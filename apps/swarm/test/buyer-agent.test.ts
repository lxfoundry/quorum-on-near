import {
  AccessKeyNotFoundError,
  Buyer,
  GatewayResponseError,
  type BuyerChainReads,
  type OfferAnswer,
  type PaymentAnswer,
  type PoolListing,
  type PoolsAnswer,
  type RedeemAnswer,
} from '@quorum-on-near/buyer';
import {
  buildOffer,
  checkPaymentHeader,
  minBonusPerSeat,
  offerSeats,
  type ExpectedPayment,
  type Offer,
  type OfferContext,
  type PaymentErrorCode,
  type PoolView,
} from '@quorum-on-near/protocol';
import { KeyPair } from 'near-api-js';
import { describe, expect, it } from 'vitest';
import { runBuyer, type BuyerOutcome, type PoolFacts } from '../src/buyer-agent.ts';
import type { BuyerProfile } from '../src/profiles.ts';
import { NOW_MS, PARENT, POOLS, poolView, testConfig, TOKEN } from './fake-chain.ts';

const ACCOUNT = `buyer-03.${PARENT}`;
const PROFILE: BuyerProfile = { name: 'buyer-03', seats: 18, topPrice: 400n };
const POOL = poolView();
const DEADLINE_MS = POOL.deadline_ms;
/** POOL as the pools contract holds it. */
const CHAIN_POOL: PoolFacts = { deadlineMs: DEADLINE_MS, seatPrice: 180n };
const TX = 'GqzWbLhRRyJk3TrHbBo3ApuWVQSxZvJ9YeCMfcQt5o4d';
const RELAY_TX = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
const REFUND_TX = '4kL7KEoNh5eNEKUyxJpWHNtUJJkTV2NiT8F8wgg8BM9R';
const CREDENTIAL = 'eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJidXllciJ9.c2lnbmF0dXJl';
/** An RPC URL that carries an API key, as library messages quote it. */
const KEYED_URL = 'https://rpc.example.org/v1?apiKey=SECRET';
/** The final height at NOW_MS; it goes up by one each second of the virtual clock (blocks of 1 s). */
const START_HEIGHT = 5_000n;
const OFFER_CONTEXT: OfferContext = {
  network: 'near:testnet',
  gatewayUrl: 'http://localhost:8402',
  poolsContract: POOLS,
  token: TOKEN,
  relayer: `relay.${PARENT}`,
  minGas: 50_000_000_000_000n,
  maxGas: 100_000_000_000_000n,
  maxTimeoutSeconds: 120,
};
/** What the gateway checks a payment for PROFILE's seats of POOL against. */
const EXPECTED_PAYMENT: ExpectedPayment = {
  network: 'near:testnet',
  token: TOKEN,
  poolsContract: POOLS,
  poolId: 0,
  maxSeats: 18,
  seatPrice: 180n,
  minGas: OFFER_CONTEXT.minGas,
  maxGas: OFFER_CONTEXT.maxGas,
};

/** `GET /pools` listing POOL with `overrides` applied, and the pools `others` makes of POOL after it. */
function listed(overrides: Partial<PoolView> = {}, ...others: Array<Partial<PoolView>>): PoolsAnswer {
  return { kind: 'pools', pools: [overrides, ...others].map((changes) => listing(poolView(changes))) };
}

/** A pool's row in `GET /pools`. */
function listing(pool: PoolView): PoolListing {
  return {
    id: pool.id,
    terms: pool.terms,
    seat_price: BigInt(pool.seat_price),
    target: pool.target,
    taken: pool.taken,
    deadline_ms: pool.deadline_ms,
    bonus: BigInt(pool.bonus),
    min_bonus_per_seat: minBonusPerSeat(BigInt(pool.bonus), pool.target),
  };
}

/** The gateway's offer for `seats` seats of the pool `overrides` makes of POOL. */
function offered(seats: number, overrides: Partial<PoolView> = {}): OfferAnswer {
  const pool = poolView(overrides);
  return { kind: 'offer', offer: buildOffer(pool, offerSeats(pool, seats), OFFER_CONTEXT) };
}

/** The 202 answer to a payment that took `seats` seats of pool `poolId`. */
function pending(seats: number, poolId = 0, deadlineMs = DEADLINE_MS): PaymentAnswer {
  return { kind: 'pending', txHash: TX, poolId, buyer: ACCOUNT, seats, taken: 100, target: 192, deadlineMs };
}

function refused(error: PaymentErrorCode): PaymentAnswer {
  return { kind: 'refused', error, offer: null };
}

/** The answer to a redemption by an account that holds no seats. */
const NO_SEATS: RedeemAnswer = { kind: 'no_seats' };
const WAITING: RedeemAnswer = { kind: 'pending', seats: 18, taken: 120, target: 192, deadlineMs: DEADLINE_MS };
const FILLED: RedeemAnswer = { kind: 'filled', credential: CREDENTIAL, poolId: 0, seats: 18, terms: POOL.terms };
const UNAVAILABLE = { kind: 'unavailable' } as const;
const RESULT_UNKNOWN: PaymentAnswer = { kind: 'result_unknown', txHash: TX };
const RELAY_FAILED: PaymentAnswer = { kind: 'relay_failed', txHash: RELAY_TX };

function refund(status: 'refunded' | 'refund_pending' | 'claimable', txHash: string | null = null): RedeemAnswer {
  return { kind: 'refund', status, amount: 6_300n, bonusShare: 540n, txHash };
}

/** The gateway's answers, in order, for each kind of request. An Error is thrown instead of answered. */
interface Script {
  pools?: Array<PoolsAnswer | Error>;
  offers?: Array<OfferAnswer | Error>;
  payments?: Array<PaymentAnswer | Error>;
  redemptions?: Array<RedeemAnswer | Error>;
}

