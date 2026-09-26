// @vitest-environment jsdom

/**
 * Merchant → Appointments → Week.
 *
 * NEW WORK, AND THE FIRST CALENDAR ON ANY AVO SURFACE. `design/AVO Merchant
 * Dashboard.dc.html` draws none — every "calendar" in it is Google Calendar as
 * an AVAILABILITY SOURCE (`:197`, `:236`, `:1139`) — so there is no artboard to
 * check this against and every rule it keeps is one
 * `routes/appointmentsWeekRules.ts` argues in prose. These are the assertions
 * that make the prose binding.
 *
 * WHY IT RENDERS RATHER THAN READS THE SOURCE: `salesTrendRender.test.tsx`'s
 * reason, and the two rules most worth breaking here are both invisible in
 * source text — WHICH COLUMN a booking lands in, and whether a released slot is
 * distinguishable from a booked one. A `placeBooking` that uses the browser's
 * zone and one that uses the salon's are one argument apart and read
 * identically; only the tree says which column the chip is in.
 *
 * AND ONE RULE IS MUTATION-CHECKED RATHER THAN MERELY ASSERTED — see § THE
 * COMPLETENESS RULE. Its failure mode is silence: a grid that is missing chips
 * looks exactly like a grid of a quiet week, so a test that only exercises the
 * happy path passes on every broken version of it.
 *
 * Cleanup is manual — no `globals: true` in this project, so
 * `@testing-library/react` registers no `afterEach(cleanup)` of its own.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Chip,
  UnplaceableNotice,
  UnusableZone,
  WeekEmpty,
  WeekGrid,
  WeekShell,
  WeekSkeleton,
  WeekTooDeep,
  WeekWalking,
  weekTitle,
} from './AppointmentsWeek.js';
import {
  APWEEK_ROW_PX,
  MIN_SLOT_MINUTES,
  STATUS_PILL,
  WALK_BUDGET,
  WEEK_DAYS,
  assignLanes,
  chipBox,
  chipDensity,
  chipLabel,
  chipShape,
  clockLabel,
  clockMinutes,
  compactClockLabel,
  hourLabel,
  makeZoneClock,
  oldestLocalDate,
  placeBooking,
  rulerHours,
  rulerRange,
  weekColumns,
  weekWindow,
  weekdayIndex,
  weekdayShort,
  windowCoverage,
  type Coverage,
  type WalkState,
  type ZoneClock,
} from './appointmentsWeekRules.js';
import { patchBookingStatus, type MerchantBooking } from '../api/bookings.js';
import type { Salon } from '@avo/types';

afterEach(cleanup);

/** The real stylesheet, read the way `noShowMarkRender.test.tsx` reads it. */
/**
 * THE PATH GOES THROUGH A VARIABLE, AND IT HAS TO.
 *
 * Vite treats a LITERAL `new URL('./thing.css', import.meta.url)` as an asset
 * reference and rewrites it at transform time — the first draft of this line
 * resolved to `http://localhost:3000/src/app.css` and `fileURLToPath` refused
 * it ("The URL must be of scheme file"). A variable is opaque to that rewrite,
 * which is why `noShowMarkRender.test.tsx` reads its stylesheets through a
 * helper taking a parameter. Same shape here, for the same reason.
 */
function cssFrom(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
}

/** The real stylesheet — the other half of the row-height constant. */
const APP_CSS = cssFrom('../app.css');

/* -------------------------------------------------------------- fixtures -- */

const KUWAIT = makeZoneClock('Asia/Kuwait') as ZoneClock;

/**
 * One booking, in the shape `GET /salons/{id}/bookings` actually serves —
 * `BookingSchema` plus the five computed fields plus the seven the
 * `perms.appointments` join adds. Every spec below varies this rather than
 * inventing a partial row, so a field the grid starts reading is a field the
 * fixtures already have.
 */
const BOOKING: MerchantBooking = {
  id: 'BK-001',
  memberId: 'MEM-011',
  // A member booking names no guest. Exactly one of the two is ever set.
  guestName: null,
  guestPhone: null,
  artistId: 'ART-003',
  serviceId: 'SVC-007',
  branchId: 'BR-001',
  startsAt: '2026-09-29T07:00:00.000Z',
  endsAt: '2026-09-29T08:30:00.000Z',
  durationMin: 90,
  depositFils: 5000,
  status: 'deposit_held',
  source: 'app',
  noShowReturnDueAt: '2026-09-29T08:00:00.000Z',
  changeableUntil: '2026-09-28T07:00:00.000Z',
  rescheduledCount: 0,
  calendarSyncState: 'synced',
  branchAssumed: false,
  memberName: 'Noura Al-Ajmi',
  memberPhone: '+96590000001',
  memberErased: false,
  memberTier: 'gold',
  artistName: 'Dana',
  serviceName: 'Balayage',
};

const at = (over: Partial<MerchantBooking>): MerchantBooking => ({ ...BOOKING, ...over });

/** The week of Sunday 27 September 2026 — the window most specs below draw. */
const WEEK = ['2026-09-27', '2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03'];

/* ========================================================================== */
/* 1 · THE ZONE — A BOOKING LANDS IN THE COLUMN THE SALON WOULD POINT AT      */
/* ========================================================================== */

