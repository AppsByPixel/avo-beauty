// @vitest-environment jsdom

/**
 * THE BELL, RENDERED — client ask W4.
 *
 * Only `fetch` is stubbed. The real `client.ts`, the real zod schemas in
 * `api/bell.ts`, the real `useBell` and the real `BellSheet`/`BellButton` run,
 * so "a malformed body is a failed read" is proved through the same parse a
 * device does, and "mark-read sends the drawn ids" is read off the actual
 * request body that left the app.
 *
 * `react-native-svg` is stubbed to nothing, as every render suite here does —
 * it cannot load under vitest (see vitest.config.ts). It costs the bell glyph,
 * which nothing below looks at.
 */

import fs from 'node:fs';
import path from 'node:path';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Language } from '@avo/types';

vi.mock('react-native-svg', () => {
  const nothing = () => null;
  return { default: nothing, Svg: nothing, Path: nothing, Circle: nothing, Rect: nothing, G: nothing };
});

/* eslint-disable import/first */
import { LanguageProvider } from '../i18n/language';
import { useBell } from '../state/useBell';
import { BellButton } from './BellButton';
import { BellSheet } from './BellSheet';
import { en } from '../copy/en';
import { ar } from '../copy/ar';

const AT = '2026-09-28T08:38:18.990Z';

const topup = (id: string, readAt: string | null = null) => ({
  id,
  transactionId: id,
  createdAt: AT,
  readAt,
  kind: 'topup',
  amountFils: 10000,
  bonusFils: 1000,
  creditFils: 11000,
  method: 'knet',
});

const ALL_KINDS = ['topup', 'charge', 'shop', 'deposit_hold', 'deposit_return', 'campaign'];

const feed = (items: unknown[], over: Record<string, unknown> = {}) => ({
  items,
  nextCursor: null,
  unreadCount: items.filter((i) => (i as { readAt: unknown }).readAt === null).length,
  visibleKinds: ALL_KINDS,
  ...over,
});

interface Posted {
  path: string;
  body: unknown;
}

/**
 * Routes by path. `pages` answers the feed in order (page one, then any "show
 * more"), and every POST body is recorded.
 */
function stubApi(pages: Array<unknown | Error>): Posted[] {
  const posted: Posted[] = [];
  let page = 0;
  /** What the server would still count unread — the feed's figure, less marks. */
  let unread = 0;
  vi.stubGlobal('fetch', (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    if ((init.method ?? 'GET') === 'POST') {
      const body = JSON.parse(String(init.body));
      posted.push({ path: u.pathname, body });
      const n = Array.isArray(body.ids) ? body.ids.length : unread;
      unread = body.all === true ? 0 : Math.max(0, unread - n);
      return Promise.resolve(
        new Response(JSON.stringify({ marked: n, unreadCount: unread }), { status: 200 }),
      );
    }
    if (u.pathname === '/members/me/notifications/feed') {
      const cursor = u.searchParams.get('cursor');
      const answer = pages[Math.min(cursor === null ? 0 : ++page, pages.length - 1)];
      if (answer instanceof Error) return Promise.reject(answer);
      const count = (answer as { unreadCount?: unknown }).unreadCount;
      if (typeof count === 'number') unread = count;
      return Promise.resolve(new Response(JSON.stringify(answer), { status: 200 }));
    }
    return Promise.resolve(new Response('{}', { status: 404 }));
  });
  return posted;
}

function Harness({ onOpenSettings = () => undefined }: { onOpenSettings?: () => void }) {
  const bell = useBell({ enabled: true });
  return (
    <>
      <BellButton unreadCount={bell.unreadCount} onPress={bell.openPanel} />
      <BellSheet bell={bell} salon="Amara" timeZone="Asia/Kuwait" transactions={[]} onOpenSettings={onOpenSettings} />
    </>
  );
}

function draw(lang: Language = 'en', onOpenSettings?: () => void) {
  return render(
    <LanguageProvider initial={lang}>
      <Harness {...(onOpenSettings ? { onOpenSettings } : {})} />
    </LanguageProvider>,
  );
}

