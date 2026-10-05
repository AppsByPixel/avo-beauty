/**
 * THE OWNER CONSOLE'S ANALYTICS AS A FILE — `GET /v1/platform/analytics.csv`.
 *
 * `services/overviewExport.ts` is this file's model, and every rule it states
 * holds here unchanged:
 *
 *   ONE ANSWER, TWO RENDERINGS. Nothing here queries anything. Every row is read
 *       off a `PlatformAnalytics` that `computePlatformAnalytics` produced through
 *       the same gates the JSON applies, so the file cannot show a figure the
 *       console does not, or run a query a withheld block skipped.
 *   LONG FORMAT. `section, item, metric, value, unit`, rendered by the Overview's
 *       own `overviewCsv` — same quoting, BOM, CRLF and formula guard.
 *   MONEY is integer fils in and KD to three decimals out (`csvMoneyCell`).
 *       SHARES are basis points in and percent to two decimals out (`bpToPercent`).
 *       No float touches either.
 *   A WITHHELD BLOCK IS A ROW. `Campaigns, , withheld, permission: approvals`.
 *       A file that silently omits a block reads as a block with nothing in it.
 *
 * WHAT DIFFERS
 *
 *   A `Scope` SECTION LEADS EVERY FILE, whatever `?section=` asked for: the month,
 *       the history length, the platform zone, the salon scope and whether the
 *       month is still running. The Overview's file carries its window inside the
 *       KPI section; this one has no KPI section, and a console export forwarded
 *       to someone without its filename must still say what month it is.
 *   ONE MORE UNIT, `seconds`, for the campaign decision times.
 *   NULL LEADERBOARD CELLS are `module_off` with no unit — not an empty cell,
 *       which would read as "not measured", and not 0, which would read as a
 *       measured nothing.
 *
 * NO MEMBER PII. The JSON has none, so the file has none: the only names in it
 * are salon names, and a salon's id rides beside its name so two salons that
 * share a name are still two rows a reader can tell apart.
 */

import { fils, type Fils } from '@avo/types';
import { badRequest } from '../http/errors';
import { bpToPercent, overviewCsv } from './overviewExport';
import type { PlatformAnalytics, PlatformWithheld } from './platformAnalytics';
import { branchTag, csvMoneyCell } from './reports';

// ---------------------------------------------------------------- sections --

/** The eleven block keys of the JSON, verbatim, in the order the object carries them. */
export const PLATFORM_ANALYTICS_SECTIONS = [
  'revenue',
  'money',
  'salons',
  'members',
  'leaderboard',
  'paymentMix',
  'bookings',
  'campaigns',
  'support',
  'shop',
  'busiestTimes',
] as const;
export type PlatformAnalyticsSection = (typeof PLATFORM_ANALYTICS_SECTIONS)[number];

const SECTION_SET: ReadonlySet<string> = new Set(PLATFORM_ANALYTICS_SECTIONS);

/** Absent is every section; one known key is that one; anything else is 400 — the Overview's rule. */
export function parsePlatformSection(value: unknown): PlatformAnalyticsSection | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'string' && SECTION_SET.has(value)) return value as PlatformAnalyticsSection;
  throw badRequest('invalid_section', `section must be one of ${PLATFORM_ANALYTICS_SECTIONS.join(', ')}.`);
}

/**
 * The section column. Provisional: the console's design draws none of these
 * widgets, so the names are this file's until lane C titles the cards — and the
 * file should then take the cards' titles, as the Overview's does.
 */
export const PLATFORM_SECTION_TITLE: Record<PlatformAnalyticsSection, string> = {
  revenue: 'AVO revenue',
  money: 'Money',
  salons: 'Salons',
  members: 'Members',
  leaderboard: 'Salon leaderboard',
  paymentMix: 'Payment mix',
  bookings: 'Bookings',
  campaigns: 'Campaigns',
  support: 'Support',
  shop: 'Shop',
  busiestTimes: 'Busiest times',
};

export const SCOPE_TITLE = 'Scope';

// ----------------------------------------------------------- the download kind --

