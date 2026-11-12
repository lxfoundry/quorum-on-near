import { createHash } from 'node:crypto';
import { poolsEvents, type TxOutcome } from '@quorum-on-near/protocol';
import {
  baseEncode,
  decodeSignedTransaction,
  encodeTransaction,
  KeyPair,
  type Action,
  type Provider,
  type SignedTransaction,
} from 'near-api-js';
import {
  AccountDoesNotExistActionError,
  AccountDoesNotExistError,
  InternalRpcError,
  InvalidNonceError,
  InvalidTransactionError,
  RequestRoutedError,
  RpcRequestParseError,
  ShardCongestedError,
  TransactionTimeoutError,
  UnknownBlockError,
  UnknownTransactionError,
} from 'near-api-js/rpc-errors';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NonceTakenError, OutcomeUnknownError, TGAS, TransactionFailedError, type AccountKey } from '../src/chain.ts';
import { createRpcSwarmChain, RpcSwarmChain } from '../src/rpc-chain.ts';
import { eventLog, PARENT, POOLS, PROVIDER, TOKEN } from './fake-chain.ts';

const BUYER = `buyer-01.${PARENT}`;
const FINAL = { finality: 'final' };
const BLOCK_HASH = baseEncode(new Uint8Array(32).fill(7));
/** The code hash of an account without a contract: 32 zero bytes in base58. */
const NO_CODE = '11111111111111111111111111111111';

/** A transaction as the stub RPC received it. */
interface SentTx {
  hash: string;
  signerId: string;
  publicKey: string;
  nonce: bigint;
  receiverId: string;
  actions: Action[];
  waitUntil: string;
}

/** One receipt of a stubbed response. */
interface ReceiptSpec {
  executorId: string;
  status?: Record<string, unknown>;
  logs?: string[];
  gasBurnt?: number;
}

function outcomeEntry(id: string, executorId: string, status: Record<string, unknown>, logs: string[], gasBurnt: number) {
  return {
    id,
    block_hash: BLOCK_HASH,
    proof: [],
    outcome: { executor_id: executorId, logs, receipt_ids: [], gas_burnt: gasBurnt, tokens_burnt: '0', status },
  };
}

/** A `send_tx` response at FINAL: the transaction at its signer, then `receipts`, with `status` at the top. */
function finalResponse(tx: SentTx, receipts: ReceiptSpec[], status: Record<string, unknown> = { SuccessValue: '' }) {
  return {
    final_execution_status: 'FINAL',
    status,
    transaction: { hash: tx.hash, signer_id: tx.signerId, receiver_id: tx.receiverId, nonce: Number(tx.nonce) },
    transaction_outcome: outcomeEntry(tx.hash, tx.signerId, { SuccessReceiptId: `${tx.hash}-0` }, [], 2_428_000_000_000),
    receipts_outcome: receipts.map((r, i) =>
      outcomeEntry(`${tx.hash}-${i}`, r.executorId, r.status ?? { SuccessValue: '' }, r.logs ?? [], r.gasBurnt ?? 1_000_000_000_000),
    ),
  };
}

/** The base64 of a JSON value, as a SuccessValue holds a function's result. */
const successValue = (value: unknown) => ({ SuccessValue: Buffer.from(JSON.stringify(value)).toString('base64') });

/** A contract panic, as a receipt's or a transaction's status reports it. */
const PANIC = { Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: 'Smart contract panicked: no' } } } } };

/**
 * A scripted RPC node: reads through `readProvider`, which has no send method, and sends (with the
 * nonce and block reads near-api-js makes for them) through `sendProvider`.
 */
class FakeRpc {
  chainNonce = 40n;
  accessKeyReads = 0;
  /** When set, the key's nonce read throws it: a read that fails before anything is sent. */
  accessKeyError: unknown = undefined;
  sent: SentTx[] = [];
  reads: Array<[method: string, params: unknown]> = [];
  /** The send's response; by default the transaction and one receipt at its receiver succeed. */
  onSend: (tx: SentTx) => Promise<unknown> = async (tx) => finalResponse(tx, [{ executorId: tx.receiverId }]);
  /** What a read answers, by provider method; a function is called, and may throw. */
  answers: Record<string, unknown> = {};

  /** Records a read and gives what `answers` holds for its method. */
  async answer(method: string, params: unknown): Promise<unknown> {
    this.reads.push([method, params]);
    const value = this.answers[method];
    return typeof value === 'function' ? (value as () => unknown)() : value;
  }

  readProvider(): Provider {
    const answer = (method: string, params: unknown): Promise<unknown> => this.answer(method, params);
    const read = {
      viewNodeStatus: () => answer('viewNodeStatus', undefined),
      viewAccount: (params: unknown) => answer('viewAccount', params),
      callFunction: (params: unknown) => answer('callFunction', params),
      viewBlock: (params: unknown) => answer('viewBlock', params),
      viewTransactionStatus: (params: unknown) => answer('viewTransactionStatus', params),
    };
    return read as unknown as Provider;
  }

  /** Sends, and the wait for a transaction to be final, which is answered as `send.viewTransactionStatus`. */
  sendProvider(): Provider {
    const send = {
      viewTransactionStatus: (params: unknown) => this.answer('send.viewTransactionStatus', params),
      viewAccessKey: async () => {
        this.accessKeyReads += 1;
        if (this.accessKeyError !== undefined) throw this.accessKeyError;
        return { nonce: this.chainNonce, permission: 'FullAccess', block_height: 1_000, block_hash: BLOCK_HASH };
      },
      viewBlock: async () => ({ header: { height: 1_000, hash: BLOCK_HASH } }),
      sendTransactionUntil: async (signed: SignedTransaction, waitUntil: string) => {
        const { transaction } = signed;
        const tx: SentTx = {
          hash: baseEncode(createHash('sha256').update(encodeTransaction(transaction)).digest()),
          signerId: transaction.signerId,
          publicKey: transaction.publicKey.toString(),
          nonce: transaction.nonce,
          receiverId: transaction.receiverId,
          actions: transaction.actions,
          waitUntil,
        };
        this.sent.push(tx);
        return this.onSend(tx);
      },
    };
    return send as unknown as Provider;
  }
}

