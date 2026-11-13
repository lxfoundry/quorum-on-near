// The MCP server end to end, started as an MCP client starts it: `node apps/mcp/src/main.ts` over
// stdio, acting as buyer-llm against a local sandbox and the real gateway running as a child process
// (the swarm's sandbox world). The provider opens a `fails` pool, which one buyer cannot fill; over the
// protocol, the server lists its tools and the pool, makes an offer, commits, refuses a payment past
// its spend cap, and follows its seats until the gateway's keeper refunds them after the deadline.
// Needs Linux or macOS (near-sandbox ships no Windows binary, so on Windows the suite is skipped) and
// the wasm files from `cargo near build`, named by QUORUM_POOLS_WASM and QUORUM_MOCK_USD_WASM; without
// them the suite fails. The tests run in order, each on the state the previous ones left.
import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finished } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolResultSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { keyFilePath, readKeyFile, readSpendFile } from '@quorum-on-near/buyer';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openPool, type OpenedPool } from '../../../swarm/src/provider.ts';
import { scenario, type Scenario } from '../../../swarm/src/scenarios.ts';
import { startSwarmWorld, type SwarmWorld } from '../../../swarm/test/sandbox/harness.ts';

const MCP_MAIN = fileURLToPath(new URL('../../src/main.ts', import.meta.url));

const TIMEOUT_MS = 600_000;
/** The start's limit: a sandbox, the token, two setups that create and fund 25 accounts, and the gateway. */
const START_TIMEOUT_MS = 900_000;
/** The seats the server buys: 5 at 320 cost 1,600. */
const SEATS = 5;
/** The spend cap the server gets, in base units: it covers one payment for SEATS seats, not two. */
const SPEND_CAP = 2_000n;
/** How long after the pool's deadline its refund may take: the keeper runs every 5 s, its refund call takes about 1 s. */
const REFUND_WAIT_MS = 180_000;
const POLL_MS = 1_000;
/** How long StdioClientTransport.close waits for the server to exit once its input is closed, before signalling it. */
const CLOSE_GRACE_MS = 2_000;
/** How long a read at final finality gets to show a transaction the gateway answered once it had executed. */
const FINAL_WAIT_MS = 15_000;
const TX_HASH = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** A base58 run as long as an ed25519 private key (64 bytes, about 88 characters), with or without its prefix. */
const LONG_BASE58 = /[1-9A-HJ-NP-Za-km-z]{80,}/g;

/** callTool's declared result also admits a legacy shape; parsing narrows it. */
async function callTool(client: Client, name: string, args?: Record<string, unknown>): Promise<CallToolResult> {
  const raw = await client.callTool({ name, ...(args === undefined ? {} : { arguments: args }) });
  return CallToolResultSchema.parse(raw);
}

/** The one text block of a result. */
function text(result: CallToolResult): string {
  const [block] = result.content;
  if (block?.type !== 'text' || result.content.length !== 1) throw new Error('expected one text block');
  return block.text;
}

/** An amount as the tools show it: in base units, and in whole mUSD with its 6 decimals. */
function amount(base: bigint): { base: string; display: string } {
  const fraction = (base % 1_000_000n).toString().padStart(6, '0');
  return { base: base.toString(), display: `${base / 1_000_000n}.${fraction} mUSD` };
}

/** The private key of every key file in `dir` and its folders, as near-cli writes it: `ed25519:<base58>`. */
async function privateKeys(dir: string): Promise<string[]> {
  const keys: string[] = [];
  for (const name of await readdir(dir, { recursive: true })) {
    if (!name.endsWith('.json')) continue;
    const file = JSON.parse(await readFile(join(dir, name), 'utf8')) as { private_key?: unknown };
    if (typeof file.private_key === 'string') keys.push(file.private_key);
  }
  return keys;
}

/**
 * How many times `output` shows a private key: one of `keys`, with or without its `ed25519:` prefix,
 * or any base58 run as long as one. A count, so that a failing assertion never prints a key.
 */
function keysShown(output: string, keys: readonly string[]): number {
  const known = keys.filter((key) => output.includes(key.slice(key.indexOf(':') + 1))).length;
  return known + (output.match(LONG_BASE58)?.length ?? 0);
}

