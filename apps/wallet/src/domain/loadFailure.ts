/**
 * A thrown request, reduced to what a failure screen needs — as a pure function.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * EXTRACTED FOR THE REASON `orderRefusal.ts`, `deletionOutcome.ts` AND
 * `signup.ts` ALL STATE: this workspace has no renderer, so a branch left inline
 * in a hook is a branch no test can reach. This mapping existed THREE times —
 * `useBooking.ts`, `useTopUp.ts` (as a quote-specific variant, left alone) and a
 * third copy added to `useShop.ts` — and none of the three had a spec.
 *
 * WHAT IT IS FOR, AND WHY THE `kind` IS THE WHOLE POINT
 * ----------------------------------------------------
 * `FailureScreen` branches on exactly one field: `canRetry = kind !== 'forbidden'`.
 * So a caller that flattens the kind decides, by omission, that a 403 gets a Try
 * again button — and a retry on a 403 "teaches a customer that the app is broken"
 * (that component's own header). `useShop` did exactly this: it stored the
 * reference and dropped the kind, then passed a literal `kind="server"`.
 *
 * The non-`ApiError` fallback is `server`, deliberately: an exception we cannot
 * classify is ours, not hers, and `server` is the kind that offers a retry. The
 * placeholder reference is what support sees when there was no request id to
 * quote — it must be a real-looking token rather than an empty string, because
 * the failure screen renders it after "Reference · " either way.
 *
 * `message` is load-bearing ONLY on the `forbidden` branch, where the screen
 * shows the server's own sentence instead of ours. Every other kind renders
 * `copy.errorBody`. That asymmetry is why the message is carried rather than
 * resolved here: this module has no language and must not choose copy.
 * ═════════════════════════════════════════════════════════════════════════════
 */

import { ApiError, type FailureKind } from '../api/client';

/** What a failed load leaves behind for the screen. */
export interface LoadFailure {
  kind: FailureKind;
  message: string;
  reference: string;
  /** The API's `error` field, when it sent one. */
  code: string | null;
}

/** Shown when there was no request id to quote. */
export const NO_REFERENCE = 'WLT-0000-0000';

/**
 * Reduce a thrown value to a `LoadFailure`.
 *
 * Total by construction — every path returns and nothing here can throw. It runs
 * inside a `catch`, so an escape would replace a failure the customer can act on
 * with a blank screen.
 */
export function toLoadFailure(err: unknown): LoadFailure {
  if (err instanceof ApiError) {
    return { kind: err.kind, message: err.message, reference: err.reference, code: err.code };
  }
  return { kind: 'server', message: 'Something went wrong.', reference: NO_REFERENCE, code: null };
}
