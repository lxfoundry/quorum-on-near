/**
 * The live page's logic, as functions with no input or output of their own: the JSON-RPC body of a
 * view call and the decoding of its answer, structural checks of everything read from the RPC and
 * the gateway, the ledger totals, the buyer rows, the explorer links, the choice of pool, the notice
 * shown for another seller's pool, the countdown, and the demo controls: the request a demo button
 * sends, the run its answer reports, the page URL without `?pool=`, whether the buttons are shown
 * and enabled, and the demo line.
 * Amounts are decimal strings in base units at the edges and `bigint` inside.
 */

/**
 * A pool's status as the views report it. The contract derives it from block time: an Open pool
 * past its deadline is reported `expired`.
 * @typedef {'open' | 'filled' | 'settled' | 'expired' | 'refunded'} PoolStatus
 */
/** @typedef {'committed' | 'refunded' | 'claimable'} BuyerState */
/**
 * The fields of a `get_pool` or `list_pools` row that the page reads (the contract's names; amounts
 * are decimal strings in base units). `bonus_per_seat` is set once the pool is past its deadline.
 * `dust_sent` is set once every buyer has been visited and the dust is on its way to the seller, and
 * cleared again if that transfer fails.
 * @typedef {{
 *   id: number,
 *   seller: string,
 *   seat_price: string,
 *   target: number,
 *   taken: number,
 *   deadline_ms: number,
 *   bonus: string,
 *   terms: string,
 *   status: PoolStatus,
 *   bonus_per_seat: string,
 *   dust_sent: boolean,
 * }} PoolView
 */
/**
 * What the page reads of a pool before it knows the pool is the provider's: its id and its seller.
 * @typedef {{ id: number, seller: string }} PoolRef
 */
/**
 * A `get_seats` row: one buyer of a pool, in commit order.
 * @typedef {{ buyer: string, seats: number, state: BuyerState }} SeatView
 */
/**
 * What a pool's money has done, in base units:
 * - `paidIn`: what the buyers paid for their seats;
 * - `paidToSeller`: the payout of a settled pool (every seat and the bonus back), or the dust of a
 *   refunded one once sent;
 * - `refunded`: the seat prices returned to buyers;
 * - `bonusPaidOut`: the bonus shares paid to buyers with their refunds;
 * - `heldNow`: what the contract still owes for this pool (spec section 5.5, invariant 1).
 * @typedef {{ paidIn: string, paidToSeller: string, refunded: string, bonusPaidOut: string, heldNow: string }} PoolTotals
 */
/**
 * One record of the gateway's activity feed (`GET /activity?pool=<id>`). `at` is milliseconds since
 * the epoch; `ok` is false for a commit that took no seat, a refund that could not be pushed, or a
 * keeper call that made no progress.
 * @typedef {{
 *   at: number,
 *   poolId: number,
 *   kind: 'commit' | 'settle' | 'refund' | 'dust',
 *   account: string,
 *   seats: number,
 *   amount: string,
 *   txHash: string,
 *   ok: boolean,
 * }} ActivityRecord
 */
/**
 * A link to a transaction in the explorer: `label` is the record's kind, followed by `(failed)`
 * when the record is not ok.
 * @typedef {{ label: string, href: string }} TxLink
 */
/**
 * One row of the buyer table. `paid` is what the buyer paid for its seats; `state` is `settled` for
 * every buyer of a settled pool, a state the contract does not store; `bonusShare` is set once the
 * buyer is refunded.
 * @typedef {{
 *   buyer: string,
 *   seats: number,
 *   paid: string,
 *   state: BuyerState | 'settled',
 *   bonusShare: string | null,
 *   links: TxLink[],
 * }} BuyerRow
 */
/**
 * The block a view call reads at: the latest final block, or the block with this hash. A refresh
 * reads `get_pool` at final finality, then the rest of the pool's data at the block of that answer.
 * @typedef {{ finality: 'final' } | { block_id: string }} BlockRef
 */
/**
 * What a view returned, and the hash of the block it was read at.
 * @typedef {{ value: unknown, blockHash: string }} ViewAnswer
 */
/**
 * What a refresh shows: a notice in place of any pool, or one of the provider's pools with the hash
 * of the block its seats and the contract's balance are read at.
 * @typedef {{ kind: 'notice', notice: string } | { kind: 'pool', pool: PoolView, blockHash: string }} PoolShown
 */
