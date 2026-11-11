import {
  calculateJwkThumbprint,
  createLocalJWKSet,
  decodeJwt,
  decodeProtectedHeader,
  exportJWK,
  generateKeyPair,
  jwtVerify,
  type JWK,
} from 'jose';
import { describe, expect, it } from 'vitest';
import { createCredentialIssuer, generateCredentialJwk, type CredentialInput } from '../src/credential.ts';

const ISSUER = 'http://localhost:8402';
const NOW_MS = 1_799_999_000_500;
const INPUT: CredentialInput = {
  buyer: 'alice.testnet',
  poolId: 7,
  seats: 3,
  terms: '8×GPU × 24 h; 1 seat = 1 GPU-hour',
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

async function newIssuer(options: { jwk?: JWK; newId?: () => string } = {}) {
  const jwk = options.jwk ?? (await generateCredentialJwk());
  const issuer = await createCredentialIssuer({ jwk, issuer: ISSUER, now: () => NOW_MS, ...options });
  return { jwk, issuer };
}

async function privateJwk(alg: string, crv?: string): Promise<JWK> {
  const { privateKey } = await generateKeyPair(alg, { crv, extractable: true });
  return exportJWK(privateKey);
}

describe('generateCredentialJwk', () => {
  it('generates a private Ed25519 JWK', async () => {
    const jwk = await generateCredentialJwk();
    expect(jwk).toEqual({
      kty: 'OKP',
      crv: 'Ed25519',
      x: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      d: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    });
  });

  it('generates a different key each time', async () => {
    const [a, b] = await Promise.all([generateCredentialJwk(), generateCredentialJwk()]);
    expect(a.d).not.toBe(b.d);
  });
});

describe('createCredentialIssuer', () => {
  it('issues a credential that verifies against its JWKS', async () => {
    const { issuer } = await newIssuer();
    const credential = await issuer.issue(INPUT);
    const { payload } = await jwtVerify(credential, createLocalJWKSet(issuer.jwks()), {
      issuer: ISSUER,
      algorithms: ['EdDSA'],
      currentDate: new Date(NOW_MS),
    });
    expect(payload.sub).toBe(INPUT.buyer);
  });

  it('does not verify a credential against another key', async () => {
    const { issuer } = await newIssuer();
    const { issuer: other } = await newIssuer();
    const credential = await issuer.issue(INPUT);
    await expect(jwtVerify(credential, createLocalJWKSet(other.jwks()))).rejects.toThrow();
  });

  it('signs with alg EdDSA and the key thumbprint as kid', async () => {
    const { jwk, issuer } = await newIssuer();
    const kid = await calculateJwkThumbprint({ kty: 'OKP', crv: 'Ed25519', x: jwk.x });
    expect(decodeProtectedHeader(await issuer.issue(INPUT))).toEqual({ alg: 'EdDSA', kid, typ: 'JWT' });
  });

  it('carries the issuer, buyer, pool, seats, terms, issue time, id and simulated claims', async () => {
    const { issuer } = await newIssuer({ newId: () => 'credential-1' });
    expect(decodeJwt(await issuer.issue(INPUT))).toEqual({
      iss: ISSUER,
      sub: 'alice.testnet',
      pool: 7,
      seats: 3,
      terms: INPUT.terms,
      iat: 1_799_999_000,
      jti: 'credential-1',
      simulated: true,
    });
  });

  it('uses a fresh UUID as jti by default', async () => {
    const { issuer } = await newIssuer();
    expect(decodeJwt(await issuer.issue(INPUT)).jti).toMatch(UUID);
  });

  it('gives two credentials for the same buyer, pool and seats the same sub, pool and seats and different jti', async () => {
    const { issuer } = await newIssuer();
    const first = decodeJwt(await issuer.issue(INPUT));
    const second = decodeJwt(await issuer.issue(INPUT));
    expect([second.sub, second.pool, second.seats]).toEqual([first.sub, first.pool, first.seats]);
    expect(second.jti).not.toBe(first.jti);
  });

  it('publishes a JWKS with the public key only', async () => {
    const { jwk, issuer } = await newIssuer();
    const kid = await calculateJwkThumbprint({ kty: 'OKP', crv: 'Ed25519', x: jwk.x });
    const { keys } = issuer.jwks();
    expect(keys).toEqual([{ kty: 'OKP', crv: 'Ed25519', x: jwk.x, kid, alg: 'EdDSA', use: 'sig' }]);
    expect(keys[0]).not.toHaveProperty('d');
  });

  it('returns a JWKS that callers cannot change', async () => {
    const { issuer } = await newIssuer();
    const before = issuer.jwks();
    issuer.jwks().keys.length = 0;
    expect(issuer.jwks()).toEqual(before);
  });

  it.each([
    ['an EC key', () => privateJwk('ES256')],
    ['an X25519 key', () => privateJwk('ECDH-ES', 'X25519')],
    ['a public Ed25519 key', async () => ({ ...(await generateCredentialJwk()), d: undefined })],
    ['a symmetric key', async () => ({ kty: 'oct', k: 'AAAAAAAAAAAAAAAAAAAAAA' })],
  ])('refuses %s', async (_name, makeJwk) => {
    const jwk = await makeJwk();
    await expect(createCredentialIssuer({ jwk, issuer: ISSUER })).rejects.toThrow(/Ed25519/);
  });

  it('refuses an Ed25519 JWK whose public part does not match its private part', async () => {
    const jwk = { ...(await generateCredentialJwk()), x: (await generateCredentialJwk()).x };
    await expect(createCredentialIssuer({ jwk, issuer: ISSUER })).rejects.toThrow();
  });
});
