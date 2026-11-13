// stopSandbox against a stand-in for near-sandbox's Sandbox and its neard process, so that every way
// a teardown can end is covered on any platform, Windows included.
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stopSandbox, type NeardProcess, type SandboxToStop } from './sandbox/teardown.ts';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'quorum-teardown-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** How the stand-in's tearDown behaves. */
type TearDownBehaviour =
  /** Removes the home folder and releases both port locks at once, as near-sandbox does when neard stops on SIGTERM. */
  | 'stops'
  /** Waits until neard gets SIGKILL, then does what 'stops' does: neard ignores SIGTERM. */
  | 'waits_for_kill'
  /** Never ends: neard had exited before, so near-sandbox waits for an exit event that has passed. */
  | 'never_ends'
  /** Releases both port locks, then rejects without removing the home folder. */
  | 'fails';

interface StandIn {
  sandbox: SandboxToStop;
  neard: NeardProcess & { signals: string[] };
  /** The two port lock files, as near-sandbox creates them in the system's temporary folder. */
  lockFiles: [string, string];
}

/**
 * A home folder holding a file, two empty port lock files, each held as proper-lockfile holds a lock
 * (a `<file>.lock` folder next to it), and a neard that is running unless `exited`.
 */
async function standIn(behaviour: TearDownBehaviour, options: { exited?: boolean } = {}): Promise<StandIn> {
  const homeDir = join(dir, 'near-sandbox-home');
  await mkdir(homeDir);
  await writeFile(join(homeDir, 'config.json'), '{}');
  const lockFiles: [string, string] = [join(dir, 'near-sandbox-port-1001.lock'), join(dir, 'near-sandbox-port-1002.lock')];
  for (const file of lockFiles) {
    await writeFile(file, '');
    await mkdir(`${file}.lock`);
  }
  const release = async (): Promise<void> => {
    for (const file of lockFiles) await rm(`${file}.lock`, { recursive: true });
  };

  let killed: () => void = () => {};
  const signals: string[] = [];
  const neard: StandIn['neard'] = {
    exitCode: options.exited === true ? 1 : null,
    signalCode: null,
    signals,
    kill(signal) {
      signals.push(String(signal));
      if (signal === 'SIGKILL') killed();
      return true;
    },
  };

  const sandbox: SandboxToStop = {
    homeDir,
    rpcPortLockPath: lockFiles[0],
    netPortLockPath: lockFiles[1],
    async tearDown() {
      if (behaviour === 'never_ends') return new Promise<void>(() => {});
      if (behaviour === 'waits_for_kill') await new Promise<void>((resolve) => (killed = resolve));
      await release();
      if (behaviour === 'fails') throw new Error('Sandbox teardown encountered errors');
      await rm(homeDir, { recursive: true, force: true });
    },
  };
  return { sandbox, neard, lockFiles };
}

describe('stopSandbox', () => {
  it('removes the empty port lock files near-sandbox leaves once its tearDown has released them', async () => {
    const { sandbox, neard, lockFiles } = await standIn('stops');

    const stopped = await stopSandbox(sandbox, neard, { graceMs: 1_000, killWaitMs: 1_000 });

    expect(stopped).toEqual({ killed: false, tornDown: true });
    expect(neard.signals).toEqual([]);
    expect(existsSync(sandbox.homeDir)).toBe(false);
    for (const file of lockFiles) expect(existsSync(file)).toBe(false);
  });

  it('kills neard with SIGKILL when tearDown has not ended within the grace period, then lets tearDown release the ports', async () => {
    const { sandbox, neard, lockFiles } = await standIn('waits_for_kill');

    const stopped = await stopSandbox(sandbox, neard, { graceMs: 20, killWaitMs: 1_000 });

    expect(stopped).toEqual({ killed: true, tornDown: true });
    expect(neard.signals).toEqual(['SIGKILL']);
    expect(existsSync(sandbox.homeDir)).toBe(false);
    for (const file of lockFiles) {
      expect(existsSync(`${file}.lock`)).toBe(false);
      expect(existsSync(file)).toBe(false);
    }
  });

  it('removes the home folder and keeps the port locks still held when tearDown never ends, signalling no neard that has already exited', async () => {
    const { sandbox, neard, lockFiles } = await standIn('never_ends', { exited: true });
    const start = performance.now();

    const stopped = await stopSandbox(sandbox, neard, { graceMs: 20, killWaitMs: 20 });

    expect(performance.now() - start).toBeLessThan(1_000);
    expect(stopped).toEqual({ killed: false, tornDown: false });
    expect(neard.signals).toEqual([]);
    expect(existsSync(sandbox.homeDir)).toBe(false);
    // Removing a lock folder this process still holds would make proper-lockfile throw: both stay.
    for (const file of lockFiles) {
      expect(existsSync(`${file}.lock`)).toBe(true);
      expect(existsSync(file)).toBe(true);
    }
  });

  it('removes the home folder itself when tearDown fails to, once the ports are released', async () => {
    const { sandbox, neard, lockFiles } = await standIn('fails');

    const stopped = await stopSandbox(sandbox, neard, { graceMs: 1_000, killWaitMs: 1_000 });

    expect(stopped).toEqual({ killed: false, tornDown: true });
    expect(existsSync(sandbox.homeDir)).toBe(false);
    for (const file of lockFiles) expect(existsSync(file)).toBe(false);
  });
});
