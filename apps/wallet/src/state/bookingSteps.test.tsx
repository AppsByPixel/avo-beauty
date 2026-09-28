// @vitest-environment jsdom

/**
 * THE BOOK FLOW'S SHAPE, DRIVEN — branch first where the question is worth
 * asking (W1), service first everywhere else, and a counter that is decided
 * before it is shown and never moves after.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY THE HOOK AND NOT THE PREDICATE
 * ═════════════════════════════════════════════════════════════════════════════
 * `domain/branchPicker.test.ts` already proves `branchStepApplies` — when a
 * branch question is answerable at all. It cannot reach the thing that actually
 * breaks in front of a customer: whether the MACHINE opens on the step it says
 * it opens on, and whether `stepIndex`/`totalSteps` agree with the path she can
 * walk.
 *
 * A counter is the easiest thing in this change to get wrong and the hardest to
 * notice, because it is right on the salon the developer seeded. Amara has two
 * branches; most salons have one. So the one-branch case is driven first-class
 * and asserted step by step, not inferred from the two-branch one.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT W1 CHANGED, AND WHAT EACH BLOCK BELOW PINS
 * ═════════════════════════════════════════════════════════════════════════════
 *   1. multi-branch: branch → service → artist → day → review, 1..5 of 5.
 *   2. single-branch: TODAY'S FLOW, unchanged — service on the first render,
 *      no entry gate, no branch read, 1..4 of 4.
 *   3. the entry gate: before the roster split lands the step is `'entry'`,
 *      never `service`-then-`branch`; a failure there is recoverable.
 *   4. the counter: every COMMITTED render's (index, total) is recorded; the
 *      total never changes and the first number shown is 1.
 *   5. an empty branch: the roster behind the chosen chip is known on the
 *      branch step, and Continue from it is refused. Since migration 0061 the
 *      service list IS narrowed by `Service.artistIds`; every fixture here is
 *      fully assigned (0062's backfill), so these specs pin that an existing
 *      salon's flow is unchanged. The narrowing is `serviceAssignment.test.tsx`.
 *   6. back, in both salon shapes.
 *   7. reschedule still enters at `day`.
 *
 * The RTL half (8) needs the screen, not the hook: `screens/bookEntryRender.test.tsx`.
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
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
import {
  TOTAL_STEPS,
  useBooking,
  type BookingController,
  type RescheduleTarget,
  type StepName,
} from './useBooking';
// eslint-disable-next-line import/first
import { ApiError } from '../api/client';

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

/**
 * FULLY ASSIGNED — every artist does every service, which is what migration
 * 0062's backfill made true for every existing salon. Every spec in this file
 * therefore pins that an existing salon's flow is UNCHANGED by 0061; the
 * narrowing itself is driven in `serviceAssignment.test.tsx`.
 */
const EVERYONE = ['AR-1', 'AR-2', 'AR-3', 'AR-4'];
const SERVICES = [
  { id: 'SV-1', name: 'Cut & style', nameAr: null, priceFils: 12000, artistIds: EVERYONE },
  { id: 'SV-2', name: 'Balayage', nameAr: null, priceFils: 45000, artistIds: EVERYONE },
];

const artist = (id: string): BookableArtist =>
  ({ id, name: id, nameAr: null }) as unknown as BookableArtist;

/**
 * Four bookable artists: AR-1 at Kuwait City, AR-2 at Salmiya... except that
 * Salmiya is served EMPTY below, which is the W1 hazard — a branch chip whose
 * roster has nobody in it. AR-3 and AR-4 are unassigned.
 */
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
    if (branch === KWC.id) return Promise.resolve([artist('AR-1')]);
    if (branch === SAL.id) return Promise.resolve([]);
    return Promise.resolve(ROSTER);
  });
}

/** A split read held open until the spec releases it. */
function holdSplit() {
  let release: (rows: BookableArtist[]) => void = () => {};
  let fail: (err: unknown) => void = () => {};
  getArtists.mockImplementation((_salonId: string, branch?: string) => {
    if (branch === 'unassigned') {
      return new Promise<BookableArtist[]>((res, rej) => {
        release = res;
        fail = rej;
      });
    }
    return Promise.resolve(ROSTER);
  });
  return {
    release: (rows: BookableArtist[]) => release(rows),
    fail: (err: unknown) => fail(err),
  };
}

