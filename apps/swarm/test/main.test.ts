import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keyFilePath, writeKeyFile, type BuyerChainReads, type Env, type PoolReads } from '@quorum-on-near/buyer';
import { KeyPair } from 'near-api-js';
import { describe, expect, it, vi, type Mock } from 'vitest';
import type { AgentRuntime, BuyerOutcome } from '../src/buyer-agent.ts';
import type { Baseline, CheckReport } from '../src/check.ts';
import { aclNotice, EnvFileExistsError } from '../src/env-files.ts';
import { parseCommand, runCli, USAGE, UsageError, type Cli, type Connections, type SwarmModules } from '../src/main.ts';
import { PROFILES, profileAccount } from '../src/profiles.ts';
import { openPool, PoolAlreadyOpenError } from '../src/provider.ts';
import { runSwarm, SeatPriceMismatchError } from '../src/run.ts';
import { ShortfallError } from '../src/setup.ts';
import { FakeChain, PARENT, POOLS, poolView, PROVIDER } from './fake-chain.ts';

const MAIN = fileURLToPath(new URL('../src/main.ts', import.meta.url));
const GATEWAY_ENV = fileURLToPath(new URL('../../gateway/.env', import.meta.url));
const MCP_ENV = fileURLToPath(new URL('../../mcp/.env', import.meta.url));
/** A valid configuration whose scenario overrides show in the scenario each command is given. */
const ENV: Env = { QUORUM_PARENT_ACCOUNT: PARENT, QUORUM_SCENARIO_DEADLINE_SECONDS: '45', QUORUM_SWARM_SPREAD_SECONDS: '9' };
const BASELINE: Baseline = new Map([[PROVIDER, 10_000n]]);
const OPENED_POOL = 7;

function report(oks: readonly boolean[]): CheckReport {
  const lines = oks.map((ok, i) => ({ name: `check ${i}`, ok, detail: '' }));
  return { poolId: OPENED_POOL, status: 'settled', lines, failed: oks.includes(false) };
}

type StubModules = { [K in keyof SwarmModules]: Mock<SwarmModules[K]> };

/** Modules that record the order they are called in and answer as a successful run would. */
function stubModules(order: string[]): StubModules {
  return {
    runSetup: vi.fn<SwarmModules['runSetup']>(async () => {
      order.push('setup');
      return { actions: [] };
    }),
    snapshot: vi.fn<SwarmModules['snapshot']>(async () => {
      order.push('snapshot');
      return BASELINE;
    }),
    openPool: vi.fn<SwarmModules['openPool']>(async () => {
      order.push('open');
      return { poolId: OPENED_POOL, txHash: 'OpenTxHash', deadlineMs: 1_800_000_000_000 };
    }),
    runSwarm: vi.fn<SwarmModules['runSwarm']>(async () => {
      order.push('run');
      return [];
    }),
    checkPool: vi.fn<SwarmModules['checkPool']>(async () => {
      order.push('check');
      return report([true, true]);
    }),
    writeGatewayEnv: vi.fn<SwarmModules['writeGatewayEnv']>(async () => {
      order.push('env gateway');
    }),
    writeMcpEnv: vi.fn<SwarmModules['writeMcpEnv']>(async () => {
      order.push('env mcp');
    }),
  };
}

const unused = (): never => {
  throw new Error('not used by the CLI itself');
};

function harness(env: Env = ENV) {
  const out: string[] = [];
  const err: string[] = [];
  const order: string[] = [];
  const chain = new FakeChain();
  const gateway: Connections['gateway'] = { pools: unused, offer: unused, pay: unused, redeem: unused, activity: unused };
  const buyerChain: BuyerChainReads = { nextNonce: unused, finalHeight: unused };
  const pools: PoolReads = { getPool: unused };
  const runtime: AgentRuntime = { now: () => 1_234, sleep: vi.fn(async () => {}), random: () => 0.5 };
  const modules = stubModules(order);
  const connect = vi.fn<Cli['connect']>(() => ({ chain, gateway, buyerChain, pools }));
  const cli: Cli = {
    env,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    connect,
    runtime,
    modules,
    platform: 'linux',
    userName: () => 'ada',
  };
  return { cli, out, err, order, chain, gateway, buyerChain, pools, runtime, modules, connect };
}

