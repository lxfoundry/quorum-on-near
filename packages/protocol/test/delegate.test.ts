import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToNumberLE, concatBytes } from '@noble/curves/utils.js';
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import {
  type Action,
  KeyPair,
  KeyType,
  PublicKey,
  KeyPairSigner,
  actions,
  buildDelegateAction,
  createTransaction,
  decodeTransaction,
  encodeDelegateAction,
  encodeSignedDelegate as nearEncodeSignedDelegate,
  encodeTransaction,
} from 'near-api-js';
import { describe, expect, it } from 'vitest';
import { commitMsg } from '../src/contract.ts';
import {
  type DecodedSignedDelegate,
  decodeSignedDelegate,
  delegateHash,
  delegatePublicKey,
  encodeSignedDelegate,
  onlyFunctionCall,
  verifyDelegateSignature,
} from '../src/delegate.ts';

const BUYER = 'buyer.testnet';
const TOKEN = 'token.testnet';
const POOLS = 'pools.parent.testnet';
const GAS = 50_000_000_000_000n;

function ascii(text: string): number[] {
  return [...Buffer.from(text, 'ascii')];
}

/** A fixed 32-byte ed25519 public key (bytes 1 to 32), with no secret key behind it. */
const PUBLIC_KEY = Array.from({ length: 32 }, (_, i) => i + 1);
/** An all-zero signature: decodeSignedDelegate does not verify signatures. */
const SIGNATURE = new Array<number>(64).fill(0);

/**
 * A DelegateAction laid out by hand from NEP-366 and nearcore's Borsh types (strings and vectors
 * have a u32 little-endian length, integers are little-endian), so that near-api-js is not its own
 * oracle.
 */
const DELEGATE_ACTION_BYTES = [
  // sender_id: AccountId, a string.
  13, 0, 0, 0, ...ascii(BUYER),
  // receiver_id: AccountId.
  13, 0, 0, 0, ...ascii(TOKEN),
  // actions: Vec<NonDelegateAction>, one action.
  1, 0, 0, 0,
  // Action::FunctionCall is variant 2.
  2,
  // method_name: String.
  4, 0, 0, 0, ...ascii('ping'),
  // args: Vec<u8>.
  2, 0, 0, 0, ...ascii('{}'),
  // gas: u64, 50 Tgas (0x2d79883d2000).
  0x00, 0x20, 0x3d, 0x88, 0x79, 0x2d, 0x00, 0x00,
  // deposit: u128, 1 yoctoNEAR.
  1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  // nonce: u64, 42.
  42, 0, 0, 0, 0, 0, 0, 0,
  // max_block_height: u64, 1,000,100 (0x0f42a4).
  0xa4, 0x42, 0x0f, 0x00, 0x00, 0x00, 0x00, 0x00,
  // public_key: KeyType::ED25519 (0), then 32 bytes.
  0, ...PUBLIC_KEY,
];
/** The SignedDelegateAction: the DelegateAction, then the signature, KeyType::ED25519 (0) and 64 bytes. */
const SIGNED_DELEGATE_BYTES = Uint8Array.from([...DELEGATE_ACTION_BYTES, 0, ...SIGNATURE]);
/** The fields of SIGNED_DELEGATE_BYTES, as decodeSignedDelegate returns them. */
const SIGNED_DELEGATE: DecodedSignedDelegate = {
  delegateAction: {
    senderId: BUYER,
    receiverId: TOKEN,
    actions: [{ functionCall: { methodName: 'ping', args: ascii('{}'), gas: GAS, deposit: 1n } }],
    nonce: 42n,
    maxBlockHeight: 1_000_100n,
    publicKey: { ed25519Key: { data: PUBLIC_KEY } },
  },
  signature: { ed25519Signature: { data: SIGNATURE } },
};

function commitCall(amount = '360'): Action {
  return actions.functionCall(
    'ft_transfer_call',
    { receiver_id: POOLS, amount, msg: commitMsg(7, 2) },
    GAS,
    1n,
  );
}

