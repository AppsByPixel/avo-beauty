/**
 * The endpoints the Book flow reads and writes.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS FILE DECLARES SHAPES WHEN api/wallet.ts DECLARES NONE
 * ═══════════════════════════════════════════════════════════════════════════
 * `@avo/types` is the contract and this app adds nothing to it — except that
 * for booking the contract and the API have drifted, and a zod object STRIPS
 * unknown keys rather than complaining about them. Parsing the real responses
 * with the trunk schemas would silently delete the fields the design cannot be
 * drawn without, and it would do it quietly, at runtime, in a way no typecheck
 * catches.
 *
 * Two drifts, both reported to trunk, neither fixable from this lane
 * (`packages/types` is trunk-owned — CLAUDE.md § one writer per package):
 *
 * 1. `BookingSchema` has nine fields. The API serialises fourteen
 *    (api/src/services/booking.ts § serialiseBooking) and names the extra five
 *    as "fields that are not in it and that the screens cannot be drawn
 *    without". `changeableUntil` is one of them, and it is the entire one-hour
 *    rule: without it the client would compute `startsAt − 1h` for itself,
 *    which is a client deciding when its own deposit is at risk.
 *
 * 2. `AvailabilitySlotSchema` is `{ time, available, reason? }`. The API
 *    returns `{ startsAt, endsAt, local, available, reason? }` inside an
 *    envelope carrying `timezone`, `slotMinutes`, `open`, `subtracted`,
 *    `hoursSource` and `fallbackReason`. `local` and `time` are not the same
 *    field, and `hoursSource` is the difference between "Live availability" and
 *    "Availability by salon hours" on the artist row.
 *
 * So the trunk schemas are EXTENDED where they exist, and the envelope is
 * declared here. Extending rather than restating means the day trunk widens
 * `BookingSchema`, the duplicate field here becomes a compile error rather than
 * a second opinion.
 */

import { z } from 'zod';
import { ArtistSchema, BookingSchema, TransactionSchema, paginated } from '@avo/types';
import type { Artist } from '@avo/types';
import { deleteJson, getJson, postJson } from './client';

// ------------------------------------------------------------------ booking --

/**
 * The wire shape of a booking, as the API actually sends it.
 *
 * `changeableUntil` is the deadline the server enforces and the sentence the
 * Upcoming card states inline. `endsAt` is the server's own arithmetic rather
 * than `startsAt + durationMin` re-done here.
 */
export const BookingViewSchema = BookingSchema.extend({
  endsAt: z.string().datetime(),
  noShowReturnDueAt: z.string().datetime(),
  changeableUntil: z.string().datetime(),
  rescheduledCount: z.number().int().nonnegative(),
  calendarSyncState: z.enum(['not_applicable', 'pending', 'synced', 'failed']),
});

export type BookingView = z.infer<typeof BookingViewSchema>;

/** `POST /bookings` — the booking, the new balance, and the deposit's ledger row. */
const CreateBookingResultSchema = z.object({
  booking: BookingViewSchema,
  balanceAfterFils: z.number().int().nonnegative(),
  transaction: TransactionSchema,
});

export type CreateBookingResult = z.infer<typeof CreateBookingResultSchema>;

/** `DELETE /bookings/{id}` — the deposit comes back. Non-negotiable #5. */
const CancelBookingResultSchema = z.object({
  booking: BookingViewSchema,
  refundedFils: z.number().int().nonnegative(),
  balanceAfterFils: z.number().int().nonnegative(),
});

export type CancelBookingResult = z.infer<typeof CancelBookingResultSchema>;

/** `POST /bookings/{id}/reschedule` — the deposit carries; no money moves. */
const RescheduleResultSchema = z.object({ booking: BookingViewSchema });

const BookingPageSchema = paginated(BookingViewSchema);

// ------------------------------------------------------------- availability --

export const AvailabilityReasonSchema = z.enum(['busy', 'booked', 'closed']);

/**
 * One slot on the grid.
 *
 * `local` — "16:45" in the SALON's zone — is rendered as-is and never
 * reformatted from `startsAt`. api/src/routes/artists.ts is explicit about the
 * failure that would cause: a customer in London would see her Kuwait
 * appointment at 07:00 and believe it.
 *
 * `available: false` slots are RENDERED, struck through, never dropped. That is
 * the contract's instruction and it is the point of the endpoint returning them
 * at all — a missing 16:45 reads as a salon that does not work at 16:45, and a
 * struck-through one reads as a slot somebody took.
 */
export const AvailabilitySlotWireSchema = z.object({
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
  local: z.string(),
  available: z.boolean(),
  reason: AvailabilityReasonSchema.optional(),
});

export type AvailabilitySlotWire = z.infer<typeof AvailabilitySlotWireSchema>;

export const AvailabilitySchema = z.object({
  artistId: z.string(),
  date: z.string(),
  /** IANA zone. The grid's labels are already in it; this is for the record. */
  timezone: z.string(),
  slotMinutes: z.number().int().positive(),
  /** False on a day the artist does not work. An EMPTY DAY, not a blank grid. */
  open: z.boolean(),
  slots: z.array(AvailabilitySlotWireSchema),
  subtracted: z.array(
    z.object({
      from: z.string(),
      to: z.string(),
      reason: z.enum(['busy', 'booked']),
      bookingId: z.string().optional(),
    }),
  ),
  /**
   * WHERE THE HOURS CAME FROM, and the reason the artist row can say "Live
   * availability" honestly.
   *
   * `artist_windows` on a google-sourced artist means her calendar was actually
   * read. `salon_hours` means it could not be, and she is being offered on the
   * salon's own hours instead — which over-offers rather than under-offers, and
   * is a thing the customer is entitled to know before she picks a time.
   */
  hoursSource: z.enum(['artist_windows', 'salon_hours']),
  fallbackReason: z.enum(['calendar_not_connected', 'calendar_unavailable']).nullable(),
});

