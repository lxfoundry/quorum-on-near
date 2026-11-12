import { setTimeout as delay } from 'node:timers/promises';
import {
  GatewayResponseError,
  PaymentNotSentError,
  PaymentUnknownError,
  SETTLE_MARGIN_BLOCKS,
  transportReason,
  type Buyer,
  type BuyerPaymentAnswer,
  type GatewayClient,
  type OfferAnswer,
  type PoolListing,
  type RedeemAnswer,
  type SignedPayment,
} from '@quorum-on-near/buyer';
import type { Offer, PaymentErrorCode } from '@quorum-on-near/protocol';
import type { BuyerProfile } from './profiles.ts';

/** The clock, timer and randomness a scripted buyer runs on, injected so that tests run instantly. */
export interface AgentRuntime {
  /** Milliseconds since the epoch. */
  now(): number;
  sleep(ms: number): Promise<void>;
  /** A number in `[0, 1)`. */
  random(): number;
}

/** The system's clock, Node's timers and Math.random. */
export const systemRuntime: AgentRuntime = {
  now: () => Date.now(),
  sleep: (ms) => delay(ms),
  random: () => Math.random(),
};

/** What a scripted buyer knows of its pool from the pools contract, never from the gateway's word. */
export interface PoolFacts {
  /** The pool's deadline, in block time: milliseconds since the epoch. */
  deadlineMs: number;
  /** The pool's seat price, in base units. */
  seatPrice: bigint;
}

/** What a scripted buyer acts with. */
export interface BuyerContext {
  /** The buyer, which signs with its own key and sends each payment once. */
  buyer: Pick<Buyer, 'accountId' | 'offer' | 'pay' | 'redeem' | 'finalHeight'>;
  /** The gateway, for its list of open pools. */
  gateway: Pick<GatewayClient, 'pools'>;
  poolId: number;
  /** The pool as the pools contract holds it: when the buyer gives up, and what its seats cost. */
  pool: PoolFacts;
  /** The buyer arrives after a delay uniform in `[0, spreadMs)`. */
  spreadMs: number;
  /** How often it polls its redemption, plus up to a tenth of it in jitter. */
  redeemIntervalMs: number;
  runtime: AgentRuntime;
  /** Receives one short line per step, prefixed with the buyer's name. */
  log: (line: string) => void;
}

/**
 * How a scripted buyer's run ended:
 * - `credential`: the pool filled, and the buyer holds a credential for its seats;
 * - `refunded`: the pool expired, and the buyer's refund arrived;
 * - `claimable`: the pool expired, and the pushed refund failed: the buyer can claim it;
 * - `declined`: the seat price is above the buyer's top price, or its own check refused the offer;
 * - `missed`: no seat was left for it;
 * - `expired`: the pool expired before the buyer's payment could take a seat;
 * - `refused`: the gateway refused the payment, for good or after every attempt;
 * - `failed`: the relay failed on every attempt, nothing landed, its proof was refused, or the gateway
 *   or the chain could not be used, so that the buyer could not pay or could not learn what it holds;
 * - `timed_out`: no final answer came by 5 minutes after the pool's deadline.
 */
export type BuyerOutcomeKind =
  | 'credential'
  | 'refunded'
  | 'claimable'
  | 'declined'
  | 'missed'
  | 'expired'
  | 'refused'
  | 'failed'
  | 'timed_out';

/** A scripted buyer's outcome. It never holds the credential, which is a bearer token. */
export interface BuyerOutcome {
  /** The buyer's account. */
  buyer: string;
  kind: BuyerOutcomeKind;
  /**
   * The seats the buyer holds in the pool, as the gateway last reported them; 0 when none was reported.
   * A refund answer names its amount, not its seats, so a buyer with no count yet when it learns of its
   * refund (a resumed buyer whose first answer is a refund) holds the count derived from it: the amount
   * less the bonus share, divided by the seat price on chain.
   */
  seats: number;
  /** What those seats cost, in base units, at the seat price the pools contract holds. */
  paid: bigint;
  /** A short account of how it ended. */
  detail: string;
  /**
   * Every transaction the gateway named to the buyer, in order: its commits, each payment whose
   * result was unknown, each relay that took nothing, and its refund.
   */
  txHashes: string[];
}

