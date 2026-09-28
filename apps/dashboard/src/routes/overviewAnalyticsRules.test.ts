/**
 * The analytics grid's rules, held without a card. `overviewAnalyticsRules.ts`
 * carries the argument for each.
 */

import { describe, expect, it } from 'vitest';
import { appointmentHref, readBookingFocus } from './appointmentHref.js';
import { doubtNote, formatBp, heatGrid, heatLevel, joinClauses } from './overviewAnalyticsRules.js';

describe('formatBp — basis points divided by 100 in formatting only', () => {
  it.each([
    [0, '0%'],
    [1, '0.01%'],
    [10, '0.1%'],
    [1200, '12%'],
    [1250, '12.5%'],
    [1234, '12.34%'],
    [3333, '33.33%'],
    [6667, '66.67%'],
    [10000, '100%'],
  ])('%i bp is %s', (bp, text) => {
    expect(formatBp(bp)).toBe(text);
  });

  it('refuses a fraction rather than rounding it a second time', () => {
    expect(formatBp(12.5)).toBe('—');
    expect(formatBp(-1)).toBe('—');
  });
});

describe('the heatmap', () => {
  it('rounds a quiet cell UP, so a visit that happened never draws as none', () => {
    expect(heatLevel(0, 40)).toBe(0);
    expect(heatLevel(1, 40)).toBe(1);
    expect(heatLevel(10, 40)).toBe(1);
    expect(heatLevel(11, 40)).toBe(2);
    expect(heatLevel(40, 40)).toBe(4);
  });

  it('draws all seven days and trims the hours to the first and last visit, gaps kept', () => {
    const grid = heatGrid([
      { weekday: 1, hour: 10, visits: 2 },
      { weekday: 5, hour: 14, visits: 4 },
    ]);
    expect(grid.rows).toHaveLength(7);
    expect(grid.hours).toEqual([10, 11, 12, 13, 14]);
    expect(grid.rows[5]!.cells[4]).toEqual({ hour: 14, visits: 4, level: 4 });
    expect(grid.rows[1]!.cells[2]).toEqual({ hour: 12, visits: 0, level: 0 });
  });

  it('places cells where the server put them and converts nothing', () => {
    const grid = heatGrid([{ weekday: 0, hour: 23, visits: 1 }]);
    expect(grid.hours).toEqual([23]);
    expect(grid.rows[0]!.cells[0]!.visits).toBe(1);
  });
});

describe('the doubt note', () => {
  it('is the Overview sentence, and nothing when there is no doubt', () => {
    expect(doubtNote(null, 'visits')).toBeNull();
    expect(doubtNote({ assumed: 0, total: 9 }, 'visits')).toBeNull();
    expect(doubtNote({ assumed: 2, total: 9 }, 'visits')).toBe(
      'Branch assumed on 2 of 9 visits — treat these branch figures as approximate.',
    );
  });

  it('keeps the list grammar Reports reads through the re-export', () => {
    expect(joinClauses(['a', 'b', 'c'])).toBe('a, b and c');
  });
});

describe('a link to one appointment', () => {
  it('carries the SALON day, not the viewer’s', () => {
    // 23:30 in Kuwait on 30 Sep is 01:30 on 1 Oct in Karachi.
    expect(appointmentHref('BK-1', '2026-09-30T20:30:00.000Z', 'Asia/Kuwait')).toBe(
      '/appointments?booking=BK-1&day=2026-09-30',
    );
    expect(appointmentHref('BK-1', '2026-09-30T20:30:00.000Z', 'Asia/Karachi')).toBe(
      '/appointments?booking=BK-1&day=2026-10-01',
    );
  });

  it('is read back by the board, and a malformed day is dropped', () => {
    expect(readBookingFocus('?booking=BK-1&day=2026-09-30')).toEqual({ bookingId: 'BK-1', day: '2026-09-30' });
    expect(readBookingFocus('?booking=BK-1&day=tomorrow')).toEqual({ bookingId: 'BK-1', day: null });
    expect(readBookingFocus('?day=2026-09-30')).toBeNull();
    expect(readBookingFocus('')).toBeNull();
  });
});
