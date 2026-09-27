/**
 * DEPOSIT HEALTH — `GET /salons/{id}/deposits`, `perms.appointments`.
 *
 * Aftab, the last item on his numbered list, verbatim:
 *
 *   "what if they dont have enough payment (sometimes they dont have money but
 *    lock the booking and they dont come) deposit health option for merchants"
 *
 * New scope, asked for directly. It is not in `design/` and it is not a Known
 * gap, so the reasoning is written down here rather than left to be inferred
 * from the SQL.
 *
 * =========================================================================
 * WHY THIS IS NOT A SECOND COPY OF THE OVERVIEW TILE
 * =========================================================================
 * `services/metrics.ts § UPCOMING TODAY` already computes the set of bookings
 * that are still to start today, and it says out loud what it leaves out:
 *
 *   "A 10:00 booking still sitting in `deposit_held` at 16:00 is therefore
 *    excluded — it is overdue, not upcoming, and both filters are doing real
 *    work rather than one covering for the other."
 *
 * That exclusion is right for a tile a merchant reads to know what is LEFT in
 * her day. It is also the exact customer the client is describing, and until
 * this endpoint existed nothing in the product surfaced her. So this file is the
 * complement of that filter, not a widening of it: metrics answers "what is
 * still coming", this answers "what never resolved".
 *
 * `deposit_held` IS THE UNRESOLVED SET, and `booking_settlement_matches_status`
 * makes that precise by constraint rather than by convention — held ⟺ nothing
 * settled it. `completed`, `cancelled` and `no_show_returned` all name the
 * transaction that resolved the money. So there is no cleverness in the WHERE
 * clause here: one status, and the database guarantees what it means.
 *
 * =========================================================================
 * THE DISTINCTION THIS FILE EXISTS TO MAKE
 * =========================================================================
 * "Past its slot and still held" is THREE different facts wearing one shape, and
 * collapsing them would let an AVO outage read as customers behaving badly.
 *
 * ---- `awaiting_arrival` -----------------------------------------------------
 *   `starts_at < now` AND `no_show_return_due_at > now`.
 *
 *   Her slot has started and nothing has resolved it. She is late, or she is in
 *   the chair and nobody has charged her yet, or she is not coming. The grace
 *   window the salon itself chose (`salon.no_show_return_minutes`) has not
 *   expired, so the correct state of the world is "we are still waiting".
 *
 *   THIS IS THE CLIENT'S QUESTION. It is the only one of the three that is about
 *   a customer at all.
 *
 * ---- `return_overdue` -------------------------------------------------------
 *   `no_show_return_due_at <= now` AND `hold_transaction_id IS NOT NULL`.
 *
 *   The deadline stamped on the row has passed and the deposit is STILL HELD.
 *   `services/noShowWorker.ts` selects on exactly this predicate, so a row in
 *   this state is a row the job was supposed to have taken and has not:
 *
 *     THE CUSTOMER IS OWED HER DEPOSIT BACK AND HAS NOT GOT IT.
 *
 *   That is an operational health signal about AVO — a worker that is not
 *   running, or that is failing this row every tick — and it is emphatically NOT
 *   evidence about the customer. She may well have no-showed; she also may have
 *   cancelled in a way that failed, or the job may simply be down for everybody.
 *   Counting her here beside the customers in `awaiting_arrival` would turn "our
 *   worker is stuck" into "these women do not turn up", which is a claim about
 *   named people made out of our own outage.
 *
 * ---- `unclosed` -------------------------------------------------------------
 *   `no_show_return_due_at <= now` AND `hold_transaction_id IS NULL`.
 *
 *   Past the same deadline, but there is NO MONEY. Migration 0056 let
 *   hand-written appointments into this table and `booking_merchant_is_zero_
 *   deposit` plus `booking_deposit_matches_hold` make "no hold" and "zero
 *   deposit" the same fact. `noShowWorker` excludes these rows deliberately and
 *   says why at length: returning 0 fils would write an unbalanced ledger pair
 *   and stamp a no-show on somebody nobody marked.
 *
 *   So a row here is NOT a stuck worker. Nothing is owed and nothing is late.
 *   It is a walk-in or a merchant-written appointment that the front desk never
 *   closed off. Folding it into `return_overdue` would inflate an AVO fault
 *   count with the salon's own book-keeping, and folding it into
 *   `awaiting_arrival` would tell a merchant to keep waiting for somebody whose
 *   appointment ended last Tuesday.
 *
 * THE THREE PARTITION THE OVERDUE SET, by construction rather than by care:
 * `no_show_return_due_at` is stamped from `ends_at` plus
 * `salon.no_show_return_minutes`, which `salon_no_show_return_in_range` pins
 * `BETWEEN 5 AND 1440`, and `booking_ends_after_starts` gives `ends_at >
 * starts_at`. So `due_at > starts_at` on every row, and `due_at <= now` implies
 * `starts_at < now` — two CHECK constraints rather than an assumption about how
 * the write path happens to behave today.
 * Every `starts_at < now` row therefore falls in exactly one of the three, and
 * `awaiting + return_overdue + unclosed = overdue` is a property of the
 * predicates and not an assertion this file has to keep true by hand.
 *
 * =========================================================================
 * ONE QUERY, FOR `metrics.ts`'s REASON
 * =========================================================================
 * Every count, every sum and every instant that qualifies one of them comes out
 * of a SINGLE aggregate SELECT with `FILTER` clauses. metrics.ts states the
 * argument and it is the same argument here: "a caveat fetched separately from
 * the figure it qualifies can disagree with it", and a count of 4 beside an
 * "oldest at" that is outside the set those 4 came from is a contract violation
 * rather than a rendering choice. A second query cannot be made to agree with
 * the first by discipline; one query makes the disagreement unrepresentable.
 *
 * The ROW LIST is a second query and deliberately is not held to that rule — it
 * is capped (`DEPOSIT_ROWS_MAX`), so it is a page of evidence and not the
 * figure. `overdue.bookings` is the authority on how many there are, `rows` is
 * what they were, and `rowsTruncated` says when the two legitimately differ.
 *
 * THE CLASSIFICATION IS WRITTEN ONCE. `awaitingArrival`, `returnOverdue` and
 * `unclosed` below are `sql` fragments spliced into BOTH the aggregate's FILTER
 * clauses and the row query's CASE. A TypeScript re-implementation of the same
 * three predicates over the fetched rows would be a second definition of the one
 * distinction this file exists to make, and the two would drift.
 *
 * =========================================================================
 * MONEY
 * =========================================================================
 * Non-negotiable #1. Every sum is `::bigint` in SQL and goes through `filsFrom`,
 * which REFUSES a non-integer rather than truncating it. That is the one place
 * this file deviates from `metrics.ts § int`: `int()` is `Math.trunc`, which is
 * right for a count and wrong for money, because a fractional sum reaching a
 * money field means a float got into the column and truncating it silently
 * repairs the symptom of exactly the defect #1 exists to catch.
 *
 * A GUEST APPOINTMENT CONTRIBUTES ZERO, and that is a database fact rather than
 * a filter: `booking_merchant_is_zero_deposit` forbids a merchant-written row
 * from carrying money at all, because #2 says a merchant who can debit a wallet
 * by filling in a form can do it without the customer. So walk-ins appear in the
 * counts and in the rows — the front desk needs to see the chair is still open —
 * and cannot move the held total by a single fils.
 */

