import {
  describeError,
  PaymentUnknownError,
  SETTLE_MARGIN_BLOCKS,
  transportReason,
  type Buyer,
  type BuyerSettings,
  type GatewayClient,
  type OfferAnswer,
  type PoolReads,
  type SignedPayment,
} from '@quorum-on-near/buyer';
import { checkOffer, minBonusPerSeat, type Offer, type PoolView } from '@quorum-on-near/protocol';
import type { Commits } from './commits.ts';
import { poolRefusal, type Refusal } from './offer-check.ts';
import {
  MAX_POOLS_LISTED,
  type Amount,
  type CommitOutput,
  type OfferOutput,
  type PoolInput,
  type PoolsOutput,
  type SeatsInput,
  type StatusOutput,
} from './schemas.ts';
import { PaymentOutcomeUnknownError, type LedgerPayment, type SpendLedger } from './spend.ts';
import { formatUnits, type TokenUnits } from './token.ts';

/** What the tools act with. */
export interface ToolDeps {
  /** The buyer the server acts for, with its own key, and its read of the latest final height. */
  buyer: Pick<Buyer, 'accountId' | 'offer' | 'pay' | 'redeem' | 'finalHeight'>;
  /** The gateway, for the pool list, which needs no signature. */
  gateway: Pick<GatewayClient, 'pools'>;
  /** The pools contract, read for the facts of a pool the gateway offers: they do not rest on its word. */
  chain: PoolReads;
  ledger: Pick<SpendLedger, 'cap' | 'left' | 'pay'>;
  /**
   * What the buyer checks offers against (never the offer's own network, token or pools contract), the
   * block time that turns blocks into seconds, and the RPC URL, which may carry an API key and is
   * redacted from every line of the log.
   */
  settings: Pick<BuyerSettings, 'network' | 'token' | 'poolsContract' | 'blockTimeMs' | 'rpcUrl'>;
  units: TokenUnits;
  /** Milliseconds since the epoch: only for the seconds left before a deadline. */
  now: () => number;
  /** Writes one line to the operator's log, standard error: never the agent's channel. */
  log: (line: string) => void;
  /**
   * The pools held by a payment whose result is unknown: until a final block above the hold's height
   * is seen, the payment may still take seats, and quorum_commit pays nothing more for the pool. Also
   * runs one quorum_commit at a time.
   */
  commits: Commits;
}

/** A tool's answer: its output, or a failure with a code and a message the agent can act on. */
export type ToolResult<T> = { ok: true; output: T } | { ok: false; error: string; message: string };

/**
 * quorum_pools: the open pools of the gateway's provider, as it lists them: the first
 * MAX_POOLS_LISTED in its order (by id), and how many more it listed (`omitted`).
 */
export async function quorumPools(deps: ToolDeps): Promise<ToolResult<PoolsOutput>> {
  const answer = await deps.gateway.pools();
  if (answer.kind === 'unavailable') return gatewayUnavailable();
  const shown = answer.pools.slice(0, MAX_POOLS_LISTED);
  const pools = shown.map((listing) => ({
    pool: listing.id,
    seatPrice: amountOf(deps, listing.seat_price),
    ...poolFacts(deps, {
      terms: listing.terms,
      target: listing.target,
      taken: listing.taken,
      deadlineMs: listing.deadline_ms,
      bonus: listing.bonus,
      minBonusPerSeat: listing.min_bonus_per_seat,
    }),
  }));
  return ok({ pools, omitted: answer.pools.length - shown.length });
}

/**
 * quorum_offer: the gateway's offer for `seats` seats of a pool, with the pool's facts as the pools
 * contract holds them (never the offer's), and whether quorum_commit would pay it now, by the checks
 * quorum_commit makes, in its order (see offerRefusal). Signs nothing. Fails, with nothing to show,
 * when the pool cannot be read from the chain, or the chain has no such pool.
 */
