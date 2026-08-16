/**
 * Salon-local time. The one place a naive wall-clock string meets a real instant.
 *
 * `salon.timezone` is an IANA zone id ("Asia/Kuwait"), not an offset — packages/
 * types/src/entities.ts § SalonSchema carries the decision and the reasoning.
 * This module is the API side of it: everything that has to turn "10:00" into a
 * moment, or a moment into "which day is it there and how far into it are we",
 * goes through here.
 *
 * THE PROCESS ZONE IS NEVER READ
 * ------------------------------
 * Not once, anywhere below. Every conversion names the zone explicitly and
 * `Intl.DateTimeFormat` resolves it from the ICU database, so the answer is
 * identical whether the API booted under `TZ=UTC` (docker-compose), `TZ=Asia/
 * Kuwait` (a developer's laptop) or `TZ=America/New_York` (the proof case in
 * src/time/zone.test.ts). `new Date(y, m, d, …)`, `getHours()`, `getDay()` and
 * `getTimezoneOffset()` all read the process zone; none of them appear here, and
 * none of them should appear in a handler either.
 *
 * WHY AN OFFSET IS DERIVED RATHER THAN STORED
 * -------------------------------------------
 * `zoneOffsetMinutes(instant, zone)` answers "how far ahead of UTC is that zone
 * AT THAT INSTANT". That is the only form of offset that is ever correct: a
 * stored one is wrong twice a year in any DST zone, and "10:00 local" is two
 * different instants across the year. Kuwait has no DST, so today every call
 * returns 180 — which is exactly why this is cheap to land now and expensive to
 * land later.
 *
 * WHAT THIS BUYS THE SHARED PREDICATE
 * -----------------------------------
 * `packages/types/src/rules.ts` — `isHappyHourLive`, `minutesRemaining`,
 * `activeHappyHour` — takes `offsetMinutes`, because it was written before the
 * zone existed. It must not be reimplemented here: it is the shared
 * implementation precisely so a client and the server cannot disagree. So the
 * API calls it with `zoneOffsetMinutes(now, salon.timezone)`, which is correct
 * for any zone at the instant being evaluated, DST included:
 *
 *     salonClock(now, offset) = UTC fields of (now + offset)
 *
 * and (now + the zone's offset at now) is by definition that zone's wall clock
 * at `now`. See `offsetFor` below and its caller in services/promotions.ts.
 *
 * The residual gap, reported rather than patched around: `minutesUntilNext`
 * searches up to seven days ahead using the SAME offset throughout, so in a DST
 * zone a "next window" that lands across a transition is off by an hour. That is
 * a `packages/types` signature change (take a zone, not an offset) and lane A
 * does not edit shared packages — CLAUDE.md § How to work.
 */

import { badRequest } from '../http/errors';

/** Minutes in a day. `to: "24:00"` is 1440 — see routes/platform.ts § midnight. */
export const MINUTES_PER_DAY = 1440;

/**
 * Formatter cache. `Intl.DateTimeFormat` construction is the expensive part and
 * every charge does at least one lookup; the objects are immutable and safe to
 * share.
 */
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(zone: string): Intl.DateTimeFormat {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      // h23, not hour12:false: `hour12:false` renders midnight as "24" in some
      // ICU builds, which would put the salon clock a day out for one hour a day.
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(zone, f);
  }
  return f;
}

/**
 * Is this a zone id the runtime can actually resolve?
 *
 * Validated by construction rather than against a hardcoded list: the IANA
 * database gains and renames zones, and a list in this file would start
 * refusing valid input the first time it fell behind. A CHECK constraint cannot
 * do this — the answer is not immutable, so Postgres will not let it into one —
 * which is why the column has a NOT NULL and a non-blank check in the database
 * and its meaning is enforced here, at the write.
 */
