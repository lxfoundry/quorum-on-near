import { transportReason, type BuyerSettings } from '@quorum-on-near/buyer';
import { ONE_YOCTO, parseAmount, toTxOutcome, type PoolView, type SeatView } from '@quorum-on-near/protocol';
import {
  Account,
  actions,
  baseEncode,
  getTransactionLastResult,
  JsonRpcProvider,
  KeyPairSigner,
  type Action,
  type Provider,
  type SerializedReturnValue,
} from 'near-api-js';
import { AccountDoesNotExistError, InvalidNonceError, TransactionTimeoutError, UnknownTransactionError } from 'near-api-js/rpc-errors';
import {
  assertBatchSize,
  BATCHED_CALL_GAS,
  NonceTakenError,
  OutcomeUnknownError,
  TGAS,
  TransactionFailedError,
  type AccountKey,
  type AccountState,
  type BlockInfo,
  type NewAccount,
  type ReadAt,
  type SwarmChain,
  type TokenTransfer,
  type TransferCall,
  type TransferCallResult,
  type TxOutcome,
} from './chain.ts';

const FINAL = { finality: 'final' } as const;
const OPTIMISTIC = { finality: 'optimistic' } as const;
const NANOS_PER_MS = 1_000_000n;
/** Gas for the pools contract's `new`, called in its deploy transaction. */
const INIT_GAS = 30n * TGAS;
/** Gas for one `ft_transfer_call`: the token's transfer, the receiver's `ft_on_transfer`, then `ft_resolve_transfer`. */
const TRANSFER_CALL_GAS = 100n * TGAS;
/** The code hash of an account that holds no contract: 32 zero bytes, in base58. */
const NO_CODE_HASH = '11111111111111111111111111111111';

type TransactionResponse = Awaited<ReturnType<Account['signAndSendTransaction']>>;

export interface RpcSwarmChainOptions {
  /** Views, accounts, blocks and transaction lookups. */
  readProvider: Provider;
  /**
   * Writes, with the nonce and block reads near-api-js makes to build them, and txOutcome's wait for a
   * transaction to be final. Construct it with `retries: 1`: near-api-js counts attempts, so each
   * signed transaction is then posted once, and a wait that the RPC ends with a 408 is not repeated.
   */
  sendProvider: Provider;
  token: string;
  poolsContract: string;
}

/**
 * An RpcSwarmChain on `settings.rpcUrl`: its reads keep near-api-js's default retries, since they
 * change nothing; its writes, and its wait for a transaction to be final, go through a provider with
 * `retries: 1`, which posts each signed transaction once and asks for each wait once.
 */
export function createRpcSwarmChain(settings: Pick<BuyerSettings, 'rpcUrl' | 'token' | 'poolsContract'>): RpcSwarmChain {
  return new RpcSwarmChain({
    readProvider: new JsonRpcProvider({ url: settings.rpcUrl }),
    sendProvider: new JsonRpcProvider({ url: settings.rpcUrl }, { retries: 1 }),
    token: settings.token,
    poolsContract: settings.poolsContract,
  });
}

/**
 * SwarmChain over near-api-js's JSON-RPC provider. Reads are at final finality, or at the block
 * height a caller gives (`block_id` in the RPC's query), or, for `list_pools`, at optimistic finality
 * when asked. Each write is one transaction, signed by one near-api-js Account per key, which caches
 * the key's nonce, and sent once that key's previous write has settled, so a key never has two
 * transactions in flight. It waits until the transaction is FINAL, then checks every receipt of the
 * outcome: near-api-js's own check reads only the transaction's final status, which reports success
 * when a later receipt, such as a receiver's callback, failed.
 *
 * Every write but ftTransferCall goes through near-api-js's signAndSendTransaction, whose re-sign
 * the swarm relies on: on an InvalidNonce answer, which means the transaction did not run, it drops
 * the key's cached nonce and signs the transaction again with one read afresh. A key used by another
 * process after this one read its nonce, as the command line's child process does in the sandbox
 * suite before its in-process reset, is so recovered. ftTransferCall signs first, so that its hash is
 * known, and sends once.
 */
export class RpcSwarmChain implements SwarmChain {
  readonly #read: Provider;
  readonly #send: Provider;
  readonly #token: string;
  readonly #poolsContract: string;
  /** Per signing key: its Account, and its latest write, which the next one waits for. */
  readonly #signers = new Map<string, { account: Account; latest: Promise<unknown> }>();

