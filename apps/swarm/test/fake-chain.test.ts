import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseEventLog, poolsEvents, type PoolView, type TxOutcome } from '@quorum-on-near/protocol';
import { KeyPair } from 'near-api-js';
import { describe, expect, it } from 'vitest';
import { TransactionFailedError, type AccountKey } from '../src/chain.ts';
import {
  FakeChain,
  NEAR,
  NOW_MS,
  PARENT,
  POOLS,
  poolView,
  PROVIDER,
  REGISTRATION_DEPOSIT,
  testConfig,
  TOKEN,
} from './fake-chain.ts';

const BUYER = `buyer-01.${PARENT}`;
const FUNDING = `funding.${PARENT}`;
const TERMS = '8×GPU × 24 h; 1 seat = 1 GPU-hour; prices at 1/10,000 scale';

/** A fake with the parent holding 10 NEAR and a key, and that key. */
function setup(): { chain: FakeChain; parent: AccountKey } {
  const chain = new FakeChain();
  const parent = chain.addSigner(PARENT, 10n * NEAR);
  return { chain, parent };
}

/** The `open` message of a pool, as the provider sends it. */
function openMsg(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    open: { seat_price: '180', target: 192, deadline_ms: NOW_MS + 600_000, max_seats_per_buyer: 24, terms: TERMS, ...overrides },
  });
}

/** A fake whose provider is registered with `tokens` and whose pools contract is deployed and registered. */
function withPools(tokens = 10_000n): { chain: FakeChain; provider: AccountKey } {
  const chain = new FakeChain();
  const provider = chain.addSigner(PROVIDER, NEAR);
  chain.addAccount(POOLS, { balance: 3n * NEAR, hasCode: true });
  chain.register(PROVIDER, tokens);
  chain.register(POOLS);
  return { chain, provider };
}

describe('testConfig', () => {
  it('names the fake chain’s accounts', () => {
    const config = testConfig();
    expect([config.parent, config.poolsContract, config.token, config.provider]).toEqual([PARENT, POOLS, TOKEN, PROVIDER]);
  });

  it('points its key and spend files where nothing can be read or written', async () => {
    const { credentialsDir, spendFile } = testConfig();
    for (const path of [credentialsDir, join(spendFile, '..')]) {
      await expect(mkdir(path, { recursive: true })).rejects.toMatchObject({ code: expect.stringMatching(/^(ENOTDIR|EEXIST)$/) });
    }
  });

  it('takes overrides', () => {
    expect(testConfig({ buyerBudget: 5n }).buyerBudget).toBe(5n);
  });
});

