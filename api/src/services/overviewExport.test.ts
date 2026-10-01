/**
 * `services/overviewExport.ts` — the Overview's widgets rendered as a long-format CSV.
 * Pure: every spec here feeds the JSON answers in (`OverviewAnalytics`, `SalonMetrics`,
 * two `ReportResult`s) and reads strings out.
 * The route-level half (gates, tenancy, audit, the link) is `overviewExport.int.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import { fils } from '@avo/types';
import type { SalonMetrics } from './metrics';
import type { OverviewAnalytics } from './overviewAnalytics';
import { resolveWindow } from './period';
import { REPORT_PERMISSION, type ReportResult } from './reports';
import {
  ANALYTICS_SECTIONS,
  OVERVIEW_SECTIONS,
  TREND_DAYS,
  bpToPercent,
  kpiRows,
  revenueByBranchRows,
  salesTrendPeriod,
  salesTrendRows,
  type OverviewExportInput,
  overviewCsv,
  overviewDownloadKind,
  overviewExportAudit,
  overviewFilename,
  overviewRows,
  parseOverviewDownloadKind,
  parseOverviewSection,
  sectionRows,
} from './overviewExport';

const W = (permission: string | null, reason = 'permission') =>
  ({ status: 'withheld', reason, permission }) as never;

function fixture(): OverviewAnalytics {
  return {
    asOf: '2026-09-16T09:00:00.000Z',
    window: {
      token: '2026-09-01_2026-09-14',
      basis: 'calendar',
      from: '2026-08-31T21:00:00.000Z',
      to: '2026-09-14T21:00:00.000Z',
      days: 14,
      fromDate: '2026-09-01',
      toDate: '2026-09-14',
      timezone: 'Asia/Kuwait',
    },
    branchId: null,
    branchName: null,
    loyaltyMode: 'tiers',
    modules: { booking: true, shop: true },
    topServices: {
      status: 'ok',
      byBookings: [
        { serviceId: 'SV1', name: 'Cut', bookings: 3, revenueFils: fils(16000) },
        { serviceId: 'SV2', name: 'Colour', bookings: 2, revenueFils: fils(40000) },
      ],
      byRevenue: [
        { serviceId: 'SV2', name: 'Colour', bookings: 2, revenueFils: fils(40000) },
        { serviceId: 'SV1', name: 'Cut', bookings: 3, revenueFils: fils(16000) },
        { serviceId: 'SV3', name: 'Nails', bookings: 0, revenueFils: fils(5) },
      ],
      branchAssumed: null,
    },
    artists: {
      status: 'ok',
      items: [{ artistId: 'AR1', name: 'Rana', bookings: 2, noShows: 1, revenueFils: fils(59250) }],
      branchAssumed: null,
    },
    busiestTimes: {
      status: 'ok',
      cells: [
        { weekday: 3, hour: 21, visits: 4 },
        { weekday: 0, hour: 9, visits: 1 },
      ],
      totalVisits: 5,
      branchAssumed: null,
    },
    upcoming: {
      status: 'ok',
      today: 1,
      next7Days: 2,
      branchAssumed: null,
      next: {
        status: 'ok',
        items: [
          {
            bookingId: 'BK7',
            // 15:00Z is 18:00 in Kuwait.
            startsAt: '2026-09-16T15:00:00.000Z',
            customerName: 'سارة',
            memberId: 'M1',
            serviceName: 'Cut',
            artistName: 'Rana',
            branchId: 'B1',
            branchName: 'Salmiya',
            branchAssumed: true,
          },
        ],
      },
    },
    noShows: {
      status: 'ok',
      completed: 1,
      noShows: 1,
      rateBp: 5000,
      depositsHeld: { bookings: 2, fils: fils(4000) },
      branchAssumed: null,
    },
    newMembers: {
      status: 'ok',
      total: 3,
      weeks: [
        { weekStart: '2026-08-30', count: 1, partial: true },
        { weekStart: '2026-09-06', count: 2, partial: false },
      ],
    },
    visitors: { status: 'ok', total: 3, firstVisit: 2, returning: 1, branchAssumed: null },
    loyalty: {
      status: 'ok',
      mode: 'tiers',
      tiers: [
        { tier: 'gold', members: 1 },
        { tier: 'silver', members: 2 },
      ],
      untiered: 4,
    },
    wallet: {
      status: 'ok',
      loadedFils: fils(1_820_000),
      bonusFils: fils(1000),
      topups: 3,
      spentFils: fils(53000),
      liabilityFils: fils(17500),
    },
    paymentMix: {
      status: 'ok',
      topups: {
        knet: { count: 2, fils: fils(13500), shareBp: 7297 },
        card: { count: 1, fils: fils(5000), shareBp: 2703 },
        applepay: { count: 0, fils: fils(0), shareBp: 0 },
      },
      walletSpend: { count: 4, fils: fils(53000) },
    },
    shop: {
      status: 'ok',
      orders: 2,
      ordersByStatus: { preparing: 1, ready: 1, closed: 0 },
      topProducts: [{ productId: 'P1', name: '=HYPERLINK("x")', units: 3, revenueFils: fils(6000) }],
      revenueFils: fils(9000),
      branchAssumed: null,
    },
    campaigns: {
      status: 'ok',
      sent: 1,
      reached: 2,
      reach: 10,
      items: [
        {
          campaignId: 'C1',
          title: 'Autumn',
          audience: 'All',
          channel: 'push',
          sentAt: '2026-09-05T08:00:00.000Z',
          reached: 2,
          reach: 10,
          result: '2 reached',
        },
      ],
      truncated: false,
    },
  } as OverviewAnalytics;
}

const TZ = 'Asia/Kuwait';
const NOW = new Date('2026-10-02T09:00:00.000Z'); // 12:00 in Kuwait, 2 October

function metrics(over: Partial<SalonMetrics> = {}): SalonMetrics {
  return {
    activeMembers: 1284,
    activeMembersDelta: 48,
    loadedTodayFils: 312_500,
    knetSharePercent: 78,
    repeatRatePercent: 62,
    upcomingAppointments: 18,
    // 13:30Z is 16:30 in Kuwait.
    nextAppointmentAt: '2026-10-02T13:30:00.000Z',
    branchId: null,
    branchName: null,
    branchAssumed: null,
    ...over,
  };
}

function kpis(m: SalonMetrics = metrics()) {
  return {
    metrics: m,
    today: '2026-10-02',
    window: resolveWindow({ basis: 'rolling', preset: '30d' }, TZ, NOW),
    timezone: TZ,
  };
}

/** `reports/sales` over the trend window: per (day, branch), newest first, gaps. */
function salesReport(): ReportResult {
  const period = salesTrendPeriod(TZ, NOW);
  return {
    kind: 'sales',
    window: resolveWindow(period, TZ, NOW),
    rows: [
      { date: '2026-10-01', transactions: 2, grossFils: 12_000, branch: 'Salmiya', keptDepositsFils: 0 },
      { date: '2026-10-01', transactions: 1, grossFils: 500, branch: 'Kuwait City', keptDepositsFils: 3000 },
      { date: '2026-09-20', transactions: 1, grossFils: 7, branch: 'Salmiya', keptDepositsFils: 0 },
    ],
  } as unknown as ReportResult;
}

