/**
 * The scanner's runtime rebrand.
 *
 * This file does NOT import `./index` — importing it seals the palette and the
 * subject here is what happens before that. Vitest isolates module registries per
 * file, so `contrast.test.ts` importing the theme cannot affect this one.
 */

import { describe, expect, it } from 'vitest';
import {
  AA_NORMAL_TEXT,
  brandPresets,
  color as palette,
  contrastRatio,
  contrastWithWhite,
  deriveBrandSet,
} from '@avo/tokens';
import { theme } from '@avo/tokens/native';
import { applyBrandColor } from './brand';

/**
 * The hex a salon row carries, not the hand-tuned preset. See `./brand`.
 *
 * READ OFF `brandPresets`, NOT RE-TYPED. This was three literals and the first
 * of them was the old sage `#6E7F6C`. When trunk revised the brand ramp the list
 * went on exercising a hex the product no longer ships — and every spec below it
 * stayed green, because they only ever asked questions about the list. A spec
 * that re-states the token file's values cannot notice the token file changing,
 * which is the precise failure this file was rewritten to stop repeating.
 */
const PRESET_HEXES = Object.values(brandPresets).map((p) => p.brand);

/** The preset the generated native theme is built from. `generate.ts:218`. */
const SHIPPED = brandPresets.amaraSage;

/**
 * WCAG 1.4.11 — a focus indicator is a non-text graphic, so 3:1 against the
 * adjacent surface. The number packages/tokens uses in the same argument.
 */
const NON_TEXT = 3;

