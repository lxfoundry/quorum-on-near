import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError, KeyFileError, keyFilePath, writeKeyFile } from '@quorum-on-near/buyer';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buyerIds } from '../src/accounts.ts';
import { OutcomeUnknownError } from '../src/chain.ts';
import type { SwarmConfig } from '../src/config.ts';
import { runReset } from '../src/reset.ts';
import { FakeChain, NEAR, PARENT, POOLS, PROVIDER, testConfig } from './fake-chain.ts';

const FUNDING = `funding.${PARENT}`;
const RELAYER = `relay.${PARENT}`;
const LLM = `buyer-llm.${PARENT}`;

function buyer(n: number): string {
  return `buyer-${String(n).padStart(2, '0')}.${PARENT}`;
}

let dir: string;
let chain: FakeChain;
let config: SwarmConfig;
let lines: string[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'quorum-reset-'));
  chain = new FakeChain();
  config = testConfig({ credentialsDir: dir });
  lines = [];
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** An account as setup leaves it: NEAR, a key and its key file, and `tokens` on the token. */
async function account(id: string, tokens: bigint): Promise<void> {
  const { keyPair } = chain.addSigner(id, NEAR);
  await writeKeyFile(keyFilePath(dir, config.network, id), id, keyPair);
  chain.register(id, tokens);
}

/** Every account of the system as setup leaves it, each buyer and the provider at its configured amount. */
async function setUp(): Promise<void> {
  await account(FUNDING, 1_000_000n);
  await account(PROVIDER, config.providerBonusFunds);
  for (const id of buyerIds(config)) await account(id, config.buyerBudget);
  chain.addAccount(POOLS, { hasCode: true });
  chain.register(POOLS);
}

function reset(): ReturnType<typeof runReset> {
  return runReset(config, { chain, log: (line) => lines.push(line) });
}

describe('runReset', () => {
  it('returns what each buyer and the provider holds above its amount to the funding account, each signing its own ft_transfer', async () => {
    await setUp();
    chain.register(PROVIDER, 10_540n);
    chain.register(buyer(3), 10_030n);
    chain.register(LLM, 10_200n);
    chain.register(buyer(5), 9_000n);

    const returned = await reset();

    expect(chain.writes).toMatchObject([
      { kind: 'ftTransfers', signer: PROVIDER, transfers: [{ receiverId: FUNDING, amount: 540n }] },
      { kind: 'ftTransfers', signer: buyer(3), transfers: [{ receiverId: FUNDING, amount: 30n }] },
      { kind: 'ftTransfers', signer: LLM, transfers: [{ receiverId: FUNDING, amount: 200n }] },
    ]);
    const [provider, third, llm] = chain.writes.map((write) => write.txHash);
    expect(returned).toEqual([
      { accountId: PROVIDER, amount: 540n, txHash: provider },
      { accountId: buyer(3), amount: 30n, txHash: third },
      { accountId: LLM, amount: 200n, txHash: llm },
    ]);
    expect([PROVIDER, buyer(3), LLM, buyer(5)].map((id) => chain.tokenBalances.get(id))).toEqual([10_000n, 10_000n, 10_000n, 9_000n]);
    expect(chain.tokenBalances.get(FUNDING)).toBe(1_000_770n);
  });

  it('logs one line for each transfer, with its transaction', async () => {
    await setUp();
    chain.register(PROVIDER, 10_540n);

    await reset();

    expect(lines).toEqual([`${PROVIDER}  returned 540 to ${FUNDING}  tx ${chain.writes[0]!.txHash}`]);
  });

  it('transfers nothing the second time in a row', async () => {
    await setUp();
    chain.register(PROVIDER, 10_540n);
    chain.register(buyer(12), 10_090n);
    await reset();
    const writes = chain.writes.length;
    lines = [];

    const returned = await reset();

    expect(returned).toEqual([]);
    expect(chain.writes).toHaveLength(writes);
    expect(lines).toEqual(['nothing to do']);
  });

  it('brings each account back to its own configured amount', async () => {
    config = testConfig({ credentialsDir: dir, buyerBudget: 5_000n, providerBonusFunds: 20_000n });
    await setUp();
    chain.register(PROVIDER, 20_500n);
    chain.register(buyer(1), 5_001n);
    chain.register(buyer(2), 10_000n);

    await reset();

    expect([PROVIDER, buyer(1), buyer(2)].map((id) => chain.tokenBalances.get(id))).toEqual([20_000n, 5_000n, 5_000n]);
  });

  it('leaves the funding account, the pools contract and the relayer as they are', async () => {
    await setUp();
    // Money an unresolved pool still holds, and tokens sent to the relayer.
    chain.register(POOLS, 50_000n);
    await account(RELAYER, 7n);

    expect(await reset()).toEqual([]);
    expect(chain.writes).toEqual([]);
  });

  it('reads no key file for an account that holds no more than its amount', async () => {
    await setUp();
    await rm(keyFilePath(dir, config.network, buyer(7)));
    chain.register(PROVIDER, 10_001n);

    expect(await reset()).toHaveLength(1);
  });

  it('stops with KeyFileError when an account to send from has no key file', async () => {
    await setUp();
    await rm(keyFilePath(dir, config.network, buyer(4)));
    chain.register(buyer(4), 10_400n);

    await expect(reset()).rejects.toMatchObject({ constructor: KeyFileError, problem: 'missing' });
    expect(chain.writes).toEqual([]);
  });

  it('says, when a transfer got no result, that reset can be run again once that transaction is final', async () => {
    await setUp();
    chain.register(PROVIDER, 10_540n);
    const unknown = new OutcomeUnknownError('a transaction from provider to token may have been sent, but the RPC gave no result (timeout): it may still run', null, 'timeout');
    chain.failWrite(() => true, unknown);

    const rejected = await reset().catch((e: unknown) => e);

    expect(rejected).toBeInstanceOf(OutcomeUnknownError);
    expect(rejected).toMatchObject({ txHash: null, cause: unknown });
    expect((rejected as Error).message).toBe(
      `${unknown.message}. Reset is idempotent: run it again once that transaction is final, and it sends only what is still above the amounts.`,
    );
  });

  it('checks the RPC’s chain against QUORUM_NETWORK before sending anything', async () => {
    await setUp();
    chain.register(PROVIDER, 10_540n);
    chain.nodeChainId = 'mainnet';

    await expect(reset()).rejects.toBeInstanceOf(ConfigError);
    expect(chain.writes).toEqual([]);
  });
});