function setup() {
  const rpc = new FakeRpc();
  const chain = new RpcSwarmChain({
    readProvider: rpc.readProvider(),
    sendProvider: rpc.sendProvider(),
    token: TOKEN,
    poolsContract: POOLS,
  });
  return { rpc, chain };
}

const signer = (accountId: string): AccountKey => ({ accountId, keyPair: KeyPair.fromRandom('ed25519') });

/** An action as a plain value, so that a test can compare whole action lists. */
function plain(action: Action): unknown {
  if (action.createAccount) return 'createAccount';
  if (action.transfer) return { transfer: action.transfer.deposit };
  if (action.addKey) {
    return { addKey: action.addKey.publicKey.toString(), fullAccess: action.addKey.accessKey.permission.fullAccess !== undefined };
  }
  if (action.deployContract) return { deployContract: [...action.deployContract.code] };
  if (action.functionCall) {
    const { methodName, args, gas, deposit } = action.functionCall;
    return { call: methodName, args: JSON.parse(new TextDecoder().decode(Uint8Array.from(args))), gas, deposit };
  }
  throw new Error(`unexpected action ${action.enum}`);
}

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Lets every pending promise callback and I/O callback run. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('RpcSwarmChain views', () => {
  const views: Array<{
    name: string;
    read: (chain: RpcSwarmChain) => Promise<unknown>;
    answer: unknown;
    contractId: string;
    method: string;
    args: Record<string, unknown>;
  }> = [
    { name: 'getToken', read: (c) => c.getToken(), answer: TOKEN, contractId: POOLS, method: 'get_token', args: {} },
    {
      name: 'registrationDeposit',
      read: (c) => c.registrationDeposit(),
      answer: { min: '1', max: '1' },
      contractId: TOKEN,
      method: 'storage_balance_bounds',
      args: {},
    },
    {
      name: 'isRegistered',
      read: (c) => c.isRegistered(BUYER),
      answer: null,
      contractId: TOKEN,
      method: 'storage_balance_of',
      args: { account_id: BUYER },
    },
    {
      name: 'ftBalanceOf',
      read: (c) => c.ftBalanceOf(BUYER),
      answer: '0',
      contractId: TOKEN,
      method: 'ft_balance_of',
      args: { account_id: BUYER },
    },
    { name: 'getPool', read: (c) => c.getPool(7), answer: null, contractId: POOLS, method: 'get_pool', args: { pool_id: 7 } },
    {
      name: 'listPools',
      read: (c) => c.listPools(3, 100),
      answer: [],
      contractId: POOLS,
      method: 'list_pools',
      args: { from: 3, limit: 100 },
    },
    {
      name: 'getSeats',
      read: (c) => c.getSeats(7, 100, 100),
      answer: [],
      contractId: POOLS,
      method: 'get_seats',
      args: { pool_id: 7, from: 100, limit: 100 },
    },
  ];

  for (const { name, read, answer, contractId, method, args } of views) {
    it(`${name} calls ${method} on ${contractId === POOLS ? 'the pools contract' : 'the token'} at final finality`, async () => {
      const { rpc, chain } = setup();
      rpc.answers.callFunction = answer;
      await read(chain);
      expect(rpc.reads).toEqual([['callFunction', { contractId, method, args, blockQuery: FINAL }]]);
    });
  }

  it('reads the token balance, list_pools and get_seats at a block height when given one, instead of final finality', async () => {
    const { rpc, chain } = setup();
    const at = { blockQuery: { blockId: 245_000_100 } };
    rpc.answers.callFunction = '5';
    expect(await chain.ftBalanceOf(BUYER, 245_000_100n)).toBe(5n);
    rpc.answers.callFunction = null;
    await chain.listPools(0, 100, 245_000_100n);
    await chain.getSeats(7, 0, 100, 245_000_100n);
    expect(rpc.reads).toEqual([
      ['callFunction', { contractId: TOKEN, method: 'ft_balance_of', args: { account_id: BUYER }, ...at }],
      ['callFunction', { contractId: POOLS, method: 'list_pools', args: { from: 0, limit: 100 }, ...at }],
      ['callFunction', { contractId: POOLS, method: 'get_seats', args: { pool_id: 7, from: 0, limit: 100 }, ...at }],
    ]);
  });

  it('reads list_pools at optimistic finality when asked to', async () => {
    const { rpc, chain } = setup();
    rpc.answers.callFunction = [];
    await chain.listPools(0, 100, 'optimistic');
    expect(rpc.reads).toEqual([
      ['callFunction', { contractId: POOLS, method: 'list_pools', args: { from: 0, limit: 100 }, blockQuery: { finality: 'optimistic' } }],
    ]);
  });

  it('reads get_pool at final finality only: it takes no block height', async () => {
    const { rpc, chain } = setup();
    rpc.answers.callFunction = null;
    // @ts-expect-error getPool takes no block height
    await chain.getPool(7, 245_000_100n);
    expect(rpc.reads).toEqual([['callFunction', { contractId: POOLS, method: 'get_pool', args: { pool_id: 7 }, blockQuery: FINAL }]]);
  });

  it('refuses a block height above what a JSON number holds exactly, reading nothing', async () => {
    const { rpc, chain } = setup();
    await expect(chain.ftBalanceOf(BUYER, 2n ** 53n)).rejects.toThrow(RangeError);
    expect(rpc.reads).toEqual([]);
  });

  it('getToken refuses an answer that is not an account id string', async () => {
    const { rpc, chain } = setup();
    rpc.answers.callFunction = { token: TOKEN };
    await expect(chain.getToken()).rejects.toThrow(TypeError);
  });

  it('registrationDeposit returns the minimum of the bounds', async () => {
    const { rpc, chain } = setup();
    rpc.answers.callFunction = { min: '1250000000000000000000', max: '1250000000000000000000' };
    expect(await chain.registrationDeposit()).toBe(1_250_000_000_000_000_000_000n);
  });

  it.each([[{ min: 1250 }], [{}], ['1250'], [undefined]])('registrationDeposit refuses the bounds %j', async (answer) => {
    const { rpc, chain } = setup();
    rpc.answers.callFunction = answer;
    await expect(chain.registrationDeposit()).rejects.toThrow(TypeError);
  });

  it.each([
    [null, false],
    [undefined, false],
    [{ total: '1250000000000000000000', available: '0' }, true],
  ])('isRegistered reads the storage balance %j as %s', async (answer, registered) => {
    const { rpc, chain } = setup();
    rpc.answers.callFunction = answer;
    expect(await chain.isRegistered(BUYER)).toBe(registered);
  });

  it('ftBalanceOf returns the balance as a bigint, and refuses one that is not a decimal string', async () => {
    const { rpc, chain } = setup();
    rpc.answers.callFunction = '10000';
    expect(await chain.ftBalanceOf(BUYER)).toBe(10_000n);
    rpc.answers.callFunction = 10_000;
    await expect(chain.ftBalanceOf(BUYER)).rejects.toThrow(TypeError);
  });

  it('getPool returns null for a pool the contract does not know', async () => {
    const { rpc, chain } = setup();
    rpc.answers.callFunction = null;
    expect(await chain.getPool(9)).toBeNull();
  });

  it('listPools and getSeats return the rows of their views', async () => {
    const { rpc, chain } = setup();
    const seats = [{ buyer: BUYER, seats: 2, state: 'committed' }];
    rpc.answers.callFunction = seats;
    expect(await chain.getSeats(7, 0, 100)).toEqual(seats);
    rpc.answers.callFunction = [{ id: 3 }];
    expect(await chain.listPools(3, 100)).toEqual([{ id: 3 }]);
  });
});

