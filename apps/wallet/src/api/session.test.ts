/**
 * The session layer, tested where it can actually cost something.
 *
 * Four of these guard a specific failure that is invisible until it bites:
 *
 *   #6            what gets persisted, asserted by scanning the stored bytes for
 *                 the password rather than by trusting the call site.
 *   rotation      a refresh that did not persist its new token works exactly once
 *                 and then signs the customer out, which presents as a flaky
 *                 backend rather than as a client bug.
 *   single-flight ONE rotation per burst of 401s. Without it the home screen's
 *                 three parallel reads rotate three times, two lose, and she is
 *                 signed out mid-session.
 *   wrong password a 401 from sign-in must NOT be treated as an expiry. Refreshing
 *                 a session she does not have yet turns "check your password" into
 *                 "you have been signed out".
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

/**
 * An in-memory AsyncStorage. `session.ts` imports the real native module, which
 * does not load under this config's node environment.
 */
const store = new Map<string, string>();
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (k: string) => store.get(k) ?? null,
    setItem: async (k: string, v: string) => void store.set(k, v),
    removeItem: async (k: string) => void store.delete(k),
    multiRemove: async (ks: string[]) => void ks.forEach((k) => store.delete(k)),
  },
}));

const {
  SESSION_KEY,
  __resetSessionForTest,
  getAccessToken,
  getRefreshToken,
  restore,
  rotated,
  setSession,
} = await import('./session');
const { refreshSession, ApiError, getJson, postJson } = await import('./client');
const { signIn, signOut } = await import('./auth');

/** The member body sign-in returns, trimmed to what MemberSchema requires. */
const MEMBER = {
  id: '8842',
  salonId: 'SAL-AMARA',
  name: 'Dana Al-Sabah',
  phone: '+96599124408',
  email: 'dana@example.com',
  emailVerified: true,
  balanceFils: 24500,
  visits: 5,
  tier: 'silver',
  stamps: null,
  policyVersion: 3,
  joinedAt: '2026-08-18T10:18:26.053Z',
};

interface Call {
  path: string;
  authorization: string | null;
  idempotencyKey: string | null;
  body: Record<string, unknown>;
}

/**
 * Stub fetch with a per-path handler and record what actually went out. Recording
 * the HEADERS is the point for most of these tests — the bug is usually a request
 * carrying the wrong token, not a wrong response being mishandled.
 */
function stubFetch(handler: (path: string, call: Call) => Response): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: { headers?: Record<string, string>; body?: string }) => {
      const path = url.replace('http://localhost:4100', '').replace('http://localhost:4000', '');
      const headers = init.headers ?? {};
      const call: Call = {
        path,
        authorization: headers['authorization'] ?? null,
        idempotencyKey: headers['idempotency-key'] ?? null,
        body: JSON.parse(init.body ?? '{}') as Record<string, unknown>,
      };
      calls.push(call);
      return handler(path, call);
    }),
  );
  return calls;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  store.clear();
  __resetSessionForTest();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ------------------------------------------------------------------- #6 ----

describe('what is persisted — non-negotiable #6', () => {
  it('never writes the password, under any key', async () => {
    stubFetch(() =>
      json({ accessToken: 'AT-1', refreshToken: 'RT-1', expiresAt: 'x', member: MEMBER }),
    );

    await signIn({
      salonId: 'SAL-AMARA',
      phone: '+96599124408',
      password: 'dana-dev-password',
    });

    /*
      A scan of everything the app stored, not an assertion about one field. The
      risk is a future change persisting the credentials "so she stays signed in",
      and this catches that wherever it is written.
    */
    const everything = JSON.stringify([...store.entries()]);
    expect(everything).not.toContain('dana-dev-password');
    expect(everything).not.toContain('password');
  });

  it('keeps the access token in memory and out of storage', async () => {
    stubFetch(() =>
      json({ accessToken: 'AT-1', refreshToken: 'RT-1', expiresAt: 'x', member: MEMBER }),
    );
    await signIn({ salonId: 'SAL-AMARA', phone: '+965', password: 'pw' });

    expect(getAccessToken()).toBe('AT-1');
    const stored = store.get(SESSION_KEY) ?? '';
    expect(stored).not.toContain('AT-1');
    expect(stored).toContain('RT-1');
  });

  it('sends the password in the sign-in body and nowhere else', async () => {
    const calls = stubFetch(() =>
      json({ accessToken: 'AT-1', refreshToken: 'RT-1', expiresAt: 'x', member: MEMBER }),
    );
    await signIn({ salonId: 'SAL-AMARA', phone: '+965', password: 'pw' });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe('/auth/member/session');
    expect(calls[0]?.body['password']).toBe('pw');
  });
});

// -------------------------------------------------------------- rotation ----

