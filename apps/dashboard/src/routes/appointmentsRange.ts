import type { BookingRange } from '../api/bookings.js';
import { formatWindowDay } from '../api/reports.js';
import { makeZoneClock, weekWindow } from './appointmentsWeekRules.js';
import { enumerateDays, localDate, shiftDate } from './salesTrendRules.js';
import { clockFrame } from './salonTime.js';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Merchant → Appointments → List → the date filter. Aftab, 2026-09-29: "Date
 * filters in appointments screen".
 * ═══════════════════════════════════════════════════════════════════════════
 * NEW WORK; THE DESIGN DRAWS NO FILTER ON THIS SCREEN. The control is
 * `Reports.tsx`' period control in shape — a `Segmented` whose last option is
 * "Dates" and opens two date fields — so the dashboard has one way of asking
 * for a window rather than two.
 *
 * THE DAYS ARE THE SALON'S. "Today" is `localDate(now, zone)` in the salon's
 * zone, so at 22:30 in Kuwait it is still Kuwait's today even for a manager
 * reading from Karachi, where it is already tomorrow. `salonTime.ts` has the
 * argument; `clockFrame` is its rule for a zone `Intl` cannot use (UTC, and
 * named — never the browser's).
 *
 * "THIS WEEK" IS THE WEEK GRID'S WEEK, through the same `weekWindow`, so the
 * list filtered to This week and the Week view's "This week" name the same
 * seven days. Two definitions of "this week" on one screen is how a merchant
 * comes to count a booking twice or not at all.
 *
 * THE SERVER APPLIES THE RANGE. This module only decides which two salon-local
 * dates to ask for; `GET /salons/{id}/bookings?from=&to=` resolves them against
 * the salon's zone and filters the query. See `api/bookings.ts § BookingRange`.
 */

export type RangePreset = 'all' | 'today' | 'tomorrow' | 'week' | 'custom';

export interface RangeSelection {
  preset: RangePreset;
  /** The two date fields' own values, kept while another preset is chosen. */
  from: string;
  to: string;
}

export const ALL_DATES: RangeSelection = { preset: 'all', from: '', to: '' };

/** `routes/salons.ts` → `services/period.ts § MAX_RANGE_DAYS`. The server refuses past it. */
export const MAX_RANGE_DAYS = 366;

export type ResolvedRange =
  /** No filter: the request the list always made. */
  | { kind: 'all' }
  | { kind: 'range'; range: BookingRange }
  /** "Dates" chosen and a field still blank. Nothing is asked yet. */
  | { kind: 'incomplete' }
  /** Both fields filled and the pair cannot be asked for. The sentence says why. */
  | { kind: 'invalid'; message: string };

const YMD = /^\d{4}-\d{2}-\d{2}$/;

export function resolveRange(
  selection: RangeSelection,
  timezone: string | null,
  now: Date,
): ResolvedRange {
  if (selection.preset === 'all') return { kind: 'all' };

  if (selection.preset === 'custom') {
    const { from, to } = selection;
    if (!YMD.test(from) || !YMD.test(to)) return { kind: 'incomplete' };
    if (to < from) {
      return { kind: 'invalid', message: 'The start date is after the end date.' };
    }
    if (enumerateDays(from, to).length > MAX_RANGE_DAYS) {
      return { kind: 'invalid', message: `Pick a range of ${MAX_RANGE_DAYS} days or fewer.` };
    }
    return { kind: 'range', range: { from, to } };
  }

  const { zone } = clockFrame(timezone);
  const today = localDate(now, zone);
  if (today === null) return { kind: 'incomplete' };

  if (selection.preset === 'today') return { kind: 'range', range: { from: today, to: today } };
  if (selection.preset === 'tomorrow') {
    const tomorrow = shiftDate(today, 1);
    return { kind: 'range', range: { from: tomorrow, to: tomorrow } };
  }

  const clock = makeZoneClock(zone);
  const week = clock === null ? null : weekWindow(clock, now, 0);
  if (week === null) return { kind: 'incomplete' };
  return { kind: 'range', range: { from: week.from, to: week.to } };
}

/** "on 29 Sep 2026" / "between 27 Sep 2026 and 3 Oct 2026" — the empty state's clause. */
export function rangeClause(range: BookingRange): string {
  return range.from === range.to
    ? `on ${formatWindowDay(range.from)}`
    : `between ${formatWindowDay(range.from)} and ${formatWindowDay(range.to)}`;
}
