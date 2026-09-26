// @vitest-environment jsdom

/**
 * THE MERCHANT BELL, and the one rule whose failure is silent.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `merchant_notification` has been filling since phase 6 and nothing in the
 * product could read a row. Lane A built the two endpoints; this is the surface,
 * and these are the properties that a screenshot of a working bell would not
 * show.
 *
 * THE RULE WORTH MORE THAN THE REST
 * ---------------------------------
 * THE TWO EMPTIES. The feed is filtered to the kinds the reader's permissions
 * cover, so an empty panel is two different sentences: "nothing is waiting"
 * (true only when she can see every kind) and "nothing is waiting *for you*"
 * (a narrower claim). `visibleKinds` is on the wire for exactly this, and the
 * failure mode is that both render the design's "You're all caught up." and
 * nothing anywhere disagrees - a merchant told her salon is quiet when two
 * things are waiting for a colleague.
 *
 * So it is MUTATED rather than merely compared (§ the mutation): `feedScope` is
 * replaced with one that answers 'full' for everything, and the narrowed empty
 * has to start lying for the swap to be visible. A panel that derived its
 * sentence from anything other than `visibleKinds` - the item count, a
 * permission snapshot, a hardcoded string - passes the comparison and fails
 * this.
 *
 * WHAT IS NOT ASSERTED HERE, NAMED SO THE ABSENCE IS A DECISION
 * ------------------------------------------------------------
 * WHICH KINDS A READER MAY SEE. `visibleKinds` in
 * `api/src/services/merchantNotifications.ts` decides that, from `perms` loaded
 * per request, and `routes/merchantNotifications.int.test.ts` drives it by
 * request with the permission off. A test here asserting "a front desk sees
 * no-shows" would be asserting a rule this column does not own and cannot see
 * change. What IS asserted is that the panel renders the ANSWER honestly
 * whatever it is.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client.js';
import type {
  FeedScope,
  MarkReadSelection,
  MerchantNotification,
  NotificationFeed,
  NotificationKind,
} from '../api/notifications.js';
import { NotificationBellPanel } from './NotificationBell.js';

/**
 * THE MUTATION HOOK. By default this is the real `feedScope` - every test below
 * runs against the shipped derivation. § the mutation swaps it for one test.
 *
 * `...actual` rather than a bare stub: `NotificationBell.tsx` also imports
 * `kindListSentence`, `linkTarget` and `unreadIdsOf` from this module, and a
 * narrow mock would blank the panel instead of testing it.
 */
let scopeImpl: ((kinds: readonly NotificationKind[]) => FeedScope) | null = null;

vi.mock('../api/notifications.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/notifications.js')>();
  return {
    ...actual,
    feedScope: (kinds: readonly NotificationKind[]) =>
      scopeImpl ? scopeImpl(kinds) : actual.feedScope(kinds),
  };
});

/* `shopRender.test.tsx`: vitest does not run with `globals`, so nothing
 * registers @testing-library's own cleanup and every render would accumulate. */
afterEach(() => {
  cleanup();
  scopeImpl = null;
});

const ALL_KINDS: NotificationKind[] = [
  'calendar_disconnected',
  'booking_no_show',
  'campaign_held',
];

/**
 * The live row on Aftab's demo database, field for field. `availability.ts`
 * composes both strings; the panel renders them and invents nothing per kind.
 */
