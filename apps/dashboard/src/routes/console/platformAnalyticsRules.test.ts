/**
 * OWNER CONSOLE → ANALYTICS — the rules the page renders, held without a card.
 * `platformAnalyticsRules.ts` carries every decision; each `describe` below is one.
 */

import { describe, expect, it } from 'vitest';
import type { PlatformSalon } from '../../api/platformSalons.js';
import {
  BAR_MAX_PX,
  allZero,
  barPx,
  durationLabel,
  momentum,
  monthLong,
  monthOf,
  monthOptions,
  monthParam,
  monthShort,
  monthShortYear,
  monthsParam,
  rankLeaderboard,
  resolveAnalyticsSalon,
  salonOptions,
  shiftMonthKey,
  withheldCopy,
  withheldShort,
  type LeaderboardRow,
} from './platformAnalyticsRules.js';

const salon = (id: string, name: string) => ({ id, name }) as PlatformSalon;

describe('month keys are text, shifted in integers', () => {
  it('labels a key short, short with year, and long', () => {
    expect(monthShort('2026-10')).toBe('Oct');
    expect(monthShortYear('2026-01')).toBe('Jan 2026');
    expect(monthLong('2025-12')).toBe('December 2025');
  });

  it('hands back anything that is not a month key unchanged', () => {
    expect(monthShort('2026-13')).toBe('2026-13');
    expect(monthLong('soon')).toBe('soon');
  });

  it('shifts across a year boundary both ways', () => {
    expect(shiftMonthKey('2026-01', -1)).toBe('2025-12');
    expect(shiftMonthKey('2025-12', 1)).toBe('2026-01');
    expect(shiftMonthKey('2026-10', -23)).toBe('2024-11');
  });

  it('offers 24 months, newest first, ending at the current one', () => {
    const options = monthOptions('2026-10');
    expect(options).toHaveLength(24);
    expect(options[0]).toBe('2026-10');
    expect(options[23]).toBe('2024-11');
  });

  it('asks which month it is in the server’s zone, not the browser’s', () => {
    // 22:30 UTC on 30 Sep is already 1 Oct in Kuwait (+03).
    const at = new Date('2026-09-30T22:30:00Z');
    expect(monthOf(at, 'Asia/Kuwait')).toBe('2026-10');
    expect(monthOf(at, 'UTC')).toBe('2026-09');
  });

  it('falls back to the browser zone for a zone Intl does not know, rather than throwing', () => {
    expect(monthOf(new Date('2026-06-15T12:00:00Z'), 'Mars/Olympus')).toMatch(/^2026-06$/);
  });
});

describe('the URL is input', () => {
  it('keeps a past month and drops the current one (the default view has one URL)', () => {
    expect(monthParam('2026-08', '2026-10')).toBe('2026-08');
    expect(monthParam('2026-10', '2026-10')).toBeNull();
  });

  it('drops a future month and anything that is not a month', () => {
    expect(monthParam('2026-11', '2026-10')).toBeNull();
    expect(monthParam('2026-1', '2026-10')).toBeNull();
    expect(monthParam('', '2026-10')).toBeNull();
  });

  it('offers 6, 12 and 24 months of history, and sends nothing for the default 12', () => {
    expect(monthsParam('6')).toBe(6);
    expect(monthsParam('24')).toBe(24);
    expect(monthsParam('12')).toBeNull();
    expect(monthsParam('')).toBeNull();
    expect(monthsParam('7')).toBeNull();
  });
});

describe('a ?salon= is checked against the salons that exist — except for the analyst', () => {
  const list = (salons: PlatformSalon[], o: { isError?: boolean; complete?: boolean } = {}) => ({
    salons,
    isError: o.isError ?? false,
    complete: o.complete ?? true,
  });

  it('sends a salon the list contains', () => {
    expect(resolveAnalyticsSalon('S1', list([salon('S1', 'Amara')]))).toEqual({ salonId: 'S1', waiting: false });
  });

  it('waits while the list is still walking, so every salon’s figures do not flash first', () => {
    expect(resolveAnalyticsSalon('S9', list([], { complete: false }))).toEqual({ salonId: null, waiting: true });
  });

  it('ignores an id a finished list does not contain', () => {
    expect(resolveAnalyticsSalon('S9', list([salon('S1', 'Amara')]))).toEqual({ salonId: null, waiting: false });
  });

  it('SENDS the id when the list is refused — the analyst cannot read Salons, and the server checks it', () => {
    expect(resolveAnalyticsSalon('S9', list([], { isError: true, complete: false }))).toEqual({
      salonId: 'S9',
      waiting: false,
    });
  });

  it('builds the picker from the salon list, sorted by name', () => {
    expect(salonOptions([salon('S2', 'Zahra'), salon('S1', 'Amara')], undefined)).toEqual([
      { value: 'S1', label: 'Amara' },
      { value: 'S2', label: 'Zahra' },
    ]);
  });
});

