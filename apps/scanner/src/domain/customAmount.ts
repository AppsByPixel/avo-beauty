/**
 * A price a manager typed: what the field accepts, and what the server's
 * refusals say.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE FIELD IS KD. THE WIRE IS FILS. NO FLOAT CROSSES BETWEEN THEM.
 * ═════════════════════════════════════════════════════════════════════════════
 * A staff member types what is on the price list, and the price list is in
 * dinars. So `18.5` is eighteen and a half dinars — 18500 fils — which is also
 * the sentence `fils()` itself puts in its own error: "18.500 KD is
 * fils(18500)". Reading the field as fils instead would make `18.5` a
 * non-integer quantity of the smallest unit, which is not money, and it is the
 * exact mix-up `api/src/money/validate.ts` was written to catch.
 *
 * The conversion is a STRING SPLIT AND INTEGER ARITHMETIC, never a multiply of a
 * parsed float. `Number('1.005') * 1000` is 1004.9999999999999 and
 * `Number('0.1') * 1000` is 100.00000000000001; both reach `fils()` as
 * non-integers and throw, and a `Math.round` on top would be a float quietly
 * deciding a price. Non-negotiable #1 is not a preference here — it is the
 * difference between charging 1.005 and charging 1.004.
 *
 * A FOURTH DECIMAL IS REFUSED RATHER THAN ROUNDED. The dinar has three. A fourth
 * digit means the artist is typing something other than what she thinks she is,
 * and silently dropping it is the float's mistake committed on purpose.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * EVERY CHECK IN HERE IS A COURTESY. THE SERVER IS THE CONTROL.
 * ═════════════════════════════════════════════════════════════════════════════
 * Non-negotiable #7, applied to a money field rather than to a button. The
 * ceiling below is a MIRROR of the server's, the reason length is a mirror of
 * the server's, and neither decides anything: `POST /charges` re-checks both and
 * answers `amount_above_ceiling` / `invalid_request` regardless of what this
 * file believed. What these buy is a sentence at the keyboard instead of a round
 * trip in front of a customer — and `customAmountRefusal` below exists precisely
 * because that is not the same thing as preventing the refusal from arriving.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY THIS IS A MODULE AND NOT AN `onChangeText` HANDLER.
 * ═════════════════════════════════════════════════════════════════════════════
 * The scanner's vitest config is node-only by design ("Component and end-to-end
 * testing is lane D's column"), so a rule that lives inside a component is a rule
 * no test in this package can reach. `deepLink.ts` exists for the same reason and
 * says so. Everything this feature decides is here.
 */

import { fils, type Fils } from '@avo/types';
import { ApiError } from '../api/client';

/**
 * 200.000 KD — a MIRROR of `CUSTOM_AMOUNT_MAX_FILS` in
 * `api/src/services/charge.ts:162`, which is the real one.
 *
 * NOT IMPORTED, because it is not importable: it lives in `api/`, which this app
 * does not and must not depend on, and it is not in trunk-owned
 * `packages/types`. Duplicating a money constant across a lane boundary is a
 * drift risk and it is a real one — if the server raises its ceiling this number
 * goes stale and the field starts refusing figures the server would accept.
 *
 * What makes that survivable is the direction of the failure: a stale mirror
 * refuses EARLY and the server still answers the truth, so the worst case is an
 * unnecessarily strict keyboard, never a charge the server would have refused.
 * Wanting it in `packages/types` is reported rather than done — that is a trunk
 * change, not a lane B one.
 */
export const CUSTOM_AMOUNT_MAX_FILS: Fils = fils(200_000);

/** Mirror of `requireString(body.reason, 'reason', 300)` in the charge route. */
export const REASON_MAX_CHARS = 300;

/** The dinar's three decimal places. */
const FILS_PER_KD = 1000;
const DECIMALS = 3;

/** Long enough for any price a salon charges, short enough not to overflow. */
const MAX_INTEGER_DIGITS = 9;

export type TypedAmount =
  /** Nothing typed yet. Not an error — do not shout at an empty field. */
  | { state: 'empty' }
  | { state: 'invalid'; why: 'not-a-number' | 'too-precise' | 'zero' }
  /**
   * A legible figure that is simply too big. Its own state, not folded into
   * `invalid`, because it is the one refusal where her number can be shown back
   * to her — "250.000 KD is over the 200.000 KD limit" — rather than telling her
   * the typing is malformed.
   */
  | { state: 'above-ceiling'; amountFils: Fils }
  | { state: 'ok'; amountFils: Fils };

/** Western digits only, one optional point, at most three places after it. */
const SHAPE = /^(\d*)(?:\.(\d*))?$/;

/**
 * A typed KD string to a whole number of fils.
 *
 * Accepts: `18`, `18.5`, `18.50`, `18.500`, `.5`, and surrounding whitespace.
 * Refuses: a fourth decimal, zero, a sign, a comma, a thousands space,
 * exponent notation, Arabic-Indic digits (non-negotiable #12 — money is Western
 * digits), and anything longer than a price.
 */