/**
 * A token's display facts, from its NEP-148 `ft_metadata`.
 * @typedef {{ decimals: number, symbol: string }} TokenInfo
 */
/**
 * The gateway's `/config.json`: what the page needs to read the chain. `rpcUrl` is `/rpc` when the
 * gateway's RPC pass-through is on. `demo` is true when the gateway's demo endpoint is on; a gateway
 * without the endpoint sends none, which reads as false.
 * @typedef {{
 *   network: string,
 *   rpcUrl: string,
 *   poolsContract: string,
 *   token: string,
 *   provider: string,
 *   explorerTxUrl: string,
 *   demo: boolean,
 * }} PageConfig
 */
/**
 * A demo run's scenario: a pool that fills, or a pool that fails.
 * @typedef {'fills' | 'fails'} DemoScenario
 */
/**
 * The last finished demo run. Times are milliseconds since the epoch. `exitCode` is the code of a
 * run that exited, `signal` the signal that ended one that did not, and both are null for a program
 * that could not be started.
 * @typedef {{
 *   scenario: DemoScenario,
 *   startedAt: number,
 *   endedAt: number,
 *   exitCode: number | null,
 *   signal: string | null,
 * }} DemoLastRun
 */
/**
 * The gateway's `GET /demo`. `scenario` and `startedAt` (milliseconds since the epoch) are set while
 * a run is in progress, and null otherwise. `runsToday` counts the runs started this UTC day.
 * @typedef {{
 *   running: boolean,
 *   scenario: DemoScenario | null,
 *   startedAt: number | null,
 *   last: DemoLastRun | null,
 *   runsToday: number,
 *   maxRunsPerDay: number,
 * }} DemoStatus
 */
/**
 * The gateway's answer to a demo button's `POST`: its HTTP status, and the `error` of its JSON body,
 * or null when it has none.
 * @typedef {{ status: number, error: string | null }} DemoAnswer
 */
/**
 * A click on a demo button: when its answer arrived (`at`, milliseconds since the epoch), and that
 * answer, or null when none came (the request failed or timed out).
 * @typedef {{ at: number, answer: DemoAnswer | null }} DemoClick
 */
/**
 * What the demo line is chosen from: the time now and the last click (milliseconds since the epoch),
 * the last `GET /demo` (null when it could not be read), and how the page writes a time.
 * @typedef {{
 *   now: number,
 *   click: DemoClick | null,
 *   status: DemoStatus | null,
 *   time: (ms: number) => string,
 * }} DemoLineInput
 */

/** Thrown when data read from the RPC, the gateway or the page URL does not have the expected shape. */
export class PageDataError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'PageDataError';
  }
}

/** A whole number written in decimal, with no sign and no leading zero: an amount or a pool id. */
const DECIMAL = /^(0|[1-9][0-9]*)$/;
/**
 * The rows the page asks `list_pools` and `get_seats` for at a time. It must not exceed the most the
 * contract returns in one call (`MAX_PAGE`): a page the contract cuts short is taken for the last.
 */
const PAGE_SIZE = 100;

/**
 * Writes an amount of base units in whole units with all `decimals` digits after the point, so
 * that `formatUnits('180', 6)` is `"0.000180"`. Throws a PageDataError unless `amount` is a
 * decimal string with no sign and no leading zero, and `decimals` a non-negative integer.
 *
 * @param {string} amount
 * @param {number} decimals
 * @returns {string}
 */
export function formatUnits(amount, decimals) {
  if (!DECIMAL.test(amount)) throw new PageDataError(`${JSON.stringify(amount)} is not an amount`);
  if (!Number.isSafeInteger(decimals) || decimals < 0) throw new PageDataError(`${decimals} is not a number of decimals`);
  if (decimals === 0) return amount;
  const digits = amount.padStart(decimals + 1, '0');
  return `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`;
}

/**
 * An amount of base units in whole units followed by the token's symbol: `"0.001728 USDC"`.
 *
 * @param {string} amount
 * @param {TokenInfo} token
 * @returns {string}
 */
export function formatAmount(amount, token) {
  return `${formatUnits(amount, token.decimals)} ${token.symbol}`;
}

