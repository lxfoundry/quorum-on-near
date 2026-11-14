# Gateway

`@quorum-on-near/gateway` is the provider's HTTP side. It plays both x402 roles for the `quorum`
scheme: the **resource server**, which answers `402 Payment Required` with an offer, and the
**facilitator**, which checks a payment and settles it on chain. Settling means relaying the buyer's
NEP-366 delegate action: the gateway's relayer account submits it and pays the gas, while the
tokens still come from the buyer.

It also:

- issues the access credential, a JWS signed with its own Ed25519 key;
- answers redemptions, signed NEP-413 proofs with which a buyer follows its seats;
- runs the **keeper**, which calls `settle` and `refund` on the pools contract when they are due;
- keeps the **activity feed**, the transactions it relayed or sent, for transaction links;
- serves the live page ([`apps/web`](../web/README.md)) and what it needs to read the chain;
- can start a scripted swarm run on request (the demo endpoint, off by default).

**It serves only the pools whose `seller` is its configured provider** (`QUORUM_PROVIDER_ACCOUNT`).
Anyone can open a pool on the contract, but the gateway lists, offers, relays payments for, redeems
and keeps only its provider's pools. Any other pool id is answered `404 unknown_pool`. The one
exception is the RPC pass-through, which forwards views of the pools contract and the token
whatever the pool.

