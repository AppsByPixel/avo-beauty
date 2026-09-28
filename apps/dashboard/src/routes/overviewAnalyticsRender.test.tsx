// @vitest-environment jsdom

/**
 * MERCHANT → OVERVIEW → ANALYTICS, DRIVEN.
 *
 * Aftab, 2026-09-29: "Fill it with various useful visuals and analytics (at
 * least 10)". Every fixture below goes through `OverviewAnalyticsSchema.parse`
 * first — the schema lane A's own int specs parse every response through — so a
 * fixture this file invents cannot drift from what the server can send: an
 * undeclared key or a missing one fails the fixture, not the component.
 *
 * `AnalyticsGrid` is a function of its two reads, so no query client and no
 * session are needed. Cleanup is manual — no `globals` in this project.
 */

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OverviewAnalyticsSchema, type OverviewAnalytics } from '@avo/types';
import { ApiError } from '../api/client.js';
import type { Report } from '../api/reports.js';

vi.mock('../auth/AuthProvider.js', () => ({ useSalonId: () => 'SAL-AMARA' }));

const { AnalyticsGrid } = await import('./OverviewAnalytics.js');
type GridProps = Parameters<typeof AnalyticsGrid>[0];

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/* ------------------------------------------------------------- fixtures -- */

const WINDOW = {
  token: '30d',
  basis: 'rolling' as const,
  from: '2026-08-30T09:00:00.000Z',
  to: '2026-09-29T09:00:00.000Z',
  days: 30,
  fromDate: null,
  toDate: null,
  timezone: 'Asia/Kuwait',
};

/** Every block `ok`, every figure non-zero, every money figure with fils in it. */
const FULL_RAW = {
  asOf: '2026-09-29T09:00:00.000Z',
  window: WINDOW,
  branchId: null,
  branchName: null,
  loyaltyMode: 'tiers',
  modules: { booking: true, shop: true },
  topServices: {
    status: 'ok',
    byBookings: [
      { serviceId: 'SV-1', name: 'Blow-dry', bookings: 12, revenueFils: 96000 },
      { serviceId: 'SV-2', name: 'Gel nails', bookings: 7, revenueFils: 122500 },
    ],
    byRevenue: [
      { serviceId: 'SV-2', name: 'Gel nails', bookings: 7, revenueFils: 122500 },
      { serviceId: 'SV-1', name: 'Blow-dry', bookings: 12, revenueFils: 96000 },
    ],
    branchAssumed: null,
  },
  artists: {
    status: 'ok',
    items: [
      { artistId: 'AR-1', name: 'Noura Al-Rashid', bookings: 11, noShows: 1, revenueFils: 12345 },
      { artistId: 'AR-2', name: 'Maha K.', bookings: 0, noShows: 0, revenueFils: 0 },
    ],
    branchAssumed: null,
  },
  busiestTimes: {
    status: 'ok',
    cells: [
      { weekday: 4, hour: 21, visits: 3 },
      { weekday: 4, hour: 17, visits: 9 },
      { weekday: 0, hour: 10, visits: 1 },
    ],
    totalVisits: 13,
    branchAssumed: null,
  },
  upcoming: {
    status: 'ok',
    today: 2,
    next7Days: 9,
    branchAssumed: null,
    next: {
      status: 'ok',
      items: [
        {
          bookingId: 'BK-10000005',
          // 23:30 in Kuwait on 30 Sep — already 1 Oct in Karachi.
          startsAt: '2026-09-30T20:30:00.000Z',
          customerName: 'Latifa A.',
          memberId: 'MB-1',
          serviceName: 'Blow-dry',
          artistName: 'Noura Al-Rashid',
          branchId: 'BR-KWC',
          branchName: 'Kuwait City',
          branchAssumed: false,
        },
      ],
    },
  },
  noShows: {
    status: 'ok',
    completed: 7,
    noShows: 1,
    rateBp: 1250,
    depositsHeld: { bookings: 3, fils: 15250 },
    branchAssumed: null,
  },
  newMembers: {
    status: 'ok',
    total: 6,
    weeks: [
      { weekStart: '2026-08-30', count: 1, partial: true },
      { weekStart: '2026-09-06', count: 3, partial: false },
      { weekStart: '2026-09-13', count: 0, partial: false },
      { weekStart: '2026-09-20', count: 2, partial: false },
      { weekStart: '2026-09-27', count: 0, partial: true },
    ],
  },
  visitors: { status: 'ok', total: 10, firstVisit: 4, returning: 6, branchAssumed: null },
  loyalty: {
    status: 'ok',
    mode: 'tiers',
    tiers: [
      { tier: 'Bronze', members: 8 },
      { tier: 'Silver', members: 3 },
      { tier: 'Gold', members: 1 },
    ],
    untiered: 2,
  },
  wallet: {
    status: 'ok',
    loadedFils: 123456,
    bonusFils: 5001,
    topups: 4,
    spentFils: 98765,
    liabilityFils: 240501,
  },
  paymentMix: {
    status: 'ok',
    topups: {
      knet: { count: 2, fils: 82304, shareBp: 6667 },
      card: { count: 1, fils: 41152, shareBp: 3333 },
      applepay: { count: 0, fils: 0, shareBp: 0 },
    },
    walletSpend: { count: 11, fils: 98765 },
  },
  shop: {
    status: 'ok',
    orders: 5,
    ordersByStatus: { preparing: 2, ready: 1, closed: 2 },
    topProducts: [{ productId: 'PR-1', name: 'Argan oil', units: 4, revenueFils: 18000 }],
    revenueFils: 27500,
    branchAssumed: null,
  },
  campaigns: {
    status: 'ok',
    sent: 1,
    reached: 140,
    reach: 150,
    items: [
      {
        campaignId: 'CP-1',
        title: 'Autumn blow-dry week',
        audience: 'All members',
        channel: 'push',
        sentAt: '2026-09-20T08:00:00.000Z',
        reached: 140,
        reach: 150,
        result: '140 reached',
      },
    ],
    truncated: false,
  },
};

