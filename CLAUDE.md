# CLAUDE.md — quorum-on-near

**Quorum on NEAR** is a threshold group purchase on NEAR. A seller opens a pool for something that
is only worth selling if enough buyers commit, and sets a target, a seat price and a deadline. When
it opens the pool, it also escrows a **refund bonus**. Buyers, usually AI agents acting for a person
or a company, each commit a seat and pay over HTTP 402. If the target is reached before the
deadline, the seller is paid and each buyer receives its access. If not, every seat is refunded
together with a share of the bonus, which makes committing a no-lose move (a dominant assurance
contract). The worked example is a block of GPU capacity shared by several teams' agents.
The provider in that example is simulated; the money flow is real, in Circle's USDC on testnet, at
prices scaled down 10,000 times.

## Architecture (implementation-relevant facts)

The contracts, the protocol package, the gateway and the live page are built and tested; the swarm
and MCP server are not yet. The design is
[`docs/specs/2026-11-09-quorum-on-near-design.md`](docs/specs/2026-11-09-quorum-on-near-design.md);
the spec wins where this summary is shorter. In brief:

- **One NEAR contract** holds the pools, the seats and the bonuses, in one NEP-141 token set at
  initialisation. On testnet it is Circle's USDC
  (`3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af`). In the sandbox tests it is
  the mock token `contracts/mock-usd` (mUSD), which is never deployed to testnet. The contract has
  no owner or admin methods: `settle` and `refund` are open to anyone, and each buyer can call
  `claim_refund` for itself, so no buyer's money depends on our server.
- **Funding:** USDC enters by hand, from Circle's testnet faucet, into one funding account, the
  only source of USDC. `swarm setup` tops the buyers and the provider up from it, and `swarm reset`
  returns their surpluses to it. Prices are scaled so that no pool holds, and no run moves, as much
  as 0.1 USDC.
- **Buyers are agents' sub-accounts** with full-access keys, each holding only its own budget. A
  buyer pays by signing an NEP-366 delegate action wrapping `ft_transfer_call`. The gateway checks
  it against the offer, then relays it, paying the gas.
- **The gateway plays both x402 roles**, resource server and facilitator, for the `quorum` scheme on
  `near:testnet`. A standard `exact` facilitator cannot take a seat.
- **Seats** arrive through NEP-141 `ft_transfer_call`, which calls the contract's `ft_on_transfer`.
  A payment that cannot take a seat is returned through the token's `ft_resolve_transfer` (the
  amount `ft_on_transfer` reports as unused).
- **The bonus** is escrowed when the pool opens. It goes back to the seller on settlement, or is
  split among the committed seats on refund.
- **Settlement and refunds** are promises with `#[private]` callbacks. State is marked (Settled,
  Refunded) before a transfer and restored if the transfer fails.
- **HTTP flow:** `402 Payment Required` with the offer, then `202 Accepted` with a receipt while the
  pool fills, then `200` with the access credential once it has filled (a full pool is final).

