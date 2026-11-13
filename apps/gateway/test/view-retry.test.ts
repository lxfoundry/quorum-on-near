import { JsonRpcProvider, KeyPair } from 'near-api-js';
import { AccessKeyDoesNotExistError } from 'near-api-js/rpc-errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RpcChain } from '../src/rpc-chain.ts';
import { retryViewsOn429, VIEW_RETRY_WAITS_MS, type ViewProvider } from '../src/view-retry.ts';
import { POOLS, TOKEN } from './fake-chain.ts';

/** What near-api-js 7.4.0 throws when the RPC answers HTTP 429: an Error whose cause is the status. */
const tooManyRequests = () => new Error('Too Many Requests', { cause: 429 });

const VIEW_METHODS = ['callFunction', 'viewAccessKey', 'viewBlock', 'viewNodeStatus'] as const;
type ViewMethod = (typeof VIEW_METHODS)[number];

/** The arguments each method is called with: one object, so a test can check it is passed on as it is. */
const ARGS: Record<ViewMethod, unknown[]> = {
  callFunction: [{ contractId: POOLS, method: 'get_pool', args: { pool_id: 1 }, blockQuery: { finality: 'optimistic' } }],
  viewAccessKey: [{ accountId: 'buyer.testnet', publicKey: 'ed25519:Fake', finalityQuery: { finality: 'optimistic' } }],
  viewBlock: [{ finality: 'final' }],
  viewNodeStatus: [],
};

// The fake clock: each wait moves it, and no test waits for real.
let clock: number;
let waits: number[];
const sleep = async (ms: number) => {
  waits.push(ms);
  clock += ms;
};

beforeEach(() => {
  clock = 0;
  waits = [];
});

/**
 * A view provider whose `method` throws each of `errors` in turn, then answers `answer`. Its other
 * methods fail the test if they are called.
 */
function fakeViews(method: ViewMethod, errors: unknown[], answer: unknown = { answeredBy: method }) {
  const unexpected = (name: string) => vi.fn(async () => expect.fail(`${name} was called`));
  const fake: Record<ViewMethod, ReturnType<typeof vi.fn>> = {
    callFunction: unexpected('callFunction'),
    viewAccessKey: unexpected('viewAccessKey'),
    viewBlock: unexpected('viewBlock'),
    viewNodeStatus: unexpected('viewNodeStatus'),
  };
  const view = vi.fn();
  for (const error of errors) view.mockRejectedValueOnce(error);
  view.mockResolvedValue(answer);
  fake[method] = view;
  return { inner: fake as unknown as ViewProvider, view };
}

/** Calls `method` on `provider` with that method's ARGS. */
function callView(provider: ViewProvider, method: ViewMethod): Promise<unknown> {
  return (provider[method] as (...args: unknown[]) => Promise<unknown>)(...ARGS[method]);
}

