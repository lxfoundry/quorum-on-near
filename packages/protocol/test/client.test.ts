import { randomBytes } from 'node:crypto';
import { KeyPair } from 'near-api-js';
import { describe, expect, it } from 'vitest';
import { checkPaymentHeader } from '../src/checks.ts';
import type { CheckedPayment, ExpectedPayment } from '../src/checks.ts';
import { OfferRefusedError, buildPaymentHeader, buildRedeemProofHeader, checkOffer, maxBlockHeightFor } from '../src/client.ts';
import type { ExpectedOffer, OfferErrorCode, PaymentInput, ProofInput } from '../src/client.ts';
import { decodeHeader } from '../src/codec.ts';
import type { PaymentPayload } from '../src/codec.ts';
import type { PoolView } from '../src/contract.ts';
import { checkRedeemProof, nonceTimeMs } from '../src/nep413.ts';
import type { RedeemProof } from '../src/nep413.ts';
import { buildOffer } from '../src/offer.ts';
import type { Offer, OfferContext } from '../src/offer.ts';

const BUYER = 'buyer.testnet';
const MIN_GAS = 50_000_000_000_000n;
const MAX_GAS = 100_000_000_000_000n;
const NONCE = 42n;
const MAX_BLOCK_HEIGHT = 1_000_100n;
const RECIPIENT = 'localhost:8402';
const NOW_MS = 1_800_000_000_000;

const POOL: PoolView = {
  id: 7,
  seller: 'provider.parent.testnet',
  seat_price: '180',
  target: 192,
  taken: 148,
  deadline_ms: 1_800_000_600_000,
  bonus: '1728',
  max_seats_per_buyer: null,
  terms: '8 GPUs for 24 h; 1 seat = 1 GPU-hour',
  status: 'open',
  bonus_per_seat: '0',
  refund_cursor: 0,
  dust_sent: false,
  buyer_count: 30,
};
const CONTEXT: OfferContext = {
  network: 'near:testnet',
  gatewayUrl: 'http://localhost:8402',
  poolsContract: 'pools.parent.testnet',
  token: 'usdc.testnet',
  relayer: 'relay.parent.testnet',
  minGas: MIN_GAS,
  maxGas: MAX_GAS,
  maxTimeoutSeconds: 120,
};
/**
 * The buyer's own configuration, which agrees with the gateway's, its request for 2 seats of pool 7,
 * and a budget of their price at 180.
 */
const BUYER_CONFIG: ExpectedOffer = {
  network: 'near:testnet',
  token: 'usdc.testnet',
  poolsContract: 'pools.parent.testnet',
  poolId: 7,
  maxSeats: 2,
  maxAmount: 360n,
};
const OFFER = buildOffer(POOL, 2, CONTEXT);

/**
 * The 2-seat offer with `changes` applied and `extra` merged into its extra. The fields take any
 * value, as an offer read from a 402 body can.
 */
function offerWith(changes: Record<string, unknown>, extra: Record<string, unknown> = {}): Offer {
  return { ...OFFER, ...changes, extra: { ...OFFER.extra, ...extra } } as Offer;
}

/**
 * Offers that name other contracts, another pool or more seats than the buyer's, an amount that is
 * not the price of their seats or is above the budget, and the code each is refused with.
 */
const MISMATCHED: [string, OfferErrorCode, Offer][] = [
  ['a scheme other than quorum', 'wrong_scheme', offerWith({ scheme: 'exact' })],
  ['another network', 'wrong_network', offerWith({ network: 'near:mainnet' })],
  ['another token as its asset', 'wrong_asset', offerWith({ asset: 'usdc.other.testnet' })],
  ['another account to pay to', 'wrong_pay_to', offerWith({ payTo: 'pools.other.testnet' })],
  ['another pool than the one asked for', 'wrong_pool', offerWith({}, { poolId: 8 })],
  ['more seats than asked for, within the budget', 'too_many_seats', offerWith({ maxAmountRequired: '300' }, { seats: 3, seatPrice: '100' })],
  ['an amount above the budget', 'over_budget', offerWith({ maxAmountRequired: '362' }, { seatPrice: '181' })],
  ['an amount below the price of its seats', 'wrong_amount', offerWith({ maxAmountRequired: '359' })],
  ['an amount above the price of its seats', 'wrong_amount', offerWith({ maxAmountRequired: '361' })],
  ['the amount for 2 seats but 1 seat in extra', 'wrong_amount', offerWith({}, { seats: 1 })],
  ['the amount at another seat price than extra.seatPrice', 'wrong_amount', offerWith({}, { seatPrice: '179' })],
];

