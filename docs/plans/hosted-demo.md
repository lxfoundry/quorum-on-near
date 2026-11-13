# Hosted demo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or
> executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for
> tracking.

**Goal:** Run the gateway and the live page on one public Fly.io machine against NEAR testnet,
where a visitor can start a swarm run from the page, with every key of the deployment derived from
one BIP-39 phrase.

**Architecture:** A new swarm command, `swarm keys from-seed`, derives every key file the swarm
reads, and the gateway's two secrets, from one phrase (SLIP-10 ed25519 under NEAR's `m/44'/397'`).
It checks them against the chain before writing anything. The gateway gains an opt-in demo
endpoint: one swarm `demo` run at a time, started as a child process without the gateway's secrets
in its environment, with a daily cap and a maximum run time. The live page gains two buttons and a
demo line. A Dockerfile, a start script and a `fly.toml` run it all on one machine, holding a single
secret: the phrase.

**Tech Stack:** Node 22.22.2 with type stripping, pnpm workspace, TypeScript, Hono (gateway),
near-api-js 7, vitest, plain HTML and ES modules (page), Docker, Fly.io (flyctl), near-cli-rs.

**Spec:** [`docs/specs/2026-11-12-hosted-demo-design.md`](../specs/2026-11-12-hosted-demo-design.md).
It extends [`docs/specs/2026-11-09-quorum-on-near-design.md`](../specs/2026-11-09-quorum-on-near-design.md)
("the design spec"). Read both before starting.

## Status of the code in this plan

This plan was written from reading the code, without running it. It builds on the code of the
swarm and MCP server plan ([`swarm-mcp.md`](swarm-mcp.md)) and the live page plan
([`live-page.md`](live-page.md)), which must both be merged into `main` first (Task 0). Where a
task names a function, type or file from those plans, it gives the name the plans use. If the
merged code differs, use the merged name and keep the behaviour this plan and the spec describe.
Expected test counts in the steps are counted from the code, not observed: when a count differs
but every named test passes and none fails, note the real count and go on.

Two values come from outside the code and are filled in during execution, each in the step that
says so:
- the parent public key that near-cli-rs derives from the public test phrase (Task 2, Step 1);
- the NEAR one run costs, measured in the rehearsal (Task 9).

## Global Constraints

- **Testnet only** (`near:testnet`), as in the design spec. No mainnet account, key or transaction.
- **Node 22.22.2** (the version CI runs), pnpm through Corepack at the version the root
  `package.json` names. TypeScript runs by Node's type stripping: erasable syntax only, `.ts`
  import extensions, no build step.
- **No new dependency** in any package. The seed derivation uses Node's built-in `node:crypto`
  only.
- **Test first:** every behaviour gets a failing test before its code, in the package's existing
  vitest suite.
- **Secrets:** no phrase, private key or key file is ever committed, printed, logged or put in an
  error message. Tests use only the public BIP-39 test phrases. The phrase reaches a process only
  through `QUORUM_SEED_PHRASE` or the file named by `QUORUM_SEED_PHRASE_FILE`, never through a
  command line.
- **The phrase's paths** are fixed (spec §3.1): parent `m/44'/397'/0'`, funding `1'` (the parent's
  key when the funding account is the parent), pools `2'`, provider `3'`, relayer key `i` at
  `(10 + i)'` (count 1 to 90), `buyer-NN` at `(100 + NN)'`, the MCP server's buyer `199'`, the
  credential key `900'`. Every level hardened.
- **Accounts:** every account the deployment signs with is a direct sub-account of the parent;
  only the funding account may be the parent itself.
- **Demo settings:** `QUORUM_DEMO_COMMAND` (a JSON array of non-empty strings; unset or empty means
  off), `QUORUM_DEMO_MAX_RUNS_PER_DAY` (1 to 1,000, default 100, per UTC day, in memory),
  `QUORUM_DEMO_MAX_RUN_SECONDS` (60 to 7,200, default 1,800; SIGTERM, then SIGKILL 10 seconds
  later).
- **Demo routes** answer exactly as spec §4.2: header `X-Quorum-Demo: 1` required on `POST`; the
  precedence 404, 403, 409 `demo_running`, 429, 409 `pool_open`, 503, 202; no CORS headers; no
  request body read.
- **A run's environment** is the gateway's minus `QUORUM_RELAYER_KEYS`, `QUORUM_CREDENTIAL_JWK`,
  `QUORUM_SEED_PHRASE` and `QUORUM_SEED_PHRASE_FILE`. It is started without a shell.
- **Static files:** the gateway serves exactly `/`, `/index.html`, `/app.js`, `/totals.js` and
  `/style.css` from the page folder, matched after percent-decoding; everything else is `404`.
- **Say what is simulated:** the provider and its access are simulated; never call them a partner,
  a booking or a reservation in code, docs or UI text.
- **Commits:** neutral, technical, present tense; one commit per task unless the task says
  otherwise. Work on `feat/hosted-demo`.

## File Structure

| File | Task | Responsibility |
|---|---|---|
| `apps/gateway/src/app.ts` | 1, 5 | The static-file rule; the demo routes and `demo` in `/config.json` |
| `apps/gateway/test/app.test.ts` | 1, 5 | Their tests |
| `apps/swarm/src/seed.ts` | 2 | Phrase normalisation, the BIP-39 seed, SLIP-10 ed25519, NEAR key strings, the credential JWK, the path table |
| `apps/swarm/test/seed.test.ts` | 2 | Published vectors, the near-cli-rs parent key, normalisation |
| `apps/swarm/src/keys-from-seed.ts` | 3 | The command: reading the phrase, the account rules, the chain check, the key files, the gateway env file, the output |
| `apps/swarm/src/main.ts` | 3 | The `keys from-seed` command line |
| `apps/swarm/src/env-files.ts` | 3 | `gatewaySecretsEnvText`, the two secret lines shared with `gatewayEnvText` |
| `apps/swarm/test/keys-from-seed.test.ts`, `apps/swarm/test/stub-seed-chain.ts` | 3 | The command against a stubbed chain and a temporary folder |
| `apps/swarm/test/main.test.ts`, `apps/swarm/test/env-files.test.ts` | 3 | The new command's line, and the shared secret lines |
| `apps/gateway/src/config.ts`, `apps/gateway/.env.example` | 4 | The three `QUORUM_DEMO_*` settings |
| `apps/gateway/src/demo.ts` | 4 | `DemoRunner`: the slot, the day's count, the child process, its output, its end, the maximum run time, `stop()` |
| `apps/gateway/test/demo.test.ts`, `apps/gateway/test/fixtures/demo-program.mjs`, `apps/gateway/test/config.test.ts`, `apps/gateway/test/fake-chain.ts` | 4 | The runner against a real stub program; the settings' tests |
| `apps/gateway/src/main.ts` | 5 | Creating the runner and stopping it at shutdown |
| `apps/web/index.html`, `app.js`, `totals.js`, `style.css` | 6 | The buttons, the demo line, `demoLine()` |
| `apps/web/test/…` | 6 | `demoLine()` and the page's wiring |
| `deploy/fly/Dockerfile`, `deploy/fly/start.sh`, `deploy/fly/fly.toml`, `.dockerignore` | 7 | The image, the start script, the Fly.io configuration |
| `docs/specs/2026-11-09-quorum-on-near-design.md`, `apps/gateway/.env.example`, `apps/swarm/.env.example`, `CLAUDE.md` | 8 | The design spec's sections of spec §11, the settings, the layout |
| `docs/specs/2026-11-12-hosted-demo-design.md` | 9 | The measured NEAR per run (§10) |

---

### Task 0: Prerequisites and branch

No code and no commit. This plan builds on the swarm and MCP server plan (`docs/plans/swarm-mcp.md`:
`packages/buyer`, `apps/swarm`, `apps/mcp`) and the live page plan (`docs/plans/live-page.md`:
`apps/web`). Both must be merged into `main` before any task here starts.

On Windows, run the `bash` blocks of this plan in Git Bash; the commands of this task also work in
PowerShell.

- [ ] **Step 1: Check Node and pnpm**

```bash
node --version
pnpm --version
```

Expected: `v22.22.2` or a later 22.x (the root `package.json` requires `>=22.22.2`; CI runs
22.22.2), and `10.23.0` (the root `package.json`'s `packageManager`, through Corepack).

If Node is older, install a current Node 22 with a version manager, for example fnm:

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

If `pnpm --version` fails or prints another version:

```bash
corepack enable
corepack prepare pnpm@10.23.0 --activate
pnpm --version
```

Expected: `10.23.0`.

- [ ] **Step 2: Check that the two earlier plans are merged**

```bash
git fetch origin
git ls-tree --name-only origin/main apps/ packages/
```

Expected, exactly:

```text
apps/gateway
apps/mcp
apps/swarm
apps/web
packages/buyer
packages/protocol
```

If `apps/mcp`, `apps/swarm`, `apps/web` or `packages/buyer` is missing, stop: the plans that build
them are not merged yet, and Tasks 2, 3, 6 and 7 of this plan need their code.

- [ ] **Step 3: Create the branch**

```bash
git status --short
git switch --no-track -c feat/hosted-demo origin/main
```

Expected: `git status --short` prints nothing (commit or stash any change first); then
`Switched to a new branch 'feat/hosted-demo'`. `--no-track` keeps the branch from tracking `main`,
so its first push sets its own upstream (`git push -u origin feat/hosted-demo`).

- [ ] **Step 4: Install the workspace**

```bash
pnpm install
git status --short
```

Expected: pnpm reports the lockfile up to date and installs; `git status --short` still prints
nothing. No task of this plan adds a dependency.

- [ ] **Step 5: Check the baseline**

```bash
pnpm typecheck
pnpm test
```

Expected: both exit 0. `pnpm typecheck` prints `Done` for `packages/protocol`, `packages/buyer`,
`apps/gateway`, `apps/swarm`, `apps/mcp` and `apps/web`. Write down the gateway's test count from
`pnpm --filter @quorum-on-near/gateway test` (its summary line, `Tests  N passed (N)`): Task 1 adds
15 tests to it, Task 4 39 (one of them skipped on Windows), and Task 5 17. If anything fails here,
fix `main` first; this plan assumes a green start.

Tasks 1, 4 and 5 run anywhere Node runs, Windows included: their tests start a small Node program,
never a shell.

---

### Task 1: The gateway serves only the page's files

The gateway serves the live page from `QUORUM_WEB_DIR`. On `main` it serves **every** file of that
folder except those under a name that starts with a dot (`DOT_SEGMENT` in
`apps/gateway/src/app.ts`). The folder is the `@quorum-on-near/web` package, with its tests, its
`package.json`, its `tsconfig.json` and its `node_modules/`, none of which is part of the page. From
here on the gateway serves exactly `/` (as `index.html`), `/index.html`, `/app.js`, `/totals.js` and
`/style.css` from it, and answers `404 not_found` for every other path (hosted demo spec, section 6).
Each file is its own `GET` route, so a path is matched after Hono has percent-decoded it:
`/%61pp.js` is `/app.js`, and `/%2Eenv` is `/.env`, which no route matches.

This task assumes `apps/gateway/src/app.ts` and `apps/gateway/test/app.test.ts` as they are on
`main` after the two earlier plans; neither plan changes how the gateway serves files. Step 1
checks that.

What the code relies on, read in the installed packages:

- `@hono/node-server` 2.1.6, `serveStatic({ root, path })` (`dist/serve-static.mjs`): with `path`
  set, it serves `join(root, path)` whatever the request's path, answers only `GET` and `HEAD`, sets
  the content type from the file's extension (`text/css; charset=utf-8` for `.css`), and calls
  `next()` when the file is missing.
- Hono 4.13.17 (`dist/utils/url.js`, `getPath`): routes match the request path after `decodeURI`,
  which decodes `%61` and `%2E` but leaves `%2F` encoded. Routing is strict and case-sensitive:
  `/index.html/` and `/App.js` match no route. A route whose handler calls `next()` with nothing after
  it is answered by the app's `notFound` handler (`dist/hono-base.js`, `#dispatch`), here
  `404 {"error":"not_found"}`. `HEAD` is answered by the `GET` route.

**Files:**
- Modify: `apps/gateway/src/app.ts` (the `DOT_SEGMENT` constant, the static-file block at the end of
  `createApp`, and `createApp`'s doc comment)
- Test: `apps/gateway/test/app.test.ts` (the block `static files whose names start with a dot` is
  replaced)

**Interfaces:**
- Consumes: `serveStatic` from `@hono/node-server/serve-static` (already imported by `app.ts`);
  `config.webDir: string | null` (`GatewayConfig`); in the tests, the existing helpers `setup`,
  `webFolder`, `answer` and the constants `INDEX_HTML`, `APP_JS` of `app.test.ts`.
- Produces: no new export. `createApp(deps, options)` keeps its signature. A module-private
  `PAGE_FILES: Record<string, string>` maps each served path to its file. Task 5 adds the demo routes
  before the static-file block this task writes.

- [ ] **Step 1: Check what the gateway serves now (the gate)**

```bash
git grep -n -e DOT_SEGMENT -e serveStatic -e PAGE_FILES -- apps/gateway/src/app.ts
```

Expected on `main` after the two earlier plans (line numbers may differ):

```text
apps/gateway/src/app.ts:1:import { serveStatic } from '@hono/node-server/serve-static';
apps/gateway/src/app.ts:24:const DOT_SEGMENT = /\/\./;
apps/gateway/src/app.ts:167:    const files = serveStatic({ root: config.webDir });
apps/gateway/src/app.ts:168:    app.use('*', (c, next) => (DOT_SEGMENT.test(c.req.path) ? next() : files(c, next)));
```

- **If the output shows `DOT_SEGMENT`** (the expected case): the gateway still serves the whole
  folder. Do Steps 2 to 7 as written.
- **If it shows no `DOT_SEGMENT`, and the static files are already served from a fixed list**
  (`PAGE_FILES` or another name, with no `app.use('*', …)` that hands every path to `serveStatic`):
  check that list against the paragraph at the top of this task: exactly the five paths, `/` and
  `/index.html` both serving `index.html`, each served by its own `GET` route (or matched against the
  percent-decoded path), and nothing else in the folder reachable. Then do Step 2 (the tests, as
  written) and Step 3 (run them).
  - If every test of the new block passes, skip Step 4 and run Steps 5 and 6 as written. In Step 7,
    stage only `apps/gateway/test/app.test.ts`, and commit it with the message
    `test that the gateway serves only the live page's own files` and a body saying that the gateway
    already served only those five paths.
  - If any test fails, the existing list does not meet section 6: replace the gateway's static-file
    code by Step 4's (remove the old constant and block, add `PAGE_FILES` and the new block, update
    the doc comment), then continue with Steps 5 to 7 as written.

- [ ] **Step 2: Write the failing tests**

In `apps/gateway/test/app.test.ts`, replace the whole block that starts with
`describe('static files whose names start with a dot', () => {` and ends with its closing `});`
(just before `describe('errors', () => {`) by the block below. The old block's tests of dot paths are
kept in the new list of `404` paths; its test `still serves the other files, in subfolders too` goes
on purpose, since no file of the page is in a subfolder; `still answers /.well-known/jwks.json` is
kept as it was.

```typescript
  describe("only the live page's own files", () => {
    /** A page folder as the web package holds it: the page's four files, and files never served. */
    const PAGE = {
      'index.html': INDEX_HTML,
      'app.js': APP_JS,
      'totals.js': 'export const total = 0;\n',
      'style.css': 'body { margin: 0; }\n',
      'package.json': '{ "name": "@quorum-on-near/web" }\n',
      'tsconfig.json': '{}\n',
      'test/totals.test.ts': 'export {};\n',
      'node_modules/vitest/package.json': '{ "name": "vitest" }\n',
      'node_modules/.bin/vitest': '#!/bin/sh\n',
      'sub/page.js': APP_JS,
      '.env': 'QUORUM_PARENT_ACCOUNT=parent.testnet\n',
      '.git/config': '[core]\n',
      'sub/.hidden': 'hidden\n',
      '.well-known/other.json': '{}',
    };

    it.each([
      ['/', 'index.html', 'text/html; charset=utf-8'],
      ['/?pool=7', 'index.html', 'text/html; charset=utf-8'],
      ['/index.html', 'index.html', 'text/html; charset=utf-8'],
      ['/app.js', 'app.js', 'text/javascript; charset=utf-8'],
      ['/totals.js', 'totals.js', 'text/javascript; charset=utf-8'],
      ['/style.css', 'style.css', 'text/css; charset=utf-8'],
      // Matched after percent-decoding: %61 is "a".
      ['/%61pp.js', 'app.js', 'text/javascript; charset=utf-8'],
    ] as const)('serves %s from %s', async (path, file, type) => {
      const { app } = await setup({ webDir: await webFolder(PAGE) });
      const res = await app.request(path);
      expect({ status: res.status, type: res.headers.get('Content-Type'), text: await res.text() }).toEqual({
        status: 200,
        type,
        text: PAGE[file],
      });
    });

    it.each([
      '/package.json',
      '/tsconfig.json',
      '/test/totals.test.ts',
      '/node_modules/vitest/package.json',
      '/node_modules/.bin/vitest',
      '/sub/page.js',
      '/.env',
      // Percent-decoded, this is /.env.
      '/%2Eenv',
      '/.git/config',
      '/sub/.hidden',
      '/.well-known/other.json',
    ])('answers 404 not_found for %s, which the folder holds', async (path) => {
      const { app } = await setup({ webDir: await webFolder(PAGE) });
      expect(await answer(app.request(path))).toEqual({ status: 404, body: { error: 'not_found' } });
    });

    it.each(['/App.js', '/index.html/'])(
      'answers 404 not_found for %s, which is not one of the paths of the page',
      async (path) => {
        const { app } = await setup({ webDir: await webFolder(PAGE) });
        expect(await answer(app.request(path))).toEqual({ status: 404, body: { error: 'not_found' } });
      },
    );

    it('answers 404 not_found for a path of the page whose file the folder lacks', async () => {
      const { app } = await setup({ webDir: await webFolder({ 'index.html': INDEX_HTML }) });
      expect(await answer(app.request('/totals.js'))).toEqual({ status: 404, body: { error: 'not_found' } });
    });

    it('still answers /.well-known/jwks.json', async () => {
      const { deps, app } = await setup({ webDir: await webFolder(PAGE) });
      expect(await answer(app.request('/.well-known/jwks.json'))).toEqual({ status: 200, body: deps.credentials.jwks() });
    });
  });
```

The block `static files` above it (`serves index.html at /`, `serves a JavaScript module as
JavaScript`, `answers 404 not_found for a file the folder does not have`, `answers the API before a
file with the same path`, `serves nothing when webDir is null`) stays as it is.

- [ ] **Step 3: Run them and see them fail**

Run: `pnpm --filter @quorum-on-near/gateway exec vitest run test/app.test.ts`

Expected: FAIL. On Linux, 5 tests fail, each with `status: 200` where `404` is expected:
`answers 404 not_found for /package.json`, `/tsconfig.json`, `/test/totals.test.ts`,
`/node_modules/vitest/package.json` and `/sub/page.js`, which the dot rule lets through. On Windows
and macOS, whose file systems ignore case, `/App.js` fails too (it reads `app.js`), and on Windows
possibly `/index.html/`. Every other test passes, the seven `serves …` included.

- [ ] **Step 4: Implement**

In `apps/gateway/src/app.ts`, replace:

```typescript
/** A path with a segment that starts with a dot, such as `/.env` or `/.git/config`. */
const DOT_SEGMENT = /\/\./;
```

with:

```typescript
/**
 * The live page's files, by the paths that serve them. Nothing else in its folder is served: the
 * folder is a package, with its tests, its `package.json` and its `node_modules`.
 */
const PAGE_FILES: Record<string, string> = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/app.js': 'app.js',
  '/totals.js': 'totals.js',
  '/style.css': 'style.css',
};
```

Replace:

```typescript
  // After the routes, so a file never shadows one. A relative root resolves against the current folder.
  // Nothing whose name starts with a dot is served, such as a .env file that holds keys.
  if (config.webDir !== null) {
    const files = serveStatic({ root: config.webDir });
    app.use('*', (c, next) => (DOT_SEGMENT.test(c.req.path) ? next() : files(c, next)));
  }
```

with:

```typescript
  // Only the page's own files, each at its own route. Hono matches a route on the percent-decoded path,
  // so /%61pp.js is /app.js, and /%2Eenv is /.env, which no route matches. A relative root resolves
  // against the current folder. A file the folder lacks falls through to the 404 below.
  if (config.webDir !== null) {
    for (const [path, file] of Object.entries(PAGE_FILES)) {
      app.get(path, serveStatic({ root: config.webDir, path: file }));
    }
  }
```

In `createApp`'s doc comment, replace:

```typescript
 * - the live page's static files at `/` (only when `config.webDir` is set), except any whose path has
 *   a segment that starts with a dot
```

with:

```typescript
 * - the live page's files (only when `config.webDir` is set): its `index.html` at `/` and
 *   `/index.html`, and `/app.js`, `/totals.js` and `/style.css`; nothing else in its folder
```

- [ ] **Step 5: Run them and see them pass**

Run: `pnpm --filter @quorum-on-near/gateway exec vitest run test/app.test.ts`

Expected: PASS. The file has 15 more tests than before this task: the new block's 22 replace the
old block's 7.

Run: `pnpm --filter @quorum-on-near/gateway typecheck`

Expected: exit code 0; `tsc` prints nothing after pnpm's two lines naming the script.

- [ ] **Step 6: Run the whole workspace**

```bash
pnpm typecheck
pnpm test
```

Expected: both exit 0; the gateway's count is Task 0's plus 15.

- [ ] **Step 7: Commit**

```bash
git add apps/gateway/src/app.ts apps/gateway/test/app.test.ts
git commit -F - <<'EOF'
serve only the live page's own files from its folder

The gateway served every file of the live page's folder except those under a name that starts with
a dot. That folder is a package, with its tests, package.json and node_modules, none of which is
part of the page. The gateway now serves exactly /, /index.html, /app.js, /totals.js and /style.css
from it, each as its own route, so a path is matched after percent-decoding, and every other path
answers 404.
EOF
```

---


### Task 2: Seed derivation, `apps/swarm/src/seed.ts`

Every key of a deployment comes from one BIP-39 phrase: the BIP-39 seed (PBKDF2-HMAC-SHA512), then
SLIP-10 for ed25519, every level hardened, under NEAR's prefix `m/44'/397'`, with Node's built-in
`node:crypto` only. This task adds the derivation and the role-to-path table of the hosted demo
spec, section 3.1. Task 3 uses it.

**Files:**
- Create: `apps/swarm/src/seed.ts`
- Test: `apps/swarm/test/seed.test.ts`

**Interfaces:**
- Consumes:
  - `baseEncode(value: Uint8Array | string): string`, `KeyPair` (`KeyPair.fromString(encodedKey: KeyPairString): KeyPair`) and `type KeyPairString` from `near-api-js` 7.4.0, imported from the package root as `apps/swarm/src/rpc-chain.ts` and `packages/buyer/src/key-files.ts` already import them. No new dependency.
  - `type CredentialJwk` (`{ kty: 'OKP'; crv: 'Ed25519'; x: string; d: string }`) from `apps/swarm/src/env-files.ts`.
  - In the test only: `parseSeedPhrase(seedPhrase: string): KeyPair` from `near-api-js/seed-phrase`, a subpath export of the same `near-api-js` 7.4.0, used as an independent reference.
- Produces (`apps/swarm/src/seed.ts`):
  - `class SeedPhraseError extends Error` with `readonly words: number`; message `a seed phrase has 12 or 24 words, not <n>`.
  - `normalisePhrase(raw: string): string`
  - `bip39Seed(phrase: string, passphrase = ''): Buffer`
  - `interface ExtendedKey { key: Buffer; chainCode: Buffer }`
  - `parsePath(path: string): number[]`
  - `slip10Derive(seed: Uint8Array, path: string): ExtendedKey`
  - `ed25519PublicKey(privateKey: Uint8Array): Buffer`
  - `interface NearKey { path: string; publicKey: string; keyPair: KeyPair }`
  - `nearKey(seed: Uint8Array, path: string): NearKey`
  - `credentialJwk(seed: Uint8Array): CredentialJwk`
  - Constants `PARENT_PATH` (`m/44'/397'/0'`), `FUNDING_PATH` (`1'`), `POOLS_PATH` (`2'`), `PROVIDER_PATH` (`3'`), `MCP_BUYER_PATH` (`199'`), `CREDENTIAL_PATH` (`900'`), `MAX_RELAYER_KEYS` (90), `SCRIPTED_BUYERS` (20).
  - `relayerKeyPath(index: number): string` (`m/44'/397'/(10 + index)'`, index 0 to 89) and `scriptedBuyerPath(number: number): string` (`m/44'/397'/(100 + number)'`, number 1 to 20).

What the code relies on, checked in Node's documentation and in `near-api-js` 7.4.0's sources:

- `crypto.createPrivateKey({ key, format: 'der', type: 'pkcs8' })` imports an Ed25519 private key
  from its PKCS#8 DER form. For a raw 32-byte key, that form is the fixed 16-byte header
  `302e020100300506032b657004220420` (RFC 8410) followed by the key.
- `KeyObject.export({ format: 'jwk' })` of an Ed25519 private key gives `{ kty: 'OKP', crv:
  'Ed25519', x, d }`, with `d` the 32-byte private key and `x` the public key, both base64url. Node's
  `Buffer` reads and writes `base64url`.
- `KeyPair.fromString('ed25519:<base58>')` in `near-api-js` 7.4.0 (`KeyPairEd25519`) reads the first
  32 bytes of the decoded key as the private key and computes the public key from them; its
  `toString()` gives the string back as it was given. near-cli's key files hold the 64-byte form
  (private key, then public key), which is also what the gateway's `QUORUM_RELAYER_KEYS` requires.
  `baseEncode` is base58 with Bitcoin's alphabet, the encoding NEAR uses for keys.
- `near-api-js/seed-phrase`'s `parseSeedPhrase` wraps `near-seed-phrase` 0.2.1: the BIP-39 seed with
  an empty passphrase, SLIP-10 at `m/44'/397'/0'`, and the key pair from the 32 bytes found there.
  The test compares the derivation with it as a second, independent implementation.

- [ ] **Step 1: Get the parent key near-cli-rs derives from the public test phrase**

This is the one value in this task that the code does not determine: the output of an external tool,
recorded before the test is written. With near-cli-rs 0.14 or later (the `near` command), run:

```bash
near account get-public-key from-seed-phrase 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about' --seed-phrase-hd-path "m/44'/397'/0'"
```

It prints one public key: `ed25519:` followed by 43 or 44 base58 characters. Copy it. In Step 2, the
test file sets `NEAR_CLI_RS_PARENT_KEY` to it: replace `ed25519:REPLACE_WITH_THE_KEY_FROM_STEP_1`
with the key, and change nothing else. The phrase is BIP-39's public test phrase: anyone can derive
its keys, so it must never hold funds, and it is safe to type here. Only the public key is committed.

- [ ] **Step 2: Write the failing test**

Create `apps/swarm/test/seed.test.ts`, with the key from Step 1 in `NEAR_CLI_RS_PARENT_KEY`:

```ts
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { baseDecode, KeyPair, type KeyPairString } from 'near-api-js';
import { parseSeedPhrase } from 'near-api-js/seed-phrase';
import { describe, expect, it } from 'vitest';
import {
  bip39Seed,
  CREDENTIAL_PATH,
  credentialJwk,
  ed25519PublicKey,
  FUNDING_PATH,
  MAX_RELAYER_KEYS,
  MCP_BUYER_PATH,
  nearKey,
  normalisePhrase,
  PARENT_PATH,
  parsePath,
  POOLS_PATH,
  PROVIDER_PATH,
  relayerKeyPath,
  SCRIPTED_BUYERS,
  scriptedBuyerPath,
  SeedPhraseError,
  slip10Derive,
} from '../src/seed.ts';

/** BIP-39's public 12-word test phrase (16 zero bytes of entropy): anyone can derive its keys. */
const PHRASE = `${'abandon '.repeat(11)}about`;
/** BIP-39's public 24-word test phrase (32 zero bytes of entropy). */
const PHRASE_24 = `${'abandon '.repeat(23)}art`;
/** PHRASE as it may be typed or pasted: capitals, line breaks, a tab and extra spaces. */
const MESSY = `\n  ABANDON abandon\tabandon\r\nAbandon ${'abandon '.repeat(7)}  ABOUT\n`;

/**
 * The public key near-cli-rs derives from PHRASE at NEAR's standard path, as printed by
 * `near account get-public-key from-seed-phrase '<PHRASE>' --seed-phrase-hd-path "m/44'/397'/0'"`.
 */
const NEAR_CLI_RS_PARENT_KEY = 'ed25519:REPLACE_WITH_THE_KEY_FROM_STEP_1';

/** The seed of SLIP-0010's "Test vector 1 for ed25519". */
const SLIP10_SEED = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');

/**
 * SLIP-0010's "Test vector 1 for ed25519": for each chain, its path, chain code, private key and
 * public key, which SLIP-0010 writes as 0x00 followed by the 32-byte ed25519 public key.
 */
const SLIP10_ED25519_VECTOR_1: Array<[path: string, chainCode: string, privateKey: string, publicKey: string]> = [
  [
    'm',
    '90046a93de5380a72b5e45010748567d5ea02bbf6522f979e05c0d8d8ca9fffb',
    '2b4be7f19ee27bbf30c667b642d5f4aa69fd169872f8fc3059c08ebae2eb19e7',
    '00a4b2856bfec510abab89753fac1ac0e1112364e7d250545963f135f2a33188ed',
  ],
  [
    "m/0'",
    '8b59aa11380b624e81507a27fedda59fea6d0b779a778918a2fd3590e16e9c69',
    '68e0fe46dfb67e368c75379acec591dad19df3cde26e63b93a8e704f1dade7a3',
    '008c8a13df77a28f3445213a0f432fde644acaa215fc72dcdf300d5efaa85d350c',
  ],
  [
    "m/0'/1'",
    'a320425f77d1b5c2505a6b1b27382b37368ee640e3557c315416801243552f14',
    'b1d0bad404bf35da785a64ca1ac54b2617211d2777696fbffaf208f746ae84f2',
    '001932a5270f335bed617d5b935c80aedb1a35bd9fc1e31acafd5372c30f5c1187',
  ],
  [
    "m/0'/1'/2'",
    '2e69929e00b5ab250f49c3fb1c12f252de4fed2c1db88387094a0f8c4c9ccd6c',
    '92a5b23c0b8a99e37d07df3fb9966917f5d06e02ddbd909c7e184371463e9fc9',
    '00ae98736566d30ed0e9d2f4486a64bc95740d89c7db33f52121f8ea8f76ff0fc1',
  ],
  [
    "m/0'/1'/2'/2'",
    '8f6d87f93d750e0efccda017d662a1b31a266e4a6f5993b15f5c1f07f74dd5cc',
    '30d1dc7e5fc04c31219ab25a27ae00b50f6fd66622f6e9c913253d6511d1e662',
    '008abae2d66361c879b900d204ad2cc4984fa2aa344dd7ddc46007329ac76c429c',
  ],
  [
    "m/0'/1'/2'/2'/1000000000'",
    '68789923a0cac2cd5a29172a475fe9e0fb14cd6adb5ad98a3fa70333e7afa230',
    '8f94d394a8e8fd6b1bc2f3f49f5c47e385281d5c17e65324b0f62483e37e8793',
    '003c24da049451555d51a7014a37337aa4e12d41e485abccfa46b47dfb2af54b7a',
  ],
];

describe('slip10Derive and ed25519PublicKey', () => {
  it.each(SLIP10_ED25519_VECTOR_1)('give SLIP-10 ed25519 test vector 1 at %s', (path, chainCode, privateKey, publicKey) => {
    const node = slip10Derive(SLIP10_SEED, path);
    expect(node.chainCode.toString('hex')).toBe(chainCode);
    expect(node.key.toString('hex')).toBe(privateKey);
    expect(`00${ed25519PublicKey(node.key).toString('hex')}`).toBe(publicKey);
  });
});

describe('normalisePhrase', () => {
  it('splits on any whitespace, lowercases each word, and joins them with single spaces', () => {
    expect(normalisePhrase(MESSY)).toBe(PHRASE);
  });

  it('keeps a phrase of 12 or 24 words that is already normalised as it is', () => {
    expect(normalisePhrase(PHRASE)).toBe(PHRASE);
    expect(normalisePhrase(PHRASE_24)).toBe(PHRASE_24);
  });

  it.each([0, 1, 11, 13, 23, 25])('refuses %i words with a SeedPhraseError that gives the count and no word', (count) => {
    let error: unknown;
    try {
      normalisePhrase(` ${'abandon '.repeat(count)}`);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(SeedPhraseError);
    expect((error as SeedPhraseError).words).toBe(count);
    expect((error as Error).message).toBe(`a seed phrase has 12 or 24 words, not ${count}`);
  });
});

describe('bip39Seed', () => {
  it("gives BIP-39's reference seed of the 12-word test phrase with the passphrase TREZOR", () => {
    expect(bip39Seed(PHRASE, 'TREZOR').toString('hex')).toBe(
      'c55257c360c07c72029aebc1b53c05ed0362ada38ead3e3e9efa3708e53495531f09a6987599d18264c1e1c92f2cf141630c7a3c4ab7c81b2f001698e7463b04',
    );
  });

  it("gives BIP-39's reference seed of the 24-word test phrase with the passphrase TREZOR", () => {
    expect(bip39Seed(PHRASE_24, 'TREZOR').toString('hex')).toBe(
      'bda85446c68413707090a52022edd26a1c9462295029f2e60cd7c4f2bbd3097170af7a4d73245cafa9c3cca8d561a7c3de6f5d4a10be8ed2a5e608d68f92fcc8',
    );
  });

  it('is 64 bytes, with an empty passphrase by default', () => {
    expect(bip39Seed(PHRASE)).toHaveLength(64);
    expect(bip39Seed(PHRASE).equals(bip39Seed(PHRASE, ''))).toBe(true);
    expect(bip39Seed(PHRASE).equals(bip39Seed(PHRASE, 'TREZOR'))).toBe(false);
  });

  it('normalises the passphrase to NFKD, as BIP-39 does', () => {
    expect(bip39Seed(PHRASE, 'é').equals(bip39Seed(PHRASE, 'é'))).toBe(true);
  });
});

describe('parsePath', () => {
  it.each<[string, number[]]>([
    ['m', []],
    ["m/44'/397'/0'", [44, 397, 0]],
    ["m/0'/1'/2'/2'/1000000000'", [0, 1, 2, 2, 1_000_000_000]],
    ["m/2147483647'", [2_147_483_647]],
  ])('reads %s', (path, indices) => {
    expect(parsePath(path)).toEqual(indices);
  });

  it.each(["m/44'/397'/0", "m/44/397'/0'", "44'/397'/0'", "m/44'/", "m/01'", "m/-1'", "m/2147483648'", 'm/0h', '', "M/0'"])(
    'refuses %j: SLIP-10 derives ed25519 keys at hardened indices below 2^31 only',
    (path) => {
      expect(() => parsePath(path)).toThrow(RangeError);
    },
  );
});

describe('the paths of the roles', () => {
  it('gives the parent, funding, pools, provider, MCP buyer and credential keys their paths', () => {
    expect([PARENT_PATH, FUNDING_PATH, POOLS_PATH, PROVIDER_PATH, MCP_BUYER_PATH, CREDENTIAL_PATH]).toEqual([
      "m/44'/397'/0'",
      "m/44'/397'/1'",
      "m/44'/397'/2'",
      "m/44'/397'/3'",
      "m/44'/397'/199'",
      "m/44'/397'/900'",
    ]);
  });

  it("numbers the relayer's keys from m/44'/397'/10', for up to 90 keys", () => {
    expect(MAX_RELAYER_KEYS).toBe(90);
    expect(relayerKeyPath(0)).toBe("m/44'/397'/10'");
    expect(relayerKeyPath(1)).toBe("m/44'/397'/11'");
    expect(relayerKeyPath(89)).toBe("m/44'/397'/99'");
  });

  it.each([-1, 90, 1.5])('refuses relayer key index %d', (index) => {
    expect(() => relayerKeyPath(index)).toThrow(RangeError);
  });

  it("gives buyer-NN m/44'/397'/(100 + NN)', from buyer-01 to buyer-20", () => {
    expect(SCRIPTED_BUYERS).toBe(20);
    expect(scriptedBuyerPath(1)).toBe("m/44'/397'/101'");
    expect(scriptedBuyerPath(20)).toBe("m/44'/397'/120'");
  });

  it.each([0, 21])('refuses scripted buyer %i', (number) => {
    expect(() => scriptedBuyerPath(number)).toThrow(RangeError);
  });
});

describe('nearKey', () => {
  const seed = bip39Seed(PHRASE);

  it("gives the parent key near-cli-rs derives from the public test phrase at m/44'/397'/0'", () => {
    // Fails here until Step 1's key replaces the marker.
    expect(NEAR_CLI_RS_PARENT_KEY).toMatch(/^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/);
    expect(nearKey(seed, PARENT_PATH).publicKey).toBe(NEAR_CLI_RS_PARENT_KEY);
  });

  it("gives the key pair near-api-js's seed-phrase module derives at NEAR's standard path", () => {
    const reference = parseSeedPhrase(PHRASE);
    const derived = nearKey(seed, PARENT_PATH);
    expect(derived.publicKey).toBe(reference.getPublicKey().toString());
    expect(derived.keyPair.toString()).toBe(reference.toString());
  });

  it('writes the secret key as near-cli does: the 32-byte private key, then the 32-byte public key, in base58', () => {
    const path = "m/44'/397'/2'";
    const derived = nearKey(seed, path);
    expect(derived.path).toBe(path);
    const secret = baseDecode(derived.keyPair.toString().slice('ed25519:'.length));
    const publicKey = baseDecode(derived.publicKey.slice('ed25519:'.length));
    expect(secret).toHaveLength(64);
    expect(publicKey).toHaveLength(32);
    expect(Buffer.from(secret.subarray(0, 32)).equals(slip10Derive(seed, path).key)).toBe(true);
    expect(Buffer.from(secret.subarray(32)).equals(Buffer.from(publicKey))).toBe(true);
    expect(KeyPair.fromString(derived.keyPair.toString() as KeyPairString).getPublicKey().toString()).toBe(derived.publicKey);
    expect(derived.keyPair.getPublicKey().toString()).toBe(derived.publicKey);
  });

  it('gives the same key for the phrase written with capitals, line breaks and extra spaces', () => {
    const messy = nearKey(bip39Seed(normalisePhrase(MESSY)), PARENT_PATH);
    expect(messy.keyPair.toString()).toBe(nearKey(seed, PARENT_PATH).keyPair.toString());
  });

  it('gives another key at another path', () => {
    expect(nearKey(seed, FUNDING_PATH).publicKey).not.toBe(nearKey(seed, PARENT_PATH).publicKey);
  });
});

describe('credentialJwk', () => {
  const seed = bip39Seed(PHRASE);

  it("is a private Ed25519 JWK with only kty, crv, x and d, derived at m/44'/397'/900'", () => {
    const jwk = credentialJwk(seed);
    expect(Object.keys(jwk).sort()).toEqual(['crv', 'd', 'kty', 'x']);
    expect([jwk.kty, jwk.crv]).toEqual(['OKP', 'Ed25519']);
    expect(Buffer.from(jwk.d, 'base64url').equals(slip10Derive(seed, CREDENTIAL_PATH).key)).toBe(true);
    expect(createPublicKey(createPrivateKey({ key: { ...jwk }, format: 'jwk' })).export({ format: 'jwk' }).x).toBe(jwk.x);
  });

  it('is the same from the same phrase however it is written, so a credential issued before a restart still verifies after it', () => {
    expect(credentialJwk(bip39Seed(normalisePhrase(MESSY)))).toEqual(credentialJwk(seed));
  });
});
```

- [ ] **Step 3: Run it and see it fail**

Run: `pnpm --filter @quorum-on-near/swarm exec vitest run test/seed.test.ts`

Expected: FAIL. vitest reports `test/seed.test.ts` as a failed suite because `../src/seed.ts` does not
exist yet, and runs no test.

- [ ] **Step 4: Implement**

Create `apps/swarm/src/seed.ts`:

```ts
import { createHmac, createPrivateKey, pbkdf2Sync } from 'node:crypto';
import { baseEncode, KeyPair, type KeyPairString } from 'near-api-js';
import type { CredentialJwk } from './env-files.ts';

/**
 * Every key of the system, derived from one BIP-39 phrase with Node's built-in crypto only: the
 * phrase gives a BIP-39 seed (PBKDF2-HMAC-SHA512), and the seed gives an ed25519 key at each path by
 * SLIP-10, every level hardened, under NEAR's prefix m/44'/397'. The parent's path is NEAR's standard
 * one, so a NEAR wallet or near-cli-rs given the phrase derives the same parent key. Each key's path
 * comes from its role, never from an account's name. Nothing here puts the phrase, the seed or a
 * private key in an error message.
 */

/** The parent account's key: NEAR's standard path. */
export const PARENT_PATH = "m/44'/397'/0'";
/** The funding account's key, unless the funding account is the parent, which signs with the parent's key. */
export const FUNDING_PATH = "m/44'/397'/1'";
/** The pools account's key. */
export const POOLS_PATH = "m/44'/397'/2'";
/** The provider's key. */
export const PROVIDER_PATH = "m/44'/397'/3'";
/** The key of the MCP server's buyer. */
export const MCP_BUYER_PATH = "m/44'/397'/199'";
/** The gateway's credential key, which signs the access credentials it issues. */
export const CREDENTIAL_PATH = "m/44'/397'/900'";
/** The most keys the relayer may have: their paths, m/44'/397'/10' to m/44'/397'/99', end where the buyers' begin. */
export const MAX_RELAYER_KEYS = 90;
/** The scripted buyers the paths number, buyer-01 to buyer-20, at m/44'/397'/101' to m/44'/397'/120'. */
export const SCRIPTED_BUYERS = 20;

/** The path of the relayer's key `index`, from 0: m/44'/397'/(10 + index)'. Throws RangeError unless `index` is 0 to 89. */
export function relayerKeyPath(index: number): string {
  if (!Number.isInteger(index) || index < 0 || index >= MAX_RELAYER_KEYS) {
    throw new RangeError(`a relayer key index is an integer from 0 to ${MAX_RELAYER_KEYS - 1}, not ${index}`);
  }
  return `m/44'/397'/${10 + index}'`;
}

