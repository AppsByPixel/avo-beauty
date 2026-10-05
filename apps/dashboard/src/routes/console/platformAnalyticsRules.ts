import type { PlatformAnalytics } from '../../api/platformAnalytics.js';
import type { PlatformSalon } from '../../api/platformSalons.js';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * OWNER CONSOLE → ANALYTICS — EVERY RULE THE PAGE RENDERS, AS PLAIN FUNCTIONS.
 * ═══════════════════════════════════════════════════════════════════════════
 * Aftab, 2026-10-05: "The way we added so much graphs and valuable analytics for
 * the merchant dashboard, we need to do similar for the admin console."
 * `console/Analytics.tsx` draws the cards; the decisions they rest on live here,
 * so a test can hold each one without mounting anything — the split
 * `overviewAnalyticsRules.ts` makes for the merchant grid, whose bar, heat-map,
 * basis-point and plural rules are imported rather than repeated.
 *
 * NO FLOAT TOUCHES MONEY (#1). Every figure on the wire is an integer — fils,
 * counts, basis points, seconds — and nothing here turns one into a float. The
 * two ratios taken are presentation: a bar's pixel height (`barPx`, integer) and
 * the month-on-month percentage on the revenue tile (`momentum`, an integer
 * percent), neither of which is a money figure anybody reconciles.
 */

/* ----------------------------------------------------------------- months -- */

const MONTH_KEY = /^(\d{4})-(0[1-9]|1[0-2])$/;

export const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
export const MONTH_LONG = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

function parts(key: string): { year: number; month: number } | null {
  const m = MONTH_KEY.exec(key);
  return m ? { year: Number(m[1]), month: Number(m[2]) } : null;
}

/** `2026-10` → `Oct`. The raw string back for anything that is not a month key. */
export function monthShort(key: string): string {
  const p = parts(key);
  return p ? MONTH_SHORT[p.month - 1]! : key;
}

/** `2026-10` → `Oct 2026`. */
export function monthShortYear(key: string): string {
  const p = parts(key);
  return p ? `${MONTH_SHORT[p.month - 1]!} ${p.year}` : key;
}

/** `2026-10` → `October 2026`. */
export function monthLong(key: string): string {
  const p = parts(key);
  return p ? `${MONTH_LONG[p.month - 1]!} ${p.year}` : key;
}

/** `2026-10` shifted by `n` months (negative is earlier). Integer arithmetic on the key. */
export function shiftMonthKey(key: string, n: number): string {
  const p = parts(key);
  if (!p) return key;
  const i = p.year * 12 + (p.month - 1) + n;
  const year = Math.floor(i / 12);
  const month = (i % 12) + 1;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`;
}

/**
 * THE CALENDAR MONTH AN INSTANT FALLS IN, IN A ZONE — `YYYY-MM`.
 *
 * The server buckets every month in `PLATFORM_TIMEZONE` and serves the zone on
 * the payload (`timezone`), so once a payload has landed this is asked in THAT
 * zone and the month picker agrees with the server about which month is
 * current. Before one has, the browser's own zone (`zone` null) — at worst a
 * few hours at a month boundary, in which a picked month after the server's
 * current one is refused by the server by name (400 `invalid_month`) and the
 * sentence is printed.
 *
 * `formatToParts` rather than a locale's string, `salesTrendRules.ts § localDate`'s
 * reason. An unknown zone falls back to the browser's rather than throwing: a
 * picker is not worth an error boundary, and the server re-validates.
 */
export function monthOf(at: Date, zone: string | null): string {
  const fmt = (timeZone: string | undefined) =>
    new Intl.DateTimeFormat('en-US', {
      ...(timeZone ? { timeZone } : {}),
      year: 'numeric',
      month: '2-digit',
    }).formatToParts(at);
  let p: Intl.DateTimeFormatPart[];
  try {
    p = fmt(zone ?? undefined);
  } catch {
    p = fmt(undefined);
  }
  const get = (t: Intl.DateTimeFormatPartTypes) => p.find((x) => x.type === t)?.value ?? '';
  return `${get('year').padStart(4, '0')}-${get('month')}`;
}

/** How many months back the month picker reaches — the server's history ceiling. */
export const MONTH_PICKER_SPAN = 24;

/** The months the picker offers, newest first, ending at `current`. */
export function monthOptions(current: string, span = MONTH_PICKER_SPAN): string[] {
  return Array.from({ length: span }, (_, i) => shiftMonthKey(current, -i));
}

/**
 * `?month=` FROM THE URL. A URL is input: anything that is not a month key, or
 * is after the current month, reads as "not set" (the server's current month)
 * rather than as a request the server will refuse — the `listFilters.ts` rule.
 * The current month itself also reads as not set, so the default view has one
 * URL.
 */
export function monthParam(raw: string, current: string): string | null {
  if (!MONTH_KEY.test(raw)) return null;
  if (raw >= current) return null;
  return raw;
}

/**
 * THE HISTORY WINDOWS ON OFFER. The server takes 1–24 and defaults to 12; the
 * picker offers three, so a trend is always long enough to be a shape and the
 * default is one of them. `''` in the URL is the server's default.
 */
export const HISTORY_WINDOWS = ['6', '12', '24'] as const;
export const DEFAULT_HISTORY = '12';

export function monthsParam(raw: string): number | null {
  if (raw === '' || raw === DEFAULT_HISTORY) return null;
  return (HISTORY_WINDOWS as readonly string[]).includes(raw) ? Number(raw) : null;
}

/* ----------------------------------------------------------------- salons -- */

/**
 * `?salon=` FROM THE URL, RESOLVED AGAINST THE SALONS THAT EXIST —
 * `salonParam.ts § resolveSalonParam`, with ONE difference, and it is the
 * analyst.
 *
 * `GET /v1/platform/salons` is gated `salons`, and the analyst preset holds
 * `analytics` without it. `resolveSalonParam` ignores the id whenever the list
 * failed, which on the other console screens is right (they all gate on
 * `salons` or close to it) and here would make every `?salon=` link dead for the
 * one role this screen is FOR. So a failed list SENDS the id and lets the server
 * check it: an unknown one is a 404 `unknown_salon`, printed by name, with the
 * filter that caused it still on screen and Clear beside it.
 *
 * While the list is still walking the read WAITS, the original rule's reason: a
 * flash of every salon's figures under a link to one is the wrong answer shown
 * first. A finished list that does not contain the id ignores it.
 */
export function resolveAnalyticsSalon(
  raw: string,
  list: { salons: readonly PlatformSalon[]; isError: boolean; complete: boolean },
): { salonId: string | null; waiting: boolean } {
  if (raw === '') return { salonId: null, waiting: false };
  if (list.salons.some((s) => s.id === raw)) return { salonId: raw, waiting: false };
  if (list.isError) return { salonId: raw, waiting: false };
  if (!list.complete) return { salonId: null, waiting: true };
  return { salonId: null, waiting: false };
}

/**
 * THE SALON PICKER'S OPTIONS. The salon list when this admin can read it; when
 * she cannot (the analyst — above), the salons the answer itself names: every
 * leaderboard row of an all-salons answer, and the scoped salon of a scoped one.
 * Sorted by name, so the menu does not reorder when the leaderboard does.
 */
export function salonOptions(
  list: readonly PlatformSalon[],
  data: PlatformAnalytics | undefined,
): Array<{ value: string; label: string }> {
  const named = new Map<string, string>();
  for (const s of list) named.set(s.id, s.name);
  if (named.size === 0 && data) {
    if (data.leaderboard.status === 'ok') {
      for (const r of data.leaderboard.rows) named.set(r.salonId, r.name);
    }
    if (data.salonId !== null) named.set(data.salonId, data.salonName ?? data.salonId);
  }
  return [...named]
    .map(([value, label]) => ({ value, label }))
    .sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
}

/* ------------------------------------------------------------ the figures -- */

/** The last entry of a month series — the SELECTED month, which ends every history. */
export function selectedOf<T>(months: readonly T[]): T | undefined {
  return months[months.length - 1];
}

/**
 * "+9% MoM" — an integer percent, OMITTED (null) when the prior month is zero:
 * a change against nothing is undefined, not "+100%", and on a first-month
 * platform that is the normal case. The old Analytics page's rule, kept.
 */
export function momentum(now: number, before: number): string | null {
  if (before <= 0) return null;
  const pct = Math.round(((now - before) * 100) / before);
  return `${pct >= 0 ? '+' : ''}${pct}% MoM`;
}

/** The design's own bar height budget, in px (`AVO Owner Console.dc.html § ANALYTICS`). */
export const BAR_MAX_PX = 128;

/**
 * A bar's height in whole pixels: a share of the tallest bar, which is what the
 * design does (`Math.round((v / bmax) * 128)`). Geometry, not money — the figure
 * a bar stands for is printed and read out from the integer, never from this.
 * Zero for a zero peak, so an all-zero series draws baselines rather than NaN.
 */
export function barPx(value: number, peak: number): number {
  if (peak <= 0 || value <= 0) return 0;
  return Math.round((value * BAR_MAX_PX) / peak);
}

/** True when every value in a series is zero (or the series is empty). */
export function allZero(values: readonly number[]): boolean {
  return values.every((v) => v === 0);
}

/**
 * A decision time in whole seconds, as a person reads one: `45s`, `12m`,
 * `4h 12m`, `2d 3h`. Integer division only. The server rounds to whole seconds
 * and serves null for "nothing was decided", which the caller renders as a dash.
 */
export function durationLabel(seconds: number): string {
  if (!Number.isInteger(seconds) || seconds < 0) return '—';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return hours % 24 === 0 ? `${days}d` : `${days}d ${hours % 24}h`;
}

/* ------------------------------------------------------------ leaderboard -- */

export type LeaderboardRow = Extract<PlatformAnalytics['leaderboard'], { status: 'ok' }>['rows'][number];
export type LeaderboardSort = 'loaded' | 'spent' | 'revenue' | 'members';

const SORT_FIELD = {
  loaded: 'loadedFils',
  spent: 'spentFils',
  revenue: 'avoRevenueFils',
  members: 'members',
} as const satisfies Record<LeaderboardSort, keyof LeaderboardRow>;

export function sortValue(row: LeaderboardRow, by: LeaderboardSort): number {
  return row[SORT_FIELD[by]];
}

/**
 * THE SERVER SORTS BY LOADED; THE CARD CAN RANK BY THREE MORE. A copy, sorted
 * descending on integers with the salon NAME as the tie-break, then the id —
 * so two salons on 0.000 sit in the same order every render.
 */
export function rankLeaderboard(rows: readonly LeaderboardRow[], by: LeaderboardSort): LeaderboardRow[] {
  return [...rows].sort((a, b) => {
    const d = sortValue(b, by) - sortValue(a, by);
    if (d !== 0) return d;
    if (a.name !== b.name) return a.name < b.name ? -1 : 1;
    return a.salonId < b.salonId ? -1 : a.salonId > b.salonId ? 1 : 0;
  });
}

/** How many rows a ranked list draws before "Show N more" — the design's five. */
export const RANKED_VISIBLE = 5;

/* --------------------------------------------------------------- withheld -- */

export type PlatformBlockKey = Exclude<
  keyof PlatformAnalytics,
  'asOf' | 'timezone' | 'month' | 'partial' | 'months' | 'salonId' | 'salonName'
>;

export interface PlatformWithheld {
  status: 'withheld';
  reason: 'permission' | 'module_off';
  permission: string | null;
}

export function isWithheld(block: { status: string }): block is PlatformWithheld {
  return block.status === 'withheld';
}

/** The console section a block is withheld for, as the sidebar names it (`consoleNavItems.tsx`). */
export const SECTION_LABEL: Record<string, string> = {
  analytics: 'Analytics',
  activity: 'Activity',
  salons: 'Salons',
  accounts: 'Accounts',
  admins: 'Admins',
  controls: 'Controls',
  approvals: 'Approvals',
  policies: 'Policies',
  audit: 'Audit log',
};

/**
 * WHAT A WITHHELD CARD SAYS INSTEAD OF A FIGURE — never a zero.
 *
 * `permission`: which console section she lacks, by its sidebar name, and what
 * that keeps from her — so "no access" is not mistaken for "no campaigns".
 *
 * `module_off` only happens with one salon picked (across every salon both
 * blocks cover the salons with the module on): that salon does not run the
 * module, by name, and how to see the platform's figure instead.
 */
export function withheldCopy(
  key: PlatformBlockKey,
  block: PlatformWithheld,
  salonName: string | null,
): string {
  if (block.reason === 'permission') {
    const section = SECTION_LABEL[block.permission ?? ''] ?? 'this section';
    return `You don't have access to ${section}, so these figures aren't shown.`;
  }
  const who = salonName ?? 'This salon';
  if (key === 'bookings') return `${who} doesn't take bookings through AVO. Choose All salons to see bookings across the platform.`;
  if (key === 'shop') return `${who} doesn't run the AVO shop. Choose All salons to see shop orders across the platform.`;
  return `${who} doesn't use this module. Choose All salons to see the platform's figures.`;
}

/**
 * The same answer in a KPI tile's one muted line, under a dash. A tile is too
 * narrow for the sentence; it names the cause and the card below it says the rest.
 */
export function withheldShort(block: { status: string; reason?: string; permission?: string | null }): string {
  if (block.reason === 'permission') {
    return `No access to ${SECTION_LABEL[block.permission ?? ''] ?? 'this section'}`;
  }
  return 'Not run by this salon';
}

/* ----------------------------------------------------------------- labels -- */

export const METHOD_LABEL = { knet: 'KNET', card: 'Card', applepay: 'Apple Pay' } as const;
export const METHODS = ['knet', 'card', 'applepay'] as const;

export const PLAN_LABEL = { starter: 'Starter', growth: 'Growth', pro: 'Pro' } as const;
export const PLANS = ['starter', 'growth', 'pro'] as const;

export const TIERS = ['bronze', 'silver', 'gold', 'black'] as const;
export const TIER_LABEL = { bronze: 'Bronze', silver: 'Silver', gold: 'Gold', black: 'Black' } as const;

export const ORDER_STATUS_LABEL = { preparing: 'Preparing', ready: 'Ready', closed: 'Closed' } as const;
export const ORDER_STATUSES = ['preparing', 'ready', 'closed'] as const;
