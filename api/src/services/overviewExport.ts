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
 * "Revenue by branch" is not here, because it is not in the JSON either: that
 * widget is served by `GET /salons/{id}/reports/earnings-by-branch` and already
 * exports as `earnings-by-branch_{branch}_{period}.csv`.
 */

import type { PermissionName } from '../auth/principal';
import { badRequest } from '../http/errors';
import { minutesToHhmm, salonWallClock } from '../time/zone';
import type { OverviewAnalytics, Withheld } from './overviewAnalytics';
import { periodToken, type Period } from './period';
import { branchTag, csvMoneyCell, neutralise, quote } from './reports';

// ---------------------------------------------------------------- sections --

/**
 * The `?section=` vocabulary: the twelve block keys of the JSON, verbatim, in the
 * order the Overview draws them. A client already holds these names — they are
 * the keys it reads the JSON by.
 */
export const OVERVIEW_SECTIONS = [
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

export type OverviewSection = (typeof OVERVIEW_SECTIONS)[number];

const SECTION_SET: ReadonlySet<string> = new Set(OVERVIEW_SECTIONS);

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
function sectionTitle(section: OverviewSection, a: OverviewAnalytics): string {
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
const kd = (f: number): string => csvMoneyCell(f);

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
export function sectionRows(a: OverviewAnalytics, section: OverviewSection): OverviewCsvRow[] {
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
      const seen = new Map<string, { name: string; bookings: number; revenueFils: number; rb: number | null; rr: number | null }>();
      b.byBookings.forEach((s, i) =>
        seen.set(s.serviceId, { name: s.name, bookings: s.bookings, revenueFils: s.revenueFils, rb: i + 1, rr: null }),
      );
      b.byRevenue.forEach((s, i) => {
        const hit = seen.get(s.serviceId);
        if (hit) hit.rr = i + 1;
        else seen.set(s.serviceId, { name: s.name, bookings: s.bookings, revenueFils: s.revenueFils, rb: null, rr: i + 1 });
      });
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

/** Every requested section's rows, in the Overview's order. */
export function overviewRows(a: OverviewAnalytics, section: OverviewSection | null): OverviewCsvRow[] {
  const sections = section === null ? OVERVIEW_SECTIONS : [section];
  return sections.flatMap((s) => sectionRows(a, s));
}

/**
 * RFC 4180 the Reports way: every field quoted, `"` doubled, CRLF records, a UTF-8
 * BOM so Excel reads an Arabic service or customer name, no trailing newline. TEXT
 * cells go through `neutralise` — a salon can name a service `=HYPERLINK(...)`, and
 * so can a customer name herself. Money, counts and percents are produced above
 * and are never negative, so `neutralise` cannot touch a figure.
 */
export function overviewCsv(rows: OverviewCsvRow[]): string {
  const header = OVERVIEW_CSV_COLUMNS.map((c) => quote(c)).join(',');
  const body = rows.map((r) =>
    [r.section, r.item, r.metric, r.value, r.unit].map((v) => quote(neutralise(v))).join(','),
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
