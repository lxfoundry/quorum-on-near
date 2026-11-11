import type { BuyerView, DecodedSignedDelegate, PoolView, QuorumEvent } from '@quorum-on-near/protocol';
import type {
  AccessKeyInfo,
  BlockInfo,
  ChainReader,
  ChainWriter,
  ReceiptOutcome,
  RelayResult,
  TxOutcome,
} from '../src/chain.ts';
import { TESTNET_USDC, type GatewayConfig } from '../src/config.ts';

export const PARENT = 'parent.testnet';
export const PROVIDER = `provider.${PARENT}`;
export const POOLS = `pools.${PARENT}`;
export const RELAYER = `relay.${PARENT}`;
export const TOKEN = TESTNET_USDC;
/** A fixed "now" for tests: well before the default pool deadline. */
export const NOW_MS = 1_799_999_000_000;
export const TERMS = '8×GPU × 24 h; 1 seat = 1 GPU-hour; prices at 1/10,000 scale';

/** A pool as the contract's views return it; the defaults match spec section 6.2's example. */
export function poolView(overrides: Partial<PoolView> = {}): PoolView {
  return {
    id: 7,
    seller: PROVIDER,
    seat_price: '180',
    target: 192,
    taken: 148,
    deadline_ms: 1_800_000_000_000,
    bonus: '1728',
    max_seats_per_buyer: 24,
    terms: TERMS,
    status: 'open',
    bonus_per_seat: '0',
    refund_cursor: 0,
    dust_sent: false,
    buyer_count: 10,
    ...overrides,
  };
}

export function testConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    network: 'near:testnet',
    rpcUrl: 'http://rpc.invalid',
    publicUrl: 'http://localhost:8402',
    port: 8402,
    parent: PARENT,
    token: TOKEN,
    poolsContract: POOLS,
    relayer: RELAYER,
    provider: PROVIDER,
    relayerKeys: [],
    credentialJwk: {},
    minGas: 50_000_000_000_000n,
    maxGas: 100_000_000_000_000n,
    maxTimeoutSeconds: 120,
    blockTimeMs: 1000,
    keeperIntervalMs: 5000,
    refundLimit: 10,
    settleGas: 100_000_000_000_000n,
    refundGas: 300_000_000_000_000n,
    dataDir: 'data',
    webDir: null,
    rpcPassthrough: false,
    explorerTxUrl: 'https://testnet.nearblocks.io/txns/',
    ...overrides,
  };
}

/** The log line the pools contract writes for an event. */
export function eventLog(event: QuorumEvent): string {
  return `EVENT_JSON:${JSON.stringify({ standard: 'quorum', version: '1.0.0', event: event.event, data: [event.data] })}`;
}

export interface ReceiptSpec {
  executorId: string;
  events?: QuorumEvent[];
  logs?: string[];
  failed?: boolean;
  gasBurnt?: bigint;
}

/** A TxOutcome from receipt specs: the relayer's transaction first, then the given receipts. */
export function outcome(txHash: string, receipts: ReceiptSpec[]): TxOutcome {
  const toReceipt = (r: ReceiptSpec): ReceiptOutcome => ({
    executorId: r.executorId,
    logs: [...(r.logs ?? []), ...(r.events ?? []).map(eventLog)],
    failed: r.failed ?? false,
    gasBurnt: r.gasBurnt ?? 1_000_000_000_000n,
  });
  return { txHash, receipts: [toReceipt({ executorId: RELAYER }), ...receipts.map(toReceipt)] };
}

/**
 * The outcome of a relayed commit that took `seats` seats: delegate at the buyer, ft_transfer_call
 * at the token, ft_on_transfer at the pools contract (with its events), ft_resolve_transfer.
 */
export function commitOutcome(opts: {
  txHash?: string;
  buyer: string;
  poolId: number;
  seats: number;
  seatPrice: bigint;
  taken: number;
  target: number;
}): TxOutcome {
  const events: QuorumEvent[] = [];
  if (opts.seats > 0) {
    events.push({
      event: 'seats_committed',
      data: {
        pool_id: opts.poolId,
        buyer: opts.buyer,
        seats: opts.seats,
        amount: (BigInt(opts.seats) * opts.seatPrice).toString(),
        taken: opts.taken,
        target: opts.target,
      },
    });
    if (opts.taken === opts.target) events.push({ event: 'pool_filled', data: { pool_id: opts.poolId, taken: opts.taken } });
  }
  return outcome(opts.txHash ?? 'TxHash111', [
    { executorId: opts.buyer },
    { executorId: TOKEN },
    { executorId: POOLS, events, failed: opts.seats === 0 },
    { executorId: TOKEN },
  ]);
}

