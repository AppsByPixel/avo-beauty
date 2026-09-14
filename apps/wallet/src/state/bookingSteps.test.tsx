// @vitest-environment jsdom

/**
 * THE BRANCH STEP, DRIVEN — five steps when the question is worth asking, four
 * when it is not, and a counter that never promises a step she cannot reach.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY THE HOOK AND NOT THE PREDICATE
 * ═════════════════════════════════════════════════════════════════════════════
 * `domain/branchPicker.test.ts` already proves `branchStepApplies` — when a
 * branch question is answerable at all. It cannot reach the thing that actually
 * breaks in front of a customer: whether the MACHINE skips the step it says it
 * skips, and whether `stepIndex`/`totalSteps` agree with the path she can walk.
 *
 * A counter is the easiest thing in this change to get wrong and the hardest to
 * notice, because it is right on the salon the developer seeded. Amara has two
 * branches; most salons have one. So the one-branch case is driven first and
 * asserted step by step, not inferred from the two-branch one.
 *
 * EVERY TEST IN THIS FILE FAILS BEFORE THIS SLICE: `StepName` had no `'branch'`
 * member, `TOTAL_STEPS` was the literal 4, and `BookingController` had no
 * `totalSteps` — so the two-branch expectations are unsatisfiable and the
 * one-branch ones assert a 4 that was a constant rather than a decision.
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BookableArtist, Salon } from '@avo/types';

const { getServices, getArtists, getAvailability, createBooking, rescheduleBooking, getBookings } =
  vi.hoisted(() => ({
    getServices: vi.fn(),
    getArtists: vi.fn(),
    getAvailability: vi.fn(),
    createBooking: vi.fn(),
    rescheduleBooking: vi.fn(),
    getBookings: vi.fn(),
  }));

vi.mock('../api/booking', () => ({
  getServices,
  getArtists,
  getAvailability,
  createBooking,
  rescheduleBooking,
  getBookings,
  cancelBooking: vi.fn(),
}));

// eslint-disable-next-line import/first
import { TOTAL_STEPS, useBooking, type RescheduleTarget } from './useBooking';

// --------------------------------------------------------------- fixtures --

const KWC = { id: 'BR-KWC', name: 'Kuwait City', nameAr: 'مدينة الكويت' };
const SAL = { id: 'BR-SAL', name: 'Salmiya', nameAr: 'السالمية' };

/**
 * Only the fields this machine reads. `as unknown as Salon` rather than a full
 * entity because a complete `Salon` fixture here would be forty fields of noise
 * around the two that decide anything: `branches` and `timezone`.
 */
const salonWith = (branches: Array<typeof KWC>): Salon =>
  ({
    id: 'SAL-AMARA',
    timezone: 'Asia/Kuwait',
    depositFils: 5000,
    branches,
    modules: { booking: true },
  }) as unknown as Salon;

const SERVICES = [{ id: 'SV-1', name: 'Cut & style', nameAr: null, priceFils: 12000 }];

const artist = (id: string): BookableArtist =>
  ({ id, name: id, nameAr: null }) as unknown as BookableArtist;

/** Four bookable artists, of whom two carry a branch. */
const ROSTER = [artist('AR-1'), artist('AR-2'), artist('AR-3'), artist('AR-4')];
const UNASSIGNED_TWO = [artist('AR-3'), artist('AR-4')];

/**
 * `?branch=` decides which list comes back, so the split read and the roster
 * read cannot be confused for one another — the exact confusion the hook's own
 * header warns about.
 */
function serveRoster(unassigned: BookableArtist[]) {
  getArtists.mockImplementation((_salonId: string, branch?: string) => {
    if (branch === 'unassigned') return Promise.resolve(unassigned);
    return Promise.resolve(ROSTER);
  });
}

const mount = (salon: Salon, reschedule?: RescheduleTarget) =>
  renderHook(() => useBooking({ salon, reschedule, onBooked: vi.fn(), now: new Date('2026-09-14T08:00:00+03:00') }));

beforeEach(() => {
  vi.clearAllMocks();
  getServices.mockResolvedValue(SERVICES);
  getAvailability.mockResolvedValue({ date: '2026-09-14', open: true, hoursSource: 'artist', slots: [] });
  serveRoster(UNASSIGNED_TWO);
});

// ══════════════════════════════════════════════════════ the flow's length ══

describe('TOTAL_STEPS', () => {
  it('is five — service, branch, artist, time, confirmation', () => {
    expect(TOTAL_STEPS).toBe(5);
  });
});

// ══════════════════════════════════════════════ a salon with two branches ══

