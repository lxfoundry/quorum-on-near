# Live Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or
> executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for
> tracking.

**Goal:** Build `apps/web`, the live page the gateway serves at `/`: one of the provider's pools as
the chain holds it, refreshed every 2 seconds, with its terms, its seats filling towards the target,
the time left, its ledger totals beside the pools contract's token balance, and every buyer's state
with links to its transactions.

**Architecture:** A static page with no build step: `index.html`, `style.css` and two ES modules.
`totals.js` holds all the page's logic as pure functions (see File Structure) and is unit-tested
with vitest. `app.js` only fetches and renders, and writes every value as text or as an attribute.
The page reads the gateway's `/config.json`, then the pools contract's and the token's views
through the RPC that configuration names (the gateway's `/rpc` pass-through when it is on), and
the gateway's activity feed. The JavaScript carries JSDoc types that `tsc` checks (`checkJs`). The
gateway already serves the folder, `/config.json`, `/rpc` and `/activity`; this plan does not
change it.

**Tech Stack:** Node 22.22.2 or later and pnpm 10 (for the tests and the typecheck only); plain
JavaScript ES modules in the browser, with JSDoc types checked by TypeScript 5.9.3; vitest 4.1.12;
@types/node 22.20.5. No runtime dependency.

**Spec:** [`../specs/2026-11-09-quorum-on-near-design.md`](../specs/2026-11-09-quorum-on-near-design.md).
Executors read the spec and this plan together. Section numbers below refer to the spec. Section 8
describes the page; the page also relies on the views of section 5.4, invariant 1 of section 5.5,
the endpoints of section 6.1 and the activity feed of section 6.7.

## Status of the code in this plan

The code and tests of Tasks 1 and 2 were typechecked with `tsc` and run with vitest before this plan
was written, with the pinned versions above. Each task was also checked on its own, with only its
files and earlier tasks' present: it typechecks and passes with the counts its steps state, and
`pnpm typecheck` and `pnpm test` pass over the whole workspace. Copy the code as written.

The page was also checked as Task 3 describes before this plan was written, in headless Chrome,
against the real gateway serving `apps/web` with its RPC pass-through on, over a local NEAR
sandbox in which the swarm (from the swarm and MCP server plan, through its command line and its
sandbox harness) filled one pool and let another expire and be refunded. Every field of the pool
card, the buyer table and the ledger matched the chain, read independently through the RPC, at
every stable point. Seller terms containing markup rendered as text; failed refreshes showed the
status line and recovered; at 375 px wide the page had no horizontal scroll; and the pass-through
accepted every `/rpc` body the page sent.

## Global Constraints

Every task's requirements include this section.

- **Runtime:** Node 22.22.2 or later and pnpm 10 through Corepack, for the tests and the typecheck.
  The page itself runs in the browser as written.
- **Dependencies:** `apps/web` has no `dependencies`. Its `devDependencies` are exactly
  `@types/node` 22.20.5, `typescript` 5.9.3 and `vitest` 4.1.12, written as exact versions. Add no
  other package.
- **No build step:** the browser loads `index.html`, `style.css`, `app.js` and `totals.js` as they
  are in the repository. The two scripts are ES modules that import only `./<name>.js` files of
  `apps/web`: no bare specifier, no bundler, no transpiler. Types are JSDoc comments that `tsc`
  checks (`allowJs` and `checkJs` in `apps/web/tsconfig.json`, `noEmit` from `tsconfig.base.json`).
- **Never write HTML from a string:** no `innerHTML`, `outerHTML`, `insertAdjacentHTML` or
  `document.write` in either script. Every value read from the RPC, the gateway or the page URL is
  set with `textContent`, as a DOM property (`href`, `value`, `max`, `title`, `dataset`) or as an
  attribute.
- **The banner, word for word:** "The provider is simulated, and prices are scaled down 10,000
  times. The money flow is real: USDC on NEAR testnet." It is static, whatever the network.
- **Say what is simulated:** the provider and the access it sells are simulated. No UI text, code
  comment or commit message describes them as real.
- **Read only:** the page never signs anything and needs no wallet. It sends the gateway only
  `GET /config.json` and `GET /activity?pool=<id>`, and the configured RPC URL only `POST`s of a
  JSON-RPC `query` with `request_type: "call_function"` at `finality: "optimistic"`, on the pools
  contract or the token: the calls the gateway's `/rpc` pass-through forwards (section 6.1).
- **Only the provider's pools:** a pool whose `seller` is not exactly the `provider` of
  `/config.json` is never rendered; a notice naming its seller takes its place.
- **Amounts** are decimal strings of base units at the edges and `bigint` inside, never a JavaScript
  `number`. They are shown with all the token's decimals and its symbol, as in `0.000180 USDC`.
- **A pool's deadline** is compared with block time by the contract. The page's countdown reads
  the browser's clock and is for display only.
- **Timings:** a refresh every 2 seconds, the countdown redrawn every second, each request aborted
  after 10 seconds; a refresh never starts while the previous one runs.
- **Repository rules:** commit messages are neutral, technical and in the present tense. Work on a
  branch, never `main`. Stage explicit paths, never `git add -A` or `git add .`. Nothing refers to a
  file outside this repository.

## File Structure

| Path | Responsibility |
|---|---|
| `apps/web/package.json`, `apps/web/tsconfig.json` | The package: no runtime dependency; `test` and `typecheck` scripts; `checkJs` over `*.js` and `test`, with the DOM library |
| `apps/web/totals.js` | All the page's logic, as pure functions: the view-call body and the decoding of its answer, structural checks, the ledger totals, the buyer rows and explorer links, the choice of pool, the notice for another seller's pool, the countdown |
| `apps/web/app.js` | Fetching and rendering: `/config.json` and `ft_metadata` once, then every 2 seconds the views and the feed; the pool card, the ledger, the buyer table, the status line |
| `apps/web/index.html` | The markup: the header with the banner, the pool selector and the status line, the pool card, the ledger, the buyer table, the footer |
| `apps/web/style.css` | Layout, and colour tokens for light and dark schemes |
| `apps/web/test/totals.test.ts` | Unit tests of `totals.js` |
| `apps/web/test/page.test.ts` | Static checks of the page: the banner, the script and stylesheet tags, the inline icon, every element id `app.js` looks up, local imports only, no HTML written from a string |
| `pnpm-lock.yaml` | Gains the `apps/web` importer (Task 1) |
| `docs/specs/2026-11-09-quorum-on-near-design.md` | Section 8 records the page as built (Task 1) |
| `CLAUDE.md` | The Layout row, the Toolchain paragraph and the Architecture sentence (Task 3) |

**Out of scope:** the gateway, which already serves `apps/web` at `/` (`QUORUM_WEB_DIR`), answers
`/config.json` and `/activity`, and forwards view calls through `/rpc` when `QUORUM_RPC_PASSTHROUGH`
is `true`; the swarm and the MCP server, which the swarm and MCP server plan builds (Task 3 can use
its swarm to make pools to look at).

---

### Task 0: Toolchain

No code and no commit. Run these once.

- [ ] **Step 1: Install Node 22.22.2 or later**

Check with `node --version`. If it is older, install a current Node 22 with a version manager, for
example fnm:

```bash
# Linux, macOS or WSL2
curl -fsSL https://fnm.vercel.app/install | bash
# open a new shell (the installer adds fnm to the shell profile), then:
eval "$(fnm env --use-on-cd)"
fnm install 22 && fnm use 22
```

```powershell
# Windows
winget install Schniz.fnm
# open a new PowerShell window, then:
fnm env --use-on-cd --shell powershell | Out-String | Invoke-Expression
fnm install 22; fnm use 22
```

`fnm use` fails until `fnm env` has set up the current shell. To keep it, add the `fnm env` line to
the shell profile (`~/.bashrc`, or `$PROFILE` in PowerShell).

- [ ] **Step 2: Enable pnpm through Corepack**

```bash
corepack enable
corepack prepare pnpm@10.23.0 --activate
pnpm --version
```

Expected: `10.23.0`. Corepack then uses the `packageManager` version from the root `package.json`.

- [ ] **Step 3: Install the workspace**

At the repository's root, on an up-to-date `main`:

```bash
git switch main
git pull --ff-only
pnpm install
```

Expected: the workspace's dependencies install.

- [ ] **Step 4: Note where each task runs**

Tasks 1 and 2 run anywhere Node runs, Windows included. On Windows, run the `bash` blocks in Git
Bash: some use `mkdir -p` and here-documents, which PowerShell does not accept. Task 3 needs a
browser, a running gateway and pools of its provider on a chain; its sandbox route needs Linux,
macOS on Apple silicon or WSL2, as the swarm and MCP server plan's sandbox harness does.

---

### Task 1: The page's totals and the web package

The package goes in first, at its final content, so that `pnpm --filter @quorum-on-near/web` finds
it and vitest is installed. Its `tsconfig.json` includes `*.js` and `test`, which at this point
matches only `totals.js` and its test, and it adds the `DOM` library to the base configuration's
`ES2023`; `@types/node` is needed from the start because `tsconfig.base.json` sets `types: ["node"]`.
Task 2 does not touch `package.json`, `tsconfig.json` or the lockfile.

`totals.js` holds every computation the page makes, with no input or output of its own, so that all
of it is unit-tested. Amounts are decimal strings of base units at the edges and `bigint` inside;
anything malformed throws a `PageDataError`, which the page reports on its status line. The totals
of one pool, from its `get_pool` view and its `get_seats` rows:

- *paid in* is `taken × seat_price`;
- *refunded* and *bonus paid out* sum, over the buyers in state `refunded`, `seats × seat_price` and
  `seats × bonus_per_seat`;
- while the pool is `open` or `filled`, *held now* is paid in plus the bonus;
- once it is `settled`, *paid to the seller* is paid in plus the bonus, and nothing is held;
- once it is `expired` or `refunded`, the dust is `bonus − bonus_per_seat × taken`: it counts as paid
  to the seller as soon as `dust_sent` is set, and as held before; *held now* also counts
  `seats × (seat_price + bonus_per_seat)` of every buyer still `committed` or `claimable`.

So paid in plus the bonus always equals the four other totals together, and held now is what
invariant 1 (section 5.5) says the contract owes for this pool. The tests use two pools shaped like
the swarm's scenarios: `fills` (180 a seat, 192 seats, a bonus of 1,728) and `fails` once expired
(320 a seat, 100 of 192 seats taken, a bonus of 3,072, so 30 a seat and a dust of 72). The task ends
by recording in the spec what the page does.

**Files:**
- Create: `apps/web/package.json`, `apps/web/tsconfig.json`, `apps/web/totals.js`
- Modify: `pnpm-lock.yaml` (the `apps/web` importer, written by `pnpm install`),
  `docs/specs/2026-11-09-quorum-on-near-design.md` (section 8; last steps)
- Test: `apps/web/test/totals.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks. The workspace root on `main` (`package.json`,
  `pnpm-workspace.yaml` with `apps/*`, `tsconfig.base.json`).
- Produces:
  - package `@quorum-on-near/web`: private, `"type": "module"`, no dependencies; devDependencies
    `@types/node` 22.20.5, `typescript` 5.9.3, `vitest` 4.1.12; scripts `test` = `vitest run`,
    `typecheck` = `tsc -p tsconfig.json`.
  - `tsconfig.json`: extends `../../tsconfig.base.json`; `lib: ["ES2023", "DOM"]`, `allowJs`,
    `checkJs`; `include: ["*.js", "test"]`.
  - `export class PageDataError extends Error { constructor(message: string) }`, whose `name` is
    `"PageDataError"`.
  - `export function formatUnits(amount: string, decimals: number): string`
  - `export function formatAmount(amount: string, token: TokenInfo): string`
  - `export function poolTotals(pool: PoolView, seats: SeatView[]): PoolTotals`
  - `export function txUrl(explorerTxUrl: string, txHash: string): string | null`
  - `export function buyerRows(pool: PoolView, seats: SeatView[], activity: ActivityRecord[], explorerTxUrl: string): BuyerRow[]`
  - `export function payoutLinks(pool: PoolView, activity: ActivityRecord[], explorerTxUrl: string): TxLink[]`
  - `export function viewRequest(id: number, accountId: string, methodName: string, args: Record<string, unknown>)`,
    which returns `{ jsonrpc: '2.0', id, method: 'query', params: { request_type: 'call_function', account_id, method_name, args_base64, finality: 'optimistic' } }`
  - `export function viewResult(response: unknown): unknown`
  - `export function parsePool(value: unknown): PoolView`
  - `export function parsePools(value: unknown): PoolView[]`
  - `export function parseSeats(value: unknown): SeatView[]`
  - `export function parseActivity(value: unknown): ActivityRecord[]`
  - `export function parseConfig(value: unknown): PageConfig`
  - `export function parseToken(value: unknown): TokenInfo`
  - `export function parseBalance(value: unknown): string`
  - `export async function readAll<T>(readPage: (from: number, limit: number) => Promise<T[]>): Promise<T[]>`,
    which reads pages of 100 until a short page
  - `export function poolParam(search: string): number | null`
  - `export function poolChoices(pools: PoolView[], provider: string, requested: number | null): { options: number[], selected: number | null }`
  - `export function foreignPoolNotice(pool: PoolView, provider: string): string | null`
  - `export function countdown(deadlineMs: number, nowMs: number): string`
  - JSDoc types, imported elsewhere with `@import` or `import type`:
    - `PoolStatus = 'open' | 'filled' | 'settled' | 'expired' | 'refunded'`
    - `BuyerState = 'committed' | 'refunded' | 'claimable'`
    - `PoolView = { id: number, seller: string, seat_price: string, target: number, taken: number, deadline_ms: number, bonus: string, terms: string, status: PoolStatus, bonus_per_seat: string, dust_sent: boolean }`
    - `SeatView = { buyer: string, seats: number, state: BuyerState }`
    - `PoolTotals = { paidIn: string, paidToSeller: string, refunded: string, bonusPaidOut: string, heldNow: string }`
    - `ActivityRecord = { at: number, poolId: number, kind: 'commit' | 'settle' | 'refund' | 'dust', account: string, seats: number, amount: string, txHash: string, ok: boolean }`
    - `TxLink = { label: string, href: string }`
    - `BuyerRow = { buyer: string, seats: number, paid: string, state: BuyerState | 'settled', bonusShare: string | null, links: TxLink[] }`
    - `TokenInfo = { decimals: number, symbol: string }`
    - `PageConfig = { network: string, rpcUrl: string, poolsContract: string, token: string, provider: string, explorerTxUrl: string }`

- [ ] **Step 1: Create the branch**

```bash
git switch main
git pull --ff-only
git switch -c feat/live-page
```

- [ ] **Step 2: Write the package manifest and its TypeScript configuration, and install**

Create the folders: `mkdir -p apps/web/test`.

`apps/web/package.json`:

```json
{
  "name": "@quorum-on-near/web",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json"
  },
  "devDependencies": {
    "@types/node": "22.20.5",
    "typescript": "5.9.3",
    "vitest": "4.1.12"
  }
}
```

`apps/web/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2023", "DOM"],
    "allowJs": true,
    "checkJs": true
  },
  "include": ["*.js", "test"]
}
```

```bash
pnpm install
git diff --stat
```

Expected: `pnpm install` adds an `apps/web` importer, listing the three devDependencies, to
`pnpm-lock.yaml`, and changes nothing else in it: `git diff --stat` shows `pnpm-lock.yaml` with 12
insertions and no deletion.

- [ ] **Step 3: Write the failing tests**

`apps/web/test/totals.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import {
  PageDataError,
  buyerRows,
  countdown,
  foreignPoolNotice,
  formatAmount,
  formatUnits,
  parseActivity,
  parseBalance,
  parseConfig,
  parsePool,
  parsePools,
  parseSeats,
  parseToken,
  payoutLinks,
  poolChoices,
  poolParam,
  poolTotals,
  readAll,
  txUrl,
  viewRequest,
  viewResult,
  type ActivityRecord,
  type PoolView,
  type SeatView,
} from '../totals.js';

const EXPLORER = 'https://testnet.nearblocks.io/txns/';
const COMMIT_1 = 'Ev64qpcqroBNeET1xax4ei5vDc1sJTyNSZRpj5GdYYTy';
const COMMIT_2 = 'FmHDvha1UrjFE2KZN9NKRTrygpw2iXNsQquSFVHcfGyM';
const REFUND_1 = '73kVxs4q7MPWXkh1cCTN3iNPk9jRnhUu5TKSE22ZeK55';
const REFUND_2 = '9PyUT7YuigXdQabWvzCri8xHHLscmzCfSoZAzC553xj5';
const SETTLE = '9BAD9UzcJxWNppT8pPBVfpzbu4P9yqgu1nCdnTCYkBjY';
const DUST = '4CXz4yT4z2YG41en4VxM87WP5ZwVzCFSyh52Ug5sztxV';

/** The `fills` pool of the swarm: 180 a seat, 192 seats, a bonus of 1728. */
function fillsPool(overrides: Partial<PoolView> = {}): PoolView {
  return {
    id: 3,
    seller: 'provider.quorum.testnet',
    seat_price: '180',
    target: 192,
    taken: 192,
    deadline_ms: 1_800_000_600_000,
    bonus: '1728',
    terms: '8×GPU × 24 h; 1 seat = 1 GPU-hour; prices at 1/10,000 scale',
    status: 'filled',
    bonus_per_seat: '0',
    dust_sent: false,
    ...overrides,
  };
}

/** The `fails` pool of the swarm once expired: 320 a seat, 100 of 192 seats taken, a bonus of 3072, so 30 a seat and a dust of 72. */
function failsPool(overrides: Partial<PoolView> = {}): PoolView {
  return {
    id: 4,
    seller: 'provider.quorum.testnet',
    seat_price: '320',
    target: 192,
    taken: 100,
    deadline_ms: 1_800_000_180_000,
    bonus: '3072',
    terms: '8×GPU × 24 h; 1 seat = 1 GPU-hour; prices at 1/10,000 scale',
    status: 'expired',
    bonus_per_seat: '30',
    dust_sent: false,
    ...overrides,
  };
}

/** The 100 seats of the fails pool, in commit order, each buyer in `state` unless `states` says otherwise. */
function failsSeats(state: SeatView['state'], states: Record<string, SeatView['state']> = {}): SeatView[] {
  const seats: [string, number][] = [
    ['buyer-01.quorum.testnet', 24],
    ['buyer-02.quorum.testnet', 20],
    ['buyer-03.quorum.testnet', 18],
    ['buyer-04.quorum.testnet', 16],
    ['buyer-05.quorum.testnet', 12],
    ['buyer-06.quorum.testnet', 10],
  ];
  return seats.map(([buyer, n]) => ({ buyer, seats: n, state: states[buyer] ?? state }));
}

function activity(overrides: Partial<ActivityRecord>): ActivityRecord {
  return {
    at: 1_800_000_000_000,
    poolId: 4,
    kind: 'commit',
    account: 'buyer-01.quorum.testnet',
    seats: 24,
    amount: '7680',
    txHash: COMMIT_1,
    ok: true,
    ...overrides,
  };
}

/** Two buyers holding all 192 seats of the fills pool. */
const FILLS_SEATS: SeatView[] = [
  { buyer: 'buyer-01.quorum.testnet', seats: 100, state: 'committed' },
  { buyer: 'buyer-02.quorum.testnet', seats: 92, state: 'committed' },
];

describe('formatUnits', () => {
  it('shows a scaled seat price with all six decimals', () => {
    expect(formatUnits('180', 6)).toBe('0.000180');
  });

  it('shows 0 with all its decimals', () => {
    expect(formatUnits('0', 6)).toBe('0.000000');
  });

  it('puts the whole units before the point', () => {
    expect(formatUnits('12345678', 6)).toBe('12.345678');
  });

  it('keeps every digit of an amount beyond the range of a number', () => {
    expect(formatUnits('340282366920938463463374607431768211455', 6)).toBe('340282366920938463463374607431768.211455');
  });

  it('shows a token with no decimals as a whole number', () => {
    expect(formatUnits('180', 0)).toBe('180');
  });

  it.each(['', '-1', '1.5', '1e5', '007', ' 1'])('throws a PageDataError for the amount %j', (amount) => {
    expect(() => formatUnits(amount, 6)).toThrow(PageDataError);
  });

  it.each([-1, 1.5, Number.NaN])('throws a PageDataError for %s decimals', (decimals) => {
    expect(() => formatUnits('180', decimals)).toThrow(PageDataError);
  });
});

describe('formatAmount', () => {
  it('follows the amount with the token symbol', () => {
    expect(formatAmount('1728', { decimals: 6, symbol: 'USDC' })).toBe('0.001728 USDC');
  });
});

describe('poolTotals', () => {
  it('holds the seats paid so far and the bonus while the pool is open', () => {
    const seats: SeatView[] = [{ buyer: 'buyer-01.quorum.testnet', seats: 40, state: 'committed' }];
    expect(poolTotals(fillsPool({ status: 'open', taken: 40 }), seats)).toEqual({
      paidIn: '7200',
      paidToSeller: '0',
      refunded: '0',
      bonusPaidOut: '0',
      heldNow: '8928',
    });
  });

  it('holds every seat and the bonus once filled, until the payout', () => {
    expect(poolTotals(fillsPool(), FILLS_SEATS)).toEqual({
      paidIn: '34560',
      paidToSeller: '0',
      refunded: '0',
      bonusPaidOut: '0',
      heldNow: '36288',
    });
  });

  it('pays the seller every seat and the bonus back once settled, and holds nothing', () => {
    expect(poolTotals(fillsPool({ status: 'settled' }), FILLS_SEATS)).toEqual({
      paidIn: '34560',
      paidToSeller: '36288',
      refunded: '0',
      bonusPaidOut: '0',
      heldNow: '0',
    });
  });

  it('holds each refund and the dust of a pool that expired before any refund', () => {
    expect(poolTotals(failsPool(), failsSeats('committed'))).toEqual({
      paidIn: '32000',
      paidToSeller: '0',
      refunded: '0',
      bonusPaidOut: '0',
      heldNow: '35072',
    });
  });

  it('counts the refunds made so far and holds the rest while refunds are in progress', () => {
    const seats = failsSeats('committed', {
      'buyer-01.quorum.testnet': 'refunded',
      'buyer-02.quorum.testnet': 'refunded',
      'buyer-03.quorum.testnet': 'refunded',
    });
    // 62 seats refunded at 320 + 30; 38 seats still held at 350, plus the dust of 72.
    expect(poolTotals(failsPool(), seats)).toEqual({
      paidIn: '32000',
      paidToSeller: '0',
      refunded: '19840',
      bonusPaidOut: '1860',
      heldNow: '13372',
    });
  });

  it('pays the dust to the seller once it is sent, before the pool is marked refunded', () => {
    expect(poolTotals(failsPool({ dust_sent: true }), failsSeats('refunded'))).toEqual({
      paidIn: '32000',
      paidToSeller: '72',
      refunded: '32000',
      bonusPaidOut: '3000',
      heldNow: '0',
    });
  });

  it('pays every seat its price and 30 of the bonus, and the dust of 72 to the seller, once refunded', () => {
    expect(poolTotals(failsPool({ status: 'refunded', dust_sent: true }), failsSeats('refunded'))).toEqual({
      paidIn: '32000',
      paidToSeller: '72',
      refunded: '32000',
      bonusPaidOut: '3000',
      heldNow: '0',
    });
  });

  it('holds the refund of a buyer whose pushed refund failed (claimable)', () => {
    const seats = failsSeats('refunded', { 'buyer-06.quorum.testnet': 'claimable' });
    expect(poolTotals(failsPool({ status: 'refunded', dust_sent: true }), seats)).toEqual({
      paidIn: '32000',
      paidToSeller: '72',
      refunded: '28800',
      bonusPaidOut: '2700',
      heldNow: '3500',
    });
  });

  it('holds the whole bonus of a pool that expired with no seat, then pays it back to the seller', () => {
    const empty = failsPool({ taken: 0, bonus_per_seat: '0' });
    expect(poolTotals(empty, [])).toMatchObject({ paidIn: '0', paidToSeller: '0', heldNow: '3072' });
    expect(poolTotals({ ...empty, status: 'refunded', dust_sent: true }, [])).toMatchObject({ paidToSeller: '3072', heldNow: '0' });
  });

  it.each([
    ['open', fillsPool({ status: 'open', taken: 100 }), FILLS_SEATS.slice(0, 1)],
    ['filled', fillsPool(), FILLS_SEATS],
    ['settled', fillsPool({ status: 'settled' }), FILLS_SEATS],
    ['expired', failsPool(), failsSeats('committed', { 'buyer-02.quorum.testnet': 'refunded' })],
    ['expired, dust sent', failsPool({ dust_sent: true }), failsSeats('refunded', { 'buyer-04.quorum.testnet': 'claimable' })],
    ['refunded', failsPool({ status: 'refunded', dust_sent: true }), failsSeats('refunded')],
  ])('accounts for every unit paid in and every unit of the bonus when %s', (_status, pool, seats) => {
    const t = poolTotals(pool, seats);
    const out = BigInt(t.paidToSeller) + BigInt(t.refunded) + BigInt(t.bonusPaidOut) + BigInt(t.heldNow);
    expect(out).toBe(BigInt(t.paidIn) + BigInt(pool.bonus));
  });
});

describe('txUrl', () => {
  it('appends a transaction hash to the explorer URL', () => {
    expect(txUrl(EXPLORER, COMMIT_1)).toBe(`${EXPLORER}${COMMIT_1}`);
  });

  it('accepts a 43-character hash', () => {
    expect(txUrl(EXPLORER, DUST.slice(0, 43))).toBe(`${EXPLORER}${DUST.slice(0, 43)}`);
  });

  it.each([
    ['that is empty', ''],
    ['of 42 characters', COMMIT_1.slice(0, 42)],
    ['of 45 characters', `${COMMIT_1}1`],
    ['with a 0', `0${COMMIT_1.slice(1)}`],
    ['with an O', `O${COMMIT_1.slice(1)}`],
    ['with an I', `I${COMMIT_1.slice(1)}`],
    ['with an l', `l${COMMIT_1.slice(1)}`],
    ['with a path', `../${COMMIT_1.slice(3)}`],
    ['with markup', `<b>${COMMIT_1.slice(3)}`],
  ])('gives no link for a hash %s', (_kind, hash) => {
    expect(txUrl(EXPLORER, hash)).toBeNull();
  });
});

describe('buyerRows', () => {
  it('gives one row per buyer in commit order, with the price of its seats', () => {
    const rows = buyerRows(failsPool({ status: 'open' }), failsSeats('committed').slice(0, 2), [], EXPLORER);
    expect(rows).toEqual([
      { buyer: 'buyer-01.quorum.testnet', seats: 24, paid: '7680', state: 'committed', bonusShare: null, links: [] },
      { buyer: 'buyer-02.quorum.testnet', seats: 20, paid: '6400', state: 'committed', bonusShare: null, links: [] },
    ]);
  });

  it('keeps a buyer committed in a filled pool, before the payout', () => {
    expect(buyerRows(fillsPool(), FILLS_SEATS, [], EXPLORER).map((row) => row.state)).toEqual(['committed', 'committed']);
  });

  it('shows every buyer of a settled pool as settled, a state the contract does not store', () => {
    expect(buyerRows(fillsPool({ status: 'settled' }), FILLS_SEATS, [], EXPLORER).map((row) => row.state)).toEqual(['settled', 'settled']);
  });

  it('gives a refunded buyer its bonus share, the seats times the bonus per seat', () => {
    const seats = failsSeats('committed', { 'buyer-02.quorum.testnet': 'refunded' });
    const row = buyerRows(failsPool(), seats, [], EXPLORER)[1];
    expect(row).toMatchObject({ buyer: 'buyer-02.quorum.testnet', paid: '6400', state: 'refunded', bonusShare: '600' });
  });

  it('keeps a buyer whose pushed refund failed claimable, with no bonus share paid', () => {
    const seats = failsSeats('refunded', { 'buyer-06.quorum.testnet': 'claimable' });
    const row = buyerRows(failsPool({ status: 'refunded', dust_sent: true }), seats, [], EXPLORER)[5];
    expect(row).toMatchObject({ buyer: 'buyer-06.quorum.testnet', state: 'claimable', bonusShare: null });
  });

  it("links the buyer's commit and refund transactions in this pool, oldest first", () => {
    const feed = [
      activity({ kind: 'commit', txHash: COMMIT_1 }),
      activity({ kind: 'commit', txHash: COMMIT_2, seats: 0, amount: '0', ok: false }),
      activity({ kind: 'refund', txHash: REFUND_1, ok: false, seats: 0 }),
      activity({ kind: 'refund', txHash: REFUND_2 }),
    ];
    const [row] = buyerRows(failsPool(), failsSeats('refunded').slice(0, 1), feed, EXPLORER);
    expect(row?.links).toEqual([
      { label: 'commit', href: `${EXPLORER}${COMMIT_1}` },
      { label: 'commit (failed)', href: `${EXPLORER}${COMMIT_2}` },
      { label: 'refund (failed)', href: `${EXPLORER}${REFUND_1}` },
      { label: 'refund', href: `${EXPLORER}${REFUND_2}` },
    ]);
  });

  it("leaves out other buyers', other pools' and the seller's records, and hashes that are not base58", () => {
    const feed = [
      activity({ account: 'buyer-02.quorum.testnet', txHash: COMMIT_2 }),
      activity({ poolId: 5, txHash: REFUND_1 }),
      activity({ kind: 'dust', account: 'buyer-01.quorum.testnet', txHash: DUST }),
      activity({ kind: 'settle', account: 'buyer-01.quorum.testnet', txHash: SETTLE }),
      activity({ txHash: 'javascript:alert(1)' }),
    ];
    const [row] = buyerRows(failsPool(), failsSeats('committed').slice(0, 1), feed, EXPLORER);
    expect(row?.links).toEqual([]);
  });
});

describe('payoutLinks', () => {
  it("links the pool's settle transaction, after a settle call that failed", () => {
    const feed = [
      activity({ kind: 'commit', txHash: COMMIT_1 }),
      activity({ kind: 'settle', account: 'provider.quorum.testnet', txHash: COMMIT_2, seats: 0, amount: '0', ok: false }),
      activity({ kind: 'settle', account: 'provider.quorum.testnet', txHash: SETTLE, seats: 192, amount: '36288' }),
    ];
    expect(payoutLinks(fillsPool({ id: 4 }), feed, EXPLORER)).toEqual([
      { label: 'settle (failed)', href: `${EXPLORER}${COMMIT_2}` },
      { label: 'settle', href: `${EXPLORER}${SETTLE}` },
    ]);
  });

  it("links the pool's dust transaction, but not a refund call that failed nor another pool's dust", () => {
    const feed = [
      activity({ kind: 'refund', account: 'provider.quorum.testnet', txHash: REFUND_1, seats: 0, amount: '0', ok: false }),
      activity({ kind: 'dust', account: 'provider.quorum.testnet', txHash: DUST, seats: 0, amount: '72' }),
      activity({ kind: 'dust', poolId: 5, account: 'provider.quorum.testnet', txHash: REFUND_2, seats: 0, amount: '72' }),
    ];
    expect(payoutLinks(failsPool(), feed, EXPLORER)).toEqual([{ label: 'dust', href: `${EXPLORER}${DUST}` }]);
  });
});

describe('viewRequest', () => {
  it('builds a call_function query at optimistic finality, with the arguments as base64 JSON', () => {
    expect(viewRequest(7, 'pools.quorum.testnet', 'get_seats', { pool_id: 4, from: 0, limit: 100 })).toStrictEqual({
      jsonrpc: '2.0',
      id: 7,
      method: 'query',
      params: {
        request_type: 'call_function',
        account_id: 'pools.quorum.testnet',
        method_name: 'get_seats',
        args_base64: 'eyJwb29sX2lkIjo0LCJmcm9tIjowLCJsaW1pdCI6MTAwfQ==',
        finality: 'optimistic',
      },
    });
  });
});

describe('viewResult', () => {
  const answer = (result: unknown) => ({ jsonrpc: '2.0', id: 7, result });

  it('decodes the bytes of a view result as UTF-8 JSON', () => {
    // The bytes of {"terms":"8×GPU","decimals":6}, where × takes two bytes.
    const bytes = [123, 34, 116, 101, 114, 109, 115, 34, 58, 34, 56, 195, 151, 71, 80, 85, 34, 44, 34, 100, 101, 99, 105, 109, 97, 108, 115, 34, 58, 54, 125];
    expect(viewResult(answer({ result: bytes, logs: [], block_height: 1, block_hash: 'h' }))).toEqual({ terms: '8×GPU', decimals: 6 });
  });

  it('gives null for a view that returned null, such as get_pool of a pool that does not exist', () => {
    expect(viewResult(answer({ result: [110, 117, 108, 108], logs: [] }))).toBeNull();
  });

  it('throws a PageDataError naming the cause of an error the RPC answered', () => {
    const error = { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_ACCOUNT', info: {} }, code: -32000, message: 'Server error' };
    expect(() => viewResult({ jsonrpc: '2.0', id: 7, error })).toThrow(new PageDataError('the RPC answered UNKNOWN_ACCOUNT'));
  });

  it('throws a PageDataError naming an error the gateway pass-through answered', () => {
    expect(() => viewResult({ error: 'chain_unavailable' })).toThrow(new PageDataError('the RPC answered chain_unavailable'));
  });

  it('throws a PageDataError for a view that failed in the contract', () => {
    const failed = answer({ error: 'wasm execution failed with error: MethodResolveError(MethodNotFound)', logs: [] });
    expect(() => viewResult(failed)).toThrow(PageDataError);
  });

  it.each([
    ['an answer that is not an object', 'ok'],
    ['an answer with no result', { jsonrpc: '2.0', id: 7 }],
    ['a result that is not bytes', answer({ result: [256] })],
    ['bytes that are not JSON', answer({ result: [123, 34, 97, 34] })],
  ])('throws a PageDataError for %s', (_kind, response) => {
    expect(() => viewResult(response)).toThrow(PageDataError);
  });
});

/** A `get_pool` row as the contract returns it, with the fields the page does not read. */
const POOL_ROW = {
  id: 4,
  seller: 'provider.quorum.testnet',
  seat_price: '320',
  target: 192,
  taken: 100,
  deadline_ms: 1_800_000_180_000,
  bonus: '3072',
  max_seats_per_buyer: 24,
  terms: '8×GPU × 24 h; 1 seat = 1 GPU-hour; prices at 1/10,000 scale',
  status: 'expired',
  bonus_per_seat: '30',
  refund_cursor: 0,
  dust_sent: false,
  buyer_count: 6,
};

describe('parsePool', () => {
  it('accepts a get_pool row', () => {
    expect(parsePool(POOL_ROW)).toEqual(POOL_ROW);
  });

  it.each([
    ['null', null],
    ['a negative id', { ...POOL_ROW, id: -1 }],
    ['a seat price as a number', { ...POOL_ROW, seat_price: 320 }],
    ['a bonus with a sign', { ...POOL_ROW, bonus: '-3072' }],
    ['a fractional taken', { ...POOL_ROW, taken: 1.5 }],
    ['an unknown status', { ...POOL_ROW, status: 'closed' }],
    ['terms that are not text', { ...POOL_ROW, terms: ['8×GPU'] }],
    ['no dust_sent', { ...POOL_ROW, dust_sent: undefined }],
    ['no seller', { ...POOL_ROW, seller: undefined }],
  ])('throws a PageDataError for %s', (_kind, row) => {
    expect(() => parsePool(row)).toThrow(PageDataError);
  });
});

describe('parsePools', () => {
  it('accepts a list_pools page', () => {
    expect(parsePools([POOL_ROW, { ...POOL_ROW, id: 5 }]).map((pool) => pool.id)).toEqual([4, 5]);
  });

  it('throws a PageDataError for a page that is not a list', () => {
    expect(() => parsePools(POOL_ROW)).toThrow(PageDataError);
  });

  it('throws a PageDataError for a page that holds a malformed row', () => {
    expect(() => parsePools([POOL_ROW, { ...POOL_ROW, status: 'closed' }])).toThrow(PageDataError);
  });
});

describe('parseSeats', () => {
  it('accepts a get_seats page', () => {
    const rows = [
      { buyer: 'buyer-01.quorum.testnet', seats: 24, state: 'committed' },
      { buyer: 'buyer-02.quorum.testnet', seats: 20, state: 'claimable' },
    ];
    expect(parseSeats(rows)).toEqual(rows);
  });

  it.each([
    ['not a list', { buyer: 'buyer-01.quorum.testnet', seats: 24, state: 'committed' }],
    ['a row with an unknown state', [{ buyer: 'buyer-01.quorum.testnet', seats: 24, state: 'settled' }]],
    ['a row with seats as text', [{ buyer: 'buyer-01.quorum.testnet', seats: '24', state: 'committed' }]],
    ['a row with no buyer', [{ seats: 24, state: 'committed' }]],
  ])('throws a PageDataError for a page that is %s', (_kind, page) => {
    expect(() => parseSeats(page)).toThrow(PageDataError);
  });
});

describe('parseActivity', () => {
  it('accepts the records of the activity feed', () => {
    const feed = [activity({}), activity({ kind: 'dust', account: 'provider.quorum.testnet', seats: 0, amount: '72' })];
    expect(parseActivity(feed)).toEqual(feed);
  });

  it.each([
    ['not a list', activity({})],
    ['a record of an unknown kind', [{ ...activity({}), kind: 'claim' }]],
    ['a record with no hash', [{ ...activity({}), txHash: undefined }]],
    ['a record with ok as text', [{ ...activity({}), ok: 'true' }]],
    ['a record with an amount as a number', [{ ...activity({}), amount: 7680 }]],
  ])('throws a PageDataError for a feed that is %s', (_kind, feed) => {
    expect(() => parseActivity(feed)).toThrow(PageDataError);
  });
});

describe('parseConfig', () => {
  const CONFIG = {
    network: 'near:testnet',
    rpcUrl: '/rpc',
    poolsContract: 'pools.quorum.testnet',
    token: '3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af',
    provider: 'provider.quorum.testnet',
    explorerTxUrl: EXPLORER,
  };

  it("accepts the gateway's /config.json", () => {
    expect(parseConfig(CONFIG)).toEqual(CONFIG);
  });

  it.each([
    ['not an object', [CONFIG]],
    ['missing the provider', { ...CONFIG, provider: undefined }],
    ['an RPC URL that is not text', { ...CONFIG, rpcUrl: 8402 }],
    ['an explorer URL that is not http(s)', { ...CONFIG, explorerTxUrl: 'javascript:alert(1)//' }],
    ['an explorer URL that is not a URL', { ...CONFIG, explorerTxUrl: 'nearblocks' }],
  ])('throws a PageDataError for a configuration with %s', (_kind, config) => {
    expect(() => parseConfig(config)).toThrow(PageDataError);
  });
});

describe('parseToken', () => {
  const METADATA = { spec: 'ft-1.0.0', name: 'USDC', symbol: 'USDC', icon: null, reference: null, reference_hash: null, decimals: 6 };

  it('keeps the decimals and the symbol of ft_metadata', () => {
    expect(parseToken(METADATA)).toStrictEqual({ decimals: 6, symbol: 'USDC' });
  });

  it.each([
    ['decimals as text', { ...METADATA, decimals: '6' }],
    ['negative decimals', { ...METADATA, decimals: -1 }],
    ['decimals beyond a u8', { ...METADATA, decimals: 256 }],
    ['no symbol', { ...METADATA, symbol: undefined }],
  ])('throws a PageDataError for metadata with %s', (_kind, metadata) => {
    expect(() => parseToken(metadata)).toThrow(PageDataError);
  });

  it('throws a PageDataError for null', () => {
    expect(() => parseToken(null)).toThrow(PageDataError);
  });
});

describe('parseBalance', () => {
  it('accepts the decimal string ft_balance_of returns', () => {
    expect(parseBalance('35072')).toBe('35072');
  });

  it.each([35072, '-1', null])('throws a PageDataError for %j', (balance) => {
    expect(() => parseBalance(balance)).toThrow(PageDataError);
  });
});

describe('readAll', () => {
  /** A paged view over `count` rows, recording each call's `from` and `limit`. */
  function pagedView(count: number) {
    const rows = Array.from({ length: count }, (_, i) => i);
    const calls: [number, number][] = [];
    const readPage = async (from: number, limit: number) => {
      calls.push([from, limit]);
      return rows.slice(from, from + limit);
    };
    return { readPage, calls };
  }

  it('reads a single page when it is shorter than 100 rows', async () => {
    const { readPage, calls } = pagedView(6);
    expect(await readAll(readPage)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(calls).toEqual([[0, 100]]);
  });

  it('reads pages of 100 until a shorter one', async () => {
    const { readPage, calls } = pagedView(203);
    expect(await readAll(readPage)).toHaveLength(203);
    expect(calls).toEqual([
      [0, 100],
      [100, 100],
      [200, 100],
    ]);
  });

  it('reads one empty page after a last page that is full', async () => {
    const { readPage, calls } = pagedView(100);
    expect(await readAll(readPage)).toHaveLength(100);
    expect(calls).toEqual([
      [0, 100],
      [100, 100],
    ]);
  });
});

describe('poolParam', () => {
  it.each([
    ['?pool=7', 7],
    ['?pool=0', 0],
    ['?view=1&pool=12', 12],
  ])('reads the pool id of %j', (search, id) => {
    expect(poolParam(search)).toBe(id);
  });

  it.each(['', '?pool=', '?pool=07', '?pool=-1', '?pool=1.5', '?pool=x', '?pool=9007199254740993'])(
    'gives null for %j, so that the newest pool is shown',
    (search) => {
      expect(poolParam(search)).toBeNull();
    },
  );
});

describe('poolChoices', () => {
  const PROVIDER = 'provider.quorum.testnet';
  const pools = [
    failsPool({ id: 0 }),
    failsPool({ id: 1, seller: 'someone.testnet' }),
    failsPool({ id: 2 }),
    failsPool({ id: 3 }),
  ];

  it("offers the provider's pools, newest first, and shows the newest", () => {
    expect(poolChoices(pools, PROVIDER, null)).toEqual({ options: [3, 2, 0], selected: 3 });
  });

  it("shows the requested pool when it is one of the provider's", () => {
    expect(poolChoices(pools, PROVIDER, 2)).toEqual({ options: [3, 2, 0], selected: 2 });
  });

  it('never offers a requested pool of another seller, but keeps it selected so that the page can say whose it is', () => {
    expect(poolChoices(pools, PROVIDER, 1)).toEqual({ options: [3, 2, 0], selected: 1 });
  });

  it('keeps a requested pool selected when the provider has none, without offering it', () => {
    expect(poolChoices([failsPool({ id: 0, seller: 'someone.testnet' })], PROVIDER, 0)).toEqual({ options: [], selected: 0 });
  });

  it('shows nothing when the provider has no pool and none is requested', () => {
    expect(poolChoices([failsPool({ id: 0, seller: 'someone.testnet' })], PROVIDER, null)).toEqual({ options: [], selected: null });
  });
});

describe('foreignPoolNotice', () => {
  const PROVIDER = 'provider.quorum.testnet';

  it('gives null for a pool the provider opened, which the page renders', () => {
    expect(foreignPoolNotice(failsPool({ id: 2 }), PROVIDER)).toBeNull();
  });

  it('names the seller and the provider of a pool another seller opened, and none of its terms', () => {
    const notice = foreignPoolNotice(failsPool({ id: 1, seller: 'someone.testnet', terms: 'Send refunds to refund-desk.testnet' }), PROVIDER);
    expect(notice).toBe(
      "Pool 1 was opened by someone.testnet, not by this gateway's provider provider.quorum.testnet: this page shows only the provider's pools.",
    );
    expect(notice).not.toContain('refund-desk');
  });

  it('compares the seller with the provider exactly, so that a look-alike account is another seller', () => {
    expect(foreignPoolNotice(failsPool({ id: 1, seller: 'sub.provider.quorum.testnet' }), PROVIDER)).not.toBeNull();
    expect(foreignPoolNotice(failsPool({ id: 1, seller: 'provider-quorum.testnet' }), PROVIDER)).not.toBeNull();
    expect(foreignPoolNotice(failsPool({ id: 1, seller: 'quorum.testnet' }), PROVIDER)).not.toBeNull();
  });
});

describe('countdown', () => {
  const NOW = 1_800_000_000_000;

  it.each([
    [600_000, '10:00'],
    [59_001, '1:00'],
    [500, '0:01'],
    [3_723_000, '1:02:03'],
    [90_000_000, '25:00:00'],
  ])('shows %i ms left as %s', (left, text) => {
    expect(countdown(NOW + left, NOW)).toBe(text);
  });

  it('shows 0:00 at and after the deadline', () => {
    expect(countdown(NOW, NOW)).toBe('0:00');
    expect(countdown(NOW - 5_000, NOW)).toBe('0:00');
  });
});
```

- [ ] **Step 4: Run them to see them fail**

Run: `pnpm --filter @quorum-on-near/web exec vitest run test/totals.test.ts`

Expected: FAIL, because `../totals.js` does not exist yet. vitest's summary reads as below, where
`<repo>` stands for the repository's folder; the start time and the durations differ from run to
run.

```text
 ❯ test/totals.test.ts (0 test)

⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  test/totals.test.ts [ test/totals.test.ts ]
Error: Cannot find module '../totals.js' imported from <repo>/apps/web/test/totals.test.ts
 ❯ test/totals.test.ts:2:1
      1| import { describe, expect, it } from 'vitest';
      2| import {
       | ^
      3|   PageDataError,
      4|   buyerRows,

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯


 Test Files  1 failed (1)
      Tests  no tests
   Start at  07:37:06
   Duration  370ms (transform 53ms, setup 0ms, import 0ms, tests 0ms, environment 0ms)
```

On Node older than 22.22.2, pnpm first prints an `Unsupported engine` warning. On Windows, pnpm
10.23.0 then prints these extra lines, although vitest ran (on Linux, pnpm reports vitest's non-zero
exit instead):

```text
undefined
<repo>\apps\web:
 ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL  Command "vitest" not found
```

- [ ] **Step 5: Write the implementation**

`apps/web/totals.js`:

```javascript
/**
 * The live page's logic, as functions with no input or output of their own: the JSON-RPC body of a
 * view call and the decoding of its answer, structural checks of everything read from the RPC and
 * the gateway, the ledger totals, the buyer rows, the explorer links, the choice of pool, the notice
 * shown for another seller's pool and the countdown. Amounts are decimal strings in base units at the
 * edges and `bigint` inside.
 */

/**
 * A pool's status as the views report it. The contract derives it from block time: an Open pool
 * past its deadline is reported `expired`.
 * @typedef {'open' | 'filled' | 'settled' | 'expired' | 'refunded'} PoolStatus
 */
/** @typedef {'committed' | 'refunded' | 'claimable'} BuyerState */
/**
 * The fields of a `get_pool` or `list_pools` row that the page reads (the contract's names; amounts
 * are decimal strings in base units). `bonus_per_seat` is set once the pool is past its deadline.
 * `dust_sent` is set once every buyer has been visited and the dust is on its way to the seller, and
 * cleared again if that transfer fails.
 * @typedef {{
 *   id: number,
 *   seller: string,
 *   seat_price: string,
 *   target: number,
 *   taken: number,
 *   deadline_ms: number,
 *   bonus: string,
 *   terms: string,
 *   status: PoolStatus,
 *   bonus_per_seat: string,
 *   dust_sent: boolean,
 * }} PoolView
 */
/**
 * A `get_seats` row: one buyer of a pool, in commit order.
 * @typedef {{ buyer: string, seats: number, state: BuyerState }} SeatView
 */
/**
 * What a pool's money has done, in base units:
 * - `paidIn`: what the buyers paid for their seats;
 * - `paidToSeller`: the payout of a settled pool (every seat and the bonus back), or the dust of a
 *   refunded one once sent;
 * - `refunded`: the seat prices returned to buyers;
 * - `bonusPaidOut`: the bonus shares paid to buyers with their refunds;
 * - `heldNow`: what the contract still owes for this pool (spec section 5.5, invariant 1).
 * @typedef {{ paidIn: string, paidToSeller: string, refunded: string, bonusPaidOut: string, heldNow: string }} PoolTotals
 */
/**
 * One record of the gateway's activity feed (`GET /activity?pool=<id>`). `at` is milliseconds since
 * the epoch; `ok` is false for a commit that took no seat, a refund that could not be pushed, or a
 * keeper call that made no progress.
 * @typedef {{
 *   at: number,
 *   poolId: number,
 *   kind: 'commit' | 'settle' | 'refund' | 'dust',
 *   account: string,
 *   seats: number,
 *   amount: string,
 *   txHash: string,
 *   ok: boolean,
 * }} ActivityRecord
 */
/**
 * A link to a transaction in the explorer: `label` is the record's kind, followed by `(failed)`
 * when the record is not ok.
 * @typedef {{ label: string, href: string }} TxLink
 */
/**
 * One row of the buyer table. `paid` is what the buyer paid for its seats; `state` is `settled` for
 * every buyer of a settled pool, a state the contract does not store; `bonusShare` is set once the
 * buyer is refunded.
 * @typedef {{
 *   buyer: string,
 *   seats: number,
 *   paid: string,
 *   state: BuyerState | 'settled',
 *   bonusShare: string | null,
 *   links: TxLink[],
 * }} BuyerRow
 */
/**
 * A token's display facts, from its NEP-148 `ft_metadata`.
 * @typedef {{ decimals: number, symbol: string }} TokenInfo
 */
/**
 * The gateway's `/config.json`: what the page needs to read the chain. `rpcUrl` is `/rpc` when the
 * gateway's RPC pass-through is on.
 * @typedef {{
 *   network: string,
 *   rpcUrl: string,
 *   poolsContract: string,
 *   token: string,
 *   provider: string,
 *   explorerTxUrl: string,
 * }} PageConfig
 */

/** Thrown when data read from the RPC, the gateway or the page URL does not have the expected shape. */
export class PageDataError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'PageDataError';
  }
}

/** A whole number written in decimal, with no sign and no leading zero: an amount or a pool id. */
const DECIMAL = /^(0|[1-9][0-9]*)$/;
/** The most rows `list_pools` and `get_seats` return in one call (the contract's page size). */
const PAGE_SIZE = 100;

/**
 * Writes an amount of base units in whole units with all `decimals` digits after the point, so
 * that `formatUnits('180', 6)` is `"0.000180"`. Throws a PageDataError unless `amount` is a
 * decimal string with no sign and no leading zero, and `decimals` a non-negative integer.
 *
 * @param {string} amount
 * @param {number} decimals
 * @returns {string}
 */
export function formatUnits(amount, decimals) {
  if (!DECIMAL.test(amount)) throw new PageDataError(`${JSON.stringify(amount)} is not an amount`);
  if (!Number.isSafeInteger(decimals) || decimals < 0) throw new PageDataError(`${decimals} is not a number of decimals`);
  if (decimals === 0) return amount;
  const digits = amount.padStart(decimals + 1, '0');
  return `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`;
}

/**
 * An amount of base units in whole units followed by the token's symbol: `"0.001728 USDC"`.
 *
 * @param {string} amount
 * @param {TokenInfo} token
 * @returns {string}
 */
export function formatAmount(amount, token) {
  return `${formatUnits(amount, token.decimals)} ${token.symbol}`;
}

/**
 * The ledger totals of one pool, from its view and every one of its `get_seats` rows. A buyer
 * marked `refunded` counts as paid back, one still `committed` or `claimable` in a pool past its
 * deadline as owed. The dust (what is left of the bonus once each seat has its share) counts as
 * paid to the seller once `dust_sent` is set, and as held before. Paid in plus the bonus always
 * equals the four other totals together.
 *
 * @param {PoolView} pool
 * @param {SeatView[]} seats
 * @returns {PoolTotals}
 */
export function poolTotals(pool, seats) {
  const price = BigInt(pool.seat_price);
  const bonus = BigInt(pool.bonus);
  const share = BigInt(pool.bonus_per_seat);
  const paidIn = BigInt(pool.taken) * price;
  let refunded = 0n;
  let bonusPaidOut = 0n;
  let owedToBuyers = 0n;
  for (const row of seats) {
    const n = BigInt(row.seats);
    if (row.state === 'refunded') {
      refunded += n * price;
      bonusPaidOut += n * share;
    } else {
      owedToBuyers += n * (price + share);
    }
  }
  let paidToSeller = 0n;
  let heldNow = 0n;
  if (pool.status === 'open' || pool.status === 'filled') {
    heldNow = paidIn + bonus;
  } else if (pool.status === 'settled') {
    paidToSeller = paidIn + bonus;
  } else {
    const dust = bonus - share * BigInt(pool.taken);
    paidToSeller = pool.dust_sent ? dust : 0n;
    heldNow = owedToBuyers + (pool.dust_sent ? 0n : dust);
  }
  return {
    paidIn: paidIn.toString(),
    paidToSeller: paidToSeller.toString(),
    refunded: refunded.toString(),
    bonusPaidOut: bonusPaidOut.toString(),
    heldNow: heldNow.toString(),
  };
}

/**
 * A NEAR transaction hash is 32 bytes in base58: 43 or 44 characters of its alphabet, except for a
 * rare hash with leading zero bytes, which is shorter and gets no link.
 */
const TX_HASH = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;

/**
 * The explorer link of a transaction: `explorerTxUrl` followed by the hash, or null when the hash
 * is not a base58 transaction hash, so that a feed record can never make the page link elsewhere.
 * `explorerTxUrl` must be an http(s) URL, as `parseConfig` checks.
 *
 * @param {string} explorerTxUrl
 * @param {string} txHash
 * @returns {string | null}
 */
export function txUrl(explorerTxUrl, txHash) {
  return TX_HASH.test(txHash) ? `${explorerTxUrl}${txHash}` : null;
}

/**
 * The links of the records that pass `keep`, in feed order, leaving out any whose hash is not a
 * transaction hash.
 *
 * @param {ActivityRecord[]} activity
 * @param {(record: ActivityRecord) => boolean} keep
 * @param {string} explorerTxUrl
 * @returns {TxLink[]}
 */
function txLinks(activity, keep, explorerTxUrl) {
  /** @type {TxLink[]} */
  const links = [];
  for (const record of activity) {
    const href = keep(record) ? txUrl(explorerTxUrl, record.txHash) : null;
    if (href !== null) links.push({ label: record.ok ? record.kind : `${record.kind} (failed)`, href });
  }
  return links;
}

/**
 * The buyer table of a pool, one row per `get_seats` row in commit order, each with the links of
 * the buyer's commit and refund records for this pool.
 *
 * @param {PoolView} pool
 * @param {SeatView[]} seats
 * @param {ActivityRecord[]} activity
 * @param {string} explorerTxUrl
 * @returns {BuyerRow[]}
 */
export function buyerRows(pool, seats, activity, explorerTxUrl) {
  const price = BigInt(pool.seat_price);
  const share = BigInt(pool.bonus_per_seat);
  return seats.map((row) => {
    const n = BigInt(row.seats);
    const ownRecord = (/** @type {ActivityRecord} */ record) =>
      record.poolId === pool.id && record.account === row.buyer && (record.kind === 'commit' || record.kind === 'refund');
    return {
      buyer: row.buyer,
      seats: row.seats,
      paid: (n * price).toString(),
      state: pool.status === 'settled' && row.state === 'committed' ? 'settled' : row.state,
      bonusShare: row.state === 'refunded' ? (n * share).toString() : null,
      links: txLinks(activity, ownRecord, explorerTxUrl),
    };
  });
}

/**
 * The links of what a pool paid its seller: its `settle` records, or its `dust` record.
 *
 * @param {PoolView} pool
 * @param {ActivityRecord[]} activity
 * @param {string} explorerTxUrl
 * @returns {TxLink[]}
 */
export function payoutLinks(pool, activity, explorerTxUrl) {
  const payout = (/** @type {ActivityRecord} */ record) =>
    record.poolId === pool.id && (record.kind === 'settle' || record.kind === 'dust');
  return txLinks(activity, payout, explorerTxUrl);
}

/**
 * The JSON-RPC body of a view call: a `query` of `request_type: "call_function"` at optimistic
 * finality, with `args` as base64 of their JSON. It has exactly the fields the gateway's `/rpc`
 * pass-through accepts.
 *
 * @param {number} id
 * @param {string} accountId
 * @param {string} methodName
 * @param {Record<string, unknown>} args
 */
export function viewRequest(id, accountId, methodName, args) {
  const bytes = new TextEncoder().encode(JSON.stringify(args));
  return {
    jsonrpc: '2.0',
    id,
    method: 'query',
    params: {
      request_type: 'call_function',
      account_id: accountId,
      method_name: methodName,
      args_base64: btoa(String.fromCharCode(...bytes)),
      finality: 'optimistic',
    },
  };
}

/**
 * The value a view returned, decoded from the bytes of the RPC's answer as UTF-8 JSON. Throws a
 * PageDataError when the RPC (or the gateway's pass-through) answered an error, when the view
 * failed in the contract, or when the answer is not a view result.
 *
 * @param {unknown} response
 * @returns {unknown}
 */
export function viewResult(response) {
  if (!isObject(response)) throw new PageDataError('the RPC answer is not a JSON object');
  if (response.error !== undefined) throw new PageDataError(`the RPC answered ${errorName(response.error)}`);
  const { result } = response;
  if (!isObject(result)) throw new PageDataError('the RPC answer has no result');
  if (typeof result.error === 'string') throw new PageDataError(`the view failed: ${result.error}`);
  const bytes = result.result;
  if (!Array.isArray(bytes) || !bytes.every(isByte)) throw new PageDataError('the view result is not a list of bytes');
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes)));
  } catch {
    throw new PageDataError('the view result is not UTF-8 JSON');
  }
}

