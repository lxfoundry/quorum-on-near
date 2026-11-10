import { sha256 } from '@noble/hashes/sha2.js';
import { decodeSignedDelegate, type DecodedSignedDelegate } from '@quorum-on-near/protocol';
import {
  KeyPair,
  KeyPairSigner,
  actions,
  baseEncode,
  buildDelegateAction,
  decodeSignedTransaction,
  encodeSignedDelegate,
  encodeTransaction,
  type Action,
  type Provider,
  type SignedTransaction,
} from 'near-api-js';
import {
  DelegateActionInvalidNonceActionError,
  DelegateActionMustBeOnlyOneActionError,
  InternalRpcError,
  InvalidNonceError,
  InvalidTransactionError,
  RequestRoutedError,
  RpcError,
  RpcMethodNotFoundError,
  RpcRequestParseError,
  ShardCongestedError,
  ShardStuckError,
  TransactionTimeoutError,
  UnknownTransactionError,
} from 'near-api-js/rpc-errors';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DelegateExpiredError } from '../src/chain.ts';
import { KeyPool, RpcRelayer, type RpcRelayerOptions } from '../src/relayer.ts';
import { POOLS, RELAYER, TOKEN } from './fake-chain.ts';

const TGAS = 1_000_000_000_000n;
const BUYER = 'buyer.testnet';
const BLOCK_HASH = baseEncode(new Uint8Array(32).fill(7));
const LOOKUP_INTERVAL_MS = 2_000;
const DELEGATE_LOOKUP_MS = 30_000;
const CALL_LOOKUP_MS = 10_000;
/** A transaction response toTxOutcome cannot read: it has no outcomes. */
const UNREADABLE = { final_execution_status: 'EXECUTED_OPTIMISTIC' };

/** The clock readings of lookups made every LOOKUP_INTERVAL_MS from 0 to `lastMs`. */
function lookupTimes(lastMs: number): number[] {
  return Array.from({ length: lastMs / LOOKUP_INTERVAL_MS + 1 }, (_, i) => i * LOOKUP_INTERVAL_MS);
}

/** A transaction as the fake RPC received it, decoded from its Borsh bytes. */
interface SentTx {
  hash: string;
  signerId: string;
  publicKey: string;
  nonce: bigint;
  receiverId: string;
  actions: Action[];
  waitUntil: string;
}

interface Lookup {
  txHash: string;
  accountId: string;
  waitUntil?: string;
  atMs: number;
  finalHeight: bigint;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function executionOutcome(id: string, executorId: string, status: Record<string, string>) {
  return {
    id,
    block_hash: BLOCK_HASH,
    proof: [],
    outcome: { executor_id: executorId, logs: [], receipt_ids: [], gas_burnt: 2_428_000_000_000, tokens_burnt: '0', status },
  };
}

/** A `send_tx` / `tx` result for a transaction whose one receipt succeeded. */
function executedResponse(tx: SentTx): unknown {
  const receiptId = `${tx.hash}-receipt`;
  return {
    final_execution_status: 'EXECUTED_OPTIMISTIC',
    status: { SuccessValue: '' },
    transaction: { hash: tx.hash, signer_id: tx.signerId, receiver_id: tx.receiverId, nonce: Number(tx.nonce) },
    transaction_outcome: executionOutcome(tx.hash, tx.signerId, { SuccessReceiptId: receiptId }),
    receipts_outcome: [executionOutcome(receiptId, tx.receiverId, { SuccessValue: '' })],
  };
}

/** A `send_tx` / `tx` result returned at `status`, before the transaction's receipt has run. */
function notExecutedResponse(tx: SentTx, status: 'INCLUDED' | 'INCLUDED_FINAL'): unknown {
  const executed = executedResponse(tx) as Record<string, unknown>;
  return { ...executed, final_execution_status: status, status: 'Started', receipts_outcome: [] };
}

/**
 * A scripted RPC node with the four Provider methods the relayer uses. Each `sleep` advances the clock
 * by the time slept and the final height by one block.
 */
class FakeRpc {
  chainNonce = 5n;
  finalHeight = 1_000n;
  clockMs = 0;
  accessKeyReads = 0;
  blockReads = 0;
  sent: SentTx[] = [];
  lookups: Lookup[] = [];
  sleeps: number[] = [];
  /** The send's result; by default the transaction executes. */
  onSend: (tx: SentTx) => Promise<unknown> = async (tx) => executedResponse(tx);
  /** The lookup's result; by default the transaction is never found. */
  onLookup: (txHash: string) => Promise<unknown> = async (txHash) => {
    throw new UnknownTransactionError(txHash);
  };
  /** Fails the next block read when set. */
  blockError: Error | null = null;

