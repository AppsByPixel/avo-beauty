/**
 * Loyalty progress, derived — never stored, never sent by a client.
 *
 * Both modes come off the same two server-owned facts: the salon's configured
 * ladder and the member's counter. The wallet card renders whichever the salon
 * runs; there is no third "no loyalty" mode in the contract.
 */

import type { Member, Salon, TierName } from '@avo/types';

export interface TierProgress {
  mode: 'tiers';
  current: TierName;
  next: TierName | null;
  visitsToNext: number;
  /** 0–1, for the progress bar. 1 when there is no higher tier. */
  fraction: number;
}

export interface StampProgress {
  mode: 'stamps';
  have: number;
  target: number;
  reward: string | null;
  fraction: number;
}

export type LoyaltyProgress = TierProgress | StampProgress;

const TIER_LABELS: Record<TierName, string> = {
  bronze: 'Bronze',
  silver: 'Silver',
  gold: 'Gold',
  black: 'Black',
};

export function tierLabel(tier: TierName): string {
  return TIER_LABELS[tier];
}

export function loyaltyProgress(member: Member, salon: Salon): LoyaltyProgress | null {
  if (salon.loyaltyMode === 'stamps') {
    const target = salon.stampTarget ?? 0;
    const have = member.stamps ?? 0;
    if (target <= 0) return null;
    return {
      mode: 'stamps',
      have,
      target,
      reward: salon.stampReward ?? null,
      fraction: Math.min(1, have / target),
    };
  }

  const ladder = [...(salon.tiers ?? [])].sort((a, b) => a.minVisits - b.minVisits);
  if (ladder.length === 0 || member.tier === null) return null;

  const currentIndex = ladder.findIndex((t) => t.name === member.tier);
  if (currentIndex === -1) return null;
  const current = ladder[currentIndex]!;
  const next = ladder[currentIndex + 1] ?? null;

  if (!next) {
    return { mode: 'tiers', current: current.name, next: null, visitsToNext: 0, fraction: 1 };
  }

  const span = next.minVisits - current.minVisits;
  const done = member.visits - current.minVisits;
  return {
    mode: 'tiers',
    current: current.name,
    next: next.name,
    visitsToNext: Math.max(0, next.minVisits - member.visits),
    fraction: span > 0 ? Math.min(1, Math.max(0, done / span)) : 1,
  };
}

/** The pill on the wallet card. Tiers show the tier; stamps show the count. */
export function loyaltyPill(progress: LoyaltyProgress | null): string | null {
  if (!progress) return null;
  return progress.mode === 'tiers'
    ? tierLabel(progress.current)
    : `${progress.have}/${progress.target}`;
}
