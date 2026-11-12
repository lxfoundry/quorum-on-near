import { generateKeyPairSync } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { keyFolderPath, readKeyFolder } from '@quorum-on-near/buyer';
import type { KeyPair } from 'near-api-js';
import type { SwarmConfig } from './config.ts';

/**
 * The `.env` files of the gateway and the MCP server, written from the swarm's configuration, so that
 * the three apps share one value of each shared variable. The text is checked with Node's own env
 * file parser, which `process.loadEnvFile` and `--env-file` use, so each value reads back as written.
 */

/** An app whose `.env` file the swarm writes. */
export type EnvApp = 'gateway' | 'mcp';

/** A private Ed25519 JWK with only the members the gateway reads. */
export interface CredentialJwk {
  kty: 'OKP';
  crv: 'Ed25519';
  /** The public key, base64url. */
  x: string;
  /** The private key, base64url. */
  d: string;
}

/** An env file that already exists: the swarm never writes over one. */
export class EnvFileExistsError extends Error {
  override name = 'EnvFileExistsError';
  readonly path: string;

  constructor(path: string) {
    super(`there is an env file at ${path} already, and it is left as it is: remove it to write a new one`);
    this.path = path;
  }
}

/** One variable of an env file and its value. */
type EnvEntry = readonly [name: string, value: string];

/** `apps/<app>/.env`, resolved from this module's own location: it does not depend on the current folder. */
export function envFilePath(app: EnvApp): string {
  return fileURLToPath(new URL(`../../${app}/.env`, import.meta.url));
}

/** A new credential key for the gateway: an Ed25519 key pair from node:crypto, as a private JWK. */
export function newCredentialJwk(): CredentialJwk {
  const { x, d } = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' });
  if (typeof x !== 'string' || typeof d !== 'string') {
    throw new TypeError('node:crypto exported an Ed25519 key without x and d');
  }
  return { kty: 'OKP', crv: 'Ed25519', x, d };
}

/**
 * The gateway's `.env`: the variables it shares with the swarm, its relayer and provider accounts,
 * the relayer's keys (QUORUM_RELAYER_KEYS) and the credential key (QUORUM_CREDENTIAL_JWK). Its other
 * variables keep the gateway's defaults. Throws RangeError without a relayer key, or for a value that
 * would not read back as it is; the message names the variable, never the value.
 */
export function gatewayEnvText(config: SwarmConfig, relayerKeys: readonly KeyPair[], credentialJwk: CredentialJwk): string {
  if (relayerKeys.length === 0) throw new RangeError(`the gateway needs at least one key of the relayer ${config.relayer}`);
  return envText(
    [
      "Written by `swarm env gateway` from the swarm's configuration.",
      "Secret: it holds the relayer's keys and the credential key. Keep it private, and never commit it.",
    ],
    [
      ...sharedEntries(config),
      ['QUORUM_RELAYER_ACCOUNT', config.relayer],
      ['QUORUM_PROVIDER_ACCOUNT', config.provider],
      ['QUORUM_RELAYER_KEYS', relayerKeys.map((key) => key.toString()).join(',')],
      ['QUORUM_CREDENTIAL_JWK', JSON.stringify(credentialJwk)],
      ['QUORUM_COMMIT_MIN_GAS', config.commitMinGas.toString()],
      ['QUORUM_COMMIT_MAX_GAS', config.commitMaxGas.toString()],
      ['QUORUM_BLOCK_TIME_MS', config.blockTimeMs.toString()],
    ],
  );
}

/**
 * The MCP server's `.env`: the variables it shares with the swarm (the longest expiry its buyer signs
 * among them), its buyer, the folder of the key files, the spend file, and a spend cap equal to the
 * budget setup tops its buyer up to. It holds no key: the server reads its buyer's key file. Throws
 * RangeError for a value that would not read back as it is.
 */
export function mcpEnvText(config: SwarmConfig): string {
  return envText(
    ["Written by `swarm env mcp` from the swarm's configuration."],
    [
      ...sharedEntries(config),
      ['QUORUM_BLOCK_TIME_MS', config.blockTimeMs.toString()],
      ['QUORUM_BUYER_MAX_TIMEOUT_SECONDS', config.maxTimeoutSeconds.toString()],
      ['QUORUM_MCP_ACCOUNT', config.mcpAccount],
      ['QUORUM_CREDENTIALS_DIR', config.credentialsDir],
      ['QUORUM_MCP_SPEND_CAP', config.buyerBudget.toString()],
      ['QUORUM_MCP_SPEND_FILE', config.spendFile],
    ],
  );
}

/**
 * Writes `text` to a new file readable by its owner only (mode 0o600, on POSIX systems; see aclNotice
 * for Windows). Never writes over a file: throws EnvFileExistsError if there is one.
 */
export async function writeEnvFile(path: string, text: string): Promise<void> {
  try {
    await writeFile(path, text, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new EnvFileExistsError(path);
    throw error;
  }
}

/**
 * What `swarm env gateway` says after writing the gateway's `.env` to `path` on Windows, where Node
 * applies only the read-only bit of a file's mode, so the file is readable by whoever its folder's
 * access control list lets in: the icacls command that removes the inherited entries and gives `user`
 * alone full control. Null on other systems, where writeEnvFile makes it readable by its owner only.
 */
export function aclNotice(path: string, platform: NodeJS.Platform, user: string): string | null {
  if (platform !== 'win32') return null;
  return (
    `${path} is protected only by its folder's access control list, since Windows ignores the file mode: ` +
    `to let ${user} alone use it, run icacls "${path}" /inheritance:r /grant:r "${user}:F"`
  );
}

/**
 * `swarm env gateway`: writes the gateway's `.env` to `path` with every key of the relayer's key
 * folder and a new credential key. Throws KeyFileError when the key folder is missing or holds a file
 * that is not a key, and EnvFileExistsError when `path` exists.
 */
export async function writeGatewayEnv(config: SwarmConfig, path: string): Promise<void> {
  const relayerKeys = await readKeyFolder(keyFolderPath(config.credentialsDir, config.network, config.relayer));
  await writeEnvFile(path, gatewayEnvText(config, relayerKeys, newCredentialJwk()));
}

/** `swarm env mcp`: writes the MCP server's `.env` to `path`. Throws EnvFileExistsError when `path` exists. */
export async function writeMcpEnv(config: SwarmConfig, path: string): Promise<void> {
  await writeEnvFile(path, mcpEnvText(config));
}

/** The variables every app reads alike from the buyer settings, in the gateway's order. */
function sharedEntries(config: SwarmConfig): EnvEntry[] {
  return [
    ['QUORUM_NETWORK', config.network],
    ['QUORUM_RPC_URL', config.rpcUrl],
    ['QUORUM_GATEWAY_URL', config.gatewayUrl],
    ['QUORUM_PARENT_ACCOUNT', config.parent],
    ['QUORUM_TOKEN_ACCOUNT', config.token],
    ['QUORUM_POOLS_ACCOUNT', config.poolsContract],
  ];
}

/**
 * An env file: `comments` as `#` lines, then one `NAME=value` line per entry. Throws RangeError for
 * an entry that Node's parser would not read back as it is, such as a value holding `#`.
 */
function envText(comments: readonly string[], entries: readonly EnvEntry[]): string {
  const lines = [...comments.map((comment) => `# ${comment}`), ...entries.map(([name, value]) => `${name}=${value}`)];
  const text = `${lines.join('\n')}\n`;
  const read = parseEnv(text);
  for (const [name, value] of entries) {
    if (read[name] !== value) throw new RangeError(`${name} has a value that an env file cannot hold as it is`);
  }
  return text;
}
