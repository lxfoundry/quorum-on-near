import { createHmac, createPrivateKey, pbkdf2Sync } from 'node:crypto';
import { baseEncode, KeyPair, type KeyPairString } from 'near-api-js';
import type { CredentialJwk } from './env-files.ts';

/**
 * Every key of the system, derived from one BIP-39 phrase with Node's built-in crypto only: the
 * phrase gives a BIP-39 seed (PBKDF2-HMAC-SHA512), and the seed gives an ed25519 key at each path by
 * SLIP-10, every level hardened, under NEAR's prefix m/44'/397'. The parent's path is NEAR's standard
 * one, so a NEAR wallet or near-cli-rs given the phrase derives the same parent key. Each key's path
 * comes from its role, never from an account's name. Nothing here puts the phrase, the seed or a
 * private key in an error message.
 */

/** The parent account's key: NEAR's standard path. */
export const PARENT_PATH = "m/44'/397'/0'";
/** The funding account's key, unless the funding account is the parent, which signs with the parent's key. */
export const FUNDING_PATH = "m/44'/397'/1'";
/** The pools account's key. */
export const POOLS_PATH = "m/44'/397'/2'";
/** The provider's key. */
export const PROVIDER_PATH = "m/44'/397'/3'";
/** The key of the MCP server's buyer. */
export const MCP_BUYER_PATH = "m/44'/397'/199'";
/** The gateway's credential key, which signs the access credentials it issues. */
export const CREDENTIAL_PATH = "m/44'/397'/900'";
/** The most keys the relayer may have: their paths, m/44'/397'/10' to m/44'/397'/99', end where the buyers' begin. */
export const MAX_RELAYER_KEYS = 90;
/** The scripted buyers the paths number, buyer-01 to buyer-20, at m/44'/397'/101' to m/44'/397'/120'. */
export const SCRIPTED_BUYERS = 20;

/** The path of the relayer's key `index`, from 0: m/44'/397'/(10 + index)'. Throws RangeError unless `index` is 0 to 89. */
export function relayerKeyPath(index: number): string {
  if (!Number.isInteger(index) || index < 0 || index >= MAX_RELAYER_KEYS) {
    throw new RangeError(`a relayer key index is an integer from 0 to ${MAX_RELAYER_KEYS - 1}, not ${index}`);
  }
  return `m/44'/397'/${10 + index}'`;
}

/** The path of the scripted buyer buyer-NN, NN being `number`: m/44'/397'/(100 + number)'. Throws RangeError unless it is 1 to 20. */
export function scriptedBuyerPath(number: number): string {
  if (!Number.isInteger(number) || number < 1 || number > SCRIPTED_BUYERS) {
    throw new RangeError(`a scripted buyer is numbered from 1 to ${SCRIPTED_BUYERS}, not ${number}`);
  }
  return `m/44'/397'/${100 + number}'`;
}

/** A phrase that does not have 12 or 24 words. The message gives the count, never a word of the phrase. */
export class SeedPhraseError extends Error {
  override name = 'SeedPhraseError';
  readonly words: number;

  constructor(words: number) {
    super(`a seed phrase has 12 or 24 words, not ${words}`);
    this.words = words;
  }
}

/**
 * The phrase as its seed is computed: its words, split on any whitespace, lowercased and joined with
 * single spaces, so that line breaks, extra spaces and capitals do not change the keys. Throws
 * SeedPhraseError unless it has 12 or 24 words. Neither the BIP-39 wordlist nor its checksum is
 * checked: a wrong phrase gives keys that no account holds, which the chain check finds.
 */
export function normalisePhrase(raw: string): string {
  const words = raw
    .split(/\s+/)
    .filter((word) => word !== '')
    .map((word) => word.toLowerCase());
  if (words.length !== 12 && words.length !== 24) throw new SeedPhraseError(words.length);
  return words.join(' ');
}

/**
 * The BIP-39 seed of `phrase`: PBKDF2-HMAC-SHA512 of the phrase, with the salt `mnemonic` followed by
 * `passphrase`, both normalised to NFKD and encoded in UTF-8, 2,048 iterations, 64 bytes. The swarm
 * always uses the empty passphrase; it is a parameter so that BIP-39's published vectors, made with
 * the passphrase "TREZOR", can be checked.
 */
export function bip39Seed(phrase: string, passphrase = ''): Buffer {
  const password = Buffer.from(phrase.normalize('NFKD'), 'utf8');
  const salt = Buffer.from(`mnemonic${passphrase}`.normalize('NFKD'), 'utf8');
  return pbkdf2Sync(password, salt, 2048, 64, 'sha512');
}

