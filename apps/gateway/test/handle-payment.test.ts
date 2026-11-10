import {
  PAYMENT_RESPONSE_HEADER,
  buildOffer,
  buildPaymentHeader,
  decodeHeader,
  encodeSignedDelegate,
  maxBlockHeightFor,
  type ExpectedOffer,
  type Offer,
  type PaymentPayload,
  type PoolView,
} from '@quorum-on-near/protocol';
import { createLocalJWKSet, jwtVerify } from 'jose';
import { KeyPair } from 'near-api-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DelegateExpiredError, type RelayResult } from '../src/chain.ts';
import type { GatewayConfig } from '../src/config.ts';
import { offerContext } from '../src/handle-offer.ts';
import { EXPIRY_MARGIN_BLOCKS } from '../src/chain.ts';
import { handlePayment } from '../src/handle-payment.ts';
import type { Reply } from '../src/reply.ts';
import {
  NOW_MS,
  POOLS,
  PROVIDER,
  TERMS,
  TOKEN,
  commitOutcome,
  eventLog,
  outcome,
  poolView,
  testConfig,
  type FakeChain,
} from './fake-chain.ts';
import { testDeps } from './handler-deps.ts';

const BUYER = 'buyer.testnet';
const POOL_ID = 7;
const KEY_NONCE = 10n;
const BALANCE = 1_000_000n;
const TX_HASH = 'RelayTx111';
const DEADLINE_MS = 1_800_000_000_000;
/**
 * The buyer's own configuration, the network and contracts it pays on, and its request: 2 seats of
 * pool 7, for at most 1000, more than any payment here (5 seats at 180 is 900).
 */
const BUYER_CONFIG: ExpectedOffer = {
  network: 'near:testnet',
  token: TOKEN,
  poolsContract: POOLS,
  poolId: POOL_ID,
  maxSeats: 2,
  maxAmount: 1_000n,
};

interface PaymentOptions {
  /** The seats the buyer asks for and its offer is made for; 2 by default. */
  seats?: number;
  nonce?: bigint;
  maxBlockHeight?: bigint;
  /** Changes to the pool as the buyer sees it, which its offer is built from. */
  pool?: Partial<PoolView>;
}

/**
 * A buyer with a full-access key (nonce 10) and a balance, and pool 7 on a FakeChain. `header` signs
 * a payment for the pool's offer as it is when called.
 */
async function scenario(opts: { pool?: Partial<PoolView>; buyer?: string; config?: Partial<GatewayConfig> } = {}) {
  const buyer = opts.buyer ?? BUYER;
  const deps = await testDeps({ config: testConfig(opts.config) });
  const { fake, config } = deps;
  fake.setPool(poolView({ id: POOL_ID, ...opts.pool }));
  const keyPair = KeyPair.fromRandom('ed25519');
  const publicKey = keyPair.getPublicKey().toString();
  fake.setKey(buyer, publicKey, { nonce: KEY_NONCE, fullAccess: true });
  fake.balances.set(buyer, BALANCE);

  const header = (p: PaymentOptions = {}): Promise<string> => {
    const seats = p.seats ?? 2;
    return buildPaymentHeader({
      keyPair,
      senderId: buyer,
      nonce: p.nonce ?? KEY_NONCE + 1n,
      maxBlockHeight: p.maxBlockHeight ?? maxBlockHeightFor(fake.block.height, config.maxTimeoutSeconds, config.blockTimeMs),
      offer: buildOffer({ ...currentPool(fake), ...p.pool }, seats, offerContext(config)),
      expected: { ...BUYER_CONFIG, maxSeats: seats },
    });
  };
  return { deps, fake, config, buyer, publicKey, header };
}

type Scenario = Awaited<ReturnType<typeof scenario>>;

function currentPool(fake: FakeChain): PoolView {
  const pool = fake.pools.get(POOL_ID);
  if (pool === undefined) throw new Error(`no pool ${POOL_ID}`);
  return pool;
}

/** Replaces pool 7 with `changes` applied. */
function updatePool(fake: FakeChain, changes: Partial<PoolView>): void {
  fake.setPool({ ...currentPool(fake), ...changes });
}

function offerFor(pool: PoolView, seats: number): Offer {
  return buildOffer(pool, seats, offerContext(testConfig()));
}

/** A relayed commit that took `seats` seats, leaving `taken` of the pool's 192 taken. */
function committed(seats: number, taken: number, buyer = BUYER): RelayResult {
  return {
    kind: 'executed',
    outcome: commitOutcome({ txHash: TX_HASH, buyer, poolId: POOL_ID, seats, seatPrice: 180n, taken, target: 192 }),
  };
}

const NO_SEATS = committed(0, 0);

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** A 402 for `code` carrying `accepts`, with nothing relayed. */
function expectRefused(s: Scenario, result: Reply, code: string, accepts: Offer[]): void {
  expect(result).toEqual({ status: 402, body: { x402Version: 1, error: code, accepts } });
  expect(s.fake.relayed).toEqual([]);
}

