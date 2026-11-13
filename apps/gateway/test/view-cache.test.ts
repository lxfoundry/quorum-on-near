import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { ViewCache } from '../src/view-cache.ts';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A read that answers 'answer 1', 'answer 2', … in turn, so that a test can tell its reads apart. */
function numberedRead(): Mock<() => Promise<string>> {
  let count = 0;
  return vi.fn(async () => {
    count += 1;
    return `answer ${count}`;
  });
}

/** The cache's clock, which tests move by hand. */
let clock: number;
let cache: ViewCache<string>;

beforeEach(() => {
  clock = 1_000;
  cache = new ViewCache<string>({ now: () => clock });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ViewCache', () => {
  it('serves a stored answer until 1 ms before 2 seconds, and reads again at 2 seconds', async () => {
    const read = numberedRead();
    expect(await cache.get('k', read)).toBe('answer 1');
    clock = 1_000 + 1_999;
    expect(await cache.get('k', read)).toBe('answer 1');
    expect(read).toHaveBeenCalledTimes(1);
    clock = 1_000 + 2_000;
    expect(await cache.get('k', read)).toBe('answer 2');
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('keeps each key apart', async () => {
    const read = numberedRead();
    expect(await cache.get('a', read)).toBe('answer 1');
    expect(await cache.get('b', read)).toBe('answer 2');
    expect(await cache.get('a', read)).toBe('answer 1');
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("counts an answer's age from when its read was sent, not from when it arrived", async () => {
    const answer = deferred<string>();
    const read = vi.fn(() => answer.promise);
    const first = cache.get('k', read);
    clock = 2_500;
    answer.resolve('slow answer');
    expect(await first).toBe('slow answer');
    clock = 1_000 + 1_999;
    expect(await cache.get('k', read)).toBe('slow answer');
    expect(read).toHaveBeenCalledTimes(1);
    clock = 1_000 + 2_000;
    read.mockResolvedValueOnce('next answer');
    expect(await cache.get('k', read)).toBe('next answer');
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('stores nothing from a read that took the whole 2 seconds', async () => {
    const answer = deferred<string>();
    const first = cache.get('k', () => answer.promise);
    clock = 1_000 + 2_000;
    answer.resolve('late answer');
    expect(await first).toBe('late answer');
    expect(cache.size).toBe(0);
  });

  it('counts a stored answer as expired once the clock has gone back', async () => {
    const read = numberedRead();
    await cache.get('k', read);
    clock = 999;
    expect(await cache.get('k', read)).toBe('answer 2');
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('joins no read in flight once the clock has gone back, and keeps the newer answer when that read ends later', async () => {
    const older = deferred<string>();
    const first = cache.get('k', () => older.promise);
    clock = 999;
    const read = numberedRead();
    expect(await cache.get('k', read)).toBe('answer 1');
    expect(read).toHaveBeenCalledTimes(1);
    clock = 1_500;
    older.resolve('older answer');
    expect(await first).toBe('older answer');
    expect(await cache.get('k', read)).toBe('answer 1');
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('shares one read between the callers that ask while it is in flight', async () => {
    const answer = deferred<{ pool: number }>();
    const objects = new ViewCache<{ pool: number }>({ now: () => clock });
    const read = vi.fn(() => answer.promise);
    const first = objects.get('k', read);
    clock = 1_000 + 1_999;
    const second = objects.get('k', read);
    expect(read).toHaveBeenCalledTimes(1);
    const value = { pool: 7 };
    answer.resolve(value);
    expect(await first).toBe(value);
    expect(await second).toBe(value);
  });

  it('sends a new read rather than join one sent 2 seconds ago, and keeps the newer answer when the older one ends later', async () => {
    const older = deferred<string>();
    const newer = deferred<string>();
    const read = vi.fn<() => Promise<string>>().mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    const first = cache.get('k', read);
    clock = 1_000 + 2_000;
    const second = cache.get('k', read);
    expect(read).toHaveBeenCalledTimes(2);
    newer.resolve('newer answer');
    expect(await second).toBe('newer answer');
    older.resolve('older answer');
    expect(await first).toBe('older answer');
    expect(await cache.get('k', read)).toBe('newer answer');
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('gives every caller an answer that keep refuses, and stores none of it', async () => {
    const pools = new ViewCache<number | null>({ now: () => clock, keep: (pool) => pool !== null });
    const answer = deferred<number | null>();
    const read = vi.fn<() => Promise<number | null>>().mockReturnValueOnce(answer.promise).mockResolvedValueOnce(7);
    const first = pools.get('k', read);
    const second = pools.get('k', read);
    answer.resolve(null);
    expect(await first).toBeNull();
    expect(await second).toBeNull();
    expect(pools.size).toBe(0);
    expect(await pools.get('k', read)).toBe(7);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('gives every caller of a read that fails the same error, and stores nothing', async () => {
    const answer = deferred<string>();
    const failure = new Error('Too Many Requests', { cause: 429 });
    const first = cache.get('k', () => answer.promise);
    const second = cache.get('k', () => answer.promise);
    answer.reject(failure);
    await expect(first).rejects.toBe(failure);
    await expect(second).rejects.toBe(failure);
    expect(cache.size).toBe(0);
    const read = numberedRead();
    expect(await cache.get('k', read)).toBe('answer 1');
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('rejects when the read throws before it returns a promise', async () => {
    const failure = new Error('could not build the request');
    const throwing = (): Promise<string> => {
      throw failure;
    };
    await expect(cache.get('k', throwing)).rejects.toBe(failure);
    const read = numberedRead();
    expect(await cache.get('k', read)).toBe('answer 1');
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('forgets every stored answer on clear', async () => {
    const read = numberedRead();
    await cache.get('a', read);
    await cache.get('b', read);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(await cache.get('a', read)).toBe('answer 3');
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('stores nothing from a read sent before clear, and lets no later caller join it', async () => {
    const before = deferred<string>();
    const after = deferred<string>();
    const read = vi.fn<() => Promise<string>>().mockReturnValueOnce(before.promise).mockReturnValueOnce(after.promise);
    const first = cache.get('k', read);
    cache.clear();
    const second = cache.get('k', read);
    expect(read).toHaveBeenCalledTimes(2);
    after.resolve('answer after clear');
    expect(await second).toBe('answer after clear');
    before.resolve('answer before clear');
    expect(await first).toBe('answer before clear');
    expect(await cache.get('k', read)).toBe('answer after clear');
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('stores nothing from a read sent before clear, even when no later read replaced it', async () => {
    const before = deferred<string>();
    const first = cache.get('k', () => before.promise);
    cache.clear();
    before.resolve('answer before clear');
    expect(await first).toBe('answer before clear');
    expect(cache.size).toBe(0);
  });

  it('keeps at most 64 answers, dropping the one stored first', async () => {
    const read = numberedRead();
    for (let key = 0; key <= 64; key += 1) await cache.get(`k${key}`, read);
    expect(cache.size).toBe(64);
    expect(read).toHaveBeenCalledTimes(65);
    await cache.get('k1', read);
    expect(read).toHaveBeenCalledTimes(65);
    await cache.get('k0', read);
    expect(read).toHaveBeenCalledTimes(66);
  });

  it('drops every expired answer when it stores one', async () => {
    const read = numberedRead();
    clock = 0;
    await cache.get('a', read);
    clock = 1;
    await cache.get('b', read);
    clock = 1_500;
    await cache.get('c', read);
    expect(cache.size).toBe(3);
    clock = 2_001;
    await cache.get('d', read);
    expect(cache.size).toBe(2);
    expect(await cache.get('c', read)).toBe('answer 3');
  });

  it('reads the time from performance.now by default', async () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(50_000);
    const monotonic = new ViewCache<string>();
    const read = numberedRead();
    await monotonic.get('k', read);
    now.mockReturnValue(50_000 + 1_999);
    expect(await monotonic.get('k', read)).toBe('answer 1');
    now.mockReturnValue(50_000 + 2_000);
    expect(await monotonic.get('k', read)).toBe('answer 2');
    expect(now).toHaveBeenCalled();
  });
});
