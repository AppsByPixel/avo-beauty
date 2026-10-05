/**
 * `services/platformAnalyticsExport.ts` — the console's analytics as a long-format
 * CSV. Pure: a `PlatformAnalytics` in, strings out. The route half (gates, the
 * link, the audit row, reconciliation against the JSON) is
 * `routes/platformAnalytics.int.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import { PlatformAnalyticsSchema, fils } from '@avo/types';
import type { PlatformAnalytics } from './platformAnalytics';
import {
  PLATFORM_ANALYTICS_SECTIONS,
  PLATFORM_SECTION_TITLE,
  SCOPE_TITLE,
  parsePlatformDownloadKind,
  parsePlatformPeriodToken,
  parsePlatformSection,
  platformCsv,
  platformDownloadKind,
  platformExportAudit,
  platformFilename,
  platformPeriodToken,
  platformRows,
  platformSectionRows,
} from './platformAnalyticsExport';

const M = (feeFils: number) => ({
  month: '2026-09',
  feeFils: fils(feeFils),
  topups: 2,
  byMethod: {
    knet: { topups: 1, feeFils: fils(150) },
    card: { topups: 1, feeFils: fils(feeFils - 150) },
    applepay: { topups: 0, feeFils: fils(0) },
  },
});

function fixture(): PlatformAnalytics {
  return {
    asOf: '2026-10-05T07:00:00.000Z',
    timezone: 'Asia/Kuwait',
    month: '2026-09',
    partial: false,
    months: ['2026-09'],
    salonId: null,
    salonName: null,
    revenue: {
      status: 'ok',
      months: [M(825)],
      thisMonthFils: fils(825),
      priorMonth: '2026-08',
      priorMonthFils: fils(150),
    },
    money: {
      status: 'ok',
      months: [{ month: '2026-09', loadedFils: fils(45000), bonusFils: fils(2500), spentFils: fils(18250) }],
      liabilityFils: fils(29250),
      liabilityBySalon: [
        { salonId: 'SAL-A', name: 'Amara', liabilityFils: fils(29250) },
        { salonId: 'SAL-B', name: '=HYPERLINK("x")', liabilityFils: fils(0) },
      ],
    },
    salons: {
      status: 'ok',
      total: 2,
      byPlan: { starter: 1, growth: 1, pro: 0 },
      branches: { open: 3, closed: 1 },
      months: [{ month: '2026-09', newSalons: 1, active: 1, dormant: 1 }],
    },
    members: {
      status: 'ok',
      total: 5,
      months: [{ month: '2026-09', newMembers: 2, activeMembers: 3 }],
      tiers: { salons: 1, bronze: 2, silver: 1, gold: 0, black: 0, untiered: 1 },
      stamps: { salons: 1, buckets: [{ stampTarget: 6, stamps: 4, members: 1 }] },
    },
    leaderboard: {
      status: 'ok',
      rows: [
        {
          salonId: 'SAL-A',
          name: 'Amara',
          modules: { booking: true, shop: true },
          members: 4,
          activeMembers: 3,
          loadedFils: fils(45000),
          spentFils: fils(18250),
          avoRevenueFils: fils(825),
          bookings: 3,
          noShowRateBp: 3333,
          shopRevenueFils: fils(4000),
          liabilityFils: fils(29250),
        },
        {
          salonId: 'SAL-B',
          name: 'Bloom',
          modules: { booking: false, shop: false },
          members: 1,
          activeMembers: 0,
          loadedFils: fils(0),
          spentFils: fils(0),
          avoRevenueFils: fils(0),
          bookings: null,
          noShowRateBp: null,
          shopRevenueFils: null,
          liabilityFils: fils(0),
        },
      ],
    },
    paymentMix: {
      status: 'ok',
      topups: 2,
      loadedFils: fils(45000),
      methods: {
        knet: { count: 1, fils: fils(20000), shareBp: 4444 },
        card: { count: 1, fils: fils(25000), shareBp: 5556 },
        applepay: { count: 0, fils: fils(0), shareBp: 0 },
      },
    },
    bookings: {
      status: 'ok',
      salons: 1,
      months: [{ month: '2026-09', bookings: 3, completed: 2, noShows: 1, rateBp: 3333 }],
      depositsHeld: { bookings: 1, fils: fils(5000) },
    },
    campaigns: {
      status: 'ok',
      pendingNow: 1,
      months: [
        {
          month: '2026-09',
          submitted: 3,
          approved: 1,
          rejected: 1,
          sent: 1,
          held: 0,
          medianDecisionSeconds: 3600,
          p90DecisionSeconds: null,
        },
      ],
    },
    support: {
      status: 'ok',
      openNow: { total: 2, avo: 1, salon: 1 },
      months: [{ month: '2026-09', opened: 2, resolved: 1 }],
    },
    shop: {
      status: 'ok',
      salons: 1,
      months: [{ month: '2026-09', gmvFils: fils(4000), orders: 1 }],
      ordersByStatus: { preparing: 0, ready: 1, closed: 0 },
    },
    busiestTimes: {
      status: 'ok',
      clock: 'salon_local',
      cells: [{ weekday: 3, hour: 10, visits: 2 }],
      totalVisits: 2,
    },
  };
}

const cell = (rows: ReturnType<typeof platformRows>, section: string, item: string, metric: string) => {
  const hit = rows.filter((r) => r.section === section && r.item === item && r.metric === metric);
  expect(hit, `${section} / ${item} / ${metric}`).toHaveLength(1);
  return hit[0]!;
};

describe('the fixture', () => {
  it('is a valid wire object, so the renderer is tested on a shape the API can serve', () => {
    expect(() => PlatformAnalyticsSchema.parse(fixture())).not.toThrow();
  });
});

describe('the file', () => {
  it('leads with the scope, then every section in the object order', () => {
    const rows = platformRows(fixture(), null);
    expect(rows.slice(0, 5).map((r) => r.section)).toEqual(Array(5).fill(SCOPE_TITLE));
    expect(cell(rows, SCOPE_TITLE, '', 'month').value).toBe('2026-09');
    expect(cell(rows, SCOPE_TITLE, '', 'salon').value).toBe('All salons');
    const order = [...new Set(rows.slice(5).map((r) => r.section))];
    expect(order).toEqual(PLATFORM_ANALYTICS_SECTIONS.map((s) => PLATFORM_SECTION_TITLE[s]));
  });

  it('prints money as KD to three decimals and shares as percent to two, by integer arithmetic', () => {
    const rows = platformRows(fixture(), null);
    expect(cell(rows, 'AVO revenue', '2026-09', 'commission').value).toBe('0.825');
    expect(cell(rows, 'Money', '', 'outstanding balance now').value).toBe('29.250');
    expect(cell(rows, 'Payment mix', 'KNET', 'share of top-up value').value).toBe('44.44');
    expect(cell(rows, 'Salon leaderboard', 'Amara', 'no-show rate').value).toBe('33.33');
  });

  it('writes a module that is off as module_off, never 0 and never empty', () => {
    const rows = platformRows(fixture(), 'leaderboard');
    for (const metric of ['bookings', 'no-show rate', 'shop revenue']) {
      const c = cell(rows, 'Salon leaderboard', 'Bloom', metric);
      expect(c).toMatchObject({ value: 'module_off', unit: '' });
    }
  });

  it('writes a null decision time as an empty cell under its unit', () => {
    const rows = platformRows(fixture(), 'campaigns');
    expect(cell(rows, 'Campaigns', '2026-09', 'median time to decision')).toMatchObject({ value: '3600', unit: 'seconds' });
    expect(cell(rows, 'Campaigns', '2026-09', 'p90 time to decision')).toMatchObject({ value: '', unit: 'seconds' });
  });

  it.each([
    ['campaigns', 'permission: approvals', { status: 'withheld', reason: 'permission', permission: 'approvals' }],
    ['support', 'permission: policies', { status: 'withheld', reason: 'permission', permission: 'policies' }],
    ['shop', 'module_off', { status: 'withheld', reason: 'module_off', permission: null }],
    ['bookings', 'module_off', { status: 'withheld', reason: 'module_off', permission: null }],
  ] as const)('a withheld %s block is exactly one row naming the reason', (section, value, w) => {
    const a = { ...fixture(), [section]: w } as PlatformAnalytics;
    expect(platformSectionRows(a, section)).toEqual([
      { section: PLATFORM_SECTION_TITLE[section], item: '', metric: 'withheld', value, unit: '' },
    ]);
  });

  it('every section yields at least one row even when every figure is zero', () => {
    const a = fixture();
    const empty: PlatformAnalytics = {
      ...a,
      leaderboard: { status: 'ok', rows: [] },
      busiestTimes: { status: 'ok', clock: 'salon_local', cells: [], totalVisits: 0 },
      money: { status: 'ok', months: [], liabilityFils: fils(0), liabilityBySalon: [] },
    };
    for (const s of PLATFORM_ANALYTICS_SECTIONS) expect(platformSectionRows(empty, s).length).toBeGreaterThan(0);
  });

  it('a section export is the scope plus that section only', () => {
    const rows = platformRows(fixture(), 'paymentMix');
    expect(new Set(rows.map((r) => r.section))).toEqual(new Set([SCOPE_TITLE, 'Payment mix']));
  });

  it('renders through the Overview CSV: BOM, quoted fields, CRLF, formula guard', () => {
    const csv = platformCsv(platformRows(fixture(), 'money'));
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv.slice(1).split('\r\n')[0]).toBe('"section","item","metric","value","unit"');
    // A salon named like a formula is neutralised in the item column.
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
  });

  it('names no member — the only names in the file are salon names', () => {
    const rows = platformRows(fixture(), null);
    const items = new Set(rows.filter((r) => r.section === 'Salon leaderboard').map((r) => r.item));
    expect(items).toEqual(new Set(['', 'Amara', 'Bloom']));
  });
});

describe('the parameters', () => {
  it('section: absent is all; a key is that key; anything else is 400', () => {
    expect(parsePlatformSection(undefined)).toBeNull();
    expect(parsePlatformSection('')).toBeNull();
    expect(parsePlatformSection('leaderboard')).toBe('leaderboard');
    for (const bad of ['Leaderboard', 'kpis', ['money']]) {
      expect(() => parsePlatformSection(bad)).toThrow(expect.objectContaining({ statusCode: 400, code: 'invalid_section' }));
    }
  });

  it('download kind round-trips, and refuses every other platform- kind', () => {
    expect(platformDownloadKind(null)).toBe('platform-analytics');
    expect(platformDownloadKind('shop')).toBe('platform-analytics:shop');
    expect(parsePlatformDownloadKind('platform-analytics')).toBeNull();
    expect(parsePlatformDownloadKind('platform-analytics:shop')).toBe('shop');
    expect(parsePlatformDownloadKind('overview')).toBeUndefined();
    expect(parsePlatformDownloadKind('sales')).toBeUndefined();
    expect(() => parsePlatformDownloadKind('platform-analytics:kpis')).toThrow();
    expect(() => parsePlatformDownloadKind('platform-other')).toThrow();
  });

  it('period token round-trips', () => {
    expect(platformPeriodToken('2026-09', 12)).toBe('2026-09_12m');
    expect(parsePlatformPeriodToken('2026-09_12m')).toEqual({ month: '2026-09', months: 12 });
    expect(() => parsePlatformPeriodToken('30d')).toThrow();
  });

  it('filename names the scope, the window and the section, sanitised', () => {
    expect(platformFilename(null, '2026-09', 12, null)).toBe('platform-analytics_all-salons_2026-09_12m.csv');
    expect(platformFilename('Amara Beauty', '2026-09', 3, 'shop')).toBe('platform-analytics_amara-beauty_2026-09_3m_shop.csv');
    expect(platformFilename('a"; x=1', '2026-09', 1, null)).not.toContain('"');
  });
});

describe('the audit row', () => {
  it('records the act and never the content, in the platform log', () => {
    const row = platformExportAudit({ salonId: 'SAL-A', section: null, month: '2026-09', months: 12, rowCount: 40, via: 'csv' });
    expect(row).toMatchObject({
      salonId: null,
      kind: 'access',
      action: 'Report exported',
      source: 'owner_console',
      subjectType: 'report',
      subjectId: 'platform-analytics',
      metadata: { kind: 'platform-analytics', section: null, salonId: 'SAL-A', month: '2026-09', months: 12, rowCount: 40, via: 'csv' },
    });
    expect(row).not.toHaveProperty('amountFils');
    expect(row.detail).toBe('Platform analytics · all sections · SAL-A · 2026-09 (12 months) · 40 rows · csv');
  });
});
