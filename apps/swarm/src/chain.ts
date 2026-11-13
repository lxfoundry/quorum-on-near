import { ConfigError } from '@quorum-on-near/buyer';
import { checkChainId, MAX_PAGE, type Network, type PoolView, type SeatView, type TxOutcome } from '@quorum-on-near/protocol';
import type { KeyPair, PublicKey } from 'near-api-js';

export type { ReceiptOutcome, TxOutcome } from '@quorum-on-near/protocol';

/** An account and one of its full-access keys: what signs a write. */
export interface AccountKey {
  accountId: string;
  keyPair: KeyPair;
}

/** An account as the latest final block holds it. */
export interface AccountState {
  /** The liquid balance in yoctoNEAR (the RPC's `amount`), the part reserved for storage included. */
  balance: bigint;
  /** Whether a contract is deployed on the account. */
  hasCode: boolean;
  /** The bytes of storage the account uses (the RPC's `storage_usage`): its keys, its code and its contract's records. */
  storageUsage: bigint;
}

/** The yoctoNEAR a byte of storage locks: NEAR's `storage_amount_per_byte`, 10^19 (1 NEAR per 100 kB). */
export const STORAGE_PRICE_PER_BYTE = 10_000_000_000_000_000_000n;

/**
 * The NEAR an account holds beyond what its storage locks, `balance - storageUsage ×
 * STORAGE_PRICE_PER_BYTE`, or 0 when its storage locks it all: what it can spend, and what its
 * contract's new records can lock. It errs low: it counts the few hundred bytes NEAR lets an account
 * without a contract use for nothing.
 */
export function freeBalance(state: Pick<AccountState, 'balance' | 'storageUsage'>): bigint {
  const free = state.balance - state.storageUsage * STORAGE_PRICE_PER_BYTE;
  return free > 0n ? free : 0n;
}

/** The latest final block. */
export interface BlockInfo {
  height: bigint;
  timestampMs: number;
}

/** A sub-account to create: its initial balance in yoctoNEAR and its full-access keys. */
export interface NewAccount {
  accountId: string;
  balance: bigint;
  publicKeys: PublicKey[];
}

/** One `ft_transfer` of a batch: `amount` base units of the token to `receiverId`. */
export interface TokenTransfer {
  receiverId: string;
  amount: bigint;
}

/** One `ft_transfer_call`: `amount` base units of the token to `receiverId`, which is called with `msg`. */
export interface TransferCall {
  receiverId: string;
  amount: bigint;
  msg: string;
}

/**
 * What an `ft_transfer_call` did: its outcome, and the amount the token kept transferred, which is
 * the call's result (NEP-141). The receiver's own receipts may have failed: the token then returned
 * the unused amount, and `used` says how much.
 */
export interface TransferCallResult {
  outcome: TxOutcome;
  used: bigint;
}

/** 1 Tgas, 10^12 units of gas: the unit the swarm states gas in. */
export const TGAS = 1_000_000_000_000n;

/** The most function calls a batched write puts in one transaction. Callers split longer lists. */
export const MAX_CALLS_PER_TRANSACTION = 10;

/**
 * The gas, 20 Tgas, attached to each call of a batched write (`storage_deposit`, `ft_transfer`): one
 * such call uses a few Tgas.
 */
export const BATCHED_CALL_GAS = 20n * TGAS;

/** Throws RangeError unless a batch holds 1 to MAX_CALLS_PER_TRANSACTION calls. Every SwarmChain applies it before signing. */
export function assertBatchSize(calls: number): void {
  if (!Number.isSafeInteger(calls) || calls < 1 || calls > MAX_CALLS_PER_TRANSACTION) {
    throw new RangeError(`a batch holds 1 to ${MAX_CALLS_PER_TRANSACTION} calls, not ${calls}`);
  }
}

/**
 * A write refused because another transaction of its key took the nonce it was signed with, after
 * the nonce was read. Only ftTransferCall rejects with it: it is sent once and never signed again,
 * since the other transaction may be an earlier send of the same call. `txHash` names the refused
 * transaction.
 */
export class NonceTakenError extends Error {
  override name = 'NonceTakenError';
  readonly txHash: string;

  constructor(message: string, txHash: string, options?: ErrorOptions) {
    super(message, options);
    this.txHash = txHash;
  }
}