/** Builds and signs a delegate with near-api-js, the way a buyer's client does. */
async function signWithNear(keyPair: KeyPair, delegateActions: Action[] = [commitCall()]) {
  const delegateAction = buildDelegateAction({
    senderId: BUYER,
    receiverId: TOKEN,
    actions: delegateActions,
    nonce: 42n,
    maxBlockHeight: 1_000_100n,
    publicKey: keyPair.getPublicKey(),
  });
  const { signedDelegate } = await new KeyPairSigner(keyPair).signDelegateAction(delegateAction);
  return { delegateAction, bytes: nearEncodeSignedDelegate(signedDelegate) };
}

function withArgs(signed: DecodedSignedDelegate, args: Uint8Array): DecodedSignedDelegate {
  const call = onlyFunctionCall(signed.delegateAction);
  if (call === null) throw new Error('expected a FunctionCall');
  return {
    ...signed,
    delegateAction: { ...signed.delegateAction, actions: [{ functionCall: { ...call, args } }] },
  };
}

/** The same delegate with byte `index` of its signature set to `value`, after a decode round trip. */
function withSignatureByte(signed: DecodedSignedDelegate, index: number, value: number): DecodedSignedDelegate {
  if (!('secp256k1Signature' in signed.signature)) throw new Error('expected a secp256k1 signature');
  const data = Uint8Array.from(signed.signature.secp256k1Signature.data);
  data[index] = value;
  // The round trip is what the gateway does with a buyer's bytes: it decodes them before verifying.
  return decodeSignedDelegate(
    encodeSignedDelegate({ ...signed, signature: { secp256k1Signature: { data } } }),
  );
}

/** The order of the ed25519 base point's prime-order subgroup (called L in RFC 8032). */
const ED25519_ORDER = ed25519.Point.Fn.ORDER;
/** The prime 2^255 - 19 that the ed25519 coordinates are taken modulo. */
const ED25519_FIELD = 2n ** 255n - 19n;
/** A fixed ed25519 key and nonce for the signatures crafted below. */
const CRAFT_SEED = new Uint8Array(32).fill(7);
const CRAFT_NONCE = 0x1234_5678_9abc_def0_1234_5678_9abc_def0n;

function littleEndian32(value: bigint): Uint8Array {
  return Uint8Array.from({ length: 32 }, (_, i) => Number((value >> BigInt(8 * i)) & 0xffn));
}

/**
 * A delegate by the key behind CRAFT_SEED whose signature starts with exactly `rBytes`, followed by
 * the scalar s = r + k * a (k is the challenge hash and a the secret scalar), so that
 * [s]B - [k]A = [r]B. The signature is the textbook one when `rBytes` encodes [r]B, and is off by
 * whatever else `rBytes` encodes.
 */
function craftEd25519(rBytes: Uint8Array, r: bigint): DecodedSignedDelegate {
  const { scalar, pointBytes } = ed25519.utils.getExtendedPublicKey(CRAFT_SEED);
  const delegateAction = {
    ...SIGNED_DELEGATE.delegateAction,
    publicKey: { ed25519Key: { data: pointBytes } },
  };
  const k =
    bytesToNumberLE(sha512(concatBytes(rBytes, pointBytes, delegateHash(delegateAction)))) % ED25519_ORDER;
  const data = concatBytes(rBytes, littleEndian32((r + k * scalar) % ED25519_ORDER));
  // The round trip is what the gateway does with a buyer's bytes: it decodes them before verifying.
  return decodeSignedDelegate(
    encodeSignedDelegate({ delegateAction, signature: { ed25519Signature: { data } } }),
  );
}

/**
 * Whether near-api-js's PublicKey.verify takes the signature. The gateway relied on that alone,
 * which is looser than nearcore's own check for the signatures crafted in these tests.
 */
function nearApiJsAccepts(signed: DecodedSignedDelegate): boolean {
  const { publicKey } = signed.delegateAction;
  const { signature } = signed;
  const key =
    'ed25519Key' in publicKey
      ? new PublicKey({ keyType: KeyType.ED25519, data: Uint8Array.from(publicKey.ed25519Key.data) })
      : new PublicKey({ keyType: KeyType.SECP256K1, data: Uint8Array.from(publicKey.secp256k1Key.data) });
  const data =
    'ed25519Signature' in signature ? signature.ed25519Signature.data : signature.secp256k1Signature.data;
  return key.verify(delegateHash(signed.delegateAction), Uint8Array.from(data));
}

