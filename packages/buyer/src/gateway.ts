import {
  PAYMENT_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PROOF_HEADER,
  decodeHeader,
  isAccountId,
  parseAmount,
  type Network,
  type Offer,
  type PaymentErrorCode,
  type PoolStatus,
  type ProofErrorCode,
} from '@quorum-on-near/protocol';

/** The most seats one request may ask for: the gateway's limit, the contract's largest target. */
export const MAX_SEATS_PER_REQUEST = 1000;

/** A row of `GET /pools`: an open pool of the gateway's provider with seats left, amounts in base units. */
export interface PoolListing {
  id: number;
  terms: string;
  seat_price: bigint;
  target: number;
  taken: number;
  deadline_ms: number;
  bonus: bigint;
  min_bonus_per_seat: bigint;
}

/** What an activity record is of: a relayed commit, a settlement, a pushed refund, or the dust sent back. */
export type ActivityKind = 'commit' | 'settle' | 'refund' | 'dust';

/**
 * One record of the gateway's activity feed. `at` is milliseconds since the epoch. `account` is the
 * buyer for a commit and for a buyer's refund, and the seller otherwise (a settlement, the dust, a
 * keeper call that moved nothing). `amount` is in the token's base units. `ok` is false for a commit
 * that took no seats, a refund that failed, and a keeper call that moved nothing.
 */
export interface ActivityRecord {
  at: number;
  poolId: number;
  kind: ActivityKind;
  account: string;
  seats: number;
  amount: bigint;
  txHash: string;
  ok: boolean;
}

/** The codes a redemption proof is refused with (`401`). */
export type RedeemErrorCode = ProofErrorCode | 'not_full_access' | 'replayed_proof';

/** The status of a refund, by the buyer's state on the contract. */
export type RefundStatus = 'refunded' | 'refund_pending' | 'claimable';

/** The answer to `GET /pools`. */
export type PoolsAnswer = { kind: 'pools'; pools: PoolListing[] } | { kind: 'unavailable' };

/** The answer to an offer request: `GET /pools/:id/access?seats=N` with no header. */
export type OfferAnswer =
  /** 402: the offer, for the seats requested or fewer. */
  | { kind: 'offer'; offer: Offer }
  /** 404: the gateway does not serve the pool. */
  | { kind: 'unknown_pool' }
  /** 409 `pool_closed`: filled, settled, or open with no seat left to offer. */
  | { kind: 'pool_closed'; status: Extract<PoolStatus, 'open' | 'filled' | 'settled'> }
  /** 410 `pool_expired`: past its deadline. */
  | { kind: 'pool_expired'; status: Extract<PoolStatus, 'expired' | 'refunded'> }
  /** 503: the gateway cannot read the chain. */
  | { kind: 'unavailable' };

/** The answer to a payment: `GET /pools/:id/access?seats=N` with `X-PAYMENT`. */
export type PaymentAnswer =
  /**
   * 202: the payment took `seats` seats and the pool is still open with `taken` of `target`.
   * `txHash` is the relayed transaction, from `X-PAYMENT-RESPONSE`.
   */
  | {
      kind: 'pending';
      txHash: string;
      poolId: number;
      buyer: string;
      seats: number;
      taken: number;
      target: number;
      deadlineMs: number;
    }
  /**
   * 200: the payment filled the pool. `seats` is every seat the buyer holds in the pool, not only
   * this payment's. `txHash` is the relayed transaction, from `X-PAYMENT-RESPONSE`.
   */
  | { kind: 'filled'; txHash: string; credential: string; poolId: number; seats: number; terms: string }
  /** 402: a check failed and nothing was relayed; `offer` is the offer as it stands, if there is one. */
  | { kind: 'refused'; error: PaymentErrorCode; offer: Offer | null }
  /** 409: the pool filled before the payment landed; the token returned the money. */
  | { kind: 'no_seats_taken' }
  /** 410 `pool_expired`: the pool expired before the payment landed; the token returned the money. */
  | { kind: 'pool_expired'; txHash: string }
  /** 502: the relay was refused, the delegate failed, or something other than a full pool refused the commit. */
  | { kind: 'relay_failed'; txHash: string }
  /** 502: the result is unknown, and the payment may still land: redemption tells. */
  | { kind: 'result_unknown'; txHash: string }
  /** 404: the gateway does not serve the pool. */
  | { kind: 'unknown_pool' }
  /** 503: the gateway could not read the chain, or had no relayer key free, and relayed nothing. */
  | { kind: 'unavailable' };

