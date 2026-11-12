import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { paymentRequired } from '@quorum-on-near/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { transportReason } from '../src/errors.ts';
import {
  GatewayClient,
  GatewayResponseError,
  type ActivityRecord,
  type GatewayRoute,
  type OfferAnswer,
  type PaymentAnswer,
  type PoolListing,
  type PoolsAnswer,
  type RedeemAnswer,
} from '../src/gateway.ts';
import {
  BUYER,
  CREDENTIAL,
  GATEWAY_URL,
  jsonResponse,
  offerFor,
  paymentResponseHeader,
  POOL,
  POOL_ID,
  stubFetch,
  txHash,
} from './stub-gateway.ts';

const PAYMENT = 'eyJwYXltZW50Ijp0cnVlfQ==';
const PROOF = 'eyJwcm9vZiI6dHJ1ZX0=';
const OFFER = offerFor(2);
const HASH = txHash();
/** A row of `GET /pools` as the gateway writes it, its amounts as decimal strings. */
const LISTING = {
  id: POOL_ID,
  terms: POOL.terms,
  seat_price: '180',
  target: 192,
  taken: 148,
  deadline_ms: POOL.deadline_ms,
  bonus: '1728',
  min_bonus_per_seat: '9',
};
/** LISTING as the client returns it, its amounts as bigints. */
const LISTED: PoolListing = { ...LISTING, seat_price: 180n, bonus: 1728n, min_bonus_per_seat: 9n };
/** A record of the activity feed as the gateway writes it. */
const RECORD = {
  at: 1_800_000_000_000,
  poolId: POOL_ID,
  kind: 'commit',
  account: BUYER,
  seats: 2,
  amount: '360',
  txHash: HASH,
  ok: true,
};
/** RECORD as the client returns it. */
const RECORDED: ActivityRecord = { ...RECORD, kind: 'commit', amount: 360n };

/** A client whose fetch answers every request with `answer()`, and the requests it sent. */
function client(answer: () => Response = () => jsonResponse(503, { error: 'chain_unavailable' })) {
  const { fetch, requests } = stubFetch(answer);
  return { gateway: new GatewayClient({ gatewayUrl: GATEWAY_URL, fetch }), requests };
}

