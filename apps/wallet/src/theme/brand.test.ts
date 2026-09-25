/**
 * The runtime rebrand, driven rather than asserted.
 *
 * This file does NOT import `./index`. Importing it seals the palette (see
 * `./sealed`), and the whole subject here is what happens before that. Vitest
 * isolates module registries per test file, so `contrast.test.ts` importing the
 * theme cannot affect this one — but within this file the discipline has to hold,
 * and `applies nothing once the palette is sealed` below is the proof it does.
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
 * The three shipped demo salons, by HEX — the input a salon row actually
 * carries. The hex is read off each preset but nothing else is: `deriveBrandSet`
 * derives from the hex, exactly as `apps/dashboard/src/shell/useBrandTheme.ts`
 * does for every salon including Amara's own, so asserting against the
 * hand-tuned `deep`/`tint` would be testing a path no surface takes.
 *
 * It used to be three literals, the first of them the old sage `#6E7F6C`. When
 * trunk revised the ramp this list went on exercising a hex the product no
 * longer ships while every spec below it stayed green — the list was the only
 * thing they were asking about.
 */
const PRESET_HEXES = Object.fromEntries(
  Object.entries(brandPresets).map(([name, p]) => [name, p.brand]),
) as Record<string, string>;

/**
 * The default palette, read off the preset the native theme is generated from
 * (`packages/tokens/src/generate.ts:218`) rather than remembered from `theme` —
 * `applyBrandColor` mutates `theme`, and a test that captured a reference would
 * compare a value to itself.
 *
 * NOT RE-TYPED AS LITERALS, which is what it was: `{ brand: '#6E7F6C',
 * brandDeep: '#5A6B58', brandTint: '#EEF1EC' }`. Restating the token file's
 * values means the spec goes red when trunk revises the ramp while telling you
 * nothing about whether the rebrand path still works — it did, and this still
 * failed. Reading the source keeps the same specs meaningful across a ramp
 * change, and the cross-check below is what makes the read worth making.
 */
const DEFAULT_BRAND = {
  brand: brandPresets.amaraSage.brand,
  brandDeep: brandPresets.amaraSage.deep,
  brandTint: brandPresets.amaraSage.tint,
} as const;

