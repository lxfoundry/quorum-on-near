import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readCommit, toTxOutcome } from '../src/outcome.ts';

// Captured from the sandbox test (test/sandbox/relayed-commit.test.ts with QUORUM_CAPTURE_FIXTURE=1):
// buyer1.sandbox's relayed commit of 2 seats in pool 0, through relay.sandbox, on musd.sandbox.
const raw: unknown = JSON.parse(readFileSync(new URL('./fixtures/relayed-commit.json', import.meta.url), 'utf8'));

describe('a relayed commit captured from the sandbox', () => {
  it('reads as two seats taken by buyer1 in pool 0, with the pool still open', () => {
    const commit = readCommit(toTxOutcome(raw), { poolsContract: 'pools.sandbox', buyer: 'buyer1.sandbox', poolId: 0 });
    expect(commit).toMatchObject({ delegateFailed: false, seats: 2, amount: 360n, taken: 2, target: 3, filled: false });
  });

  it('lists the delegate receipt at the buyer before the receipts at the token and the pools contract', () => {
    const executors = toTxOutcome(raw).receipts.map((r) => r.executorId);
    const buyer = executors.indexOf('buyer1.sandbox');
    expect(buyer).toBeGreaterThan(0);
    expect(executors.indexOf('musd.sandbox')).toBeGreaterThan(buyer);
    expect(executors.indexOf('pools.sandbox')).toBeGreaterThan(buyer);
  });
});
