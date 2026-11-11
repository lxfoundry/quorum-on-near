import { randomBytes } from 'node:crypto';
import { sha256 } from '@noble/hashes/sha2.js';
import { KeyPair, KeyPairSigner } from 'near-api-js';
import { describe, expect, it } from 'vitest';
import { encodeHeader } from '../src/codec.ts';
import { REDEEM_MAX_AGE_MS, REDEEM_MAX_SKEW_MS } from '../src/constants.ts';
import { checkRedeemProof, nep413Hash, nonceTimeMs, redeemMessage } from '../src/nep413.ts';
import type { RedeemProof } from '../src/nep413.ts';

const ACCOUNT = 'buyer.testnet';
const RECIPIENT = 'localhost:8402';
const POOL_ID = 7;
const NOW_MS = 1_800_000_000_000;

function nonceAt(signedAtMs: number): Uint8Array {
  const nonce = new Uint8Array(32);
  new DataView(nonce.buffer).setBigUint64(0, BigInt(signedAtMs));
  nonce.set(randomBytes(24), 8);
  return nonce;
}

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function ascii(text: string): number[] {
  return [...Buffer.from(text, 'ascii')];
}

/** A fixed nonce, bytes 0 to 31. */
const FIXED_NONCE = Array.from({ length: 32 }, (_, i) => i);
/**
 * The hashed message up to its callbackUrl, laid out by hand from NEP-413 so that near-api-js is not
 * its own oracle: the tag, then the Borsh fields of a payload of `quorum:redeem:7` for RECIPIENT (a
 * string is a u32 little-endian length then UTF-8; the nonce is a fixed-size array, with no length).
 */
const SIGNED_MESSAGE_START = [
  // The tag.
  0x9d, 0x01, 0x00, 0x80,
  // message: string.
  15, 0, 0, 0, ...ascii('quorum:redeem:7'),
  // nonce: [u8; 32].
  ...FIXED_NONCE,
  // recipient: string.
  14, 0, 0, 0, ...ascii(RECIPIENT),
];

/** Changes a base64 character's two low bits, which a 32-byte value's last character does not use. */
function flipLowBits(char: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  return alphabet[alphabet.indexOf(char) ^ 0b01]!;
}

interface ProofOptions {
  keyPair?: KeyPair;
  message?: string;
  recipient?: string;
  signedAtMs?: number;
  nonce?: Uint8Array;
}

/** Signs a redemption proof with near-api-js directly, as a wallet would. */
async function signProof(options: ProofOptions = {}): Promise<RedeemProof> {
  const keyPair = options.keyPair ?? KeyPair.fromRandom('ed25519');
  const message = options.message ?? redeemMessage(POOL_ID);
  const recipient = options.recipient ?? RECIPIENT;
  const nonce = options.nonce ?? nonceAt(options.signedAtMs ?? NOW_MS - 1_000);
  const signed = await new KeyPairSigner(keyPair).signNep413Message(ACCOUNT, { message, recipient, nonce });
  return {
    accountId: signed.accountId,
    publicKey: signed.publicKey.toString(),
    signature: base64(signed.signature),
    message,
    nonce: base64(nonce),
    recipient,
  };
}

function check(proof: unknown, overrides: { nowMs?: number; maxAgeMs?: number } = {}) {
  return checkRedeemProof(encodeHeader(proof), { poolId: POOL_ID, recipient: RECIPIENT, nowMs: NOW_MS, ...overrides });
}

describe('nep413Hash', () => {
  it('is sha256 of the NEP-413 tag 2^31 + 413 as a little-endian u32 (9d 01 00 80), then the payload', () => {
    const payload = { message: 'quorum:redeem:7', nonce: Uint8Array.from(FIXED_NONCE), recipient: RECIPIENT };

    // callbackUrl: Option<string>, None.
    expect(nep413Hash(payload)).toEqual(sha256(Uint8Array.from([...SIGNED_MESSAGE_START, 0])));
  });

  it('lays out a callbackUrl as Some (1), then the string', () => {
    const callbackUrl = 'https://example.com/cb';
    const payload = { message: 'quorum:redeem:7', nonce: Uint8Array.from(FIXED_NONCE), recipient: RECIPIENT, callbackUrl };
    const message = [...SIGNED_MESSAGE_START, 1, 22, 0, 0, 0, ...ascii(callbackUrl)];

    expect(nep413Hash(payload)).toEqual(sha256(Uint8Array.from(message)));
  });

  it('is the hash near-api-js signs, so its signature verifies against it', async () => {
    const keyPair = KeyPair.fromRandom('ed25519');
    const payload = { message: 'quorum:redeem:3', recipient: RECIPIENT, nonce: nonceAt(NOW_MS) };
    const signed = await new KeyPairSigner(keyPair).signNep413Message(ACCOUNT, payload);

    expect(signed.publicKey.verify(nep413Hash(payload), signed.signature)).toBe(true);
  });

  it('is the hash near-api-js signs when a callbackUrl is given', async () => {
    const keyPair = KeyPair.fromRandom('ed25519');
    const payload = { message: 'm', recipient: RECIPIENT, nonce: nonceAt(NOW_MS), callbackUrl: 'https://example.com/cb' };
    const signed = await new KeyPairSigner(keyPair).signNep413Message(ACCOUNT, payload);

    expect(signed.publicKey.verify(nep413Hash(payload), signed.signature)).toBe(true);
  });

  it('treats a null callbackUrl as absent', () => {
    const payload = { message: 'm', recipient: RECIPIENT, nonce: nonceAt(NOW_MS) };

    expect(nep413Hash({ ...payload, callbackUrl: null })).toEqual(nep413Hash(payload));
  });

  it('changes when the callbackUrl is set', () => {
    const payload = { message: 'm', recipient: RECIPIENT, nonce: nonceAt(NOW_MS) };

    expect(nep413Hash({ ...payload, callbackUrl: 'https://example.com/cb' })).not.toEqual(nep413Hash(payload));
  });
});

