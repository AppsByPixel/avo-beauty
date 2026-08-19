/**
 * The receipt headline's sign, and the zero that had the wrong one.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * A CHARGE SETTLED ENTIRELY BY A HELD DEPOSIT, DRIVEN BEFORE THIS WAS WRITTEN.
 *
 * `POST /charges` caps the applied deposit at the basket — `heldDeposit =
 * min(gross, held)` in `api/src/services/charge.ts` — so a hold that covers the
 * whole visit leaves `due` at 0 and the row is written `amountFils: 0`. It is a
 * real transaction, not a hypothetical:
 *
 *   salon deposit 6000, service SV-04 Manicure 6000
 *   POST /bookings   -> BK-4676654, deposit_held, balance 12500 -> 6500
 *   POST /charges    -> 200 {"amountFils":0,"depositAppliedFils":6000,
 *                            "depositReturnedFils":0,"balanceAfterFils":6500}
 *
 * The booking has to start within the hold window (`findApplicableHold` matches
 * `startsAt <= now + noShowReturnMinutes`, 60 minutes), which is why the first
 * attempt two days out applied nothing and is worth writing down.
 *
 * `positive` is `headline > 0`, so a zero took the negative branch and the sheet
 * rendered `−0.000`, spoken as "minus 0.000 Kuwaiti dinars" in English and with
 * the same English "minus" in Arabic (`plus`/`minus` are AR_GAPS). Nothing left
 * her wallet; the minus asserted a direction that did not occur.
 * ═════════════════════════════════════════════════════════════════════════════
 */

import { describe, expect, it } from 'vitest';
import type { Transaction } from '@avo/types';
import { buildReceipt } from './receipt';
import { en } from '../copy/en';
import { ar } from '../copy/ar';

const BRANCHES = [{ id: 'BR-KWC', name: 'Kuwait City' }];

/** The driven zero-debit charge, field for field off the wire. */
function charge(amountFils: number): Transaction {
  return {
    id: 'TX-5719874',
    memberId: '8842',
    branchId: 'BR-KWC',
    kind: 'charge',
    amountFils,
    bonusFils: 0,
    method: 'wallet',
    status: 'settled',
    reference: 'AVO-CHG-5719874',
    createdAt: '2026-08-19T06:16:00.000Z',
    voidedAt: null,
    reversedByTransactionId: null,
  } as Transaction;
}

describe('a charge the held deposit covered entirely', () => {
  it('renders the zero without a sign, in both languages', () => {
    expect(buildReceipt(charge(0), BRANCHES, 'en', en).amount).toBe('0.000');
    expect(buildReceipt(charge(0), BRANCHES, 'ar', ar).amount).toBe('0.000');
  });

  /**
   * The glyph and the announcement have to agree. A sighted customer seeing
   * `0.000` while a screen reader says "minus 0.000" is the same defect half
   * fixed, and this is the half that is easy to forget.
   */
  it('announces the bare amount, never "minus 0.000"', () => {
    for (const [lang, copy] of [['en', en], ['ar', ar]] as const) {
      const label = buildReceipt(charge(0), BRANCHES, lang, copy).amountLabel;
      // `plus`/`minus` are AR_GAPS, so the Arabic label carries the English
      // "minus" too — which is why both languages are checked for the word.
      expect(label).not.toContain('minus');
      expect(label).not.toBe(copy.minus(label));
    }
    // Pinned positively as well, so a copy change is visible rather than merely
    // still-not-containing-a-word.
    expect(buildReceipt(charge(0), BRANCHES, 'en', en).amountLabel).toBe(
      '0.000 Kuwaiti dinars',
    );
    expect(buildReceipt(charge(0), BRANCHES, 'ar', ar).amountLabel).toBe(
      '0.000 دينار كويتي',
    );
  });

  /**
   * THE FIGURE IS NOT RECOMPUTED. Trunk's call on this frame is "leave the figure,
   * fix the frame" — rendering the 6.000 gross under a receipt for a transaction
   * the server recorded as 0 would be the client inventing a debit (#2).
   */
  it('does not substitute the gross it never received', () => {
    const r = buildReceipt(charge(0), BRANCHES, 'en', en);
    expect(r.amount).not.toContain('6.000');
    expect(r.rows.find((row) => row.label === en.txAmountRow)?.value).toBe('0.000 KD');
  });

  /** A zero is not a credit — the headline must not turn green. */
  it('is not styled as money coming in', () => {
    expect(buildReceipt(charge(0), BRANCHES, 'en', en).positive).toBe(false);
  });
});

describe('the sign on every other headline is unchanged', () => {
  it('keeps the minus on a real debit', () => {
    const r = buildReceipt(charge(-6000), BRANCHES, 'en', en);
    // U+2212 MINUS, not a hyphen — the character the design sets.
    expect(r.amount).toBe('−6.000');
    expect(r.amountLabel).toBe(en.minus('6.000 Kuwaiti dinars'));
    expect(r.positive).toBe(false);
  });

  it('keeps the plus on money coming in', () => {
    const returned = { ...charge(4000), kind: 'deposit_return' } as Transaction;
    const r = buildReceipt(returned, BRANCHES, 'en', en);
    expect(r.amount).toBe('+4.000');
    expect(r.amountLabel).toBe(en.plus('4.000 Kuwaiti dinars'));
    expect(r.positive).toBe(true);
  });
});
