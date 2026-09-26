// @vitest-environment jsdom

/**
 * THE BELL'S RESPONSE, PARSED — and the three answers it must keep apart.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `authedRequest<NotificationFeed>` was a CAST (`api/client.ts` ends in
 * `await response.json() as T`), so `visibleKinds` was typed as present and
 * nothing at runtime checked that it was. Against a 200 body of
 * `{ items: [], nextCursor: null, unreadCount: 0 }` both readers threw, and
 * because `NotificationBell` renders in `Header` — which `MerchantShell` renders
 * once above `<Outlet>` — the throw was not a broken dropdown. It was every
 * screen in the dashboard in the CatchBoundary.
 *
 * THE RULE WORTH MORE THAN THE REST
 * ---------------------------------
 * A FEED WE CANNOT TRUST IS A THIRD THING. `?? []` makes the crash go away and
 * replaces it with "Notifications go to the people who can act on them." — a
 * confident, permanent-sounding sentence about the reader's own authority,
 * rendered because a proxy mangled a response. That is the silent failure
 * `visibleKinds` was put on the wire to prevent. So the assertions below are
 * mostly NEGATIVE: the failed read must not be mistaken for the 'none' scope,
 * and the 'none' scope must not be flattened into the failed read.
 *
 * `notificationBell.test.tsx` drives the PANEL with fixtures. This file drives
 * the BOUNDARY — the module, its parse, and the container that wires them — so
 * the two halves are exercised by the thing that can actually break each.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { Component, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const authedRequest = vi.fn();
vi.mock('../auth/authedRequest.js', () => ({
  authedRequest: (...args: unknown[]) => authedRequest(...args),
}));

/** The salon comes from the session, and there is no session in a jsdom realm. */
vi.mock('../auth/AuthProvider.js', () => ({ useSalonId: () => 'SAL-AMARA' }));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));

const mod = await import('./notifications.js');
const {
  feedScope,
  kindListSentence,
  linkTarget,
  parseMarkReadResult,
  parseNotificationFeed,
  unreadIdsOf,
} = mod;
const { NotificationBell } = await import('../shell/NotificationBell.js');

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/* ------------------------------------------------------------- the bodies -- */

/**
 * The wire, as `serialiseNotification` composes it. A PLAIN OBJECT and not a
 * `MerchantNotification`, deliberately: the whole subject of this file is what
 * arrives before anything has proved it is one.
 */
const ROW_BODY: Record<string, unknown> = {
  id: 'MNT-1',
  kind: 'calendar_disconnected',
  severity: 'warning',
  title: "Rana Al-Sabah's calendar is not connected",
  body: 'Falling back to salon hours until she reconnects Google Calendar.',
  deepLink: '/merchant/team/ART-1',
  createdAt: '2026-09-25T09:00:00.000Z',
  readAt: null,
  resolvedAt: null,
};

const FEED_BODY: Record<string, unknown> = {
  items: [ROW_BODY],
  nextCursor: null,
  unreadCount: 1,
  visibleKinds: ['calendar_disconnected', 'booking_no_show', 'campaign_held'],
};

const MARK_READ_BODY: Record<string, unknown> = { marked: 2, unreadCount: 0 };

/** The measured defect, exactly: a 200 with `visibleKinds` simply absent. */
const { visibleKinds: _dropped, ...FEED_WITHOUT_KINDS } = FEED_BODY;

function without(body: Record<string, unknown>, key: string): Record<string, unknown> {
  const copy = { ...body };
  delete copy[key];
  return copy;
}

/* ========================================================================== */
/*  1. every exported reader survives a body missing each required key        */
/* ========================================================================== */

/**
 * TABLE-DRIVEN OFF THE BODY ITSELF, so a seventh field added to the wire next
 * quarter is covered the day the fixture learns about it rather than the day
 * somebody remembers to add a case.
 */
