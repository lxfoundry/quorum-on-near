import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isAllowedViewCall } from '../src/view-call.ts';

const POOLS = 'pools.parent.testnet';
const TOKEN = 'usdc.testnet';

function call(params: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'query',
    params: { request_type: 'call_function', account_id: POOLS, method_name: 'get_pool', args_base64: 'e30=', finality: 'final', ...params },
  };
}

describe('view-call.ts', () => {
  // The live page's tests import this file to check the bodies the page builds against the pass-through,
  // so it must not need anything installed for the gateway.
  it('imports nothing', () => {
    const source = readFileSync(new URL('../src/view-call.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/^\s*import\s|\brequire\(|\bimport\(/m);
  });
});

describe('isAllowedViewCall', () => {
  it.each([
    ['a view on the pools contract at final finality', call()],
    ['a view on the token', call({ account_id: TOKEN })],
    ['a view at a block hash', call({ finality: undefined, block_id: 'GZ3Ya1qXp7kN8mWcT4vB9rHfJ2sLdE6uQyKxM5nPaRtV' })],
    ['a view at a block height', call({ finality: undefined, block_id: 1000 })],
    ['args_base64 of 1024 characters', call({ args_base64: 'A'.repeat(1024) })],
  ])('allows %s', (_what, body) => {
    expect(isAllowedViewCall(JSON.parse(JSON.stringify(body)), [POOLS, TOKEN])).toBe(true);
  });

  it.each([
    ['another account', call({ account_id: 'other.testnet' })],
    ['another request type', call({ request_type: 'view_account' })],
    ['args_base64 of 1025 characters', call({ args_base64: 'A'.repeat(1025) })],
    ['a block reference and a finality', call({ block_id: 'abc' })],
    ['an extra field', call({ extra: 1 })],
    ['another method', { ...call(), method: 'status' }],
    ['a batch', [call()]],
    ['no body', null],
  ])('refuses %s', (_what, body) => {
    expect(isAllowedViewCall(JSON.parse(JSON.stringify(body)), [POOLS, TOKEN])).toBe(false);
  });
});
