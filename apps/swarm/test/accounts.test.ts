import { describe, expect, it } from 'vitest';
import { buyerIds, isSubAccount, scriptedBuyerIds, swarmAccounts, type SwarmAccount } from '../src/accounts.ts';
import { loadSwarmConfig } from '../src/config.ts';

const PARENT = 'parent.testnet';
const NEAR = 1_000_000_000_000_000_000_000_000n;

describe('scriptedBuyerIds', () => {
  it('names the 20 scripted buyers buyer-01 to buyer-20 under the parent, in order', () => {
    const ids = scriptedBuyerIds(PARENT);
    expect(ids).toHaveLength(20);
    expect(ids.slice(0, 2)).toEqual(['buyer-01.parent.testnet', 'buyer-02.parent.testnet']);
    expect(ids.slice(8, 10)).toEqual(['buyer-09.parent.testnet', 'buyer-10.parent.testnet']);
    expect(ids.at(-1)).toBe('buyer-20.parent.testnet');
  });
});

describe('buyerIds', () => {
  it('lists the scripted buyers, then the MCP server buyer', () => {
    const config = loadSwarmConfig({ QUORUM_PARENT_ACCOUNT: PARENT, QUORUM_MCP_ACCOUNT: 'agent.other.testnet' });
    const ids = buyerIds(config);
    expect(ids).toHaveLength(21);
    expect(ids.slice(0, 20)).toEqual(scriptedBuyerIds(PARENT));
    expect(ids[20]).toBe('agent.other.testnet');
  });
});

describe('isSubAccount', () => {
  it.each([
    ['buyer-01.parent.testnet', true],
    ['parent.testnet', false],
    ['a.buyer-01.parent.testnet', false],
    ['xparent.testnet', false],
    ['parent.testnet.other', false],
    ['funding.near', false],
  ])('%s is a direct sub-account of parent.testnet: %s', (id, expected) => {
    expect(isSubAccount(id, PARENT)).toBe(expected);
  });
});

describe('swarmAccounts', () => {
  const config = loadSwarmConfig({ QUORUM_PARENT_ACCOUNT: PARENT, QUORUM_RELAYER_KEY_COUNT: '3' });
  const accounts = swarmAccounts(config);
  const byId = (id: string): SwarmAccount | undefined => accounts.find((account) => account.id === id);

  it('lists the funding account, the pools contract, the relayer, the provider, then the 21 buyers', () => {
    expect(accounts.map((account) => account.id)).toEqual([
      'funding.parent.testnet',
      'pools.parent.testnet',
      'relay.parent.testnet',
      'provider.parent.testnet',
      ...scriptedBuyerIds(PARENT),
      'buyer-llm.parent.testnet',
    ]);
  });

  it('gives each role its targets: NEAR for all, the token for the provider and the buyers', () => {
    expect(accounts.slice(0, 5)).toEqual<SwarmAccount[]>([
      { id: 'funding.parent.testnet', role: 'funding', create: true, keyCount: 1, near: NEAR / 2n, onToken: true, tokens: null },
      { id: 'pools.parent.testnet', role: 'pools', create: true, keyCount: 1, near: (NEAR * 7n) / 2n, onToken: true, tokens: null },
      { id: 'relay.parent.testnet', role: 'relayer', create: true, keyCount: 3, near: 3n * NEAR, onToken: false, tokens: null },
      { id: 'provider.parent.testnet', role: 'provider', create: true, keyCount: 1, near: NEAR / 2n, onToken: true, tokens: 10_000n },
      { id: 'buyer-01.parent.testnet', role: 'buyer', create: true, keyCount: 1, near: NEAR / 20n, onToken: true, tokens: 10_000n },
    ]);
    expect(byId('buyer-llm.parent.testnet')).toEqual<SwarmAccount>({
      id: 'buyer-llm.parent.testnet',
      role: 'buyer',
      create: true,
      keyCount: 1,
      near: NEAR / 20n,
      onToken: true,
      tokens: 10_000n,
    });
  });

  it('creates only the direct sub-accounts of the parent', () => {
    const outside = swarmAccounts(
      loadSwarmConfig({
        QUORUM_PARENT_ACCOUNT: PARENT,
        QUORUM_FUNDING_ACCOUNT: 'treasury.testnet',
        QUORUM_MCP_ACCOUNT: 'llm.agents.parent.testnet',
      }),
    );
    const created = (id: string): boolean | undefined => outside.find((account) => account.id === id)?.create;
    expect(created('treasury.testnet')).toBe(false);
    expect(created('llm.agents.parent.testnet')).toBe(false);
    expect(created('provider.parent.testnet')).toBe(true);
  });

  it('tops up a funding account outside the parent, but never the parent itself', () => {
    const outside = swarmAccounts(loadSwarmConfig({ QUORUM_PARENT_ACCOUNT: PARENT, QUORUM_FUNDING_ACCOUNT: 'treasury.testnet' }));
    expect(outside[0]).toMatchObject({ id: 'treasury.testnet', create: false, near: NEAR / 2n, onToken: true });
    const parent = swarmAccounts(loadSwarmConfig({ QUORUM_PARENT_ACCOUNT: PARENT, QUORUM_FUNDING_ACCOUNT: PARENT }));
    expect(parent[0]).toMatchObject({ id: PARENT, role: 'funding', create: false, near: null, onToken: true });
  });

  it("reads each target from the configuration", () => {
    const custom = swarmAccounts(
      loadSwarmConfig({
        QUORUM_PARENT_ACCOUNT: PARENT,
        QUORUM_BUYER_NEAR: '0.1',
        QUORUM_PROVIDER_NEAR: '0.2',
        QUORUM_FUNDING_NEAR: '0.3',
        QUORUM_RELAYER_NEAR: '0.4',
        QUORUM_POOLS_NEAR: '0.6',
        QUORUM_BUYER_BUDGET: '700',
        QUORUM_PROVIDER_BONUS_FUNDS: '800',
      }),
    );
    expect(custom.map((account) => [account.role, account.near, account.tokens]).slice(0, 5)).toEqual([
      ['funding', (NEAR * 3n) / 10n, null],
      ['pools', (NEAR * 6n) / 10n, null],
      ['relayer', (NEAR * 4n) / 10n, null],
      ['provider', (NEAR * 2n) / 10n, 800n],
      ['buyer', NEAR / 10n, 700n],
    ]);
  });
});
