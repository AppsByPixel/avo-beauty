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

/**
 * An adjustment — the owner console's Wallet adjust, `POST /members/{id}/adjustments`.
 *
 * SIGNED, ONE OPERATION TWO WAYS. `parseSignedFils` refuses zero ("nothing to
 * adjust"), so unlike a charge this kind cannot be 0 — but it can be either
 * direction, and the direction is carried by `amountFils` alone. The ledger
 * agrees: `direction: amountFils > 0 ? 'credit' : 'debit'`.
 *
 * WHAT THE SHEET MUST NOT SAY is the interesting half, and both omissions are
 * asserted below rather than described: no payment route (`method` is the
 * column's default, not a route — and on a credit "Paid from" is backwards) and
 * no branch (the API writes the salon's first branch with `branchAssumed: true`,
 * a flag the wire does not carry). The reason is not on the wire at all.
 */
function adjustment(amountFils: number): Transaction {
  return {
    id: 'TX-ADJ-4f2a9b1c8e03',
    memberId: '8842',
    branchId: 'BR-KWC',
    kind: 'adjustment',
    amountFils,
    bonusFils: 0,
    // As the route writes it — a movement with no payment route.
    method: 'wallet',
    status: 'settled',
    reference: 'AVO-ADJ-4f2a9b1c8e03',
    createdAt: '2026-08-19T06:16:00.000Z',
    voidedAt: null,
    reversedByTransactionId: null,
  } as Transaction;
}

describe('an adjustment reads honestly in both directions', () => {
  it('a credit is a plus, in both languages', () => {
    for (const [lang, copy] of [['en', en], ['ar', ar]] as const) {
      const r = buildReceipt(adjustment(5000), BRANCHES, lang, copy);
      expect(r.amount).toBe('+5.000');
      expect(r.positive).toBe(true);
      expect(r.amountLabel).toContain('5.000');
    }
  });

  it('a deduction is a minus, in both languages', () => {
    for (const [lang, copy] of [['en', en], ['ar', ar]] as const) {
      const r = buildReceipt(adjustment(-5000), BRANCHES, lang, copy);
      // U+2212, the character the design sets — not a hyphen.
      expect(r.amount).toBe('−5.000');
      expect(r.positive).toBe(false);
    }
  });

  it('is titled as an adjustment, not left blank or generic', () => {
    expect(buildReceipt(adjustment(5000), BRANCHES, 'en', en).title).toBe(en.txKind.adjustment);
    expect(buildReceipt(adjustment(5000), BRANCHES, 'en', en).title).not.toBe('');
  });

  it('shows the amount as a row, unsigned, so the figure is legible twice', () => {
    const rows = buildReceipt(adjustment(-5000), BRANCHES, 'en', en).rows;
    expect(rows.map((r) => r.label)).toContain(en.txAmountRow);
    // With the currency, as `money()` formats it — the row is a full figure,
    // and unsigned: the direction is stated once, in the headline above it.
    expect(rows.find((r) => r.label === en.txAmountRow)?.value).toBe('5.000 KD');
  });

  /**
   * THE TWO OMISSIONS. Both directions, because a credit is the case where
   * "Paid from" is not merely noise but the opposite of what happened.
   */
  it('never claims a payment route — there was none', () => {
    for (const amount of [5000, -5000]) {
      const rows = buildReceipt(adjustment(amount), BRANCHES, 'en', en).rows;
      const labels = rows.map((r) => r.label);
      expect(labels).not.toContain(en.txPaidFrom);
      expect(labels).not.toContain(en.txPaidWith);
      expect(rows.map((r) => r.value)).not.toContain(en.txMethod.wallet);
    }
  });

  it('never names a branch — the API assumed one and the wire cannot say so', () => {
    for (const amount of [5000, -5000]) {
      const rows = buildReceipt(adjustment(amount), BRANCHES, 'en', en).rows;
      expect(rows.map((r) => r.label)).not.toContain(en.txBranch);
      expect(rows.map((r) => r.value)).not.toContain('Kuwait City');
    }
  });

  /**
   * The reason is stored server-side and deliberately not emitted. This asserts
   * the sheet does not grow a row for it by accident — and that it does not
   * imply one: exactly one row, the amount.
   */
  it('offers no reason and implies none', () => {
    const rows = buildReceipt(adjustment(-5000), BRANCHES, 'en', en).rows;
    expect(rows).toHaveLength(1);
  });

  it('still carries the reference, which is what support can act on', () => {
    expect(buildReceipt(adjustment(-5000), BRANCHES, 'en', en).reference).toBe(
      'AVO-ADJ-4f2a9b1c8e03',
    );
  });
});
