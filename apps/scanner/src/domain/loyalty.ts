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
 * THE HONEST FALLBACK. Until lane A sends the count, the first clause is the
 * design's own "Visit added" / "Stamp added" — true for any number added — and
 * the rest of the line is unchanged. A count of 0 is treated the same way:
 * "+0 visits" on a success screen would read as a failure.
 */
export function loyaltyGain(
  outcome: LoyaltyOutcome,
  happyHour: ChargeResult['happyHour'],
): string {
  if (outcome.mode === 'stamps') {
    const n = outcome.stampsEarned;
    return [
      n ? copy.loyaltyStampsEarned(n) : copy.loyaltyStampAdded,
      happyHour ? multiplierLabel('stamp', happyHour.stampMultiplier) : null,
      outcome.rewardReady
        ? copy.loyaltyRewardReady
        : copy.loyaltyStampProgress(outcome.stamps, outcome.target),
    ]
      .filter(Boolean)
      .join(' · ');
  }

  const n = outcome.visitsEarned;
  return [
    n ? copy.loyaltyVisitsEarned(n) : copy.loyaltyVisitAdded,
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
