import { createPrivateKey, createPublicKey } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAccountId, type Network } from '@quorum-on-near/protocol';
import type { JWK } from 'jose';
import { baseDecode, KeyPair, type KeyPairString } from 'near-api-js';
import { isPrivateEd25519Jwk } from './credential.ts';

export { checkChainId } from '@quorum-on-near/protocol';

/** Circle's USDC on NEAR testnet. */
export const TESTNET_USDC = '3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af';

export interface GatewayConfig {
  /** `near:testnet`, or `near:sandbox` for a local test chain. */
  network: Network;
  /** Public: `/config.json` gives it to the live page unless `rpcPassthrough` is on. */
  rpcUrl: string;
  /** The gateway's public base URL, without a trailing slash. */
  publicUrl: string;
  port: number;
  parent: string;
  token: string;
  poolsContract: string;
  relayer: string;
  provider: string;
  /** The relayer account's secret keys, `ed25519:<base58>`. */
  relayerKeys: string[];
  /** The private Ed25519 JWK that signs credentials, with only its kty, crv, x and d. */
  credentialJwk: JWK;
  minGas: bigint;
  maxGas: bigint;
  maxTimeoutSeconds: number;
  blockTimeMs: number;
  keeperIntervalMs: number;
  refundLimit: number;
  settleGas: bigint;
  refundGas: bigint;
  dataDir: string;
  /** The live page's folder, whose four page files (and no other) are served from `/`, or null to serve nothing there. */
  webDir: string | null;
  rpcPassthrough: boolean;
  explorerTxUrl: string;
  /** A demo run's program and first arguments, to which the scenario is appended; null: the demo is off. */
  demoCommand: string[] | null;
  /** Demo runs started per UTC day, counted in memory. */
  demoMaxRunsPerDay: number;
  /** How long a demo run may last, in seconds, before the gateway stops it. */
  demoMaxRunSeconds: number;
  /**
   * Secret: the RPC URL a demo run gets as its QUORUM_RPC_URL, which may hold a key. Never published or
   * written out. Null: a run uses `rpcUrl`.
   */
  demoRpcUrl: string | null;
}

/** Thrown by loadConfig with one line per missing or invalid variable. */
export class ConfigError extends Error {
  override name = 'ConfigError';
}

/** How one variable is read. */
interface Rule<T> {
  /** Completes "<VARIABLE> must be …". */
  expected: string;
  /** The value, or undefined when `raw` is invalid. */
  parse(raw: string): T | undefined;
  /** Keep the raw value out of the problem line. */
  secret?: boolean;
}

/** The networks the gateway runs on. */
const NETWORKS: Network[] = ['near:testnet', 'near:sandbox'];
const INTEGER = /^(0|[1-9][0-9]*)$/;
const ED25519_PREFIX = 'ed25519:';
const TGAS = 1_000_000_000_000n;
/**
 * The most gas the gateway attaches to one call: 300 Tgas. A deliberately conservative bound of the
 * gateway's own, not a protocol limit: the largest call the gateway makes is a full refund batch,
 * which needs about 280 Tgas attached (spec section 5.4).
 */
const MAX_CALL_GAS = 300n * TGAS;
/** The gateway's own folder, which holds its `.env` file. */
const GATEWAY_DIR = resolve(fileURLToPath(new URL('..', import.meta.url)));

/**
 * The gas the pools contract asserts at the entry of a call that schedules `transfers` transfers:
 * 10 Tgas for its own work, then 10 for each transfer, 10 for its callback and 3 for their receipts.
 * `settle` schedules 1; `refund` up to its limit, plus the dust.
 */
function gasRequiredAtEntry(transfers: number): bigint {
  return 10n * TGAS + BigInt(transfers) * 23n * TGAS;
}

/**
 * A call uses some gas before the contract's entry check (loading the contract, reading its state,
 * parsing its arguments), and the check only counts what is left. A call that attaches just
 * `gasRequiredAtEntry` therefore always fails at entry. 17 Tgas is the margin with which the contract's
 * sandbox gas test completes a full refund batch: 280 Tgas against the 263 Tgas it requires (spec
 * section 5.4).
 */