function earningsReport(): ReportResult {
  return {
    kind: 'earnings-by-branch',
    window: resolveWindow({ basis: 'rolling', preset: '30d' }, TZ, NOW),
    rows: [
      { branch: 'Kuwait City', transactions: 5, grossFils: 40_000, assumedGrossFils: 10_000, assumedTransactions: 1 },
      { branch: 'Salmiya', transactions: 0, grossFils: 0, assumedGrossFils: 0, assumedTransactions: 0 },
    ],
  } as unknown as ReportResult;
}

function input(a: OverviewAnalytics = fixture()): OverviewExportInput {
  return {
    analytics: a,
    kpis: kpis(),
    salesTrend: { block: { status: 'ok', report: salesReport() }, branchApplied: false },
    revenueByBranch: { status: 'ok', report: earningsReport() },
  };
}

const find = (rows: ReturnType<typeof overviewRows>, item: string, metric: string) =>
  rows.find((r) => r.item === item && r.metric === metric);

describe('sections', () => {
  it('the vocabulary is the three widgets, then the twelve JSON block keys, in Overview order', () => {
    expect(OVERVIEW_SECTIONS).toHaveLength(15);
    expect(OVERVIEW_SECTIONS.slice(0, 3)).toEqual(['kpis', 'salesTrend', 'revenueByBranch']);
    expect(OVERVIEW_SECTIONS.slice(3)).toEqual([...ANALYTICS_SECTIONS]);
    const a = fixture() as unknown as Record<string, unknown>;
    for (const s of ANALYTICS_SECTIONS) expect(a[s], s).toBeDefined();
  });

  it('absent is every section, a known key is that one, anything else is 400 invalid_section', () => {
    expect(parseOverviewSection(undefined)).toBeNull();
    expect(parseOverviewSection('')).toBeNull();
    expect(parseOverviewSection('topServices')).toBe('topServices');
    for (const s of ['kpis', 'salesTrend', 'revenueByBranch']) expect(parseOverviewSection(s)).toBe(s);
    for (const bad of ['revenue', 'TOPSERVICES', ['topServices', 'shop'], 7]) {
      expect(() => parseOverviewSection(bad)).toThrow(/section must be one of/);
    }
  });

  it('a download kind round-trips, and a Reports kind is not an overview', () => {
    expect(overviewDownloadKind(null)).toBe('overview');
    expect(overviewDownloadKind('shop')).toBe('overview:shop');
    for (const s of [null, ...OVERVIEW_SECTIONS]) {
      expect(parseOverviewDownloadKind(overviewDownloadKind(s))).toBe(s);
    }
    expect(parseOverviewDownloadKind('sales')).toBeUndefined();
    expect(parseOverviewDownloadKind('overviewx')).toBeUndefined();
    expect(() => parseOverviewDownloadKind('overview:bogus')).toThrow();
  });
});

