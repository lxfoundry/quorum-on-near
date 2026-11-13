import { REDEEM_MAX_AGE_MS, REDEEM_MAX_SKEW_MS } from '@quorum-on-near/protocol';

/**
 * Buyers with a payment in flight: at most one each (spec section 6.4). A buyer is busy from `begin`
 * to `end`, and held after `end` while a payment whose result is unknown may still execute or still
 * have receipts to run.
 */
export class InFlight {
  readonly #busy = new Set<string>();
  /** Held buyers, each with the last height at which its payment may still take effect. */
  readonly #held = new Map<string, bigint>();

  /** Marks the buyer busy. Returns false, changing nothing, if it already was busy or is held. */
  begin(buyer: string): boolean {
    if (this.#busy.has(buyer) || this.#held.has(buyer)) return false;
    this.#busy.add(buyer);
    return true;
  }

  /** Ends the buyer's busy time. A hold outlasts it. */
  end(buyer: string): void {
    this.#busy.delete(buyer);
  }

  /**
   * Keeps the buyer in flight until `passed` is given a final height above `untilHeight`: the last
   * height at which its payment may still take effect, its `max_block_height` plus the blocks its
   * receipts take.
   */
  hold(buyer: string, untilHeight: bigint): void {
    this.#held.set(buyer, untilHeight);
  }

  held(buyer: string): boolean {
    return this.#held.has(buyer);
  }

  /** Lifts every hold whose height is below `finalHeight`: those payments can no longer take effect. */
  passed(finalHeight: bigint): void {
    for (const [buyer, untilHeight] of this.#held) {
      if (finalHeight > untilHeight) this.#held.delete(buyer);
    }
  }

  /** True while the buyer is busy or held. */
  has(buyer: string): boolean {
    return this.#busy.has(buyer) || this.#held.has(buyer);
  }
}

/** Redemption nonces seen in the last `ttlMs`. In memory only, so it restarts empty. */
export class NonceCache {
  readonly #ttlMs: number;
  readonly #seenAt = new Map<string, number>();

  constructor(ttlMs: number) {
    this.#ttlMs = ttlMs;
  }

  /** Returns true if `key` was seen within the TTL; otherwise records it and returns false. */
  seen(key: string, nowMs: number): boolean {
    for (const [k, at] of this.#seenAt) {
      if (nowMs - at >= this.#ttlMs) this.#seenAt.delete(k);
    }
    if (this.#seenAt.has(key)) return true;
    this.#seenAt.set(key, nowMs);
    return false;
  }
}

/**
 * The cache of redemption nonces (spec section 6.5). A proof signed up to REDEEM_MAX_SKEW_MS ahead
 * stays fresh until REDEEM_MAX_AGE_MS after its signing time, so a nonce is kept for their sum.
 */
export function proofNonceCache(): NonceCache {
  return new NonceCache(REDEEM_MAX_AGE_MS + REDEEM_MAX_SKEW_MS);
}