interface Options {
  profile?: BuyerProfile;
  /** The values random() returns, in order; 0 once they run out. */
  randoms?: number[];
  spreadMs?: number;
  redeemIntervalMs?: number;
  /** The pool the buyer is sent to; 0 by default. */
  poolId?: number;
  /** The pool as the chain holds it; CHAIN_POOL by default. */
  pool?: PoolFacts;
  /** The errors the key's nonce reads reject with, in order, before they answer. */
  nonceErrors?: Error[];
  /** The final height at a time of the virtual clock; it may throw. START_HEIGHT plus a block a second by default. */
  finalHeight?: (nowMs: number) => bigint;
}

/** The final height of the default chain at `nowMs`. */
function heightAt(nowMs: number): bigint {
  return START_HEIGHT + BigInt(Math.floor((nowMs - NOW_MS) / 1000));
}

/**
 * A scripted buyer for PROFILE (its account ACCOUNT, a fresh key) over a gateway that answers from
 * `script`, a chain whose next nonce goes up by one at each read and whose final height goes up by
 * one each second, and a virtual clock that starts at NOW_MS and moves only when the agent sleeps.
 * `events` records every sleep and request in order; `payments` the X-PAYMENT headers sent; `lines`
 * what the agent logged.
 */
function agent(script: Script = {}, options: Options = {}) {
  const { profile = PROFILE, randoms = [], spreadMs = 120_000, redeemIntervalMs = 5_000, poolId = 0, pool = CHAIN_POOL } = options;
  const nonceErrors = [...(options.nonceErrors ?? [])];
  const finalHeight = options.finalHeight ?? heightAt;
  const events: string[] = [];
  const payments: string[] = [];
  const lines: string[] = [];
  const queues = { pools: [listed()], offers: [offered(profile.seats)], payments: [], redemptions: [], ...script };
  const next = <T>(queue: Array<T | Error>, request: string): T => {
    events.push(request);
    const answer = queue.shift();
    if (answer === undefined) throw new Error(`unscripted request: ${request}`);
    if (answer instanceof Error) throw answer;
    return answer;
  };
  let now = NOW_MS;
  let nonce = 1_000n;
  const chain: BuyerChainReads = {
    nextNonce: async () => {
      const error = nonceErrors.shift();
      if (error !== undefined) throw error;
      return (nonce += 1n);
    },
    finalHeight: async () => finalHeight(now),
  };
  const gateway = {
    pools: async () => next(queues.pools, 'pools'),
    offer: async (poolId: number, seats: number) => next(queues.offers, `offer ${poolId} ${seats}`),
    pay: async (poolId: number, seats: number, header: string) => {
      payments.push(header);
      return next(queues.payments, `pay ${poolId} ${seats}`);
    },
    redeem: async (poolId: number) => next(queues.redemptions, `redeem ${poolId}`),
  };
  const buyer = new Buyer({
    settings: testConfig(),
    accountId: `${profile.name}.${PARENT}`,
    keyPair: KeyPair.fromRandom('ed25519'),
    gateway,
    chain,
    now: () => now,
  });
  const runtime = {
    now: () => now,
    sleep: async (ms: number) => {
      events.push(`sleep ${ms}`);
      now += ms;
    },
    random: () => randoms.shift() ?? 0,
  };
  const run = (): Promise<BuyerOutcome> =>
    runBuyer(profile, { buyer, gateway, poolId, pool, spreadMs, redeemIntervalMs, runtime, log: (line) => lines.push(line) });
  return { run, events, payments, lines, now: () => now, buyer };
}

/** The outcome of ACCOUNT with nothing paid, as `kind` with `detail`. */
function nothingPaid(kind: BuyerOutcome['kind'], detail: string, txHashes: string[] = []): BuyerOutcome {
  return { buyer: ACCOUNT, kind, seats: 0, paid: 0n, detail, txHashes };
}

/** The nonce each X-PAYMENT header was signed with, as the gateway reads it. */
function nonces(payments: readonly string[]): Array<bigint | null> {
  return payments.map((header) => {
    const checked = checkPaymentHeader(header, EXPECTED_PAYMENT);
    return checked.ok ? checked.payment.nonce : null;
  });
}

function paysIn(events: readonly string[]): string[] {
  return events.filter((event) => event.startsWith('pay'));
}

