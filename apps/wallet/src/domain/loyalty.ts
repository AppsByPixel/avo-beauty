/**
 * Loyalty progress, derived — never stored, never sent by a client.
 *
 * Both modes come off the same two server-owned facts: the salon's configured
 * ladder and the member's counter. The wallet card renders whichever the salon
 * runs; there is no third "no loyalty" mode in the contract.
 */

import type { Language, Member, Salon, TierName } from '@avo/types';
import type { Copy } from '../copy/types';
import { stampRewardName } from './names';

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

/**
 * The tier's display name.
 *
 * It lives in the copy module, not here, because Arabic needs more than a
 * lookup: the same tier appears as a noun (فضية), inside a merged preposition
 * (للذهبية) and as an adjective (الفضي) depending on the sentence. A single
 * `tierLabel` string cannot serve all three, so the grammar stays in the
 * language file and this is only the plain-noun accessor.
 */
export function tierLabel(tier: TierName, copy: Copy): string {
  return copy.tierName[tier];
}

/**
 * `lang` is here only for the stamp reward, which is the one field on this
 * shape that is customer-facing COPY rather than a number. It resolves through
 * `stampRewardName` so the branch is testable; see that function's header for
 * the Arabic bug this closes.
 */
export function loyaltyProgress(
  member: Member,
  salon: Salon,
  lang: Language,
): LoyaltyProgress | null {
  if (salon.loyaltyMode === 'stamps') {
    const target = salon.stampTarget ?? 0;
    const have = member.stamps ?? 0;
    if (target <= 0) return null;
    return {
      mode: 'stamps',
      have,
      target,
      reward: stampRewardName(salon, lang),
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

/**
 * The pill on the wallet card. Tiers show the tier; stamps show the count.
 *
 * The stamps form is built by the copy module rather than here, because "3/8" is
 * a COUNT and counts are Eastern in Arabic — design/AVO Wallet Home.dc.html:1646
 * renders it `٣ / ٨`. Assembling it locally is exactly how a Western digit ends
 * up on an Arabic card.
 */
export function loyaltyPill(progress: LoyaltyProgress | null, copy: Copy): string | null {
  if (!progress) return null;
  return progress.mode === 'tiers'
    ? tierLabel(progress.current, copy)
    : copy.stampsPill(progress.have, progress.target);
}
