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
