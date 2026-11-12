import {
  describeError,
  PaymentNotSentError,
  readSpendFile,
  writeSpendFile,
  type BuyerPaymentAnswer,
} from '@quorum-on-near/buyer';
import type { Offer } from '@quorum-on-near/protocol';

/** What a SpendLedger counts against. */
export interface SpendLedgerOptions {
  /** The spend file that keeps the running total (see readSpendFile). */
  path: string;
  /** The buyer whose payments are counted. */
  account: string;
  /** The most the buyer may spend, in the token's base units. */
  cap: bigint;
  /** Writes one line to the operator's log; standard error by default. */
  log?: (line: string) => void;
}

/** Signs and sends a payment that costs at most `maxAmount`, and returns the answer. */
export type Send = (maxAmount: bigint) => Promise<BuyerPaymentAnswer>;

/** The result of SpendLedger.pay. */
export type LedgerPayment =
  /** The payment would take the total past the cap: nothing was sent. `left` is what the cap leaves. */
  | { kind: 'over_spend_cap'; amount: bigint; left: bigint }
  /** The payment's answer, `spent` the part of its price counted against the cap, `left` what the cap leaves now. */
  | { kind: 'answered'; answer: BuyerPaymentAnswer; spent: bigint; left: bigint }
  /** The payment never left the buyer (`error` says why), so its price was released; `left` is what the cap leaves. */
  | { kind: 'not_sent'; error: PaymentNotSentError; left: bigint };

/**
 * The payment was handed to its sender, which rejected: whether it reached the gateway is unknown,
 * so the ledger keeps its whole price counted. `cause` is the sender's error; the message never
 * quotes it, since a library's message may hold the RPC URL.
 */
export class PaymentOutcomeUnknownError extends Error {
  override name = 'PaymentOutcomeUnknownError';
  readonly amount: bigint;

  constructor(amount: bigint, cause: unknown) {
    super(`the payment of ${amount} may have been sent`, { cause });
    this.amount = amount;
  }
}

/**
 * The spend cap: a running total of what the buyer has paid, kept in the spend file, that no payment
 * may take past the cap. Payments go through the ledger one at a time. Each one is refused before it
 * is sent if its price is above what the cap leaves; otherwise its price is reserved in the file
 * before it is sent, and once it is answered, the part of the price the answer did not spend is
 * released. The total is read from the file for each payment, so a total cleared by `swarm setup`
 * counts from 0 at the next one, and read again when the payment is answered, so a total cleared
 * while the payment was in flight then counts only that payment's spend (see settledTotal).
 *
 * The answers are the gateway's word: a gateway that misreports what it relayed can make the cap count
 * less than was spent. The buyer's token balance is the bound that does not depend on the gateway.
 */
export class SpendLedger {
  readonly cap: bigint;
  readonly #path: string;
  readonly #account: string;
  readonly #log: (line: string) => void;
  /** Settles once the payment in progress, if any, has been counted. */
  #idle: Promise<void> = Promise.resolve();

  constructor(opts: SpendLedgerOptions) {
    this.cap = opts.cap;
    this.#path = opts.path;
    this.#account = opts.account;
    this.#log = opts.log ?? ((line) => console.error(line));
  }

  /** What the buyer may still spend: the cap less the total, or 0 once the total has reached the cap. */
  async left(): Promise<bigint> {
    return this.#leftAfter(await readSpendFile(this.#path, this.#account));
  }