export async function quorumOffer(deps: ToolDeps, { pool, seats }: SeatsInput): Promise<ToolResult<OfferOutput>> {
  const answer = await deps.buyer.offer(pool, seats);
  if (answer.kind !== 'offer') return noOffer(pool, answer);
  const { offer } = answer;
  const read = await poolOnChain(deps, 'quorum_offer', pool);
  if (!read.ok) return read;
  const view = read.output;
  let wait: Unsettled | null;
  try {
    wait = await unsettledWait(deps, pool);
  } catch (error) {
    return unreadableHeight(deps, 'quorum_offer', pool, error);
  }
  const left = await deps.ledger.left();
  const refusal = offerRefusal(deps, { pool, seats }, offer, view, wait, left);
  const seatPrice = BigInt(view.seat_price);
  const bonus = BigInt(view.bonus);
  const minBonus = minBonusPerSeat(bonus, view.target);
  return ok({
    pool,
    seatsRequested: seats,
    seats: offer.extra.seats,
    price: amountOf(deps, BigInt(offer.maxAmountRequired)),
    seatPrice: amountOf(deps, seatPrice),
    minRefundIfFails: amountOf(deps, BigInt(offer.extra.seats) * (seatPrice + minBonus)),
    payable: refusal === null,
    ...(refusal === null ? {} : { refusal }),
    spendCapLeft: amountOf(deps, left),
    ...poolFacts(deps, {
      terms: view.terms,
      target: view.target,
      taken: view.taken,
      deadlineMs: view.deadline_ms,
      bonus,
      minBonusPerSeat: minBonus,
    }),
  });
}

/**
 * Why quorum_commit would not pay `offer` now, in the order of its checks, or null: an earlier payment
 * to the pool whose result is unknown may still take seats (`wait`); the offer misstates the pool on
 * chain, or the pool takes no more seats there (poolRefusal); its price is above what the spend cap
 * leaves (`left`); then checkOffer against the buyer's settings and the request.
 */
function offerRefusal(
  deps: ToolDeps,
  request: SeatsInput,
  offer: Offer,
  view: PoolView,
  wait: Unsettled | null,
  left: bigint,
): Refusal | null {
  if (wait !== null) return { code: 'payment_unsettled', detail: unsettledDetail(request.pool, wait) };
  const onChain = poolRefusal(offer, view);
  if (onChain !== null) return onChain;
  if (BigInt(offer.maxAmountRequired) > left) {
    return { code: 'over_spend_cap', detail: `the price is above the ${display(deps, left)} that the spend cap leaves` };
  }
  const { network, token, poolsContract } = deps.settings;
  return checkOffer(offer, { network, token, poolsContract, poolId: request.pool, maxSeats: request.seats, maxAmount: left });
}

/**
 * The pool's view on chain, or the failure that says why the gateway's offer cannot be checked against
 * it: the read failed (`chain_unavailable`, the detail on the log), or the pools contract has no such
 * pool (`offer_mismatch`). Nothing is signed after either.
 */
async function poolOnChain(deps: ToolDeps, tool: string, pool: number): Promise<ToolResult<PoolView>> {
  let view: PoolView | null;
  try {
    view = await deps.chain.getPool(pool);
  } catch (error) {
    deps.log(`${tool}: ${describeError(error, deps.settings.rpcUrl)}`);
    return failure(
      'chain_unavailable',
      `This server could not read pool ${pool} from the chain to check the gateway's offer (${transportReason(error)}). ` +
        'Nothing was signed; try again shortly.',
    );
  }
  if (view === null) {
    return failure(
      'offer_mismatch',
      `The pools contract ${deps.settings.poolsContract} has no pool ${pool}, although the gateway offers it. ` +
        'Nothing was signed.',
    );
  }
  return ok(view);
}

/**
 * quorum_commit: refuses, before anything is asked or signed, a pool whose last payment with an
 * unknown result may still take seats (`payment_unsettled`); then asks for a fresh offer for `seats`
 * seats, checks it against the pool on chain (poolRefusal), and pays it through the spend ledger,
 * which refuses it, before anything is signed, when its price is above what the cap leaves. The buyer
 * then checks the offer, signs the payment and sends it once. A payment whose result is unknown holds
 * the pool until it is settled (see ToolDeps.commits). One commit runs at a time, so that each sees
 * the hold the one before it left.
 *
 * `signal` is the client's cancellation of the call, after which the MCP SDK sends no answer. A call
 * cancelled when it leaves the queue, or before its payment goes through the spend ledger, signs and
 * spends nothing (`cancelled`). One cancelled once the payment was handed over runs to its answer;
 * the pool is then held whatever the answer, once a payment was signed, as for a payment whose result
 * is unknown, and the answer goes to the log, since no client receives it.
 */
