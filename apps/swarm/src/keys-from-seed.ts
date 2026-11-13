import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import {
  ConfigError,
  folderKeyPath,
  KeyFileError,
  keyFilePath,
  keyFolderPath,
  readKeyFile,
  writeKeyFile,
  type BuyerSettings,
  type Env,
} from '@quorum-on-near/buyer';
import { JsonRpcProvider, type KeyPair, type Provider } from 'near-api-js';
import { AccessKeyDoesNotExistError, AccountDoesNotExistError } from 'near-api-js/rpc-errors';
import { isSubAccount, scriptedBuyerIds } from './accounts.ts';
import { checkChain } from './chain.ts';
import type { SwarmConfig } from './config.ts';
import { gatewaySecretsEnvText, writeEnvFile, type CredentialJwk } from './env-files.ts';
import {
  bip39Seed,
  credentialJwk,
  FUNDING_PATH,
  MAX_RELAYER_KEYS,
  MCP_BUYER_PATH,
  nearKey,
  normalisePhrase,
  PARENT_PATH,
  POOLS_PATH,
  PROVIDER_PATH,
  relayerKeyPath,
  scriptedBuyerPath,
  SeedPhraseError,
  type NearKey,
} from './seed.ts';

/**
 * `swarm keys from-seed`: every key file the swarm reads, and optionally the gateway's two secrets,
 * derived from one BIP-39 phrase (seed.ts) and checked against the chain before anything is written.
 * The phrase is never printed, logged or put in a message, and neither is a private key.
 */

/**
 * Why `swarm keys from-seed` refused: the chain does not hold a derived key, or a file holds something
 * else. Messages name accounts, public keys and files, never a private key or the phrase.
 */
export class KeysFromSeedError extends Error {
  override name = 'KeysFromSeedError';
}

/** How an account holds a public key: as a full-access key, or with any other permission (a function-call key, a gas key). */
export type KeyPermission = 'full_access' | 'other';

/** What `swarm keys from-seed` reads from the chain. */
export interface SeedChain {
  /** The `chain_id` the RPC node reports, for checkChain. */
  chainId(): Promise<string>;
  /** Whether the account exists, at optimistic finality. */
  accountExists(accountId: string): Promise<boolean>;
  /** How the account holds `publicKey`, at optimistic finality; null when it does not, or when the account does not exist. */
  accessKey(accountId: string, publicKey: string): Promise<KeyPermission | null>;
}

const OPTIMISTIC = { finality: 'optimistic' } as const;

/**
 * SeedChain over near-api-js's JSON-RPC provider: the node status, then `view_account` and
 * `view_access_key` queries at optimistic finality.
 */
export class RpcSeedChain implements SeedChain {
  readonly #provider: Provider;

  constructor(provider: Provider) {
    this.#provider = provider;
  }

