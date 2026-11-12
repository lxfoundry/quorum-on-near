import { transportReason, type ActivityRecord, type GatewayClient } from '@quorum-on-near/buyer';
import { MAX_PAGE, poolsEvents, priceOf, type PoolStatus, type PoolView, type SeatView } from '@quorum-on-near/protocol';
import { buyerIds } from './accounts.ts';
import { allPools, TGAS, type MissingOutcome, type SwarmChain, type TxOutcome } from './chain.ts';
import type { SwarmConfig } from './config.ts';
import type { Scenario } from './scenarios.ts';
import { count } from './words.ts';

/** A status a pool ends in: Settled once filled, Refunded once expired. */
type EndStatus = Scenario['expectedEnd'];

/** Token balances in base units by account id, read by snapshot before a pool opens. */
export type Baseline = ReadonlyMap<string, bigint>;

/** What checkPool reads, how it waits, and where it prints its lines. */
export interface CheckDeps {
  chain: Pick<SwarmChain, 'getPool' | 'getSeats' | 'listPools' | 'ftBalanceOf' | 'finalBlock' | 'txOutcome'>;
  /** The gateway's activity feed, for the transactions of the pool's commits, settlement and refunds. */
  gateway: Pick<GatewayClient, 'activity'>;
  /** The local clock in milliseconds: it only measures how long the check has waited. */
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
}

/** The pool to check, the scenario it was opened for, and the balances read before it opened. */
export interface CheckRequest {
  poolId: number;
  scenario: Pick<Scenario, 'name' | 'expectedEnd'>;
  /** When given, each account in it is checked for the change the pool's end implies. */
  baseline?: Baseline;
  /**
   * Transactions that may be relayed commits of `account` which the activity feed lacks, such as the
   * hashes the scripted buyers learned: the gateway records no relay whose result was unknown. Each
   * one the feed lacks is looked up, and is measured as a commit when its outcome shows the pools
   * contract committing seats in the pool to its account; any other is left out.
   */
  extraCommits?: ReadonlyArray<{ account: string; txHash: string }>;
}

/** One check: its name, whether it passed, and the figures it measured. */
export interface CheckLine {
  name: string;
  ok: boolean;
  detail: string;
}

/** Every check made on a pool, in the order printed; `failed` when any of them did not pass. */
export interface CheckReport {
  poolId: number;
  /** The pool's status when the checks were made. */
  status: PoolStatus;
  lines: CheckLine[];
  failed: boolean;
}

/** The pools contract's views know no pool of this id. */
export class UnknownPoolError extends Error {
  override name = 'UnknownPoolError';
  readonly poolId: number;

  constructor(poolId: number) {
    super(`the pools contract has no pool ${poolId}`);
    this.poolId = poolId;
  }
}

/**
 * What each `ft_transfer` the pools contract makes, and each callback, must burn less than: half
 * the 10 Tgas the contract gives each of them.
 */
const PAYOUT_GAS_LIMIT = 5n * TGAS;
/** How often the check reads the pool while it waits for the pool to end, and reads again a read that failed. */
const POLL_INTERVAL_MS = 2_000;
/** How many times a read made after the wait is tried before its error is passed on. */
const READ_ATTEMPTS = 3;
/** How long after the pool's deadline the check waits for the keeper to settle or refund it. */
const RESOLUTION_GRACE_MS = 300_000;

/**
 * Reads the token balances checkPool compares a pool's end with: the provider's, the pools
 * contract's and every buyer's (buyerIds). Taken before the pool opens, since opening it moves the
 * provider's bonus.
 */
export async function snapshot(
  config: Pick<SwarmConfig, 'parent' | 'mcpAccount' | 'provider' | 'poolsContract'>,
  chain: Pick<SwarmChain, 'ftBalanceOf'>,
): Promise<Baseline> {
  const baseline = new Map<string, bigint>();
  for (const id of [config.provider, config.poolsContract, ...buyerIds(config)]) {
    baseline.set(id, await chain.ftBalanceOf(id));
  }
  return baseline;
}

/**
 * The gas a relayed commit burnt in the commit itself: the receipts after the buyer's delegate
 * receipt that ran on `contracts` (the token's `ft_transfer_call` and `ft_resolve_transfer`, the
 * pools contract's `ft_on_transfer`). The relayer's transaction, the delegate receipt and the gas
 * refunds are left out. Null, the gas unmeasured, when no receipt ran on `buyer`, or none ran on
 * `contracts` after it, as for a delegate that failed before its call reached the token.
 */