describe('a body missing any required key is a failed read, not a narrowed one', () => {
  /**
   * THE EXPORT CENSUS. `Object.keys` over the module, so a NEW export cannot be
   * added without this list — and therefore the coverage below — moving with it.
   * The alternative is a hand-written list that silently stops being the whole
   * set, which is how `kindListSentence` went unreported as a second crash site.
   */
  it('names every function this module exports, so a seventh cannot arrive unnoticed', () => {
    const exported = Object.entries(mod)
      .filter(([, v]) => typeof v === 'function')
      .map(([k]) => k)
      .sort();
    expect(exported).toEqual(
      [
        'feedScope',
        'kindListSentence',
        'linkTarget',
        'parseMarkReadResult',
        'parseNotification',
        'parseNotificationFeed',
        'unreadIdsOf',
        'useMarkNotificationsRead',
        'useNotifications',
      ].sort(),
    );
  });

  /**
   * THE GATE. Every reader takes its argument out of a `NotificationFeed`, so the
   * way to make them total is to make a `NotificationFeed` impossible to obtain
   * from a body that cannot produce one. Each missing key is rejected BY NAME —
   * "cannot read properties of undefined" names nothing and is what this replaces.
   */
  for (const key of Object.keys(FEED_BODY)) {
    it(`rejects a feed with no ${key}, naming the field`, () => {
      expect(() => parseNotificationFeed(without(FEED_BODY, key))).toThrow(
        new RegExp(`notifications\\.${key}`),
      );
    });
  }

  for (const key of Object.keys(ROW_BODY)) {
    it(`rejects a row with no ${key}, naming the row and the field`, () => {
      expect(() =>
        parseNotificationFeed({ ...FEED_BODY, items: [without(ROW_BODY, key)] }),
      ).toThrow(new RegExp(`items\\[0\\]\\.${key}`));
    });
  }

  /**
   * AND THE OTHER HALF OF "TOTAL": every reader, over every feed that DID get
   * through the gate, returns rather than throws. The parse is the only door, so
   * these two loops together are the guarantee — with no `?? []` anywhere, which
   * would have been the guarantee's replacement by a lie.
   */
  for (const kinds of [
    [],
    ['booking_no_show'],
    ['calendar_disconnected', 'booking_no_show', 'campaign_held'],
    // An enum value this client has not heard of. INERT in both readers (each
    // iterates KNOWN_KINDS), and deliberately not a parse failure: a fourth kind
    // in the pg enum must not darken every screen in the dashboard.
    ['booking_no_show', 'a_kind_from_the_future'],
  ]) {
    it(`every reader is total over a parsed feed whose visibleKinds is ${JSON.stringify(kinds)}`, () => {
      const feed = parseNotificationFeed({ ...FEED_BODY, visibleKinds: kinds });
      expect(() => feedScope(feed.visibleKinds)).not.toThrow();
      expect(() => kindListSentence(feed.visibleKinds)).not.toThrow();
      expect(() => unreadIdsOf(feed.items)).not.toThrow();
      expect(() => feed.items.map((n) => linkTarget(n.deepLink))).not.toThrow();
    });
  }

  /** `unreadIdsOf` takes `items`; a body with no `items` is the same class. */
  it('a feed with no items never reaches unreadIdsOf', () => {
    expect(() => parseNotificationFeed(FEED_WITHOUT_KINDS)).toThrow();
    expect(() => parseNotificationFeed(without(FEED_BODY, 'items'))).toThrow();
  });

  /**
   * THE MARK-READ ANSWER IS THE SAME CAST AND A DIFFERENT FAILURE. A missing
   * `unreadCount` does not throw — it is written into the cache and the badge
   * silently VANISHES, which reads as "nothing to do" about the one number the
   * bell exists to show.
   */
  for (const key of Object.keys(MARK_READ_BODY)) {
    it(`rejects a mark-read answer with no ${key}`, () => {
      expect(() => parseMarkReadResult(without(MARK_READ_BODY, key))).toThrow(
        new RegExp(`read\\.${key}`),
      );
    });
  }
});

/* ========================================================================== */
/*  2–5. what the bell renders, and what the screen behind it keeps doing      */
/* ========================================================================== */

/** The sentence a mangled response must never be allowed to produce. */
const NONE_SENTENCE = 'Notifications go to the people who can act on them.';

/**
 * A boundary of our own, standing in for the router's CatchBoundary. If the bell
 * throws during render, `caught` flips — which is the whole of spec 5.
 */
class Boundary extends Component<{ children: ReactNode }, { caught: string | null }> {
  override state = { caught: null as string | null };
  static getDerivedStateFromError(error: unknown) {
    return { caught: error instanceof Error ? error.message : String(error) };
  }
  override render() {
    return this.state.caught === null ? this.props.children : <p>boundary: {this.state.caught}</p>;
  }
}

const caught = () => screen.queryByText(/^boundary:/);

