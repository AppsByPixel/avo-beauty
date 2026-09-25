/**
 * THE DEFAULT BRAND COLOUR MUST SURVIVE ITS OWN VALIDATOR.
 *
 * Migration 0055 rewrites every salon still holding the old default `#6E7F6C`
 * to the new one, `#459A3C`. If `parseBrandColor` — and therefore
 * `deriveBrandSet` behind it — refused `#459A3C`, the migration would achieve
 * nothing visible and the failure would be silent: `applyBrandColor` falls back
 * rather than throwing, so every migrated salon would render the fallback ramp
 * and the rows would look correct in the database while looking wrong on the
 * card. That is a worse bug than a rejected write, and it is why this is pinned
 * here rather than checked once by hand at migration time.
 *
 * `whiteOnBrand` FOR `#459A3C` IS 3.54, UNDER 4.5, AND THAT IS NOT A DEFECT.
 * Non-negotiable #9: "White text never goes on `--avo-brand`. Use
 * `--avo-brand-deep`. `--avo-brand` is a *surface* colour: gradients, tints,
 * dots, progress fills." `deriveBrandSet` derives the deep and gates on THAT
 * pairing, which clears the floor comfortably. The assertion below states the
 * distinction explicitly so that a future reader who measures `#459A3C` against
 * white, gets 3.54 and concludes the palette is broken finds the answer here.
 *
 * The `packages/tokens` contrast maths itself is trunk's and is covered by
 * `packages/tokens/src/derive.test.ts`. This file asserts only the one fact
 * `api/` depends on: that the hex this migration writes is storable.
 */

import { describe, expect, it } from 'vitest';
import { deriveBrandSet, tokens } from '@avo/tokens';
import { DEFAULT_BRAND_COLOR, parseBrandColor } from './brandColor';

/**
 * Migration 0055 moved rows OFF this one. It is a historical value and is
 * therefore written out: 0055 is immutable history and its hexes do not follow
 * the token file. `#6E7F6C` must stay STORABLE — a merchant may choose that
 * sage deliberately after the migration — which is the only claim made about it
 * below.
 */
const OLD_DEFAULT = '#6E7F6C';

/**
 * The CURRENT default, read rather than typed. Writing `'#459A3C'` here would
 * make this file the sixth stale copy of a value that has already gone stale
 * five times in this build, and — worse — a spec asserting a hard-coded hex
 * derives cleanly proves nothing about the hex the product actually ships.
 */
const SHIPPED = DEFAULT_BRAND_COLOR;

describe('the brand colour the product ships is a storable one', () => {
  it('is the token file’s brand, not a value copied beside it', () => {
    // The constant's entire job. If somebody replaces it with a literal to
    // "avoid the import", this is what goes red.
    expect(DEFAULT_BRAND_COLOR).toBe(tokens.color.brand);
  });

  it('derives a full viable set from the shipped default', () => {
    const derived = deriveBrandSet(SHIPPED);

    expect(derived.ok).toBe(true);
    if (!derived.ok) return; // narrowing; the assertion above is the claim

    expect(derived.set.brand).toBe(SHIPPED);
    // The two pairings #9 actually puts text on, both over the 4.5 floor.
    expect(derived.set.whiteOnDeep).toBeGreaterThanOrEqual(4.5);
    expect(derived.set.deepOnTint).toBeGreaterThanOrEqual(4.5);
  });

  /**
   * WHY `whiteOnBrand` IS NOT ASSERTED AGAINST THE FLOOR.
   *
   * For today's default it measures 3.54, under 4.5, and that is CORRECT rather
   * than a defect — non-negotiable #9 puts white on `brand-deep` and treats
   * `brand` as a surface colour. But `expect(whiteOnBrand).toBeLessThan(4.5)`
   * would be a guard pointing the wrong way: a future ramp that happened to be
   * darker would clear 4.5 and red this spec for getting SAFER. A red that means
   * "nothing is wrong" is how a suite stops being read.
   *
   * The structural fact is the one worth pinning, and it is true for every hex:
   * the deep is darker than the brand, so it always carries white better. That
   * is #9's reason rather than #9's restatement.
   */
  it('always carries white better on the deep than on the brand — #9’s reason', () => {
    const derived = deriveBrandSet(SHIPPED);
    expect(derived.ok).toBe(true);
    if (!derived.ok) return;

    expect(derived.set.whiteOnDeep).toBeGreaterThan(derived.set.whiteOnBrand);
  });

  it('accepts the shipped default through the route-facing validator', () => {
    // Verbatim, not upper-cased — parseBrandColor stores the merchant's spelling.
    expect(parseBrandColor(SHIPPED)).toBe(SHIPPED);
  });

  it('still accepts the old default, which rows may legitimately hold', () => {
    // 0055 does not make `#6E7F6C` unstorable: a merchant may choose that sage
    // deliberately after the migration, and it must round-trip like any hex.
    expect(parseBrandColor(OLD_DEFAULT)).toBe(OLD_DEFAULT);
    expect(parseBrandColor(OLD_DEFAULT.toLowerCase())).toBe(OLD_DEFAULT.toLowerCase());
  });
});