const GAS_BEFORE_ENTRY_CHECK = 17n * TGAS;

/** The least gas worth attaching to a call that schedules `transfers` transfers. */
function leastKeeperGas(transfers: number): bigint {
  return gasRequiredAtEntry(transfers) + GAS_BEFORE_ENTRY_CHECK;
}

/** Whether `dir` is `inner` or a folder above it. */
function holds(dir: string, inner: string): boolean {
  const path = relative(dir, inner);
  return path === '' || (!isAbsolute(path) && path.split(sep)[0] !== '..');
}

const asNetwork: Rule<Network> = {
  expected: `${NETWORKS.join(' or ')} (the gateway runs on no other network)`,
  parse: (raw) => NETWORKS.find((network) => network === raw),
};

const asHttpUrl: Rule<string> = {
  expected: 'an http or https URL',
  parse: (raw) => (URL.canParse(raw) && ['http:', 'https:'].includes(new URL(raw).protocol) ? raw : undefined),
};

/** Never repeated in a problem line: a provider may put its key in the URL, even in its path. */
const asRpcUrl: Rule<string> = { ...asHttpUrl, secret: true };

/**
 * A prefix that a transaction hash is appended to, for a link to the explorer. It ends in `/` or `=`,
 * and a link built from it keeps its origin: appended to `https://explorer.example`, a hash would
 * become part of the host. The live page refuses the same prefixes, so a gateway that starts publishes
 * only a prefix the page accepts.
 */
const asExplorerPrefix: Rule<string> = {
  expected: `${asHttpUrl.expected} that ends in / or =, and whose links keep its origin`,
  parse(raw) {
    if (asHttpUrl.parse(raw) === undefined || !(raw.endsWith('/') || raw.endsWith('='))) return undefined;
    const link = `${raw}x`;
    return URL.canParse(link) && new URL(link).origin === new URL(raw).origin ? raw : undefined;
  },
};

/**
 * Whether `url` has a user name, a password, a query or a fragment: where an endpoint's key would go.
 * A key in the path cannot be told from a path, so it goes unseen: such an endpoint needs the pass-through.
 */
function mayHoldKey(url: string): boolean {
  const { username, password, search, hash } = new URL(url);
  return username !== '' || password !== '' || search !== '' || hash !== '';
}

const asBaseUrl: Rule<string> = {
  expected: asHttpUrl.expected,
  parse: (raw) => asHttpUrl.parse(raw)?.replace(/\/+$/, ''),
};

const asAccountId: Rule<string> = {
  expected: 'a NEAR account id',
  parse: (raw) => (isAccountId(raw) ? raw : undefined),
};

function asInteger(min: number, max: number, expected = `an integer from ${min} to ${max}`): Rule<number> {
  return {
    expected,
    parse(raw) {
      const value = INTEGER.test(raw) ? Number(raw) : Number.NaN;
      return value >= min && value <= max ? value : undefined;
    },
  };
}

const asPositiveInteger = asInteger(1, Number.MAX_SAFE_INTEGER, 'a positive integer');

/** The longest delay a Node timer honours: it turns any longer one into 1 ms. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** Gas from `min`, which `why` explains, to the most the gateway attaches to one call. */
function asGas(min = 1n, why?: string): Rule<bigint> {
  const from = why === undefined ? `${min}` : `${min} (${why})`;
  return {
    expected: `an amount of gas from ${from} to ${MAX_CALL_GAS} (300 Tgas, the most the gateway attaches to one call)`,
    parse(raw) {
      const gas = INTEGER.test(raw) ? BigInt(raw) : -1n;
      return gas >= min && gas <= MAX_CALL_GAS ? gas : undefined;
    },
  };
}

