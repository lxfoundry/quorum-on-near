import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToNumberLE, concatBytes } from '@noble/curves/utils.js';
import { sha256, sha512 } from '@noble/hashes/sha2.js';
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

/**
 * True when the signature is valid for the delegate's public key over delegateHash, by near-api-js's
 * check and by nearcore's: nearcore refuses some signatures that near-api-js takes, and a delegate
 * that fails on chain costs the relayer its gas without using up the nonce. Never throws.
 */
export function verifyDelegateSignature(signed: DecodedSignedDelegate): boolean {
  try {
    const key = keyOf(signed.delegateAction.publicKey);
    const signature = signatureOf(signed.signature);
    if (signature.keyType !== key.keyType) return false;
    const hash = delegateHash(signed.delegateAction);
    if (!new PublicKey(key).verify(hash, signature.data)) return false;
    return key.keyType === KeyType.ED25519
      ? ed25519MatchesNearcore(key.data, signature.data, hash)
      : secp256k1MatchesNearcore(signature.data);
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

/**
 * The part of nearcore's secp256k1 check that near-api-js skips. The signature is 64 bytes of (r, s)
 * then a recovery byte, which near-api-js never reads while nearcore parses it as a recovery id and
 * refuses anything above 3. The rest (low s, a valid point) is checked by both.
 */
function secp256k1MatchesNearcore(signature: Uint8Array): boolean {
  return signature.length === 65 && (signature[64] ?? 0) <= 3;
}

/**
 * The part of nearcore's ed25519 check that near-api-js skips. near-api-js takes ZIP-215 signatures,
 * where the check is [8]([s]B - [k]A - R) = 0: it ignores a small-order component of R and takes
 * a non-canonical encoding of R. nearcore uses ed25519-dalek, which computes
 * R' = [s]B - [k]A and requires its canonical encoding to equal the bytes of R. Here k is
 * sha512(R ++ A ++ message) mod L, with R and A as written in the signature and the key.
 * Whatever dalek takes, ZIP-215 takes too, so this only narrows the set. Both require s < L.
 */
function ed25519MatchesNearcore(publicKey: Uint8Array, signature: Uint8Array, message: Uint8Array): boolean {
  if (publicKey.length !== 32 || signature.length !== 64) return false;
  const rBytes = signature.subarray(0, 32);
  const s = bytesToNumberLE(signature.subarray(32));
  const order = ed25519.Point.Fn.ORDER;
  if (s >= order) return false;
  // Unreduced encodings of A are decoded as ed25519-dalek does, which reduces them.
  const point = ed25519.Point.fromBytes(publicKey, true);
  const k = bytesToNumberLE(sha512(concatBytes(rBytes, publicKey, message))) % order;
  const expected = ed25519.Point.BASE.multiplyUnsafe(s).subtract(point.multiplyUnsafe(k)).toBytes();
  return sameBytes(expected, rBytes);
}

function isFunctionCall(action: DecodedAction): action is { functionCall: DecodedFunctionCall } {
  return 'functionCall' in action;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}
