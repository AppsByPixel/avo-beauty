// @vitest-environment jsdom

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * MERCHANT → APPOINTMENTS → LIST → THE DATE FILTER. Aftab, 2026-09-29: "Date
 * filters in appointments screen".
 * ═══════════════════════════════════════════════════════════════════════════
 * The screen is mounted WHOLE, with the REAL `useSalonBookings`, and the wire is
 * the thing asserted: `authedRequest` is the only stand-in on the read path, so
 * a range that the screen displays but does not send — or sends and then
 * filters again in the browser — fails here rather than in a merchant's day.
 *
 * FOUR GUARANTEES:
 *
 *   1. THE RANGE REACHES THE SERVER as `?from=&to=`, salon-local dates. No
 *      filter sends exactly the request the list always sent.
 *   2. THE DAYS ARE THE SALON'S. At 21:30Z it is already the 30th in Kuwait;
 *      "Today" must ask for the 30th, whatever clock the test process runs on.
 *   3. A HALF-ASKED "Dates" PAIR ASKS NOTHING, and a reversed one says why.
 *   4. THE THREE STATES — loading, "No appointments in this range", and an error
 *      that keeps the filter on screen so a different range can be asked for.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffPerms } from '@avo/types';
import { ApiError } from '../api/client.js';

const authedRequest = vi.fn();
vi.mock('../auth/authedRequest.js', () => ({
  authedRequest: (...args: unknown[]) => authedRequest(...args),
}));
const perms = { appointments: true, void: true, team: false } as StaffPerms;
vi.mock('../auth/AuthProvider.js', () => ({
  useSalonId: () => 'SAL-AMARA',
  useSession: () => ({ perms }),
}));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));
const useSalon = vi.fn();
vi.mock('../api/salon.js', () => ({ useSalon: () => useSalon() }));
vi.mock('../api/artists.js', () => ({ useBookableArtists: () => ({ data: undefined }) }));
vi.mock('./AppointmentForm.js', () => ({ AppointmentForm: () => null }));

const { Appointments } = await import('./Appointments.js');

/** 21:30 UTC on the 29th is 00:30 on the 30th in Kuwait (+03:00). */
const NOW = Date.parse('2026-09-29T21:30:00.000Z');

const SALON = {
  isSuccess: true,
  isPending: false,
  isError: false,
  isFetching: false,
  refetch: vi.fn(),
  data: {
    id: 'SAL-AMARA',
    timezone: 'Asia/Kuwait',
    modules: { booking: true, shop: true },
    noShowReturnMinutes: 60,
    businessHours: { morning: ['10:00', '13:00'], evening: ['16:00', '21:00'] },
    branches: [],
  },
};

beforeEach(() => {
  // The filter lives in the URL now, and jsdom keeps one URL for the whole file.
  window.history.replaceState(null, '', '/appointments');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  useSalon.mockReturnValue(SALON);
  authedRequest.mockResolvedValue({ items: [], nextCursor: null });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <Appointments />
    </QueryClientProvider>,
  );
}

const bookingPaths = () =>
  authedRequest.mock.calls
    .map(([, path]) => path as string)
    .filter((path) => path.startsWith('/salons/SAL-AMARA/bookings'));

const lastPath = () => bookingPaths()[bookingPaths().length - 1];

const choose = (name: string) => fireEvent.click(screen.getByRole('radio', { name }));