function paymentResponse(result: Reply): unknown {
  const header = result.headers?.[PAYMENT_RESPONSE_HEADER];
  if (header === undefined) throw new Error('no X-PAYMENT-RESPONSE header');
  return decodeHeader(header);
}

describe('handlePayment: requests it cannot check', () => {
  it('answers 400 invalid_seats for an invalid seats parameter, without reading the chain', async () => {
    const s = await scenario();
    const result = await handlePayment(s.deps, POOL_ID, '1001', await s.header());
    expect(result).toEqual({ status: 400, body: { error: 'invalid_seats' } });
    expect(s.fake.reads.size).toBe(0);
    expect(s.fake.relayed).toEqual([]);
  });

  it('answers 404 unknown_pool for a pool that does not exist', async () => {
    const s = await scenario();
    const result = await handlePayment(s.deps, 8, '2', await s.header());
    expect(result).toEqual({ status: 404, body: { error: 'unknown_pool' } });
    expect(s.fake.relayed).toEqual([]);
  });

  it("answers 404 unknown_pool for another seller's pool", async () => {
    const s = await scenario({ pool: { seller: `other.${PROVIDER}` } });
    const result = await handlePayment(s.deps, POOL_ID, '2', await s.header());
    expect(result).toEqual({ status: 404, body: { error: 'unknown_pool' } });
    expect(s.fake.relayed).toEqual([]);
  });
});

describe('handlePayment: static checks', () => {
  it('answers 402 wrong_amount with the current offer when the amount is not the price of the seats', async () => {
    const s = await scenario();
    // A buyer that has the seat price as 179 pays 358 for 2 seats; the pool's price is 180.
    const header = await s.header({ pool: { seat_price: '179' } });
    const result = await handlePayment(s.deps, POOL_ID, '2', header);
    expectRefused(s, result, 'wrong_amount', [offerFor(currentPool(s.fake), 2)]);
  });

  it('answers 402 wrong_pool when the payment is for more seats than the request asks for', async () => {
    const s = await scenario();
    const result = await handlePayment(s.deps, POOL_ID, '2', await s.header({ seats: 3 }));
    expectRefused(s, result, 'wrong_pool', [offerFor(currentPool(s.fake), 2)]);
  });

  it('answers 202 to a payment for a reduced offer made at the URL first requested', async () => {
    // Asked for 5 seats of a pool that allows 3 per buyer: the offer is for 3.
    const s = await scenario({ pool: { max_seats_per_buyer: 3 } });
    s.fake.relayResults.push(committed(3, 151));
    const result = await handlePayment(s.deps, POOL_ID, '5', await s.header({ seats: 3 }));
    expect(result).toMatchObject({ status: 202, body: { receipt: { seats: 3 }, pool: { taken: 151 } } });
    expect(s.fake.relayed).toHaveLength(1);
  });

  it('answers 402 invalid_payload for a header that does not decode', async () => {
    const s = await scenario();
    const result = await handlePayment(s.deps, POOL_ID, '2', 'not a payment');
    expectRefused(s, result, 'invalid_payload', [offerFor(currentPool(s.fake), 2)]);
  });

  it("does not read the buyer's key or take the in-flight slot for a payment that fails a static check", async () => {
    const s = await scenario();
    const begin = vi.spyOn(s.deps.inFlight, 'begin');
    await handlePayment(s.deps, POOL_ID, '2', 'not a payment');
    expect(begin).not.toHaveBeenCalled();
    expect(s.fake.reads.get('view_access_key')).toBeUndefined();
  });
});

