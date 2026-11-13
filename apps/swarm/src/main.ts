// The swarm's command line: `node src/main.ts <command>` (see USAGE). It reads QUORUM_* variables
// from the environment and from apps/swarm/.env, wherever it is started from.
import { userInfo } from 'node:os';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ConfigError,
  describeError,
  GatewayClient,
  redact,
  RpcBuyerChain,
  RpcPoolReads,
  type BuyerChainReads,
  type Env,
  type PoolReads,
} from '@quorum-on-near/buyer';
import { JsonRpcProvider } from 'near-api-js';
import { systemRuntime, type AgentRuntime, type BuyerOutcome } from './buyer-agent.ts';
import { checkChain, type SwarmChain } from './chain.ts';
import { checkPool, snapshot, type CheckReport } from './check.ts';
import { loadSwarmConfig, type SwarmConfig } from './config.ts';
import { aclNotice, envFilePath, writeGatewayEnv, writeMcpEnv, type EnvApp } from './env-files.ts';
import { createRpcSeedChain, keysFromSeed, parentPublicKey, readSeedPhrase, type SeedChain } from './keys-from-seed.ts';
import { lockFilePath, takeLock, type SwarmLock } from './lock.ts';
import { assertNoPoolOpen, openPool } from './provider.ts';
import { runReset } from './reset.ts';
import { createRpcSwarmChain } from './rpc-chain.ts';
import { runSwarm, unexpectedOutcomes } from './run.ts';
import { isScenarioName, scenario, type Scenario, type ScenarioName } from './scenarios.ts';
import { runSetup } from './setup.ts';
import { count } from './words.ts';

/** A command line of the swarm, parsed. */
export type SwarmCommand =
  | { name: 'setup' }
  | { name: 'open'; scenario: ScenarioName }
  | { name: 'run'; poolId: number; scenario: ScenarioName }
  | { name: 'check'; poolId: number; scenario: ScenarioName }
  | { name: 'demo'; scenario: ScenarioName }
  | { name: 'env'; app: EnvApp }
  | { name: 'keys'; parentKey: boolean; gatewayEnv: string | null }
  | { name: 'reset' }
  | { name: 'help' };

/** Each command's arguments and what it does, in the order USAGE lists them. */
const COMMANDS: Record<SwarmCommand['name'], { synopsis: string; does: string }> = {
  setup: { synopsis: 'setup', does: 'create, fund and register every account; sends nothing when all is in place' },
  open: { synopsis: 'open <fills|fails>', does: "open the scenario's pool as the provider" },
  run: { synopsis: 'run <pool-id> <fills|fails>', does: 'run the 20 scripted buyers against the pool, or resume them on it' },
  check: { synopsis: 'check <pool-id> <fills|fails>', does: 'wait until the pool has ended, then check what the chain holds' },
  demo: { synopsis: 'demo <fills|fails>', does: 'setup, open, run, then check against the balances read before the pool opened' },
  env: { synopsis: 'env <gateway|mcp>', does: 'write apps/<gateway|mcp>/.env from this configuration, never over a file' },
  keys: {
    synopsis: 'keys from-seed [--gateway-env <path> | --parent-key]',
    does: "write every missing key file from one seed phrase; --gateway-env also writes the gateway's keys, --parent-key prints the parent's key only",
  },
  reset: { synopsis: 'reset', does: "send each buyer's and the provider's surplus back to the funding account" },
  help: { synopsis: 'help', does: 'print this text' },
};

/** What `swarm help` prints, and what a usage error prints after the problem. */
export const USAGE = [
  'usage: swarm <command>',
  '',
  ...Object.values(COMMANDS).map(({ synopsis, does }) => `  ${synopsis.padEnd(30)} ${does}`),
  '',
  'swarm run on a pool that buyers have paid in resumes them: each asks the gateway what it holds',
  'before it pays, and a buyer that holds seats in the pool follows them and never buys again.',
  '',
  'swarm keys from-seed derives every key from one BIP-39 phrase, read from QUORUM_SEED_PHRASE or from',
  'the file QUORUM_SEED_PHRASE_FILE names (set one of them), checks the keys against the chain, then',
  'writes each missing key file under QUORUM_CREDENTIALS_DIR. It never writes over a file that holds',
  'something else, and never prints the phrase or a private key: one line per key, the account and its',
  'public key.',
  '',
  'The configuration is read from QUORUM_* variables, set in the environment or in apps/swarm/.env',
  '(see apps/swarm/.env.example). Exits with 0 when done, 1 when a command or a check failed, and 2',
  'for a usage error. run and demo also exit with 1 when a buyer did not end as the scenario expects,',
  'each such buyer named on stderr: a buyer whose top price is at or above the seat price ends with a',
  'credential or misses the pool in fills, and is refunded in fails; any other buyer holds no seats.',
].join('\n');

