/**
 * Turning a Transaction into an activity row.
 *
 * The signed amount is the only thing that decides direction — credit positive,
 * debit negative, per api-contract.md. The row never re-derives a sign from the
 * kind, because a `charge` that was voided arrives as a credit and the two must
 * not disagree.
 */

import {
  add,
  fils,
  formatFils,
  moneyAriaLabel,
  type Fils,
  type Language,
  type Transaction,
} from '@avo/types';
import type { Copy } from '../copy/types';

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

/**
 * The locale a date is formatted in.
 *
 * `ar-u-nu-arab` rather than plain `ar`: modern CLDR gives the bare `ar` locale
 * **Western** digits, so `Intl.DateTimeFormat('ar', …)` returns "12 يوليو" —
 * Arabic month, Latin numerals. The design writes `السبت ١٢ يوليو · ٤:٣٠ م`
 * (AVO Wallet Home.dc.html:1286), so the numbering system has to be asked for
 * explicitly. With it the output matches the design character for character,
 * including the ٤:٣٠ م meridiem.
 *
 * This is the date half of the digit rule: a date is not money, so it is
 * Eastern. Money formatted anywhere near it stays Western.
 */
export function dateLocale(lang: Language): string {
  return lang === 'ar' ? 'ar-u-nu-arab' : 'en-GB';
}

function branchLabel(tx: Transaction, branches: { id: string; name: string }[]): string | null {
  return branches.find((b) => b.id === tx.branchId)?.name ?? null;
}

function when(
  tx: Transaction,
  branches: { id: string; name: string }[],
  lang: Language,
  copy: Copy,
): string {
  const date = new Date(tx.createdAt);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  const yesterday = new Date(now.getTime() - 86_400_000).toDateString() === date.toDateString();
  const locale = dateLocale(lang);

  const time = new Intl.DateTimeFormat(locale, {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: KUWAIT_TIME_ZONE,
  }).format(date);
  const day = new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    timeZone: KUWAIT_TIME_ZONE,
  }).format(date);

  const head = sameDay
    ? `${copy.today} · ${time}`
    : yesterday
      ? `${copy.yesterday} · ${time}`
      : `${day} · ${time}`;
  const branch = branchLabel(tx, branches);
  // A top-up has no branch a customer would recognise; a charge always does.
  const withBranch = branch && tx.kind !== 'topup' ? `${head} · ${branch}` : head;

  // The status suffix used to be an inline ' · Pending' in the component, which
  // is the shape of string an Arabic build silently ships in English.
  if (tx.status === 'pending') return `${withBranch} · ${copy.rowPending}`;
  if (tx.status === 'failed' || tx.status === 'cancelled') {
    return `${withBranch} · ${copy.rowFailed}`;
  }
  return withBranch;
}

function title(tx: Transaction, copy: Copy): string {
  const kind = copy.txKind[tx.kind];
  if (tx.kind === 'topup' && tx.method) return `${kind} · ${copy.txMethod[tx.method]}`;
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
  lang: Language,
  copy: Copy,
): ActivityRow {
  // The amounts arrive as plain numbers off the wire; fils() re-brands them and
  // throws on a float, so a contract violation surfaces here rather than as a
  // wrong figure on a customer's screen.
  const amount: Fils = creditedAmount(tx);
  const positive = amount > 0;
  const abs = fils(Math.abs(amount));
  const spoken = moneyAriaLabel(abs, lang);
  return {
    id: tx.id,
    title: title(tx, copy),
    when: when(tx, branches, lang, copy),
    /*
      U+2212 MINUS, not a hyphen — it is the character the design sets.
      MONEY: Western digits in both languages. Not routed through the Eastern
      converter, deliberately — this is the exception the digit rule names.

      NO SIGN ON A ZERO, and this row was the HALF OF THAT FIX THAT WAS MISSED.
      d29fdb4 fixed `domain/receipt.ts` — the detail sheet — for a charge a held
      deposit covered entirely: `POST /charges` caps the applied deposit at the
      basket (`heldDeposit = min(gross, held)`), so a 0-fils charge is a real
      settled row, not an edge. `positive` is `amount > 0`, so zero fell to the
      negative branch and this LIST row still rendered `−0.000`, announced as
      "minus 0.000 Kuwaiti dinars" — the same false direction, on the same
      transaction, in the row above the sheet that had been corrected. Tapping it
      changed the answer.

      Only the sign goes. Nothing left her wallet, and a minus asserts a
      direction that did not occur; the figure is the server's and is not
      recomputed (#2).
    */
    amount: `${amount === 0 ? '' : positive ? '+' : '−'}${formatFils(abs)}`,
    amountLabel: amount === 0 ? spoken : positive ? copy.plus(spoken) : copy.minus(spoken),
    positive,
    pending: tx.status === 'pending',
    failed: tx.status === 'failed' || tx.status === 'cancelled',
  };
}

/**
 * "14 min ago" for the offline stamp.
 *
 * The raw number goes to the copy function and the copy function decides the
 * script — that is the invariant the whole i18n layer rests on. Converting here
 * would put digit policy in two places, and the second one always drifts.
 *
 * These four strings are currently an AR GAP (see copy/ar.ts), so Arabic renders
 * the English wording with Western digits. When the translation lands it will
 * convert with `toEasternDigits` like every other Arabic string, and the test in
 * i18n/digits.test.ts will start covering it automatically.
 */
export function relativeTime(fetchedAt: number, copy: Copy, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - fetchedAt) / 1000));
  if (seconds < 60) return copy.justNow;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return copy.minutesAgo(minutes);
  const hours = Math.round(minutes / 60);
  if (hours < 24) return copy.hoursAgo(hours);
  return copy.daysAgo(Math.round(hours / 24));
}

/** "14:02" — the clock time a stale banner names. Eastern in Arabic. */
export function clockTime(epochMs: number, lang: Language = 'en'): string {
  return new Intl.DateTimeFormat(dateLocale(lang), {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: KUWAIT_TIME_ZONE,
  }).format(new Date(epochMs));
}