describe('RpcSwarmChain reads', () => {
  it('chainId reads the node status', async () => {
    const { rpc, chain } = setup();
    rpc.answers.viewNodeStatus = { chain_id: 'testnet', version: {} };
    expect(await chain.chainId()).toBe('testnet');
  });

  it('account reads the account at final finality, with its liquid balance, whether it holds code and its storage', async () => {
    const { rpc, chain } = setup();
    rpc.answers.viewAccount = { amount: 5n, locked: 0n, code_hash: NO_CODE, storage_usage: 182 };
    expect(await chain.account(BUYER)).toEqual({ balance: 5n, hasCode: false, storageUsage: 182n });
    expect(rpc.reads).toEqual([['viewAccount', { accountId: BUYER, blockQuery: FINAL }]]);
    rpc.answers.viewAccount = { amount: 7n, locked: 0n, code_hash: 'E8jZ1giWcVrps8PcV75ATauu6gFRkcwjNtKp7NKmipZG', storage_usage: 204_022 };
    expect(await chain.account(POOLS)).toEqual({ balance: 7n, hasCode: true, storageUsage: 204_022n });
  });

  it('account returns null for an account that does not exist, and passes on any other error', async () => {
    const { rpc, chain } = setup();
    rpc.answers.viewAccount = () => {
      throw new AccountDoesNotExistError(BUYER, BLOCK_HASH, 1_000);
    };
    expect(await chain.account(BUYER)).toBeNull();
    rpc.answers.viewAccount = () => {
      throw new UnknownBlockError();
    };
    await expect(chain.account(BUYER)).rejects.toBeInstanceOf(UnknownBlockError);
  });

  it('finalBlock reads the latest final block, its timestamp in milliseconds', async () => {
    const { rpc, chain } = setup();
    rpc.answers.viewBlock = { header: { height: 245_000_100, hash: BLOCK_HASH, timestamp_nanosec: '1799999000123999999' } };
    expect(await chain.finalBlock()).toEqual({ height: 245_000_100n, timestampMs: 1_799_999_000_123 });
    expect(rpc.reads).toEqual([['viewBlock', FINAL]]);
  });

  const relayed: SentTx = { hash: 'Tx1', signerId: 'relay.testnet', publicKey: '', nonce: 1n, receiverId: BUYER, actions: [], waitUntil: '' };
  const relayedOutcome: TxOutcome = {
    txHash: 'Tx1',
    receipts: [
      { executorId: 'relay.testnet', logs: [], failed: false, gasBurnt: 2_428_000_000_000n },
      { executorId: BUYER, logs: ['hello'], failed: false, gasBurnt: 3_000_000_000_000n },
    ],
  };
  const lookup = (waitUntil: string) => ({ txHash: 'Tx1', accountId: 'relay.testnet', waitUntil });

  it('txOutcome looks the transaction up without waiting, and converts it when it is final already', async () => {
    const { rpc, chain } = setup();
    rpc.answers.viewTransactionStatus = finalResponse(relayed, [{ executorId: BUYER, gasBurnt: 3_000_000_000_000, logs: ['hello'] }]);
    expect(await chain.txOutcome('Tx1', 'relay.testnet')).toEqual<TxOutcome>(relayedOutcome);
    expect(rpc.reads).toEqual([['viewTransactionStatus', lookup('NONE')]]);
  });

  it('txOutcome waits for a transaction the RPC knows to be final, through the provider that sends each request once', async () => {
    const { rpc, chain } = setup();
    rpc.answers.viewTransactionStatus = { final_execution_status: 'EXECUTED_OPTIMISTIC' };
    rpc.answers['send.viewTransactionStatus'] = finalResponse(relayed, [{ executorId: BUYER, gasBurnt: 3_000_000_000_000, logs: ['hello'] }]);
    expect(await chain.txOutcome('Tx1', 'relay.testnet')).toEqual<TxOutcome>(relayedOutcome);
    expect(rpc.reads).toEqual([
      ['viewTransactionStatus', lookup('NONE')],
      ['send.viewTransactionStatus', lookup('FINAL')],
    ]);
  });

  it("txOutcome is 'unknown' at once for a transaction the RPC does not know, such as one older than its history", async () => {
    const { rpc, chain } = setup();
    rpc.answers.viewTransactionStatus = () => {
      throw new UnknownTransactionError('Tx1');
    };
    expect(await chain.txOutcome('Tx1', 'relay.testnet')).toBe('unknown');
    expect(rpc.reads).toEqual([['viewTransactionStatus', lookup('NONE')]]);
  });

  it.each([
    ['a 408', 'not_final', () => new Error('Timeout error', { cause: 408 })],
    ['TIMEOUT_ERROR', 'not_final', () => new TransactionTimeoutError()],
    ['UNKNOWN_TRANSACTION', 'unknown', () => new UnknownTransactionError('Tx1')],
  ])('txOutcome tells why it has no outcome when the wait for the transaction to be final ends with %s: %s', async (_, why, error) => {
    const { rpc, chain } = setup();
    rpc.answers.viewTransactionStatus = { final_execution_status: 'INCLUDED' };
    rpc.answers['send.viewTransactionStatus'] = () => {
      throw error();
    };
    expect(await chain.txOutcome('Tx1', 'relay.testnet')).toBe(why);
  });

  it('txOutcome passes on any other error', async () => {
    const { rpc, chain } = setup();
    rpc.answers.viewTransactionStatus = () => {
      throw new UnknownBlockError();
    };
    await expect(chain.txOutcome('Tx1', 'relay.testnet')).rejects.toBeInstanceOf(UnknownBlockError);
    rpc.answers.viewTransactionStatus = { final_execution_status: 'INCLUDED' };
    rpc.answers['send.viewTransactionStatus'] = () => {
      throw new Error('Bad Gateway', { cause: 502 });
    };
    await expect(chain.txOutcome('Tx1', 'relay.testnet')).rejects.toThrow('Bad Gateway');
  });
});

