import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DEMO_ANSWER_MS,
  PageDataError,
  buyerRows,
  countdown,
  countdownText,
  demoControls,
  demoLine,
  demoRequest,
  foreignPoolNotice,
  formatAmount,
  formatUnits,
  parseActivity,
  parseBalance,
  parseConfig,
  parseDemoAnswer,
  parseDemoStatus,
  parsePool,
  parsePoolRefs,
  parseSeats,
  parseToken,
  payoutLinks,
  poolChoices,
  poolParam,
  poolToShow,
  poolTotals,
  readAll,
  statusAfterAnswer,
  txUrl,
  viewRequest,
  viewResult,
  withoutPoolParam,
  type ActivityRecord,
  type DemoClick,
  type DemoLastRun,
  type DemoStatus,
  type PoolView,
  type SeatView,
} from '../totals.js';
import { isAllowedViewCall } from '../../gateway/src/view-call.ts';

const EXPLORER = 'https://testnet.nearblocks.io/txns/';
const POOLS = 'pools.quorum.testnet';
const TOKEN = '3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af';
/** The hash of the block a refresh reads at, as an RPC answer gives it. */
const BLOCK_HASH = 'GZ3Ya1qXp7kN8mWcT4vB9rHfJ2sLdE6uQyKxM5nPaRtV';
const COMMIT_1 = 'Ev64qpcqroBNeET1xax4ei5vDc1sJTyNSZRpj5GdYYTy';
const COMMIT_2 = 'FmHDvha1UrjFE2KZN9NKRTrygpw2iXNsQquSFVHcfGyM';
const REFUND_1 = '73kVxs4q7MPWXkh1cCTN3iNPk9jRnhUu5TKSE22ZeK55';
const REFUND_2 = '9PyUT7YuigXdQabWvzCri8xHHLscmzCfSoZAzC553xj5';
const SETTLE = '9BAD9UzcJxWNppT8pPBVfpzbu4P9yqgu1nCdnTCYkBjY';
const DUST = '4CXz4yT4z2YG41en4VxM87WP5ZwVzCFSyh52Ug5sztxV';

/** The `fills` pool of the swarm: 180 a seat, 192 seats, a bonus of 1728. */
function fillsPool(overrides: Partial<PoolView> = {}): PoolView {
  return {
    id: 3,
    seller: 'provider.quorum.testnet',
    seat_price: '180',
    target: 192,
    taken: 192,
    deadline_ms: 1_800_000_600_000,
    bonus: '1728',
    terms: '8×GPU × 24 h; 1 seat = 1 GPU-hour; prices at 1/10,000 scale',
    status: 'filled',
    bonus_per_seat: '0',
    dust_sent: false,
    ...overrides,
  };
}

/** The `fails` pool of the swarm once expired: 320 a seat, 100 of 192 seats taken, a bonus of 3072, so 30 a seat and a dust of 72. */
function failsPool(overrides: Partial<PoolView> = {}): PoolView {
  return {
    id: 4,
    seller: 'provider.quorum.testnet',
    seat_price: '320',
    target: 192,
    taken: 100,
    deadline_ms: 1_800_000_180_000,
    bonus: '3072',
    terms: '8×GPU × 24 h; 1 seat = 1 GPU-hour; prices at 1/10,000 scale',
    status: 'expired',
    bonus_per_seat: '30',
    dust_sent: false,
    ...overrides,
  };
}

/** The 100 seats of the fails pool, in commit order, each buyer in `state` unless `states` says otherwise. */
function failsSeats(state: SeatView['state'], states: Record<string, SeatView['state']> = {}): SeatView[] {
  const seats: [string, number][] = [
    ['buyer-01.quorum.testnet', 24],
    ['buyer-02.quorum.testnet', 20],
    ['buyer-03.quorum.testnet', 18],
    ['buyer-04.quorum.testnet', 16],
    ['buyer-05.quorum.testnet', 12],
    ['buyer-06.quorum.testnet', 10],
  ];
  return seats.map(([buyer, n]) => ({ buyer, seats: n, state: states[buyer] ?? state }));
}

function activity(overrides: Partial<ActivityRecord>): ActivityRecord {
  return {
    at: 1_800_000_000_000,
    poolId: 4,
    kind: 'commit',
    account: 'buyer-01.quorum.testnet',
    seats: 24,
    amount: '7680',
    txHash: COMMIT_1,
    ok: true,
    ...overrides,
  };
}

/** Two buyers holding all 192 seats of the fills pool. */
const FILLS_SEATS: SeatView[] = [
  { buyer: 'buyer-01.quorum.testnet', seats: 100, state: 'committed' },
  { buyer: 'buyer-02.quorum.testnet', seats: 92, state: 'committed' },
];

describe('formatUnits', () => {
  it('shows a scaled seat price with all six decimals', () => {
    expect(formatUnits('180', 6)).toBe('0.000180');
  });

  it('shows 0 with all its decimals', () => {
    expect(formatUnits('0', 6)).toBe('0.000000');
  });

  it('puts the whole units before the point', () => {
    expect(formatUnits('12345678', 6)).toBe('12.345678');
  });

  it('keeps every digit of an amount beyond the range of a number', () => {
    expect(formatUnits('340282366920938463463374607431768211455', 6)).toBe('340282366920938463463374607431768.211455');
  });

  it('shows a token with no decimals as a whole number', () => {
    expect(formatUnits('180', 0)).toBe('180');
  });

  it.each(['', '-1', '1.5', '1e5', '007', ' 1'])('throws a PageDataError for the amount %j', (amount) => {
    expect(() => formatUnits(amount, 6)).toThrow(PageDataError);
  });

  it.each([-1, 1.5, Number.NaN])('throws a PageDataError for %s decimals', (decimals) => {
    expect(() => formatUnits('180', decimals)).toThrow(PageDataError);
  });
});

describe('formatAmount', () => {
  it('follows the amount with the token symbol', () => {
    expect(formatAmount('1728', { decimals: 6, symbol: 'USDC' })).toBe('0.001728 USDC');
  });
});

