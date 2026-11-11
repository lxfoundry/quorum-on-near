import {
  type Action,
  KeyPair,
  KeyPairSigner,
  actions,
  buildDelegateAction,
  encodeSignedDelegate as nearEncodeSignedDelegate,
} from 'near-api-js';
import { describe, expect, it } from 'vitest';
import { checkPaymentHeader } from '../src/checks.ts';
import type { CheckedPayment, ExpectedPayment, StaticErrorCode } from '../src/checks.ts';
import { buildPaymentHeader } from '../src/client.ts';
import type { ExpectedOffer } from '../src/client.ts';
import { decodeHeader, encodeHeader } from '../src/codec.ts';
import type { PaymentPayload } from '../src/codec.ts';
import { commitMsg } from '../src/contract.ts';
import type { PoolView } from '../src/contract.ts';
import { decodeSignedDelegate, delegateHash, encodeSignedDelegate } from '../src/delegate.ts';
import { buildOffer } from '../src/offer.ts';

const NETWORK = 'near:testnet';
const TOKEN = 'usdc.testnet';
const POOLS = 'pools.parent.testnet';
const BUYER = 'buyer.testnet';
const POOL_ID = 7;
const SEATS = 2;
const AMOUNT = '360';
const MIN_GAS = 50_000_000_000_000n;
const MAX_GAS = 100_000_000_000_000n;
const NONCE = 42n;
const MAX_BLOCK_HEIGHT = 1_000_100n;

const POOL: PoolView = {
  id: POOL_ID,
  seller: 'provider.parent.testnet',
  seat_price: '180',
  target: 192,
  taken: 148,
  deadline_ms: 1_800_000_000_000,
  bonus: '1728',
  max_seats_per_buyer: null,
  terms: '8 GPUs for 24 h; 1 seat = 1 GPU-hour',
  status: 'open',
  bonus_per_seat: '0',
  refund_cursor: 0,
  dust_sent: false,
  buyer_count: 30,
};
const OFFER = buildOffer(POOL, SEATS, {
  network: NETWORK,
  gatewayUrl: 'http://localhost:8402',
  poolsContract: POOLS,
  token: TOKEN,
  relayer: 'relay.parent.testnet',
  minGas: MIN_GAS,
  maxGas: MAX_GAS,
  maxTimeoutSeconds: 120,
});
const EXPECTED: ExpectedPayment = {
  network: NETWORK,
  token: TOKEN,
  poolsContract: POOLS,
  poolId: POOL_ID,
  maxSeats: SEATS,
  seatPrice: 180n,
  minGas: MIN_GAS,
  maxGas: MAX_GAS,
};
/** What the buyer requires of the offer it signs: the same contracts, pool and seats, for at most their price. */
const BUYER_CONFIG: ExpectedOffer = {
  network: NETWORK,
  token: TOKEN,
  poolsContract: POOLS,
  poolId: POOL_ID,
  maxSeats: SEATS,
  maxAmount: BigInt(AMOUNT),
};

function check(header: string): ReturnType<typeof checkPaymentHeader> {
  return checkPaymentHeader(header, EXPECTED);
}

/** The code of the first failing check, or `ok`. */
function codeOf(header: string): StaticErrorCode | 'ok' {
  const result = check(header);
  return result.ok ? 'ok' : result.code;
}

function paymentOf(header: string): CheckedPayment {
  const result = check(header);
  if (!result.ok) throw new Error(`expected a valid payment, got ${result.code}: ${result.detail}`);
  return result.payment;
}

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

/** The Borsh bytes inside an `X-PAYMENT` header. */
function signedDelegateBytes(header: string): Uint8Array {
  const { payload } = decodeHeader(header) as PaymentPayload;
  return new Uint8Array(Buffer.from(payload.signedDelegate, 'base64'));
}

function buyerHeader(gas?: bigint): Promise<string> {
  return buildPaymentHeader({
    keyPair: KeyPair.fromRandom('ed25519'),
    senderId: BUYER,
    nonce: NONCE,
    maxBlockHeight: MAX_BLOCK_HEIGHT,
    offer: OFFER,
    expected: BUYER_CONFIG,
    gas,
  });
}

function commitArgs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { receiver_id: POOLS, amount: AMOUNT, msg: commitMsg(POOL_ID, SEATS), ...overrides };
}

