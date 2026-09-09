import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import type { Branch, Salon } from '@avo/types';
import { authedRequest } from '../auth/authedRequest.js';
import { useSalonId } from '../auth/AuthProvider.js';
import { deviceKeys } from './devices.js';
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
 * THE RESPONSE IS A RECEIPT, NOT A WARNING — and this heading used to say the
 * response WAS the warning and arrived too late to be one, which was the first
 * half of a wrong conclusion. It arrives exactly on time for what it is.
 *
 * The body carries `staffRescoped`, `staffLeftWithNoBranch` and
 * `depositHeldBookings` — read from the UPDATE's own RETURNING, so they describe
 * this close rather than the salon's general state. They exist to be shown, and
 * `staffLeftWithNoBranch` is the one that needs her attention: a staff member
 * scoped to branches who now has none cannot work.
 *
 * They are computed INSIDE the transaction that does the close, so this response
 * is a receipt rather than a warning. The warning is a SEPARATE READ, and it
 * exists — see `useBranchClosurePreview` below.
 *
 * WHAT THIS PARAGRAPH USED TO SAY, AND WHY THE CORRECTION IS KEPT.
 *
 * It said: "there is no preview route — no `GET …/branches/{bid}/closure-preview`,
 * no `?dryRun` … A preview endpoint is the clean fix; reported to trunk."
 *
 * That route exists, at exactly the path the sentence names —
 * `api/src/routes/salons.ts:1152`, `GET /salons/:id/branches/:bid/closure-preview`,
 * gated `requireDashboardPerm(req, 'loyalty')`, the same permission as the close.
 * It is covered by `e2e/configuration.test.ts:556`, `e2e/tenancy.test.ts:806`,
 * `e2e/contract.test.ts:971` and the permission census at
 * `e2e/permission-census.test.ts:691`. The fix this comment asked for had already
 * shipped, and the comment asked for it anyway.
 *
 * This is the NINTH instance of the pattern DECISIONS.md row 26 tracks — a
 * consumer-lane comment asserting a gap the API lane had already closed — and it
 * is the worst-shaped one so far, because every part of it except the conclusion
 * was true. It named a real path, gave a real reason (the numbers really were
 * computed inside the transaction), and drew a correct consequence from a false
 * premise. A reader who checks the path finds a plausible comment and leaves the
 * workaround alone, which is what happened for as long as it stood: `Settings.tsx`
 * computed the closure impact client-side from `GET /staff`, `GET /devices` and
 * `GET /salons/{id}/bookings` BECAUSE of this sentence.
 *
 * The mitigation that sentence describes is gone with it. The client-side
 * computation needed `perms.team`, `perms.appointments` and `perms.dashboard` —
 * three permissions the person closing the branch need not hold, since closing it
 * needs only `loyalty` — so the warning degraded to categories without counts for
 * a `loyalty`-only account. The preview is gated on `loyalty` alone and answers
 * all of it, so no second permission stands between a destructive button and its
 * own consequences. `api/src/services/branchClosure.ts` makes that argument at
 * length and credits this lane's report for it.
 */
/**
 * `GET /salons/{id}/branches/{bid}/closure-preview` — `perms.loyalty`.
 *
 * WHAT CLOSING THIS BRANCH WOULD DO, asked before it is done. The same
 * permission as the close, deliberately: whoever may close a branch may be told
 * what closing it does, and no second permission stands between a destructive
 * button and its own consequences.
 *
 * A SEPARATE READ, NOT `?dryRun` ON THE DELETE — the API's choice and a good one:
 * cacheable, impossible to fire by accident, and a destructive verb whose effect
 * depends on a query parameter is a request nobody can read in a log.
 *
 * THIS REPLACED A CLIENT-SIDE COMPUTATION, AND THE TWO DID NOT AGREE.
 *
 * `Settings.tsx § BranchesPanel` used to derive the same four facts from
 * `GET /staff`, `GET /salons/{id}/bookings?status=deposit_held` and
 * `GET /salons/{id}/devices`. On ordinary data the answers matched exactly. On a
 * busy salon they do not, and the divergence is in the direction that costs
 * money: `GET /salons/{id}/bookings` is `ORDER BY starts_at DESC LIMIT 200` with
 * `nextCursor: null` (`salons.ts` § the appointments list), so past 200
 * deposit-held bookings the list is silently truncated — and because the order is
 * DESC, the rows dropped first are the ones starting SOONEST.
 *
 * Measured on `avo_lane_c` against the real API: 3 deposit-held bookings at
 * Salmiya, 211 further out at Kuwait City. The preview answered
 * `depositHeldBookings: 3, depositHeldBookingsBranchAssumed: 2`. The client's own
 * computation, from the same 200-row list, answered **0** — and the confirmation
 * it drove would have read "No appointment here is holding a deposit" over three
 * customers' held deposits. `nextCursor: null` meant no page of this client could
 * have known.
 *
 * That is the case for the preview beyond `tillsUnenrolled`: a client-side
 * estimate that disagrees with the server's is worse than either alone, because
 * the screen states it with the same confidence either way.
 */