describe('runBuyer: arrival and rule', () => {
  it('arrives after random() × the spread, then lists the pools', async () => {
    const { run, events } = agent({ payments: [pending(18)], redemptions: [NO_SEATS, FILLED] }, { randoms: [0.25] });
    await run();
    expect(events.slice(0, 2)).toEqual(['sleep 30000', 'pools']);
  });

  it('declines a pool whose seat price is above its top price, without asking for an offer', async () => {
    const { run, events } = agent({ pools: [listed({ seat_price: '320' })] }, { profile: { ...PROFILE, topPrice: 250n } });
    expect(await run()).toEqual(nothingPaid('declined', 'seat price 320 above top price 250'));
    expect(events).toEqual(['sleep 0', 'pools']);
  });

  it('commits to a pool whose seat price is its top price', async () => {
    const { run, events } = agent(
      {
        pools: [listed({ seat_price: '250' })],
        offers: [offered(18, { seat_price: '250' })],
        payments: [pending(18)],
        redemptions: [NO_SEATS, FILLED],
      },
      { profile: { ...PROFILE, topPrice: 250n } },
    );
    expect((await run()).kind).toBe('credential');
    expect(events).toContain('pay 0 18');
  });

  it('applies its rule to the seat price of its own pool in the list', async () => {
    const { run, events } = agent(
      {
        pools: [listed({ id: 1, seat_price: '320' }, { id: 0, seat_price: '180' })],
        payments: [pending(18)],
        redemptions: [NO_SEATS, FILLED],
      },
      { profile: { ...PROFILE, topPrice: 250n } },
    );
    expect((await run()).kind).toBe('credential');
    expect(events).toContain('pay 0 18');
  });

  it('acts on the pool it is sent to', async () => {
    const { run, events } = agent(
      { pools: [listed({ id: 7 })], offers: [offered(18, { id: 7 })], payments: [pending(18, 7)], redemptions: [NO_SEATS, FILLED] },
      { poolId: 7 },
    );
    expect((await run()).kind).toBe('credential');
    expect(events.slice(2)).toEqual(['redeem 7', 'offer 7 18', 'pay 7 18', 'sleep 5000', 'redeem 7']);
  });

  it('asks for an offer when the pool is not listed, and has missed it when the gateway says it is closed', async () => {
    const { run, events } = agent({
      pools: [{ kind: 'pools', pools: [] }],
      offers: [{ kind: 'pool_closed', status: 'filled' }],
      redemptions: [NO_SEATS],
    });
    expect(await run()).toEqual(nothingPaid('missed', 'no seat left (pool filled)'));
    expect(events).toEqual(['sleep 0', 'pools', 'redeem 0', 'offer 0 18']);
  });

  it('has missed an unlisted pool that the gateway says expired', async () => {
    const { run } = agent({
      pools: [{ kind: 'pools', pools: [] }],
      offers: [{ kind: 'pool_expired', status: 'refunded' }],
      redemptions: [NO_SEATS],
    });
    expect(await run()).toEqual(nothingPaid('expired', 'pool refunded'));
  });

  it('retries the list when the gateway cannot read the chain, three times at most', async () => {
    const { run, events } = agent({ pools: [UNAVAILABLE, UNAVAILABLE, UNAVAILABLE] });
    expect(await run()).toEqual(nothingPaid('failed', 'gateway unavailable'));
    expect(events).toEqual(['sleep 0', 'pools', 'sleep 2000', 'pools', 'sleep 4000', 'pools']);
  });

  it('asks for the list again when the request fails, then goes on', async () => {
    const { run, events } = agent({
      pools: [new TypeError('fetch failed'), listed()],
      payments: [pending(18)],
      redemptions: [NO_SEATS, FILLED],
    });
    expect((await run()).kind).toBe('credential');
    expect(events.slice(0, 5)).toEqual(['sleep 0', 'pools', 'sleep 2000', 'pools', 'redeem 0']);
  });

  it('ends failed, without throwing, when every request for the list fails', async () => {
    const refusedConnection = new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
    const { run, lines } = agent({ pools: [refusedConnection, new TypeError('fetch failed'), refusedConnection] });
    expect(await run()).toEqual(nothingPaid('failed', 'gateway unreachable (ECONNREFUSED)'));
    expect(lines).toContain('buyer-03  gateway unreachable (error), tries again in 4 s');
  });
});

describe('runBuyer: what it holds already', () => {
  it('redeems once before it pays, and pays when it holds no seats', async () => {
    const { run, events } = agent({ payments: [pending(18)], redemptions: [NO_SEATS, FILLED] });
    await run();
    expect(events.slice(0, 5)).toEqual(['sleep 0', 'pools', 'redeem 0', 'offer 0 18', 'pay 0 18']);
  });

  it('follows the seats it already holds to its credential, never asking for an offer or paying', async () => {
    const { run, events, lines } = agent({ redemptions: [{ ...WAITING, seats: 12 }, { ...FILLED, seats: 12 }] });
    expect(await run()).toEqual({ buyer: ACCOUNT, kind: 'credential', seats: 12, paid: 2_160n, detail: 'pool filled', txHashes: [] });
    expect(events).toEqual(['sleep 0', 'pools', 'redeem 0', 'sleep 5000', 'redeem 0']);
    expect(lines).toContain('buyer-03  holds 12 seats already: follows its redemption');
  });

  it('ends with its credential at once when the pool it holds seats in has filled', async () => {
    const { run, events } = agent({ redemptions: [FILLED] });
    expect(await run()).toMatchObject({ kind: 'credential', seats: 18, paid: 3_240n });
    expect(events).toEqual(['sleep 0', 'pools', 'redeem 0']);
  });

  it('follows a refund it already has, holding the seats the refund is for, at the price on chain', async () => {
    // 18 seats at 180 are 3,240, plus a bonus of 9 a seat.
    const held: RedeemAnswer = { kind: 'refund', status: 'refunded', amount: 3_402n, bonusShare: 162n, txHash: REFUND_TX };
    const { run, payments } = agent({ pools: [{ kind: 'pools', pools: [] }], redemptions: [held] });
    expect(await run()).toEqual({
      buyer: ACCOUNT,
      kind: 'refunded',
      seats: 18,
      paid: 3_240n,
      detail: '3402 back, bonus 162',
      txHashes: [REFUND_TX],
    });
    expect(payments).toEqual([]);
  });

  it('asks again when the gateway cannot answer, and ends failed, paying nothing, when it never learns what it holds', async () => {
    const { run, events } = agent({ redemptions: [UNAVAILABLE, new TypeError('fetch failed'), UNAVAILABLE] });
    expect(await run()).toEqual(nothingPaid('failed', 'could not learn whether it holds seats; nothing paid'));
    expect(events).toEqual(['sleep 0', 'pools', 'redeem 0', 'sleep 2000', 'redeem 0', 'sleep 4000', 'redeem 0']);
  });

  it('pays once the gateway answers that it holds no seats', async () => {
    const { run, events } = agent({ payments: [pending(18)], redemptions: [UNAVAILABLE, NO_SEATS, FILLED] });
    expect((await run()).kind).toBe('credential');
    expect(paysIn(events)).toEqual(['pay 0 18']);
  });

  it('ends failed before paying when its proof is refused', async () => {
    const { run, events } = agent({ redemptions: [{ kind: 'invalid_proof', error: 'wrong_recipient' }] });
    expect(await run()).toEqual(nothingPaid('failed', 'proof refused: wrong_recipient'));
    expect(events).toEqual(['sleep 0', 'pools', 'redeem 0']);
  });

  it('ends failed before paying when the gateway does not serve the pool', async () => {
    const { run } = agent({ redemptions: [{ kind: 'unknown_pool' }] });
    expect(await run()).toEqual(nothingPaid('failed', 'the gateway does not serve pool 0'));
  });

  it('redeems again before every new payment', async () => {
    const { run, events } = agent({
      offers: [offered(18), offered(18)],
      payments: [UNAVAILABLE, pending(18)],
      redemptions: [NO_SEATS, NO_SEATS, FILLED],
    });
    expect((await run()).kind).toBe('credential');
    expect(events).toEqual([
      'sleep 0',
      'pools',
      'redeem 0',
      'offer 0 18',
      'pay 0 18',
      'sleep 2000',
      'redeem 0',
      'offer 0 18',
      'pay 0 18',
      'sleep 5000',
      'redeem 0',
    ]);
  });

  it('pays no more once the redemption before a new payment finds that it holds seats', async () => {
    const { run, events } = agent({ payments: [UNAVAILABLE], redemptions: [NO_SEATS, WAITING, FILLED] });
    expect(await run()).toMatchObject({ kind: 'credential', seats: 18 });
    expect(paysIn(events)).toEqual(['pay 0 18']);
  });
});

