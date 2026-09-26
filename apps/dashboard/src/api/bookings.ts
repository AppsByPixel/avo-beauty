import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type UseInfiniteQueryResult,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import type { Booking } from '@avo/types';
import { ApiError } from './client.js';
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
 * See STATUS_PILL in routes/appointmentsWeekRules.ts — it moved out of
 * `Appointments.tsx` when the week grid arrived, so that the list and the grid
 * cannot label one status two ways.
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
  /**
   * The week grid's cursor walk. `'stream'` cannot collide with a `list` key:
   * the third element there is a `BookingStatus` or the literal `'any'`, and the
   * server refuses any other status by name.
   *
   * UNDER `all` ON PURPOSE, so `invalidateQueries({ queryKey: bookingKeys.all })`
   * after a no-show reaches the grid as well as the list. That prefix is also
   * what made `patchBookingStatus` below necessary — see its docblock.
   */
  stream: (salonId: string) => [...bookingKeys.all, salonId, 'stream'] as const,
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

/**
 * ===========================================================================
 * THE SAME ENDPOINT, WALKED. `GET /salons/{id}/bookings?cursor=…`
 * ===========================================================================
 * `useSalonBookings` above reads ONE page and the list it feeds is honestly a
 * list of one page. The week grid cannot be: a page that stops short of a day
 * draws that day as free, and a free Thursday afternoon is a thing a salon
 * ACTS on. `routes/appointmentsWeekRules.ts § THE 200 CAP` has the argument and the
 * proof that a descending walk can be shown to have covered a window.
 *
 * TWO QUERIES ON ONE ENDPOINT RATHER THAN ONE SHARED. The list would be changed
 * by sharing — it would silently grow to whatever the grid had walked, so what
 * "newest 200" means on that screen would depend on which view was opened first.
 * Two cache entries cost one extra request when both views are visited in a
 * session, and buy each view an answer that does not depend on the other.
 *
 * NO `status` PARAMETER, AND THAT IS THE GRID'S REQUIREMENT RATHER THAN AN
 * OMISSION. `booking_artist_slot_no_overlap` excludes `no_show_returned` and
 * `cancelled`, so those are exactly the slots that came BACK — a grid filtered
 * to `deposit_held` would draw a released hour as free without ever saying that
 * something had been there. All four statuses, drawn differently.
 *
 * `networkMode: 'always'` for `useSalonBookings`'s stated reason: TanStack's
 * default PAUSES a fetch offline rather than failing it, and a paused query sits
 * pending forever, which this screen would paint as a permanent skeleton instead
 * of the offline answer `SectionError` is there to give.
 */
