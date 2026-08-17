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

import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { db } from '../db/client';
import { member } from '../db/schema/member';
import { branch, salon } from '../db/schema/salon';
import { service } from '../db/schema/service';
import { staffPasswordReset, staffUser } from '../db/schema/staff';
import {
  PERMISSION_NAMES,
  permsOf,
  requireDashboardPerm,
  requireScannerPerm,
  requireStaff,
  type PermissionName,
  type StaffPerms,
} from '../auth/principal';
import { revokeAllSessions } from '../auth/sessions';
import {
  hashPasswordResetToken as hashResetToken,
  mintPasswordResetToken as mintResetToken,
} from '../auth/tokens';
import { badRequest, conflict, notFound } from '../http/errors';
import { requireString } from '../money/validate';
import { peekToken } from '../services/walletToken';
import { writeAudit } from '../services/audit';
import { findApplicableHold } from '../services/booking';
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
    /**
     * Whether she can sign in on the web at all. `pinSet` already says the same
     * thing about the scanner, and the Accounts screen has to distinguish "no
     * web login by design" — an artist who only ever uses the tablet — from "her
     * password needs resetting". Both are false; only one is a problem.
     *
     * A boolean, never the hash and never a length. Non-negotiable #6.
     */
    passwordSet: row.passwordHash !== null,
    /** A leaver. See `deactivatedAt` in db/schema/staff.ts. */
    active: row.deactivatedAt === null,
    deactivatedAt: row.deactivatedAt?.toISOString() ?? null,
    perms: permsOf(row),
  };
}

/** api-contract.md § StaffUser. The five roles the enum holds. */
const ROLES = ['owner', 'manager', 'frontdesk', 'artist', 'scanner'] as const;
type Role = (typeof ROLES)[number];

/** How long a reset link is good for. Short: it is a credential in transit. */
const RESET_TTL_MINUTES = 60;