import { sql } from 'drizzle-orm';
import { fils, type Fils } from '@avo/types';
import type { Db } from '../db/client';
import { at, int } from './metrics';
import type { BranchFilter } from './branchFilter';
import { serialiseMemberContact } from '../http/serialise';

/**
 * The ceiling on the row list. The counts are unbounded and exact; this bounds
 * the payload.
 *
 * 200 rather than a cursor. A salon's overdue set is the bookings that never
 * resolved, which at a healthy salon is a handful and at a broken one is a
 * backlog someone needs to be told about in one screen — neither is a walk. A
 * cursor here would also have to be stable across a `now` that moves between
 * pages, and the set is DEFINED by `now`: a row can leave `awaiting_arrival`
 * and enter `return_overdue` mid-walk. `rowsTruncated` is the honest answer
 * instead, and `overdue.bookings` is always the true size.
 */
export const DEPOSIT_ROWS_MAX = 200;

/** Which of the three an overdue booking is in. See the header. */
export type DepositState = 'awaiting_arrival' | 'return_overdue' | 'unclosed';

export interface DepositRow {
  bookingId: string;
  state: DepositState;

  /**
   * EXACTLY ONE OF `memberId` AND `guestName` IS NON-NULL —
   * `booking_identity_exactly_one`. Both are present on every row rather than
   * omitted, for `services/booking.ts § serialiseBooking`'s stated reason: a
   * field that is sometimes absent and sometimes null is two shapes.
   */
  memberId: string | null;
  memberName: string | null;
  /**
   * DECISIONS #100. This query joins `member` for a name and a phone, and
   * `http/serialise.ts` says in as many words what that means: it calls
   * `serialiseMemberContact` or it repeats the bug. Erasure cannot clear
   * `member.phone` — NOT NULL, E.164-CHECKed, unique per salon — so it
   * overwrites it with a `+990` tombstone, and three merchant reads have already
   * rendered that into a `tel:` link beside "Deleted account".
   */
  memberErased: boolean;
  /** Null for an erased member. Never the `+990` tombstone. */
  memberPhone: string | null;
  guestName: string | null;
  guestPhone: string | null;

