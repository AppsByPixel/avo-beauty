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
import { en } from '../copy/en';

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

function fullWhen(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', {
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
  lang: Language = 'en',
): Receipt {
  const branch = branches.find((b) => b.id === tx.branchId)?.name ?? null;
  const bonus = fils(tx.bonusFils);
  const paid = fils(tx.amountFils);
  // Same rule as the activity row: for a top-up the headline is what LANDED,
  // which is what the customer's balance moved by.
  const headline = tx.kind === 'topup' && bonus !== 0 ? add(paid, bonus) : paid;
  const positive = headline > 0;
  const abs = fils(Math.abs(headline));

  const rows: ReceiptRow[] = [];

  if (tx.kind === 'topup') {
    if (tx.method) rows.push({ label: en.txPaidWith, value: en.txMethod[tx.method] });
    rows.push({ label: en.youPay, ...money(paid, lang), emphasis: true });
    // Non-negotiable: the bonus is the server's number. It is read off the
    // transaction, never recomputed from a tier percentage — and in stamps mode
    // it is 0 and the row does not exist at all.
    if (bonus > 0) {
      const m = money(bonus, lang);
      rows.push({
        label: en.txTierBonus,
        value: `+${m.value}`,
        valueLabel: `plus ${m.valueLabel}`,
        emphasis: true,
      });
    }
    rows.push({ label: en.txLanded, ...money(add(paid, bonus), lang), emphasis: true });
    rows.push({ label: en.txBranch, value: branch ?? en.txBranchOnline });
  } else {
    rows.push({ label: en.txAmountRow, ...money(abs, lang), emphasis: true });
    if (tx.kind === 'deposit_return') {
      rows.push({ label: en.txReturnedTo, value: en.txWalletBalance });
    } else if (tx.method) {
      rows.push({ label: en.txPaidFrom, value: en.txMethod[tx.method] });
    }
    if (branch) rows.push({ label: en.txBranch, value: branch });
  }

  return {
    title:
      tx.kind === 'topup' && tx.method
        ? `${en.txKind.topup} · ${en.txMethod[tx.method]}`
        : en.txKind[tx.kind],
    subtitle: fullWhen(tx.createdAt),
    // U+2212 MINUS, not a hyphen — the character the design sets.
    amount: `${positive ? '+' : '−'}${formatFils(abs)}`,
    amountLabel: `${positive ? 'plus' : 'minus'} ${moneyAriaLabel(abs, lang)}`,
    positive,
    status: en.txStatus[tx.status],
    statusTone: statusTone(tx.status),
    rows,
    reference: tx.reference,
  };
}