export function commitGas(outcome: TxOutcome, buyer: string, contracts: readonly string[]): bigint | null {
  const delegate = outcome.receipts.findIndex((receipt) => receipt.executorId === buyer);
  if (delegate === -1) return null;
  const steps = outcome.receipts.slice(delegate + 1).filter((receipt) => contracts.includes(receipt.executorId));
  if (steps.length === 0) return null;
  return steps.reduce((sum, receipt) => sum + receipt.gasBurnt, 0n);
}

/**
 * The gas of each payout in a `settle` or `refund` transaction: after the call's own receipt (the
 * first the pools contract ran), each receipt the token ran is an `ft_transfer`, and each later one
 * the pools contract ran is its callback.
 */
export function payoutGas(outcome: TxOutcome, poolsContract: string, token: string): { transfers: bigint[]; callbacks: bigint[] } {
  const call = outcome.receipts.findIndex((receipt) => receipt.executorId === poolsContract);
  const payouts = call === -1 ? [] : outcome.receipts.slice(call + 1);
  const gasOf = (executor: string): bigint[] =>
    payouts.filter((receipt) => receipt.executorId === executor).map((receipt) => receipt.gasBurnt);
  return { transfers: gasOf(token), callbacks: gasOf(poolsContract) };
}

/**
 * The final check of a pool (spec section 10). It first waits, polling the pool every 2 s, until the
 * pool is Settled or Refunded and the gateway's activity feed holds the keeper transaction that
 * ended it (an ok `settle` record, or the `dust` record that `pool_refunded` gives). It gives up 5
 * minutes after the pool's deadline: the time left until the deadline is read in block time when the
 * wait starts, and the wait is measured on the local clock. Every transaction in the feed is then
 * read at FINAL, so the balances read after it include every transfer it made. Then, printing each
 * check as it goes:
 * - status: the scenario's expected end;
 * - buyers: each buyer `committed` in a Settled pool, their seats adding up to `taken` (no buyers
 *   fail it), and each `refunded` in a Refunded one;
 * - refunds and dust, for a Refunded pool (invariant 4), on what the activity feed records as
 *   transferred (refundsLine): each refunded buyer's refund, the dust, and their total;
 * - solvency (invariant 1): the pools contract's token balance covers what every pool still owes,
 *   all read at the height of one final block;
 * - with a baseline, the change in the balance of the pool's seller, the pools contract and each
 *   buyer of the pool, for the accounts in the baseline: once Settled, the seller `+taken × price`
 *   and each buyer `−seats × price`; once Refunded, the seller `−(bonus − dust)` and each buyer
 *   `+seats × bonus_per_seat`; the pools contract 0 either way;
 * - commit gas: each relayed commit's commitGas at most QUORUM_COMMIT_MIN_GAS, the commits being
 *   the feed's and those of `request.extraCommits` that took seats; a commit whose gas is unmeasured
 *   fails it if it is an ok record of the feed or an extra commit, and is named in a note if the feed
 *   records it as taking no seats; once the pool has ended, every one of the swarm's buyers
 *   (buyerIds) holding seats must have an ok commit record or such an extra commit, and a holder the
 *   swarm does not know is named in a note instead;
 * - payout gas: each `ft_transfer` and callback of the feed's `settle`, `refund` and `dust`
 *   transactions (payoutGas) under 5 Tgas, and, once the pool has ended, at least one `ft_transfer`
 *   across them; once the pool is Refunded, every one of the swarm's buyers whose seats are
 *   `refunded` must have an ok refund record, a buyer the swarm does not know being named in a note
 *   instead.
 * The buyer, invariant and balance checks need the pool ended and are left out if it has not.
 * Transactions are looked up with the relayer as their signer.
 *
 * A read that fails while the check waits is made again at the next poll, each failure logged once
 * by what it read and its transportReason. When the last poll before the limit failed, a `reads`
 * check fails after the status, which is then the last one read; when no poll ever read the pool,
 * the last error is thrown once 5 minutes have passed. Each read made after the wait is tried up to
 * 3 times, 2 s apart, the solvency reads with a new final block each time, before its error is passed
 * on. Throws UnknownPoolError, at once, for a pool that does not exist.
 */
