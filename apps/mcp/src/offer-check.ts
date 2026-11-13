import { minBonusPerSeat, parseAmount, type Offer, type PoolView } from '@quorum-on-near/protocol';

/**
 * The check of a gateway's offer against the pool on chain. The gateway is the seller's: what an
 * offer's `extra` says of the pool is its word, while the pools contract's view is what a commit and a
 * refund are checked against. Both quorum_offer and quorum_commit make this check before anything is
 * signed.
 */

/** Why quorum_commit would not pay an offer: a code, and a detail that quotes no value of the offer. */
export interface Refusal {
  code: string;
  detail: string;
}

/**
 * Refuses an offer for `pool`, as the pools contract holds it: `offer_mismatch` when the offer
 * misstates a fact of the pool (see offerMismatch), then `pool_closed` when the pool is not open or
 * has no seat left on chain. Null when the offer may be paid as far as the pool is concerned.
 */
export function poolRefusal(offer: Offer, pool: PoolView): Refusal | null {
  const mismatch = offerMismatch(offer, pool);
  if (mismatch !== null) return { code: 'offer_mismatch', detail: mismatch };
  if (pool.status !== 'open') return { code: 'pool_closed', detail: `pool ${pool.id} is ${pool.status} on chain` };
  if (pool.taken >= pool.target) return { code: 'pool_closed', detail: `pool ${pool.id} has no seat left on chain` };
  return null;
}

/**
 * The first fact of `pool` that the gateway's `offer` misstates, as a refusal's detail, or null when
 * it states each one it carries as the chain holds it. Only the facts fixed when the pool opened are
 * compared, in this order: the seat price, the target, the deadline, the bonus, the terms, and the
 * least bonus per seat they give (the protocol's minBonusPerSeat, the formula the gateway uses). The
 * seats taken and the status move between the gateway's read and this one, so an honest offer can
 * differ there: they are never compared. Never throws, whatever the offer's values.
 */
export function offerMismatch(offer: Offer, pool: PoolView): string | null {
  const { extra } = offer;
  if (typeof extra !== 'object' || extra === null) return 'the offer carries no pool facts';
  const bonus = parseAmount(pool.bonus);
  const facts: [name: string, same: boolean][] = [
    ['seat price', sameAmount(extra.seatPrice, pool.seat_price)],
    ['target', extra.target === pool.target],
    ['deadline', extra.deadlineMs === pool.deadline_ms],
    ['bonus', sameAmount(extra.bonus, pool.bonus)],
    ['terms', extra.terms === pool.terms],
    ['minimum bonus per seat', bonus !== null && parseAmount(extra.minBonusPerSeat) === minBonusPerSeat(bonus, pool.target)],
  ];
  const differs = facts.find(([, same]) => !same);
  return differs === undefined ? null : `the offer's ${differs[0]} is not the pool's on chain`;
}

/** Whether `offered` is a decimal amount equal to the chain's `held`. */
function sameAmount(offered: unknown, held: string): boolean {
  const value = parseAmount(offered);
  return value !== null && value === parseAmount(held);
}
