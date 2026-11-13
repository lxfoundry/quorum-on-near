import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keyFilePath, writeKeyFile } from '@quorum-on-near/buyer';
import { KeyPair } from 'near-api-js';
import { afterEach, describe, expect, it } from 'vitest';

const MAIN = fileURLToPath(new URL('../src/main.ts', import.meta.url));
const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const MCP_EXAMPLE = fileURLToPath(new URL('../mcp.example.json', import.meta.url));
/** Invalid whatever apps/mcp/.env holds, since a variable set in the environment wins over that file. */
const INVALID = { QUORUM_NETWORK: 'near:mainnet', QUORUM_MCP_SPEND_CAP: 'all' };

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** A configuration that loads, whatever apps/mcp/.env holds, except for the RPC URL. */
const VALID = {
  QUORUM_NETWORK: 'near:testnet',
  QUORUM_PARENT_ACCOUNT: 'parent.testnet',
  QUORUM_GATEWAY_URL: 'http://localhost:8402',
  QUORUM_MCP_SPEND_CAP: '10000',
};

const servers: Server[] = [];
/** Every JSON-RPC request the stubs received: its method and params. */
const received: Array<{ method: string; params: unknown }> = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
  received.splice(0);
});

/**
 * A JSON-RPC endpoint on the loopback interface that answers `status` with `chainId`, when given, and
 * every other request with HTTP 502, which near-api-js reports in an error that quotes the RPC URL.
 * Returns that URL, with an API key in its query, as an RPC provider's may carry one.
 */
async function rpcStub(chainId?: string, metadata?: Record<string, unknown>): Promise<string> {
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString()));
    request.on('end', () => {
      const { id, method, params } = JSON.parse(body) as { id: string; method: string; params: unknown };
      received.push({ method, params });
      const json = (result: unknown): void => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
      };
      if (method === 'status' && chainId !== undefined) {
        json({ chain_id: chainId });
      } else if (method === 'query' && metadata !== undefined) {
        // A call_function answer: the view's JSON as bytes.
        json({ result: [...Buffer.from(JSON.stringify(metadata))], logs: [], block_height: 1, block_hash: '11111111111111111111111111111111' });
      } else {
        response.writeHead(502).end();
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}/?apiKey=TEST-RPC-KEY`;
}

/** Runs `node <args>` with `env` added to this process's environment. */
function run(args: string[], env: Record<string, string>): Promise<Run> {
  return new Promise((resolve) => {
    const options = { env: { ...process.env, ...env }, timeout: 30_000 };
    const child = execFile(process.execPath, args, options, (_, stdout, stderr) =>
      resolve({ code: child.exitCode, stdout, stderr }),
    );
  });
}

/** Starts `node <MAIN>` with `env` added, closes its input, and resolves once it exits. */
function runClosed(env: Record<string, string>): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [MAIN], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end();
  });
}

describe('main', () => {
  it('exits with code 1 on an invalid configuration, listing its problems on stderr and writing nothing to stdout', async () => {
    const { code, stdout, stderr } = await run([MAIN], INVALID);
    expect(code).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('QUORUM_NETWORK must be near:testnet or near:sandbox, got "near:mainnet"');
    expect(stderr).toContain('QUORUM_MCP_SPEND_CAP must be an amount in base units');
  });

  it('names QUORUM_RPC_URL, never its value, when the chain id cannot be read', async () => {
    const url = await rpcStub();
    const { code, stdout, stderr } = await run([MAIN], { ...VALID, QUORUM_RPC_URL: url });
    expect(code).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('cannot read the chain id from QUORUM_RPC_URL: QUORUM_RPC_URL Bad Gateway');
    expect(stderr).not.toContain('TEST-RPC-KEY');
    expect(stderr).not.toContain('127.0.0.1');
  });

  it('exits with code 1 when the RPC serves another chain, before any call_function reaches it', async () => {
    const url = await rpcStub('mainnet');
    const { code, stdout, stderr } = await run([MAIN], { ...VALID, QUORUM_RPC_URL: url });
    expect(code).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('QUORUM_NETWORK is near:testnet, but QUORUM_RPC_URL serves the chain "mainnet", not "testnet"');
    expect(stderr).not.toContain('TEST-RPC-KEY');
    const calls = received.filter(({ method, params }) => method === 'query' && JSON.stringify(params).includes('call_function'));
    expect(calls).toEqual([]);
    expect(received.map(({ method }) => method)).toEqual(['status']);
  });

  it("redacts the RPC URL from the error when the token's metadata cannot be read", async () => {
    const url = await rpcStub('testnet');
    const { code, stderr } = await run([MAIN], { ...VALID, QUORUM_RPC_URL: url });
    expect(code).toBe(1);
    expect(stderr).toContain('cannot read the metadata of the token');
    expect(stderr).toContain('QUORUM_RPC_URL Bad Gateway');
    expect(stderr).not.toContain('TEST-RPC-KEY');
  });

  it('names the gateway by its host alone once started, never QUORUM_GATEWAY_URL, which may carry a key', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'quorum-mcp-main-'));
    try {
      const account = 'buyer-llm.parent.testnet';
      await writeKeyFile(keyFilePath(join(dir, 'keys'), 'near:testnet', account), account, KeyPair.fromRandom('ed25519'));
      const url = await rpcStub('testnet', { spec: 'ft-1.0.0', name: 'USD Coin', symbol: 'USDC', decimals: 6 });
      const { stdout, stderr } = await runClosed({
        ...VALID,
        QUORUM_RPC_URL: url,
        QUORUM_GATEWAY_URL: 'http://127.0.0.1:9402/route/GATEWAY-SECRET',
        QUORUM_CREDENTIALS_DIR: join(dir, 'keys'),
        QUORUM_MCP_SPEND_FILE: join(dir, 'mcp-spend.json'),
      });
      expect(stdout).toBe('');
      expect(stderr).toContain(`quorum-buyer MCP server on stdio: buyer ${account}, gateway 127.0.0.1:9402, `);
      expect(stderr).not.toContain('GATEWAY-SECRET');
      expect(stderr).not.toContain('TEST-RPC-KEY');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('is what the command in mcp.example.json starts, with the repository as the project folder', async () => {
    const config = JSON.parse(await readFile(MCP_EXAMPLE, 'utf8')) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    const server = config.mcpServers['quorum-buyer'];
    expect(server?.command).toBe('node');
    const args = (server?.args ?? []).map((arg) => arg.replace('${CLAUDE_PROJECT_DIR:-.}', ROOT));
    const { code, stderr } = await run(args, INVALID);
    expect(code).toBe(1);
    expect(stderr).toContain('QUORUM_NETWORK must be near:testnet or near:sandbox');
  });
});