/** The path of the scripted buyer buyer-NN, NN being `number`: m/44'/397'/(100 + number)'. Throws RangeError unless it is 1 to 20. */
export function scriptedBuyerPath(number: number): string {
  if (!Number.isInteger(number) || number < 1 || number > SCRIPTED_BUYERS) {
    throw new RangeError(`a scripted buyer is numbered from 1 to ${SCRIPTED_BUYERS}, not ${number}`);
  }
  return `m/44'/397'/${100 + number}'`;
}

/** A phrase that does not have 12 or 24 words. The message gives the count, never a word of the phrase. */
export class SeedPhraseError extends Error {
  override name = 'SeedPhraseError';
  readonly words: number;

  constructor(words: number) {
    super(`a seed phrase has 12 or 24 words, not ${words}`);
    this.words = words;
  }
}

/**
 * The phrase as its seed is computed: its words, split on any whitespace, lowercased and joined with
 * single spaces, so that line breaks, extra spaces and capitals do not change the keys. Throws
 * SeedPhraseError unless it has 12 or 24 words. Neither the BIP-39 wordlist nor its checksum is
 * checked: a wrong phrase gives keys that no account holds, which the chain check finds.
 */
export function normalisePhrase(raw: string): string {
  const words = raw
    .split(/\s+/)
    .filter((word) => word !== '')
    .map((word) => word.toLowerCase());
  if (words.length !== 12 && words.length !== 24) throw new SeedPhraseError(words.length);
  return words.join(' ');
}

/**
 * The BIP-39 seed of `phrase`: PBKDF2-HMAC-SHA512 of the phrase, with the salt `mnemonic` followed by
 * `passphrase`, both normalised to NFKD and encoded in UTF-8, 2,048 iterations, 64 bytes. The swarm
 * always uses the empty passphrase; it is a parameter so that BIP-39's published vectors, made with
 * the passphrase "TREZOR", can be checked.
 */
export function bip39Seed(phrase: string, passphrase = ''): Buffer {
  const password = Buffer.from(phrase.normalize('NFKD'), 'utf8');
  const salt = Buffer.from(`mnemonic${passphrase}`.normalize('NFKD'), 'utf8');
  return pbkdf2Sync(password, salt, 2048, 64, 'sha512');
}

/** A SLIP-10 node: its 32-byte ed25519 private key and its 32-byte chain code. */
export interface ExtendedKey {
  key: Buffer;
  chainCode: Buffer;
}

/** 2^31, which SLIP-10 adds to an index to make it hardened. */
const HARDENED = 0x8000_0000;
/** `m`, then each level as decimal digits without a leading zero and a `'`. */
const PATH = /^m(\/(0|[1-9][0-9]*)')*$/;

/**
 * The indices of a derivation path such as m/44'/397'/0': every level hardened (`'`) and below 2^31,
 * since SLIP-10 derives ed25519 keys at hardened indices only. Throws RangeError for any other path.
 */
export function parsePath(path: string): number[] {
  if (!PATH.test(path)) throw new RangeError(`not a path of hardened indices: ${JSON.stringify(path)}`);
  const indices = path
    .split('/')
    .slice(1)
    .map((level) => Number(level.slice(0, -1)));
  if (indices.some((index) => index >= HARDENED)) throw new RangeError(`${JSON.stringify(path)} has an index of 2^31 or more`);
  return indices;
}

/** The two halves of an HMAC-SHA512 digest: the key, then the chain code. */
function split(digest: Buffer): ExtendedKey {
  return { key: digest.subarray(0, 32), chainCode: digest.subarray(32) };
}

/** SLIP-10's master node for ed25519: HMAC-SHA512 keyed with "ed25519 seed", over the seed. */
function masterKey(seed: Uint8Array): ExtendedKey {
  return split(createHmac('sha512', 'ed25519 seed').update(seed).digest());
}

/**
 * SLIP-10's hardened child for ed25519: HMAC-SHA512 keyed with the parent's chain code, over 0x00,
 * the parent's key, then index + 2^31 as 4 big-endian bytes.
 */
function hardenedChild(parent: ExtendedKey, index: number): ExtendedKey {
  const data = Buffer.alloc(37);
  parent.key.copy(data, 1);
  data.writeUInt32BE(index + HARDENED, 33);
  return split(createHmac('sha512', parent.chainCode).update(data).digest());
}

/** The SLIP-10 ed25519 node at `path` (parsePath) of `seed`. */
export function slip10Derive(seed: Uint8Array, path: string): ExtendedKey {
  return parsePath(path).reduce(hardenedChild, masterKey(seed));
}

/** The PKCS#8 DER header of an Ed25519 private key (RFC 8410), which node:crypto imports with the 32 raw bytes after it. */
const PKCS8_ED25519_HEADER = Buffer.from('302e020100300506032b657004220420', 'hex');

/** The JWK members of the Ed25519 key whose 32-byte private key is `privateKey`: `d` is that key, `x` its public key, both base64url. */
function ed25519Jwk(privateKey: Uint8Array): { x: string; d: string } {
  if (privateKey.length !== 32) throw new RangeError(`an ed25519 private key has 32 bytes, not ${privateKey.length}`);
  const key = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_HEADER, privateKey]), format: 'der', type: 'pkcs8' });
  const { x, d } = key.export({ format: 'jwk' });
  if (typeof x !== 'string' || typeof d !== 'string') throw new TypeError('node:crypto exported an Ed25519 key without x and d');
  return { x, d };
}

/** The 32-byte Ed25519 public key of a 32-byte private key. */
export function ed25519PublicKey(privateKey: Uint8Array): Buffer {
  return Buffer.from(ed25519Jwk(privateKey).x, 'base64url');
}

/** A NEAR key derived from a seed. */
export interface NearKey {
  /** The path it was derived at. */
  path: string;
  /** `ed25519:` and the base58 of its 32-byte public key, as NEAR writes public keys. */
  publicKey: string;
  /**
   * Its key pair, which near-api-js reads from `ed25519:` and the base58 of its 64-byte secret key:
   * the 32-byte private key, then the public key, as near-cli writes it in key files.
   */
  keyPair: KeyPair;
}

/** The NEAR key at `path` of `seed`. */
export function nearKey(seed: Uint8Array, path: string): NearKey {
  const { key } = slip10Derive(seed, path);
  const publicKey = ed25519PublicKey(key);
  const keyPair = KeyPair.fromString(`ed25519:${baseEncode(Buffer.concat([key, publicKey]))}` as KeyPairString);
  return { path, publicKey: `ed25519:${baseEncode(publicKey)}`, keyPair };
}

/** The gateway's credential key, at CREDENTIAL_PATH of `seed`, as the private JWK the gateway reads in QUORUM_CREDENTIAL_JWK. */
export function credentialJwk(seed: Uint8Array): CredentialJwk {
  const { x, d } = ed25519Jwk(slip10Derive(seed, CREDENTIAL_PATH).key);
  return { kty: 'OKP', crv: 'Ed25519', x, d };
}
```

- [ ] **Step 5: Run it and see it pass**

Run: `pnpm --filter @quorum-on-near/swarm exec vitest run test/seed.test.ts`

Expected: PASS, 47 tests (`Tests  47 passed (47)`). If only the near-cli-rs test fails while the
near-api-js test passes, the key copied in Step 1 is not the one near-cli-rs printed for that exact
phrase and path: run Step 1 again and compare, but do not change the derivation or the expected
value to make the test pass. If both fail, the derivation is wrong.

Run: `pnpm --filter @quorum-on-near/swarm typecheck`

Expected: exit code 0; after pnpm's two lines naming the script, `tsc` prints nothing.

Run: `pnpm typecheck`

Expected: exit code 0.

- [ ] **Step 6: Commit**

```bash
git add apps/swarm/src/seed.ts apps/swarm/test/seed.test.ts
git commit -F - <<'EOF'
derive the swarm's keys and the credential key from one phrase

seed.ts turns a BIP-39 phrase into its seed (PBKDF2-HMAC-SHA512) and derives ed25519 keys from the
seed by SLIP-10, every level hardened, under NEAR's prefix m/44'/397', with node:crypto only. Each
role has its own path: the parent NEAR's standard m/44'/397'/0', which wallets and near-cli-rs
derive from the same phrase, then the funding, pools and provider accounts, up to 90 relayer keys,
the scripted buyers, the MCP server's buyer and the gateway's credential key. NEAR keys come out as
near-api-js key pairs in near-cli's 64-byte form, and the credential key as the private JWK the
gateway reads. The tests check SLIP-10's and BIP-39's published vectors, near-api-js's own
seed-phrase derivation, and the parent key near-cli-rs prints for BIP-39's public test phrase.
EOF
```

### Task 3: `swarm keys from-seed`

The command of the hosted demo spec, section 3.2: every key file the swarm reads, and with
`--gateway-env` the gateway's two secrets, derived from one phrase and checked against the chain
before anything is written. It uses Task 2's `seed.ts`.

This task edits `apps/swarm/src/main.ts`, `apps/swarm/src/env-files.ts` and their tests as the swarm
and MCP server plan (`docs/plans/swarm-mcp.md`) leaves them on `main`. If the merged code names a
member differently (of `Cli`, `SwarmModules`, the `harness` of `main.test.ts`), keep the behaviour
below and adapt the names.

**Files:**
- Create: `apps/swarm/src/keys-from-seed.ts`
- Create: `apps/swarm/test/stub-seed-chain.ts` (test helper, not a test file)
- Modify: `apps/swarm/src/env-files.ts` (add `gatewaySecretsEnvText`; `gatewayEnvText` takes its two secret lines from the same helper)
- Modify: `apps/swarm/src/main.ts` (the `keys` command: `SwarmCommand`, `COMMANDS`, `USAGE`, `parseCommand`, `SwarmModules`, `Cli`, `execute`, the entry point)
- Test: `apps/swarm/test/keys-from-seed.test.ts`
- Modify: `apps/swarm/test/env-files.test.ts` (tests of `gatewaySecretsEnvText`)
- Modify: `apps/swarm/test/main.test.ts` (harness, stub module, `keys` tests)

**Interfaces:**
- Consumes:
  - From Task 2 (`apps/swarm/src/seed.ts`): `bip39Seed`, `normalisePhrase`, `SeedPhraseError`, `nearKey`, `type NearKey`, `credentialJwk`, `PARENT_PATH`, `FUNDING_PATH`, `POOLS_PATH`, `PROVIDER_PATH`, `MCP_BUYER_PATH`, `MAX_RELAYER_KEYS`, `relayerKeyPath`, `scriptedBuyerPath`.
  - From `@quorum-on-near/buyer`: `ConfigError` (constructor `(problems: readonly string[])`), `type Env`, `type BuyerSettings`, `keyFilePath(dir, network, accountId)`, `keyFolderPath(dir, network, accountId)`, `folderKeyPath(folder, publicKey)`, `readKeyFile(path): Promise<KeyPair>` (throws `KeyFileError` with `problem` `missing` for an absent or empty file, `invalid` for one that is not a key file), `writeKeyFile(path, accountId, keyPair)` (creates its folder with mode `0o700`, creates the file exclusively with mode `0o600` and flushes it, replaces an empty file once, throws `KeyFileError` `exists` otherwise), `KeyFileError`.
  - From the swarm: `isSubAccount(id, parent)` and `scriptedBuyerIds(parent)` (`accounts.ts`, buyer-01 to buyer-20 in that order), `checkChain(network, chain: Pick<SwarmChain, 'chainId'>)` (`chain.ts`, throws `ConfigError` on another chain), `type SwarmConfig` and `loadSwarmConfig` (`config.ts`), `writeEnvFile(path, text)` (`env-files.ts`: exclusive create, mode `0o600`, `EnvFileExistsError` when the file exists), the private `envText` and `EnvEntry` of `env-files.ts`.
  - From `near-api-js` 7.4.0: `JsonRpcProvider`, `type Provider` (`viewNodeStatus()`, `viewAccount({ accountId, blockQuery })`, `viewAccessKey({ accountId, publicKey, finalityQuery })`); from `near-api-js/rpc-errors`: `AccessKeyDoesNotExistError`, `AccountDoesNotExistError`.
- Produces:
  - `apps/swarm/src/keys-from-seed.ts`: `class KeysFromSeedError extends Error`; `type KeyPermission = 'full_access' | 'other'`; `interface SeedChain { chainId(): Promise<string>; accountExists(accountId: string): Promise<boolean>; accessKey(accountId: string, publicKey: string): Promise<KeyPermission | null> }`; `class RpcSeedChain implements SeedChain` (constructor `(provider: Provider)`); `createRpcSeedChain(settings: Pick<BuyerSettings, 'rpcUrl'>): RpcSeedChain`; `readSeedPhrase(env: Env): Promise<string>`; `parentPublicKey(phrase: string): string`; `seedAccountProblems(config: SwarmConfig): string[]`; `interface SeedAccount`, `interface SeedKeys`, `seedKeys(config: SwarmConfig, phrase: string): SeedKeys`; `interface KeysFromSeedDeps { chain: SeedChain; log: (line: string) => void }`; `interface KeysFromSeedOptions { gatewayEnv: string | null }`; `keysFromSeed(config: SwarmConfig, phrase: string, deps: KeysFromSeedDeps, options: KeysFromSeedOptions): Promise<void>`.
  - `apps/swarm/src/env-files.ts`: `gatewaySecretsEnvText(relayerKeys: readonly KeyPair[], credentialJwk: CredentialJwk): string`.
  - `apps/swarm/src/main.ts`: `SwarmCommand` gains `{ name: 'keys'; parentKey: boolean; gatewayEnv: string | null }`; `SwarmModules` gains `keysFromSeed`; `Cli` gains `seedChain: (config: SwarmConfig) => SeedChain`.
  - The command line, for the start script and the bootstrap: `node apps/swarm/src/main.ts keys from-seed [--gateway-env <path> | --parent-key]`. It reads the phrase from `QUORUM_SEED_PHRASE` or `QUORUM_SEED_PHRASE_FILE`, the accounts from the swarm's usual `QUORUM_*` variables (`QUORUM_CREDENTIALS_DIR` among them). `--parent-key` prints the parent's public key alone on one line (`ed25519:<base58>`), so `"$(… --parent-key)"` gives the key. Without it, stdout has one line per key, `<account>  <public key>` (two spaces), the relayer once per key, then `credential  <x>`. Exit 0 when done, 1 on any refusal or failure (message on stderr), 2 for wrong arguments.

What the chain reads rely on, checked in `near-api-js` 7.4.0's sources: `viewAccessKey` sends the
`query` `view_access_key` with the given finality and returns `{ nonce, permission }`, where
`permission` is the string `'FullAccess'` for a full-access key and an object for any other key (a
function-call key, a gas key). A missing key rejects `AccessKeyDoesNotExistError`, whether the node
answers with the structured `UNKNOWN_ACCESS_KEY` error or with the older `result.error` text
(`access key … does not exist while viewing`); a missing account rejects `AccountDoesNotExistError`
in either form, from `view_access_key` as from `view_account`. Other errors, a failed request among
them, pass through as they are.

- [ ] **Step 1: Write the failing tests**

Create the stub chain the tests use, `apps/swarm/test/stub-seed-chain.ts`:

```ts
import type { KeyPermission, SeedChain } from '../src/keys-from-seed.ts';

/**
 * The chain `swarm keys from-seed` reads, in memory: the accounts that exist, each with the public
 * keys it holds and how. Every read is recorded in `reads`; with `down` set, every read fails as a
 * request to an RPC that cannot be reached does.
 */
export class StubSeedChain implements SeedChain {
  /** The `chain_id` the node reports. */
  nodeChainId = 'testnet';
  /** When true, every read rejects with `fetch failed`, after it is recorded. */
  down = false;
  /** `chainId`, `account <id>` and `key <id> <public key>`, in the order read. */
  readonly reads: string[] = [];
  readonly #accounts = new Map<string, Map<string, KeyPermission>>();

  /** Makes `accountId` exist, if it did not, and hold `publicKey` with `permission`. */
  hold(accountId: string, publicKey: string, permission: KeyPermission = 'full_access'): this {
    const keys = this.#accounts.get(accountId) ?? new Map<string, KeyPermission>();
    keys.set(publicKey, permission);
    this.#accounts.set(accountId, keys);
    return this;
  }

  async chainId(): Promise<string> {
    this.#read('chainId');
    return this.nodeChainId;
  }

  async accountExists(accountId: string): Promise<boolean> {
    this.#read(`account ${accountId}`);
    return this.#accounts.has(accountId);
  }

  async accessKey(accountId: string, publicKey: string): Promise<KeyPermission | null> {
    this.#read(`key ${accountId} ${publicKey}`);
    return this.#accounts.get(accountId)?.get(publicKey) ?? null;
  }

  #read(what: string): void {
    this.reads.push(what);
    if (this.down) throw new Error('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:3030') });
  }
}
```

Create `apps/swarm/test/keys-from-seed.test.ts`:

```ts
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseEnv } from 'node:util';
import {
  ConfigError,
  folderKeyPath,
  keyFilePath,
  keyFolderPath,
  readKeyFile,
  readKeyFolder,
  writeKeyFile,
  type Env,
} from '@quorum-on-near/buyer';
import { KeyPair, PublicKey, type Provider } from 'near-api-js';
import { AccessKeyDoesNotExistError, AccountDoesNotExistError, UnknownBlockError } from 'near-api-js/rpc-errors';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// The gateway's own loader, from its sources, as env-files.test.ts reads it: the swarm itself never
// imports another app.
import { loadConfig } from '../../gateway/src/config.ts';
import { loadSwarmConfig, type SwarmConfig } from '../src/config.ts';
import {
  keysFromSeed,
  KeysFromSeedError,
  parentPublicKey,
  readSeedPhrase,
  RpcSeedChain,
  type SeedChain,
} from '../src/keys-from-seed.ts';
import { bip39Seed, credentialJwk, nearKey } from '../src/seed.ts';
import { PARENT, POOLS, PROVIDER } from './fake-chain.ts';
import { StubSeedChain } from './stub-seed-chain.ts';

/** BIP-39's public 12-word test phrase: anyone can derive its keys. */
const PHRASE = `${'abandon '.repeat(11)}about`;
/** BIP-39's public 24-word test phrase. */
const PHRASE_24 = `${'abandon '.repeat(23)}art`;
/** PHRASE as it may be typed or pasted: capitals, line breaks, a tab and extra spaces. */
const MESSY = `\n  ABANDON abandon\tabandon\r\nAbandon ${'abandon '.repeat(7)}  ABOUT\n`;
const SEED = bip39Seed(PHRASE);

const FUNDING = `funding.${PARENT}`;
const RELAYER = `relay.${PARENT}`;
const MCP_BUYER = `buyer-llm.${PARENT}`;
const BUYER_01 = `buyer-01.${PARENT}`;
const BUYERS = Array.from({ length: 20 }, (_, i) => `buyer-${String(i + 1).padStart(2, '0')}.${PARENT}`);

/** What the phrase gives at m/44'/397'/<index>'. */
const key = (index: number) => nearKey(SEED, `m/44'/397'/${index}'`);
const pub = (index: number): string => key(index).publicKey;
const randomKey = (): string => KeyPair.fromRandom('ed25519').getPublicKey().toString();

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'quorum-keys-from-seed-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** The configuration of PARENT, its key files under the temporary folder, two relayer keys, and `env` over it. */
function config(env: Env = {}): SwarmConfig {
  return loadSwarmConfig({
    QUORUM_PARENT_ACCOUNT: PARENT,
    QUORUM_CREDENTIALS_DIR: join(dir, 'keys'),
    QUORUM_RELAYER_KEY_COUNT: '2',
    ...env,
  });
}

/** A chain on which only the parent exists, holding the phrase's parent key with full access. */
function parentOnly(): StubSeedChain {
  return new StubSeedChain().hold(PARENT, pub(0));
}

/** Runs keysFromSeed with PHRASE and returns the lines it logged. */
async function run(cfg: SwarmConfig, chain: SeedChain, gatewayEnv: string | null = null): Promise<string[]> {
  const lines: string[] = [];
  await keysFromSeed(cfg, PHRASE, { chain, log: (line) => lines.push(line) }, { gatewayEnv });
  return lines;
}

/** The error `promise` rejects with; fails the test if it resolves. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('the promise resolved');
}

/** Every file and folder under the temporary folder, relative to it, sorted. */
async function written(): Promise<string[]> {
  return (await readdir(dir, { recursive: true })).sort();
}

/** Each file under the temporary folder, with its content and its modification time. */
async function snapshot(): Promise<Record<string, [content: string, mtimeMs: number]>> {
  const files: Record<string, [string, number]> = {};
  for (const entry of await written()) {
    const info = await stat(join(dir, entry));
    if (info.isFile()) files[entry] = [await readFile(join(dir, entry), 'utf8'), info.mtimeMs];
  }
  return files;
}

const keyFile = (accountId: string): string => keyFilePath(join(dir, 'keys'), 'near:testnet', accountId);
const relayerFolder = (): string => keyFolderPath(join(dir, 'keys'), 'near:testnet', RELAYER);

describe('readSeedPhrase', () => {
  it('reads QUORUM_SEED_PHRASE, split on any whitespace, lowercased and joined with single spaces', async () => {
    expect(await readSeedPhrase({ QUORUM_SEED_PHRASE: MESSY })).toBe(PHRASE);
  });

  it('reads the file QUORUM_SEED_PHRASE_FILE names', async () => {
    const path = join(dir, 'phrase.txt');
    await writeFile(path, `${PHRASE.replaceAll(' ', '\n')}\n`);
    expect(await readSeedPhrase({ QUORUM_SEED_PHRASE_FILE: path })).toBe(PHRASE);
  });

  it('accepts a phrase of 24 words', async () => {
    expect(await readSeedPhrase({ QUORUM_SEED_PHRASE: PHRASE_24 })).toBe(PHRASE_24);
  });

  it('refuses both variables at once, naming them and quoting neither', async () => {
    const path = join(dir, 'phrase.txt');
    await writeFile(path, PHRASE);
    const error = await rejection(readSeedPhrase({ QUORUM_SEED_PHRASE: PHRASE, QUORUM_SEED_PHRASE_FILE: path }));
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toBe('QUORUM_SEED_PHRASE and QUORUM_SEED_PHRASE_FILE are both set: set only one of them');
  });

  it.each<Env>([{}, { QUORUM_SEED_PHRASE: '', QUORUM_SEED_PHRASE_FILE: '' }])('refuses %j: neither variable is set', async (env) => {
    const error = await rejection(readSeedPhrase(env));
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toBe(
      'QUORUM_SEED_PHRASE or QUORUM_SEED_PHRASE_FILE is required: the seed phrase, or the absolute path of a file that holds it',
    );
  });

  it.each([0, 1, 11, 13, 23, 25])('refuses a phrase of %i words, giving the count and no word of it', async (count) => {
    const error = await rejection(readSeedPhrase({ QUORUM_SEED_PHRASE: ` ${'abandon '.repeat(count)}` }));
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toBe(`QUORUM_SEED_PHRASE must hold a phrase of 12 or 24 words, not ${count}`);
  });

  it('names the file whose phrase does not have 12 or 24 words, and quotes nothing of it', async () => {
    const path = join(dir, 'phrase.txt');
    await writeFile(path, 'abandon about\n');
    const error = await rejection(readSeedPhrase({ QUORUM_SEED_PHRASE_FILE: path }));
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toBe(`the file QUORUM_SEED_PHRASE_FILE names, ${path}, must hold a phrase of 12 or 24 words, not 2`);
  });

  it('refuses a QUORUM_SEED_PHRASE_FILE that is not an absolute path without quoting it: it may be a phrase set there by mistake', async () => {
    const error = await rejection(readSeedPhrase({ QUORUM_SEED_PHRASE_FILE: PHRASE }));
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toBe('QUORUM_SEED_PHRASE_FILE must be an absolute path');
  });

  it('names a file it cannot read, with the reason', async () => {
    const path = join(dir, 'missing.txt');
    const error = await rejection(readSeedPhrase({ QUORUM_SEED_PHRASE_FILE: path }));
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toBe(`QUORUM_SEED_PHRASE_FILE names ${path}, which cannot be read (ENOENT)`);
  });
});

describe('parentPublicKey', () => {
  it("is the key at m/44'/397'/0' of the phrase, however it is written", () => {
    expect(parentPublicKey(MESSY)).toBe(pub(0));
  });
});

describe('keysFromSeed: the accounts', () => {
  it.each<[string, string]>([
    ['QUORUM_POOLS_ACCOUNT', 'pools.elsewhere.testnet'],
    ['QUORUM_RELAYER_ACCOUNT', 'relay.testnet'],
    ['QUORUM_PROVIDER_ACCOUNT', `seller.${PROVIDER}`],
    ['QUORUM_MCP_ACCOUNT', 'agent.testnet'],
    ['QUORUM_FUNDING_ACCOUNT', 'bank.testnet'],
  ])('refuses %s=%s, not a direct sub-account of the parent, before it reads the chain', async (name, id) => {
    const chain = parentOnly();
    const error = await rejection(run(config({ [name]: id }), chain));
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toContain(`${name} must be a direct sub-account of QUORUM_PARENT_ACCOUNT ${PARENT}`);
    expect((error as Error).message).toContain(`got ${JSON.stringify(id)}`);
    expect(chain.reads).toEqual([]);
    expect(await written()).toEqual([]);
  });

  it('accepts a funding account that is the parent: it signs with the parent key, and no key is derived for it', async () => {
    const lines = await run(config({ QUORUM_FUNDING_ACCOUNT: PARENT }), parentOnly());
    expect(lines.filter((line) => line.startsWith(`${PARENT} `))).toEqual([`${PARENT}  ${pub(0)}`]);
    expect(lines.join('\n')).not.toContain(pub(1));
    expect(lines.some((line) => line.startsWith(`${FUNDING} `))).toBe(false);
    expect((await readKeyFile(keyFile(PARENT))).toString()).toBe(key(0).keyPair.toString());
    expect(await written()).not.toContain(join('keys', 'testnet', `${FUNDING}.json`));
  });

  it.each([0, 91])('refuses a relayer key count of %i, naming QUORUM_RELAYER_KEY_COUNT, before it reads the chain', async (count) => {
    const chain = parentOnly();
    const error = await rejection(run({ ...config(), relayerKeyCount: count }, chain));
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toBe(
      `QUORUM_RELAYER_KEY_COUNT must be from 1 to 90 for the relayer's keys to be derived from the seed phrase, got "${count}"`,
    );
    expect(chain.reads).toEqual([]);
    expect(await written()).toEqual([]);
  });

  it("accepts 90 relayer keys, at m/44'/397'/10' to m/44'/397'/99'", async () => {
    const lines = await run(config({ QUORUM_RELAYER_KEY_COUNT: '90' }), parentOnly());
    const relayer = lines.filter((line) => line.startsWith(`${RELAYER} `));
    expect(relayer).toHaveLength(90);
    expect(relayer[0]).toBe(`${RELAYER}  ${pub(10)}`);
    expect(relayer[89]).toBe(`${RELAYER}  ${pub(99)}`);
  });
});

describe('keysFromSeed: the chain check', () => {
  it('checks the chain id first, and refuses another chain than QUORUM_NETWORK names, writing nothing', async () => {
    const chain = parentOnly();
    chain.nodeChainId = 'mainnet';
    const error = await rejection(run(config(), chain, join(dir, 'gateway.env')));
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toContain('"mainnet"');
    expect(chain.reads).toEqual(['chainId']);
    expect(await written()).toEqual([]);
  });

  it("reads the parent's key, then whether each other account exists, and the keys of those that do", async () => {
    const chain = parentOnly().hold(PROVIDER, pub(3));
    await run(config(), chain);
    expect(chain.reads).toEqual([
      'chainId',
      `key ${PARENT} ${pub(0)}`,
      `account ${FUNDING}`,
      `account ${POOLS}`,
      `account ${RELAYER}`,
      `account ${PROVIDER}`,
      `key ${PROVIDER} ${pub(3)}`,
      ...BUYERS.map((id) => `account ${id}`),
      `account ${MCP_BUYER}`,
    ]);
  });

  /** Expects the parent to be refused with `found`, and nothing written. */
  async function expectParentRefused(chain: StubSeedChain, found: string): Promise<void> {
    const error = await rejection(run(config(), chain, join(dir, 'gateway.env')));
    expect(error).toBeInstanceOf(KeysFromSeedError);
    expect((error as Error).message).toBe(
      `the seed phrase does not hold a full-access key of the parent account ${PARENT} (QUORUM_PARENT_ACCOUNT): ` +
        `it gives ${pub(0)} at m/44'/397'/0', ${found}`,
    );
    expect(await written()).toEqual([]);
  }

  it('refuses a parent that holds the key without full access, and writes nothing', async () => {
    await expectParentRefused(new StubSeedChain().hold(PARENT, pub(0), 'other'), 'which the account holds without full access');
  });

  it('refuses a parent that does not hold the key, and writes nothing', async () => {
    await expectParentRefused(new StubSeedChain().hold(PARENT, randomKey()), 'which the account does not hold');
  });

  it('refuses a parent account that does not exist, and writes nothing', async () => {
    await expectParentRefused(new StubSeedChain(), 'which the account does not hold');
  });

  it('refuses an existing account that lacks its derived key, naming the account and the key, and writes nothing', async () => {
    const chain = parentOnly().hold(PROVIDER, randomKey());
    const error = await rejection(run(config(), chain, join(dir, 'gateway.env')));
    expect(error).toBeInstanceOf(KeysFromSeedError);
    expect((error as Error).message).toBe(
      `${PROVIDER} exists, but does not hold ${pub(3)}, the key the seed phrase gives it at m/44'/397'/3': ` +
        'the account was set up with another phrase or other keys',
    );
    expect(await written()).toEqual([]);
  });

  it('refuses a relayer that lacks one of its keys, naming that key, and writes nothing', async () => {
    const chain = parentOnly().hold(RELAYER, pub(10));
    const error = await rejection(run(config(), chain));
    expect(error).toBeInstanceOf(KeysFromSeedError);
    expect((error as Error).message).toContain(`${RELAYER} exists, but does not hold ${pub(11)}, the key the seed phrase gives it at m/44'/397'/11'`);
    expect(await written()).toEqual([]);
  });

  it('accepts existing accounts that hold their derived keys, other keys besides, and skips those that do not exist yet', async () => {
    const chain = parentOnly()
      .hold(FUNDING, pub(1))
      .hold(POOLS, pub(2))
      .hold(RELAYER, pub(10))
      .hold(RELAYER, pub(11))
      .hold(PROVIDER, pub(3))
      .hold(PROVIDER, randomKey())
      .hold(BUYER_01, pub(101));
    await run(config(), chain);
    expect((await readKeyFile(keyFile(PROVIDER))).toString()).toBe(key(3).keyPair.toString());
    expect((await readKeyFile(keyFile(MCP_BUYER))).toString()).toBe(key(199).keyPair.toString());
  });

  it('fails with the error of an RPC that cannot be read, and writes nothing', async () => {
    const chain = parentOnly();
    chain.down = true;
    const error = await rejection(run(config(), chain, join(dir, 'gateway.env')));
    expect((error as Error).message).toBe('fetch failed');
    expect(await written()).toEqual([]);
  });
});

