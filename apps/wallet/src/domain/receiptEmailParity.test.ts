/**
 * THE INVOICE ON SCREEN AND THE RECEIPT IN HER INBOX DESCRIBE ONE PURCHASE.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY THIS FILE REACHES OUTSIDE apps/wallet — the same trade, and the same
 * disclaimer, as `topupPreviewParity.test.ts`.
 *
 * It imports the SERVER'S OWN `composeReceiptEmail`. Read-only, test-only,
 * nothing under `api/` is modified. If lane A moves that module this file
 * breaks, and that is the entire point: a receipt and an invoice that quietly
 * stopped saying the same thing is the failure it is paid for.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT CANNOT DIVERGE, AND IT IS NOT THIS TEST THAT PREVENTS IT
 *
 * The strongest guarantee here is structural and is worth stating before the
 * assertions, because it is what makes them narrow. `services/order.ts` builds
 * ONE `lines` array and ONE `balanceAfter`, then uses each TWICE — line 581
 * hands them to `queueReceipts` as the receipt payload, and line 690 returns
 * them in the response this app renders. There is no second computation on
 * either side of the boundary. The client does no arithmetic at all: it
 * formats fils it was handed.
 *
 * So the FIGURES cannot disagree. What can disagree is everything a human
 * chose:
 *
 *   · which facts each document shows
 *   · what each one calls them
 *   · how money is rendered
 *
 * That is what is pinned below.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT IS ALLOWED TO DIFFER, STATED SO A FUTURE READER DOES NOT "FIX" IT
 *
 *   LANGUAGE.  The invoice is EN and AR. The email is English only, and
 *              `compose.ts` explains why at length: `member` has no locale
 *              column, so there is nothing to select a language on, and there is
 *              no Arabic receipt email in the design bundle. That is a reported
 *              gap on the API's side, not drift on this one.
 *
 *   LAYOUT.    The email is plain text with a right-aligned amount column; the
 *              invoice is label/value rows in a sheet. The two designed
 *              documents are themselves laid out differently.
 *
 *   ROWS THE OTHER CANNOT HAVE.  The email carries the dispute paragraph, the
 *              wallet-credit disclosure and the "on behalf of" footer — legal
 *              copy that belongs in a durable document and that non-negotiable
 *              #10 keeps out of this app entirely. The invoice carries the
 *              branch and the payment method, which the email's payload does not
 *              carry.
 *
 *              These are genuinely on different sides of a process boundary: the
 *              email is composed from a `jsonb` payload frozen at checkout and
 *              read back possibly months later, the invoice from a response held
 *              for as long as a sheet is open.
 * ═════════════════════════════════════════════════════════════════════════════
 */

import { describe, expect, it } from 'vitest';
import type { Transaction } from '@avo/types';
// The server's own composer, not a copy of it. See the header.
import { composeReceiptEmail } from '../../../../api/src/receipts/email/compose';
import { buildReceipt, type ReceiptDetail } from './receipt';
import { en } from '../copy/en';
import { ar } from '../copy/ar';

/**
 * ONE ORDER, EXPRESSED TWICE — and the two expressions are built from the same
 * literals here for the same reason the server builds them from the same
 * variables: `services/order.ts:581` and `:690` read one `lines` and one
 * `balanceAfter`.
 */
const LINES = [
  { productId: 'PR-1', name: 'Repair serum', qty: 1, unitPriceFils: 9500, lineTotalFils: 9500 },
  { productId: 'PR-2', name: 'Silk scrunchie', qty: 2, unitPriceFils: 2500, lineTotalFils: 5000 },
];
const TOTAL_FILS = 14500;
const BALANCE_AFTER_FILS = 48500;

/** `services/order.ts` § 9 — the payload as it is queued, `amountFils` POSITIVE. */
const EMAIL = composeReceiptEmail({
  transactionId: 'AVO-SH-7601442',
  recipient: { name: 'Dana', email: 'dana@example.com', emailVerified: true },
  salon: { id: 'SAL-AMARA', name: 'Amara' },
  payload: {
    kind: 'shop',
    transactionId: 'TX-7601442',
    amountFils: TOTAL_FILS,
    items: LINES,
    balanceAfterFils: BALANCE_AFTER_FILS,
    fulfilment: 'pickup',
  },
});

/** `services/order.ts:445` writes the transaction row NEGATIVE. */
const TX: Transaction = {
  id: 'TX-7601442',
  memberId: '8842',
  branchId: 'BR-KWC',
  kind: 'shop',
  amountFils: -TOTAL_FILS,
  bonusFils: 0,
  method: 'wallet',
  status: 'settled',
  reference: 'AVO-SH-7601442',
  createdAt: '2026-09-06T13:20:00.000Z',
  voidedAt: null,
  reversedByTransactionId: null,
} as Transaction;

