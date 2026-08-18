/**
 * The endpoints the Book flow reads and writes.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE SHAPES THIS FILE USED TO DECLARE, AND WHY IT NO LONGER DOES
 * ═══════════════════════════════════════════════════════════════════════════
 * `@avo/types` is the contract and this app adds nothing to it. For a while
 * booking was the exception: the contract and the API had drifted, and a zod
 * object STRIPS unknown keys rather than complaining, so parsing the real
 * responses with the trunk schemas silently deleted fields the design cannot be
 * drawn without — quietly, at runtime, in a way no typecheck catches.
 *
 * Both drifts are closed on trunk now:
 *
 * 1. `BookingSchema` had nine fields against fourteen serialised. It has all
 *    fourteen, `changeableUntil` included — the entire one-hour rule, and the
 *    difference between the server owning when a deposit is at risk and the
 *    client computing `startsAt − 1h` for itself.
 *
 * 2. `AvailabilitySlotSchema` was `{ time, available, reason? }` against a wire
 *    of `{ startsAt, endsAt, local, available, reason? }`, and
 *    `AvailabilityDaySchema` declared four of nine envelope fields. Both now
 *    match, `open` and `subtracted` included.
 *
 * So the local copies are DELETED rather than kept in sync. The type names
 * survive as aliases because the call sites read fine as they are; the point
 * was never the name, it was that there is one schema again.
 *
 * The plan this file recorded — extend trunk so a widened base makes the
 * duplicate "a compile error rather than a second opinion" — would not have
 * worked. `.extend()` overriding a key the base has since grown is silent. Only
 * removing the local declaration collapses the two.
 *
 * WHAT IS STILL DECLARED HERE, and why each one is not a shape:
 *   `CreateBookingResultSchema`, `CancelBookingResultSchema`,
 *   `RescheduleResultSchema` — response ENVELOPES the contract describes in
 *   prose, each built out of shared schemas rather than restating a field.
 *   `ServiceSchema` — a narrowed local copy, and the one genuine remaining
 *   drift. See its note below.
 */

import { z } from 'zod';
import {
  ArtistSchema,
  AvailabilityDaySchema,
  BookingSchema,
  ServiceSchema,
  TransactionSchema,
  paginated,
} from '@avo/types';
import type { Artist, AvailabilityDay, AvailabilitySlot, Booking, Service } from '@avo/types';
import { deleteJson, getJson, postJson } from './client';

// ------------------------------------------------------------------ booking --

/**
 * The wire shape of a booking — now just `BookingSchema`, which carries all
 * five of the fields this file used to add back.
 *
 * `changeableUntil` is the deadline the server enforces and the sentence the
 * Upcoming card states inline; `endsAt` is the server's own arithmetic rather
 * than `startsAt + durationMin` re-done here. Both are in the trunk schema now.
 *
 * The alias stays so call sites keep reading `BookingView` — what matters is
 * that there is one schema again, not the name. `.extend()` does NOT error when
 * the base grows the same key: it silently overrides, so the "duplicate field
 * becomes a compile error" this file was counting on would never have fired.
 * Deleting the extension is the only thing that actually collapses the two.
 */
export const BookingViewSchema = BookingSchema;

export type BookingView = Booking;

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

/**
 * Both of these are trunk's now, and the local copies are gone.
 *
 * `AvailabilitySlotSchema` was `{ time, available, reason? }` when this file was
 * written and the API sends `{ startsAt, endsAt, local, available, reason? }`;
 * `AvailabilityDaySchema` declared four of the nine served fields and zod
 * stripped the other five, `open` among them. Both have been widened to the
 * wire, so restating them here is now the drift rather than the guard against
 * it — a second definition that no longer disagrees is just a second place to
 * forget to update.
 *
 * What the trunk schema is careful about, and this copy was not:
 *
 *   `reason` is OPTIONAL, not nullable. The server omits the key on an
 *   available slot. A `.nullable()` that is not `.optional()` makes every
 *   bookable slot fail `.parse()` — the whole grid — and it hides on today's
 *   date, where every slot is already past and therefore carries a reason.
 *
 *   `SubtractedBlock.from`/`to` are salon-local WALL CLOCK, "10:00", not
 *   instants. Typed as instants they throw on any day with a booking, and pass
 *   on any day without one.
 *
 * The two design facts this file used to carry the comments for are unchanged
 * and both still hold: `local` ("16:45", salon zone) is rendered as-is and
 * never reformatted from `startsAt`, or a customer in London reads her Kuwait
 * appointment as 07:00 and believes it; and `available: false` slots are
 * RENDERED struck through, never dropped, because a missing 16:45 reads as a
 * salon that does not work then and a struck-through one reads as a slot
 * somebody took.
 *
 * `hoursSource` is the difference between "Live availability" and "Availability
 * by salon hours" on the artist row: `salon_hours` means her own window was not
 * trusted and she is being offered on the salon's, which over-offers.
 */
export type AvailabilitySlotWire = AvailabilitySlot;
export type Availability = AvailabilityDay;

// ---------------------------------------------------------------- services --

/**
 * `GET /salons/{id}/services` — trunk's `ServiceSchema`, local copy deleted.
 *
 * `nameAr` LANDED, and it was the bigger of the two reported gaps. The Book
 * flow's service list is the most Arabic-heavy screen in the wallet and every
 * row of it was rendering a Latin name, because `Salon`, `Branch` and `Artist`
 * all carried `nameAr` and `Service` alone did not. Lane A added the column and
 * the list serves it; the fallback is `nameAr ?? name`, and the seed leaves
 * SV-05 NULL on purpose so the null path is a real one rather than a branch
 * nothing reaches.
 *
 * `active` comes with it. The list already filters to active rows server-side,
 * so this is belt and braces rather than a second opinion — but a retired
 * service in a basket is a 409 from the charge handler, and the field being
 * present is what would let this screen say so instead of guessing.
 *
 * `durationMin` IS STILL ABSENT AND STILL NOT A GAP. The design shows "45 min"
 * under each service (AVO Wallet Home.dc.html:1470-1475); the API has no such
 * field because a booking's duration is the ARTIST's `slotMinutes`, decided at
 * step 3, not the service's. The duration is therefore shown where the server
 * actually decides it — the slot grid and the review — and the service rows
 * carry the price alone. A design/contract disagreement, reported, not papered
 * over with an invented per-service minute.
 *
 * ⚠️ `packages/mock`'s services fixture (fixtures.ts:257) serves only
 * `{id, name, priceFils}` — no `salonId`, `nameAr` or `active` — so this parse
 * fails against the mock. REPORTED TO TRUNK, not worked around: `packages/mock`
 * is trunk-owned (CLAUDE.md § one writer per package), and narrowing the client
 * back to the mock's shape would re-open the Arabic gap to keep a fixture
 * happy. The Book flow is driven against the real API regardless — the mock
 * implements neither `/bookings` nor `/artists/{id}/availability`.
 */
export type BookableService = Service;

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
    AvailabilityDaySchema,
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
