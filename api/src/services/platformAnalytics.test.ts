/**
 * `services/platformAnalytics.ts` — the pure half: the month parameters and the
 * calendar arithmetic every series is keyed by. The aggregates themselves run
 * against Postgres in `routes/platformAnalytics.int.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import {
  currentMonth,
  DEFAULT_HISTORY_MONTHS,
  historyOf,
  monthKey,
  monthStartInstant,
  parseHistoryMonths,
  parseMonth,
  shiftMonth,
} from './platformAnalytics';

const NOW = new Date('2026-10-05T07:00:00.000Z');

describe('the platform month', () => {
  it('is the Kuwait month, not the UTC one, at the boundary', () => {
    // 22:30 UTC on 30 Sep is 01:30 on 1 Oct in Kuwait (+03, no DST).
    expect(monthKey(currentMonth(new Date('2026-09-30T22:30:00.000Z')))).toBe('2026-10');
    expect(monthKey(currentMonth(new Date('2026-09-30T20:59:59.999Z')))).toBe('2026-09');
  });

  it('starts at Kuwait midnight', () => {
    expect(monthStartInstant({ year: 2026, month: 10 }).toISOString()).toBe('2026-09-30T21:00:00.000Z');
    expect(monthStartInstant({ year: 2027, month: 1 }).toISOString()).toBe('2026-12-31T21:00:00.000Z');
  });

  it('shifts across years in both directions', () => {
    expect(monthKey(shiftMonth({ year: 2026, month: 1 }, -1))).toBe('2025-12');
    expect(monthKey(shiftMonth({ year: 2026, month: 12 }, 1))).toBe('2027-01');
    expect(monthKey(shiftMonth({ year: 2026, month: 10 }, -23))).toBe('2024-11');
  });

  it('builds the history oldest first, ending at the selected month', () => {
    expect(historyOf({ year: 2026, month: 2 }, 4).map(monthKey)).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
    expect(historyOf({ year: 2026, month: 2 }, 1).map(monthKey)).toEqual(['2026-02']);
  });
});

describe('?month=', () => {
  it('defaults to the current platform month', () => {
    expect(monthKey(parseMonth(undefined, NOW))).toBe('2026-10');
    expect(monthKey(parseMonth('', NOW))).toBe('2026-10');
  });

  it('takes YYYY-MM up to and including the current month', () => {
    expect(monthKey(parseMonth('2026-10', NOW))).toBe('2026-10');
    expect(monthKey(parseMonth('2019-03', NOW))).toBe('2019-03');
  });

  it.each(['2026-11', '2027-01', '2026-13', '2026-1', '26-10', '2026-10-01', '1999-12', ['2026-01']])(
    'refuses %j',
    (v) => {
      expect(() => parseMonth(v, NOW)).toThrow(expect.objectContaining({ statusCode: 400, code: 'invalid_month' }));
    },
  );
});

describe('?months=', () => {
  it('defaults to twelve', () => {
    expect(parseHistoryMonths(undefined)).toBe(DEFAULT_HISTORY_MONTHS);
    expect(DEFAULT_HISTORY_MONTHS).toBe(12);
  });

  it('takes 1 to 24, as text or a number', () => {
    expect(parseHistoryMonths('1')).toBe(1);
    expect(parseHistoryMonths('24')).toBe(24);
    expect(parseHistoryMonths(6)).toBe(6);
  });

  it.each(['0', '25', '-1', '1.5', 'twelve', 1.5, ['3']])('refuses %j', (v) => {
    expect(() => parseHistoryMonths(v)).toThrow(expect.objectContaining({ statusCode: 400, code: 'invalid_months' }));
  });
});