describe('rotation is persisted', () => {
  it('stores the NEW refresh token, so the next refresh can work', async () => {
    await setSession({
      accessToken: 'AT-1',
      refreshToken: 'RT-1',
      salonId: 'SAL-AMARA',
      memberId: '8842',
    });
    await rotated({ accessToken: 'AT-2', refreshToken: 'RT-2' });

    expect(getRefreshToken()).toBe('RT-2');
    // The assertion that matters: a rotation kept only in memory survives until
    // the app is closed and then signs her out on the next launch.
    expect(store.get(SESSION_KEY) ?? '').toContain('RT-2');
    expect(store.get(SESSION_KEY) ?? '').not.toContain('RT-1');
  });

  it('keeps the salon and member across a rotation', async () => {
    await setSession({
      accessToken: 'AT-1',
      refreshToken: 'RT-1',
      salonId: 'SAL-AMARA',
      memberId: '8842',
    });
    await rotated({ accessToken: 'AT-2', refreshToken: 'RT-2' });

    const stored = JSON.parse(store.get(SESSION_KEY) ?? '{}') as Record<string, unknown>;
    expect(stored['salonId']).toBe('SAL-AMARA');
    expect(stored['memberId']).toBe('8842');
  });
});

describe('restore', () => {
  it('returns null and CLEARS a corrupt value rather than leaving it', async () => {
    store.set(SESSION_KEY, '{not json');
    expect(await restore()).toBeNull();
    // Left in place, every launch fails on the same bytes and the customer is
    // shown a sign-in screen with no explanation.
    expect(store.has(SESSION_KEY)).toBe(false);
  });

  it('rejects a stored shape missing its refresh token', async () => {
    store.set(SESSION_KEY, JSON.stringify({ salonId: 'SAL-AMARA', memberId: '8842' }));
    expect(await restore()).toBeNull();
    expect(store.has(SESSION_KEY)).toBe(false);
  });

  it('brings back the refresh token and NO access token', async () => {
    store.set(
      SESSION_KEY,
      JSON.stringify({ refreshToken: 'RT-1', salonId: 'SAL-AMARA', memberId: '8842' }),
    );
    const s = await restore();
    expect(s?.refreshToken).toBe('RT-1');
    expect(getRefreshToken()).toBe('RT-1');
    /*
      Deliberately null. Boot then goes through the same refresh a mid-session
      expiry uses, so there is one code path for "get a working access token"
      rather than two.
    */
    expect(getAccessToken()).toBeNull();
  });
});

// --------------------------------------------------------- single flight ----

