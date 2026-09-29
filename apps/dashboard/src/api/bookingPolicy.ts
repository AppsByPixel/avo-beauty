import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import {
  BookingPolicyPublishSchema,
  BookingPolicyReadSchema,
  type BookingPolicy,
  type CancellationRule,
} from '@avo/types';
import { authedRequest } from '../auth/authedRequest.js';
import { useSalonId } from '../auth/AuthProvider.js';

/**
 * The salon's own booking policy — `api/src/routes/bookingPolicy.ts`.
 *
 *   GET /salons/{id}/booking-policy   any principal of the salon. No permission:
 *                                     the policy is shown to every customer before
 *                                     she books, so tenancy is the control.
 *   PUT /salons/{id}/booking-policy   `perms.loyalty`, the deposit settings' gate.
 *                                     Publishes version n+1 and writes one bell
 *                                     notice per member, at most one a salon-day.
 *
 * BOTH BODIES ARE PARSED WITH THE SHARED SCHEMAS, not cast. The banner on
 * Appointments states the salon's no-show rule from this read, so a body that
 * does not parse must fail loudly rather than tell a merchant a rule about her
 * customers' money that nobody sent.
 *
 * NO IDEMPOTENCY KEY ON THE PUT, and that is the route's argument, not an
 * omission: it moves no money, and an identical body publishes nothing
 * (`published: false`), so a double-submitted Publish cannot mint two versions or
 * two bell notices.
 */

export const bookingPolicyKeys = {
  all: ['bookingPolicy'] as const,
  detail: (salonId: string) => [...bookingPolicyKeys.all, salonId] as const,
};

/** `null` until the salon publishes one — "no policy" is a fact, not a 404. */
export function useBookingPolicy(enabled = true): UseQueryResult<BookingPolicy | null> {
  const salonId = useSalonId();
  return useQuery({
    queryKey: bookingPolicyKeys.detail(salonId),
    queryFn: async ({ signal }) => {
      const raw = await authedRequest<unknown>('merchant', `/salons/${salonId}/booking-policy`, {
        signal,
      });
      return BookingPolicyReadSchema.parse(raw).policy;
    },
    enabled,
    // `useSalonBookings`' reason: the default `'online'` pauses a fetch offline
    // and a paused query renders as a permanent skeleton.
    networkMode: 'always',
  });
}

/** The `PUT` body. Unknown fields are refused by the server, so nothing else goes. */
export interface BookingPolicyInput {
  noShow: BookingPolicy['noShow'];
  cancellation: CancellationRule[];
  text: { en: string; ar: string };
}

export interface BookingPolicyPublished {
  policy: BookingPolicy;
  /** False when the body matched the current version: nothing written, nobody told. */
  published: boolean;
  /** Bell notices THIS publish wrote. 0 on a second publish the same salon-day. */
  noticesWritten: number;
}

export function usePublishBookingPolicy(): UseMutationResult<
  BookingPolicyPublished,
  unknown,
  BookingPolicyInput
> {
  const salonId = useSalonId();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input) => {
      const raw = await authedRequest<unknown>('merchant', `/salons/${salonId}/booking-policy`, {
        method: 'PUT',
        body: input,
      });
      return BookingPolicyPublishSchema.parse(raw);
    },
    /*
     * The parsed version goes straight into the read's cache, so the panel's
     * "Version N" and the Appointments banner both move on the answer the server
     * gave rather than on what was sent. An unchanged publish writes the same
     * version back, which is a no-op.
     */
    onSuccess: (result) => {
      queryClient.setQueryData(bookingPolicyKeys.detail(salonId), result.policy);
    },
  });
}