/**
 * `report_download.kind` for a console link: `platform-analytics`, or
 * `platform-analytics:<section>`. Migration 0071's CHECK ties every kind that
 * begins `platform-` to a `platform_admin_id` and no staff id, so a row this
 * module did not write cannot redeem as one.
 */
export const PLATFORM_DOWNLOAD_KIND = 'platform-analytics';

export function platformDownloadKind(section: PlatformAnalyticsSection | null): string {
  return section === null ? PLATFORM_DOWNLOAD_KIND : `${PLATFORM_DOWNLOAD_KIND}:${section}`;
}

/**
 * `undefined` — not a console row (a Reports or Overview kind). `null` — every
 * section. A section — that one. Throws on `platform-analytics:<unknown>` AND on
 * any other `platform-` kind, which only a corrupted row could hold; the
 * redemption turns either into its uniform refusal.
 */
export function parsePlatformDownloadKind(kind: string): PlatformAnalyticsSection | null | undefined {
  if (kind === PLATFORM_DOWNLOAD_KIND) return null;
  if (kind.startsWith(`${PLATFORM_DOWNLOAD_KIND}:`)) {
    const section = kind.slice(PLATFORM_DOWNLOAD_KIND.length + 1);
    if (!SECTION_SET.has(section)) throw new Error(`report_download.kind ${kind} names no section.`);
    return section as PlatformAnalyticsSection;
  }
  if (kind.startsWith('platform-')) throw new Error(`report_download.kind ${kind} is no console export.`);
  return undefined;
}

/**
 * `report_download.period` for a console link: `2026-10_12m` — the month and the
 * history length, which together are the whole window. Round-trips through
 * `parsePlatformPeriodToken`; the redemption parses it back rather than trusting
 * it, as Reports does with `parsePeriod`.
 */
export function platformPeriodToken(month: string, months: number): string {
  return `${month}_${months}m`;
}

export function parsePlatformPeriodToken(token: string): { month: string; months: number } {
  const m = /^(\d{4}-(?:0[1-9]|1[0-2]))_(\d{1,2})m$/.exec(token);
  if (!m) throw new Error(`report_download.period ${token} is no console window.`);
  return { month: m[1]!, months: Number(m[2]) };
}

// ---------------------------------------------------------------- rendering --

export type PlatformUnit = 'KD' | '%' | 'count' | 'rank' | 'stamps' | 'seconds' | '';

export interface PlatformCsvRow {
  section: string;
  item: string;
  metric: string;
  value: string;
  unit: PlatformUnit;
}

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const METHOD_LABEL = { knet: 'KNET', card: 'Card', applepay: 'Apple Pay' } as const;
const PLAN_LABEL = { starter: 'Starter', growth: 'Growth', pro: 'Pro' } as const;
const TIER_LABEL = { bronze: 'Bronze', silver: 'Silver', gold: 'Gold', black: 'Black' } as const;
const ORDER_LABEL = { preparing: 'Preparing', ready: 'Ready', closed: 'Closed' } as const;

const kd = (f: Fils): string => csvMoneyCell(fils(f));

function count(n: number): string {
  if (!Number.isSafeInteger(n) || n < 0) throw new TypeError(`A count must be a non-negative integer, got ${n}.`);
  return String(n);
}

function withheldValue(w: PlatformWithheld): string {
  return w.reason === 'permission' ? `permission: ${String(w.permission)}` : w.reason;
}

/** The rows every file starts with. See the header. */
export function scopeRows(a: PlatformAnalytics): PlatformCsvRow[] {
  const push = (metric: string, value: string, unit: PlatformUnit = '') =>
    ({ section: SCOPE_TITLE, item: '', metric, value, unit });
  return [
    push('month', a.month),
    push('history', `${a.months[0]} to ${a.months[a.months.length - 1]} (${a.months.length} months)`),
    push('timezone', a.timezone),
    push('salon', a.salonName === null ? 'All salons' : `${a.salonName} (${a.salonId})`),
    push('month to date', a.partial ? 'yes' : 'no'),
  ];
}

