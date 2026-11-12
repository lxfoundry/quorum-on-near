import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { ConfigError, type Env } from '@quorum-on-near/buyer';
import { describe, expect, it } from 'vitest';
import { loadMcpConfig, type McpConfig } from '../src/config.ts';

const EXAMPLE = fileURLToPath(new URL('../.env.example', import.meta.url));
/** The repository root. */
const REPO_ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const PARENT = 'parent.testnet';
const ABSOLUTE = resolve('/var/lib/quorum');

/** The one required variable, plus `overrides` (`undefined` unsets one). */
function env(overrides: Env = {}): Env {
  return { QUORUM_PARENT_ACCOUNT: PARENT, ...overrides };
}

/** The problem lines of the ConfigError that loadMcpConfig throws for `vars`. */
function problems(vars: Env): readonly string[] {
  try {
    loadMcpConfig(vars);
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
  throw new Error('loadMcpConfig accepted the configuration');
}

describe('loadMcpConfig', () => {
  it('applies every default when only the parent account is set', () => {
    expect(loadMcpConfig(env())).toEqual<McpConfig>({
      network: 'near:testnet',
      rpcUrl: 'https://test.rpc.fastnear.com',
      gatewayUrl: 'http://localhost:8402',
      parent: PARENT,
      token: '3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af',
      poolsContract: 'pools.parent.testnet',
      blockTimeMs: 1000,
      maxTimeoutSeconds: 120,
      mcpAccount: 'buyer-llm.parent.testnet',
      credentialsDir: join(homedir(), '.near-credentials'),
      spendCap: 10_000n,
      spendFile: join(REPO_ROOT, 'data', 'mcp-spend.json'),
    });
  });

  it('reads its own variables when they are set', () => {
    const config = loadMcpConfig(
      env({
        QUORUM_MCP_ACCOUNT: 'agent.example.testnet',
        QUORUM_CREDENTIALS_DIR: join(ABSOLUTE, 'keys'),
        QUORUM_MCP_SPEND_CAP: '2500',
        QUORUM_MCP_SPEND_FILE: join(ABSOLUTE, 'spend.json'),
      }),
    );
    expect(config).toMatchObject({
      mcpAccount: 'agent.example.testnet',
      credentialsDir: join(ABSOLUTE, 'keys'),
      spendCap: 2500n,
      spendFile: join(ABSOLUTE, 'spend.json'),
    });
  });

  it('reads the buyer settings it shares with the gateway', () => {
    const config = loadMcpConfig(
      env({
        QUORUM_NETWORK: 'near:sandbox',
        QUORUM_GATEWAY_URL: 'http://127.0.0.1:9000/',
        QUORUM_BLOCK_TIME_MS: '600',
        QUORUM_BUYER_MAX_TIMEOUT_SECONDS: '240',
      }),
    );
    expect(config).toMatchObject({ network: 'near:sandbox', gatewayUrl: 'http://127.0.0.1:9000', blockTimeMs: 600, maxTimeoutSeconds: 240 });
  });

  it('accepts a spend cap of 0, which refuses every payment', () => {
    expect(loadMcpConfig(env({ QUORUM_MCP_SPEND_CAP: '0' })).spendCap).toBe(0n);
  });

  it('lists every invalid variable at once, the shared ones first', () => {
    expect(
      problems({
        QUORUM_NETWORK: 'near:mainnet',
        QUORUM_MCP_ACCOUNT: 'Buyer LLM',
        QUORUM_CREDENTIALS_DIR: '~/.near-credentials',
        QUORUM_MCP_SPEND_CAP: '0.01',
        QUORUM_MCP_SPEND_FILE: 'data/mcp-spend.json',
      }),
    ).toEqual([
      'QUORUM_NETWORK must be near:testnet or near:sandbox, got "near:mainnet"',
      'QUORUM_PARENT_ACCOUNT is required',
      'QUORUM_MCP_ACCOUNT must be a NEAR account id, got "Buyer LLM"',
      'QUORUM_CREDENTIALS_DIR must be an absolute path, got "~/.near-credentials"',
      'QUORUM_MCP_SPEND_FILE must be an absolute path, got "data/mcp-spend.json"',
      'QUORUM_MCP_SPEND_CAP must be an amount in base units (decimal digits, such as 10000), got "0.01"',
    ]);
  });

  it('ships an example file whose values, once the parent is filled in, are the defaults', async () => {
    const example = parseEnv(await readFile(EXAMPLE, 'utf8'));
    expect(loadMcpConfig({ ...example, ...env() })).toEqual(loadMcpConfig(env()));
  });

  it('ships an example file that lists exactly the variables loadMcpConfig reads', async () => {
    const read = new Set<string>();
    const tracked = new Proxy(env(), {
      get: (target, name) => {
        if (typeof name === 'string') read.add(name);
        return Reflect.get(target, name);
      },
    });
    loadMcpConfig(tracked);
    const listed = [...(await readFile(EXAMPLE, 'utf8')).matchAll(/^#?(QUORUM_[A-Z_]+)=/gm)].map((m) => m[1]);
    expect(listed.sort()).toEqual([...read].sort());
  });
});
