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
import {
  platformAdmin,
  PLATFORM_SECTIONS,
  type PlatformRole,
  type PlatformSection,
} from '../db/schema/platformAdmin';
import { staffUser } from '../db/schema/staff';
import { env } from '../env';
import { forbidden, unauthorized } from '../http/errors';
import { liveSession } from './sessions';
import { verifyAccessToken, type PrincipalKind, type SessionScope } from './tokens';

/** The nine permissions of api-contract.md § StaffUser. */
export interface StaffPerms {
  dashboard: boolean;
  appointments: boolean;
  shop: boolean;
  /**
   * ==========================================================================
   * `loyalty` NO LONGER GRANTS AUTHORITY OVER LOYALTY. IT SURVIVES, NARROWED.
   * ==========================================================================
   * Aftab, verbatim: *"Owner console will control the loyalty part not the
   * merchant (it will be read only for merchant)."* That REVERSES a decision
   * `design/README.md:136` records as closed — "merchants now edit their own
   * tier rules" — so this is a change of mind, not a gap.
   *
   * IT IS NOT MEANINGLESS, AND DELETING IT WOULD HAVE BEEN THE WRONG READING.
   * The permission was already carrying most of the merchant Settings screen,
   * which has nothing to do with the tier ladder. It still gates, unchanged:
   *
   *   PATCH  /salons/{id}                       brand colour, deposit, modules,
   *                                             timezone, business hours, social,
   *                                             nameAr, no-show return window
   *   POST   /salons/{id}/branches              open a branch
   *   PATCH  /salons/{id}/branches/{bid}        rename / close a branch
   *   DELETE /salons/{id}/branches/{bid}        and its closure preview
   *   PATCH  /v1/salons/{id}/social/{linkId}    the salon's public handles
   *   GET    /salons/{id}/loyalty               SEE the ladder — read-only
   *
   * WHAT IT LOST is the write: `PUT /salons/{id}/loyalty` now takes the
   * console's `sections.salons`, and the five loyalty fields left
   * `MERCHANT_EDITABLE` so `PATCH /salons/{id}` cannot carry them either.
   * routes/loyalty.ts holds the full argument.
   *
   * SO THE NAME IS NOW WRONG, AND IT WAS ALREADY WRONG. `routes/salons.ts §
   * PATCH /v1/salons/{id}/social/{linkId}` escalated this to trunk before this
   * slice existed: "the honest name for this gate is `perms.settings`, and
   * adding it is a four-way break — `PERMISSION_NAMES`, `PERM_COLUMN`, the
   * `staff_user` columns, the Accounts → Team chips and the permission census
   * all move together." This change strengthens that escalation to the point of
   * being its whole case: the gate is now named after the ONE thing it no longer
   * controls. Still not renamed here — `packages/types` is trunk-owned and a
   * lane may not make a four-way break. Reported.
   *
   * `PERMISSION_COPY.loyalty` is stale for the same reason and is deliberately
   * NOT edited: it is design copy that four surfaces assert on verbatim. See the
   * note there.
   */
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

/**
 * The nine permission names, mapped to their nine columns.
 *
 * It lived in `routes/staff.ts` and moved here when a SECOND writer of
 * `staff_user`'s permission columns appeared — the onboarding wizard's owner
 * account, created by `services/salonOnboarding.ts`. A private copy in each
 * writer is the shape of the defect `routes/salons.ts` records against the tier
 * ladder: two doors into one set of columns, and the one nobody is reading is
 * the one that drifts.
 *
 * `satisfies` is what makes a tenth permission a compile error here rather than
 * a silently unwritten column at the far end.
 */
export const PERM_COLUMN = {
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
  /**
   * The till this session was minted for, read off the session row and never off
   * a header.
   *
   * IT IS THE RATE-LIMIT KEY for `POST /scans`, `POST /charges` and `POST /voids`
   * — see services/scannerLimit.ts — which is why it is on the principal at all
   * rather than being fetched where it is used: fetching it separately would be a
   * second read of a row `resolvePrincipal` has already read, and a second place
   * that could disagree about which device is calling.
   *
   * `string | null` rather than `string`, and the null is not a shrug.
   * `session_scanner_is_device_scoped` makes it non-null for every SCANNER
   * session, which is every principal that can reach the three limited endpoints;
   * a DASHBOARD session may legitimately have none, and an `AVO_TEST_PRINCIPALS`
   * build has no session row to read at all. The limiter counts the null bucket
   * rather than exempting it.
   */
  deviceId: string | null;
  name: string;
  role: string;
  perms: StaffPerms;
  branchAccessAll: boolean;
  branchAccessIds: string[];
}

/**
 * The owner console. THE ONE PRINCIPAL WITH NO SALON.
 *
 * `requireSameSalon` is the tenancy boundary for every other principal, and this
 * one is above it: the console's Analytics is "across all salons" by design. So
 * there is no `salonId` field to compare — not a null one, no field at all, so a
 * handler that tries to call `requireSameSalon(p, id)` on a platform principal
 * does not compile. That is deliberate. A nullable field would make the tenancy
 * check silently pass instead.
 *
 * `sections` is nine booleans rather than the design's six. The reasoning is in
 * db/schema/platformAdmin.ts: the console draws ten sidebar sections and six
 * permission chips, three of the four ungated ones have endpoints here, and #7
 * does not permit an ungated endpoint.
 */
export interface PlatformPrincipal {
  kind: 'platform_admin';
  id: string;
  scope: 'platform';
  sessionId: string;
  name: string;
  role: PlatformRole;
  owner: boolean;
  sections: Record<PlatformSection, boolean>;
}

export type Principal = MemberPrincipal | StaffPrincipal | PlatformPrincipal;

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
  /**
   * Passed IN rather than looked up here, because the caller has already read the
   * session row — `resolvePrincipal` reads it to answer "is it live" and the test
   * shim has no row to read. A second query for a column already in hand would be
   * a second answer to "which device is calling", on the request path of every
   * charge.
   */
  deviceId: string | null,
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
    deviceId,
    name: row.name,
    role: row.role,
    perms: permsOf(row),
    branchAccessAll: row.branchAccessAll,
    branchAccessIds: row.branchAccessIds,
  };
}

