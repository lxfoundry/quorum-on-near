import { isAbsolute } from 'node:path';
import { isAccountId } from '@quorum-on-near/protocol';
import { nearToYocto } from 'near-api-js';
import { defaultCredentialsDir } from './key-files.ts';
import { defaultSpendFile } from './spend-file.ts';

/** Environment variables, as `process.env` holds them. */
export type Env = Record<string, string | undefined>;

/** The networks a buyer pays on: NEAR testnet, or a local sandbox chain. */
export type BuyerNetwork = 'near:testnet' | 'near:sandbox';

/** Circle's USDC on NEAR testnet, the default token. */
export const TESTNET_USDC = '3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af';

/**
 * What a buyer shares with the gateway, and the bound it puts on what it signs. Each shared value is
 * read from the gateway's own variable, with the gateway's default, so that one value configures every
 * app.
 */
export interface BuyerSettings {
  /** QUORUM_NETWORK: the network offers and payments name. */
  network: BuyerNetwork;
  /** QUORUM_RPC_URL: the NEAR RPC endpoint, as written. */
  rpcUrl: string;
  /**
   * QUORUM_GATEWAY_URL, without a trailing slash: where the gateway is reached. Its host is the
   * recipient of redemption proofs, so it must be written as the gateway's own QUORUM_GATEWAY_URL.
   */
  gatewayUrl: string;
  /** QUORUM_PARENT_ACCOUNT: the account the system's accounts are created under. */
  parent: string;
  /** QUORUM_TOKEN_ACCOUNT: the token the pools contract was initialised with. */
  token: string;
  /** QUORUM_POOLS_ACCOUNT: the pools contract, `pools.<parent>` by default. */
  poolsContract: string;
  /** QUORUM_BLOCK_TIME_MS: the average block time that turns an offer's timeout into blocks. */
  blockTimeMs: number;
  /**
   * QUORUM_BUYER_MAX_TIMEOUT_SECONDS: the longest a payment the buyer signs stays valid, 30 to 3600
   * seconds (120 by default). The buyer's own bound, not the gateway's: a payment expires after the
   * offer's timeout or this one, whichever is shorter.
   */
  maxTimeoutSeconds: number;
}

/** How one variable is read. */
export interface Rule<T> {
  /** Completes "<VARIABLE> must be …". */
  expected: string;
  /** The value, or undefined when `raw` is invalid. */
  parse(raw: string): T | undefined;
  /**
   * True for a value that may hold a secret, such as a URL with an API key in its query or path: a
   * problem line then names the variable and never quotes the value.
   */
  secret?: boolean;
}

/** A configuration being read: a value is undefined when its variable has a problem. */
export type Draft<T> = { [K in keyof T]: T[K] | undefined };

/** Thrown by completeConfig with every missing or invalid variable, one per line of its message. */
export class ConfigError extends Error {
  override name = 'ConfigError';
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(problems.join('\n'));
    this.problems = problems;
  }
}

/**
 * Reads variables from `env` with rules, appending one line to `problems` for each variable that is
 * missing or invalid, so that a loader can list every problem at once. A value with a problem is
 * returned as undefined. Problem lines quote the raw value, except for a rule marked `secret`, such as
 * the URL rules: a URL may carry an API key.
 */
export class EnvReader {
  readonly #env: Env;
  readonly #problems: string[];

  constructor(env: Env, problems: string[]) {
    this.#env = env;
    this.#problems = problems;
  }

  /** The variable read with `rule`, or `fallback` read with it when the variable is unset. */
  optional<T>(name: string, fallback: string, rule: Rule<T>): T | undefined {
    return this.#check(name, this.#env[name] ?? fallback, rule);
  }

  /** The variable read with `rule`; a problem when it is unset or empty. */
  required<T>(name: string, rule: Rule<T>): T | undefined {
    const raw = this.#env[name];
    if (raw !== undefined && raw !== '') return this.#check(name, raw, rule);
    this.#problems.push(`${name} is required`);
    return undefined;
  }

  /** The variable read with `rule`, or null when it is unset or empty. */
  nullable<T>(name: string, rule: Rule<T>): T | null | undefined {
    const raw = this.#env[name];
    return raw === undefined || raw === '' ? null : this.#check(name, raw, rule);
  }

  /**
   * An account id that defaults to `<prefix>.<parent>`. Without a valid parent there is no default,
   * and the parent's problem is already listed, so an unset variable then gives undefined silently.
   */
  child(name: string, prefix: string, parent: string | undefined): string | undefined {
    const raw = this.#env[name] ?? (parent === undefined ? undefined : `${prefix}.${parent}`);
    return raw === undefined ? undefined : this.#check(name, raw, asAccountId);
  }

  #check<T>(name: string, raw: string, rule: Rule<T>): T | undefined {
    const value = rule.parse(raw);
    if (value === undefined) {
      const got = rule.secret === true ? '' : `, got ${JSON.stringify(raw)}`;
      this.#problems.push(`${name} must be ${rule.expected}${got}`);
    }
    return value;
  }
}

/**
 * The configuration once every variable has been read: throws a ConfigError listing `problems` if
 * there are any. A loader only leaves a value undefined after listing its problem, so without
 * problems every value of the draft is defined.
 */
export function completeConfig<T>(draft: Draft<T>, problems: readonly string[]): T {
  if (problems.length > 0) throw new ConfigError(problems);
  return draft as T;
}

/**
 * Reads the buyer settings from the gateway's variables and defaults (see BuyerSettings), appending
 * a line to `problems` for each missing or invalid one. The caller reads its own variables into the
 * same list, then calls completeConfig.
 */
