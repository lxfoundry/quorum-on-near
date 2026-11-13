/**
 * How long a stored answer is served, in milliseconds, counted from when its read was sent. The live
 * page refreshes every 2 seconds, so a cached view costs at most one read per 2 seconds however many
 * pages are open. A scripted buyer polls its redemption every 5 seconds by default, so it never gets
 * the same cached answer on two polls in a row.
 */
export const VIEW_CACHE_TTL_MS = 2_000;
/** The most answers a cache keeps. Its keys come from requests (a pool id, a view's arguments), so any caller can add one. */
export const VIEW_CACHE_MAX_ENTRIES = 64;

/** How a ViewCache is set up. */
export interface ViewCacheOptions<T> {
  /** The cache's clock, in milliseconds. Default `performance.now()`, which never goes back. */
  now?: () => number;
  /** Whether an answer may be stored. One it refuses still answers every caller of its read. Default: every answer. */
  keep?: (value: T) => boolean;
}

/** A stored answer. */
interface Entry<T> {
  value: T;
  /** When its read was sent, by the cache's clock. */
  sentAtMs: number;
}

/** A read in flight, which callers of the same key may join. */
interface Pending<T> {
  promise: Promise<T>;
  /** When it was sent, by the cache's clock. */
  sentAtMs: number;
  /** The cache's generation when it was sent. A `clear()` since then means its answer is not stored. */
  generation: number;
}

/**
 * A short-lived, bounded, in-memory cache of view answers, with one read in flight per key.
 *
 * - An answer is fresh while `0 <= now() - sentAtMs < VIEW_CACHE_TTL_MS`, `sentAtMs` being when its
 *   read was sent, not when it arrived: every answer a caller gets was requested less than the TTL
 *   before the caller asked. An age below zero (a clock that went back) counts as expired.
 * - A caller with no fresh answer joins the key's read in flight if that read was sent less than the
 *   TTL ago and no `clear()` came after it; otherwise it sends a new read.
 * - A read stores its answer only if it is still the key's latest read, no `clear()` came after it was
 *   sent, and `keep` accepts the answer. A read that rejects stores nothing, and every caller that
 *   joined it gets the same rejection.
 * - Each store first drops every expired answer, then the oldest stored while VIEW_CACHE_MAX_ENTRIES
 *   are kept.
 *
 * Callers share an answer: it is never copied, so they must not change it.
 */
export class ViewCache<T> {
  readonly #now: () => number;
  readonly #keep: (value: T) => boolean;
  /** The stored answers, in the order they were stored: the oldest first. */
  readonly #entries = new Map<string, Entry<T>>();
  /** The latest read sent for each key, while it is in flight. */
  readonly #pending = new Map<string, Pending<T>>();
  /** Counts the calls to `clear()`. */
  #generation = 0;

  constructor(options: ViewCacheOptions<T> = {}) {
    this.#now = options.now ?? (() => performance.now());
    this.#keep = options.keep ?? (() => true);
  }

  /** The answers stored, fresh or expired but not yet dropped. */
  get size(): number {
    return this.#entries.size;
  }

  /** The answer for `key`: a fresh stored one, the one of the read in flight, or the one `read` sends now. */
  get(key: string, read: () => Promise<T>): Promise<T> {
    const nowMs = this.#now();
    const entry = this.#entries.get(key);
    if (entry !== undefined && this.#isFresh(entry.sentAtMs, nowMs)) return Promise.resolve(entry.value);
    const pending = this.#pending.get(key);
    if (pending !== undefined && pending.generation === this.#generation && this.#isFresh(pending.sentAtMs, nowMs)) {
      return pending.promise;
    }
    return this.#send(key, read, nowMs);
  }

  /** Forgets every stored answer. A read in flight still answers its callers, but stores nothing and is joined by no one. */
  clear(): void {
    this.#entries.clear();
    this.#generation += 1;
  }

  /** Sent less than the TTL ago. A clock that went back makes nothing fresh. */
  #isFresh(sentAtMs: number, nowMs: number): boolean {
    const ageMs = nowMs - sentAtMs;
    return ageMs >= 0 && ageMs < VIEW_CACHE_TTL_MS;
  }

  #send(key: string, read: () => Promise<T>, sentAtMs: number): Promise<T> {
    // `read` is called at once, so the request is sent now; one that throws before it returns a
    // promise rejects like one that fails later.
    const sent = new Promise<T>((resolve) => resolve(read()));
    const pending: Pending<T> = {
      sentAtMs,
      generation: this.#generation,
      promise: sent.then(
        (value) => {
          if (this.#pending.get(key) === pending) {
            this.#pending.delete(key);
            if (pending.generation === this.#generation && this.#keep(value)) this.#store(key, value, sentAtMs);
          }
          return value;
        },
        (error: unknown) => {
          if (this.#pending.get(key) === pending) this.#pending.delete(key);
          throw error;
        },
      ),
    };
    this.#pending.set(key, pending);
    return pending.promise;
  }

  #store(key: string, value: T, sentAtMs: number): void {
    const nowMs = this.#now();
    for (const [k, entry] of this.#entries) {
      if (!this.#isFresh(entry.sentAtMs, nowMs)) this.#entries.delete(k);
    }
    // A read that took the whole TTL has nothing left to serve.
    if (!this.#isFresh(sentAtMs, nowMs)) return;
    // Deleted first, so that the key is stored again as the newest.
    this.#entries.delete(key);
    for (const oldest of this.#entries.keys()) {
      if (this.#entries.size < VIEW_CACHE_MAX_ENTRIES) break;
      this.#entries.delete(oldest);
    }
    this.#entries.set(key, { value, sentAtMs });
  }
}
