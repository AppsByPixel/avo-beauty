/**
 * Row 365, dashboard/console half: every screen has its loading, empty, error
 * and offline states built — and stays having them after the people who built
 * them are gone.
 *
 * SOURCE SCANS, for lane B's stated reason (`failureStates.test.ts`): there is
 * no renderer in this workspace, and adding one rewrites the trunk-owned
 * lockfile. And as there, a render test would aim at the wrong risk — none of
 * these guarantees is about a component drawing a value wrongly:
 *
 *   the states rule    a screen that fetches renders `SectionError` (or the
 *                      Overview's ErrorState split) for its error and offline
 *                      answers, and a Skeleton while pending. `SectionError`
 *                      is where offline is told apart from a server failure
 *                      (`ApiError.isConnectivity`) and where a 403 renders the
 *                      SERVER's sentence — so its presence is the whole
 *                      four-state vocabulary, not a fraction of it.
 *   the announced rule a pending screen must not announce a zero it is not
 *                      painting. `total ?? 0` reached a sr-only <caption> as
 *                      "0 entries match the current filter" while the visible
 *                      count line correctly rendered '' — on BOTH audit
 *                      screens, found on one and fixed on its already-merged
 *                      sibling. The premature-zero class arriving through the
 *                      accessibility tree instead of the paint.
 *
 * Truthful-by-accident and announced-not-painted are the classes this build
 * keeps finding; both are invisible to a test that only checks the happy path.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const here = __dirname;
const read = (name: string) => readFileSync(join(here, name), 'utf8');

/**
 * The screens that fetch and therefore own the four states themselves.
 *
 * NOT a glob, deliberately — the exclusions below are excluded for stated
 * reasons, and a list that explains itself is the point.
 */
const SECTION_SCREENS = [
  'Overview.tsx',
  'Appointments.tsx',
  'Team.tsx',
  'Loyalty.tsx',
  'Settings.tsx',
  'Accounts.tsx',
  'AuditLog.tsx',
  'Reports.tsx',
  'console/Admins.tsx',
  'console/Analytics.tsx',
  'console/Audit.tsx',
  'console/Approvals.tsx',
  'console/Controls.tsx',
  'console/Policies.tsx',
  'console/Salons.tsx',
  /**
   * IN THIS LIST, NOT THE SUBVIEW ONE, and the census itself made the point: the
   * first run of this file classed Campaigns as a pure subview and FAILED — it
   * owns a second fetch (the submitted-campaigns queue) with its own
   * `SectionError`, deliberately, with the rationale written at the call site
   * ("the one read error in the dashboard not going through SectionError…"). The
   * wrong classification lasted exactly one test run, which is the argument for
   * the census.
   */
  'marketing/Campaigns.tsx',
] as const;

/**
 * The marketing HOST and its pure subviews.
 *
 * `Marketing.tsx` owns the shared fetch (`usePromotions` + `useSalon`) and the
 * error/offline answer for all three tabs — but NOT the pending paint: it hands
 * `loading` down and the subviews draw their own Skeletons where the cards will
 * be, so the pending layout matches the loaded one. The census's first run
 * asserted a Skeleton on the host, failed, and this is the corrected model
 * rather than a loosened assertion.
 *
 * A `SectionError` inside a PURE subview would be a second, drifting copy of
 * the host's answer — its absence is asserted, not tolerated. (Campaigns is not
 * pure — see SECTION_SCREENS.)
 */
const HOST = 'Marketing.tsx';
const HOST_SUBVIEWS = ['marketing/Boosts.tsx', 'marketing/HappyHours.tsx'] as const;

/**
 * The doors. Lane B's `PinScreen` ruling, ported: a sign-in screen owes the
 * OFFLINE guarantee — "can't reach" and "wrong password" are different next
 * moves — but it must NOT render the sections' error vocabulary, because there
 * is no session to explain and the screen IS the remedy. Each classifies
 * connectivity in its own catch instead.
 */
const DOORS = ['SignIn.tsx', 'ConsoleSignIn.tsx'] as const;

/**
 * Not screens.
 *
 *   NotBuiltYet.tsx     a static explainer with no request — its whole body is
 *                       one EmptyState; there is nothing to load, err or lose.
 *   sectionState.tsx    the shared states VOCABULARY (SectionError, WriteError,
 *                       the courtesy-gate ledger) — the thing under test, not a
 *                       tested thing.
 */
const NON_SCREENS = ['NotBuiltYet.tsx', 'sectionState.tsx'] as const;

