# Sandbox support

`quorum-sandbox-support` is a test helper for the Rust contract tests. It starts a local NEAR node
with near-sandbox and wraps the few operations the tests need with near-api. Everything that depends
on near-sandbox and near-api lives here, so the tests use only this crate's interface. It is a
dev-dependency, and is not published.

## API

All in [`src/lib.rs`](src/lib.rs):

- **`Chain::start()`** starts a sandbox and returns a `Chain`: the `sandbox`, a `network` config for
  its RPC, and a `signer` holding the sandbox's default key. Every account it creates uses that key,
  so one signer signs for all of them.
- **`create_account(name, near)`** creates `<name>.sandbox` with `near` NEAR. It returns once the
  account's key is visible at final finality, so the next transaction can be signed for it, and
  gives up after 30 seconds.
- **`deploy(name, wasm, init)`** creates `<name>.sandbox` with 20 NEAR, deploys `wasm`, and, when
  `init` is given as a method and its JSON arguments, runs it in the same transaction. It panics if
  the deployment fails.
- **`call(caller, contract, method, args, tgas, deposit_yocto)`** signs a function call as `caller`
  and returns an `Outcome`: `ok` (whether the transaction succeeded), its `logs`, its `debug` text
  (which includes any receipt failure message), and its `receipts`, as the account each ran on and
  the gas it burnt, the call's own receipt first. A failed transaction gives `ok: false`, not an
  error.
- **`view(contract, method, args)`** runs a view and returns its JSON.
- **`fast_forward(blocks)`** moves the chain forward by that many blocks.
- **`now_ms()`** is the block time of the latest final block, in milliseconds.
- **`wait_past(deadline_ms)`** fast-forwards 500 blocks at a time, up to 120 times, until block time
  is at or past `deadline_ms`, and fails otherwise.
- **`pools_wasm()`** and **`token_wasm()`** build [`contracts/pools`](../../contracts/pools/README.md)
  and [`contracts/mock-usd`](../../contracts/mock-usd/README.md) with the cargo-near-build library's
  `build_with_cli`, which runs the `cargo near` CLI, so cargo-near must be installed (ABI steps and
  the lockfile check switched off). Each builds once per test binary, under a lock,
  however many tests run in parallel.
- `AccountId` is re-exported from near-api.

## Who uses it

| User | What for |
|---|---|
| [`contracts/pools/tests/`](../../contracts/pools/tests/) | The pools contract's sandbox tests, through their shared `World` in `tests/common/mod.rs` |
| [`contracts/mock-usd/tests/token.rs`](../../contracts/mock-usd/tests/token.rs) | The mock token's sandbox tests |
| [`tests/create_account.rs`](tests/create_account.rs) | Its own test: an account `create_account` returns can be signed for at once |

The TypeScript sandbox suites do not use it: they start their own sandbox with near-sandbox from
npm.

## Requirements

near-sandbox downloads a NEAR sandbox node, which needs glibc 2.38 or later. The tests run on Linux
(x86_64 or aarch64), macOS on Apple silicon, or WSL2 (Ubuntu 24.04 or later); near-sandbox ships no
Windows binary. The contracts are built through the `cargo near` CLI, so cargo-near 0.23.0 must be
installed (see the root README's [local sandbox](../../README.md#b-a-local-sandbox) section).

```bash
cargo test -p quorum-sandbox-support    # this crate's own test
cargo test --workspace                  # every test that uses it
```
