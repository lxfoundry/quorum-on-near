# @quorum-on-near/buyer

A buyer's side of the `quorum` scheme, shared by the swarm's scripted buyers
([`apps/swarm`](../../apps/swarm/README.md)) and the MCP server
([`apps/mcp`](../../apps/mcp/README.md)): the shared settings, key files, a typed client of the
gateway, signing and sending a payment, checked chain reads, and the MCP server's spend file. It
builds on [`@quorum-on-near/protocol`](../protocol/README.md), whose builders do no I/O; this package
adds the reads, the requests and the files around them.

What the buyers buy is simulated: the provider and the GPU access it sells, with a credential that
is a signed token whose claims include `simulated: true`. The money is not: each payment moves USDC
on NEAR testnet.

## Modules

Everything is exported from the package entry, `src/index.ts`.

| Module | Main exports |
|---|---|
| `gateway.ts` | `GatewayClient`, `GatewayResponseError`, `checkAccessRequest`, `MAX_SEATS_PER_REQUEST` (1000); answer types `PoolsAnswer`, `OfferAnswer`, `PaymentAnswer`, `RedeemAnswer`, `PoolListing`, `ActivityRecord` |
| `buyer.ts` | `Buyer`, `PaymentNotSentError`, `PaymentUnknownError`, `SETTLE_MARGIN_BLOCKS`; types `BuyerOptions`, `PaymentRequest`, `SignedPayment`, `BuyerPaymentAnswer` |
| `chain.ts` | `RpcBuyerChain`, `RpcPoolReads`, `readPoolView`, `AccessKeyNotFoundError`, `PoolViewError`, `MAX_TERMS_BYTES` (280); interfaces `BuyerChainReads`, `PoolReads` |
| `key-files.ts` | `readKeyFile`, `writeKeyFile`, `readKeyFolder`, `keyFilePath`, `keyFolderPath`, `folderKeyPath`, `defaultCredentialsDir`, `KeyFileError` |
| `spend-file.ts` | `readSpendFile`, `writeSpendFile`, `defaultSpendFile`, `SpendFileError` |
| `settings.ts` | `readBuyerSettings`, `readMcpBuyerSettings`, `EnvReader`, `completeConfig`, `ConfigError`, `TESTNET_USDC`; rules `asInteger`, `asPositiveInteger`, `asAmount`, `asNear`, `asAbsolutePath` |
| `errors.ts` | `transportReason`, `redact`, `describeError` |

## The gateway client

`new GatewayClient({ gatewayUrl, fetch?, payTimeoutMs?, readTimeoutMs? })`. `gatewayUrl` is the
gateway's base URL without a trailing slash.

