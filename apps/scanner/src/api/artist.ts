/**
 * The artist's own bookings and her own hours.
 *
 *   GET /artists/me                 her own artist row
 *   GET /artists/me/bookings        her day, with the client's name and phone
 *   PUT /artists/me/availability    her week
 *
 * All three are scanner-scoped and need no permission, which is the point: an
 * artist should not need the merchant's `perms.appointments` to see who is
 * coming to see her, or `perms.team` to set the hours she works.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE READ EXISTS NOW, AND THIS HEADER SAID IT DID NOT — FOR THREE MERGES
 * ═══════════════════════════════════════════════════════════════════════════
 * This file used to open "THERE IS NO WAY TO *READ* HER OWN ARTIST ROW, AND
 * THAT IS A REAL GAP", listing `GET /artists/me` as "does not exist", and it
 * closed by asking for exactly that route "returning the same `serialiseArtist`
 * shape the PUT already returns".
 *
 * Lane A built it — `api/src/routes/artists.ts:658`, scanner scope, no
 * permission — and its own header credits this lane's reasoning by name. The
 * request was granted and the comment was never updated, so the workaround below
 * it stayed live and the screen kept opening on a toggle it no longer needed.
 *
 * THE WORKAROUND WAS THE DEFECT, not the comment. The comment was merely how it
 * survived review: a paragraph arguing the absence made the workaround look like
 * a decision rather than a gap. What the screen actually did was open on the
 * source toggle and take her week from the PUT's response — which meant a
 * Google-synced artist could not LOOK at her hours without tapping Manual and
 * switching herself off her calendar. Declining to probe with a speculative
 * `{ availabilitySource: 'manual' }` on mount was right, and it is now moot:
 * there is a real read, so the screen reads.
 *
 * (`GET /artists/me/availability` still falls through to `/artists/:id` with
 * id="me" and answers 404, and `GET /salons/{id}/artists` is still `perms.team`
 * — which the seeded artist ST-002 deliberately lacks. Both remain true; only
 * the third line was stale.)
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
 *
 * It also joins `member` LIVE, which is how an erased customer's tombstone
 * reaches this parse. See `memberPhone` and `memberErased` below.
 */
export const ArtistBookingSchema = BookingSchema.extend({
  endsAt: z.string().datetime(),
  noShowReturnDueAt: z.string().datetime(),
  changeableUntil: z.string().datetime(),
  rescheduledCount: z.number().int().nonnegative(),
  calendarSyncState: z.enum(['not_applicable', 'pending', 'synced', 'failed']),
  memberName: z.string(),
  /**
   * NULL WHEN SHE HAS BEEN ERASED, and this parse is the urgent half of the fix.
   *
   * `api/src/services/erasure.ts` scrubs the member row IN PLACE: the name
   * becomes the tombstone `'Deleted account'` and the phone becomes `+990`
   * followed by twelve random digits. `+990` is an unassigned country code, so
   * the string is well-formed and names nobody. `GET /artists/me/bookings`
   * joins `member` live and `erasure.ts` keeps `booking` rows deliberately, so
   * the tombstone reached this schema as an ordinary `z.string()` and the card
   * below it offered to CALL and WhatsApp the number — an outbound request
   * built from fabricated digits.
   *
   * Lane A is replacing that with `null` + `memberErased`. Declared `z.string()`,
   * the day the API starts sending `null` is the day a `z.string()` parse throws
   * and the artist's ENTIRE DAY fails to load — a schema-shaped outage, not a
   * privacy bug. `.nullable()` lands first for exactly that reason.
   */
  memberPhone: z.string().nullable(),
  /**
   * `.default(false)`, so this branch is green on BOTH payloads.
   *
   * LANE A HAS SINCE MERGED — `http/serialise.ts § serialiseMemberContact`
   * computes it from `erasedAt` and every item carries it — so the original
   * reason for the default ("a required boolean would reject every booking the
   * API serves TODAY") is spent. The default STAYS on the reason that outlives
   * it: a required boolean against a rolled-back API throws inside
   * `fetchMyBookings` and her entire day fails to load, and absent means "not
   * erased", which is the truthful reading of the older payload. It is safe in
   * the one direction that matters, because the card's guard is `memberErased ||
   * memberPhone === null`: a real tombstone arriving without the flag is still
   * caught by the null.
   */
  memberErased: z.boolean().default(false),
  memberTier: z.enum(['bronze', 'silver', 'gold', 'black']),
  serviceName: z.string(),
  /**
   * "YOU RANG THIS UP AND IT WAS REVERSED" - server-decided, and it was being
   * DELETED HERE.
   *
   * This schema is a plain zod object, so the default `strip` applies: a key it
   * does not name is dropped on arrival and nothing throws. `GET
   * /artists/me/bookings` sends `chargeVoided` on every item, and the parse ate
   * it - the same drift that has cost this repo a whole feature between the
   * server and the screen more than once. `artistBookingWire.test.ts` pins the
   * ARRIVAL rather than the rendering, because a card test cannot see a key that
   * was removed before the card was called.
   *
   * WHAT IT MEANS, AND WHY IT IS NOT DERIVABLE HERE. True exactly when the
   * booking's settling transaction carries `reverses_transaction_id`, which has
   * exactly ONE writer in the whole API - the void - behind the unique index
   * `transaction_reverses_uq`. `status` alone says `cancelled`, which has two
   * writers meaning opposite things: a customer calling off a visit that never
   * happened, and a manager reversing the charge for work this artist performed.
   * Nothing on the booking row tells them apart. Non-negotiable #2: this is the
   * server's answer and the client does not recompute it from a status, a
   * timestamp, or a charge this device happened to watch.
   *
   * (Today the route admits `cancelled` to her day ONLY when that id is
   * non-null, so every `cancelled` row reaching this parse IS a reversal.
   * Branching on the status instead of on this field would therefore look
   * correct and be wrong the moment Lane A widens that predicate to let a
   * customer's cancellation through - which its own comment says is a live
   * option, deliberately left open.)
   *
   * `.default(false)`, mirroring `memberErased` above, and the trade is argued
   * in `artistBookingWire.test.ts`: a required boolean against a rolled-back API
   * throws inside `fetchMyBookings` and takes her ENTIRE DAY down, to preserve a
   * "too old to say" distinction that has no consumer on this screen.
   */
  chargeVoided: z.boolean().default(false),
});

export type ArtistBooking = z.infer<typeof ArtistBookingSchema>;

const ArtistBookingPageSchema = paginated(ArtistBookingSchema);

/**
 * Her own artist row — `GET /artists/me`.
 *
 * `ArtistSchema` unchanged and deliberately shared with `putMyAvailability`
 * below: the route returns the same `serialiseArtist` shape the PUT does, so a
 * second schema here would be a second opinion about one payload. If they ever
 * diverge, that is the contract's problem to answer, not this file's to paper
 * over with a looser parse.
 *
 * 404 `not_an_artist` for a staff account with no artist row — a receptionist or
 * a shared terminal — which the caller renders as "no calendar here" rather than
 * as a failure. Same code `GET /artists/me/bookings` answers, for the same
 * reason.
 */
export function fetchMyArtist(accessToken: string, signal?: AbortSignal): Promise<ArtistRow> {
  return getJson('/artists/me', ArtistSchema, accessToken, signal);
}

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