/** The answer to a redemption: `GET /pools/:id/access` with `X-QUORUM-PROOF`. */
export type RedeemAnswer =
  /** 202: the buyer holds `seats` seats and the pool is still open. */
  | { kind: 'pending'; seats: number; taken: number; target: number; deadlineMs: number }
  /** 200: the pool filled; the credential is for every seat the buyer holds. */
  | { kind: 'filled'; credential: string; poolId: number; seats: number; terms: string }
  /**
   * 410: the pool expired. `amount` is what the buyer's seats are refunded, `bonusShare` the part of it
   * that is bonus, and `txHash` the refund's transaction when the gateway's keeper sent it.
   */
  | { kind: 'refund'; status: RefundStatus; amount: bigint; bonusShare: bigint; txHash: string | null }
  /** 404: the account holds no seats in the pool. */
  | { kind: 'no_seats' }
  /** 401: the proof was refused. */
  | { kind: 'invalid_proof'; error: RedeemErrorCode }
  /** 404: the gateway does not serve the pool. */
  | { kind: 'unknown_pool' }
  /** 503: the gateway cannot read the chain. */
  | { kind: 'unavailable' };

/** The requests GatewayClient sends. */
export type GatewayRoute = 'pools' | 'offer' | 'payment' | 'redemption' | 'activity';

/**
 * An answer that is not one the gateway documents for the request: an unexpected status, a body that
 * is not JSON, or a field that is missing or malformed. The message names the request, the status and
 * the field, never a value from the body, which may hold a credential.
 */
export class GatewayResponseError extends Error {
  override name = 'GatewayResponseError';
  readonly route: GatewayRoute;
  readonly status: number;

  constructor(route: GatewayRoute, path: string, status: number, detail: string) {
    super(`the gateway's answer to the ${route} request GET ${path} is not a documented one: HTTP ${status}, ${detail}`);
    this.route = route;
    this.status = status;
  }
}

/**
 * A typed HTTP client of the gateway. Each method sends one GET request, never repeats it, and
 * returns the documented answer as a discriminated union on `kind`. Every body is checked field by
 * field, and only the documented fields are kept, since the gateway is outside the buyer's trust.
 * The strings a buyer passes on are bounded, so that an answer cannot carry megabytes of text to
 * whoever reads it: a pool's terms to the 280 UTF-8 bytes the pools contract keeps, a transaction
 * hash to the 44 base58 characters of a NEAR hash, and a credential to 4096 characters. An offer's
 * `resource` and `description` are kept as sent: nothing passes them on.
 *
 * Amounts: every amount of a type this client defines (PoolListing, ActivityRecord, a refund of
 * RedeemAnswer) is a bigint in the token's base units, converted once here from the gateway's decimal
 * string. The protocol's Offer keeps its amounts as the decimal strings of the wire, since the buyer
 * signs the offer as it was sent.
 *
 * Each request is aborted if its answer, body included, has not arrived within its time: 300 seconds
 * for a payment, which is more than the gateway's longest relay at its defaults (a 30-second wait for
 * a relayer key, the send, and a lookup that ends by the payment's expiry), and 30 seconds for every
 * other request. At most 1 MiB of a body is read; a longer body is an undocumented answer.
 * Rejects with RangeError, before sending anything, for a pool id that is not a non-negative safe
 * integer or a seat count outside 1 to MAX_SEATS_PER_REQUEST; with GatewayResponseError for an answer
 * that is not documented; with the abort's TimeoutError (a DOMException) for a request that ran out of
 * time; and with fetch's own error when no answer arrives otherwise. The client follows no redirect,
 * which would carry a payment or a proof to another server.
 */
