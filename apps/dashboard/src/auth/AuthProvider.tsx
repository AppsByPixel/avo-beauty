import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { signIn as signInRequest, type Credentials } from './api.js';
import { clearSession, readSession, writeSession, type Session } from './session.js';
import type { AuthScope } from './scopes.js';

export interface AuthState {
  /** Sessions by scope. A merchant session and an owner session can coexist. */
  sessions: Partial<Record<AuthScope, Session>>;
  sessionFor: (scope: AuthScope) => Session | null;
  signIn: (scope: AuthScope, credentials: Credentials, keepSignedIn: boolean) => Promise<Session>;
  signOut: (scope: AuthScope) => void;
}

const AuthContext = createContext<AuthState | null>(null);

function hydrate(): Partial<Record<AuthScope, Session>> {
  const merchant = readSession('merchant');
  const owner = readSession('owner');
  return {
    ...(merchant ? { merchant } : {}),
    ...(owner ? { owner } : {}),
  };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [sessions, setSessions] = useState<Partial<Record<AuthScope, Session>>>(hydrate);

  const signIn = useCallback(
    async (scope: AuthScope, credentials: Credentials, keepSignedIn: boolean) => {
      const session = await signInRequest(scope, credentials);
      writeSession(session, keepSignedIn);
      setSessions((current) => ({ ...current, [scope]: session }));
      return session;
    },
    [],
  );

  const signOut = useCallback((scope: AuthScope) => {
    clearSession(scope);
    setSessions((current) => {
      const next = { ...current };
      delete next[scope];
      return next;
    });
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      sessions,
      sessionFor: (scope) => sessions[scope] ?? null,
      signIn,
      signOut,
    }),
    [sessions, signIn, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside <AuthProvider>.');
  return context;
}

/** The session for a scope, or a throw. Use inside a scope-guarded route. */
export function useSession(scope: AuthScope): Session {
  const session = useAuth().sessionFor(scope);
  if (!session) throw new Error(`No ${scope} session. This route must sit behind requireScope().`);
  return session;
}
