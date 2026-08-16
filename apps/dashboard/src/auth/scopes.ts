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
   * Declared, not built. Lane C's brief is explicit: structure for it, do not
   * build it. Nothing routes to `/console` yet.
   */
  owner: {
    id: 'owner',
    home: '/console/salons',
    signIn: '/console/signin',
    prefix: '/console',
    theme: 'dark',
    storageKey: 'avo.session.owner',
  },
};

export function isAuthScope(value: unknown): value is AuthScope {
  return typeof value === 'string' && (AUTH_SCOPES as readonly string[]).includes(value);
}