describe('runBuyer: the offer', () => {
  it('pays the offer for its seats once, at the offered price, with its own key and the next nonce', async () => {
    const { run, events, payments } = agent({ payments: [pending(18)], redemptions: [NO_SEATS, FILLED] });
    await run();
    expect(events.slice(0, 5)).toEqual(['sleep 0', 'pools', 'redeem 0', 'offer 0 18', 'pay 0 18']);
    const checked = checkPaymentHeader(payments[0] ?? '', EXPECTED_PAYMENT);
    expect(checked.ok && checked.payment).toMatchObject({ senderId: ACCOUNT, seats: 18, amount: 3_240n, nonce: 1_001n });
  });

  it('pays a reduced offer for the seats that are left', async () => {
    const { run, payments } = agent({ offers: [offered(18, { taken: 184 })], payments: [pending(8)], redemptions: [NO_SEATS, FILLED] });
    await run();
    const checked = checkPaymentHeader(payments[0] ?? '', EXPECTED_PAYMENT);
    expect(checked.ok && [checked.payment.seats, checked.payment.amount]).toEqual([8, 1_440n]);
  });

  it('declines an offer whose seat price is above its top price, even for fewer seats, and signs nothing', async () => {
    // 8 seats at 500 cost 4,000, under 18 seats at the top price of 400: the budget is the offered seats'.
    const { run, payments } = agent({ offers: [offered(18, { taken: 184, seat_price: '500' })], redemptions: [NO_SEATS] });
    expect(await run()).toEqual(nothingPaid('declined', 'offer refused: over_budget'));
    expect(payments).toEqual([]);
  });

  it('declines an offer that its own check refuses, and signs nothing', async () => {
    const answer = offered(18) as { kind: 'offer'; offer: Offer };
    const { run, payments } = agent({
      offers: [{ kind: 'offer', offer: { ...answer.offer, payTo: `escrow.${PARENT}` } }],
      redemptions: [NO_SEATS],
    });
    expect(await run()).toEqual(nothingPaid('declined', 'offer refused: wrong_pay_to'));
    expect(payments).toEqual([]);
  });

  it.each([
    [{ kind: 'pool_closed', status: 'filled' }, 'missed', 'no seat left (pool filled)'],
    [{ kind: 'pool_closed', status: 'settled' }, 'missed', 'no seat left (pool settled)'],
    [{ kind: 'pool_expired', status: 'expired' }, 'expired', 'pool expired'],
    [{ kind: 'unknown_pool' }, 'failed', 'the gateway does not serve pool 0'],
  ] as const)('answered %j, ends %s', async (answer, kind, detail) => {
    const { run } = agent({ offers: [answer], redemptions: [NO_SEATS] });
    expect(await run()).toEqual(nothingPaid(kind, detail));
  });

  it('asks again when the gateway cannot read the chain, three times at most', async () => {
    const { run, events } = agent({ offers: [UNAVAILABLE, UNAVAILABLE, UNAVAILABLE], redemptions: [NO_SEATS, NO_SEATS, NO_SEATS] });
    expect(await run()).toEqual(nothingPaid('failed', 'gateway unavailable'));
    expect(events.filter((event) => !event.startsWith('redeem'))).toEqual([
      'sleep 0',
      'pools',
      'offer 0 18',
      'sleep 2000',
      'offer 0 18',
      'sleep 4000',
      'offer 0 18',
    ]);
  });

  it('asks again when the request for the offer fails, or its answer is not a documented one', async () => {
    const undocumented = new GatewayResponseError('offer', '/pools/0/access?seats=18', 500, 'status 500 is not one this request is answered with');
    const { run, events, lines } = agent({
      offers: [undocumented, new TypeError('fetch failed'), offered(18)],
      payments: [pending(18)],
      redemptions: [NO_SEATS, NO_SEATS, NO_SEATS, FILLED],
    });
    expect((await run()).kind).toBe('credential');
    expect(paysIn(events)).toEqual(['pay 0 18']);
    expect(lines).toContain('buyer-03  undocumented answer from the gateway (HTTP 500), tries again in 2 s');
    expect(lines).toContain('buyer-03  gateway unreachable (error), tries again in 4 s');
  });
});