describe('the rows', () => {
  const rows = overviewRows(input(), null);

  it('money is KD to three decimals, to the fil, with no thousands comma', () => {
    expect(find(rows, 'Rana', 'revenue')).toMatchObject({ section: 'Artist performance', value: '59.250', unit: 'KD' });
    expect(find(rows, 'Nails', 'revenue')?.value).toBe('0.005');
    expect(rows.find((r) => r.section === 'Wallet loaded vs spent' && r.metric === 'loaded')?.value).toBe('1820.000');
  });

  it('shares are percent to two decimals, from basis points by integer division', () => {
    expect(find(rows, '', 'no-show rate')).toMatchObject({ section: 'No-shows and deposits', value: '50.00', unit: '%' });
    expect(find(rows, 'KNET', 'share of top-up value')?.value).toBe('72.97');
    expect(find(rows, 'Apple Pay', 'share of top-up value')?.value).toBe('0.00');
    expect(bpToPercent(10000)).toBe('100.00');
    expect(bpToPercent(1)).toBe('0.01');
    expect(bpToPercent(null)).toBe('');
    expect(() => bpToPercent(12.5)).toThrow();
  });

  it("busiest times are the wire's salon-local weekday and hour", () => {
    expect(find(rows, 'Wed 21:00', 'visits')).toMatchObject({ section: 'Busiest times', value: '4', unit: 'count' });
    expect(find(rows, 'Sun 09:00', 'visits')?.value).toBe('1');
  });

  it("upcoming renders the instant in the salon's clock and keeps the customer's name", () => {
    expect(find(rows, '2026-09-16 18:00', 'customer')).toMatchObject({ section: 'Upcoming', value: 'سارة' });
    expect(find(rows, '2026-09-16 18:00', 'branch inferred')?.value).toBe('yes');
    // No internal ids anywhere in the file.
    expect(rows.some((r) => /\b(BK7|M1|SV1|AR1|C1|P1)\b/.test(r.value + r.item))).toBe(false);
  });

  it('a service in both rankings is one item carrying both ranks', () => {
    const cut = rows.filter((r) => r.item === 'Cut' && r.section === 'Top services');
    expect(find(rows, '', 'services ranked')?.value).toBe('3');
    expect(cut.map((r) => [r.metric, r.value])).toEqual([
      ['bookings', '3'],
      ['revenue', '16.000'],
      ['rank by bookings', '1'],
      ['rank by revenue', '2'],
    ]);
    expect(find(rows, 'Nails', 'rank by bookings')).toBeUndefined();
    expect(find(rows, 'Nails', 'rank by revenue')?.value).toBe('3');
  });

  it('the sections come out in the Overview order', () => {
    const order = [...new Set(rows.map((r) => r.section))];
    expect(order).toEqual([
      'KPIs', 'Gross by day', 'Revenue by branch',
      'Top services', 'Artist performance', 'Busiest times', 'Upcoming', 'No-shows and deposits',
      'New members', 'First visit vs returning', 'Members by tier', 'Wallet loaded vs spent',
      'Payment mix', 'Shop orders', 'Campaigns',
    ]);
  });

  it('branchAssumed becomes two rows only when a branch was applied', () => {
    expect(rows.some((r) => r.metric === 'rows with branch inferred')).toBe(false);
    const a = fixture();
    (a.visitors as { branchAssumed: unknown }).branchAssumed = { assumed: 1, total: 3 };
    const v = sectionRows(a, 'visitors');
    expect(find(v, '', 'rows with branch inferred')?.value).toBe('1');
    expect(find(v, '', 'rows considered')?.value).toBe('3');
  });

  it('a float reaching a money cell throws rather than prints', () => {
    const a = fixture();
    (a.wallet as { loadedFils: number }).loadedFils = 18.5;
    expect(() => sectionRows(a, 'wallet')).toThrow(/integer number of fils/);
  });
});