/** The rows of ONE section. Pure — `platformAnalyticsExport.test.ts` drives every block in both states. */
export function platformSectionRows(a: PlatformAnalytics, section: PlatformAnalyticsSection): PlatformCsvRow[] {
  const title = PLATFORM_SECTION_TITLE[section];
  const out: PlatformCsvRow[] = [];
  const push = (item: string, metric: string, value: string, unit: PlatformUnit) =>
    out.push({ section: title, item, metric, value, unit });
  const block = a[section];
  if (block.status === 'withheld') {
    return [{ section: title, item: '', metric: 'withheld', value: withheldValue(block), unit: '' }];
  }

  switch (section) {
    case 'revenue': {
      const b = a.revenue;
      if (b.status !== 'ok') break;
      push(a.month, 'commission (selected month)', kd(b.thisMonthFils), 'KD');
      push(b.priorMonth, 'commission (prior month)', kd(b.priorMonthFils), 'KD');
      for (const m of b.months) {
        push(m.month, 'commission', kd(m.feeFils), 'KD');
        push(m.month, 'top-ups', count(m.topups), 'count');
        for (const k of ['knet', 'card', 'applepay'] as const) {
          push(m.month, `${METHOD_LABEL[k]} commission`, kd(m.byMethod[k].feeFils), 'KD');
          push(m.month, `${METHOD_LABEL[k]} top-ups`, count(m.byMethod[k].topups), 'count');
        }
      }
      push('', 'note', 'KNET is a flat fee per top-up. Card and Apple Pay are on the card rate.', '');
      break;
    }

    case 'money': {
      const b = a.money;
      if (b.status !== 'ok') break;
      for (const m of b.months) {
        push(m.month, 'loaded (paid)', kd(m.loadedFils), 'KD');
        push(m.month, 'bonus credited', kd(m.bonusFils), 'KD');
        push(m.month, 'spent', kd(m.spentFils), 'KD');
      }
      push('', 'outstanding balance now', kd(b.liabilityFils), 'KD');
      for (const s of b.liabilityBySalon) {
        push(s.name, 'salon id', s.salonId, '');
        push(s.name, 'outstanding balance now', kd(s.liabilityFils), 'KD');
      }
      break;
    }

    case 'salons': {
      const b = a.salons;
      if (b.status !== 'ok') break;
      push('', 'salons', count(b.total), 'count');
      for (const p of ['starter', 'growth', 'pro'] as const) push(PLAN_LABEL[p], 'salons', count(b.byPlan[p]), 'count');
      push('', 'open branches', count(b.branches.open), 'count');
      push('', 'closed branches', count(b.branches.closed), 'count');
      for (const m of b.months) {
        push(m.month, 'new salons', count(m.newSalons), 'count');
        push(m.month, 'active salons', count(m.active), 'count');
        push(m.month, 'dormant salons', count(m.dormant), 'count');
      }
      push(
        '',
        'note',
        'Active: at least one settled transaction in the month. Dormant: on AVO by the end of the month and not active.',
        '',
      );
      break;
    }

    case 'members': {
      const b = a.members;
      if (b.status !== 'ok') break;
      push('', 'members', count(b.total), 'count');
      for (const m of b.months) {
        push(m.month, 'new members', count(m.newMembers), 'count');
        push(m.month, 'active members', count(m.activeMembers), 'count');
      }
      push('', 'tiers-mode salons', count(b.tiers.salons), 'count');
      for (const t of ['bronze', 'silver', 'gold', 'black'] as const) push(TIER_LABEL[t], 'members', count(b.tiers[t]), 'count');
      push('no tier', 'members', count(b.tiers.untiered), 'count');
      push('', 'stamps-mode salons', count(b.stamps.salons), 'count');
      for (const s of b.stamps.buckets) {
        push(`${s.stamps} of ${s.stampTarget} stamps`, 'members', count(s.members), 'count');
      }
      break;
    }

    case 'leaderboard': {
      const b = a.leaderboard;
      if (b.status !== 'ok') break;
      push('', 'salons', count(b.rows.length), 'count');
      b.rows.forEach((r, i) => {
        push(r.name, 'rank by loaded', count(i + 1), 'rank');
        push(r.name, 'salon id', r.salonId, '');
        push(r.name, 'members', count(r.members), 'count');
        push(r.name, 'active members', count(r.activeMembers), 'count');
        push(r.name, 'loaded (paid)', kd(r.loadedFils), 'KD');
        push(r.name, 'spent', kd(r.spentFils), 'KD');
        push(r.name, 'AVO revenue', kd(r.avoRevenueFils), 'KD');
        if (r.bookings === null) push(r.name, 'bookings', 'module_off', '');
        else push(r.name, 'bookings', count(r.bookings), 'count');
        if (!r.modules.booking) push(r.name, 'no-show rate', 'module_off', '');
        else push(r.name, 'no-show rate', bpToPercent(r.noShowRateBp), '%');
        if (r.shopRevenueFils === null) push(r.name, 'shop revenue', 'module_off', '');
        else push(r.name, 'shop revenue', kd(r.shopRevenueFils), 'KD');
        push(r.name, 'outstanding balance now', kd(r.liabilityFils), 'KD');
      });
      break;
    }

    case 'paymentMix': {
      const b = a.paymentMix;
      if (b.status !== 'ok') break;
      push('', 'top-ups', count(b.topups), 'count');
      push('', 'loaded (paid)', kd(b.loadedFils), 'KD');
      for (const k of ['knet', 'card', 'applepay'] as const) {
        const t = b.methods[k];
        push(METHOD_LABEL[k], 'top-ups', count(t.count), 'count');
        push(METHOD_LABEL[k], 'top-up value', kd(t.fils), 'KD');
        push(METHOD_LABEL[k], 'share of top-up value', bpToPercent(t.shareBp), '%');
      }
      break;
    }

    case 'bookings': {
      const b = a.bookings;
      if (b.status !== 'ok') break;
      push('', 'booking-module salons', count(b.salons), 'count');
      for (const m of b.months) {
        push(m.month, 'bookings', count(m.bookings), 'count');
        push(m.month, 'completed', count(m.completed), 'count');
        push(m.month, 'no-shows', count(m.noShows), 'count');
        push(m.month, 'no-show rate', bpToPercent(m.rateBp), '%');
      }
      push('', 'deposits held now', kd(b.depositsHeld.fils), 'KD');
      push('', 'deposits held now (bookings)', count(b.depositsHeld.bookings), 'count');
      break;
    }

    case 'campaigns': {
      const b = a.campaigns;
      if (b.status !== 'ok') break;
      push('', 'pending now', count(b.pendingNow), 'count');
      for (const m of b.months) {
        push(m.month, 'submitted', count(m.submitted), 'count');
        push(m.month, 'approved', count(m.approved), 'count');
        push(m.month, 'rejected', count(m.rejected), 'count');
        push(m.month, 'sent', count(m.sent), 'count');
        push(m.month, 'held', count(m.held), 'count');
        push(m.month, 'median time to decision', m.medianDecisionSeconds === null ? '' : count(m.medianDecisionSeconds), 'seconds');
        push(m.month, 'p90 time to decision', m.p90DecisionSeconds === null ? '' : count(m.p90DecisionSeconds), 'seconds');
      }
      break;
    }

    case 'support': {
      const b = a.support;
      if (b.status !== 'ok') break;
      push('', 'open now', count(b.openNow.total), 'count');
      push('AVO queue', 'open now', count(b.openNow.avo), 'count');
      push('Salon queue', 'open now', count(b.openNow.salon), 'count');
      for (const m of b.months) {
        push(m.month, 'opened', count(m.opened), 'count');
        push(m.month, 'resolved', count(m.resolved), 'count');
      }
      push('', 'note', 'First-response time is not recorded: replies go out over WhatsApp or email, outside AVO.', '');
      break;
    }

    case 'shop': {
      const b = a.shop;
      if (b.status !== 'ok') break;
      push('', 'shop-module salons', count(b.salons), 'count');
      for (const m of b.months) {
        push(m.month, 'GMV', kd(m.gmvFils), 'KD');
        push(m.month, 'orders', count(m.orders), 'count');
      }
      for (const s of ['preparing', 'ready', 'closed'] as const) {
        push(ORDER_LABEL[s], `orders placed in ${a.month}`, count(b.ordersByStatus[s]), 'count');
      }
      break;
    }

    case 'busiestTimes': {
      const b = a.busiestTimes;
      if (b.status !== 'ok') break;
      for (const c of b.cells) {
        push(`${WEEKDAY[c.weekday]} ${String(c.hour).padStart(2, '0')}:00`, 'visits', count(c.visits), 'count');
      }
      push('', 'total visits', count(b.totalVisits), 'count');
      push('', 'note', "Each visit is placed at its own salon's local weekday and hour.", '');
      break;
    }
  }
  return out;
}

