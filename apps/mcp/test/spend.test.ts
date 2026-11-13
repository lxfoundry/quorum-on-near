import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PaymentNotSentError, readSpendFile, SpendFileError, writeSpendFile, type BuyerPaymentAnswer } from '@quorum-on-near/buyer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PaymentOutcomeUnknownError, SpendLedger } from '../src/spend.ts';
import { BUYER, filled, offerFor, pending, signed, TX_HASH } from './fixtures.ts';

/** The offer for 2 seats at 180: a payment of 360. */
const OFFER = offerFor(2);
const CAP = 1000n;

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'quorum-mcp-spend-'));
  path = join(dir, 'state', 'mcp-spend.json');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function ledger(cap = CAP, log?: (line: string) => void): SpendLedger {
  return new SpendLedger({ path, account: BUYER, cap, ...(log === undefined ? {} : { log }) });
}

/** A send that records each call and answers `answer`. */
function sender(answer: BuyerPaymentAnswer) {
  const calls: bigint[] = [];
  const send = async (maxAmount: bigint): Promise<BuyerPaymentAnswer> => {
    calls.push(maxAmount);
    return answer;
  };
  return { send, calls };
}

describe('SpendLedger.left', () => {
  it('is the whole cap when nothing was spent, with no spend file yet', async () => {
    expect(await ledger().left()).toBe(1000n);
  });

  it('is the cap less the total in the spend file', async () => {
    await writeSpendFile(path, BUYER, 640n);
    expect(await ledger().left()).toBe(360n);
  });

  it('is 0 when the total is above the cap', async () => {
    await writeSpendFile(path, BUYER, 1500n);
    expect(await ledger().left()).toBe(0n);
  });

  it("refuses a spend file that holds another account's total", async () => {
    await writeSpendFile(path, `buyer-01.parent.testnet`, 0n);
    await expect(ledger().left()).rejects.toMatchObject({ name: 'SpendFileError', problem: 'other_account' });
  });
});

