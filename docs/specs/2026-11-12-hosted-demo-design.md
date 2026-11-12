# Quorum on NEAR: hosted demo

> **Status: draft.** This spec extends the design spec,
> [`2026-11-09-quorum-on-near-design.md`](2026-11-09-quorum-on-near-design.md) ("the design spec"
> below). It describes a public deployment of the gateway and the live page on NEAR testnet, and the
> features that deployment needs. Section 11 lists the design spec's sections it changes.

## 1. Summary

The gateway and the live page run on one public machine on Fly.io, against NEAR testnet. A visitor
opens the page and watches the provider's latest pool. A visitor can also start a run of the swarm
with a button, either a pool that fills or a pool that fails, and watch it from its first seat:

- **One run at a time.** A visitor who clicks while a run is in progress watches that run. The
  first click starts it; any later click is told a run is in progress, and the page follows the
  running pool either way.
- **One secret.** Every testnet account of the deployment, and the gateway's credential key, is
  derived from one BIP-39 phrase. The host holds that phrase and nothing else secret.

The provider and the GPU access stay simulated, as everywhere in this system (design spec, section
1). The money flow of every run is real, in Circle's testnet USDC.

## 2. Scope

**In scope**

- `swarm keys from-seed`: every key file the swarm reads, derived from one phrase (section 3).
- An opt-in demo endpoint on the gateway that starts the swarm's `demo` command (section 4).
- Two buttons and a status line on the live page, shown only when the endpoint is on (section 5).
- The gateway serving only the page's own files (section 6).
- A Dockerfile, a start script and a Fly.io configuration, and how the deployment is bootstrapped
  and run (section 7).

**Out of scope** (not built)

- Mainnet, as in the design spec.
- More than one machine or region.
- Alerting. A run that lacks funds shows on the page and in the logs (section 7.6).
- Authentication or per-visitor rate limiting of the demo endpoint. One run at a time and a daily
  cap bound it (section 4).
- Scheduled runs: a run starts only when someone asks for one.
- Automated faucet funding (design spec, section 2).

## 3. Accounts and keys

### 3.1 One phrase

The deployment has its own parent account, used for nothing else, and the accounts of the design
spec's section 7.1 under it. Runs started elsewhere with other keys therefore never share its
accounts.

Every key is derived from one **BIP-39 English phrase** of 12 or 24 words:

- **Seed:** PBKDF2-HMAC-SHA512 of the phrase (normalised to NFKD), with the salt `mnemonic` (no
  passphrase), 2,048 iterations, 64 bytes (BIP-39).
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
  names. Its words are split on whitespace and joined with single spaces before the seed is
  computed, so line breaks and extra spaces in the file do not change the keys. The command refuses
  when both variables or neither is set. The phrase is never printed, logged, or put in an error
  message.
- **`--parent-key`** prints the derived parent public key and exits. It reads no chain and writes no
  file, so it can run before the parent account exists (section 7.5, step 2).
- **First, a check against the chain.** Like every swarm command, it checks the RPC's chain id
  (design spec, section 7.6). It then reads the derived parent public key's access key on
  `QUORUM_PARENT_ACCOUNT` (`view_access_key`, optimistic finality). If the account or the key does
  not exist, it exits 1, says that the phrase does not hold a key of that account, and writes
  nothing. If the RPC cannot be read, it exits 1.
- **Then the key files.** Under `QUORUM_CREDENTIALS_DIR`, it writes every account's key file in the
  layout the swarm reads (design spec, section 7.1). The relayer gets its key folder with the
  configured number of keys, and the first key is also in its key file. A file is written only if
  it is new: created exclusively, mode `0600`, flushed. A file that already holds the same key is
  left alone; a file that holds a different key stops the command (exit 1, naming the file) and is
  never overwritten. Running it again is therefore safe.
- **`--gateway-env <path>`** also writes, created exclusively and mode `0600`, an env file holding
  `QUORUM_RELAYER_KEYS` (the relayer's keys, in path order) and `QUORUM_CREDENTIAL_JWK` (the private
  Ed25519 JWK of the credential key). The same phrase always gives the same credential key, so a
  credential issued before a restart still verifies after it.
- **Its output** is one line per account: its id and public key. No private key is printed.

