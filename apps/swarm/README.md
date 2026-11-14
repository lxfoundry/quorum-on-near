# The swarm (`apps/swarm`)

The `swarm` command line runs the system's side of a pool from end to end, on NEAR testnet or a
local sandbox. It creates and funds every account under one parent account, opens pools as the
provider, runs 20 scripted buyer agents against a pool, checks the final on-chain state, writes the
gateway's and the MCP server's `.env` files, and returns surpluses to the funding account.

Each scripted buyer is an agent with its own sub-account and full-access key, and one rule:
**commit if the seat price is at most its top price.** It pays over HTTP 402 through the
[gateway](../gateway/README.md), signing an NEP-366 delegate action that the gateway's relayer
submits, then follows its seats with NEP-413 proofs until it holds a credential or its refund. The
buyers' side is the [buyer package](../../packages/buyer/README.md), shared with the
[MCP server](../mcp/README.md); the wire format is the [protocol package](../../packages/protocol/README.md).
The design is section 7 of the
[design spec](../../docs/specs/2026-11-09-quorum-on-near-design.md#7-accounts-and-agents).

**What is simulated.** The provider (the seller) and the GPU access it sells are simulated: the
credential a filled pool gives is a signed token whose claims include `simulated: true`, with no
GPU behind it. The money flow is real: seats, the bonus, the payout and the refunds are
transactions in Circle's testnet USDC on NEAR testnet, at prices scaled down 10,000 times (a seat
at 0.00018 USDC stands for 1.80 USDC per GPU-hour).

The root README's [testnet walk-through](../../README.md#c-near-testnet) runs the commands below,
all but `run` and `keys from-seed`, with the output they print.

## Running it

```bash
pnpm --filter @quorum-on-near/swarm swarm <command>
# or, from the repository's root:
node apps/swarm/src/main.ts <command>
```

