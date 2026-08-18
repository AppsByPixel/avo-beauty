/**
 * White-label brand derivation.
 *
 * A merchant supplies ONE hex at onboarding. Everything else is derived here and
 * validated before it can be committed to a salon — because shipping an
 * unreadable primary button to a whole salon's customers is not recoverable
 * after the fact.
 *
 * design/interaction-spec.md §2:
 *   "Onboarding must derive and validate, not accept. If `deep` can't reach
 *    4.5:1 inside ~25% lightness shift, that hex isn't viable as a brand token —
 *    say so at the point of entry."
 *
 * Note on the three shipped presets (Amara sage, Noor rose, Lila lilac): those
 * come out of design/tokens/avo-tokens.json verbatim, they are NOT derived. This
 * module is for salon number four onwards.
 *
 * ---------------------------------------------------------------------------
 * TWO PAIRINGS ARE VALIDATED, NOT ONE. THE SECOND ONE WAS THE BUG.
 *
 * This module used to call `contrastWithWhite` and nothing else. It validated
 * white-on-`deep` — non-negotiable #9's pairing — and never checked `deep`
 * against `tint`, even though `deep` is the *text* colour on tinted surfaces
 * throughout the dashboard: `.avo-label`, `.avo-pill`, branch-id chips, banners.
 *
 * That mattered because the derived set is what actually renders.
 * `apps/dashboard/src/shell/useBrandTheme.ts` writes `--avo-brand`,
 * `--avo-brand-deep`, `--avo-brand-tint` and both card stops onto the document
 * for any salon that has a brand hex, so §2's hand-tuned table is overridden and
 * these values are the ones a merchant actually reads. Measured in the live DOM
 * for Amara's own `#6E7F6C`, the old derivation produced `deep: #637361` and
 * `tint: #E9ECE9` — **4.24:1**, below AA for the 11–12px text it carries, where
 * the hand-tuned `#5A6B58` on `#EEF1EC` measures 5.01:1.
 *
 * #9 was never violated: white-on-deep measured 5.05:1 and every white fill was
 * fine. The gap was that one pairing was the only one anyone looked at.
 *
 * THE CEILING, which is why this needs a search rather than a second threshold.
 * `tint` is always lighter than `deep` and never lighter than white, so
 *
 *     contrast(deep, tint)  <  contrast(deep, white)
 *
 * Deep-on-tint can never exceed white-on-deep. A 4.5:1 tint floor therefore
 * *implies* real headroom on white-on-deep — asking for both asks for a darker
 * `deep` than #9 alone would accept, and no amount of threshold tuning satisfies
 * the tint floor when white-on-deep is only just clearing 4.5.
 *
 * WHICH VARIABLE MOVES, and why that ordering is deliberate. `tint` is pinned
 * near the design's value and `deep` is the free one. Solving it the other way
 * round — holding `deep` as close to the merchant's hex as possible and
 * lightening `tint` until the pair clears — also passes every threshold, and
 * drives every tint to the lightness cap: `#F6F7F5` for Amara, which is
 * indistinguishable from the `#FBFAF8` app surface, so every banner and chip
 * loses its edge. A tint is a *surface with an identity*; `deep` is a shade of
 * the brand. So the search walks tint lightness up from §2's 92% inside a narrow
 * band and darkens `deep` within it.
 *
 * The result sits closer to the designers' hand-tuned values than the old
 * derivation did, which is the strongest evidence available that this is
 * faithful rather than a restyle: Amara's hex now derives `#5C6A5A` against a
 * shipped `#5A6B58`.
 */

import {
  contrastRatio,
  contrastWithWhite,
  rgbToHsl,
  hexToRgb,
  setLightness,
  shiftLightness,
} from './contrast.js';

/** Hard floor. WCAG AA for normal text. Below this we refuse the colour. */
export const MIN_WHITE_CONTRAST = 4.5;

