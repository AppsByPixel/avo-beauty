// @vitest-environment jsdom

/**
 * MERCHANT → OVERVIEW → ANALYTICS → EXPORT, DRIVEN.
 *
 * Aftab, 2026-10-02: "want export option to get the valuable widget info they
 * are giving on the dashboard". The head's Export takes every block; each card's
 * quiet Export takes its own `section`. Both mint a one-time link and follow it
 * with a plain anchor (`api/download.ts`), so what is asserted here is the
 * REQUEST that left — read off the `fetch` mock — and the HREF the anchor was
 * handed, not a function's arguments: a test of the arguments would pass with
 * the wrong URL built underneath.
 *
 * The grid is driven through `analyticsExporter`, the same wiring the host
 * mounts, with the session mocked rather than written into storage (the
 * `reportsWindow.test.tsx` reason). Cleanup is manual — no `globals` here.
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OverviewAnalyticsSchema, type OverviewAnalytics } from '@avo/types';
import { ApiError } from '../api/client.js';
import type { Report } from '../api/reports.js';
import { API_BASE_URL } from '../config.js';

vi.mock('../auth/AuthProvider.js', () => ({ useSalonId: () => 'SAL-AMARA' }));
vi.mock('../auth/session.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../auth/session.js')>()),
  readSession: () => ({ accessToken: 'tok_test_export' }) as never,
}));

const { AnalyticsGrid, analyticsExporter, EXPORT_LABEL } = await import('./OverviewAnalytics.js');
type GridProps = Parameters<typeof AnalyticsGrid>[0];

/* ------------------------------------------------------------- fixtures -- */

const WINDOW = {
  token: '30d',
  basis: 'rolling' as const,
  from: '2026-09-02T09:00:00.000Z',
  to: '2026-10-02T09:00:00.000Z',
  days: 30,
  fromDate: null,
  toDate: null,
  timezone: 'Asia/Kuwait',
};

/** Every block `ok` and empty — the export does not care what a card draws. */
const RAW = {
  asOf: '2026-10-02T09:00:00.000Z',
  window: WINDOW,
  branchId: 'BR-SALMIYA',
  branchName: 'Salmiya',
  loyaltyMode: 'tiers',
  modules: { booking: true, shop: true },
  topServices: { status: 'ok', byBookings: [], byRevenue: [], branchAssumed: null },
  artists: { status: 'ok', items: [], branchAssumed: null },
  busiestTimes: { status: 'ok', cells: [], totalVisits: 0, branchAssumed: null },
  upcoming: {
    status: 'ok',
    today: 0,
    next7Days: 0,
    branchAssumed: null,
    next: { status: 'ok', items: [] },
  },
  noShows: {
    status: 'ok',
    completed: 0,
    noShows: 0,
    rateBp: null,
    depositsHeld: { bookings: 0, fils: 0 },
    branchAssumed: null,
  },
  newMembers: { status: 'ok', total: 0, weeks: [] },
  visitors: { status: 'ok', total: 0, firstVisit: 0, returning: 0, branchAssumed: null },
  loyalty: { status: 'ok', mode: 'tiers', tiers: [], untiered: 0 },
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
};

const parse = (raw: unknown): OverviewAnalytics => OverviewAnalyticsSchema.parse(raw);
const DATA = parse(RAW);

const REPORT: Report = {
  kind: 'earnings-by-branch',
  title: 'Earnings by branch',
  period: '30d',
  window: WINDOW,
  comparison: null,
  branchId: 'BR-SALMIYA',
  columns: [],
  rows: [{ branch: 'Salmiya', transactions: 3, grossFils: 20001, assumedGrossFils: 0, assumedTransactions: 0 }],
  stat: { key: 'grossFils', label: 'KD gross', value: 20001, type: 'money' },
  rowCount: 1,
};

function read<T>(data: T | undefined, over: Partial<GridProps['analytics']> = {}) {
  return { data, pending: false, error: null, onRetry: vi.fn(), retrying: false, ...over };
}

function mount(
  opts: {
    data?: OverviewAnalytics | undefined;
    analytics?: Partial<GridProps['analytics']>;
    offline?: boolean;
    exporter?: boolean;
  } = {},
) {
  /* `'data' in opts`, not a default: `data: undefined` is the pending/failed grid, and a default would replace it. */
  const data = 'data' in opts ? opts.data : DATA;
  const { analytics = {}, offline = false, exporter = true } = opts;
  return render(
    <AnalyticsGrid
      analytics={read(data, analytics) as GridProps['analytics']}
      earnings={read(REPORT) as GridProps['earnings']}
      timezone="Asia/Kuwait"
      modulesHint={{ booking: true, shop: true }}
      updatedAt={Date.parse('2026-10-02T09:00:00Z')}
      {...(exporter ? { exporter: analyticsExporter('SAL-AMARA', offline) } : {})}
    />,
  );
}

