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
import { ACTIVITY_VISIBLE, discloseActivity } from './activity';

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

  it('reveals the rest once asked, and then has nothing left to offer', () => {
    const d = discloseActivity(rows(9), true);
    expect(d.visible).toHaveLength(9);
    // The control is drawn from `hidden`, so it disappears of its own accord
    // rather than needing a second string the bundle does not have.
    expect(d.hidden).toBe(0);
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
