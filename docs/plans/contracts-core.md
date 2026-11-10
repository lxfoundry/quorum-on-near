# Contracts Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or
> executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for
> tracking.

**Goal:** Build the on-chain half of Quorum on NEAR: the pools escrow contract, and the Mock USD
token its sandbox tests run against, tested at unit level and in a local NEAR sandbox, with the
escrow invariants checked after every step. On testnet the pools contract runs against Circle's
USDC instead (spec section 5.7), which this plan does not deploy.

**Architecture:** A Cargo workspace with two contracts. `contracts/mock-usd` is a NEP-141 token with
storage management and a capped open `mint`, for the sandbox tests only. `contracts/pools` holds
pools, seats and bonuses in flat `LookupMap` storage, takes seats and bonuses through
`ft_on_transfer`, and pays out through `ft_transfer` promises with `#[private]` callbacks. A small
helper crate, `crates/sandbox-support`, wraps `near-sandbox` and `near-api` so that every sandbox
test talks to one thin interface.

**Tech Stack:** Rust (stable, `wasm32-unknown-unknown`), `near-sdk` 5, `near-contract-standards` 5,
`cargo near` for builds; `near-sandbox` and `near-api` for sandbox tests; `tokio`, `serde_json`,
`anyhow`, `reqwest` in the test helper.

**Spec:** [`../specs/2026-11-09-quorum-on-near-design.md`](../specs/2026-11-09-quorum-on-near-design.md).
Executors read the spec and this plan together. Section numbers below refer to the spec.

## Corrections found while executing this plan

The plan was executed as written except for these corrections, which the code and the spec now
carry. Where a snippet below differs from the repository, the repository is authoritative.

- `cargo add` refuses a manifest whose `[lib]` source file does not exist yet, so each crate's
  `src/lib.rs` is written before its `cargo add` step.
- A bare `cargo check -p <crate>` stops at near-sdk's native-build guard, because it leaves out the
  dev-dependency that turns on `unit-testing`. Use `cargo check --tests` or
  `cargo check --target wasm32-unknown-unknown`.
- `Cargo.lock` is committed with the workspace.
- The sandbox node that near-sandbox downloads (nearcore 2.13.4) needs glibc 2.38 or later, so
  Ubuntu 24.04 or later. Older nodes that run on an older glibc reject the wasm current Rust emits.
- `gas.rs` adds `FEES_PER_TRANSFER` (3 Tgas), so `gas_needed(n)` is 10 + 23n Tgas: 33 Tgas for one
  transfer, 263 Tgas for a full refund batch of 10 plus the dust. `tests/gas.rs` checks that 262
  Tgas is refused and that 280 Tgas completes a full batch, which burnt 52 Tgas in the sandbox.
- The refund unit tests are run with the filter `refund::tests`, because `refund` also matches
  three `math` tests.
- The sandbox `World`'s `open`, `commit`, `settle`, `refund` and `claim` check the invariants after
  every call, failed calls included.
- Tests added beyond the plan: the `pool_opened`, `seats_committed` and `pool_filled` events in the
  receive unit tests; "Filled is final" at the `refund` and `claim_refund` entry points; the
  amounts carried by `seat_refunded`, `pool_refunded` and `pool_settled`; a refund scenario where
  each buyer holds three seats, one buyer's taken in two commits, paid by a claim and by a push,
  which ends with the contract holding nothing. The invariant check only proves the contract holds
  at least what it owes, so it cannot catch an underpayment on its own.
- The sandbox helper's `Outcome` carries each receipt's account and gas burnt, and `tests/gas.rs`
  asserts that every transfer and callback in the full batch burns under 5 Tgas of its 10 (about
  1.7 and 1.5 Tgas against the mock token).
- `refund.rs` shares one `restore_claimable` helper between the two refund callbacks, its gate
  messages read "pool is not expired" and "pool is neither expired nor refunded", and
  `on_dust_sent` acts only on an Expired pool whose dust is in flight.

## Status of the code in this plan

**No snippet in this plan has been compiled.** Treat each as unverified until the command at the end
of its step has run. Where a compile error names a different import path, method name or trait
signature than the snippet uses (the near crates rename things between releases), fix the name in
place: do not change the logic. The sandbox helper in Task 2 is the one place that depends on
`near-sandbox` and `near-api` details; the rest of the sandbox tests use only the helper's own
interface. Run Tasks 1 and 2 first and settle any such fixes before going on.

## Global Constraints

Every task's requirements include this section. Values are copied from the spec and the repository
rules.

- Contracts are Rust with `near-sdk` 5, built with `cargo near`; sandbox tests run in a local NEAR
  sandbox. NEAR **testnet** only until the test circuit passes.
- **Mock token:** NEP-141 from `near-contract-standards` with storage management; name `Mock USD`,
  symbol `mUSD`, 6 decimals (as USDC); one extra method `mint(account_id, amount)`, open to anyone,
  capped at 1,000 mUSD per call. It is used by the sandbox tests only and is never deployed to
  testnet.
- **Pools contract:** there are **no owner or admin methods**. One token per contract, set by
  `new(token)`, which is `#[private]` and runs in the same transaction as the deployment. The
  contract accepts `ft_on_transfer` only from that token.
- **Any compliant token:** the pools contract calls nothing on the token beyond NEP-141
  (`ft_transfer`) and never relies on the mock's `mint` or metadata, so its logic needs no change
  for Circle's testnet USDC. Its gas allowances (`TRANSFER_GAS`, `CALLBACK_GAS`) are calibrated
  here against the mock; the swarm plan checks them again against USDC (spec sections 5.7 and 10).
  It has no minimum amount beyond `seat_price > 0`: the testnet scenarios use seat prices of 180
  and 320 base units (spec section 7.3). `get_token` reports the token, so that setup can check an
  existing deployment (spec section 7.2).
- **Limits:** `1 ≤ target ≤ 1000`; `terms` at most 280 bytes; `refund` `limit` 1 to 10;
  `seat_price > 0`; `deadline_ms` in the future when a pool opens.
- **Time:** every deadline is judged by block time (`env::block_timestamp_ms()`). A pool is past its
  deadline when block time ≥ `deadline_ms`; a commit needs block time < `deadline_ms`.
- **Promises:** every cross-contract call is a promise with a `#[private]` callback. State is
  written before each transfer and restored by the callback if the transfer fails. **Callbacks never
  panic.** Every amount is computed with checked arithmetic, before the transfer, never in a
  callback.
- **Gas and deposits:** each `ft_transfer` the contract makes attaches exactly 1 yoctoNEAR from the
  contract's own balance. `settle`, `refund` and `claim_refund` assert at entry that their prepaid
  gas covers every transfer and callback they will schedule, and panic before changing any state if
  it does not.
- **Events:** NEP-297, `standard: "quorum"`, `version: "1.0.0"`; amounts are decimal strings.
- **Repository rules:** commit messages are neutral, technical and in the present tense ("verify the
  payment before serving the resource"); none is framed around an audience, an event, a deadline or a
  pitch, and none names a date. Work on a branch, never `main`. No secrets in any commit.
  Nothing refers to a file outside this repository.

## File Structure

| Path | Responsibility |
|---|---|
| `Cargo.toml` | Workspace members and the release profile (`overflow-checks = true`) |
| `rust-toolchain.toml` | Stable toolchain with the `wasm32-unknown-unknown` target |
| `contracts/mock-usd/src/lib.rs` | The token: NEP-141, NEP-145, NEP-148 metadata, capped `mint` |
| `contracts/mock-usd/tests/token.rs` | Sandbox tests of the token |
| `crates/sandbox-support/src/lib.rs` | `Chain`: start a sandbox, create accounts, deploy, call, view, read the block time, move time forward; `token_wasm()`, `pools_wasm()` |
| `contracts/pools/src/lib.rs` | `Contract` state, `new`, the token-transfer helper, the unit-test helpers |
| `contracts/pools/src/types.rs` | `Pool`, `Buyer`, statuses, the `Msg` enum, the view structs, limits |
| `contracts/pools/src/math.rs` | Pure amount functions: bonus share, dust, refund, payout |
| `contracts/pools/src/events.rs` | NEP-297 event emitters |
| `contracts/pools/src/gas.rs` | Gas constants and the entry assertion |
| `contracts/pools/src/receive.rs` | `ft_on_transfer`: opening a pool and committing seats |
| `contracts/pools/src/settle.rs` | `settle` and its callback |
| `contracts/pools/src/refund.rs` | `refund`, `claim_refund` and their callbacks |
| `contracts/pools/src/views.rs` | `get_pool`, `list_pools`, `get_seats`, `get_buyer`, `get_token` |
| `contracts/pools/tests/common/mod.rs` | `World`: the two contracts deployed in a sandbox, plus the invariant check |
| `contracts/pools/tests/*.rs` | Sandbox scenarios (one file per theme) |

**Out of scope for this plan** (each depends on this plan's contracts): the `packages/protocol`
TypeScript package, the gateway, the swarm, the MCP server and the live page. The spec's sandbox test
that records which account is debited the 1 yoctoNEAR of a relayed payment needs the relayer, so it
belongs with the gateway. Everything on testnet belongs with the swarm too: deploying the pools
contract against Circle's USDC, the funding account, `swarm setup`'s top-ups and `swarm reset`
(spec section 7.2), and measuring gas against USDC, both a commit's and that of the pools
contract's own transfers (spec section 10).

---

### Task 0: Toolchain

No code and no commit. Run these once and confirm each prints a version.

**Platform.** `near-sandbox`, which runs the sandbox tests of Tasks 2 and 7 to 11, supports Linux
(x86_64, aarch64) and macOS on Apple silicon. On Windows, do all of this inside WSL2 (an Ubuntu
distribution, with the repository checked out on the WSL filesystem, not under `/mnt/c`), or in CI on
Linux. The installers below are Unix shell scripts. Tasks 1 and 3 to 6 (the build and the unit tests)
also run natively on Windows, but one environment for everything avoids surprises.

- [ ] **Step 1: Install the Rust toolchain and the NEAR build tool**

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
rustup target add wasm32-unknown-unknown
curl --proto '=https' --tlsv1.2 -LsSf https://github.com/near/cargo-near/releases/latest/download/cargo-near-installer.sh | sh
```

- [ ] **Step 2: Verify**

Run: `cargo --version && rustc --version && cargo near --version && rustup target list --installed`
Expected: three version lines, and `wasm32-unknown-unknown` in the target list.

---

### Task 1: Workspace and the Mock USD token

**Files:**
- Create: `Cargo.toml`, `rust-toolchain.toml`, `contracts/mock-usd/Cargo.toml`,
  `contracts/mock-usd/src/lib.rs`
- Modify: `CLAUDE.md` (Layout and Toolchain sections, step 8),
  `docs/specs/2026-11-09-quorum-on-near-design.md` (four wording fixes, step 9)

**Interfaces:**
- Produces: the token contract, with methods `new()`, `mint(account_id: AccountId, amount: U128)`, and
  the standard NEP-141, NEP-145 and NEP-148 methods. `pub const MAX_MINT: u128 = 1_000_000_000`
  (1,000 mUSD in base units) and `pub const DECIMALS: u8 = 6`.

- [ ] **Step 1: Create the branch**

```bash
git switch -c feat/contracts-core
```

- [ ] **Step 2: Create the token crate's folder**

```bash
mkdir -p contracts/mock-usd/src
```

Do not scaffold with `cargo near new`: it runs `git init` and commits inside the new folder, which
would leave a nested repository here, and it adds workflow files this repository does not use. The
manifest in step 4 carries the settings the template would have set.

- [ ] **Step 3: Write the workspace manifest and the toolchain file**

`Cargo.toml` (repository root):

```toml
[workspace]
resolver = "2"
members = [
    "contracts/mock-usd",
]

[profile.release]
codegen-units = 1
opt-level = "z"
lto = true
debug = false
panic = "abort"
overflow-checks = true
```

`rust-toolchain.toml` (repository root):

```toml
[toolchain]
channel = "stable"
components = ["rustfmt", "clippy"]
targets = ["wasm32-unknown-unknown"]
```

If `cargo check` later reports that `near-sdk` needs a newer minimum Rust version than the stable
channel provides, or the reverse, pin `channel` to the version it names.

- [ ] **Step 4: Write the token manifest and add its dependencies**

Write `contracts/mock-usd/Cargo.toml`:

```toml
[package]
name = "mock-usd"
version = "0.1.0"
edition = "2021"
publish = false
description = "Mock USD (mUSD): a NEP-141 token for sandbox tests, with a capped open mint"

[lib]
crate-type = ["cdylib", "rlib"]
```

Then add the dependencies at their current versions:

```bash
cargo add -p mock-usd near-sdk@5 near-contract-standards@5
cargo add -p mock-usd --dev near-sdk@5 --features unit-testing
```

`near-sdk` refuses to compile for a native target unless a test or ABI feature is on. The
dev-dependency turns on `unit-testing` for `cargo check`, `cargo clippy` and the sandbox tests, and
does not touch the wasm build.

- [ ] **Step 5: Write the token**

`contracts/mock-usd/src/lib.rs`:

```rust
//! Mock USD (mUSD): a NEP-141 token for the sandbox tests; it is never deployed to testnet. Anyone
//! can mint a small amount to a registered account; the token has no owner.

use near_contract_standards::fungible_token::events::FtMint;
use near_contract_standards::fungible_token::metadata::{
    FungibleTokenMetadata, FungibleTokenMetadataProvider, FT_METADATA_SPEC,
};
use near_contract_standards::fungible_token::{
    FungibleToken, FungibleTokenCore, FungibleTokenResolver,
};
use near_contract_standards::storage_management::{
    StorageBalance, StorageBalanceBounds, StorageManagement,
};
use near_sdk::json_types::U128;
use near_sdk::{
    log, near, require, AccountId, BorshStorageKey, NearToken, PanicOnDefault, PromiseOrValue,
};

pub const DECIMALS: u8 = 6;
/// The most one `mint` call can create: 1,000 mUSD in base units.
pub const MAX_MINT: u128 = 1_000 * 1_000_000;

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Token,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    token: FungibleToken,
}

#[near]
impl Contract {
    #[init]
    pub fn new() -> Self {
        Self {
            token: FungibleToken::new(StorageKey::Token),
        }
    }

    /// Mints `amount` to `account_id`, which must already be registered on the token. The cap keeps
    /// one call from creating an absurd balance; there is no cap on the number of calls.
    pub fn mint(&mut self, account_id: AccountId, amount: U128) {
        require!(amount.0 > 0, "amount must be positive");
        require!(amount.0 <= MAX_MINT, "amount exceeds the per-call mint cap");
        self.token.internal_deposit(&account_id, amount.0);
        FtMint {
            owner_id: &account_id,
            amount,
            memo: Some("mint"),
        }
        .emit();
    }
}

#[near]
impl FungibleTokenCore for Contract {
    #[payable]
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        self.token.ft_transfer(receiver_id, amount, memo)
    }

    #[payable]
    fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<U128> {
        self.token.ft_transfer_call(receiver_id, amount, memo, msg)
    }

    fn ft_total_supply(&self) -> U128 {
        self.token.ft_total_supply()
    }

    fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        self.token.ft_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenResolver for Contract {
    #[private]
    fn ft_resolve_transfer(
        &mut self,
        sender_id: AccountId,
        receiver_id: AccountId,
        amount: U128,
    ) -> U128 {
        let (used_amount, burned_amount) =
            self.token
                .internal_ft_resolve_transfer(&sender_id, receiver_id, amount);
        if burned_amount > 0 {
            log!("Account @{} burned {}", sender_id, burned_amount);
        }
        used_amount.into()
    }
}

#[near]
impl StorageManagement for Contract {
    #[payable]
    fn storage_deposit(
        &mut self,
        account_id: Option<AccountId>,
        registration_only: Option<bool>,
    ) -> StorageBalance {
        self.token.storage_deposit(account_id, registration_only)
    }

    #[payable]
    fn storage_withdraw(&mut self, amount: Option<NearToken>) -> StorageBalance {
        self.token.storage_withdraw(amount)
    }

    #[payable]
    fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        if let Some((account_id, balance)) = self.token.internal_storage_unregister(force) {
            log!("Closed @{} with {}", account_id, balance);
            true
        } else {
            false
        }
    }

    fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        self.token.storage_balance_bounds()
    }

    fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.token.storage_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenMetadataProvider for Contract {
    fn ft_metadata(&self) -> FungibleTokenMetadata {
        FungibleTokenMetadata {
            spec: FT_METADATA_SPEC.to_string(),
            name: "Mock USD".to_string(),
            symbol: "mUSD".to_string(),
            icon: None,
            reference: None,
            reference_hash: None,
            decimals: DECIMALS,
        }
    }
}
```

- [ ] **Step 6: Compile and build the wasm**

Run: `cargo check -p mock-usd`
Expected: finishes with no errors. If a trait signature differs from the snippet (for example the
type of `storage_withdraw`'s argument), change it to match the compiler's message.

Run: `cargo near build non-reproducible-wasm --manifest-path contracts/mock-usd/Cargo.toml`
(older `cargo-near` versions: `cargo near build` from inside `contracts/mock-usd`)
Expected: a `mock_usd.wasm` under `target/near/`.

- [ ] **Step 7: Commit the workspace and the token**

```bash
git add Cargo.toml rust-toolchain.toml contracts/mock-usd
git commit -m "add the workspace and the Mock USD token"
```

- [ ] **Step 8: Record the toolchain and the layout in `CLAUDE.md`**

Add this row to the Layout table:

| Path | Content |
|---|---|
| `contracts/mock-usd/` | The Mock USD token (NEP-141), for the sandbox tests only |

Replace the sentence `The code layout is set by the first implementation plan.` with `The
TypeScript packages and apps are added by later plans.` (Tasks 2 and 3 add the rows for the folders
they create.)

Replace the paragraph under `## Toolchain` with: `Rust stable with the wasm32-unknown-unknown target;
near-sdk 5 and near-contract-standards 5; cargo-near for builds (cargo near build
non-reproducible-wasm). Unit tests: cargo test --lib. Sandbox tests use near-sandbox and near-api and
build the contracts themselves: cargo test --workspace (Linux or macOS on Apple silicon, or WSL2).
NEAR testnet only until the test circuit passes (rule 4).`

```bash
git add CLAUDE.md
git commit -m "record the toolchain and the contracts layout"
```

- [ ] **Step 9: Correct the spec**

NEAR's documentation now recommends `near-sandbox` with `near-api` for sandbox tests, and the standard
token rejects a zero-amount `ft_transfer_call`. In
`docs/specs/2026-11-09-quorum-on-near-design.md` make four edits:
1. Section 4, "Toolchain": replace ``with sandbox tests in `near-workspaces` `` with ``with sandbox
   tests in `near-sandbox` and `near-api` ``. In the spec this text wraps after `tests`, so match
   across the line break (`with sandbox tests` at the end of one line, ``in `near-workspaces`.`` at
   the start of the next) and re-wrap the bullet.
2. Section 10, the "Sandbox integration" row: replace ``(`near-workspaces`, with the real mock
   token)`` with ``(`near-sandbox` and `near-api`, with the real mock token)``.
3. Section 10, the same row: replace `a pool whose dust is 0, and one whose bonus is 0;` with `a pool
   whose dust is 0 (a bonus of 0 is covered by unit tests only, because the standard token rejects a
   zero-amount `ft_transfer_call`);`.
4. Section 5.3, "Open a pool": replace `(0 is allowed)` with `(0 is allowed by the contract, though
   the standard NEP-141 token rejects a zero-amount `ft_transfer_call`, so a pool with no bonus needs
   a token that accepts one)`.

```bash
git add docs/specs/2026-11-09-quorum-on-near-design.md
git commit -m "name the sandbox test libraries and the zero-bonus limit in the spec"
```

---

### Task 2: Sandbox support crate and the token's sandbox tests

**Files:**
- Create: `crates/sandbox-support/Cargo.toml`, `crates/sandbox-support/src/lib.rs`,
  `contracts/mock-usd/tests/token.rs`
- Modify: `Cargo.toml` (members), `contracts/mock-usd/Cargo.toml` (dev-dependencies)

**Interfaces:**
- Produces (used by every later sandbox test):
  - `pub struct Chain { pub sandbox: Sandbox, pub network: NetworkConfig, pub signer: Arc<Signer> }`
  - `pub struct Outcome { pub ok: bool, pub logs: Vec<String>, pub debug: String }`
  - `Chain::start() -> Result<Chain>`
  - `Chain::create_account(&self, name: &str, near: u128) -> Result<AccountId>` (creates `<name>.sandbox`
    with `near` whole NEAR)
  - `Chain::deploy(&self, name: &str, wasm: Vec<u8>, init: Option<(&str, Value)>) -> Result<AccountId>`
    (deploys and, if given, initialises in the same transaction)
  - `Chain::call(&self, caller: &AccountId, contract: &AccountId, method: &str, args: Value, tgas: u64, deposit_yocto: u128) -> Result<Outcome>`
  - `Chain::view(&self, contract: &AccountId, method: &str, args: Value) -> Result<Value>`
  - `Chain::fast_forward(&self, blocks: u64) -> Result<()>`
  - `Chain::now_ms(&self) -> Result<u64>` (block time of the latest final block)
  - `Chain::wait_past(&self, deadline_ms: u64) -> Result<()>` (moves time forward until block time ≥
    `deadline_ms`)
  - `token_wasm() -> Result<Vec<u8>>`, `pools_wasm() -> Result<Vec<u8>>`
  - `AccountId`, re-exported from `near-api`, so test crates need not depend on `near-api`

- [ ] **Step 1: Create the crate and register it**

Add `"crates/sandbox-support"` to `members` in the root `Cargo.toml`. Then:

```bash
mkdir -p crates/sandbox-support/src
```

`crates/sandbox-support/Cargo.toml`:

```toml
[package]
name = "quorum-sandbox-support"
version = "0.1.0"
edition = "2021"
publish = false
description = "Test helper: a local NEAR sandbox with thin call and view wrappers"
```

```bash
cargo add -p quorum-sandbox-support anyhow serde_json near-api cargo-near-build
cargo add -p quorum-sandbox-support near-sandbox@0.3
cargo add -p quorum-sandbox-support tokio --features full
cargo add -p quorum-sandbox-support reqwest --features json
```

`near-sandbox` is pinned to 0.3 because it and `near-api` 0.8 must agree on one `near-account-id`
version, or the `AccountId` types clash. If a later release pair agrees, `cargo tree -d` shows no
duplicate `near-account-id` and the pin can go.

- [ ] **Step 2: Write the helper**

`crates/sandbox-support/src/lib.rs`:

```rust
//! A local NEAR sandbox with the few operations the contract tests need. Everything that depends on
//! `near-sandbox` and `near-api` lives here, so the tests use only this file's interface.

