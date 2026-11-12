# Quorum on NEAR: hosted demo

> **Status: draft.** This spec extends the design spec,
> [`2026-11-09-quorum-on-near-design.md`](2026-11-09-quorum-on-near-design.md) ("the design spec"
> below). It describes a public deployment of the gateway and the live page on NEAR testnet, and the
> features that deployment needs. It builds on the swarm, the MCP server and the live page as their
> plans, [`swarm-mcp.md`](../plans/swarm-mcp.md) and [`live-page.md`](../plans/live-page.md),
> describe them. Some design spec sections cited here are as those plans edit them. Section 11 lists
> the design spec's sections this spec changes.

## 1. Summary

The gateway and the live page run on one public machine on Fly.io, against NEAR testnet. A visitor
opens the page and watches the provider's latest pool. A visitor can also start a run of the swarm
with a button, either a pool that fills or a pool that fails, and watch it from its first seat:

- **One run at a time.** The first click starts a run. Any later click while it is in progress is
  told so, and the page follows the running pool either way.
- **One secret.** Every testnet account of the deployment, and the gateway's credential key, is
  derived from one BIP-39 phrase. The host holds that phrase and nothing else secret.

The provider and the GPU access stay simulated, as everywhere in this system (design spec, section
1). The money flow of every run is real, in Circle's testnet USDC.

## 2. Scope

**In scope**

- `swarm keys from-seed`: every key file the swarm reads, derived from one phrase (section 3).
- An opt-in demo endpoint on the gateway that starts the swarm's `demo` command (section 4).
- Two buttons and a demo status line on the live page, shown only when the endpoint is on (section
  5).
- The gateway serving only the page's own files (section 6).
- A Dockerfile, a start script and a Fly.io configuration, and how the deployment is bootstrapped
  and run (section 7).

**Out of scope** (not built)

- Mainnet, as in the design spec.
- More than one machine or region.
- Alerting. A failed run shows on the page and in the logs (section 7.6).
- Authentication or per-visitor rate limiting of the demo endpoint. One run at a time, a daily cap
  and a maximum run time bound it (section 4).
- Scheduled runs: a run starts only when someone asks for one.
- Automated faucet funding (design spec, section 2).

## 3. Accounts and keys

### 3.1 One phrase

The deployment has its own parent account, used for nothing else, and the accounts of the design
spec's section 7.1 under it. Runs started elsewhere with other keys therefore never share its
accounts. Every account the deployment signs with is a direct sub-account of the parent
(`<name>.<parent>`); only the funding account may be the parent itself.

Every key is derived from one **BIP-39 English phrase** of 12 or 24 words:

- **Seed:** PBKDF2-HMAC-SHA512 of the phrase (normalised to NFKD), with the salt `mnemonic`
  followed by the passphrase, 2,048 iterations, 64 bytes (BIP-39). The command always uses an empty
  passphrase; the function takes one so that BIP-39's published vectors can be tested.
- **Keys:** SLIP-10 for ed25519 from that seed, every level hardened, under NEAR's prefix
  `m/44'/397'`. The parent's path is NEAR's standard `m/44'/397'/0'`, so a NEAR wallet or
  near-cli-rs given the phrase derives the same parent key.

| Key | Path |
|---|---|
| Parent | `m/44'/397'/0'` |
| Funding account | `m/44'/397'/1'` (the parent's key when the funding account is the parent) |
| Pools account | `m/44'/397'/2'` |
| Provider | `m/44'/397'/3'` |
| Relayer key `i`, from 0 | `m/44'/397'/(10 + i)'`; the relayer key count must be 1 to 90 |
| Scripted buyer `buyer-NN` (01 to 20) | `m/44'/397'/(100 + NN)'` |
| The MCP server's buyer | `m/44'/397'/199'` |
| The gateway's credential key | `m/44'/397'/900'` |

An account's name comes from the swarm's configuration, as setup reads it. Its key comes from its
role in the table, never from its name.

### 3.2 `swarm keys from-seed`

A swarm command, `swarm keys from-seed [--gateway-env <path> | --parent-key]`, uses Node's built-in
crypto only.

- **The phrase** comes from `QUORUM_SEED_PHRASE`, or from the file that `QUORUM_SEED_PHRASE_FILE`
  names. The command refuses when both variables or neither is set. The phrase's words are split on
  whitespace, lowercased and joined with single spaces before the seed is computed, so line breaks
  and extra spaces do not change the keys. It must have 12 or 24 words. The BIP-39 wordlist and
  checksum are not checked: the chain check below is what catches a wrong phrase. The phrase is
  never printed, logged, or put in an error message.
- **`--parent-key`** needs only the phrase. It prints the derived parent public key and exits,
  reading no chain, no configuration and no file, so it can run before the parent account exists
  (section 7.5, step 2).
- **The accounts** come from the swarm's configuration. The command refuses (exit 1, naming the
  setting) an account that is neither a direct sub-account of the parent nor, for the funding account
  only, the parent itself, and a relayer key count outside 1 to 90.
