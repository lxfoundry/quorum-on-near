// The gateway against a local sandbox running the real contracts: an offer, two relayed payments
// that fill a pool (the second paid at the offer's minGas), a redemption, and the keeper's
// settlement. Needs Linux or macOS (near-sandbox ships no Windows binary, so on Windows the suite is
// skipped) and the wasm files from `cargo near build`, named by QUORUM_POOLS_WASM and
// QUORUM_MOCK_USD_WASM; without them the suite fails. The first run downloads the sandbox binary;
// `pnpm --filter @quorum-on-near/gateway exec near-sandbox --version` fetches it ahead. With
// QUORUM_CAPTURE_FIXTURE=1 it also writes the relayed commit's raw outcome to
// test/fixtures/relayed-commit.json.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PAYMENT_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PROOF_HEADER,
  buildPaymentHeader,
  buildRedeemProofHeader,
  decodeHeader,
  maxBlockHeightFor,
  type Offer,
  type PaymentRequired,
  type PaymentResponse,
} from '@quorum-on-near/protocol';
import { createLocalJWKSet, jwtVerify } from 'jose';
import { JsonRpcProvider, KeyPair, teraToGas, type KeyPairString } from 'near-api-js';
import { DEFAULT_ACCOUNT_ID } from 'near-sandbox';
import { afterAll, assert, beforeAll, describe, expect, it } from 'vitest';
import { ActivityLog } from '../../src/activity.ts';
import { createApp } from '../../src/app.ts';
import type { TxOutcome } from '../../src/chain.ts';
import { checkChainId, loadConfig } from '../../src/config.ts';
import { createCredentialIssuer, generateCredentialJwk } from '../../src/credential.ts';
import type { Deps } from '../../src/deps.ts';
import { InFlight, proofNonceCache } from '../../src/guards.ts';
import { Keeper } from '../../src/keeper.ts';
import { toTxOutcome } from '../../src/outcome.ts';
import { KeyPool, RpcRelayer } from '../../src/relayer.ts';
import { RpcChain } from '../../src/rpc-chain.ts';
import { finalOutcome, nearBalance, startWorld, wasmFromEnv, type Actor, type World } from './world.ts';

const TIMEOUT_MS = 180_000;
/** The setup's limit: the first run downloads the sandbox binary. */
const SETUP_TIMEOUT_MS = 900_000;
const FIXTURE = new URL('../fixtures/relayed-commit.json', import.meta.url);

// The seller's pool is the contract's first, so its id is 0.
const POOL_ID = 0;
const SEAT_PRICE = 180n;
const TARGET = 3;
const BONUS = 1728n;
const MAX_SEATS_PER_BUYER = 2;
const DEADLINE_AFTER_MS = 10 * 60_000;
const TERMS = '1×GPU × 3 h; 1 seat = 1 GPU-hour; prices at 1/10,000 scale';
/** What the seller receives when the pool settles: every seat's price, and the bonus back. */
const PAYOUT = BigInt(TARGET) * SEAT_PRICE + BONUS;

/** The 202 body of a payment that took seats in a pool still open. */
interface Pending {
  status: 'pending';
  receipt: { poolId: number; buyer: string; seats: number; txHash: string };
  pool: { taken: number; target: number; deadlineMs: number };
}

/** The 200 body of a payment that filled the pool. */
interface Filled {
  status: 'filled';
  credential: string;
  poolId: number;
  seats: number;
  terms: string;
}