describe('parseCommand', () => {
  it.each([
    [['setup'], { name: 'setup' }],
    [['open', 'fills'], { name: 'open', scenario: 'fills' }],
    [['open', 'fails'], { name: 'open', scenario: 'fails' }],
    [['run', '0', 'fills'], { name: 'run', poolId: 0, scenario: 'fills' }],
    [['run', '9007199254740991', 'fails'], { name: 'run', poolId: 9_007_199_254_740_991, scenario: 'fails' }],
    [['check', '12', 'fails'], { name: 'check', poolId: 12, scenario: 'fails' }],
    [['demo', 'fills'], { name: 'demo', scenario: 'fills' }],
    [['env', 'gateway'], { name: 'env', app: 'gateway' }],
    [['env', 'mcp'], { name: 'env', app: 'mcp' }],
    [['help'], { name: 'help' }],
    [['--help'], { name: 'help' }],
    [['-h'], { name: 'help' }],
  ])('reads %j', (argv, command) => {
    expect(parseCommand(argv)).toEqual(command);
  });

  it.each([
    [[], 'no command'],
    [['deploy'], '"deploy"'],
    [['Setup'], '"Setup"'],
    [['setup', 'now'], 'swarm setup'],
    [['help', 'open'], 'swarm help'],
    [['open'], 'swarm open <fills|fails>'],
    [['open', 'fills', 'fails'], 'swarm open <fills|fails>'],
    [['run', 'fills'], 'swarm run <pool-id> <fills|fails>'],
    [['check', '1'], 'swarm check <pool-id> <fills|fails>'],
    [['demo'], 'swarm demo <fills|fails>'],
    [['env'], 'swarm env <gateway|mcp>'],
  ])('refuses %j, naming what is wrong', (argv, named) => {
    expect(() => parseCommand(argv)).toThrow(UsageError);
    expect(() => parseCommand(argv)).toThrow(named);
  });

  it.each(['both', 'Fills', 'toString', ''])('refuses the scenario %j', (name) => {
    expect(() => parseCommand(['open', name])).toThrow(UsageError);
    expect(() => parseCommand(['demo', name])).toThrow(JSON.stringify(name));
  });

  it.each(['-1', '01', '1.5', '1e3', ' 1', '0x1', '', '9007199254740992'])('refuses the pool id %j', (id) => {
    expect(() => parseCommand(['run', id, 'fills'])).toThrow(UsageError);
    expect(() => parseCommand(['check', id, 'fills'])).toThrow(JSON.stringify(id));
  });

  it.each(['web', 'swarm', 'constructor'])('refuses the app %j', (app) => {
    expect(() => parseCommand(['env', app])).toThrow(UsageError);
    expect(() => parseCommand(['env', app])).toThrow(JSON.stringify(app));
  });

  it('is what USAGE lists, command by command', () => {
    for (const name of ['setup', 'open', 'run', 'check', 'demo', 'env', 'help']) {
      expect(USAGE).toMatch(new RegExp(`^  ${name}\\b`, 'm'));
    }
  });

  it('says in USAGE that run resumes a pool, buying nothing more for a buyer that holds seats', () => {
    expect(USAGE).toMatch(/^ {2}run <pool-id> <fills\|fails> +run the 20 scripted buyers against the pool, or resume them on it$/m);
    expect(USAGE).toMatch(/^swarm run on a pool that buyers have paid in resumes them: .*\s+.*a buyer that holds seats in the pool follows them and never buys again\.$/m);
  });
});