/**
 * Section authority for a platform admin row.
 *
 * `active` IS CHECKED HERE AND NOT AT SIGN-IN ONLY, for the reason permissions
 * are read per request rather than put in the token: an admin deactivated at
 * 14:00 is out at 14:00, not whenever her fifteen-minute access token happens to
 * expire. A deactivated row resolves to no principal at all, so every one of her
 * requests is anonymous from the next call onward.
 */
async function loadPlatformPrincipal(
  db: Db,
  adminId: string,
  sessionId: string,
): Promise<PlatformPrincipal | null> {
  const rows = await db
    .select()
    .from(platformAdmin)
    .where(eq(platformAdmin.id, adminId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  if (!row.active) return null;

  return {
    kind: 'platform_admin',
    id: row.id,
    scope: 'platform',
    sessionId,
    name: row.name,
    role: row.role,
    owner: row.owner,
    sections: {
      analytics: row.permAnalytics,
      activity: row.permActivity,
      salons: row.permSalons,
      accounts: row.permAccounts,
      admins: row.permAdmins,
      controls: row.permControls,
      approvals: row.permApprovals,
      policies: row.permPolicies,
      audit: row.permAudit,
    },
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
 * The owner console's two seeded admins. `PLT-001` is Yousef, the owner, who holds
 * every section; `PLT-002` is Mariam, the analyst, who holds analytics and
 * activity and nothing else.
 *
 * The pair exists for the reason ST-001/ST-002 does: a section gate can only be
 * PROVEN to exist if some credential is refused by it, and a hypothetical
 * credential proves nothing. `x-avo-scenario: noplatformperms` selects the
 * analyst.
 */
const TEST_PLATFORM_OWNER = 'PLT-001';
const TEST_PLATFORM_LIMITED = 'PLT-002';
/**
 * `lowbal` selects a seeded member with 2.500 KD rather than pinning a fake
 * balance. The mock could substitute a number; a real API cannot fabricate a
 * balance without lying about the money, so the scenario changes WHOSE wallet is
 * in play and the handler runs unmodified. The 402 it produces is a real
 * shortfall against a real row.
 */
const TEST_MEMBER_LOWBAL = '8843';

/**
 * The session ids the shim stamps on a fabricated principal, and the ONLY way to
 * tell one from a real caller after `resolvePrincipal` has returned.
 *
 * They are named rather than left as three inline literals because something
 * downstream now has to ASK the question — see `isFabricatedPrincipal` below — and
 * a copy of the string at the asking site is a copy that stops matching the moment
 * one of these is edited. That is the defect `routes/salons.ts` records against the
 * tier ladder, in a smaller form.
 *
 * They cannot collide with a real session id: `session.id` is a `uuid` primary key
 * and none of these three parses as one. That is what makes the check below exact
 * rather than approximate.
 */
export const TEST_SESSION_MEMBER = 'test-session-member';
export const TEST_SESSION_STAFF = 'test-session-staff';
export const TEST_SESSION_PLATFORM = 'test-session-platform';

/**
 * Is this principal the `AVO_TEST_PRINCIPALS` shim's invention rather than a
 * caller who presented a credential?
 *
 * WHY ANYTHING NEEDS TO ASK. The two rate limiters — services/scannerLimit.ts and
 * services/topupLimit.ts — key on an identity: a till, or a customer. The shim
 * resolves EVERY anonymous request to the same seeded staff member and the same
 * seeded customer, so under it those keys stop naming anybody. Every request in a
 * test run becomes one tablet and one shopper, and a suite that drives a thousand
 * specs in nine minutes exhausts a budget sized for a salon counter. Measured, not
 * predicted: 79 e2e failures across five files, every one a 429 where a 200 was
 * expected.
 *
 * BOTH HALVES ARE REQUIRED, and each closes a different door.
 *
 *   `env.testPrincipals` — which `env.ts` refuses outright in production. A build
 *   with it on already answers "who is calling?" with "Noura, with every
 *   permission", to anyone at all; a rate limit on top of that protects nothing
 *   that has not already been given away.
 *
 *   THE SESSION ID — so this exempts the SHIM and not "a test build". A real
 *   bearer token in a test build carries a uuid and is limited normally, which
 *   matters because `e2e/support/tenancy-harness.ts` mints real device-bound PIN
 *   sessions and real member sessions and drives money through them. Those stay
 *   under the limiter, and they are the e2e coverage of it.
 *
 * The alternative was to raise the thresholds until CI fit underneath them, which
 * is how a production control ends up at a number chosen by a test suite.
 */
export function isFabricatedPrincipal(principal: { sessionId: string }): boolean {
  if (!env.testPrincipals) return false;
  return (
    principal.sessionId === TEST_SESSION_MEMBER ||
    principal.sessionId === TEST_SESSION_STAFF ||
    principal.sessionId === TEST_SESSION_PLATFORM
  );
}

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

  /**
   * `GET`/`PATCH /v1/support/tickets` IS ONE PATH FOR TWO AUTHORITIES — the console
   * admin holding `policies` and the merchant holding `perms.dashboard`. Neither is
   * inferable from the URL, because the contract deliberately gives them one
   * endpoint, so the scenario says which one is being driven. Staff is the default;
   * `console` opts into the other side.
   *
   * FIRST, above the `/v1/platform/` block, because a path that is not under that
   * prefix could never reach it and the reader should not have to work that out.
   */
  if (hasScenario(req, 'console') && req.url.startsWith('/v1/support/tickets')) {
    return loadPlatformPrincipal(
      db,
      hasScenario(req, 'noplatformperms') ? TEST_PLATFORM_LIMITED : TEST_PLATFORM_OWNER,
      TEST_SESSION_PLATFORM,
    );
  }

  /**
   * THE OWNER CONSOLE, and it is matched FIRST because its prefix overlaps
   * nothing below and its exclusions are exact.
   *
   * `/v1/platform/policies` and `/v1/platform/support` are the two reads that live
   * under this prefix WITHOUT being console-only: the published legal set is
   * unauthenticated by necessity (a signup screen renders it before there is a
   * session — non-negotiable #10), and the support config is readable by any
   * authenticated principal because the wallet's Contact us form needs it. Both
   * keep resolving to staff, which is what they resolved to before and what the
   * existing specs drive them with.
   *
   * MATCHED EXACTLY, with an optional query string and nothing after the word.
   * `startsWith('/v1/platform/policies')` would have excluded
   * `/v1/platform/policies/draft` and `/publish` too, which ARE console-only and
   * would then have been handed a staff principal and answered 403 for a reason no
   * spec could see. That is the same prefix-versus-exact trap the `/members`
   * comment below records.
   */
  if (
    req.url.startsWith('/v1/platform/') &&
    !/^\/v1\/platform\/(policies|support)(\?|$)/.test(req.url)
  ) {
    return loadPlatformPrincipal(
      db,
      hasScenario(req, 'noplatformperms') ? TEST_PLATFORM_LIMITED : TEST_PLATFORM_OWNER,
      TEST_SESSION_PLATFORM,
    );
  }

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
     * THE METHOD IS PART OF THE MATCH, and it is the only place in this function
     * where that is true. One path now carries three verbs for three audiences:
     * `POST` is the customer, `GET` is a staffed queue and `PATCH` closes a row in
     * one. A path-only match sent the queue reads to the member branch too, and
     * `requireQueueReader` answers those 403 "This is a staffed support queue" —
     * the endpoint's gate refusing the shim's choice again, one layer along. So
     * `POST` is matched here and everything else falls through to the staff branch
     * below, where `perms.dashboard` and the salon predicate are what the queue is
     * actually worth testing.
     *
     * THE CONSOLE'S HALF OF THAT QUEUE cannot be selected by URL — it is not under
     * `/v1/platform/`, because api-contract.md § Operations lists ONE endpoint for
     * "Owner / Merchant". `x-avo-scenario: console` selects it, handled above the
     * `/v1/platform/` block so the two cannot disagree.
     *
     * NOT `/v1/platform/support` or `/v1/platform/policies`: those are readable
     * by any authenticated principal, so either kind resolves them, and staff
     * is the useful default there because the dashboard reads them too.
     */
    (req.method === 'POST' && req.url.startsWith('/v1/support/tickets')) ||
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
    return loadMemberPrincipal(db, memberId, TEST_SESSION_MEMBER);
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
    TEST_SESSION_STAFF,
    /**
     * NO DEVICE, because there is no session row to read one from — this shim
     * exists precisely to skip the session. The scanner limiter counts the null
     * bucket rather than exempting it, so a test build is rate limited too; what
     * it does not get is one budget PER DEVICE, since every test principal shares
     * that single bucket. See services/scannerLimit.ts.
     */
    null,
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
  //
  // The ROW rather than the predicate, because the same read carries the device
  // the scanner limiter keys on. One query, two facts — see sessions.ts
  // § `liveSession`.
  const live = await liveSession(db, claims.sid);
  if (!live) return null;

  if (claims.kind === 'platform_admin') {
    return loadPlatformPrincipal(db, claims.sub, claims.sid);
  }
  if (claims.kind === 'member') {
    return loadMemberPrincipal(db, claims.sub, claims.sid);
  }
  /**
   * A staff token with a wallet or platform scope resolves to nothing.
   * `verifyAccessToken` already refuses `platform` on a staff kind, so this is the
   * second statement of the same fact — kept because `claims.scope` is what
   * `loadStaffPrincipal` stamps on the principal, and narrowing it here is what
   * makes that parameter provably one of the two surfaces rather than a cast.
   */
  if (claims.scope !== 'scanner' && claims.scope !== 'dashboard') return null;
  return loadStaffPrincipal(db, claims.sub, claims.scope, claims.sid, live.deviceId);
}

// -------------------------------------------------------------------- guards --

export function requirePrincipal(req: FastifyRequest): Principal {
  if (!req.principal) throw unauthorized();
  return req.principal;
}

/**
 * Authenticated AND belonging to a salon — a member or a staff member, never the
 * owner console.
 *
 * THE TYPE SYSTEM ASKED FOR THIS, WHICH IS THE INTERESTING PART. Adding
 * `PlatformPrincipal` to the `Principal` union turned five call sites red at once,
 * every one of them `requireSameSalon(requirePrincipal(req), …)`:
 *
 *     routes/salons.ts   GET /salons/:id, /:id/services, /:id/products
 *     routes/artists.ts  GET /salons/:id/artists
 *     routes/platform.ts GET /v1/salons/:id/promotions
 *
 * Those routes are documented as "readable by any authenticated principal of that
 * salon", and the second half of that sentence was carried by
 * `requireSameSalon` — which could only be written because every principal
 * happened to have a `salonId`. A platform admin has none, so `requireSameSalon`
 * now takes the narrower union and these five had to say what they meant.
 *
 * Nothing about their behaviour changes: no platform principal could reach them
 * before, because none existed. What changes is that the requirement is now
 * stated rather than implied by a field that happened to be on every branch.
 *
 * A platform admin who needs to read a salon's data reads it through a console
 * route gated on the `salons` section, where crossing the tenancy boundary is the
 * declared intent rather than a consequence of an absent field.
 *
 * THOSE ROUTES NOW EXIST, and this paragraph used to end "not built yet, and that
 * is reported rather than papered over here". Reported is not the same as
 * harmless: for as long as it was true, the refusal below pointed a console admin
 * at a Salons section that had no remedy in it — `GET /salons/:id` 403,
 * `PATCH /salons/:id` 403, `GET /v1/platform/salons/:id` 404, three doors and no
 * way in. Lane C drew no Manage button rather than ship a control that only 403s,
 * which is the only reason nobody hit it. The message is true now:
 * `GET`/`PATCH /v1/platform/salons/{id}` in `routes/platformConsole.ts`.
 */
export function requireSalonScoped(req: FastifyRequest): MemberPrincipal | StaffPrincipal {
  const p = requirePrincipal(req);
  if (p.kind === 'platform_admin') {
    throw forbidden(
      'This endpoint belongs to a salon. Open it from the console\u2019s Salons section.',
    );
  }
  return p;
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
  /**
   * STALE SINCE THE LOYALTY AUTHORITY REVERSAL, AND LEFT ALONE ON PURPOSE.
   *
   * A merchant without this permission can no longer "change loyalty settings"
   * WITH it either, so the sentence now describes a capability that does not
   * exist. The accurate refusal for a withdrawn capability is
   * `loyaltyReadOnly()` — a different code, on the endpoints that withdrew it.
   * This string is what remains: the refusal for someone who may not SEE the
   * Loyalty screen, plus the Settings writes listed on `StaffPerms.loyalty`.
   *
   * NOT REWRITTEN HERE because it is verbatim design copy asserted in four
   * places — `e2e/authority.test.ts:112`, `e2e/permission-census.test.ts:102`,
   * `apps/dashboard/src/routes/Settings.tsx:80` and `http/errors.ts` — three of
   * which are outside this lane's column. Rewording it is a trunk change that
   * lands with the `perms.settings` rename it belongs to. Reported.
   */
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

/**
 * A staff member or a member may only ever act inside their own salon.
 *
 * TAKES A SALON-SCOPED PRINCIPAL, NOT `Principal`. `PlatformPrincipal` has no
 * `salonId` field at all, so passing one here does not compile — which is the
 * point: an owner-console route calling this would either always throw or, with a
 * nullable field, silently pass. A platform admin's boundary is
 * `requirePlatform`, and it is a different question.
 */
export function requireSameSalon(
  principal: MemberPrincipal | StaffPrincipal,
  salonId: string,
): void {
  if (principal.salonId !== salonId) {
    throw forbidden('That salon is not yours.');
  }
}

// ------------------------------------------------------- the platform gate --

/**
 * Copy for a refused section. Named like `PERMISSION_COPY`, and pointed in the
 * same direction: it tells the reader who can grant it. The console's admins are
 * a short list, so "the platform owner" is a real answer rather than a shrug.
 */
const SECTION_COPY: Record<PlatformSection, string> = {
  analytics: 'Your console account cannot open Analytics. The platform owner can grant it.',
  activity: 'Your console account cannot open Activity. The platform owner can grant it.',
  salons: 'Your console account cannot open Salons. The platform owner can grant it.',
  accounts: 'Your console account cannot open Accounts. The platform owner can grant it.',
  admins: 'Your console account cannot manage admins. The platform owner can grant it.',
  controls: 'Your console account cannot change platform controls. The platform owner can grant it.',
  approvals:
    'Your console account cannot decide campaigns. The platform owner can grant it.',
  policies:
    'Your console account cannot edit or publish policies. The platform owner can grant it.',
  audit: 'Your console account cannot read the platform audit log. The platform owner can grant it.',
};

/** Authenticated on the owner console, whatever section. */
export function requirePlatformScope(req: FastifyRequest): PlatformPrincipal {
  const p = requirePrincipal(req);
  if (p.kind !== 'platform_admin') {
    /**
     * A MERCHANT CREDENTIAL MUST NOT REACH AN OWNER ROUTE, and the refusal names
     * the surface rather than the authority — a manager who lands here is confused,
     * not attacking, exactly as `SURFACE_COPY` reasons for the scanner/dashboard
     * wall. Lane D has the inverse test written down as owed in
     * `e2e/tenancy.test.ts`: "when it lands, every one of its endpoints needs the
     * inverse test — a merchant credential must not reach an owner route".
     */
    throw forbidden('This endpoint is the AVO owner console, not the salon dashboard.');
  }
  return p;
}

/**
 * THE platform gate. First statement of every `/v1/platform/*` handler that is
 * not a customer read.
 *
 * `section` has no default, for the reason `StaffSurface` has none: a default
 * here would be a default answer to a security question. Every caller names the
 * section it belongs to, so a new console endpoint cannot be ungated by accident
 * — only on purpose, by calling `requirePlatformScope` and being seen to.
 */
export function requirePlatform(
  req: FastifyRequest,
  section: PlatformSection,
): PlatformPrincipal {
  const p = requirePlatformScope(req);
  if (!p.sections[section]) throw forbidden(SECTION_COPY[section]);
  return p;
}

/** Every section name, for the admins editor and for tests that sweep them. */
export { PLATFORM_SECTIONS };
export type { PlatformSection, PlatformRole };
