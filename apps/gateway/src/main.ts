// Starts the gateway: `node --env-file-if-exists=.env src/main.ts` (see `.env.example`).
import { statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { JsonRpcProvider, KeyPair, type KeyPairString } from 'near-api-js';
import { ActivityLog } from './activity.ts';
import { createApp } from './app.ts';
import { checkChainId, ConfigError, loadConfig, type GatewayConfig } from './config.ts';
import { createCredentialIssuer } from './credential.ts';
import type { Deps } from './deps.ts';
import { InFlight, proofNonceCache } from './guards.ts';
import { Keeper } from './keeper.ts';
import { KeyPool, RpcRelayer } from './relayer.ts';
import { RpcChain } from './rpc-chain.ts';

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readConfig(): GatewayConfig {
  try {
    return loadConfig(process.env);
  } catch (error) {
    if (error instanceof ConfigError) fail(`invalid configuration:\n${error.message}`);
    throw error;
  }
}

/** The live page's folder as an absolute path, or null if it is not set or not a folder. */
function liveFolder(webDir: string | null): string | null {
  if (webDir === null) return null;
  const dir = resolve(process.cwd(), webDir);
  if (statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return dir;
  console.warn(`no live page: ${dir} is not a folder`);
  return null;
}

const config = readConfig();
// Views change nothing, so they keep near-api-js's default retries.
const viewProvider = new JsonRpcProvider({ url: config.rpcUrl });
const chain = new RpcChain({ provider: viewProvider, poolsContract: config.poolsContract, token: config.token });

// QUORUM_NETWORK only labels offers: the RPC decides which chain the gateway pays on.
let chainId: string;
try {
  chainId = (await viewProvider.viewNodeStatus()).chain_id;
} catch (error) {
  fail(`cannot read the chain id from ${config.rpcUrl}: ${errorMessage(error)}`);
}
const wrongChain = checkChainId(config.network, chainId);
if (wrongChain !== null) fail(wrongChain);

let token: string;
try {
  token = await chain.getToken();
} catch (error) {
  fail(`cannot read the token of ${config.poolsContract}: ${errorMessage(error)}`);
}
if (token !== config.token) {
  fail(`${config.poolsContract} holds ${token}, but QUORUM_TOKEN_ACCOUNT is ${config.token}`);
}

// near-api-js counts attempts: `retries: 1` posts each request once. A transaction is never posted
// twice, and each lookup by hash is a single post, so the relayer checks its deadline between posts.
const relayerProvider = new JsonRpcProvider({ url: config.rpcUrl }, { retries: 1 });
const writer = new RpcRelayer({
  relayer: config.relayer,
  poolsContract: config.poolsContract,
  keys: new KeyPool(config.relayerKeys.map((key) => KeyPair.fromString(key as KeyPairString))),
  readProvider: relayerProvider,
  sendProvider: relayerProvider,
  // An accepted delegate expires at most about maxTimeoutSeconds ahead; twice that bounds the lookup
  // when blocks slow down or the final height cannot be read.
  delegateLookupMs: 2 * config.maxTimeoutSeconds * 1000,
});
const activity = await ActivityLog.open(join(config.dataDir, 'activity.jsonl'));
const deps: Deps = {
  config: { ...config, webDir: liveFolder(config.webDir) },
  chain,
  writer,
  credentials: await createCredentialIssuer({ jwk: config.credentialJwk, issuer: config.publicUrl }),
  activity,
  inFlight: new InFlight(),
  proofNonces: proofNonceCache(),
  now: Date.now,
};

const server = serve({ fetch: createApp(deps).fetch, port: config.port }, (info) => {
  console.log(`gateway listening on http://localhost:${info.port} (public URL ${config.publicUrl})`);
});
server.once('error', (error) => fail(`cannot listen on port ${config.port}: ${error.message}`));

const keeper = new Keeper({
  chain,
  writer,
  activity,
  provider: config.provider,
  poolsContract: config.poolsContract,
  refundLimit: config.refundLimit,
  settleGas: config.settleGas,
  refundGas: config.refundGas,
  now: Date.now,
});
keeper.start(config.keeperIntervalMs);

/** Stops taking requests and keeper ticks; the process exits once the running ones finish. */
function shutdown(signal: NodeJS.Signals): void {
  // A second signal ends the process at once.
  process.off('SIGINT', shutdown);
  process.off('SIGTERM', shutdown);
  console.log(`${signal}: shutting down`);
  server.close();
  void keeper.stop();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