export function parseTypedKd(raw: string): TypedAmount {
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === '.') return { state: 'empty' };

  const match = SHAPE.exec(trimmed);
  if (!match) return { state: 'invalid', why: 'not-a-number' };

  const whole = match[1] ?? '';
  const fraction = match[2] ?? '';

  // `.` alone is caught above; `5.` is a half-typed `5.x` and reads as 5.000.
  if (whole === '' && fraction === '') return { state: 'invalid', why: 'not-a-number' };
  if (whole.length > MAX_INTEGER_DIGITS) return { state: 'invalid', why: 'not-a-number' };
  if (fraction.length > DECIMALS) return { state: 'invalid', why: 'too-precise' };

  /**
   * THE CONVERSION. Two integer parses, one integer multiply, one integer add.
   * `whole` and `padded` are digit strings of bounded length, so `Number()` on
   * each is exact; `× 1000` on a safe integer is exact; the sum of an integer and
   * a value below 1000 is exact. No float exists at any point in this expression.
   */
  const padded = (fraction + '0'.repeat(DECIMALS)).slice(0, DECIMALS);
  const amount = Number(whole === '' ? '0' : whole) * FILS_PER_KD + Number(padded);

  if (!Number.isSafeInteger(amount)) return { state: 'invalid', why: 'not-a-number' };
  if (amount === 0) return { state: 'invalid', why: 'zero' };
  if (amount > CUSTOM_AMOUNT_MAX_FILS) {
    return { state: 'above-ceiling', amountFils: fils(amount) };
  }
  return { state: 'ok', amountFils: fils(amount) };
}

/**
 * Whether the Charge button may be enabled.
 *
 * Both halves, because the server requires both: an `amountFils` with no
 * `reason` is `400 invalid_request`, and the reason is the only thing that will
 * ever answer "what was this for" — a custom charge has no service row anywhere
 * and `best-selling-services` cannot attribute it.
 *
 * A courtesy, again. `submit` re-reads the parse rather than trusting that a
 * disabled button was the thing that stopped a bad request.
 */
export function typedChargeReady(amount: TypedAmount, reason: string): boolean {
  if (amount.state !== 'ok') return false;
  const trimmed = reason.trim();
  return trimmed.length > 0 && trimmed.length <= REASON_MAX_CHARS;
}

export interface CustomAmountRefusal {
  /** What to put in front of the artist. The server's own words where it has them. */
  body: string;
  /** A scanner-written line naming what she was doing. Null when it adds nothing. */
  hint: string | null;
  /** Re-read authority: the server disagreed with our cached `perms`. */
  rereadPerms: boolean;
  /**
   * The outcome of an EARLIER request under this key is unknown, so the screen
   * must add the check-her-balance line rather than implying nothing happened.
   */
  outcomeUnknown: boolean;
  /** Nothing left the device, so the outcome is not in doubt. */
  offline: boolean;
}

/**
 * The server's refusal, turned into something readable at a counter.
 *
 * THE PRINCIPLE: render the server's sentence, do not replace it. Every message
 * this endpoint produces is written and several are asserted verbatim elsewhere,
 * so paraphrasing them would both break those assertions and hide which check
 * actually fired. Two codes get scanner-written text instead, and both are
 * called out at the branch.
 */
export function customAmountRefusal(err: ApiError): CustomAmountRefusal {
  const base: CustomAmountRefusal = {
    body: err.message,
    hint: null,
    rereadPerms: false,
    outcomeUnknown: false,
    offline: false,
  };

  if (err.kind === 'offline') {
    return { ...base, offline: true };
  }

  /**
   * THE PERMISSION-OFF CASE — the whole point of non-negotiable #7 on this
   * control. The entry control is hidden from a staff member whose session does
   * not carry `perms.void`, and that hiding decides nothing: a cached
   * `perms.void: true` against a server that has since revoked it sends the
   * figure and gets this back.
   *
   * VERBATIM, AND IT NAMES THE WRONG CAPABILITY ON PURPOSE. The sentence is
   * `PERMISSION_COPY.void` — "You don't have permission to VOID a charge" —
   * because the gate genuinely is `perms.void`. The API's own comment concedes
   * `perms.customAmount` would be the honest gate and is a four-way break a lane
   * may not make. Rewriting it here would hide which permission was refused from
   * the person who has to go ask for it, so the scanner adds a line rather than
   * replacing one.
   */
  if (err.status === 403) {
    return {
      ...base,
      hint: 'Typing a price needs the same authority as voiding one.',
      rereadPerms: true,
    };
  }

  /**
   * THE REUSED KEY, AND IT IS NOT "NOTHING HAPPENED".
   *
   * `idempotency_key_reused` means this key already carries a DIFFERENT body.
   * The request just refused did nothing — but the earlier one it was compared
   * against may well have charged. So the refusal that reads as reassuring is
   * the dangerous one, and this is the same doubt the unreadable-response path
   * has: `outcomeUnknown` makes the screen add the check-her-balance line.
   *
   * The server's copy — "Use a new key" — is written for a client, not for a
   * woman holding a card reader, so it is the one message here replaced rather
   * than rendered.
   *
   * The screen mints a fresh key whenever the figure or the reason changes, so
   * its own flow does not produce this; it is rendered anyway because a generic
   * failure would tell her nothing about a charge that may have landed.
   */
  if (err.code === 'idempotency_key_reused') {
    return {
      ...base,
      body: 'That figure changed after the charge was sent. The earlier amount may already have gone through.',
      outcomeUnknown: true,
    };
  }

  return base;
}