describe('FakeChain reads', () => {
  it('reports the chain id it is given', async () => {
    const chain = new FakeChain();
    expect(await chain.chainId()).toBe('testnet');
    chain.nodeChainId = 'sandbox-1';
    expect(await chain.chainId()).toBe('sandbox-1');
  });

  it('gives an account’s balance, code flag and storage, and null for a missing one', async () => {
    const chain = new FakeChain();
    chain.addAccount(POOLS, { balance: 7n, hasCode: true, storageUsage: 204_022n });
    chain.addAccount(BUYER);
    expect(await chain.account(POOLS)).toEqual({ balance: 7n, hasCode: true, storageUsage: 204_022n });
    expect(await chain.account(BUYER)).toEqual({ balance: 0n, hasCode: false, storageUsage: 0n });
    expect(await chain.account('missing.testnet')).toBeNull();
  });

  it('gives the token of a deployed pools contract, and fails without a contract', async () => {
    const chain = new FakeChain();
    await expect(chain.getToken()).rejects.toThrow(`${POOLS} holds no contract`);
    chain.addAccount(POOLS, { hasCode: true });
    expect(await chain.getToken()).toBe(TOKEN);
    chain.poolsToken = 'other.testnet';
    expect(await chain.getToken()).toBe('other.testnet');
  });

  it('reads registrations and token balances', async () => {
    const chain = new FakeChain();
    chain.register(BUYER, 42n);
    expect(await chain.registrationDeposit()).toBe(REGISTRATION_DEPOSIT);
    expect([await chain.isRegistered(BUYER), await chain.ftBalanceOf(BUYER)]).toEqual([true, 42n]);
    expect([await chain.isRegistered(FUNDING), await chain.ftBalanceOf(FUNDING)]).toEqual([false, 0n]);
  });

  it('pages pools and seats as the contract does, at most 100 per call', async () => {
    const chain = new FakeChain();
    for (let id = 0; id < 105; id += 1) chain.setPool(poolView({ id }));
    const seats = Array.from({ length: 103 }, (_, i) => ({ buyer: `b${i}.testnet`, seats: 1, state: 'committed' as const }));
    chain.seats.set(3, seats);
    expect((await chain.listPools(0, 1000)).map((pool) => pool.id)).toEqual([...Array(100).keys()]);
    expect((await chain.listPools(101, 100)).map((pool) => pool.id)).toEqual([101, 102, 103, 104]);
    expect(await chain.getSeats(3, 100, 100)).toEqual(seats.slice(100));
    expect(await chain.getSeats(3, 0, 2)).toEqual(seats.slice(0, 2));
    expect(await chain.getSeats(9, 0, 100)).toEqual([]);
  });

  it('gives a pool as stored, and null for an unknown one', async () => {
    const chain = new FakeChain();
    chain.setPool(poolView({ id: 4, status: 'settled' }));
    expect(await chain.getPool(4)).toEqual(poolView({ id: 4, status: 'settled' }));
    expect(await chain.getPool(5)).toBeNull();
  });

  it('records each view and token balance read, with the block height it asked for', async () => {
    const chain = new FakeChain();
    await chain.ftBalanceOf(PROVIDER);
    await chain.ftBalanceOf(POOLS, 7n);
    await chain.getPool(3);
    await chain.listPools(0, 100, 8n);
    await chain.getSeats(3, 0, 100);
    expect(chain.reads).toEqual([
      { method: 'ftBalanceOf', args: [PROVIDER], atHeight: null },
      { method: 'ftBalanceOf', args: [POOLS], atHeight: 7n },
      { method: 'getPool', args: [3], atHeight: null },
      { method: 'listPools', args: [0, 100], atHeight: 8n },
      { method: 'getSeats', args: [3, 0, 100], atHeight: null },
    ]);
  });

  it('gives the final block it is given', async () => {
    const chain = new FakeChain();
    expect(await chain.finalBlock()).toEqual({ height: 1_000n, timestampMs: NOW_MS });
    chain.block = { height: 5n, timestampMs: 9 };
    expect(await chain.finalBlock()).toEqual({ height: 5n, timestampMs: 9 });
  });

  it("looks an outcome up by hash and signer, and gives 'unknown' for any other pair, or 'not_final' for one marked so", async () => {
    const chain = new FakeChain();
    const outcome: TxOutcome = { txHash: 'Hash1', receipts: [{ executorId: 'relay.testnet', logs: [], failed: false, gasBurnt: 1n }] };
    chain.addOutcome('relay.testnet', outcome);
    expect(await chain.txOutcome('Hash1', 'relay.testnet')).toEqual(outcome);
    expect(await chain.txOutcome('Hash1', 'other.testnet')).toBe('unknown');
    expect(await chain.txOutcome('Hash2', 'relay.testnet')).toBe('unknown');
    chain.markNotFinal('relay.testnet', 'Hash2');
    expect(await chain.txOutcome('Hash2', 'relay.testnet')).toBe('not_final');
  });
});

