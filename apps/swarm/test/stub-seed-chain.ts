import type { KeyPermission, SeedChain } from '../src/keys-from-seed.ts';

/**
 * The chain `swarm keys from-seed` reads, in memory: the accounts that exist, each with the public
 * keys it holds and how. Every read is recorded in `reads`; with `down` set, every read fails as a
 * request to an RPC that cannot be reached does.
 */
export class StubSeedChain implements SeedChain {
  /** The `chain_id` the node reports. */
  nodeChainId = 'testnet';
  /** When true, every read rejects with `fetch failed`, after it is recorded. */
  down = false;
  /** `chainId`, `account <id>` and `key <id> <public key>`, in the order read. */
  readonly reads: string[] = [];
  readonly #accounts = new Map<string, Map<string, KeyPermission>>();

  /** Makes `accountId` exist, if it did not, and hold `publicKey` with `permission`. */
  hold(accountId: string, publicKey: string, permission: KeyPermission = 'full_access'): this {
    const keys = this.#accounts.get(accountId) ?? new Map<string, KeyPermission>();
    keys.set(publicKey, permission);
    this.#accounts.set(accountId, keys);
    return this;
  }

  async chainId(): Promise<string> {
    this.#read('chainId');
    return this.nodeChainId;
  }

  async accountExists(accountId: string): Promise<boolean> {
    this.#read(`account ${accountId}`);
    return this.#accounts.has(accountId);
  }

  async accessKey(accountId: string, publicKey: string): Promise<KeyPermission | null> {
    this.#read(`key ${accountId} ${publicKey}`);
    return this.#accounts.get(accountId)?.get(publicKey) ?? null;
  }

  #read(what: string): void {
    this.reads.push(what);
    if (this.down) throw new Error('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:3030') });
  }
}