const card = (label: string) => document.querySelector(`[data-widget="${label}"]`) as HTMLElement;
const headExport = () => screen.getByRole('button', { name: /all analytics$/ }) as HTMLButtonElement;
const cardExport = (label: string) =>
  card(label).querySelector('.ovw__export') as HTMLButtonElement | null;

/* -------------------------------------------------- the network, recorded -- */

type Call = { url: string; method: string; body: unknown; auth: string | null };
let calls: Call[];
let followed: string[];
let answer: () => Promise<Response>;

const minted = (url: string) => async () =>
  new Response(JSON.stringify({ url, expiresAt: '2026-10-02T09:01:00.000Z' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

beforeEach(() => {
  calls = [];
  followed = [];
  answer = minted('/overview-downloads/tok_once');
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
  /* The anchor's half: record where it was pointed instead of letting jsdom navigate. */
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    followed.push(this.href);
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/* ------------------------------------------------------------------- tests -- */

describe('the head’s Export takes every block, for the scope on screen', () => {
  it('mints with the branch and period the grid shows, no section, then follows the link', async () => {
    mount();
    expect(headExport().textContent).toBe('Export');
    fireEvent.click(headExport());
    await waitFor(() => expect(followed).toHaveLength(1));

    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url).toBe(`${API_BASE_URL}/v1/salons/SAL-AMARA/overview/analytics/download-url`);
    /* "Absent means all" — omitted, not sent as null. */
    expect(calls[0]!.body).toEqual({ branch: 'BR-SALMIYA', period: '30d' });
    expect(calls[0]!.auth).toBe('Bearer tok_test_export');
    /* The relative path, on the API's origin — and nothing else was fetched. */
    expect(followed[0]).toBe(`${API_BASE_URL}/overview-downloads/tok_once`);
  });

  it('sends all branches as `all` when the grid is salon-wide', async () => {
    mount({ data: parse({ ...RAW, branchId: null, branchName: null }) });
    fireEvent.click(headExport());
    await waitFor(() => expect(followed).toHaveLength(1));
    expect(calls[0]!.body).toEqual({ branch: 'all', period: '30d' });
  });

  it('is disabled until the grid has something to export', () => {
    mount({ data: undefined, analytics: { pending: true } });
    expect(headExport().disabled).toBe(true);
  });
});

describe('a card’s Export takes its own section', () => {
  it('mints with the card’s section and the same scope', async () => {
    mount();
    fireEvent.click(cardExport('top-services')!);
    await waitFor(() => expect(followed).toHaveLength(1));
    expect(calls[0]!.body).toEqual({ branch: 'BR-SALMIYA', period: '30d', section: 'topServices' });
  });

  it.each([
    ['artists', 'artists'],
    ['busiest-times', 'busiestTimes'],
    ['upcoming', 'upcoming'],
    ['no-shows', 'noShows'],
    ['new-members', 'newMembers'],
    ['visitors', 'visitors'],
    ['loyalty', 'loyalty'],
    ['wallet', 'wallet'],
    ['payment-mix', 'paymentMix'],
    ['shop', 'shop'],
    ['campaigns', 'campaigns'],
  ])('%s → section=%s', async (label, section) => {
    mount();
    fireEvent.click(cardExport(label)!);
    await waitFor(() => expect(followed).toHaveLength(1));
    expect((calls[0]!.body as { section: string }).section).toBe(section);
  });

  it('revenue by branch is the earnings report, through that report’s own mint', async () => {
    answer = minted('/report-downloads/tok_report');
    mount();
    fireEvent.click(cardExport('revenue-by-branch')!);
    await waitFor(() => expect(followed).toHaveLength(1));
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe('/salons/SAL-AMARA/reports/earnings-by-branch/download-url');
    expect(url.searchParams.get('branch')).toBe('BR-SALMIYA');
    expect(url.searchParams.get('period')).toBe('30d');
    expect(url.searchParams.get('compare')).toBeNull();
    expect(followed[0]).toBe(`${API_BASE_URL}/report-downloads/tok_report`);
  });

  it('names its card for a screen reader, beside the visible "Export"', () => {
    mount();
    expect(screen.getByRole('button', { name: 'Export Top services' })).toBeTruthy();
  });
});

describe('a refusal is the server’s sentence, inline and verbatim', () => {
  const SENTENCE = 'You don’t have access to the dashboard. Ask the salon owner to turn it on under Accounts.';

  it('on the head', async () => {
    answer = async () =>
      new Response(JSON.stringify({ error: 'forbidden', message: SENTENCE }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      });
    mount();
    fireEvent.click(headExport());
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(SENTENCE);
    expect(followed).toHaveLength(0);
    /* Not stuck: the control is back, so she can try again once it is granted. */
    expect(headExport().disabled).toBe(false);
    expect(headExport().textContent).toBe('Export');
  });

  it('on a card, inside that card only', async () => {
    answer = async () =>
      new Response(JSON.stringify({ error: 'invalid_section', message: 'No such section: topServices.' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    mount();
    fireEvent.click(cardExport('top-services')!);
    const alert = await within(card('top-services')).findByRole('alert');
    expect(alert.textContent).toBe('No such section: topServices.');
    expect(within(card('artists')).queryByRole('alert')).toBeNull();
  });

  it('refuses to follow a link to another origin', async () => {
    answer = minted('https://elsewhere.example/steal');
    mount();
    fireEvent.click(headExport());
    await screen.findByRole('alert');
    expect(followed).toHaveLength(0);
  });
});

describe('pending disables the control', () => {
  it('says "Preparing…", is disabled, and a second press mints nothing', async () => {
    let release!: (r: Response) => void;
    answer = () => new Promise<Response>((resolve) => (release = resolve));
    mount();
    fireEvent.click(headExport());
    await waitFor(() => expect(headExport().disabled).toBe(true));
    expect(headExport().textContent).toBe(EXPORT_LABEL.pending);
    expect(EXPORT_LABEL.pending).toBe('Preparing…');
    fireEvent.click(headExport());
    expect(calls).toHaveLength(1);

    release(await minted('/overview-downloads/tok_once')());
    await waitFor(() => expect(headExport().disabled).toBe(false));
    expect(followed).toHaveLength(1);
  });

  it('a card’s pending is its own — the head and the other cards stay ready', async () => {
    answer = () => new Promise<Response>(() => {});
    mount();
    fireEvent.click(cardExport('wallet')!);
    await waitFor(() => expect(cardExport('wallet')!.disabled).toBe(true));
    expect(cardExport('wallet')!.textContent).toBe('Preparing…');
    expect(cardExport('shop')!.disabled).toBe(false);
    expect(headExport().disabled).toBe(false);
  });
});

describe('no control on a withheld card', () => {
  it('permission: the card stays, its Export does not', () => {
    mount({
      data: parse({ ...RAW, topServices: { status: 'withheld', reason: 'permission', permission: 'appointments' } }),
    });
    expect(card('top-services')).toBeTruthy();
    expect(cardExport('top-services')).toBeNull();
    expect(cardExport('artists')).not.toBeNull();
  });

  it('not_per_branch: the salon-wide cards under a branch have none', () => {
    const salonWide = { status: 'withheld', reason: 'not_per_branch', permission: null };
    mount({ data: parse({ ...RAW, wallet: salonWide, loyalty: salonWide }) });
    expect(cardExport('wallet')).toBeNull();
    expect(cardExport('loyalty')).toBeNull();
    expect(cardExport('visitors')).not.toBeNull();
  });

  it('pending or failed: no card has one', () => {
    mount({ data: undefined, analytics: { pending: true } });
    expect(document.querySelectorAll('.ovw-grid .ovw__export')).toHaveLength(1); // the report card's own read
    cleanup();
    mount({ data: undefined, analytics: { error: new ApiError('down', { status: 500, code: 'x' }) } });
    expect(document.querySelectorAll('[data-widget]:not([data-widget="revenue-by-branch"]) .ovw__export')).toHaveLength(0);
  });

  it('a grid drawn without an exporter draws no controls at all', () => {
    mount({ exporter: false });
    expect(document.querySelectorAll('.ovw__export, .ovw-head__export')).toHaveLength(0);
  });
});

describe('offline: disabled, in the house’s offline words', () => {
  it('the browser says offline', () => {
    mount({ offline: true });
    expect(headExport().disabled).toBe(true);
    expect(headExport().textContent).toBe('No connection');
    expect(cardExport('top-services')!.disabled).toBe(true);
    expect(cardExport('top-services')!.textContent).toBe('No connection');
  });

  it('the last read failed for want of a connection, with figures still on screen', () => {
    mount({ analytics: { error: new ApiError('No connection to the workspace.', { status: 0, code: 'network_error', offline: true }) } });
    expect(headExport().disabled).toBe(true);
    expect(headExport().textContent).toBe('No connection');
  });
});
