import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  ConfigError,
  folderKeyPath,
  keyFilePath,
  keyFolderPath,
  readKeyFile,
  readKeyFolder,
  readSpendFile,
  SpendFileError,
  writeKeyFile,
  writeSpendFile,
} from '@quorum-on-near/buyer';
import { KeyPair } from 'near-api-js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scriptedBuyerIds } from '../src/accounts.ts';
import type { SwarmConfig } from '../src/config.ts';
import { OutcomeUnknownError } from '../src/chain.ts';
import { runSetup, SetupError, ShortfallError, type SetupProblem, type SetupReport } from '../src/setup.ts';
import { FakeChain, NEAR, PARENT, POOLS, PROVIDER, REGISTRATION_DEPOSIT, testConfig, type FakeWrite } from './fake-chain.ts';

const FUNDING = `funding.${PARENT}`;
const RELAYER = `relay.${PARENT}`;
const MCP = `buyer-llm.${PARENT}`;
const BUYERS = [...scriptedBuyerIds(PARENT), MCP];
/** A wasm module's first eight bytes: what setup deploys, read from QUORUM_POOLS_WASM. */
const WASM = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
const MILLINEAR = NEAR / 1000n;
/**
 * What a first setup sends from the parent with the defaults: the funding account 0.5 NEAR, the
 * pools contract 3.5, the relayer 3, the provider 0.5, 21 buyers 0.05 each (8.55 NEAR), and 24
 * registrations of 0.00125 NEAR (0.03 NEAR).
 */
const FIRST_RUN_SENDS = 8_580n * MILLINEAR;
/**
 * What a first setup keeps for gas beyond that: 0.1 NEAR, plus 0.008 NEAR for each of the 25
 * accounts it creates (0.2 NEAR), plus the 0.2 NEAR its batches of 10 registrations hold while they
 * run (10 calls of 20 Tgas at 0.001 NEAR per Tgas).
 */
const FIRST_RUN_GAS = 500n * MILLINEAR;
const FIRST_RUN_NEAR = FIRST_RUN_SENDS + FIRST_RUN_GAS;
/** What each batched call holds while it runs: 20 Tgas bought at 0.001 NEAR per Tgas. */
const CALL_GAS_HELD = 20n * MILLINEAR;
/** What the provider and the 21 buyers are topped up to on the token: 22 × 10,000 base units. */
const FIRST_RUN_TOKENS = 220_000n;

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'quorum-setup-'));
  await writeFile(join(dir, 'quorum_pools.wasm'), WASM);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A setup world: a fake chain holding the parent and its key file, and the lines setup logs. */
interface World {
  config: SwarmConfig;
  chain: FakeChain;
  parentKey: KeyPair;
  lines: string[];
  run(): Promise<SetupReport>;
}

/** A chain holding only the parent, with `parentNear`, and the parent's key file in the temp folder. */
async function world(opts: { parentNear?: bigint; config?: Partial<SwarmConfig> } = {}): Promise<World> {
  const config = testConfig({
    credentialsDir: join(dir, 'keys'),
    spendFile: join(dir, 'mcp-spend.json'),
    poolsWasm: join(dir, 'quorum_pools.wasm'),
    ...opts.config,
  });
  const chain = new FakeChain(config);
  const { keyPair: parentKey } = chain.addSigner(PARENT, opts.parentNear ?? 100n * NEAR);
  await writeKeyFile(keyFile(config, PARENT), PARENT, parentKey);
  const lines: string[] = [];
  return { config, chain, parentKey, lines, run: () => runSetup(config, { chain, log: (line) => lines.push(line) }) };
}

/** A world in which setup has run to the end: the first run, the funding account filled, the second run. */
async function readyWorld(opts: { config?: Partial<SwarmConfig> } = {}): Promise<World> {
  const w = await world(opts);
  await expect(w.run()).rejects.toThrow(ShortfallError);
  w.chain.tokenBalances.set(w.config.funding, FIRST_RUN_TOKENS);
  await w.run();
  w.chain.writes = [];
  w.lines.length = 0;
  return w;
}

function keyFile(config: SwarmConfig, accountId: string): string {
  return keyFilePath(config.credentialsDir, config.network, accountId);
}

/** The error `promise` rejects with; fails the test if it resolves. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('the promise resolved');
}

/** Checks that setup stopped with `problem`, in a message that names `named`. */
function expectSetupError(error: unknown, problem: SetupProblem, named: string): void {
  expect(error).toBeInstanceOf(SetupError);
  expect((error as SetupError).problem).toBe(problem);
  expect((error as SetupError).message).toContain(named);
}

/** The writes of one kind, in order. */
function writesOf<K extends FakeWrite['kind']>(chain: FakeChain, kind: K): Extract<FakeWrite, { kind: K }>[] {
  return chain.writes.filter((write): write is Extract<FakeWrite, { kind: K }> => write.kind === kind);
}

