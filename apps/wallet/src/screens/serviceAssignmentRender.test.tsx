// @vitest-environment jsdom

/**
 * WHO DOES WHICH SERVICE — `Service.artistIds` (migration 0061), driven through
 * the real `useBooking` and the real `BookScreen`. Only the wire is mocked.
 *
 * What is pinned, in the brief's order:
 *   1. a service with `artistIds: []` is hidden;
 *   2. at a multi-branch salon, after she picks a branch, only services with at
 *      least one assigned artist AT THAT BRANCH (the intersection of
 *      `service.artistIds` with `/artists/bookable?branch=`);
 *   3. the staff step shows only the artists assigned to her service;
 *   4. `409 artist_not_assigned` is recoverable, from the CODE, EN and AR — a
 *      new booking goes back to the staff step with her service kept; a
 *      reschedule is told its appointment did not move;
 *   5. an existing (fully-assigned) salon's flow is unchanged.
 *
 * THE REFUSAL BODY IS THE API'S, verbatim from `notAssigned` in
 * api/src/services/artistService.ts, so a screen that rendered the English
 * `message` — in Arabic above all — is caught.
 */

import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BookableArtist, Language, Member, Salon } from '@avo/types';

vi.mock('react-native-svg', () => {
  const nothing = () => null;
  return { default: nothing, Svg: nothing, Path: nothing, Circle: nothing, Rect: nothing, G: nothing };
});

const { getServices, getArtists, getAvailability, createBooking, rescheduleBooking } = vi.hoisted(
  () => ({
    getServices: vi.fn(),
    getArtists: vi.fn(),
    getAvailability: vi.fn(),
    createBooking: vi.fn(),
    rescheduleBooking: vi.fn(),
  }),
);
vi.mock('../api/booking', () => ({
  getServices,
  getArtists,
  getAvailability,
  createBooking,
  rescheduleBooking,
  getBookings: vi.fn(),
  cancelBooking: vi.fn(),
}));
vi.mock('../api/topups', () => ({ createTopUp: vi.fn(), getTopUp: vi.fn() }));
vi.mock('../platform/gateway', () => ({ openGateway: vi.fn() }));

/* eslint-disable import/first */
import { BookScreen } from './BookScreen';
import { useBooking, type RescheduleTarget } from '../state/useBooking';
import { LanguageProvider } from '../i18n/language';
import { ApiError } from '../api/client';
import { assignedArtists, bookableServices } from '../domain/serviceAssignment';
import { en } from '../copy/en';
import { ar } from '../copy/ar';

// --------------------------------------------------------------- fixtures --

const KWC = { id: 'BR-KWC', name: 'Kuwait City', nameAr: 'مدينة الكويت' };
const SAL = { id: 'BR-SAL', name: 'Salmiya', nameAr: 'السالمية' };
/** A branch whose one artist performs nothing — "nobody bookable here". */
const JAH = { id: 'BR-JAH', name: 'Jahra', nameAr: 'الجهراء' };

const salonWith = (branches: Array<typeof KWC>): Salon =>
  ({
    id: 'SAL-AMARA',
    timezone: 'Asia/Kuwait',
    depositFils: 5000,
    branches,
    modules: { booking: true },
  }) as unknown as Salon;

const MEMBER = { balanceFils: 25000, tier: 'silver' } as unknown as Member;

const artist = (id: string): BookableArtist =>
  ({ id, salonId: 'SAL-AMARA', name: id, nameAr: null, availabilityLive: false }) as BookableArtist;

/** AR-1 at Kuwait City, AR-2 at Salmiya, AR-3 with no branch, AR-9 at Jahra. */
function serveRoster() {
  getArtists.mockImplementation((_s: string, branch?: string) => {
    if (branch === 'unassigned') return Promise.resolve([artist('AR-3')]);
    if (branch === KWC.id) return Promise.resolve([artist('AR-1')]);
    if (branch === SAL.id) return Promise.resolve([artist('AR-2')]);
    if (branch === JAH.id) return Promise.resolve([artist('AR-9')]);
    return Promise.resolve([artist('AR-1'), artist('AR-2'), artist('AR-3'), artist('AR-9')]);
  });
}

