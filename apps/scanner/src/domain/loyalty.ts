/**
 * The loyalty line on the result screen, and the pill on the member card.
 *
 * design/AVO Staff Scanner.dc.html:610-612 drew the line as "Stamp added · 5 of
 * 8" / "Visit added · 5 of 10 to Gold". Aftab's ruling of 2026-09-29 (DECISIONS.md
 * § "The fourth list") is that it says what she GAINED: "+1 visit · 2 more to
 * Gold", or the stamp equivalent. See `loyaltyGain`.
 */

import type { ChargeResult, LoyaltyOutcome } from '../api/charges';
import { copy } from '../copy/en';

/** Tier names arrive lowercase from the API; the design renders them titled. */
export function tierLabel(tier: string | null): string {
  if (!tier) return '';
  return tier.charAt(0).toUpperCase() + tier.slice(1);
}

/**
 * The line under "Loyalty" on the result screen: what this visit earned, then
 * where it leaves her.
 *
 *   tiers   "+1 visit · 2 more to Gold"            climbing
 *           "+1 visit · Reached Gold"               this charge crossed a rung,
 *                                                   or she is at the top
 *   stamps  "+1 stamp · 5 of 8"
 *           "+1 stamp · Reward ready"               the card is full
 *
 * with the multiplier's name between the two when the server says one applied:
 * "+2 stamps · Double stamps · 6 of 8".
 *
 * EVERY PART IS THE SERVER'S. The count is `visitsEarned` / `stampsEarned`, the
 * progress is the outcome's after-state, the multiplier is `happyHour`. Nothing
 * here is a before-and-after subtraction, and nothing infers a count from a
 * multiplier: `happyHour` is null under a branch boost that still doubled the
 * visit (api/charges.ts § visitsEarned), so "no happy hour, so +1" would be a
 * false sentence at the counter.
 *
 * THE COUNT IS ALWAYS THERE. The first clause used to fall back to the design's
 * "Visit added" / "Stamp added" while the API did not send the count; since lane
 * A's eefccb1 it always does, the schema requires it, and the fallback is gone.
 * The line renders exactly the number the server applied — the server's
 * multiplier floor is 1 (services/promotions.ts § decideEarning), so a charge
 * never reports 0, and if one ever did this would say so rather than guess.
 */
export function loyaltyGain(
  outcome: LoyaltyOutcome,
  happyHour: ChargeResult['happyHour'],
): string {
  if (outcome.mode === 'stamps') {
    return [
      copy.loyaltyStampsEarned(outcome.stampsEarned),
      happyHour ? multiplierLabel('stamp', happyHour.stampMultiplier) : null,
      outcome.rewardReady
        ? copy.loyaltyRewardReady
        : copy.loyaltyStampProgress(outcome.stamps, outcome.target),
    ]
      .filter(Boolean)
      .join(' · ');
  }

  return [
    copy.loyaltyVisitsEarned(outcome.visitsEarned),
    happyHour ? multiplierLabel('visit', happyHour.visitMultiplier) : null,
    tierProgress(outcome),
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * "Reached Gold" when this charge crossed a rung — the news, even with a rung
 * still ahead — and at the top of the ladder, where there is no next rung for a
 * "more to" clause to name. Otherwise how many visits the next rung is away.
 * A salon with no ladder at all has neither, and the line stops at the count.
 */
function tierProgress(outcome: Extract<LoyaltyOutcome, { mode: 'tiers' }>): string | null {
  if (outcome.climbed && outcome.tier !== null) {
    return copy.loyaltyReached(tierLabel(outcome.tier));
  }
  if (outcome.nextTier !== null && outcome.visitsToNext !== null) {
    return copy.loyaltyToNext(outcome.visitsToNext, tierLabel(outcome.nextTier));
  }
  return outcome.tier !== null ? copy.loyaltyReached(tierLabel(outcome.tier)) : null;
}

/** Only the multipliers the bundle has words for; anything else says nothing. */
function multiplierLabel(kind: 'visit' | 'stamp', multiplier: number): string | null {
  if (kind === 'visit') return multiplier === 2 ? copy.loyaltyMultiplier.x2visit : null;
  if (multiplier === 2) return copy.loyaltyMultiplier.x2stamp;
  if (multiplier === 3) return copy.loyaltyMultiplier.x3stamp;
  return null;
}

/**
 * The tier beside her name on the result screen — "Latifa A. · Silver".
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THIS DEVIATES FROM THE DESIGN, deliberately (trunk's ruling, 2026-09-29).
 * design:381 renders `Latifa A. · {{ loyaltyPill }}`, and the prototype's
 * `loyaltyPill` is the member card's pill from BEFORE the charge. So on a charge
 * that climbed a rung the screen read "Latifa A. · Silver" directly above the
 * Loyalty row's "Reached Gold": two tiers for one woman, one screen apart, and
 * the counter reads the wrong one out to her.
 *
 * When the charge climbed, the sub-line shows the tier AFTER it: the server's
 * `loyalty.tier`, the same field "Reached Gold" is drawn from. Nothing is
 * evaluated here (non-negotiable #2); `climbed` is the server's too. Every
 * other case keeps the pill exactly as MemberScreen drew it, which is still the
 * design's: no climb, a stamps salon (whose "4 / 8" pill this ruling does not
 * cover), an API too old to send `climbed`, or a climb to no tier at all.
 * ═════════════════════════════════════════════════════════════════════════════
 */
export function resultPill(pillBeforeCharge: string, outcome: LoyaltyOutcome): string {
  if (outcome.mode === 'tiers' && outcome.climbed === true && outcome.tier !== null) {
    return tierLabel(outcome.tier);
  }
  return pillBeforeCharge;
}

/**
 * The pill on the member card — design:608.
 * Stamps salons show "4 / 8"; tiers salons show the tier name.
 */
export function loyaltyPill(member: {
  tier: string | null;
  stamps: number | null;
}, stampTarget: number | null): string {
  if (member.stamps !== null && stampTarget !== null) {
    return `${member.stamps} / ${stampTarget}`;
  }
  return tierLabel(member.tier) || 'Member';
}

/** The line under the member's name — design:609. */
export function memberSubtitle(member: { visits: number; stamps: number | null }): string {
  return member.stamps !== null
    ? copy.memberSubStamps(member.stamps)
    : copy.memberSubVisits(member.visits);
}
