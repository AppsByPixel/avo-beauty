/**
 * Booking — api-contract.md § Booking, build-plan.md phase 6.
 *
 * A booking is not an appointment note. It is a MONEY ROW with a calendar
 * attached: `POST /bookings` debits the customer's wallet for the salon's
 * deposit, and every exit from this table — completed, cancelled, no-show —
 * decides where that money lands. So this table is modelled the way
 * `transaction` is, not the way a scheduling table usually is.
 *
 * THE DEPOSIT IS A TRANSACTION, AND THIS ROW ONLY POINTS AT IT
 * -----------------------------------------------------------
 * `hold_transaction_id` is NOT NULL: a booking cannot exist without the
 * `deposit_hold` row that paid for it, and both are written in one database
 * transaction. There is deliberately no `deposit_fils` column that could
 * disagree with the transaction — well, there is, because the contract's
 * `BookingSchema` has one and both clients render it, but it is a copy of the
 * hold's magnitude taken at write time and never edited. The ledger is the
 * authority; this is the label.
 *
 * `settled_transaction_id` is the OTHER end, and the CHECK below makes the pair
 * a state machine the database enforces rather than a convention a handler
 * keeps:
 *
 *     deposit_held        settled_transaction_id IS NULL      money is in
 *                                                             `deposit_held`
 *     completed           → the charge that consumed it       money became
 *                                                             salon revenue
 *     cancelled           → the `deposit_return`              money went back
 *     no_show_returned    → the `deposit_return`              money went back
 *
 * A booking cannot be marked completed without naming the charge, and cannot be
 * cancelled without naming the refund. Refunds are wallet credit — non-negotiable
 * #5 — and "which transaction credited her" is the question that has to be
 * answerable at a counter.
 *
 * WHY `no_show_return_due_at` IS A STORED COLUMN AND NOT A COMPUTATION
 * -------------------------------------------------------------------
 * `salon.no_show_return_minutes` is editable. Computing the deadline at read
 * time means a merchant who changes 60 → 240 retroactively un-returns deposits
 * that were already due, and one who changes 240 → 60 makes a batch of live
 * bookings instantly overdue. The deadline a customer was promised is a fact
 * about her booking at the moment she made it, so it is stamped on the row. The
 * no-show job reads this column and nothing else.
 *
 * It is stamped from `ends_at`, not `starts_at`. The contract says "auto-returned
 * `noShowReturnMinutes` after a missed slot" and the product brief says "if the
 * customer doesn't arrive within 1 hour of the slot" — those are two readings of
 * the same sentence, and they differ by the length of the appointment. Measuring
 * from the END is the one that cannot fire while the customer is in the chair: a
 * 60-minute service under a 60-minute rule would otherwise have its deposit
 * returned at the exact moment the artist reaches for the scanner, and the credit
 * line the design promises ("8.000 − 5.000 = 3.000") would silently vanish. The
 * ambiguity is reported rather than settled quietly; the column is what makes
 * either answer a one-line change instead of a data migration.
 *
 * THE EXCLUSION CONSTRAINT IS THE DOUBLE-BOOK GUARANTEE
 * ----------------------------------------------------
 * Two customers tapping the same 16:45 slot at the same instant is the booking
 * equivalent of the double-tapped scanner, and the same answer applies: the
 * database resolves it, not a handler's `SELECT` followed by an `INSERT`. A
 * UNIQUE index on `(artist_id, starts_at)` would only catch an exact tie —
 * a 45-minute booking at 16:00 and a 30-minute one at 16:15 overlap and would
 * both be accepted. `EXCLUDE USING gist` over the real time range is the
 * constraint that means what the screen means. See migration 0013.
 */

import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { filsColumn, timestamptz } from './_shared';
import { artist } from './artist';
import { member } from './member';
import { branch, salon } from './salon';
import { service } from './service';
import { transaction } from './transaction';

/** api-contract.md § Booking, verbatim. The merchant's status pills. */
export const bookingStatus = pgEnum('booking_status', [
  'deposit_held',
  'completed',
  'no_show_returned',
  'cancelled',
]);

export const bookingSource = pgEnum('booking_source', ['app', 'google_calendar']);

