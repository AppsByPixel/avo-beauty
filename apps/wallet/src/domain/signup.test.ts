/**
 * Signup, tested where it can actually cost something.
 *
 * Five things are worth a test here and the rest is layout:
 *
 *   #10          the version SENT is the version DISPLAYED. Asserted on the wire
 *                body, because that is the only place the claim is falsifiable.
 *   #10 again    the stale refusal must NOT be recoverable by resubmitting the
 *                `publishedVersion` the server offered — that is the "they agreed
 *                to whatever is current" defect wearing a client's clothes.
 *   `wa`         sent explicitly, as a boolean, even when false. An omitted value
 *                would let `NOT NULL DEFAULT true` store the opposite of an
 *                unticked box, which no screen would ever show as wrong.
 *   #6           the password reaches the request body and nothing else.
 *   totality     every refusal the endpoint can answer with maps to a sentence and
 *                a recovery. An unmapped code is a customer reading "this is on
 *                our side" about something she could have fixed.
 *
 * The mapping test reads the API's OWN SOURCE for the codes rather than restating
 * them, because a list restated in two repositories is a list that drifts — and
 * this project's recorded failure mode is exactly that (MEMORY: stale "not built"
 * comments; DECISIONS.md's four contract drifts). It greps for the string, not for
 * a structure, so Lane A can refactor the handler freely and only a RENAME breaks
 * it — which is precisely the event this test should fail on.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** In-memory AsyncStorage — `session.ts` imports the real native module. */
const store = new Map<string, string>();
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (k: string) => store.get(k) ?? null,
    setItem: async (k: string, v: string) => void store.set(k, v),
    removeItem: async (k: string) => void store.delete(k),
    multiRemove: async (ks: string[]) => void ks.forEach((k) => store.delete(k)),
  },
}));

const { signUp } = await import('../api/auth');
const { __resetSessionForTest, SESSION_KEY, getAccessToken } = await import('../api/session');
const { ApiError } = await import('../api/client');
const { signupRefusal, HANDLED_SIGNUP_CODES, MIN_PASSWORD_LENGTH } = await import('./signup');
const { en } = await import('../copy/en');
const { ar } = await import('../copy/ar');

const MEMBER = {
  id: '9001',
  salonId: 'SAL-AMARA',
  name: 'Dana Al-Sabah',
  phone: '+96599124408',
  email: null,
  emailVerified: false,
  balanceFils: 0,
  visits: 0,
  tier: 'bronze',
  stamps: null,
  policyVersion: 3,
  joinedAt: '2026-08-19T09:00:00.000Z',
};

interface Call {
  path: string;
  body: Record<string, unknown>;
}

function stubFetch(respond: () => Response): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: { body?: string }) => {
      calls.push({
        path: url.replace('http://localhost:4100', ''),
        body: JSON.parse(init.body ?? '{}') as Record<string, unknown>,
      });
      return respond();
    }),
  );
  return calls;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const created = () =>
  json(
    { accessToken: 'AT-1', refreshToken: 'RT-1', expiresAt: 'x', member: MEMBER },
    201,
  );

const REGISTRATION = {
  salonId: 'SAL-AMARA',
  name: 'Dana Al-Sabah',
  phone: '+96599124408',
  password: 'dana-dev-password',
  policyVersion: 3,
  wa: true,
};