export interface BranchClosurePreview extends Branch {
  closedAt: string | null;
  /** Whether the DELETE would go through at all. */
  closable: boolean;
  /** `already_closed` | `last_open_branch`, or null when it would go through. */
  blockedReason: string | null;
  openBranchCount: number;
  /** Names, not ids — the server already resolved them for display. */
  staffRescoped: string[];
  /** Names of staff who are scoped to branches and would be left with NONE. */
  staffLeftWithNoBranch: string[];
  /** Appointments at that branch still holding a customer's deposit. */
  depositHeldBookings: number;
  /**
   * How many of those had their branch INFERRED rather than recorded. A COUNT,
   * and the client-side version this replaced could only manage a boolean — an
   * artist has no branch column, so a warning about money already taken from
   * customers must not read as a fact where part of it is a guess.
   */
  depositHeldBookingsBranchAssumed: number;
  /**
   * THE TILLS THE CLOSE WOULD UNENROL (DECISIONS.md #91). Labels, because this is
   * read on a confirmation sheet.
   *
   * The only place this number comes from. It cannot be derived from
   * `GET /salons/{id}/devices` any more than the rest of it can, and there is no
   * second source: before the field existed a merchant learnt which tills a close
   * broke by charging from one and getting a 404.
   */
  tillsUnenrolled: string[];
}

/**
 * Fetched only while a confirmation is open — `branchId` is null the rest of the
 * time and the query is disabled.
 *
 * NOT PREFETCHED PER ROW. The branch list draws a ✕ per branch and prefetching
 * would mean one request per row on every render of the Settings screen, for a
 * button most merchants never press. The endpoint is cheap and cacheable; it is
 * not free, and three of its four numbers are counts over `booking` and
 * `staff_user`.
 *
 * `staleTime: 0` OVERRIDES THE GLOBAL 30 SECONDS, AND MUST. This is a warning
 * shown immediately before an irreversible cascade. A merchant who opens the
 * confirmation, cancels, gives somebody a branch in Accounts → Team and reopens
 * it inside half a minute would otherwise be shown the pre-change impact and
 * decide on it. The global `staleTime` is right for a dashboard tile and wrong
 * for this.
 */
export function useBranchClosurePreview(
  branchId: string | null,
): UseQueryResult<BranchClosurePreview> {
  const salonId = useSalonId();
  return useQuery({
    queryKey: [...salonKeys.detail(salonId), 'closure-preview', branchId ?? 'none'] as const,
    queryFn: ({ signal }) =>
      authedRequest<BranchClosurePreview>(
        'merchant',
        `/salons/${salonId}/branches/${branchId!}/closure-preview`,
        { signal },
      ),
    enabled: branchId !== null,
    staleTime: 0,
    /*
     * Restated for `api/bookings.ts`' reason even though the global default
     * already sets it: without `'always'` an unreachable API leaves the query
     * PAUSED at `status: 'pending'` rather than erroring, and this confirmation
     * would sit on its loading state for ever instead of reaching the failure
     * state that blocks the close. That distinction is load-bearing here in a way
     * it is not on a stat tile — see `Settings.tsx § WHAT A FAILED PREVIEW DOES`.
     */
    networkMode: 'always',
  });
}

/**
 * The DELETE's own response. Field names match `BranchClosurePreview` exactly,
 * which is the API's deliberate choice — "so the preview and the outcome are
 * comparable rather than merely similar" — and is why the confirmation and the
 * receipt can be read against each other.
 */
export interface BranchClosure extends Branch {
  closedAt: string | null;
  /** Names, not ids — the server already resolved them for display. */
  staffRescoped: string[];
  /** Names of staff who were scoped to branches and now have NONE. */
  staffLeftWithNoBranch: string[];
  /** Appointments at that branch still holding a customer's deposit. */
  depositHeldBookings: number;
  /** How many of those had their branch inferred rather than recorded. */
  depositHeldBookingsBranchAssumed: number;
  /** The tills this close unenrolled, from the cascade's own RETURNING. */
  tillsUnenrolled: string[];
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
      /*
       * AND THE TILL LIST, because closing a branch silently breaks every till
       * standing at it — this is the third list a close changes and the only one
       * where the consequence is a counter that stops taking money.
       *
       * THE CLOSE NOW CASCADES A REVOKE, AND THIS COMMENT USED TO SAY IT DID NOT.
       *
       * It said "the enrolment row is NOT revoked by the close … REPORTED TO LANE
       * A; the fix is theirs and this column cannot make it." Lane A made it. The
       * DELETE's transaction UPDATEs `device_enrolment` for the closing branch,
       * setting `revoked_at`, `revoked_by_staff_id` and `updated_at` with
       * `revoked_at IS NULL` in the predicate so a re-close cannot double-report
       * (`api/src/routes/salons.ts` § "THE TILLS, CASCADED — revoked, not
       * stranded", DECISIONS.md #91). It returns them as `tillsUnenrolled` and
       * names them in the audit row.
       *
       * The defect the old text described was real when written: enrol a till at a
       * branch, close the branch, charge from that till → 404 `unknown_branch`,
       * driven on a lane-C API. That is what got it fixed. It is stale now, and
       * the two claims are worth keeping apart, because the SECOND one is the one
       * that misleads — "this column cannot make it" is a standing instruction to
       * the next reader not to look.
       *
       * SO THE LIST STILL MUST BE INVALIDATED, for a changed reason. Before the
       * cascade a closed branch left a live enrolment row pointing at it, and this
       * client's cached list was stale about the branch. Now the row itself is
       * revoked, and `GET /salons/{id}/devices` does not serve revoked rows — so
       * an uninvalidated cache would show tills that the server no longer has at
       * all. Same invalidation, worse staleness.
       */
      void queryClient.invalidateQueries({ queryKey: deviceKeys.list(salonId) });
    },
  });
}
