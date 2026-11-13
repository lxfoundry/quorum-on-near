// Stops a near-sandbox Sandbox within a bounded time and leaves nothing of it behind. near-sandbox
// 0.3.5's tearDown() sends neard SIGTERM and waits for its exit with no time limit, and a neard that
// has run for a while can catch SIGTERM and go on producing blocks; a neard that exited earlier
// never sends the exit event tearDown waits for. tearDown also leaves, in the system's temporary
// folder, the two empty port lock files it created, once it has released the locks.
import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';

/** What stopSandbox uses of a near-sandbox Sandbox. */
export interface SandboxToStop {
  readonly homeDir: string;
  readonly rpcPortLockPath: string;
  readonly netPortLockPath: string;
  tearDown(): Promise<void>;
}

/** What stopSandbox uses of the sandbox's neard process. */
export type NeardProcess = Pick<ChildProcess, 'exitCode' | 'signalCode' | 'kill'>;

export interface StopSandboxOptions {
  /** How long tearDown gets, from its SIGTERM, before neard is killed; SANDBOX_GRACE_MS by default. */
  graceMs?: number;
  /** How long tearDown then gets to release the ports once neard is killed; SANDBOX_KILL_WAIT_MS by default. */
  killWaitMs?: number;
}

/** How stopSandbox stopped a sandbox. */
export interface SandboxStopped {
  /** neard was still running when the grace period ended, and was sent SIGKILL. */
  killed: boolean;
  /** tearDown ended, so the port locks are released; false when it was still waiting for neard's exit. */
  tornDown: boolean;
}

/** A neard that stops on SIGTERM does so in well under a second. */
export const SANDBOX_GRACE_MS = 10_000;
/** After SIGKILL, tearDown only releases two locks and removes the home folder. */
export const SANDBOX_KILL_WAIT_MS = 10_000;

/**
 * Tears `sandbox` down and gives it `graceMs`. If tearDown has not ended by then, sends neard SIGKILL
 * (unless it has already exited) and gives tearDown `killWaitMs` more: neard's exit lets it release
 * the port locks and remove the home folder. Then removes the home folder (again, when tearDown did)
 * and each port lock file whose lock is released. A lock still held stays: proper-lockfile, which
 * near-sandbox locks the ports with, holds a lock as a `<file>.lock` folder that it keeps fresh and
 * reports as compromised (by throwing) once it is removed, and it removes the folder itself when the
 * process exits. A held lock is this process's when tearDown never ended, or another sandbox's that
 * took the same port since. Resolves in at most `graceMs + killWaitMs` plus the removals; rejects only
 * when the home folder cannot be removed.
 */
export async function stopSandbox(
  sandbox: SandboxToStop,
  neard: NeardProcess,
  options: StopSandboxOptions = {},
): Promise<SandboxStopped> {
  const { graceMs = SANDBOX_GRACE_MS, killWaitMs = SANDBOX_KILL_WAIT_MS } = options;
  // tearDown's only failure is removing the home folder, which is done again below.
  const tearDown = sandbox.tearDown().then(
    () => true,
    () => true,
  );
  let tornDown = await settledWithin(tearDown, graceMs);
  let killed = false;
  if (!tornDown) {
    if (neard.exitCode === null && neard.signalCode === null) killed = neard.kill('SIGKILL');
    tornDown = await settledWithin(tearDown, killWaitMs);
  }
  await rm(sandbox.homeDir, { recursive: true, force: true, maxRetries: 3 });
  for (const lockFile of [sandbox.rpcPortLockPath, sandbox.netPortLockPath]) {
    if (!existsSync(`${lockFile}.lock`)) await rm(lockFile, { force: true });
  }
  return { killed, tornDown };
}

/** Resolves with what `promise` resolves with, or false once `ms` have passed. */
async function settledWithin(promise: Promise<boolean>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
