/**
 * The salon's own booking policy, and the bell notice each publish writes.
 * Migration 0066 carries the whole argument; this file mirrors it for Drizzle.
 *
 * `booking_policy` is APPEND-ONLY for `avo_app` (0066's REVOKE). A publish inserts
 * version n+1; nothing edits a version, because bookings point at the version they
 * were made under and "a later edit never changes what an existing booking returns"
 * (DECISIONS.md, the fourth list) is only true if that row cannot change.
 *
 * `cancellation_rules` is a jsonb array checked by `booking_cancellation_rules_valid`
 * — up to three `{ hoursBefore, returnPercent }`, `hoursBefore` strictly descending,
 * `returnPercent` non-increasing. services/bookingPolicy.ts § parseCancellationRules
 * is the same rule in TypeScript and is what answers a merchant with a 400.
 */

import { sql } from 'drizzle-orm';
import {
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
} from 'drizzle-orm/pg-core';
import { timestamptz } from './_shared';
import { member } from './member';
import { salon } from './salon';
import { staffUser } from './staff';

export type NoShowRule = 'keep' | 'return';

export interface CancellationRule {
  /** Whole hours before `starts_at`. She meets it when at least this far ahead. */
  hoursBefore: number;
  /** Whole percent of the deposit returned to her wallet, 0–100. */
  returnPercent: number;
}

export const bookingPolicy = pgTable(
  'booking_policy',
  {
    id: text('id').primaryKey(),
    salonId: text('salon_id')
      .notNull()
      .references(() => salon.id, { onDelete: 'restrict' }),
    version: integer('version').notNull(),
    noShowRule: text('no_show_rule').$type<NoShowRule>().notNull(),
    cancellationRules: jsonb('cancellation_rules').$type<CancellationRule[]>().notNull(),
    textEn: text('text_en').notNull(),
    /** Empty means "fall back to `text_en`", as `LegalDocSchema` does. Never NULL. */
    textAr: text('text_ar').notNull().default(''),
    publishedAt: timestamptz('published_at').notNull().defaultNow(),
    publishedByStaffId: text('published_by_staff_id')
      .notNull()
      .references(() => staffUser.id, { onDelete: 'restrict' }),
  },
  (t) => [
    unique('booking_policy_salon_version_uq').on(t.salonId, t.version),
    unique('booking_policy_ref_uq').on(t.id, t.salonId, t.version),
    check('booking_policy_version_positive', sql`${t.version} > 0`),
    check('booking_policy_no_show_rule_valid', sql`${t.noShowRule} IN ('keep', 'return')`),
    check('booking_policy_rules_valid', sql`booking_cancellation_rules_valid(${t.cancellationRules})`),
    check(
      'booking_policy_text_en_present',
      sql`length(btrim(${t.textEn})) > 0 AND char_length(${t.textEn}) <= 1000`,
    ),
    check('booking_policy_text_ar_bounded', sql`char_length(${t.textAr}) <= 1000`),
  ],
);

/**
 * One wallet-bell notice per member per salon per salon-local day. The UNIQUE is
 * the coalescing rule, so two publishes racing on one day still write one notice
 * each member. Bell only — nothing reads this to SEND anything (#8).
 */
export const memberPolicyNotice = pgTable(
  'member_policy_notice',
  {
    id: text('id').primaryKey(),
    memberId: text('member_id')
      .notNull()
      .references(() => member.id, { onDelete: 'restrict' }),
    salonId: text('salon_id')
      .notNull()
      .references(() => salon.id, { onDelete: 'restrict' }),
    policyId: text('policy_id').notNull(),
    policyVersion: integer('policy_version').notNull(),
    noticeDate: date('notice_date', { mode: 'string' }).notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    readAt: timestamptz('read_at'),
  },
  (t) => [
    foreignKey({
      name: 'member_policy_notice_policy_fk',
      columns: [t.policyId, t.salonId, t.policyVersion],
      foreignColumns: [bookingPolicy.id, bookingPolicy.salonId, bookingPolicy.version],
    }).onDelete('restrict'),
    unique('member_policy_notice_one_a_day_uq').on(t.memberId, t.salonId, t.noticeDate),
    index('member_policy_notice_member_created_idx').on(t.memberId, t.createdAt.desc()),
    check(
      'member_policy_notice_read_after_created',
      sql`${t.readAt} IS NULL OR ${t.readAt} >= ${t.createdAt}`,
    ),
  ],
);
