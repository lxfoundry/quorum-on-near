// The swarm end to end, against a local sandbox and the real gateway running as a child process:
// setup stopping on the token shortfall and then completing, the `fills` scenario run in this
// process, the `fails` scenario run through the command line, a second setup in a row that sends
// nothing, and reset. Needs Linux or macOS (near-sandbox ships no Windows binary, so on Windows the
// suite is skipped) and the wasm files from `cargo near build`, named by QUORUM_POOLS_WASM and
// QUORUM_MOCK_USD_WASM; without them the suite fails. The tests run in order, each on the state the
// previous ones left; the last one checks that the sandbox still holds the first setup's transactions.
// Figures worth comparing between runs (durations, NEAR spent, gas) are printed.
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { RpcPoolReads } from '@quorum-on-near/buyer';
import { JsonRpcProvider, yoctoToNear } from 'near-api-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buyerIds } from '../../src/accounts.ts';
import type { BuyerOutcome, BuyerOutcomeKind } from '../../src/buyer-agent.ts';
import { TGAS } from '../../src/chain.ts';
import { checkPool, commitGas, payoutGas, snapshot } from '../../src/check.ts';
import { PROFILES } from '../../src/profiles.ts';
import { openPool } from '../../src/provider.ts';
import { runReset } from '../../src/reset.ts';
import { runSwarm } from '../../src/run.ts';
import { scenario } from '../../src/scenarios.ts';
import { ShortfallError } from '../../src/setup.ts';
import { recordSetup, runSwarmCli, startSwarmWorld, type SetupRun, type SwarmWorld } from './harness.ts';

const TIMEOUT_MS = 600_000;
/** The start's limit: a sandbox, the token, two setups that create and fund 25 accounts, and the gateway. */
const START_TIMEOUT_MS = 900_000;
/** `swarm demo fails` waits for the pool's deadline, then for the keeper's refund; the check gives up 5 minutes after the deadline. */
const CLI_TIMEOUT_MS = 540_000;
/** The scripted buyers that accept the `fills` price, 180 (their top price is 400 or 250): buyer-01 to buyer-14. */
const FILLS_ACCEPTING = 14;

/** How many outcomes there are of each kind, in the order the kinds first appear. */
function kinds(outcomes: readonly BuyerOutcome[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const { kind } of outcomes) counts[kind] = (counts[kind] ?? 0) + 1;
  return counts;
}

function near(yocto: bigint): string {
  return `${yoctoToNear(yocto)} NEAR`;
}

function tgas(gas: bigint): string {
  return (Number(gas) / Number(TGAS)).toFixed(2);
}

/** The least, the most and the mean of some gas figures, in Tgas. */
function gasRange(figures: readonly bigint[]): string {
  if (figures.length === 0) return 'none';
  const sorted = [...figures].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const total = figures.reduce((sum, gas) => sum + gas, 0n);
  const least = sorted[0] ?? 0n;
  const most = sorted.at(-1) ?? 0n;
  return `${figures.length}, ${tgas(least)} to ${tgas(most)}, mean ${tgas(total / BigInt(figures.length))}`;
}

/** Prints what a setup run did and logged, and what it cost the parent. */
function logSetup(name: string, run: SetupRun): void {
  const ended = run.error === null ? 'completed' : `stopped: ${(run.error as Error).message}`;
  console.log(
    `${name}: ${run.writes} writes in ${run.ms} ms, the parent spent ${near(run.parentBefore - run.parentAfter)}; ${ended}`,
  );
  for (const line of run.lines) console.log(`  ${line}`);
}

