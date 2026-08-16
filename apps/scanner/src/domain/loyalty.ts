/**
 * The loyalty sentence on the result screen, and the pill on the member card.
 *
 * design/AVO Staff Scanner.dc.html:610-612 gives both forms verbatim:
 *
 *   stamps  "Stamp added · 5 of 8"
 *   tiers   "Visit added · 5 of 10 to Gold"
 *
 * The tiers form needs a target the API does not send directly: it returns
 * `visits` and `visitsToNext`, so the "of 10" is `visits + visitsToNext`. That
 * addition is presentation, not money, and it is done here rather than in a
 * component so it can be tested.
 */

import type { LoyaltyOutcome } from '../api/charges';
import { copy } from '../copy/en';

/** Tier names arrive lowercase from the API; the design renders them titled. */
export function tierLabel(tier: string | null): string {
  if (!tier) return '';
  return tier.charAt(0).toUpperCase() + tier.slice(1);
}

/** The sentence under "Loyalty" on the result screen. */
export function loyaltySentence(outcome: LoyaltyOutcome): string {
  if (outcome.mode === 'stamps') {
    return copy.loyaltyStamp(outcome.stamps, outcome.target);
  }
  // At the top of the ladder there is no next rung, so the design's "to Gold"
  // clause has nothing to name. The design only draws the climbing case; this
  // is the honest degradation rather than a dangling preposition.
  if (outcome.nextTier === null || outcome.visitsToNext === null) {
    return copy.loyaltyVisitTop(outcome.visits);
  }
  return copy.loyaltyVisit(
    outcome.visits,
    outcome.visits + outcome.visitsToNext,
    tierLabel(outcome.nextTier),
  );
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
