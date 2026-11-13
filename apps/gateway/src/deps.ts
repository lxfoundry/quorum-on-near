import type { ActivityLog } from './activity.ts';
import type { ChainReader, ChainWriter } from './chain.ts';
import type { GatewayConfig } from './config.ts';
import type { CredentialIssuer } from './credential.ts';
import type { InFlight, NonceCache } from './guards.ts';
import type { PoolReader } from './pools.ts';

/** Everything the request handlers need. Tests pass fakes. */
export interface Deps {
  config: GatewayConfig;
  chain: ChainReader;
  /**
   * Where redemptions read a pool, and nothing else does: in the gateway, `chain`'s getPool through
   * a 2-second cache that each transaction it sends clears (pool-cache.ts). By default, `chain`.
   */
  redeemPools?: PoolReader;
  writer: ChainWriter;
  credentials: CredentialIssuer;
  activity: ActivityLog;
  inFlight: InFlight;
  proofNonces: NonceCache;
  now: () => number;
}
