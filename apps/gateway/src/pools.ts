import { MAX_PAGE, minBonusPerSeat, type PoolView } from '@quorum-on-near/protocol';
import type { ChainReader } from './chain.ts';

/**
 * Every pool whose seller is `provider`, in id order. Pages `list_pools` by MAX_PAGE until a page
 * comes back shorter than that.
 */
export async function listServedPools(chain: ChainReader, provider: string): Promise<PoolView[]> {
  const served: PoolView[] = [];
  // Pool ids run from 0 with no gaps, so each page starts MAX_PAGE ids after the last.
  for (let from = 0; ; from += MAX_PAGE) {
    const page = await chain.listPools(from, MAX_PAGE);
    served.push(...page.filter((pool) => pool.seller === provider));
    if (page.length < MAX_PAGE) return served;
  }
}

/** A row of `GET /pools` (spec section 6.1). */
export interface PoolListing {
  id: number;
  terms: string;
  seat_price: string;
  target: number;
  taken: number;
  deadline_ms: number;
  bonus: string;
  min_bonus_per_seat: string;
}

/** The served pools that are open with seats left, as `GET /pools` lists them. */
export async function openPoolListings(chain: ChainReader, provider: string): Promise<PoolListing[]> {
  const pools = await listServedPools(chain, provider);
  return pools
    .filter((pool) => pool.status === 'open' && pool.taken < pool.target)
    .map((pool) => ({
      id: pool.id,
      terms: pool.terms,
      seat_price: pool.seat_price,
      target: pool.target,
      taken: pool.taken,
      deadline_ms: pool.deadline_ms,
      bonus: pool.bonus,
      min_bonus_per_seat: minBonusPerSeat(BigInt(pool.bonus), pool.target).toString(),
    }));
}

/** The pool if it exists and `provider` sells it; otherwise null. */
export async function servedPool(chain: ChainReader, provider: string, poolId: number): Promise<PoolView | null> {
  const pool = await chain.getPool(poolId);
  return pool !== null && pool.seller === provider ? pool : null;
}
