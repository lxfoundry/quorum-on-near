import { JsonRpcProvider, KeyPair } from 'near-api-js';
import type { Provider } from 'near-api-js';
import { AccessKeyDoesNotExistError, AccountDoesNotExistError, UnknownBlockError } from 'near-api-js/rpc-errors';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RpcChain } from '../src/rpc-chain.ts';
import { PARENT, POOLS, poolView, TOKEN } from './fake-chain.ts';

const BUYER = `buyer-01.${PARENT}`;
const OPTIMISTIC = { finality: 'optimistic' };
const FINAL = { finality: 'final' };

/** What the fake answers: a view result, an access key (or the error to throw), a block. */
interface Answers {
  view?: unknown;
  accessKey?: () => unknown;
  block?: unknown;
}

/** An RpcChain over a fake Provider that has only the methods RpcChain calls, recording each call. */
function setup(answers: Answers = {}) {
  const calls: Array<[method: string, params: unknown]> = [];
  const provider = {
    async callFunction(params: unknown) {
      calls.push(['callFunction', params]);
      return answers.view;
    },
    async viewAccessKey(params: unknown) {
      calls.push(['viewAccessKey', params]);
      return answers.accessKey?.();
    },
    async viewBlock(blockQuery: unknown) {
      calls.push(['viewBlock', blockQuery]);
      return answers.block;
    },
  };
  const chain = new RpcChain({ provider: provider as unknown as Provider, poolsContract: POOLS, token: TOKEN });
  return { chain, calls };
}

const publicKey = () => KeyPair.fromRandom('ed25519').getPublicKey();

describe('RpcChain views', () => {
  const views: Array<{
    name: string;
    read: (chain: RpcChain) => Promise<unknown>;
    answer: unknown;
    contractId: string;
    method: string;
    args: Record<string, unknown>;
  }> = [
    {
      name: 'getPool',
      read: (c) => c.getPool(7),
      answer: poolView(),
      contractId: POOLS,
      method: 'get_pool',
      args: { pool_id: 7 },
    },
    {
      name: 'listPools',
      read: (c) => c.listPools(3, 100),
      answer: [],
      contractId: POOLS,
      method: 'list_pools',
      args: { from: 3, limit: 100 },
    },
    {
      name: 'getBuyer',
      read: (c) => c.getBuyer(7, BUYER),
      answer: null,
      contractId: POOLS,
      method: 'get_buyer',
      args: { pool_id: 7, account_id: BUYER },
    },
    {
      name: 'ftBalanceOf',
      read: (c) => c.ftBalanceOf(BUYER),
      answer: '0',
      contractId: TOKEN,
      method: 'ft_balance_of',
      args: { account_id: BUYER },
    },
    {
      name: 'getToken',
      read: (c) => c.getToken(),
      answer: TOKEN,
      contractId: POOLS,
      method: 'get_token',
      args: {},
    },
  ];

  for (const { name, read, answer, contractId, method, args } of views) {
    it(`${name} calls ${method} at optimistic finality`, async () => {
      const { chain, calls } = setup({ view: answer });
      await read(chain);
      expect(calls).toEqual([['callFunction', { contractId, method, args, blockQuery: OPTIMISTIC }]]);
    });
  }

  it('getPool returns the view of the pool', async () => {
    const { chain } = setup({ view: poolView() });
    expect(await chain.getPool(7)).toEqual(poolView());
  });

  it('getPool returns null for a pool the contract does not know', async () => {
    const { chain } = setup({ view: null });
    expect(await chain.getPool(99)).toBeNull();
  });

  it('listPools returns the rows of list_pools', async () => {
    const rows = [poolView({ id: 3 }), poolView({ id: 4 })];
    const { chain } = setup({ view: rows });
    expect(await chain.listPools(3, 100)).toEqual(rows);
  });

  it('getBuyer returns the view of the buyer', async () => {
    const { chain } = setup({ view: { seats: 2, state: 'committed' } });
    expect(await chain.getBuyer(7, BUYER)).toEqual({ seats: 2, state: 'committed' });
  });

  it('getBuyer returns null for an account that holds no seats in the pool', async () => {
    const { chain } = setup({ view: null });
    expect(await chain.getBuyer(7, BUYER)).toBeNull();
  });

  it('ftBalanceOf returns the balance as a bigint', async () => {
    const { chain } = setup({ view: '12345678901234567890' });
    expect(await chain.ftBalanceOf(BUYER)).toBe(12_345_678_901_234_567_890n);
  });

  it('ftBalanceOf throws when the token returns something other than a decimal string', async () => {
    const { chain } = setup({ view: 42 });
    await expect(chain.ftBalanceOf(BUYER)).rejects.toThrow(TypeError);
  });

  it('getToken returns the account id of the token', async () => {
    const { chain } = setup({ view: TOKEN });
    expect(await chain.getToken()).toBe(TOKEN);
  });

  it('getToken throws when the view returns something other than a string', async () => {
    const { chain } = setup({ view: undefined });
    await expect(chain.getToken()).rejects.toThrow(TypeError);
  });
});