describe('redeemMessage', () => {
  it('is quorum:redeem: followed by the pool id', () => {
    expect(redeemMessage(42)).toBe('quorum:redeem:42');
  });
});

describe('nonceTimeMs', () => {
  it('reads the first 8 bytes as big-endian milliseconds', () => {
    const nonce = new Uint8Array(32).fill(0xff);
    nonce.set([0x00, 0x00, 0x01, 0x8f, 0x2a, 0x3b, 0x4c, 0x5d]);

    expect(nonceTimeMs(nonce)).toBe(0x018f_2a3b_4c5d);
  });

  it('reads a nonce that is a view into a larger buffer', () => {
    const backing = new Uint8Array(48).fill(0xff);
    backing.set([0, 0, 0, 0, 0, 0, 0x01, 0x02], 8);

    expect(nonceTimeMs(backing.subarray(8, 40))).toBe(0x0102);
  });
});

describe('checkRedeemProof', () => {
  it('accepts a fresh proof and returns the account, the key and the signing time', async () => {
    const keyPair = KeyPair.fromRandom('ed25519');
    const proof = await signProof({ keyPair, signedAtMs: NOW_MS - 2_000 });

    expect(check(proof)).toEqual({
      ok: true,
      accountId: ACCOUNT,
      publicKey: keyPair.getPublicKey().toString(),
      nonceKey: proof.nonce,
      signedAtMs: NOW_MS - 2_000,
    });
  });

  it('accepts a proof signed with a secp256k1 key', async () => {
    const keyPair = KeyPair.fromRandom('secp256k1');
    const result = check(await signProof({ keyPair }));

    expect(result.ok && result.publicKey).toBe(keyPair.getPublicKey().toString());
  });

  it('returns the nonce in standard base64 as nonceKey', async () => {
    const nonce = nonceAt(NOW_MS);
    nonce.set([0xfb, 0xff, 0xbf], 8);
    const result = check(await signProof({ nonce }));

    expect(result.ok && result.nonceKey).toBe(Buffer.from(nonce).toString('base64'));
  });

  it('rejects a header that is not base64 JSON as invalid_proof', () => {
    const result = checkRedeemProof('not a proof', { poolId: POOL_ID, recipient: RECIPIENT, nowMs: NOW_MS });

    expect(result).toEqual({ ok: false, code: 'invalid_proof' });
  });

  it.each([[null], [42], ['proof'], [[1, 2]]])('rejects the JSON value %j as invalid_proof', (value) => {
    expect(check(value)).toEqual({ ok: false, code: 'invalid_proof' });
  });

  it.each(['accountId', 'publicKey', 'signature', 'message', 'nonce', 'recipient'] as const)(
    'rejects a proof without %s as invalid_proof',
    async (field) => {
      const proof: Partial<RedeemProof> = await signProof();
      delete proof[field];

      expect(check(proof)).toEqual({ ok: false, code: 'invalid_proof' });
    },
  );

  it.each<[string, (proof: RedeemProof) => unknown | Promise<unknown>]>([
    ['a nonce that is not a string', (p) => ({ ...p, nonce: [...Buffer.from(p.nonce, 'base64')] })],
    ['a 31-byte nonce', (p) => ({ ...p, nonce: base64(Buffer.from(p.nonce, 'base64').subarray(0, 31)) })],
    ['a 33-byte nonce', (p) => ({ ...p, nonce: base64(Buffer.concat([Buffer.from(p.nonce, 'base64'), Buffer.of(0)])) })],
    ['a nonce in URL-safe base64', (p) => ({ ...p, nonce: Buffer.from(p.nonce, 'base64').toString('base64url') })],
    ['a nonce with unused bits set', (p) => ({ ...p, nonce: `${p.nonce.slice(0, 42)}${flipLowBits(p.nonce[42]!)}=` })],
    ['a signature that is not base64', (p) => ({ ...p, signature: `${p.signature.slice(1)}!` })],
    ['a public key that is not base58', (p) => ({ ...p, publicKey: 'ed25519:0OIl' })],
    ['a public key without its type prefix', (p) => ({ ...p, publicKey: p.publicKey.slice('ed25519:'.length) })],
    ['a public key of an unknown type', (p) => ({ ...p, publicKey: p.publicKey.replace('ed25519:', 'rsa:') })],
    ['a public key of the wrong length', (p) => ({ ...p, publicKey: p.publicKey.slice(0, -4) })],
    [
      'an ed25519 prefix on a 64-byte key, which near-api-js reads as secp256k1',
      (p) => ({ ...p, publicKey: KeyPair.fromRandom('secp256k1').getPublicKey().toString().replace('secp256k1:', 'ed25519:') }),
    ],
    // near-api-js parses and verifies ML-DSA-65 keys too, but a proof is signed by an ed25519 or a secp256k1 key.
    ['a proof signed with an ml-dsa-65 key', () => signProof({ keyPair: KeyPair.fromRandom('ml-dsa-65') })],
    ['an account id that NEAR does not allow', (p) => ({ ...p, accountId: 'Buyer.testnet' })],
    ['a one-character account id', (p) => ({ ...p, accountId: 'b' })],
  ])('rejects %s as invalid_proof', async (_name, mutate) => {
    expect(check(await mutate(await signProof()))).toEqual({ ok: false, code: 'invalid_proof' });
  });

  it('rejects a proof for another pool as wrong_message', async () => {
    const proof = await signProof({ message: redeemMessage(POOL_ID + 1) });

    expect(check(proof)).toEqual({ ok: false, code: 'wrong_message' });
  });

  it('rejects a proof for another gateway as wrong_recipient', async () => {
    const proof = await signProof({ recipient: 'gateway.example.com' });

    expect(check(proof)).toEqual({ ok: false, code: 'wrong_recipient' });
  });

  it('rejects a proof exactly REDEEM_MAX_AGE_MS old as stale_proof', async () => {
    const proof = await signProof({ signedAtMs: NOW_MS - REDEEM_MAX_AGE_MS });

    expect(check(proof)).toEqual({ ok: false, code: 'stale_proof' });
  });

  it('accepts a proof just under REDEEM_MAX_AGE_MS old', async () => {
    const proof = await signProof({ signedAtMs: NOW_MS - REDEEM_MAX_AGE_MS + 1 });

    expect(check(proof).ok).toBe(true);
  });

  it('uses the maxAgeMs it is given in place of REDEEM_MAX_AGE_MS', async () => {
    const proof = await signProof({ signedAtMs: NOW_MS - 1_000 });

    expect(check(proof, { maxAgeMs: 1_000 })).toEqual({ ok: false, code: 'stale_proof' });
    expect(check(proof, { maxAgeMs: 1_001 }).ok).toBe(true);
  });

  it('accepts a proof signed REDEEM_MAX_SKEW_MS ahead of the clock', async () => {
    const proof = await signProof({ signedAtMs: NOW_MS + REDEEM_MAX_SKEW_MS });

    expect(check(proof).ok).toBe(true);
  });

  it('rejects a proof signed more than REDEEM_MAX_SKEW_MS ahead of the clock as stale_proof', async () => {
    const proof = await signProof({ signedAtMs: NOW_MS + REDEEM_MAX_SKEW_MS + 1 });

    expect(check(proof)).toEqual({ ok: false, code: 'stale_proof' });
  });

  it('rejects any proof as stale_proof when the clock reads NaN', async () => {
    const proof = await signProof();

    expect(check(proof, { nowMs: Number.NaN })).toEqual({ ok: false, code: 'stale_proof' });
  });

  it('rejects a proof signed by another key as invalid_signature', async () => {
    const proof = await signProof();
    const other = KeyPair.fromRandom('ed25519').getPublicKey().toString();

    expect(check({ ...proof, publicKey: other })).toEqual({ ok: false, code: 'invalid_signature' });
  });

  it('rejects a proof whose nonce changed after signing as invalid_signature', async () => {
    const proof = await signProof();
    const nonce = Buffer.from(proof.nonce, 'base64');
    nonce[31] = nonce[31]! ^ 0x01;

    expect(check({ ...proof, nonce: base64(nonce) })).toEqual({ ok: false, code: 'invalid_signature' });
  });

  it('rejects a signature of the wrong length as invalid_signature', async () => {
    const proof = await signProof();
    const signature = base64(Buffer.from(proof.signature, 'base64').subarray(0, 63));

    expect(check({ ...proof, signature })).toEqual({ ok: false, code: 'invalid_signature' });
  });

  it('reports the first failure in the order message, recipient, age, signature', async () => {
    const badSignature = base64(new Uint8Array(64));
    const sign = async (options: ProofOptions) => check({ ...(await signProof(options)), signature: badSignature });

    expect(await sign({ message: 'other', recipient: 'other', signedAtMs: 0 })).toEqual({ ok: false, code: 'wrong_message' });
    expect(await sign({ recipient: 'other', signedAtMs: 0 })).toEqual({ ok: false, code: 'wrong_recipient' });
    expect(await sign({ signedAtMs: 0 })).toEqual({ ok: false, code: 'stale_proof' });
    expect(await sign({})).toEqual({ ok: false, code: 'invalid_signature' });
  });
});
