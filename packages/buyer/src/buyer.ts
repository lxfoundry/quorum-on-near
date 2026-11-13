import {
  buildPaymentHeader,
  buildRedeemProofHeader,
  checkOffer,
  maxBlockHeightFor,
  type ExpectedOffer,
  type Offer,
  type OfferRefusal,
} from '@quorum-on-near/protocol';
import type { KeyPair } from 'near-api-js';
import { AccessKeyNotFoundError, type BuyerChainReads } from './chain.ts';
import { transportReason } from './errors.ts';
import { checkAccessRequest, type GatewayClient, type OfferAnswer, type PaymentAnswer, type RedeemAnswer } from './gateway.ts';
import type { BuyerSettings } from './settings.ts';

/** What a payment is for: the pool and the seats requested, and the most the buyer pays, in base units. */
export interface PaymentRequest {
  poolId: number;
  seats: number;
  maxAmount: bigint;
}

/**
 * What a signed payment is: the nonce it uses, the final height it was signed at, and its
 * `max_block_height`, the last block at which its delegate can still be included. Once a final block
 * above `maxBlockHeight` (plus the few blocks the delegate's receipts take) has been seen, the payment
 * can no longer take seats.
 */
export interface SignedPayment {
  nonce: bigint;
  finalHeight: bigint;
  maxBlockHeight: bigint;
}

/**
 * The blocks after a payment's `maxBlockHeight` in which it may still take seats: a delegate included
 * at that height takes them a few receipts later (the token's transfer, the pools contract's
 * ft_on_transfer, the token's resolve). A payment whose result is unknown is settled once a final
 * block above `maxBlockHeight + SETTLE_MARGIN_BLOCKS` has been seen.
 */
export const SETTLE_MARGIN_BLOCKS = 20n;

/**
 * The answer to Buyer.pay: the gateway's, with the payment it answers in `signed`, or `declined` when
 * the buyer refused the offer and signed nothing.
 */
export type BuyerPaymentAnswer = (PaymentAnswer & { signed: SignedPayment }) | { kind: 'declined'; refusal: OfferRefusal };

/**
 * Why a payment was not sent: the account has no such key (`key_not_found`), the key's nonce or the
 * final height could not be read (`chain_read`), the payment could not be signed (`signing`), or no
 * connection to the gateway could be made (`gateway_unreachable`).
 */
export type PaymentNotSentReason = 'key_not_found' | 'chain_read' | 'signing' | 'gateway_unreachable';

/**
 * Buyer.pay failed before the payment left the buyer: nothing reached the gateway, so a new payment is
 * safe. The message is the buyer's own text, with at most the failure's transportReason, and never a
 * library's, which may quote the RPC URL or a body the RPC wrote; `cause` keeps the error behind it.
 */
export class PaymentNotSentError extends Error {
  override name = 'PaymentNotSentError';
  readonly reason: PaymentNotSentReason;

  constructor(reason: PaymentNotSentReason, message: string, cause: unknown) {
    super(message, { cause });
    this.reason = reason;
  }
}

/**
 * The payment was handed to the gateway and no documented answer came back: it may have been relayed,
 * and whether it took seats is unknown until a final block above `signed.maxBlockHeight` (plus the
 * blocks its receipts take) has been seen. The message is fixed text with the failure's
 * transportReason; `cause` keeps the error behind it.
 */
export class PaymentUnknownError extends Error {
  override name = 'PaymentUnknownError';
  readonly signed: SignedPayment;

  constructor(signed: SignedPayment, cause: unknown) {
    super(`the payment got no documented answer from the gateway (${transportReason(cause)}), and may have been relayed`, {
      cause,
    });
    this.signed = signed;
  }
}

/** What a Buyer acts with. */
export interface BuyerOptions {
  /** The buyer's own configuration: what it checks offers against, and how it reaches the gateway. */
  settings: Pick<BuyerSettings, 'network' | 'token' | 'poolsContract' | 'gatewayUrl' | 'blockTimeMs' | 'maxTimeoutSeconds'>;
  accountId: string;
  /** A full-access key of the account. */
  keyPair: KeyPair;
  gateway: Pick<GatewayClient, 'offer' | 'pay' | 'redeem'>;
  chain: BuyerChainReads;
  /** The clock that dates redemption proofs, in milliseconds since the epoch; Date.now by default. */
  now?: () => number;
}

/**
 * One buyer acting through the gateway with its own key. It signs a payment only for an offer that
 * its own settings and request accept, and sends each signed payment once: retrying is the caller's
 * choice, and always signs a new payment. A buyer makes one payment at a time, since a second one
 * signed before the first is relayed reads the same nonce, and the gateway refuses it.
 */
export class Buyer {
  readonly accountId: string;
  readonly #settings: BuyerOptions['settings'];
  readonly #keyPair: KeyPair;
  readonly #gateway: BuyerOptions['gateway'];
  readonly #chain: BuyerChainReads;
  readonly #now: () => number;
  /** The gateway's host, which redemption proofs name as their recipient. */
  readonly #recipient: string;

  constructor(opts: BuyerOptions) {
    this.accountId = opts.accountId;
    this.#settings = opts.settings;
    this.#keyPair = opts.keyPair;
    this.#gateway = opts.gateway;
    this.#chain = opts.chain;
    this.#now = opts.now ?? Date.now;
    this.#recipient = new URL(opts.settings.gatewayUrl).host;
  }

