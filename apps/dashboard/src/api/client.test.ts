import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, request } from './client.js';

/**
 * `ApiError`'s three classifications, pinned.
 *
 * These getters are not conveniences — they are the branch points every state in
 * interaction-spec.md §4 is chosen from. `SectionError` renders one of three
 * different things depending on them:
 *
 *   isUnauthenticated  render NOTHING; the shell is already redirecting
 *   isForbidden        EXPLAIN with the server's own copy, and NO retry button
 *   isConnectivity     "No connection" + the nothing-is-lost reassurance
 *   none of the above  "we failed" + a retry button
 *
 * So a regression here does not throw and does not fail a typecheck. It swaps
 * one designed state for another designed state — a permission refusal that
 * grows a Retry button the merchant presses until she calls someone, or a dead
 * wifi reported as "Something went wrong on our side", which sends her to the
 * wrong person. `retryPolicy.test.ts` covers what the QUERY layer does with
 * these; nothing covered the classification itself.
 *
 * WHY A TEST AND NOT A BROWSER RUN. The connectivity state specifically cannot
 * be demonstrated in the automated browser pane: its document reports
 * `visibilityState: 'hidden'` permanently, and TanStack Query v5 gates retry
 * *continuation* on `focusManager.isFocused()` regardless of `networkMode`. So a
 * connection failure parks at `fetchStatus: 'paused'`, `status: 'pending'` — the
 * error is never recorded and the state never renders, in a focused tab it
 * would. That is a property of the harness, not of this code, which is exactly
 * why the classification needs pinning somewhere a hidden document cannot reach.
 *
 * No DOM, no new test dependency — `shell/useBreakpoint.test.ts` sets that
 * constraint for this column and it still holds.
 */

const api = (status: number, opts: { offline?: boolean; code?: string } = {}) =>
  new ApiError('message from the server', {
    status,
    code: opts.code ?? 'http_error',
    ...(opts.offline === undefined ? {} : { offline: opts.offline }),
  });

describe('ApiError — 401 is "get out of the way"', () => {
  it('classifies only 401 as unauthenticated', () => {
    expect(api(401).isUnauthenticated).toBe(true);
    expect(api(403).isUnauthenticated).toBe(false);
    expect(api(500).isUnauthenticated).toBe(false);
    expect(api(0, { offline: true }).isUnauthenticated).toBe(false);
  });

  it('is what `authedRequest` throws when there is no session at all', () => {
    // Same shape as the server's own 401 on purpose, so callers handle one thing.
    const noSession = new ApiError('Sign in to continue.', { status: 401, code: 'no_session' });
    expect(noSession.isUnauthenticated).toBe(true);
    expect(noSession.isForbidden).toBe(false);
    expect(noSession.isConnectivity).toBe(false);
  });
});

describe('ApiError — 403 is "explain, never retry"', () => {
  it('classifies only 403 as forbidden', () => {
    expect(api(403).isForbidden).toBe(true);
    expect(api(401).isForbidden).toBe(false);
    expect(api(404).isForbidden).toBe(false);
    expect(api(503).isForbidden).toBe(false);
  });

  /*
   * Non-negotiable #7 makes a 403 a NORMAL response on this dashboard, and the
   * server writes the copy that names who can grant the permission. It has to
   * survive to the component verbatim; a paraphrase drops the fix.
   */
  it('carries the server message through untouched', () => {
    const refusal = new ApiError(
      "You don't have permission to manage the team. A manager can grant it.",
      { status: 403, code: 'forbidden' },
    );
    expect(refusal.message).toBe(
      "You don't have permission to manage the team. A manager can grant it.",
    );
  });

  /*
   * A 403 must NOT also read as connectivity. If it did, `SectionError` would
   * offer the "try again once you're back online" reassurance for a refusal that
   * no amount of reconnecting will change.
   */
  it('is not connectivity', () => {
    expect(api(403).isConnectivity).toBe(false);
  });
});

describe('ApiError — connectivity is three distinct causes, one state', () => {
  it('treats a thrown fetch as offline: status 0 and the flag', () => {
    // What client.ts constructs when `fetch` itself rejects — DNS, CORS, a
    // refused connection, the laptop's wifi. There is no response to read.
    const dead = new ApiError('No connection to the workspace.', {
      status: 0,
      code: 'network_error',
      offline: true,
    });
    expect(dead.isConnectivity).toBe(true);
  });

  it('treats a 503 as connectivity even though a response arrived', () => {
    // The API answered, and answered "not right now". For the merchant this is
    // the same sentence as a dead connection, which is why it lands here rather
    // than in the generic "we failed" branch.
    expect(api(503).isConnectivity).toBe(true);
    expect(api(503).offline).toBe(false);
  });

  it('treats status 0 as connectivity even without the flag', () => {
    // Belt and braces: `status === 0` means no HTTP response, whatever set it.
    expect(api(0).isConnectivity).toBe(true);
  });

  it('does NOT sweep every 5xx into offline', () => {
    // A 500 is "we failed" — retry, but do not tell her the network is down and
    // do not promise nothing was lost, because a 500 reached a handler.
    expect(api(500).isConnectivity).toBe(false);
    expect(api(502).isConnectivity).toBe(false);
    expect(api(504).isConnectivity).toBe(false);
  });
});