| Method | Request | Answer (`kind`) |
|---|---|---|
| `pools()` | `GET /pools` | `pools` (the provider's open pools, in id order), `unavailable` |
| `offer(poolId, seats)` | `GET /pools/:id/access?seats=N` | `offer` (`402`), `unknown_pool` (`404`), `pool_closed` (`409`), `pool_expired` (`410`), `unavailable` (`503`) |
| `pay(poolId, seats, paymentHeader)` | the same, with `X-PAYMENT` | `pending` (`202`), `filled` (`200`, with the credential), `refused` (`402`, with the error code and the offer as it stands, or null), `no_seats_taken` (`409`), `pool_expired` (`410`), `relay_failed` and `result_unknown` (`502`), `unknown_pool` (`404`), `unavailable` (`503`) |
| `redeem(poolId, proofHeader)` | `GET /pools/:id/access`, with `X-QUORUM-PROOF` | `pending` (`202`), `filled` (`200`), `refund` (`410`: `refunded`, `refund_pending` or `claimable`, with `amount`, `bonusShare` and the refund's `txHash` or null), `no_seats` and `unknown_pool` (`404`), `invalid_proof` (`401`, with its code), `unavailable` (`503`) |
| `activity(poolId)` | `GET /activity?pool=<id>` | The pool's records, oldest first: `{at, poolId, kind, account, seats, amount, txHash, ok}` |

How it behaves:

- **One request per call.** Each method sends one GET, never repeats it, and follows no redirect
  (`redirect: 'error'`), which would carry a payment or a proof to another server.
- **Checked answers.** Each answer is a discriminated union on `kind`. Every body is checked field
  by field, and only the documented fields are kept: the gateway is outside the buyer's trust. A
  `202` or `200` to a payment must carry an `X-PAYMENT-RESPONSE` header that names the same
  transaction as the body.
- **Bounded strings.** A pool's terms are at most 280 UTF-8 bytes (what the contract keeps), a
  transaction hash 32 to 44 base58 characters, and a credential at most 4096 characters, in compact
  JWS form.
- **Amounts.** Amounts in this package's own types are `bigint` base units. An `Offer` keeps its
  amounts as the wire's decimal strings, since the buyer signs the offer as it was sent.
- **Timeouts.** A request is aborted if its answer, body included, has not arrived in time: 300
  seconds for a payment, 30 seconds for any other request (`payTimeoutMs`, `readTimeoutMs`).
- **Body cap.** At most 1 MiB of a body is read; a longer body is an undocumented answer.
- **Errors.** `RangeError`, before anything is sent, for a pool id that is not a non-negative safe
  integer or a seat count outside 1 to 1000; `GatewayResponseError` (`route`, `status`) for an
  answer the gateway does not document, with a message that never quotes the body; the abort's
  `TimeoutError`; or fetch's own error. A `pay` that rejects with anything but a `RangeError` may
  have reached the gateway: redemption tells whether it landed.

The full table of answers is in sections
[6.3](../../docs/specs/2026-11-09-quorum-on-near-design.md#63-payment) to
[6.5](../../docs/specs/2026-11-09-quorum-on-near-design.md#65-redemption) of the design spec.

## The buyer

`new Buyer({ settings, accountId, keyPair, gateway, chain, now? })` is one buyer acting through the
gateway with a full-access key of its own account. It makes one payment at a time: a second payment
signed before the first is relayed reads the same nonce, and the gateway refuses it.

| Method | What it does |
|---|---|
| `offer(poolId, seats)` | Asks the gateway for its offer (`GatewayClient.offer`) |
| `pay(offer, { poolId, seats, maxAmount })` | Checks the offer, signs a payment, sends it once |
| `finalHeight()` | The latest final block's height, which the gateway checks a payment's expiry against |
| `redeem(poolId)` | Signs a new redemption proof, dated `now()` and naming the gateway's host, and sends it |

`pay` in order:

1. Throws `RangeError`, reading nothing, for a request no gateway request can carry.
2. Runs `checkOffer` against the buyer's own network, token and pools contract (never the offer's),
   the pool and seats requested, and `maxAmount`. A refused offer is answered
   `{ kind: 'declined', refusal }`, with nothing read, signed or sent.
3. Reads the key's next nonce and the final height, and signs a payment that expires after the
   shorter of the offer's `maxTimeoutSeconds` and the buyer's own `maxTimeoutSeconds`, with the
   offer's `maxGas`.
4. Sends it once, at the URL of the seats requested. The gateway's answer comes back with
   `signed: { nonce, finalHeight, maxBlockHeight }`.

Retrying is the caller's choice, and always signs a new payment. A failure is one of two errors:

| Error | When | What it means |
|---|---|---|
| `PaymentNotSentError`, `reason` `key_not_found` | The account does not exist, or has no such key | Nothing was sent: a new payment is safe |
| `PaymentNotSentError`, `reason` `chain_read` | The nonce or the final height could not be read | Nothing was sent |
| `PaymentNotSentError`, `reason` `signing` | The payment could not be signed | Nothing was sent |
| `PaymentNotSentError`, `reason` `gateway_unreachable` | The connection was never made (`ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`) | Nothing was sent |
| `PaymentUnknownError`, with `signed` | Any other failure once the payment is signed: a timeout, a reset connection, an undocumented answer | It may have been relayed, and may take seats until a final block above `signed.maxBlockHeight` plus a few blocks |

`SETTLE_MARGIN_BLOCKS` is `20n`: the blocks after `maxBlockHeight` in which a payment may still take
seats (the token's transfer, the pools contract's `ft_on_transfer`, the token's resolve). A payment
whose result is unknown is settled once a final block above `maxBlockHeight + SETTLE_MARGIN_BLOCKS`
has been seen; the swarm and the MCP server pay that pool nothing more until then.

## Chain reads

| | Reads | At |
|---|---|---|
| `RpcBuyerChain.nextNonce(accountId, publicKey)` | `view_access_key`, plus 1. Throws `AccessKeyNotFoundError` for a missing account or key | optimistic finality, as the gateway reads it |
| `RpcBuyerChain.finalHeight()` | the latest block's height | final finality |
| `RpcPoolReads.getPool(poolId)` | `get_pool` on the pools contract, or null for no such pool | optimistic finality |

Both classes take a near-api-js `Provider`. `RpcPoolReads` checks every field of the view and keeps
only those fields (`readPoolView`); a malformed result throws `PoolViewError`, whose message names the
field and never quotes the terms. A buyer that relies on a pool's facts reads them here: what an
offer's `extra` says of the pool is the gateway's word.

## Key files

Key files are in near-cli's legacy keychain layout, under a credentials folder
(`~/.near-credentials` by default, `defaultCredentialsDir()`):

| Path | Holds |
|---|---|
| `<dir>/testnet/<account>.json` (`sandbox/` for `near:sandbox`) | One key of the account (`keyFilePath`) |
| `<dir>/testnet/<account>/<public key with : as _>.json` | One file per key, for an account with several (`keyFolderPath`, `folderKeyPath`) |

- `readKeyFile` reads the JSON near-cli-rs writes (`public_key`, `private_key`, seed-phrase fields)
  or the older form (`account_id`, `public_key`, `private_key`), takes `secret_key` when
  `private_key` is absent, and checks that `public_key` matches.
- `writeKeyFile` writes `{account_id, public_key, private_key}` to a new file, mode `0o600`, in a
  folder created with mode `0o700`, flushes it to disk and, on POSIX, syncs the folder. It never
  overwrites a file that holds anything; an empty file, left by a write cut short, is replaced. On
  Windows the modes do not apply.
- `readKeyFolder` reads every key of a key folder, sorted by public key.
- `KeyFileError` has a `problem`: `missing`, `exists` or `invalid`. Its message names the path and
  never quotes the file.

## The spend file

The MCP server's running total of what its buyer has spent, so that a restart does not reset its
spend cap: `{"account": "<buyer>", "spent": "<base units>"}`, by default `data/mcp-spend.json` at
the repository's root (gitignored; `defaultSpendFile()` resolves it from the module's own location).

- `readSpendFile(path, account)` returns 0 when there is no file, and throws `SpendFileError`
  (`other_account` or `malformed`) otherwise.
- `writeSpendFile(path, account, spent)` writes to a temporary file in the same folder, then renames
  it over the path, so a reader sees the old total or the new one. The caller serialises the writes.

The MCP server keeps the file; `swarm setup` clears it on every run whose token top-ups go through.

## Settings

The package loads no `.env` file. Each app passes its environment (`process.env`, as an `Env`) and a
list of problems; `readBuyerSettings` and `readMcpBuyerSettings` append one line per missing or
invalid variable, and `completeConfig` throws a `ConfigError` listing them all. A problem with a URL
names the variable and never quotes the URL, which may carry an API key. Each value shared with the
gateway is read from the gateway's own variable, with the gateway's default.

| Variable | Setting | Default |
|---|---|---|
| `QUORUM_NETWORK` | `network` | `near:testnet` (or `near:sandbox`) |
| `QUORUM_RPC_URL` | `rpcUrl` | `https://test.rpc.fastnear.com` |
| `QUORUM_GATEWAY_URL` | `gatewayUrl`, trailing slashes removed. Its host is the recipient of redemption proofs, so it is written as the gateway's own `QUORUM_GATEWAY_URL` | `http://localhost:8402` |
| `QUORUM_PARENT_ACCOUNT` | `parent` | required |
| `QUORUM_TOKEN_ACCOUNT` | `token` | Circle's testnet USDC, `3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af` (`TESTNET_USDC`) |
| `QUORUM_POOLS_ACCOUNT` | `poolsContract` | `pools.<parent>` |
| `QUORUM_BLOCK_TIME_MS` | `blockTimeMs`: turns an offer's timeout into blocks | `1000` |
| `QUORUM_BUYER_MAX_TIMEOUT_SECONDS` | `maxTimeoutSeconds`: the longest a signed payment stays valid, 30 to 3600 | `120` |

For the MCP server's buyer (`readMcpBuyerSettings`), read by both the MCP server and the swarm:

| Variable | Setting | Default |
|---|---|---|
| `QUORUM_MCP_ACCOUNT` | `mcpAccount` | `buyer-llm.<parent>` |
| `QUORUM_CREDENTIALS_DIR` | `credentialsDir`, an absolute path | `~/.near-credentials` |
| `QUORUM_MCP_SPEND_FILE` | `spendFile`, an absolute path | `data/mcp-spend.json` at the repository's root |

The whole configuration table is in
[section 7.6](../../docs/specs/2026-11-09-quorum-on-near-design.md#76-configuration) of the design
spec.

## Errors for people and agents

Library and RPC messages can hold the RPC URL, which may carry an API key. Text meant for an agent,
or for a buyer's log line, is therefore the caller's own plus at most `transportReason(error)`: a
short reason such as `HTTP 429`, `ECONNREFUSED`, `timeout` or `retries exceeded`, never a quoted
message. `describeError(error, rpcUrl)` gives the full message chain, with the RPC URL replaced by
`QUORUM_RPC_URL`, for the operator's standard error only.

## Who uses it

| App | Uses |
|---|---|
| [`apps/swarm`](../../apps/swarm/README.md) | `Buyer`, `GatewayClient` and `RpcBuyerChain` for the 20 scripted buyers, and `RpcPoolReads` for the pool's deadline and seat price, read once before they act; `GatewayClient.activity` for the final check of a pool; the key files for setup, reset and `keys from-seed`; `writeSpendFile` to clear the MCP server's total; the settings |
| [`apps/mcp`](../../apps/mcp/README.md) | `Buyer`, `GatewayClient`, `RpcBuyerChain` and `RpcPoolReads` behind its four tools; the key file of its buyer; the spend file for its spend cap; the settings |

The gateway ([`apps/gateway`](../../apps/gateway/README.md)) does not use this package: it uses the
protocol package's checks.

## Tests

```bash
pnpm --filter @quorum-on-near/buyer test
pnpm --filter @quorum-on-near/buyer typecheck
```

The vitest suites (`test/`) run against a stub of the gateway's HTTP side (`test/stub-gateway.ts`,
with offers built by the protocol's own `buildOffer`) and stub chain reads, with no network. They
cover every documented answer and the refusal of undocumented ones, the not-sent and unknown paths of
a payment, key files and spend files on disk, the settings' defaults and problems, and that the
package entry exports every module's exports. On Windows, the test of the key file's POSIX modes is
reported skipped.