describe('RpcSwarmChain writes', () => {
  it('creates a sub-account with its balance and every key as a full-access key, waiting until final', async () => {
    const { rpc, chain } = setup();
    const parent = signer(PARENT);
    const keys = [KeyPair.fromRandom('ed25519').getPublicKey(), KeyPair.fromRandom('ed25519').getPublicKey()];
    await chain.createAccount(parent, { accountId: 'relay.parent.testnet', balance: 3n, publicKeys: keys });
    const [tx] = rpc.sent;
    expect(tx).toMatchObject({
      signerId: PARENT,
      publicKey: parent.keyPair.getPublicKey().toString(),
      receiverId: 'relay.parent.testnet',
      waitUntil: 'FINAL',
    });
    expect(tx?.actions.map(plain)).toEqual([
      'createAccount',
      { transfer: 3n },
      { addKey: keys[0]?.toString(), fullAccess: true },
      { addKey: keys[1]?.toString(), fullAccess: true },
    ]);
  });

  it('transfers NEAR', async () => {
    const { rpc, chain } = setup();
    await chain.transferNear(signer(PARENT), BUYER, 50_000_000_000_000_000_000_000n);
    expect(rpc.sent[0]?.receiverId).toBe(BUYER);
    expect(rpc.sent[0]?.actions.map(plain)).toEqual([{ transfer: 50_000_000_000_000_000_000_000n }]);
  });

  it("deploys the pools contract to the signer's own account and initialises it with the token in the same transaction", async () => {
    const { rpc, chain } = setup();
    await chain.deployPools(signer('escrow.testnet'), new Uint8Array([0, 97, 115, 109]));
    expect(rpc.sent[0]).toMatchObject({ signerId: 'escrow.testnet', receiverId: 'escrow.testnet' });
    expect(rpc.sent[0]?.actions.map(plain)).toEqual([
      { deployContract: [0, 97, 115, 109] },
      { call: 'new', args: { token: TOKEN }, gas: 30n * TGAS, deposit: 0n },
    ]);
  });

  it('registers accounts with one storage_deposit each, registration only, 20 Tgas each', async () => {
    const { rpc, chain } = setup();
    await chain.storageDeposits(signer(PARENT), [BUYER, POOLS], 1_250n);
    expect(rpc.sent[0]?.receiverId).toBe(TOKEN);
    expect(rpc.sent[0]?.actions.map(plain)).toEqual([
      { call: 'storage_deposit', args: { account_id: BUYER, registration_only: true }, gas: 20n * TGAS, deposit: 1_250n },
      { call: 'storage_deposit', args: { account_id: POOLS, registration_only: true }, gas: 20n * TGAS, deposit: 1_250n },
    ]);
  });

  it('sends a batch of ft_transfer calls with 1 yoctoNEAR and 20 Tgas each', async () => {
    const { rpc, chain } = setup();
    const funding = signer(`funding.${PARENT}`);
    await chain.ftTransfers(funding, [
      { receiverId: BUYER, amount: 8_000n },
      { receiverId: PROVIDER, amount: 10_000n },
    ]);
    expect(rpc.sent[0]).toMatchObject({ signerId: funding.accountId, receiverId: TOKEN });
    expect(rpc.sent[0]?.actions.map(plain)).toEqual([
      { call: 'ft_transfer', args: { receiver_id: BUYER, amount: '8000' }, gas: 20n * TGAS, deposit: 1n },
      { call: 'ft_transfer', args: { receiver_id: PROVIDER, amount: '10000' }, gas: 20n * TGAS, deposit: 1n },
    ]);
  });

  it('sends one ft_transfer_call with 1 yoctoNEAR and 100 Tgas', async () => {
    const { rpc, chain } = setup();
    rpc.onSend = async (tx) => finalResponse(tx, [{ executorId: TOKEN }], successValue('1728'));
    await chain.ftTransferCall(signer(PROVIDER), { receiverId: POOLS, amount: 1_728n, msg: '{"open":{}}' });
    expect(rpc.sent[0]).toMatchObject({ signerId: PROVIDER, receiverId: TOKEN });
    expect(rpc.sent[0]?.actions.map(plain)).toEqual([
      { call: 'ft_transfer_call', args: { receiver_id: POOLS, amount: '1728', msg: '{"open":{}}' }, gas: 100n * TGAS, deposit: 1n },
    ]);
  });

  it.each([0, 11])('refuses a batch of %i calls before signing anything', async (size) => {
    const { rpc, chain } = setup();
    const ids = Array.from({ length: size }, (_, i) => `b${i}.testnet`);
    await expect(chain.storageDeposits(signer(PARENT), ids, 1n)).rejects.toBeInstanceOf(RangeError);
    const transfers = ids.map((receiverId) => ({ receiverId, amount: 1n }));
    await expect(chain.ftTransfers(signer(PARENT), transfers)).rejects.toBeInstanceOf(RangeError);
    expect(rpc.sent).toEqual([]);
    expect(rpc.accessKeyReads).toBe(0);
  });

  it('sends a batch of 10 calls in one transaction', async () => {
    const { rpc, chain } = setup();
    const ids = Array.from({ length: 10 }, (_, i) => `b${i}.testnet`);
    await chain.storageDeposits(signer(PARENT), ids, 1n);
    expect(rpc.sent).toHaveLength(1);
    expect(rpc.sent[0]?.actions).toHaveLength(10);
  });

  it("returns the write's outcome, converted from the final response", async () => {
    const { rpc, chain } = setup();
    rpc.onSend = async (tx) => finalResponse(tx, [{ executorId: TOKEN, gasBurnt: 4_000_000_000_000, logs: ['EVENT_JSON:{}'] }, { executorId: PARENT, gasBurnt: 0 }]);
    const outcome = await chain.ftTransfers(signer(PARENT), [{ receiverId: BUYER, amount: 1n }]);
    expect(outcome).toEqual<TxOutcome>({
      txHash: rpc.sent[0]?.hash ?? '',
      receipts: [
        { executorId: PARENT, logs: [], failed: false, gasBurnt: 2_428_000_000_000n },
        { executorId: TOKEN, logs: ['EVENT_JSON:{}'], failed: false, gasBurnt: 4_000_000_000_000n },
        { executorId: PARENT, logs: [], failed: false, gasBurnt: 0n },
      ],
    });
  });
});

