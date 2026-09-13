// @vitest-environment jsdom

/**
 * THE MERCHANT COULD NOT SIGN IN ON ANY HOSTED DOMAIN. A REGRESSION TEST FOR A
 * BUG THAT WAS FOUND BY DEPLOYING, NOT BY READING.
 *
 * `SignIn.tsx` rendered the Workspace field as `{fromHost ? null : <TextField/>}`
 * with `fromHost = workspaceHintFromHost(window.location.hostname)`. That helper
 * returns the first DNS label of any host carrying three or more labels, so the
 * condition was not "is this a per-salon subdomain" — it was "does this host have
 * a dot in the middle". Every hosted domain therefore DELETED the field and
 * submitted its own first label as the salon id:
 *
 *   localhost                        -> null                 the only one that worked
 *   98a0-39-49-146-53.ngrok-free.app -> "98a0-39-49-146-53"
 *   abc-def.trycloudflare.com        -> "abc-def"
 *   avo-dashboard.onrender.com       -> "avo-dashboard"
 *   dashboard.avo.beauty             -> "dashboard"
 *   amara.avo.app                    -> "amara"
 *
 * The deployed page rendered two inputs, username and password, POSTed a salon
 * id that is not a salon, and took back one deliberately-unspecific 401 with no
 * control on screen able to correct it. `dashboard.avo.beauty` is in that list on
 * purpose: it is the host drawn in the browser chrome of `AVO Login.dc.html` 5a,
 * so the design's own deployment hit this.
 *
 * WHY THIS IS A RENDER TEST AND NOT A UNIT TEST OF `workspaceHintFromHost`.
 *
 * The helper is pure, trivially testable, and was never wrong — it returned
 * exactly what it documents. Every unit assertion about it was TRUE THROUGHOUT
 * THE BUG. The defect is one JSX condition consuming that correct answer as an
 * authority, and nothing short of rendering the screen on a hostname can tell
 * those two apart. Same lesson as `consoleSignInRedirect.test.tsx` and
 * DECISIONS.md #38: a source-text or unit assertion that holds while the screen
 * is broken is not a guard.
 *
 * The real `router` and the real `AuthProvider` are mounted for the same reason
 * that file gives. Only the network is stubbed, so the last case below can prove
 * the corrected workspace actually reaches `POST /auth/web/session` — "the field
 * is on screen" is not the same claim as "the person can get in".
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MerchantSession } from '../auth/session.js';

const { signInMock } = vi.hoisted(() => ({ signInMock: vi.fn() }));

/*
 * Only `signIn` is replaced; the rest of the module is re-exported so that
 * mocking the merchant endpoint does not quietly blank `displayNameFor` or the
 * console's own sign-in for anything else this router mounts.
 */
vi.mock('../auth/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../auth/api.js')>();
  return { ...actual, signIn: signInMock };
});

const { AuthProvider, useAuth } = await import('../auth/AuthProvider.js');
const { router } = await import('../router.js');
const { SCOPES } = await import('../auth/scopes.js');

/** See consoleSignInRedirect.test.tsx — a real mount plus a real navigation. */
const LOADED_HOST = { timeout: 5000 } as const;

/**
 * THE HOSTNAME HARNESS.
 *
 * `window.location` is redefinable under this jsdom (measured), but replacing it
 * with a bare `{ hostname }` object would take `href`, `pathname` and `origin`
 * away from TanStack Router's history, which reads them on every navigation. So
 * the real `Location` is proxied and only `hostname` is answered differently —
 * the router keeps the location it has, and the screen sees the host we are
 * testing. Methods are bound back to the real object because jsdom's `Location`
 * carries internal slots and will not accept a proxy as its receiver.
 */
const REAL_LOCATION = window.location;

function servedFrom(hostname: string): void {
  Object.defineProperty(window, 'location', {
    configurable: true,
    writable: true,
    value: new Proxy(REAL_LOCATION, {
      get(target, prop, receiver) {
        if (prop === 'hostname') return hostname;
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : (value ?? Reflect.get(target, prop, receiver));
      },
      set(target, prop, value) {
        return Reflect.set(target, prop, value, target);
      },
    }),
  });
}

afterAll(() => {
  Object.defineProperty(window, 'location', {
    configurable: true,
    writable: true,
    value: REAL_LOCATION,
  });
});

/** See consoleSignInRedirect.test.tsx — this jsdom ships no working Storage. */
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

const SESSION: MerchantSession = {
  scope: 'merchant',
  accessToken: 'test-access-token',
  refreshToken: 'test-refresh-token',
  refreshExpiresAt: '2099-01-01T00:00:00.000Z',
  staffId: 'STF-001',
  salonId: 'SAL-AMARA',
  username: 'amara',
  displayName: 'Amara',
  role: 'owner',
  perms: {
    dashboard: true,
    appointments: true,
    shop: true,
    loyalty: true,
    team: true,
    scanner: true,
    charges: true,
    void: true,
    marketing: true,
  },
};

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

