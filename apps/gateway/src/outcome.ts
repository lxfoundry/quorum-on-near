import { parseAmount, parseEventLog } from '@quorum-on-near/protocol';
import type { QuorumEvent } from '@quorum-on-near/protocol';
import type { ReceiptOutcome, TxOutcome } from './chain.ts';

type Fields = Record<string, unknown>;
type SeatsCommitted = Extract<QuorumEvent, { event: 'seats_committed' }>;

function isFields(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function malformed(where: string, problem: string): never {
  throw new TypeError(`malformed transaction response: ${where} ${problem}`);
}

/** Gas as the RPC writes it: a JSON number, or a decimal string. */
function toGas(value: unknown): bigint | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  return parseAmount(value);
}

/** One `{id, outcome: {executor_id, logs, status, gas_burnt}}` entry of the response. */
function readOutcome(value: unknown, where: string): { id: string; receipt: ReceiptOutcome } {
  if (!isFields(value) || typeof value.id !== 'string' || !isFields(value.outcome)) {
    malformed(where, 'is not an outcome with an id');
  }
  const { executor_id: executorId, logs, status, gas_burnt: gas } = value.outcome;
  if (typeof executorId !== 'string') malformed(where, 'has no executor_id');
  if (!Array.isArray(logs) || !logs.every((log): log is string => typeof log === 'string')) {
    malformed(where, 'has invalid logs');
  }
  const gasBurnt = toGas(gas);
  if (gasBurnt === null) malformed(where, 'has an invalid gas_burnt');
  const failed = isFields(status) && 'Failure' in status;
  return { id: value.id, receipt: { executorId, logs, failed, gasBurnt } };
}

/**
 * The `final_execution_status` values at which every non-refund receipt has run. Below them (`NONE`,
 * `INCLUDED`, `INCLUDED_FINAL`), `receipts_outcome` may be incomplete.
 */
const EXECUTED_STATUSES = new Set(['EXECUTED_OPTIMISTIC', 'EXECUTED', 'FINAL']);

/**
 * Converts the RPC's transaction response (`send_tx` / `tx`, near-api-js's RpcTransactionResponse)
 * into a TxOutcome: `transaction_outcome` first, then `receipts_outcome` in order. A receipt is failed
 * when its status has a `Failure` key. Throws on a response whose `final_execution_status` is not in
 * EXECUTED_STATUSES, since its outcome is not complete yet.
 */
export function toTxOutcome(response: unknown): TxOutcome {
  if (!isFields(response)) malformed('response', 'is not an object');
  const { final_execution_status: status, transaction_outcome: transaction, receipts_outcome: receipts } = response;
  if (typeof status !== 'string' || !EXECUTED_STATUSES.has(status)) {
    throw new TypeError(`transaction response not executed yet: final_execution_status is ${String(status)}`);
  }
  if (!Array.isArray(receipts)) malformed('receipts_outcome', 'is not an array');
  const tx = readOutcome(transaction, 'transaction_outcome');
  return {
    txHash: tx.id,
    receipts: [tx.receipt, ...receipts.map((r: unknown, i) => readOutcome(r, `receipts_outcome[${i}]`).receipt)],
  };
}

/**
 * Every `quorum` event logged by a receipt that the pools contract executed, in order. A failed
 * receipt's events are skipped: its state changes were reverted.
 */
export function poolsEvents(outcome: TxOutcome, poolsContract: string): QuorumEvent[] {
  return outcome.receipts
    .filter((receipt) => receipt.executorId === poolsContract && !receipt.failed)
    .flatMap((receipt) => receipt.logs.map(parseEventLog))
    .filter((event) => event !== null);
}

/** What a relayed commit did. */
export interface CommitResult {
  /** The delegate action itself failed (for example a used nonce), so nothing was attempted. */
  delegateFailed: boolean;
  /** Seats taken by this payment: 0 when the contract took none. */
  seats: number;
  amount: bigint;
  /** The pool's seats taken after this commit, from the event; null when no seats were taken. */
  taken: number | null;
  target: number | null;
  /** This commit filled the pool. */
  filled: boolean;
}

/**
 * Reads a relayed commit's outcome. The seats come from the pools contract's `seats_committed`
 * event for this buyer and pool, and `filled` from its `pool_filled` event. A failed receipt executed
 * by the buyer's account means the delegate action failed.
 */
export function readCommit(
  outcome: TxOutcome,
  query: { poolsContract: string; buyer: string; poolId: number },
): CommitResult {
  const { poolsContract, buyer, poolId } = query;
  const delegateFailed = outcome.receipts.some((receipt) => receipt.failed && receipt.executorId === buyer);
  const events = poolsEvents(outcome, poolsContract);
  const commit = events.find(
    (event): event is SeatsCommitted =>
      event.event === 'seats_committed' && event.data.buyer === buyer && event.data.pool_id === poolId,
  );
  if (commit === undefined) {
    return { delegateFailed, seats: 0, amount: 0n, taken: null, target: null, filled: false };
  }
  const { seats, amount, taken, target } = commit.data;
  const paid = parseAmount(amount);
  if (paid === null || ![seats, taken, target].every(Number.isSafeInteger)) {
    throw new TypeError(`malformed seats_committed event: ${JSON.stringify(commit.data)}`);
  }
  const filled =
    taken === target || events.some((event) => event.event === 'pool_filled' && event.data.pool_id === poolId);
  return { delegateFailed, seats, amount: paid, taken, target, filled };
}
