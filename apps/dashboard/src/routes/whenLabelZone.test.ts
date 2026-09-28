/**
 * A BOOKING'S TIME IS READ IN THE SALON'S CLOCK — ASSERTED FROM A DIFFERENT ONE.
 *
 * The bug this file pins was found live, not by a test: SAL-AMARA (`Asia/Kuwait`,
 * +03:00) viewed from a Mac in Pakistan (+05:00). `2026-09-30T07:00:00Z` is 10:00
 * in Kuwait and the Appointments list drew "12:00 PM", beside a form that names
 * its field `Time (Asia/Kuwait)`.
 *
 * NO TEST COULD HAVE CAUGHT IT, AND NOT BECAUSE A SETUP PINNED KUWAIT. Nothing in
 * `apps/dashboard` pins `TZ` at all — no setup file, no `test.env`, no script —
 * so the suite runs in whatever zone the machine is in. `whenLabel` had no test
 * of its own either; the only render tests that reach it assert names and money,
 * never the clock. On a Kuwait machine a wrong-zone formatter and a right-zone
 * one print the same string, so even a test of the output would have passed there.
 *
 * SO THE PROCESS IS PINNED TO A ZONE THAT IS NOT THE SALON'S, and the pin is
 * itself asserted below: a suite that silently ran in Kuwait would pass every
 * case here for the wrong reason. `process.env.TZ` is re-read by Node when it is
 * assigned, which is the method `apps/wallet/src/domain/pickupHours.test.ts`
 * already uses for the device-zone half of the same argument.
 *
 * `vi.setSystemTime` rather than a `now` argument, so the same assertions run
 * unchanged against the pre-fix `whenLabel(iso)` — which is how they were shown
 * red before the fix went in.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { whenLabel } from './appointmentWhen.js';
import { whenLabel as feedWhenLabel } from './AuditLog.js';

const VIEWER = 'Asia/Karachi'; // +05:00, no DST
const SALON = 'Asia/Kuwait'; //  +03:00, no DST

const originalTZ = process.env.TZ;
beforeAll(() => {
  process.env.TZ = VIEWER;
});
afterAll(() => {
  if (originalTZ === undefined) delete process.env.TZ;
  else process.env.TZ = originalTZ;
});
afterEach(() => {
  vi.useRealTimers();
});

function at(now: string) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(now));
}

describe('the pin', () => {
  it('this process really is in Karachi, two hours off the salon', () => {
    // 07:00Z is 12:00 in Karachi. If this reads 10, the suite is in Kuwait and
    // every case below is passing for the wrong reason.
    expect(new Date('2026-09-30T07:00:00Z').getHours()).toBe(12);
  });
});

describe('Appointments whenLabel, in the salon clock', () => {
  it('BK-10000005: 07:00Z renders 10:00 AM for Asia/Kuwait, not the viewer’s 12:00 PM', () => {
    at('2026-09-28T09:00:00Z');
    const label = whenLabel('2026-09-30T07:00:00Z', SALON);
    expect(label).toContain('10:00 AM');
    expect(label).not.toContain('12:00 PM');
    expect(label).toMatch(/^30 Sept? · 10:00 AM$/);
  });

  it('the day before, the same booking is "Tomorrow · 10:00 AM"', () => {
    at('2026-09-29T09:00:00Z'); // 12:00 Kuwait, 29 Sep
    expect(whenLabel('2026-09-30T07:00:00Z', SALON)).toBe('Tomorrow · 10:00 AM');
  });

  it('22:30 in Kuwait is still Today there, though Karachi is already on tomorrow', () => {
    at('2026-09-28T12:00:00Z'); // 15:00 Kuwait / 17:00 Karachi, both 28 Sep
    // 19:30Z = 22:30 Kuwait on the 28th = 00:30 Karachi on the 29th.
    expect(whenLabel('2026-09-28T19:30:00Z', SALON)).toBe('Today · 10:30 PM');
  });

  it('Today follows the salon’s midnight, not the viewer’s', () => {
    at('2026-09-28T20:00:00Z'); // 23:00 Kuwait on the 28th / 01:00 Karachi on the 29th
    // 21:30Z = 00:30 Kuwait on the 29th: tomorrow in the salon, "today" in Karachi.
    expect(whenLabel('2026-09-28T21:30:00Z', SALON)).toBe('Tomorrow · 12:30 AM');
    // 18:00Z = 21:00 Kuwait on the 28th: today in the salon, "yesterday" in Karachi.
    expect(whenLabel('2026-09-28T18:00:00Z', SALON)).toBe('Today · 9:00 PM');
  });

  it('Yesterday is the salon’s yesterday', () => {
    at('2026-09-28T21:30:00Z'); // 00:30 Kuwait on the 29th / 02:30 Karachi on the 29th
    // 20:30Z = 23:30 Kuwait on the 28th: yesterday in the salon.
    expect(whenLabel('2026-09-28T20:30:00Z', SALON)).toBe('Yesterday · 11:30 PM');
  });
});

describe('feed whenLabel (audit log, orders), in the salon clock', () => {
  it('draws the salon’s 24-hour clock and the salon’s Today', () => {
    at('2026-09-28T12:00:00Z');
    expect(feedWhenLabel('2026-09-28T19:30:00Z', SALON)).toBe('Today · 22:30');
    expect(feedWhenLabel('2026-09-28T07:00:00Z', SALON)).toBe('Today · 10:00');
  });

  it('Yesterday is the salon’s yesterday', () => {
    at('2026-09-28T21:30:00Z'); // 00:30 Kuwait on the 29th
    expect(feedWhenLabel('2026-09-28T20:30:00Z', SALON)).toBe('Yesterday · 23:30');
  });
});

describe('a zone the salon read cannot supply', () => {
  /*
   * NEVER THE BROWSER'S ZONE. That fallback is the bug. A row with no usable
   * salon zone — the read still in flight, or an id the engine does not know —
   * prints the true instant in UTC and SAYS so, rather than Karachi's 12:00 PM
   * unlabelled.
   */
  it('falls back to UTC and names it — never to the viewer’s zone', () => {
    at('2026-09-28T09:00:00Z');
    expect(whenLabel('2026-09-30T07:00:00Z', null)).toMatch(/^30 Sept? · 7:00 AM UTC$/);
    expect(whenLabel('2026-09-30T07:00:00Z', 'Mars/Olympus_Mons')).toMatch(/· 7:00 AM UTC$/);
    expect(feedWhenLabel('2026-09-28T07:00:00Z', null)).toBe('Today · 07:00 UTC');
  });

  it('an unparseable instant is "unknown", not "Invalid Date"', () => {
    expect(whenLabel('not-a-date', SALON)).toBe('unknown');
    expect(feedWhenLabel('not-a-date', SALON)).toBe('unknown');
  });
});
