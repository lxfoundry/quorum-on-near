import { serveStatic } from '@hono/node-server/serve-static';
import { PAYMENT_HEADER, PROOF_HEADER } from '@quorum-on-near/protocol';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Deps } from './deps.ts';
import { handleOffer } from './handle-offer.ts';
import { handlePayment } from './handle-payment.ts';
import { handleRedeem } from './handle-redeem.ts';
import { openPoolListings } from './pools.ts';
import type { Reply } from './reply.ts';

const POOL_ID = /^(0|[1-9][0-9]*)$/;
/** The largest `POST /rpc` body read; a longer one is answered 413. */
const MAX_RPC_BODY_BYTES = 16 * 1024;
/** How long a `POST /rpc` forward waits for the RPC's whole answer; past it, the request is answered 503. */
const RPC_FORWARD_TIMEOUT_MS = 10_000;
/**
 * The longest `args_base64` forwarded. The largest arguments a view of either contract takes,
 * `get_buyer`'s u64 pool id and 64-character account id, are 152 characters of base64.
 */
const MAX_ARGS_BASE64 = 1024;
/**
 * The paths of the live page's four files, the only files served from `config.webDir`: `/` serves
 * `index.html`. The folder also holds the page's package files, tests and `node_modules`, which are
 * never served.
 */
const PAGE_FILES = new Set(['/', '/index.html', '/app.js', '/totals.js', '/style.css']);

/** A pool id as a URL writes it: decimal, no sign, no leading zero. Null otherwise. */
function parsePoolId(param: string): number | null {
  if (!POOL_ID.test(param)) return null;
  const id = Number(param);
  return Number.isSafeInteger(id) ? id : null;
}

type Fields = Record<string, unknown>;

function isFields(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether `value` has exactly these keys. */
function hasExactKeys(value: Fields, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

/**
 * Whether `body` is a JSON-RPC 2.0 `query` of `request_type: "call_function"` on one of `accounts`,
 * at a `finality` or a `block_id`, with no other field at either level, and `args_base64` of at
 * most MAX_ARGS_BASE64 characters.
 */
export function isAllowedViewCall(body: unknown, accounts: string[]): boolean {
  if (!isFields(body) || !hasExactKeys(body, ['jsonrpc', 'id', 'method', 'params'])) return false;
  const { jsonrpc, id, method, params } = body;
  if (jsonrpc !== '2.0' || (typeof id !== 'string' && typeof id !== 'number') || method !== 'query') return false;
  if (!isFields(params)) return false;
  const byFinality = 'finality' in params;
  const block = byFinality
    ? typeof params.finality === 'string'
    : typeof params.block_id === 'string' || typeof params.block_id === 'number';
  return (
    hasExactKeys(params, ['request_type', 'account_id', 'method_name', 'args_base64', byFinality ? 'finality' : 'block_id']) &&
    block &&
    params.request_type === 'call_function' &&
    typeof params.account_id === 'string' &&
    accounts.includes(params.account_id) &&
    typeof params.method_name === 'string' &&
    typeof params.args_base64 === 'string' &&
    params.args_base64.length <= MAX_ARGS_BASE64
  );
}

function send(c: Context, r: Reply): Response {
  return c.json(r.body, r.status as ContentfulStatusCode, r.headers);
}

/**
 * The HTTP app (spec section 6.1):
 * - `GET /pools`
 * - `GET /pools/:id/access` (offer, payment or redemption, chosen by header)
 * - `GET /activity?pool=:id`
 * - `GET /.well-known/jwks.json`
 * - `GET /config.json`
 * - `POST /rpc` (only when `config.rpcPassthrough`), with a body of at most 16 KiB, forwarded with a
 *   10-second timeout
 * - the live page's four files (only when `config.webDir` is set): `index.html` at `/` and at
 *   `/index.html`, `/app.js`, `/totals.js` and `/style.css`; no other file of the folder
 *
 * Every answer is JSON except the page's files. `options.fetch` replaces the global fetch for the
 * RPC pass-through.
 */
export function createApp(deps: Deps, options: { fetch?: typeof fetch } = {}): Hono {
  const { config } = deps;
  const app = new Hono();

  app.get('/pools', async (c) => {
    try {
      return c.json(await openPoolListings(deps.chain, config.provider));
    } catch (error) {
      console.error('could not list the open pools:', error);
      return c.json({ error: 'chain_unavailable' }, 503);
    }
  });

  app.get('/pools/:id/access', async (c) => {
    const poolId = parsePoolId(c.req.param('id'));
    if (poolId === null) return c.json({ error: 'unknown_pool' }, 404);
    const seats = c.req.query('seats');
    // A payment takes precedence over a proof.
    const payment = c.req.header(PAYMENT_HEADER);
    if (payment !== undefined) return send(c, await handlePayment(deps, poolId, seats, payment));
    const proof = c.req.header(PROOF_HEADER);
    if (proof !== undefined) return send(c, await handleRedeem(deps, poolId, proof));
    return send(c, await handleOffer(deps, poolId, seats));
  });

  app.get('/activity', (c) => {
    const pool = c.req.query('pool');
    if (pool === undefined) return c.json(deps.activity.list());
    const poolId = parsePoolId(pool);
    if (poolId === null) return c.json({ error: 'invalid_pool' }, 400);
    return c.json(deps.activity.list(poolId));
  });

  app.get('/.well-known/jwks.json', (c) => c.json(deps.credentials.jwks()));

  // What the live page needs to read the chain.
  app.get('/config.json', (c) =>
    c.json({
      network: config.network,
      rpcUrl: config.rpcPassthrough ? '/rpc' : config.rpcUrl,
      poolsContract: config.poolsContract,
      token: config.token,
      provider: config.provider,
      explorerTxUrl: config.explorerTxUrl,
    }),
  );

  if (config.rpcPassthrough) {
    const forward = options.fetch ?? fetch;
    const accounts = [config.poolsContract, config.token];
    const limit = bodyLimit({ maxSize: MAX_RPC_BODY_BYTES, onError: (c) => c.json({ error: 'body_too_large' }, 413) });
    app.post('/rpc', limit, async (c) => {
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: 'invalid_json' }, 400);
      }
      if (!isAllowedViewCall(body, accounts)) return c.json({ error: 'not_allowed' }, 403);
      try {
        // The request as parsed and checked, so the RPC cannot read it differently (a duplicated key).
        const upstream = await forward(config.rpcUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(RPC_FORWARD_TIMEOUT_MS),
        });
        return c.json(await upstream.json(), upstream.status as ContentfulStatusCode);
      } catch (error) {
        console.error('could not forward a request to the RPC:', error);
        return c.json({ error: 'chain_unavailable' }, 503);
      }
    });
  }

  // After the routes, so a file never shadows one. A relative root resolves against the current folder.
  // Only the page's own files are served: any other path, such as /package.json or /.env, falls
  // through to not_found.
  if (config.webDir !== null) {
    const files = serveStatic({ root: config.webDir });
    app.use('*', (c, next) => (PAGE_FILES.has(c.req.path) ? files(c, next) : next()));
  }

  app.notFound((c) => c.json({ error: 'not_found' }, 404));
  app.onError((error, c) => {
    console.error(`unhandled error in ${c.req.method} ${c.req.path}:`, error);
    return c.json({ error: 'internal_error' }, 500);
  });
  return app;
}
