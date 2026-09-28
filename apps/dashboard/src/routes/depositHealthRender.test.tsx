// @vitest-environment jsdom

/**
 * THE DEPOSIT QUEUE, DRIVEN.
 *
 * `stateCensus.test.ts` proves this view HAS the four-state vocabulary and a
 * pending paint, and `depositHealthRules.test.ts` proves the partition and the
 * copy. Neither can prove what a merchant actually reads, and on this screen six
 * things are not cosmetic:
 *
 *   1. THE THREE STATES ARE THREE SECTIONS WITH THREE FRAMINGS. This distinction
 *      IS the feature. A screen that lumped them into one "problem appointments"
 *      list would tell a merchant her customers are unreliable when in fact AVO's
 *      own return job is stuck — and `return_overdue` in particular must not read
 *      as anything the customer did.
 *
 *   2. `unclosed` SHOWS NO MONEY. `booking_deposit_matches_hold` makes the sum 0
 *      for every row there for ever, so the API declines to serve it. A rendered
 *      `0.000 KD` would be a money figure whose only possible use is to mislead.
 *
 *   3. THE TOTALS ARE THE SERVER'S, NOT A SUM OF THE ROWS IN HAND. The rows are
 *      the OVERDUE subset and are capped at 200; a client that added them up
 *      would report a fraction of the held money as the whole of it, and a guest
 *      row — which carries 0 fils by constraint — would be the thing that made
 *      the two look consistent on a small fixture.
 *
 *   4. A CAPPED LIST DOES NOT REPORT ITSELF AS COMPLETE. `overdue.bookings` is
 *      the authority and `rows` is the evidence, so a merchant can legitimately
 *      see a count larger than her rows. She is told, where she can see both.
 *
 *   5. A MALFORMED BODY IS A FAILED READ. Not a zero, not an empty list. A
 *      deposit screen that rendered `0.000 KD` because it could not read the body
 *      is the exact lie class this lane has spent four slices closing.
 *
 *   6. THE EMPTY STATE IS GOOD NEWS. Nowhere else in this dashboard does an empty
 *      list mean the business is healthy; here it does, and the copy has to say
 *      so rather than report an absence of data.
 *
 * DRIVEN THROUGH THE REAL HOOK AND THE REAL PARSER — `authedRequest` is the only
 * data seam, so every fixture below passes through `parseDepositHealth` and the
 * field names are part of what is under test.
 *
 * THE BRANCH SCOPE IS MOCKED, and that is the one seam that is not the wire. It
 * is the SHELL's state, owned by `BranchScopeProvider`, which reads
 * `GET /salons/{id}` for the branch list — a second endpoint, a full `Salon`
 * fixture, and a provider this view does not own. `shell/branchScope.test.tsx`
 * already drives the selector itself; what this file needs from it is the
 * selected value, and what it asserts is the URL that leaves as a result.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client.js';
import { DEPOSIT_FRAMING } from './depositHealthRules.js';

const authedRequest = vi.fn();
vi.mock('../auth/authedRequest.js', () => ({
  authedRequest: (...args: unknown[]) => authedRequest(...args),
}));

/** The salon comes from the session, and there is no session in a jsdom realm. */
vi.mock('../auth/AuthProvider.js', () => ({ useSalonId: () => 'SAL-AMARA' }));

let branch = 'all';
vi.mock('../shell/BranchScope.js', () => ({
  ALL_BRANCHES: 'all',
  useBranchScope: () => ({
    selected: branch,
    select: () => {},
    branches: [],
    status: 'ready' as const,
    selectedName: null,
  }),
}));

const { DepositHealth } = await import('./DepositHealth.js');

/*
 * NOT AUTOMATIC — this project does not run vitest with `globals`, so
 * `@testing-library/react` never registers its own `afterEach(cleanup)`.
 */
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  branch = 'all';
  authedRequest.mockReset();
});

/* ================================================================= fixtures */

/**
 * ONE ROW, WHOLE. Every key `services/depositHealth.ts § DepositRow` documents,
 * because a partial fixture would let the parser be exercised against a record
 * the wire never sends — and this file's whole method is that the fixtures go
 * through the real parser.
 */
function row(over: Record<string, unknown>): Record<string, unknown> {
  return {
    bookingId: 'BK-0000',
    state: 'awaiting_arrival',
    memberId: 'MB-1a2b3c4d5e',
    memberName: 'Latifa A.',
    memberErased: false,
    memberPhone: '+96599124408',
    guestName: null,
    guestPhone: null,
    artistId: 'AR-01',
    artistName: 'Dana',
    serviceName: 'Balayage',
    branchId: 'BR-SAL',
    branchName: 'Salmiya',
    branchAssumed: false,
    startsAt: '2026-09-27T05:00:00.000Z',
    endsAt: '2026-09-27T06:30:00.000Z',
    durationMin: 90,
    depositFils: 18000,
    noShowReturnDueAt: '2026-09-27T07:30:00.000Z',
    source: 'customer',
    overdueMinutes: 40,
    returnOverdueMinutes: null,
    ...over,
  };
}

