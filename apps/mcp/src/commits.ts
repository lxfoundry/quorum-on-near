/**
 * What quorum_commit keeps between calls, in memory, for this process: per pool, the height above
 * which a final block settles the last payment to it whose result is unknown (its `maxBlockHeight`
 * plus SETTLE_MARGIN_BLOCKS), and a queue that runs one commit at a time. An agent may call tools
 * concurrently, and a commit must see the hold that the commit before it may leave, so it checks the
 * holds only once every commit queued before it has answered.
 */
export class Commits {
  readonly #unsettled = new Map<number, bigint>();
  /** Settles once the commit in progress, if any, has answered or thrown. */
  #idle: Promise<void> = Promise.resolve();

  /** Holds `pool` until a final block above `untilHeight`; a later height already held is kept. */
  hold(pool: number, untilHeight: bigint): void {
    const held = this.#unsettled.get(pool);
    if (held === undefined || held < untilHeight) this.#unsettled.set(pool, untilHeight);
  }

  /** The height above which a final block lifts the hold on `pool`, or undefined when it is not held. */
  heldUntil(pool: number): bigint | undefined {
    return this.#unsettled.get(pool);
  }

  /** Lifts the hold on `pool`, once a final block above its height has been seen. */
  release(pool: number): void {
    this.#unsettled.delete(pool);
  }

  /** Runs `commit` once every commit queued before it has answered or thrown. */
  serial<T>(commit: () => Promise<T>): Promise<T> {
    const run = this.#idle.then(commit);
    this.#idle = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
