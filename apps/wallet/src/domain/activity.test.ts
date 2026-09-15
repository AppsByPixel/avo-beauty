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

/**
 * BOTH NAMES, AND THAT IS THE POINT. This was
 * `[{ id: 'BR-KWC', name: 'Kuwait City' }]` — a branch carrying no `nameAr` —
 * so every Arabic assertion in this file passed whether or not `toActivityRow`
 * read the field. It did not read it, for months, and this fixture is the reason
 * nothing here noticed. See domain/names.ts.
 */
const BRANCHES = [{ id: 'BR-KWC', name: 'Kuwait City', nameAr: 'مدينة الكويت' }];

/** SAL-LUMIERE's branches are seeded with `name_ar` NULL deliberately. */
const BRANCHES_NO_ARABIC = [{ id: 'BR-KWC', name: 'Kuwait City', nameAr: null }];

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
   * A top-up's row shows what LANDED — and what landed is `amountFils`, because
   * that is what the server writes there.
   *
   * THE FIXTURE IS A REAL ONE AND THE OLD ONE WAS NOT. This test used to pass
   * `{amountFils: 25000, bonusFils: 2500}` and expect `+27.500`, on the theory
   * that `amountFils` is what she paid and the row must add the bonus back. The
   * wire disagrees: `GET /members/me/transactions` on avo_lane_b answered
   * `{"kind":"topup","amountFils":11000,"bonusFils":1000}` for the 10.000
   * payment that moved a Silver member from 24.500 to 35.500 — `amountFils` IS
   * the credit and `bonusFils` is the split beside it. `services/topup.ts`
   * writes `amountFils: intent.creditFils` and says so in a comment.
   *
   * Driven with the old arithmetic, the row read `+12.000` under a balance that
   * had gone up by 11.000.
   */
  it('shows a top-up as the credit the server recorded, not credit plus bonus', () => {
    const row = toActivityRow(
      // Captured, not composed: TX-2665307 on avo_lane_b.
      tx({ kind: 'topup', amountFils: 11000, bonusFils: 1000, method: 'knet' }),
      BRANCHES,
      'en',
      en,
    );
    expect(row.amount).toBe('+11.000');
  });

  it('never adds bonusFils to a top-up figure, whatever the split says', () => {
    // The bonus is reconciliation data travelling alongside the credit. A row
    // that adds it invents money: 11.000 + 1.000 is not a number the ledger,
    // the intent or her balance has ever held.
    for (const bonusFils of [0, 1000, 2500, 5000]) {
      const row = toActivityRow(
        tx({ kind: 'topup', amountFils: 11000, bonusFils, method: 'knet' }),
        BRANCHES,
        'en',
        en,
      );
      expect(row.amount).toBe('+11.000');
    }
  });
});

