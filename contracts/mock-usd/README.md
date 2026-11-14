# Mock USD

`mock-usd` is an NEP-141 fungible token for the sandbox tests: **Mock USD** (`mUSD`), with 6
decimals like Circle's USDC, which the [pools contract](../pools/README.md) uses on NEAR testnet. It
is never deployed to testnet. It is the standard implementation from near-contract-standards 5, with
storage management and metadata, plus one method of its own: `mint`.

| | |
|---|---|
| Name, symbol | Mock USD, `mUSD` |
| Decimals | 6: 1 mUSD is 1,000,000 base units |
| Initialisation | `new()`, with no arguments |
| Owner | None |
| Standards | NEP-141 (`ft_transfer`, `ft_transfer_call`, `ft_total_supply`, `ft_balance_of`, `ft_resolve_transfer`), NEP-145 storage management, `ft_metadata` |

## `mint`

`mint(account_id, amount)` adds `amount` base units to `account_id`'s balance and logs a standard
`ft_mint` event with the memo `mint`. Anyone can call it, with no deposit.

| Limit | Refusal (panic message) |
|---|---|
| `amount` is above 0 | `amount must be positive` |
| `amount` is at most 1,000 mUSD (`1000000000` base units) per call | `amount exceeds the per-call mint cap` |
| `account_id` is already registered on the token (`storage_deposit`) | A panic from the standard implementation |

The number of calls is not limited: the cap only keeps one call from creating an absurd balance.

## Who uses it

| User | How |
|---|---|
| The contract sandbox tests ([`../pools/tests/`](../pools/tests/), [`tests/token.rs`](tests/token.rs)) | Built and deployed through [`quorum-sandbox-support`](../../crates/sandbox-support/README.md)'s `token_wasm()` |
| The TypeScript sandbox suites of the gateway, the swarm and the MCP server | Read the built wasm's path from `QUORUM_MOCK_USD_WASM` |

## Build and test

From the repository's root:

```bash
cargo near build non-reproducible-wasm --no-abi --no-embed-abi --manifest-path contracts/mock-usd/Cargo.toml
cargo test -p mock-usd --test token
```

The build writes `target/near/mock_usd/mock_usd.wasm`. The crate has no unit tests. Its sandbox
tests check the metadata, that `mint` needs a registered account and respects the cap, and that
registered accounts can transfer. Like every sandbox test, they need Linux (x86_64 or aarch64),
macOS on Apple silicon, or WSL2, with glibc 2.38 or later (Ubuntu 24.04 or later).
