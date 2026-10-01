/**
 * THE OVERVIEW'S WIDGETS AS A FILE — `GET /v1/salons/{id}/overview/analytics.csv`.
 *
 * Aftab, 2026-10-02: "want export option to get the valuable widget info they are
 * giving on the dashboard".
 *
 * ==========================================================================
 * ONE ANSWER, TWO RENDERINGS — THE REPORTS RULE
 * ==========================================================================
 * Nothing here queries anything. Every row below is read off an `OverviewAnalytics`
 * that `computeOverviewAnalytics` already produced, through the same gates the JSON
 * route applies (`routes/overview.ts § loadOverview`). So the file cannot show a
 * figure the card does not, cannot run a query a withheld block skipped, and cannot
 * disagree with the card about a definition: there is no second definition.
 *
 * ==========================================================================
 * LONG FORMAT — `section, item, metric, value, unit`
 * ==========================================================================
 * Twelve widgets of twelve different shapes do not share columns, and twelve
 * tables in one CSV is not a CSV Excel can open. One long table can be, and it
 * pivots: filter on `section`, pivot `item` × `metric`.
 *
 *   section   the widget's title, verbatim from the Overview
 *   item      what the row is about — a service, an artist, `Wed 21:00`, a tier.
 *             Empty for a widget-level figure.
 *   metric    what was measured
 *   value     the figure, as text
 *   unit      `KD`, `%`, `count`, `rank`, `stamps`, or empty for text
 *
 * MONEY is integer fils on the way in and leaves as KD to three decimals through
 * `reports.ts § csvMoneyCell` — `formatFils` from `@avo/types` minus the thousands
 * comma, for the reason that function gives (a quoted `"1,820.000"` is text to
 * Excel). `fils()` runs on every value, so a float that somehow reached this file
 * throws instead of printing.
 *
 * SHARES are basis points on the way in and leave as percent to two decimals, by
 * integer division: 2500 bp is `25.00`. No float touches either.
 *
 * TIMES are in the SALON'S clock, as the JSON's busiest-times grid already is —
 * `upcoming` and `campaigns` carry UTC instants on the wire, and a file a merchant
 * reads in Excel has no zone column, so they are rendered in `window.timezone`.
 *
 * ==========================================================================
 * A WITHHELD BLOCK IS A ROW, NOT A GAP
 * ==========================================================================
 * `Campaigns, , withheld, permission: marketing`. A file that silently omits the
 * widgets a caller may not see reads as a complete export with nothing in those
 * widgets — a merchant cannot tell "no campaigns went out" from "you may not see
 * campaigns". So every withheld block, whatever the reason, is exactly one row whose
 * `value` is the reason (`permission: <perm>`, `not_per_branch`, `module_off`).
 *
 * `module_off` IS EMITTED TOO, not omitted. The brief allowed either; one rule for
 * every reason is the one a reader of the file never has to know, and a shop row
 * saying the module is off is the same honesty the JSON shows the card.
 *
 * `upcoming.next` is a block INSIDE a block: its withheld row is
 * `Upcoming, Next appointments, withheld, permission: appointments`, beside the
 * two counts that are still served.
 *
 * ==========================================================================
 * WHAT IS NOT IN THE FILE
 * ==========================================================================
 * Internal ids (`serviceId`, `bookingId`, `memberId`, …). They are join keys for a
 * client, mean nothing in a spreadsheet, and `memberId` is a handle on a person.
 * Customer NAMES on `upcoming.next` ARE kept — the Overview shows them to a holder
 * of `appointments`, and the export obeys that same gate because it is the same
 * object. That is why every export is audited (`overviewExportAudit` below).
 *
 * ==========================================================================
 * FIFTEEN SECTIONS, NOT TWELVE — EVERY WIDGET THE OVERVIEW DRAWS
 * ==========================================================================
 * Aftab asked for "the valuable widget info they are giving on the dashboard",
 * and the Overview draws three widgets the analytics JSON does not carry. Each
 * is in the file, BUILT FROM THE SAME SERVICE CALL ITS OWN ENDPOINT MAKES, so
 * the file cannot disagree with the card about any of them:
 *
 *   kpis              the four tiles      `computeMetrics` — `GET /salons/{id}/metrics`
 *   salesTrend        Gross by day        `computeReport('sales')` — `GET …/reports/sales`
 *   revenueByBranch   Revenue by branch   `computeReport('earnings-by-branch')`
 *
 * The file reads in the Overview's order, top to bottom: the KPI row, the Gross
 * by day chart, then the analytics grid, whose first card is Revenue by branch,
 * then the grid's twelve blocks.
 *
 * EACH KEEPS ITS OWN CARD'S TIME BASIS, AND THE ROWS SAY WHICH ONE.
 *   - Two KPI tiles are TODAY in the salon's clock ("Loaded today", "Upcoming
 *     today"), and `?period=` does not move them (`metrics.ts § the day`). Their
 *     metrics say "today", and a widget-level row names the salon-local date.
 *     The other two tiles run over the export's period. Their metrics say "in
 *     period", and a widget-level row names the period.
 *   - Gross by day covers the last FOURTEEN COMPLETE salon-local days, ending
 *     yesterday, at ALL BRANCHES. That is the chart's own fixed window and scope
 *     (`apps/dashboard/src/routes/salesTrendRules.ts § TREND_DAYS`, `trendScope`).
 *     Neither `?period=` nor `?branch=` narrows it, so the section states its
 *     window and its scope in rows of its own.
 *   - Revenue by branch takes the export's branch and period, as the card does:
 *     the card reads the analytics period and the shell's branch selection.
 *
 * With a branch applied, the Loaded today tile is withheld as `not_per_branch`.
 * That is the analytics blocks' reason, and it applies because the JSON's
 * `loadedTodayFils` is null there for the same cause. The branch-assumed caveat
 * becomes count rows. Where the card prints its sentence, a `note` row carries
 * that sentence verbatim.
 */