export async function checkPool(
  config: Pick<SwarmConfig, 'relayer' | 'poolsContract' | 'token' | 'commitMinGas' | 'parent' | 'mcpAccount'>,
  deps: CheckDeps,
  request: CheckRequest,
): Promise<CheckReport> {
  const { chain } = deps;
  const lines: CheckLine[] = [];
  const add = (line: CheckLine): void => {
    lines.push(line);
    deps.log(`${line.ok ? 'ok  ' : 'FAIL'}  ${line.name}: ${line.detail}`);
  };

  const { pool, records, waitedMs, lastReadError } = await awaitEnd(deps, request.poolId);
  add(statusLine(pool, request.scenario, waitedMs));
  if (lastReadError !== null) add({ name: 'reads', ok: false, detail: `the last read before the limit failed: ${lastReadError}` });
  const outcomes: Outcomes = new Map();
  for (const { txHash } of records) {
    if (!outcomes.has(txHash)) {
      outcomes.set(txHash, await retryRead(deps, `transaction ${txHash}`, () => chain.txOutcome(txHash, config.relayer)));
    }
  }

  const end = endStatus(pool.status);
  const seats = end === null ? [] : await retryRead(deps, 'the buyers', () => allSeats(chain, pool.id));
  const known = new Set(buyerIds(config));
  if (end !== null) {
    add(buyersLine(pool, end, seats));
    if (end === 'refunded') add(refundsLine(pool, seats, records, known));
  }
  add(await retryRead(deps, 'the solvency figures', () => solvencyLine(chain, config.poolsContract)));
  if (end !== null && request.baseline !== undefined) {
    const balance = (id: string): Promise<bigint> => retryRead(deps, `the balance of ${id}`, () => chain.ftBalanceOf(id));
    for (const line of await balanceLines(balance, config.poolsContract, pool, end, seats, request.baseline)) add(line);
  }
  const learned = await learnedCommits(deps, config, pool.id, request.extraCommits ?? [], outcomes);
  const holders = end === null ? null : { seats, known };
  add(commitGasLine(config, records, learned, outcomes, holders));
  add(payoutGasLine(config, end, records, outcomes, holders));

  return { poolId: pool.id, status: pool.status, lines, failed: lines.some((line) => !line.ok) };
}

/** Each transaction looked up, by its hash: its outcome, or why it has none. */
type Outcomes = Map<string, TxOutcome | MissingOutcome>;

/** Why a transaction has no outcome, in the check's words: unknown to the RPC, or not yet final. */
function missing(txHash: string, why: MissingOutcome): string {
  return why === 'unknown' ? `${txHash} is unknown to the RPC` : `${txHash} is not yet final (waited for once)`;
}

/** A relayed commit, by its transaction and its buyer. */
interface CommitTx {
  txHash: string;
  account: string;
}

/** An ended pool's buyers as `get_seats` lists them, and the accounts of the swarm's own buyers among which they are checked. */
interface Holders {
  seats: readonly SeatView[];
  known: ReadonlySet<string>;
}

/**
 * The commits of `extra` that the feed lacks and whose outcome shows the pools contract committing
 * seats in pool `poolId` to their account. Each transaction not looked up yet (every one of the feed
 * has been) is looked up into `outcomes`; one with no outcome, or that took no seats for its account
 * in this pool, is left out.
 */
async function learnedCommits(
  deps: CheckDeps,
  config: Pick<SwarmConfig, 'relayer' | 'poolsContract'>,
  poolId: number,
  extra: readonly CommitTx[],
  outcomes: Outcomes,
): Promise<CommitTx[]> {
  const commits: CommitTx[] = [];
  for (const { txHash, account } of extra) {
    if (outcomes.has(txHash)) continue;
    const outcome = await retryRead(deps, `transaction ${txHash}`, () => deps.chain.txOutcome(txHash, config.relayer));
    outcomes.set(txHash, outcome);
    const took =
      typeof outcome !== 'string' &&
      poolsEvents(outcome, config.poolsContract).some(
        (event) => event.event === 'seats_committed' && event.data.pool_id === poolId && event.data.buyer === account,
      );
    if (took) commits.push({ txHash, account });
  }
  return commits;
}

/** `seats` split into those of the swarm's buyers and those of accounts it does not know. */
function byKnown(holders: Holders, seats: readonly SeatView[]): { known: SeatView[]; strangers: SeatView[] } {
  return {
    known: seats.filter((seat) => holders.known.has(seat.buyer)),
    strangers: seats.filter((seat) => !holders.known.has(seat.buyer)),
  };
}

/** Each buyer with its seats: `a.testnet (2 seats), b.testnet (1 seat)`. */
function withSeats(seats: readonly SeatView[]): string {
  return seats.map((seat) => `${seat.buyer} (${count(seat.seats, 'seat')})`).join(', ');
}