describe('runSetup on a chain that holds only the parent', () => {
  it('creates every account under the parent with its NEAR target as its balance, in order', async () => {
    const w = await world();
    await rejection(w.run());
    expect(writesOf(w.chain, 'createAccount').map(({ signer, accountId, balance }) => [signer, accountId, balance])).toEqual([
      [PARENT, FUNDING, 500n * MILLINEAR],
      [PARENT, POOLS, 3_500n * MILLINEAR],
      [PARENT, RELAYER, 3_000n * MILLINEAR],
      [PARENT, PROVIDER, 500n * MILLINEAR],
      ...BUYERS.map((id) => [PARENT, id, 50n * MILLINEAR]),
    ]);
  });

  it('writes each new key to its key file, for the account the creation gives that key', async () => {
    const w = await world();
    await rejection(w.run());
    for (const { accountId, publicKeys } of writesOf(w.chain, 'createAccount')) {
      if (accountId === RELAYER) continue;
      const stored = JSON.parse(await readFile(keyFile(w.config, accountId), 'utf8')) as Record<string, string>;
      expect(stored.account_id).toBe(accountId);
      expect(publicKeys).toEqual([stored.public_key]);
    }
  });

  it('reports each transaction with its hash and each key file it writes, as it goes', async () => {
    const w = await world({ config: { relayerKeyCount: 2 } });
    await rejection(w.run());
    expect(w.chain.writes).toHaveLength(29);
    for (const write of w.chain.writes) {
      expect(w.lines.filter((line) => line.includes(write.txHash))).toHaveLength(1);
    }
    const files = (await readdir(w.config.credentialsDir, { recursive: true }))
      .filter((name) => name.endsWith('.json'))
      .map((name) => join(w.config.credentialsDir, name))
      .filter((path) => path !== keyFile(w.config, PARENT));
    expect(files).toHaveLength(24 + 2 + 1);
    for (const path of files) expect(w.lines.filter((line) => line.endsWith(path))).toHaveLength(1);
    expect(w.lines).toHaveLength(29 + 27);
  });

  it("gives the relayer QUORUM_RELAYER_KEY_COUNT keys in its key folder, and the first in the relayer's key file", async () => {
    const w = await world({ config: { relayerKeyCount: 3 } });
    await rejection(w.run());
    const [relayer] = writesOf(w.chain, 'createAccount').filter((write) => write.accountId === RELAYER);
    const folderKeys = await readKeyFolder(keyFolderPath(w.config.credentialsDir, w.config.network, RELAYER));
    expect(relayer?.publicKeys).toHaveLength(3);
    expect(new Set(relayer?.publicKeys)).toEqual(new Set(folderKeys.map((key) => key.getPublicKey().toString())));
    const relayerFile = await readKeyFile(keyFile(w.config, RELAYER));
    expect(relayer?.publicKeys[0]).toBe(relayerFile.getPublicKey().toString());
  });

  it('deploys the pools contract from QUORUM_POOLS_WASM, signed by the pools account', async () => {
    const w = await world();
    await rejection(w.run());
    const deploys = writesOf(w.chain, 'deployPools');
    expect(deploys.map(({ signer, code }) => [signer, [...code]])).toEqual([[POOLS, [...WASM]]]);
  });

  it('registers the funding account, the pools contract, the provider and each buyer, 10 at most per transaction', async () => {
    const w = await world();
    await rejection(w.run());
    const deposits = writesOf(w.chain, 'storageDeposits');
    expect(deposits.map(({ signer, deposit }) => [signer, deposit])).toEqual([
      [PARENT, REGISTRATION_DEPOSIT],
      [PARENT, REGISTRATION_DEPOSIT],
      [PARENT, REGISTRATION_DEPOSIT],
    ]);
    expect(deposits.map((write) => write.accountIds)).toEqual([
      [FUNDING, POOLS, PROVIDER, ...BUYERS.slice(0, 7)],
      BUYERS.slice(7, 17),
      BUYERS.slice(17),
    ]);
    expect(w.chain.registered.has(RELAYER)).toBe(false);
  });

  it('then stops, naming the funding account and its token shortfall, and makes none of the top-ups', async () => {
    const w = await world();
    const error = await rejection(w.run());
    expectSetupError(error, 'token_shortfall', FUNDING);
    expect(error).toBeInstanceOf(ShortfallError);
    expect(error).toMatchObject({ account: FUNDING, shortfall: FIRST_RUN_TOKENS });
    expect((error as Error).message).toContain('220000');
    expect(writesOf(w.chain, 'ftTransfers')).toEqual([]);
    expect(w.chain.writes.map((write) => write.kind)).toEqual([
      ...Array<string>(25).fill('createAccount'),
      'deployPools',
      'storageDeposits',
      'storageDeposits',
      'storageDeposits',
    ]);
  });
});

