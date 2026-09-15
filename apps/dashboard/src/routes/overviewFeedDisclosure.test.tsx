// @vitest-environment jsdom

/**
 * The Overview's Recent activity panel draws five lines, then asks.
 *
 * Aftab, item 1: "activity is huge (put a show more button)". Three things
 * already said five — `AVO Merchant Dashboard.dc.html:153`'s
 * `hint-placeholder-count="5"`, the panel's own loading skeleton, and
 * `api/src/routes/activity.ts`'s header, which lists the five lines by name —
 * and the panel drew twenty, because `FEED_DEFAULT_LIMIT` is 20 and
 * `useRecentActivity` sends no `limit`. Twenty rows in a card beside the KPI
 * tiles is the complaint.
 *
 * WHAT ONLY A RENDER CAN PROVE, and why this file is not a source scan like
 * `stateCensus.test.ts`. Two of the three properties below are about a control
 * that must be ABSENT, and absence is exactly what a scan for an identifier
 * cannot distinguish from presence-behind-a-wrong-condition:
 *
 *   1. AT EXACTLY FIVE ROWS, NOTHING DRAWS. A control that reveals nothing
 *      reads as broken, and `hidden > 0` is the single expression that decides
 *      it. An off-by-one here is invisible on any salon that has had a busy
 *      morning — which is every salon anyone would demo.
 *   2. THE CONTROL IS ON THE SUCCESS PATH ONLY. The four states in this panel
 *      are carefully built and a disclosure under a refusal would show a staff
 *      member a button offering to reveal more of what she has just been told
 *      she may not see. The 403-with-rows-in-hand case is the one that can
 *      actually happen, because `keepStale` holds rows through an error.
 *   3. THE BUTTON SAYS WHAT IT WILL DO, TO A READER WHO CANNOT SEE THE LIST.
 *      "Show 15 more" is fifteen more of nothing, out of context.
 *
 * THE PURE RULE IS ASSERTED SEPARATELY FROM THE RENDER, deliberately: the
 * boundary cases are cheapest to state as arithmetic, and the render then has to
 * prove only that the JSX is wired to that arithmetic rather than to a second
 * copy of it.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError } from '../api/client.js';
import type { ActivityItem } from '../api/salon.js';
import { ActivityList, FEED_VISIBLE, discloseFeed } from './Overview.js';

/*
 * NOT AUTOMATIC — this project does not run vitest with `globals`, so
 * `@testing-library/react` never registers its own `afterEach(cleanup)`. Without
 * it every `render()` accumulates in one document and the first query matching
 * two nodes fails with "Found multiple elements", pointing at the component
 * instead of at the leftovers. `shopRender.test.tsx` carries the same line.
 */
afterEach(cleanup);

/**
 * `n` feed lines, newest first, in the shape `GET /salons/{id}/activity` sends.
 * The sentence is composed server-side, so `what` is prose here exactly as it is
 * on the wire — a client that started switching on `kind` would be the defect
 * `api/salon.ts § ActivityItem` argues against.
 */
function feed(n: number): ActivityItem[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `TXN-${String(i).padStart(2, '0')}`,
    stream: 'transaction' as const,
    at: new Date(Date.UTC(2026, 8, 15, 9, 0) - i * 60_000).toISOString(),
    who: `Member ${i}`,
    memberId: `MEM-${i}`,
    salonId: 'SAL-AMARA',
    what: `topped up ${i}.000 via KNET`,
    kind: 'topup',
    amountFils: i * 1000,
  }));
}

function renderList(props: Partial<Parameters<typeof ActivityList>[0]> = {}) {
  return render(
    <ActivityList
      items={feed(20)}
      loading={false}
      error={null}
      onRetry={() => {}}
      retrying={false}
      {...props}
    />,
  );
}

const rows = () => screen.queryAllByRole('listitem');
/*
 * FOUND BY WHAT IS PAINTED, NOT BY THE LABEL UNDER TEST. `/^Show \d+ more/`
 * matches the accessible name whether it comes from the aria-label or falls back
 * to the button's own text, so a missing label fails the assertion that is about
 * the label rather than quietly making the button unfindable and failing five
 * unrelated things. The error states render a Retry button, which is why this is
 * not a bare `queryByRole('button')`.
 */
const control = () => screen.queryByRole('button', { name: /^Show \d+ more/ });

describe('discloseFeed — how many lines she sees before she asks', () => {
  it('agrees with the design placeholder and with the skeleton', () => {
    // design/AVO Merchant Dashboard.dc.html:153 — hint-placeholder-count="5".
    expect(FEED_VISIBLE).toBe(5);
  });

  it('shows five of the twenty the endpoint sends, and counts the rest', () => {
    const d = discloseFeed(feed(20), false);
    expect(d.visible).toHaveLength(5);
    expect(d.hidden).toBe(15);
    // The FIRST five, not any five: the feed is newest first.
    expect(d.visible.map((i) => i.id)).toEqual([
      'TXN-00',
      'TXN-01',
      'TXN-02',
      'TXN-03',
      'TXN-04',
    ]);
  });

  it('hands back everything and asks for nothing once expanded', () => {
    const d = discloseFeed(feed(20), true);
    expect(d.visible).toHaveLength(20);
    expect(d.hidden).toBe(0);
  });
});

/*
 * THE BOUNDARY, BOTH SIDES OF IT. At five there is nothing beneath the fifth
 * line, so a control there would reveal nothing.
 *
 * THESE DO NOT PIN THE GUARD'S COMPARISON, and that is stated rather than
 * assumed: flipping `discloseFeed`'s `<=` to `<` leaves all twenty of these
 * green, because at exactly five the fall-through computes `5 - FEED_VISIBLE`
 * and reaches the same `hidden: 0`. What they pin is the OUTPUT at each length,
 * which is the property the panel actually depends on. `Overview.tsx
 * § discloseFeed` carries the measurement.
 */
