/**
 * The salon's clock, for every time the scanner draws.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY THIS MODULE EXISTS
 *
 * Two screens read time, and until 2026-09-28 they read it two wrong ways:
 *
 *   ChargesScreen   `toLocaleTimeString` / `toLocaleDateString` with no zone —
 *                   the DEVICE's clock. A counter phone left on the wrong zone
 *                   stamped every charge hours out, and the header named the
 *                   device's weekday over a list the server scoped to the
 *                   salon's day.
 *   BookingsScreen  a hard-coded `Asia/Kuwait`. Right for every salon signed so
 *                   far, an hour early on the first one in Dubai.
 *
 * Both now take `salon.timezone` (IANA, `packages/types` Salon, default
 * `Asia/Kuwait` — DECISIONS.md § "Salon timezone"), resolved once in
 * `ScannerFlow` and passed down. The dashboard fixed the same bug in 60a4b3f;
 * the wallet in the same slice as this file.
 *
 * Pure functions, no React Native, so the node-environment vitest can pin them.
 * ═════════════════════════════════════════════════════════════════════════════
 */

/**
 * The zone used ONLY while the salon has not loaded — `fetchSalonLoyalty` is in
 * flight, or failed (ScannerFlow treats that as non-fatal). It is the contract's
 * own default for `Salon.timezone`, and it is what BookingsScreen hard-coded
 * before this module, so a screen reached before the salon lands reads exactly
 * as it did. It is never the device's zone: that is the one value certainly not
 * the salon's.
 */
export const FALLBACK_SALON_TIME_ZONE = 'Asia/Kuwait';

/**
 * "2026-09-30" — the salon's calendar date for an instant.
 * `en-CA` because its short date is already ISO-ordered.
 */
export function salonDate(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

/**
 * The calendar day after "YYYY-MM-DD". Calendar arithmetic in UTC, so no DST
 * transition can repeat or skip a day — `now + 24h` is the version that does.
 */
export function nextCalendarDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + 1)).toISOString().slice(0, 10);
}

/** "Sun 13 Jul" — BookingsScreen's day heading shape (design:692-700). */
export function weekdayLabel(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone,
  }).format(new Date(iso));
}

/** "2:30 pm" — a booking card's time, design:693. */
export function clockLabel(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone,
  }).format(new Date(iso));
}

/**
 * "14:05" — a charge row's time and the void note's. The options are the ones
 * `toLocaleTimeString` was given before; only the zone is new.
 */
export function chargeTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', { hour: 'numeric', minute: '2-digit', timeZone }).format(
    new Date(iso),
  );
}

/** "Wednesday" — the charges header, design:247. The salon's today. */
export function salonWeekday(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', { weekday: 'long', timeZone }).format(now);
}

export interface DayGroup<T> {
  date: string;
  label: string;
  bookings: T[];
}

/**
 * design:692-700 — "Today · Sun 13 Jul", "Tomorrow · Mon 14 Jul".
 *
 * Grouped on the SALON's calendar date, not the device's. The scanner is a
 * phone in a salon so the two normally agree, but a phone left on the wrong
 * zone would otherwise split a single evening across two headings — and the
 * artist would read it as two days' work. Moved here from BookingsScreen
 * unchanged but for the zone, which is now the salon's rather than a constant.
 */
export function groupByDay<T extends { startsAt: string }>(
  bookings: readonly T[],
  timeZone: string,
  words: { today: string; tomorrow: string },
  now: Date = new Date(),
): DayGroup<T>[] {
  const today = salonDate(now, timeZone);
  const tomorrow = nextCalendarDate(today);
  const groups = new Map<string, T[]>();

  for (const booking of bookings) {
    const key = salonDate(new Date(booking.startsAt), timeZone);
    const list = groups.get(key);
    if (list) list.push(booking);
    else groups.set(key, [booking]);
  }

  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, list]) => {
      const heading = weekdayLabel(list[0]!.startsAt, timeZone);
      return {
        date,
        label:
          date === today
            ? `${words.today} · ${heading}`
            : date === tomorrow
              ? `${words.tomorrow} · ${heading}`
              : heading,
        bookings: list,
      };
    });
}
