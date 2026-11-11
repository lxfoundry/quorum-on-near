import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { PoolView, QuorumEvent } from '@quorum-on-near/protocol';
import type { TxOutcome } from './chain.ts';
import { poolsEvents } from './outcome.ts';

export type ActivityKind = 'commit' | 'settle' | 'refund' | 'dust';

/** One line of the activity feed (spec section 6.7). `at` is milliseconds since the epoch. */
export interface ActivityRecord {
  at: number;
  poolId: number;
  kind: ActivityKind;
  account: string;
  seats: number;
  amount: string;
  txHash: string;
  ok: boolean;
}

const KINDS = new Set<string>(['commit', 'settle', 'refund', 'dust']);

function isActivityRecord(value: unknown): value is ActivityRecord {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.at === 'number' &&
    Number.isSafeInteger(r.poolId) &&
    typeof r.kind === 'string' &&
    KINDS.has(r.kind) &&
    typeof r.account === 'string' &&
    Number.isSafeInteger(r.seats) &&
    typeof r.amount === 'string' &&
    typeof r.txHash === 'string' &&
    typeof r.ok === 'boolean'
  );
}

function parseLines(text: string): ActivityRecord[] {
  const records: ActivityRecord[] = [];
  for (const line of text.split('\n')) {
    try {
      const value: unknown = JSON.parse(line);
      if (isActivityRecord(value)) records.push(value);
    } catch {
      // A blank line, or a line cut short when the process stopped mid-write.
    }
  }
  return records;
}

async function readIfExists(file: string): Promise<string> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

/** The activity feed: kept in memory and appended to a JSON-lines file. */
export class ActivityLog {
  readonly #file: string;
  readonly #records: ActivityRecord[];
  /** Whether the last append failed, and so may have left part of its line at the end of the file. */
  #midLine = false;

  private constructor(file: string, records: ActivityRecord[]) {
    this.#file = file;
    this.#records = records;
  }

  /**
   * Loads `file` if it exists (skipping lines that do not parse) and creates its folder if needed. A
   * file that does not end with a newline (the process stopped mid-write) gets one, so that the next
   * record starts on a line of its own.
   */
  static async open(file: string): Promise<ActivityLog> {
    await mkdir(dirname(file), { recursive: true });
    const text = await readIfExists(file);
    if (text !== '' && !text.endsWith('\n')) await appendFile(file, '\n');
    return new ActivityLog(file, parseLines(text));
  }

  /**
   * Appends `record` to the file, then to the list. After a failed append, which may have written part
   * of its line, the record starts with a newline: it gets a line of its own, and the blank line this
   * leaves when nothing was written is skipped on load.
   */
  async append(record: ActivityRecord): Promise<void> {
    const line = `${this.#midLine ? '\n' : ''}${JSON.stringify(record)}\n`;
    try {
      await appendFile(this.#file, line);
    } catch (error) {
      this.#midLine = true;
      throw error;
    }
    this.#midLine = false;
    this.#records.push(record);
  }

  /** Every record, or only one pool's, oldest first. */
  list(poolId?: number): ActivityRecord[] {
    return poolId === undefined ? [...this.#records] : this.#records.filter((r) => r.poolId === poolId);
  }

  /** The latest successful refund record for this buyer in this pool, if any. */
  lastRefund(poolId: number, account: string): ActivityRecord | undefined {
    return this.#records.findLast((r) => r.kind === 'refund' && r.ok && r.poolId === poolId && r.account === account);
  }
}

/**
 * Whether a keeper call moved its pool on. `pool` is the view read before the call.
 * - `settle`: the pools contract logged `pool_settled` for the pool.
 * - `refund`: the call's receipt at the pools contract did not fail, and either the pool had buyers
 *   left to visit (`refund_cursor < buyer_count`), so the call advanced the cursor, even past buyers
 *   that had claimed on their own and so logged nothing; or the pools contract logged
 *   `pool_refunded` for the pool (the dust arrived, or was 0). A call that only retried the dust, and
 *   whose transfer failed, moved nothing.
 */
export function keeperCallProgressed(
  kind: 'settle' | 'refund',
  pool: PoolView,
  outcome: TxOutcome,
  poolsContract: string,
): boolean {
  const logged = (event: QuorumEvent['event']): boolean =>
    poolsEvents(outcome, poolsContract).some((e) => e.event === event && e.data.pool_id === pool.id);
  if (kind === 'settle') return logged('pool_settled');
  const call = outcome.receipts.find((receipt) => receipt.executorId === poolsContract);
  if (call === undefined || call.failed) return false;
  return pool.refund_cursor < pool.buyer_count || logged('pool_refunded');
}

/**
 * The records a keeper call produced, from the pools contract's events:
 * - `settle`: `pool_settled` gives one `settle` record (account = seller, seats = pool.taken).
 * - `refund`: each `seat_refunded` gives a `refund` record (ok), each `refund_failed` a `refund` record
 *   (not ok, seats 0), and `pool_refunded` a `dust` record (account = seller, seats 0).
 * A call that produced none of these gives one record of `kind` with `ok: false`, `amount: "0"`,
 * unless it moved its pool on (keeperCallProgressed), as a refund batch that only passed buyers who
 * had claimed on their own does: that gives no record.
 */
export function keeperRecords(
  kind: 'settle' | 'refund',
  pool: PoolView,
  outcome: TxOutcome,
  poolsContract: string,
  at: number,
): ActivityRecord[] {
  const record = (recordKind: ActivityKind, account: string, seats: number, amount: string, ok: boolean): ActivityRecord => ({
    at,
    poolId: pool.id,
    kind: recordKind,
    account,
    seats,
    amount,
    txHash: outcome.txHash,
    ok,
  });
  const records: ActivityRecord[] = [];
  for (const e of poolsEvents(outcome, poolsContract)) {
    if (e.data.pool_id !== pool.id) continue;
    if (kind === 'settle' && e.event === 'pool_settled') {
      records.push(record('settle', e.data.seller, pool.taken, e.data.amount, true));
    } else if (kind === 'refund' && e.event === 'seat_refunded') {
      records.push(record('refund', e.data.buyer, e.data.seats, e.data.amount, true));
    } else if (kind === 'refund' && e.event === 'refund_failed') {
      records.push(record('refund', e.data.buyer, 0, e.data.amount, false));
    } else if (kind === 'refund' && e.event === 'pool_refunded') {
      records.push(record('dust', pool.seller, 0, e.data.dust, true));
    }
  }
  if (records.length > 0 || keeperCallProgressed(kind, pool, outcome, poolsContract)) return records;
  return [record(kind, pool.seller, 0, '0', false)];
}