/**
 * What we aim for, not what we accept. Stopping the moment we cross 4.5:1 leaves
 * a colour with no headroom — sub-pixel rendering, a slightly different white, or
 * an OS colour filter can push it back under. The three hand-picked presets sit
 * at 4.9–6.0, so 5.0 keeps derived salons in the same band as designed ones.
 *
 * In practice the tint floor is the binding constraint and pushes `deep` past
 * this on its own — the three presets land at 5.7–6.0. It stays as the
 * white-specific preference so a future change to the tint rules cannot quietly
 * drop white-on-deep back to scraping the floor.
 */
export const TARGET_WHITE_CONTRAST = 5.0;

/** Past this much lightness shift the result no longer reads as the merchant's colour. */
export const MAX_LIGHTNESS_SHIFT = 0.25;

/**
 * `deep` used as TEXT on `tint`. WCAG AA for normal text, because that is what
 * it is — 11–12px labels, pills and chips, not a large-text or non-text case.
 */
export const MIN_TINT_CONTRAST = 4.5;

/** Headroom, for the same reason `TARGET_WHITE_CONTRAST` exists. */
export const TARGET_TINT_CONTRAST = 4.8;

/** §2: "tint at ~92% lightness". The starting point, and the preferred answer. */
export const TINT_LIGHTNESS = 0.92;

/**
 * How far the tint may be lightened to rescue the pairing.
 *
 * 0.95 rather than something looser, because it is the top of the band the
 * designers actually shipped — the three preset tints measure 0.94, 0.95 and
 * 0.94 — so staying inside it keeps a derived tint recognisable as the same kind
 * of surface. Above it a tint stops being a tint.
 */
export const MAX_TINT_LIGHTNESS = 0.95;

export interface BrandSet {
  /** The merchant's hex, unchanged. SURFACE ONLY — gradients, tints, dots, progress fills. */
  brand: string;
  /** Every fill that carries white content: primary buttons, badges, active nav. */
  deep: string;
  /** Info banners, chips, avatar backgrounds, pills. */
  tint: string;
  /** Wallet-card gradient stops. */
  cardFrom: string;
  cardTo: string;
  /** Measured, not assumed. */
  whiteOnDeep: number;
  whiteOnBrand: number;
  /** `deep` as text on `tint`. The pairing this module used to ignore. */
  deepOnTint: number;
}

/**
 * WHICH constraint refused the hex, as a value rather than a sentence.
 *
 * Both refusals legitimately begin "can't be used as a brand colour", so a test
 * or a UI that discriminated on the prose would match either — and a check that
 * a comment could satisfy is not a check. This build has been bitten three times
 * by exactly that shape, so the discriminator is data.
 */
export type BrandRejection = 'white-on-deep' | 'deep-on-tint';

export type DeriveResult =
  | { ok: true; set: BrandSet }
  | { ok: false; failed: BrandRejection; reason: string; bestContrast: number };

/** Every darkening candidate inside the shift budget, least-shifted first. */
function deepCandidates(brand: string): string[] {
  const { l } = rgbToHsl(hexToRgb(brand));
  const out: string[] = [];
  for (let shift = 0; shift <= MAX_LIGHTNESS_SHIFT + 1e-9; shift += 0.005) {
    out.push(setLightness(brand, Math.max(0, l - shift)));
    if (l - shift <= 0) break;
  }
  return out;
}

/**
 * The first (tint, deep) pair satisfying both minimums — preferring the tint
 * closest to §2's 92%, then the `deep` closest to the merchant's own hex.
 */
function solve(
  brand: string,
  candidates: string[],
  minWhite: number,
  minTint: number,
): { deep: string; tint: string } | null {
  for (let tl = TINT_LIGHTNESS; tl <= MAX_TINT_LIGHTNESS + 1e-9; tl += 0.005) {
    const tint = setLightness(brand, tl);
    for (const deep of candidates) {
      if (contrastWithWhite(deep) < minWhite) continue;
      if (contrastRatio(deep, tint) < minTint) continue;
      return { deep, tint };
    }
  }
  return null;
}

/**
 * Derive the full token set from one hex, or refuse it with a reason a
 * salon-onboarding UI can show verbatim.
 */