describe('runSetup once the funding account holds the tokens', () => {
  it('tops the provider and each buyer up from the funding account, 10 at most per transaction', async () => {
    const w = await world();
    await rejection(w.run());
    w.chain.tokenBalances.set(FUNDING, FIRST_RUN_TOKENS + 5n);
    w.chain.writes = [];
    await w.run();
    const transfers = writesOf(w.chain, 'ftTransfers');
    expect(transfers.map((write) => write.signer)).toEqual([FUNDING, FUNDING, FUNDING]);
    expect(transfers.map((write) => write.transfers)).toEqual([
      [PROVIDER, ...BUYERS.slice(0, 9)].map((receiverId) => ({ receiverId, amount: 10_000n })),
      BUYERS.slice(9, 19).map((receiverId) => ({ receiverId, amount: 10_000n })),
      BUYERS.slice(19).map((receiverId) => ({ receiverId, amount: 10_000n })),
    ]);
    expect(w.chain.tokenBalances.get(FUNDING)).toBe(5n);
    expect(w.chain.writes.map((write) => write.kind)).toEqual(['ftTransfers', 'ftTransfers', 'ftTransfers']);
  });

  it("clears the MCP server's spend total", async () => {
    const w = await world();
    await writeSpendFile(w.config.spendFile, MCP, 4_000n);
    await rejection(w.run());
    expect(await readSpendFile(w.config.spendFile, MCP)).toBe(4_000n);
    w.chain.tokenBalances.set(FUNDING, FIRST_RUN_TOKENS);
    await w.run();
    expect(await readSpendFile(w.config.spendFile, MCP)).toBe(0n);
  });

  it('reports each transaction it sent with its hash, and each file it wrote, and returns the same lines', async () => {
    const w = await world();
    await writeSpendFile(w.config.spendFile, MCP, 4_000n);
    await rejection(w.run());
    w.chain.tokenBalances.set(FUNDING, FIRST_RUN_TOKENS);
    w.lines.length = 0;
    const report = await w.run();
    expect(report.actions).toEqual(w.lines);
    expect(w.lines).toHaveLength(4);
    for (const write of w.chain.writes.slice(-3)) {
      expect(w.lines.filter((line) => line.includes(write.txHash))).toHaveLength(1);
    }
    expect(w.lines.filter((line) => line.includes(w.config.spendFile) && line.includes(MCP))).toHaveLength(1);
  });

  it('then has nothing to do: a third run reads only, and says so', async () => {
    const w = await readyWorld();
    const report = await w.run();
    expect(w.chain.writes).toEqual([]);
    expect(report.actions).toEqual([]);
    expect(w.lines).toEqual(['nothing to do']);
  });
});

describe('runSetup refuses before sending anything', () => {
  /** Runs setup and checks that it stopped with `problem`, naming `named`, and that it sent and wrote nothing. */
  async function expectRefusal(w: World, problem: SetupProblem, named: string): Promise<unknown> {
    const before = await readdir(dir, { recursive: true });
    const error = await rejection(w.run());
    expectSetupError(error, problem, named);
    expect(w.chain.writes).toEqual([]);
    expect(w.lines).toEqual([]);
    expect(await readdir(dir, { recursive: true })).toEqual(before);
    return error;
  }

  it('when the RPC serves another chain than QUORUM_NETWORK names, with a ConfigError as the command line gives', async () => {
    const w = await world();
    w.chain.nodeChainId = 'mainnet';
    const before = await readdir(dir, { recursive: true });
    const error = await rejection(w.run());
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).problems).toEqual([expect.stringContaining('"mainnet"')]);
    expect(w.chain.writes).toEqual([]);
    expect(w.lines).toEqual([]);
    expect(await readdir(dir, { recursive: true })).toEqual(before);
  });

  it("when the parent's key file is missing", async () => {
    const w = await world();
    await rm(keyFile(w.config, PARENT));
    await expectRefusal(w, 'missing_key', PARENT);
  });

  it('when the parent account does not exist', async () => {
    const w = await world();
    w.chain.accounts.delete(PARENT);
    await expectRefusal(w, 'missing_account', PARENT);
  });

  it('when the parent cannot pay for what setup sends, naming it and the NEAR it lacks', async () => {
    const w = await world({ parentNear: FIRST_RUN_NEAR - 10n * MILLINEAR });
    const error = await expectRefusal(w, 'near_shortfall', PARENT);
    expect(error).toBeInstanceOf(ShortfallError);
    expect(error).toMatchObject({ account: PARENT, shortfall: 10n * MILLINEAR });
    expect((error as Error).message).toContain('0.01 NEAR');
  });

  it('when an account it would sign for exists without a key file', async () => {
    const w = await world();
    w.chain.addAccount(PROVIDER, { balance: NEAR });
    await expectRefusal(w, 'missing_key', PROVIDER);
  });

  it('when the relayer exists without its key folder', async () => {
    const w = await world();
    const { keyPair } = w.chain.addSigner(RELAYER, 3n * NEAR);
    await writeKeyFile(keyFile(w.config, RELAYER), RELAYER, keyPair);
    await expectRefusal(w, 'missing_key', RELAYER);
  });

  it('when a funding account outside the parent does not exist: setup never creates it', async () => {
    const w = await world({ config: { funding: 'treasury.testnet' } });
    await expectRefusal(w, 'missing_account', 'treasury.testnet');
  });

  it('when a funding account outside the parent has no key file', async () => {
    const w = await world({ config: { funding: 'treasury.testnet' } });
    w.chain.addSigner('treasury.testnet', NEAR);
    await expectRefusal(w, 'missing_key', 'treasury.testnet');
  });

  it('when the pools contract was initialised with another token', async () => {
    const w = await world();
    w.chain.addAccount(POOLS, { balance: 3n * NEAR, hasCode: true });
    w.chain.poolsToken = 'other-token.testnet';
    const error = await expectRefusal(w, 'wrong_token', POOLS);
    expect((error as Error).message).toContain('other-token.testnet');
  });

  it('when the pools contract must be deployed but QUORUM_POOLS_WASM is not set', async () => {
    const w = await world({ config: { poolsWasm: null } });
    await expectRefusal(w, 'missing_wasm', 'QUORUM_POOLS_WASM');
  });

  it('when the pools account exists without code and without a key file to deploy with', async () => {
    const w = await world();
    w.chain.addAccount(POOLS, { balance: 3n * NEAR });
    await expectRefusal(w, 'missing_key', POOLS);
  });
});