The swarm's setup reuses a key file left for an account it has not yet created. So when the command
runs before the first setup, setup creates each account with its derived key.

### 3.3 Where the keys live

- **On the host:** the phrase, in one secret. At each boot, the key files and the gateway's env file
  are written to `/run/quorum` on the machine's ephemeral disk, never to the volume.
- **On the operator's machine:** the phrase, in a file of mode `0600` outside the repository, which
  `QUORUM_SEED_PHRASE_FILE` names.

## 4. The demo endpoint

### 4.1 Configuration

| Variable | Meaning |
|---|---|
| `QUORUM_DEMO_COMMAND` | A JSON array of strings: the program to start and its first arguments, for example the swarm's command-line entry and `demo`. The gateway appends the scenario. Unset or empty: the demo is off. A value that is not a non-empty array of non-empty strings: the gateway refuses to start |
| `QUORUM_DEMO_MAX_RUNS_PER_DAY` | 1 to 1,000, default 100. Runs started per UTC day, counted in memory |

### 4.2 Routes

| Route | Answer |
|---|---|
| `POST /demo/fills`, `POST /demo/fails` | Demo off: `404`, as for any unknown route. A run in progress: `409` `{error: "demo_running", scenario, startedAt}`. Today's cap reached: `429` `{error: "demo_limit"}`. Otherwise the run starts: `202` `{scenario, startedAt}` |
| `GET /demo` | Demo off: `404`. Otherwise `200` `{running, scenario, startedAt, last, runsToday, maxRunsPerDay}`. `scenario` and `startedAt` are `null` when no run is in progress. `last` is `{scenario, startedAt, endedAt, exitCode}` for the last finished run, or `null`. `exitCode` is `null` when the program could not be started |
| `GET /config.json` | Gains `demo`: `true` when the demo is on, `false` otherwise |

`startedAt` and `endedAt` are milliseconds since the epoch. The routes read no request body and send
no CORS headers: only the page, served from the same origin, calls them.

### 4.3 A run

- **One at a time.** The run's slot is taken before the program is started, in the same synchronous
  step that checks it, so two requests can never both start a run. The day's count goes up when a
  run starts.
- **Started without a shell:** the program and its arguments are the command's array plus the
  scenario. Its environment and working folder are the gateway's.
- **Its output**, line by line, goes to the gateway's standard output and error, each line prefixed
  with `[demo] `.
- **When it ends**, its exit code is recorded as `last` and the slot is released. A program that
  cannot be started is recorded with `exitCode: null`.
- **When the gateway stops** (SIGINT or SIGTERM), it sends the run SIGTERM.
- **The run is the swarm's `demo` command** (setup, open, run, check), with its own guards: it
  refuses to open a pool while one of the provider's pools is Open. The gateway reads none of its
  key files. The environment points the swarm at the key files of section 3.3 and at the gateway's
  public URL, which is the URL the buyers sign their proofs for (design spec, section 6.5).

## 5. The live page

When `/config.json` has `demo: true`, the page shows two buttons, **"Start a pool that fills"** and
**"Start a pool that fails"**, and a status line. With `demo: false`, or on a gateway without the
endpoint, it shows neither, and is as the design spec's section 8 describes.

- **Every refresh** (2 seconds) also reads `GET /demo`, and the buttons are disabled while a run is
  in progress.
- **A click** sends the `POST`, and the status line says what happened:
  - `202`: "A run started. Its pool appears here once it opens."
  - `409`: "A run is already in progress. This page shows its pool."
  - `429`: "The demo has reached its limit for today."
  - no answer: "The gateway could not be reached."
- **While a run is in progress**, the status line names its scenario and start time.
- **After a failed run**, when `last.exitCode` is not 0, the status line says: "The last run ended
  with an error. Its testnet funds may need a refill."
- **Following the run.** The page follows the provider's newest pool unless the URL names one
  (design spec, section 8), so the pool a run opens replaces the previous one on the next refresh.
- **Still read-only toward the chain.** The page never signs anything and needs no wallet. It only
  asks the gateway to start a run.

## 6. The gateway's static files

