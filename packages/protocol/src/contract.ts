/**
 * The pools contract's JSON interface: view results, the commit message and NEP-297 events.
 * Field names and string forms are the contract's own (snake_case; amounts as decimal strings).
 */
export type PoolStatus = 'open' | 'filled' | 'settled' | 'expired' | 'refunded';
export type BuyerState = 'committed' | 'refunded' | 'claimable';

/** A `get_pool` / `list_pools` row. The contract derives the status from block time. */
export interface PoolView {
  id: number;
  seller: string;
  seat_price: string;
  target: number;
  taken: number;
  deadline_ms: number;
  bonus: string;
  max_seats_per_buyer: number | null;
  terms: string;
  status: PoolStatus;
  bonus_per_seat: string;
  refund_cursor: number;
  dust_sent: boolean;
  buyer_count: number;
}
/** A `get_seats` row. */
export interface SeatView {
  buyer: string;
  seats: number;
  state: BuyerState;
}
/** The `get_buyer` result (the view returns null for an account that holds no seats). */
export interface BuyerView {
  seats: number;
  state: BuyerState;
}
/** The most rows a view returns in one call. */
export const MAX_PAGE = 100;

/** The `msg` of a commit: `{"commit":{"pool_id":7,"seats":2}}`. */
export function commitMsg(poolId: number, seats: number): string {
  return JSON.stringify({ commit: { pool_id: poolId, seats } });
}

export type QuorumEvent =
  | { event: 'pool_opened'; data: { pool_id: number; seller: string; seat_price: string; target: number; deadline_ms: number; bonus: string; terms: string } }
  | { event: 'seats_committed'; data: { pool_id: number; buyer: string; seats: number; amount: string; taken: number; target: number } }
  | { event: 'pool_filled'; data: { pool_id: number; taken: number } }
  | { event: 'pool_settled'; data: { pool_id: number; seller: string; amount: string } }
  | { event: 'seat_refunded'; data: { pool_id: number; buyer: string; seats: number; amount: string; bonus_share: string } }
  | { event: 'refund_failed'; data: { pool_id: number; buyer: string; amount: string } }
  | { event: 'refund_claimed'; data: { pool_id: number; buyer: string; amount: string } }
  | { event: 'pool_refunded'; data: { pool_id: number; dust: string } };

const EVENT_NAMES = new Set<string>([
  'pool_opened',
  'seats_committed',
  'pool_filled',
  'pool_settled',
  'seat_refunded',
  'refund_failed',
  'refund_claimed',
  'pool_refunded',
]);
const EVENT_PREFIX = 'EVENT_JSON:';

/**
 * Parses one log line. Returns the event when the line is `EVENT_JSON:` followed by a JSON object
 * with `standard: "quorum"`, `version: "1.0.0"`, a known `event` name and a one-element `data`
 * array; returns null for any other line. Never throws.
 *
 * Only the envelope is checked: `data` is cast to the event's type, its fields unchecked. Any
 * contract can log such a line, so callers must pass only logs of receipts that the pools contract
 * executed.
 */
export function parseEventLog(log: string): QuorumEvent | null {
  if (!log.startsWith(EVENT_PREFIX)) return null;
  let body: unknown;
  try {
    body = JSON.parse(log.slice(EVENT_PREFIX.length));
  } catch {
    return null;
  }
  if (typeof body !== 'object' || body === null) return null;
  const { standard, version, event, data } = body as Record<string, unknown>;
  if (standard !== 'quorum' || version !== '1.0.0') return null;
  if (typeof event !== 'string' || !EVENT_NAMES.has(event)) return null;
  if (!Array.isArray(data) || data.length !== 1) return null;
  const first: unknown = data[0];
  if (typeof first !== 'object' || first === null || Array.isArray(first)) return null;
  return { event, data: first } as QuorumEvent;
}
