import { serveStatic } from '@hono/node-server/serve-static';
import { PAYMENT_HEADER, PROOF_HEADER, type PoolView } from '@quorum-on-near/protocol';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { DEMO_SCENARIOS, type DemoRunner } from './demo.ts';
import type { Deps } from './deps.ts';
import { handleOffer } from './handle-offer.ts';
import { handlePayment } from './handle-payment.ts';
import { handleRedeem } from './handle-redeem.ts';
import { listServedPools, openPoolListings } from './pools.ts';
import { redactUrls } from './redact.ts';
import type { Reply } from './reply.ts';
import { isAllowedViewCall } from './view-call.ts';

const POOL_ID = /^(0|[1-9][0-9]*)$/;
/** The largest `POST /rpc` body read; a longer one is answered 413. */
const MAX_RPC_BODY_BYTES = 16 * 1024;
/** How long a `POST /rpc` forward waits for the RPC's whole answer; past it, the request is answered 503. */
const RPC_FORWARD_TIMEOUT_MS = 10_000;
/**
 * How long a demo `POST` waits for the provider's pools, which it reads while it holds the slot; past
 * it, the request is answered 503 and the slot is freed. Below the 10 seconds that the live page waits
 * for the answer, so that the page never gives up on a request the gateway then starts a run for.
 */
const DEMO_POOLS_READ_TIMEOUT_MS = 8_000;
/**
 * The paths of the live page's four files, the only files served from `config.webDir`: `/` serves
 * `index.html`. The folder also holds the page's package files, tests and `node_modules`, which are
 * never served.
 */
const PAGE_FILES = new Set(['/', '/index.html', '/app.js', '/totals.js', '/style.css']);
/**
 * The header a demo `POST` must carry, with the value `1`. A page on another site cannot send it
 * without a CORS preflight, which the gateway never answers, so a browser never sends that page's
 * request: a form or a beacon from another site cannot start a run.
 */
const DEMO_HEADER = 'X-Quorum-Demo';

/** A pool id as a URL writes it: decimal, no sign, no leading zero. Null otherwise. */
function parsePoolId(param: string): number | null {
  if (!POOL_ID.test(param)) return null;
  const id = Number(param);
  return Number.isSafeInteger(id) ? id : null;
}

/**
 * `promise`'s outcome, or a rejection once `ms` milliseconds have passed without one. The read itself is
 * not cancelled: it goes on until its own end, and its late outcome is dropped. The timer is cleared as
 * soon as `promise` settles, so a read that answers leaves nothing running.
 */
function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

function send(c: Context, r: Reply): Response {
  return c.json(r.body, r.status as ContentfulStatusCode, r.headers);
}

export interface AppOptions {
  /** Replaces the global fetch for the RPC pass-through. */
  fetch?: typeof fetch;
  /** Runs the demo; absent or null, the demo routes do not exist. */
  demo?: DemoRunner | null;
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
 * - `POST /demo/fills`, `POST /demo/fails` and `GET /demo` (only when `options.demo` is set; hosted
 *   demo spec, section 4.2)
 * - the live page's four files (only when `config.webDir` is set): `index.html` at `/` and at
 *   `/index.html`, `/app.js`, `/totals.js` and `/style.css`; no other file of the folder
 *
 * Every answer is JSON except the page's files.
 */
export function createApp(deps: Deps, options: AppOptions = {}): Hono {
  const { config } = deps;
  const demo = options.demo ?? null;
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

  // What the live page needs: how to read the chain, and whether to show the demo's buttons.
  app.get('/config.json', (c) =>
    c.json({
      network: config.network,
      rpcUrl: config.rpcPassthrough ? '/rpc' : config.rpcUrl,
      poolsContract: config.poolsContract,
      token: config.token,
      provider: config.provider,
      explorerTxUrl: config.explorerTxUrl,
      demo: demo !== null,
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
        // The RPC's own text may quote its URL, which may hold a key, and the live page shows an error's
        // message: the URL is named by its variable instead, as in the gateway's own output.
        const text = redactUrls(JSON.stringify(await upstream.json()), { QUORUM_RPC_URL: config.rpcUrl });
        return c.json(JSON.parse(text), upstream.status as ContentfulStatusCode);
      } catch (error) {
        console.error('could not forward a request to the RPC:', error);
        return c.json({ error: 'chain_unavailable' }, 503);
      }
    });
  }

  // The demo (hosted demo spec, section 4.2). No request body is read, and no CORS header is sent.
  if (demo !== null) {
    app.get('/demo', (c) => c.json(demo.status()));

    for (const scenario of DEMO_SCENARIOS) {
      app.post(`/demo/${scenario}`, async (c) => {
        if (c.req.header(DEMO_HEADER) !== '1') return c.json({ error: 'demo_header_required' }, 403);
        // A run in progress, then today's cap, checked in the same synchronous step that takes the slot.
        const claim = demo.claim(scenario);
        if (claim.kind === 'running') {
          return c.json({ error: 'demo_running', scenario: claim.scenario, startedAt: claim.startedAt }, 409);
        }
        if (claim.kind === 'limit') return c.json({ error: 'demo_limit' }, 429);
        let pools: PoolView[];
        try {
          pools = await within(listServedPools(deps.chain, config.provider), DEMO_POOLS_READ_TIMEOUT_MS);
        } catch (error) {
          claim.release();
          console.error('could not read the pools before a demo run:', error);
          return c.json({ error: 'chain_unavailable' }, 503);
        }
        // The swarm opens no pool while one of the provider's is Open, so such a run would stop at once.
        // The newest is the one the live page follows.
        const open = pools.findLast((pool) => pool.status === 'open');
        if (open !== undefined) {
          claim.release();
          return c.json({ error: 'pool_open', poolId: open.id }, 409);
        }
        void claim.start();
        return c.json({ scenario, startedAt: claim.startedAt }, 202);
      });
    }
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
