import { readFile } from 'node:fs/promises';
import type { ActivityRecord } from '@quorum-on-near/buyer';
import { toTxOutcome, type PoolView, type SeatView } from '@quorum-on-near/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import { buyerIds } from '../src/accounts.ts';
import { TGAS } from '../src/chain.ts';
import {
  checkPool,
  commitGas,
  payoutGas,
  snapshot,
  UnknownPoolError,
  type Baseline,
  type CheckDeps,
  type CheckReport,
} from '../src/check.ts';
import type { SwarmConfig } from '../src/config.ts';
import { scenario } from '../src/scenarios.ts';
import { COMMIT_STEP_GAS, FIXTURE_COMMIT_GAS, hashOf, keeperCall, relayedCommit } from './check-outcomes.ts';
import { eventLog, FakeChain, NOW_MS, PARENT, POOLS, poolView, PROVIDER, testConfig, TOKEN } from './fake-chain.ts';

const RELAYER = `relay.${PARENT}`;
const FILLS = scenario('fills', { deadlineSeconds: null, spreadSeconds: null });
const FAILS = scenario('fails', { deadlineSeconds: null, spreadSeconds: null });
const FIXTURE = new URL('../../gateway/test/fixtures/relayed-commit.json', import.meta.url);

/** The gas a payout's `ft_transfer` and its callback burn in these tests, shown as 1.72 and 1.49 Tgas. */
const TRANSFER_GAS = 1_723_456_789_012n;
const CALLBACK_GAS = 1_498_765_432_109n;
const PAYOUT = { transfer: TRANSFER_GAS, callback: CALLBACK_GAS };
/** What a `settle` or `refund` call burns at the pools contract itself: more than 5 Tgas, and not a payout. */
const CALL_GAS = 9_512_345_678_901n;

function buyer(n: number): string {
  return `buyer-${String(n).padStart(2, '0')}.${PARENT}`;
}

let chain: FakeChain;
let feed: ActivityRecord[];
/** The check's clock, which the fake sleep moves on. */
let clock: number;
let slept: number[];
/** Runs after each sleep, before the check polls again: lets a test change the chain or the feed. */
let afterSleep: (sleeps: number) => void;
let logs: string[];

beforeEach(() => {
  chain = new FakeChain();
  feed = [];
  clock = 50_000;
  slept = [];
  afterSleep = () => {};
  logs = [];
});

/** What the check reads and how it waits: the fake chain, the feed, and a clock that only the sleeps move on. */
function deps(): CheckDeps {
  return {
    chain,
    gateway: { activity: async (poolId) => feed.filter((record) => record.poolId === poolId) },
    now: () => clock,
    sleep: async (ms) => {
      slept.push(ms);
      clock += ms;
      afterSleep(slept.length);
    },
    log: (line) => logs.push(line),
  };
}

function run(
  check: { poolId: number; scenario?: typeof FILLS; baseline?: Baseline },
  config: SwarmConfig = testConfig(),
): Promise<CheckReport> {
  return checkPool(config, deps(), { poolId: check.poolId, scenario: check.scenario ?? FILLS, baseline: check.baseline });
}

function names(report: CheckReport): string[] {
  return report.lines.map((line) => line.name);
}

function lineOf(report: CheckReport, name: string): { ok: boolean; detail: string } {
  const line = report.lines.find((l) => l.name === name);
  if (line === undefined) throw new Error(`the report has no ${name} line`);
  return { ok: line.ok, detail: line.detail };
}

/** A relayed commit in the feed, whose outcome the relayer's transaction has. */
function commit(poolId: number, account: string, seats: number, seatPrice: number, gas?: Partial<typeof COMMIT_STEP_GAS>): string {
  const txHash = hashOf(`commit ${poolId} ${account}`);
  feed.push({ at: NOW_MS, poolId, kind: 'commit', account, seats, amount: BigInt(seats * seatPrice), txHash, ok: true });
  chain.addOutcome(RELAYER, relayedCommit({ txHash, relayer: RELAYER, buyer: account, token: TOKEN, pools: POOLS, gas }));
  return txHash;
}

/** A keeper transaction in the feed: its records, all with one hash, and its outcome with `payouts`. */
function keeperTx(
  poolId: number,
  records: Array<Pick<ActivityRecord, 'kind' | 'account' | 'seats' | 'amount'>>,
  payouts: Array<{ transfer: bigint; callback: bigint; failed?: boolean }>,
): string {
  const txHash = hashOf(`keeper ${poolId} ${feed.length}`);
  for (const record of records) feed.push({ at: NOW_MS, poolId, txHash, ok: true, ...record });
  chain.addOutcome(RELAYER, keeperCall({ txHash, relayer: RELAYER, token: TOKEN, pools: POOLS, callGas: CALL_GAS, payouts }));
  return txHash;
}

/**
 * Pool 0, a `fills` pool of 3 seats at 180 that buyer-01 (2 seats) and buyer-02 (1 seat) filled and
 * the keeper settled. Every account held 10,000 before it opened, the pools contract none.
 */
function settledFills(): Baseline {
  chain.setPool(poolView({ id: 0, target: 3, taken: 3, status: 'settled', buyer_count: 2 }));
  chain.seats.set(0, [
    { buyer: buyer(1), seats: 2, state: 'committed' },
    { buyer: buyer(2), seats: 1, state: 'committed' },
  ]);
  commit(0, buyer(1), 2, 180);
  commit(0, buyer(2), 1, 180);
  keeperTx(0, [{ kind: 'settle', account: PROVIDER, seats: 3, amount: 2268n }], [PAYOUT]);
  // The provider sent the 1,728 bonus and got back 3 × 180 + 1,728.
  chain.register(PROVIDER, 10_540n);
  chain.register(POOLS, 0n);
  chain.register(buyer(1), 9_640n);
  chain.register(buyer(2), 9_820n);
  return new Map([
    [PROVIDER, 10_000n],
    [POOLS, 0n],
    [buyer(1), 10_000n],
    [buyer(2), 10_000n],
  ]);
}

