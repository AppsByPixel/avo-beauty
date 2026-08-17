/**
 * The artist's own bookings and her own hours.
 *
 *   GET /artists/me/bookings        her day, with the client's name and phone
 *   PUT /artists/me/availability    her week
 *
 * Both are scanner-scoped and need no permission, which is the point: an
 * artist should not need the merchant's `perms.appointments` to see who is
 * coming to see her, or `perms.team` to set the hours she works.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THERE IS NO WAY TO *READ* HER OWN ARTIST ROW, AND THAT IS A REAL GAP
 * ═══════════════════════════════════════════════════════════════════════════
 * `PUT /artists/me/availability` writes the week. Nothing reads it:
 *
 *   GET /artists/me                 does not exist
 *   GET /artists/me/availability    falls through to `/artists/:id` with
 *                                   id="me" and answers 404 unknown_artist
 *   GET /salons/{id}/artists        exists, and is gated on `perms.team` —
 *                                   which the seeded artist account (ST-002,
 *                                   Hessa) deliberately does not have, because
 *                                   she is the fixture proving own-hours needs
 *                                   no team authority
 *
 * So the screen cannot draw her current week on open. `api/` is lane A's
 * column and this lane does not write there, so it is REPORTED rather than
 * patched: `GET /artists/me` returning the same `serialiseArtist` shape the
 * PUT already returns would close it in one route.
 *
 * WHAT THE SCREEN DOES INSTEAD, AND WHY IT IS NOT A WORKAROUND. The design's
 * own first control on My schedule is the source toggle. Tapping it is a PUT,
 * and `applyAvailability` returns the full artist row — so choosing a source
 * both performs the action the artist intended and yields her real week. When
 * she is already on that source the API returns BEFORE opening a transaction
 * (`if (changed.length === 0) return serialiseArtist(target)`), so it writes
 * nothing and audits nothing.
 *
 * What is NOT done, and was considered: probing with a speculative
 * `{ availabilitySource: 'manual' }` on mount to discover the week. That is a
 * write dressed as a read, and it silently switches a Google-synced artist off
 * her calendar the first time she opens the screen.
 */

import { z } from 'zod';
import { ArtistSchema, BookingSchema, paginated } from '@avo/types';
import { getJson, putJson } from './client';

// ------------------------------------------------------------ her bookings --

/**
 * `GET /artists/me/bookings`.
 *
 * The API joins the customer's name, phone and tier onto each row — a real
 * disclosure, bounded to her own bookings by construction, because there is no
 * id in this URL to point at somebody else's.
 */
export const ArtistBookingSchema = BookingSchema.extend({
  endsAt: z.string().datetime(),
  noShowReturnDueAt: z.string().datetime(),
  changeableUntil: z.string().datetime(),
  rescheduledCount: z.number().int().nonnegative(),
  calendarSyncState: z.enum(['not_applicable', 'pending', 'synced', 'failed']),
  memberName: z.string(),
  memberPhone: z.string(),
  memberTier: z.enum(['bronze', 'silver', 'gold', 'black']),
  serviceName: z.string(),
});

export type ArtistBooking = z.infer<typeof ArtistBookingSchema>;

const ArtistBookingPageSchema = paginated(ArtistBookingSchema);

export function fetchMyBookings(accessToken: string, signal?: AbortSignal): Promise<ArtistBooking[]> {
  return getJson('/artists/me/bookings', ArtistBookingPageSchema, accessToken, signal).then(
    (page) => page.items,
  );
}

// ---------------------------------------------------------------- her week --

/**
 * The artist row, exactly as `serialiseArtist` sends it.
 *
 * `ArtistSchema` from @avo/types already matches — unlike the booking shapes,
 * this one has not drifted — so it is used directly rather than re-declared.
 */
export type ArtistRow = z.infer<typeof ArtistSchema>;

export const SLOT_LENGTHS = [15, 20, 30, 45, 60] as const;
export type SlotLength = (typeof SLOT_LENGTHS)[number];

export interface DayWindow {
  open: boolean;
  /** "10:00" — 24-hour, zero-padded. The API validates the format. */
  from: string;
  to: string;
}

/** Sunday-first, keyed "0".."6", matching `Artist.windows` and JS `getDay()`. */
export type Week = Record<string, DayWindow>;

export interface AvailabilityPatch {
  availabilitySource?: 'google' | 'manual';
  slotMinutes?: SlotLength;
  /**
   * ALL SEVEN DAYS OR NONE. The API refuses a partial map by name: a PUT is a
   * full replacement of the week, and a merge dressed as a replace disagrees
   * exactly when it matters — a partial that omits Friday keeps Friday open.
   */
  windows?: Week;
}

/**
 * `PUT /artists/me/availability`.
 *
 * ONE CALL DOES BOTH JOBS, and the API is built for that: "Switch and edit may
 * arrive in ONE request — that is what the segmented control does — and they
 * land in one UPDATE." So moving to Manual and setting a day's window is a
 * single PUT rather than two, which is what stops the screen from leaving an
 * artist switched but not edited when the second request fails.
 */
export function putMyAvailability(
  patch: AvailabilityPatch,
  accessToken: string,
  signal?: AbortSignal,
): Promise<ArtistRow> {
  return putJson('/artists/me/availability', patch, ArtistSchema, accessToken, signal);
}
