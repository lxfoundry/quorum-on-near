// The environment the sandbox harness gives the swarm's command line, checked on any platform: it
// starts nothing.
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadSwarmConfig } from '../src/config.ts';
import { swarmCliEnv } from './sandbox/harness.ts';

const EXAMPLE = new URL('../.env.example', import.meta.url);
/** Paths that are only named, never written. */
const ROOT = join(tmpdir(), 'quorum-swarm-sandbox-world');

/** A world's own swarm variables, as startSwarmWorld sets them; every other one is left unset. */
const SWARM_ENV: Record<string, string> = {
  QUORUM_NETWORK: 'near:sandbox',
  QUORUM_RPC_URL: 'http://127.0.0.1:3030',
  QUORUM_GATEWAY_URL: 'http://127.0.0.1:9402',
  QUORUM_PARENT_ACCOUNT: 'test.near',
  QUORUM_TOKEN_ACCOUNT: 'musd.test.near',
  QUORUM_POOLS_WASM: join(ROOT, 'quorum_pools.wasm'),
  QUORUM_CREDENTIALS_DIR: join(ROOT, 'keys'),
  QUORUM_MCP_SPEND_FILE: join(ROOT, 'mcp-spend.json'),
  QUORUM_SCENARIO_DEADLINE_SECONDS: '30',
  QUORUM_SWARM_SPREAD_SECONDS: '5',
  QUORUM_REDEEM_INTERVAL_MS: '1000',
};

/** Every variable apps/swarm/.env.example names, set or commented out: every variable the swarm reads. */
async function swarmVariables(): Promise<string[]> {
  const text = await readFile(EXAMPLE, 'utf8');
  return [...text.matchAll(/^#?(QUORUM_[A-Z0-9_]+)=/gm)].map((match) => match[1] ?? '');
}

function world(swarmEnv: Record<string, string> = SWARM_ENV) {
  return { swarmEnv, config: loadSwarmConfig(swarmEnv) };
}

describe("the sandbox harness's environment for the swarm's command line", () => {
  it('sets every variable the swarm reads, so that a developer’s apps/swarm/.env cannot fill one the world leaves unset', async () => {
    const env = swarmCliEnv(world());

    const unset = (await swarmVariables()).filter((name) => env[name] === undefined);

    expect(unset).toEqual([]);
  });

  it('gives each variable the value the world’s configuration resolved, so that the command line reads that configuration', () => {
    const w = world();

    expect(loadSwarmConfig(swarmCliEnv(w))).toEqual(w.config);
  });

  it('gives a setting the world leaves null as empty, which the swarm reads as unset', () => {
    const { QUORUM_POOLS_WASM: _wasm, QUORUM_SCENARIO_DEADLINE_SECONDS: _deadline, ...rest } = SWARM_ENV;
    const w = world(rest);

    const env = swarmCliEnv(w);

    expect([env.QUORUM_POOLS_WASM, env.QUORUM_SCENARIO_DEADLINE_SECONDS]).toEqual(['', '']);
    expect(loadSwarmConfig(env)).toMatchObject({ poolsWasm: null, deadlineSeconds: null });
  });

  it('keeps the world’s own values as written, and sets a test’s variables over them', () => {
    const env = swarmCliEnv(world(), { QUORUM_SWARM_SPREAD_SECONDS: '0', QUORUM_REDEEM_INTERVAL_MS: undefined });

    expect(env).toMatchObject({ ...SWARM_ENV, QUORUM_SWARM_SPREAD_SECONDS: '0' });
  });
});
