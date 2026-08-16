/**
 * Who is signed in, what they may do, and the token every request carries.
 *
 * Two rules shape this file:
 *
 * 1. **Perms are re-read, not remembered.** api-contract.md § StaffUser: the
 *    scanner "must re-read [perms] on change". `refreshPerms()` is called when
 *    the app returns to the foreground and before the gated screens open, so a
 *    manager granting `charges` mid-shift takes effect without a sign-out.
 *
 * 2. **The client's copy of `perms` is a courtesy.** Non-negotiable #7. It
 *    decides which tile shows a padlock; it never decides whether a request is
 *    allowed. Every gated call still goes to the server and every 403 is
 *    rendered. `ChargesScreen` proves this deliberately.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { AppState } from 'react-native';
import { fetchMe, signIn, type PinCredentials, type StaffSession, type StaffUser } from '../api/staff';
import { ApiError } from '../api/client';

interface SessionValue {
  session: StaffSession | null;
  staff: StaffUser | null;
  /** Convenience for the tiles. Never a substitute for the server's answer. */
  can: (perm: keyof StaffUser['perms']) => boolean;
  signInWithPin: (credentials: PinCredentials) => Promise<void>;
  signOut: () => void;
  refreshPerms: () => Promise<void>;
  /**
   * Report a failed request so the shell can react to a dead session.
   *
   * A 401 means the session is gone — expired, revoked from the dashboard, or
   * cleared server-side. Every screen that moves money calls this on failure,
   * because the alternative is what the first simulator run showed: the raw
   * string "Sign in to continue." printed under the service chips while the
   * artist stares at a Charge button that can no longer work. Dropping to the
   * PIN screen is the honest response — the remedy is to sign in again.
   *
   * Returns true when the session was ended, so the caller can skip rendering
   * an error for a screen that is about to be replaced.
   */
  reportFailure: (err: unknown) => boolean;
}

const Ctx = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<StaffSession | null>(null);
  const sessionRef = useRef<StaffSession | null>(null);
  sessionRef.current = session;

  const signInWithPin = useCallback(async (credentials: PinCredentials) => {
    // Errors propagate: PinScreen distinguishes a refusal from a lockout from
    // an offline device, and swallowing them here would flatten all three.
    const next = await signIn(credentials);
    setSession(next);
  }, []);

  const signOut = useCallback(() => {
    setSession(null);
  }, []);

  const refreshPerms = useCallback(async () => {
    const current = sessionRef.current;
    if (!current) return;
    try {
      const staff = await fetchMe(current.accessToken);
      setSession({ ...current, staff });
    } catch (err) {
      // A revoked or expired session drops us back to the PIN screen rather
      // than leaving a signed-in shell whose every action will 401.
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        setSession(null);
        return;
      }
      // Anything else — offline, a 500 — keeps the last-known authority. The
      // server is still the control on every call, so a stale `perms` here
      // cannot authorise anything.
    }
  }, []);

  // Re-read authority when the phone comes back to the foreground. A scanner
  // sits on a counter between customers; that is exactly when a manager changes
  // a permission in the dashboard.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void refreshPerms();
    });
    return () => sub.remove();
  }, [refreshPerms]);

  const reportFailure = useCallback((err: unknown): boolean => {
    // 401 only. A 403 is a live session without the authority for one endpoint
    // — the locked screen's whole job — and signing the artist out for it would
    // turn a permission she does not have into a sign-in loop.
    if (err instanceof ApiError && err.status === 401) {
      setSession(null);
      return true;
    }
    return false;
  }, []);

  const value = useMemo<SessionValue>(
    () => ({
      session,
      staff: session?.staff ?? null,
      can: (perm) => session?.staff.perms[perm] === true,
      signInWithPin,
      signOut,
      refreshPerms,
      reportFailure,
    }),
    [session, signInWithPin, signOut, refreshPerms, reportFailure],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(Ctx);
  if (!value) throw new Error('useSession must be used inside a SessionProvider');
  return value;
}

/**
 * The access token, for a screen that is certain it is signed in.
 * Throws rather than sending an unauthenticated request that would 401 anyway.
 */
export function useAccessToken(): string {
  const { session } = useSession();
  if (!session) throw new Error('No staff session');
  return session.accessToken;
}