describe('a booking lands in the right cell for the salon’s zone', () => {
  it('places a mid-day instant on the salon’s date at the salon’s minute', () => {
    const placed = placeBooking(BOOKING, KUWAIT);
    // 07:00Z is 10:00 in Kuwait (UTC+3), running to 11:30.
    expect(placed?.date).toBe('2026-09-29');
    expect(placed?.startMin).toBe(10 * 60);
    expect(placed?.endMin).toBe(11 * 60 + 30);
  });

  /**
   * THE SPEC THAT TELLS A ZONE-AWARE GRID FROM A UTC ONE. 21:30Z on the 29th is
   * half past midnight on the THIRTIETH in Kuwait, so the chip belongs in the
   * next column. A grid that read the instant's UTC date — or the browser's,
   * under a CI runner pinned to UTC — draws it on the 29th and the salon reads
   * a Tuesday night appointment that is actually Wednesday's first.
   */
  it('puts a late-evening instant in the NEXT day’s column when the salon has rolled over', () => {
    const placed = placeBooking(
      at({ startsAt: '2026-09-29T21:30:00.000Z', endsAt: '2026-09-29T22:30:00.000Z' }),
      KUWAIT,
    );
    expect(placed?.date).toBe('2026-09-30');
    expect(placed?.startMin).toBe(30);
    expect(new Date('2026-09-29T21:30:00.000Z').toISOString().slice(0, 10)).toBe('2026-09-29');
  });

  it('reads a different zone differently, so the zone is genuinely consulted', () => {
    const newYork = makeZoneClock('America/New_York') as ZoneClock;
    const instant = at({ startsAt: '2026-09-29T02:00:00.000Z', endsAt: '2026-09-29T03:00:00.000Z' });
    expect(placeBooking(instant, KUWAIT)?.date).toBe('2026-09-29');
    expect(placeBooking(instant, newYork)?.date).toBe('2026-09-28');
  });

  it('refuses a zone Intl does not know, rather than falling back to the browser’s', () => {
    expect(makeZoneClock('Mars/Olympus_Mons')).toBeNull();
    expect(makeZoneClock('')).toBeNull();
  });

  it('refuses an instant it cannot read rather than inventing a time', () => {
    expect(KUWAIT.at(new Date('not a date'))).toBeNull();
    expect(placeBooking(at({ startsAt: 'yesterday-ish' }), KUWAIT)).toBeNull();
  });

  /**
   * MIDNIGHT IS MINUTE 0 OF ITS OWN DAY, NOT MINUTE 1440 OF THE ONE BEFORE.
   * `hourCycle: 'h23'` is stated rather than inferred because several engines
   * render midnight as "24" under `hour12: false`, which would push a 00:15
   * booking off the bottom of the previous column.
   */
  it('puts salon midnight at the top of its own column', () => {
    const placed = placeBooking(
      at({ startsAt: '2026-09-29T21:00:00.000Z', endsAt: '2026-09-29T22:00:00.000Z' }),
      KUWAIT,
    );
    expect(placed?.date).toBe('2026-09-30');
    expect(placed?.startMin).toBe(0);
  });

  it('clips an appointment that runs past salon midnight and says it continues', () => {
    const placed = placeBooking(
      at({ startsAt: '2026-09-29T20:30:00.000Z', endsAt: '2026-09-29T22:00:00.000Z' }),
      KUWAIT,
    );
    expect(placed?.date).toBe('2026-09-29');
    expect(placed?.endMin).toBe(1440);
    expect(placed?.continues).toBe(true);
  });

  it('clamps an end that precedes its start instead of dropping the booking', () => {
    const placed = placeBooking(
      at({ startsAt: '2026-09-29T07:00:00.000Z', endsAt: '2026-09-29T06:00:00.000Z' }),
      KUWAIT,
    );
    expect(placed?.startMin).toBe(600);
    expect(placed?.endMin).toBe(600);
    // The display boundary is where the legible floor is applied, not the data.
    expect(chipBox({ ...placed!, lane: 0, lanes: 1 }, { startMin: 540, endMin: 1140 }).height).toBeCloseTo(
      (MIN_SLOT_MINUTES / 600) * 100,
      6,
    );
  });
});

/* ========================================================================== */
/* 2 · THE WINDOW                                                            */
/* ========================================================================== */

describe('the week is seven salon-local days starting Sunday', () => {
  it('opens on the Sunday of the week containing today', () => {
    // 2026-09-30T09:00Z is Wednesday noon in Kuwait.
    const w = weekWindow(KUWAIT, new Date('2026-09-30T09:00:00.000Z'), 0);
    expect(w).toEqual({ from: '2026-09-27', to: '2026-10-03', days: WEEK });
    expect(weekdayShort(w!.from)).toBe('Sun');
    expect(weekdayIndex(w!.from)).toBe(0);
    expect(w!.days).toHaveLength(WEEK_DAYS);
  });

  it('treats a Sunday as the first day of its own week, not the last of the one before', () => {
    const w = weekWindow(KUWAIT, new Date('2026-09-27T09:00:00.000Z'), 0);
    expect(w?.from).toBe('2026-09-27');
  });

  it('steps whole weeks in both directions', () => {
    const now = new Date('2026-09-30T09:00:00.000Z');
    expect(weekWindow(KUWAIT, now, -1)?.from).toBe('2026-09-20');
    expect(weekWindow(KUWAIT, now, 1)?.from).toBe('2026-10-04');
    expect(weekWindow(KUWAIT, now, 2)?.to).toBe('2026-10-17');
  });

  /**
   * THE WINDOW IS THE SALON'S WEEK, NOT THE BROWSER'S. At 21:30Z on a Saturday
   * the salon is already in Sunday, so the week it should open on is the NEXT
   * one. This is the same rule as the column placement, one level up, and it is
   * the one that decides which seven days are asked about at all.
   */
  it('rolls into the next week at the salon’s midnight, not the browser’s', () => {
    expect(weekWindow(KUWAIT, new Date('2026-10-03T21:30:00.000Z'), 0)?.from).toBe('2026-10-04');
    expect(weekWindow(KUWAIT, new Date('2026-10-03T20:30:00.000Z'), 0)?.from).toBe('2026-09-27');
  });

  it.each([
    [0, 'This week'],
    [-1, 'Last week'],
    [1, 'Next week'],
    [-3, '3 weeks back'],
    [4, '4 weeks ahead'],
  ])('names the offset %i as %s', (offset, label) => {
    expect(offset === 0 ? 'This week' : weekTitle(offset as number)).toBe(label);
  });
});

