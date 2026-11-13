# Gateway RPC load Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or
> executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for
> tracking.

**Goal:** Keep the gateway's JSON-RPC reads from growing with the number of open live pages and
polling buyers, and let the gateway's own reads survive an HTTP 429 from an endpoint that limits
requests per second, without ever posting a transaction twice.

**Architecture:** One small in-memory cache, `ViewCache<T>`: an answer lives 2 seconds from when its
read was sent, at most 64 are kept, callers of the same key share one read in flight, and `clear()`
starts a new generation. It is used twice: by the `POST /rpc` forward, for four of the live page's
views, and by redemptions, for `get_pool`, cleared after every transaction the gateway sends. A
wrapper around the gateway's near-api-js view provider, with four view methods and no send method,
tries a read again after HTTP 429, at most three times. Payments, offers, the keeper, `GET /pools`
and the relayer keep their uncached, single-post paths.

**Tech Stack:** Node 22.22.2 with type stripping, pnpm workspace, TypeScript, Hono (gateway),
near-api-js 7.4.0, vitest 4.1.12.

**Spec:** [`docs/specs/2026-11-09-quorum-on-near-design.md`](../specs/2026-11-09-quorum-on-near-design.md)
("the design spec"). This plan adds to four of its places: the `POST /rpc` row of section 6.1 and
section 12's bullet on the live page's refreshes (Task 2), section 6.5 on redemption (Task 3) and
the error handling table of section 9 (Task 4).
Read sections 6.1, 6.4, 6.5, 6.7, 9 and 12 before starting.

## Status of the code in this plan

Every code block, test and expected output in this plan comes from a run against `main`.
Each task's tests fail first as its steps show and pass after it, and `pnpm typecheck` and
`pnpm test` pass over the whole workspace after it. The test counts in the steps are observed. Every
code block in a step is the code as it ran: a new file's full content, or an edit as its exact old
and new text; the Interfaces blocks give the signatures. Copy the code as written. The sentences quoted for the design spec are text, not code, and are
not part of a run. Expected outputs
are excerpts of the run's own lines, in order; lines that name the checkout's folder, timings, code
frames and failure details are left out, and the whitespace in pnpm's error lines is normalised.

`main.ts`, `app.ts` and `config.ts` may differ from what this plan quotes. This plan does not change
`config.ts`, keeps its edits to `main.ts` and `app.ts` small, and quotes the anchor of each. Where
the code differs, adapt the anchor and keep the behaviour the task states; each task that edits one
of these files says what that behaviour is. If the gateway's suite starts with more tests than this
plan shows, check each task's increment (Task 1 +17, Task 2 +39, Task 3 +14, Task 4 +18).

## Why

Measured on NEAR testnet, against the gateway at commit `d46616e`, with the live page open in one
tab and a run of 14 scripted buyers:

- **The calls.** The gateway made 1,378 JSON-RPC calls in 425 s: 3.2 per second on average, with
  peaks of 19, 16, 15, 14 and 14 per second. The endpoint, limited to 15 requests per second,
  answered 8 of them with HTTP 429.
- **The sources.** The live page made about 60% of the calls, redemption polling about 20%, and
  payments about 11% (about 10 calls each). `get_pool` and `list_pools` alone were 48%.
- **The page.** Every 2 seconds, each open tab reads `list_pools`, `get_pool`, `get_seats` and
  `ft_balance_of` through the gateway's `POST /rpc` forward (`apps/gateway/src/app.ts`): about 2
  calls per second per tab, so the cost grows with the number of tabs. It reads `list_pools` and
  `get_pool` at `final` finality, and `get_seats` and `ft_balance_of` at the block hash of its
  `get_pool` answer. The gateway's own reads use `optimistic` finality, so they never ask for the
  same view as the page.
- **The retries.** near-api-js 7.4.0 retries a request only after HTTP 503, 500 and 408 (the
  `retry` predicate in the installed package's `lib/index.js`). After HTTP 429 it throws at once,
  a `ProviderError` whose `cause` is 429 and whose message is the response's body. The gateway's
  view provider uses those defaults (`apps/gateway/src/main.ts`), so a single 429 fails the offer,
  payment, redemption or keeper tick that made the read.
- **The relayer.** The relayer's provider posts each request once, on purpose
  (`apps/gateway/src/providers.ts`, `retries: 1`): a transaction is never posted twice. This plan
  keeps it so.
- **One quota.** With the pass-through on (`QUORUM_RPC_PASSTHROUGH=true`) and an endpoint that
  takes a key, every visitor's page reads and any caller of `POST /rpc` spend the same endpoint's
  quota as the keeper, the relayer's status reads and the reads made at boot (`swarm keys
  from-seed` makes about 55 sequential reads). `/rpc` has no rate limit, a known limit of the design
  (spec section 12).

## The time-to-live: 2,000 ms

`VIEW_CACHE_TTL_MS = 2_000` in `apps/gateway/src/view-cache.ts`, a constant, not a `QUORUM_*`
setting. An answer is fresh while `0 <= now - sentAt < 2,000`, where `sentAt` is when its read was
**sent**, so every answer a caller gets was requested less than 2 seconds before the caller asked.
The clock is `performance.now()`, which never goes back; an injected clock that goes back makes
nothing fresh.

- **The live page** refreshes every 2,000 ms per tab (`POLL_INTERVAL_MS`, `apps/web/app.js:33`).
  With a 2,000 ms life, each cached view costs at most one upstream read per 2 seconds, however many
  tabs are open. A tab is served a cached answer on some refreshes, so its display lags by at most
  one refresh. A shorter life would let more of the tabs' reads through (at 1,000 ms, up to one per
  second per view); a longer one would make the display lag more than one refresh.
- **Redemptions.** A scripted buyer polls its redemption every 5,000 ms by default
  (`QUORUM_REDEEM_INTERVAL_MS`, `apps/swarm/src/config.ts:127`), plus up to 10% jitter
  (`apps/swarm/src/buyer-agent.ts:572`). 2,000 ms is below that, so at the default a buyer never
  gets the same cached answer on two polls in a row. The interval may be set lower (it is accepted
  from 1 ms); a buyer may then get one answer twice, which only delays it (see the table below).

The fake-clock tests that pin it, each with the clock moved by hand:

| Test | File | What it shows |
|---|---|---|
| `serves a stored answer until 1 ms before 2 seconds, and reads again at 2 seconds` | `test/view-cache.test.ts` | Served at 1,999 ms, read again at 2,000 ms |
| `counts an answer's age from when its read was sent, not from when it arrived` | `test/view-cache.test.ts` | A slow answer expires 2,000 ms after its read was sent |
| `stores nothing from a read that took the whole 2 seconds` | `test/view-cache.test.ts` | An answer that arrives at 2,000 ms is not stored |
| `counts a stored answer as expired once the clock has gone back` | `test/view-cache.test.ts` | A backward step expires the stored answer |
| `joins no read in flight once the clock has gone back, …` | `test/view-cache.test.ts` | A backward step makes a read in flight unjoinable |
| `sends a new read rather than join one sent 2 seconds ago, …` | `test/view-cache.test.ts` | The join window is the same 2,000 ms |
| `reads the time from performance.now by default` | `test/view-cache.test.ts` | The default clock |
| `reads the RPC again 2 seconds after its read was sent, and once the clock has gone back` | `test/page-view-cache.test.ts` | The same bounds through `POST /rpc` |
| `reads a pool once for the callers within 2 seconds of its read, and again at 2 seconds` | `test/pool-cache.test.ts` | The same bounds for redemptions' pool reads |
| `answers redemptions within 2 seconds from one read of the pool, and reads it again at 2 seconds` | `test/pool-cache.test.ts` | A pool filled meanwhile answers `202` at 1,999 ms and `200` at 2,000 ms |

## Which reads are cached

Every reader of `get_pool` and `list_pools`, and of the other two cached views (`get_seats` and
`ft_balance_of`). Lines are those of `main` before this plan. A cached answer is at most 2,000 ms
old, counted from when its read was sent. A pool's status only moves forward (Open to Filled to
Settled, Open to Expired to Refunded) and `taken` only grows, so a stale view shows a pool less far
along than it is, or `null` for a pool opened since.

| Reader | File:line | Finality | Decision taken from the answer | Cached? | An answer up to 2,000 ms old: wrong decision or only a delay, and why |
|---|---|---|---|---|---|
| Live page, pool selector: `list_pools` | `apps/web/app.js:226-228` | `final` | Display only: the options and the default pool | **Yes** (Task 2) | **Delay only.** A new pool appears in the selector up to 2 s later |
| Live page, pool card: `get_pool` | `apps/web/app.js:233` | `final` | Display only. Its `block_hash` anchors the seats and balance reads (`app.js:242`) | **Yes** (Task 2) | **Delay only.** The card is up to one refresh older. The whole `result` is served with its own `block_hash`, so the card, its seats and the balance still come from one block |
| Live page, buyer table and ledger: `get_seats` | `apps/web/app.js:244-246` | `block_id`: that block hash | Display only | **Yes** (Task 2) | **Neither.** An answer at a fixed block hash never changes |
| Live page, held balance: `ft_balance_of` (pools contract) | `apps/web/app.js:247` | `block_id`: that block hash | Display only | **Yes** (Task 2) | **Neither**, for the same reason |
| Live page, token metadata: `ft_metadata` | `apps/web/app.js:206` | `final` | Decimals and symbol, once per page load | No | Not polled: nothing to save |
| `GET /pools` | `apps/gateway/src/app.ts:58` → `openPoolListings`, `pools.ts:31-45` → `listServedPools`, `pools.ts:8-16` | optimistic | Which open pools are listed (`pools.ts:34`) | No | Would be a delay only: a pool that has just filled or passed its deadline stays listed up to 2 s longer, and the offer and the payment refuse it. Left uncached: it is read once per listing, not polled |
| Offer | `servedPool`, `apps/gateway/src/handle-offer.ts:61` | optimistic | `404`, `410`, `409` or `402` with the seats on offer | No | No wrong outcome, but a `402` for a pool that has just filled leads a buyer to sign a payment that the payment's own check then refuses: more reads, not fewer |
| Payment, before the relay | `servedPool`, `apps/gateway/src/handle-payment.ts:87`; check 6 at `:171-173` | optimistic | `pool_closed`, or relay | **No** | **Wrong decision.** A stale Open status or `taken` passes check 6, and the payment is relayed into a full pool: the relayer spends gas and the buyer gets `409`. Uncached, the view can still age while the endpoint answers 429: Task 4's retry can make the pool view and the final block that check 6 judges up to about 10 seconds old at relay time, with the same outcome. That is accepted, since the contract takes no seat and the alternative is a `503` (Task 4) |
| Payment, after the relay | `deps.chain.getPool`, `apps/gateway/src/handle-payment.ts:265`; `seatLeft` at `:270` | optimistic | `410`, `502 relay_failed` or `409 no_seats_taken` | **No** | **Uncached.** Through Task 3's cache it would be correct only because of the clear-before-return ordering: `clearAfterSends` clears the cache before the relay's result reaches the handler. It is one read per lost race, so there is nothing to save, and the `409`/`502` choice should not depend on that ordering |
| Payment, check 7: `ft_balance_of` (buyer) | `chain.ftBalanceOf`, `apps/gateway/src/handle-payment.ts:174` | optimistic | `insufficient_balance` | No | Not a cached view: the forward's cache is reached only through `POST /rpc`, and the gateway reads through `RpcChain` |
| Redemption | `servedPool`, `apps/gateway/src/handle-redeem.ts:35` (read before the proof is checked, `:39`); `null` answers `404 unknown_pool` (`:36`); the reply by status (`:63-85`) | optimistic | `202` pending, `200` credential, `410` refund | **Yes** (Task 3), never `null`, cleared after each of the gateway's own transactions | **Delay only.** Since the status only moves forward, a view up to 2 s old answers `202` where `200` or `410` is due, never a credential or a refund the pool does not support, and the buyer polls again. The seats and the `410` status come from the uncached `getBuyer` (`:53`). A cached `null` would answer `404 unknown_pool` for a pool opened since, which ends a scripted buyer `failed` (`apps/swarm/src/buyer-agent.ts:536-537`), so `null` is never stored |
| Keeper | `listServedPools`, `apps/gateway/src/keeper.ts:103`; the call chosen at `:156-164`; sent at `:167` | optimistic | `settle` or `refund` | **No** | **Wrong decision.** A view older than a `settle` or `refund` already sent (anyone's, or its own when the call's result came back unknown: both methods are open to anyone, spec section 5.4) still shows Filled or Expired, and the keeper sends the call again: it fails on chain or does nothing, spends gas, records a failed call in the feed and backs off |
| Demo start route: `list_pools` through `listServedPools(deps.chain, …)`, in the handler of `POST /demo/<scenario>` in `apps/gateway/src/app.ts` (present once the gateway has a demo endpoint; not on `main` before it) | Its handler | optimistic | `409 pool_open`, or start a run | **No** | **Wrong decision.** A view up to 2 s old that does not yet show a pool that has just opened starts a run that stops at once, because the swarm opens no pool while one of the provider's is Open, and the run still counts against the daily cap. A stale Open for a pool that has since filled is only a delay (`409 pool_open` for a moment). Read through `deps.chain`, uncached |
| Any other route that reads `get_pool` or `list_pools` | Its own | Its own | Its own | **No** | Reads `deps.chain`, never `deps.redeemPools`. A route added later records its own row in the commit that adds it, or in the design spec, with its decision and what an answer up to 2,000 ms old does to it, and stays uncached |

