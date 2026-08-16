/**
 * Staff routes — and `PATCH /staff/{id}`, which Lane D named the
 * privilege-escalation route because it is the endpoint that SETS `perms`.
 *
 * It did not exist. Everything else in the permission system is downstream of
 * it: an endpoint that grants authority, with no authority check of its own, is
 * not a gap in the model, it IS the model, inverted. So this file gets the most
 * careful handling in the API:
 *
 *   - `perms.team` is required, checked before anything is read or written;
 *   - the target must be in the caller's salon;
 *   - `void` implies `charges`, both directions (see below);
 *   - every grant and every revoke writes an audit row naming who changed what,
 *     from what, to what;
 *   - `pin`, `pinHash` and `passwordHash` are not settable here and never
 *     serialised out.
 *
 * THE `void` / `charges` DEPENDENCY
 * ---------------------------------
 * api-contract.md § StaffUser: "void is meaningless without charges". That has
 * two directions and the contract only states one:
 *
 *   - granting `void` while `charges` is false is REJECTED with a 400. The
 *     database CHECK would refuse it anyway; catching it here means the client
 *     gets a sentence instead of a constraint-violation 500.
 *   - revoking `charges` REVOKES `void` with it, silently and in the same
 *     update. Leaving `void` set on a member who can no longer see charges is
 *     the state the CHECK exists to forbid, and a manager revoking `charges`
 *     plainly means to remove the senior authority, not half of it.
 */

import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { db } from '../db/client';
import { member } from '../db/schema/member';
import { service } from '../db/schema/service';
import { staffUser } from '../db/schema/staff';
import {
  PERMISSION_NAMES,
  permsOf,
  requireDashboardPerm,
  requirePerm,
  requireStaff,
  type PermissionName,
} from '../auth/principal';
import { revokeAllSessions } from '../auth/sessions';
import { badRequest, notFound } from '../http/errors';
import { peekToken } from '../services/walletToken';
import { writeAudit } from '../services/audit';
import { serialiseMember, staffPinSession } from './auth';

/**
 * The wire shape of a staff member.
 *
 * `pinSet` is a boolean; `pinHash` and `passwordHash` never appear. Lane D
 * asserts on exactly this — "never returns a PIN, a PIN hash or a password".
 */
export function serialiseStaff(row: typeof staffUser.$inferSelect) {
  return {
    id: row.id,
    salonId: row.salonId,
    name: row.name,
    handle: row.handle,
    role: row.role,
    branchAccess: row.branchAccessAll ? ('all' as const) : row.branchAccessIds,
    pinSet: row.pinHash !== null,
    perms: permsOf(row),
  };
}

const PERM_COLUMN = {
  dashboard: 'permDashboard',
  appointments: 'permAppointments',
  shop: 'permShop',
  loyalty: 'permLoyalty',
  team: 'permTeam',
  scanner: 'permScanner',
  charges: 'permCharges',
  void: 'permVoid',
  marketing: 'permMarketing',
} as const satisfies Record<PermissionName, keyof typeof staffUser.$inferSelect>;