export function quorumCommit(deps: ToolDeps, request: SeatsInput, signal?: AbortSignal): Promise<ToolResult<CommitOutput>> {
  return deps.commits.serial(() => commit(deps, request, signal));
}

async function commit(deps: ToolDeps, { pool, seats }: SeatsInput, signal?: AbortSignal): Promise<ToolResult<CommitOutput>> {
  // Cancelled while it waited its turn: nothing is asked, signed or counted.
  if (isCancelled(signal)) return cancelled(pool);
  let wait: Unsettled | null;
  try {
    wait = await unsettledWait(deps, pool);
  } catch (error) {
    return unreadableHeight(deps, 'quorum_commit', pool, error);
  }
  if (wait !== null) return failure('payment_unsettled', unsettledMessage(pool, wait));
  const answer = await deps.buyer.offer(pool, seats);
  if (answer.kind !== 'offer') return noOffer(pool, answer);
  const { offer } = answer;
  const read = await poolOnChain(deps, 'quorum_commit', pool);
  if (!read.ok) return read;
  const refusal = poolRefusal(offer, read.output);
  if (refusal !== null) return refused(refusal);
  // Cancelled before the payment is handed over: nothing is signed or counted.
  if (isCancelled(signal)) return cancelled(pool);
  const { result, signed } = await payOffer(deps, pool, seats, offer);
  if (isCancelled(signal)) cancelledAfterPaying(deps, pool, signed, result);
  return result;
}

/**
 * Pays `offer` through the spend ledger: the call's answer, and what Buyer.pay signed when it signed
 * and sent a payment (null when nothing left the buyer, or what it signed is not known).
 */
async function payOffer(
  deps: ToolDeps,
  pool: number,
  seats: number,
  offer: Offer,
): Promise<{ result: ToolResult<CommitOutput>; signed: SignedPayment | null }> {
  let payment: LedgerPayment;
  try {
    payment = await deps.ledger.pay(offer, (maxAmount) => deps.buyer.pay(offer, { poolId: pool, seats, maxAmount }));
  } catch (error) {
    if (!(error instanceof PaymentOutcomeUnknownError)) throw error;
    // Only the reason's code: the error's message may come from a library and quote the RPC URL.
    const reason = transportReason(error.cause);
    const noAnswer = `The payment may have been sent: the gateway gave no documented answer to it (${reason}).`;
    // Buyer.pay's own rejection says what it signed; without that, the pool cannot be held.
    if (error.cause instanceof PaymentUnknownError) {
      const { signed } = error.cause;
      return { result: failure('payment_unknown', `${noAnswer} ${holdUnsettled(deps, pool, error.amount, signed)}`), signed };
    }
    return { result: failure('payment_unknown', `${noAnswer} ${stillCounted(deps, error.amount)}`), signed: null };
  }
  if (payment.kind === 'over_spend_cap') {
    const result = failure(
      'over_spend_cap',
      `Paying ${display(deps, payment.amount)} would take this buyer past its spend cap of ` +
        `${display(deps, deps.ledger.cap)}: ${display(deps, payment.left)} is left. Nothing was signed.`,
    );
    return { result, signed: null };
  }
  if (payment.kind === 'not_sent') return { result: notSent(deps, payment), signed: null };
  const { answer } = payment;
  return { result: paymentResult(deps, pool, payment), signed: 'signed' in answer ? answer.signed : null };
}

