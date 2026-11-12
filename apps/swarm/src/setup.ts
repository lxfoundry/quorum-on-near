import { readFile } from 'node:fs/promises';
import {
  folderKeyPath,
  KeyFileError,
  keyFilePath,
  keyFolderPath,
  readKeyFile,
  readKeyFolder,
  readSpendFile,
  SpendFileError,
  writeKeyFile,
  writeSpendFile,
} from '@quorum-on-near/buyer';
import { KeyPair, yoctoToNear } from 'near-api-js';
import { swarmAccounts, type SwarmAccount } from './accounts.ts';
import {
  BATCHED_CALL_GAS,
  checkChain,
  freeBalance,
  MAX_CALLS_PER_TRANSACTION,
  rerunAdvice,
  type AccountKey,
  type AccountState,
  type SwarmChain,
  type TokenTransfer,
} from './chain.ts';
import type { SwarmConfig } from './config.ts';
import { count } from './words.ts';

/** What runSetup works with besides the configuration. */
export interface SetupDeps {
  chain: SwarmChain;
  /** Receives one line for each action as it is taken, or `nothing to do` after a run that took none. */
  log: (line: string) => void;
}

/** What a setup did. */
export interface SetupReport {
  /** One line for each transaction sent and each file written, in order; empty when all was in place. */
  actions: string[];
}

/** Why setup stopped. */
export type SetupProblem =
  /** An account setup does not create is missing: the parent, or an account outside it. */
  | 'missing_account'
  /** An account that exists, the parent included, has no key file, so it cannot sign. */
  | 'missing_key'
  /** The pools contract must be deployed, but QUORUM_POOLS_WASM is not set. */
  | 'missing_wasm'
  /** The pools contract was initialised with another token than QUORUM_TOKEN_ACCOUNT. */
  | 'wrong_token'
  /** The parent cannot pay for what setup would send from it. */
  | 'near_shortfall'
  /** The funding account cannot cover the token top-ups. */
  | 'token_shortfall';

/** Setup stopped before it was done. The message says why; it names accounts and files, never a key. */
export class SetupError extends Error {
  override name = 'SetupError';
  readonly problem: SetupProblem;

  constructor(problem: SetupProblem, message: string) {
    super(message);
    this.problem = problem;
  }
}

/** An account setup pays from does not hold what setup must send: `shortfall` is what it lacks. */
export class ShortfallError extends SetupError {
  override name = 'ShortfallError';
  readonly account: string;
  /** In yoctoNEAR for `near_shortfall`, in the token's base units for `token_shortfall`. */
  readonly shortfall: bigint;

  constructor(problem: 'near_shortfall' | 'token_shortfall', account: string, shortfall: bigint, message: string) {
    super(problem, message);
    this.account = account;
    this.shortfall = shortfall;
  }
}

/**
 * Setup tops an account up once it holds less than this share of its NEAR target, in percent. Every
 * transaction an account signs burns some of its NEAR, and the funding account signs setup's own
 * token transfers, so topping up any shortfall at all would make each run send something.
 */
const TOP_UP_BELOW_PERCENT = 90n;

/**
 * 0.1 NEAR: the base of what the parent keeps for gas beyond what setup sends from it. It covers the
 * gas its transactions burn (a NEAR transfer burns 0.000045 NEAR at the floor gas price of 0.0001
 * NEAR per Tgas), and the gas a creation or a NEAR transfer buys upfront while it runs (about 0.01
 * NEAR at GAS_PURCHASE_PRICE).
 */
const BASE_GAS_MARGIN = 100_000_000_000_000_000_000_000n;

/**
 * 0.008 NEAR, kept for each account setup creates: NEAR charges a fixed 0.007 NEAR for each account
 * creation, which it keeps back from the transaction's gas refund, about 0.00707 NEAR in all with the
 * fees of sending the creation.
 */
const CREATION_COST = 8_000_000_000_000_000_000_000n;

/**
 * The yoctoNEAR per unit of gas at which a transaction's gas is bought when it is sent: NEAR's
 * `min_gas_purchase_price`, 0.001 NEAR per Tgas, the buy price while the gas price is below it (its
 * floor is 0.0001 NEAR per Tgas). The signer must hold the gas a function call attaches at this price
 * while the transaction runs; the gas it does not burn, and the difference with the price it burns
 * at, are refunded once it is done.
 */
const GAS_PURCHASE_PRICE = 1_000_000_000n;

/** An account as setup found it before acting. */
interface Found {
  account: SwarmAccount;
  /** null when the account does not exist. */
  state: AccountState | null;
  /** The keys its key file holds (its key folder's, for the relayer); empty when there is none, or none is needed. */
  keys: KeyPair[];
  /** Whether it is registered on the token; false for an account that is not to be. */
  registered: boolean;
}