const DETAIL: ReceiptDetail = { items: LINES, balanceAfterFils: BALANCE_AFTER_FILS };

const INVOICE = buildReceipt(TX, [{ id: 'BR-KWC', name: 'Kuwait City', nameAr: null }], 'en', en, DETAIL);
const INVOICE_TEXT = INVOICE.rows.map((r) => `${r.label} ${r.value}`).join('\n');

describe('the two documents agree on every line', () => {
  it('names the same products, in the same order, in both', () => {
    for (const l of LINES) {
      expect(EMAIL.text).toContain(l.name);
      expect(INVOICE_TEXT).toContain(l.name);
    }
    expect(EMAIL.text.indexOf('Repair serum')).toBeLessThan(EMAIL.text.indexOf('Silk scrunchie'));
    expect(INVOICE_TEXT.indexOf('Repair serum')).toBeLessThan(
      INVOICE_TEXT.indexOf('Silk scrunchie'),
    );
  });

  /**
   * THE MONEY IS THE SAME STRING, not merely the same number. Both sides render
   * through `formatMoney(fils(n), 'en')` from `@avo/types`, which is the rule
   * CLAUDE.md states outright — "Import money helpers from `@avo/types`, never
   * reimplement them". A second formatter on either side is what makes "14.500
   * KD" and "14.5 KD" a support call, and it is exactly the kind of thing that
   * passes every typecheck.
   */
  it('renders every line total as the identical string', () => {
    for (const l of LINES) {
      const rendered = `${(l.lineTotalFils / 1000).toFixed(3)} KD`;
      expect(EMAIL.text).toContain(rendered);
      expect(INVOICE_TEXT).toContain(rendered);
    }
  });

  it('carries the quantity on both, so a multiplied total reconciles', () => {
    // The email's subline is "2 x 2.500"; the invoice's label is "… × 2".
    expect(EMAIL.text).toContain('2 x 2.500 KD');
    expect(INVOICE_TEXT).toContain('Silk scrunchie × 2');
  });

  /** The one figure #2 is about. It is the server's, and it is on both. */
  it('states the same balance after on both', () => {
    expect(EMAIL.text).toContain('48.500 KD');
    expect(INVOICE_TEXT).toContain('48.500 KD');
    expect(INVOICE.rows.at(-1)?.label).toBe(en.txBalanceAfter);
  });

  /**
   * Neither document may carry the processor's cut or the internal note. Driven
   * with both actually present in the payload, because the assertion that
   * matters is that a widened payload cannot leak them — not that a narrow
   * fixture happened to omit them.
   */
  it('keeps the fee and the note off both documents', () => {
    const leaky = composeReceiptEmail({
      transactionId: 'AVO-SH-7601442',
      recipient: { name: 'Dana', email: 'dana@example.com', emailVerified: true },
      salon: { id: 'SAL-AMARA', name: 'Amara' },
      payload: {
        kind: 'shop',
        transactionId: 'TX-7601442',
        amountFils: TOTAL_FILS,
        items: LINES,
        balanceAfterFils: BALANCE_AFTER_FILS,
        feeFils: 150,
        note: 'she_is_lazy',
      },
    });
    for (const doc of [leaky.text, INVOICE_TEXT]) {
      expect(doc).not.toContain('0.150');
      expect(doc).not.toContain('she_is_lazy');
    }
  });
});

/**
 * THE TOP-UP HALF, AND WHY IT IS HERE RATHER THAN GETTING AN INVOICE OF ITS OWN.
 *
 * `compose.ts` handles `kind: 'topup'` with three lines — Top-up, Bonus credit,
 * Credited to your wallet — and `buildReceipt` has had the same three rows for a
 * top-up `Transaction` since it was written: `txYouPaid`, `txTierBonus`,
 * `txLanded`. Two documents, already saying the same thing, and nothing pinned
 * them together.
 *
 * A top-up does NOT get the on-screen invoice, and the reason is structural.
 * `GET /topups/{id}` answers a `TopUpIntentPublic`: no `Transaction` and no
 * `balanceAfterFils`. The two facts that make the shop invoice possible are
 * simply not on that wire, so an "invoice" there could only be the intent's own
 * three figures — which its success screen already shows, with the balance it
 * gets from re-reading `GET /members/me` rather than from the intent. Adding a
 * receipt sheet on top would be a second document for one event on one screen:
 * the exact defect this slice exists to avoid, arrived at from the other side.
 *
 * So the top-up's parity is asserted where it already exists, on the feed's
 * receipt, rather than a document being built to hold it.
 */