The two caches never share an answer: the page reads at `final` or at a block hash, the gateway at
`optimistic`, and each cache is its own instance in its own module.

## What stays out

- **No rate limit on `/rpc`.** Each distinct request still costs one read; a known limit of the
  design (spec section 12).
- **No change to the relayer.** `apps/gateway/src/relayer.ts` and `providers.ts` are not touched. The
  relayer's provider is not wrapped and still posts each request once; a transaction is never
  re-posted or retried.
- **No 429 retry in the `POST /rpc` forward.** The page reads again at its next refresh, and a retry
  in the gateway would add reads while the endpoint is refusing them. A 429 passes through as before.
- **No change to `packages/**`** or to `apps/web`. near-api-js makes a 429 answer's body the error's
  message, and `packages/buyer/src/errors.ts` `redact` replaces only the RPC URL as given, so a
  possible follow-up is to bound what a buyer prints of such a message.

## Global Constraints

- **Node 22.22.2** (the root `package.json` requires `>=22.22.2`), pnpm through Corepack at the
  version the root `package.json` names. TypeScript runs by Node's type stripping: erasable syntax
  only, `.ts` import extensions, no build step.
- **No new dependency** in any package. The retry's default wait is `setTimeout` from
  `node:timers/promises`.
- **Test first:** every behaviour gets a failing test before its code, in the gateway's existing
  vitest suite. Tests move clocks by hand and inject `sleep`; two Task 2 tests poll with
  `vi.waitFor` until every request has reached the cache.
- **The relayer stays single-post:** `apps/gateway/src/relayer.ts` and `providers.ts` are not
  changed, and no provider that reaches `RpcRelayer` is wrapped. A transaction is never posted twice.
- **The TTL and the bound** are the constants `VIEW_CACHE_TTL_MS = 2_000` and
  `VIEW_CACHE_MAX_ENTRIES = 64`; the retry's waits are the constant `VIEW_RETRY_WAITS_MS = [200, 400, 800]`.
  None is a setting; `apps/gateway/src/config.ts` is not changed.
- **Display only through the forward's cache:** no gateway decision reads it.
- **Uncached:** a payment's own checks and its read after the relay, the offer, the keeper,
  `GET /pools` and any other route that reads a pool read the chain directly.
- **The new modules log nothing.** Failures reach the existing catches, which log as before.
- **Unchanged:** `packages/**`, `apps/web`, `apps/swarm`, `apps/mcp`, every `.env.example`,
  `package.json` and `pnpm-lock.yaml`.
- **`apps/gateway/src/main.ts`, `app.ts` and `config.ts`:** small edits, each with its anchor;
  adapt anchors to the code and keep the behaviour.
- **No secrets:** no RPC URL with a key in code, tests, logs or docs. Tests use `http://rpc.invalid`.
- **Say what is simulated:** the provider and its access are simulated; never call them a partner,
  a booking or a reservation.
- **Commits:** neutral, technical, present tense, the subject in lower case like the repository's
  recent commits; one commit per task. Work on `fix/gateway-rpc-load`. Each heredoc gives the
  message; the executor adds its session's attribution trailer under it.

## File Structure

| File | Task | Responsibility |
|---|---|---|
| `apps/gateway/src/view-cache.ts` | 1 | `ViewCache<T>`, `VIEW_CACHE_TTL_MS`, `VIEW_CACHE_MAX_ENTRIES`: the life, the bound, one read in flight per key, `clear()` |
| `apps/gateway/test/view-cache.test.ts` | 1 | Its tests, on a hand-moved clock |
| `apps/gateway/src/page-view-cache.ts` | 2 | `cachePageViews`: a `typeof fetch` that answers four of the live page's views from a `ViewCache` |
| `apps/gateway/test/page-view-cache.test.ts` | 2 | Its tests, through `createApp` and a counting fake fetch |
| `apps/gateway/src/app.ts` | 2 | One import and one changed line: the forward's fetch |
| `apps/gateway/src/pool-cache.ts` | 3 | `poolViewCache`, `cachePoolReads`, `clearAfterSends`: redemptions' pool reads and the clear after each transaction |
| `apps/gateway/test/pool-cache.test.ts` | 3 | Their tests, alone and through `createApp` |
| `apps/gateway/src/pools.ts` | 3 | `PoolReader`, the one read `servedPool` makes |
| `apps/gateway/src/deps.ts` | 3 | The optional `redeemPools` member |
| `apps/gateway/src/handle-redeem.ts` | 3 | One changed line: redemptions read `redeemPools` |
| `apps/gateway/src/main.ts` | 3, 4 | The wiring: the pool cache and the clearing writer (3); the retrying view provider (4) |
| `apps/gateway/src/view-retry.ts` | 4 | `retryViewsOn429`, `ViewProvider`, `VIEW_RETRY_WAITS_MS` |
| `apps/gateway/test/view-retry.test.ts` | 4 | Its tests, over fakes and over a real `JsonRpcProvider` under `RpcChain` |
| `apps/gateway/src/rpc-chain.ts` | 4 | `ChainProvider`, the three methods `RpcChain` reads with |
| `docs/specs/2026-11-09-quorum-on-near-design.md` | 2, 3, 4 | Section 6.1 `POST /rpc` and section 12 (2), section 6.5 (3), section 9 (4) |

## Before Task 1

Work on the branch `fix/gateway-rpc-load`, from `main`, with a clean tree: `git fetch origin`, then
`git switch --no-track -c fix/gateway-rpc-load origin/main`. Then install the workspace and run the
gateway's suite:

```bash
pnpm install --frozen-lockfile
pnpm --filter @quorum-on-near/gateway test
```

Expected: pnpm reports `Lockfile is up to date, resolution step is skipped` and installs; the suite
ends with

```text
 Test Files  18 passed (18)
      Tests  635 passed (635)
```

If the counts are higher, write them down, since each task's steps give its increment. No task of
this plan adds a dependency or changes another package. In `pnpm test` from the root, every other package passes before and after every task, with the
counts it has before Task 1: no task changes them.

---

### Task 1: `ViewCache`, a short-lived cache with one read in flight per key

A generic, bounded, in-memory cache of view answers, used by Tasks 2 and 3:

- an answer is fresh while `0 <= now() - sentAtMs < VIEW_CACHE_TTL_MS` (2,000 ms), `sentAtMs` being
  when its read was sent; an age below zero (a clock that went back) counts as expired;
- a caller with no fresh answer joins the key's read in flight if that read was sent less than the
  TTL ago and no `clear()` came after it; otherwise it sends a new read;
- a read that rejects stores nothing, and every caller that joined it gets the same rejection; an
  answer the optional `keep` predicate refuses reaches every caller and is not stored;
- `clear()` forgets every stored answer and starts a new generation: a read sent before it stores
  nothing and is joined by no one;
- each store drops the expired answers, then the oldest stored while 64 are kept;
- the clock is `performance.now()` unless one is injected; the module logs nothing and sets no
  timer.

Callers share an answer: it is never copied. Task 2 builds a new response per caller, and Task 3
hands each caller a copy. Nothing uses the cache yet, so this task changes no existing file and adds
no sentence to the spec.

**Files:**
- Create: `apps/gateway/src/view-cache.ts`
- Test: `apps/gateway/test/view-cache.test.ts`

**Interfaces:**
- Consumes: `performance.now()` (a Node global). Nothing from the gateway.
- Produces:

```typescript
// apps/gateway/src/view-cache.ts
export const VIEW_CACHE_TTL_MS = 2_000;
export const VIEW_CACHE_MAX_ENTRIES = 64;
export interface ViewCacheOptions<T> {
  now?: () => number; // default () => performance.now()
  keep?: (value: T) => boolean; // default: every answer
}
export class ViewCache<T> {
  constructor(options?: ViewCacheOptions<T>);
  get size(): number;
  get(key: string, read: () => Promise<T>): Promise<T>;
  clear(): void;
}
```

- [ ] **Step 1: Write the failing test**

Create `apps/gateway/test/view-cache.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { ViewCache } from '../src/view-cache.ts';

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

/** A read that answers 'answer 1', 'answer 2', … in turn, so that a test can tell its reads apart. */
function numberedRead(): Mock<() => Promise<string>> {
  let count = 0;
  return vi.fn(async () => {
    count += 1;
    return `answer ${count}`;
  });
}

/** The cache's clock, which tests move by hand. */
let clock: number;
let cache: ViewCache<string>;

beforeEach(() => {
  clock = 1_000;
  cache = new ViewCache<string>({ now: () => clock });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ViewCache', () => {
  it('serves a stored answer until 1 ms before 2 seconds, and reads again at 2 seconds', async () => {
    const read = numberedRead();
    expect(await cache.get('k', read)).toBe('answer 1');
    clock = 1_000 + 1_999;
    expect(await cache.get('k', read)).toBe('answer 1');
    expect(read).toHaveBeenCalledTimes(1);
    clock = 1_000 + 2_000;
    expect(await cache.get('k', read)).toBe('answer 2');
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('keeps each key apart', async () => {
    const read = numberedRead();
    expect(await cache.get('a', read)).toBe('answer 1');
    expect(await cache.get('b', read)).toBe('answer 2');
    expect(await cache.get('a', read)).toBe('answer 1');
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("counts an answer's age from when its read was sent, not from when it arrived", async () => {
    const answer = deferred<string>();
    const read = vi.fn(() => answer.promise);
    const first = cache.get('k', read);
    clock = 2_500;
    answer.resolve('slow answer');
    expect(await first).toBe('slow answer');
    clock = 1_000 + 1_999;
    expect(await cache.get('k', read)).toBe('slow answer');
    expect(read).toHaveBeenCalledTimes(1);
    clock = 1_000 + 2_000;
    read.mockResolvedValueOnce('next answer');
    expect(await cache.get('k', read)).toBe('next answer');
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('stores nothing from a read that took the whole 2 seconds', async () => {
    const answer = deferred<string>();
    const first = cache.get('k', () => answer.promise);
    clock = 1_000 + 2_000;
    answer.resolve('late answer');
    expect(await first).toBe('late answer');
    expect(cache.size).toBe(0);
  });

  it('counts a stored answer as expired once the clock has gone back', async () => {
    const read = numberedRead();
    await cache.get('k', read);
    clock = 999;
    expect(await cache.get('k', read)).toBe('answer 2');
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('joins no read in flight once the clock has gone back, and keeps the newer answer when that read ends later', async () => {
    const older = deferred<string>();
    const first = cache.get('k', () => older.promise);
    clock = 999;
    const read = numberedRead();
    expect(await cache.get('k', read)).toBe('answer 1');
    expect(read).toHaveBeenCalledTimes(1);
    clock = 1_500;
    older.resolve('older answer');
    expect(await first).toBe('older answer');
    expect(await cache.get('k', read)).toBe('answer 1');
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('shares one read between the callers that ask while it is in flight', async () => {
    const answer = deferred<{ pool: number }>();
    const objects = new ViewCache<{ pool: number }>({ now: () => clock });
    const read = vi.fn(() => answer.promise);
    const first = objects.get('k', read);
    clock = 1_000 + 1_999;
    const second = objects.get('k', read);
    expect(read).toHaveBeenCalledTimes(1);
    const value = { pool: 7 };
    answer.resolve(value);
    expect(await first).toBe(value);
    expect(await second).toBe(value);
  });

  it('sends a new read rather than join one sent 2 seconds ago, and keeps the newer answer when the older one ends later', async () => {
    const older = deferred<string>();
    const newer = deferred<string>();
    const read = vi.fn<() => Promise<string>>().mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    const first = cache.get('k', read);
    clock = 1_000 + 2_000;
    const second = cache.get('k', read);
    expect(read).toHaveBeenCalledTimes(2);
    newer.resolve('newer answer');
    expect(await second).toBe('newer answer');
    older.resolve('older answer');
    expect(await first).toBe('older answer');
    expect(await cache.get('k', read)).toBe('newer answer');
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('gives every caller an answer that keep refuses, and stores none of it', async () => {
    const pools = new ViewCache<number | null>({ now: () => clock, keep: (pool) => pool !== null });
    const answer = deferred<number | null>();
    const read = vi.fn<() => Promise<number | null>>().mockReturnValueOnce(answer.promise).mockResolvedValueOnce(7);
    const first = pools.get('k', read);
    const second = pools.get('k', read);
    answer.resolve(null);
    expect(await first).toBeNull();
    expect(await second).toBeNull();
    expect(pools.size).toBe(0);
    expect(await pools.get('k', read)).toBe(7);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('gives every caller of a read that fails the same error, and stores nothing', async () => {
    const answer = deferred<string>();
    const failure = new Error('Too Many Requests', { cause: 429 });
    const first = cache.get('k', () => answer.promise);
    const second = cache.get('k', () => answer.promise);
    answer.reject(failure);
    await expect(first).rejects.toBe(failure);
    await expect(second).rejects.toBe(failure);
    expect(cache.size).toBe(0);
    const read = numberedRead();
    expect(await cache.get('k', read)).toBe('answer 1');
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('rejects when the read throws before it returns a promise', async () => {
    const failure = new Error('could not build the request');
    const throwing = (): Promise<string> => {
      throw failure;
    };
    await expect(cache.get('k', throwing)).rejects.toBe(failure);
    const read = numberedRead();
    expect(await cache.get('k', read)).toBe('answer 1');
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('forgets every stored answer on clear', async () => {
    const read = numberedRead();
    await cache.get('a', read);
    await cache.get('b', read);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(await cache.get('a', read)).toBe('answer 3');
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('stores nothing from a read sent before clear, and lets no later caller join it', async () => {
    const before = deferred<string>();
    const after = deferred<string>();
    const read = vi.fn<() => Promise<string>>().mockReturnValueOnce(before.promise).mockReturnValueOnce(after.promise);
    const first = cache.get('k', read);
    cache.clear();
    const second = cache.get('k', read);
    expect(read).toHaveBeenCalledTimes(2);
    after.resolve('answer after clear');
    expect(await second).toBe('answer after clear');
    before.resolve('answer before clear');
    expect(await first).toBe('answer before clear');
    expect(await cache.get('k', read)).toBe('answer after clear');
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('stores nothing from a read sent before clear, even when no later read replaced it', async () => {
    const before = deferred<string>();
    const first = cache.get('k', () => before.promise);
    cache.clear();
    before.resolve('answer before clear');
    expect(await first).toBe('answer before clear');
    expect(cache.size).toBe(0);
  });

  it('keeps at most 64 answers, dropping the one stored first', async () => {
    const read = numberedRead();
    for (let key = 0; key <= 64; key += 1) await cache.get(`k${key}`, read);
    expect(cache.size).toBe(64);
    expect(read).toHaveBeenCalledTimes(65);
    await cache.get('k1', read);
    expect(read).toHaveBeenCalledTimes(65);
    await cache.get('k0', read);
    expect(read).toHaveBeenCalledTimes(66);
  });

  it('drops every expired answer when it stores one', async () => {
    const read = numberedRead();
    clock = 0;
    await cache.get('a', read);
    clock = 1;
    await cache.get('b', read);
    clock = 1_500;
    await cache.get('c', read);
    expect(cache.size).toBe(3);
    clock = 2_001;
    await cache.get('d', read);
    expect(cache.size).toBe(2);
    expect(await cache.get('c', read)).toBe('answer 3');
  });

  it('reads the time from performance.now by default', async () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(50_000);
    const monotonic = new ViewCache<string>();
    const read = numberedRead();
    await monotonic.get('k', read);
    now.mockReturnValue(50_000 + 1_999);
    expect(await monotonic.get('k', read)).toBe('answer 1');
    now.mockReturnValue(50_000 + 2_000);
    expect(await monotonic.get('k', read)).toBe('answer 2');
    expect(now).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm --filter @quorum-on-near/gateway test test/view-cache.test.ts`

