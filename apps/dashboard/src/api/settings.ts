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
 * `MERCHANT_EDITABLE` on the API side does not include `branches`, and does not
 * include the two module COLUMN spellings, `moduleBooking` and `moduleShop`.
 *
 * THIS PARAGRAPH HAS NOW BEEN WRONG TWICE, IN THE SAME DIRECTION BOTH TIMES, AND
 * THE CORRECTIONS ARE KEPT RATHER THAN TIDIED AWAY BECAUSE THE PATTERN IS THE
 * POINT — a refusal observed once, generalised into "the API cannot do this",
 * then believed long after the API grew the door.
 *
 * (1) It used to say branches "cannot be written by any endpoint in the API" —
 *     the sixth stale "not built" claim found in this dashboard. `PATCH
 *     /salons/{id}` genuinely refuses a `branches` key, but branches have their
 *     own routes and always did:
 *
 *       POST   /salons/{id}/branches            perms.loyalty   (salons.ts:420)
 *       PATCH  /salons/{id}/branches/{bid}      perms.loyalty
 *       DELETE /salons/{id}/branches/{bid}      perms.loyalty   — a CLOSE, not a delete
 *
 *     `useAddBranch` and `useCloseBranch` below use them.
 *
 * (2) It used to say `modules` "remains genuinely unwritable", and that this
 *     endpoint refuses `modules`, `moduleBooking` and `moduleShop` alike. Only
 *     the last two are true. `modules` is in `MERCHANT_EDITABLE`
 *     (salons.ts:57) and has been since e883330 — "feat(api): a salon's
 *     structure is configurable". The COLUMN spellings are refused deliberately
 *     and permanently, by that set's own comment: `modules` is the WIRE shape,
 *     `applyModules` splits it into the two boolean columns, and "two doors into
 *     one field is how the tier ladder acquired an unvalidated second entrance".
 *     So the original verification almost certainly hit `moduleBooking` /
 *     `moduleShop`, got `not_editable`, and the note generalised one true
 *     refusal into a false one about a third field.
 *
 *     Driven against the running API on `avo_lane_c`, as ST-001 (a manager
 *     holding `perms.loyalty`), and confirmed in SQL rather than in the reply:
 *
 *       PATCH /salons/SAL-AMARA {"modules":{"booking":true,"shop":false}}
 *         → 200,  module_booking=t module_shop=f
 *       PATCH … {"modules":{"shop":true}}              → 200, booking untouched
 *       PATCH … {"moduleBooking":false}                → 400 not_editable
 *       PATCH … {"moduleShop":false}                   → 400 not_editable
 *       PATCH … {"modules":{"loyalty":true}}           → 400 unknown_module
 *       PATCH … as ST-002 (perms.loyalty OFF), called directly
 *                                                      → 403, columns unchanged
 *
 *     The module toggles in `Settings.tsx § ModulesPanel` are wired to the first
 *     of those and their notice is gone.
 */
export type SalonPatch = Partial<
  Pick<
    Salon,
    'name' | 'nameAr' | 'brandColor' | 'depositFils' | 'businessHours' | 'whatsappEnabled' | 'timezone'
  >
> & {
  /**
   * `Partial<>` and NOT `Salon['modules']`, which requires both keys.
   *
   * A partial object is a partial update on the server's side and that is
   * designed, not tolerated — `applyModules` (salons.ts:240) only touches a
   * column whose key is present, "because the Settings screen has two
   * independent switches and sending the pair on every flip would let a stale
   * render turn the other one off". Sending `{ booking }` alone is therefore the
   * correct write for one switch, and the type says so.
   */
  modules?: Partial<Salon['modules']>;
};

/**
 * The PATCH response is typed `unknown` and is not written into the cache.
 *
 * IT USED TO SAY "the PATCH response is NOT a `Salon`". THAT WAS TRUE AND IS NOT
 * ANY MORE — found while driving `modules` above, in the same session, which is
 * the argument for driving rather than re-reading.
 *
 * What was true: `GET /salons/{id}` ran a serialiser and `PATCH /salons/{id}`
 * ended on `reply.send(after)` with the raw Drizzle row — no `branches`, no
 * `modules`, instead `moduleBooking`, `moduleShop`, `createdAt`, `updatedAt`.
 * Writing that into the cache the shell reads made `salon.branches[0]` throw and
 * took the whole dashboard to its error boundary on every settings change. It
 * was reported to Lane A, and Lane A fixed it: `serialiseSalon` was lifted out of
 * the GET handler and both routes now end on it (salons.ts:621, with the comment
 * "The SAME shape `GET` answers"). Observed on the wire:
 *
 *   PATCH /salons/SAL-AMARA → 19 keys, `branches` and `modules` present,
 *                             `moduleBooking` absent — the documented Salon.
 *
 * SO WHY STILL `unknown`, AND STILL A REFETCH? Because nothing here parses that
 * body, and a cast is not a check — `authedRequest<Salon>` would compile whatever
 * arrives, which is exactly how the crash above got in. `platformSalons.ts` may
 * trust its PATCH response because it owns `parsePlatformSalonDetail` and runs it;
 * this file has no parser, and adding one is the slice that would also let this
 * hook `setQueryData`. Until then the cheap round trip stays: it costs one request
 * and cannot put a shape the shell does not expect into the cache.
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
