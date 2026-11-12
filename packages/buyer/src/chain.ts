import { isAccountId, parseAmount, type PoolStatus, type PoolView } from '@quorum-on-near/protocol';
import type { Provider } from 'near-api-js';
import { AccessKeyDoesNotExistError, AccountDoesNotExistError } from 'near-api-js/rpc-errors';

/** What a buyer reads from the chain to sign a payment. */
export interface BuyerChainReads {
  /** The nonce the key's next signature must use: its on-chain nonce plus 1. */
  nextNonce(accountId: string, publicKey: string): Promise<bigint>;
  /** The height of the latest final block, which the gateway checks a payment's expiry against. */
  finalHeight(): Promise<bigint>;
}

/** The account does not exist, or has no access key `publicKey`, so it cannot sign with that key. */
export class AccessKeyNotFoundError extends Error {
  override name = 'AccessKeyNotFoundError';
  readonly accountId: string;
  readonly publicKey: string;

  constructor(accountId: string, publicKey: string) {
    super(`${accountId} has no access key ${publicKey}`);
    this.accountId = accountId;
    this.publicKey = publicKey;
  }
}

/**
 * BuyerChainReads over near-api-js's JSON-RPC provider. The key is read at optimistic finality, as the
 * gateway reads it, so its nonce counts every payment the gateway has already relayed; the height is
 * the latest final block's.
 */
export class RpcBuyerChain implements BuyerChainReads {
  readonly #provider: Provider;

  constructor(provider: Provider) {
    this.#provider = provider;
  }

  /** Throws AccessKeyNotFoundError when the account or the key does not exist. */
  async nextNonce(accountId: string, publicKey: string): Promise<bigint> {
    try {
      const key = await this.#provider.viewAccessKey({ accountId, publicKey, finalityQuery: { finality: 'optimistic' } });
      return key.nonce + 1n;
    } catch (error) {
      if (error instanceof AccessKeyDoesNotExistError || error instanceof AccountDoesNotExistError) {
        throw new AccessKeyNotFoundError(accountId, publicKey);
      }
      throw error;
    }
  }

  async finalHeight(): Promise<bigint> {
    const { header } = await this.#provider.viewBlock({ finality: 'final' });
    return BigInt(header.height);
  }
}

/**
 * What a buyer reads of a pool from the chain, the source that does not rest on the gateway's word:
 * the gateway's offers and listings say what it reads, and a buyer that relies on a pool's facts checks
 * them here.
 */
export interface PoolReads {
  /** The pool's view, as the pools contract's `get_pool` returns it; null when it has no such pool. */
  getPool(poolId: number): Promise<PoolView | null>;
}

/**
 * A `get_pool` result that is not a pool view: not a JSON object, or a field missing or malformed. The
 * message names the field and never quotes the result, whose text (the terms) is the seller's.
 */
export class PoolViewError extends Error {
  override name = 'PoolViewError';
  readonly poolId: number;

  constructor(poolsContract: string, poolId: number, detail: string) {
    super(`${poolsContract} answered get_pool for pool ${poolId} with ${detail}`);
    this.poolId = poolId;
  }
}

/**
 * PoolReads over near-api-js's JSON-RPC provider: `get_pool` on the pools contract at optimistic
 * finality, as the gateway reads it, so a pool the gateway has just seen open is not reported missing.
 * Every field of the view is checked, and only those fields are kept; the terms are bounded to the
 * MAX_TERMS_BYTES the contract keeps, as GatewayClient bounds the gateway's. Throws RangeError, reading
 * nothing, for a pool id that is not a non-negative safe integer, PoolViewError for a result that is
 * not a pool view, and the provider's error for a failed read.
 */
export class RpcPoolReads implements PoolReads {
  readonly #provider: Provider;
  readonly #poolsContract: string;

  constructor(provider: Provider, poolsContract: string) {
    this.#provider = provider;
    this.#poolsContract = poolsContract;
  }

  async getPool(poolId: number): Promise<PoolView | null> {
    if (!Number.isSafeInteger(poolId) || poolId < 0) throw new RangeError(`invalid pool id: ${poolId}`);
    const view = await this.#provider.callFunction({
      contractId: this.#poolsContract,
      method: 'get_pool',
      args: { pool_id: poolId },
      blockQuery: { finality: 'optimistic' },
    });
    if (view === null) return null;
    return readPoolView(view, poolId, (detail) => new PoolViewError(this.#poolsContract, poolId, detail));
  }
}

const POOL_STATUSES: readonly PoolStatus[] = ['open', 'filled', 'settled', 'expired', 'refunded'];
/** The most UTF-8 bytes of terms the pools contract keeps for a pool. */
const MAX_TERMS_BYTES = 280;

/** `value` as the view of pool `poolId`, field by field; `malformed` makes the error for one that is not. */
function readPoolView(value: unknown, poolId: number, malformed: (detail: string) => PoolViewError): PoolView {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw malformed('something that is not a JSON object');
  const view = value as Record<string, unknown>;
  const bad = (key: string, expected: string): PoolViewError => malformed(`a view whose ${key} is not ${expected}`);
  const integer = (key: string, least = 0): number => {
    const field = view[key];
    if (typeof field !== 'number' || !Number.isSafeInteger(field) || field < least) {
      throw bad(key, least === 0 ? 'a non-negative integer' : 'a positive integer');
    }
    return field;
  };
  const amount = (key: string): string => {
    const field = view[key];
    if (typeof field !== 'string' || parseAmount(field) === null) throw bad(key, 'a decimal amount');
    return field;
  };
  const id = integer('id');
  if (id !== poolId) throw bad('id', `${poolId}`);
  const { seller, max_seats_per_buyer: perBuyer, terms, status, dust_sent: dustSent } = view;
  if (typeof seller !== 'string' || !isAccountId(seller)) throw bad('seller', 'a NEAR account id');
  if (perBuyer !== null && (typeof perBuyer !== 'number' || !Number.isSafeInteger(perBuyer) || perBuyer < 0)) {
    throw bad('max_seats_per_buyer', 'null or a non-negative integer');
  }
  if (typeof terms !== 'string') throw bad('terms', 'a string');
  if (Buffer.byteLength(terms, 'utf8') > MAX_TERMS_BYTES) throw bad('terms', `at most ${MAX_TERMS_BYTES} bytes in UTF-8`);
  const known = POOL_STATUSES.find((s) => s === status);
  if (known === undefined) throw bad('status', `one of ${POOL_STATUSES.join(', ')}`);
  if (typeof dustSent !== 'boolean') throw bad('dust_sent', 'a boolean');
  return {
    id,
    seller,
    seat_price: amount('seat_price'),
    target: integer('target', 1),
    taken: integer('taken'),
    deadline_ms: integer('deadline_ms'),
    bonus: amount('bonus'),
    max_seats_per_buyer: perBuyer,
    terms,
    status: known,
    bonus_per_seat: amount('bonus_per_seat'),
    refund_cursor: integer('refund_cursor'),
    dust_sent: dustSent,
    buyer_count: integer('buyer_count'),
  };
}
