/**
 * An entity's name in the reading language.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY THIS IS A MODULE AND NOT TWO INLINE TERNARIES.
 *
 * `nameAr` landed on `SalonSchema` and `BranchSchema`, was served by
 * `GET /salons/{id}` (driven: `"أمارا"`, `"السالمية"`, `"مدينة الكويت"`), and
 * FOUR render sites went on reading `name` unconditionally — HomeScreen's
 * header, BranchEarning's chips, `toActivityRow`'s row subtitle and
 * `buildReceipt`'s branch row. An Arabic wallet greeted her in Arabic and then
 * named her salon in Latin, against a design that has written `salon: 'أمارا'`
 * since `AVO Wallet Home.dc.html:1275` and `أمس · أمارا السالمية` since :1580.
 *
 * It shipped, and stayed shipped, because THREE files carried a
 * `CONTRACT GAP (reported, not filled)` comment asserting the field did not
 * exist. The comments outlived the gap; nothing recompiled them.
 *
 * It also stayed shipped because nothing tested it. `grep -rn "nameAr"
 * apps/wallet/src --include="*.test.ts*"` returned zero both before the fix and
 * after it, and the fixtures are why: `activity.test.ts` used
 * `[{ id: 'BR-KWC', name: 'Kuwait City' }]` — a branch with no `nameAr` at all,
 * so the Arabic assertions in that file could not have caught a site that
 * ignores it. A fixture narrower than the wire hides exactly the bug the wire
 * carries.
 *
 * So the decision lives here, as two pure functions with a spec, for the reason
 * `loadFailure.ts` and `orderRefusal.ts` both state at length: this workspace
 * has no renderer, so a branch left inline in a component is a branch no test
 * can reach.
 *
 * THE FALLBACK IS `nameAr ?? name`, NOT `nameAr || name`, and not a blank. It is
 * the same fallback `artistName` and `serviceName` in `domain/booking.ts`
 * already use, and it has a live null path rather than a theoretical one: the
 * seed leaves SAL-LUMIERE and both its branches with `name_ar` NULL
 * deliberately, "so the `nameAr ?? name` fallback has a real null path to
 * prove" (api/src/db/seed.ts). Driven by nulling Amara's `name_ar` in lane B's
 * database: the Arabic screen fell back to `Amara` / `Kuwait City` / `Salmiya`
 * rather than blanking.
 * ═════════════════════════════════════════════════════════════════════════════
 */

import type { Language } from '@avo/types';

/**
 * Structural rather than `Branch`/`Salon`, so a caller can pass the two fields
 * that matter — and so a test fixture cannot accidentally satisfy the type by
 * omitting `nameAr`, which is what `nameAr?: string | null` deliberately allows
 * for the many call sites that hold a narrowed shape.
 */
export interface Named {
  name: string;
  nameAr?: string | null;
}

/** A branch's name in the reading language. See the module header. */
export function branchName(branch: Named, lang: Language): string {
  return lang === 'ar' ? (branch.nameAr ?? branch.name) : branch.name;
}

/**
 * A salon's name in the reading language.
 *
 * Identical to `branchName` and deliberately NOT merged with it. They are two
 * different contract fields on two different entities that happen to share a
 * rule today; one collapsed helper would make a future divergence — a salon
 * with a legal name and a trading name, say — a change to branches as well.
 * The shared implementation is one line; the shared NAME would be the mistake.
 */
export function salonName(salon: Named, lang: Language): string {
  return lang === 'ar' ? (salon.nameAr ?? salon.name) : salon.name;
}

/**
 * The salon's stamp reward in the reading language.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE THIRD "CONTRACT GAP" COMMENT THAT OUTLIVED ITS GAP, and the second in this
 * module's own subject area.
 *
 * `WalletCard.tsx` carried, right above the render site:
 *
 *     The reward comes off Salon.stampReward, which the contract carries in
 *     one language only. CONTRACT GAP, reported: an Arabic wallet renders
 *     the salon's English reward text here.
 *
 * The contract carries BOTH. `SalonSchema` has `stampReward` and
 * `stampRewardAr`, the second with the note "the reward is customer-facing copy,
 * so it needs both"; `api/src/db/seed.ts` sets `stampRewardAr: 'تصفيف شعر مجاني'`
 * for Amara and the mock serves it at `fixtures.ts:49`. So the Arabic string was
 * on the wire and `loyaltyProgress` read `salon.stampReward` unconditionally —
 * an Arabic wallet showed "Free blow-dry" on the card while every other string
 * around it was Arabic.
 *
 * This is the SAME defect as the `nameAr` one at the top of this file, in the
 * same shape: a note asserting a gap, the gap closed on trunk, nothing
 * recompiling the note, and the language that loses being the one nobody on the
 * build reads. That is now three instances in this module's subject area alone.
 *
 * It is fixed here rather than inline for the reason the header already gives:
 * a ternary at a render site is a branch no test can reach.
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * Structural, and BOTH fields optional-and-nullable, because that is exactly how
 * `SalonSchema` declares them — `stampReward` is absent on a tiers salon and
 * explicitly NULL on SAL-LUMIERE, which is seeded that way so the fallback has a
 * real null path. Returns null when the salon has no reward at all, which is a
 * salon with no stamp card rather than a missing translation.
 */
export interface RewardNamed {
  // `| undefined` is spelled out because the workspace runs
  // `exactOptionalPropertyTypes`, under which `?:` alone does NOT admit an
  // explicit undefined — and `SalonSchema`'s `.optional()` produces exactly
  // that. Without it a real `Salon` does not satisfy this interface.
  stampReward?: string | null | undefined;
  stampRewardAr?: string | null | undefined;
}

export function stampRewardName(salon: RewardNamed, lang: Language): string | null {
  const base = salon.stampReward ?? null;
  return lang === 'ar' ? (salon.stampRewardAr ?? base) : base;
}