interface Frame {
  step: StepName;
  stepIndex: number | null;
  totalSteps: number | null;
}

/**
 * Mounts the hook and records every COMMITTED render — in an effect, so a
 * render React discards (the entry gate sets state during render) is not
 * mistaken for a frame she saw.
 */
const mount = (salon: Salon, reschedule?: RescheduleTarget) => {
  const frames: Frame[] = [];
  const hook = renderHook(() => {
    const c: BookingController = useBooking({
      salon,
      reschedule,
      onBooked: vi.fn(),
      now: new Date('2026-09-14T08:00:00+03:00'),
    });
    useEffect(() => {
      frames.push({ step: c.step, stepIndex: c.stepIndex, totalSteps: c.totalSteps });
    });
    return c;
  });
  return { ...hook, frames };
};

/** The steps she was shown, in order, with consecutive repeats collapsed. */
const path = (frames: Frame[]) =>
  frames.map((f) => f.step).filter((s, i, all) => i === 0 || all[i - 1] !== s);

beforeEach(() => {
  vi.clearAllMocks();
  getServices.mockResolvedValue(SERVICES);
  getAvailability.mockResolvedValue({ date: '2026-09-14', open: true, hoursSource: 'artist', slots: [] });
  serveRoster(UNASSIGNED_TWO);
});

// ══════════════════════════════════════════════════════ the flow's length ══

describe('TOTAL_STEPS', () => {
  it('is five — branch, service, artist, time, confirmation', () => {
    expect(TOTAL_STEPS).toBe(5);
  });
});

// ═══════════════════════════════ 1 · a salon with two branches (W1 order) ══