/**
 * WAIT UNTIL THE QUERY HAS PRODUCED *AN* ANSWER, WHATEVER IT IS.
 *
 * Every assertion in this section is about which of four answers the bell gave,
 * so none of them may wait on one of the four — a test that awaits its own
 * expected sentence fails as a TIMEOUT when the code regresses, which is a true
 * statement about the wrong thing and reads in CI as a flake. Settling on the
 * whole set first means each mutation below fails on the sentence that names it.
 */
const settled = () =>
  waitFor(() =>
    expect(
      screen.queryByText("Couldn't load notifications") ??
        screen.queryByText(NONE_SENTENCE) ??
        screen.queryByText(/all caught up/) ??
        screen.queryByText('Nothing waiting for you.') ??
        caught(),
    ).not.toBeNull(),
  );

/**
 * The shell's shape in miniature: the bell is chrome ABOVE the section, exactly
 * as `MerchantShell` renders `Header` above `<Outlet>`. The `<main>` is the
 * section, and it is what must still be on screen at the end of every case here.
 */
function mount(body: unknown, markReadBody: unknown = MARK_READ_BODY) {
  // Routed on the path: opening the panel fires the mark-read POST, and the two
  // answers are separate casts with separate failures.
  authedRequest.mockImplementation((_scope: string, path: string) =>
    Promise.resolve(String(path).endsWith('/read') ? markReadBody : body),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <Boundary>
      <QueryClientProvider client={client}>
        <NotificationBell />
        <main>Appointments</main>
      </QueryClientProvider>
    </Boundary>,
  );
}

const openBell = async () => {
  const bell = await screen.findByRole('button', { name: /^Notifications/ });
  bell.click();
  return bell;
};

describe('a feed whose shape we did not get', () => {
  /**
   * SPEC 2. The failed-read state, and specifically NOT the 'none' scope. Those
   * are different things and the difference is the point of the fix: one says
   * "we could not load this", the other says "you hold no permission to see it".
   */
  it('renders the bell’s failed-read state and never the ‘none’ sentence', async () => {
    mount(FEED_WITHOUT_KINDS);
    await openBell();
    /*
     * THE ABSENCE IS ASSERTED FIRST, AND BEFORE THE PRESENCE, ON PURPOSE. `?? []`
     * at the call sites makes this body render the 'none' scope, and if the
     * failed-read sentence were awaited first the cheap fix would fail as a
     * timeout — a true statement about the wrong thing. Settling on either
     * outcome and then checking the LIE makes it fail on the sentence that is
     * the defect.
     */
    await settled();
    expect(screen.queryByText(NONE_SENTENCE)).toBeNull();
    // Nor the other two sentences an invented empty feed would have produced.
    expect(screen.queryByText(/all caught up/)).toBeNull();
    expect(screen.queryByText('Nothing waiting for you.')).toBeNull();
    expect(screen.getByText("Couldn't load notifications")).toBeTruthy();
  });

  /**
   * SPEC 5. The bell's failure stays inside the bell. The boundary never fires
   * and the section beside it is still rendered — which is the property the cast
   * destroyed, because the throw happened in chrome that every screen mounts.
   */
  it('leaves the section beside it rendering, and trips no boundary', async () => {
    mount(FEED_WITHOUT_KINDS);
    await openBell();
    /*
     * SETTLED ON EITHER OUTCOME, and that is what makes the assertion below
     * sharp. Waiting on the failed-read text alone would make a re-introduced
     * cast fail as a TIMEOUT — "could not find that sentence" — which is a true
     * statement about the wrong thing. Waiting until the query has produced
     * either answer means the mutation fails on the sentence that names the
     * actual defect: the boundary caught something.
     */
    await settled();
    expect(caught()).toBeNull();
    expect(screen.getByText('Appointments')).toBeTruthy();
  });

  /**
   * NO BADGE OVER A FEED WE DID NOT GET — a number here would be invented, and
   * `unreadCount` is the one field of this body that a mangled response is most
   * likely to still carry.
   *
   * ASSERTED WITHOUT OPENING THE PANEL, and that is the whole precision of it.
   * Opening marks what it drew, and the mark-read answer then legitimately takes
   * the count to zero — so a bell opened first reads 'Notifications' for the
   * right reason and the wrong one alike, and `?? []` passes. The query is
   * settled by awaiting the request itself instead.
   */
  it('announces no count for a feed it could not read', async () => {
    mount(FEED_WITHOUT_KINDS);
    const bell = await screen.findByRole('button', { name: /^Notifications/ });
    await act(async () => {
      await Promise.all(authedRequest.mock.results.map((r: { value: unknown }) => r.value));
    });
    expect(caught()).toBeNull();
    expect(bell.getAttribute('aria-label')).toBe('Notifications');
  });
});

