import { describe, expect, it } from 'vitest';
import { commitMsg, parseEventLog, type QuorumEvent } from '../src/contract.ts';

/** A log line with the given body, as the pools contract writes it. */
function logLine(body: unknown): string {
  return `EVENT_JSON:${JSON.stringify(body)}`;
}

/** The NEP-297 envelope the pools contract puts around one event. */
function envelope(event: string, data: unknown): Record<string, unknown> {
  return { standard: 'quorum', version: '1.0.0', event, data: [data] };
}

const EVENTS: QuorumEvent[] = [
  {
    event: 'pool_opened',
    data: {
      pool_id: 7,
      seller: 'provider.parent.testnet',
      seat_price: '180',
      target: 192,
      deadline_ms: 1_800_000_000_000,
      bonus: '1728',
      terms: '8×GPU × 24 h; 1 seat = 1 GPU-hour; prices at 1/10,000 scale',
    },
  },
  {
    event: 'seats_committed',
    data: { pool_id: 7, buyer: 'buyer-01.parent.testnet', seats: 2, amount: '360', taken: 150, target: 192 },
  },
  { event: 'pool_filled', data: { pool_id: 7, taken: 192 } },
  { event: 'pool_settled', data: { pool_id: 7, seller: 'provider.parent.testnet', amount: '36288' } },
  {
    event: 'seat_refunded',
    data: { pool_id: 8, buyer: 'buyer-01.parent.testnet', seats: 2, amount: '700', bonus_share: '60' },
  },
  { event: 'refund_failed', data: { pool_id: 8, buyer: 'buyer-02.parent.testnet', amount: '350' } },
  { event: 'refund_claimed', data: { pool_id: 8, buyer: 'buyer-02.parent.testnet', amount: '350' } },
  { event: 'pool_refunded', data: { pool_id: 8, dust: '72' } },
];

describe('commitMsg', () => {
  it('writes the commit message as compact JSON with snake_case keys', () => {
    expect(commitMsg(7, 2)).toBe('{"commit":{"pool_id":7,"seats":2}}');
  });

  it('writes pool 0 as the number 0', () => {
    expect(commitMsg(0, 1)).toBe('{"commit":{"pool_id":0,"seats":1}}');
  });
});

describe('parseEventLog', () => {
  it.each(EVENTS.map((e) => [e.event, e] as const))('parses a %s event', (_name, event) => {
    expect(parseEventLog(logLine(envelope(event.event, event.data)))).toStrictEqual(event);
  });

  it('parses a log line written as a literal string', () => {
    const line =
      'EVENT_JSON:{"data":[{"pool_id":7,"taken":192}],"event":"pool_filled","standard":"quorum","version":"1.0.0"}';
    expect(parseEventLog(line)).toStrictEqual({ event: 'pool_filled', data: { pool_id: 7, taken: 192 } });
  });

  it('ignores fields of the envelope other than event and data', () => {
    const body = { ...envelope('pool_filled', { pool_id: 7, taken: 192 }), extra: true };
    expect(parseEventLog(logLine(body))).toStrictEqual({ event: 'pool_filled', data: { pool_id: 7, taken: 192 } });
  });

  it('returns null for another standard', () => {
    const body = { ...envelope('pool_filled', { pool_id: 7, taken: 192 }), standard: 'nep141' };
    expect(parseEventLog(logLine(body))).toBeNull();
  });

  it('returns null for a missing standard', () => {
    const { standard: _omitted, ...body } = envelope('pool_filled', { pool_id: 7, taken: 192 });
    expect(parseEventLog(logLine(body))).toBeNull();
  });

  it('returns null for another version', () => {
    const body = { ...envelope('pool_filled', { pool_id: 7, taken: 192 }), version: '1.0.1' };
    expect(parseEventLog(logLine(body))).toBeNull();
  });

  it('returns null for a version written as a number', () => {
    const body = { ...envelope('pool_filled', { pool_id: 7, taken: 192 }), version: 1 };
    expect(parseEventLog(logLine(body))).toBeNull();
  });

  it('returns null for an unknown event name', () => {
    expect(parseEventLog(logLine(envelope('pool_closed', { pool_id: 7 })))).toBeNull();
  });

  it('returns null for an event name that is not a string', () => {
    const body = { ...envelope('pool_filled', { pool_id: 7, taken: 192 }), event: 1 };
    expect(parseEventLog(logLine(body))).toBeNull();
  });

  it('returns null when data is an object instead of an array', () => {
    const body = { ...envelope('pool_filled', {}), data: { pool_id: 7, taken: 192 } };
    expect(parseEventLog(logLine(body))).toBeNull();
  });

  it('returns null when data is an empty array', () => {
    const body = { ...envelope('pool_filled', {}), data: [] };
    expect(parseEventLog(logLine(body))).toBeNull();
  });

  it('returns null when data has two elements', () => {
    const body = { ...envelope('pool_filled', {}), data: [{ pool_id: 7, taken: 192 }, { pool_id: 8, taken: 3 }] };
    expect(parseEventLog(logLine(body))).toBeNull();
  });

  it('returns null when data is missing', () => {
    const { data: _omitted, ...body } = envelope('pool_filled', {});
    expect(parseEventLog(logLine(body))).toBeNull();
  });

  it.each([
    ['a number', 7],
    ['a string', 'pool 7'],
    ['null', null],
    ['an array', [7, 192]],
  ])('returns null when the data element is %s', (_kind, element) => {
    expect(parseEventLog(logLine(envelope('pool_filled', element)))).toBeNull();
  });

  it('returns null when the body is not JSON', () => {
    expect(parseEventLog('EVENT_JSON:{"standard":"quorum",')).toBeNull();
  });

  it.each([
    ['null', null],
    ['a string', 'quorum'],
    ['an array', [envelope('pool_filled', { pool_id: 7, taken: 192 })]],
  ])('returns null when the body is %s', (_kind, body) => {
    expect(parseEventLog(logLine(body))).toBeNull();
  });

  it('returns null without the EVENT_JSON: prefix', () => {
    expect(parseEventLog(JSON.stringify(envelope('pool_filled', { pool_id: 7, taken: 192 })))).toBeNull();
  });

  it('returns null when the prefix is not at the start of the line', () => {
    expect(parseEventLog(` ${logLine(envelope('pool_filled', { pool_id: 7, taken: 192 }))}`)).toBeNull();
  });

  it('returns null for a prefix in another case', () => {
    const line = `event_json:${JSON.stringify(envelope('pool_filled', { pool_id: 7, taken: 192 }))}`;
    expect(parseEventLog(line)).toBeNull();
  });

  it('returns null for a plain log line', () => {
    expect(parseEventLog('Transfer 360 from buyer-01.parent.testnet to pools.parent.testnet')).toBeNull();
  });

  it('returns null for an empty line', () => {
    expect(parseEventLog('')).toBeNull();
  });
});
