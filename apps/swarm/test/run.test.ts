import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  KeyFileError,
  keyFilePath,
  writeKeyFile,
  type BuyerChainReads,
  type OfferAnswer,
  type PaymentAnswer,
  type PoolReads,
  type PoolsAnswer,
  type RedeemAnswer,
} from '@quorum-on-near/buyer';
import {
  buildOffer,
  checkPaymentHeader,
  decodeHeader,
  minBonusPerSeat,
  offerSeats,
  type OfferContext,
  type PoolView,
  type RedeemProof,
} from '@quorum-on-near/protocol';
import { KeyPair } from 'near-api-js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentRuntime, BuyerOutcome, BuyerOutcomeKind } from '../src/buyer-agent.ts';
import { UnknownPoolError } from '../src/chain.ts';
import { PROFILES, profileAccount } from '../src/profiles.ts';
import { runSwarm, SeatPriceMismatchError, unexpectedOutcomes, type RunDeps } from '../src/run.ts';
import { scenario, type Scenario } from '../src/scenarios.ts';
import { NOW_MS, PARENT, POOLS, poolView, testConfig, TOKEN } from './fake-chain.ts';

const DEFAULTS = { deadlineSeconds: null, spreadSeconds: null };
const FILLS = scenario('fills', DEFAULTS);
const FAILS = scenario('fails', DEFAULTS);
const TX = 'GqzWbLhRRyJk3TrHbBo3ApuWVQSxZvJ9YeCMfcQt5o4d';
const CREDENTIAL = 'eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJidXllciJ9.c2lnbmF0dXJl';
const OFFER_CONTEXT: OfferContext = {
  network: 'near:testnet',
  gatewayUrl: 'http://localhost:8402',
  poolsContract: POOLS,
  token: TOKEN,
  relayer: `relay.${PARENT}`,
  minGas: 50_000_000_000_000n,
  maxGas: 100_000_000_000_000n,
  maxTimeoutSeconds: 120,
};

let credentialsDir: string;

beforeEach(async () => {
  credentialsDir = await mkdtemp(join(tmpdir(), 'quorum-run-'));
});

afterEach(async () => {
  await rm(credentialsDir, { recursive: true, force: true });
});

/** Writes a fresh key file for each scripted buyer but those in `skip`; returns each account's public key. */
async function writeKeys(skip: string[] = []): Promise<Map<string, string>> {
  const keys = new Map<string, string>();
  for (const profile of PROFILES) {
    const accountId = profileAccount(profile, PARENT);
    if (skip.includes(accountId)) continue;
    const keyPair = KeyPair.fromRandom('ed25519');
    await writeKeyFile(keyFilePath(credentialsDir, 'near:testnet', accountId), accountId, keyPair);
    keys.set(accountId, keyPair.getPublicKey().toString());
  }
  return keys;
}

/**
 * A gateway for one pool that offers every buyer the seats it asks for, answers each payment 202
 * after checking it as the gateway does, and redeems with a credential for the seats held (`fills`) or
 * their refund with a bonus of 30 a seat (`fails`), or no_seats for a buyer that holds none. It
 * records each payment's signer and key; `held` may be given seats before the run. `arrive`, when
 * given, is awaited by every request for the list of pools.
 */
function stubGateway(pool: PoolView, arrive?: () => Promise<void>) {
  const held = new Map<string, number>();
  const signedWith = new Map<string, string>();
  const requests: string[] = [];
  const seatPrice = BigInt(pool.seat_price);
  const gateway: RunDeps['gateway'] = {
    async pools(): Promise<PoolsAnswer> {
      requests.push('pools');
      await arrive?.();
      const { id, terms, target, taken, deadline_ms } = pool;
      const bonus = BigInt(pool.bonus);
      const listing = { id, terms, seat_price: seatPrice, target, taken, deadline_ms, bonus, min_bonus_per_seat: minBonusPerSeat(bonus, target) };
      return { kind: 'pools', pools: [listing] };
    },
    async offer(_poolId, seats): Promise<OfferAnswer> {
      requests.push('offer');
      return { kind: 'offer', offer: buildOffer(pool, offerSeats(pool, seats), OFFER_CONTEXT) };
    },
    async pay(poolId, seats, header): Promise<PaymentAnswer> {
      requests.push('pay');
      const { network, token, poolsContract, minGas, maxGas } = OFFER_CONTEXT;
      const checked = checkPaymentHeader(header, { network, token, poolsContract, poolId, maxSeats: seats, seatPrice, minGas, maxGas });
      if (!checked.ok) throw new Error(`the stub gateway refuses the payment: ${checked.code}`);
      const { senderId, publicKey } = checked.payment;
      held.set(senderId, checked.payment.seats);
      signedWith.set(senderId, publicKey);
      const { target, deadline_ms: deadlineMs } = pool;
      return { kind: 'pending', txHash: TX, poolId, buyer: senderId, seats: checked.payment.seats, taken: 0, target, deadlineMs };
    },
    async redeem(poolId, header): Promise<RedeemAnswer> {
      requests.push('redeem');
      const { accountId } = decodeHeader(header) as RedeemProof;
      const seats = held.get(accountId) ?? 0;
      if (seats === 0) return { kind: 'no_seats' };
      if (pool.status === 'settled') return { kind: 'filled', credential: CREDENTIAL, poolId, seats, terms: pool.terms };
      const bonusShare = BigInt(seats) * 30n;
      return { kind: 'refund', status: 'refunded', amount: BigInt(seats) * seatPrice + bonusShare, bonusShare, txHash: TX };
    },
  };
  return { gateway, held, signedWith, requests };
}