/** A NEAR transfer from the parent, and what its line adds to the amount, if anything. */
interface NearTopUp {
  receiverId: string;
  amount: bigint;
  note?: string;
}

/** What step 0 found and checked: everything steps 1 to 5 will do, worked out before any is done. */
interface Plan {
  parent: AccountKey;
  found: Found[];
  /** The pools contract's code when step 3 must deploy it, else null. */
  code: Uint8Array | null;
  topUps: NearTopUp[];
  registrations: string[];
  /** The deposit that registers one account on the token, in yoctoNEAR. */
  deposit: bigint;
  /** Step 5's token transfers, which the funding account makes only if it can cover them all. */
  tokenTopUps: TokenTransfer[];
}

/** What one run works with. */
interface Run {
  config: SwarmConfig;
  chain: SwarmChain;
  report: (line: string) => void;
}

/**
 * Prepares every account of the system (spec section 7.2). It is idempotent: a run that finds
 * everything in place sends nothing and logs `nothing to do`.
 *
 * 0. Reads and checks everything before it sends anything: the RPC's chain (ConfigError, as the
 *    command line gives, when it is not the one QUORUM_NETWORK names), the parent's key file
 *    and account, each account's state, key file and token balance, the pools contract's token, and
 *    that the parent holds, free of its storage (freeBalance), what steps 1, 2 and 4 send from it plus
 *    a margin for gas: 0.1 NEAR, plus
 *    0.008 NEAR for each account it creates, plus the gas that the largest batch of calls it signs
 *    (registrations, and token top-ups when it is the funding account) buys upfront, 0.02 NEAR a
 *    call. Throws SetupError if not.
 * 1. Creates each missing sub-account of the parent with its NEAR target as balance. A key that an
 *    earlier run left in the account's key file is reused; a new key is written to its key file
 *    before the transaction is sent. The relayer gets QUORUM_RELAYER_KEY_COUNT keys.
 * 2. Tops each existing account up to its NEAR target from the parent, once it holds less than 90%
 *    of it. A funding account that is the parent is never topped up. The pools contract, once it
 *    holds code, is topped up instead to QUORUM_POOLS_FREE_NEAR of NEAR free of its storage, once
 *    less than 90% of that is free.
 * 3. Deploys the pools contract, initialised with the configured token, if it holds no code. It
 *    comes after the top-ups, so that a pools account holding less than its code locks has been
 *    topped up first.
 * 4. Registers the funding account, the pools contract, the provider and each buyer on the token,
 *    paid by the parent, at most 10 per transaction.
 * 5. Tops the provider and each buyer up to its token amount from the funding account, at most 10 per
 *    transaction, or throws ShortfallError and makes none of them if the funding account cannot
 *    cover them all. Then clears the MCP server's spend total.
 *
 * Each action is logged as it is taken, and returned. A write that fails throws its error; one that
 * got no result (OutcomeUnknownError) also says that setup can be run again once it is final.
 */
export async function runSetup(config: SwarmConfig, deps: SetupDeps): Promise<SetupReport> {
  try {
    return await setUp(config, deps);
  } catch (error) {
    throw rerunAdvice(error, 'Setup', 'it sends only what is still missing');
  }
}

async function setUp(config: SwarmConfig, deps: SetupDeps): Promise<SetupReport> {
  const { chain } = deps;
  const actions: string[] = [];
  const run: Run = {
    config,
    chain,
    report(line) {
      actions.push(line);
      deps.log(line);
    },
  };

  const { parent, found, code, topUps, registrations, deposit, tokenTopUps } = await prepare(config, chain);
  /** The key each account signs with, by account id. */
  const signers = new Map<string, KeyPair>();
  for (const { account, keys } of found) {
    if (keys[0] !== undefined) signers.set(account.id, keys[0]);
  }

  // 1. Creations.
  for (const entry of found) {
    if (entry.state === null) signers.set(entry.account.id, await create(run, parent, entry));
  }
  // 2. NEAR top-ups.
  for (const { receiverId, amount, note } of topUps) {
    const outcome = await chain.transferNear(parent, receiverId, amount);
    run.report(`topped up  ${receiverId}  +${near(amount)}${note === undefined ? '' : `  ${note}`}  tx ${outcome.txHash}`);
  }
  // 3. The pools contract.
  if (code !== null) await deploy(run, signerOf(signers, config.poolsContract), code);
  // 4. Registrations.
  for (const batch of batches(registrations)) {
    const outcome = await chain.storageDeposits(parent, batch, deposit);
    run.report(`registered on the token  ${batch.join(', ')}  tx ${outcome.txHash}`);
  }
  // 5. Token top-ups, then the spend total.
  await topUpTokens(run, tokenTopUps, signerOf(signers, config.funding));
  await clearSpendTotal(run);

  if (actions.length === 0) deps.log('nothing to do');
  return { actions };
}