describe('the NEAR pre-check', () => {
  it('lets setup run when the parent holds exactly what it sends plus its gas margin', async () => {
    const w = await world({ parentNear: FIRST_RUN_NEAR });
    expect(await rejection(w.run())).toMatchObject({ problem: 'token_shortfall' });
    expect(w.chain.accounts.get(PARENT)?.balance).toBe(FIRST_RUN_GAS);
  });

  it('keeps enough for a first setup whose transactions burn gas and hold the gas of each call while they run', async () => {
    const w = await world({ parentNear: FIRST_RUN_NEAR });
    // An account creation alone costs about 0.00707 NEAR.
    w.chain.txFee = 8n * MILLINEAR;
    w.chain.heldWhileRunning = (write) => (write.kind === 'storageDeposits' ? BigInt(write.accountIds.length) * CALL_GAS_HELD : 0n);
    expect(await rejection(w.run())).toMatchObject({ problem: 'token_shortfall' });
    expect(writesOf(w.chain, 'storageDeposits')).toHaveLength(3);
  });

  it('refuses a parent that holds what setup sends plus only 0.1 NEAR, too little for the gas of a first setup', async () => {
    const w = await world({ parentNear: FIRST_RUN_SENDS + 100n * MILLINEAR });
    const error = await rejection(w.run());
    expect(error).toMatchObject({ problem: 'near_shortfall', account: PARENT, shortfall: 400n * MILLINEAR });
    expect(w.chain.writes).toEqual([]);
  });

  it('says what the gas margin is made of', async () => {
    const w = await world({ parentNear: FIRST_RUN_NEAR - 1n });
    const error = await rejection(w.run());
    expect(error).toMatchObject({ problem: 'near_shortfall', shortfall: 1n });
    expect((error as Error).message).toContain(
      'setup sends 8.58 NEAR from it and keeps 0.5 NEAR for gas (0.1 NEAR, plus 0.008 NEAR for each of the 25 accounts ' +
        'it creates, plus 0.2 NEAR its largest batch of 10 calls buys upfront, refunded after)',
    );
  });

  it('grows the margin with the accounts to create and the calls of the largest batch', async () => {
    const w = await readyWorld();
    for (const id of BUYERS.slice(0, 3)) {
      w.chain.accounts.delete(id);
      w.chain.registered.delete(id);
      w.chain.tokenBalances.delete(id);
    }
    w.chain.tokenBalances.set(FUNDING, 30_000n);
    // Sent: 3 × 0.05 NEAR and 3 registrations. Kept: 0.1 NEAR, 3 × 0.008 NEAR and one batch of 3 calls.
    const needed = 150n * MILLINEAR + 3n * REGISTRATION_DEPOSIT + 100n * MILLINEAR + 24n * MILLINEAR + 3n * CALL_GAS_HELD;
    w.chain.accounts.get(PARENT)!.balance = needed - 1n;
    expect(await rejection(w.run())).toMatchObject({ problem: 'near_shortfall', shortfall: 1n });
    expect(w.chain.writes).toEqual([]);
    w.chain.accounts.get(PARENT)!.balance = needed;
    await w.run();
    expect(writesOf(w.chain, 'createAccount').map((write) => write.accountId)).toEqual(BUYERS.slice(0, 3));
  });

  it('keeps the gas of the token top-ups too when the parent is the funding account, even if it sends no NEAR', async () => {
    const w = await world({ config: { funding: PARENT } });
    w.chain.register(PARENT, FIRST_RUN_TOKENS);
    await w.run();
    w.chain.tokenBalances.set(BUYERS[0]!, 0n);
    w.chain.tokenBalances.set(PARENT, 10_000n);
    w.chain.writes = [];
    // One batch of one ft_transfer.
    w.chain.accounts.get(PARENT)!.balance = 100n * MILLINEAR + CALL_GAS_HELD - 1n;
    expect(await rejection(w.run())).toMatchObject({ problem: 'near_shortfall', shortfall: 1n });
    expect(w.chain.writes).toEqual([]);
    w.chain.accounts.get(PARENT)!.balance = 100n * MILLINEAR + CALL_GAS_HELD;
    await w.run();
    expect(writesOf(w.chain, 'ftTransfers').map((write) => write.transfers)).toEqual([[{ receiverId: BUYERS[0], amount: 10_000n }]]);
  });

  it("compares what setup sends with the parent's NEAR free of its storage", async () => {
    const w = await world({ parentNear: FIRST_RUN_NEAR });
    // 1,000 bytes lock 0.01 NEAR of the parent's balance.
    w.chain.accounts.get(PARENT)!.storageUsage = 1_000n;
    const error = await rejection(w.run());
    expect(error).toMatchObject({ problem: 'near_shortfall', account: PARENT, shortfall: 10n * MILLINEAR });
    expect((error as Error).message).toContain(`the parent account ${PARENT} holds 9.07 NEAR free of its storage, but setup sends 8.58 NEAR`);
    expect(w.chain.writes).toEqual([]);
  });

  it('asks for nothing when setup sends nothing from the parent', async () => {
    const w = await readyWorld();
    w.chain.accounts.get(PARENT)!.balance = 0n;
    await w.run();
    expect(w.lines).toEqual(['nothing to do']);
  });
});

