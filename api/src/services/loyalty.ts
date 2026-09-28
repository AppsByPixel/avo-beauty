/**
 * Loyalty — steps 4 and 5 of api-contract.md § Charging: "increments visits or
 * stamps per salon.loyaltyMode" and "evaluates a tier climb / stamp-target
 * reward".
 *
 * Pure functions. They take the current state and return the next one, so the
 * charge transaction can compute the whole outcome before it writes anything,
 * and so this is testable without a database.
 *
 * `loyaltyMode` is exclusive: a tiers salon has `tier` and a null `stamps`, a
 * stamps salon the reverse. The schema CHECK `salon_loyalty_config_complete`
 * guarantees the configuration each branch needs is actually present, so neither
 * branch has to invent a fallback.
 */

import type { Tier } from '@avo/types';

export type TierName = 'bronze' | 'silver' | 'gold' | 'black';

export interface TiersOutcome {
  mode: 'tiers';
  visits: number;
  tier: TierName | null;
  nextTier: TierName | null;
  visitsToNext: number | null;
  /** True when this charge crossed a threshold — the receipt and the audit say so. */
  climbed: boolean;
  /**
   * The increment ACTUALLY APPLIED, after any branch boost or happy-hour
   * multiplier — "+2 visits", not "+1 visit, and there was a boost".
   *
   * The server's to state (non-negotiable #2). The scanner could otherwise only
   * subtract the scan's visit count from `visits`, which is the client deciding
   * what the server awarded, and wrong the moment two tills charge her at once.
   * It is also what `POST /voids` takes back — see migration 0065.
   */
  visitsEarned: number;
}

export interface StampsOutcome {
  mode: 'stamps';
  stamps: number;
  target: number;
  rewardReady: boolean;
  /** The stamps actually added, after any multiplier. `visitsEarned`'s twin. */
  stampsEarned: number;
}

export type LoyaltyOutcome = TiersOutcome | StampsOutcome;

/**
 * The tier for a visit count: the highest ladder rung whose `minVisits` is met.
 *
 * Sorted defensively rather than trusting the stored array order. The ladder is
 * one jsonb document precisely so publishing it is atomic, but atomic is not the
 * same as ordered, and a ladder saved out of order must not hand out Black.
 */
export function tierForVisits(tiers: Tier[], visits: number): TierName | null {
  const eligible = [...tiers]
    .filter((t) => visits >= t.minVisits)
    .sort((a, b) => a.minVisits - b.minVisits);
  const top = eligible[eligible.length - 1];
  return (top?.name as TierName) ?? null;
}

/** The next rung up, if there is one. */
function nextRung(tiers: Tier[], visits: number): Tier | null {
  const ahead = [...tiers]
    .filter((t) => t.minVisits > visits)
    .sort((a, b) => a.minVisits - b.minVisits);
  return ahead[0] ?? null;
}

/**
 * Apply `visitIncrement` visits and evaluate the climb.
 *
 * The increment is a parameter rather than a constant because a live `x2visit`
 * happy hour makes it 2. Liveness is resolved on the server clock at charge
 * time — never from a client flag (non-negotiable #2) — and passed in here.
 */
export function applyVisits(
  tiers: Tier[],
  currentVisits: number,
  currentTier: TierName | null,
  visitIncrement: number,
): TiersOutcome {
  const visits = currentVisits + visitIncrement;
  const tier = tierForVisits(tiers, visits);
  const next = nextRung(tiers, visits);

  return {
    mode: 'tiers',
    visits,
    tier,
    nextTier: (next?.name as TierName) ?? null,
    visitsToNext: next ? next.minVisits - visits : null,
    climbed: tier !== currentTier,
    visitsEarned: visitIncrement,
  };
}

/** Apply `stampIncrement` stamps and report whether the card is full. */
export function applyStamps(
  target: number,
  currentStamps: number,
  stampIncrement: number,
): StampsOutcome {
  const stamps = currentStamps + stampIncrement;
  return {
    mode: 'stamps',
    stamps,
    target,
    rewardReady: stamps >= target,
    stampsEarned: stampIncrement,
  };
}

/**
 * ===========================================================================
 * THE VOID'S HALF: take back what a charge earned, and nothing else.
 * ===========================================================================
 * `routes/charges.ts § performVoid`. Pure, like the two above, so the rules are
 * testable without a database.
 *
 * SUBTRACT, NEVER RESTORE. The void does not put `visits` back to what it was
 * before the charge, because that number is stale the moment a second till
 * charges her inside the fifteen-minute window: restoring it would erase the
 * other visit too. It takes `earned` off whatever the count is NOW.
 *
 * NEVER BELOW ZERO — `member_visits_non_negative` / `member_stamps_non_negative`
 * would refuse the row and roll the whole refund back. Clamping is the right
 * answer rather than a refusal: the only way the count can be below `earned` is
 * something else lowering it in between, and the money still has to go back.
 *
 * THE TIER IS RE-EVALUATED EXACTLY AS THE CHARGE EVALUATES IT: `tierForVisits`
 * on the salon's CURRENT ladder, the same function `applyVisits` calls. The rung
 * is a function of the visit count and has never been a ratchet — `applyVisits`
 * already reports any change of rung as `climbed`, a republished ladder can
 * move her down on her next visit (`routes/loyalty.ts § appliesAt:
 * 'next_visit'`), and `activityFeed.describeLoyalty` already words a descent.
 * So a void that takes her back under a threshold she crossed with the voided
 * charge takes her back down, and one that does not cross a threshold moves
 * nothing. The old void never touched the tier at all, which left her on a rung
 * her count no longer supported until her NEXT charge re-evaluated it — and that
 * charge then reported a "climb" downwards.
 */
export interface TiersReversal {
  visits: number;
  tier: TierName | null;
  /** What was actually taken off — `earned`, or less if the count was lower. */
  visitsRemoved: number;
  /** The rung moved. The caller records it the way the charge records a climb. */
  changed: boolean;
}

export function reverseVisits(
  tiers: Tier[],
  currentVisits: number,
  currentTier: TierName | null,
  earned: number,
): TiersReversal {
  const visits = Math.max(0, currentVisits - Math.max(0, earned));
  const tier = tierForVisits(tiers, visits);
  return {
    visits,
    tier,
    visitsRemoved: currentVisits - visits,
    changed: tier !== currentTier,
  };
}

export interface StampsReversal {
  stamps: number;
  stampsRemoved: number;
}

/**
 * NO REWARD IS UN-CLAIMED, because nothing here can claim one. There is no
 * redeem endpoint in this API: `member.stamps` only ever goes up (charge and
 * shop), `rewardReady` is `stamps >= target`, and the salon honours the reward
 * off-system. So this only lowers the count, never writes or removes a reward
 * row, and leaves the `stamp_reward_ready` event where it is (loyalty_event is
 * append-only by intent). When a claim flow exists and resets the card, a void
 * after it takes back at most what is left on the card — the clamp — and her
 * claimed reward stays claimed.
 */
export function reverseStamps(currentStamps: number, earned: number): StampsReversal {
  const stamps = Math.max(0, currentStamps - Math.max(0, earned));
  return { stamps, stampsRemoved: currentStamps - stamps };
}
