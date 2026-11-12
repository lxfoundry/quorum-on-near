import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TESTNET_USDC } from '@quorum-on-near/buyer';
import { MAX_PAGE, ONE_YOCTO, parseAmount, type PoolView, type QuorumEvent, type SeatView } from '@quorum-on-near/protocol';
import { baseEncode, KeyPair, type PublicKey } from 'near-api-js';
import { isSubAccount } from '../src/accounts.ts';
import {
  assertBatchSize,
  STORAGE_PRICE_PER_BYTE,
  TransactionFailedError,
  type AccountKey,
  type AccountState,
  type BlockInfo,
  type MissingOutcome,
  type NewAccount,
  type ReadAt,
  type ReceiptOutcome,
  type SwarmChain,
  type TokenTransfer,
  type TransferCall,
  type TransferCallResult,
  type TxOutcome,
} from '../src/chain.ts';
import { loadSwarmConfig, type SwarmConfig } from '../src/config.ts';

export const PARENT = 'parent.testnet';
export const POOLS = `pools.${PARENT}`;
export const PROVIDER = `provider.${PARENT}`;
export const TOKEN = TESTNET_USDC;
/** The fake's final block time: well before the default pool deadline. */
export const NOW_MS = 1_799_999_000_000;
/** 1 NEAR in yoctoNEAR. */
export const NEAR = 10n ** 24n;
/** The fake token's registration deposit: 0.00125 NEAR, USDC's on testnet. */
export const REGISTRATION_DEPOSIT = 1_250_000_000_000_000_000_000n;
export const TERMS = '8×GPU × 24 h; 1 seat = 1 GPU-hour; prices at 1/10,000 scale';

/**
 * A folder under this module's own file. A file cannot hold a folder, so every read or write of a
 * path inside it fails (ENOTDIR or EEXIST) instead of touching a real key or spend file.
 */
const UNUSABLE_FOLDER = join(fileURLToPath(import.meta.url), 'unusable');

/**
 * The configuration for PARENT with every default, its key files and spend file under a folder that
 * cannot exist, so that only a test that passes its own temporary paths can touch files.
 */
export function testConfig(overrides: Partial<SwarmConfig> = {}): SwarmConfig {
  return {
    ...loadSwarmConfig({ QUORUM_PARENT_ACCOUNT: PARENT }),
    credentialsDir: UNUSABLE_FOLDER,
    spendFile: join(UNUSABLE_FOLDER, 'mcp-spend.json'),
    ...overrides,
  };
}

/** A pool as the contract's views return it; the defaults are a `fills` pool just opened. */
export function poolView(overrides: Partial<PoolView> = {}): PoolView {
  return {
    id: 0,
    seller: PROVIDER,
    seat_price: '180',
    target: 192,
    taken: 0,
    deadline_ms: NOW_MS + 600_000,
    bonus: '1728',
    max_seats_per_buyer: 24,
    terms: TERMS,
    status: 'open',
    bonus_per_seat: '0',
    refund_cursor: 0,
    dust_sent: false,
    buyer_count: 0,
    ...overrides,
  };
}

/** The log line the pools contract writes for an event. */
export function eventLog(event: QuorumEvent): string {
  return `EVENT_JSON:${JSON.stringify({ standard: 'quorum', version: '1.0.0', event: event.event, data: [event.data] })}`;
}

/**
 * An account of the fake: its NEAR, whether it holds a contract, the bytes of storage it uses (its
 * code's, once deployed; 0 otherwise, unless a test sets it), and its full-access public keys.
 */
export interface FakeAccount {
  balance: bigint;
  hasCode: boolean;
  storageUsage: bigint;
  keys: Set<string>;
}

/** What every recorded write has: its signer, the public key it signed with, and its transaction hash. */
interface WriteBase {
  signer: string;
  publicKey: string;
  txHash: string;
}

