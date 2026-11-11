import { describe, expect, it } from 'vitest';
import { isAccountId } from '../src/account.ts';

describe('isAccountId', () => {
  it('accepts named accounts and sub-accounts', () => {
    for (const id of ['near', 'pools.parent.testnet', 'buyer-01.parent.testnet', 'a_b.c-d']) {
      expect(isAccountId(id)).toBe(true);
    }
  });

  it('accepts a 64-character implicit account', () => {
    expect(isAccountId('3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af')).toBe(true);
  });

  it('refuses ids shorter than 2 or longer than 64 characters', () => {
    expect(isAccountId('a')).toBe(false);
    expect(isAccountId('a'.repeat(65))).toBe(false);
  });

  it('refuses upper case, empty parts and separators at the edges', () => {
    for (const id of ['Near', 'a..b', '.ab', 'ab.', '-ab', 'ab-', 'a--b', 'a b', '']) {
      expect(isAccountId(id)).toBe(false);
    }
  });
});