describe('figures', () => {
  it('states month-on-month as an integer percent, and nothing against a zero month', () => {
    expect(momentum(10900, 10000)).toBe('+9% MoM');
    expect(momentum(9000, 10000)).toBe('-10% MoM');
    expect(momentum(5000, 0)).toBeNull();
  });

  it('sizes bars in whole pixels against the tallest, and zero against a zero peak', () => {
    expect(barPx(500, 1000)).toBe(BAR_MAX_PX / 2);
    expect(barPx(1000, 1000)).toBe(BAR_MAX_PX);
    expect(barPx(1, 3)).toBe(43);
    expect(barPx(0, 0)).toBe(0);
    expect(Number.isInteger(barPx(7, 9))).toBe(true);
  });

  it('knows an all-zero series', () => {
    expect(allZero([0, 0, 0])).toBe(true);
    expect(allZero([0, 1])).toBe(false);
  });

  it('reads a decision time as a person would, in integer steps', () => {
    expect(durationLabel(45)).toBe('45s');
    expect(durationLabel(12 * 60 + 59)).toBe('12m');
    expect(durationLabel(4 * 3600 + 12 * 60)).toBe('4h 12m');
    expect(durationLabel(3 * 3600)).toBe('3h');
    expect(durationLabel(2 * 86400 + 3 * 3600)).toBe('2d 3h');
    expect(durationLabel(-1)).toBe('—');
  });
});

describe('the leaderboard ranks on integers, ties by name', () => {
  const row = (salonId: string, name: string, o: Partial<LeaderboardRow> = {}): LeaderboardRow => ({
    salonId,
    name,
    modules: { booking: true, shop: true },
    members: 0,
    activeMembers: 0,
    loadedFils: 0,
    spentFils: 0,
    avoRevenueFils: 0,
    bookings: null,
    noShowRateBp: null,
    shopRevenueFils: null,
    liabilityFils: 0,
    ...o,
  });
  const rows = [
    row('S1', 'Bloom', { loadedFils: 5000, members: 3, avoRevenueFils: 75 }),
    row('S2', 'Amara', { loadedFils: 5000, members: 9, avoRevenueFils: 10 }),
    row('S3', 'Cedar', { loadedFils: 9000, members: 1, avoRevenueFils: 150 }),
  ];

  it('by loaded, with the name breaking a tie', () => {
    expect(rankLeaderboard(rows, 'loaded').map((r) => r.name)).toEqual(['Cedar', 'Amara', 'Bloom']);
  });

  it('by members and by revenue, without reordering the input', () => {
    expect(rankLeaderboard(rows, 'members').map((r) => r.name)).toEqual(['Amara', 'Bloom', 'Cedar']);
    expect(rankLeaderboard(rows, 'revenue').map((r) => r.name)).toEqual(['Cedar', 'Bloom', 'Amara']);
    expect(rows.map((r) => r.name)).toEqual(['Bloom', 'Amara', 'Cedar']);
  });
});

describe('withheld is a sentence, never a zero', () => {
  it('names the console section a permission block needs', () => {
    expect(withheldCopy('campaigns', { status: 'withheld', reason: 'permission', permission: 'approvals' }, null)).toBe(
      "You don't have access to Approvals, so these figures aren't shown.",
    );
    expect(withheldShort({ status: 'withheld', reason: 'permission', permission: 'policies' })).toBe(
      'No access to Policies',
    );
  });

  it('names the salon that does not run a module, and how to see the platform’s figure', () => {
    expect(withheldCopy('bookings', { status: 'withheld', reason: 'module_off', permission: null }, 'Amara')).toBe(
      "Amara doesn't take bookings through AVO. Choose All salons to see bookings across the platform.",
    );
    expect(withheldCopy('shop', { status: 'withheld', reason: 'module_off', permission: null }, null)).toMatch(
      /^This salon doesn't run the AVO shop\./,
    );
  });
});