  artistId: string;
  artistName: string;
  serviceName: string;
  branchId: string;
  branchName: string;
  /** Whether this row's branch was RECORDED or inferred. `db/schema/booking.ts`. */
  branchAssumed: boolean;

  startsAt: string;
  endsAt: string;
  durationMin: number;
  /** Integer fils. Zero on every walk-in, by constraint. */
  depositFils: Fils;
  noShowReturnDueAt: string;
  source: string;

  /**
   * HOW OVERDUE, in whole minutes since `starts_at`. Floored, not rounded: "at
   * least this long" is the true statement, and a round-half-up would report a
   * booking 29 seconds past its slot as a minute late.
   *
   * A NUMBER, NOT A SENTENCE. "2h 15m" bakes one language into a field two
   * languages read, and non-negotiable #12 makes Arabic a layout rather than a
   * translation pass — the wallet renders Western digits inside an RTL line and
   * the client owns that, not this.
   */
  overdueMinutes: number;
  /**
   * Minutes since the deposit was DUE BACK, and null unless `state` is
   * `return_overdue`. On the other two states there is nothing due: an
   * `awaiting_arrival` row has not reached its deadline, and an `unclosed` row
   * has no money behind the deadline it passed. A zero there would read as "due
   * back this instant", which is a different and false claim.
   */
  returnOverdueMinutes: number | null;
}

export interface DepositHealth {
  /** The instant every figure below was computed against. */
  asOf: string;

  /**
   * EVERY `deposit_held` BOOKING IN SCOPE — the answer to "how much of my
   * customers' money am I sitting on", which is figure 2 of the three the
   * client's sentence implies and which nothing in the product served.
   */
  held: {
    bookings: number;
    fils: Fils;
    /**
     * How many of those rows had their branch INFERRED rather than recorded —
     * `metrics.ts § branchAssumed`, and null at `branch=all` for its reason: a
     * row attributed to the wrong branch is still inside the salon, so a
     * salon-wide total is exact however many rows are assumed.
     */
    branchAssumed: number | null;
  };

  /**
   * Held, slot NOT yet started.
   *
   * NAMED `scheduled` AND NOT `upcoming`, deliberately. `metrics.ts` serves
   * `upcomingAppointments`, which is bounded at the SALON'S MIDNIGHT and means
   * "what is left in her day". This has no day bound at all — it is every future
   * held booking, which at a salon taking bookings three weeks out is a much
   * larger number. Two figures with one name, differing only by a bound nobody
   * can see in the payload, is the failure metrics.ts's whole header exists to
   * prevent.
   */
  scheduled: { bookings: number; fils: Fils };

