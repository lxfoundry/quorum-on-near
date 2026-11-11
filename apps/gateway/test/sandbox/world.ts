// A local NEAR sandbox with the mock token and the pools contract deployed, for the sandbox tests.
import { readFile } from 'node:fs/promises';
import {
  Account,
  JsonRpcProvider,
  KeyPair,
  KeyPairSigner,
  actions,
  nearToYocto,
  teraToGas,
  type Action,
} from 'near-api-js';
import { DEFAULT_ACCOUNT_ID, DEFAULT_PRIVATE_KEY, Sandbox } from 'near-sandbox';

/** The two contracts' wasm files, as `cargo near build` writes them. */
export interface WasmFiles {
  pools: string;
  mockUsd: string;
}

/** A sandbox account, the key that controls it, and an Account that signs with that key. */
export interface Actor {
  id: string;
  keyPair: KeyPair;
  account: Account;
}

export interface World {
  sandbox: Sandbox;
  provider: JsonRpcProvider;
  token: Actor;
  pools: Actor;
  relay: Actor;
  /** The relayer's two full-access keys, `relay.keyPair` first. */
  relayKeys: KeyPair[];
  seller: Actor;
  buyer1: Actor;
  buyer2: Actor;
}

/** The mock token each of the seller and the buyers starts with, in base units (1 mUSD). */
const MINTED = 1_000_000n;

const INIT_GAS = teraToGas(30);
const TOKEN_CALL_GAS = teraToGas(20);

/** The wasm files named by QUORUM_POOLS_WASM and QUORUM_MOCK_USD_WASM. Throws, naming both, unless both are set. */
export function wasmFromEnv(): WasmFiles {
  const { QUORUM_POOLS_WASM: pools, QUORUM_MOCK_USD_WASM: mockUsd } = process.env;
  if (!pools || !mockUsd) {
    throw new Error(
      'set QUORUM_POOLS_WASM and QUORUM_MOCK_USD_WASM to the absolute paths of the pools and mock-usd wasm files that `cargo near build` writes',
    );
  }
  return { pools, mockUsd };
}

/**
 * Starts a sandbox and creates `musd`, `pools`, `relay`, `seller`, `buyer1` and `buyer2` under its
 * root account, each with a fresh key (two for `relay`). Deploys the mock token to `musd` and the
 * pools contract to `pools`, each initialised in its deploy transaction, registers `pools`, the
 * seller and the buyers on the token, and mints MINTED to the seller and each buyer. Resolves once
 * all of it is final. Tears the sandbox down if a step fails.
 */
export async function startWorld(wasm: WasmFiles): Promise<World> {
  const sandbox = await Sandbox.start({});
  try {
    const provider = new JsonRpcProvider({ url: sandbox.rpcUrl });
    const root = new Account(DEFAULT_ACCOUNT_ID, provider, DEFAULT_PRIVATE_KEY);
    const create = (name: string, near: number, keys?: KeyPair[]): Promise<Actor> =>
      createActor(root, name, nearToYocto(near), keys);

    const token = await create('musd', 20);
    const pools = await create('pools', 20);
    const relayKeys = [KeyPair.fromRandom('ed25519'), KeyPair.fromRandom('ed25519')];
    const relay = await create('relay', 10, relayKeys);
    const seller = await create('seller', 5);
    const buyer1 = await create('buyer1', 5);
    const buyer2 = await create('buyer2', 5);

    await deploy(token, wasm.mockUsd, {});
    await deploy(pools, wasm.pools, { token: token.id });

    const bounds = await provider.callFunction<{ min: string }>({
      contractId: token.id,
      method: 'storage_balance_bounds',
      args: {},
    });
    if (bounds === undefined) throw new Error(`${token.id} returned no storage_balance_bounds`);
    const register = (actor: Actor): Action =>
      actions.functionCall(
        'storage_deposit',
        { account_id: actor.id, registration_only: true },
        TOKEN_CALL_GAS,
        BigInt(bounds.min),
      );
    const mint = (actor: Actor): Action =>
      actions.functionCall('mint', { account_id: actor.id, amount: MINTED.toString() }, TOKEN_CALL_GAS, 0n);
    // The last setup transaction: once it is final, so is everything before it.
    await root.signAndSendTransaction({
      receiverId: token.id,
      actions: [...[pools, seller, buyer1, buyer2].map(register), ...[seller, buyer1, buyer2].map(mint)],
      waitUntil: 'FINAL',
    });

    return { sandbox, provider, token, pools, relay, relayKeys, seller, buyer1, buyer2 };
  } catch (error) {
    await sandbox.tearDown();
    throw error;
  }
}

/** The account's NEAR balance at the latest final block, in yoctoNEAR. */
export async function nearBalance(world: World, accountId: string): Promise<bigint> {
  const view = await world.provider.viewAccount({ accountId, blockQuery: { finality: 'final' } });
  return view.amount;
}

/**
 * Waits until a transaction signed by `signerId`, and every receipt it caused (refunds included), is
 * final. Resolves with the RPC's raw response.
 */
export function finalOutcome(world: World, txHash: string, signerId: string): Promise<unknown> {
  return world.provider.viewTransactionStatus({ txHash, accountId: signerId, waitUntil: 'FINAL' });
}

/** Creates `<name>.<root>` holding `yocto`, with `keys` as its full-access keys. */
async function createActor(
  root: Account,
  name: string,
  yocto: bigint,
  keys: KeyPair[] = [KeyPair.fromRandom('ed25519')],
): Promise<Actor> {
  const [keyPair] = keys;
  if (keyPair === undefined) throw new Error(`${name} needs at least one key`);
  const id = `${name}.${root.accountId}`;
  await root.signAndSendTransaction({
    receiverId: id,
    actions: [
      actions.createAccount(),
      actions.transfer(yocto),
      ...keys.map((key) => actions.addFullAccessKey(key.getPublicKey())),
    ],
  });
  return { id, keyPair, account: new Account(id, root.provider, new KeyPairSigner(keyPair)) };
}

/** Deploys a wasm file to the contract's own account and calls `new(args)` in the same transaction. */
async function deploy(contract: Actor, wasmFile: string, args: Record<string, unknown>): Promise<void> {
  const code = await readFile(wasmFile);
  await contract.account.signAndSendTransaction({
    receiverId: contract.id,
    actions: [actions.deployContract(code), actions.functionCall('new', args, INIT_GAS, 0n)],
  });
}
