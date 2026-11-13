import { createPrivateKey, createPublicKey } from 'node:crypto';
import { baseDecode, KeyPair, type KeyPairString } from 'near-api-js';
import { parseSeedPhrase } from 'near-api-js/seed-phrase';
import { describe, expect, it } from 'vitest';
import {
  bip39Seed,
  CREDENTIAL_PATH,
  credentialJwk,
  ed25519PublicKey,
  FUNDING_PATH,
  MAX_RELAYER_KEYS,
  MCP_BUYER_PATH,
  nearKey,
  normalisePhrase,
  PARENT_PATH,
  parsePath,
  POOLS_PATH,
  PROVIDER_PATH,
  relayerKeyPath,
  SCRIPTED_BUYERS,
  scriptedBuyerPath,
  SeedPhraseError,
  slip10Derive,
} from '../src/seed.ts';

/** BIP-39's public 12-word test phrase (16 zero bytes of entropy): anyone can derive its keys. */
const PHRASE = `${'abandon '.repeat(11)}about`;
/** BIP-39's public 24-word test phrase (32 zero bytes of entropy). */
const PHRASE_24 = `${'abandon '.repeat(23)}art`;
/** PHRASE as it may be typed or pasted: capitals, line breaks, a tab and extra spaces. */
const MESSY = `\n  ABANDON abandon\tabandon\r\nAbandon ${'abandon '.repeat(7)}  ABOUT\n`;

/**
 * The public key near-cli-rs derives from PHRASE at NEAR's standard path, as printed by
 * `near account get-public-key from-seed-phrase '<PHRASE>' --seed-phrase-hd-path "m/44'/397'/0'"`.
 */
const NEAR_CLI_RS_PARENT_KEY = 'ed25519:6j4b6zUaty6fD1awqcGCCU9JYGCWYUgdJhQrzfZhqE25';

/** The seed of SLIP-0010's "Test vector 1 for ed25519". */
const SLIP10_SEED = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');

/**
 * SLIP-0010's "Test vector 1 for ed25519": for each chain, its path, chain code, private key and
 * public key, which SLIP-0010 writes as 0x00 followed by the 32-byte ed25519 public key.
 */
const SLIP10_ED25519_VECTOR_1: Array<[path: string, chainCode: string, privateKey: string, publicKey: string]> = [
  [
    'm',
    '90046a93de5380a72b5e45010748567d5ea02bbf6522f979e05c0d8d8ca9fffb',
    '2b4be7f19ee27bbf30c667b642d5f4aa69fd169872f8fc3059c08ebae2eb19e7',
    '00a4b2856bfec510abab89753fac1ac0e1112364e7d250545963f135f2a33188ed',
  ],
  [
    "m/0'",
    '8b59aa11380b624e81507a27fedda59fea6d0b779a778918a2fd3590e16e9c69',
    '68e0fe46dfb67e368c75379acec591dad19df3cde26e63b93a8e704f1dade7a3',
    '008c8a13df77a28f3445213a0f432fde644acaa215fc72dcdf300d5efaa85d350c',
  ],
  [
    "m/0'/1'",
    'a320425f77d1b5c2505a6b1b27382b37368ee640e3557c315416801243552f14',
    'b1d0bad404bf35da785a64ca1ac54b2617211d2777696fbffaf208f746ae84f2',
    '001932a5270f335bed617d5b935c80aedb1a35bd9fc1e31acafd5372c30f5c1187',
  ],
  [
    "m/0'/1'/2'",
    '2e69929e00b5ab250f49c3fb1c12f252de4fed2c1db88387094a0f8c4c9ccd6c',
    '92a5b23c0b8a99e37d07df3fb9966917f5d06e02ddbd909c7e184371463e9fc9',
    '00ae98736566d30ed0e9d2f4486a64bc95740d89c7db33f52121f8ea8f76ff0fc1',
  ],
  [
    "m/0'/1'/2'/2'",
    '8f6d87f93d750e0efccda017d662a1b31a266e4a6f5993b15f5c1f07f74dd5cc',
    '30d1dc7e5fc04c31219ab25a27ae00b50f6fd66622f6e9c913253d6511d1e662',
    '008abae2d66361c879b900d204ad2cc4984fa2aa344dd7ddc46007329ac76c429c',
  ],
  [
    "m/0'/1'/2'/2'/1000000000'",
    '68789923a0cac2cd5a29172a475fe9e0fb14cd6adb5ad98a3fa70333e7afa230',
    '8f94d394a8e8fd6b1bc2f3f49f5c47e385281d5c17e65324b0f62483e37e8793',
    '003c24da049451555d51a7014a37337aa4e12d41e485abccfa46b47dfb2af54b7a',
  ],
];