describe('handlePayment: gateway checks', () => {
  it('answers 402 not_full_access when the signing key is not on the account', async () => {
    const s = await scenario();
    s.fake.keys.clear();
    const result = await handlePayment(s.deps, POOL_ID, '2', await s.header());
    expectRefused(s, result, 'not_full_access', [offerFor(currentPool(s.fake), 2)]);
  });

  it('answers 402 not_full_access when the signing key is a function-call key', async () => {
    const s = await scenario();
    s.fake.setKey(BUYER, s.publicKey, { nonce: KEY_NONCE, fullAccess: false });
    const result = await handlePayment(s.deps, POOL_ID, '2', await s.header());
    expectRefused(s, result, 'not_full_access', [offerFor(currentPool(s.fake), 2)]);
  });

  it("answers 402 stale_nonce when the nonce is not above the key's nonce", async () => {
    const s = await scenario();
    const result = await handlePayment(s.deps, POOL_ID, '2', await s.header({ nonce: KEY_NONCE }));
    expectRefused(s, result, 'stale_nonce', [offerFor(currentPool(s.fake), 2)]);
  });

  it('answers 402 nonce_too_large when the nonce is the final height times 10^6', async () => {
    const s = await scenario();
    const header = await s.header({ nonce: s.fake.block.height * 1_000_000n });
    const result = await handlePayment(s.deps, POOL_ID, '2', header);
    expectRefused(s, result, 'nonce_too_large', [offerFor(currentPool(s.fake), 2)]);
  });

  it('accepts a nonce just below the final height times 10^6', async () => {
    const s = await scenario();
    s.fake.relayResults.push(committed(2, 150));
    const header = await s.header({ nonce: s.fake.block.height * 1_000_000n - 1n });
    expect((await handlePayment(s.deps, POOL_ID, '2', header)).status).toBe(202);
  });

  it('answers 402 expired when max_block_height is the current final height', async () => {
    const s = await scenario();
    const result = await handlePayment(s.deps, POOL_ID, '2', await s.header({ maxBlockHeight: s.fake.block.height }));
    expectRefused(s, result, 'expired', [offerFor(currentPool(s.fake), 2)]);
  });

  it('answers 402 expired when max_block_height is below the current final height', async () => {
    const s = await scenario();
    const header = await s.header({ maxBlockHeight: s.fake.block.height - 1n });
    const result = await handlePayment(s.deps, POOL_ID, '2', header);
    expectRefused(s, result, 'expired', [offerFor(currentPool(s.fake), 2)]);
  });

  it('answers 402 expired when max_block_height is only 5 blocks past the final height', async () => {
    const s = await scenario();
    const header = await s.header({ maxBlockHeight: s.fake.block.height + 5n });
    const result = await handlePayment(s.deps, POOL_ID, '2', header);
    expectRefused(s, result, 'expired', [offerFor(currentPool(s.fake), 2)]);
  });

  it('accepts a max_block_height 6 blocks past the final height', async () => {
    const s = await scenario();
    s.fake.relayResults.push(committed(2, 150));
    const header = await s.header({ maxBlockHeight: s.fake.block.height + 6n });
    expect((await handlePayment(s.deps, POOL_ID, '2', header)).status).toBe(202);
    expect(s.fake.relayed).toHaveLength(1);
  });

  it('accepts a max_block_height up to 5 blocks past maxTimeoutSeconds of blocks ahead', async () => {
    // 120 s at 1000 ms a block: at most 120 + 5 blocks ahead.
    const s = await scenario();
    s.fake.relayResults.push(committed(2, 150));
    const header = await s.header({ maxBlockHeight: s.fake.block.height + 125n });
    expect((await handlePayment(s.deps, POOL_ID, '2', header)).status).toBe(202);
  });

  it('answers 402 expired when max_block_height is more than 5 blocks past maxTimeoutSeconds of blocks ahead', async () => {
    const s = await scenario();
    const header = await s.header({ maxBlockHeight: s.fake.block.height + 126n });
    const result = await handlePayment(s.deps, POOL_ID, '2', header);
    expectRefused(s, result, 'expired', [offerFor(currentPool(s.fake), 2)]);
  });

  it('rounds maxTimeoutSeconds of blocks up', async () => {
    // 120 s at 700 ms a block is 171.4 blocks: at most 172 + 5 ahead.
    const s = await scenario({ config: { blockTimeMs: 700 } });
    s.fake.relayResults.push(committed(2, 150));
    const header = await s.header({ maxBlockHeight: s.fake.block.height + 172n + EXPIRY_MARGIN_BLOCKS });
    expect((await handlePayment(s.deps, POOL_ID, '2', header)).status).toBe(202);
  });

  it('answers 402 pool_closed with no offer when the pool has filled', async () => {
    const s = await scenario({ pool: { status: 'filled', taken: 192 } });
    const result = await handlePayment(s.deps, POOL_ID, '2', await s.header());
    expectRefused(s, result, 'pool_closed', []);
  });

  it('answers 402 pool_closed with no offer when an open pool has no seat left', async () => {
    const s = await scenario({ pool: { taken: 192 } });
    const result = await handlePayment(s.deps, POOL_ID, '2', await s.header());
    expectRefused(s, result, 'pool_closed', []);
  });

  it("answers 402 pool_closed when the final block's time has reached the deadline", async () => {
    const s = await scenario();
    s.fake.block = { height: s.fake.block.height, timestampMs: DEADLINE_MS };
    const result = await handlePayment(s.deps, POOL_ID, '2', await s.header());
    expectRefused(s, result, 'pool_closed', [offerFor(currentPool(s.fake), 2)]);
  });

  it("answers 402 insufficient_balance when the buyer's balance is below the amount", async () => {
    const s = await scenario();
    s.fake.balances.set(BUYER, 359n);
    const result = await handlePayment(s.deps, POOL_ID, '2', await s.header());
    expectRefused(s, result, 'insufficient_balance', [offerFor(currentPool(s.fake), 2)]);
  });

  it('accepts a balance that exactly covers the amount', async () => {
    const s = await scenario();
    s.fake.balances.set(BUYER, 360n);
    s.fake.relayResults.push(committed(2, 150));
    expect((await handlePayment(s.deps, POOL_ID, '2', await s.header())).status).toBe(202);
  });

  it("answers 402 seller_commit when the payer is the pool's seller", async () => {
    const s = await scenario({ buyer: PROVIDER });
    const result = await handlePayment(s.deps, POOL_ID, '2', await s.header());
    expectRefused(s, result, 'seller_commit', [offerFor(currentPool(s.fake), 2)]);
  });

  it("answers 402 over_buyer_cap with an offer for the seats left under the pool's limit", async () => {
    const s = await scenario({ pool: { max_seats_per_buyer: 24 } });
    s.fake.setBuyer(POOL_ID, BUYER, { seats: 23, state: 'committed' });
    const result = await handlePayment(s.deps, POOL_ID, '2', await s.header());
    expectRefused(s, result, 'over_buyer_cap', [offerFor(currentPool(s.fake), 1)]);
  });

  it("answers 402 over_buyer_cap with no offer when the buyer already holds the pool's limit", async () => {
    const s = await scenario({ pool: { max_seats_per_buyer: 24 } });
    s.fake.setBuyer(POOL_ID, BUYER, { seats: 24, state: 'committed' });
    const result = await handlePayment(s.deps, POOL_ID, '2', await s.header());
    expectRefused(s, result, 'over_buyer_cap', []);
  });

  it("accepts a payment that brings the buyer's seats exactly to the pool's limit", async () => {
    const s = await scenario({ pool: { max_seats_per_buyer: 24 } });
    s.fake.setBuyer(POOL_ID, BUYER, { seats: 22, state: 'committed' });
    s.fake.relayResults.push(committed(2, 150));
    expect((await handlePayment(s.deps, POOL_ID, '2', await s.header())).status).toBe(202);
  });

  it('accepts any number of seats held when the pool has no limit per buyer', async () => {
    const s = await scenario({ pool: { max_seats_per_buyer: null } });
    s.fake.setBuyer(POOL_ID, BUYER, { seats: 140, state: 'committed' });
    s.fake.relayResults.push(committed(2, 150));
    expect((await handlePayment(s.deps, POOL_ID, '2', await s.header())).status).toBe(202);
  });

  it('answers 402 payment_in_flight while another payment from the same buyer is being relayed', async () => {
    const s = await scenario();
    const relaying = deferred<void>();
    const relayed = deferred<RelayResult>();
    s.fake.onRelay = () => {
      relaying.resolve();
      return relayed.promise;
    };
    const first = handlePayment(s.deps, POOL_ID, '2', await s.header());
    await relaying.promise;

    const second = await handlePayment(s.deps, POOL_ID, '2', await s.header({ nonce: KEY_NONCE + 2n }));
    expect(second).toEqual({
      status: 402,
      body: { x402Version: 1, error: 'payment_in_flight', accepts: [offerFor(currentPool(s.fake), 2)] },
    });
    expect(s.fake.relayed).toHaveLength(1);

    relayed.resolve(committed(2, 150));
    expect((await first).status).toBe(202);
  });

  it('accepts a payment from another buyer while one is being relayed', async () => {
    const s = await scenario();
    const other = 'other-buyer.testnet';
    const otherKey = KeyPair.fromRandom('ed25519');
    s.fake.setKey(other, otherKey.getPublicKey().toString(), { nonce: 0n, fullAccess: true });
    s.fake.balances.set(other, BALANCE);
    const relaying = deferred<void>();
    const relayed = deferred<RelayResult>();
    s.fake.onRelay = () => {
      relaying.resolve();
      return relayed.promise;
    };
    const first = handlePayment(s.deps, POOL_ID, '2', await s.header());
    await relaying.promise;

    s.fake.onRelay = undefined;
    s.fake.relayResults.push(committed(2, 152, other));
    const otherHeader = await buildPaymentHeader({
      keyPair: otherKey,
      senderId: other,
      nonce: 1n,
      maxBlockHeight: s.fake.block.height + 100n,
      offer: offerFor(currentPool(s.fake), 2),
      expected: BUYER_CONFIG,
    });
    expect((await handlePayment(s.deps, POOL_ID, '2', otherHeader)).status).toBe(202);

    relayed.resolve(committed(2, 150));
    expect((await first).status).toBe(202);
  });
});

