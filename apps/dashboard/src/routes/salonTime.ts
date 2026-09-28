import { localDate, shiftDate } from './salesTrendRules.js';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A WALL CLOCK ON THE MERCHANT DASHBOARD IS THE SALON'S CLOCK, NOT THE VIEWER'S
 * ═══════════════════════════════════════════════════════════════════════════
 * Found live: SAL-AMARA (`Asia/Kuwait`, +03:00) viewed from a Mac in Pakistan
 * (+05:00). BK-10000005 starts at `2026-09-30T07:00:00Z` — 10:00 in Kuwait — and
 * the Appointments list drew "30 Sept · 12:00 PM", while `AppointmentForm`
 * builds the same instant FROM the salon's zone and labels its field
 * `Time (Asia/Kuwait)`. A merchant who typed 10:00 read 12:00 back. Nobody in
 * Kuwait could see it, which is exactly why it shipped.
 *
 * `toLocaleTimeString` with no `timeZone` formats in the BROWSER's zone, and
 * `new Date(y, m, d)` is the browser's midnight. Both answer a question about
 * where the reader is sitting, and every label on this dashboard is a question
 * about the salon. So every label goes through here, and this module takes the
 * zone as an argument rather than reading one: there is no default to forget.
 *
 * THE DAY ARITHMETIC IS `salesTrendRules.ts`' — `localDate` reads an instant's
 * calendar date IN a zone, and `shiftDate` steps a decided date by whole days
 * at UTC midnight. "Today" is `localDate(now, zone)`, so today means today in
 * the salon, and 22:30 in Kuwait is still "Today" there while Karachi is
 * already on tomorrow. Reused, not rewritten: the week grid and the sales chart
 * already draw their days with the same two functions, and three definitions of
 * "which day is this" is how two screens come to disagree about one booking.
 */

/**
 * The zone a label is drawn in, and whether it has to say so.
 *
 * AN UNUSABLE ZONE FALLS BACK TO UTC AND NAMES IT — never to the browser's.
 * `makeZoneClock` and `localDate` refuse the browser's zone for the reason this
 * whole module exists: it is the silent wrong answer. A row still has to say
 * SOMETHING, though, and unlike a grid column there is no "which day" decision
 * riding on it — so it says the true instant in a frame it names ("10:00 UTC")
 * rather than a guess it does not. `null` is the same case: a salon read that
 * has not landed yet. `salon.timezone` is required on the wire, so outside that
 * tick this arm is reached only by a zone id the engine does not know.
 */
export interface ClockFrame {
  zone: string;
  /** `' UTC'` when the salon's own zone could not be used, else `''`. */
  suffix: '' | ' UTC';
}

export function clockFrame(timezone: string | null): ClockFrame {
  if (timezone !== null && localDate(new Date(0), timezone) !== null) {
    return { zone: timezone, suffix: '' };
  }
  return { zone: 'UTC', suffix: ' UTC' };
}

/**
 * The viewer's own IANA zone. For the owner console ONLY, where rows span many
 * salons in many zones and the reader's clock is the one frame they all share —
 * see `AuditLog.tsx § whenLabel`. Named at the call site so that choosing it is
 * visible, rather than being what happens when a zone is left out.
 */
export function viewerZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export type RelativeDay = 'today' | 'yesterday' | 'tomorrow' | 'other';

/** Which day `at` is relative to `now`, both read in `zone`. `null` on an unreadable instant. */
export function relativeDay(at: Date, now: Date, zone: string): RelativeDay | null {
  const day = localDate(at, zone);
  const today = localDate(now, zone);
  if (day === null || today === null) return null;
  if (day === today) return 'today';
  if (day === shiftDate(today, -1)) return 'yesterday';
  if (day === shiftDate(today, 1)) return 'tomorrow';
  return 'other';
}

/** "10:00 AM" — the 12-hour clock the Appointments board speaks. */
export function clock12(at: Date, frame: ClockFrame): string {
  return (
    at.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZone: frame.zone,
    }) + frame.suffix
  );
}

/** "14:05" — the 24-hour clock the feeds and the audit log speak. */
export function clock24(at: Date, frame: ClockFrame): string {
  return (
    at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: frame.zone }) +
    frame.suffix
  );
}

/** "30 Sept" — the day-and-month every "· time" label leads with past Tomorrow. */
export function dayMonth(at: Date, frame: ClockFrame): string {
  return at.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: frame.zone });
}
