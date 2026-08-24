/**
 * The scanner's runtime rebrand.
 *
 * This file does NOT import `./index` — importing it seals the palette and the
 * subject here is what happens before that. Vitest isolates module registries per
 * file, so `contrast.test.ts` importing the theme cannot affect this one.
 */

import { describe, expect, it } from 'vitest';
import { AA_NORMAL_TEXT, contrastRatio, contrastWithWhite, deriveBrandSet } from '@avo/tokens';
import { theme } from '@avo/tokens/native';
import { applyBrandColor } from './brand';

/** The hex a salon row carries, not the hand-tuned preset. See `./brand`. */
const PRESET_HEXES = ['#6E7F6C', '#B08D8D', '#8A7CB0'] as const;

/**
 * WCAG 1.4.11 — a focus indicator is a non-text graphic, so 3:1 against the
 * adjacent surface. The number packages/tokens uses in the same argument.
 */
const NON_TEXT = 3;

describe('applyBrandColor', () => {
  it('starts from the sage the token file ships', () => {
    expect(theme.color.brand).toBe('#6E7F6C');
    expect(theme.color.brandDeep).toBe('#5A6B58');
  });

  it('writes the salon hex and its derived set onto the palette', () => {
    const out = applyBrandColor('#B08D8D');
    expect(out.applied).toBe(true);
    if (!out.applied) return;
    expect(theme.color.brand).toBe('#B08D8D');
    expect(theme.color.brandDeep).toBe(out.values.brandDeep);
    expect(theme.color.brandTint).toBe(out.values.brandTint);
    // It actually moved — a rebrand that silently no-ops is the defect being fixed.
    expect(theme.color.brandDeep).not.toBe('#5A6B58');
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
   * And FAILS it on `brand` for every one of them — 4.27 / 2.98 / 3.76. That is
   * why `onBrandFill` is a single constant pinned to `brandDeep`: the rule is a
   * property of every brand this product has, not of the default.
   */
  it('and fails it for white on brand, for every shipped brand', () => {
    const legible = PRESET_HEXES.filter((hex) => contrastWithWhite(hex) >= AA_NORMAL_TEXT);
    expect(legible).toEqual([]);
  });
});

describe('the focus ring survives a rebrand — WCAG 1.4.11, 3:1 non-text', () => {
  /**
   * THE REGRESSION THIS EXISTS TO CATCH. `FOCUS_RING_LIGHT` was `color.brand`,
   * which passes on Amara sage (4.10:1 against `surface`) and FAILS on Noor rose
   * (2.86:1). It was unreachable while the palette was always sage; applying a
   * tenant's hex is what makes it reachable, so both halves are asserted here.
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