describe('applyBrandColor — the rebrand', () => {
  /**
   * The palette is still untouched at this line — the real subject, since
   * `applyBrandColor` mutates `theme` in place — and the separately generated
   * `@avo/tokens/native` agrees with the `color` map the rest of the workspace
   * reads. Both are checkable without naming a colour.
   */
  it('starts from the untouched default the token file ships', () => {
    expect(theme.color.brand).toBe(DEFAULT_BRAND.brand);
    expect(theme.color.brandDeep).toBe(DEFAULT_BRAND.brandDeep);
    expect(theme.color.brandTint).toBe(DEFAULT_BRAND.brandTint);

    expect(theme.color.brand).toBe(palette.brand);
    expect(theme.color.brandDeep).toBe(palette.brandDeep);
    expect(theme.color.brandTint).toBe(palette.brandTint);
  });

  /** #9's shape at the default: `deep` carries white, `brand` does not. */
  it('ships a default whose deep carries white and whose brand does not', () => {
    expect(theme.color.brandDeep).not.toBe(theme.color.brand);
    expect(contrastWithWhite(theme.color.brandDeep)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    expect(contrastWithWhite(theme.color.brand)).toBeLessThan(AA_NORMAL_TEXT);
  });

  it('writes the salon hex and its derived set onto the palette', () => {
    const out = applyBrandColor('#B08D8D');
    expect(out.applied).toBe(true);
    if (!out.applied) return;

    // The five, and only the five. `brand` is the salon's own hex, unchanged.
    expect(theme.color.brand).toBe('#B08D8D');
    expect(theme.color.brandDeep).toBe(out.values.brandDeep);
    expect(theme.color.brandTint).toBe(out.values.brandTint);
    expect(theme.card.from).toBe(out.values.cardFrom);
    expect(theme.card.to).toBe(out.values.cardTo);

    // It actually MOVED. A rebrand that silently no-ops is the defect this
    // whole slice exists to close, so the new values must differ from sage.
    expect(theme.color.brand).not.toBe(DEFAULT_BRAND.brand);
    expect(theme.color.brandDeep).not.toBe(DEFAULT_BRAND.brandDeep);
    expect(theme.color.brandTint).not.toBe(DEFAULT_BRAND.brandTint);
  });

  it('applies the same values the shared package derived, not its own', () => {
    const out = applyBrandColor('#8A7CB0');
    const shared = deriveBrandSet('#8A7CB0');
    expect(out.applied && shared.ok).toBe(true);
    if (!out.applied || !shared.ok) return;
    expect(out.values).toEqual({
      brand: shared.set.brand,
      brandDeep: shared.set.deep,
      brandTint: shared.set.tint,
      cardFrom: shared.set.cardFrom,
      cardTo: shared.set.cardTo,
    });
  });

  it('leaves brandDeeper and brandTint2 alone, because nothing white-labels them', () => {
    /*
      packages/tokens/src/generate.ts:42 white-labels exactly brand / brandDeep /
      brandTint, on the web surface too. Deriving these two here would be a second
      derivation policy outside the trunk-owned package. Asserted so that if trunk
      ever DOES white-label them, this fails and somebody wires them through
      rather than leaving two sage notes in a rose app.
    */
    const before = { deeper: theme.color.brandDeeper, tint2: theme.color.brandTint2 };
    applyBrandColor('#B08D8D');
    expect(theme.color.brandDeeper).toBe(before.deeper);
    expect(theme.color.brandTint2).toBe(before.tint2);
  });

  it('does nothing at all when there is no hex — a first launch', () => {
    const snapshot = { ...theme.color };
    expect(applyBrandColor(null)).toEqual({ applied: false, why: 'no-hex' });
    expect(applyBrandColor(undefined)).toEqual({ applied: false, why: 'no-hex' });
    expect(applyBrandColor('')).toEqual({ applied: false, why: 'no-hex' });
    expect({ ...theme.color }).toEqual(snapshot);
  });
});

describe('the refusal path — a non-viable hex leaves the defaults standing', () => {
  /**
   * `#FFFF00` is the case the brief names, and it is refused by the shared
   * package: darkened by the full 25% budget it reaches only 4.25:1 against
   * white. The behaviour to prove is not that it is refused — `derive.test.ts`
   * owns that — but that a refusal changes NOTHING here, so the app keeps a
   * palette that is known readable instead of shipping an unreadable button.
   */
  it('refuses #FFFF00 and does not touch the palette', () => {
    applyBrandColor('#8A7CB0'); // put a real brand in place first
    const standing = { ...theme.color, cardFrom: theme.card.from, cardTo: theme.card.to };

    const out = applyBrandColor('#FFFF00');
    expect(out.applied).toBe(false);
    if (out.applied) return;
    expect(out.why).toBe('refused');
    if (out.why !== 'refused') return;
    expect(out.failed).toBe('white-on-deep');

    expect({ ...theme.color, cardFrom: theme.card.from, cardTo: theme.card.to }).toEqual(standing);
  });

  it('discriminates on the refusal DATA, not on the prose', () => {
    /*
      derive.ts: both refusals legitimately begin "can't be used as a brand
      colour", "so a test or a UI that discriminated on the prose would match
      either — and a check that a comment could satisfy is not a check". This
      module carries the shared package's sentence through verbatim and its
      `failed` discriminator alongside it.
     */
    const out = applyBrandColor('#FFFF00');
    expect(out.applied).toBe(false);
    if (out.applied || out.why !== 'refused') return;
    const shared = deriveBrandSet('#FFFF00');
    expect(shared.ok).toBe(false);
    if (shared.ok) return;
    expect(out.reason).toBe(shared.reason);
    expect(out.failed).toBe(shared.failed);
  });
});

describe('the ordering guard', () => {
  it('applies nothing once the palette is sealed', async () => {
    const { seal } = await import('./sealed');
    const standing = { ...theme.color };
    seal();
    const out = applyBrandColor('#B08D8D');
    expect(out.applied).toBe(false);
    if (out.applied) return;
    expect(out.why).toBe('sealed');
    // Half-themed is worse than not themed: nothing moved.
    expect({ ...theme.color }).toEqual(standing);
  });
});

// ------------------------------------------------------- non-negotiable #9 --

describe('non-negotiable #9 holds for every brand a salon can be given', () => {
  for (const [name, hex] of Object.entries(PRESET_HEXES)) {
    describe(name, () => {
      const result = deriveBrandSet(hex);

      it('is viable at all', () => {
        expect(result.ok).toBe(true);
      });

      it('clears 4.5:1 for white on the derived DEEP', () => {
        if (!result.ok) throw new Error(`${hex} was refused`);
        expect(contrastWithWhite(result.set.deep)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
      });

      /**
       * The rule's own justification for each brand in turn: white on `brand`
       * fails on all three, so #9 is a property of every brand this product has,
       * not an Amara quirk. If a hex ever arrives where white-on-brand passes,
       * this fails and somebody has to say why `brand` may now carry text.
       *
       * The three ratios used to be copied into this sentence and one of them
       * went stale with the ramp. They live on `brandPresets.*.whiteOnBrand`, and
       * the scanner's `theme/brand.test.ts` recomputes those declarations rather
       * than trusting them.
       */
      it('and FAILS it for white on brand, which is why the rule exists', () => {
        if (!result.ok) throw new Error(`${hex} was refused`);
        expect(contrastWithWhite(result.set.brand)).toBeLessThan(AA_NORMAL_TEXT);
      });

      it('clears 4.5:1 for the derived deep as LABEL text on the derived tint', () => {
        if (!result.ok) throw new Error(`${hex} was refused`);
        expect(contrastRatio(result.set.deep, result.set.tint)).toBeGreaterThanOrEqual(
          AA_NORMAL_TEXT,
        );
      });

      /**
       * The measured size of the un-white-labelled gap. `brandDeeper` stays sage
       * while `brandTint` follows the salon, so the two can end up in different
       * hues — and this is the assertion that says the consequence is cosmetic
       * rather than an accessibility defect. If a future brand breaks it, the
       * gap stops being cosmetic and the generator has to be fixed first.
       */
      it('keeps the fixed brandDeeper legible on the themed tint', () => {
        if (!result.ok) throw new Error(`${hex} was refused`);
        expect(contrastRatio(theme.color.brandDeeper, result.set.tint)).toBeGreaterThanOrEqual(
          AA_NORMAL_TEXT,
        );
      });

      it('keeps the themed deep legible on the fixed brandTint2', () => {
        if (!result.ok) throw new Error(`${hex} was refused`);
        expect(contrastRatio(result.set.deep, theme.color.brandTint2)).toBeGreaterThanOrEqual(
          AA_NORMAL_TEXT,
        );
      });
    });
  }
});
