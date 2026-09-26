import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import type { Artist } from '@avo/types';
import { authedRequest } from '../auth/authedRequest.js';
import { useSalonId } from '../auth/AuthProvider.js';
import type { Paginated } from './salon.js';

/**
 * `GET /salons/{id}/artists`, `PUT /artists/{id}/availability` — both `perms.team`.
 *
 * THE WIRE SHAPE IS WIDER THAN `ArtistSchema`.
 *
 * The API's `serialiseArtist` returns three fields the shared schema does not
 * declare: `nameAr`, `active`, and `hasOwnLogin`. Two of them are load-bearing
 * here — `active` decides whether an artist is bookable at all, and
 * `hasOwnLogin` is the difference between "she can set her own hours from the
 * scanner" and "only reception can", which is what the card's summary line has
 * to say honestly.
 *
 * So this widens the type locally rather than reading undeclared fields off an
 * `Artist` and hoping. `packages/types` is trunk-owned; the fields belong on
 * `ArtistSchema` and are reported, not added here.
 */
export interface DashboardArtist extends Artist {
  nameAr: string | null;
  /** Whether a staff login is linked, i.e. whether she can edit her own week. */
  hasOwnLogin: boolean;
  active: boolean;
}

/** JS `getDay()` order, Sunday first — the key space the API validates against. */
export type DayKey = '0' | '1' | '2' | '3' | '4' | '5' | '6';

export interface DayWindow {
  open: boolean;
  from: string;
  to: string;
}

export type ArtistWindows = Record<DayKey, DayWindow>;

export const SLOT_MINUTES = [15, 20, 30, 45, 60] as const;
export type SlotMinutes = (typeof SLOT_MINUTES)[number];

export const artistKeys = {
  all: ['artists'] as const,
  list: (salonId: string) => [...artistKeys.all, salonId] as const,
};

export function useArtists(): UseQueryResult<Paginated<DashboardArtist>> {
  const salonId = useSalonId();
  return useQuery({
    queryKey: artistKeys.list(salonId),
    queryFn: ({ signal }) =>
      authedRequest<Paginated<DashboardArtist>>('merchant', `/salons/${salonId}/artists`, {
        signal,
      }),
    // Retry policy is global — api/retryPolicy.ts. `perms.team` gates this one.
  });
}

/**
 * ===========================================================================
 * `GET /salons/{id}/artists/bookable` — AND THE REASON IT IS A SECOND HOOK
 * RATHER THAN A PARAMETER ON THE ONE ABOVE IS A PERMISSION, NOT A FIELD SET
 * ===========================================================================
 * `GET /salons/{id}/artists` is `requireDashboardPerm(req, 'team')`
 * (api/src/routes/artists.ts:576). THIS one is `requireSalonScoped` — "any
 * authenticated principal of this salon", and the route's own comment says why:
 * "the same gate `GET /salons/{id}/services` uses, and for the same reason:
 * gating the list a customer books from on a merchant permission gates booking".
 *
 * WHICH IS EXACTLY THE HOLE THE APPOINTMENT FORM FELL INTO. Creating a booking
 * is `perms.appointments`, and `db/seed.ts § ST-002` is Hessa — frontdesk,
 * `appointments: true`, `team: false`. She is the person the feature was asked
 * for, and against the team roster she is a 403: she could be offered a form she
 * is authorised to submit and given no way to name an artist in it. Caught by
 * reading the guards rather than by a failing test, because a mocked roster
 * answers whoever asks.
 *
 * IT IS ALSO THE RIGHT LIST ON THE MERITS, not merely the reachable one. It
 * serves `active` artists only, and `reassignArtist` refuses an inactive one by
 * name — 409 `artist_not_bookable`, "That artist is not taking bookings." So the
 * team roster would offer choices the write endpoint rejects, and this one
 * cannot.
 *
 * `enabled` BECAUSE THE REASSIGN STEP NEEDS IT AND THE BOARD DOES NOT. A table
 * of 25 rows draws itself without the roster; asking on mount would make every
 * visit to Appointments a second request for a list nobody opened.
 */
export const bookableArtistKeys = {
  all: ['artists', 'bookable'] as const,
  list: (salonId: string) => [...bookableArtistKeys.all, salonId] as const,
};

export interface BookableArtistRow {
  id: string;
  salonId: string;
  name: string;
  nameAr: string | null;
  availabilitySource: string;
}

export function useBookableArtists(enabled = true): UseQueryResult<Paginated<BookableArtistRow>> {
  const salonId = useSalonId();
  return useQuery({
    queryKey: bookableArtistKeys.list(salonId),
    queryFn: ({ signal }) =>
      authedRequest<Paginated<BookableArtistRow>>(
        'merchant',
        `/salons/${salonId}/artists/bookable`,
        { signal },
      ),
    enabled,
    /*
     * `networkMode: 'always'` — TanStack's default PAUSES a fetch offline rather
     * than failing it, and a paused query sits `pending` forever, which the form
     * would paint as a permanently skeletoned artist field instead of saying
     * why. `api/bookings.ts § useSalonBookings` records the same trap hit
     * against a real 403.
     */
    networkMode: 'always',
  });
}

/**
 * The availability write.
 *
 * `availabilitySource` and `windows` may travel together, and usually do: the
 * editor's segmented control moves the artist to Manual and the day rows become
 * live in the same gesture. The API accepts exactly that combination and refuses
 * a windows edit that does NOT carry the switch, with a 409 naming the fix. The
 * editor sends whatever changed and lets the server be the authority — see the
 * note on the 409 in routes/Team.tsx.
 *
 * NOT a money-moving POST, so no idempotency key. A repeated PUT of the same
 * week is the same week; there is nothing to double-apply.
 */
export interface AvailabilityPatch {
  availabilitySource?: 'google' | 'manual';
  slotMinutes?: SlotMinutes;
  windows?: ArtistWindows;
}

export function useSaveAvailability(): UseMutationResult<
  DashboardArtist,
  unknown,
  { artistId: string; patch: AvailabilityPatch }
> {
  const salonId = useSalonId();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ artistId, patch }) =>
      authedRequest<DashboardArtist>('merchant', `/artists/${artistId}/availability`, {
        method: 'PUT',
        body: patch,
      }),
    /*
     * NO OPTIMISTIC UPDATE, and that is the point of the 409.
     *
     * Painting the new week before the server accepts it would show a merchant
     * hours that a Google sync is about to overwrite — which is the exact
     * failure the API refuses in order to prevent. The list is refetched from
     * the server on success, so what is on screen afterwards is what is stored.
     */
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: artistKeys.list(salonId) });
    },
  });
}
