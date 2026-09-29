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
 * other two light presets — white-on-brand is 2.98:1 for Noor rose and 3.76:1
 * for Lila lilac, i.e. the rule is not a default-preset quirk, it is true of
 * every light brand this product has. The dark `forest` preset (#1F5A36,
 * 2026-09-29) passes white on its brand, and that is not an exception: its
 * derived deep IS its brand, so white-on-deep is the same pixels. This module
 * never writes a text colour; it writes a palette, and `onBrandFill` in
 * `./index` is what keeps white on `deep`.
 *
 * (Those are a snapshot of a ramp that has already moved once — the default read
 * 4.27:1 before trunk revised it. `brandPresets.*.whiteOnBrand` is the declared
 * source and `apps/scanner/src/theme/brand.test.ts` recomputes it; the PROPERTY,
 * for every shipped brand, is asserted in `./brand.test.ts`.)
 *
 * MUTATION, AND WHEN IT TAKES EFFECT
 * ==================================
 * `theme.color` IS this app's palette root, the native analogue of
 * `document.documentElement.style`, so the five values are written onto it and
 * then `./live`'s `repaint()` does what the browser does for the dashboard:
 * every stylesheet that reads a brand token is rebuilt in place and the tree
 * re-renders. So a hex applies WHENEVER it arrives:
 *
 *   - at boot, from the hex cached on the previous launch (`Boot.tsx`), before
 *     the first frame — so a returning phone never shows a default frame, and a
 *     signed-out one shows its salon's colour on sign-in;
 *   - on every successful salon read (`useWalletHome`), live — which is the
 *     only moment a fresh install ever learns its salon's colour, and the one
 *     this file used to wait a whole launch for.
 *
 * It used to be sealed: after the first stylesheet was evaluated this refused,
 * because a native stylesheet copies its colours once and a late write would
 * have themed half the app. `./live` removes the reason — the stylesheets are
 * re-evaluable now — so the seal is gone with it. See `./live` for why this is a
 * repaint and not a re-mount or a reload.
 *
 * THE DASHBOARD'S POLICY, CASE BY CASE
 * ====================================
 * The palette is always EITHER `deriveBrandSet(hex)`'s five OR the defaults the
 * token file ships — never a leftover. That is `useBrandTheme`'s behaviour too:
 * its effect cleanup removes the previous salon's properties before the next
 * hex is looked at, so a refused or absent hex lands on the defaults.
 *
 *   hex derives      →  write the five, repaint
 *   hex refused      →  warn with the package's own sentence, defaults, repaint
 *   no hex           →  defaults (a first launch, where they already stand)
 *   same as standing →  nothing, and no re-render: Home re-reads the salon on
 *                       every refresh, and that must not redraw the app
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
 * A hex changed in the dashboard mid-session is picked up at the next salon
 * read — Home's next refresh — not the next launch.
 */

import { deriveBrandSet, type BrandRejection } from '@avo/tokens';
import { theme } from '@avo/tokens/native';
import { repaint } from './live';

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
  | { applied: false; why: 'refused'; hex: string; failed: BrandRejection; reason: string };

type Five = BrandApplied['values'];

const palette = theme.color as Writable<typeof theme.color>;
const card = theme.card as Writable<typeof theme.card>;

/**
 * The shipped defaults, read once when this module is evaluated. Nothing writes
 * the palette except `paint` below, so at this line it is still the token file's.
 */
const DEFAULTS: Five = {
  brand: palette.brand,
  brandDeep: palette.brandDeep,
  brandTint: palette.brandTint,
  cardFrom: card.from,
  cardTo: card.to,
};

function paint(next: Five): void {
  if (
    palette.brand === next.brand &&
    palette.brandDeep === next.brandDeep &&
    palette.brandTint === next.brandTint &&
    card.from === next.cardFrom &&
    card.to === next.cardTo
  ) {
    return;
  }
  palette.brand = next.brand;
  palette.brandDeep = next.brandDeep;
  palette.brandTint = next.brandTint;
  card.from = next.cardFrom;
  card.to = next.cardTo;
  repaint();
}

/**
 * Apply a salon's brand hex to the native palette, or return it to the defaults.
 *
 * Fail-safe in both negative cases, for `useBrandTheme`'s reason: the point of
 * entry is where a bad hex gets rejected, and by the time one reaches a
 * customer's phone the only safe move is to ignore it and keep going.
 */
export function applyBrandColor(hex: string | null | undefined): BrandOutcome {
  if (!hex) {
    paint(DEFAULTS);
    return { applied: false, why: 'no-hex' };
  }

  const result = deriveBrandSet(hex);
  if (!result.ok) {
    // The shared package wrote the sentence; it is not paraphrased here.
    console.warn(`[avo] Ignoring salon brand colour ${hex}: ${result.reason}`);
    paint(DEFAULTS);
    return { applied: false, why: 'refused', hex, failed: result.failed, reason: result.reason };
  }

  const { set } = result;
  const values: Five = {
    brand: set.brand,
    brandDeep: set.deep,
    brandTint: set.tint,
    cardFrom: set.cardFrom,
    cardTo: set.cardTo,
  };
  paint(values);

  return {
    applied: true,
    hex,
    values,
    whiteOnDeep: set.whiteOnDeep,
    whiteOnBrand: set.whiteOnBrand,
    deepOnTint: set.deepOnTint,
  };
}