export function useSalonBookingStream(
  enabled = true,
): UseInfiniteQueryResult<InfiniteData<Paginated<MerchantBooking>>> {
  const salonId = useSalonId();
  return useInfiniteQuery({
    queryKey: bookingKeys.stream(salonId),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      authedRequest<Paginated<MerchantBooking>>(
        'merchant',
        `/salons/${salonId}/bookings${
          pageParam === null ? '' : `?cursor=${encodeURIComponent(pageParam)}`
        }`,
        { signal },
      ),
    getNextPageParam: (last) => last.nextCursor,
    enabled,
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

/**
 * ===========================================================================
 * TWO OF THESE FOUR WENT NULLABLE UNDER THIS CLIENT, AND NOTHING BROKE — WHICH
 * IS THE PART WORTH WRITING DOWN
 * ===========================================================================
 * Lane A ruled that a no-show is a fact about ATTENDANCE rather than about
 * money, so a hand-written appointment is markable too. On that branch there is
 * no wallet behind the booking: `refundedFils` is 0, and `balanceAfterFils` and
 * `transactionId` are `null` — PRESENT on both branches, never omitted, so a
 * client can tell "no money moved" from "this API is too old to say"
 * (`services/booking.ts § markNoShow`).
 *
 * THIS INTERFACE SAID `number` AND `string` AND THE DASHBOARD DID NOT NOTICE,
 * because `authedRequest<MarkNoShowResult>` is a CAST and not a parse. Nothing
 * threw, nothing rendered wrongly, and the two fields have no render site today
 * — so the break was silent in both directions, which is worse than a loud one
 * and is exactly why the types are widened BEFORE a render site exists. The next
 * person who reaches for `balanceAfterFils` here gets `number | null` from the
 * compiler and has to decide about the moneyless branch, instead of drawing
 * "0.000 KD" over an appointment that never had a deposit.
 *
 * The same shape, for the same reason, on `CancelResult` below. Two endpoints
 * answering differently about the same kind of row would be the worse outcome.
 */
export interface MarkNoShowResult {
  booking: MarkedBooking;
  /** INTEGER FILS — the deposit that went back, 0 where none was held. #1. */
  refundedFils: number;
  /** INTEGER FILS — her wallet after it, or `null` where no wallet was touched. #1. */
  balanceAfterFils: number | null;
  /** `null` where no money moved, so there is no ledger row to name. */
  transactionId: string | null;
}

/**
 * ===========================================================================
 * ONE FIELD, IN WHICHEVER SHAPE THE CACHE ENTRY HAS — AND THE SECOND SHAPE IS
 * A TRAP THIS FUNCTION EXISTS TO HAVE ALREADY SPRUNG
 * ===========================================================================
 * `setQueriesData({ queryKey: bookingKeys.all })` matches BY PREFIX, so it hands
 * its updater every cache entry under `['bookings']`. Until the week grid there
 * was exactly one shape under that prefix — `Paginated<MerchantBooking>` — and
 * the updater was written as `{ ...old, items: old.items.map(…) }`.
 *
 * `useSalonBookingStream` puts a SECOND shape there: an infinite query caches
 * `{ pages, pageParams }` and has no `items` at all. The old updater would have
 * read `old.items.map` off it and thrown a TypeError inside `onSuccess` — on the
 * one path in this section that moves a customer's money, AFTER the server had
 * committed. The mark would have succeeded and the screen would have broken.
 *
 * Found by adding the query, not by the type system: the updater was generic on
 * `Paginated<MerchantBooking>` and `setQueriesData` was perfectly happy to claim
 * that every matching entry had that type. A prefix key is a runtime contract
 * that a type parameter can only assert.
 *
 * THE NARROW PATCH IS UNCHANGED AND IS STILL THE WHOLE DELTA. `status` is the
 * only field taken, for the reason `MarkedBooking` is an `Omit`: the response
 * carries none of the joined fields, so anything wider blanks the customer's
 * name on the one row the merchant is looking at.
 *
 * AN UNRECOGNISED SHAPE IS RETURNED UNTOUCHED rather than replaced with
 * something tidier. A third shape appearing under this prefix should lose an
 * optimistic patch and get the invalidation's refetch a moment later, not have
 * its cache entry overwritten by a guess.
 */
export function patchBookingStatus(
  cached: unknown,
  bookingId: string,
  status: BookingStatus,
): unknown {
  if (cached === null || typeof cached !== 'object') return cached;

  const patchPage = (page: Paginated<MerchantBooking>): Paginated<MerchantBooking> => ({
    ...page,
    items: page.items.map((row) => (row.id === bookingId ? { ...row, status } : row)),
  });

  if ('pages' in cached && Array.isArray((cached as InfiniteData<unknown>).pages)) {
    const infinite = cached as InfiniteData<Paginated<MerchantBooking>>;
    return { ...infinite, pages: infinite.pages.map(patchPage) };
  }

  if ('items' in cached && Array.isArray((cached as Paginated<MerchantBooking>).items)) {
    return patchPage(cached as Paginated<MerchantBooking>);
  }

  return cached;
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
      queryClient.setQueriesData({ queryKey: bookingKeys.all }, (old: unknown) =>
        patchBookingStatus(old, bookingId, data.booking.status),
      );
      void queryClient.invalidateQueries({ queryKey: bookingKeys.all });
    },
  });
}

/* ================================= the five hand-written-appointment writes == */

