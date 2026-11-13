import { setTimeout as delay } from 'node:timers/promises';
import type { DecodedSignedDelegate } from '@quorum-on-near/protocol';
import { Account, KeyPairSigner, actions, baseEncode, type Action, type KeyPair, type Provider } from 'near-api-js';
import {
  ActionExecutionError,
  InvalidTransactionError,
  RequestValidationError,
  TransactionExecutionError,
} from 'near-api-js/rpc-errors';
import { DelegateExpiredError, EXPIRY_MARGIN_BLOCKS, type ChainWriter, type RelayResult, type TxOutcome } from './chain.ts';
import { toTxOutcome } from './outcome.ts';

/** A key on loan from the pool. Release it exactly once. */
export interface KeyLease {
  keyPair: KeyPair;
  release(): void;
}

/** The relayer's access keys. Each key signs one transaction at a time, so nonces never clash. */
export class KeyPool {
  readonly #size: number;
  readonly #free: KeyPair[];
  readonly #waiters: Array<(lease: KeyLease) => void> = [];

  constructor(keys: KeyPair[]) {
    if (keys.length === 0) throw new Error('KeyPool needs at least one key');
    this.#size = keys.length;
    this.#free = [...keys];
  }

  get size(): number {
    return this.#size;
  }

  /** Waits for a free key, first come first served. Rejects after `timeoutMs` (default 30 s). */
  acquire(timeoutMs = 30_000): Promise<KeyLease> {
    const keyPair = this.#free.shift();
    if (keyPair) return Promise.resolve(this.#lease(keyPair));
    return new Promise((resolve, reject) => {
      const waiter = (lease: KeyLease): void => {
        clearTimeout(timer);
        resolve(lease);
      };
      const timer = setTimeout(() => {
        const index = this.#waiters.indexOf(waiter);
        if (index !== -1) this.#waiters.splice(index, 1);
        reject(new Error(`no relayer key was free within ${timeoutMs} ms`));
      }, timeoutMs);
      this.#waiters.push(waiter);
    });
  }

  #lease(keyPair: KeyPair): KeyLease {
    let released = false;
    return {
      keyPair,
      release: () => {
        if (released) return;
        released = true;
        const next = this.#waiters.shift();
        if (next) next(this.#lease(keyPair));
        else this.#free.push(keyPair);
      },
    };
  }
}

/**
 * Build both providers with `retries: 1`. near-api-js counts attempts (with `retries: 0` it posts
 * nothing), so a transaction is posted at most once, and each lookup posts once and leaves the
 * deadline to be checked between posts.
 */
export interface RpcRelayerOptions {
  relayer: string;
  poolsContract: string;
  keys: KeyPool;
  /** Reads: nonces, blocks, transaction lookups. Construct it with `retries: 1`. */
  readProvider: Provider;
  /** Sends only. Construct it with `retries: 1`, so a transaction is posted at most once. */
  sendProvider: Provider;
  /** How often a lookup by hash is retried. Default 2000 ms. */
  lookupIntervalMs?: number;
  /**
   * How long a delegate is looked up, at most, after a send whose result is not known. The lookup
   * ends sooner once the final height passes the delegate's `maxBlockHeight`. Default 240 000 ms.
   */
  delegateLookupMs?: number;
  /** How long a keeper call is looked up after a send whose result is not known. Default 60 000 ms. */
  callLookupMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * When a lookup by hash gives up: after `lookupMs`, or, for a delegate, once the final height passes
 * its `maxBlockHeight` (the result is then `unknown` and `expired`, with that height), whichever comes
 * first.
 */
interface Deadline {
  lookupMs: number;
  maxBlockHeight?: bigint;
}

type SignedDelegateParts = Parameters<typeof actions.signedDelegate>[0];

/**
 * True when the RPC refused the transaction while validating it (a bad nonce, an expired block hash,
 * a congested or stuck shard, a malformed request), or turned the request away unread with HTTP 429
 * (too many requests), so it never ran. A timeout, a routed request, a server error (any other HTTP
 * error status included), an error it does not recognise or a network failure leaves its fate open.
 */
function refused(error: unknown): boolean {
  // near-api-js throws its own error class, which it does not export, for an HTTP error status, with
  // the status as the error's cause.
  if (error instanceof Error && error.cause === 429) return true;
  // An action error is what a transaction that ran raises. near-api-js also gives one to a transaction
  // refused for an invalid action; that one is looked up too, which only delays its answer.
  if (error instanceof ActionExecutionError) return false;
  return (
    error instanceof TransactionExecutionError ||
    error instanceof InvalidTransactionError ||
    error instanceof RequestValidationError
  );
}

/**
 * The outcome in a transaction response, or null when the response cannot be read as one, including a
 * response from before every non-refund receipt had run.
 */
function readOutcome(response: unknown): TxOutcome | null {
  try {
    return toTxOutcome(response);
  } catch {
    return null;
  }
}

/**
 * ChainWriter that signs with the relayer account. It builds and signs each transaction with a leased
 * key, sends it once and waits for `EXECUTED_OPTIMISTIC`. A delegate is first checked against the
 * final height and refused with DelegateExpiredError, before anything is built or signed, when it is
 * about to expire. If the send times out, the network fails, the RPC cannot say whether it took the
 * transaction (a routed request, a server error) or its response cannot be read (or comes back below
 * `EXECUTED_OPTIMISTIC`), it looks the transaction up by hash (never re-signing or re-sending) until a
 * readable outcome is found or the deadline passes. An RPC error that refuses the transaction, or an
 * HTTP 429 that turns the request away, is a rejection: nothing ran, and the key's cached nonce is
 * dropped. Nothing throws once a transaction has been sent.
 *
 * The key goes back to the pool once a result is returned, even an `unknown` one whose transaction
 * may still be pending. Nonces are ordered, so the key's next transaction cannot clash with it: if
 * the next one lands first, the pending one can no longer land.
 */
export class RpcRelayer implements ChainWriter {
  readonly #relayer: string;
  readonly #poolsContract: string;
  readonly #keys: KeyPool;
  readonly #read: Provider;
  readonly #send: Provider;
  readonly #lookupIntervalMs: number;
  readonly #delegateLookupMs: number;
  readonly #callLookupMs: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => number;
  /** One Account per key, each holding near-api-js's nonce cache for that key alone. */
  readonly #accounts = new Map<string, Account>();

