import {
  PAYMENT_HEADER,
  PROOF_HEADER,
  buildOffer,
  buildPaymentHeader,
  buildRedeemProofHeader,
  maxBlockHeightFor,
  type DecodedSignedDelegate,
  type PoolView,
} from '@quorum-on-near/protocol';
import { KeyPair } from 'near-api-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.ts';
import { DelegateExpiredError, type RelayResult } from '../src/chain.ts';
import type { Deps } from '../src/deps.ts';
import { offerContext } from '../src/handle-offer.ts';
import { cachePoolReads, clearAfterSends, poolViewCache, type PoolViewCache } from '../src/pool-cache.ts';
import { POOLS, TOKEN, FakeChain, commitOutcome, outcome, poolView } from './fake-chain.ts';
import { testDeps } from './handler-deps.ts';

const BUYER = 'buyer.testnet';
const POOL_ID = 7;
const TX_HASH = 'RelayTx111';

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

/** The cache's clock, which tests move by hand. */
let clock: number;
let cache: PoolViewCache;

beforeEach(() => {
  clock = 1_000;
  cache = poolViewCache(() => clock);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** A FakeChain holding pool 7, and its getPool through the cache. */
function cachedFake() {
  const fake = new FakeChain();
  fake.setPool(poolView({ id: POOL_ID }));
  return { fake, pools: cachePoolReads(fake, cache) };
}

function getPoolReads(fake: FakeChain): number {
  return fake.reads.get('get_pool') ?? 0;
}

/** A transaction that ran, as the writer returns it. */
function executed(txHash: string): RelayResult {
  return { kind: 'executed', outcome: outcome(txHash, [{ executorId: POOLS }]) };
}

/** A delegate the fake writer takes as it is: it reads none of its fields. */
const SIGNED = {} as DecodedSignedDelegate;

describe('cachePoolReads', () => {
  it('reads a pool once for the callers within 2 seconds of its read, and again at 2 seconds', async () => {
    const { fake, pools } = cachedFake();
    expect(await pools.getPool(POOL_ID)).toEqual(poolView({ id: POOL_ID }));
    clock = 1_000 + 1_999;
    fake.setPool(poolView({ id: POOL_ID, taken: 150 }));
    expect((await pools.getPool(POOL_ID))?.taken).toBe(148);
    expect(getPoolReads(fake)).toBe(1);
    clock = 1_000 + 2_000;
    expect((await pools.getPool(POOL_ID))?.taken).toBe(150);
    expect(getPoolReads(fake)).toBe(2);
  });

  it('shares one read between the callers that ask while it is in flight', async () => {
    const { fake, pools } = cachedFake();
    const answer = deferred<PoolView | null>();
    const read = vi.spyOn(fake, 'getPool').mockReturnValue(answer.promise);
    const first = pools.getPool(POOL_ID);
    const second = pools.getPool(POOL_ID);
    expect(read).toHaveBeenCalledOnce();
    answer.resolve(poolView({ id: POOL_ID }));
    expect(await first).toEqual(poolView({ id: POOL_ID }));
    expect(await second).toEqual(poolView({ id: POOL_ID }));
  });

  it('keeps each pool apart', async () => {
    const { fake, pools } = cachedFake();
    fake.setPool(poolView({ id: 8, taken: 3 }));
    expect((await pools.getPool(POOL_ID))?.id).toBe(POOL_ID);
    expect((await pools.getPool(8))?.taken).toBe(3);
    expect(getPoolReads(fake)).toBe(2);
  });

  it('keeps no answer that a pool does not exist, so a pool opened since is found at once', async () => {
    const fake = new FakeChain();
    const pools = cachePoolReads(fake, cache);
    expect(await pools.getPool(POOL_ID)).toBeNull();
    fake.setPool(poolView({ id: POOL_ID }));
    expect(await pools.getPool(POOL_ID)).toEqual(poolView({ id: POOL_ID }));
    expect(await pools.getPool(POOL_ID)).toEqual(poolView({ id: POOL_ID }));
    expect(getPoolReads(fake)).toBe(2);
  });

  it('hands each caller its own copy of the view', async () => {
    const { pools } = cachedFake();
    const first = await pools.getPool(POOL_ID);
    if (first === null) throw new Error('pool 7 is missing');
    first.taken = 0;
    expect((await pools.getPool(POOL_ID))?.taken).toBe(148);
  });
});

describe('clearAfterSends', () => {
  it.each<RelayResult>([
    executed(TX_HASH),
    { kind: 'unknown', txHash: TX_HASH, expired: false },
    { kind: 'rejected', txHash: TX_HASH, error: 'InvalidNonce' },
  ])('reads every pool again once a relayed delegate returns $kind, and returns its result unchanged', async (result) => {
    const { fake, pools } = cachedFake();
    const writer = clearAfterSends(fake, cache);
    await pools.getPool(POOL_ID);
    fake.relayResults.push(result);
    expect(await writer.relayDelegate(SIGNED, 1_200n)).toBe(result);
    expect(fake.relayed).toEqual([{ signed: SIGNED, maxBlockHeight: 1_200n }]);
    await pools.getPool(POOL_ID);
    expect(getPoolReads(fake)).toBe(2);
  });

  it("reads every pool again once a keeper's call returns, and returns its result unchanged", async () => {
    const { fake, pools } = cachedFake();
    const writer = clearAfterSends(fake, cache);
    await pools.getPool(POOL_ID);
    const result = executed('SettleTx1');
    fake.callResults.push(result);
    expect(await writer.callPools('settle', { pool_id: POOL_ID }, 100n)).toBe(result);
    expect(fake.calls).toEqual([{ method: 'settle', args: { pool_id: POOL_ID }, gas: 100n }]);
    await pools.getPool(POOL_ID);
    expect(getPoolReads(fake)).toBe(2);
  });

  it('reads every pool again when a relay throws, and rethrows its error', async () => {
    const { fake, pools } = cachedFake();
    const writer = clearAfterSends(fake, cache);
    await pools.getPool(POOL_ID);
    const failure = new DelegateExpiredError('too close to max_block_height');
    fake.onRelay = () => {
      throw failure;
    };
    await expect(writer.relayDelegate(SIGNED, 1_200n)).rejects.toBe(failure);
    await pools.getPool(POOL_ID);
    expect(getPoolReads(fake)).toBe(2);
  });

  it("reads every pool again when a keeper's call throws, and rethrows its error", async () => {
    const { fake, pools } = cachedFake();
    const writer = clearAfterSends(fake, cache);
    await pools.getPool(POOL_ID);
    const failure = new Error('connection reset');
    fake.onCall = () => {
      throw failure;
    };
    await expect(writer.callPools('refund', { pool_id: POOL_ID }, 100n)).rejects.toBe(failure);
    expect(fake.calls).toEqual([{ method: 'refund', args: { pool_id: POOL_ID }, gas: 100n }]);
    await pools.getPool(POOL_ID);
    expect(getPoolReads(fake)).toBe(2);
  });

  it("clears the pools once a keeper's call has settled, and before its result reaches the caller", async () => {
    const { fake } = cachedFake();
    const events: string[] = [];
    const writer = clearAfterSends(fake, {
      clear: () => {
        events.push('clear');
      },
    });
    const call = deferred<RelayResult>();
    fake.onCall = () => {
      events.push('call');
      return call.promise;
    };
    const result = executed('SettleTx1');
    const sent = writer.callPools('settle', { pool_id: POOL_ID }, 100n).then((value) => {
      events.push('result');
      return value;
    });
    expect(events).toEqual(['call']);
    call.resolve(result);
    expect(await sent).toBe(result);
    expect(events).toEqual(['call', 'clear', 'result']);
  });

  it("clears the pools once a keeper's call has thrown, and before its error reaches the caller", async () => {
    const { fake } = cachedFake();
    const events: string[] = [];
    const writer = clearAfterSends(fake, {
      clear: () => {
        events.push('clear');
      },
    });
    const call = deferred<RelayResult>();
    fake.onCall = () => {
      events.push('call');
      return call.promise;
    };
    const failure = new Error('connection reset');
    const sent = writer.callPools('settle', { pool_id: POOL_ID }, 100n).catch((error: unknown) => {
      events.push('error');
      throw error;
    });
    expect(events).toEqual(['call']);
    call.reject(failure);
    await expect(sent).rejects.toBe(failure);
    expect(events).toEqual(['call', 'clear', 'error']);
  });

  it('stores nothing from a pool read sent before the transaction returned', async () => {
    const { fake, pools } = cachedFake();
    const writer = clearAfterSends(fake, cache);
    const relay = deferred<RelayResult>();
    fake.onRelay = () => relay.promise;
    const sent = writer.relayDelegate(SIGNED, 1_200n);
    const answer = deferred<PoolView | null>();
    const read = vi.spyOn(fake, 'getPool').mockReturnValueOnce(answer.promise);
    const before = pools.getPool(POOL_ID);
    relay.resolve(executed(TX_HASH));
    await sent;
    answer.resolve(poolView({ id: POOL_ID }));
    await before;
    await pools.getPool(POOL_ID);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("stores nothing from a pool read sent before a keeper's call returned", async () => {
    const { fake, pools } = cachedFake();
    const writer = clearAfterSends(fake, cache);
    const call = deferred<RelayResult>();
    fake.onCall = () => call.promise;
    const sent = writer.callPools('settle', { pool_id: POOL_ID }, 100n);
    const answer = deferred<PoolView | null>();
    const read = vi.spyOn(fake, 'getPool').mockReturnValueOnce(answer.promise);
    const before = pools.getPool(POOL_ID);
    call.resolve(executed('SettleTx1'));
    await sent;
    answer.resolve(poolView({ id: POOL_ID }));
    await before;
    await pools.getPool(POOL_ID);
    expect(read).toHaveBeenCalledTimes(2);
  });
});

describe('redemptions through the pool cache', () => {
  /**
   * The app over deps whose redemptions read pool 7 through the cache, from a reader that does not
   * count in `fake.reads`; so `redeemReads` counts the redemptions' pool reads, and
   * `fake.reads.get('get_pool')` every other route's. A buyer holds 2 committed seats.
   */
  async function setup() {
    const deps = await testDeps();
    const { fake } = deps;
    fake.setPool(poolView({ id: POOL_ID }));
    const redeemReads = vi.fn(async (poolId: number) => fake.pools.get(poolId) ?? null);
    const writer = clearAfterSends(fake, cache);
    const cachedDeps: Deps = { ...deps, writer, redeemPools: cachePoolReads({ getPool: redeemReads }, cache) };
    const keyPair = KeyPair.fromRandom('ed25519');
    fake.setKey(BUYER, keyPair.getPublicKey().toString(), { nonce: 10n, fullAccess: true });
    fake.balances.set(BUYER, 1_000_000n);
    fake.setBuyer(POOL_ID, BUYER, { seats: 2, state: 'committed' });
    return { deps: cachedDeps, fake, keyPair, redeemReads, app: createApp(cachedDeps) };
  }

  /** A redemption with a new proof: each proof has a nonce of its own. */
  async function redeem(s: Awaited<ReturnType<typeof setup>>): Promise<{ status: number; body: { status?: string } }> {
    const recipient = new URL(s.deps.config.publicUrl).host;
    const header = await buildRedeemProofHeader({ keyPair: s.keyPair, accountId: BUYER, poolId: POOL_ID, recipient, nowMs: s.deps.now() });
    const res = await s.app.request(`/pools/${POOL_ID}/access`, { headers: { [PROOF_HEADER]: header } });
    return { status: res.status, body: (await res.json()) as { status?: string } };
  }

  it('answers redemptions within 2 seconds from one read of the pool, and reads it again at 2 seconds', async () => {
    const s = await setup();
    expect(await redeem(s)).toMatchObject({ status: 202, body: { status: 'pending' } });
    expect(await redeem(s)).toMatchObject({ status: 202, body: { status: 'pending' } });
    expect(s.redeemReads).toHaveBeenCalledOnce();
    s.fake.setPool(poolView({ id: POOL_ID, taken: 192, status: 'filled' }));
    clock = 1_000 + 1_999;
    expect(await redeem(s)).toMatchObject({ status: 202, body: { status: 'pending' } });
    clock = 1_000 + 2_000;
    expect(await redeem(s)).toMatchObject({ status: 200, body: { status: 'filled' } });
    expect(s.redeemReads).toHaveBeenCalledTimes(2);
    expect(getPoolReads(s.fake)).toBe(0);
  });

  it('reads the pool for every offer, outside the cache', async () => {
    const s = await setup();
    await redeem(s);
    expect((await s.app.request(`/pools/${POOL_ID}/access?seats=2`)).status).toBe(402);
    expect((await s.app.request(`/pools/${POOL_ID}/access?seats=2`)).status).toBe(402);
    expect(s.redeemReads).toHaveBeenCalledOnce();
    expect(getPoolReads(s.fake)).toBe(2);
  });

  it('checks a payment against a pool read outside the cache, and reads the pool again for the next redemption', async () => {
    const s = await setup();
    await redeem(s);
    // The relayed commit takes 2 seats.
    s.fake.onRelay = () => {
      s.fake.setPool(poolView({ id: POOL_ID, taken: 150 }));
      return {
        kind: 'executed',
        outcome: commitOutcome({ txHash: TX_HASH, buyer: BUYER, poolId: POOL_ID, seats: 2, seatPrice: 180n, taken: 150, target: 192 }),
      };
    };
    const header = await buildPaymentHeader({
      keyPair: s.keyPair,
      senderId: BUYER,
      nonce: 11n,
      maxBlockHeight: maxBlockHeightFor(s.fake.block.height, s.deps.config.maxTimeoutSeconds, s.deps.config.blockTimeMs),
      offer: buildOffer(poolView({ id: POOL_ID }), 2, offerContext(s.deps.config)),
      expected: { network: 'near:testnet', token: TOKEN, poolsContract: POOLS, poolId: POOL_ID, maxSeats: 2, maxAmount: 360n },
    });
    const paid = await s.app.request(`/pools/${POOL_ID}/access?seats=2`, { headers: { [PAYMENT_HEADER]: header } });
    expect(paid.status).toBe(202);
    expect(s.fake.relayed).toHaveLength(1);
    expect(getPoolReads(s.fake)).toBe(1);
    expect(s.redeemReads).toHaveBeenCalledOnce();
    expect(await redeem(s)).toMatchObject({ status: 202, body: { status: 'pending', taken: 150 } });
    expect(s.redeemReads).toHaveBeenCalledTimes(2);
  });
});
