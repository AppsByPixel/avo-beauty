import { describe, expect, it } from 'vitest';
import { contrastRatio, contrastWithWhite } from './contrast.js';
import { MIN_WHITE_CONTRAST, deriveBrandSet, assertWhiteIsLegible } from './derive.js';
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

  it('refuses a hex that cannot carry white text', () => {
    // Pure yellow: no reachable darkening inside 25% makes white legible.
    const r = deriveBrandSet('#FFFF00');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("can't be used as a brand colour");
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
