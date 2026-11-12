import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lockFilePath, SwarmLockedError, takeLock } from '../src/lock.ts';

/** A temporary folder for the tests' lock files, so that no test writes into the repository. */
let dir: string;
let n = 0;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'quorum-swarm-lock-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A lock path no other test uses. */
function freshPath(): string {
  n += 1;
  return join(dir, `lock-${n}`, 'swarm.lock');
}

describe('lockFilePath', () => {
  it('names the network by its chain name, so that the file name holds no colon', () => {
    expect(lockFilePath(dir, 'near:testnet', 'ops.testnet')).toBe(join(dir, 'swarm-testnet-ops.testnet.lock'));
  });
});

describe('takeLock', () => {
  it('creates the folder and the file, which holds the PID, and refuses a second lock while the file exists', async () => {
    const path = freshPath();

    const lock = await takeLock(path, 4321);

    expect(await readFile(path, 'utf8')).toBe('4321\n');
    await expect(takeLock(path, 99)).rejects.toThrow(SwarmLockedError);
    await lock.release();
  });

  it('removes the file on release, and does nothing on a later release', async () => {
    const path = freshPath();
    const lock = await takeLock(path, 4321);

    await lock.release();
    expect(existsSync(path)).toBe(false);

    await writeFile(path, '4321\n');
    await lock.release();
    expect(await readFile(path, 'utf8')).toBe('4321\n');
  });

  it('leaves a lock file that holds another process’s PID, which a swarm that took the lock after this one’s file was removed wrote', async () => {
    const path = freshPath();
    const lock = await takeLock(path, 4321);
    await rm(path);
    await writeFile(path, '4242\n');

    await lock.release();

    expect(await readFile(path, 'utf8')).toBe('4242\n');
  });

  it('leaves a lock file that holds no PID, as a write cut short leaves it', async () => {
    const path = freshPath();
    const lock = await takeLock(path, 4321);
    await writeFile(path, '');

    await lock.release();

    expect(existsSync(path)).toBe(true);
  });

  it('releases a lock whose file is already gone without failing', async () => {
    const path = freshPath();
    const lock = await takeLock(path, 4321);
    await rm(path);

    await expect(lock.release()).resolves.toBeUndefined();
  });

  it('rejects when the file cannot be removed, here because it was replaced by a folder', async () => {
    const path = freshPath();
    const lock = await takeLock(path, 4321);
    await rm(path);
    await mkdir(path);

    await expect(lock.release()).rejects.toThrow();
  });
});
