import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { testDeps } from './handler-deps.ts';

describe('testDeps', () => {
  // A folder of this file's own stands in for the system's temporary folder, so only testDeps writes there.
  let root = '';

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'quorum-handler-deps-'));
    // os.tmpdir reads TMPDIR on Linux and macOS, and TEMP or TMP on Windows.
    for (const name of ['TMPDIR', 'TEMP', 'TMP']) vi.stubEnv(name, root);
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  it('keeps the activity log in a temporary folder while the test runs', async () => {
    const deps = await testDeps();
    // A record, so the folder is not empty when it is removed.
    await deps.activity.append({
      at: 0,
      poolId: 7,
      kind: 'commit',
      account: 'buyer.testnet',
      seats: 1,
      amount: '180',
      txHash: 'Tx',
      ok: true,
    });
    expect(await readdir(root)).toHaveLength(1);
  });

  // Runs after the test above, which it depends on.
  it('removes that folder once the test that made it has finished', async () => {
    expect(await readdir(root)).toEqual([]);
  });
});
