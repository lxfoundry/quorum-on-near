import { parseAmount, poolsEvents } from '@quorum-on-near/protocol';
import type { QuorumEvent } from '@quorum-on-near/protocol';
import type { TxOutcome } from './chain.ts';

export { poolsEvents, toTxOutcome } from '@quorum-on-near/protocol';

type SeatsCommitted = Extract<QuorumEvent, { event: 'seats_committed' }>;

/** What a relayed commit did. */
export interface CommitResult {
  /** The delegate action itself failed (for example a used nonce), so nothing was attempted. */
  delegateFailed: boolean;
  /** Seats taken by this payment: 0 when the contract took none. */
  seats: number;
  amount: bigint;
  /** The pool's seats taken after this commit, from the event; null when no seats were taken. */
  taken: number | null;
  target: number | null;
  /** This commit filled the pool. */
  filled: boolean;
}

/**
 * Reads a relayed commit's outcome. The seats come from the pools contract's `seats_committed`
 * event for this buyer and pool, and `filled` from its `pool_filled` event. A failed receipt executed
 * by the buyer's account means the delegate action failed.
 */
export function readCommit(
  outcome: TxOutcome,
  query: { poolsContract: string; buyer: string; poolId: number },
): CommitResult {
  const { poolsContract, buyer, poolId } = query;
  const delegateFailed = outcome.receipts.some((receipt) => receipt.failed && receipt.executorId === buyer);
  const events = poolsEvents(outcome, poolsContract);
  const commit = events.find(
    (event): event is SeatsCommitted =>
      event.event === 'seats_committed' && event.data.buyer === buyer && event.data.pool_id === poolId,
  );
  if (commit === undefined) {
    return { delegateFailed, seats: 0, amount: 0n, taken: null, target: null, filled: false };
  }
  const { seats, amount, taken, target } = commit.data;
  const paid = parseAmount(amount);
  if (paid === null || ![seats, taken, target].every(Number.isSafeInteger)) {
    throw new TypeError(`malformed seats_committed event: ${JSON.stringify(commit.data)}`);
  }
  const filled =
    taken === target || events.some((event) => event.event === 'pool_filled' && event.data.pool_id === poolId);
  return { delegateFailed, seats, amount: paid, taken, target, filled };
}