/** A walk-in: no member, no account, and ZERO FILS BY CONSTRAINT. */
const MAHA = row({
  bookingId: 'BK-MAHA',
  state: 'unclosed',
  memberId: null,
  memberName: null,
  memberPhone: null,
  guestName: 'Maha (walk-in)',
  guestPhone: '+96566001122',
  depositFils: 0,
  startsAt: '2026-09-25T08:00:00.000Z',
  noShowReturnDueAt: '2026-09-25T10:00:00.000Z',
  source: 'merchant',
  overdueMinutes: 2940,
});

/**
 * A LONG SERVICE, BOOKED EARLY. `no_show_return_due_at` is `ends_at` plus the
 * salon's window, so a six-hour keratin starting at 09:30 is due back LATER than
 * a half-hour manicure starting at 14:00 — which means the "Owed for" figure
 * DOES NOT DESCEND down the queue even though `starts_at` ascends.
 *
 * THAT IS DELIBERATE AND THIS SPEC EARNED IT. The first fixture gave every row a
 * `returnOverdueMinutes` that happened to fall in served order, so a
 * `sort((a, b) => b.returnOverdueMinutes - a.returnOverdueMinutes)` spliced into
 * the grouping was a no-op and the order assertion passed with the ranking in
 * place. Found by mutation. Now a sort on the displayed figure — the single most
 * plausible "helpful" re-rank, since it is the column a merchant reads —
 * reorders these two and fails.
 */
const NOURA = row({
  bookingId: 'BK-NOURA',
  state: 'return_overdue',
  memberId: 'MB-noura00001',
  memberName: 'Noura S.',
  memberPhone: '+96599887766',
  serviceName: 'Keratin treatment',
  depositFils: 25000,
  startsAt: '2026-09-26T09:30:00.000Z',
  endsAt: '2026-09-26T15:30:00.000Z',
  durationMin: 360,
  noShowReturnDueAt: '2026-09-26T18:00:00.000Z',
  overdueMinutes: 1210,
  returnOverdueMinutes: 700,
});

/** Erased, and still on the queue — her deposit is still owed back to her wallet. */
const GONE = row({
  bookingId: 'BK-GONE',
  state: 'return_overdue',
  memberId: 'MB-9f8e7d6c5b',
  memberName: 'Deleted account',
  memberErased: true,
  memberPhone: null,
  serviceName: 'Gel manicure',
  depositFils: 22500,
  startsAt: '2026-09-26T14:00:00.000Z',
  endsAt: '2026-09-26T14:30:00.000Z',
  durationMin: 30,
  noShowReturnDueAt: '2026-09-26T16:30:00.000Z',
  overdueMinutes: 940,
  /* Later slot, EARLIER deadline, therefore owed LONGER. See the note above. */
  returnOverdueMinutes: 790,
});

/** A walk-in inside the grace window: she is on a section that HAS a money column. */
const SARA = row({
  bookingId: 'BK-SARA',
  state: 'awaiting_arrival',
  memberId: null,
  memberName: null,
  memberPhone: null,
  guestName: 'Sara (walk-in)',
  guestPhone: null,
  serviceName: 'Blow-dry',
  depositFils: 0,
  startsAt: '2026-09-27T04:45:00.000Z',
  source: 'merchant',
  overdueMinutes: 55,
  branchAssumed: true,
});

const LATIFA = row({ bookingId: 'BK-LATIFA', state: 'awaiting_arrival' });

/**
 * THE MAIN FIXTURE, AND IT IS INTERNALLY CONSISTENT ON PURPOSE.
 *
 *   held      12 bookings / 186.500  =  scheduled 7 / 121.000  +  overdue 5 / 65.500
 *   overdue    5 bookings /  65.500  =  awaiting 2 / 18.000
 *                                     + returnOverdue 2 / 47.500
 *                                     + unclosed 1 / (no money, ever)
 *
 * The sum of the FIVE ROWS' deposits is 65.500 — the OVERDUE total, not the held
 * one. That is what makes the totals assertion below bite: a component that added
 * up the rows in hand would print 65.500 under "Held right now" and be off by
 * 121.000, and the number it printed would still look plausible.
 *
 * `rows` arrive `starts_at ASC` — Maha, Noura, Gone, Sara, Latifa — which
 * INTERLEAVES the three states, so the served order is not accidentally the
 * grouped order.
 */
const HEALTH = {
  asOf: '2026-09-27T05:40:00.000Z',
  held: { bookings: 12, fils: 186500, branchAssumed: null },
  scheduled: { bookings: 7, fils: 121000 },
  overdue: {
    bookings: 5,
    fils: 65500,
    oldestStartedAt: '2026-09-25T08:00:00.000Z',
    branchAssumed: null,
    awaitingArrival: { bookings: 2, fils: 18000 },
    returnOverdue: { bookings: 2, fils: 47500, dueSince: '2026-09-26T12:00:00.000Z' },
    unclosed: { bookings: 1, oldestStartedAt: '2026-09-25T08:00:00.000Z' },
  },
  rows: [MAHA, NOURA, GONE, SARA, LATIFA],
  rowsTruncated: false,
  branchId: null,
  branchName: null,
};

