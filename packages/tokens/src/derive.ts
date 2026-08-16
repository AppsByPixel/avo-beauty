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
 */

import { contrastWithWhite, rgbToHsl, hexToRgb, setLightness, shiftLightness } from './contrast.js';

/** Hard floor. WCAG AA for normal text. Below this we refuse the colour. */
export const MIN_WHITE_CONTRAST = 4.5;

/**
 * What we aim for, not what we accept. Stopping the moment we cross 4.5:1 leaves
 * a colour with no headroom — sub-pixel rendering, a slightly different white, or
 * an OS colour filter can push it back under. The three hand-picked presets sit
 * at 4.9–6.0, so 5.0 keeps derived salons in the same band as designed ones.
 */
export const TARGET_WHITE_CONTRAST = 5.0;

/** Past this much lightness shift the result no longer reads as the merchant's colour. */
export const MAX_LIGHTNESS_SHIFT = 0.25;

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
}

export type DeriveResult =
  | { ok: true; set: BrandSet }
  | { ok: false; reason: string; bestContrast: number };

/**
 * Derive the full token set from one hex, or refuse it with a reason a
 * salon-onboarding UI can show verbatim.
 */
export function deriveBrandSet(inputHex: string): DeriveResult {
  const brand = normaliseHex(inputHex);
  const { l } = rgbToHsl(hexToRgb(brand));

  let deep: string | null = null;
  let best = contrastWithWhite(brand);

  // Walk lightness down in 0.5% steps until white is comfortably legible.
  for (let shift = 0; shift <= MAX_LIGHTNESS_SHIFT + 1e-9; shift += 0.005) {
    const candidate = setLightness(brand, Math.max(0, l - shift));
    const ratio = contrastWithWhite(candidate);
    if (ratio > best) best = ratio;
    if (ratio >= TARGET_WHITE_CONTRAST) {
      deep = candidate;
      break;
    }
    if (l - shift <= 0) break;
  }

  // Couldn't hit the target — fall back to anything clearing the hard floor.
  if (!deep) {
    for (let shift = 0; shift <= MAX_LIGHTNESS_SHIFT + 1e-9; shift += 0.005) {
      const candidate = setLightness(brand, Math.max(0, l - shift));
      if (contrastWithWhite(candidate) >= MIN_WHITE_CONTRAST) {
        deep = candidate;
        break;
      }
      if (l - shift <= 0) break;
    }
  }

  if (!deep) {
    return {
      ok: false,
      bestContrast: Math.round(best * 100) / 100,
      reason:
        `${brand} can't be used as a brand colour. Darkening it by the maximum ` +
        `${Math.round(MAX_LIGHTNESS_SHIFT * 100)}% only reaches ${best.toFixed(2)}:1 against white, ` +
        `and buttons need 4.5:1 to stay readable. Pick a deeper shade of the same colour.`,
    };
  }

  return {
    ok: true,
    set: {
      brand,
      deep,
      tint: setLightness(brand, 0.92),
      cardFrom: shiftLightness(brand, 0.06),
      cardTo: shiftLightness(brand, -0.08),
      whiteOnDeep: round2(contrastWithWhite(deep)),
      whiteOnBrand: round2(contrastWithWhite(brand)),
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

function normaliseHex(hex: string): string {
  const t = hex.trim();
  return (t.startsWith('#') ? t : `#${t}`).toUpperCase();
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
