import { describe, expect, it } from 'vitest';
import { contrastRatio, contrastWithWhite, rgbToHsl, hexToRgb } from './contrast.js';
import {
  MAX_TINT_LIGHTNESS,
  MIN_TINT_CONTRAST,
  MIN_WHITE_CONTRAST,
  TARGET_TINT_CONTRAST,
  assertLabelIsLegible,
  assertWhiteIsLegible,
  deriveBrandSet,
} from './derive.js';
import tokens from '../../../design/tokens/avo-tokens.json' with { type: 'json' };

const presets = tokens.brandPresets as Record<
  string,
  { brand: string; deep: string; tint: string; cardFrom: string; cardTo: string }
>;

describe('the three shipped presets', () => {
  it.each(Object.entries(presets))('%s: white FAILS on brand — this is why #9 exists', (_name, p) => {
    expect(contrastWithWhite(p.brand)).toBeLessThan(MIN_WHITE_CONTRAST);
  });

  it.each(Object.entries(presets))('%s: white PASSES on the shipped deep', (_name, p) => {
    expect(contrastWithWhite(p.deep)).toBeGreaterThanOrEqual(MIN_WHITE_CONTRAST);
  });
});

describe('deriveBrandSet', () => {
  it.each(Object.entries(presets))(
    '%s: deriving from the raw brand hex reaches the floor unaided',
    (_name, p) => {
      const r = deriveBrandSet(p.brand);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.set.whiteOnDeep).toBeGreaterThanOrEqual(MIN_WHITE_CONTRAST);
      // Derived deep should land in the same band as the hand-picked one, not
      // scrape the floor.
      expect(r.set.whiteOnDeep).toBeGreaterThanOrEqual(4.8);
    },
  );

  it('refuses a hex that cannot carry white text, and says WHICH pairing failed', () => {
    // Pure yellow: no reachable darkening inside 25% makes white legible.
    const r = deriveBrandSet('#FFFF00');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    /*
     * `failed` and not `reason`. Both refusals legitimately open with "can't be
     * used as a brand colour", so the substring this test used to match no longer
     * distinguishes them — it would pass for either cause, and would keep passing
     * if the white check were deleted and the tint check refused the hex instead.
     * The discriminator is a value for exactly that reason.
     */
    expect(r.failed).toBe('white-on-deep');
    expect(r.bestContrast).toBeLessThan(MIN_WHITE_CONTRAST);
  });

  it('accepts an already-dark hex without moving it far', () => {
    const r = deriveBrandSet('#3B4A38');
    expect(r.ok).toBe(true);
  });

  it('normalises a hex given without the hash', () => {
    const r = deriveBrandSet('6E7F6C');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.set.brand).toBe('#6E7F6C');
  });
});

describe('assertWhiteIsLegible', () => {
  it('throws when white is put on the surface brand', () => {
    expect(() => assertWhiteIsLegible(presets.amaraSage!.brand, 'primary button')).toThrow(
      /below the 4.5:1 floor/,
    );
  });

  it('passes on the deep variant', () => {
    expect(() => assertWhiteIsLegible(presets.amaraSage!.deep, 'primary button')).not.toThrow();
  });
});

describe('focus ring — WCAG 1.4.11 non-text contrast', () => {
  const SURFACE = '#FBFAF8';

  it.each(Object.entries(presets))(
    '%s: the shipped deep clears 3:1 on the app surface',
    (_name, p) => {
      expect(contrastRatio(p.deep, SURFACE)).toBeGreaterThanOrEqual(3);
    },
  );

  it('Noor rose is why the ring is not --avo-brand', () => {
    // interaction-spec.md §2 writes the ring as a literal #6E7F6C, the Amara
    // brand value. Generalising that to --avo-brand fails here.
    expect(contrastRatio(presets.noorRose!.brand, SURFACE)).toBeLessThan(3);
    expect(contrastRatio(presets.noorRose!.deep, SURFACE)).toBeGreaterThanOrEqual(3);
  });
});

/**
 * THE PAIRING THAT WAS NEVER CHECKED — `deep` as text on `tint`.
 *
 * Every assertion here recomputes a ratio from the returned hexes. None of them
 * matches a message, a hex literal the implementation could drift away from, or
 * anything a comment could satisfy: if the derivation stopped darkening `deep`,
 * these numbers move and the specs go red.
 */
