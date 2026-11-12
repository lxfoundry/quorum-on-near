import {
  checkPaymentHeader,
  checkRedeemProof,
  decodeHeader,
  paymentRequired,
  type ExpectedPayment,
  type Offer,
  type OfferErrorCode,
} from '@quorum-on-near/protocol';
import { JsonRpcProvider, KeyPair } from 'near-api-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Buyer, PaymentNotSentError, PaymentUnknownError, type PaymentRequest, type SignedPayment } from '../src/buyer.ts';
import { AccessKeyNotFoundError, RpcBuyerChain, type BuyerChainReads } from '../src/chain.ts';
import { GatewayClient, GatewayResponseError } from '../src/gateway.ts';
import type { BuyerSettings } from '../src/settings.ts';
import {
  BUYER,
  GATEWAY_URL,
  jsonResponse,
  offerFor,
  paymentResponseHeader,
  PARENT,
  POOL,
  POOL_ID,
  POOLS,
  stubFetch,
  TOKEN,
  txHash,
} from './stub-gateway.ts';

const NOW_MS = 1_800_000_000_000;
const NONCE = 245_000_100_000_042n;
const FINAL_HEIGHT = 245_000_100n;
/** What Buyer.pay signs for OFFER: 120 s at 600 ms per block is 200 blocks past the final height. */
const SIGNED: SignedPayment = { nonce: NONCE, finalHeight: FINAL_HEIGHT, maxBlockHeight: 245_000_300n };
const SETTINGS: BuyerSettings = {
  network: 'near:testnet',
  rpcUrl: 'https://test.rpc.fastnear.com',
  gatewayUrl: GATEWAY_URL,
  parent: PARENT,
  token: TOKEN,
  poolsContract: POOLS,
  blockTimeMs: 600,
  maxTimeoutSeconds: 120,
};
/** The offer for 2 seats at 180, and a request for them on a budget of exactly their price. */
const OFFER = offerFor(2);
const REQUEST: PaymentRequest = { poolId: POOL_ID, seats: 2, maxAmount: 360n };
/** What the gateway checks a payment for 2 seats of the pool against. */
const EXPECTED_PAYMENT: ExpectedPayment = {
  network: 'near:testnet',
  token: TOKEN,
  poolsContract: POOLS,
  poolId: POOL_ID,
  maxSeats: 2,
  seatPrice: 180n,
  minGas: 50_000_000_000_000n,
  maxGas: 100_000_000_000_000n,
};

/** The gateway's answers to each kind of request, as the stub router sends them. */
interface Answers {
  offer?: () => Response;
  payment?: () => Response;
  redemption?: () => Response;
}

interface Setup {
  answers?: Answers;
  settings?: BuyerSettings;
  /** Replaces the chain's nonce read. */
  nextNonce?: () => Promise<bigint>;
  /** Replaces the chain's final height read. */
  finalHeight?: () => Promise<bigint>;
  keyPair?: KeyPair;
}

/**
 * A Buyer over a gateway stubbed by `answers` and a chain whose next nonce is NONCE and whose final
 * height is FINAL_HEIGHT, with the time NOW_MS. Records the requests sent and the chain reads made.
 */
function setup({
  answers = {},
  settings = SETTINGS,
  nextNonce = async () => NONCE,
  finalHeight = async () => FINAL_HEIGHT,
  keyPair = KeyPair.fromRandom('ed25519'),
}: Setup = {}) {
  const unavailable = () => jsonResponse(503, { error: 'chain_unavailable' });
  const { fetch, requests } = stubFetch((request) => {
    if (request.headers.has('X-PAYMENT')) return (answers.payment ?? unavailable)();
    if (request.headers.has('X-QUORUM-PROOF')) return (answers.redemption ?? unavailable)();
    return (answers.offer ?? unavailable)();
  });
  const reads: string[] = [];
  const chain: BuyerChainReads = {
    async nextNonce(accountId, publicKey) {
      reads.push(`nextNonce ${accountId} ${publicKey}`);
      return nextNonce();
    },
    async finalHeight() {
      reads.push('finalHeight');
      return finalHeight();
    },
  };
  const buyer = new Buyer({
    settings,
    accountId: BUYER,
    keyPair,
    gateway: new GatewayClient({ gatewayUrl: settings.gatewayUrl, fetch }),
    chain,
    now: () => NOW_MS,
  });
  return { buyer, keyPair, requests, reads };
}