const FAILS_SEATS = [24, 20, 18, 16, 12, 10];

/**
 * Pool 1, a `fails` pool at 320 a seat with a 3,072 bonus, which expired with 100 seats taken by
 * buyer-01 to buyer-06 and was refunded in one keeper transaction: each seat gets back 320 and a
 * bonus share of 30, and the dust of 72 goes back to the provider. Every account held 10,000 before
 * it opened, the pools contract none.
 */
function refundedFails(overrides: Partial<PoolView> = {}): Baseline {
  chain.setPool(
    poolView({
      id: 1,
      seat_price: '320',
      bonus: '3072',
      deadline_ms: NOW_MS - 60_000,
      taken: 100,
      status: 'refunded',
      bonus_per_seat: '30',
      refund_cursor: 6,
      dust_sent: true,
      buyer_count: 6,
      ...overrides,
    }),
  );
  chain.seats.set(
    1,
    FAILS_SEATS.map((seats, i) => ({ buyer: buyer(i + 1), seats, state: 'refunded' as const })),
  );
  FAILS_SEATS.forEach((seats, i) => commit(1, buyer(i + 1), seats, 320));
  keeperTx(
    1,
    [
      ...FAILS_SEATS.map((seats, i) => ({ kind: 'refund' as const, account: buyer(i + 1), seats, amount: BigInt(seats * 350) })),
      { kind: 'dust', account: PROVIDER, seats: 0, amount: 72n },
    ],
    Array.from({ length: 7 }, () => PAYOUT),
  );
  chain.register(PROVIDER, 7_000n);
  chain.register(POOLS, 0n);
  FAILS_SEATS.forEach((seats, i) => chain.register(buyer(i + 1), 10_000n + BigInt(seats * 30)));
  return new Map([[PROVIDER, 10_000n], [POOLS, 0n], ...FAILS_SEATS.map((_, i) => [buyer(i + 1), 10_000n] as const)]);
}

describe('commitGas', () => {
  it('sums the gas the token and the pools contract burn after the buyer’s delegate receipt, as in a captured relayed commit', async () => {
    const outcome = toTxOutcome(JSON.parse(await readFile(FIXTURE, 'utf8')));

    expect(commitGas(outcome, 'buyer1.sandbox', ['musd.sandbox', 'pools.sandbox'])).toBe(FIXTURE_COMMIT_GAS);
  });

  it('is null when no receipt ran on the buyer', () => {
    const outcome = relayedCommit({ txHash: hashOf('commit'), relayer: RELAYER, buyer: buyer(1), token: TOKEN, pools: POOLS });

    expect(commitGas(outcome, buyer(2), [TOKEN, POOLS])).toBeNull();
  });
});

describe('payoutGas', () => {
  it('lists each ft_transfer the token runs after the call and each later callback, leaving out the call itself and the gas refunds', () => {
    const outcome = keeperCall({
      txHash: hashOf('refund'),
      relayer: RELAYER,
      token: TOKEN,
      pools: POOLS,
      callGas: CALL_GAS,
      payouts: [
        { transfer: 1_700_000_000_000n, callback: 1_500_000_000_000n },
        { transfer: 1_710_000_000_000n, callback: 1_510_000_000_000n },
      ],
    });

    expect(payoutGas(outcome, POOLS, TOKEN)).toEqual({
      transfers: [1_700_000_000_000n, 1_710_000_000_000n],
      callbacks: [1_500_000_000_000n, 1_510_000_000_000n],
    });
  });
});

describe('snapshot', () => {
  it('reads the token balance of the provider, the pools contract and each of the 21 buyers', async () => {
    const config = testConfig();
    chain.register(PROVIDER, 10_540n);
    chain.register(POOLS, 7n);
    buyerIds(config).forEach((id, i) => chain.register(id, BigInt(i)));

    const baseline = await snapshot(config, chain);

    expect([...baseline]).toEqual([
      [PROVIDER, 10_540n],
      [POOLS, 7n],
      ...buyerIds(config).map((id, i) => [id, BigInt(i)]),
    ]);
    expect(baseline.size).toBe(23);
  });
});

