import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PoolView } from '@quorum-on-near/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActivityLog } from '../src/activity.ts';
import type { RelayResult } from '../src/chain.ts';
import { Keeper } from '../src/keeper.ts';
import { FakeChain, NOW_MS, POOLS, PROVIDER, TOKEN, outcome, poolView } from './fake-chain.ts';

const SETTLE_GAS = 100_000_000_000_000n;
const REFUND_GAS = 300_000_000_000_000n;
const REFUND_LIMIT = 7;
const ALICE = 'alice.testnet';
const BOB = 'bob.testnet';

function settled(poolId: number, txHash = 'SettleTx'): RelayResult {
  return {
    kind: 'executed',
    outcome: outcome(txHash, [
      { executorId: POOLS },
      { executorId: TOKEN },
      { executorId: POOLS, events: [{ event: 'pool_settled', data: { pool_id: poolId, seller: PROVIDER, amount: '36288' } }] },
    ]),
  };
}

/** An executed call whose receipt at the pools contract failed: it made no progress. */
function failed(txHash = 'FailedTx'): RelayResult {
  return { kind: 'executed', outcome: outcome(txHash, [{ executorId: POOLS, failed: true }]) };
}

/** An executed refund call that refunded one buyer and failed to refund another. */
function partlyRefunded(poolId: number): RelayResult {
  return {
    kind: 'executed',
    outcome: outcome('PartialRefundTx', [
      {
        executorId: POOLS,
        events: [
          { event: 'seat_refunded', data: { pool_id: poolId, buyer: ALICE, seats: 2, amount: '360', bonus_share: '0' } },
          { event: 'refund_failed', data: { pool_id: poolId, buyer: BOB, amount: '180' } },
        ],
      },
    ]),
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

let dir: string;
let fake: FakeChain;
let activity: ActivityLog;
let messages: string[];
/** The keeper's clock, which tests move by hand. */
let clock: number;
let keeper: Keeper;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'quorum-keeper-'));
  fake = new FakeChain();
  activity = await ActivityLog.open(join(dir, 'activity.jsonl'));
  messages = [];
  clock = NOW_MS;
  keeper = new Keeper({
    chain: fake,
    writer: fake,
    activity,
    provider: PROVIDER,
    poolsContract: POOLS,
    refundLimit: REFUND_LIMIT,
    settleGas: SETTLE_GAS,
    refundGas: REFUND_GAS,
    now: () => clock,
    log: (message) => messages.push(message),
  });
});

/**
 * Asserts that the keeper waits exactly `waitMs` from the clock's current time before calling the
 * pool again: a tick 1 ms earlier makes no call, a tick at `waitMs` makes one.
 */
async function expectWait(waitMs: number): Promise<void> {
  const from = clock;
  const calls = fake.calls.length;
  clock = from + waitMs - 1;
  await keeper.tick();
  expect(fake.calls).toHaveLength(calls);
  clock = from + waitMs;
  await keeper.tick();
  expect(fake.calls).toHaveLength(calls + 1);
}