/** `one` when `items` holds one item, else `many`. */
function agree<T>(items: readonly T[], one: string, many: string): string {
  return items.length === 1 ? one : many;
}

/** What the wait read last: the pool and the feed, and why the last poll failed, if it did. */
interface Waited {
  pool: PoolView;
  records: ActivityRecord[];
  waitedMs: number;
  /** What the last poll before the limit could not read, and why; null when it read everything. */
  lastReadError: string | null;
}

/**
 * Polls the pool and the feed until the pool has ended and the feed holds the record of the
 * transaction that ended it, or until 5 minutes past the pool's deadline: the time left until the
 * deadline is read in block time from the first pool and final block read, and the wait is measured
 * on the local clock. A poll that fails is logged, once for each distinct failure, and made again
 * after the interval; until the pool is first read, the limit is 5 minutes from the start, and the
 * last error is thrown when it passes. UnknownPoolError is thrown at once.
 */
async function awaitEnd(deps: CheckDeps, poolId: number): Promise<Waited> {
  const start = deps.now();
  let limitMs = RESOLUTION_GRACE_MS;
  let pool: PoolView | null = null;
  let records: ActivityRecord[] = [];
  let failure: { error: unknown; text: string } | null = null;
  const logged = new Set<string>();
  for (;;) {
    let reading = 'the pool';
    try {
      const view = await readPool(deps.chain, poolId);
      if (pool === null) {
        reading = 'the final block';
        const block = await deps.chain.finalBlock();
        limitMs = deps.now() - start + Math.max(0, view.deadline_ms - block.timestampMs) + RESOLUTION_GRACE_MS;
      }
      pool = view;
      reading = 'the activity feed';
      records = await deps.gateway.activity(poolId);
      failure = null;
    } catch (error) {
      if (error instanceof UnknownPoolError) throw error;
      failure = { error, text: `could not read ${reading} (${transportReason(error)})` };
      if (!logged.has(failure.text)) {
        logged.add(failure.text);
        deps.log(`${failure.text}: reads it again in ${POLL_INTERVAL_MS / 1000} s`);
      }
    }
    const waitedMs = deps.now() - start;
    const end = pool === null ? null : endStatus(pool.status);
    if (pool !== null && failure === null && end !== null && records.some((record) => endsPool(record, end))) {
      return { pool, records, waitedMs, lastReadError: null };
    }
    if (waitedMs >= limitMs) {
      if (pool === null) throw failure?.error;
      return { pool, records, waitedMs, lastReadError: failure?.text ?? null };
    }
    await deps.sleep(POLL_INTERVAL_MS);
  }
}

/**
 * `read()`, tried up to READ_ATTEMPTS times, POLL_INTERVAL_MS apart, the first failure logged by
 * `what` and its transportReason; the last attempt's error is passed on. UnknownPoolError is never
 * read again.
 */
async function retryRead<T>(deps: Pick<CheckDeps, 'sleep' | 'log'>, what: string, read: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await read();
    } catch (error) {
      if (error instanceof UnknownPoolError || attempt === READ_ATTEMPTS) throw error;
      if (attempt === 1) deps.log(`could not read ${what} (${transportReason(error)}): reads it again in ${POLL_INTERVAL_MS / 1000} s`);
      await deps.sleep(POLL_INTERVAL_MS);
    }
  }
}

async function readPool(chain: Pick<SwarmChain, 'getPool'>, poolId: number): Promise<PoolView> {
  const pool = await chain.getPool(poolId);
  if (pool === null) throw new UnknownPoolError(poolId);
  return pool;
}

function endStatus(status: PoolStatus): EndStatus | null {
  return status === 'settled' || status === 'refunded' ? status : null;
}

/** The record of the keeper transaction that ends a pool in `end`: `pool_settled` or `pool_refunded`. */
function endsPool(record: ActivityRecord, end: EndStatus): boolean {
  return record.ok && record.kind === endRecordKind(end);
}

function endRecordKind(end: EndStatus): ActivityRecord['kind'] {
  return end === 'settled' ? 'settle' : 'dust';
}

/** Every buyer of a pool, paging `get_seats` by MAX_PAGE until a page comes back shorter; at `atHeight` when given. */
async function allSeats(chain: Pick<SwarmChain, 'getSeats'>, poolId: number, atHeight?: bigint): Promise<SeatView[]> {
  const seats: SeatView[] = [];
  for (;;) {
    const page = await chain.getSeats(poolId, seats.length, MAX_PAGE, atHeight);
    seats.push(...page);
    if (page.length < MAX_PAGE) return seats;
  }
}