describe('checkPool', () => {
  it('passes a settled fills pool, printing each check with its figures', async () => {
    const baseline = settledFills();

    const report = await run({ poolId: 0, baseline });

    expect(report).toMatchObject({ poolId: 0, status: 'settled', failed: false });
    expect(logs).toEqual([
      'ok    status: settled, as fills expects',
      'ok    buyers: 2 buyers, all committed',
      'ok    solvency: the pools contract holds 0 and owes 0 across 1 pool',
      `ok    provider balance: ${PROVIDER} changed by +540, as expected`,
      `ok    pools contract balance: ${POOLS} changed by 0, as expected`,
      'ok    buyer balances: 2 buyers changed as expected',
      'ok    commit gas: 2 commits, at most 5.70 Tgas each (limit 50.00 Tgas)',
      'ok    payout gas: 1 transaction, 1 ft_transfer at most 1.72 Tgas, 1 callback at most 1.49 Tgas (each under 5.00 Tgas)',
    ]);
    expect(report.lines.map((line) => line.ok)).toEqual(Array(8).fill(true));
  });

  it('passes a refunded fails pool, checking that its refunds and dust add up', async () => {
    const baseline = refundedFails();

    const report = await run({ poolId: 1, scenario: FAILS, baseline });

    expect(report.failed).toBe(false);
    expect(logs).toEqual([
      'ok    status: refunded, as fails expects',
      'ok    buyers: 6 buyers, all refunded',
      'ok    refunds and dust: refunds 35000 + dust 72 = 100 × 320 + bonus 3072 = 35072',
      'ok    solvency: the pools contract holds 0 and owes 0 across 1 pool',
      `ok    provider balance: ${PROVIDER} changed by -3000, as expected`,
      `ok    pools contract balance: ${POOLS} changed by 0, as expected`,
      'ok    buyer balances: 6 buyers changed as expected',
      'ok    commit gas: 6 commits, at most 5.70 Tgas each (limit 50.00 Tgas)',
      'ok    payout gas: 1 transaction, 7 ft_transfers at most 1.72 Tgas, 7 callbacks at most 1.49 Tgas (each under 5.00 Tgas)',
    ]);
  });

  it('takes extra commits for the request, looking up only those the feed lacks', async () => {
    settledFills();
    const [first] = feed;
    const lookups: string[] = [];
    const txOutcome = chain.txOutcome.bind(chain);
    chain.txOutcome = async (txHash, signerId) => {
      lookups.push(txHash);
      return txOutcome(txHash, signerId);
    };
    const extraCommits = [{ account: buyer(1), txHash: first!.txHash }, { account: buyer(1), txHash: hashOf('never relayed') }];

    const report = await checkPool(testConfig(), deps(), { poolId: 0, scenario: FILLS, extraCommits });

    expect(report.failed).toBe(false);
    expect(lookups.filter((hash) => hash === first!.txHash)).toHaveLength(1);
    expect(lookups).toContain(hashOf('never relayed'));
  });

  it('throws UnknownPoolError for a pool the contract does not know', async () => {
    await expect(run({ poolId: 9 })).rejects.toBeInstanceOf(UnknownPoolError);
  });

  describe('status', () => {
    it('fails when the pool ended in the other status than the scenario’s', async () => {
      refundedFails();

      const report = await run({ poolId: 1, scenario: FILLS });

      expect(report.failed).toBe(true);
      expect(lineOf(report, 'status')).toEqual({ ok: false, detail: 'refunded; fills ends settled' });
      expect(logs[0]).toBe('FAIL  status: refunded; fills ends settled');
    });
  });

  describe('waiting for the pool to end', () => {
    it('polls every 2 s until the pool has ended and the feed holds the transaction that ended it', async () => {
      settledFills();
      const settled = chain.pools.get(0)!;
      chain.setPool({ ...settled, status: 'filled' });
      const settleRecords = feed.filter((record) => record.kind === 'settle');
      feed = feed.filter((record) => record.kind !== 'settle');
      afterSleep = (sleeps) => {
        if (sleeps === 2) chain.setPool(settled);
        if (sleeps === 4) feed.push(...settleRecords);
      };

      const report = await run({ poolId: 0 });

      expect(slept).toEqual([2_000, 2_000, 2_000, 2_000]);
      expect(lineOf(report, 'status').ok).toBe(true);
      expect(lineOf(report, 'payout gas').ok).toBe(true);
    });

    it('gives up 5 minutes after the pool’s deadline in block time, measured on its own clock', async () => {
      // The deadline is 10 minutes after the final block, whatever the local clock says.
      chain.setPool(poolView({ id: 0, deadline_ms: NOW_MS + 600_000 }));

      const report = await run({ poolId: 0, baseline: new Map([[PROVIDER, 10_000n]]) });

      expect(slept.reduce((sum, ms) => sum + ms, 0)).toBe(900_000);
      expect(lineOf(report, 'status')).toEqual({ ok: false, detail: 'open after waiting 900 s; fills ends settled' });
      expect(names(report)).toEqual(['status', 'solvency', 'commit gas', 'payout gas']);
      expect(report.failed).toBe(true);
    });

    it('waits only the 5 minutes of grace for a pool already past its deadline', async () => {
      chain.setPool(poolView({ id: 0, deadline_ms: NOW_MS - 60_000, status: 'expired' }));

      await run({ poolId: 0 });

      expect(slept.reduce((sum, ms) => sum + ms, 0)).toBe(300_000);
    });

    it('waits for the dust record of a refunded pool, not only for its refund records', async () => {
      refundedFails();
      const dust = feed.filter((record) => record.kind === 'dust');
      feed = feed.filter((record) => record.kind !== 'dust');
      afterSleep = (sleeps) => {
        if (sleeps === 3) feed.push(...dust);
      };

      const report = await run({ poolId: 1, scenario: FAILS });

      expect(slept).toEqual([2_000, 2_000, 2_000]);
      expect(report.failed).toBe(false);
    });

    it('fails the payout gas check when the feed never holds the transaction that ended the pool', async () => {
      settledFills();
      feed = feed.filter((record) => record.kind !== 'settle');

      const report = await run({ poolId: 0 });

      expect(lineOf(report, 'status').ok).toBe(true);
      expect(lineOf(report, 'payout gas')).toEqual({ ok: false, detail: 'no keeper transactions: the activity feed has no settle record' });
      expect(slept.reduce((sum, ms) => sum + ms, 0)).toBe(900_000);
    });

    it('takes a failed settle record for no proof that the pool was settled', async () => {
      settledFills();
      for (const record of feed) if (record.kind === 'settle') record.ok = false;

      const report = await run({ poolId: 0 });

      expect(lineOf(report, 'payout gas').ok).toBe(false);
      expect(slept.length).toBeGreaterThan(0);
    });
  });

  describe('reads that fail', () => {
    /** Makes `method` of the fake chain throw `error` on the calls for which `when` is true (counted from 1). */
    function failing<K extends 'getPool' | 'finalBlock' | 'txOutcome' | 'getSeats' | 'ftBalanceOf'>(
      method: K,
      when: (call: number) => boolean,
      error: () => Error = () => new Error('Bad Gateway', { cause: 502 }),
    ): void {
      const original = (chain[method] as (...args: unknown[]) => Promise<unknown>).bind(chain);
      let calls = 0;
      (chain as unknown as Record<string, unknown>)[method] = async (...args: unknown[]) => {
        calls += 1;
        if (when(calls)) throw error();
        return original(...args);
      };
    }

    it('reads the feed again at the next poll after it failed, logging the failure once, and every check passes', async () => {
      settledFills();
      const settled = chain.pools.get(0)!;
      chain.setPool({ ...settled, status: 'filled' });
      afterSleep = (sleeps) => {
        if (sleeps === 3) chain.setPool(settled);
      };
      let calls = 0;
      const activity = async (poolId: number) => {
        calls += 1;
        if (calls === 2 || calls === 3) throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect'), { code: 'ECONNRESET' }) });
        return feed.filter((record) => record.poolId === poolId);
      };

      const report = await checkPool(testConfig(), { ...deps(), gateway: { activity } }, { poolId: 0, scenario: FILLS });

      expect(report.failed).toBe(false);
      expect(names(report)).not.toContain('reads');
      expect(logs.filter((line) => line.startsWith('could not read'))).toEqual([
        'could not read the activity feed (ECONNRESET): reads it again in 2 s',
      ]);
    });

    it('goes on with the last pool it read when the pool cannot be read again, and fails a reads check at the limit', async () => {
      chain.setPool(poolView({ id: 0, deadline_ms: NOW_MS - 60_000, status: 'expired' }));
      failing('getPool', (call) => call > 1);

      const report = await run({ poolId: 0, scenario: FAILS });

      expect(slept.reduce((sum, ms) => sum + ms, 0)).toBe(300_000);
      expect(report.failed).toBe(true);
      expect(lineOf(report, 'status')).toEqual({ ok: false, detail: 'expired after waiting 300 s; fails ends refunded' });
      expect(lineOf(report, 'reads')).toEqual({ ok: false, detail: 'the last read before the limit failed: could not read the pool (HTTP 502)' });
      expect(names(report)).toEqual(['status', 'reads', 'solvency', 'commit gas', 'payout gas']);
      expect(logs.filter((line) => line.startsWith('could not read'))).toHaveLength(1);
    });

    it('passes no reads check when a read failed but a later one before the limit did not', async () => {
      chain.setPool(poolView({ id: 0, deadline_ms: NOW_MS - 60_000, status: 'expired' }));
      failing('getPool', (call) => call === 2);

      const report = await run({ poolId: 0, scenario: FAILS });

      expect(names(report)).not.toContain('reads');
    });

    it('waits for a first read of the pool, then dates the limit from the pool it read', async () => {
      // The deadline is 10 minutes after the final block: once read, the check waits until 5 minutes after it.
      chain.setPool(poolView({ id: 0, deadline_ms: NOW_MS + 600_000 }));
      failing('getPool', (call) => call <= 2);

      const report = await run({ poolId: 0 });

      expect(slept.reduce((sum, ms) => sum + ms, 0)).toBe(4_000 + 900_000);
      expect(lineOf(report, 'status').ok).toBe(false);
      expect(names(report)).not.toContain('reads');
    });

    it('throws the last error when it never read the pool, 5 minutes after it started', async () => {
      chain.setPool(poolView({ id: 0 }));
      failing('getPool', () => true, () => new Error('the RPC is down'));

      await expect(run({ poolId: 0 })).rejects.toThrow('the RPC is down');
      expect(slept.reduce((sum, ms) => sum + ms, 0)).toBe(300_000);
    });

    it('throws UnknownPoolError at once, even after reading the pool before', async () => {
      chain.setPool(poolView({ id: 0 }));
      afterSleep = () => chain.pools.delete(0);

      await expect(run({ poolId: 0 })).rejects.toBeInstanceOf(UnknownPoolError);
      expect(slept).toEqual([2_000]);
    });

    it('reads a transaction again after its lookup failed, and measures it as before', async () => {
      settledFills();
      failing('txOutcome', (call) => call === 1);

      const report = await run({ poolId: 0 });

      expect(report.failed).toBe(false);
      expect(lineOf(report, 'commit gas').ok).toBe(true);
    });

    it('passes on the error of a read after the wait that failed three times in a row', async () => {
      settledFills();
      failing('txOutcome', (call) => call <= 3, () => new Error('the RPC is down'));

      await expect(run({ poolId: 0 })).rejects.toThrow('the RPC is down');
    });

    it('reads the buyers and the balances again after a failed read', async () => {
      const baseline = settledFills();
      failing('getSeats', (call) => call === 1);
      failing('ftBalanceOf', (call) => call === 1 || call === 4);

      const report = await run({ poolId: 0, baseline });

      expect(report.failed).toBe(false);
      expect(report.lines).toHaveLength(8);
    });

    it('reads the solvency figures again at the height of a new final block when one of them failed', async () => {
      settledFills();
      chain.register(POOLS, 0n);
      const finalBlock = chain.finalBlock.bind(chain);
      chain.finalBlock = async () => {
        chain.block = { ...chain.block, height: chain.block.height + 1n };
        return finalBlock();
      };
      failing('ftBalanceOf', (call) => call === 1, () => new Error('the block is garbage-collected'));

      const report = await run({ poolId: 0 });

      expect(lineOf(report, 'solvency').ok).toBe(true);
      // The failed balance read was not made: the reads made are those of the second try, at its height.
      const pinned = chain.reads.filter((read) => read.atHeight !== null);
      expect(pinned.map((read) => read.method)).toEqual(['ftBalanceOf', 'listPools']);
      expect(pinned.map((read) => read.atHeight)).toEqual([chain.block.height, chain.block.height]);
    });
  });

  describe('buyers', () => {
    it('fails a settled pool with a buyer that is not committed', async () => {
      settledFills();
      chain.seats.get(0)![1]!.state = 'refunded';

      const report = await run({ poolId: 0 });

      expect(lineOf(report, 'buyers')).toEqual({ ok: false, detail: `1 of 2 buyers not committed: ${buyer(2)} refunded` });
    });

    it('fails a refunded pool with a buyer that is claimable or still committed', async () => {
      refundedFails();
      chain.seats.get(1)![2]!.state = 'claimable';
      chain.seats.get(1)![4]!.state = 'committed';

      const report = await run({ poolId: 1, scenario: FAILS });

      expect(lineOf(report, 'buyers')).toEqual({
        ok: false,
        detail: `2 of 6 buyers not refunded: ${buyer(3)} claimable, ${buyer(5)} committed`,
      });
    });

    it('reads every page of buyers', async () => {
      // 150 buyers of one seat: a bonus share of floor(3072 / 150) = 20 each and a dust of 72.
      const seats: SeatView[] = Array.from({ length: 150 }, (_, i) => ({ buyer: `b${i}.testnet`, seats: 1, state: 'refunded' }));
      seats[120]!.state = 'claimable';
      refundedFails({ taken: 150, buyer_count: 150, refund_cursor: 150, bonus_per_seat: '20' });
      chain.seats.set(1, seats);

      const report = await run({ poolId: 1, scenario: FAILS });

      expect(lineOf(report, 'buyers')).toEqual({ ok: false, detail: '1 of 150 buyers not refunded: b120.testnet claimable' });
      expect(lineOf(report, 'refunds and dust').ok).toBe(true);
    });
  });

  describe('refunds and dust (invariant 4)', () => {
    it('fails when the buyers’ seats do not add up to the seats the pool took', async () => {
      // 101 seats at a share of 30 leave a dust of 3072 − 3030 = 42.
      refundedFails({ taken: 101 });

      const report = await run({ poolId: 1, scenario: FAILS });

      expect(lineOf(report, 'refunds and dust')).toEqual({
        ok: false,
        detail: 'refunds 35000 + dust 42 = 35042, not 101 × 320 + bonus 3072 = 35392',
      });
    });

    it('fails when the bonus shares come to more than the bonus', async () => {
      refundedFails({ bonus_per_seat: '31' });

      const report = await run({ poolId: 1, scenario: FAILS });

      expect(lineOf(report, 'refunds and dust')).toEqual({
        ok: false,
        detail: 'a bonus share of 31 for each of 100 seats comes to more than the bonus 3072',
      });
    });

    it('accepts a dust of 0, when the bonus shares come to the whole bonus', async () => {
      refundedFails({ bonus: '3000' });

      const report = await run({ poolId: 1, scenario: FAILS });

      expect(lineOf(report, 'refunds and dust')).toEqual({ ok: true, detail: 'refunds 35000 + dust 0 = 100 × 320 + bonus 3000 = 35000' });
    });

    it('is not checked for a settled pool', async () => {
      settledFills();

      expect(names(await run({ poolId: 0 }))).not.toContain('refunds and dust');
    });
  });

  describe('solvency', () => {
    /**
     * Pools 5 to 9 beside the settled pool 0, owing by status: open 10 × 180 + 1728 = 3528; filled
     * 3 × 100 + 50 = 350; settled 0; expired, a committed and a claimable buyer at 100 + 3 each and a
     * dust of 1 not sent yet = 207; refunded, a claimable buyer of 2 seats at 100 + 5 = 210 with its
     * dust sent. 4295 in all.
     */
    function otherPools(): void {
      chain.setPool(poolView({ id: 5, taken: 10 }));
      chain.setPool(poolView({ id: 6, seat_price: '100', target: 3, taken: 3, bonus: '50', status: 'filled' }));
      chain.setPool(poolView({ id: 7, taken: 192, status: 'settled' }));
      chain.setPool(
        poolView({ id: 8, seat_price: '100', taken: 3, bonus: '10', status: 'expired', bonus_per_seat: '3', refund_cursor: 1, buyer_count: 3 }),
      );
      chain.seats.set(8, [
        { buyer: 'a.testnet', seats: 1, state: 'refunded' },
        { buyer: 'b.testnet', seats: 1, state: 'committed' },
        { buyer: 'c.testnet', seats: 1, state: 'claimable' },
      ]);
      chain.setPool(
        poolView({ id: 9, seat_price: '100', taken: 2, bonus: '11', status: 'refunded', bonus_per_seat: '5', dust_sent: true, buyer_count: 1 }),
      );
      chain.seats.set(9, [{ buyer: 'd.testnet', seats: 2, state: 'claimable' }]);
    }

    it('passes when the pools contract holds what every pool still owes', async () => {
      settledFills();
      otherPools();
      chain.register(POOLS, 4_295n);

      const report = await run({ poolId: 0 });

      expect(lineOf(report, 'solvency')).toEqual({ ok: true, detail: 'the pools contract holds 4295 and owes 4295 across 6 pools' });
    });

    it('fails when the pools contract holds less than every pool still owes', async () => {
      settledFills();
      otherPools();
      chain.register(POOLS, 4_294n);

      const report = await run({ poolId: 0 });

      expect(lineOf(report, 'solvency')).toEqual({ ok: false, detail: 'the pools contract holds 4294 but owes 4295 across 6 pools' });
    });

    it('reads the pools contract’s balance and every view it sums at one final block', async () => {
      settledFills();
      otherPools();
      chain.register(POOLS, 4_295n);
      // The final block moves on at each read of it, as it does while the check runs.
      const finalBlock = chain.finalBlock.bind(chain);
      chain.finalBlock = async () => {
        chain.block = { ...chain.block, height: chain.block.height + 1n };
        return finalBlock();
      };

      const report = await run({ poolId: 0 });

      expect(lineOf(report, 'solvency').ok).toBe(true);
      const pinned = chain.reads.filter((read) => read.atHeight !== null);
      expect(pinned.map(({ method, args }) => [method, args])).toEqual([
        ['ftBalanceOf', [POOLS]],
        ['listPools', [0, 100]],
        ['getSeats', [8, 0, 100]],
        ['getSeats', [9, 0, 100]],
      ]);
      expect(pinned.map((read) => read.atHeight)).toEqual(Array(4).fill(chain.block.height));
    });

    it('reads every page of pools', async () => {
      settledFills();
      for (let id = 1; id <= 100; id++) chain.setPool(poolView({ id, status: 'settled' }));
      chain.setPool(poolView({ id: 101 }));
      chain.register(POOLS, 1_728n);

      const report = await run({ poolId: 0 });

      expect(lineOf(report, 'solvency')).toEqual({ ok: true, detail: 'the pools contract holds 1728 and owes 1728 across 102 pools' });
    });
  });

  describe('balances', () => {
    it('fails a buyer whose balance did not change by its seats’ price', async () => {
      const baseline = settledFills();
      chain.register(buyer(1), 9_650n);

      const report = await run({ poolId: 0, baseline });

      expect(lineOf(report, 'buyer balances')).toEqual({
        ok: false,
        detail: `1 of 2 buyers off: ${buyer(1)} changed by -350, expected -360`,
      });
    });

    it('fails a provider whose balance did not change by the seats taken', async () => {
      const baseline = settledFills();
      chain.register(PROVIDER, 10_500n);

      const report = await run({ poolId: 0, baseline });

      expect(lineOf(report, 'provider balance')).toEqual({ ok: false, detail: `${PROVIDER} changed by +500, expected +540` });
    });

    it('fails a pools contract whose balance changed', async () => {
      const baseline = settledFills();
      chain.register(POOLS, 1n);

      const report = await run({ poolId: 0, baseline });

      expect(lineOf(report, 'pools contract balance')).toEqual({ ok: false, detail: `${POOLS} changed by +1, expected 0` });
    });

    it('fails a refunded pool’s buyer that did not get its bonus share', async () => {
      const baseline = refundedFails();
      chain.register(buyer(2), 10_000n);

      const report = await run({ poolId: 1, scenario: FAILS, baseline });

      expect(lineOf(report, 'buyer balances')).toEqual({ ok: false, detail: `1 of 6 buyers off: ${buyer(2)} changed by 0, expected +600` });
    });

    it('fails a refunded pool’s provider that did not get the dust back', async () => {
      const baseline = refundedFails();
      chain.register(PROVIDER, 6_928n);

      const report = await run({ poolId: 1, scenario: FAILS, baseline });

      expect(lineOf(report, 'provider balance')).toEqual({ ok: false, detail: `${PROVIDER} changed by -3072, expected -3000` });
    });

    it('compares only the accounts in the baseline, and only the pool’s buyers', async () => {
      settledFills();
      // buyer-03 holds no seat of this pool, so what it spent elsewhere during the run is not checked.
      chain.register(buyer(3), 1n);
      const baseline = new Map([
        [buyer(1), 10_000n],
        [buyer(3), 10_000n],
      ]);

      const report = await run({ poolId: 0, baseline });

      expect(names(report)).not.toContain('provider balance');
      expect(names(report)).not.toContain('pools contract balance');
      expect(lineOf(report, 'buyer balances')).toEqual({ ok: true, detail: '1 buyer changed as expected' });
    });

    it('checks no balance without a baseline', async () => {
      settledFills();

      expect(names(await run({ poolId: 0 }))).toEqual(['status', 'buyers', 'solvency', 'commit gas', 'payout gas']);
    });
  });

  describe('commit gas', () => {
    it('fails each commit that burnt more than QUORUM_COMMIT_MIN_GAS', async () => {
      settledFills();
      const heavy = commit(0, buyer(3), 1, 180, { onTransfer: 50n * TGAS });

      const report = await run({ poolId: 0 }, testConfig({ commitMinGas: 52n * TGAS }));

      expect(lineOf(report, 'commit gas')).toEqual({ ok: false, detail: `3 commits, limit 52.00 Tgas: ${heavy} burnt 53.74 Tgas` });
    });

    it('accepts a commit that burnt exactly QUORUM_COMMIT_MIN_GAS', async () => {
      settledFills();

      const report = await run({ poolId: 0 }, testConfig({ commitMinGas: FIXTURE_COMMIT_GAS }));

      expect(lineOf(report, 'commit gas').ok).toBe(true);
    });

    it('fails a commit whose transaction the RPC does not know as one the relayer signed', async () => {
      settledFills();
      const txHash = hashOf('a commit signed by the buyer');
      feed.push({ at: NOW_MS, poolId: 0, kind: 'commit', account: buyer(3), seats: 1, amount: 180n, txHash, ok: true });
      chain.addOutcome(buyer(3), relayedCommit({ txHash, relayer: RELAYER, buyer: buyer(3), token: TOKEN, pools: POOLS }));

      const report = await run({ poolId: 0 });

      expect(lineOf(report, 'commit gas')).toEqual({ ok: false, detail: `3 commits, limit 50.00 Tgas: ${txHash} is unknown to the RPC` });
    });

    it('fails a commit whose transaction the RPC did not see final within its wait, saying so', async () => {
      settledFills();
      const txHash = hashOf('a commit not yet final');
      feed.push({ at: NOW_MS, poolId: 0, kind: 'commit', account: buyer(3), seats: 1, amount: 180n, txHash, ok: true });
      chain.markNotFinal(RELAYER, txHash);

      const report = await run({ poolId: 0 });

      expect(lineOf(report, 'commit gas')).toEqual({
        ok: false,
        detail: `3 commits, limit 50.00 Tgas: ${txHash} is not yet final (waited for once)`,
      });
    });

    it('fails a commit whose outcome has no receipt on its buyer', async () => {
      settledFills();
      const txHash = hashOf('a commit of another buyer');
      feed.push({ at: NOW_MS, poolId: 0, kind: 'commit', account: buyer(3), seats: 1, amount: 180n, txHash, ok: true });
      chain.addOutcome(RELAYER, relayedCommit({ txHash, relayer: RELAYER, buyer: buyer(4), token: TOKEN, pools: POOLS }));

      const report = await run({ poolId: 0 });

      expect(lineOf(report, 'commit gas')).toEqual({
        ok: false,
        detail: `3 commits, limit 50.00 Tgas: ${txHash} ran no receipt on ${buyer(3)}`,
      });
    });

    it("fails when one of the swarm's buyers holds seats but the feed has no commit of it, saying why that can be", async () => {
      settledFills();
      feed = feed.filter((record) => !(record.kind === 'commit' && record.account === buyer(2)));

      const report = await run({ poolId: 0 });

      expect(lineOf(report, 'commit gas')).toEqual({
        ok: false,
        detail:
          `1 commit, limit 50.00 Tgas: not measured: ${buyer(2)} (1 seat) holds seats, but the activity feed has no commit of it ` +
          "(the gateway records no relay whose result was unknown; its feed is in its QUORUM_DATA_DIR)",
      });
      expect(report.lines).toHaveLength(5);
    });

    it('fails, naming each of them, when the feed holds no commit at all of a pool whose seats were taken', async () => {
      settledFills();
      feed = feed.filter((record) => record.kind !== 'commit');

      const report = await run({ poolId: 0 });

      expect(lineOf(report, 'commit gas')).toEqual({
        ok: false,
        detail:
          `no commits, limit 50.00 Tgas: not measured: ${buyer(1)} (2 seats), ${buyer(2)} (1 seat) hold seats, but the activity feed ` +
          "has no commit of theirs (the gateway records no relay whose result was unknown; its feed is in its QUORUM_DATA_DIR)",
      });
    });

    it('takes no failed commit record for the commit of a buyer holding seats', async () => {
      settledFills();
      for (const record of feed) if (record.kind === 'commit' && record.account === buyer(2)) record.ok = false;

      const report = await run({ poolId: 0 });

      expect(lineOf(report, 'commit gas').ok).toBe(false);
      expect(lineOf(report, 'commit gas').detail).toContain(`not measured: ${buyer(2)} (1 seat) holds seats`);
    });

    it('names a holder that is not one of the swarm’s buyers in a note, without failing', async () => {
      settledFills();
      chain.seats.get(0)!.push({ buyer: 'stranger.testnet', seats: 3, state: 'committed' });

      const report = await run({ poolId: 0 });

      expect(lineOf(report, 'commit gas')).toEqual({
        ok: true,
        detail:
          '2 commits, at most 5.70 Tgas each (limit 50.00 Tgas); not checked: stranger.testnet (3 seats) holds seats with no commit ' +
          "in the activity feed, and is not one of the swarm's buyers",
      });
    });

    it('measures a commit a buyer learned the transaction of, which the feed lacks, once its outcome shows the seats it took', async () => {
      settledFills();
      feed = feed.filter((record) => !(record.kind === 'commit' && record.account === buyer(2)));
      const txHash = hashOf('a commit whose result was unknown');
      const committed = eventLog({ event: 'seats_committed', data: { pool_id: 0, buyer: buyer(2), seats: 1, amount: '180', taken: 3, target: 3 } });
      chain.addOutcome(RELAYER, relayedCommit({ txHash, relayer: RELAYER, buyer: buyer(2), token: TOKEN, pools: POOLS, poolsLogs: [committed] }));

      const report = await checkPool(testConfig(), deps(), { poolId: 0, scenario: FILLS, extraCommits: [{ account: buyer(2), txHash }] });

      expect(lineOf(report, 'commit gas')).toEqual({ ok: true, detail: '2 commits, at most 5.70 Tgas each (limit 50.00 Tgas)' });
    });

    it('measures nothing from a learned transaction the RPC does not know, or whose outcome took no seats for its buyer in the pool', async () => {
      settledFills();
      feed = feed.filter((record) => !(record.kind === 'commit' && record.account === buyer(2)));
      const elsewhere = hashOf('a commit to another pool');
      const otherPool = eventLog({ event: 'seats_committed', data: { pool_id: 5, buyer: buyer(2), seats: 1, amount: '180', taken: 1, target: 3 } });
      chain.addOutcome(RELAYER, relayedCommit({ txHash: elsewhere, relayer: RELAYER, buyer: buyer(2), token: TOKEN, pools: POOLS, poolsLogs: [otherPool] }));
      const extraCommits = [
        { account: buyer(2), txHash: hashOf('never relayed') },
        { account: buyer(2), txHash: elsewhere },
      ];

      const report = await checkPool(testConfig(), deps(), { poolId: 0, scenario: FILLS, extraCommits });

      expect(lineOf(report, 'commit gas').ok).toBe(false);
      expect(lineOf(report, 'commit gas').detail).toMatch(/^1 commit, limit 50\.00 Tgas: not measured: /);
    });

    it('passes a pool no one committed to', async () => {
      chain.setPool(poolView({ id: 2, deadline_ms: NOW_MS - 60_000, status: 'refunded', dust_sent: true }));
      keeperTx(2, [{ kind: 'dust', account: PROVIDER, seats: 0, amount: 1728n }], [PAYOUT]);

      const report = await run({ poolId: 2, scenario: FAILS });

      expect(lineOf(report, 'commit gas')).toEqual({ ok: true, detail: 'no commits' });
      expect(report.failed).toBe(false);
    });
  });

  describe('payout gas', () => {
    it('shows gas truncated to 2 decimals, so that a transfer that passes at 4.996 Tgas shows as 4.99, not 5.00', async () => {
      settledFills();
      keeperTx(0, [{ kind: 'settle', account: PROVIDER, seats: 3, amount: 2268n }], [{ transfer: 4_996_000_000_000n, callback: CALLBACK_GAS }]);

      const report = await run({ poolId: 0 });

      expect(lineOf(report, 'payout gas')).toEqual({
        ok: true,
        detail: '2 transactions, 2 ft_transfers at most 4.99 Tgas, 2 callbacks at most 1.49 Tgas (each under 5.00 Tgas)',
      });
    });

    it('fails an ft_transfer that burnt 5 Tgas', async () => {
      settledFills();
      const txHash = keeperTx(0, [{ kind: 'settle', account: PROVIDER, seats: 3, amount: 2268n }], [{ transfer: 5n * TGAS, callback: CALLBACK_GAS }]);

      const report = await run({ poolId: 0 });

      expect(lineOf(report, 'payout gas')).toEqual({ ok: false, detail: `2 transactions: ${txHash} ft_transfer burnt 5.00 Tgas` });
    });

    it('fails a callback that burnt 5 Tgas', async () => {
      refundedFails();
      const txHash = keeperTx(1, [{ kind: 'refund', account: buyer(1), seats: 24, amount: 8400n }], [{ transfer: TRANSFER_GAS, callback: 5n * TGAS }]);

      const report = await run({ poolId: 1, scenario: FAILS });

      expect(lineOf(report, 'payout gas')).toEqual({ ok: false, detail: `2 transactions: ${txHash} callback burnt 5.00 Tgas` });
    });

    it('measures an ft_transfer that failed, as a refund the token refused does', async () => {
      refundedFails();
      const txHash = keeperTx(
        1,
        [{ kind: 'refund', account: buyer(1), seats: 0, amount: 8400n }],
        [{ transfer: 5n * TGAS, callback: CALLBACK_GAS, failed: true }],
      );
      feed.at(-1)!.ok = false;

      const report = await run({ poolId: 1, scenario: FAILS });

      expect(lineOf(report, 'payout gas')).toEqual({ ok: false, detail: `2 transactions: ${txHash} ft_transfer burnt 5.00 Tgas` });
    });

    it("fails a refunded pool when one of the swarm's refunded buyers has no refund in the feed, saying why that can be", async () => {
      refundedFails();
      feed = feed.filter((record) => !(record.kind === 'refund' && (record.account === buyer(2) || record.account === buyer(5))));

      const report = await run({ poolId: 1, scenario: FAILS });

      expect(lineOf(report, 'payout gas')).toEqual({
        ok: false,
        detail:
          `1 transaction: not measured: ${buyer(2)}, ${buyer(5)} were refunded, but the activity feed has no refund of theirs ` +
          "(the gateway records only the refunds its keeper sends; its feed is in its QUORUM_DATA_DIR)",
      });
      // As many checks as in a refunded pool that passes: status, buyers, refunds and dust, solvency and the two gas lines.
      expect(report.lines).toHaveLength(6);
    });

    it('fails a refunded pool whose feed holds the dust but no refund at all', async () => {
      refundedFails();
      feed = feed.filter((record) => record.kind !== 'refund');

      const report = await run({ poolId: 1, scenario: FAILS });

      expect(lineOf(report, 'payout gas').ok).toBe(false);
      expect(lineOf(report, 'payout gas').detail).toContain(`not measured: ${buyer(1)}, ${buyer(2)}, ${buyer(3)}`);
    });

    it('names a refunded buyer that is not one of the swarm’s in a note, without failing', async () => {
      refundedFails({ taken: 101 });
      chain.seats.get(1)!.push({ buyer: 'stranger.testnet', seats: 1, state: 'refunded' });

      const report = await run({ poolId: 1, scenario: FAILS });

      expect(lineOf(report, 'payout gas').ok).toBe(true);
      expect(lineOf(report, 'payout gas').detail).toMatch(
        /; not checked: stranger\.testnet was refunded with no refund in the activity feed, and is not one of the swarm's buyers$/,
      );
    });

    it('fails a keeper transaction the RPC did not see final within its wait, saying so', async () => {
      settledFills();
      const txHash = hashOf('a settle not yet final');
      feed.push({ at: NOW_MS, poolId: 0, kind: 'settle', account: PROVIDER, seats: 3, amount: 0n, txHash, ok: false });
      chain.markNotFinal(RELAYER, txHash);

      const report = await run({ poolId: 0 });

      expect(lineOf(report, 'payout gas')).toEqual({ ok: false, detail: `2 transactions: ${txHash} is not yet final (waited for once)` });
    });

    it('fails a keeper transaction the RPC does not know', async () => {
      settledFills();
      const txHash = hashOf('an unknown settle');
      feed.push({ at: NOW_MS, poolId: 0, kind: 'settle', account: PROVIDER, seats: 3, amount: 0n, txHash, ok: false });

      const report = await run({ poolId: 0 });

      expect(lineOf(report, 'payout gas')).toEqual({ ok: false, detail: `2 transactions: ${txHash} is unknown to the RPC` });
    });
  });
});
