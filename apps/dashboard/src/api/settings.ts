import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from '@tanstack/react-query';
import type { Branch, Salon } from '@avo/types';
import { authedRequest } from '../auth/authedRequest.js';
import { useSalonId } from '../auth/AuthProvider.js';
import { salonKeys } from './salon.js';
import { staffKeys } from './staff.js';

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
 * `moduleShop`), and does not include `branches`.
 *
 * THE SECOND HALF OF THAT SENTENCE USED TO SAY "neither can be written by any
 * endpoint in the API", AND IT WAS WRONG ABOUT BRANCHES — the sixth stale
 * "not built" claim found in this dashboard, and the second one about these exact
 * routes. `PATCH /salons/{id}` genuinely refuses a `branches` key, but branches
 * have their own routes and always did:
 *
 *   POST   /salons/{id}/branches            perms.loyalty   (salons.ts:420)
 *   PATCH  /salons/{id}/branches/{bid}      perms.loyalty
 *   DELETE /salons/{id}/branches/{bid}      perms.loyalty   — a CLOSE, not a delete
 *
 * `useAddBranch` and `useCloseBranch` below use them. `modules` remains genuinely
 * unwritable, so the module toggles stay disabled with their sentence.
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

/* ---------------------------------------------------------------- branches -- */

/**
 * `POST /salons/{id}/branches` — `perms.loyalty`. A salon opens a second location.
 *
 * NAME ONLY. THE SERVER MINTS THE ID.
 *
 * The prototype generates one client-side — `genBranchId()` in
 * `AVO Merchant Dashboard.dc.html:1471` builds `BR-` plus three letters of the
 * name and de-duplicates against its own in-memory list. That cannot be ported: a
 * branch id is what `staff_user.branch_access_ids`, `booking.branch_id` and every
 * boost row reference, and two clients minting ids against their own view of the
 * list will eventually mint the same one. The API's `branchId()` owns it, and the
 * body it accepts is `name` and `nameAr` and nothing else — anything more is a
 * `not_editable` 400.
 *
 * `nameAr` IS NOT SENT, AND THAT IS A REPORTED GAP RATHER THAN AN OVERSIGHT.
 * The design's Settings panel has one field, "New branch name", and no Arabic
 * one — the merchant dashboard is English-only by decision (design/README.md
 * § Known gaps 1). But a branch name reaches the CUSTOMER app, which is Arabic-
 * first, so a branch opened here will show its English name to an Arabic wallet.
 * The prototype "solves" this by copying the English string into `nameAr`, which
 * is worse than leaving it null: it makes an unlocalised name look translated,
 * and non-negotiable #12 calls Arabic a first-class layout rather than a copy of
 * the English. Null is honest and the wallet can fall back. Reported to trunk.
 */
export function useAddBranch(): UseMutationResult<Branch, unknown, { name: string }> {
  const salonId = useSalonId();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ name }) =>
      authedRequest<Branch>('merchant', `/salons/${salonId}/branches`, {
        method: 'POST',
        body: { name },
      }),
    // Invalidate rather than append: the branch list lives on the Salon object
    // that the whole shell reads, and the 201 is a Branch, not a Salon.
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: salonKeys.detail(salonId) });
    },
  });
}

/**
 * `DELETE /salons/{id}/branches/{bid}` — `perms.loyalty`. A CLOSE, not a delete.
 *
 * The row survives with `closedAt` set, because `booking.branch_id` and
 * `transaction` rows reference it — a branch that ever took money cannot be
 * removed, only closed. `GET /salons/{id}` serialises open branches only, so a
 * closed one simply leaves the list.
 *
 * THE RESPONSE IS A WARNING, AND IT ARRIVES TOO LATE TO BE ONE.
 *
 * The body carries `staffRescoped`, `staffLeftWithNoBranch` and
 * `depositHeldBookings` — read from the UPDATE's own RETURNING, so they describe
 * this close rather than the salon's general state. They exist to be shown, and
 * `staffLeftWithNoBranch` is the one that needs her attention: a staff member
 * scoped to branches who now has none cannot work.
 *
 * But they are computed INSIDE the transaction that does the close, and there is
 * no preview route — no `GET …/branches/{bid}/closure-preview`, no `?dryRun`. So
 * the server can only tell her what it already did. Showing the consequences
 * BEFORE she confirms therefore has to be done client-side, from `GET /staff` and
 * `GET /salons/{id}/bookings` — and both of those need permissions
 * (`team`, `appointments`) that the person closing the branch may not hold, since
 * closing it needs only `loyalty`. See Settings.tsx for what that means in
 * practice. A preview endpoint is the clean fix; reported to trunk.
 */
export interface BranchClosure extends Branch {
  closedAt: string | null;
  /** Names, not ids — the server already resolved them for display. */
  staffRescoped: string[];
  /** Names of staff who were scoped to branches and now have NONE. */
  staffLeftWithNoBranch: string[];
  /** Appointments at that branch still holding a customer's deposit. */
  depositHeldBookings: number;
}

export function useCloseBranch(): UseMutationResult<
  BranchClosure,
  unknown,
  { branchId: string }
> {
  const salonId = useSalonId();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ branchId }) =>
      authedRequest<BranchClosure>('merchant', `/salons/${salonId}/branches/${branchId}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      /*
       * Both the salon AND the staff list. `array_remove` rewrote
       * `branch_access_ids` on every staff row naming this branch, so a cached
       * Accounts screen would keep showing a branch that no longer exists — and
       * that screen is where branch access is edited.
       */
      void queryClient.invalidateQueries({ queryKey: salonKeys.detail(salonId) });
      void queryClient.invalidateQueries({ queryKey: staffKeys.list(salonId) });
    },
  });
}
