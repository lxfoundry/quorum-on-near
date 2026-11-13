import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseEnv } from 'node:util';
import {
  ConfigError,
  folderKeyPath,
  keyFilePath,
  keyFolderPath,
  readKeyFile,
  readKeyFolder,
  writeKeyFile,
  type Env,
} from '@quorum-on-near/buyer';
import { KeyPair, PublicKey, type Provider } from 'near-api-js';
import { AccessKeyDoesNotExistError, AccountDoesNotExistError, UnknownBlockError } from 'near-api-js/rpc-errors';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// The gateway's own loader, from its sources, as env-files.test.ts reads it: the swarm itself never
// imports another app.
import { loadConfig } from '../../gateway/src/config.ts';
import { loadSwarmConfig, type SwarmConfig } from '../src/config.ts';
import {
  keysFromSeed,
  KeysFromSeedError,
  parentPublicKey,
  readSeedPhrase,
  RpcSeedChain,
  type SeedChain,
} from '../src/keys-from-seed.ts';
import { bip39Seed, credentialJwk, nearKey } from '../src/seed.ts';
import { PARENT, POOLS, PROVIDER } from './fake-chain.ts';
import { StubSeedChain } from './stub-seed-chain.ts';

/** BIP-39's public 12-word test phrase: anyone can derive its keys. */
const PHRASE = `${'abandon '.repeat(11)}about`;
/** BIP-39's public 24-word test phrase. */
const PHRASE_24 = `${'abandon '.repeat(23)}art`;
/** PHRASE as it may be typed or pasted: capitals, line breaks, a tab and extra spaces. */
const MESSY = `\n  ABANDON abandon\tabandon\r\nAbandon ${'abandon '.repeat(7)}  ABOUT\n`;
const SEED = bip39Seed(PHRASE);

const FUNDING = `funding.${PARENT}`;
const RELAYER = `relay.${PARENT}`;
const MCP_BUYER = `buyer-llm.${PARENT}`;
const BUYER_01 = `buyer-01.${PARENT}`;
const BUYERS = Array.from({ length: 20 }, (_, i) => `buyer-${String(i + 1).padStart(2, '0')}.${PARENT}`);

/** What the phrase gives at m/44'/397'/<index>'. */
const key = (index: number) => nearKey(SEED, `m/44'/397'/${index}'`);
const pub = (index: number): string => key(index).publicKey;
const randomKey = (): string => KeyPair.fromRandom('ed25519').getPublicKey().toString();

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'quorum-keys-from-seed-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** The configuration of PARENT, its key files under the temporary folder, two relayer keys, and `env` over it. */
function config(env: Env = {}): SwarmConfig {
  return loadSwarmConfig({
    QUORUM_PARENT_ACCOUNT: PARENT,
    QUORUM_CREDENTIALS_DIR: join(dir, 'keys'),
    QUORUM_RELAYER_KEY_COUNT: '2',
    ...env,
  });
}

/** A chain on which only the parent exists, holding the phrase's parent key with full access. */
function parentOnly(): StubSeedChain {
  return new StubSeedChain().hold(PARENT, pub(0));
}

