import { randomBytes } from 'node:crypto';
import { buildOffer, encodeHeader, type Offer, type OfferContext, type PaymentResponse, type PoolView } from '@quorum-on-near/protocol';
import { baseEncode } from 'near-api-js';

/**
 * The gateway's HTTP side as the buyer tests stub it: a recording fetch, JSON responses, and the
 * values its answers carry (offers built with the protocol's own builder, transaction hashes, a
 * credential).
 */

export const GATEWAY_URL = 'http://localhost:8402';
export const PARENT = 'parent.testnet';
export const POOLS = `pools.${PARENT}`;
export const TOKEN = 'usdc.testnet';
export const BUYER = `buyer-01.${PARENT}`;
export const POOL_ID = 7;

/** A pool of the gateway's provider: 180 per seat, 148 of 192 seats taken, at most 24 per buyer. */
export const POOL: PoolView = {
  id: POOL_ID,
  seller: `provider.${PARENT}`,
  seat_price: '180',
  target: 192,
  taken: 148,
  deadline_ms: 1_800_000_600_000,
  bonus: '1728',
  max_seats_per_buyer: 24,
  terms: '8×GPU × 24 h; 1 seat = 1 GPU-hour; prices at 1/10,000 scale',
  status: 'open',
  bonus_per_seat: '0',
  refund_cursor: 0,
  dust_sent: false,
  buyer_count: 30,
};

/** What the stubbed gateway is configured with. */
export const CONTEXT: OfferContext = {
  network: 'near:testnet',
  gatewayUrl: GATEWAY_URL,
  poolsContract: POOLS,
  token: TOKEN,
  relayer: `relay.${PARENT}`,
  minGas: 50_000_000_000_000n,
  maxGas: 100_000_000_000_000n,
  maxTimeoutSeconds: 120,
};

/** The gateway's offer for `seats` seats of POOL. */
export function offerFor(seats: number): Offer {
  return buildOffer(POOL, seats, CONTEXT);
}

/** A transaction hash: base58 of 32 random bytes. */
export function txHash(): string {
  return baseEncode(randomBytes(32));
}

/** A compact JWS, as the gateway's credentials are. */
export const CREDENTIAL = 'eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJidXllci0wMS5wYXJlbnQudGVzdG5ldCJ9.c2lnbmF0dXJl';

/** The `X-PAYMENT-RESPONSE` header of a relayed payment. */
export function paymentResponseHeader(transaction: string, payer = BUYER): Record<string, string> {
  const response: PaymentResponse = { success: true, transaction, network: 'near:testnet', payer };
  return { 'X-PAYMENT-RESPONSE': encodeHeader(response) };
}

/** A response with `body` as JSON. */
export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

/** A fetch that records each request, then answers it with `handler`. */
export function stubFetch(handler: (request: Request) => Response | Promise<Response>): {
  fetch: typeof fetch;
  requests: Request[];
} {
  const requests: Request[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    requests.push(request);
    return handler(request);
  };
  return { fetch, requests };
}