/**
 * A write that was sent, but whose result the swarm does not know: the RPC gave no answer that shows
 * it refused the transaction, answered before the transaction was final, or gave a final answer that
 * cannot be read. The transaction may still run, or have run. `txHash` names it (null only where a
 * chain cannot know it); `reason` is `timeout`, the failed request's transportReason, `not final` or
 * `unreadable result`.
 */
export class OutcomeUnknownError extends Error {
  override name = 'OutcomeUnknownError';
  readonly txHash: string | null;
  readonly reason: string;

  constructor(message: string, txHash: string | null, reason: string, options?: ErrorOptions) {
    super(message, options);
    this.txHash = txHash;
    this.reason = reason;
  }
}

/**
 * `error`, with the advice of an idempotent command added to the message of an OutcomeUnknownError:
 * `<command> is idempotent: run it again once that transaction is final, and <rerun>.` Any other
 * error is returned as it is.
 */
export function rerunAdvice(error: unknown, command: string, rerun: string): unknown {
  if (!(error instanceof OutcomeUnknownError)) return error;
  const advice = `${command} is idempotent: run it again once that transaction is final, and ${rerun}.`;
  return new OutcomeUnknownError(`${error.message}. ${advice}`, error.txHash, error.reason, { cause: error });
}

/**
 * Why txOutcome gives no outcome: `unknown` when the RPC does not know the transaction (one older
 * than its history included), `not_final` when the RPC did not see it final within its own wait.
 */
export type MissingOutcome = 'unknown' | 'not_final';

/** Where `list_pools` is read: at the height of a final block, or at optimistic finality. */
export type ReadAt = bigint | 'optimistic';

/**
 * A write whose transaction ran, but whose outcome has a failed receipt. For a batch, the failed
 * receipt reverted every call of the batch. The message names the transaction, never a key.
 */
export class TransactionFailedError extends Error {
  override name = 'TransactionFailedError';
  readonly outcome: TxOutcome;

  constructor(message: string, outcome: TxOutcome) {
    super(message);
    this.outcome = outcome;
  }
}

/** The pools contract's views know no pool of this id. */
export class UnknownPoolError extends Error {
  override name = 'UnknownPoolError';
  readonly poolId: number;

  constructor(poolId: number) {
    super(`the pools contract has no pool ${poolId}`);
    this.poolId = poolId;
  }
}

/**
 * Everything the swarm's commands read from the chain and send to it. Reads are at the latest final
 * block, and each write resolves once its transaction and every receipt it caused are final, so a
 * read made after a write sees all of the write's effects. The token balance, `list_pools` and
 * `get_seats` also read at a given block: `atHeight`, the height of a final block (from finalBlock),
 * so that reads that must agree with each other see the same state. The token and the pools contract
 * are the configured ones.
 *
 * Each write is one transaction signed by `signer` and resolves with its outcome. It throws
 * TransactionFailedError when any receipt of the outcome failed, except where noted, and passes on
 * the error of a read made before the transaction is sent, and the RPC's error when it shows the
 * transaction was refused. Any other failure once the transaction is sent, a response that is not
 * final and one that cannot be read reject OutcomeUnknownError naming the transaction. A transaction
 * refused for its nonce (InvalidNonce: it did not run, and another transaction of the key, such as
 * one of another process, took the nonce) is signed again with a nonce read afresh, a bounded number
 * of times, except by ftTransferCall. Writes signed with one key are sent one after another, so their
 * nonces never race.
 */
