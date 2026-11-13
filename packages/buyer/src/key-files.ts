import { mkdir, open, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { isAccountId } from '@quorum-on-near/protocol';
import { KeyPair, type KeyPairString, type PublicKey } from 'near-api-js';
import type { BuyerNetwork } from './settings.ts';

/**
 * Key files in near-cli's legacy keychain layout: `<dir>/<network>/<account>.json` for an account's
 * key, and `<dir>/<network>/<account>/<public key>.json`, one file per key, for an account with
 * several keys (near-cli-rs writes both forms when it saves a key to the legacy keychain).
 */

/** The keychain's folder for each network. */
const NETWORK_FOLDERS: Record<BuyerNetwork, string> = {
  'near:testnet': 'testnet',
  'near:sandbox': 'sandbox',
};

/** What is wrong with a key file: there is none, there is one already, or it cannot be read as a key. */
export type KeyFileProblem = 'missing' | 'exists' | 'invalid';

/**
 * A key file or key folder that is missing, already exists, or does not hold a key. The message names
 * the path and never quotes the file's content.
 */
export class KeyFileError extends Error {
  override name = 'KeyFileError';
  readonly path: string;
  readonly problem: KeyFileProblem;

  constructor(path: string, problem: KeyFileProblem, message: string) {
    super(message);
    this.path = path;
    this.problem = problem;
  }
}

/** near-cli's credentials folder, `~/.near-credentials`. */
export function defaultCredentialsDir(): string {
  return join(homedir(), '.near-credentials');
}

/** `<dir>/<network>/<accountId>.json`. Throws RangeError unless `accountId` is a NEAR account id. */
export function keyFilePath(dir: string, network: BuyerNetwork, accountId: string): string {
  return `${keyFolderPath(dir, network, accountId)}.json`;
}

/**
 * `<dir>/<network>/<accountId>`: the folder of an account with several keys. Throws RangeError unless
 * `accountId` is a NEAR account id, which holds no path separator and no `..`.
 */
export function keyFolderPath(dir: string, network: BuyerNetwork, accountId: string): string {
  if (!isAccountId(accountId)) throw new RangeError(`not a NEAR account id: ${JSON.stringify(accountId)}`);
  return join(dir, NETWORK_FOLDERS[network], accountId);
}

/** The file of one key in an account's key folder: `<folder>/<public key with ':' as '_'>.json`. */
export function folderKeyPath(folder: string, publicKey: PublicKey): string {
  return join(folder, folderKeyName(publicKey));
}

/**
 * Reads the key pair in a key file: the JSON that near-cli-rs writes (`public_key`, `private_key`
 * and seed-phrase fields, no `account_id`) or that writeKeyFile and the older near-cli write
 * (`account_id`, `public_key`, `private_key`). Reads `private_key`, or `secret_key` when it is absent,
 * and checks that `public_key`, when present, is that key's. Throws KeyFileError (`missing` or
 * `invalid`) otherwise. An empty file is `missing`: it is what a write cut short between creating the
 * file and writing it leaves, and it holds no key.
 */
export async function readKeyFile(path: string): Promise<KeyPair> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') throw new KeyFileError(path, 'missing', `there is no key file at ${path}`);
    throw error;
  }
  if (text === '') throw new KeyFileError(path, 'missing', `the key file ${path} is empty: a write was cut short`);
  return parseKeyFile(text, path);
}

/**
 * Writes `{account_id, public_key, private_key}` to a new file readable by its owner only (mode
 * 0o600), creating its folder (mode 0o700) if needed. The file is flushed to disk before the promise
 * resolves, and on POSIX systems its folder is synced too, so that a key written before the
 * transaction that funds it survives a crash of the machine, not only of the process. Never
 * overwrites a file that holds anything: throws KeyFileError (`exists`) if there is one. An empty file
 * holds no key (see readKeyFile), so it is replaced, once. The modes apply on POSIX systems; Windows
 * keeps only a read-only flag.
 */