describe('keysFromSeed: the key files', () => {
  it.each<[string, number]>([
    [PARENT, 0],
    [FUNDING, 1],
    [POOLS, 2],
    [PROVIDER, 3],
    [RELAYER, 10],
    [BUYER_01, 101],
    [`buyer-02.${PARENT}`, 102],
    [`buyer-20.${PARENT}`, 120],
    [MCP_BUYER, 199],
  ])("writes the key file of %s with the key at m/44'/397'/%i'", async (accountId, index) => {
    await run(config(), parentOnly());
    expect((await readKeyFile(keyFile(accountId))).toString()).toBe(key(index).keyPair.toString());
    expect(JSON.parse(await readFile(keyFile(accountId), 'utf8'))).toMatchObject({ account_id: accountId, public_key: pub(index) });
  });

  it("writes the relayer's key folder, one file per key, each named after its key", async () => {
    await run(config(), parentOnly());
    const keys = await readKeyFolder(relayerFolder());
    expect(keys.map((keyPair) => keyPair.toString()).sort()).toEqual([key(10).keyPair.toString(), key(11).keyPair.toString()].sort());
    const second = await readKeyFile(folderKeyPath(relayerFolder(), key(11).keyPair.getPublicKey()));
    expect(second.toString()).toBe(key(11).keyPair.toString());
  });

  it("writes nothing else: each account's key file and the relayer's key folder", async () => {
    await run(config(), parentOnly());
    const testnet = join('keys', 'testnet');
    const accounts = [PARENT, FUNDING, POOLS, RELAYER, PROVIDER, ...BUYERS, MCP_BUYER];
    expect(await written()).toEqual(
      [
        'keys',
        testnet,
        ...accounts.map((id) => join(testnet, `${id}.json`)),
        join(testnet, RELAYER),
        ...[10, 11].map((index) => join(testnet, RELAYER, `${pub(index).replace(':', '_')}.json`)),
      ].sort(),
    );
  });

  it.skipIf(process.platform === 'win32')('makes each key file readable by its owner only', async () => {
    await run(config(), parentOnly());
    const files = (await written()).filter((entry) => entry.endsWith('.json'));
    expect(files).toHaveLength(28);
    for (const entry of files) expect((await stat(join(dir, entry))).mode & 0o777).toBe(0o600);
  });

  it('prints one line per key, the account then its public key, the relayer once per key, the credential key last', async () => {
    expect(await run(config(), parentOnly())).toEqual([
      `${PARENT}  ${pub(0)}`,
      `${FUNDING}  ${pub(1)}`,
      `${POOLS}  ${pub(2)}`,
      `${RELAYER}  ${pub(10)}`,
      `${RELAYER}  ${pub(11)}`,
      `${PROVIDER}  ${pub(3)}`,
      ...BUYERS.map((id, i) => `${id}  ${pub(101 + i)}`),
      `${MCP_BUYER}  ${pub(199)}`,
      `credential  ${credentialJwk(SEED).x}`,
    ]);
  });

  it('changes nothing when run again: every file keeps its content and its time, and the lines are the same', async () => {
    const envPath = join(dir, 'gateway.env');
    const first = await run(config(), parentOnly(), envPath);
    const before = await snapshot();
    expect(await run(config(), parentOnly(), envPath)).toEqual(first);
    expect(await snapshot()).toEqual(before);
  });

  it('leaves alone a key file that holds the same key, in the form near-cli-rs writes', async () => {
    const text = `${JSON.stringify({ public_key: pub(0), private_key: key(0).keyPair.toString() })}\n`;
    await mkdir(dirname(keyFile(PARENT)), { recursive: true });
    await writeFile(keyFile(PARENT), text);
    await run(config(), parentOnly());
    expect(await readFile(keyFile(PARENT), 'utf8')).toBe(text);
  });

  it('refuses a key file that holds another key, naming it, leaves it as it is and writes nothing', async () => {
    const other = KeyPair.fromRandom('ed25519');
    await writeKeyFile(keyFile(PROVIDER), PROVIDER, other);
    const error = await rejection(run(config(), parentOnly(), join(dir, 'gateway.env')));
    expect(error).toBeInstanceOf(KeysFromSeedError);
    expect((error as Error).message).toBe(
      `the key file ${keyFile(PROVIDER)} holds another key than the seed phrase gives ${PROVIDER}; it is left as it is`,
    );
    expect((await readKeyFile(keyFile(PROVIDER))).toString()).toBe(other.toString());
    expect(await written()).toEqual(['keys', join('keys', 'testnet'), join('keys', 'testnet', `${PROVIDER}.json`)].sort());
  });

  it("refuses a relayer key file that holds another of the relayer's keys than its first", async () => {
    await writeKeyFile(keyFile(RELAYER), RELAYER, key(11).keyPair);
    const error = await rejection(run(config(), parentOnly()));
    expect(error).toBeInstanceOf(KeysFromSeedError);
    expect((error as Error).message).toContain(`the key file ${keyFile(RELAYER)} holds another key`);
  });

  it('replaces an empty key file, which a write cut short leaves', async () => {
    await mkdir(dirname(keyFile(POOLS)), { recursive: true });
    await writeFile(keyFile(POOLS), '');
    await run(config(), parentOnly());
    expect((await readKeyFile(keyFile(POOLS))).toString()).toBe(key(2).keyPair.toString());
  });
});

describe('keysFromSeed: the gateway env file', () => {
  it("writes the relayer's keys in path order and the credential key, which the gateway's own loader reads", async () => {
    const path = join(dir, 'gateway.env');
    await run(config(), parentOnly(), path);
    const values = parseEnv(await readFile(path, 'utf8'));
    expect(Object.keys(values).sort()).toEqual(['QUORUM_CREDENTIAL_JWK', 'QUORUM_RELAYER_KEYS']);
    const gateway = loadConfig({ QUORUM_PARENT_ACCOUNT: PARENT, ...values });
    expect(gateway.relayerKeys).toEqual([key(10).keyPair.toString(), key(11).keyPair.toString()]);
    expect(gateway.credentialJwk).toEqual(credentialJwk(SEED));
  });

  it.skipIf(process.platform === 'win32')('makes the env file readable by its owner only', async () => {
    const path = join(dir, 'gateway.env');
    await run(config(), parentOnly(), path);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it('writes the same file from the same phrase: a credential issued before a restart still verifies after it', async () => {
    await run(config(), parentOnly(), join(dir, 'first.env'));
    await run(config(), parentOnly(), join(dir, 'second.env'));
    expect(await readFile(join(dir, 'second.env'), 'utf8')).toBe(await readFile(join(dir, 'first.env'), 'utf8'));
  });

  it('refuses an env file with other content, naming it, leaves it as it is and writes no key file', async () => {
    const path = join(dir, 'gateway.env');
    await writeFile(path, 'KEPT=1\n');
    const error = await rejection(run(config(), parentOnly(), path));
    expect(error).toBeInstanceOf(KeysFromSeedError);
    expect((error as Error).message).toBe(
      `the env file ${path} holds something else than the seed phrase gives; it is left as it is: remove it to write it again`,
    );
    expect(await readFile(path, 'utf8')).toBe('KEPT=1\n');
    expect(await written()).toEqual(['gateway.env']);
  });

  it('puts no part of the phrase in any file it writes, nor in its lines', async () => {
    const lines = await run(config(), parentOnly(), join(dir, 'gateway.env'));
    expect(lines.join('\n')).not.toContain('abandon');
    for (const entry of await written()) {
      const path = join(dir, entry);
      if ((await stat(path)).isFile()) expect(await readFile(path, 'utf8')).not.toContain('abandon');
    }
  });
});

/** A base58 block hash, for the RPC errors the tests throw. */
const BLOCK_HASH = '11111111111111111111111111111111';
const OPTIMISTIC = { finality: 'optimistic' };

/** An RpcSeedChain over a provider that answers each method with `answers[method]()`, recording each read. */
function rpcWith(answers: Record<string, () => unknown>) {
  const reads: Array<[method: string, params: unknown]> = [];
  const read = async (method: string, params: unknown): Promise<unknown> => {
    reads.push([method, params]);
    const answer = answers[method];
    if (answer === undefined) throw new Error(`no answer for ${method}`);
    return answer();
  };
  const provider = {
    viewNodeStatus: () => read('viewNodeStatus', undefined),
    viewAccount: (params: unknown) => read('viewAccount', params),
    viewAccessKey: (params: unknown) => read('viewAccessKey', params),
  };
  return { chain: new RpcSeedChain(provider as unknown as Provider), reads };
}

describe('RpcSeedChain', () => {
  it('chainId reads the node status', async () => {
    const { chain } = rpcWith({ viewNodeStatus: () => ({ chain_id: 'testnet' }) });
    expect(await chain.chainId()).toBe('testnet');
  });

  it('accountExists reads the account at optimistic finality: true when it exists, false when the RPC says it does not', async () => {
    const exists = rpcWith({ viewAccount: () => ({ amount: 1n, code_hash: BLOCK_HASH, storage_usage: 182 }) });
    expect(await exists.chain.accountExists(PROVIDER)).toBe(true);
    expect(exists.reads).toEqual([['viewAccount', { accountId: PROVIDER, blockQuery: OPTIMISTIC }]]);
    const missing = rpcWith({
      viewAccount: () => {
        throw new AccountDoesNotExistError(PROVIDER, BLOCK_HASH, 1_000);
      },
    });
    expect(await missing.chain.accountExists(PROVIDER)).toBe(false);
  });

  it('accountExists passes on any other error', async () => {
    const { chain } = rpcWith({
      viewAccount: () => {
        throw new UnknownBlockError();
      },
    });
    await expect(chain.accountExists(PROVIDER)).rejects.toBeInstanceOf(UnknownBlockError);
  });

  it('accessKey reads the key at optimistic finality: full_access for a full-access key, other for any other', async () => {
    const full = rpcWith({ viewAccessKey: () => ({ nonce: 1n, permission: 'FullAccess' }) });
    expect(await full.chain.accessKey(PARENT, pub(0))).toBe('full_access');
    expect(full.reads).toEqual([['viewAccessKey', { accountId: PARENT, publicKey: pub(0), finalityQuery: OPTIMISTIC }]]);
    const limited = rpcWith({
      viewAccessKey: () => ({ nonce: 1n, permission: { FunctionCall: { receiver_id: POOLS, method_names: [] } } }),
    });
    expect(await limited.chain.accessKey(PARENT, pub(0))).toBe('other');
  });

  it('accessKey is null when the RPC says the key, or the account, does not exist', async () => {
    const noKey = rpcWith({
      viewAccessKey: () => {
        throw new AccessKeyDoesNotExistError(PublicKey.fromString(pub(0)), BLOCK_HASH, 1_000);
      },
    });
    expect(await noKey.chain.accessKey(PARENT, pub(0))).toBeNull();
    const noAccount = rpcWith({
      viewAccessKey: () => {
        throw new AccountDoesNotExistError(PARENT, BLOCK_HASH, 1_000);
      },
    });
    expect(await noAccount.chain.accessKey(PARENT, pub(0))).toBeNull();
  });

  it('accessKey passes on any other error, such as a request that failed', async () => {
    const { chain } = rpcWith({
      viewAccessKey: () => {
        throw new Error('fetch failed');
      },
    });
    await expect(chain.accessKey(PARENT, pub(0))).rejects.toThrow('fetch failed');
  });
});
```

In `apps/swarm/test/env-files.test.ts`, add `gatewaySecretsEnvText` to the import from
`'../src/env-files.ts'`, which becomes:

```ts
import {
  aclNotice,
  EnvFileExistsError,
  envFilePath,
  gatewayEnvText,
  gatewaySecretsEnvText,
  mcpEnvText,
  newCredentialJwk,
  writeEnvFile,
  writeGatewayEnv,
  writeMcpEnv,
} from '../src/env-files.ts';
```

and add this block right after the `describe('gatewayEnvText', …)` block:

```ts
describe('gatewaySecretsEnvText', () => {
  it('holds QUORUM_RELAYER_KEYS, in the order given, and QUORUM_CREDENTIAL_JWK alone, on the lines gatewayEnvText writes for them', () => {
    const keys = [KeyPair.fromRandom('ed25519'), KeyPair.fromRandom('ed25519')];
    const jwk = newCredentialJwk();
    const text = gatewaySecretsEnvText(keys, jwk);
    expect(parseEnv(text)).toEqual({
      QUORUM_RELAYER_KEYS: keys.map((key) => key.toString()).join(','),
      QUORUM_CREDENTIAL_JWK: JSON.stringify(jwk),
    });
    const secretLines = (source: string): string[] =>
      source.split('\n').filter((line) => /^QUORUM_(RELAYER_KEYS|CREDENTIAL_JWK)=/.test(line));
    expect(secretLines(text)).toHaveLength(2);
    expect(secretLines(text)).toEqual(secretLines(gatewayEnvText(sandboxConfig(), keys, jwk)));
  });

  it('starts with comment lines saying what wrote it and that it is secret', () => {
    const text = gatewaySecretsEnvText([KeyPair.fromRandom('ed25519')], newCredentialJwk());
    expect(text.split('\n').slice(0, 2)).toEqual([
      '# Written by `swarm keys from-seed --gateway-env` from the seed phrase.',
      "# Secret: it holds the relayer's keys and the credential key. Keep it private, and never commit it.",
    ]);
  });

  it('needs at least one relayer key', () => {
    expect(() => gatewaySecretsEnvText([], newCredentialJwk())).toThrow(RangeError);
  });
});
```

In `apps/swarm/test/main.test.ts`, make these edits.

Replace the first import line:

```ts
import { mkdtemp, rm } from 'node:fs/promises';
```

with:

```ts
import { mkdtemp, readdir, rm } from 'node:fs/promises';
```

Replace:

```ts
import { aclNotice, EnvFileExistsError } from '../src/env-files.ts';
```

with:

```ts
import { aclNotice, EnvFileExistsError } from '../src/env-files.ts';
import { keysFromSeed } from '../src/keys-from-seed.ts';
```

Replace:

```ts
import { ShortfallError } from '../src/setup.ts';
import { FakeChain, PARENT, POOLS, poolView, PROVIDER } from './fake-chain.ts';
```

with:

```ts
import { bip39Seed, nearKey } from '../src/seed.ts';
import { ShortfallError } from '../src/setup.ts';
import { FakeChain, PARENT, POOLS, poolView, PROVIDER } from './fake-chain.ts';
import { StubSeedChain } from './stub-seed-chain.ts';
```

Replace:

```ts
const OPENED_POOL = 7;
```

with:

```ts
const OPENED_POOL = 7;
/** BIP-39's public 12-word test phrase: anyone can derive its keys. */
const PHRASE = `${'abandon '.repeat(11)}about`;
/** The parent key PHRASE gives, at m/44'/397'/0'. */
const PARENT_KEY = nearKey(bip39Seed(PHRASE), "m/44'/397'/0'").publicKey;
```

In `stubModules`, replace:

```ts
    writeMcpEnv: vi.fn<SwarmModules['writeMcpEnv']>(async () => {
      order.push('env mcp');
    }),
  };
}
```

with:

```ts
    writeMcpEnv: vi.fn<SwarmModules['writeMcpEnv']>(async () => {
      order.push('env mcp');
    }),
    keysFromSeed: vi.fn<SwarmModules['keysFromSeed']>(async () => {
      order.push('keys');
    }),
  };
}
```

In `harness`, replace:

```ts
  const connect = vi.fn<Cli['connect']>(() => ({ chain, gateway, buyerChain, pools }));
  const cli: Cli = {
    env,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    connect,
    runtime,
    modules,
    platform: 'linux',
    userName: () => 'ada',
  };
  return { cli, out, err, order, chain, gateway, buyerChain, pools, runtime, modules, connect };
```

with:

```ts
  const connect = vi.fn<Cli['connect']>(() => ({ chain, gateway, buyerChain, pools }));
  const keysChain = new StubSeedChain();
  const seedChain = vi.fn<Cli['seedChain']>(() => keysChain);
  const cli: Cli = {
    env,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    connect,
    seedChain,
    runtime,
    modules,
    platform: 'linux',
    userName: () => 'ada',
  };
  return { cli, out, err, order, chain, gateway, buyerChain, pools, runtime, modules, connect, keysChain, seedChain };
```

In the test `is what USAGE lists, command by command`, replace:

```ts
    for (const name of ['setup', 'open', 'run', 'check', 'demo', 'env', 'reset', 'help']) {
```

with:

```ts
    for (const name of ['setup', 'open', 'run', 'check', 'demo', 'env', 'keys', 'reset', 'help']) {
```

Add these two blocks right after the `describe('runCli: errors', …)` block, before
`interface Run`:

```ts
describe('parseCommand: keys', () => {
  it.each([
    [['keys', 'from-seed'], { name: 'keys', parentKey: false, gatewayEnv: null }],
    [['keys', 'from-seed', '--parent-key'], { name: 'keys', parentKey: true, gatewayEnv: null }],
    [['keys', 'from-seed', '--gateway-env', '/run/quorum/gateway.env'], { name: 'keys', parentKey: false, gatewayEnv: '/run/quorum/gateway.env' }],
  ])('reads %j', (argv, command) => {
    expect(parseCommand(argv)).toEqual(command);
  });

  it.each([
    [['keys']],
    [['keys', 'from-phrase']],
    [['keys', 'from-seed', '--gateway-env']],
    [['keys', 'from-seed', '--gateway-env', '']],
    [['keys', 'from-seed', '--parent-key', '--gateway-env', '/tmp/gateway.env']],
    [['keys', 'from-seed', '--gateway-env', '/tmp/gateway.env', '--parent-key']],
    [['keys', 'from-seed', '--parent-key', 'now']],
    [['keys', 'from-seed', '--verbose']],
  ])("refuses %j, giving the command's synopsis", (argv) => {
    expect(() => parseCommand(argv)).toThrow(UsageError);
    expect(() => parseCommand(argv)).toThrow('wrong arguments: the command is swarm keys from-seed [--gateway-env <path> | --parent-key]');
  });
});

describe('runCli: keys from-seed', () => {
  /** Runs `test` with a temporary credentials folder, removed after it. */
  async function withCredentials(test: (credentialsDir: string) => Promise<void>): Promise<void> {
    const credentialsDir = await mkdtemp(join(tmpdir(), 'quorum-main-keys-'));
    try {
      await test(credentialsDir);
    } finally {
      await rm(credentialsDir, { recursive: true, force: true });
    }
  }

  it('--parent-key prints the parent key alone, from the phrase alone: no configuration, no chain, no key file', async () => {
    // An invalid configuration without a parent account: --parent-key never reads it.
    const h = harness({ QUORUM_SEED_PHRASE: PHRASE, QUORUM_NETWORK: 'near:mainnet' });
    expect(await runCli(['keys', 'from-seed', '--parent-key'], h.cli)).toBe(0);
    expect(h.out).toEqual([PARENT_KEY]);
    expect(h.err).toEqual([]);
    expect(h.seedChain).not.toHaveBeenCalled();
    expect(h.connect).not.toHaveBeenCalled();
    expect(h.modules.keysFromSeed).not.toHaveBeenCalled();
  });

  it('runs keysFromSeed with the configuration, the phrase as normalised, the seed chain and the env file path, and connects nothing else', async () => {
    const h = harness({ ...ENV, QUORUM_SEED_PHRASE: `\n${PHRASE.toUpperCase()}  ` });
    expect(await runCli(['keys', 'from-seed', '--gateway-env', '/run/quorum/gateway.env'], h.cli)).toBe(0);
    expect(h.order).toEqual(['keys']);
    const [config, phrase, deps, options] = h.modules.keysFromSeed.mock.calls[0] ?? [];
    expect(config?.parent).toBe(PARENT);
    expect(phrase).toBe(PHRASE);
    expect(deps?.chain).toBe(h.keysChain);
    expect(options).toEqual({ gatewayEnv: '/run/quorum/gateway.env' });
    expect(h.seedChain.mock.calls[0]?.[0]).toBe(config);
    expect(h.connect).not.toHaveBeenCalled();
  });

  it('asks for no env file without --gateway-env', async () => {
    const h = harness({ ...ENV, QUORUM_SEED_PHRASE: PHRASE });
    expect(await runCli(['keys', 'from-seed'], h.cli)).toBe(0);
    expect(h.modules.keysFromSeed.mock.calls[0]?.[3]).toEqual({ gatewayEnv: null });
  });

  it.each<[string, Env, string]>([
    ['both variables are set', { QUORUM_SEED_PHRASE: PHRASE, QUORUM_SEED_PHRASE_FILE: '/run/secrets/phrase' }, 'QUORUM_SEED_PHRASE and QUORUM_SEED_PHRASE_FILE are both set'],
    ['neither variable is set', {}, 'QUORUM_SEED_PHRASE or QUORUM_SEED_PHRASE_FILE is required'],
    ['the phrase has 13 words', { QUORUM_SEED_PHRASE: `${PHRASE} abandon` }, 'must hold a phrase of 12 or 24 words, not 13'],
  ])('exits 1, running nothing and printing no part of the phrase, when %s', async (_, phraseEnv, problem) => {
    for (const argv of [['keys', 'from-seed'], ['keys', 'from-seed', '--parent-key']]) {
      const h = harness({ ...ENV, ...phraseEnv });
      expect(await runCli(argv, h.cli)).toBe(1);
      expect(h.err).toHaveLength(1);
      expect(h.err[0]).toMatch(/^invalid configuration:\n/);
      expect(h.err[0]).toContain(problem);
      expect(h.err[0]).not.toContain('abandon');
      expect(h.out).toEqual([]);
      expect(h.order).toEqual([]);
      expect(h.seedChain).not.toHaveBeenCalled();
    }
  });

  it('exits 1 naming QUORUM_RELAYER_KEY_COUNT above 90, reading no chain and writing nothing', async () => {
    await withCredentials(async (credentialsDir) => {
      const h = harness({ ...ENV, QUORUM_SEED_PHRASE: PHRASE, QUORUM_CREDENTIALS_DIR: credentialsDir, QUORUM_RELAYER_KEY_COUNT: '91' });
      h.modules.keysFromSeed.mockImplementation(keysFromSeed);
      expect(await runCli(['keys', 'from-seed'], h.cli)).toBe(1);
      expect(h.err).toEqual([
        'invalid configuration:\nQUORUM_RELAYER_KEY_COUNT must be from 1 to 90 for the relayer\'s keys to be derived from the seed phrase, got "91"',
      ]);
      expect(h.keysChain.reads).toEqual([]);
      expect(await readdir(credentialsDir)).toEqual([]);
    });
  });

  it('exits 1 when the phrase holds no full-access key of the parent, writing nothing and printing no part of the phrase', async () => {
    await withCredentials(async (credentialsDir) => {
      const h = harness({ ...ENV, QUORUM_SEED_PHRASE: PHRASE, QUORUM_CREDENTIALS_DIR: credentialsDir });
      h.modules.keysFromSeed.mockImplementation(keysFromSeed);
      h.keysChain.hold(PARENT, PARENT_KEY, 'other');
      expect(await runCli(['keys', 'from-seed'], h.cli)).toBe(1);
      expect(h.err).toHaveLength(1);
      expect(h.err[0]).toContain(`the seed phrase does not hold a full-access key of the parent account ${PARENT}`);
      expect([...h.out, ...h.err].join('\n')).not.toContain('abandon');
      expect(await readdir(credentialsDir)).toEqual([]);
    });
  });

  it('exits 1 when the RPC cannot be read, writing nothing', async () => {
    await withCredentials(async (credentialsDir) => {
      const h = harness({ ...ENV, QUORUM_SEED_PHRASE: PHRASE, QUORUM_CREDENTIALS_DIR: credentialsDir });
      h.modules.keysFromSeed.mockImplementation(keysFromSeed);
      h.keysChain.down = true;
      expect(await runCli(['keys', 'from-seed'], h.cli)).toBe(1);
      expect(h.err).toEqual(['fetch failed (connect ECONNREFUSED 127.0.0.1:3030)']);
      expect(await readdir(credentialsDir)).toEqual([]);
    });
  });

  it('exits 0 once the chain check passes, with one line per key on stdout and no part of the phrase', async () => {
    await withCredentials(async (credentialsDir) => {
      const h = harness({ ...ENV, QUORUM_SEED_PHRASE: PHRASE, QUORUM_CREDENTIALS_DIR: credentialsDir });
      h.modules.keysFromSeed.mockImplementation(keysFromSeed);
      h.keysChain.hold(PARENT, PARENT_KEY);
      expect(await runCli(['keys', 'from-seed'], h.cli)).toBe(0);
      expect(h.err).toEqual([]);
      expect(h.out[0]).toBe(`${PARENT}  ${PARENT_KEY}`);
      expect(h.out.at(-1)).toMatch(/^credential {2}[A-Za-z0-9_-]{43}$/);
      // The parent, funding, pools, 4 relayer keys (the default count), provider, 20 scripted buyers, the MCP buyer, the credential key.
      expect(h.out).toHaveLength(30);
      expect(h.out.join('\n')).not.toContain('abandon');
      expect(await readdir(credentialsDir)).toEqual(['testnet']);
    });
  });
});
```

In the `describe('main, as a process', …)` block, add this test after the last one:

```ts
  it('prints the parent key for keys from-seed --parent-key, with only the phrase set', async () => {
    // An empty QUORUM_SEED_PHRASE_FILE counts as unset, and keeps out any value apps/swarm/.env may give it.
    const { code, stdout, stderr } = await runMain(['keys', 'from-seed', '--parent-key'], {
      QUORUM_SEED_PHRASE: PHRASE,
      QUORUM_SEED_PHRASE_FILE: '',
    });
    expect(stderr).toBe('');
    expect(code).toBe(0);
    expect(stdout).toBe(`${PARENT_KEY}\n`);
  });
```

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm --filter @quorum-on-near/swarm exec vitest run test/keys-from-seed.test.ts test/env-files.test.ts test/main.test.ts`

Expected: FAIL. `test/keys-from-seed.test.ts` and `test/main.test.ts` fail as suites, without
running a test, because `../src/keys-from-seed.ts` does not exist yet. In
`test/env-files.test.ts`, the three `gatewaySecretsEnvText` tests fail, since `env-files.ts` does not
export it yet, and every other test passes.

- [ ] **Step 3: Add `gatewaySecretsEnvText` to `apps/swarm/src/env-files.ts`**

In `gatewayEnvText`, replace these two entries:

```ts
      ['QUORUM_RELAYER_KEYS', relayerKeys.map((key) => key.toString()).join(',')],
      ['QUORUM_CREDENTIAL_JWK', JSON.stringify(credentialJwk)],
```

with:

```ts
      ...secretEntries(relayerKeys, credentialJwk),
```

Add this function right after `gatewayEnvText`:

```ts
/**
 * The gateway's two secrets alone, as `swarm keys from-seed --gateway-env` writes them: the relayer's
 * keys (QUORUM_RELAYER_KEYS), in the order given, and the credential key (QUORUM_CREDENTIAL_JWK), on
 * the lines gatewayEnvText writes for them, checked with Node's parser in the same way. The gateway
 * reads its other variables from its environment. The same keys always give the same text. Throws
 * RangeError without a relayer key.
 */
export function gatewaySecretsEnvText(relayerKeys: readonly KeyPair[], credentialJwk: CredentialJwk): string {
  if (relayerKeys.length === 0) throw new RangeError('the gateway needs at least one key of the relayer');
  return envText(
    [
      'Written by `swarm keys from-seed --gateway-env` from the seed phrase.',
      "Secret: it holds the relayer's keys and the credential key. Keep it private, and never commit it.",
    ],
    secretEntries(relayerKeys, credentialJwk),
  );
}
```

Add this function right after `sharedEntries`:

```ts
/** The relayer's keys and the credential key, as the gateway reads them. */
function secretEntries(relayerKeys: readonly KeyPair[], credentialJwk: CredentialJwk): EnvEntry[] {
  return [
    ['QUORUM_RELAYER_KEYS', relayerKeys.map((key) => key.toString()).join(',')],
    ['QUORUM_CREDENTIAL_JWK', JSON.stringify(credentialJwk)],
  ];
}
```

`gatewayEnvText`'s text is unchanged: the same variables, in the same order.

- [ ] **Step 4: Create `apps/swarm/src/keys-from-seed.ts`**

```ts
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import {
  ConfigError,
  folderKeyPath,
  KeyFileError,
  keyFilePath,
  keyFolderPath,
  readKeyFile,
  writeKeyFile,
  type BuyerSettings,
  type Env,
} from '@quorum-on-near/buyer';
import { JsonRpcProvider, type KeyPair, type Provider } from 'near-api-js';
import { AccessKeyDoesNotExistError, AccountDoesNotExistError } from 'near-api-js/rpc-errors';
import { isSubAccount, scriptedBuyerIds } from './accounts.ts';
import { checkChain } from './chain.ts';
import type { SwarmConfig } from './config.ts';
import { gatewaySecretsEnvText, writeEnvFile, type CredentialJwk } from './env-files.ts';
import {
  bip39Seed,
  credentialJwk,
  FUNDING_PATH,
  MAX_RELAYER_KEYS,
  MCP_BUYER_PATH,
  nearKey,
  normalisePhrase,
  PARENT_PATH,
  POOLS_PATH,
  PROVIDER_PATH,
  relayerKeyPath,
  scriptedBuyerPath,
  SeedPhraseError,
  type NearKey,
} from './seed.ts';

/**
 * `swarm keys from-seed`: every key file the swarm reads, and optionally the gateway's two secrets,
 * derived from one BIP-39 phrase (seed.ts) and checked against the chain before anything is written.
 * The phrase is never printed, logged or put in a message, and neither is a private key.
 */

/**
 * Why `swarm keys from-seed` refused: the chain does not hold a derived key, or a file holds something
 * else. Messages name accounts, public keys and files, never a private key or the phrase.
 */
export class KeysFromSeedError extends Error {
  override name = 'KeysFromSeedError';
}

/** How an account holds a public key: as a full-access key, or with any other permission (a function-call key, a gas key). */
export type KeyPermission = 'full_access' | 'other';

/** What `swarm keys from-seed` reads from the chain. */
export interface SeedChain {
  /** The `chain_id` the RPC node reports, for checkChain. */
  chainId(): Promise<string>;
  /** Whether the account exists, at optimistic finality. */
  accountExists(accountId: string): Promise<boolean>;
  /** How the account holds `publicKey`, at optimistic finality; null when it does not, or when the account does not exist. */
  accessKey(accountId: string, publicKey: string): Promise<KeyPermission | null>;
}

const OPTIMISTIC = { finality: 'optimistic' } as const;

/**
 * SeedChain over near-api-js's JSON-RPC provider: the node status, then `view_account` and
 * `view_access_key` queries at optimistic finality.
 */
export class RpcSeedChain implements SeedChain {
  readonly #provider: Provider;

  constructor(provider: Provider) {
    this.#provider = provider;
  }

  async chainId(): Promise<string> {
    return (await this.#provider.viewNodeStatus()).chain_id;
  }

  async accountExists(accountId: string): Promise<boolean> {
    try {
      await this.#provider.viewAccount({ accountId, blockQuery: OPTIMISTIC });
      return true;
    } catch (error) {
      if (error instanceof AccountDoesNotExistError) return false;
      throw error;
    }
  }

  async accessKey(accountId: string, publicKey: string): Promise<KeyPermission | null> {
    try {
      const { permission } = await this.#provider.viewAccessKey({ accountId, publicKey, finalityQuery: OPTIMISTIC });
      return permission === 'FullAccess' ? 'full_access' : 'other';
    } catch (error) {
      // A node may answer a key of a missing account either way.
      if (error instanceof AccessKeyDoesNotExistError || error instanceof AccountDoesNotExistError) return null;
      throw error;
    }
  }
}

/** An RpcSeedChain on `settings.rpcUrl`, with near-api-js's default retries: it only reads. */
export function createRpcSeedChain(settings: Pick<BuyerSettings, 'rpcUrl'>): RpcSeedChain {
  return new RpcSeedChain(new JsonRpcProvider({ url: settings.rpcUrl }));
}

/**
 * The phrase, from QUORUM_SEED_PHRASE or from the file QUORUM_SEED_PHRASE_FILE names (an absolute
 * path), normalised (normalisePhrase). An empty variable counts as unset. Throws ConfigError when both
 * are set or neither is, when the file cannot be read, or when the phrase does not have 12 or 24
 * words. No message quotes the phrase, nor QUORUM_SEED_PHRASE_FILE unless it is an absolute path,
 * which a phrase set there by mistake never is.
 */
export async function readSeedPhrase(env: Env): Promise<string> {
  const inline = env.QUORUM_SEED_PHRASE ?? '';
  const file = env.QUORUM_SEED_PHRASE_FILE ?? '';
  if (inline !== '' && file !== '') {
    throw new ConfigError(['QUORUM_SEED_PHRASE and QUORUM_SEED_PHRASE_FILE are both set: set only one of them']);
  }
  if (inline === '' && file === '') {
    throw new ConfigError([
      'QUORUM_SEED_PHRASE or QUORUM_SEED_PHRASE_FILE is required: the seed phrase, or the absolute path of a file that holds it',
    ]);
  }
  const raw = inline !== '' ? inline : await readPhraseFile(file);
  try {
    return normalisePhrase(raw);
  } catch (error) {
    if (!(error instanceof SeedPhraseError)) throw error;
    const source = inline !== '' ? 'QUORUM_SEED_PHRASE' : `the file QUORUM_SEED_PHRASE_FILE names, ${file},`;
    throw new ConfigError([`${source} must hold a phrase of 12 or 24 words, not ${error.words}`]);
  }
}

/** The text of the phrase file at `path`. Throws ConfigError for a path that is not absolute, or a file that cannot be read. */
async function readPhraseFile(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new ConfigError(['QUORUM_SEED_PHRASE_FILE must be an absolute path']);
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'an error';
    throw new ConfigError([`QUORUM_SEED_PHRASE_FILE names ${path}, which cannot be read (${code})`]);
  }
}

/** The parent's public key, `ed25519:<base58>`, from the phrase alone: what `--parent-key` prints. */
export function parentPublicKey(phrase: string): string {
  return nearKey(bip39Seed(normalisePhrase(phrase)), PARENT_PATH).publicKey;
}

/**
 * What makes the configuration unfit for derived keys, one line per problem, each naming its
 * setting: an account that is not a direct sub-account of the parent (only the funding account may
 * also be the parent itself), and a relayer key count outside 1 to MAX_RELAYER_KEYS.
 */
export function seedAccountProblems(config: SwarmConfig): string[] {
  const { parent } = config;
  const settings: Array<[name: string, id: string]> = [
    ['QUORUM_FUNDING_ACCOUNT', config.funding],
    ['QUORUM_POOLS_ACCOUNT', config.poolsContract],
    ['QUORUM_RELAYER_ACCOUNT', config.relayer],
    ['QUORUM_PROVIDER_ACCOUNT', config.provider],
    ['QUORUM_MCP_ACCOUNT', config.mcpAccount],
  ];
  const problems: string[] = [];
  for (const [name, id] of settings) {
    const funding = name === 'QUORUM_FUNDING_ACCOUNT';
    if (isSubAccount(id, parent) || (funding && id === parent)) continue;
    const allowed = `a direct sub-account of QUORUM_PARENT_ACCOUNT ${parent}${funding ? ', or that account itself,' : ''}`;
    problems.push(`${name} must be ${allowed} to have its key derived from the seed phrase, got ${JSON.stringify(id)}`);
  }
  const count = config.relayerKeyCount;
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_RELAYER_KEYS) {
    problems.push(
      `QUORUM_RELAYER_KEY_COUNT must be from 1 to ${MAX_RELAYER_KEYS} for the relayer's keys to be derived from the seed phrase, got "${count}"`,
    );
  }
  return problems;
}

/** An account whose keys the phrase gives. */
export interface SeedAccount {
  id: string;
  /** Its keys, in path order: the relayer's QUORUM_RELAYER_KEY_COUNT keys, one for every other account. */
  keys: NearKey[];
  /** True for the relayer: its keys go to its key folder, one file each, and the first to its key file too. */
  keyFolder: boolean;
}

/** Every key the phrase gives a configuration. */
export interface SeedKeys {
  /**
   * The parent first, then the funding account unless it is the parent, the pools account, the
   * relayer, the provider, the scripted buyers buyer-01 to buyer-20, and the MCP server's buyer.
   */
  accounts: SeedAccount[];
  /** The relayer's key pairs in path order, as QUORUM_RELAYER_KEYS lists them. */
  relayerKeys: KeyPair[];
  /** The gateway's credential key, QUORUM_CREDENTIAL_JWK. */
  credential: CredentialJwk;
}

/**
 * Derives every key of the configuration from the phrase, which it normalises (a phrase from
 * readSeedPhrase is already). Each key's path comes from its account's role, never from its name.
 * Throws RangeError for more relayer keys than MAX_RELAYER_KEYS, which seedAccountProblems refuses first.
 */
export function seedKeys(config: SwarmConfig, phrase: string): SeedKeys {
  const seed = bip39Seed(normalisePhrase(phrase));
  const single = (id: string, path: string): SeedAccount => ({ id, keys: [nearKey(seed, path)], keyFolder: false });
  const relayerKeys = Array.from({ length: config.relayerKeyCount }, (_, index) => nearKey(seed, relayerKeyPath(index)));
  const accounts: SeedAccount[] = [
    single(config.parent, PARENT_PATH),
    ...(config.funding === config.parent ? [] : [single(config.funding, FUNDING_PATH)]),
    single(config.poolsContract, POOLS_PATH),
    { id: config.relayer, keys: relayerKeys, keyFolder: true },
    single(config.provider, PROVIDER_PATH),
    ...scriptedBuyerIds(config.parent).map((id, index) => single(id, scriptedBuyerPath(index + 1))),
    single(config.mcpAccount, MCP_BUYER_PATH),
  ];
  return { accounts, relayerKeys: relayerKeys.map((key) => key.keyPair), credential: credentialJwk(seed) };
}

