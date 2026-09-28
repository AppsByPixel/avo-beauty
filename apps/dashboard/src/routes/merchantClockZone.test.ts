/**
 * EVERY OTHER MERCHANT CLOCK, IN THE SALON'S ZONE — ASSERTED FROM KARACHI.
 *
 * `whenLabelZone.test.ts` pins the Appointments and feed-stamp formatters. The
 * sweep that followed found the same browser-zoned formatting in the Overview
 * feed and the notification bell (one shared `feedStamp` now), the header's
 * date, and the customer book's dates. Same pin, same reason: a suite running
 * in Kuwait passes all of these for the wrong reason, so the pin is asserted.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { fullDate, monthYear, whenLabel as historyWhen } from './Customers.js';
import { feedStamp } from './salonTime.js';
import { todayLabel } from '../shell/Header.js';

const SALON = 'Asia/Kuwait';
const saved = process.env.TZ;
beforeAll(() => {
  process.env.TZ = 'Asia/Karachi';
});
afterAll(() => {
  if (saved === undefined) delete process.env.TZ;
  else process.env.TZ = saved;
});
afterEach(() => {
  vi.useRealTimers();
});

// 20:00Z on the 28th: 23:00 in Kuwait (still the 28th), 01:00 in Karachi (the 29th).
const LATE = new Date('2026-09-28T20:00:00.000Z');

describe('the pin', () => {
  it('this process really is in Karachi', () => {
    expect(new Date('2026-09-30T07:00:00Z').getHours()).toBe(12);
  });
});

describe('Overview feed and notification bell — feedStamp', () => {
  it('a 22:30 Kuwait top-up is today’s "22:30", not tomorrow’s "00:30"', () => {
    expect(feedStamp('2026-09-28T19:30:00.000Z', SALON, LATE)).toBe('22:30');
  });
  it('anything before the salon’s midnight carries the salon’s date', () => {
    expect(feedStamp('2026-09-27T20:30:00.000Z', SALON, LATE)).toMatch(/^27 Sept? · 23:30$/);
  });
  it('an unusable zone says UTC rather than borrowing the browser’s', () => {
    expect(feedStamp('2026-09-28T19:30:00.000Z', null, LATE)).toBe('19:30 UTC');
  });
});

describe('the header date', () => {
  it('names the salon’s today, not Karachi’s tomorrow', () => {
    expect(todayLabel(SALON, LATE)).toBe('Monday · 28 September 2026');
  });
  it('is empty until the salon read lands, like the salon name beside it', () => {
    expect(todayLabel(null, LATE)).toBe('');
  });
});

describe('the customer book', () => {
  // 21:30Z on 31 March: 00:30 on 1 April in Kuwait, 02:30 on 1 April in Karachi —
  // and 20:30Z is 23:30 on 31 March in Kuwait but 01:30 on 1 April in Karachi.
  it('"member since" is the salon’s month', () => {
    expect(monthYear('2026-03-31T20:30:00.000Z', SALON)).toBe('Mar 2026');
  });
  it('the joined date is the salon’s day', () => {
    expect(fullDate('2026-03-31T20:30:00.000Z', SALON)).toBe('31 Mar 2026');
  });
  it('a history line is the salon’s date and clock', () => {
    expect(historyWhen('2026-03-31T20:30:00.000Z', SALON)).toBe('31 Mar · 23:30');
  });
});