async function openBell() {
  await act(async () => {
    fireEvent.click(screen.getByTestId('bell-open'));
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// ------------------------------------------------------------- mark read --

describe('opening the bell marks the DRAWN rows — { ids }, never { all }', () => {
  it('sends exactly the unread, markable ids on screen', async () => {
    const posted = stubApi([
      feed([
        topup('TX-1'),
        topup('TX-2', '2026-09-28T09:00:00.000Z'), // already read — not sent
        { id: 'LE-1', kind: 'tier_climb', createdAt: AT, readAt: null }, // unknown — not sent
        topup('TX-3'),
      ]),
    ]);
    draw();
    await waitFor(() => expect(screen.getByTestId('bell-badge').textContent).toBe('3'));
    // Nothing is marked by the badge read alone.
    expect(posted).toEqual([]);

    await openBell();
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({ path: '/members/me/notifications/read', body: { ids: ['TX-1', 'TX-3'] } });
    // The rows those ids name are the rows drawn.
    expect(screen.getByTestId('bell-row-TX-1')).toBeTruthy();
    expect(screen.getByTestId('bell-row-TX-3')).toBeTruthy();
  });

  it('"Show more" marks the NEW page’s rows, not the first page again', async () => {
    const posted = stubApi([
      feed([topup('TX-1')], { nextCursor: 'c1', unreadCount: 2 }),
      feed([topup('TX-9')], { unreadCount: 1 }),
    ]);
    draw();
    await openBell();
    await waitFor(() => expect(posted).toHaveLength(1));
    await act(async () => {
      fireEvent.click(screen.getByTestId('bell-more'));
    });
    await waitFor(() => expect(posted).toHaveLength(2));
    expect(posted.map((p) => p.body)).toEqual([{ ids: ['TX-1'] }, { ids: ['TX-9'] }]);
  });

  it('{ all: true } goes only from the explicit control', async () => {
    const posted = stubApi([feed([topup('TX-1')], { unreadCount: 40 })]);
    draw();
    await openBell();
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted.every((p) => !('all' in (p.body as object)))).toBe(true);
    await act(async () => {
      fireEvent.click(screen.getByTestId('bell-mark-all'));
    });
    await waitFor(() => expect(posted).toHaveLength(2));
    expect(posted[1]!.body).toEqual({ all: true });
  });
});

// ------------------------------------------------------------- the states --

describe('a malformed body is a FAILED READ, not an empty bell', () => {
  it('a float amount → the error state with a reference, and no "all caught up"', async () => {
    stubApi([feed([{ ...topup('TX-1'), amountFils: 8.5 }])]);
    draw();
    await openBell();
    await waitFor(() => expect(screen.getByTestId('bell-failed')).toBeTruthy());
    expect(screen.getByTestId('bell-failed').textContent).toContain(en.bellLoadFailed);
    expect(screen.queryByTestId('bell-empty')).toBeNull();
    // And the badge claims nothing — no "0", because nothing was read.
    expect(screen.queryByTestId('bell-badge')).toBeNull();
  });
});

describe('the other states', () => {
  it('empty is a good outcome, with its own words', async () => {
    stubApi([feed([])]);
    draw();
    await openBell();
    await waitFor(() => expect(screen.getByTestId('bell-empty')).toBeTruthy());
    expect(screen.getByTestId('bell-empty').textContent).toContain(en.bellEmptyTitle);
  });

  it('offline with nothing kept → the cold offline words, not the error', async () => {
    stubApi([new TypeError('Network request failed')]);
    draw();
    await openBell();
    await waitFor(() => expect(screen.getByTestId('bell-offline')).toBeTruthy());
    expect(screen.queryByTestId('bell-empty')).toBeNull();
  });

  it('loading draws skeleton rows, never a zero figure', async () => {
    vi.stubGlobal('fetch', () => new Promise(() => undefined));
    draw();
    await openBell();
    expect(screen.getByTestId('bell-skeleton').textContent).not.toContain('0.000');
  });
});

describe('an unknown kind does not crash the bell', () => {
  it('is drawn as the neutral row beside the known ones', async () => {
    stubApi([feed([{ id: 'LE-1', kind: 'tier_climb', createdAt: AT, readAt: null, tier: 'gold' }, topup('TX-1')])]);
    draw();
    await openBell();
    await waitFor(() => expect(screen.getByTestId('bell-row-LE-1')).toBeTruthy());
    expect(screen.getByTestId('bell-title-LE-1').textContent).toBe(en.bellUnknownTitle);
    expect(screen.getByTestId('bell-row-TX-1')).toBeTruthy();
  });
});

// ------------------------------------------------------------ visibleKinds --

describe('offers switched off → the bell says so and points at the EXISTING settings', () => {
  it('campaign missing from visibleKinds shows the note, and its control opens settings', async () => {
    stubApi([feed([topup('TX-1')], { visibleKinds: ['topup', 'charge', 'shop', 'deposit_hold', 'deposit_return'] })]);
    const onOpenSettings = vi.fn();
    draw('en', onOpenSettings);
    await openBell();
    await waitFor(() => expect(screen.getByTestId('bell-offers-off')).toBeTruthy());
    expect(screen.getByTestId('bell-offers-off').textContent).toContain(en.bellOffersOff);
    fireEvent.click(screen.getByTestId('bell-open-settings'));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it('the note is owed on the EMPTY bell too — "all caught up" is narrower then', async () => {
    stubApi([feed([], { visibleKinds: ['topup'] })]);
    draw();
    await openBell();
    await waitFor(() => expect(screen.getByTestId('bell-empty')).toBeTruthy());
    expect(screen.getByTestId('bell-offers-off')).toBeTruthy();
  });

  it('with campaigns visible there is no note', async () => {
    stubApi([feed([topup('TX-1')])]);
    draw();
    await openBell();
    await waitFor(() => expect(screen.getByTestId('bell-row-TX-1')).toBeTruthy());
    expect(screen.queryByTestId('bell-offers-off')).toBeNull();
  });
});

// --------------------------------------------------------------------- RTL --

describe('the bell in Arabic — non-negotiable #12', () => {
  it('the document is right-to-left, the control and badge speak Arabic with Eastern digits', async () => {
    stubApi([feed([topup('TX-1'), topup('TX-2'), topup('TX-3')])]);
    draw('ar');
    await waitFor(() => expect(screen.getByTestId('bell-badge').textContent).toBe('٣'));
    expect(document.documentElement.dir).toBe('rtl');
    expect(screen.getByTestId('bell-open').getAttribute('aria-label')).toBe(ar.bellAria(3));
  });

  it('rows render the Arabic copy, and money stays Western', async () => {
    stubApi([feed([topup('TX-1')])]);
    draw('ar');
    await openBell();
    await waitFor(() => expect(screen.getByTestId('bell-row-TX-1')).toBeTruthy());
    expect(screen.getByTestId('bell-title-TX-1').textContent).toBe('شحن · كي نت');
    expect(screen.getByTestId('bell-amount-TX-1').textContent).toBe('+11.000');
  });

  /**
   * SOURCE ASSERTIONS, LABELLED AS SUCH. jsdom does not lay out, so where the
   * badge lands cannot be measured here. What can be pinned is the mechanism
   * that makes it mirror: a LOGICAL inset (`end`), never a physical one, and a
   * bell mounted inside Home's `row` header — logical on both targets
   * (i18n/rtl.ts) — rather than positioned by hand.
   */
  it('the badge is pinned by the logical `end`, never `right`/`left`', () => {
    const src = fs.readFileSync(path.join(__dirname, 'BellButton.tsx'), 'utf8');
    const badge = src.slice(src.indexOf('  badge: {'), src.indexOf('  badgeText'));
    expect(badge).toMatch(/\bend: -?\d+/);
    expect(badge).not.toMatch(/\b(right|left):/);
  });

  it('Home mounts the bell in the header control row, between the switch and the avatar', () => {
    const home = fs.readFileSync(path.join(__dirname, '..', 'screens', 'HomeScreen.tsx'), 'utf8');
    const controls = home.slice(home.indexOf('<View style={styles.headerControls}>'));
    const toggle = controls.indexOf('<LanguageToggle />');
    const bell = controls.indexOf('<BellButton');
    const avatar = controls.indexOf('<AccountButton');
    expect(toggle).toBeGreaterThanOrEqual(0);
    expect(bell).toBeGreaterThan(toggle);
    expect(avatar).toBeGreaterThan(bell);
    expect(home).toMatch(/headerControls: \{ flexDirection: 'row'/);
  });
});