export class GatewayClient {
  readonly #url: string;
  readonly #fetch: typeof fetch;
  readonly #payTimeoutMs: number;
  readonly #readTimeoutMs: number;

  /**
   * `gatewayUrl` is the gateway's base URL without a trailing slash, as BuyerSettings has it.
   * `payTimeoutMs` and `readTimeoutMs` replace the 300 and 30 seconds a payment and any other request
   * are given.
   */
  constructor(opts: { gatewayUrl: string; fetch?: typeof fetch; payTimeoutMs?: number; readTimeoutMs?: number }) {
    this.#url = opts.gatewayUrl;
    this.#fetch = opts.fetch ?? fetch;
    this.#payTimeoutMs = opts.payTimeoutMs ?? PAY_TIMEOUT_MS;
    this.#readTimeoutMs = opts.readTimeoutMs ?? READ_TIMEOUT_MS;
  }

  /** `GET /pools`: the open pools of the gateway's provider, in id order. */
  async pools(): Promise<PoolsAnswer> {
    return this.#get('pools', '/pools', {}, poolsAnswer, this.#readTimeoutMs);
  }

  /** The offer for `seats` seats of a pool. */
  async offer(poolId: number, seats: number): Promise<OfferAnswer> {
    return this.#get('offer', accessPath(poolId, seats), {}, offerAnswer, this.#readTimeoutMs);
  }

  /**
   * Sends a payment, at the URL of the seats requested (the payment may be for fewer, as a reduced
   * offer is). A RangeError is a rejection before anything is sent. Any other rejection, a
   * GatewayResponseError or a timeout included, may come after the payment reached the gateway, and
   * leaves it unknown whether it landed: redemption tells.
   */
  async pay(poolId: number, seats: number, paymentHeader: string): Promise<PaymentAnswer> {
    const headers = { [PAYMENT_HEADER]: paymentHeader };
    return this.#get('payment', accessPath(poolId, seats), headers, paymentAnswer, this.#payTimeoutMs);
  }

  /** Sends a redemption proof for a pool. */
  async redeem(poolId: number, proofHeader: string): Promise<RedeemAnswer> {
    checkPoolId(poolId);
    const headers = { [PROOF_HEADER]: proofHeader };
    return this.#get('redemption', `/pools/${poolId}/access`, headers, redeemAnswer, this.#readTimeoutMs);
  }

  /** `GET /activity?pool=<id>`: the pool's records in the activity feed, oldest first. */
  async activity(poolId: number): Promise<ActivityRecord[]> {
    checkPoolId(poolId);
    return this.#get('activity', `/activity?pool=${poolId}`, {}, activityAnswer, this.#readTimeoutMs);
  }

  async #get<T>(
    route: GatewayRoute,
    path: string,
    headers: Record<string, string>,
    read: Reader<T>,
    timeoutMs: number,
  ): Promise<T> {
    // The signal also bounds the reading of the body.
    const signal = AbortSignal.timeout(timeoutMs);
    const response = await this.#fetch(`${this.#url}${path}`, { headers, redirect: 'error', signal });
    try {
      return read(response.status, parseJson(await readBody(response)), response.headers);
    } catch (error) {
      if (error instanceof Malformed) throw new GatewayResponseError(route, path, response.status, error.message);
      throw error;
    }
  }
}

/**
 * The time a payment's answer is waited for: more than the gateway's longest relay at its defaults, a
 * 30-second wait for a relayer key, the send, and a lookup that ends by the payment's expiry.
 */
const PAY_TIMEOUT_MS = 300_000;
/** The time the answer to any other request is waited for. */
const READ_TIMEOUT_MS = 30_000;
/** The most bytes of a body read: the gateway's answers are a few kilobytes. */
const MAX_BODY_BYTES = 1024 * 1024;

/**
 * The body as UTF-8 text, read up to MAX_BODY_BYTES: a longer body is Malformed, and the rest of it is
 * not read.
 */
