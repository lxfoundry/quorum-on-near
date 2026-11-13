import { execFile, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KeyPair } from 'near-api-js';
import { afterEach, describe, expect, it } from 'vitest';
import { TESTNET_USDC } from '../src/config.ts';
import { generateCredentialJwk } from '../src/credential.ts';

const MAIN = fileURLToPath(new URL('../src/main.ts', import.meta.url));
/** The stand-in for the swarm's `demo` command. */
const DEMO_PROGRAM = fileURLToPath(new URL('./fixtures/demo-program.mjs', import.meta.url));
/** The stub RPC's path, which holds a fake key where some providers put a real one. */
const KEY_PATH = '/v2/fake-key-0123456789abcdef/';
/** Any piece of that key. */
const KEY = /fake-key|0123456789abcdef/;
const CREDENTIAL_JWK = JSON.stringify(await generateCredentialJwk());

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** The stub's answer to one JSON-RPC method: an HTTP status with no body, or a JSON-RPC result or error. */
type Answer = number | { result: unknown } | { error: unknown };

const servers: Server[] = [];
const folders: string[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});

/**
 * A JSON-RPC endpoint on the loopback interface, at a URL with KEY_PATH as its path, that answers
 * each request as `answer` says for its method and params, given that URL. Returns the URL and its host.
 */
async function rpcStub(
  answer: (method: string, url: string, params: unknown) => Answer,
): Promise<{ url: string; host: string }> {
  let url = '';
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString()));
    request.on('end', () => {
      const { id, method, params } = JSON.parse(body) as { id: unknown; method: string; params: unknown };
      const reply = answer(method, url, params);
      if (typeof reply === 'number') {
        response.writeHead(reply).end();
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id, ...reply }));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  url = `http://${host}${KEY_PATH}`;
  return { url, host };
}

/** A JSON-RPC INTERNAL_ERROR whose text, the provider's own, quotes `url`: near-api-js makes it its error's message. */
function internalError(url: string): Answer {
  return { error: { name: 'INTERNAL_ERROR', cause: { name: 'INTERNAL_ERROR', info: { error_message: `node behind ${url} failed` } } } };
}

/** The answer to a `call_function` query whose view returns `value`, as the contract's JSON. */
function viewAnswer(value: unknown): Answer {
  const bytes = [...Buffer.from(JSON.stringify(value))];
  return { result: { result: bytes, logs: [], block_height: 1, block_hash: '11111111111111111111111111111111' } };
}

/** A new folder for one gateway, removed after the test. */
async function gatewayFolder(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'quorum-gateway-main-'));
  folders.push(dir);
  return dir;
}

/**
 * The environment of a gateway in `dir` against the RPC at `rpcUrl`: a configuration that loads, with
 * `extra` on top. None of this process's QUORUM_* variables is in it.
 */
function gatewayEnv(rpcUrl: string, dir: string, extra: Record<string, string> = {}): Record<string, string | undefined> {
  const inherited = Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith('QUORUM_'));
  return {
    ...Object.fromEntries(inherited),
    QUORUM_RPC_URL: rpcUrl,
    QUORUM_PARENT_ACCOUNT: 'parent.testnet',
    QUORUM_RELAYER_KEYS: KeyPair.fromRandom('ed25519').toString(),
    QUORUM_CREDENTIAL_JWK: CREDENTIAL_JWK,
    QUORUM_WEB_DIR: '',
    QUORUM_DATA_DIR: dir,
    ...extra,
  };
}

/**
 * Runs `node src/main.ts` in a new folder, against the RPC at `rpcUrl`, with a configuration that
 * loads, until it exits. None of this process's QUORUM_* variables reaches it, and no .env file is read.
 */
async function runGateway(rpcUrl: string): Promise<Run> {
  const dir = await gatewayFolder();
  const env = gatewayEnv(rpcUrl, dir);
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [MAIN], { env, cwd: dir, timeout: 30_000 }, (_, stdout, stderr) =>
      resolve({ code: child.exitCode, stdout, stderr }),
    );
  });
}

/** A port on the loopback interface that was free a moment ago: the gateway's configuration refuses port 0. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** A gateway started with `node src/main.ts`: what it has written so far, and how to stop it. */
interface StartedGateway {
  output: { stdout: string; stderr: string };
  /** Whether it has exited. */
  ended(): boolean;
  /** Ends it with SIGKILL if it is still running, and waits until its output has closed. */
  stop(): Promise<void>;
}

/** Starts `node src/main.ts` in `dir` with `env`; no .env file is read. */
function startGateway(env: Record<string, string | undefined>, dir: string): StartedGateway {
  const child = spawn(process.execPath, [MAIN], { env, cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  const output = { stdout: '', stderr: '' };
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => (output.stdout += chunk));
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (output.stderr += chunk));
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  const ended = (): boolean => child.exitCode !== null || child.signalCode !== null;
  return {
    output,
    ended,
    async stop() {
      if (!ended()) child.kill('SIGKILL');
      await closed;
    },
  };
}

/**
 * Waits until `ready` holds, checking every 50 ms for at most 30 seconds; throws, with the gateway's
 * output, if it does not, or if the gateway ends first.
 */