/** A write the fake received, with its arguments (public keys as strings). */
export type FakeWrite =
  | (WriteBase & { kind: 'createAccount'; accountId: string; balance: bigint; publicKeys: string[] })
  | (WriteBase & { kind: 'transferNear'; receiverId: string; amount: bigint })
  | (WriteBase & { kind: 'deployPools'; code: Uint8Array })
  | (WriteBase & { kind: 'storageDeposits'; accountIds: string[]; deposit: bigint })
  | (WriteBase & { kind: 'ftTransfers'; transfers: TokenTransfer[] })
  | (WriteBase & { kind: 'ftTransferCall'; receiverId: string; amount: bigint; msg: string });

/** A recorded `ft_transfer_call`. */
export type FakeTransferCall = Extract<FakeWrite, { kind: 'ftTransferCall' }>;

/**
 * A read of a token balance or a pools view the fake received: its arguments, and the block height
 * or the finality it asked for (null for the latest final block). The fake answers from its state
 * either way.
 */
export interface FakeRead {
  method: 'ftBalanceOf' | 'getPool' | 'listPools' | 'getSeats';
  args: Array<string | number>;
  atHeight: ReadAt | null;
}

/** `Omit` applied to each member of a union. */
type Without<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** The arguments of a write, before the fake records it. */
type WriteArgs = Without<FakeWrite, keyof WriteBase>;

/** The pools contract's limits on an `open` message (`target` and `terms`). */
const MAX_TARGET = 1000;
const MAX_TERMS_BYTES = 280;

function receipt(executorId: string, failed = false, logs: string[] = []): ReceiptOutcome {
  return { executorId, logs, failed, gasBurnt: 0n };
}

function isInteger(value: unknown, min: number, max: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
}

/** The fields of an `open` message, or null when `msg` is not one. */
function openFields(msg: string): Record<string, unknown> | null {
  let message: unknown;
  try {
    message = JSON.parse(msg);
  } catch {
    return null;
  }
  const open = (message as { open?: unknown } | null)?.open;
  return typeof open === 'object' && open !== null && !Array.isArray(open) ? (open as Record<string, unknown>) : null;
}

/**
 * An in-memory SwarmChain. Tests set its state directly (accounts, keys, code, NEAR, the token's
 * registrations and balances, pools and seats, the final block) and read back `writes`, every write
 * it received, in order, with its signer, and `reads`, the block each balance or view read asked for.
 *
 * Writes act as the chain would, so that a command run twice sees its first run's effects:
 * - a write must be signed with a key its signer's account holds (else it throws an Error, as the RPC
 *   refuses it), and the signer must cover what it attaches plus `txFee` plus what `heldWhileRunning`
 *   asks (else an Error too);
 * - checks the contracts would make fail the write with a TransactionFailedError and change nothing:
 *   creating an account that exists or is not a direct sub-account of the signer, a NEAR transfer to
 *   a missing account, deploying over code or to an account that cannot hold its storage with the
 *   code added (`storagePricePerByte`), a registration deposit below `storageBalanceMin`, a
 *   token transfer from or to an unregistered account, of 0, to the sender itself, or beyond the
 *   sender's balance (a batch fails whole);
 * - otherwise the write takes effect and charges its signer `txFee` plus what it attaches (1
 *   yoctoNEAR per token call, a registration deposit for each account not registered yet), which
 *   goes to the receiver when it is one of the fake's accounts;
 * - `ft_transfer_call` opens a pool, as the contract does, when it sends a valid `open` message to a
 *   deployed pools contract, and is refused by its receiver otherwise (the receiver's receipt fails
 *   and the token keeps nothing). `onTransferCall` replaces that behaviour.
 *
 * Every write's outcome, a failed one's included, can be looked up with txOutcome, as can those
 * given to addOutcome. The fake burns no gas, never derives a pool's status from the block time, and
 * returns views as they were stored. `failWrite` makes a chosen write fail.
 */