/** What keysFromSeed works with besides the configuration and the phrase. */
export interface KeysFromSeedDeps {
  chain: SeedChain;
  /** Receives the output: one line per key. */
  log: (line: string) => void;
}

/** The options of `swarm keys from-seed`. */
export interface KeysFromSeedOptions {
  /** `--gateway-env <path>`: where to write the gateway's env file of QUORUM_RELAYER_KEYS and QUORUM_CREDENTIAL_JWK; null for none. */
  gatewayEnv: string | null;
}

/**
 * `swarm keys from-seed`. In order, writing nothing before step 4:
 *
 * 1. Refuses the configuration with ConfigError, one line per setting, for seedAccountProblems.
 * 2. Checks the chain: the RPC's chain id (checkChain, ConfigError); the parent's derived key must be
 *    a full-access key of QUORUM_PARENT_ACCOUNT; every other account that exists must hold each of
 *    its derived keys, the relayer each of its QUORUM_RELAYER_KEY_COUNT keys. An account that does
 *    not exist yet is skipped: setup creates it with the key file written here. Throws
 *    KeysFromSeedError otherwise, and an RPC that cannot be read throws its own error.
 * 3. Reads every file it is to write, in the layout the swarm reads: each account's key file, and the
 *    relayer's key folder with one file per key, its first key also in its key file. A file that holds
 *    the same key is left alone; one that holds another key throws KeysFromSeedError naming it, and
 *    one that is not a key file throws readKeyFile's KeyFileError. With `gatewayEnv`, the env file
 *    (gatewaySecretsEnvText) is read in the same way: an identical one is left alone, any other throws.
 * 4. Writes each missing key file (writeKeyFile: created exclusively, mode 0o600, flushed), then the
 *    env file if it is missing (writeEnvFile: created exclusively, mode 0o600).
 * 5. Logs one line per key, `<account>  <public key>`, the relayer once per key, then
 *    `credential  <x>`: the credential key's public key as the gateway's /.well-known/jwks.json gives it.
 *
 * Running it again therefore changes nothing.
 */
export async function keysFromSeed(
  config: SwarmConfig,
  phrase: string,
  deps: KeysFromSeedDeps,
  options: KeysFromSeedOptions,
): Promise<void> {
  const problems = seedAccountProblems(config);
  if (problems.length > 0) throw new ConfigError(problems);
  const keys = seedKeys(config, phrase);
  await checkSeedChain(config, keys, deps.chain);

  const missing = await missingKeyFiles(keyFiles(config, keys.accounts));
  const env = options.gatewayEnv === null ? null : { path: options.gatewayEnv, text: gatewaySecretsEnvText(keys.relayerKeys, keys.credential) };
  const writeEnv = env !== null && (await envFileMissing(env.path, env.text));

  for (const file of missing) await writeKeyFile(file.path, file.accountId, file.keyPair);
  if (env !== null && writeEnv) await writeEnvFile(env.path, env.text);

  for (const account of keys.accounts) {
    for (const key of account.keys) deps.log(`${account.id}  ${key.publicKey}`);
  }
  deps.log(`credential  ${keys.credential.x}`);
}

/** Step 2 of keysFromSeed. */
async function checkSeedChain(config: SwarmConfig, { accounts }: SeedKeys, chain: SeedChain): Promise<void> {
  await checkChain(config.network, chain);
  const [parent, ...others] = accounts;
  const parentKey = parent?.keys[0];
  if (parent === undefined || parentKey === undefined) throw new RangeError('no key was derived for the parent');
  const permission = await chain.accessKey(parent.id, parentKey.publicKey);
  if (permission !== 'full_access') {
    const found = permission === null ? 'which the account does not hold' : 'which the account holds without full access';
    throw new KeysFromSeedError(
      `the seed phrase does not hold a full-access key of the parent account ${parent.id} (QUORUM_PARENT_ACCOUNT): ` +
        `it gives ${parentKey.publicKey} at ${parentKey.path}, ${found}`,
    );
  }
  for (const account of others) {
    if (!(await chain.accountExists(account.id))) continue;
    for (const key of account.keys) {
      if ((await chain.accessKey(account.id, key.publicKey)) !== null) continue;
      throw new KeysFromSeedError(
        `${account.id} exists, but does not hold ${key.publicKey}, the key the seed phrase gives it at ${key.path}: ` +
          'the account was set up with another phrase or other keys',
      );
    }
  }
}

/** A key file to hold `keyPair`, as writeKeyFile writes it. */
interface KeyFile {
  path: string;
  accountId: string;
  keyPair: KeyPair;
}

/** Every key file of `accounts`, in the layout the swarm reads (SeedAccount.keyFolder). */
function keyFiles(config: SwarmConfig, accounts: readonly SeedAccount[]): KeyFile[] {
  const { credentialsDir, network } = config;
  return accounts.flatMap(({ id, keys, keyFolder }): KeyFile[] => {
    const folder = keyFolderPath(credentialsDir, network, id);
    const inFolder = keyFolder
      ? keys.map(({ keyPair }) => ({ path: folderKeyPath(folder, keyPair.getPublicKey()), accountId: id, keyPair }))
      : [];
    const first = keys[0];
    if (first === undefined) return inFolder;
    return [...inFolder, { path: keyFilePath(credentialsDir, network, id), accountId: id, keyPair: first.keyPair }];
  });
}

/**
 * The files of `files` still to be written: those that do not exist, or are empty (writeKeyFile
 * replaces an empty file, which a write cut short leaves). A file that holds the same key is left
 * out; one that holds another key throws KeysFromSeedError naming it; readKeyFile's KeyFileError
 * passes on for a file that is not a key file.
 */
async function missingKeyFiles(files: readonly KeyFile[]): Promise<KeyFile[]> {
  const missing: KeyFile[] = [];
  for (const file of files) {
    let held: KeyPair;
    try {
      held = await readKeyFile(file.path);
    } catch (error) {
      if (!(error instanceof KeyFileError && error.problem === 'missing')) throw error;
      missing.push(file);
      continue;
    }
    if (held.getPublicKey().toString() !== file.keyPair.getPublicKey().toString()) {
      throw new KeysFromSeedError(`the key file ${file.path} holds another key than the seed phrase gives ${file.accountId}; it is left as it is`);
    }
  }
  return missing;
}

/**
 * Whether the env file at `path` is still to be written: true when there is none, false when it holds
 * `text` already. Throws KeysFromSeedError, naming it, when it holds anything else.
 */
async function envFileMissing(path: string, text: string): Promise<boolean> {
  let held: string;
  try {
    held = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
  if (held === text) return false;
  throw new KeysFromSeedError(
    `the env file ${path} holds something else than the seed phrase gives; it is left as it is: remove it to write it again`,
  );
}
```

- [ ] **Step 5: Wire the command into `apps/swarm/src/main.ts`**

Replace:

```ts
import { aclNotice, envFilePath, writeGatewayEnv, writeMcpEnv, type EnvApp } from './env-files.ts';
```

with:

```ts
import { aclNotice, envFilePath, writeGatewayEnv, writeMcpEnv, type EnvApp } from './env-files.ts';
import { createRpcSeedChain, keysFromSeed, parentPublicKey, readSeedPhrase, type SeedChain } from './keys-from-seed.ts';
```

In `SwarmCommand`, replace:

```ts
  | { name: 'env'; app: EnvApp }
```

with:

```ts
  | { name: 'env'; app: EnvApp }
  | { name: 'keys'; parentKey: boolean; gatewayEnv: string | null }
```

In `COMMANDS`, replace:

```ts
  env: { synopsis: 'env <gateway|mcp>', does: 'write apps/<gateway|mcp>/.env from this configuration, never over a file' },
```

with:

```ts
  env: { synopsis: 'env <gateway|mcp>', does: 'write apps/<gateway|mcp>/.env from this configuration, never over a file' },
  keys: {
    synopsis: 'keys from-seed [--gateway-env <path> | --parent-key]',
    does: "write every missing key file from one seed phrase; --gateway-env also writes the gateway's keys, --parent-key prints the parent's key only",
  },
```

In `USAGE`, replace:

```ts
  'before it pays, and a buyer that holds seats in the pool follows them and never buys again.',
  '',
```

with:

```ts
  'before it pays, and a buyer that holds seats in the pool follows them and never buys again.',
  '',
  'swarm keys from-seed derives every key from one BIP-39 phrase, read from QUORUM_SEED_PHRASE or from',
  'the file QUORUM_SEED_PHRASE_FILE names (set one of them), checks the keys against the chain, then',
  'writes each missing key file under QUORUM_CREDENTIALS_DIR. It never writes over a file that holds',
  'something else, and never prints the phrase or a private key: one line per key, the account and its',
  'public key.',
  '',
```

In `parseCommand`, replace:

```ts
    case 'env': {
      const [app] = argsOf(name, args, 1);
      return { name, app: appArg(app) };
    }
```

with:

```ts
    case 'env': {
      const [app] = argsOf(name, args, 1);
      return { name, app: appArg(app) };
    }
    case 'keys':
      return keysArgs(args);
```

Add this function right after `argsOf`:

```ts
/** `keys from-seed`, then nothing, `--parent-key`, or `--gateway-env` and a path that is not empty. */
function keysArgs(args: readonly string[]): SwarmCommand {
  const [action, option, path, ...rest] = args;
  if (action === 'from-seed' && rest.length === 0) {
    if (option === undefined) return { name: 'keys', parentKey: false, gatewayEnv: null };
    if (option === '--parent-key' && path === undefined) return { name: 'keys', parentKey: true, gatewayEnv: null };
    if (option === '--gateway-env' && path !== undefined && path !== '') return { name: 'keys', parentKey: false, gatewayEnv: path };
  }
  throw new UsageError(`wrong arguments: the command is swarm ${COMMANDS.keys.synopsis}`);
}
```

In `SwarmModules`, replace:

```ts
  writeMcpEnv: typeof writeMcpEnv;
}
```

with:

```ts
  writeMcpEnv: typeof writeMcpEnv;
  keysFromSeed: typeof keysFromSeed;
}
```

In `Cli`, replace:

```ts
  /** Builds the connections for a configuration, sending nothing; called by the commands that use the chain. */
  connect: (config: SwarmConfig) => Connections;
```

with:

```ts
  /** Builds the connections for a configuration, sending nothing; called by the commands that use the chain. */
  connect: (config: SwarmConfig) => Connections;
  /** Builds the chain reads of `swarm keys from-seed` for a configuration, sending nothing. */
  seedChain: (config: SwarmConfig) => SeedChain;
```

In the comment above `runCli`, replace:

```ts
 * Every command but `env` and `help` checks the RPC's chain before it runs. An error is printed as
```

with:

```ts
 * Every command but `env`, `keys` and `help` checks the RPC's chain before it runs; `keys from-seed`
 * checks it itself, after the configuration's accounts, and `--parent-key` reads no chain, no
 * configuration and no file but the phrase's. An error is printed as
```

In `execute`, replace:

```ts
  const { modules, runtime, out: log } = cli;
  const config = loadSwarmConfig(cli.env);
```

with:

```ts
  const { modules, runtime, out: log } = cli;
  if (command.name === 'keys') {
    // The phrase before the configuration: --parent-key needs nothing else, so that it runs before
    // the parent account exists.
    const phrase = await readSeedPhrase(cli.env);
    if (command.parentKey) {
      log(parentPublicKey(phrase));
      return true;
    }
    const keysConfig = loadSwarmConfig(cli.env);
    const deps = { chain: cli.seedChain(keysConfig), log };
    await modules.keysFromSeed(keysConfig, phrase, deps, { gatewayEnv: command.gatewayEnv });
    return true;
  }
  const config = loadSwarmConfig(cli.env);
```

In the entry point at the end of the file, replace:

```ts
        connect: connectRpc,
        runtime: systemRuntime,
        modules: { runSetup, snapshot, openPool, runSwarm, checkPool, runReset, writeGatewayEnv, writeMcpEnv },
```

with:

```ts
        connect: connectRpc,
        seedChain: createRpcSeedChain,
        runtime: systemRuntime,
        modules: { runSetup, snapshot, openPool, runSwarm, checkPool, runReset, writeGatewayEnv, writeMcpEnv, keysFromSeed },
```

- [ ] **Step 6: Run the tests and the typecheck**

Run: `pnpm --filter @quorum-on-near/swarm exec vitest run test/keys-from-seed.test.ts test/env-files.test.ts test/main.test.ts test/seed.test.ts`

Expected: PASS. `test/keys-from-seed.test.ts` has 63 tests: all pass on Linux and macOS, and on
Windows 61 pass and the 2 file-mode tests are skipped. `test/env-files.test.ts` has 3 more tests than
before and `test/main.test.ts` 22 more, all passing. `test/seed.test.ts` still passes its 47.

Run: `pnpm --filter @quorum-on-near/swarm typecheck`

Expected: exit code 0; after pnpm's two lines naming the script, `tsc` prints nothing.

Run:

```bash
pnpm typecheck
pnpm test
```

Expected: both exit 0.

Check by hand that the parent key comes out of the process alone, from the phrase alone (POSIX
shell; the variables are set for this one command only, and the empty `QUORUM_SEED_PHRASE_FILE`
counts as unset, whatever `apps/swarm/.env` says):

```bash
QUORUM_SEED_PHRASE='abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about' QUORUM_SEED_PHRASE_FILE= node apps/swarm/src/main.ts keys from-seed --parent-key
```

Expected: one line, the key Task 2's Step 1 recorded from near-cli-rs, and exit code 0.

- [ ] **Step 7: Commit**

```bash
git add apps/swarm/src/keys-from-seed.ts apps/swarm/src/env-files.ts apps/swarm/src/main.ts apps/swarm/test/keys-from-seed.test.ts apps/swarm/test/stub-seed-chain.ts apps/swarm/test/env-files.test.ts apps/swarm/test/main.test.ts
git commit -F - <<'EOF'
add swarm keys from-seed, which writes every key file from one phrase

swarm keys from-seed reads a BIP-39 phrase from QUORUM_SEED_PHRASE or from the file
QUORUM_SEED_PHRASE_FILE names, derives every account's key from it, and checks them against the
chain before it writes anything: the RPC's chain id, a full-access parent key, and each derived key
on every account that already exists. It then writes each missing key file in the layout setup
reads, exclusively and with mode 0600, and with --gateway-env the gateway's relayer keys and
credential key, in the format of the gateway's env file. A file that holds the same key is left as
it is and one that holds another stops the command, so running it again changes nothing.
--parent-key prints the parent's public key from the phrase alone, before the account exists. The
phrase and the private keys never appear in its output or its messages.
EOF
```

### Task 4: The gateway's demo settings and `DemoRunner`

Two parts, one commit each. First the three settings of the hosted demo spec's section 4.1, read
by the gateway's `loadConfig` with its existing rules and problem list. Then `DemoRunner`, the
gateway's side of a demo run (section 4.3): it holds the one slot, counts the runs of each UTC day,
starts the run's program, forwards its output, records how it ended, bounds its time, and stops it
when the gateway stops. Task 5 puts it behind the HTTP routes.

The runner's tests start a real program: `apps/gateway/test/fixtures/demo-program.mjs`, a stand-in
for the swarm's `demo` command written in plain JavaScript, so that Node runs it without type
stripping (and prints no experimental warning). Timers are injected (`schedule`), so the tests fire
the maximum run time and the SIGKILL that follows at once, and check their exact delays.

This task assumes `apps/gateway` as the swarm and MCP server plan leaves it (`config.ts` re-exports
`checkChainId` from the protocol package and no longer defines it; the rest of `loadConfig` is as on
the earlier `main`). The live page plan does not change the gateway. If a name differs in the merged
code, adapt the edits to it.

What the code relies on, from Node's documentation for `node:child_process` and `node:readline`:

- `spawn(program, args, options)` never uses a shell unless `shell` is set. A program that cannot be
  started (for example `ENOENT`) emits `'error'` instead of `'spawn'`; `'spawn'` is emitted only once
  the program has started. `'close'` is emitted after the program has ended **and** its standard
  streams have closed, with `(code, signal)`: one of them is non-null.
- `readline`'s `'line'` event is also emitted for a last line without an end-of-line marker when the
  stream ends; `crlfDelay: Infinity` makes `\r\n` one line break. The stream's end comes before its
  close, and so before the child's `'close'`.
- On Windows, `kill('SIGTERM')` ends the process at once (there are no POSIX signals), and `'close'`
  still reports the signal `SIGTERM` (Node's own test `test-child-process-kill.js` asserts this on
  Windows). A program there cannot catch SIGTERM, so the test of the SIGKILL that follows an ignored
  SIGTERM is skipped on Windows, as the repository's other POSIX-only tests are (`skipIf`).

**Files:**
- Modify: `apps/gateway/src/config.ts` (`GatewayConfig`, a new `asDemoCommand` rule, `loadConfig`),
  `apps/gateway/.env.example` (three new lines at the end), `apps/gateway/test/fake-chain.ts`
  (`testConfig`'s defaults)
- Create: `apps/gateway/src/demo.ts`, `apps/gateway/test/fixtures/demo-program.mjs`
- Test: `apps/gateway/test/config.test.ts`, `apps/gateway/test/demo.test.ts`

**Interfaces:**
- Consumes: in `config.ts`, the existing `Rule<T>`, `asInteger(min, max)`, `optional(name, fallback,
  rule)` and the `problems` list of `loadConfig`; in the tests, `env()` and `problems()` of
  `config.test.ts`.
- Produces:
  - `GatewayConfig` gains `demoCommand: string[] | null` (null: the demo is off),
    `demoMaxRunsPerDay: number` and `demoMaxRunSeconds: number`, read from `QUORUM_DEMO_COMMAND`
    (default empty), `QUORUM_DEMO_MAX_RUNS_PER_DAY` (1 to 1000, default 100) and
    `QUORUM_DEMO_MAX_RUN_SECONDS` (60 to 7200, default 1800).
  - `testConfig()` (`apps/gateway/test/fake-chain.ts`) defaults them to `null`, `100`, `1800`.
  - `apps/gateway/src/demo.ts` exports:
    - `type DemoScenario = 'fills' | 'fails'` and `const DEMO_SCENARIOS: readonly DemoScenario[]`
      (`['fills', 'fails']`)
    - `const WITHHELD_VARIABLES: readonly string[]` (`QUORUM_RELAYER_KEYS`, `QUORUM_CREDENTIAL_JWK`,
      `QUORUM_SEED_PHRASE`, `QUORUM_SEED_PHRASE_FILE`) and `const KILL_GRACE_MS = 10_000`
    - `interface DemoLast { scenario: DemoScenario; startedAt: number; endedAt: number; exitCode: number | null; signal: string | null }`
    - `interface DemoStatus { running: boolean; scenario: DemoScenario | null; startedAt: number | null; last: DemoLast | null; runsToday: number; maxRunsPerDay: number }`
    - `type DemoClaim = { kind: 'running'; scenario: DemoScenario; startedAt: number } | { kind: 'limit' } | { kind: 'claimed'; startedAt: number; start(): Promise<DemoLast>; release(): void }`
    - `interface DemoOutput { stdout(line: string): void; stderr(line: string): void }`
    - `type Spawn = (program: string, args: readonly string[], options: SpawnOptions) => ChildProcess`
    - `type Schedule = (run: () => void, ms: number) => () => void`
    - `interface DemoRunnerOptions { command: readonly string[]; maxRunsPerDay: number; maxRunSeconds: number; env?: Record<string, string | undefined>; now?: () => number; spawn?: Spawn; schedule?: Schedule; output?: DemoOutput }`
    - `class DemoRunner { constructor(options: DemoRunnerOptions); claim(scenario: DemoScenario): DemoClaim; status(): DemoStatus; stop(): void }`
  - `apps/gateway/test/fixtures/demo-program.mjs`: its first argument picks a mode (`lines`,
    `exit <code>`, `hang`, `ignore-sigterm`, `describe`); Task 5's tests start it too.
  - The runner's own lines: `[demo] starting the <scenario> run: <program and arguments>` (stdout),
    `[demo] the <scenario> run exited with code <code>` or `… ended on <signal>` (stdout), and on
    stderr `[demo] the <scenario> run could not be started: <error>`,
    `[demo] the <scenario> run is not started: the gateway is stopping`,
    `[demo] the <scenario> run has run for <seconds> seconds: sending SIGTERM`,
    `[demo] the <scenario> run is still going 10 seconds after SIGTERM: sending SIGKILL`,
    `[demo] the gateway is stopping: sending SIGTERM to the <scenario> run`.

- [ ] **Step 1: Write the failing configuration tests**

In `apps/gateway/test/config.test.ts`, in the test `applies every default when only the three
required variables are set`, replace:

```typescript
      rpcPassthrough: false,
      explorerTxUrl: 'https://testnet.nearblocks.io/txns/',
    });
  });
```

with:

```typescript
      rpcPassthrough: false,
      explorerTxUrl: 'https://testnet.nearblocks.io/txns/',
      demoCommand: null,
      demoMaxRunsPerDay: 100,
      demoMaxRunSeconds: 1800,
    });
  });
```

In the test `reads every variable that is set`, replace:

```typescript
        QUORUM_RPC_PASSTHROUGH: 'true',
        QUORUM_EXPLORER_TX_URL: 'https://explorer.example/txns/',
      }),
    );
```

with:

```typescript
        QUORUM_RPC_PASSTHROUGH: 'true',
        QUORUM_EXPLORER_TX_URL: 'https://explorer.example/txns/',
        QUORUM_DEMO_COMMAND: '["node","../swarm/src/main.ts","demo"]',
        QUORUM_DEMO_MAX_RUNS_PER_DAY: '5',
        QUORUM_DEMO_MAX_RUN_SECONDS: '600',
      }),
    );
```

and, in the same test, replace:

```typescript
      rpcPassthrough: true,
      explorerTxUrl: 'https://explorer.example/txns/',
    });
  });
```

with:

```typescript
      rpcPassthrough: true,
      explorerTxUrl: 'https://explorer.example/txns/',
      demoCommand: ['node', '../swarm/src/main.ts', 'demo'],
      demoMaxRunsPerDay: 5,
      demoMaxRunSeconds: 600,
    });
  });
```

At the end of the file, add:

```typescript
describe('loadConfig demo', () => {
  const COMMAND =
    'QUORUM_DEMO_COMMAND must be empty (the demo is off), or a JSON array of one or more non-empty strings: ' +
    'the program to start, then its first arguments';

  it('turns the demo off when QUORUM_DEMO_COMMAND is unset or empty', () => {
    expect(loadConfig(env()).demoCommand).toBeNull();
    expect(loadConfig(env({ QUORUM_DEMO_COMMAND: '' })).demoCommand).toBeNull();
  });

  it.each([
    ['["node","/app/apps/swarm/src/main.ts","demo"]', ['node', '/app/apps/swarm/src/main.ts', 'demo']],
    ['["/usr/local/bin/quorum-demo"]', ['/usr/local/bin/quorum-demo']],
  ] as const)('reads QUORUM_DEMO_COMMAND = %s', (raw, command) => {
    expect(loadConfig(env({ QUORUM_DEMO_COMMAND: raw })).demoCommand).toEqual(command);
  });

  it.each([
    ['text that is not JSON', 'node demo'],
    ['an empty array', '[]'],
    ['a JSON string', '"node"'],
    ['an object', '{"program":"node"}'],
    ['null', 'null'],
    ['an empty string in the array', '["node",""]'],
    ['a number in the array', '["node",1]'],
    ['a nested array', '[["node"]]'],
  ])('refuses QUORUM_DEMO_COMMAND holding %s, naming the variable', (_label, raw) => {
    expect(problems(env({ QUORUM_DEMO_COMMAND: raw }))).toEqual([`${COMMAND}, got ${JSON.stringify(raw)}`]);
  });

  it('accepts from 1 to 1000 runs a day, and from 60 to 7200 seconds a run', () => {
    const least = loadConfig(env({ QUORUM_DEMO_MAX_RUNS_PER_DAY: '1', QUORUM_DEMO_MAX_RUN_SECONDS: '60' }));
    const most = loadConfig(env({ QUORUM_DEMO_MAX_RUNS_PER_DAY: '1000', QUORUM_DEMO_MAX_RUN_SECONDS: '7200' }));
    expect([least.demoMaxRunsPerDay, least.demoMaxRunSeconds, most.demoMaxRunsPerDay, most.demoMaxRunSeconds]).toEqual([
      1, 60, 1000, 7200,
    ]);
  });

  it.each([
    ['QUORUM_DEMO_MAX_RUNS_PER_DAY', '0', 'an integer from 1 to 1000'],
    ['QUORUM_DEMO_MAX_RUNS_PER_DAY', '1001', 'an integer from 1 to 1000'],
    ['QUORUM_DEMO_MAX_RUNS_PER_DAY', '', 'an integer from 1 to 1000'],
    ['QUORUM_DEMO_MAX_RUNS_PER_DAY', '10.5', 'an integer from 1 to 1000'],
    ['QUORUM_DEMO_MAX_RUN_SECONDS', '59', 'an integer from 60 to 7200'],
    ['QUORUM_DEMO_MAX_RUN_SECONDS', '7201', 'an integer from 60 to 7200'],
    ['QUORUM_DEMO_MAX_RUN_SECONDS', '30m', 'an integer from 60 to 7200'],
  ])('refuses %s = %j, also while the demo is off', (name, value, expected) => {
    expect(problems(env({ [name]: value }))).toEqual([`${name} must be ${expected}, got ${JSON.stringify(value)}`]);
  });
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm --filter @quorum-on-near/gateway exec vitest run test/config.test.ts`

Expected: FAIL, 21 tests: the two whole-configuration tests (`demoCommand` and the two limits are
missing from what `loadConfig` returns), and the 19 tests of `loadConfig demo` (the values are
`undefined`, and every refusal test fails with `loadConfig accepted the configuration`). The others
pass, the two tests of the example file included.

- [ ] **Step 3: Implement the settings**

In `apps/gateway/src/config.ts`, in `interface GatewayConfig`, replace:

```typescript
  rpcPassthrough: boolean;
  explorerTxUrl: string;
}
```

with:

```typescript
  rpcPassthrough: boolean;
  explorerTxUrl: string;
  /** A demo run's program and first arguments, to which the scenario is appended; null: the demo is off. */
  demoCommand: string[] | null;
  /** Demo runs started per UTC day, counted in memory. */
  demoMaxRunsPerDay: number;
  /** How long a demo run may last, in seconds, before the gateway stops it. */
  demoMaxRunSeconds: number;
}
```

Just above the comment `/** The positions, from 1, of the first key listed twice, compared by
public key; null if none is. */`, add:

```typescript
/** Whether `value` is a non-empty array of non-empty strings. */
function isCommand(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((part) => typeof part === 'string' && part !== '');
}

/**
 * A demo run's program and first arguments, as a JSON array; empty turns the demo off. The gateway
 * starts the program without a shell, so it must be the run itself (hosted demo spec, section 4.1).
 */
const asDemoCommand: Rule<string[] | null> = {
  expected:
    'empty (the demo is off), or a JSON array of one or more non-empty strings: the program to start, then its first arguments',
  parse(raw) {
    if (raw === '') return null;
    try {
      const value: unknown = JSON.parse(raw);
      return isCommand(value) ? value : undefined;
    } catch {
      return undefined;
    }
  },
};

```

In `loadConfig`, replace:

```typescript
  const draft: Draft = {
```

with:

```typescript
  const explorerTxUrl = optional('QUORUM_EXPLORER_TX_URL', 'https://testnet.nearblocks.io/txns/', asHttpUrl);
  // The demo endpoint (hosted demo spec, section 4.1): an empty command turns it off, and its limits are
  // checked either way.
  const demoCommand = optional('QUORUM_DEMO_COMMAND', '', asDemoCommand);
  const demoMaxRunsPerDay = optional('QUORUM_DEMO_MAX_RUNS_PER_DAY', '100', asInteger(1, 1000));
  const demoMaxRunSeconds = optional('QUORUM_DEMO_MAX_RUN_SECONDS', '1800', asInteger(60, 7200));

  const draft: Draft = {
```

and, at the end of the draft, replace:

```typescript
    rpcPassthrough,
    explorerTxUrl: optional('QUORUM_EXPLORER_TX_URL', 'https://testnet.nearblocks.io/txns/', asHttpUrl),
  };
```

with:

```typescript
    rpcPassthrough,
    explorerTxUrl,
    demoCommand,
    demoMaxRunsPerDay,
    demoMaxRunSeconds,
  };
```

The explorer URL is still read after `QUORUM_RPC_PASSTHROUGH`, so the order of the problem lines does
not change.

At the end of `apps/gateway/.env.example`, after `QUORUM_EXPLORER_TX_URL=…`, add these lines. The
config tests require it: the example file must list exactly the variables `loadConfig` reads, and its
values must be the defaults.

```text
# The demo endpoint: POST /demo/fills and POST /demo/fails start a run, and GET /demo reports it.
# A JSON array of strings: the program to start and its first arguments, to which the gateway appends
# the scenario, for example ["node","../swarm/src/main.ts","demo"]. The program must be the run itself,
# never a shell or a package manager, which would not pass signals on. Empty turns the demo off.
QUORUM_DEMO_COMMAND=
# Demo runs started per UTC day, from 1 to 1000, counted in memory.
QUORUM_DEMO_MAX_RUNS_PER_DAY=100
# Longest a demo run may last, in seconds, from 60 to 7200. It then gets SIGTERM, and SIGKILL 10 seconds later.
QUORUM_DEMO_MAX_RUN_SECONDS=1800
```

In `apps/gateway/test/fake-chain.ts`, in `testConfig`, replace:

```typescript
    explorerTxUrl: 'https://testnet.nearblocks.io/txns/',
    ...overrides,
```

with:

```typescript
    explorerTxUrl: 'https://testnet.nearblocks.io/txns/',
    demoCommand: null,
    demoMaxRunsPerDay: 100,
    demoMaxRunSeconds: 1800,
    ...overrides,
```

- [ ] **Step 4: Run them and see them pass**

Run: `pnpm --filter @quorum-on-near/gateway exec vitest run test/config.test.ts`

Expected: PASS, with 19 more tests than before this task.

Run: `pnpm --filter @quorum-on-near/gateway typecheck`

Expected: exit code 0. (Without the `testConfig` change, `tsc` reports the three new properties
missing from its object.)

- [ ] **Step 5: Commit the settings**

```bash
git add apps/gateway/src/config.ts apps/gateway/.env.example apps/gateway/test/config.test.ts apps/gateway/test/fake-chain.ts
git commit -F - <<'EOF'
read the demo endpoint's command and limits from the environment

QUORUM_DEMO_COMMAND is a JSON array of strings, the program of a demo run and its first arguments,
and leaves the demo off when unset or empty. QUORUM_DEMO_MAX_RUNS_PER_DAY (1 to 1000, default 100)
caps the runs started per UTC day, and QUORUM_DEMO_MAX_RUN_SECONDS (60 to 7200, default 1800)
bounds how long one may last. A malformed value stops the gateway at startup, naming the variable.
EOF
```

- [ ] **Step 6: Write the stand-in program and the failing runner tests**

`apps/gateway/test/fixtures/demo-program.mjs`:

```javascript
// Stands in for the swarm's `demo` command in the gateway's tests. The gateway appends the scenario
// after the arguments it is given, so the first argument picks what this program does:
//   lines           writes two lines and a last one without a newline to stdout, and one line to
//                   stderr, then exits with 0
//   exit <code>     writes one line, then exits with <code>
//   hang            writes "ready", then runs until a signal ends it
//   ignore-sigterm  like hang, but on SIGTERM writes "SIGTERM ignored" and runs on (on POSIX only:
//                   Windows ends the process instead)
//   describe        writes its arguments, its working folder and its QUORUM_* variables (any case) as
//                   JSON on one line, then exits with 0
// Plain JavaScript, so that Node runs it without type stripping.
const [mode, ...rest] = process.argv.slice(2);

switch (mode) {
  case 'lines':
    process.stdout.write('first line\nsecond line\r\n');
    process.stderr.write('an error line\n');
    process.stdout.write('last line without a newline');
    break;
  case 'exit':
    console.log(`exiting with ${rest[0]}`);
    process.exitCode = Number(rest[0]);
    break;
  case 'ignore-sigterm':
    process.on('SIGTERM', () => console.log('SIGTERM ignored'));
    console.log('ready');
    setInterval(() => {}, 60_000);
    break;
  case 'hang':
    console.log('ready');
    setInterval(() => {}, 60_000);
    break;
  case 'describe': {
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^quorum_/i.test(name)));
    console.log(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), env }));
    break;
  }
  default:
    console.error(`unknown mode ${JSON.stringify(mode)}`);
    process.exitCode = 2;
}
```

vitest does not collect it (its name is not `*.test.*`), and `tsc` does not check it (the gateway's
`tsconfig.json` has no `allowJs`).

`apps/gateway/test/demo.test.ts`:

```typescript
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import {
  DemoRunner,
  type DemoOutput,
  type DemoRunnerOptions,
  type DemoScenario,
  type Schedule,
  type Spawn,
} from '../src/demo.ts';

/** The stand-in for the swarm's demo command (its modes are listed in the file). */
const PROGRAM = fileURLToPath(new URL('./fixtures/demo-program.mjs', import.meta.url));
/** 2030-01-01 at 12:00 UTC. */
const NOON = Date.UTC(2030, 0, 1, 12);
/** How long a test waits for the program: starting Node takes a few hundred milliseconds. */
const WAIT = { timeout: 5_000, interval: 10 };

/** An output that keeps every line the runner writes, by stream. */
interface Collected extends DemoOutput {
  out: string[];
  err: string[];
}

function collect(): Collected {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (line) => out.push(line), stderr: (line) => err.push(line) };
}

interface ManualTimer {
  ms: number;
  run: () => void;
  cancelled: boolean;
}

/** A Schedule whose timers run only when the test fires them. */
function manualSchedule(): { schedule: Schedule; timers: ManualTimer[] } {
  const timers: ManualTimer[] = [];
  const schedule: Schedule = (run, ms) => {
    const timer: ManualTimer = { ms, run, cancelled: false };
    timers.push(timer);
    return () => {
      timer.cancelled = true;
    };
  };
  return { schedule, timers };
}

/** Runs the timer at `index`, which the runner must have scheduled. */
function fire(timers: ManualTimer[], index: number): void {
  const timer = timers[index];
  if (timer === undefined) throw new Error(`no timer ${index}: ${timers.length} scheduled`);
  timer.run();
}

/**
 * A runner of the stand-in program in `mode`, 100 runs a day and 1800 seconds a run unless `options`
 * says otherwise, over a clock the test moves. Once the test has finished, no run is left in progress.
 */
function runner(mode: string[], options: Partial<DemoRunnerOptions> = {}) {
  const output = collect();
  const clock = { now: NOON };
  const demo = new DemoRunner({
    command: [process.execPath, PROGRAM, ...mode],
    maxRunsPerDay: 100,
    maxRunSeconds: 1800,
    now: () => clock.now,
    output,
    ...options,
  });
  onTestFinished(async () => {
    demo.stop();
    await vi.waitFor(() => expect(demo.status().running).toBe(false), WAIT);
  });
  return { demo, output, clock };
}

/** Takes the slot, or fails the test. */
function claimed(demo: DemoRunner, scenario: DemoScenario = 'fills') {
  const claim = demo.claim(scenario);
  if (claim.kind !== 'claimed') throw new Error(`expected the slot, got ${claim.kind}`);
  return claim;
}

/** What the program printed in its describe mode. */
function described(output: Collected): { argv: string[]; cwd: string; env: Record<string, string> } {
  const line = output.out.find((text) => text.startsWith('[demo] {'));
  if (line === undefined) throw new Error(`the program printed no description: ${JSON.stringify(output.out)}`);
  return JSON.parse(line.slice('[demo] '.length));
}