/** The gateway's dependencies as main.ts builds them, pointed at the sandbox, with the seller as provider. */
async function sandboxDeps(world: World, dataDir: string): Promise<Deps> {
  const config = loadConfig({
    QUORUM_NETWORK: 'near:sandbox',
    QUORUM_RPC_URL: world.sandbox.rpcUrl,
    QUORUM_PARENT_ACCOUNT: DEFAULT_ACCOUNT_ID,
    QUORUM_TOKEN_ACCOUNT: world.token.id,
    QUORUM_POOLS_ACCOUNT: world.pools.id,
    QUORUM_RELAYER_ACCOUNT: world.relay.id,
    QUORUM_PROVIDER_ACCOUNT: world.seller.id,
    QUORUM_RELAYER_KEYS: world.relayKeys.map((key) => key.toString()).join(','),
    QUORUM_CREDENTIAL_JWK: JSON.stringify(await generateCredentialJwk()),
    QUORUM_DATA_DIR: dataDir,
    QUORUM_WEB_DIR: '',
  });
  const { poolsContract } = config;
  const relayerProvider = new JsonRpcProvider({ url: config.rpcUrl }, { retries: 1 });
  return {
    config,
    chain: new RpcChain({ provider: new JsonRpcProvider({ url: config.rpcUrl }), poolsContract, token: config.token }),
    writer: new RpcRelayer({
      relayer: config.relayer,
      poolsContract,
      keys: new KeyPool(config.relayerKeys.map((key) => KeyPair.fromString(key as KeyPairString))),
      readProvider: relayerProvider,
      sendProvider: relayerProvider,
      delegateLookupMs: 2 * config.maxTimeoutSeconds * 1000,
    }),
    credentials: await createCredentialIssuer({ jwk: config.credentialJwk, issuer: config.publicUrl }),
    activity: await ActivityLog.open(join(config.dataDir, 'activity.jsonl')),
    inFlight: new InFlight(),
    proofNonces: proofNonceCache(),
    now: Date.now,
  };
}

/**
 * The gas burnt by the commit itself: the receipts after the buyer's delegate receipt that ran on
 * `contracts` (ft_transfer_call, ft_on_transfer, ft_resolve_transfer). The relayer's transaction,
 * the delegate receipt and the gas refunds are left out.
 */
function commitGas(outcome: TxOutcome, buyer: string, contracts: string[]): bigint {
  const delegate = outcome.receipts.findIndex((receipt) => receipt.executorId === buyer);
  if (delegate === -1) throw new Error(`no receipt ran on ${buyer}`);
  return outcome.receipts
    .slice(delegate + 1)
    .filter((receipt) => contracts.includes(receipt.executorId))
    .reduce((sum, receipt) => sum + receipt.gasBurnt, 0n);
}

function tgas(gas: bigint): string {
  return (Number(gas) / 1e12).toFixed(2);
}