/** Offers with a field the payment is built from that is not of the offer's form. */
const MALFORMED: [string, Offer][] = [
  ['an extra that is not an object', { ...OFFER, extra: null } as unknown as Offer],
  ['a pool id that is a string', offerWith({}, { poolId: '7' })],
  ['a negative pool id', offerWith({}, { poolId: -1 })],
  ['0 seats', offerWith({ maxAmountRequired: '0' }, { seats: 0 })],
  ['a fractional seat count', offerWith({}, { seats: 1.5 })],
  ['a seat count beyond the safe integer range', offerWith({}, { seats: 2 ** 53 })],
  ['a seat price that is a number', offerWith({}, { seatPrice: 180 })],
  ['a seat price in hexadecimal', offerWith({}, { seatPrice: '0xb4' })],
  ['an amount with a leading zero', offerWith({ maxAmountRequired: '0360' })],
  ['a maxGas in exponent form', offerWith({}, { maxGas: '1e14' })],
];

/** Offers that fail several checks, and the code of the first in checkOffer's order. */
const FIRST_FAILURE: [string, OfferErrorCode, Offer][] = [
  ['a string pool id and more seats', 'invalid_offer', offerWith({ maxAmountRequired: '540' }, { poolId: '8', seats: 3 })],
  ['another pool and more seats, above the budget', 'wrong_pool', offerWith({ maxAmountRequired: '540' }, { poolId: 8, seats: 3 })],
  ['more seats, above the budget', 'too_many_seats', offerWith({ maxAmountRequired: '540' }, { seats: 3 })],
  ['an amount not the price of its seats, above the budget', 'wrong_amount', offerWith({ maxAmountRequired: '1000' })],
];

/** What the gateway expects of a payment that answers `offer`. */
function expectedFor(offer: Offer): ExpectedPayment {
  return {
    network: offer.network,
    token: offer.asset,
    poolsContract: offer.payTo,
    poolId: offer.extra.poolId,
    maxSeats: offer.extra.seats,
    seatPrice: BigInt(offer.extra.seatPrice),
    minGas: BigInt(offer.extra.minGas),
    maxGas: BigInt(offer.extra.maxGas),
  };
}

function paymentInput(overrides: Partial<PaymentInput> = {}): PaymentInput {
  return {
    keyPair: KeyPair.fromRandom('ed25519'),
    senderId: BUYER,
    nonce: NONCE,
    maxBlockHeight: MAX_BLOCK_HEIGHT,
    offer: OFFER,
    expected: BUYER_CONFIG,
    ...overrides,
  };
}

/** Builds a payment header and runs the gateway's static checks on it. */
async function checkedPayment(input: PaymentInput): Promise<CheckedPayment> {
  const result = checkPaymentHeader(await buildPaymentHeader(input), expectedFor(input.offer));
  if (!result.ok) throw new Error(`expected a valid payment, got ${result.code}: ${result.detail}`);
  return result.payment;
}

function proofInput(overrides: Partial<ProofInput> = {}): ProofInput {
  return {
    keyPair: KeyPair.fromRandom('ed25519'),
    accountId: BUYER,
    poolId: 7,
    recipient: RECIPIENT,
    nowMs: NOW_MS,
    ...overrides,
  };
}

function nonceOf(header: string): Uint8Array {
  return new Uint8Array(Buffer.from((decodeHeader(header) as RedeemProof).nonce, 'base64'));
}