const RANA: MerchantNotification = {
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

/** Raised, then resolved when she reconnected. Still in the feed, never counted. */
const RECONNECTED: MerchantNotification = {
  ...RANA,
  id: 'MNT-2',
  title: "Dana Yousef's calendar is not connected",
  createdAt: '2026-09-24T09:00:00.000Z',
  readAt: null,
  resolvedAt: '2026-09-24T11:00:00.000Z',
};

const NO_SHOW: MerchantNotification = {
  id: 'MNT-3',
  kind: 'booking_no_show',
  severity: 'info',
  title: 'No-show recorded',
  body: 'Mariam K. did not arrive for her appointment.',
  deepLink: null,
  createdAt: '2026-09-23T09:00:00.000Z',
  readAt: '2026-09-23T10:00:00.000Z',
  resolvedAt: null,
};

function feedOf(over: Partial<NotificationFeed> = {}): NotificationFeed {
  return {
    items: [RANA, RECONNECTED, NO_SHOW],
    nextCursor: null,
    unreadCount: 1,
    visibleKinds: ALL_KINDS,
    ...over,
  };
}

type Sent = MarkReadSelection[];

function panel(
  over: Partial<React.ComponentProps<typeof NotificationBellPanel>> = {},
  sent: Sent = [],
  went: string[] = [],
) {
  return (
    <NotificationBellPanel
      feed={feedOf()}
      pending={false}
      error={null}
      onRetry={() => {}}
      retrying={false}
      onMarkRead={(s) => sent.push(s)}
      onNavigate={(to) => went.push(to)}
      updatedAt={Date.parse('2026-09-26T08:30:00.000Z')}
      {...over}
    />
  );
}

const bell = () => screen.getByRole('button', { name: /^Notifications/ });
const openPanel = () => fireEvent.click(bell());

/* ========================================================================== */
describe('the badge is the server’s count, not the panel’s arithmetic', () => {
  /**
   * `unreadCount` is an aggregate over the WHOLE visible set and is deliberately
   * not cursor-dependent - "a badge that counted the current page would be a
   * different number for the same bell". A client that derived it from `items`
   * would be page-dependent by construction, so the fixture is built to tell the
   * two apart: three rows, two of them unread, and a server count of 1.
   */
  it('renders unreadCount and not a count it worked out from the rows', () => {
    render(panel({ feed: feedOf({ unreadCount: 7 }) }));
    expect(bell().getAttribute('aria-label')).toBe('Notifications, 7 unread');
    expect(screen.getByText('7')).toBeTruthy();
  });

  it('draws no badge at all when nothing is unread', () => {
    render(panel({ feed: feedOf({ unreadCount: 0 }) }));
    expect(bell().getAttribute('aria-label')).toBe('Notifications');
    expect(screen.queryByText('0')).toBeNull();
  });

  /**
   * THE PREMATURE ZERO. `stateCensus.test.ts § the announced rule`: a pending
   * screen must not announce a zero it is not painting. `feed?.unreadCount ?? 0`
   * is the natural spelling and would put "0 unread" in the accessible name of a
   * bell that has not finished asking.
   */
  it('announces no number while the first fetch is still in flight', () => {
    render(panel({ feed: undefined, pending: true }));
    expect(bell().getAttribute('aria-label')).toBe('Notifications');
    expect(bell().textContent).not.toContain('0');
  });
});

/* ========================================================================== */
describe('the two empties, which is what visibleKinds is for', () => {
  const EMPTY = { items: [], unreadCount: 0 };

  it('a reader who can see every kind is genuinely caught up', () => {
    render(panel({ feed: feedOf({ ...EMPTY, visibleKinds: ALL_KINDS }) }));
    openPanel();
    expect(screen.getByText(/all caught up/)).toBeTruthy();
    // No narrowing claim is made about a feed that is not narrowed.
    expect(screen.queryByText(/Others go to the people who can act on them/)).toBeNull();
  });

  it('a reader who can see one kind gets the narrower sentence, naming it', () => {
    render(panel({ feed: feedOf({ ...EMPTY, visibleKinds: ['booking_no_show'] }) }));
    openPanel();
    expect(screen.queryByText(/all caught up/)).toBeNull();
    expect(screen.getByText('Nothing waiting for you.')).toBeTruthy();
    expect(
      screen.getByText('You see no-show notifications. Others go to the people who can act on them.'),
    ).toBeTruthy();
  });

  /**
   * NONE OF THE THREE. The API answers 200 and an empty feed rather than 403,
   * because the bell is chrome on every screen and a 403 makes every screen look
   * broken for someone whose account is working exactly as configured. So this
   * must render as a state and never as an error.
   */
  it('a reader who holds none of the three sees a panel, not a refusal', () => {
    render(panel({ feed: feedOf({ ...EMPTY, visibleKinds: [] }) }));
    openPanel();
    expect(screen.getByText('Nothing waiting for you.')).toBeTruthy();
    expect(screen.getByText('Notifications go to the people who can act on them.')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  /**
   * THE DISCLOSURE IS NOT ONLY AN EMPTY STATE, and that is what makes the
   * design's "Mark all read" honest over a narrowed feed: the button marks what
   * she could have read and nothing else (the server takes the same filter as
   * the read), and the sentence above it has already said what "all" covers.
   */
  it('says what it covers above a populated narrowed list too', () => {
    render(panel({ feed: feedOf({ visibleKinds: ['calendar_disconnected', 'campaign_held'] }) }));
    openPanel();
    expect(
      screen.getByText(
        'You see calendar and campaign notifications. Others go to the people who can act on them.',
      ),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Mark all read' })).toBeTruthy();
  });

  /* ------------------------------------------------------- § the mutation -- */
  /**
   * THE RULE, PROVED RATHER THAN COMPARED.
   *
   * With `feedScope` replaced by one that answers 'full' for every input - the
   * exact shape of a panel that ignored `visibleKinds` - the narrowed empty
   * renders the design's confident sentence over a feed that is not confident.
   * That is the defect in one line, and the test above is what catches it.
   */
  it('the narrowed empty moves when the derivation moves', () => {
    scopeImpl = () => 'full';
    render(panel({ feed: feedOf({ ...EMPTY, visibleKinds: ['booking_no_show'] }) }));
    openPanel();
    // The false sentence, reached only because the derivation was swapped.
    expect(screen.getByText(/all caught up/)).toBeTruthy();
    expect(screen.queryByText('Nothing waiting for you.')).toBeNull();
  });
});

/* ========================================================================== */
describe('resolved is not read: the row stays, struck, and uncounted', () => {
  it('strikes a resolved row and says so where a strike cannot be seen', () => {
    render(panel());
    openPanel();

    const resolved = screen.getByText("Dana Yousef's calendar is not connected");
    expect(resolved.getAttribute('data-resolved')).toBe('true');
    // `text-decoration` reaches no screen reader. The fact is in the tree too.
    expect(screen.getByText('Resolved.')).toBeTruthy();

    // The unresolved row beside it is not struck - the attribute is doing work.
    expect(
      screen.getByText("Rana Al-Sabah's calendar is not connected").getAttribute('data-resolved'),
    ).toBeNull();
  });

  /**
   * IT DOES NOT VANISH. Dropping a resolved row is the dishonesty lane A named:
   * a merchant who saw a badge, got pulled away and came back to an empty panel
   * learns nothing and stops trusting the bell.
   */
  it('keeps the resolved row in the feed', () => {
    render(panel());
    openPanel();
    expect(screen.getAllByText(/calendar is not connected/)).toHaveLength(2);
  });

  /**
   * AND IT IS NOT IN THE BADGE. The fixture's two unread rows include the
   * resolved one; the server counts unread AND unresolved, which is 1.
   */
  it('does not count toward the badge', () => {
    render(panel());
    expect(bell().getAttribute('aria-label')).toBe('Notifications, 1 unread');
  });
});

/* ========================================================================== */
describe('a row that goes nowhere is not a control', () => {
  /** `deepLink: null` - the API's own answer for a link that failed validation. */
  it('renders a null deep link as text rather than a button', () => {
    render(panel({ feed: feedOf({ items: [NO_SHOW] }) }));
    openPanel();
    expect(screen.queryByRole('button', { name: /No-show recorded/ })).toBeNull();
    expect(screen.getByText('No-show recorded')).toBeTruthy();
  });

  /**
   * THE SECOND REASON A ROW IS UNCLICKABLE, AND IT IS THIS DASHBOARD'S PROBLEM.
   *
   * `/merchant/team/ART-1` is what `availability.ts` writes and what
   * `safeDeepLink` correctly passes - it is a site-relative path. This shell is
   * a PATHLESS layout route, so its sections are `/team`, `/appointments`,
   * `/marketing`, with no `/merchant` prefix and no per-id route. Following one
   * lands on the router's not-found, so it renders as the null case does.
   *
   * REPORTED, NOT TRANSLATED. Rewriting it to `/team` would drop the artist the
   * notification is about and land her on a list that looks like it worked.
   */
  it('renders a link this router does not serve as text rather than a 404', () => {
    render(panel({ feed: feedOf({ items: [RANA] }) }));
    openPanel();
    expect(screen.queryByRole('button', { name: /Rana Al-Sabah/ })).toBeNull();
  });

  it('is a button, and navigates, for a path this shell does serve', () => {
    const went: string[] = [];
    render(panel({ feed: feedOf({ items: [{ ...RANA, deepLink: '/team' }] }) }, [], went));
    openPanel();
    fireEvent.click(screen.getByRole('button', { name: /Rana Al-Sabah/ }));
    expect(went).toEqual(['/team']);
  });
});

/* ========================================================================== */
describe('opening marks what it showed', () => {
  /**
   * `{ ids }`, NEVER `{ all: true }`. The panel draws one page; `all` would
   * silence rows further down the stream that nobody has seen, which is the
   * opposite of what opening a panel means.
   *
   * The resolved-but-unread row IS included: `read_at` answers "has anybody
   * looked at this", and the panel drew it.
   */
  it('sends the ids it drew, and only the ones that were unread', () => {
    const sent: Sent = [];
    render(panel({}, sent));
    openPanel();
    expect(sent).toEqual([{ ids: ['MNT-1', 'MNT-2'] }]);
  });

  it('does not mark anything before it is opened', () => {
    const sent: Sent = [];
    render(panel({}, sent));
    expect(sent).toEqual([]);
  });

  /**
   * A POLL LANDING ON AN OPEN PANEL MUST NOT RE-SEND. The server is idempotent
   * (`WHERE read_at IS NULL`), so this is about traffic on chrome rather than
   * correctness - which is exactly the budget lane A bought by leaving this read
   * out of the audit log.
   */
  it('does not re-send when the same rows arrive again', () => {
    const sent: Sent = [];
    const { rerender } = render(panel({}, sent));
    openPanel();
    rerender(panel({ feed: feedOf() }, sent));
    expect(sent).toEqual([{ ids: ['MNT-1', 'MNT-2'] }]);
  });

  it('sends nothing at all when every row it drew was already read', () => {
    const sent: Sent = [];
    render(panel({ feed: feedOf({ items: [NO_SHOW], unreadCount: 0 }) }, sent));
    openPanel();
    expect(sent).toEqual([]);
  });

  /** The design's button, and the one place `{ all: true }` is correct. */
  it('“Mark all read” asks for all of them', () => {
    const sent: Sent = [];
    render(panel({}, sent));
    openPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Mark all read' }));
    expect(sent).toContainEqual({ all: true });
  });

  it('offers no “Mark all read” when there is nothing to mark', () => {
    render(panel({ feed: feedOf({ unreadCount: 0 }) }));
    openPanel();
    expect(screen.queryByRole('button', { name: 'Mark all read' })).toBeNull();
  });
});

/* ========================================================================== */
describe('the four states, and a bell that fails does not take the screen', () => {
  it('loading: skeletons, no rows, and no empty sentence', () => {
    const { container } = render(panel({ feed: undefined, pending: true }));
    openPanel();
    expect(container.querySelectorAll('.avo-skeleton').length).toBeGreaterThan(0);
    expect(screen.queryByText(/all caught up/)).toBeNull();
    expect(screen.queryByText('Nothing waiting for you.')).toBeNull();
  });

  it('error: the panel explains itself and offers the retry', () => {
    const onRetry = vi.fn();
    render(
      panel({
        feed: undefined,
        error: new ApiError('boom', { status: 500, code: 'http_error' }),
        onRetry,
      }),
    );
    openPanel();
    expect(screen.getByText("Couldn't load notifications")).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalled();
  });

  it('offline: the connection is named, not the server', () => {
    render(
      panel({
        feed: undefined,
        error: new ApiError('no route to host', { status: 0, code: 'offline', offline: true }),
      }),
    );
    openPanel();
    expect(screen.getByText('No connection')).toBeTruthy();
  });

  /**
   * STALE-NOT-BLANK. A failed refresh over a feed we already have is a banner
   * above the rows she was reading, never a replacement for them - and the badge
   * keeps its number, because a badge that vanishes on a dropped connection
   * reads as "nothing to do".
   */
  it('a failed refresh keeps the rows and the count', () => {
    render(
      panel({
        error: new ApiError('gone', { status: 0, code: 'offline', offline: true }),
      }),
    );
    expect(bell().getAttribute('aria-label')).toBe('Notifications, 1 unread');
    openPanel();
    expect(screen.getByText(/Couldn’t refresh/)).toBeTruthy();
    expect(screen.getByText("Rana Al-Sabah's calendar is not connected")).toBeTruthy();
    expect(screen.queryByText("Couldn't load notifications")).toBeNull();
  });

  /**
   * THE BELL IS CHROME. Everything it renders is inside the popover, so a failed
   * bell leaves the screen behind it untouched - and the trigger keeps working
   * so she can close it.
   */
  it('a failing bell still opens and closes, and paints nothing outside itself', () => {
    const { container } = render(
      panel({ feed: undefined, error: new ApiError('boom', { status: 500, code: 'http_error' }) }),
    );
    const root = container.querySelector('.dash-bell') as HTMLElement;
    openPanel();
    expect(screen.getByRole('dialog', { name: 'Notifications' })).toBeTruthy();
    // Every rendered node is inside the bell's own subtree.
    expect(root.contains(screen.getByText("Couldn't load notifications"))).toBe(true);
    fireEvent.click(bell());
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

/* ========================================================================== */
describe('the page it is showing, said out loud', () => {
  /**
   * `nextCursor` is a REAL cursor here, unlike `GET …/orders` where it is
   * always-null beside an honest `truncated`. The panel shows one page, and the
   * badge counts the whole visible set - so a merchant with more than a page of
   * unread sees a badge larger than the rows in front of her. A scroller that
   * simply stopped would be the "capped list reports itself as complete" defect
   * that cost this lane a wrong deposit total once already.
   */
  it('says there are older ones when the stream has not run out', () => {
    render(panel({ feed: feedOf({ nextCursor: 'CUR-2', unreadCount: 24 }) }));
    openPanel();
    expect(screen.getByText(/Older notifications aren’t shown here/)).toBeTruthy();
  });

  it('says nothing of the kind when the stream is exhausted', () => {
    render(panel());
    openPanel();
    expect(screen.queryByText(/Older notifications aren’t shown here/)).toBeNull();
  });
});

/* ========================================================================== */
describe('the popover’s keyboard contract', () => {
  /**
   * NOT A MODAL. interaction-spec.md §2 scopes focus TRAPPING to sheets and
   * modals; the page behind this stays live, so `aria-modal` would be a promise
   * to a screen reader that is false. What it does owe is Esc, and focus back on
   * the trigger afterwards.
   */
  it('Esc closes it and hands focus back to the bell', () => {
    render(panel());
    openPanel();
    expect(screen.getByRole('dialog', { name: 'Notifications' })).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(bell());
  });

  it('states whether it is open, for a reader who cannot see it', () => {
    render(panel());
    expect(bell().getAttribute('aria-expanded')).toBe('false');
    openPanel();
    expect(bell().getAttribute('aria-expanded')).toBe('true');
  });
});
