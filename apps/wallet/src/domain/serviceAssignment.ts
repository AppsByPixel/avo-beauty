/**
 * WHO DOES WHICH SERVICE — migration 0061, `Service.artistIds`.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THIS REPLACES A REPORTED GAP, AND THE BOOK FLOW'S OLD PIN SAID SO.
 *
 * `useBooking § the empty branch` used to read "THE SERVICE IS NEVER THE
 * REASON ... the data model has no artist-to-service relation at all", and a
 * spec pinned that the service list was NOT narrowed so that an invented filter
 * would go red. Lane A has since added the relation — on the SERVICE list, not
 * on `BookableArtist` — so "bookable at this branch" is the INTERSECTION of
 * `service.artistIds` with `GET /artists/bookable?branch=`, both lists the flow
 * already holds. No request per service.
 *
 * THREE RULES, and the server is the control for all of them (#7): booking,
 * rescheduling or reassigning with an unassigned artist is `409
 * artist_not_assigned`. These make the flow stop offering what that 409 would
 * refuse; they do not replace it.
 *
 *   1. `artistIds: []` IS HIDDEN. Nobody can be booked for it. It is still
 *      chargeable at the counter — the person at the till rings up the visit
 *      rather than performing it — which is not this flow's concern.
 *   2. A SERVICE IS OFFERED ONLY WHERE SOMEBODY ON THE ROSTER DOES IT. The
 *      roster is whatever `/artists/bookable` answered for her branch choice —
 *      one branch, All, or the unassigned group — so after she picks a branch
 *      at a multi-branch salon, a service performed only elsewhere is gone.
 *   3. THE STAFF STEP SHOWS ONLY THE ARTISTS ASSIGNED TO HER SERVICE.
 *
 * MIGRATION 0062 ASSIGNED EVERY EXISTING ARTIST TO EVERY EXISTING SERVICE, so
 * for every salon today all three are no-ops until a merchant edits
 * assignments. `bookingSteps.test.tsx` pins that an existing salon's flow is
 * unchanged, and this module's spec pins each rule against a salon that has
 * edited them.
 *
 * NO `active` FILTER HERE, for `useBooking`'s reason: `/artists/bookable` is
 * already the bookable set, so intersecting with it is what removes an artist
 * who left — a second opinion held here would be the bug.
 * ═════════════════════════════════════════════════════════════════════════════
 */

import type { Service } from '@avo/types';

type Assigned = Pick<Service, 'artistIds'>;
type HasId = { id: string };

/** Rule 1: somebody, anywhere, is assigned to it. */
export function hasAssignedArtist(service: Assigned): boolean {
  return service.artistIds.length > 0;
}

/**
 * Rules 1 and 2. `roster` NULL means "not known" — the roster read failed — and
 * then only rule 1 applies: a service nobody at all performs is still hidden,
 * and the staff step shows the roster's own failure with its retry.
 */
export function bookableServices<S extends Assigned>(
  services: readonly S[],
  roster: readonly HasId[] | null,
): S[] {
  if (roster === null) return services.filter(hasAssignedArtist);
  const here = new Set(roster.map((a) => a.id));
  return services.filter((s) => s.artistIds.some((id) => here.has(id)));
}

/** Rule 3: the roster, narrowed to the artists who perform this service. */
export function assignedArtists<A extends HasId>(roster: readonly A[], service: Assigned): A[] {
  const assigned = new Set(service.artistIds);
  return roster.filter((a) => assigned.has(a.id));
}

/** Is this artist one of the service's? For clearing a choice she can no longer see. */
export function isAssigned(service: Assigned, artistId: string): boolean {
  return service.artistIds.includes(artistId);
}