  /** Held, slot already started. The set metrics.ts excludes on purpose. */
  overdue: {
    bookings: number;
    fils: Fils;
    /**
     * The earliest `starts_at` in the overdue set — how far back the backlog
     * goes. Out of the SAME aggregate as the count it qualifies, so it is null
     * exactly when the count is 0, by construction.
     */
    oldestStartedAt: string | null;
    branchAssumed: number | null;

    /** She has not arrived, and the grace window has not run out. */
    awaitingArrival: { bookings: number; fils: Fils };

    /**
     * AVO OWES THIS MONEY BACK AND HAS NOT RETURNED IT. An operational signal
     * about us, not about her. Non-zero here means `noShowWorker` is not doing
     * its work.
     */
    returnOverdue: {
      bookings: number;
      fils: Fils;
      /**
       * The oldest unmet deadline — the longest any customer has been waiting
       * for money that is hers. Same aggregate as the count, same construction.
       */
      dueSince: string | null;
    };

    /**
     * Past the deadline with no money behind it: a hand-written appointment
     * nobody closed.
     *
     * NO `fils`, AND THAT IS NOT AN OMISSION. `booking_deposit_matches_hold`
     * makes "no hold" and "zero deposit" the same fact, so the sum is 0 for
     * every row here for ever. Serving it would invite a client to render
     * "0.000 KD" as a quantity — a money figure that can never be anything but
     * zero is a field whose only possible use is to mislead.
     */
    unclosed: { bookings: number; oldestStartedAt: string | null };
  };

  /**
   * The overdue rows, oldest slot first, capped at `DEPOSIT_ROWS_MAX`.
   *
   * ORDERED BY TIME, NEVER BY PERSON. A list sorted by how often a customer has
   * no-showed is a leaderboard of women to distrust, and this endpoint refuses
   * to build one — see `countMemberNoShows` in services/customerDirectory.ts.
   * `starts_at ASC` is a queue: the oldest thing that never resolved is the
   * thing to deal with first.
   */
  rows: DepositRow[];
  /** True when the cap hid rows. `overdue.bookings` is always the true size. */
  rowsTruncated: boolean;

  branchId: string | null;
  branchName: string | null;
}

/**
 * Money from a Postgres aggregate, and it REFUSES rather than truncates.
 *
 * `sum()` over an integer column returns numeric, which arrives as a string
 * through postgres.js. `::bigint` in the query and `fils()` here are the two
 * halves: the cast makes it an integer in the database, and `fils()` throws if
 * it somehow is not.
 *
 * THIS IS WHY THE COUNTS USE `metrics.ts § int` AND THE MONEY DOES NOT. `int` is
 * `Math.trunc`, which is right for a count and wrong here: truncating would
 * swallow the one signal that a float had reached a money column, which is the
 * defect non-negotiable #1 exists to catch. Two funnels, and the money one
 * refuses.
 */
function filsFrom(value: unknown): Fils {
  if (value === null || value === undefined) return fils(0);
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new TypeError(`A deposit sum arrived as ${String(value)}, which is not a number.`);
  }
  return fils(n);
}

/** An ISO instant from a raw-`sql` timestamptz, or null. `metrics.ts § rawNext`. */
function instant(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return new Date(value as string | Date).toISOString();
}

