import { mkdir, mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { KeyPair } from 'near-api-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  defaultCredentialsDir,
  folderKeyPath,
  KeyFileError,
  keyFilePath,
  keyFolderPath,
  readKeyFile,
  readKeyFolder,
  writeKeyFile,
} from '../src/key-files.ts';

// writeFile and open record their calls; both still act on the disk.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, writeFile: vi.fn(actual.writeFile), open: vi.fn(actual.open) };
});

const ACCOUNT = 'buyer-01.parent.testnet';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'quorum-key-files-'));
});

afterEach(async () => {
  vi.mocked(open).mockClear();
  vi.mocked(writeFile).mockClear();
  await rm(dir, { recursive: true, force: true });
});

/** Runs `body` with process.platform reading `platform`. */
async function onPlatform(platform: NodeJS.Platform, body: () => Promise<void>): Promise<void> {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    await body();
  } finally {
    if (descriptor !== undefined) Object.defineProperty(process, 'platform', descriptor);
  }
}

/** The calls to open for `path`. */
function opened(path: string): unknown[][] {
  return vi.mocked(open).mock.calls.filter(([opened]) => opened === path);
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

/** Writes `content` as JSON to `name` in the temp folder and returns its path. */
async function jsonFile(name: string, content: unknown): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, JSON.stringify(content));
  return path;
}

/** The fields near-cli-rs writes to a legacy keychain file: no account_id. */
function nearCliRsFile(keyPair: KeyPair): Record<string, string> {
  return {
    implicit_account_id: Buffer.from(keyPair.getPublicKey().data).toString('hex'),
    master_seed_phrase: 'placeholder words, not read by readKeyFile',
    private_key: keyPair.toString(),
    public_key: keyPair.getPublicKey().toString(),
    seed_phrase_hd_path: "m/44'/397'/0'",
  };
}

describe('key file paths', () => {
  it('keyFilePath is <dir>/testnet/<account>.json on testnet and <dir>/sandbox/… on a sandbox', () => {
    expect(keyFilePath('/keys', 'near:testnet', ACCOUNT)).toBe(join('/keys', 'testnet', `${ACCOUNT}.json`));
    expect(keyFilePath('/keys', 'near:sandbox', 'test.near')).toBe(join('/keys', 'sandbox', 'test.near.json'));
  });

  it('keyFolderPath is <dir>/<network>/<account>, the folder of an account with several keys', () => {
    expect(keyFolderPath('/keys', 'near:testnet', 'relay.parent.testnet')).toBe(
      join('/keys', 'testnet', 'relay.parent.testnet'),
    );
  });

  it('refuses an account id that is not one, so that no path leaves the folder', () => {
    expect(() => keyFilePath('/keys', 'near:testnet', '../../evil')).toThrow(RangeError);
    expect(() => keyFolderPath('/keys', 'near:testnet', 'a/b')).toThrow(RangeError);
  });

  it("folderKeyPath names a key's file after its public key, with ':' replaced by '_'", () => {
    const keyPair = KeyPair.fromRandom('ed25519');
    const base58 = keyPair.getPublicKey().toString().slice('ed25519:'.length);
    expect(folderKeyPath('/keys/relay', keyPair.getPublicKey())).toBe(join('/keys/relay', `ed25519_${base58}.json`));
  });

  it("defaultCredentialsDir is near-cli's ~/.near-credentials", () => {
    expect(defaultCredentialsDir()).toBe(join(homedir(), '.near-credentials'));
  });
});