const service = (id: string, name: string, artistIds: string[]) => ({
  id,
  salonId: 'SAL-AMARA',
  name,
  nameAr: null,
  priceFils: 12000,
  active: true,
  image: null,
  artistIds,
});

/** A salon that HAS edited its assignments. */
const CUT = service('SV-CUT', 'Cut & style', ['AR-1', 'AR-2']);
const BALAYAGE = service('SV-BAL', 'Balayage', ['AR-2']); // Salmiya only
const NAILS = service('SV-NAIL', 'Nails', []); // nobody
const BROWS = service('SV-BROW', 'Brows', ['AR-3']); // the unassigned group only
const EDITED = [CUT, BALAYAGE, NAILS, BROWS];

/** A salon that has not — migration 0062 assigned everyone to everything. */
const EVERYONE = ['AR-1', 'AR-2', 'AR-3', 'AR-9'];
const BACKFILLED = [service('SV-CUT', 'Cut & style', EVERYONE), service('SV-BAL', 'Balayage', EVERYONE)];

const SLOT = {
  startsAt: '2026-09-14T13:00:00Z',
  endsAt: '2026-09-14T13:45:00Z',
  local: '16:00',
  available: true,
};

/** Verbatim from api/src/services/artistService.ts § notAssigned. */
const NOT_ASSIGNED = () =>
  new ApiError(
    'server',
    'AR-1 does not do Cut & style. Choose someone who does, or another service.',
    'REF-409',
    409,
    'artist_not_assigned',
    { artistId: 'AR-1', serviceId: 'SV-CUT' },
  );

const mount = (salon: Salon, reschedule?: RescheduleTarget) =>
  renderHook(() =>
    useBooking({ salon, reschedule, onBooked: vi.fn(), now: new Date('2026-09-14T08:00:00+03:00') }),
  );

const ids = (state: { status: string; data?: readonly { id: string }[] }) =>
  state.status === 'ready' ? state.data!.map((x) => x.id) : state.status;

beforeEach(() => {
  vi.clearAllMocks();
  getServices.mockResolvedValue(EDITED);
  getAvailability.mockResolvedValue({ date: '2026-09-14', open: true, hoursSource: 'artist', slots: [SLOT] });
  serveRoster();
});

afterEach(cleanup);

// ══════════════════════════════════════════════════════════ the rules, pure ══

