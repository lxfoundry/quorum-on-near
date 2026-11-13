import type { BuyerView, DecodedSignedDelegate, PoolView, TxOutcome } from '@quorum-on-near/protocol';

export type { ReceiptOutcome, TxOutcome } from '@quorum-on-near/protocol';

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
 *   the lookup stopped on a final block above the delegate's `maxBlockHeight`, whose height is
 *   `finalHeight`: the delegate can no longer be included, but one included by its `maxBlockHeight`
 *   may still have receipts to run. False when the lookup's time ran out first, and for a call that
 *   relays no delegate.
 * - `rejected`: the RPC refused the transaction, so nothing ran.
 */
export type RelayResult =
  | { kind: 'executed'; outcome: TxOutcome }
  | { kind: 'unknown'; txHash: string; expired: false }
  | { kind: 'unknown'; txHash: string; expired: true; finalHeight: bigint }
  | { kind: 'rejected'; txHash: string; error: string };

/**
 * The send-side margin, and only that: a payment is `expired` unless its `maxBlockHeight` is more
 * than this many blocks past the final height, so that the relayed transaction can land before the
 * delegate expires. The upper bound, the offer's timeout in blocks, allows the same margin, and the
 * relayer refuses to send a delegate the final height has come this close to. How long a buyer is
 * held after an unknown result is RECEIPT_MARGIN_BLOCKS.
 */
export const EXPIRY_MARGIN_BLOCKS = 5n;

/**
 * The blocks past a delegate's `maxBlockHeight` that its receipts may still take: a delegate
 * included at its `maxBlockHeight` still runs the token's `ft_transfer_call` and the pools
 * contract's `ft_on_transfer` in the blocks after it. A buyer whose payment's result is unknown is
 * held until a final block above `maxBlockHeight` plus this many blocks has been read, so that a new
 * payment is never checked before the seats the earlier one may take are visible. The scripted
 * buyers and the MCP server wait at least as long before they pay again.
 */
export const RECEIPT_MARGIN_BLOCKS = 20n;

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