use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use anyhow::{anyhow, bail, Result};
pub use near_api::AccountId;
use near_api::{Account, Contract, NearGas, NearToken, NetworkConfig, Signer};
use near_sandbox::Sandbox;
use serde_json::{json, Value};

/// A running sandbox. Every account it creates uses the sandbox's default key, so one signer signs
/// for all of them.
pub struct Chain {
    pub sandbox: Sandbox,
    pub network: NetworkConfig,
    pub signer: Arc<Signer>,
}

/// The result of a function call: did the transaction succeed, what it logged, and its debug text
/// (which includes any receipt failure message).
pub struct Outcome {
    pub ok: bool,
    pub logs: Vec<String>,
    pub debug: String,
}

impl Chain {
    pub async fn start() -> Result<Self> {
        let sandbox = Sandbox::start_sandbox().await?;
        let network = NetworkConfig::from_rpc_url("sandbox", sandbox.rpc_addr.parse()?);
        let signer = Signer::from_secret_key(
            near_sandbox::config::DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY
                .parse()
                .map_err(|_| anyhow!("bad sandbox key"))?,
        )?;
        Ok(Self {
            sandbox,
            network,
            signer,
        })
    }

    pub async fn create_account(&self, name: &str, near: u128) -> Result<AccountId> {
        let id: AccountId = format!("{name}.sandbox").parse()?;
        self.sandbox
            .create_account(id.clone())
            .initial_balance(NearToken::from_near(near))
            .send()
            .await?;
        Ok(id)
    }

    /// Creates `<name>.sandbox` with 20 NEAR, deploys `wasm`, and runs `init` in the same
    /// transaction when given.
    pub async fn deploy(
        &self,
        name: &str,
        wasm: Vec<u8>,
        init: Option<(&str, Value)>,
    ) -> Result<AccountId> {
        let id = self.create_account(name, 20).await?;
        let deploy = Contract::deploy(id.clone()).use_code(wasm);
        let result = match init {
            Some((method, args)) => {
                deploy
                    .with_init_call(method, args)?
                    .with_signer(self.signer.clone())
                    .send_to(&self.network)
                    .await?
            }
            None => {
                deploy
                    .without_init_call()
                    .with_signer(self.signer.clone())
                    .send_to(&self.network)
                    .await?
            }
        };
        result.assert_success();
        Ok(id)
    }

    pub async fn call(
        &self,
        caller: &AccountId,
        contract: &AccountId,
        method: &str,
        args: Value,
        tgas: u64,
        deposit_yocto: u128,
    ) -> Result<Outcome> {
        let result = Account(contract.clone())
            .as_contract()
            .call_function(method, args)
            .transaction()
            .gas(NearGas::from_tgas(tgas))
            .deposit(NearToken::from_yoctonear(deposit_yocto))
            .with_signer(caller.clone(), self.signer.clone())
            .send_to(&self.network)
            .await?;
        Ok(Outcome {
            ok: result.is_success(),
            logs: result.logs().iter().map(|line| line.to_string()).collect(),
            debug: format!("{result:?}"),
        })
    }

    pub async fn view(&self, contract: &AccountId, method: &str, args: Value) -> Result<Value> {
        let data: Value = Account(contract.clone())
            .as_contract()
            .call_function(method, args)
            .read_only::<Value>()
            .fetch_from(&self.network)
            .await?
            .data;
        Ok(data)
    }

    pub async fn fast_forward(&self, blocks: u64) -> Result<()> {
        self.sandbox.fast_forward(blocks).await?;
        Ok(())
    }

    /// Block time of the latest final block, in milliseconds, read over plain JSON-RPC.
    pub async fn now_ms(&self) -> Result<u64> {
        let body = json!({
            "jsonrpc": "2.0", "id": "t", "method": "block", "params": { "finality": "final" }
        });
        let reply: Value = reqwest::Client::new()
            .post(&self.sandbox.rpc_addr)
            .json(&body)
            .send()
            .await?
            .json()
            .await?;
        let nanos = reply["result"]["header"]["timestamp"]
            .as_u64()
            .ok_or_else(|| anyhow!("no block timestamp in {reply}"))?;
        Ok(nanos / 1_000_000)
    }

    /// Moves the chain forward until block time is at or past `deadline_ms`.
    pub async fn wait_past(&self, deadline_ms: u64) -> Result<()> {
        for _ in 0..120 {
            if self.now_ms().await? >= deadline_ms {
                return Ok(());
            }
            self.fast_forward(500).await?;
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        bail!("block time did not reach {deadline_ms}")
    }
}

/// Builds a contract to wasm. The ABI steps and the lockfile check are switched off: they slow the
/// build and are not needed for tests. If the builder rejects one of those three option names, drop
/// that option; it only affects speed.
fn build_wasm(manifest_relative_to_workspace: &str) -> Result<Vec<u8>> {
    let manifest = format!(
        "{}/../../{}",
        env!("CARGO_MANIFEST_DIR"),
        manifest_relative_to_workspace
    );
    let path = cargo_near_build::build_with_cli(
        cargo_near_build::BuildOpts::builder()
            .manifest_path(manifest)
            .no_abi(true)
            .no_embed_abi(true)
            .no_locked(true)
            .build(),
    )
    .map_err(|error| anyhow!("building {manifest_relative_to_workspace}: {error:?}"))?;
    Ok(std::fs::read(path)?)
}

/// Tests in one binary run on parallel threads and every one deploys the wasm. Building once, under
/// a lock, keeps them from rebuilding (and from reading a file another build is writing).
static BUILD_LOCK: Mutex<()> = Mutex::new(());
static TOKEN_WASM: OnceLock<Vec<u8>> = OnceLock::new();
static POOLS_WASM: OnceLock<Vec<u8>> = OnceLock::new();

fn build_once(cell: &'static OnceLock<Vec<u8>>, manifest: &str) -> Result<Vec<u8>> {
    let _guard = BUILD_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(wasm) = cell.get() {
        return Ok(wasm.clone());
    }
    let wasm = build_wasm(manifest)?;
    let _ = cell.set(wasm.clone());
    Ok(wasm)
}

pub fn token_wasm() -> Result<Vec<u8>> {
    build_once(&TOKEN_WASM, "contracts/mock-usd/Cargo.toml")
}

pub fn pools_wasm() -> Result<Vec<u8>> {
    build_once(&POOLS_WASM, "contracts/pools/Cargo.toml")
}
```

- [ ] **Step 3: Compile the helper**

Run: `cargo check -p quorum-sandbox-support`
Expected: no errors. Fix import paths and builder method names to match the compiler (`NearGas`,
`NearToken`, `.deposit(...)`, `with_init_call`, `read_only::<Value>()` and the `BuildOpts` option names
are the likeliest to differ). If `create_account` reports an `AccountId` type mismatch, the two
crates disagree on the account-id version: convert with `id.as_str().parse()?` at that call. Do not
change the function signatures listed under Interfaces.

- [ ] **Step 4: Write the token's sandbox tests**

These tests exercise the token from Task 1, which already exists, so they should pass on their first
run: they characterise the token and prove the helper works. Add the dev-dependencies, then write
the tests:

```bash
cargo add -p mock-usd --dev --path crates/sandbox-support
cargo add -p mock-usd --dev anyhow serde_json
cargo add -p mock-usd --dev tokio --features full
```

`contracts/mock-usd/tests/token.rs`:

```rust
use quorum_sandbox_support::{token_wasm, Chain};
use serde_json::json;

const STORAGE_DEPOSIT: u128 = 10_000_000_000_000_000_000_000; // 0.01 NEAR, the excess is refunded

#[tokio::test]
async fn metadata_names_the_token() -> anyhow::Result<()> {
    let chain = Chain::start().await?;
    let token = chain
        .deploy("musd", token_wasm()?, Some(("new", json!({}))))
        .await?;
    let md = chain.view(&token, "ft_metadata", json!({})).await?;
    assert_eq!(md["name"], "Mock USD");
    assert_eq!(md["symbol"], "mUSD");
    assert_eq!(md["decimals"], 6);
    Ok(())
}

#[tokio::test]
async fn mint_needs_registration_and_respects_the_cap() -> anyhow::Result<()> {
    let chain = Chain::start().await?;
    let token = chain
        .deploy("musd", token_wasm()?, Some(("new", json!({}))))
        .await?;
    let alice = chain.create_account("alice", 10).await?;
    let mint = |amount: &str| json!({ "account_id": alice, "amount": amount });

    // An unregistered account cannot be minted to.
    assert!(!chain.call(&alice, &token, "mint", mint("1000000"), 30, 0).await?.ok);

    chain
        .call(
            &alice,
            &token,
            "storage_deposit",
            json!({ "account_id": alice, "registration_only": true }),
            30,
            STORAGE_DEPOSIT,
        )
        .await?;

    assert!(chain.call(&alice, &token, "mint", mint("1000000"), 30, 0).await?.ok);
    let balance = chain
        .view(&token, "ft_balance_of", json!({ "account_id": alice }))
        .await?;
    assert_eq!(balance, "1000000");

    // 1,000 mUSD is the most one call can mint; one base unit more is refused.
    assert!(!chain.call(&alice, &token, "mint", mint("1000000001"), 30, 0).await?.ok);
    assert!(chain.call(&alice, &token, "mint", mint("1000000000"), 30, 0).await?.ok);
    assert!(!chain.call(&alice, &token, "mint", mint("0"), 30, 0).await?.ok);
    Ok(())
}

#[tokio::test]
async fn registered_accounts_can_transfer() -> anyhow::Result<()> {
    let chain = Chain::start().await?;
    let token = chain
        .deploy("musd", token_wasm()?, Some(("new", json!({}))))
        .await?;
    let alice = chain.create_account("alice", 10).await?;
    let bob = chain.create_account("bob", 10).await?;
    for who in [&alice, &bob] {
        chain
            .call(
                who,
                &token,
                "storage_deposit",
                json!({ "account_id": who, "registration_only": true }),
                30,
                STORAGE_DEPOSIT,
            )
            .await?;
    }
    chain
        .call(&alice, &token, "mint", json!({ "account_id": alice, "amount": "5000000" }), 30, 0)
        .await?;
    let sent = chain
        .call(
            &alice,
            &token,
            "ft_transfer",
            json!({ "receiver_id": bob, "amount": "2000000" }),
            30,
            1,
        )
        .await?;
    assert!(sent.ok);
    let bob_balance = chain
        .view(&token, "ft_balance_of", json!({ "account_id": bob }))
        .await?;
    assert_eq!(bob_balance, "2000000");
    Ok(())
}
```

- [ ] **Step 5: Run the tests**

Run: `cargo test -p mock-usd --test token -- --nocapture`
Expected: the first run builds the token wasm and starts a sandbox per test; all three tests PASS. If
a test fails because of a helper detail (for example `Outcome.ok` is true for a call that should have
failed), fix the helper, not the test. A failure in a token behaviour (for example the mint cap) means
Task 1's token is wrong.

- [ ] **Step 6: Commit**

In `CLAUDE.md`, add this row to the Layout table:

| Path | Content |
|---|---|
| `crates/sandbox-support/` | Test helper: starts a local NEAR sandbox and wraps calls and views |

```bash
git add Cargo.toml crates/sandbox-support contracts/mock-usd CLAUDE.md
git commit -m "add the sandbox helper and sandbox tests for the token"
```

---

### Task 3: Pools crate: types, amount maths, events, gas, initialisation

**Files:**
- Create: `contracts/pools/Cargo.toml`, `contracts/pools/src/lib.rs`, `types.rs`, `math.rs`,
  `events.rs`, `gas.rs`, and empty `receive.rs`, `settle.rs`, `refund.rs`, `views.rs`
- Modify: `Cargo.toml` (members)

**Interfaces:**
- Produces:
  - `types.rs`: `PoolStatus { Open, Filled, Settled, Expired, Refunded }`,
    `BuyerState { Committed, Refunded, Claimable }` (both `Copy`, `PartialEq`, snake_case JSON),
    `Pool` (fields below), `Buyer { slot: u32, seats: u32, state: BuyerState }`,
    `Msg::{Open{..}, Commit{..}}`, `OpenParams`, `PoolView`, `SeatView`, `BuyerView`, and the limits
    `MAX_TARGET: u32 = 1000`, `MAX_TERMS_BYTES: usize = 280`, `MAX_REFUND_LIMIT: u32 = 10`,
    `MAX_PAGE: u64 = 100`.
  - `Pool { seller: AccountId, seat_price: u128, target: u32, taken: u32, deadline_ms: u64, bonus: u128,
    max_seats_per_buyer: Option<u32>, terms: String, status: PoolStatus, bonus_per_seat: u128,
    refund_cursor: u32, dust_sent: bool, buyer_count: u32 }`, with `Pool::expire_if_due(&mut self,
    now_ms: u64)`.
  - `math.rs`: `bonus_per_seat(bonus: u128, taken: u32) -> u128`, `dust(bonus: u128, bonus_per_seat:
    u128, taken: u32) -> u128`, `price_of(seats: u32, seat_price: u128) -> u128`,
    `refund_amount(seats: u32, seat_price: u128, bonus_per_seat: u128) -> u128`,
    `payout(taken: u32, seat_price: u128, bonus: u128) -> u128`.
  - `events.rs`: `pool_opened`, `seats_committed`, `pool_filled`, `pool_settled`, `seat_refunded`,
    `refund_failed`, `refund_claimed`, `pool_refunded` (signatures in the code below).
  - `gas.rs`: `TRANSFER_GAS`, `CALLBACK_GAS`, `BASE_GAS` (`Gas`), `gas_needed(transfers: u32) -> u64`,
    `require_gas_for(transfers: u32)`.
  - `lib.rs`: `Contract` with `new(token: AccountId) -> Self`, the associated function
    `Contract::transfer(token: &AccountId, receiver: AccountId, amount: u128) -> Promise`, and the
    `testutil` module (`acct`, `set_context`, `new_contract`) for unit tests.

- [ ] **Step 1: Create the crate and register it**

Add `"contracts/pools"` to `members` in the root `Cargo.toml`.

```bash
mkdir -p contracts/pools/src
```

`contracts/pools/Cargo.toml`:

```toml
[package]
name = "quorum-pools"
version = "0.1.0"
edition = "2021"
publish = false
description = "Pools escrow: threshold group purchases with an escrowed refund bonus"

[lib]
crate-type = ["cdylib", "rlib"]
```

```bash
cargo add -p quorum-pools near-sdk@5
cargo add -p quorum-pools --dev near-sdk@5 --features unit-testing
cargo add -p quorum-pools --dev --path crates/sandbox-support
cargo add -p quorum-pools --dev anyhow serde_json
cargo add -p quorum-pools --dev tokio --features full
```

- [ ] **Step 2: Write the failing maths tests**

`contracts/pools/src/math.rs` (tests first, functions in step 4):

```rust
//! Pure amount functions. Nothing here reads the chain.

#[cfg(test)]
mod tests {
    use super::*;

    /// The least each seat of a failed pool receives, whatever the other buyers do: a failed pool
    /// has at most `target - 1` seats, so this is `floor(bonus / max(target - 1, 1))`.
    fn min_bonus_per_seat(bonus: u128, target: u32) -> u128 {
        bonus / u128::from(target.saturating_sub(1).max(1))
    }

    #[test]
    fn bonus_is_shared_equally_and_floored() {
        assert_eq!(bonus_per_seat(17_280_000, 191), 90_471);
        assert_eq!(bonus_per_seat(10, 3), 3);
        assert_eq!(bonus_per_seat(10, 1), 10);
    }

    #[test]
    fn no_seats_means_no_share() {
        assert_eq!(bonus_per_seat(10, 0), 0);
        assert_eq!(dust(10, 0, 0), 10);
    }

    #[test]
    fn dust_is_the_rounding_remainder() {
        assert_eq!(dust(10, 3, 3), 1);
        assert_eq!(dust(9, 3, 3), 0);
    }

    #[test]
    fn refund_is_price_plus_share_per_seat() {
        assert_eq!(refund_amount(2, 1_800_000, 90_471), 3_780_942);
        assert_eq!(refund_amount(1, 5, 0), 5);
    }