export type Availability = z.infer<typeof AvailabilitySchema>;

// ---------------------------------------------------------------- services --

/**
 * `GET /salons/{id}/services`.
 *
 * TWO FIELDS THE DESIGN NEEDS AND THIS DOES NOT CARRY, both reported:
 *
 *   nameAr      the Book flow's service list is the most Arabic-heavy screen in
 *               the wallet and every row of it renders a Latin name. `Salon`,
 *               `Branch` and `Artist` all have `nameAr`; `Service` does not,
 *               and the house pattern in the live AvoRewards app is that
 *               backend entities carry one (PRIOR-ART.md).
 *   durationMin the design shows "45 min" under each service
 *               (AVO Wallet Home.dc.html:1470-1475). The API has no such field:
 *               a booking's duration is the ARTIST's `slotMinutes`, decided at
 *               step 3, not the service's. So the duration is shown where the
 *               server actually decides it — on the slot grid and the review —
 *               and the service rows carry the price alone. That is a design/
 *               contract disagreement rather than a gap, and it is reported
 *               rather than papered over with an invented per-service minute.
 */
const ServiceSchema = z.object({
  id: z.string(),
  name: z.string(),
  priceFils: z.number().int().positive(),
});

export type BookableService = z.infer<typeof ServiceSchema>;

const ServicePageSchema = paginated(ServiceSchema);
const ArtistPageSchema = paginated(ArtistSchema);

// ------------------------------------------------------------------- calls --

export function getServices(salonId: string, signal?: AbortSignal): Promise<BookableService[]> {
  return getJson(`/salons/${encodeURIComponent(salonId)}/services`, ServicePageSchema, signal).then(
    (page) => page.items,
  );
}

/**
 * The bookable roster.
 *
 * ⚠️ THIS ENDPOINT IS GATED ON `perms.team` AND A CUSTOMER DOES NOT HAVE IT.
 *
 * `GET /salons/{id}/artists` is the merchant's Team screen
 * (api/src/routes/artists.ts: "perms.team. The roster of bookable people and
 * their hours is the Merchant → Team screen"), and api-contract.md § Operations
 * gives the customer only `GET /artists/{id}/availability` — availability for
 * an artist she is assumed to already have. There is no customer-scoped list.
 *
 * A real member session therefore gets a 403 here. It resolves today only
 * because the API's `AVO_TEST_PRINCIPALS` shim answers non-member routes with a
 * seeded staff row, which is a harness affordance and not a permission.
 *
 * REPORTED, NOT WORKED AROUND. The alternatives were both worse: hard-coding a
 * roster puts names in front of a customer that no server vouched for, and
 * skipping the artist step deletes a step the design specifies. So the call is
 * written against the endpoint that should exist, and the failure is surfaced
 * as a real error state rather than hidden behind a fallback.
 */
export function getArtists(salonId: string, signal?: AbortSignal): Promise<Artist[]> {
  return getJson(`/salons/${encodeURIComponent(salonId)}/artists`, ArtistPageSchema, signal).then(
    (page) => page.items,
  );
}

/**
 * The grid for one artist on one calendar date.
 *
 * `date` is a SALON-LOCAL calendar date ("2026-08-18"), never an instant and
 * never derived from the device clock — see domain/booking.ts § salonToday.
 */
export function getAvailability(
  artistId: string,
  date: string,
  signal?: AbortSignal,
): Promise<Availability> {
  return getJson(
    `/artists/${encodeURIComponent(artistId)}/availability?date=${encodeURIComponent(date)}`,
    AvailabilitySchema,
    signal,
  );
}

/**
 * Hold the deposit and take the slot.
 *
 * The key is positional — non-negotiable #4. `startsAt` is the SERVER's own
 * `startsAt` from the slot, copied verbatim; the client never composes an
 * instant, because the server re-validates it against the same grid and a
 * client-composed one would differ by a zone the customer never chose.
 *
 * NEITHER `branchId` NOR `depositFils` IS SENT, and the API refuses both by
 * name if they are: a client naming its own branch chooses its own reporting
 * bucket, and a client naming its own deposit books for 0.001 KD.
 */
export function createBooking(
  input: { artistId: string; serviceId: string; startsAt: string },
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<CreateBookingResult> {
  return postJson('/bookings', input, CreateBookingResultSchema, idempotencyKey, signal);
}

/** Her own appointments. `status` filters; the Upcoming card asks for held ones. */
export function getBookings(
  status: BookingView['status'] | undefined,
  signal?: AbortSignal,
): Promise<BookingView[]> {
  const query = status ? `?status=${encodeURIComponent(status)}` : '';
  return getJson(`/bookings${query}`, BookingPageSchema, signal).then((page) => page.items);
}

/** Cancel. The deposit returns to the wallet as credit — never cash. */
export function cancelBooking(id: string, signal?: AbortSignal): Promise<CancelBookingResult> {
  return deleteJson(`/bookings/${encodeURIComponent(id)}`, CancelBookingResultSchema, signal);
}

/**
 * Move the slot. The deposit carries, so no money moves and no key is required
 * — but one is sent anyway, because a double-tapped "Confirm" on a flaky
 * connection would otherwise re-validate and re-write the same row twice.
 */
export function rescheduleBooking(
  id: string,
  startsAt: string,
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<BookingView> {
  return postJson(
    `/bookings/${encodeURIComponent(id)}/reschedule`,
    { startsAt },
    RescheduleResultSchema,
    idempotencyKey,
    signal,
  ).then((r) => r.booking);
}
