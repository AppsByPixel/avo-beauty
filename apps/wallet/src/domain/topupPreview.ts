/**
 * Wallet · Home → "Top up": what a top-up is worth, PREVIEWED.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THIS FILE EXISTS BECAUSE THE FIGURES WERE RULED IN AND THE CLIENT IS STILL NOT
 * ALLOWED TO INVENT THEM.
 *
 * `components/TopUpCard.tsx` used to open with an argument for why Home carried
 * no "+2.500" under each tile and no you-pay→you-get card: the prototype
 * computed both as `Math.round(amount * RATE)` off the member's tier, and
 * "reproducing that means the client deciding what a top-up is worth". That
 * argument was right about the DANGER and wrong about the only available
 * remedy — it treated "do not compute it here" and "do not show it" as the same
 * decision. They are not. Non-negotiable #2 forbids a client that INVENTS a
 * number; it does not forbid a client that resolves the SAME rule the server
 * resolves, from the same published inputs, using the same shared code.
 *
 * So the figures are back, and none of the arithmetic below is this app's own.
 *
 * WHAT THE SERVER DOES — api/src/services/topup.ts § createTopUp, read, not
 * assumed:
 *
 *     bonusPercent = loyaltyMode === 'stamps' ? 0
 *                  : (tiers.find(t => t.name === member.tier)?.bonusPercent ?? 0)
 *     bonus        = percentOf(amountFils, bonusPercent)
 *
 *     promoInputs  = loadPromotionInputs(tx, salon.id, null)   // branch: NULL
 *     promoPercent = promoInputs && loyaltyMode !== 'stamps'
 *                      ? decideEarning(promoInputs, now).topupBonusPercent : 0
 *     promoBonus   = percentOf(amountFils, promoPercent)
 *
 *     credit       = amount + bonus + promoBonus
 *
 * and `mirrorsTheServer` below is that, line for line, in the same order.
 *
 * THREE THINGS THAT LOOK LIKE DETAILS AND ARE NOT:
 *
 *  1. TWO SEPARATE `percentOf` CALLS, SUMMED — never `percentOf(amount, tier +
 *     promo)`. `percentOf` rounds (`Math.round(amount * percent / 100)`), and
 *     rounding twice is not rounding once: at 2.500 KD with 12.5% + 12.5% the
 *     separate calls give 313 + 313 = 626 fils and the combined 25% gives 625.
 *     Checked, not assumed — and checked the other way too: with today's data
 *     the two spellings AGREE everywhere, because every tier `bonusPercent` and
 *     every `rewardEffect` percentage is a whole number and every amount in
 *     `TOP_UP_AMOUNTS` is a whole dinar, so `amount * percent / 100` never has a
 *     fraction to round. That is exactly why this is worth pinning down in
 *     writing: the divergence is invisible today and arrives the first time
 *     somebody types 12.5 into a tier stepper or adds a 2.500 KD tile. A fils is
 *     not a rounding error when it is the gap between the number she was shown
 *     and the number she was charged, so this does not get "simplified" into one
 *     call.
 *
 *  2. BRANCH IS `null`, DELIBERATELY AND UNCONDITIONALLY. The server passes
 *     `null` for the branch on the top-up path — a top-up happens on a phone,
 *     not at a branch — and `decideEarning` responds by skipping branch boosts
 *     entirely and by matching only `branchId === 'all'` windows. So this
 *     reads NO branch boost and NO branch-scoped window. Including either would
 *     over-promise, which is the failure direction that costs the salon an
 *     argument at the counter.
 *
 *  3. STAMPS MODE ZEROES BOTH HALVES, not just the tier half. A stamps salon has
 *     no tier ladder, and the server guards the promotion read with the same
 *     `loyaltyMode !== 'stamps'`. A stamps salon running a `topup10` window
 *     therefore pays nothing extra, and this must say so too.
 *
 * WHY IT CANNOT DRIFT: every decision above is made by code imported from
 * `@avo/types` — `isHappyHourLive`, `rewardEffect`, `percentOf`, `add`. The only
 * thing this module contributes is the ORDER of the calls, and
 * `topupPreviewParity.test.ts` pins that against the server's own
 * `decideEarning` rather than against a transcription of it.
 *
 * AND WHEN IT DRIFTS ANYWAY: the preview is resolved against THIS device's
 * clock at render; the server locks its answer inside the `POST /topups`
 * transaction, minutes later. A window that closes in between makes the two
 * disagree, and that is not a bug to be engineered away here — it is why the
 * SHEET is authoritative. `useTopUp` renders its calculation card from a real
 * `TopUpIntentPublic`, and `pay()` only fires from the `ready` stage, so the
 * server's locked number is on screen before she commits to anything. This
 * card's job is to help her choose a tile; the intent's job is to be the number
 * she is held to.
 * ═════════════════════════════════════════════════════════════════════════════
 */

