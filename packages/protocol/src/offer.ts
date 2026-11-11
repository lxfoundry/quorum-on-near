import { minBonusPerSeat, priceOf } from './amounts.ts';
import type { Network } from './constants.ts';
import type { PoolView } from './contract.ts';

export interface OfferExtra {
  poolId: number;
  seats: number;
  seatPrice: string;
  target: number;
  taken: number;
  deadlineMs: number;
  bonus: string;
  minBonusPerSeat: string;
  terms: string;
  relayer: string;
  minGas: string;
  maxGas: string;
}

/** One entry of `accepts` in a 402 body. */
export interface Offer {
  scheme: 'quorum';
  network: Network;
  maxAmountRequired: string;
  resource: string;
  description: string;
  mimeType: 'application/json';
  payTo: string;
  maxTimeoutSeconds: number;
  asset: string;
  extra: OfferExtra;
}

/** The 402 response body. */
export interface PaymentRequired {
  x402Version: 1;
  error: string;
  accepts: Offer[];
}

/** What the gateway knows about itself when it builds an offer. */
export interface OfferContext {
  network: Network;
  /** The gateway's public base URL, without a trailing slash. */
  gatewayUrl: string;
  poolsContract: string;
  token: string;
  relayer: string;
  minGas: bigint;
  maxGas: bigint;
  maxTimeoutSeconds: number;
}

/**
 * The seats an offer is made for: `min(requested, target − taken, max_seats_per_buyer)`, or 0 when
 * none can be offered. `requested` must be a positive safe integer (RangeError otherwise).
 */
export function offerSeats(pool: PoolView, requested: number): number {
  if (!Number.isSafeInteger(requested) || requested < 1) {
    throw new RangeError(`invalid seat count: ${requested}`);
  }
  const left = Math.max(pool.target - pool.taken, 0);
  const cap = pool.max_seats_per_buyer ?? Number.MAX_SAFE_INTEGER;
  return Math.min(requested, left, cap);
}

/**
 * Builds the offer for `seats` seats of `pool` (the caller has already applied offerSeats).
 * `resource` is `${gatewayUrl}/pools/${id}/access?seats=${seats}`, and `description` is
 * "1 seat in pool 7: <terms>" or "2 seats in pool 7: <terms>".
 */
export function buildOffer(pool: PoolView, seats: number, ctx: OfferContext): Offer {
  const seatPrice = BigInt(pool.seat_price);
  const bonus = BigInt(pool.bonus);
  return {
    scheme: 'quorum',
    network: ctx.network,
    maxAmountRequired: priceOf(seats, seatPrice).toString(),
    resource: `${ctx.gatewayUrl}/pools/${pool.id}/access?seats=${seats}`,
    description: `${seats} ${seats === 1 ? 'seat' : 'seats'} in pool ${pool.id}: ${pool.terms}`,
    mimeType: 'application/json',
    payTo: ctx.poolsContract,
    maxTimeoutSeconds: ctx.maxTimeoutSeconds,
    asset: ctx.token,
    extra: {
      poolId: pool.id,
      seats,
      seatPrice: pool.seat_price,
      target: pool.target,
      taken: pool.taken,
      deadlineMs: pool.deadline_ms,
      bonus: pool.bonus,
      minBonusPerSeat: minBonusPerSeat(bonus, pool.target).toString(),
      terms: pool.terms,
      relayer: ctx.relayer,
      minGas: ctx.minGas.toString(),
      maxGas: ctx.maxGas.toString(),
    },
  };
}

/** `{x402Version: 1, error, accepts}`; `error` defaults to `"payment required"`. */
export function paymentRequired(accepts: Offer[], error = 'payment required'): PaymentRequired {
  return { x402Version: 1, error, accepts };
}
