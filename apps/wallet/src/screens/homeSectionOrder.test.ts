/**
 * HOME'S SECTION ORDER, ASSERTED AGAINST THE DESIGN ITSELF.
 *
 * WHY THIS FILE EXISTS
 * ====================
 * `TopUpCard` was rendered BELOW the Upcoming block for weeks. The design puts it
 * above — `<!-- TOP UP + BONUS -->` at design:283, `<!-- UPCOMING -->` at
 * design:312 — and the note sitting on the Upcoming block asserted the opposite
 * *while citing the very lines that disprove it*, so every reader who checked the
 * citation found a real line number and believed it.
 *
 * Nothing could have caught it. Vertical order is invisible in a unit test of any
 * component, invisible in a typecheck, and invisible in a diff that only moves a
 * JSX block. The only witness is the screen, and the mock ships
 * `modules.booking: false` (packages/mock/src/fixtures.ts:39), so on a dev machine
 * the Upcoming block collapses to nothing and the two cards cannot even be seen in
 * the same screenshot. That is why it survived: the one configuration a human
 * looks at is the one configuration that hides the bug.
 *
 * HOW IT ASSERTS
 * ==============
 * It does not hardcode the expected order — a constant in a test is just the same
 * claim written twice, and the failure here was precisely a confident local claim
 * that disagreed with the design. Instead it reads BOTH files: the section-marker
 * comments in `design/AVO Wallet Home.dc.html` give the intended order, the render
 * body of `HomeScreen.tsx` gives the built order, and the two must agree. Move a
 * section in the design and this test tells you the screen has not followed yet.
 *
 * It scans source text rather than rendering, for the same reason
 * `theme/brandBootOrder.test.ts` does: rendering `HomeScreen` means standing up a
 * session, an API client and five hooks, and the property under test is structural
 * — where a block sits in the file — not behavioural.
 *
 * ADDING A SECTION
 * ================
 * Add one entry to `BUILT`. `<!-- MEMBERSHIP -->` (design:343) is the last section
 * on Home and is deliberately absent from that map because it is not built yet;
 * see `UNBUILT` below, which keeps the gap recorded rather than merely missing.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/** apps/wallet/src/screens → the repository root. */
const ROOT = resolve(__dirname, '..', '..', '..', '..');
const DESIGN = resolve(ROOT, 'design', 'AVO Wallet Home.dc.html');
const SCREEN = resolve(__dirname, 'HomeScreen.tsx');

/**
 * Design section marker → the anchors that render it in `HomeScreen.tsx`.
 *
 * Several anchors for one section means "the earliest of these": the Upcoming
 * block is a ternary over four different components (loading, failed, card, and
 * the empty CARD rather than nothing), and any of them may come first in the
 * source without changing where the SECTION sits on the screen.
 */
const BUILT: ReadonlyArray<{ marker: string; anchors: readonly string[] }> = [
  { marker: 'HAPPY HOUR', anchors: ['<HappyHourBanner'] },
  { marker: 'WALLET CARD', anchors: ['<WalletCard'] },
  { marker: 'EARNING BY BRANCH', anchors: ['<BranchEarning'] },
  { marker: 'TOP UP + BONUS', anchors: ['<TopUpCard'] },
  {
    marker: 'UPCOMING',
    anchors: ['<UpcomingSkeleton', '<UpcomingFailedCard', '<UpcomingCard', '<NoUpcomingCard'],
  },
  { marker: 'ACTIVITY', anchors: ['<ActivityFeed'] },
  { marker: 'MEMBERSHIP', anchors: ['<MembershipSection'] },
];

/**
 * Recorded, not forgotten.
 *
 * Empty since MEMBERSHIP was built. The list stays, and so does the test below
 * it, because the next section this design grows will want the same treatment —
 * and because an empty list is a claim ("every section of this design is built")
 * that the `BUILT` map above is now asserted against.
 */
const UNBUILT: readonly string[] = [];

const design = readFileSync(DESIGN, 'utf8');
const screen = readFileSync(SCREEN, 'utf8');

/**
 * The line number of `<!-- MARKER -->` in the design.
 *
 * `HAPPY HOUR` is deliberately matched as a prefix: the design splits it into
 * `<!-- HAPPY HOUR LIVE -->` and `<!-- HAPPY HOUR NEXT -->`, two markers for the
 * one banner component, and the first of them is where the section starts.
 */