/** Runs keysFromSeed with PHRASE and returns the lines it logged. */
async function run(cfg: SwarmConfig, chain: SeedChain, gatewayEnv: string | null = null): Promise<string[]> {
  const lines: string[] = [];
  await keysFromSeed(cfg, PHRASE, { chain, log: (line) => lines.push(line) }, { gatewayEnv });
  return lines;
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

/** Every file and folder under the temporary folder, relative to it, sorted. */
async function written(): Promise<string[]> {
  return (await readdir(dir, { recursive: true })).sort();
}

/** Each file under the temporary folder, with its content and its modification time. */
async function snapshot(): Promise<Record<string, [content: string, mtimeMs: number]>> {
  const files: Record<string, [string, number]> = {};
  for (const entry of await written()) {
    const info = await stat(join(dir, entry));
    if (info.isFile()) files[entry] = [await readFile(join(dir, entry), 'utf8'), info.mtimeMs];
  }
  return files;
}

const keyFile = (accountId: string): string => keyFilePath(join(dir, 'keys'), 'near:testnet', accountId);
const relayerFolder = (): string => keyFolderPath(join(dir, 'keys'), 'near:testnet', RELAYER);

describe('readSeedPhrase', () => {
  it('reads QUORUM_SEED_PHRASE, split on any whitespace, lowercased and joined with single spaces', async () => {
    expect(await readSeedPhrase({ QUORUM_SEED_PHRASE: MESSY })).toBe(PHRASE);
  });

  it('reads the file QUORUM_SEED_PHRASE_FILE names', async () => {
    const path = join(dir, 'phrase.txt');
    await writeFile(path, `${PHRASE.replaceAll(' ', '\n')}\n`);
    expect(await readSeedPhrase({ QUORUM_SEED_PHRASE_FILE: path })).toBe(PHRASE);
  });

  it('accepts a phrase of 24 words', async () => {
    expect(await readSeedPhrase({ QUORUM_SEED_PHRASE: PHRASE_24 })).toBe(PHRASE_24);
  });

  it('refuses both variables at once, naming them and quoting neither', async () => {
    const path = join(dir, 'phrase.txt');
    await writeFile(path, PHRASE);
    const error = await rejection(readSeedPhrase({ QUORUM_SEED_PHRASE: PHRASE, QUORUM_SEED_PHRASE_FILE: path }));
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toBe('QUORUM_SEED_PHRASE and QUORUM_SEED_PHRASE_FILE are both set: set only one of them');
  });

  it.each<Env>([{}, { QUORUM_SEED_PHRASE: '', QUORUM_SEED_PHRASE_FILE: '' }])('refuses %j: neither variable is set', async (env) => {
    const error = await rejection(readSeedPhrase(env));
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toBe(
      'QUORUM_SEED_PHRASE or QUORUM_SEED_PHRASE_FILE is required: the seed phrase, or the absolute path of a file that holds it',
    );
  });

  it.each([0, 1, 11, 13, 23, 25])('refuses a phrase of %i words, giving the count and no word of it', async (count) => {
    const error = await rejection(readSeedPhrase({ QUORUM_SEED_PHRASE: ` ${'abandon '.repeat(count)}` }));
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toBe(`QUORUM_SEED_PHRASE must hold a phrase of 12 or 24 words, not ${count}`);
  });

  it('names the file whose phrase does not have 12 or 24 words, and quotes nothing of it', async () => {
    const path = join(dir, 'phrase.txt');
    await writeFile(path, 'abandon about\n');
    const error = await rejection(readSeedPhrase({ QUORUM_SEED_PHRASE_FILE: path }));
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toBe(`the file QUORUM_SEED_PHRASE_FILE names, ${path}, must hold a phrase of 12 or 24 words, not 2`);
  });

  it('refuses a QUORUM_SEED_PHRASE_FILE that is not an absolute path without quoting it: it may be a phrase set there by mistake', async () => {
    const error = await rejection(readSeedPhrase({ QUORUM_SEED_PHRASE_FILE: PHRASE }));
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toBe('QUORUM_SEED_PHRASE_FILE must be an absolute path');
  });

  it('names a file it cannot read, with the reason', async () => {
    const path = join(dir, 'missing.txt');
    const error = await rejection(readSeedPhrase({ QUORUM_SEED_PHRASE_FILE: path }));
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toBe(`QUORUM_SEED_PHRASE_FILE names ${path}, which cannot be read (ENOENT)`);
  });
});

describe('parentPublicKey', () => {
  it("is the key at m/44'/397'/0' of the phrase, however it is written", () => {
    expect(parentPublicKey(MESSY)).toBe(pub(0));
  });
});

describe('keysFromSeed: the accounts', () => {
  it.each<[string, string]>([
    ['QUORUM_POOLS_ACCOUNT', 'pools.elsewhere.testnet'],
    ['QUORUM_RELAYER_ACCOUNT', 'relay.testnet'],
    ['QUORUM_PROVIDER_ACCOUNT', `seller.${PROVIDER}`],
    ['QUORUM_MCP_ACCOUNT', 'agent.testnet'],
    ['QUORUM_FUNDING_ACCOUNT', 'bank.testnet'],
  ])('refuses %s=%s, not a direct sub-account of the parent, before it reads the chain', async (name, id) => {
    const chain = parentOnly();
    const error = await rejection(run(config({ [name]: id }), chain));
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toContain(`${name} must be a direct sub-account of QUORUM_PARENT_ACCOUNT ${PARENT}`);
    expect((error as Error).message).toContain(`got ${JSON.stringify(id)}`);
    expect(chain.reads).toEqual([]);
    expect(await written()).toEqual([]);
  });

  it('accepts a funding account that is the parent: it signs with the parent key, and no key is derived for it', async () => {
    const lines = await run(config({ QUORUM_FUNDING_ACCOUNT: PARENT }), parentOnly());
    expect(lines.filter((line) => line.startsWith(`${PARENT} `))).toEqual([`${PARENT}  ${pub(0)}`]);
    expect(lines.join('\n')).not.toContain(pub(1));
    expect(lines.some((line) => line.startsWith(`${FUNDING} `))).toBe(false);
    expect((await readKeyFile(keyFile(PARENT))).toString()).toBe(key(0).keyPair.toString());
    expect(await written()).not.toContain(join('keys', 'testnet', `${FUNDING}.json`));
  });

  it.each([0, 91])('refuses a relayer key count of %i, naming QUORUM_RELAYER_KEY_COUNT, before it reads the chain', async (count) => {
    const chain = parentOnly();
    const error = await rejection(run({ ...config(), relayerKeyCount: count }, chain));
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toBe(
      `QUORUM_RELAYER_KEY_COUNT must be from 1 to 90 for the relayer's keys to be derived from the seed phrase, got "${count}"`,
    );
    expect(chain.reads).toEqual([]);
    expect(await written()).toEqual([]);
  });

  it("accepts 90 relayer keys, at m/44'/397'/10' to m/44'/397'/99'", async () => {
    const lines = await run(config({ QUORUM_RELAYER_KEY_COUNT: '90' }), parentOnly());
    const relayer = lines.filter((line) => line.startsWith(`${RELAYER} `));
    expect(relayer).toHaveLength(90);
    expect(relayer[0]).toBe(`${RELAYER}  ${pub(10)}`);
    expect(relayer[89]).toBe(`${RELAYER}  ${pub(99)}`);
  });
});

describe('keysFromSeed: the chain check', () => {
  it('checks the chain id first, and refuses another chain than QUORUM_NETWORK names, writing nothing', async () => {
    const chain = parentOnly();
    chain.nodeChainId = 'mainnet';
    const error = await rejection(run(config(), chain, join(dir, 'gateway.env')));
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toContain('"mainnet"');
    expect(chain.reads).toEqual(['chainId']);
    expect(await written()).toEqual([]);
  });

  it("reads the parent's key, then whether each other account exists, and the keys of those that do", async () => {
    const chain = parentOnly().hold(PROVIDER, pub(3));
    await run(config(), chain);
    expect(chain.reads).toEqual([
      'chainId',
      `key ${PARENT} ${pub(0)}`,
      `account ${FUNDING}`,
      `account ${POOLS}`,
      `account ${RELAYER}`,
      `account ${PROVIDER}`,
      `key ${PROVIDER} ${pub(3)}`,
      ...BUYERS.map((id) => `account ${id}`),
      `account ${MCP_BUYER}`,
    ]);
  });

  /** Expects the parent to be refused with `found`, and nothing written. */
  async function expectParentRefused(chain: StubSeedChain, found: string): Promise<void> {
    const error = await rejection(run(config(), chain, join(dir, 'gateway.env')));
    expect(error).toBeInstanceOf(KeysFromSeedError);
    expect((error as Error).message).toBe(
      `the seed phrase does not hold a full-access key of the parent account ${PARENT} (QUORUM_PARENT_ACCOUNT): ` +
        `it gives ${pub(0)} at m/44'/397'/0', ${found}`,
    );
    expect(await written()).toEqual([]);
  }

  it('refuses a parent that holds the key without full access, and writes nothing', async () => {
    await expectParentRefused(new StubSeedChain().hold(PARENT, pub(0), 'other'), 'which the account holds without full access');
  });

  it('refuses a parent that does not hold the key, and writes nothing', async () => {
    await expectParentRefused(new StubSeedChain().hold(PARENT, randomKey()), 'which the account does not hold');
  });

  it('refuses a parent account that does not exist, and writes nothing', async () => {
    await expectParentRefused(new StubSeedChain(), 'which the account does not hold');
  });

  it('refuses an existing account that lacks its derived key, naming the account and the key, and writes nothing', async () => {
    const chain = parentOnly().hold(PROVIDER, randomKey());
    const error = await rejection(run(config(), chain, join(dir, 'gateway.env')));
    expect(error).toBeInstanceOf(KeysFromSeedError);
    expect((error as Error).message).toBe(
      `${PROVIDER} exists, but does not hold ${pub(3)}, the key the seed phrase gives it at m/44'/397'/3': ` +
        'the account was set up with another phrase or other keys',
    );
    expect(await written()).toEqual([]);
  });

  it('refuses a relayer that lacks one of its keys, naming that key, and writes nothing', async () => {
    const chain = parentOnly().hold(RELAYER, pub(10));
    const error = await rejection(run(config(), chain));
    expect(error).toBeInstanceOf(KeysFromSeedError);
    expect((error as Error).message).toContain(`${RELAYER} exists, but does not hold ${pub(11)}, the key the seed phrase gives it at m/44'/397'/11'`);
    expect(await written()).toEqual([]);
  });

  it('accepts existing accounts that hold their derived keys, other keys besides, and skips those that do not exist yet', async () => {
    const chain = parentOnly()
      .hold(FUNDING, pub(1))
      .hold(POOLS, pub(2))
      .hold(RELAYER, pub(10))
      .hold(RELAYER, pub(11))
      .hold(PROVIDER, pub(3))
      .hold(PROVIDER, randomKey())
      .hold(BUYER_01, pub(101));
    await run(config(), chain);
    expect((await readKeyFile(keyFile(PROVIDER))).toString()).toBe(key(3).keyPair.toString());
    expect((await readKeyFile(keyFile(MCP_BUYER))).toString()).toBe(key(199).keyPair.toString());
  });

  it('fails with the error of an RPC that cannot be read, and writes nothing', async () => {
    const chain = parentOnly();
    chain.down = true;
    const error = await rejection(run(config(), chain, join(dir, 'gateway.env')));
    expect((error as Error).message).toBe('fetch failed');
    expect(await written()).toEqual([]);
  });
});

describe('keysFromSeed: the key files', () => {
  it.each<[string, number]>([
    [PARENT, 0],
    [FUNDING, 1],
    [POOLS, 2],
    [PROVIDER, 3],
    [RELAYER, 10],
    [BUYER_01, 101],
    [`buyer-02.${PARENT}`, 102],
    [`buyer-20.${PARENT}`, 120],
    [MCP_BUYER, 199],
  ])("writes the key file of %s with the key at m/44'/397'/%i'", async (accountId, index) => {
    await run(config(), parentOnly());
    expect((await readKeyFile(keyFile(accountId))).toString()).toBe(key(index).keyPair.toString());
    expect(JSON.parse(await readFile(keyFile(accountId), 'utf8'))).toMatchObject({ account_id: accountId, public_key: pub(index) });
  });

  it("writes the relayer's key folder, one file per key, each named after its key", async () => {
    await run(config(), parentOnly());
    const keys = await readKeyFolder(relayerFolder());
    expect(keys.map((keyPair) => keyPair.toString()).sort()).toEqual([key(10).keyPair.toString(), key(11).keyPair.toString()].sort());
    const second = await readKeyFile(folderKeyPath(relayerFolder(), key(11).keyPair.getPublicKey()));
    expect(second.toString()).toBe(key(11).keyPair.toString());
  });

  it("writes nothing else: each account's key file and the relayer's key folder", async () => {
    await run(config(), parentOnly());
    const testnet = join('keys', 'testnet');
    const accounts = [PARENT, FUNDING, POOLS, RELAYER, PROVIDER, ...BUYERS, MCP_BUYER];
    expect(await written()).toEqual(
      [
        'keys',
        testnet,
        ...accounts.map((id) => join(testnet, `${id}.json`)),
        join(testnet, RELAYER),
        ...[10, 11].map((index) => join(testnet, RELAYER, `${pub(index).replace(':', '_')}.json`)),
      ].sort(),
    );
  });

  it.skipIf(process.platform === 'win32')('makes each key file readable by its owner only', async () => {
    await run(config(), parentOnly());
    const files = (await written()).filter((entry) => entry.endsWith('.json'));
    expect(files).toHaveLength(28);
    for (const entry of files) expect((await stat(join(dir, entry))).mode & 0o777).toBe(0o600);
  });

  it('prints one line per key, the account then its public key, the relayer once per key, the credential key last', async () => {
    expect(await run(config(), parentOnly())).toEqual([
      `${PARENT}  ${pub(0)}`,
      `${FUNDING}  ${pub(1)}`,
      `${POOLS}  ${pub(2)}`,
      `${RELAYER}  ${pub(10)}`,
      `${RELAYER}  ${pub(11)}`,
      `${PROVIDER}  ${pub(3)}`,
      ...BUYERS.map((id, i) => `${id}  ${pub(101 + i)}`),
      `${MCP_BUYER}  ${pub(199)}`,
      `credential  ${credentialJwk(SEED).x}`,
    ]);
  });

  it('changes nothing when run again: every file keeps its content and its time, and the lines are the same', async () => {
    const envPath = join(dir, 'gateway.env');
    const first = await run(config(), parentOnly(), envPath);
    const before = await snapshot();
    expect(await run(config(), parentOnly(), envPath)).toEqual(first);
    expect(await snapshot()).toEqual(before);
  });

  it('leaves alone a key file that holds the same key, in the form near-cli-rs writes', async () => {
    const text = `${JSON.stringify({ public_key: pub(0), private_key: key(0).keyPair.toString() })}\n`;
    await mkdir(dirname(keyFile(PARENT)), { recursive: true });
    await writeFile(keyFile(PARENT), text);
    await run(config(), parentOnly());
    expect(await readFile(keyFile(PARENT), 'utf8')).toBe(text);
  });

  it('refuses a key file that holds another key, naming it, leaves it as it is and writes nothing', async () => {
    const other = KeyPair.fromRandom('ed25519');
    await writeKeyFile(keyFile(PROVIDER), PROVIDER, other);
    const error = await rejection(run(config(), parentOnly(), join(dir, 'gateway.env')));
    expect(error).toBeInstanceOf(KeysFromSeedError);
    expect((error as Error).message).toBe(
      `the key file ${keyFile(PROVIDER)} holds another key than the seed phrase gives ${PROVIDER}; it is left as it is`,
    );
    expect((await readKeyFile(keyFile(PROVIDER))).toString()).toBe(other.toString());
    expect(await written()).toEqual(['keys', join('keys', 'testnet'), join('keys', 'testnet', `${PROVIDER}.json`)].sort());
  });

  it("refuses a relayer key file that holds another of the relayer's keys than its first", async () => {
    await writeKeyFile(keyFile(RELAYER), RELAYER, key(11).keyPair);
    const error = await rejection(run(config(), parentOnly()));
    expect(error).toBeInstanceOf(KeysFromSeedError);
    expect((error as Error).message).toContain(`the key file ${keyFile(RELAYER)} holds another key`);
  });

  it('replaces an empty key file, which a write cut short leaves', async () => {
    await mkdir(dirname(keyFile(POOLS)), { recursive: true });
    await writeFile(keyFile(POOLS), '');
    await run(config(), parentOnly());
    expect((await readKeyFile(keyFile(POOLS))).toString()).toBe(key(2).keyPair.toString());
  });
});

describe('keysFromSeed: the gateway env file', () => {
  it("writes the relayer's keys in path order and the credential key, which the gateway's own loader reads", async () => {
    const path = join(dir, 'gateway.env');
    await run(config(), parentOnly(), path);
    const values = parseEnv(await readFile(path, 'utf8'));
    expect(Object.keys(values).sort()).toEqual(['QUORUM_CREDENTIAL_JWK', 'QUORUM_RELAYER_KEYS']);
    const gateway = loadConfig({ QUORUM_PARENT_ACCOUNT: PARENT, ...values });
    expect(gateway.relayerKeys).toEqual([key(10).keyPair.toString(), key(11).keyPair.toString()]);
    expect(gateway.credentialJwk).toEqual(credentialJwk(SEED));
  });

  it.skipIf(process.platform === 'win32')('makes the env file readable by its owner only', async () => {
    const path = join(dir, 'gateway.env');
    await run(config(), parentOnly(), path);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it('writes the same file from the same phrase: a credential issued before a restart still verifies after it', async () => {
    await run(config(), parentOnly(), join(dir, 'first.env'));
    await run(config(), parentOnly(), join(dir, 'second.env'));
    expect(await readFile(join(dir, 'second.env'), 'utf8')).toBe(await readFile(join(dir, 'first.env'), 'utf8'));
  });

  it('refuses an env file with other content, naming it, leaves it as it is and writes no key file', async () => {
    const path = join(dir, 'gateway.env');
    await writeFile(path, 'KEPT=1\n');
    const error = await rejection(run(config(), parentOnly(), path));
    expect(error).toBeInstanceOf(KeysFromSeedError);
    expect((error as Error).message).toBe(
      `the env file ${path} holds something else than the seed phrase gives; it is left as it is: remove it to write it again`,
    );
    expect(await readFile(path, 'utf8')).toBe('KEPT=1\n');
    expect(await written()).toEqual(['gateway.env']);
  });

  it('puts no part of the phrase in any file it writes, nor in its lines', async () => {
    const lines = await run(config(), parentOnly(), join(dir, 'gateway.env'));
    expect(lines.join('\n')).not.toContain('abandon');
    for (const entry of await written()) {
      const path = join(dir, entry);
      if ((await stat(path)).isFile()) expect(await readFile(path, 'utf8')).not.toContain('abandon');
    }
  });
});

/** A base58 block hash, for the RPC errors the tests throw. */
const BLOCK_HASH = '11111111111111111111111111111111';
const OPTIMISTIC = { finality: 'optimistic' };

/** An RpcSeedChain over a provider that answers each method with `answers[method]()`, recording each read. */
function rpcWith(answers: Record<string, () => unknown>) {
  const reads: Array<[method: string, params: unknown]> = [];
  const read = async (method: string, params: unknown): Promise<unknown> => {
    reads.push([method, params]);
    const answer = answers[method];
    if (answer === undefined) throw new Error(`no answer for ${method}`);
    return answer();
  };
  const provider = {
    viewNodeStatus: () => read('viewNodeStatus', undefined),
    viewAccount: (params: unknown) => read('viewAccount', params),
    viewAccessKey: (params: unknown) => read('viewAccessKey', params),
  };
  return { chain: new RpcSeedChain(provider as unknown as Provider), reads };
}

describe('RpcSeedChain', () => {
  it('chainId reads the node status', async () => {
    const { chain } = rpcWith({ viewNodeStatus: () => ({ chain_id: 'testnet' }) });
    expect(await chain.chainId()).toBe('testnet');
  });

  it('accountExists reads the account at optimistic finality: true when it exists, false when the RPC says it does not', async () => {
    const exists = rpcWith({ viewAccount: () => ({ amount: 1n, code_hash: BLOCK_HASH, storage_usage: 182 }) });
    expect(await exists.chain.accountExists(PROVIDER)).toBe(true);
    expect(exists.reads).toEqual([['viewAccount', { accountId: PROVIDER, blockQuery: OPTIMISTIC }]]);
    const missing = rpcWith({
      viewAccount: () => {
        throw new AccountDoesNotExistError(PROVIDER, BLOCK_HASH, 1_000);
      },
    });
    expect(await missing.chain.accountExists(PROVIDER)).toBe(false);
  });

  it('accountExists passes on any other error', async () => {
    const { chain } = rpcWith({
      viewAccount: () => {
        throw new UnknownBlockError();
      },
    });
    await expect(chain.accountExists(PROVIDER)).rejects.toBeInstanceOf(UnknownBlockError);
  });

  it('accessKey reads the key at optimistic finality: full_access for a full-access key, other for any other', async () => {
    const full = rpcWith({ viewAccessKey: () => ({ nonce: 1n, permission: 'FullAccess' }) });
    expect(await full.chain.accessKey(PARENT, pub(0))).toBe('full_access');
    expect(full.reads).toEqual([['viewAccessKey', { accountId: PARENT, publicKey: pub(0), finalityQuery: OPTIMISTIC }]]);
    const limited = rpcWith({
      viewAccessKey: () => ({ nonce: 1n, permission: { FunctionCall: { receiver_id: POOLS, method_names: [] } } }),
    });
    expect(await limited.chain.accessKey(PARENT, pub(0))).toBe('other');
  });

  it('accessKey is null when the RPC says the key, or the account, does not exist', async () => {
    const noKey = rpcWith({
      viewAccessKey: () => {
        throw new AccessKeyDoesNotExistError(PublicKey.fromString(pub(0)), BLOCK_HASH, 1_000);
      },
    });
    expect(await noKey.chain.accessKey(PARENT, pub(0))).toBeNull();
    const noAccount = rpcWith({
      viewAccessKey: () => {
        throw new AccountDoesNotExistError(PARENT, BLOCK_HASH, 1_000);
      },
    });
    expect(await noAccount.chain.accessKey(PARENT, pub(0))).toBeNull();
  });

  it('accessKey passes on any other error, such as a request that failed', async () => {
    const { chain } = rpcWith({
      viewAccessKey: () => {
        throw new Error('fetch failed');
      },
    });
    await expect(chain.accessKey(PARENT, pub(0))).rejects.toThrow('fetch failed');
  });
});
