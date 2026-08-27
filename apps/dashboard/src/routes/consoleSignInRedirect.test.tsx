// @vitest-environment jsdom

/**
 * THE OWNER CONSOLE SIGN-IN REDIRECTS. A REGRESSION TEST FOR A BUG THAT SHIPPED.
 *
 * The defect: `POST /auth/platform/session` returned 200, the session was
 * written to storage, and the admin was left looking at the sign-in form. Worse
 * than a dead end — the success path clears the password and the button disables
 * itself on an empty one, so the obvious recovery (click Sign in again) was not
 * available either. Reproduced twice by trunk and once by this lane against a
 * real API, then instrumented:
 *
 *   [DIAG] pre-navigate  href= /console/signin
 *   [DIAG] requireScope owner sessionFor= false keys= Array(0)
 *   [DIAG] requireScope BOUNCE -> /console/signin
 *   [DIAG] post-navigate href= /console/signin
 *
 * `ConsoleSignIn` used to `await navigate(...)` on the line after
 * `await signInToConsole(...)`. `AuthProvider` had called `setSessions`, but
 * React had not committed it, so `RoutedApp` had not re-rendered and
 * `RouterProvider` had not been handed the new `context={{ auth }}`.
 * `requireScope('owner')` therefore read the PREVIOUS context — an empty session
 * map — and threw its redirect straight back here.
 *
 * WHY THIS TEST USES THE REAL `router` AND THE REAL `AuthProvider`.
 *
 * Both halves of the bug live in the seam between them, and a test that stubs
 * either one asserts nothing. A stub router with a hand-written `beforeLoad`
 * would pass while the real guard in `router.tsx` bounced; a stubbed auth
 * context would hand the router a session synchronously and erase the commit
 * boundary that IS the bug. So the only thing stubbed is the network:
 * `auth/api.ts` is mocked, everything from `AuthProvider` down through
 * `requireScope` to the router's own location is the shipping code.
 *
 * DECISIONS.md #38 is the reason this is a render test and not a source scan.
 * `stateCensus.test.ts` and `consoleNavGates.test.ts` read source text, and a
 * source-text assertion here — "ConsoleSignIn mentions SCOPES.owner.home" — was
 * TRUE THROUGHOUT THE BUG. The redirect was coded. It just ran one commit early.
 * Nothing short of rendering can tell those two apart.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OwnerSession } from '../auth/session.js';

/*
 * Hoisted, because `vi.mock` is hoisted above the imports and the factory below
 * closes over this. A plain `const` here would be read before initialisation.
 */
const { signInToConsoleMock } = vi.hoisted(() => ({
  signInToConsoleMock: vi.fn(),
}));

/*
 * ONLY THE NETWORK IS STUBBED. `signIn`, `signOut` and `displayNameFor` are
 * re-exported from the real module rather than replaced, so mocking the console
 * endpoint does not quietly blank the merchant one for anything else this router
 * mounts.
 */
vi.mock('../auth/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../auth/api.js')>();
  return { ...actual, signInToConsole: signInToConsoleMock };
});

const { AuthProvider, useAuth } = await import('../auth/AuthProvider.js');
const { router } = await import('../router.js');
const { SCOPES } = await import('../auth/scopes.js');

/** A seeded owner, every section — the `yousef` row, minus anything secret. */
const OWNER: OwnerSession = {
  scope: 'owner',
  accessToken: 'test-access-token',
  refreshToken: 'test-refresh-token',
  refreshExpiresAt: '2099-01-01T00:00:00.000Z',
  adminId: 'PLT-001',
  username: '@yousef',
  displayName: 'Yousef',
  role: 'owner',
  owner: true,
  sections: {
    analytics: true,
    activity: true,
    salons: true,
    accounts: true,
    admins: true,
    controls: true,
    approvals: true,
    policies: true,
    audit: true,
  },
};

/** `main.tsx`, minus the tokens and the StrictMode wrapper. Same wiring. */
function App() {
  const auth = useAuth();
  return <RouterProvider router={router} context={{ auth }} />;
}

function mount() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </QueryClientProvider>,
  );
}

/*
 * A REAL `Storage`, BECAUSE THIS jsdom DOES NOT SHIP ONE.
 *
 * Under Node 25 + jsdom 30 here, `window.localStorage` is an EMPTY OBJECT — no
 * `getItem`, no `setItem`, no `clear`; measured, not assumed. `auth/session.ts`
 * calls `store.getItem(key)` unguarded (correctly — a browser always has
 * Storage), so `hydrate()` throws before `AuthProvider` renders anything and
 * every assertion below fails on a TypeError that has nothing to do with the
 * subject.
 *
 * LANES.md forbids stubbing a global like `localStorage` on a SHARED surface —
 * the browser pane, where another lane's app is running in the next tab. A
 * vitest jsdom file is the opposite of that: its own worker, its own `window`,
 * torn down with the file. Installing Storage here restores the browser's
 * behaviour rather than replacing it, which is why the fix belongs in the test
 * and not in `session.ts` — guarding production code for a missing Storage would
 * be paying for a test environment's gap in shipped code.
 */
