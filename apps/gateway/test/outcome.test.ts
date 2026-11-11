import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { QuorumEvent } from '@quorum-on-near/protocol';
import { poolsEvents, readCommit, toTxOutcome } from '../src/outcome.ts';
import { commitOutcome, outcome, PARENT, POOLS, RELAYER, TOKEN } from './fake-chain.ts';

const BUYER = `buyer-01.${PARENT}`;
const QUERY = { poolsContract: POOLS, buyer: BUYER, poolId: 7 };

/** The fields of the fixture that these tests change. */
interface RawResponse {
  final_execution_status?: string;
  receipts_outcome: Array<{ outcome: { status: unknown; gas_burnt: unknown } }>;
}

/** A fresh copy of the provisional `send_tx` result for a relayed commit of 2 seats in pool 7. */
function relayedCommit(): RawResponse {
  const url = new URL('./fixtures/relayed-commit.provisional.json', import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as RawResponse;
}

type SeatsCommitted = Extract<QuorumEvent, { event: 'seats_committed' }>;

function committed(overrides: Partial<SeatsCommitted['data']> = {}): SeatsCommitted {
  return {
    event: 'seats_committed',
    data: { pool_id: 7, buyer: BUYER, seats: 2, amount: '360', taken: 150, target: 192, ...overrides },
  };
}

describe('toTxOutcome', () => {
  it('takes the transaction hash from the transaction outcome', () => {
    expect(toTxOutcome(relayedCommit()).txHash).toBe('FakeTxHash1111111111111111111111111111111111');
  });

  it('lists the transaction first, then every receipt in the order the RPC gave', () => {
    const { receipts } = toTxOutcome(relayedCommit());
    expect(receipts.map((r) => r.executorId)).toEqual([RELAYER, BUYER, TOKEN, POOLS, RELAYER, TOKEN, RELAYER]);
  });

  it('keeps each receipt its own logs', () => {
    const { receipts } = toTxOutcome(relayedCommit());
    expect(receipts.map((r) => r.logs.length)).toEqual([0, 0, 1, 1, 0, 0, 0]);
    expect(receipts[2]?.logs[0]).toMatch(/^EVENT_JSON:\{"standard":"nep141","version":"1\.0\.0","event":"ft_transfer"/);
    expect(receipts[3]?.logs).toEqual([
      'EVENT_JSON:{"data":[{"amount":"360","buyer":"buyer-01.parent.testnet","pool_id":7,"seats":2,"taken":150,"target":192}],"event":"seats_committed","standard":"quorum","version":"1.0.0"}',
    ]);
  });

  it('marks no receipt failed when every status is a success', () => {
    expect(toTxOutcome(relayedCommit()).receipts.map((r) => r.failed)).toEqual(Array(7).fill(false));
  });

  it('converts gas_burnt to bigint', () => {
    expect(toTxOutcome(relayedCommit()).receipts.map((r) => r.gasBurnt)).toEqual([
      2_628_184_840_212n,
      2_628_184_840_212n,
      8_858_916_069_173n,
      3_365_039_006_310n,
      0n,
      2_027_365_745_368n,
      0n,
    ]);
  });

  it('marks a receipt failed when its status has a Failure key', () => {
    const response = relayedCommit();
    response.receipts_outcome[0]!.outcome.status = {
      Failure: {
        ActionError: {
          index: 0,
          kind: { DelegateActionInvalidNonce: { ak_nonce: 244_990_000_000_007, delegate_nonce: 244_990_000_000_007 } },
        },
      },
    };
    const failed = toTxOutcome(response).receipts.map((r) => r.failed);
    expect(failed).toEqual([false, true, false, false, false, false, false]);
  });

  it('throws on a response that has no receipts_outcome', () => {
    const { receipts_outcome: _, ...rest } = relayedCommit();
    expect(() => toTxOutcome(rest)).toThrow(TypeError);
  });

  it('throws on a receipt whose gas_burnt is not an integer', () => {
    const response = relayedCommit();
    response.receipts_outcome[1]!.outcome.gas_burnt = 1.5;
    expect(() => toTxOutcome(response)).toThrow(TypeError);
  });

  it.each(['EXECUTED_OPTIMISTIC', 'EXECUTED', 'FINAL'])('reads a response whose final_execution_status is %s', (status) => {
    const response = { ...relayedCommit(), final_execution_status: status };
    expect(toTxOutcome(response).receipts).toHaveLength(7);
  });

  it.each(['NONE', 'INCLUDED', 'INCLUDED_FINAL'])(
    'throws on a response whose final_execution_status is %s, since its receipts may not all have run',
    (status) => {
      const response = relayedCommit();
      response.final_execution_status = status;
      response.receipts_outcome.splice(1);
      expect(() => toTxOutcome(response)).toThrow(TypeError);
    },
  );

  it('throws on a response that has no final_execution_status', () => {
    const { final_execution_status: _, ...rest } = relayedCommit();
    expect(() => toTxOutcome(rest)).toThrow(TypeError);
  });
});

describe('poolsEvents', () => {
  it('returns the events the pools contract logged, in order, skipping other log lines', () => {
    const filled: QuorumEvent = { event: 'pool_filled', data: { pool_id: 7, taken: 192 } };
    const tx = outcome('TxHash', [
      { executorId: POOLS, logs: ['plain log line'], events: [committed({ taken: 192 }), filled] },
    ]);
    expect(poolsEvents(tx, POOLS)).toEqual([committed({ taken: 192 }), filled]);
  });

  it('ignores look-alike events logged by another account', () => {
    const tx = outcome('TxHash', [
      { executorId: BUYER },
      { executorId: TOKEN, events: [committed({ seats: 24 })] },
      { executorId: POOLS, events: [committed()] },
    ]);
    expect(poolsEvents(tx, POOLS)).toEqual([committed()]);
  });

  it('skips the events of a failed pools receipt, whose state changes were reverted', () => {
    const tx = outcome('TxHash', [{ executorId: POOLS, events: [committed()], failed: true }]);
    expect(poolsEvents(tx, POOLS)).toEqual([]);
  });
});

describe('readCommit', () => {
  it('reads the seats, amount and pool totals when the seats are taken and the pool stays open', () => {
    const tx = commitOutcome({ buyer: BUYER, poolId: 7, seats: 2, seatPrice: 180n, taken: 150, target: 192 });
    expect(readCommit(tx, QUERY)).toEqual({
      delegateFailed: false,
      seats: 2,
      amount: 360n,
      taken: 150,
      target: 192,
      filled: false,
    });
  });

  it('reads the provisional relayed-commit fixture as 2 seats taken in an open pool', () => {
    expect(readCommit(toTxOutcome(relayedCommit()), QUERY)).toEqual({
      delegateFailed: false,
      seats: 2,
      amount: 360n,
      taken: 150,
      target: 192,
      filled: false,
    });
  });

  it('reports filled when the pools contract logged pool_filled for the pool', () => {
    const tx = commitOutcome({ buyer: BUYER, poolId: 7, seats: 2, seatPrice: 180n, taken: 192, target: 192 });
    expect(readCommit(tx, QUERY)).toMatchObject({ seats: 2, taken: 192, target: 192, filled: true });
  });

  it('reports filled when the commit brought taken up to target', () => {
    const tx = outcome('TxHash', [{ executorId: POOLS, events: [committed({ taken: 192 })] }]);
    expect(readCommit(tx, QUERY).filled).toBe(true);
  });

  it('reports no seats when the pools contract logged no seats_committed', () => {
    const tx = commitOutcome({ buyer: BUYER, poolId: 7, seats: 0, seatPrice: 180n, taken: 192, target: 192 });
    expect(readCommit(tx, QUERY)).toEqual({
      delegateFailed: false,
      seats: 0,
      amount: 0n,
      taken: null,
      target: null,
      filled: false,
    });
  });

  it("ignores another buyer's seats_committed in the same outcome", () => {
    const tx = outcome('TxHash', [{ executorId: POOLS, events: [committed({ buyer: `buyer-02.${PARENT}` })] }]);
    expect(readCommit(tx, QUERY)).toMatchObject({ seats: 0, amount: 0n, taken: null, filled: false });
  });

  it('ignores a seats_committed for another pool', () => {
    const tx = outcome('TxHash', [{ executorId: POOLS, events: [committed({ pool_id: 8 })] }]);
    expect(readCommit(tx, QUERY).seats).toBe(0);
  });

  it('ignores a seats_committed logged by another contract', () => {
    const tx = outcome('TxHash', [{ executorId: TOKEN, events: [committed()] }]);
    expect(readCommit(tx, QUERY).seats).toBe(0);
  });

  it("reports delegateFailed when a receipt at the buyer's account failed", () => {
    const tx = outcome('TxHash', [{ executorId: BUYER, failed: true }, { executorId: RELAYER }]);
    expect(readCommit(tx, QUERY)).toEqual({
      delegateFailed: true,
      seats: 0,
      amount: 0n,
      taken: null,
      target: null,
      filled: false,
    });
  });

  it('does not report delegateFailed when only the pools receipt failed', () => {
    const tx = commitOutcome({ buyer: BUYER, poolId: 7, seats: 0, seatPrice: 180n, taken: 192, target: 192 });
    expect(readCommit(tx, QUERY).delegateFailed).toBe(false);
  });

  it('throws on a seats_committed whose amount is not a decimal string', () => {
    const tx = outcome('TxHash', [{ executorId: POOLS, events: [committed({ amount: '3.6e2' })] }]);
    expect(() => readCommit(tx, QUERY)).toThrow(TypeError);
  });
});