describe('runCli: usage', () => {
  it('prints the problem and the usage on stderr and exits 2 for an unknown command, reading no configuration', async () => {
    const h = harness({});
    expect(await runCli(['deploy'], h.cli)).toBe(2);
    expect(h.err.join('\n')).toContain('"deploy"');
    expect(h.err.join('\n')).toContain(USAGE);
    expect(h.out).toEqual([]);
    expect(h.connect).not.toHaveBeenCalled();
  });

  it('exits 2 for wrong arguments, before reading the configuration', async () => {
    const h = harness({});
    expect(await runCli(['run', 'x', 'fills'], h.cli)).toBe(2);
    expect(h.err.join('\n')).toContain('"x"');
    expect(h.err.join('\n')).toContain(USAGE);
    expect(h.order).toEqual([]);
  });

  it('exits 2 with no command at all', async () => {
    const h = harness();
    expect(await runCli([], h.cli)).toBe(2);
    expect(h.err.join('\n')).toContain(USAGE);
  });

  it('prints the usage on stdout and exits 0 for help, without a configuration', async () => {
    const h = harness({});
    expect(await runCli(['help'], h.cli)).toBe(0);
    expect(h.out).toEqual([USAGE]);
    expect(h.err).toEqual([]);
  });
});

describe('runCli: configuration and chain', () => {
  it('lists every configuration problem on stderr and exits 1, connecting to nothing', async () => {
    const h = harness({ QUORUM_NETWORK: 'near:mainnet', QUORUM_BUYER_NEAR: 'lots' });
    expect(await runCli(['setup'], h.cli)).toBe(1);
    const [text] = h.err;
    expect(h.err).toHaveLength(1);
    expect(text).toMatch(/^invalid configuration:\n/);
    expect(text).toContain('QUORUM_NETWORK must be near:testnet or near:sandbox, got "near:mainnet"');
    expect(text).toContain('QUORUM_PARENT_ACCOUNT is required');
    expect(text).toContain('QUORUM_BUYER_NEAR');
    expect(h.connect).not.toHaveBeenCalled();
  });

  it.each([['setup'], ['open', 'fills'], ['run', '3', 'fills'], ['check', '3', 'fails'], ['demo', 'fails']])(
    '%s stops with exit 1, running nothing, when the RPC serves another chain than QUORUM_NETWORK names',
    async (...argv) => {
      const h = harness();
      h.chain.nodeChainId = 'mainnet';
      expect(await runCli(argv, h.cli)).toBe(1);
      expect(h.err).toHaveLength(1);
      expect(h.err[0]).toMatch(/^invalid configuration:\n/);
      expect(h.err[0]).toContain('"mainnet"');
      expect(h.order).toEqual([]);
      expect(h.chain.writes).toEqual([]);
    },
  );

  it('connects once, with the configuration it read', async () => {
    const h = harness({ ...ENV, QUORUM_RPC_URL: 'http://127.0.0.1:3030', QUORUM_NETWORK: 'near:sandbox' });
    h.chain.nodeChainId = 'sandbox';
    expect(await runCli(['setup'], h.cli)).toBe(0);
    expect(h.connect).toHaveBeenCalledTimes(1);
    expect(h.connect.mock.calls[0]?.[0]).toMatchObject({ rpcUrl: 'http://127.0.0.1:3030', network: 'near:sandbox', parent: PARENT });
  });
});