const asBoolean: Rule<boolean> = {
  expected: 'true or false',
  parse: (raw) => (raw === 'true' ? true : raw === 'false' ? false : undefined),
};

const asPath: Rule<string> = {
  expected: 'a non-empty path',
  parse: (raw) => (raw === '' ? undefined : raw),
};

/** A relative path resolves against the current folder, as the gateway serves it. */
const asWebDir: Rule<string | null> = {
  expected: `empty, or a folder that neither is nor contains the gateway's own folder (${GATEWAY_DIR})`,
  parse: (raw) => (raw === '' ? null : holds(resolve(raw), GATEWAY_DIR) ? undefined : raw),
};

const asRelayerKeys: Rule<string[]> = {
  expected: 'a comma-separated list of ed25519 secret keys',
  secret: true,
  parse(raw) {
    const keys = raw
      .split(',')
      .map((key) => key.trim())
      .filter((key) => key !== '');
    return keys.length > 0 && keys.every(isEd25519SecretKey) ? keys : undefined;
  },
};

/**
 * Whether `x` is the public key of the Ed25519 private key `d` in `jwk`. Node derives the public key
 * from `d` and fails on a `d` that is not a key. Nothing it throws is repeated: the error may quote the key.
 */
function holdsKeyPair(jwk: JWK & { x: string; d: string }): boolean {
  try {
    return createPublicKey(createPrivateKey({ key: jwk, format: 'jwk' })).export({ format: 'jwk' }).x === jwk.x;
  } catch {
    return false;
  }
}

/**
 * Keeps only `kty`, `crv`, `x` and `d`: the issuer's JWK import would pass any other member on, such
 * as `key_ops`, which it takes as the key's usages and refuses unless they allow signing.
 */
const asCredentialJwk: Rule<JWK> = {
  expected: 'a private Ed25519 JWK (JSON with kty "OKP", crv "Ed25519", x and d)',
  secret: true,
  parse(raw) {
    try {
      const jwk: unknown = JSON.parse(raw);
      if (!isPrivateEd25519Jwk(jwk)) return undefined;
      const { kty, crv, x, d } = jwk;
      const key = { kty, crv, x, d };
      return holdsKeyPair(key) ? key : undefined;
    } catch {
      return undefined;
    }
  },
};

/** Whether `value` is a non-empty array of non-empty strings. */
function isCommand(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((part) => typeof part === 'string' && part !== '');
}

/**
 * A demo run's program and first arguments, as a JSON array; empty turns the demo off. The gateway
 * starts the program without a shell, so it must be the run itself (hosted demo spec, section 4.1).
 */
const asDemoCommand: Rule<string[] | null> = {
  expected:
    'empty (the demo is off), or a JSON array of one or more non-empty strings: the program to start, then its first arguments',
  parse(raw) {
    if (raw === '') return null;
    try {
      const value: unknown = JSON.parse(raw);
      return isCommand(value) ? value : undefined;
    } catch {
      return undefined;
    }
  },
};

/**
 * The RPC URL a demo run gets in place of the gateway's; empty: the gateway's. No page is ever given
 * it, so it may hold a key anywhere, and it is never repeated in a problem line.
 */
const asDemoRpcUrl: Rule<string | null> = {
  expected: `empty, or ${asHttpUrl.expected}`,
  secret: true,
  parse: (raw) => (raw === '' ? null : asHttpUrl.parse(raw)),
};

/** The positions, from 1, of the first key listed twice, compared by public key; null if none is. */
function repeatedKey(keys: string[]): [number, number] | null {
  const publicKeys = keys.map((key) => KeyPair.fromString(key as KeyPairString).getPublicKey().toString());
  for (const [later, publicKey] of publicKeys.entries()) {
    const first = publicKeys.indexOf(publicKey);
    if (first < later) return [first + 1, later + 1];
  }
  return null;
}

/**
 * Whether `key` is a NEAR ed25519 secret key: 64 bytes, the seed then its public key.
 * `KeyPair.fromString` alone also accepts 32 bytes, such as a public key, and derives another key.
 */
