// @vitest-environment jsdom

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * MERCHANT → APPOINTMENTS → WEEK → A CHIP OPENS ITS BOOKING. Aftab, 2026-09-29:
 * "The calendar view things should be clickable".
 * ═══════════════════════════════════════════════════════════════════════════
 * `Appointments` is mounted WHOLE with the real stream and the real write
 * hooks; `authedRequest` is the only stand-in. So "the popover reuses the list's
 * controls" is asserted by what reaches the wire, not by a mock's call count.
 *
 *   1. A CHIP IS A REAL <button>, keyboard-reachable, named for its booking.
 *   2. IT OPENS A DIALOG with the booking's facts and the list's own controls.
 *   3. THE CONTROLS ARE THE LIST'S RULES: arm-then-confirm cancel sends the
 *      list's request; `perms.void` off withholds cancel here exactly as there.
 *   4. ESCAPE CLOSES AND FOCUS RETURNS TO THE CHIP.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffPerms } from '@avo/types';
import type { MerchantBooking } from '../api/bookings.js';

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

/** Tuesday 29 Sep 2026, 12:00 in Kuwait. */
const NOW = Date.parse('2026-09-29T09:00:00.000Z');

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

/** Wednesday 30 Sep, 10:00–11:00 Kuwait. A held 5.000 KD — not yet started. */
const BOOKING: MerchantBooking = {
  id: 'BK-10000005',
  memberId: 'MB-1a2b3c4d5e',
  guestName: null,
  guestPhone: null,
  artistId: 'AR-1a2b3c4d5e',
  branchId: 'BR-1a2b3c4d5e',
  serviceId: 'SV-1a2b3c4d5e',
  startsAt: '2026-09-30T07:00:00.000Z',
  endsAt: '2026-09-30T08:00:00.000Z',
  durationMin: 60,
  depositFils: 5000,
  status: 'deposit_held',
  source: 'app',
  changeableUntil: '2026-09-30T06:00:00.000Z',
  noShowReturnDueAt: '2026-09-30T09:00:00.000Z',
  rescheduledCount: 0,
  calendarSyncState: 'synced',
  policy: null,
  settlement: null,
  branchAssumed: false,
  memberName: 'Dana Al-Sabah',
  memberPhone: '+96599124408',
  memberErased: false,
  memberTier: 'gold',
  artistName: 'Noura Al-Rashid',
  serviceName: 'Balayage',
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  useSalon.mockReturnValue(SALON);
  perms.void = true;
  authedRequest.mockImplementation((_scope: string, path: string, options?: { method?: string }) => {
    if (options?.method === 'POST') return Promise.resolve({ ...BOOKING, status: 'cancelled' });
    if (path.startsWith('/salons/SAL-AMARA/bookings')) {
      return Promise.resolve({ items: [BOOKING], nextCursor: null });
    }
    return Promise.reject(new Error(`unexpected ${path}`));
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

async function openWeek() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <Appointments />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole('radio', { name: 'Week' }));
  return screen.findByRole('button', { name: /Dana Al-Sabah/ });
}

describe('a chip is a button that opens its booking', () => {
  it('is a real, focusable <button> that says it opens a dialog', async () => {
    const chip = await openWeek();
    expect(chip.tagName).toBe('BUTTON');
    expect(chip.getAttribute('aria-haspopup')).toBe('dialog');
    expect(chip.getAttribute('aria-expanded')).toBe('false');
    chip.focus();
    expect(document.activeElement).toBe(chip);
  });

  it('opens a dialog with the booking’s facts and the list’s controls', async () => {
    const chip = await openWeek();
    fireEvent.click(chip);
    const dialog = screen.getByRole('dialog', { name: 'Dana Al-Sabah' });
    expect(chip.getAttribute('aria-expanded')).toBe('true');
    expect(within(dialog).getByText('Balayage')).toBeTruthy();
    expect(within(dialog).getByText('Noura Al-Rashid')).toBeTruthy();
    expect(within(dialog).getByText('Deposit held')).toBeTruthy();
    // The list's four gates, applied: held deposit, not started, void on.
    expect(within(dialog).getByRole('button', { name: 'Change the date or time for Dana Al-Sabah' })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Reassign Dana Al-Sabah to another artist' })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: "Cancel Dana Al-Sabah's appointment" })).toBeTruthy();
    // Mark done is withheld on a deposit-bearing booking; no-show before the slot starts.
    expect(within(dialog).queryByRole('button', { name: /as done/ })).toBeNull();
    expect(within(dialog).queryByRole('button', { name: /no-show/ })).toBeNull();
    // Focus moved into the dialog.
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it('cancel is the list’s arm-then-confirm, and sends the list’s request', async () => {
    fireEvent.click(await openWeek());
    const dialog = screen.getByRole('dialog', { name: 'Dana Al-Sabah' });
    fireEvent.click(within(dialog).getByRole('button', { name: "Cancel Dana Al-Sabah's appointment" }));
    // Nothing sent on the first press — the confirmation is the list's.
    expect(authedRequest.mock.calls.some(([, , o]) => o?.method === 'POST')).toBe(false);
    expect(within(dialog).getByText(/Cancel this appointment and return/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: "Yes, cancel Dana Al-Sabah's appointment" }));
    await waitFor(() =>
      expect(
        authedRequest.mock.calls.find(([, , o]) => o?.method === 'POST')?.[1],
      ).toBe('/salons/SAL-AMARA/bookings/BK-10000005/cancel'),
    );
  });

  it('perms.void off withholds cancel here exactly as the list does', async () => {
    perms.void = false;
    fireEvent.click(await openWeek());
    const dialog = screen.getByRole('dialog', { name: 'Dana Al-Sabah' });
    expect(within(dialog).queryByRole('button', { name: /Cancel Dana/ })).toBeNull();
    expect(within(dialog).getByRole('button', { name: /Reassign Dana/ })).toBeTruthy();
  });

  it('Escape closes it and focus returns to the chip', async () => {
    const chip = await openWeek();
    fireEvent.click(chip);
    expect(screen.getByRole('dialog')).toBeTruthy();
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(chip);
    expect(chip.getAttribute('aria-expanded')).toBe('false');
  });

  it('the close button closes it too', async () => {
    fireEvent.click(await openWeek());
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