export async function registerStaffRoutes(app: FastifyInstance): Promise<void> {
  // -------------------------------------------------------------- PIN sign-in --
  app.post('/staff/session', async (req, reply) => reply.send(await staffPinSession(req)));

  // ------------------------------------------------------------------ own row --
  /**
   * No permission gate: this is how a scanner learns what it may do, so gating
   * it on a permission would be circular. Authentication is the gate.
   */
  app.get('/staff/me', async (req, reply) => {
    const p = requireStaff(req);
    const rows = await db.select().from(staffUser).where(eq(staffUser.id, p.id)).limit(1);
    const row = rows[0];
    if (!row) throw notFound('unknown_staff', 'No such staff member.');
    return reply.send(serialiseStaff(row));
  });

  // --------------------------------------------------------------- the roster --
  /** perms.team — the roster is who works here and what they may do. */
  app.get('/staff', async (req, reply) => {
    const p = requireDashboardPerm(req, 'team');
    const rows = await db.select().from(staffUser).where(eq(staffUser.salonId, p.salonId));
    return reply.send({ items: rows.map(serialiseStaff), nextCursor: null });
  });

  // ------------------------------------------------------- set staff authority --
  /**
   * api-contract.md § Operations: "Merchant | Set staff authority |
   * PATCH /staff/{id} { perms }".
   */
  app.patch<{ Params: { id: string } }>('/staff/:id', async (req, reply) => {
    // FIRST STATEMENT. Before the target is read, before the body is parsed.
    const p = requireDashboardPerm(req, 'team');

    const rows = await db
      .select()
      .from(staffUser)
      .where(and(eq(staffUser.id, req.params.id), eq(staffUser.salonId, p.salonId)))
      .limit(1);
    const target = rows[0];
    // Same 404 for "not here" and "not yours" — the roster of another salon is
    // not something this caller gets to probe.
    if (!target) throw notFound('unknown_staff', 'No such staff member.');

    const body = (req.body ?? {}) as Record<string, unknown>;

    // A credential is never set through the authority endpoint.
    for (const banned of ['pin', 'pinHash', 'password', 'passwordHash']) {
      if (banned in body) {
        throw badRequest(
          'not_settable_here',
          'Credentials are not set through this endpoint. Send a reset link instead.',
        );
      }
    }

    const incoming = body.perms;
    if (incoming === undefined || incoming === null || typeof incoming !== 'object') {
      throw badRequest('invalid_request', 'perms is required.');
    }

    const before = permsOf(target);
    const requested = incoming as Record<string, unknown>;

    // Only the nine. An unknown key is a client that thinks it can invent
    // authority, and silently dropping it hides that.
    for (const key of Object.keys(requested)) {
      if (!(PERMISSION_NAMES as readonly string[]).includes(key)) {
        throw badRequest('unknown_permission', `Unknown permission: ${key}.`);
      }
    }

    const next: Record<PermissionName, boolean> = { ...before };
    for (const name of PERMISSION_NAMES) {
      if (name in requested) {
        const v = requested[name];
        if (typeof v !== 'boolean') {
          throw badRequest('invalid_permission_value', `perms.${name} must be true or false.`);
        }
        next[name] = v;
      }
    }

    // --- the dependency, both directions -----------------------------------
    // Revoking `charges` takes `void` with it, unless the caller explicitly
    // asked for void in the same breath (which the next check then rejects).
    if (before.charges && !next.charges && !('void' in requested)) {
      next.void = false;
    }
    if (next.void && !next.charges) {
      throw badRequest(
        'void_requires_charges',
        'Void is meaningless without charges. Grant charges first, or leave void off.',
      );
    }

    const changed = PERMISSION_NAMES.filter((n) => before[n] !== next[n]);

    if (changed.length > 0) {
      await db
        .update(staffUser)
        .set({
          ...Object.fromEntries(PERMISSION_NAMES.map((n) => [PERM_COLUMN[n], next[n]])),
          updatedAt: new Date(),
        })
        .where(eq(staffUser.id, target.id));

      // Every grant and every revoke, named. `kind: 'access'` is the dashboard's
      // Access filter — design/README.md § Merchant dashboard.
      await writeAudit(db, p, {
        salonId: p.salonId,
        kind: 'access',
        action: 'Permissions changed',
        detail:
          `${target.name}: ` +
          changed.map((n) => `${n} ${before[n] ? 'on→off' : 'off→on'}`).join(', '),
        source: 'merchant',
        subjectType: 'staff_user',
        subjectId: target.id,
        metadata: {
          before,
          after: next,
          changed,
          grants: changed.filter((n) => next[n]),
          revokes: changed.filter((n) => !next[n]),
        },
        ipAddress: req.ip ?? null,
        userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
      });

      // Losing scanner authority should not leave a live scanner session behind.
      if (before.scanner && !next.scanner) {
        await revokeAllSessions(db, { kind: 'staff', id: target.id }, 'permissions_changed');
      }
    }

    const updated = await db.select().from(staffUser).where(eq(staffUser.id, target.id)).limit(1);
    return reply.send(serialiseStaff(updated[0]!));
  });

  // ---------------------------------------------------------------- resolve QR --
  /**
   * `POST /scans` resolves a QR to the member card the scanner shows.
   *
   * perms.scanner is checked BEFORE the token is looked up. Lane D's probe reads
   * "410 means the token was resolved before authority was checked" — answering
   * a 410 to an unauthorised caller has already told them whether that code
   * exists.
   *
   * It does NOT consume the token. Consumption happens at the charge, so a
   * scanner re-reading the code before the artist confirms does not burn it.
   */
  app.post('/scans', async (req, reply) => {
    const p = requirePerm(req, 'scanner');

    const body = (req.body ?? {}) as Record<string, unknown>;
    const token = typeof body.token === 'string' ? body.token.trim() : '';
    if (!token) throw badRequest('invalid_request', 'token is required.');

    const peeked = await peekToken(db, token);

    const rows = await db.select().from(member).where(eq(member.id, peeked.memberId)).limit(1);
    const m = rows[0];
    if (!m) throw notFound('unknown_member', 'No such member.');

    const services = await db
      .select({ id: service.id, name: service.name, priceFils: service.priceFils })
      .from(service)
      .where(and(eq(service.salonId, p.salonId), eq(service.active, true)));

    return reply.send({
      member: serialiseMember(m),
      // Bookings are not built, so nothing is ever held today.
      heldDepositFils: 0,
      services,
    });
  });
}
