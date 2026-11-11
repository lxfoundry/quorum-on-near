import type { PoolView } from '@quorum-on-near/protocol';
import { keeperCallProgressed, keeperRecords, type ActivityLog, type ActivityRecord } from './activity.ts';
import type { ChainReader, ChainWriter, RelayResult } from './chain.ts';
import { listServedPools } from './pools.ts';

export interface KeeperOptions {
  chain: ChainReader;
  writer: ChainWriter;
  activity: ActivityLog;
  provider: string;
  poolsContract: string;
  refundLimit: number;
  settleGas: bigint;
  refundGas: bigint;
  /** The keeper's clock in milliseconds: it stamps the feed records and times the backoff. */
  now: () => number;
  log?: (message: string) => void;
}

interface KeeperCall {
  method: 'settle' | 'refund';
  args: Record<string, unknown>;
  gas: bigint;
}

/** A pool's run of failed calls. */
interface Backoff {
  /** Failed calls in a row. */
  failures: number;
  /** The pool is skipped until the clock reaches this time. */
  retryAtMs: number;
}

/** The wait after a pool's first failed call; each further failure in a row doubles it. */
const FIRST_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 600_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Why a call made no progress, for the log. */
function failureText(result: RelayResult): string {
  switch (result.kind) {
    case 'executed':
      return `made no progress (transaction ${result.outcome.txHash})`;
    case 'unknown':
      return `has an unknown result (transaction ${result.txHash})`;
    case 'rejected':
      return `was rejected (transaction ${result.txHash}): ${result.error}`;
  }
}

/**
 * Calls `settle` on every served Filled pool and `refund(pool_id, refundLimit)` on every served
 * Expired pool whose dust is not in flight (spec section 6.7), and records each call in the activity
 * feed. Anyone may call these methods, so the keeper is a convenience.
 *
 * A call that makes no progress (an executed call that did not move its pool on, by
 * keeperCallProgressed, or a rejected or unknown result) starts a backoff for its pool: the pool is
 * skipped for 30 s, twice as long after each further failure in a row, at most 10 minutes. A call
 * that makes progress ends the run. Only the first failure of a run goes to the feed; every failure
 * is logged.
 */
export class Keeper {
  readonly #chain: ChainReader;
  readonly #writer: ChainWriter;
  readonly #activity: ActivityLog;
  readonly #provider: string;
  readonly #poolsContract: string;
  readonly #refundLimit: number;
  readonly #settleGas: bigint;
  readonly #refundGas: bigint;
  readonly #now: () => number;
  readonly #log: (message: string) => void;
  /** The pools whose last call failed, by pool id. */
  readonly #backoff = new Map<number, Backoff>();
  /** The interval while started; null once stopped. */
  #intervalMs: number | null = null;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #running: Promise<void> | undefined;

  constructor(opts: KeeperOptions) {
    this.#chain = opts.chain;
    this.#writer = opts.writer;
    this.#activity = opts.activity;
    this.#provider = opts.provider;
    this.#poolsContract = opts.poolsContract;
    this.#refundLimit = opts.refundLimit;
    this.#settleGas = opts.settleGas;
    this.#refundGas = opts.refundGas;
    this.#now = opts.now;
    this.#log = opts.log ?? ((message) => console.error(message));
  }

  /**
   * One pass over the served pools, one call at a time, skipping pools in backoff. Never throws:
   * failures are logged, and a call that throws is retried next tick.
   */
  async tick(): Promise<void> {
    let pools: PoolView[];
    try {
      pools = await listServedPools(this.#chain, this.#provider);
    } catch (error) {
      this.#log(`keeper: listing pools failed: ${errorMessage(error)}`);
      return;
    }
    for (const pool of pools) {
      const call = this.#callFor(pool);
      if (call === null) {
        // A pool that needs no call has no run of failures to keep.
        this.#backoff.delete(pool.id);
        continue;
      }
      const backoff = this.#backoff.get(pool.id);
      if (backoff !== undefined && this.#now() < backoff.retryAtMs) continue;
      try {
        await this.#run(pool, call);
      } catch (error) {
        this.#log(`keeper: ${call.method} on pool ${pool.id} failed: ${errorMessage(error)}`);
      }
    }
  }

  /** Runs tick every `intervalMs`, waiting for each tick to finish before scheduling the next. */
  start(intervalMs: number): void {
    if (this.#intervalMs !== null) throw new Error('the keeper is already started');
    this.#intervalMs = intervalMs;
    // A tick still running from before a stop schedules the next one when it ends.
    if (this.#running === undefined) this.#schedule();
  }

  /** Stops scheduling and waits for a running tick. */
  async stop(): Promise<void> {
    this.#intervalMs = null;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    await this.#running;
  }

  #schedule(): void {
    if (this.#intervalMs === null) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#running = this.tick().finally(() => {
        this.#running = undefined;
        this.#schedule();
      });
    }, this.#intervalMs);
  }

  /**
   * The call a pool needs: `settle` when Filled; `refund` when Expired, unless every buyer has been
   * processed and the dust transfer is in flight (its callback marks the pool Refunded).
   */
  #callFor(pool: PoolView): KeeperCall | null {
    if (pool.status === 'filled') {
      return { method: 'settle', args: { pool_id: pool.id }, gas: this.#settleGas };
    }
    if (pool.status === 'expired' && !(pool.refund_cursor >= pool.buyer_count && pool.dust_sent)) {
      return { method: 'refund', args: { pool_id: pool.id, limit: this.#refundLimit }, gas: this.#refundGas };
    }
    return null;
  }

  async #run(pool: PoolView, call: KeeperCall): Promise<void> {
    const result = await this.#writer.callPools(call.method, call.args, call.gas);
    const nowMs = this.#now();
    const outcome = result.kind === 'executed' ? result.outcome : null;
    const records = outcome === null ? [] : keeperRecords(call.method, pool, outcome, this.#poolsContract, nowMs);
    if (outcome !== null && keeperCallProgressed(call.method, pool, outcome, this.#poolsContract)) {
      this.#backoff.delete(pool.id);
      await this.#append(records);
      return;
    }
    const backoff = this.#recordFailure(pool.id, nowMs);
    if (backoff.failures === 1) await this.#append(records);
    const waitSeconds = (backoff.retryAtMs - nowMs) / 1000;
    this.#log(`keeper: ${call.method} on pool ${pool.id} ${failureText(result)}; next try in ${waitSeconds} s`);
  }

  /** Counts one more failed call in a row for the pool and sets when it may be called again. */
  #recordFailure(poolId: number, nowMs: number): Backoff {
    const failures = (this.#backoff.get(poolId)?.failures ?? 0) + 1;
    const waitMs = Math.min(FIRST_BACKOFF_MS * 2 ** (failures - 1), MAX_BACKOFF_MS);
    const backoff = { failures, retryAtMs: nowMs + waitMs };
    this.#backoff.set(poolId, backoff);
    return backoff;
  }

  /** Appends records to the feed. A failed append is logged and the rest still go: the feed never stops the keeper. */
  async #append(records: ActivityRecord[]): Promise<void> {
    for (const record of records) {
      try {
        await this.#activity.append(record);
      } catch (error) {
        this.#log(`keeper: appending a ${record.kind} record for pool ${record.poolId} failed: ${errorMessage(error)}`);
      }
    }
  }
}
