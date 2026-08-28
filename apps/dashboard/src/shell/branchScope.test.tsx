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
import type { Branch } from '@avo/types';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { branchQuery, parseMetricsResponse, type ScopedSalonMetrics } from '../api/salon.js';
import { ScopeNotice, appliedBranchOf, scopeWasIgnored } from '../routes/Overview.js';
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

const FIGURES = {
  activeMembers: 412,
  activeMembersDelta: 6,
  loadedTodayFils: 184500,
  knetSharePercent: 62,
  repeatRatePercent: 48,
  upcomingAppointments: 3,
  nextAppointmentAt: '2026-08-29T13:30:00.000Z',
};

describe('what the screen claims comes off the echo, never off the request', () => {
  it('reads the branch the server says it applied', () => {
    const scoped = parseMetricsResponse({
      ...FIGURES,
      branchId: 'BR-KWC',
      branchName: 'Kuwait City',
    });
    expect(scoped.applied).toEqual({ branchId: 'BR-KWC', branchName: 'Kuwait City' });
    expect(scoped.metrics.activeMembers).toBe(412);
  });

  it('tells a salon-wide answer apart from no answer at all', () => {
    const wide = parseMetricsResponse({ ...FIGURES, branchId: null, branchName: null });
    expect(wide.applied).toEqual({ branchId: null, branchName: null });

    /*
     * AN API WITHOUT THE PARAMETER — lane A's endpoint may not be merged when
     * this ships, and this is the shape its answer has. `undefined`, not
     * `{ branchId: null }`: "the server says salon-wide" and "the server did not
     * answer the question" are different facts, and only the second one means a
     * branch we ASKED for was silently dropped.
     */
    expect(parseMetricsResponse(FIGURES).applied).toBeUndefined();
  });

  it('refuses half an echo rather than claiming a scope from it', () => {
    expect(() => parseMetricsResponse({ ...FIGURES, branchId: 'BR-KWC' })).toThrow(
      /branchId\/branchName/,
    );
    expect(() => parseMetricsResponse({ ...FIGURES, branchId: 7, branchName: 'x' })).toThrow(
      /neither a string nor null/,
    );
  });

  const scoped = (applied: ScopedSalonMetrics['applied']): ScopedSalonMetrics => ({
    metrics: parseMetricsResponse(FIGURES).metrics,
    applied,
  });

  it('is not a mismatch when the server applied what was asked', () => {
    expect(scopeWasIgnored('BR-KWC', scoped({ branchId: 'BR-KWC', branchName: 'Kuwait City' })))
      .toBe(false);
  });

  it('is not a mismatch on the salon-wide default', () => {
    expect(scopeWasIgnored('all', scoped({ branchId: null, branchName: null }))).toBe(false);
    expect(scopeWasIgnored('all', scoped(undefined))).toBe(false);
  });

  /**
   * THE CASE THIS WHOLE MECHANISM EXISTS FOR. An older API ignores `?branch=`
   * and answers 200 with salon-wide figures. Believing our own request here
   * would put "Kuwait City" over both branches' numbers — the defect the
   * selector replaced, one layer down and harder to see.
   */
  it('is a mismatch when a branch was asked for and the workspace ignored it', () => {
    expect(scopeWasIgnored('BR-KWC', scoped(undefined))).toBe(true);
    expect(scopeWasIgnored('BR-KWC', scoped({ branchId: null, branchName: null }))).toBe(true);
    expect(scopeWasIgnored('BR-KWC', scoped({ branchId: 'BR-SAL', branchName: 'Salmiya' }))).toBe(
      true,
    );
  });

  it('claims nothing before figures arrive', () => {
    expect(scopeWasIgnored('BR-KWC', undefined)).toBe(false);
    expect(appliedBranchOf(undefined)).toBeNull();
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