export class FakeChain implements SwarmChain {
  readonly token: string;
  readonly poolsContract: string;
  /** What chainId returns. */
  nodeChainId = 'testnet';
  accounts = new Map<string, FakeAccount>();
  /** What getToken returns once the pools contract holds code; deployPools sets it to `token`. */
  poolsToken: string;
  /** What registrationDeposit returns, and the least deposit storageDeposits accepts. */
  storageBalanceMin = REGISTRATION_DEPOSIT;
  registered = new Set<string>();
  tokenBalances = new Map<string, bigint>();
  pools = new Map<number, PoolView>();
  /** Each pool's `get_seats` rows, in commit order. */
  seats = new Map<number, SeatView[]>();
  block: BlockInfo = { height: 1_000n, timestampMs: NOW_MS };
  /** The yoctoNEAR each write that runs charges its signer, standing in for gas. */
  txFee = 0n;
  /**
   * The yoctoNEAR a write needs its signer to hold while it runs, beyond what it attaches and `txFee`,
   * and leaves it: standing in for the gas a transaction buys upfront and gets back once it is done.
   * Nothing by default.
   */
  heldWhileRunning: (write: FakeWrite) => bigint = () => 0n;
  /**
   * The yoctoNEAR a byte of storage locks: NEAR's `storage_amount_per_byte`, 10^19 (1 NEAR per 100
   * kB). A deploy fails unless its account, once it has paid `txFee`, holds what its storage locks
   * with the code added to it.
   */
  storagePricePerByte = STORAGE_PRICE_PER_BYTE;
  writes: FakeWrite[] = [];
  /** Every read of a token balance or a pools view, in order, with the block height it asked for. */
  reads: FakeRead[] = [];
  /**
   * When set, answers every `ft_transfer_call` that its signer may send, instead of the fake's own
   * behaviour, which then changes no state; its outcome can be looked up with txOutcome.
   */
  onTransferCall?: (call: FakeTransferCall) => TransferCallResult | Promise<TransferCallResult>;

  readonly #outcomes = new Map<string, TxOutcome>();
  /** Transactions txOutcome gives `not_final` for, by `<signer> <hash>`. */
  readonly #notFinal = new Set<string>();
  readonly #failures: Array<{ match: (write: FakeWrite) => boolean; error: Error | undefined }> = [];
  #transactions = 0;

  constructor(config: Pick<SwarmConfig, 'token' | 'poolsContract'> = { token: TOKEN, poolsContract: POOLS }) {
    this.token = config.token;
    this.poolsContract = config.poolsContract;
    this.poolsToken = config.token;
  }

  /** Adds (or replaces) an account; it holds nothing, uses no storage and has no key unless given. */
  addAccount(
    accountId: string,
    state: { balance?: bigint; hasCode?: boolean; storageUsage?: bigint; publicKeys?: PublicKey[] } = {},
  ): FakeAccount {
    const account: FakeAccount = {
      balance: state.balance ?? 0n,
      hasCode: state.hasCode ?? false,
      storageUsage: state.storageUsage ?? 0n,
      keys: new Set((state.publicKeys ?? []).map(String)),
    };
    this.accounts.set(accountId, account);
    return account;
  }

  /** Adds an account holding `balance` yoctoNEAR with a fresh full-access key, and returns that key. */
  addSigner(accountId: string, balance = 0n): AccountKey {
    const keyPair = KeyPair.fromRandom('ed25519');
    this.addAccount(accountId, { balance, publicKeys: [keyPair.getPublicKey()] });
    return { accountId, keyPair };
  }

  /** Registers the account on the token and sets its token balance. */
  register(accountId: string, balance = 0n): void {
    this.registered.add(accountId);
    this.tokenBalances.set(accountId, balance);
  }

  setPool(pool: PoolView): void {
    this.pools.set(pool.id, pool);
  }

  /** Makes txOutcome(outcome.txHash, signerId) return `outcome`. */
  addOutcome(signerId: string, outcome: TxOutcome): void {
    this.#outcomes.set(`${signerId} ${outcome.txHash}`, outcome);
  }

  /** Makes txOutcome(txHash, signerId) return `not_final`, as for a transaction the RPC does not see final within its wait. */
  markNotFinal(signerId: string, txHash: string): void {
    this.#notFinal.add(`${signerId} ${txHash}`);
  }

  /**
   * Makes the first later write for which `match` is true fail: it is recorded, changes nothing, and
   * throws `error`, by default a TransactionFailedError whose outcome has the receiver's receipt
   * failed. Each call arms one failure.
   */
  failWrite(match: (write: FakeWrite) => boolean, error?: Error): void {
    this.#failures.push({ match, error });
  }