describe('runCli: commands', () => {
  it('setup runs runSetup on the chain, its lines on stdout', async () => {
    const h = harness();
    h.modules.runSetup.mockImplementation(async (_, deps) => {
      deps.log('nothing to do');
      return { actions: [] };
    });
    expect(await runCli(['setup'], h.cli)).toBe(0);
    const [config, deps] = h.modules.runSetup.mock.calls[0] ?? [];
    expect(config?.parent).toBe(PARENT);
    expect(deps?.chain).toBe(h.chain);
    expect(h.out).toEqual(['nothing to do']);
    expect(h.err).toEqual([]);
  });

  it('open opens the scenario named, with the deadline the configuration sets', async () => {
    const h = harness();
    expect(await runCli(['open', 'fills'], h.cli)).toBe(0);
    const [config, deps, scenario] = h.modules.openPool.mock.calls[0] ?? [];
    expect(config?.provider).toBe(`provider.${PARENT}`);
    expect(deps?.chain).toBe(h.chain);
    expect(scenario).toMatchObject({ name: 'fills', seatPrice: 180n, target: 192, deadlineSeconds: 45 });
    expect(h.order).toEqual(['open']);
  });

  it("run runs the scripted buyers against the pool, through the gateway, with the buyers' chain reads and the runtime", async () => {
    const h = harness();
    expect(await runCli(['run', '3', 'fails'], h.cli)).toBe(0);
    const [, deps, poolId, scenario] = h.modules.runSwarm.mock.calls[0] ?? [];
    expect(deps?.gateway).toBe(h.gateway);
    expect(deps?.chain).toBe(h.buyerChain);
    expect(deps?.pools).toBe(h.pools);
    expect(deps?.runtime).toBe(h.runtime);
    expect(poolId).toBe(3);
    expect(scenario).toMatchObject({ name: 'fails', seatPrice: 320n, spreadSeconds: 9 });
    expect(h.order).toEqual(['run']);
  });

  it("run exits 1 with the pool's seat price and the scenario's on stderr when they differ, and no buyer acts", async () => {
    const credentialsDir = await mkdtemp(join(tmpdir(), 'quorum-main-'));
    try {
      for (const profile of PROFILES) {
        const accountId = profileAccount(profile, PARENT);
        await writeKeyFile(keyFilePath(credentialsDir, 'near:testnet', accountId), accountId, KeyPair.fromRandom('ed25519'));
      }
      const h = harness({ ...ENV, QUORUM_CREDENTIALS_DIR: credentialsDir });
      h.modules.runSwarm.mockImplementation(runSwarm);
      // A fills pool, run as fails.
      vi.spyOn(h.pools, 'getPool').mockImplementation(async (poolId) => poolView({ id: poolId, seat_price: '180' }));
      expect(await runCli(['run', '3', 'fails'], h.cli)).toBe(1);
      expect(h.err).toEqual([new SeatPriceMismatchError(3, 180n, { name: 'fails', seatPrice: 320n }).message]);
      expect(h.err[0]).toContain("pool 3's seat price on chain is 180, not the fails scenario's 320");
      expect(h.out).toEqual([]);
    } finally {
      await rm(credentialsDir, { recursive: true, force: true });
    }
  });

  it('run logs through stdout', async () => {
    const h = harness();
    h.modules.runSwarm.mockImplementation(async (_, deps) => {
      deps.log('buyer-01  paid 24 seats');
      return [];
    });
    await runCli(['run', '3', 'fills'], h.cli);
    expect(h.out).toEqual(['buyer-01  paid 24 seats']);
  });

  it('check checks the pool for the scenario, without a baseline, on the runtime clock', async () => {
    const h = harness();
    expect(await runCli(['check', '12', 'fills'], h.cli)).toBe(0);
    const [, deps, request] = h.modules.checkPool.mock.calls[0] ?? [];
    expect(deps?.chain).toBe(h.chain);
    expect(deps?.gateway).toBe(h.gateway);
    expect(deps?.now()).toBe(1_234);
    await deps?.sleep(2_000);
    expect(h.runtime.sleep).toHaveBeenCalledWith(2_000);
    expect(request?.poolId).toBe(12);
    expect(request?.scenario).toMatchObject({ name: 'fills', expectedEnd: 'settled' });
    expect(request).not.toHaveProperty('baseline');
  });

  it('check exits 0 and says so on stdout when every check passed', async () => {
    const h = harness();
    expect(await runCli(['check', '7', 'fills'], h.cli)).toBe(0);
    expect(h.out).toEqual(['pool 7: 2 checks passed']);
    expect(h.err).toEqual([]);
  });

  it('check exits 1 and says how many failed on stderr when a check failed', async () => {
    const h = harness();
    h.modules.checkPool.mockResolvedValue(report([true, false, false]));
    expect(await runCli(['check', '7', 'fails'], h.cli)).toBe(1);
    expect(h.err).toEqual(['pool 7: 2 of 3 checks failed']);
  });

  it('demo runs setup, reads the baseline, opens the pool, runs the buyers on it, then checks it against the baseline', async () => {
    const h = harness();
    expect(await runCli(['demo', 'fails'], h.cli)).toBe(0);
    expect(h.order).toEqual(['setup', 'snapshot', 'open', 'run', 'check']);
    const [snapshotConfig, snapshotChain] = h.modules.snapshot.mock.calls[0] ?? [];
    expect(snapshotConfig?.provider).toBe(`provider.${PARENT}`);
    expect(snapshotChain).toBe(h.chain);
    expect(h.modules.openPool.mock.calls[0]?.[2]).toMatchObject({ name: 'fails', deadlineSeconds: 45 });
    const [, runDeps, runPool, runScenario] = h.modules.runSwarm.mock.calls[0] ?? [];
    expect(runDeps?.chain).toBe(h.buyerChain);
    expect(runDeps?.pools).toBe(h.pools);
    expect(runPool).toBe(OPENED_POOL);
    expect(runScenario).toMatchObject({ name: 'fails', spreadSeconds: 9 });
    const [, , request] = h.modules.checkPool.mock.calls[0] ?? [];
    expect(request?.poolId).toBe(OPENED_POOL);
    expect(request?.scenario).toMatchObject({ name: 'fails', expectedEnd: 'refunded' });
    expect(request?.baseline).toBe(BASELINE);
  });

  it('demo heads each step on stdout and ends with the verdict', async () => {
    const h = harness();
    await runCli(['demo', 'fills'], h.cli);
    expect(h.out).toEqual(['--- setup', '--- open fills', `--- run pool ${OPENED_POOL}`, `--- check pool ${OPENED_POOL}`, 'pool 7: 2 checks passed']);
  });

  it('demo exits 1 when a check failed', async () => {
    const h = harness();
    h.modules.checkPool.mockResolvedValue(report([false]));
    expect(await runCli(['demo', 'fills'], h.cli)).toBe(1);
    expect(h.err).toEqual(['pool 7: 1 of 1 check failed']);
  });

  it('demo stops at the first step that fails, with its message on stderr and exit 1', async () => {
    const h = harness();
    const shortfall = new ShortfallError('token_shortfall', `funding.${PARENT}`, 500n, `funding.${PARENT} is 500 short of the top-ups`);
    h.modules.runSetup.mockRejectedValue(shortfall);
    expect(await runCli(['demo', 'fills'], h.cli)).toBe(1);
    expect(h.order).toEqual([]);
    expect(h.modules.snapshot).not.toHaveBeenCalled();
    expect(h.modules.openPool).not.toHaveBeenCalled();
    expect(h.err).toEqual([`funding.${PARENT} is 500 short of the top-ups`]);
  });

  it.each([['open'], ['demo']])('%s refuses with exit 1, naming the pool, when the provider already has a pool open, and sends nothing', async (name) => {
    const h = harness();
    h.modules.openPool.mockImplementation(openPool);
    h.chain.addAccount(POOLS, { hasCode: true });
    h.chain.setPool(poolView({ id: 4 }));
    expect(await runCli([name, 'fills'], h.cli)).toBe(1);
    expect(h.err).toEqual([new PoolAlreadyOpenError(PROVIDER, [4]).message]);
    expect(h.err[0]).toContain('pool 4');
    expect(h.chain.writes).toEqual([]);
    // No setup and no snapshot: demo refuses before setup could top an account up.
    expect(h.order).toEqual([]);
    expect(h.out).toEqual([]);
  });

  it('demo goes on to setup when the pools contract is not deployed yet: it holds no pool', async () => {
    const h = harness();
    h.chain.addAccount(POOLS);
    expect(await runCli(['demo', 'fills'], h.cli)).toBe(0);
    expect(h.order).toEqual(['setup', 'snapshot', 'open', 'run', 'check']);
    expect(h.chain.reads.filter((read) => read.method === 'listPools')).toEqual([]);
  });

  it.each([
    ['gateway', GATEWAY_ENV, 'writeGatewayEnv'],
    ['mcp', MCP_ENV, 'writeMcpEnv'],
  ] as const)('env %s writes apps/%s/.env and prints its path, without connecting', async (app, path, module) => {
    const h = harness();
    expect(await runCli(['env', app], h.cli)).toBe(0);
    const [config, written] = h.modules[module].mock.calls[0] ?? [];
    expect(config?.parent).toBe(PARENT);
    expect(written).toBe(path);
    expect(h.order).toEqual([`env ${app}`]);
    expect(h.out).toEqual([`wrote ${path}`]);
    expect(h.connect).not.toHaveBeenCalled();
  });

  it("env gateway on Windows adds a line giving the icacls command that restricts the file to the user", async () => {
    const h = harness();
    h.cli.platform = 'win32';
    h.cli.userName = () => 'Ada Lovelace';
    expect(await runCli(['env', 'gateway'], h.cli)).toBe(0);
    expect(h.out).toEqual([`wrote ${GATEWAY_ENV}`, aclNotice(GATEWAY_ENV, 'win32', 'Ada Lovelace')]);
    expect(h.out[1]).toContain(`icacls "${GATEWAY_ENV}" /inheritance:r /grant:r "Ada Lovelace:F"`);
  });

  it('env mcp on Windows writes no such line: the file holds no key', async () => {
    const h = harness();
    h.cli.platform = 'win32';
    expect(await runCli(['env', 'mcp'], h.cli)).toBe(0);
    expect(h.out).toEqual([`wrote ${MCP_ENV}`]);
  });

  it('env exits 1 with the refusal when the file exists', async () => {
    const h = harness();
    h.modules.writeMcpEnv.mockRejectedValue(new EnvFileExistsError(MCP_ENV));
    expect(await runCli(['env', 'mcp'], h.cli)).toBe(1);
    expect(h.err).toEqual([new EnvFileExistsError(MCP_ENV).message]);
    expect(h.out).toEqual([]);
  });
});

