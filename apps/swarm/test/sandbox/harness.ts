// A whole local system for the sandbox tests: a NEAR sandbox holding the mock token, every account
// of the swarm prepared by runSetup, and the real gateway running as a child process. Needs Linux or
// macOS (near-sandbox ships no Windows binary) and the wasm files from `cargo near build`, named by
// QUORUM_POOLS_WASM and QUORUM_MOCK_USD_WASM. Everything it writes (key files, the spend file, the
// gateway's data and logs) goes to one temporary folder, which stop() removes; nothing is written
// into the repository. The sandbox keeps about 15 minutes of history (SANDBOX_GC_EPOCHS), and stop()
// ends it within a bounded time (stopSandbox).
import { ChildProcess, spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import {
  GatewayClient,
  keyFilePath,
  keyFolderPath,
  readKeyFolder,
  RpcBuyerChain,
  writeKeyFile,
  type Env,
} from '@quorum-on-near/buyer';
import { Account, actions, JsonRpcProvider, KeyPair, KeyPairSigner, teraToGas, type KeyPairString } from 'near-api-js';
import { DEFAULT_ACCOUNT_ID, DEFAULT_PRIVATE_KEY, Sandbox } from 'near-sandbox';
import type {
  AccountKey,
  AccountState,
  BlockInfo,
  NewAccount,
  ReadAt,
  SwarmChain,
  TokenTransfer,
  TransferCall,
  TransferCallResult,
  TxOutcome,
} from '../../src/chain.ts';
import { loadSwarmConfig, type SwarmConfig } from '../../src/config.ts';
import { gatewayEnvText, mcpEnvText, newCredentialJwk } from '../../src/env-files.ts';
import { createRpcSwarmChain } from '../../src/rpc-chain.ts';
import { runSetup, type SetupReport } from '../../src/setup.ts';
import { stopSandbox } from './teardown.ts';

/** The repository's root folder, the working folder of the child processes. */
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const SWARM_MAIN = fileURLToPath(new URL('../../src/main.ts', import.meta.url));
const GATEWAY_MAIN = fileURLToPath(new URL('../../../gateway/src/main.ts', import.meta.url));
const WEB_DIR = fileURLToPath(new URL('../../../web/', import.meta.url));

/**
 * The mock token minted to the funding account between the two setup runs, in base units: 10 mUSD.
 * A first setup's top-ups take 220,000 (21 buyers and the provider at 10,000 each); the rest covers
 * the top-ups of every later setup in a test run. One `mint` call creates at most 1,000 mUSD.
 */
export const DEFAULT_MINT = 10_000_000n;

/**
 * The deadline every scenario gets, in seconds, unless a test sets QUORUM_SCENARIO_DEADLINE_SECONDS.
 * The sandbox makes a block about every 125 ms and the gateway relays a commit in under a second, so
 * even when all 14 buyers that accept `fills` arrive at once, its 4 relayer keys have answered them
 * all within about 3 s. 30 s covers the spread, those 3 s and a buyer's retries (2 s, then 4 s) more
 * than twice over, on a slower machine too. A pool that fills settles at once, so only a pool that
 * fails waits for its deadline.
 */
const SANDBOX_DEADLINE_SECONDS = '30';
/**
 * The arrival spread every scenario gets, in seconds, unless a test sets QUORUM_SWARM_SPREAD_SECONDS:
 * long enough that the buyers arrive one after another, as they would over the scenarios' own spread.
 */
const SANDBOX_SPREAD_SECONDS = '5';
/** How often a scripted buyer polls its redemption: 1 s, since sandbox blocks come faster than testnet's. */
const SANDBOX_REDEEM_INTERVAL_MS = '1000';
/**
 * How many epochs of blocks, transactions and state the sandbox keeps: neard's gc_num_epochs_to_keep,
 * 5 by default. A sandbox epoch is 60 blocks of about 125 ms, 7.5 s, so the default keeps about 37 s,
 * and the RPC knows no older transaction: `swarm check` could not measure a run that lasts longer.
 * 120 epochs keep about 15 minutes.
 */
export const SANDBOX_GC_EPOCHS = 120;

/** NEAR given to the mock token's account: its code locks about 1.5 NEAR, and each registration pays its own storage. */
const TOKEN_NEAR = 5_000_000_000_000_000_000_000_000n;
const INIT_GAS = teraToGas(30);
const MINT_GAS = teraToGas(20);
/** How long the gateway gets to answer its first request once started. */
const GATEWAY_START_MS = 30_000;
/** How long a stopped gateway gets to finish its running work before it is killed. */
const GATEWAY_STOP_MS = 15_000;

/** What startSwarmWorld can be asked to do differently. */
export interface SwarmWorldOptions {
  /**
   * Serve apps/web at the gateway's `/` and turn its RPC pass-through on, as a browser looking at the
   * live page needs. Off by default: QUORUM_WEB_DIR is empty and the pass-through off.
   */
  page?: boolean;
  /** Swarm variables set over the world's own, such as QUORUM_SCENARIO_DEADLINE_SECONDS. */
  swarmEnv?: Env;
  /** Gateway variables set over those its env file holds, such as QUORUM_KEEPER_INTERVAL_MS. */
  gatewayEnv?: Env;
  /** The mock token minted to the funding account between the two setup runs; DEFAULT_MINT by default. */
  mint?: bigint;
}

/** One write a CountingChain passed on: the SwarmChain method and the account that signed it. */
export interface WriteRecord {
  method: 'createAccount' | 'transferNear' | 'deployPools' | 'storageDeposits' | 'ftTransfers' | 'ftTransferCall';
  signer: string;
}

/** What one recordSetup run did. */
export interface SetupRun {
  /** The lines runSetup logged, in order. */
  lines: string[];
  /** What runSetup returned; null when it threw. */
  report: SetupReport | null;
  /** What runSetup threw; null when it returned. */
  error: unknown;
  /** The writes it sent through the chain, failed ones included. */
  writes: number;
  /** The parent's NEAR balance before and after the run, at the latest final block, in yoctoNEAR. */
  parentBefore: bigint;
  parentAfter: bigint;
  /** How long the run took, in milliseconds. */
  ms: number;
}

/** The gateway running as a child process. */
export interface GatewayProcess {
  /** Its base URL, `http://127.0.0.1:<port>`: QUORUM_GATEWAY_URL for it and for every buyer. */
  url: string;
  port: number;
  /** The files its standard output and standard error go to, inside the world's temporary folder. */
  stdoutPath: string;
  stderrPath: string;
}

/** A running world, as startSwarmWorld returns it. */
export interface SwarmWorld {
  sandbox: Sandbox;
  /**
   * The swarm's variables in this world: the sandbox network and RPC, the sandbox's root account as
   * the parent, the mock token, the gateway's URL, QUORUM_POOLS_WASM, the temporary key folder and
   * spend file, a shortened deadline, spread and redemption interval, and the options' swarmEnv. It
   * holds paths and account ids, no key. Spawn the real command line with it (runSwarmCli).
   */
  swarmEnv: Readonly<Record<string, string>>;
  /** loadSwarmConfig(swarmEnv). */
  config: SwarmConfig;
  /** The swarm's RPC chain, counting the writes sent through it. */
  chain: CountingChain;
  /** A client of the running gateway. */
  gatewayClient: GatewayClient;
  /** The chain reads a buyer signs its payments with, on the sandbox's RPC. */
  buyerChain: RpcBuyerChain;
  /** The two setup runs of the start: the first stops on the token shortfall, the second completes. */
  setupRuns: readonly [SetupRun, SetupRun];
  /** What was minted to the funding account between them, in base units. */
  minted: bigint;
  gateway: GatewayProcess;
  /**
   * The MCP server's variables for the buyer `buyer-llm.<root>`, as `swarm env mcp` writes them
   * (mcpEnvText, parsed): no key, the server reads its buyer's key file in the temporary key folder.
   */
  mcpEnv: Readonly<Record<string, string>>;
  /** How long each step of the start took, in order, in milliseconds. */
  timings: ReadonlyArray<{ step: string; ms: number }>;
  /**
   * Stops the gateway, stops the sandbox with stopSandbox (killing neard if it has not stopped within
   * SANDBOX_GRACE_MS) and removes the temporary folder. Runs once; later calls wait for it.
   */
  stop(): Promise<void>;
}

/** How a child process ended, with everything it printed. */
export interface ProcessResult {
  /** Its exit code; null when a signal ended it. */
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/**
 * A SwarmChain that passes every call on to another one and records each write before passing it on,
 * so that a test can assert that a command sent nothing.
 */
export class CountingChain implements SwarmChain {
  readonly #inner: SwarmChain;
  readonly #writes: WriteRecord[] = [];

  constructor(inner: SwarmChain) {
    this.#inner = inner;
  }

  /** Every write passed on so far, in order; one that then failed is counted. */
  get writes(): readonly WriteRecord[] {
    return this.#writes;
  }

  chainId(): Promise<string> {
    return this.#inner.chainId();
  }

  account(accountId: string): Promise<AccountState | null> {
    return this.#inner.account(accountId);
  }

  getToken(): Promise<string> {
    return this.#inner.getToken();
  }

  registrationDeposit(): Promise<bigint> {
    return this.#inner.registrationDeposit();
  }

  isRegistered(accountId: string): Promise<boolean> {
    return this.#inner.isRegistered(accountId);
  }

  ftBalanceOf(accountId: string, atHeight?: bigint): Promise<bigint> {
    return this.#inner.ftBalanceOf(accountId, atHeight);
  }

  getPool(poolId: number): ReturnType<SwarmChain['getPool']> {
    return this.#inner.getPool(poolId);
  }

  listPools(from: number, limit: number, at?: ReadAt): ReturnType<SwarmChain['listPools']> {
    return this.#inner.listPools(from, limit, at);
  }

  getSeats(poolId: number, from: number, limit: number, atHeight?: bigint): ReturnType<SwarmChain['getSeats']> {
    return this.#inner.getSeats(poolId, from, limit, atHeight);
  }

  finalBlock(): Promise<BlockInfo> {
    return this.#inner.finalBlock();
  }

  txOutcome(txHash: string, signerId: string): Promise<TxOutcome | null> {
    return this.#inner.txOutcome(txHash, signerId);
  }

  createAccount(signer: AccountKey, account: NewAccount): Promise<TxOutcome> {
    this.#count('createAccount', signer);
    return this.#inner.createAccount(signer, account);
  }

  transferNear(signer: AccountKey, receiverId: string, amount: bigint): Promise<TxOutcome> {
    this.#count('transferNear', signer);
    return this.#inner.transferNear(signer, receiverId, amount);
  }

  deployPools(signer: AccountKey, code: Uint8Array): Promise<TxOutcome> {
    this.#count('deployPools', signer);
    return this.#inner.deployPools(signer, code);
  }

  storageDeposits(signer: AccountKey, accountIds: readonly string[], deposit: bigint): Promise<TxOutcome> {
    this.#count('storageDeposits', signer);
    return this.#inner.storageDeposits(signer, accountIds, deposit);
  }

  ftTransfers(signer: AccountKey, transfers: readonly TokenTransfer[]): Promise<TxOutcome> {
    this.#count('ftTransfers', signer);
    return this.#inner.ftTransfers(signer, transfers);
  }

  ftTransferCall(signer: AccountKey, call: TransferCall): Promise<TransferCallResult> {
    this.#count('ftTransferCall', signer);
    return this.#inner.ftTransferCall(signer, call);
  }

  #count(method: WriteRecord['method'], signer: AccountKey): void {
    this.#writes.push({ method, signer: signer.accountId });
  }
}

/** The wasm files QUORUM_POOLS_WASM and QUORUM_MOCK_USD_WASM name. Throws, naming both, unless both are set. */
export function wasmFromEnv(): { pools: string; mockUsd: string } {
  const { QUORUM_POOLS_WASM: pools, QUORUM_MOCK_USD_WASM: mockUsd } = process.env;
  if (!pools || !mockUsd) {
    throw new Error(
      'set QUORUM_POOLS_WASM and QUORUM_MOCK_USD_WASM to the absolute paths of the pools and mock-usd wasm files that `cargo near build` writes',
    );
  }
  return { pools, mockUsd };
}

/**
 * Stands up a whole world, up to a running gateway:
 * 1. starts a sandbox and deploys the mock token, initialised, at `musd.<root>`;
 * 2. writes the root account's key file into a temporary key folder: the root is the swarm's parent;
 * 3. builds the swarm's configuration (see SwarmWorld.swarmEnv);
 * 4. runs setup, which stops on the token shortfall once it has created and registered every
 *    account; mints `options.mint` to the funding account, as a faucet would; runs setup again;
 * 5. starts the gateway (`node apps/gateway/src/main.ts`) with the variables `swarm env gateway`
 *    writes (gatewayEnvText, never written to a file), on a free port, with a temporary data folder,
 *    and waits until it answers `GET /pools`.
 * The QUORUM_* variables of this process are not passed on: the world's own are. Throws if a step
 * fails, the second setup included, after stopping whatever it had started.
 */
export async function startSwarmWorld(options: SwarmWorldOptions = {}): Promise<SwarmWorld> {
  const wasm = wasmFromEnv();
  const timings: Array<{ step: string; ms: number }> = [];
  const timed = async <T>(step: string, work: () => Promise<T>): Promise<T> => {
    const start = performance.now();
    const result = await work();
    timings.push({ step, ms: Math.round(performance.now() - start) });
    return result;
  };

  const root = await mkdtemp(join(tmpdir(), 'quorum-swarm-sandbox-'));
  let sandbox: Sandbox | undefined;
  let gatewayChild: ChildProcess | undefined;
  const stopAll = async (): Promise<void> => {
    try {
      if (gatewayChild !== undefined) await stopChild(gatewayChild);
    } finally {
      try {
        if (sandbox !== undefined) {
          const { killed } = await stopSandbox(sandbox, neardProcess(sandbox));
          if (killed) console.log('the sandbox did not stop on SIGTERM: neard was killed');
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  };

  try {
    const credentialsDir = join(root, 'keys');
    const gatewayData = join(root, 'gateway-data');
    await mkdir(gatewayData);
    const port = await freePort();
    const gatewayUrl = `http://127.0.0.1:${port}`;

    const started = await timed('start the sandbox', startSandbox);
    sandbox = started;
    const provider = new JsonRpcProvider({ url: started.rpcUrl });
    const rootAccount = new Account(DEFAULT_ACCOUNT_ID, provider, DEFAULT_PRIVATE_KEY);
    const rootKey = KeyPair.fromString(DEFAULT_PRIVATE_KEY as KeyPairString);
    await writeKeyFile(keyFilePath(credentialsDir, 'near:sandbox', DEFAULT_ACCOUNT_ID), DEFAULT_ACCOUNT_ID, rootKey);
    const token = await timed('deploy the mock token', () => deployToken(rootAccount, wasm.mockUsd));

    const swarmEnv: Record<string, string> = {
      QUORUM_NETWORK: 'near:sandbox',
      QUORUM_RPC_URL: started.rpcUrl,
      QUORUM_GATEWAY_URL: gatewayUrl,
      QUORUM_PARENT_ACCOUNT: DEFAULT_ACCOUNT_ID,
      QUORUM_TOKEN_ACCOUNT: token,
      QUORUM_POOLS_WASM: wasm.pools,
      QUORUM_CREDENTIALS_DIR: credentialsDir,
      QUORUM_MCP_SPEND_FILE: join(root, 'mcp-spend.json'),
      QUORUM_SCENARIO_DEADLINE_SECONDS: SANDBOX_DEADLINE_SECONDS,
      QUORUM_SWARM_SPREAD_SECONDS: SANDBOX_SPREAD_SECONDS,
      QUORUM_REDEEM_INTERVAL_MS: SANDBOX_REDEEM_INTERVAL_MS,
      ...definedOnly(options.swarmEnv),
    };
    const config = loadSwarmConfig(swarmEnv);
    const chain = new CountingChain(createRpcSwarmChain(config));

    const first = await timed('first setup', () => recordSetup(config, chain));
    const minted = options.mint ?? DEFAULT_MINT;
    await timed('mint to the funding account', () => mint(rootAccount, token, config.funding, minted));
    const second = await timed('second setup', () => recordSetup(config, chain));
    if (second.error !== null) {
      throw new Error(
        `the second setup failed; the first logged:\n${first.lines.join('\n')}\nand ended with: ${errorText(first.error)}`,
        { cause: second.error },
      );
    }

    const relayerKeys = await readKeyFolder(keyFolderPath(credentialsDir, config.network, config.relayer));
    const gatewayEnv: Record<string, string> = {
      ...definedOnly(parseEnv(gatewayEnvText(config, relayerKeys, newCredentialJwk()))),
      QUORUM_GATEWAY_PORT: String(port),
      QUORUM_DATA_DIR: gatewayData,
      QUORUM_WEB_DIR: options.page === true ? WEB_DIR : '',
      QUORUM_RPC_PASSTHROUGH: options.page === true ? 'true' : 'false',
      ...definedOnly(options.gatewayEnv),
    };
    const gateway: GatewayProcess = {
      url: gatewayUrl,
      port,
      stdoutPath: join(root, 'gateway.stdout.txt'),
      stderrPath: join(root, 'gateway.stderr.txt'),
    };
    await timed('start the gateway', async () => {
      gatewayChild = spawnLogged(GATEWAY_MAIN, [], childEnv(gatewayEnv), gateway);
      await untilAnswers(gatewayChild, gateway);
    });

    let stopping: Promise<void> | undefined;
    return {
      sandbox: started,
      swarmEnv,
      config,
      chain,
      gatewayClient: new GatewayClient({ gatewayUrl }),
      buyerChain: new RpcBuyerChain(new JsonRpcProvider({ url: started.rpcUrl })),
      setupRuns: [first, second],
      minted,
      gateway,
      mcpEnv: definedOnly(parseEnv(mcpEnvText(config))),
      timings,
      stop: () => (stopping ??= stopAll()),
    };
  } catch (error) {
    await stopAll();
    throw error;
  }
}

/** Starts a sandbox that keeps SANDBOX_GC_EPOCHS epochs of history. Stop it with stopSandbox. */
export async function startSandbox(): Promise<Sandbox> {
  return Sandbox.start({ config: { additionalConfig: { gc_num_epochs_to_keep: SANDBOX_GC_EPOCHS } } });
}

/** The neard process a sandbox runs, which near-sandbox keeps in a private field. */
export function neardProcess(sandbox: Sandbox): ChildProcess {
  const child: unknown = sandbox['childProcess'];
  if (!(child instanceof ChildProcess)) throw new TypeError('the sandbox keeps no neard process in childProcess');
  return child;
}

/**
 * Runs setup once through `chain` and records what it did: the lines it logged (also passed to
 * `log`, when given), what it returned or threw, the writes it sent, the parent's NEAR before and
 * after, and how long it took. Never throws for setup's own error: it is in `error`.
 */
export async function recordSetup(config: SwarmConfig, chain: CountingChain, log?: (line: string) => void): Promise<SetupRun> {
  const lines: string[] = [];
  const writesBefore = chain.writes.length;
  const parentBefore = await parentBalance(config, chain);
  const start = performance.now();
  let report: SetupReport | null = null;
  let error: unknown = null;
  try {
    report = await runSetup(config, {
      chain,
      log: (line) => {
        lines.push(line);
        log?.(line);
      },
    });
  } catch (thrown) {
    error = thrown;
  }
  const ms = Math.round(performance.now() - start);
  const parentAfter = await parentBalance(config, chain);
  return { lines, report, error, writes: chain.writes.length - writesBefore, parentBefore, parentAfter, ms };
}

/**
 * Runs the swarm's real command line, `node apps/swarm/src/main.ts <args>`, from the repository's
 * root, with the world's swarmEnv and then `env` as its only QUORUM_* variables. Resolves once it
 * exits, with what it printed; a run longer than `timeoutMs` is killed and resolves with its signal.
 */
export async function runSwarmCli(
  world: Pick<SwarmWorld, 'swarmEnv'>,
  args: readonly string[],
  options: { env?: Env; timeoutMs?: number } = {},
): Promise<ProcessResult> {
  const child = spawn(process.execPath, [SWARM_MAIN, ...args], {
    cwd: REPO_ROOT,
    env: childEnv({ ...world.swarmEnv, ...definedOnly(options.env) }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
  const timer = options.timeoutMs === undefined ? undefined : setTimeout(() => child.kill('SIGKILL'), options.timeoutMs);
  try {
    const [code, signal] = await onceExited(child);
    return { code, signal, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The environment of a child process: this process's variables except every QUORUM_* one, then
 * `vars`. A child configured this way reads only the variables it is given, whatever the shell that
 * started the tests exports.
 */
export function childEnv(vars: Env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.startsWith('QUORUM_')) env[name] = value;
  }
  return { ...env, ...definedOnly(vars) };
}

/** Creates `musd.<root>`, deploys the mock token's code to it and initialises it, in one transaction after the creation. */
async function deployToken(root: Account, wasmFile: string): Promise<string> {
  const id = `musd.${root.accountId}`;
  const keyPair = KeyPair.fromRandom('ed25519');
  await root.signAndSendTransaction({
    receiverId: id,
    actions: [actions.createAccount(), actions.transfer(TOKEN_NEAR), actions.addFullAccessKey(keyPair.getPublicKey())],
    waitUntil: 'FINAL',
  });
  const token = new Account(id, root.provider, new KeyPairSigner(keyPair));
  await token.signAndSendTransaction({
    receiverId: id,
    actions: [actions.deployContract(await readFile(wasmFile)), actions.functionCall('new', {}, INIT_GAS, 0n)],
    waitUntil: 'FINAL',
  });
  return id;
}

/** Mints `amount` of the mock token to `accountId`, which must be registered on it, signed by the root. */
async function mint(root: Account, token: string, accountId: string, amount: bigint): Promise<void> {
  await root.signAndSendTransaction({
    receiverId: token,
    actions: [actions.functionCall('mint', { account_id: accountId, amount: amount.toString() }, MINT_GAS, 0n)],
    waitUntil: 'FINAL',
  });
}

async function parentBalance(config: SwarmConfig, chain: SwarmChain): Promise<bigint> {
  const state = await chain.account(config.parent);
  if (state === null) throw new Error(`the parent account ${config.parent} does not exist`);
  return state.balance;
}

/** A TCP port on 127.0.0.1 that was free a moment ago. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (address === null || typeof address === 'string') throw new Error('the free port probe got no TCP address');
  return address.port;
}

/** Starts `node <script> <args>` from the repository's root, its output going to the gateway's log files. */
function spawnLogged(script: string, args: readonly string[], env: NodeJS.ProcessEnv, logs: GatewayProcess): ChildProcess {
  const out = openSync(logs.stdoutPath, 'w');
  const err = openSync(logs.stderrPath, 'w');
  try {
    return spawn(process.execPath, [script, ...args], { cwd: REPO_ROOT, env, stdio: ['ignore', out, err] });
  } finally {
    // The child holds its own copies of the two descriptors.
    closeSync(out);
    closeSync(err);
  }
}

/**
 * Waits until the gateway answers `GET /pools` with 200, which it does once it has read the chain id
 * and the pools contract's token and listens. Throws, with what it wrote on standard error, if it
 * exits first or does not answer within GATEWAY_START_MS.
 */
async function untilAnswers(child: ChildProcess, gateway: GatewayProcess): Promise<void> {
  let exited = false;
  const exit = onceExited(child).then(() => {
    exited = true;
  });
  const giveUpAt = Date.now() + GATEWAY_START_MS;
  while (!exited && Date.now() < giveUpAt) {
    try {
      const response = await fetch(`${gateway.url}/pools`, { signal: AbortSignal.timeout(2_000) });
      await response.body?.cancel();
      if (response.status === 200) return;
    } catch {
      // Not listening yet.
    }
    await Promise.race([exit, new Promise((resolve) => setTimeout(resolve, 200))]);
  }
  const stderr = await readFile(gateway.stderrPath, 'utf8');
  const why = exited ? `exited with code ${child.exitCode}` : `did not answer within ${GATEWAY_START_MS} ms`;
  throw new Error(`the gateway ${why}; its standard error:\n${stderr}`);
}

/** Asks a child to stop (SIGTERM), kills it if it is still running after GATEWAY_STOP_MS, and waits until it has exited. */
async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = onceExited(child);
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), GATEWAY_STOP_MS);
  try {
    await exited;
  } finally {
    clearTimeout(timer);
  }
}

/** Resolves with `[code, signal]` once the child has exited, at once if it already has. */
function onceExited(child: ChildProcess): Promise<[number | null, NodeJS.Signals | null]> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve([child.exitCode, child.signalCode]);
  return new Promise((resolve) => child.once('exit', (code, signal) => resolve([code, signal])));
}

/** `vars` without its undefined values. */
function definedOnly(vars: Env | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(vars ?? {})) {
    if (value !== undefined) result[name] = value;
  }
  return result;
}

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
