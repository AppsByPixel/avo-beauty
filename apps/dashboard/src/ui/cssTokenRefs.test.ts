/**
 * EVERY `var(--…)` THE DASHBOARD READS IS A CUSTOM PROPERTY SOMETHING DEFINES.
 *
 * =========================================================================
 * WRITTEN BECAUSE THIS LANE JUST SHIPPED THE DEFECT INTO A DIFF
 * =========================================================================
 * The `earnings-by-branch` caveat block was first written against
 * `--avo-warn-tint` and `--avo-warn-line`, invented by analogy with
 * `--avo-brand-tint` and `--avo-hairline`, and the comment above it asserted in
 * as many words that they were "the tokens Settings already uses". They do not
 * exist. `packages/tokens` defines `color.warnText` and `color.warnBg` and
 * nothing else warning-coloured.
 *
 * THE REASON IT NEEDS A TEST RATHER THAN CARE IS THAT IT FAILS SILENTLY AND
 * INVISIBLY. An unresolvable custom property is not a parse error and not a
 * console warning: the declaration is simply dropped. The block would have
 * rendered with no background and no border — a caveat on a money table styled
 * as ordinary paragraph text, on a card that still looked plausible. Nothing in
 * `pnpm check` reads CSS at all.
 *
 * AND `getComputedStyle` CANNOT CATCH IT HERE. `emphasisWeight.test.tsx` reads
 * the real cascade for `font-weight` and that works, but jsdom does not resolve
 * `var()`: measured on this very block, a correct rule reports
 * `color: "var(--avo-warn-text)"` — the literal text — and an invented token
 * reports exactly the same thing. The cascade tells the two apart in a browser
 * and not in this test environment, so the question has to be asked of the
 * stylesheet text, which is where the answer honestly lives.
 *
 * SCOPE: every `var()` in the dashboard's own stylesheet and in `packages/ui`,
 * against every `--x:` declaration in those two plus the generated token sheet.
 * It is deliberately not limited to the block that prompted it — the failure
 * mode is a typo or an invention, and neither knows which rule it is in.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function cssFrom(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
}

/** Comments hold example names and prose; only live declarations count. */
function withoutComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

const TOKENS = withoutComments(cssFrom('../../../../packages/tokens/dist/avo-tokens.css'));
const UI = withoutComments(cssFrom('../../../../packages/ui/src/ui.css'));
const APP = withoutComments(cssFrom('../app.css'));

const DECLARED = new Set(
  [...`${TOKENS}${UI}${APP}`.matchAll(/(--[A-Za-z0-9-]+)\s*:/g)].map((m) => m[1] as string),
);

function referencesIn(css: string): string[] {
  return [...css.matchAll(/var\(\s*(--[A-Za-z0-9-]+)/g)].map((m) => m[1] as string);
}

describe('no rule reads a custom property nothing declares', () => {
  it('resolves every var() in the dashboard stylesheet', () => {
    const missing = [...new Set(referencesIn(APP))].filter((name) => !DECLARED.has(name)).sort();
    expect(missing).toEqual([]);
  });

  it('resolves every var() in packages/ui', () => {
    const missing = [...new Set(referencesIn(UI))].filter((name) => !DECLARED.has(name)).sort();
    expect(missing).toEqual([]);
  });

  it('is actually reading the sheets — the guard’s own premise', () => {
    /*
     * A regex that matched nothing would pass both assertions above forever.
     * DECISIONS.md's standing note applies to this file as much as to any sweep:
     * a zero result is a claim about the command as much as about the tree.
     */
    expect(DECLARED.size).toBeGreaterThan(80);
    expect(referencesIn(APP).length).toBeGreaterThan(40);
    expect(DECLARED.has('--avo-warn-bg')).toBe(true);
    expect(DECLARED.has('--avo-warn-tint')).toBe(false);
  });

  it('flags an invented token when one is introduced', () => {
    /*
     * The guard proved against the exact string that got past a reader: the
     * block as first written, with two names that do not exist.
     */
    const invented = '.x { background: var(--avo-warn-tint); border-color: var(--avo-warn-line); }';
    const missing = [...new Set(referencesIn(invented))].filter((n) => !DECLARED.has(n)).sort();
    expect(missing).toEqual(['--avo-warn-line', '--avo-warn-tint']);
  });
});
