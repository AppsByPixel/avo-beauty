import { ApiError } from './client.js';

/**
 * THE ONE RETRY POLICY. Every query in the dashboard uses this and none sets its
 * own, because the two things it balances pull in opposite directions and got
 * resolved differently in seven different files.
 *
 * WHAT WENT WRONG. `main.tsx` set a policy that refused to retry a 401 or a 403,
 * for the reason interaction-spec.md §4 gives: a permission refusal asked twice
 * is still a refusal, and "explain, no retry" is broken one layer below the
 * component that implements it. Then seven hooks overrode it with a bare
 * `retry: 1` — `useStaff`, `useSalon`, `useSalonMetrics`, `useRecentActivity`,
 * `useLoyalty`, `useArtists`, `useAuditLog` — plus `useCampaigns` with
 * `retry: false`.
 *
 * Those overrides were not careless. They were buying a SMALLER BUDGET, and the
 * comment on `useSalon` has the measurement: on TanStack's default of three
 * retries with exponential backoff, Settings took about five seconds to show its
 * error while every other section took about two, and five seconds of an
 * apparently-working settings screen is how a merchant concludes a toggle saved.
 *
 * The bug is that a bare number cannot express both. `retry: 1` sets the budget
 * and silently re-enables retrying a 403 — so on a permission failure the
 * merchant waited out a pointless round trip before being told she lacks access.
 * Non-negotiable #7 makes a 403 a NORMAL response on this dashboard, not an
 * anomaly, which is exactly why it must not cost a retry.
 *
 * `api/bookings.ts` had already found this and written it down —
 * "`retry` must stay the DEFAULT FUNCTION, not a number ... copied from the
 * sections that read endpoints with no permission gate" — and the fix stopped at
 * that one hook. This is that fix, generalised, so there is nothing left to copy
 * the wrong pattern from.
 *
 * THE BUDGET IS ONE RETRY, which is what those seven hooks asked for and what the
 * five-seconds-versus-two measurement argues for. It is a reduction from the old
 * global (`failureCount < 2`, so two retries), and it applies to the hooks that
 * were deliberately on the default — `useBookings` and `useCampaigns`. That is
 * the intended direction: no screen in this product benefits from a third silent
 * attempt before it says something.
 */

/** Attempts after the first. Two attempts total on a retryable failure. */
export const RETRY_BUDGET = 1;

/**
 * `error instanceof ApiError`, not `(error as { status?: number }).status`.
 *
 * The old duck-typed read worked, and it also meant the policy silently treated
 * anything without a `.status` as retryable without saying so. Naming the type
 * makes the two non-retryable cases legible, and `ApiError` is the shape every
 * failure out of `request()` already has.
 */
export function retryPolicy(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError) {
    /*
     * 401 — the credential is gone. `authedRequest` has ALREADY rotated once and
     * dropped the session by the time this is reached, so a retry here is a
     * third attempt with nothing new to send, racing the shell's redirect to
     * sign-in.
     */
    if (error.isUnauthenticated) return false;

    /*
     * 403 — the request was understood and refused. An identical request
     * produces an identical refusal, so retrying cannot change the answer and
     * only delays the sentence that explains it. This is the case the seven
     * overrides broke.
     *
     * NOT WIDENED to every 4xx, deliberately. A 400, 404 or 409 is equally
     * unretryable in principle, but nothing in this dashboard currently reaches
     * one on a *read*, and quietly changing behaviour for statuses I have not
     * driven would be inventing policy. Reported rather than assumed.
     */
    if (error.isForbidden) return false;
  }

  /*
   * Everything else gets the budget: a 5xx, a dropped connection, a DNS failure,
   * `ApiError.isConnectivity`. These are the failures a second attempt can
   * genuinely fix, and they are why the budget is not zero.
   */
  return failureCount < RETRY_BUDGET;
}