function serve(answer: unknown | Error) {
  authedRequest.mockImplementation(() =>
    answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer),
  );
}

function rig() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return render(<DepositHealth timezone="Asia/Kuwait" />, { wrapper: Wrapper });
}

/** The section element for one state — `data-state` is on the element for this. */
function section(state: keyof typeof DEPOSIT_FRAMING): HTMLElement {
  const el = document.querySelector(`[data-state="${state}"]`);
  if (!el) throw new Error(`no section rendered for ${state}`);
  return el as HTMLElement;
}

/** Every money figure on screen, as the display boundary formats them. */
function moneyOn(el: HTMLElement): string[] {
  return (el.textContent ?? '').match(/\d+\.\d{3}/g) ?? [];
}

/* ===================================================== the three framings == */

describe('the three states are three sections, each with its own sentence', () => {
  it('draws all three, each under its own heading and its own framing', async () => {
    serve(HEALTH);
    rig();

    await screen.findByText(DEPOSIT_FRAMING.return_overdue.title);

    for (const state of ['return_overdue', 'awaiting_arrival', 'unclosed'] as const) {
      const el = section(state);
      const framing = DEPOSIT_FRAMING[state];
      expect(within(el).getByText(framing.title), `${state} has no heading`).toBeTruthy();
      expect(within(el).getByText(framing.body), `${state} has no framing sentence`).toBeTruthy();
    }
  });

  /**
   * NOT ONE LIST. The rows of one state never appear inside another's section,
   * which is the structural half of the guarantee — the framings could all be
   * present and still sit above a single undifferentiated table.
   */
  it('puts each row under the section that frames it, and under no other', () => {
    serve(HEALTH);
    rig();

    return screen.findByText('Noura S.').then(() => {
      const ours = section('return_overdue');
      const waiting = section('awaiting_arrival');
      const book = section('unclosed');

      expect(within(ours).getByText('Noura S.')).toBeTruthy();
      expect(within(ours).getByText('Deleted account')).toBeTruthy();
      expect(within(ours).queryByText('Latifa A.')).toBeNull();
      expect(within(ours).queryByText('Maha (walk-in)')).toBeNull();

      expect(within(waiting).getByText('Latifa A.')).toBeTruthy();
      expect(within(waiting).getByText('Sara (walk-in)')).toBeTruthy();
      expect(within(waiting).queryByText('Noura S.')).toBeNull();

      expect(within(book).getByText('Maha (walk-in)')).toBeTruthy();
      expect(within(book).queryByText('Noura S.')).toBeNull();
    });
  });

  /**
   * ===========================================================================
   * `return_overdue` CONTAINS NOTHING BLAMING THE CUSTOMER — IN THE PAINT
   * ===========================================================================
   * `depositHealthRules.test.ts` scans the COPY. This scans the rendered section
   * including every row inside it, which is where the blame would actually get
   * in: a "Missed" pill, a "no-show" label on the state, a warning glyph beside
   * her name. Two named women are in this section, one of them erased, and the
   * only claims made about either are a service, a slot and a duration.
   */
  it('says nothing about the customer in the section that is ours', async () => {
    serve(HEALTH);
    rig();
    await screen.findByText('Noura S.');

    const text = (section('return_overdue').textContent ?? '').toLowerCase();
    for (const word of [
      'no-show',
      'no show',
      'did not come',
      "didn't come",
      'did not turn up',
      'missed',
      'failed to',
      'unreliable',
      'repeatedly',
      'at risk',
      'problem',
    ]) {
      expect(text, `the return_overdue section renders "${word}"`).not.toContain(word);
    }

    // And it does say whose job it is.
    expect(text).toContain('runs on our side, not hers');
    expect(text).toContain('nothing for you to do here');
  });

  /**
   * THE ELAPSED COLUMN IS HEADED DIFFERENTLY PER STATE, which is the smallest
   * place the distinction could quietly collapse: one shared "Overdue by" over
   * all three would describe AVO's backlog and a salon's book-keeping in the
   * vocabulary of a late customer.
   */
  it('heads the elapsed column with the state’s own words', () => {
    serve(HEALTH);
    rig();

    return screen.findByText('Noura S.').then(() => {
      expect(within(section('return_overdue')).getByText('Owed for')).toBeTruthy();
      expect(within(section('awaiting_arrival')).getByText('Since slot')).toBeTruthy();
      expect(within(section('unclosed')).getByText('Past due by')).toBeTruthy();
    });
  });

  it('renders the elapsed figure the state’s own field supplies', async () => {
    serve(HEALTH);
    rig();
    await screen.findByText('Noura S.');

    // `returnOverdueMinutes` (700 = 11h 40m), NOT `overdueMinutes` (1210 = 20h 10m).
    expect(within(section('return_overdue')).getByText('11h 40m')).toBeTruthy();
    expect(within(section('return_overdue')).queryByText('20h 10m')).toBeNull();
    expect(within(section('return_overdue')).getByText('13h 10m')).toBeTruthy();
    // …and the other two states have no `returnOverdueMinutes`, so they use theirs.
    expect(within(section('awaiting_arrival')).getByText('40m')).toBeTruthy();
    expect(within(section('unclosed')).getByText('2d 1h')).toBeTruthy();
  });
});

