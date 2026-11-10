# Protocol and Gateway Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or
> executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for
> tracking.

**Goal:** Build the HTTP half of Quorum on NEAR: the `quorum` x402 scheme as a pure TypeScript
package, and the gateway that serves offers, checks and relays payments, issues credentials, answers
redemptions, runs the keeper and keeps the activity feed.

**Architecture:** A pnpm workspace beside the Cargo workspace. `packages/protocol` holds the scheme's
types, the header codecs, the Borsh decoding and signature checks of a signed delegate action, the
static payment checks (spec section 6.4, rows 1 to 3), NEP-413 redemption proofs and the pure builders
a buyer uses; it has no network access. `apps/gateway` is a Hono app over two small interfaces,
`ChainReader` and `ChainWriter`, so every handler is tested against an in-memory fake chain; the real
implementations wrap near-api-js's JSON-RPC provider and a relayer that leases one access key per
transaction. The last two tasks are gated on the contracts plan: one runs the gateway against a
local NEAR sandbox with the contracts deployed, the other records what it measured.

**Tech Stack:** Node 22.22.2 or later, pnpm 10, TypeScript 5.9 run directly by Node (type stripping,
no build step); near-api-js 7.4.0 and borsh 2.0.0; @noble/hashes 2.0.1; jose 6.2.17 for the JWS
credential; hono 4.13.17 with @hono/node-server 2.1.6; vitest 4.1.12; near-sandbox 0.3.5 for the
sandbox test.

**Spec:** [`../specs/2026-11-09-quorum-on-near-design.md`](../specs/2026-11-09-quorum-on-near-design.md).
Executors read the spec and this plan together. Section numbers below refer to the spec.

## Status of the code in this plan

The code and tests of Tasks 1 to 14 were typechecked with `tsc` and run with vitest (867 tests:
331 in the protocol package, 536 in the gateway), with the pinned package versions above, before
this plan was written; they ran on Node 22.18, for which near-api-js 7.4.0 only prints an engine
warning. Each task was also checked on its own, with only its files and earlier tasks' present: it
typechecks and passes with the counts its steps state. Copy them as written. Task 15's sandbox test
and its captured-outcome test were typechecked but have never run: they need the contracts' wasm
files and Linux, macOS on Apple silicon or WSL2. Treat them as unverified until their commands have
passed, and fix names in place if a library call differs (do not change what they assert).

## Global Constraints

Every task's requirements include this section.

- **Runtime:** Node 22.22.2 or later (near-api-js 7.4.0 and near-sandbox 0.3.5 require it), pnpm 10
  through Corepack. ESM throughout. Node runs the `.ts` sources directly, so the TypeScript must use
  erasable syntax only: no `enum`, no parameter properties, no `namespace`; relative imports end in
  `.ts`; types are imported with `import type`. `tsc` only typechecks (`noEmit`).
- **Exact versions** as in the Tech Stack line; `pnpm add` with an exact version writes it to
  `package.json` as written. Add no other dependency.
- **The protocol package has no network access.** Everything that needs the chain is in the gateway.
- **The pools contract's JSON interface** is the one the contracts plan defines, restated in Task 1:
  snake_case field names, lowercase status strings, amounts as decimal strings, `deadline_ms` a
  number, events as `EVENT_JSON:` log lines with a one-element `data` array.
- **Deadlines** are judged by block time, never by the gateway's clock. The gateway's clock is used
  only for durations and timestamps: the redemption proof's age, the redemption nonce cache's expiry,
  the relayer's lookup budget and key-wait timeout, the keeper's backoff, and the credential's and the
  activity feed's timestamps.
- **The relayer never re-signs or re-sends a payment** (spec sections 6.4 and 9). The send provider is
  built with `retries: 1`: near-api-js counts attempts, so 1 posts each request once and 0 posts
  nothing. After a timeout the result is looked up by transaction hash.
- **Each relayer key signs one transaction at a time**; the keeper and the payment relay share the
  same key pool.
- **The gateway serves only pools whose seller is its configured provider** (spec section 6.1).
- **Configuration** comes from environment variables named `QUORUM_*` (Task 6); none is a constant in
  code, and no secret value is ever committed. `.env` is gitignored; `.env.example` holds empty values
  for the secrets.
- **Test keys are generated at run time** (`KeyPair.fromRandom('ed25519')`); no key material is
  written to the repository.
- **File names avoid the .gitignore patterns**: nothing named with `secret` in any case, no folder
  named `credentials/`, `secrets/`, `keystore/`, `wallets/`, `build/`, `dist/` or `data/` for source
  or fixtures, no `*.key` file. Fixtures live in `test/fixtures/`.
- **Say what is simulated:** the credential carries `simulated: true`; code and messages never call
  the provider or its access a booking, reservation or partner.
- **Repository rules:** commit messages are neutral, technical and in the present tense; none names a
  date, an event, an audience or a pitch. Work on a branch, never `main`. Stage explicit paths, never
  `git add -A` or `git add .` (the contracts' `Cargo.lock` and build output must not be swept in).
  Nothing refers to a file outside this repository.

## File Structure

| Path | Responsibility |
|---|---|
| `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json` | The pnpm workspace root (`packages/*`, `apps/*`), recursive `test` and `typecheck` scripts |
| `packages/protocol/src/constants.ts` | Scheme name, x402 version, NEP-366 and NEP-413 tags, header names |
| `packages/protocol/src/account.ts` | NEAR's account id rule |
| `packages/protocol/src/contract.ts` | The pools contract's views, the commit `msg`, NEP-297 event parsing |
| `packages/protocol/src/amounts.ts` | `priceOf`, `minBonusPerSeat`, `parseAmount` |
| `packages/protocol/src/codec.ts` | base64-JSON header encoding; the payment payload and response types |
| `packages/protocol/src/offer.ts` | The 402 offer: seats offered, `buildOffer`, `paymentRequired` |
| `packages/protocol/src/delegate.ts` | Borsh decoding of a SignedDelegate, its NEP-366 hash and signature check |
| `packages/protocol/src/checks.ts` | Static payment checks, rows 1 to 3 of spec section 6.4 |
| `packages/protocol/src/nep413.ts` | NEP-413 hashing and the redemption proof check |
| `packages/protocol/src/client.ts` | Pure builders for buyers: the `X-PAYMENT` header and the redemption proof |
| `packages/protocol/src/index.ts` | Re-exports |
| `apps/gateway/src/config.ts`, `.env.example`, `src/keygen.ts` | Configuration from `QUORUM_*` variables; a credential key generator |
| `apps/gateway/src/chain.ts` | `ChainReader`, `ChainWriter`, `TxOutcome`, `RelayResult` |
| `apps/gateway/src/rpc-chain.ts` | `ChainReader` over near-api-js's JSON-RPC provider |
| `apps/gateway/src/outcome.ts` | RPC outcome → `TxOutcome`; reading a relayed commit's events |
| `apps/gateway/src/relayer.ts` | `KeyPool` and `RpcRelayer`: one key per transaction, send once, look up on timeout |
| `apps/gateway/src/credential.ts` | The EdDSA JWS credential and the JWKS |
| `apps/gateway/src/activity.ts` | The activity feed (JSON lines under `data/`) and the keeper's records |
| `apps/gateway/src/guards.ts` | One payment in flight per buyer; the redemption nonce cache |
| `apps/gateway/src/pools.ts` | Served pools, `GET /pools` rows |
| `apps/gateway/src/reply.ts`, `src/deps.ts` | A framework-free reply type; the handlers' dependencies |
| `apps/gateway/src/handle-offer.ts`, `src/handle-payment.ts` | The offer and the payment flow (spec sections 6.2 to 6.4) |
| `apps/gateway/src/handle-redeem.ts` | Redemption (spec section 6.5) |
| `apps/gateway/src/keeper.ts` | The keeper (spec section 6.7) |
| `apps/gateway/src/app.ts`, `src/main.ts` | Routes, static serving, `/config.json`, `/rpc`; process wiring |
| `apps/gateway/test/fake-chain.ts` | `FakeChain`, a pool and configuration for tests, outcome builders |
| `apps/gateway/test/handler-deps.ts` | `testDeps`: handler dependencies over a `FakeChain` |
| `apps/gateway/test/fixtures/` | A provisional relayed outcome (Task 7) and one captured from the sandbox (Task 15) |
| `apps/gateway/test/outcome.captured.test.ts` | The outcome parser against the outcome captured from the sandbox (Task 15) |
| `apps/gateway/test/sandbox/` | The sandbox test (Task 15), excluded from `pnpm test` |

**Out of scope** (later plans): the swarm (`apps/swarm`: account setup, funding, the provider agent,
the scripted buyers, testnet runs), the MCP server (`apps/mcp`) and the live page (`apps/web`). This
plan fixes the interfaces they consume: the protocol package's exports, the gateway's HTTP API, the
activity feed's records, `/config.json`, and the `QUORUM_*` variable names they share.

---

### Task 0: Toolchain

No code and no commit. Run these once and confirm each prints a version.

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

- [ ] **Step 3: Note where each task runs**

Tasks 1 to 14 run anywhere Node runs, Windows included. On Windows, run the `bash` blocks in Git
Bash: some use `mkdir -p`, which PowerShell does not accept. Task 15 needs Linux, macOS on Apple silicon or
WSL2 (with the repository on the WSL filesystem), Rust and `cargo near` as the contracts plan's
Task 0 installs them, and Node as above. On Linux and WSL2 the sandbox node needs glibc 2.38 or
later, so Ubuntu 24.04 or later.

---

### Task 1: Workspace root and the contract interface

The pnpm workspace sits beside the Cargo workspace; neither touches the other's files. The protocol package starts with what every other module builds on: the scheme's constants, NEAR's account id rule, the pools contract's JSON interface as the contracts plan defines it, and the amount arithmetic. The task ends by recording in the spec what this plan adds to it.

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `pnpm-lock.yaml`, `packages/protocol/package.json`, `packages/protocol/tsconfig.json`, `packages/protocol/src/constants.ts`, `packages/protocol/src/account.ts`, `packages/protocol/src/contract.ts`, `packages/protocol/src/amounts.ts`, `packages/protocol/src/index.ts`
- Modify: `docs/specs/2026-11-09-quorum-on-near-design.md` (sections 6.1 to 6.5, 6.7, 7.6, 9 and 12; last step)
- Test: `packages/protocol/test/account.test.ts`, `packages/protocol/test/contract.test.ts`, `packages/protocol/test/amounts.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `X402_VERSION`, `SCHEME`, `ONE_YOCTO`, `NEP366_TAG`, `NEP413_TAG`, `REDEEM_MAX_AGE_MS`, `REDEEM_MAX_SKEW_MS`, `type Network`, `PAYMENT_HEADER`, `PAYMENT_RESPONSE_HEADER`, `PROOF_HEADER`; `isAccountId(value: string): boolean`; `type PoolStatus`, `type BuyerState`, `interface PoolView`, `SeatView`, `BuyerView`, `MAX_PAGE`, `commitMsg(poolId: number, seats: number): string`, `type QuorumEvent`, `parseEventLog(log: string): QuorumEvent | null`; `priceOf(seats: number, seatPrice: bigint): bigint`, `minBonusPerSeat(bonus: bigint, target: number): bigint`, `parseAmount(value: unknown): bigint | null`.

- [ ] **Step 1: Create the branch**

```bash
git switch main
git pull --ff-only
git switch -c feat/protocol-gateway
```

- [ ] **Step 2: Write the workspace root**

`package.json`:

```json
{
  "name": "quorum-on-near",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@10.23.0",
  "engines": { "node": ">=22.22.2" },
  "scripts": {
    "test": "pnpm -r --if-present test",
    "typecheck": "pnpm -r --if-present typecheck"
  }
}
```

`pnpm-workspace.yaml`:

```yaml
packages:
  - "packages/*"
  - "apps/*"
```

`tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": false,
    "verbatimModuleSyntax": true,
    "erasableSyntaxOnly": true,
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": ["node"]
  }
}
```

- [ ] **Step 3: Write the protocol package manifest and install**

`packages/protocol/package.json`:

```json
{
  "name": "@quorum-on-near/protocol",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json"
  },
  "dependencies": {
    "@noble/hashes": "2.0.1",
    "borsh": "2.0.0",
    "near-api-js": "7.4.0"
  },
  "devDependencies": {
    "@types/node": "22.20.5",
    "typescript": "5.9.3",
    "vitest": "4.1.12"
  }
}
```

`packages/protocol/tsconfig.json`:

```json
{ "extends": "../../tsconfig.base.json", "include": ["src", "test"] }
```

```bash
mkdir -p packages/protocol/src packages/protocol/test
pnpm install
```

Expected: `pnpm-lock.yaml` is written and the dependencies install. pnpm may report build scripts it skipped; none of these packages needs one.

- [ ] **Step 4: Write the failing tests**

`packages/protocol/test/account.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { isAccountId } from '../src/account.ts';

describe('isAccountId', () => {
  it('accepts named accounts and sub-accounts', () => {
    for (const id of ['near', 'pools.parent.testnet', 'buyer-01.parent.testnet', 'a_b.c-d']) {
      expect(isAccountId(id)).toBe(true);
    }
  });

  it('accepts a 64-character implicit account', () => {
    expect(isAccountId('3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af')).toBe(true);
  });

  it('refuses ids shorter than 2 or longer than 64 characters', () => {
    expect(isAccountId('a')).toBe(false);
    expect(isAccountId('a'.repeat(65))).toBe(false);
  });

  it('refuses upper case, empty parts and separators at the edges', () => {
    for (const id of ['Near', 'a..b', '.ab', 'ab.', '-ab', 'ab-', 'a--b', 'a b', '']) {
      expect(isAccountId(id)).toBe(false);
    }
  });
});
```

`packages/protocol/test/contract.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { commitMsg, parseEventLog, type QuorumEvent } from '../src/contract.ts';

/** A log line with the given body, as the pools contract writes it. */
function logLine(body: unknown): string {
  return `EVENT_JSON:${JSON.stringify(body)}`;
}

/** The NEP-297 envelope the pools contract puts around one event. */
function envelope(event: string, data: unknown): Record<string, unknown> {
  return { standard: 'quorum', version: '1.0.0', event, data: [data] };
}

const EVENTS: QuorumEvent[] = [
  {
    event: 'pool_opened',
    data: {
      pool_id: 7,
      seller: 'provider.parent.testnet',
      seat_price: '180',
      target: 192,
      deadline_ms: 1_800_000_000_000,
      bonus: '1728',
      terms: '8×GPU × 24 h; 1 seat = 1 GPU-hour; prices at 1/10,000 scale',
    },
  },
  {
    event: 'seats_committed',
    data: { pool_id: 7, buyer: 'buyer-01.parent.testnet', seats: 2, amount: '360', taken: 150, target: 192 },
  },
  { event: 'pool_filled', data: { pool_id: 7, taken: 192 } },
  { event: 'pool_settled', data: { pool_id: 7, seller: 'provider.parent.testnet', amount: '36288' } },
  {
    event: 'seat_refunded',
    data: { pool_id: 8, buyer: 'buyer-01.parent.testnet', seats: 2, amount: '700', bonus_share: '60' },
  },
  { event: 'refund_failed', data: { pool_id: 8, buyer: 'buyer-02.parent.testnet', amount: '350' } },
  { event: 'refund_claimed', data: { pool_id: 8, buyer: 'buyer-02.parent.testnet', amount: '350' } },
  { event: 'pool_refunded', data: { pool_id: 8, dust: '72' } },
];

describe('commitMsg', () => {
  it('writes the commit message as compact JSON with snake_case keys', () => {
    expect(commitMsg(7, 2)).toBe('{"commit":{"pool_id":7,"seats":2}}');
  });

  it('writes pool 0 as the number 0', () => {
    expect(commitMsg(0, 1)).toBe('{"commit":{"pool_id":0,"seats":1}}');
  });
});

describe('parseEventLog', () => {
  it.each(EVENTS.map((e) => [e.event, e] as const))('parses a %s event', (_name, event) => {
    expect(parseEventLog(logLine(envelope(event.event, event.data)))).toStrictEqual(event);
  });

  it('parses a log line written as a literal string', () => {
    const line =
      'EVENT_JSON:{"data":[{"pool_id":7,"taken":192}],"event":"pool_filled","standard":"quorum","version":"1.0.0"}';
    expect(parseEventLog(line)).toStrictEqual({ event: 'pool_filled', data: { pool_id: 7, taken: 192 } });
  });

  it('ignores fields of the envelope other than event and data', () => {
    const body = { ...envelope('pool_filled', { pool_id: 7, taken: 192 }), extra: true };
    expect(parseEventLog(logLine(body))).toStrictEqual({ event: 'pool_filled', data: { pool_id: 7, taken: 192 } });
  });

  it('returns null for another standard', () => {
    const body = { ...envelope('pool_filled', { pool_id: 7, taken: 192 }), standard: 'nep141' };
    expect(parseEventLog(logLine(body))).toBeNull();
  });

  it('returns null for a missing standard', () => {
    const { standard: _omitted, ...body } = envelope('pool_filled', { pool_id: 7, taken: 192 });
    expect(parseEventLog(logLine(body))).toBeNull();
  });

  it('returns null for another version', () => {
    const body = { ...envelope('pool_filled', { pool_id: 7, taken: 192 }), version: '1.0.1' };
    expect(parseEventLog(logLine(body))).toBeNull();
  });

  it('returns null for a version written as a number', () => {
    const body = { ...envelope('pool_filled', { pool_id: 7, taken: 192 }), version: 1 };
    expect(parseEventLog(logLine(body))).toBeNull();
  });

  it('returns null for an unknown event name', () => {
    expect(parseEventLog(logLine(envelope('pool_closed', { pool_id: 7 })))).toBeNull();
  });

  it('returns null for an event name that is not a string', () => {
    const body = { ...envelope('pool_filled', { pool_id: 7, taken: 192 }), event: 1 };
    expect(parseEventLog(logLine(body))).toBeNull();
  });

  it('returns null when data is an object instead of an array', () => {
    const body = { ...envelope('pool_filled', {}), data: { pool_id: 7, taken: 192 } };
    expect(parseEventLog(logLine(body))).toBeNull();
  });

  it('returns null when data is an empty array', () => {
    const body = { ...envelope('pool_filled', {}), data: [] };
    expect(parseEventLog(logLine(body))).toBeNull();
  });

  it('returns null when data has two elements', () => {
    const body = { ...envelope('pool_filled', {}), data: [{ pool_id: 7, taken: 192 }, { pool_id: 8, taken: 3 }] };
    expect(parseEventLog(logLine(body))).toBeNull();
  });

  it('returns null when data is missing', () => {
    const { data: _omitted, ...body } = envelope('pool_filled', {});
    expect(parseEventLog(logLine(body))).toBeNull();
  });

  it.each([
    ['a number', 7],
    ['a string', 'pool 7'],
    ['null', null],
    ['an array', [7, 192]],
  ])('returns null when the data element is %s', (_kind, element) => {
    expect(parseEventLog(logLine(envelope('pool_filled', element)))).toBeNull();
  });

  it('returns null when the body is not JSON', () => {
    expect(parseEventLog('EVENT_JSON:{"standard":"quorum",')).toBeNull();
  });

  it.each([
    ['null', null],
    ['a string', 'quorum'],
    ['an array', [envelope('pool_filled', { pool_id: 7, taken: 192 })]],
  ])('returns null when the body is %s', (_kind, body) => {
    expect(parseEventLog(logLine(body))).toBeNull();
  });

  it('returns null without the EVENT_JSON: prefix', () => {
    expect(parseEventLog(JSON.stringify(envelope('pool_filled', { pool_id: 7, taken: 192 })))).toBeNull();
  });

  it('returns null when the prefix is not at the start of the line', () => {
    expect(parseEventLog(` ${logLine(envelope('pool_filled', { pool_id: 7, taken: 192 }))}`)).toBeNull();
  });

  it('returns null for a prefix in another case', () => {
    const line = `event_json:${JSON.stringify(envelope('pool_filled', { pool_id: 7, taken: 192 }))}`;
    expect(parseEventLog(line)).toBeNull();
  });

  it('returns null for a plain log line', () => {
    expect(parseEventLog('Transfer 360 from buyer-01.parent.testnet to pools.parent.testnet')).toBeNull();
  });

  it('returns null for an empty line', () => {
    expect(parseEventLog('')).toBeNull();
  });
});
```

`packages/protocol/test/amounts.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { minBonusPerSeat, parseAmount, priceOf } from '../src/amounts.ts';

const U128_MAX = 2n ** 128n - 1n;

describe('priceOf', () => {
  it('multiplies the seats by the seat price', () => {
    expect(priceOf(2, 180n)).toBe(360n);
  });

  it('is 0 for 0 seats', () => {
    expect(priceOf(0, 180n)).toBe(0n);
  });

  it('keeps every digit of a price beyond the range of a number', () => {
    expect(priceOf(1000, U128_MAX)).toBe(1000n * U128_MAX);
  });

  it.each([
    ['negative', -1],
    ['fractional', 1.5],
    ['beyond the safe integer range', 2 ** 53],
    ['NaN', Number.NaN],
    ['infinite', Number.POSITIVE_INFINITY],
  ])('throws a RangeError for a seat count that is %s', (_kind, seats) => {
    expect(() => priceOf(seats, 180n)).toThrow(RangeError);
  });
});

describe('minBonusPerSeat', () => {
  it('gives the whole bonus to the one seat of a target of 1', () => {
    expect(minBonusPerSeat(1728n, 1)).toBe(1728n);
  });

  it('gives the whole bonus to the one seat a failed pool of target 2 can hold', () => {
    expect(minBonusPerSeat(1728n, 2)).toBe(1728n);
  });

  it('gives 9 for a bonus of 1728 and a target of 192', () => {
    expect(minBonusPerSeat(1728n, 192)).toBe(9n);
  });

  it('rounds down for a target of 191', () => {
    expect(minBonusPerSeat(1728n, 191)).toBe(9n);
  });

  it('divides by target − 1, not by target', () => {
    expect(minBonusPerSeat(1910n, 192)).toBe(10n);
  });

  it('is 0 when the bonus is smaller than target − 1', () => {
    expect(minBonusPerSeat(100n, 192)).toBe(0n);
  });

  it('is 0 for a bonus of 0', () => {
    expect(minBonusPerSeat(0n, 192)).toBe(0n);
  });
});

describe('parseAmount', () => {
  it('accepts "0"', () => {
    expect(parseAmount('0')).toBe(0n);
  });

  it('accepts digits with no leading zero', () => {
    expect(parseAmount('360')).toBe(360n);
  });

  it('keeps every digit of the largest u128', () => {
    expect(parseAmount(U128_MAX.toString())).toBe(U128_MAX);
  });

  it.each([
    ['a leading zero', '01'],
    ['a minus sign', '-1'],
    ['a plus sign', '+1'],
    ['a decimal point', '1.5'],
    ['an exponent', '1e3'],
    ['a hex prefix', '0x10'],
    ['a leading space', ' 1'],
    ['a trailing space', '1 '],
    ['a digit separator', '1_000'],
    ['no digits', ''],
  ])('rejects a string with %s', (_kind, value) => {
    expect(parseAmount(value)).toBeNull();
  });

  it.each([
    ['a number', 360],
    ['zero as a number', 0],
    ['a bigint', 360n],
    ['null', null],
    ['undefined', undefined],
    ['an object', { amount: '360' }],
  ])('rejects %s', (_kind, value) => {
    expect(parseAmount(value)).toBeNull();
  });
});
```

- [ ] **Step 5: Run them to see them fail**

Run: `pnpm --filter @quorum-on-near/protocol exec vitest run test/account.test.ts test/contract.test.ts test/amounts.test.ts`

Expected: FAIL. vitest cannot load `../src/account.ts`, `../src/contract.ts` and `../src/amounts.ts`, which do not exist yet.

- [ ] **Step 6: Write the implementation**

`packages/protocol/src/constants.ts`:

```typescript
/** x402 wire-format version used by the `quorum` scheme. */
export const X402_VERSION = 1;
/** The x402 scheme name. */
export const SCHEME = 'quorum';
/** Exactly 1 yoctoNEAR: the deposit `ft_transfer_call` requires. */
export const ONE_YOCTO = 1n;
/** NEP-366 delegate-action prefix tag: 2^30 + 366. */
export const NEP366_TAG = 1_073_742_190;
/** NEP-413 signed-message prefix tag: 2^31 + 413. */
export const NEP413_TAG = 2_147_484_061;
/** A redemption proof is accepted for 5 minutes after it was signed. */
export const REDEEM_MAX_AGE_MS = 300_000;
/** How far ahead of the gateway's clock a proof's signing time may be, to absorb clock skew. */
export const REDEEM_MAX_SKEW_MS = 60_000;
/** A network in CAIP-2 form, such as `near:testnet`. */
export type Network = `near:${string}`;
/** HTTP header names. */
export const PAYMENT_HEADER = 'X-PAYMENT';
export const PAYMENT_RESPONSE_HEADER = 'X-PAYMENT-RESPONSE';
export const PROOF_HEADER = 'X-QUORUM-PROOF';
```

`packages/protocol/src/account.ts`:

```typescript
/** NEAR's account id rule: lowercase parts joined by `.`, each part letters and digits joined by `-` or `_`. */
const ACCOUNT_ID = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

/** True when `value` is a valid NEAR account id (named or implicit), 2 to 64 characters long. */
export function isAccountId(value: string): boolean {
  return value.length >= 2 && value.length <= 64 && ACCOUNT_ID.test(value);
}
```

`packages/protocol/src/contract.ts`:

```typescript
/**
 * The pools contract's JSON interface: view results, the commit message and NEP-297 events.
 * Field names and string forms are the contract's own (snake_case; amounts as decimal strings).
 */
export type PoolStatus = 'open' | 'filled' | 'settled' | 'expired' | 'refunded';
export type BuyerState = 'committed' | 'refunded' | 'claimable';

/** A `get_pool` / `list_pools` row. The contract derives the status from block time. */
export interface PoolView {
  id: number;
  seller: string;
  seat_price: string;
  target: number;
  taken: number;
  deadline_ms: number;
  bonus: string;
  max_seats_per_buyer: number | null;
  terms: string;
  status: PoolStatus;
  bonus_per_seat: string;
  refund_cursor: number;
  dust_sent: boolean;
  buyer_count: number;
}
/** A `get_seats` row. */
export interface SeatView {
  buyer: string;
  seats: number;
  state: BuyerState;
}
/** The `get_buyer` result (the view returns null for an account that holds no seats). */
export interface BuyerView {
  seats: number;
  state: BuyerState;
}
/** The most rows a view returns in one call. */
export const MAX_PAGE = 100;

/** The `msg` of a commit: `{"commit":{"pool_id":7,"seats":2}}`. */
export function commitMsg(poolId: number, seats: number): string {
  return JSON.stringify({ commit: { pool_id: poolId, seats } });
}

export type QuorumEvent =
  | { event: 'pool_opened'; data: { pool_id: number; seller: string; seat_price: string; target: number; deadline_ms: number; bonus: string; terms: string } }
  | { event: 'seats_committed'; data: { pool_id: number; buyer: string; seats: number; amount: string; taken: number; target: number } }
  | { event: 'pool_filled'; data: { pool_id: number; taken: number } }
  | { event: 'pool_settled'; data: { pool_id: number; seller: string; amount: string } }
  | { event: 'seat_refunded'; data: { pool_id: number; buyer: string; seats: number; amount: string; bonus_share: string } }
  | { event: 'refund_failed'; data: { pool_id: number; buyer: string; amount: string } }
  | { event: 'refund_claimed'; data: { pool_id: number; buyer: string; amount: string } }
  | { event: 'pool_refunded'; data: { pool_id: number; dust: string } };

const EVENT_NAMES = new Set<string>([
  'pool_opened',
  'seats_committed',
  'pool_filled',
  'pool_settled',
  'seat_refunded',
  'refund_failed',
  'refund_claimed',
  'pool_refunded',
]);
const EVENT_PREFIX = 'EVENT_JSON:';

/**
 * Parses one log line. Returns the event when the line is `EVENT_JSON:` followed by a JSON object
 * with `standard: "quorum"`, `version: "1.0.0"`, a known `event` name and a one-element `data`
 * array; returns null for any other line. Never throws.
 *
 * Only the envelope is checked: `data` is cast to the event's type, its fields unchecked. Any
 * contract can log such a line, so callers must pass only logs of receipts that the pools contract
 * executed.
 */
export function parseEventLog(log: string): QuorumEvent | null {
  if (!log.startsWith(EVENT_PREFIX)) return null;
  let body: unknown;
  try {
    body = JSON.parse(log.slice(EVENT_PREFIX.length));
  } catch {
    return null;
  }
  if (typeof body !== 'object' || body === null) return null;
  const { standard, version, event, data } = body as Record<string, unknown>;
  if (standard !== 'quorum' || version !== '1.0.0') return null;
  if (typeof event !== 'string' || !EVENT_NAMES.has(event)) return null;
  if (!Array.isArray(data) || data.length !== 1) return null;
  const first: unknown = data[0];
  if (typeof first !== 'object' || first === null || Array.isArray(first)) return null;
  return { event, data: first } as QuorumEvent;
}
```

`packages/protocol/src/amounts.ts`:

```typescript
/** `seats × seat_price`. Throws RangeError unless `seats` is a non-negative safe integer. */
export function priceOf(seats: number, seatPrice: bigint): bigint {
  if (!Number.isSafeInteger(seats) || seats < 0) throw new RangeError(`invalid seat count: ${seats}`);
  return BigInt(seats) * seatPrice;
}

/** The least a seat receives from the bonus if the pool fails: `floor(bonus / max(target − 1, 1))`. */
export function minBonusPerSeat(bonus: bigint, target: number): bigint {
  return bonus / BigInt(Math.max(target - 1, 1));
}

const DECIMAL = /^(0|[1-9][0-9]*)$/;

/** Parses a decimal amount string: `"0"`, or digits with no leading zero. Returns null otherwise. */
export function parseAmount(value: unknown): bigint | null {
  if (typeof value !== 'string' || !DECIMAL.test(value)) return null;
  return BigInt(value);
}
```

`packages/protocol/src/index.ts`:

```typescript
export * from './constants.ts';
export * from './account.ts';
export * from './contract.ts';
export * from './amounts.ts';
```

- [ ] **Step 7: Run the tests and the typecheck**

Run: `pnpm --filter @quorum-on-near/protocol exec vitest run test/account.test.ts test/contract.test.ts test/amounts.test.ts`

Expected: PASS, 73 tests (`test/account.test.ts` 4, `test/contract.test.ts` 35, `test/amounts.test.ts` 34).

Run: `pnpm --filter @quorum-on-near/protocol typecheck`

Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add package.json pnpm-workspace.yaml tsconfig.base.json pnpm-lock.yaml packages/protocol
git commit -m "add the pnpm workspace and the contract interface of the protocol package"
```

- [ ] **Step 9: Record in the spec what this plan adds**

These edits touch sections 6.1 to 6.5, 6.7, 7.6, 9 and 12 only. The contracts plan edits sections 4,
5.3, 5.4, 5.6 and 10, so the two branches merge without conflict. In
`docs/specs/2026-11-09-quorum-on-near-design.md`, make each replacement below. A table row is one
line in the file; a passage of prose may wrap differently in the file than here, so match its
words, not its line breaks.

1. Section 6.1, the endpoint table. Replace the row

   ```markdown
   | `GET /` | The live page (static files from `apps/web`) |
   ```

   with

   ```markdown
   | `GET /` | The live page (static files from `apps/web`). No file whose path has a segment that starts with a dot, such as `/.env`, is served (`404`) |
   ```

   Replace the row

   ```markdown
   | `GET /pools/:id/access?seats=N` | With no header: `402` with the offer (`seats` defaults to 1). With `X-PAYMENT`: process a payment. With `X-QUORUM-PROOF`: redeem (section 6.5) |
   ```

   with

   ```markdown
   | `GET /pools/:id/access?seats=N` | With no header: `402` with the offer (`seats` defaults to 1; `N` from 1 to 1000, otherwise `400` with `error` set to `invalid_seats`), `404` (`unknown_pool`) for a pool the gateway does not serve, `409` if the pool is filled or has no seat left, `410` if it has expired, `503` (`chain_unavailable`) if the chain cannot be read. With `X-PAYMENT`: process a payment. With `X-QUORUM-PROOF`: redeem (section 6.5) |
   ```

   Replace the row

   ```markdown
   | `POST /rpc` | Only if the public RPC refuses browser requests: a read-only pass-through that forwards `call_function` view calls on the pools contract and the token, and nothing else |
   ```

   with these two rows

   ```markdown
   | `POST /rpc` | Only if the public RPC refuses browser requests: a read-only pass-through that forwards `call_function` view calls on the pools contract and the token, and nothing else. Any other call, or `args_base64` over 1,024 characters, is answered `403` (`not_allowed`); a body over 16 KiB `413` (`body_too_large`); a body that is not JSON `400` (`invalid_json`); and an RPC that cannot be reached `503` (`chain_unavailable`) |
   | `GET /config.json` | What the live page needs: the network, the RPC URL (`/rpc` when the pass-through is on), the pools contract, the token, the provider and the explorer's transaction link prefix |
   ```

2. Section 6.2, below the offer. Replace the passage

   ```markdown
   If fewer seats are left than requested, the offer is made for the seats left, and
   `extra.seats` says so. From here on, "the seats" of a payment means `extra.seats`.
   ```

   with

   ```markdown
   The offer is made for the seats requested, or fewer if fewer are left or the pool's
   `max_seats_per_buyer` is lower, and `extra.seats` says so. The fresh offer that comes with a
   refused payment (section 6.4) also counts the seats the buyer already holds against
   `max_seats_per_buyer`. From here on, "the seats" of a payment means the seats its `msg` commits
   to: any number from 1 to the seats of its request (`?seats=N`), so a buyer that pays an offer
   reduced to `extra.seats` at the URL it first requested is accepted.
   ```

3. Section 6.3: after the line ``- gas of at least `minGas`.``, add a blank line and the paragraph

   ```markdown
   Before signing, a buyer checks the offer against its own configuration, its request and a
   spending limit for this payment (not the token balance of section 7.2; the MCP server's spend cap
   of section 7.5 is a separate, running limit): the scheme is `quorum`; `network`, `asset` and `payTo` are its configured network, token
   and pools contract, never taken from the gateway; the fields it pays from are well formed;
   `extra.poolId` is the pool it requested; `extra.seats` is at most the seats it requested (fewer
   is a reduced offer, and accepted); and `maxAmountRequired` is exactly `extra.seats ×
   extra.seatPrice` and at most that spending limit. It refuses the first
   failure, in that order (`wrong_scheme`, `wrong_network`, `wrong_asset`, `wrong_pay_to`,
   `invalid_offer`, `wrong_pool`, `too_many_seats`, `wrong_amount`, `over_budget`), and signs
   nothing. The check bounds what the payment commits to and what it costs. Within the limit the
   seat price is the offer's, and what `extra` says about the pool (terms, deadline, bonus, seats
   taken) is the gateway's word; a buyer that relies on it reads the pool from the chain. A payment
   at a seat price other than the pool's own is refused by the contract, and the token returns the
   transfer.
   ```

4. Section 6.4, its first paragraph: in the sentence that starts `A failed check is answered with`,
   replace the words `carrying the same offer` with `carrying the offer as it stands (section 6.2)`.
   Then, in the checks table, replace row 5 with

   ```markdown
   | 5 | `nonce` is above the key's current nonce, and below the final block height × 10^6 (the chain refuses a larger delegate nonce without using it up, so the same payment could be relayed again); `max_block_height` is more than 5 blocks above the final height, and no further ahead than `maxTimeoutSeconds` of blocks (converted with the configured average block time) plus 5 | gateway | `stale_nonce`, `nonce_too_large`, `expired` |
   ```

5. Section 6.4, the checks table: after row 7 (`insufficient_balance`), add the row

   ```markdown
   | 8 | `sender_id` is not the pool's seller, and the seats it already holds (`get_buyer`) plus the seats paid for stay within `max_seats_per_buyer`. The contract refuses both, so the gateway refuses them before the relayer pays gas | gateway | `seller_commit`, `over_buyer_cap` |
   ```

6. Section 6.4: replace the passage

   ```markdown
   Each buyer has at most one payment in flight; a second one is refused with `payment_in_flight`. A
   payment is in flight from its relay until its result is known or its `max_block_height` has passed,
   whichever comes first.
   ```

   with

   ```markdown
   The delegate action must be signed with an ed25519 or a secp256k1 key; any other key type is
   `invalid_payload`. The `ft_transfer_call` arguments must be compact JSON, as `JSON.stringify`
   writes them. The gateway reads the contract's views and access keys at optimistic finality, so it
   sees state at least as new as the results it relays; heights and deadlines are judged against the
   final block. The relayer checks the expiry again once it holds a key, and refuses a payment that
   expired while it waited with `expired`. If the chain cannot be read while the checks run, the
   gateway answers `503` and relays nothing.

   Each buyer has at most one payment in flight; a second one is refused with `payment_in_flight`. A
   payment is in flight from its relay until its result is known or a final block above its
   `max_block_height` has been seen. If the relay ends with the result unknown while the delegate
   may still land, the buyer stays in flight after the `502`: the gateway releases it once a final
   height it reads for a later payment (the buyer's own or any other buyer's) is above that
   `max_block_height`, never by its own clock. Until then, the buyer's payments are refused with
   `payment_in_flight`.
   ```

7. Section 6.4, the relay paragraph: replace

   ```markdown
   On an RPC timeout, the gateway looks the result up by transaction hash. It never re-signs or
   re-sends a payment.
   ```

   with

   ```markdown
   On an RPC timeout, the gateway looks the result up by transaction hash. It never re-signs or
   re-sends a payment. A response counts as the result only once its `final_execution_status` is
   `EXECUTED_OPTIMISTIC`, `EXECUTED` or `FINAL`; at a lower status its receipts may not all have run,
   so the transaction is looked up again.
   ```

8. Section 6.4, the outcome table. Replace the row

   ```markdown
   | No seats taken (the pool filled or closed in between; the token has returned the money) | `409 Conflict`, with a fresh offer if seats are left |
   ```

   with these two rows

   ```markdown
   | No seats taken because the pool filled in between (the token has returned the money) | `409 Conflict`, with `error` set to `no_seats_taken` and no offer |
   | No seats taken while the pool is still Open with a seat left, or the transfer never reached the pools contract | `502 Bad Gateway`, with `error` set to `relay_failed` and the transaction hash. The contract takes whatever seats are left, so something else refused the commit, and the same payment would be refused again |
   ```

   Replace the row

   ```markdown
   | The pool had expired | `410 Gone` |
   ```

   with

   ```markdown
   | The pool had expired: the views say Expired or Refunded, or Open with the final block's time at or past the deadline | `410 Gone` |
   ```

   Replace the row

   ```markdown
   | The relay failed, or its result is unknown after the timeout | `502 Bad Gateway`, with the transaction hash if there is one |
   ```

   with

   ```markdown
   | The relay failed, or its result is unknown after the timeout | `502 Bad Gateway`, with the transaction hash if there is one, and `error` set to `relay_failed` or `result_unknown` |
   ```

   Then, directly after the table and before the line that starts `` `X-PAYMENT-RESPONSE` carries ``,
   add the paragraph

   ```markdown
   When a commit took no seats, the first of these that applies is the answer: `410` if the pool is
   past its deadline, judged by block time; `502` with `relay_failed` if the transfer never reached
   the pools contract or the pool is still Open with a seat left; otherwise `409`.
   ```

9. Section 6.5: after the line `4. that the nonce has not been seen.`, add a blank line and the
   paragraph

   ```markdown
   The replay check is keyed by the public key and the nonce, which is what NEP-413 signs. A proof
   that fails is answered with `401` and `error` set to `invalid_proof`, `wrong_message`,
   `wrong_recipient`, `stale_proof`, `invalid_signature`, `not_full_access` or `replayed_proof`. In
   the header, `signature` and `nonce` are standard base64, `publicKey` is the key in NEAR's text
   form (`ed25519:<base58>` or `secp256k1:<base58>`), and `recipient` is the gateway's host as its
   URL writes it (`host` or `host:port`). A signing time up to one minute ahead of the gateway's
   clock is accepted, to absorb clock skew, so a nonce is remembered for six minutes.
   ```

10. Section 6.7: replace the line

    ```markdown
    - for each pool past its deadline that is not yet Refunded, it calls `refund(pool_id, 10)`.
    ```

    with

    ```markdown
    - for each Expired pool (the views report an Open pool past its deadline as Expired; a Filled or
      Settled pool is never refunded), it calls `refund(pool_id, limit)`, with `limit` 10 by default,
      unless the pool's dust transfer is already in flight (every buyer visited and `dust_sent` set),
      when the call would do nothing.

    A call makes progress when `settle` settles the pool, or when the `refund` call's receipt at the
    pools contract succeeds and either the pool had buyers left to visit (the call moves the refund
    cursor, even past buyers who claimed their own refunds and log nothing) or the dust arrives
    (`pool_refunded`). A pool whose call makes no progress is retried with a backoff: 30 seconds,
    doubling, up to 10 minutes. Only the first failure of such a streak is written to the activity
    feed; a refund that could not be pushed to a buyer is always written.
    ```

11. Section 7.6, the configuration table. Replace the row

    ```markdown
    | RPC URL | gateway, swarm, MCP server, live page | The NEAR testnet RPC endpoint |
    ```

    with

    ```markdown
    | RPC URL | gateway, swarm, MCP server, live page | The NEAR testnet RPC endpoint. The gateway refuses to start if the RPC's `chain_id` does not fit the network: `testnet` for `near:testnet`, and neither `testnet` nor `mainnet` for `near:sandbox`. It publishes the URL to the live page in `/config.json` unless the pass-through is on, so the URL must not carry an API key |
    ```

    Replace the row

    ```markdown
    | Relayer keys | gateway | The several access keys of the relayer account (secret) |
    ```

    with

    ```markdown
    | Relayer keys | gateway | The several access keys of the relayer account (secret), each listed once |
    ```

    After the table's last row (`| Budget per buyer, bonus funds for the provider | …`), add the rows

    ```markdown
    | Network | gateway, swarm, MCP server | `near:testnet`, the network that offers and payments name. The gateway refuses any other, except `near:sandbox`, the local chain its sandbox test runs on |
    | Pools account | gateway, swarm, MCP server | The pools contract buyers pay; default `pools.<parent>`. A buyer refuses an offer whose `payTo` is not this account (section 6.3) |
    | Commit gas bounds | gateway | The offer's `minGas` and `maxGas` (section 6.2): `minGas` at most `maxGas`, both at most 300 Tgas |
    | Average block time | gateway, swarm, MCP server | Converts `maxTimeoutSeconds` into blocks (section 6.4, check 5) |
    | Keeper settings | gateway | The keeper's interval, the refund batch `limit` (1 to 10), and the gas attached to `settle` and `refund` (section 6.7): at least what the contract requires at entry (section 5.4), 33 Tgas for `settle` and 10 + 23 × (`limit` + 1) Tgas for `refund`, and at most 300 Tgas |
    | RPC pass-through | gateway | Turns `POST /rpc` on (section 6.1) |
    | Live page folder | gateway | The folder served at `/` (section 8). The gateway refuses to start if it is, or contains, the gateway's own folder |
    ```

12. Section 9, the error table. Replace the row

    ```markdown
    | The RPC times out during a relay | The result is looked up by transaction hash; the payment is never re-signed or re-sent. If the result is still unknown, `502` with the hash, and the buyer checks through redemption |
    ```

    with

    ```markdown
    | The RPC times out during a relay | The result is looked up by transaction hash; the payment is never re-signed or re-sent. If the result is still unknown, `502` with the hash, and the buyer checks through redemption. The buyer stays in flight until a final block above the delegate's `max_block_height` has been seen (section 6.4) |
    ```

    Replace the row

    ```markdown
    | The gateway restarts | All money state is on chain. The activity feed is reloaded from its file. The redemption nonce cache restarts empty, so a proof captured before the restart can be replayed once within its 5-minute life; the replay returns the credential, a bearer token (section 12) |
    ```

    with

    ```markdown
    | The gateway restarts | All money state is on chain. The activity feed is reloaded from its file; a line cut short by a stop mid-write is skipped, and the file is ended with a newline before the next record. The redemption nonce cache restarts empty, so a proof captured before the restart can be replayed once within its life (up to six minutes, section 6.5); the replay returns the credential, a bearer token (section 12). Payments in flight, and buyers held after an unknown result, are forgotten (section 12) |
    ```

13. Section 12: after its last bullet (``**The credential is a bearer token**``), add

    ```markdown
    - **`/rpc` has no rate limit.** With the pass-through on, anyone can send view calls on the pools
      contract and the token through the gateway, up to 16 KiB each, and the RPC's own limits then
      apply to the gateway as a whole. A production version would rate-limit it per client.
    - **Credentials are issued at optimistic execution, not finality.** The relayer waits for the
      commit to execute optimistically, and redemption reads the pool at optimistic finality, so a
      credential can be issued before the block holding the commit is final. If that block were not
      finalised, the credential would stand for a seat the contract does not hold.
    - **The in-flight hold is bounded by the delegate action, not its receipts.** `max_block_height`
      bounds when the delegate action may execute, not the token and pools receipts it starts. If
      those were still pending when a final block passed it, the buyer is released while its commit
      can still land, and a second payment could commit too. The hold also lives in memory, so a
      gateway restart releases it.
    ```

Check that nothing else changed: `git diff --stat` shows only the spec, and `git diff` shows only these
hunks, none in sections 4, 5 or 10.

```bash
git add docs/specs/2026-11-09-quorum-on-near-design.md
git commit -m "specify the gateway's extra checks and answers, the in-flight hold, keeper progress, configuration and limits"
```


---

### Task 2: Header codec and the offer

Every `quorum` header is base64 of JSON (spec section 6). The offer is the 402 body of spec section 6.2; `offerSeats` caps it by the seats left and by `max_seats_per_buyer`.

**Files:**
- Create: `packages/protocol/src/codec.ts`, `packages/protocol/src/offer.ts`
- Modify: `packages/protocol/src/index.ts`
- Test: `packages/protocol/test/codec.test.ts`, `packages/protocol/test/offer.test.ts`

**Interfaces:**
- Consumes: `priceOf`, `minBonusPerSeat`, `PoolView`, `Network` (Task 1).
- Produces: `encodeHeader(value: unknown): string`, `decodeHeader(header: string): unknown`, `interface PaymentPayload`, `interface PaymentResponse`; `interface OfferExtra`, `Offer`, `PaymentRequired`, `OfferContext {network, gatewayUrl, poolsContract, token, relayer, minGas, maxGas, maxTimeoutSeconds}`, `offerSeats(pool: PoolView, requested: number): number`, `buildOffer(pool: PoolView, seats: number, ctx: OfferContext): Offer`, `paymentRequired(accepts: Offer[], error?: string): PaymentRequired`.

- [ ] **Step 1: Write the failing tests**

`packages/protocol/test/codec.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { decodeHeader, encodeHeader, type PaymentPayload, type PaymentResponse } from '../src/codec.ts';

const PAYMENT: PaymentPayload = {
  x402Version: 1,
  scheme: 'quorum',
  network: 'near:testnet',
  payload: { signedDelegate: 'AAECAwQFBgcICQ==' },
};

const RESPONSE: PaymentResponse = {
  success: true,
  transaction: '6zgh2u9DqHHiXzdy9ouTP7oGky2T4nugqzqt9wJZwNFm',
  network: 'near:testnet',
  payer: 'buyer-01.parent.testnet',
};

describe('encodeHeader', () => {
  it('writes base64 of the JSON text, with padding', () => {
    expect(encodeHeader({ a: 1 })).toBe('eyJhIjoxfQ==');
  });

  it('encodes text as UTF-8', () => {
    expect(Buffer.from(encodeHeader('×'), 'base64').toString('utf8')).toBe('"×"');
  });
});

describe('decodeHeader', () => {
  it('round-trips a payment payload', () => {
    expect(decodeHeader(encodeHeader(PAYMENT))).toStrictEqual(PAYMENT);
  });

  it('round-trips a payment response', () => {
    expect(decodeHeader(encodeHeader(RESPONSE))).toStrictEqual(RESPONSE);
  });

  it('round-trips text outside ASCII', () => {
    const value = { terms: '8×GPU × 24 h; 1 seat = 1 GPU-hour; prices at 1/10,000 scale' };
    expect(decodeHeader(encodeHeader(value))).toStrictEqual(value);
  });

  it('ignores whitespace around the header value', () => {
    expect(decodeHeader(` ${encodeHeader(PAYMENT)}\t`)).toStrictEqual(PAYMENT);
  });

  // Node's own base64 decoder would turn most of these into valid JSON: decodeHeader must refuse them first.
  it.each([
    ['an empty value', ''],
    ['only whitespace', '   '],
    ['characters outside the base64 alphabet', 'eyJh****IjoxfQ=='],
    ['the URL-safe alphabet', 'eyJrIjoifn5-Pz8_In0='],
    ['whitespace inside the value', 'eyJh    IjoxfQ=='],
    ['missing padding', 'eyJhIjoxfQ'],
    ['data after the padding', 'eyJhIjoxfQ==AAAA'],
    ['three padding characters', 'eyJhIjoxf==='],
    ['the JSON text itself', '{"a":1}'],
  ])('rejects %s as not base64', (_kind, header) => {
    expect(() => decodeHeader(header)).toThrow(new SyntaxError('header is not base64'));
  });

  it('rejects base64 of text that is not JSON', () => {
    expect(() => decodeHeader(Buffer.from('not json', 'utf8').toString('base64'))).toThrow(SyntaxError);
  });
});
```

`packages/protocol/test/offer.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import type { PoolView } from '../src/contract.ts';
import { buildOffer, offerSeats, paymentRequired, type OfferContext } from '../src/offer.ts';

const TERMS = '8×GPU × 24 h; 1 seat = 1 GPU-hour; prices at 1/10,000 scale';

/** Circle's testnet USDC. */
const TESTNET_USDC = '3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af';

/** A pool as the contract's views return it; the defaults are those of the design spec's example offer. */
function pool(overrides: Partial<PoolView> = {}): PoolView {
  return {
    id: 7,
    seller: 'provider.<parent>',
    seat_price: '180',
    target: 192,
    taken: 148,
    deadline_ms: 1_800_000_000_000,
    bonus: '1728',
    max_seats_per_buyer: null,
    terms: TERMS,
    status: 'open',
    bonus_per_seat: '0',
    refund_cursor: 0,
    dust_sent: false,
    buyer_count: 30,
    ...overrides,
  };
}

/** The account names are the design spec's placeholders, so that the example can be compared as is. */
const CTX: OfferContext = {
  network: 'near:testnet',
  gatewayUrl: 'https://<gateway>',
  poolsContract: 'pools.<parent>',
  token: TESTNET_USDC,
  relayer: 'relay.<parent>',
  minGas: 50_000_000_000_000n,
  maxGas: 100_000_000_000_000n,
  maxTimeoutSeconds: 120,
};

/** The example 402 body of the design spec, section 6.2, as written there. */
const SPEC_EXAMPLE = `{
  "x402Version": 1,
  "error": "payment required",
  "accepts": [{
    "scheme": "quorum",
    "network": "near:testnet",
    "maxAmountRequired": "360",
    "resource": "https://<gateway>/pools/7/access?seats=2",
    "description": "2 seats in pool 7: 8×GPU × 24 h; 1 seat = 1 GPU-hour; prices at 1/10,000 scale",
    "mimeType": "application/json",
    "payTo": "pools.<parent>",
    "maxTimeoutSeconds": 120,
    "asset": "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af",
    "extra": {
      "poolId": 7, "seats": 2, "seatPrice": "180",
      "target": 192, "taken": 148, "deadlineMs": 1800000000000,
      "bonus": "1728", "minBonusPerSeat": "9",
      "terms": "8×GPU × 24 h; 1 seat = 1 GPU-hour; prices at 1/10,000 scale",
      "relayer": "relay.<parent>", "minGas": "50000000000000", "maxGas": "100000000000000"
    }
  }]
}`;

describe('offerSeats', () => {
  it('offers the seats requested when enough are left', () => {
    expect(offerSeats(pool(), 2)).toBe(2);
  });

  it('offers every seat left when the request is exactly that', () => {
    expect(offerSeats(pool(), 44)).toBe(44);
  });

  it('caps the offer at the seats left in the pool', () => {
    expect(offerSeats(pool(), 50)).toBe(44);
  });

  it('caps the offer at max_seats_per_buyer', () => {
    expect(offerSeats(pool({ max_seats_per_buyer: 24 }), 30)).toBe(24);
  });

  it('applies the seats left when they are fewer than max_seats_per_buyer', () => {
    expect(offerSeats(pool({ taken: 182, max_seats_per_buyer: 24 }), 30)).toBe(10);
  });

  it('applies max_seats_per_buyer when it is lower than the seats left', () => {
    expect(offerSeats(pool({ taken: 100, max_seats_per_buyer: 5 }), 30)).toBe(5);
  });

  it('returns 0 for a full pool', () => {
    expect(offerSeats(pool({ taken: 192 }), 1)).toBe(0);
  });

  it.each([
    ['0', 0],
    ['negative', -1],
    ['fractional', 1.5],
    ['NaN', Number.NaN],
    ['beyond the safe integer range', 2 ** 53],
  ])('throws a RangeError for a request that is %s', (_kind, requested) => {
    expect(() => offerSeats(pool(), requested)).toThrow(RangeError);
  });
});

describe('buildOffer', () => {
  it('reproduces the example 402 body of the design spec, section 6.2', () => {
    expect(paymentRequired([buildOffer(pool(), 2, CTX)])).toStrictEqual(JSON.parse(SPEC_EXAMPLE));
  });

  it('serializes its fields in the order of the design spec example', () => {
    const body = paymentRequired([buildOffer(pool(), 2, CTX)]);
    expect(JSON.stringify(body)).toBe(JSON.stringify(JSON.parse(SPEC_EXAMPLE)));
  });

  it('describes one seat in the singular', () => {
    expect(buildOffer(pool(), 1, CTX).description).toBe(`1 seat in pool 7: ${TERMS}`);
  });

  it('names the seats offered in the resource URL', () => {
    expect(buildOffer(pool(), 1, CTX).resource).toBe('https://<gateway>/pools/7/access?seats=1');
  });

  it('prices the offer at seats × seat_price', () => {
    expect(buildOffer(pool({ seat_price: '320' }), 3, CTX).maxAmountRequired).toBe('960');
  });

  it('keeps every digit of a seat price beyond the range of a number', () => {
    const seatPrice = (2n ** 100n).toString();
    expect(buildOffer(pool({ seat_price: seatPrice }), 3, CTX).maxAmountRequired).toBe((3n * 2n ** 100n).toString());
  });

  it('gives the minimum bonus per seat as bonus / (target − 1), rounded down', () => {
    expect(buildOffer(pool({ bonus: '1910' }), 1, CTX).extra.minBonusPerSeat).toBe('10');
  });
});

describe('paymentRequired', () => {
  it('defaults the error to "payment required"', () => {
    expect(paymentRequired([])).toStrictEqual({ x402Version: 1, error: 'payment required', accepts: [] });
  });

  it('carries the error it is given', () => {
    expect(paymentRequired([], 'wrong_amount').error).toBe('wrong_amount');
  });

  it('carries the offers it is given', () => {
    const offer = buildOffer(pool(), 2, CTX);
    expect(paymentRequired([offer]).accepts).toStrictEqual([offer]);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @quorum-on-near/protocol exec vitest run test/codec.test.ts test/offer.test.ts`

Expected: FAIL. vitest cannot load `../src/codec.ts` and `../src/offer.ts`, which do not exist yet.

- [ ] **Step 3: Write the implementation**

`packages/protocol/src/codec.ts`:

```typescript
import type { Network } from './constants.ts';

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** base64(JSON.stringify(value)), standard alphabet with padding. */
export function encodeHeader(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

/** The inverse of encodeHeader. Throws on input that is not base64 of a JSON value. */
export function decodeHeader(header: string): unknown {
  const text = header.trim();
  if (text.length === 0 || text.length % 4 !== 0 || !BASE64.test(text)) {
    throw new SyntaxError('header is not base64');
  }
  return JSON.parse(Buffer.from(text, 'base64').toString('utf8'));
}

/** The decoded `X-PAYMENT` header. */
export interface PaymentPayload {
  x402Version: 1;
  scheme: 'quorum';
  network: Network;
  payload: { signedDelegate: string };
}

/** The decoded `X-PAYMENT-RESPONSE` header. */
export interface PaymentResponse {
  success: true;
  transaction: string;
  network: Network;
  payer: string;
}
```

`packages/protocol/src/offer.ts`:

```typescript
import { minBonusPerSeat, priceOf } from './amounts.ts';
import type { Network } from './constants.ts';
import type { PoolView } from './contract.ts';

export interface OfferExtra {
  poolId: number;
  seats: number;
  seatPrice: string;
  target: number;
  taken: number;
  deadlineMs: number;
  bonus: string;
  minBonusPerSeat: string;
  terms: string;
  relayer: string;
  minGas: string;
  maxGas: string;
}

/** One entry of `accepts` in a 402 body. */
export interface Offer {
  scheme: 'quorum';
  network: Network;
  maxAmountRequired: string;
  resource: string;
  description: string;
  mimeType: 'application/json';
  payTo: string;
  maxTimeoutSeconds: number;
  asset: string;
  extra: OfferExtra;
}

/** The 402 response body. */
export interface PaymentRequired {
  x402Version: 1;
  error: string;
  accepts: Offer[];
}

/** What the gateway knows about itself when it builds an offer. */
export interface OfferContext {
  network: Network;
  /** The gateway's public base URL, without a trailing slash. */
  gatewayUrl: string;
  poolsContract: string;
  token: string;
  relayer: string;
  minGas: bigint;
  maxGas: bigint;
  maxTimeoutSeconds: number;
}

/**
 * The seats an offer is made for: `min(requested, target − taken, max_seats_per_buyer)`, or 0 when
 * none can be offered. `requested` must be a positive safe integer (RangeError otherwise).
 */
export function offerSeats(pool: PoolView, requested: number): number {
  if (!Number.isSafeInteger(requested) || requested < 1) {
    throw new RangeError(`invalid seat count: ${requested}`);
  }
  const left = Math.max(pool.target - pool.taken, 0);
  const cap = pool.max_seats_per_buyer ?? Number.MAX_SAFE_INTEGER;
  return Math.min(requested, left, cap);
}

/**
 * Builds the offer for `seats` seats of `pool` (the caller has already applied offerSeats).
 * `resource` is `${gatewayUrl}/pools/${id}/access?seats=${seats}`, and `description` is
 * "1 seat in pool 7: <terms>" or "2 seats in pool 7: <terms>".
 */
export function buildOffer(pool: PoolView, seats: number, ctx: OfferContext): Offer {
  const seatPrice = BigInt(pool.seat_price);
  const bonus = BigInt(pool.bonus);
  return {
    scheme: 'quorum',
    network: ctx.network,
    maxAmountRequired: priceOf(seats, seatPrice).toString(),
    resource: `${ctx.gatewayUrl}/pools/${pool.id}/access?seats=${seats}`,
    description: `${seats} ${seats === 1 ? 'seat' : 'seats'} in pool ${pool.id}: ${pool.terms}`,
    mimeType: 'application/json',
    payTo: ctx.poolsContract,
    maxTimeoutSeconds: ctx.maxTimeoutSeconds,
    asset: ctx.token,
    extra: {
      poolId: pool.id,
      seats,
      seatPrice: pool.seat_price,
      target: pool.target,
      taken: pool.taken,
      deadlineMs: pool.deadline_ms,
      bonus: pool.bonus,
      minBonusPerSeat: minBonusPerSeat(bonus, pool.target).toString(),
      terms: pool.terms,
      relayer: ctx.relayer,
      minGas: ctx.minGas.toString(),
      maxGas: ctx.maxGas.toString(),
    },
  };
}

/** `{x402Version: 1, error, accepts}`; `error` defaults to `"payment required"`. */
export function paymentRequired(accepts: Offer[], error = 'payment required'): PaymentRequired {
  return { x402Version: 1, error, accepts };
}
```

`packages/protocol/src/index.ts`:

```typescript
export * from './constants.ts';
export * from './account.ts';
export * from './contract.ts';
export * from './amounts.ts';
export * from './codec.ts';
export * from './offer.ts';
```

- [ ] **Step 4: Run the tests and the typecheck**

Run: `pnpm --filter @quorum-on-near/protocol exec vitest run test/codec.test.ts test/offer.test.ts`

Expected: PASS, 38 tests (`test/codec.test.ts` 16, `test/offer.test.ts` 22).

Run: `pnpm --filter @quorum-on-near/protocol typecheck`

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol
git commit -m "encode quorum headers and build the 402 offer"
```


---

### Task 3: Signed delegate actions

A payment carries a Borsh-encoded NEP-366 SignedDelegate (spec section 6.3). It is decoded with near-api-js's schema and borsh 2. borsh 2.0.0 does not reject trailing bytes, and it does not check that strings are well-formed UTF-8, so `decodeSignedDelegate` re-encodes what it decoded and refuses the input unless the bytes are identical: the bytes the gateway verifies are exactly the bytes it relays. The signature covers `sha256(borsh_u32(2^30 + 366) ++ borsh(DelegateAction))`, the same hash near-api-js signs.

**Files:**
- Create: `packages/protocol/src/delegate.ts`
- Modify: `packages/protocol/src/index.ts`
- Test: `packages/protocol/test/delegate.test.ts`

**Interfaces:**
- Consumes: `NEP366_TAG` (Task 1).
- Produces: `type Bytes`, `interface DecodedFunctionCall {methodName, args, gas, deposit}`, `type DecodedAction`, `DecodedPublicKey`, `DecodedSignature`, `interface DecodedDelegateAction {senderId, receiverId, actions, nonce, maxBlockHeight, publicKey}`, `interface DecodedSignedDelegate {delegateAction, signature}`; `decodeSignedDelegate(bytes: Uint8Array): DecodedSignedDelegate`, `encodeSignedDelegate(signed): Uint8Array`, `delegateHash(action): Uint8Array`, `delegatePublicKey(action): string`, `verifyDelegateSignature(signed): boolean`, `onlyFunctionCall(action): DecodedFunctionCall | null`.

- [ ] **Step 1: Write the failing test**

`packages/protocol/test/delegate.test.ts`:

```typescript
import { sha256 } from '@noble/hashes/sha2.js';
import {
  type Action,
  KeyPair,
  KeyPairSigner,
  actions,
  buildDelegateAction,
  createTransaction,
  decodeTransaction,
  encodeDelegateAction,
  encodeSignedDelegate as nearEncodeSignedDelegate,
  encodeTransaction,
} from 'near-api-js';
import { describe, expect, it } from 'vitest';
import { commitMsg } from '../src/contract.ts';
import {
  type DecodedSignedDelegate,
  decodeSignedDelegate,
  delegateHash,
  delegatePublicKey,
  encodeSignedDelegate,
  onlyFunctionCall,
  verifyDelegateSignature,
} from '../src/delegate.ts';

const BUYER = 'buyer.testnet';
const TOKEN = 'token.testnet';
const POOLS = 'pools.parent.testnet';
const GAS = 50_000_000_000_000n;

function ascii(text: string): number[] {
  return [...Buffer.from(text, 'ascii')];
}

/** A fixed 32-byte ed25519 public key (bytes 1 to 32), with no secret key behind it. */
const PUBLIC_KEY = Array.from({ length: 32 }, (_, i) => i + 1);
/** An all-zero signature: decodeSignedDelegate does not verify signatures. */
const SIGNATURE = new Array<number>(64).fill(0);

/**
 * A DelegateAction laid out by hand from NEP-366 and nearcore's Borsh types (strings and vectors
 * have a u32 little-endian length, integers are little-endian), so that near-api-js is not its own
 * oracle.
 */
const DELEGATE_ACTION_BYTES = [
  // sender_id: AccountId, a string.
  13, 0, 0, 0, ...ascii(BUYER),
  // receiver_id: AccountId.
  13, 0, 0, 0, ...ascii(TOKEN),
  // actions: Vec<NonDelegateAction>, one action.
  1, 0, 0, 0,
  // Action::FunctionCall is variant 2.
  2,
  // method_name: String.
  4, 0, 0, 0, ...ascii('ping'),
  // args: Vec<u8>.
  2, 0, 0, 0, ...ascii('{}'),
  // gas: u64, 50 Tgas (0x2d79883d2000).
  0x00, 0x20, 0x3d, 0x88, 0x79, 0x2d, 0x00, 0x00,
  // deposit: u128, 1 yoctoNEAR.
  1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  // nonce: u64, 42.
  42, 0, 0, 0, 0, 0, 0, 0,
  // max_block_height: u64, 1,000,100 (0x0f42a4).
  0xa4, 0x42, 0x0f, 0x00, 0x00, 0x00, 0x00, 0x00,
  // public_key: KeyType::ED25519 (0), then 32 bytes.
  0, ...PUBLIC_KEY,
];
/** The SignedDelegateAction: the DelegateAction, then the signature, KeyType::ED25519 (0) and 64 bytes. */
const SIGNED_DELEGATE_BYTES = Uint8Array.from([...DELEGATE_ACTION_BYTES, 0, ...SIGNATURE]);
/** The fields of SIGNED_DELEGATE_BYTES, as decodeSignedDelegate returns them. */
const SIGNED_DELEGATE: DecodedSignedDelegate = {
  delegateAction: {
    senderId: BUYER,
    receiverId: TOKEN,
    actions: [{ functionCall: { methodName: 'ping', args: ascii('{}'), gas: GAS, deposit: 1n } }],
    nonce: 42n,
    maxBlockHeight: 1_000_100n,
    publicKey: { ed25519Key: { data: PUBLIC_KEY } },
  },
  signature: { ed25519Signature: { data: SIGNATURE } },
};

function commitCall(amount = '360'): Action {
  return actions.functionCall(
    'ft_transfer_call',
    { receiver_id: POOLS, amount, msg: commitMsg(7, 2) },
    GAS,
    1n,
  );
}

/** Builds and signs a delegate with near-api-js, the way a buyer's client does. */
async function signWithNear(keyPair: KeyPair, delegateActions: Action[] = [commitCall()]) {
  const delegateAction = buildDelegateAction({
    senderId: BUYER,
    receiverId: TOKEN,
    actions: delegateActions,
    nonce: 42n,
    maxBlockHeight: 1_000_100n,
    publicKey: keyPair.getPublicKey(),
  });
  const { signedDelegate } = await new KeyPairSigner(keyPair).signDelegateAction(delegateAction);
  return { delegateAction, bytes: nearEncodeSignedDelegate(signedDelegate) };
}

function withArgs(signed: DecodedSignedDelegate, args: Uint8Array): DecodedSignedDelegate {
  const call = onlyFunctionCall(signed.delegateAction);
  if (call === null) throw new Error('expected a FunctionCall');
  return {
    ...signed,
    delegateAction: { ...signed.delegateAction, actions: [{ functionCall: { ...call, args } }] },
  };
}

describe('decodeSignedDelegate', () => {
  it('decodes a delegate signed with near-api-js into its fields', async () => {
    const keyPair = KeyPair.fromRandom('ed25519');
    const { bytes } = await signWithNear(keyPair);

    const { delegateAction } = decodeSignedDelegate(bytes);

    expect(delegateAction.senderId).toBe(BUYER);
    expect(delegateAction.receiverId).toBe(TOKEN);
    expect(delegateAction.nonce).toBe(42n);
    expect(delegateAction.maxBlockHeight).toBe(1_000_100n);
    expect(onlyFunctionCall(delegateAction)).toMatchObject({
      methodName: 'ft_transfer_call',
      gas: GAS,
      deposit: 1n,
    });
  });

  it('decodes a SignedDelegate laid out by hand from NEP-366 into its fields', () => {
    expect(decodeSignedDelegate(SIGNED_DELEGATE_BYTES)).toEqual(SIGNED_DELEGATE);
  });

  it('re-encodes a decoded delegate to the identical bytes', async () => {
    const { bytes } = await signWithNear(KeyPair.fromRandom('ed25519'));

    expect(encodeSignedDelegate(decodeSignedDelegate(bytes))).toEqual(bytes);
  });

  it('throws on trailing bytes', async () => {
    const { bytes } = await signWithNear(KeyPair.fromRandom('ed25519'));

    expect(() => decodeSignedDelegate(new Uint8Array([...bytes, 0]))).toThrow();
  });

  it('throws on truncated input', async () => {
    const { bytes } = await signWithNear(KeyPair.fromRandom('ed25519'));

    expect(() => decodeSignedDelegate(bytes.subarray(0, bytes.length - 1))).toThrow();
  });

  it('throws on empty input', () => {
    expect(() => decodeSignedDelegate(new Uint8Array())).toThrow();
  });

  it('throws on a non-canonical encoding that decodes to the same fields', async () => {
    const { bytes } = await signWithNear(KeyPair.fromRandom('ed25519'));
    // senderId is a u32 length then UTF-8; 0xc1 0xa2 is an overlong form of its first letter, "b".
    const overlong = new Uint8Array([BUYER.length + 1, 0, 0, 0, 0xc1, 0xa2, ...bytes.subarray(5)]);

    expect(() => decodeSignedDelegate(overlong)).toThrow(/non-canonical/);
  });

  it('throws on a key type other than ed25519 or secp256k1', async () => {
    const { bytes } = await signWithNear(KeyPair.fromRandom('ml-dsa-65'));

    expect(() => decodeSignedDelegate(bytes)).toThrow(/key type/);
  });
});

describe('encodeSignedDelegate', () => {
  it('lays a SignedDelegate out as NEP-366 does, byte for byte', () => {
    expect(encodeSignedDelegate(SIGNED_DELEGATE)).toEqual(SIGNED_DELEGATE_BYTES);
  });
});

describe('delegateHash', () => {
  it('is sha256 of the NEP-366 tag 2^30 + 366 as a little-endian u32 (6e 01 00 40), then the DelegateAction', () => {
    const message = Uint8Array.from([0x6e, 0x01, 0x00, 0x40, ...DELEGATE_ACTION_BYTES]);

    expect(delegateHash(SIGNED_DELEGATE.delegateAction)).toEqual(sha256(message));
  });

  it('equals sha256 of near-api-js encodeDelegateAction', async () => {
    const { delegateAction, bytes } = await signWithNear(KeyPair.fromRandom('ed25519'));

    const decoded = decodeSignedDelegate(bytes);

    expect(delegateHash(decoded.delegateAction)).toEqual(sha256(encodeDelegateAction(delegateAction)));
  });
});

describe('delegatePublicKey', () => {
  it('matches the signing key pair public key string', async () => {
    const keyPair = KeyPair.fromRandom('ed25519');
    const { bytes } = await signWithNear(keyPair);

    expect(delegatePublicKey(decodeSignedDelegate(bytes).delegateAction)).toBe(
      keyPair.getPublicKey().toString(),
    );
  });

  it('formats a secp256k1 key with its prefix', async () => {
    const keyPair = KeyPair.fromRandom('secp256k1');
    const { bytes } = await signWithNear(keyPair);

    const publicKey = delegatePublicKey(decodeSignedDelegate(bytes).delegateAction);

    expect(publicKey).toBe(keyPair.getPublicKey().toString());
    expect(publicKey.startsWith('secp256k1:')).toBe(true);
  });
});

describe('verifyDelegateSignature', () => {
  it('accepts an ed25519 delegate signed with near-api-js', async () => {
    const { bytes } = await signWithNear(KeyPair.fromRandom('ed25519'));

    expect(verifyDelegateSignature(decodeSignedDelegate(bytes))).toBe(true);
  });

  it('accepts a secp256k1 delegate signed with near-api-js', async () => {
    const { bytes } = await signWithNear(KeyPair.fromRandom('secp256k1'));

    expect(verifyDelegateSignature(decodeSignedDelegate(bytes))).toBe(true);
  });

  it('rejects a delegate whose amount was changed after signing', async () => {
    const { bytes } = await signWithNear(KeyPair.fromRandom('ed25519'));
    const signed = decodeSignedDelegate(bytes);
    const args = new TextEncoder().encode(
      JSON.stringify({ receiver_id: POOLS, amount: '1', msg: commitMsg(7, 2) }),
    );

    expect(verifyDelegateSignature(withArgs(signed, args))).toBe(false);
  });

  it('rejects a delegate whose receiver was changed after signing', async () => {
    const { bytes } = await signWithNear(KeyPair.fromRandom('ed25519'));
    const signed = decodeSignedDelegate(bytes);
    const tampered = {
      ...signed,
      delegateAction: { ...signed.delegateAction, receiverId: 'other.testnet' },
    };

    expect(verifyDelegateSignature(tampered)).toBe(false);
  });

  it('rejects a signature made by another key over the same hash', async () => {
    const { bytes } = await signWithNear(KeyPair.fromRandom('ed25519'));
    const signed = decodeSignedDelegate(bytes);
    const other = KeyPair.fromRandom('ed25519').sign(delegateHash(signed.delegateAction)).signature;
    const forged = { ...signed, signature: { ed25519Signature: { data: other } } };

    expect(verifyDelegateSignature(forged)).toBe(false);
  });

  it('rejects a signature whose type does not match the key type', async () => {
    const { bytes } = await signWithNear(KeyPair.fromRandom('ed25519'));
    const signed = decodeSignedDelegate(bytes);
    const mismatched = { ...signed, signature: { secp256k1Signature: { data: new Uint8Array(65) } } };

    expect(verifyDelegateSignature(mismatched)).toBe(false);
  });

  it('returns false instead of throwing on a malformed signature', async () => {
    const { bytes } = await signWithNear(KeyPair.fromRandom('ed25519'));
    const signed = decodeSignedDelegate(bytes);
    const malformed = { ...signed, signature: { ed25519Signature: { data: [1, 2, 3] } } };

    expect(verifyDelegateSignature(malformed)).toBe(false);
  });
});

describe('onlyFunctionCall', () => {
  it('returns the FunctionCall of a single-action delegate', async () => {
    const { bytes } = await signWithNear(KeyPair.fromRandom('ed25519'));
    const call = onlyFunctionCall(decodeSignedDelegate(bytes).delegateAction);

    expect(call?.methodName).toBe('ft_transfer_call');
    expect(JSON.parse(new TextDecoder().decode(Uint8Array.from(call?.args ?? [])))).toEqual({
      receiver_id: POOLS,
      amount: '360',
      msg: commitMsg(7, 2),
    });
  });

  it('returns null for a delegate with no actions', async () => {
    const { bytes } = await signWithNear(KeyPair.fromRandom('ed25519'), []);

    expect(onlyFunctionCall(decodeSignedDelegate(bytes).delegateAction)).toBeNull();
  });

  it('returns null for a delegate with two actions', async () => {
    const { bytes } = await signWithNear(KeyPair.fromRandom('ed25519'), [commitCall(), commitCall()]);

    expect(onlyFunctionCall(decodeSignedDelegate(bytes).delegateAction)).toBeNull();
  });

  it('returns null for a delegate whose only action is a transfer', async () => {
    const { bytes } = await signWithNear(KeyPair.fromRandom('ed25519'), [actions.transfer(1n)]);

    expect(onlyFunctionCall(decodeSignedDelegate(bytes).delegateAction)).toBeNull();
  });
});

describe('near-api-js interoperability', () => {
  it('relays a decoded delegate through actions.signedDelegate and a Transaction round trip', async () => {
    const { bytes } = await signWithNear(KeyPair.fromRandom('ed25519'));
    const decoded = decodeSignedDelegate(bytes);
    const relayer = KeyPair.fromRandom('ed25519').getPublicKey();
    // near-api-js types the argument with its own classes; the plain decoded objects encode the same.
    const action = actions.signedDelegate(
      decoded as unknown as Parameters<typeof actions.signedDelegate>[0],
    );
    const tx = createTransaction('relay.parent.testnet', relayer, BUYER, 7n, [action], new Uint8Array(32));

    const relayed = decodeTransaction(encodeTransaction(tx)).actions[0]?.signedDelegate;

    if (relayed === undefined) throw new Error('expected a signedDelegate action');
    expect(nearEncodeSignedDelegate(relayed)).toEqual(bytes);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @quorum-on-near/protocol exec vitest run test/delegate.test.ts`

Expected: FAIL. vitest cannot load `../src/delegate.ts`, which does not exist yet.

- [ ] **Step 3: Write the implementation**

`packages/protocol/src/delegate.ts`:

```typescript
import { sha256 } from '@noble/hashes/sha2.js';
import { deserialize, serialize } from 'borsh';
import { KeyType, PublicKey, SCHEMA } from 'near-api-js';
import { NEP366_TAG } from './constants.ts';

/**
 * The NEP-366 signed delegate action as Borsh-decoded plain objects (near-api-js's SCHEMA, decoded
 * with borsh 2). Byte arrays decode as number arrays, u64 and u128 as bigint.
 */
export type Bytes = number[] | Uint8Array;
export interface DecodedFunctionCall {
  methodName: string;
  args: Bytes;
  gas: bigint;
  deposit: bigint;
}
/** One action: an object with exactly one key naming the variant, such as `{ functionCall: {...} }`. */
export type DecodedAction = { functionCall: DecodedFunctionCall } | Record<string, unknown>;
export type DecodedPublicKey = { ed25519Key: { data: Bytes } } | { secp256k1Key: { data: Bytes } };
export type DecodedSignature = { ed25519Signature: { data: Bytes } } | { secp256k1Signature: { data: Bytes } };
export interface DecodedDelegateAction {
  senderId: string;
  receiverId: string;
  actions: DecodedAction[];
  nonce: bigint;
  maxBlockHeight: bigint;
  publicKey: DecodedPublicKey;
}
export interface DecodedSignedDelegate {
  delegateAction: DecodedDelegateAction;
  signature: DecodedSignature;
}

/** Borsh-decodes a SignedDelegate. Throws on malformed input or trailing bytes. */
export function decodeSignedDelegate(bytes: Uint8Array): DecodedSignedDelegate {
  const signed = deserialize(SCHEMA.SignedDelegate, bytes) as DecodedSignedDelegate;
  // borsh stops at the end of the schema and ignores anything after it. Requiring the re-encoding
  // to match also rejects non-canonical input, so what is verified is exactly what gets relayed.
  if (!sameBytes(encodeSignedDelegate(signed), bytes)) {
    throw new Error('signed delegate has trailing bytes or a non-canonical encoding');
  }
  // The schema also decodes ML-DSA keys and signatures; the types above cover ed25519 and
  // secp256k1 only, and keyOf and signatureOf throw on anything else.
  keyOf(signed.delegateAction.publicKey);
  signatureOf(signed.signature);
  return signed;
}

/** Borsh-encodes a SignedDelegate (the inverse of decodeSignedDelegate). */
export function encodeSignedDelegate(signed: DecodedSignedDelegate): Uint8Array {
  return serialize(SCHEMA.SignedDelegate, signed);
}

/** The NEP-366 signable hash: sha256(borsh_u32(NEP366_TAG) ++ borsh(DelegateAction)). */
export function delegateHash(action: DecodedDelegateAction): Uint8Array {
  return sha256
    .create()
    .update(serialize('u32', NEP366_TAG))
    .update(serialize(SCHEMA.DelegateAction, action))
    .digest();
}

/** The signing key as `ed25519:<base58>` (or `secp256k1:<base58>`). */
export function delegatePublicKey(action: DecodedDelegateAction): string {
  return new PublicKey(keyOf(action.publicKey)).toString();
}

/** True when the signature is valid for the delegate's public key over delegateHash. Never throws. */
export function verifyDelegateSignature(signed: DecodedSignedDelegate): boolean {
  try {
    const key = keyOf(signed.delegateAction.publicKey);
    const signature = signatureOf(signed.signature);
    if (signature.keyType !== key.keyType) return false;
    return new PublicKey(key).verify(delegateHash(signed.delegateAction), signature.data);
  } catch {
    return false;
  }
}

/** The delegate's FunctionCall, or null unless it has exactly one action and that action is a FunctionCall. */
export function onlyFunctionCall(action: DecodedDelegateAction): DecodedFunctionCall | null {
  if (action.actions.length !== 1) return null;
  const only = action.actions[0];
  return only !== undefined && isFunctionCall(only) ? only.functionCall : null;
}

/** Key or signature bytes with their key type, as near-api-js's PublicKey constructor takes them. */
interface TypedBytes {
  keyType: KeyType;
  data: Uint8Array;
}

function keyOf(publicKey: DecodedPublicKey): TypedBytes {
  if ('ed25519Key' in publicKey) {
    return { keyType: KeyType.ED25519, data: Uint8Array.from(publicKey.ed25519Key.data) };
  }
  if ('secp256k1Key' in publicKey) {
    return { keyType: KeyType.SECP256K1, data: Uint8Array.from(publicKey.secp256k1Key.data) };
  }
  throw new Error('unsupported key type');
}

function signatureOf(signature: DecodedSignature): TypedBytes {
  if ('ed25519Signature' in signature) {
    return { keyType: KeyType.ED25519, data: Uint8Array.from(signature.ed25519Signature.data) };
  }
  if ('secp256k1Signature' in signature) {
    return { keyType: KeyType.SECP256K1, data: Uint8Array.from(signature.secp256k1Signature.data) };
  }
  throw new Error('unsupported signature key type');
}

function isFunctionCall(action: DecodedAction): action is { functionCall: DecodedFunctionCall } {
  return 'functionCall' in action;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}
```

`packages/protocol/src/index.ts`:

```typescript
export * from './constants.ts';
export * from './account.ts';
export * from './contract.ts';
export * from './amounts.ts';
export * from './codec.ts';
export * from './offer.ts';
export * from './delegate.ts';
```

- [ ] **Step 4: Run the tests and the typecheck**

Run: `pnpm --filter @quorum-on-near/protocol exec vitest run test/delegate.test.ts`

Expected: PASS, 25 tests (`test/delegate.test.ts` 25).

Run: `pnpm --filter @quorum-on-near/protocol typecheck`

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol
git commit -m "decode signed delegate actions and verify their signatures"
```


---

### Task 4: NEP-413 redemption proofs

A buyer redeems with an NEP-413 signed message (spec section 6.5). This task checks everything about a proof that needs no chain access; the full-access check is the gateway's (Task 12). Fields must be in their canonical forms (standard padded base64, `ed25519:<base58>` keys), so that each nonce has one spelling for the replay cache.

**Files:**
- Create: `packages/protocol/src/nep413.ts`
- Modify: `packages/protocol/src/index.ts`
- Test: `packages/protocol/test/nep413.test.ts`

**Interfaces:**
- Consumes: `isAccountId`, `NEP413_TAG`, `REDEEM_MAX_AGE_MS`, `REDEEM_MAX_SKEW_MS` (Task 1); `decodeHeader` (Task 2).
- Produces: `interface Nep413Payload`, `nep413Hash(payload): Uint8Array`, `interface RedeemProof {accountId, publicKey, signature, message, nonce, recipient}`, `redeemMessage(poolId: number): string`, `nonceTimeMs(nonce: Uint8Array): number`, `type ProofErrorCode`, `type ProofCheck`, `checkRedeemProof(header: string, expected: {poolId, recipient, nowMs, maxAgeMs?}): ProofCheck`.

- [ ] **Step 1: Write the failing test**

`packages/protocol/test/nep413.test.ts`:

```typescript
import { randomBytes } from 'node:crypto';
import { sha256 } from '@noble/hashes/sha2.js';
import { KeyPair, KeyPairSigner } from 'near-api-js';
import { describe, expect, it } from 'vitest';
import { encodeHeader } from '../src/codec.ts';
import { REDEEM_MAX_AGE_MS, REDEEM_MAX_SKEW_MS } from '../src/constants.ts';
import { checkRedeemProof, nep413Hash, nonceTimeMs, redeemMessage } from '../src/nep413.ts';
import type { RedeemProof } from '../src/nep413.ts';

const ACCOUNT = 'buyer.testnet';
const RECIPIENT = 'localhost:8402';
const POOL_ID = 7;
const NOW_MS = 1_800_000_000_000;

function nonceAt(signedAtMs: number): Uint8Array {
  const nonce = new Uint8Array(32);
  new DataView(nonce.buffer).setBigUint64(0, BigInt(signedAtMs));
  nonce.set(randomBytes(24), 8);
  return nonce;
}

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function ascii(text: string): number[] {
  return [...Buffer.from(text, 'ascii')];
}

/** A fixed nonce, bytes 0 to 31. */
const FIXED_NONCE = Array.from({ length: 32 }, (_, i) => i);
/**
 * The hashed message up to its callbackUrl, laid out by hand from NEP-413 so that near-api-js is not
 * its own oracle: the tag, then the Borsh fields of a payload of `quorum:redeem:7` for RECIPIENT (a
 * string is a u32 little-endian length then UTF-8; the nonce is a fixed-size array, with no length).
 */
const SIGNED_MESSAGE_START = [
  // The tag.
  0x9d, 0x01, 0x00, 0x80,
  // message: string.
  15, 0, 0, 0, ...ascii('quorum:redeem:7'),
  // nonce: [u8; 32].
  ...FIXED_NONCE,
  // recipient: string.
  14, 0, 0, 0, ...ascii(RECIPIENT),
];

/** Changes a base64 character's two low bits, which a 32-byte value's last character does not use. */
function flipLowBits(char: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  return alphabet[alphabet.indexOf(char) ^ 0b01]!;
}

interface ProofOptions {
  keyPair?: KeyPair;
  message?: string;
  recipient?: string;
  signedAtMs?: number;
  nonce?: Uint8Array;
}

/** Signs a redemption proof with near-api-js directly, as a wallet would. */
async function signProof(options: ProofOptions = {}): Promise<RedeemProof> {
  const keyPair = options.keyPair ?? KeyPair.fromRandom('ed25519');
  const message = options.message ?? redeemMessage(POOL_ID);
  const recipient = options.recipient ?? RECIPIENT;
  const nonce = options.nonce ?? nonceAt(options.signedAtMs ?? NOW_MS - 1_000);
  const signed = await new KeyPairSigner(keyPair).signNep413Message(ACCOUNT, { message, recipient, nonce });
  return {
    accountId: signed.accountId,
    publicKey: signed.publicKey.toString(),
    signature: base64(signed.signature),
    message,
    nonce: base64(nonce),
    recipient,
  };
}

function check(proof: unknown, overrides: { nowMs?: number; maxAgeMs?: number } = {}) {
  return checkRedeemProof(encodeHeader(proof), { poolId: POOL_ID, recipient: RECIPIENT, nowMs: NOW_MS, ...overrides });
}

describe('nep413Hash', () => {
  it('is sha256 of the NEP-413 tag 2^31 + 413 as a little-endian u32 (9d 01 00 80), then the payload', () => {
    const payload = { message: 'quorum:redeem:7', nonce: Uint8Array.from(FIXED_NONCE), recipient: RECIPIENT };

    // callbackUrl: Option<string>, None.
    expect(nep413Hash(payload)).toEqual(sha256(Uint8Array.from([...SIGNED_MESSAGE_START, 0])));
  });

  it('lays out a callbackUrl as Some (1), then the string', () => {
    const callbackUrl = 'https://example.com/cb';
    const payload = { message: 'quorum:redeem:7', nonce: Uint8Array.from(FIXED_NONCE), recipient: RECIPIENT, callbackUrl };
    const message = [...SIGNED_MESSAGE_START, 1, 22, 0, 0, 0, ...ascii(callbackUrl)];

    expect(nep413Hash(payload)).toEqual(sha256(Uint8Array.from(message)));
  });

  it('is the hash near-api-js signs, so its signature verifies against it', async () => {
    const keyPair = KeyPair.fromRandom('ed25519');
    const payload = { message: 'quorum:redeem:3', recipient: RECIPIENT, nonce: nonceAt(NOW_MS) };
    const signed = await new KeyPairSigner(keyPair).signNep413Message(ACCOUNT, payload);

    expect(signed.publicKey.verify(nep413Hash(payload), signed.signature)).toBe(true);
  });

  it('is the hash near-api-js signs when a callbackUrl is given', async () => {
    const keyPair = KeyPair.fromRandom('ed25519');
    const payload = { message: 'm', recipient: RECIPIENT, nonce: nonceAt(NOW_MS), callbackUrl: 'https://example.com/cb' };
    const signed = await new KeyPairSigner(keyPair).signNep413Message(ACCOUNT, payload);

    expect(signed.publicKey.verify(nep413Hash(payload), signed.signature)).toBe(true);
  });

  it('treats a null callbackUrl as absent', () => {
    const payload = { message: 'm', recipient: RECIPIENT, nonce: nonceAt(NOW_MS) };

    expect(nep413Hash({ ...payload, callbackUrl: null })).toEqual(nep413Hash(payload));
  });

  it('changes when the callbackUrl is set', () => {
    const payload = { message: 'm', recipient: RECIPIENT, nonce: nonceAt(NOW_MS) };

    expect(nep413Hash({ ...payload, callbackUrl: 'https://example.com/cb' })).not.toEqual(nep413Hash(payload));
  });
});

describe('redeemMessage', () => {
  it('is quorum:redeem: followed by the pool id', () => {
    expect(redeemMessage(42)).toBe('quorum:redeem:42');
  });
});

describe('nonceTimeMs', () => {
  it('reads the first 8 bytes as big-endian milliseconds', () => {
    const nonce = new Uint8Array(32).fill(0xff);
    nonce.set([0x00, 0x00, 0x01, 0x8f, 0x2a, 0x3b, 0x4c, 0x5d]);

    expect(nonceTimeMs(nonce)).toBe(0x018f_2a3b_4c5d);
  });

  it('reads a nonce that is a view into a larger buffer', () => {
    const backing = new Uint8Array(48).fill(0xff);
    backing.set([0, 0, 0, 0, 0, 0, 0x01, 0x02], 8);

    expect(nonceTimeMs(backing.subarray(8, 40))).toBe(0x0102);
  });
});

describe('checkRedeemProof', () => {
  it('accepts a fresh proof and returns the account, the key and the signing time', async () => {
    const keyPair = KeyPair.fromRandom('ed25519');
    const proof = await signProof({ keyPair, signedAtMs: NOW_MS - 2_000 });

    expect(check(proof)).toEqual({
      ok: true,
      accountId: ACCOUNT,
      publicKey: keyPair.getPublicKey().toString(),
      nonceKey: proof.nonce,
      signedAtMs: NOW_MS - 2_000,
    });
  });

  it('accepts a proof signed with a secp256k1 key', async () => {
    const keyPair = KeyPair.fromRandom('secp256k1');
    const result = check(await signProof({ keyPair }));

    expect(result.ok && result.publicKey).toBe(keyPair.getPublicKey().toString());
  });

  it('returns the nonce in standard base64 as nonceKey', async () => {
    const nonce = nonceAt(NOW_MS);
    nonce.set([0xfb, 0xff, 0xbf], 8);
    const result = check(await signProof({ nonce }));

    expect(result.ok && result.nonceKey).toBe(Buffer.from(nonce).toString('base64'));
  });

  it('rejects a header that is not base64 JSON as invalid_proof', () => {
    const result = checkRedeemProof('not a proof', { poolId: POOL_ID, recipient: RECIPIENT, nowMs: NOW_MS });

    expect(result).toEqual({ ok: false, code: 'invalid_proof' });
  });

  it.each([[null], [42], ['proof'], [[1, 2]]])('rejects the JSON value %j as invalid_proof', (value) => {
    expect(check(value)).toEqual({ ok: false, code: 'invalid_proof' });
  });

  it.each(['accountId', 'publicKey', 'signature', 'message', 'nonce', 'recipient'] as const)(
    'rejects a proof without %s as invalid_proof',
    async (field) => {
      const proof: Partial<RedeemProof> = await signProof();
      delete proof[field];

      expect(check(proof)).toEqual({ ok: false, code: 'invalid_proof' });
    },
  );

  it.each<[string, (proof: RedeemProof) => unknown]>([
    ['a nonce that is not a string', (p) => ({ ...p, nonce: [...Buffer.from(p.nonce, 'base64')] })],
    ['a 31-byte nonce', (p) => ({ ...p, nonce: base64(Buffer.from(p.nonce, 'base64').subarray(0, 31)) })],
    ['a 33-byte nonce', (p) => ({ ...p, nonce: base64(Buffer.concat([Buffer.from(p.nonce, 'base64'), Buffer.of(0)])) })],
    ['a nonce in URL-safe base64', (p) => ({ ...p, nonce: Buffer.from(p.nonce, 'base64').toString('base64url') })],
    ['a nonce with unused bits set', (p) => ({ ...p, nonce: `${p.nonce.slice(0, 42)}${flipLowBits(p.nonce[42]!)}=` })],
    ['a signature that is not base64', (p) => ({ ...p, signature: `${p.signature.slice(1)}!` })],
    ['a public key that is not base58', (p) => ({ ...p, publicKey: 'ed25519:0OIl' })],
    ['a public key without its type prefix', (p) => ({ ...p, publicKey: p.publicKey.slice('ed25519:'.length) })],
    ['a public key of an unknown type', (p) => ({ ...p, publicKey: p.publicKey.replace('ed25519:', 'rsa:') })],
    ['a public key of the wrong length', (p) => ({ ...p, publicKey: p.publicKey.slice(0, -4) })],
    [
      'an ed25519 prefix on a 64-byte key, which near-api-js reads as secp256k1',
      (p) => ({ ...p, publicKey: KeyPair.fromRandom('secp256k1').getPublicKey().toString().replace('secp256k1:', 'ed25519:') }),
    ],
    ['an account id that NEAR does not allow', (p) => ({ ...p, accountId: 'Buyer.testnet' })],
    ['a one-character account id', (p) => ({ ...p, accountId: 'b' })],
  ])('rejects %s as invalid_proof', async (_name, mutate) => {
    expect(check(mutate(await signProof()))).toEqual({ ok: false, code: 'invalid_proof' });
  });

  it('rejects a proof for another pool as wrong_message', async () => {
    const proof = await signProof({ message: redeemMessage(POOL_ID + 1) });

    expect(check(proof)).toEqual({ ok: false, code: 'wrong_message' });
  });

  it('rejects a proof for another gateway as wrong_recipient', async () => {
    const proof = await signProof({ recipient: 'gateway.example.com' });

    expect(check(proof)).toEqual({ ok: false, code: 'wrong_recipient' });
  });

  it('rejects a proof exactly REDEEM_MAX_AGE_MS old as stale_proof', async () => {
    const proof = await signProof({ signedAtMs: NOW_MS - REDEEM_MAX_AGE_MS });

    expect(check(proof)).toEqual({ ok: false, code: 'stale_proof' });
  });

  it('accepts a proof just under REDEEM_MAX_AGE_MS old', async () => {
    const proof = await signProof({ signedAtMs: NOW_MS - REDEEM_MAX_AGE_MS + 1 });

    expect(check(proof).ok).toBe(true);
  });

  it('uses the maxAgeMs it is given in place of REDEEM_MAX_AGE_MS', async () => {
    const proof = await signProof({ signedAtMs: NOW_MS - 1_000 });

    expect(check(proof, { maxAgeMs: 1_000 })).toEqual({ ok: false, code: 'stale_proof' });
    expect(check(proof, { maxAgeMs: 1_001 }).ok).toBe(true);
  });

  it('accepts a proof signed REDEEM_MAX_SKEW_MS ahead of the clock', async () => {
    const proof = await signProof({ signedAtMs: NOW_MS + REDEEM_MAX_SKEW_MS });

    expect(check(proof).ok).toBe(true);
  });

  it('rejects a proof signed more than REDEEM_MAX_SKEW_MS ahead of the clock as stale_proof', async () => {
    const proof = await signProof({ signedAtMs: NOW_MS + REDEEM_MAX_SKEW_MS + 1 });

    expect(check(proof)).toEqual({ ok: false, code: 'stale_proof' });
  });

  it('rejects any proof as stale_proof when the clock reads NaN', async () => {
    const proof = await signProof();

    expect(check(proof, { nowMs: Number.NaN })).toEqual({ ok: false, code: 'stale_proof' });
  });

  it('rejects a proof signed by another key as invalid_signature', async () => {
    const proof = await signProof();
    const other = KeyPair.fromRandom('ed25519').getPublicKey().toString();

    expect(check({ ...proof, publicKey: other })).toEqual({ ok: false, code: 'invalid_signature' });
  });

  it('rejects a proof whose nonce changed after signing as invalid_signature', async () => {
    const proof = await signProof();
    const nonce = Buffer.from(proof.nonce, 'base64');
    nonce[31] = nonce[31]! ^ 0x01;

    expect(check({ ...proof, nonce: base64(nonce) })).toEqual({ ok: false, code: 'invalid_signature' });
  });

  it('rejects a signature of the wrong length as invalid_signature', async () => {
    const proof = await signProof();
    const signature = base64(Buffer.from(proof.signature, 'base64').subarray(0, 63));

    expect(check({ ...proof, signature })).toEqual({ ok: false, code: 'invalid_signature' });
  });

  it('reports the first failure in the order message, recipient, age, signature', async () => {
    const badSignature = base64(new Uint8Array(64));
    const sign = async (options: ProofOptions) => check({ ...(await signProof(options)), signature: badSignature });

    expect(await sign({ message: 'other', recipient: 'other', signedAtMs: 0 })).toEqual({ ok: false, code: 'wrong_message' });
    expect(await sign({ recipient: 'other', signedAtMs: 0 })).toEqual({ ok: false, code: 'wrong_recipient' });
    expect(await sign({ signedAtMs: 0 })).toEqual({ ok: false, code: 'stale_proof' });
    expect(await sign({})).toEqual({ ok: false, code: 'invalid_signature' });
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @quorum-on-near/protocol exec vitest run test/nep413.test.ts`

Expected: FAIL. vitest cannot load `../src/nep413.ts`, which does not exist yet.

- [ ] **Step 3: Write the implementation**

`packages/protocol/src/nep413.ts`:

```typescript
import { sha256 } from '@noble/hashes/sha2.js';
import { serialize } from 'borsh';
import type { Schema } from 'borsh';
import { PublicKey } from 'near-api-js';
import { isAccountId } from './account.ts';
import { decodeHeader } from './codec.ts';
import { NEP413_TAG, REDEEM_MAX_AGE_MS, REDEEM_MAX_SKEW_MS } from './constants.ts';

/** An NEP-413 payload. `nonce` is exactly 32 bytes. */
export interface Nep413Payload {
  message: string;
  nonce: Uint8Array;
  recipient: string;
  callbackUrl?: string | null;
}

const PAYLOAD_SCHEMA: Schema = {
  struct: {
    message: 'string',
    nonce: { array: { type: 'u8', len: 32 } },
    recipient: 'string',
    callbackUrl: { option: 'string' },
  },
};
const NONCE_BYTES = 32;

/** sha256(borsh_u32(NEP413_TAG) ++ borsh({message, nonce: [u8; 32], recipient, callbackUrl: Option<string>})). */
export function nep413Hash(payload: Nep413Payload): Uint8Array {
  const { message, nonce, recipient, callbackUrl } = payload;
  return sha256
    .create()
    .update(serialize('u32', NEP413_TAG))
    .update(serialize(PAYLOAD_SCHEMA, { message, nonce, recipient, callbackUrl: callbackUrl ?? null }))
    .digest();
}

/** The decoded `X-QUORUM-PROOF` header. `signature` and `nonce` are standard base64. */
export interface RedeemProof {
  accountId: string;
  publicKey: string;
  signature: string;
  message: string;
  nonce: string;
  recipient: string;
}

/** `quorum:redeem:<poolId>`. */
export function redeemMessage(poolId: number): string {
  return `quorum:redeem:${poolId}`;
}

/** The signing time in the first 8 bytes of a proof nonce (big-endian milliseconds). */
export function nonceTimeMs(nonce: Uint8Array): number {
  return Number(new DataView(nonce.buffer, nonce.byteOffset, nonce.byteLength).getBigUint64(0));
}

export type ProofErrorCode = 'invalid_proof' | 'wrong_message' | 'wrong_recipient' | 'stale_proof' | 'invalid_signature';

export type ProofCheck =
  | { ok: true; accountId: string; publicKey: string; nonceKey: string; signedAtMs: number }
  | { ok: false; code: ProofErrorCode };

/**
 * Checks an `X-QUORUM-PROOF` header without network access. It decodes; the message is
 * `quorum:redeem:<poolId>`; the recipient matches; the nonce is 32 bytes and its time is less than
 * `maxAgeMs` (default REDEEM_MAX_AGE_MS) before `nowMs` and at most REDEEM_MAX_SKEW_MS after it; and
 * the signature is valid for `publicKey` over nep413Hash. `nonceKey` is the nonce in base64, for a
 * replay cache. The full-access check needs the chain, so it is the caller's. Never throws.
 */
export function checkRedeemProof(
  header: string,
  expected: { poolId: number; recipient: string; nowMs: number; maxAgeMs?: number },
): ProofCheck {
  const parsed = parseProof(header);
  if (parsed === null) return { ok: false, code: 'invalid_proof' };
  const { proof, publicKey, signature, nonce } = parsed;
  if (proof.message !== redeemMessage(expected.poolId)) return { ok: false, code: 'wrong_message' };
  if (proof.recipient !== expected.recipient) return { ok: false, code: 'wrong_recipient' };

  const signedAtMs = nonceTimeMs(nonce);
  const maxAgeMs = expected.maxAgeMs ?? REDEEM_MAX_AGE_MS;
  // Written as a positive condition so that a NaN clock fails closed.
  const fresh = expected.nowMs - signedAtMs < maxAgeMs && signedAtMs - expected.nowMs <= REDEEM_MAX_SKEW_MS;
  if (!fresh) return { ok: false, code: 'stale_proof' };

  const hash = nep413Hash({ message: proof.message, nonce, recipient: proof.recipient });
  if (!verifies(publicKey, hash, signature)) return { ok: false, code: 'invalid_signature' };
  return { ok: true, accountId: proof.accountId, publicKey: proof.publicKey, nonceKey: proof.nonce, signedAtMs };
}

interface ParsedProof {
  proof: RedeemProof;
  publicKey: PublicKey;
  signature: Uint8Array;
  nonce: Uint8Array;
}

/**
 * Decodes the header into a proof whose fields are all well formed: a valid account id, a public
 * key in its canonical `<type>:<base58>` form, and canonical standard base64 for the signature and
 * the 32-byte nonce. Canonical forms make `publicKey` and `nonceKey` unique per key and per nonce.
 */
function parseProof(header: string): ParsedProof | null {
  let value: unknown;
  try {
    value = decodeHeader(header);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const { accountId, publicKey, signature, message, nonce, recipient } = value as Record<string, unknown>;
  if (
    typeof accountId !== 'string' ||
    typeof publicKey !== 'string' ||
    typeof signature !== 'string' ||
    typeof message !== 'string' ||
    typeof nonce !== 'string' ||
    typeof recipient !== 'string'
  ) {
    return null;
  }
  if (!isAccountId(accountId)) return null;
  const key = parsePublicKey(publicKey);
  const signatureBytes = decodeBase64(signature);
  const nonceBytes = decodeBase64(nonce);
  if (key === null || signatureBytes === null || nonceBytes?.length !== NONCE_BYTES) return null;
  return {
    proof: { accountId, publicKey, signature, message, nonce, recipient },
    publicKey: key,
    signature: signatureBytes,
    nonce: nonceBytes,
  };
}

function parsePublicKey(text: string): PublicKey | null {
  try {
    const key = PublicKey.fromString(text);
    return key.toString() === text ? key : null;
  } catch {
    return null;
  }
}

/** Standard base64 with padding; null unless `text` is exactly the encoding of the bytes it decodes to. */
function decodeBase64(text: string): Uint8Array | null {
  const bytes = Buffer.from(text, 'base64');
  return bytes.toString('base64') === text ? new Uint8Array(bytes) : null;
}

function verifies(publicKey: PublicKey, hash: Uint8Array, signature: Uint8Array): boolean {
  try {
    return publicKey.verify(hash, signature);
  } catch {
    return false;
  }
}
```

`packages/protocol/src/index.ts`:

```typescript
export * from './constants.ts';
export * from './account.ts';
export * from './contract.ts';
export * from './amounts.ts';
export * from './codec.ts';
export * from './offer.ts';
export * from './delegate.ts';
export * from './nep413.ts';
```

- [ ] **Step 4: Run the tests and the typecheck**

Run: `pnpm --filter @quorum-on-near/protocol exec vitest run test/nep413.test.ts`

Expected: PASS, 48 tests (`test/nep413.test.ts` 48).

Run: `pnpm --filter @quorum-on-near/protocol typecheck`

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol
git commit -m "check NEP-413 redemption proofs"
```


---

### Task 5: Static payment checks and the buyer builders

Rows 1 to 3 of spec section 6.4, in order, as one pure function, and the builders a buyer uses to make what those checks accept. A payment may commit to any number of seats from 1 to the seats of its request, so a buyer that pays an offer reduced to `extra.seats` at the URL it first requested is accepted. The `ft_transfer_call` arguments must be compact JSON, which also refuses duplicated keys (the token's deserializer would refuse them on chain, at the relayer's cost). A buyer attaches the offer's `maxGas` unless told otherwise: unused gas is refunded to the relayer. Before signing, the builder checks the offer against the buyer's own configuration (network, token, pools contract), its request (the pool, at most the seats asked for) and its budget, and that the amount is exactly the seats' price, since the offer names where the tokens go and what they buy; it refuses any other offer and signs nothing.

**Files:**
- Create: `packages/protocol/src/checks.ts`, `packages/protocol/src/client.ts`
- Modify: `packages/protocol/src/index.ts`
- Test: `packages/protocol/test/checks.test.ts`, `packages/protocol/test/client.test.ts`

**Interfaces:**
- Consumes: `isAccountId`, `parseAmount`, `priceOf`, `commitMsg`, the constants (Task 1); `decodeHeader`, `encodeHeader`, `Offer` (Task 2); `decodeSignedDelegate`, `delegatePublicKey`, `onlyFunctionCall`, `verifyDelegateSignature` (Task 3); `RedeemProof`, `redeemMessage` (Task 4).
- Produces: `type StaticErrorCode`, `GatewayErrorCode` (`not_full_access`, `stale_nonce`, `nonce_too_large`, `expired`, `pool_closed`, `insufficient_balance`, `seller_commit`, `over_buyer_cap`, `payment_in_flight`), `PaymentErrorCode`; `interface ExpectedPayment {network, token, poolsContract, poolId, maxSeats, seatPrice, minGas, maxGas}`, `interface CheckedPayment {signedDelegate, senderId, publicKey, nonce, maxBlockHeight, gas, amount, poolId, seats}`, `type StaticCheckResult`, `checkPaymentHeader(header: string, expected: ExpectedPayment): StaticCheckResult`; `interface ExpectedOffer` (`network`, `token`, `poolsContract`: the buyer's own configuration; `poolId`, `maxSeats`: its request; `maxAmount: bigint`: its budget for this payment), `type OfferErrorCode` (in the order checked: `wrong_scheme`, `wrong_network`, `wrong_asset`, `wrong_pay_to`, `invalid_offer`, `wrong_pool`, `too_many_seats`, `wrong_amount`, `over_budget`), `interface OfferRefusal {code, detail}`, `checkOffer(offer: Offer, expected: ExpectedOffer): OfferRefusal | null`, `class OfferRefusedError` (`code`); `interface PaymentInput {keyPair, senderId, nonce, maxBlockHeight, offer, expected, gas?}`, `buildPaymentHeader(input): Promise<string>` (throws `OfferRefusedError`, signing nothing, when `checkOffer` refuses the offer), `maxBlockHeightFor(finalHeight: bigint, maxTimeoutSeconds: number, blockTimeMs: number): bigint`, `interface ProofInput {keyPair, accountId, poolId, recipient, nowMs, random?}`, `buildRedeemProofHeader(input): Promise<string>`.

- [ ] **Step 1: Write the failing tests**

`packages/protocol/test/checks.test.ts`:

```typescript
import {
  type Action,
  KeyPair,
  KeyPairSigner,
  actions,
  buildDelegateAction,
  encodeSignedDelegate as nearEncodeSignedDelegate,
} from 'near-api-js';
import { describe, expect, it } from 'vitest';
import { checkPaymentHeader } from '../src/checks.ts';
import type { CheckedPayment, ExpectedPayment, StaticErrorCode } from '../src/checks.ts';
import { buildPaymentHeader } from '../src/client.ts';
import type { ExpectedOffer } from '../src/client.ts';
import { decodeHeader, encodeHeader } from '../src/codec.ts';
import type { PaymentPayload } from '../src/codec.ts';
import { commitMsg } from '../src/contract.ts';
import type { PoolView } from '../src/contract.ts';
import { decodeSignedDelegate, delegateHash, encodeSignedDelegate } from '../src/delegate.ts';
import { buildOffer } from '../src/offer.ts';

const NETWORK = 'near:testnet';
const TOKEN = 'usdc.testnet';
const POOLS = 'pools.parent.testnet';
const BUYER = 'buyer.testnet';
const POOL_ID = 7;
const SEATS = 2;
const AMOUNT = '360';
const MIN_GAS = 50_000_000_000_000n;
const MAX_GAS = 100_000_000_000_000n;
const NONCE = 42n;
const MAX_BLOCK_HEIGHT = 1_000_100n;

const POOL: PoolView = {
  id: POOL_ID,
  seller: 'provider.parent.testnet',
  seat_price: '180',
  target: 192,
  taken: 148,
  deadline_ms: 1_800_000_000_000,
  bonus: '1728',
  max_seats_per_buyer: null,
  terms: '8 GPUs for 24 h; 1 seat = 1 GPU-hour',
  status: 'open',
  bonus_per_seat: '0',
  refund_cursor: 0,
  dust_sent: false,
  buyer_count: 30,
};
const OFFER = buildOffer(POOL, SEATS, {
  network: NETWORK,
  gatewayUrl: 'http://localhost:8402',
  poolsContract: POOLS,
  token: TOKEN,
  relayer: 'relay.parent.testnet',
  minGas: MIN_GAS,
  maxGas: MAX_GAS,
  maxTimeoutSeconds: 120,
});
const EXPECTED: ExpectedPayment = {
  network: NETWORK,
  token: TOKEN,
  poolsContract: POOLS,
  poolId: POOL_ID,
  maxSeats: SEATS,
  seatPrice: 180n,
  minGas: MIN_GAS,
  maxGas: MAX_GAS,
};
/** What the buyer requires of the offer it signs: the same contracts, pool and seats, for at most their price. */
const BUYER_CONFIG: ExpectedOffer = {
  network: NETWORK,
  token: TOKEN,
  poolsContract: POOLS,
  poolId: POOL_ID,
  maxSeats: SEATS,
  maxAmount: BigInt(AMOUNT),
};

function check(header: string): ReturnType<typeof checkPaymentHeader> {
  return checkPaymentHeader(header, EXPECTED);
}

/** The code of the first failing check, or `ok`. */
function codeOf(header: string): StaticErrorCode | 'ok' {
  const result = check(header);
  return result.ok ? 'ok' : result.code;
}

function paymentOf(header: string): CheckedPayment {
  const result = check(header);
  if (!result.ok) throw new Error(`expected a valid payment, got ${result.code}: ${result.detail}`);
  return result.payment;
}

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

/** The Borsh bytes inside an `X-PAYMENT` header. */
function signedDelegateBytes(header: string): Uint8Array {
  const { payload } = decodeHeader(header) as PaymentPayload;
  return new Uint8Array(Buffer.from(payload.signedDelegate, 'base64'));
}

function buyerHeader(gas?: bigint): Promise<string> {
  return buildPaymentHeader({
    keyPair: KeyPair.fromRandom('ed25519'),
    senderId: BUYER,
    nonce: NONCE,
    maxBlockHeight: MAX_BLOCK_HEIGHT,
    offer: OFFER,
    expected: BUYER_CONFIG,
    gas,
  });
}

function commitArgs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { receiver_id: POOLS, amount: AMOUNT, msg: commitMsg(POOL_ID, SEATS), ...overrides };
}

interface CallOptions {
  methodName?: string;
  /** An object is sent as JSON; bytes are sent as they are. */
  args?: object | Uint8Array;
  gas?: bigint;
  deposit?: bigint;
}

function commitCall(options: CallOptions = {}): Action {
  return actions.functionCall(
    options.methodName ?? 'ft_transfer_call',
    options.args ?? commitArgs(),
    options.gas ?? MIN_GAS,
    options.deposit ?? 1n,
  );
}

interface DelegateOptions {
  keyPair?: KeyPair;
  senderId?: string;
  receiverId?: string;
  actions?: Action[];
}

/** Builds and signs a delegate with near-api-js directly, so that it can be made wrong in one way. */
async function signDelegate(options: DelegateOptions = {}): Promise<Uint8Array> {
  const keyPair = options.keyPair ?? KeyPair.fromRandom('ed25519');
  const delegateAction = buildDelegateAction({
    senderId: options.senderId ?? BUYER,
    receiverId: options.receiverId ?? TOKEN,
    actions: options.actions ?? [commitCall()],
    nonce: NONCE,
    maxBlockHeight: MAX_BLOCK_HEIGHT,
    publicKey: keyPair.getPublicKey(),
  });
  const { signedDelegate } = await new KeyPairSigner(keyPair).signDelegateAction(delegateAction);
  return nearEncodeSignedDelegate(signedDelegate);
}

function paymentHeader(signedDelegate: string, overrides: Record<string, unknown> = {}): string {
  return encodeHeader({ x402Version: 1, scheme: 'quorum', network: NETWORK, payload: { signedDelegate }, ...overrides });
}

async function delegateHeader(options: DelegateOptions = {}): Promise<string> {
  return paymentHeader(base64(await signDelegate(options)));
}

function callHeader(options: CallOptions): Promise<string> {
  return delegateHeader({ actions: [commitCall(options)] });
}

function argsHeader(overrides: Record<string, unknown>): Promise<string> {
  return callHeader({ args: commitArgs(overrides) });
}

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe('checkPaymentHeader', () => {
  describe('a valid payment', () => {
    it('accepts a payment built by buildPaymentHeader and returns all of its fields', async () => {
      const keyPair = KeyPair.fromRandom('ed25519');
      const header = await buildPaymentHeader({
        keyPair,
        senderId: BUYER,
        nonce: NONCE,
        maxBlockHeight: MAX_BLOCK_HEIGHT,
        offer: OFFER,
        expected: BUYER_CONFIG,
      });

      expect(paymentOf(header)).toEqual({
        signedDelegate: decodeSignedDelegate(signedDelegateBytes(header)),
        senderId: BUYER,
        publicKey: keyPair.getPublicKey().toString(),
        nonce: NONCE,
        maxBlockHeight: MAX_BLOCK_HEIGHT,
        gas: MAX_GAS,
        amount: 360n,
        poolId: POOL_ID,
        seats: SEATS,
      });
    });

    it('returns a signed delegate that re-encodes to the bytes in the header', async () => {
      const header = await buyerHeader();

      expect(encodeSignedDelegate(paymentOf(header).signedDelegate)).toEqual(signedDelegateBytes(header));
    });

    it('accepts gas of exactly minGas', async () => {
      expect(paymentOf(await buyerHeader(MIN_GAS)).gas).toBe(MIN_GAS);
    });

    it('accepts gas of exactly maxGas', async () => {
      expect(paymentOf(await buyerHeader(MAX_GAS)).gas).toBe(MAX_GAS);
    });

    it('accepts a delegate built field by field with near-api-js', async () => {
      expect(codeOf(await delegateHeader())).toBe('ok');
    });

    it('accepts a delegate signed with a secp256k1 key', async () => {
      const keyPair = KeyPair.fromRandom('secp256k1');

      expect(paymentOf(await delegateHeader({ keyPair })).publicKey).toBe(keyPair.getPublicKey().toString());
    });

    it('accepts a msg with whitespace and its keys in another order', async () => {
      const msg = '{ "commit": { "seats": 2, "pool_id": 7 } }';

      expect(codeOf(await argsHeader({ msg }))).toBe('ok');
    });

    it('accepts compact args with their keys in another order', async () => {
      const args = { msg: commitMsg(POOL_ID, SEATS), amount: AMOUNT, receiver_id: POOLS };

      expect(codeOf(await callHeader({ args }))).toBe('ok');
    });

    it('accepts a payment for fewer seats than maxSeats and returns its own seat count', async () => {
      const payment = paymentOf(await argsHeader({ amount: '180', msg: commitMsg(POOL_ID, 1) }));

      expect(payment).toMatchObject({ seats: 1, amount: 180n });
    });
  });

  describe('check 1: the payload', () => {
    it('rejects a header that is not base64 as invalid_payload', () => {
      expect(codeOf('not base64!')).toBe('invalid_payload');
    });

    it('rejects base64 of text that is not JSON as invalid_payload', () => {
      expect(codeOf(Buffer.from('not json').toString('base64'))).toBe('invalid_payload');
    });

    it.each([null, [], 'quorum', 1])('rejects a header whose JSON is %j as invalid_payload', (value) => {
      expect(codeOf(encodeHeader(value))).toBe('invalid_payload');
    });

    it('rejects an x402Version other than 1 as invalid_payload', async () => {
      const signedDelegate = base64(await signDelegate());

      expect(codeOf(paymentHeader(signedDelegate, { x402Version: 2 }))).toBe('invalid_payload');
    });

    it('rejects a scheme other than quorum as invalid_payload', async () => {
      const signedDelegate = base64(await signDelegate());

      expect(codeOf(paymentHeader(signedDelegate, { scheme: 'exact' }))).toBe('invalid_payload');
    });

    it('rejects a network other than the expected one as invalid_payload', async () => {
      const signedDelegate = base64(await signDelegate());

      expect(codeOf(paymentHeader(signedDelegate, { network: 'near:mainnet' }))).toBe('invalid_payload');
    });

    it('rejects a payload without signedDelegate as invalid_payload', () => {
      expect(codeOf(encodeHeader({ x402Version: 1, scheme: 'quorum', network: NETWORK, payload: {} }))).toBe(
        'invalid_payload',
      );
    });

    it('rejects a payload that is not an object as invalid_payload', () => {
      expect(codeOf(encodeHeader({ x402Version: 1, scheme: 'quorum', network: NETWORK, payload: null }))).toBe(
        'invalid_payload',
      );
    });

    it('rejects a signedDelegate that is not a Borsh SignedDelegate as invalid_payload', () => {
      expect(codeOf(paymentHeader(base64(new Uint8Array([1, 2, 3, 4]))))).toBe('invalid_payload');
    });

    it('rejects a signedDelegate with trailing bytes as invalid_payload', async () => {
      const bytes = await signDelegate();

      expect(codeOf(paymentHeader(base64(new Uint8Array([...bytes, 0]))))).toBe('invalid_payload');
    });

    it('rejects a signedDelegate whose base64 has a line break in it as invalid_payload', async () => {
      const encoded = base64(await signDelegate());
      const signedDelegate = `${encoded.slice(0, 40)}\n${encoded.slice(40)}`;

      expect(codeOf(paymentHeader(signedDelegate))).toBe('invalid_payload');
    });

    it('rejects a delegate whose sender is not a valid account id as invalid_payload', async () => {
      expect(codeOf(await delegateHeader({ senderId: 'Buyer.Testnet' }))).toBe('invalid_payload');
    });

    it('rejects a delegate signed by another key as invalid_signature', async () => {
      const signed = decodeSignedDelegate(await signDelegate());
      const other = KeyPair.fromRandom('ed25519').sign(delegateHash(signed.delegateAction)).signature;
      const forged = { ...signed, signature: { ed25519Signature: { data: other } } };

      expect(codeOf(paymentHeader(base64(encodeSignedDelegate(forged))))).toBe('invalid_signature');
    });

    it('rejects a delegate changed after signing as invalid_signature', async () => {
      const signed = decodeSignedDelegate(await signDelegate());
      const tampered = {
        ...signed,
        delegateAction: { ...signed.delegateAction, maxBlockHeight: MAX_BLOCK_HEIGHT + 1_000n },
      };

      expect(codeOf(paymentHeader(base64(encodeSignedDelegate(tampered))))).toBe('invalid_signature');
    });
  });

  describe('check 2: the action', () => {
    it('rejects a delegate to a receiver other than the token as wrong_receiver', async () => {
      expect(codeOf(await delegateHeader({ receiverId: 'other-token.testnet' }))).toBe('wrong_receiver');
    });

    it('rejects a delegate with no actions as wrong_method', async () => {
      expect(codeOf(await delegateHeader({ actions: [] }))).toBe('wrong_method');
    });

    it('rejects a delegate with two actions as wrong_method', async () => {
      expect(codeOf(await delegateHeader({ actions: [commitCall(), commitCall()] }))).toBe('wrong_method');
    });

    it('rejects a delegate whose only action is a transfer as wrong_method', async () => {
      expect(codeOf(await delegateHeader({ actions: [actions.transfer(1n)] }))).toBe('wrong_method');
    });

    it('rejects a call to a method other than ft_transfer_call as wrong_method', async () => {
      expect(codeOf(await callHeader({ methodName: 'ft_transfer' }))).toBe('wrong_method');
    });

    it('rejects a deposit of 0 as wrong_deposit', async () => {
      expect(codeOf(await callHeader({ deposit: 0n }))).toBe('wrong_deposit');
    });

    it('rejects a deposit of 2 yoctoNEAR as wrong_deposit', async () => {
      expect(codeOf(await callHeader({ deposit: 2n }))).toBe('wrong_deposit');
    });

    it('rejects gas below minGas as gas_too_low', async () => {
      expect(codeOf(await callHeader({ gas: MIN_GAS - 1n }))).toBe('gas_too_low');
    });

    it('rejects gas above maxGas as gas_too_high', async () => {
      expect(codeOf(await callHeader({ gas: MAX_GAS + 1n }))).toBe('gas_too_high');
    });

    it('reports the first failing check when several fail', async () => {
      const header = await delegateHeader({ receiverId: 'other-token.testnet', actions: [commitCall({ deposit: 0n })] });

      expect(codeOf(header)).toBe('wrong_receiver');
    });
  });

  describe('check 3: the arguments', () => {
    it('rejects args with a memo as wrong_args', async () => {
      expect(codeOf(await argsHeader({ memo: 'hello' }))).toBe('wrong_args');
    });

    it('rejects args with a null memo as wrong_args', async () => {
      expect(codeOf(await argsHeader({ memo: null }))).toBe('wrong_args');
    });

    it('rejects args without msg as wrong_args', async () => {
      expect(codeOf(await argsHeader({ msg: undefined }))).toBe('wrong_args');
    });

    it('rejects a receiver_id other than the pools contract as wrong_args', async () => {
      expect(codeOf(await argsHeader({ receiver_id: 'other-pools.testnet' }))).toBe('wrong_args');
    });

    it.each([360, '0360', '360.0', ' 360', '-360', '3.6e2'])(
      'rejects the amount %j, which is not a decimal string, as wrong_args',
      async (amount) => {
        expect(codeOf(await argsHeader({ amount }))).toBe('wrong_args');
      },
    );

    it('rejects args that are not JSON as wrong_args', async () => {
      expect(codeOf(await callHeader({ args: utf8('receiver_id=pools.parent.testnet') }))).toBe('wrong_args');
    });

    it('rejects args that are a JSON array as wrong_args', async () => {
      expect(codeOf(await callHeader({ args: utf8(JSON.stringify([POOLS, AMOUNT, commitMsg(7, 2)])) }))).toBe(
        'wrong_args',
      );
    });

    it('rejects args that are not valid UTF-8 as wrong_args', async () => {
      const args = new Uint8Array([...utf8(JSON.stringify(commitArgs())).slice(0, -2), 0xff, ...utf8('"}')]);

      expect(codeOf(await callHeader({ args }))).toBe('wrong_args');
    });

    it('rejects args that start with a byte order mark as wrong_args', async () => {
      const args = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8(JSON.stringify(commitArgs()))]);

      expect(codeOf(await callHeader({ args }))).toBe('wrong_args');
    });

    it('rejects args with a duplicated key as wrong_args', async () => {
      const msg = JSON.stringify(commitMsg(POOL_ID, SEATS));
      const text = `{"receiver_id":"other-pools.testnet","receiver_id":"${POOLS}","amount":"${AMOUNT}","msg":${msg}}`;

      expect(codeOf(await callHeader({ args: utf8(text) }))).toBe('wrong_args');
    });

    it.each([
      ['indented', JSON.stringify(commitArgs(), null, 2)],
      ['followed by a newline', `${JSON.stringify(commitArgs())}\n`],
      ['with an escaped character', JSON.stringify(commitArgs()).replace(`"${AMOUNT}"`, String.raw`"\u0033\u0036\u0030"`)],
    ])('rejects args that are not compact JSON (%s) as wrong_args', async (_, text) => {
      expect(codeOf(await callHeader({ args: utf8(text) }))).toBe('wrong_args');
    });

    it('rejects a msg that is not JSON as wrong_args', async () => {
      expect(codeOf(await argsHeader({ msg: 'commit 7 2' }))).toBe('wrong_args');
    });

    it('rejects a msg with an extra top-level key as wrong_args', async () => {
      const msg = JSON.stringify({ commit: { pool_id: POOL_ID, seats: SEATS }, note: 'x' });

      expect(codeOf(await argsHeader({ msg }))).toBe('wrong_args');
    });

    it('rejects a msg with an extra key inside commit as wrong_args', async () => {
      const msg = JSON.stringify({ commit: { pool_id: POOL_ID, seats: SEATS, note: 'x' } });

      expect(codeOf(await argsHeader({ msg }))).toBe('wrong_args');
    });

    it('rejects a msg that is an open instead of a commit as wrong_args', async () => {
      const msg = JSON.stringify({ open: { pool_id: POOL_ID, seats: SEATS } });

      expect(codeOf(await argsHeader({ msg }))).toBe('wrong_args');
    });

    it('rejects a msg whose seats is a string as wrong_args', async () => {
      const msg = JSON.stringify({ commit: { pool_id: POOL_ID, seats: '2' } });

      expect(codeOf(await argsHeader({ msg }))).toBe('wrong_args');
    });

    it('rejects a msg whose pool_id is not an integer as wrong_args', async () => {
      const msg = JSON.stringify({ commit: { pool_id: 7.5, seats: SEATS } });

      expect(codeOf(await argsHeader({ msg }))).toBe('wrong_args');
    });

    it.each(['{"commit":{"pool_id":7.0,"seats":2}}', '{"commit":{"pool_id":7,"seats":2e0}}'])(
      'rejects the msg %s, whose integers the contract cannot parse, as wrong_args',
      async (msg) => {
        expect(codeOf(await argsHeader({ msg }))).toBe('wrong_args');
      },
    );

    it('rejects a msg with a duplicated key as wrong_args', async () => {
      const msg = '{"commit":{"pool_id":8,"pool_id":7,"seats":2}}';

      expect(codeOf(await argsHeader({ msg }))).toBe('wrong_args');
    });

    it('rejects an amount other than seats times seat price as wrong_amount', async () => {
      expect(codeOf(await argsHeader({ amount: '359' }))).toBe('wrong_amount');
    });

    it('rejects an amount that pays for maxSeats when the msg commits to fewer seats as wrong_amount', async () => {
      expect(codeOf(await argsHeader({ amount: AMOUNT, msg: commitMsg(POOL_ID, 1) }))).toBe('wrong_amount');
    });

    it('rejects a msg that is not JSON as wrong_args even when the amount is also wrong', async () => {
      expect(codeOf(await argsHeader({ amount: '180', msg: 'commit 7 2' }))).toBe('wrong_args');
    });

    it('rejects a commit for another pool as wrong_pool', async () => {
      expect(codeOf(await argsHeader({ msg: commitMsg(8, SEATS) }))).toBe('wrong_pool');
    });

    it('rejects a commit for 0 seats as wrong_pool', async () => {
      expect(codeOf(await argsHeader({ amount: '0', msg: commitMsg(POOL_ID, 0) }))).toBe('wrong_pool');
    });

    it('rejects a commit for a negative number of seats as wrong_pool', async () => {
      expect(codeOf(await argsHeader({ msg: commitMsg(POOL_ID, -1) }))).toBe('wrong_pool');
    });

    it('rejects a commit for more seats than maxSeats, priced for those seats, as wrong_pool', async () => {
      expect(codeOf(await argsHeader({ amount: '540', msg: commitMsg(POOL_ID, 3) }))).toBe('wrong_pool');
    });
  });

  it('explains a failure in its detail', async () => {
    const result = check(await argsHeader({ amount: '359' }));

    expect(result).toEqual({ ok: false, code: 'wrong_amount', detail: expect.stringMatching(/359.*360/) });
  });
});
```

`packages/protocol/test/client.test.ts`:

```typescript
import { randomBytes } from 'node:crypto';
import { KeyPair } from 'near-api-js';
import { describe, expect, it } from 'vitest';
import { checkPaymentHeader } from '../src/checks.ts';
import type { CheckedPayment, ExpectedPayment } from '../src/checks.ts';
import { OfferRefusedError, buildPaymentHeader, buildRedeemProofHeader, checkOffer, maxBlockHeightFor } from '../src/client.ts';
import type { ExpectedOffer, OfferErrorCode, PaymentInput, ProofInput } from '../src/client.ts';
import { decodeHeader } from '../src/codec.ts';
import type { PaymentPayload } from '../src/codec.ts';
import type { PoolView } from '../src/contract.ts';
import { checkRedeemProof, nonceTimeMs } from '../src/nep413.ts';
import type { RedeemProof } from '../src/nep413.ts';
import { buildOffer } from '../src/offer.ts';
import type { Offer, OfferContext } from '../src/offer.ts';

const BUYER = 'buyer.testnet';
const MIN_GAS = 50_000_000_000_000n;
const MAX_GAS = 100_000_000_000_000n;
const NONCE = 42n;
const MAX_BLOCK_HEIGHT = 1_000_100n;
const RECIPIENT = 'localhost:8402';
const NOW_MS = 1_800_000_000_000;

const POOL: PoolView = {
  id: 7,
  seller: 'provider.parent.testnet',
  seat_price: '180',
  target: 192,
  taken: 148,
  deadline_ms: 1_800_000_600_000,
  bonus: '1728',
  max_seats_per_buyer: null,
  terms: '8 GPUs for 24 h; 1 seat = 1 GPU-hour',
  status: 'open',
  bonus_per_seat: '0',
  refund_cursor: 0,
  dust_sent: false,
  buyer_count: 30,
};
const CONTEXT: OfferContext = {
  network: 'near:testnet',
  gatewayUrl: 'http://localhost:8402',
  poolsContract: 'pools.parent.testnet',
  token: 'usdc.testnet',
  relayer: 'relay.parent.testnet',
  minGas: MIN_GAS,
  maxGas: MAX_GAS,
  maxTimeoutSeconds: 120,
};
/**
 * The buyer's own configuration, which agrees with the gateway's, its request for 2 seats of pool 7,
 * and a budget of their price at 180.
 */
const BUYER_CONFIG: ExpectedOffer = {
  network: 'near:testnet',
  token: 'usdc.testnet',
  poolsContract: 'pools.parent.testnet',
  poolId: 7,
  maxSeats: 2,
  maxAmount: 360n,
};
const OFFER = buildOffer(POOL, 2, CONTEXT);

/**
 * The 2-seat offer with `changes` applied and `extra` merged into its extra. The fields take any
 * value, as an offer read from a 402 body can.
 */
function offerWith(changes: Record<string, unknown>, extra: Record<string, unknown> = {}): Offer {
  return { ...OFFER, ...changes, extra: { ...OFFER.extra, ...extra } } as Offer;
}

/**
 * Offers that name other contracts, another pool or more seats than the buyer's, an amount that is
 * not the price of their seats or is above the budget, and the code each is refused with.
 */
const MISMATCHED: [string, OfferErrorCode, Offer][] = [
  ['a scheme other than quorum', 'wrong_scheme', offerWith({ scheme: 'exact' })],
  ['another network', 'wrong_network', offerWith({ network: 'near:mainnet' })],
  ['another token as its asset', 'wrong_asset', offerWith({ asset: 'usdc.other.testnet' })],
  ['another account to pay to', 'wrong_pay_to', offerWith({ payTo: 'pools.other.testnet' })],
  ['another pool than the one asked for', 'wrong_pool', offerWith({}, { poolId: 8 })],
  ['more seats than asked for, within the budget', 'too_many_seats', offerWith({ maxAmountRequired: '300' }, { seats: 3, seatPrice: '100' })],
  ['an amount above the budget', 'over_budget', offerWith({ maxAmountRequired: '362' }, { seatPrice: '181' })],
  ['an amount below the price of its seats', 'wrong_amount', offerWith({ maxAmountRequired: '359' })],
  ['an amount above the price of its seats', 'wrong_amount', offerWith({ maxAmountRequired: '361' })],
  ['the amount for 2 seats but 1 seat in extra', 'wrong_amount', offerWith({}, { seats: 1 })],
  ['the amount at another seat price than extra.seatPrice', 'wrong_amount', offerWith({}, { seatPrice: '179' })],
];

/** Offers with a field the payment is built from that is not of the offer's form. */
const MALFORMED: [string, Offer][] = [
  ['an extra that is not an object', { ...OFFER, extra: null } as unknown as Offer],
  ['a pool id that is a string', offerWith({}, { poolId: '7' })],
  ['a negative pool id', offerWith({}, { poolId: -1 })],
  ['0 seats', offerWith({ maxAmountRequired: '0' }, { seats: 0 })],
  ['a fractional seat count', offerWith({}, { seats: 1.5 })],
  ['a seat count beyond the safe integer range', offerWith({}, { seats: 2 ** 53 })],
  ['a seat price that is a number', offerWith({}, { seatPrice: 180 })],
  ['a seat price in hexadecimal', offerWith({}, { seatPrice: '0xb4' })],
  ['an amount with a leading zero', offerWith({ maxAmountRequired: '0360' })],
  ['a maxGas in exponent form', offerWith({}, { maxGas: '1e14' })],
];

/** Offers that fail several checks, and the code of the first in checkOffer's order. */
const FIRST_FAILURE: [string, OfferErrorCode, Offer][] = [
  ['a string pool id and more seats', 'invalid_offer', offerWith({ maxAmountRequired: '540' }, { poolId: '8', seats: 3 })],
  ['another pool and more seats, above the budget', 'wrong_pool', offerWith({ maxAmountRequired: '540' }, { poolId: 8, seats: 3 })],
  ['more seats, above the budget', 'too_many_seats', offerWith({ maxAmountRequired: '540' }, { seats: 3 })],
  ['an amount not the price of its seats, above the budget', 'wrong_amount', offerWith({ maxAmountRequired: '1000' })],
];

/** What the gateway expects of a payment that answers `offer`. */
function expectedFor(offer: Offer): ExpectedPayment {
  return {
    network: offer.network,
    token: offer.asset,
    poolsContract: offer.payTo,
    poolId: offer.extra.poolId,
    maxSeats: offer.extra.seats,
    seatPrice: BigInt(offer.extra.seatPrice),
    minGas: BigInt(offer.extra.minGas),
    maxGas: BigInt(offer.extra.maxGas),
  };
}

function paymentInput(overrides: Partial<PaymentInput> = {}): PaymentInput {
  return {
    keyPair: KeyPair.fromRandom('ed25519'),
    senderId: BUYER,
    nonce: NONCE,
    maxBlockHeight: MAX_BLOCK_HEIGHT,
    offer: OFFER,
    expected: BUYER_CONFIG,
    ...overrides,
  };
}

/** Builds a payment header and runs the gateway's static checks on it. */
async function checkedPayment(input: PaymentInput): Promise<CheckedPayment> {
  const result = checkPaymentHeader(await buildPaymentHeader(input), expectedFor(input.offer));
  if (!result.ok) throw new Error(`expected a valid payment, got ${result.code}: ${result.detail}`);
  return result.payment;
}

function proofInput(overrides: Partial<ProofInput> = {}): ProofInput {
  return {
    keyPair: KeyPair.fromRandom('ed25519'),
    accountId: BUYER,
    poolId: 7,
    recipient: RECIPIENT,
    nowMs: NOW_MS,
    ...overrides,
  };
}

function nonceOf(header: string): Uint8Array {
  return new Uint8Array(Buffer.from((decodeHeader(header) as RedeemProof).nonce, 'base64'));
}

describe('checkOffer', () => {
  it('accepts an offer that buildOffer made from the same configuration as the buyer', () => {
    expect(checkOffer(OFFER, BUYER_CONFIG)).toBeNull();
  });

  it('accepts a reduced offer for fewer seats', () => {
    expect(checkOffer(buildOffer(POOL, 1, CONTEXT), BUYER_CONFIG)).toBeNull();
  });

  it('accepts an offer whose amount is exactly the budget', () => {
    expect(checkOffer(OFFER, { ...BUYER_CONFIG, maxAmount: 360n })).toBeNull();
  });

  it('refuses the same offer as over_budget with a budget 1 below its amount', () => {
    expect(checkOffer(OFFER, { ...BUYER_CONFIG, maxAmount: 359n })?.code).toBe('over_budget');
  });

  it('accepts any seat price whose total is within the budget', () => {
    expect(checkOffer(offerWith({ maxAmountRequired: '300' }, { seats: 1, seatPrice: '300' }), BUYER_CONFIG)).toBeNull();
  });

  it.each(MISMATCHED)('refuses an offer with %s as %s', (_name, code, offer) => {
    expect(checkOffer(offer, BUYER_CONFIG)?.code).toBe(code);
  });

  it.each(MALFORMED)('refuses an offer with %s as invalid_offer', (_name, offer) => {
    expect(checkOffer(offer, BUYER_CONFIG)?.code).toBe('invalid_offer');
  });

  it.each(FIRST_FAILURE)('refuses an offer with %s as %s', (_name, code, offer) => {
    expect(checkOffer(offer, BUYER_CONFIG)?.code).toBe(code);
  });

  it('explains a refusal with the value the buyer is configured with', () => {
    expect(checkOffer(offerWith({ payTo: 'pools.other.testnet' }), BUYER_CONFIG)).toEqual({
      code: 'wrong_pay_to',
      detail: 'payTo is not pools.parent.testnet',
    });
  });

  it('explains a wrong amount with the price of the seats', () => {
    expect(checkOffer(offerWith({ maxAmountRequired: '359' }), BUYER_CONFIG)).toEqual({
      code: 'wrong_amount',
      detail: 'maxAmountRequired is not 360, the price of 2 seats at 180',
    });
  });

  it.each<[OfferErrorCode, Offer, string]>([
    ['wrong_pool', offerWith({}, { poolId: 8 }), 'extra.poolId is not 7, the pool asked for'],
    ['too_many_seats', offerWith({ maxAmountRequired: '300' }, { seats: 3, seatPrice: '100' }), 'extra.seats is above 2, the seats asked for'],
    ['over_budget', offerWith({ maxAmountRequired: '362' }, { seatPrice: '181' }), 'maxAmountRequired is above 360, the budget'],
  ])('explains %s with what the buyer asked for', (code, offer, detail) => {
    expect(checkOffer(offer, BUYER_CONFIG)).toEqual({ code, detail });
  });
});

describe('buildPaymentHeader', () => {
  it('builds a header that passes checkPaymentHeader for the offer it answers', async () => {
    const input = paymentInput();

    const result = checkPaymentHeader(await buildPaymentHeader(input), expectedFor(input.offer));

    expect(result.ok).toBe(true);
  });

  it('builds an x402 version 1 quorum payload on the offer network', async () => {
    const payload = decodeHeader(await buildPaymentHeader(paymentInput())) as PaymentPayload;

    expect(payload).toEqual({
      x402Version: 1,
      scheme: 'quorum',
      network: 'near:testnet',
      payload: { signedDelegate: expect.any(String) },
    });
  });

  it('signs for the given sender, key, nonce and max block height', async () => {
    const keyPair = KeyPair.fromRandom('ed25519');

    const payment = await checkedPayment(paymentInput({ keyPair }));

    expect(payment).toMatchObject({
      senderId: BUYER,
      publicKey: keyPair.getPublicKey().toString(),
      nonce: NONCE,
      maxBlockHeight: MAX_BLOCK_HEIGHT,
    });
  });

  it('pays for the seats and the amount of the offer', async () => {
    const offer = buildOffer(POOL, 1, CONTEXT);

    const payment = await checkedPayment(paymentInput({ offer }));

    expect(payment).toMatchObject({ poolId: 7, seats: 1, amount: 180n });
  });

  it('builds a header for a reduced offer that passes the checks for the seats first asked for', async () => {
    const offer = buildOffer(POOL, 1, CONTEXT);

    const result = checkPaymentHeader(await buildPaymentHeader(paymentInput({ offer })), {
      ...expectedFor(offer),
      maxSeats: 2,
    });

    expect(result).toMatchObject({ ok: true, payment: { seats: 1, amount: 180n } });
  });

  it('signs an offer whose amount is exactly the budget', async () => {
    const payment = await checkedPayment(paymentInput({ expected: { ...BUYER_CONFIG, maxAmount: 360n } }));

    expect(payment).toMatchObject({ seats: 2, amount: 360n });
  });

  it('uses the offer maxGas when no gas is given', async () => {
    expect((await checkedPayment(paymentInput())).gas).toBe(MAX_GAS);
  });

  it('uses the gas it is given instead of the offer maxGas', async () => {
    const gas = 75_000_000_000_000n;

    expect((await checkedPayment(paymentInput({ gas }))).gas).toBe(gas);
  });

  it.each(MISMATCHED)('refuses to sign an offer with %s, with an OfferRefusedError of code %s', async (_name, code, offer) => {
    const building = buildPaymentHeader(paymentInput({ offer }));

    await expect(building).rejects.toThrow(OfferRefusedError);
    await expect(building).rejects.toMatchObject({ code });
  });

  it.each(MALFORMED)('refuses to sign an offer with %s, as invalid_offer', async (_name, offer) => {
    await expect(buildPaymentHeader(paymentInput({ offer }))).rejects.toMatchObject({
      name: 'OfferRefusedError',
      code: 'invalid_offer',
    });
  });

  it('says in the error why the offer was refused', async () => {
    const offer = offerWith({ asset: 'usdc.other.testnet' });

    await expect(buildPaymentHeader(paymentInput({ offer }))).rejects.toThrow(
      'offer refused (wrong_asset): the asset is not usdc.testnet',
    );
  });

  it('signs an offer for other contracts when the buyer is configured with them', async () => {
    const other = { ...CONTEXT, token: 'usdc.other.testnet', poolsContract: 'pools.other.testnet' };
    const offer = buildOffer(POOL, 2, other);
    const expected = { ...BUYER_CONFIG, token: other.token, poolsContract: other.poolsContract };

    const payment = await checkedPayment(paymentInput({ offer, expected }));

    expect(payment).toMatchObject({ seats: 2, amount: 360n });
  });
});

describe('maxBlockHeightFor', () => {
  it('adds the timeout, converted to blocks, to the current height', () => {
    expect(maxBlockHeightFor(1_000_000n, 120, 1_000)).toBe(1_000_120n);
  });

  it('rounds a fractional number of blocks down', () => {
    // 120 s at 700 ms a block is 171.43 blocks.
    expect(maxBlockHeightFor(1_000_000n, 120, 700)).toBe(1_000_171n);
  });

  it('adds nothing when the timeout is shorter than one block', () => {
    expect(maxBlockHeightFor(1_000_000n, 1, 1_500)).toBe(1_000_000n);
  });
});

describe('buildRedeemProofHeader', () => {
  it('builds a proof that passes checkRedeemProof', async () => {
    const header = await buildRedeemProofHeader(proofInput());

    const result = checkRedeemProof(header, { poolId: 7, recipient: RECIPIENT, nowMs: NOW_MS });

    expect(result).toMatchObject({ ok: true, signedAtMs: NOW_MS });
  });

  it('signs for the given account with the key pair public key', async () => {
    const keyPair = KeyPair.fromRandom('ed25519');

    const proof = decodeHeader(await buildRedeemProofHeader(proofInput({ keyPair }))) as RedeemProof;

    expect(proof).toMatchObject({
      accountId: BUYER,
      publicKey: keyPair.getPublicKey().toString(),
      message: 'quorum:redeem:7',
      recipient: RECIPIENT,
    });
  });

  it('puts nowMs in the first 8 bytes of the nonce, big-endian', async () => {
    const nonce = nonceOf(await buildRedeemProofHeader(proofInput()));

    expect(Buffer.from(nonce.subarray(0, 8)).readBigUInt64BE()).toBe(BigInt(NOW_MS));
    expect(nonceTimeMs(nonce)).toBe(NOW_MS);
  });

  it('uses the given random bytes for the last 24 bytes of the nonce', async () => {
    const random = new Uint8Array(randomBytes(24));

    const nonce = nonceOf(await buildRedeemProofHeader(proofInput({ random })));

    expect(nonce).toHaveLength(32);
    expect(nonce.subarray(8)).toEqual(random);
  });

  it('generates fresh random bytes when none are given', async () => {
    const keyPair = KeyPair.fromRandom('ed25519');

    const first = nonceOf(await buildRedeemProofHeader(proofInput({ keyPair })));
    const second = nonceOf(await buildRedeemProofHeader(proofInput({ keyPair })));

    expect(first.subarray(0, 8)).toEqual(second.subarray(0, 8));
    expect(first.subarray(8)).not.toEqual(second.subarray(8));
  });

  it('refuses random bytes that are not 24 bytes long', async () => {
    await expect(buildRedeemProofHeader(proofInput({ random: new Uint8Array(23) }))).rejects.toThrow(RangeError);
  });

  it('refuses a nowMs that is not a non-negative integer', async () => {
    await expect(buildRedeemProofHeader(proofInput({ nowMs: -1 }))).rejects.toThrow(RangeError);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @quorum-on-near/protocol exec vitest run test/checks.test.ts test/client.test.ts`

Expected: FAIL. vitest cannot load `../src/checks.ts` and `../src/client.ts`, which do not exist yet.

- [ ] **Step 3: Write the implementation**

`packages/protocol/src/checks.ts`:

```typescript
import { isAccountId } from './account.ts';
import { parseAmount, priceOf } from './amounts.ts';
import { decodeHeader } from './codec.ts';
import { ONE_YOCTO, SCHEME, X402_VERSION } from './constants.ts';
import type { Network } from './constants.ts';
import { decodeSignedDelegate, delegatePublicKey, onlyFunctionCall, verifyDelegateSignature } from './delegate.ts';
import type { Bytes, DecodedSignedDelegate } from './delegate.ts';

/** Codes of the static checks (spec section 6.4, rows 1 to 3), made without network access. */
export type StaticErrorCode =
  | 'invalid_payload'
  | 'invalid_signature'
  | 'wrong_receiver'
  | 'wrong_method'
  | 'wrong_deposit'
  | 'gas_too_low'
  | 'gas_too_high'
  | 'wrong_args'
  | 'wrong_amount'
  | 'wrong_pool';

/** Codes of the gateway's chain checks and its own guards. */
export type GatewayErrorCode =
  | 'not_full_access'
  | 'stale_nonce'
  | 'nonce_too_large'
  | 'expired'
  | 'pool_closed'
  | 'insufficient_balance'
  | 'seller_commit'
  | 'over_buyer_cap'
  | 'payment_in_flight';

export type PaymentErrorCode = StaticErrorCode | GatewayErrorCode;

/** What a payment must match. */
export interface ExpectedPayment {
  network: Network;
  token: string;
  poolsContract: string;
  poolId: number;
  /**
   * The seats asked for in the request. A payment may commit to fewer, as when the buyer answers a
   * reduced offer at the URL it first requested, but to no more.
   */
  maxSeats: number;
  seatPrice: bigint;
  minGas: bigint;
  maxGas: bigint;
}

/** A payment that passed the static checks. */
export interface CheckedPayment {
  signedDelegate: DecodedSignedDelegate;
  senderId: string;
  publicKey: string;
  nonce: bigint;
  maxBlockHeight: bigint;
  gas: bigint;
  amount: bigint;
  poolId: number;
  /** The seats the payment commits to, between 1 and the expected `maxSeats`. */
  seats: number;
}

export type StaticCheckResult =
  | { ok: true; payment: CheckedPayment }
  | { ok: false; code: StaticErrorCode; detail: string };

type Failure = Extract<StaticCheckResult, { ok: false }>;

const METHOD = 'ft_transfer_call';
/**
 * Strict UTF-8 that keeps a leading byte order mark, so that JSON.parse refuses args that start with
 * one, as serde_json does.
 */
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * Runs checks 1 to 3 of spec section 6.4 on an `X-PAYMENT` header value, in the table's order, and
 * returns the first failure. Never throws.
 */
export function checkPaymentHeader(header: string, expected: ExpectedPayment): StaticCheckResult {
  // Check 1: the payload and the signature.
  const signed = decodePayment(header, expected.network);
  if (isFailure(signed)) return signed;
  if (!verifyDelegateSignature(signed)) {
    return fail('invalid_signature', 'the signature is not valid for the delegate public key');
  }

  // Check 2: one ft_transfer_call on the token, with 1 yoctoNEAR and gas within bounds.
  const delegate = signed.delegateAction;
  if (delegate.receiverId !== expected.token) return fail('wrong_receiver', `the receiver is not ${expected.token}`);
  const call = onlyFunctionCall(delegate);
  if (call === null || call.methodName !== METHOD) {
    return fail('wrong_method', `the delegate must hold exactly one FunctionCall to ${METHOD}`);
  }
  if (call.deposit !== ONE_YOCTO) return fail('wrong_deposit', `the deposit is ${call.deposit}, not 1 yoctoNEAR`);
  if (call.gas < expected.minGas) return fail('gas_too_low', `the gas is ${call.gas}, below ${expected.minGas}`);
  if (call.gas > expected.maxGas) return fail('gas_too_high', `the gas is ${call.gas}, above ${expected.maxGas}`);

  // Check 3: the arguments match the offer, and the amount pays for the seats in the msg.
  const args = parseArgs(call.args);
  if (args === null) {
    return fail('wrong_args', 'the args must be compact JSON of an object of exactly receiver_id, amount and msg, as strings');
  }
  if (args.receiver_id !== expected.poolsContract) {
    return fail('wrong_args', `receiver_id is not ${expected.poolsContract}`);
  }
  const amount = parseAmount(args.amount);
  if (amount === null) return fail('wrong_args', 'amount is not a decimal string');
  const commit = parseCommit(args.msg);
  if (commit === null) return fail('wrong_args', 'msg must be exactly {"commit":{"pool_id":<integer>,"seats":<integer>}}');
  if (commit.pool_id !== expected.poolId || commit.seats < 1 || commit.seats > expected.maxSeats) {
    return fail(
      'wrong_pool',
      `msg commits ${commit.seats} seats to pool ${commit.pool_id}, not 1 to ${expected.maxSeats} seats to pool ${expected.poolId}`,
    );
  }
  const price = priceOf(commit.seats, expected.seatPrice);
  if (amount !== price) return fail('wrong_amount', `the amount is ${amount}, not ${price} for ${commit.seats} seats`);

  return {
    ok: true,
    payment: {
      signedDelegate: signed,
      senderId: delegate.senderId,
      publicKey: delegatePublicKey(delegate),
      nonce: delegate.nonce,
      maxBlockHeight: delegate.maxBlockHeight,
      gas: call.gas,
      amount,
      poolId: commit.pool_id,
      seats: commit.seats,
    },
  };
}

/** The signed delegate of a well-formed `quorum` payment header for `network`. */
function decodePayment(header: string, network: Network): DecodedSignedDelegate | Failure {
  let value: unknown;
  try {
    value = decodeHeader(header);
  } catch {
    return fail('invalid_payload', 'the header is not base64 of JSON');
  }
  if (!isRecord(value)) return fail('invalid_payload', 'the header is not a JSON object');
  if (value.x402Version !== X402_VERSION) return fail('invalid_payload', `x402Version is not ${X402_VERSION}`);
  if (value.scheme !== SCHEME) return fail('invalid_payload', `the scheme is not ${SCHEME}`);
  if (value.network !== network) return fail('invalid_payload', `the network is not ${network}`);
  const { payload } = value;
  if (!isRecord(payload) || typeof payload.signedDelegate !== 'string') {
    return fail('invalid_payload', 'payload.signedDelegate is missing');
  }
  const bytes = decodeBase64(payload.signedDelegate);
  if (bytes === null) return fail('invalid_payload', 'payload.signedDelegate is not base64');
  let signed: DecodedSignedDelegate;
  try {
    signed = decodeSignedDelegate(bytes);
  } catch {
    return fail('invalid_payload', 'payload.signedDelegate is not a Borsh SignedDelegate');
  }
  // The chain refuses a delegate whose account ids are invalid, so it is not a valid payload.
  if (!isAccountId(signed.delegateAction.senderId) || !isAccountId(signed.delegateAction.receiverId)) {
    return fail('invalid_payload', 'the delegate sender or receiver is not a valid account id');
  }
  return signed;
}

interface TransferArgs {
  receiver_id: string;
  amount: string;
  msg: string;
}

/**
 * The ft_transfer_call args, when they are UTF-8 JSON of exactly receiver_id, amount and msg, all
 * strings, written in compact form.
 */
function parseArgs(bytes: Bytes): TransferArgs | null {
  let text: string;
  try {
    text = UTF8.decode(Uint8Array.from(bytes));
  } catch {
    return null;
  }
  const args = parseObject(text);
  // JSON.parse keeps the last of duplicate keys, where the token's parser may keep the first or refuse
  // them. Requiring the text to be what JSON.stringify writes for its value, as near-api-js does,
  // refuses duplicate keys, whitespace and escapes that JSON.stringify would not write.
  if (args === null || text !== JSON.stringify(args)) return null;
  if (!hasExactKeys(args, ['receiver_id', 'amount', 'msg'])) return null;
  const { receiver_id, amount, msg } = args;
  if (typeof receiver_id !== 'string' || typeof amount !== 'string' || typeof msg !== 'string') return null;
  return { receiver_id, amount, msg };
}

/** The commit in a msg of exactly `{"commit":{"pool_id":<integer>,"seats":<integer>}}`. */
function parseCommit(msg: string): { pool_id: number; seats: number } | null {
  const value = parseObject(msg);
  if (value === null || !hasExactKeys(value, ['commit'])) return null;
  const { commit } = value;
  if (!isRecord(commit) || !hasExactKeys(commit, ['pool_id', 'seats'])) return null;
  const { pool_id, seats } = commit;
  if (!isSafeInteger(pool_id) || !isSafeInteger(seats)) return null;
  // JSON.parse accepts integers written as 7.0, 7e0 or -0 and duplicate keys, which the contract's
  // serde_json refuses for these fields. With the keys known, the msg holds only those keys,
  // integers and punctuation, so up to whitespace it must equal the compact form of its value.
  if (msg.replace(/[ \t\n\r]/g, '') !== JSON.stringify(value)) return null;
  return { pool_id, seats };
}

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

/** Standard base64 with padding; null unless `text` is exactly the encoding of the bytes it decodes to. */
function decodeBase64(text: string): Uint8Array | null {
  const bytes = Buffer.from(text, 'base64');
  return bytes.toString('base64') === text ? new Uint8Array(bytes) : null;
}

function isFailure(value: DecodedSignedDelegate | Failure): value is Failure {
  return 'ok' in value;
}

function fail(code: StaticErrorCode, detail: string): Failure {
  return { ok: false, code, detail };
}
```

`packages/protocol/src/client.ts`:

```typescript
import { randomBytes } from 'node:crypto';
import { KeyPairSigner, actions, buildDelegateAction, encodeSignedDelegate } from 'near-api-js';
import type { KeyPair } from 'near-api-js';
import { parseAmount, priceOf } from './amounts.ts';
import type { ExpectedPayment } from './checks.ts';
import { encodeHeader } from './codec.ts';
import type { PaymentPayload } from './codec.ts';
import { ONE_YOCTO, SCHEME, X402_VERSION } from './constants.ts';
import { commitMsg } from './contract.ts';
import { redeemMessage } from './nep413.ts';
import type { RedeemProof } from './nep413.ts';
import type { Offer } from './offer.ts';

/**
 * Pure builders for buyers: no network access. The caller supplies the key's next nonce and the
 * maximum block height.
 */
export interface PaymentInput {
  keyPair: KeyPair;
  senderId: string;
  /** The access key's current on-chain nonce plus 1, or higher. */
  nonce: bigint;
  maxBlockHeight: bigint;
  offer: Offer;
  /** The buyer's own configuration, its request and its budget, which the offer must match. */
  expected: ExpectedOffer;
  /**
   * Gas for the inner ft_transfer_call; defaults to the offer's maxGas, the most the gateway accepts
   * and the least likely to run out. The relayer prepays it and is refunded what the call does not
   * use, under the protocol's refund rules.
   */
  gas?: bigint;
}

/**
 * Builds and signs the delegate action for an offer that checkOffer accepts (OfferRefusedError
 * otherwise): one `ft_transfer_call` on the expected token, to the expected pools contract, for
 * `offer.maxAmountRequired`, with the commit msg for `extra.poolId` and `extra.seats` and
 * 1 yoctoNEAR attached. The payment is therefore for the pool asked for, for at most the seats asked
 * for, and for at most `expected.maxAmount`; within that budget, the seat price is the offer's.
 * Returns the `X-PAYMENT` header value.
 */
export async function buildPaymentHeader(input: PaymentInput): Promise<string> {
  const { keyPair, senderId, nonce, maxBlockHeight, offer, expected, gas } = input;
  const refusal = checkOffer(offer, expected);
  if (refusal !== null) throw new OfferRefusedError(refusal);
  const { extra } = offer;
  const args = {
    receiver_id: expected.poolsContract,
    amount: offer.maxAmountRequired,
    msg: commitMsg(extra.poolId, extra.seats),
  };
  const transfer = actions.functionCall('ft_transfer_call', args, gas ?? BigInt(extra.maxGas), ONE_YOCTO);
  const delegateAction = buildDelegateAction({
    senderId,
    receiverId: expected.token,
    actions: [transfer],
    nonce,
    maxBlockHeight,
    publicKey: keyPair.getPublicKey(),
  });
  const { signedDelegate } = await new KeyPairSigner(keyPair).signDelegateAction(delegateAction);
  const payment: PaymentPayload = {
    x402Version: X402_VERSION,
    scheme: SCHEME,
    network: expected.network,
    payload: { signedDelegate: base64(encodeSignedDelegate(signedDelegate)) },
  };
  return encodeHeader(payment);
}

/**
 * What a buyer requires of every offer before it signs one. The network, the token and the pools
 * contract come from its own configuration: an offer names the contract the tokens are sent to, so
 * these never come from the gateway. `poolId` and `maxSeats` are the pool and the seats of the
 * request the offer answers. Nothing here bounds the seat price except `maxAmount`.
 */
export interface ExpectedOffer extends Pick<ExpectedPayment, 'network' | 'token' | 'poolsContract' | 'poolId' | 'maxSeats'> {
  /** The most the buyer pays for this payment, in the token's base units. */
  maxAmount: bigint;
}

export type OfferErrorCode =
  | 'invalid_offer'
  | 'wrong_scheme'
  | 'wrong_network'
  | 'wrong_asset'
  | 'wrong_pay_to'
  | 'wrong_pool'
  | 'too_many_seats'
  | 'wrong_amount'
  | 'over_budget';

export interface OfferRefusal {
  code: OfferErrorCode;
  detail: string;
}

/**
 * Checks an offer against the buyer's configuration, request and budget, in this order: the scheme
 * is `quorum`; the network, `asset` and `payTo` are the expected network, token and pools contract;
 * the fields the payment is built from are well formed (`extra.poolId` a non-negative integer,
 * `extra.seats` a positive integer, `maxAmountRequired`, `extra.seatPrice` and `extra.maxGas` decimal
 * strings); `extra.poolId` is the expected pool; `extra.seats` is at most `maxSeats` (fewer is a
 * reduced offer); `maxAmountRequired` is exactly `extra.seats × extra.seatPrice`; and it is at most
 * `maxAmount`. Returns the first refusal, or null when the offer may be signed. Never throws,
 * whatever the offer's field values.
 *
 * This bounds what the payment commits to and what it costs. The rest of the offer is the gateway's
 * word: the seat price within the budget, the gas figures, the timeout and what `extra` says of the
 * pool, which a buyer that relies on it reads from the chain.
 */
export function checkOffer(offer: Offer, expected: ExpectedOffer): OfferRefusal | null {
  if (offer.scheme !== SCHEME) return refuse('wrong_scheme', `the scheme is not ${SCHEME}`);
  if (offer.network !== expected.network) return refuse('wrong_network', `the network is not ${expected.network}`);
  if (offer.asset !== expected.token) return refuse('wrong_asset', `the asset is not ${expected.token}`);
  if (offer.payTo !== expected.poolsContract) return refuse('wrong_pay_to', `payTo is not ${expected.poolsContract}`);

  const { extra } = offer;
  if (typeof extra !== 'object' || extra === null) return refuse('invalid_offer', 'extra is not an object');
  const { poolId, seats } = extra;
  if (!Number.isSafeInteger(poolId) || poolId < 0) return refuse('invalid_offer', 'extra.poolId is not a non-negative integer');
  if (!Number.isSafeInteger(seats) || seats < 1) return refuse('invalid_offer', 'extra.seats is not a positive integer');
  const amount = parseAmount(offer.maxAmountRequired);
  const seatPrice = parseAmount(extra.seatPrice);
  if (amount === null || seatPrice === null || parseAmount(extra.maxGas) === null) {
    return refuse('invalid_offer', 'maxAmountRequired, extra.seatPrice and extra.maxGas must be decimal strings');
  }

  if (poolId !== expected.poolId) return refuse('wrong_pool', `extra.poolId is not ${expected.poolId}, the pool asked for`);
  if (seats > expected.maxSeats) {
    return refuse('too_many_seats', `extra.seats is above ${expected.maxSeats}, the seats asked for`);
  }

  const price = priceOf(seats, seatPrice);
  if (amount !== price) {
    return refuse('wrong_amount', `maxAmountRequired is not ${price}, the price of ${seats} seats at ${seatPrice}`);
  }
  if (amount > expected.maxAmount) return refuse('over_budget', `maxAmountRequired is above ${expected.maxAmount}, the budget`);
  return null;
}

/** Thrown by buildPaymentHeader, before anything is signed, for an offer that checkOffer refuses. */
export class OfferRefusedError extends Error {
  override name = 'OfferRefusedError';
  readonly code: OfferErrorCode;

  constructor(refusal: OfferRefusal) {
    super(`offer refused (${refusal.code}): ${refusal.detail}`);
    this.code = refusal.code;
  }
}

/**
 * `finalHeight + floor(maxTimeoutSeconds × 1000 / blockTimeMs)`: the latest expiry an offer allows,
 * from the chain's final height (the gateway judges expiry against it).
 */
export function maxBlockHeightFor(finalHeight: bigint, maxTimeoutSeconds: number, blockTimeMs: number): bigint {
  return finalHeight + BigInt(Math.floor((maxTimeoutSeconds * 1000) / blockTimeMs));
}

export interface ProofInput {
  keyPair: KeyPair;
  accountId: string;
  poolId: number;
  /** The gateway's host, such as `localhost:8402`. */
  recipient: string;
  nowMs: number;
  /** 24 random bytes for the rest of the nonce; generated when omitted. */
  random?: Uint8Array;
}

const TIME_BYTES = 8;
const RANDOM_BYTES = 24;

/** Builds and signs a redemption proof and returns the `X-QUORUM-PROOF` header value. */
export async function buildRedeemProofHeader(input: ProofInput): Promise<string> {
  const { keyPair, accountId, poolId, recipient, nowMs, random = randomBytes(RANDOM_BYTES) } = input;
  const nonce = proofNonce(nowMs, random);
  const message = redeemMessage(poolId);
  const signed = await new KeyPairSigner(keyPair).signNep413Message(accountId, { message, recipient, nonce });
  const proof: RedeemProof = {
    accountId: signed.accountId,
    publicKey: signed.publicKey.toString(),
    signature: base64(signed.signature),
    message,
    nonce: base64(nonce),
    recipient,
  };
  return encodeHeader(proof);
}

/** The 32-byte NEP-413 nonce: `nowMs` as a big-endian u64, then the random bytes. */
function proofNonce(nowMs: number, random: Uint8Array): Uint8Array {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new RangeError(`invalid nowMs: ${nowMs}`);
  if (random.length !== RANDOM_BYTES) {
    throw new RangeError(`random must be ${RANDOM_BYTES} bytes, got ${random.length}`);
  }
  const nonce = new Uint8Array(TIME_BYTES + RANDOM_BYTES);
  new DataView(nonce.buffer).setBigUint64(0, BigInt(nowMs));
  nonce.set(random, TIME_BYTES);
  return nonce;
}

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function refuse(code: OfferErrorCode, detail: string): OfferRefusal {
  return { code, detail };
}
```

`packages/protocol/src/index.ts`:

```typescript
export * from './constants.ts';
export * from './account.ts';
export * from './contract.ts';
export * from './amounts.ts';
export * from './codec.ts';
export * from './offer.ts';
export * from './delegate.ts';
export * from './nep413.ts';
export * from './checks.ts';
export * from './client.ts';
```

- [ ] **Step 4: Run the tests and the typecheck**

Run: `pnpm --filter @quorum-on-near/protocol exec vitest run test/checks.test.ts test/client.test.ts`

Expected: PASS, 147 tests (`test/checks.test.ts` 71, `test/client.test.ts` 76).

Run: `pnpm --filter @quorum-on-near/protocol typecheck`

Expected: no errors.

- [ ] **Step 5: Run the whole protocol suite**

Run: `pnpm --filter @quorum-on-near/protocol test`

Expected: PASS, 9 test files, 331 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/protocol
git commit -m "check quorum payments statically and build payments and proofs for buyers"
```


---

### Task 6: Gateway package, configuration and credentials

The gateway reads every setting from `QUORUM_*` variables (spec section 7.6) and refuses to start on any problem, listing them all; secret values never appear in the message. It runs on testnet only (`near:sandbox` is accepted for the local sandbox test), checks each keeper gas setting against what the contract requires at entry, bounds every gas setting at 300 Tgas, refuses a relayer key listed twice and a web folder that holds the gateway's own folder. `checkChainId` lets `main.ts` (Task 14) refuse an RPC that serves another chain than the configured network. The credential is an EdDSA compact JWS (spec section 6.6), signed with an Ed25519 key that is distinct from every NEAR key.

**Files:**
- Create: `apps/gateway/package.json`, `apps/gateway/tsconfig.json`, `apps/gateway/.env.example`, `apps/gateway/src/credential.ts`, `apps/gateway/src/config.ts`, `apps/gateway/src/keygen.ts`
- Modify: `pnpm-lock.yaml`
- Test: `apps/gateway/test/config.test.ts`, `apps/gateway/test/credential.test.ts`

**Interfaces:**
- Consumes: `isAccountId`, `Network` from `@quorum-on-near/protocol` (Tasks 1 to 5).
- Produces: `TESTNET_USDC`, `interface GatewayConfig` (every field of the table in `.env.example`), `class ConfigError`, `loadConfig(env: Record<string, string | undefined>): GatewayConfig`, `checkChainId(network: Network, chainId: string): string | null`; `interface CredentialInput {buyer, poolId, seats, terms}`, `interface CredentialIssuer {issue(input): Promise<string>; jwks(): {keys: JWK[]}}`, `isPrivateEd25519Jwk(value): boolean`, `createCredentialIssuer({jwk, issuer, now?, newId?}): Promise<CredentialIssuer>`, `generateCredentialJwk(): Promise<JWK>`; the `keygen` script.

- [ ] **Step 1: Write the gateway package manifest and install**

`apps/gateway/package.json`:

```json
{
  "name": "@quorum-on-near/gateway",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "node --env-file-if-exists=.env src/main.ts",
    "keygen": "node src/keygen.ts",
    "test": "vitest run --exclude \"test/sandbox/**\"",
    "test:sandbox": "vitest run test/sandbox",
    "typecheck": "tsc -p tsconfig.json"
  },
  "dependencies": {
    "@hono/node-server": "2.1.6",
    "@noble/hashes": "2.0.1",
    "@quorum-on-near/protocol": "workspace:*",
    "hono": "4.13.17",
    "jose": "6.2.17",
    "near-api-js": "7.4.0"
  },
  "devDependencies": {
    "@types/node": "22.20.5",
    "near-sandbox": "0.3.5",
    "typescript": "5.9.3",
    "vitest": "4.1.12"
  }
}
```

`apps/gateway/tsconfig.json`:

```json
{ "extends": "../../tsconfig.base.json", "include": ["src", "test"] }
```

```bash
mkdir -p apps/gateway/src apps/gateway/test
pnpm install
```

Expected: `pnpm-lock.yaml` gains the gateway's dependencies, and `@quorum-on-near/protocol` is linked from the workspace.

- [ ] **Step 2: Write the failing tests**

`apps/gateway/test/config.test.ts`:

```typescript
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv, promisify } from 'node:util';
import { KeyPair } from 'near-api-js';
import { describe, expect, it } from 'vitest';
import { checkChainId, ConfigError, loadConfig, TESTNET_USDC, type GatewayConfig } from '../src/config.ts';
import { generateCredentialJwk } from '../src/credential.ts';

const EXAMPLE = fileURLToPath(new URL('../.env.example', import.meta.url));
const PARENT = 'parent.testnet';
const RELAYER_KEY = KeyPair.fromRandom('ed25519').toString();
const CREDENTIAL_JWK = await generateCredentialJwk();

/** The three required variables, plus `overrides` (`undefined` unsets one). */
function env(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    QUORUM_PARENT_ACCOUNT: PARENT,
    QUORUM_RELAYER_KEYS: RELAYER_KEY,
    QUORUM_CREDENTIAL_JWK: JSON.stringify(CREDENTIAL_JWK),
    ...overrides,
  };
}

/** The problem lines of the ConfigError that loadConfig throws for `vars`. */
function problems(vars: Record<string, string | undefined>): string[] {
  try {
    loadConfig(vars);
  } catch (error) {
    if (error instanceof ConfigError) return error.message.split('\n');
    throw error;
  }
  throw new Error('loadConfig accepted the configuration');
}

describe('loadConfig', () => {
  it('applies every default when only the three required variables are set', () => {
    expect(loadConfig(env())).toEqual<GatewayConfig>({
      network: 'near:testnet',
      rpcUrl: 'https://test.rpc.fastnear.com',
      publicUrl: 'http://localhost:8402',
      port: 8402,
      parent: PARENT,
      token: TESTNET_USDC,
      poolsContract: 'pools.parent.testnet',
      relayer: 'relay.parent.testnet',
      provider: 'provider.parent.testnet',
      relayerKeys: [RELAYER_KEY],
      credentialJwk: CREDENTIAL_JWK,
      minGas: 50_000_000_000_000n,
      maxGas: 100_000_000_000_000n,
      maxTimeoutSeconds: 120,
      blockTimeMs: 1000,
      keeperIntervalMs: 5000,
      refundLimit: 10,
      settleGas: 100_000_000_000_000n,
      refundGas: 300_000_000_000_000n,
      dataDir: 'data',
      webDir: '../web',
      rpcPassthrough: false,
      explorerTxUrl: 'https://testnet.nearblocks.io/txns/',
    });
  });

  it('derives the pools, relayer and provider accounts from the parent', () => {
    const config = loadConfig(env({ QUORUM_PARENT_ACCOUNT: 'quorum-test.testnet' }));
    expect([config.poolsContract, config.relayer, config.provider]).toEqual([
      'pools.quorum-test.testnet',
      'relay.quorum-test.testnet',
      'provider.quorum-test.testnet',
    ]);
  });

  it('reads every variable that is set', () => {
    const secondKey = KeyPair.fromRandom('ed25519').toString();
    const config = loadConfig(
      env({
        QUORUM_NETWORK: 'near:sandbox',
        QUORUM_RPC_URL: 'http://127.0.0.1:3030',
        QUORUM_GATEWAY_URL: 'https://gateway.example',
        QUORUM_GATEWAY_PORT: '9000',
        QUORUM_TOKEN_ACCOUNT: 'usdc.testnet',
        QUORUM_POOLS_ACCOUNT: 'pools-v2.testnet',
        QUORUM_RELAYER_ACCOUNT: 'relayer_1.testnet',
        QUORUM_PROVIDER_ACCOUNT: 'gpu.testnet',
        QUORUM_RELAYER_KEYS: `${RELAYER_KEY},${secondKey}`,
        QUORUM_COMMIT_MIN_GAS: '30000000000000',
        QUORUM_COMMIT_MAX_GAS: '30000000000000',
        QUORUM_MAX_TIMEOUT_SECONDS: '60',
        QUORUM_BLOCK_TIME_MS: '600',
        QUORUM_KEEPER_INTERVAL_MS: '2000',
        QUORUM_REFUND_LIMIT: '1',
        QUORUM_SETTLE_GAS: '80000000000000',
        QUORUM_REFUND_GAS: '250000000000000',
        QUORUM_DATA_DIR: '/var/lib/quorum',
        QUORUM_WEB_DIR: 'public',
        QUORUM_RPC_PASSTHROUGH: 'true',
        QUORUM_EXPLORER_TX_URL: 'https://explorer.example/txns/',
      }),
    );
    expect(config).toEqual<GatewayConfig>({
      network: 'near:sandbox',
      rpcUrl: 'http://127.0.0.1:3030',
      publicUrl: 'https://gateway.example',
      port: 9000,
      parent: PARENT,
      token: 'usdc.testnet',
      poolsContract: 'pools-v2.testnet',
      relayer: 'relayer_1.testnet',
      provider: 'gpu.testnet',
      relayerKeys: [RELAYER_KEY, secondKey],
      credentialJwk: CREDENTIAL_JWK,
      minGas: 30_000_000_000_000n,
      maxGas: 30_000_000_000_000n,
      maxTimeoutSeconds: 60,
      blockTimeMs: 600,
      keeperIntervalMs: 2000,
      refundLimit: 1,
      settleGas: 80_000_000_000_000n,
      refundGas: 250_000_000_000_000n,
      dataDir: '/var/lib/quorum',
      webDir: 'public',
      rpcPassthrough: true,
      explorerTxUrl: 'https://explorer.example/txns/',
    });
  });

  it('ignores spaces and empty entries in the relayer key list', () => {
    const secondKey = KeyPair.fromRandom('ed25519').toString();
    const config = loadConfig(env({ QUORUM_RELAYER_KEYS: ` ${RELAYER_KEY} , ${secondKey},` }));
    expect(config.relayerKeys).toEqual([RELAYER_KEY, secondKey]);
  });

  it('removes the trailing slash from the gateway URL', () => {
    expect(loadConfig(env({ QUORUM_GATEWAY_URL: 'https://gateway.example/' })).publicUrl).toBe(
      'https://gateway.example',
    );
  });

  it('removes every trailing slash from a gateway URL with a path', () => {
    expect(loadConfig(env({ QUORUM_GATEWAY_URL: 'https://example.com/quorum//' })).publicUrl).toBe(
      'https://example.com/quorum',
    );
  });

  it('treats an empty QUORUM_WEB_DIR as serving nothing', () => {
    expect(loadConfig(env({ QUORUM_WEB_DIR: '' })).webDir).toBeNull();
  });

  it.each(['QUORUM_PARENT_ACCOUNT', 'QUORUM_RELAYER_KEYS', 'QUORUM_CREDENTIAL_JWK'])(
    'reports %s as required when it is unset',
    (name) => {
      expect(problems(env({ [name]: undefined }))).toEqual([`${name} is required`]);
    },
  );

  it.each(['QUORUM_PARENT_ACCOUNT', 'QUORUM_RELAYER_KEYS', 'QUORUM_CREDENTIAL_JWK'])(
    'reports %s as required when it is empty',
    (name) => {
      expect(problems(env({ [name]: '' }))).toEqual([`${name} is required`]);
    },
  );

  it.each([
    ['QUORUM_NETWORK', 'testnet'],
    ['QUORUM_NETWORK', 'near:Testnet'],
    ['QUORUM_RPC_URL', 'not a url'],
    ['QUORUM_RPC_URL', 'ws://rpc.example'],
    ['QUORUM_GATEWAY_URL', 'localhost:8402'],
    ['QUORUM_GATEWAY_PORT', '0'],
    ['QUORUM_GATEWAY_PORT', '65536'],
    ['QUORUM_GATEWAY_PORT', '84O2'],
    ['QUORUM_PARENT_ACCOUNT', 'Parent.testnet'],
    ['QUORUM_PARENT_ACCOUNT', 'a'],
    ['QUORUM_PARENT_ACCOUNT', `${'a'.repeat(57)}.testnet`],
    ['QUORUM_TOKEN_ACCOUNT', 'usdc..testnet'],
    ['QUORUM_POOLS_ACCOUNT', 'pools_.testnet'],
    ['QUORUM_POOLS_ACCOUNT', ''],
    ['QUORUM_RELAYER_ACCOUNT', '-relay.testnet'],
    ['QUORUM_PROVIDER_ACCOUNT', 'provider.testnet.'],
    ['QUORUM_COMMIT_MIN_GAS', '0'],
    ['QUORUM_COMMIT_MIN_GAS', '1e14'],
    ['QUORUM_COMMIT_MAX_GAS', '-1'],
    ['QUORUM_MAX_TIMEOUT_SECONDS', '0'],
    ['QUORUM_MAX_TIMEOUT_SECONDS', '1.5'],
    ['QUORUM_BLOCK_TIME_MS', ''],
    ['QUORUM_KEEPER_INTERVAL_MS', '5s'],
    ['QUORUM_REFUND_LIMIT', '0'],
    ['QUORUM_REFUND_LIMIT', '11'],
    ['QUORUM_SETTLE_GAS', '100 Tgas'],
    ['QUORUM_REFUND_GAS', '0'],
    ['QUORUM_DATA_DIR', ''],
    ['QUORUM_RPC_PASSTHROUGH', 'yes'],
    ['QUORUM_RPC_PASSTHROUGH', 'TRUE'],
    ['QUORUM_EXPLORER_TX_URL', 'nearblocks.io/txns/'],
  ])('reports %s = %j as invalid', (name, value) => {
    expect(problems(env({ [name]: value }))).toEqual([expect.stringMatching(new RegExp(`^${name} must be `))]);
  });

  // Labelled rather than printed: these values are, or contain, key material.
  it.each([
    ['no key', ','],
    ['a value that is not base58', 'ed25519:not-base58'],
    ['a secp256k1 secret key', KeyPair.fromRandom('secp256k1').toString()],
    ['an ed25519 public key', KeyPair.fromRandom('ed25519').getPublicKey().toString()],
  ])('reports QUORUM_RELAYER_KEYS holding %s as invalid', (_label, value) => {
    expect(problems(env({ QUORUM_RELAYER_KEYS: value }))).toEqual([
      'QUORUM_RELAYER_KEYS must be a comma-separated list of ed25519 secret keys',
    ]);
  });

  it('reports QUORUM_RELAYER_KEYS as invalid when one key of several is invalid', () => {
    const value = `${RELAYER_KEY},${KeyPair.fromRandom('ed25519').getPublicKey().toString()}`;
    expect(problems(env({ QUORUM_RELAYER_KEYS: value }))).toEqual([
      'QUORUM_RELAYER_KEYS must be a comma-separated list of ed25519 secret keys',
    ]);
  });

  it.each([
    ['text that is not JSON', 'not json'],
    ['a JSON array', '[]'],
    ['a public key', JSON.stringify({ ...CREDENTIAL_JWK, d: undefined })],
    ['an X25519 key', JSON.stringify({ ...CREDENTIAL_JWK, crv: 'X25519' })],
    ['an EC key', JSON.stringify({ ...CREDENTIAL_JWK, kty: 'EC' })],
  ])('reports QUORUM_CREDENTIAL_JWK holding %s as invalid', (_label, value) => {
    expect(problems(env({ QUORUM_CREDENTIAL_JWK: value }))).toEqual([
      'QUORUM_CREDENTIAL_JWK must be a private Ed25519 JWK (JSON with kty "OKP", crv "Ed25519", x and d)',
    ]);
  });

  it('reports a maximum commit gas below the minimum', () => {
    expect(problems(env({ QUORUM_COMMIT_MIN_GAS: '60000000000000', QUORUM_COMMIT_MAX_GAS: '50000000000000' }))).toEqual(
      ['QUORUM_COMMIT_MAX_GAS must be at least QUORUM_COMMIT_MIN_GAS (60000000000000), got "50000000000000"'],
    );
  });

  it('reports a derived account that is too long to be valid', () => {
    // 56 characters: pools.<parent> and relay.<parent> fit in 64, provider.<parent> does not.
    const parent = `${'a'.repeat(48)}.testnet`;
    expect(problems(env({ QUORUM_PARENT_ACCOUNT: parent }))).toEqual([
      `QUORUM_PROVIDER_ACCOUNT must be a NEAR account id, got "provider.${parent}"`,
    ]);
  });

  it('reports several problems together, in the order of the variables', () => {
    expect(
      problems({
        QUORUM_GATEWAY_PORT: '0',
        QUORUM_CREDENTIAL_JWK: '{}',
        QUORUM_RPC_PASSTHROUGH: 'yes',
      }),
    ).toEqual([
      'QUORUM_GATEWAY_PORT must be an integer from 1 to 65535, got "0"',
      'QUORUM_PARENT_ACCOUNT is required',
      'QUORUM_RELAYER_KEYS is required',
      'QUORUM_CREDENTIAL_JWK must be a private Ed25519 JWK (JSON with kty "OKP", crv "Ed25519", x and d)',
      'QUORUM_RPC_PASSTHROUGH must be true or false, got "yes"',
    ]);
  });

  it('never repeats a relayer key or the credential key in its problems', () => {
    const relayerKey = KeyPair.fromRandom('secp256k1').toString();
    const jwk = JSON.stringify({ ...CREDENTIAL_JWK, crv: 'X25519' });
    const message = problems(env({ QUORUM_RELAYER_KEYS: relayerKey, QUORUM_CREDENTIAL_JWK: jwk })).join('\n');
    expect(message).not.toContain(relayerKey.slice('secp256k1:'.length));
    expect(message).not.toContain(CREDENTIAL_JWK.d);
  });

  it('ships an example file whose values, once the required ones are filled in, are the defaults', async () => {
    const example = parseEnv(await readFile(EXAMPLE, 'utf8'));
    const filled = { ...example, ...env() };
    expect(loadConfig(filled)).toEqual(loadConfig(env()));
  });

  it('ships an example file that lists exactly the variables loadConfig reads', async () => {
    const read = new Set<string>();
    const tracked = new Proxy(env(), {
      get: (target, name) => {
        if (typeof name === 'string') read.add(name);
        return Reflect.get(target, name);
      },
    });
    loadConfig(tracked);
    const listed = [...(await readFile(EXAMPLE, 'utf8')).matchAll(/^#?(QUORUM_[A-Z_]+)=/gm)].map((m) => m[1]);
    expect(listed.sort()).toEqual([...read].sort());
  });

  it('accepts the credential key line that keygen prints', async () => {
    const keygen = fileURLToPath(new URL('../src/keygen.ts', import.meta.url));
    const { stdout } = await promisify(execFile)(process.execPath, [keygen]);
    const [, jwk] = /^QUORUM_CREDENTIAL_JWK=(\{.*\})\n$/.exec(stdout) ?? [];
    expect(jwk).toBeDefined();
    expect(loadConfig(env({ QUORUM_CREDENTIAL_JWK: jwk })).credentialJwk).toEqual({
      kty: 'OKP',
      crv: 'Ed25519',
      x: expect.any(String),
      d: expect.any(String),
    });
  });
});

describe('loadConfig network', () => {
  it.each(['near:testnet', 'near:sandbox'])('accepts %s', (network) => {
    expect(loadConfig(env({ QUORUM_NETWORK: network })).network).toBe(network);
  });

  it.each(['near:mainnet', 'near:localnet'])('refuses %s: the gateway runs on testnet only', (network) => {
    expect(problems(env({ QUORUM_NETWORK: network }))).toEqual([
      `QUORUM_NETWORK must be near:testnet or near:sandbox (the gateway runs on no other network), got "${network}"`,
    ]);
  });
});

describe('checkChainId', () => {
  it.each([
    ['near:testnet', 'testnet'],
    // A sandbox initialised without a chain id gets test-chain- and 5 random characters.
    ['near:sandbox', 'test-chain-a1B2c'],
    ['near:sandbox', 'localnet'],
  ] as const)('accepts %s on the chain %j', (network, chainId) => {
    expect(checkChainId(network, chainId)).toBeNull();
  });

  it.each(['mainnet', 'test-chain-a1B2c', 'Testnet', ''])('refuses near:testnet on the chain %j', (chainId) => {
    expect(checkChainId('near:testnet', chainId)).toBe(
      `QUORUM_NETWORK is near:testnet, but QUORUM_RPC_URL serves the chain ${JSON.stringify(chainId)}, not "testnet"`,
    );
  });

  it.each(['mainnet', 'testnet'])('refuses near:sandbox on the public chain %j', (chainId) => {
    expect(checkChainId('near:sandbox', chainId)).toBe(
      `QUORUM_NETWORK is near:sandbox, but QUORUM_RPC_URL serves NEAR's public chain ${JSON.stringify(chainId)}`,
    );
  });
});

describe('loadConfig gas', () => {
  const MOST = '300000000000000';

  it('accepts the gas the pools contract requires at entry, at the smallest and the largest refund limit', () => {
    const atLimit = (limit: string, refundGas: string) =>
      loadConfig(
        env({ QUORUM_REFUND_LIMIT: limit, QUORUM_SETTLE_GAS: '33000000000000', QUORUM_REFUND_GAS: refundGas }),
      );
    // settle: 10 + 23 Tgas; refund: 10 + 23 × (limit + 1) Tgas.
    expect(atLimit('1', '56000000000000')).toMatchObject({ settleGas: 33_000_000_000_000n, refundGas: 56_000_000_000_000n });
    expect(atLimit('10', '263000000000000').refundGas).toBe(263_000_000_000_000n);
  });

  it('accepts 300 Tgas, the most gas the gateway attaches to one call', () => {
    const config = loadConfig(
      env({ QUORUM_COMMIT_MIN_GAS: MOST, QUORUM_COMMIT_MAX_GAS: MOST, QUORUM_SETTLE_GAS: MOST, QUORUM_REFUND_GAS: MOST }),
    );
    expect([config.minGas, config.maxGas, config.settleGas, config.refundGas]).toEqual(Array(4).fill(BigInt(MOST)));
  });

  const SETTLE_FROM = '33000000000000 (what settle requires at entry)';
  const REFUND_FROM = '263000000000000 (what refund requires at entry with QUORUM_REFUND_LIMIT 10)';
  it.each([
    ['QUORUM_COMMIT_MIN_GAS', '0', '1'],
    ['QUORUM_COMMIT_MIN_GAS', '300000000000001', '1'],
    ['QUORUM_COMMIT_MAX_GAS', '300000000000001', '1'],
    ['QUORUM_SETTLE_GAS', '32999999999999', SETTLE_FROM],
    ['QUORUM_SETTLE_GAS', '300000000000001', SETTLE_FROM],
    ['QUORUM_REFUND_GAS', '300000000000001', REFUND_FROM],
  ])('reports %s = %s out of its range', (name, gas, from) => {
    expect(problems(env({ [name]: gas }))).toEqual([
      `${name} must be an amount of gas from ${from} to 300000000000000 (300 Tgas, the most the gateway attaches to one call), got "${gas}"`,
    ]);
  });

  it.each([
    ['10', '262999999999999', '263000000000000'],
    ['3', '100000000000000', '102000000000000'],
    ['1', '55999999999999', '56000000000000'],
  ])('reports refund gas below what refund requires at entry with QUORUM_REFUND_LIMIT %s', (limit, gas, needed) => {
    expect(problems(env({ QUORUM_REFUND_LIMIT: limit, QUORUM_REFUND_GAS: gas }))).toEqual([
      `QUORUM_REFUND_GAS must be an amount of gas from ${needed} (what refund requires at entry with QUORUM_REFUND_LIMIT ${limit}) to 300000000000000 (300 Tgas, the most the gateway attaches to one call), got "${gas}"`,
    ]);
  });

  it('checks the refund gas only against the range when the refund limit is invalid', () => {
    expect(problems(env({ QUORUM_REFUND_LIMIT: '11', QUORUM_REFUND_GAS: '1' }))).toEqual([
      'QUORUM_REFUND_LIMIT must be an integer from 1 to 10, got "11"',
    ]);
  });
});

describe('loadConfig relayer keys', () => {
  it('reports a key listed twice, by position, without the key', () => {
    const secondKey = KeyPair.fromRandom('ed25519').toString();
    const message = problems(env({ QUORUM_RELAYER_KEYS: `${RELAYER_KEY}, ${secondKey},,${RELAYER_KEY}` }));
    expect(message).toEqual(['QUORUM_RELAYER_KEYS must list each key once: keys 1 and 3 are the same']);
  });
});

describe('loadConfig web folder', () => {
  // The folder this package lives in, which holds its .env file.
  const GATEWAY_DIR = resolve(fileURLToPath(new URL('..', import.meta.url)));

  it.each([
    ['the gateway folder', GATEWAY_DIR],
    ['the gateway folder relative to the current folder', relative(process.cwd(), GATEWAY_DIR) || '.'],
    ['a folder above the gateway folder', dirname(GATEWAY_DIR)],
    ['a folder two levels above it', dirname(dirname(GATEWAY_DIR))],
  ])('refuses %s, which would publish its .env file', (_label, dir) => {
    expect(problems(env({ QUORUM_WEB_DIR: dir }))).toEqual([
      `QUORUM_WEB_DIR must be empty, or a folder that neither is nor contains the gateway's own folder (${GATEWAY_DIR}), got ${JSON.stringify(dir)}`,
    ]);
  });

  it.each([
    ['a folder inside the gateway folder', join(GATEWAY_DIR, 'public')],
    ['a sibling of the gateway folder', join(dirname(GATEWAY_DIR), 'web')],
    ['a sibling whose name starts with the gateway folder name', `${GATEWAY_DIR}-web`],
  ])('accepts %s', (_label, dir) => {
    expect(loadConfig(env({ QUORUM_WEB_DIR: dir })).webDir).toBe(dir);
  });
});
```

`apps/gateway/test/credential.test.ts`:

```typescript
import {
  calculateJwkThumbprint,
  createLocalJWKSet,
  decodeJwt,
  decodeProtectedHeader,
  exportJWK,
  generateKeyPair,
  jwtVerify,
  type JWK,
} from 'jose';
import { describe, expect, it } from 'vitest';
import { createCredentialIssuer, generateCredentialJwk, type CredentialInput } from '../src/credential.ts';

const ISSUER = 'http://localhost:8402';
const NOW_MS = 1_799_999_000_500;
const INPUT: CredentialInput = {
  buyer: 'alice.testnet',
  poolId: 7,
  seats: 3,
  terms: '8×GPU × 24 h; 1 seat = 1 GPU-hour',
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

async function newIssuer(options: { jwk?: JWK; newId?: () => string } = {}) {
  const jwk = options.jwk ?? (await generateCredentialJwk());
  const issuer = await createCredentialIssuer({ jwk, issuer: ISSUER, now: () => NOW_MS, ...options });
  return { jwk, issuer };
}

async function privateJwk(alg: string, crv?: string): Promise<JWK> {
  const { privateKey } = await generateKeyPair(alg, { crv, extractable: true });
  return exportJWK(privateKey);
}

describe('generateCredentialJwk', () => {
  it('generates a private Ed25519 JWK', async () => {
    const jwk = await generateCredentialJwk();
    expect(jwk).toEqual({
      kty: 'OKP',
      crv: 'Ed25519',
      x: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      d: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    });
  });

  it('generates a different key each time', async () => {
    const [a, b] = await Promise.all([generateCredentialJwk(), generateCredentialJwk()]);
    expect(a.d).not.toBe(b.d);
  });
});

describe('createCredentialIssuer', () => {
  it('issues a credential that verifies against its JWKS', async () => {
    const { issuer } = await newIssuer();
    const credential = await issuer.issue(INPUT);
    const { payload } = await jwtVerify(credential, createLocalJWKSet(issuer.jwks()), {
      issuer: ISSUER,
      algorithms: ['EdDSA'],
      currentDate: new Date(NOW_MS),
    });
    expect(payload.sub).toBe(INPUT.buyer);
  });

  it('does not verify a credential against another key', async () => {
    const { issuer } = await newIssuer();
    const { issuer: other } = await newIssuer();
    const credential = await issuer.issue(INPUT);
    await expect(jwtVerify(credential, createLocalJWKSet(other.jwks()))).rejects.toThrow();
  });

  it('signs with alg EdDSA and the key thumbprint as kid', async () => {
    const { jwk, issuer } = await newIssuer();
    const kid = await calculateJwkThumbprint({ kty: 'OKP', crv: 'Ed25519', x: jwk.x });
    expect(decodeProtectedHeader(await issuer.issue(INPUT))).toEqual({ alg: 'EdDSA', kid, typ: 'JWT' });
  });

  it('carries the issuer, buyer, pool, seats, terms, issue time, id and simulated claims', async () => {
    const { issuer } = await newIssuer({ newId: () => 'credential-1' });
    expect(decodeJwt(await issuer.issue(INPUT))).toEqual({
      iss: ISSUER,
      sub: 'alice.testnet',
      pool: 7,
      seats: 3,
      terms: INPUT.terms,
      iat: 1_799_999_000,
      jti: 'credential-1',
      simulated: true,
    });
  });

  it('uses a fresh UUID as jti by default', async () => {
    const { issuer } = await newIssuer();
    expect(decodeJwt(await issuer.issue(INPUT)).jti).toMatch(UUID);
  });

  it('gives two credentials for the same buyer, pool and seats the same sub, pool and seats and different jti', async () => {
    const { issuer } = await newIssuer();
    const first = decodeJwt(await issuer.issue(INPUT));
    const second = decodeJwt(await issuer.issue(INPUT));
    expect([second.sub, second.pool, second.seats]).toEqual([first.sub, first.pool, first.seats]);
    expect(second.jti).not.toBe(first.jti);
  });

  it('publishes a JWKS with the public key only', async () => {
    const { jwk, issuer } = await newIssuer();
    const kid = await calculateJwkThumbprint({ kty: 'OKP', crv: 'Ed25519', x: jwk.x });
    const { keys } = issuer.jwks();
    expect(keys).toEqual([{ kty: 'OKP', crv: 'Ed25519', x: jwk.x, kid, alg: 'EdDSA', use: 'sig' }]);
    expect(keys[0]).not.toHaveProperty('d');
  });

  it('returns a JWKS that callers cannot change', async () => {
    const { issuer } = await newIssuer();
    const before = issuer.jwks();
    issuer.jwks().keys.length = 0;
    expect(issuer.jwks()).toEqual(before);
  });

  it.each([
    ['an EC key', () => privateJwk('ES256')],
    ['an X25519 key', () => privateJwk('ECDH-ES', 'X25519')],
    ['a public Ed25519 key', async () => ({ ...(await generateCredentialJwk()), d: undefined })],
    ['a symmetric key', async () => ({ kty: 'oct', k: 'AAAAAAAAAAAAAAAAAAAAAA' })],
  ])('refuses %s', async (_name, makeJwk) => {
    const jwk = await makeJwk();
    await expect(createCredentialIssuer({ jwk, issuer: ISSUER })).rejects.toThrow(/Ed25519/);
  });

  it('refuses an Ed25519 JWK whose public part does not match its private part', async () => {
    const jwk = { ...(await generateCredentialJwk()), x: (await generateCredentialJwk()).x };
    await expect(createCredentialIssuer({ jwk, issuer: ISSUER })).rejects.toThrow();
  });
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `pnpm --filter @quorum-on-near/gateway exec vitest run test/config.test.ts test/credential.test.ts`

Expected: FAIL. vitest cannot load `../src/config.ts` and `../src/credential.ts`, which do not exist yet.

- [ ] **Step 4: Write the implementation**

The configuration reference, with every variable and its default:

`apps/gateway/.env.example`:

```bash
# Gateway configuration. Copy to .env and fill in the three required values (left empty here).
# Every other line shows its default, which applies when the variable is unset.

# NEAR network, in CAIP-2 form: near:testnet, or near:sandbox for a local test chain. No other is accepted.
# The gateway exits at startup unless QUORUM_RPC_URL serves that chain (testnet, or any non-public chain).
QUORUM_NETWORK=near:testnet
# NEAR RPC endpoint. Public: unless QUORUM_RPC_PASSTHROUGH is true, /config.json gives it to the live page,
# so it must not carry an API key.
QUORUM_RPC_URL=https://test.rpc.fastnear.com
# The gateway's public base URL: the credential issuer, and the recipient redemption proofs name.
QUORUM_GATEWAY_URL=http://localhost:8402
# Port the gateway listens on.
QUORUM_GATEWAY_PORT=8402
# Required. The parent account the gateway's accounts are created under.
QUORUM_PARENT_ACCOUNT=
# Token the pools contract was initialised with (Circle's USDC on testnet).
QUORUM_TOKEN_ACCOUNT=3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af
# Pools contract account. Unset means pools.<parent>.
#QUORUM_POOLS_ACCOUNT=
# Account that relays payments and pays their gas. Unset means relay.<parent>.
#QUORUM_RELAYER_ACCOUNT=
# The only seller whose pools the gateway serves. Unset means provider.<parent>.
#QUORUM_PROVIDER_ACCOUNT=
# Required, secret. The relayer account's full-access secret keys, comma-separated ed25519:... values, each listed once.
QUORUM_RELAYER_KEYS=
# Required, secret. Private Ed25519 JWK that signs credentials; `node src/keygen.ts` prints one.
QUORUM_CREDENTIAL_JWK=
# Least gas a payment's ft_transfer_call may attach. Every gas value is at most 300000000000000 (300 Tgas).
QUORUM_COMMIT_MIN_GAS=50000000000000
# Most gas a payment's ft_transfer_call may attach; at least the minimum.
QUORUM_COMMIT_MAX_GAS=100000000000000
# Longest a signed payment may stay valid, in seconds; bounds its max block height.
QUORUM_MAX_TIMEOUT_SECONDS=120
# Block time used to turn that timeout into blocks, in milliseconds.
QUORUM_BLOCK_TIME_MS=1000
# How often the keeper looks for pools to settle or refund, in milliseconds.
QUORUM_KEEPER_INTERVAL_MS=5000
# Buyers refunded per refund call, from 1 to 10.
QUORUM_REFUND_LIMIT=10
# Gas attached to a settle call. settle requires 33000000000000 left at entry and uses a few Tgas before
# that check; a value below the requirement is refused.
QUORUM_SETTLE_GAS=100000000000000
# Gas attached to a refund call. refund requires 10 + 23 x (QUORUM_REFUND_LIMIT + 1) Tgas left at entry
# (263000000000000 at a limit of 10) and uses a few Tgas before that check; a value below it is refused.
QUORUM_REFUND_GAS=300000000000000
# Folder for the activity feed.
QUORUM_DATA_DIR=data
# Folder of the live page, served at /. Empty serves nothing there. Never this folder or one above it,
# which would publish .env; files and folders whose names start with a dot are never served.
QUORUM_WEB_DIR=../web
# true lets the live page call the pools and token views through POST /rpc.
QUORUM_RPC_PASSTHROUGH=false
# Explorer URL prefix that a transaction hash is appended to.
QUORUM_EXPLORER_TX_URL=https://testnet.nearblocks.io/txns/
```

`apps/gateway/src/credential.ts`:

```typescript
import { randomUUID } from 'node:crypto';
import { calculateJwkThumbprint, exportJWK, generateKeyPair, importJWK, SignJWT, type JWK } from 'jose';

export interface CredentialInput {
  buyer: string;
  poolId: number;
  seats: number;
  terms: string;
}

export interface CredentialIssuer {
  /**
   * A compact JWS, `alg: "EdDSA"`, header `kid` = the key's RFC 7638 thumbprint, with claims
   * `iss` (the gateway URL), `sub` (the buyer), `pool`, `seats`, `terms`, `iat` (seconds), `jti` (a
   * fresh UUID) and `simulated: true`.
   */
  issue(input: CredentialInput): Promise<string>;
  /** `{ keys: [public JWK with kid, alg: "EdDSA", use: "sig"] }`, with no private part. */
  jwks(): { keys: JWK[] };
}

const ALG = 'EdDSA';

/** Whether `value` is a private Ed25519 JWK: `kty: "OKP"`, `crv: "Ed25519"`, and `x` and `d` set. */
export function isPrivateEd25519Jwk(value: unknown): value is JWK & { x: string; d: string } {
  if (typeof value !== 'object' || value === null) return false;
  const { kty, crv, x, d } = value as Record<string, unknown>;
  return kty === 'OKP' && crv === 'Ed25519' && typeof x === 'string' && x !== '' && typeof d === 'string' && d !== '';
}

/** Builds an issuer from a private Ed25519 JWK (`kty: "OKP"`, `crv: "Ed25519"`, `x`, `d`). */
export async function createCredentialIssuer(opts: {
  jwk: JWK;
  issuer: string;
  now?: () => number;
  newId?: () => string;
}): Promise<CredentialIssuer> {
  const { jwk, issuer, now = Date.now, newId = randomUUID } = opts;
  if (!isPrivateEd25519Jwk(jwk)) {
    throw new TypeError('the credential key must be a private Ed25519 JWK (kty "OKP", crv "Ed25519", x and d)');
  }
  // The import also fails when `x` is not the public key of `d`.
  const key = await importJWK(jwk, ALG);
  const publicJwk: JWK = { kty: 'OKP', crv: 'Ed25519', x: jwk.x };
  const kid = await calculateJwkThumbprint(publicJwk);

  return {
    issue: ({ buyer, poolId, seats, terms }) =>
      new SignJWT({ pool: poolId, seats, terms, simulated: true })
        .setProtectedHeader({ alg: ALG, kid, typ: 'JWT' })
        .setIssuer(issuer)
        .setSubject(buyer)
        .setIssuedAt(Math.floor(now() / 1000))
        .setJti(newId())
        .sign(key),
    jwks: () => ({ keys: [{ ...publicJwk, kid, alg: ALG, use: 'sig' }] }),
  };
}

/** A new private Ed25519 JWK, for the credential key. */
export async function generateCredentialJwk(): Promise<JWK> {
  const { privateKey } = await generateKeyPair(ALG, { crv: 'Ed25519', extractable: true });
  return exportJWK(privateKey);
}
```

`apps/gateway/src/config.ts`:

```typescript
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAccountId, type Network } from '@quorum-on-near/protocol';
import type { JWK } from 'jose';
import { baseDecode, KeyPair, type KeyPairString } from 'near-api-js';
import { isPrivateEd25519Jwk } from './credential.ts';

/** Circle's USDC on NEAR testnet. */
export const TESTNET_USDC = '3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af';

export interface GatewayConfig {
  /** `near:testnet`, or `near:sandbox` for a local test chain. */
  network: Network;
  /** Public: `/config.json` gives it to the live page unless `rpcPassthrough` is on. */
  rpcUrl: string;
  /** The gateway's public base URL, without a trailing slash. */
  publicUrl: string;
  port: number;
  parent: string;
  token: string;
  poolsContract: string;
  relayer: string;
  provider: string;
  /** The relayer account's secret keys, `ed25519:<base58>`. */
  relayerKeys: string[];
  /** The private Ed25519 JWK that signs credentials. */
  credentialJwk: JWK;
  minGas: bigint;
  maxGas: bigint;
  maxTimeoutSeconds: number;
  blockTimeMs: number;
  keeperIntervalMs: number;
  refundLimit: number;
  settleGas: bigint;
  refundGas: bigint;
  dataDir: string;
  /** The live page's folder, served at `/`, or null to serve nothing there. */
  webDir: string | null;
  rpcPassthrough: boolean;
  explorerTxUrl: string;
}

/** Thrown by loadConfig with one line per missing or invalid variable. */
export class ConfigError extends Error {
  override name = 'ConfigError';
}

/** How one variable is read. */
interface Rule<T> {
  /** Completes "<VARIABLE> must be …". */
  expected: string;
  /** The value, or undefined when `raw` is invalid. */
  parse(raw: string): T | undefined;
  /** Keep the raw value out of the problem line. */
  secret?: boolean;
}

/** The networks the gateway runs on. */
const NETWORKS: Network[] = ['near:testnet', 'near:sandbox'];
const INTEGER = /^(0|[1-9][0-9]*)$/;
const ED25519_PREFIX = 'ed25519:';
const TGAS = 1_000_000_000_000n;
/**
 * The most gas the gateway attaches to one call: 300 Tgas. A deliberately conservative bound of the
 * gateway's own, not a protocol limit: the largest call the gateway makes is a full refund batch,
 * which needs about 280 Tgas attached (spec section 5.4).
 */
const MAX_CALL_GAS = 300n * TGAS;
/** NEAR's public chains, by the `chain_id` their RPC nodes report. */
const PUBLIC_CHAINS = ['mainnet', 'testnet'];
/** The gateway's own folder, which holds its `.env` file. */
const GATEWAY_DIR = resolve(fileURLToPath(new URL('..', import.meta.url)));

/**
 * The gas the pools contract asserts at the entry of a call that schedules `transfers` transfers:
 * 10 Tgas for its own work, then 10 for each transfer, 10 for its callback and 3 for their receipts.
 * `settle` schedules 1; `refund` up to its limit, plus the dust.
 */
function gasRequiredAtEntry(transfers: number): bigint {
  return 10n * TGAS + BigInt(transfers) * 23n * TGAS;
}

/** Whether `dir` is `inner` or a folder above it. */
function holds(dir: string, inner: string): boolean {
  const path = relative(dir, inner);
  return path === '' || (!isAbsolute(path) && path.split(sep)[0] !== '..');
}

const asNetwork: Rule<Network> = {
  expected: `${NETWORKS.join(' or ')} (the gateway runs on no other network)`,
  parse: (raw) => NETWORKS.find((network) => network === raw),
};

const asHttpUrl: Rule<string> = {
  expected: 'an http or https URL',
  parse: (raw) => (URL.canParse(raw) && ['http:', 'https:'].includes(new URL(raw).protocol) ? raw : undefined),
};

const asBaseUrl: Rule<string> = {
  expected: asHttpUrl.expected,
  parse: (raw) => asHttpUrl.parse(raw)?.replace(/\/+$/, ''),
};

const asAccountId: Rule<string> = {
  expected: 'a NEAR account id',
  parse: (raw) => (isAccountId(raw) ? raw : undefined),
};

function asInteger(min: number, max: number, expected = `an integer from ${min} to ${max}`): Rule<number> {
  return {
    expected,
    parse(raw) {
      const value = INTEGER.test(raw) ? Number(raw) : Number.NaN;
      return value >= min && value <= max ? value : undefined;
    },
  };
}

const asPositiveInteger = asInteger(1, Number.MAX_SAFE_INTEGER, 'a positive integer');

/** Gas from `min`, which `why` explains, to the most the gateway attaches to one call. */
function asGas(min = 1n, why?: string): Rule<bigint> {
  const from = why === undefined ? `${min}` : `${min} (${why})`;
  return {
    expected: `an amount of gas from ${from} to ${MAX_CALL_GAS} (300 Tgas, the most the gateway attaches to one call)`,
    parse(raw) {
      const gas = INTEGER.test(raw) ? BigInt(raw) : -1n;
      return gas >= min && gas <= MAX_CALL_GAS ? gas : undefined;
    },
  };
}

const asBoolean: Rule<boolean> = {
  expected: 'true or false',
  parse: (raw) => (raw === 'true' ? true : raw === 'false' ? false : undefined),
};

const asPath: Rule<string> = {
  expected: 'a non-empty path',
  parse: (raw) => (raw === '' ? undefined : raw),
};

/** A relative path resolves against the current folder, as the gateway serves it. */
const asWebDir: Rule<string | null> = {
  expected: `empty, or a folder that neither is nor contains the gateway's own folder (${GATEWAY_DIR})`,
  parse: (raw) => (raw === '' ? null : holds(resolve(raw), GATEWAY_DIR) ? undefined : raw),
};

const asRelayerKeys: Rule<string[]> = {
  expected: 'a comma-separated list of ed25519 secret keys',
  secret: true,
  parse(raw) {
    const keys = raw
      .split(',')
      .map((key) => key.trim())
      .filter((key) => key !== '');
    return keys.length > 0 && keys.every(isEd25519SecretKey) ? keys : undefined;
  },
};

const asCredentialJwk: Rule<JWK> = {
  expected: 'a private Ed25519 JWK (JSON with kty "OKP", crv "Ed25519", x and d)',
  secret: true,
  parse(raw) {
    try {
      const jwk: unknown = JSON.parse(raw);
      return isPrivateEd25519Jwk(jwk) ? jwk : undefined;
    } catch {
      return undefined;
    }
  },
};

/** The positions, from 1, of the first key listed twice, compared by public key; null if none is. */
function repeatedKey(keys: string[]): [number, number] | null {
  const publicKeys = keys.map((key) => KeyPair.fromString(key as KeyPairString).getPublicKey().toString());
  for (const [later, publicKey] of publicKeys.entries()) {
    const first = publicKeys.indexOf(publicKey);
    if (first < later) return [first + 1, later + 1];
  }
  return null;
}

/**
 * Whether `key` is a NEAR ed25519 secret key: 64 bytes, the seed then its public key.
 * `KeyPair.fromString` alone also accepts 32 bytes, such as a public key, and derives another key.
 */
function isEd25519SecretKey(key: string): boolean {
  if (!key.startsWith(ED25519_PREFIX)) return false;
  try {
    const bytes = baseDecode(key.slice(ED25519_PREFIX.length));
    const publicKey = KeyPair.fromString(key as KeyPairString).getPublicKey().data;
    return bytes.length === 64 && Buffer.from(bytes.subarray(32)).equals(publicKey);
  } catch {
    return false;
  }
}

/**
 * Checks the `chain_id` that the RPC at QUORUM_RPC_URL reports against QUORUM_NETWORK, which only
 * labels offers: the RPC decides which chain the gateway pays on. `near:testnet` needs `testnet`;
 * `near:sandbox` takes any chain but NEAR's public ones. Returns the problem, or null.
 */
export function checkChainId(network: Network, chainId: string): string | null {
  if (network === 'near:testnet') {
    if (chainId === 'testnet') return null;
    return `QUORUM_NETWORK is near:testnet, but QUORUM_RPC_URL serves the chain ${JSON.stringify(chainId)}, not "testnet"`;
  }
  if (!PUBLIC_CHAINS.includes(chainId)) return null;
  return `QUORUM_NETWORK is ${network}, but QUORUM_RPC_URL serves NEAR's public chain ${JSON.stringify(chainId)}`;
}

/** A GatewayConfig being read: a value is undefined when its variable has a problem. */
type Draft = { [K in keyof GatewayConfig]: GatewayConfig[K] | undefined };

/**
 * Reads the configuration from environment variables (see `.env.example`). Collects every problem
 * and throws one ConfigError listing them all.
 */
export function loadConfig(env: Record<string, string | undefined>): GatewayConfig {
  const problems: string[] = [];

  const check = <T>(name: string, raw: string, rule: Rule<T>): T | undefined => {
    const value = rule.parse(raw);
    if (value === undefined) {
      problems.push(`${name} must be ${rule.expected}${rule.secret ? '' : `, got ${JSON.stringify(raw)}`}`);
    }
    return value;
  };
  const optional = <T>(name: string, fallback: string, rule: Rule<T>): T | undefined =>
    check(name, env[name] ?? fallback, rule);
  const required = <T>(name: string, rule: Rule<T>): T | undefined => {
    const raw = env[name];
    if (raw !== undefined && raw !== '') return check(name, raw, rule);
    problems.push(`${name} is required`);
    return undefined;
  };

  const network = optional('QUORUM_NETWORK', 'near:testnet', asNetwork);
  const rpcUrl = optional('QUORUM_RPC_URL', 'https://test.rpc.fastnear.com', asHttpUrl);
  const publicUrl = optional('QUORUM_GATEWAY_URL', 'http://localhost:8402', asBaseUrl);
  const port = optional('QUORUM_GATEWAY_PORT', '8402', asInteger(1, 65_535));
  const parent = required('QUORUM_PARENT_ACCOUNT', asAccountId);
  const token = optional('QUORUM_TOKEN_ACCOUNT', TESTNET_USDC, asAccountId);
  /** An account that defaults to `<prefix>.<parent>`. */
  const child = (name: string, prefix: string): string | undefined => {
    const raw = env[name] ?? (parent === undefined ? undefined : `${prefix}.${parent}`);
    // Without a valid parent there is no default, and the parent's problem is already listed.
    return raw === undefined ? undefined : check(name, raw, asAccountId);
  };
  const poolsContract = child('QUORUM_POOLS_ACCOUNT', 'pools');
  const relayer = child('QUORUM_RELAYER_ACCOUNT', 'relay');
  const provider = child('QUORUM_PROVIDER_ACCOUNT', 'provider');
  const relayerKeys = required('QUORUM_RELAYER_KEYS', asRelayerKeys);
  // A key listed twice could sign two transactions at once. Positions only: the keys are secret.
  const repeated = relayerKeys === undefined ? null : repeatedKey(relayerKeys);
  if (repeated !== null) {
    problems.push(`QUORUM_RELAYER_KEYS must list each key once: keys ${repeated[0]} and ${repeated[1]} are the same`);
  }
  const credentialJwk = required('QUORUM_CREDENTIAL_JWK', asCredentialJwk);
  const minGas = optional('QUORUM_COMMIT_MIN_GAS', '50000000000000', asGas());
  const maxGas = optional('QUORUM_COMMIT_MAX_GAS', '100000000000000', asGas());
  if (minGas !== undefined && maxGas !== undefined && maxGas < minGas) {
    problems.push(`QUORUM_COMMIT_MAX_GAS must be at least QUORUM_COMMIT_MIN_GAS (${minGas}), got "${maxGas}"`);
  }
  const maxTimeoutSeconds = optional('QUORUM_MAX_TIMEOUT_SECONDS', '120', asPositiveInteger);
  const blockTimeMs = optional('QUORUM_BLOCK_TIME_MS', '1000', asPositiveInteger);
  const keeperIntervalMs = optional('QUORUM_KEEPER_INTERVAL_MS', '5000', asPositiveInteger);
  const refundLimit = optional('QUORUM_REFUND_LIMIT', '10', asInteger(1, 10));
  // With less gas than the contract asserts at entry, every call would panic.
  const settleGas = optional(
    'QUORUM_SETTLE_GAS',
    '100000000000000',
    asGas(gasRequiredAtEntry(1), 'what settle requires at entry'),
  );
  // Without a valid limit there is no requirement to check, and the limit's problem is already listed.
  const refundGasRule =
    refundLimit === undefined
      ? asGas()
      : asGas(gasRequiredAtEntry(refundLimit + 1), `what refund requires at entry with QUORUM_REFUND_LIMIT ${refundLimit}`);
  const refundGas = optional('QUORUM_REFUND_GAS', '300000000000000', refundGasRule);

  const draft: Draft = {
    network,
    rpcUrl,
    publicUrl,
    port,
    parent,
    token,
    poolsContract,
    relayer,
    provider,
    relayerKeys,
    credentialJwk,
    minGas,
    maxGas,
    maxTimeoutSeconds,
    blockTimeMs,
    keeperIntervalMs,
    refundLimit,
    settleGas,
    refundGas,
    dataDir: optional('QUORUM_DATA_DIR', 'data', asPath),
    webDir: optional('QUORUM_WEB_DIR', '../web', asWebDir),
    rpcPassthrough: optional('QUORUM_RPC_PASSTHROUGH', 'false', asBoolean),
    explorerTxUrl: optional('QUORUM_EXPLORER_TX_URL', 'https://testnet.nearblocks.io/txns/', asHttpUrl),
  };
  if (problems.length > 0) throw new ConfigError(problems.join('\n'));
  // No problem was listed, so every value in the draft is defined.
  return draft as GatewayConfig;
}
```

`apps/gateway/src/keygen.ts`:

```typescript
// Prints a new credential key as a line for `.env`: `node src/keygen.ts >> .env`.
import { generateCredentialJwk } from './credential.ts';

const jwk = await generateCredentialJwk();
process.stdout.write(`QUORUM_CREDENTIAL_JWK=${JSON.stringify(jwk)}\n`);
```

- [ ] **Step 5: Run the tests and the typecheck**

Run: `pnpm --filter @quorum-on-near/gateway exec vitest run test/config.test.ts test/credential.test.ts`

Expected: PASS, 109 tests (`test/config.test.ts` 94, `test/credential.test.ts` 15).

Run: `pnpm --filter @quorum-on-near/gateway typecheck`

Expected: no errors.

- [ ] **Step 6: Check the key generator**

Run: `pnpm --filter @quorum-on-near/gateway keygen`

Expected: after pnpm's own header lines, one line, `QUORUM_CREDENTIAL_JWK={"crv":"Ed25519","d":"…","x":"…","kty":"OKP"}`. It is a private key: put it only in `apps/gateway/.env`, which is gitignored, never in a committed file.

- [ ] **Step 7: Commit**

```bash
git add pnpm-lock.yaml apps/gateway/package.json apps/gateway/tsconfig.json apps/gateway/.env.example apps/gateway/src apps/gateway/test
git commit -m "add the gateway package with its configuration and credential issuer"
```


---

### Task 7: The chain seam and transaction outcomes

Every handler talks to the chain through two interfaces, so that it can be tested against an in-memory fake. `RpcChain` reads the contract's views and access keys at optimistic finality, so the gateway sees state at least as new as the outcomes it relays; heights and block times come from the final block. A relayed commit's result is read from the pools contract's `seats_committed` and `pool_filled` events, never from the transaction's top-level status, which ends at the delegate receipt. A response counts as an outcome only once its `final_execution_status` is `EXECUTED_OPTIMISTIC`, `EXECUTED` or `FINAL`; below that, its receipts may not all have run. The fixture is shaped like a relayed commit's RPC result; Task 15 captures a real one and adds a test against it.

**Files:**
- Create: `apps/gateway/src/chain.ts`, `apps/gateway/src/outcome.ts`, `apps/gateway/src/rpc-chain.ts`, `apps/gateway/test/fake-chain.ts`, `apps/gateway/test/fixtures/relayed-commit.provisional.json`
- Test: `apps/gateway/test/outcome.test.ts`, `apps/gateway/test/rpc-chain.test.ts`

**Interfaces:**
- Consumes: `GatewayConfig`, `TESTNET_USDC` (Task 6); `PoolView`, `BuyerView`, `DecodedSignedDelegate`, `QuorumEvent`, `parseEventLog` from the protocol package.
- Produces: `interface AccessKeyInfo {nonce, fullAccess}`, `BlockInfo {height, timestampMs}`, `ReceiptOutcome {executorId, logs, failed, gasBurnt}`, `TxOutcome {txHash, receipts}`, `interface ChainReader {getPool, listPools, getBuyer, ftBalanceOf, accessKey, finalBlock, getToken}`, `type RelayResult` (`executed` | `unknown`, with `expired`: whether the delegate can no longer execute | `rejected`), `EXPIRY_MARGIN_BLOCKS = 5n`, `class DelegateExpiredError`, `interface ChainWriter {relayDelegate(signed, maxBlockHeight), callPools(method, args, gas)}`; `toTxOutcome(response: unknown): TxOutcome` (throws unless `final_execution_status` is `EXECUTED_OPTIMISTIC`, `EXECUTED` or `FINAL`), `poolsEvents(outcome, poolsContract): QuorumEvent[]`, `interface CommitResult`, `readCommit(outcome, {poolsContract, buyer, poolId}): CommitResult`; `class RpcChain implements ChainReader` (`new RpcChain({provider, poolsContract, token})`); test support `FakeChain`, `poolView`, `testConfig`, `eventLog`, `outcome`, `commitOutcome` and the constants `PARENT`, `PROVIDER`, `POOLS`, `RELAYER`, `TOKEN`, `NOW_MS`, `TERMS`.

- [ ] **Step 1: Write the chain interfaces**

`apps/gateway/src/chain.ts`:

```typescript
import type { BuyerView, DecodedSignedDelegate, PoolView } from '@quorum-on-near/protocol';

/** An access key as the gateway needs it. */
export interface AccessKeyInfo {
  nonce: bigint;
  fullAccess: boolean;
}

/** The latest final block. */
export interface BlockInfo {
  height: bigint;
  timestampMs: number;
}

/** One executed receipt (or the transaction itself) of a transaction's outcome. */
export interface ReceiptOutcome {
  executorId: string;
  logs: string[];
  failed: boolean;
  gasBurnt: bigint;
}

/** A transaction's outcome: the transaction first, then every receipt, as the RPC lists them. */
export interface TxOutcome {
  txHash: string;
  receipts: ReceiptOutcome[];
}

/** Everything the gateway reads from the chain. */
export interface ChainReader {
  getPool(poolId: number): Promise<PoolView | null>;
  listPools(from: number, limit: number): Promise<PoolView[]>;
  getBuyer(poolId: number, accountId: string): Promise<BuyerView | null>;
  ftBalanceOf(accountId: string): Promise<bigint>;
  /** null when the account has no such key. */
  accessKey(accountId: string, publicKey: string): Promise<AccessKeyInfo | null>;
  finalBlock(): Promise<BlockInfo>;
  getToken(): Promise<string>;
}

/**
 * The result of submitting a transaction.
 * - `executed`: the RPC returned the outcome once every non-refund receipt had run (some may have
 *   failed).
 * - `unknown`: the transaction was sent but its result was not known in time. `expired` is true when
 *   a final block above the delegate's `maxBlockHeight` was seen, so the delegate can no longer
 *   execute; false when it may still land, and for a call that relays no delegate.
 * - `rejected`: the RPC refused the transaction, so nothing ran.
 */
export type RelayResult =
  | { kind: 'executed'; outcome: TxOutcome }
  | { kind: 'unknown'; txHash: string; expired: boolean }
  | { kind: 'rejected'; txHash: string; error: string };

/**
 * A payment is `expired` unless its `maxBlockHeight` is more than this many blocks past the final
 * height, so that the relayed transaction can land before the delegate expires. The upper bound,
 * the offer's timeout in blocks, allows the same margin.
 */
export const EXPIRY_MARGIN_BLOCKS = 5n;

/**
 * Thrown by `relayDelegate` when the chain's final height is already too close to the delegate's
 * `maxBlockHeight` for a relayed transaction to land in time. Nothing was sent.
 */
export class DelegateExpiredError extends Error {
  override name = 'DelegateExpiredError';
}

/** Everything the gateway submits, all signed by the relayer account. */
export interface ChainWriter {
  /**
   * Wraps a signed delegate action in a transaction to its sender and submits it. Resolves with the
   * result once it is known, or with `unknown` once the lookup's deadline passes without one. Throws
   * only before anything is sent: DelegateExpiredError when the final height is within EXPIRY_MARGIN_BLOCKS of
   * `maxBlockHeight`, or the error of a failed read or key wait.
   */
  relayDelegate(signed: DecodedSignedDelegate, maxBlockHeight: bigint): Promise<RelayResult>;
  /** Calls `settle` or `refund` on the pools contract with no deposit. Throws only before anything is sent. */
  callPools(method: 'settle' | 'refund', args: Record<string, unknown>, gas: bigint): Promise<RelayResult>;
}
```

- [ ] **Step 2: Write the test support: the fake chain and the provisional fixture**

`apps/gateway/test/fake-chain.ts`:

```typescript
import type { BuyerView, DecodedSignedDelegate, PoolView, QuorumEvent } from '@quorum-on-near/protocol';
import type {
  AccessKeyInfo,
  BlockInfo,
  ChainReader,
  ChainWriter,
  ReceiptOutcome,
  RelayResult,
  TxOutcome,
} from '../src/chain.ts';
import { TESTNET_USDC, type GatewayConfig } from '../src/config.ts';

export const PARENT = 'parent.testnet';
export const PROVIDER = `provider.${PARENT}`;
export const POOLS = `pools.${PARENT}`;
export const RELAYER = `relay.${PARENT}`;
export const TOKEN = TESTNET_USDC;
/** A fixed "now" for tests: well before the default pool deadline. */
export const NOW_MS = 1_799_999_000_000;
export const TERMS = '8×GPU × 24 h; 1 seat = 1 GPU-hour; prices at 1/10,000 scale';

/** A pool as the contract's views return it; the defaults match spec section 6.2's example. */
export function poolView(overrides: Partial<PoolView> = {}): PoolView {
  return {
    id: 7,
    seller: PROVIDER,
    seat_price: '180',
    target: 192,
    taken: 148,
    deadline_ms: 1_800_000_000_000,
    bonus: '1728',
    max_seats_per_buyer: 24,
    terms: TERMS,
    status: 'open',
    bonus_per_seat: '0',
    refund_cursor: 0,
    dust_sent: false,
    buyer_count: 10,
    ...overrides,
  };
}

export function testConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    network: 'near:testnet',
    rpcUrl: 'http://rpc.invalid',
    publicUrl: 'http://localhost:8402',
    port: 8402,
    parent: PARENT,
    token: TOKEN,
    poolsContract: POOLS,
    relayer: RELAYER,
    provider: PROVIDER,
    relayerKeys: [],
    credentialJwk: {},
    minGas: 50_000_000_000_000n,
    maxGas: 100_000_000_000_000n,
    maxTimeoutSeconds: 120,
    blockTimeMs: 1000,
    keeperIntervalMs: 5000,
    refundLimit: 10,
    settleGas: 100_000_000_000_000n,
    refundGas: 300_000_000_000_000n,
    dataDir: 'data',
    webDir: null,
    rpcPassthrough: false,
    explorerTxUrl: 'https://testnet.nearblocks.io/txns/',
    ...overrides,
  };
}

/** The log line the pools contract writes for an event. */
export function eventLog(event: QuorumEvent): string {
  return `EVENT_JSON:${JSON.stringify({ standard: 'quorum', version: '1.0.0', event: event.event, data: [event.data] })}`;
}

export interface ReceiptSpec {
  executorId: string;
  events?: QuorumEvent[];
  logs?: string[];
  failed?: boolean;
  gasBurnt?: bigint;
}

/** A TxOutcome from receipt specs: the relayer's transaction first, then the given receipts. */
export function outcome(txHash: string, receipts: ReceiptSpec[]): TxOutcome {
  const toReceipt = (r: ReceiptSpec): ReceiptOutcome => ({
    executorId: r.executorId,
    logs: [...(r.logs ?? []), ...(r.events ?? []).map(eventLog)],
    failed: r.failed ?? false,
    gasBurnt: r.gasBurnt ?? 1_000_000_000_000n,
  });
  return { txHash, receipts: [toReceipt({ executorId: RELAYER }), ...receipts.map(toReceipt)] };
}

/**
 * The outcome of a relayed commit that took `seats` seats: delegate at the buyer, ft_transfer_call
 * at the token, ft_on_transfer at the pools contract (with its events), ft_resolve_transfer.
 */
export function commitOutcome(opts: {
  txHash?: string;
  buyer: string;
  poolId: number;
  seats: number;
  seatPrice: bigint;
  taken: number;
  target: number;
}): TxOutcome {
  const events: QuorumEvent[] = [];
  if (opts.seats > 0) {
    events.push({
      event: 'seats_committed',
      data: {
        pool_id: opts.poolId,
        buyer: opts.buyer,
        seats: opts.seats,
        amount: (BigInt(opts.seats) * opts.seatPrice).toString(),
        taken: opts.taken,
        target: opts.target,
      },
    });
    if (opts.taken === opts.target) events.push({ event: 'pool_filled', data: { pool_id: opts.poolId, taken: opts.taken } });
  }
  return outcome(opts.txHash ?? 'TxHash111', [
    { executorId: opts.buyer },
    { executorId: TOKEN },
    { executorId: POOLS, events, failed: opts.seats === 0 },
    { executorId: TOKEN },
  ]);
}

/** An in-memory chain. Tests set its state directly and queue relay results. */
export class FakeChain implements ChainReader, ChainWriter {
  pools = new Map<number, PoolView>();
  buyers = new Map<string, BuyerView>();
  balances = new Map<string, bigint>();
  keys = new Map<string, AccessKeyInfo>();
  block: BlockInfo = { height: 1_000n, timestampMs: NOW_MS };
  token = TOKEN;
  /** Results returned by relayDelegate, in order; when empty, `onRelay` decides. */
  relayResults: RelayResult[] = [];
  onRelay?: (signed: DecodedSignedDelegate, maxBlockHeight: bigint) => RelayResult | Promise<RelayResult>;
  relayed: Array<{ signed: DecodedSignedDelegate; maxBlockHeight: bigint }> = [];
  /** Results returned by callPools, in order; when empty, `onCall` decides. */
  callResults: RelayResult[] = [];
  onCall?: (method: 'settle' | 'refund', args: Record<string, unknown>) => RelayResult | Promise<RelayResult>;
  calls: Array<{ method: 'settle' | 'refund'; args: Record<string, unknown>; gas: bigint }> = [];
  /** Count of view calls, by method name. */
  reads = new Map<string, number>();

  #read(name: string): void {
    this.reads.set(name, (this.reads.get(name) ?? 0) + 1);
  }

  setPool(pool: PoolView): void {
    this.pools.set(pool.id, pool);
  }
  setBuyer(poolId: number, account: string, view: BuyerView | null): void {
    if (view === null) this.buyers.delete(`${poolId}:${account}`);
    else this.buyers.set(`${poolId}:${account}`, view);
  }
  setKey(account: string, publicKey: string, info: AccessKeyInfo): void {
    this.keys.set(`${account}:${publicKey}`, info);
  }

  async getPool(poolId: number): Promise<PoolView | null> {
    this.#read('get_pool');
    return this.pools.get(poolId) ?? null;
  }
  async listPools(from: number, limit: number): Promise<PoolView[]> {
    this.#read('list_pools');
    return [...this.pools.values()]
      .sort((a, b) => a.id - b.id)
      .filter((p) => p.id >= from)
      .slice(0, Math.min(limit, 100));
  }
  async getBuyer(poolId: number, accountId: string): Promise<BuyerView | null> {
    this.#read('get_buyer');
    return this.buyers.get(`${poolId}:${accountId}`) ?? null;
  }
  async ftBalanceOf(accountId: string): Promise<bigint> {
    this.#read('ft_balance_of');
    return this.balances.get(accountId) ?? 0n;
  }
  async accessKey(accountId: string, publicKey: string): Promise<AccessKeyInfo | null> {
    this.#read('view_access_key');
    return this.keys.get(`${accountId}:${publicKey}`) ?? null;
  }
  async finalBlock(): Promise<BlockInfo> {
    this.#read('block');
    return this.block;
  }
  async getToken(): Promise<string> {
    this.#read('get_token');
    return this.token;
  }
  async relayDelegate(signed: DecodedSignedDelegate, maxBlockHeight: bigint): Promise<RelayResult> {
    this.relayed.push({ signed, maxBlockHeight });
    const queued = this.relayResults.shift();
    if (queued) return queued;
    if (this.onRelay) return this.onRelay(signed, maxBlockHeight);
    throw new Error('FakeChain: no relay result queued');
  }
  async callPools(method: 'settle' | 'refund', args: Record<string, unknown>, gas: bigint): Promise<RelayResult> {
    this.calls.push({ method, args, gas });
    const queued = this.callResults.shift();
    if (queued) return queued;
    if (this.onCall) return this.onCall(method, args);
    return { kind: 'rejected', txHash: 'none', error: 'FakeChain: no call result queued' };
  }
}
```

`apps/gateway/test/fixtures/relayed-commit.provisional.json`:

```json
{
  "final_execution_status": "EXECUTED_OPTIMISTIC",
  "receipts_outcome": [
    {
      "block_hash": "FakeBkHashB111111111111111111111111111111111",
      "id": "FakeReceiptA11111111111111111111111111111111",
      "outcome": {
        "executor_id": "buyer-01.parent.testnet",
        "gas_burnt": 2628184840212,
        "logs": [],
        "metadata": {
          "gas_profile": [
            {
              "cost": "DELEGATE",
              "cost_category": "ACTION_COST",
              "gas_used": "200000000000"
            },
            {
              "cost": "FUNCTION_CALL_BASE",
              "cost_category": "ACTION_COST",
              "gas_used": "2319861500000"
            },
            {
              "cost": "FUNCTION_CALL_BYTE",
              "cost_category": "ACTION_COST",
              "gas_used": "263840212"
            },
            {
              "cost": "NEW_ACTION_RECEIPT",
              "cost_category": "ACTION_COST",
              "gas_used": "108059500000"
            }
          ],
          "version": 3
        },
        "receipt_ids": [
          "FakeReceiptB11111111111111111111111111111111"
        ],
        "status": {
          "SuccessValue": ""
        },
        "tokens_burnt": "262818484021200000000"
      },
      "proof": [
        {
          "direction": "Right",
          "hash": "FakeProofRB111111111111111111111111111111111"
        }
      ]
    },
    {
      "block_hash": "FakeBkHashC111111111111111111111111111111111",
      "id": "FakeReceiptB11111111111111111111111111111111",
      "outcome": {
        "executor_id": "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af",
        "gas_burnt": 8858916069173,
        "logs": [
          "EVENT_JSON:{\"standard\":\"nep141\",\"version\":\"1.0.0\",\"event\":\"ft_transfer\",\"data\":[{\"old_owner_id\":\"buyer-01.parent.testnet\",\"new_owner_id\":\"pools.parent.testnet\",\"amount\":\"360\"}]}"
        ],
        "metadata": {
          "gas_profile": [
            {
              "cost": "FUNCTION_CALL_BASE",
              "cost_category": "ACTION_COST",
              "gas_used": "4639723000000"
            },
            {
              "cost": "FUNCTION_CALL_BYTE",
              "cost_category": "ACTION_COST",
              "gas_used": "507557018"
            },
            {
              "cost": "NEW_ACTION_RECEIPT",
              "cost_category": "ACTION_COST",
              "gas_used": "216119000000"
            },
            {
              "cost": "NEW_DATA_RECEIPT_BASE",
              "cost_category": "ACTION_COST",
              "gas_used": "36486732312"
            },
            {
              "cost": "BASE",
              "cost_category": "WASM_HOST_COST",
              "gas_used": "6354310623"
            },
            {
              "cost": "CONTRACT_LOADING_BASE",
              "cost_category": "WASM_HOST_COST",
              "gas_used": "35445963"
            },
            {
              "cost": "CONTRACT_LOADING_BYTES",
              "cost_category": "WASM_HOST_COST",
              "gas_used": "412663218000"
            },
            {
              "cost": "LOG_BASE",
              "cost_category": "WASM_HOST_COST",
              "gas_used": "3543313050"
            },
            {
              "cost": "LOG_BYTE",
              "cost_category": "WASM_HOST_COST",
              "gas_used": "2336186007"
            },
            {
              "cost": "STORAGE_READ_BASE",
              "cost_category": "WASM_HOST_COST",
              "gas_used": "225427383000"
            },
            {
              "cost": "STORAGE_WRITE_BASE",
              "cost_category": "WASM_HOST_COST",
              "gas_used": "128393472000"
            },
            {
              "cost": "WASM_INSTRUCTION",
              "cost_category": "WASM_HOST_COST",
              "gas_used": "3187326451200"
            }
          ],
          "version": 3
        },
        "receipt_ids": [
          "FakeReceiptC11111111111111111111111111111111",
          "FakeReceiptE11111111111111111111111111111111"
        ],
        "status": {
          "SuccessReceiptId": "FakeReceiptE11111111111111111111111111111111"
        },
        "tokens_burnt": "885891606917300000000"
      },
      "proof": [
        {
          "direction": "Right",
          "hash": "FakeProofRC111111111111111111111111111111111"
        }
      ]
    },
    {
      "block_hash": "FakeBkHashD111111111111111111111111111111111",
      "id": "FakeReceiptC11111111111111111111111111111111",
      "outcome": {
        "executor_id": "pools.parent.testnet",
        "gas_burnt": 3365039006310,
        "logs": [
          "EVENT_JSON:{\"data\":[{\"amount\":\"360\",\"buyer\":\"buyer-01.parent.testnet\",\"pool_id\":7,\"seats\":2,\"taken\":150,\"target\":192}],\"event\":\"seats_committed\",\"standard\":\"quorum\",\"version\":\"1.0.0\"}"
        ],
        "metadata": {
          "gas_profile": [
            {
              "cost": "BASE",
              "cost_category": "WASM_HOST_COST",
              "gas_used": "4501250520"
            },
            {
              "cost": "CONTRACT_LOADING_BASE",
              "cost_category": "WASM_HOST_COST",
              "gas_used": "35445963"
            },
            {
              "cost": "CONTRACT_LOADING_BYTES",
              "cost_category": "WASM_HOST_COST",
              "gas_used": "268210384500"
            },
            {
              "cost": "LOG_BASE",
              "cost_category": "WASM_HOST_COST",
              "gas_used": "3543313050"
            },
            {
              "cost": "LOG_BYTE",
              "cost_category": "WASM_HOST_COST",
              "gas_used": "2415378753"
            },
            {
              "cost": "STORAGE_READ_BASE",
              "cost_category": "WASM_HOST_COST",
              "gas_used": "225427383000"
            },
            {
              "cost": "STORAGE_WRITE_BASE",
              "cost_category": "WASM_HOST_COST",
              "gas_used": "256786944000"
            },
            {
              "cost": "WASM_INSTRUCTION",
              "cost_category": "WASM_HOST_COST",
              "gas_used": "2604118906524"
            }
          ],
          "version": 3
        },
        "receipt_ids": [
          "FakeReceiptD11111111111111111111111111111111"
        ],
        "status": {
          "SuccessValue": "IjAi"
        },
        "tokens_burnt": "336503900631000000000"
      },
      "proof": [
        {
          "direction": "Right",
          "hash": "FakeProofRD111111111111111111111111111111111"
        }
      ]
    },
    {
      "block_hash": "FakeBkHashE111111111111111111111111111111111",
      "id": "FakeReceiptD11111111111111111111111111111111",
      "outcome": {
        "executor_id": "relay.parent.testnet",
        "gas_burnt": 0,
        "logs": [],
        "metadata": {
          "gas_profile": [],
          "version": 3
        },
        "receipt_ids": [],
        "status": {
          "SuccessValue": ""
        },
        "tokens_burnt": "0"
      },
      "proof": [
        {
          "direction": "Right",
          "hash": "FakeProofRE111111111111111111111111111111111"
        }
      ]
    },
    {
      "block_hash": "FakeBkHashE111111111111111111111111111111111",
      "id": "FakeReceiptE11111111111111111111111111111111",
      "outcome": {
        "executor_id": "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af",
        "gas_burnt": 2027365745368,
        "logs": [],
        "metadata": {
          "gas_profile": [
            {
              "cost": "BASE",
              "cost_category": "WASM_HOST_COST",
              "gas_used": "3177155311"
            },
            {
              "cost": "CONTRACT_LOADING_BASE",
              "cost_category": "WASM_HOST_COST",
              "gas_used": "35445963"
            },
            {
              "cost": "CONTRACT_LOADING_BYTES",
              "cost_category": "WASM_HOST_COST",
              "gas_used": "412663218000"
            },
            {
              "cost": "PROMISE_RETURN",
              "cost_category": "WASM_HOST_COST",
              "gas_used": "560152386"
            },
            {
              "cost": "STORAGE_READ_BASE",
              "cost_category": "WASM_HOST_COST",
              "gas_used": "112713691500"
            },
            {
              "cost": "WASM_INSTRUCTION",
              "cost_category": "WASM_HOST_COST",
              "gas_used": "1498216082208"
            }
          ],
          "version": 3
        },
        "receipt_ids": [
          "FakeReceiptF11111111111111111111111111111111"
        ],
        "status": {
          "SuccessValue": "IjM2MCI="
        },
        "tokens_burnt": "202736574536800000000"
      },
      "proof": [
        {
          "direction": "Right",
          "hash": "FakeProofRE111111111111111111111111111111111"
        }
      ]
    },
    {
      "block_hash": "FakeBkHashF111111111111111111111111111111111",
      "id": "FakeReceiptF11111111111111111111111111111111",
      "outcome": {
        "executor_id": "relay.parent.testnet",
        "gas_burnt": 0,
        "logs": [],
        "metadata": {
          "gas_profile": [],
          "version": 3
        },
        "receipt_ids": [],
        "status": {
          "SuccessValue": ""
        },
        "tokens_burnt": "0"
      },
      "proof": [
        {
          "direction": "Right",
          "hash": "FakeProofRF111111111111111111111111111111111"
        }
      ]
    }
  ],
  "status": {
    "SuccessValue": ""
  },
  "transaction": {
    "actions": [
      {
        "Delegate": {
          "delegate_action": {
            "actions": [
              {
                "FunctionCall": {
                  "args": "eyJyZWNlaXZlcl9pZCI6InBvb2xzLnBhcmVudC50ZXN0bmV0IiwiYW1vdW50IjoiMzYwIiwibXNnIjoie1wiY29tbWl0XCI6e1wicG9vbF9pZFwiOjcsXCJzZWF0c1wiOjJ9fSJ9",
                  "deposit": "1",
                  "gas": 50000000000000,
                  "method_name": "ft_transfer_call"
                }
              }
            ],
            "max_block_height": 245000220,
            "nonce": 244990000000007,
            "public_key": "ed25519:FakeBuyerKey11111111111111111111111111111111",
            "receiver_id": "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af",
            "sender_id": "buyer-01.parent.testnet"
          },
          "signature": "ed25519:FakeBuyerSignature111111111111111111111111111111111111111111111111111111111111111111111"
        }
      }
    ],
    "hash": "FakeTxHash1111111111111111111111111111111111",
    "nonce": 245000000000042,
    "priority_fee": 0,
    "public_key": "ed25519:FakeRe1ayerKey111111111111111111111111111111",
    "receiver_id": "buyer-01.parent.testnet",
    "signature": "ed25519:FakeRe1ayerSignature1111111111111111111111111111111111111111111111111111111111111111111",
    "signer_id": "relay.parent.testnet"
  },
  "transaction_outcome": {
    "block_hash": "FakeBkHashA111111111111111111111111111111111",
    "id": "FakeTxHash1111111111111111111111111111111111",
    "outcome": {
      "executor_id": "relay.parent.testnet",
      "gas_burnt": 2628184840212,
      "logs": [],
      "metadata": {
        "gas_profile": null,
        "version": 1
      },
      "receipt_ids": [
        "FakeReceiptA11111111111111111111111111111111"
      ],
      "status": {
        "SuccessReceiptId": "FakeReceiptA11111111111111111111111111111111"
      },
      "tokens_burnt": "262818484021200000000"
    },
    "proof": [
      {
        "direction": "Right",
        "hash": "FakeProofTA111111111111111111111111111111111"
      }
    ]
  }
}
```

- [ ] **Step 3: Write the failing tests**

`apps/gateway/test/outcome.test.ts`:

```typescript
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { QuorumEvent } from '@quorum-on-near/protocol';
import { poolsEvents, readCommit, toTxOutcome } from '../src/outcome.ts';
import { commitOutcome, outcome, PARENT, POOLS, RELAYER, TOKEN } from './fake-chain.ts';

const BUYER = `buyer-01.${PARENT}`;
const QUERY = { poolsContract: POOLS, buyer: BUYER, poolId: 7 };

/** The fields of the fixture that these tests change. */
interface RawResponse {
  final_execution_status?: string;
  receipts_outcome: Array<{ outcome: { status: unknown; gas_burnt: unknown } }>;
}

/** A fresh copy of the provisional `send_tx` result for a relayed commit of 2 seats in pool 7. */
function relayedCommit(): RawResponse {
  const url = new URL('./fixtures/relayed-commit.provisional.json', import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as RawResponse;
}

type SeatsCommitted = Extract<QuorumEvent, { event: 'seats_committed' }>;

function committed(overrides: Partial<SeatsCommitted['data']> = {}): SeatsCommitted {
  return {
    event: 'seats_committed',
    data: { pool_id: 7, buyer: BUYER, seats: 2, amount: '360', taken: 150, target: 192, ...overrides },
  };
}

describe('toTxOutcome', () => {
  it('takes the transaction hash from the transaction outcome', () => {
    expect(toTxOutcome(relayedCommit()).txHash).toBe('FakeTxHash1111111111111111111111111111111111');
  });

  it('lists the transaction first, then every receipt in the order the RPC gave', () => {
    const { receipts } = toTxOutcome(relayedCommit());
    expect(receipts.map((r) => r.executorId)).toEqual([RELAYER, BUYER, TOKEN, POOLS, RELAYER, TOKEN, RELAYER]);
  });

  it('keeps each receipt its own logs', () => {
    const { receipts } = toTxOutcome(relayedCommit());
    expect(receipts.map((r) => r.logs.length)).toEqual([0, 0, 1, 1, 0, 0, 0]);
    expect(receipts[2]?.logs[0]).toMatch(/^EVENT_JSON:\{"standard":"nep141","version":"1\.0\.0","event":"ft_transfer"/);
    expect(receipts[3]?.logs).toEqual([
      'EVENT_JSON:{"data":[{"amount":"360","buyer":"buyer-01.parent.testnet","pool_id":7,"seats":2,"taken":150,"target":192}],"event":"seats_committed","standard":"quorum","version":"1.0.0"}',
    ]);
  });

  it('marks no receipt failed when every status is a success', () => {
    expect(toTxOutcome(relayedCommit()).receipts.map((r) => r.failed)).toEqual(Array(7).fill(false));
  });

  it('converts gas_burnt to bigint', () => {
    expect(toTxOutcome(relayedCommit()).receipts.map((r) => r.gasBurnt)).toEqual([
      2_628_184_840_212n,
      2_628_184_840_212n,
      8_858_916_069_173n,
      3_365_039_006_310n,
      0n,
      2_027_365_745_368n,
      0n,
    ]);
  });

  it('marks a receipt failed when its status has a Failure key', () => {
    const response = relayedCommit();
    response.receipts_outcome[0]!.outcome.status = {
      Failure: {
        ActionError: {
          index: 0,
          kind: { DelegateActionInvalidNonce: { ak_nonce: 244_990_000_000_007, delegate_nonce: 244_990_000_000_007 } },
        },
      },
    };
    const failed = toTxOutcome(response).receipts.map((r) => r.failed);
    expect(failed).toEqual([false, true, false, false, false, false, false]);
  });

  it('throws on a response that has no receipts_outcome', () => {
    const { receipts_outcome: _, ...rest } = relayedCommit();
    expect(() => toTxOutcome(rest)).toThrow(TypeError);
  });

  it('throws on a receipt whose gas_burnt is not an integer', () => {
    const response = relayedCommit();
    response.receipts_outcome[1]!.outcome.gas_burnt = 1.5;
    expect(() => toTxOutcome(response)).toThrow(TypeError);
  });

  it.each(['EXECUTED_OPTIMISTIC', 'EXECUTED', 'FINAL'])('reads a response whose final_execution_status is %s', (status) => {
    const response = { ...relayedCommit(), final_execution_status: status };
    expect(toTxOutcome(response).receipts).toHaveLength(7);
  });

  it.each(['NONE', 'INCLUDED', 'INCLUDED_FINAL'])(
    'throws on a response whose final_execution_status is %s, since its receipts may not all have run',
    (status) => {
      const response = relayedCommit();
      response.final_execution_status = status;
      response.receipts_outcome.splice(1);
      expect(() => toTxOutcome(response)).toThrow(TypeError);
    },
  );

  it('throws on a response that has no final_execution_status', () => {
    const { final_execution_status: _, ...rest } = relayedCommit();
    expect(() => toTxOutcome(rest)).toThrow(TypeError);
  });
});

describe('poolsEvents', () => {
  it('returns the events the pools contract logged, in order, skipping other log lines', () => {
    const filled: QuorumEvent = { event: 'pool_filled', data: { pool_id: 7, taken: 192 } };
    const tx = outcome('TxHash', [
      { executorId: POOLS, logs: ['plain log line'], events: [committed({ taken: 192 }), filled] },
    ]);
    expect(poolsEvents(tx, POOLS)).toEqual([committed({ taken: 192 }), filled]);
  });

  it('ignores look-alike events logged by another account', () => {
    const tx = outcome('TxHash', [
      { executorId: BUYER },
      { executorId: TOKEN, events: [committed({ seats: 24 })] },
      { executorId: POOLS, events: [committed()] },
    ]);
    expect(poolsEvents(tx, POOLS)).toEqual([committed()]);
  });

  it('skips the events of a failed pools receipt, whose state changes were reverted', () => {
    const tx = outcome('TxHash', [{ executorId: POOLS, events: [committed()], failed: true }]);
    expect(poolsEvents(tx, POOLS)).toEqual([]);
  });
});

describe('readCommit', () => {
  it('reads the seats, amount and pool totals when the seats are taken and the pool stays open', () => {
    const tx = commitOutcome({ buyer: BUYER, poolId: 7, seats: 2, seatPrice: 180n, taken: 150, target: 192 });
    expect(readCommit(tx, QUERY)).toEqual({
      delegateFailed: false,
      seats: 2,
      amount: 360n,
      taken: 150,
      target: 192,
      filled: false,
    });
  });

  it('reads the provisional relayed-commit fixture as 2 seats taken in an open pool', () => {
    expect(readCommit(toTxOutcome(relayedCommit()), QUERY)).toEqual({
      delegateFailed: false,
      seats: 2,
      amount: 360n,
      taken: 150,
      target: 192,
      filled: false,
    });
  });

  it('reports filled when the pools contract logged pool_filled for the pool', () => {
    const tx = commitOutcome({ buyer: BUYER, poolId: 7, seats: 2, seatPrice: 180n, taken: 192, target: 192 });
    expect(readCommit(tx, QUERY)).toMatchObject({ seats: 2, taken: 192, target: 192, filled: true });
  });

  it('reports filled when the commit brought taken up to target', () => {
    const tx = outcome('TxHash', [{ executorId: POOLS, events: [committed({ taken: 192 })] }]);
    expect(readCommit(tx, QUERY).filled).toBe(true);
  });

  it('reports no seats when the pools contract logged no seats_committed', () => {
    const tx = commitOutcome({ buyer: BUYER, poolId: 7, seats: 0, seatPrice: 180n, taken: 192, target: 192 });
    expect(readCommit(tx, QUERY)).toEqual({
      delegateFailed: false,
      seats: 0,
      amount: 0n,
      taken: null,
      target: null,
      filled: false,
    });
  });

  it("ignores another buyer's seats_committed in the same outcome", () => {
    const tx = outcome('TxHash', [{ executorId: POOLS, events: [committed({ buyer: `buyer-02.${PARENT}` })] }]);
    expect(readCommit(tx, QUERY)).toMatchObject({ seats: 0, amount: 0n, taken: null, filled: false });
  });

  it('ignores a seats_committed for another pool', () => {
    const tx = outcome('TxHash', [{ executorId: POOLS, events: [committed({ pool_id: 8 })] }]);
    expect(readCommit(tx, QUERY).seats).toBe(0);
  });

  it('ignores a seats_committed logged by another contract', () => {
    const tx = outcome('TxHash', [{ executorId: TOKEN, events: [committed()] }]);
    expect(readCommit(tx, QUERY).seats).toBe(0);
  });

  it("reports delegateFailed when a receipt at the buyer's account failed", () => {
    const tx = outcome('TxHash', [{ executorId: BUYER, failed: true }, { executorId: RELAYER }]);
    expect(readCommit(tx, QUERY)).toEqual({
      delegateFailed: true,
      seats: 0,
      amount: 0n,
      taken: null,
      target: null,
      filled: false,
    });
  });

  it('does not report delegateFailed when only the pools receipt failed', () => {
    const tx = commitOutcome({ buyer: BUYER, poolId: 7, seats: 0, seatPrice: 180n, taken: 192, target: 192 });
    expect(readCommit(tx, QUERY).delegateFailed).toBe(false);
  });

  it('throws on a seats_committed whose amount is not a decimal string', () => {
    const tx = outcome('TxHash', [{ executorId: POOLS, events: [committed({ amount: '3.6e2' })] }]);
    expect(() => readCommit(tx, QUERY)).toThrow(TypeError);
  });
});
```

`apps/gateway/test/rpc-chain.test.ts`:

```typescript
import { JsonRpcProvider, KeyPair } from 'near-api-js';
import type { Provider } from 'near-api-js';
import { AccessKeyDoesNotExistError, AccountDoesNotExistError, UnknownBlockError } from 'near-api-js/rpc-errors';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RpcChain } from '../src/rpc-chain.ts';
import { PARENT, POOLS, poolView, TOKEN } from './fake-chain.ts';

const BUYER = `buyer-01.${PARENT}`;
const OPTIMISTIC = { finality: 'optimistic' };
const FINAL = { finality: 'final' };

/** What the fake answers: a view result, an access key (or the error to throw), a block. */
interface Answers {
  view?: unknown;
  accessKey?: () => unknown;
  block?: unknown;
}

/** An RpcChain over a fake Provider that has only the methods RpcChain calls, recording each call. */
function setup(answers: Answers = {}) {
  const calls: Array<[method: string, params: unknown]> = [];
  const provider = {
    async callFunction(params: unknown) {
      calls.push(['callFunction', params]);
      return answers.view;
    },
    async viewAccessKey(params: unknown) {
      calls.push(['viewAccessKey', params]);
      return answers.accessKey?.();
    },
    async viewBlock(blockQuery: unknown) {
      calls.push(['viewBlock', blockQuery]);
      return answers.block;
    },
  };
  const chain = new RpcChain({ provider: provider as unknown as Provider, poolsContract: POOLS, token: TOKEN });
  return { chain, calls };
}

const publicKey = () => KeyPair.fromRandom('ed25519').getPublicKey();

describe('RpcChain views', () => {
  const views: Array<{
    name: string;
    read: (chain: RpcChain) => Promise<unknown>;
    answer: unknown;
    contractId: string;
    method: string;
    args: Record<string, unknown>;
  }> = [
    {
      name: 'getPool',
      read: (c) => c.getPool(7),
      answer: poolView(),
      contractId: POOLS,
      method: 'get_pool',
      args: { pool_id: 7 },
    },
    {
      name: 'listPools',
      read: (c) => c.listPools(3, 100),
      answer: [],
      contractId: POOLS,
      method: 'list_pools',
      args: { from: 3, limit: 100 },
    },
    {
      name: 'getBuyer',
      read: (c) => c.getBuyer(7, BUYER),
      answer: null,
      contractId: POOLS,
      method: 'get_buyer',
      args: { pool_id: 7, account_id: BUYER },
    },
    {
      name: 'ftBalanceOf',
      read: (c) => c.ftBalanceOf(BUYER),
      answer: '0',
      contractId: TOKEN,
      method: 'ft_balance_of',
      args: { account_id: BUYER },
    },
    {
      name: 'getToken',
      read: (c) => c.getToken(),
      answer: TOKEN,
      contractId: POOLS,
      method: 'get_token',
      args: {},
    },
  ];

  for (const { name, read, answer, contractId, method, args } of views) {
    it(`${name} calls ${method} at optimistic finality`, async () => {
      const { chain, calls } = setup({ view: answer });
      await read(chain);
      expect(calls).toEqual([['callFunction', { contractId, method, args, blockQuery: OPTIMISTIC }]]);
    });
  }

  it('getPool returns the view of the pool', async () => {
    const { chain } = setup({ view: poolView() });
    expect(await chain.getPool(7)).toEqual(poolView());
  });

  it('getPool returns null for a pool the contract does not know', async () => {
    const { chain } = setup({ view: null });
    expect(await chain.getPool(99)).toBeNull();
  });

  it('listPools returns the rows of list_pools', async () => {
    const rows = [poolView({ id: 3 }), poolView({ id: 4 })];
    const { chain } = setup({ view: rows });
    expect(await chain.listPools(3, 100)).toEqual(rows);
  });

  it('getBuyer returns the view of the buyer', async () => {
    const { chain } = setup({ view: { seats: 2, state: 'committed' } });
    expect(await chain.getBuyer(7, BUYER)).toEqual({ seats: 2, state: 'committed' });
  });

  it('getBuyer returns null for an account that holds no seats in the pool', async () => {
    const { chain } = setup({ view: null });
    expect(await chain.getBuyer(7, BUYER)).toBeNull();
  });

  it('ftBalanceOf returns the balance as a bigint', async () => {
    const { chain } = setup({ view: '12345678901234567890' });
    expect(await chain.ftBalanceOf(BUYER)).toBe(12_345_678_901_234_567_890n);
  });

  it('ftBalanceOf throws when the token returns something other than a decimal string', async () => {
    const { chain } = setup({ view: 42 });
    await expect(chain.ftBalanceOf(BUYER)).rejects.toThrow(TypeError);
  });

  it('getToken returns the account id of the token', async () => {
    const { chain } = setup({ view: TOKEN });
    expect(await chain.getToken()).toBe(TOKEN);
  });

  it('getToken throws when the view returns something other than a string', async () => {
    const { chain } = setup({ view: undefined });
    await expect(chain.getToken()).rejects.toThrow(TypeError);
  });
});

describe('RpcChain.accessKey', () => {
  it('asks for the key of the account at optimistic finality', async () => {
    const key = publicKey().toString();
    const { chain, calls } = setup({ accessKey: () => ({ nonce: 1n, permission: 'FullAccess' }) });
    await chain.accessKey(BUYER, key);
    expect(calls).toEqual([['viewAccessKey', { accountId: BUYER, publicKey: key, finalityQuery: OPTIMISTIC }]]);
  });

  it('reports a full-access key with its nonce', async () => {
    const view = { nonce: 244_990_000_000_007n, permission: 'FullAccess', block_height: 245_000_100 };
    const { chain } = setup({ accessKey: () => view });
    const key = await chain.accessKey(BUYER, publicKey().toString());
    expect(key).toEqual({ nonce: 244_990_000_000_007n, fullAccess: true });
  });

  it('reports a function-call key as not full access', async () => {
    const permission = {
      FunctionCall: { allowance: '250000000000000000000000', method_names: [], receiver_id: POOLS },
    };
    const { chain } = setup({ accessKey: () => ({ nonce: 5n, permission }) });
    expect(await chain.accessKey(BUYER, publicKey().toString())).toEqual({ nonce: 5n, fullAccess: false });
  });

  it('returns null when the account has no such key', async () => {
    const key = publicKey();
    const { chain } = setup({
      accessKey: () => {
        throw new AccessKeyDoesNotExistError(key, 'FakeBkHash', 245_000_100);
      },
    });
    expect(await chain.accessKey(BUYER, key.toString())).toBeNull();
  });

  it('returns null when the account does not exist', async () => {
    const { chain } = setup({
      accessKey: () => {
        throw new AccountDoesNotExistError(BUYER, 'FakeBkHash', 245_000_100);
      },
    });
    expect(await chain.accessKey(BUYER, publicKey().toString())).toBeNull();
  });

  it('rethrows any other RPC error', async () => {
    const { chain } = setup({
      accessKey: () => {
        throw new UnknownBlockError();
      },
    });
    await expect(chain.accessKey(BUYER, publicKey().toString())).rejects.toBeInstanceOf(UnknownBlockError);
  });
});

describe('RpcChain.finalBlock', () => {
  const block = {
    author: 'validator.testnet',
    chunks: [],
    header: { height: 245_000_100, timestamp_nanosec: '1799999000123999999' },
  };

  it('asks for the block at final finality', async () => {
    const { chain, calls } = setup({ block });
    await chain.finalBlock();
    expect(calls).toEqual([['viewBlock', FINAL]]);
  });

  it('returns the height of the block as a bigint', async () => {
    const { chain } = setup({ block });
    expect((await chain.finalBlock()).height).toBe(245_000_100n);
  });

  it('converts timestamp_nanosec to milliseconds, rounding down as the contract does', async () => {
    const { chain } = setup({ block });
    expect((await chain.finalBlock()).timestampMs).toBe(1_799_999_000_123);
  });
});

describe('RpcChain over JsonRpcProvider', () => {
  interface RpcRequest {
    id: string;
    method: string;
    params: Record<string, unknown>;
  }

  /** An RpcChain over a JsonRpcProvider whose fetch records each request and answers it with `reply`. */
  function stubRpc(reply: { result: unknown } | { error: unknown }) {
    const requests: RpcRequest[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
      const request = JSON.parse(init.body) as RpcRequest;
      requests.push(request);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, ...reply }), { status: 200 });
    });
    const provider = new JsonRpcProvider({ url: 'http://rpc.invalid' });
    return { chain: new RpcChain({ provider, poolsContract: POOLS, token: TOKEN }), requests };
  }

  const handlerError = (cause: unknown) => ({
    error: { name: 'HANDLER_ERROR', cause, code: -32000, message: 'Server error' },
  });
  const AT = { block_height: 245_000_100, block_hash: 'FakeBkHash' };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends a view as a call_function query at optimistic finality', async () => {
    const result = Array.from(new TextEncoder().encode(JSON.stringify(TOKEN)));
    const { chain, requests } = stubRpc({ result: { result, logs: [], ...AT } });
    await chain.getToken();
    expect(requests.map((r) => [r.method, r.params])).toEqual([
      [
        'query',
        {
          request_type: 'call_function',
          account_id: POOLS,
          method_name: 'get_token',
          args_base64: 'e30=',
          finality: 'optimistic',
        },
      ],
    ]);
  });

  it('sends an access-key read as a view_access_key query at optimistic finality', async () => {
    const key = publicKey().toString();
    const { chain, requests } = stubRpc({ result: { nonce: 5, permission: 'FullAccess', ...AT } });
    await chain.accessKey(BUYER, key);
    expect(requests.map((r) => [r.method, r.params])).toEqual([
      ['query', { request_type: 'view_access_key', account_id: BUYER, public_key: key, finality: 'optimistic' }],
    ]);
  });

  it('requests the block at final finality', async () => {
    const header = { height: 245_000_100, timestamp_nanosec: '1799999000123999999' };
    const { chain, requests } = stubRpc({ result: { author: 'validator.testnet', chunks: [], header } });
    await chain.finalBlock();
    expect(requests.map((r) => [r.method, r.params])).toEqual([['block', FINAL]]);
  });

  it("returns null for the RPC's UNKNOWN_ACCESS_KEY error", async () => {
    const key = publicKey().toString();
    const info = { public_key: key, ...AT };
    const { chain } = stubRpc(handlerError({ name: 'UNKNOWN_ACCESS_KEY', info }));
    expect(await chain.accessKey(BUYER, key)).toBeNull();
  });

  it("returns null for the RPC's UNKNOWN_ACCOUNT error", async () => {
    const info = { requested_account_id: BUYER, ...AT };
    const { chain } = stubRpc(handlerError({ name: 'UNKNOWN_ACCOUNT', info }));
    expect(await chain.accessKey(BUYER, publicKey().toString())).toBeNull();
  });
});
```

- [ ] **Step 4: Run them to see them fail**

Run: `pnpm --filter @quorum-on-near/gateway exec vitest run test/outcome.test.ts test/rpc-chain.test.ts`

Expected: FAIL. vitest cannot load `../src/outcome.ts` and `../src/rpc-chain.ts`, which do not exist yet.

- [ ] **Step 5: Write the implementation**

`apps/gateway/src/outcome.ts`:

```typescript
import { parseAmount, parseEventLog } from '@quorum-on-near/protocol';
import type { QuorumEvent } from '@quorum-on-near/protocol';
import type { ReceiptOutcome, TxOutcome } from './chain.ts';

type Fields = Record<string, unknown>;
type SeatsCommitted = Extract<QuorumEvent, { event: 'seats_committed' }>;

function isFields(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function malformed(where: string, problem: string): never {
  throw new TypeError(`malformed transaction response: ${where} ${problem}`);
}

/** Gas as the RPC writes it: a JSON number, or a decimal string. */
function toGas(value: unknown): bigint | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  return parseAmount(value);
}

/** One `{id, outcome: {executor_id, logs, status, gas_burnt}}` entry of the response. */
function readOutcome(value: unknown, where: string): { id: string; receipt: ReceiptOutcome } {
  if (!isFields(value) || typeof value.id !== 'string' || !isFields(value.outcome)) {
    malformed(where, 'is not an outcome with an id');
  }
  const { executor_id: executorId, logs, status, gas_burnt: gas } = value.outcome;
  if (typeof executorId !== 'string') malformed(where, 'has no executor_id');
  if (!Array.isArray(logs) || !logs.every((log): log is string => typeof log === 'string')) {
    malformed(where, 'has invalid logs');
  }
  const gasBurnt = toGas(gas);
  if (gasBurnt === null) malformed(where, 'has an invalid gas_burnt');
  const failed = isFields(status) && 'Failure' in status;
  return { id: value.id, receipt: { executorId, logs, failed, gasBurnt } };
}

/**
 * The `final_execution_status` values at which every non-refund receipt has run. Below them (`NONE`,
 * `INCLUDED`, `INCLUDED_FINAL`), `receipts_outcome` may be incomplete.
 */
const EXECUTED_STATUSES = new Set(['EXECUTED_OPTIMISTIC', 'EXECUTED', 'FINAL']);

/**
 * Converts the RPC's transaction response (`send_tx` / `tx`, near-api-js's RpcTransactionResponse)
 * into a TxOutcome: `transaction_outcome` first, then `receipts_outcome` in order. A receipt is failed
 * when its status has a `Failure` key. Throws on a response whose `final_execution_status` is not in
 * EXECUTED_STATUSES, since its outcome is not complete yet.
 */
export function toTxOutcome(response: unknown): TxOutcome {
  if (!isFields(response)) malformed('response', 'is not an object');
  const { final_execution_status: status, transaction_outcome: transaction, receipts_outcome: receipts } = response;
  if (typeof status !== 'string' || !EXECUTED_STATUSES.has(status)) {
    throw new TypeError(`transaction response not executed yet: final_execution_status is ${String(status)}`);
  }
  if (!Array.isArray(receipts)) malformed('receipts_outcome', 'is not an array');
  const tx = readOutcome(transaction, 'transaction_outcome');
  return {
    txHash: tx.id,
    receipts: [tx.receipt, ...receipts.map((r: unknown, i) => readOutcome(r, `receipts_outcome[${i}]`).receipt)],
  };
}

/**
 * Every `quorum` event logged by a receipt that the pools contract executed, in order. A failed
 * receipt's events are skipped: its state changes were reverted.
 */
export function poolsEvents(outcome: TxOutcome, poolsContract: string): QuorumEvent[] {
  return outcome.receipts
    .filter((receipt) => receipt.executorId === poolsContract && !receipt.failed)
    .flatMap((receipt) => receipt.logs.map(parseEventLog))
    .filter((event) => event !== null);
}

/** What a relayed commit did. */
export interface CommitResult {
  /** The delegate action itself failed (for example a used nonce), so nothing was attempted. */
  delegateFailed: boolean;
  /** Seats taken by this payment: 0 when the contract took none. */
  seats: number;
  amount: bigint;
  /** The pool's seats taken after this commit, from the event; null when no seats were taken. */
  taken: number | null;
  target: number | null;
  /** This commit filled the pool. */
  filled: boolean;
}

/**
 * Reads a relayed commit's outcome. The seats come from the pools contract's `seats_committed`
 * event for this buyer and pool, and `filled` from its `pool_filled` event. A failed receipt executed
 * by the buyer's account means the delegate action failed.
 */
export function readCommit(
  outcome: TxOutcome,
  query: { poolsContract: string; buyer: string; poolId: number },
): CommitResult {
  const { poolsContract, buyer, poolId } = query;
  const delegateFailed = outcome.receipts.some((receipt) => receipt.failed && receipt.executorId === buyer);
  const events = poolsEvents(outcome, poolsContract);
  const commit = events.find(
    (event): event is SeatsCommitted =>
      event.event === 'seats_committed' && event.data.buyer === buyer && event.data.pool_id === poolId,
  );
  if (commit === undefined) {
    return { delegateFailed, seats: 0, amount: 0n, taken: null, target: null, filled: false };
  }
  const { seats, amount, taken, target } = commit.data;
  const paid = parseAmount(amount);
  if (paid === null || ![seats, taken, target].every(Number.isSafeInteger)) {
    throw new TypeError(`malformed seats_committed event: ${JSON.stringify(commit.data)}`);
  }
  const filled =
    taken === target || events.some((event) => event.event === 'pool_filled' && event.data.pool_id === poolId);
  return { delegateFailed, seats, amount: paid, taken, target, filled };
}
```

`apps/gateway/src/rpc-chain.ts`:

```typescript
import { parseAmount } from '@quorum-on-near/protocol';
import type { BuyerView, PoolView } from '@quorum-on-near/protocol';
import type { Provider, SerializedReturnValue } from 'near-api-js';
import { AccessKeyDoesNotExistError, AccountDoesNotExistError } from 'near-api-js/rpc-errors';
import type { AccessKeyInfo, BlockInfo, ChainReader } from './chain.ts';

const OPTIMISTIC = { finality: 'optimistic' } as const;
const FINAL = { finality: 'final' } as const;
const NANOS_PER_MS = 1_000_000n;

/**
 * ChainReader over near-api-js's JSON-RPC provider. Views and access keys are read at optimistic
 * finality, so they reflect at least the state of an outcome returned at EXECUTED_OPTIMISTIC;
 * `finalBlock` reads the latest final block.
 */
export class RpcChain implements ChainReader {
  readonly #provider: Provider;
  readonly #poolsContract: string;
  readonly #token: string;

  constructor(opts: { provider: Provider; poolsContract: string; token: string }) {
    this.#provider = opts.provider;
    this.#poolsContract = opts.poolsContract;
    this.#token = opts.token;
  }

  async getPool(poolId: number): Promise<PoolView | null> {
    return (await this.#view<PoolView>(this.#poolsContract, 'get_pool', { pool_id: poolId })) ?? null;
  }

  async listPools(from: number, limit: number): Promise<PoolView[]> {
    return (await this.#view<PoolView[]>(this.#poolsContract, 'list_pools', { from, limit })) ?? [];
  }

  async getBuyer(poolId: number, accountId: string): Promise<BuyerView | null> {
    const args = { pool_id: poolId, account_id: accountId };
    return (await this.#view<BuyerView>(this.#poolsContract, 'get_buyer', args)) ?? null;
  }

  async ftBalanceOf(accountId: string): Promise<bigint> {
    const result = await this.#view(this.#token, 'ft_balance_of', { account_id: accountId });
    const balance = parseAmount(result);
    if (balance === null) throw new TypeError(`ft_balance_of returned ${JSON.stringify(result)}`);
    return balance;
  }

  async accessKey(accountId: string, publicKey: string): Promise<AccessKeyInfo | null> {
    try {
      const key = await this.#provider.viewAccessKey({ accountId, publicKey, finalityQuery: OPTIMISTIC });
      return { nonce: key.nonce, fullAccess: key.permission === 'FullAccess' };
    } catch (error) {
      if (error instanceof AccessKeyDoesNotExistError || error instanceof AccountDoesNotExistError) return null;
      throw error;
    }
  }

  async finalBlock(): Promise<BlockInfo> {
    const { header } = await this.#provider.viewBlock(FINAL);
    return {
      height: BigInt(header.height),
      timestampMs: Number(BigInt(header.timestamp_nanosec) / NANOS_PER_MS),
    };
  }

  async getToken(): Promise<string> {
    const token = await this.#view(this.#poolsContract, 'get_token', {});
    if (typeof token !== 'string') throw new TypeError(`get_token returned ${JSON.stringify(token)}`);
    return token;
  }

  /** A view call at optimistic finality; the result is the contract's JSON, unchecked. */
  #view<T extends SerializedReturnValue>(
    contractId: string,
    method: string,
    args: Record<string, unknown>,
  ): Promise<T | undefined> {
    return this.#provider.callFunction<T>({ contractId, method, args, blockQuery: OPTIMISTIC });
  }
}
```

- [ ] **Step 6: Run the tests and the typecheck**

Run: `pnpm --filter @quorum-on-near/gateway exec vitest run test/outcome.test.ts test/rpc-chain.test.ts`

Expected: PASS, 57 tests (`test/outcome.test.ts` 29, `test/rpc-chain.test.ts` 28).

Run: `pnpm --filter @quorum-on-near/gateway typecheck`

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add apps/gateway/src/chain.ts apps/gateway/src/outcome.ts apps/gateway/src/rpc-chain.ts \
  apps/gateway/test/fake-chain.ts apps/gateway/test/fixtures/relayed-commit.provisional.json \
  apps/gateway/test/outcome.test.ts apps/gateway/test/rpc-chain.test.ts
git commit -m "read the chain through a seam and parse relayed outcomes"
```


---

### Task 8: The relayer

The relayer account holds several full-access keys; `KeyPool` lends each to one transaction at a time, so nonces never clash, and the keeper and the payments share it. `RpcRelayer` signs with the leased key, sends once and waits for `EXECUTED_OPTIMISTIC`. Build both of its providers with `{retries: 1}`: near-api-js counts attempts, so `retries: 1` posts a transaction exactly once and `retries: 0` posts nothing. After a timeout, a network failure, or a response it cannot read, it looks the transaction up by hash until the final height passes the delegate's `maxBlockHeight` or the time budget runs out, whichever is first; it never signs or sends a payment twice. A response that comes back before the transaction has executed is looked up the same way. An `unknown` result says whether the delegate can no longer execute (`expired`: the lookup saw a final height above `maxBlockHeight`) or may still land. Only an RPC refusal (the transaction never ran) is `rejected`. Before signing a delegate it checks again that the delegate has not come within `EXPIRY_MARGIN_BLOCKS` of expiring while it waited for a key.

**Files:**
- Create: `apps/gateway/src/relayer.ts`
- Test: `apps/gateway/test/relayer.test.ts`

**Interfaces:**
- Consumes: `ChainWriter`, `RelayResult`, `TxOutcome`, `EXPIRY_MARGIN_BLOCKS`, `DelegateExpiredError` (Task 7); `toTxOutcome` (Task 7); `DecodedSignedDelegate` from the protocol package.
- Produces: `interface KeyLease {keyPair, release()}`, `class KeyPool` (`new KeyPool(keys: KeyPair[])`, `size`, `acquire(timeoutMs?): Promise<KeyLease>`), `interface RpcRelayerOptions {relayer, poolsContract, keys, readProvider, sendProvider, lookupIntervalMs?, callLookupMs?, delegateLookupMs?, sleep?, now?}`, `class RpcRelayer implements ChainWriter`.

- [ ] **Step 1: Write the failing test**

`apps/gateway/test/relayer.test.ts`:

```typescript
import { sha256 } from '@noble/hashes/sha2.js';
import { decodeSignedDelegate, type DecodedSignedDelegate } from '@quorum-on-near/protocol';
import {
  KeyPair,
  KeyPairSigner,
  actions,
  baseEncode,
  buildDelegateAction,
  decodeSignedTransaction,
  encodeSignedDelegate,
  encodeTransaction,
  type Action,
  type Provider,
  type SignedTransaction,
} from 'near-api-js';
import {
  DelegateActionInvalidNonceActionError,
  DelegateActionMustBeOnlyOneActionError,
  InternalRpcError,
  InvalidNonceError,
  InvalidTransactionError,
  RequestRoutedError,
  RpcError,
  RpcMethodNotFoundError,
  RpcRequestParseError,
  ShardCongestedError,
  ShardStuckError,
  TransactionTimeoutError,
  UnknownTransactionError,
} from 'near-api-js/rpc-errors';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DelegateExpiredError } from '../src/chain.ts';
import { KeyPool, RpcRelayer, type RpcRelayerOptions } from '../src/relayer.ts';
import { POOLS, RELAYER, TOKEN } from './fake-chain.ts';

const TGAS = 1_000_000_000_000n;
const BUYER = 'buyer.testnet';
const BLOCK_HASH = baseEncode(new Uint8Array(32).fill(7));
const LOOKUP_INTERVAL_MS = 2_000;
const DELEGATE_LOOKUP_MS = 30_000;
const CALL_LOOKUP_MS = 10_000;
/** A transaction response toTxOutcome cannot read: it has no outcomes. */
const UNREADABLE = { final_execution_status: 'EXECUTED_OPTIMISTIC' };

/** The clock readings of lookups made every LOOKUP_INTERVAL_MS from 0 to `lastMs`. */
function lookupTimes(lastMs: number): number[] {
  return Array.from({ length: lastMs / LOOKUP_INTERVAL_MS + 1 }, (_, i) => i * LOOKUP_INTERVAL_MS);
}

/** A transaction as the fake RPC received it, decoded from its Borsh bytes. */
interface SentTx {
  hash: string;
  signerId: string;
  publicKey: string;
  nonce: bigint;
  receiverId: string;
  actions: Action[];
  waitUntil: string;
}

interface Lookup {
  txHash: string;
  accountId: string;
  waitUntil?: string;
  atMs: number;
  finalHeight: bigint;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function executionOutcome(id: string, executorId: string, status: Record<string, string>) {
  return {
    id,
    block_hash: BLOCK_HASH,
    proof: [],
    outcome: { executor_id: executorId, logs: [], receipt_ids: [], gas_burnt: 2_428_000_000_000, tokens_burnt: '0', status },
  };
}

/** A `send_tx` / `tx` result for a transaction whose one receipt succeeded. */
function executedResponse(tx: SentTx): unknown {
  const receiptId = `${tx.hash}-receipt`;
  return {
    final_execution_status: 'EXECUTED_OPTIMISTIC',
    status: { SuccessValue: '' },
    transaction: { hash: tx.hash, signer_id: tx.signerId, receiver_id: tx.receiverId, nonce: Number(tx.nonce) },
    transaction_outcome: executionOutcome(tx.hash, tx.signerId, { SuccessReceiptId: receiptId }),
    receipts_outcome: [executionOutcome(receiptId, tx.receiverId, { SuccessValue: '' })],
  };
}

/** A `send_tx` / `tx` result returned at `status`, before the transaction's receipt has run. */
function notExecutedResponse(tx: SentTx, status: 'INCLUDED' | 'INCLUDED_FINAL'): unknown {
  const executed = executedResponse(tx) as Record<string, unknown>;
  return { ...executed, final_execution_status: status, status: 'Started', receipts_outcome: [] };
}

/**
 * A scripted RPC node with the four Provider methods the relayer uses. Each `sleep` advances the clock
 * by the time slept and the final height by one block.
 */
class FakeRpc {
  chainNonce = 5n;
  finalHeight = 1_000n;
  clockMs = 0;
  accessKeyReads = 0;
  blockReads = 0;
  sent: SentTx[] = [];
  lookups: Lookup[] = [];
  sleeps: number[] = [];
  /** The send's result; by default the transaction executes. */
  onSend: (tx: SentTx) => Promise<unknown> = async (tx) => executedResponse(tx);
  /** The lookup's result; by default the transaction is never found. */
  onLookup: (txHash: string) => Promise<unknown> = async (txHash) => {
    throw new UnknownTransactionError(txHash);
  };
  /** Fails the next block read when set. */
  blockError: Error | null = null;

  /** Reads go here; it has no send method, so a send through it fails. */
  readProvider(): Provider {
    const read = {
      viewAccessKey: async () => {
        this.accessKeyReads += 1;
        return { nonce: this.chainNonce, permission: 'FullAccess', block_height: Number(this.finalHeight), block_hash: BLOCK_HASH };
      },
      viewBlock: async () => {
        this.blockReads += 1;
        if (this.blockError) throw this.blockError;
        return { header: { height: Number(this.finalHeight), hash: BLOCK_HASH } };
      },
      viewTransactionStatus: async (args: { txHash: string; accountId: string; waitUntil?: string }) => {
        this.lookups.push({ ...args, atMs: this.clockMs, finalHeight: this.finalHeight });
        return this.onLookup(args.txHash);
      },
    };
    return read as unknown as Provider;
  }

  /** Sends go here; it has no read methods. */
  sendProvider(): Provider {
    const send = {
      sendTransactionUntil: async (signed: SignedTransaction, waitUntil: string) => {
        const { transaction } = decodeSignedTransaction(encodeTransaction(signed));
        const tx: SentTx = {
          hash: baseEncode(sha256(encodeTransaction(transaction))),
          signerId: transaction.signerId,
          publicKey: signed.transaction.publicKey.toString(),
          nonce: transaction.nonce,
          receiverId: transaction.receiverId,
          actions: transaction.actions,
          waitUntil,
        };
        this.sent.push(tx);
        return this.onSend(tx);
      },
    };
    return send as unknown as Provider;
  }

  sleep = async (ms: number): Promise<void> => {
    this.sleeps.push(ms);
    this.clockMs += ms;
    this.finalHeight += 1n;
  };
}

function setup(keyCount = 1, options: Partial<RpcRelayerOptions> = {}) {
  const rpc = new FakeRpc();
  const keys = Array.from({ length: keyCount }, () => KeyPair.fromRandom('ed25519'));
  const pool = new KeyPool(keys);
  const relayer = new RpcRelayer({
    relayer: RELAYER,
    poolsContract: POOLS,
    keys: pool,
    readProvider: rpc.readProvider(),
    sendProvider: rpc.sendProvider(),
    lookupIntervalMs: LOOKUP_INTERVAL_MS,
    delegateLookupMs: DELEGATE_LOOKUP_MS,
    callLookupMs: CALL_LOOKUP_MS,
    sleep: rpc.sleep,
    now: () => rpc.clockMs,
    ...options,
  });
  return { rpc, relayer, keys, pool };
}

/** A buyer's signed `ft_transfer_call` delegate, as the gateway receives it decoded. */
async function buyerDelegate(maxBlockHeight = 1_100n): Promise<{ signed: DecodedSignedDelegate; bytes: Uint8Array }> {
  const buyer = KeyPair.fromRandom('ed25519');
  const delegateAction = buildDelegateAction({
    senderId: BUYER,
    receiverId: TOKEN,
    actions: [
      actions.functionCall(
        'ft_transfer_call',
        { receiver_id: POOLS, amount: '360', msg: '{"commit":{"pool_id":7,"seats":2}}' },
        50n * TGAS,
        1n,
      ),
    ],
    nonce: 42n,
    maxBlockHeight,
    publicKey: buyer.getPublicKey(),
  });
  const { signedDelegate } = await new KeyPairSigner(buyer).signDelegateAction(delegateAction);
  const bytes = encodeSignedDelegate(signedDelegate);
  return { signed: decodeSignedDelegate(bytes), bytes };
}

/** Lets every pending promise callback run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
}

describe('KeyPool', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports how many keys it holds', () => {
    const pool = new KeyPool([KeyPair.fromRandom('ed25519'), KeyPair.fromRandom('ed25519')]);
    expect(pool.size).toBe(2);
  });

  it('refuses to be built without a key', () => {
    expect(() => new KeyPool([])).toThrow();
  });

  it('hands out each free key before anyone waits', async () => {
    const [a, b] = [KeyPair.fromRandom('ed25519'), KeyPair.fromRandom('ed25519')];
    const pool = new KeyPool([a, b]);
    const first = await pool.acquire();
    const second = await pool.acquire();
    expect(first.keyPair).toBe(a);
    expect(second.keyPair).toBe(b);
  });

  it('serves waiters first come, first served', async () => {
    const pool = new KeyPool([KeyPair.fromRandom('ed25519')]);
    const held = await pool.acquire();
    const order: string[] = [];
    const second = pool.acquire().then((lease) => {
      order.push('second');
      return lease;
    });
    const third = pool.acquire().then((lease) => {
      order.push('third');
      return lease;
    });
    held.release();
    await Promise.race([second, third]);
    expect(order).toEqual(['second']);
    (await second).release();
    await third;
    expect(order).toEqual(['second', 'third']);
  });

  it('gives a released key to the first waiter without also returning it to the pool', async () => {
    vi.useFakeTimers();
    const pool = new KeyPool([KeyPair.fromRandom('ed25519')]);
    const held = await pool.acquire();
    const waiter = pool.acquire();
    held.release();
    await waiter;
    const another = expect(pool.acquire(1_000)).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(1_000);
    await another;
  });

  it('rejects an acquire that waits longer than its timeout', async () => {
    vi.useFakeTimers();
    const pool = new KeyPool([KeyPair.fromRandom('ed25519')]);
    await pool.acquire();
    const waiting = expect(pool.acquire(1_000)).rejects.toThrow(/1000 ms/);
    await vi.advanceTimersByTimeAsync(1_000);
    await waiting;
  });

  it('waits 30 seconds by default', async () => {
    vi.useFakeTimers();
    const pool = new KeyPool([KeyPair.fromRandom('ed25519')]);
    await pool.acquire();
    let rejected = false;
    pool.acquire().catch(() => {
      rejected = true;
    });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(rejected).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(rejected).toBe(true);
  });

  it('gives a key released after a waiter timed out to the next caller', async () => {
    vi.useFakeTimers();
    const key = KeyPair.fromRandom('ed25519');
    const pool = new KeyPool([key]);
    const held = await pool.acquire();
    const timedOut = expect(pool.acquire(1_000)).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(1_000);
    await timedOut;
    held.release();
    expect((await pool.acquire(0)).keyPair).toBe(key);
  });

  it('returns a key to the pool only once however often its lease is released', async () => {
    vi.useFakeTimers();
    const pool = new KeyPool([KeyPair.fromRandom('ed25519')]);
    const lease = await pool.acquire();
    lease.release();
    lease.release();
    await pool.acquire();
    const second = expect(pool.acquire(1_000)).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(1_000);
    await second;
  });
});

describe('RpcRelayer.relayDelegate', () => {
  it('returns the outcome of a relay that executes', async () => {
    const { rpc, relayer } = setup();
    const { signed } = await buyerDelegate();
    const result = await relayer.relayDelegate(signed, 1_100n);
    expect(result).toMatchObject({ kind: 'executed', outcome: { txHash: rpc.sent[0]?.hash } });
    expect(rpc.sent[0]?.waitUntil).toBe('EXECUTED_OPTIMISTIC');
  });

  it("sends the relayer's transaction to the delegate's sender with one signedDelegate action", async () => {
    const { rpc, relayer, keys } = setup();
    const { signed, bytes } = await buyerDelegate();
    await relayer.relayDelegate(signed, 1_100n);
    const [tx] = rpc.sent;
    expect(tx).toMatchObject({ signerId: RELAYER, receiverId: BUYER, publicKey: keys[0]?.getPublicKey().toString() });
    expect(tx?.actions).toHaveLength(1);
    const inner = tx?.actions[0]?.signedDelegate;
    expect(inner).toBeDefined();
    expect(encodeSignedDelegate(inner!)).toEqual(bytes);
  });

  it('uses the next nonce after the chain nonce and keeps counting from its cache', async () => {
    const { rpc, relayer } = setup();
    const { signed } = await buyerDelegate();
    await relayer.relayDelegate(signed, 1_100n);
    await relayer.relayDelegate(signed, 1_100n);
    expect(rpc.sent.map((tx) => tx.nonce)).toEqual([6n, 7n]);
    expect(rpc.accessKeyReads).toBe(1);
  });

  it('looks a timed-out send up by hash without sending it again', async () => {
    const { rpc, relayer } = setup();
    rpc.onSend = async () => {
      throw new TransactionTimeoutError();
    };
    let lookups = 0;
    rpc.onLookup = async (txHash) => {
      lookups += 1;
      if (lookups < 3) throw new UnknownTransactionError(txHash);
      return executedResponse(rpc.sent[0]!);
    };
    const { signed } = await buyerDelegate();
    const result = await relayer.relayDelegate(signed, 1_100n);
    const hash = rpc.sent[0]?.hash;
    expect(result).toMatchObject({ kind: 'executed', outcome: { txHash: hash } });
    expect(rpc.sent).toHaveLength(1);
    expect(rpc.lookups.map(({ txHash, accountId, waitUntil }) => ({ txHash, accountId, waitUntil }))).toEqual(
      Array(3).fill({ txHash: hash, accountId: RELAYER, waitUntil: 'EXECUTED_OPTIMISTIC' }),
    );
    expect(rpc.sleeps).toEqual([LOOKUP_INTERVAL_MS, LOOKUP_INTERVAL_MS]);
  });

  it('gives unknown and expired once the final height has passed maxBlockHeight with nothing found', async () => {
    const { rpc, relayer } = setup();
    rpc.onSend = async () => {
      throw new TransactionTimeoutError();
    };
    const { signed } = await buyerDelegate(1_008n);
    const result = await relayer.relayDelegate(signed, 1_008n);
    expect(result).toEqual({ kind: 'unknown', txHash: rpc.sent[0]?.hash, expired: true });
    expect(rpc.sent).toHaveLength(1);
    expect(rpc.lookups.map((lookup) => lookup.finalHeight)).toEqual(
      Array.from({ length: 10 }, (_, i) => 1_000n + BigInt(i)),
    );
  });

  it('looks once more after seeing the height pass, in case the transaction landed meanwhile', async () => {
    const { rpc, relayer } = setup();
    rpc.onSend = async () => {
      throw new TransactionTimeoutError();
    };
    let landed = false;
    rpc.onLookup = async (txHash) => {
      if (landed) return executedResponse(rpc.sent[0]!);
      if (rpc.finalHeight === 1_008n) {
        // The transaction lands, and the chain moves past maxBlockHeight, while this lookup runs.
        landed = true;
        rpc.finalHeight = 1_009n;
      }
      throw new UnknownTransactionError(txHash);
    };
    const { signed } = await buyerDelegate(1_008n);
    const result = await relayer.relayDelegate(signed, 1_008n);
    expect(result.kind).toBe('executed');
  });

  it('keeps looking while the final height cannot be read', async () => {
    const { rpc, relayer } = setup();
    const { signed } = await buyerDelegate(1_010n);
    rpc.onSend = async () => {
      // The chain moves past maxBlockHeight while the send runs, but its height cannot be read.
      rpc.finalHeight = 1_020n;
      rpc.blockError = new TypeError('fetch failed');
      throw new TransactionTimeoutError();
    };
    rpc.onLookup = async (txHash) => {
      if (rpc.lookups.length === 3) rpc.blockError = null;
      throw new UnknownTransactionError(txHash);
    };
    const result = await relayer.relayDelegate(signed, 1_010n);
    expect(result).toEqual({ kind: 'unknown', txHash: rpc.sent[0]?.hash, expired: true });
    expect(rpc.lookups).toHaveLength(4);
  });

  it('gives unknown, not expired, after delegateLookupMs while the final height cannot be read', async () => {
    const { rpc, relayer } = setup();
    rpc.onSend = async () => {
      rpc.blockError = new TypeError('fetch failed');
      throw new TransactionTimeoutError();
    };
    const { signed } = await buyerDelegate();
    const result = await relayer.relayDelegate(signed, 1_100n);
    expect(result).toEqual({ kind: 'unknown', txHash: rpc.sent[0]?.hash, expired: false });
    expect(rpc.lookups.map((lookup) => lookup.atMs)).toEqual(lookupTimes(DELEGATE_LOOKUP_MS));
  });

  it('gives unknown, not expired, after delegateLookupMs while the final height stays below maxBlockHeight', async () => {
    const { rpc, relayer } = setup();
    rpc.onSend = async () => {
      throw new TransactionTimeoutError();
    };
    const { signed } = await buyerDelegate(1_000_000n);
    const result = await relayer.relayDelegate(signed, 1_000_000n);
    expect(result).toEqual({ kind: 'unknown', txHash: rpc.sent[0]?.hash, expired: false });
    expect(rpc.lookups.map((lookup) => lookup.atMs)).toEqual(lookupTimes(DELEGATE_LOOKUP_MS));
  });

  it('looks a delegate up for 240 seconds by default', async () => {
    const { rpc, relayer } = setup(1, { delegateLookupMs: undefined });
    rpc.onSend = async () => {
      throw new TransactionTimeoutError();
    };
    const { signed } = await buyerDelegate(1_000_000n);
    await relayer.relayDelegate(signed, 1_000_000n);
    expect(rpc.lookups.at(-1)?.atMs).toBe(240_000);
  });

  it('looks up a send whose response cannot be read, without sending it again', async () => {
    const { rpc, relayer } = setup();
    rpc.onSend = async () => UNREADABLE;
    rpc.onLookup = async () => executedResponse(rpc.sent[0]!);
    const { signed } = await buyerDelegate();
    const result = await relayer.relayDelegate(signed, 1_100n);
    expect(result).toMatchObject({ kind: 'executed', outcome: { txHash: rpc.sent[0]?.hash } });
    expect(rpc.sent).toHaveLength(1);
    expect(rpc.lookups).toHaveLength(1);
  });

  it('gives unknown at the deadline when the send response cannot be read and nothing is found', async () => {
    const { rpc, relayer } = setup();
    rpc.onSend = async () => UNREADABLE;
    const { signed } = await buyerDelegate(1_008n);
    const result = await relayer.relayDelegate(signed, 1_008n);
    expect(result).toEqual({ kind: 'unknown', txHash: rpc.sent[0]?.hash, expired: true });
    expect(rpc.sent).toHaveLength(1);
  });

  it.each(['INCLUDED', 'INCLUDED_FINAL'] as const)(
    'looks up a send that returns at %s, before its receipts have run, without sending it again',
    async (status) => {
      const { rpc, relayer } = setup();
      rpc.onSend = async (tx) => notExecutedResponse(tx, status);
      rpc.onLookup = async () => executedResponse(rpc.sent[0]!);
      const { signed } = await buyerDelegate();
      const result = await relayer.relayDelegate(signed, 1_100n);
      expect(result).toMatchObject({
        kind: 'executed',
        outcome: { txHash: rpc.sent[0]?.hash, receipts: [{ executorId: RELAYER }, { executorId: BUYER }] },
      });
      expect(rpc.sent).toHaveLength(1);
      expect(rpc.lookups).toHaveLength(1);
    },
  );

  it('gives unknown after delegateLookupMs when no lookup gets past INCLUDED', async () => {
    const { rpc, relayer } = setup();
    rpc.onSend = async (tx) => notExecutedResponse(tx, 'INCLUDED');
    rpc.onLookup = async () => notExecutedResponse(rpc.sent[0]!, 'INCLUDED');
    const { signed } = await buyerDelegate(1_000_000n);
    const result = await relayer.relayDelegate(signed, 1_000_000n);
    expect(result).toEqual({ kind: 'unknown', txHash: rpc.sent[0]?.hash, expired: false });
    expect(rpc.sent).toHaveLength(1);
    expect(rpc.lookups.map((lookup) => lookup.atMs)).toEqual(lookupTimes(DELEGATE_LOOKUP_MS));
  });

  it('treats a lookup response that cannot be read as not found and keeps looking', async () => {
    const { rpc, relayer } = setup();
    rpc.onSend = async () => {
      throw new TransactionTimeoutError();
    };
    rpc.onLookup = async () => (rpc.lookups.length < 3 ? UNREADABLE : executedResponse(rpc.sent[0]!));
    const { signed } = await buyerDelegate();
    const result = await relayer.relayDelegate(signed, 1_100n);
    expect(result).toMatchObject({ kind: 'executed', outcome: { txHash: rpc.sent[0]?.hash } });
    expect(rpc.lookups).toHaveLength(3);
  });

  it('gives unknown at the deadline when no lookup response can be read', async () => {
    const { rpc, relayer } = setup();
    rpc.onSend = async () => {
      throw new TransactionTimeoutError();
    };
    rpc.onLookup = async () => UNREADABLE;
    const { signed } = await buyerDelegate(1_008n);
    const result = await relayer.relayDelegate(signed, 1_008n);
    expect(result).toEqual({ kind: 'unknown', txHash: rpc.sent[0]?.hash, expired: true });
    expect(rpc.sent).toHaveLength(1);
  });

  it('treats a network failure during the send like a timeout', async () => {
    const { rpc, relayer } = setup();
    rpc.onSend = async () => {
      throw new TypeError('fetch failed');
    };
    rpc.onLookup = async () => executedResponse(rpc.sent[0]!);
    const { signed } = await buyerDelegate();
    const result = await relayer.relayDelegate(signed, 1_100n);
    expect(result).toMatchObject({ kind: 'executed', outcome: { txHash: rpc.sent[0]?.hash } });
    expect(rpc.sent).toHaveLength(1);
  });

  it.each([
    ['a server error', new InternalRpcError('internal error')],
    ['a routed request', new RequestRoutedError('tx')],
    ['an unrecognised RpcError', new RpcError('Unknown RPC error')],
    ['a DelegateActionInvalidNonce action error', new DelegateActionInvalidNonceActionError(42, 42, 0, '', '')],
    ['a DelegateActionMustBeOnlyOne validation error', new DelegateActionMustBeOnlyOneActionError(null, '', '')],
  ])('treats %s from the RPC like a timeout, not a rejection', async (_, error) => {
    const { rpc, relayer } = setup();
    rpc.onSend = async () => {
      throw error;
    };
    rpc.onLookup = async () => executedResponse(rpc.sent[0]!);
    const { signed } = await buyerDelegate();
    const result = await relayer.relayDelegate(signed, 1_100n);
    expect(result.kind).toBe('executed');
    expect(rpc.sent).toHaveLength(1);
  });

  it('rejects on an invalid nonce, and the next transaction re-reads the nonce', async () => {
    const { rpc, relayer } = setup();
    rpc.onSend = async (tx) => {
      rpc.chainNonce = 9n;
      throw new InvalidNonceError(9, Number(tx.nonce), tx.hash, BLOCK_HASH);
    };
    const { signed } = await buyerDelegate();
    const rejected = await relayer.relayDelegate(signed, 1_100n);
    expect(rejected).toEqual({ kind: 'rejected', txHash: rpc.sent[0]?.hash, error: expect.stringMatching(/Invalid nonce/) });
    expect(rpc.lookups).toHaveLength(0);

    rpc.onSend = async (tx) => executedResponse(tx);
    const next = await relayer.relayDelegate(signed, 1_100n);
    expect(next.kind).toBe('executed');
    expect(rpc.sent[1]?.nonce).toBe(10n);
    expect(rpc.accessKeyReads).toBe(2);
  });

  it.each([
    ['an invalid transaction with no details', new InvalidTransactionError()],
    ['a request it cannot parse', new RpcRequestParseError('invalid base64')],
    ['an unknown method', new RpcMethodNotFoundError('send_tx')],
    ['a congested shard', new ShardCongestedError(1, 0, '', '')],
    ['a stuck shard', new ShardStuckError(10, 0, '', '')],
  ])('rejects on %s, looking nothing up', async (_, error) => {
    const { rpc, relayer } = setup();
    rpc.onSend = async () => {
      throw error;
    };
    const { signed } = await buyerDelegate();
    const result = await relayer.relayDelegate(signed, 1_100n);
    expect(result).toEqual({ kind: 'rejected', txHash: rpc.sent[0]?.hash, error: String(error) });
    expect(rpc.sent).toHaveLength(1);
    expect(rpc.lookups).toHaveLength(0);
  });

  it('throws an RPC failure that happens before anything is sent', async () => {
    const { rpc, relayer } = setup();
    rpc.blockError = new TypeError('fetch failed');
    const { signed } = await buyerDelegate();
    await expect(relayer.relayDelegate(signed, 1_100n)).rejects.toThrow('fetch failed');
    expect(rpc.sent).toHaveLength(0);
  });

  it('serialises two relays that share one key: the second is built only after the first finishes', async () => {
    const { rpc, relayer } = setup(1);
    const firstSent = deferred<SentTx>();
    const firstResult = deferred<unknown>();
    rpc.onSend = (tx) => {
      firstSent.resolve(tx);
      return firstResult.promise;
    };
    const { signed } = await buyerDelegate();
    const first = relayer.relayDelegate(signed, 1_100n);
    const second = relayer.relayDelegate(signed, 1_100n);
    const tx = await firstSent.promise;
    await settle();
    expect(rpc.sent).toHaveLength(1);
    // The first relay's expiry check and its transaction's block hash; nothing from the second.
    expect(rpc.blockReads).toBe(2);

    rpc.onSend = async (next) => executedResponse(next);
    firstResult.resolve(executedResponse(tx));
    await Promise.all([first, second]);
    expect(rpc.sent.map((sent) => sent.nonce)).toEqual([6n, 7n]);
  });

  it('keeps the key leased while a timed-out transaction is looked up', async () => {
    const { rpc, relayer } = setup(1);
    rpc.onSend = async (tx) => {
      if (rpc.sent.length === 1) throw new TransactionTimeoutError();
      return executedResponse(tx);
    };
    const lookupStarted = deferred<void>();
    const lookupResult = deferred<unknown>();
    rpc.onLookup = () => {
      lookupStarted.resolve();
      return lookupResult.promise;
    };
    const { signed } = await buyerDelegate();
    const first = relayer.relayDelegate(signed, 1_100n);
    const second = relayer.relayDelegate(signed, 1_100n);
    await lookupStarted.promise;
    await settle();
    expect(rpc.sent).toHaveLength(1);

    lookupResult.resolve(executedResponse(rpc.sent[0]!));
    await Promise.all([first, second]);
    expect(rpc.sent).toHaveLength(2);
  });

  it('relays with two keys at the same time', async () => {
    const { rpc, relayer, keys } = setup(2);
    const results = deferred<void>();
    rpc.onSend = async (tx) => {
      if (rpc.sent.length === 2) results.resolve();
      await results.promise;
      return executedResponse(tx);
    };
    const { signed } = await buyerDelegate();
    await Promise.all([relayer.relayDelegate(signed, 1_100n), relayer.relayDelegate(signed, 1_100n)]);
    expect(new Set(rpc.sent.map((tx) => tx.publicKey))).toEqual(new Set(keys.map((key) => key.getPublicKey().toString())));
  });
});

describe('RpcRelayer.relayDelegate expiry check', () => {
  it('throws DelegateExpiredError and sends nothing when maxBlockHeight is 5 blocks past the final height', async () => {
    const { rpc, relayer } = setup();
    const { signed } = await buyerDelegate(1_005n);
    await expect(relayer.relayDelegate(signed, 1_005n)).rejects.toBeInstanceOf(DelegateExpiredError);
    expect(rpc.sent).toHaveLength(0);
  });

  it('relays a delegate whose maxBlockHeight is 6 blocks past the final height', async () => {
    const { relayer } = setup();
    const { signed } = await buyerDelegate(1_006n);
    expect((await relayer.relayDelegate(signed, 1_006n)).kind).toBe('executed');
  });

  it('builds no transaction for an expired delegate, so the next one takes the next nonce', async () => {
    const { rpc, relayer } = setup();
    const expired = await buyerDelegate(1_005n);
    await expect(relayer.relayDelegate(expired.signed, 1_005n)).rejects.toBeInstanceOf(DelegateExpiredError);
    const { signed } = await buyerDelegate();
    await relayer.relayDelegate(signed, 1_100n);
    expect(rpc.sent.map((tx) => tx.nonce)).toEqual([6n]);
  });

  it('checks the final height once the key is leased, so a delegate that expires while waiting is not sent', async () => {
    const { rpc, relayer } = setup(1);
    const firstSent = deferred<SentTx>();
    const firstResult = deferred<unknown>();
    rpc.onSend = (tx) => {
      firstSent.resolve(tx);
      return firstResult.promise;
    };
    const first = await buyerDelegate();
    const waiting = await buyerDelegate(1_008n);
    const firstRelay = relayer.relayDelegate(first.signed, 1_100n);
    const secondRelay = relayer.relayDelegate(waiting.signed, 1_008n);
    const tx = await firstSent.promise;
    // The chain moves on while the second relay waits for the key.
    rpc.finalHeight = 1_003n;
    firstResult.resolve(executedResponse(tx));
    await firstRelay;
    await expect(secondRelay).rejects.toBeInstanceOf(DelegateExpiredError);
    expect(rpc.sent).toHaveLength(1);
  });
});

describe('RpcRelayer key lease', () => {
  const cases: Array<[string, (rpc: FakeRpc) => void, bigint]> = [
    ['the relay executes', () => {}, 1_100n],
    [
      'the RPC rejects the transaction',
      (rpc) => {
        rpc.onSend = async (tx) => {
          throw new InvalidNonceError(9, Number(tx.nonce), tx.hash, BLOCK_HASH);
        };
      },
      1_100n,
    ],
    [
      'the result stays unknown',
      (rpc) => {
        rpc.onSend = async () => {
          throw new TransactionTimeoutError();
        };
      },
      1_008n,
    ],
    [
      'no response can be read',
      (rpc) => {
        rpc.onSend = async () => UNREADABLE;
        rpc.onLookup = async () => UNREADABLE;
      },
      1_008n,
    ],
    ['the delegate has expired', () => {}, 1_005n],
    [
      'a read fails before sending',
      (rpc) => {
        rpc.blockError = new TypeError('fetch failed');
      },
      1_100n,
    ],
  ];

  it.each(cases)('is released when %s', async (_, arrange, maxBlockHeight) => {
    const { rpc, relayer, pool } = setup(1);
    arrange(rpc);
    const { signed } = await buyerDelegate(maxBlockHeight);
    await relayer.relayDelegate(signed, maxBlockHeight).catch(() => undefined);
    await expect(pool.acquire(0)).resolves.toBeDefined();
  });
});

describe('RpcRelayer.callPools', () => {
  it('sends a function call to the pools contract with the given gas and no deposit', async () => {
    const { rpc, relayer } = setup();
    const result = await relayer.callPools('refund', { pool_id: 7, limit: 10 }, 300n * TGAS);
    expect(result).toMatchObject({ kind: 'executed', outcome: { txHash: rpc.sent[0]?.hash } });
    const [tx] = rpc.sent;
    expect(tx).toMatchObject({ signerId: RELAYER, receiverId: POOLS });
    expect(tx?.actions).toHaveLength(1);
    const call = tx?.actions[0]?.functionCall;
    expect(call).toMatchObject({ methodName: 'refund', gas: 300n * TGAS, deposit: 0n });
    expect(JSON.parse(new TextDecoder().decode(Uint8Array.from(call!.args)))).toEqual({ pool_id: 7, limit: 10 });
  });

  it('looks a timed-out call up for callLookupMs, then gives unknown, not expired', async () => {
    const { rpc, relayer } = setup();
    rpc.onSend = async () => {
      throw new TransactionTimeoutError();
    };
    const result = await relayer.callPools('settle', { pool_id: 7 }, 100n * TGAS);
    expect(result).toEqual({ kind: 'unknown', txHash: rpc.sent[0]?.hash, expired: false });
    expect(rpc.sent).toHaveLength(1);
    expect(rpc.lookups.map((lookup) => lookup.atMs)).toEqual(lookupTimes(CALL_LOOKUP_MS));
  });

  it('looks up a call whose send response cannot be read, without sending it again', async () => {
    const { rpc, relayer } = setup();
    rpc.onSend = async () => UNREADABLE;
    rpc.onLookup = async () => executedResponse(rpc.sent[0]!);
    const result = await relayer.callPools('settle', { pool_id: 7 }, 100n * TGAS);
    expect(result).toMatchObject({ kind: 'executed', outcome: { txHash: rpc.sent[0]?.hash } });
    expect(rpc.sent).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @quorum-on-near/gateway exec vitest run test/relayer.test.ts`

Expected: FAIL. vitest cannot load `../src/relayer.ts`, which does not exist yet.

- [ ] **Step 3: Write the implementation**

`apps/gateway/src/relayer.ts`:

```typescript
import { setTimeout as delay } from 'node:timers/promises';
import type { DecodedSignedDelegate } from '@quorum-on-near/protocol';
import { Account, KeyPairSigner, actions, baseEncode, type Action, type KeyPair, type Provider } from 'near-api-js';
import {
  ActionExecutionError,
  InvalidTransactionError,
  RequestValidationError,
  TransactionExecutionError,
} from 'near-api-js/rpc-errors';
import { DelegateExpiredError, EXPIRY_MARGIN_BLOCKS, type ChainWriter, type RelayResult, type TxOutcome } from './chain.ts';
import { toTxOutcome } from './outcome.ts';

/** A key on loan from the pool. Release it exactly once. */
export interface KeyLease {
  keyPair: KeyPair;
  release(): void;
}

/** The relayer's access keys. Each key signs one transaction at a time, so nonces never clash. */
export class KeyPool {
  readonly #size: number;
  readonly #free: KeyPair[];
  readonly #waiters: Array<(lease: KeyLease) => void> = [];

  constructor(keys: KeyPair[]) {
    if (keys.length === 0) throw new Error('KeyPool needs at least one key');
    this.#size = keys.length;
    this.#free = [...keys];
  }

  get size(): number {
    return this.#size;
  }

  /** Waits for a free key, first come first served. Rejects after `timeoutMs` (default 30 s). */
  acquire(timeoutMs = 30_000): Promise<KeyLease> {
    const keyPair = this.#free.shift();
    if (keyPair) return Promise.resolve(this.#lease(keyPair));
    return new Promise((resolve, reject) => {
      const waiter = (lease: KeyLease): void => {
        clearTimeout(timer);
        resolve(lease);
      };
      const timer = setTimeout(() => {
        const index = this.#waiters.indexOf(waiter);
        if (index !== -1) this.#waiters.splice(index, 1);
        reject(new Error(`no relayer key was free within ${timeoutMs} ms`));
      }, timeoutMs);
      this.#waiters.push(waiter);
    });
  }

  #lease(keyPair: KeyPair): KeyLease {
    let released = false;
    return {
      keyPair,
      release: () => {
        if (released) return;
        released = true;
        const next = this.#waiters.shift();
        if (next) next(this.#lease(keyPair));
        else this.#free.push(keyPair);
      },
    };
  }
}

/**
 * Build both providers with `retries: 1`. near-api-js counts attempts (with `retries: 0` it posts
 * nothing), so a transaction is posted at most once, and each lookup posts once and leaves the
 * deadline to be checked between posts.
 */
export interface RpcRelayerOptions {
  relayer: string;
  poolsContract: string;
  keys: KeyPool;
  /** Reads: nonces, blocks, transaction lookups. Construct it with `retries: 1`. */
  readProvider: Provider;
  /** Sends only. Construct it with `retries: 1`, so a transaction is posted at most once. */
  sendProvider: Provider;
  /** How often a lookup by hash is retried. Default 2000 ms. */
  lookupIntervalMs?: number;
  /**
   * How long a delegate is looked up, at most, after a send whose result is not known. The lookup
   * ends sooner once the final height passes the delegate's `maxBlockHeight`. Default 240 000 ms.
   */
  delegateLookupMs?: number;
  /** How long a keeper call is looked up after a send whose result is not known. Default 60 000 ms. */
  callLookupMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * When a lookup by hash gives up: after `lookupMs`, or, for a delegate, once the final height passes
 * its `maxBlockHeight` (the result is then `unknown` and `expired`), whichever comes first.
 */
interface Deadline {
  lookupMs: number;
  maxBlockHeight?: bigint;
}

type SignedDelegateParts = Parameters<typeof actions.signedDelegate>[0];

/**
 * True when the RPC refused the transaction while validating it (a bad nonce, an expired block hash,
 * a congested or stuck shard, a malformed request), so it never ran. A timeout, a routed request, a
 * server error, an error it does not recognise or a network failure leaves its fate open.
 */
function refused(error: unknown): boolean {
  // An action error is what a transaction that ran raises. near-api-js also gives one to a transaction
  // refused for an invalid action; that one is looked up too, which only delays its answer.
  if (error instanceof ActionExecutionError) return false;
  return (
    error instanceof TransactionExecutionError ||
    error instanceof InvalidTransactionError ||
    error instanceof RequestValidationError
  );
}

/**
 * The outcome in a transaction response, or null when the response cannot be read as one, including a
 * response from before every non-refund receipt had run.
 */
function readOutcome(response: unknown): TxOutcome | null {
  try {
    return toTxOutcome(response);
  } catch {
    return null;
  }
}

/**
 * ChainWriter that signs with the relayer account. It builds and signs each transaction with a leased
 * key, sends it once and waits for `EXECUTED_OPTIMISTIC`. A delegate is first checked against the
 * final height and refused with DelegateExpiredError, before anything is built or signed, when it is
 * about to expire. If the send times out, the network fails, the RPC cannot say whether it took the
 * transaction (a routed request, a server error) or its response cannot be read (or comes back below
 * `EXECUTED_OPTIMISTIC`), it looks the transaction up by hash (never re-signing or re-sending) until a
 * readable outcome is found or the deadline passes. An RPC error that refuses the transaction is a
 * rejection: nothing ran, and the key's cached nonce is dropped. Nothing throws once a transaction
 * has been sent.
 *
 * The key goes back to the pool once a result is returned, even an `unknown` one whose transaction
 * may still be pending. Nonces are ordered, so the key's next transaction cannot clash with it: if
 * the next one lands first, the pending one can no longer land.
 */
export class RpcRelayer implements ChainWriter {
  readonly #relayer: string;
  readonly #poolsContract: string;
  readonly #keys: KeyPool;
  readonly #read: Provider;
  readonly #send: Provider;
  readonly #lookupIntervalMs: number;
  readonly #delegateLookupMs: number;
  readonly #callLookupMs: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => number;
  /** One Account per key, each holding near-api-js's nonce cache for that key alone. */
  readonly #accounts = new Map<string, Account>();

  constructor(opts: RpcRelayerOptions) {
    this.#relayer = opts.relayer;
    this.#poolsContract = opts.poolsContract;
    this.#keys = opts.keys;
    this.#read = opts.readProvider;
    this.#send = opts.sendProvider;
    this.#lookupIntervalMs = opts.lookupIntervalMs ?? 2_000;
    this.#delegateLookupMs = opts.delegateLookupMs ?? 240_000;
    this.#callLookupMs = opts.callLookupMs ?? 60_000;
    this.#sleep = opts.sleep ?? ((ms) => delay(ms));
    this.#now = opts.now ?? Date.now;
  }

  relayDelegate(signed: DecodedSignedDelegate, maxBlockHeight: bigint): Promise<RelayResult> {
    // Borsh encodes by field name, so the decoded plain objects serialize like near-api-js's classes.
    const action = actions.signedDelegate(signed as unknown as SignedDelegateParts);
    return this.#submit(signed.delegateAction.senderId, action, { lookupMs: this.#delegateLookupMs, maxBlockHeight });
  }

  callPools(method: 'settle' | 'refund', args: Record<string, unknown>, gas: bigint): Promise<RelayResult> {
    const action = actions.functionCall(method, args, gas, 0n);
    return this.#submit(this.#poolsContract, action, { lookupMs: this.#callLookupMs });
  }

  async #submit(receiverId: string, action: Action, deadline: Deadline): Promise<RelayResult> {
    const lease = await this.#keys.acquire();
    try {
      // After the lease, since waiting for a key takes blocks; before the transaction is built, since
      // building it reserves a nonce.
      if (deadline.maxBlockHeight !== undefined) await this.#refuseExpired(deadline.maxBlockHeight);
      const publicKey = lease.keyPair.getPublicKey().toString();
      const transaction = await this.#account(publicKey).createTransaction({ receiverId, actions: [action], publicKey });
      const signer = new KeyPairSigner(lease.keyPair);
      const { txHash: hashBytes, signedTransaction } = await signer.signTransaction(transaction);
      const txHash = baseEncode(hashBytes);
      let response: unknown;
      try {
        response = await this.#send.sendTransactionUntil(signedTransaction, 'EXECUTED_OPTIMISTIC');
      } catch (error) {
        if (!refused(error)) return await this.#lookUp(txHash, deadline);
        this.#accounts.delete(publicKey);
        return { kind: 'rejected', txHash, error: String(error) };
      }
      const outcome = readOutcome(response);
      if (outcome === null) return await this.#lookUp(txHash, deadline);
      return { kind: 'executed', outcome };
    } finally {
      lease.release();
    }
  }

  #account(publicKey: string): Account {
    let account = this.#accounts.get(publicKey);
    if (!account) {
      account = new Account(this.#relayer, this.#read);
      this.#accounts.set(publicKey, account);
    }
    return account;
  }

  /** Throws DelegateExpiredError when the final height is within EXPIRY_MARGIN_BLOCKS of `maxBlockHeight`. */
  async #refuseExpired(maxBlockHeight: bigint): Promise<void> {
    const block = await this.#read.viewBlock({ finality: 'final' });
    const height = BigInt(block.header.height);
    if (height + EXPIRY_MARGIN_BLOCKS >= maxBlockHeight) {
      throw new DelegateExpiredError(`the delegate expires at block ${maxBlockHeight} and the final height is ${height}`);
    }
  }

  /**
   * Looks the transaction up every `lookupIntervalMs` until an outcome is found or the deadline passes.
   * The clock is checked first, so no block is read once the time is up.
   */
  async #lookUp(txHash: string, { lookupMs, maxBlockHeight }: Deadline): Promise<RelayResult> {
    const end = this.#now() + lookupMs;
    for (;;) {
      // Read the deadline before looking, so the last lookup is made after the deadline has passed.
      const timeUp = this.#now() >= end;
      const expired = !timeUp && maxBlockHeight !== undefined && (await this.#finalHeightAbove(maxBlockHeight));
      const outcome = readOutcome(await this.#find(txHash));
      if (outcome !== null) return { kind: 'executed', outcome };
      if (timeUp || expired) return { kind: 'unknown', txHash, expired };
      await this.#sleep(this.#lookupIntervalMs);
    }
  }

  /** False while the final height cannot be read: the lookup goes on. */
  async #finalHeightAbove(height: bigint): Promise<boolean> {
    try {
      const block = await this.#read.viewBlock({ finality: 'final' });
      return BigInt(block.header.height) > height;
    } catch {
      return false;
    }
  }

  /** The transaction's response, or null while the RPC does not have it. */
  async #find(txHash: string): Promise<unknown> {
    try {
      return await this.#read.viewTransactionStatus({
        txHash,
        accountId: this.#relayer,
        waitUntil: 'EXECUTED_OPTIMISTIC',
      });
    } catch {
      return null;
    }
  }
}
```

- [ ] **Step 4: Run the tests and the typecheck**

Run: `pnpm --filter @quorum-on-near/gateway exec vitest run test/relayer.test.ts`

Expected: PASS, 55 tests (`test/relayer.test.ts` 55).

Run: `pnpm --filter @quorum-on-near/gateway typecheck`

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/relayer.ts apps/gateway/test/relayer.test.ts
git commit -m "relay transactions with leased keys, sending each once"
```


---

### Task 9: Activity feed, guards and served pools

The activity feed (spec section 6.7) is a JSON-lines file under `data/`, which is gitignored; it exists to give transaction links, and the money state is always read from the contract. `ActivityLog.open` ends a line cut short by a stop mid-write with a newline, so the next record is not lost. `keeperCallProgressed` says whether a keeper call moved its pool (Task 13 backs off from those that did not), and `keeperRecords` writes no failure row for a call that did. `InFlight` allows one payment in flight per buyer (spec section 6.4), and holds a buyer whose payment's result is unknown and may still land until a final height above its `max_block_height` is seen. `NonceCache` remembers redemption nonces. The gateway serves only its provider's pools (spec section 6.1).

**Files:**
- Create: `apps/gateway/src/guards.ts`, `apps/gateway/src/pools.ts`, `apps/gateway/src/activity.ts`
- Test: `apps/gateway/test/guards.test.ts`, `apps/gateway/test/pools.test.ts`, `apps/gateway/test/activity.test.ts`

**Interfaces:**
- Consumes: `ChainReader`, `TxOutcome` (Task 7); `poolsEvents` (Task 7); `MAX_PAGE`, `minBonusPerSeat`, `PoolView` from the protocol package.
- Produces: `class InFlight {begin(buyer): boolean; end(buyer); has(buyer); hold(buyer, maxBlockHeight: bigint); held(buyer): boolean; passed(finalHeight: bigint)}`, `class NonceCache` (`new NonceCache(ttlMs)`, `seen(key, nowMs): boolean`); `listServedPools(chain, provider): Promise<PoolView[]>`, `interface PoolListing`, `openPoolListings(chain, provider): Promise<PoolListing[]>`, `servedPool(chain, provider, poolId): Promise<PoolView | null>`; `type ActivityKind`, `interface ActivityRecord {at, poolId, kind, account, seats, amount, txHash, ok}`, `class ActivityLog` (`ActivityLog.open(file)`, `append(record)`, `list(poolId?)`, `lastRefund(poolId, account)`), `keeperCallProgressed(kind: 'settle' | 'refund', pool: PoolView, outcome: TxOutcome, poolsContract: string): boolean`, `keeperRecords(kind, pool, outcome, poolsContract, at): ActivityRecord[]`.

- [ ] **Step 1: Write the failing tests**

`apps/gateway/test/guards.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';
import { InFlight, NonceCache } from '../src/guards.ts';

describe('InFlight', () => {
  it('marks a buyer busy on begin', () => {
    const inFlight = new InFlight();
    expect(inFlight.begin('alice.testnet')).toBe(true);
    expect(inFlight.has('alice.testnet')).toBe(true);
  });

  it('refuses a second begin for a buyer that is already busy', () => {
    const inFlight = new InFlight();
    inFlight.begin('alice.testnet');
    expect(inFlight.begin('alice.testnet')).toBe(false);
    expect(inFlight.has('alice.testnet')).toBe(true);
  });

  it('frees the buyer on end, so begin succeeds again', () => {
    const inFlight = new InFlight();
    inFlight.begin('alice.testnet');
    inFlight.end('alice.testnet');
    expect(inFlight.has('alice.testnet')).toBe(false);
    expect(inFlight.begin('alice.testnet')).toBe(true);
  });

  it('tracks each buyer separately', () => {
    const inFlight = new InFlight();
    inFlight.begin('alice.testnet');
    expect(inFlight.has('bob.testnet')).toBe(false);
    expect(inFlight.begin('bob.testnet')).toBe(true);
  });

  it('ignores end for a buyer that is not busy', () => {
    const inFlight = new InFlight();
    inFlight.end('alice.testnet');
    expect(inFlight.has('alice.testnet')).toBe(false);
  });

  it('keeps a held buyer in flight after end, so begin is refused', () => {
    const inFlight = new InFlight();
    inFlight.begin('alice.testnet');
    inFlight.hold('alice.testnet', 1_100n);
    inFlight.end('alice.testnet');
    expect(inFlight.held('alice.testnet')).toBe(true);
    expect(inFlight.has('alice.testnet')).toBe(true);
    expect(inFlight.begin('alice.testnet')).toBe(false);
  });

  it('lifts a hold once a final height above its maxBlockHeight is passed, not at it', () => {
    const inFlight = new InFlight();
    inFlight.hold('alice.testnet', 1_100n);
    inFlight.passed(1_100n);
    expect(inFlight.held('alice.testnet')).toBe(true);
    inFlight.passed(1_101n);
    expect(inFlight.held('alice.testnet')).toBe(false);
    expect(inFlight.begin('alice.testnet')).toBe(true);
  });

  it('lifts every passed hold at once, so holds do not accumulate', () => {
    const inFlight = new InFlight();
    inFlight.hold('alice.testnet', 1_100n);
    inFlight.hold('bob.testnet', 1_300n);
    inFlight.hold('carol.testnet', 1_200n);
    inFlight.passed(1_250n);
    const held = ['alice.testnet', 'bob.testnet', 'carol.testnet'].map((buyer) => inFlight.held(buyer));
    expect(held).toEqual([false, true, false]);
  });

  it('does not block other buyers while one is held', () => {
    const inFlight = new InFlight();
    inFlight.hold('alice.testnet', 1_100n);
    expect(inFlight.has('bob.testnet')).toBe(false);
    expect(inFlight.begin('bob.testnet')).toBe(true);
  });
});

describe('NonceCache', () => {
  const TTL = 300_000;

  it('reports a key as unseen the first time', () => {
    const cache = new NonceCache(TTL);
    expect(cache.seen('alice.testnet:n1', 1_000)).toBe(false);
  });

  it('reports a key as seen when it comes back within the TTL', () => {
    const cache = new NonceCache(TTL);
    cache.seen('alice.testnet:n1', 1_000);
    expect(cache.seen('alice.testnet:n1', 1_000 + TTL - 1)).toBe(true);
  });

  it('forgets a key at exactly the TTL', () => {
    const cache = new NonceCache(TTL);
    cache.seen('alice.testnet:n1', 1_000);
    expect(cache.seen('alice.testnet:n1', 1_000 + TTL)).toBe(false);
  });

  it('records an expired key again from the new time', () => {
    const cache = new NonceCache(TTL);
    cache.seen('alice.testnet:n1', 0);
    cache.seen('alice.testnet:n1', TTL);
    expect(cache.seen('alice.testnet:n1', 2 * TTL - 1)).toBe(true);
  });

  it('tracks each key separately', () => {
    const cache = new NonceCache(TTL);
    cache.seen('alice.testnet:n1', 1_000);
    expect(cache.seen('alice.testnet:n2', 1_000)).toBe(false);
    expect(cache.seen('bob.testnet:n1', 1_000)).toBe(false);
  });

  it('drops every expired entry on each call, so the cache does not grow', () => {
    const cache = new NonceCache(TTL);
    cache.seen('a', 0);
    cache.seen('b', 1);
    cache.seen('c', 2);
    const deleted = vi.spyOn(Map.prototype, 'delete');
    try {
      cache.seen('d', TTL + 1);
      expect(deleted.mock.calls.map(([key]) => key)).toEqual(['a', 'b']);
    } finally {
      deleted.mockRestore();
    }
  });
});
```

`apps/gateway/test/pools.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { MAX_PAGE, type PoolStatus } from '@quorum-on-near/protocol';
import { listServedPools, openPoolListings, servedPool } from '../src/pools.ts';
import { FakeChain, PROVIDER, TERMS, poolView } from './fake-chain.ts';

const OTHER_SELLER = 'other-seller.testnet';

function chainWithPools(count: number, seller: (id: number) => string = () => PROVIDER): FakeChain {
  const chain = new FakeChain();
  for (let id = 0; id < count; id++) chain.setPool(poolView({ id, seller: seller(id) }));
  return chain;
}

describe('listServedPools', () => {
  it('pages through more than one page of pools, in id order', async () => {
    const chain = chainWithPools(2 * MAX_PAGE + 50);
    const pools = await listServedPools(chain, PROVIDER);
    expect(pools.map((p) => p.id)).toEqual([...Array(2 * MAX_PAGE + 50).keys()]);
    expect(chain.reads.get('list_pools')).toBe(3);
  });

  it('asks for another page after a full one', async () => {
    const chain = chainWithPools(MAX_PAGE);
    const pools = await listServedPools(chain, PROVIDER);
    expect(pools).toHaveLength(MAX_PAGE);
    expect(chain.reads.get('list_pools')).toBe(2);
  });

  it('returns nothing when the contract has no pools', async () => {
    const chain = new FakeChain();
    expect(await listServedPools(chain, PROVIDER)).toEqual([]);
    expect(chain.reads.get('list_pools')).toBe(1);
  });

  it("keeps only the provider's pools", async () => {
    const chain = chainWithPools(MAX_PAGE + 20, (id) => (id % 3 === 0 ? PROVIDER : OTHER_SELLER));
    const pools = await listServedPools(chain, PROVIDER);
    expect(pools.map((p) => p.id)).toEqual([...Array(MAX_PAGE + 20).keys()].filter((id) => id % 3 === 0));
    expect(pools.every((p) => p.seller === PROVIDER)).toBe(true);
  });
});

describe('openPoolListings', () => {
  it('lists only served pools that are open with seats left', async () => {
    const chain = new FakeChain();
    const statuses: PoolStatus[] = ['open', 'filled', 'settled', 'expired', 'refunded'];
    statuses.forEach((status, id) => chain.setPool(poolView({ id, status })));
    chain.setPool(poolView({ id: 5, status: 'open', taken: 192, target: 192 }));
    chain.setPool(poolView({ id: 6, status: 'open', seller: OTHER_SELLER }));
    chain.setPool(poolView({ id: 7, status: 'open', taken: 0 }));
    const listings = await openPoolListings(chain, PROVIDER);
    expect(listings.map((l) => l.id)).toEqual([0, 7]);
  });

  it("gives each pool's public terms and the least bonus a seat receives if the pool fails", async () => {
    const chain = new FakeChain();
    chain.setPool(poolView({ id: 7, bonus: '1728', target: 192, taken: 148 }));
    expect(await openPoolListings(chain, PROVIDER)).toEqual([
      {
        id: 7,
        terms: TERMS,
        seat_price: '180',
        target: 192,
        taken: 148,
        deadline_ms: 1_800_000_000_000,
        bonus: '1728',
        // floor(1728 / (192 - 1))
        min_bonus_per_seat: '9',
      },
    ]);
  });
});

describe('servedPool', () => {
  it('returns a pool that the provider sells', async () => {
    const chain = new FakeChain();
    const pool = poolView({ id: 7 });
    chain.setPool(pool);
    expect(await servedPool(chain, PROVIDER, 7)).toEqual(pool);
  });

  it("returns null for another seller's pool", async () => {
    const chain = new FakeChain();
    chain.setPool(poolView({ id: 7, seller: OTHER_SELLER }));
    expect(await servedPool(chain, PROVIDER, 7)).toBeNull();
  });

  it('returns null for a pool that does not exist', async () => {
    const chain = new FakeChain();
    expect(await servedPool(chain, PROVIDER, 7)).toBeNull();
  });
});
```

`apps/gateway/test/activity.test.ts`:

```typescript
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { PoolView, QuorumEvent } from '@quorum-on-near/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ActivityLog, keeperCallProgressed, keeperRecords, type ActivityRecord } from '../src/activity.ts';
import { NOW_MS, POOLS, PROVIDER, TOKEN, eventLog, outcome, poolView, type ReceiptSpec } from './fake-chain.ts';

const ALICE = 'alice.testnet';
const BOB = 'bob.testnet';
const CAROL = 'carol.testnet';

function record(overrides: Partial<ActivityRecord> = {}): ActivityRecord {
  return {
    at: NOW_MS,
    poolId: 7,
    kind: 'commit',
    account: ALICE,
    seats: 2,
    amount: '360',
    txHash: 'Tx1',
    ok: true,
    ...overrides,
  };
}

describe('ActivityLog', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'quorum-activity-'));
    file = join(dir, 'feed', 'activity.jsonl');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('creates the folder of its file when it does not exist', async () => {
    await ActivityLog.open(file);
    expect((await stat(join(dir, 'feed'))).isDirectory()).toBe(true);
  });

  it('starts empty when its file does not exist', async () => {
    const log = await ActivityLog.open(file);
    expect(log.list()).toEqual([]);
  });

  it('appends each record to its file as one JSON line', async () => {
    const log = await ActivityLog.open(file);
    const first = record({ txHash: 'Tx1' });
    const second = record({ txHash: 'Tx2', kind: 'settle', account: PROVIDER });
    await log.append(first);
    await log.append(second);
    expect(await readFile(file, 'utf8')).toBe(`${JSON.stringify(first)}\n${JSON.stringify(second)}\n`);
  });

  it('reloads the appended records when the file is opened again', async () => {
    const log = await ActivityLog.open(file);
    const records = [record({ txHash: 'Tx1' }), record({ txHash: 'Tx2', poolId: 8, ok: false })];
    for (const r of records) await log.append(r);
    const reopened = await ActivityLog.open(file);
    expect(reopened.list()).toEqual(records);
  });

  it('appends after the records it loaded', async () => {
    const first = record({ txHash: 'Tx1' });
    const second = record({ txHash: 'Tx2' });
    await (await ActivityLog.open(file)).append(first);
    const reopened = await ActivityLog.open(file);
    await reopened.append(second);
    expect(reopened.list()).toEqual([first, second]);
    expect((await ActivityLog.open(file)).list()).toEqual([first, second]);
  });

  it('skips lines that are not activity records when loading', async () => {
    const good = [record({ txHash: 'Tx1' }), record({ txHash: 'Tx2' })];
    const lines = [
      JSON.stringify(good[0]),
      'not json',
      '',
      '42',
      JSON.stringify({ ...record(), kind: 'mint' }),
      JSON.stringify({ ...record(), amount: 360 }),
      JSON.stringify({ ...record(), txHash: undefined }),
      JSON.stringify(good[1]),
      '{"at":1799999000000,"poolId":7,"ki',
    ];
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, lines.join('\n'));
    const log = await ActivityLog.open(file);
    expect(log.list()).toEqual(good);
  });

  it('keeps a record appended after a line cut short when the process stopped mid-write', async () => {
    const kept = record({ txHash: 'Tx1' });
    const appended = record({ kind: 'refund', txHash: 'Tx3' });
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(kept)}\n{"at":1799999000000,"poolId":7,"ki`);
    await (await ActivityLog.open(file)).append(appended);
    const reopened = await ActivityLog.open(file);
    expect(reopened.list()).toEqual([kept, appended]);
    expect(reopened.lastRefund(7, ALICE)?.txHash).toBe('Tx3');
  });

  it('adds nothing to a file that already ends with a newline', async () => {
    const line = `${JSON.stringify(record())}\n`;
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, line);
    await ActivityLog.open(file);
    expect(await readFile(file, 'utf8')).toBe(line);
  });

  it('lists every record, oldest first', async () => {
    const log = await ActivityLog.open(file);
    const records = [record({ txHash: 'Tx1', poolId: 7 }), record({ txHash: 'Tx2', poolId: 8 }), record({ txHash: 'Tx3', poolId: 7 })];
    for (const r of records) await log.append(r);
    expect(log.list()).toEqual(records);
  });

  it("lists only one pool's records, in order, when given a pool id", async () => {
    const log = await ActivityLog.open(file);
    const records = [record({ txHash: 'Tx1', poolId: 7 }), record({ txHash: 'Tx2', poolId: 8 }), record({ txHash: 'Tx3', poolId: 7 })];
    for (const r of records) await log.append(r);
    expect(log.list(7).map((r) => r.txHash)).toEqual(['Tx1', 'Tx3']);
    expect(log.list(9)).toEqual([]);
  });

  it('finds the latest successful refund for that buyer in that pool', async () => {
    const log = await ActivityLog.open(file);
    const records = [
      record({ kind: 'refund', txHash: 'Tx1' }),
      record({ kind: 'refund', txHash: 'Tx2' }),
      record({ kind: 'refund', txHash: 'Tx3', ok: false, seats: 0 }),
      record({ kind: 'refund', txHash: 'Tx4', poolId: 8 }),
      record({ kind: 'refund', txHash: 'Tx5', account: BOB }),
      record({ kind: 'commit', txHash: 'Tx6' }),
    ];
    for (const r of records) await log.append(r);
    expect(log.lastRefund(7, ALICE)?.txHash).toBe('Tx2');
  });

  it('finds no refund for a buyer that has no successful refund in that pool', async () => {
    const log = await ActivityLog.open(file);
    await log.append(record({ kind: 'commit', txHash: 'Tx1' }));
    await log.append(record({ kind: 'refund', txHash: 'Tx2', ok: false, seats: 0 }));
    expect(log.lastRefund(7, ALICE)).toBeUndefined();
  });
});

describe('keeperRecords', () => {
  const AT = NOW_MS;

  it('gives one settle record, for the seller and every seat taken, from pool_settled', () => {
    const pool = poolView({ status: 'filled', taken: 192 });
    const tx = outcome('SettleTx', [
      { executorId: POOLS },
      { executorId: TOKEN },
      { executorId: POOLS, events: [{ event: 'pool_settled', data: { pool_id: 7, seller: PROVIDER, amount: '36288' } }] },
    ]);
    expect(keeperRecords('settle', pool, tx, POOLS, AT)).toEqual([
      { at: AT, poolId: 7, kind: 'settle', account: PROVIDER, seats: 192, amount: '36288', txHash: 'SettleTx', ok: true },
    ]);
  });

  it('gives a refund record per seat_refunded and refund_failed, and a dust record for pool_refunded', () => {
    // bonus 1728 over 5 seats: 345 a seat, dust 3
    const pool = poolView({ status: 'expired', taken: 5, bonus_per_seat: '345' });
    const tx = outcome('RefundTx', [
      { executorId: POOLS },
      { executorId: TOKEN },
      { executorId: TOKEN },
      { executorId: TOKEN, failed: true },
      { executorId: TOKEN },
      {
        executorId: POOLS,
        events: [{ event: 'seat_refunded', data: { pool_id: 7, buyer: ALICE, seats: 2, amount: '1050', bonus_share: '690' } }],
      },
      {
        executorId: POOLS,
        events: [{ event: 'seat_refunded', data: { pool_id: 7, buyer: BOB, seats: 1, amount: '525', bonus_share: '345' } }],
      },
      { executorId: POOLS, events: [{ event: 'refund_failed', data: { pool_id: 7, buyer: CAROL, amount: '1050' } }] },
      { executorId: POOLS, events: [{ event: 'pool_refunded', data: { pool_id: 7, dust: '3' } }] },
    ]);
    expect(keeperRecords('refund', pool, tx, POOLS, AT)).toEqual([
      { at: AT, poolId: 7, kind: 'refund', account: ALICE, seats: 2, amount: '1050', txHash: 'RefundTx', ok: true },
      { at: AT, poolId: 7, kind: 'refund', account: BOB, seats: 1, amount: '525', txHash: 'RefundTx', ok: true },
      { at: AT, poolId: 7, kind: 'refund', account: CAROL, seats: 0, amount: '1050', txHash: 'RefundTx', ok: false },
      { at: AT, poolId: 7, kind: 'dust', account: PROVIDER, seats: 0, amount: '3', txHash: 'RefundTx', ok: true },
    ]);
  });

  it('gives a dust record for a pool_refunded that the refund call itself emitted', () => {
    // bonus 1728 over 4 seats: 432 a seat, no dust
    const pool = poolView({ status: 'expired', taken: 4, bonus: '1728', bonus_per_seat: '432' });
    const tx = outcome('LastBatchTx', [
      { executorId: POOLS, events: [{ event: 'pool_refunded', data: { pool_id: 7, dust: '0' } }] },
      { executorId: TOKEN },
      {
        executorId: POOLS,
        events: [{ event: 'seat_refunded', data: { pool_id: 7, buyer: ALICE, seats: 4, amount: '2448', bonus_share: '1728' } }],
      },
    ]);
    expect(keeperRecords('refund', pool, tx, POOLS, AT)).toEqual([
      { at: AT, poolId: 7, kind: 'dust', account: PROVIDER, seats: 0, amount: '0', txHash: 'LastBatchTx', ok: true },
      { at: AT, poolId: 7, kind: 'refund', account: ALICE, seats: 4, amount: '2448', txHash: 'LastBatchTx', ok: true },
    ]);
  });

  it.each(['settle', 'refund'] as const)('gives one failed %s record for a call that produced no events', (kind) => {
    const pool = poolView({ status: kind === 'settle' ? 'filled' : 'expired' });
    const tx = outcome('FailedTx', [{ executorId: POOLS, failed: true }]);
    expect(keeperRecords(kind, pool, tx, POOLS, AT)).toEqual([
      { at: AT, poolId: 7, kind, account: PROVIDER, seats: 0, amount: '0', txHash: 'FailedTx', ok: false },
    ]);
  });

  it('gives no record for a refund batch that only passed buyers who had claimed their own refunds', () => {
    const pool = poolView({ status: 'expired', buyer_count: 10, refund_cursor: 0 });
    const tx = outcome('SkippedTx', [{ executorId: POOLS }]);
    expect(keeperRecords('refund', pool, tx, POOLS, AT)).toEqual([]);
  });

  it('gives one failed refund record for a call that only retried the dust, whose transfer failed', () => {
    const pool = poolView({ status: 'expired', buyer_count: 10, refund_cursor: 10, dust_sent: false });
    const tx = outcome('DustTx', [{ executorId: POOLS }, { executorId: TOKEN, failed: true }, { executorId: POOLS }]);
    expect(keeperRecords('refund', pool, tx, POOLS, AT)).toEqual([
      { at: AT, poolId: 7, kind: 'refund', account: PROVIDER, seats: 0, amount: '0', txHash: 'DustTx', ok: false },
    ]);
  });

  it('ignores events logged by an account other than the pools contract', () => {
    const pool = poolView({ status: 'expired', taken: 3, bonus_per_seat: '576' });
    const tx = outcome('RefundTx', [
      { executorId: POOLS },
      {
        executorId: 'mimic.testnet',
        logs: [
          eventLog({ event: 'seat_refunded', data: { pool_id: 7, buyer: BOB, seats: 9, amount: '5508', bonus_share: '3888' } }),
          eventLog({ event: 'pool_refunded', data: { pool_id: 7, dust: '1' } }),
        ],
      },
      {
        executorId: POOLS,
        events: [{ event: 'seat_refunded', data: { pool_id: 7, buyer: ALICE, seats: 3, amount: '2268', bonus_share: '1728' } }],
      },
    ]);
    expect(keeperRecords('refund', pool, tx, POOLS, AT)).toEqual([
      { at: AT, poolId: 7, kind: 'refund', account: ALICE, seats: 3, amount: '2268', txHash: 'RefundTx', ok: true },
    ]);
  });

  it("ignores the pools contract's events about another pool", () => {
    const pool = poolView({ status: 'filled', taken: 192 });
    const tx = outcome('SettleTx', [
      { executorId: POOLS, events: [{ event: 'pool_settled', data: { pool_id: 8, seller: PROVIDER, amount: '100' } }] },
    ]);
    expect(keeperRecords('settle', pool, tx, POOLS, AT)).toEqual([
      { at: AT, poolId: 7, kind: 'settle', account: PROVIDER, seats: 0, amount: '0', txHash: 'SettleTx', ok: false },
    ]);
  });

  it('ignores events that do not belong to the kind of call', () => {
    const pool = poolView({ status: 'filled', taken: 192 });
    const tx = outcome('SettleTx', [
      { executorId: POOLS, events: [{ event: 'pool_refunded', data: { pool_id: 7, dust: '5' } }] },
    ]);
    expect(keeperRecords('settle', pool, tx, POOLS, AT)).toEqual([
      { at: AT, poolId: 7, kind: 'settle', account: PROVIDER, seats: 0, amount: '0', txHash: 'SettleTx', ok: false },
    ]);
  });
});

describe('keeperCallProgressed', () => {
  const FILLED: Partial<PoolView> = { status: 'filled', taken: 192 };
  /** Buyers left to visit: the call advances the cursor. */
  const BUYERS_LEFT: Partial<PoolView> = { status: 'expired', buyer_count: 10, refund_cursor: 3 };
  /** Every buyer visited and the dust not sent: the call only retries the dust. */
  const DUST_ONLY: Partial<PoolView> = { status: 'expired', buyer_count: 10, refund_cursor: 10, dust_sent: false };
  const settledEvent = (poolId: number): QuorumEvent => ({
    event: 'pool_settled',
    data: { pool_id: poolId, seller: PROVIDER, amount: '36288' },
  });
  const refundedEvent = (poolId: number): QuorumEvent => ({ event: 'pool_refunded', data: { pool_id: poolId, dust: '3' } });

  type Case = [string, 'settle' | 'refund', Partial<PoolView>, ReceiptSpec[]];

  it.each<Case>([
    ['a settle call that logged pool_settled', 'settle', FILLED, [{ executorId: POOLS }, { executorId: TOKEN }, { executorId: POOLS, events: [settledEvent(7)] }]],
    ['a refund batch over buyers who had all claimed their own refunds, which logged nothing', 'refund', BUYERS_LEFT, [{ executorId: POOLS }]],
    ['a dust retry that logged pool_refunded', 'refund', DUST_ONLY, [{ executorId: POOLS }, { executorId: TOKEN }, { executorId: POOLS, events: [refundedEvent(7)] }]],
  ])('counts %s as progress', (_label, kind, pool, receipts) => {
    expect(keeperCallProgressed(kind, poolView(pool), outcome('KeeperTx', receipts), POOLS)).toBe(true);
  });

  it.each<Case>([
    ['a settle call whose payout failed', 'settle', FILLED, [{ executorId: POOLS }, { executorId: TOKEN, failed: true }, { executorId: POOLS }]],
    ["a settle call that logged another pool's pool_settled", 'settle', FILLED, [{ executorId: POOLS, events: [settledEvent(8)] }]],
    ['a refund call with buyers left whose receipt failed', 'refund', BUYERS_LEFT, [{ executorId: POOLS, failed: true }]],
    ['a refund call that never reached the pools contract', 'refund', BUYERS_LEFT, []],
    ['a dust retry whose transfer failed', 'refund', DUST_ONLY, [{ executorId: POOLS }, { executorId: TOKEN, failed: true }, { executorId: POOLS }]],
    ["a dust retry that logged another pool's pool_refunded", 'refund', DUST_ONLY, [{ executorId: POOLS, events: [refundedEvent(8)] }]],
  ])('does not count %s as progress', (_label, kind, pool, receipts) => {
    expect(keeperCallProgressed(kind, poolView(pool), outcome('KeeperTx', receipts), POOLS)).toBe(false);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @quorum-on-near/gateway exec vitest run test/guards.test.ts test/pools.test.ts test/activity.test.ts`

Expected: FAIL. vitest cannot load `../src/guards.ts`, `../src/pools.ts` and `../src/activity.ts`, which do not exist yet.

- [ ] **Step 3: Write the implementation**

`apps/gateway/src/guards.ts`:

```typescript
/**
 * Buyers with a payment in flight: at most one each (spec section 6.4). A buyer is busy from `begin`
 * to `end`, and held after `end` while a payment whose result is unknown may still execute.
 */
export class InFlight {
  readonly #busy = new Set<string>();
  /** Held buyers, each with its payment's `maxBlockHeight`. */
  readonly #held = new Map<string, bigint>();

  /** Marks the buyer busy. Returns false, changing nothing, if it already was busy or is held. */
  begin(buyer: string): boolean {
    if (this.#busy.has(buyer) || this.#held.has(buyer)) return false;
    this.#busy.add(buyer);
    return true;
  }

  /** Ends the buyer's busy time. A hold outlasts it. */
  end(buyer: string): void {
    this.#busy.delete(buyer);
  }

  /** Keeps the buyer in flight until `passed` is given a final height above `maxBlockHeight`. */
  hold(buyer: string, maxBlockHeight: bigint): void {
    this.#held.set(buyer, maxBlockHeight);
  }

  held(buyer: string): boolean {
    return this.#held.has(buyer);
  }

  /** Lifts every hold whose `maxBlockHeight` is below `finalHeight`: those payments can no longer execute. */
  passed(finalHeight: bigint): void {
    for (const [buyer, maxBlockHeight] of this.#held) {
      if (finalHeight > maxBlockHeight) this.#held.delete(buyer);
    }
  }

  /** True while the buyer is busy or held. */
  has(buyer: string): boolean {
    return this.#busy.has(buyer) || this.#held.has(buyer);
  }
}

/** Redemption nonces seen in the last `ttlMs`. In memory only, so it restarts empty. */
export class NonceCache {
  readonly #ttlMs: number;
  readonly #seenAt = new Map<string, number>();

  constructor(ttlMs: number) {
    this.#ttlMs = ttlMs;
  }

  /** Returns true if `key` was seen within the TTL; otherwise records it and returns false. */
  seen(key: string, nowMs: number): boolean {
    for (const [k, at] of this.#seenAt) {
      if (nowMs - at >= this.#ttlMs) this.#seenAt.delete(k);
    }
    if (this.#seenAt.has(key)) return true;
    this.#seenAt.set(key, nowMs);
    return false;
  }
}
```

`apps/gateway/src/pools.ts`:

```typescript
import { MAX_PAGE, minBonusPerSeat, type PoolView } from '@quorum-on-near/protocol';
import type { ChainReader } from './chain.ts';

/**
 * Every pool whose seller is `provider`, in id order. Pages `list_pools` by MAX_PAGE until a page
 * comes back shorter than that.
 */
export async function listServedPools(chain: ChainReader, provider: string): Promise<PoolView[]> {
  const served: PoolView[] = [];
  // Pool ids run from 0 with no gaps, so each page starts MAX_PAGE ids after the last.
  for (let from = 0; ; from += MAX_PAGE) {
    const page = await chain.listPools(from, MAX_PAGE);
    served.push(...page.filter((pool) => pool.seller === provider));
    if (page.length < MAX_PAGE) return served;
  }
}

/** A row of `GET /pools` (spec section 6.1). */
export interface PoolListing {
  id: number;
  terms: string;
  seat_price: string;
  target: number;
  taken: number;
  deadline_ms: number;
  bonus: string;
  min_bonus_per_seat: string;
}

/** The served pools that are open with seats left, as `GET /pools` lists them. */
export async function openPoolListings(chain: ChainReader, provider: string): Promise<PoolListing[]> {
  const pools = await listServedPools(chain, provider);
  return pools
    .filter((pool) => pool.status === 'open' && pool.taken < pool.target)
    .map((pool) => ({
      id: pool.id,
      terms: pool.terms,
      seat_price: pool.seat_price,
      target: pool.target,
      taken: pool.taken,
      deadline_ms: pool.deadline_ms,
      bonus: pool.bonus,
      min_bonus_per_seat: minBonusPerSeat(BigInt(pool.bonus), pool.target).toString(),
    }));
}

/** The pool if it exists and `provider` sells it; otherwise null. */
export async function servedPool(chain: ChainReader, provider: string, poolId: number): Promise<PoolView | null> {
  const pool = await chain.getPool(poolId);
  return pool !== null && pool.seller === provider ? pool : null;
}
```

`apps/gateway/src/activity.ts`:

```typescript
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { PoolView, QuorumEvent } from '@quorum-on-near/protocol';
import type { TxOutcome } from './chain.ts';
import { poolsEvents } from './outcome.ts';

export type ActivityKind = 'commit' | 'settle' | 'refund' | 'dust';

/** One line of the activity feed (spec section 6.7). `at` is milliseconds since the epoch. */
export interface ActivityRecord {
  at: number;
  poolId: number;
  kind: ActivityKind;
  account: string;
  seats: number;
  amount: string;
  txHash: string;
  ok: boolean;
}

const KINDS = new Set<string>(['commit', 'settle', 'refund', 'dust']);

function isActivityRecord(value: unknown): value is ActivityRecord {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.at === 'number' &&
    Number.isSafeInteger(r.poolId) &&
    typeof r.kind === 'string' &&
    KINDS.has(r.kind) &&
    typeof r.account === 'string' &&
    Number.isSafeInteger(r.seats) &&
    typeof r.amount === 'string' &&
    typeof r.txHash === 'string' &&
    typeof r.ok === 'boolean'
  );
}

function parseLines(text: string): ActivityRecord[] {
  const records: ActivityRecord[] = [];
  for (const line of text.split('\n')) {
    try {
      const value: unknown = JSON.parse(line);
      if (isActivityRecord(value)) records.push(value);
    } catch {
      // A blank line, or a line cut short when the process stopped mid-write.
    }
  }
  return records;
}

async function readIfExists(file: string): Promise<string> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

/** The activity feed: kept in memory and appended to a JSON-lines file. */
export class ActivityLog {
  readonly #file: string;
  readonly #records: ActivityRecord[];

  private constructor(file: string, records: ActivityRecord[]) {
    this.#file = file;
    this.#records = records;
  }

  /**
   * Loads `file` if it exists (skipping lines that do not parse) and creates its folder if needed. A
   * file that does not end with a newline (the process stopped mid-write) gets one, so that the next
   * record starts on a line of its own.
   */
  static async open(file: string): Promise<ActivityLog> {
    await mkdir(dirname(file), { recursive: true });
    const text = await readIfExists(file);
    if (text !== '' && !text.endsWith('\n')) await appendFile(file, '\n');
    return new ActivityLog(file, parseLines(text));
  }

  async append(record: ActivityRecord): Promise<void> {
    await appendFile(this.#file, `${JSON.stringify(record)}\n`);
    this.#records.push(record);
  }

  /** Every record, or only one pool's, oldest first. */
  list(poolId?: number): ActivityRecord[] {
    return poolId === undefined ? [...this.#records] : this.#records.filter((r) => r.poolId === poolId);
  }

  /** The latest successful refund record for this buyer in this pool, if any. */
  lastRefund(poolId: number, account: string): ActivityRecord | undefined {
    return this.#records.findLast((r) => r.kind === 'refund' && r.ok && r.poolId === poolId && r.account === account);
  }
}

/**
 * Whether a keeper call moved its pool on. `pool` is the view read before the call.
 * - `settle`: the pools contract logged `pool_settled` for the pool.
 * - `refund`: the call's receipt at the pools contract did not fail, and either the pool had buyers
 *   left to visit (`refund_cursor < buyer_count`), so the call advanced the cursor, even past buyers
 *   that had claimed on their own and so logged nothing; or the pools contract logged
 *   `pool_refunded` for the pool (the dust arrived, or was 0). A call that only retried the dust, and
 *   whose transfer failed, moved nothing.
 */
export function keeperCallProgressed(
  kind: 'settle' | 'refund',
  pool: PoolView,
  outcome: TxOutcome,
  poolsContract: string,
): boolean {
  const logged = (event: QuorumEvent['event']): boolean =>
    poolsEvents(outcome, poolsContract).some((e) => e.event === event && e.data.pool_id === pool.id);
  if (kind === 'settle') return logged('pool_settled');
  const call = outcome.receipts.find((receipt) => receipt.executorId === poolsContract);
  if (call === undefined || call.failed) return false;
  return pool.refund_cursor < pool.buyer_count || logged('pool_refunded');
}

/**
 * The records a keeper call produced, from the pools contract's events:
 * - `settle`: `pool_settled` gives one `settle` record (account = seller, seats = pool.taken).
 * - `refund`: each `seat_refunded` gives a `refund` record (ok), each `refund_failed` a `refund` record
 *   (not ok, seats 0), and `pool_refunded` a `dust` record (account = seller, seats 0).
 * A call that produced none of these gives one record of `kind` with `ok: false`, `amount: "0"`,
 * unless it moved its pool on (keeperCallProgressed), as a refund batch that only passed buyers who
 * had claimed on their own does: that gives no record.
 */
export function keeperRecords(
  kind: 'settle' | 'refund',
  pool: PoolView,
  outcome: TxOutcome,
  poolsContract: string,
  at: number,
): ActivityRecord[] {
  const record = (recordKind: ActivityKind, account: string, seats: number, amount: string, ok: boolean): ActivityRecord => ({
    at,
    poolId: pool.id,
    kind: recordKind,
    account,
    seats,
    amount,
    txHash: outcome.txHash,
    ok,
  });
  const records: ActivityRecord[] = [];
  for (const e of poolsEvents(outcome, poolsContract)) {
    if (e.data.pool_id !== pool.id) continue;
    if (kind === 'settle' && e.event === 'pool_settled') {
      records.push(record('settle', e.data.seller, pool.taken, e.data.amount, true));
    } else if (kind === 'refund' && e.event === 'seat_refunded') {
      records.push(record('refund', e.data.buyer, e.data.seats, e.data.amount, true));
    } else if (kind === 'refund' && e.event === 'refund_failed') {
      records.push(record('refund', e.data.buyer, 0, e.data.amount, false));
    } else if (kind === 'refund' && e.event === 'pool_refunded') {
      records.push(record('dust', pool.seller, 0, e.data.dust, true));
    }
  }
  if (records.length > 0 || keeperCallProgressed(kind, pool, outcome, poolsContract)) return records;
  return [record(kind, pool.seller, 0, '0', false)];
}
```

- [ ] **Step 4: Run the tests and the typecheck**

Run: `pnpm --filter @quorum-on-near/gateway exec vitest run test/guards.test.ts test/pools.test.ts test/activity.test.ts`

Expected: PASS, 55 tests (`test/guards.test.ts` 15, `test/pools.test.ts` 9, `test/activity.test.ts` 31).

Run: `pnpm --filter @quorum-on-near/gateway typecheck`

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/guards.ts apps/gateway/src/pools.ts apps/gateway/src/activity.ts \
  apps/gateway/test/guards.test.ts apps/gateway/test/pools.test.ts apps/gateway/test/activity.test.ts
git commit -m "keep the activity feed, the in-flight guard and the served pools"
```


---

### Task 10: The offer endpoint

The handlers return a framework-free `Reply`, and take every dependency through `Deps`, so tests call them directly. With no payment or proof header, `GET /pools/:id/access?seats=N` answers 402 with the offer; 409 for a pool that is filled or has no seat left; 410 for one that has expired.

**Files:**
- Create: `apps/gateway/src/reply.ts`, `apps/gateway/src/deps.ts`, `apps/gateway/src/handle-offer.ts`, `apps/gateway/test/handler-deps.ts`
- Test: `apps/gateway/test/handle-offer.test.ts`

**Interfaces:**
- Consumes: `GatewayConfig` (Task 6), `CredentialIssuer` (Task 6), `ChainReader`, `ChainWriter` (Task 7), `ActivityLog`, `InFlight`, `NonceCache`, `servedPool` (Task 9); `buildOffer`, `offerSeats`, `paymentRequired`, `REDEEM_MAX_AGE_MS`, `REDEEM_MAX_SKEW_MS` from the protocol package.
- Produces: `interface Reply {status, body, headers?}`, `reply(status, body, headers?)`; `interface Deps {config, chain, writer, credentials, activity, inFlight, proofNonces, now}`; `MAX_SEATS_PER_REQUEST`, `parseSeats(param): number | null`, `offerContext(config): OfferContext`, `currentAccepts(pool, seats, config, held = 0): Offer[]`, `handleOffer(deps, poolId, seatsParam): Promise<Reply>`; test support `testDeps(overrides?)`, which builds `Deps` over a `FakeChain` with a real activity log and credential issuer, and a nonce cache that lives `REDEEM_MAX_AGE_MS + REDEEM_MAX_SKEW_MS`.

- [ ] **Step 1: Write the reply type, the dependencies and the test dependencies**

`apps/gateway/src/reply.ts`:

```typescript
/** A handler's answer, independent of the HTTP framework. */
export interface Reply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export function reply(status: number, body: unknown, headers?: Record<string, string>): Reply {
  return headers ? { status, body, headers } : { status, body };
}
```

`apps/gateway/src/deps.ts`:

```typescript
import type { ActivityLog } from './activity.ts';
import type { ChainReader, ChainWriter } from './chain.ts';
import type { GatewayConfig } from './config.ts';
import type { CredentialIssuer } from './credential.ts';
import type { InFlight, NonceCache } from './guards.ts';

/** Everything the request handlers need. Tests pass fakes. */
export interface Deps {
  config: GatewayConfig;
  chain: ChainReader;
  writer: ChainWriter;
  credentials: CredentialIssuer;
  activity: ActivityLog;
  inFlight: InFlight;
  proofNonces: NonceCache;
  now: () => number;
}
```

`apps/gateway/test/handler-deps.ts`:

```typescript
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REDEEM_MAX_AGE_MS, REDEEM_MAX_SKEW_MS } from '@quorum-on-near/protocol';
import { ActivityLog } from '../src/activity.ts';
import { createCredentialIssuer, generateCredentialJwk } from '../src/credential.ts';
import type { Deps } from '../src/deps.ts';
import { InFlight, NonceCache } from '../src/guards.ts';
import { FakeChain, NOW_MS, testConfig } from './fake-chain.ts';

/** Handler dependencies over a FakeChain, with a real activity log in a temporary folder. */
export async function testDeps(overrides: Partial<Deps> = {}): Promise<Deps & { fake: FakeChain }> {
  const fake = new FakeChain();
  const config = overrides.config ?? testConfig();
  const dir = await mkdtemp(join(tmpdir(), 'quorum-gateway-'));
  const deps: Deps = {
    config,
    chain: fake,
    writer: fake,
    credentials: await createCredentialIssuer({ jwk: await generateCredentialJwk(), issuer: config.publicUrl }),
    activity: await ActivityLog.open(join(dir, 'activity.jsonl')),
    inFlight: new InFlight(),
    proofNonces: new NonceCache(REDEEM_MAX_AGE_MS + REDEEM_MAX_SKEW_MS),
    now: () => NOW_MS,
    ...overrides,
  };
  return { ...deps, fake };
}
```

- [ ] **Step 2: Write the failing test**

`apps/gateway/test/handle-offer.test.ts`:

```typescript
import { buildOffer, type PoolStatus } from '@quorum-on-near/protocol';
import { describe, expect, it, vi } from 'vitest';
import { currentAccepts, handleOffer, offerContext, parseSeats } from '../src/handle-offer.ts';
import { POOLS, PROVIDER, RELAYER, TERMS, TOKEN, poolView, testConfig } from './fake-chain.ts';
import { testDeps } from './handler-deps.ts';

const CLOSED: PoolStatus[] = ['filled', 'settled', 'expired', 'refunded'];

describe('parseSeats', () => {
  it('reads an absent parameter as one seat', () => {
    expect(parseSeats(undefined)).toBe(1);
  });

  it.each([
    ['1', 1],
    ['24', 24],
    ['1000', 1000],
  ])('reads %j as %i seats', (param, seats) => {
    expect(parseSeats(param)).toBe(seats);
  });

  it.each(['', '0', '01', '-1', '+1', '1.5', '1e3', ' 2', '2 ', '0x10', 'two', '1001', '9'.repeat(400)])(
    'refuses %j',
    (param) => {
      expect(parseSeats(param)).toBeNull();
    },
  );
});

describe('offerContext', () => {
  it("takes the network, URLs, accounts, gas bounds and timeout from the gateway's configuration", () => {
    const config = testConfig({ publicUrl: 'https://gateway.example', maxTimeoutSeconds: 90 });
    expect(offerContext(config)).toEqual({
      network: 'near:testnet',
      gatewayUrl: 'https://gateway.example',
      poolsContract: POOLS,
      token: TOKEN,
      relayer: RELAYER,
      minGas: 50_000_000_000_000n,
      maxGas: 100_000_000_000_000n,
      maxTimeoutSeconds: 90,
    });
  });
});

describe('currentAccepts', () => {
  const config = testConfig();
  const ctx = offerContext(config);

  it('offers the seats asked for when the pool has them', () => {
    const pool = poolView();
    expect(currentAccepts(pool, 2, config)).toEqual([buildOffer(pool, 2, ctx)]);
  });

  it('offers only the seats left', () => {
    const pool = poolView({ taken: 190 });
    expect(currentAccepts(pool, 5, config)).toEqual([buildOffer(pool, 2, ctx)]);
  });

  it("offers no more than the pool's limit per buyer", () => {
    const pool = poolView({ taken: 0, max_seats_per_buyer: 24 });
    expect(currentAccepts(pool, 30, config)).toEqual([buildOffer(pool, 24, ctx)]);
  });

  it.each(CLOSED)('offers nothing for a pool that is %s', (status) => {
    expect(currentAccepts(poolView({ status }), 2, config)).toEqual([]);
  });

  it('offers nothing for an open pool with no seat left', () => {
    expect(currentAccepts(poolView({ taken: 192 }), 2, config)).toEqual([]);
  });

  it("offers a buyer no more than the pool's limit less the seats it holds", () => {
    const pool = poolView({ max_seats_per_buyer: 24 });
    expect(currentAccepts(pool, 10, config, 20)).toEqual([buildOffer(pool, 4, ctx)]);
  });

  it.each([24, 30])('offers nothing to a buyer holding %i seats of a 24-seat limit', (held) => {
    expect(currentAccepts(poolView({ max_seats_per_buyer: 24 }), 2, config, held)).toEqual([]);
  });

  it('ignores the seats held when the pool has no limit per buyer', () => {
    const pool = poolView({ max_seats_per_buyer: null });
    expect(currentAccepts(pool, 5, config, 500)).toEqual([buildOffer(pool, 5, ctx)]);
  });
});

describe('handleOffer', () => {
  it("answers 402 with spec section 6.2's offer for two seats of pool 7", async () => {
    const deps = await testDeps();
    deps.fake.setPool(poolView());
    expect(await handleOffer(deps, 7, '2')).toEqual({
      status: 402,
      body: {
        x402Version: 1,
        error: 'payment required',
        accepts: [
          {
            scheme: 'quorum',
            network: 'near:testnet',
            maxAmountRequired: '360',
            resource: 'http://localhost:8402/pools/7/access?seats=2',
            description: `2 seats in pool 7: ${TERMS}`,
            mimeType: 'application/json',
            payTo: POOLS,
            maxTimeoutSeconds: 120,
            asset: TOKEN,
            extra: {
              poolId: 7,
              seats: 2,
              seatPrice: '180',
              target: 192,
              taken: 148,
              deadlineMs: 1_800_000_000_000,
              bonus: '1728',
              minBonusPerSeat: '9',
              terms: TERMS,
              relayer: RELAYER,
              minGas: '50000000000000',
              maxGas: '100000000000000',
            },
          },
        ],
      },
    });
  });

  it('offers one seat when the request does not say how many', async () => {
    const deps = await testDeps();
    const pool = poolView();
    deps.fake.setPool(pool);
    expect(await handleOffer(deps, 7, undefined)).toEqual({
      status: 402,
      body: { x402Version: 1, error: 'payment required', accepts: [buildOffer(pool, 1, offerContext(deps.config))] },
    });
  });

  it('offers only the seats left when fewer are left than asked for', async () => {
    const deps = await testDeps();
    deps.fake.setPool(poolView({ taken: 190 }));
    const result = await handleOffer(deps, 7, '5');
    expect(result.status).toBe(402);
    expect(result.body).toMatchObject({
      accepts: [{ maxAmountRequired: '360', resource: 'http://localhost:8402/pools/7/access?seats=2', extra: { seats: 2 } }],
    });
  });

  it("offers no more than the pool's limit per buyer", async () => {
    const deps = await testDeps();
    deps.fake.setPool(poolView({ taken: 0, max_seats_per_buyer: 24 }));
    const result = await handleOffer(deps, 7, '30');
    expect(result.status).toBe(402);
    expect(result.body).toMatchObject({ accepts: [{ maxAmountRequired: '4320', extra: { seats: 24 } }] });
  });

  it('answers 400 invalid_seats for an invalid seats parameter, without reading the chain', async () => {
    const deps = await testDeps();
    deps.fake.setPool(poolView());
    expect(await handleOffer(deps, 7, '0')).toEqual({ status: 400, body: { error: 'invalid_seats' } });
    expect(deps.fake.reads.size).toBe(0);
  });

  it('answers 404 unknown_pool for a pool that does not exist', async () => {
    const deps = await testDeps();
    deps.fake.setPool(poolView({ id: 7 }));
    expect(await handleOffer(deps, 8, '2')).toEqual({ status: 404, body: { error: 'unknown_pool' } });
  });

  it("answers 404 unknown_pool for another seller's pool", async () => {
    const deps = await testDeps();
    deps.fake.setPool(poolView({ seller: `other.${PROVIDER}` }));
    expect(await handleOffer(deps, 7, '2')).toEqual({ status: 404, body: { error: 'unknown_pool' } });
  });

  it.each(['filled', 'settled'] as const)(
    'answers 409 pool_closed with the status for a pool that is %s',
    async (status) => {
      const deps = await testDeps();
      deps.fake.setPool(poolView({ status, taken: 192 }));
      expect(await handleOffer(deps, 7, '2')).toEqual({ status: 409, body: { error: 'pool_closed', status } });
    },
  );

  it('answers 409 pool_closed for an open pool with no seat left', async () => {
    const deps = await testDeps();
    deps.fake.setPool(poolView({ taken: 192 }));
    expect(await handleOffer(deps, 7, '2')).toEqual({ status: 409, body: { error: 'pool_closed', status: 'open' } });
  });

  it.each(['expired', 'refunded'] as const)(
    'answers 410 pool_expired with the status for a pool that is %s',
    async (status) => {
      const deps = await testDeps();
      deps.fake.setPool(poolView({ status }));
      expect(await handleOffer(deps, 7, '2')).toEqual({ status: 410, body: { error: 'pool_expired', status } });
    },
  );

  it('answers 503 chain_unavailable when the pool cannot be read', async () => {
    const deps = await testDeps();
    vi.spyOn(deps.fake, 'getPool').mockRejectedValue(new Error('connect ECONNREFUSED'));
    expect(await handleOffer(deps, 7, '2')).toEqual({ status: 503, body: { error: 'chain_unavailable' } });
  });
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `pnpm --filter @quorum-on-near/gateway exec vitest run test/handle-offer.test.ts`

Expected: FAIL. vitest cannot load `../src/handle-offer.ts`, which does not exist yet.

- [ ] **Step 4: Write the implementation**

`apps/gateway/src/handle-offer.ts`:

```typescript
import { buildOffer, offerSeats, paymentRequired } from '@quorum-on-near/protocol';
import type { Offer, OfferContext, PoolView } from '@quorum-on-near/protocol';
import type { GatewayConfig } from './config.ts';
import type { Deps } from './deps.ts';
import { servedPool } from './pools.ts';
import { reply, type Reply } from './reply.ts';

/** The most seats one request may ask for: the contract's largest target. */
export const MAX_SEATS_PER_REQUEST = 1000;

const SEATS = /^[1-9][0-9]*$/;

/** The `seats` query parameter: absent means 1; otherwise `^[1-9][0-9]*$` and at most 1000. Null if invalid. */
export function parseSeats(param: string | undefined): number | null {
  if (param === undefined) return 1;
  if (!SEATS.test(param)) return null;
  const seats = Number(param);
  return seats <= MAX_SEATS_PER_REQUEST ? seats : null;
}

/** The OfferContext for this gateway's configuration. */
export function offerContext(config: GatewayConfig): OfferContext {
  return {
    network: config.network,
    gatewayUrl: config.publicUrl,
    poolsContract: config.poolsContract,
    token: config.token,
    relayer: config.relayer,
    minGas: config.minGas,
    maxGas: config.maxGas,
    maxTimeoutSeconds: config.maxTimeoutSeconds,
  };
}

/**
 * The offer to attach to a reply: one offer for the seats that can be offered, or none if the pool
 * is not open or full. A buyer known to hold `held` seats is offered at most
 * `max_seats_per_buyer − held`, and nothing once it is at the limit.
 */
export function currentAccepts(pool: PoolView, seats: number, config: GatewayConfig, held = 0): Offer[] {
  if (pool.status !== 'open') return [];
  const room = pool.max_seats_per_buyer === null ? seats : pool.max_seats_per_buyer - held;
  const offered = Math.min(offerSeats(pool, seats), room);
  return offered > 0 ? [buildOffer(pool, offered, offerContext(config))] : [];
}

/**
 * `GET /pools/:id/access?seats=N` with no payment or proof header: the 402 offer.
 * - 400 `{error: "invalid_seats"}` unless `seats` is valid (parseSeats).
 * - 404 `{error: "unknown_pool"}` if the pool does not exist or is another seller's.
 * - 410 `{error: "pool_expired", status}` if it is expired or refunded.
 * - 409 `{error: "pool_closed", status}` if it is filled, settled, or open with no seat left.
 * - otherwise 402 with paymentRequired(currentAccepts(...)).
 * - 503 `{error: "chain_unavailable"}` if the chain cannot be read.
 */
export async function handleOffer(deps: Deps, poolId: number, seatsParam: string | undefined): Promise<Reply> {
  const seats = parseSeats(seatsParam);
  if (seats === null) return reply(400, { error: 'invalid_seats' });
  let pool: PoolView | null;
  try {
    pool = await servedPool(deps.chain, deps.config.provider, poolId);
  } catch {
    return reply(503, { error: 'chain_unavailable' });
  }
  if (pool === null) return reply(404, { error: 'unknown_pool' });
  if (pool.status === 'expired' || pool.status === 'refunded') {
    return reply(410, { error: 'pool_expired', status: pool.status });
  }
  const accepts = currentAccepts(pool, seats, deps.config);
  if (accepts.length === 0) return reply(409, { error: 'pool_closed', status: pool.status });
  return reply(402, paymentRequired(accepts));
}
```

- [ ] **Step 5: Run the tests and the typecheck**

Run: `pnpm --filter @quorum-on-near/gateway exec vitest run test/handle-offer.test.ts`

Expected: PASS, 43 tests (`test/handle-offer.test.ts` 43).

Run: `pnpm --filter @quorum-on-near/gateway typecheck`

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/gateway/src/reply.ts apps/gateway/src/deps.ts apps/gateway/src/handle-offer.ts \
  apps/gateway/test/handler-deps.ts apps/gateway/test/handle-offer.test.ts
git commit -m "answer offer requests with the 402 offer"
```


---

### Task 11: Payments

The payment flow of spec sections 6.3 and 6.4: the static checks, the in-flight guard, checks 4 to 8 on the chain, the relay, then the response table. Nothing is relayed until every check passes. Two checks go beyond the spec's table, as Task 1 recorded in the spec: a nonce at or above the final height × 10^6 (which the chain refuses without using it up, so the same payment could be relayed again and again) is `nonce_too_large`, and a payment from the seller or over the per-buyer cap is refused before the relayer pays gas for a commit the contract would refuse. Once the relay has returned, nothing is answered 503: the payment may have landed, so an unreadable result is 502 `result_unknown` with the transaction hash, and if the payment may still land, the buyer stays held until a final height above its `max_block_height` is seen. A commit that took no seats is judged by the pool's state and the final block's time, never the gateway's clock: `410` past the deadline, `502 relay_failed` if the pool is still open with a seat left (the contract takes what is left, so something else refused it), otherwise `409` (the pool filled first). A failed write to the activity feed is logged and never changes the reply.

**Files:**
- Create: `apps/gateway/src/handle-payment.ts`
- Test: `apps/gateway/test/handle-payment.test.ts`

**Interfaces:**
- Consumes: `Deps`, `Reply`, `currentAccepts`, `parseSeats` (Task 10); `readCommit` (Task 7); `servedPool` (Task 9); `DelegateExpiredError`, `EXPIRY_MARGIN_BLOCKS` (Task 7); `checkPaymentHeader`, `encodeHeader`, `paymentRequired`, `PAYMENT_RESPONSE_HEADER` from the protocol package.
- Produces: `handlePayment(deps, poolId: number, seatsParam: string | undefined, header: string): Promise<Reply>`.

- [ ] **Step 1: Write the failing test**

`apps/gateway/test/handle-payment.test.ts`:

```typescript
import {
  PAYMENT_RESPONSE_HEADER,
  buildOffer,
  buildPaymentHeader,
  decodeHeader,
  encodeSignedDelegate,
  maxBlockHeightFor,
  type ExpectedOffer,
  type Offer,
  type PaymentPayload,
  type PoolView,
} from '@quorum-on-near/protocol';
import { createLocalJWKSet, jwtVerify } from 'jose';
import { KeyPair } from 'near-api-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DelegateExpiredError, type RelayResult } from '../src/chain.ts';
import type { GatewayConfig } from '../src/config.ts';
import { offerContext } from '../src/handle-offer.ts';
import { EXPIRY_MARGIN_BLOCKS } from '../src/chain.ts';
import { handlePayment } from '../src/handle-payment.ts';
import type { Reply } from '../src/reply.ts';
import {
  NOW_MS,
  POOLS,
  PROVIDER,
  TERMS,
  TOKEN,
  commitOutcome,
  eventLog,
  outcome,
  poolView,
  testConfig,
  type FakeChain,
} from './fake-chain.ts';
import { testDeps } from './handler-deps.ts';

const BUYER = 'buyer.testnet';
const POOL_ID = 7;
const KEY_NONCE = 10n;
const BALANCE = 1_000_000n;
const TX_HASH = 'RelayTx111';
const DEADLINE_MS = 1_800_000_000_000;
/**
 * The buyer's own configuration, the network and contracts it pays on, and its request: 2 seats of
 * pool 7, for at most 1000, more than any payment here (5 seats at 180 is 900).
 */
const BUYER_CONFIG: ExpectedOffer = {
  network: 'near:testnet',
  token: TOKEN,
  poolsContract: POOLS,
  poolId: POOL_ID,
  maxSeats: 2,
  maxAmount: 1_000n,
};

interface PaymentOptions {
  /** The seats the buyer asks for and its offer is made for; 2 by default. */
  seats?: number;
  nonce?: bigint;
  maxBlockHeight?: bigint;
  /** Changes to the pool as the buyer sees it, which its offer is built from. */
  pool?: Partial<PoolView>;
}

/**
 * A buyer with a full-access key (nonce 10) and a balance, and pool 7 on a FakeChain. `header` signs
 * a payment for the pool's offer as it is when called.
 */
async function scenario(opts: { pool?: Partial<PoolView>; buyer?: string; config?: Partial<GatewayConfig> } = {}) {
  const buyer = opts.buyer ?? BUYER;
  const deps = await testDeps({ config: testConfig(opts.config) });
  const { fake, config } = deps;
  fake.setPool(poolView({ id: POOL_ID, ...opts.pool }));
  const keyPair = KeyPair.fromRandom('ed25519');
  const publicKey = keyPair.getPublicKey().toString();
  fake.setKey(buyer, publicKey, { nonce: KEY_NONCE, fullAccess: true });
  fake.balances.set(buyer, BALANCE);

  const header = (p: PaymentOptions = {}): Promise<string> => {
    const seats = p.seats ?? 2;
    return buildPaymentHeader({
      keyPair,
      senderId: buyer,
      nonce: p.nonce ?? KEY_NONCE + 1n,
      maxBlockHeight: p.maxBlockHeight ?? maxBlockHeightFor(fake.block.height, config.maxTimeoutSeconds, config.blockTimeMs),
      offer: buildOffer({ ...currentPool(fake), ...p.pool }, seats, offerContext(config)),
      expected: { ...BUYER_CONFIG, maxSeats: seats },
    });
  };
  return { deps, fake, config, buyer, publicKey, header };
}

type Scenario = Awaited<ReturnType<typeof scenario>>;

function currentPool(fake: FakeChain): PoolView {
  const pool = fake.pools.get(POOL_ID);
  if (pool === undefined) throw new Error(`no pool ${POOL_ID}`);
  return pool;
}

/** Replaces pool 7 with `changes` applied. */
function updatePool(fake: FakeChain, changes: Partial<PoolView>): void {
  fake.setPool({ ...currentPool(fake), ...changes });
}

function offerFor(pool: PoolView, seats: number): Offer {
  return buildOffer(pool, seats, offerContext(testConfig()));
}

/** A relayed commit that took `seats` seats, leaving `taken` of the pool's 192 taken. */
function committed(seats: number, taken: number, buyer = BUYER): RelayResult {
  return {
    kind: 'executed',
    outcome: commitOutcome({ txHash: TX_HASH, buyer, poolId: POOL_ID, seats, seatPrice: 180n, taken, target: 192 }),
  };
}

const NO_SEATS = committed(0, 0);

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** A 402 for `code` carrying `accepts`, with nothing relayed. */
function expectRefused(s: Scenario, result: Reply, code: string, accepts: Offer[]): void {
  expect(result).toEqual({ status: 402, body: { x402Version: 1, error: code, accepts } });
  expect(s.fake.relayed).toEqual([]);
}

function paymentResponse(result: Reply): unknown {
  const header = result.headers?.[PAYMENT_RESPONSE_HEADER];
  if (header === undefined) throw new Error('no X-PAYMENT-RESPONSE header');
  return decodeHeader(header);
}

describe('handlePayment: requests it cannot check', () => {
  it('answers 400 invalid_seats for an invalid seats parameter, without reading the chain', async () => {
    const s = await scenario();
    const result = await handlePayment(s.deps, POOL_ID, '1001', await s.header());
    expect(result).toEqual({ status: 400, body: { error: 'invalid_seats' } });
    expect(s.fake.reads.size).toBe(0);
    expect(s.fake.relayed).toEqual([]);
  });

  it('answers 404 unknown_pool for a pool that does not exist', async () => {
    const s = await scenario();
    const result = await handlePayment(s.deps, 8, '2', await s.header());
    expect(result).toEqual({ status: 404, body: { error: 'unknown_pool' } });
    expect(s.fake.relayed).toEqual([]);
  });

  it("answers 404 unknown_pool for another seller's pool", async () => {
    const s = await scenario({ pool: { seller: `other.${PROVIDER}` } });
    const result = await handlePayment(s.deps, POOL_ID, '2', await s.header());
    expect(result).toEqual({ status: 404, body: { error: 'unknown_pool' } });
    expect(s.fake.relayed).toEqual([]);
  });
});

describe('handlePayment: static checks', () => {
  it('answers 402 wrong_amount with the current offer when the amount is not the price of the seats', async () => {
    const s = await scenario();
    // A buyer that has the seat price as 179 pays 358 for 2 seats; the pool's price is 180.
    const header = await s.header({ pool: { seat_price: '179' } });
    const result = await handlePayment(s.deps, POOL_ID, '2', header);
    expectRefused(s, result, 'wrong_amount', [offerFor(currentPool(s.fake), 2)]);
  });

  it('answers 402 wrong_pool when the payment is for more seats than the request asks for', async () => {
    const s = await scenario();
    const result = await handlePayment(s.deps, POOL_ID, '2', await s.header({ seats: 3 }));
    expectRefused(s, result, 'wrong_pool', [offerFor(currentPool(s.fake), 2)]);
  });

  it('answers 202 to a payment for a reduced offer made at the URL first requested', async () => {
    // Asked for 5 seats of a pool that allows 3 per buyer: the offer is for 3.
    const s = await scenario({ pool: { max_seats_per_buyer: 3 } });
    s.fake.relayResults.push(committed(3, 151));
    const result = await handlePayment(s.deps, POOL_ID, '5', await s.header({ seats: 3 }));
    expect(result).toMatchObject({ status: 202, body: { receipt: { seats: 3 }, pool: { taken: 151 } } });
    expect(s.fake.relayed).toHaveLength(1);
  });

  it('answers 402 invalid_payload for a header that does not decode', async () => {
    const s = await scenario();
    const result = await handlePayment(s.deps, POOL_ID, '2', 'not a payment');
    expectRefused(s, result, 'invalid_payload', [offerFor(currentPool(s.fake), 2)]);
  });

  it("does not read the buyer's key or take the in-flight slot for a payment that fails a static check", async () => {
    const s = await scenario();
    const begin = vi.spyOn(s.deps.inFlight, 'begin');
    await handlePayment(s.deps, POOL_ID, '2', 'not a payment');
    expect(begin).not.toHaveBeenCalled();
    expect(s.fake.reads.get('view_access_key')).toBeUndefined();
  });
});

describe('handlePayment: gateway checks', () => {
  it('answers 402 not_full_access when the signing key is not on the account', async () => {
    const s = await scenario();
    s.fake.keys.clear();
    const result = await handlePayment(s.deps, POOL_ID, '2', await s.header());
    expectRefused(s, result, 'not_full_access', [offerFor(currentPool(s.fake), 2)]);
  });

  it('answers 402 not_full_access when the signing key is a function-call key', async () => {
    const s = await scenario();
    s.fake.setKey(BUYER, s.publicKey, { nonce: KEY_NONCE, fullAccess: false });
    const result = await handlePayment(s.deps, POOL_ID, '2', await s.header());
    expectRefused(s, result, 'not_full_access', [offerFor(currentPool(s.fake), 2)]);
  });

  it("answers 402 stale_nonce when the nonce is not above the key's nonce", async () => {
    const s = await scenario();
    const result = await handlePayment(s.deps, POOL_ID, '2', await s.header({ nonce: KEY_NONCE }));
    expectRefused(s, result, 'stale_nonce', [offerFor(currentPool(s.fake), 2)]);
  });

  it('answers 402 nonce_too_large when the nonce is the final height times 10^6', async () => {
    const s = await scenario();
    const header = await s.header({ nonce: s.fake.block.height * 1_000_000n });
    const result = await handlePayment(s.deps, POOL_ID, '2', header);
    expectRefused(s, result, 'nonce_too_large', [offerFor(currentPool(s.fake), 2)]);
  });

  it('accepts a nonce just below the final height times 10^6', async () => {
    const s = await scenario();
    s.fake.relayResults.push(committed(2, 150));
    const header = await s.header({ nonce: s.fake.block.height * 1_000_000n - 1n });
    expect((await handlePayment(s.deps, POOL_ID, '2', header)).status).toBe(202);
  });

  it('answers 402 expired when max_block_height is the current final height', async () => {
    const s = await scenario();
    const result = await handlePayment(s.deps, POOL_ID, '2', await s.header({ maxBlockHeight: s.fake.block.height }));
    expectRefused(s, result, 'expired', [offerFor(currentPool(s.fake), 2)]);
  });

  it('answers 402 expired when max_block_height is below the current final height', async () => {
    const s = await scenario();
    const header = await s.header({ maxBlockHeight: s.fake.block.height - 1n });
    const result = await handlePayment(s.deps, POOL_ID, '2', header);
    expectRefused(s, result, 'expired', [offerFor(currentPool(s.fake), 2)]);
  });

  it('answers 402 expired when max_block_height is only 5 blocks past the final height', async () => {
    const s = await scenario();
    const header = await s.header({ maxBlockHeight: s.fake.block.height + 5n });
    const result = await handlePayment(s.deps, POOL_ID, '2', header);
    expectRefused(s, result, 'expired', [offerFor(currentPool(s.fake), 2)]);
  });

  it('accepts a max_block_height 6 blocks past the final height', async () => {
    const s = await scenario();
    s.fake.relayResults.push(committed(2, 150));
    const header = await s.header({ maxBlockHeight: s.fake.block.height + 6n });
    expect((await handlePayment(s.deps, POOL_ID, '2', header)).status).toBe(202);
    expect(s.fake.relayed).toHaveLength(1);
  });

  it('accepts a max_block_height up to 5 blocks past maxTimeoutSeconds of blocks ahead', async () => {
    // 120 s at 1000 ms a block: at most 120 + 5 blocks ahead.
    const s = await scenario();
    s.fake.relayResults.push(committed(2, 150));
    const header = await s.header({ maxBlockHeight: s.fake.block.height + 125n });
    expect((await handlePayment(s.deps, POOL_ID, '2', header)).status).toBe(202);
  });

  it('answers 402 expired when max_block_height is more than 5 blocks past maxTimeoutSeconds of blocks ahead', async () => {
    const s = await scenario();
    const header = await s.header({ maxBlockHeight: s.fake.block.height + 126n });
    const result = await handlePayment(s.deps, POOL_ID, '2', header);
    expectRefused(s, result, 'expired', [offerFor(currentPool(s.fake), 2)]);
  });

  it('rounds maxTimeoutSeconds of blocks up', async () => {
    // 120 s at 700 ms a block is 171.4 blocks: at most 172 + 5 ahead.
    const s = await scenario({ config: { blockTimeMs: 700 } });
    s.fake.relayResults.push(committed(2, 150));
    const header = await s.header({ maxBlockHeight: s.fake.block.height + 172n + EXPIRY_MARGIN_BLOCKS });
    expect((await handlePayment(s.deps, POOL_ID, '2', header)).status).toBe(202);
  });

  it('answers 402 pool_closed with no offer when the pool has filled', async () => {
    const s = await scenario({ pool: { status: 'filled', taken: 192 } });
    const result = await handlePayment(s.deps, POOL_ID, '2', await s.header());
    expectRefused(s, result, 'pool_closed', []);
  });

  it('answers 402 pool_closed with no offer when an open pool has no seat left', async () => {
    const s = await scenario({ pool: { taken: 192 } });
    const result = await handlePayment(s.deps, POOL_ID, '2', await s.header());
    expectRefused(s, result, 'pool_closed', []);
  });

  it("answers 402 pool_closed when the final block's time has reached the deadline", async () => {
    const s = await scenario();
    s.fake.block = { height: s.fake.block.height, timestampMs: DEADLINE_MS };
    const result = await handlePayment(s.deps, POOL_ID, '2', await s.header());
    expectRefused(s, result, 'pool_closed', [offerFor(currentPool(s.fake), 2)]);
  });

  it("answers 402 insufficient_balance when the buyer's balance is below the amount", async () => {
    const s = await scenario();
    s.fake.balances.set(BUYER, 359n);
    const result = await handlePayment(s.deps, POOL_ID, '2', await s.header());
    expectRefused(s, result, 'insufficient_balance', [offerFor(currentPool(s.fake), 2)]);
  });

  it('accepts a balance that exactly covers the amount', async () => {
    const s = await scenario();
    s.fake.balances.set(BUYER, 360n);
    s.fake.relayResults.push(committed(2, 150));
    expect((await handlePayment(s.deps, POOL_ID, '2', await s.header())).status).toBe(202);
  });

  it("answers 402 seller_commit when the payer is the pool's seller", async () => {
    const s = await scenario({ buyer: PROVIDER });
    const result = await handlePayment(s.deps, POOL_ID, '2', await s.header());
    expectRefused(s, result, 'seller_commit', [offerFor(currentPool(s.fake), 2)]);
  });

  it("answers 402 over_buyer_cap with an offer for the seats left under the pool's limit", async () => {
    const s = await scenario({ pool: { max_seats_per_buyer: 24 } });
    s.fake.setBuyer(POOL_ID, BUYER, { seats: 23, state: 'committed' });
    const result = await handlePayment(s.deps, POOL_ID, '2', await s.header());
    expectRefused(s, result, 'over_buyer_cap', [offerFor(currentPool(s.fake), 1)]);
  });

  it("answers 402 over_buyer_cap with no offer when the buyer already holds the pool's limit", async () => {
    const s = await scenario({ pool: { max_seats_per_buyer: 24 } });
    s.fake.setBuyer(POOL_ID, BUYER, { seats: 24, state: 'committed' });
    const result = await handlePayment(s.deps, POOL_ID, '2', await s.header());
    expectRefused(s, result, 'over_buyer_cap', []);
  });

  it("accepts a payment that brings the buyer's seats exactly to the pool's limit", async () => {
    const s = await scenario({ pool: { max_seats_per_buyer: 24 } });
    s.fake.setBuyer(POOL_ID, BUYER, { seats: 22, state: 'committed' });
    s.fake.relayResults.push(committed(2, 150));
    expect((await handlePayment(s.deps, POOL_ID, '2', await s.header())).status).toBe(202);
  });

  it('accepts any number of seats held when the pool has no limit per buyer', async () => {
    const s = await scenario({ pool: { max_seats_per_buyer: null } });
    s.fake.setBuyer(POOL_ID, BUYER, { seats: 140, state: 'committed' });
    s.fake.relayResults.push(committed(2, 150));
    expect((await handlePayment(s.deps, POOL_ID, '2', await s.header())).status).toBe(202);
  });

  it('answers 402 payment_in_flight while another payment from the same buyer is being relayed', async () => {
    const s = await scenario();
    const relaying = deferred<void>();
    const relayed = deferred<RelayResult>();
    s.fake.onRelay = () => {
      relaying.resolve();
      return relayed.promise;
    };
    const first = handlePayment(s.deps, POOL_ID, '2', await s.header());
    await relaying.promise;

    const second = await handlePayment(s.deps, POOL_ID, '2', await s.header({ nonce: KEY_NONCE + 2n }));
    expect(second).toEqual({
      status: 402,
      body: { x402Version: 1, error: 'payment_in_flight', accepts: [offerFor(currentPool(s.fake), 2)] },
    });
    expect(s.fake.relayed).toHaveLength(1);

    relayed.resolve(committed(2, 150));
    expect((await first).status).toBe(202);
  });

  it('accepts a payment from another buyer while one is being relayed', async () => {
    const s = await scenario();
    const other = 'other-buyer.testnet';
    const otherKey = KeyPair.fromRandom('ed25519');
    s.fake.setKey(other, otherKey.getPublicKey().toString(), { nonce: 0n, fullAccess: true });
    s.fake.balances.set(other, BALANCE);
    const relaying = deferred<void>();
    const relayed = deferred<RelayResult>();
    s.fake.onRelay = () => {
      relaying.resolve();
      return relayed.promise;
    };
    const first = handlePayment(s.deps, POOL_ID, '2', await s.header());
    await relaying.promise;

    s.fake.onRelay = undefined;
    s.fake.relayResults.push(committed(2, 152, other));
    const otherHeader = await buildPaymentHeader({
      keyPair: otherKey,
      senderId: other,
      nonce: 1n,
      maxBlockHeight: s.fake.block.height + 100n,
      offer: offerFor(currentPool(s.fake), 2),
      expected: BUYER_CONFIG,
    });
    expect((await handlePayment(s.deps, POOL_ID, '2', otherHeader)).status).toBe(202);

    relayed.resolve(committed(2, 150));
    expect((await first).status).toBe(202);
  });
});

describe('handlePayment: relay', () => {
  it('relays exactly the delegate the buyer signed, with its max_block_height', async () => {
    const s = await scenario();
    s.fake.relayResults.push(committed(2, 150));
    const maxBlockHeight = s.fake.block.height + 100n;
    const header = await s.header({ maxBlockHeight });
    await handlePayment(s.deps, POOL_ID, '2', header);
    const { payload } = decodeHeader(header) as PaymentPayload;
    expect(
      s.fake.relayed.map((r) => ({
        signedDelegate: Buffer.from(encodeSignedDelegate(r.signed)).toString('base64'),
        maxBlockHeight: r.maxBlockHeight,
      })),
    ).toEqual([{ signedDelegate: payload.signedDelegate, maxBlockHeight }]);
  });

  it('answers 402 expired with the current offer when the relayer finds the delegate too close to its expiry', async () => {
    const s = await scenario();
    s.fake.onRelay = () => {
      throw new DelegateExpiredError('the delegate expires at block 1100 and the final height is 1095');
    };
    const result = await handlePayment(s.deps, POOL_ID, '2', await s.header());
    expect(result).toEqual({
      status: 402,
      body: { x402Version: 1, error: 'expired', accepts: [offerFor(currentPool(s.fake), 2)] },
    });
  });
});

describe('handlePayment: responses', () => {
  it('answers 202 pending with the receipt and the pool after the commit, and an X-PAYMENT-RESPONSE header', async () => {
    const s = await scenario();
    s.fake.relayResults.push(committed(2, 150));
    const result = await handlePayment(s.deps, POOL_ID, '2', await s.header());
    expect(result).toEqual({
      status: 202,
      body: {
        status: 'pending',
        receipt: { poolId: POOL_ID, buyer: BUYER, seats: 2, txHash: TX_HASH },
        pool: { taken: 150, target: 192, deadlineMs: DEADLINE_MS },
      },
      headers: { [PAYMENT_RESPONSE_HEADER]: expect.any(String) },
    });
    expect(paymentResponse(result)).toEqual({ success: true, transaction: TX_HASH, network: 'near:testnet', payer: BUYER });
  });

  it('answers 200 filled with a credential for the seats held plus the seats taken when the commit fills the pool', async () => {
    const s = await scenario({ pool: { taken: 187 } });
    s.fake.setBuyer(POOL_ID, BUYER, { seats: 3, state: 'committed' });
    s.fake.relayResults.push(committed(5, 192));
    const result = await handlePayment(s.deps, POOL_ID, '5', await s.header({ seats: 5 }));
    expect(result).toEqual({
      status: 200,
      body: { status: 'filled', credential: expect.any(String), poolId: POOL_ID, seats: 8, terms: TERMS },
      headers: { [PAYMENT_RESPONSE_HEADER]: expect.any(String) },
    });
    expect(paymentResponse(result)).toEqual({ success: true, transaction: TX_HASH, network: 'near:testnet', payer: BUYER });

    const { credential } = result.body as { credential: string };
    const { payload } = await jwtVerify(credential, createLocalJWKSet(s.deps.credentials.jwks()), {
      issuer: s.config.publicUrl,
      subject: BUYER,
    });
    expect(payload).toMatchObject({ pool: POOL_ID, seats: 8, terms: TERMS, simulated: true });
  });

  it.each(['filled', 'settled'] as const)(
    'answers 409 no_seats_taken with no offer when the pool is %s after a commit that took no seats',
    async (status) => {
      const s = await scenario();
      s.fake.onRelay = () => {
        updatePool(s.fake, { status, taken: 192 });
        return NO_SEATS;
      };
      const result = await handlePayment(s.deps, POOL_ID, '2', await s.header());
      expect(result).toEqual({ status: 409, body: { x402Version: 1, error: 'no_seats_taken', accepts: [] } });
    },
  );

  it("answers 409, not 410, for a pool that filled, even once the final block's time is past its deadline", async () => {
    const s = await scenario();
    s.fake.onRelay = () => {
      updatePool(s.fake, { status: 'filled', taken: 192 });
      s.fake.block = { ...s.fake.block, timestampMs: DEADLINE_MS + 1 };
      return NO_SEATS;
    };
    const result = await handlePayment(s.deps, POOL_ID, '2', await s.header());
    expect(result).toEqual({ status: 409, body: { x402Version: 1, error: 'no_seats_taken', accepts: [] } });
  });

  // The contract takes min(seats, target - taken) seats of an open pool, so it took none for another
  // reason, such as the buyer's limit, and the same payment would be refused again.
  it.each([
    ['room for every seat paid for', 148],
    ['one seat left of the two paid for', 191],
  ])('answers 502 relay_failed when a commit took no seats while the pool was open with %s', async (_label, taken) => {
    const s = await scenario();
    s.fake.onRelay = () => {
      updatePool(s.fake, { taken });
      return NO_SEATS;
    };
    const result = await handlePayment(s.deps, POOL_ID, '2', await s.header());
    expect(result).toEqual({ status: 502, body: { error: 'relay_failed', txHash: TX_HASH } });
  });

  it("answers 410 pool_expired when the final block's time has reached the deadline of a pool the view still shows open", async () => {
    const s = await scenario();
    s.fake.onRelay = () => {
      s.fake.block = { ...s.fake.block, timestampMs: DEADLINE_MS };
      return NO_SEATS;
    };
    const result = await handlePayment(s.deps, POOL_ID, '2', await s.header());
    expect(result).toEqual({ status: 410, body: { error: 'pool_expired', poolId: POOL_ID, txHash: TX_HASH } });
  });

  it("judges the deadline by the final block's time, not the gateway's clock, after a commit that took no seats", async () => {
    const s = await scenario();
    s.deps.now = () => DEADLINE_MS + 60_000;
    s.fake.onRelay = () => {
      s.fake.block = { ...s.fake.block, timestampMs: DEADLINE_MS - 1 };
      return NO_SEATS;
    };
    const result = await handlePayment(s.deps, POOL_ID, '2', await s.header());
    expect(result).toEqual({ status: 502, body: { error: 'relay_failed', txHash: TX_HASH } });
  });

  it('answers 502 relay_failed when a commit took no seats because the transfer never reached the pools contract', async () => {
    // The pool filled meanwhile, which alone would answer 409.
    const s = await scenario();
    s.fake.onRelay = () => {
      updatePool(s.fake, { status: 'filled', taken: 192 });
      const refusedByToken = outcome(TX_HASH, [{ executorId: BUYER }, { executorId: TOKEN, failed: true }]);
      return { kind: 'executed', outcome: refusedByToken };
    };
    const result = await handlePayment(s.deps, POOL_ID, '2', await s.header());
    expect(result).toEqual({ status: 502, body: { error: 'relay_failed', txHash: TX_HASH } });
  });

  it.each(['expired', 'refunded'] as const)(
    'answers 410 pool_expired with the transaction hash when the pool is %s after a commit that took no seats',
    async (status) => {
      const s = await scenario();
      s.fake.onRelay = () => {
        updatePool(s.fake, { status });
        return NO_SEATS;
      };
      const result = await handlePayment(s.deps, POOL_ID, '2', await s.header());
      expect(result).toEqual({ status: 410, body: { error: 'pool_expired', poolId: POOL_ID, txHash: TX_HASH } });
    },
  );

  it('answers 502 relay_failed with the transaction hash when the RPC rejects the relay', async () => {
    const s = await scenario();
    s.fake.relayResults.push({ kind: 'rejected', txHash: TX_HASH, error: 'InvalidNonceError' });
    const result = await handlePayment(s.deps, POOL_ID, '2', await s.header());
    expect(result).toEqual({ status: 502, body: { error: 'relay_failed', txHash: TX_HASH } });
  });

  it('answers 502 relay_failed with the transaction hash when the delegate action fails', async () => {
    const s = await scenario();
    s.fake.relayResults.push({ kind: 'executed', outcome: outcome(TX_HASH, [{ executorId: BUYER, failed: true }]) });
    const result = await handlePayment(s.deps, POOL_ID, '2', await s.header());
    expect(result).toEqual({ status: 502, body: { error: 'relay_failed', txHash: TX_HASH } });
  });

  it('answers 502 result_unknown with the transaction hash when the result is not known in time', async () => {
    const s = await scenario();
    s.fake.relayResults.push({ kind: 'unknown', txHash: TX_HASH, expired: false });
    const result = await handlePayment(s.deps, POOL_ID, '2', await s.header());
    expect(result).toEqual({ status: 502, body: { error: 'result_unknown', txHash: TX_HASH } });
  });

  it('answers 502 result_unknown with the transaction hash when the outcome cannot be read', async () => {
    const s = await scenario();
    const malformed = eventLog({
      event: 'seats_committed',
      data: { pool_id: POOL_ID, buyer: BUYER, seats: 2, amount: '3.6e2', taken: 150, target: 192 },
    });
    s.fake.relayResults.push({
      kind: 'executed',
      outcome: outcome(TX_HASH, [{ executorId: BUYER }, { executorId: TOKEN }, { executorId: POOLS, logs: [malformed] }]),
    });
    const result = await handlePayment(s.deps, POOL_ID, '2', await s.header());
    expect(result).toEqual({ status: 502, body: { error: 'result_unknown', txHash: TX_HASH } });
  });

  it('answers 502 result_unknown with the transaction hash when the pool cannot be read again after a commit that took no seats', async () => {
    const s = await scenario();
    s.fake.onRelay = () => {
      vi.spyOn(s.fake, 'getPool').mockRejectedValue(new Error('connect ECONNREFUSED'));
      return NO_SEATS;
    };
    const result = await handlePayment(s.deps, POOL_ID, '2', await s.header());
    expect(result).toEqual({ status: 502, body: { error: 'result_unknown', txHash: TX_HASH } });
  });

  it('answers 502 result_unknown with the transaction hash when the final block cannot be read after a commit that took no seats', async () => {
    const s = await scenario();
    s.fake.onRelay = () => {
      vi.spyOn(s.fake, 'finalBlock').mockRejectedValue(new Error('connect ECONNREFUSED'));
      return NO_SEATS;
    };
    const result = await handlePayment(s.deps, POOL_ID, '2', await s.header());
    expect(result).toEqual({ status: 502, body: { error: 'result_unknown', txHash: TX_HASH } });
  });

  it.each(['getPool', 'accessKey', 'finalBlock', 'ftBalanceOf', 'getBuyer'] as const)(
    'answers 503 chain_unavailable, relaying nothing, when %s throws',
    async (method) => {
      const s = await scenario();
      vi.spyOn(s.fake, method).mockRejectedValue(new Error('connect ECONNREFUSED'));
      const result = await handlePayment(s.deps, POOL_ID, '2', await s.header());
      expect(result).toEqual({ status: 503, body: { error: 'chain_unavailable' } });
      expect(s.fake.relayed).toEqual([]);
    },
  );

  it('answers 503 chain_unavailable when relayDelegate throws before sending', async () => {
    const s = await scenario();
    s.fake.onRelay = () => {
      throw new Error('no relayer key was free within 30000 ms');
    };
    const result = await handlePayment(s.deps, POOL_ID, '2', await s.header());
    expect(result).toEqual({ status: 503, body: { error: 'chain_unavailable' } });
  });
});

describe('handlePayment: activity feed', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Makes every append fail and silences the log; returns the console.error spy. */
  function failAppends(s: Scenario) {
    vi.spyOn(s.deps.activity, 'append').mockRejectedValue(new Error('ENOSPC: no space left on device'));
    return vi.spyOn(console, 'error').mockImplementation(() => {});
  }

  it('records a commit that took seats, with its amount and transaction hash', async () => {
    const s = await scenario();
    s.fake.relayResults.push(committed(2, 150));
    await handlePayment(s.deps, POOL_ID, '2', await s.header());
    expect(s.deps.activity.list()).toEqual([
      { at: NOW_MS, poolId: POOL_ID, kind: 'commit', account: BUYER, seats: 2, amount: '360', txHash: TX_HASH, ok: true },
    ]);
  });

  it('records a commit that took no seats as not ok', async () => {
    const s = await scenario();
    s.fake.relayResults.push(NO_SEATS);
    await handlePayment(s.deps, POOL_ID, '2', await s.header());
    expect(s.deps.activity.list()).toEqual([
      { at: NOW_MS, poolId: POOL_ID, kind: 'commit', account: BUYER, seats: 0, amount: '0', txHash: TX_HASH, ok: false },
    ]);
  });

  it.each<[string, RelayResult]>([
    ['the relay is rejected', { kind: 'rejected', txHash: TX_HASH, error: 'InvalidNonceError' }],
    ['the result is unknown', { kind: 'unknown', txHash: TX_HASH, expired: false }],
    ['the delegate action fails', { kind: 'executed', outcome: outcome(TX_HASH, [{ executorId: BUYER, failed: true }]) }],
  ])('records nothing when %s', async (_, relayResult) => {
    const s = await scenario();
    s.fake.relayResults.push(relayResult);
    await handlePayment(s.deps, POOL_ID, '2', await s.header());
    expect(s.deps.activity.list()).toEqual([]);
  });

  it('still answers 202 pending when the record cannot be appended', async () => {
    const s = await scenario();
    failAppends(s);
    s.fake.relayResults.push(committed(2, 150));
    const result = await handlePayment(s.deps, POOL_ID, '2', await s.header());
    expect(result).toMatchObject({ status: 202, body: { status: 'pending' } });
  });

  it('still answers 200 filled when the record cannot be appended', async () => {
    const s = await scenario({ pool: { taken: 190 } });
    failAppends(s);
    s.fake.relayResults.push(committed(2, 192));
    const result = await handlePayment(s.deps, POOL_ID, '2', await s.header());
    expect(result).toMatchObject({ status: 200, body: { status: 'filled', seats: 2 } });
  });

  it('logs a record it cannot append', async () => {
    const s = await scenario();
    const logged = failAppends(s);
    s.fake.relayResults.push(committed(2, 150));
    await handlePayment(s.deps, POOL_ID, '2', await s.header());
    expect(logged).toHaveBeenCalledOnce();
  });
});

describe('handlePayment: in-flight slot', () => {
  const cases: Array<[string, (s: Scenario) => void]> = [
    ['the commit takes seats', (s) => s.fake.relayResults.push(committed(2, 150))],
    ['the commit takes no seats', (s) => s.fake.relayResults.push(NO_SEATS)],
    ['the relay is rejected', (s) => s.fake.relayResults.push({ kind: 'rejected', txHash: TX_HASH, error: 'x' })],
    [
      'the result is unknown and the delegate has expired',
      (s) => s.fake.relayResults.push({ kind: 'unknown', txHash: TX_HASH, expired: true }),
    ],
    ['a gateway check fails', (s) => s.fake.balances.set(BUYER, 0n)],
    ['a chain read throws', (s) => vi.spyOn(s.fake, 'ftBalanceOf').mockRejectedValue(new Error('rpc down'))],
    [
      'relayDelegate throws',
      (s) => {
        s.fake.onRelay = () => {
          throw new Error('no relayer key was free');
        };
      },
    ],
    [
      'the outcome cannot be read',
      (s) => {
        const malformed = eventLog({
          event: 'seats_committed',
          data: { pool_id: POOL_ID, buyer: BUYER, seats: 2, amount: 'x', taken: 150, target: 192 },
        });
        s.fake.relayResults.push({ kind: 'executed', outcome: outcome(TX_HASH, [{ executorId: POOLS, logs: [malformed] }]) });
      },
    ],
  ];

  it.each(cases)('is released when %s', async (_, arrange) => {
    const s = await scenario();
    arrange(s);
    const begin = vi.spyOn(s.deps.inFlight, 'begin');
    await handlePayment(s.deps, POOL_ID, '2', await s.header());
    expect(begin).toHaveBeenCalledWith(BUYER);
    expect(begin).toHaveReturnedWith(true);
    expect(s.deps.inFlight.has(BUYER)).toBe(false);
  });
});

describe('handlePayment: a payment whose result is unknown', () => {
  /** The 402 a payment gets while another from the same buyer is in flight. */
  function inFlightReply(s: Scenario): Reply {
    const accepts = [offerFor(currentPool(s.fake), 2)];
    return { status: 402, body: { x402Version: 1, error: 'payment_in_flight', accepts } };
  }

  /** Relays a payment whose delegate expires at block 1100 and whose result is unknown. */
  async function relayUnknown(s: Scenario, expired: boolean): Promise<void> {
    s.fake.relayResults.push({ kind: 'unknown', txHash: TX_HASH, expired });
    const result = await handlePayment(s.deps, POOL_ID, '2', await s.header({ maxBlockHeight: 1_100n }));
    expect(result).toEqual({ status: 502, body: { error: 'result_unknown', txHash: TX_HASH } });
  }

  it('keeps the buyer in flight when the delegate may still land, so its next payment is refused', async () => {
    const s = await scenario();
    await relayUnknown(s, false);
    const next = await handlePayment(s.deps, POOL_ID, '2', await s.header({ nonce: KEY_NONCE + 2n }));
    expect(next).toEqual(inFlightReply(s));
    expect(s.fake.relayed).toHaveLength(1);
  });

  it("frees the buyer once a final block above the delegate's max_block_height is seen, not at it", async () => {
    const s = await scenario();
    await relayUnknown(s, false);
    s.fake.block = { ...s.fake.block, height: 1_100n };
    const atHeight = await handlePayment(s.deps, POOL_ID, '2', await s.header({ nonce: KEY_NONCE + 2n }));
    expect(atHeight).toEqual(inFlightReply(s));

    s.fake.block = { ...s.fake.block, height: 1_101n };
    s.fake.relayResults.push(committed(2, 150));
    expect((await handlePayment(s.deps, POOL_ID, '2', await s.header({ nonce: KEY_NONCE + 2n }))).status).toBe(202);
    expect(s.fake.relayed).toHaveLength(2);
  });

  it('frees the buyer at once when the delegate can no longer execute', async () => {
    const s = await scenario();
    await relayUnknown(s, true);
    s.fake.relayResults.push(committed(2, 150));
    expect((await handlePayment(s.deps, POOL_ID, '2', await s.header({ nonce: KEY_NONCE + 2n }))).status).toBe(202);
  });

  it('answers 503 chain_unavailable, relaying nothing, when the final block cannot be read for a held buyer', async () => {
    const s = await scenario();
    await relayUnknown(s, false);
    vi.spyOn(s.fake, 'finalBlock').mockRejectedValue(new Error('connect ECONNREFUSED'));
    const next = await handlePayment(s.deps, POOL_ID, '2', await s.header({ nonce: KEY_NONCE + 2n }));
    expect(next).toEqual({ status: 503, body: { error: 'chain_unavailable' } });
    expect(s.fake.relayed).toHaveLength(1);
    expect(s.deps.inFlight.held(BUYER)).toBe(true);
  });

  it('does not block another buyer while one is held', async () => {
    const s = await scenario();
    s.deps.inFlight.hold('other-buyer.testnet', 1_100n);
    s.fake.relayResults.push(committed(2, 150));
    expect((await handlePayment(s.deps, POOL_ID, '2', await s.header())).status).toBe(202);
    expect(s.deps.inFlight.held('other-buyer.testnet')).toBe(true);
  });

  it("lifts another buyer's hold once a payment's final block is above that delegate's max_block_height", async () => {
    const s = await scenario();
    s.deps.inFlight.hold('other-buyer.testnet', 999n);
    s.fake.relayResults.push(committed(2, 150));
    await handlePayment(s.deps, POOL_ID, '2', await s.header());
    expect(s.deps.inFlight.has('other-buyer.testnet')).toBe(false);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @quorum-on-near/gateway exec vitest run test/handle-payment.test.ts`

Expected: FAIL. vitest cannot load `../src/handle-payment.ts`, which does not exist yet.

- [ ] **Step 3: Write the implementation**

`apps/gateway/src/handle-payment.ts`:

```typescript
import { PAYMENT_RESPONSE_HEADER, checkPaymentHeader, encodeHeader, paymentRequired } from '@quorum-on-near/protocol';
import type {
  CheckedPayment,
  GatewayErrorCode,
  PaymentErrorCode,
  PaymentResponse,
  PoolView,
} from '@quorum-on-near/protocol';
import type { ActivityRecord } from './activity.ts';
import { DelegateExpiredError, EXPIRY_MARGIN_BLOCKS, type RelayResult, type TxOutcome } from './chain.ts';
import type { Deps } from './deps.ts';
import { currentAccepts, parseSeats } from './handle-offer.ts';
import { readCommit } from './outcome.ts';
import { servedPool } from './pools.ts';
import { reply, type Reply } from './reply.ts';


/**
 * NEAR refuses a delegate whose nonce is at or above the block height times this without storing
 * the nonce, so the same payment could otherwise be relayed again and again.
 */
const NONCE_RANGE_MULTIPLIER = 1_000_000n;

/** A refusal carries the buyer's seats once they are known, so that its offer can respect the buyer's limit. */
type ChainCheck = { ok: true; held: number } | { ok: false; code: GatewayErrorCode; held?: number };

/**
 * `GET /pools/:id/access?seats=N` with an `X-PAYMENT` header (spec sections 6.3 and 6.4): the
 * checks in order, then the relay, then the response table. The payment may commit to fewer seats
 * than `seats` (a reduced offer paid at the URL first requested), never to more.
 * - 400 `{error: "invalid_seats"}` and 404 `{error: "unknown_pool"}` as for the offer.
 * - 402 paymentRequired(current offer, code) for a failed check, a payment already in flight for
 *   the buyer, or a delegate the relayer finds too close to its expiry to send (`expired`). Nothing
 *   is relayed. The `over_buyer_cap` offer is for the seats the buyer may still take, if any.
 *   A payment whose result is unknown keeps its buyer in flight, while its delegate may still land,
 *   until a final block above its `max_block_height` is read.
 * - 202 `{status: "pending", receipt, pool}` or, when the commit filled the pool, 200 `{status:
 *   "filled", credential, poolId, seats, terms}`; both carry `X-PAYMENT-RESPONSE`.
 * - When no seats were taken: 410 `{error: "pool_expired", poolId, txHash}` if the pool is past its
 *   deadline (its view says Expired or Refunded, or says Open while the latest final block's time is
 *   at or past the deadline); 502 `{error: "relay_failed", txHash}` if the transfer never reached the
 *   pools contract or the pool is still Open with a seat left; otherwise (the pool filled) 409
 *   `{x402Version: 1, error: "no_seats_taken", accepts: []}`.
 * - 502 `{error: "relay_failed" | "result_unknown", txHash}` when the relay was refused, the delegate
 *   failed, or the result is unknown or cannot be read.
 * - 503 `{error: "chain_unavailable"}` when the chain cannot be read before the relay.
 *
 * A failure to append to the activity feed is logged and does not change the reply.
 */
export async function handlePayment(
  deps: Deps,
  poolId: number,
  seatsParam: string | undefined,
  header: string,
): Promise<Reply> {
  const seats = parseSeats(seatsParam);
  if (seats === null) return reply(400, { error: 'invalid_seats' });
  try {
    return await checkAndRelay(deps, poolId, seats, header);
  } catch {
    // A chain read failed, or relayDelegate threw before sending anything.
    return reply(503, { error: 'chain_unavailable' });
  }
}

async function checkAndRelay(deps: Deps, poolId: number, seats: number, header: string): Promise<Reply> {
  const { config, chain, inFlight } = deps;
  const pool = await servedPool(chain, config.provider, poolId);
  if (pool === null) return reply(404, { error: 'unknown_pool' });
  // Every refused payment gets the offer as it stands.
  const refuse = (code: PaymentErrorCode, held?: number): Reply =>
    reply(402, paymentRequired(currentAccepts(pool, seats, config, held), code));

  const checked = checkPaymentHeader(header, {
    network: config.network,
    token: config.token,
    poolsContract: config.poolsContract,
    poolId,
    maxSeats: seats,
    seatPrice: BigInt(pool.seat_price),
    minGas: config.minGas,
    maxGas: config.maxGas,
  });
  if (!checked.ok) return refuse(checked.code);
  const { payment } = checked;

  // A held buyer is freed once the final height passes its earlier payment's max_block_height.
  if (inFlight.held(payment.senderId)) inFlight.passed((await chain.finalBlock()).height);
  if (!inFlight.begin(payment.senderId)) return refuse('payment_in_flight');
  try {
    const check = await checkOnChain(deps, pool, payment);
    if (!check.ok) return refuse(check.code, check.held);
    let result: RelayResult;
    try {
      result = await deps.writer.relayDelegate(payment.signedDelegate, payment.maxBlockHeight);
    } catch (error) {
      // Nothing was sent. Any other error answers 503 like a failed read.
      if (error instanceof DelegateExpiredError) return refuse('expired', check.held);
      throw error;
    }
    return await answerRelay(deps, pool, payment, check.held, result);
  } finally {
    inFlight.end(payment.senderId);
  }
}

/** Checks 4 to 8: the buyer's key, its nonce and expiry, the pool, the balance and the buyer's seats. */
async function checkOnChain(deps: Deps, pool: PoolView, payment: CheckedPayment): Promise<ChainCheck> {
  const { chain, config } = deps;
  const buyer = payment.senderId;
  const refused = (code: GatewayErrorCode): ChainCheck => ({ ok: false, code });

  const key = await chain.accessKey(buyer, payment.publicKey);
  if (key === null || !key.fullAccess) return refused('not_full_access');
  if (payment.nonce <= key.nonce) return refused('stale_nonce');
  const block = await chain.finalBlock();
  // Frees every held buyer whose payment can no longer execute, so holds do not pile up.
  deps.inFlight.passed(block.height);
  if (payment.nonce >= block.height * NONCE_RANGE_MULTIPLIER) return refused('nonce_too_large');
  const maxAhead = BigInt(Math.ceil((config.maxTimeoutSeconds * 1000) / config.blockTimeMs));
  const ahead = payment.maxBlockHeight - block.height;
  if (ahead <= EXPIRY_MARGIN_BLOCKS || ahead > maxAhead + EXPIRY_MARGIN_BLOCKS) return refused('expired');
  if (pool.status !== 'open' || pool.taken >= pool.target || block.timestampMs >= pool.deadline_ms) {
    return refused('pool_closed');
  }
  if ((await chain.ftBalanceOf(buyer)) < payment.amount) return refused('insufficient_balance');
  // The contract refuses both of these, so relaying them would only cost the relayer gas.
  if (buyer === pool.seller) return refused('seller_commit');
  const held = (await chain.getBuyer(pool.id, buyer))?.seats ?? 0;
  if (pool.max_seats_per_buyer !== null && held + payment.seats > pool.max_seats_per_buyer) {
    return { ok: false, code: 'over_buyer_cap', held };
  }
  return { ok: true, held };
}

/** The response to a relay. `held` is the seats the buyer held before this payment. */
async function answerRelay(
  deps: Deps,
  pool: PoolView,
  payment: CheckedPayment,
  held: number,
  result: RelayResult,
): Promise<Reply> {
  if (result.kind === 'rejected') return reply(502, { error: 'relay_failed', txHash: result.txHash });
  if (result.kind === 'unknown') {
    // The delegate may still land: the buyer stays in flight until it no longer can.
    if (!result.expired) deps.inFlight.hold(payment.senderId, payment.maxBlockHeight);
    return reply(502, { error: 'result_unknown', txHash: result.txHash });
  }
  try {
    return await answerCommit(deps, pool, payment, held, result.outcome);
  } catch {
    // The transaction ran, so the payment may have landed: the buyer finds out through redemption.
    return reply(502, { error: 'result_unknown', txHash: result.outcome.txHash });
  }
}

async function answerCommit(
  deps: Deps,
  pool: PoolView,
  payment: CheckedPayment,
  held: number,
  outcome: TxOutcome,
): Promise<Reply> {
  const { config } = deps;
  const buyer = payment.senderId;
  const { txHash } = outcome;
  const commit = readCommit(outcome, { poolsContract: config.poolsContract, buyer, poolId: pool.id });
  if (commit.delegateFailed) return reply(502, { error: 'relay_failed', txHash });

  await appendActivity(deps, {
    at: deps.now(),
    poolId: pool.id,
    kind: 'commit',
    account: buyer,
    seats: commit.seats,
    amount: commit.amount.toString(),
    txHash,
    ok: commit.seats > 0,
  });
  if (commit.seats === 0) return await answerNoSeats(deps, pool.id, outcome);

  const response: PaymentResponse = { success: true, transaction: txHash, network: config.network, payer: buyer };
  const headers = { [PAYMENT_RESPONSE_HEADER]: encodeHeader(response) };
  if (commit.filled) {
    const seats = held + commit.seats;
    const credential = await deps.credentials.issue({ buyer, poolId: pool.id, seats, terms: pool.terms });
    return reply(200, { status: 'filled', credential, poolId: pool.id, seats, terms: pool.terms }, headers);
  }
  return reply(
    202,
    {
      status: 'pending',
      receipt: { poolId: pool.id, buyer, seats: commit.seats, txHash },
      pool: { taken: commit.taken, target: commit.target, deadlineMs: pool.deadline_ms },
    },
    headers,
  );
}

/**
 * A commit that took no seats, so the token has returned the payment. The contract takes
 * `min(seats, target − taken)` seats of an Open pool before its deadline, so a payment lost a race
 * only if the pool filled or expired before it landed.
 */
async function answerNoSeats(deps: Deps, poolId: number, outcome: TxOutcome): Promise<Reply> {
  const { txHash } = outcome;
  const latest = await deps.chain.getPool(poolId);
  if (latest !== null && (await pastDeadline(deps, latest))) {
    return reply(410, { error: 'pool_expired', poolId, txHash });
  }
  const reachedPools = outcome.receipts.some((receipt) => receipt.executorId === deps.config.poolsContract);
  const seatLeft = latest?.status === 'open' && latest.taken < latest.target;
  if (!reachedPools || seatLeft) {
    // The refusal had another cause, such as the buyer's limit, so the same payment would be refused again.
    return reply(502, { error: 'relay_failed', txHash });
  }
  // The pool filled before the payment landed, so there is nothing left to offer.
  return reply(409, paymentRequired([], 'no_seats_taken'));
}

/**
 * Whether a pool is past its deadline: its view says Expired or Refunded, or says Open while the
 * latest final block's time is at or past the deadline. A Filled or Settled pool never is.
 */
async function pastDeadline(deps: Deps, pool: PoolView): Promise<boolean> {
  if (pool.status === 'expired' || pool.status === 'refunded') return true;
  return pool.status === 'open' && (await deps.chain.finalBlock()).timestampMs >= pool.deadline_ms;
}

/** Appends to the activity feed, logging a failure: the feed never changes a reply. */
async function appendActivity(deps: Deps, record: ActivityRecord): Promise<void> {
  try {
    await deps.activity.append(record);
  } catch (error) {
    console.error('could not append to the activity feed:', error);
  }
}
```

- [ ] **Step 4: Run the tests and the typecheck**

Run: `pnpm --filter @quorum-on-near/gateway exec vitest run test/handle-payment.test.ts`

Expected: PASS, 80 tests (`test/handle-payment.test.ts` 80).

Run: `pnpm --filter @quorum-on-near/gateway typecheck`

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/handle-payment.ts apps/gateway/test/handle-payment.test.ts
git commit -m "check, relay and answer quorum payments"
```


---

### Task 12: Redemption

A buyer that received 202 comes back with `X-QUORUM-PROOF` (spec section 6.5). The replay cache is keyed by the public key and the nonce, which is what NEP-413 signs; the account is not signed.

**Files:**
- Create: `apps/gateway/src/handle-redeem.ts`
- Test: `apps/gateway/test/handle-redeem.test.ts`

**Interfaces:**
- Consumes: `Deps`, `Reply` (Task 10); `servedPool` (Task 9); `checkRedeemProof`, `priceOf` from the protocol package.
- Produces: `handleRedeem(deps, poolId: number, header: string): Promise<Reply>`.

- [ ] **Step 1: Write the failing test**

`apps/gateway/test/handle-redeem.test.ts`:

```typescript
import { createLocalJWKSet, decodeJwt, jwtVerify } from 'jose';
import { KeyPair } from 'near-api-js';
import { describe, expect, it, vi } from 'vitest';
import {
  REDEEM_MAX_AGE_MS,
  REDEEM_MAX_SKEW_MS,
  buildRedeemProofHeader,
  decodeHeader,
  encodeHeader,
  type BuyerState,
  type BuyerView,
  type PoolStatus,
  type PoolView,
  type ProofInput,
} from '@quorum-on-near/protocol';
import type { ActivityRecord } from '../src/activity.ts';
import type { AccessKeyInfo } from '../src/chain.ts';
import type { GatewayConfig } from '../src/config.ts';
import { handleRedeem } from '../src/handle-redeem.ts';
import { NOW_MS, TERMS, poolView, testConfig } from './fake-chain.ts';
import { testDeps } from './handler-deps.ts';

const BUYER = 'alice.testnet';
const OTHER_BUYER = 'bob.testnet';
const POOL_ID = 7;
/** The host of testConfig's public URL. */
const RECIPIENT = 'localhost:8402';
const FULL_ACCESS: AccessKeyInfo = { nonce: 5n, fullAccess: true };

/**
 * Handler deps over a FakeChain holding pool 7 and a buyer with a full-access key and 2 committed
 * seats, plus a builder for that buyer's proofs.
 */
async function setup(
  opts: {
    pool?: Partial<PoolView>;
    holding?: BuyerView | null;
    key?: AccessKeyInfo | null;
    config?: GatewayConfig;
  } = {},
) {
  const deps = await testDeps(opts.config ? { config: opts.config } : {});
  const keyPair = KeyPair.fromRandom('ed25519');
  deps.fake.setPool(poolView({ id: POOL_ID, ...opts.pool }));
  const key = opts.key === undefined ? FULL_ACCESS : opts.key;
  if (key !== null) deps.fake.setKey(BUYER, keyPair.getPublicKey().toString(), key);
  deps.fake.setBuyer(POOL_ID, BUYER, opts.holding === undefined ? { seats: 2, state: 'committed' } : opts.holding);
  const proof = (overrides: Partial<ProofInput> = {}) =>
    buildRedeemProofHeader({ keyPair, accountId: BUYER, poolId: POOL_ID, recipient: RECIPIENT, nowMs: NOW_MS, ...overrides });
  return { deps, proof };
}

function refundRecord(overrides: Partial<ActivityRecord> = {}): ActivityRecord {
  return {
    at: NOW_MS,
    poolId: POOL_ID,
    kind: 'refund',
    account: BUYER,
    seats: 2,
    amount: '360',
    txHash: 'RefundTx1',
    ok: true,
    ...overrides,
  };
}

describe('handleRedeem', () => {
  describe('pool lookup', () => {
    it('answers 404 unknown_pool for a pool that does not exist', async () => {
      const { deps, proof } = await setup();
      expect(await handleRedeem(deps, 8, await proof({ poolId: 8 }))).toEqual({ status: 404, body: { error: 'unknown_pool' } });
    });

    it("answers 404 unknown_pool for another seller's pool", async () => {
      const { deps, proof } = await setup({ pool: { seller: 'other-seller.testnet' } });
      expect(await handleRedeem(deps, POOL_ID, await proof())).toEqual({ status: 404, body: { error: 'unknown_pool' } });
    });
  });

  describe('proof checks', () => {
    it('answers 401 invalid_proof for a header that does not decode to a proof', async () => {
      const { deps } = await setup();
      expect(await handleRedeem(deps, POOL_ID, 'not-a-proof')).toEqual({ status: 401, body: { error: 'invalid_proof' } });
    });

    it("answers 401 wrong_message for another pool's proof", async () => {
      const { deps, proof } = await setup();
      expect(await handleRedeem(deps, POOL_ID, await proof({ poolId: 8 }))).toEqual({
        status: 401,
        body: { error: 'wrong_message' },
      });
    });

    it('answers 401 wrong_recipient for a proof addressed to another host', async () => {
      const { deps, proof } = await setup();
      expect(await handleRedeem(deps, POOL_ID, await proof({ recipient: 'gateway.example.org' }))).toEqual({
        status: 401,
        body: { error: 'wrong_recipient' },
      });
    });

    it('accepts a proof addressed to the host of the configured public URL', async () => {
      const { deps, proof } = await setup({ config: testConfig({ publicUrl: 'https://gateway.example.org' }) });
      const result = await handleRedeem(deps, POOL_ID, await proof({ recipient: 'gateway.example.org' }));
      expect(result.status).toBe(202);
    });

    it.each([
      ['signed 5 minutes ago', NOW_MS - REDEEM_MAX_AGE_MS],
      ['signed further ahead than the allowed clock skew', NOW_MS + REDEEM_MAX_SKEW_MS + 1],
    ])('answers 401 stale_proof for a proof %s', async (_name, signedAtMs) => {
      const { deps, proof } = await setup();
      expect(await handleRedeem(deps, POOL_ID, await proof({ nowMs: signedAtMs }))).toEqual({
        status: 401,
        body: { error: 'stale_proof' },
      });
    });

    it('answers 401 invalid_signature for a proof that names a key other than the signing one', async () => {
      const { deps, proof } = await setup();
      const other = KeyPair.fromRandom('ed25519').getPublicKey().toString();
      deps.fake.setKey(BUYER, other, FULL_ACCESS);
      const forged = encodeHeader({ ...(decodeHeader(await proof()) as object), publicKey: other });
      expect(await handleRedeem(deps, POOL_ID, forged)).toEqual({ status: 401, body: { error: 'invalid_signature' } });
    });

    it('answers 401 not_full_access when the account has no such key', async () => {
      const { deps, proof } = await setup({ key: null });
      expect(await handleRedeem(deps, POOL_ID, await proof())).toEqual({ status: 401, body: { error: 'not_full_access' } });
    });

    it('answers 401 not_full_access for a function-call key', async () => {
      const { deps, proof } = await setup({ key: { nonce: 5n, fullAccess: false } });
      expect(await handleRedeem(deps, POOL_ID, await proof())).toEqual({ status: 401, body: { error: 'not_full_access' } });
    });

    it('answers 401 replayed_proof on the second use of the same proof', async () => {
      const { deps, proof } = await setup();
      const header = await proof();
      expect((await handleRedeem(deps, POOL_ID, header)).status).toBe(202);
      expect(await handleRedeem(deps, POOL_ID, header)).toEqual({ status: 401, body: { error: 'replayed_proof' } });
    });

    it('answers 401 replayed_proof to the same proof presented under another account that holds the same full-access key', async () => {
      const { deps, proof } = await setup();
      const header = await proof();
      const decoded = decodeHeader(header) as { publicKey: string };
      deps.fake.setKey(OTHER_BUYER, decoded.publicKey, FULL_ACCESS);
      deps.fake.setBuyer(POOL_ID, OTHER_BUYER, { seats: 2, state: 'committed' });
      const underOtherBuyer = encodeHeader({ ...decoded, accountId: OTHER_BUYER });
      expect((await handleRedeem(deps, POOL_ID, header)).status).toBe(202);
      expect(await handleRedeem(deps, POOL_ID, underOtherBuyer)).toEqual({ status: 401, body: { error: 'replayed_proof' } });
    });

    it('accepts proofs signed by two keys with the same nonce', async () => {
      const { deps, proof } = await setup();
      const otherKey = KeyPair.fromRandom('ed25519');
      deps.fake.setKey(BUYER, otherKey.getPublicKey().toString(), FULL_ACCESS);
      const random = new Uint8Array(24).fill(1);
      expect((await handleRedeem(deps, POOL_ID, await proof({ random }))).status).toBe(202);
      expect((await handleRedeem(deps, POOL_ID, await proof({ keyPair: otherKey, random }))).status).toBe(202);
    });

    it('accepts a second proof from the same buyer', async () => {
      const { deps, proof } = await setup();
      expect((await handleRedeem(deps, POOL_ID, await proof())).status).toBe(202);
      expect((await handleRedeem(deps, POOL_ID, await proof())).status).toBe(202);
    });

    it('does not use up a proof refused for its key', async () => {
      const { deps, proof } = await setup({ key: { nonce: 5n, fullAccess: false } });
      const header = await proof();
      expect((await handleRedeem(deps, POOL_ID, header)).status).toBe(401);
      deps.fake.setKey(BUYER, (decodeHeader(header) as { publicKey: string }).publicKey, FULL_ACCESS);
      expect((await handleRedeem(deps, POOL_ID, header)).status).toBe(202);
    });
  });

  describe('holdings', () => {
    it.each([
      ['holds no seats', null],
      ['holds 0 seats', { seats: 0, state: 'committed' } satisfies BuyerView],
    ])('answers 404 no_seats when the account %s', async (_name, holding) => {
      const { deps, proof } = await setup({ holding });
      expect(await handleRedeem(deps, POOL_ID, await proof())).toEqual({ status: 404, body: { error: 'no_seats' } });
    });

    it('answers 202 pending with the seats and the pool progress for an open pool', async () => {
      const { deps, proof } = await setup({ pool: { status: 'open', taken: 150, target: 192 } });
      expect(await handleRedeem(deps, POOL_ID, await proof())).toEqual({
        status: 202,
        body: { status: 'pending', seats: 2, taken: 150, target: 192, deadlineMs: 1_800_000_000_000 },
      });
    });

    it.each<PoolStatus>(['filled', 'settled'])('answers 200 filled with the seats and terms for a %s pool', async (status) => {
      const { deps, proof } = await setup({ pool: { status, taken: 192 }, holding: { seats: 3, state: 'committed' } });
      expect(await handleRedeem(deps, POOL_ID, await proof())).toEqual({
        status: 200,
        body: { status: 'filled', credential: expect.any(String), poolId: POOL_ID, seats: 3, terms: TERMS },
      });
    });

    it.each<PoolStatus>(['filled', 'settled'])(
      "issues, for a %s pool, a credential that verifies against the issuer's JWKS and carries the seats and terms",
      async (status) => {
        const { deps, proof } = await setup({ pool: { status, taken: 192 }, holding: { seats: 3, state: 'committed' } });
        const { body } = await handleRedeem(deps, POOL_ID, await proof());
        const { payload } = await jwtVerify((body as { credential: string }).credential, createLocalJWKSet(deps.credentials.jwks()), {
          issuer: deps.config.publicUrl,
          algorithms: ['EdDSA'],
        });
        expect(payload).toMatchObject({ sub: BUYER, pool: POOL_ID, seats: 3, terms: TERMS, simulated: true });
      },
    );

    it('gives the same buyer redeeming twice credentials with the same sub, pool and seats', async () => {
      const { deps, proof } = await setup({ pool: { status: 'filled', taken: 192 } });
      const credentialClaims = async () => {
        const { body } = await handleRedeem(deps, POOL_ID, await proof());
        const { sub, pool, seats } = decodeJwt((body as { credential: string }).credential);
        return { sub, pool, seats };
      };
      const first = await credentialClaims();
      expect(first).toEqual({ sub: BUYER, pool: POOL_ID, seats: 2 });
      expect(await credentialClaims()).toEqual(first);
    });

    it.each<[PoolStatus, BuyerState, string]>([
      ['expired', 'committed', 'refund_pending'],
      ['expired', 'refunded', 'refunded'],
      ['expired', 'claimable', 'claimable'],
      ['refunded', 'committed', 'refund_pending'],
      ['refunded', 'refunded', 'refunded'],
      ['refunded', 'claimable', 'claimable'],
    ])('answers 410 for a %s pool, mapping the buyer state %s to %s', async (status, state, expected) => {
      const { deps, proof } = await setup({ pool: { status }, holding: { seats: 2, state } });
      const result = await handleRedeem(deps, POOL_ID, await proof());
      expect(result.status).toBe(410);
      expect((result.body as { status: string }).status).toBe(expected);
    });

    it('gives the seats times the seat price plus the bonus share, and the bonus share, in a 410', async () => {
      const { deps, proof } = await setup({
        pool: { status: 'expired', seat_price: '180', bonus_per_seat: '9' },
        holding: { seats: 3, state: 'committed' },
      });
      expect(await handleRedeem(deps, POOL_ID, await proof())).toEqual({
        status: 410,
        body: { status: 'refund_pending', amount: '567', bonusShare: '27', txHash: null },
      });
    });

    it("gives the transaction of the buyer's latest successful refund in this pool", async () => {
      const { deps, proof } = await setup({ pool: { status: 'refunded' }, holding: { seats: 2, state: 'refunded' } });
      await deps.activity.append(refundRecord({ txHash: 'RefundTx1' }));
      await deps.activity.append(refundRecord({ txHash: 'RefundTx2' }));
      await deps.activity.append(refundRecord({ txHash: 'FailedTx', ok: false, seats: 0 }));
      await deps.activity.append(refundRecord({ txHash: 'OtherBuyerTx', account: OTHER_BUYER }));
      await deps.activity.append(refundRecord({ txHash: 'OtherPoolTx', poolId: 8 }));
      const result = await handleRedeem(deps, POOL_ID, await proof());
      expect((result.body as { txHash: string | null }).txHash).toBe('RefundTx2');
    });

    it('gives a null txHash when the feed has no refund for the buyer', async () => {
      const { deps, proof } = await setup({ pool: { status: 'refunded' }, holding: { seats: 2, state: 'claimable' } });
      await deps.activity.append(refundRecord({ txHash: 'FailedTx', ok: false, seats: 0 }));
      const result = await handleRedeem(deps, POOL_ID, await proof());
      expect((result.body as { txHash: string | null }).txHash).toBeNull();
    });
  });

  describe('chain failures', () => {
    it.each(['getPool', 'accessKey', 'getBuyer'] as const)('answers 503 chain_unavailable when %s throws', async (method) => {
      const { deps, proof } = await setup();
      vi.spyOn(deps.fake, method).mockRejectedValue(new Error('rpc unreachable'));
      expect(await handleRedeem(deps, POOL_ID, await proof())).toEqual({ status: 503, body: { error: 'chain_unavailable' } });
    });
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @quorum-on-near/gateway exec vitest run test/handle-redeem.test.ts`

Expected: FAIL. vitest cannot load `../src/handle-redeem.ts`, which does not exist yet.

- [ ] **Step 3: Write the implementation**

`apps/gateway/src/handle-redeem.ts`:

```typescript
import { checkRedeemProof, priceOf, type BuyerState, type BuyerView, type PoolView } from '@quorum-on-near/protocol';
import type { Deps } from './deps.ts';
import { servedPool } from './pools.ts';
import { reply, type Reply } from './reply.ts';

/** The refund status a buyer of an expired pool sees, by the buyer's state on the contract. */
const REFUND_STATUS: Record<BuyerState, 'refund_pending' | 'refunded' | 'claimable'> = {
  committed: 'refund_pending',
  refunded: 'refunded',
  claimable: 'claimable',
};

/**
 * `GET /pools/:id/access` with an `X-QUORUM-PROOF` header (spec section 6.5): checks the proof, its
 * key and its nonce, then answers from the buyer's seats and the pool's status.
 * - 404 `{error: "unknown_pool"}` if the pool does not exist or is another seller's.
 * - 401 `{error: code}` for a proof that fails checkRedeemProof, `not_full_access` if its key is not
 *   a full-access key of the account, `replayed_proof` if a proof with the same key and nonce was
 *   seen, under any account.
 * - 404 `{error: "no_seats"}` if the account holds no seats in the pool.
 * - 202 pending, 200 with a credential, or 410 with the refund, by pool status.
 * - 503 `{error: "chain_unavailable"}` if the chain cannot be read.
 */
export async function handleRedeem(deps: Deps, poolId: number, header: string): Promise<Reply> {
  const { config, chain, proofNonces } = deps;
  try {
    const pool = await servedPool(chain, config.provider, poolId);
    if (pool === null) return reply(404, { error: 'unknown_pool' });

    const nowMs = deps.now();
    const proof = checkRedeemProof(header, { poolId, recipient: new URL(config.publicUrl).host, nowMs });
    if (!proof.ok) return reply(401, { error: proof.code });
    const key = await chain.accessKey(proof.accountId, proof.publicKey);
    if (key === null || !key.fullAccess) return reply(401, { error: 'not_full_access' });
    // NEP-413 signs the nonce but not the account, so the same proof verifies under every account
    // that holds the key: the replay key is the key and the nonce.
    if (proofNonces.seen(`${proof.publicKey}:${proof.nonceKey}`, nowMs)) return reply(401, { error: 'replayed_proof' });

    const holding = await chain.getBuyer(poolId, proof.accountId);
    if (holding === null || holding.seats === 0) return reply(404, { error: 'no_seats' });
    return await holdingReply(deps, pool, proof.accountId, holding);
  } catch {
    return reply(503, { error: 'chain_unavailable' });
  }
}

/** The answer for a buyer holding seats, by the pool's status. */
async function holdingReply(deps: Deps, pool: PoolView, buyer: string, holding: BuyerView): Promise<Reply> {
  const { seats } = holding;
  switch (pool.status) {
    case 'open':
      return reply(202, { status: 'pending', seats, taken: pool.taken, target: pool.target, deadlineMs: pool.deadline_ms });
    case 'filled':
    case 'settled': {
      const credential = await deps.credentials.issue({ buyer, poolId: pool.id, seats, terms: pool.terms });
      return reply(200, { status: 'filled', credential, poolId: pool.id, seats, terms: pool.terms });
    }
    case 'expired':
    case 'refunded': {
      const bonusPerSeat = BigInt(pool.bonus_per_seat);
      return reply(410, {
        status: REFUND_STATUS[holding.state],
        amount: priceOf(seats, BigInt(pool.seat_price) + bonusPerSeat).toString(),
        bonusShare: priceOf(seats, bonusPerSeat).toString(),
        // A refund the buyer claimed itself is not in the feed.
        txHash: deps.activity.lastRefund(pool.id, buyer)?.txHash ?? null,
      });
    }
  }
}
```

- [ ] **Step 4: Run the tests and the typecheck**

Run: `pnpm --filter @quorum-on-near/gateway exec vitest run test/handle-redeem.test.ts`

Expected: PASS, 36 tests (`test/handle-redeem.test.ts` 36).

Run: `pnpm --filter @quorum-on-near/gateway typecheck`

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/handle-redeem.ts apps/gateway/test/handle-redeem.test.ts
git commit -m "redeem NEP-413 proofs for credentials and refund status"
```


---

### Task 13: The keeper

Every 5 seconds the keeper calls `settle` on each served Filled pool and `refund(pool_id, limit)` on each served Expired pool, unless that pool's dust transfer is already in flight (spec section 6.7). Ticks never overlap. A pool whose call makes no progress backs off (30 s, doubling, up to 10 minutes), and only the first failure of such a streak goes to the activity feed. A `settle` progresses when the pool settles; a `refund` when its pools receipt succeeds and the pool had buyers left to visit (even if they had all claimed their own refunds and nothing was logged), or when the dust arrives.

**Files:**
- Create: `apps/gateway/src/keeper.ts`
- Test: `apps/gateway/test/keeper.test.ts`

**Interfaces:**
- Consumes: `ChainReader`, `ChainWriter` (Task 7); `ActivityLog`, `keeperCallProgressed`, `keeperRecords`, `listServedPools` (Task 9).
- Produces: `interface KeeperOptions {chain, writer, activity, provider, poolsContract, refundLimit, settleGas, refundGas, now, log?}`, `class Keeper {tick(): Promise<void>; start(intervalMs): void; stop(): Promise<void>}`.

- [ ] **Step 1: Write the failing test**

`apps/gateway/test/keeper.test.ts`:

```typescript
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PoolView } from '@quorum-on-near/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActivityLog } from '../src/activity.ts';
import type { RelayResult } from '../src/chain.ts';
import { Keeper } from '../src/keeper.ts';
import { FakeChain, NOW_MS, POOLS, PROVIDER, TOKEN, outcome, poolView } from './fake-chain.ts';

const SETTLE_GAS = 100_000_000_000_000n;
const REFUND_GAS = 300_000_000_000_000n;
const REFUND_LIMIT = 7;
const ALICE = 'alice.testnet';
const BOB = 'bob.testnet';

function settled(poolId: number, txHash = 'SettleTx'): RelayResult {
  return {
    kind: 'executed',
    outcome: outcome(txHash, [
      { executorId: POOLS },
      { executorId: TOKEN },
      { executorId: POOLS, events: [{ event: 'pool_settled', data: { pool_id: poolId, seller: PROVIDER, amount: '36288' } }] },
    ]),
  };
}

/** An executed call whose receipt at the pools contract failed: it made no progress. */
function failed(txHash = 'FailedTx'): RelayResult {
  return { kind: 'executed', outcome: outcome(txHash, [{ executorId: POOLS, failed: true }]) };
}

/** An executed refund call that refunded one buyer and failed to refund another. */
function partlyRefunded(poolId: number): RelayResult {
  return {
    kind: 'executed',
    outcome: outcome('PartialRefundTx', [
      {
        executorId: POOLS,
        events: [
          { event: 'seat_refunded', data: { pool_id: poolId, buyer: ALICE, seats: 2, amount: '360', bonus_share: '0' } },
          { event: 'refund_failed', data: { pool_id: poolId, buyer: BOB, amount: '180' } },
        ],
      },
    ]),
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

let dir: string;
let fake: FakeChain;
let activity: ActivityLog;
let messages: string[];
/** The keeper's clock, which tests move by hand. */
let clock: number;
let keeper: Keeper;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'quorum-keeper-'));
  fake = new FakeChain();
  activity = await ActivityLog.open(join(dir, 'activity.jsonl'));
  messages = [];
  clock = NOW_MS;
  keeper = new Keeper({
    chain: fake,
    writer: fake,
    activity,
    provider: PROVIDER,
    poolsContract: POOLS,
    refundLimit: REFUND_LIMIT,
    settleGas: SETTLE_GAS,
    refundGas: REFUND_GAS,
    now: () => clock,
    log: (message) => messages.push(message),
  });
});

/**
 * Asserts that the keeper waits exactly `waitMs` from the clock's current time before calling the
 * pool again: a tick 1 ms earlier makes no call, a tick at `waitMs` makes one.
 */
async function expectWait(waitMs: number): Promise<void> {
  const from = clock;
  const calls = fake.calls.length;
  clock = from + waitMs - 1;
  await keeper.tick();
  expect(fake.calls).toHaveLength(calls);
  clock = from + waitMs;
  await keeper.tick();
  expect(fake.calls).toHaveLength(calls + 1);
}

/** Moves the clock past the longest wait, then ticks. */
async function tickAfterLongestWait(): Promise<void> {
  clock += 600_000;
  await keeper.tick();
}

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('Keeper.tick', () => {
  it('calls settle with the pool id and the configured gas for a served filled pool', async () => {
    fake.setPool(poolView({ status: 'filled', taken: 192 }));
    await keeper.tick();
    expect(fake.calls).toEqual([{ method: 'settle', args: { pool_id: 7 }, gas: SETTLE_GAS }]);
  });

  it('calls refund with the pool id, the refund limit and the configured gas for a served expired pool', async () => {
    fake.setPool(poolView({ status: 'expired', bonus_per_seat: '9', refund_cursor: 3 }));
    await keeper.tick();
    expect(fake.calls).toEqual([{ method: 'refund', args: { pool_id: 7, limit: REFUND_LIMIT }, gas: REFUND_GAS }]);
  });

  it('skips an expired pool whose dust transfer is in flight', async () => {
    fake.setPool(poolView({ status: 'expired', buyer_count: 10, refund_cursor: 10, dust_sent: true }));
    await keeper.tick();
    expect(fake.calls).toEqual([]);
  });

  it('calls refund for an expired pool whose buyers are all processed but whose dust is not sent', async () => {
    fake.setPool(poolView({ status: 'expired', buyer_count: 10, refund_cursor: 10, dust_sent: false }));
    await keeper.tick();
    expect(fake.calls.map((c) => c.method)).toEqual(['refund']);
  });

  it.each(['open', 'settled', 'refunded'] as const)('makes no call for a served %s pool', async (status) => {
    fake.setPool(poolView({ status }));
    await keeper.tick();
    expect(fake.calls).toEqual([]);
  });

  it("ignores another seller's pools", async () => {
    fake.setPool(poolView({ id: 0, seller: 'other.testnet', status: 'filled' }));
    fake.setPool(poolView({ id: 1, seller: 'other.testnet', status: 'expired' }));
    await keeper.tick();
    expect(fake.calls).toEqual([]);
  });

  it('calls the pools one at a time, in id order', async () => {
    for (const id of [2, 0, 1]) fake.setPool(poolView({ id, status: 'filled' }));
    let active = 0;
    let maxActive = 0;
    fake.onCall = async (_method, args) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setImmediate(resolve));
      active -= 1;
      return settled(args.pool_id as number);
    };
    await keeper.tick();
    expect(fake.calls.map((c) => c.args.pool_id)).toEqual([0, 1, 2]);
    expect(maxActive).toBe(1);
  });

  it('appends the records of an executed settle call to the activity feed', async () => {
    fake.setPool(poolView({ status: 'filled', taken: 192 }));
    fake.callResults.push(settled(7));
    await keeper.tick();
    expect(activity.list()).toEqual([
      { at: NOW_MS, poolId: 7, kind: 'settle', account: PROVIDER, seats: 192, amount: '36288', txHash: 'SettleTx', ok: true },
    ]);
  });

  it('appends the refund and dust records of an executed refund call to the activity feed', async () => {
    fake.setPool(poolView({ status: 'expired', taken: 5, bonus_per_seat: '345' }));
    fake.callResults.push({
      kind: 'executed',
      outcome: outcome('RefundTx', [
        { executorId: POOLS },
        { executorId: TOKEN },
        {
          executorId: POOLS,
          events: [{ event: 'seat_refunded', data: { pool_id: 7, buyer: ALICE, seats: 5, amount: '2625', bonus_share: '1725' } }],
        },
        { executorId: POOLS, events: [{ event: 'pool_refunded', data: { pool_id: 7, dust: '3' } }] },
      ]),
    });
    await keeper.tick();
    expect(activity.list()).toEqual([
      { at: NOW_MS, poolId: 7, kind: 'refund', account: ALICE, seats: 5, amount: '2625', txHash: 'RefundTx', ok: true },
      { at: NOW_MS, poolId: 7, kind: 'dust', account: PROVIDER, seats: 0, amount: '3', txHash: 'RefundTx', ok: true },
    ]);
  });

  it('logs a rejected call and appends nothing', async () => {
    fake.setPool(poolView({ status: 'filled' }));
    fake.callResults.push({ kind: 'rejected', txHash: 'RejectedTx', error: 'invalid nonce' });
    await keeper.tick();
    expect(activity.list()).toEqual([]);
    expect(messages).toEqual([expect.stringMatching(/settle.*pool 7.*RejectedTx.*invalid nonce/)]);
  });

  it('logs a call whose result is unknown and appends nothing', async () => {
    fake.setPool(poolView({ status: 'expired' }));
    fake.callResults.push({ kind: 'unknown', txHash: 'UnknownTx', expired: false });
    await keeper.tick();
    expect(activity.list()).toEqual([]);
    expect(messages).toEqual([expect.stringMatching(/refund.*pool 7.*UnknownTx/)]);
  });

  it('keeps calling the other pools when the call for one pool throws', async () => {
    fake.setPool(poolView({ id: 0, status: 'filled' }));
    fake.setPool(poolView({ id: 1, status: 'filled', taken: 192 }));
    fake.onCall = (_method, args) => {
      if (args.pool_id === 0) throw new Error('connection reset');
      return settled(1);
    };
    await keeper.tick();
    expect(fake.calls.map((c) => c.args.pool_id)).toEqual([0, 1]);
    expect(activity.list().map((r) => r.poolId)).toEqual([1]);
    expect(messages).toEqual([expect.stringMatching(/settle.*pool 0.*connection reset/)]);
  });

  it('resolves without throwing when listing the pools fails, and logs why', async () => {
    vi.spyOn(fake, 'listPools').mockRejectedValue(new Error('rpc unreachable'));
    await expect(keeper.tick()).resolves.toBeUndefined();
    expect(fake.calls).toEqual([]);
    expect(messages).toEqual([expect.stringContaining('rpc unreachable')]);
  });

  it('logs an append that fails', async () => {
    fake.setPool(poolView({ status: 'filled', taken: 192 }));
    fake.callResults.push(settled(7));
    vi.spyOn(activity, 'append').mockRejectedValueOnce(new Error('disk full'));
    await keeper.tick();
    expect(messages).toEqual([expect.stringMatching(/settle record.*pool 7.*disk full/)]);
  });

  it("appends the call's other records after an append fails", async () => {
    fake.setPool(poolView({ status: 'expired' }));
    fake.callResults.push(partlyRefunded(7));
    vi.spyOn(activity, 'append').mockRejectedValueOnce(new Error('disk full'));
    await keeper.tick();
    expect(activity.list()).toEqual([
      { at: NOW_MS, poolId: 7, kind: 'refund', account: BOB, seats: 0, amount: '180', txHash: 'PartialRefundTx', ok: false },
    ]);
  });

  it('keeps calling the other pools after an append fails', async () => {
    fake.setPool(poolView({ id: 0, status: 'filled', taken: 192 }));
    fake.setPool(poolView({ id: 1, status: 'filled', taken: 192 }));
    fake.onCall = (_method, args) => settled(args.pool_id as number);
    vi.spyOn(activity, 'append').mockRejectedValueOnce(new Error('disk full'));
    await keeper.tick();
    expect(fake.calls.map((c) => c.args.pool_id)).toEqual([0, 1]);
    expect(activity.list().map((r) => r.poolId)).toEqual([1]);
  });

  it('does not back off from a successful call whose append fails', async () => {
    fake.setPool(poolView({ status: 'filled', taken: 192 }));
    fake.onCall = () => settled(7);
    vi.spyOn(activity, 'append').mockRejectedValueOnce(new Error('disk full'));
    await keeper.tick();
    await keeper.tick();
    expect(fake.calls).toHaveLength(2);
  });
});

describe('Keeper backoff', () => {
  it('skips a filled pool whose settle call failed at the pools contract until 30 s have passed', async () => {
    fake.setPool(poolView({ status: 'filled' }));
    fake.onCall = () => failed();
    await keeper.tick();
    await expectWait(30_000);
  });

  it('doubles the wait after each further failure in a row, up to 10 minutes', async () => {
    fake.setPool(poolView({ status: 'filled' }));
    fake.onCall = () => failed();
    await keeper.tick();
    for (const waitMs of [30_000, 60_000, 120_000, 240_000, 480_000, 600_000, 600_000]) await expectWait(waitMs);
  });

  it.each<[string, RelayResult]>([
    ['was rejected', { kind: 'rejected', txHash: 'RejectedTx', error: 'invalid nonce' }],
    ['has an unknown result', { kind: 'unknown', txHash: 'UnknownTx', expired: false }],
    ['failed at the pools contract', failed()],
  ])('skips an expired pool whose refund call %s until 30 s have passed', async (_name, result) => {
    fake.setPool(poolView({ status: 'expired' }));
    fake.onCall = () => result;
    await keeper.tick();
    await expectWait(30_000);
  });

  it('does not back off from a refund batch that only passed buyers who had claimed their own refunds, and appends nothing', async () => {
    fake.setPool(poolView({ status: 'expired', buyer_count: 10, refund_cursor: 0 }));
    fake.onCall = () => ({ kind: 'executed', outcome: outcome('SkippedTx', [{ executorId: POOLS }]) });
    await keeper.tick();
    await keeper.tick();
    expect(fake.calls).toHaveLength(2);
    expect(activity.list()).toEqual([]);
    expect(messages).toEqual([]);
  });

  it('does not back off from a refund batch whose every push failed, and appends their failed records', async () => {
    fake.setPool(poolView({ status: 'expired', buyer_count: 10, refund_cursor: 0 }));
    fake.onCall = () => ({
      kind: 'executed',
      outcome: outcome('PushesFailedTx', [
        { executorId: POOLS },
        { executorId: TOKEN, failed: true },
        { executorId: POOLS, events: [{ event: 'refund_failed', data: { pool_id: 7, buyer: ALICE, amount: '360' } }] },
      ]),
    });
    await keeper.tick();
    await keeper.tick();
    expect(fake.calls).toHaveLength(2);
    expect(activity.list()).toEqual(
      Array(2).fill({ at: NOW_MS, poolId: 7, kind: 'refund', account: ALICE, seats: 0, amount: '360', txHash: 'PushesFailedTx', ok: false }),
    );
  });

  it('backs off from a refund call that only retried the dust, whose transfer failed', async () => {
    fake.setPool(poolView({ status: 'expired', buyer_count: 10, refund_cursor: 10, dust_sent: false }));
    fake.onCall = () => ({
      kind: 'executed',
      outcome: outcome('DustTx', [{ executorId: POOLS }, { executorId: TOKEN, failed: true }, { executorId: POOLS }]),
    });
    await keeper.tick();
    await expectWait(30_000);
    expect(activity.list()).toEqual([
      { at: NOW_MS, poolId: 7, kind: 'refund', account: PROVIDER, seats: 0, amount: '0', txHash: 'DustTx', ok: false },
    ]);
    expect(messages[0]).toMatch(/refund on pool 7 made no progress \(transaction DustTx\); next try in 30 s/);
  });

  it('starts again from 30 s after a call that made progress', async () => {
    fake.setPool(poolView({ status: 'filled', taken: 192 }));
    fake.callResults.push(failed(), failed(), settled(7));
    fake.onCall = () => failed();
    await keeper.tick();
    await expectWait(30_000);
    await expectWait(60_000);
    await keeper.tick();
    expect(fake.calls).toHaveLength(4);
    await expectWait(30_000);
  });

  it('counts a refund batch that refunded one buyer and failed to refund another as progress', async () => {
    fake.setPool(poolView({ status: 'expired' }));
    fake.onCall = (_method, args) => partlyRefunded(args.pool_id as number);
    await keeper.tick();
    await keeper.tick();
    expect(fake.calls).toHaveLength(2);
  });

  it('calls a pool again on the next tick after its call threw', async () => {
    fake.setPool(poolView({ status: 'filled' }));
    fake.onCall = () => {
      throw new Error('connection reset');
    };
    await keeper.tick();
    await keeper.tick();
    expect(fake.calls).toHaveLength(2);
  });

  it('appends only the first failure of a run to the feed', async () => {
    fake.setPool(poolView({ status: 'filled' }));
    fake.callResults.push(failed('FailedTx1'), failed('FailedTx2'), failed('FailedTx3'));
    await keeper.tick();
    await tickAfterLongestWait();
    await tickAfterLongestWait();
    expect(activity.list()).toEqual([
      { at: NOW_MS, poolId: 7, kind: 'settle', account: PROVIDER, seats: 0, amount: '0', txHash: 'FailedTx1', ok: false },
    ]);
  });

  it('logs every failure of a run with the wait before the next call', async () => {
    fake.setPool(poolView({ status: 'filled' }));
    fake.callResults.push(failed('FailedTx1'), failed('FailedTx2'), failed('FailedTx3'));
    await keeper.tick();
    await tickAfterLongestWait();
    await tickAfterLongestWait();
    expect(messages).toEqual([
      expect.stringMatching(/settle on pool 7.*FailedTx1.*next try in 30 s/),
      expect.stringMatching(/settle on pool 7.*FailedTx2.*next try in 60 s/),
      expect.stringMatching(/settle on pool 7.*FailedTx3.*next try in 120 s/),
    ]);
  });

  it('appends the first failure of a new run after a success', async () => {
    fake.setPool(poolView({ status: 'filled', taken: 192 }));
    fake.callResults.push(failed('FailedTx1'), failed('FailedTx2'), settled(7), failed('FailedTx3'));
    await keeper.tick();
    await tickAfterLongestWait();
    await tickAfterLongestWait();
    await keeper.tick();
    expect(activity.list().map((r) => [r.txHash, r.ok])).toEqual([
      ['FailedTx1', false],
      ['SettleTx', true],
      ['FailedTx3', false],
    ]);
  });

  it('keeps calling the other pools while one pool waits', async () => {
    fake.setPool(poolView({ id: 0, status: 'filled' }));
    fake.setPool(poolView({ id: 1, status: 'filled', taken: 192 }));
    fake.onCall = (_method, args) => (args.pool_id === 0 ? failed() : settled(1));
    await keeper.tick();
    clock += 1_000;
    await keeper.tick();
    expect(fake.calls.map((c) => c.args.pool_id)).toEqual([0, 1, 1]);
  });

  it("does not count one pool's failures against another", async () => {
    fake.setPool(poolView({ id: 0, status: 'filled' }));
    fake.onCall = () => failed();
    await keeper.tick();
    await tickAfterLongestWait();
    fake.setPool(poolView({ id: 1, status: 'filled' }));
    await tickAfterLongestWait();
    expect(messages.at(-1)).toMatch(/settle on pool 1.*next try in 30 s/);
  });

  it('forgets the failures of a pool once it needs no call', async () => {
    fake.setPool(poolView({ status: 'expired' }));
    fake.onCall = () => failed();
    await keeper.tick();
    fake.setPool(poolView({ status: 'expired', refund_cursor: 10, dust_sent: true }));
    clock += 1_000;
    await keeper.tick();
    fake.setPool(poolView({ status: 'expired', refund_cursor: 10, dust_sent: false }));
    clock += 1_000;
    await keeper.tick();
    expect(fake.calls).toHaveLength(2);
  });
});

describe('Keeper.start and Keeper.stop', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    await keeper.stop();
    vi.useRealTimers();
  });

  it('runs the first tick one interval after start, and each next tick one interval after the last', async () => {
    const list = vi.spyOn(fake, 'listPools');
    keeper.start(1000);
    await vi.advanceTimersByTimeAsync(999);
    expect(list).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(list).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('does not start a tick while the previous one is still running', async () => {
    const gate = deferred<PoolView[]>();
    const list = vi.spyOn(fake, 'listPools').mockReturnValueOnce(gate.promise);
    keeper.start(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(list).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(list).toHaveBeenCalledTimes(1);
    gate.resolve([]);
    await vi.advanceTimersByTimeAsync(999);
    expect(list).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('stop resolves only once the running tick has finished', async () => {
    const gate = deferred<PoolView[]>();
    vi.spyOn(fake, 'listPools').mockReturnValueOnce(gate.promise);
    keeper.start(1000);
    await vi.advanceTimersByTimeAsync(1000);
    let stopped = false;
    const stopping = keeper.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);
    gate.resolve([]);
    await stopping;
    expect(stopped).toBe(true);
  });

  it('schedules no tick after a stop made during a tick', async () => {
    const gate = deferred<PoolView[]>();
    const list = vi.spyOn(fake, 'listPools').mockReturnValueOnce(gate.promise);
    keeper.start(1000);
    await vi.advanceTimersByTimeAsync(1000);
    const stopping = keeper.stop();
    gate.resolve([]);
    await stopping;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('schedules no tick after a stop made between ticks', async () => {
    const list = vi.spyOn(fake, 'listPools');
    keeper.start(1000);
    await vi.advanceTimersByTimeAsync(1500);
    await keeper.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('runs again after a stop when started again', async () => {
    const list = vi.spyOn(fake, 'listPools');
    keeper.start(1000);
    await keeper.stop();
    keeper.start(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('refuses to start when already started', () => {
    keeper.start(1000);
    expect(() => keeper.start(1000)).toThrow('already started');
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @quorum-on-near/gateway exec vitest run test/keeper.test.ts`

Expected: FAIL. vitest cannot load `../src/keeper.ts`, which does not exist yet.

- [ ] **Step 3: Write the implementation**

`apps/gateway/src/keeper.ts`:

```typescript
import type { PoolView } from '@quorum-on-near/protocol';
import { keeperCallProgressed, keeperRecords, type ActivityLog, type ActivityRecord } from './activity.ts';
import type { ChainReader, ChainWriter, RelayResult } from './chain.ts';
import { listServedPools } from './pools.ts';

export interface KeeperOptions {
  chain: ChainReader;
  writer: ChainWriter;
  activity: ActivityLog;
  provider: string;
  poolsContract: string;
  refundLimit: number;
  settleGas: bigint;
  refundGas: bigint;
  /** The keeper's clock in milliseconds: it stamps the feed records and times the backoff. */
  now: () => number;
  log?: (message: string) => void;
}

interface KeeperCall {
  method: 'settle' | 'refund';
  args: Record<string, unknown>;
  gas: bigint;
}

/** A pool's run of failed calls. */
interface Backoff {
  /** Failed calls in a row. */
  failures: number;
  /** The pool is skipped until the clock reaches this time. */
  retryAtMs: number;
}

/** The wait after a pool's first failed call; each further failure in a row doubles it. */
const FIRST_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 600_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Why a call made no progress, for the log. */
function failureText(result: RelayResult): string {
  switch (result.kind) {
    case 'executed':
      return `made no progress (transaction ${result.outcome.txHash})`;
    case 'unknown':
      return `has an unknown result (transaction ${result.txHash})`;
    case 'rejected':
      return `was rejected (transaction ${result.txHash}): ${result.error}`;
  }
}

/**
 * Calls `settle` on every served Filled pool and `refund(pool_id, refundLimit)` on every served
 * Expired pool whose dust is not in flight (spec section 6.7), and records each call in the activity
 * feed. Anyone may call these methods, so the keeper is a convenience.
 *
 * A call that makes no progress (an executed call that did not move its pool on, by
 * keeperCallProgressed, or a rejected or unknown result) starts a backoff for its pool: the pool is
 * skipped for 30 s, twice as long after each further failure in a row, at most 10 minutes. A call
 * that makes progress ends the run. Only the first failure of a run goes to the feed; every failure
 * is logged.
 */
export class Keeper {
  readonly #chain: ChainReader;
  readonly #writer: ChainWriter;
  readonly #activity: ActivityLog;
  readonly #provider: string;
  readonly #poolsContract: string;
  readonly #refundLimit: number;
  readonly #settleGas: bigint;
  readonly #refundGas: bigint;
  readonly #now: () => number;
  readonly #log: (message: string) => void;
  /** The pools whose last call failed, by pool id. */
  readonly #backoff = new Map<number, Backoff>();
  /** The interval while started; null once stopped. */
  #intervalMs: number | null = null;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #running: Promise<void> | undefined;

  constructor(opts: KeeperOptions) {
    this.#chain = opts.chain;
    this.#writer = opts.writer;
    this.#activity = opts.activity;
    this.#provider = opts.provider;
    this.#poolsContract = opts.poolsContract;
    this.#refundLimit = opts.refundLimit;
    this.#settleGas = opts.settleGas;
    this.#refundGas = opts.refundGas;
    this.#now = opts.now;
    this.#log = opts.log ?? ((message) => console.error(message));
  }

  /**
   * One pass over the served pools, one call at a time, skipping pools in backoff. Never throws:
   * failures are logged, and a call that throws is retried next tick.
   */
  async tick(): Promise<void> {
    let pools: PoolView[];
    try {
      pools = await listServedPools(this.#chain, this.#provider);
    } catch (error) {
      this.#log(`keeper: listing pools failed: ${errorMessage(error)}`);
      return;
    }
    for (const pool of pools) {
      const call = this.#callFor(pool);
      if (call === null) {
        // A pool that needs no call has no run of failures to keep.
        this.#backoff.delete(pool.id);
        continue;
      }
      const backoff = this.#backoff.get(pool.id);
      if (backoff !== undefined && this.#now() < backoff.retryAtMs) continue;
      try {
        await this.#run(pool, call);
      } catch (error) {
        this.#log(`keeper: ${call.method} on pool ${pool.id} failed: ${errorMessage(error)}`);
      }
    }
  }

  /** Runs tick every `intervalMs`, waiting for each tick to finish before scheduling the next. */
  start(intervalMs: number): void {
    if (this.#intervalMs !== null) throw new Error('the keeper is already started');
    this.#intervalMs = intervalMs;
    // A tick still running from before a stop schedules the next one when it ends.
    if (this.#running === undefined) this.#schedule();
  }

  /** Stops scheduling and waits for a running tick. */
  async stop(): Promise<void> {
    this.#intervalMs = null;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    await this.#running;
  }

  #schedule(): void {
    if (this.#intervalMs === null) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#running = this.tick().finally(() => {
        this.#running = undefined;
        this.#schedule();
      });
    }, this.#intervalMs);
  }

  /**
   * The call a pool needs: `settle` when Filled; `refund` when Expired, unless every buyer has been
   * processed and the dust transfer is in flight (its callback marks the pool Refunded).
   */
  #callFor(pool: PoolView): KeeperCall | null {
    if (pool.status === 'filled') {
      return { method: 'settle', args: { pool_id: pool.id }, gas: this.#settleGas };
    }
    if (pool.status === 'expired' && !(pool.refund_cursor >= pool.buyer_count && pool.dust_sent)) {
      return { method: 'refund', args: { pool_id: pool.id, limit: this.#refundLimit }, gas: this.#refundGas };
    }
    return null;
  }

  async #run(pool: PoolView, call: KeeperCall): Promise<void> {
    const result = await this.#writer.callPools(call.method, call.args, call.gas);
    const nowMs = this.#now();
    const outcome = result.kind === 'executed' ? result.outcome : null;
    const records = outcome === null ? [] : keeperRecords(call.method, pool, outcome, this.#poolsContract, nowMs);
    if (outcome !== null && keeperCallProgressed(call.method, pool, outcome, this.#poolsContract)) {
      this.#backoff.delete(pool.id);
      await this.#append(records);
      return;
    }
    const backoff = this.#recordFailure(pool.id, nowMs);
    if (backoff.failures === 1) await this.#append(records);
    const waitSeconds = (backoff.retryAtMs - nowMs) / 1000;
    this.#log(`keeper: ${call.method} on pool ${pool.id} ${failureText(result)}; next try in ${waitSeconds} s`);
  }

  /** Counts one more failed call in a row for the pool and sets when it may be called again. */
  #recordFailure(poolId: number, nowMs: number): Backoff {
    const failures = (this.#backoff.get(poolId)?.failures ?? 0) + 1;
    const waitMs = Math.min(FIRST_BACKOFF_MS * 2 ** (failures - 1), MAX_BACKOFF_MS);
    const backoff = { failures, retryAtMs: nowMs + waitMs };
    this.#backoff.set(poolId, backoff);
    return backoff;
  }

  /** Appends records to the feed. A failed append is logged and the rest still go: the feed never stops the keeper. */
  async #append(records: ActivityRecord[]): Promise<void> {
    for (const record of records) {
      try {
        await this.#activity.append(record);
      } catch (error) {
        this.#log(`keeper: appending a ${record.kind} record for pool ${record.poolId} failed: ${errorMessage(error)}`);
      }
    }
  }
}
```

- [ ] **Step 4: Run the tests and the typecheck**

Run: `pnpm --filter @quorum-on-near/gateway exec vitest run test/keeper.test.ts`

Expected: PASS, 43 tests (`test/keeper.test.ts` 43).

Run: `pnpm --filter @quorum-on-near/gateway typecheck`

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/keeper.ts apps/gateway/test/keeper.test.ts
git commit -m "settle and refund served pools from the keeper"
```


---

### Task 14: The app and the process

The routes of spec section 6.1, plus `GET /config.json` for the live page. `POST /rpc` exists only when the pass-through is on, and forwards only `call_function` queries on the pools contract and the token, with a 16 KiB body limit. The live page's folder is served at `/` when it exists, never a path with a segment that starts with a dot; the live page itself comes from a later plan. `main.ts` wires the real chain, relayer, credentials, feed, app and keeper, and refuses to start unless the RPC serves the configured network's chain and the pools contract was initialised with the configured token.

**Files:**
- Create: `apps/gateway/src/app.ts`, `apps/gateway/src/main.ts`
- Test: `apps/gateway/test/app.test.ts`

**Interfaces:**
- Consumes: every module of Tasks 6 to 13.
- Produces: `createApp(deps: Deps, options?: {fetch?: typeof fetch}): Hono`; the `start` script (`pnpm --filter @quorum-on-near/gateway start`).

- [ ] **Step 1: Write the failing test**

`apps/gateway/test/app.test.ts`:

```typescript
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  PAYMENT_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PROOF_HEADER,
  buildOffer,
  buildPaymentHeader,
  buildRedeemProofHeader,
  decodeHeader,
  maxBlockHeightFor,
  paymentRequired,
  type ExpectedOffer,
} from '@quorum-on-near/protocol';
import { KeyPair } from 'near-api-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActivityRecord } from '../src/activity.ts';
import { createApp } from '../src/app.ts';
import type { GatewayConfig } from '../src/config.ts';
import type { Deps } from '../src/deps.ts';
import { offerContext } from '../src/handle-offer.ts';
import { NOW_MS, POOLS, PROVIDER, TERMS, TOKEN, commitOutcome, poolView, testConfig, type FakeChain } from './fake-chain.ts';
import { testDeps } from './handler-deps.ts';

const BUYER = 'buyer.testnet';
const POOL_ID = 7;
const TX_HASH = 'RelayTx111';
const DEADLINE_MS = 1_800_000_000_000;
/**
 * The buyer's own configuration, the network and contracts it pays on, and its request: 2 seats of
 * pool 7, for at most their price at 180.
 */
const BUYER_CONFIG: ExpectedOffer = {
  network: 'near:testnet',
  token: TOKEN,
  poolsContract: POOLS,
  poolId: POOL_ID,
  maxSeats: 2,
  maxAmount: 360n,
};

/** Deps over a FakeChain holding pool 7, and the app over them. */
async function setup(config: Partial<GatewayConfig> = {}, options: { fetch?: typeof fetch } = {}) {
  const deps = await testDeps({ config: testConfig(config) });
  deps.fake.setPool(poolView({ id: POOL_ID }));
  return { deps, fake: deps.fake, app: createApp(deps, options) };
}

/** A buyer with a full-access key (nonce 10), a balance and 2 committed seats in pool 7. */
function addBuyer(fake: FakeChain): KeyPair {
  const keyPair = KeyPair.fromRandom('ed25519');
  fake.setKey(BUYER, keyPair.getPublicKey().toString(), { nonce: 10n, fullAccess: true });
  fake.balances.set(BUYER, 1_000_000n);
  fake.setBuyer(POOL_ID, BUYER, { seats: 2, state: 'committed' });
  return keyPair;
}

/** The buyer's payment for 2 seats of pool 7 as it stands. */
function payment(deps: Deps & { fake: FakeChain }, keyPair: KeyPair): Promise<string> {
  const { config, fake } = deps;
  return buildPaymentHeader({
    keyPair,
    senderId: BUYER,
    nonce: 11n,
    maxBlockHeight: maxBlockHeightFor(fake.block.height, config.maxTimeoutSeconds, config.blockTimeMs),
    offer: buildOffer(poolView({ id: POOL_ID }), 2, offerContext(config)),
    expected: BUYER_CONFIG,
  });
}

/** The buyer's redemption proof for pool 7. */
function proof(deps: Deps, keyPair: KeyPair): Promise<string> {
  const recipient = new URL(deps.config.publicUrl).host;
  return buildRedeemProofHeader({ keyPair, accountId: BUYER, poolId: POOL_ID, recipient, nowMs: NOW_MS });
}

/** A relayed commit of 2 seats that leaves the pool open. */
function queueCommit(fake: FakeChain): void {
  fake.relayResults.push({
    kind: 'executed',
    outcome: commitOutcome({ txHash: TX_HASH, buyer: BUYER, poolId: POOL_ID, seats: 2, seatPrice: 180n, taken: 150, target: 192 }),
  });
}

async function answer(response: Response | Promise<Response>): Promise<{ status: number; body: unknown }> {
  const res = await response;
  return { status: res.status, body: await res.json() };
}

function activityRecord(overrides: Partial<ActivityRecord> = {}): ActivityRecord {
  return {
    at: NOW_MS,
    poolId: POOL_ID,
    kind: 'commit',
    account: BUYER,
    seats: 2,
    amount: '360',
    txHash: TX_HASH,
    ok: true,
    ...overrides,
  };
}

/** A JSON-RPC `call_function` view of `get_pool` on the pools contract, with changes. */
function viewCall(changes: Record<string, unknown> = {}, params: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id: 'page',
    method: 'query',
    params: {
      request_type: 'call_function',
      account_id: POOLS,
      method_name: 'get_pool',
      args_base64: Buffer.from(JSON.stringify({ pool_id: POOL_ID })).toString('base64'),
      finality: 'final',
      ...params,
    },
    ...changes,
  };
}

const RPC_RESULT = { jsonrpc: '2.0', id: 'page', result: { result: [123], logs: [], block_height: 1000, block_hash: 'Hash1' } };

/** An upstream RPC that answers `body` with `status`. */
function upstream(body: unknown = RPC_RESULT, status = 200) {
  return vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
}

/** The app with the RPC pass-through on, over `fetch`. */
async function passthrough(fetch: typeof globalThis.fetch) {
  return setup({ rpcPassthrough: true }, { fetch });
}

function postRpc(app: Awaited<ReturnType<typeof setup>>['app'], body: unknown): Response | Promise<Response> {
  return app.request('/rpc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

/** A temporary folder holding the live page's files, by path within it. */
async function webFolder(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'quorum-web-'));
  for (const [name, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, name)), { recursive: true });
    await writeFile(join(dir, name), text);
  }
  return dir;
}

const INDEX_HTML = '<!doctype html><title>Quorum</title>\n';
const APP_JS = 'export const ready = true;\n';

describe('createApp', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('GET /pools', () => {
    it('lists the open pools of the configured provider', async () => {
      const { fake, app } = await setup();
      fake.setPool(poolView({ id: 8, seller: 'other-seller.testnet' }));
      fake.setPool(poolView({ id: 9, status: 'filled', taken: 192 }));
      expect(await answer(app.request('/pools'))).toEqual({
        status: 200,
        body: [
          {
            id: POOL_ID,
            terms: TERMS,
            seat_price: '180',
            target: 192,
            taken: 148,
            deadline_ms: DEADLINE_MS,
            bonus: '1728',
            min_bonus_per_seat: '9',
          },
        ],
      });
    });

    it('answers 503 chain_unavailable when the pools cannot be read', async () => {
      const { fake, app } = await setup();
      vi.spyOn(fake, 'listPools').mockRejectedValue(new Error('RPC down'));
      expect(await answer(app.request('/pools'))).toEqual({ status: 503, body: { error: 'chain_unavailable' } });
    });
  });

  describe('GET /pools/:id/access', () => {
    it('answers the 402 offer for the requested seats when there is no header', async () => {
      const { deps, app } = await setup();
      const offer = buildOffer(poolView({ id: POOL_ID }), 2, offerContext(deps.config));
      expect(await answer(app.request(`/pools/${POOL_ID}/access?seats=2`))).toEqual({
        status: 402,
        body: paymentRequired([offer]),
      });
    });

    it('relays a payment sent in X-PAYMENT', async () => {
      const { deps, fake, app } = await setup();
      const keyPair = addBuyer(fake);
      queueCommit(fake);
      const headers = { [PAYMENT_HEADER]: await payment(deps, keyPair) };
      expect(await answer(app.request(`/pools/${POOL_ID}/access?seats=2`, { headers }))).toEqual({
        status: 202,
        body: {
          status: 'pending',
          receipt: { poolId: POOL_ID, buyer: BUYER, seats: 2, txHash: TX_HASH },
          pool: { taken: 150, target: 192, deadlineMs: DEADLINE_MS },
        },
      });
    });

    it("passes the handler's reply headers through", async () => {
      const { deps, fake, app } = await setup();
      const keyPair = addBuyer(fake);
      queueCommit(fake);
      const headers = { [PAYMENT_HEADER]: await payment(deps, keyPair) };
      const res = await app.request(`/pools/${POOL_ID}/access?seats=2`, { headers });
      expect(decodeHeader(res.headers.get(PAYMENT_RESPONSE_HEADER) ?? '')).toEqual({
        success: true,
        transaction: TX_HASH,
        network: 'near:testnet',
        payer: BUYER,
      });
    });

    it('redeems a proof sent in X-QUORUM-PROOF', async () => {
      const { deps, fake, app } = await setup();
      const keyPair = addBuyer(fake);
      const headers = { [PROOF_HEADER]: await proof(deps, keyPair) };
      expect(await answer(app.request(`/pools/${POOL_ID}/access`, { headers }))).toEqual({
        status: 202,
        body: { status: 'pending', seats: 2, taken: 148, target: 192, deadlineMs: DEADLINE_MS },
      });
    });

    it('treats a request carrying both headers as a payment', async () => {
      const { deps, fake, app } = await setup();
      const keyPair = addBuyer(fake);
      const headers = { [PAYMENT_HEADER]: 'not-a-payment', [PROOF_HEADER]: await proof(deps, keyPair) };
      const { status, body } = await answer(app.request(`/pools/${POOL_ID}/access`, { headers }));
      expect({ status, error: (body as { error: unknown }).error }).toEqual({ status: 402, error: 'invalid_payload' });
    });

    it.each(['abc', '-1', '07', '1.5', '1e3', '9007199254740993'])(
      'answers 404 unknown_pool without reading the chain for the pool id %s',
      async (id) => {
        const { fake, app } = await setup();
        expect(await answer(app.request(`/pools/${id}/access`))).toEqual({ status: 404, body: { error: 'unknown_pool' } });
        expect(fake.reads.size).toBe(0);
      },
    );
  });

  describe('GET /activity', () => {
    it('lists every record without a pool parameter', async () => {
      const { deps, app } = await setup();
      const records = [activityRecord(), activityRecord({ poolId: 8, txHash: 'OtherTx' })];
      for (const record of records) await deps.activity.append(record);
      expect(await answer(app.request('/activity'))).toEqual({ status: 200, body: records });
    });

    it("lists only one pool's records with ?pool", async () => {
      const { deps, app } = await setup();
      await deps.activity.append(activityRecord());
      await deps.activity.append(activityRecord({ poolId: 8, txHash: 'OtherTx' }));
      expect(await answer(app.request(`/activity?pool=${POOL_ID}`))).toEqual({ status: 200, body: [activityRecord()] });
    });

    it.each(['', 'x', '-1', '07'])('answers 400 invalid_pool for ?pool=%s', async (pool) => {
      const { app } = await setup();
      expect(await answer(app.request(`/activity?pool=${pool}`))).toEqual({ status: 400, body: { error: 'invalid_pool' } });
    });
  });

  describe('GET /.well-known/jwks.json', () => {
    it("answers the credential issuer's public keys", async () => {
      const { deps, app } = await setup();
      expect(await answer(app.request('/.well-known/jwks.json'))).toEqual({ status: 200, body: deps.credentials.jwks() });
    });
  });

  describe('GET /config.json', () => {
    const expected = {
      network: 'near:testnet',
      poolsContract: POOLS,
      token: TOKEN,
      provider: PROVIDER,
      explorerTxUrl: 'https://testnet.nearblocks.io/txns/',
    };

    it('points the page at the configured RPC when the pass-through is off', async () => {
      const { app } = await setup();
      expect(await answer(app.request('/config.json'))).toEqual({
        status: 200,
        body: { ...expected, rpcUrl: 'http://rpc.invalid' },
      });
    });

    it('points the page at /rpc when the pass-through is on', async () => {
      const { app } = await setup({ rpcPassthrough: true });
      expect(await answer(app.request('/config.json'))).toEqual({ status: 200, body: { ...expected, rpcUrl: '/rpc' } });
    });
  });

  describe('POST /rpc', () => {
    it('is not served when the pass-through is off', async () => {
      const fetch = upstream();
      const { app } = await setup({}, { fetch });
      expect(await answer(postRpc(app, viewCall()))).toEqual({ status: 404, body: { error: 'not_found' } });
      expect(fetch).not.toHaveBeenCalled();
    });

    it('forwards a view call on the pools contract to the RPC with the same body', async () => {
      const fetch = upstream();
      const { app } = await passthrough(fetch);
      await postRpc(app, viewCall());
      expect(fetch).toHaveBeenCalledExactlyOnceWith('http://rpc.invalid', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(viewCall()),
      });
    });

    it("answers the RPC's JSON for a view call on the pools contract", async () => {
      const { app } = await passthrough(upstream());
      expect(await answer(postRpc(app, viewCall()))).toEqual({ status: 200, body: RPC_RESULT });
    });

    it('forwards a view call on the token', async () => {
      const fetch = upstream();
      const { app } = await passthrough(fetch);
      const call = viewCall({}, { account_id: TOKEN, method_name: 'ft_balance_of' });
      expect(await answer(postRpc(app, call))).toEqual({ status: 200, body: RPC_RESULT });
      expect(fetch.mock.calls[0]?.[1]?.body).toBe(JSON.stringify(call));
    });

    it('forwards a view call at a block id', async () => {
      const fetch = upstream();
      const { app } = await passthrough(fetch);
      const call = viewCall({}, { finality: undefined, block_id: 1000 });
      expect(await answer(postRpc(app, call))).toEqual({ status: 200, body: RPC_RESULT });
    });

    it("answers with the RPC's status", async () => {
      const error = { jsonrpc: '2.0', id: 'page', error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_BLOCK' } } };
      const { app } = await passthrough(upstream(error, 408));
      expect(await answer(postRpc(app, viewCall()))).toEqual({ status: 408, body: error });
    });

    it.each([
      ['another account', viewCall({}, { account_id: 'other.testnet' })],
      ['another request type', viewCall({}, { request_type: 'view_state', prefix_base64: '' })],
      ['another RPC method', viewCall({ method: 'send_tx' })],
      ['a JSON-RPC version other than 2.0', viewCall({ jsonrpc: '1.0' })],
      ['both finality and block_id', viewCall({}, { block_id: 1000 })],
      ['an unknown field', viewCall({}, { extra: true })],
      ['a batch', [viewCall()]],
      ['params given as an array', viewCall({ params: ['call/pools/get_pool', ''] })],
    ])('answers 403 not_allowed for %s', async (_name, body) => {
      const fetch = upstream();
      const { app } = await passthrough(fetch);
      expect(await answer(postRpc(app, body))).toEqual({ status: 403, body: { error: 'not_allowed' } });
      expect(fetch).not.toHaveBeenCalled();
    });

    it('answers 400 invalid_json for a body that is not JSON', async () => {
      const fetch = upstream();
      const { app } = await passthrough(fetch);
      expect(await answer(postRpc(app, '{"jsonrpc":'))).toEqual({ status: 400, body: { error: 'invalid_json' } });
      expect(fetch).not.toHaveBeenCalled();
    });

    it('answers 503 chain_unavailable when the RPC cannot be reached', async () => {
      const fetch = vi.fn<typeof globalThis.fetch>(async () => {
        throw new TypeError('fetch failed');
      });
      const { app } = await passthrough(fetch);
      expect(await answer(postRpc(app, viewCall()))).toEqual({ status: 503, body: { error: 'chain_unavailable' } });
    });
  });

  describe('static files', () => {
    it('serves index.html at /', async () => {
      const webDir = await webFolder({ 'index.html': INDEX_HTML });
      const { app } = await setup({ webDir });
      const res = await app.request('/');
      expect({ status: res.status, type: res.headers.get('Content-Type'), text: await res.text() }).toEqual({
        status: 200,
        type: 'text/html; charset=utf-8',
        text: INDEX_HTML,
      });
    });

    it('serves a JavaScript module as JavaScript', async () => {
      const webDir = await webFolder({ 'index.html': INDEX_HTML, 'app.js': APP_JS });
      const { app } = await setup({ webDir });
      const res = await app.request('/app.js');
      expect({ status: res.status, type: res.headers.get('Content-Type'), text: await res.text() }).toEqual({
        status: 200,
        type: 'text/javascript; charset=utf-8',
        text: APP_JS,
      });
    });

    it('answers 404 not_found for a file the folder does not have', async () => {
      const webDir = await webFolder({ 'index.html': INDEX_HTML });
      const { app } = await setup({ webDir });
      expect(await answer(app.request('/missing.js'))).toEqual({ status: 404, body: { error: 'not_found' } });
    });

    it('answers the API before a file with the same path', async () => {
      const webDir = await webFolder({ 'config.json': '{"rpcUrl":"elsewhere"}' });
      const { app } = await setup({ webDir });
      const { body } = await answer(app.request('/config.json'));
      expect((body as { rpcUrl: unknown }).rpcUrl).toBe('http://rpc.invalid');
    });

    it('serves nothing when webDir is null', async () => {
      const { app } = await setup({ webDir: null });
      expect(await answer(app.request('/'))).toEqual({ status: 404, body: { error: 'not_found' } });
    });
  });

  describe('POST /rpc limits', () => {
    const MAX_BODY = 16 * 1024;

    /** A view call on the pools contract, padded with spaces to `size` bytes of JSON. */
    function padded(size: number): string {
      const json = JSON.stringify(viewCall());
      return json + ' '.repeat(size - json.length);
    }

    it('reads a body of exactly 16 KiB', async () => {
      const { app } = await passthrough(upstream());
      expect(await answer(postRpc(app, padded(MAX_BODY)))).toEqual({ status: 200, body: RPC_RESULT });
    });

    it('answers 413 body_too_large for a longer body, and forwards nothing', async () => {
      const fetch = upstream();
      const { app } = await passthrough(fetch);
      expect(await answer(postRpc(app, padded(MAX_BODY + 1)))).toEqual({ status: 413, body: { error: 'body_too_large' } });
      expect(fetch).not.toHaveBeenCalled();
    });

    it('answers 413 body_too_large for a longer declared Content-Length', async () => {
      const fetch = upstream();
      const { app } = await passthrough(fetch);
      const body = padded(MAX_BODY + 1);
      const res = app.request('/rpc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': String(body.length) },
        body,
      });
      expect(await answer(res)).toEqual({ status: 413, body: { error: 'body_too_large' } });
      expect(fetch).not.toHaveBeenCalled();
    });

    it('forwards the largest arguments a view of either contract takes', async () => {
      // get_buyer with the largest u64 pool id and a 64-character account id: 112 bytes of JSON.
      const args = `{"pool_id":18446744073709551615,"account_id":"${'a'.repeat(64)}"}`;
      const call = viewCall({}, { method_name: 'get_buyer', args_base64: Buffer.from(args).toString('base64') });
      const { app } = await passthrough(upstream());
      expect(await answer(postRpc(app, call))).toEqual({ status: 200, body: RPC_RESULT });
    });

    it('forwards args_base64 of 1024 characters', async () => {
      const { app } = await passthrough(upstream());
      const call = viewCall({}, { args_base64: 'A'.repeat(1024) });
      expect(await answer(postRpc(app, call))).toEqual({ status: 200, body: RPC_RESULT });
    });

    it('answers 403 not_allowed for longer args_base64', async () => {
      const fetch = upstream();
      const { app } = await passthrough(fetch);
      const call = viewCall({}, { args_base64: 'A'.repeat(1028) });
      expect(await answer(postRpc(app, call))).toEqual({ status: 403, body: { error: 'not_allowed' } });
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  describe('static files whose names start with a dot', () => {
    const FILES = {
      'index.html': INDEX_HTML,
      '.env': 'QUORUM_PARENT_ACCOUNT=parent.testnet\n',
      '.git/config': '[core]\n',
      'sub/.hidden': 'hidden\n',
      'sub/page.js': APP_JS,
      '.well-known/other.json': '{}',
    };

    it.each(['/.env', '/%2Eenv', '/.git/config', '/sub/.hidden', '/.well-known/other.json'])(
      'answers 404 not_found for %s, which the folder holds',
      async (path) => {
        const { app } = await setup({ webDir: await webFolder(FILES) });
        expect(await answer(app.request(path))).toEqual({ status: 404, body: { error: 'not_found' } });
      },
    );

    it('still serves the other files, in subfolders too', async () => {
      const { app } = await setup({ webDir: await webFolder(FILES) });
      const res = await app.request('/sub/page.js');
      expect({ status: res.status, text: await res.text() }).toEqual({ status: 200, text: APP_JS });
    });

    it('still answers /.well-known/jwks.json', async () => {
      const { deps, app } = await setup({ webDir: await webFolder(FILES) });
      expect(await answer(app.request('/.well-known/jwks.json'))).toEqual({ status: 200, body: deps.credentials.jwks() });
    });
  });

  describe('errors', () => {
    it('answers 404 not_found for an unknown route', async () => {
      const { app } = await setup();
      expect(await answer(app.request('/nope'))).toEqual({ status: 404, body: { error: 'not_found' } });
    });

    it('answers 500 internal_error when a route throws', async () => {
      const { deps, app } = await setup();
      vi.spyOn(deps.credentials, 'jwks').mockImplementation(() => {
        throw new Error('broken key');
      });
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(await answer(app.request('/.well-known/jwks.json'))).toEqual({ status: 500, body: { error: 'internal_error' } });
      expect(logged).toHaveBeenCalledOnce();
    });
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @quorum-on-near/gateway exec vitest run test/app.test.ts`

Expected: FAIL. vitest cannot load `../src/app.ts`, which does not exist yet.

- [ ] **Step 3: Write the implementation**

`apps/gateway/src/app.ts`:

```typescript
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
/**
 * The longest `args_base64` forwarded. The largest arguments a view of either contract takes,
 * `get_buyer`'s u64 pool id and 64-character account id, are 152 characters of base64.
 */
const MAX_ARGS_BASE64 = 1024;
/** A path with a segment that starts with a dot, such as `/.env` or `/.git/config`. */
const DOT_SEGMENT = /\/\./;

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
function isAllowedViewCall(body: unknown, accounts: string[]): boolean {
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
 * - `POST /rpc` (only when `config.rpcPassthrough`), with a body of at most 16 KiB
 * - the live page's static files at `/` (only when `config.webDir` is set), except any whose path has
 *   a segment that starts with a dot
 *
 * Every answer is JSON except the static files. `options.fetch` replaces the global fetch for the
 * RPC pass-through.
 */
export function createApp(deps: Deps, options: { fetch?: typeof fetch } = {}): Hono {
  const { config } = deps;
  const app = new Hono();

  app.get('/pools', async (c) => {
    try {
      return c.json(await openPoolListings(deps.chain, config.provider));
    } catch {
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
        });
        return c.json(await upstream.json(), upstream.status as ContentfulStatusCode);
      } catch {
        return c.json({ error: 'chain_unavailable' }, 503);
      }
    });
  }

  // After the routes, so a file never shadows one. A relative root resolves against the current folder.
  // Nothing whose name starts with a dot is served, such as a .env file that holds keys.
  if (config.webDir !== null) {
    const files = serveStatic({ root: config.webDir });
    app.use('*', (c, next) => (DOT_SEGMENT.test(c.req.path) ? next() : files(c, next)));
  }

  app.notFound((c) => c.json({ error: 'not_found' }, 404));
  app.onError((error, c) => {
    console.error(error);
    return c.json({ error: 'internal_error' }, 500);
  });
  return app;
}
```

`apps/gateway/src/main.ts`:

```typescript
// Starts the gateway: `node --env-file-if-exists=.env src/main.ts` (see `.env.example`).
import { statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { REDEEM_MAX_AGE_MS, REDEEM_MAX_SKEW_MS } from '@quorum-on-near/protocol';
import { JsonRpcProvider, KeyPair, type KeyPairString } from 'near-api-js';
import { ActivityLog } from './activity.ts';
import { createApp } from './app.ts';
import { checkChainId, ConfigError, loadConfig, type GatewayConfig } from './config.ts';
import { createCredentialIssuer } from './credential.ts';
import type { Deps } from './deps.ts';
import { InFlight, NonceCache } from './guards.ts';
import { Keeper } from './keeper.ts';
import { KeyPool, RpcRelayer } from './relayer.ts';
import { RpcChain } from './rpc-chain.ts';

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readConfig(): GatewayConfig {
  try {
    return loadConfig(process.env);
  } catch (error) {
    if (error instanceof ConfigError) fail(`invalid configuration:\n${error.message}`);
    throw error;
  }
}

/** The live page's folder as an absolute path, or null if it is not set or not a folder. */
function liveFolder(webDir: string | null): string | null {
  if (webDir === null) return null;
  const dir = resolve(process.cwd(), webDir);
  if (statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return dir;
  console.warn(`no live page: ${dir} is not a folder`);
  return null;
}

const config = readConfig();
// Views change nothing, so they keep near-api-js's default retries.
const viewProvider = new JsonRpcProvider({ url: config.rpcUrl });
const chain = new RpcChain({ provider: viewProvider, poolsContract: config.poolsContract, token: config.token });

// QUORUM_NETWORK only labels offers: the RPC decides which chain the gateway pays on.
let chainId: string;
try {
  chainId = (await viewProvider.viewNodeStatus()).chain_id;
} catch (error) {
  fail(`cannot read the chain id from ${config.rpcUrl}: ${errorMessage(error)}`);
}
const wrongChain = checkChainId(config.network, chainId);
if (wrongChain !== null) fail(wrongChain);

let token: string;
try {
  token = await chain.getToken();
} catch (error) {
  fail(`cannot read the token of ${config.poolsContract}: ${errorMessage(error)}`);
}
if (token !== config.token) {
  fail(`${config.poolsContract} holds ${token}, but QUORUM_TOKEN_ACCOUNT is ${config.token}`);
}

// near-api-js counts attempts: `retries: 1` posts each request once. A transaction is never posted
// twice, and each lookup by hash is a single post, so the relayer checks its deadline between posts.
const relayerProvider = new JsonRpcProvider({ url: config.rpcUrl }, { retries: 1 });
const writer = new RpcRelayer({
  relayer: config.relayer,
  poolsContract: config.poolsContract,
  keys: new KeyPool(config.relayerKeys.map((key) => KeyPair.fromString(key as KeyPairString))),
  readProvider: relayerProvider,
  sendProvider: relayerProvider,
  // An accepted delegate expires at most about maxTimeoutSeconds ahead; twice that bounds the lookup
  // when blocks slow down or the final height cannot be read.
  delegateLookupMs: 2 * config.maxTimeoutSeconds * 1000,
});
const activity = await ActivityLog.open(join(config.dataDir, 'activity.jsonl'));
const deps: Deps = {
  config: { ...config, webDir: liveFolder(config.webDir) },
  chain,
  writer,
  credentials: await createCredentialIssuer({ jwk: config.credentialJwk, issuer: config.publicUrl }),
  activity,
  inFlight: new InFlight(),
  // A proof signed up to REDEEM_MAX_SKEW_MS ahead stays valid REDEEM_MAX_AGE_MS after its signing time.
  proofNonces: new NonceCache(REDEEM_MAX_AGE_MS + REDEEM_MAX_SKEW_MS),
  now: Date.now,
};

const server = serve({ fetch: createApp(deps).fetch, port: config.port }, (info) => {
  console.log(`gateway listening on http://localhost:${info.port} (public URL ${config.publicUrl})`);
});
server.once('error', (error) => fail(`cannot listen on port ${config.port}: ${error.message}`));

const keeper = new Keeper({
  chain,
  writer,
  activity,
  provider: config.provider,
  poolsContract: config.poolsContract,
  refundLimit: config.refundLimit,
  settleGas: config.settleGas,
  refundGas: config.refundGas,
  now: Date.now,
});
keeper.start(config.keeperIntervalMs);

/** Stops taking requests and keeper ticks; the process exits once the running ones finish. */
function shutdown(signal: NodeJS.Signals): void {
  // A second signal ends the process at once.
  process.off('SIGINT', shutdown);
  process.off('SIGTERM', shutdown);
  console.log(`${signal}: shutting down`);
  server.close();
  void keeper.stop();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
```

- [ ] **Step 4: Run the tests and the typecheck**

Run: `pnpm --filter @quorum-on-near/gateway exec vitest run test/app.test.ts`

Expected: PASS, 58 tests (`test/app.test.ts` 58).

Run: `pnpm --filter @quorum-on-near/gateway typecheck`

Expected: no errors.

- [ ] **Step 5: Run the whole workspace**

```bash
pnpm typecheck
pnpm test
```

Expected: no type errors; PASS, 9 protocol test files and 13 gateway test files (the sandbox suite is not part of `pnpm test`).

- [ ] **Step 6: Check that the gateway refuses to start without its configuration**

With no `apps/gateway/.env` and no `QUORUM_*` variables set, run: `pnpm --filter @quorum-on-near/gateway start`

Expected: the process exits with code 1 after printing

```text
invalid configuration:
QUORUM_PARENT_ACCOUNT is required
QUORUM_RELAYER_KEYS is required
QUORUM_CREDENTIAL_JWK is required
```

Node may first print `.env not found. Continuing without it.`. Running it against testnet needs the accounts and keys that the swarm plan's setup creates.

- [ ] **Step 7: Commit**

```bash
git add apps/gateway/src/app.ts apps/gateway/src/main.ts apps/gateway/test/app.test.ts
git commit -m "serve the gateway routes and wire the process"
```


---

### Task 15: The gateway against a local sandbox

**Gate:** run this task once the contracts plan's branch has merged into `main`, on Linux, macOS on
Apple silicon or WSL2 (the repository on the WSL filesystem), with Rust and `cargo near` installed as
the contracts plan's Task 0 describes, and Node as in Task 0. On Linux and WSL2 the sandbox node
needs glibc 2.38 or later, so Ubuntu 24.04 or later (`ldd --version` prints the glibc version).
`near-sandbox` ships no Windows binary, so on Windows the suite reports itself skipped.

The test drives the gateway's real `RpcChain`, `RpcRelayer` and HTTP app against a sandbox with the
contracts deployed. It records what the stubbed tests cannot: which account is debited the
1 yoctoNEAR deposit of a relayed payment (spec section 11), the gas a commit burns and that a commit
paid at `minGas` completes (spec section 6.2), the shape of a real relayed outcome, and a redemption
and a startup chain check against a real chain.

**Files:**
- Create: `apps/gateway/test/sandbox/world.ts`, `apps/gateway/test/sandbox/relayed-commit.test.ts`,
  `apps/gateway/test/fixtures/relayed-commit.json` (captured), `apps/gateway/test/outcome.captured.test.ts`

**Interfaces:**
- Consumes: `RpcChain` (Task 7), `KeyPool`, `RpcRelayer` (Task 8), `ActivityLog`, `InFlight`,
  `NonceCache` (Task 9), `createCredentialIssuer`, `checkChainId` (Task 6), `createApp` (Task 14),
  `Keeper` (Task 13), `toTxOutcome`, `readCommit` (Task 7); `buildPaymentHeader` (with the buyer's
  `expected`), `buildRedeemProofHeader`, `maxBlockHeightFor`, `decodeHeader`, `PROOF_HEADER`,
  `PAYMENT_RESPONSE_HEADER`, `type PaymentResponse` from the protocol package; the contracts' wasm
  files.
- Produces: `startWorld(wasm)`, `wasmFromEnv(): WasmFiles` (throws when either wasm variable is
  unset), `nearBalance(world, accountId)`, `finalOutcome(world, txHash, signerId)` (test support);
  the captured fixture.

- [ ] **Step 1: Bring the branch up to date with `main`**

```bash
git fetch origin
git rebase origin/main
ls contracts/pools/Cargo.toml contracts/mock-usd/Cargo.toml
```

Expected: the rebase completes with no conflict (the two plans touch different files and different
spec sections), and both manifests exist. If they do not, the contracts plan has not merged: stop.

- [ ] **Step 2: Build the two contracts and point the test at their wasm files**

```bash
cargo near build non-reproducible-wasm --manifest-path contracts/mock-usd/Cargo.toml
cargo near build non-reproducible-wasm --manifest-path contracts/pools/Cargo.toml
find target/near -name '*.wasm'
```

Expected: `find` lists `mock_usd.wasm` and `quorum_pools.wasm` (the folder they are in depends on
cargo-near's version). Export their absolute paths:

```bash
export QUORUM_MOCK_USD_WASM="$(realpath "$(find target/near -name 'mock_usd.wasm' | head -n 1)")"
export QUORUM_POOLS_WASM="$(realpath "$(find target/near -name 'quorum_pools.wasm' | head -n 1)")"
```

- [ ] **Step 3: Write the sandbox world**

`apps/gateway/test/sandbox/world.ts`:

```typescript
// A local NEAR sandbox with the mock token and the pools contract deployed, for the sandbox tests.
import { readFile } from 'node:fs/promises';
import {
  Account,
  JsonRpcProvider,
  KeyPair,
  KeyPairSigner,
  actions,
  nearToYocto,
  teraToGas,
  type Action,
} from 'near-api-js';
import { DEFAULT_ACCOUNT_ID, DEFAULT_PRIVATE_KEY, Sandbox } from 'near-sandbox';

/** The two contracts' wasm files, as `cargo near build` writes them. */
export interface WasmFiles {
  pools: string;
  mockUsd: string;
}

/** A sandbox account, the key that controls it, and an Account that signs with that key. */
export interface Actor {
  id: string;
  keyPair: KeyPair;
  account: Account;
}

export interface World {
  sandbox: Sandbox;
  provider: JsonRpcProvider;
  token: Actor;
  pools: Actor;
  relay: Actor;
  /** The relayer's two full-access keys, `relay.keyPair` first. */
  relayKeys: KeyPair[];
  seller: Actor;
  buyer1: Actor;
  buyer2: Actor;
}

/** The mock token each of the seller and the buyers starts with, in base units (1 mUSD). */
const MINTED = 1_000_000n;

const INIT_GAS = teraToGas(30);
const TOKEN_CALL_GAS = teraToGas(20);

/** The wasm files named by QUORUM_POOLS_WASM and QUORUM_MOCK_USD_WASM. Throws, naming both, unless both are set. */
export function wasmFromEnv(): WasmFiles {
  const { QUORUM_POOLS_WASM: pools, QUORUM_MOCK_USD_WASM: mockUsd } = process.env;
  if (!pools || !mockUsd) {
    throw new Error(
      'set QUORUM_POOLS_WASM and QUORUM_MOCK_USD_WASM to the absolute paths of the pools and mock-usd wasm files that `cargo near build` writes',
    );
  }
  return { pools, mockUsd };
}

/**
 * Starts a sandbox and creates `musd`, `pools`, `relay`, `seller`, `buyer1` and `buyer2` under its
 * root account, each with a fresh key (two for `relay`). Deploys the mock token to `musd` and the
 * pools contract to `pools`, each initialised in its deploy transaction, registers `pools`, the
 * seller and the buyers on the token, and mints MINTED to the seller and each buyer. Resolves once
 * all of it is final. Tears the sandbox down if a step fails.
 */
export async function startWorld(wasm: WasmFiles): Promise<World> {
  const sandbox = await Sandbox.start({});
  try {
    const provider = new JsonRpcProvider({ url: sandbox.rpcUrl });
    const root = new Account(DEFAULT_ACCOUNT_ID, provider, DEFAULT_PRIVATE_KEY);
    const create = (name: string, near: number, keys?: KeyPair[]): Promise<Actor> =>
      createActor(root, name, nearToYocto(near), keys);

    const token = await create('musd', 20);
    const pools = await create('pools', 20);
    const relayKeys = [KeyPair.fromRandom('ed25519'), KeyPair.fromRandom('ed25519')];
    const relay = await create('relay', 10, relayKeys);
    const seller = await create('seller', 5);
    const buyer1 = await create('buyer1', 5);
    const buyer2 = await create('buyer2', 5);

    await deploy(token, wasm.mockUsd, {});
    await deploy(pools, wasm.pools, { token: token.id });

    const bounds = await provider.callFunction<{ min: string }>({
      contractId: token.id,
      method: 'storage_balance_bounds',
      args: {},
    });
    if (bounds === undefined) throw new Error(`${token.id} returned no storage_balance_bounds`);
    const register = (actor: Actor): Action =>
      actions.functionCall(
        'storage_deposit',
        { account_id: actor.id, registration_only: true },
        TOKEN_CALL_GAS,
        BigInt(bounds.min),
      );
    const mint = (actor: Actor): Action =>
      actions.functionCall('mint', { account_id: actor.id, amount: MINTED.toString() }, TOKEN_CALL_GAS, 0n);
    // The last setup transaction: once it is final, so is everything before it.
    await root.signAndSendTransaction({
      receiverId: token.id,
      actions: [...[pools, seller, buyer1, buyer2].map(register), ...[seller, buyer1, buyer2].map(mint)],
      waitUntil: 'FINAL',
    });

    return { sandbox, provider, token, pools, relay, relayKeys, seller, buyer1, buyer2 };
  } catch (error) {
    await sandbox.tearDown();
    throw error;
  }
}

/** The account's NEAR balance at the latest final block, in yoctoNEAR. */
export async function nearBalance(world: World, accountId: string): Promise<bigint> {
  const view = await world.provider.viewAccount({ accountId, blockQuery: { finality: 'final' } });
  return view.amount;
}

/**
 * Waits until a transaction signed by `signerId`, and every receipt it caused (refunds included), is
 * final. Resolves with the RPC's raw response.
 */
export function finalOutcome(world: World, txHash: string, signerId: string): Promise<unknown> {
  return world.provider.viewTransactionStatus({ txHash, accountId: signerId, waitUntil: 'FINAL' });
}

/** Creates `<name>.<root>` holding `yocto`, with `keys` as its full-access keys. */
async function createActor(
  root: Account,
  name: string,
  yocto: bigint,
  keys: KeyPair[] = [KeyPair.fromRandom('ed25519')],
): Promise<Actor> {
  const [keyPair] = keys;
  if (keyPair === undefined) throw new Error(`${name} needs at least one key`);
  const id = `${name}.${root.accountId}`;
  await root.signAndSendTransaction({
    receiverId: id,
    actions: [
      actions.createAccount(),
      actions.transfer(yocto),
      ...keys.map((key) => actions.addFullAccessKey(key.getPublicKey())),
    ],
  });
  return { id, keyPair, account: new Account(id, root.provider, new KeyPairSigner(keyPair)) };
}

/** Deploys a wasm file to the contract's own account and calls `new(args)` in the same transaction. */
async function deploy(contract: Actor, wasmFile: string, args: Record<string, unknown>): Promise<void> {
  const code = await readFile(wasmFile);
  await contract.account.signAndSendTransaction({
    receiverId: contract.id,
    actions: [actions.deployContract(code), actions.functionCall('new', args, INIT_GAS, 0n)],
  });
}
```

- [ ] **Step 4: Write the sandbox test**

`apps/gateway/test/sandbox/relayed-commit.test.ts`:

```typescript
// The gateway against a local sandbox running the real contracts: an offer, two relayed payments
// that fill a pool (the second paid at the offer's minGas), a redemption, and the keeper's
// settlement. Needs Linux or macOS (near-sandbox ships no Windows binary, so on Windows the suite is
// skipped) and the wasm files from `cargo near build`, named by QUORUM_POOLS_WASM and
// QUORUM_MOCK_USD_WASM; without them the suite fails. The first run downloads the sandbox binary;
// `pnpm --filter @quorum-on-near/gateway exec near-sandbox --version` fetches it ahead. With
// QUORUM_CAPTURE_FIXTURE=1 it also writes the relayed commit's raw outcome to
// test/fixtures/relayed-commit.json.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PAYMENT_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PROOF_HEADER,
  REDEEM_MAX_AGE_MS,
  REDEEM_MAX_SKEW_MS,
  buildPaymentHeader,
  buildRedeemProofHeader,
  decodeHeader,
  maxBlockHeightFor,
  type Offer,
  type PaymentRequired,
  type PaymentResponse,
} from '@quorum-on-near/protocol';
import { createLocalJWKSet, jwtVerify } from 'jose';
import { JsonRpcProvider, KeyPair, teraToGas, type KeyPairString } from 'near-api-js';
import { DEFAULT_ACCOUNT_ID } from 'near-sandbox';
import { afterAll, assert, beforeAll, describe, expect, it } from 'vitest';
import { ActivityLog } from '../../src/activity.ts';
import { createApp } from '../../src/app.ts';
import type { TxOutcome } from '../../src/chain.ts';
import { checkChainId, loadConfig } from '../../src/config.ts';
import { createCredentialIssuer, generateCredentialJwk } from '../../src/credential.ts';
import type { Deps } from '../../src/deps.ts';
import { InFlight, NonceCache } from '../../src/guards.ts';
import { Keeper } from '../../src/keeper.ts';
import { toTxOutcome } from '../../src/outcome.ts';
import { KeyPool, RpcRelayer } from '../../src/relayer.ts';
import { RpcChain } from '../../src/rpc-chain.ts';
import { finalOutcome, nearBalance, startWorld, wasmFromEnv, type Actor, type World } from './world.ts';

const TIMEOUT_MS = 180_000;
/** The setup's limit: the first run downloads the sandbox binary. */
const SETUP_TIMEOUT_MS = 900_000;
const FIXTURE = new URL('../fixtures/relayed-commit.json', import.meta.url);

// The seller's pool is the contract's first, so its id is 0.
const POOL_ID = 0;
const SEAT_PRICE = 180n;
const TARGET = 3;
const BONUS = 1728n;
const MAX_SEATS_PER_BUYER = 2;
const DEADLINE_AFTER_MS = 10 * 60_000;
const TERMS = '1×GPU × 3 h; 1 seat = 1 GPU-hour; prices at 1/10,000 scale';
/** What the seller receives when the pool settles: every seat's price, and the bonus back. */
const PAYOUT = BigInt(TARGET) * SEAT_PRICE + BONUS;

/** The 202 body of a payment that took seats in a pool still open. */
interface Pending {
  status: 'pending';
  receipt: { poolId: number; buyer: string; seats: number; txHash: string };
  pool: { taken: number; target: number; deadlineMs: number };
}

/** The 200 body of a payment that filled the pool. */
interface Filled {
  status: 'filled';
  credential: string;
  poolId: number;
  seats: number;
  terms: string;
}

/** The gateway's dependencies as main.ts builds them, pointed at the sandbox, with the seller as provider. */
async function sandboxDeps(world: World, dataDir: string): Promise<Deps> {
  const config = loadConfig({
    QUORUM_NETWORK: 'near:sandbox',
    QUORUM_RPC_URL: world.sandbox.rpcUrl,
    QUORUM_PARENT_ACCOUNT: DEFAULT_ACCOUNT_ID,
    QUORUM_TOKEN_ACCOUNT: world.token.id,
    QUORUM_POOLS_ACCOUNT: world.pools.id,
    QUORUM_RELAYER_ACCOUNT: world.relay.id,
    QUORUM_PROVIDER_ACCOUNT: world.seller.id,
    QUORUM_RELAYER_KEYS: world.relayKeys.map((key) => key.toString()).join(','),
    QUORUM_CREDENTIAL_JWK: JSON.stringify(await generateCredentialJwk()),
    QUORUM_DATA_DIR: dataDir,
    QUORUM_WEB_DIR: '',
  });
  const { poolsContract } = config;
  const relayerProvider = new JsonRpcProvider({ url: config.rpcUrl }, { retries: 1 });
  return {
    config,
    chain: new RpcChain({ provider: new JsonRpcProvider({ url: config.rpcUrl }), poolsContract, token: config.token }),
    writer: new RpcRelayer({
      relayer: config.relayer,
      poolsContract,
      keys: new KeyPool(config.relayerKeys.map((key) => KeyPair.fromString(key as KeyPairString))),
      readProvider: relayerProvider,
      sendProvider: relayerProvider,
      delegateLookupMs: 2 * config.maxTimeoutSeconds * 1000,
    }),
    credentials: await createCredentialIssuer({ jwk: config.credentialJwk, issuer: config.publicUrl }),
    activity: await ActivityLog.open(join(config.dataDir, 'activity.jsonl')),
    inFlight: new InFlight(),
    proofNonces: new NonceCache(REDEEM_MAX_AGE_MS + REDEEM_MAX_SKEW_MS),
    now: Date.now,
  };
}

/**
 * The gas burnt by the commit itself: the receipts after the buyer's delegate receipt that ran on
 * `contracts` (ft_transfer_call, ft_on_transfer, ft_resolve_transfer). The relayer's transaction,
 * the delegate receipt and the gas refunds are left out.
 */
function commitGas(outcome: TxOutcome, buyer: string, contracts: string[]): bigint {
  const delegate = outcome.receipts.findIndex((receipt) => receipt.executorId === buyer);
  if (delegate === -1) throw new Error(`no receipt ran on ${buyer}`);
  return outcome.receipts
    .slice(delegate + 1)
    .filter((receipt) => contracts.includes(receipt.executorId))
    .reduce((sum, receipt) => sum + receipt.gasBurnt, 0n);
}

function tgas(gas: bigint): string {
  return (Number(gas) / 1e12).toFixed(2);
}

// near-sandbox ships no Windows binary.
describe.skipIf(process.platform === 'win32')('the gateway against the sandbox', { timeout: TIMEOUT_MS }, () => {
  // Set by beforeAll; afterAll may find them unset if the setup failed.
  let world: World;
  let dataDir: string;
  let deps: Deps;
  let app: ReturnType<typeof createApp>;
  /** Buyer 1's relayed commit, with the balances read just before it was sent. */
  let commit: { txHash: string; buyerBefore: bigint; relayerBefore: bigint };

  const access = async (seats: number, payment?: string): Promise<Response> =>
    app.request(`/pools/${POOL_ID}/access?seats=${seats}`, {
      headers: payment === undefined ? {} : { [PAYMENT_HEADER]: payment },
    });

  /** The offer the gateway answers a request for `seats` seats with. */
  const offerFor = async (seats: number): Promise<Offer> => {
    const response = await access(seats);
    expect(response.status).toBe(402);
    const [offer] = ((await response.json()) as PaymentRequired).accepts;
    assert.isDefined(offer, 'the 402 carried no offer');
    return offer;
  };

  /**
   * The buyer's payment for `offer`, which answers its request for `seats` seats: its key's next
   * nonce, the expiry maxBlockHeightFor gives from the final height, the sandbox's network and
   * contracts as the buyer's own configuration, and the price of `seats` at SEAT_PRICE as its budget.
   * The ft_transfer_call gets `gas`, or the offer's maxGas when it is omitted.
   */
  const paymentFrom = async (buyer: Actor, seats: number, offer: Offer, gas?: bigint): Promise<string> => {
    const { chain, config } = deps;
    const key = await chain.accessKey(buyer.id, buyer.keyPair.getPublicKey().toString());
    assert.isNotNull(key, `${buyer.id} has no such access key`);
    const block = await chain.finalBlock();
    return buildPaymentHeader({
      keyPair: buyer.keyPair,
      senderId: buyer.id,
      nonce: key.nonce + 1n,
      maxBlockHeight: maxBlockHeightFor(block.height, config.maxTimeoutSeconds, config.blockTimeMs),
      offer,
      expected: {
        network: 'near:sandbox',
        token: world.token.id,
        poolsContract: world.pools.id,
        poolId: POOL_ID,
        maxSeats: seats,
        maxAmount: BigInt(seats) * SEAT_PRICE,
      },
      gas,
    });
  };

  /** Waits until a transaction the relayer signed is final, with every receipt it caused. */
  const relayedFinal = (txHash: string): Promise<unknown> => finalOutcome(world, txHash, world.relay.id);

  beforeAll(async () => {
    // Throws, failing the suite, unless both wasm files are named.
    const wasm = wasmFromEnv();
    world = await startWorld(wasm);
    dataDir = await mkdtemp(join(tmpdir(), 'quorum-sandbox-'));
    deps = await sandboxDeps(world, dataDir);
    app = createApp(deps);

    const { seller, token, pools } = world;
    const { timestampMs } = await deps.chain.finalBlock();
    const open = {
      seat_price: SEAT_PRICE.toString(),
      target: TARGET,
      deadline_ms: timestampMs + DEADLINE_AFTER_MS,
      max_seats_per_buyer: MAX_SEATS_PER_BUYER,
      terms: TERMS,
    };
    // The bonus is the amount sent with the open message.
    await seller.account.callFunctionRaw({
      contractId: token.id,
      methodName: 'ft_transfer_call',
      args: { receiver_id: pools.id, amount: BONUS.toString(), msg: JSON.stringify({ open }) },
      deposit: 1n,
      gas: teraToGas(100),
    });
    const pool = await deps.chain.getPool(POOL_ID);
    if (pool?.status !== 'open') throw new Error(`pool ${POOL_ID} did not open: ${JSON.stringify(pool)}`);
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await world?.sandbox.tearDown();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  }, TIMEOUT_MS);

  it('runs on a chain whose id near:sandbox accepts', async () => {
    const { chain_id: chainId } = await world.provider.viewNodeStatus();

    console.log(`sandbox chain id: ${chainId}`);
    expect(checkChainId('near:sandbox', chainId)).toBeNull();
  });

  it('answers a request for 2 seats with no payment with 402 and an offer for 2 seats', async () => {
    const offer = await offerFor(2);

    expect(offer).toMatchObject({
      network: 'near:sandbox',
      maxAmountRequired: (2n * SEAT_PRICE).toString(),
      payTo: world.pools.id,
      asset: world.token.id,
      extra: { poolId: POOL_ID, seats: 2, taken: 0, target: TARGET },
    });
  });

  it("relays buyer 1's payment for 2 seats and answers 202 with a receipt for them", async () => {
    const { buyer1, relay } = world;
    const offer = await offerFor(2);
    const buyerBefore = await nearBalance(world, buyer1.id);
    const relayerBefore = await nearBalance(world, relay.id);

    const response = await access(2, await paymentFrom(buyer1, 2, offer));

    expect(response.status).toBe(202);
    const body = (await response.json()) as Pending;
    expect(body.receipt).toMatchObject({ poolId: POOL_ID, buyer: buyer1.id, seats: 2 });
    expect(body.pool).toMatchObject({ taken: 2, target: TARGET });
    commit = { txHash: body.receipt.txHash, buyerBefore, relayerBefore };
  });

  it("changes buyer 1's NEAR balance by at most the commit's 1 yoctoNEAR deposit", async () => {
    const { buyer1, relay } = world;
    await relayedFinal(commit.txHash);

    const buyerChange = (await nearBalance(world, buyer1.id)) - commit.buyerBefore;
    const relayerChange = (await nearBalance(world, relay.id)) - commit.relayerBefore;

    expect([0n, -1n]).toContain(buyerChange);
    console.log(`deposit debited from: ${buyerChange === -1n ? 'buyer' : 'relayer'}`);
    console.log(`relayer balance change: ${relayerChange} yoctoNEAR`);
  });

  it("burns less gas in buyer 1's commit than the offer's minGas", async () => {
    const { buyer1, token, pools } = world;
    const raw = await relayedFinal(commit.txHash);
    if (process.env.QUORUM_CAPTURE_FIXTURE === '1') {
      await writeFile(FIXTURE, `${JSON.stringify(raw, null, 2)}\n`);
    }

    const gas = commitGas(toTxOutcome(raw), buyer1.id, [token.id, pools.id]);

    console.log(`commit gas burnt: ${tgas(gas)} Tgas`);
    expect(gas).toBeGreaterThan(0n);
    // Burnt gas never exceeds what was attached, so this commit, paid at maxGas, cannot show that
    // minGas is enough. It shows that minGas covers at least the gas burnt; buyer 2's commit, paid
    // at minGas, shows that a commit completes with it.
    expect(gas).toBeLessThan(deps.config.minGas);
  });

  it("fills the pool with buyer 2's payment for the last seat, paid at the offer's minGas, and answers 200 with a credential", async () => {
    const { buyer2, token, pools } = world;

    const response = await access(1, await paymentFrom(buyer2, 1, await offerFor(1), deps.config.minGas));

    expect(response.status).toBe(200);
    const body = (await response.json()) as Filled;
    expect(body).toMatchObject({ status: 'filled', poolId: POOL_ID, seats: 1, terms: TERMS });
    const jwks = createLocalJWKSet(deps.credentials.jwks());
    const { payload } = await jwtVerify(body.credential, jwks, { issuer: deps.config.publicUrl });
    expect(payload).toMatchObject({ sub: buyer2.id, pool: POOL_ID, seats: 1, simulated: true });

    const header = response.headers.get(PAYMENT_RESPONSE_HEADER);
    assert.isNotNull(header, 'the 200 carried no X-PAYMENT-RESPONSE header');
    const { transaction } = decodeHeader(header) as PaymentResponse;
    const gas = commitGas(toTxOutcome(await relayedFinal(transaction)), buyer2.id, [token.id, pools.id]);
    console.log(`filling commit gas burnt at minGas: ${tgas(gas)} Tgas`);
  });

  it("answers buyer 1's redemption proof with 200 and a credential for its 2 seats once the pool has filled", async () => {
    const { buyer1 } = world;
    const proof = await buildRedeemProofHeader({
      keyPair: buyer1.keyPair,
      accountId: buyer1.id,
      poolId: POOL_ID,
      recipient: new URL(deps.config.publicUrl).host,
      nowMs: deps.now(),
    });

    const response = await app.request(`/pools/${POOL_ID}/access`, { headers: { [PROOF_HEADER]: proof } });

    expect(response.status).toBe(200);
    const body = (await response.json()) as Filled;
    expect(body).toMatchObject({ status: 'filled', poolId: POOL_ID, seats: 2, terms: TERMS });
    const jwks = createLocalJWKSet(deps.credentials.jwks());
    const { payload } = await jwtVerify(body.credential, jwks, { issuer: deps.config.publicUrl });
    expect(payload).toMatchObject({ sub: buyer1.id, pool: POOL_ID, seats: 2, simulated: true });
  });

  it("settles the filled pool on the keeper's tick and pays the seller every seat's price and the bonus", async () => {
    const { seller } = world;
    const { chain, config } = deps;
    // The gateway reads optimistic state, so neither the fill nor the settlement needs to be final
    // before it is read.
    const sellerBefore = await chain.ftBalanceOf(seller.id);
    const problems: string[] = [];
    const keeper = new Keeper({
      chain,
      writer: deps.writer,
      activity: deps.activity,
      provider: config.provider,
      poolsContract: config.poolsContract,
      refundLimit: config.refundLimit,
      settleGas: config.settleGas,
      refundGas: config.refundGas,
      now: deps.now,
      log: (message) => problems.push(message),
    });

    await keeper.tick();

    expect(problems).toEqual([]);
    const settled = deps.activity.list(POOL_ID).find((record) => record.kind === 'settle');
    assert.isDefined(settled, 'the keeper recorded no settle call');
    expect(settled).toMatchObject({ ok: true, account: seller.id, seats: TARGET, amount: PAYOUT.toString() });
    expect((await chain.getPool(POOL_ID))?.status).toBe('settled');
    expect((await chain.ftBalanceOf(seller.id)) - sellerBefore).toBe(PAYOUT);
  });
});
```

- [ ] **Step 5: Run it and capture a relayed outcome**

```bash
QUORUM_CAPTURE_FIXTURE=1 pnpm --filter @quorum-on-near/gateway test:sandbox
```

Expected: PASS, 8 tests. The first run downloads the sandbox binary inside the setup (allowed 15
minutes); `pnpm --filter @quorum-on-near/gateway exec near-sandbox --version` fetches it ahead. With
`QUORUM_POOLS_WASM` or `QUORUM_MOCK_USD_WASM` unset, the suite fails and names both. The output
includes these lines; Task 16 records the last three:

```text
sandbox chain id: <id>
deposit debited from: <buyer or relayer>
commit gas burnt: <N> Tgas
filling commit gas burnt at minGas: <M> Tgas
```

Write them down. `test/fixtures/relayed-commit.json` now holds the relayed commit's RPC result. It
names only sandbox accounts (`*.sandbox`) and their generated public keys, so it holds no personal
data and no secret.

If a step fails, it is the code that meets the real chain for the first time: fix names in place
where a library call differs (the test is the specification of what must hold). If buyer 1's
commit burns `minGas` or more, or buyer 2's commit (paid at `minGas`) answers `502` with `error` set
to `relay_failed` instead of `200`, `minGas` is too low: raise `QUORUM_COMMIT_MIN_GAS` (and
`QUORUM_COMMIT_MAX_GAS` to keep it above) in the test's configuration, run again, and carry the
measured figures into Task 16.

- [ ] **Step 6: Test the outcome parser against the captured result**

`apps/gateway/test/outcome.captured.test.ts`:

```typescript
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readCommit, toTxOutcome } from '../src/outcome.ts';

// Captured from the sandbox test (test/sandbox/relayed-commit.test.ts with QUORUM_CAPTURE_FIXTURE=1):
// buyer1.sandbox's relayed commit of 2 seats in pool 0, through relay.sandbox, on musd.sandbox.
const raw: unknown = JSON.parse(readFileSync(new URL('./fixtures/relayed-commit.json', import.meta.url), 'utf8'));

describe('a relayed commit captured from the sandbox', () => {
  it('reads as two seats taken by buyer1 in pool 0, with the pool still open', () => {
    const commit = readCommit(toTxOutcome(raw), { poolsContract: 'pools.sandbox', buyer: 'buyer1.sandbox', poolId: 0 });
    expect(commit).toMatchObject({ delegateFailed: false, seats: 2, amount: 360n, taken: 2, target: 3, filled: false });
  });

  it('lists the delegate receipt at the buyer before the receipts at the token and the pools contract', () => {
    const executors = toTxOutcome(raw).receipts.map((r) => r.executorId);
    const buyer = executors.indexOf('buyer1.sandbox');
    expect(buyer).toBeGreaterThan(0);
    expect(executors.indexOf('musd.sandbox')).toBeGreaterThan(buyer);
    expect(executors.indexOf('pools.sandbox')).toBeGreaterThan(buyer);
  });
});
```

Run: `pnpm --filter @quorum-on-near/gateway exec vitest run test/outcome.captured.test.ts`

Expected: PASS, 2 tests. Then `pnpm --filter @quorum-on-near/gateway test` passes with this file included.

- [ ] **Step 7: Commit**

```bash
git add apps/gateway/test/sandbox apps/gateway/test/fixtures/relayed-commit.json apps/gateway/test/outcome.captured.test.ts
git commit -m "run the gateway against a local sandbox and keep a captured relayed outcome"
```

---

### Task 16: Record the results, the layout and the toolchain

**Gate:** run this task after the contracts plan's branch has merged into `main`, and after
Task 15 has passed. The contracts plan edits the same parts of `CLAUDE.md` and the spec's section 10
row; making these edits before it merges would conflict.

**Files:**
- Modify: `docs/specs/2026-11-09-quorum-on-near-design.md` (sections 10 and 11, and section 6.2 if
  the gas measurement calls for it)
- Modify: `CLAUDE.md` (Architecture first line, Layout, Toolchain)
- Modify: `apps/gateway/src/config.ts`, `apps/gateway/.env.example` and
  `apps/gateway/test/config.test.ts` (only if the measured gas calls for new defaults), and `apps/gateway/test/sandbox/relayed-commit.test.ts` (only if Task 15
  overrode `minGas` in it)

- [ ] **Step 1: Check the gate**

```bash
grep -n 'contracts/pools/' CLAUDE.md
```

Expected: `grep` prints the Layout row the contracts plan added (Task 15 rebased onto `main`). If it
prints nothing, the contracts plan has not merged yet: stop here.

- [ ] **Step 2: Move the relayed-payment case to its own row in the spec's section 10**

In `docs/specs/2026-11-09-quorum-on-near-design.md`, section 10:
1. In the `Sandbox integration` row, delete `; a relayed payment that records which account is
   debited its 1 yoctoNEAR deposit` (keep the full stop that follows it).
2. Directly below the `Sandbox integration` row, add:

   ```markdown
   | Gateway sandbox test (`near-sandbox` from npm and near-api-js, with the contracts' wasm and the mock token) | A relayed commit through the gateway's HTTP path: the `402` offer, a payment answered `202`, a second buyer's payment that fills the pool answered `200` with a credential, and the keeper's `settle`. Which account is debited the 1 yoctoNEAR deposit of a relayed payment. The gas a commit burns, and that the filling commit, paid at the offer's `minGas`, completes. A redemption against the sandbox, and the chain-id check the gateway runs at startup, applied to the sandbox's id |
   ```

- [ ] **Step 3: Record which account paid the deposit**

Task 15 printed either `deposit debited from: buyer` or `deposit debited from: relayer`. In section
11, in the bullet that starts `In an NEP-366 meta transaction`, directly after `a sandbox test
records which account is debited (section 10).` (it wraps across two lines in the file) and before
`The tokens moved by`, add one sentence:

- if the buyer: `In the sandbox, the deposit is debited from the buyer's account.`
- if the relayer: `In the sandbox, the deposit is debited from the relayer's account.`

- [ ] **Step 4: Set the commit gas defaults from the measurement**

Task 15 printed `commit gas burnt: <N> Tgas` (buyer 1, paid at `maxGas`) and `filling commit gas
burnt at minGas: <M> Tgas` (buyer 2, which filled the pool). Let `G` be the larger of the two. The
defaults are `minGas` 50 Tgas and `maxGas` 100 Tgas. Burnt gas understates what a commit needs
attached (the token reserves gas for its resolver that it does not all burn), which is why the
filling commit was paid at `minGas` rather than trusted from the figure.

First, check whether Task 15 had to raise `QUORUM_COMMIT_MIN_GAS` in the test's configuration to
pass. If it did, call that value `R` (in Tgas): set the new `minGas` to the larger of `R` and
`ceil(G × 1.5)` Tgas and `maxGas` to twice that, remove both overrides (`QUORUM_COMMIT_MIN_GAS` and,
if Task 15 set it, `QUORUM_COMMIT_MAX_GAS`) from the test's configuration,
then follow the second case below from `Update the two defaults` on, with these values (it runs the
sandbox test again at the new default). If it did not:
- If `G × 1.5 ≤ 50`, change nothing in the code. In section 6.2, replace `the figures above are
  placeholders.` with `the figures above are the defaults; against the mock token a commit burns
  about <N> Tgas and the one that fills a pool about <M> Tgas, and a filling commit paid at the
  50 Tgas minGas completes in the sandbox test.`
- If `G × 1.5 > 50`, set the new `minGas` to `ceil(G × 1.5)` Tgas and `maxGas` to twice that. Update
  the two defaults in `apps/gateway/src/config.ts` (the `QUORUM_COMMIT_MIN_GAS` and
  `QUORUM_COMMIT_MAX_GAS` defaults) and in `apps/gateway/.env.example`, and the expected defaults in
  `apps/gateway/test/config.test.ts`. Run `pnpm --filter @quorum-on-near/gateway test`, which must
  pass, then run Task 15's sandbox test again (Step 5's command without `QUORUM_CAPTURE_FIXTURE`),
  which must pass with the filling commit paid at the new `minGas`. In section 6.2, replace `the
  figures above are placeholders.` with `against the mock token a commit burns about <N> Tgas and the
  one that fills a pool about <M> Tgas; the gateway's defaults are <min> and <max> Tgas, and a
  filling commit paid at <min> Tgas completes in the sandbox test.`

The swarm plan measures the same figures again against Circle's USDC on testnet.

- [ ] **Step 5: Record the layout and the toolchain in `CLAUDE.md`**

1. In `## Architecture (implementation-relevant facts)`, replace `The contracts are built and tested;
   the protocol package, gateway, swarm, MCP server and live page are not yet.` (it wraps across two
   lines in the file) with `The contracts, the protocol package and the gateway are built and tested;
   the swarm, MCP server and live page are not yet.`
2. Append these rows at the end of the Layout table:

   ```markdown
   | `packages/protocol/` | The `quorum` x402 scheme: types, header codecs, delegate-action and NEP-413 checks, buyer builders |
   | `apps/gateway/` | The provider's HTTP side: offers, payment checks, relay, credentials, redemption, the keeper and the activity feed |
   ```

3. Delete the sentence `The TypeScript packages and apps are added by later plans.` (later plans
   append their own rows).
4. Under `## Toolchain`, keep the existing paragraph and add a second one after it:

   ```markdown
   TypeScript: Node 22.22.2 or later and pnpm 10 through Corepack, in a pnpm workspace
   (`packages/*`, `apps/*`); near-api-js 7, Hono, jose, vitest. Node runs the TypeScript sources
   directly (type stripping), so there is no build step. `pnpm install`, then `pnpm test` and
   `pnpm typecheck`. The gateway runs with `pnpm --filter @quorum-on-near/gateway start` and reads
   `QUORUM_*` variables from `apps/gateway/.env` (see `.env.example`). Its sandbox test
   (`pnpm --filter @quorum-on-near/gateway test:sandbox`) needs the contracts built with cargo near,
   with the absolute paths of their wasm files in `QUORUM_POOLS_WASM` and `QUORUM_MOCK_USD_WASM`. It
   runs on macOS on Apple silicon, or on Linux or WSL2 with glibc 2.38 or later (Ubuntu 24.04 or
   later).
   ```

- [ ] **Step 6: Run everything once more**

```bash
pnpm install
pnpm typecheck
pnpm test
```

Expected: no type errors; every test passes (the sandbox suite is not part of `pnpm test`).

- [ ] **Step 7: Commit**

```bash
git add docs/specs/2026-11-09-quorum-on-near-design.md CLAUDE.md
git commit -m "record the gateway's sandbox results, layout and toolchain"
```

If Step 4 changed the defaults, stage those files in the same commit:
`git add apps/gateway/src/config.ts apps/gateway/.env.example apps/gateway/test/config.test.ts`,
and, if it removed the overrides from the sandbox test's configuration,
`git add apps/gateway/test/sandbox/relayed-commit.test.ts`.


---

## Spec coverage

| Spec requirement | Where |
|---|---|
| 4: the protocol package has no network access; the gateway plays both x402 roles | Tasks 1 to 5 (no provider in the protocol package); Tasks 10 to 14 |
| 5.6: the events, read only from receipts the pools contract executed | Task 1 (`parseEventLog`), Task 7 (`poolsEvents`) |
| 6: the x402 v1 wire format, base64 JSON headers, `near:testnet` in CAIP-2 form | Task 2 (`encodeHeader`, `decodeHeader`), Task 6 (`QUORUM_NETWORK`) |
| 6.1: `GET /`, `GET /pools`, `GET /pools/:id/access`, `GET /activity`, JWKS, `POST /rpc` and its limits, no dot paths; only the provider's pools | Task 9 (`servedPool`, `openPoolListings`), Task 10 (the offer's answers), Task 14 (routes, static serving, `/config.json`) |
| 6.2: the offer, its fields, seats capped by the seats left and `max_seats_per_buyer` (as Task 1 records it), `minBonusPerSeat` | Task 2 (`buildOffer`, `offerSeats`), Task 10 (`currentAccepts`) |
| 6.3: the payment payload, one `ft_transfer_call` with 1 yoctoNEAR; the buyer's check of the offer before signing | Task 3 (decoding), Task 5 (checks, `checkOffer` and the buyer builder) |
| 6.3 and 6.4: a full-access key (check 4) | Task 11 (`not_full_access`) |
| 6.4: checks 1 to 3 with every rejection code | Task 5 (`checkPaymentHeader`, one test per code) |
| 6.4: checks 4 to 8, one payment in flight per buyer, nothing relayed until every check passes | Task 9 (`InFlight`), Task 11 |
| 6.4: the relay with several keys, one transaction per key; never re-signed or re-sent; lookup by hash on a timeout; a result only at `EXECUTED_OPTIMISTIC` or later | Task 7 (`toTxOutcome`), Task 8 |
| 6.4: a buyer whose result is unknown stays in flight until a final block above its `max_block_height` | Task 8 (`expired`), Task 9 (`InFlight.hold`), Task 11 |
| 6.4: the response table (202, 200, 409, 410, 502), a commit that took no seats judged by block time, and `X-PAYMENT-RESPONSE` | Task 11 |
| 6.5: redemption: NEP-413 signature, full-access key, 5-minute age (one minute of clock skew), unseen nonce; the 202/200/410/404 table | Task 4, Task 9 (`NonceCache`), Task 12 |
| 6.6: the EdDSA JWS credential, its claims, the same `sub`, `pool` and `seats` for the same buyer | Task 6, Tasks 11 and 12 |
| 6.7: the keeper every 5 seconds, `settle` and `refund`, safe to repeat; progress by the pool's state, and the backoff | Task 9 (`keeperCallProgressed`), Task 13 |
| 6.7: the activity feed, a JSON-lines file under `data/`, reloaded on restart | Task 9 (`ActivityLog`, `keeperRecords`), Task 11, Task 13 |
| 7.6: configuration, testnet only, gas bounds against the contract's requirements, the RPC's chain checked at startup, no secret committed | Task 6 (`loadConfig`, `checkChainId`, `.env.example`), Task 14 (`main.ts`) |
| 9: error handling (failed checks, races, RPC timeouts, keeper retries, restarts, block-time deadlines) | Tasks 8, 9, 11, 12, 13 |
| 12: the limits this plan adds (no rate limit on `/rpc`, credentials at optimistic execution, the in-flight hold's window) | Task 1 (recorded), Tasks 11 and 14 |
| 10: protocol unit tests, one per rejection code, with fixture keys | Tasks 1 to 5 (keys generated at run time) |
| 10: gateway tests against a stubbed chain: every response row, payments in flight, the RPC timeout path, the keeper's calls | Tasks 7 to 14 (`FakeChain`) |
| 10: the relayed payment that records which account is debited its 1 yoctoNEAR deposit | Task 15, recorded in Task 16 |
| 5.7 and 6.2: a commit's burnt gas measured, and a commit paid at `minGas` completed, in the sandbox against the mock token | Task 15, recorded in Task 16 |
| 11: relayed calls see the buyer as `predecessor_account_id`; full-access keys for the 1 yoctoNEAR deposit | Task 5 (the delegate is the buyer's), Task 11 (`not_full_access`), Task 15 |
| Not here: the swarm, the MCP server, the live page, anything on testnet | Later plans |
