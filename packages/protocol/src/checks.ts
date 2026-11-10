import { isAccountId } from './account.ts';
import { parseAmount, priceOf } from './amounts.ts';
import { decodeHeader } from './codec.ts';
import { ONE_YOCTO, SCHEME, X402_VERSION } from './constants.ts';
import type { Network } from './constants.ts';
import { decodeSignedDelegate, delegatePublicKey, onlyFunctionCall, verifyDelegateSignature } from './delegate.ts';
import type { Bytes, DecodedSignedDelegate } from './delegate.ts';

/** Codes of the static checks (spec section 6.4, rows 1 to 3), made without network access. */
export type StaticErrorCode =
  | 'invalid_payload'
  | 'invalid_signature'
  | 'wrong_receiver'
  | 'wrong_method'
  | 'wrong_deposit'
  | 'gas_too_low'
  | 'gas_too_high'
  | 'wrong_args'
  | 'wrong_amount'
  | 'wrong_pool';

/** Codes of the gateway's chain checks and its own guards. */
export type GatewayErrorCode =
  | 'not_full_access'
  | 'stale_nonce'
  | 'nonce_too_large'
  | 'expired'
  | 'pool_closed'
  | 'insufficient_balance'
  | 'seller_commit'
  | 'over_buyer_cap'
  | 'payment_in_flight';

export type PaymentErrorCode = StaticErrorCode | GatewayErrorCode;

/** What a payment must match. */
export interface ExpectedPayment {
  network: Network;
  token: string;
  poolsContract: string;
  poolId: number;
  /**
   * The seats asked for in the request. A payment may commit to fewer, as when the buyer answers a
   * reduced offer at the URL it first requested, but to no more.
   */
  maxSeats: number;
  seatPrice: bigint;
  minGas: bigint;
  maxGas: bigint;
}

/** A payment that passed the static checks. */
export interface CheckedPayment {
  signedDelegate: DecodedSignedDelegate;
  senderId: string;
  publicKey: string;
  nonce: bigint;
  maxBlockHeight: bigint;
  gas: bigint;
  amount: bigint;
  poolId: number;
  /** The seats the payment commits to, between 1 and the expected `maxSeats`. */
  seats: number;
}

export type StaticCheckResult =
  | { ok: true; payment: CheckedPayment }
  | { ok: false; code: StaticErrorCode; detail: string };

type Failure = Extract<StaticCheckResult, { ok: false }>;

const METHOD = 'ft_transfer_call';
/**
 * Strict UTF-8 that keeps a leading byte order mark, so that JSON.parse refuses args that start with
 * one, as serde_json does.
 */
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * Runs checks 1 to 3 of spec section 6.4 on an `X-PAYMENT` header value, in the table's order, and
 * returns the first failure. Never throws.
 */
export function checkPaymentHeader(header: string, expected: ExpectedPayment): StaticCheckResult {
  // Check 1: the payload and the signature.
  const signed = decodePayment(header, expected.network);
  if (isFailure(signed)) return signed;
  if (!verifyDelegateSignature(signed)) {
    return fail('invalid_signature', 'the signature is not valid for the delegate public key');
  }

  // Check 2: one ft_transfer_call on the token, with 1 yoctoNEAR and gas within bounds.
  const delegate = signed.delegateAction;
  if (delegate.receiverId !== expected.token) return fail('wrong_receiver', `the receiver is not ${expected.token}`);
  const call = onlyFunctionCall(delegate);
  if (call === null || call.methodName !== METHOD) {
    return fail('wrong_method', `the delegate must hold exactly one FunctionCall to ${METHOD}`);
  }
  if (call.deposit !== ONE_YOCTO) return fail('wrong_deposit', `the deposit is ${call.deposit}, not 1 yoctoNEAR`);
  if (call.gas < expected.minGas) return fail('gas_too_low', `the gas is ${call.gas}, below ${expected.minGas}`);
  if (call.gas > expected.maxGas) return fail('gas_too_high', `the gas is ${call.gas}, above ${expected.maxGas}`);

  // Check 3: the arguments match the offer, and the amount pays for the seats in the msg.
  const args = parseArgs(call.args);
  if (args === null) {
    return fail('wrong_args', 'the args must be compact JSON of an object of exactly receiver_id, amount and msg, as strings');
  }
  if (args.receiver_id !== expected.poolsContract) {
    return fail('wrong_args', `receiver_id is not ${expected.poolsContract}`);
  }
  const amount = parseAmount(args.amount);
  if (amount === null) return fail('wrong_args', 'amount is not a decimal string');
  const commit = parseCommit(args.msg);
  if (commit === null) return fail('wrong_args', 'msg must be exactly {"commit":{"pool_id":<integer>,"seats":<integer>}}');
  if (commit.pool_id !== expected.poolId || commit.seats < 1 || commit.seats > expected.maxSeats) {
    return fail(
      'wrong_pool',
      `msg commits ${commit.seats} seats to pool ${commit.pool_id}, not 1 to ${expected.maxSeats} seats to pool ${expected.poolId}`,
    );
  }
  const price = priceOf(commit.seats, expected.seatPrice);
  if (amount !== price) return fail('wrong_amount', `the amount is ${amount}, not ${price} for ${commit.seats} seats`);

  return {
    ok: true,
    payment: {
      signedDelegate: signed,
      senderId: delegate.senderId,
      publicKey: delegatePublicKey(delegate),
      nonce: delegate.nonce,
      maxBlockHeight: delegate.maxBlockHeight,
      gas: call.gas,
      amount,
      poolId: commit.pool_id,
      seats: commit.seats,
    },
  };
}