describe('decodeSignedDelegate', () => {
  it('decodes a delegate signed with near-api-js into its fields', async () => {
    const keyPair = KeyPair.fromRandom('ed25519');
    const { bytes } = await signWithNear(keyPair);

    const { delegateAction } = decodeSignedDelegate(bytes);

    expect(delegateAction.senderId).toBe(BUYER);
    expect(delegateAction.receiverId).toBe(TOKEN);
    expect(delegateAction.nonce).toBe(42n);
    expect(delegateAction.maxBlockHeight).toBe(1_000_100n);
    expect(onlyFunctionCall(delegateAction)).toMatchObject({
      methodName: 'ft_transfer_call',
      gas: GAS,
      deposit: 1n,
    });
  });

  it('decodes a SignedDelegate laid out by hand from NEP-366 into its fields', () => {
    expect(decodeSignedDelegate(SIGNED_DELEGATE_BYTES)).toEqual(SIGNED_DELEGATE);
  });

  it('re-encodes a decoded delegate to the identical bytes', async () => {
    const { bytes } = await signWithNear(KeyPair.fromRandom('ed25519'));

    expect(encodeSignedDelegate(decodeSignedDelegate(bytes))).toEqual(bytes);
  });

  it('throws on trailing bytes', async () => {
    const { bytes } = await signWithNear(KeyPair.fromRandom('ed25519'));

    expect(() => decodeSignedDelegate(new Uint8Array([...bytes, 0]))).toThrow();
  });

  it('throws on truncated input', async () => {
    const { bytes } = await signWithNear(KeyPair.fromRandom('ed25519'));

    expect(() => decodeSignedDelegate(bytes.subarray(0, bytes.length - 1))).toThrow();
  });

  it('throws on empty input', () => {
    expect(() => decodeSignedDelegate(new Uint8Array())).toThrow();
  });

  it('throws on a non-canonical encoding that decodes to the same fields', async () => {
    const { bytes } = await signWithNear(KeyPair.fromRandom('ed25519'));
    // senderId is a u32 length then UTF-8; 0xc1 0xa2 is an overlong form of its first letter, "b".
    const overlong = new Uint8Array([BUYER.length + 1, 0, 0, 0, 0xc1, 0xa2, ...bytes.subarray(5)]);

    expect(() => decodeSignedDelegate(overlong)).toThrow(/non-canonical/);
  });

  it('throws on a key type other than ed25519 or secp256k1', async () => {
    const { bytes } = await signWithNear(KeyPair.fromRandom('ml-dsa-65'));

    expect(() => decodeSignedDelegate(bytes)).toThrow(/key type/);
  });
});

describe('encodeSignedDelegate', () => {
  it('lays a SignedDelegate out as NEP-366 does, byte for byte', () => {
    expect(encodeSignedDelegate(SIGNED_DELEGATE)).toEqual(SIGNED_DELEGATE_BYTES);
  });
});

describe('delegateHash', () => {
  it('is sha256 of the NEP-366 tag 2^30 + 366 as a little-endian u32 (6e 01 00 40), then the DelegateAction', () => {
    const message = Uint8Array.from([0x6e, 0x01, 0x00, 0x40, ...DELEGATE_ACTION_BYTES]);

    expect(delegateHash(SIGNED_DELEGATE.delegateAction)).toEqual(sha256(message));
  });

  it('equals sha256 of near-api-js encodeDelegateAction', async () => {
    const { delegateAction, bytes } = await signWithNear(KeyPair.fromRandom('ed25519'));

    const decoded = decodeSignedDelegate(bytes);

    expect(delegateHash(decoded.delegateAction)).toEqual(sha256(encodeDelegateAction(delegateAction)));
  });
});

describe('delegatePublicKey', () => {
  it('matches the signing key pair public key string', async () => {
    const keyPair = KeyPair.fromRandom('ed25519');
    const { bytes } = await signWithNear(keyPair);

    expect(delegatePublicKey(decodeSignedDelegate(bytes).delegateAction)).toBe(
      keyPair.getPublicKey().toString(),
    );
  });

  it('formats a secp256k1 key with its prefix', async () => {
    const keyPair = KeyPair.fromRandom('secp256k1');
    const { bytes } = await signWithNear(keyPair);

    const publicKey = delegatePublicKey(decodeSignedDelegate(bytes).delegateAction);

    expect(publicKey).toBe(keyPair.getPublicKey().toString());
    expect(publicKey.startsWith('secp256k1:')).toBe(true);
  });
});