/**
 * How a booking's write-back to the artist's calendar went.
 *
 * NOT part of the contract and not rendered by any client. It exists because the
 * write-back is a third-party call that happens AFTER the money transaction
 * commits — it must, for the reason services/receipts.ts gives about holding a
 * row lock across a provider's timeout — which means it can fail while the
 * booking is perfectly valid. Without a column the failure is a log line, and
 * "the artist's calendar is missing an appointment" becomes unanswerable.
 *
 *   not_applicable  the artist has no calendar connection to write to
 *   pending         the booking committed; the write-back has not run
 *   synced          `google_event_id` names a real event
 *   failed          the provider refused; `calendar_error` says what it said
 */
export const calendarSyncState = pgEnum('calendar_sync_state', [
  'not_applicable',
  'pending',
  'synced',
  'failed',
]);

export const booking = pgTable(
  'booking',
  {
    id: text('id').primaryKey(),

    salonId: text('salon_id')
      .notNull()
      .references(() => salon.id, { onDelete: 'restrict' }),
    /**
     * A booking has a branch, and the same rule applies as for a charge: the
     * client does not name it. `services/branch.ts` resolves it and says whether
     * the answer is a fact; `branch_assumed` carries that answer forward exactly
     * as `transaction.branch_assumed` does, so per-branch appointment counts can
     * be filtered the same way per-branch revenue can.
     */
    branchId: text('branch_id')
      .notNull()
      .references(() => branch.id, { onDelete: 'restrict' }),
    branchAssumed: boolean('branch_assumed').notNull().default(false),

    memberId: text('member_id')
      .notNull()
      .references(() => member.id, { onDelete: 'restrict' }),
    artistId: text('artist_id')
      .notNull()
      .references(() => artist.id, { onDelete: 'restrict' }),
    serviceId: text('service_id')
      .notNull()
      .references(() => service.id, { onDelete: 'restrict' }),

    /**
     * The instant, not a wall-clock string. `artist.windows` holds "16:45"
     * because a week of hours is a rule; a booking is a moment, and the two
     * representations are resolved against `salon.timezone` by src/time/zone.ts
     * at exactly one place — the availability grid this start time must come
     * from.
     */
    startsAt: timestamptz('starts_at').notNull(),
    /**
     * Stored rather than derived. The exclusion constraint needs a range
     * expression over immutable columns, and `starts_at + duration` is one the
     * planner can build — but a stored end is also what makes a later change to
     * how duration is decided incapable of moving an existing appointment.
     */
    endsAt: timestamptz('ends_at').notNull(),
    durationMin: integer('duration_min').notNull(),

    /** A copy of the hold's magnitude, for the label. The ledger is the authority. */
    depositFils: filsColumn('deposit_fils').notNull(),

    status: bookingStatus('status').notNull().default('deposit_held'),
    source: bookingSource('source').notNull().default('app'),

    /** The `deposit_hold` transaction. Written in the same database transaction. */
    holdTransactionId: text('hold_transaction_id')
      .notNull()
      .references((): AnyPgColumn => transaction.id, { onDelete: 'restrict' }),
    /**
     * Where the held money ended up: the charge that consumed it, or the
     * `deposit_return` that gave it back. NULL only while `deposit_held`.
     */
    settledTransactionId: text('settled_transaction_id').references(
      (): AnyPgColumn => transaction.id,
      { onDelete: 'restrict' },
    ),

    /** Stamped at write from `salon.no_show_return_minutes`. See the header. */
    noShowReturnDueAt: timestamptz('no_show_return_due_at').notNull(),

    /**
     * Reschedule CARRIES the deposit — README § Upcoming appointment. So it moves
     * `starts_at`/`ends_at`/`no_show_return_due_at` on this row rather than
     * writing a new booking, which is also why the contract's status enum has no
     * `rescheduled`: nothing about the money changed. The counter is kept so the
     * appointment list can show that a slot has moved, and so "she rescheduled
     * four times" is answerable without reading the audit log.
     */
    rescheduledCount: integer('rescheduled_count').notNull().default(0),
    rescheduledAt: timestamptz('rescheduled_at'),

    calendarSyncState: calendarSyncState('calendar_sync_state').notNull().default('not_applicable'),
    googleEventId: text('google_event_id'),
    calendarError: text('calendar_error'),

    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
    completedAt: timestamptz('completed_at'),
    cancelledAt: timestamptz('cancelled_at'),
    returnedAt: timestamptz('returned_at'),
  },
  (t) => [
    index('booking_member_starts_idx').on(t.memberId, t.startsAt.desc()),
    index('booking_salon_starts_idx').on(t.salonId, t.startsAt.desc()),
    index('booking_artist_starts_idx').on(t.artistId, t.startsAt),
    /**
     * The no-show job's only index. Partial, because a job that scans terminal
     * bookings is a job that gets slower every day it runs.
     */
    index('booking_no_show_due_idx')
      .on(t.noShowReturnDueAt)
      .where(sql`status = 'deposit_held'`),

    check('booking_duration_positive', sql`${t.durationMin} > 0`),
    check('booking_ends_after_starts', sql`${t.endsAt} > ${t.startsAt}`),
    // A booking with no deposit is a note in a diary, not a commitment. The
    // salon range is 1000-10000 fils; this only refuses the absurd.
    check('booking_deposit_positive', sql`${t.depositFils} > 0`),
    /**
     * THE STATE MACHINE, as a constraint.
     *
     * Held ⟺ nothing settled it. Every terminal status names the transaction
     * that resolved the money. A handler that marks a booking completed and
     * forgets to link the charge does not commit.
     */
    check(
      'booking_settlement_matches_status',
      sql`(${t.status} = 'deposit_held') = (${t.settledTransactionId} IS NULL)`,
    ),
    check(
      'booking_completed_at_matches_status',
      sql`(${t.status} = 'completed') = (${t.completedAt} IS NOT NULL)`,
    ),
    check(
      'booking_cancelled_at_matches_status',
      sql`(${t.status} = 'cancelled') = (${t.cancelledAt} IS NOT NULL)`,
    ),
    check(
      'booking_returned_at_matches_status',
      sql`(${t.status} = 'no_show_returned') = (${t.returnedAt} IS NOT NULL)`,
    ),
    check('booking_rescheduled_count_non_negative', sql`${t.rescheduledCount} >= 0`),
    check(
      'booking_rescheduled_at_matches_count',
      sql`(${t.rescheduledCount} > 0) = (${t.rescheduledAt} IS NOT NULL)`,
    ),
    /**
     * `synced` is the only state that may name an event, and it must.
     * A `google_event_id` on a `failed` row is an id nobody can cancel against.
     */
    check(
      'booking_google_event_matches_sync_state',
      sql`(${t.calendarSyncState} = 'synced') = (${t.googleEventId} IS NOT NULL)`,
    ),
  ],
);

