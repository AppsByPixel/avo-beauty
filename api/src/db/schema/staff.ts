/**
 * StaffUser — api-contract.md § StaffUser.
 *
 * `perms` is nine booleans rather than one jsonb blob. Non-negotiable #7 says
 * permissions are enforced server-side and every gated endpoint gets a test that
 * calls it with the permission off; columns make that a `WHERE perm_charges`
 * rather than a JSON path, and they let the database hold the one dependency the
 * contract states outright — "void is meaningless without charges".
 *
 * The PIN is not a password. It is four digits, scoped to a device AND a salon,
 * rate limited, and locked after N failures (`pin_locked_until`). It never
 * reaches dashboard scopes.
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
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { timestamptz } from './_shared';
import { salon } from './salon';

export const staffRole = pgEnum('staff_role', [
  'owner',
  'manager',
  'frontdesk',
  'artist',
  'scanner',
]);

export const staffUser = pgTable(
  'staff_user',
  {
    id: text('id').primaryKey(),
    salonId: text('salon_id')
      .notNull()
      .references(() => salon.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    handle: text('handle').notNull(),
    /**
     * Her own mobile, E.164 — a SIGN-IN NAME beside `handle`, on the scanner
     * (`POST /staff/session` with `phone`) and the dashboard
     * (`POST /auth/web/session` with the number as `username`), and the
     * identifier `POST /staff/pair` takes with the six digits. Aftab, 2026-11-10
     * (DECISIONS.md § Staff phone pairing); migration 0073.
     *
     * Unique per salon AMONG ACTIVE STAFF (`staff_user_salon_active_phone_uq`),
     * not across leavers the way the handle is: a number is a SIM, and the next
     * hire may hold a leaver's. Null until a manager enters it.
     */
    phone: text('phone'),
    role: staffRole('role').notNull(),

    /**
     * "all" | branchId[] from the contract, split so the database can hold it.
     * `branch_access_all` true means every branch, present and future; the id
     * list must then be empty, or the two representations could disagree.
     */
    branchAccessAll: boolean('branch_access_all').notNull().default(false),
    branchAccessIds: text('branch_access_ids')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),

    /** argon2id. Web sign-in (dashboard / owner console). Null = no web login. */
    passwordHash: text('password_hash'),

    /** argon2id over the 4-digit PIN. Null = no PIN set; the API exposes only `pinSet`. */
    pinHash: text('pin_hash'),
    /** The device the PIN is bound to. A PIN without a device is not device-scoped. */
    pinDeviceId: text('pin_device_id'),
    pinFailedAttempts: integer('pin_failed_attempts').notNull().default(0),
    pinLockedUntil: timestamptz('pin_locked_until'),

    permDashboard: boolean('perm_dashboard').notNull().default(false),
    permAppointments: boolean('perm_appointments').notNull().default(false),
    permShop: boolean('perm_shop').notNull().default(false),
    permLoyalty: boolean('perm_loyalty').notNull().default(false),
    permTeam: boolean('perm_team').notNull().default(false),
    /** Can scan & charge. */
    permScanner: boolean('perm_scanner').notNull().default(false),
    /** Can open Today's charges on the scanner. Senior permission. */
    permCharges: boolean('perm_charges').notNull().default(false),
    /** Can reverse a charge within 15 minutes. */
    permVoid: boolean('perm_void').notNull().default(false),
    /** Can submit a campaign for AVO approval. Cannot send it — non-negotiable #8. */
    permMarketing: boolean('perm_marketing').notNull().default(false),

    /**
     * A LEAVER, not a deleted row. NULL means active.
     *
     * `transaction.created_by_staff_id`, `wallet_token.consumed_by_staff_id`
     * and `artist.staff_user_id` all reference this table, and `audit_log`
     * names the actor by id. The row is what makes a two-year-old charge still
     * say who took it, so leaving removes the CREDENTIALS — `password_hash`
     * and `pin_hash` are nulled and every session revoked — and keeps the
     * identity. Re-hiring is a reset link against the same row.
     */
    deactivatedAt: timestamptz('deactivated_at'),

    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('staff_user_salon_handle_uq').on(t.salonId, t.handle),
    index('staff_user_salon_idx').on(t.salonId),
    index('staff_user_pin_device_idx').on(t.salonId, t.pinDeviceId),
    // Migration 0073. The phone is a sign-in name, so two ACTIVE accounts at one
    // salon cannot share it; a leaver's number is free for the next hire.
    uniqueIndex('staff_user_salon_active_phone_uq')
      .on(t.salonId, t.phone)
      .where(sql`deactivated_at IS NULL`),
    // `POST /staff/pair` by mobile number carries no salon, so it looks the
    // number up across salons; the unique index above leads with `salon_id`.
    index('staff_user_active_phone_idx')
      .on(t.phone)
      .where(sql`deactivated_at IS NULL AND phone IS NOT NULL`),
    // The target of `staff_pairing_code`'s composite foreign keys (0073).
    uniqueIndex('staff_user_id_salon_uq').on(t.id, t.salonId),
    // Byte-identical to `member_phone_is_e164` and `http/fields.ts § E164`.
    check('staff_user_phone_is_e164', sql`${t.phone} ~ '^\\+[1-9][0-9]{6,14}$'`),

    // "void implies charges" — api-contract.md § StaffUser. A dashboard toggle
    // that grants void without charges is a UI bug the database refuses to store.
    check('staff_user_void_implies_charges', sql`NOT ${t.permVoid} OR ${t.permCharges}`),
    check(
      'staff_user_branch_access_exclusive',
      sql`NOT ${t.branchAccessAll} OR cardinality(${t.branchAccessIds}) = 0`,
    ),
    // A PIN is only a PIN if it is bound to a device.
    check(
      'staff_user_pin_is_device_scoped',
      sql`(${t.pinHash} IS NULL) = (${t.pinDeviceId} IS NULL)`,
    ),
    check('staff_user_pin_attempts_non_negative', sql`${t.pinFailedAttempts} >= 0`),
    // A leaver keeps nothing she can sign in with. The handler nulls both; this
    // is the invariant the handler is an implementation of.
    check(
      'staff_user_deactivated_holds_no_credential',
      sql`${t.deactivatedAt} IS NULL OR (${t.passwordHash} IS NULL AND ${t.pinHash} IS NULL)`,
    ),
  ],
);