async function readBody(response: Response): Promise<string> {
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Malformed('the body is longer than 1 MiB');
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** Reads one route's answer; throws Malformed for anything that is not documented. */
type Reader<T> = (status: number, body: unknown, headers: Headers) => T;

/** An undocumented answer, described without quoting the body. */
class Malformed extends Error {}

type Fields = Record<string, unknown>;

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Malformed('the body is not JSON');
  }
}

function poolsAnswer(status: number, body: unknown): PoolsAnswer {
  if (status === 503) return unavailable(body);
  if (status !== 200) throw unexpectedStatus(status);
  return { kind: 'pools', pools: list(body, 'body').map((row, i) => poolListing(row, `body[${i}]`)) };
}

function offerAnswer(status: number, body: unknown): OfferAnswer {
  switch (status) {
    case 402: {
      const { error, accepts } = paymentRequiredBody(body);
      if (error !== 'payment required') throw new Malformed('body.error is not "payment required"');
      const [offer] = accepts;
      if (offer === undefined || accepts.length !== 1) throw new Malformed('body.accepts does not hold exactly one offer');
      return { kind: 'offer', offer };
    }
    case 404:
      expectError(body, 'unknown_pool');
      return { kind: 'unknown_pool' };
    case 409:
      expectError(body, 'pool_closed');
      return { kind: 'pool_closed', status: oneOf(fields(body, 'body'), 'status', 'body', ['open', 'filled', 'settled']) };
    case 410:
      expectError(body, 'pool_expired');
      return { kind: 'pool_expired', status: oneOf(fields(body, 'body'), 'status', 'body', ['expired', 'refunded']) };
    case 503:
      return unavailable(body);
  }
  throw unexpectedStatus(status);
}

function paymentAnswer(status: number, body: unknown, headers: Headers): PaymentAnswer {
  switch (status) {
    case 202: {
      const b = fields(body, 'body');
      literal(b, 'status', 'body', 'pending');
      const receipt = fields(b.receipt, 'body.receipt');
      const pool = fields(b.pool, 'body.pool');
      const txHash = paymentTransaction(headers);
      if (hash(receipt, 'txHash', 'body.receipt') !== txHash) {
        throw new Malformed(`body.receipt.txHash is not the transaction of ${PAYMENT_RESPONSE_HEADER}`);
      }
      return {
        kind: 'pending',
        txHash,
        poolId: integer(receipt, 'poolId', 'body.receipt'),
        buyer: account(receipt, 'buyer', 'body.receipt'),
        seats: integer(receipt, 'seats', 'body.receipt'),
        taken: integer(pool, 'taken', 'body.pool'),
        target: integer(pool, 'target', 'body.pool'),
        deadlineMs: integer(pool, 'deadlineMs', 'body.pool'),
      };
    }
    case 200:
      return { kind: 'filled', txHash: paymentTransaction(headers), ...filledBody(body) };
    case 402: {
      const { error, accepts } = paymentRequiredBody(body);
      if (!isCode(PAYMENT_ERRORS, error)) throw new Malformed('body.error is not a documented payment error');
      if (accepts.length > 1) throw new Malformed('body.accepts holds more than one offer');
      return { kind: 'refused', error, offer: accepts[0] ?? null };
    }
    case 409: {
      const { error, accepts } = paymentRequiredBody(body);
      if (error !== 'no_seats_taken') throw new Malformed('body.error is not "no_seats_taken"');
      if (accepts.length > 0) throw new Malformed('body.accepts is not empty');
      return { kind: 'no_seats_taken' };
    }
    case 410:
      expectError(body, 'pool_expired');
      return { kind: 'pool_expired', txHash: hash(fields(body, 'body'), 'txHash', 'body') };
    case 502: {
      const b = fields(body, 'body');
      const kind = oneOf(b, 'error', 'body', ['relay_failed', 'result_unknown']);
      return { kind, txHash: hash(b, 'txHash', 'body') };
    }
    case 404:
      expectError(body, 'unknown_pool');
      return { kind: 'unknown_pool' };
    case 503:
      return unavailable(body);
  }
  throw unexpectedStatus(status);
}