describe('RpcSwarmChain failure detection', () => {
  it('throws TransactionFailedError when the transaction failed, naming it and its failure', async () => {
    const { rpc, chain } = setup();
    rpc.onSend = async (tx) => finalResponse(tx, [{ executorId: TOKEN, status: PANIC }], PANIC);
    const error = await chain.ftTransfers(signer(PARENT), [{ receiverId: BUYER, amount: 1n }]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TransactionFailedError);
    const { message, outcome } = error as TransactionFailedError;
    expect(outcome.receipts.map((receipt) => receipt.failed)).toEqual([false, true]);
    expect(message).toContain(rpc.sent[0]?.hash);
    expect(message).toContain(`from ${PARENT} to ${TOKEN}`);
    expect(message).toContain('Smart contract panicked: no');
  });

  it('throws TransactionFailedError when a later receipt failed, though the transaction reports success', async () => {
    const { rpc, chain } = setup();
    rpc.onSend = async (tx) => finalResponse(tx, [{ executorId: BUYER }, { executorId: POOLS, status: PANIC }]);
    const error = await chain.transferNear(signer(PARENT), BUYER, 1n).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TransactionFailedError);
    expect((error as TransactionFailedError).message).toContain(`a receipt executed by ${POOLS} failed`);
  });

  it.each([
    ['a TIMEOUT_ERROR', () => new TransactionTimeoutError(), 'timeout'],
    ['a 408', () => new Error('Timeout error', { cause: 408 }), 'timeout'],
    ['a 503', () => new Error('http://rpc.invalid unavailable', { cause: 503 }), 'HTTP 503'],
    ['a failed request', () => new TypeError('fetch failed', { cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }) }), 'ECONNRESET'],
    ['a routed request', () => new RequestRoutedError('RoutedTx1'), 'error'],
    ['an internal error', () => new InternalRpcError('boom'), 'error'],
    ['an answer that is not JSON', () => new SyntaxError('Unexpected token \'<\''), 'error'],
    ['an action error', () => new AccountDoesNotExistActionError(BUYER, 0, 'Tx1', BLOCK_HASH), 'error'],
  ])('rejects OutcomeUnknownError naming the transaction, its cause kept, when a send gets %s instead of a result', async (_, error, reason) => {
    const { rpc, chain } = setup();
    const thrown = error();
    rpc.onSend = async () => {
      throw thrown;
    };
    const rejected = await chain.transferNear(signer(PARENT), BUYER, 1n).catch((e: unknown) => e);
    expect(rejected).toBeInstanceOf(OutcomeUnknownError);
    expect(rpc.sent).toHaveLength(1);
    const hash = rpc.sent[0]?.hash;
    expect(rejected).toMatchObject({ txHash: hash, reason, cause: thrown });
    expect((rejected as Error).message).toBe(
      `transaction ${hash} from ${PARENT} to ${BUYER} was sent, but the RPC gave no result (${reason}): it may still run`,
    );
  });

  it.each([
    ['an invalid transaction', () => new InvalidTransactionError()],
    ['a congested shard', () => new ShardCongestedError(1, 0, 'Tx1', BLOCK_HASH)],
    ['a request that does not validate', () => new RpcRequestParseError('bad')],
    ['an HTTP 429', () => new Error('slow down', { cause: 429 })],
  ])('passes on, as it is, a refusal that shows the transaction did not run: %s', async (_, error) => {
    const { rpc, chain } = setup();
    const refusal = error();
    rpc.onSend = async () => {
      throw refusal;
    };
    await expect(chain.transferNear(signer(PARENT), BUYER, 1n)).rejects.toBe(refusal);
    expect(rpc.sent).toHaveLength(1);
  });

  it.each(['INCLUDED', 'EXECUTED_OPTIMISTIC'])(
    'rejects OutcomeUnknownError naming the transaction for a response that is %s, not final',
    async (status) => {
      const { rpc, chain } = setup();
      rpc.onSend = async (tx) => ({ ...finalResponse(tx, [{ executorId: BUYER }]), final_execution_status: status });
      const rejected = await chain.transferNear(signer(PARENT), BUYER, 1n).catch((e: unknown) => e);
      expect(rejected).toBeInstanceOf(OutcomeUnknownError);
      expect(rejected).toMatchObject({ txHash: rpc.sent[0]?.hash, reason: 'not final' });
    },
  );

  it('rejects OutcomeUnknownError naming the transaction for a final response that cannot be read', async () => {
    const { rpc, chain } = setup();
    rpc.onSend = async (tx) => ({ ...finalResponse(tx, []), receipts_outcome: 'none' });
    const rejected = await chain.transferNear(signer(PARENT), BUYER, 1n).catch((e: unknown) => e);
    expect(rejected).toBeInstanceOf(OutcomeUnknownError);
    expect(rejected).toMatchObject({ txHash: rpc.sent[0]?.hash, reason: 'unreadable result' });
    expect((rejected as Error).message).toContain(`transaction ${rpc.sent[0]?.hash} from ${PARENT} to ${BUYER} is final`);
  });

  it('passes on, as it is, a read that failed before anything was sent', async () => {
    const { rpc, chain } = setup();
    const failure = new Error('http://rpc.invalid unavailable', { cause: 503 });
    rpc.accessKeyError = failure;
    const rejected = await chain.transferNear(signer(PARENT), BUYER, 1n).catch((e: unknown) => e);
    expect(rejected).toBe(failure);
    expect(rpc.sent).toEqual([]);
  });
});

