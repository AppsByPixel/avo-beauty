/**
 * The Membership section's model — design:343-384, the last section on Home.
 *
 * TWO VARIANTS, ONE PER `Salon.loyaltyMode`: the tier ladder with the member's
 * own rung marked, or the stamp card. There is no third "no loyalty" mode in the
 * contract, and this returns `null` for a salon that has neither configured.
 *
 *
 * WHY THE LADDER IS DERIVED AND NOT COPIED
 * ========================================
 * design:1716-1719 hand-writes four rows — Bronze, Silver, Gold, Black — because
 * the prototype had one salon with four rungs. `SAL-LUMIERE` in the seed runs
 * TWO (`bronze` at 0 visits, `silver` at 4), with `stampTarget: null`, and it is
 * a live tenant. Lane C shipped exactly this bug on the merchant side and showed
 * that salon two tiers it does not have.
 *
 * So every rung comes off `salon.tiers`, sorted by `minVisits` — the same sort
 * `loyaltyProgress` does, for the same reason: the contract does not promise an
 * order and the ladder is meaningless in any other one.
 *
 * THE ONE DESIGN STRING THIS CANNOT REPRODUCE is Black's requirement, written at
 * design:1719 as `20+ · +30% · priority` — it drops the word "visits" that the
 * other three carry and appends a perk. `TierSchema` is `{ name, minVisits,
 * bonusPercent }`; there is no perks field, and "priority" appears nowhere in
 * `api-contract.md`. Inventing it here would promise a customer something no
 * salon can configure and no endpoint can honour, so the requirement renders in
 * the uniform form and the perk is reported rather than rendered. Same class as
 * DECISIONS.md #86: design copy that the contract cannot support is a decision,
 * not an edit.
 *
 *
 * WHY THERE IS A "10 → 11" COLUMN HERE WHEN `TopUpCard` REFUSES ONE
 * ================================================================
 * `TopUpCard`'s header explains at length why it shows no computed bonus: the
 * server owns the number, a branch boost can stack on the tier rate, and the
 * figure a customer is shown *before paying* is the one she will hold the salon
 * to. That reasoning is intact and this does not weaken it, because the two
 * figures answer different questions:
 *
 *   - TopUpCard's would have been a QUOTE, attached to an amount the customer is
 *     about to pay, and a branch boost would have made it wrong.
 *   - This is an ILLUSTRATION of the rung's own published rate, in a reference
 *     table with no payment action on it. It restates `bonusPercent` — which the
 *     server sent — in the plain language the design chose, beside the very
 *     `+10%` it is restating.
 *
 * And the direction of any error is safe: boosts only ever ADD, so a customer
 * who reads "10 → 11" and receives 13 at a boosted branch is not owed anything.
 * The reverse cannot happen. If a discount boost is ever introduced, this column
 * is the first thing that has to be reconsidered.
 *
 * The arithmetic itself never leaves integer fils: `percentOf` from `@avo/types`
 * does it, rounding half-up, exactly as the charge path does. Nothing here
 * reimplements a money helper.
 */

import { add, fils, formatFils, percentOf, type Fils } from '@avo/types';
import type { Language, Member, Salon, TierName } from '@avo/types';
import { stampRewardName } from './names';

/**
 * The amount the illustration is drawn for — design:1716-1719 writes every row
 * against a 10 KD top-up ("10 → 11", "10 → 12", "10 → 13").
 */
export const ILLUSTRATION_BASE: Fils = fils(10_000);

export interface MembershipRung {
  name: TierName;
  minVisits: number;
  bonusPercent: number;
  /** The member is on this rung. Exactly one is true when her tier is in the ladder. */
  current: boolean;
  /** The illustration pair, already at the display boundary. */
  base: string;
  credited: string;
}

export interface MembershipTiers {
  mode: 'tiers';
  rungs: MembershipRung[];
}

export interface MembershipStamps {
  mode: 'stamps';
  have: number;
  target: number;
  /** Never negative: a member can hold a full card before it is claimed. */
  remaining: number;
  /**
   * The salon's reward in the reading language, or null when it has configured
   * none. Two of the three stamp strings name it, so null means those strings
   * cannot be rendered rather than that they render empty.
   */
  reward: string | null;
  /** `modules.shop`. The "a shop purchase counts too" rule needs a shop. */
  shopCounts: boolean;
}

export type MembershipView = MembershipTiers | MembershipStamps;

/**
 * Whole KD when the amount is whole, three decimals when it is not.
 *
 * NOT a general money formatter and deliberately not exported: `formatFils` is
 * the app's money format and every balance, row and receipt goes through it.
 * This exists only because the design's illustration column is two figures in a
 * 13.5px cell next to a requirement string, and "10.000 → 11.000" does not fit
 * a 402pt frame in either language, let alone in Arabic where the row mirrors.
 *
 * A rate that does not divide evenly — 25% of 10 KD is 12.500 — falls back to
 * the real format rather than rounding a money figure to look tidy.
 */
function illustrate(amount: Fils): string {
  return amount % 1000 === 0 ? String(amount / 1000) : formatFils(amount);
}

export function membershipView(
  member: Member,
  salon: Salon,
  lang: Language,
): MembershipView | null {
  if (salon.loyaltyMode === 'stamps') {
    const target = salon.stampTarget ?? 0;
    if (target <= 0) return null;
    const have = member.stamps ?? 0;
    return {
      mode: 'stamps',
      have,
      target,
      remaining: Math.max(0, target - have),
      reward: stampRewardName(salon, lang),
      shopCounts: salon.modules.shop,
    };
  }

  const ladder = [...(salon.tiers ?? [])].sort((a, b) => a.minVisits - b.minVisits);
  if (ladder.length === 0) return null;

  return {
    mode: 'tiers',
    rungs: ladder.map((tier) => {
      const credited = add(ILLUSTRATION_BASE, percentOf(ILLUSTRATION_BASE, tier.bonusPercent));
      return {
        name: tier.name,
        minVisits: tier.minVisits,
        bonusPercent: tier.bonusPercent,
        current: tier.name === member.tier,
        base: illustrate(ILLUSTRATION_BASE),
        credited: illustrate(credited),
      };
    }),
  };
}
