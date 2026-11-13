import type {
  BuyerPaymentAnswer,
  OfferAnswer,
  PaymentAnswer,
  PaymentRequest,
  PoolListing,
  PoolsAnswer,
  RedeemAnswer,
  SignedPayment,
} from '@quorum-on-near/buyer';
import { buildOffer, type Offer, type OfferContext, type PoolView } from '@quorum-on-near/protocol';
import { baseEncode } from 'near-api-js';
import { Commits } from '../src/commits.ts';
import { SpendLedger } from '../src/spend.ts';
import type { ToolDeps } from '../src/tools.ts';

/** The accounts, the pool, the gateway answers and the stubbed buyer the MCP tests share. */

export const PARENT = 'parent.testnet';
export const BUYER = `buyer-llm.${PARENT}`;
export const POOLS = `pools.${PARENT}`;
export const TOKEN = 'usdc.testnet';
export const POOL_ID = 7;
/** 2027-01-15T08:00:00.000Z. */
export const DEADLINE_MS = 1_800_000_000_000;
export const TERMS = '8×GPU × 24 h; 1 seat = 1 GPU-hour; prices at 1/10,000 scale';

/** A pool of the gateway's provider: 180 per seat, 148 of 192 seats taken, a bonus of 1728, at most 24 per buyer. */
export const POOL: PoolView = {
  id: POOL_ID,
  seller: `provider.${PARENT}`,
  seat_price: '180',
  target: 192,
  taken: 148,
  deadline_ms: DEADLINE_MS,
  bonus: '1728',
  max_seats_per_buyer: 24,
  terms: TERMS,
  status: 'open',
  bonus_per_seat: '0',
  refund_cursor: 0,
  dust_sent: false,
  buyer_count: 30,
};

/** POOL as GatewayClient lists it: the least bonus per seat is floor(1728 / 191) = 9. */
export const LISTING: PoolListing = {
  id: POOL_ID,
  terms: TERMS,
  seat_price: 180n,
  target: 192,
  taken: 148,
  deadline_ms: DEADLINE_MS,
  bonus: 1728n,
  min_bonus_per_seat: 9n,
};

/** What the stubbed gateway is configured with. */
export const CONTEXT: OfferContext = {
  network: 'near:testnet',
  gatewayUrl: 'http://localhost:8402',
  poolsContract: POOLS,
  token: TOKEN,
  relayer: `relay.${PARENT}`,
  minGas: 50_000_000_000_000n,
  maxGas: 100_000_000_000_000n,
  maxTimeoutSeconds: 120,
};

/** The gateway's offer for `seats` seats of `pool`, built as the gateway builds it. */
export function offerFor(seats: number, pool: PoolView = POOL, context: OfferContext = CONTEXT): Offer {
  return buildOffer(pool, seats, context);
}

/** A transaction hash: base58 of 32 bytes. */
export const TX_HASH = baseEncode(new Uint8Array(32).fill(7));

/** A compact JWS, as the gateway's credentials are. */
export const CREDENTIAL = 'eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJidXllci1sbG0ifQ.c2lnbmF0dXJl';

/** What the stubbed buyer signed for each payment: 120 blocks of expiry past the final height. */
export const SIGNED: SignedPayment = { nonce: 1_001n, finalHeight: 245_000_100n, maxBlockHeight: 245_000_220n };

/** The gateway's `answer` as Buyer.pay returns it, with the payment it answers. */
export function signed(answer: PaymentAnswer): BuyerPaymentAnswer {
  return { ...answer, signed: SIGNED };
}

/** The 202 answer to a payment that took `seats` seats of POOL. */
export function pending(seats: number): BuyerPaymentAnswer {
  return signed({
    kind: 'pending',
    txHash: TX_HASH,
    poolId: POOL_ID,
    buyer: BUYER,
    seats,
    taken: 148 + seats,
    target: 192,
    deadlineMs: DEADLINE_MS,
  });
}