describe('poolTotals', () => {
  it('holds the seats paid so far and the bonus while the pool is open', () => {
    const seats: SeatView[] = [{ buyer: 'buyer-01.quorum.testnet', seats: 40, state: 'committed' }];
    expect(poolTotals(fillsPool({ status: 'open', taken: 40 }), seats)).toEqual({
      paidIn: '7200',
      paidToSeller: '0',
      refunded: '0',
      bonusPaidOut: '0',
      heldNow: '8928',
    });
  });

  it('holds every seat and the bonus once filled, until the payout', () => {
    expect(poolTotals(fillsPool(), FILLS_SEATS)).toEqual({
      paidIn: '34560',
      paidToSeller: '0',
      refunded: '0',
      bonusPaidOut: '0',
      heldNow: '36288',
    });
  });

  it('pays the seller every seat and the bonus back once settled, and holds nothing', () => {
    expect(poolTotals(fillsPool({ status: 'settled' }), FILLS_SEATS)).toEqual({
      paidIn: '34560',
      paidToSeller: '36288',
      refunded: '0',
      bonusPaidOut: '0',
      heldNow: '0',
    });
  });

  it('holds each refund and the dust of a pool that expired before any refund', () => {
    expect(poolTotals(failsPool(), failsSeats('committed'))).toEqual({
      paidIn: '32000',
      paidToSeller: '0',
      refunded: '0',
      bonusPaidOut: '0',
      heldNow: '35072',
    });
  });

  it('counts the refunds made so far and holds the rest while refunds are in progress', () => {
    const seats = failsSeats('committed', {
      'buyer-01.quorum.testnet': 'refunded',
      'buyer-02.quorum.testnet': 'refunded',
      'buyer-03.quorum.testnet': 'refunded',
    });
    // 62 seats refunded at 320 + 30; 38 seats still held at 350, plus the dust of 72.
    expect(poolTotals(failsPool(), seats)).toEqual({
      paidIn: '32000',
      paidToSeller: '0',
      refunded: '19840',
      bonusPaidOut: '1860',
      heldNow: '13372',
    });
  });

  it('pays the dust to the seller once it is sent, before the pool is marked refunded', () => {
    expect(poolTotals(failsPool({ dust_sent: true }), failsSeats('refunded'))).toEqual({
      paidIn: '32000',
      paidToSeller: '72',
      refunded: '32000',
      bonusPaidOut: '3000',
      heldNow: '0',
    });
  });

  it('holds the dust of 72 again, paid to the seller 0, when its transfer failed after every refund (dust_sent back to false)', () => {
    expect(poolTotals(failsPool({ dust_sent: false }), failsSeats('refunded'))).toEqual({
      paidIn: '32000',
      paidToSeller: '0',
      refunded: '32000',
      bonusPaidOut: '3000',
      heldNow: '72',
    });
  });

  it('pays every seat its price and 30 of the bonus, and the dust of 72 to the seller, once refunded', () => {
    expect(poolTotals(failsPool({ status: 'refunded', dust_sent: true }), failsSeats('refunded'))).toEqual({
      paidIn: '32000',
      paidToSeller: '72',
      refunded: '32000',
      bonusPaidOut: '3000',
      heldNow: '0',
    });
  });

  it('holds the refund of a buyer whose pushed refund failed (claimable)', () => {
    const seats = failsSeats('refunded', { 'buyer-06.quorum.testnet': 'claimable' });
    expect(poolTotals(failsPool({ status: 'refunded', dust_sent: true }), seats)).toEqual({
      paidIn: '32000',
      paidToSeller: '72',
      refunded: '28800',
      bonusPaidOut: '2700',
      heldNow: '3500',
    });
  });

  it('holds the whole bonus of a pool that expired with no seat, then pays it back to the seller', () => {
    const empty = failsPool({ taken: 0, bonus_per_seat: '0' });
    expect(poolTotals(empty, [])).toMatchObject({ paidIn: '0', paidToSeller: '0', heldNow: '3072' });
    expect(poolTotals({ ...empty, status: 'refunded', dust_sent: true }, [])).toMatchObject({ paidToSeller: '3072', heldNow: '0' });
  });

  it.each([
    ['open', fillsPool({ status: 'open', taken: 100 }), FILLS_SEATS.slice(0, 1)],
    ['filled', fillsPool(), FILLS_SEATS],
    ['settled', fillsPool({ status: 'settled' }), FILLS_SEATS],
    ['expired', failsPool(), failsSeats('committed', { 'buyer-02.quorum.testnet': 'refunded' })],
    ['expired, dust sent', failsPool({ dust_sent: true }), failsSeats('refunded', { 'buyer-04.quorum.testnet': 'claimable' })],
    ['expired, dust transfer failed', failsPool(), failsSeats('refunded')],
    ['refunded', failsPool({ status: 'refunded', dust_sent: true }), failsSeats('refunded')],
  ])('accounts for every unit paid in and every unit of the bonus when %s', (_status, pool, seats) => {
    const t = poolTotals(pool, seats);
    const out = BigInt(t.paidToSeller) + BigInt(t.refunded) + BigInt(t.bonusPaidOut) + BigInt(t.heldNow);
    expect(out).toBe(BigInt(t.paidIn) + BigInt(pool.bonus));
  });
});

describe('txUrl', () => {
  it('appends a transaction hash to the explorer URL', () => {
    expect(txUrl(EXPLORER, COMMIT_1)).toBe(`${EXPLORER}${COMMIT_1}`);
  });

  it('accepts a 43-character hash', () => {
    expect(txUrl(EXPLORER, DUST.slice(0, 43))).toBe(`${EXPLORER}${DUST.slice(0, 43)}`);
  });

  it.each([
    ['that is empty', ''],
    ['of 42 characters', COMMIT_1.slice(0, 42)],
    ['of 45 characters', `${COMMIT_1}1`],
    ['with a 0', `0${COMMIT_1.slice(1)}`],
    ['with an O', `O${COMMIT_1.slice(1)}`],
    ['with an I', `I${COMMIT_1.slice(1)}`],
    ['with an l', `l${COMMIT_1.slice(1)}`],
    ['with a path', `../${COMMIT_1.slice(3)}`],
    ['with markup', `<b>${COMMIT_1.slice(3)}`],
  ])('gives no link for a hash %s', (_kind, hash) => {
    expect(txUrl(EXPLORER, hash)).toBeNull();
  });
});