function statusLine(pool: PoolView, scenario: CheckRequest['scenario'], waitedMs: number): CheckLine {
  const ok = pool.status === scenario.expectedEnd;
  if (ok) return { name: 'status', ok, detail: `${pool.status}, as ${scenario.name} expects` };
  const seen = endStatus(pool.status) === null ? `${pool.status} after waiting ${Math.round(waitedMs / 1000)} s` : pool.status;
  return { name: 'status', ok, detail: `${seen}; ${scenario.name} ends ${scenario.expectedEnd}` };
}

/**
 * Every buyer `committed` in a Settled pool, and `refunded` in a Refunded one. A Settled pool's buyers
 * must also hold, between them, the seats it took: none, or fewer or more, fails the line.
 */
function buyersLine(pool: PoolView, end: EndStatus, seats: readonly SeatView[]): CheckLine {
  const state = end === 'settled' ? 'committed' : 'refunded';
  const problems: string[] = [];
  const others = seats.filter((seat) => seat.state !== state);
  if (others.length > 0) {
    const listed = others.map((seat) => `${seat.buyer} ${seat.state}`).join(', ');
    problems.push(`${others.length} of ${count(seats.length, 'buyer')} not ${state}: ${listed}`);
  }
  if (end === 'settled') {
    const held = seats.reduce((sum, seat) => sum + seat.seats, 0);
    if (seats.length === 0) problems.push(`no buyers hold the ${count(pool.taken, 'seat')} the pool took`);
    else if (held !== pool.taken) problems.push(`${count(seats.length, 'buyer')} hold ${count(held, 'seat')}, not the ${pool.taken} the pool took`);
  }
  if (problems.length > 0) return { name: 'buyers', ok: false, detail: problems.join('; ') };
  if (seats.length === 0) return { name: 'buyers', ok: true, detail: 'no buyers' };
  return { name: 'buyers', ok: true, detail: `${count(seats.length, 'buyer')}, all ${state}` };
}

/**
 * Invariant 4 for a Refunded pool, on what was transferred as the activity feed records it: the `ok`
 * refund records of each buyer whose seats the views give as `refunded` carry `seats × (seat_price +
 * bonus_per_seat)`, the `dust` record carries `bonus − taken × bonus_per_seat`, and the feed's
 * refunds plus the dust total `taken × seat_price + bonus`. The feed has no record of a refund a buyer
 * claimed itself: such a buyer counts in the total at what it was due, and fails the line if it is one
 * of the swarm's buyers (`known`), or is named in a note otherwise. The bonus shares must not come to
 * more than the bonus.
 */
function refundsLine(
  pool: PoolView,
  seats: readonly SeatView[],
  records: readonly ActivityRecord[],
  known: ReadonlySet<string>,
): CheckLine {
  const name = 'refunds and dust';
  const { price, bonus, share } = amounts(pool);
  const shared = priceOf(pool.taken, share);
  if (shared > bonus) {
    return { name, ok: false, detail: `a bonus share of ${share} for each of ${pool.taken} seats comes to more than the bonus ${bonus}` };
  }
  const paid = new Map<string, bigint>();
  for (const record of records) {
    if (record.kind === 'refund' && record.ok) paid.set(record.account, (paid.get(record.account) ?? 0n) + record.amount);
  }
  let refunds = [...paid.values()].reduce((sum, amount) => sum + amount, 0n);
  const problems: string[] = [];
  const unrecorded: SeatView[] = [];
  for (const seat of seats.filter((row) => row.state === 'refunded')) {
    const due = priceOf(seat.seats, price + share);
    const got = paid.get(seat.buyer);
    if (got === undefined) {
      unrecorded.push(seat);
      refunds += due;
    } else if (got !== due) {
      problems.push(`${seat.buyer} was refunded ${got}, not ${seat.seats} × (${price} + ${share}) = ${due}`);
    }
  }
  const ids = (rows: readonly SeatView[]): string => rows.map((row) => row.buyer).join(', ');
  const ours = unrecorded.filter((seat) => known.has(seat.buyer));
  const strangers = unrecorded.filter((seat) => !known.has(seat.buyer));
  if (ours.length > 0) {
    problems.push(
      `${ids(ours)} ${agree(ours, 'was', 'were')} refunded, but the activity feed has no refund of ${agree(ours, 'it', 'theirs')} ` +
        '(the gateway records only the refunds its keeper sends, not one a buyer claims itself)',
    );
  }
  const dustRecords = records.filter((record) => record.kind === 'dust' && record.ok);
  const dust = dustRecords.reduce((sum, record) => sum + record.amount, 0n);
  const dueDust = bonus - shared;
  if (dustRecords.length === 0) problems.push('the activity feed has no dust record');
  else if (dust !== dueDust) problems.push(`the dust record carries ${dust}, not bonus ${bonus} − ${pool.taken} × ${share} = ${dueDust}`);
  const takenIn = priceOf(pool.taken, price) + bonus;
  if (refunds + dust !== takenIn) {
    problems.push(`refunds ${refunds} + dust ${dust} = ${refunds + dust}, not ${pool.taken} × ${price} + bonus ${bonus} = ${takenIn}`);
  }
  const notes =
    strangers.length === 0
      ? []
      : [
          `not checked: ${ids(strangers)} ${agree(strangers, 'was', 'were')} refunded with no refund in the activity feed, ` +
            `and ${agree(strangers, 'is', 'are')} not one of the swarm's buyers`,
        ];
  const ok = problems.length === 0;
  const figures = ok ? `refunds ${refunds} + dust ${dust} = ${pool.taken} × ${price} + bonus ${bonus} = ${takenIn}` : problems.join('; ');
  return { name, ok, detail: [figures, ...notes].join('; ') };
}

