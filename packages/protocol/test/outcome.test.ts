import { describe, expect, it } from 'vitest';
import type { QuorumEvent } from '../src/contract.ts';
import { poolsEvents, toTxOutcome, type ReceiptOutcome, type TxOutcome } from '../src/outcome.ts';

const PARENT = 'parent.testnet';
const POOLS = `pools.${PARENT}`;
const RELAYER = `relay.${PARENT}`;
const BUYER = `buyer-01.${PARENT}`;
/** Circle's USDC on NEAR testnet. */
const TOKEN = '3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af';

/** One `{id, outcome}` entry of a transaction response. */
interface RawOutcome {
  id: string;
  outcome: {
    executor_id: string;
    gas_burnt: unknown;
    logs: string[];
    receipt_ids: string[];
    status: unknown;
    tokens_burnt: string;
  };
}

/** A transaction response as the RPC's `send_tx` returns it, without the fields an outcome is not read from. */
interface RawResponse {
  final_execution_status?: string;
  status: unknown;
  transaction_outcome: RawOutcome;
  receipts_outcome: RawOutcome[];
}

/**
 * A fresh copy of a provisional `send_tx` result for a relayed commit of 2 seats in pool 7: the
 * relayer's transaction, the delegate at the buyer, `ft_transfer_call` at the token, `ft_on_transfer`
 * at the pools contract, a gas refund to the relayer, `ft_resolve_transfer` at the token and its gas
 * refund. Gas profiles, proofs and block hashes are left out.
 */
function relayedCommit(): RawResponse {
  return {
    final_execution_status: 'EXECUTED_OPTIMISTIC',
    status: { SuccessValue: '' },
    transaction_outcome: {
      id: 'FakeTxHash1111111111111111111111111111111111',
      outcome: {
        executor_id: RELAYER,
        gas_burnt: 2_628_184_840_212,
        logs: [],
        receipt_ids: ['FakeReceiptA11111111111111111111111111111111'],
        status: { SuccessReceiptId: 'FakeReceiptA11111111111111111111111111111111' },
        tokens_burnt: '262818484021200000000',
      },
    },
    receipts_outcome: [
      {
        id: 'FakeReceiptA11111111111111111111111111111111',
        outcome: {
          executor_id: BUYER,
          gas_burnt: 2_628_184_840_212,
          logs: [],
          receipt_ids: ['FakeReceiptB11111111111111111111111111111111'],
          status: { SuccessValue: '' },
          tokens_burnt: '262818484021200000000',
        },
      },
      {
        id: 'FakeReceiptB11111111111111111111111111111111',
        outcome: {
          executor_id: TOKEN,
          gas_burnt: 8_858_916_069_173,
          logs: [
            'EVENT_JSON:{"standard":"nep141","version":"1.0.0","event":"ft_transfer","data":[{"old_owner_id":"buyer-01.parent.testnet","new_owner_id":"pools.parent.testnet","amount":"360"}]}',
          ],
          receipt_ids: ['FakeReceiptC11111111111111111111111111111111', 'FakeReceiptE11111111111111111111111111111111'],
          status: { SuccessReceiptId: 'FakeReceiptE11111111111111111111111111111111' },
          tokens_burnt: '885891606917300000000',
        },
      },
      {
        id: 'FakeReceiptC11111111111111111111111111111111',
        outcome: {
          executor_id: POOLS,
          gas_burnt: 3_365_039_006_310,
          logs: [
            'EVENT_JSON:{"data":[{"amount":"360","buyer":"buyer-01.parent.testnet","pool_id":7,"seats":2,"taken":150,"target":192}],"event":"seats_committed","standard":"quorum","version":"1.0.0"}',
          ],
          receipt_ids: ['FakeReceiptD11111111111111111111111111111111'],
          status: { SuccessValue: 'IjAi' },
          tokens_burnt: '336503900631000000000',
        },
      },
      {
        id: 'FakeReceiptD11111111111111111111111111111111',
        outcome: {
          executor_id: RELAYER,
          gas_burnt: 0,
          logs: [],
          receipt_ids: [],
          status: { SuccessValue: '' },
          tokens_burnt: '0',
        },
      },
      {
        id: 'FakeReceiptE11111111111111111111111111111111',
        outcome: {
          executor_id: TOKEN,
          gas_burnt: 2_027_365_745_368,
          logs: [],
          receipt_ids: ['FakeReceiptF11111111111111111111111111111111'],
          status: { SuccessValue: 'IjM2MCI=' },
          tokens_burnt: '202736574536800000000',
        },
      },
      {
        id: 'FakeReceiptF11111111111111111111111111111111',
        outcome: {
          executor_id: RELAYER,
          gas_burnt: 0,
          logs: [],
          receipt_ids: [],
          status: { SuccessValue: '' },
          tokens_burnt: '0',
        },
      },
    ],
  };
}

/** The log line the pools contract writes for an event. */
function eventLog(event: QuorumEvent): string {
  return `EVENT_JSON:${JSON.stringify({ standard: 'quorum', version: '1.0.0', event: event.event, data: [event.data] })}`;
}

interface ReceiptSpec {
  executorId: string;
  events?: QuorumEvent[];
  logs?: string[];
  failed?: boolean;
}

/** A TxOutcome from receipt specs: the relayer's transaction first, then the given receipts. */
function outcome(txHash: string, receipts: ReceiptSpec[]): TxOutcome {
  const toReceipt = (r: ReceiptSpec): ReceiptOutcome => ({
    executorId: r.executorId,
    logs: [...(r.logs ?? []), ...(r.events ?? []).map(eventLog)],
    failed: r.failed ?? false,
    gasBurnt: 1_000_000_000_000n,
  });
  return { txHash, receipts: [toReceipt({ executorId: RELAYER }), ...receipts.map(toReceipt)] };
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