describe('handlePayment: relay', () => {
  it('relays exactly the delegate the buyer signed, with its max_block_height', async () => {
    const s = await scenario();
    s.fake.relayResults.push(committed(2, 150));
    const maxBlockHeight = s.fake.block.height + 100n;
    const header = await s.header({ maxBlockHeight });
    await handlePayment(s.deps, POOL_ID, '2', header);
    const { payload } = decodeHeader(header) as PaymentPayload;
    expect(
      s.fake.relayed.map((r) => ({
        signedDelegate: Buffer.from(encodeSignedDelegate(r.signed)).toString('base64'),
        maxBlockHeight: r.maxBlockHeight,
      })),
    ).toEqual([{ signedDelegate: payload.signedDelegate, maxBlockHeight }]);
  });

  it('answers 402 expired with the current offer when the relayer finds the delegate too close to its expiry', async () => {
    const s = await scenario();
    s.fake.onRelay = () => {
      throw new DelegateExpiredError('the delegate expires at block 1100 and the final height is 1095');
    };
    const result = await handlePayment(s.deps, POOL_ID, '2', await s.header());
    expect(result).toEqual({
      status: 402,
      body: { x402Version: 1, error: 'expired', accepts: [offerFor(currentPool(s.fake), 2)] },
    });
  });
});