describe('the range reaches the server', () => {
  it('no filter sends the request the list always sent', async () => {
    mount();
    await waitFor(() => expect(bookingPaths()).toHaveLength(1));
    expect(lastPath()).toBe('/salons/SAL-AMARA/bookings');
    expect((screen.getByRole('radio', { name: 'All dates' }) as HTMLElement).getAttribute('aria-checked')).toBe('true');
  });

  it('Today asks for the SALON’s today — the 30th in Kuwait, while UTC is still on the 29th', async () => {
    mount();
    choose('Today');
    await waitFor(() =>
      expect(lastPath()).toBe('/salons/SAL-AMARA/bookings?from=2026-09-30&to=2026-09-30'),
    );
    expect(screen.getByText('30 Sep 2026, in your salon’s own time.')).toBeTruthy();
  });

  it('Tomorrow asks for the day after the salon’s today', async () => {
    mount();
    choose('Tomorrow');
    await waitFor(() =>
      expect(lastPath()).toBe('/salons/SAL-AMARA/bookings?from=2026-10-01&to=2026-10-01'),
    );
  });

  it('This week asks for the week grid’s week — Sunday to Saturday', async () => {
    mount();
    choose('This week');
    await waitFor(() =>
      expect(lastPath()).toBe('/salons/SAL-AMARA/bookings?from=2026-09-27&to=2026-10-03'),
    );
    expect(screen.getByText('27 Sep 2026 – 3 Oct 2026, in your salon’s own time.')).toBeTruthy();
  });

  it('Dates sends the two days typed, and nothing until both are there', async () => {
    mount();
    await waitFor(() => expect(bookingPaths()).toHaveLength(1));
    choose('Dates');
    expect(screen.getByText(/Pick both days\./)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-10-04' } });
    // Half a range is not a question. Still only the first, unfiltered request.
    expect(bookingPaths()).toHaveLength(1);
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-10-10' } });
    await waitFor(() =>
      expect(lastPath()).toBe('/salons/SAL-AMARA/bookings?from=2026-10-04&to=2026-10-10'),
    );
  });

  it('a reversed pair says why and asks nothing', async () => {
    mount();
    await waitFor(() => expect(bookingPaths()).toHaveLength(1));
    choose('Dates');
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-10-10' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-10-04' } });
    expect(screen.getByRole('alert').textContent).toBe('The start date is after the end date.');
    expect(bookingPaths()).toHaveLength(1);
    // No table is drawn under a question that was not asked.
    expect(screen.queryByRole('table')).toBeNull();
  });
});

describe('the states', () => {
  it('loading: skeleton rows while the range is being read', async () => {
    authedRequest.mockReturnValue(new Promise(() => {}));
    const { container } = mount();
    choose('Today');
    expect(container.querySelectorAll('.appts__table tbody .avo-skeleton').length).toBeGreaterThan(0);
  });

  it('empty: "No appointments in this range", naming the day', async () => {
    mount();
    choose('Today');
    await screen.findByText('No appointments in this range');
    expect(screen.getByText('Nothing is booked on 30 Sep 2026.')).toBeTruthy();
    // The unfiltered empty is a different fact, and its copy is not reused.
    expect(screen.queryByText('No appointments this week')).toBeNull();
  });

  /**
   * "All dates" asked for the whole book, so its empty says the whole book is
   * empty. It said "No appointments this week" — the design's title for a board
   * that showed one week — under a filter that is not a week.
   */
  it('the unfiltered empty speaks for the whole book, not for this week', async () => {
    mount();
    await screen.findByText('No appointments yet');
    expect(screen.queryByText('No appointments this week')).toBeNull();
    expect(screen.queryByText('No appointments in this range')).toBeNull();
  });

  it('"This week" is where the design’s "No appointments this week" is true, with the days named', async () => {
    mount();
    choose('This week');
    await screen.findByText('No appointments this week');
    expect(screen.getByText('Nothing is booked between 27 Sep 2026 and 3 Oct 2026.')).toBeTruthy();
    expect(screen.queryByText('No appointments in this range')).toBeNull();
  });

  it('error: the refusal renders UNDER the filter, so another range can still be asked for', async () => {
    authedRequest.mockRejectedValue(
      new ApiError('Something broke.', { status: 500, code: 'internal' }),
    );
    mount();
    choose('Tomorrow');
    await screen.findByText("Couldn't load Appointments");
    expect(screen.getByRole('radiogroup', { name: 'Dates shown' })).toBeTruthy();
    authedRequest.mockResolvedValue({ items: [], nextCursor: null });
    choose('Today');
    await screen.findByText('No appointments in this range');
  });

  it('more than one page matched: said, not hidden', async () => {
    authedRequest.mockResolvedValue({ items: [], nextCursor: 'abc' });
    mount();
    choose('This week');
    await screen.findByText(/More appointments match than fit on one page/);
  });
});