/**
 * The outcomes of a run of `name` that went as it expects (each buyer at or above its seat price
 * holds its seats with a credential in fills or its refund in fails; the others declined), with
 * `changes` applied to the outcome at each index.
 */
function runOutcomes(name: 'fills' | 'fails', changes: Record<number, Partial<BuyerOutcome>> = {}): BuyerOutcome[] {
  const seatPrice = name === 'fills' ? 180n : 320n;
  return PROFILES.map((profile, i) => {
    const buyer = profileAccount(profile, PARENT);
    const accepts = profile.topPrice >= seatPrice;
    const outcome: BuyerOutcome = accepts
      ? { buyer, kind: name === 'fills' ? 'credential' : 'refunded', seats: profile.seats, paid: 0n, detail: 'as expected', txHashes: [] }
      : { buyer, kind: 'declined', seats: 0, paid: 0n, detail: 'seat price above top price', txHashes: [] };
    return { ...outcome, ...changes[i] };
  });
}

describe("runCli: the buyers' outcomes", () => {
  it('demo exits 1 when a buyer that accepts the price did not end as the scenario expects, naming it on stderr after the verdict', async () => {
    const h = harness();
    h.modules.runSwarm.mockResolvedValue(runOutcomes('fails', { 2: { kind: 'failed', seats: 0, detail: 'relay failed' } }));
    expect(await runCli(['demo', 'fails'], h.cli)).toBe(1);
    expect(h.out.at(-1)).toBe('pool 7: 2 checks passed');
    expect(h.err).toEqual(['buyer-03 ended failed with 0 seats (relay failed); fails expects refunded']);
  });

  it('demo exits 1 when a buyer that accepts the price declined the offer', async () => {
    const h = harness();
    h.modules.runSwarm.mockResolvedValue(runOutcomes('fills', { 0: { kind: 'declined', seats: 0, detail: 'offer refused: wrong_pay_to' } }));
    expect(await runCli(['demo', 'fills'], h.cli)).toBe(1);
    expect(h.err).toEqual(['buyer-01 ended declined with 0 seats (offer refused: wrong_pay_to); fills expects credential or missed']);
  });

  it('demo exits 1 when a buyer whose top price is below the seat price holds seats', async () => {
    const h = harness();
    h.modules.runSwarm.mockResolvedValue(runOutcomes('fails', { 6: { kind: 'refunded', seats: 18, detail: '6300 back, bonus 540' } }));
    expect(await runCli(['demo', 'fails'], h.cli)).toBe(1);
    expect(h.err).toEqual([
      'buyer-07 ended refunded with 18 seats (6300 back, bonus 540); fails expects no seats, its top price 250 being below the seat price 320',
    ]);
  });

  it('demo exits 0 when a buyer of fills missed the pool and every other buyer ended as expected', async () => {
    const h = harness();
    h.modules.runSwarm.mockResolvedValue(runOutcomes('fills', { 13: { kind: 'missed', seats: 0 }, 16: { kind: 'missed' } }));
    expect(await runCli(['demo', 'fills'], h.cli)).toBe(0);
    expect(h.err).toEqual([]);
  });

  it('demo prints both a failed check and each unexpected outcome, and exits 1', async () => {
    const h = harness();
    h.modules.checkPool.mockResolvedValue(report([true, false]));
    h.modules.runSwarm.mockResolvedValue(runOutcomes('fills', { 3: { kind: 'timed_out' }, 4: { kind: 'refused', seats: 0, detail: 'payment refused: expired' } }));
    expect(await runCli(['demo', 'fills'], h.cli)).toBe(1);
    expect(h.err).toEqual([
      'pool 7: 1 of 2 checks failed',
      'buyer-04 ended timed_out with 16 seats (as expected); fills expects credential or missed',
      'buyer-05 ended refused with 0 seats (payment refused: expired); fills expects credential or missed',
    ]);
  });

  it('demo gives the check every transaction its buyers learned, as commits the feed may lack', async () => {
    const h = harness();
    const outcomes = runOutcomes('fills', { 0: { txHashes: ['Commit1'] }, 3: { txHashes: ['Unknown4', 'Commit4'] } });
    h.modules.runSwarm.mockResolvedValue(outcomes);
    await runCli(['demo', 'fills'], h.cli);
    const [, , request] = h.modules.checkPool.mock.calls[0] ?? [];
    expect(request?.extraCommits).toEqual([
      { account: outcomes[0]?.buyer, txHash: 'Commit1' },
      { account: outcomes[3]?.buyer, txHash: 'Unknown4' },
      { account: outcomes[3]?.buyer, txHash: 'Commit4' },
    ]);
  });

  it('run exits 1 when a buyer did not end as the scenario expects, naming it on stderr', async () => {
    const h = harness();
    h.modules.runSwarm.mockResolvedValue(runOutcomes('fails', { 5: { kind: 'claimable', detail: '3500 to claim, bonus 300' } }));
    expect(await runCli(['run', '3', 'fails'], h.cli)).toBe(1);
    expect(h.err).toEqual(['buyer-06 ended claimable with 10 seats (3500 to claim, bonus 300); fails expects refunded']);
  });

  it('run exits 0 when every buyer ended as the scenario expects', async () => {
    const h = harness();
    h.modules.runSwarm.mockResolvedValue(runOutcomes('fills'));
    expect(await runCli(['run', '3', 'fills'], h.cli)).toBe(0);
    expect(h.err).toEqual([]);
  });

  it('says in USAGE which buyer outcomes make run and demo exit 1', () => {
    expect(USAGE).toContain('run and demo also exit with 1 when a buyer did not end as the scenario expects');
  });
});