function installStorage(name: 'localStorage' | 'sessionStorage') {
  const existing = window[name] as unknown;
  if (existing && typeof (existing as Storage).setItem === 'function') return;
  const map = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key) => map.get(key) ?? null,
    key: (index) => [...map.keys()][index] ?? null,
    removeItem: (key) => void map.delete(key),
    setItem: (key, value) => void map.set(key, String(value)),
  };
  Object.defineProperty(window, name, { value: storage, configurable: true, writable: true });
}

installStorage('localStorage');
installStorage('sessionStorage');

// See ui/moneyRender.test.tsx — @testing-library registers no automatic cleanup
// without vitest `globals: true`, and the failure it produces names the wrong
// cause.
afterEach(() => {
  cleanup();
  signInToConsoleMock.mockReset();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.history.replaceState(null, '', SCOPES.owner.signIn);
});

describe('the owner console sign-in leaves the sign-in screen', () => {
  it('lands on the owner home once the session exists', async () => {
    signInToConsoleMock.mockResolvedValue(OWNER);
    mount();

    await waitFor(() =>
      expect(router.state.location.pathname).toBe(SCOPES.owner.signIn),
    );

    /*
     * `getAllByRole('textbox')` finds the username field only — a
     * `type="password"` input has NO accessible role, by spec. So the password is
     * reached through the form it lives in rather than by role, and the count is
     * asserted so that a future third field on this screen fails here loudly
     * instead of shifting an index silently.
     */
    const textboxes = screen.getAllByRole('textbox');
    expect(textboxes).toHaveLength(1);
    const username = textboxes[0] as HTMLInputElement;
    const form = username.closest('form');
    if (!form) throw new Error('The console sign-in fields are not inside a <form>.');
    const password = form.querySelector<HTMLInputElement>('input[type="password"]');
    if (!password) throw new Error('The console sign-in has no password field.');

    /*
     * `fireEvent.change`, not `element.value = x`. A bare assignment bypasses
     * React's own value tracker, so the next render restores the old state and
     * the field reads empty — and the submit button is `disabled` until BOTH
     * fields are non-empty, so a silently-ignored keystroke would make this test
     * green for the wrong reason. `fireEvent` goes through the native setter and
     * wraps the dispatch in `act`.
     */
    fireEvent.change(username, { target: { value: 'yousef' } });
    fireEvent.change(password, { target: { value: 'yousef-dev-password' } });

    /*
     * The BUTTON is clicked rather than the form submitted directly, because
     * `disabled` is the other half of what made this bug unrecoverable: the
     * success path clears the password, which disables the button, so an admin
     * who saw nothing happen could not simply click again. Clicking asserts the
     * button was actually enabled at this point.
     */
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => expect(signInToConsoleMock).toHaveBeenCalledTimes(1));

    /*
     * THE ASSERTION THE BUG FAILED. `signInToConsole` resolving is not the
     * subject — it resolved throughout the defect, with a 200. Where the router
     * ENDS UP is.
     *
     * `not.toBe(signIn)` as well as `toBe(home)`, because they are two different
     * failures with two different causes: never leaving, versus leaving and being
     * bounced back by the guard. The bug was the second, and an assertion on the
     * destination alone would report it as the first.
     */
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(SCOPES.owner.home);
    });
    expect(router.state.location.pathname).not.toBe(SCOPES.owner.signIn);
  });

  it('does not show the form to an admin who already holds a session', async () => {
    /*
     * The second half of the same fix, and a real gap of its own: `SignIn.tsx`
     * has always skipped its form for a signed-in merchant and this screen never
     * did. One effect keyed on the session covers both, so both are asserted —
     * otherwise a future change could satisfy the test above by navigating from
     * the submit handler again and silently reopen this one.
     */
    // The shape `writeSession` actually writes: the session, flattened, plus
    // `persistent`. Not `{ session, keep }` — `readSession` validates the fields
    // at the top level and would drop a nested one as corrupt, which would make
    // this test pass for the wrong reason (no session, so no form to skip... and
    // no redirect either, so it would fail — but on the wrong cause).
    window.localStorage.setItem(
      SCOPES.owner.storageKey,
      JSON.stringify({ ...OWNER, persistent: true }),
    );
    mount();

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(SCOPES.owner.home);
    });
    expect(signInToConsoleMock).not.toHaveBeenCalled();
  });
});
