import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
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
 *
 * ---------------------------------------------------------------------------
 * HALF OF THAT HAS SINCE HAPPENED, AND THE BLOCK ABOVE DOES NOT KNOW IT.
 * ---------------------------------------------------------------------------
 * `BookingSchema` (entities.ts:428) now declares ALL FIVE — `endsAt`,
 * `changeableUntil`, `noShowReturnDueAt`, `rescheduledCount`,
 * `calendarSyncState` — so the five lines below are redeclarations of fields
 * `Booking` already has, and they narrow nothing. Harmless, and left in place
 * rather than deleted in a slice that is about something else; the point of
 * writing it down is that the paragraph above reads as a live request and is
 * not one. The JOINED half is still outstanding: there is no
 * `MerchantBookingSchema`, and the seven fields under it are still this file's.
 *
 * Checked, not assumed — the standing lesson about an absence claim: it is the
 * one kind of comment that cannot be verified by rereading the file it sits in,
 * and this one expired without anything noticing.
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

/* ======================================================= mark a no-show == */

/**
 * `POST /salons/{id}/bookings/{bookingId}/no-show` — `perms.void`, NOT
 * `perms.appointments`.
 *
 * =========================================================================
 * THE WRITE'S GATE IS NOT THE BOARD'S GATE, AND THE SEED PROVES WHY
 * =========================================================================
 * The list next door is `requireDashboardPerm(req, 'appointments')`. This is
 * `requireDashboardPerm(req, 'void')` (api/src/routes/bookings.ts § the gate),
 * and the two are deliberately different authorities rather than an oversight:
 * `perms.appointments` is a READ gate, and hanging a money-moving write off it
 * would silently widen what every existing holder can do.
 *
 * `db/seed.ts § ST-002` is that holder. Hessa, frontdesk, `appointments: true`
 * with `void: false` AND `dashboard: false` — so under the board's own gate she
 * could return a customer's deposit and stamp a no-show against a named person
 * while unable to open the dashboard at all.
 *
 * WHICH IS WHY THIS SCREEN CARRIES A COURTESY GATE AND THE LEDGER ROW MOVED.
 * `routes/sectionState.tsx § THE COURTESY-GATE LEDGER` had Appointments in the
 * "none needed" column, correctly, for as long as the section was read-only: a
 * permission-gated read answers its own 403 and `SectionError` explains it. A
 * write on a DIFFERENT permission from the read breaks that equivalence — the
 * read succeeding says nothing about the write, so nothing would refuse the link
 * until Hessa had already clicked it. #7 is intact either way: the link is a
 * courtesy and the 403 is the control, and `Appointments.tsx` renders that 403
 * rather than assuming it is unreachable.
 *
 * =========================================================================
 * `MarkedBooking` IS DELIBERATELY NOT A `MerchantBooking`
 * =========================================================================
 * The 200 body's `booking` is `serialiseBooking(row)` — `BookingSchema` plus the
 * same five computed fields the list carries — and NONE of the join fields the
 * board draws: no `memberName`, no `serviceName`, no `artistName`, no
 * `branchAssumed`. That is correct of the endpoint (the join is what
 * `perms.appointments` gates, and this route does not check it) and it is a trap
 * for the client: `setQueryData(..., data.booking)` would blank the customer's
 * name, the service and the artist on the row that just changed — the one row a
 * merchant is looking at.
 *
 * So the type says so — and the guard is narrower than it first reads, which was
 * worth measuring rather than asserting. `Omit`ting the seven joined fields makes
 * USING THE RESPONSE AS THE ROW a compile error:
 *
 *     items.map((row) => (row.id === bookingId ? data.booking : row))
 *     → TS2345 … Type 'MarkedBooking' is missing the following properties from
 *       type 'MerchantBooking': branchAssumed, memberName, memberPhone,
 *       memberErased, and 3 more.
 *
 * It does NOT catch `{ ...row, ...data.booking }`, and that is correct of
 * TypeScript rather than a hole: spreading a narrower object over a wider one
 * still has every property, and at runtime the response carries no joined KEY to
 * overwrite `memberName` with, so today that spread is behaviour-identical to the
 * one-field patch below. It is still not what this does, for the reason the
 * narrow patch is written the way it is: the day the endpoint adds a field, a
 * blanket spread adopts it unread. The type stops the loud mistake; the patch
 * below is the quiet half, and `api/noShowMark.test.tsx` is what holds it.
 *
 * =========================================================================
 * THE IDEMPOTENCY KEY IS THE CALLER'S, AND IT IS NOT MINTED HERE
 * =========================================================================
 * Non-negotiable #4. The key is REQUIRED — 400 `idempotency_key_required`
 * without one — and the server hashes `{ salonId, bookingId }` into the claim, so
 * one key names one booking and reusing it on a second is 422
 * `idempotency_key_reused`.
 *
 * Minting it inside this hook would put it on the wrong side of the decision:
 * `useMutation` would mint per CALL, so a retry after a failure would arrive with
 * a fresh key and lose the replay. `Appointments.tsx § the armed row` mints it
 * where the merchant's intent begins, which is the same place
 * `console/Salons.tsx` mints the onboarding wizard's.
 */
