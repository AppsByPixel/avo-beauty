/**
 * Authentication. Three sign-ins, one refresh, one password change.
 *
 *   POST /auth/member/session   phone + password   → wallet scope
 *   POST /staff/session         4-digit PIN        → scanner scope   (staff.ts calls in)
 *   POST /auth/web/session      username + password → dashboard scope
 *   POST /auth/refresh          rotate
 *   POST /auth/sign-out         revoke this device
 *   POST /members/me/password   change + revoke every OTHER session
 *
 * WHY THE PIN IS NOT JUST A SHORT PASSWORD
 * ----------------------------------------
 * api-contract.md § StaffUser: "Staff scanner authenticates by 4-digit PIN
 * scoped to a device+salon. PIN is not a password: rate-limit it, lock after N
 * failures, and never let it reach dashboard scopes."
 *
 * Four digits is 10,000 possibilities, which is nothing. What makes it safe is
 * the three controls around it, and all three are enforced in `staffPinSession`:
 * the PIN only works from the device it was bound to, attempts are rate-limited
 * per device (so an attacker cannot rotate targets to dodge the per-account
 * counter), and the account locks after N failures. The scope on the session is
 * the fourth: a PIN mints `scanner`, and `requireDashboardScope` refuses it.
 *
 * ENUMERATION
 * -----------
 * Every failure path answers with the same body and burns the same argon2 time,
 * whether the account exists or not. "Wrong password" and "no such phone number"
 * being distinguishable turns a login form into a customer-list oracle.
 */

