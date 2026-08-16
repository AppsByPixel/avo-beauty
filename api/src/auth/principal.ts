/**
 * Who is calling, and what may they do.
 *
 * Non-negotiable #7: "Permissions are enforced server-side. The UI hiding a
 * button is a courtesy, not a control." The mechanical consequence is the rule
 * this module exists to make unavoidable:
 *
 *   PERMISSIONS ARE READ FROM `staff_user`, ON EVERY REQUEST, BY STAFF ID FROM
 *   A VERIFIED TOKEN. Never from the body, never from a header, never from a
 *   `role` the client sends, and never from a claim inside the access token.
 *
 * The last one is the non-obvious one. Putting perms in the JWT is the usual
 * optimisation and it quietly breaks the requirement: a manager who revokes
 * `charges` at 14:00 expects it gone at 14:00, not whenever a fifteen-minute
 * token happens to expire. One indexed primary-key lookup per request is the
 * price of that, and it is cheap.
 *
 * `void` implying `charges` is resolved HERE as well as in the database CHECK,
 * so a row that predates the constraint still cannot produce an effective
 * `void` without `charges`.
 */

import { eq } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import type { Db } from '../db/client';
import { member } from '../db/schema/member';
import { staffUser } from '../db/schema/staff';
import { env } from '../env';
import { forbidden, unauthorized } from '../http/errors';
import { sessionIsLive } from './sessions';
import { verifyAccessToken, type PrincipalKind, type SessionScope } from './tokens';

/** The nine permissions of api-contract.md § StaffUser. */
export interface StaffPerms {
  dashboard: boolean;
  appointments: boolean;
  shop: boolean;
  loyalty: boolean;
  team: boolean;
  scanner: boolean;
  charges: boolean;
  void: boolean;
  marketing: boolean;
}

export const PERMISSION_NAMES = [
  'dashboard',
  'appointments',
  'shop',
  'loyalty',
  'team',
  'scanner',
  'charges',
  'void',
  'marketing',
] as const;

export type PermissionName = (typeof PERMISSION_NAMES)[number];

export interface MemberPrincipal {
  kind: 'member';
  id: string;
  salonId: string;
  scope: 'wallet';
  sessionId: string;
}

export interface StaffPrincipal {
  kind: 'staff';
  id: string;
  salonId: string;
  scope: 'scanner' | 'dashboard';
  sessionId: string;
  name: string;
  role: string;
  perms: StaffPerms;
  branchAccessAll: boolean;
  branchAccessIds: string[];
}

export type Principal = MemberPrincipal | StaffPrincipal;

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal | undefined;
  }
}

/**
 * Effective permissions for a staff row.
 *
 * `void` is filtered through `charges` because api-contract.md § StaffUser says
 * "void is meaningless without charges". The database CHECK refuses to store
 * that combination; this makes an already-stored one harmless too.
 */
export function permsOf(row: {
  permDashboard: boolean;
  permAppointments: boolean;
  permShop: boolean;
  permLoyalty: boolean;
  permTeam: boolean;
  permScanner: boolean;
  permCharges: boolean;
  permVoid: boolean;
  permMarketing: boolean;
}): StaffPerms {
  return {
    dashboard: row.permDashboard,
    appointments: row.permAppointments,
    shop: row.permShop,
    loyalty: row.permLoyalty,
    team: row.permTeam,
    scanner: row.permScanner,
    charges: row.permCharges,
    void: row.permVoid && row.permCharges,
    marketing: row.permMarketing,
  };
}

async function loadStaffPrincipal(
  db: Db,
  staffId: string,
  scope: 'scanner' | 'dashboard',
  sessionId: string,
): Promise<StaffPrincipal | null> {
  const rows = await db.select().from(staffUser).where(eq(staffUser.id, staffId)).limit(1);
  const row = rows[0];
  if (!row) return null;

  return {
    kind: 'staff',
    id: row.id,
    salonId: row.salonId,
    scope,
    sessionId,
    name: row.name,
    role: row.role,
    perms: permsOf(row),
    branchAccessAll: row.branchAccessAll,
    branchAccessIds: row.branchAccessIds,
  };
}