describe('RpcSwarmChain.ftTransferCall', () => {
  const call = { receiverId: POOLS, amount: 1_728n, msg: '{"open":{}}' };
  const opened = eventLog({
    event: 'pool_opened',
    data: { pool_id: 3, seller: PROVIDER, seat_price: '180', target: 192, deadline_ms: 1, bonus: '1728', terms: 't' },
  });

  it('returns the outcome and the amount the token kept, the call’s result', async () => {
    const { rpc, chain } = setup();
    rpc.onSend = async (tx) =>
      finalResponse(tx, [{ executorId: TOKEN }, { executorId: POOLS, logs: [opened] }, { executorId: TOKEN }], successValue('1728'));
    const { outcome, used } = await chain.ftTransferCall(signer(PROVIDER), call);
    expect(used).toBe(1_728n);
    expect(poolsEvents(outcome, POOLS).map((event) => event.event)).toEqual(['pool_opened']);
  });

  it("returns, without throwing, a call whose receiver failed and that the token returned", async () => {
    const { rpc, chain } = setup();
    rpc.onSend = async (tx) =>
      finalResponse(tx, [{ executorId: TOKEN }, { executorId: POOLS, status: PANIC }, { executorId: TOKEN }], successValue('0'));
    const { outcome, used } = await chain.ftTransferCall(signer(PROVIDER), call);
    expect(used).toBe(0n);
    expect(outcome.receipts.map((receipt) => receipt.failed)).toEqual([false, false, true, false]);
  });

  it('throws TransactionFailedError when the call itself failed', async () => {
    const { rpc, chain } = setup();
    rpc.onSend = async (tx) => finalResponse(tx, [{ executorId: TOKEN, status: PANIC }], PANIC);
    await expect(chain.ftTransferCall(signer(PROVIDER), call)).rejects.toBeInstanceOf(TransactionFailedError);
  });

  it.each([[successValue(1728)], [{ SuccessValue: '' }], [successValue('-1')]])(
    'rejects OutcomeUnknownError naming the transaction for a result %j that is not an amount',
    async (status) => {
      const { rpc, chain } = setup();
      rpc.onSend = async (tx) => finalResponse(tx, [{ executorId: TOKEN }], status);
      const rejected = await chain.ftTransferCall(signer(PROVIDER), call).catch((e: unknown) => e);
      expect(rejected).toBeInstanceOf(OutcomeUnknownError);
      expect(rejected).toMatchObject({ txHash: rpc.sent[0]?.hash, reason: 'unreadable result' });
      expect(rpc.sent).toHaveLength(1);
    },
  );

  it('rejects OutcomeUnknownError naming the transaction for a response that is not final, sent once', async () => {
    const { rpc, chain } = setup();
    rpc.onSend = async (tx) => ({ ...finalResponse(tx, [{ executorId: TOKEN }], successValue('1728')), final_execution_status: 'INCLUDED' });
    const rejected = await chain.ftTransferCall(signer(PROVIDER), call).catch((e: unknown) => e);
    expect(rejected).toBeInstanceOf(OutcomeUnknownError);
    expect(rejected).toMatchObject({ txHash: rpc.sent[0]?.hash, reason: 'not final' });
    expect(rpc.sent).toHaveLength(1);
  });

  it('names the bonus transfer in the OutcomeUnknownError of a routed request, and never signs it again', async () => {
    const { rpc, chain } = setup();
    rpc.onSend = async () => {
      throw new RequestRoutedError('RoutedTx1');
    };
    const rejected = await chain.ftTransferCall(signer(PROVIDER), call).catch((e: unknown) => e);
    expect(rejected).toBeInstanceOf(OutcomeUnknownError);
    expect(rejected).toMatchObject({ txHash: rpc.sent[0]?.hash });
    expect(rpc.sent).toHaveLength(1);
  });

  it('passes on, as it is, a read that failed before the bonus transfer was sent', async () => {
    const { rpc, chain } = setup();
    const failure = new TypeError('fetch failed');
    rpc.accessKeyError = failure;
    expect(await chain.ftTransferCall(signer(PROVIDER), call).catch((e: unknown) => e)).toBe(failure);
    expect(rpc.sent).toEqual([]);
  });
});

describe('RpcSwarmChain signers', () => {
  it('reads a key’s nonce once, then numbers its transactions from it', async () => {
    const { rpc, chain } = setup();
    const parent = signer(PARENT);
    await chain.transferNear(parent, BUYER, 1n);
    await chain.transferNear(parent, BUYER, 2n);
    expect(rpc.accessKeyReads).toBe(1);
    expect(rpc.sent.map((tx) => tx.nonce)).toEqual([41n, 42n]);
  });

  it('sends the writes of one key one after another, even when they are started together', async () => {
    const { rpc, chain } = setup();
    const parent = signer(PARENT);
    const gate = deferred();
    rpc.onSend = async (tx) => {
      if (tx.nonce === 41n) await gate.promise;
      return finalResponse(tx, [{ executorId: tx.receiverId }]);
    };
    const first = chain.transferNear(parent, BUYER, 1n);
    const second = chain.transferNear(parent, BUYER, 2n);
    await vi.waitFor(() => expect(rpc.sent).toHaveLength(1));
    await settle();
    expect(rpc.sent).toHaveLength(1);
    gate.resolve();
    await Promise.all([first, second]);
    expect(rpc.sent.map((tx) => [tx.nonce, tx.actions.map(plain)])).toEqual([
      [41n, [{ transfer: 1n }]],
      [42n, [{ transfer: 2n }]],
    ]);
  });

  it('sends the writes of different keys at the same time', async () => {
    const { rpc, chain } = setup();
    const gate = deferred();
    rpc.onSend = async (tx) => {
      if (tx.signerId === PARENT) await gate.promise;
      return finalResponse(tx, [{ executorId: tx.receiverId }]);
    };
    const blocked = chain.transferNear(signer(PARENT), BUYER, 1n);
    await chain.transferNear(signer(PROVIDER), BUYER, 2n);
    expect(rpc.sent.map((tx) => tx.signerId)).toEqual([PARENT, PROVIDER]);
    gate.resolve();
    await blocked;
  });

  it('goes on with a key’s next write after one fails', async () => {
    const { rpc, chain } = setup();
    const parent = signer(PARENT);
    rpc.onSend = async (tx) => {
      if (tx.nonce === 41n) throw new TransactionTimeoutError();
      return finalResponse(tx, [{ executorId: tx.receiverId }]);
    };
    const first = chain.transferNear(parent, BUYER, 1n);
    const second = chain.transferNear(parent, BUYER, 2n);
    await expect(first).rejects.toBeInstanceOf(OutcomeUnknownError);
    await second;
    expect(rpc.sent.map((tx) => tx.nonce)).toEqual([41n, 42n]);
  });
});