Expected: FAIL, since the module does not exist yet:

```text
 ❯ test/view-cache.test.ts (0 test)

⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  test/view-cache.test.ts [ test/view-cache.test.ts ]
Error: Cannot find module '../src/view-cache.ts' imported from …/apps/gateway/test/view-cache.test.ts
 ❯ test/view-cache.test.ts:2:1

 Test Files  1 failed (1)
      Tests  no tests
 ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  @quorum-on-near/gateway@0.1.0 test: `vitest run --exclude "test/sandbox/**" "test/view-cache.test.ts"`
Exit status 1
```

- [ ] **Step 3: Write the cache**

Create `apps/gateway/src/view-cache.ts`:

```typescript
/**
 * How long a stored answer is served, in milliseconds, counted from when its read was sent. The live
 * page refreshes every 2 seconds, so a cached view costs at most one read per 2 seconds however many
 * pages are open. A scripted buyer polls its redemption every 5 seconds by default, so it never gets
 * the same cached answer on two polls in a row.
 */
export const VIEW_CACHE_TTL_MS = 2_000;
/** The most answers a cache keeps. Its keys come from requests (a pool id, a view's arguments), so any caller can add one. */
export const VIEW_CACHE_MAX_ENTRIES = 64;

/** How a ViewCache is set up. */
export interface ViewCacheOptions<T> {
  /** The cache's clock, in milliseconds. Default `performance.now()`, which never goes back. */
  now?: () => number;
  /** Whether an answer may be stored. One it refuses still answers every caller of its read. Default: every answer. */
  keep?: (value: T) => boolean;
}

/** A stored answer. */
interface Entry<T> {
  value: T;
  /** When its read was sent, by the cache's clock. */
  sentAtMs: number;
}

/** A read in flight, which callers of the same key may join. */
interface Pending<T> {
  promise: Promise<T>;
  /** When it was sent, by the cache's clock. */
  sentAtMs: number;
  /** The cache's generation when it was sent. A `clear()` since then means its answer is not stored. */
  generation: number;
}

/**
 * A short-lived, bounded, in-memory cache of view answers, with one read in flight per key.
 *
 * - An answer is fresh while `0 <= now() - sentAtMs < VIEW_CACHE_TTL_MS`, `sentAtMs` being when its
 *   read was sent, not when it arrived: every answer a caller gets was requested less than the TTL
 *   before the caller asked. An age below zero (a clock that went back) counts as expired.
 * - A caller with no fresh answer joins the key's read in flight if that read was sent less than the
 *   TTL ago and no `clear()` came after it; otherwise it sends a new read.
 * - A read stores its answer only if it is still the key's latest read, no `clear()` came after it was
 *   sent, and `keep` accepts the answer. A read that rejects stores nothing, and every caller that
 *   joined it gets the same rejection.
 * - Each store first drops every expired answer, then the oldest stored while VIEW_CACHE_MAX_ENTRIES
 *   are kept.
 *
 * Callers share an answer: it is never copied, so they must not change it.
 */
export class ViewCache<T> {
  readonly #now: () => number;
  readonly #keep: (value: T) => boolean;
  /** The stored answers, in the order they were stored: the oldest first. */
  readonly #entries = new Map<string, Entry<T>>();
  /** The latest read sent for each key, while it is in flight. */
  readonly #pending = new Map<string, Pending<T>>();
  /** Counts the calls to `clear()`. */
  #generation = 0;

  constructor(options: ViewCacheOptions<T> = {}) {
    this.#now = options.now ?? (() => performance.now());
    this.#keep = options.keep ?? (() => true);
  }

  /** The answers stored, fresh or expired but not yet dropped. */
  get size(): number {
    return this.#entries.size;
  }

  /** The answer for `key`: a fresh stored one, the one of the read in flight, or the one `read` sends now. */
  get(key: string, read: () => Promise<T>): Promise<T> {
    const nowMs = this.#now();
    const entry = this.#entries.get(key);
    if (entry !== undefined && this.#isFresh(entry.sentAtMs, nowMs)) return Promise.resolve(entry.value);
    const pending = this.#pending.get(key);
    if (pending !== undefined && pending.generation === this.#generation && this.#isFresh(pending.sentAtMs, nowMs)) {
      return pending.promise;
    }
    return this.#send(key, read, nowMs);
  }

  /** Forgets every stored answer. A read in flight still answers its callers, but stores nothing and is joined by no one. */
  clear(): void {
    this.#entries.clear();
    this.#generation += 1;
  }

  /** Sent less than the TTL ago. A clock that went back makes nothing fresh. */
  #isFresh(sentAtMs: number, nowMs: number): boolean {
    const ageMs = nowMs - sentAtMs;
    return ageMs >= 0 && ageMs < VIEW_CACHE_TTL_MS;
  }

  #send(key: string, read: () => Promise<T>, sentAtMs: number): Promise<T> {
    // `read` is called at once, so the request is sent now; one that throws before it returns a
    // promise rejects like one that fails later.
    const sent = new Promise<T>((resolve) => resolve(read()));
    const pending: Pending<T> = {
      sentAtMs,
      generation: this.#generation,
      promise: sent.then(
        (value) => {
          if (this.#pending.get(key) === pending) {
            this.#pending.delete(key);
            if (pending.generation === this.#generation && this.#keep(value)) this.#store(key, value, sentAtMs);
          }
          return value;
        },
        (error: unknown) => {
          if (this.#pending.get(key) === pending) this.#pending.delete(key);
          throw error;
        },
      ),
    };
    this.#pending.set(key, pending);
    return pending.promise;
  }

  #store(key: string, value: T, sentAtMs: number): void {
    const nowMs = this.#now();
    for (const [k, entry] of this.#entries) {
      if (!this.#isFresh(entry.sentAtMs, nowMs)) this.#entries.delete(k);
    }
    // A read that took the whole TTL has nothing left to serve.
    if (!this.#isFresh(sentAtMs, nowMs)) return;
    // Deleted first, so that the key is stored again as the newest.
    this.#entries.delete(key);
    for (const oldest of this.#entries.keys()) {
      if (this.#entries.size < VIEW_CACHE_MAX_ENTRIES) break;
      this.#entries.delete(oldest);
    }
    this.#entries.set(key, { value, sentAtMs });
  }
}
```

- [ ] **Step 4: Run it and see it pass**

Run: `pnpm --filter @quorum-on-near/gateway test test/view-cache.test.ts`

Expected:

```text
 Test Files  1 passed (1)
      Tests  17 passed (17)
```

- [ ] **Step 5: Typecheck the gateway**

Run: `pnpm --filter @quorum-on-near/gateway typecheck`

Expected: exit code 0; `tsc` prints nothing after pnpm's two lines naming the script:

```text
> @quorum-on-near/gateway@0.1.0 typecheck …/apps/gateway
> tsc -p tsconfig.json
```

- [ ] **Step 6: Run the gateway's suite**

Run: `pnpm --filter @quorum-on-near/gateway test`

Expected: exit code 0, 17 tests and 1 file more than before this task:

```text
 Test Files  19 passed (19)
      Tests  652 passed (652)
```

- [ ] **Step 7: Typecheck and test the whole workspace**

```bash
pnpm typecheck
pnpm test
```

Expected: both exit 0. Among its lines, `pnpm typecheck` prints a `Done` line for each project (the
order varies, since the projects run in parallel):

```text
apps/web typecheck: Done
packages/protocol typecheck: Done
packages/buyer typecheck: Done
apps/gateway typecheck: Done
apps/mcp typecheck: Done
apps/swarm typecheck: Done
```

In `pnpm test`, every package passes; the gateway's lines read

```text
apps/gateway test:  Test Files  19 passed (19)
apps/gateway test:       Tests  652 passed (652)
```

and every other package passes with the counts it had before the task.

- [ ] **Step 8: Commit**

```bash
git add apps/gateway/src/view-cache.ts apps/gateway/test/view-cache.test.ts
git commit -q -F - <<'EOF'
add a short-lived view cache with one read in flight per key

ViewCache<T> keeps view answers in memory for VIEW_CACHE_TTL_MS (2 s),
counted from when each read was sent, so every answer a caller gets was
requested less than 2 s before it asked. Callers that ask while a read of
the same key is in flight share it, if it was sent less than 2 s ago. A
read that rejects, or whose answer the keep option refuses, stores
nothing, and every caller that joined it gets the same outcome. clear()
starts a new generation: a read sent before it stores nothing and is
joined by no one. The cache keeps at most VIEW_CACHE_MAX_ENTRIES (64)
answers, dropping the expired ones and then the oldest on each store. Its
clock is performance.now() unless one is injected, and an age below zero
counts as expired.

Nothing uses the cache yet.
EOF
git show --stat --format= HEAD
```

Expected:

```text
 apps/gateway/src/view-cache.ts       | 135 +++++++++++++++++++
 apps/gateway/test/view-cache.test.ts | 250 +++++++++++++++++++++++++++++++++++
 2 files changed, 385 insertions(+)
```

---

### Task 2: The live page's views, from the cache, in the `POST /rpc` forward

`cachePageViews(inner, accounts)` is a `typeof fetch` built around the fetch the `/rpc` route already
takes (`options.fetch ?? fetch`). The route's own checks run first and stay as they are: its body
limit, its JSON parse, `isAllowedViewCall`, its `AbortSignal.timeout`, its catch and its log line.

- **Cached:** `get_pool` and `list_pools` on the pools contract at `final` finality; `get_seats` on
  the pools contract and `ft_balance_of` on the token at a `block_id` that is a block hash (base58,
  32 to 44 characters), since an answer at a fixed block hash never changes. A numeric `block_id` is
  never cached: a height can name a block that is not final yet. Nothing else is cached; every other
  request reaches `inner` with the same arguments, and its `Response` comes back as it is.
- **The key:** the block reference with its kind (`finality` or `block_id`), `account_id`,
  `method_name` and `args_base64` exactly as sent. The wrapper runs `isAllowedViewCall` again before
  it makes a key, since the key leaves out the fields that rule fixes.
- **Stored:** only HTTP 200 with a JSON-RPC result holding a view's bytes and a block hash, and no
  `error` at either level. A non-200 answer, a JSON-RPC `error` or a contract error reaches every
  caller that shared the read, at its status, and is not stored.
- **Each caller's own `id`:** a stored or shared answer is sent to each caller as a new response
  with that caller's JSON-RPC `id`, of the same type. A body that is not a JSON-RPC answer is passed
  on unchanged.
- **Failures:** a rejected fetch, or an answer whose body is not JSON, rejects every request that
  shared the read into the route's existing catch: one log line and `503 chain_unavailable` per
  request, as before.
- **No 429 retry here:** a 429 passes through as before, and the page reads again at its next
  refresh.
- **Display only:** the gateway's own reads go through `RpcChain` and near-api-js, never through
  this fetch.

A request that joins a read in flight waits on the first request's fetch, and so on its 10-second
timeout. It joins less than 2 seconds after that read was sent, so it is answered before its own
timeout would end.

