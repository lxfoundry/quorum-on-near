import { buildOffer, offerSeats, paymentRequired } from '@quorum-on-near/protocol';
import type { Offer, OfferContext, PoolView } from '@quorum-on-near/protocol';
import type { GatewayConfig } from './config.ts';
import type { Deps } from './deps.ts';
import { servedPool } from './pools.ts';
import { reply, type Reply } from './reply.ts';

/** The most seats one request may ask for: the contract's largest target. */
export const MAX_SEATS_PER_REQUEST = 1000;

const SEATS = /^[1-9][0-9]*$/;

/** The `seats` query parameter: absent means 1; otherwise `^[1-9][0-9]*$` and at most 1000. Null if invalid. */
export function parseSeats(param: string | undefined): number | null {
  if (param === undefined) return 1;
  if (!SEATS.test(param)) return null;
  const seats = Number(param);
  return seats <= MAX_SEATS_PER_REQUEST ? seats : null;
}

/** The OfferContext for this gateway's configuration. */
export function offerContext(config: GatewayConfig): OfferContext {
  return {
    network: config.network,
    gatewayUrl: config.publicUrl,
    poolsContract: config.poolsContract,
    token: config.token,
    relayer: config.relayer,
    minGas: config.minGas,
    maxGas: config.maxGas,
    maxTimeoutSeconds: config.maxTimeoutSeconds,
  };
}

/**
 * The offer to attach to a reply: one offer for the seats that can be offered, or none if the pool
 * is not open or full. A buyer known to hold `held` seats is offered at most
 * `max_seats_per_buyer − held`, and nothing once it is at the limit.
 */
export function currentAccepts(pool: PoolView, seats: number, config: GatewayConfig, held = 0): Offer[] {
  if (pool.status !== 'open') return [];
  const room = pool.max_seats_per_buyer === null ? seats : pool.max_seats_per_buyer - held;
  const offered = Math.min(offerSeats(pool, seats), room);
  return offered > 0 ? [buildOffer(pool, offered, offerContext(config))] : [];
}

/**
 * `GET /pools/:id/access?seats=N` with no payment or proof header: the 402 offer.
 * - 400 `{error: "invalid_seats"}` unless `seats` is valid (parseSeats).
 * - 404 `{error: "unknown_pool"}` if the pool does not exist or is another seller's.
 * - 410 `{error: "pool_expired", status}` if it is expired or refunded.
 * - 409 `{error: "pool_closed", status}` if it is filled, settled, or open with no seat left.
 * - otherwise 402 with paymentRequired(currentAccepts(...)).
 * - 503 `{error: "chain_unavailable"}` if the chain cannot be read.
 */
export async function handleOffer(deps: Deps, poolId: number, seatsParam: string | undefined): Promise<Reply> {
  const seats = parseSeats(seatsParam);
  if (seats === null) return reply(400, { error: 'invalid_seats' });
  let pool: PoolView | null;
  try {
    pool = await servedPool(deps.chain, deps.config.provider, poolId);
  } catch {
    return reply(503, { error: 'chain_unavailable' });
  }
  if (pool === null) return reply(404, { error: 'unknown_pool' });
  if (pool.status === 'expired' || pool.status === 'refunded') {
    return reply(410, { error: 'pool_expired', status: pool.status });
  }
  const accepts = currentAccepts(pool, seats, deps.config);
  if (accepts.length === 0) return reply(409, { error: 'pool_closed', status: pool.status });
  return reply(402, paymentRequired(accepts));
}
