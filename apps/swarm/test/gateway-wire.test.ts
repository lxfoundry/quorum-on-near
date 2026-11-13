// The gateway's real HTTP app, read back through the buyer package's GatewayClient with no network
// between them: every status, code and field a buyer relies on is what the gateway actually writes.
// The client's own tests answer from hand-built bodies, and the gateway's from its own handlers, so
// a reply field renamed or retyped on one side only would pass both. It fails here instead. The
// swarm itself never imports another app; like gateway-agreement.test.ts, this test does.
import { GatewayClient } from '@quorum-on-near/buyer';
import { buildOffer, buildPaymentHeader, buildRedeemProofHeader, maxBlockHeightFor } from '@quorum-on-near/protocol';
import { KeyPair } from 'near-api-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../gateway/src/app.ts';
import { offerContext } from '../../gateway/src/handle-offer.ts';
import {
  NOW_MS,
  POOLS,
  PROVIDER,
  RELAYER,
  TERMS,
  TOKEN,
  commitOutcome,
  poolView,
  testConfig,
  type FakeChain,
} from '../../gateway/test/fake-chain.ts';
import { testDeps } from '../../gateway/test/handler-deps.ts';

const BUYER = 'buyer.testnet';
const POOL_ID = 7;
/** Transaction hashes in NEAR's form, 44 base58 characters, which the client requires of every one it reads. */
const TX_HASH = '9uKpXhTeoSbRrEq2bX3NkPhVwYQJz5CtD1LmAaFgHs4W';
const REFUND_TX = '4cVfQ7dNwXe8RkGz2sTpJmHb5yUaLnC3oEiDrWxAqS9t';
const SETTLE_TX = '7bYtMnPz3QwHfKcR6sXeVdJa2GuLoNx9iTrEgBqAhC5D';
const DUST_TX = 'Bq8WmZtN4xKfHsRc2dYvPe6JgLuA3oTiEn5XhCrDw9Sz';
const DEADLINE_MS = 1_800_000_000_000;
const KEY_NONCE = 10n;

afterEach(() => {
  vi.restoreAllMocks();
});

/** A gateway over a FakeChain that holds pool 7 and a buyer with a full-access key, and a client of it. */
async function world() {
  const deps = await testDeps();
  const { fake, config } = deps;
  fake.setPool(poolView({ id: POOL_ID }));
  const keyPair = KeyPair.fromRandom('ed25519');
  fake.setKey(BUYER, keyPair.getPublicKey().toString(), { nonce: KEY_NONCE, fullAccess: true });
  fake.balances.set(BUYER, 1_000_000n);
  const app = createApp(deps);
  const client = new GatewayClient({
    gatewayUrl: config.publicUrl,
    fetch: async (input, init) => app.request(input, init),
  });

  /** The buyer's payment for `seats` seats of pool 7 as it stands. */
  const payment = (seats = 2, nonce = KEY_NONCE + 1n): Promise<string> =>
    buildPaymentHeader({
      keyPair,
      senderId: BUYER,
      nonce,
      maxBlockHeight: maxBlockHeightFor(fake.block.height, config.maxTimeoutSeconds, config.blockTimeMs),
      offer: buildOffer(poolOf(fake), seats, offerContext(config)),
      expected: { network: 'near:testnet', token: TOKEN, poolsContract: POOLS, poolId: POOL_ID, maxSeats: seats, maxAmount: 1_000n },
    });
  /** A redemption proof of the buyer for pool 7; a new one each time. */
  const proof = (key = keyPair): Promise<string> =>
    buildRedeemProofHeader({
      keyPair: key,
      accountId: BUYER,
      poolId: POOL_ID,
      recipient: new URL(config.publicUrl).host,
      nowMs: NOW_MS,
    });
  return { deps, fake, client, payment, proof };
}

type World = Awaited<ReturnType<typeof world>>;

function poolOf(fake: FakeChain) {
  const pool = fake.pools.get(POOL_ID);
  if (pool === undefined) throw new Error(`no pool ${POOL_ID}`);
  return pool;
}

/** The chain cannot be read: the gateway logs it and answers 503. */
function breakReads(fake: FakeChain): void {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  fake.getPool = async () => {
    throw new Error('rpc down');
  };
  fake.getBuyer = async () => {
    throw new Error('rpc down');
  };
  fake.listPools = async () => {
    throw new Error('rpc down');
  };
}

