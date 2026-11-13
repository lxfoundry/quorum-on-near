import type { Network } from './constants.ts';

/** NEAR's public chains, by the `chain_id` their RPC nodes report. */
const PUBLIC_CHAINS = ['mainnet', 'testnet'];

/**
 * Checks the `chain_id` that the RPC at QUORUM_RPC_URL reports against QUORUM_NETWORK, which only
 * labels offers: the RPC decides which chain is paid on. `near:testnet` needs `testnet`;
 * `near:sandbox` takes any chain but NEAR's public ones. Returns the problem, or null.
 */
export function checkChainId(network: Network, chainId: string): string | null {
  if (network === 'near:testnet') {
    if (chainId === 'testnet') return null;
    return `QUORUM_NETWORK is near:testnet, but QUORUM_RPC_URL serves the chain ${JSON.stringify(chainId)}, not "testnet"`;
  }
  if (!PUBLIC_CHAINS.includes(chainId)) return null;
  return `QUORUM_NETWORK is ${network}, but QUORUM_RPC_URL serves NEAR's public chain ${JSON.stringify(chainId)}`;
}
