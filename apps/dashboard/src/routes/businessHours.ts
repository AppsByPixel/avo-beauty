import { hhmmToMinutes, type Branch } from '@avo/types';

/**
 * Business hours as the server TRADES them — shared by Settings → Business hours
 * (the salon's) and Settings → Branches (a branch's own, or the salon's it
 * inherits).
 *
 * A SPAN WITH `to <= from` IS NOT A WINDOW. `tradingSpans`
 * (`api/src/services/availability.ts`) drops it, which makes
 * `evening: ["21:00", "21:00"]` the ESTABLISHED way to say "no second sitting" —
 * `BusinessHoursSchema`'s own comment in `packages/types` argues it, and
 * `BranchSchema.businessHours` says to render the spans the way the server
 * trades them. So a salon open straight through must not be shown a phantom
 * "Evening 21:00 – 21:00", and that is what this module exists to prevent in one
 * place rather than at each render.
 *
 * `hhmmToMinutes` from `@avo/types`, not a local split: the parse of a clock is
 * a shared rule, and "24:00" reads as 1440 — end of day — through it.
 */
export type BusinessHours = Branch['businessHours'];
export type Span = BusinessHours['morning'];
export type Session = 'morning' | 'evening';

export function isWindow([from, to]: Span): boolean {
  return hhmmToMinutes(to) > hhmmToMinutes(from);
}

/** "10:00–13:00 · 16:00–21:00", or one window, or nothing at all. */
export function describeHours(hours: BusinessHours): string {
  const open = [hours.morning, hours.evening].filter(isWindow);
  if (open.length === 0) return 'Closed all day';
  return open.map(([from, to]) => `${from}–${to}`).join(' · ');
}

/** End of day is a close, never an open — `parseBusinessHours` refuses a session opening at 24:00. */
export const END_OF_DAY = 24 * 60;

export function minutesToClock(minutes: number): string {
  const clamped = Math.max(0, Math.min(END_OF_DAY, minutes));
  return `${String(Math.floor(clamped / 60)).padStart(2, '0')}:${String(clamped % 60).padStart(2, '0')}`;
}

/**
 * The evening a salon "open straight through" writes: a zero-length span at the
 * morning's close, the established spelling. At a midnight close the pair would
 * be `["24:00","24:00"]`, and the server refuses a session OPENING at 24:00, so
 * that one case is written `["00:00","00:00"]` — still `to <= from`, still no
 * evening.
 */
export function noEvening(morning: Span): Span {
  const close = morning[1];
  return close === '24:00' ? ['00:00', '00:00'] : [close, close];
}
