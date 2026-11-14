# @quorum-on-near/web: the live page

A read-only page that shows one of the provider's pools as the chain holds it: its terms and seats,
its ledger and its buyers, refreshed every 2 seconds. The gateway serves it at `/`. It never signs
anything and needs no wallet. When the gateway's demo is on, it also shows two buttons that ask the
gateway to start a run of the swarm.

The banner says what is simulated: "The provider is simulated, and prices are scaled down 10,000
times. The money flow is real: USDC on NEAR testnet." The provider and the GPU access it sells are
simulated, and a buyer's credential is a signed token whose claims include `simulated: true`. The
seats, the bonus, the payout and the refunds the page shows are real token transfers on NEAR testnet.

The full rules are in section 8 of the
[design spec](../../docs/specs/2026-11-09-quorum-on-near-design.md#8-live-page), and the demo
controls in section 5 of the
[hosted demo spec](../../docs/specs/2026-11-12-hosted-demo-design.md#5-the-live-page).

## What it shows

| Part | Content |
|---|---|
| Header | The name, one line on what a threshold group purchase is, and the banner above. The banner is static, whatever the network |
| Pool picker | A selector of the provider's pools, newest first; choosing one sets `?pool=<id>`. Hidden while the provider has no pool |
| Status line | "Updated at `<time>`", or "Could not refresh (`<reason>`). Retrying every 2 seconds." A screen reader is told only of a failure and of the recovery from one, through a visually hidden live region |
| Demo section | Shown only when `/config.json` has `demo: true`: **Start a pool that fills**, **Start a pool that fails**, and a demo line (see below) |
| Pool card | The terms set by the seller, a bar filling seat by seat ("148 of 192 seats taken"), the seat price, the bonus escrowed, the time left, the seller, and a status badge: "Open", "Filled: payout pending", "Settled: the seller is paid", "Expired: refunds in progress" or "Refunded" |
| Ledger | Paid in, paid to the seller (with the `settle` or `dust` transaction links), refunded, bonus paid out, and *held now for this pool* beside the contract's token balance for all pools. The balance is never below held now |
| Buyers | One row per buyer, in commit order: account, seats, paid, state (`committed`, `refunded, bonus <share>`, `claimable`, or `settled` for every buyer of a settled pool), and the explorer links of its `commit` and `refund` transactions. A failed record is linked as `commit (failed)` |
| Footer | "Read from the pools contract `<account>` on `<network>`; token `<account>`." |

Amounts are shown with all of the token's decimals, read from its `ft_metadata`, then its symbol:
`0.000180 USDC`. The time left is `m:ss` (`h:mm:ss` from an hour), rounded up to the second and
updated every second while the pool is Open, and "closed" in every other status; its tooltip gives
the deadline in local time. It is for display only: the contract compares the deadline with block
time.

## Which pool

| URL | Shows |
|---|---|
| `/` | The provider's newest pool (the highest id it opened), or "The provider has not opened a pool yet." |
| `/?pool=<id>` | That pool. `<id>` is written as the gateway writes pool ids: decimal, no sign, no leading zero, a safe integer; anything else is ignored |
| `/?pool=<id>` of a pool that does not exist | "There is no pool `<id>`." |
| `/?pool=<id>` of a pool another seller opened | "Pool `<id>` was opened by `<seller>`, not by this gateway's provider `<provider>`: this page shows only the provider's pools." |

Anyone can open a pool on the pools contract, so a link can name a pool whose terms the provider
never wrote. For such a pool the page reads only its id and seller, shows none of its text, and reads
nothing more of it: not its seats, the balance or the feed. The check is made on the `get_pool`
answer of the same refresh.

## Where its data comes from

| When | Request | For |
|---|---|---|
| Once (again at each refresh until it succeeds) | `GET /config.json` | `network`, `rpcUrl`, `poolsContract`, `token`, `provider`, `explorerTxUrl`, `demo` |
| Once (again at each refresh until it succeeds) | `ft_metadata` on the token, at final finality | The token's decimals and symbol |
| Every 2 seconds | `list_pools` on the pools contract, in pages of 100, at final finality | The picker, and the newest pool |
| Every 2 seconds | `get_pool` of the pool to show, at final finality | The pool card and the check of its seller |
| Every 2 seconds, for one of the provider's pools | `get_seats` (pages of 100) and the token's `ft_balance_of(pools contract)`, at the block of the `get_pool` answer (`block_id`) | The buyers and the ledger: the pool, its seats and the balance are read at one block |
| Every 2 seconds, for one of the provider's pools | `GET /activity?pool=<id>` | Transaction links only; the money state is always read from the contract |
| Every 2 seconds, while the demo is on | `GET /demo` | The demo line and the buttons |
| On a click | `POST /demo/fills` or `POST /demo/fails`, with `X-Quorum-Demo: 1` | Starting a run |

Every view is a JSON-RPC `query` of `request_type: "call_function"`, sent to the `rpcUrl` that
`/config.json` gives. That is the gateway's own RPC URL, or `/rpc`, the gateway's read-only
pass-through, when the gateway runs with `QUORUM_RPC_PASSTHROUGH=true`. The pass-through forwards
only `call_function` queries of this form, to the pools contract or the token, whatever the method
([section 6.1](../../docs/specs/2026-11-09-quorum-on-near-design.md#61-endpoints)).

- **Checked.** Every value read is checked for its shape. A malformed one fails that refresh, and
  the status line names what was wrong. The configuration's `explorerTxUrl` must be an http or https
  URL that ends in `/` or `=` and whose links keep its origin, and a hash that is not a base58
  transaction hash is never linked.
- **Bounded.** Each request times out after 10 seconds, and the status line names the request or
  view that timed out. Refreshes never overlap. A failed refresh keeps the last data on screen and
  is tried again at the next tick.
- **Written as text.** Every value read is written with `textContent` or as an attribute, never as
  HTML. A refresh writes only what changed, so a selection or a focused link survives it.
- **A pool left behind.** A refresh that ends after the viewer chose another pool renders and
  announces nothing.

## The demo controls

They exist only when the gateway's demo endpoint is on (the gateway's `QUORUM_DEMO_COMMAND` is set),
which `/config.json` reports as `demo: true`.

- The buttons are disabled while a run is in progress, when the day's cap of runs is reached, when
  `GET /demo` cannot be read, and while the page's own request is on its way, so a double click sends
  one request.
- A click first removes `?pool=` from the URL, so that the page follows the provider's newest pool,
  which is the one the run opens.
- The demo line shows, for 10 seconds after a click's answer arrives, that answer ("A run started.
  Its pool appears here once it opens.", and others for `409`, `429` and no answer). Otherwise it
  shows the run in progress, the day's cap reached, "The last run (`<scenario>`) ended at `<time>`.",
  "The last run ended with an error. Its testnet funds may need a refill.", or, before any run,
  "Start a run to watch a pool from its first seat."

The routes and their answers are in
[section 4.2](../../docs/specs/2026-11-12-hosted-demo-design.md#42-routes) of the hosted demo spec.

## Files

| File | Content |
|---|---|
| `index.html` | The markup: header and banner, picker, status line, demo section, pool card, ledger, buyer table, footer. Its icon is declared inline, so a browser asks for no `/favicon.ico` |
| `app.js` | An ES module that fetches and renders: the refresh loop, the view calls, the picker, the demo buttons |
| `totals.js` | All the page's logic, as functions with no I/O: the body of a view call and the decoding of its answer, the shape checks, the ledger totals (`poolTotals`), the buyer rows, the explorer links, the choice of pool and its notices, the countdown, and the demo controls and line |
| `style.css` | The styles, light and dark (`color-scheme: light dark`) |

There is no build step. The page is plain JavaScript with JSDoc types, checked by `tsc` with
`checkJs` (`tsconfig.json`); `app.js` imports only `totals.js`.

## Serving it

The gateway ([`apps/gateway`](../gateway/README.md)) serves the page from the folder that
`QUORUM_WEB_DIR` names, by default `../web`, resolved from the folder the gateway runs in
(`apps/gateway` under `pnpm --filter @quorum-on-near/gateway start`). It serves exactly the four page
files: `index.html` at `/` and at `/index.html`, `/app.js`, `/totals.js` and `/style.css`. Every other
path, such as this folder's `package.json`, tests or `node_modules`, is answered `404`. An empty
`QUORUM_WEB_DIR` serves nothing at `/`.

The page reads `/config.json`, `/activity` and `/demo` from the origin that served it, so it runs
only behind the gateway. With the gateway started as in the
[repository's README](../../README.md#c-near-testnet), open <http://localhost:8402/>.

## Tests

```bash
pnpm --filter @quorum-on-near/web test
pnpm --filter @quorum-on-near/web typecheck
```

They also run in `pnpm test` and `pnpm typecheck` at the repository's root. The vitest suites
(`test/`) need no browser and no network:

| Suite | Covers |
|---|---|
| `totals.test.ts` | The functions of `totals.js`: amounts, the ledger totals in every pool status, buyer rows and links, the shape checks, the choice of pool, the countdown, the demo line |
| `refresh.test.ts` | `app.js` run against a hand-written stand-in for the DOM, `fetch` and the timers: what a refresh reads and writes, the notice for another seller's pool, a change of pool during a refresh, the status line and its announcements, the demo controls. Every view-call body is checked against the gateway's pass-through rule |
| `page.test.ts` | `index.html`, the scripts and `style.css`: the banner word for word, every element `app.js` looks up, imports only from this folder, no HTML written from a string |
