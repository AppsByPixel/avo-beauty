/**
 * Who does which service — the rule, in one place.  (migrations 0061, 0062)
 *
 * `assertArtistPerformsService` is called by EVERY path that commits an artist
 * to performing a service at a time:
 *
 *   POST /bookings                               createBooking
 *   POST /salons/{id}/bookings                   createMerchantBooking
 *   POST /bookings/{id}/reschedule               rescheduleBooking
 *   POST /salons/{id}/bookings/{id}/reschedule   rescheduleByMerchant
 *   POST /salons/{id}/bookings/{id}/reassign     reassignArtist
 *
 * One function, so the five cannot disagree about what "assigned" means. It is
 * non-negotiable #7's shape: the wallet hiding an artist who does not do a
 * service is a courtesy, and this is the control.
 *
 * WHY THE RESCHEDULES CHECK TOO. Moving a booking re-commits the same artist to
 * the same service at a new time. If the salon has since taken that service off
 * her, the new slot is a promise she will not keep. The booking at its ORIGINAL
 * time is left alone — unassigning is not a cancellation, and an appointment a
 * customer has paid a deposit on is not withdrawn by a settings change.
 *
 * WHAT IT DOES NOT GUARD: `POST /charges`, `POST /salons/{id}/bookings/{id}/complete`,
 * cancel, no-show. None of them commits anybody to perform anything — see
 * `db/schema/artistService.ts` for why charging in particular is not restricted.
 */

import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/client';
import { artist as artistTable } from '../db/schema/artist';
import { artistService } from '../db/schema/artistService';
import { service as serviceTable } from '../db/schema/service';
import { conflict } from '../http/errors';
import type { Executor } from './audit';

/**
 * Refuse, with `409 artist_not_assigned`, unless this artist is assigned to this
 * service.
 *
 * Call it AFTER the artist and the service have each been resolved against the
 * caller's salon. It deliberately does not re-check tenancy — the composite FKs
 * make a cross-salon row unstorable, so a row found here is same-salon by
 * construction — and it must not become the first thing to answer for an id the
 * caller may not see: "no such artist" is `unknown_artist`'s job, and a 409
 * here would confirm the id is real.
 *
 * `FOR SHARE` ON THE LINK ROW, and it is the whole defence against the unassign
 * racing the booking — the same move `resolvePickupBranch` makes against a
 * branch close. `PUT /salons/{id}/services/{sid}/artists` DELETEs the rows it
 * drops, and a DELETE conflicts with a share lock: either the unassign waits for
 * this booking to commit (and the booking stands, like any booking made before
 * an unassign), or this read waits for the unassign, finds the row gone, and
 * refuses. Without it a booking could commit against an assignment removed a
 * millisecond earlier. The caller must pass its transaction.
 */
export async function assertArtistPerformsService(
  tx: Executor,
  artist: { id: string; name: string },
  svc: { id: string; name: string },
): Promise<void> {
  if (await holdsAssignment(tx, artist.id, svc.id)) return;
  throw notAssigned(artist, svc);
}

/**
 * The same rule for a booking that already exists — the two reschedules and the
 * reassign, which hold ids off the booking row rather than resolved rows. The
 * names are read only on the refusal path, where the sentence needs them.
 *
 * The SERVICE IS NOT REQUIRED TO BE ACTIVE here, and that is the retire rule
 * rather than an oversight: a live booking whose service has since been retired
 * still happens (`DELETE /salons/{id}/services/{sid}` withdraws a service from
 * sale, it does not cancel appointments), so it can still be moved to another
 * slot with the same artist. Retiring keeps the links; see `routes/services.ts`.
 */
export async function assertBookedPairAssigned(
  tx: Executor,
  artistId: string,
  serviceId: string,
): Promise<void> {
  if (await holdsAssignment(tx, artistId, serviceId)) return;
  const [a] = await (tx as Db)
    .select({ name: artistTable.name })
    .from(artistTable)
    .where(eq(artistTable.id, artistId))
    .limit(1);
  const [s] = await (tx as Db)
    .select({ name: serviceTable.name })
    .from(serviceTable)
    .where(eq(serviceTable.id, serviceId))
    .limit(1);
  throw notAssigned(
    { id: artistId, name: a?.name ?? 'That artist' },
    { id: serviceId, name: s?.name ?? 'this service' },
  );
}

async function holdsAssignment(tx: Executor, artistId: string, serviceId: string): Promise<boolean> {
  const [row] = await (tx as Db)
    .select({ artistId: artistService.artistId })
    .from(artistService)
    .where(and(eq(artistService.artistId, artistId), eq(artistService.serviceId, serviceId)))
    .for('share')
    .limit(1);
  return row !== undefined;
}

function notAssigned(artist: { id: string; name: string }, svc: { id: string; name: string }) {
  return conflict(
    'artist_not_assigned',
    `${artist.name} does not do ${svc.name}. Choose someone who does, or another service.`,
    { artistId: artist.id, serviceId: svc.id },
  );
}

/**
 * `serviceId → artistIds`, for a page of services. ONE query, not one per row —
 * `primaryImagesFor`'s rule. Every requested id is present in the map, with `[]`
 * when nobody is assigned, so a caller cannot mistake "not asked" for "nobody".
 *
 * Sorted by artist id so the array is stable across reads: a client diffing its
 * checkbox state against a re-read must not see a reordering as a change.
 */
export async function assignedArtistIds(
  exec: Executor,
  serviceIds: readonly string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>(serviceIds.map((id) => [id, []]));
  if (serviceIds.length === 0) return out;
  const rows = await (exec as Db)
    .select({ serviceId: artistService.serviceId, artistId: artistService.artistId })
    .from(artistService)
    .where(inArray(artistService.serviceId, [...serviceIds]))
    .orderBy(asc(artistService.serviceId), asc(artistService.artistId));
  for (const r of rows) out.get(r.serviceId)?.push(r.artistId);
  return out;
}