function staffId(): string {
  return `ST-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

/**
 * `branchAccess` on the wire is `'all' | string[]`; in the database it is a
 * boolean and an array, kept mutually exclusive by
 * `staff_user_branch_access_exclusive`.
 *
 * Ids are checked against the salon's OPEN branches. A closed branch would be
 * access to somewhere that takes no money, and a branch of another salon is a
 * tenancy bug however it got into the body — refused by name either way, since
 * the caller already knows this salon's branch list.
 */
async function parseBranchAccess(
  value: unknown,
  salonId: string,
): Promise<{ branchAccessAll: boolean; branchAccessIds: string[] }> {
  if (value === 'all') return { branchAccessAll: true, branchAccessIds: [] };

  if (!Array.isArray(value)) {
    throw badRequest(
      'invalid_branch_access',
      'branchAccess must be "all" or an array of branch ids.',
    );
  }

  const ids = [...new Set(value)];
  for (const id of ids) {
    if (typeof id !== 'string' || id.trim() === '') {
      throw badRequest('invalid_branch_access', 'branchAccess ids must be non-empty strings.');
    }
  }

  if (ids.length > 0) {
    const open = await db
      .select({ id: branch.id })
      .from(branch)
      .where(and(eq(branch.salonId, salonId), isNull(branch.closedAt)));
    const known = new Set(open.map((b) => b.id));
    const unknown = (ids as string[]).filter((id) => !known.has(id));
    if (unknown.length > 0) {
      throw badRequest(
        'invalid_branch_access',
        `Not an open branch of this salon: ${unknown.join(', ')}.`,
      );
    }
  }

  // An EMPTY array is allowed and means "no branch". It is a real state — a
  // branch close produces it — and refusing to express it here would leave the
  // only route to it being a side effect of something else.
  return { branchAccessAll: false, branchAccessIds: ids as string[] };
}

function parseRole(value: unknown): Role {
  if (typeof value !== 'string' || !(ROLES as readonly string[]).includes(value)) {
    throw badRequest('invalid_role', `role must be one of ${ROLES.join(', ')}.`);
  }
  return value as Role;
}

/**
 * A credential is never set through a staff endpoint. Checked on every body
 * that reaches this file, not just the authority one, because "create the
 * account with this password" is the same defect as "change it to this
 * password" and arrives at a different URL.
 */
function refuseCredentialFields(body: Record<string, unknown>): void {
  for (const banned of ['pin', 'pinHash', 'password', 'passwordHash']) {
    if (banned in body) {
      throw badRequest(
        'not_settable_here',
        'Credentials are not set through this endpoint. Send a reset link instead.',
      );
    }
  }
}

/**
 * Nine falses. What a new account holds until somebody grants something.
 *
 * Built from `PERMISSION_NAMES` rather than written out, so a tenth permission
 * cannot be added to the contract and silently default to `undefined` here.
 */
const EMPTY_PERMS: StaffPerms = Object.fromEntries(
  PERMISSION_NAMES.map((n) => [n, false]),
) as unknown as StaffPerms;

/**
 * Validate a `perms` object and merge it onto a base.
 *
 * Shared by create and edit so the two doors into the permission columns
 * cannot drift — the same lesson `parseLoyaltyConfig` records for the tier
 * ladder, where an unvalidated second entrance made the validation decorative.
 *
 * An unknown key is REFUSED rather than dropped: a client that thinks it can
 * invent authority needs to be told, and silently ignoring it hides that.
 * `undefined` means "not mentioned", which is why the base is a parameter.
 */
function parsePerms(incoming: unknown, base: StaffPerms): StaffPerms {
  if (incoming === undefined) return { ...base };
  if (incoming === null || typeof incoming !== 'object' || Array.isArray(incoming)) {
    throw badRequest('invalid_request', 'perms must be an object of the nine permissions.');
  }

  const requested = incoming as Record<string, unknown>;
  for (const key of Object.keys(requested)) {
    if (!(PERMISSION_NAMES as readonly string[]).includes(key)) {
      throw badRequest('unknown_permission', `Unknown permission: ${key}.`);
    }
  }

  const next: StaffPerms = { ...base };
  for (const name of PERMISSION_NAMES) {
    if (name in requested) {
      const v = requested[name];
      if (typeof v !== 'boolean') {
        throw badRequest('invalid_permission_value', `perms.${name} must be true or false.`);
      }
      next[name] = v;
    }
  }
  return next;
}

/**
 * `perms.team` IS THE PERMISSION THAT GRANTS PERMISSIONS. Removing the last
 * active holder locks the salon out of its own Accounts screen, with no way
 * back that does not involve an engineer — which is the phase-4 criterion
 * ("configure a salon without an engineer") inverted by a single click.
 *
 * Same shape as the last-open-branch rule in salons.ts: refused with a sentence
 * naming the way out, rather than discovered afterwards.
 *
 * THE REACHABLE PATH IS THE PATCH, NOT THE DELETE, and it is worth writing down
 * which is which. Both callers are gated on `perms.team`, so on `DELETE` the
 * caller is herself an active holder and cannot be the target (self-removal is
 * refused before this) — the count can never reach zero there, and the call is
 * defence in depth against a future caller that is neither. On `PATCH` it is a
 * live hazard with no such protection: a manager who is the only holder can
 * revoke her OWN `team` chip, and nothing else in the system would stop her.
 */
async function refuseLastTeamAdminRemoval(salonId: string, targetId: string): Promise<void> {
  const [remaining] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(staffUser)
    .where(
      and(
        eq(staffUser.salonId, salonId),
        eq(staffUser.permTeam, true),
        isNull(staffUser.deactivatedAt),
        ne(staffUser.id, targetId),
      ),
    );
  if ((remaining?.n ?? 0) === 0) {
    throw conflict(
      'last_team_admin',
      'This is the only account that can manage the team. Give someone else Team authority first, or the salon locks itself out of its own Accounts screen.',
    );
  }
}

/** api-contract.md § StaffUser: "void is meaningless without charges". */
function refuseVoidWithoutCharges(perms: StaffPerms): void {
  if (perms.void && !perms.charges) {
    throw badRequest(
      'void_requires_charges',
      'Void is meaningless without charges. Grant charges first, or leave void off.',
    );
  }
}

/** The two audit columns every handler in this file fills the same way. */
function clientMeta(req: FastifyRequest): { ipAddress: string | null; userAgent: string | null } {
  return {
    ipAddress: req.ip ?? null,
    userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
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
   *
   * `'either'` and not `'scanner'`, written out rather than defaulted. Both
   * surfaces need to know who is signed in and what they may do — the scanner
   * to draw its locked screens, the dashboard to draw its own shell — and the
   * response carries no money and no other staff member's row. This is the one
   * staff endpoint in the API that is genuinely surface-agnostic.
   */
  app.get('/staff/me', async (req, reply) => {
    const p = requireStaff(req, 'either');
    const rows = await db.select().from(staffUser).where(eq(staffUser.id, p.id)).limit(1);
    const row = rows[0];
    if (!row) throw notFound('unknown_staff', 'No such staff member.');
    return reply.send(serialiseStaff(row));
  });

  // --------------------------------------------------------------- the roster --
  /**
   * perms.team — the roster is who works here and what they may do.
   *
   * DEACTIVATED ROWS ARE LISTED, flagged `active: false`, rather than hidden.
   * `staff_user_salon_handle_uq` spans them, so a manager re-hiring somebody
   * would otherwise be told the handle is taken by a row she cannot see. The
   * screen filters; the API does not decide that for it.
   */
  app.get('/staff', async (req, reply) => {
    const p = requireDashboardPerm(req, 'team');
    const rows = await db
      .select()
      .from(staffUser)
      .where(eq(staffUser.salonId, p.salonId))
      .orderBy(staffUser.id);
    return reply.send({ items: rows.map(serialiseStaff), nextCursor: null });
  });

  // -------------------------------------------------------------- hire ---
  /**
   * perms.team. A salon hires somebody.
   *
   * THE ACCOUNT IS CREATED WITH NO CREDENTIAL. `password_hash` and `pin_hash`
   * are both null, and a `password` or `pin` in the body is refused by name.
   * Non-negotiable #6 has no carve-out for creation: an endpoint that accepts a
   * password on the way in is a plaintext password in a request log, a
   * browser's memory and somebody's clipboard, and "we only do it at
   * onboarding" is how it stays for ever.
   *
   * Access is established the one way the non-negotiable allows — a reset link,
   * from `POST /staff/{id}/password-reset` below. The response says
   * `passwordSet: false` so the dashboard can show the new row as "invite
   * pending" rather than looking broken.
   */
  app.post('/staff', async (req, reply) => {
    const p = requireDashboardPerm(req, 'team');

    const body = (req.body ?? {}) as Record<string, unknown>;
    refuseCredentialFields(body);

    const allowed = new Set(['name', 'handle', 'role', 'perms', 'branchAccess']);
    const rejected = Object.keys(body).filter((k) => !allowed.has(k));
    if (rejected.length > 0) {
      throw badRequest(
        'not_settable_here',
        `These fields cannot be set on a staff account: ${rejected.join(', ')}.`,
      );
    }

    const name = requireString(body.name, 'name', 120);
    // Lower-cased at the door, the way `staffPinSession` lower-cases the handle
    // it looks up. Two rows differing only in case would be one login.
    const handle = requireString(body.handle, 'handle', 60).toLowerCase().replace(/^@/, '');
    if (!/^[a-z0-9._-]+$/.test(handle)) {
      throw badRequest(
        'invalid_handle',
        'A handle is letters, numbers, dots, dashes and underscores — no spaces.',
      );
    }
    const role = parseRole(body.role);

    // Default: no branch. The same safe direction the branch close takes — a new
    // account reaches nothing until somebody says what it may reach.
    const access =
      'branchAccess' in body
        ? await parseBranchAccess(body.branchAccess, p.salonId)
        : { branchAccessAll: false, branchAccessIds: [] as string[] };

    const perms = parsePerms(body.perms, EMPTY_PERMS);
    refuseVoidWithoutCharges(perms);

    const clash = await db
      .select({ id: staffUser.id, deactivatedAt: staffUser.deactivatedAt })
      .from(staffUser)
      .where(and(eq(staffUser.salonId, p.salonId), eq(staffUser.handle, handle)))
      .limit(1);
    if (clash[0]) {
      throw conflict(
        'handle_taken',
        clash[0].deactivatedAt
          ? `@${handle} belonged to someone who has left. Re-activate that account with a reset link instead, so their history stays on one identity.`
          : `@${handle} is already someone else at this salon.`,
      );
    }

    const id = staffId();
    const [row] = await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(staffUser)
        .values({
          id,
          salonId: p.salonId,
          name,
          handle,
          role,
          ...access,
          ...Object.fromEntries(PERMISSION_NAMES.map((n) => [PERM_COLUMN[n], perms[n]])),
        })
        .returning();

      await writeAudit(tx, p, {
        salonId: p.salonId,
        kind: 'access',
        action: 'Staff account created',
        detail:
          `${name} (@${handle}), ${role}` +
          ` · ${PERMISSION_NAMES.filter((n) => perms[n]).join(', ') || 'no permissions'}`,
        source: 'merchant',
        subjectType: 'staff_user',
        subjectId: id,
        metadata: { name, handle, role, perms, branchAccess: body.branchAccess ?? [] },
        ...clientMeta(req),
      });
      return inserted;
    });

    if (!row) throw conflict('staff_not_created', 'That staff account could not be created.');
    return reply.code(201).send(serialiseStaff(row));
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
    refuseCredentialFields(body);

    const allowed = new Set(['perms', 'role', 'branchAccess']);
    const rejected = Object.keys(body).filter((k) => !allowed.has(k));
    if (rejected.length > 0) {
      throw badRequest(
        'not_settable_here',
        `These fields cannot be edited on a staff account: ${rejected.join(', ')}.`,
      );
    }
    if (!('perms' in body) && !('role' in body) && !('branchAccess' in body)) {
      throw badRequest('invalid_request', 'Send perms, role or branchAccess.');
    }

    const before = permsOf(target);
    const requested = (body.perms ?? {}) as Record<string, unknown>;
    const next = parsePerms(body.perms, before);

    // --- the dependency, both directions -----------------------------------
    // Revoking `charges` takes `void` with it, unless the caller explicitly
    // asked for void in the same breath (which the next check then rejects).
    if (before.charges && !next.charges && !('void' in requested)) {
      next.void = false;
    }
    refuseVoidWithoutCharges(next);

    // The lockout this endpoint can actually cause: the only holder of `team`
    // revoking it, from herself or from the last other holder. See the helper.
    if (before.team && !next.team) await refuseLastTeamAdminRemoval(p.salonId, target.id);

    /**
     * ROLE AND BRANCH ACCESS — the other two thirds of a staff row, which had
     * no write path at all. `PATCH /staff/{id}` took `perms` only, so a
     * receptionist promoted to manager, or a stylist moved to the new branch,
     * needed an UPDATE by hand.
     */
    const role = 'role' in body ? parseRole(body.role) : target.role;
    const access =
      'branchAccess' in body
        ? await parseBranchAccess(body.branchAccess, p.salonId)
        : { branchAccessAll: target.branchAccessAll, branchAccessIds: target.branchAccessIds };

    const changed = PERMISSION_NAMES.filter((n) => before[n] !== next[n]);
    const roleChanged = role !== target.role;
    const accessChanged =
      access.branchAccessAll !== target.branchAccessAll ||
      access.branchAccessIds.join(',') !== target.branchAccessIds.join(',');

    if (changed.length > 0 || roleChanged || accessChanged) {
      await db
        .update(staffUser)
        .set({
          ...Object.fromEntries(PERMISSION_NAMES.map((n) => [PERM_COLUMN[n], next[n]])),
          role,
          ...access,
          updatedAt: new Date(),
        })
        .where(eq(staffUser.id, target.id));

      // Every grant and every revoke, named. `kind: 'access'` is the dashboard's
      // Access filter — design/README.md § Merchant dashboard.
      const describeAccess = (all: boolean, ids: string[]) =>
        all ? 'all branches' : ids.length ? ids.join(', ') : 'no branch';

      await writeAudit(db, p, {
        salonId: p.salonId,
        kind: 'access',
        action: 'Permissions changed',
        detail:
          `${target.name}: ` +
          [
            ...changed.map((n) => `${n} ${before[n] ? 'on→off' : 'off→on'}`),
            ...(roleChanged ? [`role ${target.role}→${role}`] : []),
            ...(accessChanged
              ? [
                  `branches ${describeAccess(target.branchAccessAll, target.branchAccessIds)}→${describeAccess(access.branchAccessAll, access.branchAccessIds)}`,
                ]
              : []),
          ].join(', '),
        source: 'merchant',
        subjectType: 'staff_user',
        subjectId: target.id,
        metadata: {
          before,
          after: next,
          changed,
          grants: changed.filter((n) => next[n]),
          revokes: changed.filter((n) => !next[n]),
          ...(roleChanged ? { roleBefore: target.role, roleAfter: role } : {}),
          ...(accessChanged
            ? {
                branchAccessBefore: target.branchAccessAll ? 'all' : target.branchAccessIds,
                branchAccessAfter: access.branchAccessAll ? 'all' : access.branchAccessIds,
              }
            : {}),
        },
        ...clientMeta(req),
      });

      // Losing scanner authority should not leave a live scanner session behind.
      if (before.scanner && !next.scanner) {
        await revokeAllSessions(db, { kind: 'staff', id: target.id }, 'permissions_changed');
      }
    }

    const updated = await db.select().from(staffUser).where(eq(staffUser.id, target.id)).limit(1);
    return reply.send(serialiseStaff(updated[0]!));
  });

  // ------------------------------------------------------------------ leave --
  /**
   * perms.team. Somebody leaves.
   *
   * A DEACTIVATION, NOT A DELETE, and the reason is the same one the branch
   * close gives: `transaction.created_by_staff_id`,
   * `wallet_token.consumed_by_staff_id` and `artist.staff_user_id` reference
   * this row, and `audit_log` names the actor by id. Her row is what makes a
   * two-year-old charge still say who took it.
   *
   * What LEAVES is the credentials. `password_hash` and `pin_hash` are nulled
   * in the same transaction and every session is revoked, so the answer to
   * "does a leaver keep her sign-in for ever" is no on both surfaces and
   * immediately, not at the next token expiry. `pin_device_id` goes with the
   * PIN because `staff_user_pin_is_device_scoped` requires the two to be null
   * together.
   *
   * TWO REFUSALS, both of them lockouts waiting to happen:
   *
   *   - you cannot deactivate YOURSELF. A manager who does it by accident has
   *     revoked her own session mid-request and cannot undo it.
   *   - you cannot deactivate the LAST account holding `perms.team`. That is
   *     the permission that grants permissions; removing the last holder locks
   *     the salon out of its own Accounts screen with no path back that does
   *     not involve an engineer — which is the phase-4 criterion, inverted.
   *     Same shape as the last-open-branch rule in salons.ts.
   */
  app.delete<{ Params: { id: string } }>('/staff/:id', async (req, reply) => {
    const p = requireDashboardPerm(req, 'team');

    const rows = await db
      .select()
      .from(staffUser)
      .where(and(eq(staffUser.id, req.params.id), eq(staffUser.salonId, p.salonId)))
      .limit(1);
    const target = rows[0];
    if (!target) throw notFound('unknown_staff', 'No such staff member.');

    // Idempotent. Deactivating a leaver is not an error and must not write a
    // second audit row claiming she left twice.
    if (target.deactivatedAt) return reply.send(serialiseStaff(target));

    if (target.id === p.id) {
      throw conflict(
        'cannot_deactivate_self',
        'You cannot remove your own account. Ask another manager to do it.',
      );
    }

    if (target.permTeam) await refuseLastTeamAdminRemoval(p.salonId, target.id);

    const deactivatedAt = new Date();
    const [row] = await db.transaction(async (tx) => {
      const updated = await tx
        .update(staffUser)
        .set({
          deactivatedAt,
          // A leaver keeps nothing she can sign in with. The CHECK
          // `staff_user_deactivated_holds_no_credential` says the same thing.
          passwordHash: null,
          pinHash: null,
          pinDeviceId: null,
          pinFailedAttempts: 0,
          pinLockedUntil: null,
          updatedAt: deactivatedAt,
        })
        .where(eq(staffUser.id, target.id))
        .returning();

      // Any live reset link is spent too. A leaver walking to her desk with an
      // unused token would otherwise be able to set a password on a
      // deactivated account the moment somebody re-activated it.
      await tx
        .update(staffPasswordReset)
        .set({ usedAt: deactivatedAt })
        .where(and(eq(staffPasswordReset.staffId, target.id), isNull(staffPasswordReset.usedAt)));

      await writeAudit(tx, p, {
        salonId: p.salonId,
        kind: 'access',
        action: 'Staff account deactivated',
        detail: `${target.name} (@${target.handle}) — sign-in removed on both surfaces`,
        source: 'merchant',
        subjectType: 'staff_user',
        subjectId: target.id,
        metadata: {
          name: target.name,
          handle: target.handle,
          role: target.role,
          permsAtDeparture: permsOf(target),
        },
        ...clientMeta(req),
      });

      return updated;
    });

    // Outside the transaction: revocation is its own write and a failure here
    // must not roll back the deactivation. The credentials are already gone, so
    // the worst case is a session that dies at its next request instead of now.
    await revokeAllSessions(db, { kind: 'staff', id: target.id }, 'staff_deactivated');

    if (!row) throw notFound('unknown_staff', 'No such staff member.');
    return reply.send(serialiseStaff(row));
  });

  // --------------------------------------------------------- password reset --
  /**
   * perms.team. NON-NEGOTIABLE #6: "Owner console only ever sends a reset link."
   *
   * The two things this endpoint must never do, and does not:
   *
   *   - it does not accept a password. There is no body field that sets one.
   *   - it does not RETURN the token. The response is 202 and carries the
   *     expiry and nothing else. A reset that comes back through the manager's
   *     browser is a credential travelling through the wrong pair of hands —
   *     it would sit in her network log, and she could set the password
   *     herself and know it. "Sends a link" means the link goes to the staff
   *     member.
   *
   * Only the sha256 is stored, the way `session.refresh_token_hash` and
   * `wallet_token.token_hash` are. A database dump is not a list of live reset
   * links.
   *
   * ISSUING A SECOND ONE SPENDS THE FIRST. Otherwise two links are live at
   * once, and the older one — the one somebody is already walking to a desk
   * with — is the one nobody knows is still valid.
   *
   * 202 and not 200, because the thing being reported is ACCEPTED, not done:
   * delivery has not happened when this returns. No sender is wired, for the
   * reason receipts/types.ts sets out — the WhatsApp templates are unapproved
   * and the sending domain is an open client decision. `staff_password_reset`
   * is the outbox that is waiting for one, and `sentAt` is where it stamps
   * itself.
   */
  app.post<{ Params: { id: string } }>('/staff/:id/password-reset', async (req, reply) => {
    const p = requireDashboardPerm(req, 'team');

    const body = (req.body ?? {}) as Record<string, unknown>;
    refuseCredentialFields(body);

    const rows = await db
      .select()
      .from(staffUser)
      .where(and(eq(staffUser.id, req.params.id), eq(staffUser.salonId, p.salonId)))
      .limit(1);
    const target = rows[0];
    if (!target) throw notFound('unknown_staff', 'No such staff member.');

    /**
     * A DEACTIVATED ACCOUNT IS ALLOWED HERE, and that is the re-hire path.
     *
     * This refused a leaver at first, which made `handle_taken` on `POST /staff`
     * a lie: it tells a manager re-hiring somebody to "re-activate that account
     * with a reset link instead", and there was no such door. A leaver's row
     * exists precisely so her history stays on one identity, so the way back in
     * has to go through it.
     *
     * The link is an INVITATION and issuing it changes nothing on its own — the
     * account stays deactivated, holding no credential, until she redeems it.
     * Re-activation happens at redemption, in the same UPDATE that sets the
     * password, because `staff_user_deactivated_holds_no_credential` will not
     * let those two facts exist apart.
     */
    const reactivating = target.deactivatedAt !== null;

    const token = mintResetToken();
    const expiresAt = new Date(Date.now() + RESET_TTL_MINUTES * 60_000);

    await db.transaction(async (tx) => {
      await tx
        .update(staffPasswordReset)
        .set({ usedAt: new Date() })
        .where(and(eq(staffPasswordReset.staffId, target.id), isNull(staffPasswordReset.usedAt)));

      await tx.insert(staffPasswordReset).values({
        staffId: target.id,
        salonId: p.salonId,
        tokenHash: hashResetToken(token),
        requestedBy: p.name,
        expiresAt,
      });

      await writeAudit(tx, p, {
        salonId: p.salonId,
        kind: 'access',
        action: reactivating ? 'Re-activation link sent' : 'Password reset link sent',
        // Names who and when. NEVER the token — an audit row is read by more
        // people than the endpoint's response is.
        detail:
          `${target.name} (@${target.handle}) — link valid for ${RESET_TTL_MINUTES} minutes` +
          (reactivating ? ' · will re-activate a deactivated account' : ''),
        source: 'merchant',
        subjectType: 'staff_user',
        subjectId: target.id,
        metadata: {
          expiresAt: expiresAt.toISOString(),
          ttlMinutes: RESET_TTL_MINUTES,
          reactivating,
        },
        ...clientMeta(req),
      });
    });

    /**
     * Accepted. No token, no password, no link — the dashboard's confirmation
     * is "we've sent Mariam a link", and the only thing it needs from here is
     * when it stops working.
     */
    return reply.code(202).send({
      staffId: target.id,
      expiresAt: expiresAt.toISOString(),
      delivered: false,
      /** So the dashboard can say "invite Mariam back" rather than "reset". */
      reactivating,
    });
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
   *
   * THE TOKEN IS RESOLVED INSIDE THE CALLER'S SALON, and the member row is read
   * inside it too. This handler used to resolve the token by hash alone and then
   * fetch the member by id with no tenant predicate, which made it a
   * cross-tenant read: a scanner at salon B, on a legitimate device-bound PIN
   * session, could submit a QR minted for salon A's customer and receive her
   * name, phone, email, balance, tier and visit count. The service list two
   * lines below WAS salon-scoped, which is what made the response look correct.
   *
   * Both reads are scoped now, and both refusals are `404 unknown_member` —
   * identical to a member that does not exist.
   */
  app.post('/scans', async (req, reply) => {
    const p = requireScannerPerm(req, 'scanner');

    const body = (req.body ?? {}) as Record<string, unknown>;
    const token = typeof body.token === 'string' ? body.token.trim() : '';
    if (!token) throw badRequest('invalid_request', 'token is required.');

    const peeked = await peekToken(db, token, { salonId: p.salonId });

    // Scoped again here rather than trusting the resolver. Two independent
    // predicates on the same boundary is the point: this one survives a future
    // change to peekToken, and peekToken's survives a future handler that
    // forgets this line.
    const rows = await db
      .select()
      .from(member)
      .where(and(eq(member.id, peeked.memberId), eq(member.salonId, p.salonId)))
      .limit(1);
    const m = rows[0];
    if (!m) throw notFound('unknown_member', 'No such member.');

    const services = await db
      .select({ id: service.id, name: service.name, priceFils: service.priceFils })
      .from(service)
      .where(and(eq(service.salonId, p.salonId), eq(service.active, true)));

    /**
     * THE HELD DEPOSIT, READ FOR REAL.
     *
     * This was hardcoded to 0 with a comment saying bookings were not built.
     * Lane D carried the consequence as a standing todo: the scanner's "deposit
     * applied" credit line renders money and had never been exercised with a
     * non-zero value.
     *
     * The SAME function `performCharge` uses — services/booking.ts
     * § findApplicableHold — so what the scanner shows before the charge and what
     * the charge actually applies cannot disagree. Two implementations of "does
     * she have a deposit with us right now" is two answers, and the one on the
     * screen is the one the customer is told.
     *
     * Unlocked here, because this is a read and the charge is the authority. A
     * booking the no-show job returns in the second between this scan and that
     * charge shows a credit line the charge then declines to apply — which is
     * correct, and is why the number is recomputed there rather than passed in.
     */
    const [s] = await db
      .select({ noShowReturnMinutes: salon.noShowReturnMinutes })
      .from(salon)
      .where(eq(salon.id, p.salonId))
      .limit(1);

    const held = await findApplicableHold(db, {
      memberId: m.id,
      salonId: p.salonId,
      now: new Date(),
      noShowReturnMinutes: s?.noShowReturnMinutes ?? 60,
    });

    return reply.send({
      member: serialiseMember(m),
      heldDepositFils: held?.depositFils ?? 0,
      /**
       * Not in the contract's `POST /scans` response, and not decorative: the
       * credit line reads "Deposit held · 5.000" and the staff member has to be
       * able to say WHICH appointment when the customer asks. Null when nothing
       * is held, rather than omitted, so "no deposit" is a fact the client can
       * read instead of an absence it has to interpret.
       */
      heldDepositBooking: held
        ? {
            id: held.id,
            startsAt: held.startsAt.toISOString(),
            serviceId: held.serviceId,
            artistId: held.artistId,
          }
        : null,
      services,
    });
  });
}
