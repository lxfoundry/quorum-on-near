import { buildOffer, type PoolStatus } from '@quorum-on-near/protocol';
import { describe, expect, it, vi } from 'vitest';
import { currentAccepts, handleOffer, offerContext, parseSeats } from '../src/handle-offer.ts';
import { POOLS, PROVIDER, RELAYER, TERMS, TOKEN, poolView, testConfig } from './fake-chain.ts';
import { testDeps } from './handler-deps.ts';

const CLOSED: PoolStatus[] = ['filled', 'settled', 'expired', 'refunded'];

describe('parseSeats', () => {
  it('reads an absent parameter as one seat', () => {
    expect(parseSeats(undefined)).toBe(1);
  });

  it.each([
    ['1', 1],
    ['24', 24],
    ['1000', 1000],
  ])('reads %j as %i seats', (param, seats) => {
    expect(parseSeats(param)).toBe(seats);
  });

  it.each(['', '0', '01', '-1', '+1', '1.5', '1e3', ' 2', '2 ', '0x10', 'two', '1001', '9'.repeat(400)])(
    'refuses %j',
    (param) => {
      expect(parseSeats(param)).toBeNull();
    },
  );
});

describe('offerContext', () => {
  it("takes the network, URLs, accounts, gas bounds and timeout from the gateway's configuration", () => {
    const config = testConfig({ publicUrl: 'https://gateway.example', maxTimeoutSeconds: 90 });
    expect(offerContext(config)).toEqual({
      network: 'near:testnet',
      gatewayUrl: 'https://gateway.example',
      poolsContract: POOLS,
      token: TOKEN,
      relayer: RELAYER,
      minGas: 50_000_000_000_000n,
      maxGas: 100_000_000_000_000n,
      maxTimeoutSeconds: 90,
    });
  });
});

describe('currentAccepts', () => {
  const config = testConfig();
  const ctx = offerContext(config);

  it('offers the seats asked for when the pool has them', () => {
    const pool = poolView();
    expect(currentAccepts(pool, 2, config)).toEqual([buildOffer(pool, 2, ctx)]);
  });

  it('offers only the seats left', () => {
    const pool = poolView({ taken: 190 });
    expect(currentAccepts(pool, 5, config)).toEqual([buildOffer(pool, 2, ctx)]);
  });

  it("offers no more than the pool's limit per buyer", () => {
    const pool = poolView({ taken: 0, max_seats_per_buyer: 24 });
    expect(currentAccepts(pool, 30, config)).toEqual([buildOffer(pool, 24, ctx)]);
  });

  it.each(CLOSED)('offers nothing for a pool that is %s', (status) => {
    expect(currentAccepts(poolView({ status }), 2, config)).toEqual([]);
  });

  it('offers nothing for an open pool with no seat left', () => {
    expect(currentAccepts(poolView({ taken: 192 }), 2, config)).toEqual([]);
  });

  it("offers a buyer no more than the pool's limit less the seats it holds", () => {
    const pool = poolView({ max_seats_per_buyer: 24 });
    expect(currentAccepts(pool, 10, config, 20)).toEqual([buildOffer(pool, 4, ctx)]);
  });

  it.each([24, 30])('offers nothing to a buyer holding %i seats of a 24-seat limit', (held) => {
    expect(currentAccepts(poolView({ max_seats_per_buyer: 24 }), 2, config, held)).toEqual([]);
  });

  it('ignores the seats held when the pool has no limit per buyer', () => {
    const pool = poolView({ max_seats_per_buyer: null });
    expect(currentAccepts(pool, 5, config, 500)).toEqual([buildOffer(pool, 5, ctx)]);
  });
});

