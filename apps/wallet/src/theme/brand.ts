/**
 * White-label at runtime: one salon, one hex, five values.
 *
 * WHY THIS EXISTS
 * ===============
 * ADR-0001 § White-label model rejects branch-per-brand by name — "every fix
 * must be cherry-picked ten times" — and DECISIONS.md § "White-label onboarding
 * is a wizard" settles that per-client identity is DATA: a salon row and a brand
 * hex. Until this file existed the wallet read its salon id from build config
 * and never read `brandColor` at all, so every build rendered Amara sage
 * whatever tenant it was for. That single gap is what forced a per-client
 * *build* instead of a per-client *config*.
 *
 * THE POLICY IS THE DASHBOARD'S POLICY, NOT A SECOND ONE
 * =====================================================
 * `apps/dashboard/src/shell/useBrandTheme.ts` is the working pattern: call
 * `deriveBrandSet(hex)` from `@avo/tokens`, apply exactly five properties, and
 * on a refusal warn and leave the defaults standing "rather than shipping an
 * unreadable button". This does the same three things. The derivation, the
 * 4.5:1 floor and the refusal text all stay in the shared package; nothing about
 * colour is decided here.
 *
 * The five are the same five, spelled natively:
 *
 *     --avo-brand        →  theme.color.brand
 *     --avo-brand-deep   →  theme.color.brandDeep
 *     --avo-brand-tint   →  theme.color.brandTint
 *     --avo-card-from    →  theme.card.from
 *     --avo-card-to      →  theme.card.to
 *
 * NON-NEGOTIABLE #9 IS THE POINT OF THE WHOLE THING
 * =================================================
 * `brand` is a SURFACE colour and white text goes on the derived `deep`. Measured
 * here, not assumed: white on the shipped default `brand` is 3.54:1 and would be
 * refused as a fill; on its derived `deep` it is 5.62:1. The same holds for the
 * other two shipped presets — white-on-brand is 2.98:1 for Noor rose and 3.76:1
 * for Lila lilac, i.e. the rule is not a default-preset quirk, it is true of
 * every brand this product has. This module never writes a text colour; it writes
 * a palette, and `onBrandFill` in `./index` is what keeps white off `brand`.
 *
 * (Those are a snapshot of a ramp that has already moved once — the default read
 * 4.27:1 before trunk revised it. `brandPresets.*.whiteOnBrand` is the declared
 * source and `apps/scanner/src/theme/brand.test.ts` recomputes it; the PROPERTY,
 * for every shipped brand, is asserted in `./brand.test.ts`.)
 *
 * MUTATION, AND WHY IT IS THE RIGHT SHAPE HERE
 * ===========================================
 * The DOM approach does not port. There are ~120 `StyleSheet.create` entries
 * reading `color.brand*` across this app, each of which copies the string at
 * module-evaluation time, so a React context would mean rewriting every
 * stylesheet in every screen — a restyle, which the brief forbids and which
 * would risk far more than it fixes. `theme.color` IS this app's palette root,
 * the native analogue of `document.documentElement.style`, so the five values are
 * written onto it before any consumer is evaluated. `./sealed` explains the
 * ordering and `Boot.tsx` enforces it.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 * ==================================
 * `brandDeeper` and `brandTint2` are NOT touched, because they are not
 * white-labelled anywhere: `packages/tokens/src/generate.ts:42` white-labels
 * exactly `brand`, `brandDeep` and `brandTint`, and emits the other two fixed on
 * the web surface too. Deriving them here would be inventing a second derivation
 * policy outside the trunk-owned package, which is precisely what "do not invent
 * a second policy" rules out. Measured consequence, so the gap is quantified
 * rather than hand-waved: the fixed `brandDeeper` as text on a themed `tint`
 * clears AA on all three presets (6.39 / 6.01 / 5.94:1), and the themed `deep` on
 * the fixed `brandTint2` clears it too (5.32 / 5.58 / 5.66:1). So it is a
 * visual-fidelity gap — two green notes in an otherwise rose app — and not an
 * accessibility one. `./brand.test.ts` asserts that floor per preset rather than
 * relying on these six figures, which move whenever the ramp does. Reported to
 * trunk; it needs fixing in the generator, for both surfaces at once.
 *
 * A hex changed in the dashboard mid-session takes effect at the NEXT LAUNCH, for
 * the sealing reason above. That is a deliberate limitation and the right one: a
 * salon changes its colour approximately never, and half-repainting a running app
 * is the failure this module is built to avoid.
 */

import { deriveBrandSet, type BrandRejection } from '@avo/tokens';
import { theme } from '@avo/tokens/native';
import { paletteIsSealed } from './sealed';

/** Drops `readonly` and nothing else. The shape is the generator's, unchanged. */
type Writable<T> = { -readonly [K in keyof T]: T[K] };

export interface BrandApplied {
  applied: true;
  hex: string;
  /** The five, as applied. Returned so a caller can log or assert on them. */
  values: {
    brand: string;
    brandDeep: string;
    brandTint: string;
    cardFrom: string;
    cardTo: string;
  };
  /** Measured by `deriveBrandSet`, carried through for the record. */
  whiteOnDeep: number;
  whiteOnBrand: number;
  deepOnTint: number;
}

export type BrandOutcome =
  | BrandApplied
  /** No hex to apply. First-ever launch, or a build with no salon read yet. */
  | { applied: false; why: 'no-hex' }
  /** The shared package refused it. Defaults stand. */
  | { applied: false; why: 'refused'; hex: string; failed: BrandRejection; reason: string }
  /** Something already read the palette. Defaults stand — see ./sealed. */
  | { applied: false; why: 'sealed'; hex: string };

/**
 * Apply a salon's brand hex to the native palette, or leave the defaults.
 *
 * Fail-safe in all three negative cases, for `useBrandTheme`'s reason: the point
 * of entry is where a bad hex gets rejected, and by the time one reaches a
 * customer's phone the only safe move is to ignore it and keep going.
 */
export function applyBrandColor(hex: string | null | undefined): BrandOutcome {
  if (!hex) return { applied: false, why: 'no-hex' };

  const result = deriveBrandSet(hex);
  if (!result.ok) {
    // The shared package wrote the sentence; it is not paraphrased here.
    console.warn(`[avo] Ignoring salon brand colour ${hex}: ${result.reason}`);
    return { applied: false, why: 'refused', hex, failed: result.failed, reason: result.reason };
  }

  if (paletteIsSealed()) {
    console.error(
      `[avo] Refusing to apply salon brand colour ${hex}: the palette was already read, ` +
        `so applying it now would theme half the app. Something imported ` +
        `src/theme before Boot resolved the brand — see src/theme/sealed.ts.`,
    );
    return { applied: false, why: 'sealed', hex };
  }

  const { set } = result;
  const palette = theme.color as Writable<typeof theme.color>;
  const card = theme.card as Writable<typeof theme.card>;

  palette.brand = set.brand;
  palette.brandDeep = set.deep;
  palette.brandTint = set.tint;
  card.from = set.cardFrom;
  card.to = set.cardTo;

  return {
    applied: true,
    hex,
    values: {
      brand: set.brand,
      brandDeep: set.deep,
      brandTint: set.tint,
      cardFrom: set.cardFrom,
      cardTo: set.cardTo,
    },
    whiteOnDeep: set.whiteOnDeep,
    whiteOnBrand: set.whiteOnBrand,
    deepOnTint: set.deepOnTint,
  };
}