describe('writeKeyFile', () => {
  it('writes the account id and the key pair, which readKeyFile reads back', async () => {
    const keyPair = KeyPair.fromRandom('ed25519');
    const path = join(dir, 'testnet', `${ACCOUNT}.json`);
    await writeKeyFile(path, ACCOUNT, keyPair);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      account_id: ACCOUNT,
      public_key: keyPair.getPublicKey().toString(),
      private_key: keyPair.toString(),
    });
    expect((await readKeyFile(path)).toString()).toBe(keyPair.toString());
  });

  it('creates the missing folders', async () => {
    const path = join(dir, 'a', 'b', 'key.json');
    await writeKeyFile(path, ACCOUNT, KeyPair.fromRandom('ed25519'));
    expect((await stat(path)).isFile()).toBe(true);
  });

  it('flushes the file to disk as it writes it, so that it is there before the transaction that funds its key', async () => {
    const path = join(dir, 'key.json');
    await writeKeyFile(path, ACCOUNT, KeyPair.fromRandom('ed25519'));
    const calls = vi.mocked(writeFile).mock.calls.filter(([written]) => written === path);
    expect(calls).toEqual([[path, expect.any(String), { flag: 'wx', mode: 0o600, flush: true }]]);
  });

  it('replaces an empty file, which a write cut short leaves, with the new key', async () => {
    const path = join(dir, 'key.json');
    await writeFile(path, '');
    const keyPair = KeyPair.fromRandom('ed25519');
    await writeKeyFile(path, ACCOUNT, keyPair);
    expect((await readKeyFile(path)).toString()).toBe(keyPair.toString());
  });

  it('never overwrites a file that is not empty, even one that holds no key', async () => {
    const path = join(dir, 'key.json');
    await writeFile(path, '{');
    const error = await rejection(writeKeyFile(path, ACCOUNT, KeyPair.fromRandom('ed25519')));
    expect(error).toMatchObject({ name: 'KeyFileError', problem: 'exists', path });
    expect(await readFile(path, 'utf8')).toBe('{');
  });

  it("syncs the file's folder on POSIX systems, so that the new entry survives a power loss", async () => {
    const folder = join(dir, 'testnet');
    const path = join(folder, `${ACCOUNT}.json`);
    const handle = { sync: vi.fn(async () => {}), close: vi.fn(async () => {}) };
    vi.mocked(open).mockImplementationOnce(async () => handle as unknown as Awaited<ReturnType<typeof open>>);
    await onPlatform('linux', () => writeKeyFile(path, ACCOUNT, KeyPair.fromRandom('ed25519')));
    expect(opened(folder)).toEqual([[folder, 'r']]);
    expect(handle.sync).toHaveBeenCalledOnce();
    expect(handle.close).toHaveBeenCalledOnce();
  });

  it.each(['EISDIR', 'EINVAL', 'EPERM', 'ENOTSUP'])(
    'writes the key file when the file system refuses to sync a folder with %s',
    async (code) => {
      const path = join(dir, 'key.json');
      vi.mocked(open).mockImplementationOnce(async () => {
        throw Object.assign(new Error(`${code}: cannot sync`), { code });
      });
      const keyPair = KeyPair.fromRandom('ed25519');
      await onPlatform('linux', () => writeKeyFile(path, ACCOUNT, keyPair));
      expect((await readKeyFile(path)).toString()).toBe(keyPair.toString());
    },
  );

  it('passes on any other error from syncing the folder', async () => {
    const path = join(dir, 'key.json');
    const failure = Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
    vi.mocked(open).mockImplementationOnce(async () => {
      throw failure;
    });
    let error: unknown;
    await onPlatform('linux', async () => {
      error = await rejection(writeKeyFile(path, ACCOUNT, KeyPair.fromRandom('ed25519')));
    });
    expect(error).toBe(failure);
  });

  it('does not open the folder on Windows, which cannot sync one', async () => {
    const path = join(dir, 'key.json');
    await onPlatform('win32', () => writeKeyFile(path, ACCOUNT, KeyPair.fromRandom('ed25519')));
    expect(opened(dirname(path))).toEqual([]);
  });

  it('never overwrites a key file', async () => {
    const first = KeyPair.fromRandom('ed25519');
    const path = join(dir, 'key.json');
    await writeKeyFile(path, ACCOUNT, first);
    const error = await rejection(writeKeyFile(path, ACCOUNT, KeyPair.fromRandom('ed25519')));
    expect(error).toBeInstanceOf(KeyFileError);
    expect((error as KeyFileError).problem).toBe('exists');
    expect((error as KeyFileError).path).toBe(path);
    expect((await readKeyFile(path)).toString()).toBe(first.toString());
  });

  // Node applies only the read-only bit of a mode on Windows.
  it.skipIf(process.platform === 'win32')('makes the file readable by its owner only, and the folder too', async () => {
    const folder = join(dir, 'testnet');
    const path = join(folder, `${ACCOUNT}.json`);
    await writeKeyFile(path, ACCOUNT, KeyPair.fromRandom('ed25519'));
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(folder)).mode & 0o777).toBe(0o700);
  });
});

