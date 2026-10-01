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

  it('the analytics cards are not stretched to a neighbour: masonry packs them instead', () => {
    expect(rulesFor('.ovw-grid')).toContain('align-items: start');
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

/*
 * Aftab: "still space under the gross by day chart". Measured at 802px: the
 * trend card 286px and the activity card 412px on one row, `align-items: start`,
 * so a 126px blank under the chart. The pair now shares its row height, and the
 * extra height goes to the one thing on either card that can use it (the bars)
 * rather than to a blank under a short card or inside it.
 */
describe('the trend/activity pair shares one row height, and the chart grows into it', () => {
  it('the pair stretches to the row; the analytics grid does not', () => {
    expect(rulesFor('.overview__grid')).toContain('align-items: stretch');
    expect(rulesFor('.overview__grid')).not.toContain('align-items: start');
  });

  it('each card in the pair is a column, so a child can take the extra height', () => {
    const card = rulesFor('.overview__grid > .avo-card');
    expect(card).toContain('display: flex');
    expect(card).toContain('flex-direction: column');
  });

  it('the plot flexes, never below the chart’s old height, and the caption stays under it', () => {
    expect(rulesFor('.trend__plot')).toContain('flex: 1');
    expect(rulesFor('.trend__plot')).toContain(
      'min-height: calc(var(--trend-bars) + var(--trend-num-row))',
    );
    expect(rulesFor('.trend-card')).toContain('--trend-bars: 132px');
    // The foot follows the plot in the column; nothing pins it anywhere else.
    expect(rulesFor('.trend-card__foot')).not.toMatch(/position:|order:/);
  });

  it('the bars are a percentage of the track, and the track is the flex child, not a fixed box', () => {
    const track = rulesFor('.trend__track');
    expect(track).toContain('flex: 1');
    expect(track).toContain('min-height: var(--trend-bars)');
    expect(track).not.toMatch(/(^|[ ;])height:/);
    expect(rulesFor('.trend__days')).toContain('align-items: stretch');
    // The axis spans exactly the bar row: the plot less the day-number row.
    const axis = rulesFor('.trend__axis');
    expect(axis).toContain('min-height: var(--trend-bars)');
    expect(axis).toContain('margin-bottom: var(--trend-num-row)');
    expect(axis).not.toMatch(/(^|[ ;])height:/);
  });

  it('the skeleton grows the same way, so the card does not change height when bars arrive', () => {
    expect(rulesFor('.trend__skeleton')).toContain('flex: 1');
    expect(rulesFor('.trend__skeleton')).toContain('display: flex');
  });

  it('a state in either card takes the extra height, so no blank band sits under its copy', () => {
    for (const sel of ['.trend-card__state', '.overview__feed-state']) {
      const state = rulesFor(sel);
      expect(state).toContain('flex: 1');
      expect(state).toContain('justify-content: center');
    }
  });

  it('a stretched activity card keeps its list at the top and “Show N more” at the bottom', () => {
    expect(rulesFor('.overview__feed-more')).toContain('margin-top: auto');
  });

  it('computed in the real cascade: the pair’s cards are flex columns in a stretching grid', () => {
    document.body.innerHTML =
      '<div class="overview__grid"><div class="avo-card trend-card"></div><div class="avo-card overview__activity"></div></div>';
    for (const card of document.querySelectorAll('.avo-card')) {
      expect(getComputedStyle(card).display).toBe('flex');
      expect(getComputedStyle(card).flexDirection).toBe('column');
    }
    expect(getComputedStyle(document.querySelector('.overview__grid')!).alignItems).toBe('stretch');
  });
});

/*
 * Aftab, 2026-10-02: export the widgets. The controls arrived after the seams
 * and insets were measured, and the brief was that they disturb neither:
 * measured live at 1440px before and after — every card head 39px, the
 * section head 21px, column gaps 16px, stack gaps 16.0–16.6px, insets 21px —
 * identical. What is pinned here is the CSS that keeps each control inside the
 * line box it shares, so the head's height does not depend on whether the
 * control is drawn.
 */
describe('the Export controls take no height of their own', () => {
  it('the card head carries the title’s old padding, and the title gives its own up', () => {
    expect(rulesFor('.ovw__head')).toContain('padding: 14px 0 4px');
    expect(rulesFor('.ovw__head')).toContain('align-items: center');
    expect(rulesFor('.ovw__head .overview__card-title')).toContain('padding: 0');
  });

  it('computed in the real cascade: the head pads 14/4 and the title inside it pads nothing', () => {
    document.body.innerHTML =
      '<div class="avo-card ovw"><div class="ovw__head"><h3 class="overview__card-title">T</h3>' +
      '<button class="avo-iconbtn avo-iconbtn--neutral avo-iconbtn--quiet ovw__export"></button></div></div>';
    const head = getComputedStyle(document.querySelector('.ovw__head')!);
    expect(head.paddingTop).toBe('14px');
    expect(head.paddingBottom).toBe('4px');
    const title = getComputedStyle(document.querySelector('.ovw__head .overview__card-title')!);
    expect(title.paddingTop).toBe('0px');
    expect(title.paddingBottom).toBe('0px');
    /* 24px tall less 2px each way = 20px, inside the title's 21px line. */
    const button = getComputedStyle(document.querySelector('.ovw__export')!);
    expect(button.minHeight).toBe('24px');
    expect(button.marginTop).toBe('-2px');
    expect(button.marginBottom).toBe('-2px');
    /* Its padding plus border, so the LABEL ends on the 21px inset. */
    expect(button.marginRight).toBe('-8px');
  });

  it('the quiet control has no hairline at rest', () => {
    expect(
      cssFrom('../../../../packages/ui/src/ui.css')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .match(/\.avo-iconbtn--quiet \{([^}]*)\}/)?.[1],
    ).toContain('border-color: transparent');
  });

  it('the section head’s Export is pulled back inside the 21px title line', () => {
    expect(rulesFor('.ovw-head__export')).toContain('margin: -6px 0 -4px auto');
  });
});