describe('handlePayment: responses', () => {
  it('answers 202 pending with the receipt and the pool after the commit, and an X-PAYMENT-RESPONSE header', async () => {
    const s = await scenario();
    s.fake.relayResults.push(committed(2, 150));
    const result = await handlePayment(s.deps, POOL_ID, '2', await s.header());
    expect(result).toEqual({
      status: 202,
      body: {
        status: 'pending',
        receipt: { poolId: POOL_ID, buyer: BUYER, seats: 2, txHash: TX_HASH },
        pool: { taken: 150, target: 192, deadlineMs: DEADLINE_MS },
      },
      headers: { [PAYMENT_RESPONSE_HEADER]: expect.any(String) },
    });
    expect(paymentResponse(result)).toEqual({ success: true, transaction: TX_HASH, network: 'near:testnet', payer: BUYER });
  });

  it('answers 200 filled with a credential for the seats held plus the seats taken when the commit fills the pool', async () => {
    const s = await scenario({ pool: { taken: 187 } });
    s.fake.setBuyer(POOL_ID, BUYER, { seats: 3, state: 'committed' });
    s.fake.relayResults.push(committed(5, 192));
    const result = await handlePayment(s.deps, POOL_ID, '5', await s.header({ seats: 5 }));
    expect(result).toEqual({
      status: 200,
      body: { status: 'filled', credential: expect.any(String), poolId: POOL_ID, seats: 8, terms: TERMS },
      headers: { [PAYMENT_RESPONSE_HEADER]: expect.any(String) },
    });
    expect(paymentResponse(result)).toEqual({ success: true, transaction: TX_HASH, network: 'near:testnet', payer: BUYER });

    const { credential } = result.body as { credential: string };
    const { payload } = await jwtVerify(credential, createLocalJWKSet(s.deps.credentials.jwks()), {
      issuer: s.config.publicUrl,
      subject: BUYER,
    });
    expect(payload).toMatchObject({ pool: POOL_ID, seats: 8, terms: TERMS, simulated: true });
  });

  it.each(['filled', 'settled'] as const)(
    'answers 409 no_seats_taken with no offer when the pool is %s after a commit that took no seats',
    async (status) => {
      const s = await scenario();
      s.fake.onRelay = () => {
        updatePool(s.fake, { status, taken: 192 });
        return NO_SEATS;
      };
      const result = await handlePayment(s.deps, POOL_ID, '2', await s.header());
      expect(result).toEqual({ status: 409, body: { x402Version: 1, error: 'no_seats_taken', accepts: [] } });
    },
  );

  it("answers 409, not 410, for a pool that filled, even once the final block's time is past its deadline", async () => {
    const s = await scenario();
    s.fake.onRelay = () => {
      updatePool(s.fake, { status: 'filled', taken: 192 });
      s.fake.block = { ...s.fake.block, timestampMs: DEADLINE_MS + 1 };
      return NO_SEATS;
    };
    const result = await handlePayment(s.deps, POOL_ID, '2', await s.header());
    expect(result).toEqual({ status: 409, body: { x402Version: 1, error: 'no_seats_taken', accepts: [] } });
  });

  // The contract takes min(seats, target - taken) seats of an open pool, so it took none for another
  // reason, such as the buyer's limit, and the same payment would be refused again.
  it.each([
    ['room for every seat paid for', 148],
    ['one seat left of the two paid for', 191],
  ])('answers 502 relay_failed when a commit took no seats while the pool was open with %s', async (_label, taken) => {
    const s = await scenario();
    s.fake.onRelay = () => {
      updatePool(s.fake, { taken });
      return NO_SEATS;
    };
    const result = await handlePayment(s.deps, POOL_ID, '2', await s.header());
    expect(result).toEqual({ status: 502, body: { error: 'relay_failed', txHash: TX_HASH } });
  });

  it("answers 410 pool_expired when the final block's time has reached the deadline of a pool the view still shows open", async () => {
    const s = await scenario();
    s.fake.onRelay = () => {
      s.fake.block = { ...s.fake.block, timestampMs: DEADLINE_MS };
      return NO_SEATS;
    };
    const result = await handlePayment(s.deps, POOL_ID, '2', await s.header());
    expect(result).toEqual({ status: 410, body: { error: 'pool_expired', poolId: POOL_ID, txHash: TX_HASH } });
  });

  it("judges the deadline by the final block's time, not the gateway's clock, after a commit that took no seats", async () => {
    const s = await scenario();
    s.deps.now = () => DEADLINE_MS + 60_000;
    s.fake.onRelay = () => {
      s.fake.block = { ...s.fake.block, timestampMs: DEADLINE_MS - 1 };
      return NO_SEATS;
    };
    const result = await handlePayment(s.deps, POOL_ID, '2', await s.header());
    expect(result).toEqual({ status: 502, body: { error: 'relay_failed', txHash: TX_HASH } });
  });

  it('answers 502 relay_failed when a commit took no seats because the transfer never reached the pools contract', async () => {
    // The pool filled meanwhile, which alone would answer 409.
    const s = await scenario();
    s.fake.onRelay = () => {
      updatePool(s.fake, { status: 'filled', taken: 192 });
      const refusedByToken = outcome(TX_HASH, [{ executorId: BUYER }, { executorId: TOKEN, failed: true }]);
      return { kind: 'executed', outcome: refusedByToken };
    };
    const result = await handlePayment(s.deps, POOL_ID, '2', await s.header());
    expect(result).toEqual({ status: 502, body: { error: 'relay_failed', txHash: TX_HASH } });
  });

  it.each(['expired', 'refunded'] as const)(
    'answers 410 pool_expired with the transaction hash when the pool is %s after a commit that took no seats',
    async (status) => {
      const s = await scenario();
      s.fake.onRelay = () => {
        updatePool(s.fake, { status });
        return NO_SEATS;
      };
      const result = await handlePayment(s.deps, POOL_ID, '2', await s.header());
      expect(result).toEqual({ status: 410, body: { error: 'pool_expired', poolId: POOL_ID, txHash: TX_HASH } });
    },
  );

  it('answers 502 relay_failed with the transaction hash when the RPC rejects the relay', async () => {
    const s = await scenario();
    s.fake.relayResults.push({ kind: 'rejected', txHash: TX_HASH, error: 'InvalidNonceError' });
    const result = await handlePayment(s.deps, POOL_ID, '2', await s.header());
    expect(result).toEqual({ status: 502, body: { error: 'relay_failed', txHash: TX_HASH } });
  });

  it('answers 502 relay_failed with the transaction hash when the delegate action fails', async () => {
    const s = await scenario();
    s.fake.relayResults.push({ kind: 'executed', outcome: outcome(TX_HASH, [{ executorId: BUYER, failed: true }]) });
    const result = await handlePayment(s.deps, POOL_ID, '2', await s.header());
    expect(result).toEqual({ status: 502, body: { error: 'relay_failed', txHash: TX_HASH } });
  });

  it('answers 502 result_unknown with the transaction hash when the result is not known in time', async () => {
    const s = await scenario();
    s.fake.relayResults.push({ kind: 'unknown', txHash: TX_HASH, expired: false });
    const result = await handlePayment(s.deps, POOL_ID, '2', await s.header());
    expect(result).toEqual({ status: 502, body: { error: 'result_unknown', txHash: TX_HASH } });
  });

  it('answers 502 result_unknown with the transaction hash when the outcome cannot be read', async () => {
    const s = await scenario();
    const malformed = eventLog({
      event: 'seats_committed',
      data: { pool_id: POOL_ID, buyer: BUYER, seats: 2, amount: '3.6e2', taken: 150, target: 192 },
    });
    s.fake.relayResults.push({
      kind: 'executed',
      outcome: outcome(TX_HASH, [{ executorId: BUYER }, { executorId: TOKEN }, { executorId: POOLS, logs: [malformed] }]),
    });
    const result = await handlePayment(s.deps, POOL_ID, '2', await s.header());
    expect(result).toEqual({ status: 502, body: { error: 'result_unknown', txHash: TX_HASH } });
  });

  it('answers 502 result_unknown with the transaction hash when the pool cannot be read again after a commit that took no seats', async () => {
    const s = await scenario();
    s.fake.onRelay = () => {
      vi.spyOn(s.fake, 'getPool').mockRejectedValue(new Error('connect ECONNREFUSED'));
      return NO_SEATS;
    };
    const result = await handlePayment(s.deps, POOL_ID, '2', await s.header());
    expect(result).toEqual({ status: 502, body: { error: 'result_unknown', txHash: TX_HASH } });
  });

  it('answers 502 result_unknown with the transaction hash when the final block cannot be read after a commit that took no seats', async () => {
    const s = await scenario();
    s.fake.onRelay = () => {
      vi.spyOn(s.fake, 'finalBlock').mockRejectedValue(new Error('connect ECONNREFUSED'));
      return NO_SEATS;
    };
    const result = await handlePayment(s.deps, POOL_ID, '2', await s.header());
    expect(result).toEqual({ status: 502, body: { error: 'result_unknown', txHash: TX_HASH } });
  });

  it.each(['getPool', 'accessKey', 'finalBlock', 'ftBalanceOf', 'getBuyer'] as const)(
    'answers 503 chain_unavailable, relaying nothing, when %s throws',
    async (method) => {
      const s = await scenario();
      vi.spyOn(s.fake, method).mockRejectedValue(new Error('connect ECONNREFUSED'));
      const result = await handlePayment(s.deps, POOL_ID, '2', await s.header());
      expect(result).toEqual({ status: 503, body: { error: 'chain_unavailable' } });
      expect(s.fake.relayed).toEqual([]);
    },
  );

  it('answers 503 chain_unavailable when relayDelegate throws before sending', async () => {
    const s = await scenario();
    s.fake.onRelay = () => {
      throw new Error('no relayer key was free within 30000 ms');
    };
    const result = await handlePayment(s.deps, POOL_ID, '2', await s.header());
    expect(result).toEqual({ status: 503, body: { error: 'chain_unavailable' } });
  });
});

