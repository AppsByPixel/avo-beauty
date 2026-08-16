/**
 * Session — one row per signed-in device, and the only thing that makes a
 * refresh token revocable.
 *
 * The access token is a short-lived JWT and is deliberately NOT stored: it is
 * verified by signature, expires in minutes, and carries no permissions (see
 * auth/principal.ts — perms are read from the database on every request, so a
 * revoked `charges` takes effect on the next call rather than at the next token
 * refresh).
 *
 * The refresh token is the opposite: long-lived, so it must be revocable, so it
 * is opaque and stored as a sha256. `revoked_at` is what
 * `POST /members/me/password` sets on every OTHER session — api-contract.md
 * § Profile edit rule 4: "revokes every other session while keeping the calling
 * device signed in". Keeping the caller signed in is why revocation is per-row
 * and not a `tokens_valid_after` stamp on the member.
 *
 * `scope` is the surface the session may reach. A staff PIN session is minted
 * with scope `scanner`, and non-negotiable #6 / api-contract.md § StaffUser say
 * a PIN must "never reach dashboard scopes" — that is enforced by the scope on
 * this row, not by which endpoints the scanner app happens to call.
 */

import { sql } from 'drizzle-orm';
import { boolean, check, index, pgEnum, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { timestamptz } from './_shared';
import { member } from './member';
import { salon } from './salon';
import { staffUser } from './staff';

export const principalKind = pgEnum('principal_kind', ['member', 'staff']);

/**
 * `scanner` is the PIN surface: scan and charge, nothing else.
 * `dashboard` is the merchant web surface, reached only by username + password.
 * `wallet` is the customer app.
 */
export const sessionScope = pgEnum('session_scope', ['wallet', 'scanner', 'dashboard']);

export const session = pgTable(
  'session',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    principalKind: principalKind('principal_kind').notNull(),
    /** Exactly one of these is set — see the CHECK below. */
    memberId: text('member_id').references(() => member.id, { onDelete: 'cascade' }),
    staffId: text('staff_id').references(() => staffUser.id, { onDelete: 'cascade' }),
    /** Denormalised so a session can be scoped to a salon without a join. */
    salonId: text('salon_id')
      .notNull()
      .references(() => salon.id, { onDelete: 'restrict' }),

    scope: sessionScope('scope').notNull(),

    /** sha256 of the opaque refresh token. The raw value is returned once. */
    refreshTokenHash: text('refresh_token_hash').notNull(),

    /**
     * The device this session belongs to. A staff PIN is scoped to device+salon,
     * so the device is part of the credential, not telemetry.
     */
    deviceId: text('device_id'),
    userAgent: text('user_agent'),
    ipAddress: text('ip_address'),

    createdAt: timestamptz('created_at').notNull().defaultNow(),
    lastUsedAt: timestamptz('last_used_at').notNull().defaultNow(),
    expiresAt: timestamptz('expires_at').notNull(),
    revokedAt: timestamptz('revoked_at'),
    /** 'password_change', 'sign_out', 'pin_lockout' — read in the audit log. */
    revokedReason: text('revoked_reason'),
  },
  (t) => [
    uniqueIndex('session_refresh_hash_uq').on(t.refreshTokenHash),
    index('session_member_idx').on(t.memberId).where(sql`revoked_at IS NULL`),
    index('session_staff_idx').on(t.staffId).where(sql`revoked_at IS NULL`),
    index('session_expires_idx').on(t.expiresAt),

    // A session belongs to exactly one principal. Both set, or neither, is a
    // session that two different people could be holding.
    check(
      'session_exactly_one_principal',
      sql`(${t.principalKind} = 'member' AND ${t.memberId} IS NOT NULL AND ${t.staffId} IS NULL)
          OR (${t.principalKind} = 'staff' AND ${t.staffId} IS NOT NULL AND ${t.memberId} IS NULL)`,
    ),
    // A PIN session is device-scoped by definition. A scanner session without a
    // device id is a bearer credential anyone can replay from anywhere.
    check(
      'session_scanner_is_device_scoped',
      sql`${t.scope} <> 'scanner' OR ${t.deviceId} IS NOT NULL`,
    ),
    // Members hold wallet sessions; staff hold scanner or dashboard sessions.
    check(
      'session_scope_matches_principal',
      sql`(${t.principalKind} = 'member' AND ${t.scope} = 'wallet')
          OR (${t.principalKind} = 'staff' AND ${t.scope} IN ('scanner', 'dashboard'))`,
    ),
    check('session_revoked_has_reason', sql`${t.revokedAt} IS NULL OR ${t.revokedReason} IS NOT NULL`),
    check('session_expires_after_creation', sql`${t.expiresAt} > ${t.createdAt}`),
  ],
);

/**
 * Failed PIN attempts, for rate limiting per device rather than per account.
 *
 * `staff_user.pin_failed_attempts` holds the lockout counter for the account.
 * This table is the other half: it makes "N attempts from this device in the
 * last minute" answerable, so an attacker cannot walk the four-digit space by
 * rotating which staff id they guess against.
 */
export const pinAttempt = pgTable(
  'pin_attempt',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    salonId: text('salon_id')
      .notNull()
      .references(() => salon.id, { onDelete: 'restrict' }),
    deviceId: text('device_id').notNull(),
    /** Null when the handle did not resolve — we still count the attempt. */
    staffId: text('staff_id').references(() => staffUser.id, { onDelete: 'cascade' }),
    succeeded: boolean('succeeded').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [index('pin_attempt_device_idx').on(t.salonId, t.deviceId, t.createdAt.desc())],
);
