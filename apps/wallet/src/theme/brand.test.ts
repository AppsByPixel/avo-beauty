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
import { AA_NORMAL_TEXT, contrastRatio, contrastWithWhite, deriveBrandSet } from '@avo/tokens';
import { theme } from '@avo/tokens/native';
import { applyBrandColor } from './brand';

/**
 * The three shipped demo salons, by HEX — the input a salon row actually
 * carries. Not by preset: `deriveBrandSet` derives from the hex, exactly as
 * `apps/dashboard/src/shell/useBrandTheme.ts` does for every salon including
 * Amara's own, so testing against the hand-tuned preset values would be testing
 * a path no surface takes.
 */
const PRESET_HEXES = {
  'Amara sage': '#6E7F6C',
  'Noor rose': '#B08D8D',
  'Lila lilac': '#8A7CB0',
} as const;

/**
 * The default palette, captured before anything is applied. Read from a fresh
 * derivation rather than remembered from `theme`, because `applyBrandColor`
 * mutates `theme` and a test that captured a reference would compare a value to
 * itself.
 */
const DEFAULT_SAGE = { brand: '#6E7F6C', brandDeep: '#5A6B58', brandTint: '#EEF1EC' } as const;

describe('applyBrandColor — the rebrand', () => {
  it('starts from the sage the token file ships', () => {
    expect(theme.color.brand).toBe(DEFAULT_SAGE.brand);
    expect(theme.color.brandDeep).toBe(DEFAULT_SAGE.brandDeep);
    expect(theme.color.brandTint).toBe(DEFAULT_SAGE.brandTint);
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
    expect(theme.color.brand).not.toBe(DEFAULT_SAGE.brand);
    expect(theme.color.brandDeep).not.toBe(DEFAULT_SAGE.brandDeep);
    expect(theme.color.brandTint).not.toBe(DEFAULT_SAGE.brandTint);
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
       * The rule's own justification, as a number, for each brand in turn. White
       * on `brand` fails on all three — 4.27:1, 2.98:1, 3.76:1 — so #9 is a
       * property of every brand this product has, not an Amara quirk. If a hex
       * ever arrives where white-on-brand passes, this fails and somebody has to
       * say why `brand` may now carry text.
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