// near-sandbox ships no Windows binary.
describe.skipIf(process.platform === 'win32')('the swarm against a local sandbox and the real gateway', { timeout: TIMEOUT_MS }, () => {
  // Set by beforeAll; afterAll may find it unset if the start failed.
  let world: SwarmWorld | undefined;

  /** The world, which beforeAll started. */
  const started = (): SwarmWorld => {
    if (world === undefined) throw new Error('the world did not start');
    return world;
  };

  /**
   * Prints the gas each transaction of the pool's activity feed burnt, read with the relayer as
   * signer: each relayed commit's own receipts (commitGas) and its whole transaction, and each payout
   * `ft_transfer` and callback of the keeper's calls (payoutGas).
   */
  const logGas = async (poolId: number): Promise<void> => {
    const { config, chain, gatewayClient } = started();
    const commits: bigint[] = [];
    const relayed: bigint[] = [];
    const transfers: bigint[] = [];
    const callbacks: bigint[] = [];
    const seen = new Set<string>();
    for (const record of await gatewayClient.activity(poolId)) {
      if (seen.has(record.txHash)) continue;
      seen.add(record.txHash);
      const outcome = await chain.txOutcome(record.txHash, config.relayer);
      if (outcome === null) continue;
      if (record.kind === 'commit') {
        const gas = commitGas(outcome, record.account, [config.token, config.poolsContract]);
        if (gas !== null) commits.push(gas);
        relayed.push(outcome.receipts.reduce((sum, receipt) => sum + receipt.gasBurnt, 0n));
      } else {
        const gas = payoutGas(outcome, config.poolsContract, config.token);
        transfers.push(...gas.transfers);
        callbacks.push(...gas.callbacks);
      }
    }
    console.log(`pool ${poolId} gas in Tgas (count, least to most, mean):`);
    console.log(`  commit receipts:        ${gasRange(commits)}`);
    console.log(`  whole relayed commit:   ${gasRange(relayed)}`);
    console.log(`  payout ft_transfer:     ${gasRange(transfers)}`);
    console.log(`  payout callback:        ${gasRange(callbacks)}`);
  };

  beforeAll(async () => {
    world = await startSwarmWorld();
    for (const { step, ms } of world.timings) console.log(`start: ${step} took ${ms} ms`);
    const [first, second] = world.setupRuns;
    logSetup('first setup', first);
    logSetup('second setup', second);
  }, START_TIMEOUT_MS);

  afterAll(async () => {
    if (world === undefined) return;
    const stderr = await readFile(world.gateway.stderrPath, 'utf8');
    console.log(`the gateway's standard error:${stderr === '' ? ' empty' : `\n${stderr}`}`);
    await world.stop();
  }, TIMEOUT_MS);

  it('stops the first setup on the token shortfall once it has created and registered the funding account, and completes the second once the funding account holds the token', async () => {
    const { config, chain, setupRuns } = started();
    const [first, second] = setupRuns;
    const { funding } = config;

    expect(first.error).toBeInstanceOf(ShortfallError);
    expect(first.error).toMatchObject({
      problem: 'token_shortfall',
      account: funding,
      // Nothing held yet: the whole amount of each of the 21 buyers and the provider.
      shortfall: 21n * config.buyerBudget + config.providerBonusFunds,
    });
    expect((first.error as Error).message).toContain(funding);
    expect(first.lines).toContainEqual(expect.stringMatching(new RegExp(`^created {2}${funding.replaceAll('.', '\\.')} {2}`)));
    expect(first.lines.some((line) => line.startsWith('registered on the token') && line.includes(funding))).toBe(true);
    expect(first.lines.some((line) => line.startsWith('sent tokens'))).toBe(false);

    expect(second.error).toBeNull();
    expect(second.lines.some((line) => line.startsWith('sent tokens'))).toBe(true);
    expect(await chain.isRegistered(funding)).toBe(true);
    for (const id of buyerIds(config)) expect(await chain.ftBalanceOf(id)).toBe(config.buyerBudget);
    expect(await chain.ftBalanceOf(config.provider)).toBe(config.providerBonusFunds);
  });

  it('fills the fills pool: buyers 15 to 20 decline it or find it full, the others take its 192 seats, it settles, and every check passes', async () => {
    const { config, chain, gatewayClient, buyerChain } = started();
    const fills = scenario('fills', config);
    const log = (line: string): void => console.log(line);
    const relayerBefore = (await chain.account(config.relayer))?.balance ?? 0n;
    const blockBefore = await chain.finalBlock();

    let start = performance.now();
    const baseline = await snapshot(config, chain);
    const { poolId } = await openPool(config, { chain, log }, fills);
    const opened = performance.now() - start;
    start = performance.now();
    const pools = new RpcPoolReads(new JsonRpcProvider({ url: config.rpcUrl }), config.poolsContract);
    const outcomes = await runSwarm(config, { gateway: gatewayClient, chain: buyerChain, pools, log }, poolId, fills);
    const ran = performance.now() - start;
    start = performance.now();
    const checkDeps = { chain, gateway: gatewayClient, now: Date.now, sleep: (ms: number) => delay(ms), log };
    // As swarm demo does: a commit whose result was unknown is missing from the feed, but its buyer may have learned it.
    const extraCommits = outcomes.flatMap(({ buyer, txHashes }) => txHashes.map((txHash) => ({ account: buyer, txHash })));
    const report = await checkPool(config, checkDeps, { poolId, scenario: fills, baseline, extraCommits });
    const checked = performance.now() - start;

    const relayerAfter = (await chain.account(config.relayer))?.balance ?? 0n;
    const blockAfter = await chain.finalBlock();
    const blocks = Number(blockAfter.height - blockBefore.height);
    const blockMs = blocks === 0 ? 0 : Math.round((blockAfter.timestampMs - blockBefore.timestampMs) / blocks);
    console.log(`fills: open ${Math.round(opened)} ms, run ${Math.round(ran)} ms, check ${Math.round(checked)} ms`);
    console.log(`fills: ${blocks} blocks went by, one every ${blockMs} ms of block time`);
    console.log(`fills outcomes: ${JSON.stringify(kinds(outcomes))}`);
    console.log(`fills: the relayer spent ${near(relayerBefore - relayerAfter)}`);
    await logGas(poolId);

    expect(report.failed).toBe(false);
    expect(report.status).toBe('settled');
    // A buyer arriving once the pool is full no longer finds it listed, so it learns it missed the
    // pool without seeing its price; one arriving as it fills takes what is left.
    const missedFull = /^no seat left \(pool (filled|settled)\)$/;
    for (const outcome of outcomes.slice(FILLS_ACCEPTING)) {
      if (outcome.kind !== 'declined') expect(outcome).toMatchObject({ kind: 'missed', detail: expect.stringMatching(missedFull) });
      expect(outcome.seats).toBe(0);
    }
    const accepting = outcomes.slice(0, FILLS_ACCEPTING);
    for (const [i, outcome] of accepting.entries()) {
      const wanted = PROFILES[i]?.seats ?? 0;
      expect<BuyerOutcomeKind[]>(['credential', 'missed']).toContain(outcome.kind);
      if (outcome.kind === 'credential') {
        expect(outcome.seats).toBeGreaterThan(0);
        expect(outcome.seats).toBeLessThanOrEqual(wanted);
      } else {
        expect(outcome.seats).toBe(0);
      }
    }
    // They want 200 seats between them, so 8 go unsold to the last to arrive.
    expect(accepting.reduce((sum, outcome) => sum + outcome.seats, 0)).toBe(fills.target);
  });

  it('fails the fails pool through the command line: `swarm demo fails` exits 0, every check is ok and the pool is refunded', async () => {
    const run = started();
    const start = performance.now();

    const result = await runSwarmCli(run, ['demo', 'fails'], { timeoutMs: CLI_TIMEOUT_MS });

    console.log(`swarm demo fails: exit ${result.code} after ${Math.round(performance.now() - start)} ms`);
    console.log(`its standard output:\n${result.stdout}`);
    console.log(`its standard error:${result.stderr === '' ? ' empty' : `\n${result.stderr}`}`);
    const opened = /^opened pool (\d+) \(fails\)/m.exec(result.stdout);
    if (opened?.[1] !== undefined) await logGas(Number(opened[1]));

    expect(result.code).toBe(0);
    const checks = result.stdout.split('\n').filter((line) => /^(ok {2}|FAIL) {2}/.test(line));
    expect(checks.length).toBeGreaterThan(0);
    expect(checks.filter((line) => line.startsWith('FAIL'))).toEqual([]);
    expect(result.stdout).toMatch(/^ok {4}status: refunded, as fails expects$/m);
    // Buyers 01 to 06 accept 320 a seat and take 100 seats; the others' top prices are below it.
    expect(result.stdout).toMatch(/^100 seats, 32000 paid: refunded 6, declined 14$/m);
    // Each names the keeper's refund transaction, which the gateway records once the call has finished.
    const refunds = result.stdout.split('\n').filter((line) => /^buyer-\d\d {2}refunded: /.test(line));
    expect(refunds).toHaveLength(6);
    for (const line of refunds) expect(line).toMatch(/ {2}tx [1-9A-HJ-NP-Za-km-z]{32,44}$/);
  });

  it('sends nothing on the second of two setups in a row', async () => {
    const { config, chain } = started();
    const log = (line: string): void => console.log(line);

    const first = await recordSetup(config, chain, log);
    const second = await recordSetup(config, chain, log);

    logSetup('setup after the scenarios', first);
    logSetup('setup again', second);
    expect(first.error).toBeNull();
    expect(second.error).toBeNull();
    expect(second.writes).toBe(0);
    expect(second.report?.actions).toEqual([]);
    expect(second.lines).toEqual(['nothing to do']);
  });

  it('brings every buyer and the provider back to its token amount with reset then setup, and a second reset sends nothing', async () => {
    const { config, chain } = started();
    const log = (line: string): void => console.log(line);

    const returned = await runReset(config, { chain, log });
    const setup = await recordSetup(config, chain, log);
    const writes = chain.writes.length;
    const again = await runReset(config, { chain, log });

    logSetup('setup after reset', setup);
    // The provider earned the fills pool's sales; buyers 01 to 06 earned the fails pool's bonus.
    const buyers = buyerIds(config);
    expect(returned.map((surplus) => surplus.accountId)).toEqual([config.provider, ...buyers.slice(0, 6)]);
    expect(setup.error).toBeNull();
    for (const id of buyers) expect(await chain.ftBalanceOf(id)).toBe(config.buyerBudget);
    expect(await chain.ftBalanceOf(config.provider)).toBe(config.providerBonusFunds);
    expect(again).toEqual([]);
    expect(chain.writes.length).toBe(writes);
  });

  it("still knows the first setup's first transaction once every scenario has run, minutes later", async () => {
    const { config, chain, setupRuns } = started();
    const created = setupRuns[0].lines.find((line) => line.startsWith('created  '));
    const txHash = created?.match(/ tx (\S+)$/)?.[1];
    if (txHash === undefined) throw new Error('the first setup logged no account it created');

    expect(await chain.txOutcome(txHash, config.parent)).not.toBeNull();
  });
});
