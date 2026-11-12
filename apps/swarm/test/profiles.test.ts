import { minBonusPerSeat } from '@quorum-on-near/protocol';
import { describe, expect, it } from 'vitest';
import { scriptedBuyerIds } from '../src/accounts.ts';
import { loadSwarmConfig } from '../src/config.ts';
import { PROFILES, profileAccount, type BuyerProfile } from '../src/profiles.ts';
import { scenario } from '../src/scenarios.ts';

const PARENT = 'parent.testnet';
const DEFAULTS = { deadlineSeconds: null, spreadSeconds: null };
const FILLS = scenario('fills', DEFAULTS);
const FAILS = scenario('fails', DEFAULTS);

/** The profiles whose rule commits to a pool at `seatPrice`. */
function accepting(seatPrice: bigint): BuyerProfile[] {
  return PROFILES.filter((profile) => seatPrice <= profile.topPrice);
}

function seats(profiles: readonly BuyerProfile[]): number {
  return profiles.reduce((total, profile) => total + profile.seats, 0);
}

describe('PROFILES', () => {
  it('is the fixture: six buyers at 400, eight at 250 and six at 150, each with its seats', () => {
    expect(PROFILES.map((p) => [p.name, p.seats, p.topPrice])).toEqual([
      ['buyer-01', 24, 400n],
      ['buyer-02', 20, 400n],
      ['buyer-03', 18, 400n],
      ['buyer-04', 16, 400n],
      ['buyer-05', 12, 400n],
      ['buyer-06', 10, 400n],
      ['buyer-07', 18, 250n],
      ['buyer-08', 16, 250n],
      ['buyer-09', 14, 250n],
      ['buyer-10', 14, 250n],
      ['buyer-11', 12, 250n],
      ['buyer-12', 10, 250n],
      ['buyer-13', 8, 250n],
      ['buyer-14', 8, 250n],
      ['buyer-15', 12, 150n],
      ['buyer-16', 10, 150n],
      ['buyer-17', 8, 150n],
      ['buyer-18', 6, 150n],
      ['buyer-19', 4, 150n],
      ['buyer-20', 2, 150n],
    ]);
  });

  it('names one profile for each scripted buyer, in order', () => {
    expect(PROFILES.map((profile) => profileAccount(profile, PARENT))).toEqual(scriptedBuyerIds(PARENT));
  });
});

describe('the fixture fits both scenarios', () => {
  const { buyerBudget } = loadSwarmConfig({ QUORUM_PARENT_ACCOUNT: PARENT });

  it("wants no more seats from any buyer than a pool's max_seats_per_buyer", () => {
    for (const profile of PROFILES) {
      expect(profile.seats).toBeLessThanOrEqual(Math.min(FILLS.maxSeatsPerBuyer, FAILS.maxSeatsPerBuyer));
    }
  });

  it("costs no buyer more than the default budget for its seats at its top price", () => {
    expect(buyerBudget).toBe(10_000n);
    for (const profile of PROFILES) {
      expect(BigInt(profile.seats) * profile.topPrice).toBeLessThanOrEqual(buyerBudget);
    }
  });

  it('wants slightly more than the 192 seats of fills at its price, so the last arrivals get fewer or none', () => {
    expect(accepting(FILLS.seatPrice)).toHaveLength(14);
    expect(seats(accepting(FILLS.seatPrice))).toBe(200);
    expect(FILLS.target).toBe(192);
  });

  it('wants 100 of the 192 seats of fails at its price, so the pool expires with a bonus share of 30 a seat and a dust of 72', () => {
    const committed = seats(accepting(FAILS.seatPrice));
    expect(accepting(FAILS.seatPrice)).toHaveLength(6);
    expect(committed).toBe(100);
    const share = FAILS.bonus / BigInt(committed);
    expect([share, FAILS.bonus - share * BigInt(committed)]).toEqual([30n, 72n]);
    expect(share).toBeGreaterThanOrEqual(minBonusPerSeat(FAILS.bonus, FAILS.target));
  });

  it('has six buyers that accept neither price', () => {
    expect(PROFILES.filter((profile) => profile.topPrice < FILLS.seatPrice).map((profile) => profile.name)).toEqual([
      'buyer-15',
      'buyer-16',
      'buyer-17',
      'buyer-18',
      'buyer-19',
      'buyer-20',
    ]);
  });
});