/**
 * Invariant 1, across every pool. The balance and every view are read at the height of one final
 * block: read at different blocks, a commit landing between two reads would count in the views
 * money that the balance read earlier did not hold yet, and fail the check falsely.
 */
async function solvencyLine(chain: CheckDeps['chain'], poolsContract: string): Promise<CheckLine> {
  const { height } = await chain.finalBlock();
  const balance = await chain.ftBalanceOf(poolsContract, height);
  const pools = await allPools(chain, height);
  let owed = 0n;
  for (const pool of pools) owed += await owedBy(chain, pool, height);
  const ok = balance >= owed;
  const detail = `the pools contract holds ${balance} ${ok ? 'and' : 'but'} owes ${owed} across ${count(pools.length, 'pool')}`;
  return { name: 'solvency', ok, detail };
}

/**
 * What a pool still owes (spec section 5.5): Open or Filled, `taken × seat_price + bonus`; Settled,
 * nothing; Expired or Refunded, the refunds of its buyers not yet refunded and the dust unless sent.
 * Its buyers are read at `atHeight`.
 */
async function owedBy(chain: Pick<SwarmChain, 'getSeats'>, pool: PoolView, atHeight: bigint): Promise<bigint> {
  const { price, bonus, share } = amounts(pool);
  switch (pool.status) {
    case 'open':
    case 'filled':
      return priceOf(pool.taken, price) + bonus;
    case 'settled':
      return 0n;
    case 'expired':
    case 'refunded': {
      const unpaid = (await allSeats(chain, pool.id, atHeight)).filter((seat) => seat.state !== 'refunded');
      const refunds = unpaid.reduce((sum, seat) => sum + priceOf(seat.seats, price + share), 0n);
      return refunds + (pool.dust_sent ? 0n : bonus - priceOf(pool.taken, share));
    }
  }
}

/**
 * The balance checks of the accounts in the baseline: the seller, the pools contract, then the pool's
 * buyers, each account's balance read now with `balanceOf`.
 */
async function balanceLines(
  balanceOf: (accountId: string) => Promise<bigint>,
  poolsContract: string,
  pool: PoolView,
  end: EndStatus,
  seats: readonly SeatView[],
  baseline: Baseline,
): Promise<CheckLine[]> {
  const { price, bonus, share } = amounts(pool);
  const changeOf = async (id: string): Promise<bigint | null> => {
    const before = baseline.get(id);
    return before === undefined ? null : (await balanceOf(id)) - before;
  };
  const dust = bonus - priceOf(pool.taken, share);
  const sellerChange = end === 'settled' ? priceOf(pool.taken, price) : -(bonus - dust);
  const lines: CheckLine[] = [];
  for (const [name, id, expected] of [
    ['provider balance', pool.seller, sellerChange],
    ['pools contract balance', poolsContract, 0n],
  ] as const) {
    const change = await changeOf(id);
    if (change === null) continue;
    const ok = change === expected;
    lines.push({ name, ok, detail: `${id} changed by ${signed(change)}, ${ok ? 'as expected' : `expected ${signed(expected)}`}` });
  }

  const off: string[] = [];
  let compared = 0;
  for (const seat of seats) {
    const change = await changeOf(seat.buyer);
    if (change === null) continue;
    compared += 1;
    const expected = end === 'settled' ? -priceOf(seat.seats, price) : priceOf(seat.seats, share);
    if (change !== expected) off.push(`${seat.buyer} changed by ${signed(change)}, expected ${signed(expected)}`);
  }
  if (compared > 0) {
    const ok = off.length === 0;
    const detail = ok ? `${count(compared, 'buyer')} changed as expected` : `${off.length} of ${count(compared, 'buyer')} off: ${off.join('; ')}`;
    lines.push({ name: 'buyer balances', ok, detail });
  }
  return lines;
}