describe('buyerRows', () => {
  it('gives one row per buyer in commit order, with the price of its seats', () => {
    const rows = buyerRows(failsPool({ status: 'open' }), failsSeats('committed').slice(0, 2), [], EXPLORER);
    expect(rows).toEqual([
      { buyer: 'buyer-01.quorum.testnet', seats: 24, paid: '7680', state: 'committed', bonusShare: null, links: [] },
      { buyer: 'buyer-02.quorum.testnet', seats: 20, paid: '6400', state: 'committed', bonusShare: null, links: [] },
    ]);
  });

  it('keeps a buyer committed in a filled pool, before the payout', () => {
    expect(buyerRows(fillsPool(), FILLS_SEATS, [], EXPLORER).map((row) => row.state)).toEqual(['committed', 'committed']);
  });

  it('shows every buyer of a settled pool as settled, a state the contract does not store', () => {
    expect(buyerRows(fillsPool({ status: 'settled' }), FILLS_SEATS, [], EXPLORER).map((row) => row.state)).toEqual(['settled', 'settled']);
  });

  it('gives a refunded buyer its bonus share, the seats times the bonus per seat', () => {
    const seats = failsSeats('committed', { 'buyer-02.quorum.testnet': 'refunded' });
    const row = buyerRows(failsPool(), seats, [], EXPLORER)[1];
    expect(row).toMatchObject({ buyer: 'buyer-02.quorum.testnet', paid: '6400', state: 'refunded', bonusShare: '600' });
  });

  it('keeps a buyer whose pushed refund failed claimable, with no bonus share paid', () => {
    const seats = failsSeats('refunded', { 'buyer-06.quorum.testnet': 'claimable' });
    const row = buyerRows(failsPool({ status: 'refunded', dust_sent: true }), seats, [], EXPLORER)[5];
    expect(row).toMatchObject({ buyer: 'buyer-06.quorum.testnet', state: 'claimable', bonusShare: null });
  });

  it("links the buyer's commit and refund transactions in this pool, oldest first", () => {
    const feed = [
      activity({ kind: 'commit', txHash: COMMIT_1 }),
      activity({ kind: 'commit', txHash: COMMIT_2, seats: 0, amount: '0', ok: false }),
      activity({ kind: 'refund', txHash: REFUND_1, ok: false, seats: 0 }),
      activity({ kind: 'refund', txHash: REFUND_2 }),
    ];
    const [row] = buyerRows(failsPool(), failsSeats('refunded').slice(0, 1), feed, EXPLORER);
    expect(row?.links).toEqual([
      { label: 'commit', href: `${EXPLORER}${COMMIT_1}` },
      { label: 'commit (failed)', href: `${EXPLORER}${COMMIT_2}` },
      { label: 'refund (failed)', href: `${EXPLORER}${REFUND_1}` },
      { label: 'refund', href: `${EXPLORER}${REFUND_2}` },
    ]);
  });

  it("leaves out other buyers', other pools' and the seller's records, and hashes that are not base58", () => {
    const feed = [
      activity({ account: 'buyer-02.quorum.testnet', txHash: COMMIT_2 }),
      activity({ poolId: 5, txHash: REFUND_1 }),
      activity({ kind: 'dust', account: 'buyer-01.quorum.testnet', txHash: DUST }),
      activity({ kind: 'settle', account: 'buyer-01.quorum.testnet', txHash: SETTLE }),
      activity({ txHash: 'javascript:alert(1)' }),
    ];
    const [row] = buyerRows(failsPool(), failsSeats('committed').slice(0, 1), feed, EXPLORER);
    expect(row?.links).toEqual([]);
  });
});

describe('payoutLinks', () => {
  it("links the pool's settle transaction, after a settle call that failed", () => {
    const feed = [
      activity({ kind: 'commit', txHash: COMMIT_1 }),
      activity({ kind: 'settle', account: 'provider.quorum.testnet', txHash: COMMIT_2, seats: 0, amount: '0', ok: false }),
      activity({ kind: 'settle', account: 'provider.quorum.testnet', txHash: SETTLE, seats: 192, amount: '36288' }),
    ];
    expect(payoutLinks(fillsPool({ id: 4 }), feed, EXPLORER)).toEqual([
      { label: 'settle (failed)', href: `${EXPLORER}${COMMIT_2}` },
      { label: 'settle', href: `${EXPLORER}${SETTLE}` },
    ]);
  });

  it("links the pool's dust transaction, but not a refund call that failed nor another pool's dust", () => {
    const feed = [
      activity({ kind: 'refund', account: 'provider.quorum.testnet', txHash: REFUND_1, seats: 0, amount: '0', ok: false }),
      activity({ kind: 'dust', account: 'provider.quorum.testnet', txHash: DUST, seats: 0, amount: '72' }),
      activity({ kind: 'dust', poolId: 5, account: 'provider.quorum.testnet', txHash: REFUND_2, seats: 0, amount: '72' }),
    ];
    expect(payoutLinks(failsPool(), feed, EXPLORER)).toEqual([{ label: 'dust', href: `${EXPLORER}${DUST}` }]);
  });
});

describe('viewRequest', () => {
  it('builds a call_function query at final finality, with the arguments as base64 JSON', () => {
    expect(viewRequest(7, POOLS, 'get_pool', { pool_id: 4 }, { finality: 'final' })).toStrictEqual({
      jsonrpc: '2.0',
      id: 7,
      method: 'query',
      params: {
        request_type: 'call_function',
        account_id: POOLS,
        method_name: 'get_pool',
        args_base64: 'eyJwb29sX2lkIjo0fQ==',
        finality: 'final',
      },
    });
  });

  it('builds a call_function query at a block, given by its hash, with no finality', () => {
    expect(viewRequest(8, POOLS, 'get_seats', { pool_id: 4, from: 0, limit: 100 }, { block_id: BLOCK_HASH })).toStrictEqual({
      jsonrpc: '2.0',
      id: 8,
      method: 'query',
      params: {
        request_type: 'call_function',
        account_id: POOLS,
        method_name: 'get_seats',
        args_base64: 'eyJwb29sX2lkIjo0LCJmcm9tIjowLCJsaW1pdCI6MTAwfQ==',
        block_id: BLOCK_HASH,
      },
    });
  });

  // The bodies of every view call the page makes, as they reach the gateway once sent as JSON.
  it.each([
    ['ft_metadata at final finality', viewRequest(1, TOKEN, 'ft_metadata', {}, { finality: 'final' })],
    ['list_pools at final finality', viewRequest(2, POOLS, 'list_pools', { from: 0, limit: 100 }, { finality: 'final' })],
    ['get_pool at final finality', viewRequest(3, POOLS, 'get_pool', { pool_id: 4 }, { finality: 'final' })],
    ['get_seats at a block', viewRequest(4, POOLS, 'get_seats', { pool_id: 4, from: 100, limit: 100 }, { block_id: BLOCK_HASH })],
    ['ft_balance_of at a block', viewRequest(5, TOKEN, 'ft_balance_of', { account_id: POOLS }, { block_id: BLOCK_HASH })],
  ])("builds a body that the gateway's /rpc pass-through forwards: %s", (_call, body) => {
    expect(isAllowedViewCall(JSON.parse(JSON.stringify(body)), [POOLS, TOKEN])).toBe(true);
  });
});