/** A SLIP-10 node: its 32-byte ed25519 private key and its 32-byte chain code. */
export interface ExtendedKey {
  key: Buffer;
  chainCode: Buffer;
}

/** 2^31, which SLIP-10 adds to an index to make it hardened. */
const HARDENED = 0x8000_0000;
/** `m`, then each level as decimal digits without a leading zero and a `'`. */
const PATH = /^m(\/(0|[1-9][0-9]*)')*$/;

/**
 * The indices of a derivation path such as m/44'/397'/0': every level hardened (`'`) and below 2^31,
 * since SLIP-10 derives ed25519 keys at hardened indices only. Throws RangeError for any other path.
 */
export function parsePath(path: string): number[] {
  if (!PATH.test(path)) throw new RangeError(`not a path of hardened indices: ${JSON.stringify(path)}`);
  const indices = path
    .split('/')
    .slice(1)
    .map((level) => Number(level.slice(0, -1)));
  if (indices.some((index) => index >= HARDENED)) throw new RangeError(`${JSON.stringify(path)} has an index of 2^31 or more`);
  return indices;
}

/** The two halves of an HMAC-SHA512 digest: the key, then the chain code. */
function split(digest: Buffer): ExtendedKey {
  return { key: digest.subarray(0, 32), chainCode: digest.subarray(32) };
}

/** SLIP-10's master node for ed25519: HMAC-SHA512 keyed with "ed25519 seed", over the seed. */
function masterKey(seed: Uint8Array): ExtendedKey {
  return split(createHmac('sha512', 'ed25519 seed').update(seed).digest());
}

/**
 * SLIP-10's hardened child for ed25519: HMAC-SHA512 keyed with the parent's chain code, over 0x00,
 * the parent's key, then index + 2^31 as 4 big-endian bytes.
 */
function hardenedChild(parent: ExtendedKey, index: number): ExtendedKey {
  const data = Buffer.alloc(37);
  parent.key.copy(data, 1);
  data.writeUInt32BE(index + HARDENED, 33);
  return split(createHmac('sha512', parent.chainCode).update(data).digest());
}

/** The SLIP-10 ed25519 node at `path` (parsePath) of `seed`. */
export function slip10Derive(seed: Uint8Array, path: string): ExtendedKey {
  return parsePath(path).reduce(hardenedChild, masterKey(seed));
}

/** The PKCS#8 DER header of an Ed25519 private key (RFC 8410), which node:crypto imports with the 32 raw bytes after it. */
const PKCS8_ED25519_HEADER = Buffer.from('302e020100300506032b657004220420', 'hex');

/** The JWK members of the Ed25519 key whose 32-byte private key is `privateKey`: `d` is that key, `x` its public key, both base64url. */
function ed25519Jwk(privateKey: Uint8Array): { x: string; d: string } {
  if (privateKey.length !== 32) throw new RangeError(`an ed25519 private key has 32 bytes, not ${privateKey.length}`);
  const key = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_HEADER, privateKey]), format: 'der', type: 'pkcs8' });
  const { x, d } = key.export({ format: 'jwk' });
  if (typeof x !== 'string' || typeof d !== 'string') throw new TypeError('node:crypto exported an Ed25519 key without x and d');
  return { x, d };
}

/** The 32-byte Ed25519 public key of a 32-byte private key. */
export function ed25519PublicKey(privateKey: Uint8Array): Buffer {
  return Buffer.from(ed25519Jwk(privateKey).x, 'base64url');
}

/** A NEAR key derived from a seed. */
export interface NearKey {
  /** The path it was derived at. */
  path: string;
  /** `ed25519:` and the base58 of its 32-byte public key, as NEAR writes public keys. */
  publicKey: string;
  /**
   * Its key pair, which near-api-js reads from `ed25519:` and the base58 of its 64-byte secret key:
   * the 32-byte private key, then the public key, as near-cli writes it in key files.
   */
  keyPair: KeyPair;
}

/** The NEAR key at `path` of `seed`. */
export function nearKey(seed: Uint8Array, path: string): NearKey {
  const { key } = slip10Derive(seed, path);
  const publicKey = ed25519PublicKey(key);
  const keyPair = KeyPair.fromString(`ed25519:${baseEncode(Buffer.concat([key, publicKey]))}` as KeyPairString);
  return { path, publicKey: `ed25519:${baseEncode(publicKey)}`, keyPair };
}

/** The gateway's credential key, at CREDENTIAL_PATH of `seed`, as the private JWK the gateway reads in QUORUM_CREDENTIAL_JWK. */
export function credentialJwk(seed: Uint8Array): CredentialJwk {
  const { x, d } = ed25519Jwk(slip10Derive(seed, CREDENTIAL_PATH).key);
  return { kty: 'OKP', crv: 'Ed25519', x, d };
}
