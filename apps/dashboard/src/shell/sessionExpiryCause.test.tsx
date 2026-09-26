// @vitest-environment jsdom

/**
 * THE SILENT SESSION EXPIRY. A REGRESSION TEST FOR A DEFECT THE CLIENT REPORTED.
 *
 * What shipped: both shells redirected on `if (!session)` with one causeless,
 * destinationless line, and that line served three materially different events
 * with one identical outcome — a bare sign-in screen, no sentence, and
 * `/overview` instead of the section she was on. Reproduced deliberately by
 * corrupting the stored token pair in a live tab and opening the appointment
 * form: its selects 401, `withSession` rotates, the refresh fails,
 * `clearSession` fires, and the front desk mid-walk-in lands somewhere she did
 * not ask for with nothing on screen to say why.
 *
 * =========================================================================
 * WHY THIS FILE RENDERS INSTEAD OF SCANNING SOURCE
 * =========================================================================
 * `consoleSignInRedirect.test.tsx` states the rule this file inherits, and it
 * was earned on this exact seam: "a source-text assertion here … was TRUE
 * THROUGHOUT THE BUG. The redirect was coded. It just ran one commit early."
 *
 * The same applies twice over here. A scan proving `MerchantShell` mentions
 * `signInSearchFor` says nothing about whether `AuthProvider` had recorded
 * 'signed-out' before `auth/api.ts`'s `finally` overwrote it with 'expired' —
 * that ordering IS the fix, it lives in three files, and only running it can
 * tell a right answer from a plausible one.
 *
 * SO ONLY THE NETWORK IS STUBBED. `fetch` is replaced; `AuthProvider`,
 * `auth/session.ts`, `auth/refresh.ts`, `authedRequest`, the real `router` and
 * both real shells are the shipping code. The one module mock is `signIn`, for
 * the round trip — and `signOut` is deliberately left REAL in the same module,
 * because the deliberate-sign-out spec is entirely about what its `finally`
 * does to the recorded reason.
 *
 * LANES.md forbids stubbing a global on a SHARED surface. A vitest jsdom file is
 * the opposite of that — its own worker, its own `window`, torn down with the
 * file — which is the argument `consoleSignInRedirect.test.tsx` already makes
 * for installing Storage here rather than guarding production code.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MerchantSession, OwnerSession } from '../auth/session.js';

const { signInMock } = vi.hoisted(() => ({ signInMock: vi.fn() }));

/*
 * `signIn` ONLY. `signOut` is the real one on purpose — see the header. Spread
 * from `importOriginal` so mocking the merchant sign-in does not quietly blank
 * the console's for anything else this router mounts.
 */
vi.mock('../auth/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../auth/api.js')>();
  return { ...actual, signIn: signInMock };
});

const { AuthProvider, useAuth } = await import('../auth/AuthProvider.js');
const { router } = await import('../router.js');
const { SCOPES } = await import('../auth/scopes.js');
const { SESSION_ENDED_COPY } = await import('../auth/signInSearch.js');

/**
 * `consoleSignInRedirect.test.tsx`'s waitFor budget, for its stated reason — a
 * real React mount plus a real TanStack navigation, on a host that has been seen
 * at a load average of 324-465 while four lanes run at once.
 *
 * THE TEST TIMEOUT IS RAISED WITH IT, WHICH THAT FILE DID NOT NEED TO DO. Its
 * waits resolve in a few hundred milliseconds; the round trip below performs
 * FOUR of them in sequence — expire, land, sign in, land again — and vitest's
 * own 5000ms default fired before the first `waitFor` had spent its budget. The
 * failure was "Test timed out", which names the harness rather than the
 * assertion and is exactly the misleading-cause class this repo keeps logging.
 *
 * This raises only how long the assertions are WILLING TO WAIT. It relaxes none
 * of them: a redirect that never fires still fails this file.
 */
const LOADED_HOST = { timeout: 5000 } as const;
vi.setConfig({ testTimeout: 20_000 });

