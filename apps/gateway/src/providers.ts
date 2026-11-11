import { JsonRpcProvider } from 'near-api-js';

/**
 * The provider the relayer reads and sends with. near-api-js counts attempts: `retries: 1` posts each
 * request once. A transaction is never posted twice, and each lookup by hash is a single post, so the
 * relayer checks its deadline between posts.
 */
export function createRelayerProvider(rpcUrl: string): JsonRpcProvider {
  return new JsonRpcProvider({ url: rpcUrl }, { retries: 1 });
}