const parse = (raw: unknown): OverviewAnalytics => OverviewAnalyticsSchema.parse(raw);
const FULL = parse(FULL_RAW);

const REPORT: Report = {
  kind: 'earnings-by-branch',
  title: 'Earnings by branch',
  period: '30d',
  window: WINDOW,
  comparison: null,
  branchId: 'all',
  columns: [],
  rows: [
    { branch: 'Kuwait City', transactions: 14, grossFils: 180250, assumedGrossFils: 0, assumedTransactions: 0 },
    { branch: 'Salmiya', transactions: 3, grossFils: 20001, assumedGrossFils: 0, assumedTransactions: 0 },
  ],
  stat: { key: 'grossFils', label: 'KD gross', value: 200251, type: 'money' },
  rowCount: 2,
};

function read<T>(data: T | undefined, over: Partial<GridProps['analytics']> = {}) {
  return { data, pending: false, error: null, onRetry: vi.fn(), retrying: false, ...over };
}

function mount(
  analytics: Omit<Partial<GridProps['analytics']>, 'data'> & { data: OverviewAnalytics | undefined },
  earnings = read(REPORT),
) {
  return render(
    <AnalyticsGrid
      analytics={read(analytics.data, analytics) as GridProps['analytics']}
      earnings={earnings as GridProps['earnings']}
      timezone="Asia/Kuwait"
      modulesHint={{ booking: true, shop: true }}
      updatedAt={Date.parse('2026-09-29T09:00:00Z')}
    />,
  );
}

const card = (label: string) => document.querySelector(`[data-widget="${label}"]`) as HTMLElement | null;
const cards = () => [...document.querySelectorAll('[data-widget]')].map((e) => e.getAttribute('data-widget'));

function withBlock<K extends keyof typeof FULL_RAW>(key: K, value: unknown, extra: Record<string, unknown> = {}) {
  return parse({ ...FULL_RAW, ...extra, [key]: value });
}