function redeemAnswer(status: number, body: unknown): RedeemAnswer {
  switch (status) {
    case 202: {
      const b = fields(body, 'body');
      literal(b, 'status', 'body', 'pending');
      return {
        kind: 'pending',
        seats: integer(b, 'seats', 'body'),
        taken: integer(b, 'taken', 'body'),
        target: integer(b, 'target', 'body'),
        deadlineMs: integer(b, 'deadlineMs', 'body'),
      };
    }
    case 200:
      return { kind: 'filled', ...filledBody(body) };
    case 410: {
      const b = fields(body, 'body');
      return {
        kind: 'refund',
        status: oneOf(b, 'status', 'body', ['refunded', 'refund_pending', 'claimable']),
        amount: baseUnits(b, 'amount', 'body'),
        bonusShare: baseUnits(b, 'bonusShare', 'body'),
        txHash: b.txHash === null ? null : hash(b, 'txHash', 'body'),
      };
    }
    case 401: {
      const error = text(fields(body, 'body'), 'error', 'body');
      if (!isCode(REDEEM_ERRORS, error)) throw new Malformed('body.error is not a documented proof error');
      return { kind: 'invalid_proof', error };
    }
    case 404: {
      const error = oneOf(fields(body, 'body'), 'error', 'body', ['unknown_pool', 'no_seats']);
      return { kind: error };
    }
    case 503:
      return unavailable(body);
  }
  throw unexpectedStatus(status);
}

function activityAnswer(status: number, body: unknown): ActivityRecord[] {
  if (status !== 200) throw unexpectedStatus(status);
  return list(body, 'body').map((value, i) => {
    const where = `body[${i}]`;
    const r = fields(value, where);
    if (typeof r.ok !== 'boolean') throw new Malformed(`${where}.ok is not a boolean`);
    return {
      at: integer(r, 'at', where),
      poolId: integer(r, 'poolId', where),
      kind: oneOf(r, 'kind', where, ['commit', 'settle', 'refund', 'dust']),
      account: account(r, 'account', where),
      seats: integer(r, 'seats', where),
      amount: baseUnits(r, 'amount', where),
      txHash: hash(r, 'txHash', where),
      ok: r.ok,
    };
  });
}

/** A `{x402Version: 1, error, accepts}` body. Its offers keep only their documented fields. */
function paymentRequiredBody(body: unknown): { error: string; accepts: Offer[] } {
  const b = fields(body, 'body');
  if (b.x402Version !== 1) throw new Malformed('body.x402Version is not 1');
  const accepts = list(b.accepts, 'body.accepts').map((offer, i) => readOffer(offer, `body.accepts[${i}]`));
  return { error: text(b, 'error', 'body'), accepts };
}

function readOffer(value: unknown, where: string): Offer {
  const o = fields(value, where);
  literal(o, 'scheme', where, 'quorum');
  literal(o, 'mimeType', where, 'application/json');
  const maxTimeoutSeconds = integer(o, 'maxTimeoutSeconds', where);
  if (maxTimeoutSeconds < 1) throw new Malformed(`${where}.maxTimeoutSeconds is not positive`);
  const at = `${where}.extra`;
  const extra = fields(o.extra, at);
  return {
    scheme: 'quorum',
    network: network(o, 'network', where),
    maxAmountRequired: amount(o, 'maxAmountRequired', where),
    resource: text(o, 'resource', where),
    description: text(o, 'description', where),
    mimeType: 'application/json',
    payTo: account(o, 'payTo', where),
    maxTimeoutSeconds,
    asset: account(o, 'asset', where),
    extra: {
      poolId: integer(extra, 'poolId', at),
      seats: integer(extra, 'seats', at),
      seatPrice: amount(extra, 'seatPrice', at),
      target: integer(extra, 'target', at),
      taken: integer(extra, 'taken', at),
      deadlineMs: integer(extra, 'deadlineMs', at),
      bonus: amount(extra, 'bonus', at),
      minBonusPerSeat: amount(extra, 'minBonusPerSeat', at),
      terms: terms(extra, 'terms', at),
      relayer: account(extra, 'relayer', at),
      minGas: amount(extra, 'minGas', at),
      maxGas: amount(extra, 'maxGas', at),
    },
  };
}

