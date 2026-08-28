// @vitest-environment jsdom

/**
 * The header's branch scope — the fix, and the four ways it could quietly come
 * undone.
 *
 * =========================================================================
 * WHAT WAS WRONG, STATED ONCE, SO THE ASSERTIONS BELOW HAVE A SUBJECT
 * =========================================================================
 * `MerchantShell.tsx:66` read `salon?.branches?.[0]?.name ?? '—'` and the header
 * rendered `{salonName} · {branchLabel}`. For SAL-AMARA — Salmiya and Kuwait
 * City — that printed "Salmiya" above four KPI tiles computed over both. Not a
 * stale value: a *specific* one, permanently wrong for every multi-branch
 * merchant and accidentally right for every single-branch one.
 *
 * The regression this file exists to prevent is therefore not "the selector
 * disappears" — that would be visible. It is the label coming back: someone
 * needing a string where a control now sits, reaching for `branches[0].name`
 * because it is right there on the salon object, and shipping a header that
 * names one branch over salon-wide numbers again. So the first describe scans
 * the SOURCE, and it is the assertion that matters most.
 *
 * =========================================================================
 * AND FOUR STATES A SOURCE SCAN CANNOT SEE
 * =========================================================================
 * `stateCensus.test.ts` scans `routes/` and never reaches `shell/`; even where
 * it reaches a file it proves `Skeleton` is imported, not that the pending
 * header draws one INSTEAD of a branch name. Every case below is about which
 * branch renders, which only rendering can answer:
 *
 *   pending  a skeleton, never an eager "All branches" and never the old '—'
 *   error    nothing at all — no scope claim built on a list that did not load
 *   one      the name, as text; there is nothing to choose between
 *   many     the segment, "All branches" first, names shown and ids sent
 *
 * The last describe covers the other half of the honesty: the client asks for a
 * branch, and lane A's endpoint may not be merged when this ships. What the
 * screen CLAIMS comes off the server's echo, never off its own request.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Branch, SalonMetrics } from '@avo/types';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { branchQuery, parseMetricsResponse } from '../api/salon.js';
import {
  AssumedNote,
  KpiRow,
  ScopeNotice,
  appliedBranchOf,
  scopeWasIgnored,
} from '../routes/Overview.js';
import { stripComments } from '../testing/stripComments.js';
import { ALL_BRANCHES, selectionIsStale } from './BranchScope.js';
import { BranchSelectorView } from './BranchSelector.js';

/*
 * NOT AUTOMATIC — this project does not run vitest with `globals`, so
 * `@testing-library/react` never registers its own `afterEach(cleanup)`. Without
 * it every `render()` accumulates in one document and the first query matching
 * two nodes fails, pointing at the component instead of at the leftovers.
 * `routes/shopRender.test.tsx` carries the same line and the same warning.
 */
afterEach(cleanup);

const SALMIYA: Branch = { id: 'BR-SAL', salonId: 'SAL-AMARA', name: 'Salmiya', nameAr: null };
const KUWAIT_CITY: Branch = {
  id: 'BR-KWC',
  salonId: 'SAL-AMARA',
  name: 'Kuwait City',
  nameAr: null,
};
const BOTH = [SALMIYA, KUWAIT_CITY];

const read = (rel: string) =>
  stripComments(readFileSync(join(__dirname, rel), 'utf8'));

/* ------------------------------------------------------- the label is gone -- */

