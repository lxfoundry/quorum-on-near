import { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { PoolView, QuorumEvent } from '@quorum-on-near/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActivityLog, keeperCallProgressed, keeperRecords, type ActivityRecord } from '../src/activity.ts';
import { NOW_MS, POOLS, PROVIDER, TOKEN, eventLog, outcome, poolView, type ReceiptSpec } from './fake-chain.ts';

// appendFile is the real one unless a test makes one call fail.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, appendFile: vi.fn(actual.appendFile) };
});
const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');

const ALICE = 'alice.testnet';
const BOB = 'bob.testnet';
const CAROL = 'carol.testnet';

function record(overrides: Partial<ActivityRecord> = {}): ActivityRecord {
  return {
    at: NOW_MS,
    poolId: 7,
    kind: 'commit',
    account: ALICE,
    seats: 2,
    amount: '360',
    txHash: 'Tx1',
    ok: true,
    ...overrides,
  };
}

describe('ActivityLog', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'quorum-activity-'));
    file = join(dir, 'feed', 'activity.jsonl');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('creates the folder of its file when it does not exist', async () => {
    await ActivityLog.open(file);
    expect((await stat(join(dir, 'feed'))).isDirectory()).toBe(true);
  });

  it('starts empty when its file does not exist', async () => {
    const log = await ActivityLog.open(file);
    expect(log.list()).toEqual([]);
  });

  it('appends each record to its file as one JSON line', async () => {
    const log = await ActivityLog.open(file);
    const first = record({ txHash: 'Tx1' });
    const second = record({ txHash: 'Tx2', kind: 'settle', account: PROVIDER });
    await log.append(first);
    await log.append(second);
    expect(await readFile(file, 'utf8')).toBe(`${JSON.stringify(first)}\n${JSON.stringify(second)}\n`);
  });

  it('reloads the appended records when the file is opened again', async () => {
    const log = await ActivityLog.open(file);
    const records = [record({ txHash: 'Tx1' }), record({ txHash: 'Tx2', poolId: 8, ok: false })];
    for (const r of records) await log.append(r);
    const reopened = await ActivityLog.open(file);
    expect(reopened.list()).toEqual(records);
  });

  it('appends after the records it loaded', async () => {
    const first = record({ txHash: 'Tx1' });
    const second = record({ txHash: 'Tx2' });
    await (await ActivityLog.open(file)).append(first);
    const reopened = await ActivityLog.open(file);
    await reopened.append(second);
    expect(reopened.list()).toEqual([first, second]);
    expect((await ActivityLog.open(file)).list()).toEqual([first, second]);
  });

  it('skips lines that are not activity records when loading', async () => {
    const good = [record({ txHash: 'Tx1' }), record({ txHash: 'Tx2' })];
    const lines = [
      JSON.stringify(good[0]),
      'not json',
      '',
      '42',
      JSON.stringify({ ...record(), kind: 'mint' }),
      JSON.stringify({ ...record(), amount: 360 }),
      JSON.stringify({ ...record(), txHash: undefined }),
      JSON.stringify(good[1]),
      '{"at":1799999000000,"poolId":7,"ki',
    ];
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, lines.join('\n'));
    const log = await ActivityLog.open(file);
    expect(log.list()).toEqual(good);
  });

  it('keeps a record appended after a line cut short when the process stopped mid-write', async () => {
    const kept = record({ txHash: 'Tx1' });
    const appended = record({ kind: 'refund', txHash: 'Tx3' });
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(kept)}\n{"at":1799999000000,"poolId":7,"ki`);
    await (await ActivityLog.open(file)).append(appended);
    const reopened = await ActivityLog.open(file);
    expect(reopened.list()).toEqual([kept, appended]);
    expect(reopened.lastRefund(7, ALICE)?.txHash).toBe('Tx3');
  });

  it('starts the record after an append that failed mid-write on a line of its own', async () => {
    const lost = record({ kind: 'settle', account: PROVIDER, txHash: 'Tx1' });
    const kept = [record({ txHash: 'Tx2' }), record({ kind: 'refund', txHash: 'Tx3' })];
    const log = await ActivityLog.open(file);
    // The disk fills mid-write: part of the line reaches the file, then the write fails.
    const partial = JSON.stringify(lost).slice(0, 20);
    const failure = Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
    vi.mocked(appendFile).mockImplementationOnce(async (path) => {
      await fs.appendFile(path, partial);
      throw failure;
    });
    await expect(log.append(lost)).rejects.toBe(failure);
    for (const r of kept) await log.append(r);
    expect(await readFile(file, 'utf8')).toBe(`${partial}
${JSON.stringify(kept[0])}
${JSON.stringify(kept[1])}
`);
    expect(log.list()).toEqual(kept);
    const reopened = await ActivityLog.open(file);
    expect(reopened.list()).toEqual(kept);
    expect(reopened.lastRefund(7, ALICE)?.txHash).toBe('Tx3');
  });

  it('adds nothing to a file that already ends with a newline', async () => {
    const line = `${JSON.stringify(record())}\n`;
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, line);
    await ActivityLog.open(file);
    expect(await readFile(file, 'utf8')).toBe(line);
  });

  it('lists every record, oldest first', async () => {
    const log = await ActivityLog.open(file);
    const records = [record({ txHash: 'Tx1', poolId: 7 }), record({ txHash: 'Tx2', poolId: 8 }), record({ txHash: 'Tx3', poolId: 7 })];
    for (const r of records) await log.append(r);
    expect(log.list()).toEqual(records);
  });

  it("lists only one pool's records, in order, when given a pool id", async () => {
    const log = await ActivityLog.open(file);
    const records = [record({ txHash: 'Tx1', poolId: 7 }), record({ txHash: 'Tx2', poolId: 8 }), record({ txHash: 'Tx3', poolId: 7 })];
    for (const r of records) await log.append(r);
    expect(log.list(7).map((r) => r.txHash)).toEqual(['Tx1', 'Tx3']);
    expect(log.list(9)).toEqual([]);
  });

  it('finds the latest successful refund for that buyer in that pool', async () => {
    const log = await ActivityLog.open(file);
    const records = [
      record({ kind: 'refund', txHash: 'Tx1' }),
      record({ kind: 'refund', txHash: 'Tx2' }),
      record({ kind: 'refund', txHash: 'Tx3', ok: false, seats: 0 }),
      record({ kind: 'refund', txHash: 'Tx4', poolId: 8 }),
      record({ kind: 'refund', txHash: 'Tx5', account: BOB }),
      record({ kind: 'commit', txHash: 'Tx6' }),
    ];
    for (const r of records) await log.append(r);
    expect(log.lastRefund(7, ALICE)?.txHash).toBe('Tx2');
  });

  it('finds no refund for a buyer that has no successful refund in that pool', async () => {
    const log = await ActivityLog.open(file);
    await log.append(record({ kind: 'commit', txHash: 'Tx1' }));
    await log.append(record({ kind: 'refund', txHash: 'Tx2', ok: false, seats: 0 }));
    expect(log.lastRefund(7, ALICE)).toBeUndefined();
  });
});

