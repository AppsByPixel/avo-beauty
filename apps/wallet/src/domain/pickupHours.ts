/**
 * WHEN SHE CAN COLLECT — W8. The client, verbatim: "please collect during the
 * branch's official working hours", and after hours, say it is closed now and
 * she can collect the next day.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * DISPLAY ONLY. THE SERVER REFUSES NOTHING OUT OF HOURS.
 *
 * A pickup placed at 23:00 is placed; `services/order.ts` does not read the
 * hours at all. So nothing here blocks Pay, holds a key or changes a body. It is
 * copy about when the counter is staffed, and a customer who orders at midnight
 * for tomorrow is doing exactly what the sentence below tells her she can.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * "OPEN NOW" IS DECIDED IN THE SALON'S ZONE, NEVER THE DEVICE'S.
 *
 * The hours are naive wall clock ("10:00"), meaningful only in `salon.timezone`
 * — which is why the server serves the zone beside them (top-level on
 * `GET /salons/{id}`, inline as `pickupBranch.timezone` on an order). This
 * machine runs PKT, two hours AHEAD of Kuwait, and `api/src/services/reports.ts`
 * has already put a charge on the wrong day for reading the host clock. A
 * device-clock "open" would call Amara's counter shut at 20:00 Kuwait time for a
 * customer whose phone says 22:00 — or open at 08:00 Kuwait for one in London.
 *
 * So the instant is shifted by the ZONE's offset at that instant
 * (`salonOffsetMinutes`, the happy-hour banner's own helper — Intl does the zone
 * arithmetic, an unusable zone falls back to Kuwait and never to the host), and
 * read with `salonClock` from `@avo/types`, the same function `POST /charges`
 * uses to decide whether a happy hour is live. `Date#getHours()` appears nowhere.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * A SPAN WITH `to <= from` IS NOT A WINDOW.
 *
 * `evening: ["21:00","21:00"]` is the ESTABLISHED way to say "no second sitting"
 * (`BusinessHoursSchema`'s comment; `tradingSpans` in
 * `api/src/services/availability.ts` drops it the same way). A salon open
 * straight through is ONE range on screen, never "10 am – 9 pm and 9 pm – 9 pm".
 * Mirrors the server's rule exactly: morning then evening, a zero-or-negative
 * span dropped, nothing merged.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * NO WEEKDAY. Every day is the same day (`BusinessHours` has no weekday
 * dimension), so "tomorrow" is always the first window of the next day and a
 * salon closed on Fridays cannot say so. Reported by lane A; not invented here.
 * ═════════════════════════════════════════════════════════════════════════════
 */

import { hhmmToMinutes, salonClock, type Branch } from '@avo/types';
import { salonOffsetMinutes } from './happyHour';

/**
 * `BusinessHoursSchema`'s shape. `@avo/types` exports the schema but no type
 * for it, and `packages/types` is trunk-owned — so it is named here off the
 * branch that serves it rather than by adding an export in another lane's
 * column.
 */
export type BusinessHours = Branch['businessHours'];

/** One trading window, as the contract spells it: `["10:00", "13:00"]`. */
export type ClockSpan = readonly [from: string, to: string];

/**
 * The windows the counter is actually open, in order. `to <= from` is not a
 * window — see the header. Returns `[]` when neither span trades, which the
 * callers render as NO hours line rather than an empty sentence.
 */
export function tradingSpans(hours: BusinessHours): ClockSpan[] {
  const spans: ClockSpan[] = [];
  for (const span of [hours.morning, hours.evening]) {
    if (hhmmToMinutes(span[1]) > hhmmToMinutes(span[0])) spans.push(span);
  }
  return spans;
}

/**
 * Is the counter staffed now, and if not, when does it open?
 *
 *   open                 inside a window — `from <= now < to`, half-open like
 *                        every other window in this contract.
 *   closed · today       between windows, or before the first: the afternoon
 *                        closure, or 08:00 before a 10:00 opening.
 *   closed · tomorrow    after the last window — the client's "collect the next
 *                        day". The first window of tomorrow, because every day
 *                        is the same day.
 *   null                 no window at all. Nothing honest to say.
 */