/** One answer of the gateway: its status, its body and its headers. */
interface Answer {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

/** Sends the request of `route` to a gateway that answers with `answer`. */
async function ask(route: GatewayRoute, answer: Answer): Promise<unknown> {
  const { gateway } = client(() => jsonResponse(answer.status, answer.body, answer.headers));
  switch (route) {
    case 'pools':
      return gateway.pools();
    case 'offer':
      return gateway.offer(POOL_ID, 2);
    case 'payment':
      return gateway.pay(POOL_ID, 2, PAYMENT);
    case 'redemption':
      return gateway.redeem(POOL_ID, PROOF);
    case 'activity':
      return gateway.activity(POOL_ID);
  }
}

/** The error `promise` rejects with; fails the test if it resolves. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('the promise resolved');
}

describe('GatewayClient requests', () => {
  it('pools() asks GET /pools', async () => {
    const { gateway, requests } = client(() => jsonResponse(200, []));
    await gateway.pools();
    expect(requests.map((r) => [r.method, r.url])).toEqual([['GET', `${GATEWAY_URL}/pools`]]);
  });

  it('offer() asks for the seats with neither a payment nor a proof', async () => {
    const { gateway, requests } = client();
    await gateway.offer(POOL_ID, 2);
    const [request] = requests;
    expect(request?.url).toBe(`${GATEWAY_URL}/pools/7/access?seats=2`);
    expect(request?.headers.has('X-PAYMENT')).toBe(false);
    expect(request?.headers.has('X-QUORUM-PROOF')).toBe(false);
  });

  it('pay() sends the payment header once, at the URL of the seats requested', async () => {
    const { gateway, requests } = client();
    await gateway.pay(POOL_ID, 2, PAYMENT);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(`${GATEWAY_URL}/pools/7/access?seats=2`);
    expect(requests[0]?.headers.get('X-PAYMENT')).toBe(PAYMENT);
  });

  it('redeem() sends the proof header, with no seats', async () => {
    const { gateway, requests } = client();
    await gateway.redeem(POOL_ID, PROOF);
    expect(requests[0]?.url).toBe(`${GATEWAY_URL}/pools/7/access`);
    expect(requests[0]?.headers.get('X-QUORUM-PROOF')).toBe(PROOF);
    expect(requests[0]?.headers.has('X-PAYMENT')).toBe(false);
  });

  it("activity() asks for one pool's records", async () => {
    const { gateway, requests } = client(() => jsonResponse(200, []));
    await gateway.activity(POOL_ID);
    expect(requests[0]?.url).toBe(`${GATEWAY_URL}/activity?pool=7`);
  });

  it('refuses to follow a redirect, which would carry a payment or a proof to another server', async () => {
    const { gateway, requests } = client();
    await gateway.pay(POOL_ID, 2, PAYMENT);
    await gateway.redeem(POOL_ID, PROOF);
    expect(requests.map((r) => r.redirect)).toEqual(['error', 'error']);
  });

  it.each([-1, 1.5, Number.NaN, 2 ** 53])('refuses the pool id %s before sending anything', async (poolId) => {
    const { gateway, requests } = client();
    await expect(gateway.offer(poolId, 1)).rejects.toThrow(RangeError);
    await expect(gateway.pay(poolId, 1, PAYMENT)).rejects.toThrow(RangeError);
    await expect(gateway.redeem(poolId, PROOF)).rejects.toThrow(RangeError);
    await expect(gateway.activity(poolId)).rejects.toThrow(RangeError);
    expect(requests).toEqual([]);
  });

  it.each([0, 1001, 2.5])('refuses %s seats, outside the 1 to 1000 a request may ask for', async (seats) => {
    const { gateway, requests } = client();
    await expect(gateway.offer(POOL_ID, seats)).rejects.toThrow(RangeError);
    await expect(gateway.pay(POOL_ID, seats, PAYMENT)).rejects.toThrow(RangeError);
    expect(requests).toEqual([]);
  });

  it('passes on the error of a request that never got an answer, without sending it again', async () => {
    const failure = new TypeError('fetch failed');
    const { gateway, requests } = client(() => {
      throw failure;
    });
    expect(await rejection(gateway.pay(POOL_ID, 2, PAYMENT))).toBe(failure);
    expect(requests).toHaveLength(1);
  });
});

describe('GatewayClient answers', () => {
  const documented: [GatewayRoute, string, Answer, PoolsAnswer | OfferAnswer | PaymentAnswer | RedeemAnswer | ActivityRecord[]][] = [
    ['pools', 'the open pools', { status: 200, body: [LISTING] }, { kind: 'pools', pools: [LISTED] }],
    ['pools', 'a chain it cannot read', { status: 503, body: { error: 'chain_unavailable' } }, { kind: 'unavailable' }],

    ['offer', 'an offer', { status: 402, body: paymentRequired([OFFER]) }, { kind: 'offer', offer: OFFER }],
    ['offer', 'an unknown pool', { status: 404, body: { error: 'unknown_pool' } }, { kind: 'unknown_pool' }],
    ['offer', 'a filled pool', { status: 409, body: { error: 'pool_closed', status: 'filled' } }, { kind: 'pool_closed', status: 'filled' }],
    ['offer', 'a settled pool', { status: 409, body: { error: 'pool_closed', status: 'settled' } }, { kind: 'pool_closed', status: 'settled' }],
    ['offer', 'an open pool with no seat to offer', { status: 409, body: { error: 'pool_closed', status: 'open' } }, { kind: 'pool_closed', status: 'open' }],
    ['offer', 'an expired pool', { status: 410, body: { error: 'pool_expired', status: 'expired' } }, { kind: 'pool_expired', status: 'expired' }],
    ['offer', 'a refunded pool', { status: 410, body: { error: 'pool_expired', status: 'refunded' } }, { kind: 'pool_expired', status: 'refunded' }],
    ['offer', 'a chain it cannot read', { status: 503, body: { error: 'chain_unavailable' } }, { kind: 'unavailable' }],

    [
      'payment',
      'seats taken in a pool still open',
      {
        status: 202,
        body: {
          status: 'pending',
          receipt: { poolId: POOL_ID, buyer: BUYER, seats: 2, txHash: HASH },
          pool: { taken: 150, target: 192, deadlineMs: POOL.deadline_ms },
        },
        headers: paymentResponseHeader(HASH),
      },
      { kind: 'pending', txHash: HASH, poolId: POOL_ID, buyer: BUYER, seats: 2, taken: 150, target: 192, deadlineMs: POOL.deadline_ms },
    ],
    [
      'payment',
      'the payment that filled the pool',
      {
        status: 200,
        body: { status: 'filled', credential: CREDENTIAL, poolId: POOL_ID, seats: 4, terms: POOL.terms },
        headers: paymentResponseHeader(HASH),
      },
      { kind: 'filled', txHash: HASH, credential: CREDENTIAL, poolId: POOL_ID, seats: 4, terms: POOL.terms },
    ],
    [
      'payment',
      'a refusal with the offer as it stands',
      { status: 402, body: paymentRequired([OFFER], 'stale_nonce') },
      { kind: 'refused', error: 'stale_nonce', offer: OFFER },
    ],
    [
      'payment',
      'a refusal with no offer left',
      { status: 402, body: paymentRequired([], 'over_buyer_cap') },
      { kind: 'refused', error: 'over_buyer_cap', offer: null },
    ],
    [
      'payment',
      'no seats taken because the pool filled',
      { status: 409, body: paymentRequired([], 'no_seats_taken') },
      { kind: 'no_seats_taken' },
    ],
    [
      'payment',
      'no seats taken because the pool had expired',
      { status: 410, body: { error: 'pool_expired', poolId: POOL_ID, txHash: HASH } },
      { kind: 'pool_expired', txHash: HASH },
    ],
    ['payment', 'a failed relay', { status: 502, body: { error: 'relay_failed', txHash: HASH } }, { kind: 'relay_failed', txHash: HASH }],
    [
      'payment',
      'a relay whose result is unknown',
      { status: 502, body: { error: 'result_unknown', txHash: HASH } },
      { kind: 'result_unknown', txHash: HASH },
    ],
    ['payment', 'an unknown pool', { status: 404, body: { error: 'unknown_pool' } }, { kind: 'unknown_pool' }],
    ['payment', 'a chain it cannot read', { status: 503, body: { error: 'chain_unavailable' } }, { kind: 'unavailable' }],

    [
      'redemption',
      'a pool still open',
      { status: 202, body: { status: 'pending', seats: 2, taken: 150, target: 192, deadlineMs: POOL.deadline_ms } },
      { kind: 'pending', seats: 2, taken: 150, target: 192, deadlineMs: POOL.deadline_ms },
    ],
    [
      'redemption',
      'a pool that filled',
      { status: 200, body: { status: 'filled', credential: CREDENTIAL, poolId: POOL_ID, seats: 2, terms: POOL.terms } },
      { kind: 'filled', credential: CREDENTIAL, poolId: POOL_ID, seats: 2, terms: POOL.terms },
    ],
    [
      'redemption',
      'a refund pushed to the buyer',
      { status: 410, body: { status: 'refunded', amount: '420', bonusShare: '60', txHash: HASH } },
      { kind: 'refund', status: 'refunded', amount: 420n, bonusShare: 60n, txHash: HASH },
    ],
    [
      'redemption',
      'a refund not sent yet',
      { status: 410, body: { status: 'refund_pending', amount: '420', bonusShare: '60', txHash: null } },
      { kind: 'refund', status: 'refund_pending', amount: 420n, bonusShare: 60n, txHash: null },
    ],
    [
      'redemption',
      'a refund the buyer must claim',
      { status: 410, body: { status: 'claimable', amount: '420', bonusShare: '60', txHash: null } },
      { kind: 'refund', status: 'claimable', amount: 420n, bonusShare: 60n, txHash: null },
    ],
    ['redemption', 'an account with no seats', { status: 404, body: { error: 'no_seats' } }, { kind: 'no_seats' }],
    ['redemption', 'an unknown pool', { status: 404, body: { error: 'unknown_pool' } }, { kind: 'unknown_pool' }],
    ['redemption', 'a chain it cannot read', { status: 503, body: { error: 'chain_unavailable' } }, { kind: 'unavailable' }],

    ['activity', "the pool's records", { status: 200, body: [RECORD] }, [RECORDED]],
  ];

  it.each(documented)('%s: %s', async (route, _name, answer, expected) => {
    expect(await ask(route, answer)).toEqual(expected);
  });

  const PAYMENT_CODES = [
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
    'not_full_access',
    'stale_nonce',
    'nonce_too_large',
    'expired',
    'pool_closed',
    'insufficient_balance',
    'seller_commit',
    'over_buyer_cap',
    'payment_in_flight',
  ];
  it.each(PAYMENT_CODES)('payment: a refusal with the code %s', async (code) => {
    expect(await ask('payment', { status: 402, body: paymentRequired([], code) })).toEqual({
      kind: 'refused',
      error: code,
      offer: null,
    });
  });

  const PROOF_CODES = [
    'invalid_proof',
    'wrong_message',
    'wrong_recipient',
    'stale_proof',
    'invalid_signature',
    'not_full_access',
    'replayed_proof',
  ];
  it.each(PROOF_CODES)('redemption: a proof refused with the code %s', async (code) => {
    expect(await ask('redemption', { status: 401, body: { error: code } })).toEqual({ kind: 'invalid_proof', error: code });
  });

  it('keeps only the documented fields of an offer', async () => {
    const answer = await ask('offer', {
      status: 402,
      body: paymentRequired([{ ...OFFER, injected: true, extra: { ...OFFER.extra, injected: true } } as typeof OFFER]),
    });
    expect(answer).toEqual({ kind: 'offer', offer: OFFER });
    expect(Object.keys((answer as { offer: object }).offer)).not.toContain('injected');
  });
});

describe('GatewayClient answers that are not documented', () => {
  const pending = (overrides: { receipt?: object; headers?: Record<string, string> } = {}): Answer => ({
    status: 202,
    body: {
      status: 'pending',
      receipt: { poolId: POOL_ID, buyer: BUYER, seats: 2, txHash: HASH, ...overrides.receipt },
      pool: { taken: 150, target: 192, deadlineMs: POOL.deadline_ms },
    },
    headers: overrides.headers ?? paymentResponseHeader(HASH),
  });
  const filled = { status: 'filled', credential: CREDENTIAL, poolId: POOL_ID, seats: 2, terms: POOL.terms };
  /** 281 bytes of terms, one more than the pools contract keeps, and 282 bytes in 141 characters. */
  const LONG_TERMS = 'x'.repeat(281);
  const WIDE_TERMS = 'é'.repeat(141);
  /** A compact JWS of 4097 characters. */
  const LONG_CREDENTIAL = `${'a'.repeat(4000)}.${'b'.repeat(48)}.${'c'.repeat(47)}`;
  const offerWithTerms = (terms: string) => paymentRequired([{ ...OFFER, extra: { ...OFFER.extra, terms } }]);
  const undocumented: [GatewayRoute, string, Answer][] = [
    ['pools', 'a body that is not an array', { status: 200, body: { pools: [] } }],
    ['pools', 'a row with a number for an amount', { status: 200, body: [{ ...LISTING, seat_price: 180 }] }],
    ['pools', 'a status the route never answers', { status: 404, body: { error: 'not_found' } }],
    ['pools', 'a row whose terms are longer than the 280 bytes the contract keeps', { status: 200, body: [{ ...LISTING, terms: LONG_TERMS }] }],
    ['pools', 'a row whose terms are 282 bytes in 141 characters', { status: 200, body: [{ ...LISTING, terms: WIDE_TERMS }] }],

    ['offer', 'a 402 with two offers', { status: 402, body: paymentRequired([OFFER, OFFER]) }],
    ['offer', 'a 402 with no offer', { status: 402, body: paymentRequired([]) }],
    ['offer', 'a 402 whose error is a refusal code', { status: 402, body: paymentRequired([OFFER], 'stale_nonce') }],
    ['offer', 'an offer whose seats are a string', { status: 402, body: paymentRequired([{ ...OFFER, extra: { ...OFFER.extra, seats: '2' } } as unknown as typeof OFFER]) }],
    ['offer', 'an offer of another scheme', { status: 402, body: paymentRequired([{ ...OFFER, scheme: 'exact' } as unknown as typeof OFFER]) }],
    ['offer', 'an offer with no timeout', { status: 402, body: paymentRequired([{ ...OFFER, maxTimeoutSeconds: 0 }]) }],
    ['offer', 'an offer whose terms are longer than 280 bytes', { status: 402, body: offerWithTerms(LONG_TERMS) }],
    ['offer', 'a 409 with a status that is not closed', { status: 409, body: { error: 'pool_closed', status: 'expired' } }],
    ['offer', 'a 410 with a status that has not expired', { status: 410, body: { error: 'pool_expired', status: 'open' } }],
    ['offer', 'a 404 with another error', { status: 404, body: { error: 'not_found' } }],
    ['offer', 'an invalid-seats answer to a valid request', { status: 400, body: { error: 'invalid_seats' } }],
    ['offer', 'an internal error', { status: 500, body: { error: 'internal_error' } }],

    ['payment', 'a 202 without X-PAYMENT-RESPONSE', pending({ headers: {} })],
    ['payment', 'a 202 whose X-PAYMENT-RESPONSE is not base64 JSON', pending({ headers: { 'X-PAYMENT-RESPONSE': '%%%' } })],
    ['payment', 'a 202 whose X-PAYMENT-RESPONSE names another transaction', pending({ headers: paymentResponseHeader(txHash()) })],
    ['payment', 'a 202 whose buyer is not an account id', pending({ receipt: { buyer: 'Not An Account' } })],
    ['payment', 'a 200 whose credential is not a compact JWS', { status: 200, body: { ...filled, credential: 'not a jws' }, headers: paymentResponseHeader(HASH) }],
    ['payment', 'a 200 that says pending', { status: 200, body: { ...filled, status: 'pending' }, headers: paymentResponseHeader(HASH) }],
    ['payment', 'a 200 whose terms are longer than 280 bytes', { status: 200, body: { ...filled, terms: WIDE_TERMS }, headers: paymentResponseHeader(HASH) }],
    ['payment', 'a 402 whose offer has terms longer than 280 bytes', { status: 402, body: { ...offerWithTerms(LONG_TERMS), error: 'stale_nonce' } }],
    ['payment', 'a 502 whose hash is shorter than a transaction hash', { status: 502, body: { error: 'relay_failed', txHash: '1'.repeat(31) } }],
    ['payment', 'a 502 whose hash is longer than a transaction hash', { status: 502, body: { error: 'result_unknown', txHash: '1'.repeat(45) } }],
    ['payment', 'a 200 whose X-PAYMENT-RESPONSE hash is longer than a transaction hash', { status: 200, body: filled, headers: paymentResponseHeader('1'.repeat(45)) }],
    ['payment', 'a 402 with an unknown code', { status: 402, body: paymentRequired([], 'try_again') }],
    ['payment', 'a 402 of another x402 version', { status: 402, body: { ...paymentRequired([], 'stale_nonce'), x402Version: 2 } }],
    ['payment', 'a 409 that carries an offer', { status: 409, body: paymentRequired([OFFER], 'no_seats_taken') }],
    ['payment', 'a 502 with another error', { status: 502, body: { error: 'bad_gateway', txHash: HASH } }],
    ['payment', 'a 502 whose hash is not base58', { status: 502, body: { error: 'relay_failed', txHash: '0x\u001b[2Jhash' } }],
    ['payment', 'a 410 without a hash', { status: 410, body: { error: 'pool_expired', poolId: POOL_ID } }],

    ['redemption', 'a 401 with an unknown code', { status: 401, body: { error: 'expired_session' } }],
    ['redemption', 'a 410 with an unknown refund status', { status: 410, body: { status: 'gone', amount: '420', bonusShare: '60', txHash: null } }],
    ['redemption', 'a 410 with a negative amount', { status: 410, body: { status: 'refunded', amount: '-420', bonusShare: '60', txHash: HASH } }],
    ['redemption', 'a 202 whose seats are a string', { status: 202, body: { status: 'pending', seats: '2', taken: 150, target: 192, deadlineMs: 1 } }],
    ['redemption', 'a 200 whose credential is longer than 4096 characters', { status: 200, body: { ...filled, credential: LONG_CREDENTIAL } }],
    ['redemption', 'a 410 whose refund hash is longer than a transaction hash', { status: 410, body: { status: 'refunded', amount: '420', bonusShare: '60', txHash: '1'.repeat(45) } }],

    ['activity', 'a record of an unknown kind', { status: 200, body: [{ at: 1, poolId: POOL_ID, kind: 'mint', account: BUYER, seats: 0, amount: '0', txHash: HASH, ok: true }] }],
    ['activity', 'an invalid-pool answer to a valid pool id', { status: 400, body: { error: 'invalid_pool' } }],
    ['activity', 'a record whose hash is shorter than a transaction hash', { status: 200, body: [{ ...RECORD, txHash: '1'.repeat(31) }] }],
  ];

