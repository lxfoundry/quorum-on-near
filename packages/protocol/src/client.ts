import { randomBytes } from 'node:crypto';
import { KeyPairSigner, actions, buildDelegateAction, encodeSignedDelegate } from 'near-api-js';
import type { KeyPair } from 'near-api-js';
import { parseAmount, priceOf } from './amounts.ts';
import type { ExpectedPayment } from './checks.ts';
import { encodeHeader } from './codec.ts';
import type { PaymentPayload } from './codec.ts';
import { ONE_YOCTO, SCHEME, X402_VERSION } from './constants.ts';
import { commitMsg } from './contract.ts';
import { redeemMessage } from './nep413.ts';
import type { RedeemProof } from './nep413.ts';
import type { Offer } from './offer.ts';

/**
 * Pure builders for buyers: no network access. The caller supplies the key's next nonce and the
 * maximum block height.
 */
export interface PaymentInput {
  keyPair: KeyPair;
  senderId: string;
  /** The access key's current on-chain nonce plus 1, or higher. */
  nonce: bigint;
  maxBlockHeight: bigint;
  offer: Offer;
  /** The buyer's own configuration, its request and its budget, which the offer must match. */
  expected: ExpectedOffer;
  /**
   * Gas for the inner ft_transfer_call; defaults to the offer's maxGas, the most the gateway accepts
   * and the least likely to run out. The relayer prepays it and is refunded what the call does not
   * use, under the protocol's refund rules.
   */
  gas?: bigint;
}

/**
 * Builds and signs the delegate action for an offer that checkOffer accepts (OfferRefusedError
 * otherwise): one `ft_transfer_call` on the expected token, to the expected pools contract, for
 * `offer.maxAmountRequired`, with the commit msg for `extra.poolId` and `extra.seats` and
 * 1 yoctoNEAR attached. The payment is therefore for the pool asked for, for at most the seats asked
 * for, and for at most `expected.maxAmount`; within that budget, the seat price is the offer's.
 * Returns the `X-PAYMENT` header value.
 */
export async function buildPaymentHeader(input: PaymentInput): Promise<string> {
  const { keyPair, senderId, nonce, maxBlockHeight, offer, expected, gas } = input;
  const refusal = checkOffer(offer, expected);
  if (refusal !== null) throw new OfferRefusedError(refusal);
  const { extra } = offer;
  const args = {
    receiver_id: expected.poolsContract,
    amount: offer.maxAmountRequired,
    msg: commitMsg(extra.poolId, extra.seats),
  };
  const transfer = actions.functionCall('ft_transfer_call', args, gas ?? BigInt(extra.maxGas), ONE_YOCTO);
  const delegateAction = buildDelegateAction({
    senderId,
    receiverId: expected.token,
    actions: [transfer],
    nonce,
    maxBlockHeight,
    publicKey: keyPair.getPublicKey(),
  });
  const { signedDelegate } = await new KeyPairSigner(keyPair).signDelegateAction(delegateAction);
  const payment: PaymentPayload = {
    x402Version: X402_VERSION,
    scheme: SCHEME,
    network: expected.network,
    payload: { signedDelegate: base64(encodeSignedDelegate(signedDelegate)) },
  };
  return encodeHeader(payment);
}

/**
 * What a buyer requires of every offer before it signs one. The network, the token and the pools
 * contract come from its own configuration: an offer names the contract the tokens are sent to, so
 * these never come from the gateway. `poolId` and `maxSeats` are the pool and the seats of the
 * request the offer answers. Nothing here bounds the seat price except `maxAmount`.
 */
export interface ExpectedOffer extends Pick<ExpectedPayment, 'network' | 'token' | 'poolsContract' | 'poolId' | 'maxSeats'> {
  /** The most the buyer pays for this payment, in the token's base units. */
  maxAmount: bigint;
}

export type OfferErrorCode =
  | 'invalid_offer'
  | 'wrong_scheme'
  | 'wrong_network'
  | 'wrong_asset'
  | 'wrong_pay_to'
  | 'wrong_pool'
  | 'too_many_seats'
  | 'wrong_amount'
  | 'over_budget';

export interface OfferRefusal {
  code: OfferErrorCode;
  detail: string;
}

/**
 * Checks an offer against the buyer's configuration, request and budget, in this order: the scheme
 * is `quorum`; the network, `asset` and `payTo` are the expected network, token and pools contract;
 * the fields the payment is built from are well formed (`extra.poolId` a non-negative integer,
 * `extra.seats` a positive integer, `maxAmountRequired`, `extra.seatPrice` and `extra.maxGas` decimal
 * strings); `extra.poolId` is the expected pool; `extra.seats` is at most `maxSeats` (fewer is a
 * reduced offer); `maxAmountRequired` is exactly `extra.seats × extra.seatPrice`; and it is at most
 * `maxAmount`. Returns the first refusal, or null when the offer may be signed. Never throws,
 * whatever the offer's field values.
 *
 * This bounds what the payment commits to and what it costs. The rest of the offer is the gateway's
 * word: the seat price within the budget, the gas figures, the timeout and what `extra` says of the
 * pool, which a buyer that relies on it reads from the chain.
 */
