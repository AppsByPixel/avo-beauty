/**
 * The scanner's runtime rebrand.
 *
 * The specs share one module registry and run in order, so each leaves the
 * palette as it applied it; a spec that depends on a starting state sets it.
 * `the live repaint` below is the half that used to be refused as "sealed": a
 * hex applied after the theme has been imported and sheets have been built.
 */

import { describe, expect, it, vi } from 'vitest';
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

/**
 * The presets dark enough that white passes on their brand — by NAME, as
 * `packages/tokens/src/derive.test.ts` scopes them, so a light preset that
 * drifted dark still goes red rather than quietly changing category.
 */
const DARK_PRESETS = new Set(['forest']);
const LIGHT_PRESETS = Object.entries(brandPresets).filter(([name]) => !DARK_PRESETS.has(name));
const DARK = Object.entries(brandPresets).filter(([name]) => DARK_PRESETS.has(name));

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

  /**
   * A device with nothing cached is already on the defaults, so this is a no-op
   * there; from a salon brand it lands on the defaults, as `useBrandTheme`'s
   * effect cleanup does on the web.
   */
  it('lands on the shipped defaults when there is no hex', () => {
    applyBrandColor('#8A7CB0');
    expect(applyBrandColor(null)).toEqual({ applied: false, why: 'no-hex' });
    expect(theme.color.brand).toBe(palette.brand);
    expect(theme.color.brandDeep).toBe(palette.brandDeep);
    expect(theme.color.brandTint).toBe(palette.brandTint);
  });

  /**
   * A refusal lands on the defaults — a palette known to be readable — rather
   * than shipping an unreadable fill or keeping a previous salon's leftover.
   */
  it('refuses #FFFF00 and returns the palette to the defaults', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    applyBrandColor('#8A7CB0');
    expect(theme.color.brand).toBe('#8A7CB0');
    const out = applyBrandColor('#FFFF00');
    expect(out.applied).toBe(false);
    if (out.applied || out.why !== 'refused') return;
    expect(out.failed).toBe('white-on-deep');
    expect(theme.color.brand).toBe(palette.brand);
    expect(theme.color.brandDeep).toBe(palette.brandDeep);
    expect(theme.color.brandTint).toBe(palette.brandTint);
    expect(warn).toHaveBeenCalledWith(`[avo] Ignoring salon brand colour #FFFF00: ${out.reason}`);
    warn.mockRestore();
  });
});

describe('the live repaint', () => {
  it('re-derives the theme and rebuilds a brandedStyles sheet in place', async () => {
    vi.doMock('react-native', () => ({ StyleSheet: { create: <T,>(s: T) => s } }));
    applyBrandColor(null);
    const [themeIndex, { brandedStyles }, { onRepaint }] = await Promise.all([
      import('./index'),
      import('./branded'),
      import('./live'),
    ]);
    const styles = brandedStyles(() => ({
      fill: { backgroundColor: themeIndex.onBrandFill },
      edge: { borderColor: themeIndex.BRAND_BORDER },
    }));
    expect(styles.fill.backgroundColor).toBe(palette.brandDeep);
    let repaints = 0;
    onRepaint(() => {
      repaints += 1;
    });

    const forest = brandPresets.forest.brand;
    const out = applyBrandColor(forest);
    if (!out.applied) throw new Error('forest was refused');
    expect(repaints).toBe(1);
    expect(styles.fill.backgroundColor).toBe(out.values.brandDeep);
    expect(styles.edge.borderColor).toBe(themeIndex.withAlpha(forest, 0.22));
    expect(themeIndex.onBrandFill).toBe(out.values.brandDeep);
    expect(themeIndex.FOCUS_RING_LIGHT).toBe(out.values.brandDeep);
    expect(themeIndex.card.from).toBe(out.values.cardFrom);

    // The same hex again is a Home refresh: no repaint.
    applyBrandColor(forest);
    expect(repaints).toBe(1);
    vi.doUnmock('react-native');
  });

  /** The path the till takes after a staff sign-in reads the salon. */
  it('adoptSalonIdentity applies the name and the colour together', async () => {
    const [{ adoptSalonIdentity }, { brand, resetSalonNameToBuildDefault }] = await Promise.all([
      import('../state/salonAdoption'),
      import('../config/brand'),
    ]);
    applyBrandColor(null);
    const out = adoptSalonIdentity({ name: 'Forest', brandColor: brandPresets.forest.brand });
    expect(out.applied).toBe(true);
    expect(brand.salonName).toBe('Forest');
    if (!out.applied) return;
    expect(theme.color.brandDeep).toBe(out.values.brandDeep);
    expect(theme.card.from).toBe('#277144');
    expect(theme.card.to).toBe('#153C24');
    resetSalonNameToBuildDefault();
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
   * And FAILS it on `brand` for every LIGHT one of them. That is why `onBrandFill`
   * is a single constant pinned to `brandDeep`: the rule is a property of the
   * light brands this product has, not of the default.
   *
   * RESCOPED 2026-09-29, as trunk rescoped `packages/tokens/src/derive.test.ts`.
   * The dark `forest` preset (#1F5A36) passes white on its brand — the safe
   * direction, not an exception: #9 is "white goes on deep", and a dark preset's
   * deep IS its brand. So the dark presets, by name, assert that identity with
   * white clearing brand and both card stops (the scanner's home and member
   * cards draw white on `card.from → card.to`).
   *
   * The per-brand figures used to be copied into this comment and went stale the
   * moment the ramp moved. They are not restated here; the token file declares
   * them as `whiteOnBrand` and the spec below holds that declaration to account.
   */
  it('and fails it for white on brand, for every shipped light brand', () => {
    const legible = LIGHT_PRESETS.map(([, p]) => p.brand).filter(
      (hex) => contrastWithWhite(hex) >= AA_NORMAL_TEXT,
    );
    expect(legible).toEqual([]);
  });

  it('and every shipped dark brand is its own deep, with white clearing brand and both card stops', () => {
    expect(DARK.length).toBeGreaterThan(0);
    const failures = DARK.flatMap(([name, p]) => {
      const r = deriveBrandSet(p.brand);
      if (!r.ok) return [`${name} refused`];
      return [
        r.set.deep === r.set.brand ? null : `${name}: deep ${r.set.deep} is not brand ${r.set.brand}`,
        ...(['brand', 'cardFrom', 'cardTo'] as const).map((k) => {
          const ratio = contrastWithWhite(r.set[k]);
          return ratio >= AA_NORMAL_TEXT ? null : `${name} ${k} ${ratio.toFixed(2)}:1`;
        }),
      ].filter(Boolean);
    });
    expect(failures).toEqual([]);
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
