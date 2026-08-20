/**
 * The activity ROW — and the half of a fix that was applied to the sheet and
 * not to the list above it.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE ZERO, IN THE ROW THIS TIME. d29fdb4 fixed `domain/receipt.ts` for a charge
 * a held deposit covered entirely — a real settled `amountFils: 0` row, because
 * `POST /charges` caps the applied deposit at the basket. `receipt.test.ts`
 * carries the driven evidence.
 *
 * That fix went into the DETAIL SHEET only. `toActivityRow` computes `positive`
 * the same way (`amount > 0`), so zero took the negative branch and the LIST
 * still rendered `−0.000`, announced "minus 0.000 Kuwaiti dinars". Same
 * transaction, two answers, and tapping the row changed which one she got —
 * which is the tell that only ever shows up if you check both surfaces.
 *
 * There was no spec on this module at all, which is how the list kept the defect
 * while the sheet's fix shipped with six of them.
 * ═════════════════════════════════════════════════════════════════════════════
 */

import { describe, expect, it } from 'vitest';
import type { Transaction } from '@avo/types';
import { toActivityRow } from './activity';
import { en } from '../copy/en';
import { ar } from '../copy/ar';

const BRANCHES = [{ id: 'BR-KWC', name: 'Kuwait City' }];

function tx(over: Partial<Transaction>): Transaction {
  return {
    id: 'TX-5719874',
    memberId: '8842',
    branchId: 'BR-KWC',
    kind: 'charge',
    amountFils: -5000,
    bonusFils: 0,
    method: 'wallet',
    status: 'settled',
    reference: 'AVO-CHG-5719874',
    createdAt: '2026-08-19T06:16:00.000Z',
    voidedAt: null,
    reversedByTransactionId: null,
    ...over,
  } as Transaction;
}

describe('a zero-amount row carries no sign', () => {
  it('renders 0.000 without a minus, in both languages', () => {
    for (const [lang, copy] of [['en', en], ['ar', ar]] as const) {
      const row = toActivityRow(tx({ amountFils: 0 }), BRANCHES, lang, copy);
      expect(row.amount).toBe('0.000');
      expect(row.amount).not.toContain('−');
      expect(row.amount).not.toContain('-');
    }
  });

  it('announces the bare amount, never "minus 0.000"', () => {
    for (const [lang, copy] of [['en', en], ['ar', ar]] as const) {
      // `plus`/`minus` are AR_GAPS, so the Arabic label carries the English
      // word too — which is why both languages are checked for it.
      const label = toActivityRow(tx({ amountFils: 0 }), BRANCHES, lang, copy).amountLabel;
      expect(label).not.toContain('minus');
      expect(label).not.toContain('plus');
      expect(label).toContain('0.000');
    }
  });

  /**
   * AGREEMENT WITH THE SHEET IS THE ACTUAL REQUIREMENT. The row and the sheet it
   * opens must not disagree about direction — that is the defect this file was
   * written for, so it is asserted directly rather than left implied by two
   * passing suites.
   */
  it('agrees with the detail sheet on the same transaction', async () => {
    const { buildReceipt } = await import('./receipt');
    const zero = tx({ amountFils: 0 });
    expect(toActivityRow(zero, BRANCHES, 'en', en).amount).toBe(
      buildReceipt(zero, BRANCHES, 'en', en).amount,
    );
  });
});

describe('the sign on every other row is unchanged', () => {
  it('keeps the minus on a real debit', () => {
    const row = toActivityRow(tx({ amountFils: -5000 }), BRANCHES, 'en', en);
    expect(row.amount).toBe('−5.000');
    expect(row.positive).toBe(false);
  });

  it('keeps the plus on money coming in', () => {
    const row = toActivityRow(tx({ kind: 'deposit_return', amountFils: 5000 }), BRANCHES, 'en', en);
    expect(row.amount).toBe('+5.000');
    expect(row.positive).toBe(true);
  });

  /**
   * A top-up's row shows what LANDED — amount + bonus — which is the design's
   * own "+27.500" for a 25.000 payment with a 2.500 bonus. Pinned here because
   * the zero change touches the same expression.
   */
  it('still shows a top-up as what landed, not what was paid', () => {
    const row = toActivityRow(
      tx({ kind: 'topup', amountFils: 25000, bonusFils: 2500, method: 'knet' }),
      BRANCHES,
      'en',
      en,
    );
    expect(row.amount).toBe('+27.500');
  });
});

describe('an adjustment', () => {
  const adj = (amountFils: number) =>
    tx({ kind: 'adjustment', amountFils, reference: 'AVO-ADJ-4f2a9b1c8e03' });

  it('is titled, not blank or fallen-through', () => {
    const row = toActivityRow(adj(5000), BRANCHES, 'en', en);
    expect(row.title).toBe(en.txKind.adjustment);
    expect(row.title.trim()).not.toBe('');
  });

  it('reads as a credit when the console added credit', () => {
    const row = toActivityRow(adj(5000), BRANCHES, 'en', en);
    expect(row.amount).toBe('+5.000');
    expect(row.positive).toBe(true);
  });

  it('reads as a deduction when the console took it away', () => {
    const row = toActivityRow(adj(-5000), BRANCHES, 'en', en);
    expect(row.amount).toBe('−5.000');
    expect(row.positive).toBe(false);
  });

  /**
   * The title must not pick up a payment method the way a top-up does —
   * `method: 'wallet'` is the column's default for a movement with no route, and
   * "Adjustment · Wallet balance" would assert one.
   */
  it('does not append a payment method to the title', () => {
    const row = toActivityRow(adj(-5000), BRANCHES, 'en', en);
    expect(row.title).not.toContain(en.txMethod.wallet);
    expect(row.title).not.toContain('·');
  });

  /**
   * MONEY IS WESTERN DIGITS IN BOTH LANGUAGES (#12) — asserted on this kind
   * because it is the newest one and the digit rule's exception is easy to miss
   * when adding a case.
   */
  it('keeps Western digits in Arabic', () => {
    const row = toActivityRow(adj(-5000), BRANCHES, 'ar', ar);
    expect(row.amount).toBe('−5.000');
    for (const eastern of ['٠', '١', '٢', '٣', '٤', '٥']) {
      expect(row.amount).not.toContain(eastern);
    }
  });
});