/** Step 0: reads and checks everything, and works out steps 1 to 5. Sends and writes nothing. */
async function prepare(config: SwarmConfig, chain: SwarmChain): Promise<Plan> {
  await checkChain(config.network, chain);

  const [parentKey] = await storedKeys(config, config.parent, false);
  if (parentKey === undefined) {
    const path = keyLocation(config, config.parent, false);
    throw new SetupError('missing_key', `there is no key for the parent account ${config.parent} at ${path}`);
  }
  const parentState = await chain.account(config.parent);
  if (parentState === null) throw new SetupError('missing_account', `the parent account ${config.parent} does not exist`);

  const found = await survey(config, chain);
  const code = await poolsCode(config, chain, found);
  const topUps = nearTopUps(config, found);
  const registrations = found
    .filter(({ account, registered }) => account.onToken && !registered)
    .map(({ account }) => account.id);
  const deposit = registrations.length > 0 ? await chain.registrationDeposit() : 0n;
  const tokenTopUps = await tokenShortfalls(chain, found);

  const created = found.filter(({ state }) => state === null);
  const sends =
    created.reduce((sum, { account }) => sum + (account.near ?? 0n), 0n) +
    topUps.reduce((sum, topUp) => sum + topUp.amount, 0n) +
    deposit * BigInt(registrations.length);
  // The parent signs the registrations, and the token top-ups when it is the funding account.
  const calls = Math.max(
    Math.min(registrations.length, MAX_CALLS_PER_TRANSACTION),
    config.funding === config.parent ? Math.min(tokenTopUps.length, MAX_CALLS_PER_TRANSACTION) : 0,
  );
  const margin = gasMargin(created.length, calls);
  // What the parent's storage locks it cannot send.
  const free = freeBalance(parentState);
  // Without anything to send or call, the parent signs nothing and needs no gas.
  if ((sends > 0n || calls > 0) && free < sends + margin.total) {
    const shortfall = sends + margin.total - free;
    throw new ShortfallError(
      'near_shortfall',
      config.parent,
      shortfall,
      `the parent account ${config.parent} holds ${near(free)} free of its storage, but setup sends ${near(sends)} from it ` +
        `and keeps ${near(margin.total)} for gas (${margin.parts.join(', plus ')}): send it ${near(shortfall)} more, ` +
        'then run setup again',
    );
  }
  const parent = { accountId: config.parent, keyPair: parentKey };
  return { parent, found, code, topUps, registrations, deposit, tokenTopUps };
}

/**
 * What the parent keeps for gas beyond what it sends: BASE_GAS_MARGIN, CREATION_COST for each of
 * `creations` accounts, and the gas a batch of `calls` function calls buys upfront at
 * GAS_PURCHASE_PRICE (batches are sent one after another, so only the largest counts). `parts` says
 * what the total is made of.
 */
function gasMargin(creations: number, calls: number): { total: bigint; parts: string[] } {
  const upfront = GAS_PURCHASE_PRICE * BATCHED_CALL_GAS * BigInt(calls);
  const parts = [near(BASE_GAS_MARGIN)];
  if (creations > 0) {
    parts.push(`${near(CREATION_COST)} for ${creations === 1 ? 'the account' : `each of the ${creations} accounts`} it creates`);
  }
  if (calls > 0) parts.push(`${near(upfront)} its largest batch of ${count(calls, 'call')} buys upfront, refunded after`);
  return { total: BASE_GAS_MARGIN + CREATION_COST * BigInt(creations) + upfront, parts };
}

/**
 * Reads each account's state, key file and registration, in swarmAccounts order. Throws SetupError
 * for a missing account setup cannot create, and for an existing account without a key file. Every
 * account signs, for setup or another command, except the pools contract once it holds code.
 */
async function survey(config: SwarmConfig, chain: SwarmChain): Promise<Found[]> {
  const found: Found[] = [];
  for (const account of swarmAccounts(config)) {
    const state = await chain.account(account.id);
    if (state === null && !account.create) {
      throw new SetupError(
        'missing_account',
        `${account.id} does not exist, and setup creates only direct sub-accounts of the parent account ${config.parent}`,
      );
    }
    const signs = state === null || account.role !== 'pools' || !state.hasCode;
    const keys = signs ? await storedKeys(config, account.id, account.role === 'relayer') : [];
    if (state !== null && signs && keys.length === 0) {
      const path = keyLocation(config, account.id, account.role === 'relayer');
      throw new SetupError('missing_key', `${account.id} exists, but there is no key for it at ${path}, so it cannot sign`);
    }
    const registered = account.onToken && (await chain.isRegistered(account.id));
    found.push({ account, state, keys, registered });
  }
  return found;
}

