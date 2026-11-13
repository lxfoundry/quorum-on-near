import type { PoolView } from '@quorum-on-near/protocol';
import type { ChainWriter } from './chain.ts';
import type { PoolReader } from './pools.ts';
import { ViewCache } from './view-cache.ts';

/** Pool views by pool id, as `getPool` answers them. */
export type PoolViewCache = ViewCache<PoolView | null>;

/**
 * A cache of pool views that never keeps `null`: a pool can be opened at any moment, and a stored
 * `null` would answer its redemptions `404 unknown_pool` until it expired. `now` is the cache's
 * clock, for tests; by default `performance.now()`.
 */
export function poolViewCache(now?: () => number): PoolViewCache {
  return new ViewCache<PoolView | null>({ now, keep: (pool) => pool !== null });
}

/**
 * `pools.getPool` through `cache`: the callers that ask for a pool within VIEW_CACHE_TTL_MS of when
 * its read was sent share that read (view-cache.ts). Each caller gets its own copy of the view.
 */
export function cachePoolReads(pools: PoolReader, cache: PoolViewCache): PoolReader {
  return {
    async getPool(poolId) {
      const pool = await cache.get(String(poolId), () => pools.getPool(poolId));
      // The cache shares its answer between callers, so each one gets a copy (every field is a primitive).
      return pool === null ? null : { ...pool };
    },
  };
}

/**
 * `writer`, with `cache` cleared once each transaction it sends has returned or thrown, so a pool
 * read through the cache is never older than the gateway's own last transaction: a read still in
 * flight at that moment stores nothing (ViewCache.clear). Each call reaches `writer` once, with the
 * same arguments, and its result or its error comes back unchanged. A throw or a `rejected` result
 * sent nothing, and clearing then only costs a read.
 */
export function clearAfterSends(writer: ChainWriter, cache: Pick<PoolViewCache, 'clear'>): ChainWriter {
  return {
    async relayDelegate(signed, maxBlockHeight) {
      try {
        return await writer.relayDelegate(signed, maxBlockHeight);
      } finally {
        cache.clear();
      }
    },
    async callPools(method, args, gas) {
      try {
        return await writer.callPools(method, args, gas);
      } finally {
        cache.clear();
      }
    },
  };
}
