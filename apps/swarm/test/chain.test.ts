import { describe, expect, it } from 'vitest';
import { freeBalance, STORAGE_PRICE_PER_BYTE } from '../src/chain.ts';

const NEAR = 10n ** 24n;

describe('freeBalance', () => {
  it("is the balance less what the account's storage locks, at 10^19 yoctoNEAR a byte", () => {
    expect(STORAGE_PRICE_PER_BYTE).toBe(10n ** 19n);
    // 204,022 bytes lock 2.04022 NEAR.
    expect(freeBalance({ balance: 3_500_000_000_000_000_000_000_000n, storageUsage: 204_022n })).toBe(1_459_780_000_000_000_000_000_000n);
    expect(freeBalance({ balance: NEAR, storageUsage: 0n })).toBe(NEAR);
  });

  it('is 0, never negative, when the storage locks the whole balance or more', () => {
    expect(freeBalance({ balance: NEAR, storageUsage: 100_000n })).toBe(0n);
    expect(freeBalance({ balance: NEAR, storageUsage: 100_001n })).toBe(0n);
  });
});
