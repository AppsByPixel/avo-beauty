// @vitest-environment jsdom

/**
 * `useMarkNoShow` — the request it sends, and what it leaves in the cache.
 *
 * SEPARATE FROM `routes/noShowMarkRender.test.tsx` BECAUSE THAT FILE MOCKS THIS
 * MODULE. The render test drives the SCREEN, so it replaces the three data hooks
 * wholesale — which is right for what it asserts (the gate, the confirmation,
 * the key discipline) and leaves exactly this hook unexercised. Splitting them
 * is the same reason `productImage.test.tsx` sits beside its module rather than
 * beside its screen.
 *
 * THE TWO GUARANTEES WORTH THE FILE:
 *
 *   1. THE ROW SURVIVES ITS OWN UPDATE. The 200 body's `booking` is
 *      `serialiseBooking(row)` and carries NONE of the joined fields the board
 *      draws — no `memberName`, no `serviceName`, no `artistName`. Splicing it
 *      into the list would blank the customer's name on the one row a merchant
 *      is looking at. `MarkedBooking` makes USING the response as the row a
 *      compile error — measured, TS2345, "missing … branchAssumed, memberName,
 *      memberPhone, memberErased, and 3 more" — but a blanket SPREAD over the
 *      row still typechecks, so the type is only half the guard. This is the
 *      other half: it proves the narrow patch actually is narrow.
 *
 *   2. THE MARKED ROW STOPS OFFERING THE LINK IMMEDIATELY. An invalidation
 *      alone leaves a window in which the row still reads `deposit_held` and
 *      still draws the control that has just been used. The patch closes it and
 *      the invalidation reconciles everything else — including the slot the mark
 *      just released, which is a change to OTHER rows and not to this one.
 *
 * AND ONE NEGATIVE: A FAILED MARK CHANGES NOTHING. The reassurance the screen
 * renders ("The deposit is still held.") is a claim about the cache as much as
 * about the database.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './client.js';

const authedRequest = vi.fn();
vi.mock('../auth/authedRequest.js', () => ({
  authedRequest: (...args: unknown[]) => authedRequest(...args),
}));

/** The salon comes from the session, and there is no session in a jsdom realm. */
vi.mock('../auth/AuthProvider.js', () => ({ useSalonId: () => 'SAL-AMARA' }));

const { bookingKeys, useMarkNoShow } = await import('./bookings.js');
type MerchantBooking = import('./bookings.js').MerchantBooking;
type MarkNoShowResult = import('./bookings.js').MarkNoShowResult;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const BOOKING_ID = 'BK-9d0c1f6a-2b44-4d1e-9f77-5a2e3c8b1d40';

/** The row as `GET /salons/{id}/bookings` serves it — joins and all. */
const ROW: MerchantBooking = {
  id: BOOKING_ID,
  memberId: 'MB-1a2b3c4d5e',
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
  branchAssumed: false,
  memberName: 'Dana Al-Sabah',
  memberPhone: '+96599124408',
  memberErased: false,
  memberTier: 'gold',
  artistName: 'Noura Al-Rashid',
  serviceName: 'Balayage',
};

/**
 * The 200 body, as `markNoShow` composes it — `serialiseBooking(row)` with the
 * status overridden, and NOT ONE JOINED FIELD. That absence is the fixture's
 * whole point: it is what the client must not splice over the row.
 */
const OK: MarkNoShowResult = {
  booking: {
    id: BOOKING_ID,
    memberId: ROW.memberId,
    artistId: ROW.artistId,
    branchId: ROW.branchId,
    serviceId: ROW.serviceId,
    startsAt: ROW.startsAt,
    endsAt: ROW.endsAt,
    durationMin: 60,
    depositFils: 5000,
    status: 'no_show_returned',
    source: 'app',
    changeableUntil: ROW.changeableUntil,
    noShowReturnDueAt: ROW.noShowReturnDueAt,
    rescheduledCount: 0,
    calendarSyncState: 'synced',
  },
  /** INTEGER FILS, both — #1. The deposit back, and her wallet after it. */
  refundedFils: 5000,
  balanceAfterFils: 29500,
  transactionId: 'TX-3233428',
};

const LIST_KEY = bookingKeys.list('SAL-AMARA', null);

function rig() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  client.setQueryData(LIST_KEY, { items: [ROW], nextCursor: null });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(() => useMarkNoShow(), { wrapper });
  const cached = () =>
    client.getQueryData<{ items: MerchantBooking[] }>(LIST_KEY)!.items[0]!;
  return { client, result, cached };
}

