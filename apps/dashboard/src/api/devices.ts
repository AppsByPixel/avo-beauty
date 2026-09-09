import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import { DeviceEnrolmentSchema, type DeviceEnrolment } from '@avo/types';
import { authedRequest } from '../auth/authedRequest.js';
import { useSalonId } from '../auth/AuthProvider.js';

/**
 * Which till stands at which branch.  (DECISIONS.md #82, migration 0043)
 *
 * ===========================================================================
 * THIS IS MONEY CONFIGURATION, NOT DEVICE MANAGEMENT
 * ===========================================================================
 * A till's branch is what makes a charge's branch `established`, and
 * `established` is what `services/promotions.ts` gates every earning decision
 * on. So the branch named here decides which boost a customer is paid at this
 * counter. `api/src/services/branch.ts` is emphatic that the guess it falls back
 * to — `ORDER BY id LIMIT 1` — is "a defensible way to ATTRIBUTE a row for
 * reporting and an indefensible way to decide what a customer EARNS", and these
 * three endpoints are what stop it having to guess.
 *
 * The consequence for this client is the reason `Tills.tsx` shows the branch's
 * boost beside every till rather than only the branch's name: re-pointing a till
 * from Salmiya to Kuwait City changes what customers earn at that counter, and a
 * bare label would read as harmless.
 *
 * ===========================================================================
 * THE GATE IS `perms.dashboard`, ON EITHER SURFACE — AND IT IS NOT SETTINGS'
 * ===========================================================================
 * All three endpoints are `requirePerm(req, 'either', 'dashboard')`. That is a
 * DIFFERENT permission from every other write on the Settings screen, all of
 * which are `perms.loyalty` (`PATCH /salons/{id}` and the three branch routes).
 * `routes/devices.ts` argues the choice: `perms.dashboard` is already the
 * authority over per-branch money truth, and "`team` was the plausible
 * alternative and is wrong: a till is not a person."
 *
 * So the panel that renders these carries its OWN courtesy gate rather than
 * inheriting Settings'. Sharing the screen's `perms.loyalty` gate in either
 * direction is a defect: it would hide the tills from a manager the API would let
 * enrol one, or offer the editor to a `loyalty`-only account whose every read
 * here 403s. `Settings.tsx § THE GATE MOVED FROM THE SCREEN TO THE PANELS` has
 * the change that made room for it.
 *
 * `'either'` is the only dual-surface gate in the API (decision 90) and is not an
 * oddity to route around: the scanner's own "Set up this device" flow is lane B's
 * and calls the same endpoints with the same permission. Nothing here is scanner
 * work.
 */

export const deviceKeys = {
  all: ['devices'] as const,
  /*
   * The salon is in the key for `salonKeys`' reason: a shared front-desk machine
   * signs one session out and the next in, and one salon's till list must not be
   * served to another's. Not built on `salonKeys.detail` — `settings.ts`
   * invalidates that prefix after every salon PATCH and after a branch close, and
   * an enrolment list is not invalidated by a deposit change.
   *
   * A BRANCH CLOSE *DOES* INVALIDATE THIS LIST, and `useCloseBranch` says so at
   * its own call site rather than being folded in here — closing a branch changes
   * whether a till's branch is still open, which is the difference between a
   * working counter and a dead one. See `Tills.tsx § A TILL ON A CLOSED BRANCH`.
   */
  list: (salonId: string) => [...deviceKeys.all, salonId] as const,
};

/**
 * `GET /salons/{id}/devices` — `perms.dashboard`. The salon's LIVE tills.
 *
 * REVOKED ROWS ARE NOT SERVED, and this client must not imply otherwise. The
 * table keeps them — revoking is an UPDATE behind a partial unique index on
 * `revoked_at IS NULL`, deliberately, because "a till that was pointed at Kuwait
 * City while charges went through it stays answerable" — but there is NO endpoint
 * serving that history. `routes/devices.ts` states the reason for serving only
 * the actionable list: "Two answers to 'which tills does this salon have' is the
 * failure this avoids."
 *
 * So no screen may offer a till's history or an audit trail of re-points. Every
 * enrolment, re-point and revoke IS in `audit_log` under kind `rules` with an
 * actor and a timestamp, which the Audit log screen already reads — that is where
 * the trail lives, and pointing at it is honest where inventing a panel would
 * not be.
 *
 * PARSED, NOT CAST. `DeviceEnrolmentSchema` is in `@avo/types` (trunk landed it
 * at cd5c5c3, "taken from the wire rather than the proposal"), so there is no
 * excuse for `authedRequest<DeviceEnrolment[]>` here — a cast compiles whatever
 * arrives, which is exactly how a raw Drizzle row once reached the shell's cache
 * and took the whole dashboard to its error boundary (`api/settings.ts § the
 * PATCH response`). `branchName` is `.nullable()` on that schema and the parse
 * keeps it required, so a server that stopped sending the key fails loudly.
 */