/**
 * The artist's calendar connection.
 *
 * SEPARATE FROM `artist.google_connected`, and the separation is the point.
 * That boolean is what the merchant dashboard renders and what the
 * `artist_google_source_requires_connection` CHECK guards — a row cannot claim
 * its hours come from a calendar it never connected. This table is the
 * connection ITSELF: which account, which calendar, whether the token still
 * works, and when it was last read. The boolean is a claim; this is the fact.
 *
 * NO TOKEN IS STORED HERE. `credential_ref` is a pointer into a secret store,
 * because an OAuth refresh token in an application table is a credential sitting
 * in every backup, every replica and every `SELECT *` in a support session. The
 * column is text and deliberately opaque: today nothing writes it, because
 * nothing can — see src/calendar/, and the report on what the client has to
 * provide before a real Google project exists.
 */
export const calendarConnectionStatus = pgEnum('calendar_connection_status', [
  'connected',
  'revoked',
  'error',
]);

export const artistCalendarConnection = pgTable(
  'artist_calendar_connection',
  {
    id: text('id').primaryKey(),
    salonId: text('salon_id')
      .notNull()
      .references(() => salon.id, { onDelete: 'restrict' }),
    /**
     * One live connection per artist. A second Google account on the same
     * calendar column would make "whose busy blocks are these" a coin toss, the
     * same way two artist rows on one staff login would have made
     * `PUT /artists/me/availability` one.
     */
    artistId: text('artist_id')
      .notNull()
      .unique()
      .references(() => artist.id, { onDelete: 'restrict' }),

    provider: text('provider').notNull().default('google'),
    status: calendarConnectionStatus('status').notNull().default('connected'),

    /** The Google account that authorised, for the dashboard to display. */
    accountEmail: text('account_email'),
    externalCalendarId: text('external_calendar_id'),
    /** A pointer into the secret store. NEVER the token. See the header. */
    credentialRef: text('credential_ref'),

    lastSyncedAt: timestamptz('last_synced_at'),
    lastError: text('last_error'),

    connectedAt: timestamptz('connected_at').notNull().defaultNow(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('artist_calendar_connection_salon_idx').on(t.salonId),
    check(
      'artist_calendar_connection_error_has_message',
      sql`${t.status} <> 'error' OR ${t.lastError} IS NOT NULL`,
    ),
  ],
);