describe('handlePayment: activity feed', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Makes every append fail and silences the log; returns the console.error spy. */
  function failAppends(s: Scenario) {
    vi.spyOn(s.deps.activity, 'append').mockRejectedValue(new Error('ENOSPC: no space left on device'));
    return vi.spyOn(console, 'error').mockImplementation(() => {});
  }

  it('records a commit that took seats, with its amount and transaction hash', async () => {
    const s = await scenario();
    s.fake.relayResults.push(committed(2, 150));
    await handlePayment(s.deps, POOL_ID, '2', await s.header());
    expect(s.deps.activity.list()).toEqual([
      { at: NOW_MS, poolId: POOL_ID, kind: 'commit', account: BUYER, seats: 2, amount: '360', txHash: TX_HASH, ok: true },
    ]);
  });

  it('records a commit that took no seats as not ok', async () => {
    const s = await scenario();
    s.fake.relayResults.push(NO_SEATS);
    await handlePayment(s.deps, POOL_ID, '2', await s.header());
    expect(s.deps.activity.list()).toEqual([
      { at: NOW_MS, poolId: POOL_ID, kind: 'commit', account: BUYER, seats: 0, amount: '0', txHash: TX_HASH, ok: false },
    ]);
  });

  it.each<[string, RelayResult]>([
    ['the relay is rejected', { kind: 'rejected', txHash: TX_HASH, error: 'InvalidNonceError' }],
    ['the result is unknown', { kind: 'unknown', txHash: TX_HASH, expired: false }],
    ['the delegate action fails', { kind: 'executed', outcome: outcome(TX_HASH, [{ executorId: BUYER, failed: true }]) }],
  ])('records nothing when %s', async (_, relayResult) => {
    const s = await scenario();
    s.fake.relayResults.push(relayResult);
    await handlePayment(s.deps, POOL_ID, '2', await s.header());
    expect(s.deps.activity.list()).toEqual([]);
  });

  it('still answers 202 pending when the record cannot be appended', async () => {
    const s = await scenario();
    failAppends(s);
    s.fake.relayResults.push(committed(2, 150));
    const result = await handlePayment(s.deps, POOL_ID, '2', await s.header());
    expect(result).toMatchObject({ status: 202, body: { status: 'pending' } });
  });

  it('still answers 200 filled when the record cannot be appended', async () => {
    const s = await scenario({ pool: { taken: 190 } });
    failAppends(s);
    s.fake.relayResults.push(committed(2, 192));
    const result = await handlePayment(s.deps, POOL_ID, '2', await s.header());
    expect(result).toMatchObject({ status: 200, body: { status: 'filled', seats: 2 } });
  });

  it('logs a record it cannot append', async () => {
    const s = await scenario();
    const logged = failAppends(s);
    s.fake.relayResults.push(committed(2, 150));
    await handlePayment(s.deps, POOL_ID, '2', await s.header());
    expect(logged).toHaveBeenCalledOnce();
  });
});

