import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keyFilePath, KeyFileError, writeKeyFile } from '@quorum-on-near/buyer';
import type { QuorumEvent } from '@quorum-on-near/protocol';
import { KeyPair } from 'near-api-js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NonceTakenError, OutcomeUnknownError, TransactionFailedError } from '../src/chain.ts';
import type { SwarmConfig } from '../src/config.ts';
import { assertNoPoolOpen, openPool, OpenPoolError, PoolAlreadyOpenError, type OpenPoolDeps } from '../src/provider.ts';
import { scenario } from '../src/scenarios.ts';
import { eventLog, FakeChain, NEAR, NOW_MS, POOLS, poolView, PROVIDER, testConfig, TOKEN, type FakeTransferCall } from './fake-chain.ts';

const TERMS = '8×GPU × 24 h; 1 seat = 1 GPU-hour; prices at 1/10,000 scale';
const DEFAULTS = { deadlineSeconds: null, spreadSeconds: null };
const FILLS = scenario('fills', DEFAULTS);
const FAILS = scenario('fails', DEFAULTS);
const TX_HASH = '8bB1Ttk9c3kXe2RsE3oqgJ1ZBTVxfXJWQWfWcnPrw8bh';

let credentialsDir: string;

beforeEach(async () => {
  credentialsDir = await mkdtemp(join(tmpdir(), 'quorum-provider-'));
});

afterEach(async () => {
  await rm(credentialsDir, { recursive: true, force: true });
});

interface Setup {
  chain: FakeChain;
  keyPair: KeyPair;
  config: SwarmConfig;
  deps: OpenPoolDeps;
  /** The lines openPool logged. */
  lines: string[];
}

/**
 * A fake chain with the pools contract deployed and registered, and the provider holding 1 NEAR and
 * 10,000 base units, with its key in a key file under the test's credentials folder.
 */
async function setup(): Promise<Setup> {
  const keyPair = KeyPair.fromRandom('ed25519');
  await writeKeyFile(keyFilePath(credentialsDir, 'near:testnet', PROVIDER), PROVIDER, keyPair);
  const chain = new FakeChain();
  chain.addAccount(PROVIDER, { balance: NEAR, publicKeys: [keyPair.getPublicKey()] });
  chain.addAccount(POOLS, { balance: 3n * NEAR, hasCode: true });
  chain.register(PROVIDER, 10_000n);
  chain.register(POOLS);
  const lines: string[] = [];
  return { chain, keyPair, config: testConfig({ credentialsDir }), deps: { chain, log: (line) => lines.push(line) }, lines };
}

/** A `pool_opened` event for pool `poolId` of FILLS, as the pools contract logs it. */
function opened(poolId: unknown): QuorumEvent {
  const data = { pool_id: poolId, seller: PROVIDER, seat_price: '180', target: 192, deadline_ms: NOW_MS + 600_000, bonus: '1728', terms: TERMS };
  return { event: 'pool_opened', data } as QuorumEvent;
}

/**
 * An `onTransferCall` script: transaction TX_HASH, in which the token kept `used`, and whose pools
 * contract receipt logs `logs` (or the token's receipt, when `loggedBy` is the token).
 */
function transferResult(used: bigint, logs: string[], loggedBy = POOLS) {
  return (call: FakeTransferCall) => ({
    outcome: {
      txHash: TX_HASH,
      receipts: [
        { executorId: call.signer, logs: [], failed: false, gasBurnt: 0n },
        { executorId: TOKEN, logs: loggedBy === TOKEN ? logs : [], failed: false, gasBurnt: 0n },
        { executorId: POOLS, logs: loggedBy === POOLS ? logs : [], failed: false, gasBurnt: 0n },
        { executorId: TOKEN, logs: [], failed: false, gasBurnt: 0n },
      ],
    },
    used,
  });
}