function isEd25519SecretKey(key: string): boolean {
  if (!key.startsWith(ED25519_PREFIX)) return false;
  try {
    const bytes = baseDecode(key.slice(ED25519_PREFIX.length));
    const publicKey = KeyPair.fromString(key as KeyPairString).getPublicKey().data;
    return bytes.length === 64 && Buffer.from(bytes.subarray(32)).equals(publicKey);
  } catch {
    return false;
  }
}

/** A GatewayConfig being read: a value is undefined when its variable has a problem. */
type Draft = { [K in keyof GatewayConfig]: GatewayConfig[K] | undefined };

/**
 * Reads the configuration from environment variables (see `.env.example`). Collects every problem
 * and throws one ConfigError listing them all.
 */
export function loadConfig(env: Record<string, string | undefined>): GatewayConfig {
  const problems: string[] = [];

  const check = <T>(name: string, raw: string, rule: Rule<T>): T | undefined => {
    const value = rule.parse(raw);
    if (value === undefined) {
      problems.push(`${name} must be ${rule.expected}${rule.secret ? '' : `, got ${JSON.stringify(raw)}`}`);
    }
    return value;
  };
  const optional = <T>(name: string, fallback: string, rule: Rule<T>): T | undefined =>
    check(name, env[name] ?? fallback, rule);
  const required = <T>(name: string, rule: Rule<T>): T | undefined => {
    const raw = env[name];
    if (raw !== undefined && raw !== '') return check(name, raw, rule);
    problems.push(`${name} is required`);
    return undefined;
  };

  const network = optional('QUORUM_NETWORK', 'near:testnet', asNetwork);
  const rpcUrl = optional('QUORUM_RPC_URL', 'https://test.rpc.fastnear.com', asRpcUrl);
  const publicUrl = optional('QUORUM_GATEWAY_URL', 'http://localhost:8402', asBaseUrl);
  const port = optional('QUORUM_GATEWAY_PORT', '8402', asInteger(1, 65_535));
  const parent = required('QUORUM_PARENT_ACCOUNT', asAccountId);
  const token = optional('QUORUM_TOKEN_ACCOUNT', TESTNET_USDC, asAccountId);
  /** An account that defaults to `<prefix>.<parent>`. */
  const child = (name: string, prefix: string): string | undefined => {
    const raw = env[name] ?? (parent === undefined ? undefined : `${prefix}.${parent}`);
    // Without a valid parent there is no default, and the parent's problem is already listed.
    return raw === undefined ? undefined : check(name, raw, asAccountId);
  };
  const poolsContract = child('QUORUM_POOLS_ACCOUNT', 'pools');
  const relayer = child('QUORUM_RELAYER_ACCOUNT', 'relay');
  const provider = child('QUORUM_PROVIDER_ACCOUNT', 'provider');
  const relayerKeys = required('QUORUM_RELAYER_KEYS', asRelayerKeys);
  // A key listed twice could sign two transactions at once. Positions only: the keys are secret.
  const repeated = relayerKeys === undefined ? null : repeatedKey(relayerKeys);
  if (repeated !== null) {
    problems.push(`QUORUM_RELAYER_KEYS must list each key once: keys ${repeated[0]} and ${repeated[1]} are the same`);
  }
  const credentialJwk = required('QUORUM_CREDENTIAL_JWK', asCredentialJwk);
  const minGas = optional('QUORUM_COMMIT_MIN_GAS', '50000000000000', asGas());
  const maxGas = optional('QUORUM_COMMIT_MAX_GAS', '100000000000000', asGas());
  if (minGas !== undefined && maxGas !== undefined && maxGas < minGas) {
    problems.push(`QUORUM_COMMIT_MAX_GAS must be at least QUORUM_COMMIT_MIN_GAS (${minGas}), got "${maxGas}"`);
  }
  const maxTimeoutSeconds = optional('QUORUM_MAX_TIMEOUT_SECONDS', '120', asPositiveInteger);
  const blockTimeMs = optional('QUORUM_BLOCK_TIME_MS', '1000', asPositiveInteger);
  // The keeper waits this long between runs with a timer, which a longer delay would turn into 1 ms.
  const keeperIntervalMs = optional(
    'QUORUM_KEEPER_INTERVAL_MS',
    '5000',
    asInteger(
      1,
      MAX_TIMER_DELAY_MS,
      `an integer from 1 to ${MAX_TIMER_DELAY_MS} (the longest delay a Node timer honours)`,
    ),
  );
  const refundLimit = optional('QUORUM_REFUND_LIMIT', '10', asInteger(1, 10));
  // With less gas than the contract asserts at entry, plus what the call uses before that check, every
  // call would panic.
  const settleGas = optional(
    'QUORUM_SETTLE_GAS',
    '100000000000000',
    asGas(leastKeeperGas(1), 'what settle requires at entry, plus what it uses before that check'),
  );
  // Without a valid limit there is no requirement to check, and the limit's problem is already listed.
  const refundGasRule =
    refundLimit === undefined
      ? asGas()
      : asGas(
          leastKeeperGas(refundLimit + 1),
          `what refund requires at entry with QUORUM_REFUND_LIMIT ${refundLimit}, plus what it uses before that check`,
        );
  const refundGas = optional('QUORUM_REFUND_GAS', '300000000000000', refundGasRule);
  const dataDir = optional('QUORUM_DATA_DIR', 'data', asPath);
  const webDir = optional('QUORUM_WEB_DIR', '../web', asWebDir);
  const rpcPassthrough = optional('QUORUM_RPC_PASSTHROUGH', 'false', asBoolean);
  // Without the pass-through, /config.json gives the RPC URL to the live page. The URL is not repeated:
  // it may hold a key.
  if (rpcPassthrough === false && rpcUrl !== undefined && mayHoldKey(rpcUrl)) {
    problems.push(
      'QUORUM_RPC_URL must have no user name, password, query or fragment while QUORUM_RPC_PASSTHROUGH is false, ' +
        'since /config.json gives it to the live page; ' +
        'for an endpoint with a key in its URL, set QUORUM_RPC_PASSTHROUGH=true',
    );
  }

  const explorerTxUrl = optional('QUORUM_EXPLORER_TX_URL', 'https://testnet.nearblocks.io/txns/', asExplorerPrefix);
  // The demo endpoint (hosted demo spec, section 4.1): an empty command turns it off, and its limits are
  // checked either way.
  const demoCommand = optional('QUORUM_DEMO_COMMAND', '', asDemoCommand);
  const demoMaxRunsPerDay = optional('QUORUM_DEMO_MAX_RUNS_PER_DAY', '100', asInteger(1, 1000));
  const demoMaxRunSeconds = optional('QUORUM_DEMO_MAX_RUN_SECONDS', '1800', asInteger(60, 7200));
  // Checked either way too. Unlike QUORUM_RPC_URL, it may hold a key with the pass-through off: no page
  // is ever given it.
  const demoRpcUrl = optional('QUORUM_DEMO_RPC_URL', '', asDemoRpcUrl);

  const draft: Draft = {
    network,
    rpcUrl,
    publicUrl,
    port,
    parent,
    token,
    poolsContract,
    relayer,
    provider,
    relayerKeys,
    credentialJwk,
    minGas,
    maxGas,
    maxTimeoutSeconds,
    blockTimeMs,
    keeperIntervalMs,
    refundLimit,
    settleGas,
    refundGas,
    dataDir,
    webDir,
    rpcPassthrough,
    explorerTxUrl,
    demoCommand,
    demoMaxRunsPerDay,
    demoMaxRunSeconds,
    demoRpcUrl,
  };
  if (problems.length > 0) throw new ConfigError(problems.join('\n'));
  // No problem was listed, so every value in the draft is defined.
  return draft as GatewayConfig;
}