function tsxOnDisk(dir: string, prefix = ''): string[] {
  return readdirSync(join(here, dir === '.' ? '' : dir), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.tsx'))
    .map((entry) => `${prefix}${entry.name}`);
}

describe('the screen census stays honest', () => {
  /**
   * The guard on the lists above. A screen added to any of these directories
   * joins a list or fails here BY NAME — the only moment classification is
   * cheap. This is the assertion that failed on its own author's list the
   * first time lane B ran the pattern, which is the argument for it.
   */
  it('accounts for every route component on disk, in exactly one list', () => {
    const onDisk = [
      ...tsxOnDisk('.'),
      ...tsxOnDisk('console', 'console/'),
      ...tsxOnDisk('marketing', 'marketing/'),
    ].sort();
    const accounted = [...SECTION_SCREENS, HOST, ...HOST_SUBVIEWS, ...DOORS, ...NON_SCREENS].sort();
    expect(onDisk).toEqual(accounted);
  });

  /**
   * The router agrees with the census — every component the two route tables
   * mount is a screen this file classifies as owning its states. Extracted from
   * the source rather than restated, so a new route cannot ship unaudited.
   */
  it('every routed section component is census-listed as owning its states', () => {
    const router = readFileSync(join(here, '..', 'router.tsx'), 'utf8');
    const tables = router.match(/const (?:CONSOLE_)?SECTIONS = \[[\s\S]*?\] as const;/g) ?? [];
    expect(tables).toHaveLength(2);
    const mounted = tables
      .join('\n')
      .match(/component: (\w+)/g)!
      .map((m) => m.replace('component: ', ''));
    expect(mounted.length).toBeGreaterThanOrEqual(15);
    const censusNames = [...SECTION_SCREENS, HOST].map((f) =>
      f.replace(/^(console|marketing)\//, '').replace('.tsx', ''),
    );
    for (const name of mounted) {
      expect(censusNames, `router mounts <${name}> but the census does not class it`).toContain(
        name,
      );
    }
  });
});

describe('every fetching screen owns the four-state vocabulary', () => {
  it.each(SECTION_SCREENS)('%s renders the error/offline vocabulary', (name) => {
    // SectionError carries error AND offline AND the 403 sentence; Overview
    // splits the same vocabulary through ErrorState for its stale-not-blank rule.
    expect(read(name)).toMatch(/SectionError|ErrorState/);
  });

  it.each(SECTION_SCREENS)('%s has a pending state', (name) => {
    expect(read(name)).toContain('Skeleton');
  });
});

describe('the marketing host and its pure subviews split the states as designed', () => {
  it.each(HOST_SUBVIEWS)('%s paints pending and owns write errors, never the fetch error', (name) => {
    const src = read(name);
    expect(src).toContain('Skeleton');
    expect(src).toContain('WriteError');
    expect(src).not.toContain('SectionError');
  });

  it('the host owns the shared fetch and its error/offline answer', () => {
    const src = read(HOST);
    expect(src).toContain('SectionError');
    expect(src).toContain('usePromotions');
    // The pending paint is delegated — the host must actually hand it down.
    expect(src).toMatch(/loading=\{loading\}/);
  });
});

describe('the doors classify connectivity without borrowing the sections’ vocabulary', () => {
  it.each(DOORS)('%s tells offline apart from a refusal', (name) => {
    // SignIn maps connectivity to COPY.unreachable; ConsoleSignIn asks
    // isConnectivity directly. Both are the same guarantee.
    expect(read(name)).toMatch(/isConnectivity|unreachable/);
  });

  it.each(DOORS)('%s does not render SectionError', (name) => {
    expect(read(name)).not.toContain('SectionError');
  });
});

describe('a pending screen does not announce a zero it is not painting', () => {
  /**
   * The regression pin for the sr-only caption defect. Both audit screens
   * withhold the total from the <caption> while pending; the visible count line
   * does the same. `?? 0` may exist — it is the fallback AFTER data lands — but
   * the caption must not interpolate a total unguarded.
   */
  /**
   * WHITESPACE-NORMALISED, AND THAT IS A CORRECTION THIS PIN EARNED. It used to
   * match the literal `isPending ? ''`, and it FAILED on a change that did not
   * touch the guarantee at all: making the caption say "1 entry" instead of "1
   * entries" pushed the ternary onto three lines, and the pin broke while the
   * guard it protects was still exactly there.
   *
   * A source-scanning test that asserts on a SPELLING fails on formatting and
   * passes on a rewrite that keeps the words — which is the wrong way round, and
   * the house rule ("assert on the thing, not the string") applied to the census
   * itself. Collapsing whitespace keeps it strict about the construct and blind to
   * the line breaks: deleting the guard, or interpolating `total` unguarded, still
   * fails.
   */
  it.each(['AuditLog.tsx', 'console/Audit.tsx'])('%s guards its caption count', (name) => {
    const src = read(name);
    const caption = src.slice(src.indexOf('<caption'), src.indexOf('</caption>'));
    expect(caption.replace(/\s+/g, '')).toContain("isPending?''");
  });
});
