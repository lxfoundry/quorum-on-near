import { Buyer, keyFilePath, readKeyFile, type BuyerChainReads, type GatewayClient, type PoolReads } from '@quorum-on-near/buyer';
import { runBuyer, systemRuntime, type AgentRuntime, type BuyerOutcome, type BuyerOutcomeKind, type PoolFacts } from './buyer-agent.ts';
import { UnknownPoolError } from './check.ts';
import type { SwarmConfig } from './config.ts';
import { PROFILES, profileAccount, type BuyerProfile } from './profiles.ts';
import type { Scenario, ScenarioName } from './scenarios.ts';

/** What runSwarm uses. */
export interface RunDeps {
  /** The gateway every buyer pays and redeems through. */
  gateway: Pick<GatewayClient, 'pools' | 'offer' | 'pay' | 'redeem'>;
  /** The chain reads each buyer signs its payment with: its key's next nonce and the final height. */
  chain: BuyerChainReads;
  /**
   * The pools contract's view of the pool, read once: its deadline and seat price, which the buyers go
   * by, and which must be the scenario's seat price.
   */
  pools: PoolReads;
  /** Receives the buyers' lines, then the summary table. */
  log: (line: string) => void;
  /** The buyers' clock, timers and randomness; the system's by default. */
  runtime?: AgentRuntime;
}

/** The configuration runSwarm reads: the buyers' settings, where their key files are, and the polling interval. */
export type RunConfig = Pick<
  SwarmConfig,
  | 'network'
  | 'token'
  | 'poolsContract'
  | 'gatewayUrl'
  | 'blockTimeMs'
  | 'maxTimeoutSeconds'
  | 'parent'
  | 'credentialsDir'
  | 'redeemIntervalMs'
>;

/**
 * The pool's seat price on chain is not the scenario's, so runSwarm stopped before any buyer acted.
 * Each buyer decides at the pool's own price, while what the scenario expects of each buyer
 * (unexpectedOutcomes) is worked out at the scenario's: a pool opened for the other scenario would be
 * bought into at a price the scenario does not describe, and its outcomes compared with the wrong
 * expectations.
 */
export class SeatPriceMismatchError extends Error {
  override name = 'SeatPriceMismatchError';
  readonly poolId: number;
  /** The pool's seat price on chain, in base units. */
  readonly seatPrice: bigint;
  readonly scenario: ScenarioName;
  /** The scenario's seat price, in base units. */
  readonly scenarioSeatPrice: bigint;

  constructor(poolId: number, seatPrice: bigint, scenario: Pick<Scenario, 'name' | 'seatPrice'>) {
    super(
      `pool ${poolId}'s seat price on chain is ${seatPrice}, not the ${scenario.name} scenario's ${scenario.seatPrice}: ` +
        'nothing was sent; run the pool with the scenario it was opened for',
    );
    this.poolId = poolId;
    this.seatPrice = seatPrice;
    this.scenario = scenario.name;
    this.scenarioSeatPrice = scenario.seatPrice;
  }
}

/** The order in which the summary counts the outcomes. */
const OUTCOME_KINDS: readonly BuyerOutcomeKind[] = [
  'credential',
  'refunded',
  'claimable',
  'declined',
  'missed',
  'expired',
  'refused',
  'failed',
  'timed_out',
];

/**
 * Runs the 20 scripted buyers against pool `poolId` of the scenario, all at once, each with the key in
 * its own key file and arriving within the scenario's spread. Every key file is read, then the pool
 * from the pools contract, before any buyer acts: a missing or unreadable key file throws
 * KeyFileError, a pool the contract does not hold UnknownPoolError, and a pool whose seat price is
 * not the scenario's SeatPriceMismatchError, with nothing sent. The buyers go by the pool's deadline
 * and seat price on chain, not the gateway's. A buyer that already holds
 * seats in the pool, as after an earlier run on it, follows them and never pays again (runBuyer), so
 * a second run on a pool resumes it. Logs each buyer's steps as they happen, then a summary table,
 * and returns the outcomes in the order of PROFILES.
 */