It reads `QUORUM_*` variables from the environment and from `apps/swarm/.env`, wherever it is started
from; the environment wins. Copy [`.env.example`](.env.example) to `.env` and set
`QUORUM_PARENT_ACCOUNT`, the one required value (see [Configuration](#configuration)).

## Commands

| Command | Lock | What it does |
|---|---|---|
| `setup` | Yes | Creates, funds and registers every account; sends nothing when all is in place |
| `open <fills\|fails>` | Yes | Opens the scenario's pool as the provider |
| `run <pool-id> <fills\|fails>` | Yes | Runs the 20 scripted buyers against the pool, or resumes them on it |
| `check <pool-id> <fills\|fails>` | No | Waits until the pool has ended, then checks what the chain holds |
| `demo <fills\|fails>` | Yes | `setup`, `open`, `run`, then `check` against the balances read before the pool opened |
| `env <gateway\|mcp>` | No | Writes `apps/<gateway\|mcp>/.env` from this configuration, never over a file |
| `keys from-seed [--gateway-env <path> \| --parent-key]` | No | Writes every missing key file from one seed phrase |
| `reset` | Yes | Sends each buyer's and the provider's surplus back to the funding account |
| `help` (also `--help`, `-h`) | No | Prints the usage |

Each command takes exactly its arguments. A pool id is a non-negative integer; pools are numbered
from 0 on a new pools contract. Every command but `env`, `keys` and `help` first checks that the RPC
serves the chain `QUORUM_NETWORK` names (`testnet` for `near:testnet`, any non-public chain for
`near:sandbox`), and runs nothing if not.

### `swarm setup`

Idempotent, and safe before every run. It reads and checks everything first, and sends nothing, and
writes no key file, until every check has passed. Then:

1. **Creates** each missing direct sub-account of the parent, with its NEAR amount as its balance and
   a fresh key, written to its key file before the transaction is sent. A key left by an interrupted
   run is reused. The relayer gets `QUORUM_RELAYER_KEY_COUNT` full-access keys (4 by default).
2. **Tops up NEAR** from the parent: each existing account once it holds less than 90% of its amount.
   Once the pools contract holds code, it goes instead by the NEAR free of the contract's storage,
   back to `QUORUM_POOLS_FREE_NEAR` once less than 90% of that is free.
3. **Deploys the pools contract** from `QUORUM_POOLS_WASM` if its account holds no code, initialised
   with the configured token. If it holds code, setup checks that its `get_token` is that token.
4. **Registers** the funding account, the pools contract, the provider and every buyer on the token
   (`storage_deposit`, paid by the parent, at the token's `storage_balance_bounds`).
5. **Tops up tokens** from the funding account: each buyer to `QUORUM_BUYER_BUDGET`, the provider to
   `QUORUM_PROVIDER_BONUS_FUNDS`. If the funding account cannot cover every top-up, it makes none
   and stops. Then it clears the MCP server's spend total.

Before sending, it checks that the parent holds, free of its storage, what steps 1, 2 and 4 send plus
a margin for gas: 0.1 NEAR, plus 0.008 NEAR per account it creates, plus 0.02 NEAR per call in its
largest batch (up to 10). With the defaults on testnet, a first setup sends 8.58 NEAR and keeps a
0.5 NEAR margin. Calls are batched at most 10 to a transaction, 20 Tgas each, and each write waits
until it is final. A write that gets no result stops setup with an error that names the transaction:
run setup again once it is final.

It prints one line per action (`wrote key file  …`, `created  …  0.05 NEAR  tx …`, `topped up  …`,
`deployed the pools contract  …  token …  tx …`, `registered on the token  …  tx …`,
`sent tokens  … +10000, …  tx …`, `cleared the spend total of …`), or `nothing to do`.

### `swarm open <fills|fails>`

Opens the scenario's pool as the provider: sends the bonus to the pools contract with
`ft_transfer_call` and an `open` message (seat price, target, deadline, seats per buyer, terms). The
deadline is the latest final block's time plus the scenario's duration, since the contract measures
deadlines in block time. It prints:

```text
opened pool 0 (fills): 192 seats at 180, bonus 1728, deadline 2026-…Z  tx …
```

**One open pool at a time.** Each buyer's budget covers one pool, so `open` sends nothing while the
provider has a pool that is Open, read at optimistic finality; the refusal names it and says that
`swarm run <pool-id> <fills|fails>` resumes its buyers. The bonus transfer is sent once, never signed
again. If it gets no result, or its nonce was taken, the error names the transaction and says that a
pool may have opened: wait until it is final, then run `open` again. It also fails if the contract
logged no `pool_opened` event or the token did not keep the whole bonus.

### `swarm run <pool-id> <fills|fails>`

Runs the 20 scripted buyers against the pool, all at once (see [Scripted buyers](#scripted-buyers)).
Before any buyer acts, it reads every buyer's key file and the pool from the pools contract
(`get_pool`), and stops, sending nothing, if a key file is missing, the contract has no such pool, or
the pool's seat price is not the scenario's (180 for `fills`, 320 for `fails`). The buyers go by the
pool's deadline and seat price on chain, never by the gateway's word.

It prints `pool 0 (fills): 20 buyers arrive over 120 s`, one line per buyer step as it happens, then
a table of the outcomes and a line of totals:

```text
buyer-01  arrives after 37.4 s: seat price 180, top price 400: wants 24 seats
buyer-01  offered 24 seats for 4320
buyer-01  paid 24 seats  tx …
…
buyer     outcome     seats  paid  detail
buyer-01  credential     24  4320  pool filled
…
192 seats, 34560 paid: credential 14, declined 6
```

The counts depend on the order of arrival: a buyer that arrives once the pool has filled ends
`missed` instead.

**Resuming.** Run again on the same pool, each buyer first asks the gateway what it holds: a buyer
that holds seats follows them and never buys again.

### `swarm check <pool-id> <fills|fails>`

Waits until the pool has ended, then checks what the chain holds (see [What `check` verifies](#what-check-verifies)).
It prints one line per check, `ok    <check>: <figures>` or `FAIL  <check>: <figures>`, then
`pool 2: 6 checks passed` on standard output, or `pool 2: 1 of 6 checks failed` on standard error.

### `swarm demo <fills|fails>`

Runs `setup`, `open`, `run` and `check` under one lock, printing `--- setup`, `--- open <scenario>`,
`--- run pool <id>` and `--- check pool <id>` before each step. It refuses before setup if the provider
has a pool Open. After setup and before the pool opens, it reads the provider's, the pools contract's
and every buyer's token balance, as the baseline of the check's balance lines. It passes the
transactions the buyers learned to the check, since the gateway's feed records no relay whose result
was unknown. It stops at the first step that fails.

### `swarm env <gateway|mcp>`

Writes the other app's `.env` from the swarm's configuration, so that a shared value is the same in
every app. Neither command reads the chain. Each writes a new file, readable by its owner only on
POSIX systems, never over an existing one, and refuses a value that the env-file parser would not
read back unchanged (such as a URL holding `#`), naming the variable but not the value.

| File | Holds |
|---|---|
| `apps/gateway/.env` | The shared values (network, RPC URL, gateway URL, parent, token, pools account), the relayer and provider accounts, every key in the relayer's key folder (`QUORUM_RELAYER_KEYS`), a newly generated credential key (`QUORUM_CREDENTIAL_JWK`), the commit gas bounds and the block time. **Secret**: never share or commit it |
| `apps/mcp/.env` | The shared values, the block time, the buyer's payment life, the MCP account, the key files' folder, the spend file, and a spend cap equal to `QUORUM_BUYER_BUDGET`. It holds no key |

It prints `wrote <path>`. On Windows, where a file's mode is not applied, `env gateway` also prints
the `icacls` command that gives the current user alone access to the file.

### `swarm keys from-seed [--gateway-env <path> | --parent-key]`

Derives every key from one BIP-39 phrase of 12 or 24 words, read from `QUORUM_SEED_PHRASE` or from
the file `QUORUM_SEED_PHRASE_FILE` names (an absolute path; set one of the two). Keys are ed25519,
derived by SLIP-10 under `m/44'/397'`, each path chosen by the account's role:

| Account | Path |
|---|---|
| Parent | `m/44'/397'/0'` (NEAR's standard path) |
| Funding (unless it is the parent) | `m/44'/397'/1'` |
| Pools | `m/44'/397'/2'` |
| Provider | `m/44'/397'/3'` |
| Relayer key 0 to 89 | `m/44'/397'/10'` to `m/44'/397'/99'` |
| `buyer-01` to `buyer-20` | `m/44'/397'/101'` to `m/44'/397'/120'` |
| MCP buyer | `m/44'/397'/199'` |
| Gateway credential key | `m/44'/397'/900'` |

It refuses an account that is not a direct sub-account of the parent (only the funding account may
be the parent itself) and a relayer key count outside 1 to 90. It checks the chain before writing
anything: the parent's key must be a full-access key of the parent, and each other account that
exists must hold its keys (one that does not exist yet is skipped; setup creates it). It then writes
each missing key file, leaves alone one that holds the same key, and refuses one that holds another.
It prints one line per key, `<account>  <public key>`, then `credential  <x>`; never the phrase or a
private key. Run again, it changes nothing.

- `--gateway-env <path>`, an absolute path, also writes the gateway's two secrets there
  (`QUORUM_RELAYER_KEYS`, `QUORUM_CREDENTIAL_JWK`).
- `--parent-key` prints the parent's public key only, and reads no chain and no other configuration:
  use it to create the parent account with that key.

### `swarm reset`

Returns to the funding account whatever each buyer and the provider holds above its configured
token amount: the provider's takings from settled pools, the bonus shares buyers received from
refunded pools. Each account signs its own `ft_transfer`. It moves balances only: it never calls
`claim_refund`, and money a pool still holds is not counted. It stops at the first error; the
transfers made before it stand. It prints `<account>  returned <amount> to <funding>  tx …` per
transfer, or `nothing to do`. Once every pool has ended, and if the funding account covers the
top-ups, a reset followed by a setup leaves each buyer and the provider at exactly its amount.

## Exit codes

| Code | When |
|---|---|
| 0 | Done |
| 1 | Invalid configuration, an RPC on another chain, a command that failed, a check that failed, another swarm holding the lock, or (`run`, `demo`) a buyer that did not end as the scenario expects |
| 2 | Usage error: no command, an unknown one, or wrong arguments; the usage follows the problem |

A buyer that did not end as expected is printed on standard error:
`<buyer> ended <outcome> with <n> seats (<detail>); <scenario> expects <expected>`. A buyer whose top
price is at or above the seat price must end `credential` or `missed` in `fills`, and `refunded` in
`fails`; every other buyer must hold no seats. No other outcome, such as a buyer declining, changes
the exit code.

Errors are printed as their message and their causes', never with a stack, and with the RPC URL
written as `QUORUM_RPC_URL`, since it may carry an API key.

## The lock

`setup`, `open`, `run`, `demo` and `reset` hold a lock while they run, so that two swarms never sign
with the same keys or top up the same accounts at once. `demo` holds one lock across its steps;
`check`, `env`, `keys` and `help` take none.

- The lock is a file, `swarm-<chain>-<parent>.lock` (such as
  `swarm-testnet-quorum-parent-4821.testnet.lock`), in `QUORUM_SWARM_LOCK_DIR` (`data/` at the
  repository's root by default, gitignored). It holds the process's PID.
- While it exists, those commands run nothing and exit with 1: `another swarm is running: <path> is
  held by process <pid>`. A swarm stopped by force leaves its file: remove it by hand.
- On SIGINT or SIGTERM, the swarm removes the lock, then raises the same signal again, so the process
  ends by it (a shell reports 130 or 143; on Windows the exit code is 1). A second signal of the same
  kind ends it at once.
- A lock that cannot be removed is reported on standard error, and does not change the command's
  result.

## Accounts and funding

Every account is a direct sub-account of the parent, `QUORUM_PARENT_ACCOUNT` (written `<parent>`),
which pays their NEAR. Each account has one role: the configuration refuses two roles, or a role and
a scripted buyer, naming the same account, and only the funding account may be the parent itself.

| Account | Default | NEAR (setup's amount) | On the token | Token amount |
|---|---|---|---|---|
| Funding | `funding.<parent>` | 0.5 (none when it is the parent) | Yes | The source of the token |
| Pools contract | `pools.<parent>` | 3.5 until deployed, then 1 free of storage | Yes | Holds the pools' money |
| Relayer and keeper | `relay.<parent>` | 3, with 4 full-access keys | No | None |
| Provider (simulated seller) | `provider.<parent>` | 0.5 | Yes | 10,000 (bonus funds) |
| Scripted buyers | `buyer-01.<parent>` to `buyer-20.<parent>` | 0.05 each | Yes | 10,000 each (budget) |
| MCP server's buyer | `buyer-llm.<parent>` | 0.05 | Yes | 10,000 (budget) |

Setup creates only direct sub-accounts of the parent; any other account, such as a funding account
outside it, must exist and have a key file. Key files follow near-cli's layout,
`<QUORUM_CREDENTIALS_DIR>/testnet/<account>.json` (`sandbox/` for `near:sandbox`); the relayer also
has a folder `<QUORUM_CREDENTIALS_DIR>/testnet/relay.<parent>/` with one file per key. A buyer holds
only its own budget, so a leaked buyer key can lose at most that.

**Funding the token, by hand.** The funding account is the only source of USDC. Circle's faucet has
no API for NEAR testnet: open <https://faucet.circle.com>, choose USDC and NEAR Testnet, enter the
funding account (`funding.quorum-parent-4821.testnet`), pass the human check and send. A first setup
stops after it has created and registered the funding account, with:

```text
the funding account funding.quorum-parent-4821.testnet holds 0 base units of the token 3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af, but the top-ups need 220000: send it 220000 more, then run setup again
```

Run setup again once the grant has arrived. The top-ups are small: 10,000 base units (0.01 USDC)
for each of 21 buyers and the provider, 0.22 USDC in all, so one grant covers many runs. Each later
setup refills from the funding account what the last run moved out of an account. No pool holds,
and no run moves, as much as 0.1 USDC.

## Scenarios

Both scenarios sell a block of 8 GPUs for 24 hours as 192 one-GPU-hour seats, with a bonus of 5% of
the block's price, and the terms `8×GPU × 24 h; 1 seat = 1 GPU-hour; prices at 1/10,000 scale`.
Amounts are in base units (USDC has 6 decimals).

| Scenario | Seat price | Bonus | Target | Deadline | Arrival spread | Seats per buyer | Expected end |
|---|---|---|---|---|---|---|---|
| `fills` | 180 (0.00018 USDC) | 1,728 | 192 | 600 s | 120 s | at most 24 | Settled |
| `fails` | 320 (0.00032 USDC) | 3,072 | 192 | 180 s | 60 s | at most 24 | Refunded |

`QUORUM_SCENARIO_DEADLINE_SECONDS` and `QUORUM_SWARM_SPREAD_SECONDS` replace every scenario's deadline
and arrival spread when set. At 180 a seat, the buyers who accept the price want 200 seats for the
192, so the pool fills and the last to arrive get a reduced offer or none. At 320 they want 100, so
the pool expires and each seat gets its 320 back plus 30 of the bonus (3,072 over 100 seats, rounded
down); the 72 left goes back to the seller as dust.

## The 20 buyer profiles

Each scripted buyer has the seats it wants and a top price per seat. No buyer wants more than the
pools' 24 seats per buyer, and none spends more than its 10,000 budget at its top price.

| Top price | Buyers | Seats each | Seats in all | `fills` (180) | `fails` (320) |
|---|---|---|---|---|---|
| 400 | `buyer-01` to `buyer-06` | 24, 20, 18, 16, 12, 10 | 100 | Commits | Commits |
| 250 | `buyer-07` to `buyer-14` | 18, 16, 14, 14, 12, 10, 8, 8 | 100 | Commits | Declines |
| 150 | `buyer-15` to `buyer-20` | 12, 10, 8, 6, 4, 2 | 42 | Declines | Declines |

In `fills`, a buyer that arrives after the pool has filled ends `missed`, whatever its top price.

## Scripted buyers

Each buyer runs on its own, in one process with the others:

1. **Arrives** after a random delay, uniform in `[0, spread)`.
2. **Lists the pools** (`GET /pools`), asking again after a 503 or a failed request, 3 times in all. A
   pool that is not listed, as a full one is not, is still asked for an offer, whose answer says why.
3. **Applies its rule**: a listed pool whose seat price on chain is above its top price is
   `declined`. Otherwise it wants its seats.
4. **Redeems once before each payment**, to learn whether it already holds seats. `no_seats` lets it
   pay; seats held (`202`, `200` or `410`) are followed to the end without paying again. A 503 or a
   failed request is asked again, 3 redemptions in all, after which it ends `failed`, having paid
   nothing.
5. **Pays.** It asks for the offer for its seats and pays it, on a spending limit of the offered
   seats at its top price, so a reduced offer above its top price is declined with nothing signed.
   It makes at most **3 paying attempts**, each with a fresh offer and a new payment, waiting 2
   seconds times the attempts made so far before the next. A new attempt follows a 503, a failed
   answer to the offer request, a payment that was never sent, a `402` `expired` or
   `nonce_too_large`, and a `502 relay_failed` (which took no seats). After a `402 pool_closed` it
   asks for the offer again at once: a 409 ends it `missed`, a 410 `expired`. Any other `402` ends it
   `refused`; a key that is not on its account ends it `failed`.
6. **After a payment that may still land** (no documented answer, `502 result_unknown`, or a `402`
   `payment_in_flight` or `stale_nonce`), it signs nothing and redeems each interval, following seats
   if they appear. Once a redemption made after a final block above the payment's
   `max_block_height` plus 20 still finds none, nothing can land, and its next attempt pays.
7. **Follows its seats.** After a `202`, it redeems every `QUORUM_REDEEM_INTERVAL_MS` (5 seconds by
   default, plus up to a tenth of it in jitter), the first poll one interval after the payment. It
   keeps polling through `202`, `410 refund_pending`, 503 and failed requests, and ends on a `200`
   (credential) or a `410` `refunded` or `claimable`. A `refunded` that names no refund transaction
   is asked again up to 3 more times, since the keeper's call may still be running. It gives up 5
   minutes after the pool's deadline on chain, by its own clock.

**Outcomes.** Each buyer ends with one of:

| Outcome | Meaning |
|---|---|
| `credential` | The pool filled; the buyer holds a credential for its seats (never printed: it is a bearer token) |
| `refunded` | The pool expired, and its refund arrived |
| `claimable` | The pool expired, and the pushed refund failed: the buyer can claim it |
| `declined` | The seat price is above its top price, or its own check refused the offer |
| `missed` | No seat was left for it |
| `expired` | The pool expired before its payment could take a seat |
| `refused` | The gateway refused the payment, for good or after every attempt |
| `failed` | The relay failed on every attempt, nothing landed, its proof was refused, or the gateway or the chain could not be used |
| `timed_out` | No final answer by 5 minutes after the pool's deadline |

With the outcome, each buyer reports the seats it holds as the gateway last reported them, what they
cost at the pool's seat price, and every transaction the gateway named to it. A log line names a
failure in the buyer's own words, with at most an HTTP status or an errno code.

## What `check` verifies

`check` first waits, reading the pool every 2 seconds, until it is Settled or Refunded and the
gateway's activity feed holds the keeper transaction that ended it. It gives up 5 minutes after the
pool's deadline (in block time). Each read after the wait is tried 3 times, 2 seconds apart. Then:

| Check | Passes when |
|---|---|
| `status` | The pool's status is the scenario's expected end: `settled` for `fills`, `refunded` for `fails` |
| `reads` | Only shown, as a failure, when the last read before the limit failed |
| `buyers` | Settled: every buyer is `committed`, their seats adding up to `taken`. Refunded: every buyer is `refunded` |
| `refunds and dust` | Refunded only: each buyer's refund in the feed is its seats × (seat price + bonus per seat), the dust record is the bonus less the shares, and refunds plus dust equal `taken × seat price + bonus` |
| `solvency` | The pools contract's token balance covers what every pool still owes, all read at one final block |
| `provider balance`, `pools contract balance`, `buyer balances` | `demo` only, against its baseline: Settled, the seller `+taken × price` and each buyer `−seats × price`; Refunded, the seller `−(bonus − dust)` and each buyer `+seats × bonus per seat`; the pools contract unchanged |
| `commit gas` | Each relayed commit burnt at most `QUORUM_COMMIT_MIN_GAS` in its token and pools receipts, and every swarm buyer holding seats has a commit measured |
| `payout gas` | Each `ft_transfer` and callback of the keeper's `settle`, `refund` and dust transactions burnt under 5 Tgas, at least one `ft_transfer` was made, and every refunded swarm buyer has its refund recorded |

The `buyers`, `refunds and dust` and balance checks need the pool ended, and are left out if it has
not; `solvency` and the two gas checks always run. So
`swarm demo fills` prints 8 checks, `swarm demo fails` 9, and `swarm check` on a refunded pool,
without a baseline, 6. The checks follow section 10 of the
[design spec](../../docs/specs/2026-11-09-quorum-on-near-design.md#10-testing).

## Configuration

Every variable, with its default, is in [`.env.example`](.env.example). The swarm lists every missing
or invalid variable at once, and a problem with a URL never quotes the URL. Values shared with the
gateway and the MCP server must be the same in each app: `swarm env` writes them out.

| Variable | Default | Meaning |
|---|---|---|
| `QUORUM_PARENT_ACCOUNT` | **Required** | The parent: every other account is created under it, and it pays their NEAR |
| `QUORUM_NETWORK` | `near:testnet` | `near:testnet`, or `near:sandbox` for a local chain |
| `QUORUM_RPC_URL` | `https://test.rpc.fastnear.com` | The NEAR RPC endpoint. May carry an API key; never quoted |
| `QUORUM_GATEWAY_URL` | `http://localhost:8402` | Where the gateway is reached, written exactly as the gateway's own: its host is the recipient that redemption proofs name |
| `QUORUM_TOKEN_ACCOUNT` | `3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af` (Circle's testnet USDC) | The token the pools contract is initialised with |
| `QUORUM_POOLS_ACCOUNT` | `pools.<parent>` | The pools contract |
| `QUORUM_BLOCK_TIME_MS` | `1000` | Turns an offer's timeout into blocks; the gateway's value |
| `QUORUM_RELAYER_ACCOUNT` | `relay.<parent>` | The account that relays payments and pays their gas |
| `QUORUM_PROVIDER_ACCOUNT` | `provider.<parent>` | The simulated seller, which opens the pools |
| `QUORUM_COMMIT_MIN_GAS` | `50000000000000` (50 Tgas) | The least gas a payment's `ft_transfer_call` may attach; the check fails a commit that burns more |
| `QUORUM_COMMIT_MAX_GAS` | `100000000000000` (100 Tgas) | The most gas it may attach: from the minimum to 300 Tgas |
| `QUORUM_BUYER_MAX_TIMEOUT_SECONDS` | `120` | The longest a payment a buyer signs stays valid, 30 to 3600 seconds |
| `QUORUM_CREDENTIALS_DIR` | `~/.near-credentials` | Absolute path of the folder of key files, in near-cli's layout |
| `QUORUM_MCP_ACCOUNT` | `buyer-llm.<parent>` | The MCP server's buyer, which setup creates and funds |
| `QUORUM_MCP_SPEND_FILE` | `data/mcp-spend.json` at the repository's root | Absolute path of the MCP server's spend total, which setup clears |
| `QUORUM_FUNDING_ACCOUNT` | `funding.<parent>` | The only source of the token; any account with a key file, the parent included |
| `QUORUM_POOLS_WASM` | unset | Absolute path of the pools contract's wasm file; needed only when setup deploys it |
| `QUORUM_RELAYER_KEY_COUNT` | `4` | The full-access keys setup gives the relayer when it creates it |
| `QUORUM_BUYER_NEAR` | `0.05` | NEAR each buyer is topped up to |
| `QUORUM_PROVIDER_NEAR` | `0.5` | NEAR the provider is topped up to |
| `QUORUM_FUNDING_NEAR` | `0.5` | NEAR the funding account is topped up to; not used when it is the parent |
| `QUORUM_RELAYER_NEAR` | `3` | NEAR the relayer is topped up to |
| `QUORUM_POOLS_NEAR` | `3.5` | The pools account's NEAR at creation, and its target until the contract is deployed |
| `QUORUM_POOLS_FREE_NEAR` | `1` | Once deployed, the NEAR setup keeps on the pools contract beyond what its storage locks |
| `QUORUM_BUYER_BUDGET` | `10000` | The token balance each buyer is topped up to and reset brings it back to, in base units |
| `QUORUM_PROVIDER_BONUS_FUNDS` | `10000` | The provider's token balance, likewise |
| `QUORUM_SCENARIO_DEADLINE_SECONDS` | unset | Replaces every scenario's deadline, in seconds |
| `QUORUM_SWARM_SPREAD_SECONDS` | unset | Replaces every scenario's arrival spread, 0 to 2147483 seconds; 0 makes every buyer arrive at once |
| `QUORUM_REDEEM_INTERVAL_MS` | `5000` | How often a scripted buyer polls its redemption, 1 to 2147483647 ms |
| `QUORUM_SWARM_LOCK_DIR` | `data/` at the repository's root | Absolute path of the folder of the lock files |
| `QUORUM_SEED_PHRASE` | unset | `keys from-seed` only: the BIP-39 phrase. Not in `.env.example` |
| `QUORUM_SEED_PHRASE_FILE` | unset | `keys from-seed` only: absolute path of a file holding the phrase; set this or `QUORUM_SEED_PHRASE`. Not in `.env.example` |

NEAR amounts are decimal numbers of NEAR; token amounts are base units. The full list of settings,
with what each app reads, is section 7.6 of the
[design spec](../../docs/specs/2026-11-09-quorum-on-near-design.md#76-configuration).

## Tests

```bash
pnpm --filter @quorum-on-near/swarm test        # unit tests, no network
pnpm --filter @quorum-on-near/swarm typecheck
pnpm --filter @quorum-on-near/swarm test:sandbox
```

**Unit tests** (`test/*.test.ts`) run on any OS against a fake chain and stubs: command parsing and
exit codes, the configuration, the accounts, setup, open, reset, the profiles and scenarios, each
scripted buyer's steps and outcomes, the run's summary and expectations, the check's figures and gas
measures, the lock, the env files, seed derivation and `keys from-seed`, and the RPC chain's reads.
Two suites check the buyer package against the gateway: one against the gateway's sources, one
against its real HTTP app with no network between them.

**The sandbox suites** (`test/sandbox/`) start a local NEAR sandbox and the real gateway:
`demo.test.ts` runs a first setup that stops on the token shortfall and then completes, the `fills`
scenario settling with every check passing, `swarm demo fails` through the command line exiting 0,
a second setup sending nothing, and reset then setup bringing every account back to its amount;
`sandbox.test.ts` checks that the sandbox keeps enough history and stops cleanly. They end with
`Test Files  2 passed (2)` and `Tests  9 passed (9)`, and need:

- Linux (x86_64, aarch64), macOS on Apple silicon, or WSL2, with glibc 2.38 or later; on Windows the
  suites report themselves skipped;
- the contracts built with `cargo near`, and `QUORUM_POOLS_WASM` and `QUORUM_MOCK_USD_WASM` set to the
  absolute paths of their wasm files; without them the suites fail, naming both.

The sandbox uses Mock USD (`mUSD`), a token for the tests only. The root README's
[local sandbox](../../README.md#b-a-local-sandbox) section gives the build commands. CI does not run
these suites.