/** The error `promise` rejects with; fails the test if it resolves. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('the promise resolved');
}

/** Node's fetch rejection when the connection fails: TypeError('fetch failed') caused by the socket error `code`. */
function fetchFailed(code: string): TypeError {
  return new TypeError('fetch failed', { cause: socketError(code) });
}

function socketError(code: string): Error {
  return Object.assign(new Error(`connect ${code} 127.0.0.1:8402`), { code });
}

/** An RPC error whose message names the RPC URL, as near-api-js's 502 and 503 errors do. */
const RPC_DOWN = new Error('https://rpc.example.org/?apiKey=SECRET-KEY unavailable');

/** OFFER with `changes` applied and `extra` merged into its extra; the fields take any value. */
function offerWith(changes: Record<string, unknown>, extra: Record<string, unknown> = {}): Offer {
  return { ...OFFER, ...changes, extra: { ...OFFER.extra, ...extra } } as Offer;
}

describe('Buyer.offer', () => {
  it("returns the gateway's answer to the offer request", async () => {
    const { buyer, requests } = setup({ answers: { offer: () => jsonResponse(402, paymentRequired([OFFER])) } });
    expect(await buyer.offer(POOL_ID, 2)).toEqual({ kind: 'offer', offer: OFFER });
    expect(requests.map((r) => r.url)).toEqual([`${GATEWAY_URL}/pools/7/access?seats=2`]);
  });
});

