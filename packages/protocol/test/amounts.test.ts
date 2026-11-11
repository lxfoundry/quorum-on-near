import { describe, expect, it } from 'vitest';
import { minBonusPerSeat, parseAmount, priceOf } from '../src/amounts.ts';

const U128_MAX = 2n ** 128n - 1n;

describe('priceOf', () => {
  it('multiplies the seats by the seat price', () => {
    expect(priceOf(2, 180n)).toBe(360n);
  });

  it('is 0 for 0 seats', () => {
    expect(priceOf(0, 180n)).toBe(0n);
  });

  it('keeps every digit of a price beyond the range of a number', () => {
    expect(priceOf(1000, U128_MAX)).toBe(1000n * U128_MAX);
  });

  it.each([
    ['negative', -1],
    ['fractional', 1.5],
    ['beyond the safe integer range', 2 ** 53],
    ['NaN', Number.NaN],
    ['infinite', Number.POSITIVE_INFINITY],
  ])('throws a RangeError for a seat count that is %s', (_kind, seats) => {
    expect(() => priceOf(seats, 180n)).toThrow(RangeError);
  });
});

describe('minBonusPerSeat', () => {
  it('gives the whole bonus to the one seat of a target of 1', () => {
    expect(minBonusPerSeat(1728n, 1)).toBe(1728n);
  });

  it('gives the whole bonus to the one seat a failed pool of target 2 can hold', () => {
    expect(minBonusPerSeat(1728n, 2)).toBe(1728n);
  });

  it('gives 9 for a bonus of 1728 and a target of 192', () => {
    expect(minBonusPerSeat(1728n, 192)).toBe(9n);
  });

  it('rounds down for a target of 191', () => {
    expect(minBonusPerSeat(1728n, 191)).toBe(9n);
  });

  it('divides by target − 1, not by target', () => {
    expect(minBonusPerSeat(1910n, 192)).toBe(10n);
  });

  it('is 0 when the bonus is smaller than target − 1', () => {
    expect(minBonusPerSeat(100n, 192)).toBe(0n);
  });

  it('is 0 for a bonus of 0', () => {
    expect(minBonusPerSeat(0n, 192)).toBe(0n);
  });
});

describe('parseAmount', () => {
  it('accepts "0"', () => {
    expect(parseAmount('0')).toBe(0n);
  });

  it('accepts digits with no leading zero', () => {
    expect(parseAmount('360')).toBe(360n);
  });

  it('keeps every digit of the largest u128', () => {
    expect(parseAmount(U128_MAX.toString())).toBe(U128_MAX);
  });

  it.each([
    ['a leading zero', '01'],
    ['a minus sign', '-1'],
    ['a plus sign', '+1'],
    ['a decimal point', '1.5'],
    ['an exponent', '1e3'],
    ['a hex prefix', '0x10'],
    ['a leading space', ' 1'],
    ['a trailing space', '1 '],
    ['a digit separator', '1_000'],
    ['no digits', ''],
  ])('rejects a string with %s', (_kind, value) => {
    expect(parseAmount(value)).toBeNull();
  });

  it.each([
    ['a number', 360],
    ['zero as a number', 0],
    ['a bigint', 360n],
    ['null', null],
    ['undefined', undefined],
    ['an object', { amount: '360' }],
  ])('rejects %s', (_kind, value) => {
    expect(parseAmount(value)).toBeNull();
  });
});
