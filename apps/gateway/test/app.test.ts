import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  PAYMENT_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PROOF_HEADER,
  buildOffer,
  buildPaymentHeader,
  buildRedeemProofHeader,
  decodeHeader,
  maxBlockHeightFor,
  paymentRequired,
  type ExpectedOffer,
} from '@quorum-on-near/protocol';
import { KeyPair } from 'near-api-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActivityRecord } from '../src/activity.ts';
import { createApp } from '../src/app.ts';
import type { GatewayConfig } from '../src/config.ts';
import type { Deps } from '../src/deps.ts';
import { offerContext } from '../src/handle-offer.ts';
import { NOW_MS, POOLS, PROVIDER, TERMS, TOKEN, commitOutcome, poolView, testConfig, type FakeChain } from './fake-chain.ts';
import { testDeps } from './handler-deps.ts';

const BUYER = 'buyer.testnet';
const POOL_ID = 7;
const TX_HASH = 'RelayTx111';
const DEADLINE_MS = 1_800_000_000_000;
/**
 * The buyer's own configuration, the network and contracts it pays on, and its request: 2 seats of
 * pool 7, for at most their price at 180.
 */
const BUYER_CONFIG: ExpectedOffer = {
  network: 'near:testnet',
  token: TOKEN,
  poolsContract: POOLS,
  poolId: POOL_ID,
  maxSeats: 2,
  maxAmount: 360n,
};

/** Deps over a FakeChain holding pool 7, and the app over them. */
async function setup(config: Partial<GatewayConfig> = {}, options: { fetch?: typeof fetch } = {}) {
  const deps = await testDeps({ config: testConfig(config) });
  deps.fake.setPool(poolView({ id: POOL_ID }));
  return { deps, fake: deps.fake, app: createApp(deps, options) };
}

/** A buyer with a full-access key (nonce 10), a balance and 2 committed seats in pool 7. */
function addBuyer(fake: FakeChain): KeyPair {
  const keyPair = KeyPair.fromRandom('ed25519');
  fake.setKey(BUYER, keyPair.getPublicKey().toString(), { nonce: 10n, fullAccess: true });
  fake.balances.set(BUYER, 1_000_000n);
  fake.setBuyer(POOL_ID, BUYER, { seats: 2, state: 'committed' });
  return keyPair;
}

/** The buyer's payment for 2 seats of pool 7 as it stands. */
function payment(deps: Deps & { fake: FakeChain }, keyPair: KeyPair): Promise<string> {
  const { config, fake } = deps;
  return buildPaymentHeader({
    keyPair,
    senderId: BUYER,
    nonce: 11n,
    maxBlockHeight: maxBlockHeightFor(fake.block.height, config.maxTimeoutSeconds, config.blockTimeMs),
    offer: buildOffer(poolView({ id: POOL_ID }), 2, offerContext(config)),
    expected: BUYER_CONFIG,
  });
}

/** The buyer's redemption proof for pool 7. */
function proof(deps: Deps, keyPair: KeyPair): Promise<string> {
  const recipient = new URL(deps.config.publicUrl).host;
  return buildRedeemProofHeader({ keyPair, accountId: BUYER, poolId: POOL_ID, recipient, nowMs: NOW_MS });
}

/** A relayed commit of 2 seats that leaves the pool open. */
function queueCommit(fake: FakeChain): void {
  fake.relayResults.push({
    kind: 'executed',
    outcome: commitOutcome({ txHash: TX_HASH, buyer: BUYER, poolId: POOL_ID, seats: 2, seatPrice: 180n, taken: 150, target: 192 }),
  });
}

async function answer(response: Response | Promise<Response>): Promise<{ status: number; body: unknown }> {
  const res = await response;
  return { status: res.status, body: await res.json() };
}

function activityRecord(overrides: Partial<ActivityRecord> = {}): ActivityRecord {
  return {
    at: NOW_MS,
    poolId: POOL_ID,
    kind: 'commit',
    account: BUYER,
    seats: 2,
    amount: '360',
    txHash: TX_HASH,
    ok: true,
    ...overrides,
  };
}

/** A JSON-RPC `call_function` view of `get_pool` on the pools contract, with changes. */
function viewCall(changes: Record<string, unknown> = {}, params: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id: 'page',
    method: 'query',
    params: {
      request_type: 'call_function',
      account_id: POOLS,
      method_name: 'get_pool',
      args_base64: Buffer.from(JSON.stringify({ pool_id: POOL_ID })).toString('base64'),
      finality: 'final',
      ...params,
    },
    ...changes,
  };
}