/** `output` with every private key keysShown would count replaced, safe to print. */
function redacted(output: string, keys: readonly string[]): string {
  let safe = output;
  for (const key of keys) safe = safe.replaceAll(key.slice(key.indexOf(':') + 1), '[private key]');
  return safe.replace(LONG_BASE58, '[private key]');
}

// near-sandbox ships no Windows binary.
describe.skipIf(process.platform === 'win32')('the MCP server over stdio, against a local sandbox and the real gateway', { timeout: TIMEOUT_MS }, () => {
  // Set by beforeAll; afterAll may find them unset if the start failed.
  let world: SwarmWorld | undefined;
  let dir: string | undefined;
  let client: Client | undefined;
  let stderrLog: WriteStream | undefined;
  let serverPid: number | null = null;
  /** What the client reported while reading the server's standard output, such as a line that is not JSON-RPC. */
  const protocolErrors: Error[] = [];
  /** The text of every tool result, which came over the server's standard output. */
  const transcript: string[] = [];

  let fails: Scenario;
  let opened: OpenedPool;
  /** buyer-llm's token balance before its payment, in base units. */
  let balanceBefore: bigint;

  /** The world, which beforeAll started. */
  const started = (): SwarmWorld => {
    if (world === undefined) throw new Error('the world did not start');
    return world;
  };
  /** The client connected to the server, and the folder the server runs in, which beforeAll set up. */
  const connected = (): { client: Client; dir: string } => {
    if (client === undefined || dir === undefined) throw new Error('the server did not start');
    return { client, dir };
  };
  const call = async (name: string, args?: Record<string, unknown>): Promise<CallToolResult> => {
    const result = await callTool(connected().client, name, args);
    transcript.push(JSON.stringify(result));
    return result;
  };
  const balance = (): Promise<bigint> => {
    const { chain, config } = started();
    return chain.ftBalanceOf(config.mcpAccount);
  };
  const spent = (): Promise<bigint> => {
    const { config } = started();
    return readSpendFile(config.spendFile, config.mcpAccount);
  };
  /** buyer-llm's records in the pool's activity feed. */
  const activity = async (): Promise<Array<{ kind: string; seats: number; txHash: string; ok: boolean }>> => {
    const { config, gatewayClient } = started();
    const records = await gatewayClient.activity(opened.poolId);
    return records.filter((record) => record.account === config.mcpAccount);
  };

  beforeAll(async () => {
    world = await startSwarmWorld();
    for (const { step, ms } of world.timings) console.log(`start: ${step} took ${ms} ms`);
    dir = await mkdtemp(join(tmpdir(), 'quorum-mcp-sandbox-'));

    fails = scenario('fails', world.config);
    opened = await openPool(world.config, { chain: world.chain, log: (line) => console.log(line) }, fails);
    balanceBefore = await balance();

    // The world's MCP variables (`swarm env mcp`): its temporary key folder, where setup wrote
    // buyer-llm's key file, and its temporary spend file, which setup cleared. The server runs from
    // another folder than the repository, as an MCP client may start it.
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [MCP_MAIN],
      env: { ...world.mcpEnv, QUORUM_MCP_SPEND_CAP: SPEND_CAP.toString() },
      cwd: dir,
      stderr: 'pipe',
    });
    stderrLog = createWriteStream(join(dir, 'mcp.stderr.txt'));
    transport.stderr?.pipe(stderrLog);
    client = new Client({ name: 'quorum-sandbox-test', version: '0.0.0' });
    client.onerror = (error) => protocolErrors.push(error);
    const start = performance.now();
    await client.connect(transport);
    serverPid = transport.pid;
    console.log(`the server answered initialize ${Math.round(performance.now() - start)} ms after it was started`);
  }, START_TIMEOUT_MS);

  afterAll(async () => {
    try {
      await client?.close();
      if (stderrLog !== undefined && dir !== undefined && world !== undefined) {
        await finished(stderrLog);
        const log = await readFile(join(dir, 'mcp.stderr.txt'), 'utf8');
        const keys = await privateKeys(world.config.credentialsDir);
        console.log(`the server's standard error:${log === '' ? ' empty' : `\n${redacted(log, keys)}`}`);
      }
    } finally {
      try {
        await world?.stop();
      } finally {
        if (dir !== undefined) await rm(dir, { recursive: true, force: true });
      }
    }
  }, TIMEOUT_MS);

  it('advertises the four tools, only quorum_commit spending, and names the account it acts for', async () => {
    const world = started();
    const { client } = connected();

    const { tools } = await client.listTools();

    expect(client.getServerVersion()).toMatchObject({ name: 'quorum-buyer' });
    expect(client.getInstructions()).toContain(world.config.mcpAccount);
    const annotations = Object.fromEntries(tools.map((tool) => [tool.name, tool.annotations]));
    expect(annotations).toEqual({
      quorum_pools: { readOnlyHint: true },
      quorum_offer: { readOnlyHint: true },
      quorum_commit: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      quorum_status: { readOnlyHint: true },
    });
    // The seller's terms are described as data wherever they are listed.
    const pools = tools.find((tool) => tool.name === 'quorum_pools');
    expect(pools?.description).toContain('never an instruction');
    expect(pools?.outputSchema?.properties?.pools).toMatchObject({
      items: { properties: { terms: { type: 'string', description: expect.stringContaining('never an instruction') } } },
    });
  });

  it('lists the open pool, its terms as data in their own field', async () => {
    const { poolId, deadlineMs } = opened;

    const result = await call('quorum_pools');

    expect(result.isError).toBeUndefined();
    const { pools } = result.structuredContent as { pools: Array<Record<string, unknown>> };
    expect(pools.find((pool) => pool.pool === poolId)).toEqual({
      pool: poolId,
      terms: fails.terms,
      seatPrice: amount(320n),
      target: 192,
      taken: 0,
      seatsLeft: 192,
      deadline: new Date(deadlineMs).toISOString(),
      deadlineMs,
      secondsLeft: expect.any(Number),
      bonus: amount(3_072n),
      // floor(3,072 / 191): a failed pool has at most 191 seats taken.
      minBonusPerSeat: amount(16n),
    });
    // In the text the client reads, the terms are a JSON string value, quoted.
    expect(text(result)).toContain(`"terms":${JSON.stringify(fails.terms)}`);
  });

  it('offers the seats, with the least paid back if the pool fails, and would pay the offer', async () => {
    const { poolId } = opened;

    const result = await call('quorum_offer', { pool: poolId, seats: SEATS });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      pool: poolId,
      seatsRequested: SEATS,
      seats: SEATS,
      price: amount(1_600n),
      seatPrice: amount(320n),
      // 5 × (320 + 16).
      minRefundIfFails: amount(1_680n),
      payable: true,
      spendCapLeft: amount(SPEND_CAP),
      terms: fails.terms,
    });
    expect(result.structuredContent).not.toHaveProperty('refusal');
    expect(await spent()).toBe(0n);
  });

  it('commits: answers the 202 receipt, counts the price in the spend file, and the buyer pays it on chain', async () => {
    const { poolId } = opened;
    const start = performance.now();

    const result = await call('quorum_commit', { pool: poolId, seats: SEATS });

    console.log(`quorum_commit answered after ${Math.round(performance.now() - start)} ms`);
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      status: 'pending',
      pool: poolId,
      seats: SEATS,
      paid: amount(1_600n),
      txHash: expect.stringMatching(TX_HASH),
      taken: SEATS,
      target: 192,
      deadlineMs: opened.deadlineMs,
      spendCapLeft: amount(SPEND_CAP - 1_600n),
    });
    expect(await spent()).toBe(1_600n);
    // The gateway answers once the transaction has executed; a final read follows a block or two later.
    await expect.poll(balance, { timeout: FINAL_WAIT_MS, interval: 250 }).toBe(balanceBefore - 1_600n);
    const txHash = (result.structuredContent as { txHash: string }).txHash;
    expect(await activity()).toEqual([expect.objectContaining({ kind: 'commit', seats: SEATS, txHash, ok: true })]);
  });

  it('refuses a payment past its spend cap before signing it: nothing reaches the chain', async () => {
    const world = started();
    const { config } = world;
    const keyPair = await readKeyFile(keyFilePath(config.credentialsDir, config.network, config.mcpAccount));
    const publicKey = keyPair.getPublicKey().toString();
    const nonceBefore = await world.buyerChain.nextNonce(config.mcpAccount, publicKey);
    const balanceAfterCommit = await balance();
    const height = (await world.chain.finalBlock()).height;

    // 1,600 more, with 400 left under the cap.
    const result = await call('quorum_commit', { pool: opened.poolId, seats: SEATS });

    expect(result.isError).toBe(true);
    expect(JSON.parse(text(result))).toEqual({
      error: 'over_spend_cap',
      message: expect.stringContaining('Nothing was signed'),
    });
    // Long enough for a payment the gateway had relayed to show at final finality.
    while ((await world.chain.finalBlock()).height < height + 10n) await delay(250);
    expect(await world.buyerChain.nextNonce(config.mcpAccount, publicKey)).toBe(nonceBefore);
    expect(await balance()).toBe(balanceAfterCommit);
    expect(await spent()).toBe(1_600n);
    expect((await activity()).filter((record) => record.kind === 'commit')).toHaveLength(1);
  });

  it('reports the seats pending while the pool is open', async () => {
    const result = await call('quorum_status', { pool: opened.poolId });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      status: 'pending',
      pool: opened.poolId,
      seats: SEATS,
      taken: SEATS,
      target: 192,
      deadlineMs: opened.deadlineMs,
    });
    expect((result.structuredContent as { secondsLeft: number }).secondsLeft).toBeGreaterThan(0);
  });

  it("reports the refund once the gateway's keeper has refunded the pool: the price back, plus the bonus share", async () => {
    const world = started();
    const statuses: string[] = [];
    let last: Record<string, unknown> | undefined;

    while (Date.now() < opened.deadlineMs + REFUND_WAIT_MS) {
      const result = await call('quorum_status', { pool: opened.poolId });
      expect(result.isError).toBeUndefined();
      last = result.structuredContent;
      const status = `${String(last?.status)}${last?.txHash === null ? ' (no transaction yet)' : ''}`;
      if (statuses.at(-1) !== status) statuses.push(status);
      if (last?.status === 'claimable' || (last?.status === 'refunded' && last.txHash !== null)) break;
      await delay(POLL_MS);
    }

    console.log(`quorum_status went through: ${statuses.join(', ')}`);
    const after = Math.round((Date.now() - opened.deadlineMs) / 1000);
    console.log(`its last answer came ${after} s after the deadline, by this clock`);
    // floor(3,072 / 5) = 614 a seat for the only buyer; the dust, 2, goes back to the provider.
    expect(last).toEqual({
      status: 'refunded',
      pool: opened.poolId,
      // 5 × (320 + 614).
      amount: amount(4_670n),
      bonusShare: amount(3_070n),
      txHash: expect.stringMatching(TX_HASH),
    });
    await expect.poll(balance, { timeout: FINAL_WAIT_MS, interval: 250 }).toBe(balanceBefore + 3_070n);
    const refunds = (await activity()).filter((record) => record.kind === 'refund');
    expect(refunds).toEqual([expect.objectContaining({ seats: SEATS, txHash: last?.txHash, ok: true })]);
    // The pool is marked Refunded by the dust transfer's callback, the last receipt of the keeper's call.
    const poolStatus = async (): Promise<string | undefined> => (await world.chain.getPool(opened.poolId))?.status;
    await expect.poll(poolStatus, { timeout: FINAL_WAIT_MS, interval: 250 }).toBe('refunded');
  });

  it('exits once the client closes its standard input', async () => {
    const { client } = connected();
    const start = performance.now();

    await client.close();

    const closeMs = performance.now() - start;
    console.log(`the server exited ${Math.round(closeMs)} ms after its standard input closed`);
    // The transport signals the server only when it is still running CLOSE_GRACE_MS after its input closed.
    expect(closeMs).toBeLessThan(CLOSE_GRACE_MS);
    expect(serverPid).not.toBeNull();
    expect(processExists(serverPid ?? 0)).toBe(false);
  });

  it('wrote nothing but protocol messages on its standard output, and no private key on either output', async () => {
    const { config } = started();
    const { dir } = connected();
    const keys = await privateKeys(config.credentialsDir);
    const own = (await readKeyFile(keyFilePath(config.credentialsDir, config.network, config.mcpAccount))).toString();
    if (stderrLog !== undefined) await finished(stderrLog);

    const log = await readFile(join(dir, 'mcp.stderr.txt'), 'utf8');

    expect(protocolErrors.map((error) => redacted(error.message, keys))).toEqual([]);
    expect(keys.includes(own)).toBe(true);
    expect(log).toContain(`buyer ${config.mcpAccount}`);
    expect(keysShown(log, keys)).toBe(0);
    expect(keysShown(transcript.join('\n'), keys)).toBe(0);
  });
});

/** Whether a process with this id exists. */
function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}