export interface SwarmChain {
  /** The `chain_id` the RPC node reports, for checkChainId. */
  chainId(): Promise<string>;
  /** The account's balance, whether it holds a contract, and its storage; null when it does not exist. */
  account(accountId: string): Promise<AccountState | null>;
  /** The pools contract's `get_token`: the token it was initialised with. */
  getToken(): Promise<string>;
  /** The token's `storage_balance_bounds().min`: the deposit that registers an account, in yoctoNEAR. */
  registrationDeposit(): Promise<bigint>;
  /** Whether the account is registered on the token: its `storage_balance_of` is not null. */
  isRegistered(accountId: string): Promise<boolean>;
  /** The token's `ft_balance_of`, in base units (0 for an account it does not know), at `atHeight` when given. */
  ftBalanceOf(accountId: string, atHeight?: bigint): Promise<bigint>;
  /** The pools contract's `get_pool`; null for a pool it does not know. */
  getPool(poolId: number): Promise<PoolView | null>;
  /**
   * The pools contract's `list_pools(from, limit)`, at `at` when given (a final block's height, or
   * optimistic finality): at most MAX_PAGE pools, in id order.
   */
  listPools(from: number, limit: number, at?: ReadAt): Promise<PoolView[]>;
  /**
   * The pools contract's `get_seats(pool_id, from, limit)`, at `atHeight` when given: at most MAX_PAGE
   * buyers, in commit order.
   */
  getSeats(poolId: number, from: number, limit: number, atHeight?: bigint): Promise<SeatView[]>;
  /** The latest final block's height and timestamp. */
  finalBlock(): Promise<BlockInfo>;
  /**
   * The outcome of the transaction `txHash` signed by `signerId`, once it and every receipt it caused
   * are final; `unknown`, without a wait, when the RPC does not know the transaction (one older than
   * the RPC's history included), and `not_final` when the RPC does not see it final within its own
   * wait.
   */
  txOutcome(txHash: string, signerId: string): Promise<TxOutcome | MissingOutcome>;

  /**
   * Creates the direct sub-account `account.accountId` of the signer, with `account.balance` and
   * each of `account.publicKeys` as a full-access key.
   */
  createAccount(signer: AccountKey, account: NewAccount): Promise<TxOutcome>;
  /** Sends `amount` yoctoNEAR to `receiverId`. */
  transferNear(signer: AccountKey, receiverId: string, amount: bigint): Promise<TxOutcome>;
  /**
   * Deploys the pools contract's `code` to the signer's own account and calls `new({token})` with the
   * configured token in the same transaction, so that no one can initialise it with another token.
   */
  deployPools(signer: AccountKey, code: Uint8Array): Promise<TxOutcome>;
  /**
   * Registers each of `accountIds` on the token: one `storage_deposit({account_id, registration_only})`
   * with `deposit` attached for each, in one transaction. The token refunds the deposit of an account
   * already registered. Throws RangeError, before signing, unless assertBatchSize accepts the batch.
   */
  storageDeposits(signer: AccountKey, accountIds: readonly string[], deposit: bigint): Promise<TxOutcome>;
  /**
   * Sends each transfer as one `ft_transfer` with 1 yoctoNEAR attached, all from the signer, in one
   * transaction. Throws RangeError, before signing, unless assertBatchSize accepts the batch.
   */
  ftTransfers(signer: AccountKey, transfers: readonly TokenTransfer[]): Promise<TxOutcome>;
  /**
   * Sends one `ft_transfer_call` with 1 yoctoNEAR attached. Throws TransactionFailedError only when
   * the call itself failed, so nothing was transferred; a failure in the receiver's receipts is the
   * caller's to read from the result (its events, and `used`). It is signed with a nonce read for it
   * alone and sent once, never signed again: an earlier send of the same call may have taken the
   * nonce, so InvalidNonce rejects NonceTakenError; OutcomeUnknownError names the transaction.
   */
  ftTransferCall(signer: AccountKey, call: TransferCall): Promise<TransferCallResult>;
}

/**
 * Throws ConfigError, naming QUORUM_NETWORK and QUORUM_RPC_URL but not the URL, when the RPC serves
 * another chain than `network` names (checkChainId). Every command that reads or writes the chain
 * makes this check before anything else; setup and reset make it again themselves, since they sign
 * transactions and can be called without the command line.
 */
export async function checkChain(network: Network, chain: Pick<SwarmChain, 'chainId'>): Promise<void> {
  const problem = checkChainId(network, await chain.chainId());
  if (problem !== null) throw new ConfigError([problem]);
}

/**
 * Every pool, paging `list_pools` from the id after the last one read until a page comes back
 * shorter; every page at `at` when given.
 */
export async function allPools(chain: Pick<SwarmChain, 'listPools'>, at?: ReadAt): Promise<PoolView[]> {
  const pools: PoolView[] = [];
  for (;;) {
    const page = await chain.listPools((pools.at(-1)?.id ?? -1) + 1, MAX_PAGE, at);
    pools.push(...page);
    if (page.length < MAX_PAGE) return pools;
  }
}