describe('the request the mark sends', () => {
  it('POSTs to the salon-scoped path with the caller’s key and no body', async () => {
    authedRequest.mockResolvedValue(OK);
    const { result } = rig();

    await act(async () => {
      await result.current.mutateAsync({ bookingId: BOOKING_ID, idempotencyKey: 'K-first' });
    });

    expect(authedRequest).toHaveBeenCalledTimes(1);
    const [scope, path, options] = authedRequest.mock.calls[0] as [
      string,
      string,
      Record<string, unknown>,
    ];
    expect(scope).toBe('merchant');
    // Salon-scoped: the tenant segment is what `requireSameSalon` needs, and
    // without it another salon's booking would be refused only by a lookup.
    expect(path).toBe(`/salons/SAL-AMARA/bookings/${BOOKING_ID}/no-show`);
    expect(options.method).toBe('POST');
    // #4 — the key the ARMED ROW minted, passed through untouched.
    expect(options.idempotencyKey).toBe('K-first');
    // There is no body. `client.ts` only sets Content-Type when there is one,
    // and the server hashes `{ salonId, bookingId }` rather than a payload.
    expect('body' in options).toBe(false);
  });
});

describe('what the mark leaves in the cache', () => {
  it('flips the row to no_show_returned without blanking the customer', async () => {
    authedRequest.mockResolvedValue(OK);
    const { result, cached } = rig();

    await act(async () => {
      await result.current.mutateAsync({ bookingId: BOOKING_ID, idempotencyKey: 'K-first' });
    });

    expect(cached().status).toBe('no_show_returned');
    // The three fields the response does not carry. A whole-object splice would
    // have made every one of these `undefined`.
    expect(cached().memberName).toBe('Dana Al-Sabah');
    expect(cached().serviceName).toBe('Balayage');
    expect(cached().artistName).toBe('Noura Al-Rashid');
    // And the figure a disputed no-show is argued over is still an integer.
    expect(cached().depositFils).toBe(5000);
  });

  /**
   * THE REFETCH IS THE OTHER HALF, and it is about OTHER rows.
   * `booking_artist_slot_no_overlap` excludes `no_show_returned`, so the artist
   * is free at that hour the moment this commits. The list is the server's
   * answer to what is on the board; after a write that releases a slot it has to
   * be asked again.
   */
  it('marks the list stale so the released slot is re-read', async () => {
    authedRequest.mockResolvedValue(OK);
    const { client, result } = rig();

    await act(async () => {
      await result.current.mutateAsync({ bookingId: BOOKING_ID, idempotencyKey: 'K-first' });
    });

    await waitFor(() => {
      expect(client.getQueryState(LIST_KEY)?.isInvalidated).toBe(true);
    });
  });

  /**
   * "The deposit is still held." is a claim about the cache as much as about the
   * database, and a refused mark must leave the board exactly as it was — so a
   * retry is a retry of the same row rather than of a row the client already
   * reported as marked.
   */
  it('leaves the row untouched when the mark is refused', async () => {
    authedRequest.mockRejectedValue(
      new ApiError('That appointment has not started yet, so it cannot be marked as a no-show.', {
        status: 409,
        code: 'appointment_not_started',
      }),
    );
    const { result, cached } = rig();

    await act(async () => {
      await result.current
        .mutateAsync({ bookingId: BOOKING_ID, idempotencyKey: 'K-first' })
        .catch(() => {});
    });

    expect(cached()).toEqual(ROW);
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toBeInstanceOf(ApiError);
  });

  /** Only the booking that was marked. A sibling on the same board is not news. */
  it('patches one row and not the list', async () => {
    authedRequest.mockResolvedValue(OK);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const sibling: MerchantBooking = { ...ROW, id: 'BK-other', memberName: 'Hessa Al-Mutairi' };
    client.setQueryData(LIST_KEY, { items: [ROW, sibling], nextCursor: null });
    const { result } = renderHook(() => useMarkNoShow(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    });

    await act(async () => {
      await result.current.mutateAsync({ bookingId: BOOKING_ID, idempotencyKey: 'K-first' });
    });

    const items = client.getQueryData<{ items: MerchantBooking[] }>(LIST_KEY)!.items;
    expect(items[0]!.status).toBe('no_show_returned');
    expect(items[1]!.status).toBe('deposit_held');
  });
});
