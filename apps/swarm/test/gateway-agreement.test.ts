// What the buyer package assumes of the gateway, checked against the gateway's own sources: the
// swarm itself never imports another app.
import { SETTLE_MARGIN_BLOCKS } from '@quorum-on-near/buyer';
import { describe, expect, it } from 'vitest';
import { RECEIPT_MARGIN_BLOCKS } from '../../gateway/src/chain.ts';

describe('the buyer package and the gateway', () => {
  it('wait after a payment whose result is unknown at least as long as the gateway holds its buyer', () => {
    // A buyer that paid again sooner would only be refused payment_in_flight.
    expect(SETTLE_MARGIN_BLOCKS >= RECEIPT_MARGIN_BLOCKS).toBe(true);
  });
});
