// The harness's own sandbox, started and stopped as every world starts and stops it: how much history
// it keeps, and what is left of it once stopped, also when neard does not stop on SIGTERM. Needs Linux
// or macOS (near-sandbox ships no Windows binary, so on Windows the suite is skipped). The first two
// tests run in order on one sandbox; the third starts its own.
import { existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import type { Sandbox } from 'near-sandbox';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { neardProcess, SANDBOX_GC_EPOCHS, startSandbox } from './harness.ts';
import { stopSandbox } from './teardown.ts';

const TIMEOUT_MS = 120_000;
/** The least transaction history a world needs: a scenario run with its check takes a few minutes. */
const LEAST_HISTORY_MS = 10 * 60_000;
/** How long the block rate is measured over. */
const MEASURE_MS = 3_000;
/** The grace period the frozen neard gets before it is killed. */
const SHORT_GRACE_MS = 1_000;

/** Calls a method of the sandbox's JSON-RPC and returns its result; throws on an error answer. */
async function rpc(sandbox: Sandbox, method: string, params: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(sandbox.rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'sandbox-test', method, params }),
  });
  const body = (await response.json()) as { result?: Record<string, unknown>; error?: unknown };
  if (body.result === undefined) throw new Error(`${method} answered ${JSON.stringify(body.error)}`);
  return body.result;
}

async function finalHeight(sandbox: Sandbox): Promise<number> {
  const block = await rpc(sandbox, 'block', { finality: 'final' });
  return (block['header'] as { height: number }).height;
}

/** Whether nothing is left of a stopped sandbox: no neard process, home folder or port lock file. */
function expectNothingLeft(sandbox: Sandbox, pid: number): void {
  expect(running(pid)).toBe(false);
  expect(existsSync(sandbox.homeDir)).toBe(false);
  expect(existsSync(sandbox.rpcPortLockPath)).toBe(false);
  expect(existsSync(sandbox.netPortLockPath)).toBe(false);
}

/** Whether a process with this id is running (or a zombie not reaped yet). */
function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

// near-sandbox ships no Windows binary.
describe.skipIf(process.platform === 'win32')("the harness's sandbox", { timeout: TIMEOUT_MS }, () => {
  let sandbox: Sandbox | undefined;
  let stopped = false;

  const started = (): Sandbox => {
    if (sandbox === undefined) throw new Error('the sandbox did not start');
    return sandbox;
  };

  beforeAll(async () => {
    sandbox = await startSandbox();
  }, TIMEOUT_MS);

  afterAll(async () => {
    if (sandbox !== undefined && !stopped) await stopSandbox(sandbox, neardProcess(sandbox));
  }, TIMEOUT_MS);

  it(`keeps ${SANDBOX_GC_EPOCHS} epochs of blocks and transactions, at least ten minutes at its block rate`, async () => {
    const node = started();
    const config = await rpc(node, 'client_config', []);
    const protocol = await rpc(node, 'EXPERIMENTAL_protocol_config', { finality: 'final' });
    const from = await finalHeight(node);
    const start = performance.now();
    await delay(MEASURE_MS);
    const msPerBlock = (performance.now() - start) / ((await finalHeight(node)) - from);
    const epochLength = protocol['epoch_length'] as number;
    const historyMs = SANDBOX_GC_EPOCHS * epochLength * msPerBlock;
    console.log(
      `sandbox history: ${SANDBOX_GC_EPOCHS} epochs of ${epochLength} blocks at ${msPerBlock.toFixed(0)} ms, about ${Math.round(historyMs / 60_000)} minutes`,
    );

    expect((config['gc'] as { gc_num_epochs_to_keep: number }).gc_num_epochs_to_keep).toBe(SANDBOX_GC_EPOCHS);
    expect(historyMs).toBeGreaterThanOrEqual(LEAST_HISTORY_MS);
  });

  it('stops neard and leaves neither its home folder nor its port lock files', async () => {
    const node = started();
    const neard = neardProcess(node);
    const pid = neard.pid;
    if (pid === undefined) throw new Error('neard has no process id');

    const start = performance.now();
    const result = await stopSandbox(node, neard);
    stopped = true;
    // A neard slowed by a busy machine may need SIGKILL; either way nothing may be left.
    console.log(`sandbox stopped in ${Math.round(performance.now() - start)} ms, ${result.killed ? 'killed' : 'on SIGTERM'}`);

    expect(result.tornDown).toBe(true);
    expectNothingLeft(node, pid);
  });

  it('kills a neard that does not stop on SIGTERM once the grace period is over, and leaves nothing of it', async () => {
    const node = await startSandbox();
    const neard = neardProcess(node);
    const pid = neard.pid;
    if (pid === undefined) throw new Error('neard has no process id');
    // A stopped process leaves SIGTERM pending; SIGKILL still ends it.
    process.kill(pid, 'SIGSTOP');

    const result = await stopSandbox(node, neard, { graceMs: SHORT_GRACE_MS });

    expect(result).toEqual({ killed: true, tornDown: true });
    expect(neard.signalCode).toBe('SIGKILL');
    expectNothingLeft(node, pid);
  });
});