  async chainId(): Promise<string> {
    return (await this.#provider.viewNodeStatus()).chain_id;
  }

  async accountExists(accountId: string): Promise<boolean> {
    try {
      await this.#provider.viewAccount({ accountId, blockQuery: OPTIMISTIC });
      return true;
    } catch (error) {
      if (error instanceof AccountDoesNotExistError) return false;
      throw error;
    }
  }

  async accessKey(accountId: string, publicKey: string): Promise<KeyPermission | null> {
    try {
      const { permission } = await this.#provider.viewAccessKey({ accountId, publicKey, finalityQuery: OPTIMISTIC });
      return permission === 'FullAccess' ? 'full_access' : 'other';
    } catch (error) {
      // A node may answer a key of a missing account either way.
      if (error instanceof AccessKeyDoesNotExistError || error instanceof AccountDoesNotExistError) return null;
      throw error;
    }
  }
}

/** An RpcSeedChain on `settings.rpcUrl`, with near-api-js's default retries: it only reads. */
export function createRpcSeedChain(settings: Pick<BuyerSettings, 'rpcUrl'>): RpcSeedChain {
  return new RpcSeedChain(new JsonRpcProvider({ url: settings.rpcUrl }));
}

/**
 * The phrase, from QUORUM_SEED_PHRASE or from the file QUORUM_SEED_PHRASE_FILE names (an absolute
 * path), normalised (normalisePhrase). An empty variable counts as unset. Throws ConfigError when both
 * are set or neither is, when the file cannot be read, or when the phrase does not have 12 or 24
 * words. No message quotes the phrase, nor QUORUM_SEED_PHRASE_FILE unless it is an absolute path,
 * which a phrase set there by mistake never is.
 */
export async function readSeedPhrase(env: Env): Promise<string> {
  const inline = env.QUORUM_SEED_PHRASE ?? '';
  const file = env.QUORUM_SEED_PHRASE_FILE ?? '';
  if (inline !== '' && file !== '') {
    throw new ConfigError(['QUORUM_SEED_PHRASE and QUORUM_SEED_PHRASE_FILE are both set: set only one of them']);
  }
  if (inline === '' && file === '') {
    throw new ConfigError([
      'QUORUM_SEED_PHRASE or QUORUM_SEED_PHRASE_FILE is required: the seed phrase, or the absolute path of a file that holds it',
    ]);
  }
  const raw = inline !== '' ? inline : await readPhraseFile(file);
  try {
    return normalisePhrase(raw);
  } catch (error) {
    if (!(error instanceof SeedPhraseError)) throw error;
    const source = inline !== '' ? 'QUORUM_SEED_PHRASE' : `the file QUORUM_SEED_PHRASE_FILE names, ${file},`;
    throw new ConfigError([`${source} must hold a phrase of 12 or 24 words, not ${error.words}`]);
  }
}

/** The text of the phrase file at `path`. Throws ConfigError for a path that is not absolute, or a file that cannot be read. */
async function readPhraseFile(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new ConfigError(['QUORUM_SEED_PHRASE_FILE must be an absolute path']);
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'an error';
    throw new ConfigError([`QUORUM_SEED_PHRASE_FILE names ${path}, which cannot be read (${code})`]);
  }
}

/** The parent's public key, `ed25519:<base58>`, from the phrase alone: what `--parent-key` prints. */
export function parentPublicKey(phrase: string): string {
  return nearKey(bip39Seed(normalisePhrase(phrase)), PARENT_PATH).publicKey;
}

/**
 * What makes the configuration unfit for derived keys, one line per problem, each naming its
 * setting: an account that is not a direct sub-account of the parent (only the funding account may
 * also be the parent itself), and a relayer key count outside 1 to MAX_RELAYER_KEYS.
 */
export function seedAccountProblems(config: SwarmConfig): string[] {
  const { parent } = config;
  const settings: Array<[name: string, id: string]> = [
    ['QUORUM_FUNDING_ACCOUNT', config.funding],
    ['QUORUM_POOLS_ACCOUNT', config.poolsContract],
    ['QUORUM_RELAYER_ACCOUNT', config.relayer],
    ['QUORUM_PROVIDER_ACCOUNT', config.provider],
    ['QUORUM_MCP_ACCOUNT', config.mcpAccount],
  ];
  const problems: string[] = [];
  for (const [name, id] of settings) {
    const funding = name === 'QUORUM_FUNDING_ACCOUNT';
    if (isSubAccount(id, parent) || (funding && id === parent)) continue;
    const allowed = `a direct sub-account of QUORUM_PARENT_ACCOUNT ${parent}${funding ? ', or that account itself,' : ''}`;
    problems.push(`${name} must be ${allowed} to have its key derived from the seed phrase, got ${JSON.stringify(id)}`);
  }
  const count = config.relayerKeyCount;
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_RELAYER_KEYS) {
    problems.push(
      `QUORUM_RELAYER_KEY_COUNT must be from 1 to ${MAX_RELAYER_KEYS} for the relayer's keys to be derived from the seed phrase, got "${count}"`,
    );
  }
  return problems;
}

/** An account whose keys the phrase gives. */
export interface SeedAccount {
  id: string;
  /** Its keys, in path order: the relayer's QUORUM_RELAYER_KEY_COUNT keys, one for every other account. */
  keys: NearKey[];
  /** True for the relayer: its keys go to its key folder, one file each, and the first to its key file too. */
  keyFolder: boolean;
}