  async chainId(): Promise<string> {
    return this.nodeChainId;
  }

  async account(accountId: string): Promise<AccountState | null> {
    const account = this.accounts.get(accountId);
    return account === undefined ? null : { balance: account.balance, hasCode: account.hasCode, storageUsage: account.storageUsage };
  }

  async getToken(): Promise<string> {
    if (this.accounts.get(this.poolsContract)?.hasCode !== true) {
      throw new Error(`FakeChain: ${this.poolsContract} holds no contract`);
    }
    return this.poolsToken;
  }

  async registrationDeposit(): Promise<bigint> {
    return this.storageBalanceMin;
  }

  async isRegistered(accountId: string): Promise<boolean> {
    return this.registered.has(accountId);
  }

  async ftBalanceOf(accountId: string, atHeight?: bigint): Promise<bigint> {
    this.#recordRead('ftBalanceOf', [accountId], atHeight);
    return this.tokenBalances.get(accountId) ?? 0n;
  }

  async getPool(poolId: number): Promise<PoolView | null> {
    this.#recordRead('getPool', [poolId], undefined);
    return this.pools.get(poolId) ?? null;
  }

  async listPools(from: number, limit: number, at?: ReadAt): Promise<PoolView[]> {
    this.#recordRead('listPools', [from, limit], at);
    return [...this.pools.values()]
      .sort((a, b) => a.id - b.id)
      .filter((pool) => pool.id >= from)
      .slice(0, Math.min(limit, MAX_PAGE));
  }

  async getSeats(poolId: number, from: number, limit: number, atHeight?: bigint): Promise<SeatView[]> {
    this.#recordRead('getSeats', [poolId, from, limit], atHeight);
    return (this.seats.get(poolId) ?? []).slice(from, from + Math.min(limit, MAX_PAGE));
  }