import { add, fils, type Fils } from '@avo/types';
import type { PermissionName } from '../auth/principal';
import { badRequest } from '../http/errors';
import { minutesToHhmm, salonWallClock, type CalendarDate } from '../time/zone';
import type { SalonMetrics } from './metrics';
import type { OverviewAnalytics, Withheld } from './overviewAnalytics';
import { periodToken, type CalendarPeriod, type Period, type PeriodWindow } from './period';
import { branchTag, csvMoneyCell, neutralise, quote, type ReportResult } from './reports';

// ---------------------------------------------------------------- sections --

/**
 * The three widgets above the analytics grid, keyed as the brief names them, in
 * the order the Overview draws them.
 */
export const WIDGET_SECTIONS = ['kpis', 'salesTrend', 'revenueByBranch'] as const;
export type WidgetSection = (typeof WIDGET_SECTIONS)[number];

/**
 * The twelve block keys of the analytics JSON, verbatim, in the order the grid
 * draws them. A client already holds these names, because they are the keys it
 * reads the JSON by.
 */
export const ANALYTICS_SECTIONS = [
  'topServices',
  'artists',
  'busiestTimes',
  'upcoming',
  'noShows',
  'newMembers',
  'visitors',
  'loyalty',
  'wallet',
  'paymentMix',
  'shop',
  'campaigns',
] as const;
export type AnalyticsSection = (typeof ANALYTICS_SECTIONS)[number];

/**
 * The `?section=` vocabulary, and the order of the whole file: the Overview read
 * top to bottom. A missing `section` means all fifteen, in this order.
 */
export const OVERVIEW_SECTIONS = [...WIDGET_SECTIONS, ...ANALYTICS_SECTIONS] as const;

export type OverviewSection = (typeof OVERVIEW_SECTIONS)[number];

const SECTION_SET: ReadonlySet<string> = new Set(OVERVIEW_SECTIONS);
const ANALYTICS_SET: ReadonlySet<string> = new Set(ANALYTICS_SECTIONS);

export function isAnalyticsSection(s: OverviewSection): s is AnalyticsSection {
  return ANALYTICS_SET.has(s);
}

/** The sections a request names, in file order. */
export function sectionsOf(section: OverviewSection | null): readonly OverviewSection[] {
  return section === null ? OVERVIEW_SECTIONS : [section];
}

/**
 * Absent (or empty) is every section; one known key is that one; anything else —
 * an unknown key, a repeated `?section=a&section=b` that arrives as an array — is
 * 400 rather than a file of everything, which is what "ignore what you did not
 * understand" would quietly serve.
 */
export function parseOverviewSection(value: unknown): OverviewSection | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'string' && SECTION_SET.has(value)) return value as OverviewSection;
  throw badRequest(
    'invalid_section',
    `section must be one of ${OVERVIEW_SECTIONS.join(', ')}.`,
  );
}

// ----------------------------------------------------------- the download kind --

/**
 * `report_download.kind` FOR AN OVERVIEW LINK: `overview`, or `overview:<section>`.
 *
 * NO MIGRATION, for Reports' own reason (`routes/reports.ts` on the period column):
 * `kind` is an unconstrained `text` column — 0036 put no CHECK on it — so it admits
 * the new value as it stands, and an additive column would have been a migration
 * with a merge-order dependency on every other lane's `drizzle/` for no gain.
 *
 * The section rides in the same column because a link is a link to ONE file, and
 * the file IS (kind, section). `parseOverviewDownloadKind` is strict in both
 * directions, so a row this module did not write never redeems as an overview.
 */
export const OVERVIEW_DOWNLOAD_KIND = 'overview';

export function overviewDownloadKind(section: OverviewSection | null): string {
  return section === null ? OVERVIEW_DOWNLOAD_KIND : `${OVERVIEW_DOWNLOAD_KIND}:${section}`;
}

/**
 * `undefined` — not an overview row at all (a Reports kind). `null` — every
 * section. A section — that one. Throws on `overview:<unknown>`, which only a
 * corrupted row could hold; the redemption turns that into its uniform refusal.
 */