describe('the refresh latch', () => {
  it('rotates ONCE for a burst of concurrent refreshes', async () => {
    await setSession({
      accessToken: 'AT-1',
      refreshToken: 'RT-1',
      salonId: 'SAL-AMARA',
      memberId: '8842',
    });

    const calls = stubFetch(() =>
      json({ accessToken: 'AT-2', refreshToken: 'RT-2', expiresAt: 'x' }),
    );

    const results = await Promise.all([refreshSession(), refreshSession(), refreshSession()]);

    expect(results).toEqual([true, true, true]);
    /*
      THE WHOLE POINT. Refresh tokens rotate and a replayed one is
      indistinguishable from a stolen one, so three independent refreshes would
      mean one success and two failures — and the two failures clear the session
      out from under a working app.
    */
    const refreshCalls = calls.filter((c) => c.path === '/auth/refresh');
    expect(refreshCalls).toHaveLength(1);
    expect(getRefreshToken()).toBe('RT-2');
  });

  it('signs out when the refresh is refused, and clears storage', async () => {
    await setSession({
      accessToken: 'AT-1',
      refreshToken: 'RT-1',
      salonId: 'SAL-AMARA',
      memberId: '8842',
    });
    stubFetch(() => json({ error: 'session_ended', message: 'That session has ended.' }, 401));

    expect(await refreshSession()).toBe(false);
    expect(getRefreshToken()).toBeNull();
    expect(store.has(SESSION_KEY)).toBe(false);
  });

  it('is false with no stored refresh token, without calling the API', async () => {
    const calls = stubFetch(() => json({}, 200));
    expect(await refreshSession()).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

// ------------------------------------------------- a wrong password is not ----

describe('sign-in failure is not an expiry', () => {
  it('does NOT refresh when sign-in itself 401s', async () => {
    const calls = stubFetch(() =>
      json({ error: 'invalid_credentials', message: 'Those details do not match. Try again.' }, 401),
    );

    await expect(
      signIn({ salonId: 'SAL-AMARA', phone: '+965', password: 'wrong' }),
    ).rejects.toBeInstanceOf(ApiError);

    /*
      One call. `/auth/member/session` is in NO_REAUTH, so the client does not try
      to refresh a session she has not got — which would replace the server's
      "those details do not match" with a sign-out.
    */
    expect(calls.map((c) => c.path)).toEqual(['/auth/member/session']);
  });

  it("surfaces the server's own message, so the screen need not invent one", async () => {
    stubFetch(() =>
      json({ error: 'invalid_credentials', message: 'Those details do not match. Try again.' }, 401),
    );
    await expect(
      signIn({ salonId: 'SAL-AMARA', phone: '+965', password: 'wrong' }),
    ).rejects.toThrow('Those details do not match. Try again.');
  });
});

// ------------------------------------------------ the 401 retry, in place ----

describe('an expired access token is the client’s problem, not a screen’s', () => {
  const Any = z.object({ ok: z.boolean() });

  beforeEach(async () => {
    await setSession({
      accessToken: 'AT-1',
      refreshToken: 'RT-1',
      salonId: 'SAL-AMARA',
      memberId: '8842',
    });
  });

  it('refreshes and retries once, and the retry carries the NEW token', async () => {
    let seenFirst = false;
    const calls = stubFetch((path) => {
      if (path === '/auth/refresh') {
        return json({ accessToken: 'AT-2', refreshToken: 'RT-2', expiresAt: 'x' });
      }
      if (!seenFirst) {
        seenFirst = true;
        return json({ error: 'unauthorized', message: 'Sign in to continue.' }, 401);
      }
      return json({ ok: true });
    });

    await expect(getJson('/members/me', Any)).resolves.toEqual({ ok: true });

    expect(calls.map((c) => c.path)).toEqual(['/members/me', '/auth/refresh', '/members/me']);
    /*
      The retry must not reuse the dead token. `sendOnce` reads the access token at
      SEND time rather than capturing it when the caller started, which is what
      makes this pass.
    */
    expect(calls[0]?.authorization).toBe('Bearer AT-1');
    expect(calls[2]?.authorization).toBe('Bearer AT-2');
  });

  it('retries exactly once — a second 401 is a refusal, not an expiry', async () => {
    const calls = stubFetch((path) => {
      if (path === '/auth/refresh') {
        return json({ accessToken: 'AT-2', refreshToken: 'RT-2', expiresAt: 'x' });
      }
      return json({ error: 'unauthorized', message: 'Sign in to continue.' }, 401);
    });

    await expect(getJson('/members/me', Any)).rejects.toBeInstanceOf(ApiError);
    // Two attempts and one refresh. Looping here would hammer the API with a
    // request that is never going to succeed.
    expect(calls.filter((c) => c.path === '/members/me')).toHaveLength(2);
    expect(calls.filter((c) => c.path === '/auth/refresh')).toHaveLength(1);
  });

  it('reuses the SAME idempotency key on the retry — non-negotiable #4', async () => {
    let seenFirst = false;
    const calls = stubFetch((path) => {
      if (path === '/auth/refresh') {
        return json({ accessToken: 'AT-2', refreshToken: 'RT-2', expiresAt: 'x' });
      }
      if (!seenFirst) {
        seenFirst = true;
        return json({ error: 'unauthorized', message: 'Sign in to continue.' }, 401);
      }
      return json({ ok: true });
    });

    await postJson('/topups', { amountFils: 10000 }, Any, 'key-abc');

    /*
      The case worth checking rather than assuming, because this retry is inside a
      money path. Same key and same body means the server replays its stored answer
      if the first attempt somehow landed, instead of taking a second top-up.
    */
    const topups = calls.filter((c) => c.path === '/topups');
    expect(topups).toHaveLength(2);
    expect(topups[0]?.idempotencyKey).toBe('key-abc');
    expect(topups[1]?.idempotencyKey).toBe('key-abc');
  });

  it('does not retry when there is no refresh token to use', async () => {
    __resetSessionForTest();
    const calls = stubFetch(() => json({ error: 'unauthorized', message: 'Sign in.' }, 401));

    await expect(getJson('/members/me', Any)).rejects.toBeInstanceOf(ApiError);
    expect(calls).toHaveLength(1);
  });
});

// ------------------------------------------------------------- sign-out ----

describe('signOut', () => {
  it('revokes server-side BEFORE forgetting locally', async () => {
    await setSession({
      accessToken: 'AT-1',
      refreshToken: 'RT-1',
      salonId: 'SAL-AMARA',
      memberId: '8842',
    });
    const calls = stubFetch(() => new Response(null, { status: 204 }));

    await signOut();

    /*
      The revoke has to carry the bearer, or it revokes nothing. This app's refresh
      token is recoverable from an unlocked handset, so a local-only clear leaves a
      working credential on a phone she believes she has signed out of.
    */
    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe('/auth/sign-out');
    expect(calls[0]?.authorization).toBe('Bearer AT-1');
    expect(getRefreshToken()).toBeNull();
    expect(store.has(SESSION_KEY)).toBe(false);
  });

  it('still signs out locally when the revoke fails', async () => {
    await setSession({
      accessToken: 'AT-1',
      refreshToken: 'RT-1',
      salonId: 'SAL-AMARA',
      memberId: '8842',
    });
    stubFetch(() => {
      throw new Error('offline');
    });

    await signOut();

    // "Get me off this phone" must not depend on the network. The residual risk —
    // a token alive server-side until it expires — is reported in api/auth.ts.
    expect(getRefreshToken()).toBeNull();
    expect(store.has(SESSION_KEY)).toBe(false);
  });
});
