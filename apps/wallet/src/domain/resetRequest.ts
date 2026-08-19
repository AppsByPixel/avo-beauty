/**
 * Why a reset-link request was refused — the classifier, as a pure function.
 *
 * EXTRACTED FOR THE STANDING REASON (`orderRefusal.ts`, `loadFailure.ts`,
 * `signup.ts`): no renderer here, so a branch inline in the screen is a branch
 * no test can reach — and this screen's branches are exactly the kind that ship
 * wrong quietly.
 *
 * THE CASE THAT MUST NOT COLLAPSE: the 429. The server throttles BY IP and the
 * throttle answers BEFORE validation (`enforceResetRequestLimits` runs before
 * the body is even read), so under repeat this is the flow WORKING, not failing.
 * `classify()` maps 429 to `kind: 'server'`, so a screen branching on the kind
 * alone would render "we failed on our side" for a refusal that is neither ours
 * nor a failure — the same one-layer-up flattening `useShop` shipped and three
 * screens after it. The code is the discriminator, as `useBooking`'s header
 * establishes for exactly this situation ("the three kinds are not enough").
 *
 * WHAT THIS FUNCTION MUST NEVER RETURN: anything that distinguishes a matched
 * pair from an unmatched one. It classifies THROWN failures only; a 202 never
 * reaches it, and there is no `unknownPhone` member for a branch to reach for.
 * The anti-enumeration property survives client-side by there being no type to
 * express its violation.
 *
 *   throttled   429, either code. The server's own sentence — it names the wait,
 *               and rewriting it here would age exactly like every hardcoded
 *               figure this build has corrected. Not retryable NOW, so no
 *               button; she waits, she does not tap.
 *   offline     her connection. Retry offered — reconnecting is actionable.
 *   invalid     the phone failed validation (invalid_phone 400) — inline, fix
 *               the field. The one case where her input is the problem.
 *   failed      ours. Retry offered.
 */

import { ApiError } from '../api/client';

export type ResetRequestRefusal =
  | { kind: 'throttled'; message: string }
  | { kind: 'offline' }
  | { kind: 'invalid'; message: string }
  /** Ours. The server's sentence when there was one — same fallback as
      `toLoadFailure`, and for the same reason: this runs inside a catch. */
  | { kind: 'failed'; message: string };

/** The two throttle codes, from api/src/services/passwordResetLimit.ts. */
const THROTTLE_CODES = new Set(['reset_hourly_limit', 'reset_rate_limited']);

/**
 * Classify a thrown reset request. Total — a non-ApiError is `failed`, never an
 * escape; this runs inside a catch on a screen a locked-out customer is staring
 * at.
 */
export function resetRequestRefusal(err: unknown): ResetRequestRefusal {
  if (!(err instanceof ApiError)) return { kind: 'failed', message: 'Something went wrong.' };

  // The codes FIRST, before the kind — the order every classifier in this
  // directory writes down: client.ts maps 503/504 to `offline`, so a coded
  // refusal on a 503 must not be read as a dead connection. (429 classifies as
  // `server`, but the order costs nothing and stays uniform with its siblings.)
  if (err.status === 429 || THROTTLE_CODES.has(err.code ?? '')) {
    return { kind: 'throttled', message: err.message };
  }
  if (err.code === 'invalid_phone') {
    return { kind: 'invalid', message: err.message };
  }
  if (err.kind === 'offline') return { kind: 'offline' };
  return { kind: 'failed', message: err.message };
}