describe('openPool', () => {
  it('sends the bonus to the pools contract with the open message, signed with the key in the provider’s key file', async () => {
    const { chain, keyPair, config, deps } = await setup();
    await openPool(config, deps, FILLS);
    expect(chain.writes).toEqual([
      {
        kind: 'ftTransferCall',
        signer: PROVIDER,
        publicKey: keyPair.getPublicKey().toString(),
        txHash: expect.any(String),
        receiverId: POOLS,
        amount: 1_728n,
        msg: `{"open":{"seat_price":"180","target":192,"deadline_ms":${NOW_MS + 600_000},"max_seats_per_buyer":24,"terms":"${TERMS}"}}`,
      },
    ]);
  });

  it('returns the id of the pool the contract opened, the transaction and the deadline', async () => {
    const { chain, config, deps } = await setup();
    for (const id of [0, 1, 2]) chain.setPool(poolView({ id, status: 'settled' }));
    const pool = await openPool(config, deps, FILLS);
    expect(pool).toEqual({ poolId: 3, txHash: chain.writes[0]?.txHash, deadlineMs: NOW_MS + 600_000 });
    expect(chain.pools.get(3)).toMatchObject({ seller: PROVIDER, seat_price: '180', target: 192, bonus: '1728' });
    expect(chain.tokenBalances.get(PROVIDER)).toBe(10_000n - 1_728n);
  });

  it('dates the deadline from the final block’s time, never the local clock', async () => {
    const { chain, config, deps } = await setup();
    chain.block = { height: 5n, timestampMs: 1_700_000_000_000 };
    const pool = await openPool(config, deps, FAILS);
    expect(pool.deadlineMs).toBe(1_700_000_180_000);
    expect(chain.writes[0]).toMatchObject({ msg: expect.stringContaining('"deadline_ms":1700000180000,') });
  });

  it('opens fails at its own price and bonus', async () => {
    const { chain, config, deps } = await setup();
    await openPool(config, deps, FAILS);
    expect(chain.writes[0]).toMatchObject({
      amount: 3_072n,
      msg: `{"open":{"seat_price":"320","target":192,"deadline_ms":${NOW_MS + 180_000},"max_seats_per_buyer":24,"terms":"${TERMS}"}}`,
    });
  });

  it('gives the pool the scenario’s deadline, the configured one when it is set', async () => {
    const { config, deps } = await setup();
    const pool = await openPool(config, deps, scenario('fills', { deadlineSeconds: 30, spreadSeconds: null }));
    expect(pool.deadlineMs).toBe(NOW_MS + 30_000);
  });

  it('logs the pool it opened, with its transaction', async () => {
    const { chain, config, deps, lines } = await setup();
    await openPool(config, deps, FILLS);
    expect(lines).toEqual([
      `opened pool 0 (fills): 192 seats at 180, bonus 1728, deadline 2027-01-15T07:53:20.000Z  tx ${chain.writes[0]?.txHash}`,
    ]);
  });

  it('fails clearly when the contract opened no pool and the token returned the bonus', async () => {
    const { chain, config, deps, lines } = await setup();
    chain.addAccount(POOLS, { balance: 3n * NEAR });
    const failure = openPool(config, deps, FILLS);
    await expect(failure).rejects.toThrow(OpenPoolError);
    await expect(failure).rejects.toThrow(
      `transaction ${chain.writes[0]?.txHash} opened no pool: the pools contract logged no pool_opened event, and the token kept 0 of the 1728 bonus`,
    );
    await expect(failure).rejects.toMatchObject({ txHash: chain.writes[0]?.txHash });
    expect(chain.tokenBalances.get(PROVIDER)).toBe(10_000n);
    expect(lines).toEqual([]);
  });

  it('reads the pool_opened event only from the pools contract’s receipts', async () => {
    const { chain, config, deps } = await setup();
    chain.onTransferCall = transferResult(1_728n, [eventLog(opened(4))], TOKEN);
    await expect(openPool(config, deps, FILLS)).rejects.toThrow(`transaction ${TX_HASH} opened no pool`);
  });

  it('fails clearly when the token kept less than the bonus', async () => {
    const { chain, config, deps } = await setup();
    chain.onTransferCall = transferResult(1_000n, [eventLog(opened(4))]);
    await expect(openPool(config, deps, FILLS)).rejects.toThrow(
      `transaction ${TX_HASH} opened pool 4, but the token kept 1000 of the 1728 bonus`,
    );
  });

  it.each([[-1], ['4'], [1.5], [null]])('refuses a pool_opened event whose pool id is %j', async (poolId) => {
    const { chain, config, deps } = await setup();
    chain.onTransferCall = transferResult(1_728n, [eventLog(opened(poolId))]);
    await expect(openPool(config, deps, FILLS)).rejects.toThrow(
      `transaction ${TX_HASH} logged a pool_opened event without a valid pool id`,
    );
  });

  it('sends nothing without the provider’s key file', async () => {
    const { chain, deps } = await setup();
    const config = testConfig({ credentialsDir: join(credentialsDir, 'empty') });
    await expect(openPool(config, deps, FILLS)).rejects.toBeInstanceOf(KeyFileError);
    expect(chain.writes).toEqual([]);
  });

  it('says that an earlier swarm open may have opened a pool when the key’s nonce was taken, naming the transaction', async () => {
    const { chain, config, deps } = await setup();
    chain.onTransferCall = () => {
      throw new NonceTakenError(`transaction ${TX_HASH} was refused`, TX_HASH);
    };
    const rejected = await openPool(config, deps, FILLS).catch((e: unknown) => e);
    expect(rejected).toBeInstanceOf(NonceTakenError);
    expect(rejected).toMatchObject({ txHash: TX_HASH });
    expect((rejected as Error).message).toBe(
      `the provider's key signed another transaction after its nonce was read (transaction ${TX_HASH} was refused): an earlier ` +
        "`swarm open` may have opened a pool. Wait until it is final, then run `swarm open` again; it lists the provider's open pools.",
    );
  });

  it('says that a pool may have opened when the bonus transfer got no result, naming the transaction', async () => {
    const { chain, config, deps } = await setup();
    chain.onTransferCall = () => {
      throw new OutcomeUnknownError(`transaction ${TX_HASH} got no result`, TX_HASH, 'timeout');
    };
    const rejected = await openPool(config, deps, FILLS).catch((e: unknown) => e);
    expect(rejected).toBeInstanceOf(OutcomeUnknownError);
    expect(rejected).toMatchObject({ txHash: TX_HASH, reason: 'timeout' });
    expect((rejected as Error).message).toBe(
      `the bonus transfer ${TX_HASH} was sent, but the RPC gave no result (timeout): a pool may have opened. Wait until it ` +
        "is final, then run `swarm open` again; it lists the provider's open pools.",
    );
  });

  it('passes on the chain’s error when the transfer itself fails', async () => {
    const { chain, config, deps } = await setup();
    chain.register(PROVIDER, 1_000n);
    await expect(openPool(config, deps, FILLS)).rejects.toBeInstanceOf(TransactionFailedError);
  });
});