describe('a withheld block is one row naming the reason', () => {
  it('permission, not_per_branch and module_off — each one row, none dropped', () => {
    const a = fixture();
    a.campaigns = W('marketing');
    a.wallet = W(null, 'not_per_branch');
    a.shop = W(null, 'module_off');
    a.upcoming.next = W('appointments');
    a.loyalty = W(null, 'not_per_branch');

    expect(sectionRows(a, 'campaigns')).toEqual([
      { section: 'Campaigns', item: '', metric: 'withheld', value: 'permission: marketing', unit: '' },
    ]);
    expect(sectionRows(a, 'wallet')).toEqual([
      { section: 'Wallet loaded vs spent', item: '', metric: 'withheld', value: 'not_per_branch', unit: '' },
    ]);
    expect(sectionRows(a, 'shop')).toEqual([
      { section: 'Shop orders', item: '', metric: 'withheld', value: 'module_off', unit: '' },
    ]);
    // Titled from the salon's mode even while withheld.
    expect(sectionRows(a, 'loyalty')[0]?.section).toBe('Members by tier');
    // Upcoming still serves its counts beside the withheld names.
    const up = sectionRows(a, 'upcoming');
    expect(up.map((r) => r.metric)).toEqual(['today', 'next 7 days', 'withheld']);
    expect(up[2]).toMatchObject({ item: 'Next appointments', value: 'permission: appointments' });
    expect(up.some((r) => r.value === 'سارة')).toBe(false);
  });

  it('every one of the twelve withheld still yields exactly one row per section', () => {
    const a = fixture() as unknown as Record<string, unknown>;
    for (const s of ANALYTICS_SECTIONS) if (s !== 'upcoming') a[s] = W('dashboard');
    const rows = overviewRows({ ...input(), analytics: a as unknown as OverviewAnalytics }, null)
      .filter((r) => !['KPIs', 'Gross by day', 'Revenue by branch'].includes(r.section));
    expect(new Set(rows.map((r) => r.section)).size).toBe(12);
    expect(rows.filter((r) => r.metric === 'withheld')).toHaveLength(11);
  });
});

