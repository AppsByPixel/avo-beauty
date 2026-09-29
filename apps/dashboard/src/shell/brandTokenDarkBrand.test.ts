/**
 * The sidebar's "Brand token" read-out, and every other brand surface this
 * dashboard paints, keeps non-negotiable #9 for a DARK brand.
 *
 * Trunk's fd6edc8 added `brandPresets.forest` (#1F5A36): the first preset whose
 * `deep` IS its `brand`, because the hex already clears white at 8.16:1. That is
 * the case where "white only on deep" and "white on brand" are the same pixels,
 * and so the case where a rule that painted white on `--avo-brand` would pass
 * every contrast check and still be the defect #9 names. What is pinned is the
 * RULE, in the stylesheet, not the luck of one hex.
 *
 * COMMENTS ARE BLANKED before the scan, for `stripComments`' reason — app.css
 * discusses `--avo-brand` in prose far more than it uses it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { brandPresets, contrastRatio, contrastWithWhite, deriveBrandSet } from '@avo/tokens';

const CSS = readFileSync(join(__dirname, '..', 'app.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** Every rule as `[selector, body]`, flat — app.css has no nesting. */
const RULES = [...CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => [m[1]!.trim(), m[2]!] as const);

function rule(selector: string): string {
  const found = RULES.find(([sel]) => sel === selector);
  expect(found, `${selector} not found in app.css`).toBeDefined();
  return found![1];
}

describe('the Brand token read-out on a dark brand', () => {
  const forest = deriveBrandSet(brandPresets.forest.brand);

  it('derives forest as its own deep, with the label pair still legible', () => {
    if (!forest.ok) throw new Error(forest.reason);
    expect(forest.set.deep).toBe(forest.set.brand);
    expect(contrastWithWhite(forest.set.deep)).toBeGreaterThanOrEqual(4.5);
    // "Brand token" is `--avo-brand-deep` on `--avo-brand-tint`.
    expect(contrastRatio(forest.set.deep, forest.set.tint)).toBeGreaterThanOrEqual(4.5);
  });

  it('paints the swatch as a surface, the label in deep on tint, and the mark white on deep', () => {
    expect(rule('.dash-sidebar__swatch')).toMatch(/background:\s*var\(--avo-brand\);/);
    expect(rule('.dash-sidebar__swatch')).not.toMatch(/(^|[^-])color:/);
    expect(rule('.dash-sidebar__token')).toMatch(/background:\s*var\(--avo-brand-tint\)/);
    expect(rule('.dash-sidebar__token .avo-label')).toMatch(/color:\s*var\(--avo-brand-deep\)/);
    expect(rule('.dash-sidebar__mark')).toMatch(/background:\s*var\(--avo-brand-deep\)/);
    expect(rule('.wcard-panel__swatch')).toMatch(/background:\s*var\(--avo-brand\);/);
  });

  it('puts white text on no rule that fills with --avo-brand, anywhere in the sheet', () => {
    const offenders = RULES.filter(
      ([, body]) =>
        /background(-color)?:\s*var\(--avo-brand\)/.test(body) &&
        /(^|[^-])color:\s*var\(--avo-white\)/.test(body),
    ).map(([sel]) => sel);
    expect(offenders).toEqual([]);
    // The scan's own premise: it is reading real rules.
    expect(RULES.filter(([, b]) => /var\(--avo-brand\)/.test(b)).length).toBeGreaterThan(3);
  });
});
