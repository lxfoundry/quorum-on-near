import { parseAmount } from './amounts.ts';
import { parseEventLog, type QuorumEvent } from './contract.ts';

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

type Fields = Record<string, unknown>;

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