describe('discloseFeed — the near-empty cases, where the control must not appear', () => {
  it('draws no control at exactly five', () => {
    const d = discloseFeed(feed(5), false);
    expect(d.visible).toHaveLength(5);
    expect(d.hidden).toBe(0);
  });

  it('draws no control at four', () => {
    const d = discloseFeed(feed(4), false);
    expect(d.visible).toHaveLength(4);
    expect(d.hidden).toBe(0);
  });

  it('draws a control for one row at six', () => {
    const d = discloseFeed(feed(6), false);
    expect(d.visible).toHaveLength(5);
    expect(d.hidden).toBe(1);
  });

  it('counts a twenty-first row if the endpoint ever sends one', () => {
    // `limit` is caller-supplied up to FEED_MAX_LIMIT=100; 20 is only the
    // default. The rule must not hard-code the default it happens to meet.
    const d = discloseFeed(feed(21), false);
    expect(d.hidden).toBe(16);
  });

  it('is quiet on one row and on none', () => {
    expect(discloseFeed(feed(1), false).hidden).toBe(0);
    expect(discloseFeed([], false).hidden).toBe(0);
    expect(discloseFeed([], false).visible).toEqual([]);
  });
});

describe('the panel draws five lines and a control that names the rest', () => {
  it('renders five of twenty', () => {
    renderList();
    expect(rows()).toHaveLength(5);
    // The sixth row is genuinely not on screen, not merely hidden by CSS.
    expect(screen.queryByText(/Member 5/)).toBeNull();
  });

  it('labels the control with the count it is actually holding', () => {
    renderList();
    const button = control();
    expect(button).not.toBeNull();
    // Visible text stays short; the accessible name says what fifteen are.
    expect(button?.textContent).toBe('Show 15 more');
    expect(button?.getAttribute('aria-label')).toBe('Show 15 more activity rows');
  });

  it('says row, not rows, when one line is hidden', () => {
    renderList({ items: feed(6) });
    expect(control()?.getAttribute('aria-label')).toBe('Show 1 more activity row');
    expect(control()?.textContent).toBe('Show 1 more');
  });

  it('reveals the rest in place and withdraws itself', () => {
    renderList();
    fireEvent.click(control() as HTMLElement);
    expect(rows()).toHaveLength(20);
    expect(screen.getByText(/Member 19/)).toBeTruthy();
    // Nothing left to reveal, so nothing left to press.
    expect(control()).toBeNull();
  });

  it('leaves focus on the list it just grew, not on the body', () => {
    renderList();
    fireEvent.click(control() as HTMLElement);
    const list = screen.getByRole('list');
    expect(document.activeElement).toBe(list);
    expect(document.activeElement).not.toBe(document.body);
  });
});

/*
 * THE TRAP THE WALLET'S VERSION HIT FIRST: a control that reveals nothing.
 */
describe('exactly five rows draw no control at all', () => {
  it('draws five lines and nothing under them', () => {
    renderList({ items: feed(5) });
    expect(rows()).toHaveLength(5);
    expect(control()).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('draws four lines and nothing under them', () => {
    renderList({ items: feed(4) });
    expect(rows()).toHaveLength(4);
    expect(screen.queryByRole('button')).toBeNull();
  });
});

/*
 * THE FOUR STATES WERE ALREADY BUILT AND THE CONTROL BELONGS TO NONE OF THEM.
 * Each assertion below is a state this panel had before this slice, re-asserted
 * only in the one respect this slice could break.
 */
describe('the control is on the success path and nowhere else', () => {
  it('is absent while the skeleton is drawing', () => {
    renderList({ items: undefined, loading: true });
    // The skeleton still draws five rows, which is now the count it resolves to.
    expect(rows()).toHaveLength(5);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('is absent on the empty state', () => {
    renderList({ items: [] });
    expect(screen.getByText('Nothing today yet')).toBeTruthy();
    expect(control()).toBeNull();
  });

  it('is absent on a refusal that is holding rows', () => {
    /*
     * The case that can actually happen. `keepStale` excludes a 403, so the
     * panel renders the server's refusal with twenty rows still in the query
     * cache — and a "Show 15 more" beneath "You don't have access to this" would
     * offer to reveal more of what she has just been told she may not see.
     */
    renderList({
      items: feed(20),
      error: new ApiError('That salon is not yours.', { status: 403, code: 'forbidden' }),
    });
    expect(screen.getByText("You don't have access to this")).toBeTruthy();
    expect(rows()).toHaveLength(0);
    expect(control()).toBeNull();
  });

  it('is absent on an offline answer with nothing in hand', () => {
    renderList({
      items: undefined,
      error: new ApiError('offline', { status: 0, code: 'offline', offline: true }),
    });
    expect(screen.getByText('No connection')).toBeTruthy();
    expect(control()).toBeNull();
  });

  it('is PRESENT behind a stale banner, because those rows are in hand', () => {
    /*
     * `keepStale`: a network failure keeps the last-known rows visible
     * (interaction-spec.md §4) and the banner belongs to the whole screen. The
     * button reveals rows already loaded and fetches nothing, so it is still
     * honest here — this is the one error state it shares a screen with.
     */
    renderList({
      items: feed(20),
      error: new ApiError('gateway', { status: 502, code: 'upstream' }),
    });
    expect(rows()).toHaveLength(5);
    expect(control()?.textContent).toBe('Show 15 more');
  });
});
