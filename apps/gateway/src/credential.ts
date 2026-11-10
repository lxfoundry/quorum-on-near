import { randomUUID } from 'node:crypto';
import { calculateJwkThumbprint, exportJWK, generateKeyPair, importJWK, SignJWT, type JWK } from 'jose';

export interface CredentialInput {
  buyer: string;
  poolId: number;
  seats: number;
  terms: string;
}

export interface CredentialIssuer {
  /**
   * A compact JWS, `alg: "EdDSA"`, header `kid` = the key's RFC 7638 thumbprint, with claims
   * `iss` (the gateway URL), `sub` (the buyer), `pool`, `seats`, `terms`, `iat` (seconds), `jti` (a
   * fresh UUID) and `simulated: true`.
   */
  issue(input: CredentialInput): Promise<string>;
  /** `{ keys: [public JWK with kid, alg: "EdDSA", use: "sig"] }`, with no private part. */
  jwks(): { keys: JWK[] };
}

const ALG = 'EdDSA';

/** Whether `value` is a private Ed25519 JWK: `kty: "OKP"`, `crv: "Ed25519"`, and `x` and `d` set. */
export function isPrivateEd25519Jwk(value: unknown): value is JWK & { x: string; d: string } {
  if (typeof value !== 'object' || value === null) return false;
  const { kty, crv, x, d } = value as Record<string, unknown>;
  return kty === 'OKP' && crv === 'Ed25519' && typeof x === 'string' && x !== '' && typeof d === 'string' && d !== '';
}

/** Builds an issuer from a private Ed25519 JWK (`kty: "OKP"`, `crv: "Ed25519"`, `x`, `d`). */
export async function createCredentialIssuer(opts: {
  jwk: JWK;
  issuer: string;
  now?: () => number;
  newId?: () => string;
}): Promise<CredentialIssuer> {
  const { jwk, issuer, now = Date.now, newId = randomUUID } = opts;
  if (!isPrivateEd25519Jwk(jwk)) {
    throw new TypeError('the credential key must be a private Ed25519 JWK (kty "OKP", crv "Ed25519", x and d)');
  }
  // The import also fails when `x` is not the public key of `d`.
  const key = await importJWK(jwk, ALG);
  const publicJwk: JWK = { kty: 'OKP', crv: 'Ed25519', x: jwk.x };
  const kid = await calculateJwkThumbprint(publicJwk);

  return {
    issue: ({ buyer, poolId, seats, terms }) =>
      new SignJWT({ pool: poolId, seats, terms, simulated: true })
        .setProtectedHeader({ alg: ALG, kid, typ: 'JWT' })
        .setIssuer(issuer)
        .setSubject(buyer)
        .setIssuedAt(Math.floor(now() / 1000))
        .setJti(newId())
        .sign(key),
    jwks: () => ({ keys: [{ ...publicJwk, kid, alg: ALG, use: 'sig' }] }),
  };
}

/** A new private Ed25519 JWK, for the credential key. */
export async function generateCredentialJwk(): Promise<JWK> {
  const { privateKey } = await generateKeyPair(ALG, { crv: 'Ed25519', extractable: true });
  return exportJWK(privateKey);
}