describe('two open branches, some artists assigned — branch first', () => {
  it('opens on the branch, then service, then artist, then day, then review', async () => {
    const { result } = mount(salonWith([KWC, SAL]));
    await waitFor(() => expect(result.current.step).toBe('branch'));
    await waitFor(() => expect(result.current.branchHasArtists).toBe(true));

    expect(result.current.totalSteps).toBe(5);
    expect(result.current.stepIndex).toBe(1);
    expect(result.current.firstStep).toBe('branch');

    act(() => result.current.next());
    expect(result.current.step).toBe('service');
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

  it('never sends a branch to POST /bookings — the chip filters the roster and nothing else', async () => {
    const { result } = mount(salonWith([KWC, SAL]));
    await waitFor(() => expect(result.current.step).toBe('branch'));
    act(() => result.current.pickBranch({ kind: 'branch', branchId: KWC.id }));
    await waitFor(() => expect(result.current.branchHasArtists).toBe(true));
    expect(getArtists).toHaveBeenCalledWith('SAL-AMARA', KWC.id, expect.anything());

    createBooking.mockResolvedValue({
      booking: { id: 'BK-1', depositFils: 5000, startsAt: '2026-09-14T13:00:00Z' },
      balanceAfterFils: 0,
    });
    getAvailability.mockResolvedValue({
      date: '2026-09-14',
      open: true,
      hoursSource: 'artist',
      slots: [{ startsAt: '2026-09-14T13:00:00Z', endsAt: '2026-09-14T13:45:00Z', local: '16:00', available: true }],
    });
    act(() => result.current.next());
    await waitFor(() => expect(result.current.services.status).toBe('ready'));
    act(() => result.current.pickService(SERVICES[0] as never));
    act(() => result.current.next());
    await waitFor(() => expect(result.current.artists.status).toBe('ready'));
    act(() => result.current.pickArtist(artist('AR-1')));
    act(() => result.current.next());
    await waitFor(() => expect(result.current.availability.status).toBe('ready'));
    const grid = result.current.availability;
    if (grid.status !== 'ready') throw new Error('grid not ready');
    const slot = grid.data.slots[0]!;
    act(() => result.current.pickSlot(slot));
    act(() => result.current.next());
    act(() => result.current.confirm());
    await waitFor(() => expect(createBooking).toHaveBeenCalledTimes(1));

    const body = createBooking.mock.calls[0]![0] as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['artistId', 'serviceId', 'startsAt']);
  });
});

// ═══════════════════════════ 2 · a salon with one branch — today's flow ════

describe('one open branch — she is not asked, and nothing about the flow moved', () => {
  it('is on the service at the very first render, counting four, with no entry gate', () => {
    const { result, frames } = mount(salonWith([KWC]));
    // Synchronous, before any read resolves: a single-branch salon has nothing
    // to wait for, so it must not wait.
    expect(result.current.step).toBe('service');
    expect(result.current.stepIndex).toBe(1);
    expect(result.current.totalSteps).toBe(4);
    expect(result.current.firstStep).toBe('service');
    expect(frames[0]).toEqual({ step: 'service', stepIndex: 1, totalSteps: 4 });
  });

  it('walks service → artist → day → review, 1..4 of 4, and never counts a branch', async () => {
    const { result, frames } = mount(salonWith([KWC]));
    await waitFor(() => expect(result.current.services.status).toBe('ready'));

    expect(result.current.branchOptions).toEqual([]);
    expect(result.current.hasBranchStep).toBe(false);

    act(() => result.current.next());
    expect(result.current.step).toBe('artist');
    expect(result.current.stepIndex).toBe(2);

    act(() => result.current.next());
    expect(result.current.step).toBe('day');
    expect(result.current.stepIndex).toBe(3);

    act(() => result.current.next());
    expect(result.current.step).toBe('review');
    expect(result.current.stepIndex).toBe(4);

    expect(frames.every((f) => f.totalSteps === 4)).toBe(true);
    expect(path(frames)).toEqual(['service', 'artist', 'day', 'review']);
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
 * no answer — and a step with no answer is worse than no step. This salon DOES
 * pass through the entry gate (it cannot know nobody is assigned without
 * asking), and then opens on the service, never on the branch.
 */
describe('two branches, nothing assigned — the step is suppressed, after the gate', () => {
  it('opens on the service at four steps and never shows the branch', async () => {
    serveRoster(ROSTER); // every artist unassigned
    const { result, frames } = mount(salonWith([KWC, SAL]));
    await waitFor(() => expect(result.current.step).toBe('service'));

    expect(result.current.branchOptions).toEqual([]);
    expect(result.current.totalSteps).toBe(4);
    expect(result.current.stepIndex).toBe(1);
    expect(result.current.firstStep).toBe('service');

    act(() => result.current.next());
    expect(result.current.step).toBe('artist');
    expect(result.current.stepIndex).toBe(2);

    expect(path(frames)).toEqual(['entry', 'service', 'artist']);
  });
});

// ═════════════════════════════════════ 3 · entry before the roster lands ═══

describe('the entry gate — step 1 waits for the data that decides it', () => {
  it('shows `entry` while the split is in flight, then the branch — never service first', async () => {
    const split = holdSplit();
    const { result, frames } = mount(salonWith([KWC, SAL]));

    expect(result.current.step).toBe('entry');
    expect(result.current.firstStep).toBeNull();
    // Let the service list and the unfiltered roster land: the gate must hold
    // on the split alone, not lift because something else arrived.
    await waitFor(() => expect(result.current.services.status).toBe('ready'));
    await waitFor(() => expect(result.current.artists.status).toBe('ready'));
    expect(result.current.step).toBe('entry');

    await act(async () => {
      split.release(UNASSIGNED_TWO);
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.step).toBe('branch'));

    expect(path(frames)).toEqual(['entry', 'branch']);
    expect(frames.some((f) => f.step === 'service')).toBe(false);
  });

  it('a failed split at entry is a failure with a retry, and the retry recovers', async () => {
    const first = holdSplit();
    const { result } = mount(salonWith([KWC, SAL]));
    await act(async () => {
      first.fail(new ApiError('offline', 'You are offline.', 'REF-1', null));
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.entryFailure).not.toBeNull());
    expect(result.current.entryFailure?.kind).toBe('offline');
    expect(result.current.step).toBe('entry');
    expect(result.current.totalSteps).toBeNull();

    const second = holdSplit();
    act(() => result.current.retryLoad());
    // Back on the skeleton, not still on the failure, while the retry is out.
    await waitFor(() => expect(result.current.entryFailure).toBeNull());
    expect(result.current.step).toBe('entry');

    await act(async () => {
      second.release(UNASSIGNED_TWO);
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.step).toBe('branch'));
    expect(result.current.totalSteps).toBe(5);
  });
});

// ═══════════════════════════════════════════════════════════ 4 · counter ═══

describe('the counter — decided before it is shown, and never moves', () => {
  it('multi-branch: no number on entry, then 1 of 5, and the total is 5 on every numbered frame', async () => {
    const split = holdSplit();
    const { result, frames } = mount(salonWith([KWC, SAL]));
    expect(result.current.stepIndex).toBeNull();
    expect(result.current.totalSteps).toBeNull();

    await act(async () => {
      split.release(UNASSIGNED_TWO);
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.branchHasArtists).toBe(true));
    act(() => result.current.next());
    act(() => result.current.next());

    const numbered = frames.filter((f) => f.totalSteps !== null);
    expect(numbered[0]).toEqual({ step: 'branch', stepIndex: 1, totalSteps: 5 });
    expect(new Set(numbered.map((f) => f.totalSteps))).toEqual(new Set([5]));
    // Every un-numbered frame is the gate and nothing else.
    expect(frames.filter((f) => f.totalSteps === null).every((f) => f.step === 'entry')).toBe(true);
  });

  it('a retry after entry that finds nobody assigned any more does not take the step away', async () => {
    const { result, frames } = mount(salonWith([KWC, SAL]));
    await waitFor(() => expect(result.current.branchHasArtists).toBe(true));
    act(() => result.current.next()); // on the service, "2 of 5"

    serveRoster(ROSTER); // the merchant unassigned everyone meanwhile
    act(() => result.current.retryLoad());
    await waitFor(() => expect(result.current.rosterSplit).toEqual({ total: 4, unassigned: 4 }));

    expect(result.current.totalSteps).toBe(5);
    expect(result.current.stepIndex).toBe(2);
    expect(new Set(frames.filter((f) => f.totalSteps !== null).map((f) => f.totalSteps))).toEqual(
      new Set([5]),
    );
  });
});

// ═══════════════════════════════════════════ 5 · an empty branch, and services ═

describe('an empty branch is caught on the branch step', () => {
  it('knows the chosen branch has nobody, and refuses Continue from it', async () => {
    const { result } = mount(salonWith([KWC, SAL]));
    await waitFor(() => expect(result.current.step).toBe('branch'));

    act(() => result.current.pickBranch({ kind: 'branch', branchId: SAL.id }));
    await waitFor(() => expect(result.current.branchHasArtists).toBe(false));

    act(() => result.current.next());
    expect(result.current.step).toBe('branch');
    expect(result.current.stepIndex).toBe(1);

    // Another chip, one tap away on the same step, is the way out.
    act(() => result.current.pickBranch({ kind: 'branch', branchId: KWC.id }));
    await waitFor(() => expect(result.current.branchHasArtists).toBe(true));
    act(() => result.current.next());
    expect(result.current.step).toBe('service');
  });

  it('holds Continue while the chosen branch is still being read', async () => {
    const { result } = mount(salonWith([KWC, SAL]));
    await waitFor(() => expect(result.current.branchHasArtists).toBe(true));

    let land: (rows: BookableArtist[]) => void = () => {};
    getArtists.mockImplementation((_s: string, branch?: string) =>
      branch === KWC.id ? new Promise<BookableArtist[]>((r) => (land = r)) : Promise.resolve(ROSTER),
    );
    act(() => result.current.pickBranch({ kind: 'branch', branchId: KWC.id }));
    expect(result.current.branchHasArtists).toBeNull();
    act(() => result.current.next());
    expect(result.current.step).toBe('branch');

    await act(async () => {
      land([artist('AR-1')]);
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.branchHasArtists).toBe(true));
  });

  /**
   * THIS USED TO PIN THAT THE LIST WAS NOT NARROWED, because there was no
   * artist-to-service relation to narrow by. Migration 0061 added one
   * (`Service.artistIds`) and the flow now narrows by it — but 0062 assigned
   * every artist to every service, so at an existing salon the answer is still
   * EVERY SERVICE, whichever branch. That is the pin now: the new filter
   * changes nothing until a merchant edits assignments.
   */
  it('an existing, fully-assigned salon still offers every service after a branch is chosen', async () => {
    const { result } = mount(salonWith([KWC, SAL]));
    await waitFor(() => expect(result.current.step).toBe('branch'));
    act(() => result.current.pickBranch({ kind: 'branch', branchId: KWC.id }));
    await waitFor(() => expect(result.current.branchHasArtists).toBe(true));
    act(() => result.current.next());
    await waitFor(() => expect(result.current.services.status).toBe('ready'));
    expect(result.current.services).toEqual({ status: 'ready', data: SERVICES });
  });
});

// ═════════════════════════════════════════════════════════════ 6 · back ═════

describe('back, in both salon shapes', () => {
  it('multi-branch: review → day → artist → service → branch, and branch is where the flow is left', async () => {
    const { result } = mount(salonWith([KWC, SAL]));
    await waitFor(() => expect(result.current.branchHasArtists).toBe(true));
    for (let i = 0; i < 4; i += 1) act(() => result.current.next());
    expect(result.current.step).toBe('review');

    const walked: StepName[] = [];
    for (let i = 0; i < 4; i += 1) {
      act(() => result.current.back());
      walked.push(result.current.step);
    }
    expect(walked).toEqual(['day', 'artist', 'service', 'branch']);
    expect(result.current.firstStep).toBe('branch');

    // The machine does not walk off its first step; the screen leaves instead.
    act(() => result.current.back());
    expect(result.current.step).toBe('branch');
  });

  it('single-branch: back from the artist is the service, and the service is where the flow is left', async () => {
    const { result } = mount(salonWith([KWC]));
    await waitFor(() => expect(result.current.services.status).toBe('ready'));
    act(() => result.current.next());
    act(() => result.current.next());
    act(() => result.current.next());
    expect(result.current.step).toBe('review');

    act(() => result.current.back());
    act(() => result.current.back());
    expect(result.current.step).toBe('artist');
    act(() => result.current.back());
    expect(result.current.step).toBe('service');
    expect(result.current.firstStep).toBe('service');
    act(() => result.current.back());
    expect(result.current.step).toBe('service');
  });
});

// ═══════════════════════════════════════════════════════ 7 · rescheduling ══

/**
 * A reschedule fixes the artist, so there is no roster to filter and no branch
 * to ask about. It enters at the grid exactly as before, and the counter it
 * shows is the one it showed before W1.
 */
describe('rescheduling — untouched by the branch step', () => {
  const TARGET: RescheduleTarget = {
    booking: { id: 'BK-1' } as RescheduleTarget['booking'],
    artistId: 'AR-1',
    serviceId: 'SV-1',
  };

  it('enters at the grid on the first render, counts four, and never reads the split', async () => {
    const { result, frames } = mount(salonWith([KWC, SAL]), TARGET);
    expect(frames[0]).toEqual({ step: 'day', stepIndex: 3, totalSteps: 4 });
    await waitFor(() => expect(result.current.services.status).toBe('ready'));

    expect(result.current.step).toBe('day');
    expect(result.current.totalSteps).toBe(4);
    expect(result.current.stepIndex).toBe(3);
    expect(result.current.firstStep).toBe('day');
    expect(result.current.branchOptions).toEqual([]);
    expect(getArtists.mock.calls.some(([, branch]) => branch === 'unassigned')).toBe(false);
    expect(frames.some((f) => f.step === 'entry')).toBe(false);
  });

  it('still refuses to walk back out of the grid into steps she never saw', async () => {
    const { result } = mount(salonWith([KWC, SAL]), TARGET);
    await waitFor(() => expect(result.current.services.status).toBe('ready'));
    act(() => result.current.back());
    expect(result.current.step).toBe('day');
  });
});