/**
 * The ledger totals of one pool, from its view and every one of its `get_seats` rows. A buyer
 * marked `refunded` counts as paid back, one still `committed` or `claimable` in a pool past its
 * deadline as owed. The dust (what is left of the bonus once each seat has its share) counts as
 * paid to the seller once `dust_sent` is set, and as held before. Paid in plus the bonus always
 * equals the four other totals together.
 *
 * @param {PoolView} pool
 * @param {SeatView[]} seats
 * @returns {PoolTotals}
 */
export function poolTotals(pool, seats) {
  const price = BigInt(pool.seat_price);
  const bonus = BigInt(pool.bonus);
  const share = BigInt(pool.bonus_per_seat);
  const paidIn = BigInt(pool.taken) * price;
  let refunded = 0n;
  let bonusPaidOut = 0n;
  let owedToBuyers = 0n;
  for (const row of seats) {
    const n = BigInt(row.seats);
    if (row.state === 'refunded') {
      refunded += n * price;
      bonusPaidOut += n * share;
    } else {
      owedToBuyers += n * (price + share);
    }
  }
  let paidToSeller = 0n;
  let heldNow = 0n;
  if (pool.status === 'open' || pool.status === 'filled') {
    heldNow = paidIn + bonus;
  } else if (pool.status === 'settled') {
    paidToSeller = paidIn + bonus;
  } else {
    const dust = bonus - share * BigInt(pool.taken);
    paidToSeller = pool.dust_sent ? dust : 0n;
    heldNow = owedToBuyers + (pool.dust_sent ? 0n : dust);
  }
  return {
    paidIn: paidIn.toString(),
    paidToSeller: paidToSeller.toString(),
    refunded: refunded.toString(),
    bonusPaidOut: bonusPaidOut.toString(),
    heldNow: heldNow.toString(),
  };
}

/**
 * A NEAR transaction hash is 32 bytes in base58: 43 or 44 characters of its alphabet, except for a
 * rare hash with leading zero bytes, which is shorter and gets no link.
 */
const TX_HASH = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;

/**
 * The explorer link of a transaction: `explorerTxUrl` followed by the hash, or null when the hash
 * is not a base58 transaction hash, so that a feed record can never make the page link elsewhere.
 * `explorerTxUrl` must be an http(s) URL ending in `/` or `=` whose links keep its origin, as
 * `parseConfig` checks.
 *
 * @param {string} explorerTxUrl
 * @param {string} txHash
 * @returns {string | null}
 */
export function txUrl(explorerTxUrl, txHash) {
  return TX_HASH.test(txHash) ? `${explorerTxUrl}${txHash}` : null;
}

/**
 * The links of the records that pass `keep`, in feed order, leaving out any whose hash is not a
 * transaction hash.
 *
 * @param {ActivityRecord[]} activity
 * @param {(record: ActivityRecord) => boolean} keep
 * @param {string} explorerTxUrl
 * @returns {TxLink[]}
 */
function txLinks(activity, keep, explorerTxUrl) {
  /** @type {TxLink[]} */
  const links = [];
  for (const record of activity) {
    const href = keep(record) ? txUrl(explorerTxUrl, record.txHash) : null;
    if (href !== null) links.push({ label: record.ok ? record.kind : `${record.kind} (failed)`, href });
  }
  return links;
}

/**
 * The buyer table of a pool, one row per `get_seats` row in commit order, each with the links of
 * the buyer's commit and refund records for this pool.
 *
 * @param {PoolView} pool
 * @param {SeatView[]} seats
 * @param {ActivityRecord[]} activity
 * @param {string} explorerTxUrl
 * @returns {BuyerRow[]}
 */
export function buyerRows(pool, seats, activity, explorerTxUrl) {
  const price = BigInt(pool.seat_price);
  const share = BigInt(pool.bonus_per_seat);
  return seats.map((row) => {
    const n = BigInt(row.seats);
    const ownRecord = (/** @type {ActivityRecord} */ record) =>
      record.poolId === pool.id && record.account === row.buyer && (record.kind === 'commit' || record.kind === 'refund');
    return {
      buyer: row.buyer,
      seats: row.seats,
      paid: (n * price).toString(),
      state: pool.status === 'settled' && row.state === 'committed' ? 'settled' : row.state,
      bonusShare: row.state === 'refunded' ? (n * share).toString() : null,
      links: txLinks(activity, ownRecord, explorerTxUrl),
    };
  });
}

/**
 * The links of what a pool paid its seller: its `settle` records, or its `dust` record.
 *
 * @param {PoolView} pool
 * @param {ActivityRecord[]} activity
 * @param {string} explorerTxUrl
 * @returns {TxLink[]}
 */