describe('DemoRunner', { timeout: 20_000 }, () => {
  it('needs a program', () => {
    expect(() => new DemoRunner({ command: [], maxRunsPerDay: 1, maxRunSeconds: 60 })).toThrow(
      'the demo command needs a program',
    );
  });

  describe('its slot', () => {
    it('reports no run before the first', () => {
      const { demo } = runner(['exit', '0']);
      expect(demo.status()).toEqual({
        running: false,
        scenario: null,
        startedAt: null,
        last: null,
        runsToday: 0,
        maxRunsPerDay: 100,
      });
    });

    it("is taken in the step that checks it: a second claim gets the first one's scenario and start", () => {
      const { demo } = runner(['exit', '0']);
      const first = claimed(demo, 'fails');
      expect(demo.claim('fills')).toEqual({ kind: 'running', scenario: 'fails', startedAt: NOON });
      expect(demo.status()).toMatchObject({ running: true, scenario: 'fails', startedAt: NOON, runsToday: 0 });
      first.release();
    });

    it('is free again once released, and a released claim is not counted', () => {
      const { demo } = runner(['exit', '0']);
      claimed(demo).release();
      expect(demo.status()).toEqual({
        running: false,
        scenario: null,
        startedAt: null,
        last: null,
        runsToday: 0,
        maxRunsPerDay: 100,
      });
      claimed(demo).release();
    });

    it('cannot be started or released twice', async () => {
      const { demo } = runner(['exit', '0']);
      const released = claimed(demo);
      released.release();
      expect(() => released.release()).toThrow('this demo claim was already started or released');
      expect(() => released.start()).toThrow('this demo claim was already started or released');
      const started = claimed(demo);
      const ended = started.start();
      expect(() => started.release()).toThrow('this demo claim was already started or released');
      expect(demo.status().running).toBe(true);
      await ended;
    });

    it('counts a run when it starts, and holds the slot until the run has ended', async () => {
      const { demo, clock } = runner(['exit', '0']);
      const ended = claimed(demo).start();
      expect(demo.status()).toEqual({
        running: true,
        scenario: 'fills',
        startedAt: NOON,
        last: null,
        runsToday: 1,
        maxRunsPerDay: 100,
      });
      clock.now = NOON + 2_000;
      const last = { scenario: 'fills', startedAt: NOON, endedAt: NOON + 2_000, exitCode: 0, signal: null };
      expect(await ended).toEqual(last);
      expect(demo.status()).toEqual({
        running: false,
        scenario: null,
        startedAt: null,
        last,
        runsToday: 1,
        maxRunsPerDay: 100,
      });
    });

    it("answers running before the day's cap, and limit once the run has ended", async () => {
      const { demo } = runner(['exit', '0'], { maxRunsPerDay: 1 });
      const ended = claimed(demo).start();
      expect(demo.claim('fails')).toEqual({ kind: 'running', scenario: 'fills', startedAt: NOON });
      await ended;
      expect(demo.claim('fails')).toEqual({ kind: 'limit' });
      expect(demo.status()).toMatchObject({ running: false, runsToday: 1, maxRunsPerDay: 1 });
    });

    it('counts from 0 again after midnight UTC', async () => {
      const { demo, clock } = runner(['exit', '0'], { maxRunsPerDay: 1 });
      clock.now = Date.UTC(2030, 0, 1, 23, 59, 59, 999);
      await claimed(demo).start();
      expect(demo.claim('fills')).toEqual({ kind: 'limit' });
      clock.now = Date.UTC(2030, 0, 2);
      expect(demo.status().runsToday).toBe(0);
      await claimed(demo).start();
      expect(demo.status().runsToday).toBe(1);
    });
  });

  describe('a run', () => {
    it("starts the command, then the scenario, without a shell, in the gateway's folder", async () => {
      // A shell would expand $HOME and split the argument at the semicolon.
      const { demo, output } = runner(['describe', '$HOME; echo split']);
      await claimed(demo, 'fails').start();
      expect(described(output)).toMatchObject({ argv: ['describe', '$HOME; echo split', 'fails'], cwd: process.cwd() });
    });

    it('gives the run the environment it is given, without the relayer keys, the credential key or the phrase', async () => {
      const base = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^quorum_/i.test(name)));
      const env = {
        ...base,
        QUORUM_GATEWAY_URL: 'https://gateway.example',
        QUORUM_CREDENTIALS_DIR: '/run/quorum/credentials',
        QUORUM_RELAYER_KEYS: 'withheld-1',
        QUORUM_CREDENTIAL_JWK: 'withheld-2',
        QUORUM_SEED_PHRASE: 'withheld-3',
        QUORUM_SEED_PHRASE_FILE: 'withheld-4',
        // Windows reads variable names without case, so this would be QUORUM_SEED_PHRASE there.
        quorum_seed_phrase: 'withheld-5',
      };
      const { demo, output } = runner(['describe'], { env });
      await claimed(demo).start();
      expect(described(output).env).toEqual({
        QUORUM_GATEWAY_URL: 'https://gateway.example',
        QUORUM_CREDENTIALS_DIR: '/run/quorum/credentials',
      });
    });

    it('writes each line of its output prefixed, and a last line without a newline once the output closes', async () => {
      const { demo, output } = runner(['lines']);
      await claimed(demo).start();
      expect(output.out).toEqual([
        `[demo] starting the fills run: ${[process.execPath, PROGRAM, 'lines', 'fills'].join(' ')}`,
        '[demo] first line',
        '[demo] second line',
        '[demo] last line without a newline',
        '[demo] the fills run exited with code 0',
      ]);
      expect(output.err).toEqual(['[demo] an error line']);
    });

    it('records the exit code of a run that exits', async () => {
      const { demo, output, clock } = runner(['exit', '3']);
      const ended = claimed(demo, 'fails').start();
      clock.now = NOON + 60_000;
      const last = { scenario: 'fails', startedAt: NOON, endedAt: NOON + 60_000, exitCode: 3, signal: null };
      expect(await ended).toEqual(last);
      expect(demo.status()).toEqual({
        running: false,
        scenario: null,
        startedAt: null,
        last,
        runsToday: 1,
        maxRunsPerDay: 100,
      });
      expect(output.out.at(-1)).toBe('[demo] the fails run exited with code 3');
    });

    it('records both the exit code and the signal as null for a program that cannot be started, and counts it', async () => {
      const missing = fileURLToPath(new URL('./fixtures/no-such-program', import.meta.url));
      const { demo, output } = runner([], { command: [missing, 'demo'] });
      expect(await claimed(demo).start()).toMatchObject({ scenario: 'fills', exitCode: null, signal: null });
      expect(demo.status()).toMatchObject({ running: false, runsToday: 1 });
      expect(output.out).toEqual([`[demo] starting the fills run: ${missing} demo fills`]);
      expect(output.err).toEqual([expect.stringMatching(/^\[demo\] the fills run could not be started: .*ENOENT/)]);
    });

    it('records both as null when the program cannot even be spawned', async () => {
      const failing: Spawn = () => {
        throw new Error('spawn EINVAL');
      };
      const { demo, output } = runner(['exit', '0'], { spawn: failing });
      expect(await claimed(demo).start()).toMatchObject({ exitCode: null, signal: null });
      expect(output.err).toEqual(['[demo] the fills run could not be started: spawn EINVAL']);
      expect(demo.status()).toMatchObject({ running: false, runsToday: 1 });
    });

    it('sends SIGTERM once the run has lasted its maximum run time', async () => {
      const { schedule, timers } = manualSchedule();
      const { demo, output } = runner(['hang'], { schedule, maxRunSeconds: 60 });
      const ended = claimed(demo).start();
      expect(timers.map(({ ms }) => ms)).toEqual([60_000]);
      await vi.waitFor(() => expect(output.out).toContain('[demo] ready'), WAIT);
      fire(timers, 0);
      expect(await ended).toMatchObject({ exitCode: null, signal: 'SIGTERM' });
      expect(output.err).toEqual(['[demo] the fills run has run for 60 seconds: sending SIGTERM']);
      expect(output.out.at(-1)).toBe('[demo] the fills run ended on SIGTERM');
      // SIGKILL was scheduled 10 seconds after SIGTERM, and cancelled when the run ended.
      expect(timers.map(({ ms, cancelled }) => ({ ms, cancelled }))).toEqual([
        { ms: 60_000, cancelled: true },
        { ms: 10_000, cancelled: true },
      ]);
    });

    // Windows has no SIGTERM a program can catch: there, the run ends at the SIGTERM.
    it.skipIf(process.platform === 'win32')('sends SIGKILL 10 seconds after SIGTERM to a run that is still going', async () => {
      const { schedule, timers } = manualSchedule();
      const { demo, output } = runner(['ignore-sigterm'], { schedule, maxRunSeconds: 60 });
      const ended = claimed(demo).start();
      await vi.waitFor(() => expect(output.out).toContain('[demo] ready'), WAIT);
      fire(timers, 0);
      await vi.waitFor(() => expect(output.out).toContain('[demo] SIGTERM ignored'), WAIT);
      expect(timers[1]).toMatchObject({ ms: 10_000, cancelled: false });
      fire(timers, 1);
      expect(await ended).toMatchObject({ exitCode: null, signal: 'SIGKILL' });
      expect(output.err).toEqual([
        '[demo] the fills run has run for 60 seconds: sending SIGTERM',
        '[demo] the fills run is still going 10 seconds after SIGTERM: sending SIGKILL',
      ]);
    });

    it('cancels the maximum run time once the run has ended', async () => {
      const { schedule, timers } = manualSchedule();
      const { demo } = runner(['exit', '0'], { schedule });
      await claimed(demo).start();
      expect(timers).toEqual([{ ms: 1_800_000, run: expect.any(Function), cancelled: true }]);
    });
  });

  describe('stop', () => {
    it('sends SIGTERM to a run in progress', async () => {
      const { demo, output } = runner(['hang']);
      const ended = claimed(demo, 'fails').start();
      await vi.waitFor(() => expect(output.out).toContain('[demo] ready'), WAIT);
      demo.stop();
      expect(await ended).toMatchObject({ scenario: 'fails', exitCode: null, signal: 'SIGTERM' });
      expect(output.err).toEqual(['[demo] the gateway is stopping: sending SIGTERM to the fails run']);
    });

    it('does nothing without a run', () => {
      const { demo, output } = runner(['exit', '0']);
      demo.stop();
      expect(demo.status()).toMatchObject({ running: false, last: null, runsToday: 0 });
      expect([...output.out, ...output.err]).toEqual([]);
    });

    it('keeps a run claimed before it from starting after it', async () => {
      const spawned = vi.fn<Spawn>(spawn);
      const { demo, output } = runner(['exit', '0'], { spawn: spawned });
      const claim = claimed(demo);
      demo.stop();
      expect(await claim.start()).toMatchObject({ exitCode: null, signal: null });
      expect(spawned).not.toHaveBeenCalled();
      expect(output.err).toEqual(['[demo] the fills run is not started: the gateway is stopping']);
    });
  });
});
```

The file holds 20 tests: 1 at the top, 7 in `its slot`, 9 in `a run` and 3 in `stop`.

- [ ] **Step 7: Run them and see them fail**

Run: `pnpm --filter @quorum-on-near/gateway exec vitest run test/demo.test.ts`

Expected: FAIL: the suite does not load, with
`Error: Cannot find module '../src/demo.ts' imported from <repo>/apps/gateway/test/demo.test.ts`, and
`Tests  no tests`.

- [ ] **Step 8: Implement the runner**

`apps/gateway/src/demo.ts`:

```typescript
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';

/** The runs a visitor can start: a pool that fills, and one that fails. */
export type DemoScenario = 'fills' | 'fails';

export const DEMO_SCENARIOS: readonly DemoScenario[] = ['fills', 'fails'];

/**
 * The variables a run never gets: the relayer's keys and the credential key, which only the gateway
 * signs with, and the phrase every key is derived from. A run reads its own keys from their key files.
 */
export const WITHHELD_VARIABLES: readonly string[] = [
  'QUORUM_RELAYER_KEYS',
  'QUORUM_CREDENTIAL_JWK',
  'QUORUM_SEED_PHRASE',
  'QUORUM_SEED_PHRASE_FILE',
];

/** How long a run has to end after the SIGTERM of its maximum run time, before it gets SIGKILL. */
export const KILL_GRACE_MS = 10_000;

const DAY_MS = 86_400_000;
const PREFIX = '[demo] ';

/** The last run that ended. Times are milliseconds since the epoch. */
export interface DemoLast {
  scenario: DemoScenario;
  startedAt: number;
  endedAt: number;
  /** The exit code of a run that exited; null otherwise. */
  exitCode: number | null;
  /** The signal that ended a run that did not exit; null otherwise. Both are null for a program that could not be started. */
  signal: string | null;
}

/** `GET /demo`'s answer. `scenario` and `startedAt` are null when no run is in progress. */
export interface DemoStatus {
  running: boolean;
  scenario: DemoScenario | null;
  startedAt: number | null;
  last: DemoLast | null;
  runsToday: number;
  maxRunsPerDay: number;
}

/**
 * What `claim` answers: a run is in progress (its scenario and start), today's cap is reached, or the
 * slot is now the caller's, to `start` or `release` exactly once.
 */
export type DemoClaim =
  | { kind: 'running'; scenario: DemoScenario; startedAt: number }
  | { kind: 'limit' }
  | { kind: 'claimed'; startedAt: number; start(): Promise<DemoLast>; release(): void };

/** Where the runner writes its lines, each without its newline. */
export interface DemoOutput {
  stdout(line: string): void;
  stderr(line: string): void;
}

/** Starts a program without a shell, as node:child_process's spawn does. */
export type Spawn = (program: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

/** Runs `run` once `ms` milliseconds have passed; the function it returns cancels that. */
export type Schedule = (run: () => void, ms: number) => () => void;

export interface DemoRunnerOptions {
  /** The program and its first arguments; the scenario is appended. Not empty. */
  command: readonly string[];
  maxRunsPerDay: number;
  /** A run still going after this long gets SIGTERM, then SIGKILL KILL_GRACE_MS later. */
  maxRunSeconds: number;
  /** The gateway's environment, which a run gets without WITHHELD_VARIABLES. Defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** The clock, in milliseconds since the epoch. Defaults to Date.now. */
  now?: () => number;
  /** Defaults to node:child_process's spawn. */
  spawn?: Spawn;
  /** Defaults to setTimeout. */
  schedule?: Schedule;
  /** Defaults to the gateway's standard output and error. */
  output?: DemoOutput;
}

const setTimer: Schedule = (run, ms) => {
  const timer = setTimeout(run, ms);
  return () => clearTimeout(timer);
};

const standardStreams: DemoOutput = {
  stdout: (line) => {
    process.stdout.write(`${line}\n`);
  },
  stderr: (line) => {
    process.stderr.write(`${line}\n`);
  },
};

/** The UTC day `ms` falls in, as a count of days since the epoch. */
function utcDay(ms: number): number {
  return Math.floor(ms / DAY_MS);
}

/** Writes each line of `stream` with the prefix, and a last line without a newline once the stream ends. */
function forwardLines(stream: Readable | null, write: (line: string) => void): void {
  if (stream === null) return;
  createInterface({ input: stream, crlfDelay: Infinity }).on('line', (line) => write(`${PREFIX}${line}`));
}

/** The run in progress, or a slot a request has claimed and not yet started or released. */
interface Slot {
  scenario: DemoScenario;
  startedAt: number;
  /** Null until the run's program is spawned. */
  child: ChildProcess | null;
}

/**
 * Starts the demo's runs, one at a time (hosted demo spec, section 4.3):
 * - `claim` checks the slot and takes it in one synchronous step, so two requests never both get it.
 *   The caller then starts the run or releases the slot.
 * - A run counts towards its UTC day's cap when it starts, even one whose program cannot be started.
 * - The program starts without a shell, with the command's arguments then the scenario, in the
 *   gateway's folder, with the gateway's environment minus WITHHELD_VARIABLES.
 * - Each line of its output goes to the gateway's standard output or error, prefixed `[demo] `.
 * - After its maximum run time it gets SIGTERM, then SIGKILL KILL_GRACE_MS later if it has not ended.
 * - `stop`, at the gateway's shutdown, sends SIGTERM to the run in progress.
 */
export class DemoRunner {
  readonly #command: readonly string[];
  readonly #maxRunsPerDay: number;
  readonly #maxRunSeconds: number;
  readonly #env: Record<string, string | undefined>;
  readonly #now: () => number;
  readonly #spawn: Spawn;
  readonly #schedule: Schedule;
  readonly #output: DemoOutput;
  #slot: Slot | null = null;
  #last: DemoLast | null = null;
  /** The UTC day that #runs counts, or null before the first run. */
  #day: number | null = null;
  #runs = 0;
  #stopping = false;

  constructor(options: DemoRunnerOptions) {
    if (options.command.length === 0) throw new Error('the demo command needs a program');
    this.#command = options.command;
    this.#maxRunsPerDay = options.maxRunsPerDay;
    this.#maxRunSeconds = options.maxRunSeconds;
    this.#env = options.env ?? process.env;
    this.#now = options.now ?? Date.now;
    this.#spawn = options.spawn ?? spawn;
    this.#schedule = options.schedule ?? setTimer;
    this.#output = options.output ?? standardStreams;
  }

  /**
   * Checks the slot and takes it in the same synchronous step. A run in progress comes first, then
   * today's cap.
   */
  claim(scenario: DemoScenario): DemoClaim {
    const busy = this.#slot;
    if (busy !== null) return { kind: 'running', scenario: busy.scenario, startedAt: busy.startedAt };
    const startedAt = this.#now();
    if (this.#runsOn(startedAt) >= this.#maxRunsPerDay) return { kind: 'limit' };
    const slot: Slot = { scenario, startedAt, child: null };
    this.#slot = slot;
    let used = false;
    const use = (): void => {
      if (used) throw new Error('this demo claim was already started or released');
      used = true;
    };
    return {
      kind: 'claimed',
      startedAt,
      start: () => {
        use();
        return this.#start(slot);
      },
      release: () => {
        use();
        this.#slot = null;
      },
    };
  }

  status(): DemoStatus {
    const slot = this.#slot;
    return {
      running: slot !== null,
      scenario: slot === null ? null : slot.scenario,
      startedAt: slot === null ? null : slot.startedAt,
      last: this.#last,
      runsToday: this.#runsOn(this.#now()),
      maxRunsPerDay: this.#maxRunsPerDay,
    };
  }

  /** At the gateway's shutdown: sends SIGTERM to the run in progress, and starts no run after it. */
  stop(): void {
    this.#stopping = true;
    const slot = this.#slot;
    if (slot === null || slot.child === null) return;
    this.#output.stderr(`${PREFIX}the gateway is stopping: sending SIGTERM to the ${slot.scenario} run`);
    slot.child.kill('SIGTERM');
  }

  /** The runs started on the UTC day `now` falls in. */
  #runsOn(now: number): number {
    return utcDay(now) === this.#day ? this.#runs : 0;
  }

  #count(startedAt: number): void {
    const day = utcDay(startedAt);
    if (day !== this.#day) {
      this.#day = day;
      this.#runs = 0;
    }
    this.#runs += 1;
  }

  /** The gateway's environment without WITHHELD_VARIABLES, whose names are compared without case, as Windows does. */
  #childEnv(): Record<string, string | undefined> {
    return Object.fromEntries(
      Object.entries(this.#env).filter(([name]) => !WITHHELD_VARIABLES.includes(name.toUpperCase())),
    );
  }

  #trySpawn(program: string, args: string[]): ChildProcess | Error {
    try {
      return this.#spawn(program, args, { env: this.#childEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
  }

  /** Starts the claimed run. Resolves once it has ended and `last` records it; never rejects. */
  #start(slot: Slot): Promise<DemoLast> {
    this.#count(slot.startedAt);
    const { scenario, startedAt } = slot;
    const [program = '', ...rest] = this.#command;
    const args = [...rest, scenario];
    return new Promise((resolve) => {
      const cancels: Array<() => void> = [];
      let ended = false;
      const end = (exitCode: number | null, signal: string | null): void => {
        if (ended) return;
        ended = true;
        for (const cancel of cancels) cancel();
        const last: DemoLast = { scenario, startedAt, endedAt: this.#now(), exitCode, signal };
        this.#last = last;
        this.#slot = null;
        resolve(last);
      };
      const notStarted = (why: string): void => {
        this.#output.stderr(`${PREFIX}the ${scenario} run ${why}`);
        end(null, null);
      };

      if (this.#stopping) {
        notStarted('is not started: the gateway is stopping');
        return;
      }
      this.#output.stdout(`${PREFIX}starting the ${scenario} run: ${[program, ...args].join(' ')}`);
      const child = this.#trySpawn(program, args);
      if (child instanceof Error) {
        notStarted(`could not be started: ${child.message}`);
        return;
      }
      slot.child = child;
      let spawned = false;
      child.once('spawn', () => {
        spawned = true;
      });
      // Emitted instead of 'spawn' when the program cannot be started, and when a signal cannot be sent.
      child.on('error', (error) => {
        if (spawned) this.#output.stderr(`${PREFIX}the ${scenario} run: ${error.message}`);
        else notStarted(`could not be started: ${error.message}`);
      });
      forwardLines(child.stdout, (line) => this.#output.stdout(line));
      forwardLines(child.stderr, (line) => this.#output.stderr(line));
      // Emitted once the output has closed too, so the run's own lines all come before this one.
      child.once('close', (code, signal) => {
        if (ended) return;
        this.#output.stdout(
          signal === null
            ? `${PREFIX}the ${scenario} run exited with code ${code}`
            : `${PREFIX}the ${scenario} run ended on ${signal}`,
        );
        end(code, signal);
      });
      cancels.push(
        this.#schedule(() => {
          this.#output.stderr(`${PREFIX}the ${scenario} run has run for ${this.#maxRunSeconds} seconds: sending SIGTERM`);
          child.kill('SIGTERM');
          cancels.push(
            this.#schedule(() => {
              this.#output.stderr(
                `${PREFIX}the ${scenario} run is still going ${KILL_GRACE_MS / 1000} seconds after SIGTERM: sending SIGKILL`,
              );
              child.kill('SIGKILL');
            }, KILL_GRACE_MS),
          );
        }, this.#maxRunSeconds * 1000),
      );
    });
  }
}
```

Notes for the executor:

- `#start` counts the run before anything can fail, so a `202` always counts one run.
- On a program that cannot be started, Node emits `'error'` and no `'spawn'`. It may emit `'close'`
  after it, with a negative code; `end` has already run by then, so that `'close'` writes nothing.
- The working folder is not passed: the program inherits the gateway's.
- The default timers keep the gateway's process alive while a run is in progress, and `end` cancels
  them, so a stopped gateway exits once its run has ended.

- [ ] **Step 9: Run them and see them pass**

Run: `pnpm --filter @quorum-on-near/gateway exec vitest run test/demo.test.ts test/config.test.ts`

Expected: PASS. `test/demo.test.ts` has 20 tests: all pass on Linux and macOS; on Windows 19 pass
and `sends SIGKILL 10 seconds after SIGTERM to a run that is still going` is skipped.

Run: `pnpm --filter @quorum-on-near/gateway typecheck`

Expected: exit code 0.

- [ ] **Step 10: Run the whole workspace**

```bash
pnpm typecheck
pnpm test
```

Expected: both exit 0; the gateway's count is Task 1's plus 39 (19 in `config.test.ts`, 20 in
`demo.test.ts`, one of them skipped on Windows).

- [ ] **Step 11: Commit the runner**

```bash
git add apps/gateway/src/demo.ts apps/gateway/test/demo.test.ts apps/gateway/test/fixtures/demo-program.mjs
git commit -F - <<'EOF'
add the demo runner, which starts one swarm run at a time

DemoRunner takes the slot in the same synchronous step that checks it, so two requests never both
start a run, and counts a run towards its UTC day's cap when it starts. It starts the command plus
the scenario without a shell, in the gateway's folder, with the gateway's environment minus the
relayer keys, the credential key and the seed phrase variables. Each output line goes to the
gateway's standard output or error prefixed "[demo] ", the last one even without a newline. The
exit code or signal of a run is kept as the last run's; both are null for a program that could not
be started. A run past its maximum time gets SIGTERM, then SIGKILL 10 seconds later, and stop()
sends SIGTERM to a run in progress.
EOF
```

---

### Task 5: The demo routes, `/config.json`'s `demo`, and the wiring in `main.ts`

The HTTP side of the demo (hosted demo spec, section 4.2). `createApp` takes the runner as an option
(`AppOptions.demo`), not as a member of `Deps`, so the handlers' dependencies, the test helper
`testDeps` and the sandbox test's own `Deps` stay as they are. With no runner, the three routes do
not exist and answer the app's usual `404 {"error":"not_found"}`.

A `POST /demo/fills` or `POST /demo/fails` is answered by the first of these that applies:

1. demo off: `404 not_found` (no route);
2. no header `X-Quorum-Demo: 1`: `403 {"error":"demo_header_required"}`;
3. `claim` answers `running`: `409 {"error":"demo_running","scenario":…,"startedAt":…}`;
4. `claim` answers `limit`: `429 {"error":"demo_limit"}`;
5. one of the provider's pools has `status: 'open'` (the `PoolView` status the contract derives from
   block time, `'open' | 'filled' | 'settled' | 'expired' | 'refunded'` in
   `packages/protocol/src/contract.ts`; the swarm refuses to open a pool on the same test): the slot
   is released and the answer is `409 {"error":"pool_open","poolId":…}`, naming the newest such pool,
   which is the one the page follows;
6. `listServedPools` throws: the slot is released, the error is logged, and the answer is
   `503 {"error":"chain_unavailable"}`;
7. otherwise the run starts: `202 {"scenario":…,"startedAt":…}`.

Steps 3 and 4 run in `claim`, synchronously, before the pools are read. `GET /demo` answers the
runner's `status()`. `/config.json` gains `demo: true` when a runner is given. The routes read no
request body and set no CORS header; the gateway has no `OPTIONS` route, so a preflight gets `404`.

`main.ts` creates the runner only when `QUORUM_DEMO_COMMAND` is set, and its shutdown calls
`stop()`. `main.ts` has no unit test (it reads the chain at startup); the typecheck covers the
wiring, and the rehearsal of Task 9 runs it.

This task assumes `apps/gateway/src/app.ts` as Task 1 leaves it, and `main.ts` as on `main` after the
two earlier plans (neither changes it). The app's tests use the real `DemoRunner` of Task 4 with the
stand-in program `test/fixtures/demo-program.mjs`, and the existing `FakeChain`.