The design is section 6 of the
[design spec](../../docs/specs/2026-11-09-quorum-on-near-design.md#6-the-quorum-x402-scheme); the
demo endpoint is section 4 of the
[hosted demo spec](../../docs/specs/2026-11-12-hosted-demo-design.md#4-the-demo-endpoint). The
wire format, the header codecs and the static payment and proof checks are in
[`packages/protocol`](../../packages/protocol/README.md). The scripted buyers that pay it are in
[`apps/swarm`](../swarm/README.md); the MCP server that lets an LLM agent pay it is in
[`apps/mcp`](../mcp/README.md).

## Routes

Every answer is JSON except the page's files. An error body is `{error: "<code>"}`, sometimes with
more fields. The redemption's `410` is an answer, not an error: it carries `status` and the refund
instead.

| Method and path | Purpose | Answers |
|---|---|---|
| `GET /pools` | The provider's pools that are Open with a seat left: `id`, `terms`, `seat_price`, `target`, `taken`, `deadline_ms`, `bonus`, `min_bonus_per_seat` | `200`; `503 chain_unavailable` |
| `GET /pools/:id/access?seats=N` | No payment or proof header: the offer | `402` with the offer; `400 invalid_seats`; `404 unknown_pool`; `409 pool_closed`; `410 pool_expired`; `503 chain_unavailable` |
| `GET /pools/:id/access?seats=N` with `X-PAYMENT` | A payment: checks, relay, outcome ([Payment](#payment)) | `202`, `200`, `402`, `409`, `410`, `502`, `503`; `400 invalid_seats`; `404 unknown_pool` |
| `GET /pools/:id/access` with `X-QUORUM-PROOF` | A redemption ([Redemption](#redemption)) | `202`, `200`, `410`, `401`, `404`, `503` |
| `GET /activity` | The whole activity feed, oldest first | `200` |
| `GET /activity?pool=:id` | One pool's records | `200`; `400 invalid_pool` |
| `GET /.well-known/jwks.json` | The public key that verifies credentials | `200` |
| `GET /config.json` | What the live page needs: `network`, `rpcUrl` (`/rpc` while the pass-through is on), `poolsContract`, `token`, `provider`, `explorerTxUrl`, `demo` (`true` when the demo endpoint is on) | `200` |
| `POST /rpc` | Only with `QUORUM_RPC_PASSTHROUGH=true`: a read-only pass-through for view calls ([RPC pass-through](#rpc-pass-through)) | The RPC's own status; `400 invalid_json`; `403 not_allowed`; `413 body_too_large`; `503 chain_unavailable` |
| `GET /demo` | Only with `QUORUM_DEMO_COMMAND` set: the demo's status ([Demo endpoint](#demo-endpoint)) | `200` |
| `POST /demo/fills`, `POST /demo/fails` | Only with `QUORUM_DEMO_COMMAND` set, and the header `X-Quorum-Demo: 1`: start a run | `202`; `403 demo_header_required`; `409 demo_running`; `409 pool_open`; `429 demo_limit`; `503 chain_unavailable` |
| `GET /`, `/index.html`, `/app.js`, `/totals.js`, `/style.css` | The live page's four files, from `QUORUM_WEB_DIR` (`/` serves `index.html`). No other file of that folder is served | `200`; `404 not_found` |
| anything else | | `404 not_found`; `500 internal_error` for an unhandled error |

`:id` is a pool id in decimal, with no sign and no leading zero. Any other form is `404 unknown_pool`
on `/pools/:id/access` and `400 invalid_pool` on `/activity`. `seats` is optional (1 by default),
matches `^[1-9][0-9]*$` and is at most 1000.

**One route, three modes.** `GET /pools/:id/access` picks its mode by header. `X-PAYMENT` wins: a
request that carries both headers is a payment, and its proof is ignored. Then `X-QUORUM-PROOF`.
With neither, the answer is the offer.

### The offer

With no header, the gateway reads the pool and answers the first of these that applies:

| Pool | Answer |
|---|---|
| Not found, or another seller's | `404 {error: "unknown_pool"}` |
| Expired or Refunded | `410 {error: "pool_expired", status}` |
| Filled, Settled, or Open with no seat left | `409 {error: "pool_closed", status}` |
| Open with a seat left | `402 {x402Version: 1, error: "payment required", accepts: [offer]}` |

The offer is made for `min(seats, seats left, max_seats_per_buyer)`, and `extra.seats` says how
many. Its fields are in
[section 6.2 of the design spec](../../docs/specs/2026-11-09-quorum-on-near-design.md#62-offer).

## Payment

A buyer signs an NEP-366 delegate action holding one `ft_transfer_call` on the token, to the pools
contract, with a `commit` message, and sends it base64-encoded in `X-PAYMENT`. A payment may commit
to fewer seats than the request's `seats` (a reduced offer paid at the URL first requested), never
to more.

### Checks, in order

Nothing is relayed until every check passes. A failed check is answered `402`, with the offer as it
stands and `error` set to the code. The full table is
[section 6.4 of the design spec](../../docs/specs/2026-11-09-quorum-on-near-design.md#64-checks-then-relay).

| # | Check | Codes |
|---|---|---|
| 1 | The header decodes; `x402Version` 1, scheme `quorum`, the configured network; the signature is valid | `invalid_payload`, `invalid_signature` |
| 2 | The receiver is the token; exactly one `FunctionCall` to `ft_transfer_call`; a deposit of exactly 1 yoctoNEAR; gas from `QUORUM_COMMIT_MIN_GAS` to `QUORUM_COMMIT_MAX_GAS` | `wrong_receiver`, `wrong_method`, `wrong_deposit`, `gas_too_low`, `gas_too_high` |
| 3 | Compact JSON args of exactly `receiver_id` (the pools contract), `amount` and `msg`; `msg` commits 1 to `seats` seats to this pool; `amount` is the seats times the seat price | `wrong_args`, `wrong_pool`, `wrong_amount` |
| 4 | The key is a full-access key of the sender | `not_full_access` |
| 5 | The nonce is above the key's, and below the final height × 10^6; `max_block_height` is more than 5 blocks above the final height and at most `ceil(QUORUM_MAX_TIMEOUT_SECONDS × 1000 / QUORUM_BLOCK_TIME_MS) + 5` above it | `stale_nonce`, `nonce_too_large`, `expired` |
| — | The buyer has no other payment in flight | `payment_in_flight` |
| 6 | The pool is Open, before its deadline by the final block's time, with a seat left | `pool_closed` |
| 7 | The buyer's token balance covers the amount | `insufficient_balance` |
| 8 | The buyer is not the pool's seller, and its seats plus these stay within `max_seats_per_buyer` | `seller_commit`, `over_buyer_cap` |

Checks 1 to 3 run without the network (in `packages/protocol`). Before check 6, the key and its
nonce are read again: an earlier payment of the buyer may have finished in between. Views and access
keys are read at optimistic finality; heights and deadlines are measured against the latest final
block. After an `over_buyer_cap` refusal, the fresh offer counts the seats the buyer already holds.

Before check 1, `seats` must be valid (`400 invalid_seats`) and the pool must be the provider's
(`404 unknown_pool`). If the chain cannot be read during the checks, or before the relayer sends,
the answer is `503 {error: "chain_unavailable"}` and nothing is relayed.

### One payment in flight per buyer

A payment takes its buyer's in-flight slot once it has passed checks 4 and 5, which only the buyer's
own fresh payment can pass. A payment signed with another key, or a replay of a used or expired
payment copied from the chain, never holds the slot. The slot is freed once the payment's answer is
ready.

When the result stays unknown (`502 result_unknown`), the buyer stays held until the gateway reads a
final block above the payment's `max_block_height` plus 20 blocks: a delegate included at its
`max_block_height` still runs the token's and the pools contract's receipts in the blocks after it.
The hold is lifted by a final height read for any later payment, never by the gateway's clock. Holds
live in memory, so a restart clears them.

### Relay

The relayer account wraps the delegate action in a transaction and sends it once, waiting for
`EXECUTED_OPTIMISTIC`. It holds every key in `QUORUM_RELAYER_KEYS` and signs with each key one
transaction at a time, so payments relay in parallel without nonce clashes. A request waits up to
30 seconds for a free key; past that it is answered `503`.

- With a key in hand, the relayer checks the expiry again: a delegate within 5 blocks of its
  `max_block_height` is not sent, and the payment is refused `402 expired`.
- An RPC error that refuses the transaction, or an HTTP 429, is a rejection: nothing ran.
- On a timeout, a network failure, a server error or an unreadable response, the relayer looks the
  transaction up by hash every 2 seconds. It never signs or sends it again. For a payment the
  lookup ends on the first final block above `max_block_height`, or after
  `2 × QUORUM_MAX_TIMEOUT_SECONDS`, whichever comes first; for a keeper call, after 60 seconds.

### Outcomes

| Outcome | Answer |
|---|---|
| Seats taken, pool still Open | `202 {status: "pending", receipt: {poolId, buyer, seats, txHash}, pool: {taken, target, deadlineMs}}` with `X-PAYMENT-RESPONSE` |
| This payment filled the pool | `200 {status: "filled", credential, poolId, seats, terms}` with `X-PAYMENT-RESPONSE`; `seats` counts every seat the buyer holds in the pool |
| No seats taken, the pool past its deadline (Expired, Refunded, or Open at or past its deadline by the final block's time) | `410 {error: "pool_expired", poolId, txHash}` |
| No seats taken, and the transfer never reached the pools contract or the pool is still Open with a seat left | `502 {error: "relay_failed", txHash}` |
| No seats taken because the pool filled first | `409 {x402Version: 1, error: "no_seats_taken", accepts: []}` |
| The RPC rejected the transaction, or the delegate action itself failed | `502 {error: "relay_failed", txHash}` |
| The result is unknown, or the outcome cannot be read | `502 {error: "result_unknown", txHash}` |

When no seats were taken, the token has returned the payment. `X-PAYMENT-RESPONSE` carries
`base64(JSON {success: true, transaction, network, payer})`: the transaction hash, the network and
the buyer.

Every executed commit, a failed one included, gets an activity record. A rejected relay and one
whose result stays unknown get none.

## Redemption

A buyer answered `202` comes back later to learn what became of its seats. It signs an NEP-413
message, `quorum:redeem:<poolId>`, for the gateway's host (the host of `QUORUM_GATEWAY_URL`, with its port if it has one, such as
`localhost:8402`), with a
fresh 32-byte nonce whose first 8 bytes are the signing time, and sends it base64-encoded in
`X-QUORUM-PROOF`. The format is in
[section 6.5 of the design spec](../../docs/specs/2026-11-09-quorum-on-near-design.md#65-redemption).

The gateway checks, in this order:

1. **the form**: a well-formed header, that message and that recipient;
2. **the age**: signed less than 5 minutes ago, and at most 1 minute ahead of the gateway's clock;
3. **the signature**;
4. **the key** is a full-access key of the account, read from the chain (the age is checked again
   after this read);
5. **the nonce** has not been seen with that key. Nonces are kept in memory for 6 minutes.

A failed check is `401`, with `error` set to `invalid_proof`, `wrong_message`, `wrong_recipient`,
`stale_proof`, `invalid_signature`, `not_full_access` or `replayed_proof`. A pool that is not the
provider's is `404 unknown_pool`, checked before the proof.

The gateway then reads the buyer's seats (`get_buyer`) and answers by the pool's status:

| Pool | Answer |
|---|---|
| The account holds no seats in it | `404 {error: "no_seats"}` |
| Open | `202 {status: "pending", seats, taken, target, deadlineMs}` |
| Filled or Settled | `200 {status: "filled", credential, poolId, seats, terms}` |
| Expired or Refunded | `410 {status, amount, bonusShare, txHash}` |

In the `410`, `status` is the buyer's state on the contract: `refund_pending`, `refunded` or
`claimable`. `amount` is the refund (the seats' price plus the bonus share), `bonusShare` its bonus
part, and `txHash` the last successful refund the activity feed records for the buyer, or `null`
(a refund the buyer claimed itself is never in the feed). If anything fails, the answer is
`503 chain_unavailable`.

**The gateway keeps no list of waiting buyers.** Each redemption is answered from the contract as
it stands. The only thing in between is a short cache of pool views:

- Redemptions share each pool's `get_pool` answer for 2 seconds from when its read was sent, and
  requests for a pool whose read is in flight join it. The cache holds at most 64 pools.
- A pool that does not exist is never kept.
- Every transaction the gateway sends (a relayed payment, a keeper call) clears the cache once it
  has returned.
- Nothing else reads through it: offers, payments, the keeper, `GET /pools` and the demo read the
  chain directly. A change the gateway did not send, such as a deadline passing, can show up to
  2 seconds late.

## Credential

The credential is a compact JWS, `alg: "EdDSA"`, signed with `QUORUM_CREDENTIAL_JWK`. That key is
an Ed25519 key of the gateway's own, distinct from every NEAR account key. Its protected header holds
`alg`, `kid` (the RFC 7638 thumbprint of the public key) and `typ: "JWT"`.

| Claim | Value |
|---|---|
| `iss` | `QUORUM_GATEWAY_URL`, without a trailing slash |
| `sub` | the buyer's account |
| `pool` | the pool id |
| `seats` | the seats the buyer holds in the pool |
| `terms` | the pool's terms, from the contract |
| `iat` | the issue time, in seconds |
| `jti` | a fresh UUID |
| `simulated` | `true`: no resource stands behind the credential |

It has no `exp` and no `aud`. The same buyer always gets the same `sub`, `pool` and `seats`; only
`iat` and `jti` change between calls. `GET /.well-known/jwks.json` answers
`{keys: [{kty: "OKP", crv: "Ed25519", x, kid, alg: "EdDSA", use: "sig"}]}`, with no private part.

Verifying a credential with jose 6 (the gateway itself uses jose 6.2.17):

```ts
import { createRemoteJWKSet, jwtVerify } from 'jose';

const gatewayUrl = 'http://localhost:8402'; // QUORUM_GATEWAY_URL, no trailing slash
const jwks = createRemoteJWKSet(new URL(`${gatewayUrl}/.well-known/jwks.json`));

const { payload } = await jwtVerify(credential, jwks, {
  issuer: gatewayUrl,
  algorithms: ['EdDSA'],
  typ: 'JWT',
});
// payload.sub is the buyer; payload.pool, payload.seats and payload.terms the seat;
// payload.simulated is true.
```

`jwtVerify` throws if the signature, the issuer, the algorithm or the `typ` does not match. Check
`payload.sub` and `payload.pool` against what you expect, too.

## Keeper

The keeper signs with the relayer account and calls the pools contract with no deposit. It starts
with the gateway, and runs a pass `QUORUM_KEEPER_INTERVAL_MS` (5000 ms by default) after the
previous one has finished. Each pass lists the provider's pools and makes one call at a time:

| Pool | Call | Gas |
|---|---|---|
| Filled | `settle(pool_id)` | `QUORUM_SETTLE_GAS` |
| Expired, unless every buyer has been visited and the dust transfer is in flight | `refund(pool_id, limit)`, `limit` = `QUORUM_REFUND_LIMIT` | `QUORUM_REFUND_GAS` |

A call **makes progress** when `settle` logs `pool_settled`, or when the `refund` receipt succeeds
and either the pool had buyers left to visit or the contract logs `pool_refunded`. A call that makes
no progress, or whose result is rejected or unknown, starts a backoff for its pool: skipped for
30 seconds, twice as long after each further failure in a row, at most 10 minutes. Progress ends the
backoff. Only the first failure of a run is written to the feed; every failure is logged.

`settle` and `refund` are open to anyone and safe to repeat, so the keeper is a convenience: no
buyer's money depends on it.

## Activity feed

The feed lists what the gateway relayed or sent, to give the live page and the buyers transaction
links. The money state is always read from the contract. It is kept in memory and appended to
`<QUORUM_DATA_DIR>/activity.jsonl`, one JSON object per line. At startup the file is loaded,
skipping any line that does not parse, and its folder is created if needed.

| Field | Value |
|---|---|
| `at` | milliseconds since the epoch |
| `poolId` | the pool id |
| `kind` | `commit`, `settle`, `refund` or `dust` |
| `account` | the buyer (`commit`, `refund`), or the seller (`settle`, `dust`, and the record of a keeper call that made no progress) |
| `seats` | the seats committed or refunded; for `settle`, the pool's seats taken; 0 otherwise |
| `amount` | in the token's base units, as a decimal string |
| `txHash` | the transaction |
| `ok` | `false` for a commit that took no seats, a refund the contract could not push, or a keeper call that made no progress |

A `refund` record comes from the contract's `seat_refunded` (ok) or `refund_failed` (not ok); a
`dust` record from `pool_refunded`. A failure to append is logged, and never changes an answer.

## Demo endpoint

Off by default. With `QUORUM_DEMO_COMMAND` set, `POST /demo/fills` and `POST /demo/fails` start one
scripted swarm run, and `GET /demo` reports it. The command is a JSON array, the program and its
first arguments, to which the gateway appends the scenario: for example
`["node","../swarm/src/main.ts","demo"]`. The program must be the run itself, never a shell or a
package manager, which would not pass signals on.

A `POST` reads no body, sends no CORS header, and is answered by the first of these that applies:

| Condition | Answer |
|---|---|
| No header `X-Quorum-Demo: 1` | `403 {error: "demo_header_required"}` |
| A run in progress | `409 {error: "demo_running", scenario, startedAt}` |
| `QUORUM_DEMO_MAX_RUNS_PER_DAY` runs started this UTC day | `429 {error: "demo_limit"}` |
| The provider's pools cannot be read within 8 seconds | `503 {error: "chain_unavailable"}` |
| One of the provider's pools is Open | `409 {error: "pool_open", poolId}` |
| Otherwise | `202 {scenario, startedAt}`, and the run starts |

The header blocks other sites: a page elsewhere cannot send it without a CORS preflight, which the
gateway never answers. `GET /demo` answers
`{running, scenario, startedAt, last, runsToday, maxRunsPerDay}`; `last` is
`{scenario, startedAt, endedAt, exitCode, signal}` for the last run that ended, or `null`. Times
are milliseconds since the epoch.

A run:

- **One at a time.** The slot is checked and taken in one synchronous step. A run counts towards the
  day's cap when it starts, even one whose program cannot be started. The count is in memory.
- **No shell.** The program starts in the gateway's current folder, with the gateway's environment
  minus `QUORUM_RELAYER_KEYS`, `QUORUM_CREDENTIAL_JWK`, `QUORUM_SEED_PHRASE`,
  `QUORUM_SEED_PHRASE_FILE` and `QUORUM_DEMO_RPC_URL`. With `QUORUM_DEMO_RPC_URL` set, the run gets
  that URL as its `QUORUM_RPC_URL`.
- **Its output** goes to the gateway's standard output and error, each line prefixed `[demo] `.
- **Time limit.** After `QUORUM_DEMO_MAX_RUN_SECONDS` it gets SIGTERM, then SIGKILL 10 seconds later.
- **At shutdown** the gateway sends a run in progress SIGTERM, and starts no new one.

The full behaviour is in
[section 4 of the hosted demo spec](../../docs/specs/2026-11-12-hosted-demo-design.md#4-the-demo-endpoint).

## RPC pass-through

Off by default. With `QUORUM_RPC_PASSTHROUGH=true`, `POST /rpc` forwards the live page's view calls
to `QUORUM_RPC_URL`, and `/config.json` gives the page `/rpc` instead of the RPC URL. Use it when
the RPC refuses browser requests, or when its URL holds an API key.

- **Allowed:** a JSON-RPC 2.0 `query` with `request_type: "call_function"`, on the pools contract or
  the token, at a `finality` or a `block_id`, with no other field at either level, and
  `args_base64` of at most 1024 characters. Anything else is `403 {error: "not_allowed"}`.
- **Limits:** a body over 16 KiB is `413 body_too_large`; a body that is not JSON `400 invalid_json`.
  The forward waits 10 seconds for the RPC; past that, or if the RPC cannot be reached, the answer
  is `503 chain_unavailable`.
- **The answer** is the RPC's own JSON and status. Any copy of the RPC URL in it is replaced by the
  name `QUORUM_RPC_URL`.
- **Cached views.** Four of the page's views are answered from memory for 2 seconds from when their
  read was sent: `get_pool` and `list_pools` on the pools contract at `final` finality, and
  `get_seats` on the pools contract and `ft_balance_of` on the token at a block hash. Requests that
  arrive while a read is in flight share it, and each answer carries its caller's JSON-RPC `id`.
  Only a view's result is kept; an error, or a status other than `200`, is passed on and never kept.

## RPC reads and retries

The gateway reads the chain with two providers on `QUORUM_RPC_URL`:

- **Views** (pools, buyers, balances, access keys, blocks) keep near-api-js's own retries and are
  tried again after an HTTP 429: up to 3 more times, after 200, 400 and 800 ms, each stretched by up
  to half again at random. That provider has no method that sends a transaction.
- **The relayer** reads and sends with a provider that posts each request once, so a transaction is
  never posted twice.

## Configuration

The gateway reads `QUORUM_*` variables from its environment. `pnpm start` runs
`node --env-file-if-exists=.env src/main.ts` in `apps/gateway`, so it loads `apps/gateway/.env` if
there is one; a variable already set in the environment takes precedence over the file.
[`.env.example`](.env.example) lists every variable with its default.

Two ways to write `.env`:

- `pnpm --filter @quorum-on-near/swarm swarm env gateway` writes it from the swarm's configuration:
  the shared accounts and RPC, the relayer's keys from its key folder, a new credential key, and the
  commit gas and block time. It never writes over an existing file. See
  [`apps/swarm`](../swarm/README.md).
- By hand: copy `.env.example` to `.env` and fill in the three required values.
  `pnpm --filter @quorum-on-near/gateway keygen` prints a new credential key as one
  `QUORUM_CREDENTIAL_JWK=…` line; from `apps/gateway`, `node src/keygen.ts >> .env` appends it.

`.env` holds secrets: never commit it (it is gitignored) or share it.

The configuration is checked as a whole at startup. Every problem is listed, one per line, and the
gateway exits with code 1. Secret values are never repeated in those lines. An optional variable
takes its default only when it is **unset**: one set to an empty value is checked as given, and
fails unless empty has a meaning for it (as for `QUORUM_WEB_DIR`, `QUORUM_DEMO_COMMAND` and
`QUORUM_DEMO_RPC_URL`). Gas is in gas units (1 Tgas = 10^12), and every gas value is at most
300 Tgas.

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `QUORUM_NETWORK` | no | `near:testnet` | `near:testnet`, or `near:sandbox` for a local test chain. It labels offers; the RPC decides which chain is paid on, and startup checks they agree |
| `QUORUM_RPC_URL` | no | `https://test.rpc.fastnear.com` | The NEAR RPC, `http` or `https`. Treated as possibly holding a key: never repeated in a problem line, and replaced by its name in the gateway's output. Without the pass-through, `/config.json` gives it to the page, so a URL with a user name, password, query or fragment is refused; a key in its path is not detected, so such an endpoint needs `QUORUM_RPC_PASSTHROUGH=true` |
| `QUORUM_GATEWAY_URL` | no | `http://localhost:8402` | The public base URL (trailing slashes removed): the credential's `iss`, the start of each offer's `resource`, and, by its host, the `recipient` a redemption proof must name |
| `QUORUM_GATEWAY_PORT` | no | `8402` | The port to listen on, 1 to 65535 |
| `QUORUM_PARENT_ACCOUNT` | **yes** | | The parent account; the three accounts below default to sub-accounts of it |
| `QUORUM_TOKEN_ACCOUNT` | no | `3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af` | The NEP-141 token (Circle's USDC on testnet). Must be the token the pools contract holds |
| `QUORUM_POOLS_ACCOUNT` | no | `pools.<parent>` | The pools contract |
| `QUORUM_RELAYER_ACCOUNT` | no | `relay.<parent>` | The account that relays payments, calls the keeper's methods and pays their gas |
| `QUORUM_PROVIDER_ACCOUNT` | no | `provider.<parent>` | The only seller whose pools the gateway serves |
| `QUORUM_RELAYER_KEYS` | **yes**, secret | | The relayer's full-access secret keys, comma-separated `ed25519:<base58>` values (64 bytes each), each listed once |
| `QUORUM_CREDENTIAL_JWK` | **yes**, secret | | The private Ed25519 JWK that signs credentials (`kty: "OKP"`, `crv: "Ed25519"`, `x`, `d`, with `x` the public key of `d`). Only those four members are kept |
| `QUORUM_COMMIT_MIN_GAS` | no | `50000000000000` | The least gas a payment's `ft_transfer_call` may attach (50 Tgas) |
| `QUORUM_COMMIT_MAX_GAS` | no | `100000000000000` | The most it may attach (100 Tgas); at least the minimum |
| `QUORUM_MAX_TIMEOUT_SECONDS` | no | `120` | The offer's `maxTimeoutSeconds`: how long a signed payment may stay valid. It bounds `max_block_height` |
| `QUORUM_BLOCK_TIME_MS` | no | `1000` | The block time used to turn that timeout into blocks |
| `QUORUM_KEEPER_INTERVAL_MS` | no | `5000` | The wait between keeper passes, 1 to 2147483647 |
| `QUORUM_REFUND_LIMIT` | no | `10` | Buyers refunded per `refund` call, 1 to 10 |
| `QUORUM_SETTLE_GAS` | no | `100000000000000` | Gas for a `settle` call; at least 50 Tgas (the 33 Tgas `settle` requires at entry, plus 17) |
| `QUORUM_REFUND_GAS` | no | `300000000000000` | Gas for a `refund` call; at least 10 + 23 × (limit + 1) + 17 Tgas, which is 280 Tgas at a limit of 10 |
| `QUORUM_DATA_DIR` | no | `data` | The folder of the activity feed, relative to the current folder |
| `QUORUM_WEB_DIR` | no | `../web` | The live page's folder, relative to the current folder. Empty serves no page. It may not be the gateway's folder or one above it. If it is not a folder at startup, the gateway warns and serves no page |
| `QUORUM_RPC_PASSTHROUGH` | no | `false` | `true` turns on `POST /rpc` |
| `QUORUM_EXPLORER_TX_URL` | no | `https://testnet.nearblocks.io/txns/` | The explorer prefix a transaction hash is appended to, for the page's links. It ends in `/` or `=`, and a link built from it keeps its origin |
| `QUORUM_DEMO_COMMAND` | no | empty (off) | A JSON array of non-empty strings: the demo run's program and first arguments |
| `QUORUM_DEMO_MAX_RUNS_PER_DAY` | no | `100` | Demo runs started per UTC day, 1 to 1000 |
| `QUORUM_DEMO_MAX_RUN_SECONDS` | no | `1800` | The longest a demo run may last, 60 to 7200 seconds |
| `QUORUM_DEMO_RPC_URL` | no, secret | empty | The RPC URL a demo run gets as its `QUORUM_RPC_URL`. No page is given it, so it may hold a key anywhere. Empty: a run uses `QUORUM_RPC_URL` |

The demo limits are checked even while the demo is off.

## Startup and shutdown

At startup, in order:

1. From here on, the values of `QUORUM_RPC_URL` and `QUORUM_DEMO_RPC_URL` are replaced by their
   names in everything the process writes to standard output and error.
   [`src/redact.ts`](src/redact.ts) says what this does not catch.
2. The configuration is read; any problem ends the gateway with code 1.
3. The RPC's `chain_id` is read. `near:testnet` needs `testnet`; `near:sandbox` refuses NEAR's
   public chains (`mainnet`, `testnet`). A mismatch, or an RPC that cannot be read, ends the gateway
   with code 1.
4. The pools contract's `get_token` must equal `QUORUM_TOKEN_ACCOUNT`, or the gateway exits with
   code 1.
5. The activity feed is loaded, and the live page's folder checked.
6. The server listens on `QUORUM_GATEWAY_PORT` and prints
   `gateway listening on http://localhost:<port> (public URL <QUORUM_GATEWAY_URL>)`. A port it
   cannot listen on ends it with code 1. The keeper starts.

An uncaught error ends the gateway with code 1.

On SIGINT or SIGTERM it prints `<signal>: shutting down`, stops taking requests, waits for the
requests in progress to be answered (closing each connection once its answer is sent), stops the
keeper after its running pass, and sends a demo run in progress SIGTERM. The process exits once all
of that has finished. A second signal ends it at once.

## Running and testing

Node 22.22.2 or later and pnpm 10, from the repository's root after `pnpm install`:

```bash
pnpm --filter @quorum-on-near/gateway start         # reads apps/gateway/.env
pnpm --filter @quorum-on-near/gateway test          # unit tests: a fake chain, no network
pnpm --filter @quorum-on-near/gateway typecheck     # tsc, no emit step: Node runs the sources
pnpm --filter @quorum-on-near/gateway test:sandbox  # the gateway against a local NEAR sandbox
```

`test` runs every suite except `test/sandbox/`, on any OS.

`test:sandbox` runs the gateway against a local sandbox with the real contracts: an offer, two
relayed payments that fill a pool, a redemption, and the keeper's settlement. It needs:

- the contracts built with `cargo near build non-reproducible-wasm`, and the absolute paths of the
  wasm files in `QUORUM_POOLS_WASM` and `QUORUM_MOCK_USD_WASM`; without them the suite fails,
  naming both;
- Linux or WSL2 with glibc 2.38 or later (Ubuntu 24.04 or later), or macOS on Apple silicon.
  near-sandbox ships no Windows binary, so on Windows the suite is skipped.

The first run downloads the sandbox binary;
`pnpm --filter @quorum-on-near/gateway exec near-sandbox --version` fetches it ahead. The build
commands are in the root [README](../../README.md#b-a-local-sandbox).