describe('two open branches, some artists assigned — the branch step is real', () => {
  it('reports five steps and puts the branch between service and artist', async () => {
    const { result } = mount(salonWith([KWC, SAL]));
    await waitFor(() => expect(result.current.branchOptions.length).toBeGreaterThan(0));

    expect(result.current.totalSteps).toBe(5);
    expect(result.current.step).toBe('service');
    expect(result.current.stepIndex).toBe(1);

    act(() => result.current.next());
    expect(result.current.step).toBe('branch');
    expect(result.current.stepIndex).toBe(2);

    act(() => result.current.next());
    expect(result.current.step).toBe('artist');
    expect(result.current.stepIndex).toBe(3);

    act(() => result.current.next());
    expect(result.current.step).toBe('day');
    expect(result.current.stepIndex).toBe(4);

    act(() => result.current.next());
    expect(result.current.step).toBe('review');
    expect(result.current.stepIndex).toBe(5);
  });

  it('walks back through the branch step rather than past it', async () => {
    const { result } = mount(salonWith([KWC, SAL]));
    await waitFor(() => expect(result.current.branchOptions.length).toBeGreaterThan(0));

    act(() => result.current.next());
    act(() => result.current.next());
    expect(result.current.step).toBe('artist');

    act(() => result.current.back());
    expect(result.current.step).toBe('branch');

    act(() => result.current.back());
    expect(result.current.step).toBe('service');
  });

  /**
   * THE COUNTER IS NEVER AHEAD OF THE PATH. Before the roster split lands, the
   * hook cannot know whether the branch question is answerable, and a "Step 2
   * of 5" painted in that window would name a step that may never exist. So the
   * flow reports four until the split PROVES otherwise, and only ever rises.
   */
  it('reports four until the split proves the step is answerable, never the reverse', async () => {
    let release: (rows: BookableArtist[]) => void = () => {};
    getArtists.mockImplementation((_salonId: string, branch?: string) => {
      if (branch === 'unassigned') return new Promise<BookableArtist[]>((r) => (release = r));
      return Promise.resolve(ROSTER);
    });

    const { result } = mount(salonWith([KWC, SAL]));
    expect(result.current.totalSteps).toBe(4);

    await act(async () => {
      release(UNASSIGNED_TWO);
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.totalSteps).toBe(5));
  });
});

// ═════════════════════════════════════════════ a salon with one branch ═════

describe('one open branch — she is not asked, and the counter says four', () => {
  it('never offers a branch step and never counts one', async () => {
    const { result } = mount(salonWith([KWC]));
    await waitFor(() => expect(result.current.services.status).toBe('ready'));

    expect(result.current.totalSteps).toBe(4);
    expect(result.current.branchOptions).toEqual([]);

    act(() => result.current.next());
    expect(result.current.step).toBe('artist');
    expect(result.current.stepIndex).toBe(2);

    act(() => result.current.next());
    expect(result.current.step).toBe('day');
    expect(result.current.stepIndex).toBe(3);

    act(() => result.current.next());
    expect(result.current.step).toBe('review');
    expect(result.current.stepIndex).toBe(4);

    act(() => result.current.back());
    act(() => result.current.back());
    expect(result.current.step).toBe('artist');
    act(() => result.current.back());
    expect(result.current.step).toBe('service');
  });

  it('asks the API nothing about branches at all', async () => {
    const { result } = mount(salonWith([KWC]));
    await waitFor(() => expect(result.current.services.status).toBe('ready'));
    expect(getArtists.mock.calls.some(([, branch]) => branch === 'unassigned')).toBe(false);
  });
});

/**
 * The common case migration 0044 left behind: two open branches, nobody
 * assigned. Every branch chip would return an empty list, so the question has
 * no answer — and a step with no answer is worse than no step.
 */
describe('two branches, nothing assigned — the step is suppressed too', () => {
  it('stays at four steps and skips straight to the artist', async () => {
    serveRoster(ROSTER); // every artist unassigned
    const { result } = mount(salonWith([KWC, SAL]));
    await waitFor(() => expect(result.current.rosterSplit).not.toBeNull());

    expect(result.current.branchOptions).toEqual([]);
    expect(result.current.totalSteps).toBe(4);

    act(() => result.current.next());
    expect(result.current.step).toBe('artist');
    expect(result.current.stepIndex).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════ rescheduling ══

/**
 * A reschedule fixes the artist, so there is no roster to filter and no branch
 * to ask about. It enters at the grid exactly as before, and the counter it
 * shows is the one it showed before this slice.
 */
describe('rescheduling — untouched by the branch step', () => {
  const TARGET: RescheduleTarget = {
    booking: { id: 'BK-1' } as RescheduleTarget['booking'],
    artistId: 'AR-1',
    serviceId: 'SV-1',
  };

  it('enters at the grid, counts four, and never reads the split', async () => {
    const { result } = mount(salonWith([KWC, SAL]), TARGET);
    await waitFor(() => expect(result.current.services.status).toBe('ready'));

    expect(result.current.step).toBe('day');
    expect(result.current.totalSteps).toBe(4);
    expect(result.current.stepIndex).toBe(3);
    expect(result.current.branchOptions).toEqual([]);
    expect(getArtists.mock.calls.some(([, branch]) => branch === 'unassigned')).toBe(false);
  });

  it('still refuses to walk back out of the grid into steps she never saw', async () => {
    const { result } = mount(salonWith([KWC, SAL]), TARGET);
    await waitFor(() => expect(result.current.services.status).toBe('ready'));
    act(() => result.current.back());
    expect(result.current.step).toBe('day');
  });
});