describe('handlePayment: in-flight slot', () => {
  const cases: Array<[string, (s: Scenario) => void]> = [
    ['the commit takes seats', (s) => s.fake.relayResults.push(committed(2, 150))],
    ['the commit takes no seats', (s) => s.fake.relayResults.push(NO_SEATS)],
    ['the relay is rejected', (s) => s.fake.relayResults.push({ kind: 'rejected', txHash: TX_HASH, error: 'x' })],
    [
      'the result is unknown and the delegate has expired',
      (s) => s.fake.relayResults.push({ kind: 'unknown', txHash: TX_HASH, expired: true }),
    ],
    ['a gateway check fails', (s) => s.fake.balances.set(BUYER, 0n)],
    ['a chain read throws', (s) => vi.spyOn(s.fake, 'ftBalanceOf').mockRejectedValue(new Error('rpc down'))],
    [
      'relayDelegate throws',
      (s) => {
        s.fake.onRelay = () => {
          throw new Error('no relayer key was free');
        };
      },
    ],
    [
      'the outcome cannot be read',
      (s) => {
        const malformed = eventLog({
          event: 'seats_committed',
          data: { pool_id: POOL_ID, buyer: BUYER, seats: 2, amount: 'x', taken: 150, target: 192 },
        });
        s.fake.relayResults.push({ kind: 'executed', outcome: outcome(TX_HASH, [{ executorId: POOLS, logs: [malformed] }]) });
      },
    ],
  ];

  it.each(cases)('is released when %s', async (_, arrange) => {
    const s = await scenario();
    arrange(s);
    const begin = vi.spyOn(s.deps.inFlight, 'begin');
    await handlePayment(s.deps, POOL_ID, '2', await s.header());
    expect(begin).toHaveBeenCalledWith(BUYER);
    expect(begin).toHaveReturnedWith(true);
    expect(s.deps.inFlight.has(BUYER)).toBe(false);
  });
});

