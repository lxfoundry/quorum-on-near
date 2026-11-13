// Starts the MCP server on stdio, acting as the buyer QUORUM_MCP_ACCOUNT: `node apps/mcp/src/main.ts`,
// from any folder (see .env.example and mcp.example.json). Standard output carries the MCP stream, so
// every message of this process goes to standard error.
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  Buyer,
  ConfigError,
  describeError,
  GatewayClient,
  keyFilePath,
  readKeyFile,
  RpcBuyerChain,
  RpcPoolReads,
} from '@quorum-on-near/buyer';
import { checkChainId } from '@quorum-on-near/protocol';
import { JsonRpcProvider, type KeyPair } from 'near-api-js';
import { loadMcpConfig, type McpConfig } from './config.ts';
import { Commits } from './commits.ts';
import { buildServer } from './server.ts';
import { SpendLedger } from './spend.ts';
import { readTokenUnits, type TokenUnits } from './token.ts';

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/** Loads apps/mcp/.env when there is one. A variable already set in the environment keeps its value. */
function loadEnvFile(): void {
  const file = fileURLToPath(new URL('../.env', import.meta.url));
  try {
    process.loadEnvFile(file);
  } catch (error) {
    // A file system error, read before any RPC URL is known.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') fail(`cannot read ${file}: ${describeError(error, undefined)}`);
  }
}

function readConfig(): McpConfig {
  try {
    return loadMcpConfig(process.env);
  } catch (error) {
    if (error instanceof ConfigError) fail(`invalid configuration:\n${error.message}`);
    throw error;
  }
}

loadEnvFile();
const config = readConfig();
const provider = new JsonRpcProvider({ url: config.rpcUrl });

/**
 * The error's message and its causes' (such as the refused connection behind "fetch failed"), with
 * the RPC URL replaced by QUORUM_RPC_URL: the URL may carry an API key, and near-api-js quotes it in
 * its errors.
 */
function errorMessage(error: unknown): string {
  return describeError(error, config.rpcUrl);
}

// QUORUM_NETWORK only labels offers and payments: the RPC decides which chain the buyer pays on.
let chainId: string;
try {
  chainId = (await provider.viewNodeStatus()).chain_id;
} catch (error) {
  fail(`cannot read the chain id from QUORUM_RPC_URL: ${errorMessage(error)}`);
}
const wrongChain = checkChainId(config.network, chainId);
if (wrongChain !== null) fail(wrongChain);

let units: TokenUnits;
try {
  units = await readTokenUnits(provider, config.token);
} catch (error) {
  fail(`cannot read the metadata of the token ${config.token}: ${errorMessage(error)}`);
}

let keyPair: KeyPair;
try {
  keyPair = await readKeyFile(keyFilePath(config.credentialsDir, config.network, config.mcpAccount));
} catch (error) {
  fail(`cannot read the key of ${config.mcpAccount}: ${errorMessage(error)}`);
}

const ledger = new SpendLedger({
  path: config.spendFile,
  account: config.mcpAccount,
  cap: config.spendCap,
  log: (line) => console.error(line),
});
let left: bigint;
try {
  left = await ledger.left();
} catch (error) {
  fail(`cannot read the spend total: ${errorMessage(error)}`);
}

const gateway = new GatewayClient({ gatewayUrl: config.gatewayUrl });
const buyer = new Buyer({
  settings: config,
  accountId: config.mcpAccount,
  keyPair,
  gateway,
  chain: new RpcBuyerChain(provider),
});
const server = buildServer({
  buyer,
  gateway,
  chain: new RpcPoolReads(provider, config.poolsContract),
  ledger,
  settings: config,
  units,
  now: Date.now,
  // The tools redact the RPC URL from every line they write.
  log: (line) => console.error(line),
  commits: new Commits(),
});
// A line on stdin that is not a JSON-RPC message is dropped; say so.
server.server.onerror = (error) => console.error(`MCP: ${errorMessage(error)}`);
await server.connect(new StdioServerTransport());
// The gateway by its host alone: QUORUM_GATEWAY_URL is read as a secret, since its path or query may
// carry a key, and its host is the recipient that redemption proofs name anyway.
console.error(
  `quorum-buyer MCP server on stdio: buyer ${config.mcpAccount}, gateway ${new URL(config.gatewayUrl).host}, ` +
    `spend cap ${left} of ${config.spendCap} base units left`,
);