export type PickupNow =
  | { kind: 'open' }
  | { kind: 'closed'; day: 'today' | 'tomorrow'; opensAt: string };

export function pickupNow(
  hours: BusinessHours,
  /** `salon.timezone` / `pickupBranch.timezone`. NEVER the device's zone. */
  timeZone: string,
  now: Date,
): PickupNow | null {
  const spans = tradingSpans(hours);
  const first = spans[0];
  if (!first) return null;
  const { minutes } = salonClock(now, salonOffsetMinutes(timeZone, now));
  for (const [from, to] of spans) {
    if (minutes >= hhmmToMinutes(from) && minutes < hhmmToMinutes(to)) return { kind: 'open' };
  }
  const later = spans.find(([from]) => hhmmToMinutes(from) > minutes);
  return later
    ? { kind: 'closed', day: 'today', opensAt: later[0] }
    : { kind: 'closed', day: 'tomorrow', opensAt: first[0] };
}

/** What the four copy keys need — structural, so this module needs no `Copy`. */
export interface PickupHoursCopy {
  pickupHours: (spans: readonly ClockSpan[]) => string;
  pickupClosedToday: (opensAt: string) => string;
  pickupClosedTomorrow: (opensAt: string) => string;
}

/** The two sentences a pickup surface draws, or null for "say nothing". */
export interface PickupHoursLines {
  /** "Collect during working hours, 10 am – 1 pm and 4 pm – 9 pm". */
  hours: string;
  /** "Closed now — collect tomorrow from 10 am", or null while it is open. */
  closedNow: string | null;
}

/**
 * The sentences, resolved. `timeZone` NULL means "the zone is not known" — an
 * order snapshot stored before migration 0063 — and then there is no closed-now
 * line at all rather than one decided on the device's clock.
 */
export function pickupHoursLines(
  hours: BusinessHours,
  timeZone: string | null,
  now: Date,
  copy: PickupHoursCopy,
): PickupHoursLines | null {
  const spans = tradingSpans(hours);
  if (spans.length === 0) return null;
  const state = timeZone === null ? null : pickupNow(hours, timeZone, now);
  return {
    hours: copy.pickupHours(spans),
    closedNow:
      state === null || state.kind === 'open'
        ? null
        : state.day === 'today'
          ? copy.pickupClosedToday(state.opensAt)
          : copy.pickupClosedTomorrow(state.opensAt),
  };
}

/**
 * "10 am" / "4:30 pm" / "١٠ ص" / "٤:٣٠ م" — a naive wall-clock "HH:MM" as the
 * wallet already writes a time: `Intl` in `dateLocale(lang)` with `hour12`,
 * which is what `bell.ts § timeLabel` and `booking.ts § formatWhen` do and what
 * the design writes (`٤:٣٠ م`, design:1286). Eastern digits and ص/م in Arabic
 * come from the locale, not from this function.
 *
 * The minutes are dropped when they are zero, because the client's own example
 * is "10 am – 1 pm". Formatted in UTC from `Date.UTC(…, h, m)` — the value IS a
 * wall clock already, so there is no zone to apply; `24:00` (a real end of
 * day) rolls to 00:00 and reads "12 am".
 *
 * Narrow and non-breaking spaces from ICU are normalised to a plain space so a
 * string assembled here compares equal on every engine.
 */
export function wallClockLabel(hhmm: string, locale: string): string {
  const total = hhmmToMinutes(hhmm);
  const h = Math.floor(total / 60);
  const m = total % 60;
  const options: Intl.DateTimeFormatOptions = { hour: 'numeric', hour12: true, timeZone: 'UTC' };
  if (m !== 0) options.minute = '2-digit';
  return new Intl.DateTimeFormat(locale, options)
    .format(Date.UTC(2000, 0, 1, h, m))
    .replace(/[  ]/g, ' ');
}
