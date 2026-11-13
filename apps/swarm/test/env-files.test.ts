import { createPrivateKey, createPublicKey } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { folderKeyPath, KeyFileError, keyFolderPath, writeKeyFile } from '@quorum-on-near/buyer';
import { KeyPair } from 'near-api-js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// The apps' own loaders, from their sources: the swarm itself never imports another app.
import { loadConfig, type GatewayConfig } from '../../gateway/src/config.ts';
import { loadMcpConfig, type McpConfig } from '../../mcp/src/config.ts';
import { loadSwarmConfig, type SwarmConfig } from '../src/config.ts';
import {
  aclNotice,
  EnvFileExistsError,
  envFilePath,
  gatewayEnvText,
  gatewaySecretsEnvText,
  mcpEnvText,
  newCredentialJwk,
  writeEnvFile,
  writeGatewayEnv,
  writeMcpEnv,
} from '../src/env-files.ts';

const RELAYER = 'gas.test.near';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'quorum-env-files-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A swarm configuration in which no shared value is the apps' default, with its files in the temp folder. */
function sandboxConfig(overrides: Partial<SwarmConfig> = {}): SwarmConfig {
  return {
    ...loadSwarmConfig({
      QUORUM_NETWORK: 'near:sandbox',
      QUORUM_RPC_URL: 'http://127.0.0.1:3030',
      QUORUM_GATEWAY_URL: 'http://127.0.0.1:9000',
      QUORUM_PARENT_ACCOUNT: 'test.near',
      QUORUM_TOKEN_ACCOUNT: 'musd.test.near',
      QUORUM_POOLS_ACCOUNT: 'escrow.test.near',
      QUORUM_BLOCK_TIME_MS: '600',
      QUORUM_RELAYER_ACCOUNT: RELAYER,
      QUORUM_PROVIDER_ACCOUNT: 'seller.test.near',
      QUORUM_MCP_ACCOUNT: 'agent.test.near',
      QUORUM_COMMIT_MIN_GAS: '40000000000000',
      QUORUM_COMMIT_MAX_GAS: '60000000000000',
      QUORUM_BUYER_BUDGET: '20000',
      QUORUM_CREDENTIALS_DIR: join(dir, 'keys'),
      QUORUM_MCP_SPEND_FILE: join(dir, 'spend.json'),
      QUORUM_BUYER_MAX_TIMEOUT_SECONDS: '90',
    }),
    ...overrides,
  };
}

/** The error `promise` rejects with; fails the test if it resolves. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('the promise resolved');
}

/** Writes `count` new keys to the relayer's key folder and returns them. */
async function relayerKeys(config: SwarmConfig, count: number): Promise<KeyPair[]> {
  const folder = keyFolderPath(config.credentialsDir, config.network, config.relayer);
  const keys = Array.from({ length: count }, () => KeyPair.fromRandom('ed25519'));
  for (const key of keys) await writeKeyFile(folderKeyPath(folder, key.getPublicKey()), config.relayer, key);
  return keys;
}

describe('gatewayEnvText', () => {
  it("is read by the gateway's own loader as the swarm is configured, with every relayer key and the credential key", () => {
    const keys = [KeyPair.fromRandom('ed25519'), KeyPair.fromRandom('ed25519'), KeyPair.fromRandom('ed25519')];
    const jwk = newCredentialJwk();
    const gateway = loadConfig(parseEnv(gatewayEnvText(sandboxConfig(), keys, jwk)));
    expect(gateway).toMatchObject<Partial<GatewayConfig>>({
      network: 'near:sandbox',
      rpcUrl: 'http://127.0.0.1:3030',
      publicUrl: 'http://127.0.0.1:9000',
      parent: 'test.near',
      token: 'musd.test.near',
      poolsContract: 'escrow.test.near',
      relayer: RELAYER,
      provider: 'seller.test.near',
      relayerKeys: keys.map((key) => key.toString()),
      credentialJwk: { ...jwk },
      minGas: 40_000_000_000_000n,
      maxGas: 60_000_000_000_000n,
      blockTimeMs: 600,
    });
  });

  it('sets only the variables the gateway shares with the swarm, and its two secrets', () => {
    const text = gatewayEnvText(sandboxConfig(), [KeyPair.fromRandom('ed25519')], newCredentialJwk());
    expect(Object.keys(parseEnv(text)).sort()).toEqual([
      'QUORUM_BLOCK_TIME_MS',
      'QUORUM_COMMIT_MAX_GAS',
      'QUORUM_COMMIT_MIN_GAS',
      'QUORUM_CREDENTIAL_JWK',
      'QUORUM_GATEWAY_URL',
      'QUORUM_NETWORK',
      'QUORUM_PARENT_ACCOUNT',
      'QUORUM_POOLS_ACCOUNT',
      'QUORUM_PROVIDER_ACCOUNT',
      'QUORUM_RELAYER_ACCOUNT',
      'QUORUM_RELAYER_KEYS',
      'QUORUM_RPC_URL',
      'QUORUM_TOKEN_ACCOUNT',
    ]);
  });

  it('refuses a value that would not read back as it is, naming the variable and not the value', () => {
    const config = sandboxConfig({ rpcUrl: 'http://127.0.0.1:3030/#fragment' });
    expect(() => gatewayEnvText(config, [KeyPair.fromRandom('ed25519')], newCredentialJwk())).toThrow(RangeError);
    expect(() => gatewayEnvText(config, [KeyPair.fromRandom('ed25519')], newCredentialJwk())).toThrow(/QUORUM_RPC_URL/);
    expect(() => gatewayEnvText(config, [KeyPair.fromRandom('ed25519')], newCredentialJwk())).not.toThrow(/fragment/);
  });

  it('needs at least one relayer key', () => {
    expect(() => gatewayEnvText(sandboxConfig(), [], newCredentialJwk())).toThrow(RangeError);
  });
});