async function until(gateway: StartedGateway, what: string, ready: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!(await ready())) {
    if (gateway.ended() || Date.now() > deadline) {
      const { stdout, stderr } = gateway.output;
      throw new Error(`the gateway did not ${what}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

// near-api-js retries an HTTP 500, 503 or 408 for about 85 seconds, so the stubs answer none of them.
// Each case's budget is above its child's own timeout, so that a child that is slow to start is killed
// and reported with its output, rather than cut off by the test's timeout.
describe('main', { timeout: 60_000 }, () => {
  it('names the RPC by its host alone when it answers the chain id with HTTP 502, which near-api-js reports with its URL', async () => {
    const { url, host } = await rpcStub(() => 502);
    const { code, stdout, stderr } = await runGateway(url);
    expect(code, stderr).toBe(1);
    expect(stderr).toContain(`cannot read the chain id from the RPC at ${host}: QUORUM_RPC_URL Bad Gateway`);
    expect(stdout).not.toMatch(KEY);
    expect(stderr).not.toMatch(KEY);
  });

  it('names the RPC by its host alone when its error to the chain id quotes its URL', async () => {
    const { url, host } = await rpcStub((_method, self) => internalError(self));
    const { code, stdout, stderr } = await runGateway(url);
    expect(code, stderr).toBe(1);
    expect(stderr).toContain(`cannot read the chain id from the RPC at ${host}: node behind QUORUM_RPC_URL failed`);
    expect(stdout).not.toMatch(KEY);
    expect(stderr).not.toMatch(KEY);
  });

  it("names the RPC URL by its variable when the RPC's error to the token read quotes it", async () => {
    const { url } = await rpcStub((method, self) => (method === 'status' ? { result: { chain_id: 'testnet' } } : internalError(self)));
    const { code, stdout, stderr } = await runGateway(url);
    expect(code, stderr).toBe(1);
    expect(stderr).toContain('cannot read the token of pools.parent.testnet: node behind QUORUM_RPC_URL failed');
    expect(stdout).not.toMatch(KEY);
    expect(stderr).not.toMatch(KEY);
  });
});

describe('main with the demo on', { timeout: 60_000 }, () => {
  /** A demo run's own RPC URL, with a fake key in its path. */
  const DEMO_RPC_URL = 'https://rpc.demo.example/v1/fake-key-0123456789abcdef/';

  it("gives a run QUORUM_DEMO_RPC_URL as its QUORUM_RPC_URL, and names it by its variable in the run's lines on the gateway's output", async () => {
    /** The requests the stub has no answer for. */
    const unexpected: string[] = [];
    const { url } = await rpcStub((method, self, params) => {
      if (method === 'status') return { result: { chain_id: 'testnet' } };
      const view = method === 'query' ? (params as { method_name?: string }).method_name : undefined;
      // The token check at startup, then the pools that the keeper reads and that a run is checked against.
      if (view === 'get_token') return viewAnswer(TESTNET_USDC);
      if (view === 'list_pools') return viewAnswer([]);
      unexpected.push(view ?? method);
      return internalError(self);
    });
    const dir = await gatewayFolder();
    const port = await freePort();
    const gateway = startGateway(
      gatewayEnv(url, dir, {
        QUORUM_GATEWAY_PORT: String(port),
        // The stand-in in describe mode writes its arguments and its QUORUM_* variables, then exits with 0.
        QUORUM_DEMO_COMMAND: JSON.stringify([process.execPath, DEMO_PROGRAM, 'describe']),
        QUORUM_DEMO_RPC_URL: DEMO_RPC_URL,
      }),
      dir,
    );
    const gatewayUrl = `http://127.0.0.1:${port}`;
    try {
      await until(gateway, 'start listening', async () => gateway.output.stdout.includes('gateway listening on'));
      expect(await (await fetch(`${gatewayUrl}/config.json`)).json()).toMatchObject({ demo: true });
      const started = await fetch(`${gatewayUrl}/demo/fills`, { method: 'POST', headers: { 'X-Quorum-Demo': '1' } });
      expect(started.status, gateway.output.stderr).toBe(202);
      await until(gateway, 'end the run with code 0', async () => {
        const status = (await (await fetch(`${gatewayUrl}/demo`)).json()) as { last: { exitCode: number | null } | null };
        // Written once all the run's own lines are forwarded.
        return status.last?.exitCode === 0 && gateway.output.stdout.includes('[demo] the fills run exited with code 0');
      });
    } finally {
      // The run, in describe mode, ends by itself at once.
      await gateway.stop();
    }
    const { stdout, stderr } = gateway.output;
    expect(unexpected).toEqual([]);
    const line = stdout.split('\n').find((text) => text.startsWith('[demo] {'));
    if (line === undefined) throw new Error(`no line from the run in describe mode:\n${stdout}`);
    // Without its own RPC URL, the run would show the gateway's: "QUORUM_RPC_URL":"QUORUM_RPC_URL".
    expect(line).toContain('"QUORUM_RPC_URL":"QUORUM_DEMO_RPC_URL"');
    const described = JSON.parse(line.slice('[demo] '.length)) as { argv: string[]; env: Record<string, string> };
    expect(described.argv).toEqual(['describe', 'fills']);
    // Neither the withheld variables nor QUORUM_DEMO_RPC_URL.
    expect(Object.keys(described.env).sort()).toEqual([
      'QUORUM_DATA_DIR',
      'QUORUM_DEMO_COMMAND',
      'QUORUM_GATEWAY_PORT',
      'QUORUM_PARENT_ACCOUNT',
      'QUORUM_RPC_URL',
      'QUORUM_WEB_DIR',
    ]);
    expect(stdout).not.toMatch(KEY);
    expect(stderr).not.toMatch(KEY);
  });
});