/** Moves the clock past the longest wait, then ticks. */
async function tickAfterLongestWait(): Promise<void> {
  clock += 600_000;
  await keeper.tick();
}

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('Keeper.tick', () => {
  it('calls settle with the pool id and the configured gas for a served filled pool', async () => {
    fake.setPool(poolView({ status: 'filled', taken: 192 }));
    await keeper.tick();
    expect(fake.calls).toEqual([{ method: 'settle', args: { pool_id: 7 }, gas: SETTLE_GAS }]);
  });

  it('calls refund with the pool id, the refund limit and the configured gas for a served expired pool', async () => {
    fake.setPool(poolView({ status: 'expired', bonus_per_seat: '9', refund_cursor: 3 }));
    await keeper.tick();
    expect(fake.calls).toEqual([{ method: 'refund', args: { pool_id: 7, limit: REFUND_LIMIT }, gas: REFUND_GAS }]);
  });

  it('skips an expired pool whose dust transfer is in flight', async () => {
    fake.setPool(poolView({ status: 'expired', buyer_count: 10, refund_cursor: 10, dust_sent: true }));
    await keeper.tick();
    expect(fake.calls).toEqual([]);
  });

  it('calls refund for an expired pool whose buyers are all processed but whose dust is not sent', async () => {
    fake.setPool(poolView({ status: 'expired', buyer_count: 10, refund_cursor: 10, dust_sent: false }));
    await keeper.tick();
    expect(fake.calls.map((c) => c.method)).toEqual(['refund']);
  });

  it.each(['open', 'settled', 'refunded'] as const)('makes no call for a served %s pool', async (status) => {
    fake.setPool(poolView({ status }));
    await keeper.tick();
    expect(fake.calls).toEqual([]);
  });

  it("ignores another seller's pools", async () => {
    fake.setPool(poolView({ id: 0, seller: 'other.testnet', status: 'filled' }));
    fake.setPool(poolView({ id: 1, seller: 'other.testnet', status: 'expired' }));
    await keeper.tick();
    expect(fake.calls).toEqual([]);
  });

  it('calls the pools one at a time, in id order', async () => {
    for (const id of [2, 0, 1]) fake.setPool(poolView({ id, status: 'filled' }));
    let active = 0;
    let maxActive = 0;
    fake.onCall = async (_method, args) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setImmediate(resolve));
      active -= 1;
      return settled(args.pool_id as number);
    };
    await keeper.tick();
    expect(fake.calls.map((c) => c.args.pool_id)).toEqual([0, 1, 2]);
    expect(maxActive).toBe(1);
  });

  it('appends the records of an executed settle call to the activity feed', async () => {
    fake.setPool(poolView({ status: 'filled', taken: 192 }));
    fake.callResults.push(settled(7));
    await keeper.tick();
    expect(activity.list()).toEqual([
      { at: NOW_MS, poolId: 7, kind: 'settle', account: PROVIDER, seats: 192, amount: '36288', txHash: 'SettleTx', ok: true },
    ]);
  });

  it('appends the refund and dust records of an executed refund call to the activity feed', async () => {
    fake.setPool(poolView({ status: 'expired', taken: 5, bonus_per_seat: '345' }));
    fake.callResults.push({
      kind: 'executed',
      outcome: outcome('RefundTx', [
        { executorId: POOLS },
        { executorId: TOKEN },
        {
          executorId: POOLS,
          events: [{ event: 'seat_refunded', data: { pool_id: 7, buyer: ALICE, seats: 5, amount: '2625', bonus_share: '1725' } }],
        },
        { executorId: POOLS, events: [{ event: 'pool_refunded', data: { pool_id: 7, dust: '3' } }] },
      ]),
    });
    await keeper.tick();
    expect(activity.list()).toEqual([
      { at: NOW_MS, poolId: 7, kind: 'refund', account: ALICE, seats: 5, amount: '2625', txHash: 'RefundTx', ok: true },
      { at: NOW_MS, poolId: 7, kind: 'dust', account: PROVIDER, seats: 0, amount: '3', txHash: 'RefundTx', ok: true },
    ]);
  });

  it('logs a rejected call and appends nothing', async () => {
    fake.setPool(poolView({ status: 'filled' }));
    fake.callResults.push({ kind: 'rejected', txHash: 'RejectedTx', error: 'invalid nonce' });
    await keeper.tick();
    expect(activity.list()).toEqual([]);
    expect(messages).toEqual([expect.stringMatching(/settle.*pool 7.*RejectedTx.*invalid nonce/)]);
  });

  it('logs a call whose result is unknown and appends nothing', async () => {
    fake.setPool(poolView({ status: 'expired' }));
    fake.callResults.push({ kind: 'unknown', txHash: 'UnknownTx', expired: false });
    await keeper.tick();
    expect(activity.list()).toEqual([]);
    expect(messages).toEqual([expect.stringMatching(/refund.*pool 7.*UnknownTx/)]);
  });

  it('keeps calling the other pools when the call for one pool throws', async () => {
    fake.setPool(poolView({ id: 0, status: 'filled' }));
    fake.setPool(poolView({ id: 1, status: 'filled', taken: 192 }));
    fake.onCall = (_method, args) => {
      if (args.pool_id === 0) throw new Error('connection reset');
      return settled(1);
    };
    await keeper.tick();
    expect(fake.calls.map((c) => c.args.pool_id)).toEqual([0, 1]);
    expect(activity.list().map((r) => r.poolId)).toEqual([1]);
    expect(messages).toEqual([expect.stringMatching(/settle.*pool 0.*connection reset/)]);
  });

  it('resolves without throwing when listing the pools fails, and logs why', async () => {
    vi.spyOn(fake, 'listPools').mockRejectedValue(new Error('rpc unreachable'));
    await expect(keeper.tick()).resolves.toBeUndefined();
    expect(fake.calls).toEqual([]);
    expect(messages).toEqual([expect.stringContaining('rpc unreachable')]);
  });

  it('logs an append that fails', async () => {
    fake.setPool(poolView({ status: 'filled', taken: 192 }));
    fake.callResults.push(settled(7));
    vi.spyOn(activity, 'append').mockRejectedValueOnce(new Error('disk full'));
    await keeper.tick();
    expect(messages).toEqual([expect.stringMatching(/settle record.*pool 7.*disk full/)]);
  });

  it("appends the call's other records after an append fails", async () => {
    fake.setPool(poolView({ status: 'expired' }));
    fake.callResults.push(partlyRefunded(7));
    vi.spyOn(activity, 'append').mockRejectedValueOnce(new Error('disk full'));
    await keeper.tick();
    expect(activity.list()).toEqual([
      { at: NOW_MS, poolId: 7, kind: 'refund', account: BOB, seats: 0, amount: '180', txHash: 'PartialRefundTx', ok: false },
    ]);
  });

  it('keeps calling the other pools after an append fails', async () => {
    fake.setPool(poolView({ id: 0, status: 'filled', taken: 192 }));
    fake.setPool(poolView({ id: 1, status: 'filled', taken: 192 }));
    fake.onCall = (_method, args) => settled(args.pool_id as number);
    vi.spyOn(activity, 'append').mockRejectedValueOnce(new Error('disk full'));
    await keeper.tick();
    expect(fake.calls.map((c) => c.args.pool_id)).toEqual([0, 1]);
    expect(activity.list().map((r) => r.poolId)).toEqual([1]);
  });

  it('does not back off from a successful call whose append fails', async () => {
    fake.setPool(poolView({ status: 'filled', taken: 192 }));
    fake.onCall = () => settled(7);
    vi.spyOn(activity, 'append').mockRejectedValueOnce(new Error('disk full'));
    await keeper.tick();
    await keeper.tick();
    expect(fake.calls).toHaveLength(2);
  });
});

