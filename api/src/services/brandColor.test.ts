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
import { deriveBrandSet } from '@avo/tokens';
import { parseBrandColor } from './brandColor';

/** Migration 0055's two hexes. */
const OLD_DEFAULT = '#6E7F6C';
const NEW_DEFAULT = '#459A3C';

describe('the brand colour migration 0055 writes is a storable one', () => {
  it('derives a full viable set from the new default', () => {
    const derived = deriveBrandSet(NEW_DEFAULT);

    expect(derived.ok).toBe(true);
    if (!derived.ok) return; // narrowing; the assertion above is the claim

    expect(derived.set.brand).toBe(NEW_DEFAULT);
    // The two pairings #9 actually puts text on, both over the 4.5 floor.
    expect(derived.set.whiteOnDeep).toBeGreaterThanOrEqual(4.5);
    expect(derived.set.deepOnTint).toBeGreaterThanOrEqual(4.5);
    // And the one it never does, recorded rather than asserted away.
    expect(derived.set.whiteOnBrand).toBeLessThan(4.5);
  });

  it('accepts the new default through the route-facing validator', () => {
    // Verbatim, not upper-cased — parseBrandColor stores the merchant's spelling.
    expect(parseBrandColor(NEW_DEFAULT)).toBe(NEW_DEFAULT);
  });

  it('still accepts the old default, which rows may legitimately hold', () => {
    // 0055 does not make `#6E7F6C` unstorable: a merchant may choose that sage
    // deliberately after the migration, and it must round-trip like any hex.
    expect(parseBrandColor(OLD_DEFAULT)).toBe(OLD_DEFAULT);
    expect(parseBrandColor(OLD_DEFAULT.toLowerCase())).toBe(OLD_DEFAULT.toLowerCase());
  });
});
