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
import type { Copy } from '../copy/types';

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

// ---------------------------------------------------- what the screen shows --

/**
 * Which copy a failure screen draws, and whether it offers a retry.
 *
 * A PURE FUNCTION FOR THE SAME REASON THE REST OF THIS MODULE IS ONE. This was
 * three conditional expressions inside `FailureScreen`'s body, where no test
 * here can reach them — and the branch it was missing had shipped: `FailureKind`
 * has three members, the component branched on one, so `offline` rendered the
 * `server` copy and told a customer with no signal that the failure was ours.
 *
 * Returns KEY NAMES rather than sentences. This module has no language and must
 * not choose copy — it decides which of the two dictionaries' entries applies,
 * and `copy` resolves it in the caller's language.
 *
 * `bodyKey: null` means "use the server's own message", which is only ever right
 * on `forbidden`: that refusal carries a written reason and ours would be vaguer
 * than the truth.
 */
export interface FailurePresentation {
  titleKey: 'blockedTitle' | 'offlineColdTitle' | 'errorTitle';
  /** Null = render the server's `message` instead of one of our strings. */
  bodyKey: 'offlineColdBody' | 'errorBody' | null;
  /** False only where retrying cannot change the answer. */
  canRetry: boolean;
}

export function failurePresentation(kind: FailureKind): FailurePresentation {
  switch (kind) {
    case 'forbidden':
      // Asking again cannot change the answer, so no button that would.
      return { titleKey: 'blockedTitle', bodyKey: null, canRetry: false };
    case 'offline':
      // Her connection, not our failure — but reconnecting IS actionable, which
      // is why this keeps the retry that `forbidden` does not.
      return { titleKey: 'offlineColdTitle', bodyKey: 'offlineColdBody', canRetry: true };
    case 'server':
      return { titleKey: 'errorTitle', bodyKey: 'errorBody', canRetry: true };
  }
}

// ------------------------------------------------------ resolved, not keyed --

/**
 * The same decision, with the strings already chosen.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY A SECOND FUNCTION RATHER THAN THREE LINES AT EACH CALL SITE.
 *
 * `failurePresentation` returns KEYS, and turning keys into sentences is three
 * lines: look up the title, and use the server's `message` when `bodyKey` is
 * null. `FailureScreen` wrote those three lines and was correct.
 * `UpcomingFailedCard` did not consult the decision at all — it hardcoded
 * `copy.errorTitle` / `copy.errorBody`, so a customer with no signal was told
 * "We couldn't load your wallet · Your balance and history are safe. This is on
 * our side." while her wallet sat rendered directly above the card, and a 403
 * was offered a Try again.
 *
 * That is the SAME defect `failurePresentation` was extracted to fix, one
 * component over: "`FailureKind` has three members, the component branched on
 * one". Extracting the decision did not stop it recurring, because the decision
 * was still optional to call. So the resolution is a function too — a card that
 * wants failure copy now has one obvious thing to call, and `copy.errorBody`
 * appearing anywhere near a failure branch is visible as a smell rather than as
 * a plausible line.
 *
 * `copy/en.ts` names the rule this enforces, in the comment above
 * `offlineColdTitle`: "`errorBody`'s 'This is on our side' is the other wrong
 * answer — it blames us for her signal."
 * ═════════════════════════════════════════════════════════════════════════════
 */
export interface FailureCopy {
  title: string;
  body: string;
  canRetry: boolean;
}

/**
 * `message` is the SERVER's sentence and is read on the `forbidden` branch only.
 * The other two kinds ignore it and use ours — see `failurePresentation`.
 */
export function failureCopy(kind: FailureKind, message: string, copy: Copy): FailureCopy {
  const { titleKey, bodyKey, canRetry } = failurePresentation(kind);
  return {
    title: copy[titleKey],
    body: bodyKey === null ? message : copy[bodyKey],
    canRetry,
  };
}
