// Starts the gateway: `node --env-file-if-exists=.env src/main.ts` (see `.env.example`).
import { statSync } from 'node:fs';
import type { Server } from 'node:http';
import { join, resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { JsonRpcProvider, KeyPair, type KeyPairString } from 'near-api-js';
import { ActivityLog } from './activity.ts';
import { createApp } from './app.ts';
import { checkChainId, ConfigError, loadConfig, type GatewayConfig } from './config.ts';
import { createCredentialIssuer } from './credential.ts';
import { DemoRunner } from './demo.ts';
import type { Deps } from './deps.ts';
import { InFlight, proofNonceCache } from './guards.ts';
import { Keeper } from './keeper.ts';
import { createRelayerProvider } from './providers.ts';
import { redactProcessOutput } from './redact.ts';
import { KeyPool, RpcRelayer } from './relayer.ts';
import { RpcChain } from './rpc-chain.ts';
import { gracefulClose } from './shutdown.ts';

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

// First, so that all the gateway, its libraries and Node write from here on has its secret URLs
// replaced by their variables' names (see redact.ts).
redactProcessOutput();
const config = readConfig();
// Views change nothing, so they keep near-api-js's default retries.
const viewProvider = new JsonRpcProvider({ url: config.rpcUrl });
const chain = new RpcChain({ provider: viewProvider, poolsContract: config.poolsContract, token: config.token });

// QUORUM_NETWORK only labels offers: the RPC decides which chain the gateway pays on.
let chainId: string;
try {
  chainId = (await viewProvider.viewNodeStatus()).chain_id;
} catch (error) {
  // The host alone: a provider may put its key in the URL's path or query.
  fail(`cannot read the chain id from the RPC at ${new URL(config.rpcUrl).host}: ${errorMessage(error)}`);
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

// Posts each request once: a transaction is never posted twice (see providers.ts).
const relayerProvider = createRelayerProvider(config.rpcUrl);
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

// The demo endpoint is on only when QUORUM_DEMO_COMMAND names the program of a run.
const demo =
  config.demoCommand === null
    ? null
    : new DemoRunner({
        command: config.demoCommand,
        maxRunsPerDay: config.demoMaxRunsPerDay,
        maxRunSeconds: config.demoMaxRunSeconds,
        rpcUrl: config.demoRpcUrl,
      });
if (demo !== null) {
  console.log(`demo endpoint on: each run starts ${JSON.stringify(config.demoCommand)}, then its scenario`);
}

const server = serve({ fetch: createApp(deps, { demo }).fetch, port: config.port }, (info) => {
  console.log(`gateway listening on http://localhost:${info.port} (public URL ${config.publicUrl})`);
});
server.once('error', (error) => fail(`cannot listen on port ${config.port}: ${error.message}`));
// serve() makes a node:http server, since it is given no other createServer.
const closeServer = gracefulClose(server as Server);

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

/**
 * Stops taking requests and keeper ticks, and sends a demo run in progress SIGTERM; the process exits
 * once the running ones finish.
 */
function shutdown(signal: NodeJS.Signals): void {
  // A second signal ends the process at once.
  process.off('SIGINT', shutdown);
  process.off('SIGTERM', shutdown);
  console.log(`${signal}: shutting down`);
  closeServer();
  void keeper.stop();
  demo?.stop();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