function poolListing(value: unknown, where: string): PoolListing {
  const p = fields(value, where);
  return {
    id: integer(p, 'id', where),
    terms: terms(p, 'terms', where),
    seat_price: baseUnits(p, 'seat_price', where),
    target: integer(p, 'target', where),
    taken: integer(p, 'taken', where),
    deadline_ms: integer(p, 'deadline_ms', where),
    bonus: baseUnits(p, 'bonus', where),
    min_bonus_per_seat: baseUnits(p, 'min_bonus_per_seat', where),
  };
}

/** A `{status: "filled", credential, poolId, seats, terms}` body. */
function filledBody(body: unknown): { credential: string; poolId: number; seats: number; terms: string } {
  const b = fields(body, 'body');
  literal(b, 'status', 'body', 'filled');
  const credential = text(b, 'credential', 'body');
  if (credential.length > MAX_CREDENTIAL_LENGTH) throw new Malformed(`body.credential is longer than ${MAX_CREDENTIAL_LENGTH} characters`);
  if (!COMPACT_JWS.test(credential)) throw new Malformed('body.credential is not a compact JWS');
  return { credential, poolId: integer(b, 'poolId', 'body'), seats: integer(b, 'seats', 'body'), terms: terms(b, 'terms', 'body') };
}

/** The transaction named by a well-formed `X-PAYMENT-RESPONSE` header. */
function paymentTransaction(headers: Headers): string {
  const where = `the ${PAYMENT_RESPONSE_HEADER} header`;
  const header = headers.get(PAYMENT_RESPONSE_HEADER);
  if (header === null) throw new Malformed(`${where} is missing`);
  let value: unknown;
  try {
    value = decodeHeader(header);
  } catch {
    throw new Malformed(`${where} is not base64 of JSON`);
  }
  const response = fields(value, where);
  if (response.success !== true) throw new Malformed(`${where} does not say success`);
  network(response, 'network', where);
  account(response, 'payer', where);
  return hash(response, 'transaction', where);
}

function unavailable(body: unknown): { kind: 'unavailable' } {
  expectError(body, 'chain_unavailable');
  return { kind: 'unavailable' };
}

function expectError(body: unknown, error: string): void {
  literal(fields(body, 'body'), 'error', 'body', error);
}

function unexpectedStatus(status: number): Malformed {
  return new Malformed(`status ${status} is not one this request is answered with`);
}

/** Every code a payment is refused with (`402`); a Record so that the compiler checks it is complete. */
const PAYMENT_ERRORS: Record<PaymentErrorCode, true> = {
  invalid_payload: true,
  invalid_signature: true,
  wrong_receiver: true,
  wrong_method: true,
  wrong_deposit: true,
  gas_too_low: true,
  gas_too_high: true,
  wrong_args: true,
  wrong_amount: true,
  wrong_pool: true,
  not_full_access: true,
  stale_nonce: true,
  nonce_too_large: true,
  expired: true,
  pool_closed: true,
  insufficient_balance: true,
  seller_commit: true,
  over_buyer_cap: true,
  payment_in_flight: true,
};

/** Every code a redemption proof is refused with (`401`). */
const REDEEM_ERRORS: Record<RedeemErrorCode, true> = {
  invalid_proof: true,
  wrong_message: true,
  wrong_recipient: true,
  stale_proof: true,
  invalid_signature: true,
  not_full_access: true,
  replayed_proof: true,
};

function isCode<T extends string>(codes: Record<T, true>, value: string): value is T {
  return Object.hasOwn(codes, value);
}

const COMPACT_JWS = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
/**
 * A NEAR transaction hash: 32 bytes in base58, at most 44 characters, fewer when it starts with
 * zero bytes (each written `1`). The alphabet also keeps control characters out of logs.
 */
