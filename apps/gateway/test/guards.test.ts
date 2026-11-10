import { describe, expect, it, vi } from 'vitest';
import { InFlight, NonceCache } from '../src/guards.ts';

describe('InFlight', () => {
  it('marks a buyer busy on begin', () => {
    const inFlight = new InFlight();
    expect(inFlight.begin('alice.testnet')).toBe(true);
    expect(inFlight.has('alice.testnet')).toBe(true);
  });

  it('refuses a second begin for a buyer that is already busy', () => {
    const inFlight = new InFlight();
    inFlight.begin('alice.testnet');
    expect(inFlight.begin('alice.testnet')).toBe(false);
    expect(inFlight.has('alice.testnet')).toBe(true);
  });

  it('frees the buyer on end, so begin succeeds again', () => {
    const inFlight = new InFlight();
    inFlight.begin('alice.testnet');
    inFlight.end('alice.testnet');
    expect(inFlight.has('alice.testnet')).toBe(false);
    expect(inFlight.begin('alice.testnet')).toBe(true);
  });

  it('tracks each buyer separately', () => {
    const inFlight = new InFlight();
    inFlight.begin('alice.testnet');
    expect(inFlight.has('bob.testnet')).toBe(false);
    expect(inFlight.begin('bob.testnet')).toBe(true);
  });

  it('ignores end for a buyer that is not busy', () => {
    const inFlight = new InFlight();
    inFlight.end('alice.testnet');
    expect(inFlight.has('alice.testnet')).toBe(false);
  });

  it('keeps a held buyer in flight after end, so begin is refused', () => {
    const inFlight = new InFlight();
    inFlight.begin('alice.testnet');
    inFlight.hold('alice.testnet', 1_100n);
    inFlight.end('alice.testnet');
    expect(inFlight.held('alice.testnet')).toBe(true);
    expect(inFlight.has('alice.testnet')).toBe(true);
    expect(inFlight.begin('alice.testnet')).toBe(false);
  });

  it('lifts a hold once a final height above its maxBlockHeight is passed, not at it', () => {
    const inFlight = new InFlight();
    inFlight.hold('alice.testnet', 1_100n);
    inFlight.passed(1_100n);
    expect(inFlight.held('alice.testnet')).toBe(true);
    inFlight.passed(1_101n);
    expect(inFlight.held('alice.testnet')).toBe(false);
    expect(inFlight.begin('alice.testnet')).toBe(true);
  });

  it('lifts every passed hold at once, so holds do not accumulate', () => {
    const inFlight = new InFlight();
    inFlight.hold('alice.testnet', 1_100n);
    inFlight.hold('bob.testnet', 1_300n);
    inFlight.hold('carol.testnet', 1_200n);
    inFlight.passed(1_250n);
    const held = ['alice.testnet', 'bob.testnet', 'carol.testnet'].map((buyer) => inFlight.held(buyer));
    expect(held).toEqual([false, true, false]);
  });

  it('does not block other buyers while one is held', () => {
    const inFlight = new InFlight();
    inFlight.hold('alice.testnet', 1_100n);
    expect(inFlight.has('bob.testnet')).toBe(false);
    expect(inFlight.begin('bob.testnet')).toBe(true);
  });
});

describe('NonceCache', () => {
  const TTL = 300_000;

  it('reports a key as unseen the first time', () => {
    const cache = new NonceCache(TTL);
    expect(cache.seen('alice.testnet:n1', 1_000)).toBe(false);
  });

  it('reports a key as seen when it comes back within the TTL', () => {
    const cache = new NonceCache(TTL);
    cache.seen('alice.testnet:n1', 1_000);
    expect(cache.seen('alice.testnet:n1', 1_000 + TTL - 1)).toBe(true);
  });

  it('forgets a key at exactly the TTL', () => {
    const cache = new NonceCache(TTL);
    cache.seen('alice.testnet:n1', 1_000);
    expect(cache.seen('alice.testnet:n1', 1_000 + TTL)).toBe(false);
  });

  it('records an expired key again from the new time', () => {
    const cache = new NonceCache(TTL);
    cache.seen('alice.testnet:n1', 0);
    cache.seen('alice.testnet:n1', TTL);
    expect(cache.seen('alice.testnet:n1', 2 * TTL - 1)).toBe(true);
  });

  it('tracks each key separately', () => {
    const cache = new NonceCache(TTL);
    cache.seen('alice.testnet:n1', 1_000);
    expect(cache.seen('alice.testnet:n2', 1_000)).toBe(false);
    expect(cache.seen('bob.testnet:n1', 1_000)).toBe(false);
  });

  it('drops every expired entry on each call, so the cache does not grow', () => {
    const cache = new NonceCache(TTL);
    cache.seen('a', 0);
    cache.seen('b', 1);
    cache.seen('c', 2);
    const deleted = vi.spyOn(Map.prototype, 'delete');
    try {
      cache.seen('d', TTL + 1);
      expect(deleted.mock.calls.map(([key]) => key)).toEqual(['a', 'b']);
    } finally {
      deleted.mockRestore();
    }
  });
});
