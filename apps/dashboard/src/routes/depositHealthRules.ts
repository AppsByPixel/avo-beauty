import type { DepositRow, DepositState } from '../api/deposits.js';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * MERCHANT → APPOINTMENTS → DEPOSITS. THE RULES AND THE COPY.
 * ═══════════════════════════════════════════════════════════════════════════
 * NEW SCOPE, AND THERE IS NO DESIGNED SCREEN FOR IT. Said plainly so a later
 * reader does not go looking for an artboard: "deposit" appears in
 * `design/AVO Merchant Dashboard.dc.html` as a COLUMN on the appointments table
 * and as a Settings panel, and nowhere as a view. It is not in
 * `design/README.md` § Known gaps either, so no prior decision is being
 * overridden — this is Aftab extending his own design, verbatim and last on his
 * numbered list:
 *
 *   "what if they dont have enough payment (sometimes they dont have money but
 *    lock the booking and they dont come) deposit health option for merchants"
 *
 * Same disclosure `appointmentsWeekRules.ts` makes about the week grid and
 * `salesTrendRules.ts` makes about the chart. The copy below is therefore THIS
 * LANE'S WORDS, not the product's, and is deliberately plain so that written
 * copy replaces it cleanly when it arrives. Reported to trunk.
 *
 * The RENDERING lives in `DepositHealth.tsx`. Everything here is a pure function
 * or a constant, so every rule is assertable without a query client or a clock.
 */

