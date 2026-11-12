import {
  asAbsolutePath,
  asAmount,
  asInteger,
  asNear,
  asPositiveInteger,
  completeConfig,
  EnvReader,
  readBuyerSettings,
  readMcpBuyerSettings,
  type BuyerSettings,
  type Env,
  type McpBuyerSettings,
  type Rule,
} from '@quorum-on-near/buyer';
import { scriptedBuyerIds } from './accounts.ts';
import { TGAS } from './chain.ts';
import { defaultLockDir } from './lock.ts';

/**
 * The swarm's configuration: the settings it shares with the gateway and the buyers, read from the
 * gateway's own variables and defaults, then those it shares with the MCP server (its buyer, the
 * folder of the key files and the spend file, as the server reads them), then its own (see
 * `.env.example`).
 */
export interface SwarmConfig extends BuyerSettings, McpBuyerSettings {
  /** QUORUM_FUNDING_ACCOUNT: the only source of the token, `funding.<parent>` by default; may be the parent. */
  funding: string;
  /** QUORUM_RELAYER_ACCOUNT: the account the gateway relays payments with, `relay.<parent>` by default. */
  relayer: string;
  /** QUORUM_PROVIDER_ACCOUNT: the simulated seller, `provider.<parent>` by default. */
  provider: string;
  /** QUORUM_POOLS_WASM: the pools contract's wasm file, or null when unset; needed only to deploy it. */
  poolsWasm: string | null;
  /** QUORUM_RELAYER_KEY_COUNT: the full-access keys setup gives the relayer when it creates it. */
  relayerKeyCount: number;
  /** QUORUM_BUYER_NEAR: the NEAR each buyer is topped up to, in yoctoNEAR. */
  buyerNear: bigint;
  /** QUORUM_PROVIDER_NEAR: the NEAR the provider is topped up to, in yoctoNEAR. */
  providerNear: bigint;
  /** QUORUM_FUNDING_NEAR: the NEAR the funding account is topped up to, in yoctoNEAR, unless it is the parent. */
  fundingNear: bigint;
  /** QUORUM_RELAYER_NEAR: the NEAR the relayer is topped up to, in yoctoNEAR. */
  relayerNear: bigint;
  /** QUORUM_POOLS_NEAR: the NEAR the pools account is created with, and topped up to while it holds no code, in yoctoNEAR. */
  poolsNear: bigint;
  /**
   * QUORUM_POOLS_FREE_NEAR: once the pools contract is deployed, the NEAR setup keeps on it beyond
   * what its storage locks (freeBalance), in yoctoNEAR.
   */
  poolsFreeNear: bigint;
  /** QUORUM_BUYER_BUDGET: the token balance each buyer is topped up to, in base units. */
  buyerBudget: bigint;
  /** QUORUM_PROVIDER_BONUS_FUNDS: the token balance the provider is topped up to, in base units. */
  providerBonusFunds: bigint;
  /** QUORUM_COMMIT_MIN_GAS: the gas a payment's `ft_transfer_call` attaches at least, as the gateway offers it. */
  commitMinGas: bigint;
  /** QUORUM_COMMIT_MAX_GAS: the gas a payment's `ft_transfer_call` attaches at most, at least `commitMinGas`. */
  commitMaxGas: bigint;
  /** QUORUM_SCENARIO_DEADLINE_SECONDS: overrides every scenario's deadline; null keeps each scenario's own. */
  deadlineSeconds: number | null;
  /** QUORUM_SWARM_SPREAD_SECONDS: overrides every scenario's arrival spread; null keeps each scenario's own. */
  spreadSeconds: number | null;
  /** QUORUM_REDEEM_INTERVAL_MS: how often a scripted buyer polls its redemption. */
  redeemIntervalMs: number;
  /** QUORUM_SWARM_LOCK_DIR: the folder of the swarm's lock files, `data/` at the root of the repository by default. */
  lockDir: string;
}

/** The most gas the gateway attaches to one call, and so the most either commit gas bound may be. */
const MAX_CALL_GAS = 300n * TGAS;
/** The longest delay a Node timer honours: it turns any longer one into 1 ms. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const DIGITS = /^(0|[1-9][0-9]*)$/;

/** Gas as the gateway reads it, so that one value of a shared variable works for both. */
const asGas: Rule<bigint> = {
  expected: `an amount of gas from 1 to ${MAX_CALL_GAS} (300 Tgas, the most the gateway attaches to one call)`,
  parse(raw) {
    const gas = DIGITS.test(raw) ? BigInt(raw) : 0n;
    return gas >= 1n && gas <= MAX_CALL_GAS ? gas : undefined;
  },
};

const asSpreadSeconds = asInteger(
  0,
  Math.floor(MAX_TIMER_DELAY_MS / 1000),
  `an integer from 0 to ${Math.floor(MAX_TIMER_DELAY_MS / 1000)} (the longest delay a Node timer honours, in seconds)`,
);