describe('retryViewsOn429', () => {
  it('waits 200, 400 and 800 ms before the three retries, before jitter', () => {
    expect(VIEW_RETRY_WAITS_MS).toEqual([200, 400, 800]);
  });

  it.each(VIEW_METHODS)('tries %s again after HTTP 429 and returns its answer as it is', async (method) => {
    const answer = { answeredBy: method };
    const { inner, view } = fakeViews(method, [tooManyRequests(), tooManyRequests()], answer);
    const views = retryViewsOn429(inner, { sleep, random: () => 0 });

    await expect(callView(views, method)).resolves.toBe(answer);
    expect(view).toHaveBeenCalledTimes(3);
    for (const call of view.mock.calls) {
      expect(call).toHaveLength(ARGS[method].length);
      call.forEach((arg, i) => expect(arg).toBe(ARGS[method][i]));
    }
    expect(waits).toEqual([200, 400]);
  });

  it('rethrows the last 429 unchanged once the three retries are spent', async () => {
    const errors = [tooManyRequests(), tooManyRequests(), tooManyRequests(), new Error('Slow down', { cause: 429 })];
    const { inner, view } = fakeViews('callFunction', errors);
    const views = retryViewsOn429(inner, { sleep, random: () => 0 });

    const thrown = await callView(views, 'callFunction').catch((error: unknown) => error);
    expect(thrown).toBe(errors[3]);
    expect(thrown).toMatchObject({ message: 'Slow down', cause: 429 });
    expect(view).toHaveBeenCalledTimes(4);
    expect(waits).toEqual([200, 400, 800]);
  });

  it.each([
    ['an HTTP 503 near-api-js has already retried', new Error('http://rpc.invalid unavailable', { cause: 503 })],
    ['an HTTP 502', new Error('http://rpc.invalid Bad Gateway', { cause: 502 })],
    ['a 429 status that is not a number', new Error('Too Many Requests', { cause: '429' })],
    ['an RPC error', new AccessKeyDoesNotExistError(KeyPair.fromRandom('ed25519').getPublicKey(), 'FakeBkHash', 245_000_100)],
    ['a network failure', new TypeError('fetch failed')],
    ['something thrown that is not an Error', { cause: 429 }],
  ])('rethrows %s at once, without waiting', async (_name, error) => {
    const { inner, view } = fakeViews('viewBlock', [error]);
    const views = retryViewsOn429(inner, { sleep, random: () => 0 });

    await expect(callView(views, 'viewBlock')).rejects.toBe(error);
    expect(view).toHaveBeenCalledTimes(1);
    expect(waits).toEqual([]);
  });

  it('stretches each wait by up to half again, from random()', async () => {
    const randoms = [0.5, 0, 0.999_999];
    const errors = [tooManyRequests(), tooManyRequests(), tooManyRequests()];
    const { inner } = fakeViews('viewNodeStatus', errors);
    const views = retryViewsOn429(inner, { sleep, random: () => randoms.shift() ?? expect.fail('random() called too often') });

    await callView(views, 'viewNodeStatus');
    expect(waits).toEqual([250, 400, 800 * (1 + 0.999_999 / 2)]);
    // At most three retries, and under 2.1 s of waiting in all.
    expect(clock).toBeLessThan(2_100);
  });

  it('waits at least 1.4 s in all before its last attempt', async () => {
    const { inner } = fakeViews('viewBlock', [tooManyRequests(), tooManyRequests(), tooManyRequests()]);
    await callView(retryViewsOn429(inner, { sleep, random: () => 0 }), 'viewBlock');
    expect(clock).toBe(1_400);
  });

  it('has the four view methods only, so nothing can send a transaction through it', () => {
    const views = retryViewsOn429(new JsonRpcProvider({ url: 'http://rpc.invalid' }), { sleep });

    expect(Object.keys(views).sort()).toEqual([...VIEW_METHODS].sort());
    for (const send of ['sendTransaction', 'sendTransactionUntil', 'sendTransactionAsync', 'sendJsonRpc']) {
      expect(send in views).toBe(false);
    }
    // @ts-expect-error: a ViewProvider has no method that sends.
    expect(views.sendTransactionUntil).toBeUndefined();
  });
});

describe('retryViewsOn429 over JsonRpcProvider, under RpcChain', () => {
  interface RpcRequest {
    id: string;
    method: string;
    params: Record<string, unknown>;
  }

  const TOKEN_VIEW = {
    result: Array.from(new TextEncoder().encode(JSON.stringify(TOKEN))),
    logs: [],
    block_height: 245_000_100,
    block_hash: 'FakeBkHash',
  };

  /**
   * An RpcChain over retryViewsOn429 over a JsonRpcProvider, as main.ts builds it. The RPC answers
   * the first `refusals` posts with HTTP `status` and a text body, then a `get_token` result.
   */
  function stubRpc(refusals: number, status = 429, providerOptions?: { retries: number }) {
    const requests: RpcRequest[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
      const request = JSON.parse(init.body) as RpcRequest;
      requests.push(request);
      if (requests.length <= refusals) return new Response('Too Many Requests', { status });
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: TOKEN_VIEW }), { status: 200 });
    });
    const provider = new JsonRpcProvider({ url: 'http://rpc.invalid' }, providerOptions);
    const views = retryViewsOn429(provider, { sleep, random: () => 0 });
    return { chain: new RpcChain({ provider: views, poolsContract: POOLS, token: TOKEN }), requests };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts a view again after each 429, the same query each time, and answers with the result', async () => {
    const { chain, requests } = stubRpc(2);

    await expect(chain.getToken()).resolves.toBe(TOKEN);
    expect(requests).toHaveLength(3);
    expect(new Set(requests.map((r) => r.method))).toEqual(new Set(['query']));
    expect(requests[1]?.params).toEqual(requests[0]?.params);
    expect(requests[2]?.params).toEqual(requests[0]?.params);
    expect(waits).toEqual([200, 400]);
  });

  it("gives up after four posts with near-api-js's own error: cause 429, the body as message", async () => {
    const { chain, requests } = stubRpc(Infinity);

    const thrown = await chain.getToken().catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).toMatchObject({ message: 'Too Many Requests', cause: 429 });
    expect(requests).toHaveLength(4);
    expect(waits).toEqual([200, 400, 800]);
  });

  it('does not post again after HTTP 503 once near-api-js has given up on it', async () => {
    // `retries: 1` stops near-api-js from waiting between its own 503 attempts.
    const { chain, requests } = stubRpc(Infinity, 503, { retries: 1 });

    await expect(chain.getToken()).rejects.toMatchObject({ cause: 503 });
    expect(requests).toHaveLength(1);
    expect(waits).toEqual([]);
  });
});