describe('the header does not name one branch over salon-wide figures', () => {
  /**
   * THE ASSERTION THIS FILE WAS WRITTEN FOR.
   *
   * Comments are blanked first (`stripComments`), which is load-bearing rather
   * than tidy: `MerchantShell.tsx` now carries a paragraph QUOTING the deleted
   * expression so the next reader knows why nothing is computed there, and
   * `Header.tsx`'s prop doc quotes it too. A naive `includes()` would find the
   * corrected history and report it as the uncorrected code — the exact trap
   * `testing/stripComments.ts` documents, live in the file it is scanning.
   */
  it('MerchantShell computes no branch label at all', () => {
    const src = read('MerchantShell.tsx');
    expect(src).not.toMatch(/branches\s*\??\.\s*\[\s*0\s*\]/);
    expect(src).not.toContain('branchLabel');
  });

  it('Header renders whatever it is handed, and derives no branch itself', () => {
    const src = read('Header.tsx');
    expect(src).not.toMatch(/branches\s*\??\.\s*\[\s*0\s*\]/);
    expect(src).not.toContain('branchLabel');
    // The slot is a node — a `string` prop here is what made a label the only
    // possible rendering.
    expect(src).toContain('branch: ReactNode');
  });

  /**
   * The selector is not merely present in the tree — it is present in the SLOT.
   * A `<BranchSelector />` mounted somewhere else with a leftover string in the
   * header would satisfy an import scan and reproduce the bug exactly.
   */
  it('the shell hands the header the selector, not a string', () => {
    expect(read('MerchantShell.tsx')).toContain('branch={<BranchSelector />}');
  });
});

/* ------------------------------------------------------------- four states -- */

describe('the branch control has a rendering for every state the header can be in', () => {
  const view = (props: Partial<Parameters<typeof BranchSelectorView>[0]> = {}) =>
    render(
      <BranchSelectorView
        selected={ALL_BRANCHES}
        onSelect={() => {}}
        branches={BOTH}
        status="ready"
        {...props}
      />,
    );

  it('draws a skeleton while the branch list is loading, and claims nothing', () => {
    const { container } = view({ status: 'pending', branches: [] });
    expect(container.querySelector('.avo-skeleton')).not.toBeNull();
    // Neither the eager default nor the old placeholder.
    expect(container.textContent).not.toContain('All branches');
    expect(container.textContent).not.toContain('—');
    expect(screen.queryByRole('radiogroup')).toBeNull();
  });

  /**
   * THE HEADER STILL RENDERS; THE BRANCH SLOT IS EMPTY. There is no error block
   * here on purpose — the header sits above whatever error the section itself is
   * showing, and a second retry affordance in the chrome competes with it. An
   * empty slot adds no claim, which is the only safe thing to add.
   */
  it('renders nothing when the branch list failed to load', () => {
    const { container } = view({ status: 'error', branches: [] });
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing for a salon with no branches', () => {
    const { container } = view({ status: 'ready', branches: [] });
    expect(container.innerHTML).toBe('');
  });

  /**
   * ONE BRANCH IS THE CASE THE OLD CODE GOT RIGHT, and it stays right. "Salmiya"
   * and "the whole salon" are the same scope for this merchant, so the name is a
   * true label — and a radiogroup with one radio is a control that cannot do
   * anything.
   */
  it('shows the name, and no control, for a single-branch salon', () => {
    view({ branches: [SALMIYA] });
    expect(screen.getByText('Salmiya')).toBeTruthy();
    expect(screen.queryByRole('radiogroup')).toBeNull();
  });

  it('offers All branches first, then every branch by name, for a multi-branch salon', () => {
    view();
    const options = screen.getAllByRole('radio').map((el) => el.textContent);
    expect(options).toEqual(['All branches', 'Salmiya', 'Kuwait City']);
    // The default is salon-wide — never `branches[0]`, which is the whole bug.
    expect(screen.getByRole('radio', { name: 'All branches' }).getAttribute('aria-checked')).toBe(
      'true',
    );
  });

  /** The segment shows the NAME and reports the ID — `?branch=` takes the id. */
  it('reports the branch id, not the label, when a branch is picked', () => {
    const onSelect = vi.fn();
    view({ onSelect });
    fireEvent.click(screen.getByRole('radio', { name: 'Kuwait City' }));
    expect(onSelect).toHaveBeenCalledWith('BR-KWC');
  });
});

/* -------------------------------------------------- a selection that expires -- */