describe('NEAR top-ups', () => {
  it('top an account back up to its target, from the parent, once it holds less than 90% of it', async () => {
    const w = await readyWorld();
    const [buyer1, buyer2] = BUYERS;
    w.chain.accounts.get(buyer1!)!.balance = 45n * MILLINEAR;
    w.chain.accounts.get(buyer2!)!.balance = 45n * MILLINEAR - 1n;
    w.chain.accounts.get(RELAYER)!.balance = 1n * NEAR;
    await w.run();
    expect(writesOf(w.chain, 'transferNear').map(({ signer, receiverId, amount }) => [signer, receiverId, amount])).toEqual([
      [PARENT, RELAYER, 2n * NEAR],
      [PARENT, buyer2, 5n * MILLINEAR + 1n],
    ]);
    expect(w.lines).toEqual([
      `topped up  ${RELAYER}  +2 NEAR  tx ${w.chain.writes[0]?.txHash}`,
      `topped up  ${buyer2}  +0.005000000000000000000001 NEAR  tx ${w.chain.writes[1]?.txHash}`,
    ]);
  });

  it('leave a second run with nothing to send after the first one burnt gas', async () => {
    const w = await world();
    w.chain.txFee = 5n * MILLINEAR;
    await rejection(w.run());
    w.chain.tokenBalances.set(FUNDING, FIRST_RUN_TOKENS);
    await w.run();
    w.chain.writes = [];
    await w.run();
    expect(w.chain.writes).toEqual([]);
  });
});

describe("the pools contract's free NEAR", () => {
  /** A world in which setup has run, whose pools contract then holds `balance` and uses `bytes` of storage. */
  async function poolsWorld(balance: bigint, bytes: bigint, config: Partial<SwarmConfig> = {}): Promise<World> {
    const w = await readyWorld({ config });
    const pools = w.chain.accounts.get(POOLS)!;
    pools.balance = balance;
    pools.storageUsage = bytes;
    return w;
  }

  it('is topped up back to QUORUM_POOLS_FREE_NEAR once its storage leaves less than 90% of it free, saying what was free', async () => {
    // 300,000 bytes lock 3 NEAR of the 3.5 NEAR it holds: 0.5 NEAR is free, below 0.9 NEAR.
    const w = await poolsWorld(3_500n * MILLINEAR, 300_000n);
    await w.run();
    expect(writesOf(w.chain, 'transferNear').map(({ signer, receiverId, amount }) => [signer, receiverId, amount])).toEqual([
      [PARENT, POOLS, 500n * MILLINEAR],
    ]);
    expect(w.lines).toEqual([`topped up  ${POOLS}  +0.5 NEAR  0.5 NEAR was free of its storage, now 1 NEAR  tx ${w.chain.writes[0]?.txHash}`]);
    w.chain.writes = [];
    w.lines.length = 0;
    await w.run();
    expect(w.lines).toEqual(['nothing to do']);
  });

  it('is left alone while 90% of QUORUM_POOLS_FREE_NEAR is free, though its balance is below 90% of QUORUM_POOLS_NEAR', async () => {
    // Its code and first records lock 204,022 bytes, 2.04022 NEAR, of 3 NEAR: 0.95978 NEAR is free.
    const w = await poolsWorld(3_000n * MILLINEAR, 204_022n);
    await w.run();
    expect(w.chain.writes).toEqual([]);
    expect(w.lines).toEqual(['nothing to do']);
  });

  it('follows QUORUM_POOLS_FREE_NEAR', async () => {
    const w = await poolsWorld(3_500n * MILLINEAR, 204_022n, { poolsFreeNear: 2n * NEAR });
    await w.run();
    expect(writesOf(w.chain, 'transferNear').map(({ receiverId, amount }) => [receiverId, amount])).toEqual([
      [POOLS, 540_220_000_000_000_000_000_000n],
    ]);
  });

  it('counts for nothing while the pools account holds no code: it is topped up to QUORUM_POOLS_NEAR', async () => {
    const w = await poolsWorld(3_000n * MILLINEAR, 0n);
    w.chain.accounts.get(POOLS)!.hasCode = false;
    await w.run();
    expect(writesOf(w.chain, 'transferNear').map(({ receiverId, amount }) => [receiverId, amount])).toEqual([[POOLS, 500n * MILLINEAR]]);
    expect(writesOf(w.chain, 'deployPools')).toHaveLength(1);
  });
});