describe('RpcSwarmChain nonces', () => {
  /** An InvalidNonce answer, as near-api-js parses one: the key's nonce on chain is past the transaction's. */
  const invalidNonce = (tx: SentTx, onChain: bigint) => new InvalidNonceError(Number(onChain), Number(tx.nonce), tx.hash, BLOCK_HASH);

  it('re-signs a batch of ft_transfer calls once with a nonce read again after an InvalidNonce answer, posting each signed transaction once', async () => {
    const { rpc, chain } = setup();
    const funding = signer(`funding.${PARENT}`);
    // Another process signed with the key after this one read its nonce.
    rpc.onSend = async (tx) => {
      if (tx.nonce === 41n) {
        rpc.chainNonce = 45n;
        throw invalidNonce(tx, 45n);
      }
      return finalResponse(tx, [{ executorId: tx.receiverId }]);
    };
    const outcome = await chain.ftTransfers(funding, [{ receiverId: BUYER, amount: 8_000n }]);
    expect(rpc.accessKeyReads).toBe(2);
    expect(rpc.sent.map((tx) => tx.nonce)).toEqual([41n, 46n]);
    expect(new Set(rpc.sent.map((tx) => tx.hash)).size).toBe(2);
    expect(outcome.txHash).toBe(rpc.sent[1]?.hash);
  });

  it('re-signs a write refused for its nonce at most 10 times, each with a nonce read afresh, then passes the refusal on', async () => {
    const { rpc, chain } = setup();
    let refusal: unknown;
    rpc.onSend = async (tx) => {
      rpc.chainNonce = tx.nonce + 3n;
      refusal = invalidNonce(tx, rpc.chainNonce);
      throw refusal;
    };
    const rejected = await chain.transferNear(signer(PARENT), BUYER, 1n).catch((e: unknown) => e);
    expect(rejected).toBe(refusal);
    expect(rpc.sent).toHaveLength(11);
    expect(rpc.accessKeyReads).toBe(11);
    // The key's next write reads its nonce afresh.
    rpc.onSend = async (tx) => finalResponse(tx, [{ executorId: tx.receiverId }]);
    await chain.transferNear(signer(PARENT), BUYER, 1n);
    expect(rpc.accessKeyReads).toBe(12);
  });

  it('signs the bonus ft_transfer_call with a nonce read for it alone, and numbers the key’s later writes from it', async () => {
    const { rpc, chain } = setup();
    const provider = signer(PROVIDER);
    await chain.transferNear(provider, BUYER, 1n);
    rpc.chainNonce = 41n;
    rpc.onSend = async (tx) => finalResponse(tx, [{ executorId: TOKEN }], successValue('1728'));
    const { outcome } = await chain.ftTransferCall(provider, { receiverId: POOLS, amount: 1_728n, msg: '{"open":{}}' });
    rpc.onSend = async (tx) => finalResponse(tx, [{ executorId: tx.receiverId }]);
    await chain.transferNear(provider, BUYER, 2n);
    expect(rpc.accessKeyReads).toBe(2);
    expect(rpc.sent.map((tx) => tx.nonce)).toEqual([41n, 42n, 43n]);
    expect(outcome.txHash).toBe(rpc.sent[1]?.hash);
  });

  it('never re-signs the bonus ft_transfer_call: an InvalidNonce answer rejects NonceTakenError naming it, after one send', async () => {
    const { rpc, chain } = setup();
    rpc.onSend = async (tx) => {
      rpc.chainNonce = 45n;
      throw invalidNonce(tx, 45n);
    };
    const rejected = await chain.ftTransferCall(signer(PROVIDER), { receiverId: POOLS, amount: 1_728n, msg: '{"open":{}}' }).catch((e: unknown) => e);
    expect(rejected).toBeInstanceOf(NonceTakenError);
    expect(rpc.sent).toHaveLength(1);
    expect(rejected).toMatchObject({ txHash: rpc.sent[0]?.hash });
    expect((rejected as Error).message).toBe(
      `transaction ${rpc.sent[0]?.hash} from ${PROVIDER} to ${TOKEN} was refused: another transaction of the key took its nonce after it was read`,
    );
  });

  it('names the bonus ft_transfer_call in the OutcomeUnknownError of a send that got no result, sent once', async () => {
    const { rpc, chain } = setup();
    rpc.onSend = async () => {
      throw new Error('Timeout error', { cause: 408 });
    };
    const rejected = await chain.ftTransferCall(signer(PROVIDER), { receiverId: POOLS, amount: 1_728n, msg: '{"open":{}}' }).catch((e: unknown) => e);
    expect(rejected).toBeInstanceOf(OutcomeUnknownError);
    expect(rpc.sent).toHaveLength(1);
    expect(rejected).toMatchObject({ txHash: rpc.sent[0]?.hash, reason: 'timeout' });
    expect((rejected as Error).message).toBe(
      `transaction ${rpc.sent[0]?.hash} from ${PROVIDER} to ${TOKEN} was sent, but the RPC gave no result (timeout): it may still run`,
    );
  });

  it('passes on a refusal of the bonus ft_transfer_call as it is', async () => {
    const { rpc, chain } = setup();
    const refusal = new InvalidTransactionError();
    rpc.onSend = async () => {
      throw refusal;
    };
    await expect(chain.ftTransferCall(signer(PROVIDER), { receiverId: POOLS, amount: 1_728n, msg: '{"open":{}}' })).rejects.toBe(refusal);
  });

  it('sends the bonus ft_transfer_call only once the key’s previous write has settled', async () => {
    const { rpc, chain } = setup();
    const provider = signer(PROVIDER);
    const gate = deferred();
    rpc.onSend = async (tx) => {
      if (tx.nonce === 41n) await gate.promise;
      return finalResponse(tx, [{ executorId: TOKEN }], successValue('1728'));
    };
    const first = chain.transferNear(provider, BUYER, 1n);
    const bonus = chain.ftTransferCall(provider, { receiverId: POOLS, amount: 1_728n, msg: '{"open":{}}' });
    await vi.waitFor(() => expect(rpc.sent).toHaveLength(1));
    await settle();
    expect(rpc.sent).toHaveLength(1);
    rpc.chainNonce = 41n;
    gate.resolve();
    await Promise.all([first, bonus]);
    expect(rpc.sent.map((tx) => tx.nonce)).toEqual([41n, 42n]);
  });
});

