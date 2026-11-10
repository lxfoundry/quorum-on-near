import { sha256 } from '@noble/hashes/sha2.js';
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

/** True when the signature is valid for the delegate's public key over delegateHash. Never throws. */
export function verifyDelegateSignature(signed: DecodedSignedDelegate): boolean {
  try {
    const key = keyOf(signed.delegateAction.publicKey);
    const signature = signatureOf(signed.signature);
    if (signature.keyType !== key.keyType) return false;
    return new PublicKey(key).verify(delegateHash(signed.delegateAction), signature.data);
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

function isFunctionCall(action: DecodedAction): action is { functionCall: DecodedFunctionCall } {
  return 'functionCall' in action;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}