describe('no section is ever absent', () => {
  it('an answer with every list empty still gives each of the twelve at least one row', () => {
    const a = fixture();
    Object.assign(a.topServices, { byBookings: [], byRevenue: [] });
    Object.assign(a.artists, { items: [] });
    Object.assign(a.busiestTimes, { cells: [], totalVisits: 0 });
    Object.assign(a.upcoming.next, { items: [] });
    Object.assign(a.newMembers, { weeks: [], total: 0 });
    Object.assign(a.loyalty, { tiers: [], untiered: 0 });
    Object.assign(a.shop, { topProducts: [] });
    Object.assign(a.campaigns, { items: [], sent: 0, reached: 0, reach: 0 });
    for (const s of ANALYTICS_SECTIONS) expect(sectionRows(a, s).length, s).toBeGreaterThan(0);
    expect(find(sectionRows(a, 'topServices'), '', 'services ranked')?.value).toBe('0');
    expect(find(sectionRows(a, 'artists'), '', 'artists')?.value).toBe('0');
  });
});

describe('the file', () => {
  it('BOM, quoted header, CRLF records, no trailing newline, formulas neutralised', () => {
    const csv = overviewCsv(overviewRows(input(), 'shop'));
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const lines = csv.slice(1).split('\r\n');
    expect(lines[0]).toBe('"section","item","metric","value","unit"');
    expect(csv.endsWith('\r\n')).toBe(false);
    expect(lines).toContain(`"Shop orders","'=HYPERLINK(""x"")","units","3","count"`);
  });

  it('one section is one block', () => {
    const rows = overviewRows(input(), 'busiestTimes');
    expect(new Set(rows.map((r) => r.section))).toEqual(new Set(['Busiest times']));
  });

  it('filenames: Reports naming, section appended', () => {
    const p30 = { basis: 'rolling', preset: '30d' } as const;
    const range = { basis: 'calendar', from: { year: 2026, month: 9, day: 1 }, to: { year: 2026, month: 9, day: 14 } } as const;
    expect(overviewFilename(null, p30, null)).toBe('overview_all-branches_30d.csv');
    expect(overviewFilename('Kuwait City', range, 'topServices')).toBe(
      'overview_kuwait-city_2026-09-01_2026-09-14_topServices.csv',
    );
    expect(overviewFilename('x"; rm -rf', p30, null)).toBe('overview_x-rm--rf_30d.csv');
    expect(overviewFilename('السالمية', p30, null)).toBe('overview_branch_30d.csv');
  });
});

describe('the audit row', () => {
  it('records the act and its shape, and no figure but the row count', () => {
    const row = overviewExportAudit({
      salonId: 'SAL-AMARA',
      section: 'topServices',
      branchId: null,
      window: { token: '30d', basis: 'rolling' },
      rowCount: 7,
      via: 'csv',
    });
    expect(row).toMatchObject({
      kind: 'access',
      action: 'Report exported',
      subjectType: 'report',
      subjectId: 'overview',
      metadata: { kind: 'overview', section: 'topServices', branchId: null, period: '30d', periodBasis: 'rolling', rowCount: 7, via: 'csv' },
    });
    expect(row).not.toHaveProperty('amountFils');
    const numbers = JSON.stringify(row.metadata).match(/\d+/g) ?? [];
    // `30` of the 30d token and the count — nothing else.
    expect(numbers.sort()).toEqual(['30', '7']);
  });
});

// ====================================================== the three widgets ==