import { and, eq, gte, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { db } from '../db/client';
import { member } from '../db/schema/member';
import { pinAttempt, session } from '../db/schema/session';
import { staffUser } from '../db/schema/staff';
import { env } from '../env';
import {
  burnVerifyTime,
  hashSecret,
  isAcceptablePassword,
  isFourDigitPin,
  verifySecret,
} from '../auth/password';
import { permsOf, requirePrincipal } from '../auth/principal';
import { issueSession, revokeOtherSessions, revokeSession, rotateSession } from '../auth/sessions';
import { badRequest, forbidden, tooManyRequests, unauthorized } from '../http/errors';
import { requireString } from '../money/validate';
import { writeAudit } from '../services/audit';
import { serialiseStaff } from './staff';

/** One body for every credential failure. Never says which half was wrong. */
const BAD_CREDENTIALS = () => unauthorized('Those details do not match. Try again.', 'invalid_credentials');

function clientMeta(req: FastifyRequest) {
  return {
    ipAddress: req.ip ?? null,
    userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
  };
}

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  // ------------------------------------------------------------ member sign-in --
  app.post('/auth/member/session', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    /**
     * The salon is part of the identity, not a convenience.
     *
     * `member_salon_phone_uq` is on (salon_id, phone), because api-contract.md
     * § Branch means one wallet per salon and the schema comment spells it out:
     * "the same person can hold a wallet at two salons". So a phone number does
     * NOT identify a member — looking one up by phone alone returns an arbitrary
     * row among the salons she belongs to, which is both a wrong-wallet bug and,
     * if the hashes differ, a way to authenticate against the wrong record.
     *
     * Each salon ships its own white-labelled wallet, so the client always knows
     * which salon it is.
     */
    const salonId = requireString(body.salonId, 'salonId', 100);
    const phone = requireString(body.phone, 'phone', 20);
    const password = typeof body.password === 'string' ? body.password : '';

    const rows = await db
      .select()
      .from(member)
      .where(and(eq(member.salonId, salonId), eq(member.phone, phone)))
      .limit(1);
    const m = rows[0];

    if (!m) {
      // Same cost as a real verify, so the timing does not reveal the miss.
      await burnVerifyTime(password);
      throw BAD_CREDENTIALS();
    }
    if (!(await verifySecret(m.passwordHash, password))) throw BAD_CREDENTIALS();

    const issued = await issueSession(db, {
      principalKind: 'member',
      memberId: m.id,
      salonId: m.salonId,
      scope: 'wallet',
      deviceId: typeof body.deviceId === 'string' ? body.deviceId : null,
      ...clientMeta(req),
    });

    return reply.send({
      accessToken: issued.accessToken,
      refreshToken: issued.refreshToken,
      expiresAt: issued.expiresAt.toISOString(),
      member: serialiseMember(m),
    });
  });

  // --------------------------------------------------------------- web sign-in --
  /**
   * Merchant dashboard. Username + password, and it mints `dashboard` scope —
   * the only way to reach a dashboard endpoint.
   */
  app.post('/auth/web/session', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    /**
     * Salon-scoped for the same reason as the member sign-in above:
     * `staff_user_salon_handle_uq` is on (salon_id, handle), so "noura" is not a
     * unique person. In deployment this comes from the per-salon subdomain the
     * dashboard is served on rather than from a field the user types.
     */
    const salonId = requireString(body.salonId, 'salonId', 100);
    const username = requireString(body.username, 'username', 100).toLowerCase();
    const password = typeof body.password === 'string' ? body.password : '';

    const rows = await db
      .select()
      .from(staffUser)
      .where(and(eq(staffUser.salonId, salonId), eq(staffUser.handle, username)))
      .limit(1);
    const staff = rows[0];

    if (!staff || !staff.passwordHash) {
      await burnVerifyTime(password);
      throw BAD_CREDENTIALS();
    }
    if (!(await verifySecret(staff.passwordHash, password))) throw BAD_CREDENTIALS();

    const issued = await issueSession(db, {
      principalKind: 'staff',
      staffId: staff.id,
      salonId: staff.salonId,
      scope: 'dashboard',
      deviceId: typeof body.deviceId === 'string' ? body.deviceId : null,
      ...clientMeta(req),
    });

    await writeAudit(db, null, {
      salonId: staff.salonId,
      kind: 'access',
      action: 'Web sign-in',
      detail: `${staff.name} signed in to the dashboard`,
      source: 'merchant',
      subjectType: 'staff_user',
      subjectId: staff.id,
      ...clientMeta(req),
    });

    return reply.send({
      accessToken: issued.accessToken,
      refreshToken: issued.refreshToken,
      expiresAt: issued.expiresAt.toISOString(),
      staff: serialiseStaff(staff),
    });
  });

  // ------------------------------------------------------------------ refresh --
  app.post('/auth/refresh', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const raw = requireString(body.refreshToken, 'refreshToken', 500);

    const rotated = await rotateSession(db, raw);
    // Null covers all of: unknown, already rotated, revoked, expired. A replayed
    // refresh token is indistinguishable from a stolen one, so it just fails.
    if (!rotated) throw unauthorized('That session has ended. Sign in again.', 'session_ended');

    return reply.send({
      accessToken: rotated.accessToken,
      refreshToken: rotated.refreshToken,
      expiresAt: rotated.expiresAt.toISOString(),
    });
  });

  // ----------------------------------------------------------------- sign-out --
  app.post('/auth/sign-out', async (req, reply) => {
    const p = requirePrincipal(req);
    await revokeSession(db, p.sessionId, 'sign_out');
    return reply.code(204).send();
  });

  // ---------------------------------------------------------- password change --
  /**
   * api-contract.md § Profile edit rule 4: requires `current`, minimum length 6,
   * rejects `next === current`, and "revokes every other session while keeping
   * the calling device signed in".
   */
  app.post('/members/me/password', async (req, reply) => {
    const p = requirePrincipal(req);
    if (p.kind !== 'member') throw forbidden('This endpoint is for customers.');

    const body = (req.body ?? {}) as Record<string, unknown>;
    const current = typeof body.current === 'string' ? body.current : '';
    const next = body.next;

    if (!isAcceptablePassword(next)) {
      throw badRequest('password_too_short', 'Your new password needs at least 6 characters.');
    }
    if (next === current) {
      throw badRequest('password_unchanged', 'Your new password must be different.');
    }

    const rows = await db.select().from(member).where(eq(member.id, p.id)).limit(1);
    const m = rows[0];
    if (!m) throw unauthorized();

    // "Forgot my current password" is the reset-link flow, not a bypass of this.
    if (!(await verifySecret(m.passwordHash, current))) {
      throw unauthorized('That password does not match.', 'invalid_credentials');
    }

    const passwordHash = await hashSecret(next);
    await db
      .update(member)
      .set({ passwordHash, updatedAt: new Date() })
      .where(eq(member.id, m.id));

    // The security half — every other device drops. The caller stays signed in,
    // which is why this is a per-row revoke and not a watermark on the account.
    const revoked = await revokeOtherSessions(
      db,
      { kind: 'member', id: m.id },
      p.sessionId,
      'password_change',
    );

    await writeAudit(db, p, {
      salonId: m.salonId,
      kind: 'access',
      action: 'Password changed',
      detail: `${revoked} other session(s) signed out`,
      source: 'wallet',
      subjectType: 'member',
      subjectId: m.id,
      metadata: { revokedSessions: revoked },
      ...clientMeta(req),
    });

    // Never returns a password field, and 204 means there is no body to leak one in.
    return reply.code(204).send();
  });
}