/** A command line that names no command, an unknown one, or wrong arguments. */
export class UsageError extends Error {
  override name = 'UsageError';
}

/** The arguments a command takes, as a tuple of their count. */
type Args<N extends 0 | 1 | 2> = N extends 0 ? [] : N extends 1 ? [string] : [string, string];

/** A pool id as the contract numbers pools: a non-negative integer, in decimal digits. */
const POOL_ID = /^(0|[1-9][0-9]*)$/;

/**
 * Parses the arguments after `swarm`. Each command takes exactly its arguments; `--help` and `-h`
 * are `help`. Throws UsageError naming the problem.
 */
export function parseCommand(argv: readonly string[]): SwarmCommand {
  const [name, ...args] = argv;
  switch (name) {
    case undefined:
      throw new UsageError('no command given');
    case 'help':
    case '--help':
    case '-h':
      argsOf('help', args, 0);
      return { name: 'help' };
    case 'setup':
    case 'reset':
      argsOf(name, args, 0);
      return { name };
    case 'open':
    case 'demo': {
      const [scenarioName] = argsOf(name, args, 1);
      return { name, scenario: scenarioArg(scenarioName) };
    }
    case 'run':
    case 'check': {
      const [poolId, scenarioName] = argsOf(name, args, 2);
      return { name, poolId: poolIdArg(poolId), scenario: scenarioArg(scenarioName) };
    }
    case 'env': {
      const [app] = argsOf(name, args, 1);
      return { name, app: appArg(app) };
    }
    case 'keys':
      return keysArgs(args);
    default:
      throw new UsageError(`unknown command ${JSON.stringify(name)}`);
  }
}

function argsOf<N extends 0 | 1 | 2>(name: SwarmCommand['name'], args: readonly string[], count: N): Args<N> {
  if (args.length !== count) throw new UsageError(`wrong arguments: the command is swarm ${COMMANDS[name].synopsis}`);
  return args as Args<N>;
}

/**
 * `keys from-seed`, then nothing, `--parent-key`, or `--gateway-env` and an absolute path. The file
 * holds the gateway's secrets, so a relative path, or a flag taken for one, is refused rather than
 * written in the current folder, where no ignore file covers it.
 */
function keysArgs(args: readonly string[]): SwarmCommand {
  const [action, option, path, ...rest] = args;
  const synopsis = `the command is swarm ${COMMANDS.keys.synopsis}`;
  if (action === 'from-seed' && rest.length === 0) {
    if (option === undefined) return { name: 'keys', parentKey: false, gatewayEnv: null };
    if (option === '--parent-key' && path === undefined) return { name: 'keys', parentKey: true, gatewayEnv: null };
    if (option === '--gateway-env' && path !== undefined && path !== '') {
      if (isAbsolute(path)) return { name: 'keys', parentKey: false, gatewayEnv: path };
      throw new UsageError(`wrong arguments: the path after --gateway-env must be absolute, got ${JSON.stringify(path)}; ${synopsis}`);
    }
  }
  throw new UsageError(`wrong arguments: ${synopsis}`);
}

function scenarioArg(raw: string): ScenarioName {
  if (isScenarioName(raw)) return raw;
  throw new UsageError(`the scenario must be fills or fails, got ${JSON.stringify(raw)}`);
}

function poolIdArg(raw: string): number {
  const id = Number(raw);
  if (POOL_ID.test(raw) && Number.isSafeInteger(id)) return id;
  throw new UsageError(`the pool id must be a non-negative integer, got ${JSON.stringify(raw)}`);
}

function appArg(raw: string): EnvApp {
  if (raw === 'gateway' || raw === 'mcp') return raw;
  throw new UsageError(`the app must be gateway or mcp, got ${JSON.stringify(raw)}`);
}

/** What the commands talk to, built from the configuration. */
export interface Connections {
  /** Every command's reads and writes on the chain. */
  chain: SwarmChain;
  /** The gateway the scripted buyers pay and redeem through, and whose activity feed the check reads. */
  gateway: Pick<GatewayClient, 'pools' | 'offer' | 'pay' | 'redeem' | 'activity'>;
  /** The reads each scripted buyer signs its payments with. */
  buyerChain: BuyerChainReads;
  /** The pools contract's view of a pool, which `swarm run` reads once for the buyers' deadline and seat price. */
  pools: PoolReads;
}