    #[test]
    fn payout_is_the_takings_plus_the_bonus() {
        assert_eq!(payout(192, 1_800_000, 17_280_000), 192 * 1_800_000 + 17_280_000);
    }

    /// The testnet scenarios (spec section 7.3) price seats at a few hundred base units of USDC.
    #[test]
    fn the_testnet_scenario_amounts_add_up() {
        // fills: 192 seats at 180, a bonus of 1,728
        assert_eq!(payout(192, 180, 1_728), 36_288);
        assert_eq!(min_bonus_per_seat(1_728, 192), 9);
        // fails: 192 seats at 320, a bonus of 3,072, expiring with 100 seats taken
        let share = bonus_per_seat(3_072, 100);
        assert_eq!(share, 30);
        assert_eq!(dust(3_072, share, 100), 72);
        assert_eq!(refund_amount(1, 320, share), 350);
        assert_eq!(min_bonus_per_seat(3_072, 192), 16);
    }

    #[test]
    fn refunds_and_dust_always_add_up_to_what_the_pool_holds() {
        for bonus in [0u128, 1, 7, 100, 1_728, 3_072, 17_280_000] {
            for taken in 1u32..=12 {
                let share = bonus_per_seat(bonus, taken);
                let total_refunds: u128 = (0..taken).map(|_| refund_amount(1, 3, share)).sum();
                assert_eq!(total_refunds + dust(bonus, share, taken), u128::from(taken) * 3 + bonus);
            }
        }
    }

    #[test]
    fn a_failed_pool_never_pays_less_than_the_minimum_share() {
        for bonus in [0u128, 1, 7, 100, 1_728, 3_072, 17_280_000] {
            for target in 1u32..=12 {
                // a failed pool has fewer seats taken than its target
                for taken in 1..target {
                    assert!(
                        bonus_per_seat(bonus, taken) >= min_bonus_per_seat(bonus, target),
                        "bonus {bonus}, target {target}, taken {taken}"
                    );
                }
            }
        }
    }

    #[test]
    #[should_panic(expected = "seat price overflows")]
    fn a_price_that_overflows_panics() {
        price_of(2, u128::MAX);
    }

    #[test]
    #[should_panic(expected = "refund overflows")]
    fn a_refund_that_overflows_panics() {
        refund_amount(2, u128::MAX / 2 + 1, 0);
    }

    #[test]
    #[should_panic(expected = "refund overflows")]
    fn a_price_plus_share_that_overflows_panics() {
        refund_amount(1, u128::MAX, 1);
    }

    #[test]
    #[should_panic(expected = "bonus shares exceed the bonus")]
    fn shares_larger_than_the_bonus_panic() {
        dust(1, 2, 1);
    }