- **Then a check against the chain**, before anything is written:
  - It checks the RPC's chain id, as the swarm's commands that read the chain do (design spec,
    section 7.6).
  - The derived parent key must be a **full-access** key of `QUORUM_PARENT_ACCOUNT`
    (`view_access_key`, optimistic finality). Otherwise the command exits 1, saying that the phrase
    does not hold a full-access key of that account.
  - Every other account that already exists must hold each of its derived keys, and the relayer must
    hold each of its configured number of keys. Otherwise the command exits 1, naming the account
    and the missing public key. An account that does not exist yet is skipped: setup creates it with
    its derived key.
  - If the RPC cannot be read, the command exits 1.
- **The key files.** Under `QUORUM_CREDENTIALS_DIR`, it writes every account's key file in the
  layout the swarm reads (design spec, section 7.1). The relayer gets its key folder with the
  configured number of keys, and the first key is also in its key file. A file is written only if
  it is new: created exclusively, mode `0600`, flushed. A file that already holds the same key is
  left alone; a file that holds a different key stops the command (exit 1, naming the file) and is
  never overwritten. Running it again therefore changes nothing.
- **`--gateway-env <path>`** also writes an env file holding `QUORUM_RELAYER_KEYS` (the relayer's
  keys, in path order) and `QUORUM_CREDENTIAL_JWK` (the private Ed25519 JWK of the credential key):
  - It is formatted as the swarm's gateway env file is, and read back with Node's env file parser
    before it is written.
  - It is created exclusively, mode `0600`. An existing file with the same content is left alone;
    one with different content stops the command (exit 1).
  - The same phrase always gives the same credential key, so a credential issued before a restart
    still verifies after it.
- **Its output** is one line per key: the account id and the public key. The relayer has one line
  per key, and the credential key's line reads `credential` and its public key. No private key and
  no part of the phrase is printed.

The swarm's setup reuses a key file left for an account it has not yet created. So when the command
runs before the first setup, setup creates each account with its derived key.

### 3.3 Where the keys live

- **On the host:** the phrase, in one secret. At each boot the start script writes the key files
  and the gateway's env file to `/run/quorum` on the machine's ephemeral disk, never to the volume.
  It then starts the gateway with the phrase removed from its environment (section 7.2), so the
  internet-facing process never holds the phrase.
- **On the operator's machine:** the phrase, in a file of mode `0600` outside the repository folder,
  which `QUORUM_SEED_PHRASE_FILE` names. The credentials folder used for the bootstrap is also
  outside the repository folder, so no key can enter an image build.

## 4. The demo endpoint

### 4.1 Configuration

| Variable | Meaning |
|---|---|
| `QUORUM_DEMO_COMMAND` | A JSON array of strings: the program to start and its first arguments; the gateway appends the scenario. The program must be the run itself, for example `node` with the swarm's entry file and `demo`, never a shell or a package manager, which would not pass signals on. Unset or empty: the demo is off. A value that is not a non-empty array of non-empty strings: the gateway refuses to start, naming the variable |
| `QUORUM_DEMO_MAX_RUNS_PER_DAY` | 1 to 1,000, default 100. Runs started per UTC day, counted in memory |
| `QUORUM_DEMO_MAX_RUN_SECONDS` | 60 to 7,200, default 1,800. A run still going after this long is stopped (section 4.3) |

### 4.2 Routes

| Route | Answer |
|---|---|
| `POST /demo/fills`, `POST /demo/fails` | See the order below |
| `GET /demo` | Demo off: `404`. Otherwise `200` `{running, scenario, startedAt, last, runsToday, maxRunsPerDay}`. `scenario` and `startedAt` are `null` when no run is in progress. `last` is `{scenario, startedAt, endedAt, exitCode, signal}` for the last finished run, or `null`: `exitCode` is the exit code of a run that exited, `signal` the signal that ended one that did not, and both are `null` for a program that could not be started |
| `GET /config.json` | Gains `demo`: `true` when the demo is on, `false` otherwise |