export async function writeKeyFile(path: string, accountId: string, keyPair: KeyPair): Promise<void> {
  const content = { account_id: accountId, public_key: keyPair.getPublicKey().toString(), private_key: keyPair.toString() };
  const text = `${JSON.stringify(content)}\n`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    await writeNew(path, text);
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error;
    if ((await stat(path)).size !== 0) throw new KeyFileError(path, 'exists', `there is a key file at ${path} already`);
    await unlink(path);
    try {
      await writeNew(path, text);
    } catch (again) {
      if (errorCode(again) === 'EEXIST') throw new KeyFileError(path, 'exists', `there is a key file at ${path} already`);
      throw again;
    }
  }
  await syncFolder(dirname(path));
}

/** Creates `path` with `text`, failing with EEXIST if it exists, and flushes it to disk. */
function writeNew(path: string, text: string): Promise<void> {
  return writeFile(path, text, { flag: 'wx', mode: 0o600, flush: true });
}

/** The errors of a file system that cannot sync a folder, which leave the file itself written. */
const UNSYNCABLE_FOLDER: ReadonlySet<unknown> = new Set(['EISDIR', 'EINVAL', 'EPERM', 'ENOTSUP']);

/**
 * Syncs a folder, so that a file just created in it is still listed after a power loss. Skipped on
 * Windows, which cannot open a folder to sync it; ignored where the file system refuses it.
 */
async function syncFolder(folder: string): Promise<void> {
  if (process.platform === 'win32') return;
  try {
    const handle = await open(folder, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (!UNSYNCABLE_FOLDER.has(errorCode(error))) throw error;
  }
}

/**
 * Reads every `.json` file of an account's key folder as a key file, sorted by public key. Each file
 * must be named after its key (folderKeyPath), so no key is listed twice. Other entries are skipped,
 * and so is a file that readKeyFile reports `missing`: an empty one, which a write cut short leaves,
 * or one removed since the folder was listed. Throws KeyFileError: `missing` for a missing folder, or
 * readKeyFile's error for a file.
 */
export async function readKeyFolder(folder: string): Promise<KeyPair[]> {
  let names: string[];
  try {
    const entries = await readdir(folder, { withFileTypes: true });
    names = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.json')).map((entry) => entry.name);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') throw new KeyFileError(folder, 'missing', `there is no key folder at ${folder}`);
    throw error;
  }
  const keys: { publicKey: string; keyPair: KeyPair }[] = [];
  for (const name of names) {
    const path = join(folder, name);
    let keyPair: KeyPair;
    try {
      keyPair = await readKeyFile(path);
    } catch (error) {
      if (error instanceof KeyFileError && error.problem === 'missing') continue;
      throw error;
    }
    if (folderKeyName(keyPair.getPublicKey()) !== name) {
      throw new KeyFileError(path, 'invalid', `the key file ${path} is not named after its public key`);
    }
    keys.push({ publicKey: keyPair.getPublicKey().toString(), keyPair });
  }
  keys.sort((a, b) => (a.publicKey < b.publicKey ? -1 : a.publicKey > b.publicKey ? 1 : 0));
  return keys.map((key) => key.keyPair);
}

function folderKeyName(publicKey: PublicKey): string {
  return `${publicKey.toString().replace(':', '_')}.json`;
}

/** The key pair in a key file's text. Nothing the parsers throw is kept: their messages may quote the key. */
function parseKeyFile(text: string, path: string): KeyPair {
  const invalid = (why: string): KeyFileError => new KeyFileError(path, 'invalid', `the key file ${path} ${why}`);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw invalid('is not JSON');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalid('is not a JSON object');
  const fields = value as Record<string, unknown>;
  const privateKey = fields.private_key ?? fields.secret_key;
  if (typeof privateKey !== 'string') throw invalid('has no private_key or secret_key string');
  let keyPair: KeyPair;
  try {
    keyPair = KeyPair.fromString(privateKey as KeyPairString);
  } catch {
    throw invalid('holds a private key that is not a NEAR key');
  }
  if (fields.public_key !== undefined && fields.public_key !== keyPair.getPublicKey().toString()) {
    throw invalid('holds a public_key that is not the public key of its private key');
  }
  return keyPair;
}

function errorCode(error: unknown): unknown {
  return (error as NodeJS.ErrnoException | null)?.code;
}