/**
 * The most offer-and-payment attempts, the most requests for the list of pools, and the most
 * redemptions that ask what the buyer holds before a payment.
 */
const MAX_ATTEMPTS = 3;
/** The wait before the next attempt is this times the attempts made so far. */
const RETRY_DELAY_MS = 2_000;
/** How long after the pool's deadline the buyer keeps polling its redemption. */
const GIVE_UP_AFTER_DEADLINE_MS = 300_000;
/**
 * How many more times the buyer asks after a `refunded` answer that names no refund transaction. The
 * pools contract marks a buyer refunded as the keeper's `refund` call starts, before the transfer has
 * run, and the gateway learns the transaction from its activity feed only once the call has finished.
 * A scripted buyer never claims its own refund, so such an answer means that the call is still
 * running; a refund claimed with the buyer's key elsewhere is never in the feed, hence the bound.
 */
const UNRECORDED_REFUND_POLLS = 3;
/** The refusals that a new payment can pass: the payment's expiry or nonce no longer fits the chain. */
const TRANSIENT_REFUSALS: ReadonlySet<PaymentErrorCode> = new Set(['expired', 'nonce_too_large']);
/**
 * The refusals that say another payment of the buyer's account may still take seats: one is in flight
 * at the gateway (`payment_in_flight`), or a transaction of the key landed after the nonce was read
 * (`stale_nonce`), which may be an earlier payment of this buyer, such as one of an interrupted run.
 */
const UNSETTLED_REFUSALS: ReadonlySet<PaymentErrorCode> = new Set(['payment_in_flight', 'stale_nonce']);

/** What an attempt at paying leads to. */
type Step =
  /** The run ends. */
  | { next: 'end'; kind: BuyerOutcomeKind; detail: string; txHash?: string }
  /**
   * Nothing was taken, so a new payment is safe: another attempt, after a backoff. `kind` and `detail`
   * end the run when no attempt is left; `txHash` is a relayed transaction that took nothing.
   */
  | { next: 'retry'; kind: 'refused' | 'failed'; detail: string; txHash?: string }
  /** The payment took seats: follow its redemption. */
  | { next: 'follow' }
  /**
   * A payment of the buyer's account may still take seats until block `untilHeight`: learn whether it
   * did before any new payment. `kind` and `detail` end the run when it did not and no attempt is left.
   */
  | { next: 'settle'; untilHeight: bigint; kind: 'refused' | 'failed'; detail: string };

