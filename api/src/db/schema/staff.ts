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
import { boolean, check, index, integer, pgEnum, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
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

    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('staff_user_salon_handle_uq').on(t.salonId, t.handle),
    index('staff_user_salon_idx').on(t.salonId),
    index('staff_user_pin_device_idx').on(t.salonId, t.pinDeviceId),

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
  ],
);