  it.each(undocumented)('%s: %s throws GatewayResponseError', async (route, _name, answer) => {
    const error = await rejection(ask(route, answer));
    expect(error).toBeInstanceOf(GatewayResponseError);
    expect((error as GatewayResponseError).route).toBe(route);
    expect((error as GatewayResponseError).status).toBe(answer.status);
  });

  it('accepts terms of exactly 280 bytes, a credential of 4096 characters, and hashes of 32 and 44 characters', async () => {
    const terms = `${'é'.repeat(139)}xx`;
    const credential = `${'a'.repeat(4000)}.${'b'.repeat(48)}.${'c'.repeat(46)}`;
    expect(await ask('pools', { status: 200, body: [{ ...LISTING, terms }] })).toEqual({ kind: 'pools', pools: [{ ...LISTED, terms }] });
    expect(await ask('redemption', { status: 200, body: { ...filled, credential } })).toMatchObject({ kind: 'filled', credential });
    for (const txHash of ['1'.repeat(32), 'z'.repeat(44)]) {
      expect(await ask('payment', { status: 502, body: { error: 'relay_failed', txHash } })).toEqual({ kind: 'relay_failed', txHash });
    }
  });

  it('throws GatewayResponseError for a body that is not JSON', async () => {
    const { gateway } = client(() => new Response('<html>Bad Gateway</html>', { status: 502 }));
    const error = await rejection(gateway.pay(POOL_ID, 2, PAYMENT));
    expect(error).toBeInstanceOf(GatewayResponseError);
    expect((error as GatewayResponseError).status).toBe(502);
  });