describe('FakeChain writes', () => {
  it('creates a sub-account with its balance and keys, paid by the signer', async () => {
    const { chain, parent } = setup();
    const key = KeyPair.fromRandom('ed25519').getPublicKey();
    const outcome = await chain.createAccount(parent, { accountId: BUYER, balance: NEAR / 20n, publicKeys: [key] });
    expect(await chain.account(BUYER)).toEqual({ balance: NEAR / 20n, hasCode: false, storageUsage: 0n });
    expect([...(chain.accounts.get(BUYER)?.keys ?? [])]).toEqual([key.toString()]);
    expect((await chain.account(PARENT))?.balance).toBe(10n * NEAR - NEAR / 20n);
    expect(chain.writes).toEqual([
      {
        kind: 'createAccount',
        signer: PARENT,
        publicKey: parent.keyPair.getPublicKey().toString(),
        txHash: outcome.txHash,
        accountId: BUYER,
        balance: NEAR / 20n,
        publicKeys: [key.toString()],
      },
    ]);
  });

  it('records each write’s outcome, so that txOutcome finds it by hash and signer', async () => {
    const { chain, parent } = setup();
    chain.addAccount(BUYER);
    const outcome = await chain.transferNear(parent, BUYER, 5n);
    expect(outcome.txHash).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    expect(outcome.receipts.map((receipt) => [receipt.executorId, receipt.failed])).toEqual([
      [PARENT, false],
      [BUYER, false],
    ]);
    expect(await chain.txOutcome(outcome.txHash, PARENT)).toEqual(outcome);
    const second = await chain.transferNear(parent, BUYER, 5n);
    expect(second.txHash).not.toBe(outcome.txHash);
  });

  it('fails a creation of an account that exists, changing nothing', async () => {
    const { chain, parent } = setup();
    chain.addAccount(BUYER, { balance: 1n });
    const created = chain.createAccount(parent, { accountId: BUYER, balance: NEAR, publicKeys: [] });
    await expect(created).rejects.toBeInstanceOf(TransactionFailedError);
    expect((await chain.account(BUYER))?.balance).toBe(1n);
    expect((await chain.account(PARENT))?.balance).toBe(10n * NEAR);
  });

  it.each(['buyer-01.other.testnet', `a.buyer-01.${PARENT}`, PARENT])(
    'fails a creation of %s, which is not a direct sub-account of the signer',
    async (accountId) => {
      const { chain, parent } = setup();
      await expect(chain.createAccount(parent, { accountId, balance: 0n, publicKeys: [] })).rejects.toBeInstanceOf(
        TransactionFailedError,
      );
    },
  );

  it('refuses a write signed with a key the account does not hold, or by an account that does not exist', async () => {
    const { chain } = setup();
    chain.addAccount(BUYER);
    const stranger = { accountId: PARENT, keyPair: KeyPair.fromRandom('ed25519') };
    await expect(chain.transferNear(stranger, BUYER, 1n)).rejects.toThrow(`${PARENT} has no access key`);
    const ghost = { accountId: 'ghost.testnet', keyPair: KeyPair.fromRandom('ed25519') };
    await expect(chain.transferNear(ghost, BUYER, 1n)).rejects.toThrow('ghost.testnet does not exist');
    expect(chain.writes).toHaveLength(2);
  });

  it('refuses a write the signer cannot pay for, NEAR fee included', async () => {
    const { chain, parent } = setup();
    chain.addAccount(BUYER);
    chain.txFee = 1n;
    await expect(chain.transferNear(parent, BUYER, 10n * NEAR)).rejects.toThrow(`${PARENT} cannot pay`);
    await chain.transferNear(parent, BUYER, 10n * NEAR - 1n);
    expect([(await chain.account(PARENT))?.balance, (await chain.account(BUYER))?.balance]).toEqual([0n, 10n * NEAR - 1n]);
  });

  it('fails a NEAR transfer to an account that does not exist', async () => {
    const { chain, parent } = setup();
    await expect(chain.transferNear(parent, BUYER, 1n)).rejects.toBeInstanceOf(TransactionFailedError);
    expect((await chain.account(PARENT))?.balance).toBe(10n * NEAR);
  });

  it('deploys the pools contract with the configured token, once', async () => {
    const chain = new FakeChain();
    chain.poolsToken = 'old.testnet';
    const pools = chain.addSigner(POOLS, 3n * NEAR);
    await chain.deployPools(pools, new Uint8Array([0, 97, 115, 109]));
    expect(await chain.account(POOLS)).toEqual({ balance: 3n * NEAR, hasCode: true, storageUsage: 4n });
    expect(await chain.getToken()).toBe(TOKEN);
    expect(chain.writes[0]).toMatchObject({ kind: 'deployPools', signer: POOLS, code: new Uint8Array([0, 97, 115, 109]) });
    await expect(chain.deployPools(pools, new Uint8Array([0]))).rejects.toBeInstanceOf(TransactionFailedError);
  });

  it('fails a deploy, changing nothing, when the account cannot then hold the storage its code locks', async () => {
    const chain = new FakeChain();
    // 200,000 bytes lock 2 NEAR at 10^19 yoctoNEAR a byte.
    const code = new Uint8Array(200_000);
    const pools = chain.addSigner(POOLS, 2n * NEAR - 1n);
    await expect(chain.deployPools(pools, code)).rejects.toBeInstanceOf(TransactionFailedError);
    expect(await chain.account(POOLS)).toEqual({ balance: 2n * NEAR - 1n, hasCode: false, storageUsage: 0n });
    chain.accounts.get(POOLS)!.balance = 2n * NEAR;
    await chain.deployPools(pools, code);
    expect(await chain.account(POOLS)).toEqual({ balance: 2n * NEAR, hasCode: true, storageUsage: 200_000n });
  });

  it('counts the storage an account uses already against what a deploy to it locks', async () => {
    const chain = new FakeChain();
    const pools = chain.addSigner(POOLS, 2n * NEAR);
    chain.accounts.get(POOLS)!.storageUsage = 1n;
    await expect(chain.deployPools(pools, new Uint8Array(200_000))).rejects.toBeInstanceOf(TransactionFailedError);
  });

  it('registers accounts on the token, charging the deposit only for those not registered yet', async () => {
    const { chain, parent } = setup();
    chain.addAccount(TOKEN);
    chain.register(FUNDING, 7n);
    await chain.storageDeposits(parent, [FUNDING, BUYER, POOLS], REGISTRATION_DEPOSIT);
    expect(await Promise.all([FUNDING, BUYER, POOLS].map((id) => chain.isRegistered(id)))).toEqual([true, true, true]);
    expect(await chain.ftBalanceOf(FUNDING)).toBe(7n);
    expect((await chain.account(PARENT))?.balance).toBe(10n * NEAR - 2n * REGISTRATION_DEPOSIT);
    expect((await chain.account(TOKEN))?.balance).toBe(2n * REGISTRATION_DEPOSIT);
  });

  it('fails a registration whose deposit is below the token’s minimum, registering none', async () => {
    const { chain, parent } = setup();
    await expect(chain.storageDeposits(parent, [FUNDING, BUYER], REGISTRATION_DEPOSIT - 1n)).rejects.toBeInstanceOf(
      TransactionFailedError,
    );
    expect(chain.registered.size).toBe(0);
  });

  it('moves tokens for each transfer of a batch, charging 1 yoctoNEAR per call', async () => {
    const chain = new FakeChain();
    const funding = chain.addSigner(FUNDING, NEAR);
    chain.register(FUNDING, 30_000n);
    chain.register(BUYER, 2_000n);
    chain.register(PROVIDER);
    await chain.ftTransfers(funding, [
      { receiverId: BUYER, amount: 8_000n },
      { receiverId: PROVIDER, amount: 10_000n },
    ]);
    expect(await Promise.all([FUNDING, BUYER, PROVIDER].map((id) => chain.ftBalanceOf(id)))).toEqual([12_000n, 10_000n, 10_000n]);
    expect((await chain.account(FUNDING))?.balance).toBe(NEAR - 2n);
    expect(chain.writes[0]).toMatchObject({
      kind: 'ftTransfers',
      signer: FUNDING,
      transfers: [
        { receiverId: BUYER, amount: 8_000n },
        { receiverId: PROVIDER, amount: 10_000n },
      ],
    });
  });

  it.each([
    ['an unregistered receiver', [{ receiverId: 'nobody.testnet', amount: 1n }]],
    ['a zero amount', [{ receiverId: BUYER, amount: 0n }]],
    ['the sender as receiver', [{ receiverId: FUNDING, amount: 1n }]],
    [
      'more than the sender holds, across the batch',
      [
        { receiverId: BUYER, amount: 600n },
        { receiverId: PROVIDER, amount: 600n },
      ],
    ],
  ])('fails a whole batch of transfers with %s, moving nothing', async (_case, transfers) => {
    const chain = new FakeChain();
    const funding = chain.addSigner(FUNDING, NEAR);
    chain.register(FUNDING, 1_000n);
    chain.register(BUYER);
    chain.register(PROVIDER);
    await expect(chain.ftTransfers(funding, transfers)).rejects.toBeInstanceOf(TransactionFailedError);
    expect(await Promise.all([FUNDING, BUYER, PROVIDER].map((id) => chain.ftBalanceOf(id)))).toEqual([1_000n, 0n, 0n]);
  });

  it('fails a transfer from an unregistered sender', async () => {
    const chain = new FakeChain();
    const funding = chain.addSigner(FUNDING, NEAR);
    chain.register(BUYER);
    await expect(chain.ftTransfers(funding, [{ receiverId: BUYER, amount: 1n }])).rejects.toBeInstanceOf(TransactionFailedError);
  });

  it.each([0, 11])('refuses a batch of %i calls before recording or signing anything', async (size) => {
    const { chain, parent } = setup();
    const ids = Array.from({ length: size }, (_, i) => `b${i}.testnet`);
    await expect(chain.storageDeposits(parent, ids, REGISTRATION_DEPOSIT)).rejects.toBeInstanceOf(RangeError);
    const transfers = ids.map((receiverId) => ({ receiverId, amount: 1n }));
    await expect(chain.ftTransfers(parent, transfers)).rejects.toBeInstanceOf(RangeError);
    expect(chain.writes).toEqual([]);
  });

  it('accepts a batch of 10 calls', async () => {
    const { chain, parent } = setup();
    const ids = Array.from({ length: 10 }, (_, i) => `b${i}.testnet`);
    await chain.storageDeposits(parent, ids, REGISTRATION_DEPOSIT);
    expect(chain.registered.size).toBe(10);
  });

  it('charges its fee to the signer of every write that runs', async () => {
    const { chain, parent } = setup();
    chain.txFee = 1_000n;
    chain.addAccount(BUYER);
    await chain.transferNear(parent, BUYER, 1n);
    await chain.storageDeposits(parent, [BUYER], REGISTRATION_DEPOSIT);
    expect((await chain.account(PARENT))?.balance).toBe(10n * NEAR - 1n - REGISTRATION_DEPOSIT - 2_000n);
  });

  it('needs the signer to hold what heldWhileRunning asks while a write runs, and charges none of it', async () => {
    const { chain, parent } = setup();
    chain.addAccount(BUYER);
    chain.heldWhileRunning = (write) => (write.kind === 'transferNear' ? NEAR : 0n);
    await expect(chain.transferNear(parent, BUYER, 9n * NEAR + 1n)).rejects.toThrow(`${PARENT} cannot pay`);
    await chain.transferNear(parent, BUYER, 9n * NEAR);
    expect((await chain.account(PARENT))?.balance).toBe(NEAR);
  });
});