/**
 * Runs one scripted buyer against a pool. It signs a payment only while the gateway says it holds no
 * seats in the pool and no earlier payment of its account can still take seats:
 * 1. waits `random() × spreadMs`;
 * 2. lists the pools (`GET /pools`), asking again after a 503 or a failed request; a pool that is not
 *    listed is asked for an offer, whose answer says why;
 * 3. declines a listed pool whose seat price, as the pools contract holds it (`ctx.pool`), is above its
 *    top price: the price the gateway lists is its word;
 * 4. redeems once before each payment. A buyer that already holds seats in the pool, such as one that
 *    paid in an earlier run on it, follows its redemption (step 7) and never pays. After a 503 or a
 *    failed request it asks again, and with no answer after MAX_ATTEMPTS it ends `failed`, having paid
 *    nothing; a refused proof ends it `failed` before it pays;
 * 5. asks for the offer for its seats and pays it with Buyer.pay, on a budget of the offered seats at
 *    its top price, so it never pays more than that per seat. A new attempt, after a backoff, follows
 *    a 503, a failed request for the offer, a payment that was never sent (its key not being on its
 *    account ends the run), a 402 `expired` or `nonce_too_large`, and a 502 `relay_failed`, which took
 *    nothing; MAX_ATTEMPTS in all. A 402 `pool_closed` asks for the offer again at once, whose answer
 *    says whether the pool is full (`missed`) or expired (`expired`), or offers seats (a new attempt).
 *    Any other refusal ends the run, as do a 409 (`missed`) and a 410 (`expired`);
 * 6. after a payment whose answer was lost, a 502 `result_unknown`, or a 402 `payment_in_flight` or
 *    `stale_nonce` (another payment of its account may still land), signs nothing and redeems until
 *    seats appear, which it follows, or until a redemption read after a final block above the
 *    payment's expiry plus SETTLE_MARGIN_BLOCKS finds none: nothing landed, and its next attempt pays;
 * 7. after a 202, or once it holds seats, redeems every `redeemIntervalMs` (with jitter) until a 200
 *    (`credential`) or a 410 whose refund is `refunded` or `claimable`, keeping on through 202, 410
 *    `refund_pending`, 503 and failed requests, and asking up to UNRECORDED_REFUND_POLLS more times
 *    after a `refunded` answer that names no refund transaction; a 404 ends it `failed`.
 * It gives up 5 minutes after the pool's deadline as the pools contract holds it (`ctx.pool`), by its
 * own clock (`timed_out`).
 *
 * So a second run on the same pool resumes each buyer: one that holds seats there follows them and
 * never buys again. Logs one line per step, which names a failure with the buyer's own text and at
 * most an HTTP status or an errno code, never a library's or the RPC's text; never throws.
 */
export function runBuyer(profile: BuyerProfile, ctx: BuyerContext): Promise<BuyerOutcome> {
  return new ScriptedBuyer(profile, ctx).run();
}

class ScriptedBuyer {
  readonly #profile: BuyerProfile;
  readonly #ctx: BuyerContext;
  /** When the buyer stops polling, by its own clock: 5 minutes after the pool's deadline on chain. */
  readonly #giveUpAtMs: number;
  #seats = 0;
  #paid = 0n;
  readonly #txHashes: string[] = [];
  /** The redemption state last logged, so that each is logged once, not on every poll. */
  #state = '';

  constructor(profile: BuyerProfile, ctx: BuyerContext) {
    this.#profile = profile;
    this.#ctx = ctx;
    this.#giveUpAtMs = ctx.pool.deadlineMs + GIVE_UP_AFTER_DEADLINE_MS;
  }

  async run(): Promise<BuyerOutcome> {
    try {
      return await this.#arrive();
    } catch (error) {
      return this.#end('failed', `stopped by an unexpected error (${transportReason(error)})`);
    }
  }