describe('kpis — the four tiles, each on its own time basis', () => {
  it('names the period and the salon-local today, and labels each tile as the Overview does', () => {
    const rows = kpiRows(kpis());
    expect(rows.map((r) => [r.item, r.metric, r.value, r.unit])).toEqual([
      ['', 'period', 'last 30 days (rolling)', ''],
      ['', 'today (salon clock)', '2026-10-02', ''],
      ['Active members', 'active in period', '1284', 'count'],
      ['Active members', 'change vs same period a week earlier', '48', 'count'],
      ['Loaded today', 'loaded today', '312.500', 'KD'],
      ['Loaded today', 'KNET share of loaded today', '78', '%'],
      ['Repeat rate', 'repeat rate in period', '62', '%'],
      ['Upcoming today', 'still to start today', '18', 'count'],
      ['Upcoming today', 'next at (salon clock)', '2026-10-02 16:30', ''],
    ]);
    expect(new Set(rows.map((r) => r.section))).toEqual(new Set(['KPIs']));
  });

  it('a calendar period is named by its dates', () => {
    const k = kpis();
    k.window = resolveWindow(
      { basis: 'calendar', from: { year: 2026, month: 9, day: 1 }, to: { year: 2026, month: 9, day: 14 } },
      TZ,
      NOW,
    );
    expect(find(kpiRows(k), '', 'period')?.value).toBe('2026-09-01 to 2026-09-14 (salon clock)');
  });

  it('with a branch, Loaded today is ONE withheld row — not_per_branch — and the caveat is counted', () => {
    const rows = kpiRows(
      kpis(
        metrics({
          loadedTodayFils: null,
          knetSharePercent: null,
          branchId: 'BR-SAL',
          branchName: 'Salmiya',
          activeMembers: 2,
          upcomingAppointments: 5,
          branchAssumed: { activeMembers: 2, visits: 1, visitsTotal: 9, upcomingAppointments: 0 },
        }),
      ),
    );
    expect(rows.filter((r) => r.item === 'Loaded today')).toEqual([
      { section: 'KPIs', item: 'Loaded today', metric: 'withheld', value: 'not_per_branch', unit: '' },
    ]);
    expect(find(rows, 'Active members', 'members counted only on rows with branch inferred')?.value).toBe('2');
    expect(find(rows, 'Repeat rate', 'visits with branch inferred')?.value).toBe('1');
    expect(find(rows, 'Repeat rate', 'visits considered')?.value).toBe('9');
    expect(find(rows, 'Upcoming today', 'appointments with branch inferred')?.value).toBe('0');
    // The card's own sentence, with the zero clause left out as the card leaves it.
    expect(find(rows, '', 'note')?.value).toBe(
      'Branch assumed on 2 of 2 members and 1 of 9 visits — treat these branch figures as approximate.',
    );
  });

  it('no note when every assumed count is zero, and no caveat rows at all-branches', () => {
    const exact = kpiRows(
      kpis(metrics({ loadedTodayFils: null, knetSharePercent: null, branchId: 'B', branchName: 'B',
        branchAssumed: { activeMembers: 0, visits: 0, visitsTotal: 4, upcomingAppointments: 0 } })),
    );
    expect(find(exact, '', 'note')).toBeUndefined();
    expect(kpiRows(kpis()).some((r) => /inferred/.test(r.metric))).toBe(false);
  });

  it('the delta is signed and survives the formula guard as a number', () => {
    const rows = kpiRows(kpis(metrics({ activeMembersDelta: -3 })));
    expect(find(rows, 'Active members', 'change vs same period a week earlier')?.value).toBe('-3');
    expect(overviewCsv(rows)).toContain('"KPIs","Active members","change vs same period a week earlier","-3","count"');
  });

  it('no "next at" row when nothing is still to start', () => {
    const rows = kpiRows(kpis(metrics({ upcomingAppointments: 0, nextAppointmentAt: null })));
    expect(find(rows, 'Upcoming today', 'next at (salon clock)')).toBeUndefined();
    expect(find(rows, 'Upcoming today', 'still to start today')?.value).toBe('0');
  });

  it('a float in loaded today throws rather than prints', () => {
    expect(() => kpiRows(kpis(metrics({ loadedTodayFils: 312.5 })))).toThrow(/integer number of fils/);
  });
});

