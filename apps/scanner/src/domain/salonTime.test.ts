/**
 * The scanner reads a salon's time in the SALON's zone — `domain/salonTime.ts`.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THIS FILE RUNS IN A NON-SALON ZONE, ON PURPOSE, AND CHECKS THAT IT DOES.
 *
 * ChargesScreen used `toLocaleTimeString` with no zone — the device's clock —
 * and BookingsScreen hard-coded Kuwait. In a process on Kuwait time neither
 * defect is visible, so the zone is pinned to Asia/Karachi (UTC+5), and the
 * first spec asserts the pin took.
 *
 *   UTC 07:00           Kuwait 10:00   Dubai 11:00   Karachi 12:00
 *   UTC 20:30 → 21:30   Kuwait crosses midnight      Karachi 01:30 → 02:30, one day
 *   UTC 19:30           Dubai 23:30 on the 30th      Karachi 00:30 on the 1st
 * ═════════════════════════════════════════════════════════════════════════════
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FALLBACK_SALON_TIME_ZONE,
  chargeTime,
  clockLabel,
  groupByDay,
  nextCalendarDate,
  salonDate,
  salonWeekday,
  weekdayLabel,
} from './salonTime';

const DEVICE_ZONE = 'Asia/Karachi';
const KUWAIT = 'Asia/Kuwait';
const DUBAI = 'Asia/Dubai';

const originalTZ = process.env.TZ;
beforeAll(() => {
  process.env.TZ = DEVICE_ZONE;
});
afterAll(() => {
  if (originalTZ === undefined) delete process.env.TZ;
  else process.env.TZ = originalTZ;
});

const WORDS = { today: 'Today', tomorrow: 'Tomorrow' };

describe('the device is NOT on the salon clock while these run', () => {
  it('the process zone is Karachi', () => {
    expect(process.env.TZ).toBe(DEVICE_ZONE);
    expect(new Date('2026-09-30T07:00:00Z').getTimezoneOffset()).toBe(-300);
    expect(new Date('2026-09-30T07:00:00Z').getHours()).toBe(12);
    // What the old ChargesScreen `timeOf` printed, for contrast: the device's clock.
    expect(new Date('2026-09-30T07:00:00Z').toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit' })).toBe(
      '12:00',
    );
  });
});

describe('a charge row and a booking card — the salon clock', () => {
  it('2026-09-30T07:00:00Z is 10:00 for Asia/Kuwait', () => {
    expect(chargeTime('2026-09-30T07:00:00Z', KUWAIT)).toBe('10:00');
    expect(clockLabel('2026-09-30T07:00:00Z', KUWAIT)).toBe('10:00 am');
  });

  it('and 11:00 for a salon in Asia/Dubai — its own clock, not Kuwait', () => {
    expect(chargeTime('2026-09-30T07:00:00Z', DUBAI)).toBe('11:00');
    expect(clockLabel('2026-09-30T07:00:00Z', DUBAI)).toBe('11:00 am');
  });

  it('the charges header names the salon\'s weekday, not the device\'s', () => {
    const now = new Date('2026-09-30T19:30:00Z'); // Karachi: Thursday 00:30
    expect(salonWeekday(now, KUWAIT)).toBe('Wednesday');
    expect(salonWeekday(now, DUBAI)).toBe('Wednesday');
    expect(salonWeekday(new Date('2026-09-30T20:30:00Z'), DUBAI)).toBe('Thursday');
  });

  it('the fallback before the salon loads is the contract default, never the device', () => {
    expect(FALLBACK_SALON_TIME_ZONE).toBe('Asia/Kuwait');
  });
});

describe('the bookings day headings turn over at the SALON\'s midnight', () => {
  it('calendar arithmetic, month end included', () => {
    expect(nextCalendarDate('2026-09-30')).toBe('2026-10-01');
    expect(nextCalendarDate('2026-12-31')).toBe('2027-01-01');
    expect(salonDate(new Date('2026-09-30T20:30:00Z'), KUWAIT)).toBe('2026-09-30');
    expect(salonDate(new Date('2026-09-30T20:30:00Z'), DUBAI)).toBe('2026-10-01');
  });

  it('Kuwait: one minute past salon midnight, 23:30 last night is no longer Today', () => {
    // Karachi calls both of these 1 October.
    const now = new Date('2026-09-30T21:01:00Z'); // 00:01 on the 1st, Kuwait
    const groups = groupByDay(
      [{ startsAt: '2026-09-30T20:30:00Z' }, { startsAt: '2026-10-01T07:00:00Z' }, { startsAt: '2026-10-02T07:00:00Z' }],
      KUWAIT,
      WORDS,
      now,
    );
    expect(groups.map((g) => g.label)).toEqual(['Wed 30 Sept', 'Today · Thu 1 Oct', 'Tomorrow · Fri 2 Oct']);
  });

  it('Dubai: its own midnight, where Kuwait would still say Today', () => {
    const now = new Date('2026-09-30T20:30:00Z'); // 00:30 on the 1st in Dubai, 23:30 on the 30th in Kuwait
    const bookings = [{ startsAt: '2026-09-30T19:30:00Z' }];
    expect(groupByDay(bookings, DUBAI, WORDS, now).map((g) => g.label)).toEqual(['Wed 30 Sept']);
    expect(groupByDay(bookings, KUWAIT, WORDS, now).map((g) => g.label)).toEqual(['Today · Wed 30 Sept']);
  });

  it('the heading\'s date is the salon\'s', () => {
    expect(weekdayLabel('2026-09-30T20:30:00Z', KUWAIT)).toBe('Wed 30 Sept');
    expect(weekdayLabel('2026-09-30T20:30:00Z', DUBAI)).toBe('Thu 1 Oct');
  });
});

describe('the screens take the zone they are given', () => {
  const read = (name: string) => readFileSync(join(__dirname, '../screens', name), 'utf8');

  it.each(['ChargesScreen.tsx', 'BookingsScreen.tsx'])(
    '%s formats no time in the device zone and hard-codes no salon zone',
    (name) => {
      const src = read(name);
      expect(src).not.toMatch(/toLocale(Time|Date)?String\(/);
      expect(src).not.toMatch(/['"]Asia\/Kuwait['"]/);
      expect(src).not.toMatch(/getHours\(|getDate\(|getDay\(/);
    },
  );
});