export function parseOverviewDownloadKind(kind: string): OverviewSection | null | undefined {
  if (kind === OVERVIEW_DOWNLOAD_KIND) return null;
  if (!kind.startsWith(`${OVERVIEW_DOWNLOAD_KIND}:`)) return undefined;
  const section = kind.slice(OVERVIEW_DOWNLOAD_KIND.length + 1);
  if (!SECTION_SET.has(section)) throw new Error(`report_download.kind ${kind} names no section.`);
  return section as OverviewSection;
}

// ---------------------------------------------------------------- rendering --

export const OVERVIEW_CSV_COLUMNS = ['section', 'item', 'metric', 'value', 'unit'] as const;

export type Unit = 'KD' | '%' | 'count' | 'rank' | 'stamps' | '';

export interface OverviewCsvRow {
  section: string;
  item: string;
  metric: string;
  value: string;
  unit: Unit;
}

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const ORDER_STATUS_LABEL = { preparing: 'Preparing', ready: 'Ready', closed: 'Closed' } as const;
const METHOD_LABEL = { knet: 'KNET', card: 'Card', applepay: 'Apple Pay' } as const;

/** The widget titles, verbatim from `apps/dashboard/src/routes/OverviewAnalytics.tsx`. */
function sectionTitle(section: AnalyticsSection, a: OverviewAnalytics): string {
  switch (section) {
    case 'topServices':
      return 'Top services';
    case 'artists':
      return 'Artist performance';
    case 'busiestTimes':
      return 'Busiest times';
    case 'upcoming':
      return 'Upcoming';
    case 'noShows':
      return 'No-shows and deposits';
    case 'newMembers':
      return 'New members';
    case 'visitors':
      return 'First visit vs returning';
    case 'loyalty':
      // The card's own title switches on the salon's mode; `loyaltyMode` is
      // top-level, so even a withheld loyalty block is titled correctly.
      return a.loyaltyMode === 'stamps' ? 'Stamp progress' : 'Members by tier';
    case 'wallet':
      return 'Wallet loaded vs spent';
    case 'paymentMix':
      return 'Payment mix';
    case 'shop':
      return 'Shop orders';
    case 'campaigns':
      return 'Campaigns';
  }
}

/** Integer fils → `59.250`. The only money path in this file. */
const kd = (f: Fils): string => csvMoneyCell(f);

/** Integer count → `4`. Refuses a fraction rather than printing one. */
function count(n: number): string {
  if (!Number.isSafeInteger(n)) throw new TypeError(`A count must be an integer, got ${n}.`);
  return String(n);
}

/**
 * Basis points → percent to two decimals, by integer division: 2500 → `25.00`,
 * 3333 → `33.33`, 10000 → `100.00`. Null (an empty denominator — "0% of nothing"
 * is a claim the JSON refuses to make) is an empty cell, not `0.00`.
 */
export function bpToPercent(bp: number | null): string {
  if (bp === null) return '';
  if (!Number.isSafeInteger(bp) || bp < 0) throw new TypeError(`Basis points must be a non-negative integer, got ${bp}.`);
  return `${Math.floor(bp / 100)}.${String(bp % 100).padStart(2, '0')}`;
}

/** An instant in the salon's clock: `2026-10-03 18:00`. */
function salonTime(iso: string, zone: string): string {
  const w = salonWallClock(new Date(iso), zone);
  return `${w.date} ${minutesToHhmm(w.minutes)}`;
}

function withheldValue(w: Withheld): string {
  return w.reason === 'permission' ? `permission: ${w.permission as PermissionName}` : w.reason;
}

/**
 * `{ assumed, total }` as two rows, only when a branch was applied (null at
 * all-branches, where nothing is in doubt). The size of the doubt is part of the
 * figure: "3 visits at Salmiya, 1 of them inferred" is a different claim from "3".
 */
function branchAssumedRows(
  push: (item: string, metric: string, value: string, unit: Unit) => void,
  ba: { assumed: number; total: number } | null,
): void {
  if (ba === null) return;
  push('', 'rows with branch inferred', count(ba.assumed), 'count');
  push('', 'rows considered', count(ba.total), 'count');
}

/**
 * The rows of ONE section. Pure — the input is the JSON object, the output is
 * strings, and `overviewExport.test.ts` drives every block in both states.
 */