interface CallOptions {
  methodName?: string;
  /** An object is sent as JSON; bytes are sent as they are. */
  args?: object | Uint8Array;
  gas?: bigint;
  deposit?: bigint;
}

function commitCall(options: CallOptions = {}): Action {
  return actions.functionCall(
    options.methodName ?? 'ft_transfer_call',
    options.args ?? commitArgs(),
    options.gas ?? MIN_GAS,
    options.deposit ?? 1n,
  );
}

interface DelegateOptions {
  keyPair?: KeyPair;
  senderId?: string;
  receiverId?: string;
  actions?: Action[];
}

/** Builds and signs a delegate with near-api-js directly, so that it can be made wrong in one way. */
async function signDelegate(options: DelegateOptions = {}): Promise<Uint8Array> {
  const keyPair = options.keyPair ?? KeyPair.fromRandom('ed25519');
  const delegateAction = buildDelegateAction({
    senderId: options.senderId ?? BUYER,
    receiverId: options.receiverId ?? TOKEN,
    actions: options.actions ?? [commitCall()],
    nonce: NONCE,
    maxBlockHeight: MAX_BLOCK_HEIGHT,
    publicKey: keyPair.getPublicKey(),
  });
  const { signedDelegate } = await new KeyPairSigner(keyPair).signDelegateAction(delegateAction);
  return nearEncodeSignedDelegate(signedDelegate);
}

function paymentHeader(signedDelegate: string, overrides: Record<string, unknown> = {}): string {
  return encodeHeader({ x402Version: 1, scheme: 'quorum', network: NETWORK, payload: { signedDelegate }, ...overrides });
}

async function delegateHeader(options: DelegateOptions = {}): Promise<string> {
  return paymentHeader(base64(await signDelegate(options)));
}

function callHeader(options: CallOptions): Promise<string> {
  return delegateHeader({ actions: [commitCall(options)] });
}

