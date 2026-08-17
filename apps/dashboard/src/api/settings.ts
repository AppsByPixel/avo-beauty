import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from '@tanstack/react-query';
import type { Salon } from '@avo/types';
import { authedRequest } from '../auth/authedRequest.js';
import { useSalonId } from '../auth/AuthProvider.js';
import { salonKeys } from './salon.js';

/**
 * `PATCH /salons/{id}` — `perms.loyalty`.
 *
 * WHICH PERMISSION GATES SETTINGS, AND WHY IT IS ODD
 * --------------------------------------------------
 * `perms.loyalty`, not a settings permission of its own. The API gates this
 * route that way because the loyalty editor writes through it, and there are
 * only nine permissions. It means a staff member who may edit the tier ladder
 * may also change the deposit and the WhatsApp switch. Noted rather than worked
 * around: the client cannot invent a tenth permission, and hiding the section
 * from someone the server would allow is a lie in the other direction.
 *
 * WHAT THIS ENDPOINT WILL NOT ACCEPT
 * ----------------------------------
 * `EDITABLE` on the API side does not include `modules` (nor `moduleBooking` /
 * `moduleShop`), and does not include `branches`. Both are served by
 * `GET /salons/{id}` and neither can be written by any endpoint in the API.
 *
 * That is not worked around here. The module toggles and the branch list render
 * in their designed places, disabled, with a sentence saying so — because the
 * alternative is a control that 400s on click, and the phase-4 criterion is that
 * an owner can configure a salon end to end without an engineer. Today she
 * cannot: turning Booking on requires a database write. Reported to Lane A.
 */
export type SalonPatch = Partial<
  Pick<
    Salon,
    'name' | 'nameAr' | 'brandColor' | 'depositFils' | 'businessHours' | 'whatsappEnabled' | 'timezone'
  >
>;

/**
 * The PATCH response is NOT a `Salon`, so it is deliberately typed as unknown.
 *
 * FOUND BY DRIVING IT, AND IT CRASHED THE SHELL.
 *
 * `GET /salons/{id}` runs a serialiser; `PATCH /salons/{id}` ends with
 * `reply.send(after)` on the raw Drizzle row. Verified against the running API:
 *
 *   GET   … branches, modules, … (18 keys, the documented Salon)
 *   PATCH … no branches, no modules; instead moduleBooking, moduleShop,
 *           createdAt, updatedAt
 *
 * Writing that into the cache the shell reads made `salon.branches[0]` throw and
 * took the entire dashboard to its error boundary on every settings change.
 * Reported to Lane A — the PATCH should return the same serialiser as the GET.
 */
export function useUpdateSalon(): UseMutationResult<unknown, unknown, SalonPatch> {
  const salonId = useSalonId();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (patch) =>
      authedRequest<unknown>('merchant', `/salons/${salonId}`, { method: 'PATCH', body: patch }),
    /*
     * INVALIDATE, do not `setQueryData` from the response. Until the PATCH
     * serialises like the GET, its body cannot be trusted to be a Salon, and the
     * cheap round trip is worth more than the crash above.
     *
     * No optimistic write either. `depositFils` is money: it decides what is
     * held from a customer's wallet at booking, and a stepper showing 7 KD while
     * the server still holds 5 is the same class of lie as a half-published
     * ladder. The control owns its own in-flight value — see Settings.tsx.
     */
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: salonKeys.detail(salonId) });
    },
  });
}