/* ------------------------------------------------------------------- tests -- */

describe('with every module and permission on', () => {
  it('draws at least ten widgets — thirteen, each from the parsed fixture', () => {
    mount({ data: FULL });
    expect(cards()).toEqual([
      'revenue-by-branch',
      'top-services',
      'artists',
      'busiest-times',
      'upcoming',
      'no-shows',
      'new-members',
      'visitors',
      'loyalty',
      'wallet',
      'payment-mix',
      'shop',
      'campaigns',
    ]);
    expect(cards().length).toBeGreaterThanOrEqual(10);
    // Nothing is withheld, so no card says so.
    expect(screen.queryByText(/don.t have access/)).toBeNull();
    expect(screen.queryByText('Salon-wide only.')).toBeNull();
  });

  it('says what the grid covers from the server echo', () => {
    mount({ data: FULL });
    expect(screen.getByText('This month · All branches')).toBeTruthy();
  });

  it('renders revenue by branch from the report, to the fil', () => {
    mount({ data: FULL });
    const c = within(card('revenue-by-branch')!);
    expect(c.getByText('Kuwait City: 180.250 KD from 14 transactions')).toBeTruthy();
    expect(c.getByText('Salmiya: 20.001 KD from 3 transactions')).toBeTruthy();
  });

  it('toggles top services between bookings and revenue', () => {
    mount({ data: FULL });
    const c = within(card('top-services')!);
    const names = () => [...card('top-services')!.querySelectorAll('.ovw-bars__name')].map((n) => n.textContent);
    expect(names()).toEqual(['Blow-dry', 'Gel nails']);
    expect(c.getByText('12 bookings')).toBeTruthy();
    fireEvent.click(c.getByRole('radio', { name: 'Revenue' }));
    expect(names()).toEqual(['Gel nails', 'Blow-dry']);
    expect(card('top-services')!.textContent).toContain('122.500 KD');
  });

  it('lists every artist, zeros included, with revenue to the fil', () => {
    mount({ data: FULL });
    const rows = within(card('artists')!).getAllByRole('row');
    expect(rows).toHaveLength(3);
    expect(rows[1]!.textContent).toContain('Noura Al-Rashid');
    expect(rows[1]!.textContent).toContain('12.345');
    expect(rows[2]!.textContent).toContain('Maha K.');
  });

  it('formats basis points by dividing by 100 in formatting only', () => {
    mount({ data: FULL });
    expect(within(card('no-shows')!).getByText('12.5%')).toBeTruthy();
    expect(within(card('no-shows')!).getByText('1 of 8 resolved appointments')).toBeTruthy();
    const mix = card('payment-mix')!;
    expect(mix.textContent).toContain('66.67%');
    expect(mix.textContent).toContain('33.33%');
  });

  it('keeps money exact to the fil — paid is loaded minus bonus, as integers', () => {
    mount({ data: FULL });
    const w = card('wallet')!;
    expect(w.textContent).toContain('123.456 KD');
    expect(w.textContent).toContain('98.765 KD');
    expect(w.textContent).toContain('5.001 KD');
    // 123456 − 5001 = 118455 fils.
    expect(w.textContent).toContain('118.455 KD');
    expect(w.textContent).toContain('240.501 KD');
    expect(card('no-shows')!.textContent).toContain('15.250 KD');
  });

  it('draws payment mix as TWO visuals — top-up methods, and wallet spend', () => {
    mount({ data: FULL });
    const c = within(card('payment-mix')!);
    expect(c.getByText('Top-ups by method')).toBeTruthy();
    expect(c.getByText('Spent from wallets')).toBeTruthy();
    expect(c.getByText('11 payments')).toBeTruthy();
    // KNET, card and Apple Pay are bars under the first heading only.
    expect(card('payment-mix')!.querySelectorAll('.ovw-bars__row')).toHaveLength(3);
  });

  it('marks partial weeks on new members, in words as well as paint', () => {
    mount({ data: FULL });
    const c = card('new-members')!;
    // The window clips the first and the last week.
    expect(c.querySelectorAll('[data-partial="true"]')).toHaveLength(2);
    expect(within(c).getByText('Week of 30 Aug: 1 new member (part week)')).toBeTruthy();
    expect(within(c).getByText(/Paler bars are part weeks/)).toBeTruthy();
  });

  it('links each upcoming booking to Appointments, on the SALON day', () => {
    mount({ data: FULL });
    const link = within(card('upcoming')!).getByRole('link');
    expect(link.getAttribute('href')).toBe('/appointments?booking=BK-10000005&day=2026-09-30');
    expect(card('upcoming')!.textContent).toContain('9');
  });

  it('draws members by tier, with the untiered as their own bar', () => {
    mount({ data: FULL });
    const c = within(card('loyalty')!);
    expect(c.getByText('Bronze: 8 members')).toBeTruthy();
    expect(c.getByText('No tier: 2 members')).toBeTruthy();
  });

  it('draws a stamp histogram at a stamps salon instead of a tier ladder', () => {
    mount({
      data: withBlock(
        'loyalty',
        {
          status: 'ok',
          mode: 'stamps',
          stampTarget: 3,
          buckets: [
            { stamps: 0, members: 4 },
            { stamps: 1, members: 2 },
            { stamps: 2, members: 0 },
            { stamps: 3, members: 1 },
          ],
        },
        { loyaltyMode: 'stamps' },
      ),
    });
    expect(screen.getByText('Stamp progress')).toBeTruthy();
    expect(within(card('loyalty')!).getByText('2 stamps: 0 members')).toBeTruthy();
    expect(screen.queryByText('Members by tier')).toBeNull();
  });
});