describe('runBuyer: a payment that was never sent', () => {
  it('pays again, with a new payment, when its chain read failed before anything was sent', async () => {
    // near-api-js gives an RPC's HTTP status as the cause of an error whose message quotes the URL.
    const rpcDown = new Error(`${KEYED_URL} answered 502 Bad Gateway`, { cause: 502 });
    const { run, events, payments, lines } = agent(
      { offers: [offered(18), offered(18)], payments: [pending(18)], redemptions: [NO_SEATS, NO_SEATS, FILLED] },
      { nonceErrors: [rpcDown] },
    );
    expect((await run()).kind).toBe('credential');
    expect(events.slice(2, 8)).toEqual(['redeem 0', 'offer 0 18', 'sleep 2000', 'redeem 0', 'offer 0 18', 'pay 0 18']);
    expect(payments).toHaveLength(1);
    expect(lines).toContain(`buyer-03  could not read the nonce of ${ACCOUNT}'s key from the RPC (HTTP 502): nothing was sent, tries again in 2 s`);
    expect(lines.join('\n')).not.toContain('SECRET');
    expect(lines.join('\n')).not.toContain('rpc.example.org');
  });

  it('ends failed after three attempts whose payment was never sent, with the reason and no redemption after them', async () => {
    const rpcDown = new Error('rate limited', { cause: 429 });
    const { run, events, payments } = agent(
      { offers: [offered(18), offered(18), offered(18)], redemptions: [NO_SEATS, NO_SEATS, NO_SEATS] },
      { nonceErrors: [rpcDown, rpcDown, rpcDown] },
    );
    expect(await run()).toEqual(nothingPaid('failed', `could not read the nonce of ${ACCOUNT}'s key from the RPC (HTTP 429): nothing was sent`));
    expect(payments).toEqual([]);
    expect(events.at(-1)).toBe('offer 0 18');
  });

  it('ends failed at once, paying nothing, when its key is not on its account', async () => {
    const publicKey = 'ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp';
    const { run, events, payments } = agent({ redemptions: [NO_SEATS] }, { nonceErrors: [new AccessKeyNotFoundError(ACCOUNT, publicKey)] });
    expect(await run()).toEqual(nothingPaid('failed', `${ACCOUNT} has no access key ${publicKey}: nothing was sent`));
    expect(payments).toEqual([]);
    expect(events).toEqual(['sleep 0', 'pools', 'redeem 0', 'offer 0 18']);
  });

  it('pays again when it could not connect to the gateway, which therefore got nothing', async () => {
    const refusedConnection = new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
    const { run, events } = agent({
      offers: [offered(18), offered(18)],
      payments: [refusedConnection, pending(18)],
      redemptions: [NO_SEATS, NO_SEATS, FILLED],
    });
    expect((await run()).kind).toBe('credential');
    expect(events.slice(4, 9)).toEqual(['pay 0 18', 'sleep 2000', 'redeem 0', 'offer 0 18', 'pay 0 18']);
  });
});

describe('runBuyer: a payment whose result is unknown', () => {
  // The payment is signed at height 5,000 to expire at 5,120 (120 s of 1 s blocks), so a redemption
  // read after a final block above 5,140 settles it. With a poll every 50 s, the third is at 5,150.
  const SETTLE_POLL_MS = 50_000;

  it('after a payment that got no answer, signs nothing until a final block past its expiry plus the margin, then pays again', async () => {
    const { run, events, payments, lines } = agent(
      {
        offers: [offered(18), offered(18)],
        payments: [new TypeError('fetch failed'), pending(18)],
        redemptions: [NO_SEATS, NO_SEATS, NO_SEATS, NO_SEATS, NO_SEATS, FILLED],
      },
      { redeemIntervalMs: SETTLE_POLL_MS },
    );
    expect(await run()).toMatchObject({ kind: 'credential', seats: 18 });
    expect(events).toEqual([
      'sleep 0',
      'pools',
      'redeem 0',
      'offer 0 18',
      'pay 0 18',
      'sleep 50000',
      'redeem 0',
      'sleep 50000',
      'redeem 0',
      'sleep 50000',
      'redeem 0',
      'redeem 0',
      'offer 0 18',
      'pay 0 18',
      'sleep 50000',
      'redeem 0',
    ]);
    expect(nonces(payments)).toEqual([1_001n, 1_002n]);
    expect(lines).toContain('buyer-03  no answer to the payment (error): learns by redemption whether it lands by block 5140');
    expect(lines).toContain('buyer-03  the payment did not land by block 5140, tries again');
  });

  it('follows the seats that a payment which got no answer took, paying once', async () => {
    const { run, events } = agent({ payments: [new TypeError('fetch failed')], redemptions: [NO_SEATS, NO_SEATS, WAITING, FILLED] });
    expect(await run()).toEqual({ buyer: ACCOUNT, kind: 'credential', seats: 18, paid: 3_240n, detail: 'pool filled', txHashes: [] });
    expect(paysIn(events)).toEqual(['pay 0 18']);
  });

  it('keeps redeeming while the final height cannot be read, and gives up 5 minutes after the deadline', async () => {
    const unreadable = (nowMs: number): bigint => {
      if (nowMs > NOW_MS) throw new Error(`${KEYED_URL} unreachable`);
      return START_HEIGHT;
    };
    const { run, events, lines } = agent(
      { payments: [new TypeError('fetch failed')], redemptions: Array(9).fill(NO_SEATS) },
      { redeemIntervalMs: 100_000, finalHeight: unreadable },
    );
    expect(await run()).toEqual(nothingPaid('timed_out', 'no final answer 5 min after the deadline'));
    expect(paysIn(events)).toEqual(['pay 0 18']);
    expect(lines.filter((line) => line.includes('could not read the final block'))).toEqual(['buyer-03  could not read the final block (error)']);
    expect(lines.join('\n')).not.toContain('SECRET');
  });

  it('settles a 502 result_unknown the same way, and pays again once it did not land', async () => {
    const { run, events } = agent(
      {
        offers: [offered(18), offered(18)],
        payments: [RESULT_UNKNOWN, pending(18)],
        redemptions: [NO_SEATS, NO_SEATS, NO_SEATS, NO_SEATS, NO_SEATS, FILLED],
      },
      { redeemIntervalMs: SETTLE_POLL_MS },
    );
    expect(await run()).toMatchObject({ kind: 'credential', txHashes: [TX, TX] });
    expect(paysIn(events)).toEqual(['pay 0 18', 'pay 0 18']);
  });

  it('follows the seats a 502 result_unknown took, never paying again', async () => {
    const { run, events } = agent({ payments: [RESULT_UNKNOWN], redemptions: [NO_SEATS, WAITING, FILLED] });
    expect(await run()).toEqual({ buyer: ACCOUNT, kind: 'credential', seats: 18, paid: 3_240n, detail: 'pool filled', txHashes: [TX] });
    expect(paysIn(events)).toEqual(['pay 0 18']);
  });

  it('learns its seats from the credential after a result_unknown', async () => {
    const { run } = agent({ payments: [RESULT_UNKNOWN], redemptions: [NO_SEATS, { ...FILLED, seats: 12 }] });
    expect(await run()).toMatchObject({ kind: 'credential', seats: 12, paid: 2_160n });
  });

  it('learns its seats from a pending redemption after a result_unknown', async () => {
    const { run } = agent({ payments: [RESULT_UNKNOWN], redemptions: [NO_SEATS, ...Array(8).fill({ ...WAITING, seats: 12 })] }, { redeemIntervalMs: 100_000 });
    expect(await run()).toMatchObject({ kind: 'timed_out', seats: 12, paid: 2_160n });
  });

  it('ends failed when none of its payments whose result is unknown landed, naming each transaction', async () => {
    // Each payment is signed at the final height of its attempt: 5,000, 5,150 and 5,300.
    const { run, payments } = agent(
      { offers: [offered(18), offered(18), offered(18)], payments: [RESULT_UNKNOWN, RESULT_UNKNOWN, RESULT_UNKNOWN], redemptions: Array(12).fill(NO_SEATS) },
      { redeemIntervalMs: SETTLE_POLL_MS },
    );
    expect(await run()).toEqual(nothingPaid('failed', 'the payment did not land by block 5440', [TX, TX, TX]));
    expect(payments).toHaveLength(3);
  });

  it.each<PaymentErrorCode>(['payment_in_flight', 'stale_nonce'])(
    'after a 402 %s, signs nothing until an earlier payment of its account can no longer land, then pays again',
    async (code) => {
      const { run, events, payments, lines } = agent(
        {
          offers: [offered(18), offered(18)],
          payments: [refused(code), pending(18)],
          redemptions: [NO_SEATS, NO_SEATS, NO_SEATS, NO_SEATS, NO_SEATS, FILLED],
        },
        { redeemIntervalMs: SETTLE_POLL_MS },
      );
      expect((await run()).kind).toBe('credential');
      expect(events.slice(4, 14)).toEqual([
        'pay 0 18',
        'sleep 50000',
        'redeem 0',
        'sleep 50000',
        'redeem 0',
        'sleep 50000',
        'redeem 0',
        'redeem 0',
        'offer 0 18',
        'pay 0 18',
      ]);
      expect(nonces(payments)).toEqual([1_001n, 1_002n]);
      expect(lines).toContain(`buyer-03  payment refused: ${code}: learns by redemption whether an earlier payment lands by block 5140`);
    },
  );

  it('after a 402 payment_in_flight, follows the seats the earlier payment took, paying once', async () => {
    const { run, events } = agent({ payments: [refused('payment_in_flight')], redemptions: [NO_SEATS, WAITING, FILLED] });
    expect(await run()).toMatchObject({ kind: 'credential', seats: 18, paid: 3_240n });
    expect(paysIn(events)).toEqual(['pay 0 18']);
  });
});