export function sectionRows(a: OverviewAnalytics, section: AnalyticsSection): OverviewCsvRow[] {
  const title = sectionTitle(section, a);
  const out: OverviewCsvRow[] = [];
  const push = (item: string, metric: string, value: string, unit: Unit) =>
    out.push({ section: title, item, metric, value, unit });
  const tz = a.window.timezone;

  switch (section) {
    case 'topServices': {
      const b = a.topServices;
      if (b.status === 'withheld') return [{ section: title, item: '', metric: 'withheld', value: withheldValue(b), unit: '' }];
      // The two rankings are of the same rows, so a service in both is one item.
      // Ranked by bookings first, then whatever only the revenue ranking holds.
      const seen = new Map<string, { name: string; bookings: number; revenueFils: Fils; rb: number | null; rr: number | null }>();
      b.byBookings.forEach((s, i) =>
        seen.set(s.serviceId, { name: s.name, bookings: s.bookings, revenueFils: s.revenueFils, rb: i + 1, rr: null }),
      );
      b.byRevenue.forEach((s, i) => {
        const hit = seen.get(s.serviceId);
        if (hit) hit.rr = i + 1;
        else seen.set(s.serviceId, { name: s.name, bookings: s.bookings, revenueFils: s.revenueFils, rb: null, rr: i + 1 });
      });
      // Always one widget-level row, so an empty ranking is a stated 0 and the
      // section is never absent from the file.
      push('', 'services ranked', count(seen.size), 'count');
      for (const s of seen.values()) {
        push(s.name, 'bookings', count(s.bookings), 'count');
        push(s.name, 'revenue', kd(s.revenueFils), 'KD');
        if (s.rb !== null) push(s.name, 'rank by bookings', count(s.rb), 'rank');
        if (s.rr !== null) push(s.name, 'rank by revenue', count(s.rr), 'rank');
      }
      branchAssumedRows(push, b.branchAssumed);
      return out;
    }

    case 'artists': {
      const b = a.artists;
      if (b.status === 'withheld') return [{ section: title, item: '', metric: 'withheld', value: withheldValue(b), unit: '' }];
      push('', 'artists', count(b.items.length), 'count');
      for (const r of b.items) {
        push(r.name, 'bookings', count(r.bookings), 'count');
        push(r.name, 'no-shows', count(r.noShows), 'count');
        push(r.name, 'revenue', kd(r.revenueFils), 'KD');
      }
      branchAssumedRows(push, b.branchAssumed);
      return out;
    }

    case 'busiestTimes': {
      const b = a.busiestTimes;
      if (b.status === 'withheld') return [{ section: title, item: '', metric: 'withheld', value: withheldValue(b), unit: '' }];
      // Already the salon's weekday and hour on the wire — rendered, not converted.
      for (const c of b.cells) {
        push(`${WEEKDAY[c.weekday]} ${String(c.hour).padStart(2, '0')}:00`, 'visits', count(c.visits), 'count');
      }
      push('', 'total visits', count(b.totalVisits), 'count');
      branchAssumedRows(push, b.branchAssumed);
      return out;
    }

    case 'upcoming': {
      const u = a.upcoming;
      push('', 'today', count(u.today), 'count');
      push('', 'next 7 days', count(u.next7Days), 'count');
      branchAssumedRows(push, u.branchAssumed);
      if (u.next.status === 'withheld') {
        push('Next appointments', 'withheld', withheldValue(u.next), '');
        return out;
      }
      for (const r of u.next.items) {
        const when = salonTime(r.startsAt, tz);
        push(when, 'customer', r.customerName, '');
        push(when, 'service', r.serviceName, '');
        push(when, 'artist', r.artistName, '');
        push(when, 'branch', r.branchName, '');
        if (r.branchAssumed) push(when, 'branch inferred', 'yes', '');
      }
      return out;
    }

    case 'noShows': {
      const b = a.noShows;
      if (b.status === 'withheld') return [{ section: title, item: '', metric: 'withheld', value: withheldValue(b), unit: '' }];
      push('', 'completed', count(b.completed), 'count');
      push('', 'no-shows', count(b.noShows), 'count');
      push('', 'no-show rate', bpToPercent(b.rateBp), '%');
      push('', 'deposits held now', kd(b.depositsHeld.fils), 'KD');
      push('', 'deposits held now (bookings)', count(b.depositsHeld.bookings), 'count');
      branchAssumedRows(push, b.branchAssumed);
      return out;
    }

    case 'newMembers': {
      const b = a.newMembers;
      if (b.status === 'withheld') return [{ section: title, item: '', metric: 'withheld', value: withheldValue(b), unit: '' }];
      push('', 'total', count(b.total), 'count');
      for (const w of b.weeks) {
        push(`week of ${w.weekStart}${w.partial ? ' (partial)' : ''}`, 'new members', count(w.count), 'count');
      }
      return out;
    }

    case 'visitors': {
      const b = a.visitors;
      if (b.status === 'withheld') return [{ section: title, item: '', metric: 'withheld', value: withheldValue(b), unit: '' }];
      push('', 'visitors', count(b.total), 'count');
      push('', 'first visit', count(b.firstVisit), 'count');
      push('', 'returning', count(b.returning), 'count');
      branchAssumedRows(push, b.branchAssumed);
      return out;
    }

    case 'loyalty': {
      const b = a.loyalty;
      if (b.status === 'withheld') return [{ section: title, item: '', metric: 'withheld', value: withheldValue(b), unit: '' }];
      if (b.mode === 'tiers') {
        for (const t of b.tiers) push(t.tier, 'members', count(t.members), 'count');
        push('no tier', 'members', count(b.untiered), 'count');
      } else {
        push('', 'stamp target', count(b.stampTarget), 'stamps');
        for (const k of b.buckets) push(`${k.stamps} stamps`, 'members', count(k.members), 'count');
      }
      return out;
    }

    case 'wallet': {
      const b = a.wallet;
      if (b.status === 'withheld') return [{ section: title, item: '', metric: 'withheld', value: withheldValue(b), unit: '' }];
      push('', 'loaded', kd(b.loadedFils), 'KD');
      push('', 'bonus', kd(b.bonusFils), 'KD');
      push('', 'top-ups', count(b.topups), 'count');
      push('', 'spent', kd(b.spentFils), 'KD');
      push('', 'outstanding balance', kd(b.liabilityFils), 'KD');
      return out;
    }

    case 'paymentMix': {
      const b = a.paymentMix;
      if (b.status === 'withheld') return [{ section: title, item: '', metric: 'withheld', value: withheldValue(b), unit: '' }];
      for (const m of ['knet', 'card', 'applepay'] as const) {
        const t = b.topups[m];
        push(METHOD_LABEL[m], 'top-ups', count(t.count), 'count');
        push(METHOD_LABEL[m], 'top-up value', kd(t.fils), 'KD');
        push(METHOD_LABEL[m], 'share of top-up value', bpToPercent(t.shareBp), '%');
      }
      push('Wallet', 'payments', count(b.walletSpend.count), 'count');
      push('Wallet', 'spent', kd(b.walletSpend.fils), 'KD');
      return out;
    }

    case 'shop': {
      const b = a.shop;
      if (b.status === 'withheld') return [{ section: title, item: '', metric: 'withheld', value: withheldValue(b), unit: '' }];
      push('', 'orders', count(b.orders), 'count');
      for (const s of ['preparing', 'ready', 'closed'] as const) {
        push(ORDER_STATUS_LABEL[s], 'orders', count(b.ordersByStatus[s]), 'count');
      }
      for (const p of b.topProducts) {
        push(p.name, 'units', count(p.units), 'count');
        push(p.name, 'revenue', kd(p.revenueFils), 'KD');
      }
      push('', 'revenue', kd(b.revenueFils), 'KD');
      branchAssumedRows(push, b.branchAssumed);
      return out;
    }

    case 'campaigns': {
      const b = a.campaigns;
      if (b.status === 'withheld') return [{ section: title, item: '', metric: 'withheld', value: withheldValue(b), unit: '' }];
      push('', 'sent', count(b.sent), 'count');
      push('', 'reached', count(b.reached), 'count');
      push('', 'targeted', count(b.reach), 'count');
      for (const c of b.items) {
        push(c.title, 'sent at', salonTime(c.sentAt, tz), '');
        push(c.title, 'audience', c.audience, '');
        push(c.title, 'channel', c.channel, '');
        push(c.title, 'reached', count(c.reached), 'count');
        push(c.title, 'targeted', count(c.reach), 'count');
        if (c.result !== null) push(c.title, 'result', c.result, '');
      }
      // The JSON caps the list at 20 and says so; the file says so too.
      if (b.truncated) push('', 'list truncated', 'yes', '');
      return out;
    }
  }
}