const asIntervalMs = asInteger(
  1,
  MAX_TIMER_DELAY_MS,
  `an integer from 1 to ${MAX_TIMER_DELAY_MS} (the longest delay a Node timer honours)`,
);

/**
 * Reads the configuration from environment variables (see `.env.example`). Collects every problem,
 * the shared variables' first, and throws one ConfigError listing them all.
 */
export function loadSwarmConfig(env: Env): SwarmConfig {
  const problems: string[] = [];
  const read = new EnvReader(env, problems);
  const base = readBuyerSettings(env, problems);
  const { parent } = base;
  const mcp = readMcpBuyerSettings(env, problems, parent);
  const funding = read.child('QUORUM_FUNDING_ACCOUNT', 'funding', parent);
  const relayer = read.child('QUORUM_RELAYER_ACCOUNT', 'relay', parent);
  const provider = read.child('QUORUM_PROVIDER_ACCOUNT', 'provider', parent);
  const poolsWasm = read.nullable('QUORUM_POOLS_WASM', asAbsolutePath);
  const relayerKeyCount = read.optional('QUORUM_RELAYER_KEY_COUNT', '4', asPositiveInteger);
  const buyerNear = read.optional('QUORUM_BUYER_NEAR', '0.05', asNear);
  const providerNear = read.optional('QUORUM_PROVIDER_NEAR', '0.5', asNear);
  const fundingNear = read.optional('QUORUM_FUNDING_NEAR', '0.5', asNear);
  const relayerNear = read.optional('QUORUM_RELAYER_NEAR', '3', asNear);
  const poolsNear = read.optional('QUORUM_POOLS_NEAR', '3.5', asNear);
  const poolsFreeNear = read.optional('QUORUM_POOLS_FREE_NEAR', '1', asNear);
  const buyerBudget = read.optional('QUORUM_BUYER_BUDGET', '10000', asAmount);
  const providerBonusFunds = read.optional('QUORUM_PROVIDER_BONUS_FUNDS', '10000', asAmount);
  const commitMinGas = read.optional('QUORUM_COMMIT_MIN_GAS', '50000000000000', asGas);
  const commitMaxGas = read.optional('QUORUM_COMMIT_MAX_GAS', '100000000000000', asGas);
  if (commitMinGas !== undefined && commitMaxGas !== undefined && commitMaxGas < commitMinGas) {
    problems.push(`QUORUM_COMMIT_MAX_GAS must be at least QUORUM_COMMIT_MIN_GAS (${commitMinGas}), got "${commitMaxGas}"`);
  }
  const deadlineSeconds = read.nullable('QUORUM_SCENARIO_DEADLINE_SECONDS', asPositiveInteger);
  const spreadSeconds = read.nullable('QUORUM_SWARM_SPREAD_SECONDS', asSpreadSeconds);
  const redeemIntervalMs = read.optional('QUORUM_REDEEM_INTERVAL_MS', '5000', asIntervalMs);
  const lockDir = read.optional('QUORUM_SWARM_LOCK_DIR', defaultLockDir(), asAbsolutePath);

  if (parent !== undefined) {
    problems.push(
      ...sharedAccounts(parent, [
        ['QUORUM_FUNDING_ACCOUNT', funding],
        ['QUORUM_POOLS_ACCOUNT', base.poolsContract],
        ['QUORUM_RELAYER_ACCOUNT', relayer],
        ['QUORUM_PROVIDER_ACCOUNT', provider],
        ['QUORUM_MCP_ACCOUNT', mcp.mcpAccount],
      ]),
    );
  }

  return completeConfig<SwarmConfig>(
    {
      ...base,
      ...mcp,
      funding,
      relayer,
      provider,
      poolsWasm,
      relayerKeyCount,
      buyerNear,
      providerNear,
      fundingNear,
      relayerNear,
      poolsNear,
      poolsFreeNear,
      buyerBudget,
      providerBonusFunds,
      commitMinGas,
      commitMaxGas,
      deadlineSeconds,
      spreadSeconds,
      redeemIntervalMs,
      lockDir,
    },
    problems,
  );
}

/**
 * One problem for each role that names an account already taken: by the parent, by an earlier role
 * or by a scripted buyer. Each account has one role, since setup tops each one up to its own amounts.
 * Only the funding account may be the parent. Roles whose variable has a problem are skipped.
 */
function sharedAccounts(parent: string, roles: Array<[name: string, id: string | undefined]>): string[] {
  const taken = new Map<string, string>(scriptedBuyerIds(parent).map((id) => [id, 'a scripted buyer']));
  const problems: string[] = [];
  for (const [name, id] of roles) {
    if (id === undefined) continue;
    const owner = id === parent && name !== 'QUORUM_FUNDING_ACCOUNT' ? 'QUORUM_PARENT_ACCOUNT' : taken.get(id);
    if (owner !== undefined) problems.push(`${name} must name an account of its own, but ${JSON.stringify(id)} is also ${owner}`);
    else taken.set(id, name);
  }
  return problems;
}
