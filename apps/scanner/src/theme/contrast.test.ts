/**
 * Non-negotiable #9 on the staff surface, plus this app's own extra risk — a dark
 * scan screen — audited against what the app actually uses.
 *
 * The method, and its stated limit, are set out at length in the wallet's
 * `src/theme/contrast.test.ts`. In short: `packages/tokens`' `auditTokenContrast`
 * audits the PALETTE, Lane C scanned the live DOM, and React Native has neither a
 * DOM nor a way to pair a `Text`'s colour with an ancestor `View`'s background
 * from source. So this claims the part of go-live row 413 that IS decidable
 * statically — #9 — and does not claim the row.
 *
 * THIS FILE'S OWN REASON TO EXIST beyond the wallet's: the scanner is the only
 * surface with a dark screen, so it is the only one where white text on a
 * near-black ground is the NORMAL case rather than the violation. That inverts
 * the usual risk — the danger here is a muted alpha over `dark.surface` dropping
 * under AA, not white on brand — and the token file's own audit cannot see the
 * alphas because they are composited locally rather than declared as tokens.
 */

import { describe, expect, it } from 'vitest';
import { AA_NORMAL_TEXT, contrastRatio } from '@avo/tokens';
import { color, dark, onBrandFill, FOCUS_RING_LIGHT } from './index';

/**
 * Flatten `rgba(255,255,255,a)` over an opaque background.
 *
 * The muted text on the dark screen is an ALPHA, not a colour, so
 * `contrastRatio` cannot be handed it directly — it would need a hex. Compositing
 * it here is what makes the check real rather than skipped: these three alphas are
 * the actual foregrounds on the scan screen and nothing else audits them.
 */
function overSurface(rgba: string, bgHex: string): string {
  const m = /rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/.exec(rgba);
  if (!m) throw new Error(`not an rgba: ${rgba}`);
  const [fr, fg, fb, fa] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  const bg = bgHex.replace('#', '');
  const [br, bgn, bb] = [
    parseInt(bg.slice(0, 2), 16),
    parseInt(bg.slice(2, 4), 16),
    parseInt(bg.slice(4, 6), 16),
  ];
  const mix = (f: number, b: number) => Math.round(f * fa + b * (1 - fa));
  const hex = (n: number) => n.toString(16).padStart(2, '0');
  return `#${hex(mix(fr, br))}${hex(mix(fg, bgn))}${hex(mix(fb, bb))}`;
}

describe('non-negotiable #9 on the staff surface', () => {
  it('is structural — one constant, and it is brandDeep', () => {
    expect(onBrandFill).toBe(color.brandDeep);
    expect(onBrandFill).not.toBe(color.brand);
  });

  it('clears AA with white, computed', () => {
    expect(contrastRatio(color.white, onBrandFill)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
  });

  /**
   * The 4.27:1 this app's own theme header cites, verified rather than trusted.
   * A figure in a comment is the thing this build keeps finding to be stale.
   */
  it('confirms the 4.27:1 the theme header claims for white on brand', () => {
    const ratio = contrastRatio(color.white, color.brand);
    expect(ratio).toBeLessThan(AA_NORMAL_TEXT);
    expect(ratio.toFixed(2)).toBe('4.27');
  });
});

describe('the dark scan screen — where white on near-black is the normal case', () => {
  it('puts its primary text well clear of AA', () => {
    expect(contrastRatio(dark.text, dark.surface)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
  });

  /**
   * The muted and faint alphas, composited. `textFaint` at 0.4 is the one most
   * likely to have been chosen by eye, and it is the one this asserts hardest.
   */
  it('keeps the muted alpha clear of AA once composited', () => {
    const muted = overSurface(dark.textMuted, dark.surface);
    expect(contrastRatio(muted, dark.surface)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
  });

  /**
   * EVERY text token in `dark`, not a hand-listed subset — so adding one puts it
   * under the floor automatically. This is what found `textFaint`
   * (`rgba(255,255,255,0.4)`, 3.84:1 composited, zero uses): a token nothing read
   * and that could not legally carry text. It was removed rather than documented,
   * and this assertion is why it cannot come back unnoticed.
   */
  it('has no text token that fails AA once composited', () => {
    const failures = Object.entries(dark)
      .filter(([k]) => k === 'text' || k.startsWith('text'))
      .map(([k, v]) => {
        const hex = v.startsWith('rgba') ? overSurface(v, dark.surface) : v;
        return { k, ratio: contrastRatio(hex, dark.surface) };
      })
      .filter(({ ratio }) => ratio < AA_NORMAL_TEXT)
      .map(({ k, ratio }) => `dark.${k} = ${ratio.toFixed(2)}:1`);
    expect(failures).toEqual([]);
  });

  /**
   * interaction-spec.md §2 specifies a DIFFERENT ring on dark, because the light
   * one does not carry. That is a contrast claim and it is checkable.
   */
  it('uses a focus ring on dark that is not the light one, and carries', () => {
    expect(dark.focus).not.toBe(FOCUS_RING_LIGHT);
    expect(contrastRatio(dark.focus, dark.surface)).toBeGreaterThan(
      contrastRatio(FOCUS_RING_LIGHT, dark.surface),
    );
  });
});
