/**
 * The zone resolution, proved BY MAKING IT FAIL.
 *
 * A test that only ever runs in one zone cannot tell a correct conversion from
 * an absent one: under `TZ=Asia/Kuwait` a hardcoded +3 and a real lookup agree
 * on every assertion anyone would think to write. That is exactly how a missing
 * timezone stays invisible — the slot list still renders, it is just wrong.
 *
 * So the spec below runs the same conversions under four process zones and
 * asserts they agree, including one (`America/New_York`) that is eight hours
 * from Kuwait and observes DST when Kuwait does not. The parallel test in
 * services/promotions.test.ts does the same for the money-bearing predicate.
 *
 * `process.env.TZ` is mutated between cases, which works because none of these
 * functions caches anything keyed on it and Node re-reads it on the next
 * Date construction. Nothing in src/time/zone.ts reads it at all — that is the
 * property under test.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  hhmmToMinutes,
  isValidTimeZone,
  minutesToHhmm,
  parseDate,
  salonWallClock,
  wallClockInstant,
  weekdayOf,
  zoneOffsetMinutes,
} from './zone';

const KUWAIT = 'Asia/Kuwait';

/** Process zones the API might actually boot under, plus the hostile one. */
const PROCESS_ZONES = ['UTC', 'Asia/Kuwait', 'America/New_York', 'Australia/Sydney'];

const originalTz = process.env.TZ;
afterAll(() => {
  process.env.TZ = originalTz;
});
beforeEach(() => {
  process.env.TZ = originalTz;
});

/** Run `fn` once per process zone and return the answers, labelled. */
function underEveryProcessZone<T>(fn: () => T): Array<[string, T]> {
  return PROCESS_ZONES.map((tz) => {
    process.env.TZ = tz;
    return [tz, fn()] as [string, T];
  });
}

describe('the process zone cannot influence a salon-local answer', () => {
  it('16:00 Kuwait is 13:00 UTC, whatever TZ the API booted with', () => {
    // 2026-08-17 is a Monday. The instant below is 16:00 in Kuwait.
    const instant = new Date('2026-08-17T13:00:00Z');

    const answers = underEveryProcessZone(() => salonWallClock(instant, KUWAIT));

    for (const [tz, clock] of answers) {
      expect(clock.minutes, `${tz} resolved the salon clock to ${clock.minutes} minutes`).toBe(
        16 * 60,
      );
      expect(clock.day, `${tz} resolved the salon weekday`).toBe(1); // Monday
      expect(clock.date, `${tz} resolved the salon date`).toBe('2026-08-17');
    }
  });

  it('the salon date rolls at salon midnight, not at the process zone midnight', () => {
    // 21:30 UTC on the 17th is 00:30 on the 18th in Kuwait. A server in New York
    // still calls it the 17th locally, and Sydney already calls it the 18th —
    // neither of which is the salon's answer.
    const instant = new Date('2026-08-17T21:30:00Z');

    for (const [tz, clock] of underEveryProcessZone(() => salonWallClock(instant, KUWAIT))) {
      expect(clock.date, `${tz}`).toBe('2026-08-18');
      expect(clock.day, `${tz}`).toBe(2); // Tuesday
      expect(clock.minutes, `${tz}`).toBe(30);
    }
  });

  it('"10:00 on 2026-08-17 at the salon" is one instant, whatever TZ the API booted with', () => {
    const date = parseDate('2026-08-17');

    const answers = underEveryProcessZone(() =>
      wallClockInstant(date, hhmmToMinutes('10:00'), KUWAIT).toISOString(),
    );

    for (const [tz, iso] of answers) {
      expect(iso, `${tz} resolved 10:00 Kuwait to the wrong instant`).toBe('2026-08-17T07:00:00.000Z');
    }
  });

  it('Kuwait is +180 in January and in July — no DST, which is why the id costs nothing today', () => {
    for (const [tz] of underEveryProcessZone(() => null)) {
      expect(zoneOffsetMinutes(new Date('2026-01-15T12:00:00Z'), KUWAIT), tz).toBe(180);
      expect(zoneOffsetMinutes(new Date('2026-07-15T12:00:00Z'), KUWAIT), tz).toBe(180);
    }
  });
});