/* ================================================== unclosed carries no money */

describe('the unclosed section renders no money figure at all', () => {
  /**
   * NOT A ZERO, NOT A DASH, NOT A COLUMN. `booking_deposit_matches_hold` makes
   * "no hold" and "zero deposit" the same fact, so every figure in that column
   * would be `0.000 KD` for ever — and the API declines to serve the sum for
   * exactly that reason. A column of dashes would be worse than none: it invites
   * the next person to "fix" it by summing the rows.
   */
  it('has no Deposit column and no KD figure anywhere in it', async () => {
    serve(HEALTH);
    rig();
    await screen.findByText('Maha (walk-in)');

    const book = section('unclosed');
    expect(within(book).queryByText('Deposit')).toBeNull();
    expect(moneyOn(book), 'a money figure reached the unclosed section').toEqual([]);
    expect(book.textContent).not.toContain('0.000');
    expect(book.textContent).not.toContain('KD');
  });

  /** The other two sections DO carry the column — the absence above is specific. */
  it('keeps the Deposit column on the two states that have money behind them', async () => {
    serve(HEALTH);
    rig();
    await screen.findByText('Noura S.');

    expect(within(section('return_overdue')).getByText('Deposit')).toBeTruthy();
    expect(within(section('awaiting_arrival')).getByText('Deposit')).toBeTruthy();
    expect(moneyOn(section('return_overdue'))).toEqual(['25.000', '22.500']);
  });
});

/* ============================================ the totals are the server's === */

describe('a guest contributes zero and the totals are the server’s', () => {
  /**
   * ===========================================================================
   * THE TILE IS `held.fils`, NOT A SUM OF THE ROWS IN HAND
   * ===========================================================================
   * The rows are the OVERDUE subset and are capped at 200. Their deposits add up
   * to 65.500 — the overdue total. A component that summed them would print
   * 65.500 under "Held right now", which is off by 121.000 and still looks like a
   * number. This is the assertion that tells the two implementations apart.
   */
  it('reads Held right now off the server’s figure and not off the rows', async () => {
    serve(HEALTH);
    rig();
    await screen.findByText('Noura S.');

    const tiles = document.querySelector('.deposits__tiles') as HTMLElement;
    expect(within(tiles).getByText('186.500')).toBeTruthy();
    expect(within(tiles).getByText('121.000')).toBeTruthy();
    expect(within(tiles).getByText('65.500')).toBeTruthy();
    expect(within(tiles).getByText('12 bookings')).toBeTruthy();
    expect(within(tiles).getByText('7 bookings')).toBeTruthy();
    expect(within(tiles).getByText('5 bookings')).toBeTruthy();
  });

  /**
   * SHE IS ON THE BOARD AND SHE MOVES NOTHING. `booking_merchant_is_zero_deposit`
   * forbids a merchant-written row from carrying money at all — because #2 says a
   * merchant who can debit a wallet by filling in a form can do it without the
   * customer — so a walk-in appears in the counts and in the rows (the front desk
   * needs to see the chair is still open) and cannot move the held total by a
   * single fils.
   *
   * ASSERTED BY DIFFERENCE, which is the only version of this that is not
   * circular: the same totals with and without her row, and the tile identical.
   */
  it('renders a walk-in by name, with 0.000 beside her and the totals untouched', async () => {
    serve(HEALTH);
    const withGuest = rig();
    await screen.findByText('Sara (walk-in)');

    const waiting = section('awaiting_arrival');
    expect(within(waiting).getByText('Sara (walk-in)')).toBeTruthy();
    expect(within(waiting).getByText('Walk-in')).toBeTruthy();
    // Her deposit IS drawn, and it is zero — unlike the unclosed SUM, this is a
    // real booking's real figure.
    expect(moneyOn(waiting)).toEqual(['0.000', '18.000']);
    const held = (document.querySelector('.deposits__tiles') as HTMLElement).textContent;

    withGuest.unmount();
    cleanup();

    /* The SAME totals, her row removed. Nothing about the money may move. */
    serve({
      ...HEALTH,
      overdue: {
        ...HEALTH.overdue,
        bookings: 4,
        awaitingArrival: { bookings: 1, fils: 18000 },
      },
      rows: [MAHA, NOURA, GONE, LATIFA],
    });
    rig();
    await screen.findByText('Latifa A.');

    expect(screen.queryByText('Sara (walk-in)')).toBeNull();
    const after = (document.querySelector('.deposits__tiles') as HTMLElement).textContent ?? '';
    expect(after).toContain('186.500');
    expect(after).toContain('121.000');
    expect(held).toContain('186.500');
  });
});

/* ================================================== the served order stands = */

