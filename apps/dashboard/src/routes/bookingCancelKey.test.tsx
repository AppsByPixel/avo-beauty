// @vitest-environment jsdom

/**
 * THE SALON'S CANCEL CARRIES AN IDEMPOTENCY KEY — ONE PER ATTEMPT, KEPT ON RETRY.
 *
 * DECISIONS, 2026-09-29, "The salon's cancel takes an Idempotency-Key": lane D
 * found that `POST /salons/{id}/bookings/{id}/cancel` returns a deposit without
 * one. Its status checks stop a double refund, but a retry after a dropped
 * response was told `already_cancelled` about a cancel that had succeeded. The
 * ruling is that the dashboard sends a key and the API requires it (#4).
 *
 * `Appointments` is mounted whole, because the key discipline lives in the
 * SCREEN: the key and the booking id share the one `open` state object there,
 * exactly as the no-show's armed object does (`noShowMarkRender.test.tsx § 7`).
 *
 *   1. Opening the cancel step and confirming sends a real v4 UUID with the
 *      booking it was minted for.
 *   2. A failed attempt keeps the step open AND the key — the retry is a retry.
 *   3. Dismissing and opening again is a new attempt, with a new key.
 *   4. Another booking never inherits the key.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffPerms } from '@avo/types';
import type { MerchantBooking } from '../api/bookings.js';

const useSalon = vi.fn();
const useSalonBookings = vi.fn();
const cancelMutate = vi.fn();
const perms = { void: true, appointments: true } as StaffPerms;

const idleWrite = () => ({ mutate: vi.fn(), reset: vi.fn(), isPending: false, error: null });
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));
vi.mock('../api/salon.js', () => ({ useSalon: () => useSalon() }));
vi.mock('../api/bookingPolicy.js', () => ({
  useBookingPolicy: () => ({ data: null, isSuccess: true, isPending: false, isError: false }),
}));
vi.mock('../api/bookings.js', async () => {
  const real = await vi.importActual<typeof import('../api/bookings.js')>('../api/bookings.js');
  return {
    isSlotTaken: real.isSlotTaken,
    useSalonBookings: () => useSalonBookings(),
    useMarkNoShow: idleWrite,
    useRescheduleBooking: idleWrite,
    useReassignArtist: idleWrite,
    useCancelBooking: () => ({ mutate: cancelMutate, reset: vi.fn(), isPending: false, error: null }),
    useCompleteBooking: idleWrite,
  };
});
vi.mock('../api/artists.js', () => ({ useBookableArtists: () => ({ data: undefined }) }));
vi.mock('./AppointmentForm.js', () => ({ AppointmentForm: () => null }));
vi.mock('../auth/AuthProvider.js', () => ({ useSession: () => ({ perms }) }));

const { Appointments } = await import('./Appointments.js');

/** A day ahead of the frozen clock, so the booking is plainly cancellable. */
const NOW = Date.parse('2026-09-16T10:00:00.000Z');

const HELD: MerchantBooking = {
  id: 'BK-9d0c1f6a-2b44-4d1e-9f77-5a2e3c8b1d40',
  memberId: 'MB-1a2b3c4d5e',
  guestName: null,
  guestPhone: null,
  artistId: 'AR-1a2b3c4d5e',
  branchId: 'BR-1a2b3c4d5e',
  serviceId: 'SV-1a2b3c4d5e',
  startsAt: '2026-09-17T10:00:00.000Z',
  endsAt: '2026-09-17T11:00:00.000Z',
  durationMin: 60,
  depositFils: 5000,
  status: 'deposit_held',
  source: 'app',
  changeableUntil: '2026-09-17T09:00:00.000Z',
  noShowReturnDueAt: '2026-09-17T12:00:00.000Z',
  rescheduledCount: 0,
  calendarSyncState: 'synced',
  policy: null,
  settlement: null,
  returnCapPercent: null,
  branchAssumed: false,
  memberName: 'Dana Al-Sabah',
  memberPhone: '+96599124408',
  memberErased: false,
  memberTier: 'gold',
  artistName: 'Noura Al-Rashid',
  serviceName: 'Balayage',
} as MerchantBooking;

const SECOND: MerchantBooking = {
  ...HELD,
  id: 'BK-4e7b2a10-8c33-4f0d-b1a6-9d5c2e4f7a81',
  memberName: 'Hessa Al-Mutairi',
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

function board(items: MerchantBooking[]) {
  useSalon.mockReturnValue({
    data: { modules: { booking: true }, noShowReturnMinutes: 60, timezone: 'Asia/Kuwait' },
    isPending: false,
    isError: false,
    isSuccess: true,
    isFetching: false,
    refetch: vi.fn(),
  });
  useSalonBookings.mockReturnValue({
    data: { items, nextCursor: null },
    isPending: false,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
  });
  return render(<Appointments />);
}

const openCancel = (name: string) =>
  fireEvent.click(screen.getByRole('button', { name: `Cancel ${name}'s appointment` }));
const confirmCancel = (name: string) =>
  fireEvent.click(screen.getByRole('button', { name: `Yes, cancel ${name}'s appointment` }));
const dismiss = () => fireEvent.click(screen.getByRole('button', { name: 'Keep it' }));

const sent = (n: number) =>
  cancelMutate.mock.calls[n]![0] as { bookingId: string; idempotencyKey?: string };

describe('the salon’s cancel sends an Idempotency-Key', () => {
  it('sends a v4 UUID with the booking it was minted for', () => {
    board([HELD]);
    openCancel('Dana Al-Sabah');
    confirmCancel('Dana Al-Sabah');
    expect(cancelMutate).toHaveBeenCalledTimes(1);
    expect(sent(0).bookingId).toBe(HELD.id);
    expect(sent(0).idempotencyKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  /**
   * A failure arrives as `mutate` NOT calling its `onSuccess`, so the step stays
   * open with the object it was opened with — the same key goes again.
   */
  it('reuses the key when the merchant retries after a failure', () => {
    board([HELD]);
    openCancel('Dana Al-Sabah');
    confirmCancel('Dana Al-Sabah');
    confirmCancel('Dana Al-Sabah');
    expect(cancelMutate).toHaveBeenCalledTimes(2);
    expect(sent(1).idempotencyKey).toBe(sent(0).idempotencyKey);
  });

  it('mints a new key for a new attempt — dismissed and opened again', () => {
    board([HELD]);
    openCancel('Dana Al-Sabah');
    confirmCancel('Dana Al-Sabah');
    dismiss();
    openCancel('Dana Al-Sabah');
    confirmCancel('Dana Al-Sabah');
    expect(sent(1).idempotencyKey).not.toBe(sent(0).idempotencyKey);
  });

  it('never lends one booking’s key to another', () => {
    board([HELD, SECOND]);
    openCancel('Dana Al-Sabah');
    confirmCancel('Dana Al-Sabah');
    openCancel('Hessa Al-Mutairi');
    confirmCancel('Hessa Al-Mutairi');
    expect(sent(0).bookingId).toBe(HELD.id);
    expect(sent(1).bookingId).toBe(SECOND.id);
    expect(sent(1).idempotencyKey).not.toBe(sent(0).idempotencyKey);
  });
});