export function checkOffer(offer: Offer, expected: ExpectedOffer): OfferRefusal | null {
  if (offer.scheme !== SCHEME) return refuse('wrong_scheme', `the scheme is not ${SCHEME}`);
  if (offer.network !== expected.network) return refuse('wrong_network', `the network is not ${expected.network}`);
  if (offer.asset !== expected.token) return refuse('wrong_asset', `the asset is not ${expected.token}`);
  if (offer.payTo !== expected.poolsContract) return refuse('wrong_pay_to', `payTo is not ${expected.poolsContract}`);

  const { extra } = offer;
  if (typeof extra !== 'object' || extra === null) return refuse('invalid_offer', 'extra is not an object');
  const { poolId, seats } = extra;
  if (!Number.isSafeInteger(poolId) || poolId < 0) return refuse('invalid_offer', 'extra.poolId is not a non-negative integer');
  if (!Number.isSafeInteger(seats) || seats < 1) return refuse('invalid_offer', 'extra.seats is not a positive integer');
  const amount = parseAmount(offer.maxAmountRequired);
  const seatPrice = parseAmount(extra.seatPrice);
  if (amount === null || seatPrice === null || parseAmount(extra.maxGas) === null) {
    return refuse('invalid_offer', 'maxAmountRequired, extra.seatPrice and extra.maxGas must be decimal strings');
  }

  if (poolId !== expected.poolId) return refuse('wrong_pool', `extra.poolId is not ${expected.poolId}, the pool asked for`);
  if (seats > expected.maxSeats) {
    return refuse('too_many_seats', `extra.seats is above ${expected.maxSeats}, the seats asked for`);
  }

  const price = priceOf(seats, seatPrice);
  if (amount !== price) {
    return refuse('wrong_amount', `maxAmountRequired is not ${price}, the price of ${seats} seats at ${seatPrice}`);
  }
  if (amount > expected.maxAmount) return refuse('over_budget', `maxAmountRequired is above ${expected.maxAmount}, the budget`);
  return null;
}

/** Thrown by buildPaymentHeader, before anything is signed, for an offer that checkOffer refuses. */
export class OfferRefusedError extends Error {
  override name = 'OfferRefusedError';
  readonly code: OfferErrorCode;

  constructor(refusal: OfferRefusal) {
    super(`offer refused (${refusal.code}): ${refusal.detail}`);
    this.code = refusal.code;
  }
}

/**
 * `finalHeight + floor(maxTimeoutSeconds × 1000 / blockTimeMs)`: the latest expiry an offer allows,
 * from the chain's final height (the gateway judges expiry against it).
 */
export function maxBlockHeightFor(finalHeight: bigint, maxTimeoutSeconds: number, blockTimeMs: number): bigint {
  return finalHeight + BigInt(Math.floor((maxTimeoutSeconds * 1000) / blockTimeMs));
}

export interface ProofInput {
  keyPair: KeyPair;
  accountId: string;
  poolId: number;
  /** The gateway's host, such as `localhost:8402`. */
  recipient: string;
  nowMs: number;
  /** 24 random bytes for the rest of the nonce; generated when omitted. */
  random?: Uint8Array;
}

const TIME_BYTES = 8;
const RANDOM_BYTES = 24;

/** Builds and signs a redemption proof and returns the `X-QUORUM-PROOF` header value. */
export async function buildRedeemProofHeader(input: ProofInput): Promise<string> {
  const { keyPair, accountId, poolId, recipient, nowMs, random = randomBytes(RANDOM_BYTES) } = input;
  const nonce = proofNonce(nowMs, random);
  const message = redeemMessage(poolId);
  const signed = await new KeyPairSigner(keyPair).signNep413Message(accountId, { message, recipient, nonce });
  const proof: RedeemProof = {
    accountId: signed.accountId,
    publicKey: signed.publicKey.toString(),
    signature: base64(signed.signature),
    message,
    nonce: base64(nonce),
    recipient,
  };
  return encodeHeader(proof);
}

/** The 32-byte NEP-413 nonce: `nowMs` as a big-endian u64, then the random bytes. */
function proofNonce(nowMs: number, random: Uint8Array): Uint8Array {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new RangeError(`invalid nowMs: ${nowMs}`);
  if (random.length !== RANDOM_BYTES) {
    throw new RangeError(`random must be ${RANDOM_BYTES} bytes, got ${random.length}`);
  }
  const nonce = new Uint8Array(TIME_BYTES + RANDOM_BYTES);
  new DataView(nonce.buffer).setBigUint64(0, BigInt(nowMs));
  nonce.set(random, TIME_BYTES);
  return nonce;
}

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function refuse(code: OfferErrorCode, detail: string): OfferRefusal {
  return { code, detail };
}