describe('the rows stay in the order the server sent them', () => {
  /**
   * `starts_at ASC` IS A QUEUE — the oldest thing that never resolved is the
   * thing to deal with first — and the endpoint takes no `?sort=`. The fixture
   * interleaves the three states, so a group that came out in the served order
   * did so because `filter` is stable and not because the input was already
   * sorted that way.
   */
  it('renders each section’s rows oldest slot first', async () => {
    serve(HEALTH);
    rig();
    await screen.findByText('Noura S.');

    const names = (el: HTMLElement) =>
      [...el.querySelectorAll('.deposits__customer')].map((n) => n.textContent);

    expect(names(section('return_overdue'))).toEqual(['Noura S.', 'Deleted account']);
    expect(names(section('awaiting_arrival'))).toEqual(['Sara (walk-in)', 'Latifa A.']);
    expect(names(section('unclosed'))).toEqual(['Maha (walk-in)']);
  });

  /**
   * NO CONTROL EXISTS THAT COULD REORDER THEM.
   *
   * The constraint is not "nothing sorts today" but "nothing can be made to" —
   * a sortable column head is one `onClick` away from a leaderboard of women
   * ranked by how much they owe. So: this whole view renders NO interactive
   * element at all on the happy path. It reads and it does not write; every
   * control that acts on a booking lives on the List, behind `perms.void` and a
   * confirmation.
   */
  it('offers no control of any kind — nothing to sort, nothing to click', async () => {
    serve(HEALTH);
    const { container } = rig();
    await screen.findByText('Noura S.');

    const view = container.querySelector('.deposits') as HTMLElement;
    expect(view.querySelectorAll('button')).toHaveLength(0);
    expect(view.querySelectorAll('select')).toHaveLength(0);
    expect(view.querySelectorAll('a')).toHaveLength(0);
    expect(view.querySelectorAll('[role="radiogroup"]')).toHaveLength(0);
    // A column head is a <th> and never a control.
    for (const th of view.querySelectorAll('th')) {
      expect(th.querySelector('button, [role="button"], [tabindex]')).toBeNull();
    }
  });
});

/* ============================================================ the cap ====== */

describe('a capped list does not report itself as complete', () => {
  /**
   * `overdue.bookings` IS THE AUTHORITY AND `rows` IS THE EVIDENCE. With the cap
   * reached, a merchant sees a count larger than her rows — and she is told, in
   * the same block as both figures, rather than being left to conclude the count
   * is wrong.
   *
   * THE AWAITING SECTION HAS A COUNT AND NO ROWS AT ALL, which is not a contrived
   * case: the cap takes the 200 OLDEST, and `awaiting_arrival` rows are by
   * definition the most recent, so they are the first to be cut. A client keyed
   * on `rows.length` would delete that section from the screen while the tile
   * above it still counted its 30 bookings.
   */
  const TRUNCATED = {
    ...HEALTH,
    held: { bookings: 260, fils: 3_120_000, branchAssumed: null },
    scheduled: { bookings: 20, fils: 300_000 },
    overdue: {
      ...HEALTH.overdue,
      bookings: 240,
      fils: 2_820_000,
      awaitingArrival: { bookings: 30, fils: 402_000 },
      returnOverdue: { bookings: 200, fils: 2_418_000, dueSince: '2026-09-01T08:00:00.000Z' },
      unclosed: { bookings: 10, oldestStartedAt: '2026-09-01T08:00:00.000Z' },
    },
    rows: [MAHA, NOURA, GONE],
    rowsTruncated: true,
  };

  it('states the discrepancy beside the count it qualifies', async () => {
    serve(TRUNCATED);
    rig();
    await screen.findByText('Noura S.');

    const ours = section('return_overdue');
    // The authority, in the heading.
    expect(within(ours).getByText('200 bookings')).toBeTruthy();
    // …and the evidence, named as partial, in the same block.
    expect(ours.textContent).toContain('Showing 2 of 200');
    expect(ours.textContent).toContain('capped at the 200 oldest');
    expect(ours.textContent).toContain('the count beside the heading is exact');
  });

  it('keeps a section whose rows were all cut, and says so', async () => {
    serve(TRUNCATED);
    rig();
    await screen.findByText('Noura S.');

    const waiting = section('awaiting_arrival');
    expect(within(waiting).getByText('30 bookings')).toBeTruthy();
    expect(waiting.textContent).toContain('All 30 of these are past the 200-row cap');
    // No table, because there is genuinely nothing to put in one…
    expect(waiting.querySelector('table')).toBeNull();
    // …and the framing still stands, because the state is still real.
    expect(within(waiting).getByText(DEPOSIT_FRAMING.awaiting_arrival.body)).toBeTruthy();
  });

  /**
   * THE NOTICE IS ABOUT THE CAP AND NOT ABOUT THE RESPONSE. A section that lost
   * no rows says nothing, even on a truncated response — a caveat on the wrong
   * figure is noise that teaches a merchant to ignore the next one.
   */
  it('says nothing on a section the cap did not shorten', async () => {
    serve({ ...TRUNCATED, overdue: { ...TRUNCATED.overdue, unclosed: { bookings: 1, oldestStartedAt: '2026-09-01T08:00:00.000Z' } } });
    rig();
    await screen.findByText('Maha (walk-in)');

    const book = section('unclosed');
    expect(book.textContent).not.toContain('Showing');
    expect(book.textContent).not.toContain('capped');
  });

  it('says nothing anywhere when the response was not truncated', async () => {
    serve(HEALTH);
    const { container } = rig();
    await screen.findByText('Noura S.');
    expect(container.textContent).not.toContain('capped');
  });
});