/** Pool `id` of a scenario, in the status its redemption answers end with. */
function poolOf(chosen: Scenario, id = 0): PoolView {
  return poolView({
    id,
    seat_price: chosen.seatPrice.toString(),
    bonus: chosen.bonus.toString(),
    deadline_ms: NOW_MS + chosen.deadlineSeconds * 1000,
    status: chosen.expectedEnd,
  });
}

/** Chain reads that give every key the same next nonce, which the stub gateway does not check. */
const CHAIN: BuyerChainReads = { nextNonce: async () => 1_001n, finalHeight: async () => 5_000n };

/** Pool reads that hold `pool` only, and record the ids asked for. */
function chainPools(pool: PoolView): PoolReads & { asked: number[] } {
  const asked: number[] = [];
  return {
    asked,
    getPool: async (poolId) => {
      asked.push(poolId);
      return poolId === pool.id ? pool : null;
    },
  };
}

/** What runSwarm runs on: `pool` on chain, the stub `gateway`, CHAIN and `runtime`. */
function runDeps(pool: PoolView, gateway: RunDeps['gateway'], runtime: AgentRuntime, log: (line: string) => void = () => {}) {
  return { gateway, chain: CHAIN, pools: chainPools(pool), runtime, log } satisfies RunDeps;
}

/** A runtime at NOW_MS whose sleeps return at once and are recorded, and whose random() is 0.5. */
function instantRuntime(): { runtime: AgentRuntime; sleeps: number[] } {
  const sleeps: number[] = [];
  return { runtime: { now: () => NOW_MS, sleep: async (ms) => void sleeps.push(ms), random: () => 0.5 }, sleeps };
}

