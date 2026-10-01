/**
 * `services/overviewExport.ts` — the Overview's JSON rendered as a long-format CSV.
 * Pure: every spec here feeds an `OverviewAnalytics` object in and reads strings out.
 * The route-level half (gates, tenancy, audit, the link) is `overviewExport.int.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import { fils } from '@avo/types';
import type { OverviewAnalytics } from './overviewAnalytics';
import {
  OVERVIEW_SECTIONS,
  bpToPercent,
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

const find = (rows: ReturnType<typeof overviewRows>, item: string, metric: string) =>
  rows.find((r) => r.item === item && r.metric === metric);

describe('sections', () => {
  it('the vocabulary is the twelve JSON block keys', () => {
    expect(OVERVIEW_SECTIONS).toHaveLength(12);
    const a = fixture() as unknown as Record<string, unknown>;
    for (const s of OVERVIEW_SECTIONS) expect(a[s], s).toBeDefined();
  });

  it('absent is every section, a known key is that one, anything else is 400 invalid_section', () => {
    expect(parseOverviewSection(undefined)).toBeNull();
    expect(parseOverviewSection('')).toBeNull();
    expect(parseOverviewSection('topServices')).toBe('topServices');
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
  const rows = overviewRows(fixture(), null);

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
    for (const s of OVERVIEW_SECTIONS) if (s !== 'upcoming') a[s] = W('dashboard');
    const rows = overviewRows(a as unknown as OverviewAnalytics, null);
    expect(new Set(rows.map((r) => r.section)).size).toBe(12);
  });
});

describe('the file', () => {
  it('BOM, quoted header, CRLF records, no trailing newline, formulas neutralised', () => {
    const csv = overviewCsv(overviewRows(fixture(), 'shop'));
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const lines = csv.slice(1).split('\r\n');
    expect(lines[0]).toBe('"section","item","metric","value","unit"');
    expect(csv.endsWith('\r\n')).toBe(false);
    expect(lines).toContain(`"Shop orders","'=HYPERLINK(""x"")","units","3","count"`);
  });

  it('one section is one block', () => {
    const rows = overviewRows(fixture(), 'busiestTimes');
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