describe('applyBrandColor', () => {
  /**
   * WHAT THIS PINS IS THE RELATIONSHIP, NOT THE HEXES.
   *
   * It asserted `'#6E7F6C'` / `'#5A6B58'` and went red the day trunk revised the
   * brand ramp — red for the wrong reason, because nothing on the rebrand path
   * had broken. Two things here are actually worth asserting and neither needs a
   * colour named:
   *
   *   1. No earlier spec in this file has mutated the palette yet. That is the
   *      real subject — `applyBrandColor` mutates `theme` in place, so "is it
   *      still untouched" is a genuine question at this line.
   *   2. `@avo/tokens/native` is a SEPARATELY generated artifact from the `color`
   *      map the rest of the workspace reads. That the two agree, and that both
   *      agree with the preset the native theme is generated from, is a real
   *      cross-check on the generator — and it survives the ramp moving again.
   */
  it('starts from the untouched default the token file ships', () => {
    expect(theme.color.brand).toBe(palette.brand);
    expect(theme.color.brandDeep).toBe(palette.brandDeep);
    expect(theme.color.brand).toBe(SHIPPED.brand);
    expect(theme.color.brandDeep).toBe(SHIPPED.deep);
  });

  /**
   * And the default satisfies #9's SHAPE: `deep` can carry white, `brand` cannot,
   * and they are two different colours. That is the property the app depends on.
   * A ramp revision that broke it would fail here; one that merely moved the hue
   * will not.
   */
  it('ships a default whose deep carries white and whose brand does not', () => {
    expect(theme.color.brandDeep).not.toBe(theme.color.brand);
    expect(contrastWithWhite(theme.color.brandDeep)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    expect(contrastWithWhite(theme.color.brand)).toBeLessThan(AA_NORMAL_TEXT);
  });

  it('writes the salon hex and its derived set onto the palette', () => {
    const out = applyBrandColor('#B08D8D');
    expect(out.applied).toBe(true);
    if (!out.applied) return;
    expect(theme.color.brand).toBe('#B08D8D');
    expect(theme.color.brandDeep).toBe(out.values.brandDeep);
    expect(theme.color.brandTint).toBe(out.values.brandTint);
    // It actually moved — a rebrand that silently no-ops is the defect being fixed.
    expect(theme.color.brandDeep).not.toBe(SHIPPED.deep);
  });

  it('applies the shared package’s values, not its own', () => {
    const out = applyBrandColor('#8A7CB0');
    const shared = deriveBrandSet('#8A7CB0');
    expect(out.applied && shared.ok).toBe(true);
    if (!out.applied || !shared.ok) return;
    expect(out.values.brandDeep).toBe(shared.set.deep);
    expect(out.values.brandTint).toBe(shared.set.tint);
  });

  it('does nothing when the device has no cached hex', () => {
    const snapshot = { ...theme.color };
    expect(applyBrandColor(null)).toEqual({ applied: false, why: 'no-hex' });
    expect({ ...theme.color }).toEqual(snapshot);
  });

  /** A refusal leaves the defaults standing rather than shipping an unreadable fill. */
  it('refuses #FFFF00 and does not touch the palette', () => {
    applyBrandColor('#8A7CB0');
    const standing = { ...theme.color };
    const out = applyBrandColor('#FFFF00');
    expect(out.applied).toBe(false);
    if (out.applied || out.why !== 'refused') return;
    expect(out.failed).toBe('white-on-deep');
    expect({ ...theme.color }).toEqual(standing);
  });

  it('applies nothing once the palette is sealed', async () => {
    const { seal } = await import('./sealed');
    const standing = { ...theme.color };
    seal();
    const out = applyBrandColor('#B08D8D');
    expect(out.applied).toBe(false);
    if (out.applied) return;
    expect(out.why).toBe('sealed');
    expect({ ...theme.color }).toEqual(standing);
  });
});

describe('non-negotiable #9 survives a rebrand on the staff surface', () => {
  it('clears 4.5:1 for white on the derived deep, for every shipped brand', () => {
    const failures = PRESET_HEXES.map((hex) => {
      const r = deriveBrandSet(hex);
      if (!r.ok) return `${hex} refused`;
      const ratio = contrastWithWhite(r.set.deep);
      return ratio >= AA_NORMAL_TEXT ? null : `${hex} deep ${ratio.toFixed(2)}:1`;
    }).filter(Boolean);
    expect(failures).toEqual([]);
  });

  /**
   * And FAILS it on `brand` for every one of them. That is why `onBrandFill` is a
   * single constant pinned to `brandDeep`: the rule is a property of every brand
   * this product has, not of the default.
   *
   * The per-brand figures used to be copied into this comment and went stale the
   * moment the ramp moved. They are not restated here; the token file declares
   * them as `whiteOnBrand` and the spec below holds that declaration to account.
   */
  it('and fails it for white on brand, for every shipped brand', () => {
    const legible = PRESET_HEXES.filter((hex) => contrastWithWhite(hex) >= AA_NORMAL_TEXT);
    expect(legible).toEqual([]);
  });

  /**
   * THE TOKEN FILE'S OWN PROSE, HELD TO ACCOUNT.
   *
   * Each preset ships a `whiteOnBrand` string beside its hex. That is a claim,
   * and an unchecked claim beside a value that moves is how the 4.27 in this
   * app's theme header became false without anything going red. This recomputes
   * it. It is the one assertion here that would catch trunk shipping a ramp whose
   * own documented ratios no longer describe it.
   */
  it('matches each preset’s declared whiteOnBrand to the computed ratio', () => {
    const drift = Object.entries(brandPresets)
      .map(([name, p]) => {
        const actual = `${contrastWithWhite(p.brand).toFixed(2)}:1`;
        return p.whiteOnBrand === actual ? null : `${name}: declares ${p.whiteOnBrand}, is ${actual}`;
      })
      .filter(Boolean);
    expect(drift).toEqual([]);
  });
});

describe('the focus ring survives a rebrand — WCAG 1.4.11, 3:1 non-text', () => {
  /**
   * THE REGRESSION THIS EXISTS TO CATCH. `FOCUS_RING_LIGHT` was `color.brand`,
   * which clears the 3:1 non-text floor against `surface` on the shipped default
   * and FAILS on Noor rose. It was unreachable while the palette was fixed;
   * applying a tenant's hex is what makes it reachable, so both halves are
   * asserted here — as a pass-somewhere / fail-somewhere pair rather than as
   * per-tenant numbers, because the numbers move with the ramp and the two-sided
   * property is what actually justifies the ring being `deep`.
   */
  it('fails on `brand` for at least one shipped brand, which is why the ring is `deep`', () => {
    const failing = PRESET_HEXES.filter((hex) => {
      const r = deriveBrandSet(hex);
      return r.ok && contrastRatio(r.set.brand, theme.color.surface) < NON_TEXT;
    });
    expect(failing.length).toBeGreaterThanOrEqual(1);
  });

  it('and clears 3:1 on the derived `deep` for every shipped brand', () => {
    const failures = PRESET_HEXES.map((hex) => {
      const r = deriveBrandSet(hex);
      if (!r.ok) return `${hex} refused`;
      const ratio = contrastRatio(r.set.deep, theme.color.surface);
      return ratio >= NON_TEXT ? null : `${hex} deep ring ${ratio.toFixed(2)}:1`;
    }).filter(Boolean);
    expect(failures).toEqual([]);
  });
});