describe('the top-up receipt and the top-up email agree without an invoice', () => {
  const TOPUP_EMAIL = composeReceiptEmail({
    transactionId: 'AVO-TU-88421',
    recipient: { name: 'Dana', email: 'dana@example.com', emailVerified: true },
    salon: { id: 'SAL-AMARA', name: 'Amara' },
    payload: {
      kind: 'topup',
      transactionId: 'TX-88421',
      // `services/topup.ts` writes the PAID amount here and the credit separately.
      amountFils: 25000,
      bonusFils: 2500,
      creditFils: 27500,
      balanceAfterFils: 52000,
    },
  });

  const TOPUP_TX: Transaction = {
    id: 'TX-88421',
    memberId: '8842',
    branchId: 'BR-KWC',
    kind: 'topup',
    // `amountFils` on the ROW is the credit — see `domain/receipt.ts`, which
    // carries the monument to the slice that read it as the paid amount.
    amountFils: 27500,
    bonusFils: 2500,
    method: 'knet',
    status: 'settled',
    reference: 'AVO-TU-88421',
    createdAt: '2026-09-06T13:20:00.000Z',
    voidedAt: null,
    reversedByTransactionId: null,
  } as Transaction;

  const sheet = buildReceipt(TOPUP_TX, [], 'en', en);
  const sheetText = sheet.rows.map((r) => `${r.label} ${r.value}`).join('\n');

  it('splits paid, bonus and credited identically on both', () => {
    for (const figure of ['25.000 KD', '2.500 KD', '27.500 KD']) {
      expect(TOPUP_EMAIL.text).toContain(figure);
      expect(sheetText).toContain(figure);
    }
  });

  /**
   * The order is the reconciliation: paid, then what the salon added, then what
   * landed. A document that listed them in another order would still contain the
   * right three numbers and would not add up on the page.
   */
  it('orders them paid -> bonus -> credited on both', () => {
    for (const doc of [TOPUP_EMAIL.text, sheetText]) {
      expect(doc.indexOf('25.000 KD')).toBeLessThan(doc.indexOf('2.500 KD'));
      expect(doc.indexOf('2.500 KD')).toBeLessThan(doc.indexOf('27.500 KD'));
    }
  });

  /**
   * `feeFils` is on `TopUpIntentSchema` and is stripped from the public shape by
   * `.omit({ feeFils: true })`. The design's own top-up receipt DRAWS a
   * "Processing fee 0.150 KD" row (design:1559) and `domain/receipt.ts` drops it
   * deliberately: api-contract.md § Commission, merchant-visible customer-never.
   * Both documents must keep refusing it.
   */
  it('keeps the processing fee off both, though the design draws it', () => {
    expect(TOPUP_EMAIL.text).not.toContain('0.150');
    expect(sheetText).not.toContain('0.150');
    expect(sheetText).not.toContain('Processing fee');
  });
});

describe('what the invoice shows that the email does not, and the reverse', () => {
  /**
   * NOT A DEFECT — a process boundary. Recorded as assertions rather than prose
   * so that closing either gap is a visible, deliberate edit rather than
   * something that drifts shut and is then assumed to have always been true.
   */
  it('has the email carrying legal copy the customer app must not hold (#10)', () => {
    expect(EMAIL.text).toContain('Refunds are returned as wallet credit.');
    expect(INVOICE_TEXT).not.toContain('Refunds are returned as wallet credit.');
  });

  it('has the invoice carrying the branch and the payment route, which the payload has not', () => {
    expect(INVOICE_TEXT).toContain(en.txBranch);
    expect(INVOICE_TEXT).toContain(en.txWalletBalance);
    expect(EMAIL.text).not.toContain('Kuwait City');
  });

  /**
   * The email is English-only and `compose.ts` says why — `member` has no locale
   * column. Pinned so the day a locale lands, this test fails and the Arabic
   * receipt is written rather than forgotten.
   */
  it('has no Arabic in the email while the invoice has a full Arabic face', () => {
    expect(/[؀-ۿ]/.test(EMAIL.text)).toBe(false);
    const arInvoice = buildReceipt(
      TX,
      [{ id: 'BR-KWC', name: 'Kuwait City', nameAr: 'مدينة الكويت' }],
      'ar',
      ar,
      DETAIL,
    );
    expect(/[؀-ۿ]/.test(arInvoice.rows.map((r) => r.label).join(''))).toBe(true);
  });
});