/**
 * ===========================================================================
 * THE PATH PREFIX, CHECKED RATHER THAN ASSUMED
 * ===========================================================================
 * This API registers about thirty routes under a literal `/v1/…` and about
 * seventy bare, `api/src/app.ts` passes no `prefix` to any `register*Routes`
 * call, and `API_BASE_URL` adds nothing — so the prefix is whatever the route
 * file typed. All five of these are registered bare, in
 * `api/src/routes/bookings.ts`:
 *
 *   app.post('/salons/:id/bookings'
 *   app.post('/salons/:id/bookings/:bookingId/reschedule'
 *   app.post('/salons/:id/bookings/:bookingId/reassign'
 *   app.post('/salons/:id/bookings/:bookingId/cancel'
 *   app.post('/salons/:id/bookings/:bookingId/complete'
 *
 * `useMarkNoShow` above is bare for the same reason and against the same file.
 * A wrong guess is not a compile error and not a visible bug in a mocked test —
 * it is a 404 in production — so `merchantScopeGates.test.ts § resolves every
 * merchant call to a registered route` is what actually holds it: it reads both
 * sides off disk and fails the call that matches no route.
 *
 * ===========================================================================
 * WHAT EACH ONE IS GATED ON, WHICH IS NOT ALL THE SAME PERMISSION
 * ===========================================================================
 *   create, reschedule, reassign, complete   `perms.appointments`
 *   cancel                                   `perms.void`
 *
 * `api/src/routes/bookings.ts § THE PERMISSION IS appointments` argues the
 * split at length, and the seeded account it is about is ST-002 Hessa —
 * frontdesk, `appointments: true`, `void: false`, `dashboard: false`. She is
 * exactly who should be able to write a walk-in down, move a 16:45 and hand it
 * to another artist, and exactly who must not be able to return a deposit.
 *
 * Every one of these is drawn behind a courtesy gate on the screen AND refused
 * independently by the server. #7: the hidden button is the courtesy, the 403 is
 * the control, and the reachable path is a mid-session revocation — `perms` is
 * the snapshot taken at sign-in.
 *
 * ===========================================================================
 * ONLY THE CREATE TAKES AN `Idempotency-Key`, AND THAT IS THE SERVER'S SHAPE
 * ===========================================================================
 * The route header says why in its own words: a POST that succeeds twice makes
 * two appointments, and the exclusion constraint answers the second `slot_taken`
 * — "a confusing and slightly alarming thing to show someone who pressed the
 * button once". With a key the double submit replays the first response and the
 * front desk sees the appointment it just made. The other four name ONE resource
 * with ONE live state and rely on `FOR UPDATE`; a second request re-reads a
 * status that is no longer `deposit_held` and is answered `already_cancelled` /
 * `already_completed` / `not_changeable`, which holds for two DIFFERENT keys as
 * well as for one repeated.
 *
 * SO THE KEY IS NOT MINTED HERE, exactly as `useMarkNoShow` is not. A key minted
 * inside `useMutation` is minted per CALL, so a retry after a failure arrives
 * with a fresh key and loses the replay the header exists for — which is the
 * whole point of the header. `AppointmentForm.tsx § the submission key` mints it
 * where the merchant's intent begins and holds it across retries of that same
 * submission.
 */

/**
 * A booking as the five write endpoints answer with it: `serialiseBooking(row)`
 * — `BookingSchema` plus the five computed fields — and NOT ONE JOINED FIELD.
 *
 * `MarkedBooking` is already exactly that shape, for exactly that reason, and
 * the alias is deliberate rather than a second `Omit`: one definition means the
 * compile error that stops `items.map(row => data.booking)` cannot be true of
 * the no-show response and false of the cancel's. The name says what the shape
 * IS rather than which endpoint produced it.
 */
export type WrittenBooking = MarkedBooking;

/**
 * `POST /salons/{id}/bookings` — the front desk writes one down.
 *
 * EXACTLY ONE OF `memberId` AND `guestName` REACHES THE WIRE, and the route
 * refuses the other two arrangements BY NAME rather than guessing:
 * `identity_required`, "Name an existing customer or a walk-in, not both." The
 * body is therefore built rather than spread — see `createBookingBody`.
 */
export interface CreateBookingInput {
  artistId: string;
  serviceId: string;
  /** An ISO instant. The server parses it and refuses `invalid_starts_at`. */
  startsAt: string;
  /** Set for an existing member; `null` for a walk-in. Never both with `guestName`. */
  memberId: string | null;
  /** Set for a walk-in; `null` for a member. Never both with `memberId`. */
  guestName: string | null;
  /** A walk-in's number, optional even for her. `null` or `''` sends nothing. */
  guestPhone: string | null;
  /** Minted by the form, held across retries of the SAME submission. #4. */
  idempotencyKey: string;
}

/**
 * ===========================================================================
 * THE GUEST FIELDS ARE OMITTED ON A MEMBER BOOKING, NOT SENT AS NULL
 * ===========================================================================
 * The route reads `hasGuest = body.guestName !== undefined && !== null`, so
 * `guestName: null` beside a `memberId` would in fact be accepted today. It is
 * still omitted, for two reasons that outlive today's handler:
 *
 *   `guestPhone` IS NOT MERELY IGNORED on a member booking — it is 400
 *   `guest_phone_without_guest`, "An existing customer's number is on her
 *   account, not on the appointment." A body that carries the guest half at all
 *   is one field away from that refusal.
 *
 *   AND THE REQUEST HASH IS THE IDEMPOTENCY CLAIM. The route hashes
 *   `{ salonId, artistId, serviceId, startsAt, memberId, guestName, guestPhone }`
 *   into the key's claim; a body whose null-vs-absent shape drifts between a
 *   first attempt and its retry is a DIFFERENT request under the same key, which
 *   is 422 rather than the replay. Building the body from one function is what
 *   makes the retry byte-identical.
 *
 * Exported so the rule is assertable without a network.
 */