describe('runBuyer: the payment', () => {
  it('redeems after a 202 until the pool fills, and holds a credential', async () => {
    const { run, events } = agent({ payments: [pending(18)], redemptions: [NO_SEATS, WAITING, FILLED] });
    expect(await run()).toEqual({ buyer: ACCOUNT, kind: 'credential', seats: 18, paid: 3_240n, detail: 'pool filled', txHashes: [TX] });
    expect(events.slice(4)).toEqual(['pay 0 18', 'sleep 5000', 'redeem 0', 'sleep 5000', 'redeem 0']);
  });

  it('holds a credential at once when its payment filled the pool (200)', async () => {
    const filled: PaymentAnswer = { kind: 'filled', txHash: TX, credential: CREDENTIAL, poolId: 0, seats: 18, terms: POOL.terms };
    const { run, events } = agent({ payments: [filled], redemptions: [NO_SEATS] });
    expect(await run()).toEqual({
      buyer: ACCOUNT,
      kind: 'credential',
      seats: 18,
      paid: 3_240n,
      detail: 'its payment filled the pool',
      txHashes: [TX],
    });
    expect(events.at(-1)).toBe('pay 0 18');
  });

  it.each<PaymentErrorCode>(['expired', 'nonce_too_large'])('after a 402 %s, pays again after a short backoff, with a new payment', async (code) => {
    const { run, events, payments } = agent({
      offers: [offered(18), offered(18)],
      payments: [refused(code), pending(18)],
      redemptions: [NO_SEATS, NO_SEATS, FILLED],
    });
    expect((await run()).kind).toBe('credential');
    expect(events.slice(3, 9)).toEqual(['offer 0 18', 'pay 0 18', 'sleep 2000', 'redeem 0', 'offer 0 18', 'pay 0 18']);
    expect(nonces(payments)).toEqual([1_001n, 1_002n]);
  });

  it('is refused with the code after three attempts that each get a transient 402', async () => {
    const { run, events } = agent({
      offers: [offered(18), offered(18), offered(18)],
      payments: [refused('expired'), refused('nonce_too_large'), refused('expired')],
      redemptions: [NO_SEATS, NO_SEATS, NO_SEATS],
    });
    expect(await run()).toEqual(nothingPaid('refused', 'payment refused: expired'));
    expect(events.filter((event) => event.startsWith('pay') || event.startsWith('sleep'))).toEqual([
      'sleep 0',
      'pay 0 18',
      'sleep 2000',
      'pay 0 18',
      'sleep 4000',
      'pay 0 18',
    ]);
  });

  it.each<PaymentErrorCode>([
    'over_buyer_cap',
    'insufficient_balance',
    'seller_commit',
    'not_full_access',
    'invalid_payload',
    'invalid_signature',
    'wrong_receiver',
    'wrong_method',
    'wrong_deposit',
    'gas_too_low',
    'gas_too_high',
    'wrong_args',
    'wrong_amount',
    'wrong_pool',
  ])('is refused, with one payment only, after a 402 %s', async (code) => {
    const { run, payments } = agent({ payments: [refused(code)], redemptions: [NO_SEATS] });
    expect(await run()).toEqual(nothingPaid('refused', `payment refused: ${code}`));
    expect(payments).toHaveLength(1);
  });

  it('after a 402 pool_closed, asks for the offer once more, at once, and has missed the pool when it is full', async () => {
    const { run, events, lines } = agent({
      offers: [offered(18), { kind: 'pool_closed', status: 'filled' }],
      payments: [refused('pool_closed')],
      redemptions: [NO_SEATS],
    });
    expect(await run()).toEqual(nothingPaid('missed', 'no seat left (pool filled)'));
    expect(events.slice(4)).toEqual(['pay 0 18', 'offer 0 18']);
    expect(lines).toContain('buyer-03  payment refused: pool_closed: asks for the offer again');
  });

  it('after a 402 pool_closed, ends expired when the pool is past its deadline', async () => {
    const { run } = agent({
      offers: [offered(18), { kind: 'pool_expired', status: 'expired' }],
      payments: [refused('pool_closed')],
      redemptions: [NO_SEATS],
    });
    expect(await run()).toEqual(nothingPaid('expired', 'pool expired'));
  });

  it('after a 402 pool_closed, pays again when the gateway offers seats again', async () => {
    const { run, events } = agent({
      offers: [offered(18), offered(18), offered(18)],
      payments: [refused('pool_closed'), pending(18)],
      redemptions: [NO_SEATS, NO_SEATS, FILLED],
    });
    expect((await run()).kind).toBe('credential');
    expect(events.slice(4, 10)).toEqual(['pay 0 18', 'offer 0 18', 'sleep 2000', 'redeem 0', 'offer 0 18', 'pay 0 18']);
  });

  it('is refused for pool_closed when the gateway still offers seats on its last attempt', async () => {
    const { run, payments } = agent({
      offers: [offered(18), offered(18), offered(18), offered(18), offered(18), offered(18)],
      payments: [refused('pool_closed'), refused('pool_closed'), refused('pool_closed')],
      redemptions: [NO_SEATS, NO_SEATS, NO_SEATS],
    });
    expect(await run()).toEqual(nothingPaid('refused', 'payment refused: pool_closed'));
    expect(payments).toHaveLength(3);
  });

  it('pays again, with a new payment, after a 503', async () => {
    const { run, events, payments } = agent({
      offers: [offered(18), offered(18)],
      payments: [UNAVAILABLE, pending(18)],
      redemptions: [NO_SEATS, NO_SEATS, FILLED],
    });
    expect((await run()).kind).toBe('credential');
    expect(events.slice(4, 8)).toEqual(['pay 0 18', 'sleep 2000', 'redeem 0', 'offer 0 18']);
    expect(new Set(payments).size).toBe(2);
  });

  it('has missed the pool when its payment took no seats (409)', async () => {
    const { run } = agent({ payments: [{ kind: 'no_seats_taken' }], redemptions: [NO_SEATS] });
    expect(await run()).toEqual(nothingPaid('missed', 'no seats taken: the pool filled first'));
  });

  it('ends expired when the pool expired before its payment landed (410)', async () => {
    const { run } = agent({ payments: [{ kind: 'pool_expired', txHash: TX }], redemptions: [NO_SEATS] });
    expect(await run()).toEqual(nothingPaid('expired', 'pool expired before the payment landed', [TX]));
  });

  it('pays again, with a new payment, after a 502 relay_failed, which took nothing', async () => {
    const { run, events, lines } = agent({
      offers: [offered(18), offered(18)],
      payments: [RELAY_FAILED, pending(18)],
      redemptions: [NO_SEATS, NO_SEATS, FILLED],
    });
    expect(await run()).toMatchObject({ kind: 'credential', txHashes: [RELAY_TX, TX] });
    expect(paysIn(events)).toEqual(['pay 0 18', 'pay 0 18']);
    expect(lines).toContain(`buyer-03  relay failed (tx ${RELAY_TX}), tries again in 2 s`);
  });

  it('ends failed, with the transactions, when the relay failed on every attempt, and does not redeem after it', async () => {
    const { run, events, lines } = agent({
      offers: [offered(18), offered(18), offered(18)],
      payments: [RELAY_FAILED, RELAY_FAILED, RELAY_FAILED],
      redemptions: [NO_SEATS, NO_SEATS, NO_SEATS],
    });
    expect(await run()).toEqual(nothingPaid('failed', 'relay failed', [RELAY_TX, RELAY_TX, RELAY_TX]));
    expect(events.at(-1)).toBe('pay 0 18');
    expect(lines.at(-1)).toBe(`buyer-03  failed: relay failed  tx ${RELAY_TX}`);
  });

  it('ends failed when the gateway does not serve the pool it pays', async () => {
    const { run } = agent({ payments: [{ kind: 'unknown_pool' }], redemptions: [NO_SEATS] });
    expect(await run()).toEqual(nothingPaid('failed', 'the gateway does not serve pool 0'));
  });
});