export function deriveBrandSet(inputHex: string): DeriveResult {
  const brand = normaliseHex(inputHex);
  const candidates = deepCandidates(brand);
  const bestWhite = candidates.reduce((m, c) => Math.max(m, contrastWithWhite(c)), 0);

  /*
   * Three attempts, relaxing one PREFERENCE at a time and never a floor: both
   * targets, then the tint floor, then the white floor as well. The last is
   * very nearly unreachable for the ceiling reason in the header, and it is kept
   * rather than pruned because it is the only branch that separates "this hex
   * cannot carry white text" from "this hex cannot carry its own label colour",
   * and those are different sentences to show someone at onboarding.
   */
  const solved =
    solve(brand, candidates, TARGET_WHITE_CONTRAST, TARGET_TINT_CONTRAST) ??
    solve(brand, candidates, TARGET_WHITE_CONTRAST, MIN_TINT_CONTRAST) ??
    solve(brand, candidates, MIN_WHITE_CONTRAST, MIN_TINT_CONTRAST);

  if (!solved) {
    if (bestWhite < MIN_WHITE_CONTRAST) {
      return {
        ok: false,
        failed: 'white-on-deep',
        bestContrast: round2(bestWhite),
        reason:
          `${brand} can't be used as a brand colour. Darkening it by the maximum ` +
          `${Math.round(MAX_LIGHTNESS_SHIFT * 100)}% only reaches ${bestWhite.toFixed(2)}:1 against white, ` +
          `and buttons need 4.5:1 to stay readable. Pick a deeper shade of the same colour.`,
      };
    }

    // White is reachable; the label pairing is not. Measure it against the
    // lightest tint we would ever allow, so the number we quote is the best case.
    const lightestTint = setLightness(brand, MAX_TINT_LIGHTNESS);
    const bestTint = candidates.reduce((m, c) => Math.max(m, contrastRatio(c, lightestTint)), 0);
    return {
      ok: false,
      failed: 'deep-on-tint',
      bestContrast: round2(bestTint),
      reason:
        `${brand} can't be used as a brand colour. White text on it can be made readable, but ` +
        `the same shade is also the label colour on tinted chips and banners, and there it only ` +
        `reaches ${bestTint.toFixed(2)}:1 against the lightest usable tint — labels need 4.5:1. ` +
        `Pick a deeper shade of the same colour.`,
    };
  }

  const { deep, tint } = solved;
  return {
    ok: true,
    set: {
      brand,
      deep,
      tint,
      cardFrom: shiftLightness(brand, 0.06),
      cardTo: shiftLightness(brand, -0.08),
      whiteOnDeep: round2(contrastWithWhite(deep)),
      whiteOnBrand: round2(contrastWithWhite(brand)),
      deepOnTint: round2(contrastRatio(deep, tint)),
    },
  };
}

/**
 * Guard for anywhere a fill is about to carry white content. Wire this into the
 * money-check / design review path, not just onboarding.
 */
export function assertWhiteIsLegible(fillHex: string, where: string): void {
  const ratio = contrastWithWhite(fillHex);
  if (ratio < MIN_WHITE_CONTRAST) {
    throw new Error(
      `White text on ${fillHex} at ${where} measures ${ratio.toFixed(2)}:1, below the 4.5:1 floor. ` +
        `Use the derived --avo-brand-deep, not --avo-brand.`,
    );
  }
}

/**
 * The mirror of `assertWhiteIsLegible`, for the pairing that was missing.
 *
 * `deep` on `tint` is text on a background, so the threshold is AA normal text.
 * Reach for this wherever a brand-coloured label sits on a brand-tinted surface,
 * which in this product is most chips, pills and info banners.
 */
export function assertLabelIsLegible(deepHex: string, tintHex: string, where: string): void {
  const ratio = contrastRatio(deepHex, tintHex);
  if (ratio < MIN_TINT_CONTRAST) {
    throw new Error(
      `Brand text ${deepHex} on tint ${tintHex} at ${where} measures ${ratio.toFixed(2)}:1, ` +
        `below the ${MIN_TINT_CONTRAST}:1 floor for normal text.`,
    );
  }
}

function normaliseHex(hex: string): string {
  const t = hex.trim();
  return (t.startsWith('#') ? t : `#${t}`).toUpperCase();
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
