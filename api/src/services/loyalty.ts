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