A `POST` is answered by the first of these that applies:

1. Demo off: `404`, as for any unknown route.
2. No header `X-Quorum-Demo: 1`: `403` `{error: "demo_header_required"}`. A page on another site
   cannot send this header without a CORS preflight, and the gateway answers no preflight, so a
   browser never sends that page's request. A form or a beacon from another site therefore cannot
   start a run.
3. A run in progress: `409` `{error: "demo_running", scenario, startedAt}`.
4. Today's cap reached: `429` `{error: "demo_limit"}`.
5. One of the provider's pools is Open: `409` `{error: "pool_open", poolId}`. Such a run would stop
   at once (the swarm opens no pool while one is Open), so the gateway does not start it and does
   not count it.
6. The pools cannot be read: `503` `{error: "chain_unavailable"}`.
7. Otherwise the run starts: `202` `{scenario, startedAt}`.

`startedAt` and `endedAt` are milliseconds since the epoch. The routes read no request body and send
no CORS headers.

### 4.3 A run

- **One at a time.** The slot is taken in the same synchronous step that checks it, before the
  pools are read, so two requests can never both get past step 3. Answers 5 and 6 release it.
- **Counted when started:** a `202` counts one run, including a program that then cannot be started.
- **Started without a shell:** the program and its arguments are the command's array plus the
  scenario. Its working folder is the gateway's, and its environment is the gateway's **minus**
  `QUORUM_RELAYER_KEYS`, `QUORUM_CREDENTIAL_JWK`, `QUORUM_SEED_PHRASE` and
  `QUORUM_SEED_PHRASE_FILE`. The run reads its keys from the key files of section 3.3.
- **Its output**, line by line, goes to the gateway's standard output and error, each line prefixed
  with `[demo] `. A last line without a newline is written when the output closes.
- **When it ends**, its exit code or signal is recorded as `last`, and the slot is released.
- **Maximum run time.** After `QUORUM_DEMO_MAX_RUN_SECONDS`, the gateway sends the run SIGTERM, then
  SIGKILL 10 seconds later if it has not ended. The swarm already gives up 5 minutes after its
  pool's deadline; this bound only keeps a stuck run from holding the slot forever.
- **When the gateway stops** (SIGINT or SIGTERM), it sends the run SIGTERM.
- **The run is the swarm's `demo` command** (setup, open, run, check), with all its own guards. The
  environment points the swarm at the key files and at the gateway's public URL, which is the URL the
  buyers sign their proofs for (design spec, section 6.5).

## 5. The live page

When `/config.json` has `demo: true`, the page shows two buttons, **"Start a pool that fills"** and
**"Start a pool that fails"**, and a **demo line**. The demo line is separate from the page's own
status line, which keeps showing when the page last refreshed. With `demo: false`, or on a gateway
without the endpoint, the page shows neither, and is as the design spec's section 8 describes.

- **Every refresh** (2 seconds) also reads `GET /demo`. The buttons are disabled while a run is in
  progress, when today's cap is reached, and when `GET /demo` cannot be read.
- **A click** first removes `?pool=` from the page's URL, so that the page follows the provider's
  newest pool (design spec, section 8). It then sends the `POST` with the header `X-Quorum-Demo: 1`.
- **The demo line** shows the first of these that applies:
  1. For 10 seconds after a click, the answer to it:
     - `202`: "A run started. Its pool appears here once it opens."
     - `409` `demo_running`: "A run is already in progress. This page follows its pool once it
       opens."
     - `409` `pool_open`: "A pool is still open. This page shows it."
     - `429`: "The demo has reached its limit for today."
     - any other answer: "The demo is not available right now."
     - no answer: "The gateway could not be reached."
  2. `GET /demo` cannot be read: "The demo's status is unavailable."
  3. A run in progress: "A `<scenario>` run started at `<time>` is in progress."
  4. Today's cap reached: "The demo has reached its limit for today."
  5. The last run exited with code 0: "The last run (`<scenario>`) ended at `<time>`."
  6. The last run ended any other way: "The last run ended with an error. Its testnet funds may need
     a refill."
  7. No run yet: "Start a run to watch a pool from its first seat."
- **Still read-only toward the chain.** The page never signs anything and needs no wallet. It only
  asks the gateway to start a run.

## 6. The gateway's static files