describe('createRpcSwarmChain', () => {
  it('asks the RPC once to wait for a transaction to be final: an RPC that answers 408 is not asked again', async () => {
    const waits: string[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
      const request = JSON.parse(init.body) as { id: string; method: string; params: Record<string, unknown> };
      if (request.method !== 'tx') throw new Error(`unexpected ${request.method}`);
      waits.push(String(request.params.wait_until));
      if (request.params.wait_until === 'FINAL') return new Response('timeout', { status: 408 });
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { final_execution_status: 'INCLUDED' } }), { status: 200 });
    });
    const chain = createRpcSwarmChain({ rpcUrl: 'http://rpc.invalid', token: TOKEN, poolsContract: POOLS });
    expect(await chain.txOutcome('Tx1', 'relay.testnet')).toBe('not_final');
    expect(waits).toEqual(['NONE', 'FINAL']);
  });

  /**
   * An RPC behind a stub fetch: `send_tx` is answered by `sendTx`, a key's nonce read (`query`) and
   * the block read by `reads`, or else with a key of nonce 40 and block 1000. Records each method
   * posted and the hash of each transaction sent.
   */
  function stubRpc(
    sendTx: (id: string) => Response,
    reads: (method: string, id: string) => Response | undefined = () => undefined,
  ) {
    const methods: string[] = [];
    const hashes: string[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
      const request = JSON.parse(init.body) as { id: string; method: string; params: Record<string, unknown> };
      methods.push(request.method);
      if (request.method === 'send_tx') {
        const signed = decodeSignedTransaction(Buffer.from(String(request.params.signed_tx_base64), 'base64'));
        hashes.push(baseEncode(createHash('sha256').update(encodeTransaction(signed.transaction)).digest()));
        return sendTx(request.id);
      }
      const answer = reads(request.method, request.id);
      if (answer !== undefined) return answer;
      const result =
        request.method === 'block'
          ? { header: { height: 1_000, hash: BLOCK_HASH, timestamp_nanosec: '0' } }
          : { nonce: 40, permission: 'FullAccess', block_height: 1_000, block_hash: BLOCK_HASH };
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }), { status: 200 });
    });
    const chain = createRpcSwarmChain({ rpcUrl: 'http://rpc.invalid', token: TOKEN, poolsContract: POOLS });
    return { chain, methods, hashes };
  }

  /** A JSON-RPC error body, as the RPC writes one, answered with HTTP 200. */
  const rpcError = (id: string, error: Record<string, unknown>) =>
    new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: 'Server error', ...error } }), { status: 200 });

  it.each<[string, (id: string) => Response]>([
    ['a 503', () => new Response('unavailable', { status: 503 })],
    ['a 504 with an HTML body', () => new Response('<html><body>504 Gateway Time-out</body></html>', { status: 504 })],
    ['a 504 with a JSON body', () => new Response(JSON.stringify({ message: 'Gateway Timeout' }), { status: 504 })],
    ['REQUEST_ROUTED', (id) => rpcError(id, { name: 'HANDLER_ERROR', cause: { name: 'REQUEST_ROUTED', info: { transaction_hash: 'RoutedTx1' } } })],
    ['INTERNAL_ERROR', (id) => rpcError(id, { name: 'INTERNAL_ERROR', cause: { name: 'INTERNAL_ERROR', info: { error_message: 'boom' } } })],
  ])('posts a signed transaction once, and rejects OutcomeUnknownError naming it, when the RPC answers it %s', async (_, sendTx) => {
    const { chain, methods, hashes } = stubRpc(sendTx);
    const rejected = await chain.transferNear(signer(PARENT), BUYER, 1n).catch((e: unknown) => e);
    expect(methods.filter((method) => method === 'send_tx')).toHaveLength(1);
    expect(rejected).toBeInstanceOf(OutcomeUnknownError);
    expect(rejected).toMatchObject({ txHash: hashes[0] });
  });

  it.each<[string, (method: string) => Response | undefined]>([
    ["the key's nonce read answered 503", (method) => (method === 'query' ? new Response('unavailable', { status: 503 }) : undefined)],
    [
      'the block read refused',
      (method) => {
        if (method === 'block') throw new TypeError('fetch failed', { cause: Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }) });
        return undefined;
      },
    ],
  ])('passes on the error of a read before sending, sending nothing, when %s', async (_, reads) => {
    const { chain, methods } = stubRpc(() => new Response('unexpected', { status: 500 }), reads);
    const rejected = await chain.transferNear(signer(PARENT), BUYER, 1n).catch((e: unknown) => e);
    expect(rejected).toBeInstanceOf(Error);
    expect(rejected).not.toBeInstanceOf(OutcomeUnknownError);
    expect(methods).not.toContain('send_tx');
  });
});