describe('busiest times are in the salon’s clock', () => {
  it('places a Kuwait Thursday 21:00 in the Thursday row and the 21:00 column, even from Karachi', () => {
    const prior = process.env.TZ;
    process.env.TZ = 'Asia/Karachi';
    try {
      mount({ data: FULL });
      const table = card('busiest-times')!.querySelector('table')!;
      const heads = [...table.querySelectorAll('thead th')].map((th) => th.textContent);
      const col = heads.findIndex((h) => h?.includes('21:00'));
      expect(col).toBeGreaterThanOrEqual(0);
      const thursday = [...table.querySelectorAll('tbody tr')].find((tr) =>
        tr.querySelector('th')?.textContent?.includes('Thursday'),
      )!;
      const cell = thursday.querySelectorAll('td')[col]!;
      expect(cell.textContent).toBe('3 visits');
      expect(cell.getAttribute('data-level')).toBe('2');
      // The hours are trimmed to 10:00–21:00, the first and last with a visit.
      expect(heads.filter((h) => /\d\d:00/.test(h ?? ''))).toHaveLength(12);
      expect(card('busiest-times')!.textContent).toContain('(Asia/Kuwait)');
      expect(screen.getByText(/Busiest: Thursday at 17:00/)).toBeTruthy();
    } finally {
      process.env.TZ = prior;
    }
  });
});