function argsHeader(overrides: Record<string, unknown>): Promise<string> {
  return callHeader({ args: commitArgs(overrides) });
}

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe('checkPaymentHeader', () => {
  describe('a valid payment', () => {
    it('accepts a payment built by buildPaymentHeader and returns all of its fields', async () => {
      const keyPair = KeyPair.fromRandom('ed25519');
      const header = await buildPaymentHeader({
        keyPair,
        senderId: BUYER,
        nonce: NONCE,
        maxBlockHeight: MAX_BLOCK_HEIGHT,
        offer: OFFER,
        expected: BUYER_CONFIG,
      });

      expect(paymentOf(header)).toEqual({
        signedDelegate: decodeSignedDelegate(signedDelegateBytes(header)),
        senderId: BUYER,
        publicKey: keyPair.getPublicKey().toString(),
        nonce: NONCE,
        maxBlockHeight: MAX_BLOCK_HEIGHT,
        gas: MAX_GAS,
        amount: 360n,
        poolId: POOL_ID,
        seats: SEATS,
      });
    });

    it('returns a signed delegate that re-encodes to the bytes in the header', async () => {
      const header = await buyerHeader();

      expect(encodeSignedDelegate(paymentOf(header).signedDelegate)).toEqual(signedDelegateBytes(header));
    });

    it('accepts gas of exactly minGas', async () => {
      expect(paymentOf(await buyerHeader(MIN_GAS)).gas).toBe(MIN_GAS);
    });

    it('accepts gas of exactly maxGas', async () => {
      expect(paymentOf(await buyerHeader(MAX_GAS)).gas).toBe(MAX_GAS);
    });

    it('accepts a delegate built field by field with near-api-js', async () => {
      expect(codeOf(await delegateHeader())).toBe('ok');
    });

    it('accepts a delegate signed with a secp256k1 key', async () => {
      const keyPair = KeyPair.fromRandom('secp256k1');

      expect(paymentOf(await delegateHeader({ keyPair })).publicKey).toBe(keyPair.getPublicKey().toString());
    });

    it('accepts a msg with whitespace and its keys in another order', async () => {
      const msg = '{ "commit": { "seats": 2, "pool_id": 7 } }';

      expect(codeOf(await argsHeader({ msg }))).toBe('ok');
    });

    it('accepts compact args with their keys in another order', async () => {
      const args = { msg: commitMsg(POOL_ID, SEATS), amount: AMOUNT, receiver_id: POOLS };

      expect(codeOf(await callHeader({ args }))).toBe('ok');
    });

    it('accepts a payment for fewer seats than maxSeats and returns its own seat count', async () => {
      const payment = paymentOf(await argsHeader({ amount: '180', msg: commitMsg(POOL_ID, 1) }));

      expect(payment).toMatchObject({ seats: 1, amount: 180n });
    });
  });

  describe('check 1: the payload', () => {
    it('rejects a header that is not base64 as invalid_payload', () => {
      expect(codeOf('not base64!')).toBe('invalid_payload');
    });

    it('rejects base64 of text that is not JSON as invalid_payload', () => {
      expect(codeOf(Buffer.from('not json').toString('base64'))).toBe('invalid_payload');
    });

    it.each([null, [], 'quorum', 1])('rejects a header whose JSON is %j as invalid_payload', (value) => {
      expect(codeOf(encodeHeader(value))).toBe('invalid_payload');
    });

    it('rejects an x402Version other than 1 as invalid_payload', async () => {
      const signedDelegate = base64(await signDelegate());

      expect(codeOf(paymentHeader(signedDelegate, { x402Version: 2 }))).toBe('invalid_payload');
    });

    it('rejects a scheme other than quorum as invalid_payload', async () => {
      const signedDelegate = base64(await signDelegate());

      expect(codeOf(paymentHeader(signedDelegate, { scheme: 'exact' }))).toBe('invalid_payload');
    });

    it('rejects a network other than the expected one as invalid_payload', async () => {
      const signedDelegate = base64(await signDelegate());

      expect(codeOf(paymentHeader(signedDelegate, { network: 'near:mainnet' }))).toBe('invalid_payload');
    });

    it('rejects a payload without signedDelegate as invalid_payload', () => {
      expect(codeOf(encodeHeader({ x402Version: 1, scheme: 'quorum', network: NETWORK, payload: {} }))).toBe(
        'invalid_payload',
      );
    });

    it('rejects a payload that is not an object as invalid_payload', () => {
      expect(codeOf(encodeHeader({ x402Version: 1, scheme: 'quorum', network: NETWORK, payload: null }))).toBe(
        'invalid_payload',
      );
    });

    it('rejects a signedDelegate that is not a Borsh SignedDelegate as invalid_payload', () => {
      expect(codeOf(paymentHeader(base64(new Uint8Array([1, 2, 3, 4]))))).toBe('invalid_payload');
    });

    it('rejects a signedDelegate with trailing bytes as invalid_payload', async () => {
      const bytes = await signDelegate();

      expect(codeOf(paymentHeader(base64(new Uint8Array([...bytes, 0]))))).toBe('invalid_payload');
    });

    it('rejects a signedDelegate whose base64 has a line break in it as invalid_payload', async () => {
      const encoded = base64(await signDelegate());
      const signedDelegate = `${encoded.slice(0, 40)}\n${encoded.slice(40)}`;

      expect(codeOf(paymentHeader(signedDelegate))).toBe('invalid_payload');
    });

    it('rejects a delegate whose sender is not a valid account id as invalid_payload', async () => {
      expect(codeOf(await delegateHeader({ senderId: 'Buyer.Testnet' }))).toBe('invalid_payload');
    });

    it('rejects a delegate signed by another key as invalid_signature', async () => {
      const signed = decodeSignedDelegate(await signDelegate());
      const other = KeyPair.fromRandom('ed25519').sign(delegateHash(signed.delegateAction)).signature;
      const forged = { ...signed, signature: { ed25519Signature: { data: other } } };

      expect(codeOf(paymentHeader(base64(encodeSignedDelegate(forged))))).toBe('invalid_signature');
    });

    it('rejects a delegate changed after signing as invalid_signature', async () => {
      const signed = decodeSignedDelegate(await signDelegate());
      const tampered = {
        ...signed,
        delegateAction: { ...signed.delegateAction, maxBlockHeight: MAX_BLOCK_HEIGHT + 1_000n },
      };

      expect(codeOf(paymentHeader(base64(encodeSignedDelegate(tampered))))).toBe('invalid_signature');
    });
  });

  describe('check 2: the action', () => {
    it('rejects a delegate to a receiver other than the token as wrong_receiver', async () => {
      expect(codeOf(await delegateHeader({ receiverId: 'other-token.testnet' }))).toBe('wrong_receiver');
    });

    it('rejects a delegate with no actions as wrong_method', async () => {
      expect(codeOf(await delegateHeader({ actions: [] }))).toBe('wrong_method');
    });

    it('rejects a delegate with two actions as wrong_method', async () => {
      expect(codeOf(await delegateHeader({ actions: [commitCall(), commitCall()] }))).toBe('wrong_method');
    });

    it('rejects a delegate whose only action is a transfer as wrong_method', async () => {
      expect(codeOf(await delegateHeader({ actions: [actions.transfer(1n)] }))).toBe('wrong_method');
    });

    it('rejects a call to a method other than ft_transfer_call as wrong_method', async () => {
      expect(codeOf(await callHeader({ methodName: 'ft_transfer' }))).toBe('wrong_method');
    });

    it('rejects a deposit of 0 as wrong_deposit', async () => {
      expect(codeOf(await callHeader({ deposit: 0n }))).toBe('wrong_deposit');
    });

    it('rejects a deposit of 2 yoctoNEAR as wrong_deposit', async () => {
      expect(codeOf(await callHeader({ deposit: 2n }))).toBe('wrong_deposit');
    });

    it('rejects gas below minGas as gas_too_low', async () => {
      expect(codeOf(await callHeader({ gas: MIN_GAS - 1n }))).toBe('gas_too_low');
    });

    it('rejects gas above maxGas as gas_too_high', async () => {
      expect(codeOf(await callHeader({ gas: MAX_GAS + 1n }))).toBe('gas_too_high');
    });

    it('reports the first failing check when several fail', async () => {
      const header = await delegateHeader({ receiverId: 'other-token.testnet', actions: [commitCall({ deposit: 0n })] });

      expect(codeOf(header)).toBe('wrong_receiver');
    });
  });

  describe('check 3: the arguments', () => {
    it('rejects args with a memo as wrong_args', async () => {
      expect(codeOf(await argsHeader({ memo: 'hello' }))).toBe('wrong_args');
    });

    it('rejects args with a null memo as wrong_args', async () => {
      expect(codeOf(await argsHeader({ memo: null }))).toBe('wrong_args');
    });

    it('rejects args without msg as wrong_args', async () => {
      expect(codeOf(await argsHeader({ msg: undefined }))).toBe('wrong_args');
    });

    it('rejects a receiver_id other than the pools contract as wrong_args', async () => {
      expect(codeOf(await argsHeader({ receiver_id: 'other-pools.testnet' }))).toBe('wrong_args');
    });

    it.each([360, '0360', '360.0', ' 360', '-360', '3.6e2'])(
      'rejects the amount %j, which is not a decimal string, as wrong_args',
      async (amount) => {
        expect(codeOf(await argsHeader({ amount }))).toBe('wrong_args');
      },
    );

    it('rejects args that are not JSON as wrong_args', async () => {
      expect(codeOf(await callHeader({ args: utf8('receiver_id=pools.parent.testnet') }))).toBe('wrong_args');
    });

    it('rejects args that are a JSON array as wrong_args', async () => {
      expect(codeOf(await callHeader({ args: utf8(JSON.stringify([POOLS, AMOUNT, commitMsg(7, 2)])) }))).toBe(
        'wrong_args',
      );
    });

    it('rejects args that are not valid UTF-8 as wrong_args', async () => {
      const args = new Uint8Array([...utf8(JSON.stringify(commitArgs())).slice(0, -2), 0xff, ...utf8('"}')]);

      expect(codeOf(await callHeader({ args }))).toBe('wrong_args');
    });

    it('rejects args that start with a byte order mark as wrong_args', async () => {
      const args = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8(JSON.stringify(commitArgs()))]);

      expect(codeOf(await callHeader({ args }))).toBe('wrong_args');
    });

    it('rejects args with a duplicated key as wrong_args', async () => {
      const msg = JSON.stringify(commitMsg(POOL_ID, SEATS));
      const text = `{"receiver_id":"other-pools.testnet","receiver_id":"${POOLS}","amount":"${AMOUNT}","msg":${msg}}`;

      expect(codeOf(await callHeader({ args: utf8(text) }))).toBe('wrong_args');
    });

    it.each([
      ['indented', JSON.stringify(commitArgs(), null, 2)],
      ['followed by a newline', `${JSON.stringify(commitArgs())}\n`],
      ['with an escaped character', JSON.stringify(commitArgs()).replace(`"${AMOUNT}"`, String.raw`"\u0033\u0036\u0030"`)],
    ])('rejects args that are not compact JSON (%s) as wrong_args', async (_, text) => {
      expect(codeOf(await callHeader({ args: utf8(text) }))).toBe('wrong_args');
    });

    it('rejects a msg that is not JSON as wrong_args', async () => {
      expect(codeOf(await argsHeader({ msg: 'commit 7 2' }))).toBe('wrong_args');
    });

    it('rejects a msg with an extra top-level key as wrong_args', async () => {
      const msg = JSON.stringify({ commit: { pool_id: POOL_ID, seats: SEATS }, note: 'x' });

      expect(codeOf(await argsHeader({ msg }))).toBe('wrong_args');
    });

    it('rejects a msg with an extra key inside commit as wrong_args', async () => {
      const msg = JSON.stringify({ commit: { pool_id: POOL_ID, seats: SEATS, note: 'x' } });

      expect(codeOf(await argsHeader({ msg }))).toBe('wrong_args');
    });

    it('rejects a msg that is an open instead of a commit as wrong_args', async () => {
      const msg = JSON.stringify({ open: { pool_id: POOL_ID, seats: SEATS } });

      expect(codeOf(await argsHeader({ msg }))).toBe('wrong_args');
    });

    it('rejects a msg whose seats is a string as wrong_args', async () => {
      const msg = JSON.stringify({ commit: { pool_id: POOL_ID, seats: '2' } });

      expect(codeOf(await argsHeader({ msg }))).toBe('wrong_args');
    });

    it('rejects a msg whose pool_id is not an integer as wrong_args', async () => {
      const msg = JSON.stringify({ commit: { pool_id: 7.5, seats: SEATS } });

      expect(codeOf(await argsHeader({ msg }))).toBe('wrong_args');
    });

    it.each(['{"commit":{"pool_id":7.0,"seats":2}}', '{"commit":{"pool_id":7,"seats":2e0}}'])(
      'rejects the msg %s, whose integers the contract cannot parse, as wrong_args',
      async (msg) => {
        expect(codeOf(await argsHeader({ msg }))).toBe('wrong_args');
      },
    );

    it('rejects a msg with a duplicated key as wrong_args', async () => {
      const msg = '{"commit":{"pool_id":8,"pool_id":7,"seats":2}}';

      expect(codeOf(await argsHeader({ msg }))).toBe('wrong_args');
    });

    it('rejects an amount other than seats times seat price as wrong_amount', async () => {
      expect(codeOf(await argsHeader({ amount: '359' }))).toBe('wrong_amount');
    });

    it('rejects an amount that pays for maxSeats when the msg commits to fewer seats as wrong_amount', async () => {
      expect(codeOf(await argsHeader({ amount: AMOUNT, msg: commitMsg(POOL_ID, 1) }))).toBe('wrong_amount');
    });

    it('rejects a msg that is not JSON as wrong_args even when the amount is also wrong', async () => {
      expect(codeOf(await argsHeader({ amount: '180', msg: 'commit 7 2' }))).toBe('wrong_args');
    });

    it('rejects a commit for another pool as wrong_pool', async () => {
      expect(codeOf(await argsHeader({ msg: commitMsg(8, SEATS) }))).toBe('wrong_pool');
    });

    it('rejects a commit for 0 seats as wrong_pool', async () => {
      expect(codeOf(await argsHeader({ amount: '0', msg: commitMsg(POOL_ID, 0) }))).toBe('wrong_pool');
    });

    it('rejects a commit for a negative number of seats as wrong_pool', async () => {
      expect(codeOf(await argsHeader({ msg: commitMsg(POOL_ID, -1) }))).toBe('wrong_pool');
    });

    it('rejects a commit for more seats than maxSeats, priced for those seats, as wrong_pool', async () => {
      expect(codeOf(await argsHeader({ amount: '540', msg: commitMsg(POOL_ID, 3) }))).toBe('wrong_pool');
    });
  });

  it('explains a failure in its detail', async () => {
    const result = check(await argsHeader({ amount: '359' }));

    expect(result).toEqual({ ok: false, code: 'wrong_amount', detail: expect.stringMatching(/359.*360/) });
  });
});
