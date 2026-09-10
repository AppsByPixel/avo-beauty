import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { Booking } from '@avo/types';
import { authedRequest } from '../auth/authedRequest.js';
import { useSalonId } from '../auth/AuthProvider.js';
import type { Paginated } from './salon.js';

/**
 * `GET /salons/{id}/bookings` — `perms.appointments`.
 *
 * THE WIRE SHAPE IS WIDER THAN `BookingSchema`, DELIBERATELY.
 *
 * `packages/types` still has the contract's nine fields. Lane A serves five more
 * that the merchant list cannot be drawn without, and `serialiseBooking` in
 * api/src/services/booking.ts documents why each one is server-computed rather
 * than derived here:
 *
 *   endsAt             — the time range, already computed from durationMin.
 *   noShowReturnDueAt  — WHEN the deposit auto-returns. A client computing
 *                        `startsAt + 1h` is a client deciding when a deposit is
 *                        at risk, which is the balance mistake wearing a hat.
 *   changeableUntil    — the free-change deadline, likewise.
 *   rescheduledCount   — how many times this slot has already moved.
 *   calendarSyncState  — whether the event actually reached the artist's
 *                        calendar. A booking nobody's calendar knows about is
 *                        the one the salon needs to see.
 *
 * Plus the join `perms.appointments` is the gate for: the customer's name, phone
 * and tier, the artist's name, the service's name, and `branchAssumed`.
 *
 * This interface is a hand-written MIRROR, not a shared type. `packages/types` is
 * trunk-owned, and `BookingSchema` is what the wallet and the scanner validate
 * against, so widening it is a trunk change rather than a lane one. Flagged in
 * the lane report: these five belong in `BookingSchema`, and the joined fields
 * belong in a `MerchantBookingSchema` beside it.
 */
export interface MerchantBooking extends Booking {
  endsAt: string;
  noShowReturnDueAt: string;
  changeableUntil: string;
  rescheduledCount: number;
  calendarSyncState: 'not_applicable' | 'pending' | 'synced' | 'failed';
  /**
   * The branch was a guess, not a fact — the same marker a transaction carries.
   * Surfaced rather than hidden so a per-branch count that rests on a guess is
   * distinguishable from one that does not.
   */
  branchAssumed: boolean;
  memberName: string;
  /**
   * NULL WHEN `memberErased`, AND NO ROUTE RENDERS IT TODAY.
   *
   * `Appointments.tsx` shows `memberName` and nothing else from this pair, so
   * the appointments board never shipped the fulfilment board's defect. The type
   * is widened anyway and BEFORE a render site exists, which is the cheap half:
   * the next person who reaches for a `tel:` link here gets `string | null` from
   * the compiler and has to decide about the erased case rather than discover it
   * in production the way the orders board did (DECISIONS.md #100).
   */
  memberPhone: string | null;
  /**
   * TRUE WHEN THE MEMBER HAS BEEN ERASED. Same contract as
   * `api/orders.ts § MerchantShopOrder`, served by `GET /salons/{id}/bookings`;
   * the reasoning for why the signal is the API's and not a client prefix match
   * lives there. Absent from the wire until lane A lands, so it reads `undefined`
   * — falsy, and nothing on this surface branches on it yet.
   */
  memberErased: boolean;
  memberTier: string | null;
  artistName: string;
  serviceName: string;
}

/**
 * The contract's four, in the order the design lists its pills.
 *
 * `cancelled` is the fourth status and the design draws no pill for it — the
 * dashboard mock only ever renders held/done/noshow. It is included here because
 * the API can return it and a row the UI cannot label is worse than a plain one.
 * See STATUS_PILL in routes/Appointments.tsx.
 */
export const BOOKING_STATUSES = [
  'deposit_held',
  'completed',
  'no_show_returned',
  'cancelled',
] as const;

export type BookingStatus = (typeof BOOKING_STATUSES)[number];

export const bookingKeys = {
  all: ['bookings'] as const,
  list: (salonId: string, status: BookingStatus | null) =>
    [...bookingKeys.all, salonId, status ?? 'any'] as const,
};

/**
 * `enabled` is how the Booking-module-off empty avoids a pointless request.
 *
 * A salon with `modules.booking === false` has no bookings by construction, and
 * asking anyway would answer `{ items: [] }` — which is the *other* empty, the
 * one that says "nothing booked yet". Firing the request and then overriding its
 * answer in the component is how the two empties end up sharing a code path and,
 * eventually, sharing copy. `AVO States.dc.html` is explicit that they must not.
 */
export function useSalonBookings(
  status: BookingStatus | null = null,
  enabled = true,
): UseQueryResult<Paginated<MerchantBooking>> {
  const salonId = useSalonId();
  return useQuery({
    queryKey: bookingKeys.list(salonId, status),
    queryFn: ({ signal }) =>
      authedRequest<Paginated<MerchantBooking>>(
        'merchant',
        `/salons/${salonId}/bookings${status ? `?status=${status}` : ''}`,
        { signal },
      ),
    enabled,
    /*
     * INHERITED FROM `defaultOptions` AND RESTATED ANYWAY.
     *
     * `networkMode: 'always'` is why this section can render an error at all.
     * TanStack's default `'online'` *pauses* a fetch rather than failing it, and
     * a paused query sits at `status: 'pending'` / `fetchStatus: 'paused'`
     * forever — which this screen renders as skeleton rows. Caught while driving
     * a real 403: the API refused the request, and Appointments showed six
     * loading rows indefinitely instead of the refusal. main.tsx §networkMode
     * explains the same trap for the Overview.
     *
     * THE `retry` NOTE THAT USED TO SIT HERE HAS MOVED, AND WON. It said a bare
     * `retry: 1` — "copied from the sections that read endpoints with no
     * permission gate" — silently re-enables retrying a 403, and that this hook
     * must therefore stay on the default function. That was right, and it was
     * true of seven other hooks that nobody had checked. The rule now lives in
     * api/retryPolicy.ts as the only `retry` in the dashboard, so there is no
     * longer a wrong pattern here to copy from.
     */
    networkMode: 'always',
  });
}