/* ======================================================== the three framings */

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE THREE STATES GET THREE FRAMINGS, AND THAT DISTINCTION *IS* THE FEATURE
 * ═══════════════════════════════════════════════════════════════════════════
 * `api/src/services/depositHealth.ts` spends its header on why "past its slot
 * and still held" is three different facts wearing one shape. The client half of
 * that decision is this table, and the rule it enforces is that the three never
 * share a sentence:
 *
 *   awaiting_arrival  A CUSTOMER. Her slot started, the salon's own grace window
 *                     has not expired. This is the one the client is describing
 *                     and the only one of the three that is about a customer at
 *                     all.
 *
 *   return_overdue    OURS. She is owed her deposit back and has not got it.
 *                     `services/noShowWorker.ts` selects on exactly this
 *                     predicate, so a row here is a row the job was supposed to
 *                     have taken and has not. It is an operational signal about
 *                     AVO and it is EMPHATICALLY NOT evidence about her — she
 *                     may have cancelled in a way that failed, or the worker may
 *                     be down for everybody.
 *
 *   unclosed          THE SALON'S OWN BOOK-KEEPING. Past the deadline with no
 *                     money behind it: a walk-in or a hand-written appointment
 *                     nobody closed off. Nothing is owed and nothing is late.
 *
 * A SCREEN THAT LUMPED THESE INTO ONE "PROBLEM APPOINTMENTS" LIST WOULD TELL A
 * MERCHANT HER CUSTOMERS ARE UNRELIABLE WHEN IN FACT OUR JOB IS STUCK. That is
 * the defect this table exists to make unrepresentable: a component reads its
 * heading and its body from here by state, so there is no arm that can fall
 * through to somebody else's sentence.
 *
 * `return_overdue` IN PARTICULAR SAYS NOTHING THE CUSTOMER DID. Read its `body`
 * with that in mind — every clause is about AVO's side of the transaction, and
 * the sentence that would be easiest to write ("these customers did not turn
 * up") is exactly the claim the data does not support.
 */
export interface DepositFraming {
  /** The section heading. */
  title: string;
  /** Whose problem this is, and what it means. One short paragraph. */
  body: string;
  /**
   * The sr-only <caption> for the section's table — what the rows below are,
   * stated once for a screen reader that meets the table without the heading.
   */
  caption: string;
  /** The column head over the elapsed-time figure. Different per state on purpose. */
  elapsedHead: string;
}

export const DEPOSIT_FRAMING: Record<DepositState, DepositFraming> = {
  /*
   * "Still waiting" and not "Late" — she is inside a window the SALON chose, so
   * nothing has gone wrong yet and the heading must not say it has. The strip
   * above this view already states the window's length; it is not repeated here,
   * because a number stated twice on one screen is a number that can disagree
   * with itself.
   */
  awaiting_arrival: {
    title: 'Still within the grace window',
    body:
      'Her slot has started and nothing has settled it yet — she may be running late, or already in the chair and not charged. Her deposit is still held, and nothing settles until the time the rule above states.',
    caption: 'Bookings whose slot has started and whose grace window has not run out.',
    elapsedHead: 'Since slot',
  },
  /*
   * THE ONE THAT MUST NOT READ AS ANYTHING SHE DID. "We owe", "ours to return",
   * "waiting for money that is already hers" — the subject of every clause is
   * AVO. The customer appears only as the person owed.
   *
   * IT ALSO NAMES WHAT TO DO, because a merchant cannot fix this one herself:
   * the return runs server-side and she has no control that triggers it. A
   * section that described an AVO fault and offered her nothing would read as a
   * reprimand.
   */
  /*
   * DIRECTION-NEUTRAL SINCE MIGRATION 0066. Under a salon policy a missed slot
   * can KEEP the deposit, so "We owe this money back" and "money that is already
   * hers" were false for every `keep` booking in this list. The deposit-health
   * rows do not carry the booking's policy, so the copy names the settle — back
   * to her wallet or to the salon, as the booking's policy says — and not a
   * direction. Still ours: settling runs on AVO's side.
   */
  return_overdue: {
    title: 'Waiting on us to settle',
    body:
      "The settle time has passed and the deposit is still held. Settling it runs on our side, not hers — each row goes back to her wallet or stays with the salon, as that booking's policy says. If this list is not empty, tell AVO support; there is nothing for you to do here.",
    caption: 'Deposits past their settle time that AVO has not yet settled.',
    elapsedHead: 'Overdue by',
  },
  /*
   * NO MONEY IN THIS SECTION AT ALL — not a column, not a figure, not a zero.
   * `booking_deposit_matches_hold` makes "no hold" and "zero deposit" the same
   * fact, so the API deliberately serves no `fils` here; a rendered `0.000 KD`
   * would be a money figure whose only possible use is to mislead.
   */
  unclosed: {
    title: 'Never closed off',
    body:
      'These slots passed their deadline with no deposit behind them — walk-ins and appointments written in by hand. No money is held and nobody is owed anything; the booking was simply never marked complete or cancelled.',
    caption: 'Bookings past their deadline with no deposit behind them.',
    elapsedHead: 'Past due by',
  },
};

/**
 * The order the sections are drawn in, and it is not the order of the wire's
 * keys by accident.
 *
 * `return_overdue` IS FIRST BECAUSE IT IS THE ONLY ONE THAT IS OURS. A merchant
 * scanning this screen should meet AVO's failure before she meets anything that
 * could be read as her customers' — putting the customer-shaped section at the
 * top would set the frame for everything under it.
 *
 * Then `awaiting_arrival`, which is live and actionable this hour, then
 * `unclosed`, which is book-keeping and has no clock on it.
 */
export const DEPOSIT_SECTION_ORDER: readonly DepositState[] = [
  'return_overdue',
  'awaiting_arrival',
  'unclosed',
];

/* ============================================================== the grouping */

export interface DepositGroup {
  state: DepositState;
  /**
   * THE SERVER'S COUNT, WHICH IS NOT `rows.length`. The row list is capped at
   * 200 and the counts are exact and unbounded, so a section can legitimately
   * show fewer rows than it declares. `DepositHealth.tsx` renders the
   * difference rather than hiding it.
   */
  bookings: number;
  /** The rows of this state that made it inside the cap, IN THE ORDER SERVED. */
  rows: DepositRow[];
}

/**
 * Partition the queue by state, preserving the served order inside each part.
 *
 * ===========================================================================
 * GROUPING IS NOT SORTING, AND THE DIFFERENCE IS THE WHOLE POINT
 * ===========================================================================
 * `rows[]` arrives `starts_at ASC, id ASC` — a queue, deliberately: "the oldest
 * thing that never resolved is the thing to deal with first". The endpoint takes
 * no `?sort=` and this screen offers no reordering control, because a list a
 * merchant can re-rank by how much a customer owes, or by how long she has been
 * a problem, is a leaderboard of women to distrust however it is labelled.
 *
 * What this function does is not a re-rank. `filter` is stable, so every group
 * comes out in exactly the relative order the server sent — row 4 is still after
 * row 2 wherever both landed. The partition exists because the three states need
 * three framings, which is the requirement one flat list cannot meet; it changes
 * which SENTENCE sits above a row and never which row comes first.
 *
 * `depositHealthRules.test.ts` pins both halves: the subsequence property, and
 * that nothing here consults `depositFils`, `memberName` or any other field of
 * the person.
 */
export function groupByState(
  rows: readonly DepositRow[],
  counts: Record<DepositState, number>,
): DepositGroup[] {
  return DEPOSIT_SECTION_ORDER.map((state) => ({
    state,
    bookings: counts[state],
    rows: rows.filter((row) => row.state === state),
  }));
}

/* ============================================================== the elapsed */

const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 1440;

/**
 * Whole minutes from the server, rendered as a duration a merchant reads.
 *
 * THE SERVER SENDS A NUMBER AND NOT A SENTENCE, and says why: "2h 15m" bakes one
 * language into a field two languages read. The merchant surfaces are
 * English-only (design/README.md § Known gaps 1), so the composition happens
 * here and stays here.
 *
 * FLOORED ON BOTH SIDES OF THE WIRE. The server floors minutes since the
 * instant — "at least this long" is the true statement — and this floors hours
 * and days out of those minutes for the same reason. Nothing is rounded up, so
 * no figure on this screen ever claims more time has passed than has.
 *
 * ZERO IS "under a minute" RATHER THAN "0m". A booking 29 seconds past its slot
 * is genuinely overdue and belongs on the queue; printing `0m` beside it reads
 * as a missing value, which is the one thing it is not.
 */
export function formatElapsed(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes < 1) return 'under a minute';

  if (minutes < MINUTES_PER_HOUR) return `${Math.floor(minutes)}m`;

  if (minutes < MINUTES_PER_DAY) {
    const h = Math.floor(minutes / MINUTES_PER_HOUR);
    const m = Math.floor(minutes % MINUTES_PER_HOUR);
    return m === 0 ? `${h}h` : `${h}h ${m}m`;
  }

  const d = Math.floor(minutes / MINUTES_PER_DAY);
  const h = Math.floor((minutes % MINUTES_PER_DAY) / MINUTES_PER_HOUR);
  return h === 0 ? `${d}d` : `${d}d ${h}h`;
}