  /** Asks the gateway for its offer for `seats` seats of a pool. */
  offer(poolId: number, seats: number): Promise<OfferAnswer> {
    return this.#gateway.offer(poolId, seats);
  }

  /**
   * Pays `offer` for `request`. The offer is checked with checkOffer against the buyer's own network,
   * token and pools contract (never the offer's) and the request; a refused offer is answered
   * `declined`, with nothing read, signed or sent. Otherwise the payment is signed with the key's next
   * nonce, to expire after the shorter of `offer.maxTimeoutSeconds` and `settings.maxTimeoutSeconds`
   * from the final height (in blocks of `settings.blockTimeMs`), so that no offer makes the buyer sign
   * a payment that stays valid longer than its own bound, and sent once at the URL of
   * `request.seats`. The gateway's answer comes back with what was signed (`signed`).
   *
   * Rejects with PaymentNotSentError when the payment never left the buyer: the key is not on the
   * account, the nonce or the final height cannot be read, the payment cannot be signed, or the
   * connection to the gateway fails before it is made (ECONNREFUSED, ENOTFOUND, EAI_AGAIN). Rejects
   * with PaymentUnknownError for any other failure of the request once the payment is signed: it may
   * have reached the gateway, and redemption tells whether it landed. Throws RangeError, before
   * reading anything, for a request that no gateway request can carry (see checkAccessRequest).
   */
  async pay(offer: Offer, request: PaymentRequest): Promise<BuyerPaymentAnswer> {
    checkAccessRequest(request.poolId, request.seats);
    const { network, token, poolsContract, blockTimeMs, maxTimeoutSeconds } = this.#settings;
    const expected: ExpectedOffer = {
      network,
      token,
      poolsContract,
      poolId: request.poolId,
      maxSeats: request.seats,
      maxAmount: request.maxAmount,
    };
    const refusal = checkOffer(offer, expected);
    if (refusal !== null) return { kind: 'declined', refusal };
    const nonce = await this.#nextNonce();
    const finalHeight = await this.finalHeight().catch((error: unknown) => {
      const message = `could not read the final block from the RPC (${transportReason(error)}): nothing was sent`;
      throw new PaymentNotSentError('chain_read', message, error);
    });
    let signed: SignedPayment;
    let header: string;
    try {
      const maxBlockHeight = maxBlockHeightFor(finalHeight, Math.min(offer.maxTimeoutSeconds, maxTimeoutSeconds), blockTimeMs);
      signed = { nonce, finalHeight, maxBlockHeight };
      header = await buildPaymentHeader({ keyPair: this.#keyPair, senderId: this.accountId, nonce, maxBlockHeight, offer, expected });
    } catch (error) {
      throw new PaymentNotSentError('signing', 'could not sign the payment: nothing was sent', error);
    }
    let answer: PaymentAnswer;
    try {
      answer = await this.#gateway.pay(request.poolId, request.seats, header);
    } catch (error) {
      if (connectionNotMade(error)) {
        const message = `could not connect to the gateway (${transportReason(error)}): nothing was sent`;
        throw new PaymentNotSentError('gateway_unreachable', message, error);
      }
      throw new PaymentUnknownError(signed, error);
    }
    return { ...answer, signed };
  }

  /**
   * The latest final block's height, which the gateway checks a payment's expiry against. Rejects with
   * the chain's own error.
   */
  finalHeight(): Promise<bigint> {
    return this.#chain.finalHeight();
  }

  /** The key's next nonce; rejects with PaymentNotSentError, `key_not_found` or `chain_read`. */
  async #nextNonce(): Promise<bigint> {
    const publicKey = this.#keyPair.getPublicKey().toString();
    try {
      return await this.#chain.nextNonce(this.accountId, publicKey);
    } catch (error) {
      if (error instanceof AccessKeyNotFoundError) {
        const message = `${error.accountId} has no access key ${error.publicKey}: nothing was sent`;
        throw new PaymentNotSentError('key_not_found', message, error);
      }
      const reason = transportReason(error);
      const message = `could not read the nonce of ${this.accountId}'s key from the RPC (${reason}): nothing was sent`;
      throw new PaymentNotSentError('chain_read', message, error);
    }
  }

  /** Redeems with a new proof, signed now, naming the gateway's host as its recipient. */
  async redeem(poolId: number): Promise<RedeemAnswer> {
    const header = await buildRedeemProofHeader({
      keyPair: this.#keyPair,
      accountId: this.accountId,
      poolId,
      recipient: this.#recipient,
      nowMs: this.#now(),
    });
    return this.#gateway.redeem(poolId, header);
  }
}

/** The socket errors of a connection that was never made: nothing was written to it. */
const NOT_CONNECTED: ReadonlySet<string> = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);

/**
 * True when `error` is fetch's rejection (`TypeError: fetch failed`) for a connection that was never
 * made: its cause is a socket error in NOT_CONNECTED or, when the host had several addresses, an
 * AggregateError of such errors only. A failure after the connection was made, such as ECONNRESET or a
 * closed socket, may come after the payment was written, so it is never counted here.
 */
function connectionNotMade(error: unknown): boolean {
  return error instanceof TypeError && notConnected(error.cause);
}

function notConnected(cause: unknown): boolean {
  if (cause instanceof AggregateError) return cause.errors.length > 0 && cause.errors.every(notConnected);
  const code = (cause as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && NOT_CONNECTED.has(code);
}
