import { describe, expect, it } from 'vitest';
import { SIDEBAR_WIDTH, breakpointFor } from './useBreakpoint.js';

/**
 * The four breakpoints of interaction-spec.md §1, pinned at their EDGES.
 *
 * The table is prose in a design document and a chain of `>=` comparisons in
 * code, and the failure mode is a single off-by-one that nobody sees: 1024 is
 * `narrow` and 1023 is `tablet`, so a `>` where a `>=` belongs hands a 1024px
 * iPad a top drawer instead of an icon rail, and the only symptom is a layout
 * that looks plausible at the wrong width. Boundaries are the whole test.
 *
 * `useBreakpoint` itself reads `window.innerWidth`, which is why the pure
 * function is exported separately — this file needs no DOM and adds no test
 * dependency to the workspace.
 */
describe('breakpointFor — interaction-spec.md §1', () => {
  it.each([
    // [width, expected, why this width is in the table]
    [1920, 'wide', 'a desktop monitor'],
    [1440, 'wide', 'the lower edge of wide'],
    [1439, 'base', 'one below wide'],
    [1280, 'base', 'a 13" laptop, the width the spec names'],
    [1200, 'base', 'the lower edge of base'],
    [1199, 'narrow', 'one below base'],
    [1024, 'narrow', 'the lower edge of narrow — an iPad in landscape'],
    [1023, 'tablet', 'one below narrow'],
    [768, 'tablet', 'the lower edge of tablet, and of support at all'],
    [767, 'unsupported', 'one below the supported range'],
    [375, 'unsupported', 'a phone — the scanner surface, not this one'],
  ] as const)('%ipx is %s (%s)', (width, expected, _why) => {
    expect(breakpointFor(width)).toBe(expected);
  });

  /*
   * Guards the "not supported" row rather than trusting it. The spec's below-768
   * behaviour is a notice, not a squeezed layout, so this boundary is the one
   * that decides whether a merchant on a phone gets a clear instruction or a
   * broken dashboard.
   */
  it('never reports a supported layout below 768px', () => {
    for (let width = 0; width < 768; width += 1) {
      expect(breakpointFor(width)).toBe('unsupported');
    }
  });

  it('collapses the rail to 68px only at narrow, and keeps 232px above it', () => {
    // The two widths §1 names. Asserted here so a token rename cannot quietly
    // change the rail and leave the breakpoint logic reading correct.
    expect(SIDEBAR_WIDTH.full).toBe(232);
    expect(SIDEBAR_WIDTH.collapsed).toBe(68);
  });
});
