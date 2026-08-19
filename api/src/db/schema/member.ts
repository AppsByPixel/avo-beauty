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
  bigserial,
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
 * The kinds of consent this table records.
 *
 * `policy_acceptance` is the second, added in migration 0025, and 0020 named it
 * before it existed: "the next one is already visible: non-negotiable #10's
 * acceptance of a NEW policy version is the same shape of fact". It is what
 * turns #10's *store the accepted version against the member* into an event, and
 * what makes "has she accepted the version published NOW" a query rather than a
 * flag — which is #10's second half, the re-prompt.
 */
export type ConsentKind = 'marketing_offers' | 'policy_acceptance';

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
    /**
     * MONOTONIC WRITE ORDER, and the reason it exists is a measured defect.
     *
     * `services/consent.ts` derives the standing answer as `ORDER BY created_at
     * DESC LIMIT 1`, and `created_at` defaults to `now()` — the TRANSACTION
     * timestamp, identical for every row written in one transaction.
     * `recordConsent` takes an executor precisely so a caller can record consent
     * inside the transaction that created the account, so a tie is reachable.
     *
     * With a grant and a withdrawal tied, the GRANT won: eight consecutive runs
     * returned `granted = true` for a member whose newest event said false. Silent,
     * in the permissive direction, in the table whose whole purpose is to be the
     * record a regulator is shown.
     *
     * `id` could not settle it — a random uuid settles a tie by coin flip and does
     * it reproducibly, which looks fixed and is not. `ledger_entry.seq` is the
     * precedent and its comment is the reason in full: "the audit read order,
     * independent of clock skew". Migration 0029.
     */
    seq: bigserial('seq', { mode: 'number' }).notNull(),
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
    check(
      'member_consent_kind_is_known',
      sql`${t.kind} IN ('marketing_offers', 'policy_acceptance')`,
    ),
    check(
      'member_consent_source_is_known',
      sql`${t.source} IN ('signup', 'wallet_account', 'support', 'import')`,
    ),
    /**
     * A POLICY ACCEPTANCE IS NEVER A WITHDRAWAL — migration 0025.
     *
     * 0020's rule is that `granted = false` is a withdrawal rather than the
     * absence of a grant. Marketing has such a fact; policy acceptance does not.
     * The product's answer to "I no longer agree" is account deletion (0021),
     * not a row here, so a `granted = false` acceptance would be a false
     * statement in a table that exists to be evidence.
     */
    check(
      'member_consent_acceptance_is_never_withdrawn',
      sql`${t.kind} <> 'policy_acceptance' OR ${t.granted} = true`,
    ),
    /**
     * "She accepted v4" is ONE fact however many times the button is tapped, and
     * the re-prompt screen is where a double tap happens. Partial, because
     * marketing consent going off-on-off over a year is three real facts.
     */
    uniqueIndex('member_consent_acceptance_once_per_version')
      .on(t.memberId, t.policyVersion)
      .where(sql`${t.kind} = 'policy_acceptance'`),
  ],
);

/**
 * The customer's own password-reset outbox — migration 0034.
 *
 * THE DEFECT IT CLOSES: api-contract.md § Profile edit rule 5 promises that
 * "Forgot my current password" drops into the existing WhatsApp reset-link flow,
 * and the wallet draws the control — but only staff and platform flows existed.
 * A customer who forgot her password had a button that led nowhere, against the
 * wallet that holds her money.
 *
 * THE THIRD RESET TABLE, NOT A WIDENED SECOND — 0034's header carries the full
 * argument (three principals, three tables, each ageing on its own terms), plus
 * why the requester column is an IP rather than a name (self-service has no
 * authenticated requester; inventing "self" would dress a claim up as a fact)
 * and why there is deliberately NO salon_id (nobody salon-scoped may touch a
 * customer's reset — a merchant who could would hold an account-takeover path).
 *
 * ONLY THE SHA256 IS STORED, as in both sibling tables. The token exists in the
 * message the customer receives and nowhere else; no endpoint returns it.
 */
export const memberPasswordReset = pgTable(
  'member_password_reset',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    memberId: text('member_id')
      .notNull()
      .references(() => member.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    /** Which connection asked. Null when unattributable — counted, not exempt. */
    requestedIp: text('requested_ip'),
    expiresAt: timestamptz('expires_at').notNull(),
    /**
     * The outbox stamp, EXPECTED TO STAY NULL: no sender is wired, for the same
     * client-blocked reasons `staff_password_reset.sent_at` and
     * `platform_admin_password_reset.sent_at` record.
     */
    sentAt: timestamptz('sent_at'),
    usedAt: timestamptz('used_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('member_password_reset_token_uq').on(t.tokenHash),
    index('member_password_reset_live_idx').on(t.memberId).where(sql`used_at IS NULL`),
    check('member_password_reset_expires_after_creation', sql`${t.expiresAt} > ${t.createdAt}`),
  ],
);

/**
 * The limiter's counter for the UNAUTHENTICATED issue endpoint — 0026's
 * `signup_attempt`, repeated for the same endpoint shape and for the same
 * reasons its header gives. It cannot ride on `member_password_reset` itself:
 * rows there exist only for phones that MATCHED, so a sweep of unknown numbers
 * would never be throttled by its own artefacts.
 */
export const memberPasswordResetAttempt = pgTable(
  'member_password_reset_attempt',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ipAddress: text('ip_address'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [index('member_password_reset_attempt_ip_idx').on(t.ipAddress, t.createdAt.desc())],
);