From the live page folder, the gateway serves exactly `/` (as `index.html`), `/index.html`,
`/app.js`, `/totals.js` and `/style.css`, and answers `404` for every other path. The path is matched
after percent-decoding, so `/%61pp.js` serves `app.js`, and `/%2Eenv` answers `404`. This replaces
the dot-segment rule of the design spec's section 6.1, and with it the gateway's test that files in
subfolders are served. The page folder is a package, with `node_modules/`, tests and
`package.json`. None of these may be served by a gateway on a public host, so this rule must be in
place before any public deployment.

## 7. Deployment on Fly.io

### 7.1 The image

`deploy/fly/Dockerfile`, built from the repository root:

- **Runtime:** Node 22.22.2, the version CI runs, and pnpm through corepack, at the version the root
  `package.json` names.
- **Install:** `pnpm install --prod --frozen-lockfile`. Workspace packages stay links into the
  source tree. Not `pnpm deploy`: it copies them under `node_modules/`, and Node refuses to strip
  types there.
- **Sources:** the workspace's TypeScript sources, run by Node's type stripping as everywhere else.
- **No Rust toolchain and no wasm.** The pools contract is deployed during the bootstrap (section
  7.5), and setup reads the wasm only for an account without code.
- **User:** root, inside the machine's own VM. This keeps `/run/quorum` and the volume writable
  without changing ownership.

`.dockerignore` keeps out `.git/`, `target/`, every `node_modules/`, every `.env` file and `data/`.
No key file is inside the repository folder (section 3.3).

### 7.2 The start script

`deploy/fly/start.sh`:

1. Empties and recreates `/run/quorum` (mode `0700`). The deployment relies on the root disk being
   reset at each boot, which is Fly.io's default; emptying the folder also makes a restart in a
   local container start clean.
2. Runs `swarm keys from-seed --gateway-env /run/quorum/gateway.env`. `QUORUM_CREDENTIALS_DIR` comes
   from `fly.toml` only. If the command fails, the script exits with its code.
3. Replaces itself (`exec`) with the gateway, started with `/run/quorum/gateway.env` as an env file
   and with `QUORUM_SEED_PHRASE` and `QUORUM_SEED_PHRASE_FILE` removed from its environment, so the
   gateway is the process the host supervises.

### 7.3 `fly.toml`

- **Build:** the Dockerfile above.
- **Environment** (no secret here):
  - `QUORUM_NETWORK=near:testnet`, and a public RPC that allows browser requests (design spec,
    section 7.6);
  - `QUORUM_GATEWAY_URL`, the deployment's public `https://` URL;
  - `QUORUM_PARENT_ACCOUNT`;
  - `QUORUM_CREDENTIALS_DIR=/run/quorum/credentials`;
  - `QUORUM_DATA_DIR` on the volume;
  - `QUORUM_WEB_DIR`, an absolute path;
  - the three `QUORUM_DEMO_*` settings.
- **A volume** mounted at `/data`, holding the activity feed.
- **An HTTP service** on the gateway's port, with HTTPS forced at Fly.io's proxy:
  - `auto_stop_machines = "off"` and one machine always running, since the keeper and runs must keep
    going (one machine only: the volume attaches to one);
  - a `kill_timeout` long enough for in-flight relays to finish;
  - a health check on `GET /config.json`.
- **One machine**, shared CPU, 512 MB.

The exact `fly.toml` keys, and the restart policy, are checked against Fly.io's documentation when
the file is written.

### 7.4 Secrets

One: `QUORUM_SEED_PHRASE`. It is set with `fly secrets import`, which reads `NAME=VALUE` lines from
standard input. The line is produced from the phrase file by a shell builtin (`printf`), so the
phrase is never in any process's arguments or typed on a command line. Fly.io passes it to the
machine as an environment variable at boot.

### 7.5 Bootstrap

Done once, in this order:

1. **Generate a phrase** with a local, offline BIP-39 generator. Keep it in a password manager and in
   a file of mode `0600` outside the repository folder. Use it on testnet only: its parent path is
   the wallet standard, so it must never hold mainnet funds.
2. **Create the parent with the phrase's key.** `swarm keys from-seed --parent-key` prints the
   parent's public key, then
   `near account create-account sponsor-by-faucet-service <parent> use-manually-provided-public-key <key> network-config testnet create`
   creates the account. The faucet funds it with 10 NEAR.