  constructor(opts: RpcRelayerOptions) {
    this.#relayer = opts.relayer;
    this.#poolsContract = opts.poolsContract;
    this.#keys = opts.keys;
    this.#read = opts.readProvider;
    this.#send = opts.sendProvider;
    this.#lookupIntervalMs = opts.lookupIntervalMs ?? 2_000;
    this.#delegateLookupMs = opts.delegateLookupMs ?? 240_000;
    this.#callLookupMs = opts.callLookupMs ?? 60_000;
    this.#sleep = opts.sleep ?? ((ms) => delay(ms));
    this.#now = opts.now ?? Date.now;
  }

  relayDelegate(signed: DecodedSignedDelegate, maxBlockHeight: bigint): Promise<RelayResult> {
    // Borsh encodes by field name, so the decoded plain objects serialize like near-api-js's classes.
    const action = actions.signedDelegate(signed as unknown as SignedDelegateParts);
    return this.#submit(signed.delegateAction.senderId, action, { lookupMs: this.#delegateLookupMs, maxBlockHeight });
  }

  callPools(method: 'settle' | 'refund', args: Record<string, unknown>, gas: bigint): Promise<RelayResult> {
    const action = actions.functionCall(method, args, gas, 0n);
    return this.#submit(this.#poolsContract, action, { lookupMs: this.#callLookupMs });
  }

  async #submit(receiverId: string, action: Action, deadline: Deadline): Promise<RelayResult> {
    const lease = await this.#keys.acquire();
    try {
      // After the lease, since waiting for a key takes blocks; before the transaction is built, since
      // building it reserves a nonce.
      if (deadline.maxBlockHeight !== undefined) await this.#refuseExpired(deadline.maxBlockHeight);
      const publicKey = lease.keyPair.getPublicKey().toString();
      const transaction = await this.#account(publicKey).createTransaction({ receiverId, actions: [action], publicKey });
      const signer = new KeyPairSigner(lease.keyPair);
      const { txHash: hashBytes, signedTransaction } = await signer.signTransaction(transaction);
      const txHash = baseEncode(hashBytes);
      let response: unknown;
      try {
        response = await this.#send.sendTransactionUntil(signedTransaction, 'EXECUTED_OPTIMISTIC');
      } catch (error) {
        if (!refused(error)) return await this.#lookUp(txHash, deadline);
        this.#accounts.delete(publicKey);
        return { kind: 'rejected', txHash, error: String(error) };
      }
      const outcome = readOutcome(response);
      if (outcome === null) return await this.#lookUp(txHash, deadline);
      return { kind: 'executed', outcome };
    } finally {
      lease.release();
    }
  }

  #account(publicKey: string): Account {
    let account = this.#accounts.get(publicKey);
    if (!account) {
      account = new Account(this.#relayer, this.#read);
      this.#accounts.set(publicKey, account);
    }
    return account;
  }

  /** Throws DelegateExpiredError when the final height is within EXPIRY_MARGIN_BLOCKS of `maxBlockHeight`. */
  async #refuseExpired(maxBlockHeight: bigint): Promise<void> {
    const block = await this.#read.viewBlock({ finality: 'final' });
    const height = BigInt(block.header.height);
    if (height + EXPIRY_MARGIN_BLOCKS >= maxBlockHeight) {
      throw new DelegateExpiredError(`the delegate expires at block ${maxBlockHeight} and the final height is ${height}`);
    }
  }

  /**
   * Looks the transaction up every `lookupIntervalMs` until an outcome is found or the deadline passes.
   * The clock is checked first, so no block is read once the time is up.
   */
  async #lookUp(txHash: string, { lookupMs, maxBlockHeight }: Deadline): Promise<RelayResult> {
    const end = this.#now() + lookupMs;
    for (;;) {
      // Read the deadline before looking, so the last lookup is made after the deadline has passed.
      const timeUp = this.#now() >= end;
      const passed = !timeUp && maxBlockHeight !== undefined ? await this.#finalHeightAbove(maxBlockHeight) : null;
      const outcome = readOutcome(await this.#find(txHash));
      if (outcome !== null) return { kind: 'executed', outcome };
      if (passed !== null) return { kind: 'unknown', txHash, expired: true, finalHeight: passed };
      if (timeUp) return { kind: 'unknown', txHash, expired: false };
      await this.#sleep(this.#lookupIntervalMs);
    }
  }

  /**
   * The final height when it is above `height`; null when it is not, or while it cannot be read (the
   * lookup goes on).
   */
  async #finalHeightAbove(height: bigint): Promise<bigint | null> {
    try {
      const block = await this.#read.viewBlock({ finality: 'final' });
      const finalHeight = BigInt(block.header.height);
      return finalHeight > height ? finalHeight : null;
    } catch {
      return null;
    }
  }

  /** The transaction's response, or null while the RPC does not have it. */
  async #find(txHash: string): Promise<unknown> {
    try {
      return await this.#read.viewTransactionStatus({
        txHash,
        accountId: this.#relayer,
        waitUntil: 'EXECUTED_OPTIMISTIC',
      });
    } catch {
      return null;
    }
  }
}