describe('Buyer.pay', () => {
  it('sends one payment that passes the gateway checks: its key, the next nonce, the price, the gas', async () => {
    const { buyer, keyPair, requests } = setup();
    await buyer.pay(OFFER, REQUEST);
    expect(requests).toHaveLength(1);
    const header = requests[0]?.headers.get('X-PAYMENT') ?? '';
    const checked = checkPaymentHeader(header, EXPECTED_PAYMENT);
    expect(checked.ok).toBe(true);
    expect(checked.ok && checked.payment).toMatchObject({
      senderId: BUYER,
      publicKey: keyPair.getPublicKey().toString(),
      nonce: NONCE,
      poolId: POOL_ID,
      seats: 2,
      amount: 360n,
      gas: 100_000_000_000_000n,
    });
  });

  it("expires the payment the offer's timeout after the final height, in blocks of the configured time", async () => {
    const { buyer, requests } = setup();
    await buyer.pay(OFFER, REQUEST);
    const checked = checkPaymentHeader(requests[0]?.headers.get('X-PAYMENT') ?? '', EXPECTED_PAYMENT);
    // 120 s at 600 ms per block is 200 blocks.
    expect(checked.ok && checked.payment.maxBlockHeight).toBe(245_000_300n);
  });

  it("expires the payment the buyer's own longest timeout after the final height when the offer allows longer", async () => {
    const { buyer, requests } = setup();
    await buyer.pay(offerWith({ maxTimeoutSeconds: 1_000_000_000_000 }), REQUEST);
    const checked = checkPaymentHeader(requests[0]?.headers.get('X-PAYMENT') ?? '', EXPECTED_PAYMENT);
    // The buyer's 120 s at 600 ms per block is 200 blocks.
    expect(checked.ok && checked.payment.maxBlockHeight).toBe(245_000_300n);
  });

  it("expires the payment the offer's timeout after the final height when it is shorter than the buyer's", async () => {
    const { buyer, requests } = setup({ settings: { ...SETTINGS, maxTimeoutSeconds: 300 } });
    await buyer.pay(offerWith({ maxTimeoutSeconds: 60 }), REQUEST);
    const checked = checkPaymentHeader(requests[0]?.headers.get('X-PAYMENT') ?? '', EXPECTED_PAYMENT);
    // 60 s at 600 ms per block is 100 blocks.
    expect(checked.ok && checked.payment.maxBlockHeight).toBe(245_000_200n);
  });

  it('reads the nonce of its own key', async () => {
    const { buyer, keyPair, reads } = setup();
    await buyer.pay(OFFER, REQUEST);
    expect(reads).toEqual([`nextNonce ${BUYER} ${keyPair.getPublicKey().toString()}`, 'finalHeight']);
  });

  it('pays a reduced offer at the URL of the seats it requested', async () => {
    const { buyer, requests } = setup();
    await buyer.pay(offerFor(1), REQUEST);
    expect(requests[0]?.url).toBe(`${GATEWAY_URL}/pools/7/access?seats=2`);
    const checked = checkPaymentHeader(requests[0]?.headers.get('X-PAYMENT') ?? '', EXPECTED_PAYMENT);
    expect(checked.ok && [checked.payment.seats, checked.payment.amount]).toEqual([1, 180n]);
  });

  it("returns the gateway's answer to the payment", async () => {
    const hash = txHash();
    const body = {
      status: 'pending',
      receipt: { poolId: POOL_ID, buyer: BUYER, seats: 2, txHash: hash },
      pool: { taken: 150, target: 192, deadlineMs: POOL.deadline_ms },
    };
    const { buyer } = setup({ answers: { payment: () => jsonResponse(202, body, paymentResponseHeader(hash)) } });
    expect(await buyer.pay(OFFER, REQUEST)).toEqual({
      kind: 'pending',
      txHash: hash,
      poolId: POOL_ID,
      buyer: BUYER,
      seats: 2,
      taken: 150,
      target: 192,
      deadlineMs: POOL.deadline_ms,
      signed: SIGNED,
    });
  });

  it("carries what it signed, the payment's nonce, final height and expiry, on every answer of the gateway", async () => {
    const { buyer, requests } = setup();
    const answer = await buyer.pay(OFFER, REQUEST);
    expect(answer).toEqual({ kind: 'unavailable', signed: SIGNED });
    const checked = checkPaymentHeader(requests[0]?.headers.get('X-PAYMENT') ?? '', EXPECTED_PAYMENT);
    expect(checked.ok && [checked.payment.nonce, checked.payment.maxBlockHeight]).toEqual([SIGNED.nonce, SIGNED.maxBlockHeight]);
  });

  it('never sends a payment again: a refusal is returned, after one request', async () => {
    const { buyer, requests } = setup({ answers: { payment: () => jsonResponse(402, paymentRequired([OFFER], 'stale_nonce')) } });
    expect(await buyer.pay(OFFER, REQUEST)).toEqual({ kind: 'refused', error: 'stale_nonce', offer: OFFER, signed: SIGNED });
    expect(requests).toHaveLength(1);
  });

  it('never sends a payment again when no answer arrives, and rejects with PaymentUnknownError naming what it signed', async () => {
    const failure = fetchFailed('ECONNRESET');
    const { buyer, requests } = setup({
      answers: {
        payment: () => {
          throw failure;
        },
      },
    });
    const error = await rejection(buyer.pay(OFFER, REQUEST));
    expect(error).toBeInstanceOf(PaymentUnknownError);
    expect(error).toMatchObject({ signed: SIGNED, cause: failure });
    expect((error as Error).message).toContain('(ECONNRESET)');
    expect((error as Error).message).not.toContain('127.0.0.1');
    expect(requests).toHaveLength(1);
  });

  it.each<[string, () => Response]>([
    ['an answer that is not documented', () => jsonResponse(500, { error: 'internal' })],
    [
      'a socket closed after the connection was made',
      () => {
        throw new TypeError('fetch failed', { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) });
      },
    ],
    [
      'a failure with no cause',
      () => {
        throw new TypeError('fetch failed');
      },
    ],
  ])('rejects with PaymentUnknownError after %s: the payment may have reached the gateway', async (_, payment) => {
    const { buyer, requests } = setup({ answers: { payment } });
    const error = await rejection(buyer.pay(OFFER, REQUEST));
    expect(error).toBeInstanceOf(PaymentUnknownError);
    expect(error).toMatchObject({ signed: SIGNED });
    expect(requests).toHaveLength(1);
  });

  it('keeps the GatewayResponseError of an undocumented answer as the cause of its PaymentUnknownError', async () => {
    const { buyer } = setup({ answers: { payment: () => jsonResponse(500, { error: 'internal' }) } });
    const error = (await rejection(buyer.pay(OFFER, REQUEST))) as PaymentUnknownError;
    expect(error.cause).toBeInstanceOf(GatewayResponseError);
  });

  it("rejects with PaymentUnknownError when the gateway does not answer within the client's timeout", async () => {
    let sent = 0;
    // A gateway that never answers; the request ends only when the client's own signal aborts it.
    const silent = (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      sent += 1;
      return new Promise((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    };
    const buyer = new Buyer({
      settings: SETTINGS,
      accountId: BUYER,
      keyPair: KeyPair.fromRandom('ed25519'),
      gateway: new GatewayClient({ gatewayUrl: GATEWAY_URL, fetch: silent, payTimeoutMs: 50 }),
      chain: { nextNonce: async () => NONCE, finalHeight: async () => FINAL_HEIGHT },
      now: () => NOW_MS,
    });
    const error = await rejection(buyer.pay(OFFER, REQUEST));
    expect(error).toBeInstanceOf(PaymentUnknownError);
    expect(error).toMatchObject({ signed: SIGNED, cause: { name: 'TimeoutError' } });
    expect((error as Error).message).toContain('(timeout)');
    expect(sent).toBe(1);
  });

  it.each(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'])(
    'rejects with PaymentNotSentError gateway_unreachable when the connection fails with %s: nothing reached the gateway',
    async (code) => {
      const failure = fetchFailed(code);
      const { buyer } = setup({
        answers: {
          payment: () => {
            throw failure;
          },
        },
      });
      const error = await rejection(buyer.pay(OFFER, REQUEST));
      expect(error).toBeInstanceOf(PaymentNotSentError);
      expect(error).toMatchObject({ reason: 'gateway_unreachable', cause: failure });
      expect((error as Error).message).toContain(`(${code})`);
      expect((error as Error).message).not.toContain('127.0.0.1');
    },
  );

  it('rejects with PaymentNotSentError gateway_unreachable when every address of the host refused the connection', async () => {
    const refused = Object.assign(new AggregateError([socketError('ECONNREFUSED'), socketError('ECONNREFUSED')], ''), {
      code: 'ECONNREFUSED',
    });
    const { buyer } = setup({
      answers: {
        payment: () => {
          throw new TypeError('fetch failed', { cause: refused });
        },
      },
    });
    expect(await rejection(buyer.pay(OFFER, REQUEST))).toMatchObject({ name: 'PaymentNotSentError', reason: 'gateway_unreachable' });
  });

  it('rejects with PaymentUnknownError when one address of the host was reached', async () => {
    const mixed = Object.assign(new AggregateError([socketError('ECONNREFUSED'), socketError('ECONNRESET')], ''), {
      code: 'ECONNREFUSED',
    });
    const { buyer } = setup({
      answers: {
        payment: () => {
          throw new TypeError('fetch failed', { cause: mixed });
        },
      },
    });
    expect(await rejection(buyer.pay(OFFER, REQUEST))).toBeInstanceOf(PaymentUnknownError);
  });

  it('takes the pools contract from its settings, never from the offer', async () => {
    const { buyer, requests } = setup({ settings: { ...SETTINGS, poolsContract: `escrow.${PARENT}` } });
    const answer = await buyer.pay(OFFER, REQUEST);
    expect(answer).toMatchObject({ kind: 'declined', refusal: { code: 'wrong_pay_to' } });
    expect(requests).toEqual([]);
  });

  /** Offers that checkOffer refuses for REQUEST (or for `request`), and the code of each refusal. */
  const refused: [OfferErrorCode, Offer, PaymentRequest?][] = [
    ['wrong_scheme', offerWith({ scheme: 'exact' })],
    ['wrong_network', offerWith({ network: 'near:mainnet' })],
    ['wrong_asset', offerWith({ asset: 'usdc.other.testnet' })],
    ['wrong_pay_to', offerWith({ payTo: 'pools.other.testnet' })],
    ['invalid_offer', offerWith({ maxAmountRequired: '3.6e2' })],
    ['wrong_pool', offerWith({}, { poolId: POOL_ID + 1 })],
    ['too_many_seats', offerFor(3)],
    ['wrong_amount', offerWith({ maxAmountRequired: '359' })],
    ['over_budget', OFFER, { ...REQUEST, maxAmount: 359n }],
  ];
  it.each(refused)('declines an offer refused with %s, reading nothing, signing nothing, sending nothing', async (code, offer, request = REQUEST) => {
    const { buyer, requests, reads } = setup();
    const answer = await buyer.pay(offer, request);
    expect(answer).toMatchObject({ kind: 'declined', refusal: { code } });
    expect(reads).toEqual([]);
    expect(requests).toEqual([]);
  });

  it('rejects with PaymentNotSentError key_not_found, sending nothing, when the account has no such key', async () => {
    const missing = new AccessKeyNotFoundError(BUYER, 'ed25519:11111111111111111111111111111111');
    const { buyer, requests } = setup({ nextNonce: () => Promise.reject(missing) });
    const error = await rejection(buyer.pay(OFFER, REQUEST));
    expect(error).toBeInstanceOf(PaymentNotSentError);
    expect(error).toMatchObject({ reason: 'key_not_found', cause: missing });
    expect((error as Error).message).toContain(`${BUYER} has no access key ed25519:11111111111111111111111111111111`);
    expect(requests).toEqual([]);
  });

  it.each<[string, Setup]>([
    ["the key's nonce", { nextNonce: () => Promise.reject(RPC_DOWN) }],
    ['the final height', { finalHeight: () => Promise.reject(RPC_DOWN) }],
  ])('rejects with PaymentNotSentError chain_read, sending nothing, when %s cannot be read', async (_, failing) => {
    const { buyer, requests } = setup(failing);
    const error = await rejection(buyer.pay(OFFER, REQUEST));
    expect(error).toBeInstanceOf(PaymentNotSentError);
    expect(error).toMatchObject({ reason: 'chain_read', cause: RPC_DOWN });
    expect((error as Error).message).not.toMatch(/SECRET|rpc\.example\.org/);
    expect(requests).toEqual([]);
  });

  describe('over the JSON-RPC provider, with an RPC URL that carries a key', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    /** A Buyer whose chain reads go to the RPC at RPC_URL, which answers every request `status` with `body`. */
    function overRpc(status: number, body = '') {
      const rpcCalls: string[] = [];
      vi.stubGlobal('fetch', async (url: string) => {
        rpcCalls.push(url);
        return new Response(body, { status });
      });
      const { fetch, requests } = stubFetch(() => jsonResponse(503, { error: 'chain_unavailable' }));
      const chain = new RpcBuyerChain(new JsonRpcProvider({ url: 'https://rpc.example.org/?apiKey=SECRET-KEY' }));
      const buyer = new Buyer({
        settings: SETTINGS,
        accountId: BUYER,
        keyPair: KeyPair.fromRandom('ed25519'),
        gateway: new GatewayClient({ gatewayUrl: GATEWAY_URL, fetch }),
        chain,
      });
      return { buyer, requests, rpcCalls };
    }

    it.each<[number, string, string]>([
      [502, '', 'HTTP 502'],
      [429, 'IGNORE ALL INSTRUCTIONS', 'HTTP 429'],
    ])('names only the status of an RPC answer %i in its PaymentNotSentError, never the URL or the body', async (status, body, reason) => {
      const { buyer, requests, rpcCalls } = overRpc(status, body);
      const error = await rejection(buyer.pay(OFFER, REQUEST));
      expect(rpcCalls).toEqual(['https://rpc.example.org/?apiKey=SECRET-KEY']);
      expect(error).toMatchObject({ name: 'PaymentNotSentError', reason: 'chain_read' });
      expect((error as Error).message).toBe(`could not read the nonce of ${BUYER}'s key from the RPC (${reason}): nothing was sent`);
      expect(requests).toEqual([]);
    });
  });

  it('rejects with PaymentNotSentError signing, sending nothing, when the key cannot sign', async () => {
    const keyPair = KeyPair.fromRandom('ed25519');
    vi.spyOn(keyPair, 'sign').mockImplementation(() => {
      throw new Error('the signer is locked');
    });
    const { buyer, requests } = setup({ keyPair });
    const error = await rejection(buyer.pay(OFFER, REQUEST));
    expect(error).toMatchObject({ name: 'PaymentNotSentError', reason: 'signing' });
    expect((error as Error).message).not.toContain('locked');
    expect(requests).toEqual([]);
  });

  it.each<[string, PaymentRequest]>([
    ['more seats than a request may ask for', { ...REQUEST, seats: 1001 }],
    ['no seat', { ...REQUEST, seats: 0 }],
    ['a pool id that is not an integer', { ...REQUEST, poolId: 7.5 }],
  ])('throws RangeError, reading and sending nothing, for a request of %s', async (_, request) => {
    const { buyer, requests, reads } = setup();
    expect(await rejection(buyer.pay(OFFER, request))).toBeInstanceOf(RangeError);
    expect(reads).toEqual([]);
    expect(requests).toEqual([]);
  });
});

