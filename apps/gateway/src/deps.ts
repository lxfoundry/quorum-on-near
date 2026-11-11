import type { ActivityLog } from './activity.ts';
import type { ChainReader, ChainWriter } from './chain.ts';
import type { GatewayConfig } from './config.ts';
import type { CredentialIssuer } from './credential.ts';
import type { InFlight, NonceCache } from './guards.ts';

/** Everything the request handlers need. Tests pass fakes. */
export interface Deps {
  config: GatewayConfig;
  chain: ChainReader;
  writer: ChainWriter;
  credentials: CredentialIssuer;
  activity: ActivityLog;
  inFlight: InFlight;
  proofNonces: NonceCache;
  now: () => number;
}
