import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.ts';
import { cachePageViews } from '../src/page-view-cache.ts';
import { ViewCache } from '../src/view-cache.ts';
import { POOLS, TOKEN, testConfig } from './fake-chain.ts';
import { testDeps } from './handler-deps.ts';

/** Block hashes as the RPC writes them: 32 bytes in base58. */
const HASH_A = 'BiYu6VhuNTBYqdoibhzY8E5qYJ8KbmQJjCxZjjbDa8Lb';
const HASH_B = 'CGPSr2jifA873SrCkb9X1VNRsfC9dR28NDTZjgYGJokF';
const FINAL = { finality: 'final' };

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * A JSON-RPC `call_function` view as the live page sends it. `args` is encoded as JSON, or taken as
 * the JSON text to encode when it is a string.
 */
function viewCall(id: string | number, account: string, method: string, args: unknown, block: Record<string, unknown>) {
  const json = typeof args === 'string' ? args : JSON.stringify(args);
  return {
    jsonrpc: '2.0',
    id,
    method: 'query',
    params: {
      request_type: 'call_function',
      account_id: account,
      method_name: method,
      args_base64: Buffer.from(json).toString('base64'),
      ...block,
    },
  };
}

/** The live page's `get_pool` of pool 7 at final finality. */
function getPool(id: string | number) {
  return viewCall(id, POOLS, 'get_pool', { pool_id: 7 }, FINAL);
}