describe('runBuyer: redemption', () => {
  it('polls every interval plus up to a tenth of it in jitter', async () => {
    const { run, events } = agent(
      { payments: [pending(18)], redemptions: [NO_SEATS, WAITING, FILLED] },
      { randoms: [0, 0.5, 0.9], redeemIntervalMs: 10_000 },
    );
    await run();
    expect(events.filter((event) => event.startsWith('sleep'))).toEqual(['sleep 0', 'sleep 10500', 'sleep 10900']);
  });

  it('keeps on through 410 refund_pending until the refund is sent, then holds what it got back', async () => {
    const { run } = agent({
      payments: [pending(18)],
      redemptions: [NO_SEATS, WAITING, refund('refund_pending'), refund('refund_pending'), refund('refunded', REFUND_TX)],
    });
    expect(await run()).toEqual({
      buyer: ACCOUNT,
      kind: 'refunded',
      seats: 18,
      paid: 3_240n,
      detail: '6300 back, bonus 540',
      txHashes: [TX, REFUND_TX],
    });
  });

  it('asks again when the gateway answers refunded before it has recorded the refund transaction', async () => {
    const { run, events } = agent({
      payments: [pending(18)],
      redemptions: [NO_SEATS, refund('refunded'), refund('refunded'), refund('refunded', REFUND_TX)],
    });
    expect(await run()).toMatchObject({ kind: 'refunded', txHashes: [TX, REFUND_TX] });
    expect(events.filter((event) => event === 'redeem 0')).toHaveLength(4);
  });

  it('ends refunded without a refund transaction when the gateway still knows none after 3 more requests', async () => {
    const { run, events } = agent({ payments: [pending(18)], redemptions: [NO_SEATS, ...Array(4).fill(refund('refunded'))] });
    expect(await run()).toMatchObject({ kind: 'refunded', detail: '6300 back, bonus 540', txHashes: [TX] });
    expect(events.filter((event) => event === 'redeem 0')).toHaveLength(5);
  });

  it('ends claimable when the pushed refund failed', async () => {
    const { run } = agent({ payments: [pending(18)], redemptions: [NO_SEATS, refund('claimable')] });
    expect(await run()).toEqual({ buyer: ACCOUNT, kind: 'claimable', seats: 18, paid: 3_240n, detail: '6300 to claim, bonus 540', txHashes: [TX] });
  });

  it('keeps on through a 503 and through a request that fails, logging no library text', async () => {
    const { run, events, lines } = agent({
      payments: [pending(18)],
      redemptions: [NO_SEATS, UNAVAILABLE, new Error(`fetch from ${KEYED_URL} failed`), FILLED],
    });
    expect((await run()).kind).toBe('credential');
    expect(events.filter((event) => event === 'redeem 0')).toHaveLength(4);
    expect(lines).toContain('buyer-03  redemption got no answer (error)');
    expect(lines.join('\n')).not.toContain('SECRET');
  });

  it('gives up 5 minutes after the deadline the chain holds, by its own clock', async () => {
    // Polls at 100 s to 800 s after NOW_MS; the deadline is at 600 s, so it gives up at 900 s.
    const { run, events, now } = agent({ payments: [pending(18)], redemptions: [NO_SEATS, ...Array(8).fill(WAITING)] }, { redeemIntervalMs: 100_000 });
    expect(await run()).toEqual({
      buyer: ACCOUNT,
      kind: 'timed_out',
      seats: 18,
      paid: 3_240n,
      detail: 'no final answer 5 min after the deadline',
      txHashes: [TX],
    });
    expect(events.filter((event) => event === 'redeem 0')).toHaveLength(9);
    expect(now()).toBe(DEADLINE_MS + 300_000);
  });

  it('gives up by the deadline the chain holds, whatever deadline the gateway reports', async () => {
    const far = DEADLINE_MS + 30 * 86_400_000;
    const { run, now } = agent(
      {
        offers: [offered(18, { deadline_ms: far })],
        payments: [pending(18, 0, far)],
        redemptions: [NO_SEATS, ...Array(8).fill({ ...WAITING, deadlineMs: far })],
      },
      { redeemIntervalMs: 100_000 },
    );
    expect(await run()).toMatchObject({ kind: 'timed_out' });
    expect(now()).toBe(DEADLINE_MS + 300_000);
  });

  it('counts what its seats cost at the seat price the chain holds', async () => {
    const { run } = agent({ payments: [pending(18)], redemptions: [NO_SEATS, FILLED] }, { pool: { ...CHAIN_POOL, seatPrice: 200n } });
    expect(await run()).toMatchObject({ kind: 'credential', seats: 18, paid: 3_600n });
  });

  it('ends failed when its proof is refused', async () => {
    const { run } = agent({ payments: [pending(18)], redemptions: [NO_SEATS, { kind: 'invalid_proof', error: 'wrong_recipient' }] });
    expect(await run()).toMatchObject({ kind: 'failed', detail: 'proof refused: wrong_recipient' });
  });

  it('ends failed when the gateway reports no seats after a 202', async () => {
    const { run } = agent({ payments: [pending(18)], redemptions: [NO_SEATS, NO_SEATS] });
    expect(await run()).toMatchObject({ kind: 'failed', detail: 'the gateway reports no seats' });
  });

  it('ends failed when the gateway stops serving the pool', async () => {
    const { run } = agent({ payments: [pending(18)], redemptions: [NO_SEATS, { kind: 'unknown_pool' }] });
    expect(await run()).toMatchObject({ kind: 'failed', detail: 'the gateway does not serve pool 0' });
  });
});

