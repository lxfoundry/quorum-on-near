import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv, promisify } from 'node:util';
import { KeyPair } from 'near-api-js';
import { describe, expect, it } from 'vitest';
import { checkChainId, ConfigError, loadConfig, TESTNET_USDC, type GatewayConfig } from '../src/config.ts';
import { generateCredentialJwk } from '../src/credential.ts';

const EXAMPLE = fileURLToPath(new URL('../.env.example', import.meta.url));
const PARENT = 'parent.testnet';
const RELAYER_KEY = KeyPair.fromRandom('ed25519').toString();
const CREDENTIAL_JWK = await generateCredentialJwk();
const OTHER_JWK = await generateCredentialJwk();

/** The three required variables, plus `overrides` (`undefined` unsets one). */
function env(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    QUORUM_PARENT_ACCOUNT: PARENT,
    QUORUM_RELAYER_KEYS: RELAYER_KEY,
    QUORUM_CREDENTIAL_JWK: JSON.stringify(CREDENTIAL_JWK),
    ...overrides,
  };
}

/** The problem lines of the ConfigError that loadConfig throws for `vars`. */
function problems(vars: Record<string, string | undefined>): string[] {
  try {
    loadConfig(vars);
  } catch (error) {
    if (error instanceof ConfigError) return error.message.split('\n');
    throw error;
  }
  throw new Error('loadConfig accepted the configuration');
}