export function payoutLinks(pool, activity, explorerTxUrl) {
  const payout = (/** @type {ActivityRecord} */ record) =>
    record.poolId === pool.id && (record.kind === 'settle' || record.kind === 'dust');
  return txLinks(activity, payout, explorerTxUrl);
}

/**
 * The JSON-RPC body of a view call: a `query` of `request_type: "call_function"` at the block that
 * `block` names, final finality or a block hash, with `args` as base64 of their JSON. It has exactly
 * the fields the gateway's `/rpc` pass-through accepts.
 *
 * @param {number} id
 * @param {string} accountId
 * @param {string} methodName
 * @param {Record<string, unknown>} args
 * @param {BlockRef} block
 */
export function viewRequest(id, accountId, methodName, args, block) {
  const bytes = new TextEncoder().encode(JSON.stringify(args));
  return {
    jsonrpc: '2.0',
    id,
    method: 'query',
    params: {
      request_type: 'call_function',
      account_id: accountId,
      method_name: methodName,
      args_base64: btoa(String.fromCharCode(...bytes)),
      ...block,
    },
  };
}

/** A block hash as the RPC writes it: base58. */
const BLOCK_HASH = /^[1-9A-HJ-NP-Za-km-z]+$/;

/**
 * The value a view returned, decoded from the bytes of the RPC's answer as UTF-8 JSON, and the hash
 * of the block it was read at. Throws a PageDataError when the RPC (or the gateway's pass-through)
 * answered an error, when the view failed in the contract, or when the answer is not a view result.
 *
 * @param {unknown} response
 * @returns {ViewAnswer}
 */
export function viewResult(response) {
  if (!isObject(response)) throw new PageDataError('the RPC answer is not a JSON object');
  if (response.error !== undefined) throw new PageDataError(`the RPC answered ${errorName(response.error)}`);
  const { result } = response;
  if (!isObject(result)) throw new PageDataError('the RPC answer has no result');
  if (typeof result.error === 'string') throw new PageDataError(`the view failed: ${result.error}`);
  const bytes = result.result;
  if (!Array.isArray(bytes) || !bytes.every(isByte)) throw new PageDataError('the view result is not a list of bytes');
  const blockHash = result.block_hash;
  if (typeof blockHash !== 'string' || !BLOCK_HASH.test(blockHash)) throw new PageDataError('the view result has no block hash');
  /** @type {unknown} */
  let value;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes)));
  } catch {
    throw new PageDataError('the view result is not UTF-8 JSON');
  }
  return { value, blockHash };
}

/**
 * The most telling name in a JSON-RPC error: NEAR's `cause.name` (such as `UNKNOWN_ACCOUNT`), else
 * its `name`, else its `message`. The gateway's pass-through answers a plain string.
 *
 * @param {unknown} error
 * @returns {string}
 */