describe('verifyDelegateSignature', () => {
  it('accepts an ed25519 delegate signed with near-api-js', async () => {
    const { bytes } = await signWithNear(KeyPair.fromRandom('ed25519'));

    expect(verifyDelegateSignature(decodeSignedDelegate(bytes))).toBe(true);
  });

  it('accepts a secp256k1 delegate signed with near-api-js', async () => {
    const { bytes } = await signWithNear(KeyPair.fromRandom('secp256k1'));

    expect(verifyDelegateSignature(decodeSignedDelegate(bytes))).toBe(true);
  });

  it('rejects a delegate whose amount was changed after signing', async () => {
    const { bytes } = await signWithNear(KeyPair.fromRandom('ed25519'));
    const signed = decodeSignedDelegate(bytes);
    const args = new TextEncoder().encode(
      JSON.stringify({ receiver_id: POOLS, amount: '1', msg: commitMsg(7, 2) }),
    );

    expect(verifyDelegateSignature(withArgs(signed, args))).toBe(false);
  });

  it('rejects a delegate whose receiver was changed after signing', async () => {
    const { bytes } = await signWithNear(KeyPair.fromRandom('ed25519'));
    const signed = decodeSignedDelegate(bytes);
    const tampered = {
      ...signed,
      delegateAction: { ...signed.delegateAction, receiverId: 'other.testnet' },
    };

    expect(verifyDelegateSignature(tampered)).toBe(false);
  });

  it('rejects a signature made by another key over the same hash', async () => {
    const { bytes } = await signWithNear(KeyPair.fromRandom('ed25519'));
    const signed = decodeSignedDelegate(bytes);
    const other = KeyPair.fromRandom('ed25519').sign(delegateHash(signed.delegateAction)).signature;
    const forged = { ...signed, signature: { ed25519Signature: { data: other } } };

    expect(verifyDelegateSignature(forged)).toBe(false);
  });

  it('rejects a signature whose type does not match the key type', async () => {
    const { bytes } = await signWithNear(KeyPair.fromRandom('ed25519'));
    const signed = decodeSignedDelegate(bytes);
    const mismatched = { ...signed, signature: { secp256k1Signature: { data: new Uint8Array(65) } } };

    expect(verifyDelegateSignature(mismatched)).toBe(false);
  });

  it('returns false instead of throwing on a malformed signature', async () => {
    const { bytes } = await signWithNear(KeyPair.fromRandom('ed25519'));
    const signed = decodeSignedDelegate(bytes);
    const malformed = { ...signed, signature: { ed25519Signature: { data: [1, 2, 3] } } };

    expect(verifyDelegateSignature(malformed)).toBe(false);
  });

  // nearcore verifies a delegate with its own rules, and signatures that near-api-js takes but
  // nearcore refuses would pass the gateway's checks and then fail on chain, after the relayer paid
  // for the transaction and without using up the nonce.
  describe('where nearcore is stricter than near-api-js', () => {
    it('accepts a secp256k1 signature with each recovery byte from 0 to 3, as nearcore parses it', async () => {
      const { bytes } = await signWithNear(KeyPair.fromRandom('secp256k1'));
      const signed = decodeSignedDelegate(bytes);

      for (const recoveryByte of [0, 1, 2, 3]) {
        expect(verifyDelegateSignature(withSignatureByte(signed, 64, recoveryByte))).toBe(true);
      }
    });

    it.each([4, 27, 255])('rejects a secp256k1 signature with recovery byte %i', async (recoveryByte) => {
      const { bytes } = await signWithNear(KeyPair.fromRandom('secp256k1'));
      const tampered = withSignatureByte(decodeSignedDelegate(bytes), 64, recoveryByte);

      expect(nearApiJsAccepts(tampered)).toBe(true);
      expect(verifyDelegateSignature(tampered)).toBe(false);
    });

    it('rejects a secp256k1 signature of 64 bytes, which has no recovery byte', async () => {
      const { bytes } = await signWithNear(KeyPair.fromRandom('secp256k1'));
      const signed = decodeSignedDelegate(bytes);
      if (!('secp256k1Signature' in signed.signature)) throw new Error('expected a secp256k1 signature');
      const short = Uint8Array.from(signed.signature.secp256k1Signature.data).subarray(0, 64);
      const truncated = { ...signed, signature: { secp256k1Signature: { data: short } } };

      expect(verifyDelegateSignature(truncated)).toBe(false);
    });

    it('accepts an ed25519 signature built by the textbook equation, as a control for the next two', () => {
      const r = CRAFT_NONCE;

      const control = craftEd25519(ed25519.Point.BASE.multiply(r).toBytes(), r);

      expect(nearApiJsAccepts(control)).toBe(true);
      expect(verifyDelegateSignature(control)).toBe(true);
    });

    it('rejects an ed25519 signature whose R carries a point of order 4', () => {
      const r = CRAFT_NONCE;
      // y = 0 is a point of order 4, encoded as 32 zero bytes. R = [r]B + it passes the cofactored
      // check, which multiplies the difference by 8, and fails ed25519-dalek's cofactorless one.
      const order4 = ed25519.Point.fromBytes(new Uint8Array(32), false);
      expect(order4.isSmallOrder()).toBe(true);
      expect(order4.isTorsionFree()).toBe(false);

      const crafted = craftEd25519(ed25519.Point.BASE.multiply(r).add(order4).toBytes(), r);

      expect(nearApiJsAccepts(crafted)).toBe(true);
      expect(verifyDelegateSignature(crafted)).toBe(false);
    });

    it('rejects an ed25519 signature whose R is a non-canonical encoding of the identity', () => {
      // y = 2^255 - 18 is the identity's y = 1 plus the field prime, below 2^255 so it still fits
      // the 255 bits. ZIP-215 reduces it, and ed25519-dalek compares the bytes of R as written.
      const rBytes = littleEndian32(ED25519_FIELD + 1n);

      const crafted = craftEd25519(rBytes, 0n);

      expect(nearApiJsAccepts(crafted)).toBe(true);
      expect(verifyDelegateSignature(crafted)).toBe(false);
    });
  });
});