/** The file's rows: the scope, then every requested section in the object's order. */
export function platformRows(a: PlatformAnalytics, section: PlatformAnalyticsSection | null): PlatformCsvRow[] {
  const wanted = section === null ? PLATFORM_ANALYTICS_SECTIONS : [section];
  return [...scopeRows(a), ...wanted.flatMap((s) => platformSectionRows(a, s))];
}

/** The Overview's renderer, unchanged. */
export function platformCsv(rows: PlatformCsvRow[]): string {
  return overviewCsv(rows);
}

/**
 * `platform-analytics_all-salons_2026-10_12m.csv`,
 * `platform-analytics_amara-beauty_2026-10_12m_leaderboard.csv`. The salon tag is
 * `branchTag`'s sanitiser (also the Content-Disposition injection guard).
 */
export function platformFilename(
  salonName: string | null,
  month: string,
  months: number,
  section: PlatformAnalyticsSection | null,
): string {
  const tag = salonName === null ? 'all-salons' : branchTag(salonName);
  return `${PLATFORM_DOWNLOAD_KIND}_${tag}_${platformPeriodToken(month, months)}${section === null ? '' : `_${section}`}.csv`;
}

// -------------------------------------------------------------------- audit --

export type PlatformExportVia = 'csv' | 'download-link';