describe('checkOffer', () => {
  it('accepts an offer that buildOffer made from the same configuration as the buyer', () => {
    expect(checkOffer(OFFER, BUYER_CONFIG)).toBeNull();
  });

  it('accepts a reduced offer for fewer seats', () => {
    expect(checkOffer(buildOffer(POOL, 1, CONTEXT), BUYER_CONFIG)).toBeNull();
  });

  it('accepts an offer whose amount is exactly the budget', () => {
    expect(checkOffer(OFFER, { ...BUYER_CONFIG, maxAmount: 360n })).toBeNull();
  });

  it('refuses the same offer as over_budget with a budget 1 below its amount', () => {
    expect(checkOffer(OFFER, { ...BUYER_CONFIG, maxAmount: 359n })?.code).toBe('over_budget');
  });

  it('accepts any seat price whose total is within the budget', () => {
    expect(checkOffer(offerWith({ maxAmountRequired: '300' }, { seats: 1, seatPrice: '300' }), BUYER_CONFIG)).toBeNull();
  });

  it.each(MISMATCHED)('refuses an offer with %s as %s', (_name, code, offer) => {
    expect(checkOffer(offer, BUYER_CONFIG)?.code).toBe(code);
  });

  it.each(MALFORMED)('refuses an offer with %s as invalid_offer', (_name, offer) => {
    expect(checkOffer(offer, BUYER_CONFIG)?.code).toBe('invalid_offer');
  });

  it.each(FIRST_FAILURE)('refuses an offer with %s as %s', (_name, code, offer) => {
    expect(checkOffer(offer, BUYER_CONFIG)?.code).toBe(code);
  });

  it('explains a refusal with the value the buyer is configured with', () => {
    expect(checkOffer(offerWith({ payTo: 'pools.other.testnet' }), BUYER_CONFIG)).toEqual({
      code: 'wrong_pay_to',
      detail: 'payTo is not pools.parent.testnet',
    });
  });

  it('explains a wrong amount with the price of the seats', () => {
    expect(checkOffer(offerWith({ maxAmountRequired: '359' }), BUYER_CONFIG)).toEqual({
      code: 'wrong_amount',
      detail: 'maxAmountRequired is not 360, the price of 2 seats at 180',
    });
  });

  it.each<[OfferErrorCode, Offer, string]>([
    ['wrong_pool', offerWith({}, { poolId: 8 }), 'extra.poolId is not 7, the pool asked for'],
    ['too_many_seats', offerWith({ maxAmountRequired: '300' }, { seats: 3, seatPrice: '100' }), 'extra.seats is above 2, the seats asked for'],
    ['over_budget', offerWith({ maxAmountRequired: '362' }, { seatPrice: '181' }), 'maxAmountRequired is above 360, the budget'],
  ])('explains %s with what the buyer asked for', (code, offer, detail) => {
    expect(checkOffer(offer, BUYER_CONFIG)).toEqual({ code, detail });
  });
});

describe('buildPaymentHeader', () => {
  it('builds a header that passes checkPaymentHeader for the offer it answers', async () => {
    const input = paymentInput();

    const result = checkPaymentHeader(await buildPaymentHeader(input), expectedFor(input.offer));

    expect(result.ok).toBe(true);
  });

  it('builds an x402 version 1 quorum payload on the offer network', async () => {
    const payload = decodeHeader(await buildPaymentHeader(paymentInput())) as PaymentPayload;

    expect(payload).toEqual({
      x402Version: 1,
      scheme: 'quorum',
      network: 'near:testnet',
      payload: { signedDelegate: expect.any(String) },
    });
  });

  it('signs for the given sender, key, nonce and max block height', async () => {
    const keyPair = KeyPair.fromRandom('ed25519');

    const payment = await checkedPayment(paymentInput({ keyPair }));

    expect(payment).toMatchObject({
      senderId: BUYER,
      publicKey: keyPair.getPublicKey().toString(),
      nonce: NONCE,
      maxBlockHeight: MAX_BLOCK_HEIGHT,
    });
  });

  it('pays for the seats and the amount of the offer', async () => {
    const offer = buildOffer(POOL, 1, CONTEXT);

    const payment = await checkedPayment(paymentInput({ offer }));

    expect(payment).toMatchObject({ poolId: 7, seats: 1, amount: 180n });
  });

  it('builds a header for a reduced offer that passes the checks for the seats first asked for', async () => {
    const offer = buildOffer(POOL, 1, CONTEXT);

    const result = checkPaymentHeader(await buildPaymentHeader(paymentInput({ offer })), {
      ...expectedFor(offer),
      maxSeats: 2,
    });

    expect(result).toMatchObject({ ok: true, payment: { seats: 1, amount: 180n } });
  });

  it('signs an offer whose amount is exactly the budget', async () => {
    const payment = await checkedPayment(paymentInput({ expected: { ...BUYER_CONFIG, maxAmount: 360n } }));

    expect(payment).toMatchObject({ seats: 2, amount: 360n });
  });

  it('uses the offer maxGas when no gas is given', async () => {
    expect((await checkedPayment(paymentInput())).gas).toBe(MAX_GAS);
  });

  it('uses the gas it is given instead of the offer maxGas', async () => {
    const gas = 75_000_000_000_000n;

    expect((await checkedPayment(paymentInput({ gas }))).gas).toBe(gas);
  });

  it.each(MISMATCHED)('refuses to sign an offer with %s, with an OfferRefusedError of code %s', async (_name, code, offer) => {
    const building = buildPaymentHeader(paymentInput({ offer }));

    await expect(building).rejects.toThrow(OfferRefusedError);
    await expect(building).rejects.toMatchObject({ code });
  });

  it.each(MALFORMED)('refuses to sign an offer with %s, as invalid_offer', async (_name, offer) => {
    await expect(buildPaymentHeader(paymentInput({ offer }))).rejects.toMatchObject({
      name: 'OfferRefusedError',
      code: 'invalid_offer',
    });
  });

  it('says in the error why the offer was refused', async () => {
    const offer = offerWith({ asset: 'usdc.other.testnet' });

    await expect(buildPaymentHeader(paymentInput({ offer }))).rejects.toThrow(
      'offer refused (wrong_asset): the asset is not usdc.testnet',
    );
  });

  it('signs an offer for other contracts when the buyer is configured with them', async () => {
    const other = { ...CONTEXT, token: 'usdc.other.testnet', poolsContract: 'pools.other.testnet' };
    const offer = buildOffer(POOL, 2, other);
    const expected = { ...BUYER_CONFIG, token: other.token, poolsContract: other.poolsContract };

    const payment = await checkedPayment(paymentInput({ offer, expected }));

    expect(payment).toMatchObject({ seats: 2, amount: 360n });
  });
});