/** The modules the commands run. */
export interface SwarmModules {
  runSetup: typeof runSetup;
  snapshot: typeof snapshot;
  openPool: typeof openPool;
  runSwarm: typeof runSwarm;
  checkPool: typeof checkPool;
  runReset: typeof runReset;
  writeGatewayEnv: typeof writeGatewayEnv;
  writeMcpEnv: typeof writeMcpEnv;
  keysFromSeed: typeof keysFromSeed;
}

/** The signals that ask a swarm to stop: Ctrl-C, and the stop a supervisor such as the gateway sends. */
export type StopSignal = 'SIGINT' | 'SIGTERM';

const STOP_SIGNALS: readonly StopSignal[] = ['SIGINT', 'SIGTERM'];

/** What runCli works with: the process's environment and output, and what the commands run on. */
export interface Cli {
  /** The variables the configuration is read from. */
  env: Env;
  /** Prints a line on standard output: what the commands report. */
  out: (line: string) => void;
  /** Prints a line on standard error: usage errors, failures and failed checks. */
  err: (line: string) => void;
  /** Builds the connections for a configuration, sending nothing; called by the commands that use the chain. */
  connect: (config: SwarmConfig) => Connections;
  /** Builds the chain reads of `swarm keys from-seed` for a configuration, sending nothing. */
  seedChain: (config: SwarmConfig) => SeedChain;
  /** The clock, timers and randomness of the scripted buyers, and of the check's wait. */
  runtime: AgentRuntime;
  modules: SwarmModules;
  /** The operating system, for what `swarm env gateway` says of the file's access (aclNotice). */
  platform: NodeJS.Platform;
  /** The name of the user the process runs as, read only for aclNotice on Windows. */
  userName: () => string;
  /**
   * Until the function it returns is called, calls `stop` when the process receives SIGINT or
   * SIGTERM, in place of their default, which ends the process at once.
   */
  onStop: (stop: (signal: StopSignal) => void) => () => void;
  /**
   * Sends `signal` to this process. Once onStop's listeners are removed, the signal's default ends
   * the process, so that its parent sees which signal ended it.
   */
  raise: (signal: StopSignal) => void;
}

/**
 * The commands that write to the chain or sign payments: each takes the lock of its network and
 * parent for the time it runs, so that two swarms never act on the same accounts at once.
 */
const LOCKED: ReadonlySet<SwarmCommand['name']> = new Set(['setup', 'open', 'run', 'demo', 'reset']);

/**
 * Runs the command that `argv`, the arguments after `swarm`, names, and returns the exit code: 0
 * when it is done; 1 when the configuration is invalid, the RPC serves another chain than
 * QUORUM_NETWORK names, the command threw, a check failed, or (`run`, `demo`) a buyer did not end as
 * the scenario expects (unexpectedOutcomes); 2 for a usage error, with the usage.
 * `setup`, `open`, `run`, `demo` and `reset` first take the lock of the network and the parent
 * (lockFilePath in QUORUM_SWARM_LOCK_DIR), and remove it when they end, whatever the outcome; while
 * another process holds it, they run nothing and exit with 1, saying that another swarm is running.
 * A lock that cannot be removed is reported on stderr, and does not change the command's result or
 * error. SIGINT or SIGTERM while a command holds its lock removes the lock, stops listening for both,
 * then raises the same signal again, so that the process ends by that signal and its parent sees it
 * (a shell reports 130 or 143; on Windows, a process that signals itself ends with exit code 1); a
 * second signal of the same kind ends it at once. `demo` holds its one lock across its steps. `check`,
 * `env`, `keys` and `help` take none.
 * Every command but `env`, `keys` and `help` checks the RPC's chain before it runs; `keys from-seed`
 * checks it itself, after the configuration's accounts, and `--parent-key` reads no chain and no
 * swarm configuration, only the phrase. An error is printed as
 * its message and its causes', never with a stack, with QUORUM_RPC_URL written in place of the RPC
 * URL.
 */
export async function runCli(argv: readonly string[], cli: Cli): Promise<number> {
  let command: SwarmCommand;
  try {
    command = parseCommand(argv);
  } catch (error) {
    cli.err(`${errorText(error, cli.env.QUORUM_RPC_URL)}\n\n${USAGE}`);
    return 2;
  }
  try {
    return (await execute(command, cli)) ? 0 : 1;
  } catch (error) {
    cli.err(errorText(error, cli.env.QUORUM_RPC_URL));
    return 1;
  }
}