describe('readKeyFile', () => {
  it('reads the file near-cli-rs writes, which has no account_id', async () => {
    const keyPair = KeyPair.fromRandom('ed25519');
    const path = await jsonFile('near-cli-rs.json', nearCliRsFile(keyPair));
    expect((await readKeyFile(path)).toString()).toBe(keyPair.toString());
  });

  it('falls back to secret_key when there is no private_key', async () => {
    const keyPair = KeyPair.fromRandom('ed25519');
    const path = await jsonFile('secret-key-field.json', {
      account_id: ACCOUNT,
      public_key: keyPair.getPublicKey().toString(),
      secret_key: keyPair.toString(),
    });
    expect((await readKeyFile(path)).toString()).toBe(keyPair.toString());
  });

  it('reads a file without public_key', async () => {
    const keyPair = KeyPair.fromRandom('ed25519');
    const path = await jsonFile('no-public-key.json', { private_key: keyPair.toString() });
    expect((await readKeyFile(path)).toString()).toBe(keyPair.toString());
  });

  it('refuses a file whose public_key is not that of its private key, without quoting either', async () => {
    const keyPair = KeyPair.fromRandom('ed25519');
    const other = KeyPair.fromRandom('ed25519').getPublicKey().toString();
    const path = await jsonFile('mismatch.json', { private_key: keyPair.toString(), public_key: other });
    const error = await rejection(readKeyFile(path));
    expect(error).toBeInstanceOf(KeyFileError);
    expect((error as KeyFileError).problem).toBe('invalid');
    expect((error as Error).message).toContain(path);
    expect((error as Error).message).not.toContain(keyPair.toString());
    expect((error as Error).message).not.toContain(other);
  });

  it('reports a missing file as missing', async () => {
    const path = join(dir, 'nowhere.json');
    const error = await rejection(readKeyFile(path));
    expect(error).toBeInstanceOf(KeyFileError);
    expect((error as KeyFileError).problem).toBe('missing');
    expect((error as KeyFileError).path).toBe(path);
  });

  it('reports an empty file, which a write cut short leaves, as missing', async () => {
    const path = join(dir, 'empty.json');
    await writeFile(path, '');
    const error = await rejection(readKeyFile(path));
    expect(error).toMatchObject({ name: 'KeyFileError', problem: 'missing', path });
    expect((error as Error).message).toContain('is empty');
  });

  const malformed: [string, string][] = [
    ['text that is not JSON', 'ed25519:not json'],
    ['JSON that is not an object', '["ed25519:x"]'],
    ['an object without a private key', '{"public_key":"ed25519:x"}'],
    ['a private key that is not a string', '{"private_key":42}'],
    ['a private key that does not parse', '{"private_key":"ed25519:0OIl-not-base58"}'],
  ];
  it.each(malformed)('refuses %s, without quoting the file', async (_name, content) => {
    const path = join(dir, 'malformed.json');
    await writeFile(path, content);
    const error = await rejection(readKeyFile(path));
    expect(error).toBeInstanceOf(KeyFileError);
    expect((error as KeyFileError).problem).toBe('invalid');
    expect((error as Error).message).toContain(path);
    expect((error as Error).message).not.toContain('ed25519:');
    expect((error as Error).cause).toBeUndefined();
  });
});

describe('readKeyFolder', () => {
  it('reads every key of the folder, sorted by public key', async () => {
    const folder = keyFolderPath(dir, 'near:testnet', 'relay.parent.testnet');
    const keys = [KeyPair.fromRandom('ed25519'), KeyPair.fromRandom('ed25519'), KeyPair.fromRandom('ed25519')];
    for (const keyPair of keys) await writeKeyFile(folderKeyPath(folder, keyPair.getPublicKey()), 'relay.parent.testnet', keyPair);
    const publicKeys = keys.map((keyPair) => keyPair.getPublicKey().toString()).sort();
    const read = await readKeyFolder(folder);
    expect(read.map((keyPair) => keyPair.getPublicKey().toString())).toEqual(publicKeys);
  });

  it('reads the files near-cli-rs writes there', async () => {
    const keyPair = KeyPair.fromRandom('ed25519');
    await writeFile(folderKeyPath(dir, keyPair.getPublicKey()), JSON.stringify(nearCliRsFile(keyPair)));
    expect((await readKeyFolder(dir)).map(String)).toEqual([keyPair.toString()]);
  });

  it('skips an empty file, which a write cut short leaves: it holds no key', async () => {
    const folder = join(dir, 'relay.parent.testnet');
    const keyPair = KeyPair.fromRandom('ed25519');
    await writeKeyFile(folderKeyPath(folder, keyPair.getPublicKey()), ACCOUNT, keyPair);
    await writeFile(folderKeyPath(folder, KeyPair.fromRandom('ed25519').getPublicKey()), '');
    expect((await readKeyFolder(folder)).map((key) => key.toString())).toEqual([keyPair.toString()]);
  });

  it('skips entries that are not .json files', async () => {
    await writeFile(join(dir, 'notes.txt'), 'not a key');
    await mkdir(join(dir, 'nested.json'));
    expect(await readKeyFolder(dir)).toEqual([]);
  });

  it('refuses a file that is not named after its key', async () => {
    const keyPair = KeyPair.fromRandom('ed25519');
    const path = join(dir, 'copy.json');
    await writeKeyFile(path, 'relay.parent.testnet', keyPair);
    const error = await rejection(readKeyFolder(dir));
    expect(error).toBeInstanceOf(KeyFileError);
    expect((error as KeyFileError).problem).toBe('invalid');
    expect((error as KeyFileError).path).toBe(path);
  });

  it('reports a missing folder as missing', async () => {
    const folder = join(dir, 'relay.parent.testnet');
    const error = await rejection(readKeyFolder(folder));
    expect(error).toBeInstanceOf(KeyFileError);
    expect((error as KeyFileError).problem).toBe('missing');
    expect((error as KeyFileError).path).toBe(folder);
  });
});
