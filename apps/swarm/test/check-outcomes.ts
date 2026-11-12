import { createHash } from 'node:crypto';
import { toTxOutcome, type TxOutcome } from '@quorum-on-near/protocol';
import { baseEncode } from 'near-api-js';

/** A hash as NEAR writes one: the base58 of a SHA-256, here of `label`. */
export function hashOf(label: string): string {
  return baseEncode(createHash('sha256').update(label).digest());
}

/**
 * The gas each step of a relayed commit burns in `apps/gateway/test/fixtures/relayed-commit.json`,
 * a commit captured on the sandbox: the relayer's transaction, the buyer's delegate receipt, the
 * token's `ft_transfer_call`, the pools contract's `ft_on_transfer`, the token's
 * `ft_resolve_transfer`, and each gas refund to the relayer.
 */
export const COMMIT_STEP_GAS = {
  transaction: 513_352_392_365n,
  delegate: 513_352_392_365n,
  transferCall: 2_464_838_848_012n,
  onTransfer: 1_959_738_779_630n,
  resolve: 1_275_586_760_213n,
  gasRefund: 223_182_562_500n,
};

/** What the token and the pools contract burn in that commit: 5.70 Tgas. */
export const FIXTURE_COMMIT_GAS = 5_700_164_387_855n;

/** One entry of a transaction's outcome: who executed it, the gas it burnt, whether it failed, and its logs. */
interface Step {
  executor: string;
  gas: bigint;
  failed?: boolean;
  logs?: string[];
}

/** The status the RPC gives a receipt whose contract call panicked. */
const PANICKED = { Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: 'Smart contract panicked' } } } } };

/**
 * The FINAL `tx` response the RPC gives for a transaction whose outcome is `steps` (the
 * transaction first, then its receipts in the RPC's order), read with toTxOutcome as the chain seam
 * reads it.
 */
function outcomeOf(txHash: string, steps: Step[]): TxOutcome {
  const [transaction, ...receipts] = steps.map((step, i) => ({
    id: i === 0 ? txHash : hashOf(`${txHash} receipt ${i}`),
    outcome: {
      executor_id: step.executor,
      gas_burnt: Number(step.gas),
      logs: step.logs ?? [],
      status: step.failed === true ? PANICKED : { SuccessValue: '' },
    },
  }));
  return toTxOutcome({ final_execution_status: 'FINAL', transaction_outcome: transaction, receipts_outcome: receipts });
}

/**
 * A commit the relayer relayed, receipt by receipt as in the captured fixture: the relayer's
 * transaction, the buyer's delegate receipt, the token's `ft_transfer_call`, the pools contract's
 * `ft_on_transfer`, a gas refund, the token's `ft_resolve_transfer`, then three more gas refunds.
 * `gas` overrides the fixture's figures; `poolsLogs` are the logs of the pools contract's receipt.
 */
export function relayedCommit(opts: {
  txHash: string;
  relayer: string;
  buyer: string;
  token: string;
  pools: string;
  gas?: Partial<typeof COMMIT_STEP_GAS>;
  poolsLogs?: string[];
}): TxOutcome {
  const gas = { ...COMMIT_STEP_GAS, ...opts.gas };
  const refund = { executor: opts.relayer, gas: gas.gasRefund };
  return outcomeOf(opts.txHash, [
    { executor: opts.relayer, gas: gas.transaction },
    { executor: opts.buyer, gas: gas.delegate },
    { executor: opts.token, gas: gas.transferCall },
    { executor: opts.pools, gas: gas.onTransfer, logs: opts.poolsLogs ?? [] },
    refund,
    { executor: opts.token, gas: gas.resolve },
    refund,
    refund,
    refund,
  ]);
}

/**
 * A keeper call the relayer signed (`settle`, or a `refund` batch, whose last payout may be the
 * dust): the relayer's transaction, the call at the pools contract, then for each payout the
 * token's `ft_transfer`, the pools contract's callback and a gas refund to the relayer, then the
 * call's own gas refund.
 */
export function keeperCall(opts: {
  txHash: string;
  relayer: string;
  token: string;
  pools: string;
  callGas: bigint;
  payouts: ReadonlyArray<{ transfer: bigint; callback: bigint; failed?: boolean }>;
}): TxOutcome {
  const refund = { executor: opts.relayer, gas: COMMIT_STEP_GAS.gasRefund };
  return outcomeOf(opts.txHash, [
    { executor: opts.relayer, gas: 308_066_207_802n },
    { executor: opts.pools, gas: opts.callGas },
    ...opts.payouts.flatMap((payout) => [
      { executor: opts.token, gas: payout.transfer, failed: payout.failed ?? false },
      { executor: opts.pools, gas: payout.callback },
      refund,
    ]),
    refund,
  ]);
}
