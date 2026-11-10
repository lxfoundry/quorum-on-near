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