describe('onlyFunctionCall', () => {
  it('returns the FunctionCall of a single-action delegate', async () => {
    const { bytes } = await signWithNear(KeyPair.fromRandom('ed25519'));
    const call = onlyFunctionCall(decodeSignedDelegate(bytes).delegateAction);

    expect(call?.methodName).toBe('ft_transfer_call');
    expect(JSON.parse(new TextDecoder().decode(Uint8Array.from(call?.args ?? [])))).toEqual({
      receiver_id: POOLS,
      amount: '360',
      msg: commitMsg(7, 2),
    });
  });

  it('returns null for a delegate with no actions', async () => {
    const { bytes } = await signWithNear(KeyPair.fromRandom('ed25519'), []);

    expect(onlyFunctionCall(decodeSignedDelegate(bytes).delegateAction)).toBeNull();
  });

  it('returns null for a delegate with two actions', async () => {
    const { bytes } = await signWithNear(KeyPair.fromRandom('ed25519'), [commitCall(), commitCall()]);

    expect(onlyFunctionCall(decodeSignedDelegate(bytes).delegateAction)).toBeNull();
  });

  it('returns null for a delegate whose only action is a transfer', async () => {
    const { bytes } = await signWithNear(KeyPair.fromRandom('ed25519'), [actions.transfer(1n)]);

    expect(onlyFunctionCall(decodeSignedDelegate(bytes).delegateAction)).toBeNull();
  });
});

describe('near-api-js interoperability', () => {
  it('relays a decoded delegate through actions.signedDelegate and a Transaction round trip', async () => {
    const { bytes } = await signWithNear(KeyPair.fromRandom('ed25519'));
    const decoded = decodeSignedDelegate(bytes);
    const relayer = KeyPair.fromRandom('ed25519').getPublicKey();
    // near-api-js types the argument with its own classes; the plain decoded objects encode the same.
    const action = actions.signedDelegate(
      decoded as unknown as Parameters<typeof actions.signedDelegate>[0],
    );
    const tx = createTransaction('relay.parent.testnet', relayer, BUYER, 7n, [action], new Uint8Array(32));

    const relayed = decodeTransaction(encodeTransaction(tx)).actions[0]?.signedDelegate;

    if (relayed === undefined) throw new Error('expected a signedDelegate action');
    expect(nearEncodeSignedDelegate(relayed)).toEqual(bytes);
  });
});
