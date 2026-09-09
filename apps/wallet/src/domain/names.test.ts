/**
 * The rule five render sites were getting wrong, with a spec this time.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THIS FILE EXISTS BECAUSE ITS ABSENCE WAS THE CAUSE.
 *
 * `nameAr` reached `packages/types` and the wire, three files carried a
 * `CONTRACT GAP (reported, not filled)` comment saying it had not, and the
 * Arabic wallet rendered `مساء الخير، Dana / Amara` with rows reading
 * `اليوم · ١١:٢٢ م · Salmiya`. `grep -rn "nameAr" apps/wallet/src
 * --include="*.test.ts*"` returned 0 before the fix AND after it, so the fix was
 * exactly as unguarded as the bug had been.
 *
 * The fixtures are the other half. `activity.test.ts` asserted Arabic rows
 * against `[{ id: 'BR-KWC', name: 'Kuwait City' }]` — a branch with no `nameAr`
 * at all. Those assertions pass whether or not the code reads the field, which
 * is why a suite of 281 tests said nothing. Every fixture below carries BOTH
 * names, and the null case is a separate fixture rather than an omitted key.
 * ═════════════════════════════════════════════════════════════════════════════
 */

import { describe, expect, it } from 'vitest';
import { branchName, salonName, stampRewardName } from './names';

/** The seed's real values — api/src/db/seed.ts, and driven off GET /salons. */
const SALMIYA = { id: 'BR-SAL', name: 'Salmiya', nameAr: 'السالمية' };
const KUWAIT_CITY = { id: 'BR-KWC', name: 'Kuwait City', nameAr: 'مدينة الكويت' };
const AMARA = { name: 'Amara', nameAr: 'أمارا' };

/** SAL-LUMIERE and both its branches are seeded with `name_ar` NULL on purpose. */
const LUMIERE = { name: 'Lumiere', nameAr: null };
const HAWALLY = { id: 'BR-LUM-HAW', name: 'Hawally', nameAr: null };

describe('Arabic reaches the screen', () => {
  it('names a branch in Arabic when the language is ar', () => {
    expect(branchName(SALMIYA, 'ar')).toBe('السالمية');
    expect(branchName(KUWAIT_CITY, 'ar')).toBe('مدينة الكويت');
  });

  it('names the salon in Arabic when the language is ar', () => {
    // design/AVO Wallet Home.dc.html:1275 — `salon: 'أمارا'`.
    expect(salonName(AMARA, 'ar')).toBe('أمارا');
  });

  it('does not leak a Latin name into an Arabic string', () => {
    expect(branchName(SALMIYA, 'ar')).not.toMatch(/[A-Za-z]/);
    expect(salonName(AMARA, 'ar')).not.toMatch(/[A-Za-z]/);
  });
});

describe('English is unchanged', () => {
  it('keeps the Latin name in en even when Arabic exists', () => {
    expect(branchName(SALMIYA, 'en')).toBe('Salmiya');
    expect(branchName(KUWAIT_CITY, 'en')).toBe('Kuwait City');
    expect(salonName(AMARA, 'en')).toBe('Amara');
  });

  it('never renders Arabic on the English surface', () => {
    for (const value of [branchName(SALMIYA, 'en'), salonName(AMARA, 'en')]) {
      expect(value).not.toMatch(/[؀-ۿ]/);
    }
  });
});

describe('a null nameAr falls back to Latin, and never to blank', () => {
  it('falls back for a salon with no Arabic name', () => {
    expect(salonName(LUMIERE, 'ar')).toBe('Lumiere');
  });

  it('falls back for a branch with no Arabic name', () => {
    expect(branchName(HAWALLY, 'ar')).toBe('Hawally');
  });

  it('falls back when the key is absent entirely, not merely null', () => {
    // The narrowed shapes several call sites hold. `nameAr?: string | null`
    // permits this, so the fallback has to survive `undefined` as well as null —
    // and this is the shape that made the original bug invisible to fixtures.
    expect(branchName({ name: 'Salmiya' }, 'ar')).toBe('Salmiya');
    expect(salonName({ name: 'Amara' }, 'ar')).toBe('Amara');
  });

  it('is never empty, in either language, for any fixture here', () => {
    const all = [SALMIYA, KUWAIT_CITY, AMARA, LUMIERE, HAWALLY];
    for (const entity of all) {
      for (const lang of ['en', 'ar'] as const) {
        expect(branchName(entity, lang).trim()).not.toBe('');
      }
    }
  });
});

/**
 * THE SAME DEFECT, A THIRD TIME, IN THE SAME SUBJECT AREA.
 *
 * `WalletCard.tsx` carried a note saying the contract held the stamp reward "in
 * one language only" and that an Arabic wallet therefore rendered English.
 * `SalonSchema` has held `stampRewardAr` alongside `stampReward` for as long as
 * `seed.ts` has set it to `تصفيف شعر مجاني`, and `packages/mock` serves it too —
 * so the Arabic was on the wire and `loyaltyProgress` dropped it.
 *
 * The fixtures below carry BOTH strings for the same reason the ones above do: a
 * fixture that omits `stampRewardAr` passes whether or not the code reads it.
 */
describe('stampRewardName', () => {
  const REWARDED = { stampReward: 'Free blow-dry', stampRewardAr: 'تصفيف شعر مجاني' };

  it('reads the reward in the reading language', () => {
    expect(stampRewardName(REWARDED, 'en')).toBe('Free blow-dry');
    expect(stampRewardName(REWARDED, 'ar')).toBe('تصفيف شعر مجاني');
  });

  /** SAL-LUMIERE is seeded with `stampRewardAr` NULL so this path is real. */
  it('falls back to the base string on a genuine NULL', () => {
    expect(stampRewardName({ stampReward: 'Free blow-dry', stampRewardAr: null }, 'ar')).toBe(
      'Free blow-dry',
    );
  });

  /**
   * `undefined ?? x` and `null ?? x` agree, so an ABSENT key proves nothing
   * about a NULL one. Both are asserted, as the header of this file argues.
   */
  it('falls back when the Arabic key is absent rather than null', () => {
    expect(stampRewardName({ stampReward: 'Free blow-dry' }, 'ar')).toBe('Free blow-dry');
  });

  it('is null when the salon has configured no reward, in either language', () => {
    for (const lang of ['en', 'ar'] as const) {
      expect(stampRewardName({}, lang)).toBeNull();
      expect(stampRewardName({ stampReward: null, stampRewardAr: null }, lang)).toBeNull();
    }
  });

  /**
   * The failure this guards is silent: a reward that renders as the empty string
   * would leave "4 more visits and your  is on us." on the card.
   */
  it('never returns an empty string when a reward exists', () => {
    for (const lang of ['en', 'ar'] as const) {
      expect(stampRewardName(REWARDED, lang)!.trim()).not.toBe('');
    }
  });
});
