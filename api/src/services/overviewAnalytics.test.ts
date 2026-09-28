/**
 * The two pieces of `services/overviewAnalytics.ts` that are arithmetic rather
 * than SQL: the basis-point rounding and the salon-local week buckets. Everything
 * that is a claim about ROWS is in `overviewAnalytics.int.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import { basisPoints, weeksOf } from './overviewAnalytics';
import { parsePeriod, resolveWindow } from './period';

describe('basisPoints — integer shares, rounded half up', () => {
  it('is null, not 0, when there is nothing to take a share of', () => {
    expect(basisPoints(0, 0)).toBeNull();
  });

  it('is exact where it can be', () => {
    expect(basisPoints(1, 4)).toBe(2500);
    expect(basisPoints(3, 3)).toBe(10000);
    expect(basisPoints(0, 7)).toBe(0);
  });

  it('rounds half UP, and below half down', () => {
    // 1/3 = 3333.33… → 3333; 2/3 = 6666.67 → 6667
    expect(basisPoints(1, 3)).toBe(3333);
    expect(basisPoints(2, 3)).toBe(6667);
    // 1/8000 = 1.25 bp → 1; 1/16000 = 0.625 → 1; 1/40000 = 0.25 → 0
    expect(basisPoints(1, 8000)).toBe(1);
    expect(basisPoints(1, 16000)).toBe(1);
    expect(basisPoints(1, 40000)).toBe(0);
    // exactly half a basis point: 1/20000 = 0.5 → 1
    expect(basisPoints(1, 20000)).toBe(1);
  });

  it('stays exact past 2^53 intermediate products — BigInt, not a float division', () => {
    // 900 million dinars in fils: a*20000 is ~1.8e16, above Number.MAX_SAFE_INTEGER.
    const whole = 900_000_000_000;
    expect(basisPoints(whole / 3, whole)).toBe(3333);
    expect(basisPoints(whole - 1, whole)).toBe(10000);
  });

  it('refuses a fraction rather than rounding one into a share', () => {
    expect(() => basisPoints(1.5, 3)).toThrow(TypeError);
  });
});

describe('weeksOf — Sunday-first weeks in the salon zone', () => {
  const tz = 'Asia/Kuwait';

  it('a calendar range that starts on a Sunday and ends on a Saturday is whole weeks', () => {
    // 2026-09-06 is a Sunday; 2026-09-19 a Saturday.
    const w = resolveWindow(parsePeriod('2026-09-06_2026-09-19'), tz, new Date());
    expect(weeksOf(w)).toEqual([
      { weekStart: '2026-09-06', partial: false },
      { weekStart: '2026-09-13', partial: false },
    ]);
  });

  it('clipped weeks at either end are marked partial', () => {
    // Wed 2026-09-09 → Mon 2026-09-21
    const w = resolveWindow(parsePeriod('2026-09-09_2026-09-21'), tz, new Date());
    expect(weeksOf(w)).toEqual([
      { weekStart: '2026-09-06', partial: true },
      { weekStart: '2026-09-13', partial: false },
      { weekStart: '2026-09-20', partial: true },
    ]);
  });

  it("the week boundary is the SALON'S Sunday midnight, not UTC's", () => {
    // 21:30Z on Saturday 2026-09-12 is 00:30 Sunday 2026-09-13 in Kuwait. A 7d
    // rolling window ending then must already be in the week of the 13th.
    const now = new Date('2026-09-12T21:30:00.000Z');
    const w = resolveWindow(parsePeriod('7d'), tz, now);
    const weeks = weeksOf(w);
    expect(weeks[weeks.length - 1]).toEqual({ weekStart: '2026-09-13', partial: true });
    expect(weeks[0]).toEqual({ weekStart: '2026-09-06', partial: true });
  });
});