describe('runCli: errors', () => {
  it("prints an error's message and its cause's, never a stack", async () => {
    const h = harness();
    const error = new Error('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:8402') });
    h.modules.runSetup.mockRejectedValue(error);
    expect(await runCli(['setup'], h.cli)).toBe(1);
    expect(h.err).toEqual(['fetch failed (connect ECONNREFUSED 127.0.0.1:8402)']);
  });

  it('names every address of a refused connection whose cause has no message of its own', async () => {
    const h = harness();
    const refused = new AggregateError([new Error('connect ECONNREFUSED ::1:8402'), new Error('connect ECONNREFUSED 127.0.0.1:8402')], '');
    h.modules.runSetup.mockRejectedValue(new Error('fetch failed', { cause: refused }));
    expect(await runCli(['setup'], h.cli)).toBe(1);
    expect(h.err).toEqual(['fetch failed (connect ECONNREFUSED ::1:8402; connect ECONNREFUSED 127.0.0.1:8402)']);
  });

  it('gives the message of a cause that groups errors, then what each of its errors says', async () => {
    const h = harness();
    const grouped = new AggregateError([new Error('first try'), new Error('second try')], 'every try failed');
    h.modules.runSetup.mockRejectedValue(new Error('cannot set up', { cause: grouped }));
    expect(await runCli(['setup'], h.cli)).toBe(1);
    expect(h.err).toEqual(['cannot set up (every try failed (first try; second try))']);
  });

  it('follows every cause of the chain, not only the first', async () => {
    const h = harness();
    const error = new Error('cannot read the pool', { cause: new Error('fetch failed', { cause: new Error('connect ECONNRESET') }) });
    h.modules.runSetup.mockRejectedValue(error);
    expect(await runCli(['setup'], h.cli)).toBe(1);
    expect(h.err).toEqual(['cannot read the pool (fetch failed (connect ECONNRESET))']);
  });

  it('writes QUORUM_RPC_URL in place of the RPC URL, which may hold an API key, in an error and its causes', async () => {
    const rpcUrl = 'https://rpc.example.org/v1?apiKey=SECRET';
    const h = harness({ ...ENV, QUORUM_RPC_URL: rpcUrl });
    const cause = new Error(`${rpcUrl} answered 502 Bad Gateway`);
    h.modules.runSetup.mockRejectedValue(new Error(`could not read from ${rpcUrl}`, { cause }));
    expect(await runCli(['setup'], h.cli)).toBe(1);
    expect(h.err).toEqual(['could not read from QUORUM_RPC_URL (QUORUM_RPC_URL answered 502 Bad Gateway)']);
    expect(h.err.join('\n')).not.toContain('SECRET');
  });

  it('prints a thrown value that is not an Error as it is', async () => {
    const h = harness();
    h.modules.runSetup.mockImplementation(() => Promise.reject('stopped'));
    expect(await runCli(['setup'], h.cli)).toBe(1);
    expect(h.err).toEqual(['stopped']);
  });
});

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs `node src/main.ts <args>` with `env` added to this process's environment. */
function runMain(args: string[], env: Record<string, string> = {}): Promise<Run> {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [MAIN, ...args], { env: { ...process.env, ...env }, timeout: 30_000 }, (_, stdout, stderr) =>
      resolve({ code: child.exitCode, stdout, stderr }),
    );
  });
}

describe('main, as a process', () => {
  it('exits 2 with the usage on stderr for an unknown command', async () => {
    const { code, stdout, stderr } = await runMain(['deploy']);
    expect(code).toBe(2);
    expect(stdout).toBe('');
    expect(stderr).toContain(USAGE);
  });

  it('exits 0 with the usage on stdout for help', async () => {
    const { code, stdout } = await runMain(['help']);
    expect(code).toBe(0);
    expect(stdout).toBe(`${USAGE}\n`);
  });

  it('exits 1 on an invalid configuration, which the environment sets over apps/swarm/.env', async () => {
    const { code, stdout, stderr } = await runMain(['setup'], { QUORUM_NETWORK: 'near:mainnet' });
    expect(code).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('QUORUM_NETWORK must be near:testnet or near:sandbox, got "near:mainnet"');
  });
});
