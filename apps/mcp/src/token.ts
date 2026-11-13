import type { Provider } from 'near-api-js';

/** How the token's amounts are written for people: its decimals and its symbol, from its NEP-148 ft_metadata. */
export interface TokenUnits {
  decimals: number;
  symbol: string;
}

/** The token's ft_metadata cannot be used to write its amounts. The message never quotes the metadata. */
export class TokenMetadataError extends Error {
  override name = 'TokenMetadataError';
}

/** A symbol that reads as one word: letters, digits, `.`, `_` or `-`, up to 16 of them. */
const SYMBOL = /^[A-Za-z0-9._-]{1,16}$/;
/** NEP-148 decimals are a u8. */
const MAX_DECIMALS = 255;

/**
 * `amount` base units in whole tokens, with every decimal: 180 at 6 decimals is `0.000180`. Throws
 * RangeError for a negative amount.
 */
export function formatUnits(amount: bigint, decimals: number): string {
  if (amount < 0n) throw new RangeError(`not an amount: ${amount}`);
  if (decimals === 0) return amount.toString();
  const digits = amount.toString().padStart(decimals + 1, '0');
  return `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`;
}

/**
 * The decimals and the symbol of an ft_metadata result. Throws TokenMetadataError unless the decimals
 * are an integer from 0 to 255 and the symbol is 1 to 16 letters, digits, `.`, `_` or `-`; a symbol is
 * shown to the agent next to every amount, so it is never free text.
 */
export function tokenUnits(metadata: unknown): TokenUnits {
  if (typeof metadata !== 'object' || metadata === null) throw new TokenMetadataError('ft_metadata is not an object');
  const { decimals, symbol } = metadata as Record<string, unknown>;
  if (typeof decimals !== 'number' || !Number.isInteger(decimals) || decimals < 0 || decimals > MAX_DECIMALS) {
    throw new TokenMetadataError(`ft_metadata.decimals is not an integer from 0 to ${MAX_DECIMALS}`);
  }
  if (typeof symbol !== 'string' || !SYMBOL.test(symbol)) {
    throw new TokenMetadataError('ft_metadata.symbol is not 1 to 16 letters, digits, ".", "_" or "-"');
  }
  return { decimals, symbol };
}

/** Reads the token's units from its `ft_metadata` view, at final finality (see tokenUnits). */
export async function readTokenUnits(provider: Pick<Provider, 'callFunction'>, token: string): Promise<TokenUnits> {
  const metadata = await provider.callFunction({
    contractId: token,
    method: 'ft_metadata',
    args: {},
    blockQuery: { finality: 'final' },
  });
  return tokenUnits(metadata);
}