describe('maxBlockHeightFor', () => {
  it('adds the timeout, converted to blocks, to the current height', () => {
    expect(maxBlockHeightFor(1_000_000n, 120, 1_000)).toBe(1_000_120n);
  });

  it('rounds a fractional number of blocks down', () => {
    // 120 s at 700 ms a block is 171.43 blocks.
    expect(maxBlockHeightFor(1_000_000n, 120, 700)).toBe(1_000_171n);
  });

  it('adds nothing when the timeout is shorter than one block', () => {
    expect(maxBlockHeightFor(1_000_000n, 1, 1_500)).toBe(1_000_000n);
  });
});

describe('buildRedeemProofHeader', () => {
  it('builds a proof that passes checkRedeemProof', async () => {
    const header = await buildRedeemProofHeader(proofInput());

    const result = checkRedeemProof(header, { poolId: 7, recipient: RECIPIENT, nowMs: NOW_MS });

    expect(result).toMatchObject({ ok: true, signedAtMs: NOW_MS });
  });

  it('signs for the given account with the key pair public key', async () => {
    const keyPair = KeyPair.fromRandom('ed25519');

    const proof = decodeHeader(await buildRedeemProofHeader(proofInput({ keyPair }))) as RedeemProof;

    expect(proof).toMatchObject({
      accountId: BUYER,
      publicKey: keyPair.getPublicKey().toString(),
      message: 'quorum:redeem:7',
      recipient: RECIPIENT,
    });
  });

  it('puts nowMs in the first 8 bytes of the nonce, big-endian', async () => {
    const nonce = nonceOf(await buildRedeemProofHeader(proofInput()));

    expect(Buffer.from(nonce.subarray(0, 8)).readBigUInt64BE()).toBe(BigInt(NOW_MS));
    expect(nonceTimeMs(nonce)).toBe(NOW_MS);
  });

  it('uses the given random bytes for the last 24 bytes of the nonce', async () => {
    const random = new Uint8Array(randomBytes(24));

    const nonce = nonceOf(await buildRedeemProofHeader(proofInput({ random })));

    expect(nonce).toHaveLength(32);
    expect(nonce.subarray(8)).toEqual(random);
  });

  it('generates fresh random bytes when none are given', async () => {
    const keyPair = KeyPair.fromRandom('ed25519');

    const first = nonceOf(await buildRedeemProofHeader(proofInput({ keyPair })));
    const second = nonceOf(await buildRedeemProofHeader(proofInput({ keyPair })));

    expect(first.subarray(0, 8)).toEqual(second.subarray(0, 8));
    expect(first.subarray(8)).not.toEqual(second.subarray(8));
  });

  it('refuses random bytes that are not 24 bytes long', async () => {
    await expect(buildRedeemProofHeader(proofInput({ random: new Uint8Array(23) }))).rejects.toThrow(RangeError);
  });

  it('refuses a nowMs that is not a non-negative integer', async () => {
    await expect(buildRedeemProofHeader(proofInput({ nowMs: -1 }))).rejects.toThrow(RangeError);
  });
});
