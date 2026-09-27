/**
 * FOUR ROWS, THEN THE REST — the rule, on its own.
 *
 * The render test beside it (`components/activityFeedRender.test.tsx`) proves
 * the feed ASKS. This proves what the answer is, including the two cases that
 * are easy to get wrong by off-by-one and impossible to see on the developer's
 * own seeded account, which has more than four rows:
 *
 *   EXACTLY FOUR      nothing is hidden, so there is no control. A "show more"
 *                     that reveals nothing is a button that appears to be
 *                     broken.
 *   THREE             the same, from the other side of the boundary.
 *
 * FAILS BEFORE THIS SLICE: `discloseActivity` did not exist, and `ActivityFeed`
 * rendered `rows.map(...)` with no notion of a limit.
 */

import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_VISIBLE,
  COLLAPSE_SCROLL_MARGIN,
  collapseScrollTarget,
  discloseActivity,
} from './activity';

const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `TX-${i}` }));

describe('discloseActivity — how many she sees before she asks', () => {
  it('shows four', () => {
    expect(ACTIVITY_VISIBLE).toBe(4);
  });

  it('holds back everything past the fourth row', () => {
    const d = discloseActivity(rows(9), false);
    expect(d.visible.map((r) => r.id)).toEqual(['TX-0', 'TX-1', 'TX-2', 'TX-3']);
    expect(d.hidden).toBe(5);
  });

  it('reveals the rest once asked — nothing left to reveal, and a way back', () => {
    const d = discloseActivity(rows(9), true);
    expect(d.visible).toHaveLength(9);
    expect(d.hidden).toBe(0);
    // Until 2026-09-28 this asserted the control disappeared here. The client
    // asked for the list to shorten again, so the expanded list offers "less".
    expect(d.control).toBe('less');
  });

  it('offers "more" while rows are held back', () => {
    expect(discloseActivity(rows(9), false).control).toBe('more');
  });

  it('folding is the collapsed view again, row for row', () => {
    const open = discloseActivity(rows(9), true);
    const folded = discloseActivity(rows(9), false);
    expect(open.visible).toHaveLength(9);
    expect(folded.visible.map((r) => r.id)).toEqual(['TX-0', 'TX-1', 'TX-2', 'TX-3']);
  });
});

describe('discloseActivity — no control where there is nothing to fold either', () => {
  it('four rows, expanded or not, draws nothing', () => {
    expect(discloseActivity(rows(4), false).control).toBeNull();
    // A list that shrank to four under an expanded feed (a refresh) must not
    // keep a "show less" that folds nothing.
    expect(discloseActivity(rows(4), true).control).toBeNull();
  });

  it('five rows is the first that can fold', () => {
    expect(discloseActivity(rows(5), true).control).toBe('less');
  });
});

describe('collapseScrollTarget — folding must not strand her past the end of Home', () => {
  const SECTION_TOP = 900;

  it('scrolls back to the section when she is below its top', () => {
    // Deep in an expanded feed, pressing "Show less" at its foot.
    expect(collapseScrollTarget(1600, SECTION_TOP)).toBe(SECTION_TOP - COLLAPSE_SCROLL_MARGIN);
  });

  it('stays put when the section top is still on screen', () => {
    expect(collapseScrollTarget(0, SECTION_TOP)).toBeNull();
    expect(collapseScrollTarget(SECTION_TOP - COLLAPSE_SCROLL_MARGIN, SECTION_TOP)).toBeNull();
  });

  it('never asks for a negative offset', () => {
    expect(collapseScrollTarget(5, 4)).toBe(0);
  });
});

describe('discloseActivity — the near-empty cases, where the control must not appear', () => {
  it('draws no control at exactly four: there is nothing beneath to disclose', () => {
    const d = discloseActivity(rows(4), false);
    expect(d.visible).toHaveLength(4);
    expect(d.hidden).toBe(0);
  });

  it('draws no control at three', () => {
    const d = discloseActivity(rows(3), false);
    expect(d.visible).toHaveLength(3);
    expect(d.hidden).toBe(0);
  });

  it('draws no control at one, and none at none', () => {
    expect(discloseActivity(rows(1), false).hidden).toBe(0);
    expect(discloseActivity([], false).hidden).toBe(0);
    expect(discloseActivity([], false).visible).toEqual([]);
  });

  it('holds back exactly one at five — the first row that can be hidden', () => {
    expect(discloseActivity(rows(5), false).hidden).toBe(1);
    expect(discloseActivity(rows(5), false).visible).toHaveLength(4);
  });
});