describe('domain/serviceAssignment', () => {
  it('hides a service nobody is assigned to, even with no roster to intersect', () => {
    expect(bookableServices(EDITED, null).map((s) => s.id)).toEqual(['SV-CUT', 'SV-BAL', 'SV-BROW']);
  });
  it('is the intersection with the roster', () => {
    expect(bookableServices(EDITED, [artist('AR-1')]).map((s) => s.id)).toEqual(['SV-CUT']);
    expect(bookableServices(EDITED, [artist('AR-2')]).map((s) => s.id)).toEqual(['SV-CUT', 'SV-BAL']);
    expect(bookableServices(EDITED, []).map((s) => s.id)).toEqual([]);
  });
  it('narrows the roster to the artists who perform the service', () => {
    const roster = [artist('AR-1'), artist('AR-2'), artist('AR-3')];
    expect(assignedArtists(roster, BALAYAGE).map((a) => a.id)).toEqual(['AR-2']);
    expect(assignedArtists(roster, NAILS)).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════ 1 · `[]` is hidden ══

describe('1. a service with nobody assigned is hidden', () => {
  it('single-branch salon: Nails (artistIds: []) is never offered', async () => {
    const { result } = mount(salonWith([KWC]));
    await waitFor(() => expect(result.current.services.status).toBe('ready'));
    expect(ids(result.current.services)).toEqual(['SV-CUT', 'SV-BAL', 'SV-BROW']);
  });

  it('the service list waits for the roster rather than showing a service that then vanishes', async () => {
    let land: (rows: BookableArtist[]) => void = () => {};
    getArtists.mockImplementation(() => new Promise<BookableArtist[]>((r) => (land = r)));
    const { result } = mount(salonWith([KWC]));
    await waitFor(() => expect(getServices).toHaveBeenCalled());
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.services.status).toBe('loading');
    await act(async () => {
      land([artist('AR-1')]);
      await Promise.resolve();
    });
    await waitFor(() => expect(ids(result.current.services)).toEqual(['SV-CUT']));
  });

  it('a salon where NOTHING is assigned says so on the service step', async () => {
    getServices.mockResolvedValue([NAILS]);
    render(
      <LanguageProvider initial="en">
        <BookScreen salon={salonWith([KWC])} member={MEMBER} memberFetchedAt={null} onHome={vi.fn()} onBooked={vi.fn()} onToast={vi.fn()} />
      </LanguageProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('book-services-empty')).toBeTruthy());
    expect(screen.getByTestId('book-services-empty').textContent).toContain(en.servicesEmptyTitle);
    expect(screen.queryByTestId('book-service-SV-NAIL')).toBeNull();
  });
});

// ═══════════════════════════════════════ 2 · branch → service, intersected ══

describe('2. after she picks a branch, only what somebody THERE does', () => {
  it('Kuwait City offers Cut only; Salmiya offers Cut and Balayage', async () => {
    const { result } = mount(salonWith([KWC, SAL]));
    await waitFor(() => expect(result.current.step).toBe('branch'));

    act(() => result.current.pickBranch({ kind: 'branch', branchId: KWC.id }));
    await waitFor(() => expect(result.current.branchHasArtists).toBe(true));
    act(() => result.current.next());
    await waitFor(() => expect(ids(result.current.services)).toEqual(['SV-CUT']));

    act(() => result.current.back());
    act(() => result.current.pickBranch({ kind: 'branch', branchId: SAL.id }));
    await waitFor(() => expect(ids(result.current.services)).toEqual(['SV-CUT', 'SV-BAL']));

    // The unassigned group: only what AR-3 does.
    act(() => result.current.pickBranch({ kind: 'unassigned' }));
    await waitFor(() => expect(ids(result.current.services)).toEqual(['SV-BROW']));
  });

  it('a branch whose artists perform nothing is caught on the branch step, not after', async () => {
    const { result } = mount(salonWith([KWC, SAL, JAH]));
    await waitFor(() => expect(result.current.step).toBe('branch'));
    act(() => result.current.pickBranch({ kind: 'branch', branchId: JAH.id }));
    await waitFor(() => expect(result.current.branchHasArtists).toBe(false));
    act(() => result.current.next());
    expect(result.current.step).toBe('branch');
  });
});

// ═══════════════════════════════════════════ 3 · the staff step, narrowed ══

describe('3. the staff step shows only the artists assigned to her service', () => {
  it('Balayage → AR-2 only; Brows → AR-3 only', async () => {
    const { result } = mount(salonWith([KWC]));
    await waitFor(() => expect(result.current.services.status).toBe('ready'));

    act(() => result.current.pickService(BALAYAGE));
    act(() => result.current.next());
    expect(ids(result.current.artists)).toEqual(['AR-2']);

    act(() => result.current.back());
    act(() => result.current.pickService(BROWS));
    act(() => result.current.next());
    expect(ids(result.current.artists)).toEqual(['AR-3']);
  });

  it('changing to a service her artist does not do clears the artist', async () => {
    const { result } = mount(salonWith([KWC]));
    await waitFor(() => expect(result.current.services.status).toBe('ready'));
    act(() => result.current.pickService(CUT));
    act(() => result.current.next());
    act(() => result.current.pickArtist(artist('AR-1')));
    expect(result.current.selectedArtist?.id).toBe('AR-1');
    act(() => result.current.back());
    act(() => result.current.pickService(BALAYAGE));
    act(() => result.current.next());
    expect(result.current.selectedArtist).toBeNull();
  });

  it('renders only the assigned rows on screen', async () => {
    render(
      <LanguageProvider initial="en">
        <BookScreen salon={salonWith([KWC])} member={MEMBER} memberFetchedAt={null} onHome={vi.fn()} onBooked={vi.fn()} onToast={vi.fn()} />
      </LanguageProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('book-service-SV-BAL')).toBeTruthy());
    expect(screen.queryByTestId('book-service-SV-NAIL')).toBeNull();
    fireEvent.click(screen.getByTestId('book-service-SV-BAL'));
    fireEvent.click(screen.getByTestId('book-next'));
    await waitFor(() => expect(screen.getByTestId('book-artist-AR-2')).toBeTruthy());
    expect(screen.queryByTestId('book-artist-AR-1')).toBeNull();
    expect(screen.queryByTestId('book-artist-AR-3')).toBeNull();
  });
});

// ═══════════════════════════════════════ 4 · `409 artist_not_assigned` ══

/** Service → artist → the one slot → review → confirm, on screen. */
async function walkToConfirm() {
  await waitFor(() => expect(screen.getByTestId('book-service-SV-CUT')).toBeTruthy());
  fireEvent.click(screen.getByTestId('book-service-SV-CUT'));
  fireEvent.click(screen.getByTestId('book-next'));
  await waitFor(() => expect(screen.getByTestId('book-artist-AR-1')).toBeTruthy());
  fireEvent.click(screen.getByTestId('book-artist-AR-1'));
  fireEvent.click(screen.getByTestId('book-next'));
  await waitFor(() => expect(screen.getByTestId('book-slot-16:00')).toBeTruthy());
  fireEvent.click(screen.getByTestId('book-slot-16:00'));
  fireEvent.click(screen.getByTestId('book-next'));
  await waitFor(() => expect(screen.getByTestId('book-confirm')).toBeTruthy());
  fireEvent.click(screen.getByTestId('book-confirm'));
}

describe('4. `409 artist_not_assigned` is recoverable, from the code', () => {
  it.each([
    ['en', en],
    ['ar', ar],
  ] as const)('%s — back to the staff step, service kept, artist cleared, said in her language', async (lang: Language, copy) => {
    createBooking.mockRejectedValueOnce(NOT_ASSIGNED());
    render(
      <LanguageProvider initial={lang}>
        <BookScreen salon={salonWith([KWC])} member={MEMBER} memberFetchedAt={null} onHome={vi.fn()} onBooked={vi.fn()} onToast={vi.fn()} />
      </LanguageProvider>,
    );
    await walkToConfirm();

    const notice = await screen.findByTestId('book-artist-unassigned');
    expect(notice.textContent).toBe(`${copy.artistNotAssignedTitle}${copy.artistNotAssignedBody}`);
    // Never the server's English sentence.
    expect(document.body.textContent).not.toContain('does not do');
    // The lists were re-read, so the step shows who does it NOW.
    await waitFor(() => expect(getServices).toHaveBeenCalledTimes(2));
    // On the staff step, with Continue held until she picks again.
    await waitFor(() => expect(screen.getByTestId('book-artist-AR-2')).toBeTruthy());
    expect(screen.getByTestId('book-next').getAttribute('aria-disabled')).toBe('true');
  });

  it('she picks someone else and books — a new attempt, a new key, the service unchanged', async () => {
    createBooking.mockRejectedValueOnce(NOT_ASSIGNED());
    createBooking.mockResolvedValueOnce({
      booking: { id: 'BK-2', depositFils: 5000, startsAt: SLOT.startsAt, artistId: 'AR-2', serviceId: 'SV-CUT' },
      balanceAfterFils: 20000,
    });
    render(
      <LanguageProvider initial="en">
        <BookScreen salon={salonWith([KWC])} member={MEMBER} memberFetchedAt={null} onHome={vi.fn()} onBooked={vi.fn()} onToast={vi.fn()} />
      </LanguageProvider>,
    );
    await walkToConfirm();
    await screen.findByTestId('book-artist-unassigned');
    await waitFor(() => expect(screen.getByTestId('book-artist-AR-2')).toBeTruthy());

    fireEvent.click(screen.getByTestId('book-artist-AR-2'));
    expect(screen.queryByTestId('book-artist-unassigned')).toBeNull();
    fireEvent.click(screen.getByTestId('book-next'));
    await waitFor(() => expect(screen.getByTestId('book-slot-16:00')).toBeTruthy());
    fireEvent.click(screen.getByTestId('book-slot-16:00'));
    fireEvent.click(screen.getByTestId('book-next'));
    fireEvent.click(await screen.findByTestId('book-confirm'));
    await waitFor(() => expect(createBooking).toHaveBeenCalledTimes(2));

    const [first, second] = createBooking.mock.calls;
    expect(first![0]).toEqual({ artistId: 'AR-1', serviceId: 'SV-CUT', startsAt: SLOT.startsAt });
    expect(second![0]).toEqual({ artistId: 'AR-2', serviceId: 'SV-CUT', startsAt: SLOT.startsAt });
    expect(second![1]).not.toBe(first![1]);
  });

  it.each([
    ['en', en],
    ['ar', ar],
  ] as const)('%s — a reschedule is told its appointment did not move', async (lang: Language, copy) => {
    rescheduleBooking.mockRejectedValueOnce(NOT_ASSIGNED());
    const target: RescheduleTarget = {
      booking: { id: 'BK-1', artistId: 'AR-1', serviceId: 'SV-CUT', depositFils: 5000 } as RescheduleTarget['booking'],
      artistId: 'AR-1',
      serviceId: 'SV-CUT',
    };
    render(
      <LanguageProvider initial={lang}>
        <BookScreen salon={salonWith([KWC])} member={MEMBER} memberFetchedAt={null} onHome={vi.fn()} onBooked={vi.fn()} onToast={vi.fn()} reschedule={target} />
      </LanguageProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('book-slot-16:00')).toBeTruthy());
    fireEvent.click(screen.getByTestId('book-slot-16:00'));
    fireEvent.click(screen.getByTestId('book-next'));
    fireEvent.click(await screen.findByTestId('book-confirm'));

    const failure = await screen.findByTestId('book-confirm-failure');
    expect(failure.textContent).toBe(`${copy.artistNotAssignedTitle}${copy.artistNotAssignedRescheduleBody}`);
    expect(document.body.textContent).not.toContain('does not do');
  });
});

