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
import type { SessionEndReason } from './signInSearch.js';
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
  /**
   * WHY THIS SCOPE'S SESSION ENDED, IF IT IS WORTH TELLING HER.
   *
   * `null` for the two cases that want silence, and they are different cases:
   * she pressed Sign out (she knows), or there was no session to lose in the
   * first place (she is simply arriving). Both render nothing, so neither needs
   * a word of its own — see `signInSearch.ts` for that argument.
   *
   * READ BY THE TWO SHELLS AND BY NOTHING ELSE. It is the argument to the
   * redirect, not a fact any screen consults: non-negotiable #7 means nothing
   * about a cause may become the basis for an access decision, and the way to
   * keep that true is for the value to have exactly one destination -
   * `InlineError`'s `message`, via the URL.
   */
  endedReasonFor: (scope: AuthScope) => SessionEndReason | null;
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

/**
 * ====================================================================
 * WHY THE SESSIONS AND THE REASONS ARE ONE PIECE OF STATE
 * ====================================================================
 * The reason is not a fact about a session. It is a fact about a TRANSITION -
 * "this scope had one a moment ago and now does not, and here is which of the
 * three things happened". A transition can only be read where the before and
 * the after are both in hand, which is inside one updater over one object.
 *
 * Two `useState`s would mean deciding the reason outside an updater, from a
 * `sessions` value that may already be stale, or — worse — calling `setEnded`
 * from inside `setSessions`, which is a side effect in a function React is
 * allowed to invoke twice. Under StrictMode it IS invoked twice.
 *
 * So: one object, one updater per event, and every updater stays pure.
 */
interface SessionState {
  sessions: Partial<Record<AuthScope, Session>>;
  /**
   * Why each scope's session ended, WHERE THERE IS SOMETHING TO SAY. A
   * deliberate sign-out is the absence of an entry.
   *
   * =====================================================================
   * WHAT KEEPS A DELIBERATE SIGN-OUT SILENT, AND WHAT DOES NOT
   * =====================================================================
   * A sign-out passes through the same store clear as an expiry. The click's
   * handler drops the session from this state first ("the shell must leave
   * immediately"), and `auth/api.ts`'s `signOut` then calls `clearSession` in
   * its `finally`, which notifies exactly the way a 401-driven clear does.
   * Nothing downstream of that notification can tell the two apart.
   *
   * WHAT TELLS THEM APART IS THAT THE REASON IS READ ONCE, ON THE CLICK'S OWN
   * COMMIT, AND THEN LEAVES REACT ALTOGETHER. `signOut` drops the session
   * synchronously; the shell's effect runs on that commit, finds no entry here,
   * and writes a sign-in URL with no `reason` in it. `signOutRequest` is still
   * awaiting a network round trip at that point, so the `clearSession` in its
   * `finally` lands afterwards — against a shell that has unmounted and a URL
   * that is already fixed. The screen renders from the URL, so a late write
   * here has nothing left to reach.
   *
   * ============ TWO THINGS THIS COMMENT USED TO CLAIM, AND DID NOT DO =========
   * Both were removed because MUTATING THEM CHANGED NOTHING, which is the only
   * evidence that settles a claim like this:
   *
   *   A THIRD VALUE, `'signed-out'`, written on the click. The comment called it
   *   "the load-bearing part of this whole file". Deleting the write turned no
   *   spec red. Gone.
   *
   *   THE EARLY RETURN in the subscription below, which the replacement comment
   *   then called "the whole of the distinction". Deleting THAT turned no spec
   *   red either, for the reason above: by the time it would matter, the
   *   sentence has already been decided. It is kept — it predates this change,
   *   it correctly refuses to write a reason for a scope nobody was holding, and
   *   it is the thing that would matter if the shell were still mounted — but
   *   it is NOT what the deliberate-sign-out spec is testing, and no spec in
   *   this repo currently distinguishes it from its absence. Said plainly here
   *   rather than asserted as a mechanism for a third time.
   */
  ended: Partial<Record<AuthScope, SessionEndReason>>;
}