  /** Reads go here; it has no send method, so a send through it fails. */
  readProvider(): Provider {
    const read = {
      viewAccessKey: async () => {
        this.accessKeyReads += 1;
        return { nonce: this.chainNonce, permission: 'FullAccess', block_height: Number(this.finalHeight), block_hash: BLOCK_HASH };
      },
      viewBlock: async () => {
        this.blockReads += 1;
        if (this.blockError) throw this.blockError;
        return { header: { height: Number(this.finalHeight), hash: BLOCK_HASH } };
      },
      viewTransactionStatus: async (args: { txHash: string; accountId: string; waitUntil?: string }) => {
        this.lookups.push({ ...args, atMs: this.clockMs, finalHeight: this.finalHeight });
        return this.onLookup(args.txHash);
      },
    };
    return read as unknown as Provider;
  }

  /** Sends go here; it has no read methods. */
  sendProvider(): Provider {
    const send = {
      sendTransactionUntil: async (signed: SignedTransaction, waitUntil: string) => {
        const { transaction } = decodeSignedTransaction(encodeTransaction(signed));
        const tx: SentTx = {
          hash: baseEncode(sha256(encodeTransaction(transaction))),
          signerId: transaction.signerId,
          publicKey: signed.transaction.publicKey.toString(),
          nonce: transaction.nonce,
          receiverId: transaction.receiverId,
          actions: transaction.actions,
          waitUntil,
        };
        this.sent.push(tx);
        return this.onSend(tx);
      },
    };
    return send as unknown as Provider;
  }