/* ================================================================= the name */

/**
 * WHO THE ROW IS ABOUT — a member, a walk-in, or a member whose account is gone.
 *
 * `booking_identity_exactly_one` guarantees exactly one of `memberId` and
 * `guestName` is non-null, so this is a total function over a well-formed row
 * rather than a chain of guesses. The `'unknown'` arm exists for the row the
 * constraint says cannot arrive, and it renders as a booking reference rather
 * than as a blank cell or an invented name.
 *
 * ERASURE IS THE FLAG AND NEVER THE PREFIX. `services/erasure.ts` mints `+990`
 * plus twelve digits for a phone it cannot null at rest — an UNASSIGNED country
 * code, so the number is a tombstone by construction — and
 * `serialiseMemberContact` is what keeps those digits off the wire. This lane has
 * shipped the second failure twice (DECISIONS #100's `tel:` link and the
 * wallet's `wa.me` button), so the contact details below are read off
 * `memberErased`, and no code anywhere in this view inspects a number's prefix.
 */
export interface DepositParty {
  kind: 'member' | 'guest' | 'erased' | 'unknown';
  name: string;
  /** Null when there is nobody to call, or when the account has been erased. */
  phone: string | null;
}

export function partyFor(row: DepositRow): DepositParty {
  if (row.memberId !== null) {
    if (row.memberErased) {
      return { kind: 'erased', name: row.memberName ?? 'Deleted account', phone: null };
    }
    return { kind: 'member', name: row.memberName ?? 'Member', phone: row.memberPhone };
  }
  if (row.guestName !== null) {
    return { kind: 'guest', name: row.guestName, phone: row.guestPhone };
  }
  return { kind: 'unknown', name: row.bookingId, phone: null };
}