/**
 * A password reset, as a LINK. Non-negotiable #6: "Owner console only ever
 * sends a reset link."
 *
 * The sha256 of the token, never the token — the same treatment
 * `session.refresh_token_hash` and `wallet_token.token_hash` get. The issuing
 * endpoint answers 202 with no token in the body, because a reset that comes
 * back through the manager's browser is a credential travelling through the
 * wrong pair of hands, which is the thing the non-negotiable is about.
 *
 * This is an OUTBOX. `sentAt` is where a sender stamps itself; none is wired,
 * for the reason receipts/types.ts sets out — unapproved WhatsApp templates and
 * an undecided sending domain, both client decisions, neither waiting on code.
 */
export const staffPasswordReset = pgTable(
  'staff_password_reset',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    staffId: text('staff_id')
      .notNull()
      .references(() => staffUser.id, { onDelete: 'cascade' }),
    salonId: text('salon_id')
      .notNull()
      .references(() => salon.id, { onDelete: 'restrict' }),
    tokenHash: text('token_hash').notNull(),
    /** Who asked. A reset is an access event; the row carries the fact too. */
    requestedBy: text('requested_by').notNull(),
    expiresAt: timestamptz('expires_at').notNull(),
    sentAt: timestamptz('sent_at'),
    usedAt: timestamptz('used_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('staff_password_reset_token_uq').on(t.tokenHash),
    index('staff_password_reset_live_idx').on(t.staffId).where(sql`used_at IS NULL`),
    check('staff_password_reset_expires_after_creation', sql`${t.expiresAt} > ${t.createdAt}`),
  ],
);

/**
 * A PAIRING CODE — the single-use door between a manager's Accounts screen and
 * a staff member's own phone. Aftab, 2026-11-10 (DECISIONS.md § Staff phone
 * pairing); migration 0073 carries the full argument.
 *
 * A manager with `perms.team` issues one (`POST /staff/{id}/pairing-code`); the
 * phone redeems it once (`POST /staff/pair`) by scanning the QR — the token — or
 * by typing the staff member's mobile number and the six digits; the staff
 * member chooses her own PIN ON THE PHONE; the server issues the device id.
 * Non-negotiable #6: the PIN never passes through the dashboard and never sits
 * in a QR.
 *
 * HASHES ONLY. `tokenHash` is sha256 (256 bits of CSPRNG need no stretching);
 * `codeHash` is argon2id through `hashSecret`, because six digits are a million
 * preimages and a fast digest of one is a laptop-second from the code.
 *
 * ENDS ONCE: `usedAt` (redeemed) or `voidedAt` (superseded by a newer code, or
 * burned by five wrong digits — `failedAttempts`). The tenancy is composite
 * foreign keys in the migration — `(staff_id, salon_id)`, `(created_by,
 * salon_id)` and `(branch_id, salon_id)` — which Drizzle cannot express, so they
 * are not restated as `.references()` here, `device_enrolment`'s convention.
 */
export const staffPairingCode = pgTable(
  'staff_pairing_code',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    salonId: text('salon_id')
      .notNull()
      .references(() => salon.id, { onDelete: 'restrict' }),
    staffId: text('staff_id').notNull(),
    tokenHash: text('token_hash').notNull(),
    codeHash: text('code_hash').notNull(),
    /** The till's branch, if the code also enrols the phone. NULL: pair only. */
    branchId: text('branch_id'),
    expiresAt: timestamptz('expires_at').notNull(),
    usedAt: timestamptz('used_at'),
    voidedAt: timestamptz('voided_at'),
    failedAttempts: integer('failed_attempts').notNull().default(0),
    /** The staff member whose `perms.team` issued it. */
    createdBy: text('created_by').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('staff_pairing_code_token_uq').on(t.tokenHash),
    uniqueIndex('staff_pairing_code_live_uq')
      .on(t.staffId)
      .where(sql`used_at IS NULL AND voided_at IS NULL`),
    index('staff_pairing_code_salon_created_idx').on(t.salonId, t.createdAt.desc()),
    check('staff_pairing_code_token_hash_is_sha256', sql`${t.tokenHash} ~ '^[0-9a-f]{64}$'`),
    check('staff_pairing_code_code_hash_is_argon2id', sql`${t.codeHash} LIKE '$argon2id$%'`),
    check('staff_pairing_code_expires_after_creation', sql`${t.expiresAt} > ${t.createdAt}`),
    check('staff_pairing_code_attempts_non_negative', sql`${t.failedAttempts} >= 0`),
    check('staff_pairing_code_spent_once', sql`${t.usedAt} IS NULL OR ${t.voidedAt} IS NULL`),
  ],
);