export async function runSwarm(config: RunConfig, deps: RunDeps, poolId: number, scenario: Scenario): Promise<BuyerOutcome[]> {
  const runtime = deps.runtime ?? systemRuntime;
  const buyers: Array<{ profile: BuyerProfile; buyer: Buyer }> = [];
  for (const profile of PROFILES) {
    const accountId = profileAccount(profile, config.parent);
    const keyPair = await readKeyFile(keyFilePath(config.credentialsDir, config.network, accountId));
    const buyer = new Buyer({ settings: config, accountId, keyPair, gateway: deps.gateway, chain: deps.chain, now: () => runtime.now() });
    buyers.push({ profile, buyer });
  }
  const view = await deps.pools.getPool(poolId);
  if (view === null) throw new UnknownPoolError(poolId);
  const pool: PoolFacts = { deadlineMs: view.deadline_ms, seatPrice: BigInt(view.seat_price) };
  if (pool.seatPrice !== scenario.seatPrice) throw new SeatPriceMismatchError(poolId, pool.seatPrice, scenario);
  deps.log(`pool ${poolId} (${scenario.name}): ${buyers.length} buyers arrive over ${scenario.spreadSeconds} s`);
  const outcomes = await Promise.all(
    buyers.map(({ profile, buyer }) =>
      runBuyer(profile, {
        buyer,
        gateway: deps.gateway,
        poolId,
        pool,
        spreadMs: scenario.spreadSeconds * 1000,
        redeemIntervalMs: config.redeemIntervalMs,
        runtime,
        log: deps.log,
      }),
    ),
  );
  for (const line of summary(PROFILES.map((profile) => profile.name), outcomes)) deps.log(line);
  return outcomes;
}

/** How each scenario expects a buyer that accepts its seat price to end. */
const EXPECTED: Record<ScenarioName, readonly BuyerOutcomeKind[]> = {
  // The pool fills; a buyer that arrives once no seat is left misses it.
  fills: ['credential', 'missed'],
  // The pool expires, and every seat is refunded with its share of the bonus.
  fails: ['refunded'],
};

/** A buyer that did not end as its scenario expects. */
export interface UnexpectedOutcome {
  /** The buyer's profile name, such as `buyer-03`. */
  name: string;
  outcome: BuyerOutcome;
  /** What the scenario expects of it, in words. */
  expected: string;
}

/**
 * The buyers that did not end as the scenario expects. A buyer whose top price is at or above the
 * seat price must end as EXPECTED says for the scenario (fills: `credential` or `missed`; fails:
 * `refunded`); any other buyer must hold no seats, whatever its end. `outcomes[i]` is the outcome of
 * `profiles[i]`, as runSwarm returns them; an outcome past the last profile is left out.
 */
export function unexpectedOutcomes(
  scenario: Pick<Scenario, 'name' | 'seatPrice'>,
  outcomes: readonly BuyerOutcome[],
  profiles: readonly BuyerProfile[] = PROFILES,
): UnexpectedOutcome[] {
  const kinds = EXPECTED[scenario.name];
  return outcomes.flatMap((outcome, i) => {
    const profile = profiles[i];
    if (profile === undefined) return [];
    if (profile.topPrice >= scenario.seatPrice) {
      return kinds.includes(outcome.kind) ? [] : [{ name: profile.name, outcome, expected: kinds.join(' or ') }];
    }
    if (outcome.seats === 0) return [];
    const expected = `no seats, its top price ${profile.topPrice} being below the seat price ${scenario.seatPrice}`;
    return [{ name: profile.name, outcome, expected }];
  });
}

/** A table of the outcomes, one row per buyer, then a line of totals. */
function summary(names: readonly string[], outcomes: readonly BuyerOutcome[]): string[] {
  const rows = outcomes.map((outcome, i) => {
    const { kind, seats, paid, detail } = outcome;
    return [names[i] ?? outcome.buyer, kind, `${seats}`, `${paid}`, detail];
  });
  const table = columns([['buyer', 'outcome', 'seats', 'paid', 'detail'], ...rows], [false, false, true, true, false]);
  const seats = outcomes.reduce((total, outcome) => total + outcome.seats, 0);
  const paid = outcomes.reduce((total, outcome) => total + outcome.paid, 0n);
  const counts = OUTCOME_KINDS.map((kind) => [kind, outcomes.filter((outcome) => outcome.kind === kind).length] as const)
    .filter(([, count]) => count > 0)
    .map(([kind, count]) => `${kind} ${count}`);
  return [...table, `${seats} seats, ${paid} paid: ${counts.join(', ')}`];
}

/** Lays rows out in columns two spaces apart, right-aligning those `right` says; the last is not padded. */
function columns(rows: readonly string[][], right: readonly boolean[]): string[] {
  const widths = right.map((_, column) => Math.max(...rows.map((row) => (row[column] ?? '').length)));
  return rows.map((row) =>
    row
      .map((cell, column) => {
        if (column === row.length - 1) return cell;
        const width = widths[column] ?? 0;
        return right[column] === true ? cell.padStart(width) : cell.padEnd(width);
      })
      .join('  '),
  );
}