function designLine(marker: string): number {
  const lines = design.split('\n');
  const at = lines.findIndex((l) => l.trimStart().startsWith(`<!-- ${marker}`));
  return at + 1; // 1-based, and 0 when absent
}

function builtIndex(anchors: readonly string[]): number {
  const found = anchors.map((a) => screen.indexOf(a)).filter((i) => i >= 0);
  return found.length === 0 ? -1 : Math.min(...found);
}

describe("Home's sections sit in the design's order", () => {
  it('every mapped section is present in both files', () => {
    for (const { marker, anchors } of BUILT) {
      expect(designLine(marker), `<!-- ${marker} --> is missing from ${DESIGN}`).toBeGreaterThan(0);
      expect(
        builtIndex(anchors),
        `none of ${anchors.join(', ')} renders in HomeScreen.tsx for <!-- ${marker} -->`,
      ).toBeGreaterThanOrEqual(0);
    }
  });

  it('the built order matches the design order', () => {
    const byDesign = [...BUILT].sort((a, b) => designLine(a.marker) - designLine(b.marker));
    const byBuild = [...BUILT].sort((a, b) => builtIndex(a.anchors) - builtIndex(b.anchors));
    expect(byBuild.map((s) => s.marker)).toEqual(byDesign.map((s) => s.marker));
  });

  /**
   * The specific inversion this file was written for, spelled out so a failure
   * names the defect instead of printing two lists for someone to diff by eye.
   */
  it('Top up sits ABOVE Upcoming, as design:283 sits above design:312', () => {
    const topUp = BUILT.find((s) => s.marker === 'TOP UP + BONUS')!;
    const upcoming = BUILT.find((s) => s.marker === 'UPCOMING')!;

    expect(designLine(topUp.marker)).toBeLessThan(designLine(upcoming.marker));
    expect(
      builtIndex(topUp.anchors),
      'TopUpCard must render before the Upcoming block — Aftab asked for it and the design has always said so',
    ).toBeLessThan(builtIndex(upcoming.anchors));
  });

  it('records the sections of this design that are not built yet', () => {
    for (const marker of UNBUILT) {
      expect(designLine(marker), `<!-- ${marker} --> vanished from the design`).toBeGreaterThan(0);
      expect(
        BUILT.some((s) => s.marker === marker),
        `${marker} is built now — move it from UNBUILT into BUILT so its position is asserted`,
      ).toBe(false);
    }
  });

  /**
   * The half that stops `UNBUILT: []` from being a free pass.
   *
   * With the list empty, the loop above iterates nothing and says nothing. This
   * reads the design's own section markers instead and requires every one of
   * them to be accounted for — asserted in `BUILT` or declared in `UNBUILT` —
   * so a section ADDED to the design cannot go unnoticed by this file.
   *
   * SCOPED TO THE HOME BLOCK, which is what this file is about. The design
   * bundle is one document holding every screen, delimited by
   * `<!-- ===== NAME ===== -->` dividers, and the first attempt at this test
   * swept up `TOAST`, `CART SHEET` and eight others from further down the file.
   * So the window is the `HOME` divider to the next divider of that form.
   *
   * `HAPPY HOUR LIVE` and `HAPPY HOUR NEXT` are the one banner the `HAPPY HOUR`
   * prefix already covers, and the markers are matched by prefix for that
   * reason; both therefore resolve to a mapped section rather than a missing one.
   */
  it('accounts for every section marker in the design\'s HOME block', () => {
    const lines = design.split('\n');
    const divider = /^<!-- =+ (.+?) =+ -->$/;
    const start = lines.findIndex((l) => divider.exec(l.trim())?.[1] === 'HOME');
    expect(start, "the design's HOME divider moved or was renamed").toBeGreaterThan(-1);

    const after = lines.slice(start + 1);
    const end = after.findIndex((l) => divider.test(l.trim()));
    const block = end === -1 ? after : after.slice(0, end);

    const markers = block
      .map((l) => /^<!-- (.+?) -->$/.exec(l.trim())?.[1])
      .filter((m): m is string => Boolean(m) && !divider.test(`<!-- ${m} -->`));

    const known = [...BUILT.map((s) => s.marker), ...UNBUILT];
    const unaccounted = [...new Set(markers)].filter(
      (m) => !known.some((k) => m === k || m.startsWith(`${k} `)),
    );

    expect(
      unaccounted,
      'these design sections are neither asserted in BUILT nor declared in UNBUILT',
    ).toEqual([]);
  });
});
