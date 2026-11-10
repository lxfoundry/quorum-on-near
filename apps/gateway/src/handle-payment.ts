import { PAYMENT_RESPONSE_HEADER, checkPaymentHeader, encodeHeader, paymentRequired } from '@quorum-on-near/protocol';
import type {
  CheckedPayment,
  GatewayErrorCode,
  PaymentErrorCode,
  PaymentResponse,
  PoolView,
} from '@quorum-on-near/protocol';
import type { ActivityRecord } from './activity.ts';
import { DelegateExpiredError, EXPIRY_MARGIN_BLOCKS, type BlockInfo, type RelayResult, type TxOutcome } from './chain.ts';
import type { Deps } from './deps.ts';
import { currentAccepts, parseSeats } from './handle-offer.ts';
import { readCommit } from './outcome.ts';
import { servedPool } from './pools.ts';
import { reply, type Reply } from './reply.ts';


/**
 * NEAR refuses a delegate whose nonce is at or above the block height times this without storing
 * the nonce, so the same payment could otherwise be relayed again and again.
 */
const NONCE_RANGE_MULTIPLIER = 1_000_000n;

/** A refusal carries the buyer's seats once they are known, so that its offer can respect the buyer's limit. */
type ChainCheck = { ok: true; held: number } | { ok: false; code: GatewayErrorCode; held?: number };

/** Checks 4 and 5 passed, with the final block they were judged against. */
type FreshCheck = { ok: true; block: BlockInfo } | { ok: false; code: GatewayErrorCode };

/**
 * `GET /pools/:id/access?seats=N` with an `X-PAYMENT` header (spec sections 6.3 and 6.4): the
 * checks in order, then the relay, then the response table. The payment may commit to fewer seats
 * than `seats` (a reduced offer paid at the URL first requested), never to more.
 * - 400 `{error: "invalid_seats"}` and 404 `{error: "unknown_pool"}` as for the offer.
 * - 402 paymentRequired(current offer, code) for a failed check, a payment already in flight for
 *   the buyer, or a delegate the relayer finds too close to its expiry to send (`expired`). Nothing
 *   is relayed. The `over_buyer_cap` offer is for the seats the buyer may still take, if any.
 *   A payment takes its buyer's in-flight slot only once it has passed checks 4 and 5 (its key is a
 *   full-access key of the buyer's account, its nonce is above that key's, and its max_block_height
 *   is within the accepted window), so neither a payment signed with another key nor a replay of a
 *   used or expired payment can hold the slot.
 *   A payment whose result is unknown keeps its buyer in flight, while its delegate may still land,
 *   until a final block above its `max_block_height` is read.
 * - 202 `{status: "pending", receipt, pool}` or, when the commit filled the pool, 200 `{status:
 *   "filled", credential, poolId, seats, terms}`; both carry `X-PAYMENT-RESPONSE`.
 * - When no seats were taken: 410 `{error: "pool_expired", poolId, txHash}` if the pool is past its
 *   deadline (its view says Expired or Refunded, or says Open while the latest final block's time is
 *   at or past the deadline); 502 `{error: "relay_failed", txHash}` if the transfer never reached the
 *   pools contract or the pool is still Open with a seat left; otherwise (the pool filled) 409
 *   `{x402Version: 1, error: "no_seats_taken", accepts: []}`.
 * - 502 `{error: "relay_failed" | "result_unknown", txHash}` when the relay was refused, the delegate
 *   failed, or the result is unknown or cannot be read.
 * - 503 `{error: "chain_unavailable"}` when the chain cannot be read before the relay.
 *
 * A failure to append to the activity feed, and the error behind a 503 or a `result_unknown` reply
 * that follows a relay, are logged; none changes the reply.
 */
export async function handlePayment(
  deps: Deps,
  poolId: number,
  seatsParam: string | undefined,
  header: string,
): Promise<Reply> {
  const seats = parseSeats(seatsParam);
  if (seats === null) return reply(400, { error: 'invalid_seats' });
  try {
    return await checkAndRelay(deps, poolId, seats, header);
  } catch (error) {
    // A chain read failed, or relayDelegate threw before sending anything.
    console.error('could not check or relay a payment:', error);
    return reply(503, { error: 'chain_unavailable' });
  }
}

