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
import { platformAdmin } from './platformAdmin';
import { salon } from './salon';
import { staffUser } from './staff';

/**
 * `platform_admin` is the owner console, added in migration 0028. It is the one
 * principal with NO salon — see `salonId` below.
 */
export const principalKind = pgEnum('principal_kind', ['member', 'staff', 'platform_admin']);

/**
 * `scanner` is the PIN surface: scan and charge, nothing else.
 * `dashboard` is the merchant web surface, reached only by username + password.
 * `wallet` is the customer app.
 * `platform` is the owner console — above every salon, and scoped to none.
 */
export const sessionScope = pgEnum('session_scope', [
  'wallet',
  'scanner',
  'dashboard',
  'platform',
]);

export const session = pgTable(
  'session',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    principalKind: principalKind('principal_kind').notNull(),
    /** Exactly one of these is set — see the CHECK below. */
    memberId: text('member_id').references(() => member.id, { onDelete: 'cascade' }),
    staffId: text('staff_id').references(() => staffUser.id, { onDelete: 'cascade' }),
    platformAdminId: text('platform_admin_id').references(() => platformAdmin.id, {
      onDelete: 'cascade',
    }),
    /**
     * Denormalised so a session can be scoped to a salon without a join.
     *
     * NULLABLE SINCE 0028, AND ONLY FOR THE PLATFORM PRINCIPAL. Every other
     * principal is salon-scoped and `requireSameSalon` is the tenancy boundary; a
     * platform admin reads across salons by design, and one carrying a salon id
     * would be a merchant with extra authority. `session_salon_matches_principal`
     * is an EQUIVALENCE, so a NULL salon on a merchant session — which would slip
     * past `requireSameSalon` by having nothing to compare — is refused too.
     */
    salonId: text('salon_id').references(() => salon.id, { onDelete: 'restrict' }),

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
    index('session_platform_admin_idx').on(t.platformAdminId).where(sql`revoked_at IS NULL`),
    index('session_expires_idx').on(t.expiresAt),

    // A session belongs to exactly one principal. Both set, or neither, is a
    // session that two different people could be holding.
    check(
      'session_exactly_one_principal',
      sql`(${t.principalKind}::text = 'member' AND ${t.memberId} IS NOT NULL
             AND ${t.staffId} IS NULL AND ${t.platformAdminId} IS NULL)
          OR (${t.principalKind}::text = 'staff' AND ${t.staffId} IS NOT NULL
             AND ${t.memberId} IS NULL AND ${t.platformAdminId} IS NULL)
          OR (${t.principalKind}::text = 'platform_admin' AND ${t.platformAdminId} IS NOT NULL
             AND ${t.memberId} IS NULL AND ${t.staffId} IS NULL)`,
    ),
    // A PIN session is device-scoped by definition. A scanner session without a
    // device id is a bearer credential anyone can replay from anywhere.
    check(
      'session_scanner_is_device_scoped',
      sql`${t.scope} <> 'scanner' OR ${t.deviceId} IS NOT NULL`,
    ),
    /**
     * Members hold wallet sessions; staff hold scanner or dashboard; a platform
     * admin holds `platform` and nothing else. A platform admin with a
     * `dashboard` session would reach every merchant route through
     * `requireDashboardPerm`, which reads `staff_user` — a table she has no row in.
     *
     * `::text` ON BOTH SIDES, and it is not cosmetic: migration 0028 adds the two
     * enum values and rewrites these constraints in one transaction, and Postgres
     * refuses to USE a new enum value in the transaction that added it. The cast
     * is the same constraint in a form that transaction may evaluate, and the
     * drizzle schema has to match the SQL or `drizzle-kit generate` will propose
     * undoing it.
     */
    check(
      'session_scope_matches_principal',
      sql`(${t.principalKind}::text = 'member' AND ${t.scope}::text = 'wallet')
          OR (${t.principalKind}::text = 'staff' AND ${t.scope}::text IN ('scanner', 'dashboard'))
          OR (${t.principalKind}::text = 'platform_admin' AND ${t.scope}::text = 'platform')`,
    ),
    /** The tenancy half of the platform principal. See `salonId` above. */
    check(
      'session_salon_matches_principal',
      sql`(${t.principalKind}::text = 'platform_admin') = (${t.salonId} IS NULL)`,
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

/**
 * Signup attempts, for bounding an unauthenticated argon2 endpoint.
 *
 * `POST /auth/member/signup` hashes a password with argon2id, which is expensive
 * on purpose, and had no rate limit — its own header said so and escalated it.
 * Half of what it escalated was a product decision and half was not: the
 * enumeration oracle in `already_registered` needs a verification step at signup
 * and stays escalated; an unbounded expensive endpoint does not, and this is what
 * bounds it.
 *
 * SIBLING OF `pin_attempt`, ON PURPOSE — same shape, same reason. That table
 * exists so "N attempts from this device in the last minute" is answerable
 * independently of any account's own counter. This one exists so "N attempts from
 * this caller in the last five minutes" is answerable when there is no account
 * yet to count against.
 *
 * NO PHONE NUMBER COLUMN. The limit is keyed on the caller, so the phone is not
 * needed to enforce it, and a retained list of numbers that TRIED to register is a
 * list of people who do not have accounts here — a worse privacy artefact than the
 * oracle this deliberately does not close.
 *
 * AND NO `succeeded` COLUMN, unlike its sibling. `pin_attempt` knows its outcome
 * when it inserts; this row must be written BEFORE the argon2 hash or a burst of
 * simultaneous requests all read a count of zero and all pay for one. Recording
 * the outcome would need an UPDATE, which migration 0026 revokes so the counter
 * cannot be reset. So this table is a COUNTER, not a record — which of them
 * succeeded is already in `audit_log`, one "Member signed up" row per success.
 *
 * Migration 0026 carries the rest, including why `salon_id` has no foreign key.
 */
export const signupAttempt = pgTable(
  'signup_attempt',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * NOT a reference. An attempt naming a salon that does not exist is exactly
     * the traffic worth counting, and a foreign key would make that insert fail
     * before the count happened — turning the cheapest probe into the one request
     * that skips the limiter.
     */
    salonId: text('salon_id').notNull(),
    /**
     * Null when Fastify cannot attribute the request. Still counted, and every
     * such caller shares this one bucket — being unattributable is not a way past
     * the limit.
     */
    ipAddress: text('ip_address'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('signup_attempt_ip_idx').on(t.ipAddress, t.createdAt.desc()),
    index('signup_attempt_salon_idx').on(t.salonId, t.createdAt.desc()),
  ],
);

/**
 * The till's budget — one row per attempt at `POST /scans`, `POST /charges` or
 * `POST /voids`.
 *
 * THIRD SIBLING OF `pin_attempt` AND `signup_attempt`, and the family resemblance
 * is the argument. `pin_attempt` exists so "N attempts from this device in the
 * last minute" is answerable independently of any account's own counter;
 * `signup_attempt` exists so the same question is answerable when there is no
 * account yet. This one exists because the three endpoints that read a customer's
 * card or move her money had no budget at all, and nothing that already existed
 * could count them: `transaction` gets a row only when a charge SUCCEEDS, and a
 * flood of refusals is the traffic worth bounding; `audit_log` is merchant-facing
 * and `POST /scans` writes to it not at all; `pin_attempt` counts only FAILED
 * sign-ins and so is silent about everything after one.
 *
 * KEYED ON (salon_id, device_id) — the same pair `pin_attempt_device_idx` indexes,
 * and NEVER on `req.ip`. A salon is one NAT, so an address-keyed budget is a
 * salon-wide budget the busiest till spends on behalf of the others; and
 * `app.ts` runs with `trustProxy` OFF until `TRUST_PROXY` names the real proxy, so
 * `req.ip` behind a balancer is the balancer. The device is not telemetry on this
 * surface — a staff PIN is scoped to device+salon, and
 * `session_scanner_is_device_scoped` refuses a scanner session without one.
 *
 * NO `succeeded` COLUMN, exactly as `signup_attempt` has none and for the same
 * mechanical reason: the row is written BEFORE the work, or a burst of
 * simultaneous requests all read a count of zero and all proceed. Migration 0038
 * revokes the UPDATE that would let the outcome be filled in afterwards, and
 * carries the rest — including why the key is the till and not the staff member.
 */
export const scannerAttempt = pgTable(
  'scanner_attempt',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    salonId: text('salon_id')
      .notNull()
      .references(() => salon.id, { onDelete: 'restrict' }),
    /**
     * Null only where the server cannot attribute a device — in production
     * unreachable, since every principal that reaches these endpoints holds a
     * device-scoped `scanner` session. Counted rather than exempted when it does
     * happen, and the whole class shares one bucket: `signup_attempt.ip_address`
     * takes the same position for the same reason.
     */
    deviceId: text('device_id'),
    /** 'scan' | 'charge' | 'void'. A CHECK, not an enum — migration 0038 says why. */
    action: text('action').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('scanner_attempt_device_idx').on(t.salonId, t.deviceId, t.createdAt.desc()),
    check('scanner_attempt_action_known', sql`${t.action} IN ('scan', 'charge', 'void')`),
  ],
);

/**
 * The password sign-in budget — one row per attempt at `POST /auth/member/session`,
 * `POST /auth/web/session` or `POST /auth/platform/session`.
 *
 * FOURTH SIBLING OF `pin_attempt`, `signup_attempt` AND `scanner_attempt`, and the
 * gap it fills is the one the family made easy to miss. `pin_attempt` bounds the
 * four-digit PIN; `signup_attempt` bounds an unauthenticated argon2 endpoint;
 * `scanner_attempt` bounds the till. The three PASSWORD front doors — the wallet,
 * the dashboard and the owner console — were bounded by nothing at all, and none
 * of the existing tables could stand in: `pin_attempt` is keyed on a device that
 * only the scanner has, `signup_attempt` on the address (see below), and
 * `audit_log` gets a sign-in row only when one SUCCEEDS, which is silent about
 * exactly the traffic worth counting.
 *
 * KEYED ON THE CLAIMED IDENTITY, NOT ON THE ACCOUNT AND NOT ON `req.ip`.
 *
 *   NOT THE ACCOUNT, because the limiter must behave identically whether the
 *   account exists or not. This file's route header — routes/auth.ts § ENUMERATION
 *   — is built on every failure path being indistinguishable; a limiter that
 *   engaged only for real accounts would rebuild that oracle with a louder signal
 *   than the timing channel `burnVerifyTime` exists to remove. The key is computed
 *   from the request's own fields before any table is read, so the limiter never
 *   learns whether there is an account behind them.
 *
 *   NOT `req.ip`, which 0038 argued for the till and which is stronger here: a
 *   salon is one NAT, so an address-keyed sign-in budget refuses the fourth
 *   customer on the salon's wifi, and with `trustProxy` OFF (`app.ts`, until
 *   `TRUST_PROXY` names the real proxy) every caller behind a load balancer shares
 *   one bucket — a platform-wide sign-in outage. An attacker rotates addresses; a
 *   customer cannot.
 *
 * A ROLLING WINDOW, NOT A LATCH, and nothing is written to the account row. There
 * is deliberately no `sign_in_locked_until` beside `staff_user.pin_locked_until`:
 * a PIN lock is fine when a manager is standing in the salon, and nobody is
 * standing next to Dana's phone. A latch anyone could set by guessing five times
 * would make a customer wallet lockable at will by a stranger who knows a phone
 * number. Migration 0039 has the full argument.
 *
 * NO `succeeded` COLUMN, for `signup_attempt`'s and `scanner_attempt`'s mechanical
 * reason: the row is written BEFORE the lookup and before argon2, or a burst all
 * reads a count of zero and all pays for a hash. 0039 revokes the UPDATE that
 * would let the outcome be filled in afterwards.
 */
export const signInAttempt = pgTable(
  'sign_in_attempt',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** 'member' | 'web' | 'platform'. A CHECK, not an enum — migration 0039 says why. */
    surface: text('surface').notNull(),
    /**
     * HMAC-SHA256 over `surface | salon | identifier`, keyed with the deployment's
     * `JWT_SECRET`. NEVER the phone number or the handle in the clear: this column
     * is a list of identities somebody TRIED, which includes people who hold no
     * account here, and a Kuwaiti mobile is eight digits behind a fixed prefix — a
     * plain digest of one is a lookup table away from the number.
     * services/signInLimit.ts carries the construction.
     */
    identityKey: text('identity_key').notNull(),
    /**
     * In the clear (a salon id is not personal) and NOT a reference, for
     * `signup_attempt.salonId`'s reason: an attempt naming a salon that does not
     * exist is exactly the traffic worth counting, and a foreign key would make
     * that insert fail before the count happened. NULL for the owner console,
     * which has no salon by design.
     */
    salonId: text('salon_id'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('sign_in_attempt_identity_idx').on(t.identityKey, t.createdAt.desc()),
    index('sign_in_attempt_salon_idx').on(t.salonId, t.createdAt.desc()),
    check('sign_in_attempt_surface_known', sql`${t.surface} IN ('member', 'web', 'platform')`),
  ],
);