describe('openPool with a pool of the provider still open', () => {
  it('refuses to open another, naming the open pool, and sends nothing', async () => {
    const { chain, config, deps, lines } = await setup();
    chain.setPool(poolView({ id: 3, status: 'settled' }));
    chain.setPool(poolView({ id: 4 }));
    const failure = openPool(config, deps, FILLS);
    await expect(failure).rejects.toThrow(PoolAlreadyOpenError);
    await expect(failure).rejects.toThrow(`the provider ${PROVIDER} has pool 4 open`);
    await expect(failure).rejects.toMatchObject({ poolIds: [4] });
    expect(chain.writes).toEqual([]);
    expect(lines).toEqual([]);
  });

  it('names every open pool of the provider', async () => {
    const { chain, config, deps } = await setup();
    for (const id of [2, 5]) chain.setPool(poolView({ id }));
    await expect(openPool(config, deps, FAILS)).rejects.toMatchObject({
      poolIds: [2, 5],
      message: expect.stringContaining(`the provider ${PROVIDER} has pools 2, 5 open`),
    });
  });

  it('names the command that resumes the open pool’s buyers', () => {
    expect(new PoolAlreadyOpenError(PROVIDER, [4]).message).toMatch(/nothing was sent; `swarm run 4 <fills\|fails>` resumes its buyers$/);
    expect(new PoolAlreadyOpenError(PROVIDER, [2, 5]).message).toMatch(/`swarm run <pool-id> <fills\|fails>` resumes a pool's buyers$/);
  });

  it('reads the pools at optimistic finality, so that a pool opened moments ago counts', async () => {
    const { chain, config, deps } = await setup();
    await openPool(config, deps, FILLS);
    const listed = chain.reads.filter((read) => read.method === 'listPools');
    expect(listed.map((read) => read.atHeight)).toEqual(['optimistic']);
  });

  it('finds an open pool past the first page of pools', async () => {
    const { chain, config, deps } = await setup();
    for (let id = 0; id < 150; id += 1) chain.setPool(poolView({ id, status: id === 120 ? 'open' : 'refunded' }));
    await expect(openPool(config, deps, FILLS)).rejects.toMatchObject({ poolIds: [120] });
    expect(chain.writes).toEqual([]);
  });

  it('refuses before reading the provider’s key file', async () => {
    const { chain, deps } = await setup();
    chain.setPool(poolView({ id: 4 }));
    const config = testConfig({ credentialsDir: join(credentialsDir, 'empty') });
    await expect(openPool(config, deps, FILLS)).rejects.toBeInstanceOf(PoolAlreadyOpenError);
  });

  it.each(['filled', 'settled', 'expired', 'refunded'] as const)('opens a pool when the provider’s other pool is %s', async (status) => {
    const { chain, config, deps } = await setup();
    chain.setPool(poolView({ id: 0, status }));
    expect(await openPool(config, deps, FILLS)).toMatchObject({ poolId: 1 });
  });

  it('opens a pool while another seller’s pool is open', async () => {
    const { chain, config, deps } = await setup();
    chain.setPool(poolView({ id: 0, seller: 'provider.other.testnet' }));
    expect(await openPool(config, deps, FILLS)).toMatchObject({ poolId: 1 });
  });
});

describe('assertNoPoolOpen', () => {
  it('throws PoolAlreadyOpenError, naming the pool, when the provider has a pool open', async () => {
    const { chain, config } = await setup();
    chain.setPool(poolView({ id: 0, status: 'settled' }));
    chain.setPool(poolView({ id: 1 }));
    await expect(assertNoPoolOpen(config, chain)).rejects.toMatchObject({ name: 'PoolAlreadyOpenError', poolIds: [1] });
    expect(chain.writes).toEqual([]);
  });

  it('passes when none of the provider’s pools is open', async () => {
    const { chain, config } = await setup();
    chain.setPool(poolView({ id: 0, status: 'refunded' }));
    chain.setPool(poolView({ id: 1, seller: 'provider.other.testnet' }));
    await expect(assertNoPoolOpen(config, chain)).resolves.toBeUndefined();
  });

  it.each([
    ['does not exist', (chain: FakeChain) => chain.accounts.delete(POOLS)],
    ['holds no contract', (chain: FakeChain) => chain.addAccount(POOLS)],
  ])('passes without reading the pools when the pools account %s yet', async (_, prepare) => {
    const { chain, config } = await setup();
    prepare(chain);
    await expect(assertNoPoolOpen(config, chain)).resolves.toBeUndefined();
    expect(chain.reads).toEqual([]);
  });
});