    #[test]
    #[should_panic(expected = "payout overflows")]
    fn a_payout_that_overflows_panics() {
        payout(1, u128::MAX, 1);
    }
}
```

- [ ] **Step 3: Write the supporting modules**

`contracts/pools/src/types.rs`:

```rust
use near_sdk::json_types::U128;
use near_sdk::{near, AccountId};

use crate::math;

pub const MAX_TARGET: u32 = 1000;
pub const MAX_TERMS_BYTES: usize = 280;
pub const MAX_REFUND_LIMIT: u32 = 10;
/// The most rows a view returns in one call.
pub const MAX_PAGE: u64 = 100;

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum PoolStatus {
    Open,
    Filled,
    Settled,
    Expired,
    Refunded,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum BuyerState {
    Committed,
    Refunded,
    Claimable,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Pool {
    pub seller: AccountId,
    pub seat_price: u128,
    pub target: u32,
    pub taken: u32,
    pub deadline_ms: u64,
    pub bonus: u128,
    pub max_seats_per_buyer: Option<u32>,
    pub terms: String,
    pub status: PoolStatus,
    /// Fixed when the pool expires; 0 before that.
    pub bonus_per_seat: u128,
    /// The next buyer slot `refund` will look at.
    pub refund_cursor: u32,
    pub dust_sent: bool,
    pub buyer_count: u32,
}

impl Pool {
    /// Moves an Open pool that is past its deadline to Expired and fixes the bonus share.
    pub fn expire_if_due(&mut self, now_ms: u64) {
        if self.status == PoolStatus::Open && now_ms >= self.deadline_ms {
            self.status = PoolStatus::Expired;
            self.bonus_per_seat = math::bonus_per_seat(self.bonus, self.taken);
        }
    }
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Buyer {
    /// This buyer's position in the pool's commit order.
    pub slot: u32,
    pub seats: u32,
    pub state: BuyerState,
}

/// The messages `ft_on_transfer` accepts, as JSON: `{"open": {...}}` or `{"commit": {...}}`.
#[near(serializers = [json])]
#[serde(rename_all = "snake_case")]
pub enum Msg {
    Open {
        seat_price: U128,
        target: u32,
        deadline_ms: u64,
        max_seats_per_buyer: Option<u32>,
        terms: String,
    },
    Commit {
        pool_id: u64,
        seats: u32,
    },
}

pub struct OpenParams {
    pub seat_price: u128,
    pub target: u32,
    pub deadline_ms: u64,
    pub max_seats_per_buyer: Option<u32>,
    pub terms: String,
}

/// A pool as the views report it. The status is derived from block time, so a pool past its
/// deadline reads as Expired even before any call has stored that.
#[near(serializers = [json])]
pub struct PoolView {
    pub id: u64,
    pub seller: AccountId,
    pub seat_price: U128,
    pub target: u32,
    pub taken: u32,
    pub deadline_ms: u64,
    pub bonus: U128,
    pub max_seats_per_buyer: Option<u32>,
    pub terms: String,
    pub status: PoolStatus,
    pub bonus_per_seat: U128,
    pub refund_cursor: u32,
    pub dust_sent: bool,
    pub buyer_count: u32,
}

impl PoolView {
    pub fn new(id: u64, pool: &Pool, now_ms: u64) -> Self {
        let expires_now = pool.status == PoolStatus::Open && now_ms >= pool.deadline_ms;
        let (status, bonus_per_seat) = if expires_now {
            (PoolStatus::Expired, math::bonus_per_seat(pool.bonus, pool.taken))
        } else {
            (pool.status, pool.bonus_per_seat)
        };
        Self {
            id,
            seller: pool.seller.clone(),
            seat_price: U128(pool.seat_price),
            target: pool.target,
            taken: pool.taken,
            deadline_ms: pool.deadline_ms,
            bonus: U128(pool.bonus),
            max_seats_per_buyer: pool.max_seats_per_buyer,
            terms: pool.terms.clone(),
            status,
            bonus_per_seat: U128(bonus_per_seat),
            refund_cursor: pool.refund_cursor,
            dust_sent: pool.dust_sent,
            buyer_count: pool.buyer_count,
        }
    }
}

#[near(serializers = [json])]
pub struct SeatView {
    pub buyer: AccountId,
    pub seats: u32,
    pub state: BuyerState,
}

#[near(serializers = [json])]
pub struct BuyerView {
    pub seats: u32,
    pub state: BuyerState,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pool(status: PoolStatus) -> Pool {
        Pool {
            seller: "seller.test".parse().unwrap(),
            seat_price: 2,
            target: 4,
            taken: 3,
            deadline_ms: 1_000,
            bonus: 10,
            max_seats_per_buyer: None,
            terms: String::new(),
            status,
            bonus_per_seat: 0,
            refund_cursor: 0,
            dust_sent: false,
            buyer_count: 3,
        }
    }

    #[test]
    fn an_open_pool_expires_exactly_at_its_deadline() {
        let mut p = pool(PoolStatus::Open);
        p.expire_if_due(999);
        assert_eq!(p.status, PoolStatus::Open);
        p.expire_if_due(1_000);
        assert_eq!(p.status, PoolStatus::Expired);
        assert_eq!(p.bonus_per_seat, 3);
    }

    #[test]
    fn a_filled_pool_never_expires() {
        let mut p = pool(PoolStatus::Filled);
        p.expire_if_due(5_000);
        assert_eq!(p.status, PoolStatus::Filled);
    }

    #[test]
    fn the_view_reports_expiry_without_storing_it() {
        let p = pool(PoolStatus::Open);
        let v = PoolView::new(0, &p, 2_000);
        assert_eq!(v.status, PoolStatus::Expired);
        assert_eq!(v.bonus_per_seat.0, 3);
        assert_eq!(p.status, PoolStatus::Open);
    }
}
```

Append to `contracts/pools/src/math.rs`, above the `#[cfg(test)]` block:

```rust
pub fn bonus_per_seat(bonus: u128, taken: u32) -> u128 {
    if taken == 0 {
        0
    } else {
        bonus / u128::from(taken)
    }
}

/// What is left of the bonus once every seat has its share; it goes back to the seller.
pub fn dust(bonus: u128, bonus_per_seat: u128, taken: u32) -> u128 {
    let shared = bonus_per_seat
        .checked_mul(u128::from(taken))
        .expect("bonus share overflows");
    bonus
        .checked_sub(shared)
        .expect("bonus shares exceed the bonus")
}

pub fn price_of(seats: u32, seat_price: u128) -> u128 {
    u128::from(seats)
        .checked_mul(seat_price)
        .expect("seat price overflows")
}

/// A buyer's refund: its seats' price plus its seats' share of the bonus.
pub fn refund_amount(seats: u32, seat_price: u128, bonus_per_seat: u128) -> u128 {
    let per_seat = seat_price
        .checked_add(bonus_per_seat)
        .expect("refund overflows");
    u128::from(seats)
        .checked_mul(per_seat)
        .expect("refund overflows")
}

/// What the seller receives when a pool settles: the takings plus the bonus back.
pub fn payout(taken: u32, seat_price: u128, bonus: u128) -> u128 {
    price_of(taken, seat_price)
        .checked_add(bonus)
        .expect("payout overflows")
}
```

`contracts/pools/src/events.rs`:

```rust
//! NEP-297 events. Amounts are decimal strings.

use near_sdk::serde_json::{json, Value};
use near_sdk::{env, AccountId};

fn emit(event: &str, data: Value) {
    let body = json!({
        "standard": "quorum",
        "version": "1.0.0",
        "event": event,
        "data": [data],
    });
    env::log_str(&format!("EVENT_JSON:{body}"));
}

pub fn pool_opened(
    pool_id: u64,
    seller: &AccountId,
    seat_price: u128,
    target: u32,
    deadline_ms: u64,
    bonus: u128,
    terms: &str,
) {
    emit(
        "pool_opened",
        json!({
            "pool_id": pool_id, "seller": seller, "seat_price": seat_price.to_string(),
            "target": target, "deadline_ms": deadline_ms, "bonus": bonus.to_string(),
            "terms": terms,
        }),
    );
}

pub fn seats_committed(
    pool_id: u64,
    buyer: &AccountId,
    seats: u32,
    amount: u128,
    taken: u32,
    target: u32,
) {
    emit(
        "seats_committed",
        json!({
            "pool_id": pool_id, "buyer": buyer, "seats": seats, "amount": amount.to_string(),
            "taken": taken, "target": target,
        }),
    );
}

pub fn pool_filled(pool_id: u64, taken: u32) {
    emit("pool_filled", json!({ "pool_id": pool_id, "taken": taken }));
}

pub fn pool_settled(pool_id: u64, seller: &AccountId, amount: u128) {
    emit(
        "pool_settled",
        json!({ "pool_id": pool_id, "seller": seller, "amount": amount.to_string() }),
    );
}

pub fn seat_refunded(pool_id: u64, buyer: &AccountId, seats: u32, amount: u128, bonus_share: u128) {
    emit(
        "seat_refunded",
        json!({
            "pool_id": pool_id, "buyer": buyer, "seats": seats, "amount": amount.to_string(),
            "bonus_share": bonus_share.to_string(),
        }),
    );
}

pub fn refund_failed(pool_id: u64, buyer: &AccountId, amount: u128) {
    emit(
        "refund_failed",
        json!({ "pool_id": pool_id, "buyer": buyer, "amount": amount.to_string() }),
    );
}

pub fn refund_claimed(pool_id: u64, buyer: &AccountId, amount: u128) {
    emit(
        "refund_claimed",
        json!({ "pool_id": pool_id, "buyer": buyer, "amount": amount.to_string() }),
    );
}

pub fn pool_refunded(pool_id: u64, dust: u128) {
    emit(
        "pool_refunded",
        json!({ "pool_id": pool_id, "dust": dust.to_string() }),
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::get_logs;

    /// The JSON after the `EVENT_JSON:` prefix, compared as a value so key order does not matter.
    fn payload(log: &str) -> Value {
        let body = log.strip_prefix("EVENT_JSON:").expect("an event log line");
        near_sdk::serde_json::from_str(body).expect("valid JSON")
    }

    #[test]
    fn events_carry_the_standard_and_string_amounts() {
        pool_filled(7, 192);
        pool_settled(7, &"seller.test".parse().unwrap(), 12_345);
        let logs = get_logs();
        assert_eq!(
            payload(&logs[0]),
            json!({
                "standard": "quorum", "version": "1.0.0", "event": "pool_filled",
                "data": [{ "pool_id": 7, "taken": 192 }],
            })
        );
        assert_eq!(payload(&logs[1])["data"][0]["amount"], "12345");
    }
}
```

`contracts/pools/src/gas.rs`:

```rust
//! Gas the contract sets aside for the transfers and callbacks it schedules. These are the starting
//! allowances; Task 11 verifies them against a full refund batch.

use near_sdk::{env, Gas};

/// Attached to each `ft_transfer` the contract makes.
pub const TRANSFER_GAS: Gas = Gas::from_tgas(10);
/// Reserved for each callback.
pub const CALLBACK_GAS: Gas = Gas::from_tgas(10);
/// The calling method's own work.
pub const BASE_GAS: Gas = Gas::from_tgas(10);

/// The gas a call needs in order to schedule `transfers` transfers, each with its callback.
pub fn gas_needed(transfers: u32) -> u64 {
    BASE_GAS.as_gas()
        + u64::from(transfers) * (TRANSFER_GAS.as_gas() + CALLBACK_GAS.as_gas())
}

/// Panics, before any state changes, unless the remaining prepaid gas covers `transfers` transfers.
pub fn require_gas_for(transfers: u32) {
    let needed = gas_needed(transfers);
    let left = env::prepaid_gas()
        .as_gas()
        .saturating_sub(env::used_gas().as_gas());
    if left < needed {
        env::panic_str(&format!("not enough gas: need {needed}, have {left}"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_transfer_needs_the_base_plus_a_transfer_and_a_callback() {
        assert_eq!(gas_needed(1), 30_000_000_000_000);
        assert_eq!(gas_needed(11), 230_000_000_000_000);
    }
}
```

`contracts/pools/src/lib.rs`:

```rust
//! Pools escrow. A seller opens a pool (seats, a seat price, a deadline) and escrows a refund bonus.
//! Buyers commit seats. A full pool pays the seller; a pool that misses its deadline refunds every
//! buyer its price plus a share of the bonus. The contract has no owner or admin methods.

mod events;
mod gas;
mod math;
mod receive;
mod refund;
mod settle;
mod types;
mod views;

use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;
use near_sdk::{
    ext_contract, near, AccountId, BorshStorageKey, NearToken, PanicOnDefault, Promise,
};

pub use types::*;

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Pools,
    Slots,
    Buyers,
}

/// The one method of the token this contract calls.
#[ext_contract(ext_token)]
pub trait Token {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    token: AccountId,
    next_pool_id: u64,
    pools: LookupMap<u64, Pool>,
    /// `(pool, slot)` to the buyer in that position of the commit order.
    slots: LookupMap<(u64, u32), AccountId>,
    /// `(pool, buyer)` to that buyer's record.
    buyers: LookupMap<(u64, AccountId), Buyer>,
}

#[near]
impl Contract {
    /// Sets the one token this contract accepts. Only the contract account itself can call it, and
    /// the deployment runs it in the same transaction, so nobody else can choose the token.
    #[init]
    #[private]
    pub fn new(token: AccountId) -> Self {
        Self {
            token,
            next_pool_id: 0,
            pools: LookupMap::new(StorageKey::Pools),
            slots: LookupMap::new(StorageKey::Slots),
            buyers: LookupMap::new(StorageKey::Buyers),
        }
    }
}

impl Contract {
    /// An `ft_transfer` of `amount` to `receiver`, with the 1 yoctoNEAR the token requires, paid
    /// from this contract's own balance.
    pub(crate) fn transfer(token: &AccountId, receiver: AccountId, amount: u128) -> Promise {
        ext_token::ext(token.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(gas::TRANSFER_GAS)
            .ft_transfer(receiver, U128(amount), None)
    }
}

#[cfg(test)]
pub(crate) mod testutil {
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::{testing_env, AccountId};

    pub fn acct(name: &str) -> AccountId {
        name.parse().unwrap()
    }

    /// Sets who is calling and the block time (milliseconds).
    pub fn set_context(predecessor: &str, now_ms: u64) {
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(acct(predecessor))
            .block_timestamp(now_ms * 1_000_000)
            .build());
    }

    /// A contract whose token is `token.test`, with the context set to a call from that token.
    pub fn new_contract() -> crate::Contract {
        set_context("token.test", 0);
        crate::Contract::new(acct("token.test"))
    }
}
```

Create `receive.rs`, `settle.rs`, `refund.rs` and `views.rs` as empty files, so the crate compiles
(an empty file is a valid Rust module). Later tasks fill them in.

- [ ] **Step 4: Run the tests**

To see the red state first, build the crate up in two stages. Write `lib.rs` with only `mod math;` and
the `math.rs` test module of step 2, and run `cargo test -p quorum-pools --lib`: it fails to compile
with `cannot find function bonus_per_seat`. Then add the functions, the other modules and the full
`lib.rs` (step 3) and run it again.

Run: `cargo test -p quorum-pools --lib`
Expected: all `math`, `types`, `events` and `gas` tests PASS (18 tests: 13 in `math`, 3 in `types`, 1
in `events`, 1 in `gas`).

- [ ] **Step 5: Confirm the wasm builds**

Run: `cargo near build non-reproducible-wasm --manifest-path contracts/pools/Cargo.toml`
Expected: a `quorum_pools.wasm` under `target/near/`. Warnings for unused items are fine until later
tasks use them.

- [ ] **Step 6: Commit**

In `CLAUDE.md`, add this row to the Layout table:

| Path | Content |
|---|---|
| `contracts/pools/` | The pools escrow contract |

```bash
git add Cargo.toml contracts/pools CLAUDE.md
git commit -m "add the pools crate skeleton with amount maths, events and gas helpers"
```

---

### Task 4: Open a pool

**Files:**
- Modify: `contracts/pools/src/receive.rs`

**Interfaces:**
- Consumes: `Contract`, `Pool`, `PoolStatus`, `Msg`, `OpenParams`, `MAX_TARGET`, `MAX_TERMS_BYTES`,
  `events::pool_opened`, `testutil::*`.
- Produces: `Contract::open_pool(&mut self, seller: AccountId, bonus: u128, p: OpenParams, now_ms: u64)
  -> u64` (returns the new pool id) and the public method `ft_on_transfer(&mut self, sender_id:
  AccountId, amount: U128, msg: String) -> PromiseOrValue<U128>`, which Task 5 extends with the
  commit message.

- [ ] **Step 1: Write the failing tests**

`contracts/pools/src/receive.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::*;

    fn params() -> OpenParams {
        OpenParams {
            seat_price: 2_000_000,
            target: 4,
            deadline_ms: 10_000,
            max_seats_per_buyer: None,
            terms: "block".to_string(),
        }
    }

    #[test]
    fn opening_creates_an_open_pool_holding_the_bonus() {
        let mut c = new_contract();
        let id = c.open_pool(acct("seller.test"), 10_000_000, params(), 1_000);
        assert_eq!(id, 0);
        let pool = c.pools.get(&0).unwrap();
        assert_eq!(pool.status, PoolStatus::Open);
        assert_eq!(pool.bonus, 10_000_000);
        assert_eq!(pool.taken, 0);
        assert_eq!(pool.seller, acct("seller.test"));
    }

    #[test]
    fn pool_ids_count_up_from_zero() {
        let mut c = new_contract();
        assert_eq!(c.open_pool(acct("seller.test"), 1, params(), 1_000), 0);
        assert_eq!(c.open_pool(acct("seller.test"), 1, params(), 1_000), 1);
    }

    #[test]
    fn a_bonus_of_zero_is_allowed() {
        let mut c = new_contract();
        c.open_pool(acct("seller.test"), 0, params(), 1_000);
        assert_eq!(c.pools.get(&0).unwrap().bonus, 0);
    }

    #[test]
    #[should_panic(expected = "seat_price must be positive")]
    fn a_free_seat_is_refused() {
        let mut c = new_contract();
        let mut p = params();
        p.seat_price = 0;
        c.open_pool(acct("seller.test"), 1, p, 1_000);
    }

    #[test]
    #[should_panic(expected = "target must be between 1 and 1000")]
    fn a_target_of_zero_is_refused() {
        let mut c = new_contract();
        let mut p = params();
        p.target = 0;
        c.open_pool(acct("seller.test"), 1, p, 1_000);
    }

    #[test]
    #[should_panic(expected = "target must be between 1 and 1000")]
    fn a_target_above_the_limit_is_refused() {
        let mut c = new_contract();
        let mut p = params();
        p.target = 1001;
        c.open_pool(acct("seller.test"), 1, p, 1_000);
    }

    #[test]
    #[should_panic(expected = "deadline must be in the future")]
    fn a_deadline_that_is_now_is_refused() {
        let mut c = new_contract();
        let mut p = params();
        p.deadline_ms = 1_000;
        c.open_pool(acct("seller.test"), 1, p, 1_000);
    }

    #[test]
    #[should_panic(expected = "terms must be at most 280 bytes")]
    fn long_terms_are_refused() {
        let mut c = new_contract();
        let mut p = params();
        p.terms = "x".repeat(281);
        c.open_pool(acct("seller.test"), 1, p, 1_000);
    }

    #[test]
    fn terms_of_exactly_280_bytes_are_accepted() {
        let mut c = new_contract();
        let mut p = params();
        p.terms = "x".repeat(280);
        c.open_pool(acct("seller.test"), 1, p, 1_000);
    }

    #[test]
    #[should_panic(expected = "max_seats_per_buyer must be at least 1")]
    fn a_cap_of_zero_is_refused() {
        let mut c = new_contract();
        let mut p = params();
        p.max_seats_per_buyer = Some(0);
        c.open_pool(acct("seller.test"), 1, p, 1_000);
    }

    #[test]
    fn the_message_opens_a_pool_and_returns_nothing_unused() {
        let mut c = new_contract();
        set_context("token.test", 1_000);
        let msg = r#"{"open":{"seat_price":"2000000","target":4,"deadline_ms":10000,"max_seats_per_buyer":2,"terms":"block"}}"#;
        let out = c.ft_on_transfer(acct("seller.test"), U128(10_000_000), msg.to_string());
        match out {
            PromiseOrValue::Value(unused) => assert_eq!(unused.0, 0),
            _ => panic!("expected an immediate value"),
        }
        assert_eq!(c.pools.get(&0).unwrap().max_seats_per_buyer, Some(2));
    }

    #[test]
    #[should_panic(expected = "only the pool token is accepted")]
    fn another_token_is_refused() {
        let mut c = new_contract();
        set_context("other.test", 1_000);
        let _ = c.ft_on_transfer(acct("seller.test"), U128(1), r#"{"open":{}}"#.to_string());
    }

    #[test]
    #[should_panic(expected = "invalid message")]
    fn a_garbled_message_is_refused() {
        let mut c = new_contract();
        set_context("token.test", 1_000);
        let _ = c.ft_on_transfer(acct("seller.test"), U128(1), "not json".to_string());
    }
}
```

- [ ] **Step 2: Run to see them fail**

Run: `cargo test -p quorum-pools --lib receive`
Expected: compile errors, `cannot find type OpenParams` / `no method named open_pool`.

- [ ] **Step 3: Write the implementation**

Put this at the top of `contracts/pools/src/receive.rs`, above the tests module:

```rust
use near_sdk::json_types::U128;
use near_sdk::{env, near, require, AccountId, PromiseOrValue};

use crate::{events, math};
use crate::{Contract, ContractExt, Msg, OpenParams, Pool, PoolStatus, MAX_TARGET, MAX_TERMS_BYTES};

#[near]
impl Contract {
    /// NEP-141 receiver. The token calls this when someone sends it tokens with
    /// `ft_transfer_call`. A panic here makes the token return the whole amount to the sender.
    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        require!(
            env::predecessor_account_id() == self.token,
            "only the pool token is accepted"
        );
        let message: Msg = near_sdk::serde_json::from_str(&msg)
            .unwrap_or_else(|_| env::panic_str("invalid message"));
        let now_ms = env::block_timestamp_ms();
        match message {
            Msg::Open {
                seat_price,
                target,
                deadline_ms,
                max_seats_per_buyer,
                terms,
            } => {
                let params = OpenParams {
                    seat_price: seat_price.0,
                    target,
                    deadline_ms,
                    max_seats_per_buyer,
                    terms,
                };
                self.open_pool(sender_id, amount.0, params, now_ms);
                PromiseOrValue::Value(U128(0))
            }
            Msg::Commit { .. } => env::panic_str("commit is not implemented yet"),
        }
    }
}

impl Contract {
    /// Opens a pool for `seller`, which has just escrowed `bonus`. Returns the new pool's id.
    pub(crate) fn open_pool(
        &mut self,
        seller: AccountId,
        bonus: u128,
        p: OpenParams,
        now_ms: u64,
    ) -> u64 {
        require!(p.seat_price > 0, "seat_price must be positive");
        require!(
            (1..=MAX_TARGET).contains(&p.target),
            "target must be between 1 and 1000"
        );
        require!(p.deadline_ms > now_ms, "deadline must be in the future");
        require!(
            p.terms.len() <= MAX_TERMS_BYTES,
            "terms must be at most 280 bytes"
        );
        if let Some(cap) = p.max_seats_per_buyer {
            require!(cap >= 1, "max_seats_per_buyer must be at least 1");
        }
        let id = self.next_pool_id;
        self.next_pool_id = id
            .checked_add(1)
            .unwrap_or_else(|| env::panic_str("pool id overflows"));
        events::pool_opened(
            id,
            &seller,
            p.seat_price,
            p.target,
            p.deadline_ms,
            bonus,
            &p.terms,
        );
        self.pools.insert(
            id,
            Pool {
                seller,
                seat_price: p.seat_price,
                target: p.target,
                taken: 0,
                deadline_ms: p.deadline_ms,
                bonus,
                max_seats_per_buyer: p.max_seats_per_buyer,
                terms: p.terms,
                status: PoolStatus::Open,
                bonus_per_seat: 0,
                refund_cursor: 0,
                dust_sent: false,
                buyer_count: 0,
            },
        );
        id
    }
}
```

`math` is imported for Task 5; if the compiler warns that it is unused now, that is expected.

- [ ] **Step 4: Run the tests**

Run: `cargo test -p quorum-pools --lib`
Expected: all tests PASS, including the 13 new ones in `receive`.

- [ ] **Step 5: Commit**

```bash
git add contracts/pools/src/receive.rs
git commit -m "open a pool through ft_on_transfer with its bonus"
```

---

### Task 5: Commit seats

**Files:**
- Modify: `contracts/pools/src/receive.rs`

**Interfaces:**
- Consumes: everything from Task 4, `math::price_of`, `events::{seats_committed, pool_filled}`,
  `Buyer`, `BuyerState`, `Contract.slots`, `Contract.buyers`.
- Produces: `Contract::commit_seats(&mut self, buyer: AccountId, amount: u128, pool_id: u64, seats:
  u32, now_ms: u64) -> u128` (returns the amount to give back, which `ft_on_transfer` reports as
  unused), and `ft_on_transfer` now handling `Msg::Commit`.

- [ ] **Step 1: Write the failing tests**

Add to the `tests` module in `receive.rs`:

```rust
    fn open_pool_with(c: &mut Contract, target: u32, cap: Option<u32>) -> u64 {
        let mut p = params();
        p.target = target;
        p.max_seats_per_buyer = cap;
        c.open_pool(acct("seller.test"), 10_000_000, p, 1_000)
    }

    #[test]
    fn a_commit_records_the_buyer_and_the_seats() {
        let mut c = new_contract();
        let id = open_pool_with(&mut c, 4, None);
        let unused = c.commit_seats(acct("a.test"), 4_000_000, id, 2, 2_000);
        assert_eq!(unused, 0);
        let pool = c.pools.get(&id).unwrap();
        assert_eq!((pool.taken, pool.buyer_count), (2, 1));
        let buyer = c.buyers.get(&(id, acct("a.test"))).unwrap();
        assert_eq!((buyer.slot, buyer.seats, buyer.state), (0, 2, BuyerState::Committed));
        assert_eq!(c.slots.get(&(id, 0)).unwrap(), &acct("a.test"));
    }

    #[test]
    fn a_second_commit_adds_to_the_same_record() {
        let mut c = new_contract();
        let id = open_pool_with(&mut c, 4, None);
        c.commit_seats(acct("a.test"), 2_000_000, id, 1, 2_000);
        c.commit_seats(acct("a.test"), 2_000_000, id, 1, 2_000);
        let pool = c.pools.get(&id).unwrap();
        assert_eq!((pool.taken, pool.buyer_count), (2, 1));
        assert_eq!(c.buyers.get(&(id, acct("a.test"))).unwrap().seats, 2);
    }

    #[test]
    fn buyers_keep_their_commit_order() {
        let mut c = new_contract();
        let id = open_pool_with(&mut c, 4, None);
        c.commit_seats(acct("a.test"), 2_000_000, id, 1, 2_000);
        c.commit_seats(acct("b.test"), 2_000_000, id, 1, 2_000);
        assert_eq!(c.slots.get(&(id, 0)).unwrap(), &acct("a.test"));
        assert_eq!(c.slots.get(&(id, 1)).unwrap(), &acct("b.test"));
    }

    #[test]
    fn the_last_seat_fills_the_pool() {
        let mut c = new_contract();
        let id = open_pool_with(&mut c, 2, None);
        c.commit_seats(acct("a.test"), 2_000_000, id, 1, 2_000);
        c.commit_seats(acct("b.test"), 2_000_000, id, 1, 2_000);
        assert_eq!(c.pools.get(&id).unwrap().status, PoolStatus::Filled);
    }

    #[test]
    fn paying_for_more_seats_than_are_left_takes_the_rest_and_returns_the_excess() {
        let mut c = new_contract();
        let id = open_pool_with(&mut c, 3, None);
        c.commit_seats(acct("a.test"), 4_000_000, id, 2, 2_000);
        let unused = c.commit_seats(acct("b.test"), 4_000_000, id, 2, 2_000);
        assert_eq!(unused, 2_000_000);
        let pool = c.pools.get(&id).unwrap();
        assert_eq!((pool.taken, pool.status), (3, PoolStatus::Filled));
        assert_eq!(c.buyers.get(&(id, acct("b.test"))).unwrap().seats, 1);
    }

    #[test]
    #[should_panic(expected = "pool not found")]
    fn an_unknown_pool_is_refused() {
        let mut c = new_contract();
        c.commit_seats(acct("a.test"), 2_000_000, 9, 1, 2_000);
    }

    #[test]
    #[should_panic(expected = "pool is not open")]
    fn a_filled_pool_takes_no_more_seats() {
        let mut c = new_contract();
        let id = open_pool_with(&mut c, 1, None);
        c.commit_seats(acct("a.test"), 2_000_000, id, 1, 2_000);
        c.commit_seats(acct("b.test"), 2_000_000, id, 1, 2_000);
    }

    #[test]
    #[should_panic(expected = "pool is past its deadline")]
    fn a_commit_at_the_deadline_is_refused() {
        let mut c = new_contract();
        let id = open_pool_with(&mut c, 4, None);
        c.commit_seats(acct("a.test"), 2_000_000, id, 1, 10_000);
    }

    #[test]
    fn a_commit_just_before_the_deadline_is_accepted() {
        let mut c = new_contract();
        let id = open_pool_with(&mut c, 4, None);
        c.commit_seats(acct("a.test"), 2_000_000, id, 1, 9_999);
    }

    #[test]
    #[should_panic(expected = "the seller cannot commit to its own pool")]
    fn the_seller_cannot_commit() {
        let mut c = new_contract();
        let id = open_pool_with(&mut c, 4, None);
        c.commit_seats(acct("seller.test"), 2_000_000, id, 1, 2_000);
    }

    #[test]
    #[should_panic(expected = "seats must be at least 1")]
    fn zero_seats_are_refused() {
        let mut c = new_contract();
        let id = open_pool_with(&mut c, 4, None);
        c.commit_seats(acct("a.test"), 0, id, 0, 2_000);
    }

    #[test]
    #[should_panic(expected = "amount must equal seats times seat_price")]
    fn the_wrong_amount_is_refused() {
        let mut c = new_contract();
        let id = open_pool_with(&mut c, 4, None);
        c.commit_seats(acct("a.test"), 3_000_000, id, 2, 2_000);
    }

    #[test]
    #[should_panic(expected = "commit exceeds max_seats_per_buyer")]
    fn the_per_buyer_cap_counts_seats_already_held() {
        let mut c = new_contract();
        let id = open_pool_with(&mut c, 8, Some(2));
        c.commit_seats(acct("a.test"), 4_000_000, id, 2, 2_000);
        c.commit_seats(acct("a.test"), 2_000_000, id, 1, 2_000);
    }

    #[test]
    fn the_cap_is_checked_against_the_seats_asked_for_not_the_seats_left() {
        let mut c = new_contract();
        let id = open_pool_with(&mut c, 3, Some(3));
        c.commit_seats(acct("a.test"), 4_000_000, id, 2, 2_000);
        // asks for 3 (within the cap of 3), only 1 is left: takes 1, returns the rest
        let unused = c.commit_seats(acct("b.test"), 6_000_000, id, 3, 2_000);
        assert_eq!(unused, 4_000_000);
    }

    #[test]
    fn the_commit_message_reaches_commit_seats() {
        let mut c = new_contract();
        let id = open_pool_with(&mut c, 4, None);
        set_context("token.test", 2_000);
        let msg = format!(r#"{{"commit":{{"pool_id":{id},"seats":2}}}}"#);
        let out = c.ft_on_transfer(acct("a.test"), U128(4_000_000), msg);
        match out {
            PromiseOrValue::Value(unused) => assert_eq!(unused.0, 0),
            _ => panic!("expected an immediate value"),
        }
        assert_eq!(c.pools.get(&id).unwrap().taken, 2);
    }
```

- [ ] **Step 2: Run to see them fail**

Run: `cargo test -p quorum-pools --lib receive`
Expected: compile error `no method named commit_seats`.

- [ ] **Step 3: Write the implementation**

In `receive.rs`, extend the imports:

```rust
use crate::{Buyer, BuyerState};
```

Replace the `Msg::Commit { .. } => env::panic_str("commit is not implemented yet"),` arm of
`ft_on_transfer` with:

```rust
            Msg::Commit { pool_id, seats } => {
                let unused = self.commit_seats(sender_id, amount.0, pool_id, seats, now_ms);
                PromiseOrValue::Value(U128(unused))
            }
```

Add inside the plain `impl Contract` block (the one holding `open_pool`):

```rust
    /// Takes `buyer`'s seats in a pool, for a payment of `amount`. Returns the part of the payment
    /// to give back: the price of any requested seats the pool had no room for.
    pub(crate) fn commit_seats(
        &mut self,
        buyer: AccountId,
        amount: u128,
        pool_id: u64,
        seats: u32,
        now_ms: u64,
    ) -> u128 {
        let pool = self
            .pools
            .get_mut(&pool_id)
            .unwrap_or_else(|| env::panic_str("pool not found"));
        require!(pool.status == PoolStatus::Open, "pool is not open");
        require!(now_ms < pool.deadline_ms, "pool is past its deadline");
        require!(
            buyer != pool.seller,
            "the seller cannot commit to its own pool"
        );
        require!(seats >= 1, "seats must be at least 1");
        require!(
            amount == math::price_of(seats, pool.seat_price),
            "amount must equal seats times seat_price"
        );
        let key = (pool_id, buyer.clone());
        let held = self.buyers.get(&key).map_or(0, |b| b.seats);
        if let Some(cap) = pool.max_seats_per_buyer {
            require!(
                held.checked_add(seats).is_some_and(|total| total <= cap),
                "commit exceeds max_seats_per_buyer"
            );
        }
        let taken_now = seats.min(pool.target - pool.taken);
        require!(taken_now > 0, "no seats left");

        match self.buyers.get_mut(&key) {
            Some(record) => record.seats += taken_now,
            None => {
                let slot = pool.buyer_count;
                self.slots.insert((pool_id, slot), buyer.clone());
                self.buyers.insert(
                    key,
                    Buyer {
                        slot,
                        seats: taken_now,
                        state: BuyerState::Committed,
                    },
                );
                pool.buyer_count += 1;
            }
        }
        pool.taken += taken_now;
        events::seats_committed(
            pool_id,
            &buyer,
            taken_now,
            math::price_of(taken_now, pool.seat_price),
            pool.taken,
            pool.target,
        );
        if pool.taken == pool.target {
            pool.status = PoolStatus::Filled;
            events::pool_filled(pool_id, pool.taken);
        }
        math::price_of(seats - taken_now, pool.seat_price)
    }
```

- [ ] **Step 4: Run the tests**

Run: `cargo test -p quorum-pools --lib`
Expected: all PASS. If the borrow checker rejects holding `pool` while touching `self.buyers` or
`self.slots`, keep the field accesses direct (as written, not through a `&mut self` helper).

- [ ] **Step 5: Commit**

```bash
git add contracts/pools/src/receive.rs
git commit -m "take seats through ft_on_transfer and fill a pool at its target"
```

---

### Task 6: Views

**Files:**
- Modify: `contracts/pools/src/views.rs`

**Interfaces:**
- Consumes: `PoolView::new`, `SeatView`, `BuyerView`, `MAX_PAGE`, `Contract.pools/slots/buyers`.
- Produces: `get_pool(pool_id: u64) -> Option<PoolView>`, `list_pools(from: u64, limit: u64) ->
  Vec<PoolView>`, `get_seats(pool_id: u64, from: u32, limit: u32) -> Vec<SeatView>`,
  `get_buyer(pool_id: u64, account_id: AccountId) -> Option<BuyerView>`, `get_token() -> AccountId`.
  Page size is clamped to `MAX_PAGE`.

- [ ] **Step 1: Write the failing tests**

`contracts/pools/src/views.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::*;
    use crate::{BuyerState, OpenParams, PoolStatus};

    fn open(c: &mut Contract, deadline_ms: u64) -> u64 {
        c.open_pool(
            acct("seller.test"),
            10,
            OpenParams {
                seat_price: 2,
                target: 3,
                deadline_ms,
                max_seats_per_buyer: None,
                terms: "block".to_string(),
            },
            1_000,
        )
    }

    #[test]
    fn an_unknown_pool_reads_as_null() {
        let c = new_contract();
        assert!(c.get_pool(0).is_none());
    }

    #[test]
    fn get_pool_reports_open_before_the_deadline_and_expired_after() {
        let mut c = new_contract();
        let id = open(&mut c, 5_000);
        set_context("anyone.test", 4_999);
        assert_eq!(c.get_pool(id).unwrap().status, PoolStatus::Open);
        set_context("anyone.test", 5_000);
        let view = c.get_pool(id).unwrap();
        assert_eq!(view.status, PoolStatus::Expired);
        // nothing was stored by the read
        assert_eq!(c.pools.get(&id).unwrap().status, PoolStatus::Open);
    }

    #[test]
    fn list_pools_pages_in_id_order() {
        let mut c = new_contract();
        for _ in 0..3 {
            open(&mut c, 5_000);
        }
        let ids: Vec<u64> = c.list_pools(1, 10).iter().map(|p| p.id).collect();
        assert_eq!(ids, vec![1, 2]);
        assert!(c.list_pools(5, 10).is_empty());
    }

    #[test]
    fn seats_and_buyer_views_follow_commit_order() {
        let mut c = new_contract();
        let id = open(&mut c, 5_000);
        c.commit_seats(acct("a.test"), 2, id, 1, 2_000);
        c.commit_seats(acct("b.test"), 2, id, 1, 2_000);
        let seats = c.get_seats(id, 0, 10);
        assert_eq!(seats.len(), 2);
        assert_eq!(seats[0].buyer, acct("a.test"));
        assert_eq!(seats[1].buyer, acct("b.test"));
        assert_eq!(c.get_seats(id, 1, 10).len(), 1);
        let one = c.get_buyer(id, acct("b.test")).unwrap();
        assert_eq!((one.seats, one.state), (1, BuyerState::Committed));
        assert!(c.get_buyer(id, acct("nobody.test")).is_none());
    }

    #[test]
    fn views_of_an_unknown_pool_are_empty() {
        let c = new_contract();
        assert!(c.get_seats(7, 0, 10).is_empty());
        assert!(c.get_buyer(7, acct("a.test")).is_none());
    }

    #[test]
    fn get_token_names_the_token_set_by_new() {
        let c = new_contract();
        assert_eq!(c.get_token(), acct("token.test"));
    }
}
```

- [ ] **Step 2: Run to see them fail**

Run: `cargo test -p quorum-pools --lib views`
Expected: compile error `no method named get_pool`.

- [ ] **Step 3: Write the implementation**

At the top of `views.rs`, above the tests:

```rust
use near_sdk::{env, near, AccountId};

use crate::{BuyerView, Contract, ContractExt, PoolView, SeatView, MAX_PAGE};

#[near]
impl Contract {
    /// Every field of a pool, with the status derived from block time.
    pub fn get_pool(&self, pool_id: u64) -> Option<PoolView> {
        self.pools
            .get(&pool_id)
            .map(|pool| PoolView::new(pool_id, pool, env::block_timestamp_ms()))
    }

    /// Pools in id order, starting at `from`, at most `MAX_PAGE` per call.
    pub fn list_pools(&self, from: u64, limit: u64) -> Vec<PoolView> {
        let end = from
            .saturating_add(limit.min(MAX_PAGE))
            .min(self.next_pool_id);
        (from..end).filter_map(|id| self.get_pool(id)).collect()
    }

    /// A pool's buyers in the order they first committed, at most `MAX_PAGE` per call.
    pub fn get_seats(&self, pool_id: u64, from: u32, limit: u32) -> Vec<SeatView> {
        let Some(pool) = self.pools.get(&pool_id) else {
            return Vec::new();
        };
        let page = u32::try_from(MAX_PAGE).unwrap_or(u32::MAX);
        let end = from.saturating_add(limit.min(page)).min(pool.buyer_count);
        (from..end)
            .map(|slot| {
                let buyer = self
                    .slots
                    .get(&(pool_id, slot))
                    .unwrap_or_else(|| env::panic_str("missing buyer slot"));
                let record = self
                    .buyers
                    .get(&(pool_id, buyer.clone()))
                    .unwrap_or_else(|| env::panic_str("missing buyer record"));
                SeatView {
                    buyer: buyer.clone(),
                    seats: record.seats,
                    state: record.state,
                }
            })
            .collect()
    }

    /// One buyer's seats and state in a pool, or null.
    pub fn get_buyer(&self, pool_id: u64, account_id: AccountId) -> Option<BuyerView> {
        self.buyers
            .get(&(pool_id, account_id))
            .map(|record| BuyerView {
                seats: record.seats,
                state: record.state,
            })
    }

    /// The one token this contract accepts, as set by `new`.
    pub fn get_token(&self) -> AccountId {
        self.token.clone()
    }
}
```

- [ ] **Step 4: Run the tests**

Run: `cargo test -p quorum-pools --lib`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add contracts/pools/src/views.rs
git commit -m "add the pool, seat and token views, with a status derived from block time"
```

---

### Task 7: Sandbox world, open and commit scenarios

**Files:**
- Create: `contracts/pools/tests/common/mod.rs`, `contracts/pools/tests/open_commit.rs`

**Interfaces:**
- Consumes: `quorum_sandbox_support::{Chain, Outcome, token_wasm, pools_wasm}`; the contract's methods
  from Tasks 3 to 6.
- Produces (`World`, used by Tasks 8 to 11): constants `MUSD: u128 = 1_000_000` and `DEADLINE_MS: u64 =
  600_000`;
  `World { chain: Chain, token: AccountId, pools: AccountId }`;
  `World::new() -> Result<World>`;
  `user(&self, name: &str, musd: u128) -> Result<AccountId>` (creates, registers on the token, mints
  `musd` whole mUSD);
  `mint(&self, who: &AccountId, musd: u128) -> Result<()>`;
  `register(&self, who: &AccountId) -> Result<()>`; `unregister(&self, who: &AccountId) -> Result<()>`;
  `balance(&self, who: &AccountId) -> Result<u128>`;
  `deadline_in(&self, offset_ms: u64) -> Result<u64>`;
  `transfer_call(&self, from: &AccountId, amount: u128, msg: Value) -> Result<Outcome>`;
  `open(&self, seller: &AccountId, bonus: u128, price: u128, target: u32, deadline_ms: u64, cap: Option<u32>) -> Result<u64>`;
  `commit(&self, buyer: &AccountId, pool_id: u64, seats: u32, price: u128) -> Result<Outcome>`;
  `settle(&self, caller: &AccountId, pool_id: u64) -> Result<Outcome>`;
  `refund(&self, caller: &AccountId, pool_id: u64, limit: u32, tgas: u64) -> Result<Outcome>`;
  `claim(&self, caller: &AccountId, pool_id: u64) -> Result<Outcome>`;
  `pool(&self, pool_id: u64) -> Result<Value>`;
  `seats(&self, pool_id: u64) -> Result<Value>`;
  `pool_count(&self) -> Result<usize>`;
  `expire(&self, pool_id: u64) -> Result<()>` (waits until the pool's deadline has passed);
  `check_invariants(&self) -> Result<()>`.

- [ ] **Step 1: Write the world and the invariant check**

`contracts/pools/tests/common/mod.rs`:

```rust
#![allow(dead_code)]

use anyhow::{anyhow, bail, Result};
pub use quorum_sandbox_support::AccountId;
use quorum_sandbox_support::{pools_wasm, token_wasm, Chain, Outcome};
use serde_json::{json, Value};

pub const MUSD: u128 = 1_000_000;
const MINT_CAP: u128 = 1_000 * MUSD;
const STORAGE_DEPOSIT: u128 = 10_000_000_000_000_000_000_000; // 0.01 NEAR; the excess is refunded

/// The deadline offset for every pool. It is long enough to cover a scenario's slow setup, so no
/// pool expires by accident; a scenario that wants a pool to expire moves the sandbox clock past
/// the deadline with `World::expire`.
pub const DEADLINE_MS: u64 = 600_000;

pub struct World {
    pub chain: Chain,
    pub token: AccountId,
    pub pools: AccountId,
}

fn amount(value: &Value) -> u128 {
    value
        .as_str()
        .expect("a decimal string")
        .parse()
        .expect("a u128")
}

impl World {
    /// Starts a sandbox, deploys the token and the pools contract (initialised in its deploy
    /// transaction), and registers the pools contract on the token.
    pub async fn new() -> Result<Self> {
        let chain = Chain::start().await?;
        let token = chain
            .deploy("musd", token_wasm()?, Some(("new", json!({}))))
            .await?;
        let pools = chain
            .deploy(
                "pools",
                pools_wasm()?,
                Some(("new", json!({ "token": token }))),
            )
            .await?;
        let world = Self {
            chain,
            token,
            pools,
        };
        world.register(&world.pools.clone()).await?;
        Ok(world)
    }

    pub async fn register(&self, who: &AccountId) -> Result<()> {
        let out = self
            .chain
            .call(
                who,
                &self.token,
                "storage_deposit",
                json!({ "account_id": who, "registration_only": true }),
                30,
                STORAGE_DEPOSIT,
            )
            .await?;
        if !out.ok {
            bail!("storage_deposit failed: {}", out.debug);
        }
        Ok(())
    }

    /// Removes `who` from the token, burning any balance, so that transfers to it fail.
    pub async fn unregister(&self, who: &AccountId) -> Result<()> {
        let out = self
            .chain
            .call(
                who,
                &self.token,
                "storage_unregister",
                json!({ "force": true }),
                30,
                1,
            )
            .await?;
        if !out.ok {
            bail!("storage_unregister failed: {}", out.debug);
        }
        Ok(())
    }

    /// Mints `musd` whole mUSD to a registered account, in chunks under the per-call cap.
    pub async fn mint(&self, who: &AccountId, musd: u128) -> Result<()> {
        let mut left = musd * MUSD;
        while left > 0 {
            let part = left.min(MINT_CAP);
            let out = self
                .chain
                .call(
                    who,
                    &self.token,
                    "mint",
                    json!({ "account_id": who, "amount": part.to_string() }),
                    30,
                    0,
                )
                .await?;
            if !out.ok {
                bail!("mint failed: {}", out.debug);
            }
            left -= part;
        }
        Ok(())
    }

    /// Creates `<name>.sandbox` with 10 NEAR, registers it on the token and mints it `musd` mUSD.
    pub async fn user(&self, name: &str, musd: u128) -> Result<AccountId> {
        let id = self.chain.create_account(name, 10).await?;
        self.register(&id).await?;
        self.mint(&id, musd).await?;
        Ok(id)
    }

    pub async fn balance(&self, who: &AccountId) -> Result<u128> {
        let value = self
            .chain
            .view(&self.token, "ft_balance_of", json!({ "account_id": who }))
            .await?;
        Ok(amount(&value))
    }

    pub async fn deadline_in(&self, offset_ms: u64) -> Result<u64> {
        Ok(self.chain.now_ms().await? + offset_ms)
    }

    /// `ft_transfer_call` of `amount` base units from `from` to the pools contract.
    pub async fn transfer_call(&self, from: &AccountId, amount: u128, msg: Value) -> Result<Outcome> {
        self.chain
            .call(
                from,
                &self.token,
                "ft_transfer_call",
                json!({
                    "receiver_id": self.pools,
                    "amount": amount.to_string(),
                    "msg": serde_json::to_string(&msg)?,
                }),
                100,
                1,
            )
            .await
    }

    pub async fn pool_count(&self) -> Result<usize> {
        let pools = self
            .chain
            .view(&self.pools, "list_pools", json!({ "from": 0, "limit": 100 }))
            .await?;
        Ok(pools.as_array().ok_or_else(|| anyhow!("not an array"))?.len())
    }

    /// Opens a pool by sending `bonus` with an `open` message. Fails if the contract refused it.
    pub async fn open(
        &self,
        seller: &AccountId,
        bonus: u128,
        price: u128,
        target: u32,
        deadline_ms: u64,
        cap: Option<u32>,
    ) -> Result<u64> {
        let before = self.pool_count().await?;
        let msg = json!({ "open": {
            "seat_price": price.to_string(), "target": target, "deadline_ms": deadline_ms,
            "max_seats_per_buyer": cap, "terms": "test block",
        }});
        let out = self.transfer_call(seller, bonus, msg).await?;
        if !out.ok || self.pool_count().await? != before + 1 {
            bail!("the pool was not opened: {}", out.debug);
        }
        Ok(before as u64)
    }

    pub async fn commit(
        &self,
        buyer: &AccountId,
        pool_id: u64,
        seats: u32,
        price: u128,
    ) -> Result<Outcome> {
        let msg = json!({ "commit": { "pool_id": pool_id, "seats": seats } });
        self.transfer_call(buyer, u128::from(seats) * price, msg).await
    }

    pub async fn settle(&self, caller: &AccountId, pool_id: u64) -> Result<Outcome> {
        self.chain
            .call(caller, &self.pools, "settle", json!({ "pool_id": pool_id }), 100, 0)
            .await
    }

    pub async fn refund(
        &self,
        caller: &AccountId,
        pool_id: u64,
        limit: u32,
        tgas: u64,
    ) -> Result<Outcome> {
        self.chain
            .call(
                caller,
                &self.pools,
                "refund",
                json!({ "pool_id": pool_id, "limit": limit }),
                tgas,
                0,
            )
            .await
    }

    pub async fn claim(&self, caller: &AccountId, pool_id: u64) -> Result<Outcome> {
        self.chain
            .call(caller, &self.pools, "claim_refund", json!({ "pool_id": pool_id }), 100, 0)
            .await
    }

    pub async fn pool(&self, pool_id: u64) -> Result<Value> {
        let value = self
            .chain
            .view(&self.pools, "get_pool", json!({ "pool_id": pool_id }))
            .await?;
        if value.is_null() {
            bail!("pool {pool_id} does not exist");
        }
        Ok(value)
    }

    pub async fn seats(&self, pool_id: u64) -> Result<Value> {
        self.chain
            .view(
                &self.pools,
                "get_seats",
                json!({ "pool_id": pool_id, "from": 0, "limit": 100 }),
            )
            .await
    }

    /// Moves the sandbox clock past a pool's deadline.
    pub async fn expire(&self, pool_id: u64) -> Result<()> {
        let deadline = self.pool(pool_id).await?["deadline_ms"]
            .as_u64()
            .ok_or_else(|| anyhow!("no deadline"))?;
        self.chain.wait_past(deadline).await
    }

    /// Checks invariants 1, 2 and 4 of the spec's section 5.5 over every pool:
    /// 1. the contract's token balance covers everything it still owes;
    /// 2. no pool has more seats taken than its target;
    /// 4. for a pool that expired, buyer refunds plus the dust equal what the pool took in.
    ///
    /// Invariants 3 (a pool's money leaves in exactly one way) and 5 (a buyer is paid at most once)
    /// are covered by the balance assertions in the scenarios, which compare every buyer's and the
    /// seller's balance after each payout. The rule that a pool only fills before its deadline is
    /// covered by the commit unit tests and by the settle-after-deadline scenario.
    pub async fn check_invariants(&self) -> Result<()> {
        let pools = self
            .chain
            .view(&self.pools, "list_pools", json!({ "from": 0, "limit": 100 }))
            .await?;
        let mut owed: u128 = 0;
        for p in pools.as_array().ok_or_else(|| anyhow!("not an array"))? {
            let id = p["id"].as_u64().unwrap();
            let price = amount(&p["seat_price"]);
            let bonus = amount(&p["bonus"]);
            let per_seat = amount(&p["bonus_per_seat"]);
            let taken = u128::from(p["taken"].as_u64().unwrap());
            let target = u128::from(p["target"].as_u64().unwrap());
            if taken > target {
                bail!("pool {id}: {taken} seats taken, target {target}");
            }
            match p["status"].as_str().unwrap() {
                "open" | "filled" => owed += taken * price + bonus,
                "settled" => {}
                "expired" | "refunded" => {
                    let rows = self.seats(id).await?;
                    let mut all_refunds = 0u128;
                    let mut still_owed = 0u128;
                    for row in rows.as_array().unwrap() {
                        let n = u128::from(row["seats"].as_u64().unwrap());
                        let refund = n * (price + per_seat);
                        all_refunds += refund;
                        if matches!(row["state"].as_str().unwrap(), "committed" | "claimable") {
                            still_owed += refund;
                        }
                    }
                    let dust = bonus - per_seat * taken;
                    if all_refunds + dust != taken * price + bonus {
                        bail!("pool {id}: refunds {all_refunds} + dust {dust} != {}", taken * price + bonus);
                    }
                    owed += still_owed;
                    if !p["dust_sent"].as_bool().unwrap() {
                        owed += dust;
                    }
                }
                other => bail!("pool {id}: unknown status {other}"),
            }
        }
        let held = self.balance(&self.pools).await?;
        if held < owed {
            bail!("the contract holds {held} but owes {owed}");
        }
        Ok(())
    }
}
```

- [ ] **Step 2: Write the open and commit scenarios**

The contract methods these scenarios call exist already (Tasks 4 to 6), so they should pass on their
first run: they check the contract end to end against a real token, and prove the world helper.

`contracts/pools/tests/open_commit.rs`:

```rust
mod common;

use common::*;
use serde_json::json;

/// How block time behaves in the sandbox decides how the other scenarios wait for a deadline.
#[tokio::test]
async fn block_time_moves_forward_with_blocks() -> anyhow::Result<()> {
    let w = World::new().await?;
    let before = w.chain.now_ms().await?;
    w.chain.fast_forward(1000).await?;
    let after = w.chain.now_ms().await?;
    println!("block time moved {} ms over 1000 blocks", after - before);
    assert!(after > before, "block time did not advance");
    Ok(())
}

#[tokio::test]
async fn a_pool_fills_with_exact_commits() -> anyhow::Result<()> {
    let w = World::new().await?;
    let seller = w.user("seller", 10).await?;
    let (a, b, c) = (w.user("a", 10).await?, w.user("b", 10).await?, w.user("c", 10).await?);
    let deadline = w.deadline_in(DEADLINE_MS).await?;

    let id = w.open(&seller, 10 * MUSD, 2 * MUSD, 4, deadline, None).await?;
    w.check_invariants().await?;
    assert_eq!(w.balance(&seller).await?, 0, "the whole balance went in as the bonus");
    assert_eq!(w.pool(id).await?["status"], "open");

    assert!(w.commit(&a, id, 2, 2 * MUSD).await?.ok);
    w.check_invariants().await?;
    assert!(w.commit(&b, id, 1, 2 * MUSD).await?.ok);
    assert!(w.commit(&c, id, 1, 2 * MUSD).await?.ok);
    w.check_invariants().await?;

    let pool = w.pool(id).await?;
    assert_eq!(pool["status"], "filled");
    assert_eq!(pool["taken"], 4);
    assert_eq!(w.balance(&w.pools).await?, 18 * MUSD, "8 mUSD of seats plus the 10 mUSD bonus");
    assert_eq!(w.balance(&a).await?, 6 * MUSD);
    Ok(())
}

#[tokio::test]
async fn a_partial_last_commit_takes_the_seats_left_and_returns_the_rest() -> anyhow::Result<()> {
    let w = World::new().await?;
    let seller = w.user("seller", 10).await?;
    let (a, b) = (w.user("a", 10).await?, w.user("b", 10).await?);
    let deadline = w.deadline_in(DEADLINE_MS).await?;
    let id = w.open(&seller, 10 * MUSD, 2 * MUSD, 3, deadline, None).await?;

    assert!(w.commit(&a, id, 2, 2 * MUSD).await?.ok);
    assert!(w.commit(&b, id, 2, 2 * MUSD).await?.ok); // asks for 2, only 1 is left
    w.check_invariants().await?;

    assert_eq!(w.pool(id).await?["status"], "filled");
    assert_eq!(w.balance(&b).await?, 8 * MUSD, "paid 4, got 2 back");
    let row = w.chain.view(&w.pools, "get_buyer", json!({ "pool_id": id, "account_id": b })).await?;
    assert_eq!(row["seats"], 1);
    Ok(())
}

#[tokio::test]
async fn refused_commits_return_the_money() -> anyhow::Result<()> {
    let w = World::new().await?;
    let seller = w.user("seller", 10).await?;
    let (a, b) = (w.user("a", 10).await?, w.user("b", 10).await?);
    let deadline = w.deadline_in(DEADLINE_MS).await?;
    let id = w.open(&seller, 10 * MUSD, 2 * MUSD, 8, deadline, Some(2)).await?;
    w.mint(&seller, 4).await?;

    // the wrong amount for the seats asked for
    let wrong = w
        .transfer_call(&b, 3 * MUSD, json!({ "commit": { "pool_id": id, "seats": 2 } }))
        .await?;
    assert!(wrong.ok, "the token call itself succeeds and refunds");
    assert_eq!(w.balance(&b).await?, 10 * MUSD);

    // the seller committing to its own pool
    w.commit(&seller, id, 1, 2 * MUSD).await?;
    assert_eq!(w.balance(&seller).await?, 4 * MUSD);

    // a commit past the per-buyer cap of 2
    assert!(w.commit(&a, id, 2, 2 * MUSD).await?.ok);
    w.commit(&a, id, 1, 2 * MUSD).await?;
    assert_eq!(w.balance(&a).await?, 6 * MUSD);

    let pool = w.pool(id).await?;
    assert_eq!(pool["taken"], 2, "only the one valid commit was taken");
    w.check_invariants().await?;
    Ok(())
}

#[tokio::test]
async fn a_payment_in_another_token_is_refused() -> anyhow::Result<()> {
    let w = World::new().await?;
    let fake = w
        .chain
        .deploy("fake", quorum_sandbox_support::token_wasm()?, Some(("new", json!({}))))
        .await?;
    let seller = w.chain.create_account("seller", 10).await?;
    let storage = 10_000_000_000_000_000_000_000u128;
    for who in [&seller, &w.pools] {
        w.chain
            .call(who, &fake, "storage_deposit", json!({ "account_id": who, "registration_only": true }), 30, storage)
            .await?;
    }
    w.chain
        .call(&seller, &fake, "mint", json!({ "account_id": seller, "amount": "10000000" }), 30, 0)
        .await?;
    let deadline = w.deadline_in(DEADLINE_MS).await?;
    let msg = json!({ "open": {
        "seat_price": "2000000", "target": 4, "deadline_ms": deadline,
        "max_seats_per_buyer": null, "terms": "x",
    }});
    w.chain
        .call(
            &seller,
            &fake,
            "ft_transfer_call",
            json!({ "receiver_id": w.pools, "amount": "10000000", "msg": serde_json::to_string(&msg)? }),
            100,
            1,
        )
        .await?;

    assert_eq!(w.pool_count().await?, 0, "no pool was opened");
    let back = w.chain.view(&fake, "ft_balance_of", json!({ "account_id": seller })).await?;
    assert_eq!(back, "10000000", "the other token was returned");
    Ok(())
}

#[tokio::test]
async fn a_commit_after_the_deadline_is_refused() -> anyhow::Result<()> {
    let w = World::new().await?;
    let seller = w.user("seller", 10).await?;
    let a = w.user("a", 10).await?;
    let deadline = w.deadline_in(DEADLINE_MS).await?;
    let id = w.open(&seller, 10 * MUSD, 2 * MUSD, 4, deadline, None).await?;

    w.expire(id).await?;
    assert_eq!(w.pool(id).await?["status"], "expired", "the view reports expiry before any call stores it");

    w.commit(&a, id, 1, 2 * MUSD).await?;
    assert_eq!(w.balance(&a).await?, 10 * MUSD, "the payment came back");
    assert_eq!(w.pool(id).await?["taken"], 0);
    w.check_invariants().await?;
    Ok(())
}

#[tokio::test]
async fn the_contract_cannot_be_initialised_again_or_by_another_account() -> anyhow::Result<()> {
    let w = World::new().await?;
    let stranger = w.chain.create_account("stranger", 10).await?;

    // another account cannot choose the token
    let by_stranger = w
        .chain
        .call(&stranger, &w.pools, "new", json!({ "token": stranger }), 30, 0)
        .await?;
    assert!(!by_stranger.ok);

    // the contract account itself cannot run `new` a second time
    let again = w
        .chain
        .call(&w.pools, &w.pools, "new", json!({ "token": stranger }), 30, 0)
        .await?;
    assert!(!again.ok);

    // the token is still the one set at deployment: a payment in it still opens a pool
    let seller = w.user("seller", 10).await?;
    let deadline = w.deadline_in(DEADLINE_MS).await?;
    w.open(&seller, 10 * MUSD, 2 * MUSD, 4, deadline, None).await?;
    Ok(())
}
```

- [ ] **Step 3: Run the scenarios**

Run: `cargo test -p quorum-pools --test open_commit -- --nocapture`
Expected: the first run builds both wasm files and starts a sandbox per test; all seven tests PASS. The
first test prints how far block time moved. If it fails because block time did not advance,
`World::expire` cannot work: stop and report it, because every scenario that lets a pool expire
depends on moving the clock with `fast_forward`.

If a scenario fails because the helper's `Outcome.ok` or a view shape differs from what the test
assumes, correct the helper or the assertion. If `refused_commits_return_the_money` fails on the
cap step, re-read section 5.3 of the spec: a buyer's seats held plus the seats asked for must stay
within `max_seats_per_buyer`.

- [ ] **Step 4: Commit**

```bash
git add contracts/pools/tests
git commit -m "add the sandbox world and the open and commit scenarios"
```

---

### Task 8: Settle

**Files:**
- Modify: `contracts/pools/src/settle.rs`
- Create: `contracts/pools/tests/settle.rs`

**Interfaces:**
- Consumes: `Contract::transfer`, `gas::{require_gas_for, CALLBACK_GAS}`, `math::payout`,
  `events::pool_settled`, `World`.
- Produces: `settle(pool_id: u64) -> Promise` and the private callback
  `on_settled(pool_id: u64, seller: AccountId, amount: U128, result)`.

- [ ] **Step 1: Write the failing tests**

First the unit tests. `contracts/pools/src/settle.rs` holds only this module until step 3 adds the
implementation above it. They call the callback directly with a successful or a failed result, which
covers the state transitions without a sandbox.

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::*;
    use crate::OpenParams;
    use near_sdk::test_utils::get_logs;

    /// A pool of 2 seats at a price of 2 with a bonus of 10, not yet filled.
    fn open(c: &mut Contract) -> u64 {
        c.open_pool(
            acct("seller.test"),
            10,
            OpenParams {
                seat_price: 2,
                target: 2,
                deadline_ms: 10_000,
                max_seats_per_buyer: None,
                terms: String::new(),
            },
            1_000,
        )
    }

    fn filled(c: &mut Contract) -> u64 {
        let id = open(c);
        c.commit_seats(acct("a.test"), 2, id, 1, 2_000);
        c.commit_seats(acct("b.test"), 2, id, 1, 2_000);
        id
    }

    #[test]
    fn settle_marks_the_pool_settled_before_the_payout_is_known() {
        let mut c = new_contract();
        let id = filled(&mut c);
        set_context("anyone.test", 3_000);
        let _ = c.settle(id);
        assert_eq!(c.pools.get(&id).unwrap().status, PoolStatus::Settled);
    }

    #[test]
    #[should_panic(expected = "pool is not filled")]
    fn settle_refuses_a_pool_that_is_not_filled() {
        let mut c = new_contract();
        let id = open(&mut c);
        set_context("anyone.test", 3_000);
        let _ = c.settle(id);
    }

    #[test]
    #[should_panic(expected = "pool is not filled")]
    fn settle_refuses_a_pool_that_is_already_settled() {
        let mut c = new_contract();
        let id = filled(&mut c);
        set_context("anyone.test", 3_000);
        let _ = c.settle(id);
        let _ = c.settle(id);
    }

    #[test]
    #[should_panic(expected = "pool not found")]
    fn settle_refuses_an_unknown_pool() {
        let mut c = new_contract();
        set_context("anyone.test", 3_000);
        let _ = c.settle(9);
    }

    #[test]
    fn a_failed_payout_puts_the_pool_back_to_filled() {
        let mut c = new_contract();
        let id = filled(&mut c);
        set_context("anyone.test", 3_000);
        let _ = c.settle(id);
        c.on_settled(id, acct("seller.test"), U128(14), Err(PromiseError::Failed));
        assert_eq!(c.pools.get(&id).unwrap().status, PoolStatus::Filled);
    }

    #[test]
    fn a_successful_payout_leaves_the_pool_settled_and_logs_the_event() {
        let mut c = new_contract();
        let id = filled(&mut c);
        set_context("anyone.test", 3_000);
        let _ = c.settle(id);
        c.on_settled(id, acct("seller.test"), U128(14), Ok(()));
        assert_eq!(c.pools.get(&id).unwrap().status, PoolStatus::Settled);
        assert!(get_logs().iter().any(|line| line.contains("pool_settled")));
    }

    #[test]
    fn a_failure_callback_changes_nothing_unless_the_pool_is_settled() {
        let mut c = new_contract();
        let id = filled(&mut c);
        c.on_settled(id, acct("seller.test"), U128(14), Err(PromiseError::Failed));
        assert_eq!(c.pools.get(&id).unwrap().status, PoolStatus::Filled);
        let open_id = open(&mut c);
        c.on_settled(open_id, acct("seller.test"), U128(14), Err(PromiseError::Failed));
        assert_eq!(c.pools.get(&open_id).unwrap().status, PoolStatus::Open);
    }
}
```

Then the sandbox scenarios, `contracts/pools/tests/settle.rs`:

```rust
mod common;

use common::*;

async fn filled_pool(w: &World) -> anyhow::Result<(u64, AccountId, AccountId)> {
    let seller = w.user("seller", 10).await?;
    let a = w.user("a", 10).await?;
    let deadline = w.deadline_in(DEADLINE_MS).await?;
    let id = w.open(&seller, 10 * MUSD, 2 * MUSD, 2, deadline, None).await?;
    assert!(w.commit(&a, id, 2, 2 * MUSD).await?.ok);
    assert_eq!(w.pool(id).await?["status"], "filled");
    Ok((id, seller, a))
}

#[tokio::test]
async fn anyone_can_settle_a_filled_pool_and_the_seller_is_paid() -> anyhow::Result<()> {
    let w = World::new().await?;
    let (id, seller, a) = filled_pool(&w).await?;
    let stranger = w.chain.create_account("stranger", 10).await?;

    assert!(w.settle(&stranger, id).await?.ok);
    w.check_invariants().await?;

    assert_eq!(w.pool(id).await?["status"], "settled");
    assert_eq!(w.balance(&seller).await?, 14 * MUSD, "4 mUSD of seats plus the 10 mUSD bonus back");
    assert_eq!(w.balance(&w.pools).await?, 0);
    assert_eq!(w.balance(&a).await?, 6 * MUSD, "a buyer of a settled pool is not refunded");

    // a second settle is refused and moves nothing
    assert!(!w.settle(&stranger, id).await?.ok);
    assert_eq!(w.balance(&seller).await?, 14 * MUSD);
    Ok(())
}

#[tokio::test]
async fn a_pool_that_is_not_filled_cannot_be_settled() -> anyhow::Result<()> {
    let w = World::new().await?;
    let seller = w.user("seller", 10).await?;
    let deadline = w.deadline_in(DEADLINE_MS).await?;
    let id = w.open(&seller, 10 * MUSD, 2 * MUSD, 2, deadline, None).await?;
    assert!(!w.settle(&seller, id).await?.ok);
    assert_eq!(w.pool(id).await?["status"], "open");
    Ok(())
}

#[tokio::test]
async fn a_filled_pool_settles_even_after_its_deadline() -> anyhow::Result<()> {
    let w = World::new().await?;
    let seller = w.user("seller", 10).await?;
    let a = w.user("a", 10).await?;
    let deadline = w.deadline_in(DEADLINE_MS).await?;
    let id = w.open(&seller, 10 * MUSD, 2 * MUSD, 1, deadline, None).await?;
    assert!(w.commit(&a, id, 1, 2 * MUSD).await?.ok);

    w.expire(id).await?;
    assert_eq!(w.pool(id).await?["status"], "filled", "a full pool is final");
    assert!(w.settle(&a, id).await?.ok);
    assert_eq!(w.pool(id).await?["status"], "settled");
    w.check_invariants().await?;
    Ok(())
}

#[tokio::test]
async fn a_failed_payout_puts_the_pool_back_and_settle_can_be_retried() -> anyhow::Result<()> {
    let w = World::new().await?;
    let (id, seller, _a) = filled_pool(&w).await?;

    // the seller leaves the token, so the payout transfer fails
    w.unregister(&seller).await?;
    assert!(w.settle(&seller, id).await?.ok, "the call succeeds; its callback restores the pool");
    assert_eq!(w.pool(id).await?["status"], "filled");
    assert_eq!(w.balance(&w.pools).await?, 14 * MUSD, "nothing left the contract");
    w.check_invariants().await?;

    // the seller registers again and anyone retries
    w.register(&seller).await?;
    assert!(w.settle(&seller, id).await?.ok);
    assert_eq!(w.pool(id).await?["status"], "settled");
    assert_eq!(w.balance(&seller).await?, 14 * MUSD);
    w.check_invariants().await?;
    Ok(())
}
```

- [ ] **Step 2: Run to see them fail**

Run: `cargo test -p quorum-pools --lib settle`
Expected: a compile error, `no method named settle` (the unit tests need the implementation).

- [ ] **Step 3: Write the implementation**

Put this at the top of `contracts/pools/src/settle.rs`, above the tests module:

```rust
use near_sdk::json_types::U128;
use near_sdk::{env, near, require, AccountId, Promise, PromiseError};

use crate::gas::{require_gas_for, CALLBACK_GAS};
use crate::{events, math};
use crate::{Contract, ContractExt, PoolStatus};

#[near]
impl Contract {
    /// Pays a filled pool's seller the takings plus the bonus. Anyone can call it. The pool is marked
    /// Settled before the transfer, so a second call cannot pay twice; if the transfer fails, the
    /// callback puts the pool back to Filled and the call can be repeated.
    pub fn settle(&mut self, pool_id: u64) -> Promise {
        require_gas_for(1);
        let pool = self
            .pools
            .get_mut(&pool_id)
            .unwrap_or_else(|| env::panic_str("pool not found"));
        require!(pool.status == PoolStatus::Filled, "pool is not filled");
        let amount = math::payout(pool.taken, pool.seat_price, pool.bonus);
        let seller = pool.seller.clone();
        pool.status = PoolStatus::Settled;
        Self::transfer(&self.token, seller.clone(), amount).then(
            Self::ext(env::current_account_id())
                .with_static_gas(CALLBACK_GAS)
                .on_settled(pool_id, seller, U128(amount)),
        )
    }

    #[private]
    pub fn on_settled(
        &mut self,
        pool_id: u64,
        seller: AccountId,
        amount: U128,
        #[callback_result] result: Result<(), PromiseError>,
    ) {
        match result {
            Ok(()) => events::pool_settled(pool_id, &seller, amount.0),
            Err(_) => {
                if let Some(pool) = self.pools.get_mut(&pool_id) {
                    if pool.status == PoolStatus::Settled {
                        pool.status = PoolStatus::Filled;
                    }
                }
            }
        }
    }
}
```

- [ ] **Step 4: Run the scenarios**

Run: `cargo test -p quorum-pools --lib settle`
Expected: the 7 settle unit tests PASS.

Run: `cargo test -p quorum-pools --test settle -- --nocapture`
Expected: all four sandbox scenarios PASS.

- [ ] **Step 5: Commit**

```bash
git add contracts/pools/src/settle.rs contracts/pools/tests/settle.rs
git commit -m "settle a filled pool and restore it if the payout fails"
```

---

### Task 9: Refund in batches, the dust and the gas assertion

**Files:**
- Modify: `contracts/pools/src/refund.rs`
- Create: `contracts/pools/tests/refund.rs`

**Interfaces:**
- Consumes: `Pool::expire_if_due`, `Contract::transfer`, `gas::{require_gas_for, CALLBACK_GAS}`,
  `math::{refund_amount, price_of, dust}`, `events::{seat_refunded, refund_failed, pool_refunded}`,
  `MAX_REFUND_LIMIT`.
- Produces: `refund(pool_id: u64, limit: u32)` and the private callbacks
  `on_refund_sent(pool_id, buyer, seats, amount, bonus_share, result)` and
  `on_dust_sent(pool_id, dust, result)`. Task 10 adds `claim_refund` to the same file.

- [ ] **Step 1: Write the failing tests**

First the unit tests. `contracts/pools/src/refund.rs` holds only this module until step 3 adds the
implementation above it (Task 10 adds more tests to it). They drive `refund` at a block time past the
deadline and call the callbacks directly with a successful or a failed result, which covers every
state transition without a sandbox, including a pool whose bonus is zero (which cannot be opened
through the standard token).

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::*;
    use crate::OpenParams;
    use near_sdk::test_utils::get_logs;

    /// A pool of 6 seats at a price of 2 with the given bonus and a deadline of 10_000, holding one
    /// seat for each named buyer.
    fn pool_with(c: &mut Contract, bonus: u128, buyers: &[&str]) -> u64 {
        let id = c.open_pool(
            acct("seller.test"),
            bonus,
            OpenParams {
                seat_price: 2,
                target: 6,
                deadline_ms: 10_000,
                max_seats_per_buyer: None,
                terms: String::new(),
            },
            1_000,
        );
        for name in buyers {
            c.commit_seats(acct(name), 2, id, 1, 2_000);
        }
        id
    }

    fn state(c: &Contract, id: u64, name: &str) -> BuyerState {
        c.buyers.get(&(id, acct(name))).unwrap().state
    }

    fn logged(fragment: &str) -> bool {
        get_logs().iter().any(|line| line.contains(fragment))
    }

    #[test]
    #[should_panic(expected = "pool is not open past its deadline or expired")]
    fn refund_is_refused_before_the_deadline() {
        let mut c = new_contract();
        let id = pool_with(&mut c, 10, &["a.test"]);
        set_context("anyone.test", 9_999);
        c.refund(id, 5);
    }

    #[test]
    #[should_panic(expected = "limit must be between 1 and 10")]
    fn a_limit_of_zero_is_refused() {
        let mut c = new_contract();
        let id = pool_with(&mut c, 10, &["a.test"]);
        set_context("anyone.test", 10_000);
        c.refund(id, 0);
    }

    #[test]
    #[should_panic(expected = "limit must be between 1 and 10")]
    fn a_limit_above_ten_is_refused() {
        let mut c = new_contract();
        let id = pool_with(&mut c, 10, &["a.test"]);
        set_context("anyone.test", 10_000);
        c.refund(id, 11);
    }

    #[test]
    fn the_first_call_expires_the_pool_and_fixes_the_share() {
        let mut c = new_contract();
        let id = pool_with(&mut c, 10, &["a.test", "b.test", "c.test"]);
        set_context("anyone.test", 10_000);
        c.refund(id, 1);
        let pool = c.pools.get(&id).unwrap();
        assert_eq!(pool.status, PoolStatus::Expired);
        assert_eq!(pool.bonus_per_seat, 3);
        assert_eq!(pool.refund_cursor, 1);
        assert_eq!(state(&c, id, "a.test"), BuyerState::Refunded);
        assert_eq!(state(&c, id, "b.test"), BuyerState::Committed);
    }

    #[test]
    fn a_batch_skips_buyers_that_are_no_longer_committed() {
        let mut c = new_contract();
        let id = pool_with(&mut c, 10, &["a.test", "b.test", "c.test"]);
        c.buyers.get_mut(&(id, acct("b.test"))).unwrap().state = BuyerState::Claimable;
        set_context("anyone.test", 10_000);
        c.refund(id, 10);
        assert_eq!(state(&c, id, "a.test"), BuyerState::Refunded);
        assert_eq!(state(&c, id, "b.test"), BuyerState::Claimable);
        assert_eq!(state(&c, id, "c.test"), BuyerState::Refunded);
        // every buyer was visited, so the dust (10 - 3 * 3 = 1) is on its way
        let pool = c.pools.get(&id).unwrap();
        assert!(pool.dust_sent);
        assert_eq!(pool.status, PoolStatus::Expired);
    }

    #[test]
    fn a_dust_of_zero_finishes_the_pool_without_a_transfer() {
        let mut c = new_contract();
        // 9 over 3 seats divides exactly
        let id = pool_with(&mut c, 9, &["a.test", "b.test", "c.test"]);
        set_context("anyone.test", 10_000);
        c.refund(id, 10);
        let pool = c.pools.get(&id).unwrap();
        assert_eq!(pool.status, PoolStatus::Refunded);
        assert!(pool.dust_sent);
        assert!(logged("pool_refunded") && logged(r#""dust":"0""#));
    }

    #[test]
    fn a_pool_with_a_bonus_of_zero_refunds_the_prices_and_finishes() {
        let mut c = new_contract();
        let id = pool_with(&mut c, 0, &["a.test", "b.test"]);
        set_context("anyone.test", 10_000);
        c.refund(id, 10);
        let pool = c.pools.get(&id).unwrap();
        assert_eq!(pool.bonus_per_seat, 0);
        assert_eq!(pool.status, PoolStatus::Refunded);
        assert_eq!(state(&c, id, "a.test"), BuyerState::Refunded);
        assert_eq!(state(&c, id, "b.test"), BuyerState::Refunded);
        assert!(logged("pool_refunded"));
    }

    #[test]
    fn a_pool_with_no_seats_sends_the_whole_bonus_as_dust() {
        let mut c = new_contract();
        let id = pool_with(&mut c, 10, &[]);
        set_context("anyone.test", 10_000);
        c.refund(id, 1);
        let pool = c.pools.get(&id).unwrap();
        assert!(pool.dust_sent);
        assert_eq!(pool.status, PoolStatus::Expired, "the pool finishes when the dust arrives");
    }

    #[test]
    fn a_failed_refund_makes_the_buyer_claimable_and_logs_it() {
        let mut c = new_contract();
        let id = pool_with(&mut c, 10, &["a.test"]);
        set_context("anyone.test", 10_000);
        c.refund(id, 1);
        c.on_refund_sent(id, acct("a.test"), 1, U128(5), U128(3), Err(PromiseError::Failed));
        assert_eq!(state(&c, id, "a.test"), BuyerState::Claimable);
        assert!(logged("refund_failed"));
    }

    #[test]
    fn a_paid_refund_logs_the_event_and_keeps_the_state() {
        let mut c = new_contract();
        let id = pool_with(&mut c, 10, &["a.test"]);
        set_context("anyone.test", 10_000);
        c.refund(id, 1);
        c.on_refund_sent(id, acct("a.test"), 1, U128(5), U128(3), Ok(()));
        assert_eq!(state(&c, id, "a.test"), BuyerState::Refunded);
        assert!(logged("seat_refunded"));
    }

    #[test]
    fn a_failed_dust_transfer_lets_the_next_call_retry_only_the_dust() {
        let mut c = new_contract();
        let id = pool_with(&mut c, 10, &["a.test", "b.test", "c.test"]);
        set_context("anyone.test", 10_000);
        c.refund(id, 10);
        c.on_dust_sent(id, U128(1), Err(PromiseError::Failed));
        let pool = c.pools.get(&id).unwrap();
        assert!(!pool.dust_sent);
        assert_eq!(pool.status, PoolStatus::Expired);

        c.refund(id, 1);
        let pool = c.pools.get(&id).unwrap();
        assert!(pool.dust_sent, "the retry sent the dust again");
        assert_eq!(pool.refund_cursor, 3, "and visited no buyer a second time");
    }

    #[test]
    fn a_paid_dust_transfer_finishes_the_pool() {
        let mut c = new_contract();
        let id = pool_with(&mut c, 10, &["a.test", "b.test", "c.test"]);
        set_context("anyone.test", 10_000);
        c.refund(id, 10);
        c.on_dust_sent(id, U128(1), Ok(()));
        assert_eq!(c.pools.get(&id).unwrap().status, PoolStatus::Refunded);
        assert!(logged("pool_refunded"));
    }
}
```

Then the sandbox scenarios, `contracts/pools/tests/refund.rs`:

```rust
mod common;

use common::*;

/// A pool of 6 seats at 2 mUSD with a 10 mUSD bonus, three buyers with one seat each, then expired.
async fn expired_pool(w: &World) -> anyhow::Result<(u64, AccountId, Vec<AccountId>)> {
    let seller = w.user("seller", 10).await?;
    let buyers = vec![w.user("a", 10).await?, w.user("b", 10).await?, w.user("c", 10).await?];
    let deadline = w.deadline_in(DEADLINE_MS).await?;
    let id = w.open(&seller, 10 * MUSD, 2 * MUSD, 6, deadline, None).await?;
    for buyer in &buyers {
        assert!(w.commit(buyer, id, 1, 2 * MUSD).await?.ok);
    }
    w.expire(id).await?;
    Ok((id, seller, buyers))
}

#[tokio::test]
async fn a_failed_pool_refunds_every_buyer_in_batches_and_the_dust_goes_to_the_seller() -> anyhow::Result<()> {
    let w = World::new().await?;
    let (id, seller, buyers) = expired_pool(&w).await?;
    let share = 10 * MUSD / 3; // 3_333_333: the bonus split over 3 seats, floored
    let dust = 10 * MUSD - 3 * share; // 1 base unit

    // first batch: two buyers
    assert!(w.refund(&seller, id, 2, 300).await?.ok);
    w.check_invariants().await?;
    let pool = w.pool(id).await?;
    assert_eq!(pool["status"], "expired");
    assert_eq!(pool["refund_cursor"], 2);
    assert_eq!(w.balance(&buyers[0]).await?, 10 * MUSD + share);
    assert_eq!(w.balance(&buyers[1]).await?, 10 * MUSD + share);
    assert_eq!(w.balance(&buyers[2]).await?, 8 * MUSD, "not refunded yet");

    // second batch: the last buyer, then the dust
    assert!(w.refund(&seller, id, 2, 300).await?.ok);
    w.check_invariants().await?;
    let pool = w.pool(id).await?;
    assert_eq!(pool["status"], "refunded");
    assert_eq!(pool["dust_sent"], true);
    assert_eq!(w.balance(&buyers[2]).await?, 10 * MUSD + share);
    assert_eq!(w.balance(&seller).await?, dust);
    assert_eq!(w.balance(&w.pools).await?, 0);

    // a refunded pool takes no more refund calls
    assert!(!w.refund(&seller, id, 2, 300).await?.ok);
    Ok(())
}

#[tokio::test]
async fn a_dust_of_zero_finishes_without_a_transfer() -> anyhow::Result<()> {
    let w = World::new().await?;
    let seller = w.user("seller", 9).await?;
    let buyers = vec![w.user("a", 10).await?, w.user("b", 10).await?, w.user("c", 10).await?];
    let deadline = w.deadline_in(DEADLINE_MS).await?;
    // 9 mUSD of bonus over 3 seats divides exactly: 3 mUSD each, nothing left over
    let id = w.open(&seller, 9 * MUSD, 2 * MUSD, 6, deadline, None).await?;
    for buyer in &buyers {
        assert!(w.commit(buyer, id, 1, 2 * MUSD).await?.ok);
    }
    w.expire(id).await?;

    assert!(w.refund(&seller, id, 10, 300).await?.ok);
    w.check_invariants().await?;
    let pool = w.pool(id).await?;
    assert_eq!(pool["status"], "refunded", "the pool finished in one call");
    assert_eq!(w.balance(&seller).await?, 0, "no dust was sent");
    assert_eq!(w.balance(&buyers[0]).await?, 10 * MUSD + 3 * MUSD);
    Ok(())
}

#[tokio::test]
async fn a_pool_with_no_seats_returns_the_whole_bonus_to_the_seller() -> anyhow::Result<()> {
    let w = World::new().await?;
    let seller = w.user("seller", 10).await?;
    let deadline = w.deadline_in(DEADLINE_MS).await?;
    let id = w.open(&seller, 10 * MUSD, 2 * MUSD, 4, deadline, None).await?;
    w.expire(id).await?;

    assert!(w.refund(&seller, id, 1, 300).await?.ok);
    w.check_invariants().await?;
    assert_eq!(w.pool(id).await?["status"], "refunded");
    assert_eq!(w.balance(&seller).await?, 10 * MUSD);
    Ok(())
}

#[tokio::test]
async fn refund_is_refused_before_the_deadline() -> anyhow::Result<()> {
    let w = World::new().await?;
    let seller = w.user("seller", 10).await?;
    let deadline = w.deadline_in(DEADLINE_MS).await?;
    let id = w.open(&seller, 10 * MUSD, 2 * MUSD, 4, deadline, None).await?;
    assert!(!w.refund(&seller, id, 5, 300).await?.ok);
    assert_eq!(w.pool(id).await?["status"], "open");
    Ok(())
}

#[tokio::test]
async fn refund_limits_outside_one_to_ten_are_refused() -> anyhow::Result<()> {
    let w = World::new().await?;
    let (id, seller, _buyers) = expired_pool(&w).await?;
    assert!(!w.refund(&seller, id, 0, 300).await?.ok);
    assert!(!w.refund(&seller, id, 11, 300).await?.ok);
    assert_eq!(w.pool(id).await?["refund_cursor"], 0);
    Ok(())
}

#[tokio::test]
async fn refund_needs_enough_gas_and_changes_nothing_without_it() -> anyhow::Result<()> {
    let w = World::new().await?;
    let (id, seller, buyers) = expired_pool(&w).await?;

    // limit 10 needs gas for 11 transfers and their callbacks; 100 Tgas is not enough
    assert!(!w.refund(&seller, id, 10, 100).await?.ok);
    let pool = w.pool(id).await?;
    assert_eq!(pool["refund_cursor"], 0, "nothing was processed");
    assert_eq!(w.balance(&buyers[0]).await?, 8 * MUSD, "nothing was paid");
    w.check_invariants().await?;

    // the same call with enough gas goes through
    assert!(w.refund(&seller, id, 10, 300).await?.ok);
    assert_eq!(w.pool(id).await?["status"], "refunded");
    w.check_invariants().await?;
    Ok(())
}

#[tokio::test]
async fn a_failed_dust_transfer_is_retried_by_the_next_refund_call() -> anyhow::Result<()> {
    let w = World::new().await?;
    let (id, seller, buyers) = expired_pool(&w).await?;
    let share = 10 * MUSD / 3;

    // the seller leaves the token, so the dust (1 base unit) cannot be sent
    w.unregister(&seller).await?;
    assert!(w.refund(&buyers[0], id, 10, 300).await?.ok);
    let pool = w.pool(id).await?;
    assert_eq!(pool["status"], "expired", "the dust is still owed, so the pool is not finished");
    assert_eq!(pool["dust_sent"], false);
    for buyer in &buyers {
        assert_eq!(w.balance(buyer).await?, 10 * MUSD + share);
    }
    w.check_invariants().await?;

    // the seller registers again; the next call sends only the dust
    w.register(&seller).await?;
    assert!(w.refund(&buyers[0], id, 1, 300).await?.ok);
    let pool = w.pool(id).await?;
    assert_eq!(pool["status"], "refunded");
    assert_eq!(pool["dust_sent"], true);
    assert_eq!(w.balance(&seller).await?, 1);
    for buyer in &buyers {
        assert_eq!(w.balance(buyer).await?, 10 * MUSD + share, "no buyer was paid twice");
    }
    w.check_invariants().await?;
    Ok(())
}
```

- [ ] **Step 2: Run to see them fail**

Run: `cargo test -p quorum-pools --lib refund`
Expected: a compile error, `no method named refund` (the unit tests need the implementation).

- [ ] **Step 3: Write the implementation**

Put this at the top of `contracts/pools/src/refund.rs`, above the tests module (Task 10 adds
`claim_refund` to the same `impl`). `Promise` is `#[must_use]` in current `near-sdk`: `.detach()`
marks a promise as deliberately not returned, and it is still scheduled.

```rust
use near_sdk::json_types::U128;
use near_sdk::{env, near, require, AccountId, PromiseError};

use crate::gas::{require_gas_for, CALLBACK_GAS};
use crate::{events, math};
use crate::{BuyerState, Contract, ContractExt, PoolStatus, MAX_REFUND_LIMIT};

/// One buyer's refund, worked out before any promise is scheduled.
struct Push {
    buyer: AccountId,
    seats: u32,
    amount: u128,
    bonus_share: u128,
}

#[near]
impl Contract {
    /// Refunds up to `limit` buyers of a pool that missed its deadline, then sends the dust to the
    /// seller. Anyone can call it, and calling it again is safe. The first call turns an Open pool
    /// that is past its deadline into Expired and fixes each seat's share of the bonus.
    pub fn refund(&mut self, pool_id: u64, limit: u32) {
        require!(
            (1..=MAX_REFUND_LIMIT).contains(&limit),
            "limit must be between 1 and 10"
        );
        // one transfer per buyer visited, plus the dust transfer
        require_gas_for(limit + 1);
        let now_ms = env::block_timestamp_ms();
        let pool = self
            .pools
            .get_mut(&pool_id)
            .unwrap_or_else(|| env::panic_str("pool not found"));
        pool.expire_if_due(now_ms);
        require!(
            pool.status == PoolStatus::Expired,
            "pool is not open past its deadline or expired"
        );

        let mut pushes: Vec<Push> = Vec::new();
        let mut visited = 0;
        while visited < limit && pool.refund_cursor < pool.buyer_count {
            let slot = pool.refund_cursor;
            pool.refund_cursor += 1;
            visited += 1;
            let buyer_id = self
                .slots
                .get(&(pool_id, slot))
                .unwrap_or_else(|| env::panic_str("missing buyer slot"))
                .clone();
            let record = self
                .buyers
                .get_mut(&(pool_id, buyer_id.clone()))
                .unwrap_or_else(|| env::panic_str("missing buyer record"));
            if record.state != BuyerState::Committed {
                continue; // already paid, or claimed on its own
            }
            record.state = BuyerState::Refunded;
            pushes.push(Push {
                buyer: buyer_id,
                seats: record.seats,
                amount: math::refund_amount(record.seats, pool.seat_price, pool.bonus_per_seat),
                bonus_share: math::price_of(record.seats, pool.bonus_per_seat),
            });
        }

        // Every buyer has been visited: settle the seller's dust. A dust of zero is not sent,
        // because the token rejects a zero transfer; the pool is simply finished.
        let mut dust_to_send: Option<(AccountId, u128)> = None;
        let mut finished_with_no_dust = false;
        if pool.refund_cursor == pool.buyer_count && !pool.dust_sent {
            let dust = math::dust(pool.bonus, pool.bonus_per_seat, pool.taken);
            pool.dust_sent = true;
            if dust == 0 {
                pool.status = PoolStatus::Refunded;
                finished_with_no_dust = true;
            } else {
                dust_to_send = Some((pool.seller.clone(), dust));
            }
        }

        for push in pushes {
            Self::transfer(&self.token, push.buyer.clone(), push.amount).then(
                Self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_refund_sent(
                        pool_id,
                        push.buyer,
                        push.seats,
                        U128(push.amount),
                        U128(push.bonus_share),
                    ),
            )
            .detach();
        }
        if let Some((seller, dust)) = dust_to_send {
            Self::transfer(&self.token, seller, dust)
                .then(
                    Self::ext(env::current_account_id())
                        .with_static_gas(CALLBACK_GAS)
                        .on_dust_sent(pool_id, U128(dust)),
                )
                .detach();
        }
        if finished_with_no_dust {
            events::pool_refunded(pool_id, 0);
        }
    }

    #[private]
    pub fn on_refund_sent(
        &mut self,
        pool_id: u64,
        buyer: AccountId,
        seats: u32,
        amount: U128,
        bonus_share: U128,
        #[callback_result] result: Result<(), PromiseError>,
    ) {
        match result {
            Ok(()) => events::seat_refunded(pool_id, &buyer, seats, amount.0, bonus_share.0),
            Err(_) => {
                if let Some(record) = self.buyers.get_mut(&(pool_id, buyer.clone())) {
                    if record.state == BuyerState::Refunded {
                        record.state = BuyerState::Claimable;
                    }
                }
                events::refund_failed(pool_id, &buyer, amount.0);
            }
        }
    }

    #[private]
    pub fn on_dust_sent(
        &mut self,
        pool_id: u64,
        dust: U128,
        #[callback_result] result: Result<(), PromiseError>,
    ) {
        if let Some(pool) = self.pools.get_mut(&pool_id) {
            match result {
                Ok(()) => {
                    pool.status = PoolStatus::Refunded;
                    events::pool_refunded(pool_id, dust.0);
                }
                // The pool stays Expired and the next `refund` call retries only the dust.
                Err(_) => pool.dust_sent = false,
            }
        }
    }
}
```

- [ ] **Step 4: Run the tests**

Run: `cargo test -p quorum-pools --lib refund`
Expected: the 12 refund unit tests PASS.

Run: `cargo test -p quorum-pools --test refund -- --nocapture`
Expected: all 7 sandbox scenarios PASS.

If `a_failed_pool_refunds_every_buyer...` reports balances off by the refund share, recheck that the
test's `share` matches the contract's: the bonus is split over the seats taken (3), floored, so
`10_000_000 / 3 = 3_333_333` and the dust is `1`.

- [ ] **Step 5: Commit**

```bash
git add contracts/pools/src/refund.rs contracts/pools/tests/refund.rs
git commit -m "refund buyers in batches, send the dust to the seller and assert gas at entry"
```

---

### Task 10: Claim a refund

**Files:**
- Modify: `contracts/pools/src/refund.rs`
- Create: `contracts/pools/tests/claim.rs`

**Interfaces:**
- Consumes: everything in `refund.rs`, `Contract.buyers`.
- Produces: `claim_refund(pool_id: u64)` (caller is the buyer) and the private callback
  `on_claim_sent(pool_id, buyer, amount, result)`.

- [ ] **Step 1: Write the failing tests**

First the unit tests. Add these inside the `tests` module of `contracts/pools/src/refund.rs`, after
the tests from Task 9 (they use the same `pool_with`, `state` and `logged` helpers).

```rust
    #[test]
    fn a_buyer_can_claim_after_the_deadline_without_any_refund_call() {
        let mut c = new_contract();
        let id = pool_with(&mut c, 10, &["a.test", "b.test", "c.test"]);
        set_context("a.test", 10_000);
        c.claim_refund(id);
        assert_eq!(state(&c, id, "a.test"), BuyerState::Refunded);
        let pool = c.pools.get(&id).unwrap();
        assert_eq!(pool.status, PoolStatus::Expired, "the claim stored the expiry");
        assert_eq!(pool.bonus_per_seat, 3);
        assert_eq!(state(&c, id, "b.test"), BuyerState::Committed);
    }

    #[test]
    #[should_panic(expected = "pool is not open past its deadline, expired or refunded")]
    fn a_claim_before_the_deadline_is_refused() {
        let mut c = new_contract();
        let id = pool_with(&mut c, 10, &["a.test"]);
        set_context("a.test", 9_999);
        c.claim_refund(id);
    }

    #[test]
    #[should_panic(expected = "the caller holds no seats in this pool")]
    fn a_claim_by_an_account_without_seats_is_refused() {
        let mut c = new_contract();
        let id = pool_with(&mut c, 10, &["a.test"]);
        set_context("stranger.test", 10_000);
        c.claim_refund(id);
    }

    #[test]
    #[should_panic(expected = "the refund was already paid or is on its way")]
    fn a_second_claim_is_refused() {
        let mut c = new_contract();
        let id = pool_with(&mut c, 10, &["a.test"]);
        set_context("a.test", 10_000);
        c.claim_refund(id);
        c.claim_refund(id);
    }

    #[test]
    fn a_claim_whose_transfer_fails_can_be_claimed_again() {
        let mut c = new_contract();
        let id = pool_with(&mut c, 10, &["a.test"]);
        set_context("a.test", 10_000);
        c.claim_refund(id);
        c.on_claim_sent(id, acct("a.test"), U128(5), Err(PromiseError::Failed));
        assert_eq!(state(&c, id, "a.test"), BuyerState::Claimable);
        c.claim_refund(id);
        assert_eq!(state(&c, id, "a.test"), BuyerState::Refunded);
    }

    #[test]
    fn a_paid_claim_logs_the_event_and_keeps_the_state() {
        let mut c = new_contract();
        let id = pool_with(&mut c, 10, &["a.test"]);
        set_context("a.test", 10_000);
        c.claim_refund(id);
        c.on_claim_sent(id, acct("a.test"), U128(5), Ok(()));
        assert_eq!(state(&c, id, "a.test"), BuyerState::Refunded);
        assert!(logged("refund_claimed"));
    }

    #[test]
    fn a_claim_failure_callback_changes_nothing_unless_the_state_is_refunded() {
        let mut c = new_contract();
        let id = pool_with(&mut c, 10, &["a.test"]);
        c.on_claim_sent(id, acct("a.test"), U128(5), Err(PromiseError::Failed));
        assert_eq!(state(&c, id, "a.test"), BuyerState::Committed);
    }

    #[test]
    fn refund_leaves_a_buyer_that_has_already_claimed_alone() {
        let mut c = new_contract();
        let id = pool_with(&mut c, 10, &["a.test", "b.test", "c.test"]);
        set_context("a.test", 10_000);
        c.claim_refund(id);
        set_context("anyone.test", 10_000);
        c.refund(id, 10);
        assert_eq!(state(&c, id, "a.test"), BuyerState::Refunded);
        assert_eq!(state(&c, id, "b.test"), BuyerState::Refunded);
        assert_eq!(state(&c, id, "c.test"), BuyerState::Refunded);
        assert_eq!(c.pools.get(&id).unwrap().refund_cursor, 3);
    }
```

Then the sandbox scenarios, `contracts/pools/tests/claim.rs`:

```rust
mod common;

use common::*;
use serde_json::json;

const SHARE: u128 = 10 * MUSD / 3; // the 10 mUSD bonus over 3 seats, floored

/// 6 seats at 2 mUSD, a 10 mUSD bonus, three buyers with one seat each, expired.
async fn expired_pool(w: &World) -> anyhow::Result<(u64, AccountId, Vec<AccountId>)> {
    let seller = w.user("seller", 10).await?;
    let buyers = vec![w.user("a", 10).await?, w.user("b", 10).await?, w.user("c", 10).await?];
    let deadline = w.deadline_in(DEADLINE_MS).await?;
    let id = w.open(&seller, 10 * MUSD, 2 * MUSD, 6, deadline, None).await?;
    for buyer in &buyers {
        assert!(w.commit(buyer, id, 1, 2 * MUSD).await?.ok);
    }
    w.expire(id).await?;
    Ok((id, seller, buyers))
}

#[tokio::test]
async fn a_buyer_can_claim_before_anyone_has_called_refund() -> anyhow::Result<()> {
    let w = World::new().await?;
    let (id, seller, buyers) = expired_pool(&w).await?;

    assert!(w.claim(&buyers[1], id).await?.ok);
    w.check_invariants().await?;
    assert_eq!(w.balance(&buyers[1]).await?, 10 * MUSD + SHARE);
    let pool = w.pool(id).await?;
    assert_eq!(pool["status"], "expired", "the claim stored the expiry");
    let row = w.chain.view(&w.pools, "get_buyer", json!({ "pool_id": id, "account_id": buyers[1] })).await?;
    assert_eq!(row["state"], "refunded");

    // refund then skips the buyer that already claimed, and finishes the pool
    assert!(w.refund(&seller, id, 10, 300).await?.ok);
    w.check_invariants().await?;
    assert_eq!(w.pool(id).await?["status"], "refunded");
    assert_eq!(w.balance(&buyers[0]).await?, 10 * MUSD + SHARE);
    assert_eq!(w.balance(&buyers[1]).await?, 10 * MUSD + SHARE, "paid once, not twice");
    assert_eq!(w.balance(&buyers[2]).await?, 10 * MUSD + SHARE);

    // claiming again is refused
    assert!(!w.claim(&buyers[1], id).await?.ok);
    assert_eq!(w.balance(&buyers[1]).await?, 10 * MUSD + SHARE);
    Ok(())
}

#[tokio::test]
async fn a_refund_that_cannot_be_pushed_becomes_claimable() -> anyhow::Result<()> {
    let w = World::new().await?;
    let (id, seller, buyers) = expired_pool(&w).await?;

    // buyer b leaves the token, so the pushed refund to it fails
    w.unregister(&buyers[1]).await?;
    assert!(w.refund(&seller, id, 10, 300).await?.ok);
    w.check_invariants().await?;

    let row = w.chain.view(&w.pools, "get_buyer", json!({ "pool_id": id, "account_id": buyers[1] })).await?;
    assert_eq!(row["state"], "claimable");
    assert_eq!(w.pool(id).await?["status"], "refunded", "the pool is done; one refund is still owed");
    assert_eq!(w.balance(&buyers[0]).await?, 10 * MUSD + SHARE);

    // b registers again and claims
    w.register(&buyers[1]).await?;
    assert!(w.claim(&buyers[1], id).await?.ok);
    w.check_invariants().await?;
    // leaving the token burned b's remaining 8 mUSD, so b now holds only the refund
    assert_eq!(w.balance(&buyers[1]).await?, 2 * MUSD + SHARE);
    let row = w.chain.view(&w.pools, "get_buyer", json!({ "pool_id": id, "account_id": buyers[1] })).await?;
    assert_eq!(row["state"], "refunded");
    Ok(())
}

#[tokio::test]
async fn a_failed_claim_leaves_the_refund_claimable() -> anyhow::Result<()> {
    let w = World::new().await?;
    let (id, _seller, buyers) = expired_pool(&w).await?;

    w.unregister(&buyers[0]).await?;
    assert!(w.claim(&buyers[0], id).await?.ok, "the call succeeds; its callback restores the state");
    let row = w.chain.view(&w.pools, "get_buyer", json!({ "pool_id": id, "account_id": buyers[0] })).await?;
    assert_eq!(row["state"], "claimable");
    w.check_invariants().await?;

    w.register(&buyers[0]).await?;
    assert!(w.claim(&buyers[0], id).await?.ok);
    // leaving the token burned a's remaining 8 mUSD, so a now holds only the refund
    assert_eq!(w.balance(&buyers[0]).await?, 2 * MUSD + SHARE);
    w.check_invariants().await?;
    Ok(())
}

#[tokio::test]
async fn a_claim_needs_an_expired_pool_and_held_seats() -> anyhow::Result<()> {
    let w = World::new().await?;
    let seller = w.user("seller", 20).await?;
    let a = w.user("a", 10).await?;
    let deadline = w.deadline_in(DEADLINE_MS).await?;
    let id = w.open(&seller, 10 * MUSD, 2 * MUSD, 4, deadline, None).await?;
    assert!(w.commit(&a, id, 1, 2 * MUSD).await?.ok);

    // the pool is still open: no claim
    assert!(!w.claim(&a, id).await?.ok);
    assert_eq!(w.balance(&a).await?, 8 * MUSD);

    // an expired pool where the caller holds no seats: a second pool in the same world
    let deadline2 = w.deadline_in(DEADLINE_MS).await?;
    let id2 = w.open(&seller, 10 * MUSD, 2 * MUSD, 4, deadline2, None).await?;
    w.expire(id2).await?;
    assert!(!w.claim(&a, id2).await?.ok, "a holds no seats in the second pool");
    w.check_invariants().await?;
    Ok(())
}
```

- [ ] **Step 2: Run to see them fail**

Run: `cargo test -p quorum-pools --lib refund`
Expected: a compile error, `no method named claim_refund` (the new unit tests need the
implementation).

- [ ] **Step 3: Write the implementation**

In `refund.rs`, inside the existing `#[near] impl Contract` block, add:

```rust
    /// A buyer collects its own refund from a pool that missed its deadline. It works whether or not
    /// anyone has called `refund`, and it is how a buyer recovers a refund that could not be pushed
    /// (for example, because the buyer was not registered on the token). The state is set before the
    /// transfer; if the transfer fails, the callback makes the refund claimable again.
    pub fn claim_refund(&mut self, pool_id: u64) {
        require_gas_for(1);
        let buyer = env::predecessor_account_id();
        let now_ms = env::block_timestamp_ms();
        let pool = self
            .pools
            .get_mut(&pool_id)
            .unwrap_or_else(|| env::panic_str("pool not found"));
        pool.expire_if_due(now_ms);
        require!(
            matches!(pool.status, PoolStatus::Expired | PoolStatus::Refunded),
            "pool is not open past its deadline, expired or refunded"
        );
        let record = self
            .buyers
            .get_mut(&(pool_id, buyer.clone()))
            .unwrap_or_else(|| env::panic_str("the caller holds no seats in this pool"));
        require!(
            matches!(record.state, BuyerState::Committed | BuyerState::Claimable),
            "the refund was already paid or is on its way"
        );
        record.state = BuyerState::Refunded;
        let amount = math::refund_amount(record.seats, pool.seat_price, pool.bonus_per_seat);
        Self::transfer(&self.token, buyer.clone(), amount)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_claim_sent(pool_id, buyer, U128(amount)),
            )
            .detach();
    }

    #[private]
    pub fn on_claim_sent(
        &mut self,
        pool_id: u64,
        buyer: AccountId,
        amount: U128,
        #[callback_result] result: Result<(), PromiseError>,
    ) {
        match result {
            Ok(()) => events::refund_claimed(pool_id, &buyer, amount.0),
            Err(_) => {
                if let Some(record) = self.buyers.get_mut(&(pool_id, buyer)) {
                    if record.state == BuyerState::Refunded {
                        record.state = BuyerState::Claimable;
                    }
                }
            }
        }
    }
```

- [ ] **Step 4: Run the scenarios**

Run: `cargo test -p quorum-pools --lib refund`
Expected: all 20 refund unit tests PASS (12 from Task 9, 8 from this task).

Run: `cargo test -p quorum-pools --test claim -- --nocapture`
Expected: all four sandbox scenarios PASS. Then `cargo test -p quorum-pools --test refund --test settle --test open_commit`
to confirm nothing regressed.

- [ ] **Step 5: Commit**

```bash
git add contracts/pools/src/refund.rs contracts/pools/tests/claim.rs
git commit -m "let a buyer claim its own refund and recover one that could not be pushed"
```

---

### Task 11: Verify the gas allowances and run everything

**Files:**
- Create: `contracts/pools/tests/gas.rs`
- Modify: `contracts/pools/src/gas.rs` (only if the test shows the allowances are wrong)

**Interfaces:**
- Consumes: `World`, `gas::{TRANSFER_GAS, CALLBACK_GAS, BASE_GAS}`.
- Produces: confirmation that `refund` with `limit = 10` and the minimum gas it accepts refunds all
  ten buyers and finishes the pool, so no transfer or callback runs out of gas.

- [ ] **Step 1: Write the scenario**

`contracts/pools/tests/gas.rs`:

```rust
mod common;

use common::*;

/// `refund` with `limit = 10` asserts that 230 Tgas (plus what it has already used) is available.
/// With about that much, ten refunds and the dust must all complete: if an allowance were too small,
/// a transfer or its callback would run out of gas and a buyer would be left unpaid or stuck.
#[tokio::test]
async fn a_full_refund_batch_completes_with_the_least_gas_refund_accepts() -> anyhow::Result<()> {
    let w = World::new().await?;
    // 11 mUSD, of which 10_000_007 base units go in as the bonus: over 10 seats that is 1_000_000
    // each with a dust of 7, so the dust transfer is exercised as well as the ten refunds.
    let seller = w.user("seller", 11).await?;
    let bonus = 10 * MUSD + 7;
    let deadline = w.deadline_in(DEADLINE_MS).await?;
    let id = w.open(&seller, bonus, 2 * MUSD, 20, deadline, None).await?;

    let mut buyers = Vec::new();
    for n in 0..10 {
        let buyer = w.user(&format!("buyer{n}"), 4).await?;
        assert!(w.commit(&buyer, id, 1, 2 * MUSD).await?.ok);
        buyers.push(buyer);
    }
    w.expire(id).await?;

    let out = w.refund(&seller, id, 10, 240).await?;
    assert!(out.ok, "{}", out.debug);
    w.check_invariants().await?;

    let share = bonus / 10;
    for buyer in &buyers {
        assert_eq!(w.balance(buyer).await?, 4 * MUSD - 2 * MUSD + 2 * MUSD + share);
        let row = w
            .chain
            .view(&w.pools, "get_buyer", serde_json::json!({ "pool_id": id, "account_id": buyer }))
            .await?;
        assert_eq!(row["state"], "refunded");
    }
    assert_eq!(w.pool(id).await?["status"], "refunded");
    // the seller kept 11 mUSD - 10_000_007 and got the 7 base units of dust back
    assert_eq!(w.balance(&seller).await?, MUSD);
    assert_eq!(w.balance(&w.pools).await?, 0);
    Ok(())
}
```

- [ ] **Step 2: Run it**

Run: `cargo test -p quorum-pools --test gas -- --nocapture`
Expected: PASS. If `refund` is refused with "not enough gas", the entry check counts gas already
used: raise the attached gas in this test from 240 to 250 and re-run (the point of the test is that
nothing runs out of gas after the check). If it fails because a buyer is `claimable` or unpaid, the
transfer or callback allowance is too small: raise `TRANSFER_GAS` or `CALLBACK_GAS` in `gas.rs` by 5
Tgas, keep `gas_needed(11)` within the per-transaction gas limit of the sandbox's protocol version
(lower `MAX_REFUND_LIMIT` in `types.rs` and the limit in this test together if it would exceed it),
update the expected numbers in the `gas.rs` unit test, and re-run. If it passes with room to spare,
leave the allowances alone: unused attached gas is refunded.

- [ ] **Step 3: Run the whole suite**

Run: `cargo test --workspace -- --nocapture`
Expected: every unit test and every sandbox scenario PASS.

Run: `cargo clippy --workspace --all-targets -- -D warnings`
Expected: no warnings. Fix any (unused imports from earlier tasks are the likeliest).

Run: `cargo near build non-reproducible-wasm --manifest-path contracts/pools/Cargo.toml` and the same
for `contracts/mock-usd`
Expected: both wasm files build with `overflow-checks` on.

- [ ] **Step 4: Commit**

```bash
git add contracts/pools
git commit -m "verify the gas allowances with a full refund batch"
```

---

## Spec coverage

| Spec requirement | Where |
|---|---|
| 5.1 state, no admin methods, `new` guarded | Task 3 (`Contract`, `#[private]` `new`); Task 7 (`new` rejected from another account and a second time) |
| 5.2 lifecycle, Filled is final, derived Expired | Tasks 3 (`Pool::expire_if_due`), 6 (view), 8 (settle after deadline) |
| 5.3 open and commit messages and every refusal | Tasks 4, 5 (unit), 7 (sandbox) |
| 5.4 `settle`, `refund`, `claim_refund`, views | Tasks 8, 9, 10 (implementation, unit tests for every state transition and callback, sandbox scenarios), 6 (views, `get_token` included) |
| Gas and deposits paragraph of 5.4 | Tasks 3 (`gas.rs`, `Contract::transfer`), 9 (gas refusal), 11 (a refusal just under the gas required, and a full batch just over it) |
| 5.5 invariants | Task 7 (`check_invariants` covers 1, 2 and 4 after each step); 3 and 5 through the balance assertions in Tasks 8 to 10 |
| 5.6 events | Task 3 (`events.rs`), emitted in Tasks 4, 5, 8, 9, 10 and asserted in the unit tests of Tasks 8 to 10 |
| 5.7 tokens: the mock token | Tasks 1, 2 |
| 5.7 tokens: Circle's USDC on testnet, and the gas measured against it (a commit's, and the transfer and callback allowances calibrated in Task 11 against the mock) | Not here: the swarm plan (deployment, setup, the end-to-end runs) |
| 7.3 scenario amounts of a few hundred base units | Task 3 (`the_testnet_scenario_amounts_add_up`, and the two loop tests over those bonuses) |
| 10 contract unit tests: bonus split and dust, every state transition, every refusal in 5.3, checked arithmetic at the limits | Tasks 3 (maths, overflow panics), 4 and 5 (refusals), 8 to 10 (transitions) |
| 10 sandbox cases: fills, fails, partial last commit, wrong token, commit after deadline, seller commit, failed pushed refund then claim, failed payout then retried settle, failed dust then retried refund, claim before any refund, no seats at expiry, dust 0, `refund` with less gas and with enough | Tasks 7 to 11 |
| 10 case: bonus 0 | Task 9 unit test (a zero-bonus pool refunded to completion) and Task 4 (opening one); the standard token rejects a zero-amount `ft_transfer_call`, so no sandbox path exists, and Task 1 corrects the spec |
| 10 case: relayed payment's 1 yoctoNEAR deposit | Not here: needs the relayer, built with the gateway |
