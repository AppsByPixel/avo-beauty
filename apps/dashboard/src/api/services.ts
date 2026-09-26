import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { Service } from '@avo/types';
import { authedRequest } from '../auth/authedRequest.js';
import { useSalonId } from '../auth/AuthProvider.js';
import type { Paginated } from './salon.js';

/**
 * `GET /salons/{id}/services` — the salon's service list.
 *
 * ONE CALLER TODAY: the hand-written appointment form needs a `serviceId`, and
 * `POST /salons/{id}/bookings` takes an id rather than a name or a price. There
 * is no other way for a merchant to name what the appointment is FOR.
 *
 * `requireSalonScoped`, NOT `requireDashboardPerm` — api/src/routes/salons.ts
 * § the service list. It is the same list the scanner prices a counter sale
 * from and the same list the wallet's Book flow reads, so it carries no
 * dashboard permission of its own. The route DOES refuse a customer of a salon
 * with `modules.booking` off (`assertBookingReadable`), which is the same module
 * flag the Appointments screen already gates its own reads on — so the form is
 * only ever mounted where this request is answerable.
 *
 * THE LIST IS ALREADY FILTERED TO `active`, server-side, and the route explains
 * why it emits the field anyway: a retired service would build a basket the
 * charge handler refuses at the counter. Nothing here re-filters; doing so would
 * be this client deciding which services a salon may book, which is the server's
 * answer to give.
 *
 * NO CURSOR WALK. The route answers `nextCursor: null` unconditionally — it is a
 * salon's whole service list in one page, by construction. A `useInfiniteQuery`
 * here would be equipment for a page boundary the server does not have.
 *
 * `networkMode: 'always'` for the reason `api/bookings.ts § useSalonBookings`
 * records against a real 403: TanStack's default PAUSES a fetch offline rather
 * than failing it, and a paused query sits `pending` forever — which the form
 * would render as a permanently disabled service field instead of saying why.
 */
export const serviceKeys = {
  all: ['services'] as const,
  list: (salonId: string) => [...serviceKeys.all, salonId] as const,
};

export function useSalonServices(enabled = true): UseQueryResult<Paginated<Service>> {
  const salonId = useSalonId();
  return useQuery({
    queryKey: serviceKeys.list(salonId),
    queryFn: ({ signal }) =>
      authedRequest<Paginated<Service>>('merchant', `/salons/${salonId}/services`, { signal }),
    enabled,
    networkMode: 'always',
  });
}
