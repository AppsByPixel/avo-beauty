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
  //
  // `/bookings` is the customer's collection — api-contract.md § Operations puts
  // it at the root and scopes it by the credential, so it belongs here. NOT
  // `/artists/me/bookings`, which is the artist's own day on the scanner and is
  // matched by the scanner block below; the two are different surfaces reading
  // the same table, exactly as `/artists/me/availability` and
  // `/artists/{id}/availability` are.
  if (
    req.url.startsWith('/members/') ||
    req.url.startsWith('/topups') ||
    req.url === '/bookings' ||
    req.url.startsWith('/bookings?') ||
    req.url.startsWith('/bookings/') ||
    /**
     * `POST /v1/support/tickets` is the customer writing to support, so it is
     * `requireMember` like the rest of this block. Without the line it falls
     * through to the staff branch below and answers 403 "This endpoint is for
     * customers" to a suite that cannot see why — the endpoint's own gate
     * refusing the shim's choice of principal.
     *
     * NOT `/v1/platform/support` or `/v1/platform/policies`: those are readable
     * by any authenticated principal, so either kind resolves them, and staff
     * is the useful default there because the dashboard reads them too.
     */
    req.url.startsWith('/v1/support/tickets') ||
    /**
     * `POST /orders` is the shop checkout — api-contract.md § Operations puts it
     * at the root and scopes it by the credential, exactly as it does
     * `POST /bookings`, and the handler is `requireMember`. Without this line it
     * falls through to the staff branch below and answers 403 "This endpoint is
     * for customers" to a suite that cannot see why.
     *
     * NOT `/salons/{id}/products`, which is one catalog read from two surfaces.
     * Staff is the useful default there because it is the side that exercises
     * `perms.shop`, and the `noperms` scenario selects the staff row with the
     * permission off.
     */
    req.url === '/orders' ||
    req.url.startsWith('/orders?')
  ) {
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
    req.url.startsWith('/staff/me') ||
    // The artist's own hours. `/artists/{id}/availability` is the merchant's
    // route and stays on the dashboard — the `me` prefix is the whole
    // distinction, exactly as it is in routes/artists.ts.
    req.url.startsWith('/artists/me') ||
    /**
     * Manual customer lookup — `GET /members?q=`, the fallback for a flat phone.
     *
     * Matched exactly, never by prefix. `/members/` was already claimed by the
     * MEMBER branch above, and a `startsWith('/members')` here would be tested
     * after it and so could never fire — but it would be a live trap for whoever
     * next reorders these two blocks and silently hands the wallet's own routes
     * a staff principal.
     */
    req.url === '/members' ||
    req.url.startsWith('/members?');

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

/**
 * WHICH SURFACE AN ENDPOINT BELONGS TO.
 *
 * Required, never defaulted, at every staff gate. A default here would be a
 * default answer to a security question, and the whole reason this parameter
 * exists is that the wrong default shipped: the scope check ran in one direction
 * only, so a dashboard web session could call `POST /charges` and debit a
 * wallet. Making the surface a parameter you cannot omit means the next endpoint
 * added to this API cannot be scope-agnostic by accident — only on purpose, by
 * writing `'either'` and being seen to write it.
 */
export type StaffSurface = 'scanner' | 'dashboard' | 'either';

const SURFACE_COPY: Record<Exclude<StaffSurface, 'either'>, string> = {
  /**
   * api-contract.md § StaffUser: a PIN must "never reach dashboard scopes".
   * The credential is the wrong kind, not merely under-privileged — a manager
   * holding every permission still cannot reach Accounts → Team from the
   * scanner tablet on the salon floor.
   */
  dashboard:
    'A scanner PIN cannot reach the dashboard. Sign in on the web with a username and password.',
  /**
   * The other direction, and the reason this map exists. A four-digit PIN is
   * only safe because of what surrounds it: hashed, device-scoped, rate-limited
   * per device and salon, locked after five failures, scanner scope only. A web
   * session has none of that — it is long-lived, browser-based, not bound to a
   * device, and refreshable for thirty days. If it can charge, every one of
   * those PIN controls is optional, because the easier door is open.
   *
   * A manager who hits this is confused, not attacking, so the copy names the
   * surface the action lives on rather than refusing flatly.
   */
  scanner:
    'Charging happens on the staff scanner, not the dashboard. Open AVO on the salon phone and sign in with your PIN.',
};

/**
 * Authenticated staff on the right surface.
 *
 * The scope is stamped on the session at sign-in and is NOT re-read per request
 * the way permissions are: a session is issued as a scanner session or a web
 * session and never changes kind. That makes it a property of the credential,
 * which is why it is checked before authority — a caller can be entirely
 * authorised and still be holding the wrong sort of key.
 */
export function requireStaff(req: FastifyRequest, surface: StaffSurface): StaffPrincipal {
  const p = requirePrincipal(req);
  if (p.kind !== 'staff') throw forbidden('This endpoint is for salon staff.');
  if (surface !== 'either' && p.scope !== surface) throw forbidden(SURFACE_COPY[surface]);
  return p;
}

/** Dashboard-only, no permission attached. */
export function requireDashboardScope(req: FastifyRequest): StaffPrincipal {
  return requireStaff(req, 'dashboard');
}

/** Scanner-only, no permission attached. */
export function requireScannerScope(req: FastifyRequest): StaffPrincipal {
  return requireStaff(req, 'scanner');
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
 * TWO gates, and the order between them is load-bearing:
 *
 *   1. SURFACE — is this the right kind of credential at all? Checked first
 *      because it is the more fundamental refusal, and because it is the one a
 *      permission check cannot stand in for: a manager holds `charges`
 *      legitimately, so gating on the permission alone lets her web session
 *      debit a wallet from a back-office laptop.
 *   2. PERMISSION — read from `staff_user` on this request, never from a claim.
 *
 * Both run before any lookup. Lane D's probe for `perms.scanner` reads:
 * "POST /scans — 410 means the token was resolved before authority was
 * checked". An endpoint that looks the token up first and only then checks
 * authority has already told an unauthorised caller whether that token exists.
 *
 * `surface` has no default on purpose. See `StaffSurface`.
 */
export function requirePerm(
  req: FastifyRequest,
  surface: StaffSurface,
  permission: PermissionName,
): StaffPrincipal {
  const p = requireStaff(req, surface);
  if (!p.perms[permission]) throw forbidden(PERMISSION_COPY[permission]);
  return p;
}

/** A dashboard endpoint: a web session AND the permission. */
export function requireDashboardPerm(
  req: FastifyRequest,
  permission: PermissionName,
): StaffPrincipal {
  return requirePerm(req, 'dashboard', permission);
}

/**
 * A scanner endpoint: a device-bound PIN session AND the permission.
 *
 * The mirror of `requireDashboardPerm`, and the half that was missing. Every
 * money-moving endpoint on the counter goes through here.
 */
export function requireScannerPerm(
  req: FastifyRequest,
  permission: PermissionName,
): StaffPrincipal {
  return requirePerm(req, 'scanner', permission);
}

/** A staff member may only ever act inside their own salon. */
export function requireSameSalon(principal: Principal, salonId: string): void {
  if (principal.salonId !== salonId) {
    throw forbidden('That salon is not yours.');
  }
}