describe('FakeChain ft_transfer_call', () => {
  it('opens a pool from an open message to the pools contract, as the contract does', async () => {
    const { chain, provider } = withPools();
    chain.setPool(poolView({ id: 6 }));
    const { outcome, used } = await chain.ftTransferCall(provider, { receiverId: POOLS, amount: 1_728n, msg: openMsg() });
    const opened: PoolView = {
      id: 7,
      seller: PROVIDER,
      seat_price: '180',
      target: 192,
      taken: 0,
      deadline_ms: NOW_MS + 600_000,
      bonus: '1728',
      max_seats_per_buyer: 24,
      terms: TERMS,
      status: 'open',
      bonus_per_seat: '0',
      refund_cursor: 0,
      dust_sent: false,
      buyer_count: 0,
    };
    expect(used).toBe(1_728n);
    expect(await chain.getPool(7)).toEqual(opened);
    expect(poolsEvents(outcome, POOLS)).toEqual([
      {
        event: 'pool_opened',
        data: { pool_id: 7, seller: PROVIDER, seat_price: '180', target: 192, deadline_ms: NOW_MS + 600_000, bonus: '1728', terms: TERMS },
      },
    ]);
    expect(outcome.receipts.map((receipt) => receipt.executorId)).toEqual([PROVIDER, TOKEN, POOLS, TOKEN]);
    expect([await chain.ftBalanceOf(PROVIDER), await chain.ftBalanceOf(POOLS)]).toEqual([10_000n - 1_728n, 1_728n]);
    expect((await chain.account(PROVIDER))?.balance).toBe(NEAR - 1n);
    expect(chain.writes[0]).toMatchObject({ kind: 'ftTransferCall', signer: PROVIDER, receiverId: POOLS, amount: 1_728n, msg: openMsg() });
  });

  it('numbers the first pool 0', async () => {
    const { chain, provider } = withPools();
    await chain.ftTransferCall(provider, { receiverId: POOLS, amount: 1n, msg: openMsg() });
    expect([...chain.pools.keys()]).toEqual([0]);
  });

  it('keeps a pool without a per-buyer cap uncapped', async () => {
    const { chain, provider } = withPools();
    await chain.ftTransferCall(provider, { receiverId: POOLS, amount: 1n, msg: openMsg({ max_seats_per_buyer: null }) });
    expect((await chain.getPool(0))?.max_seats_per_buyer).toBeNull();
  });

  it.each([
    ['a deadline that is not after the final block', openMsg({ deadline_ms: NOW_MS })],
    ['a seat price of 0', openMsg({ seat_price: '0' })],
    ['a target above 1000', openMsg({ target: 1001 })],
    ['terms above 280 bytes', openMsg({ terms: '×'.repeat(141) })],
    ['a per-buyer cap of 0', openMsg({ max_seats_per_buyer: 0 })],
    ['a message that is not an open', JSON.stringify({ commit: { pool_id: 0, seats: 1 } })],
    ['a message that is not JSON', 'open'],
  ])('refuses %s: the pools receipt fails and the token keeps nothing', async (_case, msg) => {
    const { chain, provider } = withPools();
    const { outcome, used } = await chain.ftTransferCall(provider, { receiverId: POOLS, amount: 1_728n, msg });
    expect(used).toBe(0n);
    expect(outcome.receipts.find((receipt) => receipt.executorId === POOLS)?.failed).toBe(true);
    expect(poolsEvents(outcome, POOLS)).toEqual([]);
    expect(chain.pools.size).toBe(0);
    expect(await chain.ftBalanceOf(PROVIDER)).toBe(10_000n);
  });

  it('refuses a call to a receiver that is not a deployed pools contract', async () => {
    const { chain, provider } = withPools();
    chain.register(BUYER);
    expect((await chain.ftTransferCall(provider, { receiverId: BUYER, amount: 5n, msg: openMsg() })).used).toBe(0n);
    expect(await chain.ftBalanceOf(BUYER)).toBe(0n);
  });

  it('fails a call the sender cannot cover, transferring nothing', async () => {
    const { chain, provider } = withPools(1_000n);
    const call = chain.ftTransferCall(provider, { receiverId: POOLS, amount: 1_728n, msg: openMsg() });
    await expect(call).rejects.toBeInstanceOf(TransactionFailedError);
    expect(await chain.ftBalanceOf(PROVIDER)).toBe(1_000n);
  });

  it('answers with the script when one is set, changing no state of its own', async () => {
    const { chain, provider } = withPools();
    const scripted = { outcome: { txHash: 'Scripted1', receipts: [] }, used: 5n };
    chain.onTransferCall = (call) => {
      expect(call).toMatchObject({ signer: PROVIDER, receiverId: POOLS, amount: 1_728n });
      return scripted;
    };
    expect(await chain.ftTransferCall(provider, { receiverId: POOLS, amount: 1_728n, msg: openMsg() })).toEqual(scripted);
    expect(chain.pools.size).toBe(0);
    expect(await chain.ftBalanceOf(PROVIDER)).toBe(10_000n);
    expect(await chain.txOutcome('Scripted1', PROVIDER)).toEqual(scripted.outcome);
  });

  it('logs the pool_opened event as the contract writes it', async () => {
    const { chain, provider } = withPools();
    const { outcome } = await chain.ftTransferCall(provider, { receiverId: POOLS, amount: 1n, msg: openMsg() });
    const [log] = outcome.receipts.find((receipt) => receipt.executorId === POOLS)?.logs ?? [];
    expect(log?.startsWith('EVENT_JSON:{"standard":"quorum","version":"1.0.0","event":"pool_opened","data":[{')).toBe(true);
    expect(parseEventLog(log ?? '')?.event).toBe('pool_opened');
  });
});