export async function computeDepositHealth(
  db: Db,
  salonId: string,
  now = new Date(),
  /**
   * Already resolved and already proved to belong to this salon —
   * `services/branchFilter.ts`, called by the route. The RESOLVED branch and
   * never the raw query value, for `metrics.ts`'s reason: the salon-scoping in
   * that lookup is the load-bearing half of `?branch=`, and a service that took
   * a string would be a second place to forget it.
   */
  branch: BranchFilter | null = null,
): Promise<DepositHealth> {
  const branchId = branch?.id ?? null;
  /**
   * Empty `sql``` rather than `AND TRUE`, so an unfiltered call emits the query
   * it would have emitted without the parameter. `metrics.ts § atBranch` and
   * `reports.ts § computeReport` use the same shape.
   */
  const atBranch = branchId === null ? sql`` : sql`AND booking.branch_id = ${branchId}`;
  const nowAt = at(now);

  /**
   * THE THREE PREDICATES, WRITTEN ONCE. Spliced into the aggregate's FILTER
   * clauses AND into the row query's CASE, so the figure and the row label
   * cannot disagree about which state a booking is in. Columns are
   * `booking.`-qualified because the row query joins four more tables.
   */
  const started = sql`booking.starts_at < ${nowAt}`;
  const awaitingArrival = sql`booking.starts_at < ${nowAt} AND booking.no_show_return_due_at > ${nowAt}`;
  const returnOverdue = sql`booking.no_show_return_due_at <= ${nowAt} AND booking.hold_transaction_id IS NOT NULL`;
  const unclosed = sql`booking.no_show_return_due_at <= ${nowAt} AND booking.hold_transaction_id IS NULL`;

  // ------------------------------------------------- one query, every figure --
  const totalsRows = await db.execute(sql`
    SELECT
      count(*)                                                        AS held,
      coalesce(sum(booking.deposit_fils), 0)::bigint                   AS held_fils,
      count(*) FILTER (WHERE booking.branch_assumed)                   AS held_assumed,

      count(*) FILTER (WHERE booking.starts_at >= ${nowAt})            AS scheduled,
      coalesce(sum(booking.deposit_fils)
        FILTER (WHERE booking.starts_at >= ${nowAt}), 0)::bigint       AS scheduled_fils,

      count(*) FILTER (WHERE ${started})                               AS overdue,
      coalesce(sum(booking.deposit_fils)
        FILTER (WHERE ${started}), 0)::bigint                          AS overdue_fils,
      min(booking.starts_at) FILTER (WHERE ${started})                 AS overdue_oldest_at,
      count(*) FILTER (WHERE ${started} AND booking.branch_assumed)    AS overdue_assumed,

      count(*) FILTER (WHERE ${awaitingArrival})                       AS awaiting,
      coalesce(sum(booking.deposit_fils)
        FILTER (WHERE ${awaitingArrival}), 0)::bigint                  AS awaiting_fils,

      count(*) FILTER (WHERE ${returnOverdue})                         AS return_overdue,
      coalesce(sum(booking.deposit_fils)
        FILTER (WHERE ${returnOverdue}), 0)::bigint                    AS return_overdue_fils,
      min(booking.no_show_return_due_at) FILTER (WHERE ${returnOverdue}) AS return_due_since,

      count(*) FILTER (WHERE ${unclosed})                              AS unclosed,
      min(booking.starts_at) FILTER (WHERE ${unclosed})                AS unclosed_oldest_at
    FROM booking
    WHERE booking.salon_id = ${salonId}
      AND booking.status = 'deposit_held'
      ${atBranch}
  `);
  const t = (totalsRows as unknown as Array<Record<string, unknown>>)[0] ?? {};

  // ------------------------------------------------------------ the evidence --
  /**
   * `booking_salon_starts_idx` is `(salon_id, starts_at DESC)` and already
   * existed. `starts_at ASC` walks the same index backwards, bounded by `now` on
   * the leading edge, which is why this is cheap rather than merely correct.
   *
   * `LEFT JOIN member` — and it has to be. `booking.member_id` is nullable since
   * migration 0056 so that a hand-written appointment can name a WALK-IN, and an
   * inner join would drop every guest row from the one list that most needs to
   * show an unclosed walk-in. `routes/salons.ts § GET /salons/:id/bookings`
   * records the same fix and what it cost.
   */
  const rowRows = await db.execute(sql`
    SELECT
      booking.id                       AS booking_id,
      booking.member_id                AS member_id,
      booking.guest_name               AS guest_name,
      booking.guest_phone              AS guest_phone,
      booking.artist_id                AS artist_id,
      booking.branch_id                AS branch_id,
      booking.branch_assumed           AS branch_assumed,
      booking.starts_at                AS starts_at,
      booking.ends_at                  AS ends_at,
      booking.duration_min             AS duration_min,
      booking.deposit_fils             AS deposit_fils,
      booking.no_show_return_due_at    AS no_show_return_due_at,
      booking.source                   AS source,
      member.name                      AS member_name,
      member.phone                     AS member_phone,
      member.erased_at                 AS member_erased_at,
      artist.name                      AS artist_name,
      service.name                     AS service_name,
      branch.name                      AS branch_name,
      CASE
        WHEN ${awaitingArrival} THEN 'awaiting_arrival'
        WHEN ${returnOverdue}   THEN 'return_overdue'
        ELSE 'unclosed'
      END                              AS state,
      floor(extract(epoch FROM (${nowAt} - booking.starts_at)) / 60)::bigint AS overdue_minutes,
      CASE WHEN ${returnOverdue}
        THEN floor(extract(epoch FROM (${nowAt} - booking.no_show_return_due_at)) / 60)::bigint
        ELSE NULL
      END                              AS return_overdue_minutes
    FROM booking
    LEFT JOIN member  ON member.id  = booking.member_id
    JOIN artist       ON artist.id  = booking.artist_id
    JOIN service      ON service.id = booking.service_id
    JOIN branch       ON branch.id  = booking.branch_id
    WHERE booking.salon_id = ${salonId}
      AND booking.status = 'deposit_held'
      AND ${started}
      ${atBranch}
    ORDER BY booking.starts_at ASC, booking.id ASC
    LIMIT ${DEPOSIT_ROWS_MAX}
  `);

  const rows: DepositRow[] = (rowRows as unknown as Array<Record<string, unknown>>).map((r) => {
    /**
     * ONE derivation of the erasure, destructured — not `erased_at !== null`
     * here and `serialiseMemberContact` there. `services/customerDirectory.ts`
     * states it: two tests of one fact in one function is how they start
     * disagreeing. The left join means both columns are null on a guest row,
     * which `serialiseMemberContact` reads as "not erased, no phone" — its own
     * header already covers that case in as many words ("null in, null out",
     * widened for exactly this left join), so a guest row needs no second branch
     * here. Her own contact details are the two fields beside it.
     */
    const { memberErased, memberPhone } = serialiseMemberContact({
      erasedAt: (r.member_erased_at as Date | null) ?? null,
      phone: (r.member_phone as string | null) ?? null,
    });
    const overdueReturn = r.return_overdue_minutes;
    return {
      bookingId: String(r.booking_id),
      state: String(r.state) as DepositState,
      memberId: (r.member_id as string | null) ?? null,
      memberName: (r.member_name as string | null) ?? null,
      memberErased,
      memberPhone,
      guestName: (r.guest_name as string | null) ?? null,
      guestPhone: (r.guest_phone as string | null) ?? null,
      artistId: String(r.artist_id),
      artistName: String(r.artist_name),
      serviceName: String(r.service_name),
      branchId: String(r.branch_id),
      branchName: String(r.branch_name),
      branchAssumed: Boolean(r.branch_assumed),
      startsAt: new Date(r.starts_at as string | Date).toISOString(),
      endsAt: new Date(r.ends_at as string | Date).toISOString(),
      durationMin: int(r.duration_min),
      depositFils: filsFrom(r.deposit_fils),
      noShowReturnDueAt: new Date(r.no_show_return_due_at as string | Date).toISOString(),
      source: String(r.source),
      overdueMinutes: int(r.overdue_minutes),
      returnOverdueMinutes:
        overdueReturn === null || overdueReturn === undefined ? null : int(overdueReturn),
    };
  });

  const overdueCount = int(t.overdue);

  return {
    asOf: now.toISOString(),
    held: {
      bookings: int(t.held),
      fils: filsFrom(t.held_fils),
      branchAssumed: branchId === null ? null : int(t.held_assumed),
    },
    scheduled: {
      bookings: int(t.scheduled),
      fils: filsFrom(t.scheduled_fils),
    },
    overdue: {
      bookings: overdueCount,
      fils: filsFrom(t.overdue_fils),
      oldestStartedAt: instant(t.overdue_oldest_at),
      branchAssumed: branchId === null ? null : int(t.overdue_assumed),
      awaitingArrival: {
        bookings: int(t.awaiting),
        fils: filsFrom(t.awaiting_fils),
      },
      returnOverdue: {
        bookings: int(t.return_overdue),
        fils: filsFrom(t.return_overdue_fils),
        dueSince: instant(t.return_due_since),
      },
      unclosed: {
        bookings: int(t.unclosed),
        oldestStartedAt: instant(t.unclosed_oldest_at),
      },
    },
    /**
     * `rows.length === DEPOSIT_ROWS_MAX && overdueCount > rows.length` would be
     * the same answer with a redundant clause; the cap is the only thing that
     * can shorten this list, and the count is exact, so their difference IS the
     * truncation.
     */
    rows,
    rowsTruncated: overdueCount > rows.length,
    branchId,
    branchName: branch?.name ?? null,
  };
}
