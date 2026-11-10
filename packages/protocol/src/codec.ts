import type { Network } from './constants.ts';

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** base64(JSON.stringify(value)), standard alphabet with padding. */
export function encodeHeader(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

/** The inverse of encodeHeader. Throws on input that is not base64 of a JSON value. */
export function decodeHeader(header: string): unknown {
  const text = header.trim();
  if (text.length === 0 || text.length % 4 !== 0 || !BASE64.test(text)) {
    throw new SyntaxError('header is not base64');
  }
  return JSON.parse(Buffer.from(text, 'base64').toString('utf8'));
}

/** The decoded `X-PAYMENT` header. */
export interface PaymentPayload {
  x402Version: 1;
  scheme: 'quorum';
  network: Network;
  payload: { signedDelegate: string };
}

/** The decoded `X-PAYMENT-RESPONSE` header. */
export interface PaymentResponse {
  success: true;
  transaction: string;
  network: Network;
  payer: string;
}