/** Mounts the merchant sign-in as served from `hostname`, and waits for it. */
async function signInPageOn(hostname: string) {
  servedFrom(hostname);
  mount();
  await waitFor(
    () => expect(router.state.location.pathname).toBe(SCOPES.merchant.signIn),
    LOADED_HOST,
  );
  await screen.findByRole('button', { name: 'Sign in' }, LOADED_HOST);
}

afterEach(() => {
  cleanup();
  signInMock.mockReset();
  window.localStorage.clear();
  window.sessionStorage.clear();
  servedFrom(REAL_LOCATION.hostname);
});

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.history.replaceState(null, '', SCOPES.merchant.signIn);
});

/**
 * The hosts that matter, driven rather than reasoned about. `localhost` is the
 * control that must not regress — it was the ONLY host that worked, so a fix
 * that traded it for the others would be no fix at all.
 */
const HOSTS = [
  'localhost',
  '98a0-39-49-146-53.ngrok-free.app',
  'abc-def.trycloudflare.com',
  'avo-dashboard.onrender.com',
  'dashboard.avo.beauty',
  'amara.avo.app',
] as const;

describe('the Workspace field is reachable on every host the dashboard is served from', () => {
  for (const hostname of HOSTS) {
    it(`renders an editable Workspace field on ${hostname}`, async () => {
      await signInPageOn(hostname);

      /*
       * By LABEL, not by index. The field's identity is the thing under test and
       * an index would survive the field being replaced by something else — and
       * `getByLabelText` additionally proves the label is wired to the input,
       * which is the difference between a field and a decoration.
       */
      const workspace = screen.getByLabelText('Workspace') as HTMLInputElement;

      /*
       * Three textboxes is two: Workspace and Username. A `type="password"` input
       * has no accessible role by spec, so the password does not appear here. The
       * count is asserted so that a fourth field on this screen fails loudly
       * rather than shifting something silently — and so that "the field renders"
       * cannot be satisfied by rendering two of them.
       */
      expect(screen.getAllByRole('textbox')).toHaveLength(2);

      /*
       * EDITABLE, not merely present. The lock-out was that no control could
       * correct a wrong workspace; a disabled or readonly field would reproduce
       * it exactly while passing a presence check.
       */
      expect(workspace.disabled).toBe(false);
      expect(workspace.readOnly).toBe(false);
      fireEvent.change(workspace, { target: { value: 'SAL-AMARA' } });
      expect(workspace.value).toBe('SAL-AMARA');
    });
  }

  it('still pre-fills from a per-salon subdomain — the hint keeps its job', async () => {
    await signInPageOn('amara.avo.app');

    // The convenience the hint exists for: on her own salon's subdomain nobody
    // types the workspace. It is now a default in a visible box instead of a
    // verdict that removed the box.
    expect((screen.getByLabelText('Workspace') as HTMLInputElement).value).toBe('amara');
  });

  it('prefers a remembered workspace to a guess made from the host', async () => {
    // What `rememberWorkspace` writes after a successful sign-in: the salon id
    // the SERVER put on the session. On this host the hint would guess
    // "98a0-39-49-146-53"; the remembered value is the one that actually worked.
    window.localStorage.setItem('avo.workspace.last', 'SAL-AMARA');
    await signInPageOn('98a0-39-49-146-53.ngrok-free.app');

    expect((screen.getByLabelText('Workspace') as HTMLInputElement).value).toBe('SAL-AMARA');
  });

  it('sends the corrected workspace, not the host label, on a tunnelled host', async () => {
    /*
     * THE ASSERTION THE BUG FAILED IN THE WAY THAT COST SOMETHING. The screen
     * rendering a field is a means; the end is that the credential triple leaving
     * this browser names a real salon. Before the fix the only reachable value
     * was `98a0-39-49-146-53` and no keystroke could change it.
     */
    signInMock.mockResolvedValue(SESSION);
    await signInPageOn('98a0-39-49-146-53.ngrok-free.app');

    fireEvent.change(screen.getByLabelText('Workspace'), { target: { value: 'SAL-AMARA' } });
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'amara' } });
    const password = screen
      .getByRole('button', { name: 'Sign in' })
      .closest('form')
      ?.querySelector<HTMLInputElement>('input[type="password"]');
    if (!password) throw new Error('The merchant sign-in has no password field.');
    fireEvent.change(password, { target: { value: 'amara-dev-password' } });

    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => expect(signInMock).toHaveBeenCalledTimes(1), LOADED_HOST);
    expect(signInMock).toHaveBeenCalledWith('merchant', {
      salonId: 'SAL-AMARA',
      username: 'amara',
      password: 'amara-dev-password',
    });
  });
});