NEAR rules the design relies on (from NEAR's documentation):

- A **function-call access key cannot attach a deposit**, not even 1 yoctoNEAR, and
  `ft_transfer_call` requires 1 yoctoNEAR. That is why buyers sign with a full-access key.
- In an NEP-366 delegate action (a meta-transaction), **the relayer pays the gas**; the tokens
  moved still come from the sender. NEAR's documentation is not consistent about who is charged the
  1 yoctoNEAR deposit (one page says the relayer, another the client), so buyers keep a little NEAR
  and a test records who is debited. A delegate action has one receiver. Gas keys cannot sign the
  inner delegate action.
- With a relayed call, `signer_account_id` is the relayer. The buyer is always
  `predecessor_account_id`.

## Layout

| Path | Content |
|---|---|
| `docs/specs/` | Design specs: what the system is and how it behaves |
| `docs/plans/` | Implementation plans written from the specs |
| `.claude/` | Vendored skills and a SessionStart hook (see Skills) |
| `contracts/mock-usd/` | The Mock USD token (NEP-141), for the sandbox tests only |
| `contracts/pools/` | The pools escrow contract |
| `crates/sandbox-support/` | Test helper: starts a local NEAR sandbox and wraps calls and views |
| `packages/protocol/` | The `quorum` x402 scheme: types, header codecs, delegate-action and NEP-413 checks, buyer builders |
| `apps/gateway/` | The provider's HTTP side: offers, payment checks, relay, credentials, redemption, the keeper and the activity feed |
| `apps/web/` | The live page: a static page with no build step, served by the gateway at `/`, that shows one of the provider's pools, its ledger and its buyers as the chain holds them |

## Toolchain

Rust 1.99.1 (pinned in `rust-toolchain.toml`) with the wasm32-unknown-unknown target; near-sdk 5 and near-contract-standards 5;
cargo-near for builds (cargo near build non-reproducible-wasm). Unit tests: cargo test --lib.
Sandbox tests use near-sandbox and near-api and build the contracts themselves: cargo test
--workspace (Linux or macOS on Apple silicon, or WSL2). The sandbox node that near-sandbox
downloads (nearcore 2.13.4) needs glibc 2.38 or later, so Ubuntu 24.04 or later; older nodes that
run on an older glibc reject the wasm current Rust emits. A bare `cargo check` stops at near-sdk's
native-build guard, because it leaves out the dev-dependency that turns on `unit-testing`: use
`cargo check --tests`, or `cargo check --target wasm32-unknown-unknown`. NEAR testnet only until
the test circuit passes (rule 4).

TypeScript: Node 22.22.2 or later and pnpm 10 through Corepack, in a pnpm workspace
(`packages/*`, `apps/*`); near-api-js 7, Hono, jose, vitest. Node runs the TypeScript sources
directly (type stripping), so there is no build step. `pnpm install`, then `pnpm test` and
`pnpm typecheck`. The gateway runs with `pnpm --filter @quorum-on-near/gateway start` and reads
`QUORUM_*` variables from `apps/gateway/.env` (see `.env.example`). Its sandbox test
(`pnpm --filter @quorum-on-near/gateway test:sandbox`) needs the contracts built with cargo near,
with the absolute paths of their wasm files in `QUORUM_POOLS_WASM` and `QUORUM_MOCK_USD_WASM`. It
runs on macOS on Apple silicon, or on Linux or WSL2 with glibc 2.38 or later (Ubuntu 24.04 or
later).

The live page (`apps/web`) is plain JavaScript with JSDoc types, checked by `tsc` (`checkJs`), and
has no build step: the gateway serves its four files at `/` (`QUORUM_WEB_DIR`, by default `../web` from
`apps/gateway`). Its tests run with `pnpm --filter @quorum-on-near/web test`, and in `pnpm test`.

**CI** (`.github/workflows/ci.yml`) runs on every pull request into `main` and on every push to
`main`, except for changes that touch only `docs/`, Markdown or `.claude/`. Four jobs run in
parallel on Ubuntu 24.04: `typescript` (typecheck and the unit tests), `rust-lint` (`cargo fmt
--check`, `cargo clippy -D warnings`), `rust-tests` (`cargo test --workspace`, the unit and sandbox
tests) and `gateway-sandbox` (the gateway's sandbox test against wasm built with `cargo near`).
The jobs use no secrets. To reproduce one locally, run the commands in its steps; the Node, pnpm,
Rust and cargo-near versions are pinned in the workflow, `package.json` and `rust-toolchain.toml`.

## Rules

1. **Self-contained repo.** All code, comments, commit messages and docs must make sense with only
   this repository checked out. Never reference files, paths or documents outside it.
2. **No secrets, ever, in any commit.** API keys, wallet mnemonics, private keys and keypair files
   live in `.env` or outside the repo (gitignored); commit `.env.example` with empty values.
   On-chain addresses are fine.
3. **Commit messages are neutral, technical and present tense** ("verify the payment before
   serving the resource"). Never framed around an audience, an event, a deadline or a pitch.
4. **Testnet or devnet first.** No mainnet transaction from code that has not passed the test
   circuit. Mainnet configuration changes get their own commit.
5. **Public-facing docs (README, API reference, specs) describe what the system does** — never
   event, campaign or competition tactics, and never a schedule.
6. **Work on a branch** (`<type>/<short-slug>`), never on a detached HEAD.
7. **Captured fixtures are scrubbed at capture time** of personal data. This repository is
   publishable at any moment, and nobody re-reads a committed JSON file.
8. **Say what is simulated.** The seller and the access it sells are simulated in the example;
   never call them a partner, a booking or a reservation in code, docs or UI text.

## Skills

`.claude/skills/` holds vendored, general-purpose public skill libraries; provenance, pinned
commits and licences are in [`.claude/skills/VENDORED.md`](.claude/skills/VENDORED.md). Do not add
project-specific content there. No git worktrees: skills that used to create one create a dedicated
branch instead. Plans are written to `docs/plans/`, specs to `docs/specs/` (overriding the upstream
`docs/superpowers/…` defaults).

**NEAR:**

- **NEAR's Agent Skills (`near/agent-skills`) are not vendored here**, because that repository
  carries no licence (see `VENDORED.md`). Do not commit them: `.claude/skills/near-*/` is
  gitignored, so a local install stays local.
- **The NEAR docs MCP** is configured in `.mcp.json` as `near-docs` (`search_near_docs`,
  `query_docs_filesystem_near_docs`, read-only). Its queries go to a third-party server: ask
  technical questions only. **Never call its `submit_feedback` tool**, which sends text to NEAR's
  docs team.
- Do not add the on-chain NEAR MCP (`nearai/near-mcp`): it handles private keys.
