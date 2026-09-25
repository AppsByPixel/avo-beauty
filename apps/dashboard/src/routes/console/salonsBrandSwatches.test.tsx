// @vitest-environment jsdom

/**
 * The owner console's brand swatches are the token file's presets, not a copy of
 * them.
 *
 * =========================================================================
 * THE DEFECT THIS EXISTS TO STOP REPEATING
 * =========================================================================
 * `Salons.tsx` held `const BRAND_SWATCHES = ['#6E7F6C', '#B08D8D', '#8A7CB0']`
 * and preselected `BRAND_SWATCHES[0]`. When trunk moved the brand ramp from 8%
 * saturation to 44-48%, those three literals did not move with it — so every
 * salon onboarded through the wizard was still created on the retired sage
 * `#6E7F6C`. That is the exact hex migration 0055 exists to move salons OFF, and
 * the exact literal Lane A removed from the API's create endpoint in favour of
 * `tokens.color.brand`. The console quietly re-introduced the value at the other
 * end of the same request.
 *
 * NOTHING WENT RED, AND THAT IS THE POINT. Every spec that touched the wizard
 * asked questions ABOUT the list — is a swatch focusable, does clicking one reset
 * the server's refusal, does the review step echo the chosen hex. A spec that
 * only ever consults the list cannot notice the list disagreeing with its source.
 * Lane B reached the same conclusion in `apps/scanner/src/theme/brand.test.ts`
 * ("a spec that re-states the token file's values cannot notice the token file
 * changing") and this file is the console's copy of that guard.
 *
 * =========================================================================
 * WHY THESE FOUR AND NOT A SNAPSHOT
 * =========================================================================
 * None of the assertions below names a colour. A guard written as
 * `expect(BRAND_SWATCHES).toEqual(['#459A3C', ...])` would be the same defect
 * with a newer hex in it: green today, wrong the next time the ramp moves, and
 * red for the wrong reason in between. What is pinned instead is the
 * RELATIONSHIP — the drawn list IS the presets, the preselection IS the
 * platform default, and the wizard's claim that no drawn swatch can be refused
 * is re-derived rather than remembered.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { brandPresets, color, deriveBrandSet } from '@avo/tokens';
import { stripComments } from '../../testing/stripComments.js';
import { BRAND_DEFAULT, BRAND_SWATCHES } from './Salons.js';

/** `Salons.tsx` as the compiler sees it — comments blanked, line numbers intact. */
const SALONS_SRC = stripComments(readFileSync(join(__dirname, 'Salons.tsx'), 'utf8'));

describe('the console onboarding wizard draws the token file’s brand presets', () => {
  /**
   * THE ASSERTION THE OLD LIST WOULD HAVE FAILED.
   *
   * Tautological only while the source is derived — which is the whole guarantee.
   * Restore a literal list in `Salons.tsx` and this goes red on the first hex,
   * naming the retired value against the shipped one.
   */
  it('offers exactly the preset brand hexes, in the token file’s order', () => {
    expect([...BRAND_SWATCHES]).toEqual(Object.values(brandPresets).map((p) => p.brand));
  });

  /**
   * THE LIVE DEFECT, ASSERTED SEPARATELY FROM THE LIST.
   *
   * "Which swatch is preselected" and "which hex the platform defaults to" were
   * one statement — `BRAND_SWATCHES[0]` — and that is why a stale list became a
   * stale default. They are two claims and they are pinned as two: the wizard
   * must start on the platform's brand, and the platform's brand must be
   * offered. A preset re-ordering breaks neither; a preselection that drifts off
   * `color.brand` breaks the first, and a default absent from the presets breaks
   * the second.
   *
   * `color.brand` is what `POST /v1/platform/salons` writes when `brandColor` is
   * absent (Lane A, 69c4044), so agreeing with it is agreeing with the server.
   */
  it('preselects the platform default, and the platform default is one of the swatches', () => {
    expect(BRAND_DEFAULT).toBe(color.brand);
    expect(BRAND_SWATCHES).toContain(color.brand);
  });

  /**
   * THE HEADER'S "all three derive cleanly", RE-DERIVED.
   *
   * `Salons.tsx § the brand step` wires an inline refusal for a hex that cannot
   * produce a 4.5:1 fill (non-negotiable #9) and says the path is unreachable
   * through the drawn control. That was checked once, by hand, against three
   * hexes that have since changed. Running `deriveBrandSet` over whatever the
   * token file currently holds turns the claim into something that fails when it
   * stops being true — and if a future ramp DOES ship a preset that refuses, the
   * failure here is the signal that the unreachable branch just became reachable.
   */
  it('derives a viable brand set for every swatch it draws', () => {
    const refused = BRAND_SWATCHES.map((hex) => {
      const r = deriveBrandSet(hex);
      return r.ok ? null : `${hex}: ${r.reason}`;
    }).filter(Boolean);
    expect(refused).toEqual([]);
  });

  /**
   * THE BACKSTOP, because the three above all read the module's own export and a
   * literal could be re-introduced anywhere else on the screen — the review step,
   * a style attribute, a fallback.
   *
   * COMMENTS ARE BLANKED FIRST and this file is the reason `stripComments` was
   * generalised: the block above `BRAND_SWATCHES` now DISCUSSES `#6E7F6C` at
   * length, deliberately, so a naive `includes()` would find the corrected
   * history and report it as the uncorrected code — failing in the direction that
   * reads as a real defect.
   *
   * SCOPED TO BRAND HEXES, not to every hex. The screen legitimately carries
   * unrelated colours; what may never reappear is a brand value transcribed out
   * of the token file. Any six-digit hex in live code that matches a preset's
   * `brand`, `deep` or `tint`, or the retired sage, is one.
   */
  it('carries no transcribed brand hex in live code', () => {
    const banned = new Map<string, string>([['#6E7F6C', 'the retired sage default']]);
    for (const [name, p] of Object.entries(brandPresets)) {
      banned.set(p.brand.toUpperCase(), `brandPresets.${name}.brand`);
      banned.set(p.deep.toUpperCase(), `brandPresets.${name}.deep`);
      banned.set(p.tint.toUpperCase(), `brandPresets.${name}.tint`);
    }
    const found = [...(SALONS_SRC.match(/#[0-9a-fA-F]{6}/g) ?? [])]
      .map((hex) => hex.toUpperCase())
      .filter((hex) => banned.has(hex))
      .map((hex) => `${hex} — read it from ${banned.get(hex)}`);
    expect([...new Set(found)]).toEqual([]);
  });
});