describe('a selection that no longer names a branch falls back to salon-wide', () => {
  it('is stale once the list loads without it', () => {
    expect(selectionIsStale('BR-GONE', BOTH, 'ready')).toBe(true);
  });

  it('is not stale while the list is still pending', () => {
    // An empty list during pending is not evidence that a branch disappeared.
    expect(selectionIsStale('BR-SAL', [], 'pending')).toBe(false);
  });

  it('is not stale when the list failed to load', () => {
    expect(selectionIsStale('BR-SAL', [], 'error')).toBe(false);
  });

  it('leaves a live selection and the all-branches default alone', () => {
    expect(selectionIsStale('BR-SAL', BOTH, 'ready')).toBe(false);
    expect(selectionIsStale(ALL_BRANCHES, BOTH, 'ready')).toBe(false);
  });
});

/* ------------------------------------------------------------- on the wire -- */

describe('the request says what was chosen', () => {
  it('omits the parameter for all branches — the request that existed before', () => {
    expect(branchQuery('all')).toBe('');
  });

  it('sends the branch id when one is chosen', () => {
    expect(branchQuery('BR-KWC')).toBe('?branch=BR-KWC');
  });

  it('escapes an id rather than pasting it into the query raw', () => {
    expect(branchQuery('BR &A')).toBe('?branch=BR%20%26A');
  });

  /**
   * THE PATH LITERAL STAYS AT THE CALL SITE. `merchantScopeGates.test.ts` reads
   * path literals out of `authedRequest(…)` to prove no merchant-scope call
   * lands on a scanner-gated route; a path built inside a helper is a call that
   * sweep cannot see. Hiding this one behind a `metricsPath()` took the metrics
   * endpoint out of the sweep with nothing turning red — 44 cases became 43.
   * Pinned here so the tidier refactor cannot be made again by accident.
   */
  it('leaves the metrics path where the surface sweep can read it', () => {
    const src = stripComments(
      readFileSync(join(__dirname, '..', 'api', 'salon.ts'), 'utf8'),
    );
    expect(src).toMatch(/authedRequest<unknown>\(\s*'merchant',\s*`\/salons\/\$\{salonId\}\/metrics/);
  });
});

/* ---------------------------------------------- and the claim says what came -- */

/**
 * A salon-wide answer. `branchId`/`branchAssumed` null, money present — the
 * shape the endpoint has always had, plus the echo.
 */
const SALON_WIDE = {
  activeMembers: 412,
  activeMembersDelta: 6,
  loadedTodayFils: 184500,
  knetSharePercent: 62,
  repeatRatePercent: 48,
  upcomingAppointments: 3,
  nextAppointmentAt: '2026-08-29T13:30:00.000Z',
  branchId: null,
  branchName: null,
  branchAssumed: null,
};

/**
 * The same endpoint under `?branch=`. THE MONEY FIELDS ARE NULL, and that is the
 * contract rather than a gap: a top-up happens in the customer's app and has no
 * branch, so the server skips those queries instead of attributing a salon's
 * whole day to whichever branch sorts first.
 */
const BY_BRANCH = {
  ...SALON_WIDE,
  activeMembers: 41,
  activeMembersDelta: 0,
  loadedTodayFils: null,
  knetSharePercent: null,
  branchId: 'BR-KWC',
  branchName: 'Kuwait City',
  branchAssumed: { activeMembers: 2, visits: 5, visitsTotal: 5, upcomingAppointments: 0 },
};

const wide = (): SalonMetrics => parseMetricsResponse(SALON_WIDE);
const byBranch = (over: Record<string, unknown> = {}): SalonMetrics =>
  parseMetricsResponse({ ...BY_BRANCH, ...over });

describe('what the screen claims comes off the echo, never off the request', () => {
  it('reads the branch the server says it applied', () => {
    const m = byBranch();
    expect(m.branchId).toBe('BR-KWC');
    expect(m.branchName).toBe('Kuwait City');
    expect(m.activeMembers).toBe(41);
  });

  /**
   * REQUIRED-BUT-NULLABLE, NOT OPTIONAL. Both halves of this feature are on
   * `dev`, so there is no deploy window in which a conforming server omits the
   * echo — and a server that omits it anyway must fail loudly rather than have
   * the client quietly decide the figures are salon-wide. This is the assertion
   * that replaced the old `applied: undefined` fold when trunk widened the
   * schema at 74ffacf.
   */
  it('refuses a response that omits the echo rather than guessing salon-wide', () => {
    const { branchId, branchName, ...noEcho } = SALON_WIDE;
    expect(() => parseMetricsResponse(noEcho)).toThrow();
    expect(() => parseMetricsResponse({ ...SALON_WIDE, branchId: 7 })).toThrow();
  });

  it('is not a mismatch when the server applied what was asked', () => {
    expect(scopeWasIgnored('BR-KWC', byBranch())).toBe(false);
  });

  it('is not a mismatch on the salon-wide default', () => {
    expect(scopeWasIgnored('all', wide())).toBe(false);
  });

  /**
   * THE CASE THIS MECHANISM EXISTS FOR. Unreachable against a conforming server
   * — an unknown branch is a 404 and a valid one is echoed — and kept precisely
   * because that is an argument about the server, not about this screen. The
   * comparison is what makes the screen structurally unable to claim a scope it
   * was not given.
   */
  it('is a mismatch when a branch was asked for and the workspace ignored it', () => {
    expect(scopeWasIgnored('BR-KWC', wide())).toBe(true);
    expect(scopeWasIgnored('BR-KWC', byBranch({ branchId: 'BR-SAL', branchName: 'Salmiya' }))).toBe(
      true,
    );
  });

  it('claims nothing before figures arrive', () => {
    expect(scopeWasIgnored('BR-KWC', undefined)).toBe(false);
    expect(appliedBranchOf(undefined)).toBeNull();
  });
});

/* ------------------------------------------- the tile with no per-branch answer */

describe('"Loaded today" under a branch is an absence, not a zero', () => {
  /**
   * THE ASSERTION THAT MATTERS MOST IN THIS FILE.
   *
   * `loadedTodayFils` is null under a branch. The one-character fix at the
   * render site is `?? 0`, which typechecks, renders, and puts **0.000 KD**
   * under "Loaded today" for a merchant who selected Kuwait City — reinstating
   * at the last layer the exact false zero `services/metrics.ts` was
   * restructured to prevent. Nothing upstream can catch that: the API is
   * correct, the schema is correct, the types are correct, and the glass lies.
   */
  it('never paints 0.000 for a figure the workspace did not answer', () => {
    const { container } = render(<KpiRow metrics={byBranch()} loading={false} />);
    expect(container.textContent).not.toContain('0.000');
    // Nor the unit, which would frame the dash as an amount.
    expect(container.textContent).not.toContain('KD');
  });

  it('says why the value is a dash, in the tile', () => {
    render(<KpiRow metrics={byBranch()} loading={false} />);
    expect(screen.getByText('Top-ups happen in the app, not at a branch')).toBeTruthy();
  });

  /**
   * The tile STAYS. A tile that vanishes when a branch is picked reads as "this
   * figure does not exist" rather than "this figure has no per-branch answer" —
   * `Reports.tsx` makes the same argument about a refused card, and the KPI row
   * is a four-column grid that a missing tile would visibly break.
   */
  it('keeps all four tiles, so nothing reads as "this figure does not exist"', () => {
    render(<KpiRow metrics={byBranch()} loading={false} />);
    for (const label of ['Active members', 'Loaded today', 'Repeat rate', 'Upcoming today']) {
      expect(screen.getByText(label)).toBeTruthy();
    }
  });

  /** The KNET delta hangs off the same null and simply has nothing to say. */
  it('drops the KNET share rather than rendering 0% via KNET', () => {
    const { container } = render(<KpiRow metrics={byBranch()} loading={false} />);
    expect(container.textContent).not.toContain('via KNET');
  });

  it('still renders the money and the KNET share at all branches', () => {
    const { container } = render(<KpiRow metrics={wide()} loading={false} />);
    expect(container.textContent).toContain('184.500');
    expect(container.textContent).toContain('KD');
    expect(container.textContent).toContain('62% via KNET');
    expect(container.textContent).not.toContain('Top-ups happen in the app');
  });

  it('skeletons before data, never a zero and never the dash', () => {
    const { container } = render(<KpiRow metrics={undefined} loading />);
    expect(container.querySelectorAll('.avo-skeleton').length).toBeGreaterThan(0);
    expect(container.textContent).not.toContain('0.000');
    expect(container.textContent).not.toContain('Top-ups happen');
  });
});

/* --------------------------------------------- how much of the answer is a guess */

describe('the assumed-branch caveat is a size, and disappears on its own', () => {
  it('says nothing at all branches, where every figure is exact', () => {
    const { container } = render(<AssumedNote metrics={wide()} />);
    expect(container.innerHTML).toBe('');
  });

  /**
   * THE PROPERTY THE COUNT WAS CHOSEN FOR. When branch-bound scanner sessions
   * ship, these counts fall to zero and the caveat leaves the UI with no code
   * change and nobody remembering to remove it. A boolean, or a fixed "may be
   * approximate" line, would have to be deleted by hand on that day.
   */
  it('says nothing when a branch is applied but nothing was inferred', () => {
    const exact = byBranch({
      branchAssumed: { activeMembers: 0, visits: 0, visitsTotal: 12, upcomingAppointments: 0 },
    });
    const { container } = render(<AssumedNote metrics={exact} />);
    expect(container.innerHTML).toBe('');
  });

  it('reports the ratio for each figure that has doubt, and only those', () => {
    render(<AssumedNote metrics={byBranch()} />);
    const text = screen.getByRole('status').textContent ?? '';
    expect(text).toContain('2 of 41 members');
    expect(text).toContain('5 of 5 visits');
    // upcomingAppointments is 0 here — a "0 of 3" clause would be noise.
    expect(text).not.toContain('appointments');
    expect(text).toContain('treat these branch figures as approximate');
  });

  it('distinguishes a figure that is entirely a guess from one that is barely', () => {
    const total = byBranch({
      activeMembers: 9,
      branchAssumed: { activeMembers: 9, visits: 0, visitsTotal: 40, upcomingAppointments: 0 },
    });
    expect(render(<AssumedNote metrics={total} />).container.textContent).toContain('9 of 9 members');
    cleanup();
    const barely = byBranch({
      activeMembers: 9,
      branchAssumed: { activeMembers: 1, visits: 0, visitsTotal: 40, upcomingAppointments: 0 },
    });
    expect(render(<AssumedNote metrics={barely} />).container.textContent).toContain('1 of 9 members');
  });

  it('joins three clauses without an Oxford comma, as the copy elsewhere sets', () => {
    const all = byBranch({
      activeMembers: 41,
      upcomingAppointments: 3,
      branchAssumed: { activeMembers: 2, visits: 5, visitsTotal: 5, upcomingAppointments: 1 },
    });
    expect(render(<AssumedNote metrics={all} />).container.textContent).toContain(
      'Branch assumed on 2 of 41 members, 5 of 5 visits and 1 of 3 appointments',
    );
  });

  it('renders nothing before figures arrive', () => {
    expect(render(<AssumedNote metrics={undefined} />).container.innerHTML).toBe('');
  });
});

describe('the notice says what the figures actually cover', () => {
  it('names the whole salon when the branch filter was not applied', () => {
    render(<ScopeNotice requestedName="Kuwait City" appliedName={null} appliedBranchId={null} />);
    const text = screen.getByRole('status').textContent ?? '';
    expect(text).toContain('Showing all branches');
    expect(text).toContain('Kuwait City');
    expect(text).toContain('the whole salon');
  });

  it('names the branch the server actually answered with', () => {
    render(
      <ScopeNotice requestedName="Kuwait City" appliedName="Salmiya" appliedBranchId="BR-SAL" />,
    );
    const text = screen.getByRole('status').textContent ?? '';
    expect(text).toContain('Showing Salmiya');
    expect(text).toContain('Kuwait City');
  });

  /**
   * It is announced. A correction to figures a merchant is already reading is
   * exactly the case `role="status"` is for — and the reason `InfoBanner` was
   * not reused: its own header says it is standing prose that "never changes and
   * is not the result of anything the merchant did".
   */
  it('is announced, and adds no retry button to chrome that cannot retry', () => {
    render(<ScopeNotice requestedName="Kuwait City" appliedName={null} appliedBranchId={null} />);
    expect(screen.getByRole('status')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
