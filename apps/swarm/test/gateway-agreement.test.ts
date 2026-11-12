// What the buyer package assumes of the gateway, checked against the gateway's own sources: the
// swarm itself never imports another app.
import {
  completeConfig,
  MAX_SEATS_PER_REQUEST,
  readBuyerSettings,
  SETTLE_MARGIN_BLOCKS,
  type BuyerSettings,
  type Env,
} from '@quorum-on-near/buyer';
import { KeyPair } from 'near-api-js';
import { describe, expect, it } from 'vitest';
import { RECEIPT_MARGIN_BLOCKS } from '../../gateway/src/chain.ts';
import { loadConfig, type GatewayConfig } from '../../gateway/src/config.ts';
import { generateCredentialJwk } from '../../gateway/src/credential.ts';
import { MAX_SEATS_PER_REQUEST as GATEWAY_MAX_SEATS_PER_REQUEST } from '../../gateway/src/handle-offer.ts';

/** The variables the gateway requires; the buyer settings read only the parent among them. */
const REQUIRED: Env = {
  QUORUM_PARENT_ACCOUNT: 'parent.testnet',
  QUORUM_RELAYER_KEYS: KeyPair.fromRandom('ed25519').toString(),
  QUORUM_CREDENTIAL_JWK: JSON.stringify(await generateCredentialJwk()),
};

/** The values the buyer settings share with the gateway, by the buyer's names. */
type Shared = Pick<BuyerSettings, 'network' | 'rpcUrl' | 'gatewayUrl' | 'parent' | 'token' | 'poolsContract' | 'blockTimeMs'>;

function gatewayShared(config: GatewayConfig): Shared {
  const { network, rpcUrl, publicUrl, parent, token, poolsContract, blockTimeMs } = config;
  if (network !== 'near:testnet' && network !== 'near:sandbox') throw new Error(`unexpected network ${network}`);
  return { network, rpcUrl, gatewayUrl: publicUrl, parent, token, poolsContract, blockTimeMs };
}

function buyerShared(env: Env): Shared {
  const problems: string[] = [];
  const { network, rpcUrl, gatewayUrl, parent, token, poolsContract, blockTimeMs } = completeConfig(
    readBuyerSettings(env, problems),
    problems,
  );
  return { network, rpcUrl, gatewayUrl, parent, token, poolsContract, blockTimeMs };
}

describe('the buyer package and the gateway', () => {
  it('wait after a payment whose result is unknown at least as long as the gateway holds its buyer', () => {
    // A buyer that paid again sooner would only be refused payment_in_flight.
    expect(SETTLE_MARGIN_BLOCKS >= RECEIPT_MARGIN_BLOCKS).toBe(true);
  });

  it.each<[string, Env]>([
    ['only the gateway requires is set, so that every default applies', {}],
    [
      'every shared variable is set',
      {
        QUORUM_NETWORK: 'near:sandbox',
        QUORUM_RPC_URL: 'http://127.0.0.1:3030',
        QUORUM_GATEWAY_URL: 'http://127.0.0.1:9402/',
        QUORUM_TOKEN_ACCOUNT: 'musd.test.near',
        QUORUM_POOLS_ACCOUNT: 'pools-v2.test.near',
        QUORUM_BLOCK_TIME_MS: '600',
      },
    ],
  ])('read the values they share alike when %s', (_, overrides) => {
    const env = { ...REQUIRED, ...overrides };
    expect(buyerShared(env)).toEqual(gatewayShared(loadConfig(env)));
  });

  it('allow the same most seats in one request', () => {
    expect(MAX_SEATS_PER_REQUEST).toBe(GATEWAY_MAX_SEATS_PER_REQUEST);
  });
});