export function readBuyerSettings(env: Env, problems: string[]): Draft<BuyerSettings> {
  const read = new EnvReader(env, problems);
  const network = read.optional('QUORUM_NETWORK', 'near:testnet', asNetwork);
  const rpcUrl = read.optional('QUORUM_RPC_URL', 'https://test.rpc.fastnear.com', asHttpUrl);
  const gatewayUrl = read.optional('QUORUM_GATEWAY_URL', 'http://localhost:8402', asBaseUrl);
  const parent = read.required('QUORUM_PARENT_ACCOUNT', asAccountId);
  const token = read.optional('QUORUM_TOKEN_ACCOUNT', TESTNET_USDC, asAccountId);
  const poolsContract = read.child('QUORUM_POOLS_ACCOUNT', 'pools', parent);
  const blockTimeMs = read.optional('QUORUM_BLOCK_TIME_MS', '1000', asPositiveInteger);
  const maxTimeoutSeconds = read.optional('QUORUM_BUYER_MAX_TIMEOUT_SECONDS', '120', asTimeoutSeconds);
  return { network, rpcUrl, gatewayUrl, parent, token, poolsContract, blockTimeMs, maxTimeoutSeconds };
}

/**
 * The MCP server's buyer, as both the swarm, which creates and funds it and clears its spend total,
 * and the MCP server, which acts for it and keeps that total, read it, with one set of defaults.
 */
export interface McpBuyerSettings {
  /** QUORUM_MCP_ACCOUNT: the buyer the MCP server acts for, `buyer-llm.<parent>` by default. */
  mcpAccount: string;
  /** QUORUM_CREDENTIALS_DIR: the folder of the key files, `~/.near-credentials` by default. */
  credentialsDir: string;
  /** QUORUM_MCP_SPEND_FILE: the MCP server's running spend total, `data/mcp-spend.json` at the repository root by default. */
  spendFile: string;
}

/**
 * Reads the MCP server's buyer (see McpBuyerSettings), appending a line to `problems` for each
 * invalid variable. `parent` is the parent account readBuyerSettings read: without it the buyer has
 * no default, and the parent's problem is listed already.
 */
export function readMcpBuyerSettings(env: Env, problems: string[], parent: string | undefined): Draft<McpBuyerSettings> {
  const read = new EnvReader(env, problems);
  return {
    mcpAccount: read.child('QUORUM_MCP_ACCOUNT', 'buyer-llm', parent),
    credentialsDir: read.optional('QUORUM_CREDENTIALS_DIR', defaultCredentialsDir(), asAbsolutePath),
    spendFile: read.optional('QUORUM_MCP_SPEND_FILE', defaultSpendFile(), asAbsolutePath),
  };
}

const NETWORKS: readonly BuyerNetwork[] = ['near:testnet', 'near:sandbox'];
const INTEGER = /^(0|[1-9][0-9]*)$/;
/** A NEAR amount: whole NEAR, then up to 24 decimals (yoctoNEAR). */
const NEAR_AMOUNT = /^(0|[1-9][0-9]*)(\.[0-9]{1,24})?$/;

const asNetwork: Rule<BuyerNetwork> = {
  expected: NETWORKS.join(' or '),
  parse: (raw) => NETWORKS.find((network) => network === raw),
};

/** An http or https URL, kept as written. It may carry an API key, so a problem never quotes it. */
const asHttpUrl: Rule<string> = {
  expected: 'an http or https URL',
  parse: (raw) => (URL.canParse(raw) && ['http:', 'https:'].includes(new URL(raw).protocol) ? raw : undefined),
  secret: true,
};

/** An http or https URL with its trailing slashes removed, as the gateway reads its own URL. */
const asBaseUrl: Rule<string> = {
  expected: asHttpUrl.expected,
  parse: (raw) => asHttpUrl.parse(raw)?.replace(/\/+$/, ''),
  secret: true,
};

/**
 * A payment's longest life, in seconds. At least 30, so that a payment signed on a slow chain still
 * lies more than the gateway's 5-block margin ahead of the final height; at most an hour.
 */
const asTimeoutSeconds = asInteger(30, 3600);

const asAccountId: Rule<string> = {
  expected: 'a NEAR account id',
  parse: (raw) => (isAccountId(raw) ? raw : undefined),
};

/** A decimal integer from `min` to `max`, written without sign or leading zero. */
export function asInteger(min: number, max: number, expected = `an integer from ${min} to ${max}`): Rule<number> {
  return {
    expected,
    parse(raw) {
      const value = INTEGER.test(raw) ? Number(raw) : Number.NaN;
      return value >= min && value <= max ? value : undefined;
    },
  };
}

/** A decimal integer from 1 to Number.MAX_SAFE_INTEGER. */
export const asPositiveInteger: Rule<number> = asInteger(1, Number.MAX_SAFE_INTEGER, 'a positive integer');

/** An amount in a token's base units: decimal digits, no sign, no leading zero. */
export const asAmount: Rule<bigint> = {
  expected: 'an amount in base units (decimal digits, such as 10000)',
  parse: (raw) => (INTEGER.test(raw) ? BigInt(raw) : undefined),
};

/**
 * An amount of NEAR written as a decimal number, such as `0.05`, read into yoctoNEAR. The string is
 * converted as written: a JS number would turn 0.0000001 into `1e-7`, which nearToYocto refuses.
 */
export const asNear: Rule<bigint> = {
  expected: 'an amount of NEAR as a decimal number with at most 24 decimals, such as 0.05',
  parse: (raw) => (NEAR_AMOUNT.test(raw) ? nearToYocto(raw as `${number}`) : undefined),
};

/** An absolute path. A relative one would depend on the folder the process was started from. */
export const asAbsolutePath: Rule<string> = {
  expected: 'an absolute path',
  parse: (raw) => (isAbsolute(raw) ? raw : undefined),
};
