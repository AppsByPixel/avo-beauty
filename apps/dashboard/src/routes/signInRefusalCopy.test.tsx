// @vitest-environment jsdom

/**
 * A SIGN-IN THAT WAS REFUSED MUST NOT SAY THE SERVER WAS UNREACHABLE.
 *
 * Aftab hit this live: after several wrong passwords the API answered
 * `POST /auth/web/session → 429 sign_in_rate_limited`, and the form said "We
 * couldn't reach your workspace. Check your connection and try again." He
 * concluded the server was down. The 429 fell through to the unreachable copy
 * because the form only special-cased 401 and 400.
 *
 * `fetch` is stubbed, not `auth/api.js`, so the real client builds the
 * `ApiError` out of the real body shape the limiter sends
 * (`api/src/services/signInLimit.ts`: `{ error, message }`, no retry field).
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { AuthProvider, useAuth } = await import('../auth/AuthProvider.js');
const { router } = await import('../router.js');
const { SCOPES } = await import('../auth/scopes.js');

const LOADED = { timeout: 5000 } as const;

const UNREACHABLE = "We couldn't reach your workspace. Check your connection and try again.";
/** The limiter's own sentences, verbatim from `signInLimit.ts`. */
const BURST = 'Too many attempts. Wait a moment and try again.';
const HOURLY = 'Too many sign-in attempts. Try again later, or use the reset link.';

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

const fetchMock = vi.fn<typeof fetch>();

function answers(status: number, body: Record<string, unknown>): void {
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  );
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

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  window.localStorage.clear();
  window.sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

async function submitMerchant(): Promise<string> {
  window.history.replaceState(null, '', SCOPES.merchant.signIn);
  mount();
  // The router is a module singleton and outlives `cleanup()`, so the previous
  // test's door is still its location until it is told otherwise.
  await router.navigate({ to: SCOPES.merchant.signIn });
  await waitFor(() => expect(router.state.location.pathname).toBe(SCOPES.merchant.signIn), LOADED);
  await screen.findByRole('button', { name: 'Sign in' }, LOADED);
  fireEvent.change(screen.getByLabelText('Workspace'), { target: { value: 'SAL-AMARA' } });
  fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'noura' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'not-her-password' } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  const alert = await screen.findByRole('alert', {}, LOADED);
  expect(fetchMock).toHaveBeenCalled();
  expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/auth/web/session');
  return alert.textContent ?? '';
}

async function submitConsole(): Promise<string> {
  window.history.replaceState(null, '', SCOPES.owner.signIn);
  mount();
  // The router is a module singleton and outlives `cleanup()`, so the previous
  // test's door is still its location until it is told otherwise.
  await router.navigate({ to: SCOPES.owner.signIn });
  await waitFor(() => expect(router.state.location.pathname).toBe(SCOPES.owner.signIn), LOADED);
  await screen.findByRole('button', { name: 'Sign in' }, LOADED);
  fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'yousef' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'not-his-password' } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  const alert = await screen.findByRole('alert', {}, LOADED);
  expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/auth/platform/session');
  return alert.textContent ?? '';
}

describe('merchant sign-in: a refusal reads as a refusal', () => {
  it('a 429 sign_in_rate_limited shows the limiter’s sentence, not the connection one', async () => {
    answers(429, { error: 'sign_in_rate_limited', message: BURST });
    const text = await submitMerchant();
    expect(text).toContain(BURST);
    expect(text).not.toContain("couldn't reach");
  });

  it('a 429 sign_in_hourly_limit shows the hourly sentence', async () => {
    answers(429, { error: 'sign_in_hourly_limit', message: HOURLY });
    const text = await submitMerchant();
    expect(text).toContain(HOURLY);
    expect(text).not.toContain("couldn't reach");
  });

  it('a 429 with no message still says too many attempts, and names no wait the server did not send', async () => {
    answers(429, { error: 'sign_in_rate_limited' });
    const text = await submitMerchant();
    // `response.statusText` is empty for a constructed Response, so this is the
    // fallback path, not the server's sentence.
    expect(text).toContain('Too many sign-in attempts. Wait a few minutes and try again.');
    expect(text).not.toContain("couldn't reach");
  });

  it('a network failure still shows the connection sentence', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    expect(await submitMerchant()).toContain(UNREACHABLE);
  });

  it('a 5xx still shows the connection sentence', async () => {
    answers(500, { error: 'server_error', message: 'Something went wrong on our side.' });
    expect(await submitMerchant()).toContain(UNREACHABLE);
  });

  it('a 401 is still the one credentials sentence', async () => {
    answers(401, { error: 'invalid_credentials', message: 'Those details do not match.' });
    expect(await submitMerchant()).toContain('That username and password do not match. Try again.');
  });
});

describe('console sign-in: the same mapping', () => {
  it('a 429 sign_in_rate_limited shows the limiter’s sentence, not the connection one', async () => {
    answers(429, { error: 'sign_in_rate_limited', message: BURST });
    const text = await submitConsole();
    expect(text).toContain(BURST);
    expect(text).not.toMatch(/reach/i);
  });

  it('a network failure still shows the connection sentence', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    expect(await submitConsole()).toContain("Can't reach AVO. Check your connection and try again.");
  });
});