describe('runSetup after a run that stopped part way', () => {
  it('creates an account with the key a stopped run left in its key file, and leaves that file as it was', async () => {
    const w = await world();
    const buyer5 = BUYERS[4]!;
    w.chain.failWrite((write) => write.kind === 'createAccount' && write.accountId === buyer5, new Error('fetch failed'));
    await expect(w.run()).rejects.toThrow('fetch failed');
    expect(w.chain.accounts.has(buyer5)).toBe(false);
    const left = await readFile(keyFile(w.config, buyer5), 'utf8');
    w.chain.writes = [];
    w.lines.length = 0;
    await rejection(w.run());
    const creations = writesOf(w.chain, 'createAccount');
    expect(creations.map((write) => write.accountId)).toEqual(BUYERS.slice(4));
    expect(creations[0]?.publicKeys).toEqual([(JSON.parse(left) as { public_key: string }).public_key]);
    expect(await readFile(keyFile(w.config, buyer5), 'utf8')).toBe(left);
    expect(w.lines.filter((line) => line.includes(keyFile(w.config, buyer5)))).toEqual([]);
  });

  it('says, when a write got no result, that setup can be run again once that transaction is final', async () => {
    const w = await world();
    const unknown = new OutcomeUnknownError('a transaction from parent to buyer may have been sent, but the RPC gave no result (timeout): it may still run', null, 'timeout');
    w.chain.failWrite((write) => write.kind === 'createAccount' && write.accountId === BUYERS[4], unknown);
    const rejected = await rejection(w.run());
    expect(rejected).toBeInstanceOf(OutcomeUnknownError);
    expect(rejected).toMatchObject({ txHash: null, reason: 'timeout', cause: unknown });
    expect((rejected as Error).message).toBe(
      `${unknown.message}. Setup is idempotent: run it again once that transaction is final, and it sends only what is still missing.`,
    );
  });

  it('creates an account with a new key when a stopped run left its key file empty', async () => {
    const w = await world();
    const buyer5 = BUYERS[4]!;
    await mkdir(dirname(keyFile(w.config, buyer5)), { recursive: true });
    await writeFile(keyFile(w.config, buyer5), '');
    await rejection(w.run());
    const [creation] = writesOf(w.chain, 'createAccount').filter((write) => write.accountId === buyer5);
    const stored = await readKeyFile(keyFile(w.config, buyer5));
    expect(creation?.publicKeys).toEqual([stored.getPublicKey().toString()]);
  });

  it("completes the relayer's key folder, keeping the keys a stopped run wrote there", async () => {
    const w = await world();
    const folder = keyFolderPath(w.config.credentialsDir, w.config.network, RELAYER);
    const kept = [KeyPair.fromRandom('ed25519'), KeyPair.fromRandom('ed25519')];
    for (const key of kept) await writeKeyFile(folderKeyPath(folder, key.getPublicKey()), RELAYER, key);
    await rejection(w.run());
    const [relayer] = writesOf(w.chain, 'createAccount').filter((write) => write.accountId === RELAYER);
    expect(relayer?.publicKeys).toHaveLength(4);
    expect(relayer?.publicKeys).toEqual(expect.arrayContaining(kept.map((key) => key.getPublicKey().toString())));
    const stored = (await readKeyFolder(folder)).map((key) => key.getPublicKey().toString());
    expect(stored.sort()).toEqual([...(relayer?.publicKeys ?? [])].sort());
  });

  it('creates the relayer with the keys a stopped run left, its key file included, and writes no file', async () => {
    const w = await world();
    const folder = keyFolderPath(w.config.credentialsDir, w.config.network, RELAYER);
    const kept = Array.from({ length: 4 }, () => KeyPair.fromRandom('ed25519'));
    for (const key of kept) await writeKeyFile(folderKeyPath(folder, key.getPublicKey()), RELAYER, key);
    await writeKeyFile(keyFile(w.config, RELAYER), RELAYER, kept[2]!);
    await rejection(w.run());
    const [relayer] = writesOf(w.chain, 'createAccount').filter((write) => write.accountId === RELAYER);
    expect([...(relayer?.publicKeys ?? [])].sort()).toEqual(kept.map((key) => key.getPublicKey().toString()).sort());
    expect((await readKeyFile(keyFile(w.config, RELAYER))).getPublicKey().toString()).toBe(kept[2]!.getPublicKey().toString());
    expect(w.lines.filter((line) => line.includes(folder))).toEqual([]);
  });
});

