import type { BuyerView, DecodedSignedDelegate, PoolView } from '@quorum-on-near/protocol';

/** An access key as the gateway needs it. */
export interface AccessKeyInfo {
  nonce: bigint;
  fullAccess: boolean;
}

/** The latest final block. */
export interface BlockInfo {
  height: bigint;
  timestampMs: number;
}

/** One executed receipt (or the transaction itself) of a transaction's outcome. */
export interface ReceiptOutcome {
  executorId: string;
  logs: string[];
  failed: boolean;
  gasBurnt: bigint;
}

/** A transaction's outcome: the transaction first, then every receipt, as the RPC lists them. */
export interface TxOutcome {
  txHash: string;
  receipts: ReceiptOutcome[];
}

/** Everything the gateway reads from the chain. */
export interface ChainReader {
  getPool(poolId: number): Promise<PoolView | null>;
  listPools(from: number, limit: number): Promise<PoolView[]>;
  getBuyer(poolId: number, accountId: string): Promise<BuyerView | null>;
  ftBalanceOf(accountId: string): Promise<bigint>;
  /** null when the account has no such key. */
  accessKey(accountId: string, publicKey: string): Promise<AccessKeyInfo | null>;
  finalBlock(): Promise<BlockInfo>;
  getToken(): Promise<string>;
}

/**
 * The result of submitting a transaction.
 * - `executed`: the RPC returned the outcome once every non-refund receipt had run (some may have
 *   failed).
 * - `unknown`: the transaction was sent but its result was not known in time. `expired` is true when
 *   a final block above the delegate's `maxBlockHeight` was seen, so the delegate can no longer
 *   execute; false when it may still land, and for a call that relays no delegate.
 * - `rejected`: the RPC refused the transaction, so nothing ran.
 */
export type RelayResult =
  | { kind: 'executed'; outcome: TxOutcome }
  | { kind: 'unknown'; txHash: string; expired: boolean }
  | { kind: 'rejected'; txHash: string; error: string };

/**
 * A payment is `expired` unless its `maxBlockHeight` is more than this many blocks past the final
 * height, so that the relayed transaction can land before the delegate expires. The upper bound,
 * the offer's timeout in blocks, allows the same margin.
 */
export const EXPIRY_MARGIN_BLOCKS = 5n;

/**
 * Thrown by `relayDelegate` when the chain's final height is already too close to the delegate's
 * `maxBlockHeight` for a relayed transaction to land in time. Nothing was sent.
 */
export class DelegateExpiredError extends Error {
  override name = 'DelegateExpiredError';
}

/** Everything the gateway submits, all signed by the relayer account. */
export interface ChainWriter {
  /**
   * Wraps a signed delegate action in a transaction to its sender and submits it. Resolves with the
   * result once it is known, or with `unknown` once the lookup's deadline passes without one. Throws
   * only before anything is sent: DelegateExpiredError when the final height is within EXPIRY_MARGIN_BLOCKS of
   * `maxBlockHeight`, or the error of a failed read or key wait.
   */
  relayDelegate(signed: DecodedSignedDelegate, maxBlockHeight: bigint): Promise<RelayResult>;
  /** Calls `settle` or `refund` on the pools contract with no deposit. Throws only before anything is sent. */
  callPools(method: 'settle' | 'refund', args: Record<string, unknown>, gas: bigint): Promise<RelayResult>;
}