/** A relayed commit of 2 seats at 180 each, which leaves `taken` of the pool's 192 taken. */
function relayCommit(fake: FakeChain, seats: number, taken: number): void {
  fake.relayResults.push({
    kind: 'executed',
    outcome: commitOutcome({ txHash: TX_HASH, buyer: BUYER, poolId: POOL_ID, seats, seatPrice: 180n, taken, target: 192 }),
  });
}

describe('GET /pools', () => {
  it('lists an open pool with its amounts as bigints', async () => {
    const { client } = await world();
    expect(await client.pools()).toEqual({
      kind: 'pools',
      pools: [
        {
          id: POOL_ID,
          terms: TERMS,
          seat_price: 180n,
          target: 192,
          taken: 148,
          deadline_ms: DEADLINE_MS,
          bonus: 1728n,
          min_bonus_per_seat: 9n,
        },
      ],
    });
  });

  it('is unavailable when the chain cannot be read', async () => {
    const { client, fake } = await world();
    breakReads(fake);
    expect(await client.pools()).toEqual({ kind: 'unavailable' });
  });
});

describe('the offer', () => {
  it('is the 402 body: one offer for the seats asked, with the pool as the gateway reads it', async () => {
    const { client } = await world();
    const answer = await client.offer(POOL_ID, 2);
    expect(answer).toEqual({
      kind: 'offer',
      offer: expect.objectContaining({
        scheme: 'quorum',
        network: 'near:testnet',
        asset: TOKEN,
        payTo: POOLS,
        maxAmountRequired: '360',
        extra: expect.objectContaining({
          poolId: POOL_ID,
          seats: 2,
          seatPrice: '180',
          target: 192,
          taken: 148,
          deadlineMs: DEADLINE_MS,
          bonus: '1728',
          minBonusPerSeat: '9',
          terms: TERMS,
          relayer: RELAYER,
        }),
      }),
    });
  });

  it('answers 404 for a pool the gateway does not serve', async () => {
    const { client, fake } = await world();
    fake.setPool(poolView({ id: 8, seller: 'someone-else.testnet' }));
    expect(await client.offer(8, 1)).toEqual({ kind: 'unknown_pool' });
    expect(await client.offer(9, 1)).toEqual({ kind: 'unknown_pool' });
  });

  it('answers 409 with the status of a pool that is filled, and of an open one with no seat left', async () => {
    const { client, fake } = await world();
    fake.setPool(poolView({ id: POOL_ID, status: 'filled', taken: 192 }));
    expect(await client.offer(POOL_ID, 1)).toEqual({ kind: 'pool_closed', status: 'filled' });
    fake.setPool(poolView({ id: POOL_ID, status: 'open', taken: 192 }));
    expect(await client.offer(POOL_ID, 1)).toEqual({ kind: 'pool_closed', status: 'open' });
  });

  it('answers 410 with the status of an expired pool', async () => {
    const { client, fake } = await world();
    fake.setPool(poolView({ id: POOL_ID, status: 'expired' }));
    expect(await client.offer(POOL_ID, 1)).toEqual({ kind: 'pool_expired', status: 'expired' });
    fake.setPool(poolView({ id: POOL_ID, status: 'refunded' }));
    expect(await client.offer(POOL_ID, 1)).toEqual({ kind: 'pool_expired', status: 'refunded' });
  });

  it('is unavailable when the chain cannot be read', async () => {
    const { client, fake } = await world();
    breakReads(fake);
    expect(await client.offer(POOL_ID, 2)).toEqual({ kind: 'unavailable' });
  });
});