describe('runSetup with accounts that exist', () => {
  it('takes the steps in order: creation, NEAR top-ups, deployment, registrations, token top-ups', async () => {
    const w = await readyWorld();
    const last = BUYERS.at(-1)!;
    w.chain.accounts.delete(last);
    w.chain.registered.delete(last);
    w.chain.tokenBalances.delete(last);
    w.chain.accounts.get(POOLS)!.hasCode = false;
    w.chain.accounts.get(RELAYER)!.balance = NEAR;
    w.chain.tokenBalances.set(FUNDING, 10_000n);
    await w.run();
    expect(w.chain.writes.map(({ kind, signer }) => [kind, signer])).toEqual([
      ['createAccount', PARENT],
      ['transferNear', PARENT],
      ['deployPools', POOLS],
      ['storageDeposits', PARENT],
      ['ftTransfers', FUNDING],
    ]);
  });

  it('tops a pools account without code up before deploying to it, when it holds less than its code locks', async () => {
    const w = await readyWorld();
    // 204,000 bytes lock 2.04 NEAR, more than the 1 NEAR the pools account holds.
    await writeFile(w.config.poolsWasm!, new Uint8Array(204_000));
    Object.assign(w.chain.accounts.get(POOLS)!, { hasCode: false, storageUsage: 0n, balance: NEAR });
    await w.run();
    expect(w.chain.writes.map(({ kind, signer }) => [kind, signer])).toEqual([
      ['transferNear', PARENT],
      ['deployPools', POOLS],
    ]);
    expect(writesOf(w.chain, 'transferNear')[0]).toMatchObject({ receiverId: POOLS, amount: 2_500n * MILLINEAR });
    expect(await w.chain.account(POOLS)).toEqual({ balance: 3_500n * MILLINEAR, hasCode: true, storageUsage: 204_000n });
    w.chain.writes = [];
    w.lines.length = 0;
    await w.run();
    expect(w.chain.writes).toEqual([]);
    expect(w.lines).toEqual(['nothing to do']);
  });

  it('registers only the accounts that are not registered yet', async () => {
    const w = await readyWorld();
    w.chain.registered.delete(PROVIDER);
    w.chain.registered.delete(BUYERS[2]!);
    w.chain.tokenBalances.set(FUNDING, 20_000n);
    await w.run();
    expect(writesOf(w.chain, 'storageDeposits').map((write) => write.accountIds)).toEqual([[PROVIDER, BUYERS[2]]]);
  });

  it('leaves a deployed pools contract with the right token alone, even without its key file', async () => {
    const w = await readyWorld();
    await rm(keyFile(w.config, POOLS));
    await w.run();
    expect(w.lines).toEqual(['nothing to do']);
  });

  it('neither creates nor tops up a funding account that is the parent, which signs the token top-ups', async () => {
    const w = await world({ config: { funding: PARENT } });
    w.chain.register(PARENT, FIRST_RUN_TOKENS);
    await w.run();
    expect(writesOf(w.chain, 'createAccount').map((write) => write.accountId)).not.toContain(PARENT);
    expect(writesOf(w.chain, 'transferNear')).toEqual([]);
    expect(writesOf(w.chain, 'ftTransfers').map((write) => write.signer)).toEqual([PARENT, PARENT, PARENT]);
    expect(w.chain.tokenBalances.get(PARENT)).toBe(0n);
  });

  it('uses a funding account outside the parent as it is, topping up only its NEAR', async () => {
    const treasury = 'treasury.testnet';
    const w = await world({ config: { funding: treasury } });
    const { keyPair } = w.chain.addSigner(treasury, 100n * MILLINEAR);
    await writeKeyFile(keyFile(w.config, treasury), treasury, keyPair);
    w.chain.register(treasury, FIRST_RUN_TOKENS);
    await w.run();
    expect(writesOf(w.chain, 'createAccount').map((write) => write.accountId)).not.toContain(treasury);
    expect(writesOf(w.chain, 'transferNear').map(({ signer, receiverId, amount }) => [signer, receiverId, amount])).toEqual([
      [PARENT, treasury, 400n * MILLINEAR],
    ]);
    expect(writesOf(w.chain, 'ftTransfers').map((write) => write.signer)).toEqual([treasury, treasury, treasury]);
  });
});

