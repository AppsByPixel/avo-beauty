/**
 * White-label at runtime for the staff scanner, and why it is runtime rather
 * than a per-salon build.
 *
 * THE HEADER THIS REPLACES WAS RIGHT ABOUT THE PROBLEM AND WRONG ABOUT THE FIX
 * ===========================================================================
 * `src/config/brand.ts` used to say the brand colour was "STILL OWED", pending
 * "the onboarding pipeline that generates these builds". But a scanner build is
 * NOT per-salon and cannot be: `EnrolScreen` types the salon id in on the device
 * (`state/device.ts`), so one generic build is bound to a salon at provisioning
 * time. There is nothing for a per-salon build to key off. The scanner's brand
 * therefore has to be data on the device, exactly like its salon id — which is
 * also what ADR-0001 § White-label model wants ("every fix must be
 * cherry-picked ten times" is the thing it rejects).
 *
 * THE POLICY IS THE SHARED ONE
 * ============================
 * `deriveBrandSet` from `@avo/tokens` derives the set and refuses a hex whose
 * `deep` cannot clear 4.5:1 against white — non-negotiable #9, decided in the
 * shared package and not re-litigated here. A refusal leaves the default sage
 * standing rather than shipping an unreadable button, which is
 * `apps/dashboard/src/shell/useBrandTheme.ts`'s behaviour and now the wallet's.
 *
 * Four values, not five: the scanner has no wallet card, so `theme.card` is
 * emitted for it but nothing reads it. It is written anyway, because a palette
 * that is branded except for one unread entry is a trap for whoever reads it
 * next.
 *
 * #9 IS WHY `brand` IS NOT ENOUGH ON ITS OWN. White on the default `#6E7F6C` is
 * 4.27:1 and would fail; on its derived `deep` it is 5.73:1. `./index` keeps
 * every white-carrying fill on `onBrandFill` (= `brandDeep`), so nothing in this
 * app can put white on `brand` whatever hex a salon supplies.
 *
 * `brandDeeper` and `brandTint2` are untouched for the same reason as in the
 * wallet: `packages/tokens/src/generate.ts:42` white-labels exactly three
 * colours and emits those two as fixed sage on every surface including the web.
 * Deriving them here would be a second derivation policy living outside the
 * trunk-owned package. Reported, not invented.
 */

import { deriveBrandSet, type BrandRejection } from '@avo/tokens';
import { theme } from '@avo/tokens/native';
import { paletteIsSealed } from './sealed';

/** Drops `readonly` and nothing else. The shape is the generator's, unchanged. */
type Writable<T> = { -readonly [K in keyof T]: T[K] };

export type BrandOutcome =
  | {
      applied: true;
      hex: string;
      values: { brand: string; brandDeep: string; brandTint: string; cardFrom: string; cardTo: string };
      whiteOnDeep: number;
      whiteOnBrand: number;
      deepOnTint: number;
    }
  | { applied: false; why: 'no-hex' }
  | { applied: false; why: 'refused'; hex: string; failed: BrandRejection; reason: string }
  | { applied: false; why: 'sealed'; hex: string };

/** Apply a salon's brand hex to the native palette, or leave the defaults. */
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