/** Every key the phrase gives a configuration. */
export interface SeedKeys {
  /**
   * The parent first, then the funding account unless it is the parent, the pools account, the
   * relayer, the provider, the scripted buyers buyer-01 to buyer-20, and the MCP server's buyer.
   */
  accounts: SeedAccount[];
  /** The relayer's key pairs in path order, as QUORUM_RELAYER_KEYS lists them. */
  relayerKeys: KeyPair[];
  /** The gateway's credential key, QUORUM_CREDENTIAL_JWK. */
  credential: CredentialJwk;
}

/**
 * Derives every key of the configuration from the phrase, which it normalises (a phrase from
 * readSeedPhrase is already). Each key's path comes from its account's role, never from its name.
 * Throws RangeError for more relayer keys than MAX_RELAYER_KEYS, which seedAccountProblems refuses first.
 */
export function seedKeys(config: SwarmConfig, phrase: string): SeedKeys {
  const seed = bip39Seed(normalisePhrase(phrase));
  const single = (id: string, path: string): SeedAccount => ({ id, keys: [nearKey(seed, path)], keyFolder: false });
  const relayerKeys = Array.from({ length: config.relayerKeyCount }, (_, index) => nearKey(seed, relayerKeyPath(index)));
  const accounts: SeedAccount[] = [
    single(config.parent, PARENT_PATH),
    ...(config.funding === config.parent ? [] : [single(config.funding, FUNDING_PATH)]),
    single(config.poolsContract, POOLS_PATH),
    { id: config.relayer, keys: relayerKeys, keyFolder: true },
    single(config.provider, PROVIDER_PATH),
    ...scriptedBuyerIds(config.parent).map((id, index) => single(id, scriptedBuyerPath(index + 1))),
    single(config.mcpAccount, MCP_BUYER_PATH),
  ];
  return { accounts, relayerKeys: relayerKeys.map((key) => key.keyPair), credential: credentialJwk(seed) };
}

/** What keysFromSeed works with besides the configuration and the phrase. */
export interface KeysFromSeedDeps {
  chain: SeedChain;
  /** Receives the output: one line per key. */
  log: (line: string) => void;
}

/** The options of `swarm keys from-seed`. */
export interface KeysFromSeedOptions {
  /** `--gateway-env <path>`: where to write the gateway's env file of QUORUM_RELAYER_KEYS and QUORUM_CREDENTIAL_JWK; null for none. */
  gatewayEnv: string | null;
}

/**
 * `swarm keys from-seed`. In order, writing nothing before step 4:
 *
 * 1. Refuses the configuration with ConfigError, one line per setting, for seedAccountProblems.
 * 2. Checks the chain: the RPC's chain id (checkChain, ConfigError); the parent's derived key must be
 *    a full-access key of QUORUM_PARENT_ACCOUNT; every other account that exists must hold each of
 *    its derived keys, the relayer each of its QUORUM_RELAYER_KEY_COUNT keys. An account that does
 *    not exist yet is skipped: setup creates it with the key file written here. Throws
 *    KeysFromSeedError otherwise, and an RPC that cannot be read throws its own error.
 * 3. Reads every file it is to write, in the layout the swarm reads: each account's key file, and the
 *    relayer's key folder with one file per key, its first key also in its key file. A file that holds
 *    the same key is left alone; one that holds another key throws KeysFromSeedError naming it, and
 *    one that is not a key file throws readKeyFile's KeyFileError. With `gatewayEnv`, the env file
 *    (gatewaySecretsEnvText) is read in the same way: an identical one is left alone, any other throws.
 * 4. Writes each missing key file (writeKeyFile: created exclusively, mode 0o600, flushed), then the
 *    env file if it is missing (writeEnvFile: created exclusively, mode 0o600).
 * 5. Logs one line per key, `<account>  <public key>`, the relayer once per key, then
 *    `credential  <x>`: the credential key's public key as the gateway's /.well-known/jwks.json gives it.
 *
 * Running it again therefore changes nothing.
 */