describe('a payment', () => {
  it('answers 202 with the receipt and the pool as the relayed commit left them', async () => {
    const { client, fake, payment } = await world();
    relayCommit(fake, 2, 150);
    expect(await client.pay(POOL_ID, 2, await payment())).toEqual({
      kind: 'pending',
      txHash: TX_HASH,
      poolId: POOL_ID,
      buyer: BUYER,
      seats: 2,
      taken: 150,
      target: 192,
      deadlineMs: DEADLINE_MS,
    });
  });

  it('answers 200 with a credential when the commit filled the pool', async () => {
    const { client, fake, payment } = await world();
    relayCommit(fake, 2, 192);
    expect(await client.pay(POOL_ID, 2, await payment())).toEqual({
      kind: 'filled',
      txHash: TX_HASH,
      credential: expect.any(String),
      poolId: POOL_ID,
      seats: 2,
      terms: TERMS,
    });
  });

  it('answers 402 with the code of the failed check and the offer as it stands', async () => {
    const { client, payment } = await world();
    expect(await client.pay(POOL_ID, 2, await payment(2, KEY_NONCE))).toEqual({
      kind: 'refused',
      error: 'stale_nonce',
      offer: expect.objectContaining({ scheme: 'quorum', payTo: POOLS, maxAmountRequired: '360' }),
    });
  });

  it('answers 402 with no offer when the buyer may take no more seats', async () => {
    const { client, fake, payment } = await world();
    fake.setBuyer(POOL_ID, BUYER, { seats: 24, state: 'committed' });
    expect(await client.pay(POOL_ID, 2, await payment())).toEqual({ kind: 'refused', error: 'over_buyer_cap', offer: null });
  });

  it('answers 409 when the pool filled before the payment landed', async () => {
    const { client, fake, payment } = await world();
    fake.onRelay = () => {
      fake.setPool(poolView({ id: POOL_ID, status: 'filled', taken: 192 }));
      return { kind: 'executed', outcome: commitOutcome({ txHash: TX_HASH, buyer: BUYER, poolId: POOL_ID, seats: 0, seatPrice: 180n, taken: 0, target: 192 }) };
    };
    expect(await client.pay(POOL_ID, 2, await payment())).toEqual({ kind: 'no_seats_taken' });
  });

  it('answers 410 with the transaction when the pool expired before the payment landed', async () => {
    const { client, fake, payment } = await world();
    fake.onRelay = () => {
      fake.setPool(poolView({ id: POOL_ID, status: 'expired' }));
      return { kind: 'executed', outcome: commitOutcome({ txHash: TX_HASH, buyer: BUYER, poolId: POOL_ID, seats: 0, seatPrice: 180n, taken: 0, target: 192 }) };
    };
    expect(await client.pay(POOL_ID, 2, await payment())).toEqual({ kind: 'pool_expired', txHash: TX_HASH });
  });

  it('answers 502 relay_failed with the transaction when the relay was refused', async () => {
    const { client, fake, payment } = await world();
    fake.relayResults.push({ kind: 'rejected', txHash: TX_HASH, error: 'the RPC refused it' });
    expect(await client.pay(POOL_ID, 2, await payment())).toEqual({ kind: 'relay_failed', txHash: TX_HASH });
  });

  it('answers 502 result_unknown with the transaction when the relay has no outcome', async () => {
    const { client, fake, payment } = await world();
    fake.relayResults.push({ kind: 'unknown', txHash: TX_HASH, expired: false });
    expect(await client.pay(POOL_ID, 2, await payment())).toEqual({ kind: 'result_unknown', txHash: TX_HASH });
  });

  it('answers 404 for a pool the gateway does not serve', async () => {
    const { client, payment } = await world();
    expect(await client.pay(9, 2, await payment())).toEqual({ kind: 'unknown_pool' });
  });

  it('is unavailable when the chain cannot be read, with nothing relayed', async () => {
    const { client, fake, payment } = await world();
    const header = await payment();
    breakReads(fake);
    expect(await client.pay(POOL_ID, 2, header)).toEqual({ kind: 'unavailable' });
    expect(fake.relayed).toEqual([]);
  });
});