3. **Write the keys and run the first setup** on Linux, macOS or WSL2, with the pools wasm built.
   Run `swarm keys from-seed` into a credentials folder outside the repository folder, then
   `swarm setup`. Setup creates the accounts with the derived keys, deploys the pools contract and
   registers the accounts, then stops on the funding account's token shortfall.
4. **Fund the funding account** with USDC from Circle's testnet faucet (design spec, section 7.2).
5. **Run `swarm setup` again.** It tops up the buyers and ends with nothing left to do.
6. **Rehearse locally.** Build the image and run it, passing the phrase through an env file outside
   the repository folder (never `-e`). Read `/config.json`, then start one run of each scenario
   from the page. Write down the parent's, the relayer's and the pools account's NEAR, and the
   funding account's USDC, before and after each run. **Stop the container before deploying:** two
   gateways would sign with the same relayer keys.
7. **Deploy.** Create the app and a 1 GB volume, set the secret (section 7.4), then `fly deploy`.
8. **Check** as section 9 describes.

### 7.6 Operating it

- **Refills:** NEAR's testnet faucet to the parent, Circle's testnet faucet to the funding account.
  A run that lacks NEAR stops in setup before sending anything. A run that lacks USDC stops before it
  moves any USDC or opens a pool, though setup's NEAR top-ups and registrations may already have
  been sent (design spec, section 7.2). Its output says why, and the page's demo line reports the
  failed run.
- **USDC goes round:** each run that fills moves USDC from the buyers to the provider, and setup
  refills the buyers from the funding account. `swarm reset`, run from the operator's machine when
  `GET /demo` shows no run in progress, returns those surpluses to the funding account (design spec,
  section 7.2).
- **Logs:** `fly logs` shows the gateway and every run, prefixed `[demo]`.
- **Deploys and restarts** stop a run in progress:
  - The run's pool stays Open until its deadline, and the keeper then settles or refunds it, as for
    any pool. Until then, a click is answered `409` `pool_open`.
  - The day's count, the redemption nonce cache and the in-flight holds start empty after a restart
    (design spec, sections 9 and 12).
  - A boot that fails is retried under Fly.io's restart policy. One that keeps failing, for example
    while the RPC is down, can leave the machine stopped until it is started again.
- **Taking it down:** `fly apps destroy`. The accounts and the contract stay on testnet.

## 8. Error handling

| Case | Behaviour |
|---|---|
| No phrase, both variables set, or not 12 or 24 words | `swarm keys from-seed` exits 1 with a message that does not quote the phrase; at boot, the start script exits |
| An account outside the parent, or a relayer key count outside 1 to 90 | Exit 1, naming the setting |
| The phrase does not hold a full-access key of the parent | Exit 1, nothing written |
| An existing account lacks one of its derived keys | Exit 1, naming the account and the key, nothing written |
| The RPC cannot be read at boot | Exit 1; the machine is restarted under its restart policy |
| A key file or the gateway env file holds something else | Exit 1, naming the file; nothing is overwritten |
| `QUORUM_DEMO_*` malformed | The gateway refuses to start, naming the variable |
| A `POST` without the header | `403` |
| A pool of the provider still Open | `409` `pool_open`, not counted |
| The pools cannot be read before a run | `503`, not counted |
| The program cannot be started | `202` was already sent; `last` has `exitCode` and `signal` both `null`, and the page reports the failed run |
| A run ends with an error (a shortfall, a failed check) | `last.exitCode` is its exit code; the page reports it; the output is in the logs |
| A run passes its maximum run time | SIGTERM, then SIGKILL after 10 seconds; `last.signal` records it |
| The gateway stops during a run | The run gets SIGTERM; the keeper resolves its pool at the deadline |

## 9. Testing