// near-sandbox ships no Windows binary.
describe.skipIf(process.platform === 'win32')('the gateway against the sandbox', { timeout: TIMEOUT_MS }, () => {
  // Set by beforeAll; afterAll may find them unset if the setup failed.
  let world: World;
  let dataDir: string;
  let deps: Deps;
  let app: ReturnType<typeof createApp>;
  /** Buyer 1's relayed commit, with the balances read just before it was sent. */
  let commit: { txHash: string; buyerBefore: bigint; relayerBefore: bigint };

  const access = async (seats: number, payment?: string): Promise<Response> =>
    app.request(`/pools/${POOL_ID}/access?seats=${seats}`, {
      headers: payment === undefined ? {} : { [PAYMENT_HEADER]: payment },
    });

  /** The offer the gateway answers a request for `seats` seats with. */
  const offerFor = async (seats: number): Promise<Offer> => {
    const response = await access(seats);
    expect(response.status).toBe(402);
    const [offer] = ((await response.json()) as PaymentRequired).accepts;
    assert.isDefined(offer, 'the 402 carried no offer');
    return offer;
  };

  /**
   * The buyer's payment for `offer`, which answers its request for `seats` seats: its key's next
   * nonce, the expiry maxBlockHeightFor gives from the final height, the sandbox's network and
   * contracts as the buyer's own configuration, and the price of `seats` at SEAT_PRICE as its budget.
   * The ft_transfer_call gets `gas`, or the offer's maxGas when it is omitted.
   */
  const paymentFrom = async (buyer: Actor, seats: number, offer: Offer, gas?: bigint): Promise<string> => {
    const { chain, config } = deps;
    const key = await chain.accessKey(buyer.id, buyer.keyPair.getPublicKey().toString());
    assert.isNotNull(key, `${buyer.id} has no such access key`);
    const block = await chain.finalBlock();
    return buildPaymentHeader({
      keyPair: buyer.keyPair,
      senderId: buyer.id,
      nonce: key.nonce + 1n,
      maxBlockHeight: maxBlockHeightFor(block.height, config.maxTimeoutSeconds, config.blockTimeMs),
      offer,
      expected: {
        network: 'near:sandbox',
        token: world.token.id,
        poolsContract: world.pools.id,
        poolId: POOL_ID,
        maxSeats: seats,
        maxAmount: BigInt(seats) * SEAT_PRICE,
      },
      gas,
    });
  };

  /** Waits until a transaction the relayer signed is final, with every receipt it caused. */
  const relayedFinal = (txHash: string): Promise<unknown> => finalOutcome(world, txHash, world.relay.id);

  beforeAll(async () => {
    // Throws, failing the suite, unless both wasm files are named.
    const wasm = wasmFromEnv();
    world = await startWorld(wasm);
    dataDir = await mkdtemp(join(tmpdir(), 'quorum-sandbox-'));
    deps = await sandboxDeps(world, dataDir);
    app = createApp(deps);

    const { seller, token, pools } = world;
    const { timestampMs } = await deps.chain.finalBlock();
    const open = {
      seat_price: SEAT_PRICE.toString(),
      target: TARGET,
      deadline_ms: timestampMs + DEADLINE_AFTER_MS,
      max_seats_per_buyer: MAX_SEATS_PER_BUYER,
      terms: TERMS,
    };
    // The bonus is the amount sent with the open message.
    await seller.account.callFunctionRaw({
      contractId: token.id,
      methodName: 'ft_transfer_call',
      args: { receiver_id: pools.id, amount: BONUS.toString(), msg: JSON.stringify({ open }) },
      deposit: 1n,
      gas: teraToGas(100),
    });
    const pool = await deps.chain.getPool(POOL_ID);
    if (pool?.status !== 'open') throw new Error(`pool ${POOL_ID} did not open: ${JSON.stringify(pool)}`);
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await world?.sandbox.tearDown();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  }, TIMEOUT_MS);

  it('runs on a chain whose id near:sandbox accepts', async () => {
    const { chain_id: chainId } = await world.provider.viewNodeStatus();

    console.log(`sandbox chain id: ${chainId}`);
    expect(checkChainId('near:sandbox', chainId)).toBeNull();
  });

  it('answers a request for 2 seats with no payment with 402 and an offer for 2 seats', async () => {
    const offer = await offerFor(2);

    expect(offer).toMatchObject({
      network: 'near:sandbox',
      maxAmountRequired: (2n * SEAT_PRICE).toString(),
      payTo: world.pools.id,
      asset: world.token.id,
      extra: { poolId: POOL_ID, seats: 2, taken: 0, target: TARGET },
    });
  });

  it("relays buyer 1's payment for 2 seats and answers 202 with a receipt for them", async () => {
    const { buyer1, relay } = world;
    const offer = await offerFor(2);
    const buyerBefore = await nearBalance(world, buyer1.id);
    const relayerBefore = await nearBalance(world, relay.id);

    const response = await access(2, await paymentFrom(buyer1, 2, offer));

    expect(response.status).toBe(202);
    const body = (await response.json()) as Pending;
    expect(body.receipt).toMatchObject({ poolId: POOL_ID, buyer: buyer1.id, seats: 2 });
    expect(body.pool).toMatchObject({ taken: 2, target: TARGET });
    commit = { txHash: body.receipt.txHash, buyerBefore, relayerBefore };
  });

  it("changes buyer 1's NEAR balance by at most the commit's 1 yoctoNEAR deposit", async () => {
    const { buyer1, relay } = world;
    await relayedFinal(commit.txHash);

    const buyerChange = (await nearBalance(world, buyer1.id)) - commit.buyerBefore;
    const relayerChange = (await nearBalance(world, relay.id)) - commit.relayerBefore;

    expect([0n, -1n]).toContain(buyerChange);
    console.log(`deposit debited from: ${buyerChange === -1n ? 'buyer' : 'relayer'}`);
    console.log(`relayer balance change: ${relayerChange} yoctoNEAR`);
  });

  it("burns less gas in buyer 1's commit than the offer's minGas", async () => {
    const { buyer1, token, pools } = world;
    const raw = await relayedFinal(commit.txHash);
    if (process.env.QUORUM_CAPTURE_FIXTURE === '1') {
      await writeFile(FIXTURE, `${JSON.stringify(raw, null, 2)}\n`);
    }

    const gas = commitGas(toTxOutcome(raw), buyer1.id, [token.id, pools.id]);

    console.log(`commit gas burnt: ${tgas(gas)} Tgas`);
    expect(gas).toBeGreaterThan(0n);
    // Burnt gas never exceeds what was attached, so this commit, paid at maxGas, cannot show that
    // minGas is enough. It shows that minGas covers at least the gas burnt; buyer 2's commit, paid
    // at minGas, shows that a commit completes with it.
    expect(gas).toBeLessThan(deps.config.minGas);
  });

  it("fills the pool with buyer 2's payment for the last seat, paid at the offer's minGas, and answers 200 with a credential", async () => {
    const { buyer2, token, pools } = world;

    const response = await access(1, await paymentFrom(buyer2, 1, await offerFor(1), deps.config.minGas));

    expect(response.status).toBe(200);
    const body = (await response.json()) as Filled;
    expect(body).toMatchObject({ status: 'filled', poolId: POOL_ID, seats: 1, terms: TERMS });
    const jwks = createLocalJWKSet(deps.credentials.jwks());
    const { payload } = await jwtVerify(body.credential, jwks, { issuer: deps.config.publicUrl });
    expect(payload).toMatchObject({ sub: buyer2.id, pool: POOL_ID, seats: 1, simulated: true });

    const header = response.headers.get(PAYMENT_RESPONSE_HEADER);
    assert.isNotNull(header, 'the 200 carried no X-PAYMENT-RESPONSE header');
    const { transaction } = decodeHeader(header) as PaymentResponse;
    const gas = commitGas(toTxOutcome(await relayedFinal(transaction)), buyer2.id, [token.id, pools.id]);
    console.log(`filling commit gas burnt at minGas: ${tgas(gas)} Tgas`);
  });

  it("answers buyer 1's redemption proof with 200 and a credential for its 2 seats once the pool has filled", async () => {
    const { buyer1 } = world;
    const proof = await buildRedeemProofHeader({
      keyPair: buyer1.keyPair,
      accountId: buyer1.id,
      poolId: POOL_ID,
      recipient: new URL(deps.config.publicUrl).host,
      nowMs: deps.now(),
    });

    const response = await app.request(`/pools/${POOL_ID}/access`, { headers: { [PROOF_HEADER]: proof } });

    expect(response.status).toBe(200);
    const body = (await response.json()) as Filled;
    expect(body).toMatchObject({ status: 'filled', poolId: POOL_ID, seats: 2, terms: TERMS });
    const jwks = createLocalJWKSet(deps.credentials.jwks());
    const { payload } = await jwtVerify(body.credential, jwks, { issuer: deps.config.publicUrl });
    expect(payload).toMatchObject({ sub: buyer1.id, pool: POOL_ID, seats: 2, simulated: true });
  });

  it("settles the filled pool on the keeper's tick and pays the seller every seat's price and the bonus", async () => {
    const { seller } = world;
    const { chain, config } = deps;
    // The gateway reads optimistic state, so neither the fill nor the settlement needs to be final
    // before it is read.
    const sellerBefore = await chain.ftBalanceOf(seller.id);
    const problems: string[] = [];
    const keeper = new Keeper({
      chain,
      writer: deps.writer,
      activity: deps.activity,
      provider: config.provider,
      poolsContract: config.poolsContract,
      refundLimit: config.refundLimit,
      settleGas: config.settleGas,
      refundGas: config.refundGas,
      now: deps.now,
      log: (message) => problems.push(message),
    });

    await keeper.tick();

    expect(problems).toEqual([]);
    const settled = deps.activity.list(POOL_ID).find((record) => record.kind === 'settle');
    assert.isDefined(settled, 'the keeper recorded no settle call');
    expect(settled).toMatchObject({ ok: true, account: seller.id, seats: TARGET, amount: PAYOUT.toString() });
    expect((await chain.getPool(POOL_ID))?.status).toBe('settled');
    expect((await chain.ftBalanceOf(seller.id)) - sellerBefore).toBe(PAYOUT);
  });
});