describe('runSwarm', () => {
  it('runs every scripted buyer, each paying with the key in its own key file, and returns their outcomes in order', async () => {
    const keys = await writeKeys();
    const pool = poolOf(FILLS);
    const { gateway, signedWith } = stubGateway(pool);
    const { runtime } = instantRuntime();
    const outcomes = await runSwarm(testConfig({ credentialsDir }), runDeps(pool, gateway, runtime), 0, FILLS);
    expect(outcomes.map((outcome) => outcome.buyer)).toEqual(PROFILES.map((profile) => profileAccount(profile, PARENT)));
    expect(outcomes.map((outcome) => outcome.kind)).toEqual([...Array(14).fill('credential'), ...Array(6).fill('declined')]);
    expect(signedWith.size).toBe(14);
    for (const [account, publicKey] of signedWith) expect(publicKey).toBe(keys.get(account));
  });

  it('runs the 20 buyers at once', async () => {
    await writeKeys();
    const pool = poolOf(FILLS);
    const { gateway } = stubGateway(pool, barrier(20));
    const { runtime } = instantRuntime();
    const outcomes = await runSwarm(testConfig({ credentialsDir }), runDeps(pool, gateway, runtime), 0, FILLS);
    expect(outcomes.filter((outcome) => outcome.kind === 'failed')).toEqual([]);
  });

  it('spreads the arrivals over the scenario’s spread, and polls at the configured interval', async () => {
    await writeKeys();
    const pool = poolOf(FAILS);
    const { gateway } = stubGateway(pool);
    const { runtime, sleeps } = instantRuntime();
    const config = testConfig({ credentialsDir, redeemIntervalMs: 2_000 });
    await runSwarm(config, runDeps(pool, gateway, runtime), 0, scenario('fails', { deadlineSeconds: null, spreadSeconds: 7 }));
    // Every buyer arrives after 0.5 × 7 s; the six that commit poll once, after 2 s plus 0.5 × 200 ms.
    expect(sleeps.toSorted((a, b) => a - b)).toEqual([...Array(6).fill(2_100), ...Array(20).fill(3_500)]);
  });

  it('logs the run, then a summary table of the outcomes', async () => {
    await writeKeys();
    const pool = poolOf(FAILS, 4);
    const { gateway } = stubGateway(pool);
    const { runtime } = instantRuntime();
    const lines: string[] = [];
    await runSwarm(testConfig({ credentialsDir }), runDeps(pool, gateway, runtime, (line) => lines.push(line)), 4, FAILS);
    expect(lines[0]).toBe('pool 4 (fails): 20 buyers arrive over 60 s');
    expect(lines).toContain('buyer-01  arrives after 30.0 s: seat price 320, top price 400: wants 24 seats');
    expect(lines.slice(-22)).toEqual([
      'buyer     outcome   seats  paid  detail',
      'buyer-01  refunded     24  7680  8400 back, bonus 720',
      'buyer-02  refunded     20  6400  7000 back, bonus 600',
      'buyer-03  refunded     18  5760  6300 back, bonus 540',
      'buyer-04  refunded     16  5120  5600 back, bonus 480',
      'buyer-05  refunded     12  3840  4200 back, bonus 360',
      'buyer-06  refunded     10  3200  3500 back, bonus 300',
      'buyer-07  declined      0     0  seat price 320 above top price 250',
      'buyer-08  declined      0     0  seat price 320 above top price 250',
      'buyer-09  declined      0     0  seat price 320 above top price 250',
      'buyer-10  declined      0     0  seat price 320 above top price 250',
      'buyer-11  declined      0     0  seat price 320 above top price 250',
      'buyer-12  declined      0     0  seat price 320 above top price 250',
      'buyer-13  declined      0     0  seat price 320 above top price 250',
      'buyer-14  declined      0     0  seat price 320 above top price 250',
      'buyer-15  declined      0     0  seat price 320 above top price 150',
      'buyer-16  declined      0     0  seat price 320 above top price 150',
      'buyer-17  declined      0     0  seat price 320 above top price 150',
      'buyer-18  declined      0     0  seat price 320 above top price 150',
      'buyer-19  declined      0     0  seat price 320 above top price 150',
      'buyer-20  declined      0     0  seat price 320 above top price 150',
      '100 seats, 32000 paid: refunded 6, declined 14',
    ]);
  });

  it('stops before any buyer acts when a buyer’s key file is missing', async () => {
    const missing = `buyer-07.${PARENT}`;
    await writeKeys([missing]);
    const pool = poolOf(FILLS);
    const { gateway, requests } = stubGateway(pool);
    const { runtime } = instantRuntime();
    const run = runSwarm(testConfig({ credentialsDir }), runDeps(pool, gateway, runtime), 0, FILLS);
    await expect(run).rejects.toBeInstanceOf(KeyFileError);
    await expect(run).rejects.toMatchObject({ path: keyFilePath(credentialsDir, 'near:testnet', missing), problem: 'missing' });
    expect(requests).toEqual([]);
  });

  it('reads the pool once from the chain, and stops before any buyer acts when the pools contract has no such pool', async () => {
    await writeKeys();
    const pool = poolOf(FILLS);
    const { gateway, requests } = stubGateway(pool);
    const { runtime } = instantRuntime();
    const deps = runDeps(pool, gateway, runtime);
    const run = runSwarm(testConfig({ credentialsDir }), deps, 9, FILLS);
    await expect(run).rejects.toBeInstanceOf(UnknownPoolError);
    await expect(run).rejects.toThrow('the pools contract has no pool 9');
    expect(requests).toEqual([]);
    expect(deps.pools.asked).toEqual([9]);
  });

  it('stops before any buyer acts when the pool’s seat price on chain is not the scenario’s, naming both', async () => {
    await writeKeys();
    const pool = poolOf(FAILS);
    const { gateway, requests } = stubGateway(pool);
    const { runtime } = instantRuntime();
    const lines: string[] = [];
    const run = runSwarm(testConfig({ credentialsDir }), runDeps(pool, gateway, runtime, (line) => lines.push(line)), 0, FILLS);
    await expect(run).rejects.toBeInstanceOf(SeatPriceMismatchError);
    await expect(run).rejects.toMatchObject({ poolId: 0, seatPrice: 320n, scenario: 'fills', scenarioSeatPrice: 180n });
    await expect(run).rejects.toThrow("pool 0's seat price on chain is 320, not the fills scenario's 180");
    expect(requests).toEqual([]);
    expect(lines).toEqual([]);
  });

  it('resumes a buyer that already holds seats: it never pays again, and the summary shows the seats it holds', async () => {
    await writeKeys();
    const pool = poolOf(FILLS);
    const { gateway, held, signedWith } = stubGateway(pool);
    const resumed = `buyer-02.${PARENT}`;
    held.set(resumed, 20);
    const { runtime } = instantRuntime();
    const lines: string[] = [];
    const outcomes = await runSwarm(testConfig({ credentialsDir }), runDeps(pool, gateway, runtime, (line) => lines.push(line)), 0, FILLS);
    expect(outcomes[1]).toEqual({ buyer: resumed, kind: 'credential', seats: 20, paid: 3_600n, detail: 'pool filled', txHashes: [] });
    expect(signedWith.has(resumed)).toBe(false);
    expect(signedWith.size).toBe(13);
    expect(lines).toContain('buyer-02  holds 20 seats already: follows its redemption');
    expect(lines).toContain('buyer-02  credential     20  3600  pool filled');
  });
});