/** Runs a parsed command. False when a check it made failed, or a buyer did not end as the scenario expects. */
async function execute(command: SwarmCommand, cli: Cli): Promise<boolean> {
  if (command.name === 'help') {
    cli.out(USAGE);
    return true;
  }
  const { modules, out: log } = cli;
  if (command.name === 'keys') {
    // The phrase before the configuration: --parent-key needs nothing else, so that it runs before
    // the parent account exists.
    const phrase = await readSeedPhrase(cli.env);
    if (command.parentKey) {
      log(parentPublicKey(phrase));
      return true;
    }
    const keysConfig = loadSwarmConfig(cli.env);
    const deps = { chain: cli.seedChain(keysConfig), log };
    await modules.keysFromSeed(keysConfig, phrase, deps, { gatewayEnv: command.gatewayEnv });
    return true;
  }
  const config = loadSwarmConfig(cli.env);
  if (command.name === 'env') {
    const path = envFilePath(command.app);
    await (command.app === 'gateway' ? modules.writeGatewayEnv : modules.writeMcpEnv)(config, path);
    log(`wrote ${path}`);
    // The gateway's file holds the relayer's keys and the credential key.
    const notice = command.app === 'gateway' ? aclNotice(path, cli.platform, cli.platform === 'win32' ? cli.userName() : '') : null;
    if (notice !== null) log(notice);
    return true;
  }

  if (!LOCKED.has(command.name)) return executeOnChain(command, cli, config);
  const lock = await takeLock(lockFilePath(config.lockDir, config.network, config.parent));
  // One removal, which a stop signal and the command's own end both wait for: a signal that comes
  // while the command's end is removing the lock ends the process only once the file is gone.
  let released: Promise<void> | undefined;
  const release = (): Promise<void> => (released ??= releaseLock(lock, cli));
  // Once the lock is gone, the signal is raised again with no listener of the swarm's left, so that
  // its default ends the process and a supervisor reads the signal, not an exit code.
  const stopListening = cli.onStop((signal) => {
    void release().then(() => {
      stopListening();
      cli.raise(signal);
    });
  });
  try {
    return await executeOnChain(command, cli, config);
  } finally {
    await release();
    stopListening();
  }
}

/**
 * Releases the lock. A lock that cannot be removed is printed on stderr, with what to do about it,
 * instead of thrown: the command's own result or error stands.
 */
async function releaseLock(lock: SwarmLock, cli: Cli): Promise<void> {
  try {
    await lock.release();
  } catch (error) {
    cli.err(`could not remove the lock ${lock.path}: ${errorText(error, cli.env.QUORUM_RPC_URL)}; remove it by hand before running another swarm`);
  }
}

/** Runs a command that reads the chain, once its lock, if it takes one, is held. */
async function executeOnChain(command: Exclude<SwarmCommand, { name: 'help' | 'env' | 'keys' }>, cli: Cli, config: SwarmConfig): Promise<boolean> {
  const { modules, runtime, out: log } = cli;
  const { chain, gateway, buyerChain, pools } = cli.connect(config);
  await checkChain(config.network, chain);
  const runDeps = { gateway, chain: buyerChain, pools, log, runtime };
  const checkDeps = { chain, gateway, now: () => runtime.now(), sleep: (ms: number) => runtime.sleep(ms), log };
  switch (command.name) {
    case 'setup':
      await modules.runSetup(config, { chain, log });
      return true;
    case 'open':
      await modules.openPool(config, { chain, log }, scenario(command.scenario, config));
      return true;
    case 'run': {
      const chosen = scenario(command.scenario, config);
      return asExpected(cli, chosen, await modules.runSwarm(config, runDeps, command.poolId, chosen));
    }
    case 'check': {
      const request = { poolId: command.poolId, scenario: scenario(command.scenario, config) };
      return verdict(cli, await modules.checkPool(config, checkDeps, request));
    }
    case 'demo': {
      const chosen = scenario(command.scenario, config);
      // Refuse before setup tops any account up; openPool checks again just before it sends.
      await assertNoPoolOpen(config, chain);
      log('--- setup');
      await modules.runSetup(config, { chain, log });
      // Read before the pool opens: opening it moves the provider's bonus.
      const baseline = await modules.snapshot(config, chain);
      log(`--- open ${chosen.name}`);
      const { poolId } = await modules.openPool(config, { chain, log }, chosen);
      log(`--- run pool ${poolId}`);
      const outcomes = await modules.runSwarm(config, runDeps, poolId, chosen);
      log(`--- check pool ${poolId}`);
      // A commit whose result was unknown is missing from the feed, but its buyer may have learned it.
      const extraCommits = outcomes.flatMap(({ buyer, txHashes }) => txHashes.map((txHash) => ({ account: buyer, txHash })));
      const checked = verdict(cli, await modules.checkPool(config, checkDeps, { poolId, scenario: chosen, baseline, extraCommits }));
      return asExpected(cli, chosen, outcomes) && checked;
    }
    case 'reset':
      await modules.runReset(config, { chain, log });
      return true;
  }
}