  constructor(opts: RpcSwarmChainOptions) {
    this.#read = opts.readProvider;
    this.#send = opts.sendProvider;
    this.#token = opts.token;
    this.#poolsContract = opts.poolsContract;
  }

  async chainId(): Promise<string> {
    return (await this.#read.viewNodeStatus()).chain_id;
  }

  async account(accountId: string): Promise<AccountState | null> {
    try {
      const view = await this.#read.viewAccount({ accountId, blockQuery: FINAL });
      return { balance: view.amount, hasCode: view.code_hash !== NO_CODE_HASH, storageUsage: BigInt(view.storage_usage) };
    } catch (error) {
      if (error instanceof AccountDoesNotExistError) return null;
      throw error;
    }
  }

  async getToken(): Promise<string> {
    const token = await this.#view(this.#poolsContract, 'get_token', {});
    if (typeof token !== 'string') throw new TypeError(`get_token returned ${JSON.stringify(token)}`);
    return token;
  }

  async registrationDeposit(): Promise<bigint> {
    const bounds = await this.#view<{ min?: unknown }>(this.#token, 'storage_balance_bounds', {});
    const min = parseAmount(bounds?.min);
    if (min === null) throw new TypeError(`storage_balance_bounds returned ${JSON.stringify(bounds)}`);
    return min;
  }

  async isRegistered(accountId: string): Promise<boolean> {
    // An unregistered account's storage balance is JSON null, which near-api-js passes on as null.
    const balance = await this.#view(this.#token, 'storage_balance_of', { account_id: accountId });
    return balance !== undefined && balance !== null;
  }

  async ftBalanceOf(accountId: string, atHeight?: bigint): Promise<bigint> {
    const result = await this.#view(this.#token, 'ft_balance_of', { account_id: accountId }, atHeight);
    const balance = parseAmount(result);
    if (balance === null) throw new TypeError(`ft_balance_of returned ${JSON.stringify(result)}`);
    return balance;
  }

  async getPool(poolId: number): Promise<PoolView | null> {
    return (await this.#view<PoolView>(this.#poolsContract, 'get_pool', { pool_id: poolId })) ?? null;
  }

  async listPools(from: number, limit: number, at?: ReadAt): Promise<PoolView[]> {
    return (await this.#view<PoolView[]>(this.#poolsContract, 'list_pools', { from, limit }, at)) ?? [];
  }

  async getSeats(poolId: number, from: number, limit: number, atHeight?: bigint): Promise<SeatView[]> {
    const args = { pool_id: poolId, from, limit };
    return (await this.#view<SeatView[]>(this.#poolsContract, 'get_seats', args, atHeight)) ?? [];
  }

  async finalBlock(): Promise<BlockInfo> {
    const { header } = await this.#read.viewBlock(FINAL);
    return { height: BigInt(header.height), timestampMs: Number(BigInt(header.timestamp_nanosec) / NANOS_PER_MS) };
  }

  /**
   * Looks the transaction up first without waiting (`wait_until` NONE), which the RPC answers at once,
   * with UNKNOWN_TRANSACTION for a transaction it does not know, one older than its history included:
   * null then. A transaction it knows is converted at once when it is FINAL already, else waited for
   * at FINAL once, through the send provider; a wait that the RPC ends unanswered (an HTTP 408 or a
   * TIMEOUT_ERROR), or with UNKNOWN_TRANSACTION, is null too. Any other error is passed on.
   */
  async txOutcome(txHash: string, signerId: string): Promise<TxOutcome | null> {
    let status: Awaited<ReturnType<Provider['viewTransactionStatus']>>;
    try {
      status = await this.#read.viewTransactionStatus({ txHash, accountId: signerId, waitUntil: 'NONE' });
    } catch (error) {
      if (error instanceof UnknownTransactionError) return null;
      throw error;
    }
    if (status.final_execution_status === 'FINAL') return toTxOutcome(status);
    try {
      return toTxOutcome(await this.#send.viewTransactionStatus({ txHash, accountId: signerId, waitUntil: 'FINAL' }));
    } catch (error) {
      if (error instanceof UnknownTransactionError || timedOut(error)) return null;
      throw error;
    }
  }

  createAccount(signer: AccountKey, account: NewAccount): Promise<TxOutcome> {
    const keys = account.publicKeys.map((publicKey) => actions.addFullAccessKey(publicKey));
    return this.#write(signer, account.accountId, [actions.createAccount(), actions.transfer(account.balance), ...keys]);
  }

  transferNear(signer: AccountKey, receiverId: string, amount: bigint): Promise<TxOutcome> {
    return this.#write(signer, receiverId, [actions.transfer(amount)]);
  }

  deployPools(signer: AccountKey, code: Uint8Array): Promise<TxOutcome> {
    const init = actions.functionCall('new', { token: this.#token }, INIT_GAS, 0n);
    return this.#write(signer, signer.accountId, [actions.deployContract(code), init]);
  }

  async storageDeposits(signer: AccountKey, accountIds: readonly string[], deposit: bigint): Promise<TxOutcome> {
    assertBatchSize(accountIds.length);
    const calls = accountIds.map((accountId) =>
      actions.functionCall('storage_deposit', { account_id: accountId, registration_only: true }, BATCHED_CALL_GAS, deposit),
    );
    return this.#write(signer, this.#token, calls);
  }

  async ftTransfers(signer: AccountKey, transfers: readonly TokenTransfer[]): Promise<TxOutcome> {
    assertBatchSize(transfers.length);
    const calls = transfers.map(({ receiverId, amount }) =>
      actions.functionCall('ft_transfer', { receiver_id: receiverId, amount: amount.toString() }, BATCHED_CALL_GAS, ONE_YOCTO),
    );
    return this.#write(signer, this.#token, calls);
  }

  async ftTransferCall(signer: AccountKey, call: TransferCall): Promise<TransferCallResult> {
    const args = { receiver_id: call.receiverId, amount: call.amount.toString(), msg: call.msg };
    const action = actions.functionCall('ft_transfer_call', args, TRANSFER_CALL_GAS, ONE_YOCTO);
    const { response, outcome } = await this.#sendOnce(signer, this.#token, [action]);
    // The call's own status is ft_resolve_transfer's: a failure means the transfer itself failed.
    if (failureOf(response) !== null) throw failed(signer.accountId, this.#token, response, outcome);
    const result = getTransactionLastResult(response);
    const used = parseAmount(result);
    if (used === null) throw new TypeError(`ft_transfer_call returned ${JSON.stringify(result)}, not an amount`);
    return { outcome, used };
  }

  /** Submits the transaction and throws TransactionFailedError if any receipt of its outcome failed. */
  async #write(signer: AccountKey, receiverId: string, actionList: Action[]): Promise<TxOutcome> {
    const { response, outcome } = await this.#submit(signer, receiverId, actionList);
    if (outcome.receipts.some((receipt) => receipt.failed)) throw failed(signer.accountId, receiverId, response, outcome);
    return outcome;
  }

  /**
   * Signs and sends one transaction once the key's previous write has settled, and waits until it is
   * FINAL, through signAndSendTransaction and its re-sign on InvalidNonce. A request that timed out or
   * failed rejects OutcomeUnknownError, its hash unknown. The response's own status is left to the
   * caller.
   */
  async #submit(
    signer: AccountKey,
    receiverId: string,
    actionList: Action[],
  ): Promise<{ response: TransactionResponse; outcome: TxOutcome }> {
    const entry = this.#entry(signer);
    const sent = entry.latest.then(async () => {
      try {
        return await entry.account.signAndSendTransaction({ receiverId, actions: actionList, waitUntil: 'FINAL', throwOnFailure: false });
      } catch (error) {
        throw noResult(error, null, signer.accountId, receiverId);
      }
    });
    entry.latest = sent.catch(() => undefined);
    const response = await sent;
    return { response, outcome: toTxOutcome(response) };
  }

  /**
   * Signs one transaction, once the key's previous write has settled, with a nonce read for it alone
   * by a new Account, which then replaces the key's own, so that the key's next write is numbered
   * after it; then sends it once and waits until it is FINAL. It is never signed again: InvalidNonce
   * rejects NonceTakenError, and a request that timed out or failed OutcomeUnknownError, both naming
   * the transaction. Any other refusal is passed on as it is.
   */
  async #sendOnce(
    signer: AccountKey,
    receiverId: string,
    actionList: Action[],
  ): Promise<{ response: TransactionResponse; outcome: TxOutcome }> {
    const entry = this.#entry(signer);
    const sent = entry.latest.then(async () => {
      const keySigner = new KeyPairSigner(signer.keyPair);
      const account = new Account(signer.accountId, this.#send, keySigner);
      entry.account = account;
      const publicKey = signer.keyPair.getPublicKey();
      const transaction = await account.createTransaction({ receiverId, actions: actionList, publicKey });
      const { txHash: hash, signedTransaction } = await keySigner.signTransaction(transaction);
      const txHash = baseEncode(hash);
      try {
        return await this.#send.sendTransactionUntil(signedTransaction, 'FINAL');
      } catch (error) {
        if (error instanceof InvalidNonceError) {
          const message = `transaction ${txHash} from ${signer.accountId} to ${receiverId} was refused: another transaction of the key took its nonce after it was read`;
          throw new NonceTakenError(message, txHash, { cause: error });
        }
        throw noResult(error, txHash, signer.accountId, receiverId);
      }
    });
    entry.latest = sent.catch(() => undefined);
    const response = await sent;
    return { response, outcome: toTxOutcome(response) };
  }

  /** The key's Account and latest write, created on its first write. */
  #entry(signer: AccountKey): { account: Account; latest: Promise<unknown> } {
    const key = `${signer.accountId} ${signer.keyPair.getPublicKey().toString()}`;
    let entry = this.#signers.get(key);
    if (entry === undefined) {
      entry = { account: new Account(signer.accountId, this.#send, new KeyPairSigner(signer.keyPair)), latest: Promise.resolve() };
      this.#signers.set(key, entry);
    }
    return entry;
  }

  /**
   * A view call at final finality, or at `at` when given: the block of that height, or optimistic
   * finality. The result is the contract's JSON, unchecked. Throws RangeError, reading nothing, for a
   * height that is not a safe integer, since near-api-js sends a block height as a JSON number.
   */
  async #view<T extends SerializedReturnValue>(
    contractId: string,
    method: string,
    args: Record<string, unknown>,
    at?: ReadAt,
  ): Promise<T | undefined> {
    const blockQuery = at === undefined ? FINAL : at === 'optimistic' ? OPTIMISTIC : { blockId: blockHeight(at) };
    return this.#read.callFunction<T>({ contractId, method, args, blockQuery });
  }
}

/** `height` as the number near-api-js takes for a block id; RangeError unless it is a safe integer. */
function blockHeight(height: bigint): number {
  const value = Number(height);
  if (height < 0n || !Number.isSafeInteger(value)) throw new RangeError(`${height} is not a block height`);
  return value;
}

/**
 * Whether the RPC ended a wait without an answer: near-api-js's error for an HTTP 408, which carries
 * the status as its cause, or the TIMEOUT_ERROR of a JSON-RPC error body.
 */
function timedOut(error: unknown): boolean {
  return error instanceof TransactionTimeoutError || (error instanceof Error && error.cause === 408);
}

/**
 * Whether a request failed without an answer from the RPC on the transaction: an HTTP 5xx status,
 * which near-api-js gives as its error's cause, or a request that fetch could not make or finish (a
 * TypeError).
 */
function failedRequest(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return typeof error.cause === 'number' ? error.cause >= 500 : error instanceof TypeError;
}

/**
 * The error a write rejects with: an OutcomeUnknownError, `error` as its cause, when the request
 * timed out or failed, since the transaction (`txHash` when it is known) may have been sent; `error`
 * itself otherwise, a refusal of the RPC.
 */
function noResult(error: unknown, txHash: string | null, signerId: string, receiverId: string): unknown {
  const reason = timedOut(error) ? 'timeout' : failedRequest(error) ? transportReason(error) : null;
  if (reason === null) return error;
  const sent = txHash === null ? `a transaction from ${signerId} to ${receiverId} may have been sent` : `transaction ${txHash} from ${signerId} to ${receiverId} was sent`;
  return new OutcomeUnknownError(`${sent}, but the RPC gave no result (${reason}): it may still run`, txHash, reason, { cause: error });
}

/** The response's own failure, or null when it reports success. */
function failureOf(response: TransactionResponse): unknown {
  const { status } = response;
  return typeof status === 'object' && 'Failure' in status ? status.Failure : null;
}

/** A TransactionFailedError naming the transaction, the first failed receipt and the response's own failure. */
function failed(signerId: string, receiverId: string, response: TransactionResponse, outcome: TxOutcome): TransactionFailedError {
  const receipt = outcome.receipts.find((r) => r.failed);
  const failure = failureOf(response);
  const where = receipt === undefined ? '' : `: a receipt executed by ${receipt.executorId} failed`;
  const why = failure === null ? '' : `: ${JSON.stringify(failure)}`;
  return new TransactionFailedError(`transaction ${outcome.txHash} from ${signerId} to ${receiverId} failed${where}${why}`, outcome);
}
