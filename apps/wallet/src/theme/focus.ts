/**
 * The focus ring, and why it cannot be a React Native style object.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * BUG THIS FIXES. interaction-spec.md §2 asks for "2px solid #6E7F6C, offset
 * 2px, `:focus-visible` rather than `:focus` so a mouse press does not ring."
 * (That hex is the spec quoted verbatim and is a superseded `brand` value; see
 * the ring colour's own note below for why the ring is `brandDeep` regardless.)
 * What the app had was a style object —
 *
 *     const focusRing = { outlineColor, outlineWidth: 2, outlineStyle: 'solid' }
 *
 * — spread into every button and every tappable row. react-native-web maps those
 * four properties straight onto CSS `outline`, and CSS paints an outline whenever
 * its style is `solid`. There is no focus condition in a style object to attach
 * one to. So every control on the screen was permanently ringed: measurable as
 * `getComputedStyle(row).outline === "rgb(110, 127, 108) solid 2px"` on a row
 * that was not focused and never had been.
 *
 * It went unnoticed because the screens built first put the ring on a filled
 * dark-green button and on chips that already had a border, where a 2px brand
 * outline is nearly invisible. The Account screen's row lists made it obvious:
 * five stacked rows inside one card, each drawing its own box.
 *
 * A pseudo-class needs real CSS, so on web this injects one stylesheet, once,
 * and controls opt in with `dataSet={focusable}` — react-native-web's documented
 * escape hatch, which emits `data-avo-focus="ring"`. On native the prop is inert
 * and the platform draws its own focus affordance, which is the right answer
 * there anyway.
 * ═════════════════════════════════════════════════════════════════════════════
 */

import { Platform } from 'react-native';
import { color } from './index';

/** Spread into `dataSet` on any control that should ring on keyboard focus. */
export const focusable = { avoFocus: 'ring' } as const;

const STYLE_ID = 'avo-focus-ring';

/**
 * Injects the stylesheet. Idempotent, and a no-op off web.
 *
 * The `outline: none` half matters as much as the ring: without it the browser
 * paints its own default ring next to ours on the same element.
 */
export function installFocusRing(): void {
  if (Platform.OS !== 'web') return;
  if (typeof document === 'undefined') return;
  if (document.getElementById(STYLE_ID)) return;

  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = [
    '[data-avo-focus="ring"]{outline:none}',
    /*
      `brandDeep`, NOT `brand`, and this is a deviation from the spec's literal
      with the same standing as the one packages/tokens already makes on the web.

      interaction-spec.md §2 writes the ring as `2px solid #6E7F6C` — the `brand`
      value of the day, since superseded by the revised ramp. A focus indicator is
      a non-text graphic, so WCAG 1.4.11 asks 3:1 against the adjacent surface —
      and measured against `surface` (#FBFAF8), `brand` gives 3.39:1 on the
      shipped default, 3.60:1 on Lila lilac and 2.86:1 on Noor rose, which FAILS
      on the last. The derived `deep` gives 5.39 / 5.74 / 5.66, i.e. it clears on
      all three. (Those six are a snapshot; the property they illustrate is
      asserted per preset in `apps/scanner/src/theme/brand.test.ts`, computed.) The
      generated stylesheet already reached this conclusion and says so in the
      `:focus-visible` block: "Same class of bug as non-negotiable #9 — a value
      that holds for the default preset and breaks the white-label promise."

      Until this app read `salon.brandColor` the palette was always Amara sage and
      `brand` passed, so the bug was latent. Applying a tenant's hex is exactly
      what makes it reachable, which is why it is fixed in the same change.
    */
    `[data-avo-focus="ring"]:focus-visible{outline:2px solid ${color.brandDeep};outline-offset:2px}`,
  ].join('\n');
  document.head.appendChild(style);
}