export type MarkedBooking = Omit<
  MerchantBooking,
  | 'branchAssumed'
  | 'memberName'
  | 'memberPhone'
  | 'memberErased'
  | 'memberTier'
  | 'artistName'
  | 'serviceName'
>;

export interface MarkNoShowResult {
  booking: MarkedBooking;
  /** INTEGER FILS — the deposit that went back. #1. */
  refundedFils: number;
  /** INTEGER FILS — her wallet after it. #1. */
  balanceAfterFils: number;
  transactionId: string;
}

export function useMarkNoShow(): UseMutationResult<
  MarkNoShowResult,
  unknown,
  { bookingId: string; idempotencyKey: string }
> {
  const salonId = useSalonId();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ bookingId, idempotencyKey }) =>
      authedRequest<MarkNoShowResult>(
        'merchant',
        `/salons/${salonId}/bookings/${bookingId}/no-show`,
        { method: 'POST', idempotencyKey },
      ),
    /**
     * ONE FIELD PATCHED, THEN INVALIDATED — and both halves are load-bearing.
     *
     * THE PATCH exists because of the trap the type above describes from the
     * other side. An invalidation alone leaves a window — however short — in
     * which the row still reads `deposit_held`, still draws "Returns … if
     * missed", and still offers the link that has just been used. That is the
     * stale-row-still-offering-the-link failure, and a refetch does not close it,
     * it only shortens it.
     *
     * `status` IS THE ONLY FIELD TAKEN, and taking more would be the defect the
     * type refuses: `data.booking` has no `memberName`, so spreading it over the
     * row blanks the customer. Everything else on the row is unchanged by a
     * no-show anyway — the deposit is the same integer, the slot is the same
     * slot — so one field is not a shortcut, it is the whole delta.
     *
     * THE INVALIDATION exists because the delta is not confined to this row.
     * `booking_artist_slot_no_overlap` excludes `no_show_returned`, so the artist
     * is free at that hour the moment this commits and a customer can book it
     * from the wallet seconds later. The list is the server's answer to "what is
     * on the board", and after a write that releases a slot it has to be asked
     * again rather than reasoned about here.
     */
    onSuccess: (data, { bookingId }) => {
      queryClient.setQueriesData<Paginated<MerchantBooking>>(
        { queryKey: bookingKeys.all },
        (old) =>
          old
            ? {
                ...old,
                items: old.items.map((row) =>
                  row.id === bookingId ? { ...row, status: data.booking.status } : row,
                ),
              }
            : old,
      );
      void queryClient.invalidateQueries({ queryKey: bookingKeys.all });
    },
  });
}
