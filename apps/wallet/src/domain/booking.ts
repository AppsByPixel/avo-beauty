/**
 * The Book flow's arithmetic. No React, no copy, no colour — so the rules below
 * can be unit-tested without a screen.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * EVERY DATE HERE IS A SALON-LOCAL CALENDAR DATE, NOT AN INSTANT
 * ═══════════════════════════════════════════════════════════════════════════
 * `GET /artists/{id}/availability?date=` takes "2026-08-18" and the API is
 * explicit that it is REQUIRED rather than defaulted to "today", because
 * "today" is a question about a zone. The same applies on this side: a customer
 * whose phone is on Europe/London at 22:30 Kuwait time is looking at tomorrow
 * according to her device and today according to her salon, and the strip has to
 * agree with the salon or the first tap asks for the wrong day.
 *
 * So the zone comes off `Salon.timezone` and the device clock is used only as
 * the instant to convert. Nothing here reads the device's zone.
 */

import type { Artist, Language } from '@avo/types';
import type { Availability, AvailabilitySlotWire } from '../api/booking';
import { dateLocale } from './activity';
import { toEasternDigits } from '../i18n/digits';

/** How many days the strip offers. design:1506-1508 shows five; seven reads a week. */
export const DAY_STRIP_LENGTH = 7;

export interface StripDay {
  /** "2026-08-18" — what the availability endpoint is asked for. */
  date: string;
  /** 0 = Sunday, matching `Artist.windows` and JS `getDay()`. */
  weekday: number;
  /** The day of the month, unformatted. The copy layer decides the digits. */
  dayOfMonth: number;
  /** 1-12. Needed by the "Sat 12 Aug · 4:30 PM" line, which names the month. */
  month: number;
  year: number;
  /** The first day of the strip. The design labels it "Today", not "Sun". */
  isToday: boolean;
}

/**
 * The salon's calendar date for an instant.
 *
 * `en-CA` because it is the one widely-supported locale whose short date is
 * already `YYYY-MM-DD`; the alternative is `formatToParts` and three lookups.
 * The locale is a formatting detail and never reaches a screen — every string a
 * customer sees is built from the numeric parts below, in her own language.
 */
