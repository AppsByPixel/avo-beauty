import type { StaffPerms } from '@avo/types';
import { SCOPES, isAuthScope, type AuthScope } from './scopes.js';

/**
 * The signed-in session.
 *
 * Non-negotiable #6: a password is never stored, never returned by an endpoint,
 * never shown in a UI. Nothing on this shape can hold one, and the sign-in form
 * clears the field the moment it submits.
 *
 * Non-negotiable #7: `perms` here drives what the UI *shows*. It is a courtesy.
 * Every gated call is enforced again server-side, and a 403 renders as an
 * explain-state rather than a retry — see ErrorState.
 *
 * `salonId` IS REQUIRED AND IT COMES FROM THE SERVER. It is `staff.salonId` off
 * the `POST /auth/web/session` response, which the API reads from the staff row
 * rather than echoing the `salonId` the sign-in form sent. A session object
 * cannot exist without one: `isStoredSession` rejects it on the way out of
 * storage and `signIn` rejects it on the way in. There is no fallback to guess
 * with — a session with no salon is an authentication failure and the caller
 * signs out.
 */
export interface Session {
  scope: AuthScope;
  /** Short-lived JWT, ~15 minutes. Sent as the bearer on every request. */
  accessToken: string;
  /** Opaque, single-use, rotates on every refresh. Never sent as a bearer. */
  refreshToken: string;
  /**
   * ISO expiry of the REFRESH token (~30 days), which is what the API's
   * `expiresAt` actually is. It is not the access token's expiry, so it cannot
   * be used to refresh ahead of time — see refresh.ts.
   */
  refreshExpiresAt: string;
  staffId: string;
  username: string;
  displayName: string;
  salonId: string;
  perms: StaffPerms;
}

interface StoredSession extends Session {
  /** Which store it came from, so a rotation writes back to the same one. */
  persistent: boolean;
}

function stores(): Storage[] {
  if (typeof window === 'undefined') return [];
  return [window.localStorage, window.sessionStorage];
}

function isStoredSession(value: unknown): value is StoredSession {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    isAuthScope(v['scope']) &&
    typeof v['accessToken'] === 'string' &&
    typeof v['refreshToken'] === 'string' &&
    typeof v['username'] === 'string' &&
    typeof v['refreshExpiresAt'] === 'string' &&
    // The whole point of this change: no salon, no session.
    typeof v['salonId'] === 'string' &&
    v['salonId'].length > 0
  );
}

export function readSession(scope: AuthScope): Session | null {
  const key = SCOPES[scope].storageKey;
  for (const store of stores()) {
    const raw = store.getItem(key);
    if (!raw) continue;
    try {
      const parsed: unknown = JSON.parse(raw);
      // A refresh token past its expiry cannot mint anything. Drop the whole
      // session here rather than letting the first request discover it.
      if (isStoredSession(parsed) && Date.parse(parsed.refreshExpiresAt) > Date.now()) {
        return parsed;
      }
    } catch {
      // A corrupt entry is not a session. Drop it rather than crashing the shell.
    }
    store.removeItem(key);
  }
  return null;
}

/** Which store the session is living in, so a rotation does not migrate it. */
function storeFor(scope: AuthScope): Storage | null {
  const key = SCOPES[scope].storageKey;
  for (const store of stores()) if (store.getItem(key) !== null) return store;
  return null;
}

/**
 * `keep` is the "Keep me signed in" toggle from AVO Login.dc.html. Off means the
 * session dies with the tab, which is what a shared front-desk machine needs.
 */
export function writeSession(session: Session, keep: boolean): void {
  const key = SCOPES[session.scope].storageKey;
  clearSession(session.scope, { silent: true });
  const store = keep ? window.localStorage : window.sessionStorage;
  const stored: StoredSession = { ...session, persistent: keep };
  store.setItem(key, JSON.stringify(stored));
  notify(session.scope);
}

/**
 * Write back a rotated token pair without moving the session between stores.
 * "Keep me signed in" was answered at sign-in; a refresh must not quietly
 * promote a tab-lifetime session to a persistent one.
 */
export function updateSession(session: Session): void {
  const key = SCOPES[session.scope].storageKey;
  const store = storeFor(session.scope);
  // No row to update means the session was signed out underneath the rotation.
  // Writing one back would resurrect it.
  if (!store) return;
  const persistent = store === window.localStorage;
  const stored: StoredSession = { ...session, persistent };
  store.setItem(key, JSON.stringify(stored));
  notify(session.scope);
}

export function clearSession(scope: AuthScope, options: { silent?: boolean } = {}): void {
  const key = SCOPES[scope].storageKey;
  for (const store of stores()) store.removeItem(key);
  if (!options.silent) notify(scope);
}

/* -------------------------------------------------------------- subscription */

/**
 * Session changes have three sources and every one of them has to reach React:
 *
 *   1. this tab signing in or out          — `notify`, below
 *   2. this tab rotating a refresh token   — `updateSession`, called from the
 *      API layer rather than from an event handler, which is why the store owns
 *      the subscription instead of AuthProvider owning the only copy
 *   3. ANOTHER TAB doing either            — the `storage` event
 *
 * (3) is easy to skip and expensive to skip. Two dashboard tabs on a front-desk
 * machine share `localStorage`; signing out in one leaves the other rendering a
 * shell for a session that no longer exists until its next request 401s.
 */
type Listener = (scope: AuthScope) => void;

const listeners = new Set<Listener>();
const ALL_SCOPES = Object.keys(SCOPES) as AuthScope[];

function notify(scope: AuthScope): void {
  for (const listener of [...listeners]) listener(scope);
}

export function subscribeToSessions(listener: Listener): () => void {
  listeners.add(listener);

  const onStorage = (event: StorageEvent) => {
    // `key === null` is storage.clear() in another tab — every scope is suspect.
    if (event.key === null) {
      for (const scope of ALL_SCOPES) listener(scope);
      return;
    }
    for (const scope of ALL_SCOPES) {
      if (SCOPES[scope].storageKey === event.key) listener(scope);
    }
  };

  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}