From the live page folder, the gateway serves exactly `/` (as `index.html`), `/index.html`,
`/app.js`, `/totals.js` and `/style.css`, and answers `404` for every other path. This replaces the
dot-segment rule of the design spec's section 6.1. The page folder is a package, with
`node_modules/`, tests and `package.json`. None of these may be served by a gateway on a public
host, so this rule must be in place before any public deployment.

## 7. Deployment on Fly.io

### 7.1 The image

`deploy/fly/Dockerfile`, built from the repository root:

- Node at the version the root `package.json` requires, and pnpm through corepack.
- A production install from the frozen lockfile.
- The workspace's TypeScript sources, run by Node's type stripping as everywhere else.
- No Rust toolchain and no wasm: the pools contract is deployed during the bootstrap (section 7.5),
  and setup reads the wasm only for an account without code.

`.dockerignore` keeps out `target/`, every `node_modules/`, every `.env` file, `data/` and any key
file.

### 7.2 The start script

`deploy/fly/start.sh`:

1. Runs `swarm keys from-seed --gateway-env /run/quorum/gateway.env`, with
   `QUORUM_CREDENTIALS_DIR=/run/quorum/credentials`. If it fails, the script exits, and the machine
   restarts.
2. Replaces itself (`exec`) with the gateway, started with `/run/quorum/gateway.env` as an env file,
   so the gateway is the process the host supervises.

### 7.3 `fly.toml`

- **Build:** the Dockerfile above.
- **Environment** (no secret here):
  - `QUORUM_NETWORK=near:testnet` and a public RPC that allows browser requests (design spec,
    section 7.6);
  - `QUORUM_GATEWAY_URL` set to the deployment's public `https://` URL;
  - `QUORUM_PARENT_ACCOUNT`;
  - `QUORUM_CREDENTIALS_DIR=/run/quorum/credentials`;
  - `QUORUM_DATA_DIR` on the volume;
  - `QUORUM_WEB_DIR` as an absolute path;
  - `QUORUM_DEMO_COMMAND` and `QUORUM_DEMO_MAX_RUNS_PER_DAY`.
- **A volume** mounted at `/data`, which holds the activity feed.
- **An HTTP service** on the gateway's port, with HTTPS forced at Fly.io's proxy. The machine is
  never stopped automatically, since the keeper and runs must keep going. A health check reads
  `GET /config.json`.
- **One machine**, shared CPU, 512 MB.

The exact `fly.toml` keys are checked against Fly.io's documentation when the file is written.

### 7.4 Secrets

One: `QUORUM_SEED_PHRASE`, set with `fly secrets set`. Fly.io passes it to the machine as an
environment variable at boot.

### 7.5 Bootstrap

Done once, in this order:

1. **Generate a phrase** with a BIP-39 generator. Keep it in a password manager and in a file of mode
   `0600` outside the repository.
2. **Create the parent with the phrase's key.** `swarm keys from-seed --parent-key` prints the
   parent's public key, then
   `near account create-account sponsor-by-faucet-service <parent> use-manually-provided-public-key <key> network-config testnet create`
   creates the account. The faucet funds it with 10 NEAR. The phrase itself never appears on a
   command line.
3. **Write the keys and run the first setup**, on Linux, macOS or WSL2 with the pools wasm built:
   `swarm keys from-seed` into a credentials folder used only for this deployment, then
   `swarm setup`. Setup creates the accounts with the derived keys, deploys the pools contract and
   registers the accounts, then stops on the funding account's token shortfall.
4. **Fund the funding account** with USDC from Circle's testnet faucet (design spec, section 7.2).
5. **Run `swarm setup` again.** It tops up the buyers and ends with nothing left to do.
6. **Rehearse locally:** build the image, run it with the phrase and the deployment's environment,
   read `/config.json`, start a run from the page.
7. **Deploy:** create the app and a 1 GB volume, set the secret from the phrase file
   (`fly secrets set QUORUM_SEED_PHRASE="$(cat <file>)"`, so the phrase is never typed on the
   command line or shown), then `fly deploy`.
8. **Check** as section 9 describes.

### 7.6 Operating it

- **Refills:** NEAR's testnet faucet to the parent, Circle's testnet faucet to the funding account.
  A run that lacks funds stops in setup before sending anything (design spec, section 7.2). Its
  output says why, and the page's status line reports the failed run.
