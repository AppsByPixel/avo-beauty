// @vitest-environment jsdom

/**
 * THE FIRST TEST IN THIS PROJECT THAT ACTUALLY RENDERS ANYTHING.
 *
 * Until now there was no way to. No `jsdom`, no `@testing-library`, no
 * `react-test-renderer` in any package — three UI surfaces and not one render
 * test between them, so every UI assertion was either pure domain logic or
 * source-text parsing (`stateCensus.test.ts`, `consoleNavGates.test.ts` and
 * `payTabWiring.test.ts` are all the latter). DECISIONS.md #38 records why that
 * mattered: a guard that reads the source asserts what the code SAYS, and stays
 * green through any refactor that keeps the words and loses the behaviour.
 *
 * `Money` is the right first subject because it is the display boundary two
 * non-negotiables meet at, and because what it promises is invisible to every
 * technique available before now:
 *
 *   #1  money is integer fils, formatted to three decimals ONLY here;
 *   #12 Arabic is a first-class layout — WESTERN digits for money, always.
 *
 * And the part no source-text test could reach: the visible glyphs are
 * `aria-hidden`, and the accessible name comes from `moneyAriaLabel`. What a
 * screen reader announces is therefore a DIFFERENT STRING from what the eye
 * reads, computed by a different function. Grepping the component proves both
 * calls exist. Only rendering proves the DOM ends up with the right one on the
 * right node.
 *
 * The environment is set by the docblock above rather than in the shared config
 * on purpose: the other 245 dashboard tests run under `node` and have no reason
 * to pay for a DOM.
 */

import { fils } from '@avo/types';
import { Money } from '@avo/ui';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

/*
 * CLEANUP IS NOT AUTOMATIC HERE, AND THE FAILURE IT CAUSES LIES ABOUT ITS CAUSE.
 *
 * `@testing-library/react` registers its own `afterEach(cleanup)` only when it
 * can see a global `afterEach` — i.e. under vitest `globals: true`, which this
 * project does not use. Without it every `render()` in a file accumulates in the
 * same document, and the first query that matches more than one node fails with
 * "Found multiple elements", pointing at the component rather than at the two
 * leftover copies of it from the tests above.
 *
 * Anyone adding the second render test in this repo will hit this. Keep the line.
 */
afterEach(cleanup);

describe('Money renders the amount, and announces a different string than it draws', () => {
  it('formats integer fils to exactly three decimals', () => {
    const { container } = render(<Money amount={fils(24500)} />);
    expect(container.textContent).toBe('24.500');
  });

  it('does not lose the trailing zeroes that make it money', () => {
    // 24.5 and 24.500 are the same number and different amounts of money.
    const { container } = render(<Money amount={fils(24000)} />);
    expect(container.textContent).toBe('24.000');
  });

  it('renders Western digits in Arabic — non-negotiable #12', () => {
    const { container } = render(<Money amount={fils(24500)} lang="ar" withUnit />);
    // The unit is Arabic; the digits are not. Both halves matter.
    expect(container.textContent).toContain('د.ك');
    expect(container.textContent).toContain('24.500');
    // No Arabic-Indic digit may appear in an amount of money.
    expect(container.textContent).not.toMatch(/[٠-٩۰-۹]/);
  });

  it('hides the drawn glyphs from assistive tech and labels the wrapper instead', () => {
    render(<Money amount={fils(24500)} />);
    // Found BY ITS ACCESSIBLE NAME — which is the whole point. If the label
    // moved to the wrong node, or the aria-hidden came off the inner span, the
    // accessible name would be the raw glyphs and this query would miss.
    // The FULL announced string, not a fragment. A loose /24/ matches the inner
    // text node too and fails as ambiguous — which is itself the point: the eye
    // and the screen reader are looking at two different nodes here.
    const labelled = screen.getByLabelText('24.500 Kuwaiti dinars');
    expect(labelled.querySelector('[aria-hidden="true"]')).not.toBeNull();
    // The announced string carries a unit the drawn one does not.
    expect(labelled.textContent).toBe('24.500');
  });
});
