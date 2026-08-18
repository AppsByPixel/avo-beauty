import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  signIn as signInRequest,
  signInToConsole as signInToConsoleRequest,
  signOut as signOutRequest,
  type ConsoleCredentials,
  type Credentials,
} from './api.js';
import { AUTH_SCOPES, type AuthScope } from './scopes.js';
import {
  readSession,
  subscribeToSessions,
  writeSession,
  type MerchantSession,
  type OwnerSession,
  type Session,
} from './session.js';
import type { PlatformSections } from './platformAdmin.js';

export interface AuthState {
  /** Sessions by scope. A merchant session and an owner session can coexist. */
  sessions: Partial<Record<AuthScope, Session>>;
  sessionFor: (scope: AuthScope) => Session | null;
  /*
   * Returns the MEMBER of the union, not the union. A caller that has just signed
   * a merchant in knows it holds a merchant session, and `SignIn.tsx` reads
   * `session.salonId` off the result — which does not exist on an owner session
   * and should not have to be narrowed for.
   */
  signIn: (
    scope: 'merchant',
    credentials: Credentials,
    keepSignedIn: boolean,
  ) => Promise<MerchantSession>;
  /**
   * The console's sign-in. Separate because the credential is a PAIR — no salon
   * — and the endpoint returns a different body. See auth/api.ts.
   */
  signInToConsole: (
    credentials: ConsoleCredentials,
    keepSignedIn: boolean,
  ) => Promise<OwnerSession>;
  /** Revokes server-side, then clears locally. Awaitable so a UI can show it. */
  signOut: (scope: AuthScope) => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

function hydrate(): Partial<Record<AuthScope, Session>> {
  const next: Partial<Record<AuthScope, Session>> = {};
  for (const scope of AUTH_SCOPES) {
    const session = readSession(scope);
    if (session) next[scope] = session;
  }
  return next;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [sessions, setSessions] = useState<Partial<Record<AuthScope, Session>>>(hydrate);
  const queryClient = useQueryClient();

  /*
   * The store, not this component, is the source of truth.
   *
   * React state cannot be it: a token rotation happens inside `authedRequest`,
   * three layers below any component and often while no component is rendering.
   * A sign-out in a second tab happens in no component at all. Both write to the
   * store; this subscription is how they reach the tree.
   *
   * Re-reading rather than taking a payload keeps one parser and one place where
   * "expired refresh token" and "corrupt entry" mean the same thing: no session.
   */
  useEffect(() => {
    return subscribeToSessions((scope) => {
      setSessions((current) => {
        const session = readSession(scope);
        if (session === null && !(scope in current)) return current;
        const next = { ...current };
        if (session) next[scope] = session;
        else delete next[scope];
        return next;
      });
    });
  }, []);

  /*
   * A SESSION CHANGE EMPTIES THE QUERY CACHE.
   *
   * Found by signing Hessa in after Noura on the same browser: `perms.dashboard`
   * is off for Hessa, the API correctly answered 403 to both Overview calls —
   * and the screen rendered Noura's figures and her charge list anyway, because
   * the cache is keyed by salon and both women work at SAL-AMARA. A permission
   * gate the server enforced perfectly was undone by a client-side cache.
   *
   * That is the shared front-desk machine this codebase keeps designing for. The
   * cache is per-salon on purpose, but a salon is not a principal: two staff at
   * one salon see different things, and the cache cannot tell them apart.
   *
   * `clear()` rather than `invalidateQueries()`. Invalidating marks data stale
   * and keeps serving it while a refetch runs, which is exactly the frame where
   * the wrong person is looking at it.
   */
  const adopt = useCallback(
    <T extends Session>(session: T, keepSignedIn: boolean): T => {
      queryClient.clear();
      writeSession(session, keepSignedIn);
      setSessions((current) => ({ ...current, [session.scope]: session }));
      return session;
    },
    [queryClient],
  );

  const signIn = useCallback(
    async (scope: 'merchant', credentials: Credentials, keepSignedIn: boolean) => {
      const session = await signInRequest(scope, credentials);
      return adopt(session, keepSignedIn);
    },
    [adopt],
  );

  /*
   * The two scopes coexist: signing in to the console does NOT clear a merchant
   * session, because `writeSession` is keyed per scope and `SCOPES[].storageKey`
   * differs. That is deliberate — an AVO founder debugging a salon's workspace
   * keeps both tabs alive. `queryClient.clear()` still runs on each sign-in,
   * which is the important half: cached data from whoever was here before must
   * not be served for a frame to whoever just arrived.
   */
  const signInToConsole = useCallback(
    async (credentials: ConsoleCredentials, keepSignedIn: boolean) => {
      const session = await signInToConsoleRequest(credentials);
      return adopt(session, keepSignedIn);
    },
    [adopt],
  );

  const signOut = useCallback(
    async (scope: AuthScope) => {
      // Drop it from the tree first. The shell must leave immediately — the
      // server round-trip can take a second on a bad connection and a dashboard
      // that stays up after the click looks like the click did nothing.
      // `signOutRequest` reads the token from the store, which still holds it.
      setSessions((current) => {
        const next = { ...current };
        delete next[scope];
        return next;
      });
      queryClient.clear();
      await signOutRequest(scope);
    },
    [queryClient],
  );

  const value = useMemo<AuthState>(
    () => ({
      sessions,
      sessionFor: (scope) => sessions[scope] ?? null,
      signIn,
      signInToConsole,
      signOut,
    }),
    [sessions, signIn, signInToConsole, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside <AuthProvider>.');
  return context;
}

/**
 * The session for a scope, or a throw. Use inside a scope-guarded route.
 *
 * OVERLOADED ON THE SCOPE, so the return type is the right member of the union
 * rather than the union itself. Without this every caller would have to narrow a
 * `Session` it already knows the shape of, and — worse — `useSalonId` below
 * would compile against an `OwnerSession` that has no salon. The overloads make
 * the scope argument and the returned shape one decision.
 */
export function useSession(scope: 'merchant'): MerchantSession;
export function useSession(scope: 'owner'): OwnerSession;
export function useSession(scope: AuthScope): Session;
export function useSession(scope: AuthScope): Session {
  const session = useAuth().sessionFor(scope);
  if (!session) throw new Error(`No ${scope} session. This route must sit behind requireScope().`);
  return session;
}

/**
 * The console admin's section grants.
 *
 * The mirror of `useSalonId` for the other scope, and a courtesy in exactly the
 * same way `session.perms` is: every one of these nine is enforced again by
 * `requirePlatform` server-side, so hiding a sidebar item is a convenience and
 * never the control. #7.
 */
export function useConsoleSections(): PlatformSections {
  return useSession('owner').sections;
}

/**
 * THE salon accessor. Every salon-scoped path in the dashboard is built from
 * this and from nothing else.
 *
 * One accessor is the whole point. The alternative — each screen reaching for a
 * salon id its own way — is how a constant like the old `FALLBACK_SALON_ID`
 * survives in four call sites after being deleted from the fifth. There is one
 * place this can be wrong, and it is six lines long.
 *
 * It cannot return an empty value: `MerchantSession.salonId` is a required
 * string, rejected at the sign-in boundary and again when read back out of
 * storage. A session with no salon is an authentication failure, not a case to
 * default.
 *
 * AND IT CANNOT BE CALLED FOR THE CONSOLE AT ALL. `OwnerSession` has no
 * `salonId` — the platform principal has none either, deliberately — so the
 * overload above makes `useSession('owner').salonId` a type error rather than an
 * `undefined` that reaches a URL as the string "undefined". Which salon the
 * console is looking at is a route parameter an admin chose, never a property of
 * the credential.
 */
export function useSalonId(): string {
  return useSession('merchant').salonId;
}