// ═══════════════════════════════ 5 · an existing salon — nothing moved ══

describe('5. an existing, fully-assigned salon (0062 backfill) is unchanged', () => {
  beforeEach(() => getServices.mockResolvedValue(BACKFILLED));

  it('every branch offers every service, and every artist there for each', async () => {
    const { result } = mount(salonWith([KWC, SAL]));
    await waitFor(() => expect(result.current.step).toBe('branch'));
    for (const [branch, roster] of [
      [KWC.id, ['AR-1']],
      [SAL.id, ['AR-2']],
    ] as const) {
      act(() => result.current.pickBranch({ kind: 'branch', branchId: branch }));
      await waitFor(() => expect(result.current.branchHasArtists).toBe(true));
      act(() => result.current.next());
      await waitFor(() => expect(ids(result.current.services)).toEqual(['SV-CUT', 'SV-BAL']));
      act(() => result.current.pickService(BACKFILLED[1]!));
      act(() => result.current.next());
      expect(ids(result.current.artists)).toEqual([...roster]);
      act(() => result.current.back());
      act(() => result.current.back());
    }
  });

  it('single-branch: the whole list and the whole roster, as before 0061', async () => {
    const { result } = mount(salonWith([KWC]));
    await waitFor(() => expect(result.current.services.status).toBe('ready'));
    expect(result.current.services).toEqual({ status: 'ready', data: BACKFILLED });
    act(() => result.current.pickService(BACKFILLED[0]!));
    act(() => result.current.next());
    expect(ids(result.current.artists)).toEqual(['AR-1', 'AR-2', 'AR-3', 'AR-9']);
  });
});