describe('RpcChain.accessKey', () => {
  it('asks for the key of the account at optimistic finality', async () => {
    const key = publicKey().toString();
    const { chain, calls } = setup({ accessKey: () => ({ nonce: 1n, permission: 'FullAccess' }) });
    await chain.accessKey(BUYER, key);
    expect(calls).toEqual([['viewAccessKey', { accountId: BUYER, publicKey: key, finalityQuery: OPTIMISTIC }]]);
  });

  it('reports a full-access key with its nonce', async () => {
    const view = { nonce: 244_990_000_000_007n, permission: 'FullAccess', block_height: 245_000_100 };
    const { chain } = setup({ accessKey: () => view });
    const key = await chain.accessKey(BUYER, publicKey().toString());
    expect(key).toEqual({ nonce: 244_990_000_000_007n, fullAccess: true });
  });

  it('reports a function-call key as not full access', async () => {
    const permission = {
      FunctionCall: { allowance: '250000000000000000000000', method_names: [], receiver_id: POOLS },
    };
    const { chain } = setup({ accessKey: () => ({ nonce: 5n, permission }) });
    expect(await chain.accessKey(BUYER, publicKey().toString())).toEqual({ nonce: 5n, fullAccess: false });
  });

  it('returns null when the account has no such key', async () => {
    const key = publicKey();
    const { chain } = setup({
      accessKey: () => {
        throw new AccessKeyDoesNotExistError(key, 'FakeBkHash', 245_000_100);
      },
    });
    expect(await chain.accessKey(BUYER, key.toString())).toBeNull();
  });

  it('returns null when the account does not exist', async () => {
    const { chain } = setup({
      accessKey: () => {
        throw new AccountDoesNotExistError(BUYER, 'FakeBkHash', 245_000_100);
      },
    });
    expect(await chain.accessKey(BUYER, publicKey().toString())).toBeNull();
  });

  it('rethrows any other RPC error', async () => {
    const { chain } = setup({
      accessKey: () => {
        throw new UnknownBlockError();
      },
    });
    await expect(chain.accessKey(BUYER, publicKey().toString())).rejects.toBeInstanceOf(UnknownBlockError);
  });
});

describe('RpcChain.finalBlock', () => {
  const block = {
    author: 'validator.testnet',
    chunks: [],
    header: { height: 245_000_100, timestamp_nanosec: '1799999000123999999' },
  };

  it('asks for the block at final finality', async () => {
    const { chain, calls } = setup({ block });
    await chain.finalBlock();
    expect(calls).toEqual([['viewBlock', FINAL]]);
  });

  it('returns the height of the block as a bigint', async () => {
    const { chain } = setup({ block });
    expect((await chain.finalBlock()).height).toBe(245_000_100n);
  });

  it('converts timestamp_nanosec to milliseconds, rounding down as the contract does', async () => {
    const { chain } = setup({ block });
    expect((await chain.finalBlock()).timestampMs).toBe(1_799_999_000_123);
  });
});

describe('RpcChain over JsonRpcProvider', () => {
  interface RpcRequest {
    id: string;
    method: string;
    params: Record<string, unknown>;
  }

  /** An RpcChain over a JsonRpcProvider whose fetch records each request and answers it with `reply`. */
  function stubRpc(reply: { result: unknown } | { error: unknown }) {
    const requests: RpcRequest[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
      const request = JSON.parse(init.body) as RpcRequest;
      requests.push(request);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, ...reply }), { status: 200 });
    });
    const provider = new JsonRpcProvider({ url: 'http://rpc.invalid' });
    return { chain: new RpcChain({ provider, poolsContract: POOLS, token: TOKEN }), requests };
  }

  const handlerError = (cause: unknown) => ({
    error: { name: 'HANDLER_ERROR', cause, code: -32000, message: 'Server error' },
  });
  const AT = { block_height: 245_000_100, block_hash: 'FakeBkHash' };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends a view as a call_function query at optimistic finality', async () => {
    const result = Array.from(new TextEncoder().encode(JSON.stringify(TOKEN)));
    const { chain, requests } = stubRpc({ result: { result, logs: [], ...AT } });
    await chain.getToken();
    expect(requests.map((r) => [r.method, r.params])).toEqual([
      [
        'query',
        {
          request_type: 'call_function',
          account_id: POOLS,
          method_name: 'get_token',
          args_base64: 'e30=',
          finality: 'optimistic',
        },
      ],
    ]);
  });

  it('sends an access-key read as a view_access_key query at optimistic finality', async () => {
    const key = publicKey().toString();
    const { chain, requests } = stubRpc({ result: { nonce: 5, permission: 'FullAccess', ...AT } });
    await chain.accessKey(BUYER, key);
    expect(requests.map((r) => [r.method, r.params])).toEqual([
      ['query', { request_type: 'view_access_key', account_id: BUYER, public_key: key, finality: 'optimistic' }],
    ]);
  });

  it('requests the block at final finality', async () => {
    const header = { height: 245_000_100, timestamp_nanosec: '1799999000123999999' };
    const { chain, requests } = stubRpc({ result: { author: 'validator.testnet', chunks: [], header } });
    await chain.finalBlock();
    expect(requests.map((r) => [r.method, r.params])).toEqual([['block', FINAL]]);
  });

  it("returns null for the RPC's UNKNOWN_ACCESS_KEY error", async () => {
    const key = publicKey().toString();
    const info = { public_key: key, ...AT };
    const { chain } = stubRpc(handlerError({ name: 'UNKNOWN_ACCESS_KEY', info }));
    expect(await chain.accessKey(BUYER, key)).toBeNull();
  });

  it("returns null for the RPC's UNKNOWN_ACCOUNT error", async () => {
    const info = { requested_account_id: BUYER, ...AT };
    const { chain } = stubRpc(handlerError({ name: 'UNKNOWN_ACCOUNT', info }));
    expect(await chain.accessKey(BUYER, publicKey().toString())).toBeNull();
  });
});