describe('Keeper backoff', () => {
  it('skips a filled pool whose settle call failed at the pools contract until 30 s have passed', async () => {
    fake.setPool(poolView({ status: 'filled' }));
    fake.onCall = () => failed();
    await keeper.tick();
    await expectWait(30_000);
  });

  it('doubles the wait after each further failure in a row, up to 10 minutes', async () => {
    fake.setPool(poolView({ status: 'filled' }));
    fake.onCall = () => failed();
    await keeper.tick();
    for (const waitMs of [30_000, 60_000, 120_000, 240_000, 480_000, 600_000, 600_000]) await expectWait(waitMs);
  });

  it.each<[string, RelayResult]>([
    ['was rejected', { kind: 'rejected', txHash: 'RejectedTx', error: 'invalid nonce' }],
    ['has an unknown result', { kind: 'unknown', txHash: 'UnknownTx', expired: false }],
    ['failed at the pools contract', failed()],
  ])('skips an expired pool whose refund call %s until 30 s have passed', async (_name, result) => {
    fake.setPool(poolView({ status: 'expired' }));
    fake.onCall = () => result;
    await keeper.tick();
    await expectWait(30_000);
  });

  it('does not back off from a refund batch that only passed buyers who had claimed their own refunds, and appends nothing', async () => {
    fake.setPool(poolView({ status: 'expired', buyer_count: 10, refund_cursor: 0 }));
    fake.onCall = () => ({ kind: 'executed', outcome: outcome('SkippedTx', [{ executorId: POOLS }]) });
    await keeper.tick();
    await keeper.tick();
    expect(fake.calls).toHaveLength(2);
    expect(activity.list()).toEqual([]);
    expect(messages).toEqual([]);
  });

  it('does not back off from a refund batch whose every push failed, and appends their failed records', async () => {
    fake.setPool(poolView({ status: 'expired', buyer_count: 10, refund_cursor: 0 }));
    fake.onCall = () => ({
      kind: 'executed',
      outcome: outcome('PushesFailedTx', [
        { executorId: POOLS },
        { executorId: TOKEN, failed: true },
        { executorId: POOLS, events: [{ event: 'refund_failed', data: { pool_id: 7, buyer: ALICE, amount: '360' } }] },
      ]),
    });
    await keeper.tick();
    await keeper.tick();
    expect(fake.calls).toHaveLength(2);
    expect(activity.list()).toEqual(
      Array(2).fill({ at: NOW_MS, poolId: 7, kind: 'refund', account: ALICE, seats: 0, amount: '360', txHash: 'PushesFailedTx', ok: false }),
    );
  });

  it('backs off from a refund call that only retried the dust, whose transfer failed', async () => {
    fake.setPool(poolView({ status: 'expired', buyer_count: 10, refund_cursor: 10, dust_sent: false }));
    fake.onCall = () => ({
      kind: 'executed',
      outcome: outcome('DustTx', [{ executorId: POOLS }, { executorId: TOKEN, failed: true }, { executorId: POOLS }]),
    });
    await keeper.tick();
    await expectWait(30_000);
    expect(activity.list()).toEqual([
      { at: NOW_MS, poolId: 7, kind: 'refund', account: PROVIDER, seats: 0, amount: '0', txHash: 'DustTx', ok: false },
    ]);
    expect(messages[0]).toMatch(/refund on pool 7 made no progress \(transaction DustTx\); next try in 30 s/);
  });

  it('starts again from 30 s after a call that made progress', async () => {
    fake.setPool(poolView({ status: 'filled', taken: 192 }));
    fake.callResults.push(failed(), failed(), settled(7));
    fake.onCall = () => failed();
    await keeper.tick();
    await expectWait(30_000);
    await expectWait(60_000);
    await keeper.tick();
    expect(fake.calls).toHaveLength(4);
    await expectWait(30_000);
  });

  it('counts a refund batch that refunded one buyer and failed to refund another as progress', async () => {
    fake.setPool(poolView({ status: 'expired' }));
    fake.onCall = (_method, args) => partlyRefunded(args.pool_id as number);
    await keeper.tick();
    await keeper.tick();
    expect(fake.calls).toHaveLength(2);
  });

  it('calls a pool again on the next tick after its call threw', async () => {
    fake.setPool(poolView({ status: 'filled' }));
    fake.onCall = () => {
      throw new Error('connection reset');
    };
    await keeper.tick();
    await keeper.tick();
    expect(fake.calls).toHaveLength(2);
  });

  it('appends only the first failure of a run to the feed', async () => {
    fake.setPool(poolView({ status: 'filled' }));
    fake.callResults.push(failed('FailedTx1'), failed('FailedTx2'), failed('FailedTx3'));
    await keeper.tick();
    await tickAfterLongestWait();
    await tickAfterLongestWait();
    expect(activity.list()).toEqual([
      { at: NOW_MS, poolId: 7, kind: 'settle', account: PROVIDER, seats: 0, amount: '0', txHash: 'FailedTx1', ok: false },
    ]);
  });

  it('logs every failure of a run with the wait before the next call', async () => {
    fake.setPool(poolView({ status: 'filled' }));
    fake.callResults.push(failed('FailedTx1'), failed('FailedTx2'), failed('FailedTx3'));
    await keeper.tick();
    await tickAfterLongestWait();
    await tickAfterLongestWait();
    expect(messages).toEqual([
      expect.stringMatching(/settle on pool 7.*FailedTx1.*next try in 30 s/),
      expect.stringMatching(/settle on pool 7.*FailedTx2.*next try in 60 s/),
      expect.stringMatching(/settle on pool 7.*FailedTx3.*next try in 120 s/),
    ]);
  });

  it('appends the first failure of a new run after a success', async () => {
    fake.setPool(poolView({ status: 'filled', taken: 192 }));
    fake.callResults.push(failed('FailedTx1'), failed('FailedTx2'), settled(7), failed('FailedTx3'));
    await keeper.tick();
    await tickAfterLongestWait();
    await tickAfterLongestWait();
    await keeper.tick();
    expect(activity.list().map((r) => [r.txHash, r.ok])).toEqual([
      ['FailedTx1', false],
      ['SettleTx', true],
      ['FailedTx3', false],
    ]);
  });

  it('keeps calling the other pools while one pool waits', async () => {
    fake.setPool(poolView({ id: 0, status: 'filled' }));
    fake.setPool(poolView({ id: 1, status: 'filled', taken: 192 }));
    fake.onCall = (_method, args) => (args.pool_id === 0 ? failed() : settled(1));
    await keeper.tick();
    clock += 1_000;
    await keeper.tick();
    expect(fake.calls.map((c) => c.args.pool_id)).toEqual([0, 1, 1]);
  });

  it("does not count one pool's failures against another", async () => {
    fake.setPool(poolView({ id: 0, status: 'filled' }));
    fake.onCall = () => failed();
    await keeper.tick();
    await tickAfterLongestWait();
    fake.setPool(poolView({ id: 1, status: 'filled' }));
    await tickAfterLongestWait();
    expect(messages.at(-1)).toMatch(/settle on pool 1.*next try in 30 s/);
  });

  it('forgets the failures of a pool once it needs no call', async () => {
    fake.setPool(poolView({ status: 'expired' }));
    fake.onCall = () => failed();
    await keeper.tick();
    fake.setPool(poolView({ status: 'expired', refund_cursor: 10, dust_sent: true }));
    clock += 1_000;
    await keeper.tick();
    fake.setPool(poolView({ status: 'expired', refund_cursor: 10, dust_sent: false }));
    clock += 1_000;
    await keeper.tick();
    expect(fake.calls).toHaveLength(2);
  });
});

