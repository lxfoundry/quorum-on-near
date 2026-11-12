import { describe, expect, it } from 'vitest';
import { formatUnits, readTokenUnits, TokenMetadataError, tokenUnits } from '../src/token.ts';

const USDC_METADATA = {
  spec: 'ft-1.0.0',
  name: 'USDC',
  symbol: 'USDC',
  icon: null,
  reference: null,
  reference_hash: null,
  decimals: 6,
};

describe('formatUnits', () => {
  it.each([
    [180n, 6, '0.000180'],
    [10_000n, 6, '0.010000'],
    [1_234_567n, 6, '1.234567'],
    [36_288_000_000n, 6, '36288.000000'],
    [0n, 6, '0.000000'],
    [180n, 0, '180'],
    [5n, 24, '0.000000000000000000000005'],
  ])('writes %s base units with %i decimals as %s', (amount, decimals, text) => {
    expect(formatUnits(amount, decimals)).toBe(text);
  });

  it('refuses a negative amount', () => {
    expect(() => formatUnits(-1n, 6)).toThrow(RangeError);
  });
});

describe('tokenUnits', () => {
  it("reads the decimals and the symbol of a token's ft_metadata", () => {
    expect(tokenUnits(USDC_METADATA)).toEqual({ decimals: 6, symbol: 'USDC' });
  });

  it.each([
    ['is not an object', null],
    ['has no decimals', { symbol: 'USDC' }],
    ['has fractional decimals', { ...USDC_METADATA, decimals: 6.5 }],
    ['has decimals above 255, a u8', { ...USDC_METADATA, decimals: 256 }],
    ['has decimals as a string', { ...USDC_METADATA, decimals: '6' }],
    ['has an empty symbol', { ...USDC_METADATA, symbol: '' }],
    ['has a symbol with spaces', { ...USDC_METADATA, symbol: 'USD Coin' }],
    ['has a symbol over 16 characters', { ...USDC_METADATA, symbol: 'U'.repeat(17) }],
  ])('throws TokenMetadataError for metadata that %s', (_, metadata) => {
    expect(() => tokenUnits(metadata)).toThrow(TokenMetadataError);
  });

  it('accepts the symbols of bridged tokens, with a dot or a hyphen', () => {
    expect(tokenUnits({ ...USDC_METADATA, symbol: 'USDC.e' }).symbol).toBe('USDC.e');
  });
});

describe('readTokenUnits', () => {
  it("calls the token's ft_metadata view at final finality", async () => {
    const calls: unknown[] = [];
    const provider = {
      async callFunction<T>(params: unknown): Promise<T | undefined> {
        calls.push(params);
        return USDC_METADATA as T;
      },
    };
    expect(await readTokenUnits(provider, 'usdc.testnet')).toEqual({ decimals: 6, symbol: 'USDC' });
    expect(calls).toEqual([{ contractId: 'usdc.testnet', method: 'ft_metadata', args: {}, blockQuery: { finality: 'final' } }]);
  });
});
