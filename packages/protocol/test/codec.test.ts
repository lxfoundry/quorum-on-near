import { describe, expect, it } from 'vitest';
import { decodeHeader, encodeHeader, type PaymentPayload, type PaymentResponse } from '../src/codec.ts';

const PAYMENT: PaymentPayload = {
  x402Version: 1,
  scheme: 'quorum',
  network: 'near:testnet',
  payload: { signedDelegate: 'AAECAwQFBgcICQ==' },
};

const RESPONSE: PaymentResponse = {
  success: true,
  transaction: '6zgh2u9DqHHiXzdy9ouTP7oGky2T4nugqzqt9wJZwNFm',
  network: 'near:testnet',
  payer: 'buyer-01.parent.testnet',
};

describe('encodeHeader', () => {
  it('writes base64 of the JSON text, with padding', () => {
    expect(encodeHeader({ a: 1 })).toBe('eyJhIjoxfQ==');
  });

  it('encodes text as UTF-8', () => {
    expect(Buffer.from(encodeHeader('×'), 'base64').toString('utf8')).toBe('"×"');
  });
});

describe('decodeHeader', () => {
  it('round-trips a payment payload', () => {
    expect(decodeHeader(encodeHeader(PAYMENT))).toStrictEqual(PAYMENT);
  });

  it('round-trips a payment response', () => {
    expect(decodeHeader(encodeHeader(RESPONSE))).toStrictEqual(RESPONSE);
  });

  it('round-trips text outside ASCII', () => {
    const value = { terms: '8×GPU × 24 h; 1 seat = 1 GPU-hour; prices at 1/10,000 scale' };
    expect(decodeHeader(encodeHeader(value))).toStrictEqual(value);
  });

  it('ignores whitespace around the header value', () => {
    expect(decodeHeader(` ${encodeHeader(PAYMENT)}\t`)).toStrictEqual(PAYMENT);
  });

  // Node's own base64 decoder would turn most of these into valid JSON: decodeHeader must refuse them first.
  it.each([
    ['an empty value', ''],
    ['only whitespace', '   '],
    ['characters outside the base64 alphabet', 'eyJh****IjoxfQ=='],
    ['the URL-safe alphabet', 'eyJrIjoifn5-Pz8_In0='],
    ['whitespace inside the value', 'eyJh    IjoxfQ=='],
    ['missing padding', 'eyJhIjoxfQ'],
    ['data after the padding', 'eyJhIjoxfQ==AAAA'],
    ['three padding characters', 'eyJhIjoxf==='],
    ['the JSON text itself', '{"a":1}'],
  ])('rejects %s as not base64', (_kind, header) => {
    expect(() => decodeHeader(header)).toThrow(new SyntaxError('header is not base64'));
  });

  it('rejects base64 of text that is not JSON', () => {
    expect(() => decodeHeader(Buffer.from('not json', 'utf8').toString('base64'))).toThrow(SyntaxError);
  });
});