describe('handlePayment: a payment whose result is unknown', () => {
  /** The 402 a payment gets while another from the same buyer is in flight. */
  function inFlightReply(s: Scenario): Reply {
    const accepts = [offerFor(currentPool(s.fake), 2)];
    return { status: 402, body: { x402Version: 1, error: 'payment_in_flight', accepts } };
  }

  /** Relays a payment whose delegate expires at block 1100 and whose result is unknown. */
  async function relayUnknown(s: Scenario, expired: boolean): Promise<void> {
    s.fake.relayResults.push({ kind: 'unknown', txHash: TX_HASH, expired });
    const result = await handlePayment(s.deps, POOL_ID, '2', await s.header({ maxBlockHeight: 1_100n }));
    expect(result).toEqual({ status: 502, body: { error: 'result_unknown', txHash: TX_HASH } });
  }

  it('keeps the buyer in flight when the delegate may still land, so its next payment is refused', async () => {
    const s = await scenario();
    await relayUnknown(s, false);
    const next = await handlePayment(s.deps, POOL_ID, '2', await s.header({ nonce: KEY_NONCE + 2n }));
    expect(next).toEqual(inFlightReply(s));
    expect(s.fake.relayed).toHaveLength(1);
  });

  it("frees the buyer once a final block above the delegate's max_block_height is seen, not at it", async () => {
    const s = await scenario();
    await relayUnknown(s, false);
    s.fake.block = { ...s.fake.block, height: 1_100n };
    const atHeight = await handlePayment(s.deps, POOL_ID, '2', await s.header({ nonce: KEY_NONCE + 2n }));
    expect(atHeight).toEqual(inFlightReply(s));

    s.fake.block = { ...s.fake.block, height: 1_101n };
    s.fake.relayResults.push(committed(2, 150));
    expect((await handlePayment(s.deps, POOL_ID, '2', await s.header({ nonce: KEY_NONCE + 2n }))).status).toBe(202);
    expect(s.fake.relayed).toHaveLength(2);
  });

  it('frees the buyer at once when the delegate can no longer execute', async () => {
    const s = await scenario();
    await relayUnknown(s, true);
    s.fake.relayResults.push(committed(2, 150));
    expect((await handlePayment(s.deps, POOL_ID, '2', await s.header({ nonce: KEY_NONCE + 2n }))).status).toBe(202);
  });

  it('answers 503 chain_unavailable, relaying nothing, when the final block cannot be read for a held buyer', async () => {
    const s = await scenario();
    await relayUnknown(s, false);
    vi.spyOn(s.fake, 'finalBlock').mockRejectedValue(new Error('connect ECONNREFUSED'));
    const next = await handlePayment(s.deps, POOL_ID, '2', await s.header({ nonce: KEY_NONCE + 2n }));
    expect(next).toEqual({ status: 503, body: { error: 'chain_unavailable' } });
    expect(s.fake.relayed).toHaveLength(1);
    expect(s.deps.inFlight.held(BUYER)).toBe(true);
  });

  it('does not block another buyer while one is held', async () => {
    const s = await scenario();
    s.deps.inFlight.hold('other-buyer.testnet', 1_100n);
    s.fake.relayResults.push(committed(2, 150));
    expect((await handlePayment(s.deps, POOL_ID, '2', await s.header())).status).toBe(202);
    expect(s.deps.inFlight.held('other-buyer.testnet')).toBe(true);
  });

  it("lifts another buyer's hold once a payment's final block is above that delegate's max_block_height", async () => {
    const s = await scenario();
    s.deps.inFlight.hold('other-buyer.testnet', 999n);
    s.fake.relayResults.push(committed(2, 150));
    await handlePayment(s.deps, POOL_ID, '2', await s.header());
    expect(s.deps.inFlight.has('other-buyer.testnet')).toBe(false);
  });
});
