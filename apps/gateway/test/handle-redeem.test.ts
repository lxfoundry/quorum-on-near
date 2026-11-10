import { createLocalJWKSet, decodeJwt, jwtVerify } from 'jose';
import { KeyPair } from 'near-api-js';
import { describe, expect, it, vi } from 'vitest';
import {
  REDEEM_MAX_AGE_MS,
  REDEEM_MAX_SKEW_MS,
  buildRedeemProofHeader,
  decodeHeader,
  encodeHeader,
  type BuyerState,
  type BuyerView,
  type PoolStatus,
  type PoolView,
  type ProofInput,
} from '@quorum-on-near/protocol';
import type { ActivityRecord } from '../src/activity.ts';
import type { AccessKeyInfo } from '../src/chain.ts';
import type { GatewayConfig } from '../src/config.ts';
import { handleRedeem } from '../src/handle-redeem.ts';
import { NOW_MS, TERMS, poolView, testConfig } from './fake-chain.ts';
import { testDeps } from './handler-deps.ts';

const BUYER = 'alice.testnet';
const OTHER_BUYER = 'bob.testnet';
const POOL_ID = 7;
/** The host of testConfig's public URL. */
const RECIPIENT = 'localhost:8402';
const FULL_ACCESS: AccessKeyInfo = { nonce: 5n, fullAccess: true };

/**
 * Handler deps over a FakeChain holding pool 7 and a buyer with a full-access key and 2 committed
 * seats, plus a builder for that buyer's proofs.
 */
async function setup(
  opts: {
    pool?: Partial<PoolView>;
    holding?: BuyerView | null;
    key?: AccessKeyInfo | null;
    config?: GatewayConfig;
  } = {},
) {
  const deps = await testDeps(opts.config ? { config: opts.config } : {});
  const keyPair = KeyPair.fromRandom('ed25519');
  deps.fake.setPool(poolView({ id: POOL_ID, ...opts.pool }));
  const key = opts.key === undefined ? FULL_ACCESS : opts.key;
  if (key !== null) deps.fake.setKey(BUYER, keyPair.getPublicKey().toString(), key);
  deps.fake.setBuyer(POOL_ID, BUYER, opts.holding === undefined ? { seats: 2, state: 'committed' } : opts.holding);
  const proof = (overrides: Partial<ProofInput> = {}) =>
    buildRedeemProofHeader({ keyPair, accountId: BUYER, poolId: POOL_ID, recipient: RECIPIENT, nowMs: NOW_MS, ...overrides });
  return { deps, proof };
}

function refundRecord(overrides: Partial<ActivityRecord> = {}): ActivityRecord {
  return {
    at: NOW_MS,
    poolId: POOL_ID,
    kind: 'refund',
    account: BUYER,
    seats: 2,
    amount: '360',
    txHash: 'RefundTx1',
    ok: true,
    ...overrides,
  };
}