export function createBookingBody(input: CreateBookingInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    artistId: input.artistId,
    serviceId: input.serviceId,
    startsAt: input.startsAt,
  };

  if (input.memberId !== null) {
    body.memberId = input.memberId;
    return body;
  }

  body.guestName = input.guestName;
  /*
   * ABSENT RATHER THAN EMPTY. The route only reaches `parseE164` when the key is
   * present, not null and not `''` — so sending `''` is harmless, and sending
   * nothing is the shape that cannot become harmful when that guard moves.
   */
  if (input.guestPhone !== null && input.guestPhone !== '') {
    body.guestPhone = input.guestPhone;
  }
  return body;
}

/**
 * `slot_taken` — 409, from the create, the reschedule and the reassign.
 *
 * THE CONSTRAINT SPANS BOTH KINDS OF APPOINTMENT, deliberately: a hand-written
 * booking lives in the same `booking` table as an app one so that
 * `booking_artist_slot_no_overlap` can see both. So this is not a rare race — it
 * is the ordinary answer when a customer took that hour from her phone while the
 * front desk was typing, and it is RECOVERABLE: pick another time, or another
 * artist, and the same submission goes through.
 *
 * A REFUSAL A MERCHANT CAN ACT ON IS NOT THE SAME OBJECT AS AN ERROR, which is
 * why this is a predicate and not a message. The server's sentence — "That
 * artist already has an appointment then." — is a correct statement of fact and
 * says nothing about what to do next; the screen adds that half, and it differs
 * by control (a reassign's way out is a different artist, a reschedule's is a
 * different time).
 */
export function isSlotTaken(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409 && error.code === 'slot_taken';
}

export function useCreateBooking(): UseMutationResult<
  { booking: WrittenBooking },
  unknown,
  CreateBookingInput
> {
  const salonId = useSalonId();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input) =>
      authedRequest<{ booking: WrittenBooking }>('merchant', `/salons/${salonId}/bookings`, {
        method: 'POST',
        body: createBookingBody(input),
        idempotencyKey: input.idempotencyKey,
      }),
    /*
     * INVALIDATE, AND DO NOT PATCH. Every other write here changes a row the
     * cache already holds; this one makes a row it does not. The response is
     * `serialiseBooking` and carries no `memberName`, no `serviceName` and no
     * `artistName`, so an optimistic insert would put a row with three blank
     * columns at the top of the board — and `GET /salons/{id}/bookings` is
     * `starts_at DESC`, so it would not even be the row's real position.
     */
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: bookingKeys.all });
    },
  });
}

/**
 * `POST /salons/{id}/bookings/{bookingId}/reschedule` — move the date and time.
 *
 * `depositCarriedFils` IS INTEGER FILS AND IS NOT A REFUND. #1 and #5 both. A
 * reschedule CARRIES a hold rather than spending or returning it: the same money
 * still sits against the same row at a new hour, so the service writes a `rules`
 * audit row rather than a `money` one. On a hand-written booking it is 0,
 * because nothing was ever held.
 */
export interface RescheduleResult {
  booking: WrittenBooking;
  /** INTEGER FILS — the hold that moved with the appointment. #1. */
  depositCarriedFils: number;
}

export function useRescheduleBooking(): UseMutationResult<
  RescheduleResult,
  unknown,
  { bookingId: string; startsAt: string }
> {
  const salonId = useSalonId();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ bookingId, startsAt }) =>
      authedRequest<RescheduleResult>(
        'merchant',
        `/salons/${salonId}/bookings/${bookingId}/reschedule`,
        { method: 'POST', body: { startsAt } },
      ),
    /*
     * ===================================================================
     * NO OPTIMISTIC PATCH ON THIS ONE, AND THE OMISSION IS THE DECISION
     * ===================================================================
     * `patchBookingStatus` exists because a marked row must stop offering the
     * link it has just used, and `status` is the whole delta of a no-show. It is
     * NOT the delta here: a reschedule changes `startsAt`, `endsAt`,
     * `noShowReturnDueAt`, `changeableUntil` and `rescheduledCount`, and the
     * status does not move at all.
     *
     * A wider patch is available and is the wrong thing. The row would then read
     * the new hour immediately — and on the WEEK GRID that means the chip jumps
     * to a column computed from a response the server has not yet reconciled
     * against `booking_artist_slot_no_overlap` for any other row. The refetch is
     * one round trip and is the server's answer about the whole board, which is
     * what a slot move actually changes.
     */
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: bookingKeys.all });
    },
  });
}