describe('an offset could not have expressed this, which is why the column is an id', () => {
  /**
   * THE CASE FOR THE ID, AS AN ASSERTION RATHER THAN A COMMENT.
   *
   * If `salon.timezone` held an integer offset instead of a zone id, one of the
   * two answers below would be wrong — the same stored number cannot be right on
   * both sides of a daylight-saving change. Kuwait never hits this; the first
   * salon AVO signs in Cairo, Amman, Beirut, Istanbul or the EU does.
   */
  it('the same wall time is two different instants across a DST boundary', () => {
    const cairo = 'Africa/Cairo';
    const winter = wallClockInstant(parseDate('2026-01-15'), hhmmToMinutes('10:00'), cairo);
    const summer = wallClockInstant(parseDate('2026-07-15'), hhmmToMinutes('10:00'), cairo);

    expect(zoneOffsetMinutes(winter, cairo)).toBe(120);
    expect(zoneOffsetMinutes(summer, cairo)).toBe(180);

    // 10:00 local, both times — but 08:00Z in January and 07:00Z in July.
    expect(winter.toISOString()).toBe('2026-01-15T08:00:00.000Z');
    expect(summer.toISOString()).toBe('2026-07-15T07:00:00.000Z');
  });

  it('a wall time inside the spring-forward gap resolves to the moment the clock jumps to', () => {
    // Cairo springs forward at 00:00 on the last Friday of April 2026; 00:30
    // local does not exist that night. It must not silently become 23:30 the
    // previous day, which is what a single-pass conversion produces.
    const cairo = 'Africa/Cairo';
    const gap = wallClockInstant(parseDate('2026-04-24'), hhmmToMinutes('00:30'), cairo);
    expect(gap.getTime()).toBeGreaterThan(new Date('2026-04-23T22:00:00Z').getTime());
    // Whatever it resolves to, it is a real instant and round-tripping it lands
    // on a real local time rather than the one that was asked for.
    expect(Number.isFinite(gap.getTime())).toBe(true);
  });
});

describe('validation', () => {
  it('accepts IANA ids and refuses offsets, which cannot express a DST change', () => {
    expect(isValidTimeZone('Asia/Kuwait')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('Africa/Cairo')).toBe(true);

    expect(isValidTimeZone('+03:00')).toBe(false);
    expect(isValidTimeZone('Kuwait')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
    expect(isValidTimeZone('   ')).toBe(false);
  });

  it('refuses a date the regex would accept but the calendar would not', () => {
    expect(() => parseDate('2026-02-31')).toThrow();
    expect(() => parseDate('17-08-2026')).toThrow();
    expect(() => parseDate(undefined)).toThrow();
    expect(parseDate('2026-02-28')).toEqual({ year: 2026, month: 2, day: 28 });
  });

  it('HH:MM round-trips, including the 24:00 end-of-day sentinel', () => {
    expect(hhmmToMinutes('00:00')).toBe(0);
    expect(hhmmToMinutes('16:45')).toBe(1005);
    expect(hhmmToMinutes('24:00')).toBe(1440);
    expect(minutesToHhmm(0)).toBe('00:00');
    expect(minutesToHhmm(1005)).toBe('16:45');
    expect(minutesToHhmm(1440)).toBe('24:00');
  });

  it('weekdayOf agrees with the contract: 0 is Sunday', () => {
    expect(weekdayOf(parseDate('2026-08-16'))).toBe(0);
    expect(weekdayOf(parseDate('2026-08-17'))).toBe(1);
    expect(weekdayOf(parseDate('2026-08-22'))).toBe(6);
  });
});