export function useDevices(enabled = true): UseQueryResult<DeviceEnrolment[]> {
  const salonId = useSalonId();
  return useQuery({
    queryKey: deviceKeys.list(salonId),
    queryFn: async ({ signal }) => {
      const body = await authedRequest<unknown>('merchant', `/salons/${salonId}/devices`, {
        signal,
      });
      const items = (body as { items?: unknown }).items;
      return DeviceEnrolmentSchema.array().parse(items);
    },
    enabled,
    /*
     * Restated for `api/bookings.ts`' reason: without it an unreachable API
     * pauses at `status: 'pending'` instead of erroring, and this panel would
     * render skeletons for ever rather than reaching its designed offline state.
     * The `retry` default in main.tsx already refuses to retry a 403, which
     * matters here because `perms.dashboard` is a permission a front-desk account
     * genuinely lacks.
     */
    networkMode: 'always',
  });
}

/**
 * `POST /salons/{id}/devices` — `perms.dashboard`. Enrol, or re-point.
 *
 * ONE ENDPOINT FOR BOTH, and the client does not get to pretend otherwise. A
 * re-point revokes the old row and inserts a new one in one transaction and
 * answers 201; re-posting an enrolment that already names the same branch AND the
 * same label returns the existing row with **200 and writes nothing**.
 *
 * SO THIS HOOK DOES NOT REPORT "CHANGED". It could — `authedRequestDetailed`
 * exists and `products` uses it to tell "Photo added" from "Photo changed" — and
 * it deliberately does not, because the two statuses here do not mean two things
 * a merchant needs told apart. 200 means *the till already stands where you just
 * said it stands*; the truthful confirmation for that is the same as for 201, and
 * a "no change was made" notice on a double-tapped Save would be a state this UI
 * manufactured rather than one the salon is in. The row in the response is the
 * live enrolment either way, which is what the list renders.
 *
 * NO IDEMPOTENCY KEY, and that is the API's decision rather than an omission
 * here. Non-negotiable #4 covers money-MOVING POSTs; this moves none. What
 * `routes/devices.ts` does instead is make the repeat harmless, "so a
 * double-tapped Save does not churn the history the revoke trail depends on."
 *
 * ERRORS WORTH KNOWING, because they decide what the panel can say:
 *
 *   404 unknown_branch  the branch is closed, or is not this salon's. The picker
 *                       only offers OPEN branches, so a merchant should not be
 *                       able to reach this — it is a stale render, not a typo.
 *   400 blank_field     a whitespace-only deviceId or label.
 *
 * A CROSS-TENANT ENROLMENT CANNOT COMMIT — the FK is `(branch_id, salon_id)` —
 * and no message is built for it, because no client can produce one. The 404
 * above is deliberately NOT a 403 for `resolveBranch`'s reason: a 403 would
 * confirm the id names a real branch at some other salon.
 */
export interface EnrolInput {
  deviceId: string;
  branchId: string;
  label: string;
}

export function useEnrolDevice(): UseMutationResult<DeviceEnrolment, unknown, EnrolInput> {
  const salonId = useSalonId();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input) => {
      const body = await authedRequest<unknown>('merchant', `/salons/${salonId}/devices`, {
        method: 'POST',
        body: input,
      });
      return DeviceEnrolmentSchema.parse((body as { device?: unknown }).device);
    },
    /*
     * INVALIDATE, never `setQueryData` and never an optimistic write.
     *
     * The optimistic version of this is specifically wrong rather than merely
     * unnecessary: a row reading "Kuwait City" while the server still has the
     * till at Salmiya is a claim about which multiplier the next customer earns,
     * and it is the same class of lie as a stepper showing a deposit nobody
     * accepted. `Settings.tsx § ModuleRow` refuses an optimistic flip for the
     * same reason one section over. The failed-write path keeps the PREVIOUS
     * assignment on screen, which is only true if nothing was written locally.
     */
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: deviceKeys.list(salonId) });
    },
  });
}

/**
 * `DELETE /salons/{id}/devices/{deviceId}` — `perms.dashboard`. Unbind a till.
 *
 * AN UPDATE, NOT A DELETE. `revoked_at` is set and the row stays; the partial
 * unique index on `revoked_at IS NULL` is what keeps one live row per
 * `(salon, device)`. A second revoke is a 404 rather than a silent success,
 * because the transition is the WHERE clause and the row count decides — so two
 * concurrent revokes produce one revocation and one 404.
 *
 * WHAT IT DOES TO THAT TILL'S NEXT CHARGE, which is the sentence the confirmation
 * on screen is built from: the charge still SUCCEEDS. `enrolledBranchId` becomes
 * null, `resolveBranch` falls back to its own answer, and at a multi-branch salon
 * the row is written `branch_assumed = true` and earns no boost. Revoking
 * degrades attribution and earning; it never refuses money at the counter.
 *
 * That is the exact opposite of what a till left pointing at a CLOSED branch
 * does, and the difference is why `Tills.tsx` treats the two states so
 * differently — see the note there.
 */
export function useRevokeDevice(): UseMutationResult<unknown, unknown, { deviceId: string }> {
  const salonId = useSalonId();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ deviceId }) =>
      authedRequest<unknown>(
        'merchant',
        // The id is a client-chosen string and reaches a path segment, so it is
        // encoded rather than interpolated raw. `requireString(…, 200)` bounds
        // the length server-side; nothing bounds the alphabet.
        `/salons/${salonId}/devices/${encodeURIComponent(deviceId)}`,
        { method: 'DELETE' },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: deviceKeys.list(salonId) });
    },
  });
}