describe('handleRedeem', () => {
  describe('pool lookup', () => {
    it('answers 404 unknown_pool for a pool that does not exist', async () => {
      const { deps, proof } = await setup();
      expect(await handleRedeem(deps, 8, await proof({ poolId: 8 }))).toEqual({ status: 404, body: { error: 'unknown_pool' } });
    });

    it("answers 404 unknown_pool for another seller's pool", async () => {
      const { deps, proof } = await setup({ pool: { seller: 'other-seller.testnet' } });
      expect(await handleRedeem(deps, POOL_ID, await proof())).toEqual({ status: 404, body: { error: 'unknown_pool' } });
    });
  });

  describe('proof checks', () => {
    it('answers 401 invalid_proof for a header that does not decode to a proof', async () => {
      const { deps } = await setup();
      expect(await handleRedeem(deps, POOL_ID, 'not-a-proof')).toEqual({ status: 401, body: { error: 'invalid_proof' } });
    });

    it("answers 401 wrong_message for another pool's proof", async () => {
      const { deps, proof } = await setup();
      expect(await handleRedeem(deps, POOL_ID, await proof({ poolId: 8 }))).toEqual({
        status: 401,
        body: { error: 'wrong_message' },
      });
    });

    it('answers 401 wrong_recipient for a proof addressed to another host', async () => {
      const { deps, proof } = await setup();
      expect(await handleRedeem(deps, POOL_ID, await proof({ recipient: 'gateway.example.org' }))).toEqual({
        status: 401,
        body: { error: 'wrong_recipient' },
      });
    });

    it('accepts a proof addressed to the host of the configured public URL', async () => {
      const { deps, proof } = await setup({ config: testConfig({ publicUrl: 'https://gateway.example.org' }) });
      const result = await handleRedeem(deps, POOL_ID, await proof({ recipient: 'gateway.example.org' }));
      expect(result.status).toBe(202);
    });

    it.each([
      ['signed 5 minutes ago', NOW_MS - REDEEM_MAX_AGE_MS],
      ['signed further ahead than the allowed clock skew', NOW_MS + REDEEM_MAX_SKEW_MS + 1],
    ])('answers 401 stale_proof for a proof %s', async (_name, signedAtMs) => {
      const { deps, proof } = await setup();
      expect(await handleRedeem(deps, POOL_ID, await proof({ nowMs: signedAtMs }))).toEqual({
        status: 401,
        body: { error: 'stale_proof' },
      });
    });

    it('answers 401 invalid_signature for a proof that names a key other than the signing one', async () => {
      const { deps, proof } = await setup();
      const other = KeyPair.fromRandom('ed25519').getPublicKey().toString();
      deps.fake.setKey(BUYER, other, FULL_ACCESS);
      const forged = encodeHeader({ ...(decodeHeader(await proof()) as object), publicKey: other });
      expect(await handleRedeem(deps, POOL_ID, forged)).toEqual({ status: 401, body: { error: 'invalid_signature' } });
    });

    it('answers 401 not_full_access when the account has no such key', async () => {
      const { deps, proof } = await setup({ key: null });
      expect(await handleRedeem(deps, POOL_ID, await proof())).toEqual({ status: 401, body: { error: 'not_full_access' } });
    });

    it('answers 401 not_full_access for a function-call key', async () => {
      const { deps, proof } = await setup({ key: { nonce: 5n, fullAccess: false } });
      expect(await handleRedeem(deps, POOL_ID, await proof())).toEqual({ status: 401, body: { error: 'not_full_access' } });
    });

    it('answers 401 replayed_proof on the second use of the same proof', async () => {
      const { deps, proof } = await setup();
      const header = await proof();
      expect((await handleRedeem(deps, POOL_ID, header)).status).toBe(202);
      expect(await handleRedeem(deps, POOL_ID, header)).toEqual({ status: 401, body: { error: 'replayed_proof' } });
    });

    it('answers 401 replayed_proof to the same proof presented under another account that holds the same full-access key', async () => {
      const { deps, proof } = await setup();
      const header = await proof();
      const decoded = decodeHeader(header) as { publicKey: string };
      deps.fake.setKey(OTHER_BUYER, decoded.publicKey, FULL_ACCESS);
      deps.fake.setBuyer(POOL_ID, OTHER_BUYER, { seats: 2, state: 'committed' });
      const underOtherBuyer = encodeHeader({ ...decoded, accountId: OTHER_BUYER });
      expect((await handleRedeem(deps, POOL_ID, header)).status).toBe(202);
      expect(await handleRedeem(deps, POOL_ID, underOtherBuyer)).toEqual({ status: 401, body: { error: 'replayed_proof' } });
    });

    it('accepts proofs signed by two keys with the same nonce', async () => {
      const { deps, proof } = await setup();
      const otherKey = KeyPair.fromRandom('ed25519');
      deps.fake.setKey(BUYER, otherKey.getPublicKey().toString(), FULL_ACCESS);
      const random = new Uint8Array(24).fill(1);
      expect((await handleRedeem(deps, POOL_ID, await proof({ random }))).status).toBe(202);
      expect((await handleRedeem(deps, POOL_ID, await proof({ keyPair: otherKey, random }))).status).toBe(202);
    });

    it('accepts a second proof from the same buyer', async () => {
      const { deps, proof } = await setup();
      expect((await handleRedeem(deps, POOL_ID, await proof())).status).toBe(202);
      expect((await handleRedeem(deps, POOL_ID, await proof())).status).toBe(202);
    });

    it('does not use up a proof refused for its key', async () => {
      const { deps, proof } = await setup({ key: { nonce: 5n, fullAccess: false } });
      const header = await proof();
      expect((await handleRedeem(deps, POOL_ID, header)).status).toBe(401);
      deps.fake.setKey(BUYER, (decodeHeader(header) as { publicKey: string }).publicKey, FULL_ACCESS);
      expect((await handleRedeem(deps, POOL_ID, header)).status).toBe(202);
    });
  });

  describe('holdings', () => {
    it.each([
      ['holds no seats', null],
      ['holds 0 seats', { seats: 0, state: 'committed' } satisfies BuyerView],
    ])('answers 404 no_seats when the account %s', async (_name, holding) => {
      const { deps, proof } = await setup({ holding });
      expect(await handleRedeem(deps, POOL_ID, await proof())).toEqual({ status: 404, body: { error: 'no_seats' } });
    });

    it('answers 202 pending with the seats and the pool progress for an open pool', async () => {
      const { deps, proof } = await setup({ pool: { status: 'open', taken: 150, target: 192 } });
      expect(await handleRedeem(deps, POOL_ID, await proof())).toEqual({
        status: 202,
        body: { status: 'pending', seats: 2, taken: 150, target: 192, deadlineMs: 1_800_000_000_000 },
      });
    });

    it.each<PoolStatus>(['filled', 'settled'])('answers 200 filled with the seats and terms for a %s pool', async (status) => {
      const { deps, proof } = await setup({ pool: { status, taken: 192 }, holding: { seats: 3, state: 'committed' } });
      expect(await handleRedeem(deps, POOL_ID, await proof())).toEqual({
        status: 200,
        body: { status: 'filled', credential: expect.any(String), poolId: POOL_ID, seats: 3, terms: TERMS },
      });
    });

    it.each<PoolStatus>(['filled', 'settled'])(
      "issues, for a %s pool, a credential that verifies against the issuer's JWKS and carries the seats and terms",
      async (status) => {
        const { deps, proof } = await setup({ pool: { status, taken: 192 }, holding: { seats: 3, state: 'committed' } });
        const { body } = await handleRedeem(deps, POOL_ID, await proof());
        const { payload } = await jwtVerify((body as { credential: string }).credential, createLocalJWKSet(deps.credentials.jwks()), {
          issuer: deps.config.publicUrl,
          algorithms: ['EdDSA'],
        });
        expect(payload).toMatchObject({ sub: BUYER, pool: POOL_ID, seats: 3, terms: TERMS, simulated: true });
      },
    );

    it('gives the same buyer redeeming twice credentials with the same sub, pool and seats', async () => {
      const { deps, proof } = await setup({ pool: { status: 'filled', taken: 192 } });
      const credentialClaims = async () => {
        const { body } = await handleRedeem(deps, POOL_ID, await proof());
        const { sub, pool, seats } = decodeJwt((body as { credential: string }).credential);
        return { sub, pool, seats };
      };
      const first = await credentialClaims();
      expect(first).toEqual({ sub: BUYER, pool: POOL_ID, seats: 2 });
      expect(await credentialClaims()).toEqual(first);
    });

    it.each<[PoolStatus, BuyerState, string]>([
      ['expired', 'committed', 'refund_pending'],
      ['expired', 'refunded', 'refunded'],
      ['expired', 'claimable', 'claimable'],
      ['refunded', 'committed', 'refund_pending'],
      ['refunded', 'refunded', 'refunded'],
      ['refunded', 'claimable', 'claimable'],
    ])('answers 410 for a %s pool, mapping the buyer state %s to %s', async (status, state, expected) => {
      const { deps, proof } = await setup({ pool: { status }, holding: { seats: 2, state } });
      const result = await handleRedeem(deps, POOL_ID, await proof());
      expect(result.status).toBe(410);
      expect((result.body as { status: string }).status).toBe(expected);
    });

    it('gives the seats times the seat price plus the bonus share, and the bonus share, in a 410', async () => {
      const { deps, proof } = await setup({
        pool: { status: 'expired', seat_price: '180', bonus_per_seat: '9' },
        holding: { seats: 3, state: 'committed' },
      });
      expect(await handleRedeem(deps, POOL_ID, await proof())).toEqual({
        status: 410,
        body: { status: 'refund_pending', amount: '567', bonusShare: '27', txHash: null },
      });
    });

    it("gives the transaction of the buyer's latest successful refund in this pool", async () => {
      const { deps, proof } = await setup({ pool: { status: 'refunded' }, holding: { seats: 2, state: 'refunded' } });
      await deps.activity.append(refundRecord({ txHash: 'RefundTx1' }));
      await deps.activity.append(refundRecord({ txHash: 'RefundTx2' }));
      await deps.activity.append(refundRecord({ txHash: 'FailedTx', ok: false, seats: 0 }));
      await deps.activity.append(refundRecord({ txHash: 'OtherBuyerTx', account: OTHER_BUYER }));
      await deps.activity.append(refundRecord({ txHash: 'OtherPoolTx', poolId: 8 }));
      const result = await handleRedeem(deps, POOL_ID, await proof());
      expect((result.body as { txHash: string | null }).txHash).toBe('RefundTx2');
    });

    it('gives a null txHash when the feed has no refund for the buyer', async () => {
      const { deps, proof } = await setup({ pool: { status: 'refunded' }, holding: { seats: 2, state: 'claimable' } });
      await deps.activity.append(refundRecord({ txHash: 'FailedTx', ok: false, seats: 0 }));
      const result = await handleRedeem(deps, POOL_ID, await proof());
      expect((result.body as { txHash: string | null }).txHash).toBeNull();
    });
  });

  describe('chain failures', () => {
    it.each(['getPool', 'accessKey', 'getBuyer'] as const)('answers 503 chain_unavailable when %s throws', async (method) => {
      const { deps, proof } = await setup();
      vi.spyOn(deps.fake, method).mockRejectedValue(new Error('rpc unreachable'));
      expect(await handleRedeem(deps, POOL_ID, await proof())).toEqual({ status: 503, body: { error: 'chain_unavailable' } });
    });
  });
});
