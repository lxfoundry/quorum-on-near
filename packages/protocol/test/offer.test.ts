import { describe, expect, it } from 'vitest';
import type { PoolView } from '../src/contract.ts';
import { buildOffer, offerSeats, paymentRequired, type OfferContext } from '../src/offer.ts';

const TERMS = '8×GPU × 24 h; 1 seat = 1 GPU-hour; prices at 1/10,000 scale';

/** Circle's testnet USDC. */
const TESTNET_USDC = '3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af';

/** A pool as the contract's views return it; the defaults are those of the design spec's example offer. */
function pool(overrides: Partial<PoolView> = {}): PoolView {
  return {
    id: 7,
    seller: 'provider.<parent>',
    seat_price: '180',
    target: 192,
    taken: 148,
    deadline_ms: 1_800_000_000_000,
    bonus: '1728',
    max_seats_per_buyer: null,
    terms: TERMS,
    status: 'open',
    bonus_per_seat: '0',
    refund_cursor: 0,
    dust_sent: false,
    buyer_count: 30,
    ...overrides,
  };
}

/** The account names are the design spec's placeholders, so that the example can be compared as is. */
const CTX: OfferContext = {
  network: 'near:testnet',
  gatewayUrl: 'https://<gateway>',
  poolsContract: 'pools.<parent>',
  token: TESTNET_USDC,
  relayer: 'relay.<parent>',
  minGas: 50_000_000_000_000n,
  maxGas: 100_000_000_000_000n,
  maxTimeoutSeconds: 120,
};

/** The example 402 body of the design spec, section 6.2, as written there. */
const SPEC_EXAMPLE = `{
  "x402Version": 1,
  "error": "payment required",
  "accepts": [{
    "scheme": "quorum",
    "network": "near:testnet",
    "maxAmountRequired": "360",
    "resource": "https://<gateway>/pools/7/access?seats=2",
    "description": "2 seats in pool 7: 8×GPU × 24 h; 1 seat = 1 GPU-hour; prices at 1/10,000 scale",
    "mimeType": "application/json",
    "payTo": "pools.<parent>",
    "maxTimeoutSeconds": 120,
    "asset": "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af",
    "extra": {
      "poolId": 7, "seats": 2, "seatPrice": "180",
      "target": 192, "taken": 148, "deadlineMs": 1800000000000,
      "bonus": "1728", "minBonusPerSeat": "9",
      "terms": "8×GPU × 24 h; 1 seat = 1 GPU-hour; prices at 1/10,000 scale",
      "relayer": "relay.<parent>", "minGas": "50000000000000", "maxGas": "100000000000000"
    }
  }]
}`;

describe('offerSeats', () => {
  it('offers the seats requested when enough are left', () => {
    expect(offerSeats(pool(), 2)).toBe(2);
  });

  it('offers every seat left when the request is exactly that', () => {
    expect(offerSeats(pool(), 44)).toBe(44);
  });

  it('caps the offer at the seats left in the pool', () => {
    expect(offerSeats(pool(), 50)).toBe(44);
  });

  it('caps the offer at max_seats_per_buyer', () => {
    expect(offerSeats(pool({ max_seats_per_buyer: 24 }), 30)).toBe(24);
  });

  it('applies the seats left when they are fewer than max_seats_per_buyer', () => {
    expect(offerSeats(pool({ taken: 182, max_seats_per_buyer: 24 }), 30)).toBe(10);
  });

  it('applies max_seats_per_buyer when it is lower than the seats left', () => {
    expect(offerSeats(pool({ taken: 100, max_seats_per_buyer: 5 }), 30)).toBe(5);
  });

  it('returns 0 for a full pool', () => {
    expect(offerSeats(pool({ taken: 192 }), 1)).toBe(0);
  });

  it.each([
    ['0', 0],
    ['negative', -1],
    ['fractional', 1.5],
    ['NaN', Number.NaN],
    ['beyond the safe integer range', 2 ** 53],
  ])('throws a RangeError for a request that is %s', (_kind, requested) => {
    expect(() => offerSeats(pool(), requested)).toThrow(RangeError);
  });
});

describe('buildOffer', () => {
  it('reproduces the example 402 body of the design spec, section 6.2', () => {
    expect(paymentRequired([buildOffer(pool(), 2, CTX)])).toStrictEqual(JSON.parse(SPEC_EXAMPLE));
  });

  it('serializes its fields in the order of the design spec example', () => {
    const body = paymentRequired([buildOffer(pool(), 2, CTX)]);
    expect(JSON.stringify(body)).toBe(JSON.stringify(JSON.parse(SPEC_EXAMPLE)));
  });

  it('describes one seat in the singular', () => {
    expect(buildOffer(pool(), 1, CTX).description).toBe(`1 seat in pool 7: ${TERMS}`);
  });

  it('names the seats offered in the resource URL', () => {
    expect(buildOffer(pool(), 1, CTX).resource).toBe('https://<gateway>/pools/7/access?seats=1');
  });

  it('prices the offer at seats × seat_price', () => {
    expect(buildOffer(pool({ seat_price: '320' }), 3, CTX).maxAmountRequired).toBe('960');
  });

  it('keeps every digit of a seat price beyond the range of a number', () => {
    const seatPrice = (2n ** 100n).toString();
    expect(buildOffer(pool({ seat_price: seatPrice }), 3, CTX).maxAmountRequired).toBe((3n * 2n ** 100n).toString());
  });

  it('gives the minimum bonus per seat as bonus / (target − 1), rounded down', () => {
    expect(buildOffer(pool({ bonus: '1910' }), 1, CTX).extra.minBonusPerSeat).toBe('10');
  });
});

describe('paymentRequired', () => {
  it('defaults the error to "payment required"', () => {
    expect(paymentRequired([])).toStrictEqual({ x402Version: 1, error: 'payment required', accepts: [] });
  });

  it('carries the error it is given', () => {
    expect(paymentRequired([], 'wrong_amount').error).toBe('wrong_amount');
  });

  it('carries the offers it is given', () => {
    const offer = buildOffer(pool(), 2, CTX);
    expect(paymentRequired([offer]).accepts).toStrictEqual([offer]);
  });
});