describe('ApiError — the classifications never overlap', () => {
  /*
   * `SectionError` tests them in order and returns on the first match, so an
   * overlap would not throw — it would silently pick whichever is checked first.
   * Pinning mutual exclusivity is what makes that ordering safe to rely on.
   */
  it.each([
    [401, {}],
    [403, {}],
    [500, {}],
    [503, {}],
    [0, { offline: true }],
  ] as const)('at most one classification is true for %i', (status, opts) => {
    const error = api(status, opts);
    const hits = [error.isUnauthenticated, error.isForbidden, error.isConnectivity].filter(Boolean);
    expect(hits.length).toBeLessThanOrEqual(1);
  });

  it('leaves a plain 500 unclassified, which is the retry branch', () => {
    const error = api(500);
    expect(error.isUnauthenticated).toBe(false);
    expect(error.isForbidden).toBe(false);
    expect(error.isConnectivity).toBe(false);
  });

  it('is an Error, so `instanceof` narrowing in sectionState.tsx holds', () => {
    expect(api(403)).toBeInstanceOf(Error);
    expect(api(403).name).toBe('ApiError');
  });
});


/* ------------------------------------------------- the bearer and the URL */

/**
 * `request` NOW ACCEPTS AN ABSOLUTE URL, AND THAT IS A DOOR THAT HAS TO STAY SHUT.
 *
 * Every other call in this client is a path against `API_BASE_URL`. `ImageRef.url`
 * is not: it is absolute, minted server-side from `PUBLIC_BASE_URL`, and it arrives
 * in a RESPONSE BODY — which makes it data, and this codebase already has a rule
 * about acting on data. Attaching the merchant's bearer to whatever origin a
 * response names would hand her session to whoever owns that origin, and the only
 * thing standing between those two facts is the check pinned here.
 *
 * IT REFUSES RATHER THAN DOWNGRADING. Dropping the header and fetching anyway
 * would answer 401, `authedRequest` would rotate the session, the retry would 401
 * again, and the merchant would be signed out — a token-exfiltration attempt
 * reaching a user as "your session expired".
 */
describe('an absolute URL never carries the session to another origin', () => {
  const fetchMock = vi.fn();
  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it('refuses a cross-origin absolute URL before the request is made', async () => {
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      request('https://evil.example/v1/images/IM-1', { token: 'secret-bearer' }),
    ).rejects.toMatchObject({ code: 'foreign_origin' });
    // The point: no request happened at all, so the token went nowhere.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('allows the API\'s own absolute URL, which is what an ImageRef carries', async () => {
    fetchMock.mockResolvedValue(
      new Response(new Blob(['bytes']), { status: 200, headers: { 'content-type': 'image/png' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await request('http://localhost:4000/v1/images/IM-1', { token: 'tok', expect: 'blob' });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('http://localhost:4000/v1/images/IM-1');
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer tok' });
  });

  it('sends a raw body with the file\'s own type and no JSON content type', async () => {
    fetchMock.mockResolvedValue(new Response('{"id":"IM-1"}', { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);

    const file = new File(['bytes'], 'oil.jpg', { type: 'image/jpeg' });
    const { status } = await (await import('./client.js')).requestDetailed('/v1/x/image', {
      method: 'POST',
      raw: { body: file, contentType: file.type },
      token: 'tok',
    });

    // The status survives the boundary — 201 "added" versus 200 "changed".
    expect(status).toBe(201);
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('image/jpeg');
    expect(init.body).toBe(file);
  });

  it('keeps the machine-readable half of a refusal instead of dropping it', async () => {
    /*
     * `image_too_large` carries `maxBytes`, and `routes/images.ts` puts it there so
     * a client can act on the limit "with a number it did not hard-code". Before
     * `details`, everything but `error` and `message` was discarded here and
     * nothing noticed, because nothing had asked yet.
     */
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: 'image_too_large',
          message: 'That image is 3.4 MB. The limit is 2 MB.',
          maxBytes: 2097152,
          byteSize: 3565158,
        }),
        { status: 413 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const error = await request('/v1/x/image', { method: 'POST' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).details).toEqual({ maxBytes: 2097152, byteSize: 3565158 });
    // …and the two named fields do NOT leak into it.
    expect((error as ApiError).details['message']).toBeUndefined();
  });
});