// ------------------------------------------------- the three widgets above --

/** The section column for the three widgets: the Overview's own titles. */
export const WIDGET_TITLE: Record<WidgetSection, string> = {
  /** The KPI row has no card title. Each tile's label is its `item`. */
  kpis: 'KPIs',
  /** `apps/dashboard/src/routes/SalesTrend.tsx § TrendCard`, verbatim. */
  salesTrend: 'Gross by day',
  /** `apps/dashboard/src/routes/OverviewAnalytics.tsx § RevenueByBranchCard`, verbatim. */
  revenueByBranch: 'Revenue by branch',
};

/**
 * "a", "a and b", "a, b and c". The dashboard's `joinClauses`
 * (`apps/dashboard/src/routes/overviewAnalyticsRules.ts`), so the note rows carry
 * the card's sentence word for word.
 */
function joinClauses(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** Integer fils off a report row cell. A float or a missing cell throws in `fils()`. */
const rowFils = (v: string | number | null | undefined): Fils => fils(v as number);
function rowCount(v: string | number | null | undefined): number {
  if (typeof v !== 'number') throw new TypeError(`A count cell must be a number, got ${String(v)}.`);
  return v;
}

/**
 * A signed integer, which only the active-members delta is. `-3` is printed as
 * `-3`. `overviewCsv` leaves a value that is a plain number untouched, so the
 * formula guard does not turn it into the text `'-3`.
 */
function signedCount(n: number): string {
  if (!Number.isSafeInteger(n)) throw new TypeError(`A count must be an integer, got ${n}.`);
  return String(n);
}

/** An integer percent, as `/metrics` serves it: `62` → `62`. */
function wholePercent(n: number): string {
  if (!Number.isSafeInteger(n) || n < 0) throw new TypeError(`A percent must be a non-negative integer, got ${n}.`);
  return String(n);
}

/** `30d` → `last 30 days (rolling)`; a range → `2026-09-01 to 2026-09-14 (salon clock)`. */
function windowText(w: PeriodWindow): string {
  if (w.basis === 'rolling') return `last ${w.days} days (rolling)`;
  return `${w.fromDate} to ${w.toDate} (salon clock)`;
}

export interface KpisInput {
  /** `computeMetrics`'s answer, exactly as `GET /salons/{id}/metrics` serves it. */
  metrics: SalonMetrics;
  /** The salon-local date the two TODAY tiles mean, from the same `now`. */
  today: string;
  /** The window the two WINDOW tiles ran over. */
  window: PeriodWindow;
  timezone: string;
}

/**
 * THE KPI ROW. One `item` per tile, labelled as the tile is.
 *
 * TWO TIME BASES, BOTH NAMED. Active members and Repeat rate run over the
 * period. Loaded today and Upcoming today are the salon's today and ignore it.
 *
 * LOADED TODAY WITH A BRANCH APPLIED is one withheld row, `not_per_branch`. Both
 * of its figures (the KD and the KNET share) are null there, for one cause, so
 * one row says so.
 *
 * THE DELTA IS SIGNED. The tile hides a non-positive delta. The file prints it,
 * because a falling member count is a figure and the file has no styling to hide
 * it with.
 */
export function kpiRows(k: KpisInput): OverviewCsvRow[] {
  const title = WIDGET_TITLE.kpis;
  const out: OverviewCsvRow[] = [];
  const push = (item: string, metric: string, value: string, unit: Unit) =>
    out.push({ section: title, item, metric, value, unit });
  const m = k.metrics;

  push('', 'period', windowText(k.window), '');
  push('', 'today (salon clock)', k.today, '');

  push('Active members', 'active in period', count(m.activeMembers), 'count');
  push('Active members', 'change vs same period a week earlier', signedCount(m.activeMembersDelta), 'count');

  if (m.loadedTodayFils === null) {
    push('Loaded today', 'withheld', 'not_per_branch', '');
  } else {
    push('Loaded today', 'loaded today', kd(fils(m.loadedTodayFils)), 'KD');
    if (m.knetSharePercent !== null) {
      push('Loaded today', 'KNET share of loaded today', wholePercent(m.knetSharePercent), '%');
    }
  }

  push('Repeat rate', 'repeat rate in period', wholePercent(m.repeatRatePercent), '%');

  push('Upcoming today', 'still to start today', count(m.upcomingAppointments), 'count');
  if (m.nextAppointmentAt !== null) {
    push('Upcoming today', 'next at (salon clock)', salonTime(m.nextAppointmentAt, k.timezone), '');
  }

  /**
   * THE BRANCH-ASSUMED CAVEAT. Count rows always appear with a branch applied,
   * in the analytics blocks' manner. The `note` row is the card's own sentence
   * (`Overview.tsx § AssumedNote`), printed only when the card prints it.
   */
  const ba = m.branchAssumed;
  if (ba !== null) {
    push('Active members', 'members counted only on rows with branch inferred', count(ba.activeMembers), 'count');
    push('Repeat rate', 'visits with branch inferred', count(ba.visits), 'count');
    push('Repeat rate', 'visits considered', count(ba.visitsTotal), 'count');
    push('Upcoming today', 'appointments with branch inferred', count(ba.upcomingAppointments), 'count');
    const clause = (assumed: number, total: number, noun: string) =>
      assumed <= 0 || total <= 0 ? null : `${assumed} of ${total} ${noun}`;
    const parts = [
      clause(ba.activeMembers, m.activeMembers, 'members'),
      clause(ba.visits, ba.visitsTotal, 'visits'),
      clause(ba.upcomingAppointments, m.upcomingAppointments, 'appointments'),
    ].filter((p): p is string => p !== null);
    if (parts.length > 0) {
      push('', 'note', `Branch assumed on ${joinClauses(parts)} — treat these branch figures as approximate.`, '');
    }
  }
  return out;
}

/** A Reports aggregate, or the reason it is withheld. */
export type ReportBlock = ({ status: 'ok' } & { report: ReportResult }) | Withheld;

/** How many days Gross by day draws. `salesTrendRules.ts § TREND_DAYS`. */
export const TREND_DAYS = 14;

/** `CalendarDate` + n days. Arithmetic on UTC midnight, which has no DST, so it is exact. */
function shiftDate(d: CalendarDate, days: number): CalendarDate {
  const t = new Date(Date.UTC(d.year, d.month - 1, d.day) + days * 86_400_000);
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
}

/**
 * THE CHART'S WINDOW, COMPUTED AS THE CHART COMPUTES IT (`salesTrendRules.ts §
 * trendWindow`): the last fourteen COMPLETE salon-local days, ending yesterday.
 * As a calendar period, because a rolling window grouped by day has part-days at
 * both ends. That is the reason the chart sends a range too.
 */
export function salesTrendPeriod(timezone: string, now: Date): CalendarPeriod {
  const [y, mo, d] = salonWallClock(now, timezone).date.split('-').map(Number) as [number, number, number];
  const to = shiftDate({ year: y, month: mo, day: d }, -1);
  return { basis: 'calendar', from: shiftDate(to, -(TREND_DAYS - 1)), to };
}

export interface SalesTrendInput {
  block: ReportBlock;
  /** A branch was applied to the rest of the file, so this chart is wider than it. */
  branchApplied: boolean;
}

/**
 * GROSS BY DAY. One `item` per salon-local day, oldest first, with a zero for a
 * day that took nothing. The fold is the chart's own (`salesTrendRules.ts §
 * seriesFrom`): the `sales` rows are per (day, branch) and newest first, so the
 * branch rows for a day are summed with `add` semantics, in integer fils. Gross
 * is `grossFils`, as the bars are. Kept deposits are not drawn on the chart, so
 * they are not in this section either.
 *
 * NO TOTAL ROW. The card shows none (`salesTrendRules.ts`: "No total is
 * displayed"), and `reports/sales` is the export that carries one.
 */
export function salesTrendRows(t: SalesTrendInput): OverviewCsvRow[] {
  const title = WIDGET_TITLE.salesTrend;
  const b = t.block;
  if (b.status === 'withheld') return [{ section: title, item: '', metric: 'withheld', value: withheldValue(b), unit: '' }];
  const w = b.report.window;
  if (w.basis !== 'calendar' || w.fromDate === null || w.toDate === null) {
    throw new Error('Gross by day is a calendar window; a rolling one has no whole days to name.');
  }
  const out: OverviewCsvRow[] = [];
  const push = (item: string, metric: string, value: string, unit: Unit) =>
    out.push({ section: title, item, metric, value, unit });

  push('', 'window', `${w.fromDate} to ${w.toDate} (${w.days} complete days, salon clock)`, '');
  push('', 'branches', 'All branches', '');
  if (t.branchApplied) {
    push('', 'note', 'This chart covers all branches. The branch filter does not narrow it.', '');
  }

  const gross = new Map<string, Fils>();
  const txns = new Map<string, number>();
  for (const row of b.report.rows) {
    const date = String(row['date'] ?? '');
    // `add` over `Fils`, and `fils()` on every cell: a float cannot enter the fold.
    gross.set(date, add(gross.get(date) ?? fils(0), rowFils(row['grossFils'])));
    txns.set(date, (txns.get(date) ?? 0) + rowCount(row['transactions']));
  }
  const days: string[] = [];
  const [fy, fm, fd] = w.fromDate.split('-').map(Number) as [number, number, number];
  for (let i = 0; i < w.days; i++) {
    const c = shiftDate({ year: fy, month: fm, day: fd }, i);
    days.push(`${c.year}-${String(c.month).padStart(2, '0')}-${String(c.day).padStart(2, '0')}`);
  }
  // A row outside the window is kept, not dropped, as the chart keeps it.
  const all = [...new Set([...days, ...gross.keys()])].sort();
  for (const date of all) {
    push(date, 'gross', kd(gross.get(date) ?? fils(0)), 'KD');
    push(date, 'transactions', count(txns.get(date) ?? 0), 'count');
  }
  return out;
}

/**
 * REVENUE BY BRANCH. One `item` per branch, in the card's order (the report's:
 * gross descending, then name). Every branch has a row, a closed one included.
 * The two assumed columns sit beside the figures they qualify, and the card's
 * caveat sentence (`OverviewAnalytics.tsx § BranchDoubt`) is a `note` row when
 * any branch carries assumed money.
 */
export function revenueByBranchRows(b: ReportBlock): OverviewCsvRow[] {
  const title = WIDGET_TITLE.revenueByBranch;
  if (b.status === 'withheld') return [{ section: title, item: '', metric: 'withheld', value: withheldValue(b), unit: '' }];
  const out: OverviewCsvRow[] = [];
  const push = (item: string, metric: string, value: string, unit: Unit) =>
    out.push({ section: title, item, metric, value, unit });

  push('', 'branches', count(b.report.rows.length), 'count');
  const doubtful: string[] = [];
  for (const row of b.report.rows) {
    const name = String(row['branch'] ?? '');
    push(name, 'gross', kd(rowFils(row['grossFils'])), 'KD');
    push(name, 'transactions', count(rowCount(row['transactions'])), 'count');
    const assumed = rowFils(row['assumedGrossFils']);
    push(name, 'gross with branch assumed', kd(assumed), 'KD');
    push(name, 'transactions with branch assumed', count(rowCount(row['assumedTransactions'])), 'count');
    if (assumed > 0 && name !== '') doubtful.push(name);
  }
  if (doubtful.length > 0) {
    push('', 'note', `Branch assumed on ${joinClauses(doubtful)} — treat these branch figures as approximate.`, '');
  }
  return out;
}

/**
 * EVERYTHING ONE EXPORT NEEDS. Each part is required only when a requested
 * section reads it, so a `section=kpis` file runs `computeMetrics` and nothing
 * else. The loader (`routes/overview.ts § loadOverviewExport`) fills exactly the
 * parts `sectionsOf(section)` names. A part that is missing when a section needs
 * it is a programming error and throws.
 */
export interface OverviewExportInput {
  analytics?: OverviewAnalytics;
  kpis?: KpisInput;
  salesTrend?: SalesTrendInput;
  revenueByBranch?: ReportBlock;
}

function need<T>(v: T | undefined, what: string): T {
  if (v === undefined) throw new Error(`The overview export was not loaded with ${what}.`);
  return v;
}

/**
 * Every requested section's rows, in the Overview's order. EVERY SECTION YIELDS AT
 * LEAST ONE ROW — a withheld row, or a widget-level figure that is present even when
 * it is 0 — so "the section is missing" never has to be read as "the section was
 * empty". `overviewExport.test.ts` drives an all-empty answer to hold that.
 */
export function overviewRows(input: OverviewExportInput, section: OverviewSection | null): OverviewCsvRow[] {
  return sectionsOf(section).flatMap((s) => {
    if (isAnalyticsSection(s)) return sectionRows(need(input.analytics, 'the analytics'), s);
    switch (s) {
      case 'kpis':
        return kpiRows(need(input.kpis, 'the metrics'));
      case 'salesTrend':
        return salesTrendRows(need(input.salesTrend, 'the sales trend'));
      case 'revenueByBranch':
        return revenueByBranchRows(need(input.revenueByBranch, 'the branch earnings'));
    }
  });
}

/**
 * RFC 4180 the Reports way: every field quoted, `"` doubled, CRLF records, a UTF-8
 * BOM so Excel reads an Arabic service or customer name, no trailing newline. TEXT
 * cells go through `neutralise` — a salon can name a service `=HYPERLINK(...)`, and
 * so can a customer name herself.
 *
 * A FIGURE IS NOT A FORMULA. One figure here can be negative: the KPI row's
 * active-members delta. `neutralise` would turn `-3` into the text `'-3`, which
 * Excel cannot sum. So a `value` cell in a row that carries a unit, and that
 * is wholly a plain number (`-?digits`, optionally `.digits`), is left as it is.
 * Nothing else is exempt. A number cannot hold a formula, and every other cell
 * still goes through `neutralise`.
 */
const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;

export function overviewCsv(rows: OverviewCsvRow[]): string {
  const header = OVERVIEW_CSV_COLUMNS.map((c) => quote(c)).join(',');
  const body = rows.map((r) =>
    [
      r.section,
      r.item,
      r.metric,
      r.unit !== '' && PLAIN_NUMBER.test(r.value) ? r.value : neutralise(r.value),
      r.unit,
    ]
      .map((v, i) => quote(i === 3 ? v : neutralise(v)))
      .join(','),
  );
  return `﻿${[header, ...body].join('\r\n')}`;
}

/**
 * `overview_all-branches_30d.csv`, `overview_salmiya_2026-09-01_2026-09-14_topServices.csv`
 * — Reports' `{kind}_{branchTag}_{period}` with the section appended when one was
 * asked for. Same branch tag (`reports.ts § branchTag`, which is also the
 * header-injection guard), same period token. The section is from a fixed
 * vocabulary of ASCII letters, so it needs no sanitising.
 */
export function overviewFilename(
  branchName: string | null,
  period: Period,
  section: OverviewSection | null,
): string {
  return `overview_${branchTag(branchName)}_${periodToken(period)}${section === null ? '' : `_${section}`}.csv`;
}

// -------------------------------------------------------------------- audit --

export type OverviewExportVia = 'csv' | 'download-link';

/**
 * THE AUDIT ROW FOR AN OVERVIEW EXPORT — `reportExportAudit`'s shape and its one
 * rule: the row records the ACT, never the content. Who (from `writeAudit`), when
 * (the row's own timestamp), which section, how wide (branch, period, basis), how
 * much (`rowCount`), how (`via`). No names, no figures, `amountFils` null.
 *
 * EVERY overview export is audited, not a subset as with Reports. Reports audits
 * the two kinds whose rows name people; this file names people whenever the caller
 * holds `appointments` (upcoming customers) or `team` (artists), and which of
 * those it did depends on who asked — so the line that decides it here is "always".
 */
export function overviewExportAudit(input: {
  salonId: string;
  section: OverviewSection | null;
  branchId: string | null;
  /** The window the aggregate actually ran against — `OverviewAnalytics.window`. */
  window: { token: string; basis: 'rolling' | 'calendar' };
  rowCount: number;
  via: OverviewExportVia;
}): {
  salonId: string;
  kind: 'access';
  action: string;
  detail: string;
  source: 'merchant';
  subjectType: string;
  subjectId: string;
  metadata: Record<string, unknown>;
} {
  return {
    salonId: input.salonId,
    kind: 'access',
    action: 'Report exported',
    detail:
      `Overview analytics · ${input.section ?? 'all sections'} · ${input.branchId ?? 'all branches'} · ` +
      `${input.window.token} · ${input.rowCount} row${input.rowCount === 1 ? '' : 's'} · ${input.via}`,
    source: 'merchant',
    subjectType: 'report',
    subjectId: OVERVIEW_DOWNLOAD_KIND,
    metadata: {
      kind: OVERVIEW_DOWNLOAD_KIND,
      section: input.section,
      branchId: input.branchId,
      period: input.window.token,
      periodBasis: input.window.basis,
      rowCount: input.rowCount,
      via: input.via,
    },
  };
}
