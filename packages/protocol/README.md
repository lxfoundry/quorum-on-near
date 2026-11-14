# @quorum-on-near/protocol

The `quorum` x402 scheme: its types, its header codecs, the checks of a payment and of a redemption
proof, the builders a buyer signs with, and the reading of a transaction's outcome. The gateway
checks with it; the buyer side ([`packages/buyer`](../buyer/README.md)) builds with it. The full
rules are in section 6 of the
[design spec](../../docs/specs/2026-11-09-quorum-on-near-design.md#6-the-quorum-x402-scheme).

## The scheme

| | |
|---|---|
| Wire format | x402 version 1 (`X402_VERSION = 1`): a JSON body on the `402`, and headers that each carry base64 of JSON |
| Scheme | `quorum` (`SCHEME`). It is not one of the published x402 schemes |
| Network | CAIP-2 form: `near:testnet`, or `near:sandbox` for a local test chain |
| Payment | An NEP-366 signed delegate action holding one call: `ft_transfer_call` on the token, to the pools contract, with the message `{"commit":{"pool_id":7,"seats":2}}` and 1 yoctoNEAR |
| Redemption | An NEP-413 signed message `quorum:redeem:<poolId>`, for the gateway's host |

**Why a new scheme.** A payment in the standard `exact` scheme is a transfer to an address. A seat
is taken only when the token calls the pools contract's `ft_on_transfer` with a `commit` message,
which may take fewer seats than paid for and return the rest. An `exact` facilitator cannot build,
check or settle that call, and cannot tell the buyer which seats it got. In `quorum`, the gateway
plays both x402 roles: resource server and facilitator.

The `Network` type is any `near:<id>`. Which networks an app accepts is its configuration's rule:
the gateway and the buyer side take `near:testnet` and `near:sandbox`. `checkChainId` checks a
network against the `chain_id` an RPC reports: `near:testnet` needs `testnet`, and any other network
needs a chain that is neither `testnet` nor `mainnet`.

## Headers

Each header is `base64(JSON.stringify(value))`, standard alphabet with padding (`encodeHeader`,
`decodeHeader`).

| Header | Direction | Decoded fields | Type |
|---|---|---|---|
| `X-PAYMENT` (`PAYMENT_HEADER`) | buyer to gateway | `x402Version: 1`, `scheme: "quorum"`, `network`, `payload.signedDelegate`: base64 of the Borsh-encoded `SignedDelegate` | `PaymentPayload` |
| `X-PAYMENT-RESPONSE` (`PAYMENT_RESPONSE_HEADER`) | gateway to buyer, with a `202` or `200` to a payment | `success: true`, `transaction` (the relayed transaction's hash), `network`, `payer` | `PaymentResponse` |
| `X-QUORUM-PROOF` (`PROOF_HEADER`) | buyer to gateway | `accountId`, `publicKey` (`ed25519:<base58>` or `secp256k1:<base58>`), `signature` (base64), `message` (`quorum:redeem:<poolId>`), `nonce` (base64 of 32 bytes: the signing time in milliseconds as a big-endian u64, then 24 random bytes), `recipient` (the gateway's `host` or `host:port`) | `RedeemProof` |

## The offer

The `402` body is `{x402Version: 1, error, accepts: [offer]}` (`PaymentRequired`, built by
`paymentRequired`). One offer (`Offer`, built by `buildOffer`):

| Field | Value |
|---|---|
| `scheme`, `network` | `quorum`, the gateway's network |
| `maxAmountRequired` | `extra.seats × extra.seatPrice`, in the token's base units, as a decimal string |
| `resource` | `<gateway URL>/pools/<id>/access?seats=<seats>` |
| `description` | `"2 seats in pool 7: <terms>"` (`"1 seat …"` for one) |
| `mimeType` | `application/json` |
| `payTo` | The pools contract |
| `maxTimeoutSeconds` | How long a payment may stay valid |
| `asset` | The token the pools contract was initialised with |

`extra` (`OfferExtra`):

| Field | Meaning |
|---|---|
| `poolId`, `seats` | The pool, and the seats offered: the seats requested, or fewer (`offerSeats`: `min(requested, target − taken, max_seats_per_buyer)`) |
| `seatPrice`, `bonus` | Decimal strings, in base units |
| `target`, `taken`, `deadlineMs` | The pool's target, seats taken, and deadline in milliseconds (block time) |
| `minBonusPerSeat` | The least a seat receives from the bonus if the pool fails: `floor(bonus / max(target − 1, 1))` |
| `terms` | The seller's terms |
| `relayer` | The account that relays the payment |
| `minGas`, `maxGas` | The gas bounds of the inner `ft_transfer_call`, decimal strings |

## Modules

Everything is exported from the package entry, `src/index.ts`.

| Module | Main exports |
|---|---|
| `constants.ts` | `X402_VERSION`, `SCHEME`, `ONE_YOCTO`, `NEP366_TAG`, `NEP413_TAG`, `REDEEM_MAX_AGE_MS` (5 minutes), `REDEEM_MAX_SKEW_MS` (1 minute), `PAYMENT_HEADER`, `PAYMENT_RESPONSE_HEADER`, `PROOF_HEADER`, type `Network` |
| `codec.ts` | `encodeHeader`, `decodeHeader`; types `PaymentPayload`, `PaymentResponse` |
| `offer.ts` | `offerSeats`, `buildOffer`, `paymentRequired`; types `Offer`, `OfferExtra`, `OfferContext`, `PaymentRequired` |
| `contract.ts` | The pools contract's JSON interface: types `PoolView`, `SeatView`, `BuyerView`, `PoolStatus`, `BuyerState`, `QuorumEvent`; `commitMsg`, `parseEventLog` (NEP-297 events of standard `quorum`, version `1.0.0`), `MAX_PAGE` (100 rows per view call) |
| `delegate.ts` | NEP-366: `decodeSignedDelegate`, `encodeSignedDelegate`, `delegateHash`, `delegatePublicKey`, `verifyDelegateSignature` (near-api-js's check and nearcore's), `onlyFunctionCall` |
| `nep413.ts` | NEP-413: `nep413Hash`, `redeemMessage`, `nonceTimeMs`, `checkRedeemProof`; types `RedeemProof`, `ProofCheck`, `ProofErrorCode` |
| `checks.ts` | `checkPaymentHeader`: checks 1 to 3 of the gateway's table (payload and signature; one `ft_transfer_call` on the token with 1 yoctoNEAR and gas within bounds; the arguments match the offer). Types `ExpectedPayment`, `CheckedPayment`, `StaticErrorCode`, `GatewayErrorCode`, `PaymentErrorCode` |
| `client.ts` | The buyer's builders: `checkOffer`, `buildPaymentHeader`, `buildRedeemProofHeader`, `maxBlockHeightFor`, `OfferRefusedError`; types `ExpectedOffer`, `PaymentInput`, `ProofInput`, `OfferRefusal`, `OfferErrorCode` |
| `amounts.ts` | `priceOf`, `minBonusPerSeat`, `parseAmount` (a decimal string with no sign or leading zero, or null) |
| `account.ts` | `isAccountId`: NEAR's account id rule, 2 to 64 characters |
| `outcome.ts` | `toTxOutcome` (an RPC transaction response, once executed, as a `TxOutcome`), `poolsEvents` (the `quorum` events of the pools contract's successful receipts); types `TxOutcome`, `ReceiptOutcome` |
| `network.ts` | `checkChainId` |

The checks never throw: `checkPaymentHeader`, `checkRedeemProof` and `checkOffer` return the first
failure as a code, or the checked value. `checkRedeemProof` checks the message, the recipient, the
proof's age and the signature; that the key is a full-access key of the account needs the chain, so
it is the caller's check.

## Building a payment and a proof

The buyer's builders do no network I/O. The caller reads the key's next nonce (its on-chain nonce
plus 1) and the latest final block's height, and passes them in.

`checkOffer` checks an offer against the buyer's own configuration, request and budget, in this
order: the scheme; the network, `asset` and `payTo` against the buyer's own network, token and pools
contract (never the offer's); the fields the payment is built from are well formed; `extra.poolId`
is the pool asked for; `extra.seats` is at most the seats asked for; `maxAmountRequired` is exactly
`extra.seats × extra.seatPrice`, and at most `maxAmount`. It returns the first refusal (`wrong_scheme`,
`wrong_network`, `wrong_asset`, `wrong_pay_to`, `invalid_offer`, `wrong_pool`, `too_many_seats`,
`wrong_amount`, `over_budget`), or null. `buildPaymentHeader` runs the same check and throws
`OfferRefusedError`, before signing anything, for an offer it refuses. It attaches the offer's
`maxGas` unless `gas` is given.

```ts
import type { KeyPair } from 'near-api-js';
import {
  PAYMENT_HEADER,
  PROOF_HEADER,
  buildPaymentHeader,
  buildRedeemProofHeader,
  checkOffer,
  maxBlockHeightFor,
  type ExpectedOffer,
  type Offer,
} from '@quorum-on-near/protocol';

declare const offer: Offer; // accepts[0] of the 402 body
declare const keyPair: KeyPair; // a full-access key of the buyer's account
declare const nonce: bigint; // the key's on-chain nonce plus 1, read by the caller
declare const finalHeight: bigint; // the latest final block's height, read by the caller

const buyer = 'buyer-01.quorum-parent-4821.testnet';
const expected: ExpectedOffer = {
  network: 'near:testnet',
  token: '3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af',
  poolsContract: 'pools.quorum-parent-4821.testnet',
  poolId: 7,
  maxSeats: 2,
  maxAmount: 400n, // base units
};

const refusal = checkOffer(offer, expected);
if (refusal !== null) throw new Error(`offer declined: ${refusal.code}`);

const payment = await buildPaymentHeader({
  keyPair,
  senderId: buyer,
  nonce,
  maxBlockHeight: maxBlockHeightFor(finalHeight, offer.maxTimeoutSeconds, 1000),
  offer,
  expected,
});
await fetch('http://localhost:8402/pools/7/access?seats=2', { headers: { [PAYMENT_HEADER]: payment } });

const proof = await buildRedeemProofHeader({
  keyPair,
  accountId: buyer,
  poolId: 7,
  recipient: 'localhost:8402', // the gateway's host
  nowMs: Date.now(),
});
await fetch('http://localhost:8402/pools/7/access', { headers: { [PROOF_HEADER]: proof } });
```

`maxBlockHeightFor(finalHeight, maxTimeoutSeconds, blockTimeMs)` is
`finalHeight + floor(maxTimeoutSeconds × 1000 / blockTimeMs)`, the latest expiry an offer allows.
`buildRedeemProofHeader` draws the 24 random bytes of the nonce itself unless `random` is given. A
proof is accepted for 5 minutes after it was signed, and its nonce only once, so a buyer signs a new
one for each redemption. [`packages/buyer`](../buyer/README.md) wraps these builders with the chain
reads and the gateway's answers.

## What is simulated

The protocol carries real payments: each one moves the token on NEAR testnet (Circle's testnet USDC
there). What a filled pool gives a buyer is a credential, a compact JWS whose claims include
`simulated: true`: in the worked example, the provider and the GPU access it sells are simulated,
and no resource stands behind the credential
([section 6.6](../../docs/specs/2026-11-09-quorum-on-near-design.md#66-credential)).

## Limits

- **Node-oriented.** It uses `Buffer` and `node:crypto`, so it does not run in a browser as is.
- **Private.** `package.json` sets `private: true`: it is a workspace package, not published to npm.
- **No build step.** The package entry is the TypeScript source, `src/index.ts`, which Node runs
  directly (type stripping, Node 22.22.2 or later).
- **Key types.** Delegate actions and proofs are signed with ed25519 or secp256k1 keys only.

## Tests

```bash
pnpm --filter @quorum-on-near/protocol test
pnpm --filter @quorum-on-near/protocol typecheck
```

The vitest suites (`test/`) need no network and no chain. They cover each check's
codes in order, the header codec, delegate and NEP-413 signatures against near-api-js (including
signatures near-api-js accepts and nearcore refuses), the offer's amounts, event parsing and
transaction outcomes.

## See also

- [Design spec](../../docs/specs/2026-11-09-quorum-on-near-design.md): endpoints
  ([6.1](../../docs/specs/2026-11-09-quorum-on-near-design.md#61-endpoints)), offer
  ([6.2](../../docs/specs/2026-11-09-quorum-on-near-design.md#62-offer)), payment
  ([6.3](../../docs/specs/2026-11-09-quorum-on-near-design.md#63-payment)), checks and relay
  ([6.4](../../docs/specs/2026-11-09-quorum-on-near-design.md#64-checks-then-relay)), redemption
  ([6.5](../../docs/specs/2026-11-09-quorum-on-near-design.md#65-redemption)).
- [`packages/buyer`](../buyer/README.md), [`apps/gateway`](../../apps/gateway/README.md),
  [`apps/swarm`](../../apps/swarm/README.md), [`apps/mcp`](../../apps/mcp/README.md).