export async function keysFromSeed(
  config: SwarmConfig,
  phrase: string,
  deps: KeysFromSeedDeps,
  options: KeysFromSeedOptions,
): Promise<void> {
  const problems = seedAccountProblems(config);
  if (problems.length > 0) throw new ConfigError(problems);
  const keys = seedKeys(config, phrase);
  await checkSeedChain(config, keys, deps.chain);

  const missing = await missingKeyFiles(keyFiles(config, keys.accounts));
  const env = options.gatewayEnv === null ? null : { path: options.gatewayEnv, text: gatewaySecretsEnvText(keys.relayerKeys, keys.credential) };
  const writeEnv = env !== null && (await envFileMissing(env.path, env.text));

  for (const file of missing) await writeKeyFile(file.path, file.accountId, file.keyPair);
  if (env !== null && writeEnv) await writeEnvFile(env.path, env.text);

  for (const account of keys.accounts) {
    for (const key of account.keys) deps.log(`${account.id}  ${key.publicKey}`);
  }
  deps.log(`credential  ${keys.credential.x}`);
}

/** Step 2 of keysFromSeed. */
async function checkSeedChain(config: SwarmConfig, { accounts }: SeedKeys, chain: SeedChain): Promise<void> {
  await checkChain(config.network, chain);
  const [parent, ...others] = accounts;
  const parentKey = parent?.keys[0];
  if (parent === undefined || parentKey === undefined) throw new RangeError('no key was derived for the parent');
  const permission = await chain.accessKey(parent.id, parentKey.publicKey);
  if (permission !== 'full_access') {
    const found = permission === null ? 'which the account does not hold' : 'which the account holds without full access';
    throw new KeysFromSeedError(
      `the seed phrase does not hold a full-access key of the parent account ${parent.id} (QUORUM_PARENT_ACCOUNT): ` +
        `it gives ${parentKey.publicKey} at ${parentKey.path}, ${found}`,
    );
  }
  for (const account of others) {
    if (!(await chain.accountExists(account.id))) continue;
    for (const key of account.keys) {
      if ((await chain.accessKey(account.id, key.publicKey)) !== null) continue;
      throw new KeysFromSeedError(
        `${account.id} exists, but does not hold ${key.publicKey}, the key the seed phrase gives it at ${key.path}: ` +
          'the account was set up with another phrase or other keys',
      );
    }
  }
}

/** A key file to hold `keyPair`, as writeKeyFile writes it. */
interface KeyFile {
  path: string;
  accountId: string;
  keyPair: KeyPair;
}

/** Every key file of `accounts`, in the layout the swarm reads (SeedAccount.keyFolder). */
function keyFiles(config: SwarmConfig, accounts: readonly SeedAccount[]): KeyFile[] {
  const { credentialsDir, network } = config;
  return accounts.flatMap(({ id, keys, keyFolder }): KeyFile[] => {
    const folder = keyFolderPath(credentialsDir, network, id);
    const inFolder = keyFolder
      ? keys.map(({ keyPair }) => ({ path: folderKeyPath(folder, keyPair.getPublicKey()), accountId: id, keyPair }))
      : [];
    const first = keys[0];
    if (first === undefined) return inFolder;
    return [...inFolder, { path: keyFilePath(credentialsDir, network, id), accountId: id, keyPair: first.keyPair }];
  });
}

/**
 * The files of `files` still to be written: those that do not exist, or are empty (writeKeyFile
 * replaces an empty file, which a write cut short leaves). A file that holds the same key is left
 * out; one that holds another key throws KeysFromSeedError naming it; readKeyFile's KeyFileError
 * passes on for a file that is not a key file.
 */
async function missingKeyFiles(files: readonly KeyFile[]): Promise<KeyFile[]> {
  const missing: KeyFile[] = [];
  for (const file of files) {
    let held: KeyPair;
    try {
      held = await readKeyFile(file.path);
    } catch (error) {
      if (!(error instanceof KeyFileError && error.problem === 'missing')) throw error;
      missing.push(file);
      continue;
    }
    if (held.getPublicKey().toString() !== file.keyPair.getPublicKey().toString()) {
      throw new KeysFromSeedError(`the key file ${file.path} holds another key than the seed phrase gives ${file.accountId}; it is left as it is`);
    }
  }
  return missing;
}

/**
 * Whether the env file at `path` is still to be written: true when there is none, false when it holds
 * `text` already. Throws KeysFromSeedError, naming it, when it holds anything else.
 */
async function envFileMissing(path: string, text: string): Promise<boolean> {
  let held: string;
  try {
    held = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
  if (held === text) return false;
  throw new KeysFromSeedError(
    `the env file ${path} holds something else than the seed phrase gives; it is left as it is: remove it to write it again`,
  );
}
