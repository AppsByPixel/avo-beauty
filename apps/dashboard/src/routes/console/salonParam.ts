import type { PlatformSalon } from '../../api/platformSalons.js';

/**
 * A `?salon=` FROM THE URL, RESOLVED AGAINST THE SALONS THAT EXIST.
 *
 * The console's audit, activity and accounts reads all take `?salon=` and all
 * REFUSE an unknown id by name (404 `unknown_salon`) rather than answering
 * empty — which is right for the API and wrong for a link: a hand-edited or
 * stale `?salon=SAL-GONE` would turn the whole section into "Couldn't load",
 * with the filter that caused it drawn nowhere and no way to clear it.
 *
 * So the id is sent only once the full salon list (`useAllPlatformSalons`, which
 * walks every page) says it is real. While that list is still walking, the read
 * WAITS rather than going out unfiltered and then again filtered — a flash of
 * every salon's rows under a link to one is the wrong answer shown first. An id
 * the finished list does not contain, or a list that failed, is ignored.
 */
export function resolveSalonParam(
  raw: string,
  list: { salons: readonly PlatformSalon[]; isError: boolean; complete: boolean },
): { salonId: string | null; waiting: boolean } {
  if (raw === '') return { salonId: null, waiting: false };
  if (list.salons.some((s) => s.id === raw)) return { salonId: raw, waiting: false };
  if (!list.complete && !list.isError) return { salonId: null, waiting: true };
  return { salonId: null, waiting: false };
}