describe('the two real empties still say their own sentences', () => {
  /**
   * SPEC 3. The fix must not flatten a genuinely quiet feed into the error one.
   * `visibleKinds` present and full, `items` empty: the design's own words, true.
   */
  it('a well-formed empty feed is still “You’re all caught up.”', async () => {
    mount({ ...FEED_BODY, items: [], unreadCount: 0 });
    await openBell();
    expect(await screen.findByText(/all caught up/)).toBeTruthy();
    expect(screen.queryByText("Couldn't load notifications")).toBeNull();
    expect(caught()).toBeNull();
  });

  /**
   * SPEC 4. The case the crash would have been mistaken for, and the reason
   * `?? []` is not a fix: this sentence is a real answer about a real reader, and
   * it has to survive a change made because a DIFFERENT thing produced it once.
   */
  it('a genuine ‘none’ feed still says its own sentence, and is not an error', async () => {
    mount({ ...FEED_BODY, items: [], unreadCount: 0, visibleKinds: [] });
    await openBell();
    expect(await screen.findByText(NONE_SENTENCE)).toBeTruthy();
    expect(screen.getByText('Nothing waiting for you.')).toBeTruthy();
    expect(screen.queryByText("Couldn't load notifications")).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(caught()).toBeNull();
  });

  /**
   * THE MARK-READ ANSWER, DRIVEN THROUGH THE HOOK AND NOT ONLY THROUGH THE PARSE.
   *
   * A unit test of `parseMarkReadResult` passes whether or not the mutation calls
   * it — measured: restoring `authedRequest<MarkReadResult>` left every
   * assertion in § 1 green. So this drives the real path. Opening the panel marks
   * what it drew; the POST answers 200 with `unreadCount` missing; `onSuccess`
   * writes `result.unreadCount` STRAIGHT INTO THE CACHE, and `undefined` there
   * does not throw — the badge simply disappears. Which is the badge's own
   * comment from the other direction: "a badge that vanishes on a dropped
   * connection reads as 'nothing to do'."
   *
   * WITH THE PARSE, the throw happens inside `mutationFn`, `onSuccess` never
   * runs, and the cache keeps the server's last good count. The deliberate
   * swallow is already the right handling — the mark repeats on the next open and
   * the 60s poll reconciles — so the assertion is that the number survived.
   */
  it('a mark-read answer missing unreadCount does not silently empty the badge', async () => {
    mount(FEED_BODY, without(MARK_READ_BODY, 'unreadCount'));
    const bell = await openBell();
    await screen.findByText("Rana Al-Sabah's calendar is not connected");
    // The POST has been sent — the panel marks what it drew, on open.
    await waitFor(() =>
      expect(
        authedRequest.mock.calls.some((c: unknown[]) => String(c[1]).endsWith('/read')),
      ).toBe(true),
    );
    /*
     * SETTLE THE MUTATION BEFORE BELIEVING THE COUNT. A bare `waitFor` on the
     * badge passes on its first poll while the POST is still in flight, which is
     * how the first version of this test stayed green with the cast restored. So
     * the mock's own promises are awaited inside `act`, which drains the
     * microtask `onSuccess` would run in either way.
     */
    await act(async () => {
      await Promise.all(authedRequest.mock.results.map((r: { value: unknown }) => r.value));
    });
    expect(bell.getAttribute('aria-label')).toBe('Notifications, 1 unread');
    expect(caught()).toBeNull();
  });

  /** A well-formed populated feed still draws its rows. The gate is not a wall. */
  it('a well-formed populated feed still draws the row and the server’s count', async () => {
    mount(FEED_BODY);
    const bell = await screen.findByRole('button', { name: /^Notifications/ });
    // BEFORE opening: opening marks what it drew, and the mark-read answer then
    // legitimately takes the count to 0. The badge under test is the feed's.
    await waitFor(() => expect(bell.getAttribute('aria-label')).toBe('Notifications, 1 unread'));
    bell.click();
    expect(await screen.findByText("Rana Al-Sabah's calendar is not connected")).toBeTruthy();
    expect(caught()).toBeNull();
  });
});