describe('salesTrend — Gross by day, its own fourteen days at all branches', () => {
  it('the window is the chart’s: fourteen complete salon-local days ending yesterday', () => {
    const p = salesTrendPeriod(TZ, NOW);
    expect(p).toEqual({ basis: 'calendar', from: { year: 2026, month: 9, day: 18 }, to: { year: 2026, month: 10, day: 1 } });
    // 22:30Z on 1 Oct is already 2 Oct in Kuwait, so yesterday is 1 Oct there.
    expect(salesTrendPeriod(TZ, new Date('2026-10-01T22:30:00.000Z')).to).toEqual({ year: 2026, month: 10, day: 1 });
    expect(TREND_DAYS).toBe(14);
  });

  it('states the window and the scope, then one gross and one count per day, oldest first, gaps as zero', () => {
    const rows = salesTrendRows({ block: { status: 'ok', report: salesReport() }, branchApplied: false });
    expect(rows.slice(0, 2).map((r) => [r.metric, r.value])).toEqual([
      ['window', '2026-09-18 to 2026-10-01 (14 complete days, salon clock)'],
      ['branches', 'All branches'],
    ]);
    const days = rows.filter((r) => r.metric === 'gross');
    expect(days).toHaveLength(14);
    expect(days[0]?.item).toBe('2026-09-18');
    expect(days[13]?.item).toBe('2026-10-01');
    // Two branch rows for one day fold to one day; kept deposits are not the bar.
    expect(find(rows, '2026-10-01', 'gross')?.value).toBe('12.500');
    expect(find(rows, '2026-10-01', 'transactions')?.value).toBe('3');
    expect(find(rows, '2026-09-20', 'gross')?.value).toBe('0.007');
    expect(find(rows, '2026-09-19', 'gross')?.value).toBe('0.000');
    expect(rows.some((r) => r.metric === 'note')).toBe(false);
  });

  it('with a branch applied elsewhere in the file, a note says this chart is wider', () => {
    const rows = salesTrendRows({ block: { status: 'ok', report: salesReport() }, branchApplied: true });
    expect(find(rows, '', 'branches')?.value).toBe('All branches');
    expect(find(rows, '', 'note')?.value).toBe('This chart covers all branches. The branch filter does not narrow it.');
  });

  it('withheld is one row', () => {
    expect(salesTrendRows({ block: W('dashboard'), branchApplied: false })).toEqual([
      { section: 'Gross by day', item: '', metric: 'withheld', value: 'permission: dashboard', unit: '' },
    ]);
  });
});

describe('revenueByBranch — the card’s rows and its caveat', () => {
  it('every branch, in the report’s order, with the assumed money beside the gross', () => {
    const rows = revenueByBranchRows({ status: 'ok', report: earningsReport() });
    expect(rows.map((r) => [r.item, r.metric, r.value, r.unit])).toEqual([
      ['', 'branches', '2', 'count'],
      ['Kuwait City', 'gross', '40.000', 'KD'],
      ['Kuwait City', 'transactions', '5', 'count'],
      ['Kuwait City', 'gross with branch assumed', '10.000', 'KD'],
      ['Kuwait City', 'transactions with branch assumed', '1', 'count'],
      ['Salmiya', 'gross', '0.000', 'KD'],
      ['Salmiya', 'transactions', '0', 'count'],
      ['Salmiya', 'gross with branch assumed', '0.000', 'KD'],
      ['Salmiya', 'transactions with branch assumed', '0', 'count'],
      ['', 'note', 'Branch assumed on Kuwait City — treat these branch figures as approximate.', ''],
    ]);
  });

  it('the gate is the card’s: both reports are dashboard-gated, as the Overview is', () => {
    expect(REPORT_PERMISSION.sales).toBe('dashboard');
    expect(REPORT_PERMISSION['earnings-by-branch']).toBe('dashboard');
  });

  it('a float in a report cell throws rather than prints', () => {
    const r = earningsReport();
    (r.rows[0] as Record<string, unknown>).grossFils = 40.5;
    expect(() => revenueByBranchRows({ status: 'ok', report: r })).toThrow(/integer number of fils/);
  });
});

describe('a section reads only the part it needs', () => {
  it('section=kpis renders from the metrics alone; a missing part for a wanted section throws', () => {
    expect(overviewRows({ kpis: kpis() }, 'kpis').length).toBeGreaterThan(0);
    expect(() => overviewRows({ kpis: kpis() }, null)).toThrow(/was not loaded/);
  });
});
