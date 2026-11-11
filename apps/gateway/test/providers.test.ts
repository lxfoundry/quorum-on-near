import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRelayerProvider } from '../src/providers.ts';

describe('createRelayerProvider', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // near-api-js 7.4.0 re-posts a request the RPC answers with HTTP 408, 500 or 503 unless it is built
  // with `retries: 1`. A transaction posted twice could be sent twice, so the provider must post once.
  it.each([408, 500, 503])('posts a request once when the RPC answers HTTP %i', async (status) => {
    const posts: string[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
      posts.push(init.body);
      return new Response('error', { status });
    });
    await expect(createRelayerProvider('http://rpc.invalid').viewBlock({ finality: 'final' })).rejects.toThrow();
    expect(posts).toHaveLength(1);
  });
});