describe('an adjustment', () => {
  const adj = (amountFils: number) =>
    tx({ kind: 'adjustment', amountFils, reference: 'AVO-ADJ-4f2a9b1c8e03' });

  /**
   * WAS `toBe(en.txKind.adjustment)` IN BOTH DIRECTIONS. "Adjustment" is the
   * word a ledger uses for a row that is, to her, money arriving; a positive one
   * now says "Credit". The DEBIT half is asserted in the same test because a
   * console deduction is also `kind: 'adjustment'`, and calling that a credit
   * would be backwards.
   */
  it('a credit is titled Credit; a deduction is still an Adjustment', () => {
    expect(toActivityRow(adj(5000), BRANCHES, 'en', en).title).toBe(en.txAdjustCredit);
    expect(toActivityRow(adj(-5000), BRANCHES, 'en', en).title).toBe(en.txKind.adjustment);
    expect(toActivityRow(adj(5000), BRANCHES, 'en', en).title.trim()).not.toBe('');
  });

  /**
   * A ZERO ADJUSTMENT KEEPS THE NEUTRAL WORD. `positive` is `amount > 0`, and
   * the title branch uses the same test, so the two cannot disagree about a row
   * that moved nothing — the pairing the `−0.000` fix was about.
   */
  it('a zero adjustment is not called a credit', () => {
    const row = toActivityRow(adj(0), BRANCHES, 'en', en);
    expect(row.title).toBe(en.txKind.adjustment);
    expect(row.amount).toBe('0.000');
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


describe('the branch on a row is named in the reading language', () => {
  /*
    The row subtitle is `<when> · <branch>`, and the design writes it in Arabic:
    `أمس · أمارا السالمية` (AVO Wallet Home.dc.html:1580). Driven against lane B:
    before the fix this rendered `اليوم · ١١:٢٢ م · Salmiya`.
  */
  it('renders the Arabic branch name in ar', () => {
    const row = toActivityRow(tx({}), BRANCHES, 'ar', ar);
    expect(row.when).toContain('مدينة الكويت');
    expect(row.when).not.toContain('Kuwait City');
  });

  it('renders the Latin branch name in en', () => {
    const row = toActivityRow(tx({}), BRANCHES, 'en', en);
    expect(row.when).toContain('Kuwait City');
    expect(row.when).not.toContain('مدينة الكويت');
  });

  it('falls back to Latin in ar when the branch has no Arabic name', () => {
    const row = toActivityRow(tx({}), BRANCHES_NO_ARABIC, 'ar', ar);
    expect(row.when).toContain('Kuwait City');
    // The failure mode a missing fallback would produce is a dangling separator.
    expect(row.when).not.toMatch(/·\s*$/);
  });

  it('still omits the branch on a top-up, in both languages', () => {
    // A top-up has no branch a customer would recognise — unchanged by the fix.
    for (const [lang, copy] of [['en', en], ['ar', ar]] as const) {
      const row = toActivityRow(tx({ kind: 'topup', amountFils: 25000 }), BRANCHES, lang, copy);
      expect(row.when).not.toContain('Kuwait City');
      expect(row.when).not.toContain('مدينة الكويت');
    }
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A REDEEMED VOUCHER, AS THE API ACTUALLY SENDS IT.
 * ═══════════════════════════════════════════════════════════════════════════
 * Not a hand-written fixture. Captured verbatim from
 * `GET /members/me/transactions` on avo_lane_b (port 4710) after
 * `POST /members/me/vouchers/redeem` credited 5.000 KD:
 *
 *   {"id":"TX-VCH-2c74284c-511","memberId":"8842","branchId":"BR-KWC",
 *    "kind":"adjustment","amountFils":5000,"bonusFils":0,"method":"wallet",
 *    "status":"settled","reference":"AVO-VCH-2c74284c-511",
 *    "customAmount":false,"voidedAt":null,"reversedByTransactionId":null}
 *
 * `api/shop.test.ts`'s lesson, applied: "four contract drifts in this project
 * were a schema narrower than the wire", and a hand-written fixture is how the
 * top-up bonus double-count survived for months.
 */
describe('a redeemed voucher in the feed', () => {
  const voucher = tx({
    id: 'TX-VCH-2c74284c-511',
    branchId: 'BR-KWC',
    kind: 'adjustment',
    amountFils: 5000,
    bonusFils: 0,
    method: 'wallet',
    status: 'settled',
    reference: 'AVO-VCH-2c74284c-511',
  });

  it('is a credit, not a top-up, and says so', () => {
    const row = toActivityRow(voucher, BRANCHES, 'en', en);
    expect(row.title).toBe(en.txAdjustCredit);
    expect(row.positive).toBe(true);
    expect(row.amount).toBe('+5.000');
  });

  /**
   * THE BRIEF'S PREMISE, CHECKED RATHER THAN ASSUMED: it does NOT render
   * indistinguishably from a top-up she paid for. A paid top-up takes the
   * method suffix; this takes none, because `kind` differs before `method` is
   * ever consulted.
   */
  it('never wears a payment method the way a paid top-up does', () => {
    const row = toActivityRow(voucher, BRANCHES, 'en', en);
    const paid = toActivityRow(
      tx({ kind: 'topup', amountFils: 5000, method: 'knet' }),
      BRANCHES,
      'en',
      en,
    );
    expect(paid.title).toBe(`${en.txKind.topup} · ${en.txMethod.knet}`);
    expect(row.title).not.toBe(paid.title);
    expect(row.title).not.toContain(en.txMethod.wallet);
  });

  /**
   * ═════════════════════════════════════════════════════════════════════════
   * IT IS NOT CALLED A VOUCHER, AND THIS TEST EXISTS TO STOP SOMEBODY MAKING
   * IT ONE FROM THE REFERENCE PREFIX.
   * ═════════════════════════════════════════════════════════════════════════
   * Five code paths write `kind: 'adjustment'` and only two are AVO's. The
   * other three — a VOID REFUND written by scanner staff, a MERCHANT-FUNDED
   * happy-hour credit, and a seeded opening balance — are the same shape on the
   * wire. `AVO-VOID-…` is the row a customer is most likely to be arguing about
   * in a salon, and labelling it "Voucher from AVO" would be false.
   *
   * So all four positives get the SAME title, deliberately, and the day one of
   * them gets its own word it will be because the server sent a field saying
   * so — not because a client matched a prefix it does not own
   * (`serialiseMemberContact` refuses exactly that reasoning for `+990`).
   */
  it('is indistinguishable from the other four positive adjustments — on purpose', () => {
    const titles = ['AVO-VCH-x', 'AVO-ADJ-x', 'AVO-VOID-x', 'AVO-PRO-x', 'AVO-OPEN-8842'].map(
      (reference) =>
        toActivityRow(
          tx({ kind: 'adjustment', amountFils: 5000, reference }),
          BRANCHES,
          'en',
          en,
        ).title,
    );
    expect(new Set(titles).size).toBe(1);
    expect(titles[0]).toBe(en.txAdjustCredit);
  });

  /**
   * #1 AND THE HALF A SCREENSHOT MISSES. The visible string can be right by
   * accident; the spoken one is where a hand-rolled `/1000 .toFixed(3)` shows
   * itself. Both are asserted, in both languages, and the digits stay Western
   * in Arabic (#12).
   */
  it('announces dinars, in both languages, with Western digits', () => {
    for (const [lang, copy] of [['en', en], ['ar', ar]] as const) {
      const row = toActivityRow(voucher, BRANCHES, lang, copy);
      expect(row.amount).toBe('+5.000');
      expect(row.amountLabel).toContain('5.000');
      expect(row.amountLabel).not.toBe(row.amount);
    }
  });
});