**Files:**
- Create: `apps/gateway/src/page-view-cache.ts`
- Modify: `apps/gateway/src/app.ts` (one import; the line that builds the forward's fetch)
- Modify: `docs/specs/2026-11-09-quorum-on-near-design.md` (section 6.1, the `POST /rpc` row; section
  12, the bullet on the live page's refreshes)
- Test: `apps/gateway/test/page-view-cache.test.ts`

**Interfaces:**
- Consumes: `ViewCache<T>` and its `keep` option (Task 1); `isAllowedViewCall(body: unknown, accounts: string[]): boolean`
  from `apps/gateway/src/view-call.ts`; `createApp(deps: Deps, options: { fetch?: typeof fetch } = {}): Hono`
  from `apps/gateway/src/app.ts`; in the tests, `testDeps(overrides: Partial<Deps> = {}): Promise<Deps & { fake: FakeChain }>`
  from `test/handler-deps.ts`, and `testConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig`,
  `POOLS` and `TOKEN` from `test/fake-chain.ts`.
- Produces:

```typescript
// apps/gateway/src/page-view-cache.ts
export interface PageViewAccounts {
  poolsContract: string;
  token: string;
}
export function cachePageViews(inner: typeof fetch, accounts: PageViewAccounts): typeof fetch;
```

One `ViewCache` per `cachePageViews` call, so one per `createApp` with `rpcPassthrough: true`. It is
never cleared.

- [ ] **Step 1: Write the failing test**

Create `apps/gateway/test/page-view-cache.test.ts`:

```typescript
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
```

The tests spy on `performance.now` (the cache's default clock) and move it by hand, since
`createApp` takes no clock. A request joins a read in flight in the tests that wait, with
`vi.waitFor`, until a spy on `ViewCache.prototype.get` has seen every request before the fake RPC
answers.

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm --filter @quorum-on-near/gateway test test/page-view-cache.test.ts`

Expected: FAIL, since the module does not exist yet:

```text
 ❯ test/page-view-cache.test.ts (0 test)

⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  test/page-view-cache.test.ts [ test/page-view-cache.test.ts ]
Error: Cannot find module '../src/page-view-cache.ts' imported from …/apps/gateway/test/page-view-cache.test.ts
 ❯ test/page-view-cache.test.ts:4:1

 Test Files  1 failed (1)
      Tests  no tests
 ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  @quorum-on-near/gateway@0.1.0 test: `vitest run --exclude "test/sandbox/**" "test/page-view-cache.test.ts"`
Exit status 1
```

- [ ] **Step 3: Write the module**

Create `apps/gateway/src/page-view-cache.ts`:

```typescript
import { ViewCache } from './view-cache.ts';
import { isAllowedViewCall } from './view-call.ts';

/** A block hash as the RPC writes it: 32 bytes in base58, which takes 32 to 44 characters. */
const BLOCK_HASH = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** The accounts whose views the forward may answer from memory. */
export interface PageViewAccounts {
  poolsContract: string;
  token: string;
}

/** An answer of the RPC as the forward reads it: its HTTP status and its JSON body. */
interface RpcAnswer {
  status: number;
  body: unknown;
}

/** The fields this module reads of a view call that isAllowedViewCall accepted. */
interface ViewCall {
  id: string | number;
  params: {
    account_id: string;
    method_name: string;
    args_base64: string;
    finality?: string;
    block_id?: string | number;
  };
}

type Fields = Record<string, unknown>;

function isFields(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The view call a forwarded request carries, or null when its body is not one the pass-through allows. */
function viewCallOf(init: RequestInit | undefined, accounts: PageViewAccounts): ViewCall | null {
  if (typeof init?.body !== 'string') return null;
  let body: unknown;
  try {
    body = JSON.parse(init.body);
  } catch {
    return null;
  }
  // The pass-through's own rule fixes `jsonrpc`, `method` and `request_type`, and allows no other
  // field, so a key made of the remaining fields covers everything the answer depends on.
  return isAllowedViewCall(body, [accounts.poolsContract, accounts.token]) ? (body as ViewCall) : null;
}

/**
 * The cache key of one of the live page's views, or null for a call that is never cached:
 * `get_pool` and `list_pools` on the pools contract at `final` finality, and `get_seats` on the
 * pools contract and `ft_balance_of` on the token at a block hash. The key holds the block reference
 * with its kind, the account, the method and `args_base64` as sent, and leaves out the `id`.
 */
function pageViewKey({ params }: ViewCall, accounts: PageViewAccounts): string | null {
  const { account_id: account, method_name: method, args_base64: args } = params;
  if ('finality' in params) {
    const cached = params.finality === 'final' && account === accounts.poolsContract && (method === 'get_pool' || method === 'list_pools');
    return cached ? JSON.stringify(['finality', params.finality, account, method, args]) : null;
  }
  // An answer at a block hash never changes. A height is left out: it can name a block that is not
  // final yet.
  const block = params.block_id;
  const cached =
    typeof block === 'string' &&
    BLOCK_HASH.test(block) &&
    ((account === accounts.poolsContract && method === 'get_seats') || (account === accounts.token && method === 'ft_balance_of'));
  return cached ? JSON.stringify(['block_id', block, account, method, args]) : null;
}

/**
 * Whether an answer may be stored: HTTP 200 and a JSON-RPC result holding a view's bytes and the
 * hash of the block they were read at, with no error at either level.
 */
function isViewResult({ status, body }: RpcAnswer): boolean {
  if (status !== 200 || !isFields(body) || body.jsonrpc !== '2.0' || Object.hasOwn(body, 'error')) return false;
  const { result } = body;
  return isFields(result) && !Object.hasOwn(result, 'error') && Array.isArray(result.result) && typeof result.block_hash === 'string';
}

/**
 * `answer` as a response of its own, with the caller's JSON-RPC id when its body is a JSON-RPC answer.
 * The stored body is shared by every caller, so it is copied, never changed.
 */
function reply({ status, body }: RpcAnswer, id: string | number): Response {
  const json = isFields(body) && Object.hasOwn(body, 'jsonrpc') ? { ...body, id } : body;
  return new Response(JSON.stringify(json), { status, headers: { 'Content-Type': 'application/json' } });
}

/**
 * `inner`, the `POST /rpc` forward's fetch, answering the live page's repeated views (pageViewKey)
 * from a ViewCache: an answer is served for VIEW_CACHE_TTL_MS from when its read was sent, and the
 * requests for a view that arrive while its read is in flight share that read. Each of them is
 * answered with its own JSON-RPC id, at the RPC's status. Only a view's result is stored
 * (isViewResult). A read that fails, or whose answer is not JSON, rejects every request that shared
 * it, as the forward's fetch would. Every other request is passed to `inner` as it came, and its
 * answer comes back as `inner` gave it.
 */
export function cachePageViews(inner: typeof fetch, accounts: PageViewAccounts): typeof fetch {
  const contracts: PageViewAccounts = { poolsContract: accounts.poolsContract, token: accounts.token };
  const cache = new ViewCache<RpcAnswer>({ keep: isViewResult });
  return async (input, init) => {
    const call = viewCallOf(init, contracts);
    const key = call === null ? null : pageViewKey(call, contracts);
    if (call === null || key === null) return inner(input, init);
    const answer = await cache.get(key, async () => {
      const upstream = await inner(input, init);
      return { status: upstream.status, body: await upstream.json() };
    });
    return reply(answer, call.id);
  };
}
```

- [ ] **Step 4: Run it and see the route still uncached**

Run: `pnpm --filter @quorum-on-near/gateway test test/page-view-cache.test.ts`

Expected: FAIL with 19 tests, since `/rpc` does not use the module yet: two upstream reads where one
is expected, the upstream's `id` where the caller's is expected, nothing reaching the cache. The 20
that pass are the 3 direct `cachePageViews` tests and the 17 that pin what must not change.

```text
 ❯ test/page-view-cache.test.ts (39 tests | 19 failed)
     × answers a repeated list_pools at final finality from one RPC read, with each caller's id
     × answers a repeated get_pool at final finality from one RPC read, with each caller's id
     × answers a repeated get_seats at a block hash from one RPC read, with each caller's id
     × answers a repeated get_seats at a block hash of 32 characters from one RPC read, with each caller's id
     × answers a repeated the token's ft_balance_of at a block hash from one RPC read, with each caller's id
     × reads the RPC again 2 seconds after its read was sent, and once the clock has gone back
     × shares one RPC read between the requests that ask while it is in flight, each answered with its own id
     × answers 503 chain_unavailable to every request that shared a read that failed, logs each once, and stores nothing
     × stores no answer that is a 429 with a JSON-RPC error, and gives it to each caller at its status, with its own id
     × stores no answer that is a 408, and gives it to each caller at its status, with its own id
     × stores no answer that is a 500, and gives it to each caller at its status, with its own id
     × stores no answer that is a view result at a status other than 200, and gives it to each caller at its status, with its own id
     × stores no answer that is a JSON-RPC error, and gives it to each caller at its status, with its own id
     × stores no answer that is an error of the contract, and gives it to each caller at its status, with its own id
     × stores no answer that is a JSON-RPC error beside a result, and gives it to each caller at its status, with its own id
     × stores no answer that is an error of the contract beside result bytes, and gives it to each caller at its status, with its own id
     × stores no answer that is a result with no bytes, and gives it to each caller at its status, with its own id
     × stores no answer that is a result with no block hash, and gives it to each caller at its status, with its own id
     × keeps views apart by block, account, method and arguments

 Test Files  1 failed (1)
      Tests  19 failed | 20 passed (39)
```

The first failure reads `AssertionError: expected "vi.fn()" to be called once, but got 2 times`.
The two tests that use `vi.waitFor` fail only after its default timeout of 1 second.

- [ ] **Step 5: Wire the forward**

In `apps/gateway/src/app.ts`, add the import. Replace:

```typescript
import { handleRedeem } from './handle-redeem.ts';
```

with:

```typescript
import { handleRedeem } from './handle-redeem.ts';
import { cachePageViews } from './page-view-cache.ts';
```

Then, inside `if (config.rpcPassthrough) {`, replace:

```typescript
    const forward = options.fetch ?? fetch;
```

with:

```typescript
    const forward = cachePageViews(options.fetch ?? fetch, config);
```

Nothing else in the route changes, and `createApp`'s doc comment is not touched. `config` is passed
as the accounts: it has `poolsContract` and `token`, which the function copies.

If `app.ts` differs: `createApp`'s options still carry `fetch?: typeof fetch`, and
`config` still has `poolsContract` and `token`. Wrap whatever fetch the `/rpc` route sends its
upstream request through in `cachePageViews(…, config)`, once per `createApp` call, and keep the
route's own checks, timeout, catch and log line around it.

- [ ] **Step 6: Run it and see it pass**

Run: `pnpm --filter @quorum-on-near/gateway test test/page-view-cache.test.ts`

Expected:

```text
 Test Files  1 passed (1)
      Tests  39 passed (39)
```

- [ ] **Step 7: State the cached views in the design spec**

In `docs/specs/2026-11-09-quorum-on-near-design.md`, section 6.1, replace the `POST /rpc` row:

```markdown
| `POST /rpc` | Only if the public RPC refuses browser requests: a read-only pass-through that forwards `call_function` view calls on the pools contract and the token, and nothing else. Any other call, or `args_base64` over 1,024 characters, is answered `403` (`not_allowed`); a body over 16 KiB `413` (`body_too_large`); a body that is not JSON `400` (`invalid_json`); and an RPC that cannot be reached `503` (`chain_unavailable`) |
```

with:

```markdown
| `POST /rpc` | Only if the public RPC refuses browser requests: a read-only pass-through that forwards `call_function` view calls on the pools contract and the token, and nothing else. Any other call, or `args_base64` over 1,024 characters, is answered `403` (`not_allowed`); a body over 16 KiB `413` (`body_too_large`); a body that is not JSON `400` (`invalid_json`); and an RPC that cannot be reached `503` (`chain_unavailable`). Four of the live page's views are answered from memory for 2 seconds after the gateway sent their read: `get_pool` and `list_pools` on the pools contract at `final` finality, and `get_seats` on the pools contract and the token's `ft_balance_of` at a block hash. Requests for one of them that arrive while its read is in flight share that read, and each answer carries its caller's JSON-RPC `id`. Only a view's result is kept: an error, or a status other than `200`, is passed on and never kept |
```

Three sentences are appended to the cell; nothing else changes. If the row reads differently, append
the same three sentences to it.

- [ ] **Step 8: State what still reaches the RPC in section 12**

In the same file, section 12, the bullet "The live page reads every seller's pools on every refresh"
ends with a sentence that the cache makes wrong. Replace:

```markdown
  the last one, and a test checks it. Through the pass-through, every
  viewer's reads reach the RPC from the gateway's address, so a public RPC's rate limit applies to
  all viewers together and shows on the page as "Could not refresh" lines.
```

with:

```markdown
  the last one, and a test checks it. Through the pass-through, each of the page's four repeated
  views (section 6.1) reaches the RPC at most once per 2 seconds for the same arguments, whatever the
  number of viewers, while its reads succeed; every other request a viewer sends, and a read that
  failed, still reaches the RPC from the gateway's address, so a public RPC's rate limit applies to
  all viewers together and shows on the page as "Could not refresh" lines.
```

The bullet's first sentences, and the `/rpc has no rate limit` bullet, are not edited: the page
still sends one `list_pools` per 100 pools at each refresh, and `/rpc` still has no rate limit.

- [ ] **Step 9: Typecheck the gateway**

Run: `pnpm --filter @quorum-on-near/gateway typecheck`

Expected: exit code 0; `tsc` prints nothing after pnpm's two lines naming the script.

- [ ] **Step 10: Run the gateway's suite**

Run: `pnpm --filter @quorum-on-near/gateway test`

Expected: exit code 0, 39 tests and 1 file more than after Task 1. `test/app.test.ts` is not changed
and passes.

```text
 Test Files  20 passed (20)
      Tests  691 passed (691)
```

- [ ] **Step 11: Typecheck and test the whole workspace**

```bash
pnpm typecheck
pnpm test
```

Expected: both exit 0; `pnpm typecheck` prints `Done` for `apps/web`, `packages/protocol`,
`packages/buyer`, `apps/gateway`, `apps/mcp` and `apps/swarm`. In `pnpm test`, every package passes;
the gateway's lines read

```text
apps/gateway test:  Test Files  20 passed (20)
apps/gateway test:       Tests  691 passed (691)
```

- [ ] **Step 12: Commit**

```bash
git add apps/gateway/src/page-view-cache.ts apps/gateway/test/page-view-cache.test.ts apps/gateway/src/app.ts docs/specs/2026-11-09-quorum-on-near-design.md
git commit -q -F - <<'EOF'
answer the live page's repeated views through POST /rpc from the view cache

The /rpc forward's fetch is now cachePageViews(options.fetch ?? fetch,
config), a fetch that answers four of the live page's views from a
ViewCache: get_pool and list_pools on the pools contract at final
finality, and get_seats on the pools contract and the token's
ft_balance_of at a block hash, whose answers never change. Requests for
one of these views that arrive while its read is in flight share that
read, so the forward's reads no longer grow with the number of open
pages. The key is the block reference with its kind, the account, the
method and args_base64 as sent.

Every caller gets the answer with its own JSON-RPC id, at the RPC's
status. Only a view's result is stored: HTTP 200, a JSON-RPC result with
bytes and a block hash, and no error at either level. A read that fails,
or whose answer is not JSON, rejects every request that shared it into
the route's existing catch, which logs once per request and answers 503,
as before. Any other request goes to the inner fetch unchanged. The
route's body limit, its JSON parse and isAllowedViewCall still run first,
and no gateway decision reads this cache.

The design spec's POST /rpc row states the cached views, and its known
limits say which of the page's requests still reach the RPC.
EOF
git show --stat --format= HEAD
```

Expected:

```text
 apps/gateway/src/app.ts                        |   3 +-
 apps/gateway/src/page-view-cache.ts            | 114 +++++++++
 apps/gateway/test/page-view-cache.test.ts      | 333 +++++++++++++++++++++++++
 docs/specs/2026-11-09-quorum-on-near-design.md |  10 +-
 4 files changed, 455 insertions(+), 5 deletions(-)
```

---

### Task 3: Redemptions' `get_pool`, cached, and cleared after the gateway's own transactions

Redemptions read a pool through `cachePoolReads(chain, cache)`, a `getPool` over a `ViewCache` keyed
by pool id, at the gateway's optimistic finality. Buyers that poll the same pool within 2 seconds of
a read share that read. Every other reader keeps reading the chain directly; the table in
[Which reads are cached](#which-reads-are-cached) gives each reason.

- **Never `null`:** `poolViewCache()` refuses to store `null`, since a stored `null` would answer
  `404 unknown_pool` for a pool opened since, and a scripted buyer ends `failed` on that answer.
- **A copy per caller:** the cache shares its answer, so each caller gets `{ ...pool }` (every
  `PoolView` field is a primitive).
- **Cleared after each transaction the gateway sends:** `clearAfterSends(writer, cache)` wraps the
  chain writer and calls `cache.clear()` in a `finally` once each `relayDelegate` (a payment's relay)
  or `callPools` (the keeper's `settle` or `refund`) has returned or thrown. A read still in flight
  at that moment stores nothing (Task 1's generation). When the transaction's result is known
  (`executed` or `rejected`), a redemption that comes after it reads the pool as that transaction
  left it, or newer; a transaction whose result is `unknown` can show up to 2 seconds late, like a
  change the gateway did not send. Clearing after a throw or a `rejected` result, which sent
  nothing, costs one read.
- **Through `Deps`:** the cached reader is the new optional member `Deps.redeemPools`, which only
  `handleRedeem` reads, falling back to `chain`. `app.ts` and `config.ts` are not touched.
  `servedPool` now takes a `PoolReader`, the one method it calls, so its other callers compile
  unchanged.

A change the gateway did not send (a deadline passing, a commit relayed elsewhere) can show up to 2
seconds late, as a `202` where a `200` or a `410` is due: a delay only.

**Files:**
- Create: `apps/gateway/src/pool-cache.ts`
- Modify: `apps/gateway/src/pools.ts` (`PoolReader`; `servedPool`'s parameter type)
- Modify: `apps/gateway/src/deps.ts` (an import; the `redeemPools` member)
- Modify: `apps/gateway/src/handle-redeem.ts:35` (the redemption's pool read)
- Modify: `apps/gateway/src/main.ts` (an import; the relayer, the cache and the clearing writer; `deps.redeemPools`)
- Modify: `docs/specs/2026-11-09-quorum-on-near-design.md` (section 6.5)
- Test: `apps/gateway/test/pool-cache.test.ts`

**Interfaces:**
- Consumes: `ViewCache<T>` (Task 1); from `apps/gateway/src/chain.ts`,
  `ChainReader.getPool(poolId: number): Promise<PoolView | null>` and
  `ChainWriter { relayDelegate(signed: DecodedSignedDelegate, maxBlockHeight: bigint): Promise<RelayResult>; callPools(method: 'settle' | 'refund', args: Record<string, unknown>, gas: bigint): Promise<RelayResult> }`;
  in the tests: from `@quorum-on-near/protocol`, `PAYMENT_HEADER`, `PROOF_HEADER`, `buildOffer`,
  `buildPaymentHeader`, `buildRedeemProofHeader`, `maxBlockHeightFor` and the types
  `DecodedSignedDelegate` and `PoolView`; `KeyPair` from `near-api-js`; `DelegateExpiredError` and
  the type `RelayResult` from `src/chain.ts`; the type `Deps` from `src/deps.ts`;
  `offerContext(config: GatewayConfig): OfferContext` from `src/handle-offer.ts`; `createApp`;
  `testDeps(overrides: Partial<Deps> = {}): Promise<Deps & { fake: FakeChain }>` from
  `test/handler-deps.ts`; and from `test/fake-chain.ts`, `POOLS`, `TOKEN`,
  `poolView(overrides: Partial<PoolView> = {}): PoolView`,
  `outcome(txHash: string, receipts: ReceiptSpec[]): TxOutcome`,
  `commitOutcome(opts: { txHash?: string; buyer: string; poolId: number; seats: number; seatPrice: bigint; taken: number; target: number }): TxOutcome`
  and `FakeChain`, whose members the tests touch: `pools: Map<number, PoolView>`,
  `balances: Map<string, bigint>`, `block: BlockInfo`, `reads: Map<string, number>`,
  `relayResults: RelayResult[]`, `callResults: RelayResult[]`,
  `onRelay?: (signed: DecodedSignedDelegate, maxBlockHeight: bigint) => RelayResult | Promise<RelayResult>`,
  `relayed: Array<{ signed: DecodedSignedDelegate; maxBlockHeight: bigint }>`,
  `calls: Array<{ method: 'settle' | 'refund'; args: Record<string, unknown>; gas: bigint }>`,
  `setPool(pool: PoolView): void`, `setKey(account: string, publicKey: string, info: AccessKeyInfo): void`,
  `setBuyer(poolId: number, account: string, view: BuyerView | null): void` and its `getPool`.
- Produces:

```typescript
// apps/gateway/src/pools.ts
export type PoolReader = Pick<ChainReader, 'getPool'>;
export async function servedPool(chain: PoolReader, provider: string, poolId: number): Promise<PoolView | null>;

// apps/gateway/src/deps.ts, in interface Deps
redeemPools?: PoolReader;

// apps/gateway/src/pool-cache.ts
export type PoolViewCache = ViewCache<PoolView | null>;
export function poolViewCache(now?: () => number): PoolViewCache;
export function cachePoolReads(pools: PoolReader, cache: PoolViewCache): PoolReader;
export function clearAfterSends(writer: ChainWriter, cache: Pick<PoolViewCache, 'clear'>): ChainWriter;
```

- [ ] **Step 1: Write the failing test**

Create `apps/gateway/test/pool-cache.test.ts`:

```typescript
import {
  PAYMENT_HEADER,
  PROOF_HEADER,
  buildOffer,
  buildPaymentHeader,
  buildRedeemProofHeader,
  maxBlockHeightFor,
  type DecodedSignedDelegate,
  type PoolView,
} from '@quorum-on-near/protocol';
import { KeyPair } from 'near-api-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.ts';
import { DelegateExpiredError, type RelayResult } from '../src/chain.ts';
import type { Deps } from '../src/deps.ts';
import { offerContext } from '../src/handle-offer.ts';
import { cachePoolReads, clearAfterSends, poolViewCache, type PoolViewCache } from '../src/pool-cache.ts';
import { POOLS, TOKEN, FakeChain, commitOutcome, outcome, poolView } from './fake-chain.ts';
import { testDeps } from './handler-deps.ts';

const BUYER = 'buyer.testnet';
const POOL_ID = 7;
const TX_HASH = 'RelayTx111';

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

/** The cache's clock, which tests move by hand. */
let clock: number;
let cache: PoolViewCache;

beforeEach(() => {
  clock = 1_000;
  cache = poolViewCache(() => clock);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** A FakeChain holding pool 7, and its getPool through the cache. */
function cachedFake() {
  const fake = new FakeChain();
  fake.setPool(poolView({ id: POOL_ID }));
  return { fake, pools: cachePoolReads(fake, cache) };
}

function getPoolReads(fake: FakeChain): number {
  return fake.reads.get('get_pool') ?? 0;
}

/** A transaction that ran, as the writer returns it. */
function executed(txHash: string): RelayResult {
  return { kind: 'executed', outcome: outcome(txHash, [{ executorId: POOLS }]) };
}

/** A delegate the fake writer takes as it is: it reads none of its fields. */
const SIGNED = {} as DecodedSignedDelegate;

describe('cachePoolReads', () => {
  it('reads a pool once for the callers within 2 seconds of its read, and again at 2 seconds', async () => {
    const { fake, pools } = cachedFake();
    expect(await pools.getPool(POOL_ID)).toEqual(poolView({ id: POOL_ID }));
    clock = 1_000 + 1_999;
    fake.setPool(poolView({ id: POOL_ID, taken: 150 }));
    expect((await pools.getPool(POOL_ID))?.taken).toBe(148);
    expect(getPoolReads(fake)).toBe(1);
    clock = 1_000 + 2_000;
    expect((await pools.getPool(POOL_ID))?.taken).toBe(150);
    expect(getPoolReads(fake)).toBe(2);
  });

  it('shares one read between the callers that ask while it is in flight', async () => {
    const { fake, pools } = cachedFake();
    const answer = deferred<PoolView | null>();
    const read = vi.spyOn(fake, 'getPool').mockReturnValue(answer.promise);
    const first = pools.getPool(POOL_ID);
    const second = pools.getPool(POOL_ID);
    expect(read).toHaveBeenCalledOnce();
    answer.resolve(poolView({ id: POOL_ID }));
    expect(await first).toEqual(poolView({ id: POOL_ID }));
    expect(await second).toEqual(poolView({ id: POOL_ID }));
  });

  it('keeps each pool apart', async () => {
    const { fake, pools } = cachedFake();
    fake.setPool(poolView({ id: 8, taken: 3 }));
    expect((await pools.getPool(POOL_ID))?.id).toBe(POOL_ID);
    expect((await pools.getPool(8))?.taken).toBe(3);
    expect(getPoolReads(fake)).toBe(2);
  });

  it('keeps no answer that a pool does not exist, so a pool opened since is found at once', async () => {
    const fake = new FakeChain();
    const pools = cachePoolReads(fake, cache);
    expect(await pools.getPool(POOL_ID)).toBeNull();
    fake.setPool(poolView({ id: POOL_ID }));
    expect(await pools.getPool(POOL_ID)).toEqual(poolView({ id: POOL_ID }));
    expect(await pools.getPool(POOL_ID)).toEqual(poolView({ id: POOL_ID }));
    expect(getPoolReads(fake)).toBe(2);
  });

  it('hands each caller its own copy of the view', async () => {
    const { pools } = cachedFake();
    const first = await pools.getPool(POOL_ID);
    if (first === null) throw new Error('pool 7 is missing');
    first.taken = 0;
    expect((await pools.getPool(POOL_ID))?.taken).toBe(148);
  });
});

describe('clearAfterSends', () => {
  it.each<RelayResult>([
    executed(TX_HASH),
    { kind: 'unknown', txHash: TX_HASH, expired: false },
    { kind: 'rejected', txHash: TX_HASH, error: 'InvalidNonce' },
  ])('reads every pool again once a relayed delegate returns $kind, and returns its result unchanged', async (result) => {
    const { fake, pools } = cachedFake();
    const writer = clearAfterSends(fake, cache);
    await pools.getPool(POOL_ID);
    fake.relayResults.push(result);
    expect(await writer.relayDelegate(SIGNED, 1_200n)).toBe(result);
    expect(fake.relayed).toEqual([{ signed: SIGNED, maxBlockHeight: 1_200n }]);
    await pools.getPool(POOL_ID);
    expect(getPoolReads(fake)).toBe(2);
  });

  it("reads every pool again once a keeper's call returns, and returns its result unchanged", async () => {
    const { fake, pools } = cachedFake();
    const writer = clearAfterSends(fake, cache);
    await pools.getPool(POOL_ID);
    const result = executed('SettleTx1');
    fake.callResults.push(result);
    expect(await writer.callPools('settle', { pool_id: POOL_ID }, 100n)).toBe(result);
    expect(fake.calls).toEqual([{ method: 'settle', args: { pool_id: POOL_ID }, gas: 100n }]);
    await pools.getPool(POOL_ID);
    expect(getPoolReads(fake)).toBe(2);
  });

  it('reads every pool again when a relay throws, and rethrows its error', async () => {
    const { fake, pools } = cachedFake();
    const writer = clearAfterSends(fake, cache);
    await pools.getPool(POOL_ID);
    const failure = new DelegateExpiredError('too close to max_block_height');
    fake.onRelay = () => {
      throw failure;
    };
    await expect(writer.relayDelegate(SIGNED, 1_200n)).rejects.toBe(failure);
    await pools.getPool(POOL_ID);
    expect(getPoolReads(fake)).toBe(2);
  });

  it('stores nothing from a pool read sent before the transaction returned', async () => {
    const { fake, pools } = cachedFake();
    const writer = clearAfterSends(fake, cache);
    const relay = deferred<RelayResult>();
    fake.onRelay = () => relay.promise;
    const sent = writer.relayDelegate(SIGNED, 1_200n);
    const answer = deferred<PoolView | null>();
    const read = vi.spyOn(fake, 'getPool').mockReturnValueOnce(answer.promise);
    const before = pools.getPool(POOL_ID);
    relay.resolve(executed(TX_HASH));
    await sent;
    answer.resolve(poolView({ id: POOL_ID }));
    await before;
    await pools.getPool(POOL_ID);
    expect(read).toHaveBeenCalledTimes(2);
  });
});

describe('redemptions through the pool cache', () => {
  /**
   * The app over deps whose redemptions read pool 7 through the cache, from a reader that does not
   * count in `fake.reads`; so `redeemReads` counts the redemptions' pool reads, and
   * `fake.reads.get('get_pool')` every other route's. A buyer holds 2 committed seats.
   */
  async function setup() {
    const deps = await testDeps();
    const { fake } = deps;
    fake.setPool(poolView({ id: POOL_ID }));
    const redeemReads = vi.fn(async (poolId: number) => fake.pools.get(poolId) ?? null);
    const writer = clearAfterSends(fake, cache);
    const cachedDeps: Deps = { ...deps, writer, redeemPools: cachePoolReads({ getPool: redeemReads }, cache) };
    const keyPair = KeyPair.fromRandom('ed25519');
    fake.setKey(BUYER, keyPair.getPublicKey().toString(), { nonce: 10n, fullAccess: true });
    fake.balances.set(BUYER, 1_000_000n);
    fake.setBuyer(POOL_ID, BUYER, { seats: 2, state: 'committed' });
    return { deps: cachedDeps, fake, keyPair, redeemReads, app: createApp(cachedDeps) };
  }

  /** A redemption with a new proof: each proof has a nonce of its own. */
  async function redeem(s: Awaited<ReturnType<typeof setup>>): Promise<{ status: number; body: { status?: string } }> {
    const recipient = new URL(s.deps.config.publicUrl).host;
    const header = await buildRedeemProofHeader({ keyPair: s.keyPair, accountId: BUYER, poolId: POOL_ID, recipient, nowMs: s.deps.now() });
    const res = await s.app.request(`/pools/${POOL_ID}/access`, { headers: { [PROOF_HEADER]: header } });
    return { status: res.status, body: (await res.json()) as { status?: string } };
  }

  it('answers redemptions within 2 seconds from one read of the pool, and reads it again at 2 seconds', async () => {
    const s = await setup();
    expect(await redeem(s)).toMatchObject({ status: 202, body: { status: 'pending' } });
    expect(await redeem(s)).toMatchObject({ status: 202, body: { status: 'pending' } });
    expect(s.redeemReads).toHaveBeenCalledOnce();
    s.fake.setPool(poolView({ id: POOL_ID, taken: 192, status: 'filled' }));
    clock = 1_000 + 1_999;
    expect(await redeem(s)).toMatchObject({ status: 202, body: { status: 'pending' } });
    clock = 1_000 + 2_000;
    expect(await redeem(s)).toMatchObject({ status: 200, body: { status: 'filled' } });
    expect(s.redeemReads).toHaveBeenCalledTimes(2);
    expect(getPoolReads(s.fake)).toBe(0);
  });

  it('reads the pool for every offer, outside the cache', async () => {
    const s = await setup();
    await redeem(s);
    expect((await s.app.request(`/pools/${POOL_ID}/access?seats=2`)).status).toBe(402);
    expect((await s.app.request(`/pools/${POOL_ID}/access?seats=2`)).status).toBe(402);
    expect(s.redeemReads).toHaveBeenCalledOnce();
    expect(getPoolReads(s.fake)).toBe(2);
  });

  it('checks a payment against a pool read outside the cache, and reads the pool again for the next redemption', async () => {
    const s = await setup();
    await redeem(s);
    // The relayed commit takes 2 seats.
    s.fake.onRelay = () => {
      s.fake.setPool(poolView({ id: POOL_ID, taken: 150 }));
      return {
        kind: 'executed',
        outcome: commitOutcome({ txHash: TX_HASH, buyer: BUYER, poolId: POOL_ID, seats: 2, seatPrice: 180n, taken: 150, target: 192 }),
      };
    };
    const header = await buildPaymentHeader({
      keyPair: s.keyPair,
      senderId: BUYER,
      nonce: 11n,
      maxBlockHeight: maxBlockHeightFor(s.fake.block.height, s.deps.config.maxTimeoutSeconds, s.deps.config.blockTimeMs),
      offer: buildOffer(poolView({ id: POOL_ID }), 2, offerContext(s.deps.config)),
      expected: { network: 'near:testnet', token: TOKEN, poolsContract: POOLS, poolId: POOL_ID, maxSeats: 2, maxAmount: 360n },
    });
    const paid = await s.app.request(`/pools/${POOL_ID}/access?seats=2`, { headers: { [PAYMENT_HEADER]: header } });
    expect(paid.status).toBe(202);
    expect(s.fake.relayed).toHaveLength(1);
    expect(getPoolReads(s.fake)).toBe(1);
    expect(s.redeemReads).toHaveBeenCalledOnce();
    expect(await redeem(s)).toMatchObject({ status: 202, body: { status: 'pending', taken: 150 } });
    expect(s.redeemReads).toHaveBeenCalledTimes(2);
  });
});
```

In the tests through `createApp`, redemptions read through a reader that does not count in
`fake.reads`, so `redeemReads` counts the redemptions' pool reads and `fake.reads.get('get_pool')`
every other route's.

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm --filter @quorum-on-near/gateway test test/pool-cache.test.ts`

Expected: FAIL, since the module does not exist yet:

```text
 ❯ test/pool-cache.test.ts (0 test)

⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  test/pool-cache.test.ts [ test/pool-cache.test.ts ]
Error: Cannot find module '../src/pool-cache.ts' imported from …/apps/gateway/test/pool-cache.test.ts
 ❯ test/pool-cache.test.ts:17:1

 Test Files  1 failed (1)
      Tests  no tests
 ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  @quorum-on-near/gateway@0.1.0 test: `vitest run --exclude "test/sandbox/**" "test/pool-cache.test.ts"`
Exit status 1
```

- [ ] **Step 3: Add `PoolReader` to `pools.ts`**

In `apps/gateway/src/pools.ts`, replace:

```typescript
/** The pool if it exists and `provider` sells it; otherwise null. */
export async function servedPool(chain: ChainReader, provider: string, poolId: number): Promise<PoolView | null> {
```

with:

```typescript
/** The one read servedPool makes. */
export type PoolReader = Pick<ChainReader, 'getPool'>;

/** The pool if it exists and `provider` sells it; otherwise null. */
export async function servedPool(chain: PoolReader, provider: string, poolId: number): Promise<PoolView | null> {
```

A widening: every caller of `servedPool` (`handle-offer.ts:61`, `handle-payment.ts:87`,
`handle-redeem.ts:35`) passes a `ChainReader`, which still fits.

- [ ] **Step 4: Write the module**

Create `apps/gateway/src/pool-cache.ts`:

```typescript
import type { PoolView } from '@quorum-on-near/protocol';
import type { ChainWriter } from './chain.ts';
import type { PoolReader } from './pools.ts';
import { ViewCache } from './view-cache.ts';

/** Pool views by pool id, as `getPool` answers them. */
export type PoolViewCache = ViewCache<PoolView | null>;

/**
 * A cache of pool views that never keeps `null`: a pool can be opened at any moment, and a stored
 * `null` would answer its redemptions `404 unknown_pool` until it expired. `now` is the cache's
 * clock, for tests; by default `performance.now()`.
 */
export function poolViewCache(now?: () => number): PoolViewCache {
  return new ViewCache<PoolView | null>({ now, keep: (pool) => pool !== null });
}

/**
 * `pools.getPool` through `cache`: the callers that ask for a pool within VIEW_CACHE_TTL_MS of when
 * its read was sent share that read (view-cache.ts). Each caller gets its own copy of the view.
 */
export function cachePoolReads(pools: PoolReader, cache: PoolViewCache): PoolReader {
  return {
    async getPool(poolId) {
      const pool = await cache.get(String(poolId), () => pools.getPool(poolId));
      // The cache shares its answer between callers, so each one gets a copy (every field is a primitive).
      return pool === null ? null : { ...pool };
    },
  };
}

/**
 * `writer`, with `cache` cleared once each transaction it sends has returned or thrown, so a pool
 * read through the cache is never older than the gateway's own last transaction: a read still in
 * flight at that moment stores nothing (ViewCache.clear). Each call reaches `writer` once, with the
 * same arguments, and its result or its error comes back unchanged. A throw or a `rejected` result
 * sent nothing, and clearing then only costs a read.
 */
export function clearAfterSends(writer: ChainWriter, cache: Pick<PoolViewCache, 'clear'>): ChainWriter {
  return {
    async relayDelegate(signed, maxBlockHeight) {
      try {
        return await writer.relayDelegate(signed, maxBlockHeight);
      } finally {
        cache.clear();
      }
    },
    async callPools(method, args, gas) {
      try {
        return await writer.callPools(method, args, gas);
      } finally {
        cache.clear();
      }
    },
  };
}
```

- [ ] **Step 5: Run it and see redemptions still uncached**

Run: `pnpm --filter @quorum-on-near/gateway test test/pool-cache.test.ts`

Expected: FAIL with 3 tests, the ones through `createApp`, since the redemption still reads
`deps.chain`. The 11 unit tests of the module pass.

```text
 ❯ test/pool-cache.test.ts (14 tests | 3 failed)
     × answers redemptions within 2 seconds from one read of the pool, and reads it again at 2 seconds
     × reads the pool for every offer, outside the cache
     × checks a payment against a pool read outside the cache, and reads the pool again for the next redemption

 Test Files  1 failed (1)
      Tests  3 failed | 11 passed (14)
```

The first two read `AssertionError: expected "vi.fn()" to be called once, but got 0 times`, the third
`AssertionError: expected 2 to be 1 // Object.is equality`.

- [ ] **Step 6: Add `redeemPools` to `Deps`**

In `apps/gateway/src/deps.ts`, replace:

```typescript
import type { InFlight, NonceCache } from './guards.ts';
```

with:

```typescript
import type { InFlight, NonceCache } from './guards.ts';
import type { PoolReader } from './pools.ts';
```

and replace:

```typescript
  chain: ChainReader;
```

with:

```typescript
  chain: ChainReader;
  /**
   * Where redemptions read a pool, and nothing else does: in the gateway, `chain`'s getPool through
   * a 2-second cache that each transaction it sends clears (pool-cache.ts). By default, `chain`.
   */
  redeemPools?: PoolReader;
```

The member is optional, so `test/handler-deps.ts` and the sandbox test, which build `Deps`, compile
unchanged and their redemptions read `chain` as before.

- [ ] **Step 7: Read the redemption's pool through `redeemPools`**

In `apps/gateway/src/handle-redeem.ts`, replace:

```typescript
    const pool = await servedPool(chain, config.provider, poolId);
```

with:

```typescript
    const pool = await servedPool(deps.redeemPools ?? chain, config.provider, poolId);
```

- [ ] **Step 8: Run it and see it pass**

Run: `pnpm --filter @quorum-on-near/gateway test test/pool-cache.test.ts`

Expected:

```text
 Test Files  1 passed (1)
      Tests  14 passed (14)
```

- [ ] **Step 9: Wire the cache and the clearing writer in `main.ts`**

In `apps/gateway/src/main.ts`, add the import. Replace:

```typescript
import { Keeper } from './keeper.ts';
```

with:

```typescript
import { Keeper } from './keeper.ts';
import { cachePoolReads, clearAfterSends, poolViewCache } from './pool-cache.ts';
```

Rename the relayer. Replace:

```typescript
const writer = new RpcRelayer({
```

with:

```typescript
const relayer = new RpcRelayer({
```

The object inside that call is unchanged. Right after the call's closing `});`, replace:

```typescript
const activity = await ActivityLog.open(join(config.dataDir, 'activity.jsonl'));
```

with:

```typescript
// Redemptions read a pool through this cache. Every transaction the gateway sends, a payment's relay
// or a keeper's call, clears it once it has returned (pool-cache.ts).
const poolViews = poolViewCache();
const writer = clearAfterSends(relayer, poolViews);
const activity = await ActivityLog.open(join(config.dataDir, 'activity.jsonl'));
```

And in `const deps: Deps = {`, replace:

```typescript
  config: { ...config, webDir: liveFolder(config.webDir) },
  chain,
```

with:

```typescript
  config: { ...config, webDir: liveFolder(config.webDir) },
  chain,
  redeemPools: cachePoolReads(chain, poolViews),
```

Every later use of `writer` stays as it is: `deps.writer` and the keeper's `writer` are now the
clearing writer. These are the only users of the `ChainWriter`.

If `main.ts` differs, keep this behaviour: one `poolViewCache()`; every `ChainWriter` the
process sends through, the keeper's and any route's, is `clearAfterSends(<the RpcRelayer>, poolViews)`;
`deps.redeemPools` is `cachePoolReads(chain, poolViews)` over the same `chain` as `deps.chain`.
Nothing tests `main.ts`, so check it by reading:

Run: `grep -n "redeemPools\|clearAfterSends\|new RpcRelayer" apps/gateway/src/main.ts`

Expected (line numbers may differ):

```text
14:import { cachePoolReads, clearAfterSends, poolViewCache } from './pool-cache.ts';
74:const relayer = new RpcRelayer({
87:const writer = clearAfterSends(relayer, poolViews);
92:  redeemPools: cachePoolReads(chain, poolViews),
```

No `RpcRelayer` may reach `deps.writer`, the keeper or another sender unwrapped.

No reader other than `handleRedeem` may take `deps.redeemPools`: any other route that reads a pool
reads `deps.chain`, uncached (the last row of the table in
[Which reads are cached](#which-reads-are-cached)). Check it by reading:

Run: `grep -rn redeemPools apps/gateway/src`

Expected (line numbers may differ):

```text
apps/gateway/src/deps.ts:16:  redeemPools?: PoolReader;
apps/gateway/src/handle-redeem.ts:35:    const pool = await servedPool(deps.redeemPools ?? chain, config.provider, poolId);
apps/gateway/src/main.ts:92:  redeemPools: cachePoolReads(chain, poolViews),
```

- [ ] **Step 10: State the cache in the design spec**

In `docs/specs/2026-11-09-quorum-on-near-design.md`, section 6.5, add a paragraph right after the
redemption table, before "The `410` status is the buyer's state…". Replace the table's last row:

```markdown
| The account holds no seats | `404` |
```

with:

```markdown
| The account holds no seats | `404` |

Redemptions share each pool's `get_pool` answer for 2 seconds after the gateway sent its read, so
buyers polling the same pool cost at most one read per 2 seconds while its reads succeed; offers,
payments, the keeper and `GET /pools` never read through this cache. A pool that does not exist is
never kept, and every pool is forgotten once a transaction the gateway sent (a relayed payment, or
the keeper's `settle` or `refund`) has returned. When its result is known (executed or rejected), a
redemption that comes after it reads the pool as that transaction left it, or newer. A transaction
whose result is unknown, and a change the gateway did not send, such as a deadline passing or seats
taken by a commit it did not relay, can show up to 2 seconds late, as a `202` where a `200` or a
`410` is due, and a buyer that asks again later gets it.
```

Section 6.4's "The gateway reads the contract's views and access keys at optimistic finality, so it
sees state at least as new as the results it relays" stays true and is not edited: the payment path
reads uncached, and a redemption reads the pool anew after every transaction the gateway relayed
whose result it knows.

- [ ] **Step 11: Typecheck the gateway**

Run: `pnpm --filter @quorum-on-near/gateway typecheck`

Expected: exit code 0; `tsc` prints nothing after pnpm's two lines naming the script.

- [ ] **Step 12: Run the gateway's suite**

Run: `pnpm --filter @quorum-on-near/gateway test`

Expected: exit code 0, 14 tests and 1 file more than after Task 2:

```text
 Test Files  21 passed (21)
      Tests  705 passed (705)
```

- [ ] **Step 13: Typecheck and test the whole workspace**

```bash
pnpm typecheck
pnpm test
```

Expected: both exit 0; `pnpm typecheck` prints `Done` for `apps/web`, `packages/protocol`,
`packages/buyer`, `apps/gateway`, `apps/mcp` and `apps/swarm`. In `pnpm test`, every package passes;
the gateway's lines read

```text
apps/gateway test:  Test Files  21 passed (21)
apps/gateway test:       Tests  705 passed (705)
```

- [ ] **Step 14: Commit**

```bash
git add apps/gateway/src/pool-cache.ts apps/gateway/test/pool-cache.test.ts apps/gateway/src/deps.ts apps/gateway/src/handle-redeem.ts apps/gateway/src/main.ts apps/gateway/src/pools.ts docs/specs/2026-11-09-quorum-on-near-design.md
git commit -q -F - <<'EOF'
read the pool for redemptions through a short-lived cache that the gateway's transactions clear

Redemptions now read a pool's view through cachePoolReads, a getPool
over a ViewCache keyed by pool id: buyers that poll the same pool within
2 seconds of a read share that read, so the redemptions' get_pool reads
no longer grow with the number of buyers. The reader is the new optional
Deps member redeemPools, which only handleRedeem reads; it falls back to
chain. Offers, payments, GET /pools and the keeper keep reading the
chain directly, since a stale view there could relay a payment into a
full pool or send a settle or refund that fails; a payment's read after
its relay is one read per lost race, with nothing to save.

A pool that does not exist is never kept: a stored null would answer a
pool opened since with 404 unknown_pool. Each caller gets its own copy
of the view.

clearAfterSends wraps the chain writer and clears the cache in a finally
once each relayDelegate or callPools has returned or thrown; a read
still in flight then stores nothing. So a redemption after one of the
gateway's own transactions whose result is known reads the pool as that
transaction left it or newer; one whose result is unknown can show up
to 2 seconds late, like a change the gateway did not send. main.ts
builds one cache, wraps the relayer that both the payment route and the
keeper use, and passes the cached reader as redeemPools. servedPool now
takes only the getPool it calls.

The design spec's redemption section states what is cached and when it
is cleared.
EOF
git show --stat --format= HEAD
```

Expected:

```text
 apps/gateway/src/deps.ts                       |   6 +
 apps/gateway/src/handle-redeem.ts              |   2 +-
 apps/gateway/src/main.ts                       |   8 +-
 apps/gateway/src/pool-cache.ts                 |  56 ++++++
 apps/gateway/src/pools.ts                      |   5 +-
 apps/gateway/test/pool-cache.test.ts           | 262 +++++++++++++++++++++++++
 docs/specs/2026-11-09-quorum-on-near-design.md |  10 +
 7 files changed, 346 insertions(+), 3 deletions(-)
```

---

### Task 4: The gateway's view reads, tried again after HTTP 429

`retryViewsOn429(inner, opts)` wraps the gateway's view provider, the `JsonRpcProvider` under
`RpcChain` and under the start-up's `viewNodeStatus`. It returns a new object with the four view
methods the gateway calls on that provider, `callFunction`, `viewAccessKey`, `viewBlock` and
`viewNodeStatus`, and no other: nothing can send a transaction through it. A test checks its keys at
run time, and a `// @ts-expect-error` checks its type at compile time.

- **What is retried:** only an error for which `error instanceof Error && error.cause === 429`, the
  `ProviderError` near-api-js 7.4.0 throws for HTTP 429. Any other error is rethrown at once.
- **How:** at most three more attempts, after 200, 400 and 800 ms, each wait multiplied by
  `1 + random() / 2`: under 2.1 seconds of waiting in all, and at least 1.4 seconds before the last
  attempt, so that it falls in a later one-second window of an endpoint that limits requests per
  second. After the last attempt its 429 is rethrown unchanged, so every caller handles a refused read
  as before. `sleep` and `random` are injectable; the defaults are `setTimeout` from
  `node:timers/promises` and `Math.random`.
- **No log line:** a 429's message is the endpoint's body as it came, and every caller already logs
  a failed read once.
- **The relayer is not wrapped:** its provider (`createRelayerProvider`) serves its reads and its
  sends and still posts each request once. `RpcRelayer` takes full `Provider`s, so passing it the
  wrapper is a compile error.
- **`RpcChain` takes a `ChainProvider`:** the three methods it reads with. Without this, `RpcChain`
  refuses a `ViewProvider` (Step 5 shows the error).

The retry changes no value a reader gets, only when it gets it. A payment reads the chain up to six
times before its relay (the pool, the key, the final block, the key again, the balance, the buyer's
seats; `handle-payment.ts:87-180`), so while the endpoint refuses, it can take up to about 12.6
seconds longer in waits alone before the relay, against a buyer's payment timeout of 300 seconds. While the
endpoint answers 429, the pool view and the final block that check 6 judges, read first and third,
can then be up to about 10 seconds old at relay time. A pool that fills or passes its deadline in
that window is relayed, which costs relayer gas and answers `409` or `410`, as a stale view would.
This is accepted because the contract refuses it safely and the alternative is a `503`. The
delegate's expiry is checked again: the relayer reads the final height after taking a key, on its
own provider, and refuses a delegate within `EXPIRY_MARGIN_BLOCKS` of its `max_block_height`
(`relayer.ts:196`, `:228-233`). Under Task 3's
cache, a pool read whose retries run past 2 seconds is no longer joinable, so a redemption that
arrives then sends one more read of that pool: at most one per 2 seconds per pool, and only while the
endpoint answers 429. `Retry-After` is not read (near-api-js keeps only the body), so the waits are
fixed.

**Files:**
- Create: `apps/gateway/src/view-retry.ts`
- Modify: `apps/gateway/src/rpc-chain.ts` (`ChainProvider`; the field and the constructor's type)
- Modify: `apps/gateway/src/main.ts` (an import; the view provider's expression and its comment)
- Modify: `docs/specs/2026-11-09-quorum-on-near-design.md` (section 9, a row)
- Test: `apps/gateway/test/view-retry.test.ts`

**Interfaces:**
- Consumes: from near-api-js 7.4.0, the types `Provider` and `SerializedReturnValue`, and
  `JsonRpcProvider`; `RpcChain` from `apps/gateway/src/rpc-chain.ts`; in the tests,
  `AccessKeyDoesNotExistError` from `near-api-js/rpc-errors`, `KeyPair`, and `POOLS` and `TOKEN`
  from `test/fake-chain.ts`.
- Produces:

```typescript
// apps/gateway/src/view-retry.ts
export type ViewProvider = Pick<Provider, 'callFunction' | 'viewAccessKey' | 'viewBlock' | 'viewNodeStatus'>;
export const VIEW_RETRY_WAITS_MS: readonly number[] = [200, 400, 800];
export interface ViewRetryOptions {
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}
export function retryViewsOn429(inner: ViewProvider, opts?: ViewRetryOptions): ViewProvider;

// apps/gateway/src/rpc-chain.ts
export type ChainProvider = Pick<Provider, 'callFunction' | 'viewAccessKey' | 'viewBlock'>;
export class RpcChain implements ChainReader {
  constructor(opts: { provider: ChainProvider; poolsContract: string; token: string });
}
```

- [ ] **Step 1: Write the failing test**

Create `apps/gateway/test/view-retry.test.ts`:

```typescript
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
```

The last block runs the composition `main.ts` builds, `RpcChain` over the wrapper over a real
`JsonRpcProvider`, against a stubbed global `fetch`, so it checks near-api-js's real 429 error. Its
503 case passes `{ retries: 1 }`, so near-api-js never waits between its own attempts.

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm --filter @quorum-on-near/gateway test test/view-retry.test.ts`

Expected: FAIL, since the module does not exist yet:

```text
 ❯ test/view-retry.test.ts (0 test)

⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  test/view-retry.test.ts [ test/view-retry.test.ts ]
Error: Cannot find module '../src/view-retry.ts' imported from …/apps/gateway/test/view-retry.test.ts
 ❯ test/view-retry.test.ts:5:1

 Test Files  1 failed (1)
      Tests  no tests
 ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  @quorum-on-near/gateway@0.1.0 test: `vitest run --exclude "test/sandbox/**" "test/view-retry.test.ts"`
Exit status 1
```

- [ ] **Step 3: Write the wrapper**

Create `apps/gateway/src/view-retry.ts`:

```typescript
import { setTimeout as delay } from 'node:timers/promises';
import type { Provider, SerializedReturnValue } from 'near-api-js';

/** The provider methods the gateway reads the chain with. None of them sends a transaction. */
export type ViewProvider = Pick<Provider, 'callFunction' | 'viewAccessKey' | 'viewBlock' | 'viewNodeStatus'>;

/**
 * The waits, in milliseconds, before the second, third and fourth attempt of a view the RPC answered
 * with HTTP 429, before jitter. The last attempt comes at least 1.4 seconds after the first, so in a
 * later one-second window of an RPC that limits requests per second.
 */
export const VIEW_RETRY_WAITS_MS: readonly number[] = [200, 400, 800];

/** How retryViewsOn429 waits. */
export interface ViewRetryOptions {
  /** Waits `ms` milliseconds. Default `setTimeout` from `node:timers/promises`. */
  sleep?: (ms: number) => Promise<void>;
  /** A number in [0, 1) that stretches each wait by up to half again. Default `Math.random`. */
  random?: () => number;
}

/**
 * True for HTTP 429 (too many requests). near-api-js throws its own error class, which it does not
 * export, for an HTTP error status, with the status as the error's cause; it never retries a 429
 * itself, so each attempt here is one post.
 */
function isTooManyRequests(error: unknown): boolean {
  return error instanceof Error && error.cause === 429;
}

/**
 * `inner`'s four view methods, each tried again after HTTP 429, at most VIEW_RETRY_WAITS_MS.length
 * more times, each wait stretched by up to half again so that reads refused together are not all
 * retried together. Any other error is rethrown at once, and the last 429 once the retries are
 * spent, both unchanged. The result has these four methods and no other, so nothing can send a
 * transaction through it: a transaction is never posted twice.
 *
 * It logs nothing: a 429's message is the RPC's answer as it came.
 */
export function retryViewsOn429(inner: ViewProvider, opts: ViewRetryOptions = {}): ViewProvider {
  const sleep = opts.sleep ?? ((ms: number) => delay(ms));
  const random = opts.random ?? Math.random;

  async function retrying<T>(view: () => Promise<T>): Promise<T> {
    for (const waitMs of VIEW_RETRY_WAITS_MS) {
      try {
        return await view();
      } catch (error) {
        if (!isTooManyRequests(error)) throw error;
      }
      await sleep(waitMs * (1 + random() / 2));
    }
    return view();
  }

  return {
    // callFunction is generic, so its wrapper is too.
    callFunction: <T extends SerializedReturnValue>(params: Parameters<ViewProvider['callFunction']>[0]) =>
      retrying(() => inner.callFunction<T>(params)),
    viewAccessKey: (params) => retrying(() => inner.viewAccessKey(params)),
    viewBlock: (blockQuery) => retrying(() => inner.viewBlock(blockQuery)),
    viewNodeStatus: () => retrying(() => inner.viewNodeStatus()),
  };
}
```

- [ ] **Step 4: Run it and see the tests pass**

Run: `pnpm --filter @quorum-on-near/gateway test test/view-retry.test.ts`

Expected: PASS. vitest strips the types without checking them, so the next step's typecheck is what
fails at this point.

```text
 Test Files  1 passed (1)
      Tests  18 passed (18)
```

- [ ] **Step 5: Typecheck the gateway and see it fail**

Run: `pnpm --filter @quorum-on-near/gateway typecheck`

Expected: FAIL, since `RpcChain` still asks for a full `Provider`:

```text
> @quorum-on-near/gateway@0.1.0 typecheck …/apps/gateway
> tsc -p tsconfig.json

test/view-retry.test.ts(164,36): error TS2740: Type 'ViewProvider' is missing the following properties from type 'Provider': getNetworkId, viewAccessKeyList, viewGasKeyNonces, viewAccount, and 25 more.
 ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  @quorum-on-near/gateway@0.1.0 typecheck: `tsc -p tsconfig.json`
Exit status 2
```

- [ ] **Step 6: Narrow `RpcChain`'s provider**

In `apps/gateway/src/rpc-chain.ts`, replace:

```typescript
const NANOS_PER_MS = 1_000_000n;
```

with:

```typescript
const NANOS_PER_MS = 1_000_000n;

/** The provider methods RpcChain reads with. None of them sends a transaction. */
export type ChainProvider = Pick<Provider, 'callFunction' | 'viewAccessKey' | 'viewBlock'>;
```

Replace the private field:

```typescript
  readonly #provider: Provider;
```

with:

```typescript
  readonly #provider: ChainProvider;
```

And the constructor's line:

```typescript
  constructor(opts: { provider: Provider; poolsContract: string; token: string }) {
```

with:

```typescript
  constructor(opts: { provider: ChainProvider; poolsContract: string; token: string }) {
```

The three methods are the ones `RpcChain` calls. Every existing caller (`test/rpc-chain.test.ts`,
`test/sandbox/relayed-commit.test.ts`, `main.ts`) compiles unchanged.

- [ ] **Step 7: Typecheck the gateway and see it pass**

Run: `pnpm --filter @quorum-on-near/gateway typecheck`

Expected: exit code 0; `tsc` prints nothing after pnpm's two lines naming the script. The
`// @ts-expect-error` in the test is live: if `views.sendTransactionUntil` were not a type error, the
typecheck would fail with `TS2578: Unused '@ts-expect-error' directive`.

- [ ] **Step 8: Wrap the view provider in `main.ts`**

In `apps/gateway/src/main.ts`, add the import. Replace:

```typescript
import { gracefulClose } from './shutdown.ts';
```

with:

```typescript
import { gracefulClose } from './shutdown.ts';
import { retryViewsOn429 } from './view-retry.ts';
```

Then replace the view provider and the comment above it:

```typescript
// Views change nothing, so they keep near-api-js's default retries.
const viewProvider = new JsonRpcProvider({ url: config.rpcUrl });
```

with:

```typescript
// Views change nothing, so they keep near-api-js's default retries, and are tried again after an
// HTTP 429 (view-retry.ts). Only the views: the relayer's provider is another one, below.
const viewProvider = retryViewsOn429(new JsonRpcProvider({ url: config.rpcUrl }));
```

Nothing else in `main.ts` changes. `viewProvider` has two users, both reads: `new RpcChain({ provider:
viewProvider, … })` and the start-up's `await viewProvider.viewNodeStatus()`. The relayer's provider
stays `createRelayerProvider(config.rpcUrl)`, passed unwrapped as both `readProvider` and
`sendProvider`.

If `main.ts` differs, keep this behaviour: the provider under `RpcChain` and under the
start-up's `viewNodeStatus` is `retryViewsOn429(new JsonRpcProvider({ url: <the RPC URL> }))`, and no
provider that reaches `RpcRelayer`, or anything else that sends, is wrapped. Another provider that
only reads may be wrapped the same way; one that sends never. Check it by reading:

Run: `grep -n "retryViewsOn429\|createRelayerProvider\|readProvider\|sendProvider" apps/gateway/src/main.ts`

Expected (line numbers may differ):

```text
15:import { createRelayerProvider } from './providers.ts';
19:import { retryViewsOn429 } from './view-retry.ts';
51:const viewProvider = retryViewsOn429(new JsonRpcProvider({ url: config.rpcUrl }));
75:const relayerProvider = createRelayerProvider(config.rpcUrl);
80:  readProvider: relayerProvider,
81:  sendProvider: relayerProvider,
```

- [ ] **Step 9: State the retry in the design spec**

In `docs/specs/2026-11-09-quorum-on-near-design.md`, section 9, add a row after "The RPC times out
during a relay". Replace that row:

```markdown
| The RPC times out during a relay | The result is looked up by transaction hash; the payment is never re-signed or re-sent. If the result is still unknown, `502` with the hash, and the buyer checks through redemption. The buyer stays in flight until a final block above the delegate's `max_block_height` plus 20 blocks has been seen (section 6.4) |
```

with:

```markdown
| The RPC times out during a relay | The result is looked up by transaction hash; the payment is never re-signed or re-sent. If the result is still unknown, `502` with the hash, and the buyer checks through redemption. The buyer stays in flight until a final block above the delegate's `max_block_height` plus 20 blocks has been seen (section 6.4) |
| The RPC answers one of the gateway's reads with HTTP 429 (too many requests) | The read is tried again up to three times, after 200, 400 and 800 ms, each wait stretched by up to half again: under 2.1 seconds of waiting more per read, besides the time of the extra requests. This covers the reads behind offers, payment checks, redemptions, `GET /pools`, the keeper and the checks at start-up. If the last try is refused too, the read fails as before: `503` (`chain_unavailable`), the keeper's next tick, or a failed start. The relayer's own reads and its send do not go through this retry: the relayer posts each request once, so a transaction is never posted twice, and a read of the relayer's that is refused before it sends fails as before. The relayer checks the expiry again once it holds a key (section 6.4). `POST /rpc` is not retried either: the live page reads again at its next refresh |
```

Section 12 is not edited in this task: the `/rpc has no rate limit` bullet stays true, and the page
still shows that it could not refresh when a read through `/rpc` is refused (Task 2 Step 8). Section 6.4's `503` for a chain that cannot be read stays true: a read
still refused after its retries is a read that cannot be made.

- [ ] **Step 10: Typecheck the gateway**

Run: `pnpm --filter @quorum-on-near/gateway typecheck`

Expected: exit code 0; `tsc` prints nothing after pnpm's two lines naming the script.

- [ ] **Step 11: Run the gateway's suite**

Run: `pnpm --filter @quorum-on-near/gateway test`

Expected: exit code 0, 18 tests and 1 file more than after Task 3:

```text
 Test Files  22 passed (22)
      Tests  723 passed (723)
```

- [ ] **Step 12: Typecheck and test the whole workspace**

```bash
pnpm typecheck
pnpm test
```

Expected: both exit 0. `pnpm typecheck` prints

```text
Scope: 6 of 7 workspace projects
apps/web typecheck$ tsc -p tsconfig.json
packages/protocol typecheck$ tsc -p tsconfig.json
packages/protocol typecheck: Done
apps/web typecheck: Done
packages/buyer typecheck$ tsc -p tsconfig.json
apps/gateway typecheck$ tsc -p tsconfig.json
packages/buyer typecheck: Done
apps/gateway typecheck: Done
apps/mcp typecheck$ tsc -p tsconfig.json
apps/swarm typecheck$ tsc -p tsconfig.json
apps/mcp typecheck: Done
apps/swarm typecheck: Done
```

In `pnpm test`, every package passes; the gateway's lines read

```text
apps/gateway test:  Test Files  22 passed (22)
apps/gateway test:       Tests  723 passed (723)
```

and every other package passes with the counts it had before the task: this plan changes no other
package.

- [ ] **Step 13: Commit**

```bash
git add apps/gateway/src/view-retry.ts apps/gateway/test/view-retry.test.ts apps/gateway/src/rpc-chain.ts apps/gateway/src/main.ts docs/specs/2026-11-09-quorum-on-near-design.md
git commit -q -F - <<'EOF'
try the gateway's view reads again after HTTP 429

near-api-js 7.4.0 retries a request on HTTP 503, 500 and 408 but throws
a 429 on the first post, so a read refused by an endpoint that limits
requests per second failed the offer, payment, redemption or keeper tick
that made it. retryViewsOn429 wraps the view provider's four view
methods (callFunction, viewAccessKey, viewBlock, viewNodeStatus) and
tries each again after an error whose cause is 429, at most three more
times, after 200, 400 and 800 ms, each wait stretched by up to half
again from an injected random source: under 2.1 seconds in all. Any
other error is rethrown at once, and the last 429 is rethrown unchanged,
so every caller handles a refused read as before. It logs nothing.

The wrapper has these four methods and no other, so nothing can send a
transaction through it; a test checks its keys and a ts-expect-error
checks its type. RpcChain now takes a ChainProvider, the three methods
it reads with, so the chain reader cannot name a send method either.
main.ts wraps only the view provider; the relayer's provider is
unchanged and still posts each request once.

The design spec's error handling table states the retry and what it
does not cover.
EOF
git show --stat --format= HEAD
```

Expected:

```text
 apps/gateway/src/main.ts                       |   6 +-
 apps/gateway/src/rpc-chain.ts                  |   7 +-
 apps/gateway/src/view-retry.ts                 |  64 ++++++++
 apps/gateway/test/view-retry.test.ts           | 200 +++++++++++++++++++++++++
 docs/specs/2026-11-09-quorum-on-near-design.md |   1 +
 5 files changed, 274 insertions(+), 4 deletions(-)
```

---

## Self-review

**Spec coverage.** Each requirement of this plan, and the task that meets it:

| Requirement | Where |
|---|---|
| A short-lived, bounded, in-memory cache; age counted from when the read was sent; a backward clock expires; one read in flight per key; a failure never stored; `clear()` with a generation; no logging | Task 1 |
| The TTL is 2,000 ms, a constant, tested with a hand-moved clock at 1,999 ms, 2,000 ms and after a backward step | Task 1; Task 2 through `POST /rpc` at 1,999 ms, 2,000 ms and after a backward step; Task 3 at 1,999 and 2,000 ms only, its backward step being the shared `ViewCache` tests'; [The time-to-live](#the-time-to-live-2000-ms) |
| The page's views through `POST /rpc` cost one read per view per 2 seconds whatever the number of tabs; only the four views; each caller's own `id`; nothing but a view's result stored; failures into the route's catch; no 429 retry in the forward; display only | Task 2; spec sections 6.1 and 12 |
| Redemptions' `get_pool` cached, never `null`, cleared after every transaction the gateway sends; every other reader uncached | Task 3; spec section 6.5 |
| For each reader of `get_pool`, `list_pools`, `get_seats` and `ft_balance_of`: cached or not, and whether a 2-second-old answer is a wrong decision or a delay; a payment's own checks stay uncached | [Which reads are cached](#which-reads-are-cached) |
| A 429-aware retry for view calls only, with its waits and the error it retries stated; no send method on the wrapper, checked at compile time and at run time | Task 4; spec section 9 |
| The relayer stays single-post: never wrapped, never retried | Task 4 (the wrapper's type; `main.ts` check); Global Constraints |
| No new dependency; `config.ts`, `packages/**`, the relayer unchanged; no rate limit on `/rpc` | Global Constraints; [What stays out](#what-stays-out) |
| Small anchored edits to `main.ts` and `app.ts`, with the behaviour to keep if the code differs | Task 2 Step 5, Task 3 Step 9, Task 4 Step 8; [Status](#status-of-the-code-in-this-plan) |

**Placeholder scan.** Every code step holds the code as it ran; every command shows its output. The
only values left to the executor are the anchors of `main.ts` and `app.ts` if the code differs, and
each such step states the behaviour to keep and how to check it.

**Type consistency.** `ViewCache<T>`, `get(key, read)`, `clear()` and the `keep` and `now` options
(Task 1) are used as defined in Tasks 2 and 3. `PoolReader` (Task 3, `pools.ts`) is what
`cachePoolReads` takes and returns and what `Deps.redeemPools` holds. `ViewProvider` (Task 4) is
assignable to `ChainProvider`, which `RpcChain` now takes. The names in each task's Interfaces match
the code blocks.