/** Whether the client has cancelled the call: read afresh at each check, since a cancellation can come during any await. */
function isCancelled(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/** A call cancelled before its payment was handed over: nothing was signed or counted. No client receives this. */
function cancelled(pool: number): ToolResult<never> {
  return failure('cancelled', `The call for pool ${pool} was cancelled before anything was signed; nothing was paid.`);
}

/**
 * A call cancelled once its payment was handed over, which no client hears the answer of: the pool is
 * held as for a payment whose result is unknown, whatever the answer, when a payment was signed, and
 * the answer goes to the operator's log.
 */
function cancelledAfterPaying(deps: ToolDeps, pool: number, signed: SignedPayment | null, result: ToolResult<CommitOutput>): void {
  const answer = `the answer: ${answerLine(result)}`;
  if (signed === null) {
    // Whether anything was signed is for the answer to say: a payment can have been signed and never sent.
    deps.log(
      `quorum_commit: the call for pool ${pool} was cancelled once its payment had reached the spend ledger, ` +
        `and no signed payment is known, so pool ${pool} is not held; ${answer}`,
    );
    return;
  }
  const untilHeight = signed.maxBlockHeight + SETTLE_MARGIN_BLOCKS;
  deps.commits.hold(pool, untilHeight);
  deps.log(
    `quorum_commit: the call for pool ${pool} was cancelled once its payment was handed over, so pool ${pool} is held ` +
      `until a final block above ${untilHeight}; ${answer}`,
  );
}

/** A commit's answer in one line for the log: never the credential, which is a bearer token. */
function answerLine(result: ToolResult<CommitOutput>): string {
  if (!result.ok) return `${result.error}: ${result.message}`;
  const { status, seats, paid, txHash } = result.output;
  return `${status}, ${seats} seats, ${paid.display} counted, transaction ${txHash}`;
}

/**
 * A payment that never left the buyer, so that nothing can land: this server's own words for each
 * reason, with at most the failure's transportReason, never the error's message.
 */
function notSent(deps: ToolDeps, { error, left }: LedgerPayment & { kind: 'not_sent' }): ToolResult<never> {
  const capLeft = `The spend cap leaves ${display(deps, left)}`;
  const reason = transportReason(error);
  switch (error.reason) {
    case 'key_not_found':
      return failure(
        'payment_not_sent',
        `This server's key is not an access key of ${deps.buyer.accountId}, so it could not sign the payment, ` +
          `and sent nothing. ${capLeft}.`,
      );
    case 'chain_read':
      return failure(
        'payment_not_sent',
        `This server could not read the chain to sign the payment (${reason}), and sent nothing. ${capLeft}; try again shortly.`,
      );
    case 'signing':
      return failure('payment_not_sent', `This server could not sign the payment, and sent nothing. ${capLeft}.`);
    case 'gateway_unreachable':
      return failure(
        'payment_not_sent',
        `This server could not connect to the gateway (${reason}), and sent nothing. ${capLeft}; try again shortly.`,
      );
  }
}

/** quorum_status: redeems with a fresh proof of the buyer's account, which pays nothing. */
export async function quorumStatus(deps: ToolDeps, { pool }: PoolInput): Promise<ToolResult<StatusOutput>> {
  const answer = await deps.buyer.redeem(pool);
  switch (answer.kind) {
    case 'pending':
      return ok({
        status: 'pending',
        pool,
        seats: answer.seats,
        taken: answer.taken,
        target: answer.target,
        ...deadlineOf(deps, answer.deadlineMs),
      });
    case 'filled':
      return ok({ status: 'filled', pool, seats: answer.seats, credential: answer.credential, terms: answer.terms });
    case 'refund':
      return ok({
        status: answer.status,
        pool,
        amount: amountOf(deps, answer.amount),
        bonusShare: amountOf(deps, answer.bonusShare),
        txHash: answer.txHash,
      });
    case 'no_seats':
      return ok({ status: 'no_seats', pool });
    case 'invalid_proof':
      return failure(answer.error, `The gateway refused this server's proof of the buyer's account (${answer.error}).`);
    case 'unknown_pool':
      return unknownPool(pool);
    case 'unavailable':
      return gatewayUnavailable();
  }
}

/** The answer to a payment the ledger let through. */
function paymentResult(
  deps: ToolDeps,
  pool: number,
  { answer, spent, left }: LedgerPayment & { kind: 'answered' },
): ToolResult<CommitOutput> {
  const paid = amountOf(deps, spent);
  const spendCapLeft = amountOf(deps, left);
  const returned = 'took no seats, and the token returned the payment';
  switch (answer.kind) {
    case 'pending':
      return ok({
        status: 'pending',
        pool,
        seats: answer.seats,
        paid,
        txHash: answer.txHash,
        taken: answer.taken,
        target: answer.target,
        ...deadlineOf(deps, answer.deadlineMs),
        spendCapLeft,
      });
    case 'filled':
      return ok({
        status: 'filled',
        pool,
        seats: answer.seats,
        paid,
        txHash: answer.txHash,
        credential: answer.credential,
        terms: answer.terms,
        spendCapLeft,
      });
    case 'declined':
      return refused(answer.refusal);
    case 'refused': {
      const now = answer.offer === null ? '' : ` It now offers ${answer.offer.extra.seats} seats.`;
      return failure(answer.error, `The gateway refused the payment (${answer.error}) and relayed nothing.${now}`);
    }
    case 'no_seats_taken':
      return failure('no_seats_taken', `The pool filled before the payment landed: the payment ${returned}.`);
    case 'pool_expired':
      return failure(
        answer.kind,
        `The pool reached its deadline before the payment landed: transaction ${answer.txHash} ${returned}.`,
      );
    case 'relay_failed':
      return failure('relay_failed', `The relayed transaction ${answer.txHash} failed. ${stillCounted(deps, spent)}`);
    case 'result_unknown':
      return failure(
        'result_unknown',
        `The result of transaction ${answer.txHash} is unknown, and it may still land. ` +
          holdUnsettled(deps, pool, spent, answer.signed),
      );
    case 'unknown_pool':
      return unknownPool(pool);
    case 'unavailable':
      return gatewayUnavailable('payment');
  }
}

/** A pool for which the gateway made no offer. */
function noOffer(pool: number, answer: Exclude<OfferAnswer, { kind: 'offer' }>): ToolResult<never> {
  switch (answer.kind) {
    case 'unknown_pool':
      return unknownPool(pool);
    case 'pool_closed':
      return failure(
        answer.kind,
        answer.status === 'open' ? `Pool ${pool} has no seat left.` : `Pool ${pool} has filled (${answer.status}).`,
      );
    case 'pool_expired':
      return failure(answer.kind, `Pool ${pool} is past its deadline (${answer.status}) and takes no more seats.`);
    case 'unavailable':
      return gatewayUnavailable();
  }
}

/** Every value of a pool the agent sees, from a pool listing or an offer's `extra`. */
function poolFacts(
  deps: ToolDeps,
  pool: { terms: string; target: number; taken: number; deadlineMs: number; bonus: bigint; minBonusPerSeat: bigint },
) {
  return {
    terms: pool.terms,
    target: pool.target,
    taken: pool.taken,
    seatsLeft: Math.max(pool.target - pool.taken, 0),
    ...deadlineOf(deps, pool.deadlineMs),
    bonus: amountOf(deps, pool.bonus),
    minBonusPerSeat: amountOf(deps, pool.minBonusPerSeat),
  };
}

/** The last instant a Date holds, in milliseconds since the epoch: 8.64 × 10^15, in the year 275760. */
const MAX_DATE_MS = 8_640_000_000_000_000;

/**
 * A deadline as the tools show it: in ISO 8601, as the gateway's milliseconds, and in seconds left. A
 * gateway's deadline is any safe integer, and one past MAX_DATE_MS has no ISO form, so its `deadline`
 * is null rather than an error that would hide the rest of the answer, such as a payment's receipt.
 */
function deadlineOf(deps: ToolDeps, deadlineMs: number): { deadline: string | null; deadlineMs: number; secondsLeft: number } {
  return {
    deadline: deadlineMs <= MAX_DATE_MS ? new Date(deadlineMs).toISOString() : null,
    deadlineMs,
    secondsLeft: Math.max(Math.floor((deadlineMs - deps.now()) / 1000), 0),
  };
}

function amountOf(deps: ToolDeps, value: bigint): Amount {
  return { base: value.toString(), display: display(deps, value) };
}

function display(deps: ToolDeps, value: bigint): string {
  return `${formatUnits(value, deps.units.decimals)} ${deps.units.symbol}`;
}

/** What a failure that may have spent says. */
function stillCounted(deps: ToolDeps, amount: bigint): string {
  const price = display(deps, amount);
  return `Its price, ${price}, stays counted against the spend cap; quorum_status tells whether it took seats.`;
}

/** How long a payment whose result is unknown may still take seats. */
interface Unsettled {
  /** The height above which a final block settles it. */
  untilHeight: bigint;
  /** About how many seconds that is, at the configured block time. */
  seconds: number;
}

/**
 * Holds `pool` until `signed` is settled (see ToolDeps.commits), and says what a failure whose
 * payment may still take seats says: its price stays counted, and the wait from its signing.
 */
function holdUnsettled(deps: ToolDeps, pool: number, amount: bigint, signed: SignedPayment): string {
  const untilHeight = signed.maxBlockHeight + SETTLE_MARGIN_BLOCKS;
  deps.commits.hold(pool, untilHeight);
  const wait = { untilHeight, seconds: secondsAbove(deps, untilHeight, signed.finalHeight) };
  return (
    `Its price, ${display(deps, amount)}, stays counted against the spend cap. It may still take seats until a final ` +
    `block above ${untilHeight}, within about ${wait.seconds} s: quorum_status tells whether it did, but a no_seats ` +
    `it answers is final only after that, and quorum_commit refuses pool ${pool} until then.`
  );
}

/**
 * The wait before the last payment to `pool` whose result is unknown is settled, or null when there
 * is none or a final block above its height has been seen (the hold it checked is then dropped, and
 * only that one: quorum_offer runs outside the commit queue, and a commit may set a newer hold while
 * it reads the final height). Rejects with the chain's error when the final height cannot be read.
 */
async function unsettledWait(deps: ToolDeps, pool: number): Promise<Unsettled | null> {
  const untilHeight = deps.commits.heldUntil(pool);
  if (untilHeight === undefined) return null;
  const height = await deps.buyer.finalHeight();
  if (height > untilHeight) {
    deps.commits.release(pool, untilHeight);
    return null;
  }
  return { untilHeight, seconds: secondsAbove(deps, untilHeight, height) };
}

/** About how many seconds, at the configured block time, until a final block above `untilHeight`, from `height`. */
function secondsAbove(deps: ToolDeps, untilHeight: bigint, height: bigint): number {
  const blocks = untilHeight - height + 1n;
  return Math.ceil((Number(blocks > 0n ? blocks : 0n) * deps.settings.blockTimeMs) / 1000);
}

/** Why a pool held by an unsettled payment is not paid, as a refusal's detail. */
function unsettledDetail(pool: number, { untilHeight, seconds }: Unsettled): string {
  return (
    `an earlier payment to pool ${pool} may still take seats until a final block above ${untilHeight}, ` +
    `within about ${seconds} s`
  );
}

function unsettledMessage(pool: number, wait: Unsettled): string {
  const detail = unsettledDetail(pool, wait);
  return (
    `${detail.charAt(0).toUpperCase()}${detail.slice(1)}. Nothing was signed. A no_seats that quorum_status answers ` +
    `for pool ${pool} is final only after that, and quorum_commit pays for pool ${pool} again only then.`
  );
}

/** The final height could not be read to tell whether a pool's held payment is settled: nothing is signed. */
function unreadableHeight(deps: ToolDeps, tool: string, pool: number, error: unknown): ToolResult<never> {
  deps.log(`${tool}: ${describeError(error, deps.settings.rpcUrl)}`);
  return failure(
    'chain_unavailable',
    `This server could not read the chain to tell whether an earlier payment to pool ${pool} can still take seats ` +
      `(${transportReason(error)}). Nothing was signed; try again shortly.`,
  );
}

function ok<T>(output: T): ToolResult<T> {
  return { ok: true, output };
}

function failure(error: string, message: string): ToolResult<never> {
  return { ok: false, error, message };
}

/** An offer this server refused before signing anything. */
function refused({ code, detail }: Refusal): ToolResult<never> {
  return failure(code, `This server refused the offer (${detail}); it signed nothing.`);
}

function unknownPool(pool: number): ToolResult<never> {
  return failure('unknown_pool', `The gateway does not serve pool ${pool}.`);
}

/**
 * The gateway's 503. For a payment it also means no relayer key was free in time; either way, the
 * gateway relayed nothing.
 */
function gatewayUnavailable(request: 'read' | 'payment' = 'read'): ToolResult<never> {
  return failure(
    'gateway_unavailable',
    request === 'payment'
      ? 'The gateway could not read the chain or had no relayer key free, and relayed nothing. Try again shortly.'
      : 'The gateway could not read the chain, and did nothing. Try again shortly.',
  );
}
