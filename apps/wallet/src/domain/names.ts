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