describe('FakeChain.failWrite', () => {
  it('fails the first matching write with a TransactionFailedError, records it, and changes nothing', async () => {
    const { chain, parent } = setup();
    chain.addAccount(BUYER);
    chain.failWrite((write) => write.kind === 'transferNear' && write.amount === 2n);
    await chain.transferNear(parent, BUYER, 1n);
    const error = await chain.transferNear(parent, BUYER, 2n).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TransactionFailedError);
    expect((error as TransactionFailedError).outcome.receipts.map((r) => [r.executorId, r.failed])).toEqual([
      [PARENT, false],
      [BUYER, true],
    ]);
    expect((await chain.account(BUYER))?.balance).toBe(1n);
    expect(chain.writes.map((write) => write.kind === 'transferNear' && write.amount)).toEqual([1n, 2n]);
  });

  it('fails only once', async () => {
    const { chain, parent } = setup();
    chain.addAccount(BUYER);
    chain.failWrite(() => true);
    await expect(chain.transferNear(parent, BUYER, 1n)).rejects.toBeInstanceOf(TransactionFailedError);
    await chain.transferNear(parent, BUYER, 1n);
    expect((await chain.account(BUYER))?.balance).toBe(1n);
  });

  it('throws the given error instead, such as a send whose result is unknown', async () => {
    const { chain, parent } = setup();
    const sent = new Error('fetch failed');
    chain.failWrite((write) => write.kind === 'createAccount', sent);
    await expect(chain.createAccount(parent, { accountId: BUYER, balance: 1n, publicKeys: [] })).rejects.toBe(sent);
    expect(await chain.account(BUYER)).toBeNull();
  });
});
