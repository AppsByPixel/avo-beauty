/**
 * The salon's own booking policy, as she reads it (migration 0066).
 *
 * DECISIONS.md § "The fourth list, 2026-09-29, and four rulings from Aftab",
 * "Booking deposit: the salon's own policy replaces the return window", is the
 * specification. `api/src/services/bookingPolicy.ts` is the implementation this
 * file mirrors, and only for DISPLAY.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE PREVIEW IS A SENTENCE, NOT A DECISION
 * ═══════════════════════════════════════════════════════════════════════════
 * Non-negotiable #2: the server owns the balance. `cancelPreview` tells her,
 * before she taps, what the stamped rule would return at this moment. It never
 * decides anything: the cancel is sent regardless of what it says, and the
 * server's `refundedFils` / `keptFils` are what the card shows afterwards. The
 * two can differ — she can cross a cut-off between reading and tapping, and
 * the device clock is not the server's — and when they do the server's wins.
 *
 * It still has to be the SAME arithmetic, or the preview is a promise the
 * server breaks every time a deposit does not divide evenly:
 *   - "the first rule whose threshold she meets wins", measured in ms against
 *     `startsAt`, rules stored earliest cut-off first;
 *   - later than every threshold returns 0%;
 *   - `returnPercent` of integer fils ROUNDED DOWN, the salon keeps the
 *     remainder fil. 50% of 5.005 KD is 2.502 back and 2.503 kept.
 *
 * `percentOf` from @avo/types is NOT used, for the reason lane A's
 * `splitDeposit` gives: it rounds half-up through a float division and returns
 * 2503 for that case. The floor lives here until trunk lands the
 * `percentOfFloor` lane A recommended in 54308ea; both copies should then import
 * it. Reported, not added to @avo/types from a lane.
 */

import { fils, subtract, type BookingPolicy, type BookingPolicyStamp, type CancellationRule, type Fils, type Language } from '@avo/types';
import type { Copy } from '../copy/types';

/** What both a published policy and a booking's stamp carry. */
export type PolicyTerms = Pick<BookingPolicy | BookingPolicyStamp, 'noShow' | 'cancellation' | 'text'>;

// ------------------------------------------------------------------ text --

/**
 * The salon's own words, in the reading language when she wrote them in it.
 *
 * `ar` is '' when the salon wrote English only (`BookingPolicyTextSchema`), and
 * falls back to `en` — as `LegalDoc` does. `lang` is the language OF THE TEXT,
 * so a caller sets an English paragraph in the Latin face inside an Arabic
 * build, rather than forcing English through the Arabic one (`PolicySheet`'s
 * rule for the legal set).
 */
export function policyText(
  text: PolicyTerms['text'],
  lang: Language,
): { body: string; lang: Language } {
  if (lang === 'ar' && text.ar.trim() !== '') return { body: text.ar, lang: 'ar' };
  return { body: text.en, lang: 'en' };
}

// --------------------------------------------------------------- summary --

/** The two plain lines under the title: what a no-show does, what a cancel returns. */
export function policySummary(terms: Pick<PolicyTerms, 'noShow' | 'cancellation'>, copy: Copy): {
  noShow: string;
  cancel: string;
} {
  const noShow = terms.noShow === 'keep' ? copy.policyNoShowKeep : copy.policyNoShowReturn;
  if (terms.cancellation.length === 0) return { noShow, cancel: copy.policyCancelNothing };
  const parts = terms.cancellation.map((r, i) => copy.policyCutoff(r.hoursBefore, r.returnPercent, i === 0));
  // The tail only when something is still returned at the last cut-off. After a
  // 0% rule "later: nothing back" restates what the rule just said.
  const last = terms.cancellation[terms.cancellation.length - 1]!;
  if (last.returnPercent > 0) parts.push(copy.policyCutoffLater);
  return { noShow, cancel: parts.join(' · ') };
}

// ----------------------------------------------------------------- maths --

/**
 * `returnPercent` of the deposit, rounded DOWN to the fil. Integer arithmetic
 * throughout, exactly `splitDeposit` in api/src/services/bookingPolicy.ts: the
 * product is an exact integer, subtracting its remainder mod 100 leaves an
 * exact multiple of 100, and that division is exact. No float holds a fil.
 */
export function splitDeposit(
  deposit: Fils,
  returnPercent: number,
): { returnedFils: Fils; keptFils: Fils } {
  if (!Number.isSafeInteger(returnPercent) || returnPercent < 0 || returnPercent > 100) {
    throw new RangeError(`returnPercent must be a whole number 0–100, got ${returnPercent}`);
  }
  const product = deposit * returnPercent;
  const returnedFils = fils((product - (product % 100)) / 100);
  return { returnedFils, keptFils: subtract(deposit, returnedFils) };
}

export interface CancelPreview {
  rule: CancellationRule | null;
  returnPercent: number;
  returnedFils: Fils;
  keptFils: Fils;
}

/**
 * What cancelling at `now` would return under `rules`. Display only — see the
 * header. `cancellationOutcome` on the server, line for line.
 */
export function cancelPreview(
  rules: readonly CancellationRule[],
  startsAt: string,
  now: Date,
  depositFils: number,
): CancelPreview {
  const aheadMs = new Date(startsAt).getTime() - now.getTime();
  const rule = rules.find((r) => aheadMs >= r.hoursBefore * 3_600_000) ?? null;
  const returnPercent = rule ? rule.returnPercent : 0;
  return { rule, returnPercent, ...splitDeposit(fils(depositFils), returnPercent) };
}
