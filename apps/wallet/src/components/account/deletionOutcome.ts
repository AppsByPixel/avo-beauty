/**
 * What the delete sheet does with each answer the server can give.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY THIS IS A MODULE AND NOT STILL INLINE IN THE SHEET
 *
 * `POST /members/me/deletion` has three outcomes and `DELETE` has two, and the
 * whole point of the sheet is that they must NOT collapse into one "try again":
 *
 *   401  the password did not match AND NOTHING HAPPENED. No clock started, so
 *        she can simply retype. This must not read like an outage.
 *   409  she still holds credit. Refused deliberately, and the amount she is
 *        being told to spend has to be the SERVER's — non-negotiable #2.
 *   200  the clock is running, on the server's `graceDays`.
 *
 *   DELETE 200  cancelled.
 *   DELETE 404  `no_deletion_request` — there was nothing to cancel, which is
 *               the outcome she asked for and not a failure. Reachable for real:
 *               a second device, or a sheet left open while the request was
 *               cancelled elsewhere.
 *
 * Those five decisions were inline in the component, where nothing without a
 * renderer could reach them — and this workspace has no renderer (no jsdom, no
 * @testing-library, and react-test-renderer is gone in React 19). Adding one
 * would rewrite the trunk-owned `pnpm-lock.yaml`, which is not a lane B call.
 *
 * So the decisions live here, as two pure functions the sheet calls, and both
 * were re-driven against the real API after the extraction.
 *
 * ONE BEHAVIOUR DID CHANGE, deliberately. The sheet's old `balanceFromError`
 * accepted any finite number, so a float `balanceFils` would have been formatted
 * into the refusal. `Number.isInteger` now rejects it and the sheet falls back to
 * the prop. Non-negotiable #1: money is integer fils, and a float arriving here
 * means the contract is broken upstream — worth showing as a stale figure rather
 * than laundering into a confident sentence about 24.5001 KD.
 * ═════════════════════════════════════════════════════════════════════════════
 */

import { ApiError } from '../../api/client';

/** The API's code for "you still hold credit", which carries the figure. */
export const BALANCE_OUTSTANDING = 'balance_outstanding';

/** The API's code for "there was nothing pending to cancel". */
export const NO_DELETION_REQUEST = 'no_deletion_request';

export interface SubmitFailure {
  /**
   * What the sheet shows. The SERVER's sentence on a refusal it authored —
   * following ChangePasswordSheet, because "That password does not match." tells
   * her to retype where a generic failure tells her to give up.
   */
  message: string;
  /**
   * The server's balance off a 409, authoritative over the prop the sheet was
   * opened with. Non-negotiable #2: the server owns the balance, which includes
   * owning it inside an error. The prop can be minutes stale from the Account
   * screen's last read, and telling her to spend 0.000 when she holds 24.500
   * sends her to the salon for nothing.
   *
   * Null on every other outcome, which leaves the sheet showing the prop.
   */
  serverBalanceFils: number | null;
}

/** The server's figure off a 409. Integer fils only — never a float. */
function balanceFromDetails(details: Record<string, unknown>): number | null {
  const value = details['balanceFils'];
  // `Number.isInteger` rather than `isFinite`: money is integer fils
  // (non-negotiable #1), and a float here means the contract is broken
  // upstream, not that the sheet should round it into a sentence.
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

/**
 * Classify a failed deletion request.
 *
 * `fallback` is the screen's generic error copy, used only when the failure did
 * not come from the API at all — a thrown TypeError, a transport fault the
 * client did not wrap. An `ApiError` always carries a message worth showing.
 */
export function deletionSubmitFailure(err: unknown, fallback: string): SubmitFailure {
  if (err instanceof ApiError) {
    return {
      message: err.message,
      serverBalanceFils:
        err.code === BALANCE_OUTSTANDING ? balanceFromDetails(err.details) : null,
    };
  }
  return { message: fallback, serverBalanceFils: null };
}

/**
 * Is this failed cancel actually the outcome she wanted?
 *
 * Only the API's own `no_deletion_request` counts. A 500 is not "already
 * cancelled", and treating it as such would tell her the clock had stopped when
 * it had not — the one lie this sheet cannot afford.
 */
export function isAlreadyCancelled(err: unknown): boolean {
  return err instanceof ApiError && err.code === NO_DELETION_REQUEST;
}