function errorName(error) {
  if (typeof error === 'string') return error;
  if (isObject(error)) {
    if (isObject(error.cause) && typeof error.cause.name === 'string') return error.cause.name;
    if (typeof error.name === 'string') return error.name;
    if (typeof error.message === 'string') return error.message;
  }
  return 'an error';
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {value is number}
 */
function isCount(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * @param {unknown} value
 * @returns {value is number}
 */
function isByte(value) {
  return isCount(value) && value <= 255;
}

/**
 * @param {unknown} value
 * @returns {value is string}
 */
function isAmount(value) {
  return typeof value === 'string' && DECIMAL.test(value);
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isHttpUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Whether a transaction hash can be appended to `prefix` without leaving its origin: it ends in `/`
 * or `=`, and a link built from it has its origin. Appended to `https://explorer.example`, a hash
 * would become part of the host.
 *
 * @param {string} prefix
 * @returns {boolean}
 */
function keepsOrigin(prefix) {
  if (!prefix.endsWith('/') && !prefix.endsWith('=')) return false;
  try {
    return new URL(`${prefix}x`).origin === new URL(prefix).origin;
  } catch {
    return false;
  }
}

/**
 * @template T
 * @param {unknown} value
 * @param {(item: unknown) => T} parseItem
 * @param {string} what
 * @returns {T[]}
 */
function parseList(value, parseItem, what) {
  if (!Array.isArray(value)) throw new PageDataError(`${what} is not a list`);
  return value.map((item) => parseItem(item));
}

const POOL_STATUSES = new Set(['open', 'filled', 'settled', 'expired', 'refunded']);
const BUYER_STATES = new Set(['committed', 'refunded', 'claimable']);
const ACTIVITY_KINDS = new Set(['commit', 'settle', 'refund', 'dust']);
const CONFIG_KEYS = ['network', 'rpcUrl', 'poolsContract', 'token', 'provider', 'explorerTxUrl'];

/**
 * The `get_pool` answer of one of the provider's pools, checked field by field. Throws a
 * PageDataError if any field the page renders is missing or of the wrong form.
 *
 * @param {unknown} value
 * @returns {PoolView}
 */
export function parsePool(value) {
  if (
    isObject(value) &&
    isCount(value.id) &&
    typeof value.seller === 'string' &&
    isAmount(value.seat_price) &&
    isCount(value.target) &&
    isCount(value.taken) &&
    isCount(value.deadline_ms) &&
    isAmount(value.bonus) &&
    typeof value.terms === 'string' &&
    typeof value.status === 'string' &&
    POOL_STATUSES.has(value.status) &&
    isAmount(value.bonus_per_seat) &&
    typeof value.dust_sent === 'boolean'
  ) {
    return /** @type {PoolView} */ (value);
  }
  throw new PageDataError('the pools contract returned a malformed pool');
}

/**
 * The id and the seller of a `list_pools` row or a `get_pool` answer, and nothing else of it. Throws
 * a PageDataError unless the id is a safe integer and the seller a string. A pool another seller
 * opened is read no further, so no other field of it, such as a `deadline_ms` beyond 2^53, can fail
 * a refresh.
 *
 * @param {unknown} value
 * @returns {PoolRef}
 */
function parsePoolRef(value) {
  if (isObject(value) && isCount(value.id) && typeof value.seller === 'string') return { id: value.id, seller: value.seller };
  throw new PageDataError('the pools contract returned a malformed pool');
}

/**
 * A `list_pools` page, read for the pool selector: the id and the seller of each row. Throws a
 * PageDataError unless it is a list of rows with both.
 *
 * @param {unknown} value
 * @returns {PoolRef[]}
 */
export function parsePoolRefs(value) {
  return parseList(value, parsePoolRef, 'the list_pools result');
}

/**
 * A `get_seats` page. Throws a PageDataError unless it is a list of `{buyer, seats, state}` rows.
 *
 * @param {unknown} value
 * @returns {SeatView[]}
 */
export function parseSeats(value) {
  return parseList(value, parseSeat, 'the get_seats result');
}

/**
 * @param {unknown} value
 * @returns {SeatView}
 */
function parseSeat(value) {
  if (
    isObject(value) &&
    typeof value.buyer === 'string' &&
    isCount(value.seats) &&
    typeof value.state === 'string' &&
    BUYER_STATES.has(value.state)
  ) {
    return /** @type {SeatView} */ (value);
  }
  throw new PageDataError('the pools contract returned a malformed seat row');
}

/**
 * The gateway's activity feed. Throws a PageDataError unless it is a list of activity records.
 *
 * @param {unknown} value
 * @returns {ActivityRecord[]}
 */
export function parseActivity(value) {
  return parseList(value, parseRecord, 'the activity feed');
}

/**
 * @param {unknown} value
 * @returns {ActivityRecord}
 */
function parseRecord(value) {
  if (
    isObject(value) &&
    typeof value.at === 'number' &&
    isCount(value.poolId) &&
    typeof value.kind === 'string' &&
    ACTIVITY_KINDS.has(value.kind) &&
    typeof value.account === 'string' &&
    isCount(value.seats) &&
    isAmount(value.amount) &&
    typeof value.txHash === 'string' &&
    typeof value.ok === 'boolean'
  ) {
    return /** @type {ActivityRecord} */ (value);
  }
  throw new PageDataError('the activity feed holds a malformed record');
}

/**
 * The gateway's `/config.json`. Throws a PageDataError unless every field is a string, `demo` is
 * absent or a boolean, and the explorer URL is an http(s) URL that ends in `/` or `=` and whose links
 * keep its origin, which `txUrl` relies on. A missing `demo`, from a gateway without the demo
 * endpoint, reads as false.
 *
 * @param {unknown} value
 * @returns {PageConfig}
 */
export function parseConfig(value) {
  if (!isObject(value) || !CONFIG_KEYS.every((key) => typeof value[key] === 'string')) {
    throw new PageDataError('the gateway configuration (/config.json) is malformed');
  }
  if (value.demo !== undefined && typeof value.demo !== 'boolean') {
    throw new PageDataError('the gateway configuration (/config.json) is malformed');
  }
  const config = /** @type {PageConfig} */ ({ ...value, demo: value.demo === true });
  if (!isHttpUrl(config.explorerTxUrl)) throw new PageDataError('the explorer URL in /config.json is not an http(s) URL');
  if (!keepsOrigin(config.explorerTxUrl)) {
    throw new PageDataError('the explorer URL in /config.json must end in / or =, and a hash appended to it must keep its origin');
  }
  return config;
}

/**
 * The decimals and symbol of a token's `ft_metadata`. Throws a PageDataError unless `decimals` is
 * an integer from 0 to 255 (NEP-148's u8) and `symbol` a string.
 *
 * @param {unknown} value
 * @returns {TokenInfo}
 */
export function parseToken(value) {
  if (isObject(value) && typeof value.symbol === 'string' && isCount(value.decimals) && value.decimals <= 255) {
    return { decimals: value.decimals, symbol: value.symbol };
  }
  throw new PageDataError('the token metadata (ft_metadata) is malformed');
}

/**
 * The amount `ft_balance_of` returned. Throws a PageDataError unless it is a decimal string.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function parseBalance(value) {
  if (isAmount(value)) return value;
  throw new PageDataError('ft_balance_of did not return an amount');
}

/**
 * Every row of a paged view (`list_pools`, `get_seats`): reads pages of 100 rows from the first
 * until a page comes back shorter.
 *
 * @template T
 * @param {(from: number, limit: number) => Promise<T[]>} readPage
 * @returns {Promise<T[]>}
 */
export async function readAll(readPage) {
  /** @type {T[]} */
  const rows = [];
  for (;;) {
    const page = await readPage(rows.length, PAGE_SIZE);
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
  }
}

/**
 * The pool id the page URL asks for (`?pool=<id>`), written as the gateway writes pool ids:
 * decimal, no sign, no leading zero, a safe integer. Null when there is none or it is not one.
 *
 * @param {string} search the URL's query string, as `location.search` gives it
 * @returns {number | null}
 */
export function poolParam(search) {
  const text = new URLSearchParams(search).get('pool');
  if (text === null || !DECIMAL.test(text)) return null;
  const id = Number(text);
  return Number.isSafeInteger(id) ? id : null;
}

/**
 * The pool selector: the provider's pools, newest first, and the pool to read, which is the one the
 * page URL asks for or else the provider's newest. A requested pool is never offered unless the
 * provider opened it; it stays selected so that the page reads it and, if another seller opened it,
 * shows `foreignPoolNotice` in its place. `selected` is null when the provider has no pool and none
 * is asked for.
 *
 * @param {PoolRef[]} pools every pool `list_pools` returns
 * @param {string} provider
 * @param {number | null} requested
 * @returns {{ options: number[], selected: number | null }}
 */
export function poolChoices(pools, provider, requested) {
  const options = pools.filter((pool) => pool.seller === provider).map((pool) => pool.id);
  options.sort((a, b) => b - a);
  return { options, selected: requested ?? options[0] ?? null };
}

/**
 * What the page shows instead of a pool that another seller opened, or null for one of the
 * provider's pools, which the page renders. Anyone can open a pool on the pools contract, so a
 * `?pool=` link can name a pool whose terms the provider never wrote: the page names its seller and
 * shows none of its text. The seller is compared with the provider exactly.
 *
 * @param {PoolRef} pool
 * @param {string} provider
 * @returns {string | null}
 */
export function foreignPoolNotice(pool, provider) {
  if (pool.seller === provider) return null;
  return `Pool ${pool.id} was opened by ${pool.seller}, not by this gateway's provider ${provider}: this page shows only the provider's pools.`;
}

/**
 * What one refresh shows, decided from the pool it selected (`poolChoices`) and the `get_pool`
 * answer of the same refresh, before anything of that pool is rendered or read further:
 * - no pool selected: "The provider has not opened a pool yet.";
 * - a selected pool that `get_pool` does not find: "There is no pool <id>.";
 * - a pool another seller opened: `foreignPoolNotice`, with none of the pool's own text, whatever
 *   else the pool holds, since only its id and seller are read before the seller is checked;
 * - otherwise the provider's pool, checked field by field, to render with its seats and the
 *   contract's balance read at `blockHash`, the block of the `get_pool` answer.
 * Throws a PageDataError if the answer has no id or seller, or if the provider's pool is malformed.
 *
 * @param {number | null} selected
 * @param {ViewAnswer | null} found the `get_pool` answer for `selected`; null when none is selected
 * @param {string} provider
 * @returns {PoolShown}
 */
export function poolToShow(selected, found, provider) {
  if (selected === null) return { kind: 'notice', notice: 'The provider has not opened a pool yet.' };
  if (found === null || found.value === null) return { kind: 'notice', notice: `There is no pool ${selected}.` };
  const notice = foreignPoolNotice(parsePoolRef(found.value), provider);
  if (notice !== null) return { kind: 'notice', notice };
  return { kind: 'pool', pool: parsePool(found.value), blockHash: found.blockHash };
}

/**
 * The time left until `deadlineMs`, rounded up to the second: `m:ss`, or `h:mm:ss` from an hour,
 * and `0:00` once the deadline has passed. For display only: the contract compares the deadline with
 * block time, never with this clock.
 *
 * @param {number} deadlineMs
 * @param {number} nowMs
 * @returns {string}
 */
export function countdown(deadlineMs, nowMs) {
  const total = Math.max(0, Math.ceil((deadlineMs - nowMs) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total / 60) % 60;
  const seconds = String(total % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
}

/**
 * What the pool card's countdown shows: the time left while the pool is Open, and "closed" in every
 * other status, whatever the deadline says. For display only, like `countdown`.
 *
 * @param {PoolStatus} status
 * @param {number} deadlineMs
 * @param {number} nowMs
 * @returns {string}
 */
export function countdownText(status, deadlineMs, nowMs) {
  return status === 'open' ? countdown(deadlineMs, nowMs) : 'closed';
}

/**
 * How long the demo line shows the answer to a click. It is counted from when that answer arrived,
 * not from the click itself: a request can take up to 10 seconds, and a slow answer counted from the
 * click would show for almost no time.
 */
export const DEMO_ANSWER_MS = 10_000;

const DEMO_SCENARIOS = new Set(['fills', 'fails']);

/**
 * @param {unknown} value
 * @returns {value is DemoScenario}
 */
function isScenario(value) {
  return typeof value === 'string' && DEMO_SCENARIOS.has(value);
}

/**
 * @param {unknown} value
 * @returns {value is DemoLastRun}
 */
function isLastRun(value) {
  return (
    isObject(value) &&
    isScenario(value.scenario) &&
    isCount(value.startedAt) &&
    isCount(value.endedAt) &&
    (value.exitCode === null || (typeof value.exitCode === 'number' && Number.isSafeInteger(value.exitCode))) &&
    (value.signal === null || typeof value.signal === 'string')
  );
}

/**
 * The gateway's `GET /demo`, checked field by field: `scenario` and `startedAt` are set exactly
 * while a run is in progress, and `last` is null or a finished run. Throws a PageDataError for any
 * other shape.
 *
 * @param {unknown} value
 * @returns {DemoStatus}
 */
export function parseDemoStatus(value) {
  if (
    isObject(value) &&
    typeof value.running === 'boolean' &&
    (value.scenario === null || isScenario(value.scenario)) &&
    (value.startedAt === null || isCount(value.startedAt)) &&
    (value.scenario !== null) === value.running &&
    (value.startedAt !== null) === value.running &&
    (value.last === null || isLastRun(value.last)) &&
    isCount(value.runsToday) &&
    isCount(value.maxRunsPerDay)
  ) {
    return /** @type {DemoStatus} */ (value);
  }
  throw new PageDataError('the demo status (/demo) is malformed');
}

/**
 * The gateway's answer to a demo button's `POST`: its HTTP status, and the `error` of its JSON body
 * when that is text. `body` is null when the answer had no JSON body.
 *
 * @param {number} status
 * @param {unknown} body
 * @returns {DemoAnswer}
 */
export function parseDemoAnswer(status, body) {
  return { status, error: isObject(body) && typeof body.error === 'string' ? body.error : null };
}

/**
 * The demo's status once a click is answered with a run: a `202` starts one, and a `409`
 * `demo_running` names the one in progress, each with its `scenario` and `startedAt`. Either way that
 * run is now in progress, whatever the last `GET /demo` (`last`) said, and a `202` counts one more run
 * today; the rest is as `last` said. Null for any other answer, for one without a valid scenario and
 * start, and when `last` is null, which leaves nothing to complete the run with (and already disables
 * the buttons).
 *
 * @param {DemoStatus | null} last
 * @param {number} status
 * @param {unknown} body the answer's JSON body, or null when it had none
 * @returns {DemoStatus | null}
 */
export function statusAfterAnswer(last, status, body) {
  if (last === null || !isObject(body) || !isScenario(body.scenario) || !isCount(body.startedAt)) return null;
  const started = status === 202;
  if (!started && !(status === 409 && body.error === 'demo_running')) return null;
  return {
    ...last,
    running: true,
    scenario: body.scenario,
    startedAt: body.startedAt,
    runsToday: started ? last.runsToday + 1 : last.runsToday,
  };
}

/**
 * The request a demo button sends: a `POST` with the header the gateway requires. A page on another
 * site cannot send that header without a CORS preflight, which the gateway never answers.
 *
 * @param {DemoScenario} scenario
 * @returns {{ url: string, method: 'POST', headers: Record<string, string> }}
 */
export function demoRequest(scenario) {
  return { url: `/demo/${scenario}`, method: 'POST', headers: { 'X-Quorum-Demo': '1' } };
}

/**
 * The page's URL without `?pool=`, so that the page follows the provider's newest pool, which is the
 * one a run started from the page opens. Every other part of the URL is kept.
 *
 * @param {string} href
 * @returns {string}
 */
export function withoutPoolParam(href) {
  const url = new URL(href);
  url.searchParams.delete('pool');
  return url.href;
}

/**
 * Whether the demo buttons and line are shown, and whether the buttons can be clicked. They are
 * shown only when `/config.json` has `demo: true`. The buttons are disabled while a run is in
 * progress, when today's cap is reached, when `GET /demo` could not be read (`status` null), and
 * while a button's own request is on its way (`sending`), so that one click sends one request.
 *
 * @param {{ demo: boolean, status: DemoStatus | null, sending: boolean }} input
 * @returns {{ shown: boolean, enabled: boolean }}
 */
export function demoControls({ demo, status, sending }) {
  const enabled = demo && !sending && status !== null && !status.running && status.runsToday < status.maxRunsPerDay;
  return { shown: demo, enabled };
}

/**
 * What the demo line says of the answer to a click.
 *
 * @param {DemoAnswer | null} answer
 * @returns {string}
 */
function answerText(answer) {
  if (answer === null) return 'The gateway could not be reached.';
  if (answer.status === 202) return 'A run started. Its pool appears here once it opens.';
  if (answer.status === 409 && answer.error === 'demo_running') return 'A run is already in progress. This page follows its pool once it opens.';
  if (answer.status === 409 && answer.error === 'pool_open') return 'A pool is still open. This page shows it.';
  if (answer.status === 429) return 'The demo has reached its limit for today.';
  return 'The demo is not available right now.';
}

/**
 * The demo line: the first of these that applies.
 * 1. For DEMO_ANSWER_MS after a click's answer arrived, that answer.
 * 2. `GET /demo` could not be read.
 * 3. A run in progress: its scenario and when it started.
 * 4. Today's cap reached.
 * 5. The last run exited with code 0: its scenario and when it ended.
 * 6. The last run ended any other way.
 * 7. No run yet.
 *
 * @param {DemoLineInput} input
 * @returns {string}
 */
export function demoLine({ now, click, status, time }) {
  if (click !== null && now - click.at < DEMO_ANSWER_MS) return answerText(click.answer);
  if (status === null) return "The demo's status is unavailable.";
  if (status.running && status.scenario !== null && status.startedAt !== null) {
    return `A ${status.scenario} run started at ${time(status.startedAt)} is in progress.`;
  }
  if (status.runsToday >= status.maxRunsPerDay) return 'The demo has reached its limit for today.';
  const { last } = status;
  if (last === null) return 'Start a run to watch a pool from its first seat.';
  if (last.exitCode === 0) return `The last run (${last.scenario}) ended at ${time(last.endedAt)}.`;
  return 'The last run ended with an error. Its testnet funds may need a refill.';
}