describe('loadConfig', () => {
  it('applies every default when only the three required variables are set', () => {
    expect(loadConfig(env())).toEqual<GatewayConfig>({
      network: 'near:testnet',
      rpcUrl: 'https://test.rpc.fastnear.com',
      publicUrl: 'http://localhost:8402',
      port: 8402,
      parent: PARENT,
      token: TESTNET_USDC,
      poolsContract: 'pools.parent.testnet',
      relayer: 'relay.parent.testnet',
      provider: 'provider.parent.testnet',
      relayerKeys: [RELAYER_KEY],
      credentialJwk: CREDENTIAL_JWK,
      minGas: 50_000_000_000_000n,
      maxGas: 100_000_000_000_000n,
      maxTimeoutSeconds: 120,
      blockTimeMs: 1000,
      keeperIntervalMs: 5000,
      refundLimit: 10,
      settleGas: 100_000_000_000_000n,
      refundGas: 300_000_000_000_000n,
      dataDir: 'data',
      webDir: '../web',
      rpcPassthrough: false,
      explorerTxUrl: 'https://testnet.nearblocks.io/txns/',
    });
  });

  it('derives the pools, relayer and provider accounts from the parent', () => {
    const config = loadConfig(env({ QUORUM_PARENT_ACCOUNT: 'quorum-test.testnet' }));
    expect([config.poolsContract, config.relayer, config.provider]).toEqual([
      'pools.quorum-test.testnet',
      'relay.quorum-test.testnet',
      'provider.quorum-test.testnet',
    ]);
  });

  it('reads every variable that is set', () => {
    const secondKey = KeyPair.fromRandom('ed25519').toString();
    const config = loadConfig(
      env({
        QUORUM_NETWORK: 'near:sandbox',
        QUORUM_RPC_URL: 'http://127.0.0.1:3030',
        QUORUM_GATEWAY_URL: 'https://gateway.example',
        QUORUM_GATEWAY_PORT: '9000',
        QUORUM_TOKEN_ACCOUNT: 'usdc.testnet',
        QUORUM_POOLS_ACCOUNT: 'pools-v2.testnet',
        QUORUM_RELAYER_ACCOUNT: 'relayer_1.testnet',
        QUORUM_PROVIDER_ACCOUNT: 'gpu.testnet',
        QUORUM_RELAYER_KEYS: `${RELAYER_KEY},${secondKey}`,
        QUORUM_COMMIT_MIN_GAS: '30000000000000',
        QUORUM_COMMIT_MAX_GAS: '30000000000000',
        QUORUM_MAX_TIMEOUT_SECONDS: '60',
        QUORUM_BLOCK_TIME_MS: '600',
        QUORUM_KEEPER_INTERVAL_MS: '2000',
        QUORUM_REFUND_LIMIT: '1',
        QUORUM_SETTLE_GAS: '80000000000000',
        QUORUM_REFUND_GAS: '250000000000000',
        QUORUM_DATA_DIR: '/var/lib/quorum',
        QUORUM_WEB_DIR: 'public',
        QUORUM_RPC_PASSTHROUGH: 'true',
        QUORUM_EXPLORER_TX_URL: 'https://explorer.example/txns/',
      }),
    );
    expect(config).toEqual<GatewayConfig>({
      network: 'near:sandbox',
      rpcUrl: 'http://127.0.0.1:3030',
      publicUrl: 'https://gateway.example',
      port: 9000,
      parent: PARENT,
      token: 'usdc.testnet',
      poolsContract: 'pools-v2.testnet',
      relayer: 'relayer_1.testnet',
      provider: 'gpu.testnet',
      relayerKeys: [RELAYER_KEY, secondKey],
      credentialJwk: CREDENTIAL_JWK,
      minGas: 30_000_000_000_000n,
      maxGas: 30_000_000_000_000n,
      maxTimeoutSeconds: 60,
      blockTimeMs: 600,
      keeperIntervalMs: 2000,
      refundLimit: 1,
      settleGas: 80_000_000_000_000n,
      refundGas: 250_000_000_000_000n,
      dataDir: '/var/lib/quorum',
      webDir: 'public',
      rpcPassthrough: true,
      explorerTxUrl: 'https://explorer.example/txns/',
    });
  });

  it('ignores spaces and empty entries in the relayer key list', () => {
    const secondKey = KeyPair.fromRandom('ed25519').toString();
    const config = loadConfig(env({ QUORUM_RELAYER_KEYS: ` ${RELAYER_KEY} , ${secondKey},` }));
    expect(config.relayerKeys).toEqual([RELAYER_KEY, secondKey]);
  });

  it('removes the trailing slash from the gateway URL', () => {
    expect(loadConfig(env({ QUORUM_GATEWAY_URL: 'https://gateway.example/' })).publicUrl).toBe(
      'https://gateway.example',
    );
  });

  it('removes every trailing slash from a gateway URL with a path', () => {
    expect(loadConfig(env({ QUORUM_GATEWAY_URL: 'https://example.com/quorum//' })).publicUrl).toBe(
      'https://example.com/quorum',
    );
  });

  it('treats an empty QUORUM_WEB_DIR as serving nothing', () => {
    expect(loadConfig(env({ QUORUM_WEB_DIR: '' })).webDir).toBeNull();
  });

  it.each(['QUORUM_PARENT_ACCOUNT', 'QUORUM_RELAYER_KEYS', 'QUORUM_CREDENTIAL_JWK'])(
    'reports %s as required when it is unset',
    (name) => {
      expect(problems(env({ [name]: undefined }))).toEqual([`${name} is required`]);
    },
  );

  it.each(['QUORUM_PARENT_ACCOUNT', 'QUORUM_RELAYER_KEYS', 'QUORUM_CREDENTIAL_JWK'])(
    'reports %s as required when it is empty',
    (name) => {
      expect(problems(env({ [name]: '' }))).toEqual([`${name} is required`]);
    },
  );

  it.each([
    ['QUORUM_NETWORK', 'testnet'],
    ['QUORUM_NETWORK', 'near:Testnet'],
    ['QUORUM_RPC_URL', 'not a url'],
    ['QUORUM_RPC_URL', 'ws://rpc.example'],
    ['QUORUM_GATEWAY_URL', 'localhost:8402'],
    ['QUORUM_GATEWAY_PORT', '0'],
    ['QUORUM_GATEWAY_PORT', '65536'],
    ['QUORUM_GATEWAY_PORT', '84O2'],
    ['QUORUM_PARENT_ACCOUNT', 'Parent.testnet'],
    ['QUORUM_PARENT_ACCOUNT', 'a'],
    ['QUORUM_PARENT_ACCOUNT', `${'a'.repeat(57)}.testnet`],
    ['QUORUM_TOKEN_ACCOUNT', 'usdc..testnet'],
    ['QUORUM_POOLS_ACCOUNT', 'pools_.testnet'],
    ['QUORUM_POOLS_ACCOUNT', ''],
    ['QUORUM_RELAYER_ACCOUNT', '-relay.testnet'],
    ['QUORUM_PROVIDER_ACCOUNT', 'provider.testnet.'],
    ['QUORUM_COMMIT_MIN_GAS', '0'],
    ['QUORUM_COMMIT_MIN_GAS', '1e14'],
    ['QUORUM_COMMIT_MAX_GAS', '-1'],
    ['QUORUM_MAX_TIMEOUT_SECONDS', '0'],
    ['QUORUM_MAX_TIMEOUT_SECONDS', '1.5'],
    ['QUORUM_BLOCK_TIME_MS', ''],
    ['QUORUM_KEEPER_INTERVAL_MS', '5s'],
    ['QUORUM_REFUND_LIMIT', '0'],
    ['QUORUM_REFUND_LIMIT', '11'],
    ['QUORUM_SETTLE_GAS', '100 Tgas'],
    ['QUORUM_REFUND_GAS', '0'],
    ['QUORUM_DATA_DIR', ''],
    ['QUORUM_RPC_PASSTHROUGH', 'yes'],
    ['QUORUM_RPC_PASSTHROUGH', 'TRUE'],
    ['QUORUM_EXPLORER_TX_URL', 'nearblocks.io/txns/'],
  ])('reports %s = %j as invalid', (name, value) => {
    expect(problems(env({ [name]: value }))).toEqual([expect.stringMatching(new RegExp(`^${name} must be `))]);
  });

  // Labelled rather than printed: these values are, or contain, key material.
  it.each([
    ['no key', ','],
    ['a value that is not base58', 'ed25519:not-base58'],
    ['a secp256k1 secret key', KeyPair.fromRandom('secp256k1').toString()],
    ['an ed25519 public key', KeyPair.fromRandom('ed25519').getPublicKey().toString()],
  ])('reports QUORUM_RELAYER_KEYS holding %s as invalid', (_label, value) => {
    expect(problems(env({ QUORUM_RELAYER_KEYS: value }))).toEqual([
      'QUORUM_RELAYER_KEYS must be a comma-separated list of ed25519 secret keys',
    ]);
  });

  it('reports QUORUM_RELAYER_KEYS as invalid when one key of several is invalid', () => {
    const value = `${RELAYER_KEY},${KeyPair.fromRandom('ed25519').getPublicKey().toString()}`;
    expect(problems(env({ QUORUM_RELAYER_KEYS: value }))).toEqual([
      'QUORUM_RELAYER_KEYS must be a comma-separated list of ed25519 secret keys',
    ]);
  });

  it.each([
    ['text that is not JSON', 'not json'],
    ['a JSON array', '[]'],
    ['a public key', JSON.stringify({ ...CREDENTIAL_JWK, d: undefined })],
    ['an X25519 key', JSON.stringify({ ...CREDENTIAL_JWK, crv: 'X25519' })],
    ['an EC key', JSON.stringify({ ...CREDENTIAL_JWK, kty: 'EC' })],
    ['a key whose x belongs to another key', JSON.stringify({ ...CREDENTIAL_JWK, x: OTHER_JWK.x })],
    ['a key whose d is not a valid key', JSON.stringify({ ...CREDENTIAL_JWK, d: 'AAAA' })],
  ])('reports QUORUM_CREDENTIAL_JWK holding %s as invalid', (_label, value) => {
    expect(problems(env({ QUORUM_CREDENTIAL_JWK: value }))).toEqual([
      'QUORUM_CREDENTIAL_JWK must be a private Ed25519 JWK (JSON with kty "OKP", crv "Ed25519", x and d)',
    ]);
  });

  it('accepts any key that generateCredentialJwk makes', () => {
    expect(loadConfig(env({ QUORUM_CREDENTIAL_JWK: JSON.stringify(OTHER_JWK) })).credentialJwk).toEqual(OTHER_JWK);
  });

  it('lists a credential key whose x does not belong to its d with the other problems, without either key', () => {
    const jwk = JSON.stringify({ ...CREDENTIAL_JWK, x: OTHER_JWK.x });
    const message = problems(env({ QUORUM_CREDENTIAL_JWK: jwk, QUORUM_RPC_PASSTHROUGH: 'yes' })).join('\n');
    expect(message).toContain('QUORUM_CREDENTIAL_JWK must be a private Ed25519 JWK');
    expect(message).toContain('QUORUM_RPC_PASSTHROUGH must be true or false, got "yes"');
    for (const part of [CREDENTIAL_JWK.d, CREDENTIAL_JWK.x, OTHER_JWK.x]) expect(message).not.toContain(part);
  });

  it('reports a maximum commit gas below the minimum', () => {
    expect(problems(env({ QUORUM_COMMIT_MIN_GAS: '60000000000000', QUORUM_COMMIT_MAX_GAS: '50000000000000' }))).toEqual(
      ['QUORUM_COMMIT_MAX_GAS must be at least QUORUM_COMMIT_MIN_GAS (60000000000000), got "50000000000000"'],
    );
  });

  it('reports a derived account that is too long to be valid', () => {
    // 56 characters: pools.<parent> and relay.<parent> fit in 64, provider.<parent> does not.
    const parent = `${'a'.repeat(48)}.testnet`;
    expect(problems(env({ QUORUM_PARENT_ACCOUNT: parent }))).toEqual([
      `QUORUM_PROVIDER_ACCOUNT must be a NEAR account id, got "provider.${parent}"`,
    ]);
  });

  it('reports several problems together, in the order of the variables', () => {
    expect(
      problems({
        QUORUM_GATEWAY_PORT: '0',
        QUORUM_CREDENTIAL_JWK: '{}',
        QUORUM_RPC_PASSTHROUGH: 'yes',
      }),
    ).toEqual([
      'QUORUM_GATEWAY_PORT must be an integer from 1 to 65535, got "0"',
      'QUORUM_PARENT_ACCOUNT is required',
      'QUORUM_RELAYER_KEYS is required',
      'QUORUM_CREDENTIAL_JWK must be a private Ed25519 JWK (JSON with kty "OKP", crv "Ed25519", x and d)',
      'QUORUM_RPC_PASSTHROUGH must be true or false, got "yes"',
    ]);
  });

  it('never repeats a relayer key or the credential key in its problems', () => {
    const relayerKey = KeyPair.fromRandom('secp256k1').toString();
    const jwk = JSON.stringify({ ...CREDENTIAL_JWK, crv: 'X25519' });
    const message = problems(env({ QUORUM_RELAYER_KEYS: relayerKey, QUORUM_CREDENTIAL_JWK: jwk })).join('\n');
    expect(message).not.toContain(relayerKey.slice('secp256k1:'.length));
    expect(message).not.toContain(CREDENTIAL_JWK.d);
  });

  it('ships an example file whose values, once the required ones are filled in, are the defaults', async () => {
    const example = parseEnv(await readFile(EXAMPLE, 'utf8'));
    const filled = { ...example, ...env() };
    expect(loadConfig(filled)).toEqual(loadConfig(env()));
  });

  it('ships an example file that lists exactly the variables loadConfig reads', async () => {
    const read = new Set<string>();
    const tracked = new Proxy(env(), {
      get: (target, name) => {
        if (typeof name === 'string') read.add(name);
        return Reflect.get(target, name);
      },
    });
    loadConfig(tracked);
    const listed = [...(await readFile(EXAMPLE, 'utf8')).matchAll(/^#?(QUORUM_[A-Z_]+)=/gm)].map((m) => m[1]);
    expect(listed.sort()).toEqual([...read].sort());
  });

  it('accepts the credential key line that keygen prints', async () => {
    const keygen = fileURLToPath(new URL('../src/keygen.ts', import.meta.url));
    const { stdout } = await promisify(execFile)(process.execPath, [keygen]);
    const [, jwk] = /^QUORUM_CREDENTIAL_JWK=(\{.*\})\n$/.exec(stdout) ?? [];
    expect(jwk).toBeDefined();
    expect(loadConfig(env({ QUORUM_CREDENTIAL_JWK: jwk })).credentialJwk).toEqual({
      kty: 'OKP',
      crv: 'Ed25519',
      x: expect.any(String),
      d: expect.any(String),
    });
  });
});

describe('loadConfig network', () => {
  it.each(['near:testnet', 'near:sandbox'])('accepts %s', (network) => {
    expect(loadConfig(env({ QUORUM_NETWORK: network })).network).toBe(network);
  });

  it.each(['near:mainnet', 'near:localnet'])('refuses %s: the gateway runs on testnet only', (network) => {
    expect(problems(env({ QUORUM_NETWORK: network }))).toEqual([
      `QUORUM_NETWORK must be near:testnet or near:sandbox (the gateway runs on no other network), got "${network}"`,
    ]);
  });
});

describe('checkChainId', () => {
  it.each([
    ['near:testnet', 'testnet'],
    // A sandbox initialised without a chain id gets test-chain- and 5 random characters.
    ['near:sandbox', 'test-chain-a1B2c'],
    ['near:sandbox', 'localnet'],
  ] as const)('accepts %s on the chain %j', (network, chainId) => {
    expect(checkChainId(network, chainId)).toBeNull();
  });

  it.each(['mainnet', 'test-chain-a1B2c', 'Testnet', ''])('refuses near:testnet on the chain %j', (chainId) => {
    expect(checkChainId('near:testnet', chainId)).toBe(
      `QUORUM_NETWORK is near:testnet, but QUORUM_RPC_URL serves the chain ${JSON.stringify(chainId)}, not "testnet"`,
    );
  });

  it.each(['mainnet', 'testnet'])('refuses near:sandbox on the public chain %j', (chainId) => {
    expect(checkChainId('near:sandbox', chainId)).toBe(
      `QUORUM_NETWORK is near:sandbox, but QUORUM_RPC_URL serves NEAR's public chain ${JSON.stringify(chainId)}`,
    );
  });
});

describe('loadConfig gas', () => {
  const MOST = '300000000000000';

  it('accepts the least gas the keeper may attach, at the smallest and the largest refund limit', () => {
    const atLimit = (limit: string, refundGas: string) =>
      loadConfig(
        env({ QUORUM_REFUND_LIMIT: limit, QUORUM_SETTLE_GAS: '50000000000000', QUORUM_REFUND_GAS: refundGas }),
      );
    // What the contract requires at entry plus 17 Tgas for what the call uses before that check.
    // settle: 10 + 23 + 17 Tgas; refund: 10 + 23 × (limit + 1) + 17 Tgas.
    expect(atLimit('1', '73000000000000')).toMatchObject({ settleGas: 50_000_000_000_000n, refundGas: 73_000_000_000_000n });
    expect(atLimit('10', '280000000000000').refundGas).toBe(280_000_000_000_000n);
  });

  it('accepts 300 Tgas, the most gas the gateway attaches to one call', () => {
    const config = loadConfig(
      env({ QUORUM_COMMIT_MIN_GAS: MOST, QUORUM_COMMIT_MAX_GAS: MOST, QUORUM_SETTLE_GAS: MOST, QUORUM_REFUND_GAS: MOST }),
    );
    expect([config.minGas, config.maxGas, config.settleGas, config.refundGas]).toEqual(Array(4).fill(BigInt(MOST)));
  });

  const SETTLE_FROM = '50000000000000 (what settle requires at entry, plus what it uses before that check)';
  const REFUND_FROM =
    '280000000000000 (what refund requires at entry with QUORUM_REFUND_LIMIT 10, plus what it uses before that check)';
  it.each([
    ['QUORUM_COMMIT_MIN_GAS', '0', '1'],
    ['QUORUM_COMMIT_MIN_GAS', '300000000000001', '1'],
    ['QUORUM_COMMIT_MAX_GAS', '300000000000001', '1'],
    ['QUORUM_SETTLE_GAS', '49999999999999', SETTLE_FROM],
    ['QUORUM_SETTLE_GAS', '300000000000001', SETTLE_FROM],
    ['QUORUM_REFUND_GAS', '300000000000001', REFUND_FROM],
  ])('reports %s = %s out of its range', (name, gas, from) => {
    expect(problems(env({ [name]: gas }))).toEqual([
      `${name} must be an amount of gas from ${from} to 300000000000000 (300 Tgas, the most the gateway attaches to one call), got "${gas}"`,
    ]);
  });

  // The contract panics at entry unless the gas it has left, after what the call has already used, covers
  // its requirement. A call that attaches only the requirement always fails there, so it is refused.
  it('refuses exactly the gas the contract requires at entry, which every call fails on', () => {
    const range = (name: string, from: string, gas: string) =>
      `${name} must be an amount of gas from ${from} to 300000000000000 (300 Tgas, the most the gateway attaches to one call), got "${gas}"`;
    expect(problems(env({ QUORUM_SETTLE_GAS: '33000000000000' }))).toEqual([
      range('QUORUM_SETTLE_GAS', SETTLE_FROM, '33000000000000'),
    ]);
    expect(problems(env({ QUORUM_REFUND_LIMIT: '10', QUORUM_REFUND_GAS: '263000000000000' }))).toEqual([
      range('QUORUM_REFUND_GAS', REFUND_FROM, '263000000000000'),
    ]);
  });

  it.each([
    ['10', '279999999999999', '280000000000000'],
    ['3', '118999999999999', '119000000000000'],
    ['1', '72999999999999', '73000000000000'],
  ])('reports refund gas below what refund needs with QUORUM_REFUND_LIMIT %s', (limit, gas, least) => {
    expect(problems(env({ QUORUM_REFUND_LIMIT: limit, QUORUM_REFUND_GAS: gas }))).toEqual([
      `QUORUM_REFUND_GAS must be an amount of gas from ${least} (what refund requires at entry with QUORUM_REFUND_LIMIT ${limit}, plus what it uses before that check) to 300000000000000 (300 Tgas, the most the gateway attaches to one call), got "${gas}"`,
    ]);
  });

  it('checks the refund gas only against the range when the refund limit is invalid', () => {
    expect(problems(env({ QUORUM_REFUND_LIMIT: '11', QUORUM_REFUND_GAS: '1' }))).toEqual([
      'QUORUM_REFUND_LIMIT must be an integer from 1 to 10, got "11"',
    ]);
  });
});

describe('loadConfig keeper interval', () => {
  // Node turns any timer delay above this into 1 ms, so the keeper would tick back to back.
  const LONGEST = 2_147_483_647;

  it('accepts 1 ms and the longest delay a Node timer honours', () => {
    expect(loadConfig(env({ QUORUM_KEEPER_INTERVAL_MS: '1' })).keeperIntervalMs).toBe(1);
    expect(loadConfig(env({ QUORUM_KEEPER_INTERVAL_MS: `${LONGEST}` })).keeperIntervalMs).toBe(LONGEST);
  });

  it.each(['0', `${LONGEST + 1}`, '9007199254740991'])('refuses QUORUM_KEEPER_INTERVAL_MS = %s', (value) => {
    expect(problems(env({ QUORUM_KEEPER_INTERVAL_MS: value }))).toEqual([
      `QUORUM_KEEPER_INTERVAL_MS must be an integer from 1 to 2147483647 (the longest delay a Node timer honours), got "${value}"`,
    ]);
  });
});

describe('loadConfig relayer keys', () => {
  it('reports a key listed twice, by position, without the key', () => {
    const secondKey = KeyPair.fromRandom('ed25519').toString();
    const message = problems(env({ QUORUM_RELAYER_KEYS: `${RELAYER_KEY}, ${secondKey},,${RELAYER_KEY}` }));
    expect(message).toEqual(['QUORUM_RELAYER_KEYS must list each key once: keys 1 and 3 are the same']);
  });
});

describe('loadConfig web folder', () => {
  // The folder this package lives in, which holds its .env file.
  const GATEWAY_DIR = resolve(fileURLToPath(new URL('..', import.meta.url)));

  it.each([
    ['the gateway folder', GATEWAY_DIR],
    ['the gateway folder relative to the current folder', relative(process.cwd(), GATEWAY_DIR) || '.'],
    ['a folder above the gateway folder', dirname(GATEWAY_DIR)],
    ['a folder two levels above it', dirname(dirname(GATEWAY_DIR))],
  ])('refuses %s, which would publish its .env file', (_label, dir) => {
    expect(problems(env({ QUORUM_WEB_DIR: dir }))).toEqual([
      `QUORUM_WEB_DIR must be empty, or a folder that neither is nor contains the gateway's own folder (${GATEWAY_DIR}), got ${JSON.stringify(dir)}`,
    ]);
  });

  it.each([
    ['a folder inside the gateway folder', join(GATEWAY_DIR, 'public')],
    ['a sibling of the gateway folder', join(dirname(GATEWAY_DIR), 'web')],
    ['a sibling whose name starts with the gateway folder name', `${GATEWAY_DIR}-web`],
  ])('accepts %s', (_label, dir) => {
    expect(loadConfig(env({ QUORUM_WEB_DIR: dir })).webDir).toBe(dir);
  });
});