/**
 * The code step 3 deploys, read from QUORUM_POOLS_WASM, when the pools contract holds none; null when
 * it holds code, after checking that its token is the configured one.
 */
async function poolsCode(config: SwarmConfig, chain: SwarmChain, found: readonly Found[]): Promise<Uint8Array | null> {
  const pools = found.find((entry) => entry.account.role === 'pools');
  if (pools?.state?.hasCode === true) {
    const token = await chain.getToken();
    if (token !== config.token) {
      throw new SetupError(
        'wrong_token',
        `the pools contract ${config.poolsContract} was initialised with the token ${token}, not QUORUM_TOKEN_ACCOUNT ` +
          `${config.token}; a contract's token is set once, so another token needs another pools account`,
      );
    }
    return null;
  }
  if (config.poolsWasm === null) {
    throw new SetupError(
      'missing_wasm',
      `the pools contract ${config.poolsContract} holds no code: set QUORUM_POOLS_WASM to the path of its wasm file`,
    );
  }
  return readFile(config.poolsWasm);
}

/**
 * Step 2's transfers: an existing account with a NEAR target is topped up back to it once it holds
 * less than TOP_UP_BELOW_PERCENT of it. An account created in step 1 starts at its target. The pools
 * contract, once it holds code, goes by its free NEAR instead (freeBalance): the records it keeps for
 * each pool and each buyer lock more of its balance as they grow and are never freed, while the
 * balance itself stays where it was. It is topped up back to QUORUM_POOLS_FREE_NEAR free once less
 * than TOP_UP_BELOW_PERCENT of that is free, and its line says what was free.
 */
function nearTopUps(config: Pick<SwarmConfig, 'poolsFreeNear'>, found: readonly Found[]): NearTopUp[] {
  return found.flatMap(({ account, state }): NearTopUp[] => {
    if (state === null) return [];
    if (account.role === 'pools' && state.hasCode) {
      const free = freeBalance(state);
      const target = config.poolsFreeNear;
      if (free * 100n >= target * TOP_UP_BELOW_PERCENT) return [];
      return [{ receiverId: account.id, amount: target - free, note: `${near(free)} was free of its storage, now ${near(target)}` }];
    }
    const target = account.near;
    if (target === null || state.balance * 100n >= target * TOP_UP_BELOW_PERCENT) return [];
    return [{ receiverId: account.id, amount: target - state.balance }];
  });
}

/**
 * Where an account's keys are kept: in its key folder, one file per key, for an account with several
 * keys (the relayer), else in its key file.
 */
function keyLocation(config: SwarmConfig, accountId: string, several: boolean): string {
  const { credentialsDir, network } = config;
  return several ? keyFolderPath(credentialsDir, network, accountId) : keyFilePath(credentialsDir, network, accountId);
}

/** The keys kept for an account (see keyLocation); none when there is no key file or key folder. */
async function storedKeys(config: SwarmConfig, accountId: string, several: boolean): Promise<KeyPair[]> {
  const location = keyLocation(config, accountId, several);
  try {
    return several ? await readKeyFolder(location) : [await readKeyFile(location)];
  } catch (error) {
    if (error instanceof KeyFileError && error.problem === 'missing') return [];
    throw error;
  }
}

/**
 * Step 1 for one account: creates it with its NEAR target as balance, and returns the key it signs
 * with. It is given the keys its key files kept from an earlier run, completed with new ones up to
 * its key count. Each new key is written to its key file before the transaction is sent, so that a
 * run stopped before the account exists leaves the key behind for the next run. The relayer's keys
 * go to its key folder, and the first of them to its key file too, unless that file exists.
 */