describe('Keeper.start and Keeper.stop', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    await keeper.stop();
    vi.useRealTimers();
  });

  it('runs the first tick one interval after start, and each next tick one interval after the last', async () => {
    const list = vi.spyOn(fake, 'listPools');
    keeper.start(1000);
    await vi.advanceTimersByTimeAsync(999);
    expect(list).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(list).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('does not start a tick while the previous one is still running', async () => {
    const gate = deferred<PoolView[]>();
    const list = vi.spyOn(fake, 'listPools').mockReturnValueOnce(gate.promise);
    keeper.start(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(list).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(list).toHaveBeenCalledTimes(1);
    gate.resolve([]);
    await vi.advanceTimersByTimeAsync(999);
    expect(list).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('stop resolves only once the running tick has finished', async () => {
    const gate = deferred<PoolView[]>();
    vi.spyOn(fake, 'listPools').mockReturnValueOnce(gate.promise);
    keeper.start(1000);
    await vi.advanceTimersByTimeAsync(1000);
    let stopped = false;
    const stopping = keeper.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);
    gate.resolve([]);
    await stopping;
    expect(stopped).toBe(true);
  });

  it('schedules no tick after a stop made during a tick', async () => {
    const gate = deferred<PoolView[]>();
    const list = vi.spyOn(fake, 'listPools').mockReturnValueOnce(gate.promise);
    keeper.start(1000);
    await vi.advanceTimersByTimeAsync(1000);
    const stopping = keeper.stop();
    gate.resolve([]);
    await stopping;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('schedules no tick after a stop made between ticks', async () => {
    const list = vi.spyOn(fake, 'listPools');
    keeper.start(1000);
    await vi.advanceTimersByTimeAsync(1500);
    await keeper.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('runs again after a stop when started again', async () => {
    const list = vi.spyOn(fake, 'listPools');
    keeper.start(1000);
    await keeper.stop();
    keeper.start(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('refuses to start when already started', () => {
    keeper.start(1000);
    expect(() => keeper.start(1000)).toThrow('already started');
  });
});