  /**
   * Pays `offer` through `send`, once the payments before it are counted. Its price is
   * `offer.maxAmountRequired`, and `send` receives it as the most the payment may cost. What the
   * answer spent:
   * - nothing for an answer that relayed nothing or whose transfer the token returned: `declined`,
   *   `refused` (402), `unavailable` (503), `unknown_pool` (404), `no_seats_taken` (409), `pool_expired`
   *   (410);
   * - the seats taken at the offer's seat price, at most the price, for `pending` (202) and `filled`
   *   (200; its seats include those the buyer held before, hence the bound);
   * - the whole price for `relay_failed` and `result_unknown` (502), since a relayed transaction may
   *   have moved the tokens.
   * When `send` rejects with PaymentNotSentError, the payment never left the buyer: its price is
   * released and the result is `not_sent`. When `send` rejects with any other error, whether the
   * payment reached the gateway is unknown: the price stays counted and PaymentOutcomeUnknownError is
   * thrown. The offer's amounts are decimal strings, as GatewayClient returns them.
   *
   * Once `send` has settled, the result is always returned, so that a payment's receipt is never lost:
   * if the spend file cannot then be read or written, the whole price stays counted (`spent` is the
   * price, `left` what the reservation leaves), and the error goes to the log.
   *
   * Releasing the price on `unavailable` relies on the gateway's guarantee: it answers a payment 503
   * `{error: "chain_unavailable"}` only when a chain read failed before the relay, or its relayer
   * threw before sending the transaction (no relayer key free in time, the final block or the key's
   * nonce unreadable). Once a transaction is sent, the relayer no longer throws, and the answer is a
   * 202, 200, 409, 410 or 502. GatewayClient reads a 503 as `unavailable` only with that body; any
   * other 503 is a GatewayResponseError, so `send` rejects and the price stays counted.
   */
  pay(offer: Offer, send: Send): Promise<LedgerPayment> {
    const payment = this.#idle.then(() => this.#pay(offer, send));
    this.#idle = payment.then(
      () => undefined,
      () => undefined,
    );
    return payment;
  }

  async #pay(offer: Offer, send: Send): Promise<LedgerPayment> {
    const amount = BigInt(offer.maxAmountRequired);
    const seatPrice = BigInt(offer.extra.seatPrice);
    const total = await readSpendFile(this.#path, this.#account);
    const left = this.#leftAfter(total);
    if (amount > left) return { kind: 'over_spend_cap', amount, left };
    const reservation = { total: total + amount, amount };
    await writeSpendFile(this.#path, this.#account, reservation.total);
    let answer: BuyerPaymentAnswer;
    try {
      answer = await send(amount);
    } catch (error) {
      if (!(error instanceof PaymentNotSentError)) throw new PaymentOutcomeUnknownError(amount, error);
      return { kind: 'not_sent', error, left: (await this.#settle(reservation, 0n)).left };
    }
    return { kind: 'answered', answer, ...(await this.#settle(reservation, spentBy(answer, amount, seatPrice))) };
  }

  /**
   * Settles a payment whose reservation of `amount` took the total to `total`, once its answer says
   * it spent `spent` (see settledTotal): returns the part of the price that stays counted, and what the
   * cap leaves. The total is read again: `swarm setup` may have cleared it while the payment was in
   * flight, and a total computed from the first read would bring the cleared amount back. If the file
   * cannot be read or written, the reservation stays as it was written, and the error is logged.
   */
  async #settle(reservation: { total: bigint; amount: bigint }, spent: bigint): Promise<{ spent: bigint; left: bigint }> {
    try {
      const current = await readSpendFile(this.#path, this.#account);
      const settled = settledTotal(current, reservation.amount, spent);
      if (settled !== current) await writeSpendFile(this.#path, this.#account, settled);
      return { spent, left: this.#leftAfter(settled) };
    } catch (error) {
      this.#log(
        `the spend total could not be settled once the payment was answered, so its whole price, ` +
          `${reservation.amount}, stays counted in ${this.#path}: ${describeError(error, undefined)}`,
      );
      return { spent: reservation.amount, left: this.#leftAfter(reservation.total) };
    }
  }

  #leftAfter(total: bigint): bigint {
    return total < this.cap ? this.cap - total : 0n;
  }
}

/**
 * The total once a payment that reserved `reserved` and spent `spent` is settled, from the total
 * `current` read after its answer: `current − reserved + spent`, which is the total before the
 * payment plus its spend when nothing else wrote the file, and keeps what another writer added; but
 * never below `spent`, since a total cleared while the payment was in flight no longer holds its
 * reservation, and then counts only this payment's spend.
 */
function settledTotal(current: bigint, reserved: bigint, spent: bigint): bigint {
  const total = current - reserved + spent;
  return total > spent ? total : spent;
}

/** The part of a payment of `amount` that `answer` spent (see SpendLedger.pay). */
function spentBy(answer: BuyerPaymentAnswer, amount: bigint, seatPrice: bigint): bigint {
  switch (answer.kind) {
    case 'pending':
    case 'filled': {
      const taken = BigInt(answer.seats) * seatPrice;
      return taken < amount ? taken : amount;
    }
    case 'relay_failed':
    case 'result_unknown':
      return amount;
    case 'declined':
    case 'refused':
    case 'unavailable':
    case 'unknown_pool':
    case 'no_seats_taken':
    case 'pool_expired':
      return 0n;
  }
}