describe('every withheld reason has its own state', () => {
  it('permission: the card stays and says the merchant has no access', () => {
    mount({
      data: withBlock('topServices', { status: 'withheld', reason: 'permission', permission: 'appointments' }),
    });
    expect(within(card('top-services')!).getByText('You don’t have access to appointments.')).toBeTruthy();
  });

  it('permission on artists, shop and campaigns names each section', () => {
    const data = parse({
      ...FULL_RAW,
      artists: { status: 'withheld', reason: 'permission', permission: 'team' },
      shop: { status: 'withheld', reason: 'permission', permission: 'shop' },
      campaigns: { status: 'withheld', reason: 'permission', permission: 'marketing' },
    });
    mount({ data });
    expect(within(card('artists')!).getByText('You don’t have access to the team.')).toBeTruthy();
    expect(within(card('shop')!).getByText('You don’t have access to the shop.')).toBeTruthy();
    expect(within(card('campaigns')!).getByText('You don’t have access to marketing.')).toBeTruthy();
  });

  it('permission on the named next five keeps the counts and drops only the list', () => {
    mount({
      data: parse({
        ...FULL_RAW,
        upcoming: {
          ...FULL_RAW.upcoming,
          next: { status: 'withheld', reason: 'permission', permission: 'appointments' },
        },
      }),
    });
    const c = card('upcoming')!;
    expect(within(c).getByText(/so the next bookings aren.t listed/)).toBeTruthy();
    expect(within(c).queryByRole('link')).toBeNull();
    expect(within(c).getByText('Next 7 days')).toBeTruthy();
  });

  it('module_off: the shop card is not drawn at all', () => {
    mount({
      data: parse({
        ...FULL_RAW,
        modules: { booking: true, shop: false },
        shop: { status: 'withheld', reason: 'module_off', permission: null },
      }),
    });
    expect(card('shop')).toBeNull();
    expect(cards()).toHaveLength(12);
  });

  it('not_per_branch: the five salon-wide cards say so and why, under a branch', () => {
    const npb = { status: 'withheld', reason: 'not_per_branch', permission: null };
    mount({
      data: parse({
        ...FULL_RAW,
        branchId: 'BR-SAL',
        branchName: 'Salmiya',
        newMembers: npb,
        loyalty: npb,
        wallet: npb,
        paymentMix: npb,
        campaigns: npb,
      }),
    });
    for (const label of ['new-members', 'loyalty', 'wallet', 'payment-mix', 'campaigns']) {
      const c = card(label)!;
      expect(within(c).getByText('Salon-wide only.')).toBeTruthy();
      expect(c.textContent).toContain('Choose All branches to see it.');
    }
    expect(card('wallet')!.textContent).toContain('Top-ups happen in the app, not at a branch');
    expect(screen.getByText('This month · Salmiya')).toBeTruthy();
    // No figure leaks through a withheld card.
    expect(card('wallet')!.textContent).not.toMatch(/\d+\.\d{3}/);
  });

  it('a salon without bookings draws none of the four booking cards', () => {
    mount({ data: parse({ ...FULL_RAW, modules: { booking: false, shop: true } }) });
    for (const label of ['top-services', 'artists', 'upcoming', 'no-shows']) expect(card(label)).toBeNull();
    expect(card('busiest-times')).not.toBeNull();
  });

  it('carries the branch-assumed doubt, in the Overview’s own words', () => {
    mount({
      data: parse({
        ...FULL_RAW,
        branchId: 'BR-SAL',
        branchName: 'Salmiya',
        busiestTimes: { ...FULL_RAW.busiestTimes, branchAssumed: { assumed: 2, total: 13 } },
      }),
    });
    expect(
      within(card('busiest-times')!).getByText(
        'Branch assumed on 2 of 13 visits — treat these branch figures as approximate.',
      ),
    ).toBeTruthy();
  });
});