/* ================================================ a body that cannot be read */

describe('a malformed body is a failed read, not a zero and not an empty list', () => {
  /**
   * ===========================================================================
   * THE LIE CLASS THIS LANE HAS BEEN CLOSING ALL WEEK, ON THE WORST SURFACE FOR IT
   * ===========================================================================
   * A tolerant parse that coerced a missing `held.fils` to zero would paint
   * `0.000 KD` under "Held right now" on a salon holding 186 dinars of its
   * customers' money — and the screen would look completely normal. So the parse
   * throws, TanStack turns that into `isError`, and `SectionError` renders the
   * "we failed" arm WITH a retry, because an unreadable body may well be
   * transient.
   *
   * ASSERTED IN BOTH DIRECTIONS: the failure is announced, AND no figure and no
   * empty-state sentence is drawn beside it.
   */
  /**
   * THE COUNT CASES ARE HERE BECAUSE THEY WERE MISSING AND THE GAP WAS REAL.
   *
   * The first version of this table attacked only money keys, the rows array and
   * the state — so loosening `count()` to `… ? v : 0` survived every case, and a
   * salon holding 186 dinars would have been reported as "no bookings" beside a
   * correct money figure. Two figures disagreeing on one tile, which is exactly
   * what the API's single-query aggregate exists to make unrepresentable.
   *
   * A COUNT IS NOT MONEY AND IT IS STILL NOT GUESSABLE. `2.5 bookings` is a
   * broken server, not a rounding, and a negative count is not a smaller one.
   */
  it.each([
    ['a missing money key', { ...HEALTH, held: { bookings: 12, branchAssumed: null } }],
    ['a money key as a string', { ...HEALTH, held: { ...HEALTH.held, fils: '186500' } }],
    ['a float where fils belong', { ...HEALTH, held: { ...HEALTH.held, fils: 186500.5 } }],
    ['a missing count', { ...HEALTH, held: { fils: 186500, branchAssumed: null } }],
    ['a count as a string', { ...HEALTH, held: { ...HEALTH.held, bookings: '12' } }],
    ['a fractional count', { ...HEALTH, held: { ...HEALTH.held, bookings: 12.5 } }],
    ['a negative count', { ...HEALTH, held: { ...HEALTH.held, bookings: -1 } }],
    [
      'a missing count on a nested bucket',
      {
        ...HEALTH,
        overdue: { ...HEALTH.overdue, unclosed: { oldestStartedAt: null } },
      },
    ],
    [
      'a missing count on the authority figure',
      { ...HEALTH, overdue: { ...HEALTH.overdue, bookings: undefined } },
    ],
    ['a missing truncation flag', { ...HEALTH, rowsTruncated: undefined }],
    ['a missing asOf', { ...HEALTH, asOf: undefined }],
    ['a row missing its money', { ...HEALTH, rows: [row({ depositFils: undefined })] }],
    ['a row with a float elapsed', { ...HEALTH, rows: [row({ overdueMinutes: 40.5 })] }],
    ['a missing rows array', { ...HEALTH, rows: undefined }],
    ['a row in an unknown state', { ...HEALTH, rows: [row({ state: 'probably_fine' })] }],
    ['a row that is not an object', { ...HEALTH, rows: ['BK-0001'] }],
    ['a missing overdue block', { ...HEALTH, overdue: null }],
    ['a block that is a number', { ...HEALTH, held: 186500 }],
    ['an array where the body belongs', []],
    ['a string where the body belongs', 'ok'],
    ['null where the body belongs', null],
  ])('refuses to render on %s', async (_label, body) => {
    serve(body);
    const { container } = rig();

    expect(await screen.findByText("Couldn't load deposit health")).toBeTruthy();

    // NOT a zero. No money figure of any kind reached the screen.
    expect(moneyOn(container as unknown as HTMLElement)).toEqual([]);
    // NOT an empty list either — neither empty-state sentence is drawn.
    expect(screen.queryByText('No deposits on hold')).toBeNull();
    expect(
      screen.queryByText(/Nothing overdue — every held deposit is for a slot still to come/),
    ).toBeNull();
    // And it IS offered as recoverable, because an unreadable body may be transient.
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  /**
   * A 403 IS NOT AN ERROR AND GETS NO RETRY. The server's own sentence, verbatim
   * — it names the permission and who can grant it, which a paraphrase would
   * drop. `perms.appointments`, and a merchant who lost it mid-session is exactly
   * who lands here.
   */
  it('explains a refusal in the server’s words and offers no retry', async () => {
    serve(
      new ApiError('You need Appointments access. Ask an owner or a manager.', {
        status: 403,
        code: 'forbidden',
      }),
    );
    rig();

    expect(
      await screen.findByText('You need Appointments access. Ask an owner or a manager.'),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  /** Offline is told apart from a server failure, and nothing is blanked to zero. */
  it('tells offline apart from a failure on our side', async () => {
    serve(new ApiError('Network request failed', { status: 0, code: 'network_error' }));
    const { container } = rig();

    expect(await screen.findByText('No connection')).toBeTruthy();
    expect(moneyOn(container as unknown as HTMLElement)).toEqual([]);
  });
});

/* ================================================== the empty is good news == */

describe('an empty deposit queue reads as a healthy salon', () => {
  /**
   * ===========================================================================
   * THE ONE EMPTY IN THIS DASHBOARD THAT IS GOOD NEWS
   * ===========================================================================
   * "No appointments this week" is a salon with nothing booked. "No customers
   * yet" is a salon with no customers. An empty deposit queue is the opposite:
   * every deposit resolved, nobody waiting on a return, nothing left open. The
   * copy has to say that, and the TILES have to stay populated — an empty state
   * over three skeletons or three zeroes would read as missing data however the
   * sentence was worded.
   */
  const CLEAR = {
    ...HEALTH,
    held: { bookings: 6, fils: 98_000, branchAssumed: null },
    scheduled: { bookings: 6, fils: 98_000 },
    overdue: {
      bookings: 0,
      fils: 0,
      oldestStartedAt: null,
      branchAssumed: null,
      awaitingArrival: { bookings: 0, fils: 0 },
      returnOverdue: { bookings: 0, fils: 0, dueSince: null },
      unclosed: { bookings: 0, oldestStartedAt: null },
    },
    rows: [],
    rowsTruncated: false,
  };

  it('names the good outcome rather than reporting an absence', async () => {
    serve(CLEAR);
    const { container } = rig();

    expect(
      await screen.findByText('Nothing overdue — every held deposit is for a slot still to come'),
    ).toBeTruthy();
    expect(
      screen.getByText(
        'No customer is waiting on a return and no booking has been left open. This is what a healthy deposit book looks like.',
      ),
    ).toBeTruthy();

    // The money she IS holding is still on screen — this is not a blank state.
    const tiles = container.querySelector('.deposits__tiles') as HTMLElement;
    expect(within(tiles).getAllByText('98.000').length).toBeGreaterThan(0);
    expect(within(tiles).getByText('0.000')).toBeTruthy();

    // No section is drawn, because no state has anything in it.
    expect(container.querySelector('[data-state]')).toBeNull();

    // And nothing on screen reads as missing data.
    const text = (container.textContent ?? '').toLowerCase();
    for (const word of ['no data', 'nothing to show', 'unavailable', 'couldn']) {
      expect(text, `the healthy empty reads as "${word}"`).not.toContain(word);
    }
  });

  /**
   * THE SECOND EMPTY, AND IT MUST NOT SHARE COPY WITH THE FIRST. Nothing held at
   * all is a quiet salon or a branch filter that matched nothing — true, and a
   * different fact from "every deposit you hold is for a future slot". `AVO
   * States.dc.html`'s two-empties rule, applied to a pair nobody drew.
   */
  it('has a different sentence for a salon holding nothing at all', async () => {
    serve({
      ...CLEAR,
      held: { bookings: 0, fils: 0, branchAssumed: null },
      scheduled: { bookings: 0, fils: 0 },
    });
    rig();

    expect(await screen.findByText('No deposits on hold')).toBeTruthy();
    expect(
      screen.queryByText('Nothing overdue — every held deposit is for a slot still to come'),
    ).toBeNull();
  });
});

/* ============================================================ the branch === */

describe('the branch scope is the shell’s, and the caveat is proportional', () => {
  it('omits ?branch= at all-branches and sends the id otherwise', async () => {
    serve(HEALTH);
    rig();
    await screen.findByText('Noura S.');
    expect(authedRequest.mock.calls[0]?.[1]).toBe('/salons/SAL-AMARA/deposits');

    cleanup();
    branch = 'BR-SAL';
    authedRequest.mockClear();
    serve(HEALTH);
    rig();
    await screen.findByText('Noura S.');
    expect(authedRequest.mock.calls[0]?.[1]).toBe('/salons/SAL-AMARA/deposits?branch=BR-SAL');
  });

  /**
   * NOTHING AT `branch=all`. The API sends `branchAssumed: null` there on
   * purpose — a row attributed to the wrong branch is still inside the salon, so
   * a salon-wide total is exact however many rows are assumed — and a null is not
   * a zero to render as "0 of 12".
   */
  it('draws no caveat when the figures are salon-wide', async () => {
    serve(HEALTH);
    const { container } = rig();
    await screen.findByText('Noura S.');
    expect(container.textContent).not.toContain('Branch assumed on');
  });

  it('states the doubt proportionally when a branch is selected', async () => {
    branch = 'BR-SAL';
    serve({
      ...HEALTH,
      held: { bookings: 12, fils: 186500, branchAssumed: 3 },
      overdue: { ...HEALTH.overdue, branchAssumed: 2 },
      branchId: 'BR-SAL',
      branchName: 'Salmiya',
    });
    const { container } = rig();
    await screen.findByText('Noura S.');

    expect(container.textContent).toContain(
      'Branch assumed on 3 of 12 held and 2 of 5 overdue — treat these branch figures as approximate.',
    );
  });

  /** It disappears on its own when the counts fall to zero. No code change. */
  it('says nothing once no figure is a guess', async () => {
    branch = 'BR-SAL';
    serve({
      ...HEALTH,
      held: { bookings: 12, fils: 186500, branchAssumed: 0 },
      overdue: { ...HEALTH.overdue, branchAssumed: 0 },
      branchId: 'BR-SAL',
      branchName: 'Salmiya',
    });
    const { container } = rig();
    await screen.findByText('Noura S.');
    expect(container.textContent).not.toContain('Branch assumed on');
  });
});

/* ============================================================ the contact == */

describe('an erased customer is on the queue and is not contactable', () => {
  /**
   * BOTH HALVES, because each without the other is a defect: dropping her row
   * hides a deposit AVO still owes to a wallet, and rendering the `+990`
   * tombstone hands a merchant digits that reach nobody. DECISIONS #100 and the
   * wallet's `wa.me` button are the two times this lane shipped the second one.
   */
  it('keeps her row, names the absence, and puts no digits on screen', async () => {
    serve(HEALTH);
    rig();
    await screen.findByText('Deleted account');

    const ours = section('return_overdue');
    const row = within(ours).getByText('Deleted account').closest('tr') as HTMLElement;
    expect(within(row).getByText('Phone no longer held')).toBeTruthy();
    expect(row.querySelector('a')).toBeNull();
    // Nothing resembling a number, whatever prefix it might have carried.
    expect(row.textContent).not.toMatch(/\+\d/);
  });

  it('shows a live member’s number as plain text and never as a dial link', async () => {
    serve(HEALTH);
    rig();
    await screen.findByText('Noura S.');

    const row = screen.getByText('Noura S.').closest('tr') as HTMLElement;
    expect(within(row).getByText('+96599887766')).toBeTruthy();
    expect(row.querySelector('a')).toBeNull();
  });

  /** The branch caveat is on the ROW too, in the same words as everywhere else. */
  it('marks a row whose branch was inferred rather than recorded', async () => {
    serve(HEALTH);
    rig();
    await screen.findByText('Sara (walk-in)');

    const row = screen.getByText('Sara (walk-in)').closest('tr') as HTMLElement;
    expect(row.textContent).toContain('branch assumed');
    const clean = screen.getByText('Latifa A.').closest('tr') as HTMLElement;
    expect(clean.textContent).not.toContain('branch assumed');
  });
});

/* ============================================================== the pending */

describe('a pending screen announces nothing it is not painting', () => {
  /**
   * interaction-spec.md §4. On THIS screen the premature zero is the whole
   * hazard: `0.000 KD` under "Held right now" is indistinguishable from a salon
   * holding nothing. No figure, no section heading, no count — skeletons only.
   */
  it('paints skeletons and no figure, no heading and no count', () => {
    authedRequest.mockImplementation(() => new Promise(() => {}));
    const { container } = rig();

    expect(container.querySelectorAll('.avo-skeleton').length).toBeGreaterThan(0);
    expect(moneyOn(container as unknown as HTMLElement)).toEqual([]);
    expect(container.textContent).not.toContain('bookings');
    expect(container.querySelector('[data-state]')).toBeNull();
    expect(screen.queryByText(DEPOSIT_FRAMING.return_overdue.title)).toBeNull();
    // The labels are standing prose and may show; the VALUES may not.
    expect(screen.getByText('Held right now')).toBeTruthy();
  });
});

/* ============================================ the slot, in the salon's clock == */

/**
 * THE QUEUE PRINTS A SLOT IN THE SALON'S CLOCK, FROM A VIEWER WHO IS NOT IN IT.
 * `whenLabelZone.test.ts` pins the formatter; this pins the WIRING — that the
 * `timezone` handed to `<DepositHealth>` actually reaches the row, three
 * components down. The process is moved to Karachi (+05:00) for this block only.
 */
describe('a row’s slot is the salon’s clock, not the viewer’s', () => {
  const saved = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = 'Asia/Karachi';
  });
  afterAll(() => {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
    vi.useRealTimers();
  });

  it('22:30 Kuwait reads "Today · 10:30 PM", though Karachi is already past midnight', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-28T20:00:00.000Z')); // 23:00 Kuwait / 01:00 Karachi (29th)
    serve({ ...HEALTH, rows: [{ ...LATIFA, startsAt: '2026-09-28T19:30:00.000Z' }] });
    rig();

    const cell = await screen.findByText(/Today · 10:30 PM/);
    expect(cell).toBeTruthy();
    expect(document.body.textContent).not.toContain('12:30 AM');
    vi.useRealTimers();
  });
});
