import type { OverviewAnalytics } from '@avo/types';
import { formatWindowDay } from '../api/reports.js';
import { barPermille } from './salesTrendRules.js';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE OVERVIEW'S ANALYTICS GRID — EVERY RULE THE WIDGETS RENDER, AS PLAIN
 * FUNCTIONS. NEW WORK: THE DESIGN BUNDLE DRAWS NONE OF THESE WIDGETS.
 * ═══════════════════════════════════════════════════════════════════════════
 * Aftab, 2026-09-29: "dashboard has only one graph widget and it looks so empty
 * otherwise. Fill it with various useful visuals and analytics (at least 10)".
 * `OverviewAnalytics.tsx` draws them; the decisions they rest on live here, so a
 * test can hold each one without mounting a card.
 *
 * NO FLOAT TOUCHES MONEY OR A SHARE (#1). Every figure on the wire is an integer
 * — fils, counts, basis points — and this file keeps it one. Bar lengths are the
 * ONE place a ratio is taken, and they are integer permille for LAYOUT
 * (`salesTrendRules.ts § barPermille`, reused): a bar's width is not a figure
 * anybody reads, the number printed beside it is.
 */

export type Block<K extends keyof OverviewAnalytics> = OverviewAnalytics[K];

/** `{ status: 'withheld', … }`, whichever block it came from. */
export interface WithheldBlock {
  status: 'withheld';
  reason: 'permission' | 'module_off' | 'not_per_branch';
  permission: string | null;
}

export function isWithheld(block: { status: string }): block is WithheldBlock {
  return block.status === 'withheld';
}

/* ----------------------------------------------------------- basis points -- */

/**
 * `1250` → `"12.5%"`, `1234` → `"12.34%"`, `1200` → `"12%"`.
 *
 * BASIS POINTS DIVIDED BY 100 IN FORMATTING ONLY, and in integers: the whole
 * percent is `bp / 100` floored and the fraction is `bp % 100` padded, so there
 * is no `bp / 100` float to round wrongly. The server rounded half up once, in
 * BigInt (`overviewAnalytics.ts § basisPoints`); a second rounding here would be
 * a second answer. Trailing zeros are trimmed so "12.50%" reads as "12.5%".
 *
 * NULL IS "NO DENOMINATOR", NOT ZERO — the server's own distinction — and is the
 * caller's to render as a sentence. This function does not accept it.
 */
export function formatBp(bp: number): string {
  if (!Number.isInteger(bp) || bp < 0) return '—';
  const whole = Math.floor(bp / 100);
  const frac = bp % 100;
  if (frac === 0) return `${whole}%`;
  const two = String(frac).padStart(2, '0');
  return `${whole}.${two.endsWith('0') ? two.slice(0, 1) : two}%`;
}

/* ------------------------------------------------------------------- bars -- */

/** The longest bar in a series. Zero for an empty series, so every bar draws at 0. */
export function peakOf(values: readonly number[]): number {
  return values.reduce((top, v) => (v > top ? v : top), 0);
}

/** A bar's width as a CSS percentage string — integer permille, for layout only. */
export function barWidth(value: number, peak: number): string {
  return `${barPermille(value, peak) / 10}%`;
}

/* ------------------------------------------------------ how much is a guess -- */

/**
 * "Branch assumed on 2 of 9 visits — treat these branch figures as approximate."
 *
 * THE OVERVIEW'S OWN SENTENCE, VERBATIM (`Overview.tsx § AssumedNote`), one
 * clause long because each block carries one `{ assumed, total }`. And it
 * disappears on its own for that component's reason: null at all branches, null
 * when nothing was inferred — so the day branch-bound tills land, every note
 * leaves the grid with no code change.
 */
export function doubtNote(
  doubt: { assumed: number; total: number } | null,
  noun: string,
): string | null {
  if (doubt === null || doubt.assumed <= 0 || doubt.total <= 0) return null;
  return `Branch assumed on ${doubt.assumed} of ${doubt.total} ${noun} — treat these branch figures as approximate.`;
}

/* --------------------------------------------------------- busiest times -- */

export const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
export const WEEKDAY_LONG = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

/** `9` → `"09:00"`. The 24-hour clock the feeds speak. */
export function hourLabel(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`;
}

export interface HeatCell {
  hour: number;
  visits: number;
  /** 0 = nothing; 1–4 = quarters of the busiest cell, rounded UP so one visit shows. */
  level: 0 | 1 | 2 | 3 | 4;
}

export interface HeatRow {
  weekday: number;
  cells: HeatCell[];
}

export interface HeatGrid {
  /** The hour columns drawn, contiguous, first to last hour that saw a visit. */
  hours: number[];
  rows: HeatRow[];
  peak: number;
}

/**
 * THE SPARSE CELLS, AS A GRID — IN THE SALON'S CLOCK, BECAUSE THE SERVER ALREADY
 * PUT THEM THERE.
 *
 * `weekday` and `hour` arrive in the SALON'S zone (`AT TIME ZONE` inside
 * Postgres), so this function does NO zone arithmetic and must not: a
 * `new Date()` anywhere here would re-read them in the browser's zone and move a
 * Kuwait 21:00 into Karachi's 23:00 column — the exact defect `salonTime.ts`
 * exists to stop. They are already wall-clock facts; they are placed, not
 * converted.
 *
 * ALL SEVEN DAYS, Sunday first (the Gulf week, and `weekday 0` on the wire).
 * THE HOURS ARE TRIMMED to the first and last hour anything happened, and filled
 * contiguously between — a salon open 10:00–22:00 does not need fourteen empty
 * columns of night, and a gap in the middle is a real quiet hour that must stay
 * visible as one.
 */
export function heatGrid(cells: ReadonlyArray<{ weekday: number; hour: number; visits: number }>): HeatGrid {
  const peak = peakOf(cells.map((c) => c.visits));
  if (cells.length === 0) return { hours: [], rows: [], peak: 0 };
  const first = Math.min(...cells.map((c) => c.hour));
  const last = Math.max(...cells.map((c) => c.hour));
  const hours = Array.from({ length: last - first + 1 }, (_, i) => first + i);
  const at = new Map(cells.map((c) => [`${c.weekday}:${c.hour}`, c.visits]));
  const rows = WEEKDAY_SHORT.map((_, weekday) => ({
    weekday,
    cells: hours.map((hour) => {
      const visits = at.get(`${weekday}:${hour}`) ?? 0;
      return { hour, visits, level: heatLevel(visits, peak) };
    }),
  }));
  return { hours, rows, peak };
}

/**
 * Integer quarters of the peak, rounded UP: `ceil(4v / peak)` as
 * `floor((4v + peak - 1) / peak)`. One visit in a week of forty is level 1, not
 * level 0 — a visit that happened must never draw as a visit that did not.
 */
export function heatLevel(visits: number, peak: number): HeatCell['level'] {
  if (visits <= 0 || peak <= 0) return 0;
  const q = Math.floor((4 * visits + peak - 1) / peak);
  return Math.min(4, Math.max(1, q)) as HeatCell['level'];
}

/** The busiest cell, for the sentence a sighted reader gets from the darkest square. */
export function busiestOf(
  cells: ReadonlyArray<{ weekday: number; hour: number; visits: number }>,
): { weekday: number; hour: number; visits: number } | null {
  let best: { weekday: number; hour: number; visits: number } | null = null;
  for (const c of cells) {
    if (
      best === null ||
      c.visits > best.visits ||
      (c.visits === best.visits && (c.weekday < best.weekday || (c.weekday === best.weekday && c.hour < best.hour)))
    ) {
      best = c;
    }
  }
  return best;
}

/* ------------------------------------------------------------ new members -- */

/** `2026-09-13` → `13 Sep`. A salon-local calendar date, reformatted as text — never re-zoned. */
export function weekLabel(ymd: string): string {
  return formatWindowDay(ymd).replace(/ \d{4}$/, '');
}

/* ------------------------------------------------------------ plurals ----- */

export function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

/* ------------------------------------------------- not_per_branch reasons -- */

/**
 * WHY A BLOCK HAS NO PER-BRANCH ANSWER, in the merchant's terms. The KPI row's
 * "Top-ups happen in the app, not at a branch" is the precedent and is reused
 * verbatim for the two top-up blocks; the other three say the same kind of thing
 * about their own subject.
 */
export const SALON_WIDE_REASON = {
  newMembers: 'A customer joins the salon, not a branch',
  loyalty: 'Tiers and stamp cards belong to the salon, not a branch',
  wallet: 'Top-ups happen in the app, not at a branch',
  paymentMix: 'Top-ups happen in the app, not at a branch',
  campaigns: 'A campaign reaches customers, not a branch',
} as const;

/** The section a permission-withheld block belongs to, as the merchant knows it. */
export const PERMISSION_SECTION: Record<string, string> = {
  appointments: 'appointments',
  team: 'the team',
  shop: 'the shop',
  marketing: 'marketing',
  loyalty: 'loyalty',
  dashboard: 'the overview',
};

/**
 * "a", "a and b", "a, b and c" — an Oxford-comma-free list, as the copy elsewhere
 * sets.
 *
 * MOVED HERE FROM `Overview.tsx`, WHICH RE-EXPORTS IT, so the analytics grid can
 * print the same "Branch assumed on {…}" sentence with the same list grammar
 * without importing the screen that mounts it. One implementation still; the
 * import path is the only thing that moved. `Reports.tsx § BranchAssumedCaveat`
 * reads it through the re-export, unchanged.
 */
export function joinClauses(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}
