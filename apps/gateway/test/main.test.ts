import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KeyPair } from 'near-api-js';
import { afterEach, describe, expect, it } from 'vitest';
import { generateCredentialJwk } from '../src/credential.ts';

const MAIN = fileURLToPath(new URL('../src/main.ts', import.meta.url));
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
 * each request as `answer` says for its method, given that URL. Returns the URL and its host.
 */
async function rpcStub(answer: (method: string, url: string) => Answer): Promise<{ url: string; host: string }> {
  let url = '';
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString()));
    request.on('end', () => {
      const { id, method } = JSON.parse(body) as { id: unknown; method: string };
      const reply = answer(method, url);
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

/**
 * Runs `node src/main.ts` in a new folder, against the RPC at `rpcUrl`, with a configuration that
 * loads. None of this process's QUORUM_* variables reaches it, and no .env file is read.
 */
async function runGateway(rpcUrl: string): Promise<Run> {
  const dir = await mkdtemp(join(tmpdir(), 'quorum-gateway-main-'));
  folders.push(dir);
  const inherited = Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith('QUORUM_'));
  const env = {
    ...Object.fromEntries(inherited),
    QUORUM_RPC_URL: rpcUrl,
    QUORUM_PARENT_ACCOUNT: 'parent.testnet',
    QUORUM_RELAYER_KEYS: KeyPair.fromRandom('ed25519').toString(),
    QUORUM_CREDENTIAL_JWK: CREDENTIAL_JWK,
    QUORUM_WEB_DIR: '',
    QUORUM_DATA_DIR: dir,
  };
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [MAIN], { env, cwd: dir, timeout: 30_000 }, (_, stdout, stderr) =>
      resolve({ code: child.exitCode, stdout, stderr }),
    );
  });
}

// near-api-js retries an HTTP 500, 503 or 408 for about 85 seconds, so the stubs answer none of them.
describe('main', () => {
  it('names the RPC by its host alone when it answers the chain id with HTTP 502, which near-api-js reports with its URL', async () => {
    const { url, host } = await rpcStub(() => 502);
    const { code, stdout, stderr } = await runGateway(url);
    expect(code).toBe(1);
    expect(stderr).toContain(`cannot read the chain id from the RPC at ${host}: QUORUM_RPC_URL Bad Gateway`);
    expect(stdout).not.toMatch(KEY);
    expect(stderr).not.toMatch(KEY);
  });

  it('names the RPC by its host alone when its error to the chain id quotes its URL', async () => {
    const { url, host } = await rpcStub((_method, self) => internalError(self));
    const { code, stdout, stderr } = await runGateway(url);
    expect(code).toBe(1);
    expect(stderr).toContain(`cannot read the chain id from the RPC at ${host}: node behind QUORUM_RPC_URL failed`);
    expect(stdout).not.toMatch(KEY);
    expect(stderr).not.toMatch(KEY);
  });

  it("names the RPC URL by its variable when the RPC's error to the token read quotes it", async () => {
    const { url } = await rpcStub((method, self) => (method === 'status' ? { result: { chain_id: 'testnet' } } : internalError(self)));
    const { code, stdout, stderr } = await runGateway(url);
    expect(code).toBe(1);
    expect(stderr).toContain('cannot read the token of pools.parent.testnet: node behind QUORUM_RPC_URL failed');
    expect(stdout).not.toMatch(KEY);
    expect(stderr).not.toMatch(KEY);
  });
});
