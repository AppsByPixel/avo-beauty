/**
 * Member (the customer) — api-contract.md § Member.
 *
 * This table holds the single most important constraint in the product:
 *
 *   CHECK (balance_fils >= 0)
 *
 * A wallet that can go negative is credit, and AVO does not extend credit. The
 * charge handler also checks the balance and returns a 402 with the exact
 * shortfall — but that check is a *user experience*, not the guarantee. The
 * guarantee is here, where a race between two scanners, a retried job, or a
 * future handler nobody has written yet still cannot produce a negative wallet.
 */

import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { fils } from '@avo/types';
import { filsColumn, timestamptz } from './_shared';
import { salon, tierName } from './salon';

/**
 * The kinds of consent this table records. One today; accepting a new policy
 * version is the same shape of fact and is the expected second.
 */
export type ConsentKind = 'marketing_offers';

/** Which surface the customer gave or withdrew it on. */
export type ConsentSource = 'signup' | 'wallet_account' | 'support' | 'import';

export const member = pgTable(
  'member',
  {
    id: text('id').primaryKey(),
    salonId: text('salon_id')
      .notNull()
      .references(() => salon.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    /** E.164. Also the login identity — api-contract.md § Profile edit, rule 1. */
    phone: text('phone').notNull(),
    email: text('email'),
    emailVerified: boolean('email_verified').notNull().default(false),

    /**
     * argon2id. Non-negotiable #6: never plaintext, never returned by an
     * endpoint, never rendered. Reset is link-only.
     */
    passwordHash: text('password_hash').notNull(),

    /** Non-negotiable #2: the server owns this number. Clients only ever read it. */
    balanceFils: filsColumn('balance_fils').notNull().default(fils(0)),

    visits: integer('visits').notNull().default(0),
    tier: tierName('tier'),
    /** null when the salon runs tiers. */
    stamps: integer('stamps'),

    /** Non-negotiable #10: the published legal version accepted at signup. */
    policyVersion: integer('policy_version').notNull(),

    /**
     * THE FOUR NOTIFICATION PREFERENCES. `offers` is NOT among them — see
     * `memberConsentEvent` below, and migration 0020.
     *
     * `wa` and `receipt` are the load-bearing pair. Both are sent by the
     * SERVER, so a switch the client held locally did not stop a receipt and
     * told the customer it had. Stored on the row the sender reads.
     *
     * Default true: these are how she is told about her own money and her own
     * appointments, and each has an explicit switch.
     */
    notifyPush: boolean('notify_push').notNull().default(true),
    notifyRemind: boolean('notify_remind').notNull().default(true),
    notifyWa: boolean('notify_wa').notNull().default(true),
    notifyReceipt: boolean('notify_receipt').notNull().default(true),

    /**
     * ACCOUNT DELETION — a state with a clock, not a ticket. Migration 0021
     * carries the full reasoning; the short form is that the published privacy
     * policy names two retention periods over one customer ("transaction
     * records are kept for 7 years" / "the rest of your account data is deleted
     * within 30 days"), so deletion is an erasure of personal data that leaves
     * the money record standing, and the 30-day promise cannot depend on a
     * support rota nobody has agreed to staff.
     *
     * The window is also a GRACE period: sessions are not revoked and sign-in
     * keeps working, because she has to be able to change her mind.
     *
     * The erasure job itself is NOT built. Which columns are nulled at the due
     * date and which survive the 7 years is a retention decision that belongs
     * to the client (CLAUDE.md § Open decisions), and it is escalated.
     */
    deletionRequestedAt: timestamptz('deletion_requested_at'),
    deletionDueAt: timestamptz('deletion_due_at'),

    joinedAt: timestamptz('joined_at').notNull().defaultNow(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    // Phone is the login identity, so it is unique per salon — the same person
    // can hold a wallet at two salons.
    uniqueIndex('member_salon_phone_uq').on(t.salonId, t.phone),
    index('member_salon_idx').on(t.salonId),

    // ---------------------------------------------------------------------
    // THE constraint. Nothing in the application is trusted to hold this.
    // ---------------------------------------------------------------------
    check('member_balance_non_negative', sql`${t.balanceFils} >= 0`),

    check('member_phone_is_e164', sql`${t.phone} ~ '^\\+[1-9][0-9]{6,14}$'`),
    check('member_visits_non_negative', sql`${t.visits} >= 0`),
    check('member_stamps_non_negative', sql`${t.stamps} IS NULL OR ${t.stamps} >= 0`),
    check('member_policy_version_positive', sql`${t.policyVersion} > 0`),
    // Both or neither: a due date with no request, or a request with no due
    // date, is a row the erasure job can neither act on nor report.
    check(
      'member_deletion_is_whole',
      sql`(${t.deletionRequestedAt} IS NULL) = (${t.deletionDueAt} IS NULL)`,
    ),
    check(
      'member_deletion_due_after_request',
      sql`${t.deletionDueAt} IS NULL OR ${t.deletionDueAt} > ${t.deletionRequestedAt}`,
    ),
  ],
);

/**
 * MARKETING CONSENT, AS AN EVENT — not a fifth notification boolean.
 *
 * Non-negotiable #8 needs this readable on the platform send path, where "caps
 * and quiet hours are enforced again at send time". A boolean answers "may we
 * send" and nothing else. It cannot answer what a cap and an audit actually
 * have to answer when a regulator or a customer asks why a campaign arrived:
 * when she agreed, under which version of the terms, from which surface, and
 * whether she had withdrawn it before. A boolean flipped twice is
 * indistinguishable from one never touched.
 *
 * So: append-only events, current state is the latest row, and `granted: false`
 * is a WITHDRAWAL — a fact in its own right, not the absence of a grant.
 * `UPDATE` and `DELETE` are revoked from the application role in migration
 * 0020, the same treatment `audit_log` gets, because a consent trail the
 * application can rewrite is not evidence and this table exists to be evidence.
 */
export const memberConsentEvent = pgTable(
  'member_consent_event',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    memberId: text('member_id')
      .notNull()
      .references(() => member.id, { onDelete: 'cascade' }),
    salonId: text('salon_id')
      .notNull()
      .references(() => salon.id, { onDelete: 'restrict' }),
    /**
     * One kind today. A column rather than a table name because the next one is
     * already visible: accepting a NEW policy version (non-negotiable #10) is
     * the same shape of fact.
     */
    kind: text('kind').$type<ConsentKind>().notNull(),
    granted: boolean('granted').notNull(),
    /** Where it happened. A cap needs to know she chose it, not inherited it. */
    source: text('source').$type<ConsentSource>().notNull(),
    /** Which terms were in force. The policy is republishable. */
    policyVersion: integer('policy_version').notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('member_consent_member_kind_idx').on(t.memberId, t.kind, t.createdAt.desc()),
    check('member_consent_kind_is_known', sql`${t.kind} IN ('marketing_offers')`),
    check(
      'member_consent_source_is_known',
      sql`${t.source} IN ('signup', 'wallet_account', 'support', 'import')`,
    ),
  ],
);
