/**
 * The brand colour, validated the way non-negotiable #9 says it must be.
 *
 * #9, second clause, verbatim: "Validate derived variants at white-label
 * onboarding with `deriveBrandSet()`; reject a hex that cannot produce a 4.5:1
 * fill."
 *
 * THE DEFECT THIS CLOSES
 * ----------------------
 * Nothing did it. `brandColor` has been in `EDITABLE` in routes/salons.ts since
 * that route was written, and the only guard on the way to the column was
 * `salon_brand_color_is_hex` — a six-hex-digit regex, which `#FFFF00` passes.
 * So `PATCH /salons/{id} { "brandColor": "#FFFF00" }` stored yellow, and every
 * surface then rendered white text on a fill measuring 1.25:1 against it.
 *
 * Worse, two files ASSERTED the validation existed. `db/schema/salon.ts` said
 * the column was "validated through deriveBrandSet() at onboarding", and
 * `apps/dashboard/src/shell/useBrandTheme.ts` said onboarding was where a bad hex
 * should be rejected "at the point of entry". Both were describing this module
 * before it existed. That is the third stale-comment-as-guarantee this build has
 * paid for, and it is the expensive kind: a comment claiming a check exists stops
 * the next reader looking for it.
 *
 * BOTH DOORS, ONE FUNCTION
 * ------------------------
 * `POST /v1/platform/salons` and `PATCH /salons/{id}` both call this. A validator
 * living on the create path only would be the same shape of hole the tier ladder
 * had — and the update door is the one that matters more here, because it is the
 * one a merchant reaches every day from her own Settings screen.
 *
 * THE MESSAGE IS THE DERIVER'S OWN
 * --------------------------------
 * `deriveBrandSet` returns `reason` written for a human at onboarding — it names
 * the hex, the ratio it actually reaches, the floor it needed, and what to do
 * instead ("Pick a deeper shade of the same colour"). Restating that here would
 * produce a second, worse sentence about the same maths, and the two would drift.
 * So the refusal carries `reason` verbatim, and `bestContrast` alongside it so a
 * UI can show the number without re-deriving it.
 *
 * THE HEX SHAPE IS CHECKED FIRST, AND SEPARATELY. `deriveBrandSet` normalises by
 * prepending '#' and upper-casing, and does not validate at all — `hexToRgb` on
 * "blue" yields NaN and the maths quietly produces a rejection whose numbers mean
 * nothing. The regex here is `salon_brand_color_is_hex` restated, so a value that
 * passes this function cannot be refused by the database with a 500. Same
 * relationship `parseDepositFils` has with `salon_deposit_in_range`: the CHECK is
 * the guarantee, this is the explanation.
 */

import { deriveBrandSet } from '@avo/tokens';
import { badRequest } from '../http/errors';

/** `salon_brand_color_is_hex`, restated. The database is the authority. */
const HEX = /^#[0-9A-Fa-f]{6}$/;

/**
 * A hex a white-label salon can actually be built out of, or a 400.
 *
 * Returned VERBATIM (trimmed), not normalised to the deriver's upper case. The
 * stored value is the merchant's own hex — it is what her brand guide says and
 * what `PATCH` has always round-tripped — and case-folding it here would silently
 * rewrite every existing row's spelling the next time it was touched. The
 * refusal message quotes the deriver's upper-cased form because that is the form
 * the contrast maths ran on.
 */
export function parseBrandColor(value: unknown, field = 'brandColor'): string {
  if (typeof value !== 'string') {
    throw badRequest('invalid_brand_color', `${field} must be a hex colour like #6E7F6C.`);
  }
  const hex = value.trim();
  if (!HEX.test(hex)) {
    throw badRequest(
      'invalid_brand_color',
      `${field} must be a six-digit hex colour like #6E7F6C.`,
    );
  }

  const derived = deriveBrandSet(hex);
  if (!derived.ok) {
    /**
     * 400 and not 422: the body is well-formed and this one field is wrong, which
     * is what every other named-field refusal on these two routes answers —
     * `deposit_out_of_range`, `invalid_no_show_window`, `invalid_tier`. 422 on
     * these routes means "the same idempotency key with a different body", and
     * borrowing it for a colour would blur a status the console switches on.
     */
    throw badRequest('brand_color_not_viable', derived.reason, {
      field,
      /** 'white-on-deep' | 'deep-on-tint' — WHICH pairing failed. */
      failed: derived.failed,
      /** The best ratio reachable inside the shift budget, e.g. 4.25. */
      bestContrast: derived.bestContrast,
    });
  }

  return hex;
}