- **Logs:** `fly logs` shows the gateway and every run, prefixed `[demo]`.
- **Deploys and restarts** stop a run in progress. Its pool stays Open until its deadline, and the
  keeper then settles or refunds it, as for any pool. The day's count, the redemption nonce cache
  and the in-flight holds start empty after a restart (design spec, sections 9 and 12).
- **Taking it down:** `fly apps destroy`. The accounts and the contract stay on testnet.

## 8. Error handling

| Case | Behaviour |
|---|---|
| No phrase, or both variables set | `swarm keys from-seed` exits 1 with a message; at boot, the machine restarts |
| The phrase does not hold a key of the parent | Exit 1, nothing written |
| The RPC cannot be read at boot | Exit 1; the machine restarts |
| A key file holds a different key | Exit 1, naming the file; nothing is overwritten |
| `QUORUM_DEMO_COMMAND` malformed | The gateway refuses to start, naming the variable |
| The program cannot be started | `202` was already sent; `last.exitCode` is `null`, and the page reports the failed run |
| A run ends with an error (a shortfall, a failed check) | `last.exitCode` is its exit code; the page reports it; the output is in the logs |
| The gateway stops during a run | The run gets SIGTERM; the keeper resolves its pool at the deadline |

## 9. Testing

| What | How |
|---|---|
| `swarm keys from-seed` | Unit tests, test first: SLIP-10's published ed25519 test vectors; BIP-39's reference seed vector; a parent key computed by near-cli-rs from a fixed test phrase at `m/44'/397'/0'`; the same keys from a phrase written with extra spaces or line breaks; `--parent-key` printing only the public key, with no RPC request and no file; the file layout and modes; a second run that changes nothing; a file with a different key refused; the chain check against a stubbed RPC (key present, key missing, account missing, RPC down); the phrase absent from every output |
| The demo endpoint | Gateway unit tests, with a stub program in place of the swarm: off means `404` on all three routes; `202` and then `409` while it runs, including two requests in the same tick; `429` over the cap and a new count after midnight UTC; `GET /demo` before, during and after a run; output lines prefixed; exit codes recorded, `null` for a program that cannot be started; SIGTERM passed on at shutdown; `config.json`'s `demo` |
| Static files | `/`, `/index.html`, `/app.js`, `/totals.js` and `/style.css` served; `/package.json`, `/test/…`, `/node_modules/…` and a dot path `404` |
| The live page | Buttons only with `demo: true`; disabled while running; each answer's status text; the failed-run line |
| The image and the start script | The local rehearsal of section 7.5, step 6 |
| The deployment | Over HTTPS from another network: the page loads, and its explorer links open; `/package.json` and `/node_modules/…` answer `404`; a `fills` run ends Settled and a `fails` run Refunded, with every check of the run passing; a second click during a run gets `409`; `fly logs` shows the `[demo]` lines |

## 10. Known limits

- **Anyone can start a run.** A run spends testnet NEAR (gas, and storage for a new pool) and moves
  testnet USDC between the deployment's own accounts. It is bounded by one run at a time and the
  daily cap, not by who asks.
- **One phrase controls every account** of the deployment, and the host holds it. Whoever reads the
  host's secrets can move all its testnet funds.
- **A run started elsewhere with the same accounts** within the same few seconds as a visitor's run
  can clash with it. Both may sign with the same keys before either opens a pool, so a transaction
  can be rejected for its nonce, a top-up can be sent twice, or two pools can open. No funds are
  lost: every seat still settles or is refunded.
- **One machine.** The deployment is unavailable during a deploy or a host failure. The activity
  feed is on one volume, kept by Fly.io's daily snapshots.
- **The daily count lives in memory** and starts again after a restart.
- **Every visitor reads the pools from the public RPC** every 2 seconds (design spec, section 8). With
  many visitors, the RPC's own limits apply.

## 11. Changes to the design spec

When this is implemented, the design spec gains:

- **6.1:** the static-file rule of section 6; the demo routes; `demo` in `/config.json`.
- **7.1:** the keys may be derived from one phrase (section 3).
- **7.6:** rows for the seed phrase, the demo command and the daily cap.
- **8:** the buttons and the status line (section 5).
- **12:** the limits of section 10.