export function salonDate(at: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

/** "2026-08-18" → its parts. Returns null for anything that is not one. */
function parseCalendarDate(date: string): { year: number; month: number; day: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

/**
 * The seven-day strip, starting at the salon's today.
 *
 * ARITHMETIC IN UTC, DELIBERATELY. Adding a day to a calendar date is calendar
 * arithmetic — it has no zone and no DST, and doing it through `Date.UTC` keeps
 * it that way. Adding 86 400 000 ms to a local `Date` is the version that loses
 * an hour twice a year and silently repeats or skips a day.
 */
export function dayStrip(now: Date, timezone: string, length = DAY_STRIP_LENGTH): StripDay[] {
  const today = parseCalendarDate(salonDate(now, timezone));
  if (!today) return [];
  const start = Date.UTC(today.year, today.month - 1, today.day);

  return Array.from({ length }, (_, i) => {
    const d = new Date(start + i * 86_400_000);
    const year = d.getUTCFullYear();
    const month = d.getUTCMonth() + 1;
    const dayOfMonth = d.getUTCDate();
    return {
      date: `${year}-${String(month).padStart(2, '0')}-${String(dayOfMonth).padStart(2, '0')}`,
      weekday: d.getUTCDay(),
      dayOfMonth,
      month,
      year,
      isToday: i === 0,
    };
  });
}

// --------------------------------------------------------------- labelling --

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THESE THREE FORMATTERS ARE HERE AND NOT IN copy/
 * ═══════════════════════════════════════════════════════════════════════════
 * Because their digits have to follow the LOCALE rather than a hand-written
 * string, and `Intl` already does that correctly for both languages. The
 * precedent is `clockTime` in domain/activity.ts, and the rule is the one that
 * module documents: `ar-u-nu-arab`, never bare `ar`, because modern CLDR gives
 * plain `ar` **Western** digits and would render "12 أغسطس" — Arabic month,
 * Latin numerals — which is half the digit rule and reads as a bug.
 *
 * Every one of them is a DATE or a TIME, and dates and times are counts. They
 * are Eastern in Arabic. Money is not formatted anywhere in this file.
 *
 * `formatWhen` takes the salon's timezone explicitly. A formatter that fell back to
 * the device zone would render a Kuwait 16:45 as 13:45 for a customer whose
 * phone is on London time, and it would do it while the grid beside it still
 * said 16:45 — because the grid renders the server's `local` string verbatim.
 */

/** "Sun" / "الأحد" — the day strip's top line. The first chip says "Today". */
export function weekdayLabel(day: StripDay, lang: Language): string {
  return new Intl.DateTimeFormat(dateLocale(lang), {
    weekday: 'short',
    timeZone: 'UTC',
  }).format(Date.UTC(day.year, day.month - 1, day.dayOfMonth));
}

/** "18" / "١٨" — the day strip's figure. A count, so Eastern in Arabic. */
export function dayNumberLabel(day: StripDay, lang: Language): string {
  return new Intl.DateTimeFormat(dateLocale(lang), {
    day: 'numeric',
    timeZone: 'UTC',
  }).format(Date.UTC(day.year, day.month - 1, day.dayOfMonth));
}

/**
 * "Sat 12 Aug · 4:30 PM" / "السبت ١٢ أغسطس · ٤:٣٠ م" — design:1533-1535.
 *
 * Built from the INSTANT, in the SALON's zone. The design composes it from its
 * own fixture strings; this composes it from the booking the server returned,
 * which is the only version that survives a customer travelling.
 */
export function formatWhen(startsAtIso: string, timezone: string, lang: Language): string {
  const at = new Date(startsAtIso);
  const locale = dateLocale(lang);
  const day = new Intl.DateTimeFormat(locale, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: timezone,
  }).format(at);
  const time = new Intl.DateTimeFormat(locale, {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: timezone,
  }).format(at);
  return `${day} · ${time}`;
}

/**
 * The slot chip's own label — "16:45" / "١٦:٤٥".
 *
 * The API's `local` string is rendered as-is in English and has its DIGITS
 * converted for Arabic. It is not re-derived from `startsAt`: the API is
 * explicit that a client reformatting the instant in the device's zone "would
 * show a customer in London her Kuwait appointment at 07:00 and let her believe
 * it". Converting digits changes the script and not the number.
 */
export function slotLabel(local: string, lang: Language): string {
  return lang === 'ar' ? toEasternDigits(local) : local;
}

// ------------------------------------------------------------ the slot grid --

export interface SlotRun {
  /** Contiguous slots — each one starts exactly where the previous ended. */
  slots: AvailabilitySlotWire[];
}

/**
 * Split the day's grid at the afternoon closure.
 *
 * THE CLOSURE IS THE NORM, NOT AN EDGE CASE. `BusinessHoursSchema` is
 * `{ morning: [from,to], evening: [from,to] }` — two spans with a gap between
 * them — because a Kuwaiti salon shuts in the afternoon. The design draws them
 * as two labelled groups (design:573-580, "Morning" and "Evening") and a single
 * flat grid would offer a 14:00 at a salon whose door is locked.
 *
 * The split is found from the DATA rather than from a hard-coded hour: a run
 * ends where the next slot does not begin at the previous one's end. Hard-coding
 * 13:00 would be right for Amara and wrong for the next salon onboarded, and it
 * is the sort of wrong that renders perfectly.
 *
 * The schema guarantees at most two spans, so at most two runs come back; a
 * third would be a contract change and the caller labels runs after the first
 * as evening, which is the honest reading of "after the closure".
 */
export function splitRuns(slots: AvailabilitySlotWire[]): SlotRun[] {
  const runs: SlotRun[] = [];
  let current: AvailabilitySlotWire[] = [];

  for (const slot of slots) {
    const previous = current[current.length - 1];
    if (previous && previous.endsAt !== slot.startsAt) {
      runs.push({ slots: current });
      current = [];
    }
    current.push(slot);
  }
  if (current.length > 0) runs.push({ slots: current });
  return runs;
}

/**
 * Is there anything on this day a customer could actually take?
 *
 * NOT the same question as `open`. A fully-booked Tuesday is open and has a
 * grid full of struck-through slots — which is what she should see, because it
 * tells her the salon works on Tuesdays and somebody got there first. A day
 * with NO slots at all is the empty state, and that is what this distinguishes.
 */
export function hasGrid(availability: Availability): boolean {
  return availability.open && availability.slots.length > 0;
}

/** Nothing left to take, but the day exists. Not an empty state — a full one. */
export function isFullyTaken(availability: Availability): boolean {
  return hasGrid(availability) && availability.slots.every((s) => !s.available);
}

// -------------------------------------------------------------- the artist --

export type HoursSource = 'live' | 'salon';

/**
 * What the artist row promises BEFORE a date is chosen.
 *
 * `google` + connected reads "Live availability"; anything else reads
 * "Availability by salon hours" (design:1491-1492, `liveLbl` / `hoursLbl`).
 *
 * This is a promise, not a measurement, and the difference matters: an artist
 * marked google-sourced whose calendar cannot actually be reached falls back to
 * salon hours, and only the availability response knows that. The row says what
 * her setting is; the grid says what happened. `fallbackReason` on the day's
 * response is what turns the first into the second, and the grid surfaces it —
 * see BookScreen § the fallback note.
 */
export function artistHoursPromise(artist: Artist): HoursSource {
  return artist.availabilitySource === 'google' && artist.googleConnected ? 'live' : 'salon';
}

/** Rana Al-Sabah → "R". The design's avatar initial, design:1486-1489. */
export function artistInitial(name: string): string {
  return name.trim().charAt(0).toUpperCase();
}

/**
 * The artist's name in the reading language.
 *
 * `nameAr` is nullable on purpose — the seed's Shaikha B. has none — and the
 * fallback is the Latin name rather than a transliteration invented here.
 * Same rule `Salon` and `Branch` already follow.
 */
export function artistName(artist: Artist, lang: Language): string {
  return lang === 'ar' ? (artist.nameAr ?? artist.name) : artist.name;
}

/**
 * The service's name in the reading language — the same rule, now that it can
 * be followed.
 *
 * `Service.nameAr` did not exist when the Book flow was built, so the most
 * Arabic-heavy screen in the wallet rendered every service row in Latin. It
 * exists now. The fallback is the Latin name and never a transliteration
 * written by this lane; the seed leaves SV-05 NULL deliberately, so the null
 * path is one a real customer walks rather than a branch nothing reaches.
 */
export function serviceName(
  service: { name: string; nameAr: string | null },
  lang: Language,
): string {
  return lang === 'ar' ? (service.nameAr ?? service.name) : service.name;
}

// ------------------------------------------------------- the one-hour rule --

/**
 * Has the change window closed?
 *
 * USED FOR PRESENTATION ONLY, AND NEVER TO REFUSE. The server owns this
 * decision and answers `409 change_window_closed` with the deadline attached;
 * the client's clock is not the one that counts, and a phone that is four
 * minutes fast would otherwise grey out a button the salon would still have
 * honoured.
 *
 * So the buttons stay live and the refusal is surfaced when it comes back. This
 * exists to decide whether to show the deadline as a future time or as a
 * past one, which is a sentence and not a control.
 */
export function changeWindowLooksClosed(booking: { changeableUntil: string }, now: Date): boolean {
  return now.getTime() >= new Date(booking.changeableUntil).getTime();
}

/**
 * The next appointment to show on Home, or null.
 *
 * The soonest one still holding a deposit. Past ones are filtered out even
 * though `GET /bookings?status=deposit_held` can still return them — a booking
 * whose deposit has not been resolved yet by the no-show job is held but gone,
 * and putting yesterday's 16:45 under "Upcoming" is worse than showing nothing.
 */
export function nextAppointment<T extends { startsAt: string; status: string }>(
  bookings: T[],
  now: Date,
): T | null {
  return (
    bookings
      .filter((b) => b.status === 'deposit_held' && new Date(b.startsAt).getTime() > now.getTime())
      .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime())[0] ?? null
  );
}
