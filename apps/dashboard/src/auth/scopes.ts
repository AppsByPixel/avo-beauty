/**
 * Auth scopes.
 *
 * ADR-0001: "The owner console is *the same application* with a different auth
 * scope and shell, not a second app. It is deferred out of the 30 days, but the
 * routing and permission structure is built to accept it from day one so adding
 * it later is not a refactor."
 *
 * This file is that structure. Adding the console means adding the `owner` rows
 * below (already present), a shell component, and its routes under `/console` —
 * not a second sign-in flow, a second session store, or a second router.
 */

export const AUTH_SCOPES = ['merchant', 'owner'] as const;
export type AuthScope = (typeof AUTH_SCOPES)[number];

export interface ScopeConfig {
  id: AuthScope;
  /** Where the router sends a signed-in session of this scope. */
  home: string;
  /** Where the router sends an unauthenticated request for this scope's routes. */
  signIn: string;
  /** The route prefix the scope's shell owns. */
  prefix: string;
  /** Light merchant workspace vs. dark platform console — AVO Login.dc.html 5a/5b. */
  theme: 'light' | 'dark';
  /** Storage key. Distinct per scope so signing out of one keeps the other. */
  storageKey: string;
}

export const SCOPES: Record<AuthScope, ScopeConfig> = {
  merchant: {
    id: 'merchant',
    home: '/overview',
    signIn: '/signin',
    prefix: '/',
    theme: 'light',
    storageKey: 'avo.session.merchant',
  },
  /**
   * BUILT. Sign-in, the shell, Approvals and Policies are live; the other eight
   * sections resolve to a named placeholder because the console design draws them
   * and their endpoints do not exist yet.
   *
   * `home` is Approvals rather than the design's Salons, and deliberately: Salons
   * has no endpoint, so landing a freshly signed-in admin there would open the
   * console on "isn't built yet". Approvals is the section that actually needs
   * watching — it is the one thing standing between a salon and a customer's
   * phone.
   *
   * THIS IS A BLOCKED ITEM, NOT A DEFERRED ONE, AND THE DIFFERENCE IS WRITTEN
   * DOWN HERE BECAUSE A MISSING GATE AND A GATE NOBODY NEEDED LOOK IDENTICAL.
   *
   * Phase 7 was checked against `api/src` on 2026-08-19, not against
   * api-contract.md. The console is blocked at its own front door: there is no
   * platform principal on the server at all.
   *
   *   api/src/auth/tokens.ts    `PrincipalKind = 'member' | 'staff'`
   *                             `SessionScope  = 'wallet' | 'scanner' | 'dashboard'`
   *   api/src/auth/principal.ts `Principal = MemberPrincipal | StaffPrincipal`
   *   api/src/db/schema/        no platform_admin table
   *   packages/types            no PlatformAdmin entity
   *
   * So `POST /auth/web/session` can only ever mint a salon-scoped `dashboard`
   * staff session, and every `/v1/platform/*` route that exists today is gated
   * by `requireDashboardPerm(req, 'marketing')` + `requireSameSalon` — a
   * MERCHANT credential. An owner console signing in against that would either
   * be a salon manager wearing a different shell, or a second sign-in flow
   * invented here against an endpoint that does not exist.
   *
   * The second is what `LANES.md` § "Order of work" records as already having
   * gone wrong once — "Running it *ahead* of the API is what produced the
   * throwaway sign-in stand-in that had to be rewritten." So this stays
   * declared until the server has a principal to authenticate.
   *
   * WHAT IS MISSING, endpoint by endpoint, for whoever unblocks it:
   *
   *   auth        no platform session endpoint, no platform_admin row to
   *               authenticate against, no `platform` SessionScope
   *   Approvals   GET  /v1/platform/campaigns?status=pending   mock only, not the API
   *               POST /v1/platform/campaigns/{cid}/decision   nowhere
   *               PATCH /v1/platform/messaging-policy          nowhere
   *   Policies    GET  /v1/platform/policies answers `{ published }` only; the
   *               console needs `{ published, draft }` (api-contract.md:464)
   *               PATCH/POST/DELETE .../policies/draft…        nowhere
   *               POST .../policies/publish, .../discard       nowhere
   *   Analytics   GET  /platform/metrics                       nowhere
   *   Audit       platform-wide read; only salon-scoped
   *               `GET /salons/{id}/audit` exists
   *   Admins      no platform_admin table, so no authority editor
   *   Controls    PATCH /platform/settings                     nowhere
   *
   * One thing DOES already anticipate the console, and it is worth knowing:
   * `audit_log.actor_kind` includes `platform_admin`, and the seed writes rows
   * with it. `services/audit.ts::actorOf()` cannot produce that value from any
   * principal that exists — the schema is ready and the write path is not.
   */
  owner: {
    id: 'owner',
    home: '/console/approvals',
    signIn: '/console/signin',
    prefix: '/console',
    theme: 'dark',
    storageKey: 'avo.session.owner',
  },
};

export function isAuthScope(value: unknown): value is AuthScope {
  return typeof value === 'string' && (AUTH_SCOPES as readonly string[]).includes(value);
}