  async #arrive(): Promise<BuyerOutcome> {
    const { runtime, spreadMs, poolId } = this.#ctx;
    const { seats, topPrice } = this.#profile;
    const delayMs = Math.floor(runtime.random() * spreadMs);
    await runtime.sleep(delayMs);
    const listed = await this.#listing();
    if ('failed' in listed) return this.#end('failed', listed.failed);
    const arrival = `arrives after ${(delayMs / 1000).toFixed(1)} s`;
    if (listed.listing === undefined) {
      this.#log(`${arrival}: pool ${poolId} is not listed, asks for an offer`);
    } else {
      // The seat price on chain, never the listing's: the gateway's word does not decide what is paid.
      const price = this.#ctx.pool.seatPrice;
      if (price > topPrice) return this.#end('declined', `seat price ${price} above top price ${topPrice}`);
      this.#log(`${arrival}: seat price ${price}, top price ${topPrice}: wants ${seats} seats`);
    }
    return this.#commit();
  }

  /** The pool's row in the gateway's list (undefined when it is not listed), or why the list could not be had. */
  async #listing(): Promise<{ listing: PoolListing | undefined } | { failed: string }> {
    for (let attempt = 1; ; attempt += 1) {
      let reason: string;
      try {
        const answer = await this.#ctx.gateway.pools();
        if (answer.kind === 'pools') return { listing: answer.pools.find((pool) => pool.id === this.#ctx.poolId) };
        reason = 'gateway unavailable';
      } catch (error) {
        reason = requestFailed(error);
      }
      if (attempt === MAX_ATTEMPTS) return { failed: reason };
      await this.#backoff(attempt, reason);
    }
  }

  async #commit(): Promise<BuyerOutcome> {
    for (let attempt = 1; ; attempt += 1) {
      const held = await this.#resume();
      if (held !== null) return held;
      const step = await this.#attempt();
      switch (step.next) {
        case 'end':
          return this.#end(step.kind, step.detail, step.txHash);
        case 'follow':
          return this.#redeem();
        case 'settle': {
          const settled = await this.#settle(step.untilHeight);
          if (settled !== 'not_landed') return settled;
          if (attempt === MAX_ATTEMPTS) return this.#end(step.kind, step.detail);
          // Nothing of the payment can land any more: the next attempt pays at once.
          this.#log(`${step.detail}, tries again`);
          break;
        }
        case 'retry':
          if (attempt === MAX_ATTEMPTS) return this.#end(step.kind, step.detail, step.txHash);
          if (step.txHash !== undefined) this.#txHashes.push(step.txHash);
          await this.#backoff(attempt, step.txHash === undefined ? step.detail : `${step.detail} (tx ${step.txHash})`);
          break;
      }
    }
  }

  /**
   * Redeems once before a payment, to learn what the buyer holds: null when the gateway says it holds
   * no seats, so that a payment may be signed; otherwise the run, which follows the seats it holds or
   * ends without paying. Asks again after a 503 or a failed request, up to MAX_ATTEMPTS in all.
   */
  async #resume(): Promise<BuyerOutcome | null> {
    const { buyer, poolId } = this.#ctx;
    for (let attempt = 1; ; attempt += 1) {
      let answer: RedeemAnswer | undefined;
      let reason = 'redemption: gateway unavailable';
      try {
        answer = await buyer.redeem(poolId);
      } catch (error) {
        reason = `redemption got no answer (${transportReason(error)})`;
      }
      if (answer !== undefined && answer.kind !== 'unavailable') {
        switch (answer.kind) {
          case 'no_seats':
            return null;
          case 'pending':
          case 'filled':
          case 'refund':
            this.#log(`holds ${this.#heldSeats(answer)} seats already: follows its redemption`);
            return this.#redeem(answer);
          case 'invalid_proof':
            return this.#end('failed', `proof refused: ${answer.error}`);
          case 'unknown_pool':
            return this.#end('failed', this.#unknownPool());
        }
      }
      if (attempt === MAX_ATTEMPTS) return this.#end('failed', 'could not learn whether it holds seats; nothing paid');
      await this.#backoff(attempt, reason);
    }
  }

  /** Asks for the offer and pays it. */
  async #attempt(): Promise<Step> {
    let answer: OfferAnswer;
    try {
      answer = await this.#ctx.buyer.offer(this.#ctx.poolId, this.#profile.seats);
    } catch (error) {
      return { next: 'retry', kind: 'failed', detail: requestFailed(error) };
    }
    switch (answer.kind) {
      case 'offer':
        return this.#pay(answer.offer);
      case 'pool_closed':
        return { next: 'end', kind: 'missed', detail: `no seat left (pool ${answer.status})` };
      case 'pool_expired':
        return { next: 'end', kind: 'expired', detail: `pool ${answer.status}` };
      case 'unknown_pool':
        return { next: 'end', kind: 'failed', detail: this.#unknownPool() };
      case 'unavailable':
        return { next: 'retry', kind: 'failed', detail: 'gateway unavailable' };
    }
  }

  async #pay(offer: Offer): Promise<Step> {
    const { buyer, poolId } = this.#ctx;
    const { seats, topPrice } = this.#profile;
    const { extra } = offer;
    const counted = extra.seats === seats ? `${seats}` : `${extra.seats} of ${seats}`;
    this.#log(`offered ${counted} seats for ${offer.maxAmountRequired}`);
    const maxAmount = BigInt(Math.min(extra.seats, seats)) * topPrice;
    let answer: BuyerPaymentAnswer;
    try {
      answer = await buyer.pay(offer, { poolId, seats, maxAmount });
    } catch (error) {
      return this.#notAnswered(error);
    }
    switch (answer.kind) {
      case 'declined':
        return { next: 'end', kind: 'declined', detail: `offer refused: ${answer.refusal.code}` };
      case 'pending':
        this.#paidFor(answer.seats, answer.txHash);
        return { next: 'follow' };
      case 'filled':
        this.#paidFor(answer.seats, answer.txHash);
        return { next: 'end', kind: 'credential', detail: 'its payment filled the pool' };
      case 'refused':
        return this.#refused(answer.error, answer.signed);
      case 'no_seats_taken':
        return { next: 'end', kind: 'missed', detail: 'no seats taken: the pool filled first' };
      case 'pool_expired':
        return { next: 'end', kind: 'expired', detail: 'pool expired before the payment landed', txHash: answer.txHash };
      case 'relay_failed':
        // relay_failed is answered only when the payment took no seats, so a new one is safe.
        return { next: 'retry', kind: 'failed', detail: 'relay failed', txHash: answer.txHash };
      case 'result_unknown':
        this.#txHashes.push(answer.txHash);
        return this.#settling(answer.signed.maxBlockHeight, 'failed', `payment result unknown  tx ${answer.txHash}`, 'it lands');
      case 'unknown_pool':
        return { next: 'end', kind: 'failed', detail: this.#unknownPool() };
      case 'unavailable':
        return { next: 'retry', kind: 'failed', detail: 'gateway unavailable' };
    }
  }

  /** Buyer.pay rejected: retry a payment that was never sent, and settle one that may have been. */
  #notAnswered(error: unknown): Step {
    if (error instanceof PaymentUnknownError) {
      const reason = `no answer to the payment (${transportReason(error)})`;
      return this.#settling(error.signed.maxBlockHeight, 'failed', reason, 'it lands');
    }
    if (error instanceof PaymentNotSentError) {
      // A key that is not on the account stays so: no new attempt would be signed with another.
      if (error.reason === 'key_not_found') return { next: 'end', kind: 'failed', detail: error.message };
      return { next: 'retry', kind: 'failed', detail: error.message };
    }
    // Buyer.pay rejects otherwise only before reading anything; paying no more is safe either way.
    return { next: 'end', kind: 'failed', detail: `could not pay (${transportReason(error)})` };
  }

  /** A 402: nothing was relayed. */
  async #refused(code: PaymentErrorCode, signed: SignedPayment): Promise<Step> {
    const detail = `payment refused: ${code}`;
    if (code === 'pool_closed') return this.#poolClosed(detail);
    if (UNSETTLED_REFUSALS.has(code)) {
      // The earlier payment was signed no later than this one, under the same bound: by its expiry,
      // the final height plus the blocks of the shorter of the offer's and the buyer's timeouts, that
      // one has expired too.
      return this.#settling(signed.maxBlockHeight, 'refused', detail, 'an earlier payment lands');
    }
    return TRANSIENT_REFUSALS.has(code) ? { next: 'retry', kind: 'refused', detail } : { next: 'end', kind: 'refused', detail };
  }

  /**
   * After a 402 `pool_closed`, asks for the offer once more, at once: the pool filled or reached its
   * deadline between the offer and the payment, and the new answer says which, or offers seats again.
   */
  async #poolClosed(detail: string): Promise<Step> {
    this.#log(`${detail}: asks for the offer again`);
    let answer: OfferAnswer;
    try {
      answer = await this.#ctx.buyer.offer(this.#ctx.poolId, this.#profile.seats);
    } catch {
      return { next: 'retry', kind: 'refused', detail };
    }
    switch (answer.kind) {
      case 'pool_closed':
        return { next: 'end', kind: 'missed', detail: `no seat left (pool ${answer.status})` };
      case 'pool_expired':
        return { next: 'end', kind: 'expired', detail: `pool ${answer.status}` };
      case 'unknown_pool':
        return { next: 'end', kind: 'failed', detail: this.#unknownPool() };
      case 'offer':
      case 'unavailable':
        return { next: 'retry', kind: 'refused', detail };
    }
  }

  /**
   * The step that settles a payment which may take seats until block `untilHeight`, and its log line:
   * `what` happened, then what the buyer learns by redemption (`whether`) and by which block.
   */
  #settling(untilHeight: bigint, kind: 'refused' | 'failed', what: string, whether: string): Step {
    const lastHeight = untilHeight + SETTLE_MARGIN_BLOCKS;
    this.#log(`${what}: learns by redemption whether ${whether} by block ${lastHeight}`);
    const detail = kind === 'failed' ? `the payment did not land by block ${lastHeight}` : what;
    return { next: 'settle', untilHeight, kind, detail };
  }

  /**
   * Redeems, signing nothing, until it learns whether a payment of the buyer's account that may still
   * land took seats: seats appear, which it follows, or a redemption read after a final block above
   * `untilHeight` plus SETTLE_MARGIN_BLOCKS finds none (`not_landed`), so that a new payment is safe.
   * A final height that cannot be read counts as not passed yet; a 503 or a failed request is asked
   * again. It gives up as #redeem does.
   */
  async #settle(untilHeight: bigint): Promise<BuyerOutcome | 'not_landed'> {
    const { buyer, poolId } = this.#ctx;
    const lastHeight = untilHeight + SETTLE_MARGIN_BLOCKS;
    this.#state = '';
    for (;;) {
      await this.#pause();
      if (this.#timeUp()) return this.#timedOut();
      // Read before the redemption, so that a 404 counts only when the height was already past.
      let height: bigint | null = null;
      try {
        height = await buyer.finalHeight();
      } catch (error) {
        this.#report('no_height', `could not read the final block (${transportReason(error)})`);
      }
      let answer: RedeemAnswer;
      try {
        answer = await buyer.redeem(poolId);
      } catch (error) {
        this.#report('error', `redemption got no answer (${transportReason(error)})`);
        continue;
      }
      switch (answer.kind) {
        case 'pending':
        case 'filled':
        case 'refund':
          return this.#redeem(answer);
        case 'no_seats':
          if (height !== null && height > lastHeight) return 'not_landed';
          continue;
        case 'invalid_proof':
          return this.#end('failed', `proof refused: ${answer.error}`);
        case 'unknown_pool':
          return this.#end('failed', this.#unknownPool());
        case 'unavailable':
          this.#report('unavailable', 'redemption: gateway unavailable');
          continue;
      }
    }
  }

  /**
   * Polls redemption for the seats the buyer holds, starting from `first` when an answer is already
   * in hand, until a final answer or the give-up time.
   */
  async #redeem(first?: RedeemAnswer): Promise<BuyerOutcome> {
    const { buyer, poolId } = this.#ctx;
    let unrecorded = 0;
    let answer = first;
    this.#state = '';
    for (;;) {
      if (answer === undefined) {
        await this.#pause();
        if (this.#timeUp()) return this.#timedOut();
        try {
          answer = await buyer.redeem(poolId);
        } catch (error) {
          this.#report('error', `redemption got no answer (${transportReason(error)})`);
          continue;
        }
      }
      const current = answer;
      answer = undefined;
      switch (current.kind) {
        case 'pending':
          this.#hold(current.seats);
          this.#report('pending', `waiting: ${current.taken} of ${current.target} seats taken`);
          continue;
        case 'filled':
          this.#hold(current.seats);
          return this.#end('credential', 'pool filled');
        case 'refund':
          if (this.#seats === 0) this.#hold(this.#heldSeats(current));
          if (current.status === 'refund_pending') {
            this.#report('refund_pending', 'pool expired: refund pending');
            continue;
          }
          if (current.status === 'claimable') {
            return this.#end('claimable', `${current.amount} to claim, bonus ${current.bonusShare}`, current.txHash ?? undefined);
          }
          if (current.txHash === null && unrecorded < UNRECORDED_REFUND_POLLS) {
            unrecorded += 1;
            this.#report('refund_unrecorded', 'refunded, its transaction not recorded yet');
            continue;
          }
          return this.#end('refunded', `${current.amount} back, bonus ${current.bonusShare}`, current.txHash ?? undefined);
        case 'no_seats':
          return this.#end('failed', 'the gateway reports no seats');
        case 'invalid_proof':
          return this.#end('failed', `proof refused: ${current.error}`);
        case 'unknown_pool':
          return this.#end('failed', this.#unknownPool());
        case 'unavailable':
          this.#report('unavailable', 'redemption: gateway unavailable');
          continue;
      }
    }
  }

  /**
   * The seats a redemption answer says the buyer holds. A refund names its amount, not its seats: the
   * seats' price is the amount less the bonus share, at the seat price the pools contract holds.
   */
  #heldSeats(answer: Extract<RedeemAnswer, { kind: 'pending' | 'filled' | 'refund' }>): number {
    if (answer.kind !== 'refund') return answer.seats;
    const { seatPrice } = this.#ctx.pool;
    const price = answer.amount - answer.bonusShare;
    return seatPrice > 0n && price > 0n ? Number(price / seatPrice) : 0;
  }

  /** Records the seats the buyer holds, as the gateway reports them, and what they cost at the pool's seat price. */
  #hold(seats: number): void {
    this.#seats = seats;
    this.#paid = BigInt(seats) * this.#ctx.pool.seatPrice;
  }

  /** Records the seats a payment took, what they cost, and its transaction. */
  #paidFor(seats: number, txHash: string): void {
    this.#hold(seats);
    this.#txHashes.push(txHash);
    this.#log(`paid ${seats} seats  tx ${txHash}`);
  }

  /** Waits one redemption interval, plus up to a tenth of it in jitter. */
  async #pause(): Promise<void> {
    const { runtime, redeemIntervalMs } = this.#ctx;
    await runtime.sleep(Math.floor(redeemIntervalMs * (1 + runtime.random() / 10)));
  }

  #timeUp(): boolean {
    return this.#ctx.runtime.now() >= this.#giveUpAtMs;
  }

  #timedOut(): BuyerOutcome {
    return this.#end('timed_out', 'no final answer 5 min after the deadline');
  }

  async #backoff(attempt: number, reason: string): Promise<void> {
    const ms = RETRY_DELAY_MS * attempt;
    this.#log(`${reason}, tries again in ${ms / 1000} s`);
    await this.#ctx.runtime.sleep(ms);
  }

  /** Logs `line` when the redemption enters the state `state`. */
  #report(state: string, line: string): void {
    if (state === this.#state) return;
    this.#state = state;
    this.#log(line);
  }

  #unknownPool(): string {
    return `the gateway does not serve pool ${this.#ctx.poolId}`;
  }

  #log(line: string): void {
    this.#ctx.log(`${this.#profile.name.padEnd(8)}  ${line}`);
  }

  /** Ends the run: logs how, with the transaction it names, if any, which it records. */
  #end(kind: BuyerOutcomeKind, detail: string, txHash?: string): BuyerOutcome {
    if (txHash !== undefined) this.#txHashes.push(txHash);
    this.#log(`${kind}: ${detail}${txHash === undefined ? '' : `  tx ${txHash}`}`);
    return { buyer: this.#ctx.buyer.accountId, kind, seats: this.#seats, paid: this.#paid, detail, txHashes: [...this.#txHashes] };
  }
}

/** A failed request to the gateway, named by its HTTP status or its errno code only. */
function requestFailed(error: unknown): string {
  const reason = transportReason(error);
  return error instanceof GatewayResponseError ? `undocumented answer from the gateway (${reason})` : `gateway unreachable (${reason})`;
}