describe('runBuyer: logging', () => {
  it('logs one short line per step, prefixed with its name, and a redemption state once', async () => {
    const { run, lines } = agent({ payments: [pending(18)], redemptions: [NO_SEATS, WAITING, WAITING, FILLED] }, { randoms: [0.25] });
    await run();
    expect(lines).toEqual([
      'buyer-03  arrives after 30.0 s: seat price 180, top price 400: wants 18 seats',
      'buyer-03  offered 18 seats for 3240',
      `buyer-03  paid 18 seats  tx ${TX}`,
      'buyer-03  waiting: 120 of 192 seats taken',
      'buyer-03  credential: pool filled',
    ]);
  });

  it('logs the retries, the refund and its transaction', async () => {
    const { run, lines } = agent({
      offers: [offered(18, { taken: 184 }), offered(18, { taken: 184 })],
      payments: [refused('expired'), pending(8)],
      redemptions: [NO_SEATS, NO_SEATS, refund('refund_pending'), refund('refunded', REFUND_TX)],
    });
    await run();
    expect(lines).toEqual([
      'buyer-03  arrives after 0.0 s: seat price 180, top price 400: wants 18 seats',
      'buyer-03  offered 8 of 18 seats for 1440',
      'buyer-03  payment refused: expired, tries again in 2 s',
      'buyer-03  offered 8 of 18 seats for 1440',
      `buyer-03  paid 8 seats  tx ${TX}`,
      'buyer-03  pool expired: refund pending',
      `buyer-03  refunded: 6300 back, bonus 540  tx ${REFUND_TX}`,
    ]);
  });

  it('never logs its credential', async () => {
    const { run, lines } = agent({ payments: [pending(18)], redemptions: [NO_SEATS, FILLED] });
    await run();
    expect(lines.join('\n')).not.toContain(CREDENTIAL);
  });
});
