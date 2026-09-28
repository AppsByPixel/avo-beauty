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
 * identical whether the API booted under UTC (a Vercel function or a CI runner:
 * neither sets `TZ`, and both default to UTC), under the zone of a developer's
 * laptop (`pnpm dev` inherits it — Asia/Karachi or Asia/Kuwait here), or under
 * `TZ=America/New_York` (the proof case in src/time/zone.test.ts).
 *
 * docker-compose.yml does NOT set the API's zone. Its `TZ: UTC` and `PGTZ: UTC`
 * are on the Postgres container, and the API is not a compose service — it runs
 * on the host, in the host's zone. No environment pins the process zone, which
 * is the whole reason it is never read.
 *
 * `new Date(y, m, d, …)`, `getHours()`, `getDay()` and `getTimezoneOffset()` all
 * read the process zone; none of them appear here, and none of them should appear
 * in a handler either. Neither should `new Date(raw)` on a caller's string: a
 * string with no offset is read in the process zone too — see `parseInstant`.
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
 * THE PLATFORM'S OWN ZONE, as opposed to a salon's.
 *
 * Almost every date boundary in this API resolves against `salon.timezone`,
 * because a business day is a salon-local fact. A few do not: a PLATFORM month
 * and a PLATFORM publication date belong to AVO, not to any one tenant. AVO is a
 * Kuwait company and `salon.timezone` defaults to Asia/Kuwait, so the platform
 * zone is Asia/Kuwait — stated as a decision rather than inherited by accident
 * from `TZ=UTC`, which is three hours away and moves every boundary with it.
 * `services/platformMetrics.ts` carries the longer form of the argument for the
 * month-bucketing case.
 *
 * IT LIVES HERE, not in the metrics service that first needed it, because it is
 * not a metrics fact. `routes/policies.ts` reaches for the same decision when it
 * asks what day it is for a legal publication, and a route importing a constant
 * out of a reporting service to answer that would be the wrong direction — the
 * constant would look like a metrics detail two callers happened to share.
 */
export const PLATFORM_TIMEZONE = 'Asia/Kuwait';

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
  if (!isCalendarDate(date)) {
    throw badRequest('invalid_date', `${field} is not a real date: ${value}.`);
  }
  return date;
}

/** Round-tripping catches "2026-02-31", which a YYYY-MM-DD regex is happy with. */
function isCalendarDate(date: CalendarDate): boolean {
  const probe = new Date(Date.UTC(date.year, date.month - 1, date.day));
  return (
    probe.getUTCFullYear() === date.year &&
    probe.getUTCMonth() + 1 === date.month &&
    probe.getUTCDate() === date.day
  );
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

/**
 * A caller-supplied INSTANT — "2026-09-30T07:00:00Z", "2026-09-30T10:00+03:00" —
 * parsed, or refused with a sentence that names the fix.
 *
 * THE OFFSET IS REQUIRED, and that is the point of this function. `new Date(raw)`
 * accepts "2026-09-30T10:00" and reads it in the PROCESS zone: 05:00Z on a laptop
 * in Karachi, 10:00Z on Vercel. The second is a Kuwait merchant's 10:00 campaign
 * going out at 13:00 her time, and nothing in the request or the response would
 * show it. A server cannot know which clock a zoneless wall time was written in,
 * so it does not guess: the client names the instant — the dashboard builds it in
 * the salon's zone with `instantFromSalonLocal` — and a string that does not say
 * which clock it is in is refused here.
 *
 * Also refused, for the same reason: a bare date ("2026-09-30", which `Date`
 * reads as UTC midnight rather than the salon's), a date the calendar does not
 * have ("2026-02-31", which `Date` silently rolls into March), and `T24:00`.
 *
 * NOT for salon-local wall clocks. A happy hour's `from`/`to` ("16:00") and a
 * branch's hours are zoneless on purpose — they mean "at the salon" and resolve
 * through `salon.timezone` via `wallClockInstant`. A calendar date is `parseDate`.
 *
 * The CODE is the caller's, so each route keeps the refusal it already had
 * (`invalid_scheduled_at`, `invalid_starts_at`, `invalid_expiry`) and a client
 * that handles it needs no new branch.
 */
const ISO_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,9})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

/** A date, or a date and a time, with nothing after it: the zoneless shapes `Date` accepts. */
const ZONELESS = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?$/;

export interface InstantField {
  /** The wire name, used in the message: "scheduledAt". */
  field: string;
  /** The route's refusal code: `invalid_scheduled_at`, `invalid_starts_at`, … */
  code: string;
}

export function parseInstant(value: unknown, { field, code }: InstantField): Date {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (ZONELESS.test(raw)) {
    throw badRequest(
      code,
      `${field} "${raw}" does not say which time zone it is in, so it could be any of several moments. Send it with a Z or an offset, like "2026-09-30T07:00:00Z" or "2026-09-30T10:00:00+03:00".`,
    );
  }
  const m = ISO_INSTANT.exec(raw);
  const at = new Date(raw);
  if (
    !m ||
    Number.isNaN(at.getTime()) ||
    // `Date` rolls "2026-02-31" into March rather than refusing it.
    !isCalendarDate({ year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) })
  ) {
    throw badRequest(
      code,
      `${field} must be an ISO 8601 instant with its time zone, like "2026-09-30T07:00:00Z" or "2026-09-30T10:00:00+03:00".`,
    );
  }
  return at;
}