  #recordRead(method: FakeRead['method'], args: FakeRead['args'], at: ReadAt | undefined): void {
    this.reads.push({ method, args, atHeight: at ?? null });
  }

  async finalBlock(): Promise<BlockInfo> {
    return this.block;
  }

  async txOutcome(txHash: string, signerId: string): Promise<TxOutcome | MissingOutcome> {
    const key = `${signerId} ${txHash}`;
    if (this.#notFinal.has(key)) return 'not_final';
    return this.#outcomes.get(key) ?? 'unknown';
  }

  async createAccount(signer: AccountKey, account: NewAccount): Promise<TxOutcome> {
    const { accountId, balance } = account;
    const write = this.#send(signer, { kind: 'createAccount', accountId, balance, publicKeys: account.publicKeys.map(String) }, balance);
    if (this.accounts.has(accountId)) throw this.#failure(write, `${accountId} exists already`);
    if (!isSubAccount(accountId, signer.accountId)) {
      throw this.#failure(write, `${signer.accountId} cannot create ${accountId}, which is not its direct sub-account`);
    }
    this.addAccount(accountId, { publicKeys: account.publicKeys });
    this.#pay(write, accountId, balance);
    return this.#outcome(write, [receipt(accountId)]);
  }

  async transferNear(signer: AccountKey, receiverId: string, amount: bigint): Promise<TxOutcome> {
    const write = this.#send(signer, { kind: 'transferNear', receiverId, amount }, amount);
    if (!this.accounts.has(receiverId)) throw this.#failure(write, `${receiverId} does not exist`);
    this.#pay(write, receiverId, amount);
    return this.#outcome(write, [receipt(receiverId)]);
  }

  async deployPools(signer: AccountKey, code: Uint8Array): Promise<TxOutcome> {
    const write = this.#send(signer, { kind: 'deployPools', code }, 0n);
    const account = this.accounts.get(signer.accountId);
    if (account === undefined || account.hasCode) throw this.#failure(write, `${signer.accountId} holds a contract already`);
    const storage = account.storageUsage + BigInt(code.length);
    const locked = storage * this.storagePricePerByte;
    if (account.balance - this.txFee < locked) {
      throw this.#failure(write, `${signer.accountId} cannot hold the ${locked} yoctoNEAR its storage locks with the code`);
    }
    account.hasCode = true;
    account.storageUsage = storage;
    if (signer.accountId === this.poolsContract) this.poolsToken = this.token;
    this.#pay(write, signer.accountId, 0n);
    return this.#outcome(write, [receipt(signer.accountId)]);
  }

  async storageDeposits(signer: AccountKey, accountIds: readonly string[], deposit: bigint): Promise<TxOutcome> {
    assertBatchSize(accountIds.length);
    const attached = deposit * BigInt(accountIds.length);
    const write = this.#send(signer, { kind: 'storageDeposits', accountIds: [...accountIds], deposit }, attached);
    if (deposit < this.storageBalanceMin) throw this.#failure(write, `a deposit of ${deposit} is below the minimum`);
    let added = 0n;
    for (const id of accountIds) {
      if (this.registered.has(id)) continue;
      this.register(id);
      added += 1n;
    }
    this.#pay(write, this.token, deposit * added);
    return this.#outcome(write, [receipt(this.token)]);
  }

  async ftTransfers(signer: AccountKey, transfers: readonly TokenTransfer[]): Promise<TxOutcome> {
    assertBatchSize(transfers.length);
    const copies = transfers.map((transfer) => ({ ...transfer }));
    const write = this.#send(signer, { kind: 'ftTransfers', transfers: copies }, ONE_YOCTO * BigInt(transfers.length));
    const problem = this.#transferProblem(signer.accountId, transfers);
    if (problem !== null) throw this.#failure(write, problem);
    for (const { receiverId, amount } of transfers) this.#moveTokens(signer.accountId, receiverId, amount);
    this.#pay(write, this.token, ONE_YOCTO * BigInt(transfers.length));
    return this.#outcome(write, [receipt(this.token)]);
  }

  async ftTransferCall(signer: AccountKey, call: TransferCall): Promise<TransferCallResult> {
    const write = this.#send(signer, { kind: 'ftTransferCall' as const, ...call }, ONE_YOCTO);
    if (this.onTransferCall !== undefined) {
      const result = await this.onTransferCall(write);
      this.addOutcome(signer.accountId, result.outcome);
      return result;
    }
    const problem = this.#transferProblem(signer.accountId, [call]);
    if (problem !== null) throw this.#failure(write, problem);
    this.#pay(write, this.token, ONE_YOCTO);
    const pool = this.#openedPool(signer.accountId, call);
    if (pool === null) {
      return { outcome: this.#outcome(write, [receipt(this.token), receipt(call.receiverId, true), receipt(this.token)]), used: 0n };
    }
    this.#moveTokens(signer.accountId, call.receiverId, call.amount);
    this.setPool(pool);
    const { id, seller, seat_price, target, deadline_ms, bonus, terms } = pool;
    const opened = eventLog({ event: 'pool_opened', data: { pool_id: id, seller, seat_price, target, deadline_ms, bonus, terms } });
    const receipts = [receipt(this.token), receipt(call.receiverId, false, [opened]), receipt(this.token)];
    return { outcome: this.#outcome(write, receipts), used: call.amount };
  }

  /**
   * Records a write, then lets it through or throws: an armed failure first, then the RPC's checks on
   * its signer (account, key, NEAR to cover `attached` and the fee).
   */
  #send<A extends WriteArgs>(signer: AccountKey, args: A, attached: bigint): A & WriteBase {
    this.#transactions += 1;
    const txHash = baseEncode(createHash('sha256').update(`fake transaction ${this.#transactions}`).digest());
    const publicKey = signer.keyPair.getPublicKey().toString();
    const write = { ...args, signer: signer.accountId, publicKey, txHash };
    this.writes.push(write);
    const armed = this.#failures.findIndex((failure) => failure.match(write));
    if (armed !== -1) {
      const [failure] = this.#failures.splice(armed, 1);
      throw failure?.error ?? this.#failure(write, 'made to fail by failWrite');
    }
    const account = this.accounts.get(signer.accountId);
    if (account === undefined) throw new Error(`FakeChain: ${signer.accountId} does not exist`);
    if (!account.keys.has(publicKey)) throw new Error(`FakeChain: ${signer.accountId} has no access key ${publicKey}`);
    const needed = attached + this.txFee + this.heldWhileRunning(write);
    if (account.balance < needed) throw new Error(`FakeChain: ${signer.accountId} cannot pay ${needed} yoctoNEAR`);
    return write;
  }

  /** Charges the signer the fee and `attached`, which goes to `receiverId` if the fake holds it. */
  #pay(write: FakeWrite, receiverId: string, attached: bigint): void {
    const signer = this.accounts.get(write.signer);
    if (signer !== undefined) signer.balance -= attached + this.txFee;
    const receiver = this.accounts.get(receiverId);
    if (receiver !== undefined) receiver.balance += attached;
  }

  /** The write's outcome: its transaction at the signer, then `receipts`. Recorded for txOutcome. */
  #outcome(write: FakeWrite, receipts: ReceiptOutcome[]): TxOutcome {
    const outcome = { txHash: write.txHash, receipts: [receipt(write.signer), ...receipts] };
    this.addOutcome(write.signer, outcome);
    return outcome;
  }

  /** A TransactionFailedError for the write, whose outcome has its receiver's receipt failed. */
  #failure(write: FakeWrite, why: string): TransactionFailedError {
    const receiver = receiverOf(write, this.token);
    const outcome = this.#outcome(write, [receipt(receiver, true)]);
    return new TransactionFailedError(`FakeChain: ${write.kind} ${write.txHash} from ${write.signer} failed: ${why}`, outcome);
  }

  /** Why the token would refuse these transfers from `sender`, or null. */
  #transferProblem(sender: string, transfers: readonly TokenTransfer[]): string | null {
    if (!this.registered.has(sender)) return `${sender} is not registered on the token`;
    let total = 0n;
    for (const { receiverId, amount } of transfers) {
      if (!this.registered.has(receiverId)) return `${receiverId} is not registered on the token`;
      if (receiverId === sender) return `${sender} cannot send tokens to itself`;
      if (amount <= 0n) return 'a token transfer must be of a positive amount';
      total += amount;
    }
    const balance = this.tokenBalances.get(sender) ?? 0n;
    return total > balance ? `${sender} holds ${balance}, not ${total}` : null;
  }

  #moveTokens(from: string, to: string, amount: bigint): void {
    this.tokenBalances.set(from, (this.tokenBalances.get(from) ?? 0n) - amount);
    this.tokenBalances.set(to, (this.tokenBalances.get(to) ?? 0n) + amount);
  }

  /** The pool a call opens, as the pools contract checks its `open` message; null when it refuses. */
  #openedPool(seller: string, call: TransferCall): PoolView | null {
    if (call.receiverId !== this.poolsContract || this.accounts.get(call.receiverId)?.hasCode !== true) return null;
    const open = openFields(call.msg);
    if (open === null) return null;
    const { seat_price, target, deadline_ms, max_seats_per_buyer = null, terms } = open;
    const price = parseAmount(seat_price);
    if (price === null || price === 0n || !isInteger(target, 1, MAX_TARGET)) return null;
    if (!isInteger(deadline_ms, this.block.timestampMs + 1, Number.MAX_SAFE_INTEGER)) return null;
    if (typeof terms !== 'string' || Buffer.byteLength(terms) > MAX_TERMS_BYTES) return null;
    if (max_seats_per_buyer !== null && !isInteger(max_seats_per_buyer, 1, Number.MAX_SAFE_INTEGER)) return null;
    return poolView({
      id: Math.max(-1, ...this.pools.keys()) + 1,
      seller,
      seat_price: price.toString(),
      target,
      deadline_ms,
      bonus: call.amount.toString(),
      max_seats_per_buyer,
      terms,
    });
  }
}

/** The account a write's transaction is sent to. */
function receiverOf(write: FakeWrite, token: string): string {
  switch (write.kind) {
    case 'createAccount':
      return write.accountId;
    case 'transferNear':
      return write.receiverId;
    case 'deployPools':
      return write.signer;
    default:
      return token;
  }
}