/** Prints how a check went: on stdout when every check passed, else on stderr. True when every check passed. */
function verdict(cli: Cli, report: CheckReport): boolean {
  const checks = count(report.lines.length, 'check');
  if (!report.failed) {
    cli.out(`pool ${report.poolId}: ${checks} passed`);
    return true;
  }
  cli.err(`pool ${report.poolId}: ${report.lines.filter((line) => !line.ok).length} of ${checks} failed`);
  return false;
}

/**
 * Prints on stderr each buyer that did not end as the scenario expects, with what it expects. True
 * when every buyer did.
 */
function asExpected(cli: Cli, chosen: Scenario, outcomes: readonly BuyerOutcome[]): boolean {
  const unexpected = unexpectedOutcomes(chosen, outcomes);
  for (const { name, outcome, expected } of unexpected) {
    const { kind, seats, detail } = outcome;
    cli.err(`${name} ended ${kind} with ${count(seats, 'seat')} (${detail}); ${chosen.name} expects ${expected}`);
  }
  return unexpected.length === 0;
}

/**
 * An error as printed: a ConfigError lists its problems; another error gives its message, then each
 * cause's in brackets, an AggregateError with no message of its own (a refused connection tried on
 * each address of a host) giving what each of its errors says (describeError). Library and RPC
 * messages can quote the RPC URL, which may carry an API key, so `rpcUrl` is written as
 * QUORUM_RPC_URL.
 */
function errorText(error: unknown, rpcUrl: string | undefined): string {
  if (error instanceof ConfigError) return redact(`invalid configuration:\n${error.message}`, rpcUrl);
  return describeError(error, rpcUrl);
}

/** The process's connections: RPC clients of QUORUM_RPC_URL and an HTTP client of QUORUM_GATEWAY_URL. */
function connectRpc(config: SwarmConfig): Connections {
  const provider = new JsonRpcProvider({ url: config.rpcUrl });
  return {
    chain: createRpcSwarmChain(config),
    gateway: new GatewayClient({ gatewayUrl: config.gatewayUrl }),
    buyerChain: new RpcBuyerChain(provider),
    pools: new RpcPoolReads(provider, config.poolsContract),
  };
}

/**
 * Cli's onStop for this process: each stop signal calls `stop` once, and a second one of the same
 * kind gets Node's default, which ends the process at once.
 */
function onStopSignal(stop: (signal: StopSignal) => void): () => void {
  const listeners = STOP_SIGNALS.map((signal) => [signal, () => stop(signal)] as const);
  for (const [signal, listener] of listeners) process.once(signal, listener);
  return () => {
    for (const [signal, listener] of listeners) process.off(signal, listener);
  };
}

/**
 * Loads apps/swarm/.env into the environment when the file exists. process.loadEnvFile keeps every
 * variable that is already set, so the environment wins over the file. False, with the problem on
 * stderr, when the file exists but cannot be read.
 */
function loadEnvFile(): boolean {
  const file = fileURLToPath(new URL('../.env', import.meta.url));
  try {
    process.loadEnvFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    console.error(`cannot read ${file}: ${errorText(error, process.env.QUORUM_RPC_URL)}`);
    return false;
  }
  return true;
}

if (import.meta.main) {
  process.exitCode = loadEnvFile()
    ? await runCli(process.argv.slice(2), {
        env: process.env,
        out: (line) => console.log(line),
        err: (line) => console.error(line),
        connect: connectRpc,
        seedChain: createRpcSeedChain,
        runtime: systemRuntime,
        modules: { runSetup, snapshot, openPool, runSwarm, checkPool, runReset, writeGatewayEnv, writeMcpEnv, keysFromSeed },
        platform: process.platform,
        userName: () => userInfo().username,
        onStop: onStopSignal,
        raise: (signal) => process.kill(process.pid, signal),
      })
    : 1;
}