import {
  add,
  isHappyHourLive,
  percentOf,
  rewardEffect,
  type Fils,
  type Member,
  type PromotionSet,
  type Salon,
} from '@avo/types';
import { salonOffsetMinutes } from './happyHour';

/** The two percentages the server locks onto a `TopUpIntent`, kept apart. */
export interface BonusPercents {
  /** The member's tier bonus. 0 in stamps mode. */
  tierPercent: number;
  /** Percentage POINTS a live `all`-scoped window adds on top. */
  promoPercent: number;
}

export interface TopUpPreview extends BonusPercents {
  /** `percentOf(amount, tierPercent)` — the server's `bonusFils`. */
  bonusFils: Fils;
  /** `percentOf(amount, promoPercent)` — the server's `promoBonusFils`. */
  promoBonusFils: Fils;
  /** What the tile prints: the whole bonus, both halves together. */
  totalBonusFils: Fils;
  /** `amount + bonus + promoBonus` — the server's `creditFils`. */
  creditFils: Fils;
}

/**
 * The promotion half, with the branch unknown — `decideEarning`'s top-up answer.
 *
 * NOT `activeHappyHour`. That function picks the window CLOSEST TO ENDING,
 * because it answers "which countdown does the banner show". The earning rate is
 * the BEST offer that is live, which is a different question with a different
 * answer whenever two windows overlap — `decideEarning` takes a `Math.max` over
 * every live window and so does this. `domain/happyHour.ts` already records the
 * same distinction for the banner; this is the other side of it.
 */
function livePromoPercent(promotions: PromotionSet, timeZone: string, now: Date): number {
  const offset = salonOffsetMinutes(timeZone, now);
  let best = 0;
  for (const w of promotions.happy) {
    // `branchId: null` on the server ⇒ a branch-scoped window is NOT a match.
    if (w.branchId !== 'all') continue;
    if (!isHappyHourLive(w, now, offset)) continue;
    best = Math.max(best, rewardEffect(w.reward).topupBonusPercent);
  }
  return best;
}

/**
 * The percentages, or null when this app is not entitled to state them.
 *
 * NULL IS RETURNED FOR THREE DIFFERENT REASONS AND THEY ALL MEAN "SAY NOTHING":
 *
 *   - stamps mode: there is no bonus to state, in either half.
 *   - `promotions === null`: the promotions read FAILED (`useWalletHome` treats
 *     it as the one part of the Home snapshot the screen survives without). We
 *     then do not know whether a `topup10` window is live, so every figure we
 *     could print is a claim about her money made from an absent read — the
 *     exact reasoning `BranchEarning` uses to drop its whole section rather than
 *     render "Standard earning" it cannot vouch for. Under-promising is not a
 *     safe default here: she would choose a tile against one number and meet a
 *     larger one in the sheet, which teaches her the card lies.
 *   - both halves are zero: a Bronze member with no live window. "+0.000" under
 *     every tile is noise, and the design prints a bonus only where there is one.
 */
export function bonusPercents(
  member: Member,
  salon: Salon,
  promotions: PromotionSet | null,
  now: Date,
): BonusPercents | null {
  if (salon.loyaltyMode === 'stamps') return null;
  if (!promotions) return null;

  const tierPercent = salon.tiers?.find((t) => t.name === member.tier)?.bonusPercent ?? 0;
  const promoPercent = livePromoPercent(promotions, salon.timezone, now);

  if (tierPercent <= 0 && promoPercent <= 0) return null;
  return { tierPercent, promoPercent };
}

/**
 * What one amount is worth, or null when no figure may be shown.
 *
 * `mirrorsTheServer`: the arithmetic below is `services/topup.ts` in the same
 * order, with the same helpers, and must stay that way. See the header.
 */
export function topUpPreview(
  amount: Fils,
  member: Member,
  salon: Salon,
  promotions: PromotionSet | null,
  now: Date,
): TopUpPreview | null {
  const percents = bonusPercents(member, salon, promotions, now);
  if (!percents) return null;

  const bonusFils = percentOf(amount, percents.tierPercent);
  const promoBonusFils = percentOf(amount, percents.promoPercent);

  return {
    ...percents,
    bonusFils,
    promoBonusFils,
    // Summed, never re-derived from a combined percentage — header note 1.
    totalBonusFils: add(bonusFils, promoBonusFils),
    creditFils: add(add(amount, bonusFils), promoBonusFils),
  };
}