describe('token top-ups', () => {
  it('read no token balance of an account that does not exist or is not registered: it holds none', async () => {
    const w = await world();
    // A token may refuse the balance of an account it does not know, instead of answering 0.
    const ftBalanceOf = w.chain.ftBalanceOf.bind(w.chain);
    w.chain.ftBalanceOf = async (accountId, atHeight) => {
      if (!w.chain.registered.has(accountId)) throw new Error(`the token does not know ${accountId}`);
      return ftBalanceOf(accountId, atHeight);
    };
    const error = await rejection(w.run());
    expectSetupError(error, 'token_shortfall', FUNDING);
    expect(error).toMatchObject({ account: FUNDING, shortfall: FIRST_RUN_TOKENS });
    w.chain.tokenBalances.set(FUNDING, FIRST_RUN_TOKENS);
    await w.run();
    expect(w.chain.tokenBalances.get(FUNDING)).toBe(0n);
  });

  it('send each account only what it lacks, and nothing to one that holds its amount or more', async () => {
    const w = await readyWorld();
    w.chain.tokenBalances.set(BUYERS[1]!, 4_000n);
    w.chain.tokenBalances.set(PROVIDER, 15_000n);
    w.chain.tokenBalances.set(FUNDING, 6_000n);
    await w.run();
    const transfers = writesOf(w.chain, 'ftTransfers').map((write) => write.transfers);
    expect(transfers).toEqual([[{ receiverId: BUYERS[1], amount: 6_000n }]]);
    expect(w.chain.tokenBalances.get(FUNDING)).toBe(0n);
    expect(w.chain.tokenBalances.get(PROVIDER)).toBe(15_000n);
  });

  it('are none of them made when the funding account cannot cover all, and the spend total is kept', async () => {
    const w = await readyWorld();
    await writeSpendFile(w.config.spendFile, MCP, 2_500n);
    w.chain.tokenBalances.set(BUYERS[1]!, 4_000n);
    w.chain.tokenBalances.set(MCP, 0n);
    w.chain.tokenBalances.set(FUNDING, 15_999n);
    const error = await rejection(w.run());
    expectSetupError(error, 'token_shortfall', FUNDING);
    expect(error).toMatchObject({ account: FUNDING, shortfall: 1n });
    expect(w.chain.writes).toEqual([]);
    expect(await readSpendFile(w.config.spendFile, MCP)).toBe(2_500n);
  });
});

describe("the MCP server's spend total", () => {
  it('is cleared even when no account needs tokens', async () => {
    const w = await readyWorld();
    await writeSpendFile(w.config.spendFile, MCP, 2_500n);
    await w.run();
    expect(await readSpendFile(w.config.spendFile, MCP)).toBe(0n);
    expect(w.chain.writes).toEqual([]);
    expect(w.lines).toHaveLength(1);
    expect(w.lines[0]).toContain(w.config.spendFile);
  });

  it('replaces the total of another account, left by an earlier QUORUM_MCP_ACCOUNT', async () => {
    const w = await readyWorld();
    await writeSpendFile(w.config.spendFile, 'buyer-llm.other.testnet', 2_500n);
    await w.run();
    expect(await readSpendFile(w.config.spendFile, MCP)).toBe(0n);
  });

  it('is never written over a file that is not a spend file', async () => {
    const w = await readyWorld();
    await writeFile(w.config.spendFile, 'not a spend file\n');
    const error = await rejection(w.run());
    expect(error).toBeInstanceOf(SpendFileError);
    expect(error).toMatchObject({ problem: 'malformed' });
    expect(await readFile(w.config.spendFile, 'utf8')).toBe('not a spend file\n');
  });
});

describe('what setup prints', () => {
  /** The private key of every key file under `folder`, as `ed25519:<base58>`. */
  async function storedPrivateKeys(folder: string): Promise<string[]> {
    const names = (await readdir(folder, { recursive: true })).filter((name) => name.endsWith('.json'));
    return Promise.all(names.map(async (name) => (await readKeyFile(join(folder, name))).toString()));
  }

  it('never holds a key, in a line or in an error', async () => {
    const w = await world();
    const texts = [((await rejection(w.run())) as Error).message];
    w.chain.tokenBalances.set(FUNDING, FIRST_RUN_TOKENS);
    await w.run();
    w.chain.accounts.get(PARENT)!.balance = 0n;
    w.chain.accounts.get(RELAYER)!.balance = 0n;
    texts.push(((await rejection(w.run())) as Error).message, ...w.lines);
    const keys = await storedPrivateKeys(w.config.credentialsDir);
    expect(keys).toHaveLength(30);
    const printed = texts.join('\n');
    for (const key of keys) expect(printed).not.toContain(key.slice('ed25519:'.length));
  });
});