describe('keeperRecords', () => {
  const AT = NOW_MS;

  it('gives one settle record, for the seller and every seat taken, from pool_settled', () => {
    const pool = poolView({ status: 'filled', taken: 192 });
    const tx = outcome('SettleTx', [
      { executorId: POOLS },
      { executorId: TOKEN },
      { executorId: POOLS, events: [{ event: 'pool_settled', data: { pool_id: 7, seller: PROVIDER, amount: '36288' } }] },
    ]);
    expect(keeperRecords('settle', pool, tx, POOLS, AT)).toEqual([
      { at: AT, poolId: 7, kind: 'settle', account: PROVIDER, seats: 192, amount: '36288', txHash: 'SettleTx', ok: true },
    ]);
  });

  it('gives a refund record per seat_refunded and refund_failed, and a dust record for pool_refunded', () => {
    // bonus 1728 over 5 seats: 345 a seat, dust 3
    const pool = poolView({ status: 'expired', taken: 5, bonus_per_seat: '345' });
    const tx = outcome('RefundTx', [
      { executorId: POOLS },
      { executorId: TOKEN },
      { executorId: TOKEN },
      { executorId: TOKEN, failed: true },
      { executorId: TOKEN },
      {
        executorId: POOLS,
        events: [{ event: 'seat_refunded', data: { pool_id: 7, buyer: ALICE, seats: 2, amount: '1050', bonus_share: '690' } }],
      },
      {
        executorId: POOLS,
        events: [{ event: 'seat_refunded', data: { pool_id: 7, buyer: BOB, seats: 1, amount: '525', bonus_share: '345' } }],
      },
      { executorId: POOLS, events: [{ event: 'refund_failed', data: { pool_id: 7, buyer: CAROL, amount: '1050' } }] },
      { executorId: POOLS, events: [{ event: 'pool_refunded', data: { pool_id: 7, dust: '3' } }] },
    ]);
    expect(keeperRecords('refund', pool, tx, POOLS, AT)).toEqual([
      { at: AT, poolId: 7, kind: 'refund', account: ALICE, seats: 2, amount: '1050', txHash: 'RefundTx', ok: true },
      { at: AT, poolId: 7, kind: 'refund', account: BOB, seats: 1, amount: '525', txHash: 'RefundTx', ok: true },
      { at: AT, poolId: 7, kind: 'refund', account: CAROL, seats: 0, amount: '1050', txHash: 'RefundTx', ok: false },
      { at: AT, poolId: 7, kind: 'dust', account: PROVIDER, seats: 0, amount: '3', txHash: 'RefundTx', ok: true },
    ]);
  });

  it('gives a dust record for a pool_refunded that the refund call itself emitted', () => {
    // bonus 1728 over 4 seats: 432 a seat, no dust
    const pool = poolView({ status: 'expired', taken: 4, bonus: '1728', bonus_per_seat: '432' });
    const tx = outcome('LastBatchTx', [
      { executorId: POOLS, events: [{ event: 'pool_refunded', data: { pool_id: 7, dust: '0' } }] },
      { executorId: TOKEN },
      {
        executorId: POOLS,
        events: [{ event: 'seat_refunded', data: { pool_id: 7, buyer: ALICE, seats: 4, amount: '2448', bonus_share: '1728' } }],
      },
    ]);
    expect(keeperRecords('refund', pool, tx, POOLS, AT)).toEqual([
      { at: AT, poolId: 7, kind: 'dust', account: PROVIDER, seats: 0, amount: '0', txHash: 'LastBatchTx', ok: true },
      { at: AT, poolId: 7, kind: 'refund', account: ALICE, seats: 4, amount: '2448', txHash: 'LastBatchTx', ok: true },
    ]);
  });

  it.each(['settle', 'refund'] as const)('gives one failed %s record for a call that produced no events', (kind) => {
    const pool = poolView({ status: kind === 'settle' ? 'filled' : 'expired' });
    const tx = outcome('FailedTx', [{ executorId: POOLS, failed: true }]);
    expect(keeperRecords(kind, pool, tx, POOLS, AT)).toEqual([
      { at: AT, poolId: 7, kind, account: PROVIDER, seats: 0, amount: '0', txHash: 'FailedTx', ok: false },
    ]);
  });

  it('gives no record for a refund batch that only passed buyers who had claimed their own refunds', () => {
    const pool = poolView({ status: 'expired', buyer_count: 10, refund_cursor: 0 });
    const tx = outcome('SkippedTx', [{ executorId: POOLS }]);
    expect(keeperRecords('refund', pool, tx, POOLS, AT)).toEqual([]);
  });

  it('gives one failed refund record for a call that only retried the dust, whose transfer failed', () => {
    const pool = poolView({ status: 'expired', buyer_count: 10, refund_cursor: 10, dust_sent: false });
    const tx = outcome('DustTx', [{ executorId: POOLS }, { executorId: TOKEN, failed: true }, { executorId: POOLS }]);
    expect(keeperRecords('refund', pool, tx, POOLS, AT)).toEqual([
      { at: AT, poolId: 7, kind: 'refund', account: PROVIDER, seats: 0, amount: '0', txHash: 'DustTx', ok: false },
    ]);
  });

  it('ignores events logged by an account other than the pools contract', () => {
    const pool = poolView({ status: 'expired', taken: 3, bonus_per_seat: '576' });
    const tx = outcome('RefundTx', [
      { executorId: POOLS },
      {
        executorId: 'mimic.testnet',
        logs: [
          eventLog({ event: 'seat_refunded', data: { pool_id: 7, buyer: BOB, seats: 9, amount: '5508', bonus_share: '3888' } }),
          eventLog({ event: 'pool_refunded', data: { pool_id: 7, dust: '1' } }),
        ],
      },
      {
        executorId: POOLS,
        events: [{ event: 'seat_refunded', data: { pool_id: 7, buyer: ALICE, seats: 3, amount: '2268', bonus_share: '1728' } }],
      },
    ]);
    expect(keeperRecords('refund', pool, tx, POOLS, AT)).toEqual([
      { at: AT, poolId: 7, kind: 'refund', account: ALICE, seats: 3, amount: '2268', txHash: 'RefundTx', ok: true },
    ]);
  });

  it("ignores the pools contract's events about another pool", () => {
    const pool = poolView({ status: 'filled', taken: 192 });
    const tx = outcome('SettleTx', [
      { executorId: POOLS, events: [{ event: 'pool_settled', data: { pool_id: 8, seller: PROVIDER, amount: '100' } }] },
    ]);
    expect(keeperRecords('settle', pool, tx, POOLS, AT)).toEqual([
      { at: AT, poolId: 7, kind: 'settle', account: PROVIDER, seats: 0, amount: '0', txHash: 'SettleTx', ok: false },
    ]);
  });

  it('ignores events that do not belong to the kind of call', () => {
    const pool = poolView({ status: 'filled', taken: 192 });
    const tx = outcome('SettleTx', [
      { executorId: POOLS, events: [{ event: 'pool_refunded', data: { pool_id: 7, dust: '5' } }] },
    ]);
    expect(keeperRecords('settle', pool, tx, POOLS, AT)).toEqual([
      { at: AT, poolId: 7, kind: 'settle', account: PROVIDER, seats: 0, amount: '0', txHash: 'SettleTx', ok: false },
    ]);
  });
});

