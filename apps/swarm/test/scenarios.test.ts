import { describe, expect, it } from 'vitest';
import { isScenarioName, scenario, type Scenario } from '../src/scenarios.ts';

const TERMS = '8×GPU × 24 h; 1 seat = 1 GPU-hour; prices at 1/10,000 scale';
const DEFAULTS = { deadlineSeconds: null, spreadSeconds: null };

describe('scenario', () => {
  it('fills: 192 seats at 180 with a 1,728 bonus for 10 minutes, buyers arriving over 2 minutes, ending Settled', () => {
    expect(scenario('fills', DEFAULTS)).toEqual<Scenario>({
      name: 'fills',
      seatPrice: 180n,
      target: 192,
      bonus: 1_728n,
      maxSeatsPerBuyer: 24,
      terms: TERMS,
      deadlineSeconds: 600,
      spreadSeconds: 120,
      expectedEnd: 'settled',
    });
  });

  it('fails: 192 seats at 320 with a 3,072 bonus for 3 minutes, buyers arriving over 1 minute, ending Refunded', () => {
    expect(scenario('fails', DEFAULTS)).toEqual<Scenario>({
      name: 'fails',
      seatPrice: 320n,
      target: 192,
      bonus: 3_072n,
      maxSeatsPerBuyer: 24,
      terms: TERMS,
      deadlineSeconds: 180,
      spreadSeconds: 60,
      expectedEnd: 'refunded',
    });
  });

  it('takes the deadline and the spread from the configuration when they are set, for both scenarios', () => {
    const config = { deadlineSeconds: 45, spreadSeconds: 5 };
    for (const name of ['fills', 'fails'] as const) {
      expect(scenario(name, config)).toMatchObject({ name, deadlineSeconds: 45, spreadSeconds: 5 });
    }
  });

  it('keeps the spread of 0 the configuration may set, which makes every buyer arrive at once', () => {
    expect(scenario('fills', { deadlineSeconds: null, spreadSeconds: 0 }).spreadSeconds).toBe(0);
  });

  it('gives each call its own copy, so that a caller cannot change the scenario of another', () => {
    const first = scenario('fills', DEFAULTS);
    first.seatPrice = 1n;
    expect(scenario('fills', DEFAULTS).seatPrice).toBe(180n);
  });
});

describe('isScenarioName', () => {
  it.each([
    ['fills', true],
    ['fails', true],
    ['FILLS', false],
    ['fill', false],
    ['', false],
    ['toString', false],
    ['__proto__', false],
  ])('%j is a scenario name: %s', (value, expected) => {
    expect(isScenarioName(value)).toBe(expected);
  });
});