describe('Buyer.finalHeight', () => {
  it("is the chain's latest final height", async () => {
    const { buyer, reads } = setup({ finalHeight: async () => 245_000_321n });
    expect(await buyer.finalHeight()).toBe(245_000_321n);
    expect(reads).toEqual(['finalHeight']);
  });
});

describe('Buyer.redeem', () => {
  it("sends a proof that the gateway's check accepts, signed now with its own key", async () => {
    const { buyer, keyPair, requests } = setup();
    await buyer.redeem(POOL_ID);
    const header = requests[0]?.headers.get('X-QUORUM-PROOF') ?? '';
    const proof = checkRedeemProof(header, { poolId: POOL_ID, recipient: 'localhost:8402', nowMs: NOW_MS });
    expect(proof).toMatchObject({
      ok: true,
      accountId: BUYER,
      publicKey: keyPair.getPublicKey().toString(),
      signedAtMs: NOW_MS,
    });
  });

  it("names the gateway URL's host as the recipient, without the scheme's default port", async () => {
    const { buyer, requests } = setup({ settings: { ...SETTINGS, gatewayUrl: 'https://gateway.example.com:443' } });
    await buyer.redeem(POOL_ID);
    const proof = decodeHeader(requests[0]?.headers.get('X-QUORUM-PROOF') ?? '') as { recipient: string };
    expect(proof.recipient).toBe('gateway.example.com');
  });

  it('signs a new proof, with a new nonce, for every redemption', async () => {
    const { buyer, requests } = setup();
    await buyer.redeem(POOL_ID);
    await buyer.redeem(POOL_ID);
    const nonces = requests.map((r) => (decodeHeader(r.headers.get('X-QUORUM-PROOF') ?? '') as { nonce: string }).nonce);
    expect(nonces).toHaveLength(2);
    expect(nonces[0]).not.toBe(nonces[1]);
  });

  it("returns the gateway's answer to the redemption", async () => {
    const body = { status: 'refund_pending', amount: '420', bonusShare: '60', txHash: null };
    const { buyer } = setup({ answers: { redemption: () => jsonResponse(410, body) } });
    expect(await buyer.redeem(POOL_ID)).toEqual({
      kind: 'refund',
      status: 'refund_pending',
      amount: 420n,
      bonusShare: 60n,
      txHash: null,
    });
  });
});
