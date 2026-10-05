// @vitest-environment jsdom

/**
 * OWNER CONSOLE → ANALYTICS, DRIVEN.
 *
 * Aftab, 2026-10-05: "The way we added so much graphs and valuable analytics for
 * the merchant dashboard, we need to do similar for the admin console." Every
 * fixture goes through `PlatformAnalyticsSchema.parse` first — the schema lane A's
 * int specs parse every response through — so a fixture invented here cannot
 * drift from what the server can send.
 *
 * `PlatformAnalyticsGrid` is a function of its one read, so no query client is
 * needed. The export half records the REQUEST that left (off the `fetch` mock) and
 * the HREF the anchor was handed — `overviewExport.test.tsx`' method. Cleanup is
 * manual — no `globals` in this project.
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlatformAnalyticsSchema } from '@avo/types';
import { ApiError } from '../../api/client.js';
import type { PlatformAnalytics } from '../../api/platformAnalytics.js';
import { PLATFORM_ANALYTICS_SECTIONS } from '../../api/platformAnalytics.js';
import { API_BASE_URL } from '../../config.js';

vi.mock('../../auth/AuthProvider.js', () => ({ useSalonId: () => 'SAL-AMARA' }));
vi.mock('../../auth/session.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../auth/session.js')>()),
  readSession: () => ({ accessToken: 'tok_console_export' }) as never,
}));

const { PlatformAnalyticsGrid, platformAnalyticsExporter } = await import('./Analytics.js');
const { EXPORT_LABEL } = await import('../overviewExport.js');
type GridProps = Parameters<typeof PlatformAnalyticsGrid>[0];

/* ------------------------------------------------------------- fixtures -- */

const MONTHS = ['2026-08', '2026-09', '2026-10'] as const;
const method = (topups: number, feeFils: number) => ({ topups, feeFils });

function raw(over: Record<string, unknown> = {}) {
  return {
    asOf: '2026-10-05T09:00:00.000Z',
    timezone: 'Asia/Kuwait',
    month: '2026-10',
    partial: true,
    months: [...MONTHS],
    salonId: null,
    salonName: null,
    revenue: {
      status: 'ok',
      months: MONTHS.map((month, i) => ({
        month,
        feeFils: [100000, 110000, 214300567][i],
        topups: 10 + i,
        byMethod: { knet: method(6, 900), card: method(3, 4500), applepay: method(1 + i, 1500) },
      })),
      thisMonthFils: 214300567,
      priorMonth: '2026-09',
      priorMonthFils: 110000,
    },
    money: {
      status: 'ok',
      months: MONTHS.map((month, i) => ({
        month,
        loadedFils: 1000000 * (i + 1),
        bonusFils: 50000,
        spentFils: 400000 * (i + 1),
      })),
      liabilityFils: 3456789,
      liabilityBySalon: [
        { salonId: 'SAL-AMARA', name: 'Amara', liabilityFils: 2456789 },
        { salonId: 'SAL-BLOOM', name: 'Bloom', liabilityFils: 1000000 },
      ],
    },
    salons: {
      status: 'ok',
      total: 14,
      byPlan: { starter: 6, growth: 5, pro: 3 },
      branches: { open: 22, closed: 2 },
      months: MONTHS.map((month, i) => ({ month, newSalons: i, active: 10 + i, dormant: 2 })),
    },
    members: {
      status: 'ok',
      total: 1280,
      months: MONTHS.map((month, i) => ({ month, newMembers: 40 + i, activeMembers: 300 + i })),
      tiers: { salons: 9, bronze: 500, silver: 200, gold: 80, black: 12, untiered: 30 },
      stamps: { salons: 2, buckets: [{ stampTarget: 8, stamps: 3, members: 41 }] },
    },
    leaderboard: {
      status: 'ok',
      rows: [
        {
          salonId: 'SAL-AMARA',
          name: 'Amara',
          modules: { booking: true, shop: true },
          members: 300,
          activeMembers: 120,
          loadedFils: 900000,
          spentFils: 100000,
          avoRevenueFils: 13500,
          bookings: 44,
          noShowRateBp: 1250,
          shopRevenueFils: 20000,
          liabilityFils: 2456789,
        },
        {
          salonId: 'SAL-BLOOM',
          name: 'Bloom',
          modules: { booking: false, shop: false },
          members: 700,
          activeMembers: 90,
          loadedFils: 500000,
          spentFils: 600000,
          avoRevenueFils: 7500,
          bookings: null,
          noShowRateBp: null,
          shopRevenueFils: null,
          liabilityFils: 1000000,
        },
      ],
    },
    paymentMix: {
      status: 'ok',
      topups: 12,
      loadedFils: 3000000,
      methods: {
        knet: { count: 6, fils: 1860000, shareBp: 6200 },
        card: { count: 3, fils: 840000, shareBp: 2800 },
        applepay: { count: 3, fils: 300000, shareBp: 1000 },
      },
    },
    bookings: {
      status: 'ok',
      salons: 5,
      months: MONTHS.map((month, i) => ({ month, bookings: 30 + i, completed: 20, noShows: 4, rateBp: 1667 })),
      depositsHeld: { bookings: 3, fils: 15000 },
    },
    campaigns: {
      status: 'ok',
      pendingNow: 2,
      months: MONTHS.map((month) => ({
        month,
        submitted: 5,
        approved: 3,
        rejected: 1,
        sent: 3,
        held: 0,
        medianDecisionSeconds: 4 * 3600 + 12 * 60,
        p90DecisionSeconds: 26 * 3600,
      })),
    },
    support: {
      status: 'ok',
      openNow: { total: 7, avo: 4, salon: 3 },
      months: MONTHS.map((month) => ({ month, opened: 9, resolved: 8 })),
    },
    shop: {
      status: 'ok',
      salons: 4,
      months: MONTHS.map((month, i) => ({ month, gmvFils: 120000 * (i + 1), orders: 6 + i })),
      ordersByStatus: { preparing: 2, ready: 1, closed: 5 },
    },
    busiestTimes: {
      status: 'ok',
      clock: 'salon_local',
      cells: [
        { weekday: 4, hour: 18, visits: 40 },
        { weekday: 5, hour: 11, visits: 9 },
      ],
      totalVisits: 49,
    },
    ...over,
  };
}

