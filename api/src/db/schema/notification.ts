/**
 * Merchant notifications — the bell in AVO Merchant Dashboard.dc.html.
 *
 * WHY THIS EXISTS NOW, IN A BOOKING SLICE
 * ---------------------------------------
 * build-plan.md phase 6 § Done when: "a calendar disconnect raises a merchant
 * notification and falls back to salon hours". The fallback is a computation and
 * could have been done silently; the notification is the half that makes it
 * honest. An artist whose hours come from a calendar the server cannot read is
 * being offered to customers on the SALON's hours instead of her own, which will
 * book her outside the times she actually works. That is not a log line. It is a
 * thing the salon has to be told, in the place it reads things it is told.
 *
 * The full notification centre is phase 4 and is not built here. This is the
 * table and the write helper; the bell that renders it is the dashboard lane's.
 * Building it as a table rather than as an audit row is deliberate: `audit_log`
 * is an append-only record of what HAPPENED, seven years, never updated — a
 * notification is a piece of state that gets read and dismissed, and giving it a
 * `read_at` would break the append-only guarantee that makes the audit log worth
 * having.
 *
 * ONE OPEN NOTIFICATION PER (SALON, KIND, SUBJECT)
 * -----------------------------------------------
 * `merchant_notification_open_uq` below. Availability is read once per customer
 * per day per artist; a disconnected calendar would otherwise mint a
 * notification on every one of those reads and bury the bell under a thousand
 * copies of one fact. The unique partial index makes "raise this, if it is not
 * already raised" a single `ON CONFLICT DO NOTHING`, which is also what makes
 * the raise safe to call from a hot read path.
 */

import { sql } from 'drizzle-orm';
import { check, index, jsonb, pgEnum, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { timestamptz } from './_shared';
import { salon } from './salon';

export const notificationKind = pgEnum('merchant_notification_kind', [
  /** An artist is sourced from a calendar this server cannot read. */
  'calendar_disconnected',
  /** A deposit was returned automatically because nobody arrived. */
  'booking_no_show',
]);

export const notificationSeverity = pgEnum('merchant_notification_severity', [
  'info',
  'warning',
]);

export const merchantNotification = pgTable(
  'merchant_notification',
  {
    id: text('id').primaryKey(),
    salonId: text('salon_id')
      .notNull()
      .references(() => salon.id, { onDelete: 'restrict' }),

    kind: notificationKind('kind').notNull(),
    severity: notificationSeverity('severity').notNull().default('warning'),

    title: text('title').notNull(),
    body: text('body').notNull(),

    /**
     * What this is about — `('artist', 'AR-001')`, `('booking', 'BK-4410293')`.
     * Part of the open-uniqueness key, so one disconnected artist is one
     * notification and two disconnected artists are two.
     */
    subjectType: text('subject_type').notNull(),
    subjectId: text('subject_id').notNull(),

    /** The dashboard's deep link target — phase 4 renders it, phase 6 sets it. */
    deepLink: text('deep_link'),
    metadata: jsonb('metadata')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),

    createdAt: timestamptz('created_at').notNull().defaultNow(),
    /** Set when the merchant reads the bell. NULL is "open". */
    readAt: timestamptz('read_at'),
    /** Set when the condition clears — a calendar reconnects. NULL is "open". */
    resolvedAt: timestamptz('resolved_at'),
  },
  (t) => [
    index('merchant_notification_salon_created_idx').on(t.salonId, t.createdAt.desc()),
    /**
     * The dedup. See the header: without it, a disconnected calendar mints a row
     * on every availability read.
     */
    uniqueIndex('merchant_notification_open_uq')
      .on(t.salonId, t.kind, t.subjectType, t.subjectId)
      .where(sql`resolved_at IS NULL`),
    check('merchant_notification_title_not_blank', sql`length(btrim(${t.title})) > 0`),
  ],
);
