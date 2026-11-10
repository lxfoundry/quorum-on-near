import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REDEEM_MAX_AGE_MS, REDEEM_MAX_SKEW_MS } from '@quorum-on-near/protocol';
import { ActivityLog } from '../src/activity.ts';
import { createCredentialIssuer, generateCredentialJwk } from '../src/credential.ts';
import type { Deps } from '../src/deps.ts';
import { InFlight, NonceCache } from '../src/guards.ts';
import { FakeChain, NOW_MS, testConfig } from './fake-chain.ts';

/** Handler dependencies over a FakeChain, with a real activity log in a temporary folder. */
export async function testDeps(overrides: Partial<Deps> = {}): Promise<Deps & { fake: FakeChain }> {
  const fake = new FakeChain();
  const config = overrides.config ?? testConfig();
  const dir = await mkdtemp(join(tmpdir(), 'quorum-gateway-'));
  const deps: Deps = {
    config,
    chain: fake,
    writer: fake,
    credentials: await createCredentialIssuer({ jwk: await generateCredentialJwk(), issuer: config.publicUrl }),
    activity: await ActivityLog.open(join(dir, 'activity.jsonl')),
    inFlight: new InFlight(),
    proofNonces: new NonceCache(REDEEM_MAX_AGE_MS + REDEEM_MAX_SKEW_MS),
    now: () => NOW_MS,
    ...overrides,
  };
  return { ...deps, fake };
}