const parse = (input: unknown): PlatformAnalytics => PlatformAnalyticsSchema.parse(input);
const DATA = parse(raw());

function readOf(data: PlatformAnalytics | undefined, over: Partial<GridProps['read']> = {}): GridProps['read'] {
  return { data, pending: false, error: null, onRetry: vi.fn(), retrying: false, ...over };
}

function mount(
  opts: { data?: PlatformAnalytics | undefined; read?: Partial<GridProps['read']>; offline?: boolean; exporter?: boolean } = {},
) {
  const data = 'data' in opts ? opts.data : DATA;
  const { offline = false, exporter = true } = opts;
  return render(
    <PlatformAnalyticsGrid
      read={readOf(data, opts.read)}
      updatedAt={Date.parse('2026-10-05T09:00:00Z')}
      {...(exporter ? { exporter: platformAnalyticsExporter(offline) } : {})}
    />,
  );
}

const card = (label: string) => document.querySelector(`[data-widget="${label}"]`) as HTMLElement;
const cardExport = (label: string) => card(label).querySelector('.ovw__export') as HTMLButtonElement | null;
const headExport = () => screen.getByRole('button', { name: /all analytics$/ }) as HTMLButtonElement;
const WIDGETS = [
  'revenue',
  'money',
  'salons',
  'members',
  'leaderboard',
  'payment-mix',
  'bookings',
  'campaigns',
  'support',
  'shop',
  'busiest-times',
];

/* -------------------------------------------------- the network, recorded -- */

type Call = { url: string; method: string; body: unknown; auth: string | null };
let calls: Call[];
let followed: string[];
let answer: () => Promise<Response>;