// ----------------------------------------------------------------- PIN session --

/**
 * The staff PIN sign-in. Exported because `POST /staff/session` lives in
 * staff.ts, but the credential logic belongs next to the other credentials.
 *
 * Order of checks is deliberate: device rate limit, then account lockout, then
 * the PIN itself. The cheap global checks come first so a flood cannot make the
 * expensive argon2 path the denial-of-service.
 */
export async function staffPinSession(req: FastifyRequest): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  staff: ReturnType<typeof serialiseStaff>;
}> {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const salonId = requireString(body.salonId, 'salonId', 100);
  const deviceId = requireString(body.deviceId, 'deviceId', 200);
  const handle = requireString(body.handle, 'handle', 100).toLowerCase();
  const pin = body.pin;

  if (!isFourDigitPin(pin)) {
    throw badRequest('invalid_pin_format', 'A PIN is four digits.');
  }

  // ------------------------------------------------- 1. device rate limit --
  // Per device+salon, whoever is being targeted. Without this an attacker walks
  // the PIN space by rotating handles, and every individual account counter
  // stays comfortably below its lockout threshold.
  const windowStart = new Date(Date.now() - env.pinDeviceWindowMinutes * 60_000);
  const recent = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(pinAttempt)
    .where(
      and(
        eq(pinAttempt.salonId, salonId),
        eq(pinAttempt.deviceId, deviceId),
        eq(pinAttempt.succeeded, false),
        gte(pinAttempt.createdAt, windowStart),
      ),
    );

  if ((recent[0]?.n ?? 0) >= env.pinDeviceAttemptsPerWindow) {
    throw tooManyRequests(
      'too_many_attempts',
      'Too many attempts from this device. Wait a few minutes and try again.',
    );
  }

  const rows = await db
    .select()
    .from(staffUser)
    .where(and(eq(staffUser.salonId, salonId), eq(staffUser.handle, handle)))
    .limit(1);
  const staff = rows[0];

  const recordAttempt = async (staffId: string | null, succeeded: boolean) => {
    await db.insert(pinAttempt).values({ salonId, deviceId, staffId, succeeded });
  };

  if (!staff) {
    await recordAttempt(null, false);
    await burnVerifyTime(String(pin));
    throw BAD_CREDENTIALS();
  }

  // --------------------------------------------------- 2. account lockout --
  if (staff.pinLockedUntil && staff.pinLockedUntil.getTime() > Date.now()) {
    await recordAttempt(staff.id, false);
    throw tooManyRequests(
      'pin_locked',
      'This PIN is locked. A manager can unlock it, or try again later.',
    );
  }

  // ------------------------------------------------- 3. device scoping ----
  // The PIN is bound to a device. api-contract.md calls it "scoped to a
  // device+salon", and the schema CHECK refuses a pin_hash without a device id.
  if (!staff.pinHash || !staff.pinDeviceId) {
    await recordAttempt(staff.id, false);
    await burnVerifyTime(String(pin));
    throw BAD_CREDENTIALS();
  }
  if (staff.pinDeviceId !== deviceId) {
    await recordAttempt(staff.id, false);
    await burnVerifyTime(String(pin));
    // Deliberately the same refusal — "right PIN, wrong device" would confirm
    // the PIN to someone holding a stolen tablet.
    throw BAD_CREDENTIALS();
  }

  // ----------------------------------------------------- 4. the PIN itself --
  if (!(await verifySecret(staff.pinHash, pin))) {
    const attempts = staff.pinFailedAttempts + 1;
    const locked = attempts >= env.pinMaxAttempts;

    await db
      .update(staffUser)
      .set({
        pinFailedAttempts: attempts,
        pinLockedUntil: locked ? new Date(Date.now() + env.pinLockoutMinutes * 60_000) : null,
        updatedAt: new Date(),
      })
      .where(eq(staffUser.id, staff.id));
    await recordAttempt(staff.id, false);

    if (locked) {
      await writeAudit(db, null, {
        salonId,
        kind: 'risk',
        action: 'PIN locked',
        detail: `${staff.name}'s PIN locked after ${attempts} failed attempts`,
        source: 'scanner',
        subjectType: 'staff_user',
        subjectId: staff.id,
        metadata: { deviceId, attempts },
      });
      throw tooManyRequests(
        'pin_locked',
        'This PIN is locked. A manager can unlock it, or try again later.',
      );
    }
    throw BAD_CREDENTIALS();
  }

  // Success clears the counter.
  await db
    .update(staffUser)
    .set({ pinFailedAttempts: 0, pinLockedUntil: null, updatedAt: new Date() })
    .where(eq(staffUser.id, staff.id));
  await recordAttempt(staff.id, true);

  // `scanner` scope, never `dashboard`. This is the line that makes "never let
  // it reach dashboard scopes" a property of the credential.
  const issued = await issueSession(db, {
    principalKind: 'staff',
    staffId: staff.id,
    salonId: staff.salonId,
    scope: 'scanner',
    deviceId,
    ...clientMeta(req),
  });

  return {
    accessToken: issued.accessToken,
    refreshToken: issued.refreshToken,
    expiresAt: issued.expiresAt.toISOString(),
    staff: serialiseStaff(staff),
  };
}

// --------------------------------------------------------------- serialisers --

/**
 * The wire shape of a member. Explicitly typed rather than inferred, so that
 * `passwordHash` cannot reappear by accident: adding a column to the table would
 * silently widen an inferred return type, and this is the serialiser that stands
 * between the password column and the network (non-negotiable #6).
 */
export interface MemberView {
  id: string;
  salonId: string;
  name: string;
  phone: string;
  email: string | null;
  emailVerified: boolean;
  balanceFils: number;
  visits: number;
  tier: 'bronze' | 'silver' | 'gold' | 'black' | null;
  stamps: number | null;
  policyVersion: number;
  joinedAt: string;
}

export function serialiseMember(m: typeof member.$inferSelect): MemberView {
  return {
    id: m.id,
    salonId: m.salonId,
    name: m.name,
    phone: m.phone,
    email: m.email,
    emailVerified: m.emailVerified,
    balanceFils: m.balanceFils,
    visits: m.visits,
    tier: m.tier,
    stamps: m.stamps,
    policyVersion: m.policyVersion,
    joinedAt: m.joinedAt.toISOString(),
  };
}

export { permsOf, session };