describe('slip10Derive and ed25519PublicKey', () => {
  it.each(SLIP10_ED25519_VECTOR_1)('give SLIP-10 ed25519 test vector 1 at %s', (path, chainCode, privateKey, publicKey) => {
    const node = slip10Derive(SLIP10_SEED, path);
    expect(node.chainCode.toString('hex')).toBe(chainCode);
    expect(node.key.toString('hex')).toBe(privateKey);
    expect(`00${ed25519PublicKey(node.key).toString('hex')}`).toBe(publicKey);
  });
});

describe('normalisePhrase', () => {
  it('splits on any whitespace, lowercases each word, and joins them with single spaces', () => {
    expect(normalisePhrase(MESSY)).toBe(PHRASE);
  });

  it('keeps a phrase of 12 or 24 words that is already normalised as it is', () => {
    expect(normalisePhrase(PHRASE)).toBe(PHRASE);
    expect(normalisePhrase(PHRASE_24)).toBe(PHRASE_24);
  });

  it.each([0, 1, 11, 13, 23, 25])('refuses %i words with a SeedPhraseError that gives the count and no word', (count) => {
    let error: unknown;
    try {
      normalisePhrase(` ${'abandon '.repeat(count)}`);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(SeedPhraseError);
    expect((error as SeedPhraseError).words).toBe(count);
    expect((error as Error).message).toBe(`a seed phrase has 12 or 24 words, not ${count}`);
  });
});

describe('bip39Seed', () => {
  it("gives BIP-39's reference seed of the 12-word test phrase with the passphrase TREZOR", () => {
    expect(bip39Seed(PHRASE, 'TREZOR').toString('hex')).toBe(
      'c55257c360c07c72029aebc1b53c05ed0362ada38ead3e3e9efa3708e53495531f09a6987599d18264c1e1c92f2cf141630c7a3c4ab7c81b2f001698e7463b04',
    );
  });

  it("gives BIP-39's reference seed of the 24-word test phrase with the passphrase TREZOR", () => {
    expect(bip39Seed(PHRASE_24, 'TREZOR').toString('hex')).toBe(
      'bda85446c68413707090a52022edd26a1c9462295029f2e60cd7c4f2bbd3097170af7a4d73245cafa9c3cca8d561a7c3de6f5d4a10be8ed2a5e608d68f92fcc8',
    );
  });

  it('is 64 bytes, with an empty passphrase by default', () => {
    expect(bip39Seed(PHRASE)).toHaveLength(64);
    expect(bip39Seed(PHRASE).equals(bip39Seed(PHRASE, ''))).toBe(true);
    expect(bip39Seed(PHRASE).equals(bip39Seed(PHRASE, 'TREZOR'))).toBe(false);
  });

  it('normalises the passphrase to NFKD, as BIP-39 does', () => {
    expect(bip39Seed(PHRASE, '\u00e9').equals(bip39Seed(PHRASE, 'e\u0301'))).toBe(true);
  });
});

describe('parsePath', () => {
  it.each<[string, number[]]>([
    ['m', []],
    ["m/44'/397'/0'", [44, 397, 0]],
    ["m/0'/1'/2'/2'/1000000000'", [0, 1, 2, 2, 1_000_000_000]],
    ["m/2147483647'", [2_147_483_647]],
  ])('reads %s', (path, indices) => {
    expect(parsePath(path)).toEqual(indices);
  });

  it.each(["m/44'/397'/0", "m/44/397'/0'", "44'/397'/0'", "m/44'/", "m/01'", "m/-1'", "m/2147483648'", 'm/0h', '', "M/0'"])(
    'refuses %j: SLIP-10 derives ed25519 keys at hardened indices below 2^31 only',
    (path) => {
      expect(() => parsePath(path)).toThrow(RangeError);
    },
  );
});

describe('the paths of the roles', () => {
  it('gives the parent, funding, pools, provider, MCP buyer and credential keys their paths', () => {
    expect([PARENT_PATH, FUNDING_PATH, POOLS_PATH, PROVIDER_PATH, MCP_BUYER_PATH, CREDENTIAL_PATH]).toEqual([
      "m/44'/397'/0'",
      "m/44'/397'/1'",
      "m/44'/397'/2'",
      "m/44'/397'/3'",
      "m/44'/397'/199'",
      "m/44'/397'/900'",
    ]);
  });

  it("numbers the relayer's keys from m/44'/397'/10', for up to 90 keys", () => {
    expect(MAX_RELAYER_KEYS).toBe(90);
    expect(relayerKeyPath(0)).toBe("m/44'/397'/10'");
    expect(relayerKeyPath(1)).toBe("m/44'/397'/11'");
    expect(relayerKeyPath(89)).toBe("m/44'/397'/99'");
  });

  it.each([-1, 90, 1.5])('refuses relayer key index %d', (index) => {
    expect(() => relayerKeyPath(index)).toThrow(RangeError);
  });

  it("gives buyer-NN m/44'/397'/(100 + NN)', from buyer-01 to buyer-20", () => {
    expect(SCRIPTED_BUYERS).toBe(20);
    expect(scriptedBuyerPath(1)).toBe("m/44'/397'/101'");
    expect(scriptedBuyerPath(20)).toBe("m/44'/397'/120'");
  });

  it.each([0, 21])('refuses scripted buyer %i', (number) => {
    expect(() => scriptedBuyerPath(number)).toThrow(RangeError);
  });
});

describe('nearKey', () => {
  const seed = bip39Seed(PHRASE);

  it("gives the parent key near-cli-rs derives from the public test phrase at m/44'/397'/0'", () => {
    // The format check catches a key copied incompletely.
    expect(NEAR_CLI_RS_PARENT_KEY).toMatch(/^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/);
    expect(nearKey(seed, PARENT_PATH).publicKey).toBe(NEAR_CLI_RS_PARENT_KEY);
  });

  it("gives the key pair near-api-js's seed-phrase module derives at NEAR's standard path", () => {
    const reference = parseSeedPhrase(PHRASE);
    const derived = nearKey(seed, PARENT_PATH);
    expect(derived.publicKey).toBe(reference.getPublicKey().toString());
    expect(derived.keyPair.toString()).toBe(reference.toString());
  });

  it('writes the secret key as near-cli does: the 32-byte private key, then the 32-byte public key, in base58', () => {
    const path = "m/44'/397'/2'";
    const derived = nearKey(seed, path);
    expect(derived.path).toBe(path);
    const secret = baseDecode(derived.keyPair.toString().slice('ed25519:'.length));
    const publicKey = baseDecode(derived.publicKey.slice('ed25519:'.length));
    expect(secret).toHaveLength(64);
    expect(publicKey).toHaveLength(32);
    expect(Buffer.from(secret.subarray(0, 32)).equals(slip10Derive(seed, path).key)).toBe(true);
    expect(Buffer.from(secret.subarray(32)).equals(Buffer.from(publicKey))).toBe(true);
    expect(KeyPair.fromString(derived.keyPair.toString() as KeyPairString).getPublicKey().toString()).toBe(derived.publicKey);
    expect(derived.keyPair.getPublicKey().toString()).toBe(derived.publicKey);
  });

  it('gives the same key for the phrase written with capitals, line breaks and extra spaces', () => {
    const messy = nearKey(bip39Seed(normalisePhrase(MESSY)), PARENT_PATH);
    expect(messy.keyPair.toString()).toBe(nearKey(seed, PARENT_PATH).keyPair.toString());
  });

  it('gives another key at another path', () => {
    expect(nearKey(seed, FUNDING_PATH).publicKey).not.toBe(nearKey(seed, PARENT_PATH).publicKey);
  });
});

describe('credentialJwk', () => {
  const seed = bip39Seed(PHRASE);

  it("is a private Ed25519 JWK with only kty, crv, x and d, derived at m/44'/397'/900'", () => {
    const jwk = credentialJwk(seed);
    expect(Object.keys(jwk).sort()).toEqual(['crv', 'd', 'kty', 'x']);
    expect([jwk.kty, jwk.crv]).toEqual(['OKP', 'Ed25519']);
    expect(Buffer.from(jwk.d, 'base64url').equals(slip10Derive(seed, CREDENTIAL_PATH).key)).toBe(true);
    expect(createPublicKey(createPrivateKey({ key: { ...jwk }, format: 'jwk' })).export({ format: 'jwk' }).x).toBe(jwk.x);
  });

  it('is the same from the same phrase however it is written, so a credential issued before a restart still verifies after it', () => {
    expect(credentialJwk(bip39Seed(normalisePhrase(MESSY)))).toEqual(credentialJwk(seed));
  });
});