export function isValidTimeZone(zone: string): boolean {
  if (typeof zone !== 'string' || zone.trim() === '') return false;
  // FOUND BY THE TEST, NOT ASSUMED. ECMA-402 accepts an OFFSET as a `timeZone`
  // — `new Intl.DateTimeFormat('en-US', { timeZone: '+03:00' })` constructs
  // happily on current V8 — so `Intl` alone does not enforce what this column
  // means. An offset stored here would look valid, format correctly all year in
  // Kuwait, and be wrong twice a year the first time AVO signs a salon in a DST
  // zone: precisely the failure migration 0010 exists to prevent. Refused.
  if (/^[+-]\d/.test(zone.trim())) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** Parse a caller-supplied zone or refuse it with a sentence that names the fix. */
export function parseTimeZone(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw badRequest(
      'invalid_timezone',
      'timezone must be an IANA zone id, like "Asia/Kuwait".',
    );
  }
  const zone = value.trim();
  if (!isValidTimeZone(zone)) {
    throw badRequest(
      'invalid_timezone',
      `"${zone}" is not an IANA zone id. Use a name from the tz database, like "Asia/Kuwait" — not an offset like "+03:00", which cannot express a daylight-saving change.`,
    );
  }
  return zone;
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function partsIn(instant: Date, zone: string): ZonedParts {
  const parts = formatterFor(zone).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const p = parts.find((x) => x.type === type);
    return p ? Number(p.value) : 0;
  };
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

/**
 * The zone's offset from UTC, in minutes, AT THAT INSTANT. +180 for Kuwait.
 *
 * Derived by formatting the instant into the zone, reading the result back as if
 * it were UTC, and taking the difference. That is the whole trick, and it is
 * correct across DST because the formatter applies whichever rule was in force
 * at `instant`.
 */
export function zoneOffsetMinutes(instant: Date, zone: string): number {
  const p = partsIn(instant, zone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  // Instant milliseconds are dropped on both sides, so the difference is whole
  // seconds; zone offsets are whole minutes, and rounding keeps it that way.
  return Math.round((asUtc - Math.floor(instant.getTime() / 1000) * 1000) / 60_000);
}

/**
 * The offset to hand `packages/types/src/rules.ts`. Named separately from
 * `zoneOffsetMinutes` so the call sites read as what they are — "resolve the
 * shared predicate against this salon's clock" — rather than as arithmetic.
 */
export function offsetFor(salon: { timezone: string }, now: Date): number {
  return zoneOffsetMinutes(now, salon.timezone);
}

export interface SalonWallClock {
  /** 0 = Sunday, matching JS getDay() and the `days` array of a HappyHour. */
  day: number;
  /** Minutes since salon-local midnight, 0..1439. */
  minutes: number;
  /** "2026-08-17" in the salon's zone — the date the customer would name. */
  date: string;
}

/** What time is it at the salon, and what day do they think it is. */
export function salonWallClock(instant: Date, zone: string): SalonWallClock {
  const p = partsIn(instant, zone);
  // Day-of-week of a calendar date is zone-free once the date itself is, so this
  // is safe: the UTC weekday of the UTC-midnight of the LOCAL date.
  const day = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
  return {
    day,
    minutes: p.hour * 60 + p.minute,
    date: `${String(p.year).padStart(4, '0')}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`,
  };
}

const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;

export interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

export function parseDate(value: unknown, field = 'date'): CalendarDate {
  if (typeof value !== 'string' || !YMD.test(value)) {
    throw badRequest('invalid_date', `${field} must be a calendar date like "2026-08-17".`);
  }
  const m = YMD.exec(value) as RegExpExecArray;
  const date: CalendarDate = { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
  // Round-tripping catches "2026-02-31", which the regex is happy with.
  const probe = new Date(Date.UTC(date.year, date.month - 1, date.day));
  if (
    probe.getUTCFullYear() !== date.year ||
    probe.getUTCMonth() + 1 !== date.month ||
    probe.getUTCDate() !== date.day
  ) {
    throw badRequest('invalid_date', `${field} is not a real date: ${value}.`);
  }
  return date;
}

/** The JS weekday (0 = Sunday) of a calendar date. Zone-free by construction. */
export function weekdayOf(date: CalendarDate): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

/**
 * "10:00 on 2026-08-17, at this salon" → the actual instant.
 *
 * THE CONVERSION artists.ts flagged and would not guess at. Two passes, and the
 * second one is not belt-and-braces: the offset that applies depends on the
 * instant, and the instant depends on the offset, so the first pass uses the
 * offset at an approximate instant and the second corrects it. One pass is wrong
 * for any wall time within an hour of a DST transition.
 *
 * A wall time inside a spring-forward GAP does not exist. Rather than invent
 * one, this returns the instant the clock jumps TO, which is what the second
 * pass naturally converges on, and which is the behaviour a booking system wants:
 * a slot that the local clock skipped is offered at the first moment that does
 * exist rather than silently an hour early.
 */
export function wallClockInstant(date: CalendarDate, minutes: number, zone: string): Date {
  const naiveUtc = Date.UTC(date.year, date.month - 1, date.day, 0, minutes);
  let instant = new Date(naiveUtc - zoneOffsetMinutes(new Date(naiveUtc), zone) * 60_000);
  instant = new Date(naiveUtc - zoneOffsetMinutes(instant, zone) * 60_000);
  return instant;
}

/** "16:45" → 1005. "24:00" → 1440, the end-of-day sentinel. */
export function hhmmToMinutes(hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) throw new TypeError(`Not a HH:MM time: ${hhmm}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/** 1005 → "16:45". 1440 → "24:00". */
export function minutesToHhmm(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