| What | How |
|---|---|
| `swarm keys from-seed` | Unit tests, test first. **Derivation:** SLIP-10's published ed25519 test vectors; BIP-39's reference seed vector, with its passphrase; a parent key that near-cli-rs computes from the public BIP-39 test phrase (`abandon … about`) at `m/44'/397'/0'` (only the public key is committed); the same keys from a phrase written with extra spaces, line breaks or capitals. **The phrase:** a phrase of the wrong length refused; both variables, or neither, refused; the phrase absent from every output and message. **Accounts:** an account outside the parent refused, a funding account equal to the parent accepted; relayer key counts of 0 and 91 refused. **`--parent-key`:** only the public key printed, with no RPC request and no file. **The chain check**, against a stubbed RPC: parent key present with full access; present as a function-call key only; missing; account missing; another existing account lacking a derived key; the relayer lacking one of its keys; RPC down. In every failure, nothing is written. **Files:** the layout and modes; a second run that changes nothing; a key file with a different key refused. **The gateway env file:** read back by the gateway's own configuration loader; an identical file left alone; a different one refused |
| The demo endpoint | Gateway unit tests, with a stub program in place of the swarm and a stub chain reader:<ul><li>off means `404` on all three routes;</li><li>`403` without the header;</li><li>`202`, then `409` `demo_running` while it runs, including two requests in the same tick;</li><li>`409` `pool_open` and `503` not counted;</li><li>`429` over the cap, and a new count after midnight UTC (injected clock);</li><li>the precedence of answers 1 to 7;</li><li>`GET /demo` before, during and after a run;</li><li>the child's argv (the command, then the scenario), working folder, and environment without the four secret variables;</li><li>output lines prefixed, and a last line without a newline written;</li><li>exit codes and signals recorded, both `null` for a program that cannot be started;</li><li>the maximum run time (SIGTERM, then SIGKILL);</li><li>SIGTERM passed on at shutdown;</li><li>`config.json`'s `demo`;</li><li>`QUORUM_DEMO_*` validation in the configuration tests</li></ul> |
| Static files | `/`, `/index.html`, `/app.js`, `/totals.js`, `/style.css` and `/%61pp.js` served; `/package.json`, `/test/…`, `/node_modules/…`, `/.env` and `/%2Eenv` answer `404` |
| The live page | Buttons only with `demo: true`; disabled while running, at the cap, and when `GET /demo` fails; the click removes `?pool=` and sends the header; every demo line of section 5, in its order of precedence |
| The image and the start script | The local rehearsal of section 7.5, step 6, including a restart of the container |
| The deployment | Over HTTPS from another network: the page loads, and its explorer links open; `/package.json` and `/node_modules/…` answer `404`; a `fills` run ends Settled and a `fails` run Refunded, with every check of the run passing; a second click during a run gets `409`; a `POST` without the header gets `403`; `fly logs` shows the `[demo]` lines |

## 10. Known limits

- **Anyone can start a run.** A run spends testnet NEAR (gas, and storage for a new pool) and moves
  testnet USDC between the deployment's own accounts. It is bounded by one run at a time, the daily
  cap and the maximum run time, not by who asks. The header of section 4.2 stops pages on other
  sites. It does not stop a script that sends the header itself.
- **NEAR runs out before the cap does.** Pool and seat storage is never freed (design spec, section
  12). After the first setup the parent holds little more than 1 NEAR, and a refill from NEAR's web
  faucet is 5 NEAR. The NEAR one run costs is measured in the rehearsal (section 7.5).
- **USDC drains** by the amount each run that fills moves to the provider, until `swarm reset`
  returns it (section 7.6).
- **Every pool ever opened is read again and again.** The keeper (every 5 seconds by default),
  `GET /pools` and every visitor's page (every 2 seconds) read all of the contract's pools, 100 per
  RPC call. At up to the daily cap of new pools a day, the public RPC's limits will apply sooner.
  `GET /activity` without a pool returns the whole feed, which also grows with every run.
- **One phrase controls every account** of the deployment, and the host holds it. Whoever reads the
  host's secrets can move all its testnet funds.
- **A run started elsewhere with the same accounts** within the same few seconds as a visitor's run
  can clash with it. Both may sign with the same keys before either opens a pool, so a transaction
  can be rejected for its nonce, a top-up can be sent twice, or two pools can open. No funds are
  lost: every seat still settles or is refunded.
- **One machine.** The deployment is unavailable during a deploy or a host failure. The activity
  feed is on one volume, kept by Fly.io's daily snapshots.
- **The daily count lives in memory** and starts again after a restart.

## 11. Changes to the design spec

When this is implemented, the design spec gains:

- **2:** the live page can ask the gateway to start a run.
- **6.1:** the static-file rule of section 6; the demo routes; `demo` in `/config.json`.
- **7.1:** the keys may be derived from one phrase (section 3).
- **7.6:** rows for the seed phrase and the three demo settings.
- **8:** the buttons and the demo line (section 5).
- **9:** the error cases of section 8.
- **10:** the tests of section 9.
- **12:** the limits of section 10.

The gateway's `.env.example` gains the `QUORUM_DEMO_*` settings, and its `QUORUM_WEB_DIR` comment
states the static-file rule instead of the dot-segment rule.
