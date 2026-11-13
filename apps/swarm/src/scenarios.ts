import type { PoolStatus } from '@quorum-on-near/protocol';
import type { SwarmConfig } from './config.ts';

/** The two scenarios the swarm runs: a pool that fills, and one that fails. */
export type ScenarioName = 'fills' | 'fails';

/**
 * A pool the provider opens and how the scripted buyers arrive at it. Amounts are in the token's
 * base units.
 */
export interface Scenario {
  name: ScenarioName;
  seatPrice: bigint;
  /** The seats the pool needs before its deadline. */
  target: number;
  /** The refund bonus the provider escrows when it opens the pool. */
  bonus: bigint;
  maxSeatsPerBuyer: number;
  /** The pool's terms, the seller's free text. */
  terms: string;
  /** How long the pool stays open, from the final block's time when it opens. */
  deadlineSeconds: number;
  /** The scripted buyers arrive at uniformly random delays in `[0, spreadSeconds)` after the run starts. */
  spreadSeconds: number;
  /** The status the pool ends in once the gateway's keeper has run. */
  expectedEnd: Extract<PoolStatus, 'settled' | 'refunded'>;
}

/** A block of 8 GPUs for 24 hours, sold by the GPU-hour, at prices divided by 10,000. */
const TERMS = '8×GPU × 24 h; 1 seat = 1 GPU-hour; prices at 1/10,000 scale';

/**
 * Both scenarios sell the same 192 seats with a bonus of 5% of the block's price. At 180 a seat, the
 * buyers who accept the price want more than 192 seats, so the pool fills; at 320 they want 100, so it
 * expires and every seat is refunded with its share of the bonus.
 */
const SCENARIOS: Record<ScenarioName, Scenario> = {
  fills: {
    name: 'fills',
    seatPrice: 180n,
    target: 192,
    bonus: 1_728n,
    maxSeatsPerBuyer: 24,
    terms: TERMS,
    deadlineSeconds: 600,
    spreadSeconds: 120,
    expectedEnd: 'settled',
  },
  fails: {
    name: 'fails',
    seatPrice: 320n,
    target: 192,
    bonus: 3_072n,
    maxSeatsPerBuyer: 24,
    terms: TERMS,
    deadlineSeconds: 180,
    spreadSeconds: 60,
    expectedEnd: 'refunded',
  },
};

/** Whether `value` names a scenario: `fills` or `fails`. */
export function isScenarioName(value: string): value is ScenarioName {
  return Object.hasOwn(SCENARIOS, value);
}

/**
 * The scenario `name`, with the deadline and the spread the configuration sets in place of its own
 * (QUORUM_SCENARIO_DEADLINE_SECONDS and QUORUM_SWARM_SPREAD_SECONDS, null when unset). Each call
 * returns a new object.
 */
export function scenario(name: ScenarioName, config: Pick<SwarmConfig, 'deadlineSeconds' | 'spreadSeconds'>): Scenario {
  const base = SCENARIOS[name];
  return {
    ...base,
    deadlineSeconds: config.deadlineSeconds ?? base.deadlineSeconds,
    spreadSeconds: config.spreadSeconds ?? base.spreadSeconds,
  };
}
