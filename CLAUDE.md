# CLAUDE.md — quorum-on-near

**Quorum on NEAR** is a threshold group purchase on NEAR. A seller opens a pool for something that
is only worth selling if enough buyers commit, and sets a target, a seat price and a deadline. When
it opens the pool, it also escrows a **refund bonus**. Buyers, usually AI agents acting for a person
or a company, each commit a seat and pay over HTTP 402. If the target is reached before the
deadline, the seller is paid and each buyer receives its access. If not, every seat is refunded
together with a share of the bonus, which makes committing a no-lose move (a dominant assurance
contract). The worked example is a reserved block of GPU capacity shared by several teams' agents.
The provider in that example is simulated; the money flow is real, on testnet.

## Architecture (implementation-relevant facts)

Nothing is built yet. The design is being written in `docs/specs/`; this section is updated as it
is decided. What is fixed so far:

- **One NEAR contract** holds the pools, the seats and the bonuses, in a mock NEP-141 stablecoin on
  testnet.
- **Seats** arrive through NEP-141 `ft_transfer_call`, which calls the contract's `ft_on_transfer`.
  A payment that cannot take a seat is returned through the token's `ft_resolve_transfer` (the
  amount `ft_on_transfer` reports as unused).
- **The bonus** is escrowed when the pool opens. It goes back to the seller on settlement, or is
  split among the committed seats on refund.
- **Settlement and refunds** are promises with `#[private]` callbacks. State is zeroed before a
  transfer and restored if the transfer fails.
- **HTTP flow:** `402 Payment Required` with the offer, then `202 Accepted` with a receipt while the
  pool fills, then `200` with the access credential once it has settled.

NEAR rules the design relies on (from NEAR's documentation):

- A **function-call access key cannot attach a deposit**, not even 1 yoctoNEAR. A method an agent
  calls with such a key must be deposit-free, so it cannot be `ft_transfer_call`.
- A function-call key **can sign an NEP-366 delegate action** (a meta-transaction): the sender's key
  is checked against the receiver and the method names. The relayer pays the gas, and the key's
  allowance is not checked. Gas keys cannot sign the inner delegate action.
- With a relayed call, `signer_account_id` is the relayer. The buyer is always
  `predecessor_account_id`.

## Layout

| Path | Content |
|---|---|
| `docs/specs/` | Design specs: what the system is and how it behaves |
| `docs/plans/` | Implementation plans written from the specs |
| `.claude/` | Vendored skills and a SessionStart hook (see Skills) |

The code layout is set by the first implementation plan.

## Toolchain

Set by the first implementation plan in `docs/plans/`, and recorded here when it lands: languages,
versions, and how to build, test and run locally. NEAR **testnet** only until the test circuit
passes (rule 4).

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