describe('each card owns its loading, empty and error states', () => {
  it('loading: every card skeletons and none paints a zero', () => {
    mount({ data: undefined, pending: true }, read<Report>(undefined, { pending: true }));
    expect(cards().length).toBeGreaterThanOrEqual(10);
    for (const el of document.querySelectorAll('[data-widget]')) {
      expect(el.querySelector('.ovw__skeleton')).not.toBeNull();
    }
    expect(document.body.textContent).not.toContain('0.000');
  });

  it('error: every card says so and offers its retry; the report card has its own', () => {
    const onRetry = vi.fn();
    mount(
      { data: undefined, error: new ApiError('boom', { status: 500, code: 'internal' }), onRetry },
      read(REPORT),
    );
    const failing = screen.getAllByText("Couldn't load this");
    expect(failing.length).toBe(12);
    // The report read succeeded, so its card still draws.
    expect(within(card('revenue-by-branch')!).queryByText("Couldn't load this")).toBeNull();
    fireEvent.click(within(card('wallet')!).getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('offline is its own answer, and a refusal offers no retry', () => {
    mount({ data: undefined, error: new ApiError('offline', { status: 0, code: 'network', offline: true }) });
    expect(screen.getAllByText('No connection').length).toBe(12);
    cleanup();
    mount({
      data: undefined,
      error: new ApiError('You need the Dashboard permission.', { status: 403, code: 'forbidden' }),
    });
    expect(screen.getAllByText("You don't have access to this").length).toBe(12);
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('a failed refetch keeps the cards it has behind one stale banner', () => {
    mount({ data: FULL, error: new ApiError('boom', { status: 500, code: 'internal' }) });
    expect(screen.queryByText("Couldn't load this")).toBeNull();
    expect(card('wallet')!.textContent).toContain('123.456 KD');
    expect(document.querySelectorAll('.avo-stale')).toHaveLength(1);
  });

  it('empty: each card names what fills it', () => {
    const zero = parse({
      ...FULL_RAW,
      topServices: { status: 'ok', byBookings: [], byRevenue: [], branchAssumed: null },
      artists: { status: 'ok', items: [], branchAssumed: null },
      busiestTimes: { status: 'ok', cells: [], totalVisits: 0, branchAssumed: null },
      upcoming: { status: 'ok', today: 0, next7Days: 0, branchAssumed: null, next: { status: 'ok', items: [] } },
      noShows: {
        status: 'ok',
        completed: 0,
        noShows: 0,
        rateBp: null,
        depositsHeld: { bookings: 0, fils: 0 },
        branchAssumed: null,
      },
      newMembers: { status: 'ok', total: 0, weeks: FULL_RAW.newMembers.weeks.map((w) => ({ ...w, count: 0 })) },
      visitors: { status: 'ok', total: 0, firstVisit: 0, returning: 0, branchAssumed: null },
      loyalty: { status: 'ok', mode: 'tiers', tiers: [{ tier: 'Bronze', members: 0 }], untiered: 0 },
      wallet: { status: 'ok', loadedFils: 0, bonusFils: 0, topups: 0, spentFils: 0, liabilityFils: 0 },
      paymentMix: {
        status: 'ok',
        topups: {
          knet: { count: 0, fils: 0, shareBp: null },
          card: { count: 0, fils: 0, shareBp: null },
          applepay: { count: 0, fils: 0, shareBp: null },
        },
        walletSpend: { count: 0, fils: 0 },
      },
      shop: {
        status: 'ok',
        orders: 0,
        ordersByStatus: { preparing: 0, ready: 0, closed: 0 },
        topProducts: [],
        revenueFils: 0,
        branchAssumed: null,
      },
      campaigns: { status: 'ok', sent: 0, reached: 0, reach: 0, items: [], truncated: false },
    });
    mount({ data: zero }, read({ ...REPORT, rows: [], stat: { ...REPORT.stat, value: 0 } }));
    expect(screen.getByText('No revenue this month')).toBeTruthy();
    expect(screen.getByText('No booked services this month')).toBeTruthy();
    expect(screen.getByText('No artists yet')).toBeTruthy();
    expect(screen.getAllByText('No visits this month')).toHaveLength(2);
    expect(screen.getByText('Nothing booked ahead')).toBeTruthy();
    // A rate over nothing is not 0%.
    expect(within(card('no-shows')!).getByText('—')).toBeTruthy();
    expect(within(card('no-shows')!).queryByText('0%')).toBeNull();
    expect(screen.getByText('No new members this month')).toBeTruthy();
    expect(screen.getByText('No members yet')).toBeTruthy();
    expect(screen.getByText('Nothing was loaded or spent this month.')).toBeTruthy();
    expect(screen.getByText('No top-ups this month.')).toBeTruthy();
    expect(screen.getByText('No shop orders this month')).toBeTruthy();
    expect(screen.getByText('No campaigns went out this month')).toBeTruthy();
  });
});

describe('the parse is the contract', () => {
  it('refuses a block with an undeclared key rather than drawing it', () => {
    expect(() =>
      parse({ ...FULL_RAW, visitors: { ...FULL_RAW.visitors, openRate: 12 } }),
    ).toThrow();
  });
});
