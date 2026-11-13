import {
  asAmount,
  completeConfig,
  EnvReader,
  readBuyerSettings,
  readMcpBuyerSettings,
  type BuyerSettings,
  type Env,
  type McpBuyerSettings,
} from '@quorum-on-near/buyer';

/**
 * The MCP server's configuration: the settings a buyer shares with the gateway, its buyer as the
 * swarm also reads it (QUORUM_MCP_ACCOUNT, QUORUM_CREDENTIALS_DIR, QUORUM_MCP_SPEND_FILE), and its own.
 */
export interface McpConfig extends BuyerSettings, McpBuyerSettings {
  /** QUORUM_MCP_SPEND_CAP: the most the buyer may spend between two setups, in the token's base units. */
  spendCap: bigint;
}

/**
 * Reads the configuration from `env`. Throws ConfigError listing every missing or invalid variable,
 * the shared ones first.
 */
export function loadMcpConfig(env: Env): McpConfig {
  const problems: string[] = [];
  const base = readBuyerSettings(env, problems);
  const buyer = readMcpBuyerSettings(env, problems, base.parent);
  const read = new EnvReader(env, problems);
  return completeConfig<McpConfig>(
    { ...base, ...buyer, spendCap: read.optional('QUORUM_MCP_SPEND_CAP', '10000', asAmount) },
    problems,
  );
}