beforeEach(() => {
  store.clear();
  __resetSessionForTest();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ------------------------------------------------------------------ #10 ----

describe('non-negotiable #10 — the version she was shown is the version stored', () => {
  it('sends the policyVersion it was given, on the wire', async () => {
    const calls = stubFetch(created);
    await signUp({ ...REGISTRATION, policyVersion: 3 });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe('/auth/member/signup');
    expect(calls[0]?.body['policyVersion']).toBe(3);
  });

  /**
   * The one that would have caught a plausible "fix".
   *
   * `signUp` must not default, infer or invent a version — every one of those
   * satisfies #10's letter and breaks gap 5's "do not rely on 'they agreed to
   * whatever is current'". Asserting the field is absent when the caller omits it
   * is not possible through the typed signature, which is the point: the type is
   * the guard, and this pins the value that actually leaves.
   */
  it('sends a different version when a different one was displayed', async () => {
    const calls = stubFetch(created);
    await signUp({ ...REGISTRATION, policyVersion: 7 });
    expect(calls[0]?.body['policyVersion']).toBe(7);
  });

  /**
   * `policy_version_stale` is a RE-READ, not a resubmit.
   *
   * The 409 carries `publishedVersion`, and the tempting recovery is to send it
   * back — the refusal disappears and the flow works. It is also the exact defect
   * #10 exists to prevent: she would have accepted a document that was never
   * rendered. So the recovery is `reterms` (fetch, re-render, clear the tick), and
   * this test asserts the classification rather than the screen, because the
   * screen has no renderer to test it with.
   */
  it('classifies a stale version as re-read the terms, not as retry', () => {
    const err = new ApiError('server', 'The terms have been updated.', 'WLT-1', 409, 'policy_version_stale', {
      publishedVersion: 4,
      submittedVersion: 3,
    });
    const refusal = signupRefusal(err, en);
    expect(refusal.recovery).toBe('reterms');
    expect(refusal.message).toBe(en.signUpErrTermsChanged);
  });

  it('treats a missing version the same way — fetch and show them again', () => {
    const err = new ApiError('server', 'Show the terms.', 'WLT-1', 409, 'policy_version_required', {
      publishedVersion: 4,
    });
    expect(signupRefusal(err, en).recovery).toBe('reterms');
  });
});

// ------------------------------------------------------------- notify_wa ----

describe('the WhatsApp preference is sent explicitly', () => {
  /**
   * THE DEFECT THIS PREVENTS IS INVISIBLE ON EVERY SCREEN. `member.notify_wa` is
   * `NOT NULL DEFAULT true`, so a payload without `wa` records "yes" for a woman
   * who left the box unticked — and nothing in the app or the database would ever
   * look wrong. The API refuses an absent value rather than defaulting it; this
   * asserts the client never makes it exercise that refusal.
   */
  it('sends false as a boolean false, not by omission', async () => {
    const calls = stubFetch(created);
    await signUp({ ...REGISTRATION, wa: false });

    expect(Object.keys(calls[0]?.body ?? {})).toContain('wa');
    expect(calls[0]?.body['wa']).toBe(false);
  });

  it('sends true as a boolean true', async () => {
    const calls = stubFetch(created);
    await signUp({ ...REGISTRATION, wa: true });
    expect(calls[0]?.body['wa']).toBe(true);
  });

  /**
   * Signup writes no marketing consent, so it must not send a field that looks
   * like one. `offers` on this body would be read by nobody and would suggest to
   * the next reader that the WhatsApp box is the offers opt-in — which is the
   * confusion DECISIONS.md § "Member signup" records having had.
   */
  it('sends no marketing field at all', async () => {
    const calls = stubFetch(created);
    await signUp(REGISTRATION);
    const keys = Object.keys(calls[0]?.body ?? {});
    expect(keys).not.toContain('offers');
    expect(keys).not.toContain('marketing');
    expect(keys.sort()).toEqual(
      ['name', 'password', 'phone', 'policyVersion', 'salonId', 'wa'].sort(),
    );
  });
});

// -------------------------------------------------------------------- #6 ----

describe('non-negotiable #6 — the password', () => {
  it('goes in the request body and into no stored value', async () => {
    const calls = stubFetch(created);
    await signUp(REGISTRATION);

    expect(calls[0]?.body['password']).toBe('dana-dev-password');
    const everything = JSON.stringify([...store.entries()]);
    expect(everything).not.toContain('dana-dev-password');
    expect(everything).not.toContain('password');
  });

  it('stores the session the 201 issued, refresh token only', async () => {
    stubFetch(created);
    await signUp(REGISTRATION);

    // The same split sign-in uses: access token in memory, refresh persisted.
    expect(getAccessToken()).toBe('AT-1');
    const stored = store.get(SESSION_KEY) ?? '';
    expect(stored).toContain('RT-1');
    expect(stored).not.toContain('AT-1');
    expect(stored).toContain('9001');
  });
});

// -------------------------------------------------------------- refusals ----

describe('every refusal is a different sentence', () => {
  it('routes an existing number to Log in rather than to a retry', () => {
    const err = new ApiError('server', 'There is already an account…', 'WLT-1', 409, 'already_registered');
    const refusal = signupRefusal(err, en);
    expect(refusal.recovery).toBe('login');
    expect(refusal.message).toBe(en.signUpErrRegistered);
  });

  /**
   * The hourly ceiling and the five-minute window are NOT the same answer. Telling
   * somebody to "wait a moment" when she has an hour to wait sends her back every
   * minute — the reasoning `services/signupLimit.ts` gives for checking the
   * ceiling first, carried through to the screen.
   */
  it('separates the hourly ceiling from the five-minute window', () => {
    const burst = new ApiError('server', 'x', 'WLT-1', 429, 'signup_rate_limited');
    const ceiling = new ApiError('server', 'x', 'WLT-1', 429, 'signup_hourly_limit');

    expect(signupRefusal(burst, en).recovery).toBe('retype');
    expect(signupRefusal(ceiling, en).recovery).toBe('unavailable');
    expect(signupRefusal(burst, en).message).not.toBe(signupRefusal(ceiling, en).message);
  });

  it('hides the form when there are no terms to accept', () => {
    const err = new ApiError('offline', 'x', 'WLT-1', 503, 'policies_not_published');
    /*
      `policies_not_published` is a 503, which `classify()` calls `offline` — and
      the offline branch would swallow it. The code is checked first for exactly
      this collision: "no connection" is the wrong sentence for a deployment with
      no published terms, and she would retry forever against it.
    */
    const refusal = signupRefusal(err, en);
    expect(refusal.message).toBe(en.signUpErrTermsMissing);
    expect(refusal.recovery).toBe('unavailable');
  });

  it('does not pass the server’s English sentence through', () => {
    const err = new ApiError('server', 'A SERVER SENTENCE', 'WLT-1', 400, 'invalid_phone');
    for (const copy of [en, ar]) {
      expect(signupRefusal(err, copy).message).not.toContain('A SERVER SENTENCE');
    }
  });

  it('renders an unmapped code as our failure, not as the server’s words', () => {
    const err = new ApiError('server', 'SOMETHING NEW', 'WLT-1', 400, 'a_code_from_the_future');
    const refusal = signupRefusal(err, en);
    expect(refusal.message).toBe(en.signUpErrFailed);
    expect(refusal.recovery).toBe('retype');
  });

  it('tells a dead connection from a refusal, and does not reuse sign-in’s sentence', () => {
    const err = new ApiError('offline', 'No connection.', 'WLT-1', null);
    expect(signupRefusal(err, en).message).toBe(en.signUpOffline);
    expect(en.signUpOffline).not.toBe(en.signInOffline);
  });

  it('survives something that is not an ApiError at all', () => {
    expect(signupRefusal(new TypeError('boom'), en).message).toBe(en.signUpErrFailed);
  });
});

// -------------------------------------------------------------- totality ----

const API_SOURCES = [
  'api/src/routes/auth.ts',
  'api/src/services/policy.ts',
  'api/src/services/signupLimit.ts',
  'api/src/http/fields.ts',
  'api/src/auth/password.ts',
];

/**
 * Every code the signup path can answer with, as recorded in the API's own source.
 *
 * Deliberately NOT derived by parsing the handler: three of these are thrown by
 * helpers the handler calls (`parseE164`, `requireCurrentPolicyVersion`,
 * `enforceSignupLimits`), and a parse that followed the call graph would be a
 * second implementation of TypeScript. The list is written down, and the test
 * below asserts each entry still EXISTS in that source — which catches the one
 * change that would silently break the screen, a rename.
 */
const SIGNUP_CODES = [
  'already_registered',
  'policy_version_stale',
  'policy_version_required',
  'policies_not_published',
  'wa_preference_required',
  'password_too_short',
  'invalid_phone',
  'unknown_salon',
  'signup_rate_limited',
  'signup_hourly_limit',
] as const;

describe('the refusal mapping is total over what the API can throw', () => {
  const source = API_SOURCES.map((rel) =>
    readFileSync(join(__dirname, '../../../..', rel), 'utf8'),
  ).join('\n');

  it('every code the API throws is still spelled that way in its source', () => {
    const missing = SIGNUP_CODES.filter((code) => !source.includes(`'${code}'`));
    expect(missing).toEqual([]);
  });

  it('every code the API throws has a sentence and a recovery', () => {
    const unhandled = SIGNUP_CODES.filter((code) => !HANDLED_SIGNUP_CODES.includes(code));
    expect(unhandled).toEqual([]);
  });

  /**
   * The other direction, and it is not redundant: a handled code that the API can
   * no longer produce is dead copy, and dead copy in AR_GAPS wastes a
   * native speaker's time on a sentence nobody will read.
   */
  it('handles no code the API cannot produce', () => {
    const orphans = HANDLED_SIGNUP_CODES.filter(
      (code) => !(SIGNUP_CODES as readonly string[]).includes(code),
    );
    expect(orphans).toEqual([]);
  });

  it('gives every code a non-empty sentence in BOTH languages', () => {
    for (const code of SIGNUP_CODES) {
      const err = new ApiError('server', '', 'WLT-1', 400, code);
      for (const [name, copy] of [['en', en], ['ar', ar]] as const) {
        const { message } = signupRefusal(err, copy);
        expect(message, `${code} in ${name}`).toBeTruthy();
      }
    }
  });
});

// --------------------------------------------------------- password rule ----

describe('the client’s password minimum matches the API’s', () => {
  /**
   * Two constants for one rule, so they are pinned against each other. The API's
   * `MIN_PASSWORD_LENGTH` is the authority; a client that checked 8 would refuse a
   * password the server would have accepted, and one that checked 4 would spend an
   * argon2 hash and a rate-limiter slot to be told so.
   */
  it('is the same number api/src/auth/password.ts declares', () => {
    const source = readFileSync(
      join(__dirname, '../../../../api/src/auth/password.ts'),
      'utf8',
    );
    const match = /MIN_PASSWORD_LENGTH\s*=\s*(\d+)/.exec(source);
    expect(match?.[1]).toBe(String(MIN_PASSWORD_LENGTH));
  });

  it('shares one sentence with the server’s password_too_short', () => {
    const err = new ApiError('server', 'x', 'WLT-1', 400, 'password_too_short');
    expect(signupRefusal(err, en).message).toBe(en.signUpErrShort);
    // The design wrote this one in Arabic, so it is NOT an AR gap.
    expect(ar.signUpErrShort).not.toBe(en.signUpErrShort);
  });
});