describe('keeperCallProgressed', () => {
  const FILLED: Partial<PoolView> = { status: 'filled', taken: 192 };
  /** Buyers left to visit: the call advances the cursor. */
  const BUYERS_LEFT: Partial<PoolView> = { status: 'expired', buyer_count: 10, refund_cursor: 3 };
  /** Every buyer visited and the dust not sent: the call only retries the dust. */
  const DUST_ONLY: Partial<PoolView> = { status: 'expired', buyer_count: 10, refund_cursor: 10, dust_sent: false };
  const settledEvent = (poolId: number): QuorumEvent => ({
    event: 'pool_settled',
    data: { pool_id: poolId, seller: PROVIDER, amount: '36288' },
  });
  const refundedEvent = (poolId: number): QuorumEvent => ({ event: 'pool_refunded', data: { pool_id: poolId, dust: '3' } });

  type Case = [string, 'settle' | 'refund', Partial<PoolView>, ReceiptSpec[]];

  it.each<Case>([
    ['a settle call that logged pool_settled', 'settle', FILLED, [{ executorId: POOLS }, { executorId: TOKEN }, { executorId: POOLS, events: [settledEvent(7)] }]],
    ['a refund batch over buyers who had all claimed their own refunds, which logged nothing', 'refund', BUYERS_LEFT, [{ executorId: POOLS }]],
    ['a dust retry that logged pool_refunded', 'refund', DUST_ONLY, [{ executorId: POOLS }, { executorId: TOKEN }, { executorId: POOLS, events: [refundedEvent(7)] }]],
  ])('counts %s as progress', (_label, kind, pool, receipts) => {
    expect(keeperCallProgressed(kind, poolView(pool), outcome('KeeperTx', receipts), POOLS)).toBe(true);
  });

  it.each<Case>([
    ['a settle call whose payout failed', 'settle', FILLED, [{ executorId: POOLS }, { executorId: TOKEN, failed: true }, { executorId: POOLS }]],
    ["a settle call that logged another pool's pool_settled", 'settle', FILLED, [{ executorId: POOLS, events: [settledEvent(8)] }]],
    ['a refund call with buyers left whose receipt failed', 'refund', BUYERS_LEFT, [{ executorId: POOLS, failed: true }]],
    ['a refund call that never reached the pools contract', 'refund', BUYERS_LEFT, []],
    ['a dust retry whose transfer failed', 'refund', DUST_ONLY, [{ executorId: POOLS }, { executorId: TOKEN, failed: true }, { executorId: POOLS }]],
    ["a dust retry that logged another pool's pool_refunded", 'refund', DUST_ONLY, [{ executorId: POOLS, events: [refundedEvent(8)] }]],
  ])('does not count %s as progress', (_label, kind, pool, receipts) => {
    expect(keeperCallProgressed(kind, poolView(pool), outcome('KeeperTx', receipts), POOLS)).toBe(false);
  });
});