/**
 * The commit gas check: the gas of the feed's commits and of the `learned` ones, and, once the pool
 * has ended (`holders`), whether every holder among the swarm's buyers has a commit measured. A
 * commit whose gas is unmeasured (commitGas is null) fails it, unless the feed records it as taking
 * no seats: that one is named in a note.
 */
function commitGasLine(
  config: Pick<SwarmConfig, 'poolsContract' | 'token' | 'commitMinGas'>,
  records: readonly ActivityRecord[],
  learned: readonly CommitTx[],
  outcomes: ReadonlyMap<string, TxOutcome | MissingOutcome>,
  holders: Holders | null,
): CheckLine {
  const fed = records.filter((record) => record.kind === 'commit');
  const commits = uniqueByHash<CommitTx & { ok?: boolean }>([...fed, ...learned]);
  const problems: string[] = [];
  const notes: string[] = [];
  if (holders !== null) {
    const measured = new Set([...fed.filter((record) => record.ok), ...learned].map((commit) => commit.account));
    const { known, strangers } = byKnown(holders, holders.seats.filter((seat) => seat.seats > 0 && !measured.has(seat.buyer)));
    if (known.length > 0) {
      problems.push(
        `not measured: ${withSeats(known)} ${agree(known, 'holds', 'hold')} seats, but the activity feed has no commit of ` +
          `${agree(known, 'it', 'theirs')} (the gateway records no relay whose result was unknown; its feed is in its QUORUM_DATA_DIR)`,
      );
    }
    if (strangers.length > 0) {
      notes.push(
        `not checked: ${withSeats(strangers)} ${agree(strangers, 'holds', 'hold')} seats with no commit in the activity feed, ` +
          `and ${agree(strangers, 'is', 'are')} not one of the swarm's buyers`,
      );
    }
  }
  let most = 0n;
  for (const commit of commits) {
    const { txHash, account } = commit;
    const outcome = outcomes.get(txHash) ?? 'unknown';
    if (typeof outcome === 'string') {
      problems.push(missing(txHash, outcome));
      continue;
    }
    const gas = commitGas(outcome, account, [config.token, config.poolsContract]);
    if (gas === null) {
      const ran = outcome.receipts.some((receipt) => receipt.executorId === account);
      const why = ran ? `ran no token or pools receipt after the delegate of ${account}` : `ran no receipt on ${account}`;
      // A commit the feed records as taking no seats is a delegate that failed: it has no gas to measure.
      if ('ok' in commit && !commit.ok) notes.push(`not measured: ${txHash} took no seats, and ${why}`);
      else problems.push(`${txHash} ${why}`);
      continue;
    }
    if (gas > most) most = gas;
    if (gas > config.commitMinGas) problems.push(`${txHash} burnt ${tgas(gas)} Tgas`);
  }
  const limit = `${tgas(config.commitMinGas)} Tgas`;
  const counted = commits.length === 0 ? 'no commits' : count(commits.length, 'commit');
  const ok = problems.length === 0;
  const figures = !ok ? `${counted}, limit ${limit}: ${problems.join('; ')}` : commits.length === 0 ? counted : `${counted}, at most ${tgas(most)} Tgas each (limit ${limit})`;
  return { name: 'commit gas', ok, detail: [figures, ...notes].join('; ') };
}

/**
 * The payout gas check: the gas of each payout of the feed's keeper transactions; once the pool has
 * ended, that they made at least one `ft_transfer`; and, once the pool is Refunded (`holders`),
 * whether every refunded buyer among the swarm's has a refund recorded.
 */