/**
 * THE TOKENS ARE DISTINCTIVE ON PURPOSE.
 *
 * Non-negotiable #6 is asserted by searching the rendered DOM for these, and for
 * every substring of them — so they are long, unique, and contain no English
 * word that could appear on a sign-in screen by coincidence and make the search
 * pass for the wrong reason.
 */
const ACCESS_TOKEN = 'zqxj7Kf2Wp9Lm4Vt8Rn3Bd6Hy5Gc1Ns0Aw';
const REFRESH_TOKEN = 'vkt5Pq8Zx2Jm7Cd4Ly9Bn6Hs3Gw1Rf0Te';

const MERCHANT: MerchantSession = {
  scope: 'merchant',
  accessToken: ACCESS_TOKEN,
  refreshToken: REFRESH_TOKEN,
  refreshExpiresAt: '2099-01-01T00:00:00.000Z',
  staffId: 'STF-001',
  salonId: 'SAL-AMARA',
  username: 'noura',
  displayName: 'Noura',
  role: 'frontdesk',
  perms: {
    dashboard: true,
    appointments: true,
    team: true,
    scanner: false,
    loyalty: true,
    marketing: true,
    shop: true,
    charges: false,
    void: false,
  },
};

const OWNER: OwnerSession = {
  scope: 'owner',
  accessToken: ACCESS_TOKEN,
  refreshToken: REFRESH_TOKEN,
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

/** `consoleSignInRedirect.test.tsx`'s Storage shim, for its stated reason. */
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

/**
 * THE NETWORK, AS A DIAL.
 *
 * `'unauthenticated'` answers 401 to everything INCLUDING `/auth/refresh`, which
 * is the deliberate reproduction: rotate once, the refresh is refused,
 * `refresh.ts` calls `clearSession`. Driving the expiry through `fetch` rather
 * than by calling `clearSession` is the point of the spec — `clearSession` is
 * the LAST step of the mechanism, and a test that started there would pass with
 * `authedRequest` and `refresh.ts` deleted.
 *
 * `'ok'` ANSWERS THE AUTH ROUTES 200 AND EVERY READ 500, WHICH IS DELIBERATE
 * AND NOT LAZINESS.
 *
 * Answering reads with an empty 200 was tried first and crashed the shell: the
 * bell reads `feed.visibleKinds` and `feedScope` is handed `undefined`, which
 * takes `NotificationBellPanel` into the router's CatchBoundary and removes the
 * header — and with it the Sign out button these specs click. Hand-shaping a
 * plausible body for every endpoint a mounted section touches would make this
 * file a fixture of the whole API, drifting against it, for a subject that is
 * not about data at all.
 *
 * A 500 is the honest alternative because every screen here is REQUIRED to have
 * that state — `stateCensus.test.ts` asserts the error vocabulary on each one —
 * so the sections render `SectionError`, the shell chrome renders in full, and
 * the session stays alive, which is what these specs need. The one thing it must
 * not be is a 401, which would end the session by the back door and make the
 * deliberate-sign-out spec pass for the wrong reason entirely.
 */
let mode: 'ok' | 'unauthenticated' = 'ok';

function body(status: number): Response {
  const payload =
    status === 401
      ? JSON.stringify({ error: 'unauthenticated', message: 'That session has ended.' })
      : status === 500
        ? JSON.stringify({ error: 'server_error', message: 'Something went wrong.' })
        : JSON.stringify({});
  return new Response(payload, { status, headers: { 'content-type': 'application/json' } });
}

function statusFor(url: string): number {
  if (mode === 'unauthenticated') return 401;
  // Sign-out and refresh must succeed, or the specs would be watching the wrong
  // failure. Everything else is a read, and a read renders its own error state.
  return url.includes('/auth/') ? 200 : 500;
}

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

function seed(session: MerchantSession | OwnerSession) {
  window.localStorage.setItem(
    SCOPES[session.scope].storageKey,
    JSON.stringify({ ...session, persistent: true }),
  );
}

/** What is actually on screen, cause sentences included. */
function shown(): string {
  return document.body.textContent ?? '';
}

beforeEach(() => {
  mode = 'ok';
  window.localStorage.clear();
  window.sessionStorage.clear();
  signInMock.mockReset();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => body(statusFor(String(input)))),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

/**
 * MOUNT WITH THE SHELL ACTUALLY ON `path`, AND THE `router.navigate` IS NOT
 * CEREMONY.
 *
 * `router` is a module singleton shared by every case in this file, and a bare
 * `history.replaceState` does not move it — TanStack's browser history listens
 * for `popstate`, which `replaceState` does not raise. Written that way first,
 * these specs inherited whatever location the previous case left behind: the
 * round trip asserted `from: '/appointments'` and read `{ reason: 'expired' }`,
 * because the shell had redirected from `/overview` and correctly omitted a
 * `from` that was already the home.
 *
 * Worth recording rather than quietly fixing, because the failure was the same
 * shape as the defect under test — a destination silently becoming the default —
 * and it was the SPEC that was wrong. A version of this file that asserted only
 * "lands on /signin" would have passed throughout and proved nothing about the
 * half the front desk cares about.
 */
async function mountAt(path: string) {
  window.history.replaceState(null, '', path);
  const utils = mount();
  await act(async () => {
    await router.navigate({ to: path, replace: true });
  });
  await waitFor(() => expect(router.state.location.pathname).toBe(path), LOADED_HOST);
  return utils;
}

/**
 * THE EXPIRY, DRIVEN THROUGH THE REAL ROTATE-RETRY.
 *
 * `authedRequest` is the entry point every authenticated read in this app goes
 * through, and it is the whole mechanism: 401, rotate once via `refresh.ts`,
 * the refresh is refused, `clearSession`. Calling it directly rather than
 * waiting for a mounted section's own poll to do it makes WHEN the session dies
 * deterministic — the section is already rendered, the shell is already on the
 * path, and nothing depends on which of a screen's queries happens to land
 * first.
 *
 * It is not a shortcut past the mechanism. Nothing here touches `clearSession`,
 * `AuthProvider` or the shells; delete `refresh.ts`'s clear and these specs go
 * red. The brief's own reproduction is this call with a form's select on top of
 * it.
 */
async function expireTheSession(scope: 'merchant' | 'owner') {
  const { authedRequest } = await import('../auth/authedRequest.js');
  mode = 'unauthenticated';
  await act(async () => {
    await authedRequest(scope, '/salons/SAL-AMARA').catch(() => undefined);
  });
}

/** Fill the merchant door's three fields and submit. */
async function signInWith() {
  const username = screen.getByLabelText('Username');
  const workspace = screen.getByLabelText('Workspace');
  const form = username.closest('form');
  if (!form) throw new Error('The sign-in fields are not inside a <form>.');
  const password = form.querySelector<HTMLInputElement>('input[type="password"]');
  if (!password) throw new Error('The sign-in has no password field.');

  fireEvent.change(workspace, { target: { value: 'SAL-AMARA' } });
  fireEvent.change(username, { target: { value: 'noura' } });
  fireEvent.change(password, { target: { value: 'noura-dev-password' } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  await waitFor(() => expect(signInMock).toHaveBeenCalled(), LOADED_HOST);
}

/** Land on the sign-in door, however we got there. */
async function atSignIn(scope: 'merchant' | 'owner') {
  await waitFor(
    () => expect(router.state.location.pathname).toBe(SCOPES[scope].signIn),
    LOADED_HOST,
  );
}

describe('the three ways a session ends are three different screens', () => {
  /**
   * ===================================================================
   * 1. A DELIBERATE SIGN-OUT SAYS NOTHING
   * ===================================================================
   * She pressed the button one screen ago. A sign-out that announces itself is
   * noise, and the sentence would be a lie about which of the three happened.
   *
   * THE SUBTLETY THIS SPEC EXISTS FOR IS AN ORDERING, NOT A BRANCH. The real
   * `auth/api.ts` `signOut` ends in `finally { clearSession(scope) }`, whose
   * notification is byte-for-byte what a 401-driven clear produces. If
   * `AuthProvider` did not claim the scope on the click, that `finally` would
   * stamp 'expired' over a deliberate sign-out and this screen would explain an
   * expiry that never happened. So the REAL `signOut` runs here, and the click
   * is a real click on the real header button.
   */
  it('lands on sign-in with no cause message', async () => {
    seed(MERCHANT);
    await mountAt('/appointments');

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    await atSignIn('merchant');
    // The form, not a blank screen — she is where she can act.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sign in' })).toBeDefined());

    expect(shown()).not.toContain(SESSION_ENDED_COPY.expired);
    expect(shown()).not.toContain(SESSION_ENDED_COPY.elsewhere);
    // …and the URL carries no cause either, so a reload cannot invent one.
    expect(window.location.search).not.toContain('reason');
  });

  /**
   * ===================================================================
   * 2. AN EXPIRY PAST REFRESH IS EXPLAINED
   * ===================================================================
   * The client's own reproduction, driven end to end: a mounted section's read
   * 401s, `withSession` rotates once, `POST /auth/refresh` is refused,
   * `refresh.ts` clears the session, and the shell redirects.
   *
   * Nothing in this spec touches `clearSession` directly — see the `mode` dial.
   */
  it('lands with the expiry sentence when the refresh will not mint', async () => {
    seed(MERCHANT);
    await mountAt('/appointments');
    await expireTheSession('merchant');

    await atSignIn('merchant');
    await waitFor(() => expect(shown()).toContain(SESSION_ENDED_COPY.expired), LOADED_HOST);
    expect(shown()).not.toContain(SESSION_ENDED_COPY.elsewhere);
    // The section she was on, carried out of a shell that had already unmounted.
    expect(router.state.location.search).toMatchObject({ from: '/appointments' });

    /*
     * THE ROTATION ACTUALLY RAN. Without this the spec would pass on a session
     * that was never refreshed at all — a different bug wearing the same screen.
     */
    const calls = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const urls = calls.map((call) => String(call[0]));
    expect(urls.some((url) => url.includes('/auth/refresh'))).toBe(true);
  });

  /**
   * ===================================================================
   * 3. A SIGN-OUT IN ANOTHER TAB GETS ITS OWN SENTENCE
   * ===================================================================
   * `MerchantShell`'s own comment named this as a distinct case long before it
   * was handled as one. Two dashboard tabs on a front-desk machine share
   * `localStorage`; the sentence for "somebody signed this workspace out next
   * door" is not the sentence for "your session expired", and rendering the
   * expiry copy here would tell her something false about her own credential.
   *
   * DRIVEN THROUGH THE REAL `storage` EVENT — `auth/session.ts` §
   * `subscribeToSessions` is the wiring under test, and it is the ONLY place
   * this cause can be distinguished. Everything downstream sees an absent key.
   */
  it('lands with its own sentence when another tab signs out', async () => {
    seed(MERCHANT);
    await mountAt('/appointments');

    const key = SCOPES.merchant.storageKey;
    const oldValue = window.localStorage.getItem(key);
    act(() => {
      // Exactly what the other tab's `clearSession` leaves behind, then the
      // event the browser raises here because of it.
      window.localStorage.removeItem(key);
      window.dispatchEvent(new StorageEvent('storage', { key, oldValue, newValue: null }));
    });

    await atSignIn('merchant');
    await waitFor(() => expect(shown()).toContain(SESSION_ENDED_COPY.elsewhere), LOADED_HOST);
    expect(shown()).not.toContain(SESSION_ENDED_COPY.expired);
  });
});

describe('the section she was on survives the sign-in', () => {
  /**
   * ===================================================================
   * 4. THE ROUND TRIP
   * ===================================================================
   * Signed out from `/appointments`, signed back in, lands on `/appointments`.
   * The whole point of the fix from the front desk's side: a walk-in does not
   * get abandoned because a token aged out.
   */
  it('returns her to /appointments rather than /overview', async () => {
    seed(MERCHANT);
    await mountAt('/appointments');
    await expireTheSession('merchant');

    await atSignIn('merchant');
    expect(router.state.location.search).toMatchObject({ from: '/appointments' });

    // The network is healthy again; she signs in.
    mode = 'ok';
    signInMock.mockResolvedValue(MERCHANT);

    await signInWith();
    await waitFor(
      () => expect(router.state.location.pathname).toBe('/appointments'),
      LOADED_HOST,
    );
    expect(router.state.location.pathname).not.toBe(SCOPES.merchant.home);
  });

  /**
   * ===================================================================
   * 5. A HOSTILE RETURN PATH IS REFUSED — RENDERED, NOT JUST CALLED
   * ===================================================================
   * `auth/signInSearch.test.ts` proves the closed-set property over a hundred
   * inputs. This proves the property is WIRED: that the value reaching
   * `navigate` really is the gate's output and not the raw search param, which
   * is the half a unit test cannot see.
   *
   * Each of these is typed straight into the address bar, the way a phishing
   * link would deliver it.
   */
  it.each([
    ['an absolute URL to another origin', 'https://evil.example/appointments'],
    ['a protocol-relative host', '//evil.example'],
    ['a path this shell does not serve', '/billing'],
  ])('%s falls back to the default rather than navigating to it', async (_label, from) => {
    signInMock.mockResolvedValue(MERCHANT);
    window.history.replaceState(null, '', '/signin');
    mount();
    await act(async () => {
      // Through the router's own search handling, exactly as an address-bar
      // paste arrives: `validateSearch` runs, and `from` reaches the screen.
      await router.navigate({ to: SCOPES.merchant.signIn, search: { from }, replace: true });
    });

    await atSignIn('merchant');

    await signInWith();

    await waitFor(
      () => expect(router.state.location.pathname).toBe(SCOPES.merchant.home),
      LOADED_HOST,
    );
    // Not merely "not the hostile string" — it left this origin's path space at
    // no point, and it landed on the declared default.
    expect(window.location.hostname).toBe('localhost');
    expect(router.state.location.pathname).toBe('/overview');
  });
});

describe('the door the shell never sees', () => {
  /**
   * A BOOKMARKED SECTION, OPENED WITH NO SESSION AT ALL.
   *
   * `requireScope` refuses in `beforeLoad`, so the shell never mounts and the
   * redirect that carries the destination never runs. This is the one path where
   * the return path has to be built by the guard, and the spec exists because
   * nothing else in this file would notice if it stopped being.
   */
  it('returns her to a bookmarked section after she signs in', async () => {
    signInMock.mockResolvedValue(MERCHANT);
    // No `seed` — she is not signed in, and this is a cold arrival.
    // Mounted BEFORE the navigation: `router.navigate` on a router no
    // `RouterProvider` has started never settles, which hangs the file rather
    // than failing it.
    window.history.replaceState(null, '', '/appointments');
    mount();
    await act(async () => {
      await router.navigate({ to: '/appointments', replace: true });
    });

    await atSignIn('merchant');
    expect(router.state.location.search).toMatchObject({ from: '/appointments' });

    /*
     * AND IT CLAIMS NOTHING ABOUT WHY. A bookmark is not an expiry. This is the
     * assertion that stops the guard being "helpful" by stamping a reason it
     * cannot know.
     */
    expect(shown()).not.toContain(SESSION_ENDED_COPY.expired);
    expect(shown()).not.toContain(SESSION_ENDED_COPY.elsewhere);

    await signInWith();
    await waitFor(
      () => expect(router.state.location.pathname).toBe('/appointments'),
      LOADED_HOST,
    );
  });

  /** The same refusal, with a hostile bookmark. */
  it('refuses a hostile path even from the guard', async () => {
    signInMock.mockResolvedValue(MERCHANT);
    window.history.replaceState(null, '', '/signin');
    mount();
    await act(async () => {
      await router.navigate({
        to: SCOPES.merchant.signIn,
        search: { from: '//evil.example' },
        replace: true,
      });
    });

    await atSignIn('merchant');
    await signInWith();
    await waitFor(
      () => expect(router.state.location.pathname).toBe(SCOPES.merchant.home),
      LOADED_HOST,
    );
  });
});

describe('nothing about the cause carries a credential', () => {
  /**
   * ===================================================================
   * 6. NON-NEGOTIABLE #6, OVER THE RENDERED OUTPUT
   * ===================================================================
   * The cause is a CATEGORY. Not the status code, not which call failed, and
   * above all no part of a token.
   *
   * SUBSTRINGS, NOT THE WHOLE TOKEN, because the whole token is the easy case.
   * A truncated bearer in a debug line, a first-eight-characters "session id",
   * a `key={token.slice(0, 8)}` — every one of those is a leak and every one
   * survives a `not.toContain(ACCESS_TOKEN)`. The sweep walks every window of
   * six characters or more over both tokens.
   */
  it('renders no token, and no substring of one', async () => {
    seed(MERCHANT);
    await mountAt('/appointments');
    await expireTheSession('merchant');

    await atSignIn('merchant');
    await waitFor(() => expect(shown()).toContain(SESSION_ENDED_COPY.expired), LOADED_HOST);

    // The markup, the accessibility tree's own text, and the address bar — a
    // token in the URL is the leak that survives every DOM assertion.
    const surface = `${document.body.innerHTML} ${shown()} ${window.location.href}`;

    const WINDOW = 6;
    const leaked: string[] = [];
    for (const token of [ACCESS_TOKEN, REFRESH_TOKEN]) {
      for (let start = 0; start + WINDOW <= token.length; start += 1) {
        const fragment = token.slice(start, start + WINDOW);
        if (surface.includes(fragment)) leaked.push(fragment);
      }
    }
    expect(leaked).toEqual([]);

    /*
     * The sweep's own premise. A `surface` that was empty — a screen that failed
     * to render, an `innerHTML` read after cleanup — would report no leak
     * forever. DECISIONS.md's standing note: a zero result is a claim about the
     * command as much as about the tree.
     */
    expect(surface).toContain(SESSION_ENDED_COPY.expired);
    expect(surface.includes(ACCESS_TOKEN.slice(0, WINDOW))).toBe(false);
    expect(`${surface} ${ACCESS_TOKEN}`.includes(ACCESS_TOKEN.slice(0, WINDOW))).toBe(true);
  });
});

describe('the owner console does not diverge from the merchant door', () => {
  /**
   * THE CONSOLE HAD THE SAME DEFECT AND IS FIXED BY THE SAME CODE. Asserted
   * rather than assumed: `ConsoleShell` is a SIBLING of `MerchantShell` and its
   * own header records what that has cost before — it was written as one and
   * "did not copy the one structural thing that comment exists to explain".
   *
   * `/console/audit` rather than `/console/approvals`, deliberately. Approvals
   * is `SCOPES.owner.home`, so a console that ignored the return path entirely
   * would still land there and pass. Auditing from any OTHER section is the only
   * place the two behaviours differ.
   */
  it('explains an expiry and returns an admin to the section she was on', async () => {
    seed(OWNER);
    await mountAt('/console/audit');
    await expireTheSession('owner');

    await atSignIn('owner');
    await waitFor(() => expect(shown()).toContain(SESSION_ENDED_COPY.expired), LOADED_HOST);
    expect(router.state.location.search).toMatchObject({ from: '/console/audit' });
    expect(router.state.location.search).not.toMatchObject({ from: SCOPES.owner.home });
  });

  /** The same silence on a deliberate sign-out, from the console's own button. */
  it('says nothing when an admin signs herself out', async () => {
    seed(OWNER);
    await mountAt('/console/audit');

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    await atSignIn('owner');
    expect(shown()).not.toContain(SESSION_ENDED_COPY.expired);
    expect(shown()).not.toContain(SESSION_ENDED_COPY.elsewhere);
  });
});
