/**
 * Turning a Transaction into an activity row.
 *
 * The signed amount is the only thing that decides direction — credit positive,
 * debit negative, per api-contract.md. The row never re-derives a sign from the
 * kind, because a `charge` that was voided arrives as a credit and the two must
 * not disagree.
 */

import {
  fils,
  formatFils,
  moneyAriaLabel,
  type Fils,
  type Language,
  type Transaction,
} from '@avo/types';
import type { Copy } from '../copy/types';
import { branchName, type Named } from './names';

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

/**
 * Structural rather than `Branch`, so a caller holding a narrowed shape can pass
 * it. `nameAr` is OPTIONAL here and that is the hazard this comment exists for:
 * a fixture that omits it type-checks, which is precisely how `activity.test.ts`
 * asserted Arabic rows for months against `[{ id: 'BR-KWC', name: 'Kuwait City' }]`
 * and could not have caught a site ignoring the field. Fixtures in this module's
 * spec carry `nameAr`.
 */
type BranchLike = Named & { id: string };

function branchLabel(tx: Transaction, branches: BranchLike[], lang: Language): string | null {
  const branch = branches.find((b) => b.id === tx.branchId);
  return branch ? branchName(branch, lang) : null;
}

function when(
  tx: Transaction,
  branches: BranchLike[],
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
  const branch = branchLabel(tx, branches, lang);
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
 * What the row's figure is: `amountFils`, signed, for every kind including a
 * top-up.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THIS FUNCTION USED TO ADD `bonusFils` TO A TOP-UP AND IT DOUBLE-COUNTED THE
 * BONUS. Driven on a simulator against the real API: a 10.000 top-up on Silver
 * moved the balance by 11.000, and the activity row underneath said +12.000.
 *
 * The old code was reasoning from the design's "+27.500" and from
 * `creditFils = amountFils + bonusFils` on the **intent** — where that identity
 * is true — and carrying it onto the **transaction**, where it is not. It said
 * so itself, filed as a "CONTRACT AMBIGUITY (reported, not resolved)". The
 * running API resolves it, in its own words at `services/topup.ts`:
 *
 *     // Signed, credit positive: what actually landed, both bonuses included.
 *     amountFils: intent.creditFils,
 *
 * So a top-up transaction's `amountFils` IS the credit, `bonusFils` is the tier
 * split carried alongside it for reconciliation, and adding them produces a
 * number that exists nowhere — not on the intent, not in the ledger, not in her
 * balance. Captured from `GET /members/me/transactions` on avo_lane_b:
 * `{"kind":"topup","amountFils":11000,"bonusFils":1000}` for the 10.000 payment
 * that took 24.500 to 35.500.
 *
 * The design is still satisfied. It asks the row to show what LANDED, and what
 * landed is now what the server sent rather than what the client recomputed —
 * which is the same rule as non-negotiable #2 one level down.
 *
 * The fixture that pinned the old behaviour was hand-written. A real one would
 * have caught this on the day, which is the lesson `api/shop.test.ts` already
 * carries: "four contract drifts in this project were a schema narrower than
 * the wire", and this was a fifth wearing arithmetic instead.
 * ═════════════════════════════════════════════════════════════════════════════
 */
function creditedAmount(tx: Transaction): Fils {
  return fils(tx.amountFils);
}

export function toActivityRow(
  tx: Transaction,
  branches: BranchLike[],
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

// ════════════════════════════════════════════════════ four, then the rest ══

/**
 * How many activity rows the feed shows before it asks.
 *
 * FOUR, and the design agrees with the number without specifying the control:
 * `design/AVO Wallet Home.dc.html:328` sizes the list's own placeholder at
 * `hint-placeholder-count="4"`, which is the designer's idea of how tall that
 * card sits on the home screen. The bundle draws no disclosure — the prototype's
 * list is however long its fixture is — so the CONTROL is new and its label is
 * an AR GAP. See `copy/en.ts § activityShowMore`.
 */
export const ACTIVITY_VISIBLE = 4;

export interface ActivityDisclosure<T> {
  /** The rows to render. */
  visible: T[];
  /**
   * How many rows the control would reveal. ZERO MEANS NO CONTROL — which is
   * what makes the two ends of this rule one branch rather than two: a
   * three-row account and an already-expanded twelve-row account both report 0
   * and both draw nothing.
   */
  hidden: number;
}

/**
 * Four rows, then a control that reveals the rest.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * IT DISCLOSES ONCE AND DOES NOT RE-COLLAPSE
 * ═══════════════════════════════════════════════════════════════════════════
 * `hidden` is 0 after expanding, so the control withdraws itself. That is not
 * an omission of a "show less": the bundle has no such string in either
 * language, and inventing a second one to undo the first is a worse trade than
 * a list that stays open for as long as she is on the screen. The feed is
 * remounted on every return to Home, so it opens collapsed again.
 *
 * THE BOUNDARY IS `>` AND NOT `>=`, and it is the whole near-empty case: at
 * exactly four there is nothing beneath the fourth row, so a control there
 * would reveal nothing and read as broken. `activityDisclosure.test.ts` asserts
 * both sides of it — three, four and five — because an off-by-one here is
 * invisible on any account that has been used.
 */
export function discloseActivity<T>(
  rows: readonly T[],
  expanded: boolean,
): ActivityDisclosure<T> {
  if (expanded || rows.length <= ACTIVITY_VISIBLE) return { visible: [...rows], hidden: 0 };
  return { visible: rows.slice(0, ACTIVITY_VISIBLE), hidden: rows.length - ACTIVITY_VISIBLE };
}