async function checkAndRelay(deps: Deps, poolId: number, seats: number, header: string): Promise<Reply> {
  const { config, chain, inFlight } = deps;
  const pool = await servedPool(chain, config.provider, poolId);
  if (pool === null) return reply(404, { error: 'unknown_pool' });
  // Every refused payment gets the offer as it stands.
  const refuse = (code: PaymentErrorCode, held?: number): Reply =>
    reply(402, paymentRequired(currentAccepts(pool, seats, config, held), code));

  const checked = checkPaymentHeader(header, {
    network: config.network,
    token: config.token,
    poolsContract: config.poolsContract,
    poolId,
    maxSeats: seats,
    seatPrice: BigInt(pool.seat_price),
    minGas: config.minGas,
    maxGas: config.maxGas,
  });
  if (!checked.ok) return refuse(checked.code);
  const { payment } = checked;

  const fresh = await checkFresh(deps, payment);
  if (!fresh.ok) return refuse(fresh.code);
  if (!inFlight.begin(payment.senderId)) return refuse('payment_in_flight');
  try {
    const check = await checkOnChain(deps, pool, payment, fresh.block);
    if (!check.ok) return refuse(check.code, check.held);
    let result: RelayResult;
    try {
      result = await deps.writer.relayDelegate(payment.signedDelegate, payment.maxBlockHeight);
    } catch (error) {
      // Nothing was sent. Any other error answers 503 like a failed read.
      if (error instanceof DelegateExpiredError) return refuse('expired', check.held);
      throw error;
    }
    return await answerRelay(deps, pool, payment, check.held, result);
  } finally {
    inFlight.end(payment.senderId);
  }
}

/**
 * Checks 4 and 5, before the buyer's in-flight slot is taken: the key is a full-access key of the
 * buyer's account, the nonce is above the key's and below the final height × 10^6, and
 * `max_block_height` is within the accepted window. The checks before these verify the signature only
 * against the delegate's own key; these are the ones that only the buyer's own fresh payment passes.
 * Check 4 ties that key to sender_id, and a used or expired payment, which anyone can copy from the
 * chain, fails check 5. So neither a payment signed with another key nor a replay holds the buyer's
 * slot. The later checks use the final block read here.
 */
async function checkFresh(deps: Deps, payment: CheckedPayment): Promise<FreshCheck> {
  const { chain, config, inFlight } = deps;
  const refused = (code: GatewayErrorCode): FreshCheck => ({ ok: false, code });

  const key = await chain.accessKey(payment.senderId, payment.publicKey);
  if (key === null || !key.fullAccess) return refused('not_full_access');
  if (payment.nonce <= key.nonce) return refused('stale_nonce');
  const block = await chain.finalBlock();
  // Frees each held buyer whose payment can no longer execute (this one too), so holds do not pile up.
  inFlight.passed(block.height);
  if (payment.nonce >= block.height * NONCE_RANGE_MULTIPLIER) return refused('nonce_too_large');
  const maxAhead = BigInt(Math.ceil((config.maxTimeoutSeconds * 1000) / config.blockTimeMs));
  const ahead = payment.maxBlockHeight - block.height;
  if (ahead <= EXPIRY_MARGIN_BLOCKS || ahead > maxAhead + EXPIRY_MARGIN_BLOCKS) return refused('expired');
  return { ok: true, block };
}

/**
 * Checks 6 to 8 once the buyer's slot is taken: the pool, judged against `block` (the final block
 * checkFresh read), the balance and the buyer's seats. The key and its nonce are checked again first:
 * an earlier payment of the buyer may have finished since checkFresh read the key.
 */
async function checkOnChain(
  deps: Deps,
  pool: PoolView,
  payment: CheckedPayment,
  block: BlockInfo,
): Promise<ChainCheck> {
  const { chain } = deps;
  const buyer = payment.senderId;
  const refused = (code: GatewayErrorCode): ChainCheck => ({ ok: false, code });

  const key = await chain.accessKey(buyer, payment.publicKey);
  if (key === null || !key.fullAccess) return refused('not_full_access');
  if (payment.nonce <= key.nonce) return refused('stale_nonce');
  if (pool.status !== 'open' || pool.taken >= pool.target || block.timestampMs >= pool.deadline_ms) {
    return refused('pool_closed');
  }
  if ((await chain.ftBalanceOf(buyer)) < payment.amount) return refused('insufficient_balance');
  // The contract refuses both of these, so relaying them would only cost the relayer gas.
  if (buyer === pool.seller) return refused('seller_commit');
  const held = (await chain.getBuyer(pool.id, buyer))?.seats ?? 0;
  if (pool.max_seats_per_buyer !== null && held + payment.seats > pool.max_seats_per_buyer) {
    return { ok: false, code: 'over_buyer_cap', held };
  }
  return { ok: true, held };
}