function hydrate(): SessionState {
  const sessions: Partial<Record<AuthScope, Session>> = {};
  for (const scope of AUTH_SCOPES) {
    const session = readSession(scope);
    if (session) sessions[scope] = session;
  }
  /*
   * NO REASON ON A COLD START, and this is the case that makes the reason
   * transient state rather than something stored beside the session.
   *
   * `readSession` drops — and `removeItem`s — an entry whose refresh token is
   * past its expiry. A merchant opening the dashboard after a month away is
   * therefore indistinguishable, at this point, from one who has never signed in
   * on this machine. Telling the second one "your session expired" is a sentence
   * about somebody else, so neither is told anything: nobody was signed out
   * while looking at the screen, which is the event the sentence describes.
   */
  return { sessions, ended: {} };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>(hydrate);
  const sessions = state.sessions;
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
    return subscribeToSessions((scope, origin) => {
      setState((current) => {
        const session = readSession(scope);
        const had = scope in current.sessions;
        if (session === null && !had) return current;

        const sessions = { ...current.sessions };
        const ended = { ...current.ended };
        if (session) {
          sessions[scope] = session;
          // A live session has not ended. Clearing the reason here is what stops
          // a sentence about the last sign-out surviving into the next one.
          delete ended[scope];
        } else {
          delete sessions[scope];
          /*
           * THE THREE CAUSES RESOLVE HERE, AND THIS LINE IS TWO OF THEM.
           *
           *   other-tab  the `storage` event. Nothing in this tab did it, so it
           *              is the second-tab sign-out MerchantShell's comment has
           *              named as a distinct case since before it had one.
           *   this-tab   a `clearSession` from `authedRequest`'s rotate-retry or
           *              from `refresh.ts`. Both mean the same thing to the
           *              merchant — the refresh would not mint, and the session
           *              is finished.
           *
           * The third — the deliberate click — does not depend on this
           * branch being skipped. It is already on its way to a URL with no
           * `reason` in it before `signOut`'s `finally` gets here; see
           * `SessionState.ended` for what is and is not load-bearing about
           * that, and for the two mutations that settled it.
           *
           * The spec is a real click on the real header button, through the
           * real `auth/api.ts`, reading the rendered screen —
           * `sessionExpiryCause.test.tsx`. Making the cause unconditional on
           * either door turns it red.
           */
          ended[scope] = origin === 'other-tab' ? 'elsewhere' : 'expired';
        }
        return { sessions, ended };
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
      setState((current) => {
        const ended = { ...current.ended };
        // She signed in. Whatever ended the last session is answered, and the
        // sentence must not outlive it — see the `storage` arm above.
        delete ended[session.scope];
        return { sessions: { ...current.sessions, [session.scope]: session }, ended };
      });
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
      setState((current) => {
        const sessions = { ...current.sessions };
        delete sessions[scope];
        /*
         * NO REASON IS RECORDED, AND NONE NEEDS TO BE. The shell reads the
         * reason on this very commit and puts the answer in a URL; the
         * `clearSession` inside `signOutRequest` below arrives after that, with
         * nowhere to land. `SessionState.ended` has the full argument and the
         * two mutations that corrected it.
         */
        return { sessions, ended: current.ended };
      });
      queryClient.clear();
      await signOutRequest(scope);
    },
    [queryClient],
  );

  const ended = state.ended;
  const value = useMemo<AuthState>(
    () => ({
      sessions,
      sessionFor: (scope) => sessions[scope] ?? null,
      /*
       * The shells ask "is there a sentence for this", and `null` is the answer
       * for both ways of saying no — she signed herself out, or she was never
       * signed in on this machine at all. Neither is distinguishable on the
       * screen and neither needs to be.
       */
      endedReasonFor: (scope) => ended[scope] ?? null,
      signIn,
      signInToConsole,
      signOut,
    }),
    [sessions, ended, signIn, signInToConsole, signOut],
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