describe('SpendLedger.pay', () => {
  it('reserves the price in the spend file before sending, and passes it as the most to pay', async () => {
    await writeSpendFile(path, BUYER, 100n);
    let reserved: bigint | undefined;
    const result = await ledger().pay(OFFER, async (maxAmount) => {
      reserved = await readSpendFile(path, BUYER);
      expect(maxAmount).toBe(360n);
      return pending(2);
    });
    expect(reserved).toBe(460n);
    expect(result).toEqual({ kind: 'answered', answer: pending(2), spent: 360n, left: 540n });
  });

  const NO_SEATS: BuyerPaymentAnswer[] = [
    { kind: 'declined', refusal: { code: 'wrong_pay_to', detail: 'payTo is not pools.parent.testnet' } },
    signed({ kind: 'refused', error: 'insufficient_balance', offer: OFFER }),
    signed({ kind: 'no_seats_taken' }),
    signed({ kind: 'pool_expired', txHash: TX_HASH }),
    signed({ kind: 'unknown_pool' }),
    signed({ kind: 'unavailable' }),
  ];

  it.each(NO_SEATS)('releases the reserved price when the answer is $kind: nothing was spent', async (answer) => {
    await writeSpendFile(path, BUYER, 100n);
    const result = await ledger().pay(OFFER, sender(answer).send);
    expect(result).toEqual({ kind: 'answered', answer, spent: 0n, left: 900n });
    expect(await readSpendFile(path, BUYER)).toBe(100n);
  });

  it.each([
    ['a 202 for every seat paid', pending(2), 360n],
    ['a 202 for fewer seats than paid', pending(1), 180n],
    ['a 200 for every seat paid', filled(2), 360n],
    ['a 200 for fewer seats than paid', filled(1), 180n],
    ['a 200 that also counts seats held before', filled(5), 360n],
    ['a relay_failed 502', signed({ kind: 'relay_failed', txHash: TX_HASH }), 360n],
    ['a result_unknown 502', signed({ kind: 'result_unknown', txHash: TX_HASH }), 360n],
  ])('keeps the seats taken at the seat price, at most the reserved price, for %s', async (_, answer, spent) => {
    await writeSpendFile(path, BUYER, 100n);
    const result = await ledger().pay(OFFER, sender(answer).send);
    expect(result).toEqual({ kind: 'answered', answer, spent, left: 900n - spent });
    expect(await readSpendFile(path, BUYER)).toBe(100n + spent);
  });

  it('refuses a payment above what is left, and sends nothing', async () => {
    await writeSpendFile(path, BUYER, 700n);
    const { send, calls } = sender(pending(2));
    expect(await ledger().pay(OFFER, send)).toEqual({ kind: 'over_spend_cap', amount: 360n, left: 300n });
    expect(calls).toEqual([]);
    expect(await readSpendFile(path, BUYER)).toBe(700n);
  });

  it('pays exactly what is left', async () => {
    await writeSpendFile(path, BUYER, 640n);
    expect(await ledger().pay(OFFER, sender(pending(2)).send)).toMatchObject({ kind: 'answered', spent: 360n, left: 0n });
  });

  it('keeps the price reserved and throws PaymentOutcomeUnknownError when sending fails', async () => {
    const cause = new TypeError('fetch failed');
    const error = await ledger()
      .pay(OFFER, async () => {
        throw cause;
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PaymentOutcomeUnknownError);
    expect(error).toMatchObject({ amount: 360n, cause, message: 'the payment of 360 may have been sent' });
    expect(await readSpendFile(path, BUYER)).toBe(360n);
  });

  it('releases the reserved price when the payment was never sent, and answers not_sent', async () => {
    await writeSpendFile(path, BUYER, 100n);
    const error = new PaymentNotSentError('chain_read', 'could not read the final block: nothing was sent', new Error('502'));
    const result = await ledger().pay(OFFER, async () => {
      expect(await readSpendFile(path, BUYER)).toBe(460n);
      throw error;
    });
    expect(result).toEqual({ kind: 'not_sent', error, left: 900n });
    expect(await readSpendFile(path, BUYER)).toBe(100n);
  });

  it('keeps what another writer added when it releases a payment that was never sent', async () => {
    await writeSpendFile(path, BUYER, 100n);
    const result = await ledger().pay(OFFER, async () => {
      await writeSpendFile(path, BUYER, 100n + 360n + 50n);
      throw new PaymentNotSentError('signing', 'could not sign the payment: nothing was sent', new Error('bad key'));
    });
    expect(result).toMatchObject({ kind: 'not_sent', left: CAP - 150n });
    expect(await readSpendFile(path, BUYER)).toBe(150n);
  });

  describe('when the total cannot be settled once the payment is answered', () => {
    /** A send that leaves the spend file unreadable as a total, then answers `answer` or throws it. */
    const breaking = (answer: BuyerPaymentAnswer | Error) => async (): Promise<BuyerPaymentAnswer> => {
      await writeFile(path, 'not a spend file');
      if (answer instanceof Error) throw answer;
      return answer;
    };

    it('still returns the answer, counting its whole price, and logs why', async () => {
      await writeSpendFile(path, BUYER, 100n);
      const logs: string[] = [];
      const result = await ledger(CAP, (line) => logs.push(line)).pay(OFFER, breaking(pending(1)));
      // The reservation, 100 + 360, is what the file was last written with.
      expect(result).toEqual({ kind: 'answered', answer: pending(1), spent: 360n, left: 540n });
      expect(logs).toEqual([expect.stringMatching(/^the spend total could not be settled .*360.* stays counted/)]);
      expect(logs[0]).toContain('does not hold an account and a decimal total');
      expect(await readFile(path, 'utf8')).toBe('not a spend file');
    });

    it('still answers not_sent for a payment that was never sent, its price still counted', async () => {
      await writeSpendFile(path, BUYER, 100n);
      const logs: string[] = [];
      const error = new PaymentNotSentError('signing', 'could not sign the payment: nothing was sent', new Error('bad key'));
      const result = await ledger(CAP, (line) => logs.push(line)).pay(OFFER, breaking(error));
      expect(result).toEqual({ kind: 'not_sent', error, left: 540n });
      expect(logs).toHaveLength(1);
    });
  });

  it("refuses to count from another account's spend file, and sends nothing", async () => {
    await writeSpendFile(path, 'buyer-01.parent.testnet', 0n);
    const { send, calls } = sender(pending(2));
    await expect(ledger().pay(OFFER, send)).rejects.toBeInstanceOf(SpendFileError);
    expect(calls).toEqual([]);
  });

  it('continues the total of an earlier run: a restart does not reset it', async () => {
    await ledger().pay(OFFER, sender(pending(2)).send);
    expect(await ledger().left()).toBe(640n);
  });

  it('reads the total each time, so a total cleared by setup since the last payment counts from 0', async () => {
    const theLedger = ledger();
    await theLedger.pay(OFFER, sender(pending(2)).send);
    await writeSpendFile(path, BUYER, 0n);
    expect(await theLedger.pay(OFFER, sender(pending(2)).send)).toMatchObject({ spent: 360n, left: 640n });
  });

  it.each([
    ['every seat paid', pending(2), 360n],
    ['fewer seats than paid', pending(1), 180n],
    ['no seats', signed({ kind: 'no_seats_taken' }), 0n],
  ])(
    'counts only its own spend once setup clears the total while the payment is in flight: %s',
    async (_, answer: BuyerPaymentAnswer, spent) => {
      await writeSpendFile(path, BUYER, 100n);
      const result = await ledger().pay(OFFER, async () => {
        await writeSpendFile(path, BUYER, 0n);
        return answer;
      });
      expect(result).toEqual({ kind: 'answered', answer, spent, left: CAP - spent });
      expect(await readSpendFile(path, BUYER)).toBe(spent);
    },
  );

  it('keeps what another writer added to the total while the payment was in flight', async () => {
    await writeSpendFile(path, BUYER, 100n);
    const result = await ledger().pay(OFFER, async () => {
      // Another server sharing the file reserves 360 on top of this payment's reservation.
      await writeSpendFile(path, BUYER, 100n + 360n + 360n);
      return pending(1);
    });
    expect(await readSpendFile(path, BUYER)).toBe(100n + 360n + 180n);
    expect(result).toMatchObject({ spent: 180n, left: CAP - 640n });
  });

  it('sends one payment at a time, each reserved after the one before is counted', async () => {
    const theLedger = ledger();
    let answerFirst: ((answer: BuyerPaymentAnswer) => void) | undefined;
    let firstAnswered = false;
    const first = theLedger.pay(OFFER, () => new Promise((resolve) => (answerFirst = resolve)));
    const second = theLedger.pay(OFFER, async () => {
      expect(firstAnswered).toBe(true);
      expect(await readSpendFile(path, BUYER)).toBe(720n);
      return pending(2);
    });
    await vi.waitFor(() => expect(answerFirst).toBeDefined());
    firstAnswered = true;
    answerFirst?.(pending(2));
    expect(await first).toMatchObject({ spent: 360n, left: 640n });
    expect(await second).toMatchObject({ spent: 360n, left: 280n });
  });

  it('still sends the next payment after one fails', async () => {
    const theLedger = ledger();
    const failed = theLedger.pay(OFFER, async () => {
      throw new TypeError('fetch failed');
    });
    const next = theLedger.pay(OFFER, sender(pending(2)).send);
    await expect(failed).rejects.toBeInstanceOf(PaymentOutcomeUnknownError);
    expect(await next).toMatchObject({ spent: 360n, left: 280n });
  });

  it('writes the total atomically, leaving no temporary file beside it', async () => {
    await ledger().pay(OFFER, sender(signed({ kind: 'no_seats_taken' })).send);
    expect(await readdir(dirname(path))).toEqual(['mcp-spend.json']);
  });
});