/**
 * THE AUDIT ROW FOR A CONSOLE EXPORT — `overviewExportAudit`'s shape and rule: it
 * records the ACT, never the content. No figures, `amountFils` null.
 *
 * `salonId` IS NULL, ALWAYS — including for a `?salon=` export, whose scope is in
 * `metadata.salonId` and the detail. The act is AVO's own, on the console, so it
 * belongs to the platform log (`GET /v1/platform/audit?salon=platform`), not to
 * the salon's: a merchant's audit log is her own staff's acts and AVO's acts ON
 * her salon's settings, and reading the analytics is neither.
 */
export function platformExportAudit(input: {
  salonId: string | null;
  section: PlatformAnalyticsSection | null;
  month: string;
  months: number;
  rowCount: number;
  via: PlatformExportVia;
}): {
  salonId: null;
  kind: 'access';
  action: string;
  detail: string;
  source: 'owner_console';
  subjectType: string;
  subjectId: string;
  metadata: Record<string, unknown>;
} {
  return {
    salonId: null,
    kind: 'access',
    action: 'Report exported',
    detail:
      `Platform analytics · ${input.section ?? 'all sections'} · ${input.salonId ?? 'all salons'} · ` +
      `${input.month} (${input.months} month${input.months === 1 ? '' : 's'}) · ` +
      `${input.rowCount} row${input.rowCount === 1 ? '' : 's'} · ${input.via}`,
    source: 'owner_console',
    subjectType: 'report',
    subjectId: PLATFORM_DOWNLOAD_KIND,
    metadata: {
      kind: PLATFORM_DOWNLOAD_KIND,
      section: input.section,
      salonId: input.salonId,
      month: input.month,
      months: input.months,
      rowCount: input.rowCount,
      via: input.via,
    },
  };
}
