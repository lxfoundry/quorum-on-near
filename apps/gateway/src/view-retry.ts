import { setTimeout as delay } from 'node:timers/promises';
import type { Provider, SerializedReturnValue } from 'near-api-js';

/** The provider methods the gateway reads the chain with. None of them sends a transaction. */
export type ViewProvider = Pick<Provider, 'callFunction' | 'viewAccessKey' | 'viewBlock' | 'viewNodeStatus'>;

/**
 * The waits, in milliseconds, before the second, third and fourth attempt of a view the RPC answered
 * with HTTP 429, before jitter. The last attempt comes at least 1.4 seconds after the first, so in a
 * later one-second window of an RPC that limits requests per second.
 */
export const VIEW_RETRY_WAITS_MS: readonly number[] = [200, 400, 800];

/** How retryViewsOn429 waits. */
export interface ViewRetryOptions {
  /** Waits `ms` milliseconds. Default `setTimeout` from `node:timers/promises`. */
  sleep?: (ms: number) => Promise<void>;
  /** A number in [0, 1) that stretches each wait by up to half again. Default `Math.random`. */
  random?: () => number;
}

/**
 * True for HTTP 429 (too many requests). near-api-js throws its own error class, which it does not
 * export, for an HTTP error status, with the status as the error's cause. It does not retry a 429
 * itself, so an attempt that ends in a 429 ended on that post; the attempt may have posted several
 * times first, since it retries a 503, 500 or 408 with its own backoff.
 */
function isTooManyRequests(error: unknown): boolean {
  return error instanceof Error && error.cause === 429;
}

/**
 * `inner`'s four view methods, each tried again after HTTP 429, at most VIEW_RETRY_WAITS_MS.length
 * more times, each wait stretched by up to half again so that reads refused together are not all
 * retried together. Any other error is rethrown at once, and the last 429 once the retries are
 * spent, both unchanged. The result has these four methods and no other, so nothing can send a
 * transaction through it: a transaction is never posted twice.
 *
 * It logs nothing: a 429's message is the RPC's answer as it came.
 */
export function retryViewsOn429(inner: ViewProvider, opts: ViewRetryOptions = {}): ViewProvider {
  const sleep = opts.sleep ?? ((ms: number) => delay(ms));
  const random = opts.random ?? Math.random;

  async function retrying<T>(view: () => Promise<T>): Promise<T> {
    for (const waitMs of VIEW_RETRY_WAITS_MS) {
      try {
        return await view();
      } catch (error) {
        if (!isTooManyRequests(error)) throw error;
      }
      await sleep(waitMs * (1 + random() / 2));
    }
    return view();
  }

  return {
    // callFunction is generic, so its wrapper is too.
    callFunction: <T extends SerializedReturnValue>(params: Parameters<ViewProvider['callFunction']>[0]) =>
      retrying(() => inner.callFunction<T>(params)),
    viewAccessKey: (params) => retrying(() => inner.viewAccessKey(params)),
    viewBlock: (blockQuery) => retrying(() => inner.viewBlock(blockQuery)),
    viewNodeStatus: () => retrying(() => inner.viewNodeStatus()),
  };
}