function payoutGasLine(
  config: Pick<SwarmConfig, 'poolsContract' | 'token'>,
  end: EndStatus | null,
  records: readonly ActivityRecord[],
  outcomes: ReadonlyMap<string, TxOutcome | MissingOutcome>,
  holders: Holders | null,
): CheckLine {
  const calls = uniqueByHash(records.filter((record) => record.kind !== 'commit'));
  const problems: string[] = [];
  const notes: string[] = [];
  if (end !== null && !records.some((record) => endsPool(record, end))) {
    problems.push(`the activity feed has no ${endRecordKind(end)} record`);
  }
  if (end === 'refunded' && holders !== null) {
    const recorded = new Set(records.filter((record) => record.kind === 'refund' && record.ok).map((record) => record.account));
    const { known, strangers } = byKnown(holders, holders.seats.filter((seat) => seat.state === 'refunded' && !recorded.has(seat.buyer)));
    const ids = (seats: readonly SeatView[]): string => seats.map((seat) => seat.buyer).join(', ');
    if (known.length > 0) {
      problems.push(
        `not measured: ${ids(known)} ${agree(known, 'was', 'were')} refunded, but the activity feed has no refund of ` +
          `${agree(known, 'it', 'theirs')} (the gateway records only the refunds its keeper sends; its feed is in its QUORUM_DATA_DIR)`,
      );
    }
    if (strangers.length > 0) {
      notes.push(
        `not checked: ${ids(strangers)} ${agree(strangers, 'was', 'were')} refunded with no refund in the activity feed, ` +
          `and ${agree(strangers, 'is', 'are')} not one of the swarm's buyers`,
      );
    }
  }
  const most = { transfers: 0n, callbacks: 0n };
  const counted = { transfers: 0, callbacks: 0 };
  let unread = 0;
  for (const { txHash } of calls) {
    const outcome = outcomes.get(txHash) ?? 'unknown';
    if (typeof outcome === 'string') {
      problems.push(missing(txHash, outcome));
      unread += 1;
      continue;
    }
    const gas = payoutGas(outcome, config.poolsContract, config.token);
    for (const [kind, label] of [['transfers', 'ft_transfer'], ['callbacks', 'callback']] as const) {
      for (const burnt of gas[kind]) {
        counted[kind] += 1;
        if (burnt > most[kind]) most[kind] = burnt;
        if (burnt >= PAYOUT_GAS_LIMIT) problems.push(`${txHash} ${label} burnt ${tgas(burnt)} Tgas`);
      }
    }
  }
  // A batch that only passed buyers who had claimed may transfer nothing, so this counts every keeper
  // transaction of the pool, not only the one that ended it. It is said only when every outcome was
  // read: one that was not may hold the transfer, and its own problem is listed.
  if (end !== null && calls.length > 0 && unread === 0 && counted.transfers === 0) {
    problems.push('none of the keeper transactions made an ft_transfer');
  }
  const transactions = calls.length === 0 ? 'no keeper transactions' : count(calls.length, 'transaction');
  if (problems.length > 0) return { name: 'payout gas', ok: false, detail: [`${transactions}: ${problems.join('; ')}`, ...notes].join('; ') };
  const detail =
    calls.length === 0
      ? transactions
      : `${transactions}, ${count(counted.transfers, 'ft_transfer')} at most ${tgas(most.transfers)} Tgas, ` +
        `${count(counted.callbacks, 'callback')} at most ${tgas(most.callbacks)} Tgas (each under ${tgas(PAYOUT_GAS_LIMIT)} Tgas)`;
  return { name: 'payout gas', ok: true, detail: [detail, ...notes].join('; ') };
}

/** A pool's amounts as bigints: seat price, bonus and bonus per seat. */
function amounts(pool: PoolView): { price: bigint; bonus: bigint; share: bigint } {
  return { price: BigInt(pool.seat_price), bonus: BigInt(pool.bonus), share: BigInt(pool.bonus_per_seat) };
}

/** The first record of each transaction: a keeper transaction can give several. */
function uniqueByHash<T extends { txHash: string }>(records: readonly T[]): T[] {
  const seen = new Set<string>();
  return records.filter((record) => {
    if (seen.has(record.txHash)) return false;
    seen.add(record.txHash);
    return true;
  });
}

/**
 * Gas in Tgas with 2 decimals, truncated rather than rounded, so that a figure never shows as the
 * limit it is under: 4.996 Tgas shows as 4.99.
 */
function tgas(gas: bigint): string {
  const hundredths = gas / (TGAS / 100n);
  return `${hundredths / 100n}.${(hundredths % 100n).toString().padStart(2, '0')}`;
}

function signed(amount: bigint): string {
  return amount > 0n ? `+${amount}` : `${amount}`;
}
