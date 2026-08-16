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
 */
export interface Session {
  scope: AuthScope;
  token: string;
  username: string;
  displayName: string;
  /** Present on a merchant session; the owner scope spans every salon. */
  salonId: string | null;
  perms: StaffPerms | null;
}

interface StoredSession extends Session {
  /** Which store it came from, so signOut clears the right one. */
  persistent: boolean;
}

function stores(): Storage[] {
  if (typeof window === 'undefined') return [];
  return [window.localStorage, window.sessionStorage];
}

function isSession(value: unknown): value is StoredSession {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return isAuthScope(v['scope']) && typeof v['token'] === 'string' && typeof v['username'] === 'string';
}

export function readSession(scope: AuthScope): Session | null {
  const key = SCOPES[scope].storageKey;
  for (const store of stores()) {
    const raw = store.getItem(key);
    if (!raw) continue;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isSession(parsed)) return parsed;
    } catch {
      // A corrupt entry is not a session. Drop it rather than crashing the shell.
    }
    store.removeItem(key);
  }
  return null;
}

/**
 * `keep` is the "Keep me signed in" toggle from AVO Login.dc.html. Off means the
 * session dies with the tab, which is what a shared front-desk machine needs.
 */
export function writeSession(session: Session, keep: boolean): void {
  const key = SCOPES[session.scope].storageKey;
  clearSession(session.scope);
  const store = keep ? window.localStorage : window.sessionStorage;
  const stored: StoredSession = { ...session, persistent: keep };
  store.setItem(key, JSON.stringify(stored));
}

export function clearSession(scope: AuthScope): void {
  const key = SCOPES[scope].storageKey;
  for (const store of stores()) store.removeItem(key);
}
