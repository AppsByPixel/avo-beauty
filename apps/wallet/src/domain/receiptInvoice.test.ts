/**
 * THE INVOICE SHE READS THE MOMENT SHE PAYS.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY THIS IS THE SAME BUILDER AND NOT A SECOND ONE
 *
 * `domain/receipt.ts` opens with a list of what the designed receipt draws and
 * the build cannot — Artist, Visit credit, Balance after, Original booking,
 * Pickup, Item — because none of them is a field on `Transaction`. That list is
 * still true OF A TRANSACTION. It is not true of the CHECKOUT RESPONSE, which is
 * a different object: `POST /orders` answers with `items[]` and
 * `balanceAfterFils` alongside the transaction, so at the instant of payment the
 * app holds two of the six rows the feed's receipt is documented as unable to
 * show.
 *
 * So the invoice is `buildReceipt` with a fifth argument, not a new function.
 * A second builder would be the defect this repository has paid for repeatedly —
 * one payload built in three places — and it would be worse here than usual,
 * because the third place already exists: `api/src/receipts/email/compose.ts`
 * itemises the same order for the emailed receipt. `receiptEmailParity.test.ts`
 * is what holds those two together across the process boundary; this file holds
 * the on-screen document to the design.
 * ═════════════════════════════════════════════════════════════════════════════
 */

import { describe, expect, it } from 'vitest';
import type { Transaction } from '@avo/types';
import { buildReceipt, type ReceiptDetail, type ReceiptRow } from './receipt';
import { en } from '../copy/en';
import { ar } from '../copy/ar';

const BRANCHES = [{ id: 'BR-KWC', name: 'Kuwait City', nameAr: 'مدينة الكويت' }];

/**
 * A shop transaction as `services/order.ts:445` writes it — `amountFils:
 * fils(-total)`, negative, which is why the sheet takes `abs` for the rows and
 * keeps the sign only on the headline.
 */
function shopTx(totalFils: number): Transaction {
  return {
    id: 'TX-7601442',
    memberId: '8842',
    branchId: 'BR-KWC',
    kind: 'shop',
    amountFils: -totalFils,
    bonusFils: 0,
    method: 'wallet',
    status: 'settled',
    reference: 'AVO-SH-7601442',
    createdAt: '2026-09-06T13:20:00.000Z',
    voidedAt: null,
    reversedByTransactionId: null,
  } as Transaction;
}

/** The response's own lines, field for field off `OrderLineSchema`. */
const DETAIL: ReceiptDetail = {
  items: [
    { name: 'Repair serum', qty: 1, lineTotalFils: 9500 },
    { name: 'Silk scrunchie', qty: 2, lineTotalFils: 5000 },
  ],
  balanceAfterFils: 48500,
};

const labels = (rows: ReceiptRow[]) => rows.map((r) => r.label);
const row = (rows: ReceiptRow[], label: string) => rows.find((r) => r.label === label);