async function loadMemberPrincipal(
  db: Db,
  memberId: string,
  sessionId: string,
): Promise<MemberPrincipal | null> {
  const rows = await db
    .select({ id: member.id, salonId: member.salonId })
    .from(member)
    .where(eq(member.id, memberId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return { kind: 'member', id: row.id, salonId: row.salonId, scope: 'wallet', sessionId };
}

// ------------------------------------------------------- the test affordance --

/**
 * Lane D's e2e suite sends no credentials and selects its principal with
 * `x-avo-scenario`, because it was written against packages/mock. Under
 * AVO_TEST_PRINCIPALS (refused in production — see env.ts) an unauthenticated
 * request resolves to a seeded principal so those specs run unchanged.
 *
 * This shim decides WHICH principal. It does not decide what that principal may
 * do: the perms come from the seeded `staff_user` row like any other request,
 * so a 403 proven here is the same 403 a real session gets.
 */
const TEST_STAFF_FULL = 'ST-001';
const TEST_STAFF_NOPERMS = 'ST-002';
const TEST_MEMBER = '8842';
/**
 * `lowbal` selects a seeded member with 2.500 KD rather than pinning a fake
 * balance. The mock could substitute a number; a real API cannot fabricate a
 * balance without lying about the money, so the scenario changes WHOSE wallet is
 * in play and the handler runs unmodified. The 402 it produces is a real
 * shortfall against a real row.
 */
const TEST_MEMBER_LOWBAL = '8843';

export function scenariosOf(req: FastifyRequest): Set<string> {
  const header = req.headers['x-avo-scenario'];
  const query = (req.query as Record<string, string> | undefined)?.scenario;
  const raw = (Array.isArray(header) ? header[0] : header) ?? query ?? '';
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

export function hasScenario(req: FastifyRequest, name: string): boolean {
  return scenariosOf(req).has(name);
}

async function testPrincipalFor(db: Db, req: FastifyRequest): Promise<Principal | null> {
  const staffId = hasScenario(req, 'noperms') ? TEST_STAFF_NOPERMS : TEST_STAFF_FULL;

  // Member-scoped routes get the member; everything else gets the staff row.
  // The suite only ever needs one of each.
  if (req.url.startsWith('/members/') || req.url.startsWith('/topups')) {
    const memberId = hasScenario(req, 'lowbal') ? TEST_MEMBER_LOWBAL : TEST_MEMBER;
    return loadMemberPrincipal(db, memberId, 'test-session-member');
  }

  // The scope has to match the surface the route belongs to, or every dashboard
  // route would be unreachable in test mode and every scanner route would be
  // reachable with the wrong kind of credential. This mirrors what a real PIN
  // session and a real web session would carry.
  const scannerSurface =
    req.url.startsWith('/scans') ||
    req.url.startsWith('/charges') ||
    req.url.startsWith('/voids') ||
    req.url.startsWith('/staff/me');

  return loadStaffPrincipal(
    db,
    staffId,
    scannerSurface ? 'scanner' : 'dashboard',
    'test-session-staff',
  );
}

// ---------------------------------------------------------------- resolution --

/**
 * Resolve the caller. Returns null for an anonymous request rather than
 * throwing — a route decides whether anonymity is acceptable.
 */
export async function resolvePrincipal(db: Db, req: FastifyRequest): Promise<Principal | null> {
  const header = req.headers.authorization;
  const bearer = typeof header === 'string' && header.startsWith('Bearer ')
    ? header.slice('Bearer '.length).trim()
    : null;

  if (!bearer) {
    return env.testPrincipals ? testPrincipalFor(db, req) : null;
  }

  const claims = await verifyAccessToken(bearer);
  if (!claims) return null;

  // A revoked session must stop working immediately, so the signature alone is
  // not enough — the session row is checked on every request. This is what makes
  // "revokes every other session" true at the moment the password changes.
  if (!(await sessionIsLive(db, claims.sid))) return null;

  if (claims.kind === 'member') {
    return loadMemberPrincipal(db, claims.sub, claims.sid);
  }
  if (claims.scope === 'wallet') return null;
  return loadStaffPrincipal(db, claims.sub, claims.scope, claims.sid);
}

// -------------------------------------------------------------------- guards --

export function requirePrincipal(req: FastifyRequest): Principal {
  if (!req.principal) throw unauthorized();
  return req.principal;
}

export function requireMember(req: FastifyRequest): MemberPrincipal {
  const p = requirePrincipal(req);
  if (p.kind !== 'member') throw forbidden('This endpoint is for customers.');
  return p;
}

export function requireStaff(req: FastifyRequest): StaffPrincipal {
  const p = requirePrincipal(req);
  if (p.kind !== 'staff') throw forbidden('This endpoint is for salon staff.');
  return p;
}

/**
 * Dashboard-only. api-contract.md § StaffUser: a PIN must "never reach dashboard
 * scopes". The scope is stamped on the session at sign-in, so a scanner token
 * cannot reach a dashboard endpoint even if the staff member holds every
 * permission — the credential is the wrong kind, not merely under-privileged.
 */
export function requireDashboardScope(req: FastifyRequest): StaffPrincipal {
  const p = requireStaff(req);
  if (p.scope !== 'dashboard') {
    throw forbidden(
      'A scanner PIN cannot reach the dashboard. Sign in on the web with a username and password.',
    );
  }
  return p;
}

/** Copy from design/AVO Staff Scanner.dc.html, locked state. Lane D asserts on it. */
const PERMISSION_COPY: Record<PermissionName, string> = {
  dashboard: "You don't have permission to see the dashboard. A manager can grant it.",
  appointments: "You don't have permission to see appointments. A manager can grant it.",
  shop: "You don't have permission to see the shop. A manager can grant it.",
  loyalty: "You don't have permission to change loyalty settings. A manager can grant it.",
  team: "You don't have permission to manage the team. A manager can grant it.",
  scanner: "You don't have permission to scan and charge. A manager can grant it.",
  charges: "You don't have permission to see today's charges. A manager can grant it.",
  void: "You don't have permission to void a charge. A manager can grant it.",
  marketing: "You don't have permission to submit a campaign. A manager can grant it.",
};

/**
 * THE permission gate. Call it as the first statement of a handler, before any
 * lookup, any token resolution and any write.
 *
 * Ordering is load-bearing, not tidiness. Lane D's probe for `perms.scanner`
 * reads: "POST /scans — 410 means the token was resolved before authority was
 * checked". An endpoint that looks the token up first and only then checks
 * authority has already told an unauthorised caller whether that token exists.
 */
export function requirePerm(req: FastifyRequest, permission: PermissionName): StaffPrincipal {
  const p = requireStaff(req);
  if (!p.perms[permission]) throw forbidden(PERMISSION_COPY[permission]);
  return p;
}

/**
 * A dashboard endpoint: the credential must be a web session AND carry the
 * permission. Both gates, in that order.
 *
 * Scope is checked first because it is the more fundamental refusal. A manager
 * holding every permission still must not reach Accounts → Team from a scanner
 * tablet on the salon floor — the PIN is a four-digit shift credential, and
 * api-contract.md says it must "never let it reach dashboard scopes". Checking
 * only the permission would let it, since she genuinely holds the permission.
 */
export function requireDashboardPerm(
  req: FastifyRequest,
  permission: PermissionName,
): StaffPrincipal {
  const p = requireDashboardScope(req);
  if (!p.perms[permission]) throw forbidden(PERMISSION_COPY[permission]);
  return p;
}

/** A staff member may only ever act inside their own salon. */
export function requireSameSalon(principal: Principal, salonId: string): void {
  if (principal.salonId !== salonId) {
    throw forbidden('That salon is not yours.');
  }
}