/** An in-memory chain. Tests set its state directly and queue relay results. */
export class FakeChain implements ChainReader, ChainWriter {
  pools = new Map<number, PoolView>();
  buyers = new Map<string, BuyerView>();
  balances = new Map<string, bigint>();
  keys = new Map<string, AccessKeyInfo>();
  block: BlockInfo = { height: 1_000n, timestampMs: NOW_MS };
  token = TOKEN;
  /** Results returned by relayDelegate, in order; when empty, `onRelay` decides. */
  relayResults: RelayResult[] = [];
  onRelay?: (signed: DecodedSignedDelegate, maxBlockHeight: bigint) => RelayResult | Promise<RelayResult>;
  relayed: Array<{ signed: DecodedSignedDelegate; maxBlockHeight: bigint }> = [];
  /** Results returned by callPools, in order; when empty, `onCall` decides. */
  callResults: RelayResult[] = [];
  onCall?: (method: 'settle' | 'refund', args: Record<string, unknown>) => RelayResult | Promise<RelayResult>;
  calls: Array<{ method: 'settle' | 'refund'; args: Record<string, unknown>; gas: bigint }> = [];
  /** Count of view calls, by method name. */
  reads = new Map<string, number>();

  #read(name: string): void {
    this.reads.set(name, (this.reads.get(name) ?? 0) + 1);
  }

  setPool(pool: PoolView): void {
    this.pools.set(pool.id, pool);
  }
  setBuyer(poolId: number, account: string, view: BuyerView | null): void {
    if (view === null) this.buyers.delete(`${poolId}:${account}`);
    else this.buyers.set(`${poolId}:${account}`, view);
  }
  setKey(account: string, publicKey: string, info: AccessKeyInfo): void {
    this.keys.set(`${account}:${publicKey}`, info);
  }

  async getPool(poolId: number): Promise<PoolView | null> {
    this.#read('get_pool');
    return this.pools.get(poolId) ?? null;
  }
  async listPools(from: number, limit: number): Promise<PoolView[]> {
    this.#read('list_pools');
    return [...this.pools.values()]
      .sort((a, b) => a.id - b.id)
      .filter((p) => p.id >= from)
      .slice(0, Math.min(limit, 100));
  }
  async getBuyer(poolId: number, accountId: string): Promise<BuyerView | null> {
    this.#read('get_buyer');
    return this.buyers.get(`${poolId}:${accountId}`) ?? null;
  }
  async ftBalanceOf(accountId: string): Promise<bigint> {
    this.#read('ft_balance_of');
    return this.balances.get(accountId) ?? 0n;
  }
  async accessKey(accountId: string, publicKey: string): Promise<AccessKeyInfo | null> {
    this.#read('view_access_key');
    return this.keys.get(`${accountId}:${publicKey}`) ?? null;
  }
  async finalBlock(): Promise<BlockInfo> {
    this.#read('block');
    return this.block;
  }
  async getToken(): Promise<string> {
    this.#read('get_token');
    return this.token;
  }
  async relayDelegate(signed: DecodedSignedDelegate, maxBlockHeight: bigint): Promise<RelayResult> {
    this.relayed.push({ signed, maxBlockHeight });
    const queued = this.relayResults.shift();
    if (queued) return queued;
    if (this.onRelay) return this.onRelay(signed, maxBlockHeight);
    throw new Error('FakeChain: no relay result queued');
  }
  async callPools(method: 'settle' | 'refund', args: Record<string, unknown>, gas: bigint): Promise<RelayResult> {
    this.calls.push({ method, args, gas });
    const queued = this.callResults.shift();
    if (queued) return queued;
    if (this.onCall) return this.onCall(method, args);
    return { kind: 'rejected', txHash: 'none', error: 'FakeChain: no call result queued' };
  }
}