describe('the invoice adds rows a Transaction alone cannot supply', () => {
  /**
   * WITHOUT the detail the sheet is exactly what it was. This is the assertion
   * that makes "one builder" safe rather than merely tidy: the feed's receipt
   * for the same transaction must not move because the invoice exists.
   */
  it('changes nothing when no detail is supplied', () => {
    const before = buildReceipt(shopTx(14500), BRANCHES, 'en', en);
    expect(labels(before.rows)).toEqual([en.txAmountRow, en.txPaidFrom, en.txBranch]);
  });

  /**
   * design/AVO Wallet Home.dc.html:1574 — `['Item', 'Repair serum × 1']`. The
   * name and the quantity, joined by U+00D7, are the design's own string; what
   * moves is which column it sits in, because a three-line order cannot render
   * three rows all labelled "Item" and the money has to land somewhere. So the
   * design's item string becomes the label and the SERVER'S line total becomes
   * the value — which is also exactly the designed receipt email's line block
   * (`AVO Receipt Email.html`: "Olaplex No.4 shampoo / 1 × 14.500 / 14.500").
   */
  it('itemises, one row per line, with the server’s own line total', () => {
    const rows = buildReceipt(shopTx(14500), BRANCHES, 'en', en, DETAIL).rows;
    expect(labels(rows).slice(0, 2)).toEqual(['Repair serum × 1', 'Silk scrunchie × 2']);
    expect(rows[0]?.value).toBe('9.500 KD');
    expect(rows[1]?.value).toBe('5.000 KD');
  });

  /**
   * THE LABEL AS WELL AS THE STRING. Three of this lane's mutations have gone
   * red on the announcement alone — a money row that reads "9.500" to a screen
   * reader says "nine point five hundred", not "dinars".
   */
  it('announces each line total as money, in both languages', () => {
    expect(row(buildReceipt(shopTx(14500), BRANCHES, 'en', en, DETAIL).rows, 'Repair serum × 1')?.valueLabel)
      .toBe('9.500 Kuwaiti dinars');
    expect(row(buildReceipt(shopTx(14500), BRANCHES, 'ar', ar, DETAIL).rows, 'Repair serum × ١')?.valueLabel)
      .toBe('9.500 دينار كويتي');
  });

  /**
   * design:1587 — `['المنتج', 'سيروم إصلاح × ١']`. The QUANTITY is Eastern in
   * Arabic because it is a count, which `copy.qtyValue` already decides for the
   * cart badge; the MONEY beside it stays Western, which is #12 and the design's
   * own Arabic receipt. Both scripts appear in one row on purpose.
   */
  it('writes the quantity in Eastern digits in Arabic and the money in Western', () => {
    const rows = buildReceipt(shopTx(14500), BRANCHES, 'ar', ar, DETAIL).rows;
    expect(labels(rows).slice(0, 2)).toEqual(['Repair serum × ١', 'Silk scrunchie × ٢']);
    expect(rows[0]?.value).toBe('9.500 د.ك');
  });

  /**
   * design:1574 `['Balance after', '48.500 KD']` and design:1587
   * `['الرصيد بعدها', '48.500 د.ك']`. Verbatim in both languages, which is why
   * this row costs nothing in `AR_GAPS`.
   *
   * IT IS THE SERVER'S FIGURE AND IS NEVER DERIVED. `domain/receipt.ts` refuses
   * to compute a running balance — "a support call and possibly a dispute" — and
   * that refusal survives this slice intact: the number comes off
   * `balanceAfterFils`, and with no detail there is no row at all.
   */
  it('states the balance after from the response, last, in both languages', () => {
    const enRows = buildReceipt(shopTx(14500), BRANCHES, 'en', en, DETAIL).rows;
    expect(enRows.at(-1)?.label).toBe('Balance after');
    expect(enRows.at(-1)?.value).toBe('48.500 KD');
    expect(enRows.at(-1)?.valueLabel).toBe('48.500 Kuwaiti dinars');

    const arRows = buildReceipt(shopTx(14500), BRANCHES, 'ar', ar, DETAIL).rows;
    expect(arRows.at(-1)?.label).toBe('الرصيد بعدها');
    expect(arRows.at(-1)?.value).toBe('48.500 د.ك');
  });

  /**
   * A ZERO BALANCE IS A FIGURE, NOT AN ABSENCE. She can spend her wallet to
   * exactly nothing, and `balanceAfterFils: 0` is the one value a truthiness
   * check would silently drop — leaving the invoice with no balance row on the
   * single occasion she most needs to see one.
   */
  it('renders a zero balance after rather than dropping the row', () => {
    const rows = buildReceipt(shopTx(14500), BRANCHES, 'en', en, {
      ...DETAIL,
      balanceAfterFils: 0,
    }).rows;
    expect(rows.at(-1)?.label).toBe('Balance after');
    expect(rows.at(-1)?.value).toBe('0.000 KD');
  });

  /**
   * The lines are ADDITIVE. "Amount" is the total the transaction moved and it
   * stays where it was, between the lines and the balance, so the document reads
   * lines → total → balance and reconciles on its face.
   */
  it('keeps the existing rows and their order, with the lines before them', () => {
    const rows = buildReceipt(shopTx(14500), BRANCHES, 'en', en, DETAIL);
    expect(labels(rows.rows)).toEqual([
      'Repair serum × 1',
      'Silk scrunchie × 2',
      en.txAmountRow,
      en.txPaidFrom,
      en.txBranch,
      'Balance after',
    ]);
  });

  /**
   * THE HEADLINE IS STILL THE TRANSACTION'S. The invoice does not re-total the
   * lines to produce it — that would be the client computing money the server
   * already sent, and the two would differ the first time a discount lands.
   */
  it('takes the headline from the transaction, not from the lines', () => {
    const receipt = buildReceipt(shopTx(14500), BRANCHES, 'en', en, DETAIL);
    expect(receipt.amount).toBe('−14.500');
    expect(receipt.title).toBe(en.txKind.shop);
  });
});

describe('what the invoice refuses to carry', () => {
  /**
   * `feeFils` is merchant-visible, customer-never (`db/schema/transaction.ts`),
   * and `transaction.note` carries four meanings (DECISIONS 107). Neither is on
   * `ReceiptDetail`, so neither can reach a row — asserted rather than left to
   * the type, because the type is the thing a future slice would widen.
   */
  it('has no field through which a fee or a note could arrive', () => {
    const detail: Record<string, unknown> = { ...DETAIL, feeFils: 150, note: 'she_is_lazy' };
    const rows = buildReceipt(shopTx(14500), BRANCHES, 'en', en, detail as ReceiptDetail).rows;
    const rendered = rows.map((r) => `${r.label} ${r.value}`).join(' | ');
    expect(rendered).not.toContain('0.150');
    expect(rendered).not.toContain('she_is_lazy');
  });
});
