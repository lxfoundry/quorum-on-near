import type { Offer, PoolView } from '@quorum-on-near/protocol';
import { describe, expect, it } from 'vitest';
import { offerMismatch, poolRefusal } from '../src/offer-check.ts';
import { offerFor, POOL } from './fixtures.ts';

/** The offer for 2 seats of POOL, with `extra` changed by `change`. */
function offerWith(change: Partial<Offer['extra']>): Offer {
  const offer = offerFor(2);
  return { ...offer, extra: { ...offer.extra, ...change } };
}

describe('offerMismatch', () => {
  it('finds nothing in the offer the gateway builds from the pool it reads', () => {
    expect(offerMismatch(offerFor(2), POOL)).toBeNull();
  });

  it.each<[string, Partial<Offer['extra']>]>([
    ['seat price', { seatPrice: '181' }],
    ['target', { target: 191 }],
    ['deadline', { deadlineMs: POOL.deadline_ms + 1 }],
    ['bonus', { bonus: '1000000' }],
    ['terms', { terms: `${POOL.terms} ` }],
    // floor(1,728 / 191) = 9.
    ['minimum bonus per seat', { minBonusPerSeat: '5000' }],
  ])("names the %s when the offer's differs from the chain's", (field, change) => {
    expect(offerMismatch(offerWith(change), POOL)).toBe(`the offer's ${field} is not the pool's on chain`);
  });

  it('names the first fact that differs, in the order seat price, target, deadline, bonus, terms', () => {
    expect(offerMismatch(offerWith({ bonus: '1', terms: 'other' }), POOL)).toBe("the offer's bonus is not the pool's on chain");
  });

  it.each<[string, Partial<PoolView>]>([
    ['taken', { taken: 191 }],
    ['status', { status: 'filled' }],
    ['the buyer count', { buyer_count: 31 }],
  ])('never compares what moves after the pool opened: %s', (_, change) => {
    expect(offerMismatch(offerFor(2), { ...POOL, ...change })).toBeNull();
  });

  it('compares amounts by value, and refuses one that is not a decimal amount', () => {
    const offer = offerWith({ seatPrice: 'one hundred' });
    expect(offerMismatch(offer, POOL)).toBe("the offer's seat price is not the pool's on chain");
  });

  it('never throws for an offer without its pool facts', () => {
    const offer = { ...offerFor(2), extra: null } as unknown as Offer;
    expect(offerMismatch(offer, POOL)).toBe('the offer carries no pool facts');
  });
});

describe('poolRefusal', () => {
  it('refuses nothing for an open pool with seats left whose facts the offer states', () => {
    expect(poolRefusal(offerFor(2), POOL)).toBeNull();
  });

  it('refuses an offer that misstates the pool as offer_mismatch, before anything else', () => {
    expect(poolRefusal(offerWith({ bonus: '1' }), { ...POOL, status: 'filled' })).toEqual({
      code: 'offer_mismatch',
      detail: "the offer's bonus is not the pool's on chain",
    });
  });

  it.each<[PoolView['status']]>([['filled'], ['settled'], ['expired'], ['refunded']])(
    'refuses a pool that is %s on chain as pool_closed',
    (status) => {
      const refusal = { code: 'pool_closed', detail: `pool 7 is ${status} on chain` };
      expect(poolRefusal(offerFor(2), { ...POOL, status })).toEqual(refusal);
    },
  );

  it('refuses an open pool with no seat left on chain as pool_closed', () => {
    expect(poolRefusal(offerFor(2), { ...POOL, taken: 192 })).toEqual({
      code: 'pool_closed',
      detail: 'pool 7 has no seat left on chain',
    });
  });
});
