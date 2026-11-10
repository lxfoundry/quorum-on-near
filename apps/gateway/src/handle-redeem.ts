import { checkRedeemProof, priceOf, type BuyerState, type BuyerView, type PoolView } from '@quorum-on-near/protocol';
import type { Deps } from './deps.ts';
import { servedPool } from './pools.ts';
import { reply, type Reply } from './reply.ts';

/** The refund status a buyer of an expired pool sees, by the buyer's state on the contract. */
const REFUND_STATUS: Record<BuyerState, 'refund_pending' | 'refunded' | 'claimable'> = {
  committed: 'refund_pending',
  refunded: 'refunded',
  claimable: 'claimable',
};

/**
 * `GET /pools/:id/access` with an `X-QUORUM-PROOF` header (spec section 6.5): checks the proof, its
 * key and its nonce, then answers from the buyer's seats and the pool's status.
 * - 404 `{error: "unknown_pool"}` if the pool does not exist or is another seller's.
 * - 401 `{error: code}` for a proof that fails checkRedeemProof, `not_full_access` if its key is not
 *   a full-access key of the account, `replayed_proof` if a proof with the same key and nonce was
 *   seen, under any account.
 * - 404 `{error: "no_seats"}` if the account holds no seats in the pool.
 * - 202 pending, 200 with a credential, or 410 with the refund, by pool status.
 * - 503 `{error: "chain_unavailable"}` if anything throws: a chain read, or the work after it, such as
 *   signing the credential. The error is logged, since the reply names only the likeliest cause.
 */
export async function handleRedeem(deps: Deps, poolId: number, header: string): Promise<Reply> {
  const { config, chain, proofNonces } = deps;
  try {
    const pool = await servedPool(chain, config.provider, poolId);
    if (pool === null) return reply(404, { error: 'unknown_pool' });

    const nowMs = deps.now();
    const proof = checkRedeemProof(header, { poolId, recipient: new URL(config.publicUrl).host, nowMs });
    if (!proof.ok) return reply(401, { error: proof.code });
    const key = await chain.accessKey(proof.accountId, proof.publicKey);
    if (key === null || !key.fullAccess) return reply(401, { error: 'not_full_access' });
    // NEP-413 signs the nonce but not the account, so the same proof verifies under every account
    // that holds the key: the replay key is the key and the nonce.
    if (proofNonces.seen(`${proof.publicKey}:${proof.nonceKey}`, nowMs)) return reply(401, { error: 'replayed_proof' });

    const holding = await chain.getBuyer(poolId, proof.accountId);
    if (holding === null || holding.seats === 0) return reply(404, { error: 'no_seats' });
    return await holdingReply(deps, pool, proof.accountId, holding);
  } catch (error) {
    console.error('could not check or answer a redemption:', error);
    return reply(503, { error: 'chain_unavailable' });
  }
}

/** The answer for a buyer holding seats, by the pool's status. */
async function holdingReply(deps: Deps, pool: PoolView, buyer: string, holding: BuyerView): Promise<Reply> {
  const { seats } = holding;
  switch (pool.status) {
    case 'open':
      return reply(202, { status: 'pending', seats, taken: pool.taken, target: pool.target, deadlineMs: pool.deadline_ms });
    case 'filled':
    case 'settled': {
      const credential = await deps.credentials.issue({ buyer, poolId: pool.id, seats, terms: pool.terms });
      return reply(200, { status: 'filled', credential, poolId: pool.id, seats, terms: pool.terms });
    }
    case 'expired':
    case 'refunded': {
      const bonusPerSeat = BigInt(pool.bonus_per_seat);
      return reply(410, {
        status: REFUND_STATUS[holding.state],
        amount: priceOf(seats, BigInt(pool.seat_price) + bonusPerSeat).toString(),
        bonusShare: priceOf(seats, bonusPerSeat).toString(),
        // A refund the buyer claimed itself is not in the feed.
        txHash: deps.activity.lastRefund(pool.id, buyer)?.txHash ?? null,
      });
    }
  }
}
