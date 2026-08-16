/**
 * Turning a Transaction into an activity row.
 *
 * The signed amount is the only thing that decides direction — credit positive,
 * debit negative, per api-contract.md. The row never re-derives a sign from the
 * kind, because a `charge` that was voided arrives as a credit and the two must
 * not disagree.
 */

import { add, fils, formatFils, moneyAriaLabel, type Fils, type Transaction } from '@avo/types';
import { en } from '../copy/en';

export interface ActivityRow {
  id: string;
  title: string;
  when: string;
  /** "+27.500" / "−12.000" — 3 decimals, Western digits, both languages. */
  amount: string;
  /** So a screen reader says "dinars", not "thousands". interaction-spec.md §2. */
  amountLabel: string;
  positive: boolean;
  pending: boolean;
  failed: boolean;
}

const KUWAIT_TIME_ZONE = 'Asia/Kuwait';

function branchLabel(tx: Transaction, branches: { id: string; name: string }[]): string | null {
  return branches.find((b) => b.id === tx.branchId)?.name ?? null;
}

function when(tx: Transaction, branches: { id: string; name: string }[]): string {
  const date = new Date(tx.createdAt);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  const yesterday = new Date(now.getTime() - 86_400_000).toDateString() === date.toDateString();

  const time = new Intl.DateTimeFormat('en-GB', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: KUWAIT_TIME_ZONE,
  }).format(date);
  const day = new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    timeZone: KUWAIT_TIME_ZONE,
  }).format(date);

  const head = sameDay ? `Today · ${time}` : yesterday ? `Yesterday · ${time}` : `${day} · ${time}`;
  const branch = branchLabel(tx, branches);
  // A top-up has no branch a customer would recognise; a charge always does.
  return branch && tx.kind !== 'topup' ? `${head} · ${branch}` : head;
}

function title(tx: Transaction): string {
  const kind = en.txKind[tx.kind];
  if (tx.kind === 'topup' && tx.method) return `${kind} · ${en.txMethod[tx.method]}`;
  return kind;
}

/**
 * What the row's figure is.
 *
 * For everything except a top-up it is `amountFils`, signed. For a top-up the
 * design shows what LANDED in the wallet, not what was paid to the gateway:
 * AVO Wallet Home.dc.html renders "Top-up · KNET  +27.500" for a top-up whose
 * detail rows read "You paid 25.000 / Silver bonus +2.500 / Landed in wallet
 * 27.500". The fixtures agree — 25000 + 2500 and 10000 + 1000 — so
 * `amountFils` is what the customer paid and the credit is amount + bonus.
 *
 * CONTRACT AMBIGUITY (reported, not resolved): api-contract.md § Transaction
 * describes `bonusFils` as "tier bonus portion of a topup", which reads as
 * though the bonus is already inside `amountFils`. Read that way this row would
 * show 25.000, and a customer's activity total would not reconcile with her
 * balance. The TopUpIntent definition three lines below — "creditFils =
 * amountFils + bonusFils" — and the design copy both point the other way, so
 * that is what is implemented. The wording should be tightened either way; this
 * is a display decision only and moves no money.
 */
function creditedAmount(tx: Transaction): Fils {
  const amount = fils(tx.amountFils);
  if (tx.kind !== 'topup' || tx.bonusFils === 0) return amount;
  return add(amount, fils(tx.bonusFils));
}

export function toActivityRow(
  tx: Transaction,
  branches: { id: string; name: string }[],
): ActivityRow {
  // The amounts arrive as plain numbers off the wire; fils() re-brands them and
  // throws on a float, so a contract violation surfaces here rather than as a
  // wrong figure on a customer's screen.
  const amount: Fils = creditedAmount(tx);
  const positive = amount > 0;
  return {
    id: tx.id,
    title: title(tx),
    when: when(tx, branches),
    // U+2212 MINUS, not a hyphen — it is the character the design sets.
    amount: `${positive ? '+' : '−'}${formatFils(fils(Math.abs(amount)))}`,
    amountLabel: `${positive ? 'plus' : 'minus'} ${moneyAriaLabel(fils(Math.abs(amount)))}`,
    positive,
    pending: tx.status === 'pending',
    failed: tx.status === 'failed' || tx.status === 'cancelled',
  };
}

/** "14 min ago" for the offline stamp. */
export function relativeTime(fetchedAt: number, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - fetchedAt) / 1000));
  if (seconds < 60) return en.justNow;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return en.minutesAgo(minutes);
  const hours = Math.round(minutes / 60);
  if (hours < 24) return en.hoursAgo(hours);
  return en.daysAgo(Math.round(hours / 24));
}

/** "14:02" — the clock time a stale banner names. */
export function clockTime(epochMs: number): string {
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: KUWAIT_TIME_ZONE,
  }).format(new Date(epochMs));
}
