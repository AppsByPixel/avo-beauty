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
import { toActivityRow } from './activity';
import { branchName } from './names';
import { en } from '../copy/en';
import { ar } from '../copy/ar';

/** Both names — see the note on the same fixture in activity.test.ts. */
const BRANCHES = [{ id: 'BR-KWC', name: 'Kuwait City', nameAr: 'مدينة الكويت' }];

/** SAL-LUMIERE's branches are seeded with `name_ar` NULL deliberately. */
const BRANCHES_NO_ARABIC = [{ id: 'BR-KWC', name: 'Kuwait City', nameAr: null }];

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

/**
 * The top-up sheet, which had NO test at all — which is how a headline that
 * overstated every top-up by its bonus survived.
 *
 * The fixture is TX-2665307, captured field for field from
 * `GET /members/me/transactions` on avo_lane_b immediately after driving a
 * 10.000 KNET top-up on a Silver member whose balance went 24.500 → 35.500.
 * `amountFils` is 11000 — the CREDIT — because `services/topup.ts` writes
 * `amountFils: intent.creditFils`. `bonusFils` is the 1000 split beside it, not
 * something to add on.
 */
const TOPUP: Transaction = {
  id: 'TX-2665307',
  memberId: '8842',
  branchId: 'BR-KWC',
  kind: 'topup',
  amountFils: 11000,
  bonusFils: 1000,
  method: 'knet',
  status: 'settled',
  reference: 'AVO-TOP-FAR19T',
  createdAt: '2026-08-25T21:38:22.862Z',
  voidedAt: null,
  reversedByTransactionId: null,
} as Transaction;

