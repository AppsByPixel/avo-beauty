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
    retry: 1,
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
