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
 * shared package and not re-litigated here. A refusal lands on the defaults
 * rather than shipping an unreadable button, which is
 * `apps/dashboard/src/shell/useBrandTheme.ts`'s behaviour and the wallet's: the
 * palette is always either `deriveBrandSet(hex)`'s five or the token file's
 * defaults, never a previous salon's leftover.
 *
 * WHEN IT APPLIES. At boot, from the identity cached on the previous sign-in
 * (`Boot.tsx`), so the PIN screen is already in the salon's colour; and on every
 * salon read after a sign-in (`config/brand.ts` → `adoptSalonIdentity`), LIVE —
 * `./live` rebuilds every brand stylesheet in place. It used to refuse after the
 * palette was "sealed" by the first stylesheet, so a till's first session after
 * enrolment ran in the default green end to end.
 *
 * Four values, not five: the scanner has no wallet card, so `theme.card` is
 * emitted for it but nothing reads it. It is written anyway, because a palette
 * that is branded except for one unread entry is a trap for whoever reads it
 * next.
 *
 * #9 IS WHY `brand` IS NOT ENOUGH ON ITS OWN. White on the shipped default
 * `brand` is 3.54:1 and would fail; on its derived `deep` it is 5.62:1, and the
 * same gap holds for every preset. Those two figures are a snapshot of a ramp
 * that has moved before — `theme/brand.test.ts` recomputes the property for every
 * shipped brand rather than trusting them. `./index` keeps
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
import { repaint } from './live';

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
  | { applied: false; why: 'refused'; hex: string; failed: BrandRejection; reason: string };

type Five = { brand: string; brandDeep: string; brandTint: string; cardFrom: string; cardTo: string };

const palette = theme.color as Writable<typeof theme.color>;
const card = theme.card as Writable<typeof theme.card>;

/** The shipped defaults, read before anything can write the palette. */
const DEFAULTS: Five = {
  brand: palette.brand,
  brandDeep: palette.brandDeep,
  brandTint: palette.brandTint,
  cardFrom: card.from,
  cardTo: card.to,
};

/** Write the five and repaint — or nothing at all if they are already standing. */
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

/** Apply a salon's brand hex to the native palette, or return it to the defaults. */
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