/** A view result as the RPC answers it, read at block `height`, with the JSON-RPC id `id`. */
function viewResult(height: number, id: string | number = 'rpc') {
  return { jsonrpc: '2.0', id, result: { result: [123], logs: [], block_height: height, block_hash: HASH_B } };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/**
 * An RPC that answers every request with a view result at the next block (heights 1001, 1002, …),
 * so that a test can tell its reads apart, and with an id of its own, so that a test can tell when
 * the forward set the caller's.
 */
function rpc() {
  let height = 1000;
  return vi.fn<typeof fetch>(async () => {
    height += 1;
    return json(viewResult(height));
  });
}

/** The app with the RPC pass-through on, over `fetch`. */
async function passthrough(fetch: typeof globalThis.fetch): Promise<Hono> {
  const deps = await testDeps({ config: testConfig({ rpcPassthrough: true }) });
  return createApp(deps, { fetch });
}

async function post(app: Hono, body: unknown): Promise<{ status: number; body: unknown }> {
  const res = await app.request('/rpc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

/** The cache's clock (`performance.now`), which tests move by hand. */
let clock: number;

beforeEach(() => {
  clock = 1_000;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('POST /rpc page views', () => {
  it.each([
    ['list_pools at final finality', POOLS, 'list_pools', { from: 0, limit: 100 }, FINAL],
    ['get_pool at final finality', POOLS, 'get_pool', { pool_id: 7 }, FINAL],
    ['get_seats at a block hash', POOLS, 'get_seats', { pool_id: 7, from: 0, limit: 100 }, { block_id: HASH_A }],
    ['get_seats at a block hash of 32 characters', POOLS, 'get_seats', { pool_id: 7, from: 0, limit: 100 }, { block_id: '1'.repeat(32) }],
    ["the token's ft_balance_of at a block hash", TOKEN, 'ft_balance_of', { account_id: POOLS }, { block_id: HASH_A }],
  ])("answers a repeated %s from one RPC read, with each caller's id", async (_name, account, method, args, block) => {
    const fetch = rpc();
    const app = await passthrough(fetch);
    const first = await post(app, viewCall(1, account, method, args, block));
    clock += 1_999;
    const second = await post(app, viewCall('tab-2', account, method, args, block));
    expect(fetch).toHaveBeenCalledOnce();
    expect(first).toEqual({ status: 200, body: viewResult(1001, 1) });
    expect(second).toEqual({ status: 200, body: viewResult(1001, 'tab-2') });
  });

  it('reads the RPC again 2 seconds after its read was sent, and once the clock has gone back', async () => {
    const fetch = rpc();
    const app = await passthrough(fetch);
    await post(app, getPool(1));
    clock = 1_000 + 1_999;
    expect(await post(app, getPool(2))).toEqual({ status: 200, body: viewResult(1001, 2) });
    clock = 1_000 + 2_000;
    expect(await post(app, getPool(3))).toEqual({ status: 200, body: viewResult(1002, 3) });
    clock = 1_000 + 1_999;
    expect(await post(app, getPool(4))).toEqual({ status: 200, body: viewResult(1003, 4) });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('shares one RPC read between the requests that ask while it is in flight, each answered with its own id', async () => {
    const answer = deferred<Response>();
    const fetch = vi.fn<typeof globalThis.fetch>(() => answer.promise);
    const asked = vi.spyOn(ViewCache.prototype, 'get');
    const app = await passthrough(fetch);
    const answers = [1, 2, 3].map((id) => post(app, getPool(id)));
    // Every request has reached the cache before the RPC answers.
    await vi.waitFor(() => expect(asked).toHaveBeenCalledTimes(3));
    answer.resolve(json(viewResult(1001)));
    expect(await Promise.all(answers)).toEqual([1, 2, 3].map((id) => ({ status: 200, body: viewResult(1001, id) })));
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('answers 503 chain_unavailable to every request that shared a read that failed, logs each once, and stores nothing', async () => {
    const answer = deferred<Response>();
    const failure = new TypeError('fetch failed');
    const fetch = vi.fn<typeof globalThis.fetch>().mockReturnValueOnce(answer.promise);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const asked = vi.spyOn(ViewCache.prototype, 'get');
    const app = await passthrough(fetch);
    const answers = [1, 2].map((id) => post(app, getPool(id)));
    await vi.waitFor(() => expect(asked).toHaveBeenCalledTimes(2));
    answer.reject(failure);
    const unavailable = { status: 503, body: { error: 'chain_unavailable' } };
    expect(await Promise.all(answers)).toEqual([unavailable, unavailable]);
    expect(fetch).toHaveBeenCalledOnce();
    expect(logged.mock.calls).toEqual([
      [expect.any(String), failure],
      [expect.any(String), failure],
    ]);
    fetch.mockResolvedValueOnce(json(viewResult(1002)));
    expect(await post(app, getPool(3))).toEqual({ status: 200, body: viewResult(1002, 3) });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    [
      'a 429 with a JSON-RPC error',
      429,
      (id: string | number) => ({ jsonrpc: '2.0', id, error: { code: -429, message: 'rate limited' } }),
    ],
    ['a 429 that is not a JSON-RPC answer', 429, () => ({ error: 'rate limited' })],
    [
      'a 408',
      408,
      (id: string | number) => ({ jsonrpc: '2.0', id, error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_BLOCK' } } }),
    ],
    ['a 500', 500, (id: string | number) => ({ jsonrpc: '2.0', id, error: { name: 'INTERNAL_ERROR' } })],
    ['a view result at a status other than 200', 500, (id: string | number) => viewResult(1001, id)],
    [
      'a JSON-RPC error',
      200,
      (id: string | number) => ({ jsonrpc: '2.0', id, error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_ACCOUNT' } } }),
    ],
    [
      'an error of the contract',
      200,
      (id: string | number) => ({
        jsonrpc: '2.0',
        id,
        result: { error: 'wasm execution failed with error: pool 7 does not exist', logs: [], block_height: 1001, block_hash: HASH_B },
      }),
    ],
    [
      'a JSON-RPC error beside a result',
      200,
      (id: string | number) => ({ ...viewResult(1001, id), error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_BLOCK' } } }),
    ],
    [
      'an error of the contract beside result bytes',
      200,
      (id: string | number) => ({
        jsonrpc: '2.0',
        id,
        result: { error: 'wasm execution failed', result: [123], logs: [], block_height: 1001, block_hash: HASH_B },
      }),
    ],
    [
      'a result with no bytes',
      200,
      (id: string | number) => ({ jsonrpc: '2.0', id, result: { logs: [], block_height: 1001, block_hash: HASH_B } }),
    ],
    [
      'a result with no block hash',
      200,
      (id: string | number) => ({ jsonrpc: '2.0', id, result: { result: [123], logs: [], block_height: 1001 } }),
    ],
    [
      'a result that is not a JSON-RPC answer',
      200,
      () => ({ result: { result: [123], logs: [], block_height: 1001, block_hash: HASH_B } }),
    ],
  ])('stores no answer that is %s, and gives it to each caller at its status, with its own id', async (_name, status, answer) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json(answer('rpc'), status));
    const app = await passthrough(fetch);
    expect(await post(app, getPool(1))).toEqual({ status, body: answer(1) });
    expect(await post(app, getPool(2))).toEqual({ status, body: answer(2) });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('answers 503 chain_unavailable to an answer that is not JSON, logs it once per request, and stores nothing', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response('Too Many Requests', { status: 429 }));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = await passthrough(fetch);
    const unavailable = { status: 503, body: { error: 'chain_unavailable' } };
    expect(await post(app, getPool(1))).toEqual(unavailable);
    expect(await post(app, getPool(2))).toEqual(unavailable);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(logged.mock.calls).toEqual([
      [expect.any(String), expect.any(SyntaxError)],
      [expect.any(String), expect.any(SyntaxError)],
    ]);
  });

  it.each([
    ['get_pool at optimistic finality', POOLS, 'get_pool', { pool_id: 7 }, { finality: 'optimistic' }],
    ['get_pool at a finality that means nothing', POOLS, 'get_pool', { pool_id: 7 }, { finality: 'whatever' }],
    ['get_pool on the token', TOKEN, 'get_pool', { pool_id: 7 }, FINAL],
    ['get_buyer at final finality', POOLS, 'get_buyer', { pool_id: 7, account_id: 'buyer.testnet' }, FINAL],
    ["the token's ft_metadata", TOKEN, 'ft_metadata', {}, FINAL],
    ['ft_balance_of at final finality', TOKEN, 'ft_balance_of', { account_id: POOLS }, FINAL],
    ['get_pool at a block hash', POOLS, 'get_pool', { pool_id: 7 }, { block_id: HASH_A }],
    ['get_seats at a block height', POOLS, 'get_seats', { pool_id: 7, from: 0, limit: 100 }, { block_id: 1000 }],
    ['get_seats at a block id of 31 characters', POOLS, 'get_seats', { pool_id: 7, from: 0, limit: 100 }, { block_id: '1'.repeat(31) }],
    ['get_seats at a block id of 45 characters', POOLS, 'get_seats', { pool_id: 7, from: 0, limit: 100 }, { block_id: 'z'.repeat(45) }],
    ['get_seats at a block id that is not base58', POOLS, 'get_seats', { pool_id: 7, from: 0, limit: 100 }, { block_id: `0${HASH_A.slice(1)}` }],
    ['get_seats on the token', TOKEN, 'get_seats', { pool_id: 7, from: 0, limit: 100 }, { block_id: HASH_A }],
    ['ft_balance_of on the pools contract', POOLS, 'ft_balance_of', { account_id: POOLS }, { block_id: HASH_A }],
  ])('forwards %s every time as it came, and answers what the RPC answered', async (_name, account, method, args, block) => {
    const fetch = rpc();
    const app = await passthrough(fetch);
    const calls = [viewCall(1, account, method, args, block), viewCall(2, account, method, args, block)];
    expect(await post(app, calls[0])).toEqual({ status: 200, body: viewResult(1001) });
    expect(await post(app, calls[1])).toEqual({ status: 200, body: viewResult(1002) });
    expect(fetch.mock.calls.map(([, init]) => init?.body)).toEqual(calls.map((call) => JSON.stringify(call)));
  });

  it('keeps views apart by block, account, method and arguments', async () => {
    const fetch = rpc();
    const app = await passthrough(fetch);
    const seats = { pool_id: 7, from: 0, limit: 100 };
    const calls = [
      viewCall(1, POOLS, 'get_pool', { pool_id: 7 }, FINAL),
      viewCall(1, POOLS, 'get_pool', { pool_id: 8 }, FINAL),
      // The same arguments as the first, for another method.
      viewCall(1, POOLS, 'list_pools', { pool_id: 7 }, FINAL),
      // The same arguments as the first, written another way.
      viewCall(1, POOLS, 'get_pool', '{ "pool_id": 7 }', FINAL),
      viewCall(1, POOLS, 'get_seats', seats, { block_id: HASH_A }),
      viewCall(1, POOLS, 'get_seats', seats, { block_id: HASH_B }),
      viewCall(1, TOKEN, 'ft_balance_of', { account_id: POOLS }, { block_id: HASH_A }),
      viewCall(1, TOKEN, 'ft_balance_of', { account_id: POOLS }, { block_id: HASH_B }),
    ];
    const first: { status: number; body: unknown }[] = [];
    for (const call of calls) first.push(await post(app, call));
    expect(first).toEqual(calls.map((_call, i) => ({ status: 200, body: viewResult(1001 + i, 1) })));
    for (const [i, call] of calls.entries()) expect(await post(app, call)).toEqual(first[i]);
    expect(fetch).toHaveBeenCalledTimes(calls.length);
  });

  it('answers 403 not_allowed from the checks in front of the cache, after the same view was stored', async () => {
    const fetch = rpc();
    const app = await passthrough(fetch);
    const call = getPool(1);
    await post(app, call);
    const refused = { status: 403, body: { error: 'not_allowed' } };
    expect(await post(app, { ...call, params: { ...call.params, extra: true } })).toEqual(refused);
    expect(await post(app, { ...call, method: 'send_tx' })).toEqual(refused);
    expect(fetch).toHaveBeenCalledOnce();
  });
});

describe('cachePageViews', () => {
  const RPC_URL = 'http://rpc.invalid';
  const stored = JSON.stringify(getPool(1));

  it.each([
    ['a body that is not a string', { method: 'POST', body: new TextEncoder().encode(stored) }],
    ['a body that is not JSON', { method: 'POST', body: `${stored}}` }],
    [
      'a body the pass-through refuses',
      { method: 'POST', body: JSON.stringify({ ...getPool(1), params: { ...getPool(1).params, request_type: 'view_account' } }) },
    ],
  ])('passes %s to the inner fetch as it came, and answers what it answered, even with the view stored', async (_name, init) => {
    const inner = rpc();
    const forward = cachePageViews(inner, { poolsContract: POOLS, token: TOKEN });
    await forward(RPC_URL, { method: 'POST', body: stored });
    const first = await forward(RPC_URL, init);
    const second = await forward(RPC_URL, init);
    expect(inner).toHaveBeenCalledTimes(3);
    expect(inner.mock.calls.slice(1)).toEqual([
      [RPC_URL, init],
      [RPC_URL, init],
    ]);
    expect(inner.mock.calls[1]?.[1]).toBe(init);
    expect(first).toBe(await inner.mock.results[1]?.value);
    expect(second).toBe(await inner.mock.results[2]?.value);
  });
});