/** The response to a relay. `held` is the seats the buyer held before this payment. */
async function answerRelay(
  deps: Deps,
  pool: PoolView,
  payment: CheckedPayment,
  held: number,
  result: RelayResult,
): Promise<Reply> {
  if (result.kind === 'rejected') return reply(502, { error: 'relay_failed', txHash: result.txHash });
  if (result.kind === 'unknown') {
    // The delegate may still land: the buyer stays in flight until it no longer can.
    if (!result.expired) deps.inFlight.hold(payment.senderId, payment.maxBlockHeight);
    return reply(502, { error: 'result_unknown', txHash: result.txHash });
  }
  try {
    return await answerCommit(deps, pool, payment, held, result.outcome);
  } catch (error) {
    // The transaction ran, so the payment may have landed: the buyer finds out through redemption.
    const { txHash } = result.outcome;
    console.error(`could not answer the payment of transaction ${txHash}:`, error);
    return reply(502, { error: 'result_unknown', txHash });
  }
}

async function answerCommit(
  deps: Deps,
  pool: PoolView,
  payment: CheckedPayment,
  held: number,
  outcome: TxOutcome,
): Promise<Reply> {
  const { config } = deps;
  const buyer = payment.senderId;
  const { txHash } = outcome;
  const commit = readCommit(outcome, { poolsContract: config.poolsContract, buyer, poolId: pool.id });

  // A failed delegate is recorded too (0 seats, not ok): its transaction ran and has a link.
  await appendActivity(deps, {
    at: deps.now(),
    poolId: pool.id,
    kind: 'commit',
    account: buyer,
    seats: commit.seats,
    amount: commit.amount.toString(),
    txHash,
    ok: commit.seats > 0,
  });
  if (commit.delegateFailed) return reply(502, { error: 'relay_failed', txHash });
  if (commit.seats === 0) return await answerNoSeats(deps, pool.id, outcome);

  const response: PaymentResponse = { success: true, transaction: txHash, network: config.network, payer: buyer };
  const headers = { [PAYMENT_RESPONSE_HEADER]: encodeHeader(response) };
  if (commit.filled) {
    const seats = held + commit.seats;
    const credential = await deps.credentials.issue({ buyer, poolId: pool.id, seats, terms: pool.terms });
    return reply(200, { status: 'filled', credential, poolId: pool.id, seats, terms: pool.terms }, headers);
  }
  return reply(
    202,
    {
      status: 'pending',
      receipt: { poolId: pool.id, buyer, seats: commit.seats, txHash },
      pool: { taken: commit.taken, target: commit.target, deadlineMs: pool.deadline_ms },
    },
    headers,
  );
}

/**
 * A commit that took no seats, so the token has returned the payment. The contract takes
 * `min(seats, target − taken)` seats of an Open pool before its deadline, so a payment lost a race
 * only if the pool filled or expired before it landed.
 */
async function answerNoSeats(deps: Deps, poolId: number, outcome: TxOutcome): Promise<Reply> {
  const { txHash } = outcome;
  const latest = await deps.chain.getPool(poolId);
  if (latest !== null && (await pastDeadline(deps, latest))) {
    return reply(410, { error: 'pool_expired', poolId, txHash });
  }
  const reachedPools = outcome.receipts.some((receipt) => receipt.executorId === deps.config.poolsContract);
  const seatLeft = latest?.status === 'open' && latest.taken < latest.target;
  if (!reachedPools || seatLeft) {
    // The refusal had another cause, such as the buyer's limit, so the same payment would be refused again.
    return reply(502, { error: 'relay_failed', txHash });
  }
  // The pool filled before the payment landed, so there is nothing left to offer.
  return reply(409, paymentRequired([], 'no_seats_taken'));
}

/**
 * Whether a pool is past its deadline: its view says Expired or Refunded, or says Open while the
 * latest final block's time is at or past the deadline. A Filled or Settled pool never is.
 */
async function pastDeadline(deps: Deps, pool: PoolView): Promise<boolean> {
  if (pool.status === 'expired' || pool.status === 'refunded') return true;
  return pool.status === 'open' && (await deps.chain.finalBlock()).timestampMs >= pool.deadline_ms;
}

/** Appends to the activity feed, logging a failure: the feed never changes a reply. */
async function appendActivity(deps: Deps, record: ActivityRecord): Promise<void> {
  try {
    await deps.activity.append(record);
  } catch (error) {
    console.error('could not append to the activity feed:', error);
  }
}