const RPC_RESULT = { jsonrpc: '2.0', id: 'page', result: { result: [123], logs: [], block_height: 1000, block_hash: 'Hash1' } };

/** An upstream RPC that answers `body` with `status`. */
function upstream(body: unknown = RPC_RESULT, status = 200) {
  return vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
}

/** The app with the RPC pass-through on, over `fetch`. */
async function passthrough(fetch: typeof globalThis.fetch) {
  return setup({ rpcPassthrough: true }, { fetch });
}

function postRpc(app: Awaited<ReturnType<typeof setup>>['app'], body: unknown): Response | Promise<Response> {
  return app.request('/rpc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

/** A temporary folder holding the live page's files, by path within it. */
async function webFolder(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'quorum-web-'));
  for (const [name, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, name)), { recursive: true });
    await writeFile(join(dir, name), text);
  }
  return dir;
}

const INDEX_HTML = '<!doctype html><title>Quorum</title>\n';
const APP_JS = 'export const ready = true;\n';

describe('createApp', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('GET /pools', () => {
    it('lists the open pools of the configured provider', async () => {
      const { fake, app } = await setup();
      fake.setPool(poolView({ id: 8, seller: 'other-seller.testnet' }));
      fake.setPool(poolView({ id: 9, status: 'filled', taken: 192 }));
      expect(await answer(app.request('/pools'))).toEqual({
        status: 200,
        body: [
          {
            id: POOL_ID,
            terms: TERMS,
            seat_price: '180',
            target: 192,
            taken: 148,
            deadline_ms: DEADLINE_MS,
            bonus: '1728',
            min_bonus_per_seat: '9',
          },
        ],
      });
    });

    it('answers 503 chain_unavailable when the pools cannot be read', async () => {
      const { fake, app } = await setup();
      const failure = new Error('RPC down');
      vi.spyOn(fake, 'listPools').mockRejectedValue(failure);
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(await answer(app.request('/pools'))).toEqual({ status: 503, body: { error: 'chain_unavailable' } });
      expect(logged).toHaveBeenCalledExactlyOnceWith(expect.any(String), failure);
    });
  });

  describe('GET /pools/:id/access', () => {
    it('answers the 402 offer for the requested seats when there is no header', async () => {
      const { deps, app } = await setup();
      const offer = buildOffer(poolView({ id: POOL_ID }), 2, offerContext(deps.config));
      expect(await answer(app.request(`/pools/${POOL_ID}/access?seats=2`))).toEqual({
        status: 402,
        body: paymentRequired([offer]),
      });
    });

    it('relays a payment sent in X-PAYMENT', async () => {
      const { deps, fake, app } = await setup();
      const keyPair = addBuyer(fake);
      queueCommit(fake);
      const headers = { [PAYMENT_HEADER]: await payment(deps, keyPair) };
      expect(await answer(app.request(`/pools/${POOL_ID}/access?seats=2`, { headers }))).toEqual({
        status: 202,
        body: {
          status: 'pending',
          receipt: { poolId: POOL_ID, buyer: BUYER, seats: 2, txHash: TX_HASH },
          pool: { taken: 150, target: 192, deadlineMs: DEADLINE_MS },
        },
      });
    });

    it("passes the handler's reply headers through", async () => {
      const { deps, fake, app } = await setup();
      const keyPair = addBuyer(fake);
      queueCommit(fake);
      const headers = { [PAYMENT_HEADER]: await payment(deps, keyPair) };
      const res = await app.request(`/pools/${POOL_ID}/access?seats=2`, { headers });
      expect(decodeHeader(res.headers.get(PAYMENT_RESPONSE_HEADER) ?? '')).toEqual({
        success: true,
        transaction: TX_HASH,
        network: 'near:testnet',
        payer: BUYER,
      });
    });

    it('redeems a proof sent in X-QUORUM-PROOF', async () => {
      const { deps, fake, app } = await setup();
      const keyPair = addBuyer(fake);
      const headers = { [PROOF_HEADER]: await proof(deps, keyPair) };
      expect(await answer(app.request(`/pools/${POOL_ID}/access`, { headers }))).toEqual({
        status: 202,
        body: { status: 'pending', seats: 2, taken: 148, target: 192, deadlineMs: DEADLINE_MS },
      });
    });

    it('treats a request carrying both headers as a payment', async () => {
      const { deps, fake, app } = await setup();
      const keyPair = addBuyer(fake);
      const headers = { [PAYMENT_HEADER]: 'not-a-payment', [PROOF_HEADER]: await proof(deps, keyPair) };
      const { status, body } = await answer(app.request(`/pools/${POOL_ID}/access`, { headers }));
      expect({ status, error: (body as { error: unknown }).error }).toEqual({ status: 402, error: 'invalid_payload' });
    });

    it.each(['abc', '-1', '07', '1.5', '1e3', '9007199254740993'])(
      'answers 404 unknown_pool without reading the chain for the pool id %s',
      async (id) => {
        const { fake, app } = await setup();
        expect(await answer(app.request(`/pools/${id}/access`))).toEqual({ status: 404, body: { error: 'unknown_pool' } });
        expect(fake.reads.size).toBe(0);
      },
    );
  });

  describe('GET /activity', () => {
    it('lists every record without a pool parameter', async () => {
      const { deps, app } = await setup();
      const records = [activityRecord(), activityRecord({ poolId: 8, txHash: 'OtherTx' })];
      for (const record of records) await deps.activity.append(record);
      expect(await answer(app.request('/activity'))).toEqual({ status: 200, body: records });
    });

    it("lists only one pool's records with ?pool", async () => {
      const { deps, app } = await setup();
      await deps.activity.append(activityRecord());
      await deps.activity.append(activityRecord({ poolId: 8, txHash: 'OtherTx' }));
      expect(await answer(app.request(`/activity?pool=${POOL_ID}`))).toEqual({ status: 200, body: [activityRecord()] });
    });

    it.each(['', 'x', '-1', '07'])('answers 400 invalid_pool for ?pool=%s', async (pool) => {
      const { app } = await setup();
      expect(await answer(app.request(`/activity?pool=${pool}`))).toEqual({ status: 400, body: { error: 'invalid_pool' } });
    });
  });

  describe('GET /.well-known/jwks.json', () => {
    it("answers the credential issuer's public keys", async () => {
      const { deps, app } = await setup();
      expect(await answer(app.request('/.well-known/jwks.json'))).toEqual({ status: 200, body: deps.credentials.jwks() });
    });
  });

  describe('GET /config.json', () => {
    const expected = {
      network: 'near:testnet',
      poolsContract: POOLS,
      token: TOKEN,
      provider: PROVIDER,
      explorerTxUrl: 'https://testnet.nearblocks.io/txns/',
    };

    it('points the page at the configured RPC when the pass-through is off', async () => {
      const { app } = await setup();
      expect(await answer(app.request('/config.json'))).toEqual({
        status: 200,
        body: { ...expected, rpcUrl: 'http://rpc.invalid' },
      });
    });

    it('points the page at /rpc when the pass-through is on', async () => {
      const { app } = await setup({ rpcPassthrough: true });
      expect(await answer(app.request('/config.json'))).toEqual({ status: 200, body: { ...expected, rpcUrl: '/rpc' } });
    });
  });

  describe('POST /rpc', () => {
    it('is not served when the pass-through is off', async () => {
      const fetch = upstream();
      const { app } = await setup({}, { fetch });
      expect(await answer(postRpc(app, viewCall()))).toEqual({ status: 404, body: { error: 'not_found' } });
      expect(fetch).not.toHaveBeenCalled();
    });

    it('forwards a view call on the pools contract to the RPC with the same body', async () => {
      const fetch = upstream();
      const { app } = await passthrough(fetch);
      await postRpc(app, viewCall());
      expect(fetch).toHaveBeenCalledExactlyOnceWith('http://rpc.invalid', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(viewCall()),
      });
    });

    it("answers the RPC's JSON for a view call on the pools contract", async () => {
      const { app } = await passthrough(upstream());
      expect(await answer(postRpc(app, viewCall()))).toEqual({ status: 200, body: RPC_RESULT });
    });

    it('forwards a view call on the token', async () => {
      const fetch = upstream();
      const { app } = await passthrough(fetch);
      const call = viewCall({}, { account_id: TOKEN, method_name: 'ft_balance_of' });
      expect(await answer(postRpc(app, call))).toEqual({ status: 200, body: RPC_RESULT });
      expect(fetch.mock.calls[0]?.[1]?.body).toBe(JSON.stringify(call));
    });

    it('forwards a view call at a block id', async () => {
      const fetch = upstream();
      const { app } = await passthrough(fetch);
      const call = viewCall({}, { finality: undefined, block_id: 1000 });
      expect(await answer(postRpc(app, call))).toEqual({ status: 200, body: RPC_RESULT });
    });

    it("answers with the RPC's status", async () => {
      const error = { jsonrpc: '2.0', id: 'page', error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_BLOCK' } } };
      const { app } = await passthrough(upstream(error, 408));
      expect(await answer(postRpc(app, viewCall()))).toEqual({ status: 408, body: error });
    });

    it.each([
      ['another account', viewCall({}, { account_id: 'other.testnet' })],
      ['another request type', viewCall({}, { request_type: 'view_state', prefix_base64: '' })],
      ['another RPC method', viewCall({ method: 'send_tx' })],
      ['a JSON-RPC version other than 2.0', viewCall({ jsonrpc: '1.0' })],
      ['both finality and block_id', viewCall({}, { block_id: 1000 })],
      ['an unknown field', viewCall({}, { extra: true })],
      ['a batch', [viewCall()]],
      ['params given as an array', viewCall({ params: ['call/pools/get_pool', ''] })],
    ])('answers 403 not_allowed for %s', async (_name, body) => {
      const fetch = upstream();
      const { app } = await passthrough(fetch);
      expect(await answer(postRpc(app, body))).toEqual({ status: 403, body: { error: 'not_allowed' } });
      expect(fetch).not.toHaveBeenCalled();
    });

    it('answers 400 invalid_json for a body that is not JSON', async () => {
      const fetch = upstream();
      const { app } = await passthrough(fetch);
      expect(await answer(postRpc(app, '{"jsonrpc":'))).toEqual({ status: 400, body: { error: 'invalid_json' } });
      expect(fetch).not.toHaveBeenCalled();
    });

    it('answers 503 chain_unavailable when the RPC cannot be reached', async () => {
      const failure = new TypeError('fetch failed');
      const fetch = vi.fn<typeof globalThis.fetch>(async () => {
        throw failure;
      });
      const { app } = await passthrough(fetch);
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(await answer(postRpc(app, viewCall()))).toEqual({ status: 503, body: { error: 'chain_unavailable' } });
      expect(logged).toHaveBeenCalledExactlyOnceWith(expect.any(String), failure);
    });
  });

  describe('static files', () => {
    it('serves index.html at /', async () => {
      const webDir = await webFolder({ 'index.html': INDEX_HTML });
      const { app } = await setup({ webDir });
      const res = await app.request('/');
      expect({ status: res.status, type: res.headers.get('Content-Type'), text: await res.text() }).toEqual({
        status: 200,
        type: 'text/html; charset=utf-8',
        text: INDEX_HTML,
      });
    });

    it('serves a JavaScript module as JavaScript', async () => {
      const webDir = await webFolder({ 'index.html': INDEX_HTML, 'app.js': APP_JS });
      const { app } = await setup({ webDir });
      const res = await app.request('/app.js');
      expect({ status: res.status, type: res.headers.get('Content-Type'), text: await res.text() }).toEqual({
        status: 200,
        type: 'text/javascript; charset=utf-8',
        text: APP_JS,
      });
    });

    it('answers 404 not_found for a file the folder does not have', async () => {
      const webDir = await webFolder({ 'index.html': INDEX_HTML });
      const { app } = await setup({ webDir });
      expect(await answer(app.request('/missing.js'))).toEqual({ status: 404, body: { error: 'not_found' } });
    });

    it('answers the API before a file with the same path', async () => {
      const webDir = await webFolder({ 'config.json': '{"rpcUrl":"elsewhere"}' });
      const { app } = await setup({ webDir });
      const { body } = await answer(app.request('/config.json'));
      expect((body as { rpcUrl: unknown }).rpcUrl).toBe('http://rpc.invalid');
    });

    it('serves nothing when webDir is null', async () => {
      const { app } = await setup({ webDir: null });
      expect(await answer(app.request('/'))).toEqual({ status: 404, body: { error: 'not_found' } });
    });
  });

  describe('POST /rpc limits', () => {
    const MAX_BODY = 16 * 1024;

    /** A view call on the pools contract, padded with spaces to `size` bytes of JSON. */
    function padded(size: number): string {
      const json = JSON.stringify(viewCall());
      return json + ' '.repeat(size - json.length);
    }

    it('reads a body of exactly 16 KiB', async () => {
      const { app } = await passthrough(upstream());
      expect(await answer(postRpc(app, padded(MAX_BODY)))).toEqual({ status: 200, body: RPC_RESULT });
    });

    it('answers 413 body_too_large for a longer body, and forwards nothing', async () => {
      const fetch = upstream();
      const { app } = await passthrough(fetch);
      expect(await answer(postRpc(app, padded(MAX_BODY + 1)))).toEqual({ status: 413, body: { error: 'body_too_large' } });
      expect(fetch).not.toHaveBeenCalled();
    });

    it('answers 413 body_too_large for a longer declared Content-Length', async () => {
      const fetch = upstream();
      const { app } = await passthrough(fetch);
      const body = padded(MAX_BODY + 1);
      const res = app.request('/rpc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': String(body.length) },
        body,
      });
      expect(await answer(res)).toEqual({ status: 413, body: { error: 'body_too_large' } });
      expect(fetch).not.toHaveBeenCalled();
    });

    it('forwards the largest arguments a view of either contract takes', async () => {
      // get_buyer with the largest u64 pool id and a 64-character account id: 112 bytes of JSON.
      const args = `{"pool_id":18446744073709551615,"account_id":"${'a'.repeat(64)}"}`;
      const call = viewCall({}, { method_name: 'get_buyer', args_base64: Buffer.from(args).toString('base64') });
      const { app } = await passthrough(upstream());
      expect(await answer(postRpc(app, call))).toEqual({ status: 200, body: RPC_RESULT });
    });

    it('forwards args_base64 of 1024 characters', async () => {
      const { app } = await passthrough(upstream());
      const call = viewCall({}, { args_base64: 'A'.repeat(1024) });
      expect(await answer(postRpc(app, call))).toEqual({ status: 200, body: RPC_RESULT });
    });

    it('answers 403 not_allowed for longer args_base64', async () => {
      const fetch = upstream();
      const { app } = await passthrough(fetch);
      const call = viewCall({}, { args_base64: 'A'.repeat(1028) });
      expect(await answer(postRpc(app, call))).toEqual({ status: 403, body: { error: 'not_allowed' } });
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  describe('static files whose names start with a dot', () => {
    const FILES = {
      'index.html': INDEX_HTML,
      '.env': 'QUORUM_PARENT_ACCOUNT=parent.testnet\n',
      '.git/config': '[core]\n',
      'sub/.hidden': 'hidden\n',
      'sub/page.js': APP_JS,
      '.well-known/other.json': '{}',
    };

    it.each(['/.env', '/%2Eenv', '/.git/config', '/sub/.hidden', '/.well-known/other.json'])(
      'answers 404 not_found for %s, which the folder holds',
      async (path) => {
        const { app } = await setup({ webDir: await webFolder(FILES) });
        expect(await answer(app.request(path))).toEqual({ status: 404, body: { error: 'not_found' } });
      },
    );

    it('still serves the other files, in subfolders too', async () => {
      const { app } = await setup({ webDir: await webFolder(FILES) });
      const res = await app.request('/sub/page.js');
      expect({ status: res.status, text: await res.text() }).toEqual({ status: 200, text: APP_JS });
    });

    it('still answers /.well-known/jwks.json', async () => {
      const { deps, app } = await setup({ webDir: await webFolder(FILES) });
      expect(await answer(app.request('/.well-known/jwks.json'))).toEqual({ status: 200, body: deps.credentials.jwks() });
    });
  });

  describe('errors', () => {
    it('answers 404 not_found for an unknown route', async () => {
      const { app } = await setup();
      expect(await answer(app.request('/nope'))).toEqual({ status: 404, body: { error: 'not_found' } });
    });

    it('answers 500 internal_error when a route throws', async () => {
      const { deps, app } = await setup();
      vi.spyOn(deps.credentials, 'jwks').mockImplementation(() => {
        throw new Error('broken key');
      });
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(await answer(app.request('/.well-known/jwks.json'))).toEqual({ status: 500, body: { error: 'internal_error' } });
      expect(logged).toHaveBeenCalledOnce();
    });
  });
});
