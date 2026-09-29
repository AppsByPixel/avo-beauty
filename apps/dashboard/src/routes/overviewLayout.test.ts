// @vitest-environment jsdom

/**
 * THE OVERVIEW'S ONE GRID, ONE INSET AND ONE BAR LINE, AS A STYLESHEET CONTRACT.
 *
 * Aftab: "the widgets on the dashboards, none of them align with each other
 * indentation-wise", then "nah still too many empty spaces on the dashboard".
 * jsdom has no layout, so the seams and heights were measured live (lane report);
 * what is pinned here is the CSS that produces them. The real stylesheets are
 * loaded into jsdom's cascade where it can compute a value, and the rule text is
 * read where it cannot (jsdom does not evaluate `repeat(auto-fit, …)`, `subgrid`
 * or container units).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

function cssFrom(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
}

const APP = cssFrom('../app.css').replace(/\/\*[\s\S]*?\*\//g, '');

/** Every declaration block whose selector list contains `selector`, joined. */
function rulesFor(selector: string): string {
  const out: string[] = [];
  for (const m of APP.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const selectors = (m[1] ?? '').split(',').map((s) => s.trim());
    if (selectors.includes(selector)) out.push(m[2] ?? '');
  }
  if (out.length === 0) throw new Error(`no rule for ${selector}`);
  return out.join(';').replace(/\s+/g, ' ');
}

beforeAll(() => {
  for (const relative of [
    '../../../../packages/tokens/dist/avo-tokens.css',
    '../../../../packages/ui/src/ui.css',
    '../app.css',
  ]) {
    const style = document.createElement('style');
    style.textContent = cssFrom(relative);
    document.head.appendChild(style);
  }
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('one grid: every row is quarters of the same column, with the one gap token', () => {
  it('the three grids share the gap token and no other gap', () => {
    for (const sel of ['.overview__kpis', '.overview__grid', '.ovw-grid']) {
      expect(rulesFor(sel)).toContain('gap: var(--avo-space-grid-gap)');
      expect(rulesFor(sel)).not.toMatch(/gap: \d/);
    }
  });

  it('the KPI row is four quarters at every supported width', () => {
    expect(rulesFor('.overview__kpis')).toContain('grid-template-columns: repeat(4, minmax(0, 1fr))');
    // The old narrow/tablet 2x2 is gone.
    expect(APP).not.toMatch(/\[data-bp='(narrow|tablet)'\] \.overview__kpis/);
  });

  it('the pair and the analytics are halves of that grid: (100% - gap) / 2, capped at two, by content', () => {
    for (const sel of ['.overview__grid', '.ovw-grid']) {
      expect(rulesFor(sel)).toMatch(
        /grid-template-columns: repeat\( auto-fit, minmax\(max\(var\(--ovw-half-min\), calc\(\(100% - var\(--avo-space-grid-gap\)\) \/ 2\)\), 1fr\) \)/,
      );
    }
    expect(rulesFor('.overview__kpis')).toMatch(/--ovw-half-min: \d+px/);
  });

  it('no card is stretched to its neighbour’s height', () => {
    for (const sel of ['.overview__grid', '.ovw-grid']) expect(rulesFor(sel)).toContain('align-items: start');
  });

  it('the analytics pack as masonry once measured: 1px rows, no row gap, dense, a measured span', () => {
    const grid = rulesFor(".ovw-grid[data-masonry]");
    expect(grid).toContain('grid-auto-rows: 1px');
    expect(grid).toContain('row-gap: 0');
    expect(grid).toContain('grid-auto-flow: row dense');
    expect(rulesFor('.ovw-grid[data-masonry] > *')).toContain('grid-row-end: span var(--ovw-rows)');
  });
});

describe('one inset: 21px, the card padding plus its border, for everything in every card', () => {
  it('an empty or error state inside an Overview card has no side padding of its own', () => {
    document.body.innerHTML = '<div class="ovw-grid"><div class="avo-card"><div class="avo-state">x</div></div></div>';
    const state = getComputedStyle(document.querySelector('.avo-state')!);
    expect(state.paddingLeft).toBe('0px');
    expect(state.paddingRight).toBe('0px');
  });

  it('the table’s outer cells sit on the inset', () => {
    document.body.innerHTML =
      '<div class="ovw-table"><table><tbody><tr><td>a</td><td>b</td><td>c</td></tr></tbody></table></div>';
    const tds = document.querySelectorAll('td');
    expect(getComputedStyle(tds[0]!).paddingLeft).toBe('0px');
    expect(getComputedStyle(tds[1]!).paddingLeft).toBe('6px');
    expect(getComputedStyle(tds[2]!).paddingRight).toBe('0px');
  });

  it('the heatmap cancels its outer cell spacing', () => {
    expect(rulesFor('.ovw-heat')).toContain('margin: 0 -3px');
    expect(rulesFor('.ovw-heat table')).toContain('border-spacing: 3px');
  });

  it('the KPI tile keeps the side inset and tightens only top and bottom', () => {
    const tile = rulesFor('.overview__kpis > .avo-card');
    expect(tile).toContain('padding-top: 14px');
    expect(tile).toContain('padding-bottom: 14px');
    expect(tile).not.toMatch(/padding(-left|-right)?:/);
  });
});

describe('one bar line: the figure column is the list’s, and the same share of every card', () => {
  it('the rows take the list’s columns by subgrid, so a card’s rows cannot disagree', () => {
    expect(rulesFor('.ovw-bars__row')).toContain('grid-template-columns: subgrid');
    expect(rulesFor('.ovw-bars__row')).toContain('grid-column: 1 / -1');
  });

  it('the figure column is a fixed share, not `auto`', () => {
    expect(rulesFor('.ovw-bars')).toContain(
      'grid-template-columns: minmax(0, 34%) minmax(0, 1fr) minmax(28%, max-content)',
    );
  });
});

describe('the heatmap fills its card', () => {
  it('flexes its hour columns across the full width, with near-square cells in a sensible band', () => {
    const table = rulesFor('.ovw-heat table');
    expect(table).toContain('table-layout: fixed');
    expect(table).toContain('width: 100%');
    expect(rulesFor('.ovw-heat')).toContain('container-type: inline-size');
    expect(rulesFor('.ovw-heat tbody td')).toContain(
      'height: clamp(20px, calc((100cqw - 40px) / var(--hours) * 0.8), 36px)',
    );
    expect(rulesFor('.ovw-heat tbody td')).not.toMatch(/(^|[ ;])width:/);
  });
});