describe('handleOffer', () => {
  it("answers 402 with spec section 6.2's offer for two seats of pool 7", async () => {
    const deps = await testDeps();
    deps.fake.setPool(poolView());
    expect(await handleOffer(deps, 7, '2')).toEqual({
      status: 402,
      body: {
        x402Version: 1,
        error: 'payment required',
        accepts: [
          {
            scheme: 'quorum',
            network: 'near:testnet',
            maxAmountRequired: '360',
            resource: 'http://localhost:8402/pools/7/access?seats=2',
            description: `2 seats in pool 7: ${TERMS}`,
            mimeType: 'application/json',
            payTo: POOLS,
            maxTimeoutSeconds: 120,
            asset: TOKEN,
            extra: {
              poolId: 7,
              seats: 2,
              seatPrice: '180',
              target: 192,
              taken: 148,
              deadlineMs: 1_800_000_000_000,
              bonus: '1728',
              minBonusPerSeat: '9',
              terms: TERMS,
              relayer: RELAYER,
              minGas: '50000000000000',
              maxGas: '100000000000000',
            },
          },
        ],
      },
    });
  });

  it('offers one seat when the request does not say how many', async () => {
    const deps = await testDeps();
    const pool = poolView();
    deps.fake.setPool(pool);
    expect(await handleOffer(deps, 7, undefined)).toEqual({
      status: 402,
      body: { x402Version: 1, error: 'payment required', accepts: [buildOffer(pool, 1, offerContext(deps.config))] },
    });
  });

  it('offers only the seats left when fewer are left than asked for', async () => {
    const deps = await testDeps();
    deps.fake.setPool(poolView({ taken: 190 }));
    const result = await handleOffer(deps, 7, '5');
    expect(result.status).toBe(402);
    expect(result.body).toMatchObject({
      accepts: [{ maxAmountRequired: '360', resource: 'http://localhost:8402/pools/7/access?seats=2', extra: { seats: 2 } }],
    });
  });

  it("offers no more than the pool's limit per buyer", async () => {
    const deps = await testDeps();
    deps.fake.setPool(poolView({ taken: 0, max_seats_per_buyer: 24 }));
    const result = await handleOffer(deps, 7, '30');
    expect(result.status).toBe(402);
    expect(result.body).toMatchObject({ accepts: [{ maxAmountRequired: '4320', extra: { seats: 24 } }] });
  });

  it('answers 400 invalid_seats for an invalid seats parameter, without reading the chain', async () => {
    const deps = await testDeps();
    deps.fake.setPool(poolView());
    expect(await handleOffer(deps, 7, '0')).toEqual({ status: 400, body: { error: 'invalid_seats' } });
    expect(deps.fake.reads.size).toBe(0);
  });

  it('answers 404 unknown_pool for a pool that does not exist', async () => {
    const deps = await testDeps();
    deps.fake.setPool(poolView({ id: 7 }));
    expect(await handleOffer(deps, 8, '2')).toEqual({ status: 404, body: { error: 'unknown_pool' } });
  });

  it("answers 404 unknown_pool for another seller's pool", async () => {
    const deps = await testDeps();
    deps.fake.setPool(poolView({ seller: `other.${PROVIDER}` }));
    expect(await handleOffer(deps, 7, '2')).toEqual({ status: 404, body: { error: 'unknown_pool' } });
  });

  it.each(['filled', 'settled'] as const)(
    'answers 409 pool_closed with the status for a pool that is %s',
    async (status) => {
      const deps = await testDeps();
      deps.fake.setPool(poolView({ status, taken: 192 }));
      expect(await handleOffer(deps, 7, '2')).toEqual({ status: 409, body: { error: 'pool_closed', status } });
    },
  );

  it('answers 409 pool_closed for an open pool with no seat left', async () => {
    const deps = await testDeps();
    deps.fake.setPool(poolView({ taken: 192 }));
    expect(await handleOffer(deps, 7, '2')).toEqual({ status: 409, body: { error: 'pool_closed', status: 'open' } });
  });

  it.each(['expired', 'refunded'] as const)(
    'answers 410 pool_expired with the status for a pool that is %s',
    async (status) => {
      const deps = await testDeps();
      deps.fake.setPool(poolView({ status }));
      expect(await handleOffer(deps, 7, '2')).toEqual({ status: 410, body: { error: 'pool_expired', status } });
    },
  );

  it('answers 503 chain_unavailable when the pool cannot be read', async () => {
    const deps = await testDeps();
    vi.spyOn(deps.fake, 'getPool').mockRejectedValue(new Error('connect ECONNREFUSED'));
    expect(await handleOffer(deps, 7, '2')).toEqual({ status: 503, body: { error: 'chain_unavailable' } });
  });
});
