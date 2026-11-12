import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultSpendFile, readSpendFile, SpendFileError, writeSpendFile } from '../src/spend-file.ts';

const ACCOUNT = 'buyer-llm.parent.testnet';

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'quorum-spend-file-'));
  file = join(dir, 'mcp-spend.json');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** The error `promise` rejects with; fails the test if it resolves. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('the promise resolved');
}

describe('defaultSpendFile', () => {
  it('is data/mcp-spend.json at the root of the repository, whatever the current folder', () => {
    const path = defaultSpendFile();
    expect(basename(path)).toBe('mcp-spend.json');
    expect(basename(dirname(path))).toBe('data');
    // The tests run from packages/buyer, so a path read against the current folder would miss the root.
    expect(existsSync(join(dirname(dirname(path)), 'pnpm-workspace.yaml'))).toBe(true);
  });
});

describe('readSpendFile', () => {
  it('reads a missing file as nothing spent', async () => {
    expect(await readSpendFile(file, ACCOUNT)).toBe(0n);
  });

  it("reads back the account's total that writeSpendFile wrote", async () => {
    await writeSpendFile(file, ACCOUNT, 3_600n);
    expect(await readSpendFile(file, ACCOUNT)).toBe(3_600n);
  });

  it("refuses another account's file", async () => {
    await writeSpendFile(file, 'buyer-01.parent.testnet', 180n);
    const error = await rejection(readSpendFile(file, ACCOUNT));
    expect(error).toBeInstanceOf(SpendFileError);
    expect((error as SpendFileError).problem).toBe('other_account');
    expect((error as SpendFileError).path).toBe(file);
  });

  const malformed: [string, string][] = [
    ['text that is not JSON', 'spent: 3600'],
    ['JSON that is not an object', '"3600"'],
    ['a file without an account', '{"spent":"3600"}'],
    ['a total written as a number', `{"account":"${ACCOUNT}","spent":3600}`],
    ['a negative total', `{"account":"${ACCOUNT}","spent":"-1"}`],
    ['a total with a leading zero', `{"account":"${ACCOUNT}","spent":"0360"}`],
  ];
  it.each(malformed)('refuses %s', async (_name, content) => {
    await writeFile(file, content);
    const error = await rejection(readSpendFile(file, ACCOUNT));
    expect(error).toBeInstanceOf(SpendFileError);
    expect((error as SpendFileError).problem).toBe('malformed');
  });
});

describe('writeSpendFile', () => {
  it('writes the account and its total as a decimal string', async () => {
    await writeSpendFile(file, ACCOUNT, 10_000n);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ account: ACCOUNT, spent: '10000' });
  });

  it('creates the missing folders', async () => {
    const nested = join(dir, 'a', 'b', 'mcp-spend.json');
    await writeSpendFile(nested, ACCOUNT, 1n);
    expect(await readSpendFile(nested, ACCOUNT)).toBe(1n);
  });

  it('replaces the total, leaving no temporary file in the folder', async () => {
    await writeSpendFile(file, ACCOUNT, 360n);
    await writeSpendFile(file, ACCOUNT, 0n);
    expect(await readSpendFile(file, ACCOUNT)).toBe(0n);
    expect(await readdir(dir)).toEqual(['mcp-spend.json']);
  });

  it('removes its temporary file when the total cannot be put in place', async () => {
    // A folder where the file should be: the rename that would replace it fails.
    await mkdir(file);
    await expect(writeSpendFile(file, ACCOUNT, 360n)).rejects.toThrow();
    expect(await readdir(dir)).toEqual(['mcp-spend.json']);
  });

  it('refuses a negative total', async () => {
    await expect(writeSpendFile(file, ACCOUNT, -1n)).rejects.toThrow(RangeError);
    expect(existsSync(file)).toBe(false);
  });
});
