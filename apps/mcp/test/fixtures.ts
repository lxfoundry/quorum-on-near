import type {
  BuyerPaymentAnswer,
  PaymentAnswer,
  PoolListing,
  SignedPayment,
} from '@quorum-on-near/buyer';
import { buildOffer, type Offer, type OfferContext, type PoolView } from '@quorum-on-near/protocol';
import { baseEncode } from 'near-api-js';

/** The accounts, the pool, the gateway answers and the stubbed buyer the MCP tests share. */

export const PARENT = 'parent.testnet';
export const BUYER = `buyer-llm.${PARENT}`;
export const POOLS = `pools.${PARENT}`;
export const TOKEN = 'usdc.testnet';
export const POOL_ID = 7;
/** 2027-01-15T08:00:00.000Z. */
export const DEADLINE_MS = 1_800_000_000_000;
export const TERMS = '8×GPU × 24 h; 1 seat = 1 GPU-hour; prices at 1/10,000 scale';

/** A pool of the gateway's provider: 180 per seat, 148 of 192 seats taken, a bonus of 1728, at most 24 per buyer. */
export const POOL: PoolView = {
  id: POOL_ID,
  seller: `provider.${PARENT}`,
  seat_price: '180',
  target: 192,
  taken: 148,
  deadline_ms: DEADLINE_MS,
  bonus: '1728',
  max_seats_per_buyer: 24,
  terms: TERMS,
  status: 'open',
  bonus_per_seat: '0',
  refund_cursor: 0,
  dust_sent: false,
  buyer_count: 30,
};

/** POOL as GatewayClient lists it: the least bonus per seat is floor(1728 / 191) = 9. */
export const LISTING: PoolListing = {
  id: POOL_ID,
  terms: TERMS,
  seat_price: 180n,
  target: 192,
  taken: 148,
  deadline_ms: DEADLINE_MS,
  bonus: 1728n,
  min_bonus_per_seat: 9n,
};

/** What the stubbed gateway is configured with. */
export const CONTEXT: OfferContext = {
  network: 'near:testnet',
  gatewayUrl: 'http://localhost:8402',
  poolsContract: POOLS,
  token: TOKEN,
  relayer: `relay.${PARENT}`,
  minGas: 50_000_000_000_000n,
  maxGas: 100_000_000_000_000n,
  maxTimeoutSeconds: 120,
};

/** The gateway's offer for `seats` seats of `pool`, built as the gateway builds it. */
export function offerFor(seats: number, pool: PoolView = POOL, context: OfferContext = CONTEXT): Offer {
  return buildOffer(pool, seats, context);
}

/** A transaction hash: base58 of 32 bytes. */
export const TX_HASH = baseEncode(new Uint8Array(32).fill(7));

/** A compact JWS, as the gateway's credentials are. */
export const CREDENTIAL = 'eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJidXllci1sbG0ifQ.c2lnbmF0dXJl';

/** What the stubbed buyer signed for each payment: 120 blocks of expiry past the final height. */
export const SIGNED: SignedPayment = { nonce: 1_001n, finalHeight: 245_000_100n, maxBlockHeight: 245_000_220n };

/** The gateway's `answer` as Buyer.pay returns it, with the payment it answers. */
export function signed(answer: PaymentAnswer): BuyerPaymentAnswer {
  return { ...answer, signed: SIGNED };
}

/** The 202 answer to a payment that took `seats` seats of POOL. */
export function pending(seats: number): BuyerPaymentAnswer {
  return signed({
    kind: 'pending',
    txHash: TX_HASH,
    poolId: POOL_ID,
    buyer: BUYER,
    seats,
    taken: 148 + seats,
    target: 192,
    deadlineMs: DEADLINE_MS,
  });
}

/** The 200 answer to a payment that filled POOL, the buyer then holding `seats` seats. */
export function filled(seats: number): BuyerPaymentAnswer {
  return signed({ kind: 'filled', txHash: TX_HASH, credential: CREDENTIAL, poolId: POOL_ID, seats, terms: TERMS });
}

/** 90.5 seconds before the pool's deadline. */
export const NOW_MS = DEADLINE_MS - 90_500;
export const CAP = 10_000n;

/** The RPC URL the tools are configured with: it carries an API key, so no text may quote it. */
export const RPC_URL = 'https://rpc.example.org/?apiKey=TEST-RPC-KEY';