/** An outcome of the profile `index` (0 for buyer-01) as `kind`, holding `seats` seats. */
function outcomeOf(index: number, kind: BuyerOutcomeKind, seats = 0): BuyerOutcome {
  const profile = PROFILES[index];
  if (profile === undefined) throw new RangeError(`no profile ${index}`);
  return { buyer: profileAccount(profile, PARENT), kind, seats, paid: 0n, detail: `ended ${kind}`, txHashes: [] };
}

/** The outcomes of a run that went as `chosen` expects: each accepting buyer ends `accepting`, the others `declined`. */
function expectedRun(chosen: Scenario, accepting: BuyerOutcomeKind): BuyerOutcome[] {
  return PROFILES.map((profile, i) => (profile.topPrice >= chosen.seatPrice ? outcomeOf(i, accepting, profile.seats) : outcomeOf(i, 'declined')));
}

describe('unexpectedOutcomes', () => {
  it('finds none in a fills run whose accepting buyers hold credentials or missed, and whose others declined', () => {
    const outcomes = expectedRun(FILLS, 'credential');
    outcomes[13] = outcomeOf(13, 'missed');
    expect(unexpectedOutcomes(FILLS, outcomes)).toEqual([]);
  });

  it('finds none in a fails run whose accepting buyers were refunded', () => {
    expect(unexpectedOutcomes(FAILS, expectedRun(FAILS, 'refunded'))).toEqual([]);
  });

  it.each<['fills' | 'fails', BuyerOutcomeKind, string]>([
    ['fills', 'failed', 'credential or missed'],
    ['fills', 'refused', 'credential or missed'],
    ['fills', 'timed_out', 'credential or missed'],
    ['fills', 'expired', 'credential or missed'],
    ['fills', 'declined', 'credential or missed'],
    ['fails', 'claimable', 'refunded'],
    ['fails', 'missed', 'refunded'],
    ['fails', 'declined', 'refunded'],
  ])('in %s, finds an accepting buyer that ended %s, and says what was expected', (name, kind, expected) => {
    const chosen = name === 'fills' ? FILLS : FAILS;
    const outcomes = expectedRun(chosen, name === 'fills' ? 'credential' : 'refunded');
    outcomes[2] = outcomeOf(2, kind);
    expect(unexpectedOutcomes(chosen, outcomes)).toEqual([{ name: 'buyer-03', outcome: outcomes[2], expected }]);
  });

  it('accepts any end for a buyer whose top price is below the seat price, as long as it holds no seats', () => {
    const outcomes = expectedRun(FILLS, 'credential');
    outcomes[16] = outcomeOf(16, 'missed');
    outcomes[17] = outcomeOf(17, 'failed');
    expect(unexpectedOutcomes(FILLS, outcomes)).toEqual([]);
  });

  it('finds a buyer whose top price is below the seat price that holds seats', () => {
    const outcomes = expectedRun(FAILS, 'refunded');
    outcomes[6] = outcomeOf(6, 'refunded', 18);
    expect(unexpectedOutcomes(FAILS, outcomes)).toEqual([
      { name: 'buyer-07', outcome: outcomes[6], expected: 'no seats, its top price 250 being below the seat price 320' },
    ]);
  });

  it('checks each outcome against the profile at its index, as runSwarm returns them', () => {
    const outcomes = expectedRun(FAILS, 'refunded').slice(0, 7);
    outcomes[0] = outcomeOf(0, 'failed');
    expect(unexpectedOutcomes(FAILS, outcomes).map((u) => u.name)).toEqual(['buyer-01']);
    expect(unexpectedOutcomes(FAILS, [])).toEqual([]);
  });
});

/**
 * A meeting point for `count` callers: each call waits until `count` calls are waiting, then all go
 * on. If they have not all arrived within a second of real time, every waiting call rejects, so that
 * callers run one after another fail instead of waiting forever.
 */
function barrier(count: number): () => Promise<void> {
  let arrived = 0;
  let release: () => void = () => {};
  let fail: (error: Error) => void = () => {};
  const met = new Promise<void>((resolve, reject) => {
    release = resolve;
    fail = reject;
  });
  met.catch(() => {});
  const timer = setTimeout(() => fail(new Error(`only ${arrived} of ${count} callers arrived together`)), 1_000);
  return () => {
    arrived += 1;
    if (arrived === count) {
      clearTimeout(timer);
      release();
    }
    return met;
  };
}
