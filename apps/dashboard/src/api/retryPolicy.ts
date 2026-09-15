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
     * STILL NOT WIDENED TO EVERY 4xx — but 404 is now in, and the paragraph that
     * used to sit here is why it took a while. It read: "A 400, 404 or 409 is
     * equally unretryable in principle, but nothing in this dashboard currently
     * reaches one on a *read*, and quietly changing behaviour for statuses I have
     * not driven would be inventing policy."
     *
     * That was true and it named its own trigger. `GET /v1/platform/salons/:id`
     * fired it: the console's per-salon editor is the first screen in this
     * dashboard that can 404 on a READ, and it does so on an ordinary path — a
     * bookmarked editor URL, or a salon id pasted out of a support ticket.
     *
     *     GET /v1/platform/salons/SAL-NOPE
     *       → 404 {"error":"unknown_salon","message":"No such salon."}
     *
     * So it is driven now rather than assumed, and the reasoning is the 403's
     * word for word: the request was understood, an identical one produces an
     * identical answer, and the budget only delays the sentence. What the delay
     * costs here is specific — the editor holds a full-page skeleton through two
     * attempts and a backoff before admitting the salon does not exist, which
     * reads as a slow load rather than as an answer.
     *
     * AND NOW 400, BY THE SAME RULE AND ON THE SAME EVIDENCE. The paragraph this
     * replaces said "400 and 409 stay out ... no read in this dashboard produces
     * either". That has expired for 400 exactly as it expired for 404: Reports'
     * window controls are the first thing in this dashboard that lets a person
     * compose a malformed READ, and `?period=` is the parameter she composes.
     *
     * DRIVEN, not assumed — the standard this comment sets for itself. Against
     * the real API on `avo_lane_c`, with From after To, five cards each asked
     * twice and held their skeletons through a backoff:
     *
     *     GET /salons/SAL-AMARA/reports/customers?period=2026-09-20_2026-09-16
     *       → 400 {"error":"invalid_period","message":"period starts after it
     *              ends: 2026-09-20 is later than 2026-09-16."}
     *
     * The server answered in one round trip with a sentence naming the fix, and
     * the budget bought a second identical refusal before that sentence appeared.
     * Same reasoning as the 403 and the 404, word for word: the request was
     * understood, an identical one produces an identical answer, and the budget
     * only delays the sentence.
     *
     * 409 STAYS OUT, and deliberately so rather than by omission: no read in this
     * dashboard produces one, `namedStateAnswer` already treats a served 409 as
     * an ANSWER rather than a failure where one appears, and widening on
     * principle rather than on a driven case is what this comment exists to
     * prevent.
     */
    if (error.isForbidden) return false;
    if (error.status === 404) return false;
    if (error.status === 400) return false;
  }

  /*
   * Everything else gets the budget: a 5xx, a dropped connection, a DNS failure,
   * `ApiError.isConnectivity`. These are the failures a second attempt can
   * genuinely fix, and they are why the budget is not zero.
   */
  return failureCount < RETRY_BUDGET;
}