/** The signed delegate of a well-formed `quorum` payment header for `network`. */
function decodePayment(header: string, network: Network): DecodedSignedDelegate | Failure {
  let value: unknown;
  try {
    value = decodeHeader(header);
  } catch {
    return fail('invalid_payload', 'the header is not base64 of JSON');
  }
  if (!isRecord(value)) return fail('invalid_payload', 'the header is not a JSON object');
  if (value.x402Version !== X402_VERSION) return fail('invalid_payload', `x402Version is not ${X402_VERSION}`);
  if (value.scheme !== SCHEME) return fail('invalid_payload', `the scheme is not ${SCHEME}`);
  if (value.network !== network) return fail('invalid_payload', `the network is not ${network}`);
  const { payload } = value;
  if (!isRecord(payload) || typeof payload.signedDelegate !== 'string') {
    return fail('invalid_payload', 'payload.signedDelegate is missing');
  }
  const bytes = decodeBase64(payload.signedDelegate);
  if (bytes === null) return fail('invalid_payload', 'payload.signedDelegate is not base64');
  let signed: DecodedSignedDelegate;
  try {
    signed = decodeSignedDelegate(bytes);
  } catch {
    return fail('invalid_payload', 'payload.signedDelegate is not a Borsh SignedDelegate');
  }
  // The chain refuses a delegate whose account ids are invalid, so it is not a valid payload.
  if (!isAccountId(signed.delegateAction.senderId) || !isAccountId(signed.delegateAction.receiverId)) {
    return fail('invalid_payload', 'the delegate sender or receiver is not a valid account id');
  }
  return signed;
}

interface TransferArgs {
  receiver_id: string;
  amount: string;
  msg: string;
}

/**
 * The ft_transfer_call args, when they are UTF-8 JSON of exactly receiver_id, amount and msg, all
 * strings, written in compact form.
 */
function parseArgs(bytes: Bytes): TransferArgs | null {
  let text: string;
  try {
    text = UTF8.decode(Uint8Array.from(bytes));
  } catch {
    return null;
  }
  const args = parseObject(text);
  // JSON.parse keeps the last of duplicate keys, where the token's parser may keep the first or refuse
  // them. Requiring the text to be what JSON.stringify writes for its value, as near-api-js does,
  // refuses duplicate keys, whitespace and escapes that JSON.stringify would not write.
  if (args === null || text !== JSON.stringify(args)) return null;
  if (!hasExactKeys(args, ['receiver_id', 'amount', 'msg'])) return null;
  const { receiver_id, amount, msg } = args;
  if (typeof receiver_id !== 'string' || typeof amount !== 'string' || typeof msg !== 'string') return null;
  return { receiver_id, amount, msg };
}

/** The commit in a msg of exactly `{"commit":{"pool_id":<integer>,"seats":<integer>}}`. */
function parseCommit(msg: string): { pool_id: number; seats: number } | null {
  const value = parseObject(msg);
  if (value === null || !hasExactKeys(value, ['commit'])) return null;
  const { commit } = value;
  if (!isRecord(commit) || !hasExactKeys(commit, ['pool_id', 'seats'])) return null;
  const { pool_id, seats } = commit;
  if (!isSafeInteger(pool_id) || !isSafeInteger(seats)) return null;
  // JSON.parse accepts integers written as 7.0, 7e0 or -0 and duplicate keys, which the contract's
  // serde_json refuses for these fields. With the keys known, the msg holds only those keys,
  // integers and punctuation, so up to whitespace it must equal the compact form of its value.
  if (msg.replace(/[ \t\n\r]/g, '') !== JSON.stringify(value)) return null;
  return { pool_id, seats };
}

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

/** Standard base64 with padding; null unless `text` is exactly the encoding of the bytes it decodes to. */
function decodeBase64(text: string): Uint8Array | null {
  const bytes = Buffer.from(text, 'base64');
  return bytes.toString('base64') === text ? new Uint8Array(bytes) : null;
}

function isFailure(value: DecodedSignedDelegate | Failure): value is Failure {
  return 'ok' in value;
}

function fail(code: StaticErrorCode, detail: string): Failure {
  return { ok: false, code, detail };
}
