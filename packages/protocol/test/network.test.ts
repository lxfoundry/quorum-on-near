import { describe, expect, it } from 'vitest';
import { checkChainId } from '../src/network.ts';

describe('checkChainId', () => {
  it.each([
    ['near:testnet', 'testnet'],
    // A sandbox initialised without a chain id gets test-chain- and 5 random characters.
    ['near:sandbox', 'test-chain-a1B2c'],
    ['near:sandbox', 'localnet'],
  ] as const)('accepts %s on the chain %j', (network, chainId) => {
    expect(checkChainId(network, chainId)).toBeNull();
  });

  it.each(['mainnet', 'test-chain-a1B2c', 'Testnet', ''])('refuses near:testnet on the chain %j', (chainId) => {
    expect(checkChainId('near:testnet', chainId)).toBe(
      `QUORUM_NETWORK is near:testnet, but QUORUM_RPC_URL serves the chain ${JSON.stringify(chainId)}, not "testnet"`,
    );
  });

  it.each(['mainnet', 'testnet'])('refuses near:sandbox on the public chain %j', (chainId) => {
    expect(checkChainId('near:sandbox', chainId)).toBe(
      `QUORUM_NETWORK is near:sandbox, but QUORUM_RPC_URL serves NEAR's public chain ${JSON.stringify(chainId)}`,
    );
  });
});