/** The 200 answer to a payment that filled POOL, the buyer then holding `seats` seats. */
export function filled(seats: number): BuyerPaymentAnswer {
  return signed({ kind: 'filled', txHash: TX_HASH, credential: CREDENTIAL, poolId: POOL_ID, seats, terms: TERMS });
}

/** 90.5 seconds before the pool's deadline. */
export const NOW_MS = DEADLINE_MS - 90_500;
export const CAP = 10_000n;

/** The RPC URL the tools are configured with: it carries an API key, so no text may quote it. */
export const RPC_URL = 'https://rpc.example.org/?apiKey=TEST-RPC-KEY';

/** The stubbed gateway's answers; each defaults to the happy path for POOL, and an Error is thrown. */
export interface Answers {
  pools?: PoolsAnswer | Error;
  /** Defaults to the offer for the seats requested. */
  offer?: OfferAnswer | Error;
  /** Defaults to a 202 for every seat of the offer. */
  pay?: BuyerPaymentAnswer | Error;
  /** Runs while the payment is in flight, before its answer. */
  duringPay?: () => Promise<void>;
  redeem?: RedeemAnswer | Error;
  /** The latest final height, read at each call; SIGNED's final height by default. */
  finalHeight?: () => bigint;
  /** The pool's view on chain, for any pool id; POOL with that id by default. */
  pool?: PoolView | null | Error;
}

/** What the stubbed buyer and gateway were asked. */
export interface Calls {
  pools: number;
  offer: [pool: number, seats: number][];
  pay: [offer: Offer, request: PaymentRequest][];
  redeem: number[];
  finalHeight: number;
  getPool: number[];
}

/** `answer`, or a throw when it is an Error. */
function answerOrThrow<T>(answer: T | Error): T {
  if (answer instanceof Error) throw answer;
  return answer;
}

/**
 * The tools' dependencies: a buyer and a gateway stubbed with `answers`, and a real spend ledger over
 * the file at `spendFile` with a cap of CAP, at the time NOW_MS, writing amounts as USDC does. `logs`
 * holds every line written to the operator's log.
 */
export function toolDeps(spendFile: string, answers: Answers = {}): { deps: ToolDeps; calls: Calls; logs: string[] } {
  const calls: Calls = { pools: 0, offer: [], pay: [], redeem: [], finalHeight: 0, getPool: [] };
  const logs: string[] = [];
  const deps: ToolDeps = {
    buyer: {
      accountId: BUYER,
      async offer(pool, seats) {
        calls.offer.push([pool, seats]);
        return answerOrThrow(answers.offer ?? { kind: 'offer', offer: offerFor(seats) });
      },
      async pay(offer, request) {
        calls.pay.push([offer, request]);
        await answers.duringPay?.();
        return answerOrThrow(answers.pay ?? pending(offer.extra.seats));
      },
      async redeem(pool) {
        calls.redeem.push(pool);
        return answerOrThrow(answers.redeem ?? { kind: 'no_seats' });
      },
      async finalHeight() {
        calls.finalHeight += 1;
        return answers.finalHeight?.() ?? SIGNED.finalHeight;
      },
    },
    gateway: {
      async pools() {
        calls.pools += 1;
        return answerOrThrow(answers.pools ?? { kind: 'pools', pools: [LISTING] });
      },
    },
    chain: {
      async getPool(id) {
        calls.getPool.push(id);
        return answerOrThrow(answers.pool === undefined ? { ...POOL, id } : answers.pool);
      },
    },
    ledger: new SpendLedger({ path: spendFile, account: BUYER, cap: CAP, log: (line) => logs.push(line) }),
    settings: { network: 'near:testnet', token: TOKEN, poolsContract: POOLS, rpcUrl: RPC_URL, blockTimeMs: 1000 },
    units: { decimals: 6, symbol: 'USDC' },
    now: () => NOW_MS,
    log: (line) => logs.push(line),
    commits: new Commits(),
  };
  return { deps, calls, logs };
}
