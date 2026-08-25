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
   * BUILT, and nine of its ten sections now read from the API.
   *
   * Analytics, Activity, Salons (with the per-salon editor), Accounts, Admins,
   * Approvals, Policies, Audit log and Controls are live. Billing alone resolves
   * to `NotBuiltYet`.
   *
   * `home` IS APPROVALS AND STAYS APPROVALS, but only half the original reason
   * survives. It used to read "rather than the design's Salons… Salons has no
   * endpoint, so landing a freshly signed-in admin there would open the console on
   * 'isn't built yet'." That is spent — Salons has `GET /v1/platform/salons`, an
   * editor and an onboarding wizard. The reason that still holds is the second
   * one: Approvals is the section that actually needs watching, because it is the
   * one thing standing between a salon and a customer's phone (non-negotiable #8 —
   * a merchant cannot send a customer message; `POST /campaigns` only creates
   * `pending`, and delivery happens on the platform decision endpoint).
   *
   * =========================================================================
   * WHAT THIS COMMENT USED TO SAY, AND WHY IT IS WORTH ONE PARAGRAPH
   * =========================================================================
   * Roughly sixty lines here explained that the console COULD NOT BE BUILT: no
   * platform principal on the server, no `platform_admin` table, no session
   * endpoint, and an endpoint-by-endpoint list of everything Approvals, Policies,
   * Analytics, Audit, Admins and Controls were missing. It was accurate when it
   * was written and dated itself honestly — "checked against `api/src` on
   * 2026-08-19".
   *
   * Every blocking claim in it is now false, and it was contradicted by this
   * file's own neighbours long before anyone reread it: `ConsoleShell`, nine built
   * sections and `consoleNavGates.test.ts` all sit on top of the principal it said
   * did not exist. Verified one at a time before deleting it:
   *
   *   PrincipalKind        includes 'platform_admin'   auth/tokens.ts:26
   *   SessionScope         includes 'platform'         auth/tokens.ts:27
   *   Principal            includes PlatformPrincipal  auth/principal.ts:156
   *   platform_admin       the table exists            db/schema/platformAdmin.ts
   *   the session endpoint POST /auth/platform/session routes/auth.ts:583
   *
   * and every route on its "WHAT IS MISSING" list is registered today — the
   * campaigns decision, the messaging policy, the four policy-draft routes,
   * `/v1/platform/metrics`, `/v1/platform/audit`, `/v1/platform/admins` and
   * `/v1/platform/settings`.
   *
   * THE MECHANISM, WHICH IS THE PART THAT RECURS: a comment cannot fail a build.
   * This is the fifth stale explanation found in this build and the second in this
   * lane's own files; the Salons nav item carried one for eight weeks that shipped
   * a real defect in both directions at once. The remedy that worked there is a
   * DERIVED test, not a better comment — `consoleNavGates.test.ts` reads the gates
   * out of `api/src/routes/` so no one has to keep them in their head. There is no
   * equivalent guard for a prose paragraph, which is exactly why this one is being
   * kept short.
   *
   * TWO THINGS FROM THE OLD NOTE ARE STILL TRUE and are kept rather than deleted
   * with the rest:
   *
   *   `packages/types` HAS NO `PlatformAdmin` ENTITY. The console's admin shape
   *   lives in `auth/platformAdmin.ts` on this side and `db/schema/platformAdmin.ts`
   *   on the server, and the two are not derived from one another. `packages/types`
   *   is trunk-owned, so this lane cannot close it — it is named here so the gap is
   *   visible rather than assumed handled.
   *
   *   `LANES.md` § "Order of work" — "Running it *ahead* of the API is what
   *   produced the throwaway sign-in stand-in that had to be rewritten." That is a
   *   rule about sequencing, not a claim about the API, so nothing falsified it.
   *   It is why this lane builds a section only once its endpoint exists, which is
   *   why Billing is still `NotBuiltYet`: no trial, subscription or invoice column
   *   exists anywhere in the schema and the design's figures are prototype
   *   fixtures. Queued as `DECISIONS.md` #15 — blocked, not deferred.
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
