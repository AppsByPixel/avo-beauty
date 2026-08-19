/**
 * A Transaction expanded into the receipt the detail sheet shows.
 *
 * WHAT IS AND IS NOT HERE — read this before adding a row.
 *
 * design/AVO Wallet Home.dc.html's detail sheet shows, across its four sample
 * transactions: Artist, Visit credit, Balance after, Original booking, Pickup,
 * Item, and a masked card number. **None of those are fields on
 * api-contract.md's Transaction**, which is exactly:
 *
 *   id · memberId · branchId · kind · amountFils · bonusFils · method · status
 *   · reference · createdAt
 *
 * They are not built, and they are not faked. A running balance in particular is
 * derivable — current balance minus everything newer — and it is left underived
 * on purpose: non-negotiable #2 puts the balance on the server, the transaction
 * list is paginated, and a "Balance after" that silently disagrees with the
 * ledger by one missing row is a support call and possibly a dispute.
 *
 * CONTRACT GAP (reported, not filled): Transaction needs `balanceAfterFils`, the
 * artist and the visit/stamp credit if the designed receipt is to be built. That
 * is a shared-package change and belongs on trunk.
 *
 * The one row the design shows that is deliberately dropped rather than missing
 * is "Processing fee 0.150 KD". That is the AVO commission. api-contract.md
 * § Commission: merchant-visible, customer-never.
 */

import {
  add,
  fils,
  formatFils,
  formatMoney,
  moneyAriaLabel,
  type Language,
  type Transaction,
} from '@avo/types';
import type { Copy } from '../copy/types';
import { dateLocale } from './activity';

export interface ReceiptRow {
  label: string;
  value: string;
  /** So a screen reader says "dinars" rather than "thousands". */
  valueLabel?: string;
  /** Money rows are set in the display face; text rows are not. */
  emphasis?: boolean;
}

export interface Receipt {
  title: string;
  /** "Wallet top-up", "Service", … — the line under the amount. */
  subtitle: string;
  /** The signed headline figure, already formatted. */
  amount: string;
  amountLabel: string;
  positive: boolean;
  /** The status pill. Carries its meaning as text, never as colour alone. */
  status: string;
  statusTone: 'good' | 'warn' | 'bad';
  rows: ReceiptRow[];
  reference: string;
}

const KUWAIT_TIME_ZONE = 'Asia/Kuwait';

function fullWhen(iso: string, lang: Language): string {
  return new Intl.DateTimeFormat(dateLocale(lang), {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: KUWAIT_TIME_ZONE,
  }).format(new Date(iso));
}

function statusTone(status: Transaction['status']): Receipt['statusTone'] {
  if (status === 'settled') return 'good';
  if (status === 'pending') return 'warn';
  return 'bad';
}

function money(amount: number, lang: Language): { value: string; valueLabel: string } {
  const f = fils(amount);
  return { value: formatMoney(f, lang), valueLabel: moneyAriaLabel(f, lang) };
}