describe('gatewaySecretsEnvText', () => {
  it('holds QUORUM_RELAYER_KEYS, in the order given, and QUORUM_CREDENTIAL_JWK alone, on the lines gatewayEnvText writes for them', () => {
    const keys = [KeyPair.fromRandom('ed25519'), KeyPair.fromRandom('ed25519')];
    const jwk = newCredentialJwk();
    const text = gatewaySecretsEnvText(keys, jwk);
    expect(parseEnv(text)).toEqual({
      QUORUM_RELAYER_KEYS: keys.map((key) => key.toString()).join(','),
      QUORUM_CREDENTIAL_JWK: JSON.stringify(jwk),
    });
    const secretLines = (source: string): string[] =>
      source.split('\n').filter((line) => /^QUORUM_(RELAYER_KEYS|CREDENTIAL_JWK)=/.test(line));
    expect(secretLines(text)).toHaveLength(2);
    expect(secretLines(text)).toEqual(secretLines(gatewayEnvText(sandboxConfig(), keys, jwk)));
  });

  it('starts with comment lines saying what wrote it and that it is secret', () => {
    const text = gatewaySecretsEnvText([KeyPair.fromRandom('ed25519')], newCredentialJwk());
    expect(text.split('\n').slice(0, 2)).toEqual([
      '# Written by `swarm keys from-seed --gateway-env` from the seed phrase.',
      "# Secret: it holds the relayer's keys and the credential key. Keep it private, and never commit it.",
    ]);
  });

  it('needs at least one relayer key', () => {
    expect(() => gatewaySecretsEnvText([], newCredentialJwk())).toThrow(RangeError);
  });
});

describe('mcpEnvText', () => {
  it("is read by the MCP server's own loader as the swarm is configured, with the spend cap at the buyer budget", () => {
    expect(loadMcpConfig(parseEnv(mcpEnvText(sandboxConfig())))).toEqual<McpConfig>({
      network: 'near:sandbox',
      rpcUrl: 'http://127.0.0.1:3030',
      gatewayUrl: 'http://127.0.0.1:9000',
      parent: 'test.near',
      token: 'musd.test.near',
      poolsContract: 'escrow.test.near',
      blockTimeMs: 600,
      maxTimeoutSeconds: 90,
      mcpAccount: 'agent.test.near',
      credentialsDir: join(dir, 'keys'),
      spendCap: 20_000n,
      spendFile: join(dir, 'spend.json'),
    });
  });
});

describe('newCredentialJwk', () => {
  it('is a private Ed25519 JWK with only kty, crv, x and d, where x is the public key of d', () => {
    const jwk = newCredentialJwk();
    expect(Object.keys(jwk).sort()).toEqual(['crv', 'd', 'kty', 'x']);
    expect([jwk.kty, jwk.crv]).toEqual(['OKP', 'Ed25519']);
    expect(createPublicKey(createPrivateKey({ key: { ...jwk }, format: 'jwk' })).export({ format: 'jwk' }).x).toBe(jwk.x);
  });

  it('is a new key each time', () => {
    expect(newCredentialJwk().d).not.toBe(newCredentialJwk().d);
  });
});

