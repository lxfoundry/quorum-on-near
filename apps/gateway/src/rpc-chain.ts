import { parseAmount } from '@quorum-on-near/protocol';
import type { BuyerView, PoolView } from '@quorum-on-near/protocol';
import type { Provider, SerializedReturnValue } from 'near-api-js';
import { AccessKeyDoesNotExistError, AccountDoesNotExistError } from 'near-api-js/rpc-errors';
import type { AccessKeyInfo, BlockInfo, ChainReader } from './chain.ts';

const OPTIMISTIC = { finality: 'optimistic' } as const;
const FINAL = { finality: 'final' } as const;
const NANOS_PER_MS = 1_000_000n;

/** The provider methods RpcChain reads with. None of them sends a transaction. */
export type ChainProvider = Pick<Provider, 'callFunction' | 'viewAccessKey' | 'viewBlock'>;

/**
 * ChainReader over near-api-js's JSON-RPC provider. Views and access keys are read at optimistic
 * finality, so they reflect at least the state of an outcome returned at EXECUTED_OPTIMISTIC;
 * `finalBlock` reads the latest final block.
 */
export class RpcChain implements ChainReader {
  readonly #provider: ChainProvider;
  readonly #poolsContract: string;
  readonly #token: string;

  constructor(opts: { provider: ChainProvider; poolsContract: string; token: string }) {
    this.#provider = opts.provider;
    this.#poolsContract = opts.poolsContract;
    this.#token = opts.token;
  }

  async getPool(poolId: number): Promise<PoolView | null> {
    return (await this.#view<PoolView>(this.#poolsContract, 'get_pool', { pool_id: poolId })) ?? null;
  }

  async listPools(from: number, limit: number): Promise<PoolView[]> {
    return (await this.#view<PoolView[]>(this.#poolsContract, 'list_pools', { from, limit })) ?? [];
  }

  async getBuyer(poolId: number, accountId: string): Promise<BuyerView | null> {
    const args = { pool_id: poolId, account_id: accountId };
    return (await this.#view<BuyerView>(this.#poolsContract, 'get_buyer', args)) ?? null;
  }

  async ftBalanceOf(accountId: string): Promise<bigint> {
    const result = await this.#view(this.#token, 'ft_balance_of', { account_id: accountId });
    const balance = parseAmount(result);
    if (balance === null) throw new TypeError(`ft_balance_of returned ${JSON.stringify(result)}`);
    return balance;
  }

  async accessKey(accountId: string, publicKey: string): Promise<AccessKeyInfo | null> {
    try {
      const key = await this.#provider.viewAccessKey({ accountId, publicKey, finalityQuery: OPTIMISTIC });
      return { nonce: key.nonce, fullAccess: key.permission === 'FullAccess' };
    } catch (error) {
      if (error instanceof AccessKeyDoesNotExistError || error instanceof AccountDoesNotExistError) return null;
      throw error;
    }
  }

  async finalBlock(): Promise<BlockInfo> {
    const { header } = await this.#provider.viewBlock(FINAL);
    return {
      height: BigInt(header.height),
      timestampMs: Number(BigInt(header.timestamp_nanosec) / NANOS_PER_MS),
    };
  }

  async getToken(): Promise<string> {
    const token = await this.#view(this.#poolsContract, 'get_token', {});
    if (typeof token !== 'string') throw new TypeError(`get_token returned ${JSON.stringify(token)}`);
    return token;
  }

  /** A view call at optimistic finality; the result is the contract's JSON, unchecked. */
  #view<T extends SerializedReturnValue>(
    contractId: string,
    method: string,
    args: Record<string, unknown>,
  ): Promise<T | undefined> {
    return this.#provider.callFunction<T>({ contractId, method, args, blockQuery: OPTIMISTIC });
  }
}