  it('names the route and the status in its message, never a value of the body', async () => {
    const body = { status: 'filled', credential: CREDENTIAL, poolId: 'seven', seats: 2, terms: POOL.terms };
    const error = await rejection(ask('redemption', { status: 200, body }));
    const { message } = error as Error;
    expect(message).toContain('redemption');
    expect(message).toContain('200');
    expect(message).not.toContain(CREDENTIAL);
    expect(message).not.toContain('seven');
  });
});

describe('GatewayClient time and size limits', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('gives a payment 300 seconds to be answered, and every other request 30 seconds', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const signals: unknown[] = [];
    const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      signals.push(init?.signal);
      return String(input).includes('/activity') ? jsonResponse(200, []) : jsonResponse(503, { error: 'chain_unavailable' });
    };
    const gateway = new GatewayClient({ gatewayUrl: GATEWAY_URL, fetch });
    await gateway.pools();
    await gateway.offer(POOL_ID, 2);
    await gateway.pay(POOL_ID, 2, PAYMENT);
    await gateway.redeem(POOL_ID, PROOF);
    await gateway.activity(POOL_ID);
    expect(timeout.mock.calls).toEqual([[30_000], [30_000], [300_000], [30_000], [30_000]]);
    expect(signals).toEqual(timeout.mock.results.map((result) => result.value));
  });

  /** A body of `chunks` chunks of 64 KiB of spaces, which records how many it gave and whether it was cancelled. */
  function spaces(chunks: number) {
    const chunk = new Uint8Array(64 * 1024).fill(0x20);
    const read = { pulled: 0, cancelled: false };
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        read.pulled += 1;
        controller.enqueue(chunk);
        if (read.pulled === chunks) controller.close();
      },
      cancel() {
        read.cancelled = true;
      },
    });
    return { body, read };
  }

  it('reads at most 1 MiB of a body: a longer one is an undocumented answer, and the rest is never read', async () => {
    const { body, read } = spaces(64);
    const { gateway } = client(() => new Response(body, { status: 200 }));
    const error = await rejection(gateway.pools());
    expect(error).toBeInstanceOf(GatewayResponseError);
    expect((error as GatewayResponseError).status).toBe(200);
    expect((error as Error).message).toContain('the body is longer than 1 MiB');
    expect(read.cancelled).toBe(true);
    expect(read.pulled).toBeLessThan(20);
  });

  it('reads a body of exactly 1 MiB', async () => {
    const body = `[]${' '.repeat(1024 * 1024 - 2)}`;
    const { gateway } = client(() => new Response(body, { status: 200 }));
    expect(await gateway.pools()).toEqual({ kind: 'pools', pools: [] });
  });

  it('refuses a payment answer longer than 1 MiB as undocumented, so that the payment stays unknown', async () => {
    const { body } = spaces(17);
    const { gateway } = client(() => new Response(body, { status: 202 }));
    expect(await rejection(gateway.pay(POOL_ID, 2, PAYMENT))).toBeInstanceOf(GatewayResponseError);
  });

  describe('against a server on the loopback interface', () => {
    let server: Server;
    let url: string;
    let handle: (request: IncomingMessage, response: ServerResponse) => void;

    beforeEach(async () => {
      server = createServer((request, response) => handle(request, response));
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterEach(async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    });

    it("aborts a payment that gets no answer within its timeout, having sent it once, with the abort's TimeoutError", async () => {
      let received = 0;
      handle = () => {
        received += 1;
      };
      const gateway = new GatewayClient({ gatewayUrl: url, payTimeoutMs: 100 });
      const error = await rejection(gateway.pay(POOL_ID, 2, PAYMENT));
      expect(error).toMatchObject({ name: 'TimeoutError' });
      expect(transportReason(error)).toBe('timeout');
      expect(received).toBe(1);
    });

    it('aborts a read whose body has not ended within its timeout', async () => {
      handle = (_, response) => {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.write('[');
      };
      const gateway = new GatewayClient({ gatewayUrl: url, readTimeoutMs: 100 });
      const error = await rejection(gateway.pools());
      expect(error).toMatchObject({ name: 'TimeoutError' });
      expect(transportReason(error)).toBe('timeout');
    });
  });
});
