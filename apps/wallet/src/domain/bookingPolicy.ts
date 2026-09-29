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
 *   - after a late reschedule, the SMALLER of that and `returnCapPercent`, the
 *     percent she held when she moved (DECISIONS.md, "Reschedule loophole: lane
 *     A's reading, accepted"; trunk 7646bb8);
 *   - `returnPercent` of integer fils ROUNDED DOWN, the salon keeps the
 *     remainder fil. 50% of 5.005 KD is 2.502 back and 2.503 kept.
 *
 * The rounding is `percentOfFloor` from @avo/types, the one the server's split
 * is owed to use too. NOT `percentOf`, which rounds half up and returns 2503 for
 * that case.
 */

import {
  fils,
  percentOfFloor,
  subtract,
  type BookingPolicy,
  type BookingPolicyStamp,
  type CancellationRule,
  type Fils,
  type Language,
} from '@avo/types';
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
 * `returnPercent` of the deposit, rounded DOWN to the fil, and the remainder
 * the salon keeps — `splitDeposit` in api/src/services/bookingPolicy.ts. The
 * floor is `percentOfFloor`'s, which refuses a fractional or out-of-range
 * percent with a RangeError. No float holds a fil.
 */
export function splitDeposit(
  deposit: Fils,
  returnPercent: number,
): { returnedFils: Fils; keptFils: Fils } {
  const returnedFils = percentOfFloor(deposit, returnPercent);
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
 * header. `cancellationOutcome` on the server, line for line, including the cap:
 * `capPercent` is the booking's `returnCapPercent`, and the preview takes the
 * smaller of it and the new slot's rule. Without it, a booking moved late from
 * 50% to next week would read 100% here while the server pays 50%.
 *
 * When the cap binds, `rule` is the stamped rule whose percent it equals (the
 * one that applied at the move), or null when no rule does.
 */
export function cancelPreview(
  rules: readonly CancellationRule[],
  startsAt: string,
  now: Date,
  depositFils: number,
  capPercent: number | null = null,
): CancelPreview {
  const deposit = fils(depositFils);
  const aheadMs = new Date(startsAt).getTime() - now.getTime();
  const matched = rules.find((r) => aheadMs >= r.hoursBefore * 3_600_000) ?? null;
  const byRules = matched ? matched.returnPercent : 0;
  if (capPercent === null || capPercent >= byRules) {
    return { rule: matched, returnPercent: byRules, ...splitDeposit(deposit, byRules) };
  }
  const rule = rules.find((r) => r.returnPercent === capPercent) ?? null;
  return { rule, returnPercent: capPercent, ...splitDeposit(deposit, capPercent) };
}