  sleep = async (ms: number): Promise<void> => {
    this.sleeps.push(ms);
    this.clockMs += ms;
    this.finalHeight += 1n;
  };
}

function setup(keyCount = 1, options: Partial<RpcRelayerOptions> = {}) {
  const rpc = new FakeRpc();
  const keys = Array.from({ length: keyCount }, () => KeyPair.fromRandom('ed25519'));
  const pool = new KeyPool(keys);
  const relayer = new RpcRelayer({
    relayer: RELAYER,
    poolsContract: POOLS,
    keys: pool,
    readProvider: rpc.readProvider(),
    sendProvider: rpc.sendProvider(),
    lookupIntervalMs: LOOKUP_INTERVAL_MS,
    delegateLookupMs: DELEGATE_LOOKUP_MS,
    callLookupMs: CALL_LOOKUP_MS,
    sleep: rpc.sleep,
    now: () => rpc.clockMs,
    ...options,
  });
  return { rpc, relayer, keys, pool };
}

/** A buyer's signed `ft_transfer_call` delegate, as the gateway receives it decoded. */
async function buyerDelegate(maxBlockHeight = 1_100n): Promise<{ signed: DecodedSignedDelegate; bytes: Uint8Array }> {
  const buyer = KeyPair.fromRandom('ed25519');
  const delegateAction = buildDelegateAction({
    senderId: BUYER,
    receiverId: TOKEN,
    actions: [
      actions.functionCall(
        'ft_transfer_call',
        { receiver_id: POOLS, amount: '360', msg: '{"commit":{"pool_id":7,"seats":2}}' },
        50n * TGAS,
        1n,
      ),
    ],
    nonce: 42n,
    maxBlockHeight,
    publicKey: buyer.getPublicKey(),
  });
  const { signedDelegate } = await new KeyPairSigner(buyer).signDelegateAction(delegateAction);
  const bytes = encodeSignedDelegate(signedDelegate);
  return { signed: decodeSignedDelegate(bytes), bytes };
}

/** Lets every pending promise callback run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
}

describe('KeyPool', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports how many keys it holds', () => {
    const pool = new KeyPool([KeyPair.fromRandom('ed25519'), KeyPair.fromRandom('ed25519')]);
    expect(pool.size).toBe(2);
  });

  it('refuses to be built without a key', () => {
    expect(() => new KeyPool([])).toThrow();
  });

  it('hands out each free key before anyone waits', async () => {
    const [a, b] = [KeyPair.fromRandom('ed25519'), KeyPair.fromRandom('ed25519')];
    const pool = new KeyPool([a, b]);
    const first = await pool.acquire();
    const second = await pool.acquire();
    expect(first.keyPair).toBe(a);
    expect(second.keyPair).toBe(b);
  });

  it('serves waiters first come, first served', async () => {
    const pool = new KeyPool([KeyPair.fromRandom('ed25519')]);
    const held = await pool.acquire();
    const order: string[] = [];
    const second = pool.acquire().then((lease) => {
      order.push('second');
      return lease;
    });
    const third = pool.acquire().then((lease) => {
      order.push('third');
      return lease;
    });
    held.release();
    await Promise.race([second, third]);
    expect(order).toEqual(['second']);
    (await second).release();
    await third;
    expect(order).toEqual(['second', 'third']);
  });

  it('gives a released key to the first waiter without also returning it to the pool', async () => {
    vi.useFakeTimers();
    const pool = new KeyPool([KeyPair.fromRandom('ed25519')]);
    const held = await pool.acquire();
    const waiter = pool.acquire();
    held.release();
    await waiter;
    const another = expect(pool.acquire(1_000)).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(1_000);
    await another;
  });

  it('rejects an acquire that waits longer than its timeout', async () => {
    vi.useFakeTimers();
    const pool = new KeyPool([KeyPair.fromRandom('ed25519')]);
    await pool.acquire();
    const waiting = expect(pool.acquire(1_000)).rejects.toThrow(/1000 ms/);
    await vi.advanceTimersByTimeAsync(1_000);
    await waiting;
  });

  it('waits 30 seconds by default', async () => {
    vi.useFakeTimers();
    const pool = new KeyPool([KeyPair.fromRandom('ed25519')]);
    await pool.acquire();
    let rejected = false;
    pool.acquire().catch(() => {
      rejected = true;
    });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(rejected).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(rejected).toBe(true);
  });

  it('gives a key released after a waiter timed out to the next caller', async () => {
    vi.useFakeTimers();
    const key = KeyPair.fromRandom('ed25519');
    const pool = new KeyPool([key]);
    const held = await pool.acquire();
    const timedOut = expect(pool.acquire(1_000)).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(1_000);
    await timedOut;
    held.release();
    expect((await pool.acquire(0)).keyPair).toBe(key);
  });

  it('returns a key to the pool only once however often its lease is released', async () => {
    vi.useFakeTimers();
    const pool = new KeyPool([KeyPair.fromRandom('ed25519')]);
    const lease = await pool.acquire();
    lease.release();
    lease.release();
    await pool.acquire();
    const second = expect(pool.acquire(1_000)).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(1_000);
    await second;
  });
});

describe('RpcRelayer.relayDelegate', () => {
  it('returns the outcome of a relay that executes', async () => {
    const { rpc, relayer } = setup();
    const { signed } = await buyerDelegate();
    const result = await relayer.relayDelegate(signed, 1_100n);
    expect(result).toMatchObject({ kind: 'executed', outcome: { txHash: rpc.sent[0]?.hash } });
    expect(rpc.sent[0]?.waitUntil).toBe('EXECUTED_OPTIMISTIC');
  });

  it("sends the relayer's transaction to the delegate's sender with one signedDelegate action", async () => {
    const { rpc, relayer, keys } = setup();
    const { signed, bytes } = await buyerDelegate();
    await relayer.relayDelegate(signed, 1_100n);
    const [tx] = rpc.sent;
    expect(tx).toMatchObject({ signerId: RELAYER, receiverId: BUYER, publicKey: keys[0]?.getPublicKey().toString() });
    expect(tx?.actions).toHaveLength(1);
    const inner = tx?.actions[0]?.signedDelegate;
    expect(inner).toBeDefined();
    expect(encodeSignedDelegate(inner!)).toEqual(bytes);
  });

  it('uses the next nonce after the chain nonce and keeps counting from its cache', async () => {
    const { rpc, relayer } = setup();
    const { signed } = await buyerDelegate();
    await relayer.relayDelegate(signed, 1_100n);
    await relayer.relayDelegate(signed, 1_100n);
    expect(rpc.sent.map((tx) => tx.nonce)).toEqual([6n, 7n]);
    expect(rpc.accessKeyReads).toBe(1);
  });

  it('looks a timed-out send up by hash without sending it again', async () => {
    const { rpc, relayer } = setup();
    rpc.onSend = async () => {
      throw new TransactionTimeoutError();
    };
    let lookups = 0;
    rpc.onLookup = async (txHash) => {
      lookups += 1;
      if (lookups < 3) throw new UnknownTransactionError(txHash);
      return executedResponse(rpc.sent[0]!);
    };
    const { signed } = await buyerDelegate();
    const result = await relayer.relayDelegate(signed, 1_100n);
    const hash = rpc.sent[0]?.hash;
    expect(result).toMatchObject({ kind: 'executed', outcome: { txHash: hash } });
    expect(rpc.sent).toHaveLength(1);
    expect(rpc.lookups.map(({ txHash, accountId, waitUntil }) => ({ txHash, accountId, waitUntil }))).toEqual(
      Array(3).fill({ txHash: hash, accountId: RELAYER, waitUntil: 'EXECUTED_OPTIMISTIC' }),
    );
    expect(rpc.sleeps).toEqual([LOOKUP_INTERVAL_MS, LOOKUP_INTERVAL_MS]);
  });

  it('gives unknown and expired once the final height has passed maxBlockHeight with nothing found', async () => {
    const { rpc, relayer } = setup();
    rpc.onSend = async () => {
      throw new TransactionTimeoutError();
    };
    const { signed } = await buyerDelegate(1_008n);
    const result = await relayer.relayDelegate(signed, 1_008n);
    expect(result).toEqual({ kind: 'unknown', txHash: rpc.sent[0]?.hash, expired: true });
    expect(rpc.sent).toHaveLength(1);
    expect(rpc.lookups.map((lookup) => lookup.finalHeight)).toEqual(
      Array.from({ length: 10 }, (_, i) => 1_000n + BigInt(i)),
    );
  });

  it('looks once more after seeing the height pass, in case the transaction landed meanwhile', async () => {
    const { rpc, relayer } = setup();
    rpc.onSend = async () => {
      throw new TransactionTimeoutError();
    };
    let landed = false;
    rpc.onLookup = async (txHash) => {
      if (landed) return executedResponse(rpc.sent[0]!);
      if (rpc.finalHeight === 1_008n) {
        // The transaction lands, and the chain moves past maxBlockHeight, while this lookup runs.
        landed = true;
        rpc.finalHeight = 1_009n;
      }
      throw new UnknownTransactionError(txHash);
    };
    const { signed } = await buyerDelegate(1_008n);
    const result = await relayer.relayDelegate(signed, 1_008n);
    expect(result.kind).toBe('executed');
  });

  it('keeps looking while the final height cannot be read', async () => {
    const { rpc, relayer } = setup();
    const { signed } = await buyerDelegate(1_010n);
    rpc.onSend = async () => {
      // The chain moves past maxBlockHeight while the send runs, but its height cannot be read.
      rpc.finalHeight = 1_020n;
      rpc.blockError = new TypeError('fetch failed');
      throw new TransactionTimeoutError();
    };
    rpc.onLookup = async (txHash) => {
      if (rpc.lookups.length === 3) rpc.blockError = null;
      throw new UnknownTransactionError(txHash);
    };
    const result = await relayer.relayDelegate(signed, 1_010n);
    expect(result).toEqual({ kind: 'unknown', txHash: rpc.sent[0]?.hash, expired: true });
    expect(rpc.lookups).toHaveLength(4);
  });

  it('gives unknown, not expired, after delegateLookupMs while the final height cannot be read', async () => {
    const { rpc, relayer } = setup();
    rpc.onSend = async () => {
      rpc.blockError = new TypeError('fetch failed');
      throw new TransactionTimeoutError();
    };
    const { signed } = await buyerDelegate();
    const result = await relayer.relayDelegate(signed, 1_100n);
    expect(result).toEqual({ kind: 'unknown', txHash: rpc.sent[0]?.hash, expired: false });
    expect(rpc.lookups.map((lookup) => lookup.atMs)).toEqual(lookupTimes(DELEGATE_LOOKUP_MS));
  });

  it('gives unknown, not expired, after delegateLookupMs while the final height stays below maxBlockHeight', async () => {
    const { rpc, relayer } = setup();
    rpc.onSend = async () => {
      throw new TransactionTimeoutError();
    };
    const { signed } = await buyerDelegate(1_000_000n);
    const result = await relayer.relayDelegate(signed, 1_000_000n);
    expect(result).toEqual({ kind: 'unknown', txHash: rpc.sent[0]?.hash, expired: false });
    expect(rpc.lookups.map((lookup) => lookup.atMs)).toEqual(lookupTimes(DELEGATE_LOOKUP_MS));
  });

  it('looks a delegate up for 240 seconds by default', async () => {
    const { rpc, relayer } = setup(1, { delegateLookupMs: undefined });
    rpc.onSend = async () => {
      throw new TransactionTimeoutError();
    };
    const { signed } = await buyerDelegate(1_000_000n);
    await relayer.relayDelegate(signed, 1_000_000n);
    expect(rpc.lookups.at(-1)?.atMs).toBe(240_000);
  });

  it('looks up a send whose response cannot be read, without sending it again', async () => {
    const { rpc, relayer } = setup();
    rpc.onSend = async () => UNREADABLE;
    rpc.onLookup = async () => executedResponse(rpc.sent[0]!);
    const { signed } = await buyerDelegate();
    const result = await relayer.relayDelegate(signed, 1_100n);
    expect(result).toMatchObject({ kind: 'executed', outcome: { txHash: rpc.sent[0]?.hash } });
    expect(rpc.sent).toHaveLength(1);
    expect(rpc.lookups).toHaveLength(1);
  });

  it('gives unknown at the deadline when the send response cannot be read and nothing is found', async () => {
    const { rpc, relayer } = setup();
    rpc.onSend = async () => UNREADABLE;
    const { signed } = await buyerDelegate(1_008n);
    const result = await relayer.relayDelegate(signed, 1_008n);
    expect(result).toEqual({ kind: 'unknown', txHash: rpc.sent[0]?.hash, expired: true });
    expect(rpc.sent).toHaveLength(1);
  });

  it.each(['INCLUDED', 'INCLUDED_FINAL'] as const)(
    'looks up a send that returns at %s, before its receipts have run, without sending it again',
    async (status) => {
      const { rpc, relayer } = setup();
      rpc.onSend = async (tx) => notExecutedResponse(tx, status);
      rpc.onLookup = async () => executedResponse(rpc.sent[0]!);
      const { signed } = await buyerDelegate();
      const result = await relayer.relayDelegate(signed, 1_100n);
      expect(result).toMatchObject({
        kind: 'executed',
        outcome: { txHash: rpc.sent[0]?.hash, receipts: [{ executorId: RELAYER }, { executorId: BUYER }] },
      });
      expect(rpc.sent).toHaveLength(1);
      expect(rpc.lookups).toHaveLength(1);
    },
  );

  it('gives unknown after delegateLookupMs when no lookup gets past INCLUDED', async () => {
    const { rpc, relayer } = setup();
    rpc.onSend = async (tx) => notExecutedResponse(tx, 'INCLUDED');
    rpc.onLookup = async () => notExecutedResponse(rpc.sent[0]!, 'INCLUDED');
    const { signed } = await buyerDelegate(1_000_000n);
    const result = await relayer.relayDelegate(signed, 1_000_000n);
    expect(result).toEqual({ kind: 'unknown', txHash: rpc.sent[0]?.hash, expired: false });
    expect(rpc.sent).toHaveLength(1);
    expect(rpc.lookups.map((lookup) => lookup.atMs)).toEqual(lookupTimes(DELEGATE_LOOKUP_MS));
  });

  it('treats a lookup response that cannot be read as not found and keeps looking', async () => {
    const { rpc, relayer } = setup();
    rpc.onSend = async () => {
      throw new TransactionTimeoutError();
    };
    rpc.onLookup = async () => (rpc.lookups.length < 3 ? UNREADABLE : executedResponse(rpc.sent[0]!));
    const { signed } = await buyerDelegate();
    const result = await relayer.relayDelegate(signed, 1_100n);
    expect(result).toMatchObject({ kind: 'executed', outcome: { txHash: rpc.sent[0]?.hash } });
    expect(rpc.lookups).toHaveLength(3);
  });

  it('gives unknown at the deadline when no lookup response can be read', async () => {
    const { rpc, relayer } = setup();
    rpc.onSend = async () => {
      throw new TransactionTimeoutError();
    };
    rpc.onLookup = async () => UNREADABLE;
    const { signed } = await buyerDelegate(1_008n);
    const result = await relayer.relayDelegate(signed, 1_008n);
    expect(result).toEqual({ kind: 'unknown', txHash: rpc.sent[0]?.hash, expired: true });
    expect(rpc.sent).toHaveLength(1);
  });

  it('treats a network failure during the send like a timeout', async () => {
    const { rpc, relayer } = setup();
    rpc.onSend = async () => {
      throw new TypeError('fetch failed');
    };
    rpc.onLookup = async () => executedResponse(rpc.sent[0]!);
    const { signed } = await buyerDelegate();
    const result = await relayer.relayDelegate(signed, 1_100n);
    expect(result).toMatchObject({ kind: 'executed', outcome: { txHash: rpc.sent[0]?.hash } });
    expect(rpc.sent).toHaveLength(1);
  });

  it.each([
    ['a server error', new InternalRpcError('internal error')],
    ['a routed request', new RequestRoutedError('tx')],
    ['an unrecognised RpcError', new RpcError('Unknown RPC error')],
    ['a DelegateActionInvalidNonce action error', new DelegateActionInvalidNonceActionError(42, 42, 0, '', '')],
    ['a DelegateActionMustBeOnlyOne validation error', new DelegateActionMustBeOnlyOneActionError(null, '', '')],
  ])('treats %s from the RPC like a timeout, not a rejection', async (_, error) => {
    const { rpc, relayer } = setup();
    rpc.onSend = async () => {
      throw error;
    };
    rpc.onLookup = async () => executedResponse(rpc.sent[0]!);
    const { signed } = await buyerDelegate();
    const result = await relayer.relayDelegate(signed, 1_100n);
    expect(result.kind).toBe('executed');
    expect(rpc.sent).toHaveLength(1);
  });

  it('rejects on an invalid nonce, and the next transaction re-reads the nonce', async () => {
    const { rpc, relayer } = setup();
    rpc.onSend = async (tx) => {
      rpc.chainNonce = 9n;
      throw new InvalidNonceError(9, Number(tx.nonce), tx.hash, BLOCK_HASH);
    };
    const { signed } = await buyerDelegate();
    const rejected = await relayer.relayDelegate(signed, 1_100n);
    expect(rejected).toEqual({ kind: 'rejected', txHash: rpc.sent[0]?.hash, error: expect.stringMatching(/Invalid nonce/) });
    expect(rpc.lookups).toHaveLength(0);

    rpc.onSend = async (tx) => executedResponse(tx);
    const next = await relayer.relayDelegate(signed, 1_100n);
    expect(next.kind).toBe('executed');
    expect(rpc.sent[1]?.nonce).toBe(10n);
    expect(rpc.accessKeyReads).toBe(2);
  });

  it.each([
    ['an invalid transaction with no details', new InvalidTransactionError()],
    ['a request it cannot parse', new RpcRequestParseError('invalid base64')],
    ['an unknown method', new RpcMethodNotFoundError('send_tx')],
    ['a congested shard', new ShardCongestedError(1, 0, '', '')],
    ['a stuck shard', new ShardStuckError(10, 0, '', '')],
  ])('rejects on %s, looking nothing up', async (_, error) => {
    const { rpc, relayer } = setup();
    rpc.onSend = async () => {
      throw error;
    };
    const { signed } = await buyerDelegate();
    const result = await relayer.relayDelegate(signed, 1_100n);
    expect(result).toEqual({ kind: 'rejected', txHash: rpc.sent[0]?.hash, error: String(error) });
    expect(rpc.sent).toHaveLength(1);
    expect(rpc.lookups).toHaveLength(0);
  });

  it('throws an RPC failure that happens before anything is sent', async () => {
    const { rpc, relayer } = setup();
    rpc.blockError = new TypeError('fetch failed');
    const { signed } = await buyerDelegate();
    await expect(relayer.relayDelegate(signed, 1_100n)).rejects.toThrow('fetch failed');
    expect(rpc.sent).toHaveLength(0);
  });

  it('serialises two relays that share one key: the second is built only after the first finishes', async () => {
    const { rpc, relayer } = setup(1);
    const firstSent = deferred<SentTx>();
    const firstResult = deferred<unknown>();
    rpc.onSend = (tx) => {
      firstSent.resolve(tx);
      return firstResult.promise;
    };
    const { signed } = await buyerDelegate();
    const first = relayer.relayDelegate(signed, 1_100n);
    const second = relayer.relayDelegate(signed, 1_100n);
    const tx = await firstSent.promise;
    await settle();
    expect(rpc.sent).toHaveLength(1);
    // The first relay's expiry check and its transaction's block hash; nothing from the second.
    expect(rpc.blockReads).toBe(2);

    rpc.onSend = async (next) => executedResponse(next);
    firstResult.resolve(executedResponse(tx));
    await Promise.all([first, second]);
    expect(rpc.sent.map((sent) => sent.nonce)).toEqual([6n, 7n]);
  });

  it('keeps the key leased while a timed-out transaction is looked up', async () => {
    const { rpc, relayer } = setup(1);
    rpc.onSend = async (tx) => {
      if (rpc.sent.length === 1) throw new TransactionTimeoutError();
      return executedResponse(tx);
    };
    const lookupStarted = deferred<void>();
    const lookupResult = deferred<unknown>();
    rpc.onLookup = () => {
      lookupStarted.resolve();
      return lookupResult.promise;
    };
    const { signed } = await buyerDelegate();
    const first = relayer.relayDelegate(signed, 1_100n);
    const second = relayer.relayDelegate(signed, 1_100n);
    await lookupStarted.promise;
    await settle();
    expect(rpc.sent).toHaveLength(1);

    lookupResult.resolve(executedResponse(rpc.sent[0]!));
    await Promise.all([first, second]);
    expect(rpc.sent).toHaveLength(2);
  });

  it('relays with two keys at the same time', async () => {
    const { rpc, relayer, keys } = setup(2);
    const results = deferred<void>();
    rpc.onSend = async (tx) => {
      if (rpc.sent.length === 2) results.resolve();
      await results.promise;
      return executedResponse(tx);
    };
    const { signed } = await buyerDelegate();
    await Promise.all([relayer.relayDelegate(signed, 1_100n), relayer.relayDelegate(signed, 1_100n)]);
    expect(new Set(rpc.sent.map((tx) => tx.publicKey))).toEqual(new Set(keys.map((key) => key.getPublicKey().toString())));
  });
});

describe('RpcRelayer.relayDelegate expiry check', () => {
  it('throws DelegateExpiredError and sends nothing when maxBlockHeight is 5 blocks past the final height', async () => {
    const { rpc, relayer } = setup();
    const { signed } = await buyerDelegate(1_005n);
    await expect(relayer.relayDelegate(signed, 1_005n)).rejects.toBeInstanceOf(DelegateExpiredError);
    expect(rpc.sent).toHaveLength(0);
  });

  it('relays a delegate whose maxBlockHeight is 6 blocks past the final height', async () => {
    const { relayer } = setup();
    const { signed } = await buyerDelegate(1_006n);
    expect((await relayer.relayDelegate(signed, 1_006n)).kind).toBe('executed');
  });

  it('builds no transaction for an expired delegate, so the next one takes the next nonce', async () => {
    const { rpc, relayer } = setup();
    const expired = await buyerDelegate(1_005n);
    await expect(relayer.relayDelegate(expired.signed, 1_005n)).rejects.toBeInstanceOf(DelegateExpiredError);
    const { signed } = await buyerDelegate();
    await relayer.relayDelegate(signed, 1_100n);
    expect(rpc.sent.map((tx) => tx.nonce)).toEqual([6n]);
  });

  it('checks the final height once the key is leased, so a delegate that expires while waiting is not sent', async () => {
    const { rpc, relayer } = setup(1);
    const firstSent = deferred<SentTx>();
    const firstResult = deferred<unknown>();
    rpc.onSend = (tx) => {
      firstSent.resolve(tx);
      return firstResult.promise;
    };
    const first = await buyerDelegate();
    const waiting = await buyerDelegate(1_008n);
    const firstRelay = relayer.relayDelegate(first.signed, 1_100n);
    const secondRelay = relayer.relayDelegate(waiting.signed, 1_008n);
    const tx = await firstSent.promise;
    // The chain moves on while the second relay waits for the key.
    rpc.finalHeight = 1_003n;
    firstResult.resolve(executedResponse(tx));
    await firstRelay;
    await expect(secondRelay).rejects.toBeInstanceOf(DelegateExpiredError);
    expect(rpc.sent).toHaveLength(1);
  });
});

describe('RpcRelayer key lease', () => {
  const cases: Array<[string, (rpc: FakeRpc) => void, bigint]> = [
    ['the relay executes', () => {}, 1_100n],
    [
      'the RPC rejects the transaction',
      (rpc) => {
        rpc.onSend = async (tx) => {
          throw new InvalidNonceError(9, Number(tx.nonce), tx.hash, BLOCK_HASH);
        };
      },
      1_100n,
    ],
    [
      'the result stays unknown',
      (rpc) => {
        rpc.onSend = async () => {
          throw new TransactionTimeoutError();
        };
      },
      1_008n,
    ],
    [
      'no response can be read',
      (rpc) => {
        rpc.onSend = async () => UNREADABLE;
        rpc.onLookup = async () => UNREADABLE;
      },
      1_008n,
    ],
    ['the delegate has expired', () => {}, 1_005n],
    [
      'a read fails before sending',
      (rpc) => {
        rpc.blockError = new TypeError('fetch failed');
      },
      1_100n,
    ],
  ];

  it.each(cases)('is released when %s', async (_, arrange, maxBlockHeight) => {
    const { rpc, relayer, pool } = setup(1);
    arrange(rpc);
    const { signed } = await buyerDelegate(maxBlockHeight);
    await relayer.relayDelegate(signed, maxBlockHeight).catch(() => undefined);
    await expect(pool.acquire(0)).resolves.toBeDefined();
  });
});

describe('RpcRelayer.callPools', () => {
  it('sends a function call to the pools contract with the given gas and no deposit', async () => {
    const { rpc, relayer } = setup();
    const result = await relayer.callPools('refund', { pool_id: 7, limit: 10 }, 300n * TGAS);
    expect(result).toMatchObject({ kind: 'executed', outcome: { txHash: rpc.sent[0]?.hash } });
    const [tx] = rpc.sent;
    expect(tx).toMatchObject({ signerId: RELAYER, receiverId: POOLS });
    expect(tx?.actions).toHaveLength(1);
    const call = tx?.actions[0]?.functionCall;
    expect(call).toMatchObject({ methodName: 'refund', gas: 300n * TGAS, deposit: 0n });
    expect(JSON.parse(new TextDecoder().decode(Uint8Array.from(call!.args)))).toEqual({ pool_id: 7, limit: 10 });
  });

  it('looks a timed-out call up for callLookupMs, then gives unknown, not expired', async () => {
    const { rpc, relayer } = setup();
    rpc.onSend = async () => {
      throw new TransactionTimeoutError();
    };
    const result = await relayer.callPools('settle', { pool_id: 7 }, 100n * TGAS);
    expect(result).toEqual({ kind: 'unknown', txHash: rpc.sent[0]?.hash, expired: false });
    expect(rpc.sent).toHaveLength(1);
    expect(rpc.lookups.map((lookup) => lookup.atMs)).toEqual(lookupTimes(CALL_LOOKUP_MS));
  });

  it('looks up a call whose send response cannot be read, without sending it again', async () => {
    const { rpc, relayer } = setup();
    rpc.onSend = async () => UNREADABLE;
    rpc.onLookup = async () => executedResponse(rpc.sent[0]!);
    const result = await relayer.callPools('settle', { pool_id: 7 }, 100n * TGAS);
    expect(result).toMatchObject({ kind: 'executed', outcome: { txHash: rpc.sent[0]?.hash } });
    expect(rpc.sent).toHaveLength(1);
  });
});
