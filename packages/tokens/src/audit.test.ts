import { describe, expect, it } from 'vitest';
import tokens from '../../../design/tokens/avo-tokens.json' with { type: 'json' };
import {
  AA_NORMAL_TEXT,
  CROSS_GROUP_PAIRS,
  auditTokenContrast,
  formatFindings,
} from './audit.js';

/**
 * The gate. Six AA failures shipped in this product and all six were found by a
 * human scanning a live DOM once; this is what makes a seventh fail here instead.
 *
 * Every assertion is on a MEASURED ratio, never on a message or a hex literal.
 */
const findings = auditTokenContrast(tokens);

describe('token contrast audit — every declared text-on-background pair', () => {
  it('finds a non-trivial number of pairs to check', () => {
    /*
     * The load-bearing spec of the file. `auditTokenContrast` discovers its work
     * structurally, so a refactor that broke discovery would return [] — and
     * every "no failures" assertion below would pass against a checker that
     * checks nothing. That is the shape of a green run bought with a cast, so the
     * count is pinned first.
     */
    expect(findings.length).toBeGreaterThanOrEqual(16);
  });

  it('discovers the sibling pairs by structure, not from a hand-written list', () => {
    const paths = findings.map((f) => f.textPath);
    // Four different shapes of sibling naming, in four different parent objects.
    expect(paths).toContain('color.warnText');
    expect(paths).toContain('tier.gold.pillText');
    expect(paths).toContain('plan.pro.text');
    expect(paths).toContain('audit.accessText');
  });

  it('covers the cross-group pairing that actually shipped broken', () => {
    const paths = findings.map((f) => f.textPath);
    for (const pair of CROSS_GROUP_PAIRS) expect(paths).toContain(pair.textPath);
  });

  it('has no failing pair', () => {
    const failures = findings.filter((f) => f.status === 'fail');
    expect(failures, `\n${formatFindings(failures)}\n`).toHaveLength(0);
  });

  it('skips nothing silently — every skip carries a reason', () => {
    for (const f of findings.filter((s) => s.status === 'skipped')) {
      expect(f.note, `${f.textPath} was skipped with no reason`).toBeTruthy();
      expect(f.ratio).toBeNull();
    }
  });

  it('measures translucent text by compositing it rather than skipping it', () => {
    // plan.starter.text is rgba(28,27,25,0.6) — the exact value §2 raised muted
    // labels TO, after 0.45 measured ~3.3:1 and failed. A checker that skipped
    // unparsed values would report nothing here.
    const starter = findings.find((f) => f.textPath === 'plan.starter.text');
    expect(starter).toBeDefined();
    expect(starter!.status).toBe('pass');
    expect(starter!.ratio).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
  });
});

describe('the six failures this audit was built from stay fixed', () => {
  /*
   * Pinned as MEASURED RATIOS on the live token values, not as hex equality — a
   * hex assertion passes if someone swaps in a different failing colour, and
   * fails uselessly if someone improves the colour further.
   */
  const ratioOf = (textPath: string): number => {
    const f = findings.find((x) => x.textPath === textPath);
    expect(f, `${textPath} is not being audited at all`).toBeDefined();
    expect(f!.status).not.toBe('skipped');
    return f!.ratio!;
  };

  it.each([
    ['color.warnText', 4.01],
    ['tier.gold.pillText', 4.01],
    ['plan.pro.text', 3.77],
    ['audit.accessText', 3.77],
    ['tier.bronze.pillText', 2.67],
    ['brandPresets.noorRose.deep', 4.41],
    // The eighth, and the highest-leverage: §2 mandated rgba(28,27,25,0.6) for 51
    // uppercase micro-labels and claimed ~5.2:1. Composited it cleared 4.5 on
    // pure white alone (4.53) and failed every real surface. 0.65 is what
    // actually measures the figure §2 recorded.
    ['color.textMutedLabel', 4.22],
  ] as const)('%s clears AA, where it used to measure %s:1', (path, wasFailing) => {
    const now = ratioOf(path);
    expect(wasFailing).toBeLessThan(AA_NORMAL_TEXT); // the bug was real
    expect(now).toBeGreaterThanOrEqual(AA_NORMAL_TEXT); // and is fixed
    expect(now).toBeGreaterThan(wasFailing); // and moved the right way
  });
});
