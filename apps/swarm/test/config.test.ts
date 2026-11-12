import { readFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { ConfigError, type Env } from '@quorum-on-near/buyer';
import { describe, expect, it } from 'vitest';
import { loadSwarmConfig, type SwarmConfig } from '../src/config.ts';

const EXAMPLE = fileURLToPath(new URL('../.env.example', import.meta.url));
const GATEWAY_EXAMPLE = fileURLToPath(new URL('../../gateway/.env.example', import.meta.url));
const MCP_EXAMPLE = fileURLToPath(new URL('../../mcp/.env.example', import.meta.url));
/** A variable line of an example file, set or commented out: its name is the first group. */
const VARIABLE = /^#?(QUORUM_[A-Z_]+)=/gm;
const PARENT = 'parent.testnet';

/** The one required variable, plus `overrides` (`undefined` unsets one). */
function env(overrides: Env = {}): Env {
  return { QUORUM_PARENT_ACCOUNT: PARENT, ...overrides };
}

/** The problems loadSwarmConfig lists for `values`, one per line of its ConfigError. */
function problems(values: Env): readonly string[] {
  try {
    loadSwarmConfig(values);
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
  return [];
}

describe('loadSwarmConfig', () => {
  it("applies the defaults when only the parent account is set: the gateway's for the shared variables", () => {
    expect(loadSwarmConfig(env())).toEqual<SwarmConfig>({
      network: 'near:testnet',
      rpcUrl: 'https://test.rpc.fastnear.com',
      gatewayUrl: 'http://localhost:8402',
      parent: PARENT,
      token: '3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af',
      poolsContract: 'pools.parent.testnet',
      blockTimeMs: 1000,
      maxTimeoutSeconds: 120,
      credentialsDir: join(homedir(), '.near-credentials'),
      funding: 'funding.parent.testnet',
      relayer: 'relay.parent.testnet',
      provider: 'provider.parent.testnet',
      mcpAccount: 'buyer-llm.parent.testnet',
      poolsWasm: null,
      relayerKeyCount: 4,
      buyerNear: 50_000_000_000_000_000_000_000n,
      providerNear: 500_000_000_000_000_000_000_000n,
      fundingNear: 500_000_000_000_000_000_000_000n,
      relayerNear: 3_000_000_000_000_000_000_000_000n,
      poolsNear: 3_500_000_000_000_000_000_000_000n,
      poolsFreeNear: 1_000_000_000_000_000_000_000_000n,
      buyerBudget: 10_000n,
      providerBonusFunds: 10_000n,
      commitMinGas: 50_000_000_000_000n,
      commitMaxGas: 100_000_000_000_000n,
      deadlineSeconds: null,
      spreadSeconds: null,
      redeemIntervalMs: 5000,
      spendFile: fileURLToPath(new URL('../../../data/mcp-spend.json', import.meta.url)),
    });
  });

  it('reads every variable that is set', () => {
    const credentialsDir = join(tmpdir(), 'near-keys');
    const poolsWasm = join(tmpdir(), 'quorum_pools.wasm');
    const spendFile = join(tmpdir(), 'spend.json');
    const config = loadSwarmConfig({
      QUORUM_NETWORK: 'near:sandbox',
      QUORUM_RPC_URL: 'http://127.0.0.1:3030',
      QUORUM_GATEWAY_URL: 'http://127.0.0.1:9000/',
      QUORUM_PARENT_ACCOUNT: 'test.near',
      QUORUM_TOKEN_ACCOUNT: 'musd.test.near',
      QUORUM_POOLS_ACCOUNT: 'escrow.test.near',
      QUORUM_BLOCK_TIME_MS: '600',
      QUORUM_BUYER_MAX_TIMEOUT_SECONDS: '240',
      QUORUM_CREDENTIALS_DIR: credentialsDir,
      QUORUM_FUNDING_ACCOUNT: 'treasury.near',
      QUORUM_RELAYER_ACCOUNT: 'gas.test.near',
      QUORUM_PROVIDER_ACCOUNT: 'seller.test.near',
      QUORUM_MCP_ACCOUNT: 'agent.test.near',
      QUORUM_POOLS_WASM: poolsWasm,
      QUORUM_RELAYER_KEY_COUNT: '2',
      QUORUM_BUYER_NEAR: '0.0000001',
      QUORUM_PROVIDER_NEAR: '1',
      QUORUM_FUNDING_NEAR: '2.25',
      QUORUM_RELAYER_NEAR: '10',
      QUORUM_POOLS_NEAR: '5',
      QUORUM_POOLS_FREE_NEAR: '0.25',
      QUORUM_BUYER_BUDGET: '20000',
      QUORUM_PROVIDER_BONUS_FUNDS: '5000',
      QUORUM_COMMIT_MIN_GAS: '40000000000000',
      QUORUM_COMMIT_MAX_GAS: '40000000000000',
      QUORUM_SCENARIO_DEADLINE_SECONDS: '90',
      QUORUM_SWARM_SPREAD_SECONDS: '0',
      QUORUM_REDEEM_INTERVAL_MS: '250',
      QUORUM_MCP_SPEND_FILE: spendFile,
    });
    expect(config).toEqual<SwarmConfig>({
      network: 'near:sandbox',
      rpcUrl: 'http://127.0.0.1:3030',
      gatewayUrl: 'http://127.0.0.1:9000',
      parent: 'test.near',
      token: 'musd.test.near',
      poolsContract: 'escrow.test.near',
      blockTimeMs: 600,
      maxTimeoutSeconds: 240,
      credentialsDir,
      funding: 'treasury.near',
      relayer: 'gas.test.near',
      provider: 'seller.test.near',
      mcpAccount: 'agent.test.near',
      poolsWasm,
      relayerKeyCount: 2,
      buyerNear: 100_000_000_000_000_000n,
      providerNear: 1_000_000_000_000_000_000_000_000n,
      fundingNear: 2_250_000_000_000_000_000_000_000n,
      relayerNear: 10_000_000_000_000_000_000_000_000n,
      poolsNear: 5_000_000_000_000_000_000_000_000n,
      poolsFreeNear: 250_000_000_000_000_000_000_000n,
      buyerBudget: 20_000n,
      providerBonusFunds: 5_000n,
      commitMinGas: 40_000_000_000_000n,
      commitMaxGas: 40_000_000_000_000n,
      deadlineSeconds: 90,
      spreadSeconds: 0,
      redeemIntervalMs: 250,
      spendFile,
    });
  });

  it("names every account after the parent by default, as the gateway's do", () => {
    const config = loadSwarmConfig({ QUORUM_PARENT_ACCOUNT: 'ops.testnet' });
    expect([config.poolsContract, config.funding, config.relayer, config.provider, config.mcpAccount]).toEqual([
      'pools.ops.testnet',
      'funding.ops.testnet',
      'relay.ops.testnet',
      'provider.ops.testnet',
      'buyer-llm.ops.testnet',
    ]);
  });

  it('accepts the parent itself as the funding account', () => {
    expect(loadSwarmConfig(env({ QUORUM_FUNDING_ACCOUNT: PARENT })).funding).toBe(PARENT);
  });

  it('treats an empty QUORUM_POOLS_WASM as unset', () => {
    expect(loadSwarmConfig(env({ QUORUM_POOLS_WASM: '' })).poolsWasm).toBeNull();
  });

  it('collects one problem per invalid variable, naming each value', () => {
    expect(
      problems(
        env({
          QUORUM_CREDENTIALS_DIR: '~/.near-credentials',
          QUORUM_FUNDING_ACCOUNT: 'Funding.testnet',
          QUORUM_RELAYER_ACCOUNT: 'relay..testnet',
          QUORUM_PROVIDER_ACCOUNT: 'provider/x',
          QUORUM_MCP_ACCOUNT: 'llm buyer',
          QUORUM_POOLS_WASM: 'target/quorum_pools.wasm',
          QUORUM_RELAYER_KEY_COUNT: '0',
          QUORUM_BUYER_NEAR: '1e-7',
          QUORUM_PROVIDER_NEAR: '-1',
          QUORUM_FUNDING_NEAR: '.5',
          QUORUM_RELAYER_NEAR: '3 NEAR',
          QUORUM_POOLS_NEAR: '',
          QUORUM_BUYER_BUDGET: '0.01',
          QUORUM_PROVIDER_BONUS_FUNDS: '1e4',
          QUORUM_COMMIT_MIN_GAS: '0',
          QUORUM_COMMIT_MAX_GAS: '300000000000001',
          QUORUM_SCENARIO_DEADLINE_SECONDS: '0',
          QUORUM_SWARM_SPREAD_SECONDS: '2147484',
          QUORUM_REDEEM_INTERVAL_MS: '2147483648',
          QUORUM_MCP_SPEND_FILE: 'data/mcp-spend.json',
        }),
      ),
    ).toEqual([
      'QUORUM_MCP_ACCOUNT must be a NEAR account id, got "llm buyer"',
      'QUORUM_CREDENTIALS_DIR must be an absolute path, got "~/.near-credentials"',
      'QUORUM_MCP_SPEND_FILE must be an absolute path, got "data/mcp-spend.json"',
      'QUORUM_FUNDING_ACCOUNT must be a NEAR account id, got "Funding.testnet"',
      'QUORUM_RELAYER_ACCOUNT must be a NEAR account id, got "relay..testnet"',
      'QUORUM_PROVIDER_ACCOUNT must be a NEAR account id, got "provider/x"',
      'QUORUM_POOLS_WASM must be an absolute path, got "target/quorum_pools.wasm"',
      'QUORUM_RELAYER_KEY_COUNT must be a positive integer, got "0"',
      'QUORUM_BUYER_NEAR must be an amount of NEAR as a decimal number with at most 24 decimals, such as 0.05, got "1e-7"',
      'QUORUM_PROVIDER_NEAR must be an amount of NEAR as a decimal number with at most 24 decimals, such as 0.05, got "-1"',
      'QUORUM_FUNDING_NEAR must be an amount of NEAR as a decimal number with at most 24 decimals, such as 0.05, got ".5"',
      'QUORUM_RELAYER_NEAR must be an amount of NEAR as a decimal number with at most 24 decimals, such as 0.05, got "3 NEAR"',
      'QUORUM_POOLS_NEAR must be an amount of NEAR as a decimal number with at most 24 decimals, such as 0.05, got ""',
      'QUORUM_BUYER_BUDGET must be an amount in base units (decimal digits, such as 10000), got "0.01"',
      'QUORUM_PROVIDER_BONUS_FUNDS must be an amount in base units (decimal digits, such as 10000), got "1e4"',
      'QUORUM_COMMIT_MIN_GAS must be an amount of gas from 1 to 300000000000000 (300 Tgas, the most the gateway attaches to one call), got "0"',
      'QUORUM_COMMIT_MAX_GAS must be an amount of gas from 1 to 300000000000000 (300 Tgas, the most the gateway attaches to one call), got "300000000000001"',
      'QUORUM_SCENARIO_DEADLINE_SECONDS must be a positive integer, got "0"',
      'QUORUM_SWARM_SPREAD_SECONDS must be an integer from 0 to 2147483 (the longest delay a Node timer honours, in seconds), got "2147484"',
      'QUORUM_REDEEM_INTERVAL_MS must be an integer from 1 to 2147483647 (the longest delay a Node timer honours), got "2147483648"',
    ]);
  });

  it('lists the problems of the shared variables first, then those of its own', () => {
    expect(problems({ QUORUM_BLOCK_TIME_MS: '0', QUORUM_BUYER_BUDGET: '-5' })).toEqual([
      'QUORUM_PARENT_ACCOUNT is required',
      'QUORUM_BLOCK_TIME_MS must be a positive integer, got "0"',
      'QUORUM_BUYER_BUDGET must be an amount in base units (decimal digits, such as 10000), got "-5"',
    ]);
  });

  it('gives the accounts no default without a valid parent, adding no problem of their own', () => {
    expect(problems({ QUORUM_PARENT_ACCOUNT: 'Parent' })).toEqual([
      'QUORUM_PARENT_ACCOUNT must be a NEAR account id, got "Parent"',
    ]);
  });

  it('refuses a maximum commit gas below the minimum, as the gateway does', () => {
    expect(
      problems(env({ QUORUM_COMMIT_MIN_GAS: '60000000000000', QUORUM_COMMIT_MAX_GAS: '59999999999999' })),
    ).toEqual(['QUORUM_COMMIT_MAX_GAS must be at least QUORUM_COMMIT_MIN_GAS (60000000000000), got "59999999999999"']);
  });

  it('accepts the gas bounds at 300 Tgas', () => {
    const config = loadSwarmConfig(
      env({ QUORUM_COMMIT_MIN_GAS: '300000000000000', QUORUM_COMMIT_MAX_GAS: '300000000000000' }),
    );
    expect([config.commitMinGas, config.commitMaxGas]).toEqual([300_000_000_000_000n, 300_000_000_000_000n]);
  });

  it.each([
    [
      'two roles',
      { QUORUM_PROVIDER_ACCOUNT: 'relay.parent.testnet' },
      'QUORUM_PROVIDER_ACCOUNT must name an account of its own, but "relay.parent.testnet" is also QUORUM_RELAYER_ACCOUNT',
    ],
    [
      'a role and the parent',
      { QUORUM_POOLS_ACCOUNT: PARENT },
      'QUORUM_POOLS_ACCOUNT must name an account of its own, but "parent.testnet" is also QUORUM_PARENT_ACCOUNT',
    ],
    [
      'a role and the funding account',
      { QUORUM_MCP_ACCOUNT: 'funding.parent.testnet' },
      'QUORUM_MCP_ACCOUNT must name an account of its own, but "funding.parent.testnet" is also QUORUM_FUNDING_ACCOUNT',
    ],
    [
      'a role and a scripted buyer',
      { QUORUM_MCP_ACCOUNT: 'buyer-07.parent.testnet' },
      'QUORUM_MCP_ACCOUNT must name an account of its own, but "buyer-07.parent.testnet" is also a scripted buyer',
    ],
    [
      'the funding account and a scripted buyer',
      { QUORUM_FUNDING_ACCOUNT: 'buyer-20.parent.testnet' },
      'QUORUM_FUNDING_ACCOUNT must name an account of its own, but "buyer-20.parent.testnet" is also a scripted buyer',
    ],
  ])('refuses one account in %s', (_case, overrides, problem) => {
    expect(problems(env(overrides))).toEqual([problem]);
  });

  it('throws one ConfigError listing every problem', () => {
    expect(() => loadSwarmConfig({ QUORUM_RELAYER_KEY_COUNT: 'four' })).toThrow(
      new ConfigError(['QUORUM_PARENT_ACCOUNT is required', 'QUORUM_RELAYER_KEY_COUNT must be a positive integer, got "four"']),
    );
  });

  it('ships an example file whose values, once the parent account is filled in, are the defaults', async () => {
    const example = parseEnv(await readFile(EXAMPLE, 'utf8'));
    expect(loadSwarmConfig({ ...example, ...env() })).toEqual(loadSwarmConfig(env()));
  });

  it('says in its example file that every command but env and help checks the chain QUORUM_RPC_URL serves', async () => {
    const text = (await readFile(EXAMPLE, 'utf8')).replace(/\n# /g, ' ');
    expect(text).toContain('Every swarm command but env and help stops unless it serves that chain');
  });

  it('heads each section of its example file with the other apps that read its variables, and only those', async () => {
    const text = await readFile(EXAMPLE, 'utf8');
    const gateway = new Set([...(await readFile(GATEWAY_EXAMPLE, 'utf8')).matchAll(VARIABLE)].map((m) => m[1]));
    const mcp = new Set([...(await readFile(MCP_EXAMPLE, 'utf8')).matchAll(VARIABLE)].map((m) => m[1]));
    const sections = text.split(/^# --- /m).slice(1);
    expect(sections.length).toBeGreaterThan(1);
    for (const section of sections) {
      const heading = section.slice(0, section.indexOf('\n'));
      const readers = { gateway: heading.includes('the gateway'), mcp: heading.includes('the MCP server') };
      for (const [, name] of section.matchAll(VARIABLE)) {
        expect({ name, gateway: gateway.has(name), mcp: mcp.has(name) }).toEqual({ name, ...readers });
      }
    }
  });

  it('ships an example file that lists exactly the variables loadSwarmConfig reads', async () => {
    const read = new Set<string>();
    const tracked = new Proxy(env(), {
      get: (target, name) => {
        if (typeof name === 'string') read.add(name);
        return Reflect.get(target, name);
      },
    });
    loadSwarmConfig(tracked);
    const listed = [...(await readFile(EXAMPLE, 'utf8')).matchAll(/^#?(QUORUM_[A-Z_]+)=/gm)].map((m) => m[1]);
    expect(listed.sort()).toEqual([...read].sort());
  });
});