/* ========================================================================== */
/* 3 · § THE COMPLETENESS RULE — ASSERTED, THEN MUTATION-CHECKED             */
/* ========================================================================== */

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE ONE RULE ON THIS SCREEN WHOSE FAILURE IS SILENT BY DEFINITION
 * ═══════════════════════════════════════════════════════════════════════════
 * `GET /salons/{id}/bookings` caps a page at 200, orders `starts_at DESC` and
 * takes no date range, so the first page is the furthest-future appointments and
 * today is somewhere below. A grid drawn before the walk has passed the window's
 * first day is missing chips — and a missing chip is an EMPTY HOUR, which reads
 * as free time and is acted on. There is no red state, no console line and no
 * wrong number: the screen looks exactly like a quiet Thursday.
 *
 * So the cases below are not a sample. They are asserted against the real
 * function AND then re-run against eight deliberately broken versions of it, and
 * each mutant must fail at least one of the very same expectations. That is what
 * makes this a test of the RULE rather than of one path through it: a case set
 * that cannot tell `<` from `<=` would pass every day and ship the defect.
 */

interface Case {
  name: string;
  walk: WalkState;
  from: string;
  expected: Coverage['kind'];
}

const base: WalkState = {
  oldestSeenDate: null,
  exhausted: false,
  fetching: false,
  pages: 0,
  budget: WALK_BUDGET,
};

const CASES: Case[] = [
  {
    name: 'the walk has passed the first day, so nothing in the window can still be out there',
    walk: { ...base, oldestSeenDate: '2026-09-26', pages: 3 },
    from: '2026-09-27',
    expected: 'whole',
  },
  {
    name: 'the stream ran out, whatever the walk reached',
    walk: { ...base, oldestSeenDate: '2026-10-20', exhausted: true, pages: 1 },
    from: '2026-09-27',
    expected: 'whole',
  },
  {
    name: 'an empty salon: one page, no rows, no next cursor',
    walk: { ...base, oldestSeenDate: null, exhausted: true, pages: 1 },
    from: '2026-09-27',
    expected: 'whole',
  },
  {
    /*
     * THE `<` CASE. The walk has reached the window's first day and NOT passed
     * it. Two bookings can share an instant — two artists, one 10:00 slot — and
     * a page boundary can fall between them, so a walk that stops AT the first
     * day may hold one of them and not the other. `<=` calls this whole.
     */
    name: 'the walk has reached the first day but not passed it',
    walk: { ...base, oldestSeenDate: '2026-09-27', pages: 4 },
    from: '2026-09-27',
    expected: 'walking',
  },
  {
    name: 'the walk is still above the window entirely',
    walk: { ...base, oldestSeenDate: '2026-10-11', pages: 2 },
    from: '2026-09-27',
    expected: 'walking',
  },
  {
    /*
     * NOTHING HAS COME BACK YET. `oldestSeenDate: null` is the absence of
     * evidence, and reading it as "we have everything" is how a pending screen
     * paints "Nothing booked this week" over a week nobody has looked at.
     */
    name: 'no rows in hand at all and the stream is not exhausted',
    walk: { ...base, oldestSeenDate: null, pages: 0 },
    from: '2026-09-27',
    expected: 'walking',
  },
  {
    name: 'a page is in flight at the budget — still walking, not stopped',
    walk: { ...base, oldestSeenDate: '2026-10-11', fetching: true, pages: WALK_BUDGET },
    from: '2026-09-27',
    expected: 'walking',
  },
  {
    /*
     * THE BUDGET IS SPENT AND THE WINDOW IS NOT COVERED. The screen must draw
     * nothing and say so — this is the case the whole view is shaped around.
     */
    name: 'the budget is spent, nothing is in flight, and the window is not covered',
    walk: { ...base, oldestSeenDate: '2026-10-11', pages: WALK_BUDGET },
    from: '2026-09-27',
    expected: 'short',
  },
  {
    name: 'coverage beats the budget: spent, but the walk got there',
    walk: { ...base, oldestSeenDate: '2026-09-26', pages: WALK_BUDGET },
    from: '2026-09-27',
    expected: 'whole',
  },
];