/**
 * The most telling name in a JSON-RPC error: NEAR's `cause.name` (such as `UNKNOWN_ACCOUNT`), else
 * its `name`, else its `message`. The gateway's pass-through answers a plain string.
 *
 * @param {unknown} error
 * @returns {string}
 */
function errorName(error) {
  if (typeof error === 'string') return error;
  if (isObject(error)) {
    if (isObject(error.cause) && typeof error.cause.name === 'string') return error.cause.name;
    if (typeof error.name === 'string') return error.name;
    if (typeof error.message === 'string') return error.message;
  }
  return 'an error';
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {value is number}
 */
function isCount(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * @param {unknown} value
 * @returns {value is number}
 */
function isByte(value) {
  return isCount(value) && value <= 255;
}

/**
 * @param {unknown} value
 * @returns {value is string}
 */
function isAmount(value) {
  return typeof value === 'string' && DECIMAL.test(value);
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isHttpUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * @template T
 * @param {unknown} value
 * @param {(item: unknown) => T} parseItem
 * @param {string} what
 * @returns {T[]}
 */
function parseList(value, parseItem, what) {
  if (!Array.isArray(value)) throw new PageDataError(`${what} is not a list`);
  return value.map((item) => parseItem(item));
}

const POOL_STATUSES = new Set(['open', 'filled', 'settled', 'expired', 'refunded']);
const BUYER_STATES = new Set(['committed', 'refunded', 'claimable']);
const ACTIVITY_KINDS = new Set(['commit', 'settle', 'refund', 'dust']);
const CONFIG_KEYS = ['network', 'rpcUrl', 'poolsContract', 'token', 'provider', 'explorerTxUrl'];

/**
 * A `get_pool` or `list_pools` row, checked field by field. Throws a PageDataError if any field
 * the page reads is missing or of the wrong form.
 *
 * @param {unknown} value
 * @returns {PoolView}
 */
export function parsePool(value) {
  if (
    isObject(value) &&
    isCount(value.id) &&
    typeof value.seller === 'string' &&
    isAmount(value.seat_price) &&
    isCount(value.target) &&
    isCount(value.taken) &&
    isCount(value.deadline_ms) &&
    isAmount(value.bonus) &&
    typeof value.terms === 'string' &&
    typeof value.status === 'string' &&
    POOL_STATUSES.has(value.status) &&
    isAmount(value.bonus_per_seat) &&
    typeof value.dust_sent === 'boolean'
  ) {
    return /** @type {PoolView} */ (value);
  }
  throw new PageDataError('the pools contract returned a malformed pool');
}

/**
 * A `list_pools` page. Throws a PageDataError unless it is a list of pools.
 *
 * @param {unknown} value
 * @returns {PoolView[]}
 */
export function parsePools(value) {
  return parseList(value, parsePool, 'the list_pools result');
}

/**
 * A `get_seats` page. Throws a PageDataError unless it is a list of `{buyer, seats, state}` rows.
 *
 * @param {unknown} value
 * @returns {SeatView[]}
 */
export function parseSeats(value) {
  return parseList(value, parseSeat, 'the get_seats result');
}

/**
 * @param {unknown} value
 * @returns {SeatView}
 */
function parseSeat(value) {
  if (
    isObject(value) &&
    typeof value.buyer === 'string' &&
    isCount(value.seats) &&
    typeof value.state === 'string' &&
    BUYER_STATES.has(value.state)
  ) {
    return /** @type {SeatView} */ (value);
  }
  throw new PageDataError('the pools contract returned a malformed seat row');
}

/**
 * The gateway's activity feed. Throws a PageDataError unless it is a list of activity records.
 *
 * @param {unknown} value
 * @returns {ActivityRecord[]}
 */
export function parseActivity(value) {
  return parseList(value, parseRecord, 'the activity feed');
}

/**
 * @param {unknown} value
 * @returns {ActivityRecord}
 */
function parseRecord(value) {
  if (
    isObject(value) &&
    typeof value.at === 'number' &&
    isCount(value.poolId) &&
    typeof value.kind === 'string' &&
    ACTIVITY_KINDS.has(value.kind) &&
    typeof value.account === 'string' &&
    isCount(value.seats) &&
    isAmount(value.amount) &&
    typeof value.txHash === 'string' &&
    typeof value.ok === 'boolean'
  ) {
    return /** @type {ActivityRecord} */ (value);
  }
  throw new PageDataError('the activity feed holds a malformed record');
}

/**
 * The gateway's `/config.json`. Throws a PageDataError unless every field is a string and the
 * explorer URL is an http(s) URL, which `txUrl` relies on.
 *
 * @param {unknown} value
 * @returns {PageConfig}
 */
export function parseConfig(value) {
  if (!isObject(value) || !CONFIG_KEYS.every((key) => typeof value[key] === 'string')) {
    throw new PageDataError('the gateway configuration (/config.json) is malformed');
  }
  if (!isHttpUrl(value.explorerTxUrl)) throw new PageDataError('the explorer URL in /config.json is not an http(s) URL');
  return /** @type {PageConfig} */ (value);
}

/**
 * The decimals and symbol of a token's `ft_metadata`. Throws a PageDataError unless `decimals` is
 * an integer from 0 to 255 (NEP-148's u8) and `symbol` a string.
 *
 * @param {unknown} value
 * @returns {TokenInfo}
 */
export function parseToken(value) {
  if (isObject(value) && typeof value.symbol === 'string' && isCount(value.decimals) && value.decimals <= 255) {
    return { decimals: value.decimals, symbol: value.symbol };
  }
  throw new PageDataError('the token metadata (ft_metadata) is malformed');
}

/**
 * The amount `ft_balance_of` returned. Throws a PageDataError unless it is a decimal string.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function parseBalance(value) {
  if (isAmount(value)) return value;
  throw new PageDataError('ft_balance_of did not return an amount');
}

/**
 * Every row of a paged view (`list_pools`, `get_seats`): reads pages of 100 rows from the first
 * until a page comes back shorter.
 *
 * @template T
 * @param {(from: number, limit: number) => Promise<T[]>} readPage
 * @returns {Promise<T[]>}
 */
export async function readAll(readPage) {
  /** @type {T[]} */
  const rows = [];
  for (;;) {
    const page = await readPage(rows.length, PAGE_SIZE);
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
  }
}

/**
 * The pool id the page URL asks for (`?pool=<id>`), written as the gateway writes pool ids:
 * decimal, no sign, no leading zero, a safe integer. Null when there is none or it is not one.
 *
 * @param {string} search the URL's query string, as `location.search` gives it
 * @returns {number | null}
 */
export function poolParam(search) {
  const text = new URLSearchParams(search).get('pool');
  if (text === null || !DECIMAL.test(text)) return null;
  const id = Number(text);
  return Number.isSafeInteger(id) ? id : null;
}

/**
 * The pool selector: the provider's pools, newest first, and the pool to read, which is the one the
 * page URL asks for or else the provider's newest. A requested pool is never offered unless the
 * provider opened it; it stays selected so that the page reads it and, if another seller opened it,
 * shows `foreignPoolNotice` in its place. `selected` is null when the provider has no pool and none
 * is asked for.
 *
 * @param {PoolView[]} pools every pool, as `list_pools` returns them
 * @param {string} provider
 * @param {number | null} requested
 * @returns {{ options: number[], selected: number | null }}
 */
export function poolChoices(pools, provider, requested) {
  const options = pools.filter((pool) => pool.seller === provider).map((pool) => pool.id);
  options.sort((a, b) => b - a);
  return { options, selected: requested ?? options[0] ?? null };
}

/**
 * What the page shows instead of a pool that another seller opened, or null for one of the
 * provider's pools, which the page renders. Anyone can open a pool on the pools contract, so a
 * `?pool=` link can name a pool whose terms the provider never wrote: the page names its seller and
 * shows none of its text. The seller is compared with the provider exactly.
 *
 * @param {PoolView} pool
 * @param {string} provider
 * @returns {string | null}
 */
export function foreignPoolNotice(pool, provider) {
  if (pool.seller === provider) return null;
  return `Pool ${pool.id} was opened by ${pool.seller}, not by this gateway's provider ${provider}: this page shows only the provider's pools.`;
}

/**
 * The time left until `deadlineMs`, rounded up to the second: `m:ss`, or `h:mm:ss` from an hour,
 * and `0:00` once the deadline has passed. For display only: the contract compares the deadline with
 * block time, never with this clock.
 *
 * @param {number} deadlineMs
 * @param {number} nowMs
 * @returns {string}
 */
export function countdown(deadlineMs, nowMs) {
  const total = Math.max(0, Math.ceil((deadlineMs - nowMs) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total / 60) % 60;
  const seconds = String(total % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
}
```

- [ ] **Step 6: Run the tests and the typecheck**

Run: `pnpm --filter @quorum-on-near/web exec vitest run test/totals.test.ts`

Expected: PASS, 127 tests:

```text
 Test Files  1 passed (1)
      Tests  127 passed (127)
```

Run: `pnpm --filter @quorum-on-near/web typecheck`

Expected: exit code 0. After pnpm's two lines naming the script (`> @quorum-on-near/web@0.1.0
typecheck …` and `> tsc -p tsconfig.json`), `tsc` prints nothing.

- [ ] **Step 7: Run the whole workspace**

```bash
pnpm typecheck
pnpm test
```

Expected: on `main` as this plan was written, `pnpm typecheck` runs in 3 of the 4 workspace
projects and prints `apps/web typecheck: Done`, `packages/protocol typecheck: Done` and
`apps/gateway typecheck: Done`. `pnpm test` exits 0 with 1,068 tests: `apps/web` 127 (1 file),
`packages/protocol` 340 (9 files), `apps/gateway` 601 (17 files). If `main` has moved on, the other
packages and their counts may differ; only `apps/web`'s must match.

- [ ] **Step 8: Commit**

```bash
git add apps/web/package.json apps/web/tsconfig.json apps/web/totals.js apps/web/test/totals.test.ts pnpm-lock.yaml
git commit -F - <<'EOF'
add the live page's totals and the web package

apps/web is the live page's package, with no runtime dependencies and type-checked JavaScript
(checkJs) so the page needs no build step. totals.js holds the page's logic as pure functions: the
JSON-RPC body of a view call and the decoding of its answer, structural checks of everything read
from the RPC, the gateway's /config.json and its activity feed, the ledger totals of a pool, the
buyer rows with their explorer links, the choice of pool among the provider's own, the notice for
another seller's pool, and the countdown to the deadline. Amounts are decimal strings in base units
at the edges and bigint inside, and malformed input throws a PageDataError.
EOF
```

- [ ] **Step 9: Record the page in the spec**

These edits touch section 8 only. The swarm and MCP server plan leaves section 8 as it is, so the
two plans' spec edits do not overlap. In `docs/specs/2026-11-09-quorum-on-near-design.md`, make
each replacement below, in order. A passage of prose may wrap differently in the file than here, so
match its words, not its line breaks. Where a replacement only adds text, its second block repeats
the first and adds to it.

1. Section 8, its first paragraph. Replace the sentence

   ```markdown
   The page never signs anything and needs no wallet.
   ```

   with

   ```markdown
   The page never signs anything and needs no wallet.
   It declares its icon inline, so a browser makes no `/favicon.ico` request, which the gateway would
   answer `404`. Every value it reads is written as text or as an attribute, never as HTML.
   ```

2. Section 8, the banner. Replace the item

   ```markdown
   - **The banner:** "The provider is simulated, and prices are scaled down 10,000 times. The money
     flow is real: USDC on NEAR testnet."
   ```

   with these two items

   ```markdown
   - **The banner:** "The provider is simulated, and prices are scaled down 10,000 times. The money
     flow is real: USDC on NEAR testnet." It is static, whatever the network; the footer names the
     network, the pools contract and the token from `/config.json`.
   - **Which pool:** the one that `?pool=<id>` names, written as the gateway writes pool ids (decimal,
     no sign, no leading zero, a safe integer; anything else is ignored), else the provider's newest
     pool. The selector lists only the provider's pools, newest first, and choosing one sets `?pool=`.
     A pool whose seller is not exactly the provider is never shown: its card, ledger and buyer table
     give way to the notice "Pool `<id>` was opened by `<seller>`, not by this gateway's provider
     `<provider>`: this page shows only the provider's pools.", with none of that pool's own text, since
     anyone can open a pool whose terms the provider never wrote. The check is made on the `get_pool`
     result of the same refresh, so a pool opened after `list_pools` was read is caught too. A pool that
     does not exist shows "There is no pool `<id>`.", and a provider with no pool "The provider has not
     opened a pool yet."
   ```

3. Section 8, the pool card. Replace the item

   ```markdown
   - **The pool card:** the terms, a bar filling seat by seat, the seat price, the bonus escrowed, a
     countdown and the status.
   ```

   with

   ```markdown
   - **The pool card:** the terms, a bar filling seat by seat, the seat price, the bonus escrowed, a
     countdown, the seller and the status. The countdown shows `m:ss` (`h:mm:ss` from an hour), rounded
     up to the second, while the pool is Open and "closed" otherwise; it is updated every second from
     the last read, and its tooltip gives the deadline in local time.
   ```

4. Section 8, the buyer table. Replace the item

   ```markdown
   - **The buyer table:** buyer, seats, amount paid, and state (committed; refunded with its bonus
     share; claimable; settled, which is derived from the pool's status and is not a buyer state in the
     contract), with a testnet explorer link for each transaction.
   ```

   with

   ```markdown
   - **The buyer table:** buyer, seats, amount paid, and state (committed; refunded with its bonus
     share; claimable; settled, which is derived from the pool's status and is not a buyer state in the
     contract), with a testnet explorer link for each transaction. A bonus share is shown only for a
     refunded buyer: a claimable one has been paid nothing yet, and its refund counts in *held now*. The
     links are those of the buyer's `commit` and `refund` records in the activity feed; a record that is
     not `ok` is still linked, labelled as failed, and a hash that is not a base58 transaction hash is
     never linked.
   ```

5. Section 8, the ledger totals. Replace the item

   ```markdown
   - **The ledger totals:** paid in, paid to the seller, refunded, bonus paid out, and held now.
     *Held now* is shown beside `ft_balance_of(pools contract)`, so the solvency invariant can be seen.
   ```

   with

   ```markdown
   - **The ledger totals:** paid in, paid to the seller, refunded, bonus paid out, and held now.
     *Held now* is shown beside `ft_balance_of(pools contract)`, so the solvency invariant can be seen.
     Held now is what the contract still owes for this pool (invariant 1), and the balance covers every
     pool together, so the balance is never below held now. The dust counts as paid to the seller as
     soon as the pool's `dust_sent` is set, while its transfer may still be in flight, and leaves held
     now at the same moment, so paid in plus the bonus always equals the four other totals together.
     The links of the pool's `settle` and dust records are shown beside *paid to the seller*.
   ```

6. Section 8, the amounts. Replace the item

   ```markdown
   - **Amounts** are shown with all 6 of the token's decimals (read from its `ft_metadata`), since the
     scaled prices are fractions of a cent.
   ```

   with

   ```markdown
   - **Amounts** are shown with all 6 of the token's decimals (read from its `ft_metadata`), since the
     scaled prices are fractions of a cent, followed by its symbol, as in `0.000180 USDC`.
   ```

7. Section 8, the data. Replace the item

   ```markdown
   - **Data:** every 2 seconds, it reads pool state from the contract's views (`get_pool`,
     `get_seats`) with RPC `call_function`, and transaction links from `/activity`. The RPC URL is set
     in the page's configuration. If the RPC refuses browser requests, the page uses the gateway's
     `/rpc` pass-through instead (section 6.1).
   ```

   with

   ```markdown
   - **Data:** every 2 seconds, it reads pool state from the contract's views (`get_pool`,
     `get_seats`) with RPC `call_function`, and transaction links from `/activity`. The RPC URL is set
     in the page's configuration. If the RPC refuses browser requests, the page uses the gateway's
     `/rpc` pass-through instead (section 6.1). It reads `/config.json` and the token's `ft_metadata`
     once, then on each refresh `list_pools` (for the selector and the newest pool), `get_pool`,
     `get_seats`, the token's `ft_balance_of` for the pools contract and the feed, every view at
     optimistic finality. Every value read is checked for its shape, and a malformed one fails that
     refresh with a status line naming what was wrong; the configuration's explorer link prefix must be
     an http or https URL. Each request times out after 10 seconds, so that a hung request cannot stop
     the refreshes, which never overlap. A failed refresh shows "Could not refresh" with its reason,
     keeps the last data on screen, and is tried again at the next 2-second tick.
   ```

- [ ] **Step 10: Check and commit the spec**

```bash
git diff --stat
git diff
```

Expected: `git diff --stat` lists only the spec, and `git diff` shows hunks in section 8 only.

```bash
git add docs/specs/2026-11-09-quorum-on-near-design.md
git commit -m "specify how the live page picks its pool, checks what it reads and refreshes"
```

---

### Task 2: The live page

`index.html` holds the page's markup: a header with the banner, a toolbar with the pool selector and
a status line, the pool card, the ledger and the buyer table, each hidden until it has data, and a
footer that names where the data comes from. Its icon is declared inline (`data:,`), so the browser
never asks the gateway for `/favicon.ico`, which the gateway answers `404`.

`app.js` only fetches and renders; every computation comes from `totals.js`. It reads
`/config.json` and the token's `ft_metadata` once. Then, every 2 seconds, it reads every page of
`list_pools` (for the selector and the newest pool), picks the pool with `poolChoices`, and reads
`get_pool`, every page of `get_seats`, the token's `ft_balance_of(poolsContract)` and
`/activity?pool=<id>` together. A pool another seller opened is checked on the `get_pool` result of
the same refresh, not on the list, and is replaced by `foreignPoolNotice`'s text. The answer of the
RPC is read as JSON whatever its HTTP status, so that an error the RPC or the pass-through explains
(such as `not_allowed`) is reported by name. Each request is aborted after 10 seconds, and a refresh
does not start while the previous one runs. A failed refresh shows "Could not refresh (<reason>).
Retrying every 2 seconds." and leaves the last data on screen. Choosing a pool sets `?pool=` with
`history.replaceState` and starts a refresh; if one is already running, it renders nothing and the
chosen pool is shown at the next tick. The selector is rebuilt only when the provider's pools
change, so a list the viewer has open stays open. The countdown is redrawn every second from the
last pool read. Explorer links open in a new tab with `rel="noopener noreferrer"`.

`style.css` keeps colours in custom properties on `:root`, overridden under
`@media (prefers-color-scheme: dark)`. The terms, the seller's account and the footer wrap anywhere;
the buyer table keeps each row on one line and scrolls sideways inside its card on a narrow screen.

**Files:**
- Create: `apps/web/index.html`, `apps/web/app.js`, `apps/web/style.css`
- Test: `apps/web/test/page.test.ts`

**Interfaces:**
- Consumes: from `./totals.js` (Task 1), `buyerRows`, `countdown`, `foreignPoolNotice`,
  `formatAmount`, `parseActivity`, `parseBalance`, `parseConfig`, `parsePool`, `parsePools`,
  `parseSeats`, `parseToken`, `payoutLinks`, `poolChoices`, `poolParam`, `poolTotals`, `readAll`,
  `viewRequest`, `viewResult`, and the types `ActivityRecord`, `BuyerRow`, `PageConfig`, `PoolStatus`,
  `PoolView`, `SeatView`, `TokenInfo`, `TxLink`. From the gateway: `GET /config.json` (a
  `PageConfig`), `GET /activity?pool=<id>` (`ActivityRecord[]`), and the RPC URL it names. From the
  chain: the pools contract's `list_pools({from, limit})`, `get_pool({pool_id})` and
  `get_seats({pool_id, from, limit})`, and the token's `ft_metadata({})` and
  `ft_balance_of({account_id})`.
- Produces:
  - `app.js`: no exports. A module script that reads `/config.json` and the token's `ft_metadata`
    once, then every 2 s (each request times out after 10 s) `list_pools`, `get_pool`, `get_seats`,
    the token's `ft_balance_of(poolsContract)` and `/activity?pool=<id>`, and redraws the countdown
    every 1 s. The element ids it looks up: `picker`, `pool-select`, `status`, `no-pool`, `pool`,
    `pool-title`, `pool-status`, `pool-terms`, `pool-bar`, `pool-seats`, `pool-price`, `pool-bonus`,
    `pool-countdown`, `pool-seller`, `ledger`, `paid-in`, `paid-to-seller`, `payout-links`,
    `refunded`, `bonus-paid-out`, `held-now`, `contract-balance`, `buyers`, `buyer-rows`,
    `no-buyers`, `source`.
  - `index.html`: `<link rel="icon" href="data:,">`, `<link rel="stylesheet" href="style.css">`,
    `<script type="module" src="app.js"></script>`; the banner "The provider is simulated, and prices
    are scaled down 10,000 times. The money flow is real: USDC on NEAR testnet."; the element ids
    above, and `ledger-title` and `buyers-title`.
  - `style.css`: colour tokens as custom properties on `:root`, overridden under
    `@media (prefers-color-scheme: dark)`.

- [ ] **Step 1: Write the failing test**

`apps/web/test/page.test.ts`:

```typescript
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const folder = new URL('../', import.meta.url);
const read = (name: string): string => readFileSync(new URL(name, folder), 'utf8');
const html = read('index.html');
const app = read('app.js');
const scripts = readdirSync(folder).filter((name) => name.endsWith('.js'));

describe('index.html', () => {
  it('shows the banner, word for word', () => {
    expect(html).toContain(
      'The provider is simulated, and prices are scaled down 10,000 times. The money flow is real: USDC on NEAR testnet.',
    );
  });

  it('loads app.js as a module and style.css as its stylesheet', () => {
    expect(html).toMatch(/<script type="module" src="app\.js"><\/script>/);
    expect(html).toMatch(/<link rel="stylesheet" href="style\.css">/);
  });

  it('declares its icon inline, so the browser does not ask the gateway for /favicon.ico, which it answers 404', () => {
    expect(html).toMatch(/<link rel="icon" href="data:,">/);
  });

  it('has every element app.js looks up', () => {
    const ids = [...app.matchAll(/element\('([^']+)'/g)].map((match) => match[1]);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(html, `#${id}`).toContain(`id="${id}"`);
  });
});

describe('the page scripts', () => {
  it('are app.js and totals.js', () => {
    expect(scripts.sort()).toEqual(['app.js', 'totals.js']);
  });

  it.each(scripts)('%s imports only files of this folder, so the page needs no build step', (name) => {
    const specifiers = [...read(name).matchAll(/^import\s[^'"]*['"]([^'"]+)['"]/gm)].map((match) => match[1] ?? '');
    for (const specifier of specifiers) {
      expect(specifier).toMatch(/^\.\/[\w-]+\.js$/);
      expect(existsSync(new URL(specifier, folder)), specifier).toBe(true);
    }
  });

  it.each(scripts)('%s never writes HTML from a string', (name) => {
    expect(read(name)).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm --filter @quorum-on-near/web exec vitest run test/page.test.ts`

Expected: FAIL, because `index.html` does not exist yet. vitest's summary reads as below, where
`<repo>` stands for the repository's folder (this run was on Windows; elsewhere the path is written
with `/`); the start time and the durations differ from run to run.

```text
 ❯ test/page.test.ts (0 test)

⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  test/page.test.ts [ test/page.test.ts ]
Error: ENOENT: no such file or directory, open '<repo>\apps\web\index.html'
 ❯ read test/page.test.ts:5:40
      3|
      4| const folder = new URL('../', import.meta.url);
      5| const read = (name: string): string => readFileSync(new URL(name, fold…
       |                                        ^
      6| const html = read('index.html');
      7| const app = read('app.js');
 ❯ test/page.test.ts:6:14

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯


 Test Files  1 failed (1)
      Tests  no tests
   Start at  07:38:25
   Duration  277ms (transform 21ms, setup 0ms, import 0ms, tests 0ms, environment 0ms)
```

On Node older than 22.22.2, pnpm first prints an `Unsupported engine` warning. On Windows, pnpm
10.23.0 then prints these extra lines, although vitest ran (on Linux, pnpm reports vitest's non-zero
exit instead):

```text
undefined
<repo>\apps\web:
 ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL  Command "vitest" not found
```

- [ ] **Step 3: Write the page**

`apps/web/index.html`:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>Quorum on NEAR: live pool</title>
  <link rel="icon" href="data:,">
  <link rel="stylesheet" href="style.css">
  <script type="module" src="app.js"></script>
</head>
<body>
  <header class="header">
    <h1>Quorum on NEAR</h1>
    <p class="lede">A threshold group purchase. Buyers commit seats before the deadline; if the target is reached, the seller is paid, otherwise every seat is refunded with a share of the seller's bonus.</p>
    <p class="banner">The provider is simulated, and prices are scaled down 10,000 times. The money flow is real: USDC on NEAR testnet.</p>
  </header>

  <main class="main">
    <div class="toolbar">
      <div id="picker" class="picker" hidden>
        <label for="pool-select">Pool</label>
        <select id="pool-select"></select>
      </div>
      <p id="status" class="status" role="status" aria-live="polite">Loading…</p>
    </div>

    <p id="no-pool" class="empty" hidden></p>

    <section id="pool" class="card" aria-labelledby="pool-title" hidden>
      <div class="card-head">
        <h2 id="pool-title">Pool</h2>
        <span id="pool-status" class="badge"></span>
      </div>
      <p class="terms-label">Terms set by the seller</p>
      <p id="pool-terms" class="terms"></p>
      <progress id="pool-bar" class="bar" max="1" value="0" aria-labelledby="pool-seats"></progress>
      <p id="pool-seats" class="seats"></p>
      <dl class="facts">
        <div><dt>Seat price</dt><dd id="pool-price" class="amount"></dd></div>
        <div><dt>Bonus escrowed</dt><dd id="pool-bonus" class="amount"></dd></div>
        <div><dt>Time left</dt><dd id="pool-countdown" class="amount"></dd></div>
        <div><dt>Seller</dt><dd id="pool-seller" class="account"></dd></div>
      </dl>
    </section>

    <section id="ledger" class="card" aria-labelledby="ledger-title" hidden>
      <h2 id="ledger-title">Ledger</h2>
      <dl class="totals">
        <div><dt>Paid in</dt><dd id="paid-in" class="amount"></dd></div>
        <div><dt>Paid to the seller</dt><dd id="paid-to-seller" class="amount"></dd><dd id="payout-links" class="links"></dd></div>
        <div><dt>Refunded</dt><dd id="refunded" class="amount"></dd></div>
        <div><dt>Bonus paid out</dt><dd id="bonus-paid-out" class="amount"></dd></div>
      </dl>
      <dl class="totals held">
        <div><dt>Held now for this pool</dt><dd id="held-now" class="amount"></dd></div>
        <div><dt>Contract balance, all pools</dt><dd id="contract-balance" class="amount"></dd></div>
      </dl>
      <p class="note">The contract's token balance covers what it still holds for every pool together, so it is never below the amount held for this one.</p>
    </section>

    <section id="buyers" class="card" aria-labelledby="buyers-title" hidden>
      <h2 id="buyers-title">Buyers</h2>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">Buyer</th>
              <th scope="col" class="num">Seats</th>
              <th scope="col" class="num">Paid</th>
              <th scope="col">State</th>
              <th scope="col">Transactions</th>
            </tr>
          </thead>
          <tbody id="buyer-rows"></tbody>
        </table>
      </div>
      <p id="no-buyers" class="empty" hidden>No buyer has committed yet.</p>
    </section>
  </main>

  <footer class="footer">
    <p id="source"></p>
  </footer>
</body>
</html>
```

`apps/web/app.js`:

```javascript
/**
 * The live page. It reads the gateway's `/config.json` and the token's `ft_metadata` once, then
 * every 2 seconds the pools contract's views (through the RPC the configuration names) and the
 * gateway's activity feed, and renders one of the provider's pools. It never signs anything.
 *
 * Every value read from the RPC or the gateway is written with `textContent` or as an attribute,
 * never as HTML. The computing is in `totals.js`; this module only fetches and renders.
 */
import {
  buyerRows,
  countdown,
  foreignPoolNotice,
  formatAmount,
  parseActivity,
  parseBalance,
  parseConfig,
  parsePool,
  parsePools,
  parseSeats,
  parseToken,
  payoutLinks,
  poolChoices,
  poolParam,
  poolTotals,
  readAll,
  viewRequest,
  viewResult,
} from './totals.js';

/** @import { ActivityRecord, BuyerRow, PageConfig, PoolStatus, PoolView, SeatView, TokenInfo, TxLink } from './totals.js' */

const POLL_INTERVAL_MS = 2_000;
const COUNTDOWN_INTERVAL_MS = 1_000;
/** How long one request may take. A poll waits for its requests, and the next poll waits for it. */
const REQUEST_TIMEOUT_MS = 10_000;

/** @type {Record<PoolStatus, string>} */
const STATUS_TEXT = {
  open: 'Open',
  filled: 'Filled: payout pending',
  settled: 'Settled: the seller is paid',
  expired: 'Expired: refunds in progress',
  refunded: 'Refunded',
};

/**
 * The element with this id, which must be of `type`.
 *
 * @template {HTMLElement} T
 * @param {string} id
 * @param {{ new (): T }} type
 * @returns {T}
 */
function element(id, type) {
  const found = document.getElementById(id);
  if (!(found instanceof type)) throw new Error(`the page has no suitable #${id}`);
  return found;
}

const ui = {
  picker: element('picker', HTMLElement),
  select: element('pool-select', HTMLSelectElement),
  status: element('status', HTMLElement),
  noPool: element('no-pool', HTMLElement),
  pool: element('pool', HTMLElement),
  poolTitle: element('pool-title', HTMLElement),
  poolStatus: element('pool-status', HTMLElement),
  poolTerms: element('pool-terms', HTMLElement),
  poolBar: element('pool-bar', HTMLProgressElement),
  poolSeats: element('pool-seats', HTMLElement),
  poolPrice: element('pool-price', HTMLElement),
  poolBonus: element('pool-bonus', HTMLElement),
  poolCountdown: element('pool-countdown', HTMLElement),
  poolSeller: element('pool-seller', HTMLElement),
  ledger: element('ledger', HTMLElement),
  paidIn: element('paid-in', HTMLElement),
  paidToSeller: element('paid-to-seller', HTMLElement),
  payoutLinks: element('payout-links', HTMLElement),
  refunded: element('refunded', HTMLElement),
  bonusPaidOut: element('bonus-paid-out', HTMLElement),
  heldNow: element('held-now', HTMLElement),
  contractBalance: element('contract-balance', HTMLElement),
  buyers: element('buyers', HTMLElement),
  buyerRows: element('buyer-rows', HTMLElement),
  noBuyers: element('no-buyers', HTMLElement),
  source: element('source', HTMLElement),
};

/** @type {{ config: PageConfig, token: TokenInfo } | null} */
let setup = null;
/**
 * The pool on screen, which the countdown reads between polls.
 * @type {PoolView | null}
 */
let shown = null;
let polling = false;
let rpcId = 0;

/**
 * GETs a path of the gateway and returns its JSON. Throws unless the answer is a 2xx.
 *
 * @param {string} path
 * @returns {Promise<unknown>}
 */
async function getJson(path) {
  const response = await fetch(path, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`${path} answered ${response.status}`);
  return response.json();
}

/**
 * Calls a view through the configured RPC and returns what it returned. The answer's JSON is read
 * whatever its HTTP status, so that an error the RPC explains is reported by name.
 *
 * @param {PageConfig} config
 * @param {string} accountId
 * @param {string} methodName
 * @param {Record<string, unknown>} args
 * @returns {Promise<unknown>}
 */
async function view(config, accountId, methodName, args) {
  rpcId += 1;
  const response = await fetch(config.rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(viewRequest(rpcId, accountId, methodName, args)),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  /** @type {unknown} */
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error(`the RPC answered ${response.status} with no JSON`);
  }
  return viewResult(body);
}

/** Reads what the page needs once: the gateway's configuration and the token's decimals. */
async function loadSetup() {
  const config = parseConfig(await getJson('/config.json'));
  const token = parseToken(await view(config, config.token, 'ft_metadata', {}));
  ui.source.textContent = `Read from the pools contract ${config.poolsContract} on ${config.network}; token ${config.token}.`;
  return { config, token };
}

/**
 * Reads the chain and the feed, then renders the pool the URL asks for, or the provider's newest.
 * A pool another seller opened is not rendered: the page shows a notice naming its seller instead.
 * Returns false, rendering nothing, when the choice of pool changed while it read.
 *
 * @returns {Promise<boolean>}
 */
async function poll() {
  const search = location.search;
  setup ??= await loadSetup();
  const { config, token } = setup;
  const pools = await readAll(async (from, limit) => parsePools(await view(config, config.poolsContract, 'list_pools', { from, limit })));
  const { options, selected } = poolChoices(pools, config.provider, poolParam(search));
  if (selected === null) {
    renderSelector(options, selected);
    renderNoPool('The provider has not opened a pool yet.');
    return true;
  }
  const [pool, seats, balance, activity] = await Promise.all([
    view(config, config.poolsContract, 'get_pool', { pool_id: selected }).then((value) => (value === null ? null : parsePool(value))),
    readAll(async (from, limit) => parseSeats(await view(config, config.poolsContract, 'get_seats', { pool_id: selected, from, limit }))),
    view(config, config.token, 'ft_balance_of', { account_id: config.poolsContract }).then(parseBalance),
    getJson(`/activity?pool=${selected}`).then(parseActivity),
  ]);
  if (location.search !== search) return false;
  renderSelector(options, selected);
  if (pool === null) {
    renderNoPool(`There is no pool ${selected}.`);
    return true;
  }
  // Checked on the pool just read, not on the list, so that a pool opened after list_pools is
  // caught too.
  const notice = foreignPoolNotice(pool, config.provider);
  if (notice !== null) {
    renderNoPool(notice);
    return true;
  }
  renderPool(pool, token);
  renderLedger(pool, seats, activity, balance, config, token);
  renderBuyers(pool, seats, activity, config, token);
  return true;
}

/**
 * @param {number[]} options
 * @param {number | null} selected
 */
function renderSelector(options, selected) {
  const key = options.join(',');
  // Rebuilt only when the pools change, so that a list the viewer has open stays open.
  if (ui.select.dataset.options !== key) {
    ui.select.replaceChildren(...options.map((id) => new Option(`Pool ${id}`, String(id))));
    ui.select.dataset.options = key;
  }
  ui.picker.hidden = options.length === 0;
  ui.select.value = selected === null ? '' : String(selected);
}

/** @param {string} message */
function renderNoPool(message) {
  shown = null;
  ui.noPool.textContent = message;
  ui.noPool.hidden = false;
  ui.pool.hidden = true;
  ui.ledger.hidden = true;
  ui.buyers.hidden = true;
}

/**
 * @param {PoolView} pool
 * @param {TokenInfo} token
 */
function renderPool(pool, token) {
  shown = pool;
  ui.noPool.hidden = true;
  ui.poolTitle.textContent = `Pool ${pool.id}`;
  ui.poolStatus.textContent = STATUS_TEXT[pool.status];
  ui.poolStatus.dataset.status = pool.status;
  ui.poolTerms.textContent = pool.terms;
  ui.poolBar.max = pool.target;
  ui.poolBar.value = pool.taken;
  ui.poolSeats.textContent = `${pool.taken} of ${pool.target} seats taken`;
  ui.poolPrice.textContent = formatAmount(pool.seat_price, token);
  ui.poolBonus.textContent = formatAmount(pool.bonus, token);
  ui.poolCountdown.title = `Deadline ${new Date(pool.deadline_ms).toLocaleString()}`;
  ui.poolSeller.textContent = pool.seller;
  renderCountdown();
  ui.pool.hidden = false;
}

function renderCountdown() {
  if (shown === null) return;
  ui.poolCountdown.textContent = shown.status === 'open' ? countdown(shown.deadline_ms, Date.now()) : 'closed';
}

/**
 * @param {PoolView} pool
 * @param {SeatView[]} seats
 * @param {ActivityRecord[]} activity
 * @param {string} balance
 * @param {PageConfig} config
 * @param {TokenInfo} token
 */
function renderLedger(pool, seats, activity, balance, config, token) {
  const totals = poolTotals(pool, seats);
  ui.paidIn.textContent = formatAmount(totals.paidIn, token);
  ui.paidToSeller.textContent = formatAmount(totals.paidToSeller, token);
  ui.payoutLinks.replaceChildren(...linkList(payoutLinks(pool, activity, config.explorerTxUrl)));
  ui.refunded.textContent = formatAmount(totals.refunded, token);
  ui.bonusPaidOut.textContent = formatAmount(totals.bonusPaidOut, token);
  ui.heldNow.textContent = formatAmount(totals.heldNow, token);
  ui.contractBalance.textContent = formatAmount(balance, token);
  ui.ledger.hidden = false;
}

/**
 * @param {PoolView} pool
 * @param {SeatView[]} seats
 * @param {ActivityRecord[]} activity
 * @param {PageConfig} config
 * @param {TokenInfo} token
 */
function renderBuyers(pool, seats, activity, config, token) {
  const rows = buyerRows(pool, seats, activity, config.explorerTxUrl);
  ui.buyerRows.replaceChildren(...rows.map((row) => buyerRow(row, token)));
  ui.noBuyers.hidden = rows.length > 0;
  ui.buyers.hidden = false;
}

/**
 * @param {BuyerRow} row
 * @param {TokenInfo} token
 * @returns {HTMLTableRowElement}
 */
function buyerRow(row, token) {
  const tr = document.createElement('tr');
  const state = row.bonusShare === null ? row.state : `${row.state}, bonus ${formatAmount(row.bonusShare, token)}`;
  tr.append(
    cell(row.buyer, 'account'),
    cell(String(row.seats), 'num'),
    cell(formatAmount(row.paid, token), 'num amount'),
    cell(state, `state state-${row.state}`),
  );
  const links = document.createElement('td');
  links.className = 'links';
  links.append(...linkList(row.links));
  tr.append(links);
  return tr;
}

/**
 * @param {string} text
 * @param {string} className
 * @returns {HTMLTableCellElement}
 */
function cell(text, className) {
  const td = document.createElement('td');
  td.className = className;
  td.textContent = text;
  return td;
}

/**
 * Explorer links, each opening in a new tab.
 *
 * @param {TxLink[]} links
 * @returns {HTMLAnchorElement[]}
 */
function linkList(links) {
  return links.map(({ label, href }) => {
    const a = document.createElement('a');
    a.href = href;
    a.textContent = label;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    return a;
  });
}

/**
 * @param {string} text
 * @param {boolean} failed
 */
function showStatus(text, failed) {
  ui.status.textContent = text;
  ui.status.classList.toggle('failed', failed);
}

/** Runs one poll, unless the previous one is still running, and reports how it went. */
async function tick() {
  if (polling) return;
  polling = true;
  try {
    if (await poll()) showStatus(`Updated at ${new Date().toLocaleTimeString()}`, false);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    showStatus(`Could not refresh (${reason}). Retrying every ${POLL_INTERVAL_MS / 1000} seconds.`, true);
  } finally {
    polling = false;
  }
}

ui.select.addEventListener('change', () => {
  const url = new URL(location.href);
  url.searchParams.set('pool', ui.select.value);
  history.replaceState(null, '', url);
  showStatus(`Loading pool ${ui.select.value}…`, false);
  void tick();
});

void tick();
setInterval(tick, POLL_INTERVAL_MS);
setInterval(renderCountdown, COUNTDOWN_INTERVAL_MS);
```

`apps/web/style.css`:

```css
:root {
  color-scheme: light dark;
  --bg: #f6f7f9;
  --surface: #ffffff;
  --text: #1b1f24;
  --muted: #5b6470;
  --border: #dde1e6;
  --accent: #1f6feb;
  --banner-bg: #fff4d6;
  --banner-text: #5a4300;
  --ok: #1a7f37;
  --warn: #9a6700;
  --bad: #cf222e;
  --track: #e6e9ed;
  --radius: 10px;
  --font: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f1216;
    --surface: #171b21;
    --text: #e6e9ed;
    --muted: #9aa4af;
    --border: #2b323b;
    --accent: #58a6ff;
    --banner-bg: #3a2f0b;
    --banner-text: #f4dc8b;
    --ok: #3fb950;
    --warn: #d29922;
    --bad: #f85149;
    --track: #262c34;
  }
}

*,
*::before,
*::after {
  box-sizing: border-box;
}

[hidden] {
  display: none !important;
}

body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 16px/1.5 var(--font);
}

h1,
h2 {
  line-height: 1.2;
  margin: 0;
}

h1 {
  font-size: 1.6rem;
}

h2 {
  font-size: 1.15rem;
}

a {
  color: var(--accent);
}

.header,
.main,
.footer {
  max-width: 60rem;
  margin-inline: auto;
  padding-inline: 1rem;
}

.header {
  padding-block: 1.5rem 1rem;
}

.lede {
  color: var(--muted);
  margin: 0.4rem 0 0;
}

.banner {
  margin: 1rem 0 0;
  padding: 0.6rem 1rem;
  background: var(--banner-bg);
  color: var(--banner-text);
  border-radius: var(--radius);
  font-weight: 600;
}

.main {
  display: grid;
  gap: 1rem;
  padding-bottom: 1.5rem;
}

.toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem 1rem;
}

.picker {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-weight: 600;
}

select {
  font: inherit;
  padding: 0.3rem 0.5rem;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  color: var(--text);
}

.status {
  margin: 0;
  color: var(--muted);
  font-size: 0.9rem;
}

.status.failed {
  color: var(--bad);
}

.empty {
  margin: 0;
  color: var(--muted);
}

.card {
  display: grid;
  gap: 0.75rem;
  padding: 1rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  min-width: 0;
}

.card-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}

.badge {
  padding: 0.15rem 0.6rem;
  border-radius: 999px;
  border: 1px solid currentColor;
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--accent);
}

.badge[data-status="filled"],
.badge[data-status="settled"] {
  color: var(--ok);
}

.badge[data-status="expired"],
.badge[data-status="refunded"] {
  color: var(--warn);
}

.terms-label {
  margin: 0;
  color: var(--muted);
  font-size: 0.85rem;
}

.terms {
  margin: 0;
  padding-left: 0.75rem;
  border-left: 3px solid var(--border);
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

.bar {
  appearance: none;
  width: 100%;
  height: 0.9rem;
  border: none;
  border-radius: 999px;
  overflow: hidden;
  background: var(--track);
  accent-color: var(--accent);
}

.bar::-webkit-progress-bar {
  background: var(--track);
}

.bar::-webkit-progress-value {
  background: var(--accent);
}

.bar::-moz-progress-bar {
  background: var(--accent);
}

.seats {
  margin: -0.25rem 0 0;
  color: var(--muted);
  font-size: 0.9rem;
}

dl {
  margin: 0;
}

dt {
  color: var(--muted);
  font-size: 0.85rem;
}

dd {
  margin: 0;
}

.facts,
.totals {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
  gap: 0.75rem 1rem;
}

.held {
  padding: 0.75rem;
  border-radius: 8px;
  background: var(--bg);
}

.note {
  margin: 0;
  color: var(--muted);
  font-size: 0.85rem;
}

.amount,
.num {
  font-variant-numeric: tabular-nums;
}

.account {
  overflow-wrap: anywhere;
}

.links {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem 0.6rem;
  font-size: 0.9rem;
}

.table-wrap {
  overflow-x: auto;
}

table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.95rem;
}

/* Each row stays on one line; on a narrow screen the table scrolls sideways inside its card. */
th,
td {
  padding: 0.45rem 0.5rem;
  border-bottom: 1px solid var(--border);
  text-align: left;
  white-space: nowrap;
}

th {
  color: var(--muted);
  font-size: 0.85rem;
  font-weight: 600;
}

th.num,
td.num {
  text-align: right;
}

td.links {
  display: table-cell;
}

td.links a + a {
  margin-left: 0.6rem;
}

.state-settled {
  color: var(--ok);
}

.state-refunded {
  color: var(--warn);
}

.state-claimable {
  color: var(--bad);
}

.footer {
  padding-block: 0 2rem;
  color: var(--muted);
  font-size: 0.85rem;
  overflow-wrap: anywhere;
}

.footer p {
  margin: 0;
}
```

- [ ] **Step 4: Run the tests and the typecheck**

Run: `pnpm --filter @quorum-on-near/web exec vitest run test/page.test.ts`

Expected: PASS, 9 tests:

```text
 Test Files  1 passed (1)
      Tests  9 passed (9)
```

Run: `pnpm --filter @quorum-on-near/web exec vitest run test/totals.test.ts test/page.test.ts`

Expected: PASS, 136 tests (`test/totals.test.ts` 127, `test/page.test.ts` 9).

Run: `pnpm --filter @quorum-on-near/web typecheck`

Expected: exit code 0; `tsc` prints nothing after pnpm's two lines naming the script.

- [ ] **Step 5: Run the whole workspace**

```bash
pnpm typecheck
pnpm test
```

Expected: `pnpm typecheck` prints `Done` for `apps/web`, `packages/protocol` and `apps/gateway`.
`pnpm test` exits 0 with 1,077 tests: `apps/web` 136 (2 files), `packages/protocol` 340 (9 files),
`apps/gateway` 601 (17 files). As in Task 1, only `apps/web`'s count must match if `main` has moved
on.

- [ ] **Step 6: Commit**

```bash
git add apps/web/index.html apps/web/app.js apps/web/style.css apps/web/test/page.test.ts
git commit -F - <<'EOF'
add the live page of a pool

index.html, app.js and style.css are a static page with no build step, which the gateway serves at
/. app.js reads the gateway's /config.json and the token's ft_metadata once, then every 2 seconds
the pools contract's views through the RPC the configuration names and the gateway's activity
feed, and renders one of the provider's pools: its terms, its seats filling towards the target and
the time left, the ledger totals beside the contract's token balance across all pools, and every
buyer's state with links to its transactions. A pool another seller opened is replaced by a notice
naming that seller. Every value read from the chain or the feed is set as text or as an attribute,
never as HTML, and the page imports only its own two scripts. A banner says that the provider is
simulated and the prices are scaled down.
EOF
```

---

### Task 3: Check the page against a running gateway

No unit test can show the page in a browser over a real chain. This task does, by hand, then records
the page in `CLAUDE.md`.

**Files:**
- Modify: `CLAUDE.md` (the Architecture section's first sentence, the Layout table, the Toolchain
  section)

**Interfaces:**
- Consumes: the gateway (`pnpm --filter @quorum-on-near/gateway start`, configured from
  `apps/gateway/.env` as `apps/gateway/.env.example` describes), its `QUORUM_WEB_DIR` (by default
  `../web`, which resolves against `apps/gateway`, the folder `start` runs in) and
  `QUORUM_RPC_PASSTHROUGH`; pools of its provider, for example made by the swarm of the swarm and
  MCP server plan; the page of Task 2.
- Produces: no code; the `CLAUDE.md` lines of Step 6.

- [ ] **Step 1: Choose where the pools come from**

The page shows the pools whose seller is the gateway's provider (`QUORUM_PROVIDER_ACCOUNT`, by
default `provider.<parent>`). Any of the routes below gives it pools to show. The first two need the
swarm and MCP server plan ([swarm-mcp.md](swarm-mcp.md)) merged into `main`, and both plans' code in
one checkout. For those two, rebase this branch onto `main`:

```bash
git fetch origin
git rebase origin/main
```

The rebase stops on `pnpm-lock.yaml` in this branch's first commit, because both plans add an
importer after `apps/gateway`. Keep `main`'s lockfile, let `pnpm install` add this plan's
`apps/web` importer back to it, go on, and install the combined workspace. During a rebase,
`--ours` is the branch being rebased onto, here `origin/main`:

```bash
git checkout --ours pnpm-lock.yaml
pnpm install
git add pnpm-lock.yaml
GIT_EDITOR=true git rebase --continue
pnpm install
```

Expected: `git rebase --continue` applies this branch's other commits without a stop and prints
`Successfully rebased and updated refs/heads/feat/live-page.`

- **A local sandbox** (Linux, macOS on Apple silicon or WSL2, with the contracts' wasm files named
  by `QUORUM_POOLS_WASM` and `QUORUM_MOCK_USD_WASM`, as that plan says). Its sandbox harness,
  `startSwarmWorld({ page: true })` in `apps/swarm/test/sandbox/harness.ts`, starts a sandbox, the
  swarm's accounts and the real gateway, serving this folder with the pass-through on. `page: true`
  needs `apps/web` present, which it is once this plan's Tasks 1 and 2 are done and the swarm plan
  is in the checkout. The launcher below starts that world, prints the page's URL and the sandbox's
  RPC URL, runs `swarm demo fills` (a pool that fills and settles) and then, once the `fills` pool
  has settled, `swarm demo fails` (a pool that expires and is refunded), and keeps the sandbox and
  the gateway running until Ctrl+C. The token there is the mock token, so the amounts carry its
  symbol; the banner stays as written (section 8).
- **Testnet**: the swarm's `open` and `run` commands, with the gateway configured for the same
  accounts (`pnpm --filter @quorum-on-near/swarm swarm env gateway` writes `apps/gateway/.env` for
  them, never over an existing file): `pnpm --filter @quorum-on-near/swarm swarm open fills`, then
  `pnpm --filter @quorum-on-near/swarm swarm run <pool-id> fills`, then, once the `fills` pool has
  settled, the same with `fails`, as that plan describes.
- **Any pools the configured provider has opened** on the pools contract, on testnet or in a sandbox:
  a pool is opened by an `ft_transfer_call` from the provider to the pools contract with the `open`
  message of section 5.3.

For the sandbox route, save this launcher as `apps/swarm/page-world.ts`. It is not committed: delete
it after the check.

```ts
// apps/swarm/page-world.ts: not committed; delete it after the check
import { runSwarmCli, startSwarmWorld } from './test/sandbox/harness.ts';

const world = await startSwarmWorld({ page: true });
console.log(`page ${world.gateway.url}, RPC ${world.swarmEnv.QUORUM_RPC_URL}`);
process.on('SIGINT', () => void world.stop().then(() => process.exit(0)));
for (const scenario of ['fills', 'fails']) {
  const { code, stdout, stderr } = await runSwarmCli(world, ['demo', scenario]);
  console.log(`swarm demo ${scenario}: exit ${code}\n${stdout}${stderr}`);
}
console.log('Both pools have ended. Press Ctrl+C to stop the sandbox and the gateway.');
```

Run it from the repository's root, with `QUORUM_POOLS_WASM` and `QUORUM_MOCK_USD_WASM` exported,
in a shell that stays open while you check the page:

```bash
node apps/swarm/page-world.ts
```

Expected: after about 30 seconds (the sandbox, the mock token, two setups and the gateway), the
line `page http://127.0.0.1:<port>, RPC http://127.0.0.1:<port>`; open the page then to watch the
pools fill. About 15 seconds later comes `swarm demo fills: exit 0`, then what that command
printed, which ends `pool 0: <n> checks passed`; about 35 seconds after that (the harness gives
each pool a 30-second deadline and spreads the buyers over 5 seconds), `swarm demo fails: exit 0`,
whose output ends `pool 1: <n> checks passed`; then `Both pools have ended. Press Ctrl+C to stop
the sandbox and the gateway.` Both pools stay on the chain for Steps 2 to 5. Ctrl+C stops the
gateway and the sandbox within about 10 seconds (if neard ignores the signal, the harness kills it
and prints `the sandbox did not stop on SIGTERM: neard was killed`), removes the world's temporary
folder and exits with code 0; a second Ctrl+C does not cut the stop short. Afterwards
`pgrep -f 'near-sandbox|gateway/src/main.ts'` prints nothing. Then delete the launcher
(`rm apps/swarm/page-world.ts`).

- [ ] **Step 2: Serve the page**

With the launcher of Step 1, the gateway already serves the page with the pass-through on; go on to
the `curl` below. Otherwise, in `apps/gateway/.env`, leave `QUORUM_WEB_DIR` at its default, set
`QUORUM_RPC_PASSTHROUGH=true`, and start the gateway:

```bash
pnpm --filter @quorum-on-near/gateway start
```

Then, in another shell, set `GATEWAY` to the gateway's URL and read its configuration. The port is
`QUORUM_GATEWAY_PORT`, 8402 by default. With the launcher, `GATEWAY` is the URL it prints, with
`127.0.0.1` written `localhost` when the browser runs on Windows and the launcher in WSL2.

```bash
GATEWAY=http://localhost:8402
curl -s "$GATEWAY/config.json"
```

Expected: a JSON object whose `rpcUrl` is `/rpc`, and whose `poolsContract`, `token` and `provider`
are the gateway's configured accounts: with the launcher, `pools.sandbox`, `musd.sandbox` and
`provider.sandbox`, on the network `near:sandbox`. Open the `GATEWAY` URL, such as
`http://localhost:8402/`, in a browser. With `QUORUM_RPC_PASSTHROUGH=false`, `rpcUrl` is
`QUORUM_RPC_URL` itself, and the page reads the RPC directly, which works only if that RPC accepts
browser requests.

On WSL2, a browser on Windows may reach a server in WSL only at `http://localhost:<port>`, not at
`http://127.0.0.1:<port>`; use `localhost`.

- [ ] **Step 3: Read the chain independently**

Read what the page shows straight from the RPC the gateway uses, not through `/rpc`: its
`QUORUM_RPC_URL`, or with the launcher the RPC URL it prints (with `127.0.0.1` written `localhost`
from a shell on Windows). In a bash shell, with `GATEWAY` set as in Step 2, set `RPC` to that URL,
and `POOLS` and `TOKEN` to the `poolsContract` and `token` of `/config.json`:

```bash
RPC=https://test.rpc.fastnear.com # QUORUM_RPC_URL, or the RPC URL the launcher prints
POOLS=$(curl -s "$GATEWAY/config.json" | node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).poolsContract')
TOKEN=$(curl -s "$GATEWAY/config.json" | node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).token')
view() { # view <account> <method> <args-json>: a view call at optimistic finality, printed as JSON
  node -e '
    const [rpc, account, method, args] = process.argv.slice(1);
    const params = { request_type: "call_function", account_id: account, method_name: method,
      args_base64: Buffer.from(args).toString("base64"), finality: "optimistic" };
    fetch(rpc, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params }) })
      .then((r) => r.json())
      .then((a) => console.log(a.result?.result ? Buffer.from(a.result.result).toString() : JSON.stringify(a)));
  ' "$RPC" "$@"
}
view "$POOLS" get_pool '{"pool_id":3}'
view "$POOLS" get_seats '{"pool_id":3,"from":0,"limit":100}'
view "$TOKEN" ft_balance_of "{\"account_id\":\"$POOLS\"}"
view "$TOKEN" ft_metadata '{}'
curl -s "$GATEWAY/activity?pool=3"
```

Replace `3` with the id of the pool on screen.

- [ ] **Step 4: Compare the page with the chain at each stable point**

The page reads at optimistic finality every 2 seconds, so compare it when no transaction of the
pool is in flight: while it fills, once it has settled, and once it has been refunded (and, if you
catch them, filled before the payout and expired with refunds in progress). Amounts on the page are
the chain's base units with all of `ft_metadata`'s `decimals` and its `symbol`.

| On the page | From the chain |
|---|---|
| The title `Pool <id>` and the status badge | `id`; `status`: `open` is "Open", `filled` "Filled: payout pending", `settled` "Settled: the seller is paid", `expired` "Expired: refunds in progress", `refunded` "Refunded" |
| The terms | `terms`, character for character |
| The bar and `<taken> of <target> seats taken` | `taken` and `target` |
| Seat price, bonus escrowed | `seat_price`, `bonus` |
| Time left | while `open`, the time to `deadline_ms`, as `m:ss` or `h:mm:ss`; "closed" otherwise. Its tooltip gives the deadline in local time |
| Seller | `seller`, which is exactly the `provider` of `/config.json` |
| Paid in | `taken × seat_price` |
| Paid to the seller | `taken × seat_price + bonus` once `settled`; the dust, `bonus − bonus_per_seat × taken`, once `dust_sent` is true; 0 otherwise. Beside it, links to the pool's `settle` and `dust` records of the feed |
| Refunded, bonus paid out | over the `get_seats` rows in state `refunded`, the sum of `seats × seat_price`, and of `seats × bonus_per_seat` |
| Held now | what invariant 1 of section 5.5 counts for this pool |
| Contract balance, all pools | `ft_balance_of(pools contract)`, never below held now |
| The buyer table | one row per `get_seats` row, in that order: the buyer, its seats, `seats × seat_price`, and its state (`settled` for every buyer of a settled pool; `refunded, bonus <seats × bonus_per_seat>` for a refunded one); links to the buyer's `commit` and `refund` records of the feed for this pool, labelled `(failed)` where `ok` is false, each opening the explorer at its transaction |
| The footer | the network, the pools contract and the token of `/config.json` |

Also check that paid in plus the bonus equals paid to the seller, refunded, bonus paid out and held
now together.

- [ ] **Step 5: Try what can go wrong**

Markup in a pool's terms and a pool another seller opened are not tried here: unit tests cover
both, `page.test.ts`'s "app.js never writes HTML from a string" and "totals.js never writes HTML
from a string", and `totals.test.ts`'s `foreignPoolNotice` tests ("names the seller and the
provider of a pool another seller opened, and none of its terms", "compares the seller with the
provider exactly, so that a look-alike account is another seller") and its `poolChoices` test
"never offers a requested pool of another seller, but keeps it selected so that the page can say
whose it is".

- **Pool ids in the URL.** `/?pool=<an id with no pool>` shows "There is no pool `<id>`.";
  `/?pool=07`, `/?pool=-1` and `/?pool=x` show the provider's newest pool. Choosing a pool in the
  selector puts its id in the URL and shows it.
- **Failed refreshes.** Cut the page off for a few seconds: set the browser's network panel to
  Offline, or stop the gateway. The status line turns to "Could not refresh (<reason>). Retrying
  every 2 seconds.", in the failure colour, and the last data stays on screen. Go back online, or
  start the gateway again: within a refresh or two the status line reads "Updated at <time>" again.
- **A narrow screen.** At 375 px wide (the browser's device toolbar), the page has no horizontal
  scroll; the buyer table scrolls sideways inside its card.
- **The pass-through.** In the browser's network panel, every `POST /rpc` is answered `200` (none
  `403 not_allowed`), and there is no request for `/favicon.ico`.

- [ ] **Step 6: Record the page in `CLAUDE.md`**

The swarm and MCP server plan ([swarm-mcp.md](swarm-mcp.md)) edits the same Architecture sentence
and appends its own rows to the same Layout table. The edits below are written against `main`
before it merges. If it has merged first (once this branch is rebased onto `main` as in Step 1,
`grep -n 'apps/swarm' CLAUDE.md` prints its Layout row), merge by meaning: in the Architecture
sentence, keep its wording and move only the live page from what is not built yet to what is built
and tested (if nothing is then left unbuilt, the sentence reads `The contracts, the protocol
package, the gateway, the swarm, the MCP server and the live page are built and tested.`); add the
`apps/web/` row as the table's last row, after its rows; and add the Toolchain paragraph directly
before the paragraph that starts `**CI**`, after any paragraph it added. Match words, not line
breaks: a sentence may wrap differently in the file than here.

1. In `## Architecture (implementation-relevant facts)`, replace

   ```markdown
   The contracts, the protocol package and the gateway are built and tested; the swarm, MCP server
   and live page are not yet.
   ```

   with

   ```markdown
   The contracts, the protocol package, the gateway and the live page are built and tested; the swarm
   and MCP server are not yet.
   ```

2. In `## Layout`, after the `apps/gateway/` row, add the `apps/web/` row:

   ```markdown
   | `apps/gateway/` | The provider's HTTP side: offers, payment checks, relay, credentials, redemption, the keeper and the activity feed |
   ```

   becomes

   ```markdown
   | `apps/gateway/` | The provider's HTTP side: offers, payment checks, relay, credentials, redemption, the keeper and the activity feed |
   | `apps/web/` | The live page: a static page with no build step, served by the gateway at `/`, that shows one of the provider's pools, its ledger and its buyers as the chain holds them |
   ```

3. In `## Toolchain`, after the TypeScript paragraph, add a paragraph. The paragraph ends

   ```markdown
   It runs on macOS on Apple silicon, or on Linux or WSL2 with glibc 2.38 or later (Ubuntu 24.04 or
   later).
   ```

   and becomes

   ```markdown
   It runs on macOS on Apple silicon, or on Linux or WSL2 with glibc 2.38 or later (Ubuntu 24.04 or
   later).

   The live page (`apps/web`) is plain JavaScript with JSDoc types, checked by `tsc` (`checkJs`), and
   has no build step: the gateway serves the folder at `/` (`QUORUM_WEB_DIR`, by default `../web` from
   `apps/gateway`). Its tests run with `pnpm --filter @quorum-on-near/web test`, and in `pnpm test`.
   ```

- [ ] **Step 7: Run everything once more and commit**

```bash
pnpm install
pnpm typecheck
pnpm test
git diff --stat
```

Expected: no type errors; every test passes; `git diff --stat` lists only `CLAUDE.md`.

```bash
git add CLAUDE.md
git commit -m "record the live page in the layout, the toolchain and the architecture summary"
```

---

## Spec coverage

| Spec requirement (section 8, as Task 1 records it) | Where |
|---|---|
| `apps/web` is `index.html`, `app.js` (an ES module), `totals.js` and `style.css`, with no build step | Task 1 (`package.json` with no dependencies, `checkJs`); Task 2 (`page.test.ts`: "are app.js and totals.js", "imports only files of this folder, so the page needs no build step", "loads app.js as a module and style.css as its stylesheet") |
| The gateway serves the folder at `/` | The gateway as it stands (`QUORUM_WEB_DIR`); Task 3, Step 2 |
| The page never signs anything and needs no wallet | Task 1 (`viewRequest`: a `call_function` query only); Task 2 (`app.js` sends only `GET`s and view calls) |
| The icon is declared inline, so there is no `/favicon.ico` request | Task 2 (`page.test.ts`: "declares its icon inline"); Task 3, Step 5 |
| Every value read is written as text or as an attribute, never as HTML | Task 2 (`page.test.ts`: "never writes HTML from a string"; `app.js` uses `textContent` and properties) |
| The banner, word for word, static whatever the network; the footer names the network, the pools contract and the token | Task 2 (`page.test.ts`: "shows the banner, word for word"; `loadSetup` fills `#source`); Task 3, Step 4 |
| Which pool: `?pool=<id>` written as the gateway writes pool ids, else the provider's newest | Task 1 (`poolParam` tests; `poolChoices`: "offers the provider's pools, newest first, and shows the newest", "shows the requested pool when it is one of the provider's") |
| The selector lists only the provider's pools, newest first; choosing one sets `?pool=` | Task 1 (`poolChoices` tests); Task 2 (`renderSelector`, the `change` handler); Task 3, Step 5 |
| A pool whose seller is not exactly the provider is replaced by the notice, with none of its text; checked on the same refresh's `get_pool` | Task 1 (`foreignPoolNotice` tests, including look-alike accounts; `poolChoices`: "never offers a requested pool of another seller"); Task 2 (`poll` checks the `get_pool` result) |
| "There is no pool `<id>`." and "The provider has not opened a pool yet." | Task 1 (`viewResult`: "gives null for a view that returned null"; `poolChoices`: "shows nothing when the provider has no pool"); Task 2 (`poll`, `renderNoPool`); Task 3, Step 5 |
| The pool card: terms, bar, seat price, bonus escrowed, countdown, seller, status | Task 2 (`renderPool`); Task 3, Step 4 |
| The countdown: `m:ss`, `h:mm:ss` from an hour, rounded up, "closed" unless Open, every second, the deadline as tooltip | Task 1 (`countdown` tests); Task 2 (`renderCountdown`, `COUNTDOWN_INTERVAL_MS`, the `title`) |
| The buyer table: buyer, seats, amount paid, state, with settled derived from the pool's status | Task 1 (`buyerRows`: "gives one row per buyer in commit order", "shows every buyer of a settled pool as settled") |
| A bonus share only for a refunded buyer; a claimable one counts in held now | Task 1 (`buyerRows`: "gives a refunded buyer its bonus share", "keeps a buyer whose pushed refund failed claimable"; `poolTotals`: "holds the refund of a buyer whose pushed refund failed") |
| The buyer's `commit` and `refund` records linked, a failed one labelled, a non-base58 hash never linked | Task 1 (`buyerRows` link tests; `txUrl` tests) |
| The ledger totals, and held now beside `ft_balance_of(pools contract)` | Task 1 (`poolTotals` tests for every status); Task 2 (`renderLedger`); Task 3, Step 4 |
| Held now is what the contract owes for this pool (invariant 1); paid in plus the bonus equals the four other totals | Task 1 (`poolTotals`: "accounts for every unit paid in and every unit of the bonus" for each status) |
| The dust counts as paid to the seller once `dust_sent` is set | Task 1 (`poolTotals`: "pays the dust to the seller once it is sent, before the pool is marked refunded") |
| The pool's `settle` and dust records linked beside paid to the seller | Task 1 (`payoutLinks` tests); Task 2 (`#payout-links`) |
| Amounts with all the token's decimals, from `ft_metadata`, followed by its symbol | Task 1 (`formatUnits`, `formatAmount`, `parseToken` tests) |
| `/config.json` and `ft_metadata` once; each refresh `list_pools`, `get_pool`, `get_seats`, `ft_balance_of` and the feed, every view at optimistic finality | Task 1 (`viewRequest`, `readAll` tests); Task 2 (`loadSetup`, `poll`) |
| The RPC URL from the configuration, or the gateway's `/rpc` pass-through | Task 1 (`parseConfig`: accepts `rpcUrl` `/rpc`); Task 3, Step 2 and Step 5 (every `/rpc` body accepted) |
| Every value read checked for its shape; a malformed one fails the refresh with a status line naming it; the explorer prefix must be http or https | Task 1 (`parsePool`, `parsePools`, `parseSeats`, `parseActivity`, `parseConfig`, `parseToken`, `parseBalance`, `viewResult` tests); Task 2 (`tick`) |
| Each request times out after 10 seconds; refreshes never overlap | Task 2 (`REQUEST_TIMEOUT_MS`, the `polling` flag) |
| A failed refresh shows "Could not refresh" with its reason, keeps the last data, and is tried again at the next tick | Task 2 (`tick`, `showStatus`); Task 3, Step 5 |
| `totals.js` is a pure module, the page's one piece of logic, unit-tested | Task 1 |
| Not here: the gateway's `/`, `/config.json`, `/rpc` and `/activity`; the swarm and the MCP server | The protocol and gateway plan; the swarm and MCP server plan |