const minted = (url: string) => async () =>
  new Response(JSON.stringify({ url, expiresAt: '2026-10-05T09:01:00.000Z' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

beforeEach(() => {
  calls = [];
  followed = [];
  answer = minted('/report-downloads/tok_once');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({
        url: String(url),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
        auth: headers['Authorization'] ?? null,
      });
      return answer();
    }),
  );
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    followed.push(this.href);
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/* --------------------------------------------------------------- loaded -- */

describe('loaded: the KPI row, then one card per block in the payload’s order', () => {
  it('draws eleven cards, in reading order', () => {
    mount();
    const order = Array.from(document.querySelectorAll('[data-widget]')).map((n) => n.getAttribute('data-widget'));
    expect(order).toEqual(WIDGETS);
  });

  it('labels the tile "Salons", never "Salons live" — the schema cannot say live', () => {
    mount();
    expect(screen.getByText('Salons', { selector: '.avo-label' })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/Salons live/);
    expect(document.body.textContent).toContain('+2 this month');
  });

  it('never abbreviates money: 214,300.567, not 214.3k', () => {
    mount();
    const tiles = document.querySelector('.analytics__kpis') as HTMLElement;
    expect(tiles.textContent).toContain('214,300.567');
    expect(document.body.textContent).not.toMatch(/\d+(\.\d)?k\b/);
  });

  it('writes the server’s echo over the cards — month, month to date, history, scope', () => {
    mount();
    const head = document.querySelector('.ovw-head') as HTMLElement;
    expect(head.textContent).toContain('All salons');
    expect(head.textContent).toContain('October 2026 · month to date · 3 months of history');
  });

  it('marks the month-to-date bar and says why in words', () => {
    mount();
    const revenue = card('revenue');
    expect(revenue.querySelectorAll('.analytics__bar[data-partial]')).toHaveLength(1);
    expect(revenue.textContent).toContain('Oct is month to date');
  });

  it('reads every bar out with its month and figure', () => {
    mount();
    const sr = Array.from(card('revenue').querySelectorAll('.analytics__barcol .avo-sr-only')).map((n) => n.textContent);
    expect(sr).toEqual(['August 2026: 100.000 KD', 'September 2026: 110.000 KD', 'October 2026 so far: 214,300.567 KD']);
  });

  it('switches a card’s series without another read', () => {
    mount();
    const money = card('money');
    fireEvent.click(within(money).getByRole('radio', { name: 'Spent' }));
    const sr = Array.from(money.querySelectorAll('.analytics__barcol .avo-sr-only')).map((n) => n.textContent);
    expect(sr[0]).toBe('August 2026: 400.000 KD');
    expect(calls).toHaveLength(0);
  });

  it('ranks the leaderboard by loaded, and re-ranks by members on request', () => {
    mount();
    const board = card('leaderboard');
    const names = () => Array.from(board.querySelectorAll('.analytics__topname')).map((n) => n.textContent);
    expect(names()).toEqual(['Amara', 'Bloom']);
    fireEvent.click(within(board).getByRole('radio', { name: 'Members' }));
    expect(names()).toEqual(['Bloom', 'Amara']);
  });

  it('says busiest times are each salon’s local time', () => {
    mount();
    const heat = card('busiest-times');
    expect(heat.textContent).toContain("in each salon's local time");
    expect(heat.textContent).toContain('Busiest: Thursday at 18:00 · 40 visits');
  });

  it('prints basis points as a share, the server’s rounding kept', () => {
    mount();
    expect(card('payment-mix').textContent).toContain('62%');
    expect(card('bookings').textContent).toContain('16.67%');
  });
});

/* -------------------------------------------------------------- pending -- */

describe('pending: skeletons in the loaded layout, and never 0.000', () => {
  it('paints every card and tile as a skeleton', () => {
    mount({ data: undefined, read: { pending: true } });
    expect(document.querySelectorAll('[data-widget]')).toHaveLength(11);
    expect(document.querySelectorAll('.ovw__skeleton').length).toBe(11);
    expect(document.body.textContent).not.toContain('0.000');
  });

  it('draws no card Export and a disabled page Export', () => {
    mount({ data: undefined, read: { pending: true } });
    expect(document.querySelectorAll('.ovw__export')).toHaveLength(0);
    expect(headExport().disabled).toBe(true);
  });
});

/* ------------------------------------------------------------- withheld -- */

describe('withheld: the card stays and says why — never a zero', () => {
  const WITHHELD = parse(
    raw({
      campaigns: { status: 'withheld', reason: 'permission', permission: 'approvals' },
      support: { status: 'withheld', reason: 'permission', permission: 'policies' },
    }),
  );

  it('names the section a permission block needs, with no figure and no Export', () => {
    mount({ data: WITHHELD });
    const campaigns = card('campaigns');
    expect(campaigns.textContent).toContain("You don't have access to Approvals, so these figures aren't shown.");
    expect(card('support').textContent).toContain("You don't have access to Policies");
    expect(campaigns.querySelector('.ovw-figure')).toBeNull();
    expect(cardExport('campaigns')).toBeNull();
    expect(cardExport('support')).toBeNull();
    expect(cardExport('revenue')).not.toBeNull();
  });

  it('says a scoped salon does not run a module, by name', () => {
    mount({
      data: parse(
        raw({
          salonId: 'SAL-BLOOM',
          salonName: 'Bloom',
          bookings: { status: 'withheld', reason: 'module_off', permission: null },
          shop: { status: 'withheld', reason: 'module_off', permission: null },
        }),
      ),
    });
    expect(card('bookings').textContent).toContain("Bloom doesn't take bookings through AVO.");
    expect(card('shop').textContent).toContain("Bloom doesn't run the AVO shop.");
    expect(document.querySelector('.ovw-head')!.textContent).toContain('Bloom');
  });
});

/* ---------------------------------------------------------------- empty -- */

describe('empty names the thing and what fills it', () => {
  it('a platform with no commission yet', () => {
    const zero = raw();
    (zero.revenue as { months: Array<{ feeFils: number; topups: number }> }).months.forEach((m) => {
      m.feeFils = 0;
      m.topups = 0;
    });
    mount({ data: parse({ ...zero, revenue: { ...(zero.revenue as object), thisMonthFils: 0, priorMonthFils: 0 } }) });
    expect(card('revenue').textContent).toContain('No commission in the last 3 months');
    expect(card('revenue').textContent).toContain('as customers top up their wallets');
  });

  it('no visits in the month', () => {
    mount({ data: parse(raw({ busiestTimes: { status: 'ok', clock: 'salon_local', cells: [], totalVisits: 0 } })) });
    expect(card('busiest-times').textContent).toContain('No visits in October 2026');
  });
});

/* -------------------------------------------------------- error/offline -- */

describe('error: one answer for the page — we failed, you can’t, or no connection', () => {
  it('we failed: retry', () => {
    const onRetry = vi.fn();
    mount({ data: undefined, read: { error: new ApiError('boom', { status: 500, code: 'internal' }), onRetry } });
    expect(screen.getByText("Couldn't load the platform analytics")).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(onRetry).toHaveBeenCalled();
    expect(document.querySelectorAll('[data-widget]')).toHaveLength(0);
  });

  it('offline: says so, and retries', () => {
    mount({ data: undefined, read: { error: new ApiError("We can't reach the workspace.", { status: 0, code: 'offline', offline: true }) } });
    expect(screen.getByText('No connection')).toBeTruthy();
    expect(screen.getByRole('button', { name: /try again/i })).toBeTruthy();
  });

  it('you can’t: the server’s sentence, no retry, and no figures held behind it', () => {
    mount({
      read: { error: new ApiError('This admin has no analytics section.', { status: 403, code: 'forbidden' }) },
    });
    expect(screen.getByText("You don't have access to analytics")).toBeTruthy();
    expect(screen.getByText('This admin has no analytics section.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /try again/i })).toBeNull();
    expect(document.querySelectorAll('[data-widget]')).toHaveLength(0);
  });

  it('a refused filter is printed verbatim, with the remedy and no retry', () => {
    mount({ data: undefined, read: { error: new ApiError('No such salon.', { status: 404, code: 'unknown_salon' }) } });
    expect(screen.getByText('No such salon. Clear the filters to see every salon this month.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /try again/i })).toBeNull();
  });

  it('a failed refresh keeps the cards and says so once (stale-not-blank)', () => {
    mount({ read: { error: new ApiError('boom', { status: 500, code: 'internal' }) } });
    expect(screen.getByText(/Couldn.t refresh/)).toBeTruthy();
    expect(document.querySelectorAll('[data-widget]')).toHaveLength(11);
  });
});

/* --------------------------------------------------------------- export -- */

describe('export: the page’s Export takes every section, a card’s takes its own', () => {
  it('mints with the server’s echo, no salon and no section, on the owner session, then follows', async () => {
    mount();
    expect(headExport().textContent).toBe(EXPORT_LABEL.idle);
    fireEvent.click(headExport());
    await waitFor(() => expect(followed).toHaveLength(1));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url).toBe(`${API_BASE_URL}/v1/platform/analytics/download-url`);
    expect(calls[0]!.body).toEqual({ month: '2026-10', months: 3 });
    expect(calls[0]!.auth).toBe('Bearer tok_console_export');
    expect(followed[0]).toBe(`${API_BASE_URL}/report-downloads/tok_once`);
  });

  it('sends the scoped salon from the echo', async () => {
    mount({ data: parse(raw({ salonId: 'SAL-AMARA', salonName: 'Amara' })) });
    fireEvent.click(headExport());
    await waitFor(() => expect(followed).toHaveLength(1));
    expect(calls[0]!.body).toEqual({ month: '2026-10', months: 3, salon: 'SAL-AMARA' });
  });

  it.each([
    ['revenue', 'revenue'],
    ['money', 'money'],
    ['salons', 'salons'],
    ['members', 'members'],
    ['leaderboard', 'leaderboard'],
    ['payment-mix', 'paymentMix'],
    ['bookings', 'bookings'],
    ['campaigns', 'campaigns'],
    ['support', 'support'],
    ['shop', 'shop'],
    ['busiest-times', 'busiestTimes'],
  ])('%s → section=%s', async (label, section) => {
    mount();
    fireEvent.click(cardExport(label)!);
    await waitFor(() => expect(followed).toHaveLength(1));
    expect(calls[0]!.body).toEqual({ month: '2026-10', months: 3, section });
  });

  it('every card section is one the server knows', () => {
    expect([...PLATFORM_ANALYTICS_SECTIONS].sort()).toEqual(
      ['revenue', 'money', 'salons', 'members', 'leaderboard', 'paymentMix', 'bookings', 'campaigns', 'support', 'shop', 'busiestTimes'].sort(),
    );
  });

  it('says "Preparing…" while the mint is in flight, and a second press mints nothing', async () => {
    let release!: (r: Response) => void;
    answer = () => new Promise<Response>((resolve) => (release = resolve));
    mount();
    fireEvent.click(cardExport('revenue')!);
    await waitFor(() => expect(cardExport('revenue')!.textContent).toBe(EXPORT_LABEL.pending));
    expect(cardExport('revenue')!.disabled).toBe(true);
    fireEvent.click(cardExport('revenue')!);
    release(await minted('/report-downloads/tok_once')());
    await waitFor(() => expect(followed).toHaveLength(1));
    expect(calls).toHaveLength(1);
  });

  it('offline: "No connection", disabled, nothing minted', () => {
    mount({ offline: true });
    expect(headExport().textContent).toBe(EXPORT_LABEL.offline);
    expect(headExport().disabled).toBe(true);
    expect(cardExport('revenue')!.disabled).toBe(true);
    fireEvent.click(cardExport('revenue')!);
    expect(calls).toHaveLength(0);
  });

  it('a stale grid whose refresh failed for want of a connection is offline too', () => {
    mount({ read: { error: new ApiError("We can't reach the workspace.", { status: 0, code: 'offline', offline: true }) } });
    expect(headExport().textContent).toBe(EXPORT_LABEL.offline);
  });

  it('a refusal is the server’s sentence, inside that card only', async () => {
    answer = async () =>
      new Response(JSON.stringify({ error: 'forbidden', message: 'This admin has no analytics section.' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      });
    mount();
    fireEvent.click(cardExport('shop')!);
    const alert = await within(card('shop')).findByRole('alert');
    expect(alert.textContent).toBe('This admin has no analytics section.');
    expect(within(card('revenue')).queryByRole('alert')).toBeNull();
    expect(followed).toHaveLength(0);
  });
});