/**
 * `POST /salons/{id}/bookings/{bookingId}/reassign` — hand it to another artist.
 *
 * THE BRANCH MOVES WITH THE ARTIST — `services/booking.ts § reassignArtist`:
 * reassigning to an artist at Salmiya makes it a Salmiya appointment, because a
 * booking's branch is a fact about who performs it. So `branchId` and
 * `branchAssumed` change too, and `artistName` — a JOINED field the response
 * does not carry — is the one a merchant is looking at. Invalidation only, for
 * `useRescheduleBooking`'s reason and more sharply: a patch here could only
 * write the id and would leave the OLD artist's name drawn beside it.
 */
export function useReassignArtist(): UseMutationResult<
  { booking: WrittenBooking },
  unknown,
  { bookingId: string; artistId: string }
> {
  const salonId = useSalonId();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ bookingId, artistId }) =>
      authedRequest<{ booking: WrittenBooking }>(
        'merchant',
        `/salons/${salonId}/bookings/${bookingId}/reassign`,
        { method: 'POST', body: { artistId } },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: bookingKeys.all });
    },
  });
}

/**
 * `POST /salons/{id}/bookings/{bookingId}/cancel` — `perms.void`.
 *
 * THE THREE MONEY FIELDS ARE NULLABLE AND THAT IS THE WHOLE ZERO-DEPOSIT STORY
 * IN A TYPE. Cancelling an APP booking returns a real deposit to a real wallet;
 * cancelling a hand-written one returns nothing, because nothing was taken —
 * `refundedFils` is 0 and there is no transaction and no balance to report. The
 * gate does NOT vary by amount (`api/src/routes/bookings.ts § CANCEL IS void`):
 * a conditional gate has no single permission to grant and would break
 * `e2e/permission-census.test.ts`'s granted mirror.
 */
export interface CancelResult {
  booking: WrittenBooking;
  /** INTEGER FILS — 0 on a booking that never held one. #1. */
  refundedFils: number;
  /** INTEGER FILS, or `null` where no wallet was touched. #1. */
  balanceAfterFils: number | null;
  /** `null` where no money moved, so there is no ledger row to name. */
  transactionId: string | null;
}

export function useCancelBooking(): UseMutationResult<
  CancelResult,
  unknown,
  { bookingId: string }
> {
  const salonId = useSalonId();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ bookingId }) =>
      authedRequest<CancelResult>('merchant', `/salons/${salonId}/bookings/${bookingId}/cancel`, {
        method: 'POST',
      }),
    /*
     * PATCHED THEN INVALIDATED, exactly as the no-show is, and for its reason:
     * `status` IS the whole delta a client can safely draw, and a row still
     * reading `deposit_held` still offers Cancel, Reassign and Mark — every one
     * of which is now a 409. The invalidation follows because the delta is not
     * confined to this row: `booking_artist_slot_no_overlap` excludes
     * `cancelled`, so the artist is free at that hour the moment this commits.
     */
    onSuccess: (data, { bookingId }) => {
      queryClient.setQueriesData({ queryKey: bookingKeys.all }, (old: unknown) =>
        patchBookingStatus(old, bookingId, data.booking.status),
      );
      void queryClient.invalidateQueries({ queryKey: bookingKeys.all });
    },
  });
}

/**
 * `POST /salons/{id}/bookings/{bookingId}/complete` — ZERO-DEPOSIT ONLY.
 *
 * THE RESTRICTION IS THE SERVER'S AND IT IS NOT A LIMITATION. Completing a
 * deposit-bearing booking has to name the charge that CONSUMED the hold, and
 * that happens at the scanner through `POST /charges` — `completed` is written
 * in exactly one place in the whole API, inside the charge transaction. A second
 * path to the status would mark an appointment done without the bill that made
 * it done. The endpoint refuses one with 409 `deposit_completed_at_the_counter`
 * and a sentence that names the remedy; the screen hides the control on those
 * rows as a courtesy and renders that sentence when it is reached anyway (#7).
 */
export function useCompleteBooking(): UseMutationResult<
  { booking: WrittenBooking },
  unknown,
  { bookingId: string }
> {
  const salonId = useSalonId();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ bookingId }) =>
      authedRequest<{ booking: WrittenBooking }>(
        'merchant',
        `/salons/${salonId}/bookings/${bookingId}/complete`,
        { method: 'POST' },
      ),
    onSuccess: (data, { bookingId }) => {
      queryClient.setQueriesData({ queryKey: bookingKeys.all }, (old: unknown) =>
        patchBookingStatus(old, bookingId, data.booking.status),
      );
      void queryClient.invalidateQueries({ queryKey: bookingKeys.all });
    },
  });
}