**Files:**
- Modify: `apps/gateway/src/app.ts` (imports, a `DEMO_HEADER` constant, `AppOptions`, `createApp`'s
  signature and doc comment, `/config.json`, the demo routes), `apps/gateway/src/main.ts` (the runner,
  `createApp`'s options, `shutdown`)
- Test: `apps/gateway/test/app.test.ts`

**Interfaces:**
- Consumes: from Task 4, `DemoRunner` (`claim`, `status`, `stop`), `DemoClaim`, `DEMO_SCENARIOS`, and
  `GatewayConfig.demoCommand`, `.demoMaxRunsPerDay`, `.demoMaxRunSeconds`; from the gateway,
  `listServedPools(chain: ChainReader, provider: string): Promise<PoolView[]>` (`pools.ts`, every pool
  whose `seller` is the provider, in id order), `PoolView` from `@quorum-on-near/protocol`, `Deps`,
  and the app's `notFound` handler; in the tests, `setup`, `answer`, `poolView`, `POOL_ID`,
  `NOW_MS` and `FakeChain` (`reads`, `setPool`, `listPools`).
- Produces:
  - `export interface AppOptions { fetch?: typeof fetch; demo?: DemoRunner | null }` and
    `createApp(deps: Deps, options: AppOptions = {}): Hono`
  - routes `POST /demo/fills`, `POST /demo/fails`, `GET /demo`, answering as listed at the top of
    this task; `GET /config.json` gains
    `demo: boolean`
  - the request header name `X-Quorum-Demo`, value `1` (Task 6's page sends it)

- [ ] **Step 1: Write the failing tests**

In `apps/gateway/test/app.test.ts`:

Add `import { fileURLToPath } from 'node:url';` after `import { dirname, join } from 'node:path';`.

Replace `import { createApp } from '../src/app.ts';` with:

```typescript
import { createApp, type AppOptions } from '../src/app.ts';
```

and add, after `import type { Deps } from '../src/deps.ts';`:

```typescript
import { DemoRunner } from '../src/demo.ts';
```

Replace the first line of the helper `setup`:

```typescript
async function setup(config: Partial<GatewayConfig> = {}, options: { fetch?: typeof fetch } = {}) {
```

with:

```typescript
async function setup(config: Partial<GatewayConfig> = {}, options: AppOptions = {}) {
```

After `const APP_JS = 'export const ready = true;\n';` (before `describe('createApp', () => {`), add:

```typescript
/** The stand-in for the swarm's demo command (its modes are listed in the file). */
const DEMO_PROGRAM = fileURLToPath(new URL('./fixtures/demo-program.mjs', import.meta.url));
/** The header a demo POST must carry. */
const DEMO_HEADERS = { 'X-Quorum-Demo': '1' };
/** How long a test waits for the program: starting Node takes a few hundred milliseconds. */
const DEMO_WAIT = { timeout: 5_000, interval: 10 };

/**
 * The app with the demo on. Its runner starts the stand-in program in `mode`, at most `maxRunsPerDay`
 * times a day and 1800 seconds a run, over a clock the test moves, and collects its lines in `output`.
 * Pool 7 is settled, so none of the provider's pools is Open. Once the test has finished, no run is
 * left in progress.
 */
async function demoApp(mode: string[] = ['exit', '0'], maxRunsPerDay = 100) {
  const clock = { now: NOW_MS };
  const output: string[] = [];
  const demo = new DemoRunner({
    command: [process.execPath, DEMO_PROGRAM, ...mode],
    maxRunsPerDay,
    maxRunSeconds: 1800,
    now: () => clock.now,
    output: { stdout: (line) => output.push(line), stderr: (line) => output.push(line) },
  });
  onTestFinished(async () => {
    demo.stop();
    await idle(demo);
  });
  const { deps, fake, app } = await setup({}, { demo });
  fake.setPool(poolView({ id: POOL_ID, status: 'settled', taken: 192 }));
  return { deps, fake, app, demo, clock, output };
}

/** Waits until `demo` has no run in progress. */
async function idle(demo: DemoRunner): Promise<void> {
  await vi.waitFor(() => expect(demo.status().running).toBe(false), DEMO_WAIT);
}

/** A demo POST for `scenario`, with the demo header unless `headers` says otherwise. */
function postDemo(
  app: Awaited<ReturnType<typeof setup>>['app'],
  scenario: string,
  headers: Record<string, string> = DEMO_HEADERS,
): Response | Promise<Response> {
  return app.request(`/demo/${scenario}`, { method: 'POST', headers });
}
```

In `describe('GET /config.json', …)`, replace:

```typescript
      explorerTxUrl: 'https://testnet.nearblocks.io/txns/',
    };
```

with:

```typescript
      explorerTxUrl: 'https://testnet.nearblocks.io/txns/',
      demo: false,
    };
```

and add this test after `points the page at /rpc when the pass-through is on`:

```typescript
    it('says the demo is on when the app has a demo runner', async () => {
      const { app } = await demoApp();
      expect(await answer(app.request('/config.json'))).toMatchObject({ status: 200, body: { demo: true } });
    });
```

After the block `describe('POST /rpc limits', …)` (before `describe("only the live page's own
files", …)`), add:

```typescript
  describe('the demo', { timeout: 20_000 }, () => {
    it.each([
      ['POST /demo/fills', 'POST', '/demo/fills', DEMO_HEADERS],
      ['POST /demo/fails', 'POST', '/demo/fails', DEMO_HEADERS],
      ['GET /demo', 'GET', '/demo', {}],
      ['POST /demo/fills without the header', 'POST', '/demo/fills', {}],
    ] as const)('answers %s with 404 not_found when the demo is off', async (_label, method, path, headers) => {
      const { app } = await setup();
      expect(await answer(app.request(path, { method, headers }))).toEqual({ status: 404, body: { error: 'not_found' } });
    });

    it.each([
      ['no header', {}],
      ['another value', { 'X-Quorum-Demo': 'true' }],
    ] as const)('answers 403 demo_header_required to a POST with %s, and reads and starts nothing', async (_label, headers) => {
      const { app, fake } = await demoApp();
      expect(await answer(postDemo(app, 'fills', headers))).toEqual({
        status: 403,
        body: { error: 'demo_header_required' },
      });
      expect(fake.reads.has('list_pools')).toBe(false);
      expect(await answer(app.request('/demo'))).toMatchObject({ status: 200, body: { running: false, runsToday: 0 } });
    });

    it('starts a run of the scenario asked for, and answers 202 with its scenario and start', async () => {
      const { app, demo, output } = await demoApp(['describe']);
      expect(await answer(postDemo(app, 'fails'))).toEqual({ status: 202, body: { scenario: 'fails', startedAt: NOW_MS } });
      await idle(demo);
      const description = output.find((line) => line.startsWith('[demo] {')) ?? '[demo] null';
      expect(JSON.parse(description.slice('[demo] '.length))).toMatchObject({ argv: ['describe', 'fails'] });
      expect(await answer(app.request('/demo'))).toMatchObject({
        status: 200,
        body: { running: false, runsToday: 1, last: { scenario: 'fails', exitCode: 0, signal: null } },
      });
    });

    it('answers 409 demo_running with the running scenario and start while a run is in progress', async () => {
      const { app, clock } = await demoApp(['hang']);
      expect(await answer(postDemo(app, 'fills'))).toEqual({ status: 202, body: { scenario: 'fills', startedAt: NOW_MS } });
      clock.now = NOW_MS + 30_000;
      expect(await answer(postDemo(app, 'fails'))).toEqual({
        status: 409,
        body: { error: 'demo_running', scenario: 'fills', startedAt: NOW_MS },
      });
    });

    it('answers 409 demo_running to a second request sent in the same tick as the first', async () => {
      const { app, fake } = await demoApp(['hang']);
      // The first request takes the slot before it reads the pools, so the second, sent before that
      // read has answered, finds the slot taken.
      const first = postDemo(app, 'fills');
      const second = postDemo(app, 'fails');
      expect(await answer(second)).toEqual({
        status: 409,
        body: { error: 'demo_running', scenario: 'fills', startedAt: NOW_MS },
      });
      expect(await answer(first)).toEqual({ status: 202, body: { scenario: 'fills', startedAt: NOW_MS } });
      expect(fake.reads.get('list_pools')).toBe(1);
    });

    it("answers 409 pool_open with the provider's newest Open pool, and neither starts nor counts a run", async () => {
      const { app, fake } = await demoApp();
      fake.setPool(poolView({ id: POOL_ID }));
      fake.setPool(poolView({ id: 8, seller: 'other-seller.testnet' }));
      fake.setPool(poolView({ id: 9 }));
      expect(await answer(postDemo(app, 'fills'))).toEqual({ status: 409, body: { error: 'pool_open', poolId: 9 } });
      expect(await answer(app.request('/demo'))).toEqual({
        status: 200,
        body: { running: false, scenario: null, startedAt: null, last: null, runsToday: 0, maxRunsPerDay: 100 },
      });
      // The slot was released. Once the provider's pools have ended, a run starts, although another
      // seller's pool is still Open.
      fake.setPool(poolView({ id: POOL_ID, status: 'settled', taken: 192 }));
      fake.setPool(poolView({ id: 9, status: 'refunded' }));
      expect(await answer(postDemo(app, 'fills'))).toEqual({ status: 202, body: { scenario: 'fills', startedAt: NOW_MS } });
    });

    it('answers 503 chain_unavailable when the pools cannot be read, and neither starts nor counts a run', async () => {
      const { app, fake } = await demoApp();
      const failure = new Error('RPC down');
      const listPools = vi.spyOn(fake, 'listPools').mockRejectedValue(failure);
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(await answer(postDemo(app, 'fills'))).toEqual({ status: 503, body: { error: 'chain_unavailable' } });
      expect(logged).toHaveBeenCalledExactlyOnceWith(expect.any(String), failure);
      expect(await answer(app.request('/demo'))).toMatchObject({
        status: 200,
        body: { running: false, last: null, runsToday: 0 },
      });
      // The slot was released.
      listPools.mockRestore();
      expect(await answer(postDemo(app, 'fills'))).toEqual({ status: 202, body: { scenario: 'fills', startedAt: NOW_MS } });
    });

    it("answers 429 demo_limit once today's cap is reached, and starts runs again after midnight UTC", async () => {
      const { app, demo, clock } = await demoApp(['exit', '0'], 1);
      expect(await answer(postDemo(app, 'fills'))).toEqual({ status: 202, body: { scenario: 'fills', startedAt: NOW_MS } });
      await idle(demo);
      expect(await answer(postDemo(app, 'fails'))).toEqual({ status: 429, body: { error: 'demo_limit' } });
      expect(await answer(app.request('/demo'))).toMatchObject({ body: { runsToday: 1, maxRunsPerDay: 1 } });
      // NOW_MS is 2027-01-15T07:43:20Z; this is the next midnight UTC.
      const midnight = Date.UTC(2027, 0, 16);
      clock.now = midnight;
      expect(await answer(app.request('/demo'))).toMatchObject({ body: { runsToday: 0, maxRunsPerDay: 1 } });
      expect(await answer(postDemo(app, 'fails'))).toEqual({ status: 202, body: { scenario: 'fails', startedAt: midnight } });
    });

    it('answers in the order: header, run in progress, cap, then the pools, which only the last of these reads', async () => {
      const { app, fake, demo } = await demoApp(['hang'], 1);
      expect(await answer(postDemo(app, 'fills'))).toEqual({ status: 202, body: { scenario: 'fills', startedAt: NOW_MS } });
      // From here on, a run is in progress, today's cap is reached, and one of the provider's pools is Open.
      fake.setPool(poolView({ id: POOL_ID }));
      expect(await answer(postDemo(app, 'fails', {}))).toEqual({ status: 403, body: { error: 'demo_header_required' } });
      expect(await answer(postDemo(app, 'fails'))).toEqual({
        status: 409,
        body: { error: 'demo_running', scenario: 'fills', startedAt: NOW_MS },
      });
      demo.stop();
      await idle(demo);
      // Today's cap is reached, and a pool is Open.
      expect(await answer(postDemo(app, 'fails'))).toEqual({ status: 429, body: { error: 'demo_limit' } });
      // Only the request that started the run read the pools.
      expect(fake.reads.get('list_pools')).toBe(1);
    });

    it('answers GET /demo before, during and after a run', async () => {
      const { app, demo, clock } = await demoApp(['hang']);
      expect(await answer(app.request('/demo'))).toEqual({
        status: 200,
        body: { running: false, scenario: null, startedAt: null, last: null, runsToday: 0, maxRunsPerDay: 100 },
      });
      expect((await postDemo(app, 'fills')).status).toBe(202);
      expect(await answer(app.request('/demo'))).toEqual({
        status: 200,
        body: { running: true, scenario: 'fills', startedAt: NOW_MS, last: null, runsToday: 1, maxRunsPerDay: 100 },
      });
      clock.now = NOW_MS + 90_000;
      demo.stop();
      await idle(demo);
      expect(await answer(app.request('/demo'))).toEqual({
        status: 200,
        body: {
          running: false,
          scenario: null,
          startedAt: null,
          last: { scenario: 'fills', startedAt: NOW_MS, endedAt: NOW_MS + 90_000, exitCode: null, signal: 'SIGTERM' },
          runsToday: 1,
          maxRunsPerDay: 100,
        },
      });
    });

    it('answers GET /demo with the exit code of a run that exited', async () => {
      const { app, demo } = await demoApp(['exit', '3']);
      expect((await postDemo(app, 'fails')).status).toBe(202);
      await idle(demo);
      expect(await answer(app.request('/demo'))).toMatchObject({
        status: 200,
        body: {
          running: false,
          last: { scenario: 'fails', startedAt: NOW_MS, endedAt: NOW_MS, exitCode: 3, signal: null },
        },
      });
    });

    it('sends no CORS header and answers no preflight', async () => {
      const { app } = await demoApp(['hang']);
      const preflight = await app.request('/demo/fills', {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://elsewhere.example',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'x-quorum-demo',
        },
      });
      const started = await postDemo(app, 'fills');
      const status = await app.request('/demo');
      expect([preflight.status, started.status, status.status]).toEqual([404, 202, 200]);
      for (const res of [preflight, started, status]) {
        expect([...res.headers.keys()].filter((name) => name.startsWith('access-control-'))).toEqual([]);
      }
    });
  });
```

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm --filter @quorum-on-near/gateway exec vitest run test/app.test.ts`

Expected: FAIL, 15 tests: the three of `GET /config.json` (no `demo` in the body), and the twelve
tests of `the demo` other than the four `when the demo is off`, which each get `404 not_found`
instead of their answer. (`createApp` ignores the `demo` option until Step 3; vitest does not
typecheck, so `AppOptions` not existing yet does not stop the file from loading.)

- [ ] **Step 3: Implement the routes**

In `apps/gateway/src/app.ts`, make these edits.

Replace:

```typescript
import { PAYMENT_HEADER, PROOF_HEADER } from '@quorum-on-near/protocol';
```

with:

```typescript
import { PAYMENT_HEADER, PROOF_HEADER, type PoolView } from '@quorum-on-near/protocol';
```

Replace:

```typescript
import type { Deps } from './deps.ts';
```

with:

```typescript
import { DEMO_SCENARIOS, type DemoRunner } from './demo.ts';
import type { Deps } from './deps.ts';
```

Replace:

```typescript
import { openPoolListings } from './pools.ts';
```

with:

```typescript
import { listServedPools, openPoolListings } from './pools.ts';
```

After the `PAGE_FILES` constant (Task 1), add:

```typescript
/**
 * The header a demo `POST` must carry, with the value `1`. A page on another site cannot send it
 * without a CORS preflight, which the gateway never answers, so a browser never sends that page's
 * request: a form or a beacon from another site cannot start a run.
 */
const DEMO_HEADER = 'X-Quorum-Demo';
```

Replace the doc comment of `createApp` and the first lines of its body, from `/**` above
`* The HTTP app (spec section 6.1):` down to `const app = new Hono();`, with:

```typescript
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
 * - the live page's files (only when `config.webDir` is set): its `index.html` at `/` and
 *   `/index.html`, and `/app.js`, `/totals.js` and `/style.css`; nothing else in its folder
 *
 * Every answer is JSON except the static files.
 */
export function createApp(deps: Deps, options: AppOptions = {}): Hono {
  const { config } = deps;
  const demo = options.demo ?? null;
  const app = new Hono();
```

Replace:

```typescript
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
```

with:

```typescript
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
```

Between the end of the `if (config.rpcPassthrough) { … }` block and the comment
`// Only the page's own files, each at its own route.` (Task 1), add:

```typescript
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
          pools = await listServedPools(deps.chain, config.provider);
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

```

`findLast` is in the `ES2023` library that `tsconfig.base.json` sets, and in Node 22.

In `apps/gateway/src/main.ts`, replace:

```typescript
import type { Deps } from './deps.ts';
```

with:

```typescript
import { DemoRunner } from './demo.ts';
import type { Deps } from './deps.ts';
```

Replace:

```typescript
const server = serve({ fetch: createApp(deps).fetch, port: config.port }, (info) => {
```

with:

```typescript
// The demo endpoint is on only when QUORUM_DEMO_COMMAND names the program of a run.
const demo =
  config.demoCommand === null
    ? null
    : new DemoRunner({
        command: config.demoCommand,
        maxRunsPerDay: config.demoMaxRunsPerDay,
        maxRunSeconds: config.demoMaxRunSeconds,
      });
if (demo !== null) {
  console.log(`demo endpoint on: each run starts ${JSON.stringify(config.demoCommand)}, then its scenario`);
}

const server = serve({ fetch: createApp(deps, { demo }).fetch, port: config.port }, (info) => {
```

Replace:

```typescript
/** Stops taking requests and keeper ticks; the process exits once the running ones finish. */
function shutdown(signal: NodeJS.Signals): void {
  // A second signal ends the process at once.
  process.off('SIGINT', shutdown);
  process.off('SIGTERM', shutdown);
  console.log(`${signal}: shutting down`);
  closeServer();
  void keeper.stop();
}
```

with:

```typescript
/**
 * Stops taking requests and keeper ticks, and sends a demo run in progress SIGTERM; the process exits
 * once the running ones finish.
 */
function shutdown(signal: NodeJS.Signals): void {
  // A second signal ends the process at once.
  process.off('SIGINT', shutdown);
  process.off('SIGTERM', shutdown);
  console.log(`${signal}: shutting down`);
  closeServer();
  void keeper.stop();
  demo?.stop();
}
```

- [ ] **Step 4: Run them and see them pass**

Run: `pnpm --filter @quorum-on-near/gateway exec vitest run test/app.test.ts`

Expected: PASS, with 17 more tests than after Task 1 (16 in `the demo`, 1 in `GET /config.json`).

Run: `pnpm --filter @quorum-on-near/gateway typecheck`

Expected: exit code 0. This also checks `main.ts`, and the sandbox test's `createApp(deps)`, which
still compiles since `options` is optional.

- [ ] **Step 5: Run the whole workspace**

```bash
pnpm typecheck
pnpm test
```

Expected: both exit 0; the gateway's count is Task 4's plus 17. The swarm's and the MCP server's
tests, which start the gateway in their sandbox harness without `QUORUM_DEMO_COMMAND`, are not
affected: the demo is off there.

- [ ] **Step 6: Commit**

```bash
git add apps/gateway/src/app.ts apps/gateway/src/main.ts apps/gateway/test/app.test.ts
git commit -F - <<'EOF'
add the demo endpoint and stop a demo run when the gateway stops

With QUORUM_DEMO_COMMAND set, POST /demo/fills and POST /demo/fails start a run, answered in this
order: 403 without the X-Quorum-Demo: 1 header, 409 demo_running while a run is in progress, 429
demo_limit at the day's cap, 409 pool_open while one of the provider's pools is Open and 503
chain_unavailable when the pools cannot be read (neither of these two is counted), otherwise 202.
GET /demo reports the run in progress, the last run and the day's count, and /config.json says
whether the demo is on. With the demo off, the three routes answer 404. When the gateway shuts
down, it sends a run in progress SIGTERM.
EOF
```

### Task 6: The live page's buttons and demo line

When `/config.json` has `demo: true`, the page shows two buttons, "Start a pool that fills" and
"Start a pool that fails", and a demo line, apart from the status line (`#status`), which keeps
saying when the page last refreshed. With `demo: false`, or a gateway that sends no `demo`, the page
is as before. The page now also sends `GET /demo` on each refresh (only when the demo is on) and, on
a click, one `POST /demo/<scenario>`; it still never signs anything and needs no wallet.

All the logic stays in `totals.js` as pure functions, unit-tested as the rest of the file is:
checking `GET /demo` (`parseDemoStatus`) and a click's answer (`parseDemoAnswer`), the request a
button sends (`demoRequest`), the page URL without `?pool=` (`withoutPoolParam`), whether the
controls are shown and enabled (`demoControls`), and the demo line (`demoLine`), with every case of
spec §5 in its order of precedence and the 10-second window after a click's answer measured against
an injected `now`. `parseConfig` gains `demo`. `app.js` only fetches and renders, as before; the
page test checks the markup and the order of a click's two actions, as it already checks the page's
other static facts.

This task assumes `apps/web` exactly as the live page plan wrote it (its Tasks 1 and 2); the edits
below quote that code. If the merged files differ, apply each edit at the same place by meaning.

**Files:**
- Modify: `apps/web/totals.js` (the module comment, the `PageConfig` typedef, new demo typedefs,
  `parseConfig`, new demo functions at the end)
- Modify: `apps/web/app.js` (the module comment, the imports, `ui`, the state, `tick`, new
  `refreshDemo`, `renderDemo`, `startRun`, the button listeners)
- Modify: `apps/web/index.html` (the demo section after the toolbar)
- Modify: `apps/web/style.css` (the demo rules after `.status.failed`)
- Test: `apps/web/test/totals.test.ts`, `apps/web/test/page.test.ts`

**Interfaces:**
- Consumes: from the gateway (Task 5): `GET /config.json` with `demo: boolean`; `GET /demo` →
  `{running, scenario, startedAt, last, runsToday, maxRunsPerDay}` (spec §4.2; `404` when the demo
  is off); `POST /demo/fills` and `POST /demo/fails`, which need the header `X-Quorum-Demo: 1` and
  answer `202 {scenario, startedAt}`, `403 {error:"demo_header_required"}`,
  `409 {error:"demo_running", scenario, startedAt}`, `429 {error:"demo_limit"}`,
  `409 {error:"pool_open", poolId}`, `503 {error:"chain_unavailable"}`, or `404` when the demo is
  off. From the live page plan: `totals.js`'s `PageDataError`, `isObject`, `isCount`, `parseConfig`,
  `CONFIG_KEYS`, `isHttpUrl`; `app.js`'s `element`, `ui`, `getJson`, `loadSetup`, `poll`, `tick`,
  `showStatus`, `setup`, `polling`, `REQUEST_TIMEOUT_MS`, `POLL_INTERVAL_MS`.
- Produces:
  - `totals.js` exports `DEMO_ANSWER_MS` (`10_000`), `parseDemoStatus(value: unknown): DemoStatus`,
    `parseDemoAnswer(status: number, body: unknown): DemoAnswer`,
    `demoRequest(scenario: DemoScenario): {url, method: 'POST', headers}`,
    `withoutPoolParam(href: string): string`,
    `demoControls({demo, status, sending}): {shown, enabled}`, `demoLine(input: DemoLineInput): string`,
    and the typedefs `DemoScenario`, `DemoLastRun`, `DemoStatus`, `DemoAnswer`, `DemoClick`,
    `DemoLineInput`. `PageConfig` gains `demo: boolean`, which `parseConfig` sets (`false` when the
    gateway sends none).
  - `index.html`: `<section id="demo" … hidden>` holding `#demo-fills`, `#demo-fails` and `#demo-line`.
  - `app.js` looks up the ids `demo`, `demo-fills`, `demo-fails` and `demo-line` as well.

- [ ] **Step 1: Write the failing tests**

In `apps/web/test/totals.test.ts`, replace the import block at the top of the file (from
`import { describe, expect, it } from 'vitest';` to `} from '../totals.js';`) with:

```typescript
import { describe, expect, it } from 'vitest';
import {
  DEMO_ANSWER_MS,
  PageDataError,
  buyerRows,
  countdown,
  demoControls,
  demoLine,
  demoRequest,
  foreignPoolNotice,
  formatAmount,
  formatUnits,
  parseActivity,
  parseBalance,
  parseConfig,
  parseDemoAnswer,
  parseDemoStatus,
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
  withoutPoolParam,
  type ActivityRecord,
  type DemoClick,
  type DemoLastRun,
  type DemoStatus,
  type PoolView,
  type SeatView,
} from '../totals.js';
```

In the same file, replace the whole `describe('parseConfig', …)` block with:

```typescript
describe('parseConfig', () => {
  const CONFIG = {
    network: 'near:testnet',
    rpcUrl: '/rpc',
    poolsContract: 'pools.quorum.testnet',
    token: '3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af',
    provider: 'provider.quorum.testnet',
    explorerTxUrl: EXPLORER,
  };

  it("accepts the gateway's /config.json, reading a missing demo as off", () => {
    expect(parseConfig(CONFIG)).toEqual({ ...CONFIG, demo: false });
  });

  it.each([true, false])('keeps demo: %s', (demo) => {
    expect(parseConfig({ ...CONFIG, demo })).toEqual({ ...CONFIG, demo });
  });

  it.each([
    ['not an object', [CONFIG]],
    ['missing the provider', { ...CONFIG, provider: undefined }],
    ['an RPC URL that is not text', { ...CONFIG, rpcUrl: 8402 }],
    ['an explorer URL that is not http(s)', { ...CONFIG, explorerTxUrl: 'javascript:alert(1)//' }],
    ['an explorer URL that is not a URL', { ...CONFIG, explorerTxUrl: 'nearblocks' }],
    ['demo as text', { ...CONFIG, demo: 'true' }],
    ['demo as null', { ...CONFIG, demo: null }],
  ])('throws a PageDataError for a configuration with %s', (_kind, config) => {
    expect(() => parseConfig(config)).toThrow(PageDataError);
  });
});
```

Then append to the end of the file:

```typescript
/** The time the demo tests read: 08:00:00 UTC. */
const DEMO_NOW = 1_800_000_000_000;
/** Writes a time as the demo line would, in UTC, so that the tests do not depend on the time zone. */
const utcTime = (ms: number): string => new Date(ms).toISOString().slice(11, 19);
const IDLE: DemoStatus = { running: false, scenario: null, startedAt: null, last: null, runsToday: 0, maxRunsPerDay: 100 };
/** A fills run started at 07:58:30. */
const RUNNING: DemoStatus = { ...IDLE, running: true, scenario: 'fills', startedAt: DEMO_NOW - 90_000, runsToday: 1 };
/** A fails run that exited with code 0 at 07:59:30. */
const ENDED_RUN: DemoLastRun = { scenario: 'fails', startedAt: DEMO_NOW - 300_000, endedAt: DEMO_NOW - 30_000, exitCode: 0, signal: null };
const ENDED: DemoStatus = { ...IDLE, runsToday: 1, last: ENDED_RUN };
/** Today's cap reached: 100 runs of 100, the last one ended well. */
const CAPPED: DemoStatus = { ...ENDED, runsToday: 100 };

/** The demo line at DEMO_NOW for `status` (null: GET /demo could not be read), after `click` if given. */
function demoLineAt(status: DemoStatus | null, click: DemoClick | null = null): string {
  return demoLine({ now: DEMO_NOW, click, status, time: utcTime });
}

/** A click whose answer arrived `ago` milliseconds before DEMO_NOW. */
function clickAgo(ago: number, answer: DemoClick['answer']): DemoClick {
  return { at: DEMO_NOW - ago, answer };
}

describe('parseDemoStatus', () => {
  const STOPPED_RUN = { scenario: 'fills', startedAt: DEMO_NOW - 2_000_000, endedAt: DEMO_NOW - 200_000, exitCode: null, signal: 'SIGTERM' };

  it.each([
    ['no run yet', IDLE],
    ['a run in progress', RUNNING],
    ['a last run that exited', ENDED],
    ['a last run ended by a signal', { ...IDLE, runsToday: 3, last: STOPPED_RUN }],
    ['a last run whose program could not be started', { ...IDLE, runsToday: 1, last: { ...STOPPED_RUN, signal: null } }],
    ["the day's cap reached", CAPPED],
  ])("accepts the gateway's GET /demo with %s", (_kind, status) => {
    expect(parseDemoStatus(status)).toEqual(status);
  });

  it.each([
    ['not an object', [IDLE]],
    ['running as text', { ...IDLE, running: 'false' }],
    ['an unknown scenario', { ...RUNNING, scenario: 'drains' }],
    ['a run in progress with no scenario', { ...RUNNING, scenario: null }],
    ['a run in progress with no start time', { ...RUNNING, startedAt: null }],
    ['a scenario while no run is in progress', { ...IDLE, scenario: 'fills' }],
    ['a start time as text', { ...RUNNING, startedAt: '1800000000000' }],
    ['a last run with an unknown scenario', { ...ENDED, last: { ...ENDED_RUN, scenario: 'drains' } }],
    ['a last run with no end time', { ...ENDED, last: { ...ENDED_RUN, endedAt: undefined } }],
    ['a last run with an exit code as text', { ...ENDED, last: { ...ENDED_RUN, exitCode: '0' } }],
    ['a last run with a signal as a number', { ...ENDED, last: { ...ENDED_RUN, exitCode: null, signal: 15 } }],
    ['a negative count of runs', { ...IDLE, runsToday: -1 }],
    ['a cap that is not a whole number', { ...IDLE, maxRunsPerDay: 1.5 }],
  ])('throws a PageDataError for a status with %s', (_kind, status) => {
    expect(() => parseDemoStatus(status)).toThrow(PageDataError);
  });
});

describe('parseDemoAnswer', () => {
  it('keeps the status and the error code of an answer', () => {
    expect(parseDemoAnswer(409, { error: 'demo_running', scenario: 'fills', startedAt: DEMO_NOW })).toEqual({
      status: 409,
      error: 'demo_running',
    });
  });

  it.each([
    ['a 202, which has no error', 202, { scenario: 'fills', startedAt: DEMO_NOW }],
    ['a body that is not JSON', 502, null],
    ['an error that is not text', 409, { error: 409 }],
  ])('gives a null error for %s', (_kind, status, body) => {
    expect(parseDemoAnswer(status, body)).toEqual({ status, error: null });
  });
});

describe('demoLine', () => {
  it.each([
    ['202', { status: 202, error: null }, 'A run started. Its pool appears here once it opens.'],
    ['409 demo_running', { status: 409, error: 'demo_running' }, 'A run is already in progress. This page follows its pool once it opens.'],
    ['409 pool_open', { status: 409, error: 'pool_open' }, 'A pool is still open. This page shows it.'],
    ['429', { status: 429, error: 'demo_limit' }, 'The demo has reached its limit for today.'],
    ['409 with another error', { status: 409, error: 'conflict' }, 'The demo is not available right now.'],
    ['403', { status: 403, error: 'demo_header_required' }, 'The demo is not available right now.'],
    ['404, the demo being off', { status: 404, error: 'not_found' }, 'The demo is not available right now.'],
    ['503', { status: 503, error: 'chain_unavailable' }, 'The demo is not available right now.'],
    ['500 with no error code', { status: 500, error: null }, 'The demo is not available right now.'],
    ['no answer', null, 'The gateway could not be reached.'],
  ])('shows the answer %s to a click for 10 seconds', (_kind, answer, text) => {
    expect(demoLineAt(IDLE, clickAgo(0, answer))).toBe(text);
    expect(demoLineAt(IDLE, clickAgo(9_999, answer))).toBe(text);
  });

  it('shows the answer to a click before anything GET /demo says', () => {
    for (const status of [null, RUNNING, CAPPED, ENDED, IDLE]) {
      expect(demoLineAt(status, clickAgo(5_000, { status: 202, error: null }))).toBe('A run started. Its pool appears here once it opens.');
    }
  });

  it('goes back to what GET /demo says 10 seconds after the answer arrived', () => {
    expect(DEMO_ANSWER_MS).toBe(10_000);
    expect(demoLineAt(RUNNING, clickAgo(10_000, { status: 202, error: null }))).toBe('A fills run started at 07:58:30 is in progress.');
  });

  it("says the demo's status is unavailable when GET /demo cannot be read", () => {
    expect(demoLineAt(null)).toBe("The demo's status is unavailable.");
    expect(demoLineAt(null, clickAgo(60_000, { status: 202, error: null }))).toBe("The demo's status is unavailable.");
  });

  it('names the scenario of the run in progress and when it started, before the cap', () => {
    expect(demoLineAt(RUNNING)).toBe('A fills run started at 07:58:30 is in progress.');
    expect(demoLineAt({ ...RUNNING, runsToday: 100 })).toBe('A fills run started at 07:58:30 is in progress.');
  });

  it("says when today's cap is reached, before the last run", () => {
    expect(demoLineAt(CAPPED)).toBe('The demo has reached its limit for today.');
    expect(demoLineAt({ ...CAPPED, last: { ...ENDED_RUN, exitCode: 1 } })).toBe('The demo has reached its limit for today.');
    expect(demoLineAt({ ...IDLE, runsToday: 100 })).toBe('The demo has reached its limit for today.');
  });

  it('names the scenario of the last run and when it ended, when it exited with code 0', () => {
    expect(demoLineAt(ENDED)).toBe('The last run (fails) ended at 07:59:30.');
  });

  it.each([
    ['an exit code of 1', { exitCode: 1, signal: null }],
    ['a signal', { exitCode: null, signal: 'SIGKILL' }],
    ['a program that could not be started', { exitCode: null, signal: null }],
  ])('reports a last run that ended with %s as an error', (_kind, end) => {
    expect(demoLineAt({ ...ENDED, last: { ...ENDED_RUN, ...end } })).toBe(
      'The last run ended with an error. Its testnet funds may need a refill.',
    );
  });

  it('invites a first run when there has been none', () => {
    expect(demoLineAt(IDLE)).toBe('Start a run to watch a pool from its first seat.');
  });
});

describe('demoControls', () => {
  it('hides the buttons and the demo line unless /config.json says demo: true', () => {
    expect(demoControls({ demo: false, status: IDLE, sending: false })).toEqual({ shown: false, enabled: false });
  });

  it('enables the buttons when no run is in progress and the cap is not reached', () => {
    expect(demoControls({ demo: true, status: IDLE, sending: false })).toEqual({ shown: true, enabled: true });
    expect(demoControls({ demo: true, status: { ...ENDED, runsToday: 99 }, sending: false })).toEqual({ shown: true, enabled: true });
  });

  it.each([
    ['a run is in progress', RUNNING, false],
    ["today's cap is reached", CAPPED, false],
    ['GET /demo cannot be read', null, false],
    ["a button's request is on its way", IDLE, true],
  ])('disables the buttons, still shown, when %s', (_kind, status, sending) => {
    expect(demoControls({ demo: true, status, sending })).toEqual({ shown: true, enabled: false });
  });
});

describe('demoRequest', () => {
  it.each(['fills', 'fails'] as const)('POSTs /demo/%s with the header X-Quorum-Demo: 1', (scenario) => {
    expect(demoRequest(scenario)).toEqual({ url: `/demo/${scenario}`, method: 'POST', headers: { 'X-Quorum-Demo': '1' } });
  });
});

describe('withoutPoolParam', () => {
  it.each([
    ['https://quorum.example/?pool=7', 'https://quorum.example/'],
    ['https://quorum.example/?view=1&pool=7#ledger', 'https://quorum.example/?view=1#ledger'],
    ['https://quorum.example/?pool=7&pool=8', 'https://quorum.example/'],
    ['https://quorum.example/', 'https://quorum.example/'],
  ])('turns %s into %s, so that the page follows the newest pool', (href, expected) => {
    expect(withoutPoolParam(href)).toBe(expected);
  });
});
```

In `apps/web/test/page.test.ts`, append to the end of the file:

```typescript
describe('the demo controls', () => {
  it('are hidden in the markup until app.js shows them for a gateway whose demo is on', () => {
    expect(html).toMatch(/<section id="demo" class="demo" aria-label="Demo runs" hidden>/);
  });

  it('label the two buttons as the spec words them', () => {
    expect(html).toContain('<button id="demo-fills" type="button">Start a pool that fills</button>');
    expect(html).toContain('<button id="demo-fails" type="button">Start a pool that fails</button>');
  });

  it("keep the demo line apart from the page's status line", () => {
    expect(html).toContain('<p id="demo-line" class="demo-line" role="status" aria-live="polite"></p>');
    expect(html).toContain('<p id="status" class="status" role="status" aria-live="polite">Loading…</p>');
  });

  it('remove ?pool= from the URL before sending the request a button sends', () => {
    const removed = app.indexOf("history.replaceState(null, '', withoutPoolParam(location.href))");
    const sent = app.indexOf('fetch(request.url');
    expect(removed).toBeGreaterThan(-1);
    expect(sent).toBeGreaterThan(removed);
    expect(app).toContain('const request = demoRequest(scenario);');
  });

  it('read GET /demo only when the gateway says its demo is on', () => {
    expect(app).toMatch(/if \(!config\.demo\) \{[^}]*\}\s*try \{\s*demoStatus = parseDemoStatus\(await getJson\('\/demo'\)\);/);
  });
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm --filter @quorum-on-near/web exec vitest run test/totals.test.ts test/page.test.ts`

Expected: FAIL. In `test/totals.test.ts`, every new test fails, because `totals.js` does not export
the demo functions yet (vitest reports them as not functions, or the file as failing to load), and
`parseConfig`'s first test fails on the missing `demo: false`. In `test/page.test.ts`, the five new
tests fail: the page has no demo markup and `app.js` no demo code. The earlier tests of
`test/page.test.ts` still pass.

- [ ] **Step 3: Implement the logic in `totals.js`**

In `apps/web/totals.js`, replace the module comment at the top of the file:

```js
/**
 * The live page's logic, as functions with no input or output of their own: the JSON-RPC body of a
 * view call and the decoding of its answer, structural checks of everything read from the RPC and
 * the gateway, the ledger totals, the buyer rows, the explorer links, the choice of pool, the notice
 * shown for another seller's pool and the countdown. Amounts are decimal strings in base units at the
 * edges and `bigint` inside.
 */
```

with

```js
/**
 * The live page's logic, as functions with no input or output of their own: the JSON-RPC body of a
 * view call and the decoding of its answer, structural checks of everything read from the RPC and
 * the gateway, the ledger totals, the buyer rows, the explorer links, the choice of pool, the notice
 * shown for another seller's pool, the countdown, and the demo controls: the request a demo button
 * sends, the page URL without `?pool=`, whether the buttons are shown and enabled, and the demo line.
 * Amounts are decimal strings in base units at the edges and `bigint` inside.
 */
```

Replace the `PageConfig` typedef:

```js
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
```

with this typedef and the demo typedefs after it:

```js
/**
 * The gateway's `/config.json`: what the page needs to read the chain. `rpcUrl` is `/rpc` when the
 * gateway's RPC pass-through is on. `demo` is true when the gateway's demo endpoint is on; a gateway
 * without the endpoint sends none, which reads as false.
 * @typedef {{
 *   network: string,
 *   rpcUrl: string,
 *   poolsContract: string,
 *   token: string,
 *   provider: string,
 *   explorerTxUrl: string,
 *   demo: boolean,
 * }} PageConfig
 */
/**
 * A demo run's scenario: a pool that fills, or a pool that fails.
 * @typedef {'fills' | 'fails'} DemoScenario
 */
/**
 * The last finished demo run. Times are milliseconds since the epoch. `exitCode` is the code of a
 * run that exited, `signal` the signal that ended one that did not, and both are null for a program
 * that could not be started.
 * @typedef {{
 *   scenario: DemoScenario,
 *   startedAt: number,
 *   endedAt: number,
 *   exitCode: number | null,
 *   signal: string | null,
 * }} DemoLastRun
 */
/**
 * The gateway's `GET /demo`. `scenario` and `startedAt` (milliseconds since the epoch) are set while
 * a run is in progress, and null otherwise. `runsToday` counts the runs started this UTC day.
 * @typedef {{
 *   running: boolean,
 *   scenario: DemoScenario | null,
 *   startedAt: number | null,
 *   last: DemoLastRun | null,
 *   runsToday: number,
 *   maxRunsPerDay: number,
 * }} DemoStatus
 */
/**
 * The gateway's answer to a demo button's `POST`: its HTTP status, and the `error` of its JSON body,
 * or null when it has none.
 * @typedef {{ status: number, error: string | null }} DemoAnswer
 */
/**
 * A click on a demo button: when its answer arrived (`at`, milliseconds since the epoch), and that
 * answer, or null when none came (the request failed or timed out).
 * @typedef {{ at: number, answer: DemoAnswer | null }} DemoClick
 */
/**
 * What the demo line is chosen from: the time now and the last click (milliseconds since the epoch),
 * the last `GET /demo` (null when it could not be read), and how the page writes a time.
 * @typedef {{
 *   now: number,
 *   click: DemoClick | null,
 *   status: DemoStatus | null,
 *   time: (ms: number) => string,
 * }} DemoLineInput
 */
```

Replace `parseConfig`:

```js
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
```

with

```js
/**
 * The gateway's `/config.json`. Throws a PageDataError unless every field is a string, `demo` is
 * absent or a boolean, and the explorer URL is an http(s) URL, which `txUrl` relies on. A missing
 * `demo`, from a gateway without the demo endpoint, reads as false.
 *
 * @param {unknown} value
 * @returns {PageConfig}
 */
export function parseConfig(value) {
  if (!isObject(value) || !CONFIG_KEYS.every((key) => typeof value[key] === 'string')) {
    throw new PageDataError('the gateway configuration (/config.json) is malformed');
  }
  if (value.demo !== undefined && typeof value.demo !== 'boolean') {
    throw new PageDataError('the gateway configuration (/config.json) is malformed');
  }
  if (!isHttpUrl(value.explorerTxUrl)) throw new PageDataError('the explorer URL in /config.json is not an http(s) URL');
  return /** @type {PageConfig} */ ({ ...value, demo: value.demo === true });
}
```

Append to the end of the file, after `countdown`:

```js
/** How long the demo line shows the answer to a click, from when that answer arrived. */
export const DEMO_ANSWER_MS = 10_000;

const DEMO_SCENARIOS = new Set(['fills', 'fails']);

/**
 * @param {unknown} value
 * @returns {value is DemoScenario}
 */
function isScenario(value) {
  return typeof value === 'string' && DEMO_SCENARIOS.has(value);
}

/**
 * @param {unknown} value
 * @returns {value is DemoLastRun}
 */
function isLastRun(value) {
  return (
    isObject(value) &&
    isScenario(value.scenario) &&
    isCount(value.startedAt) &&
    isCount(value.endedAt) &&
    (value.exitCode === null || (typeof value.exitCode === 'number' && Number.isSafeInteger(value.exitCode))) &&
    (value.signal === null || typeof value.signal === 'string')
  );
}

/**
 * The gateway's `GET /demo`, checked field by field: `scenario` and `startedAt` are set exactly
 * while a run is in progress, and `last` is null or a finished run. Throws a PageDataError for any
 * other shape.
 *
 * @param {unknown} value
 * @returns {DemoStatus}
 */
export function parseDemoStatus(value) {
  if (
    isObject(value) &&
    typeof value.running === 'boolean' &&
    (value.scenario === null || isScenario(value.scenario)) &&
    (value.startedAt === null || isCount(value.startedAt)) &&
    (value.scenario !== null) === value.running &&
    (value.startedAt !== null) === value.running &&
    (value.last === null || isLastRun(value.last)) &&
    isCount(value.runsToday) &&
    isCount(value.maxRunsPerDay)
  ) {
    return /** @type {DemoStatus} */ (value);
  }
  throw new PageDataError('the demo status (/demo) is malformed');
}

/**
 * The gateway's answer to a demo button's `POST`: its HTTP status, and the `error` of its JSON body
 * when that is text. `body` is null when the answer had no JSON body.
 *
 * @param {number} status
 * @param {unknown} body
 * @returns {DemoAnswer}
 */
export function parseDemoAnswer(status, body) {
  return { status, error: isObject(body) && typeof body.error === 'string' ? body.error : null };
}

/**
 * The request a demo button sends: a `POST` with the header the gateway requires. A page on another
 * site cannot send that header without a CORS preflight, which the gateway never answers.
 *
 * @param {DemoScenario} scenario
 * @returns {{ url: string, method: 'POST', headers: Record<string, string> }}
 */
export function demoRequest(scenario) {
  return { url: `/demo/${scenario}`, method: 'POST', headers: { 'X-Quorum-Demo': '1' } };
}

/**
 * The page's URL without `?pool=`, so that the page follows the provider's newest pool, which is the
 * one a run started from the page opens. Every other part of the URL is kept.
 *
 * @param {string} href
 * @returns {string}
 */
export function withoutPoolParam(href) {
  const url = new URL(href);
  url.searchParams.delete('pool');
  return url.href;
}

/**
 * Whether the demo buttons and line are shown, and whether the buttons can be clicked. They are
 * shown only when `/config.json` has `demo: true`. The buttons are disabled while a run is in
 * progress, when today's cap is reached, when `GET /demo` could not be read (`status` null), and
 * while a button's own request is on its way (`sending`), so that one click sends one request.
 *
 * @param {{ demo: boolean, status: DemoStatus | null, sending: boolean }} input
 * @returns {{ shown: boolean, enabled: boolean }}
 */
export function demoControls({ demo, status, sending }) {
  const enabled = demo && !sending && status !== null && !status.running && status.runsToday < status.maxRunsPerDay;
  return { shown: demo, enabled };
}

/**
 * What the demo line says of the answer to a click.
 *
 * @param {DemoAnswer | null} answer
 * @returns {string}
 */
function answerText(answer) {
  if (answer === null) return 'The gateway could not be reached.';
  if (answer.status === 202) return 'A run started. Its pool appears here once it opens.';
  if (answer.status === 409 && answer.error === 'demo_running') return 'A run is already in progress. This page follows its pool once it opens.';
  if (answer.status === 409 && answer.error === 'pool_open') return 'A pool is still open. This page shows it.';
  if (answer.status === 429) return 'The demo has reached its limit for today.';
  return 'The demo is not available right now.';
}

/**
 * The demo line: the first of these that applies.
 * 1. For DEMO_ANSWER_MS after a click's answer arrived, that answer.
 * 2. `GET /demo` could not be read.
 * 3. A run in progress: its scenario and when it started.
 * 4. Today's cap reached.
 * 5. The last run exited with code 0: its scenario and when it ended.
 * 6. The last run ended any other way.
 * 7. No run yet.
 *
 * @param {DemoLineInput} input
 * @returns {string}
 */
export function demoLine({ now, click, status, time }) {
  if (click !== null && now - click.at < DEMO_ANSWER_MS) return answerText(click.answer);
  if (status === null) return "The demo's status is unavailable.";
  if (status.running && status.scenario !== null && status.startedAt !== null) {
    return `A ${status.scenario} run started at ${time(status.startedAt)} is in progress.`;
  }
  if (status.runsToday >= status.maxRunsPerDay) return 'The demo has reached its limit for today.';
  const { last } = status;
  if (last === null) return 'Start a run to watch a pool from its first seat.';
  if (last.exitCode === 0) return `The last run (${last.scenario}) ended at ${time(last.endedAt)}.`;
  return 'The last run ended with an error. Its testnet funds may need a refill.';
}
```

Run: `pnpm --filter @quorum-on-near/web exec vitest run test/totals.test.ts`

Expected: PASS, 186 tests (the live page plan's 127, plus 59: 4 more in `parseConfig`, 19 in
`parseDemoStatus`, 4 in `parseDemoAnswer`, 20 in `demoLine`, 6 in `demoControls`, 2 in
`demoRequest`, 4 in `withoutPoolParam`). If the merged file had another count, it grows by 59.

- [ ] **Step 4: Add the markup, the styles and the wiring**

In `apps/web/index.html`, replace

```html
      <p id="status" class="status" role="status" aria-live="polite">Loading…</p>
    </div>

    <p id="no-pool" class="empty" hidden></p>
```

with

```html
      <p id="status" class="status" role="status" aria-live="polite">Loading…</p>
    </div>

    <section id="demo" class="demo" aria-label="Demo runs" hidden>
      <div class="demo-buttons">
        <button id="demo-fills" type="button">Start a pool that fills</button>
        <button id="demo-fails" type="button">Start a pool that fails</button>
      </div>
      <p id="demo-line" class="demo-line" role="status" aria-live="polite"></p>
    </section>

    <p id="no-pool" class="empty" hidden></p>
```

The banner paragraph stays word for word as it is.

In `apps/web/style.css`, insert after the `.status.failed` rule (the rule that sets
`color: var(--bad);` on `.status.failed`):

```css
.demo {
  display: grid;
  gap: 0.5rem;
}

.demo-buttons {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.demo-buttons button {
  font: inherit;
  font-weight: 600;
  padding: 0.4rem 0.9rem;
  border: 1px solid var(--accent);
  border-radius: 6px;
  background: var(--accent);
  color: var(--surface);
  cursor: pointer;
}

.demo-buttons button:disabled {
  border-color: var(--border);
  background: var(--track);
  color: var(--muted);
  cursor: not-allowed;
}

.demo-line {
  margin: 0;
  font-size: 0.9rem;
}
```

The existing `[hidden] { display: none !important; }` rule keeps the section hidden over
`display: grid`. The buttons take their colours from the tokens that are already redefined for the
dark scheme.

In `apps/web/app.js`, make these six edits.

1. Replace the module comment at the top:

   ```js
   /**
    * The live page. It reads the gateway's `/config.json` and the token's `ft_metadata` once, then
    * every 2 seconds the pools contract's views (through the RPC the configuration names) and the
    * gateway's activity feed, and renders one of the provider's pools. It never signs anything.
    *
    * Every value read from the RPC or the gateway is written with `textContent` or as an attribute,
    * never as HTML. The computing is in `totals.js`; this module only fetches and renders.
    */
   ```

   with

   ```js
   /**
    * The live page. It reads the gateway's `/config.json` and the token's `ft_metadata` once, then
    * every 2 seconds the pools contract's views (through the RPC the configuration names) and the
    * gateway's activity feed, and renders one of the provider's pools. It never signs anything.
    *
    * When the configuration has `demo: true`, every refresh also reads `GET /demo`, and two buttons ask
    * the gateway to start a run of the swarm (`POST /demo/fills`, `POST /demo/fails`). A demo line,
    * apart from the status line, says what the demo is doing.
    *
    * Every value read from the RPC or the gateway is written with `textContent` or as an attribute,
    * never as HTML. The computing is in `totals.js`; this module only fetches and renders.
    */
   ```

2. Replace the import statement and the `@import` line below it (from `import {` to the line
   `/** @import { ActivityRecord, … } from './totals.js' */`) with:

   ```js
   import {
     DEMO_ANSWER_MS,
     buyerRows,
     countdown,
     demoControls,
     demoLine,
     demoRequest,
     foreignPoolNotice,
     formatAmount,
     parseActivity,
     parseBalance,
     parseConfig,
     parseDemoAnswer,
     parseDemoStatus,
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
     withoutPoolParam,
   } from './totals.js';

   /** @import { ActivityRecord, BuyerRow, DemoAnswer, DemoClick, DemoScenario, DemoStatus, PageConfig, PoolStatus, PoolView, SeatView, TokenInfo, TxLink } from './totals.js' */
   ```

3. In `ui`, replace its last entries

   ```js
     noBuyers: element('no-buyers', HTMLElement),
     source: element('source', HTMLElement),
   };
   ```

   with

   ```js
     noBuyers: element('no-buyers', HTMLElement),
     source: element('source', HTMLElement),
     demo: element('demo', HTMLElement),
     demoFills: element('demo-fills', HTMLButtonElement),
     demoFails: element('demo-fails', HTMLButtonElement),
     demoLine: element('demo-line', HTMLElement),
   };
   ```

4. Replace

   ```js
   let polling = false;
   let rpcId = 0;
   ```

   with

   ```js
   let polling = false;
   let rpcId = 0;
   /**
    * The last `GET /demo`, or null when it could not be read or the demo is off.
    * @type {DemoStatus | null}
    */
   let demoStatus = null;
   /**
    * The last click on a demo button, once its answer (or its failure) has arrived.
    * @type {DemoClick | null}
    */
   let demoClick = null;
   /** True while a demo button's request is on its way. */
   let demoSending = false;
   ```

5. Replace `tick` (from its comment `/** Runs one poll, unless the previous one is still running, and
   reports how it went. */` to its closing brace) with `tick` and the three demo functions:

   ```js
   /**
    * Runs one poll, and reads the demo's state when the demo is on, unless the previous one is still
    * running; reports how it went.
    */
   async function tick() {
     if (polling) return;
     polling = true;
     try {
       const { config } = (setup ??= await loadSetup());
       const [rendered] = await Promise.all([poll(), refreshDemo(config)]);
       if (rendered) showStatus(`Updated at ${new Date().toLocaleTimeString()}`, false);
     } catch (error) {
       const reason = error instanceof Error ? error.message : String(error);
       showStatus(`Could not refresh (${reason}). Retrying every ${POLL_INTERVAL_MS / 1000} seconds.`, true);
     } finally {
       polling = false;
       renderDemo();
     }
   }

   /**
    * Reads `GET /demo` when the gateway's demo is on. Never throws: a read that fails, or returns
    * something malformed, leaves `demoStatus` null, which the demo line reports and which disables the
    * buttons.
    *
    * @param {PageConfig} config
    */
   async function refreshDemo(config) {
     if (!config.demo) {
       demoStatus = null;
       return;
     }
     try {
       demoStatus = parseDemoStatus(await getJson('/demo'));
     } catch {
       demoStatus = null;
     }
   }

   /** Shows the demo controls only when the demo is on, enables the buttons when a run can start, and writes the demo line. */
   function renderDemo() {
     const { shown, enabled } = demoControls({ demo: setup?.config.demo ?? false, status: demoStatus, sending: demoSending });
     ui.demo.hidden = !shown;
     ui.demoFills.disabled = !enabled;
     ui.demoFails.disabled = !enabled;
     if (shown) {
       ui.demoLine.textContent = demoLine({
         now: Date.now(),
         click: demoClick,
         status: demoStatus,
         time: (ms) => new Date(ms).toLocaleTimeString(),
       });
     }
   }

   /**
    * A click on a demo button. It first removes `?pool=` from the URL, so that the page follows the
    * provider's newest pool, which is the one the run opens; then it asks the gateway to start the run,
    * shows the answer on the demo line for DEMO_ANSWER_MS, and refreshes.
    *
    * @param {DemoScenario} scenario
    */
   async function startRun(scenario) {
     history.replaceState(null, '', withoutPoolParam(location.href));
     demoSending = true;
     renderDemo();
     const request = demoRequest(scenario);
     /** @type {DemoAnswer | null} */
     let answer = null;
     try {
       const response = await fetch(request.url, {
         method: request.method,
         headers: request.headers,
         signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
       });
       answer = parseDemoAnswer(response.status, await response.json().catch(() => null));
     } catch {
       answer = null;
     }
     demoSending = false;
     demoClick = { at: Date.now(), answer };
     renderDemo();
     setTimeout(renderDemo, DEMO_ANSWER_MS);
     void tick();
   }
   ```

   `poll` keeps its own `setup ??= await loadSetup();`, which is then a no-op.

6. Replace

   ```js
     void tick();
   });

   void tick();
   setInterval(tick, POLL_INTERVAL_MS);
   ```

   with

   ```js
     void tick();
   });
   ui.demoFills.addEventListener('click', () => void startRun('fills'));
   ui.demoFails.addEventListener('click', () => void startRun('fails'));

   void tick();
   setInterval(tick, POLL_INTERVAL_MS);
   ```

What this relies on: `AbortSignal.timeout` and `Response.json()` are what `getJson` already uses;
`URLSearchParams.delete` re-serialises the query and drops the `?` when nothing is left (the URL
standard's update steps), which the `withoutPoolParam` tests pin. Every value from the gateway is
still written with `textContent`, so the page test "never writes HTML from a string" keeps passing.

- [ ] **Step 5: Run the tests and the typecheck**

Run: `pnpm --filter @quorum-on-near/web exec vitest run test/totals.test.ts test/page.test.ts`

Expected: PASS, 200 tests (`test/totals.test.ts` 186, `test/page.test.ts` 14: the live page plan's
9 and the 5 new ones; "has every element app.js looks up" now also finds `demo`, `demo-fills`,
`demo-fails` and `demo-line`).

Run: `pnpm --filter @quorum-on-near/web typecheck`

Expected: exit code 0; `tsc` prints nothing after pnpm's two lines naming the script.

Run:

```bash
pnpm typecheck
pnpm test
```

Expected: no type errors, and every test of the workspace passes.

The page itself is checked in a browser, against a gateway whose demo is on, in Task 9 Step 8.

- [ ] **Step 6: Commit**

```bash
git add apps/web/totals.js apps/web/app.js apps/web/index.html apps/web/style.css apps/web/test/totals.test.ts apps/web/test/page.test.ts
git commit -F - <<'EOF'
add the demo buttons and the demo line to the live page

When /config.json has demo: true, the page shows two buttons that ask the gateway to start a swarm
run, and a demo line apart from the status line. Every refresh then also reads GET /demo. The
buttons are disabled while a run is in progress, at the day's cap, when GET /demo cannot be read,
and while a click's request is on its way. A click removes ?pool= from the URL, so that the page
follows the newest pool, then sends POST /demo/<scenario> with the X-Quorum-Demo header. totals.js
checks GET /demo and the click's answer, builds the request and chooses the demo line, in the order
of precedence the spec gives, the answer to a click first for 10 seconds.
EOF
```

---

### Task 7: The image, the start script and the Fly.io configuration

Four files run the gateway and the live page on one Fly.io machine (spec §7.1–7.4):

- `deploy/fly/Dockerfile`: Node 22.22.2 (CI's version), pnpm through Corepack at the root
  `package.json`'s `packageManager` version (`pnpm@10.23.0`), `pnpm install --prod
  --frozen-lockfile` over the copied workspace, so that workspace packages stay links into the source
  tree, where Node strips their types (it refuses to under `node_modules/`, so not `pnpm deploy`).
  It runs as root and has no Rust toolchain and no wasm.
- `.dockerignore` at the root: `.git`, every `target`, `node_modules`, `.env` and `.env.*` file and
  `data` folder, and, as a further guard, every `.near-credentials` folder.
- `deploy/fly/start.sh`: empties and recreates `/run/quorum` (mode `0700`), runs `swarm keys
  from-seed --gateway-env /run/quorum/gateway.env` and exits with its code if it fails, then `exec`s
  the gateway with that env file and without `QUORUM_SEED_PHRASE` and `QUORUM_SEED_PHRASE_FILE`.
  The gateway needs no particular working folder: with `QUORUM_WEB_DIR` and `QUORUM_DATA_DIR`
  absolute, `main.ts` resolves the web folder against the working folder and joins the data folder,
  both of which then give the absolute paths; the gateway's own folder (`GATEWAY_DIR` in
  `config.ts`) and the swarm's `.env` and default spend file come from `import.meta.url`. So the
  script runs from `/app`, the image's `WORKDIR`, and a demo run inherits `/app` as its working
  folder.
- `deploy/fly/fly.toml`: the app `quorum-on-near-demo` in region `lhr` (Task 9 Step 9 may change
  both, in one step that says so), the `[env]` of spec §7.3, a volume at `/data`, an HTTP service
  on the gateway's port 8402 with HTTPS forced, no automatic stop, one machine running, a health
  check on `GET /config.json`, a `kill_timeout`, the restart policy and one `shared-cpu-1x` VM of
  512 MB. `QUORUM_PARENT_ACCOUNT` holds the example name `quorum-hosted-7316.testnet`, the name
  Task 9 uses throughout; Task 9 Step 9 writes the real parent in its place before the first deploy
  and commits it (account names are public).

**Checked against Fly.io's documentation** (the configuration reference at
`https://docs.fly.io/reference/configuration`, and flyctl's `deploy`, `apps create`,
`volumes create` and `secrets import` reference pages), each key of `fly.toml` below:

| Key | What the documentation says |
|---|---|
| `app`, `primary_region` | The app's name; where `fly deploy` creates new machines |
| `kill_signal` | One of `SIGTERM`, `SIGQUIT`, `SIGUSR1`, `SIGUSR2`, `SIGKILL`, `SIGSTOP`; it replaces Fly.io's default signal |
| `kill_timeout` | Seconds Fly.io waits after `kill_signal` before a forced shutdown; default 5, at most 300 |
| `[build] dockerfile` | A relative path to a Dockerfile; it does not change the build context, which is the working directory. The page does not say what a relative path is resolved against; flyctl resolves it against the configuration file's folder, and Task 9 also passes `--dockerfile deploy/fly/Dockerfile` from the repository's root, so both readings name the same file |
| `[deploy] strategy` | `rolling` (the default, with or without volumes), `immediate`, `canary` or `bluegreen` |
| `[env]` | Non-secret environment variables; values are strings only; secrets take precedence over env variables with the same name |
| `[[mounts]] source`, `destination` | The volume's name, and the folder it is mounted at |
| `[http_service] internal_port`, `force_https`, `auto_stop_machines`, `auto_start_machines`, `min_machines_running` | The port the app listens on (default 8080); HTTP to HTTPS redirects; `"off"`, `"stop"` or `"suspend"` (`"off"`: the proxy never stops machines); start machines on request (default `true`); machines kept running when `auto_stop_machines` is `"stop"` or `"suspend"` |
| `[[http_service.checks]] grace_period`, `interval`, `method`, `timeout`, `path` | A check expects a 2xx answer, runs against the machine over the private network, and follows no redirect |
| `[[restart]] policy`, `retries` | `always`, `never` or `on-failure` (the default: restart only after a non-zero exit); how many restarts before giving up |
| `[[vm]] size`, `memory`, `persist_rootfs` | A preset such as `shared-cpu-1x`; memory with units such as `512mb`; `never` (the default: the root file system is not kept across restarts or updates), `restart` or `always` |

`persist_rootfs = "never"` is written out, since the start script relies on the root disk being
reset at each boot (spec §7.2). `auto_start_machines` stays `true`, so that a request starts the
machine again if repeated boot failures left it stopped. `min_machines_running` only applies when
`auto_stop_machines` is `"stop"` or `"suspend"`; it is written as `1` to state the intent. `rolling`
updates the one machine in place, so two gateways never sign with the same relayer keys (`canary`
and `bluegreen` start a second machine). `kill_timeout = 300`, the most Fly.io allows: the gateway
answers its running requests before it exits, and a relay whose result is unknown is looked up for
up to twice `QUORUM_MAX_TIMEOUT_SECONDS` (240 seconds at the default). `kill_signal = "SIGTERM"`: the
gateway stops on SIGINT or SIGTERM alike and passes SIGTERM to a demo run (spec §4.3).

**Files:**
- Create: `.dockerignore`
- Create: `deploy/fly/Dockerfile`
- Create: `deploy/fly/start.sh`
- Create: `deploy/fly/fly.toml`

**Interfaces:**
- Consumes: `swarm keys from-seed --gateway-env <path>` (Task 3), run as
  `node /app/apps/swarm/src/main.ts keys from-seed --gateway-env /run/quorum/gateway.env`: it reads
  the phrase from `QUORUM_SEED_PHRASE` or `QUORUM_SEED_PHRASE_FILE`, writes the key files under
  `QUORUM_CREDENTIALS_DIR`, writes the env file holding `QUORUM_RELAYER_KEYS` and
  `QUORUM_CREDENTIAL_JWK`, and exits 1 on any refusal, before writing anything. The gateway
  (`apps/gateway/src/main.ts`): its port `QUORUM_GATEWAY_PORT` (default 8402), `QUORUM_WEB_DIR`,
  `QUORUM_DATA_DIR` (the activity feed `activity.jsonl` is created there, folder included), the
  three `QUORUM_DEMO_*` settings (Tasks 4 and 5), `GET /config.json`, and its stop on SIGINT or
  SIGTERM. The swarm's `demo` command (`apps/swarm/src/main.ts`), which reads `QUORUM_*` from its
  environment.
- Produces: an image whose repository is at `/app` and whose command is
  `/bin/sh /app/deploy/fly/start.sh`; `fly.toml` with `app = "quorum-on-near-demo"`,
  `primary_region = "lhr"`, the volume `quorum_data` at `/data`, `internal_port = 8402`, and
  `QUORUM_PARENT_ACCOUNT = "quorum-hosted-7316.testnet"`. Task 9 builds, rehearses and deploys them.

- [ ] **Step 1: Keep the build context clean**

Create `.dockerignore` at the repository's root:

```text
# Kept out of the image that deploy/fly/Dockerfile builds; the build context is the repository's
# root. No key file belongs in the repository folder; .near-credentials is listed in case one is
# made there by mistake.
.git
**/target
**/node_modules
**/.env
**/.env.*
**/data
**/.near-credentials
```

`**/` matches at the root too, so `node_modules`, `target` and `data` are left out at every depth.
No tracked file is under a folder named `data` or `target`, and the `.env.example` files are not
needed in the image.

- [ ] **Step 2: Write the Dockerfile**

Create `deploy/fly/Dockerfile`:

```dockerfile
# The hosted gateway and live page (see fly.toml next to this file). Build it from the repository's
# root, which is the build context:
#   docker build -f deploy/fly/Dockerfile -t quorum-hosted .
# Node runs the workspace's TypeScript sources directly (type stripping): there is no build step.
FROM node:22.22.2-slim

# pnpm at the version that "packageManager" in the root package.json names, through Corepack.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable pnpm

WORKDIR /app

# The workspace's sources. .dockerignore keeps out .git, target, every node_modules, every .env file
# and data.
COPY . .

# Production dependencies only. Workspace packages stay links into the source tree, so Node strips
# their types where they are: it refuses to under node_modules/, which rules out pnpm deploy. No Rust
# toolchain and no wasm: the pools contract is deployed when the deployment is bootstrapped.
RUN pnpm install --prod --frozen-lockfile

# Runs as root, inside the machine's own VM, so that /run/quorum and the volume are writable without
# changing their owner. The start script derives the keys, then replaces itself with the gateway.
CMD ["/bin/sh", "/app/deploy/fly/start.sh"]
```

The official `node` image keeps its `docker-entrypoint.sh`, which runs a command whose first word is
an executable as it is: `/bin/sh` here, or `node` in Step 5's checks. Naming `/bin/sh` in `CMD` means
the script needs no executable bit.

- [ ] **Step 3: Write the start script**

Create `deploy/fly/start.sh`:

```sh
#!/bin/sh
# Starts the hosted gateway at each boot (the command of deploy/fly/Dockerfile). It derives every key
# file and the gateway's two secrets from the seed phrase into /run/quorum, on the machine's
# ephemeral disk, never on the volume, then replaces itself with the gateway, started without the
# phrase in its environment. QUORUM_CREDENTIALS_DIR and every other setting come from fly.toml.
set -eu
umask 077

RUN_DIR=/run/quorum

# Start clean. Fly.io resets the root disk at each boot; a local container keeps it across restarts.
rm -rf "$RUN_DIR"
mkdir -m 0700 "$RUN_DIR"

# Writes the key files under QUORUM_CREDENTIALS_DIR and the gateway's env file, once the derived keys
# have been checked against the chain. If it fails, exit with its code.
node /app/apps/swarm/src/main.ts keys from-seed --gateway-env "$RUN_DIR/gateway.env" || exit $?

# The gateway becomes the process the host supervises. Node reads its relayer keys and credential key
# from the env file; the phrase is removed from its environment, and so from every demo run's.
exec env -u QUORUM_SEED_PHRASE -u QUORUM_SEED_PHRASE_FILE \
  node --env-file="$RUN_DIR/gateway.env" /app/apps/gateway/src/main.ts
```

What this relies on: Node's `--env-file` never overrides a variable already in the environment, so
the file only adds `QUORUM_RELAYER_KEYS` and `QUORUM_CREDENTIAL_JWK`; `env -u` is GNU coreutils' (the
image is Debian); `cmd || exit $?` exits with `cmd`'s status, and `set -e` does not act on a command
in an `||` list.

- [ ] **Step 4: Write the Fly.io configuration**

Create `deploy/fly/fly.toml`:

```toml
# The hosted gateway and live page on Fly.io: one machine, on NEAR testnet. From the repository's
# root:
#   fly deploy --config deploy/fly/fly.toml --dockerfile deploy/fly/Dockerfile --ha=false
# The one secret, QUORUM_SEED_PHRASE, is set with `fly secrets import`, never in this file.

app = "quorum-on-near-demo"
primary_region = "lhr"
# The gateway stops on SIGINT or SIGTERM: it answers the requests it is running, then exits, and
# passes SIGTERM to a demo run.
kill_signal = "SIGTERM"
# The most Fly.io allows: a relay whose result is unknown is looked up for up to twice
# QUORUM_MAX_TIMEOUT_SECONDS (240 seconds at the default) before its request is answered.
kill_timeout = 300

[build]
  # Relative to this file's folder.
  dockerfile = "Dockerfile"

[deploy]
  # Updates the one machine in place, so that two gateways never sign with the same relayer keys.
  strategy = "rolling"

[env]
  QUORUM_NETWORK = "near:testnet"
  # A public RPC that allows browser requests: /config.json gives it to the live page.
  QUORUM_RPC_URL = "https://test.rpc.fastnear.com"
  # The deployment's public URL: the credential issuer, the recipient that redemption proofs name, and
  # where a demo run's buyers reach the gateway. Its host follows the app name.
  QUORUM_GATEWAY_URL = "https://quorum-on-near-demo.fly.dev"
  # The gateway's port; [http_service] internal_port is the same.
  QUORUM_GATEWAY_PORT = "8402"
  # The deployment's own parent account, used for nothing else.
  QUORUM_PARENT_ACCOUNT = "quorum-hosted-7316.testnet"
  # Written by start.sh at each boot, on the machine's ephemeral disk.
  QUORUM_CREDENTIALS_DIR = "/run/quorum/credentials"
  # The activity feed, on the volume.
  QUORUM_DATA_DIR = "/data/gateway"
  QUORUM_WEB_DIR = "/app/apps/web"
  # The demo endpoint: one run of the swarm's demo command at a time.
  QUORUM_DEMO_COMMAND = '["node","/app/apps/swarm/src/main.ts","demo"]'
  QUORUM_DEMO_MAX_RUNS_PER_DAY = "100"
  QUORUM_DEMO_MAX_RUN_SECONDS = "1800"

[[mounts]]
  source = "quorum_data"
  destination = "/data"

[http_service]
  internal_port = 8402
  force_https = true
  # The keeper and the demo runs must keep going: the machine is never stopped for being idle. One
  # machine only, since the volume attaches to one.
  auto_stop_machines = "off"
  auto_start_machines = true
  min_machines_running = 1

  [[http_service.checks]]
    grace_period = "30s"
    interval = "15s"
    method = "GET"
    timeout = "5s"
    path = "/config.json"

# A boot that fails (for example while the RPC is down) is retried.
[[restart]]
  policy = "on-failure"
  retries = 10

[[vm]]
  size = "shared-cpu-1x"
  memory = "512mb"
  # The root disk, and so /run/quorum, is reset at each boot.
  persist_rootfs = "never"
```

- [ ] **Step 5: Check the script, the image and a boot with no phrase**

This step needs Docker (Docker Desktop, or Docker Engine on Linux) and no network beyond the image
build. On Windows, run it in Git Bash.

```bash
sh -n deploy/fly/start.sh && echo "start.sh: syntax ok"
docker build -f deploy/fly/Dockerfile -t quorum-hosted .
```

Expected: `start.sh: syntax ok`; the build pulls `node:22.22.2-slim`, enables pnpm, copies the
workspace and installs the production dependencies with the lockfile unchanged, and ends by naming
the image `quorum-hosted`.

```bash
docker run --rm --network none quorum-hosted node /app/apps/swarm/src/main.ts help
echo "exit $?"
```

Expected: the swarm's usage text, starting `usage: swarm <command>` and listing `keys from-seed`,
then `exit 0`. This shows Node 22.22.2 stripping the types of the sources at `/app` and resolving the
workspace links (`@quorum-on-near/buyer`, `@quorum-on-near/protocol`) and the production
dependencies.

```bash
docker run --rm --network none quorum-hosted sh -c 'ls -A /app; find /app -name ".env*" -not -path "*/node_modules/*"; for p in .git target data; do test -e "/app/$p" && echo "present: $p"; done; echo checked'
```

Expected: the repository's top level (`apps`, `deploy`, `node_modules`, `package.json`, `packages`,
`pnpm-lock.yaml` and the other tracked files), no line from `find`, no `present:` line, then
`checked`.

```bash
docker run --rm --network none -e QUORUM_PARENT_ACCOUNT=quorum-hosted-7316.testnet -e QUORUM_CREDENTIALS_DIR=/run/quorum/credentials quorum-hosted
echo "exit $?"
```

Expected: `swarm keys from-seed`'s refusal of a missing phrase (its message, from Task 3, names
`QUORUM_SEED_PHRASE` and `QUORUM_SEED_PHRASE_FILE`), no `gateway listening` line, and `exit 1`: the
script stopped before the gateway, with the command's code. No network is needed, because the phrase
is read before the chain. The full boot, the restart and the demo runs are rehearsed in Task 9 Step 8.

- [ ] **Step 6: Commit**

```bash
git add .dockerignore deploy/fly/Dockerfile deploy/fly/start.sh deploy/fly/fly.toml
git commit -F - <<'EOF'
add the hosted deployment's image, start script and Fly.io configuration

The image runs the workspace's TypeScript sources with Node 22.22.2, its production dependencies
installed by pnpm with workspace packages left as links into the source tree. At each boot the start
script derives the key files and the gateway's env file from the seed phrase into /run/quorum, then
replaces itself with the gateway, started without the phrase in its environment. fly.toml runs one
machine with the activity feed on a volume, HTTPS forced, no automatic stop, a health check on
/config.json and the demo endpoint on.
EOF
```

---

### Task 8: The design spec, the `.env.example` files and `CLAUDE.md`

The hosted demo spec §11 lists what the design spec gains. This task makes those edits, and the
example settings and `CLAUDE.md` changes that go with them. The edits are written against the
design spec and `CLAUDE.md` as the swarm and MCP server plan and the live page plan leave them once
both are merged (their spec edits: the swarm plan's Task 1 Step 8 and Task 18 Step 2, the live page
plan's Task 1 Step 9; their `CLAUDE.md` edits: the swarm plan's Task 18 Step 3 and the live page
plan's Task 3 Step 6). A table row is one line in the file; a passage of prose may wrap differently
in the file than here, so match its words, not its line breaks. Each block below is indented to sit
in its numbered list; write it without that indentation. Where an anchor below is not found because
a plan's edit landed in other words, put the new text at the same place by meaning. The hosted demo
spec itself is not edited here.

**Files:**
- Modify: `docs/specs/2026-11-09-quorum-on-near-design.md` (sections 2, 6.1, 7.1, 7.6, 8, 9, 10, 12)
- Modify: `apps/gateway/.env.example` (the `QUORUM_WEB_DIR` comment only)
- Modify: `apps/swarm/.env.example` (the RPC comment, a section on the phrase variables)
- Modify: `CLAUDE.md` (Layout, Toolchain)

**Interfaces:**
- Consumes: the names this plan builds: `swarm keys from-seed [--gateway-env <path> | --parent-key]`
  (Task 3), `QUORUM_SEED_PHRASE`, `QUORUM_SEED_PHRASE_FILE`; `QUORUM_DEMO_COMMAND`,
  `QUORUM_DEMO_MAX_RUNS_PER_DAY` (default 100), `QUORUM_DEMO_MAX_RUN_SECONDS` (default 1800), which
  `loadConfig` reads and which Task 4 already added to `apps/gateway/.env.example` (the gateway's
  config tests require the example file to list exactly the variables `loadConfig` reads, with their
  defaults as values); the routes and answers of Task 5; the page of Task 6; the deploy files of
  Task 7.
- Produces: documents and example files only. No variable line is added to either example file, so
  the gateway's and the swarm's example-file tests keep passing.

- [ ] **Step 1: Check the starting point**

```bash
grep -n 'Always measured in block time' docs/specs/2026-11-09-quorum-on-near-design.md
grep -n 'wait until that transfer is final before opening again' docs/specs/2026-11-09-quorum-on-near-design.md
grep -n 'It declares its icon inline' docs/specs/2026-11-09-quorum-on-near-design.md
grep -n '`apps/swarm/`\|`apps/web/`' CLAUDE.md
grep -n 'QUORUM_DEMO_' apps/gateway/.env.example
```

Expected: each `grep` prints at least one line. The first three show the spec as the two plans left
it (sections 9, 12 and 8); the fourth, their Layout rows; the last, the three `QUORUM_DEMO_*` lines
that Task 4 added. This task leaves those lines as Task 4 wrote them.

- [ ] **Step 2: Edit the design spec**

In `docs/specs/2026-11-09-quorum-on-near-design.md`, make each edit below, in order.

1. Section 2, in scope. Replace the item

   ```markdown
   - A read-only live page showing pools filling, settling and refunding.
   ```

   with these two items

   ```markdown
   - A read-only live page showing pools filling, settling and refunding.
   - An opt-in demo endpoint on the gateway, through which the live page can ask the gateway to start
     a run of the swarm (sections 6.1 and 8), and a hosted deployment of the gateway and the live page
     on one public machine, with every key derived from one phrase (section 7.1). Its design is
     [`2026-11-12-hosted-demo-design.md`](2026-11-12-hosted-demo-design.md).
   ```

2. Section 6.1, the endpoints table. Replace the row

   ```markdown
   | `GET /` | The live page (static files from `apps/web`). No file whose path has a segment that starts with a dot, such as `/.env`, is served (`404`) |
   ```

   with

   ```markdown
   | `GET /` | The live page, from `apps/web`: exactly `/` (as `index.html`), `/index.html`, `/app.js`, `/totals.js` and `/style.css`, the path matched after percent-decoding, so `/%61pp.js` serves `app.js` and `/%2Eenv` answers `404`. Every other path answers `404`: the folder is a package, with `node_modules/`, tests and `package.json`, none of which is served |
   ```

3. Section 6.1, the endpoints table. Replace its last row

   ```markdown
   | `GET /config.json` | What the live page needs: the network, the RPC URL (`/rpc` when the pass-through is on), the pools contract, the token, the provider and the explorer's transaction link prefix |
   ```

   with this row and two more

   ```markdown
   | `GET /config.json` | What the live page needs: the network, the RPC URL (`/rpc` when the pass-through is on), the pools contract, the token, the provider and the explorer's transaction link prefix; and `demo`, `true` when the demo endpoint is on and `false` otherwise |
   | `POST /demo/fills`, `POST /demo/fails` | Only when the demo endpoint is on (the demo command, section 7.6); otherwise `404`, as for any unknown route. Starts a run of the swarm's `demo` command for that scenario. The first answer that applies: `403` (`demo_header_required`) without the header `X-Quorum-Demo: 1`; `409` (`demo_running`, with `scenario` and `startedAt`) while a run is in progress; `429` (`demo_limit`) once the day's cap is reached; `409` (`pool_open`, with `poolId`) while a pool of the provider is Open, not counted; `503` (`chain_unavailable`) if the pools cannot be read, not counted; otherwise `202` with `scenario` and `startedAt`. It reads no request body and sends no CORS headers |
   | `GET /demo` | Only when the demo endpoint is on; otherwise `404`. `200` with `running`, `scenario` and `startedAt` (both `null` when no run is in progress), `last` (`{scenario, startedAt, endedAt, exitCode, signal}` of the last finished run, or `null`; `exitCode` and `signal` are both `null` for a program that could not be started), `runsToday` and `maxRunsPerDay`. Times are milliseconds since the epoch |
   ```

4. Section 6.1, after the paragraph that starts `**Which pools the gateway serves.**` and ends
   `It never relays a payment, or issues a credential, for any other pool.`, before `### 6.2 Offer`,
   insert a paragraph (with a blank line before it):

   ```markdown
   **The demo endpoint.** The header is required because a page on another site cannot send it without
   a CORS preflight, which the gateway never answers, so neither such a page nor a form or a beacon can
   start a run. One run at a time: the slot is taken in the same synchronous step that checks it, before
   the pools are read, and the `pool_open` and `503` answers release it. A `202` counts one run of the
   UTC day, in memory, even if the program then cannot be started. The run is the program and arguments
   of the demo command followed by the scenario, started without a shell, in the gateway's working
   folder, with the gateway's environment minus its relayer keys, its credential key and the two seed
   phrase variables; it reads its keys from key files (section 7.1). Each line of its output goes to the
   gateway's own output prefixed `[demo] `, and a last line without a newline is written when the output
   closes. Its exit code, or the signal that ended it, becomes `last`. A run still going after the
   maximum run time gets SIGTERM, then SIGKILL 10 seconds later, and a gateway that stops sends the run
   SIGTERM. The details are in [`2026-11-12-hosted-demo-design.md`](2026-11-12-hosted-demo-design.md),
   section 4.
   ```

5. Section 7.1, after the paragraph on keys, whose last sentence is "Only `swarm setup` signs with
   its key: the gateway, the agents and the MCP server never use it, and `swarm reset` only sends to
   it.", insert a paragraph (with a blank line before it):

   ```markdown
   **Keys from one phrase.** Instead of the random keys setup generates, every key file the swarm reads,
   and the gateway's relayer keys and credential key, can be derived from one BIP-39 phrase of 12 or 24
   words with `swarm keys from-seed`: the BIP-39 seed, then SLIP-10 for ed25519, every level hardened,
   under NEAR's `m/44'/397'`, with the parent at NEAR's standard `m/44'/397'/0'`, so a NEAR wallet or
   near-cli-rs given the phrase derives the same parent key. Each key comes from its account's role,
   never from its name. Every account signed for must be a direct sub-account of `<parent>`, or
   `<parent>` itself for the funding account only. The command checks the derived keys against the
   chain before it writes anything, writes each key file only if it is new, and never writes over one
   that holds another key; setup then creates each missing account with its derived key. A hosted
   deployment holds the phrase as its only secret. The paths and the rules are in
   [`2026-11-12-hosted-demo-design.md`](2026-11-12-hosted-demo-design.md), section 3.
   ```

6. Section 7.6, the configuration table. Replace the row

   ```markdown
   | Live page folder | gateway | The folder served at `/` (section 8). The gateway refuses to start if it is, or contains, the gateway's own folder |
   ```

   with this row and four more

   ```markdown
   | Live page folder | gateway | The folder whose page files are served at `/` (sections 6.1 and 8). The gateway refuses to start if it is, or contains, the gateway's own folder |
   | Seed phrase | swarm | The BIP-39 phrase of 12 or 24 words from which `swarm keys from-seed` derives every key (section 7.1) (secret): in the variable itself, or in a file that a second variable names; exactly one of the two. It is never printed or logged, and neither the gateway nor a demo run receives it |
   | Demo command | gateway | Turns the demo endpoint on (section 6.1): a JSON array of strings, the program to start and its first arguments, to which the gateway appends the scenario. The program must be the run itself (`node` with the swarm's entry file and `demo`), never a shell or a package manager, which would not pass signals on. Unset or empty: the demo is off. A value that is not a non-empty array of non-empty strings: the gateway refuses to start, naming the variable |
   | Demo runs per day | gateway | The runs started per UTC day, counted in memory: 1 to 1,000, default 100 |
   | Demo maximum run time | gateway | The seconds after which a run still going gets SIGTERM, then SIGKILL 10 seconds later: 60 to 7,200, default 1,800 |
   ```

7. Section 8, its first paragraph. Replace the sentences

   ```markdown
   There is no build step, and the gateway serves the folder at `/`. The page never signs anything and
   needs no wallet.
   ```

   with

   ```markdown
   There is no build step, and the gateway serves those four files at `/`, and nothing else of the
   folder (section 6.1). The page never signs anything and needs no wallet; when the gateway's demo
   endpoint is on, it can ask the gateway to start a run (the demo controls, below).
   ```

8. Section 8. Directly before its last item, the one that starts "- `totals.js` is a pure module",
   insert this item:

   ```markdown
   - **The demo controls**, shown only when `/config.json` has `demo: true`: two buttons, "Start a pool
     that fills" and "Start a pool that fails", and a demo line, apart from the status line, which keeps
     showing when the page last refreshed. Every refresh also reads `GET /demo`. The buttons are
     disabled while a run is in progress, when today's cap is reached, when `GET /demo` cannot be read,
     and while a button's own request is on its way. A click first removes `?pool=` from the page's URL,
     so that the page follows the provider's newest pool, then sends the `POST` with the header
     `X-Quorum-Demo: 1`. The demo line shows the first of these that applies:
     1. for 10 seconds after a click's answer arrives, that answer: `202`, "A run started. Its pool
        appears here once it opens."; `409` `demo_running`, "A run is already in progress. This page
        follows its pool once it opens."; `409` `pool_open`, "A pool is still open. This page shows
        it."; `429`, "The demo has reached its limit for today."; any other answer, "The demo is not
        available right now."; no answer, "The gateway could not be reached.";
     2. `GET /demo` cannot be read: "The demo's status is unavailable.";
     3. a run in progress: "A `<scenario>` run started at `<time>` is in progress.";
     4. today's cap reached: "The demo has reached its limit for today.";
     5. the last run exited with code 0: "The last run (`<scenario>`) ended at `<time>`.";
     6. the last run ended any other way: "The last run ended with an error. Its testnet funds may need
        a refill.";
     7. no run yet: "Start a run to watch a pool from its first seat."
   ```

9. Section 8, its last item. Replace

   ```markdown
   - `totals.js` is a pure module that computes the totals from the contract's data. It is the one
     piece of logic on the page, and it is unit-tested.
   ```

   with

   ```markdown
   - `totals.js` is a pure module that computes the totals from the contract's data and chooses the
     demo line. It is the one piece of logic on the page, and it is unit-tested.
   ```

10. Section 9. After the table's last row,

    ```markdown
    | Deadlines | Always measured in block time, never by a server clock |
    ```

    add these rows:

    ```markdown
    | No seed phrase, both phrase variables set, or a phrase that is not 12 or 24 words | `swarm keys from-seed` exits 1 with a message that does not quote the phrase; at boot, the hosted deployment's start script exits |
    | An account outside the parent, or a relayer key count outside 1 to 90, for `swarm keys from-seed` | Exit 1, naming the setting |
    | The phrase does not hold a full-access key of the parent | `swarm keys from-seed` exits 1, and writes nothing |
    | An existing account lacks one of its derived keys | `swarm keys from-seed` exits 1, naming the account and the key, and writes nothing |
    | The RPC cannot be read when the hosted deployment boots | `swarm keys from-seed` exits 1; the machine is restarted under its restart policy |
    | A key file or the gateway env file holds something else | `swarm keys from-seed` exits 1, naming the file; nothing is overwritten |
    | A malformed demo setting | The gateway refuses to start, naming the variable |
    | A demo `POST` without the header `X-Quorum-Demo: 1` | `403` |
    | A pool of the provider still Open when a run is asked for | `409` `pool_open`, not counted |
    | The pools cannot be read before a run | `503`, not counted |
    | The demo program cannot be started | `202` was already sent; `last` has `exitCode` and `signal` both `null`, and the page reports the failed run |
    | A demo run ends with an error (a shortfall, a failed check) | `last.exitCode` is its exit code; the page reports it; its output is in the gateway's logs |
    | A demo run passes its maximum run time | SIGTERM, then SIGKILL after 10 seconds; `last.signal` records it |
    | The gateway stops during a demo run | The run gets SIGTERM; the keeper resolves its pool at the deadline |
    ```

11. Section 10. Replace the row

    ```markdown
    | Live page | `totals.js` unit tests |
    ```

    with these rows

    ```markdown
    | Live page | `totals.js` unit tests, the demo controls included: shown only with `demo: true`; the buttons disabled while a run is in progress, at the day's cap, when `GET /demo` cannot be read and while a click's request is on its way; the click's request with its header, and the page URL without `?pool=`; every demo line in its order of precedence. Static checks of the page's markup and scripts |
    | `swarm keys from-seed` unit tests | The derivation against SLIP-10's published ed25519 vectors, BIP-39's reference seed vector with its passphrase, and the parent key that near-cli-rs derives from the public BIP-39 test phrase (`abandon … about`) at `m/44'/397'/0'` (only the public key is committed); the same keys from a phrase with extra spaces, line breaks or capitals. A phrase of the wrong length, both variables and neither refused, and the phrase absent from every output and message. An account outside the parent and relayer key counts of 0 and 91 refused, a funding account equal to the parent accepted. `--parent-key` printing only the public key, with no RPC request and no file. The chain check against a stubbed RPC: the parent key with full access, as a function-call key only, or missing; the parent account missing; another account or the relayer lacking a derived key; the RPC down; nothing written on any failure. The key files' layout and modes, a second run that changes nothing, a key file with another key refused; the gateway env file read back by the gateway's own configuration loader, left alone when identical, refused when different |
    | Gateway demo endpoint tests (a stub program in place of the swarm, a stub chain reader) | Off means `404` on all three routes; `403` without the header; `202`, then `409` `demo_running` while it runs, including two requests in the same tick; `409` `pool_open` and `503` not counted; `429` over the cap, and a new count after midnight UTC; the precedence of the answers; `GET /demo` before, during and after a run; the child's arguments, working folder and environment without the four secret variables; output lines prefixed, and a last line without a newline written; exit codes and signals recorded, both `null` for a program that cannot be started; the maximum run time; SIGTERM passed on at shutdown; `demo` in `/config.json`; the demo settings' validation |
    | Gateway static files | `/`, `/index.html`, `/app.js`, `/totals.js`, `/style.css` and `/%61pp.js` served; `/package.json`, `/test/…`, `/node_modules/…`, `/.env` and `/%2Eenv` answer `404` |
    | Hosted image and start script | A local rehearsal of the deployment, including a restart of the container ([`2026-11-12-hosted-demo-design.md`](2026-11-12-hosted-demo-design.md), section 7.5) |
    | Hosted deployment | Over HTTPS from another network: the page loads and its explorer links open; `/package.json` and `/node_modules/…` answer `404`; a `fills` run ends Settled and a `fails` run Refunded, with every check of the run passing; a second request during a run gets `409`; a `POST` without the header gets `403`; the logs show the `[demo]` lines |
    ```

12. Section 12. After its last line, which ends
    `wait until that transfer is final before opening again.`, add these items:

    ```markdown
    - **Anyone can start a hosted demo run.** A run spends testnet NEAR (gas, and storage for a new
      pool) and moves testnet USDC between the deployment's own accounts. It is bounded by one run at a
      time, the daily cap and the maximum run time, not by who asks. The `X-Quorum-Demo` header stops
      pages on other sites, not a script that sends the header itself.
    - **The hosted deployment's NEAR runs out before its daily cap does.** Pool and seat storage is
      never freed, so each run costs NEAR for good, and refills come by hand from NEAR's testnet faucet
      ([`2026-11-12-hosted-demo-design.md`](2026-11-12-hosted-demo-design.md), sections 7.6 and 10).
      Its USDC drains by what each `fills` run pays the provider, until `swarm reset` returns it to the
      funding account (section 7.2).
    - **Every pool ever opened is read again and again.** The keeper, `GET /pools` and every visitor's
      page read all of the contract's pools, 100 per RPC call, and `GET /activity` without a pool
      returns the whole feed. With the demo on, up to the daily cap of new pools a day, the public RPC's
      limits apply sooner.
    - **One phrase controls every account** of a deployment whose keys are derived from it (section
      7.1), and the host holds it: whoever reads the host's secrets can move all its testnet funds.
    - **A run started elsewhere with the same accounts** within the same few seconds as a demo run can
      clash with it. Both may sign with the same keys before either opens a pool, so a transaction can
      be rejected for its nonce, a top-up can be sent twice, or two pools can open. No funds are lost:
      every seat still settles or is refunded.
    - **The hosted deployment is one machine.** It is unavailable during a deploy or a host failure,
      and its activity feed is on one volume, kept by the host's daily snapshots. The demo's daily count
      lives in memory and starts again after a restart.
    ```

Then read sections 2, 6.1, 7.1, 7.6, 8, 9, 10 and 12 again as they now stand: each edit is in place
once, and no passage is left half replaced.

- [ ] **Step 3: Edit the gateway's `.env.example`**

Only the `QUORUM_WEB_DIR` comment changes: it stated the dot-segment rule, which Task 1 replaced
with the static-file rule. In `apps/gateway/.env.example`, replace

```text
# Folder of the live page, served at /. Empty serves nothing there. Never this folder or one above it,
# which would publish .env; files and folders whose names start with a dot are never served.
QUORUM_WEB_DIR=../web
```

with

```text
# Folder of the live page. Only its page files are served: / (as index.html), /index.html, /app.js,
# /totals.js and /style.css, matched after percent-decoding; every other path answers 404. Empty
# serves nothing there. Never this folder or one above it. A relative path resolves against the
# folder the gateway runs in.
QUORUM_WEB_DIR=../web
```

The variable line is unchanged, so the gateway's example-file tests are unaffected. The
`QUORUM_DEMO_*` lines stay as Task 4 wrote them.

- [ ] **Step 4: Edit the swarm's `.env.example`**

In `apps/swarm/.env.example`, replace

```text
# NEAR RPC endpoint. Every swarm command but env and help stops unless it serves that chain (testnet,
# or any non-public chain).
```

with

```text
# NEAR RPC endpoint. Every swarm command but env and help stops unless it serves that chain (testnet,
# or any non-public chain); swarm keys from-seed --parent-key reads no chain.
```

Then add at the end of the file, after `QUORUM_REDEEM_INTERVAL_MS=5000`:

```text

# --- Read only by swarm keys from-seed. ---

# The BIP-39 phrase (12 or 24 words) that swarm keys from-seed derives every key from, in one of two
# variables, never both; an empty value counts as unset. QUORUM_SEED_PHRASE_FILE names a file that
# holds it: an absolute path, outside the repository, to a file readable by its owner only.
# QUORUM_SEED_PHRASE holds the phrase itself, as a host passes a secret in the environment. Never put
# the phrase itself in this file or in any committed file; the file's path may be set here or in the
# environment. No other command reads either variable.
```

The two variables are named in the comment, not written as `#QUORUM_SEED_PHRASE=` lines like
`#QUORUM_POOLS_WASM=`. The swarm's config test "ships an example file that lists exactly the variables
loadSwarmConfig reads" collects every line matching `/^#?(QUORUM_[A-Z_]+)=/m`, commented lines
included, and compares them with what `loadSwarmConfig` reads; it reads neither phrase variable
(`apps/swarm/src/keys-from-seed.ts` does), so such lines would fail that test. Naming them only in
the comment also keeps a line from inviting the phrase into this file. No comment line starts with a
variable name. The test "says in its example file that every command but env and help checks the
chain QUORUM_RPC_URL serves" still finds its sentence, which the first edit only extends.

- [ ] **Step 5: Edit `CLAUDE.md`**

1. In `## Layout`, after the `apps/web/` row, the table's last row,

   ```markdown
   | `apps/web/` | The live page: a static page with no build step, served by the gateway at `/`, that shows one of the provider's pools, its ledger and its buyers as the chain holds them |
   ```

   add the row

   ```markdown
   | `deploy/fly/` | The hosted deployment on Fly.io: the image (`Dockerfile`), the start script that derives every key from the seed phrase and starts the gateway, and `fly.toml`; its `.dockerignore` is at the repository's root |
   ```

2. In `## Toolchain`, after the live page's paragraph, which ends

   ```markdown
   Its tests run with `pnpm --filter @quorum-on-near/web test`, and in `pnpm test`.
   ```

   add a paragraph (with a blank line before it):

   ```markdown
   The hosted deployment (`deploy/fly/`, specified in `docs/specs/2026-11-12-hosted-demo-design.md`)
   builds from the repository's root with `docker build -f deploy/fly/Dockerfile .` and deploys with
   `fly deploy --config deploy/fly/fly.toml --dockerfile deploy/fly/Dockerfile --ha=false`, also from
   the root. Its one secret is the BIP-39 phrase `QUORUM_SEED_PHRASE`, set with `fly secrets import`;
   at each boot, `swarm keys from-seed` derives every key file and the gateway's two secrets from it
   into `/run/quorum`. The gateway's demo endpoint is on only when `QUORUM_DEMO_COMMAND` is set. CI does
   not build the image.
   ```

- [ ] **Step 6: Run the example-file tests and everything else**

```bash
pnpm --filter @quorum-on-near/gateway exec vitest run test/config.test.ts
pnpm --filter @quorum-on-near/swarm exec vitest run test/config.test.ts
pnpm typecheck
pnpm test
git diff --stat
```

Expected: both config suites pass, including their example-file tests; no type errors; every test
passes; `git diff --stat` lists exactly `CLAUDE.md`, `apps/gateway/.env.example`,
`apps/swarm/.env.example` and `docs/specs/2026-11-09-quorum-on-near-design.md`.

- [ ] **Step 7: Commit**

```bash
git add docs/specs/2026-11-09-quorum-on-near-design.md apps/gateway/.env.example apps/swarm/.env.example CLAUDE.md
git commit -F - <<'EOF'
record the demo endpoint, the keys from one phrase and the hosted deployment

The design spec now lists the demo routes and the static-file rule among the gateway's endpoints,
says how keys can be derived from one phrase, adds the seed phrase and the demo settings to the
configuration, describes the page's demo buttons and line, and adds the new error cases, tests and
limits. The gateway's example settings state the static-file rule for the live page folder; the
swarm's describe the phrase variables. CLAUDE.md lists deploy/fly/ and how to build and deploy it.
EOF
```

---

### Task 9: Bootstrap, rehearse, deploy and check, by hand

No code: this task runs the bootstrap of spec §7.5 on NEAR testnet against Circle's testnet USDC,
rehearses the image locally, deploys it to Fly.io and checks it as the last row of spec §9 says. It
commits two things: the parent account in `deploy/fly/fly.toml` (Step 9) and the NEAR one run costs
in the hosted demo spec (Step 11).

**Gate:** Tasks 0 to 8 committed on `feat/hosted-demo`, on Linux, macOS on Apple silicon or WSL2 (in
WSL2, with the repository cloned under `~`, not under `/mnt/c`, where file modes are not kept).
Needed: Rust with the toolchain of `rust-toolchain.toml` and cargo-near 0.23.0, near-cli-rs, Docker,
flyctl and a Fly.io account. Run every block in `bash`, from the repository's root, in one shell that
stays open from Step 2 to the end (a new shell needs Step 2's `export` lines again).

**No secret on any command line.** The phrase is only ever read from its file: by `swarm keys
from-seed` through `QUORUM_SEED_PHRASE_FILE`, and by the `printf` lines of Steps 8 and 9, where `tr`
and `sed` receive it on standard input and the shell's builtin `printf` writes it out. Never paste the
phrase into a command, and never pass it with `docker run -e`.

The parent account's name is yours to choose. This task writes it as `quorum-hosted-7316.testnet`,
the name `deploy/fly/fly.toml` holds: replace it in Step 2 with yours, and the other accounts follow
from it (for example `funding.quorum-hosted-7316.testnet`). The token is Circle's testnet USDC,
`3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af` (6 decimals, symbol `USDC`).

**Files:**
- Modify: `deploy/fly/fly.toml` (`QUORUM_PARENT_ACCOUNT`; `app`, `primary_region` and the host of
  `QUORUM_GATEWAY_URL` only if Step 9 changes the app name or region)
- Modify: `docs/specs/2026-11-12-hosted-demo-design.md` (section 10, the NEAR one run costs)

Every other file this task writes is outside the repository, under `~/quorum-hosted/`: the phrase
file, the credentials folder, the spend file and the rehearsal's env file.

**Interfaces:**
- Consumes: `swarm keys from-seed` and `--parent-key` (Task 3), `swarm setup` (the swarm and MCP
  server plan), the demo endpoint (Tasks 4 and 5), the page's buttons (Task 6), the image, start
  script and `fly.toml` (Task 7).
- Produces: the deployment at `https://quorum-on-near-demo.fly.dev` (or the app name Step 9 chose),
  the committed parent account, and the measured NEAR per run in the hosted demo spec.

- [ ] **Step 1: Install the tools and build the pools contract**

```bash
near --version
docker --version
curl -L https://fly.io/install.sh | sh
fly version
fly auth login
```

Expected: a version line from each tool (near-cli-rs installs as the swarm and MCP server plan's
Task 0 Step 6 says; Docker is Docker Desktop with WSL integration, or Docker Engine on Linux); the
flyctl installer prints the folder to add to `PATH`; `fly auth login` opens a browser to sign in and
ends with `successfully logged in as …`.

Build the pools contract's wasm as CI builds it, for setup to deploy:

```bash
cargo near build non-reproducible-wasm --no-abi --no-embed-abi --manifest-path contracts/pools/Cargo.toml
ls -l target/near/quorum_pools/quorum_pools.wasm
```

Expected: `ls` lists the file.

- [ ] **Step 2: Choose the names and set up the shell**

```bash
export PARENT=quorum-hosted-7316.testnet
export APP=quorum-on-near-demo
export REGION=lhr
export USDC=3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af
export QUORUM_SEED_PHRASE_FILE="$HOME/quorum-hosted/seed-phrase.txt"
export QUORUM_PARENT_ACCOUNT="$PARENT"
export QUORUM_CREDENTIALS_DIR="$HOME/quorum-hosted/credentials"
export QUORUM_MCP_SPEND_FILE="$HOME/quorum-hosted/mcp-spend.json"
export QUORUM_POOLS_WASM="$PWD/target/near/quorum_pools/quorum_pools.wasm"
balances() {
  near tokens "$PARENT" view-near-balance network-config testnet now
  near tokens "relay.$PARENT" view-near-balance network-config testnet now
  near tokens "pools.$PARENT" view-near-balance network-config testnet now
  near tokens "funding.$PARENT" view-ft-balance "$USDC" network-config testnet now
}
```

Replace `quorum-hosted-7316.testnet` with your parent's name before running the block. Keep `APP`
and `REGION` as they are unless Step 9 tells you to change them. The credentials folder and the
spend file are under `~/quorum-hosted`, outside the repository, so no key can enter an image build
and earlier runs' files stay as they are.

Variables set in the environment win over `apps/swarm/.env`, but any other value in that file still
applies. If `apps/swarm/.env` exists, set it aside for this task (git ignores both names):

```bash
test -e apps/swarm/.env && mv apps/swarm/.env apps/swarm/.env.saved
```

- [ ] **Step 3: Generate the phrase** (spec §7.5, step 1)

near-cli-rs generates a 12-word BIP-39 phrase locally and offline, with its key at NEAR's standard
path `m/44'/397'/0'`, into a JSON file:

```bash
mkdir -p ~/quorum-hosted
chmod 700 ~/quorum-hosted
near account create-account fund-later use-auto-generation save-to-folder ~/quorum-hosted/generated
```

Expected: `The file "…/quorum-hosted/generated/<64 hex characters>.json" was saved successfully`. It
creates nothing on chain. Move the phrase into the phrase file (mode `0600`) and the public key into
a file of its own, without printing the phrase:

```bash
(umask 077 && node -e '
  const { readFileSync, readdirSync, writeFileSync } = require("node:fs");
  const [dir, home] = process.argv.slice(1);
  const files = readdirSync(dir);
  if (files.length !== 1) throw new Error(`expected one file in ${dir}, found ${files.length}`);
  const generated = JSON.parse(readFileSync(`${dir}/${files[0]}`, "utf8"));
  if (generated.seed_phrase_hd_path !== "m/44\x27/397\x27/0\x27") throw new Error("unexpected derivation path");
  writeFileSync(`${home}/seed-phrase.txt`, `${generated.master_seed_phrase}\n`, { flag: "wx", mode: 0o600 });
  writeFileSync(`${home}/parent-public-key.txt`, `${generated.public_key}\n`, { flag: "wx" });
  console.log(`wrote ${home}/seed-phrase.txt; parent public key ${generated.public_key}`);
' ~/quorum-hosted/generated ~/quorum-hosted)
ls -l ~/quorum-hosted/seed-phrase.txt
```

Expected: `wrote …/seed-phrase.txt; parent public key ed25519:…`, and `ls` shows `-rw-------`.
Copy the phrase from `seed-phrase.txt` into your password manager (open the file in an editor; do not
paste the phrase into a shell). Then delete the generated file, which also holds the private key:

```bash
rm -r ~/quorum-hosted/generated
```

Use this phrase on testnet only: its parent path is the wallet standard, so it must never hold
mainnet funds.

- [ ] **Step 4: Create the parent with the phrase's key** (spec §7.5, step 2)

```bash
PARENT_KEY="$(node apps/swarm/src/main.ts keys from-seed --parent-key)"
echo "$PARENT_KEY"
test "$PARENT_KEY" = "$(cat ~/quorum-hosted/parent-public-key.txt)" && echo "near-cli-rs derives the same parent key"
```

Expected: the parent's public key, `ed25519:` and base58, the one line `--parent-key` prints, then
`near-cli-rs derives the same parent key`. `--parent-key` reads only the phrase: no chain, no
configuration, no file. If the two keys differ, stop: the swarm's
derivation does not match NEAR's standard path, and an account created now would not be the one the
phrase's wallet holds.

```bash
near account create-account sponsor-by-faucet-service "$PARENT" use-manually-provided-public-key "$PARENT_KEY" network-config testnet create
near account list-keys "$PARENT" network-config testnet now
```

Expected: the faucet service creates the account and funds it with 10 NEAR (a name already taken is
refused: choose another and go back to Step 2); `list-keys` shows one full-access key, `$PARENT_KEY`.

- [ ] **Step 5: Write the keys and run the first setup** (spec §7.5, step 3)

```bash
pnpm --filter @quorum-on-near/swarm swarm keys from-seed
find "$QUORUM_CREDENTIALS_DIR" -type f | sort
pnpm --filter @quorum-on-near/swarm swarm setup
echo "exit $?"
```

Expected: `keys from-seed` checks the RPC's chain id and the parent's full-access key, skips the
accounts that do not exist yet, and prints one line per key, `<account>  <public key>` (two spaces):
the parent, `funding.`, `pools.`, `relay.` (4 lines), `provider.`, `buyer-01.` to `buyer-20.` and
`buyer-llm.` under `$PARENT`. No private key and no word of the phrase is printed. `find` lists `testnet/<account>.json` for each of those accounts and 4 files under
`testnet/relay.$PARENT/`.

Setup then creates the 25 accounts under the parent with the keys in those files (it reuses a key
file left for an account it has not created yet), deploys the pools contract
(`deployed the pools contract  pools.quorum-hosted-7316.testnet  token 3e2210e1…  tx …`), registers
the accounts on the token, and stops, on standard error:

```text
the funding account funding.quorum-hosted-7316.testnet holds 0 base units of the token 3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af, but the top-ups need 220000: send it 220000 more, then run setup again
```

and `exit 1`, with your parent's name in place of `quorum-hosted-7316.testnet`.

- [ ] **Step 6: Fund the funding account with USDC** (spec §7.5, step 4)

Open Circle's testnet faucet, https://faucet.circle.com, choose USDC and the network NEAR Testnet,
enter `funding.` followed by your parent's name as the address, pass the check and send. Then:

```bash
near tokens "funding.$PARENT" view-ft-balance "$USDC" network-config testnet now
```

Expected: 20 USDC, once the faucet's transfer has landed.

- [ ] **Step 7: Run setup again** (spec §7.5, step 5)

```bash
pnpm --filter @quorum-on-near/swarm swarm setup
pnpm --filter @quorum-on-near/swarm swarm setup
touch ~/quorum-hosted/marker
pnpm --filter @quorum-on-near/swarm swarm keys from-seed
find "$QUORUM_CREDENTIALS_DIR" -newer ~/quorum-hosted/marker
near tokens "$PARENT" view-near-balance network-config testnet now
```

Expected: the first setup sends the token top-ups from the funding account (`sent tokens …` lines)
and exits 0; the second prints `nothing to do`. `keys from-seed` now finds every account holding its
derived keys and prints the same lines as in Step 5; `find` prints nothing, since no file changed
(this is the check the start script runs at every boot). The parent then holds little more than
1 NEAR.

- [ ] **Step 8: Rehearse locally** (spec §7.5, step 6)

Stop any gateway running on port 8402 first. Build the image and write the rehearsal's env file
outside the repository: the phrase first, from its file, then the same settings as `fly.toml`'s
`[env]`, with the gateway reached at `http://localhost:8402`:

```bash
docker build -f deploy/fly/Dockerfile -t quorum-hosted .
(umask 077 && printf 'QUORUM_SEED_PHRASE=%s\n' "$(tr -s '[:space:]' ' ' < "$QUORUM_SEED_PHRASE_FILE" | sed 's/^ //;s/ $//')" > ~/quorum-hosted/rehearsal.env)
cat >> ~/quorum-hosted/rehearsal.env <<EOF
QUORUM_NETWORK=near:testnet
QUORUM_RPC_URL=https://test.rpc.fastnear.com
QUORUM_GATEWAY_URL=http://localhost:8402
QUORUM_GATEWAY_PORT=8402
QUORUM_PARENT_ACCOUNT=$PARENT
QUORUM_CREDENTIALS_DIR=/run/quorum/credentials
QUORUM_DATA_DIR=/data/gateway
QUORUM_WEB_DIR=/app/apps/web
QUORUM_DEMO_COMMAND=["node","/app/apps/swarm/src/main.ts","demo"]
QUORUM_DEMO_MAX_RUNS_PER_DAY=100
QUORUM_DEMO_MAX_RUN_SECONDS=1800
EOF
ls -l ~/quorum-hosted/rehearsal.env
```

Expected: the image builds; `ls` shows `-rw-------`. Docker reads an env file's lines as
`NAME=value`, the value taken as written, without quotes.

Start the container and follow its boot:

```bash
docker run -d --name quorum-rehearsal --env-file ~/quorum-hosted/rehearsal.env -v quorum-rehearsal:/data -p 8402:8402 quorum-hosted
docker logs -f quorum-rehearsal
```

Expected: the lines of `keys from-seed` (as in Step 5, and `credential  <public key>` for the
gateway's credential key, which `--gateway-env` adds), then
`gateway listening on http://localhost:8402 (public URL http://localhost:8402)`. Stop following the
log with Ctrl+C; the container keeps running.

```bash
curl -sS http://localhost:8402/config.json; echo
curl -sS http://localhost:8402/demo; echo
curl -sS -o /dev/null -w '%{http_code}\n' http://localhost:8402/package.json
curl -sS -X POST -w '\n%{http_code}\n' http://localhost:8402/demo/fills
balances
```

Expected: `/config.json` names `pools.`, `provider.` under your parent, the RPC
`https://test.rpc.fastnear.com`, and `"demo":true`; `/demo` answers
`{"running":false,"scenario":null,"startedAt":null,"last":null,"runsToday":0,"maxRunsPerDay":100}`;
`/package.json` answers `404`; the `POST` without the header answers
`{"error":"demo_header_required"}` and `403`, starting nothing. Write down, from `balances`, the NEAR
each of the parent, `relay.` and `pools.` has available for transfer (near-cli-rs prints it with the
total balance and the part locked for storage) and the funding account's USDC.

Open `http://localhost:8402/` in a browser (from Windows with WSL2, use `localhost`, not
`127.0.0.1`). Expected: the banner, the provider's newest pool (or "The provider has not opened a
pool yet."), the two buttons, enabled, and the demo line "Start a run to watch a pool from its first
seat." Click **Start a pool that fills**. Expected: the URL loses any `?pool=`; the buttons are
disabled; the demo line reads "A run started. Its pool appears here once it opens." for 10 seconds,
then "A fills run started at <time> is in progress."; the new pool appears once setup has run and it
opens, and fills over about two minutes. While it runs:

```bash
curl -sS -X POST -H 'X-Quorum-Demo: 1' -w '\n%{http_code}\n' http://localhost:8402/demo/fails
docker logs quorum-rehearsal 2>&1 | grep -c '^\[demo\] '
```

Expected: `{"error":"demo_running","scenario":"fills","startedAt":…}` and `409`; a count above 0.
When the run ends, the pool shows "Settled: the seller is paid", the demo line reads "The last run
(fills) ended at <time>.", and the log's last `[demo]` lines end `[demo] pool <id>: 8 checks passed`.
Then:

```bash
curl -sS http://localhost:8402/demo; echo
balances
```

Expected: `"running":false`, `"runsToday":1`, and `last` with `"scenario":"fills"`, `"exitCode":0`
and `"signal":null`. Write down the four figures again.

Click **Start a pool that fails**. Expected as above, with a pool of 192 seats at 320 that six buyers
commit to; once its 3-minute deadline has passed and the keeper has refunded it, the pool shows
"Refunded", the demo line "The last run (fails) ended at <time>.", and the log ends
`[demo] pool <id>: 9 checks passed`. Run `balances` once more and write down the four figures.

For each run, the NEAR it cost is the sum, over the parent, `relay.` and `pools.`, of the NEAR
available for transfer before the run less the NEAR available after it. Write down both sums, to 3
decimals. They leave out the little gas the provider and the buyers burn from their own NEAR, which a
later setup tops up from the parent.

Restart the container, as a host restart would, and check that it comes back with the same
credential key and a new day's count:

```bash
curl -sS http://localhost:8402/.well-known/jwks.json > ~/quorum-hosted/jwks-before.json
docker restart quorum-rehearsal
sleep 20
docker logs --since 30s quorum-rehearsal
curl -sS http://localhost:8402/.well-known/jwks.json | cmp - ~/quorum-hosted/jwks-before.json && echo "same credential key"
curl -sS http://localhost:8402/demo; echo
```

Expected: the log shows `SIGTERM: shutting down`, then the boot again (`keys from-seed`'s lines and
`gateway listening …`): the start script emptied `/run/quorum` and the key files were written again
without a conflict. Then `same credential key`, and `/demo` with `"runsToday":0` and `"last":null`
(both live in memory). The page still lists both pools and their buyers' transaction links: the feed
is on the volume.

Stop the container before deploying: two gateways would sign with the same relayer keys.

```bash
docker stop quorum-rehearsal
docker rm quorum-rehearsal
docker volume rm quorum-rehearsal
rm ~/quorum-hosted/rehearsal.env ~/quorum-hosted/jwks-before.json
docker ps --filter name=quorum-rehearsal --format '{{.Names}}'
```

Expected: the last command prints nothing.

- [ ] **Step 9: Deploy** (spec §7.5, step 7)

Create the app:

```bash
fly apps create "$APP" --org personal
```

Expected: `New app created: quorum-on-near-demo`. If the name is taken, choose another: set `APP` to
it, and in `deploy/fly/fly.toml` write it as `app` and as the host of `QUORUM_GATEWAY_URL`
(`https://<app>.fly.dev`). To run in another region, set `REGION` and `primary_region` to it. Those
are the only changes to these names.

Write your parent's name into `deploy/fly/fly.toml`, the line
`QUORUM_PARENT_ACCOUNT = "quorum-hosted-7316.testnet"` becoming that line with your name, then check
and commit (if you kept the example name and the app's name and region, there is nothing to commit):

```bash
grep -n '^app\|primary_region\|QUORUM_PARENT_ACCOUNT\|QUORUM_GATEWAY_URL' deploy/fly/fly.toml
git add deploy/fly/fly.toml
git commit -m "set the hosted deployment's parent account"
```

Expected: `grep` shows `$APP`, `$REGION`, `$PARENT` and `https://$APP.fly.dev`.

Create the volume, set the secret and deploy:

```bash
fly volumes create quorum_data --app "$APP" --region "$REGION" --size 1 --yes
printf 'QUORUM_SEED_PHRASE=%s\n' "$(tr -s '[:space:]' ' ' < "$QUORUM_SEED_PHRASE_FILE" | sed 's/^ //;s/ $//')" | fly secrets import --app "$APP" --stage
fly secrets list --app "$APP"
fly config validate --config deploy/fly/fly.toml
fly deploy --config deploy/fly/fly.toml --dockerfile deploy/fly/Dockerfile --ha=false
```

Expected: a 1 GB volume `quorum_data` in the region; `fly secrets import` reads the
`NAME=VALUE` line from standard input and stages it; `fly secrets list` shows `QUORUM_SEED_PHRASE`
with a digest, never its value; the configuration is reported valid; the deploy builds the image from
the repository's root (the build context, filtered by `.dockerignore`), creates one machine in the
region with the volume mounted at `/data`, and waits until its health check on `/config.json`
passes. `--ha=false` keeps it to one machine, since the volume attaches to one.

```bash
fly status --app "$APP"
fly ips list --app "$APP"
fly logs --app "$APP" --no-tail
```

Expected: one machine, `started`, its check passing; a shared IPv4 and an IPv6 address (if none is
listed, run `fly ips allocate-v6 --app "$APP"` and `fly ips allocate-v4 --shared --app "$APP"`); the
log shows the lines of `keys from-seed` and
`gateway listening on http://localhost:8402 (public URL https://quorum-on-near-demo.fly.dev)`.

- [ ] **Step 10: Check the deployment** (spec §7.5, step 8, and the last row of spec §9)

From another network than the rehearsal's (for example a laptop on a phone's connection), with
`URL` set to the deployment's public URL:

```bash
URL="https://$APP.fly.dev"
curl -sS -o /dev/null -w '%{http_code}\n' "$URL/"
curl -sS -o /dev/null -w '%{http_code} %{redirect_url}\n' "http://$APP.fly.dev/"
curl -sS "$URL/config.json"; echo
for path in /index.html /app.js /totals.js /style.css /%61pp.js; do curl -sS -o /dev/null -w "%{http_code} $path\n" "$URL$path"; done
for path in /package.json /node_modules/vitest/package.json /test/page.test.ts /.env /%2Eenv; do curl -sS -o /dev/null -w "%{http_code} $path\n" "$URL$path"; done
curl -sS -X POST -w '\n%{http_code}\n' "$URL/demo/fills"
curl -sS "$URL/demo"; echo
```

Expected: `200`; a redirect (`301` or `308`) to the same path over `https://`, since HTTPS is forced
at Fly.io's proxy; `/config.json` with your parent's accounts and `"demo":true`; `200` for each of
the five page paths; `404` for each of the five others; `{"error":"demo_header_required"}` and `403`;
`/demo` with `"running":false` and `"runsToday":0`.

Open `$URL` in a browser on that other network. Expected: the page as in the rehearsal, with the
pools the rehearsal opened (their buyer links are missing, since the new volume's feed starts
empty). Click **Start a pool that fills**, and while it runs:

```bash
curl -sS -X POST -H 'X-Quorum-Demo: 1' -w '\n%{http_code}\n' "$URL/demo/fails"
fly logs --app "$APP" --no-tail | grep '\[demo\] ' | tail -n 5
```

Expected: `{"error":"demo_running",…}` and `409`; recent `[demo]` lines. When the run ends: the pool
"Settled: the seller is paid", every buyer's transaction link opens the explorer
(`https://testnet.nearblocks.io/txns/…`) at a transaction, the demo line "The last run (fills) ended
at <time>.", and `fly logs` shows `[demo] pool <id>: 8 checks passed`. Then click **Start a pool
that fails**. Expected: the pool "Refunded" after its deadline, its links opening, and
`[demo] pool <id>: 9 checks passed` in the logs.

If anything fails, `fly logs --app "$APP"` shows the gateway's and the run's output; fix the cause on
the branch and deploy again (Step 9's last command).

- [ ] **Step 11: Record the NEAR per run and tidy up**

In `docs/specs/2026-11-12-hosted-demo-design.md`, section 10, the item that starts
`**NEAR runs out before the cap does.**`, replace the sentence (prose may wrap differently in the
file: match its words)

```markdown
The NEAR one run costs is measured in the rehearsal (section 7.5).
```

with

```markdown
In the rehearsal (section 7.5), a `fills` run cost about <F> NEAR and a `fails` run about <L> NEAR:
what the parent, the relayer and the pools account had available for transfer before the run, less
what they had after it. A 5 NEAR refill therefore lasts about <R> runs.
```

where `<F>` and `<L>` are Step 8's two sums, to 3 decimals, and `<R>` is 5 divided by the larger of
the two, rounded down. Write each value without the angle brackets. Leave the rest of the spec, its
status line included, as it is.

```bash
git diff --stat
git add docs/specs/2026-11-12-hosted-demo-design.md
git commit -m "record the NEAR a hosted demo run costs"
```

Expected: `git diff --stat` lists only the hosted demo spec.

Move the swarm's own settings back if Step 2 set them aside, and check that the run left nothing else
to commit:

```bash
test -e apps/swarm/.env.saved && mv apps/swarm/.env.saved apps/swarm/.env
git status --short
```

Expected: `git status --short` prints nothing. The deployment keeps running; its accounts and pools
stay on testnet. Refills, `swarm reset`, logs and taking it down are as spec §7.6 describes; run
`swarm reset` from this shell (with Step 2's exports) only while `GET /demo` shows no run in
progress.

## Spec coverage

| Spec section | Task |
|---|---|
| 3.1 One phrase (seed, SLIP-10, paths, account rule) | 2; the account rule in 3 |
| 3.2 `swarm keys from-seed` (phrase, `--parent-key`, accounts, chain check, key files, `--gateway-env`, output) | 3 |
| 3.3 Where the keys live | 3 (files), 7 (`/run/quorum`, the phrase removed from the gateway's environment), 9 (the operator's files outside the repository) |
| 4.1 Configuration | 4 |
| 4.2 Routes and their order of answers | 5 |
| 4.3 A run (slot, count, environment, output, end, maximum run time, shutdown) | 4; the shutdown wiring in 5 |
| 5 The live page | 6 |
| 6 The gateway's static files | 1 |
| 7.1 to 7.4 Image, start script, `fly.toml`, secret | 7 |
| 7.5 Bootstrap | 9 |
| 7.6 Operating it | 9 (its last steps), 8 (the design spec's operating notes) |
| 8 Error handling | 3, 4 and 5 (each case has a test) |
| 9 Testing | the tests of Tasks 1 to 6; the image checks of 7; the deployment checks of 9 |
| 10 Known limits | 8 (design spec section 12); 9 (the measured NEAR per run) |
| 11 Changes to the design spec | 8 |