async function create(run: Run, parent: AccountKey, entry: Found): Promise<KeyPair> {
  const { config } = run;
  const { id, keyCount } = entry.account;
  const several = entry.account.role === 'relayer';
  const keys = [...entry.keys];
  const file = keyFilePath(config.credentialsDir, config.network, id);
  while (keys.length < keyCount) {
    const keyPair = KeyPair.fromRandom('ed25519');
    await writeKey(run, several ? folderKeyPath(keyLocation(config, id, several), keyPair.getPublicKey()) : file, id, keyPair);
    keys.push(keyPair);
  }
  const [first] = keys;
  if (first === undefined) throw new RangeError(`${id} has a key count of ${keyCount}`);
  if (several) {
    try {
      await writeKey(run, file, id, first);
    } catch (error) {
      if (!(error instanceof KeyFileError && error.problem === 'exists')) throw error;
    }
  }
  const balance = entry.account.near ?? 0n;
  const publicKeys = keys.map((key) => key.getPublicKey());
  const outcome = await run.chain.createAccount(parent, { accountId: id, balance, publicKeys });
  run.report(`created  ${id}  ${near(balance)}  tx ${outcome.txHash}`);
  return first;
}

async function writeKey(run: Run, path: string, accountId: string, keyPair: KeyPair): Promise<void> {
  await writeKeyFile(path, accountId, keyPair);
  run.report(`wrote key file  ${path}`);
}

/** Step 3: deploys the pools contract with the configured token, signed by the pools account. */
async function deploy(run: Run, pools: AccountKey, code: Uint8Array): Promise<void> {
  const outcome = await run.chain.deployPools(pools, code);
  run.report(`deployed the pools contract  ${pools.accountId}  token ${run.config.token}  tx ${outcome.txHash}`);
}

/**
 * Step 5's top-ups, read in step 0: each account with a token amount that holds less is to receive
 * the difference. An account not created or not registered on the token yet holds none of it and
 * lacks its whole amount; its balance is not read, so that setup does not depend on what the token
 * answers for an account it does not know.
 */
async function tokenShortfalls(chain: SwarmChain, found: readonly Found[]): Promise<TokenTransfer[]> {
  const transfers: TokenTransfer[] = [];
  for (const { account, state, registered } of found) {
    if (account.tokens === null) continue;
    const balance = state === null || !registered ? 0n : await chain.ftBalanceOf(account.id);
    if (balance < account.tokens) transfers.push({ receiverId: account.id, amount: account.tokens - balance });
  }
  return transfers;
}

/**
 * Step 5: sends the top-ups from the funding account. Throws ShortfallError, and makes none of them,
 * unless the funding account covers them all.
 */
async function topUpTokens(run: Run, transfers: readonly TokenTransfer[], funding: AccountKey): Promise<void> {
  const { chain, config } = run;
  const needed = transfers.reduce((sum, transfer) => sum + transfer.amount, 0n);
  if (needed === 0n) return;
  const held = await chain.ftBalanceOf(config.funding);
  if (held < needed) {
    throw new ShortfallError(
      'token_shortfall',
      config.funding,
      needed - held,
      `the funding account ${config.funding} holds ${held} base units of the token ${config.token}, but the top-ups ` +
        `need ${needed}: send it ${needed - held} more, then run setup again`,
    );
  }
  for (const batch of batches(transfers)) {
    const outcome = await chain.ftTransfers(funding, batch);
    const sent = batch.map((transfer) => `${transfer.receiverId} +${transfer.amount}`).join(', ');
    run.report(`sent tokens  ${sent}  tx ${outcome.txHash}`);
  }
}

/**
 * Writes a zero total for the MCP server's buyer to its spend file, unless the file reads 0 already
 * (a missing file does). Replaces another account's total, left by an earlier QUORUM_MCP_ACCOUNT,
 * but passes on readSpendFile's error for a file that is not a spend file, which it never overwrites.
 */
async function clearSpendTotal(run: Run): Promise<void> {
  const { spendFile, mcpAccount } = run.config;
  try {
    if ((await readSpendFile(spendFile, mcpAccount)) === 0n) return;
  } catch (error) {
    if (!(error instanceof SpendFileError && error.problem === 'other_account')) throw error;
  }
  await writeSpendFile(spendFile, mcpAccount, 0n);
  run.report(`cleared the spend total of ${mcpAccount}  ${spendFile}`);
}

function signerOf(signers: ReadonlyMap<string, KeyPair>, accountId: string): AccountKey {
  const keyPair = signers.get(accountId);
  if (keyPair === undefined) throw new RangeError(`setup holds no key for ${accountId}`);
  return { accountId, keyPair };
}

/** `items` in consecutive batches of at most MAX_CALLS_PER_TRANSACTION. */
function batches<T>(items: readonly T[]): T[][] {
  const result: T[][] = [];
  for (let start = 0; start < items.length; start += MAX_CALLS_PER_TRANSACTION) {
    result.push(items.slice(start, start + MAX_CALLS_PER_TRANSACTION));
  }
  return result;
}

function near(yocto: bigint): string {
  return `${yoctoToNear(yocto)} NEAR`;
}
