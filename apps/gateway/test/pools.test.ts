import { describe, expect, it } from 'vitest';
import { MAX_PAGE, type PoolStatus } from '@quorum-on-near/protocol';
import { listServedPools, openPoolListings, servedPool } from '../src/pools.ts';
import { FakeChain, PROVIDER, TERMS, poolView } from './fake-chain.ts';

const OTHER_SELLER = 'other-seller.testnet';

function chainWithPools(count: number, seller: (id: number) => string = () => PROVIDER): FakeChain {
  const chain = new FakeChain();
  for (let id = 0; id < count; id++) chain.setPool(poolView({ id, seller: seller(id) }));
  return chain;
}

describe('listServedPools', () => {
  it('pages through more than one page of pools, in id order', async () => {
    const chain = chainWithPools(2 * MAX_PAGE + 50);
    const pools = await listServedPools(chain, PROVIDER);
    expect(pools.map((p) => p.id)).toEqual([...Array(2 * MAX_PAGE + 50).keys()]);
    expect(chain.reads.get('list_pools')).toBe(3);
  });

  it('asks for another page after a full one', async () => {
    const chain = chainWithPools(MAX_PAGE);
    const pools = await listServedPools(chain, PROVIDER);
    expect(pools).toHaveLength(MAX_PAGE);
    expect(chain.reads.get('list_pools')).toBe(2);
  });

  it('returns nothing when the contract has no pools', async () => {
    const chain = new FakeChain();
    expect(await listServedPools(chain, PROVIDER)).toEqual([]);
    expect(chain.reads.get('list_pools')).toBe(1);
  });

  it("keeps only the provider's pools", async () => {
    const chain = chainWithPools(MAX_PAGE + 20, (id) => (id % 3 === 0 ? PROVIDER : OTHER_SELLER));
    const pools = await listServedPools(chain, PROVIDER);
    expect(pools.map((p) => p.id)).toEqual([...Array(MAX_PAGE + 20).keys()].filter((id) => id % 3 === 0));
    expect(pools.every((p) => p.seller === PROVIDER)).toBe(true);
  });
});

describe('openPoolListings', () => {
  it('lists only served pools that are open with seats left', async () => {
    const chain = new FakeChain();
    const statuses: PoolStatus[] = ['open', 'filled', 'settled', 'expired', 'refunded'];
    statuses.forEach((status, id) => chain.setPool(poolView({ id, status })));
    chain.setPool(poolView({ id: 5, status: 'open', taken: 192, target: 192 }));
    chain.setPool(poolView({ id: 6, status: 'open', seller: OTHER_SELLER }));
    chain.setPool(poolView({ id: 7, status: 'open', taken: 0 }));
    const listings = await openPoolListings(chain, PROVIDER);
    expect(listings.map((l) => l.id)).toEqual([0, 7]);
  });

  it("gives each pool's public terms and the least bonus a seat receives if the pool fails", async () => {
    const chain = new FakeChain();
    chain.setPool(poolView({ id: 7, bonus: '1728', target: 192, taken: 148 }));
    expect(await openPoolListings(chain, PROVIDER)).toEqual([
      {
        id: 7,
        terms: TERMS,
        seat_price: '180',
        target: 192,
        taken: 148,
        deadline_ms: 1_800_000_000_000,
        bonus: '1728',
        // floor(1728 / (192 - 1))
        min_bonus_per_seat: '9',
      },
    ]);
  });
});

describe('servedPool', () => {
  it('returns a pool that the provider sells', async () => {
    const chain = new FakeChain();
    const pool = poolView({ id: 7 });
    chain.setPool(pool);
    expect(await servedPool(chain, PROVIDER, 7)).toEqual(pool);
  });

  it("returns null for another seller's pool", async () => {
    const chain = new FakeChain();
    chain.setPool(poolView({ id: 7, seller: OTHER_SELLER }));
    expect(await servedPool(chain, PROVIDER, 7)).toBeNull();
  });

  it('returns null for a pool that does not exist', async () => {
    const chain = new FakeChain();
    expect(await servedPool(chain, PROVIDER, 7)).toBeNull();
  });
});