describe('the completeness rule', () => {
  it.each(CASES)('$name → $expected', ({ walk, from, expected }) => {
    expect(windowCoverage(walk, from).kind).toBe(expected);
  });

  it('reads the minimum salon-local date across every page in hand', () => {
    const rows = [
      at({ id: 'a', startsAt: '2026-10-11T07:00:00.000Z' }),
      at({ id: 'b', startsAt: '2026-09-26T07:00:00.000Z' }),
      at({ id: 'c', startsAt: '2026-09-30T07:00:00.000Z' }),
    ];
    expect(oldestLocalDate(rows, KUWAIT)).toBe('2026-09-26');
    expect(oldestLocalDate([], KUWAIT)).toBeNull();
  });

  /**
   * A ROW THAT WILL NOT PARSE MUST NOT DEEPEN THE CLAIM. Skipping it errs
   * towards walking further; counting it as some default date would let one bad
   * payload row certify a window nobody walked to.
   */
  it('excludes an unreadable row from the minimum rather than guessing one', () => {
    const rows = [at({ id: 'a', startsAt: '2026-10-11T07:00:00.000Z' }), at({ id: 'b', startsAt: '' })];
    expect(oldestLocalDate(rows, KUWAIT)).toBe('2026-10-11');
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE MUTATION CHECK
 * ═══════════════════════════════════════════════════════════════════════════
 * Eight ways this rule could plausibly be written — every one of them a change
 * an unwary edit could make, and every one of them silent in production. The
 * assertion is not that the mutant is wrong; it is that THE CASES ABOVE ALREADY
 * SAY SO. A mutant that survives means the case set has a hole, and the hole is
 * the thing to fix.
 */
const MUTANTS: Array<{ name: string; fn: (walk: WalkState, from: string) => Coverage }> = [
  {
    name: 'at-or-before instead of strictly before the first day',
    fn: (w, from) => {
      if (w.exhausted) return { kind: 'whole' };
      if (w.oldestSeenDate !== null && w.oldestSeenDate <= from) return { kind: 'whole' };
      if (w.fetching || w.pages < w.budget) return { kind: 'walking' };
      return { kind: 'short' };
    },
  },
  {
    name: 'the comparison inverted',
    fn: (w, from) => {
      if (w.exhausted) return { kind: 'whole' };
      if (w.oldestSeenDate !== null && w.oldestSeenDate > from) return { kind: 'whole' };
      if (w.fetching || w.pages < w.budget) return { kind: 'walking' };
      return { kind: 'short' };
    },
  },
  {
    name: 'the exhausted arm dropped',
    fn: (w, from) => {
      if (w.oldestSeenDate !== null && w.oldestSeenDate < from) return { kind: 'whole' };
      if (w.fetching || w.pages < w.budget) return { kind: 'walking' };
      return { kind: 'short' };
    },
  },
  {
    name: 'the date arm dropped — only an exhausted stream counts',
    fn: (w) => {
      if (w.exhausted) return { kind: 'whole' };
      if (w.fetching || w.pages < w.budget) return { kind: 'walking' };
      return { kind: 'short' };
    },
  },
  {
    name: 'no rows in hand treated as a covered window',
    fn: (w, from) => {
      if (w.exhausted) return { kind: 'whole' };
      if (w.oldestSeenDate === null || w.oldestSeenDate < from) return { kind: 'whole' };
      if (w.fetching || w.pages < w.budget) return { kind: 'walking' };
      return { kind: 'short' };
    },
  },
  {
    name: 'a page in flight reported as whole',
    fn: (w, from) => {
      if (w.exhausted || w.fetching) return { kind: 'whole' };
      if (w.oldestSeenDate !== null && w.oldestSeenDate < from) return { kind: 'whole' };
      if (w.pages < w.budget) return { kind: 'walking' };
      return { kind: 'short' };
    },
  },
  {
    name: 'the budget falls through to whole instead of short',
    fn: (w, from) => {
      if (w.exhausted) return { kind: 'whole' };
      if (w.oldestSeenDate !== null && w.oldestSeenDate < from) return { kind: 'whole' };
      if (w.fetching || w.pages < w.budget) return { kind: 'walking' };
      return { kind: 'whole' };
    },
  },
  {
    name: 'no budget at all — it walks for ever and never says so',
    fn: (w, from) => {
      if (w.exhausted) return { kind: 'whole' };
      if (w.oldestSeenDate !== null && w.oldestSeenDate < from) return { kind: 'whole' };
      return { kind: 'walking' };
    },
  },
];

describe('the completeness rule survives no mutation', () => {
  it.each(MUTANTS)('the cases above already refuse: $name', ({ fn }) => {
    const killed = CASES.filter((c) => fn(c.walk, c.from).kind !== c.expected);
    expect(
      killed.map((c) => c.name),
      'this mutant passes every case above, so the case set has a hole — add the case, not a looser assertion',
    ).not.toHaveLength(0);
  });

  /** The control: the real implementation passes all of them, or the above is vacuous. */
  it('and the real rule is killed by none of them', () => {
    const killed = CASES.filter((c) => windowCoverage(c.walk, c.from).kind !== c.expected);
    expect(killed.map((c) => c.name)).toEqual([]);
  });
});

/* ========================================================================== */
/* 4 · THE GRID — WHAT A MERCHANT READS OFF A CHIP                           */
/* ========================================================================== */

function grid(rows: MerchantBooking[], days: string[] = WEEK, today: string | null = null) {
  const { columns } = weekColumns(rows, KUWAIT, days);
  return render(
    <WeekGrid
      columns={columns}
      hours={{ morning: ['10:00', '13:00'], evening: ['16:00', '21:00'] }}
      today={today}
      count={columns.reduce((n, c) => n + c.items.length, 0)}
      from={days[0]!}
      to={days[days.length - 1]!}
    />,
  );
}

describe('every status renders distinguishably, and never by colour alone', () => {
  const STATUSES = ['deposit_held', 'completed', 'no_show_returned', 'cancelled'] as const;

  it('draws one chip per booking, in the day the salon calls it', () => {
    const { container } = grid([BOOKING]);
    const chips = container.querySelectorAll('.apweek__chip');
    expect(chips).toHaveLength(1);
    const column = chips[0]!.closest('section');
    expect(column?.getAttribute('aria-label')).toBe('Tuesday 29, 1 appointment');
  });

  it.each(STATUSES)('%s carries a label a screen reader hears', (status) => {
    grid([at({ status })]);
    const chip = screen.getByRole('listitem');
    expect(chip.getAttribute('aria-label')).toContain(STATUS_PILL[status].label);
  });

  /**
   * THE FOUR ARE FOUR. A rendering that collapsed `cancelled` into
   * `no_show_returned` — or drew both as a plain booking — would pass any spec
   * that only asked "is there a chip".
   */
  it('gives the four statuses four different accessible names', () => {
    const names = STATUSES.map((status) => {
      const { unmount } = grid([at({ status })]);
      const name = screen.getByRole('listitem').getAttribute('aria-label');
      unmount();
      return name;
    });
    expect(new Set(names).size).toBe(4);
  });

  /**
   * A RELEASED SLOT MUST NOT READ AS BOOKED. `booking_artist_slot_no_overlap`
   * excludes `no_show_returned` AND `cancelled`, so the artist is bookable at
   * that hour — a chip drawn like a live booking hides free time, which is the
   * mirror image of the missing-chip defect this screen exists to refuse.
   */
  it.each(['no_show_returned', 'cancelled'] as const)(
    '%s is drawn as released, not as a live booking',
    (status) => {
      const { container } = grid([at({ status })]);
      expect(container.querySelector('.apweek__chip--released')).not.toBeNull();
      expect(container.querySelector('.apweek__chip--held')).toBeNull();
      // …and the word is on the chip, so the difference survives without colour.
      expect(container.textContent).toContain(STATUS_PILL[status].label);
    },
  );

  it('a no-show does not read as attended', () => {
    const { container } = grid([at({ status: 'no_show_returned' })]);
    expect(container.textContent).toContain('No-show · returned');
    expect(container.textContent).not.toContain('Completed');
  });

  it('a completed booking is its own shape and says so', () => {
    const { container } = grid([at({ status: 'completed' })]);
    expect(container.querySelector('.apweek__chip--completed')).not.toBeNull();
    expect(container.textContent).toContain('Completed');
  });

  /**
   * THE LIVE BOOKING IS THE ONE CHIP THAT SPENDS NO LINE ON ITS STATUS — a short
   * chip has one line to give and "Deposit held" is the least surprising fact on
   * the grid. It is still in the accessible name, which is where the guarantee
   * lives.
   */
  it('spends no visible line on the status of a live booking, but still announces it', () => {
    const { container } = grid([BOOKING]);
    expect(container.querySelector('.apweek__chip-status')).toBeNull();
    expect(screen.getByRole('listitem').getAttribute('aria-label')).toContain('Deposit held');
  });

  it.each(['deposit_held', 'completed', 'no_show_returned', 'cancelled'] as const)(
    'classifies %s into exactly one shape',
    (status) => {
      expect(['held', 'completed', 'released']).toContain(chipShape(status));
    },
  );
});

describe('a guessed branch is visible as a guess', () => {
  it('draws the marker and puts the phrase in the accessible name', () => {
    const { container } = grid([at({ branchAssumed: true })]);
    expect(container.textContent).toContain('Branch assumed');
    expect(screen.getByRole('listitem').getAttribute('aria-label')).toContain('branch assumed');
  });

  it('says nothing when the branch is known', () => {
    const { container } = grid([at({ branchAssumed: false })]);
    expect(container.textContent).not.toContain('Branch assumed');
    expect(screen.getByRole('listitem').getAttribute('aria-label')).not.toContain('branch assumed');
  });

  it('carries a failed calendar sync, the way the list does', () => {
    const { container } = grid([at({ calendarSyncState: 'failed' })]);
    expect(container.textContent).toContain('Not on their calendar');
  });
});

describe('the chip says when, who and what', () => {
  it('prints the salon’s clock time, not the browser’s', () => {
    const { container } = grid([BOOKING]);
    expect(container.querySelector('.apweek__chip-time')?.textContent).toBe('10:00');
    expect(container.textContent).toContain('Noura Al-Ajmi');
    expect(container.textContent).toContain('Balayage');
    expect(container.textContent).toContain('Dana');
  });

  /**
   * THE CHIP ABBREVIATES AND THE LABEL DOES NOT. The suffix comes off the chip
   * because three lanes leave about thirty pixels for it, and the ruler already
   * says AM or PM; nobody who cannot see where the chip SITS should lose it.
   */
  it('drops the AM/PM on the chip and keeps it in the accessible name', () => {
    grid([BOOKING]);
    const name = screen.getByRole('listitem').getAttribute('aria-label') ?? '';
    expect(name).toContain('10:00 AM to 11:30 AM');
  });

  it.each([
    [0, '12:00'],
    [615, '10:15'],
    [720, '12:00'],
    [1230, '8:30'],
  ])('compacts minute %i to %s for the chip', (minute, label) => {
    expect(compactClockLabel(minute as number)).toBe(label);
  });

  it('names the whole appointment for a reader who cannot see the box', () => {
    const placed = { ...placeBooking(BOOKING, KUWAIT)!, lane: 0, lanes: 1 };
    expect(chipLabel(placed)).toBe(
      'Tuesday 29, 10:00 AM to 11:30 AM, Noura Al-Ajmi, Balayage, with Dana, Deposit held',
    );
  });

  it.each([
    [0, '12:00 AM'],
    [615, '10:15 AM'],
    [720, '12:00 PM'],
    [1230, '8:30 PM'],
  ])('formats minute %i as %s', (minute, label) => {
    expect(clockLabel(minute as number)).toBe(label);
  });

  it.each([
    [0, '12 AM'],
    [600, '10 AM'],
    [720, '12 PM'],
    [1260, '9 PM'],
  ])('rules hour %i as %s', (minute, label) => {
    expect(hourLabel(minute as number)).toBe(label);
  });
});

/* ========================================================================== */
/* 5 · THE LAYOUT                                                            */
/* ========================================================================== */

describe('overlapping appointments sit side by side, not on top of each other', () => {
  const two = [
    at({ id: 'BK-a', startsAt: '2026-09-29T07:00:00.000Z', endsAt: '2026-09-29T08:00:00.000Z' }),
    at({ id: 'BK-b', startsAt: '2026-09-29T07:30:00.000Z', endsAt: '2026-09-29T08:30:00.000Z' }),
  ];

  it('gives an overlapping pair two lanes at half width each', () => {
    const { columns } = weekColumns(two, KUWAIT, WEEK);
    const tuesday = columns.find((c) => c.date === '2026-09-29')!;
    expect(tuesday.items.map((i) => i.lane)).toEqual([0, 1]);
    expect(tuesday.items.every((i) => i.lanes === 2)).toBe(true);
  });

  it('reuses a lane once the earlier appointment has finished', () => {
    const laned = assignLanes([
      { booking: at({ id: 'a' }), date: '2026-09-29', startMin: 600, endMin: 660, continues: false },
      { booking: at({ id: 'b' }), date: '2026-09-29', startMin: 660, endMin: 720, continues: false },
    ]);
    expect(laned.map((i) => i.lane)).toEqual([0, 0]);
    expect(laned.every((i) => i.lanes === 1)).toBe(true);
  });

  /**
   * EVERY CHIP IN A DAY IS THE SAME WIDTH. Widths that change partway down a
   * column read as hours of differing importance, which is a claim the data does
   * not make.
   */
  it('sizes the whole day by the day’s busiest moment', () => {
    const three = [
      ...two,
      at({ id: 'BK-c', startsAt: '2026-09-29T07:15:00.000Z', endsAt: '2026-09-29T09:00:00.000Z' }),
      at({ id: 'BK-d', startsAt: '2026-09-29T14:00:00.000Z', endsAt: '2026-09-29T15:00:00.000Z' }),
    ];
    const { columns } = weekColumns(three, KUWAIT, WEEK);
    const tuesday = columns.find((c) => c.date === '2026-09-29')!;
    expect(new Set(tuesday.items.map((i) => i.lanes))).toEqual(new Set([3]));
  });

  /**
   * A STABLE ORDER FOR IDENTICAL APPOINTMENTS. Two artists at 10:00 for the same
   * service differ only by id; without that tiebreak their left-to-right order
   * would depend on the order the cursor pages happened to arrive in, so the
   * same week drawn twice would shuffle.
   */
  it('orders identical slots by id so the same week draws the same way twice', () => {
    const same = (id: string) => ({
      booking: at({ id }),
      date: '2026-09-29',
      startMin: 600,
      endMin: 660,
      continues: false,
    });
    expect(assignLanes([same('BK-z'), same('BK-a')]).map((i) => i.booking.id)).toEqual([
      'BK-a',
      'BK-z',
    ]);
    expect(assignLanes([same('BK-a'), same('BK-z')]).map((i) => i.booking.id)).toEqual([
      'BK-a',
      'BK-z',
    ]);
  });

  it('positions a chip as a fraction of the ruler it is drawn against', () => {
    const box = chipBox(
      { startMin: 600, endMin: 660, lane: 1, lanes: 2 },
      { startMin: 540, endMin: 1140 },
    );
    expect(box.top).toBeCloseTo(10, 6);
    expect(box.height).toBeCloseTo(10, 6);
    expect(box.left).toBe(50);
    expect(box.width).toBe(50);
  });
});

describe('the ruler never hides a booking outside opening hours', () => {
  const hours: Salon['businessHours'] = { morning: ['10:00', '13:00'], evening: ['16:00', '21:00'] };

  it('spans the salon’s day when every booking is inside it', () => {
    const { columns } = weekColumns([BOOKING], KUWAIT, WEEK);
    expect(rulerRange(columns, hours)).toEqual({ startMin: 600, endMin: 1260 });
  });

  /**
   * THE WIDENING IS THE RULE. A ruler that is only the business hours drops the
   * 8am fitting off the top of the grid — the cap's defect arriving through the
   * y-axis instead of through the cursor.
   */
  it('widens to whole hours around an early booking', () => {
    const early = at({ startsAt: '2026-09-29T04:45:00.000Z', endsAt: '2026-09-29T05:30:00.000Z' });
    const { columns } = weekColumns([early], KUWAIT, WEEK);
    expect(rulerRange(columns, hours).startMin).toBe(7 * 60);
  });

  it('widens around an appointment that runs past closing', () => {
    const late = at({ startsAt: '2026-09-29T18:30:00.000Z', endsAt: '2026-09-29T20:15:00.000Z' });
    const { columns } = weekColumns([late], KUWAIT, WEEK);
    expect(rulerRange(columns, hours).endMin).toBe(24 * 60);
  });

  it('falls back to a sane day when the hours are unusable, and still shows everything', () => {
    const { columns } = weekColumns([BOOKING], KUWAIT, WEEK);
    const range = rulerRange(columns, { morning: ['nope', '13:00'], evening: ['16:00', 'nope'] });
    expect(range.startMin).toBeLessThanOrEqual(600);
    expect(range.endMin).toBeGreaterThanOrEqual(690);
  });

  it('refuses a closing time that precedes opening rather than inverting the grid', () => {
    const range = rulerRange([], { morning: ['18:00', '19:00'], evening: ['09:00', '10:00'] });
    expect(range.endMin).toBeGreaterThan(range.startMin);
  });

  it.each([
    ['10:00', 600],
    ['00:00', 0],
    ['23:59', 1439],
    ['24:00', null],
    ['9:00', null],
    ['', null],
  ])('reads %s as %s', (text, minutes) => {
    expect(clockMinutes(text as string)).toBe(minutes);
  });

  it('marks one hour per row, top inclusive and foot exclusive', () => {
    expect(rulerHours({ startMin: 600, endMin: 780 })).toEqual([600, 660, 720]);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A CHIP DROPS WHOLE LINES, NEVER PART OF ONE
 * ═══════════════════════════════════════════════════════════════════════════
 * FOUND BY LOOKING AT IT. Under a flat `overflow: hidden` a thirty-minute chip
 * sliced its last line THROUGH THE GLYPHS — half a "CANCELLED" under half a
 * customer's name — and the line it cut was the status, which is the one fact a
 * released slot must not lose. jsdom lays nothing out, so no render assertion
 * could have caught it; what a test CAN hold is the bucketing and the constant
 * the bucketing depends on.
 */
describe('a short chip says less rather than showing half a line', () => {
  it.each([
    [15, 'tiny'],
    [30, 'tiny'],
    [45, 'tiny'],
    [60, 'roomy'],
    [75, 'roomy'],
    [90, 'full'],
    [180, 'full'],
  ])('a %i-minute appointment is %s', (minutes, density) => {
    expect(chipDensity(600, 600 + (minutes as number))).toBe(density);
  });

  it('never drops the status, however short the appointment', () => {
    const { container } = grid([
      at({ status: 'cancelled', startsAt: '2026-09-29T07:00:00.000Z', endsAt: '2026-09-29T07:15:00.000Z' }),
    ]);
    const chip = container.querySelector('.apweek__chip')!;
    expect(chip.className).toContain('apweek__chip--tiny');
    // The status shares the first line with the time, which no bucket hides.
    expect(chip.querySelector('.apweek__chip-line')?.textContent).toContain('Cancelled');
  });

  /**
   * THE STYLESHEET AND THIS MODULE HOLD TWO HALVES OF ONE NUMBER.
   *
   * A chip's drawn height is `minutes / 60 × --apweek-row-h`, and a `.ts` file
   * cannot read a custom property. So `APWEEK_ROW_PX` is a copy, and a copy
   * needs a guard: a row height lowered in `app.css` alone puts the mid-glyph
   * clipping straight back, with the buckets still confidently reporting `full`.
   * Reads the stylesheet rather than trusting a comment to be obeyed.
   */
  it('agrees with the row height app.css actually sets', () => {
    const declared = /--apweek-row-h:\s*(\d+)px/.exec(APP_CSS.replace(/\/\*[\s\S]*?\*\//g, ''));
    expect(declared, 'app.css no longer declares --apweek-row-h').not.toBeNull();
    expect(Number(declared![1])).toBe(APWEEK_ROW_PX);
  });
});

describe('the grid draws seven columns whatever is in them', () => {
  it('keeps an empty day as a column, not as a gap', () => {
    const { container } = grid([BOOKING]);
    expect(container.querySelectorAll('.apweek__col')).toHaveLength(7);
    const empty = [...container.querySelectorAll('.apweek__col')].find(
      (c) => c.getAttribute('aria-label')?.includes('nothing booked') ?? false,
    );
    expect(empty).toBeTruthy();
  });

  it('marks today, and only today', () => {
    const { container } = grid([BOOKING], WEEK, '2026-09-30');
    const marked = container.querySelectorAll('.apweek__col--today');
    expect(marked).toHaveLength(1);
    expect(marked[0]!.getAttribute('aria-label')).toContain('Wednesday 30');
  });

  it('drops a row outside the window rather than forcing it into a column', () => {
    const { columns } = weekColumns([at({ startsAt: '2026-11-11T07:00:00.000Z' })], KUWAIT, WEEK);
    expect(columns.reduce((n, c) => n + c.items.length, 0)).toBe(0);
  });

  it('counts a row it cannot place rather than losing it silently', () => {
    const { unplaceable } = weekColumns([BOOKING, at({ id: 'x', startsAt: '' })], KUWAIT, WEEK);
    expect(unplaceable).toBe(1);
  });

  it('announces the count and the window for a reader who cannot see the grid', () => {
    const { container } = grid([BOOKING]);
    expect(container.querySelector('.avo-sr-only')?.textContent).toBe(
      '1 appointment from 27 Sep 2026 to 3 Oct 2026, salon time.',
    );
  });
});

/* ========================================================================== */
/* 6 · THE STATES                                                            */
/* ========================================================================== */

describe('the week’s own states', () => {
  it('shapes the pending grid like the grid that replaces it', () => {
    const { container } = render(<WeekSkeleton />);
    expect(container.querySelectorAll('.apweek__col')).toHaveLength(7);
    expect(container.querySelectorAll('.avo-skeleton').length).toBeGreaterThan(0);
    // It claims nothing about how busy the week is: every column the same.
    const perColumn = [...container.querySelectorAll('.apweek__slots')].map(
      (s) => s.querySelectorAll('li').length,
    );
    expect(new Set(perColumn).size).toBe(1);
  });

  it('says what the walk is doing and how far it has got, with no invented total', () => {
    const { container } = render(<WeekWalking seen={1400} pages={7} />);
    expect(container.textContent).toContain('1,400 appointments so far');
    expect(container.textContent).toContain('7 pages');
    expect(container.textContent).not.toMatch(/%/);
    expect(container.querySelector('[role="status"]')).not.toBeNull();
  });

  /**
   * THE REFUSAL. It draws no grid, it says how far it got, and it offers both
   * ways out — the one that keeps walking and the one that has no preconditions.
   */
  it('refuses the week it cannot vouch for, and names both ways out', () => {
    const keep = vi.fn();
    const list = vi.fn();
    const { container } = render(
      <WeekTooDeep
        seen={2400}
        oldestSeenDate="2026-10-12"
        from="2026-09-27"
        onKeepLoading={keep}
        onShowList={list}
      />,
    );
    expect(container.querySelector('.apweek__grid')).toBeNull();
    expect(container.textContent).toContain('2,400');
    expect(container.textContent).toContain('12 Oct 2026');
    expect(container.textContent).toContain('27 Sep 2026');
    fireEvent.click(screen.getByRole('button', { name: 'Keep loading' }));
    fireEvent.click(screen.getByRole('button', { name: 'Switch to List' }));
    expect(keep).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('survives having read nothing at all when it stops', () => {
    const { container } = render(
      <WeekTooDeep
        seen={0}
        oldestSeenDate={null}
        from="2026-09-27"
        onKeepLoading={vi.fn()}
        onShowList={vi.fn()}
      />,
    );
    expect(container.textContent).toContain('none of them');
  });

  it('quotes the time zone it cannot use, and sends her to the list', () => {
    const list = vi.fn();
    const { container } = render(<UnusableZone zone="Mars/Olympus_Mons" onShowList={list} />);
    expect(container.textContent).toContain('Mars/Olympus_Mons');
    expect(container.textContent).toContain('Settings');
    fireEvent.click(screen.getByRole('button', { name: 'Switch to List' }));
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('names the seven days it found nothing in', () => {
    const { container } = render(<WeekEmpty from="2026-09-27" to="2026-10-03" />);
    expect(container.textContent).toContain('27 Sep 2026');
    expect(container.textContent).toContain('3 Oct 2026');
  });

  it('says out loud when a row could not be positioned', () => {
    const list = vi.fn();
    const one = render(<UnplaceableNotice count={1} onShowList={list} />);
    expect(one.container.textContent).toContain('1 appointment has a time we could not read');
    one.unmount();
    const many = render(<UnplaceableNotice count={3} onShowList={list} />);
    expect(many.container.textContent).toContain('3 appointments have times');
  });

  /**
   * THE WEEK NAV OUTLIVES WHATEVER IS UNDER IT. A merchant four weeks back who
   * hits a state has to be able to walk forward again; a head that disappears
   * with its content strands her on the one week that cannot draw.
   */
  it('keeps the nav over a state that cannot name any dates', () => {
    const onOffset = vi.fn();
    const { container } = render(
      <WeekShell window={null} offset={-4} onOffset={onOffset}>
        <UnusableZone zone="Mars/Olympus_Mons" onShowList={vi.fn()} />
      </WeekShell>,
    );
    expect(container.textContent).toContain('4 weeks back');
    expect(container.textContent).toContain('Dates unavailable');
    fireEvent.click(screen.getByRole('button', { name: 'Next week' }));
    expect(onOffset).toHaveBeenCalledWith(-3);
    fireEvent.click(screen.getByRole('button', { name: 'Previous week' }));
    expect(onOffset).toHaveBeenCalledWith(-5);
  });

  it('disables Today on the week it is already showing', () => {
    render(
      <WeekShell window={{ from: '2026-09-27', to: '2026-10-03' }} offset={0} onOffset={vi.fn()}>
        <p>content</p>
      </WeekShell>,
    );
    expect((screen.getByRole('button', { name: 'Today' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('This week')).toBeTruthy();
    expect(screen.getByText('27 Sep 2026 – 3 Oct 2026')).toBeTruthy();
  });
});

/* ========================================================================== */
/* 7 · THE CACHE SHAPE THE WALK INTRODUCED                                   */
/* ========================================================================== */

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * `setQueriesData` MATCHES BY PREFIX, AND THE WALK PUT A SECOND SHAPE UNDER IT
 * ═══════════════════════════════════════════════════════════════════════════
 * `useMarkNoShow` patches every cache entry under `['bookings']`. Until this
 * slice there was one shape there — `{ items, nextCursor }` — and the updater
 * read `old.items.map(…)` unguarded. `useSalonBookingStream` caches
 * `{ pages, pageParams }`, which has no `items` at all: the old updater would
 * have thrown inside `onSuccess`, AFTER the server had already returned the
 * deposit. `Chip`s do not mark no-shows, but the two views share the cache, so
 * marking in the LIST with the week loaded is the reachable path.
 */
describe('a status patch survives both shapes under the bookings key', () => {
  const held = at({ id: 'BK-001', status: 'deposit_held' });
  const other = at({ id: 'BK-002', status: 'deposit_held' });

  it('patches the list’s page', () => {
    const next = patchBookingStatus(
      { items: [held, other], nextCursor: null },
      'BK-001',
      'no_show_returned',
    ) as { items: MerchantBooking[] };
    expect(next.items.map((r) => r.status)).toEqual(['no_show_returned', 'deposit_held']);
    // The joined fields are untouched — the response carries none of them.
    expect(next.items[0]!.memberName).toBe('Noura Al-Ajmi');
  });

  it('patches every page of the walk', () => {
    const next = patchBookingStatus(
      {
        pages: [
          { items: [other], nextCursor: 'c1' },
          { items: [held], nextCursor: null },
        ],
        pageParams: [null, 'c1'],
      },
      'BK-001',
      'no_show_returned',
    ) as { pages: Array<{ items: MerchantBooking[] }> };
    expect(next.pages[0]!.items[0]!.status).toBe('deposit_held');
    expect(next.pages[1]!.items[0]!.status).toBe('no_show_returned');
  });

  it('leaves a shape it does not recognise alone rather than overwriting it', () => {
    const odd = { something: 'else' };
    expect(patchBookingStatus(odd, 'BK-001', 'cancelled')).toBe(odd);
    expect(patchBookingStatus(undefined, 'BK-001', 'cancelled')).toBeUndefined();
    expect(patchBookingStatus(null, 'BK-001', 'cancelled')).toBeNull();
  });
});