describe('a redemption', () => {
  /** The buyer holds 2 seats of pool 7, in `state`, and the pool has `changes`. */
  function holding(w: World, changes: Parameters<typeof poolView>[0] = {}, state: 'committed' | 'refunded' | 'claimable' = 'committed'): void {
    w.fake.setPool(poolView({ id: POOL_ID, ...changes }));
    w.fake.setBuyer(POOL_ID, BUYER, { seats: 2, state });
  }

  it('answers 202 with the seats held while the pool is open', async () => {
    const w = await world();
    holding(w);
    expect(await w.client.redeem(POOL_ID, await w.proof())).toEqual({
      kind: 'pending',
      seats: 2,
      taken: 148,
      target: 192,
      deadlineMs: DEADLINE_MS,
    });
  });

  it('answers 200 with a credential once the pool is filled', async () => {
    const w = await world();
    holding(w, { status: 'filled', taken: 192 });
    expect(await w.client.redeem(POOL_ID, await w.proof())).toEqual({
      kind: 'filled',
      credential: expect.any(String),
      poolId: POOL_ID,
      seats: 2,
      terms: TERMS,
    });
  });

  it.each([
    { state: 'committed', status: 'refund_pending' },
    { state: 'claimable', status: 'claimable' },
  ] as const)('answers 410 with the refund of a $state buyer of an expired pool, and no transaction yet', async ({ state, status }) => {
    const w = await world();
    holding(w, { status: 'expired', bonus_per_seat: '4' }, state);
    expect(await w.client.redeem(POOL_ID, await w.proof())).toEqual({
      kind: 'refund',
      status,
      amount: 368n,
      bonusShare: 8n,
      txHash: null,
    });
  });

  it('answers 410 with the keeper transaction of a refund already sent', async () => {
    const w = await world();
    holding(w, { status: 'refunded', bonus_per_seat: '4' }, 'refunded');
    await w.deps.activity.append({
      at: NOW_MS,
      poolId: POOL_ID,
      kind: 'refund',
      account: BUYER,
      seats: 2,
      amount: '368',
      txHash: REFUND_TX,
      ok: true,
    });
    expect(await w.client.redeem(POOL_ID, await w.proof())).toEqual({
      kind: 'refund',
      status: 'refunded',
      amount: 368n,
      bonusShare: 8n,
      txHash: REFUND_TX,
    });
  });

  it('answers 404 for an account that holds no seats', async () => {
    const w = await world();
    expect(await w.client.redeem(POOL_ID, await w.proof())).toEqual({ kind: 'no_seats' });
  });

  it('answers 401 not_full_access for a key the account does not hold', async () => {
    const w = await world();
    holding(w);
    const stranger = KeyPair.fromRandom('ed25519');
    expect(await w.client.redeem(POOL_ID, await w.proof(stranger))).toEqual({ kind: 'invalid_proof', error: 'not_full_access' });
  });

  it('answers 401 replayed_proof for a proof sent twice', async () => {
    const w = await world();
    holding(w);
    const proof = await w.proof();
    expect((await w.client.redeem(POOL_ID, proof)).kind).toBe('pending');
    expect(await w.client.redeem(POOL_ID, proof)).toEqual({ kind: 'invalid_proof', error: 'replayed_proof' });
  });

  it('answers 404 for a pool the gateway does not serve', async () => {
    const w = await world();
    expect(await w.client.redeem(9, await w.proof())).toEqual({ kind: 'unknown_pool' });
  });

  it('is unavailable when the chain cannot be read', async () => {
    const w = await world();
    const proof = await w.proof();
    breakReads(w.fake);
    expect(await w.client.redeem(POOL_ID, proof)).toEqual({ kind: 'unavailable' });
  });
});

describe('GET /activity', () => {
  it('lists a pool\'s records of every kind, oldest first, with the amounts as bigints', async () => {
    const { client, deps } = await world();
    const record = (kind: 'commit' | 'settle' | 'refund' | 'dust', amount: string, txHash: string, poolId = POOL_ID) => ({
      at: NOW_MS,
      poolId,
      kind,
      account: kind === 'settle' || kind === 'dust' ? PROVIDER : BUYER,
      seats: kind === 'commit' || kind === 'refund' ? 2 : 0,
      amount,
      txHash,
      ok: true,
    });
    await deps.activity.append(record('commit', '360', TX_HASH));
    await deps.activity.append(record('commit', '90', TX_HASH, 8));
    await deps.activity.append(record('settle', '34560', SETTLE_TX));
    await deps.activity.append(record('refund', '368', REFUND_TX));
    await deps.activity.append(record('dust', '4', DUST_TX));
    expect(await client.activity(POOL_ID)).toEqual([
      { at: NOW_MS, poolId: POOL_ID, kind: 'commit', account: BUYER, seats: 2, amount: 360n, txHash: TX_HASH, ok: true },
      { at: NOW_MS, poolId: POOL_ID, kind: 'settle', account: PROVIDER, seats: 0, amount: 34_560n, txHash: SETTLE_TX, ok: true },
      { at: NOW_MS, poolId: POOL_ID, kind: 'refund', account: BUYER, seats: 2, amount: 368n, txHash: REFUND_TX, ok: true },
      { at: NOW_MS, poolId: POOL_ID, kind: 'dust', account: PROVIDER, seats: 0, amount: 4n, txHash: DUST_TX, ok: true },
    ]);
  });

  it('is empty for a pool with no records', async () => {
    const { client } = await world();
    expect(await client.activity(POOL_ID)).toEqual([]);
  });
});