export function buildReceipt(
  tx: Transaction,
  branches: { id: string; name: string }[],
  lang: Language,
  copy: Copy,
): Receipt {
  const branch = branches.find((b) => b.id === tx.branchId)?.name ?? null;
  const bonus = fils(tx.bonusFils);
  const paid = fils(tx.amountFils);
  // Same rule as the activity row: for a top-up the headline is what LANDED,
  // which is what the customer's balance moved by.
  const headline = tx.kind === 'topup' && bonus !== 0 ? add(paid, bonus) : paid;
  const positive = headline > 0;
  const abs = fils(Math.abs(headline));
  /**
   * A ZERO HEADLINE TAKES NO SIGN, AND THIS IS A REAL TRANSACTION, NOT AN EDGE.
   *
   * `POST /charges` applies a held deposit capped at the basket — `heldDeposit =
   * min(gross, held)` — so when the hold covers the whole visit `due` is 0 and the
   * row is written `amountFils: 0`. Driven on avo_lane_b: a 6.000 Manicure against
   * a 6.000 held deposit answered `amountFils: 0`, `depositAppliedFils: 6000`,
   * balance unchanged at 6500.
   *
   * `positive` is `headline > 0`, so a zero fell to the negative branch and this
   * sheet rendered `−0.000` — announced to a screen reader as "minus 0.000 Kuwaiti
   * dinars", in both languages. The minus asserts a direction that did not happen:
   * nothing left her wallet, and the deposit she had already paid covered the
   * visit.
   *
   * THE FIGURE IS NOT RECOMPUTED — trunk's call on this frame is "leave the figure,
   * fix the frame", and putting the 6.000 gross here would be the client inventing
   * a debit the server never made (#2). Only the sign goes, which needs no new copy
   * in either language and therefore adds nothing to AR_GAPS.
   *
   * ⚠️ WHAT THIS DOES NOT FIX, AND IT NEEDS TRUNK: the sheet still cannot say WHY
   * it was zero. `depositAppliedFils` is on the CHARGE RESPONSE, not on the
   * `Transaction` entity this is built from, so the receipt reads "Service ·
   * 0.000 · Amount 0.000" with nothing reconciling it. The scanner solved the same
   * frame by showing its applied row, but it has the charge response in hand and
   * this does not. Naming the gap rather than deriving a figure from two numbers
   * the entity does not carry.
   */
  const signed = headline === 0 ? '' : positive ? '+' : '−';

  const rows: ReceiptRow[] = [];

  if (tx.kind === 'topup') {
    if (tx.method) rows.push({ label: copy.txPaidWith, value: copy.txMethod[tx.method] });
    rows.push({ label: copy.txYouPaid, ...money(paid, lang), emphasis: true });
    // Non-negotiable: the bonus is the server's number. It is read off the
    // transaction, never recomputed from a tier percentage — and in stamps mode
    // it is 0 and the row does not exist at all.
    if (bonus > 0) {
      const m = money(bonus, lang);
      rows.push({
        // null: a Transaction does not record which tier funded the bonus, so
        // the neutral wording is used rather than the member's current tier.
        label: copy.txTierBonus(null),
        value: `+${m.value}`,
        valueLabel: copy.plus(m.valueLabel),
        emphasis: true,
      });
    }
    rows.push({ label: copy.txLanded, ...money(add(paid, bonus), lang), emphasis: true });
    rows.push({ label: copy.txBranch, value: branch ?? copy.txBranchOnline });
  } else {
    rows.push({ label: copy.txAmountRow, ...money(abs, lang), emphasis: true });
    if (tx.kind === 'deposit_return') {
      rows.push({ label: copy.txReturnedTo, value: copy.txWalletBalance });
    } else if (tx.method) {
      rows.push({ label: copy.txPaidFrom, value: copy.txMethod[tx.method] });
    }
    if (branch) rows.push({ label: copy.txBranch, value: branch });
  }

  const spoken = moneyAriaLabel(abs, lang);

  return {
    title:
      tx.kind === 'topup' && tx.method
        ? `${copy.txKind.topup} · ${copy.txMethod[tx.method]}`
        : copy.txKind[tx.kind],
    subtitle: fullWhen(tx.createdAt, lang),
    // U+2212 MINUS, not a hyphen — the character the design sets.
    // MONEY: Western digits in both languages, per non-negotiable #12 and the
    // design's own Arabic receipt (AVO Wallet Home.dc.html:1579 renders
    // '25.000 د.ك' with Latin numerals inside an otherwise Eastern-digit sheet).
    amount: `${signed}${formatFils(abs)}`,
    // The bare spoken amount on a zero — `copy.minus(spoken)` would say "minus
    // 0.000", which is the same false direction the glyph asserted.
    amountLabel: headline === 0 ? spoken : positive ? copy.plus(spoken) : copy.minus(spoken),
    positive,
    status: copy.txStatus[tx.status],
    statusTone: statusTone(tx.status),
    rows,
    reference: tx.reference,
  };
}
