import { describe, expect, it } from 'vitest';
import { BATCHED_CALL_GAS, TGAS } from '../src/chain.ts';
import { count } from '../src/words.ts';

describe('count', () => {
  it.each([
    [0, 'seat', '0 seats'],
    [1, 'seat', '1 seat'],
    [2, 'pool', '2 pools'],
    [10, 'call', '10 calls'],
  ])('writes %i %s as %j', (n, noun, text) => {
    expect(count(n, noun)).toBe(text);
  });
});

describe('TGAS', () => {
  it('is 10^12 gas, the unit the swarm states gas in', () => {
    expect(TGAS).toBe(10n ** 12n);
    expect(BATCHED_CALL_GAS).toBe(20n * TGAS);
  });
});
