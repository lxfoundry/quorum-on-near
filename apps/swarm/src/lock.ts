import { mkdir, open, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Network } from '@quorum-on-near/protocol';

/**
 * One swarm at a time for a network and a parent: the commands that write to the chain take a lock
 * file for the time they run, so that two of them never sign with the same keys, top the same
 * accounts up or open pools at once.
 */

/**
 * The folder of the lock files: `data/` at the root of the repository, which is gitignored and holds
 * the MCP server's spend file by default too. Resolved from this module's own location, so it does
 * not depend on the folder the process was started from.
 */
export function defaultLockDir(): string {
  return fileURLToPath(new URL('../../../data/', import.meta.url));
}

/**
 * The lock file for `network` and `parent` in `dir`: `swarm-<network>-<parent>.lock`, the network by
 * its chain name (`testnet`, `sandbox`), since a Windows file name cannot hold the colon of
 * `near:testnet`.
 */
export function lockFilePath(dir: string, network: Network, parent: string): string {
  return join(dir, `swarm-${network.replace(/^near:/, '')}-${parent}.lock`);
}

/** Another process holds the lock: its file exists. */
export class SwarmLockedError extends Error {
  override name = 'SwarmLockedError';
  readonly path: string;
  /** The PID the lock file holds; null when it holds none. */
  readonly pid: number | null;

  constructor(path: string, pid: number | null) {
    const holder = pid === null ? 'a process whose PID it does not hold' : `process ${pid}`;
    super(
      `another swarm is running: ${path} is held by ${holder}. If that process no longer runs, as when a ` +
        `swarm was stopped by force, remove ${path} and run again.`,
    );
    this.path = path;
    this.pid = pid;
  }
}

/** A lock held by this process. */
export interface SwarmLock {
  path: string;
  /** Removes the lock file; later calls do nothing. */
  release(): Promise<void>;
}

/**
 * Takes the lock at `path`: creates its folder when needed, then the file with flag `wx`, which fails
 * when the file exists, and writes `pid` to it. Throws SwarmLockedError, naming the PID the file
 * holds, when it exists already; a file left by a write cut short holds no PID.
 */
export async function takeLock(path: string, pid: number = process.pid): Promise<SwarmLock> {
  await mkdir(dirname(path), { recursive: true });
  let file: Awaited<ReturnType<typeof open>>;
  try {
    file = await open(path, 'wx');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new SwarmLockedError(path, await pidIn(path));
    throw error;
  }
  try {
    await file.writeFile(`${pid}\n`);
  } catch (error) {
    await file.close();
    await rm(path, { force: true });
    throw error;
  }
  await file.close();
  let released = false;
  return {
    path,
    release: async () => {
      if (released) return;
      released = true;
      await rm(path, { force: true });
    },
  };
}

/** The PID a lock file holds: null when it holds none, or cannot be read. */
async function pidIn(path: string): Promise<number | null> {
  try {
    const text = (await readFile(path, 'utf8')).trim();
    return /^[1-9][0-9]{0,9}$/.test(text) ? Number(text) : null;
  } catch {
    return null;
  }
}