describe('viewResult', () => {
  const answer = (result: unknown) => ({ jsonrpc: '2.0', id: 7, result });

  it('decodes the bytes of a view result as UTF-8 JSON, with the hash of the block it was read at', () => {
    // The bytes of {"terms":"8×GPU","decimals":6}, where × takes two bytes.
    const bytes = [123, 34, 116, 101, 114, 109, 115, 34, 58, 34, 56, 195, 151, 71, 80, 85, 34, 44, 34, 100, 101, 99, 105, 109, 97, 108, 115, 34, 58, 54, 125];
    expect(viewResult(answer({ result: bytes, logs: [], block_height: 1000, block_hash: BLOCK_HASH }))).toStrictEqual({
      value: { terms: '8×GPU', decimals: 6 },
      blockHash: BLOCK_HASH,
    });
  });

  it('gives null for a view that returned null, such as get_pool of a pool that does not exist', () => {
    expect(viewResult(answer({ result: [110, 117, 108, 108], logs: [], block_height: 1000, block_hash: BLOCK_HASH }))).toStrictEqual({
      value: null,
      blockHash: BLOCK_HASH,
    });
  });

  it.each([
    ['no block hash', undefined],
    ['a block hash that is not text', 1000],
    ['an empty block hash', ''],
    ['a block hash that is not base58', 'not/a+hash'],
  ])('throws a PageDataError for a view result with %s', (_kind, hash) => {
    expect(() => viewResult(answer({ result: [110, 117, 108, 108], logs: [], block_height: 1000, block_hash: hash }))).toThrow(PageDataError);
  });

  it('throws a PageDataError naming the cause of an error the RPC answered', () => {
    const error = { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_ACCOUNT', info: {} }, code: -32000, message: 'Server error' };
    expect(() => viewResult({ jsonrpc: '2.0', id: 7, error })).toThrow(new PageDataError('the RPC answered UNKNOWN_ACCOUNT'));
  });

  it('throws a PageDataError naming an error the gateway pass-through answered', () => {
    expect(() => viewResult({ error: 'chain_unavailable' })).toThrow(new PageDataError('the RPC answered chain_unavailable'));
  });

  it('throws a PageDataError for a view that failed in the contract', () => {
    const failed = answer({ error: 'wasm execution failed with error: MethodResolveError(MethodNotFound)', logs: [] });
    expect(() => viewResult(failed)).toThrow(PageDataError);
  });

  it.each([
    ['an answer that is not an object', 'ok'],
    ['an answer with no result', { jsonrpc: '2.0', id: 7 }],
    ['a result that is not bytes', answer({ result: [256] })],
    ['bytes that are not JSON', answer({ result: [123, 34, 97, 34] })],
  ])('throws a PageDataError for %s', (_kind, response) => {
    expect(() => viewResult(response)).toThrow(PageDataError);
  });
});

/** A `get_pool` row as the contract returns it, with the fields the page does not read. */
const POOL_ROW = {
  id: 4,
  seller: 'provider.quorum.testnet',
  seat_price: '320',
  target: 192,
  taken: 100,
  deadline_ms: 1_800_000_180_000,
  bonus: '3072',
  max_seats_per_buyer: 24,
  terms: '8×GPU × 24 h; 1 seat = 1 GPU-hour; prices at 1/10,000 scale',
  status: 'expired',
  bonus_per_seat: '30',
  refund_cursor: 0,
  dust_sent: false,
  buyer_count: 6,
};

describe('parsePool', () => {
  it('accepts a get_pool row', () => {
    expect(parsePool(POOL_ROW)).toEqual(POOL_ROW);
  });

  it.each([
    ['null', null],
    ['a negative id', { ...POOL_ROW, id: -1 }],
    ['a seat price as a number', { ...POOL_ROW, seat_price: 320 }],
    ['a bonus with a sign', { ...POOL_ROW, bonus: '-3072' }],
    ['a fractional taken', { ...POOL_ROW, taken: 1.5 }],
    ['an unknown status', { ...POOL_ROW, status: 'closed' }],
    ['terms that are not text', { ...POOL_ROW, terms: ['8×GPU'] }],
    ['no dust_sent', { ...POOL_ROW, dust_sent: undefined }],
    ['no seller', { ...POOL_ROW, seller: undefined }],
  ])('throws a PageDataError for %s', (_kind, row) => {
    expect(() => parsePool(row)).toThrow(PageDataError);
  });
});

/** The largest u64, as JSON.parse reads it from a view: a number beyond 2^53, which isCount refuses. */
const U64_MAX = JSON.parse('18446744073709551615') as number;

describe('parsePoolRefs', () => {
  it('keeps only the id and the seller of each list_pools row', () => {
    expect(parsePoolRefs([POOL_ROW, { ...POOL_ROW, id: 5, seller: 'someone.testnet' }])).toStrictEqual([
      { id: 4, seller: 'provider.quorum.testnet' },
      { id: 5, seller: 'someone.testnet' },
    ]);
  });

  it('accepts a row whose other fields the page could not render, such as a deadline beyond 2^53', () => {
    const row = { ...POOL_ROW, id: 5, seller: 'someone.testnet', deadline_ms: U64_MAX, status: 'closed', terms: null };
    expect(parsePoolRefs([row])).toStrictEqual([{ id: 5, seller: 'someone.testnet' }]);
  });

  it('throws a PageDataError for a page that is not a list', () => {
    expect(() => parsePoolRefs(POOL_ROW)).toThrow(PageDataError);
  });

  it.each([
    ['null', null],
    ['no seller', { ...POOL_ROW, seller: undefined }],
    ['an id as text', { ...POOL_ROW, id: '4' }],
    ['an id beyond 2^53', { ...POOL_ROW, id: U64_MAX }],
  ])('throws a PageDataError for a page that holds a row with %s', (_kind, row) => {
    expect(() => parsePoolRefs([POOL_ROW, row])).toThrow(PageDataError);
  });
});

describe('parseSeats', () => {
  it('accepts a get_seats page', () => {
    const rows = [
      { buyer: 'buyer-01.quorum.testnet', seats: 24, state: 'committed' },
      { buyer: 'buyer-02.quorum.testnet', seats: 20, state: 'claimable' },
    ];
    expect(parseSeats(rows)).toEqual(rows);
  });

  it.each([
    ['not a list', { buyer: 'buyer-01.quorum.testnet', seats: 24, state: 'committed' }],
    ['a row with an unknown state', [{ buyer: 'buyer-01.quorum.testnet', seats: 24, state: 'settled' }]],
    ['a row with seats as text', [{ buyer: 'buyer-01.quorum.testnet', seats: '24', state: 'committed' }]],
    ['a row with no buyer', [{ seats: 24, state: 'committed' }]],
  ])('throws a PageDataError for a page that is %s', (_kind, page) => {
    expect(() => parseSeats(page)).toThrow(PageDataError);
  });
});

describe('parseActivity', () => {
  it('accepts the records of the activity feed', () => {
    const feed = [activity({}), activity({ kind: 'dust', account: 'provider.quorum.testnet', seats: 0, amount: '72' })];
    expect(parseActivity(feed)).toEqual(feed);
  });

  it.each([
    ['not a list', activity({})],
    ['a record of an unknown kind', [{ ...activity({}), kind: 'claim' }]],
    ['a record with no hash', [{ ...activity({}), txHash: undefined }]],
    ['a record with ok as text', [{ ...activity({}), ok: 'true' }]],
    ['a record with an amount as a number', [{ ...activity({}), amount: 7680 }]],
  ])('throws a PageDataError for a feed that is %s', (_kind, feed) => {
    expect(() => parseActivity(feed)).toThrow(PageDataError);
  });
});

describe('parseConfig', () => {
  const CONFIG = {
    network: 'near:testnet',
    rpcUrl: '/rpc',
    poolsContract: 'pools.quorum.testnet',
    token: '3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af',
    provider: 'provider.quorum.testnet',
    explorerTxUrl: EXPLORER,
  };

  it("accepts the gateway's /config.json, reading a missing demo as off", () => {
    expect(parseConfig(CONFIG)).toEqual({ ...CONFIG, demo: false });
  });

  it.each([true, false])('keeps demo: %s', (demo) => {
    expect(parseConfig({ ...CONFIG, demo })).toEqual({ ...CONFIG, demo });
  });

  it('accepts an explorer prefix that ends in a query parameter, whose links keep its origin', () => {
    const config = { ...CONFIG, explorerTxUrl: 'https://explorer.example/tx?hash=' };
    expect(parseConfig(config)).toEqual({ ...config, demo: false });
    expect(new URL(txUrl(config.explorerTxUrl, COMMIT_1) ?? '').origin).toBe('https://explorer.example');
  });

  it.each([
    ['not an object', [CONFIG]],
    ['missing the provider', { ...CONFIG, provider: undefined }],
    ['an RPC URL that is not text', { ...CONFIG, rpcUrl: 8402 }],
    ['an explorer URL that is not http(s)', { ...CONFIG, explorerTxUrl: 'javascript:alert(1)//' }],
    ['an explorer URL that is not a URL', { ...CONFIG, explorerTxUrl: 'nearblocks' }],
    // A hash appended to these would change the host: https://explorer.example<hash>/.
    ['an explorer URL with no path', { ...CONFIG, explorerTxUrl: 'https://explorer.example' }],
    ['an explorer URL whose host ends in =', { ...CONFIG, explorerTxUrl: 'https://explorer.example=' }],
    ['an explorer URL that ends in neither / nor =', { ...CONFIG, explorerTxUrl: 'https://testnet.nearblocks.io/txns' }],
    ['demo as text', { ...CONFIG, demo: 'true' }],
    ['demo as null', { ...CONFIG, demo: null }],
  ])('throws a PageDataError for a configuration with %s', (_kind, config) => {
    expect(() => parseConfig(config)).toThrow(PageDataError);
  });
});

describe('parseToken', () => {
  const METADATA = { spec: 'ft-1.0.0', name: 'USDC', symbol: 'USDC', icon: null, reference: null, reference_hash: null, decimals: 6 };

  it('keeps the decimals and the symbol of ft_metadata', () => {
    expect(parseToken(METADATA)).toStrictEqual({ decimals: 6, symbol: 'USDC' });
  });

  it.each([
    ['decimals as text', { ...METADATA, decimals: '6' }],
    ['negative decimals', { ...METADATA, decimals: -1 }],
    ['decimals beyond a u8', { ...METADATA, decimals: 256 }],
    ['no symbol', { ...METADATA, symbol: undefined }],
  ])('throws a PageDataError for metadata with %s', (_kind, metadata) => {
    expect(() => parseToken(metadata)).toThrow(PageDataError);
  });

  it('throws a PageDataError for null', () => {
    expect(() => parseToken(null)).toThrow(PageDataError);
  });
});

describe('parseBalance', () => {
  it('accepts the decimal string ft_balance_of returns', () => {
    expect(parseBalance('35072')).toBe('35072');
  });

  it.each([35072, '-1', null])('throws a PageDataError for %j', (balance) => {
    expect(() => parseBalance(balance)).toThrow(PageDataError);
  });
});

describe('readAll', () => {
  /** A paged view over `count` rows, recording each call's `from` and `limit`. */
  function pagedView(count: number) {
    const rows = Array.from({ length: count }, (_, i) => i);
    const calls: [number, number][] = [];
    const readPage = async (from: number, limit: number) => {
      calls.push([from, limit]);
      return rows.slice(from, from + limit);
    };
    return { readPage, calls };
  }

  it('reads a single page when it is shorter than 100 rows', async () => {
    const { readPage, calls } = pagedView(6);
    expect(await readAll(readPage)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(calls).toEqual([[0, 100]]);
  });

  it('reads pages of 100 until a shorter one', async () => {
    const { readPage, calls } = pagedView(203);
    expect(await readAll(readPage)).toHaveLength(203);
    expect(calls).toEqual([
      [0, 100],
      [100, 100],
      [200, 100],
    ]);
  });

  it('reads one empty page after a last page that is full', async () => {
    const { readPage, calls } = pagedView(100);
    expect(await readAll(readPage)).toHaveLength(100);
    expect(calls).toEqual([
      [0, 100],
      [100, 100],
    ]);
  });

  // A page the contract cuts short would be taken for the last one, and the rows after it never read;
  // a smaller page only costs more requests.
  it('asks for no more rows than the pools contract returns in one call, its MAX_PAGE', async () => {
    const source = readFileSync(new URL('../../../contracts/pools/src/types.rs', import.meta.url), 'utf8');
    const maxPage = Number(/pub const MAX_PAGE: u64 = (\d+);/.exec(source)?.[1]);
    expect(Number.isSafeInteger(maxPage) && maxPage > 0, 'MAX_PAGE is read from the contract').toBe(true);
    const { readPage, calls } = pagedView(0);
    await readAll(readPage);
    const limit = calls[0]?.[1] ?? Number.NaN;
    expect(limit).toBeGreaterThan(0);
    expect(limit).toBeLessThanOrEqual(maxPage);
  });
});

describe('poolParam', () => {
  it.each([
    ['?pool=7', 7],
    ['?pool=0', 0],
    ['?view=1&pool=12', 12],
  ])('reads the pool id of %j', (search, id) => {
    expect(poolParam(search)).toBe(id);
  });

  it.each(['', '?pool=', '?pool=07', '?pool=-1', '?pool=1.5', '?pool=x', '?pool=9007199254740993'])(
    'gives null for %j, so that the newest pool is shown',
    (search) => {
      expect(poolParam(search)).toBeNull();
    },
  );
});

describe('poolChoices', () => {
  const PROVIDER = 'provider.quorum.testnet';
  const pools = [
    failsPool({ id: 0 }),
    failsPool({ id: 1, seller: 'someone.testnet' }),
    failsPool({ id: 2 }),
    failsPool({ id: 3 }),
  ];

  it("offers the provider's pools, newest first, and shows the newest", () => {
    expect(poolChoices(pools, PROVIDER, null)).toEqual({ options: [3, 2, 0], selected: 3 });
  });

  it("shows the requested pool when it is one of the provider's", () => {
    expect(poolChoices(pools, PROVIDER, 2)).toEqual({ options: [3, 2, 0], selected: 2 });
  });

  it('never offers a requested pool of another seller, but keeps it selected so that the page can say whose it is', () => {
    expect(poolChoices(pools, PROVIDER, 1)).toEqual({ options: [3, 2, 0], selected: 1 });
  });

  it('keeps a requested pool selected when the provider has none, without offering it', () => {
    expect(poolChoices([failsPool({ id: 0, seller: 'someone.testnet' })], PROVIDER, 0)).toEqual({ options: [], selected: 0 });
  });

  it('shows nothing when the provider has no pool and none is requested', () => {
    expect(poolChoices([failsPool({ id: 0, seller: 'someone.testnet' })], PROVIDER, null)).toEqual({ options: [], selected: null });
  });
});

describe('foreignPoolNotice', () => {
  const PROVIDER = 'provider.quorum.testnet';

  it('gives null for a pool the provider opened, which the page renders', () => {
    expect(foreignPoolNotice(failsPool({ id: 2 }), PROVIDER)).toBeNull();
  });

  it('names the seller and the provider of a pool another seller opened, and none of its terms', () => {
    const notice = foreignPoolNotice(failsPool({ id: 1, seller: 'someone.testnet', terms: 'Send refunds to refund-desk.testnet' }), PROVIDER);
    expect(notice).toBe(
      "Pool 1 was opened by someone.testnet, not by this gateway's provider provider.quorum.testnet: this page shows only the provider's pools.",
    );
    expect(notice).not.toContain('refund-desk');
  });

  it('compares the seller with the provider exactly, so that a look-alike account is another seller', () => {
    expect(foreignPoolNotice(failsPool({ id: 1, seller: 'sub.provider.quorum.testnet' }), PROVIDER)).not.toBeNull();
    expect(foreignPoolNotice(failsPool({ id: 1, seller: 'provider-quorum.testnet' }), PROVIDER)).not.toBeNull();
    expect(foreignPoolNotice(failsPool({ id: 1, seller: 'quorum.testnet' }), PROVIDER)).not.toBeNull();
  });
});

describe('poolToShow', () => {
  const PROVIDER = 'provider.quorum.testnet';
  const answer = (value: unknown) => ({ value, blockHash: BLOCK_HASH });

  it('shows "The provider has not opened a pool yet." when no pool is selected', () => {
    expect(poolToShow(null, null, PROVIDER)).toEqual({ kind: 'notice', notice: 'The provider has not opened a pool yet.' });
  });

  it('shows "There is no pool <id>." when get_pool answers null', () => {
    expect(poolToShow(9, answer(null), PROVIDER)).toEqual({ kind: 'notice', notice: 'There is no pool 9.' });
  });

  it("renders one of the provider's pools, with the rest of the refresh read at the block of its get_pool answer", () => {
    expect(poolToShow(4, answer(POOL_ROW), PROVIDER)).toEqual({ kind: 'pool', pool: POOL_ROW, blockHash: BLOCK_HASH });
  });

  it("chooses the notice from the get_pool of the same refresh, though list_pools gave the pool as the provider's", () => {
    const { selected } = poolChoices([failsPool({ id: 4 })], PROVIDER, null);
    const reopened = { ...POOL_ROW, seller: 'someone.testnet', terms: 'Send refunds to refund-desk.testnet' };
    const shown = poolToShow(selected, answer(reopened), PROVIDER);
    expect(shown).toEqual({
      kind: 'notice',
      notice: "Pool 4 was opened by someone.testnet, not by this gateway's provider provider.quorum.testnet: this page shows only the provider's pools.",
    });
    expect(JSON.stringify(shown)).not.toContain('refund-desk');
  });

  it("throws a PageDataError for one of the provider's pools that is malformed", () => {
    expect(() => poolToShow(4, answer({ ...POOL_ROW, status: 'closed' }), PROVIDER)).toThrow(PageDataError);
  });

  it.each([
    ['that is text', 'pool 4'],
    ['with no seller', { ...POOL_ROW, seller: undefined }],
  ])('throws a PageDataError for a get_pool answer %s', (_kind, value) => {
    expect(() => poolToShow(4, answer(value), PROVIDER)).toThrow(PageDataError);
  });
});

describe('a pool another seller opened with a deadline beyond 2^53', () => {
  const PROVIDER = 'provider.quorum.testnet';
  // Anyone can open such a pool: the contract bounds deadline_ms only from below.
  const hostile = { ...POOL_ROW, id: 5, seller: 'someone.testnet', deadline_ms: U64_MAX };
  const NOTICE = "Pool 5 was opened by someone.testnet, not by this gateway's provider provider.quorum.testnet: this page shows only the provider's pools.";

  it("does not stop the provider's pool from rendering when it is in the list", () => {
    const { options, selected } = poolChoices(parsePoolRefs([POOL_ROW, hostile]), PROVIDER, null);
    expect({ options, selected }).toEqual({ options: [4], selected: 4 });
    expect(poolToShow(selected, { value: POOL_ROW, blockHash: BLOCK_HASH }, PROVIDER)).toEqual({
      kind: 'pool',
      pool: POOL_ROW,
      blockHash: BLOCK_HASH,
    });
  });

  it('gets the notice naming its seller when it is the selected pool', () => {
    const { selected } = poolChoices(parsePoolRefs([POOL_ROW, hostile]), PROVIDER, 5);
    expect(poolToShow(selected, { value: hostile, blockHash: BLOCK_HASH }, PROVIDER)).toEqual({ kind: 'notice', notice: NOTICE });
  });

  it.each([
    ['terms that are not text', { terms: ['8×GPU'] }],
    ['an unknown status', { status: 'closed' }],
    ['no seat price', { seat_price: undefined }],
  ])('gets the notice whatever else it holds, such as %s', (_kind, changes) => {
    expect(poolToShow(5, { value: { ...hostile, ...changes }, blockHash: BLOCK_HASH }, PROVIDER)).toEqual({ kind: 'notice', notice: NOTICE });
  });
});

describe('countdown', () => {
  const NOW = 1_800_000_000_000;

  it.each([
    [600_000, '10:00'],
    [59_001, '1:00'],
    [500, '0:01'],
    [3_723_000, '1:02:03'],
    [90_000_000, '25:00:00'],
  ])('shows %i ms left as %s', (left, text) => {
    expect(countdown(NOW + left, NOW)).toBe(text);
  });

  it('shows 0:00 at and after the deadline', () => {
    expect(countdown(NOW, NOW)).toBe('0:00');
    expect(countdown(NOW - 5_000, NOW)).toBe('0:00');
  });
});

describe('countdownText', () => {
  const NOW = 1_800_000_000_000;

  it('counts down while the pool is open', () => {
    expect(countdownText('open', NOW + 600_000, NOW)).toBe('10:00');
    expect(countdownText('open', NOW + 3_723_000, NOW)).toBe('1:02:03');
  });

  it('shows 0:00 for an open pool whose deadline has passed on this clock, since only block time decides', () => {
    expect(countdownText('open', NOW - 5_000, NOW)).toBe('0:00');
  });

  it.each(['filled', 'settled', 'expired', 'refunded'] as const)('shows closed for a pool that is %s, whatever its deadline', (status) => {
    expect(countdownText(status, NOW + 600_000, NOW)).toBe('closed');
    expect(countdownText(status, NOW - 600_000, NOW)).toBe('closed');
  });
});

/** The time the demo tests read: 08:00:00 UTC. */
const DEMO_NOW = 1_800_000_000_000;
/** Writes a time as the demo line would, in UTC, so that the tests do not depend on the time zone. */
const utcTime = (ms: number): string => new Date(ms).toISOString().slice(11, 19);
const IDLE: DemoStatus = { running: false, scenario: null, startedAt: null, last: null, runsToday: 0, maxRunsPerDay: 100 };
/** A fills run started at 07:58:30. */
const RUNNING: DemoStatus = { ...IDLE, running: true, scenario: 'fills', startedAt: DEMO_NOW - 90_000, runsToday: 1 };
/** A fails run that exited with code 0 at 07:59:30. */
const ENDED_RUN: DemoLastRun = { scenario: 'fails', startedAt: DEMO_NOW - 300_000, endedAt: DEMO_NOW - 30_000, exitCode: 0, signal: null };
const ENDED: DemoStatus = { ...IDLE, runsToday: 1, last: ENDED_RUN };
/** Today's cap reached: 100 runs of 100, the last one ended well. */
const CAPPED: DemoStatus = { ...ENDED, runsToday: 100 };

/** The demo line at DEMO_NOW for `status` (null: GET /demo could not be read), after `click` if given. */
function demoLineAt(status: DemoStatus | null, click: DemoClick | null = null): string {
  return demoLine({ now: DEMO_NOW, click, status, time: utcTime });
}

/** A click whose answer arrived `ago` milliseconds before DEMO_NOW. */
function clickAgo(ago: number, answer: DemoClick['answer']): DemoClick {
  return { at: DEMO_NOW - ago, answer };
}

describe('parseDemoStatus', () => {
  const STOPPED_RUN = { scenario: 'fills', startedAt: DEMO_NOW - 2_000_000, endedAt: DEMO_NOW - 200_000, exitCode: null, signal: 'SIGTERM' };

  it.each([
    ['no run yet', IDLE],
    ['a run in progress', RUNNING],
    ['a last run that exited', ENDED],
    ['a last run ended by a signal', { ...IDLE, runsToday: 3, last: STOPPED_RUN }],
    ['a last run whose program could not be started', { ...IDLE, runsToday: 1, last: { ...STOPPED_RUN, signal: null } }],
    ["the day's cap reached", CAPPED],
  ])("accepts the gateway's GET /demo with %s", (_kind, status) => {
    expect(parseDemoStatus(status)).toEqual(status);
  });

  it.each([
    ['not an object', [IDLE]],
    ['running as text', { ...IDLE, running: 'false' }],
    ['an unknown scenario', { ...RUNNING, scenario: 'drains' }],
    ['a run in progress with no scenario', { ...RUNNING, scenario: null }],
    ['a run in progress with no start time', { ...RUNNING, startedAt: null }],
    ['a scenario while no run is in progress', { ...IDLE, scenario: 'fills' }],
    ['a start time as text', { ...RUNNING, startedAt: '1800000000000' }],
    ['a last run with an unknown scenario', { ...ENDED, last: { ...ENDED_RUN, scenario: 'drains' } }],
    ['a last run with no end time', { ...ENDED, last: { ...ENDED_RUN, endedAt: undefined } }],
    ['a last run with an exit code as text', { ...ENDED, last: { ...ENDED_RUN, exitCode: '0' } }],
    ['a last run with a signal as a number', { ...ENDED, last: { ...ENDED_RUN, exitCode: null, signal: 15 } }],
    ['a negative count of runs', { ...IDLE, runsToday: -1 }],
    ['a cap that is not a whole number', { ...IDLE, maxRunsPerDay: 1.5 }],
  ])('throws a PageDataError for a status with %s', (_kind, status) => {
    expect(() => parseDemoStatus(status)).toThrow(PageDataError);
  });
});

describe('parseDemoAnswer', () => {
  it('keeps the status and the error code of an answer', () => {
    expect(parseDemoAnswer(409, { error: 'demo_running', scenario: 'fills', startedAt: DEMO_NOW })).toEqual({
      status: 409,
      error: 'demo_running',
    });
  });

  it.each([
    ['a 202, which has no error', 202, { scenario: 'fills', startedAt: DEMO_NOW }],
    ['a body that is not JSON', 502, null],
    ['an error that is not text', 409, { error: 409 }],
  ])('gives a null error for %s', (_kind, status, body) => {
    expect(parseDemoAnswer(status, body)).toEqual({ status, error: null });
  });
});

describe('statusAfterAnswer', () => {
  /** When the run a click's answer reports started: 07:59:58. */
  const STARTED_AT = DEMO_NOW - 2_000;

  it('takes a 202 for the run it started: in progress, with its scenario and start, and counted today, the rest as GET /demo last said', () => {
    expect(statusAfterAnswer(ENDED, 202, { scenario: 'fills', startedAt: STARTED_AT })).toEqual({
      ...ENDED,
      running: true,
      scenario: 'fills',
      startedAt: STARTED_AT,
      runsToday: 2,
    });
  });

  it('takes a 409 demo_running for the run it names: in progress, with its scenario and start, and already counted', () => {
    expect(statusAfterAnswer(ENDED, 409, { error: 'demo_running', scenario: 'fails', startedAt: STARTED_AT })).toEqual({
      ...ENDED,
      running: true,
      scenario: 'fails',
      startedAt: STARTED_AT,
    });
  });

  it.each([
    ['409 pool_open', 409, { error: 'pool_open', poolId: 3 }],
    ['429', 429, { error: 'demo_limit' }],
    ['503', 503, { error: 'chain_unavailable' }],
    ['403', 403, { error: 'demo_header_required' }],
    ['404, the demo being off', 404, { error: 'not_found' }],
    ['a 409 with a run but another error', 409, { error: 'conflict', scenario: 'fills', startedAt: STARTED_AT }],
    ['a 202 with no JSON body', 202, null],
    ['a 202 with an unknown scenario', 202, { scenario: 'drains', startedAt: STARTED_AT }],
    ['a 202 with a start time as text', 202, { scenario: 'fills', startedAt: String(STARTED_AT) }],
    ['a 409 demo_running with no start time', 409, { error: 'demo_running', scenario: 'fills' }],
  ])('is null for %s, which reports no run', (_kind, status, body) => {
    expect(statusAfterAnswer(ENDED, status, body)).toBeNull();
  });

  it('is null when GET /demo could not be read, which leaves nothing to complete the run with', () => {
    expect(statusAfterAnswer(null, 202, { scenario: 'fills', startedAt: STARTED_AT })).toBeNull();
  });
});

describe('demoLine', () => {
  it.each([
    ['202', { status: 202, error: null }, 'A run started. Its pool appears here once it opens.'],
    ['409 demo_running', { status: 409, error: 'demo_running' }, 'A run is already in progress. This page follows its pool once it opens.'],
    ['409 pool_open', { status: 409, error: 'pool_open' }, 'A pool is still open. This page shows it.'],
    ['429', { status: 429, error: 'demo_limit' }, 'The demo has reached its limit for today.'],
    ['409 with another error', { status: 409, error: 'conflict' }, 'The demo is not available right now.'],
    ['403', { status: 403, error: 'demo_header_required' }, 'The demo is not available right now.'],
    ['404, the demo being off', { status: 404, error: 'not_found' }, 'The demo is not available right now.'],
    ['503', { status: 503, error: 'chain_unavailable' }, 'The demo is not available right now.'],
    ['500 with no error code', { status: 500, error: null }, 'The demo is not available right now.'],
    ['no answer', null, 'The gateway could not be reached.'],
  ])('shows the answer %s to a click for 10 seconds', (_kind, answer, text) => {
    expect(demoLineAt(IDLE, clickAgo(0, answer))).toBe(text);
    expect(demoLineAt(IDLE, clickAgo(9_999, answer))).toBe(text);
  });

  it('shows the answer to a click before anything GET /demo says', () => {
    for (const status of [null, RUNNING, CAPPED, ENDED, IDLE]) {
      expect(demoLineAt(status, clickAgo(5_000, { status: 202, error: null }))).toBe('A run started. Its pool appears here once it opens.');
    }
  });

  it('goes back to what GET /demo says 10 seconds after the answer arrived', () => {
    expect(DEMO_ANSWER_MS).toBe(10_000);
    expect(demoLineAt(RUNNING, clickAgo(10_000, { status: 202, error: null }))).toBe('A fills run started at 07:58:30 is in progress.');
  });

  it("says the demo's status is unavailable when GET /demo cannot be read", () => {
    expect(demoLineAt(null)).toBe("The demo's status is unavailable.");
    expect(demoLineAt(null, clickAgo(60_000, { status: 202, error: null }))).toBe("The demo's status is unavailable.");
  });

  it('names the scenario of the run in progress and when it started, before the cap', () => {
    expect(demoLineAt(RUNNING)).toBe('A fills run started at 07:58:30 is in progress.');
    expect(demoLineAt({ ...RUNNING, runsToday: 100 })).toBe('A fills run started at 07:58:30 is in progress.');
  });

  it("says when today's cap is reached, before the last run", () => {
    expect(demoLineAt(CAPPED)).toBe('The demo has reached its limit for today.');
    expect(demoLineAt({ ...CAPPED, last: { ...ENDED_RUN, exitCode: 1 } })).toBe('The demo has reached its limit for today.');
    expect(demoLineAt({ ...IDLE, runsToday: 100 })).toBe('The demo has reached its limit for today.');
  });

  it('names the scenario of the last run and when it ended, when it exited with code 0', () => {
    expect(demoLineAt(ENDED)).toBe('The last run (fails) ended at 07:59:30.');
  });

  it.each([
    ['an exit code of 1', { exitCode: 1, signal: null }],
    ['a signal', { exitCode: null, signal: 'SIGKILL' }],
    ['a program that could not be started', { exitCode: null, signal: null }],
  ])('reports a last run that ended with %s as an error', (_kind, end) => {
    expect(demoLineAt({ ...ENDED, last: { ...ENDED_RUN, ...end } })).toBe(
      'The last run ended with an error. Its testnet funds may need a refill.',
    );
  });

  it('invites a first run when there has been none', () => {
    expect(demoLineAt(IDLE)).toBe('Start a run to watch a pool from its first seat.');
  });
});

describe('demoControls', () => {
  it('hides the buttons and the demo line unless /config.json says demo: true', () => {
    expect(demoControls({ demo: false, status: IDLE, sending: false })).toEqual({ shown: false, enabled: false });
  });

  it('enables the buttons when no run is in progress and the cap is not reached', () => {
    expect(demoControls({ demo: true, status: IDLE, sending: false })).toEqual({ shown: true, enabled: true });
    expect(demoControls({ demo: true, status: { ...ENDED, runsToday: 99 }, sending: false })).toEqual({ shown: true, enabled: true });
  });

  it.each([
    ['a run is in progress', RUNNING, false],
    ["today's cap is reached", CAPPED, false],
    ['GET /demo cannot be read', null, false],
    ["a button's request is on its way", IDLE, true],
  ])('disables the buttons, still shown, when %s', (_kind, status, sending) => {
    expect(demoControls({ demo: true, status, sending })).toEqual({ shown: true, enabled: false });
  });
});

describe('demoRequest', () => {
  it.each(['fills', 'fails'] as const)('POSTs /demo/%s with the header X-Quorum-Demo: 1', (scenario) => {
    expect(demoRequest(scenario)).toEqual({ url: `/demo/${scenario}`, method: 'POST', headers: { 'X-Quorum-Demo': '1' } });
  });
});

describe('withoutPoolParam', () => {
  it.each([
    ['https://quorum.example/?pool=7', 'https://quorum.example/'],
    ['https://quorum.example/?view=1&pool=7#ledger', 'https://quorum.example/?view=1#ledger'],
    ['https://quorum.example/?pool=7&pool=8', 'https://quorum.example/'],
    ['https://quorum.example/', 'https://quorum.example/'],
  ])('turns %s into %s, so that the page follows the newest pool', (href, expected) => {
    expect(withoutPoolParam(href)).toBe(expected);
  });
});
