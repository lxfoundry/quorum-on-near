/** `seats × seat_price`. Throws RangeError unless `seats` is a non-negative safe integer. */
export function priceOf(seats: number, seatPrice: bigint): bigint {
  if (!Number.isSafeInteger(seats) || seats < 0) throw new RangeError(`invalid seat count: ${seats}`);
  return BigInt(seats) * seatPrice;
}

/** The least a seat receives from the bonus if the pool fails: `floor(bonus / max(target − 1, 1))`. */
export function minBonusPerSeat(bonus: bigint, target: number): bigint {
  return bonus / BigInt(Math.max(target - 1, 1));
}

const DECIMAL = /^(0|[1-9][0-9]*)$/;

/** Parses a decimal amount string: `"0"`, or digits with no leading zero. Returns null otherwise. */
export function parseAmount(value: unknown): bigint | null {
  if (typeof value !== 'string' || !DECIMAL.test(value)) return null;
  return BigInt(value);
}