describe('deriveBrandSet — deep-on-tint, the pairing #9 does not cover', () => {
  it.each(Object.entries(presets))(
    '%s: the derived label pairing clears the AA floor for normal text',
    (_name, p) => {
      const r = deriveBrandSet(p.brand);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(contrastRatio(r.set.deep, r.set.tint)).toBeGreaterThanOrEqual(MIN_TINT_CONTRAST);
    },
  );

  it.each(Object.entries(presets))('%s: and reaches the headroom target, not just the floor', (_name, p) => {
    const r = deriveBrandSet(p.brand);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.set.deepOnTint).toBeGreaterThanOrEqual(TARGET_TINT_CONTRAST);
  });

  it.each(Object.entries(presets))('%s: the reported deepOnTint is the real measurement', (_name, p) => {
    // Guards against the number being computed from something other than the two
    // values actually returned — the shape that let a stale `dist` read as truth.
    const r = deriveBrandSet(p.brand);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const measured = Math.round(contrastRatio(r.set.deep, r.set.tint) * 100) / 100;
    expect(r.set.deepOnTint).toBe(measured);
  });

  /*
   * The regression this whole change exists for. Amara's own hex is the one that
   * was measured failing in the live DOM at 4.24:1, and #637361 is the exact deep
   * the old derivation produced. Pinning the OLD value as forbidden is stronger
   * than pinning the new one as expected: it cannot be satisfied by a coincidence
   * and it names the bug.
   */
  it('no longer returns the #637361 deep that measured 4.24:1 against its own tint', () => {
    const r = deriveBrandSet('#6E7F6C');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.set.deep).not.toBe('#637361');
    expect(contrastRatio('#637361', '#E9ECE9')).toBeLessThan(MIN_TINT_CONTRAST);
    expect(contrastRatio(r.set.deep, r.set.tint)).toBeGreaterThanOrEqual(MIN_TINT_CONTRAST);
  });

  it('keeps the tint inside the band the designers actually shipped', () => {
    // The alternative solution — hold `deep`, lighten `tint` — passes every
    // threshold and washes the tint out to the app surface. This is what stops
    // someone "fixing" it that way later.
    for (const p of Object.values(presets)) {
      const r = deriveBrandSet(p.brand);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(rgbToHsl(hexToRgb(r.set.tint)).l).toBeLessThanOrEqual(MAX_TINT_LIGHTNESS + 1e-6);
    }
  });

  it('still refuses a hex whose label pairing cannot be rescued, naming that cause', () => {
    /*
     * Found by search rather than chosen: a hex where white-on-deep is reachable
     * inside the shift budget but deep-on-tint never clears 4.5. If the tint
     * validation were deleted this hex would be ACCEPTED, so the spec fails
     * closed.
     */
    const candidates: string[] = [];
    for (let h = 0; h < 360; h += 5) {
      for (let l = 30; l <= 85; l += 5) {
        candidates.push(hslHex(h, 0.95, l / 100));
      }
    }
    const tintFailures = candidates.filter((hex) => {
      const r = deriveBrandSet(hex);
      return !r.ok && r.failed === 'deep-on-tint';
    });
    expect(tintFailures.length).toBeGreaterThan(0);

    const r = deriveBrandSet(tintFailures[0]!);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.failed).toBe('deep-on-tint');
    expect(r.bestContrast).toBeLessThan(MIN_TINT_CONTRAST);
  });
});

describe('assertLabelIsLegible', () => {
  it('throws on the exact pair that shipped, with the measured ratio in the message', () => {
    expect(() => assertLabelIsLegible('#637361', '#E9ECE9', 'branch id chip')).toThrow(/4\.24:1/);
  });

  it('passes on a pair the derivation now produces', () => {
    const r = deriveBrandSet('#6E7F6C');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(() => assertLabelIsLegible(r.set.deep, r.set.tint, 'branch id chip')).not.toThrow();
  });
});

/**
 * The SHIPPED presets, measured on the same pairing.
 *
 * Two of the three clear it by hand. `noorRose` does not — 4.41:1 — so the
 * validator above would refuse that pair from a new salon while we ship it
 * ourselves. That is a designed-value decision (the hex appears in
 * interaction-spec.md §2's table and across the design bundle), so it is
 * reported to trunk rather than changed here, and pinned so it cannot drift
 * unnoticed in either direction.
 */
describe('the shipped presets on the label pairing', () => {
  const KNOWN_SHORTFALL: Record<string, number> = { noorRose: 4.41 };

  it.each(Object.entries(presets))('%s', (name, p) => {
    const ratio = Math.round(contrastRatio(p.deep, p.tint) * 100) / 100;
    const known = KNOWN_SHORTFALL[name];
    if (known === undefined) {
      expect(ratio).toBeGreaterThanOrEqual(MIN_TINT_CONTRAST);
    } else {
      // Not an approval. If this becomes >= 4.5 the preset was fixed and this
      // branch should be deleted; if it drops further something got worse.
      expect(ratio).toBe(known);
      expect(ratio).toBeLessThan(MIN_TINT_CONTRAST);
    }
  });
});

/** Local HSL->hex, so the search above does not depend on a non-exported helper. */
function hslHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let rp = 0;
  let gp = 0;
  let bp = 0;
  if (h < 60) [rp, gp, bp] = [c, x, 0];
  else if (h < 120) [rp, gp, bp] = [x, c, 0];
  else if (h < 180) [rp, gp, bp] = [0, c, x];
  else if (h < 240) [rp, gp, bp] = [0, x, c];
  else if (h < 300) [rp, gp, bp] = [x, 0, c];
  else [rp, gp, bp] = [c, 0, x];
  const to = (v: number) =>
    Math.max(0, Math.min(255, Math.round((v + m) * 255)))
      .toString(16)
      .padStart(2, '0');
  return `#${to(rp)}${to(gp)}${to(bp)}`.toUpperCase();
}