describe('envFilePath', () => {
  it("is the app's own .env, next to its package.json, wherever the process runs", () => {
    const apps = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
    expect(envFilePath('gateway')).toBe(join(apps, 'gateway', '.env'));
    expect(envFilePath('mcp')).toBe(join(apps, 'mcp', '.env'));
  });
});

describe('writeEnvFile', () => {
  it('writes the text to a new file', async () => {
    const path = join(dir, '.env');
    await writeEnvFile(path, 'QUORUM_NETWORK=near:sandbox\n');
    expect(await readFile(path, 'utf8')).toBe('QUORUM_NETWORK=near:sandbox\n');
  });

  it('refuses to write over a file that exists, and says where it is', async () => {
    const path = join(dir, '.env');
    await writeFile(path, 'KEPT=1\n');
    const error = await rejection(writeEnvFile(path, 'QUORUM_NETWORK=near:sandbox\n'));
    expect(error).toBeInstanceOf(EnvFileExistsError);
    expect(error).toMatchObject({ path });
    expect((error as Error).message).toContain(path);
    expect(await readFile(path, 'utf8')).toBe('KEPT=1\n');
  });

  it.skipIf(process.platform === 'win32')('makes the file readable by its owner only', async () => {
    const path = join(dir, '.env');
    await writeEnvFile(path, 'QUORUM_NETWORK=near:sandbox\n');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
});

describe('aclNotice', () => {
  it('on Windows, says the file is protected only by its folder’s access list, and gives the icacls command for the user', () => {
    const path = 'C:\\repo with space\\apps\\gateway\\.env';
    expect(aclNotice(path, 'win32', 'Ada Lovelace')).toBe(
      `${path} is protected only by its folder's access control list, since Windows ignores the file mode: ` +
        `to let Ada Lovelace alone use it, run icacls "${path}" /inheritance:r /grant:r "Ada Lovelace:F"`,
    );
  });

  it.each(['linux', 'darwin'] as const)('is null on %s, where the file is created readable by its owner only', (platform) => {
    expect(aclNotice('/repo/apps/gateway/.env', platform, 'ada')).toBeNull();
  });
});

describe('writeGatewayEnv', () => {
  it("writes every key of the relayer's key folder and a new credential key, as the gateway reads them", async () => {
    const config = sandboxConfig();
    const keys = await relayerKeys(config, 3);
    const path = join(dir, 'gateway.env');
    await writeGatewayEnv(config, path);
    const gateway = loadConfig(parseEnv(await readFile(path, 'utf8')));
    expect([...gateway.relayerKeys].sort()).toEqual(keys.map((key) => key.toString()).sort());
    expect(gateway.relayer).toBe(RELAYER);
  });

  it('gives each file it writes a credential key of its own', async () => {
    const config = sandboxConfig();
    await relayerKeys(config, 1);
    await writeGatewayEnv(config, join(dir, 'first.env'));
    await writeGatewayEnv(config, join(dir, 'second.env'));
    const jwk = async (name: string): Promise<string | undefined> =>
      parseEnv(await readFile(join(dir, name), 'utf8')).QUORUM_CREDENTIAL_JWK;
    expect(await jwk('first.env')).not.toBe(await jwk('second.env'));
  });

  it('refuses to write over a file that exists', async () => {
    const config = sandboxConfig();
    await relayerKeys(config, 1);
    const path = join(dir, 'gateway.env');
    await writeFile(path, 'KEPT=1\n');
    expect(await rejection(writeGatewayEnv(config, path))).toBeInstanceOf(EnvFileExistsError);
    expect(await readFile(path, 'utf8')).toBe('KEPT=1\n');
  });

  it("fails without the relayer's key folder, which setup writes", async () => {
    const error = await rejection(writeGatewayEnv(sandboxConfig(), join(dir, 'gateway.env')));
    expect(error).toBeInstanceOf(KeyFileError);
    expect(error).toMatchObject({ problem: 'missing' });
  });
});

describe('writeMcpEnv', () => {
  it('writes the text the MCP server reads, and refuses to write over it', async () => {
    const config = sandboxConfig();
    const path = join(dir, 'mcp.env');
    await writeMcpEnv(config, path);
    expect(loadMcpConfig(parseEnv(await readFile(path, 'utf8'))).mcpAccount).toBe('agent.test.near');
    expect(await rejection(writeMcpEnv(config, path))).toBeInstanceOf(EnvFileExistsError);
  });
});