describe('a top-up receipt', () => {
  it('headlines the credit the balance actually moved by, not credit plus bonus', () => {
    // 12.000 is the old answer and it is a number nothing holds: not the
    // intent, not the ledger row, not her balance.
    expect(buildReceipt(TOPUP, BRANCHES, 'en', en).amount).toBe('+11.000');
  });

  it('agrees with the activity row on the same transaction', () => {
    // The two used to agree while both were wrong, which is why neither looked
    // wrong beside the other. They agree here on the server's figure.
    expect(buildReceipt(TOPUP, BRANCHES, 'en', en).amount).toBe(
      toActivityRow(TOPUP, BRANCHES, 'en', en).amount,
    );
  });

  it('the three money rows sum: paid + bonus = landed', () => {
    const rows = buildReceipt(TOPUP, BRANCHES, 'en', en).rows;
    const value = (label: string) => rows.find((r) => r.label === label)?.value;
    expect(value(en.txYouPaid)).toBe('10.000 KD');
    expect(value(en.txTierBonus(null))).toBe('+1.000 KD');
    expect(value(en.txLanded)).toBe('11.000 KD');
  });

  it('never reports landed as more than the balance moved', () => {
    const rows = buildReceipt(TOPUP, BRANCHES, 'en', en).rows;
    expect(rows.find((r) => r.label === en.txLanded)?.value).not.toContain('12.000');
  });

  it('drops the bonus row entirely when there is none — stamps mode', () => {
    const noBonus = { ...TOPUP, amountFils: 10000, bonusFils: 0 } as Transaction;
    const receipt = buildReceipt(noBonus, BRANCHES, 'en', en);
    expect(receipt.amount).toBe('+10.000');
    expect(receipt.rows.some((r) => r.label === en.txTierBonus(null))).toBe(false);
    expect(receipt.rows.find((r) => r.label === en.txYouPaid)?.value).toBe('10.000 KD');
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

  /**
   * WAS `toBe(en.txKind.adjustment)` FOR BOTH DIRECTIONS. A positive adjustment
   * now says "Credit", because "Adjustment" is a ledger word for a row that is,
   * to her, money arriving — `domain/activity.ts § title` carries the whole
   * argument, including why it cannot say "Voucher".
   *
   * BOTH DIRECTIONS ARE ASSERTED, and the debit half is the one that matters:
   * a redeemed voucher, a console credit and a VOIDED CHARGE all land as
   * positive adjustments, but a console DEDUCTION lands negative, and calling
   * that a credit would be backwards.
   */
  it('a credit is titled Credit; a deduction is still an Adjustment', () => {
    expect(buildReceipt(adjustment(5000), BRANCHES, 'en', en).title).toBe(en.txAdjustCredit);
    expect(buildReceipt(adjustment(-5000), BRANCHES, 'en', en).title).toBe(en.txKind.adjustment);
    expect(buildReceipt(adjustment(5000), BRANCHES, 'en', en).title.trim()).not.toBe('');
  });

  /**
   * THE SHEET AND THE LIST ROW MUST ANSWER THE SAME QUESTION THE SAME WAY.
   *
   * Not a tidy-up: the −0.000 fix landed in `receipt.ts` and not in
   * `activity.ts`, so tapping a zero-fils charge changed the answer —
   * −0.000 in the feed, 0.000 in the sheet, on one transaction. This pins the
   * pair so a future edit to one of them fails here rather than in front of a
   * customer.
   */
  it('titles a credit exactly as the activity row does', () => {
    for (const amount of [5000, -5000, 0]) {
      expect(buildReceipt(adjustment(amount), BRANCHES, 'en', en).title).toBe(
        toActivityRow(adjustment(amount), BRANCHES, 'en', en).title,
      );
    }
  });

  /**
   * WHERE THE MONEY WENT — the row a credit adjustment did not have.
   *
   * `deposit_return` has said "Returned to · Wallet balance" all along, for
   * exactly this reason: money that arrived without her paying has to name its
   * destination. A redeemed voucher is the same event and said nothing. It is
   * also non-negotiable #5 as a FACT — it went to wallet balance — which closes
   * the cash and card-reversal readings without the sheet mentioning either.
   */
  it('a credit says where it landed; a deduction does not', () => {
    const credit = buildReceipt(adjustment(5000), BRANCHES, 'en', en).rows;
    expect(credit.map((r) => r.label)).toContain(en.txAddedTo);
    expect(credit.find((r) => r.label === en.txAddedTo)?.value).toBe(en.txWalletBalance);

    const debit = buildReceipt(adjustment(-5000), BRANCHES, 'en', en).rows;
    expect(debit.map((r) => r.label)).not.toContain(en.txAddedTo);
  });

  /** A zero adjustment has no direction, so it names no destination either. */
  it('a zero adjustment claims no destination', () => {
    const rows = buildReceipt(adjustment(0), BRANCHES, 'en', en).rows;
    expect(rows.map((r) => r.label)).not.toContain(en.txAddedTo);
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
      /*
        WAS `expect(values).not.toContain(en.txMethod.wallet)`, WHICH WENT RED ON
        A TRUE SENTENCE. `txMethod.wallet` and `txWalletBalance` are the same
        string in English — 'Wallet balance' — so a blanket ban on the VALUE
        also banned "Added to · Wallet balance", which claims no payment route
        and is the destination row `deposit_return` has always had.

        Scoped to the LABEL instead, which is what the test was ever about: the
        defect is a row that says money came FROM somewhere, and only a label can
        say that. `txAddedTo` is excluded by name rather than by accident.
      */
      for (const row of rows) {
        if (row.value === en.txMethod.wallet) expect(row.label).toBe(en.txAddedTo);
      }
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


describe('the receipt names the branch in the reading language', () => {
  /*
    design/AVO Wallet Home.dc.html:1582 writes the Arabic detail rows as
    `['الفرع', 'أمارا السالمية']`. Driven against lane B: before the fix this row
    read `الفرع · Salmiya`.
  */
  const branchRow = (
    // The structural shape, not `typeof BRANCHES` — that infers `nameAr: string`
    // and would reject the null fixture, which is the case worth testing.
    branches: { id: string; name: string; nameAr: string | null }[],
    lang: 'en' | 'ar',
    copy: typeof en | typeof ar,
  ) =>
    buildReceipt(charge(-6000), branches, lang, copy).rows.find((r) => r.label === copy.txBranch);

  it('renders the Arabic branch name in ar', () => {
    expect(branchRow(BRANCHES, 'ar', ar)?.value).toBe('مدينة الكويت');
  });

  it('renders the Latin branch name in en', () => {
    expect(branchRow(BRANCHES, 'en', en)?.value).toBe('Kuwait City');
  });

  it('falls back to Latin in ar when the branch has no Arabic name', () => {
    const row = branchRow(BRANCHES_NO_ARABIC, 'ar', ar);
    expect(row?.value).toBe('Kuwait City');
    expect(row?.value).not.toBe('');
  });

  it('agrees with the activity row on the same transaction, in ar', () => {
    // The pair that disagreed once before — d29fdb4 fixed the sheet and left the
    // list. Whatever the rule is, both surfaces must apply it.
    const tx = charge(-6000);
    expect(branchRow(BRANCHES, 'ar', ar)?.value).toBe(branchName(BRANCHES[0]!, 'ar'));
    expect(toActivityRow(tx, BRANCHES, 'ar', ar).when).toContain(branchName(BRANCHES[0]!, 'ar'));
  });
});