const TX_HASH = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** The most UTF-8 bytes of terms the pools contract keeps for a pool. */
const MAX_TERMS_BYTES = 280;
/** The longest credential accepted, in characters: the gateway's are a few hundred. */
const MAX_CREDENTIAL_LENGTH = 4096;

function accessPath(poolId: number, seats: number): string {
  checkAccessRequest(poolId, seats);
  return `/pools/${poolId}/access?seats=${seats}`;
}

/**
 * Throws RangeError unless `poolId` is a non-negative safe integer and `seats` is from 1 to
 * MAX_SEATS_PER_REQUEST: the offer and payment requests GatewayClient refuses to send.
 */
export function checkAccessRequest(poolId: number, seats: number): void {
  checkPoolId(poolId);
  if (!Number.isSafeInteger(seats) || seats < 1 || seats > MAX_SEATS_PER_REQUEST) {
    throw new RangeError(`a request asks for 1 to ${MAX_SEATS_PER_REQUEST} seats, not ${seats}`);
  }
}

function checkPoolId(poolId: number): void {
  if (!Number.isSafeInteger(poolId) || poolId < 0) throw new RangeError(`invalid pool id: ${poolId}`);
}

function fields(value: unknown, where: string): Fields {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Malformed(`${where} is not an object`);
  return value as Fields;
}

function list(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) throw new Malformed(`${where} is not an array`);
  return value;
}

function literal(o: Fields, key: string, where: string, value: string): void {
  if (o[key] !== value) throw new Malformed(`${where}.${key} is not ${JSON.stringify(value)}`);
}

function oneOf<T extends string>(o: Fields, key: string, where: string, values: readonly T[]): T {
  const value = values.find((v) => v === o[key]);
  if (value === undefined) throw new Malformed(`${where}.${key} is not one of ${values.join(', ')}`);
  return value;
}

function text(o: Fields, key: string, where: string): string {
  const value = o[key];
  if (typeof value !== 'string') throw new Malformed(`${where}.${key} is not a string`);
  return value;
}

/** A pool's terms: a string of at most MAX_TERMS_BYTES in UTF-8, as the pools contract keeps them. */
function terms(o: Fields, key: string, where: string): string {
  const value = text(o, key, where);
  if (Buffer.byteLength(value, 'utf8') > MAX_TERMS_BYTES) {
    throw new Malformed(`${where}.${key} is longer than the ${MAX_TERMS_BYTES} bytes the pools contract keeps`);
  }
  return value;
}

/** A non-negative safe integer. */
function integer(o: Fields, key: string, where: string): number {
  const value = o[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Malformed(`${where}.${key} is not a non-negative integer`);
  }
  return value;
}

/** An amount as a decimal string, kept as the string: the protocol's Offer holds amounts so. */
function amount(o: Fields, key: string, where: string): string {
  const value = o[key];
  if (typeof value !== 'string' || parseAmount(value) === null) throw new Malformed(`${where}.${key} is not a decimal amount`);
  return value;
}

/** An amount written as a decimal string, read into base units: the form of the client's own types. */
function baseUnits(o: Fields, key: string, where: string): bigint {
  const value = parseAmount(o[key]);
  if (value === null) throw new Malformed(`${where}.${key} is not a decimal amount`);
  return value;
}

function account(o: Fields, key: string, where: string): string {
  const value = o[key];
  if (typeof value !== 'string' || !isAccountId(value)) throw new Malformed(`${where}.${key} is not a NEAR account id`);
  return value;
}

function hash(o: Fields, key: string, where: string): string {
  const value = o[key];
  if (typeof value !== 'string' || !TX_HASH.test(value)) throw new Malformed(`${where}.${key} is not a base58 transaction hash`);
  return value;
}

function network(o: Fields, key: string, where: string): Network {
  const value = o[key];
  if (typeof value !== 'string' || !value.startsWith('near:')) throw new Malformed(`${where}.${key} is not a NEAR network`);
  return value as Network;
}
