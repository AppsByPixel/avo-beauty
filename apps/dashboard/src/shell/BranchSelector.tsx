import type { Branch } from '@avo/types';
import { Segmented, Skeleton } from '@avo/ui';
import { ALL_BRANCHES, useBranchScope, type BranchScope } from './BranchScope.js';

/**
 * The header's branch control — the thing that stands where
 * `{salonName} · {branches[0].name}` used to.
 *
 * ===========================================================================
 * NOT A NEW CONTROL. `routes/Reports.tsx:90`'s CONTROL, IN A SECOND PLACE
 * ===========================================================================
 * The design bundle has no branch switcher anywhere, so there is no drawn
 * component to build and inventing one would be a restyle (CLAUDE.md). Reports
 * already solved this exact problem in this exact product with the shared
 * `Segmented`: `{ value: 'all', label: 'All branches' }` first, then one option
 * per branch, rendering the NAME while sending the ID. Same options, same
 * label, same component, same copy — so this is a consistency fix rather than a
 * design decision. The two are now literally the same selection (see
 * `BranchScope.tsx`), which is the other half of not inventing anything.
 *
 * ===========================================================================
 * THE FOUR STATES, AND WHY EACH ONE IS DRAWN THE WAY IT IS
 * ===========================================================================
 * This control is unusual among the dashboard's states in that its host CANNOT
 * fail with it: the header renders on every screen, including the ones whose
 * own read has failed, so "show the section's error block" is not available.
 * Every branch below therefore has to be something a header can carry.
 *
 *   PENDING — a Skeleton the size of the control. Never an eager
 *     "All branches", which is a claim about a salon we have not loaded yet,
 *     and never the old `'—'`, which reads as "this salon has no branches".
 *     interaction-spec.md §4's rule about not painting a value before the value
 *     exists is not only about money.
 *
 *   ERROR — NOTHING. The header keeps rendering, with the salon name and no
 *     branch claim at all. This is the case most likely to be got wrong, so:
 *     falling back to "All branches" would be a scope claim built on a list we
 *     failed to fetch, and offering a retry would put a second, competing error
 *     affordance in a chrome element that sits above whatever error the SECTION
 *     is already showing. Saying nothing is the only answer that adds no claim.
 *     Every consumer stays on `'all'` — the pre-existing, unfiltered behaviour —
 *     so a failed branch list degrades to exactly the dashboard we had before.
 *
 *   ONE BRANCH — the name, as static text in the same pill. There is no choice
 *     to offer, and a radiogroup with a single radio is a control that cannot
 *     do anything. This is also the one case the OLD code got right: for a
 *     single-branch salon "Salmiya" and "the whole salon" are the same scope,
 *     so the label was true. It stays true, and it stays a label.
 *
 *   NO BRANCHES — nothing, for the same reason as ERROR: there is no branch to
 *     name. The old `'—'` was a placeholder for a missing value; an empty list
 *     is not a missing value.
 */
export function BranchSelector() {
  const { selected, select, branches, status } = useBranchScope();
  return (
    <BranchSelectorView
      selected={selected}
      onSelect={select}
      branches={branches}
      status={status}
    />
  );
}

export interface BranchSelectorViewProps {
  selected: string;
  onSelect: (next: string) => void;
  branches: Branch[];
  status: BranchScope['status'];
}

/**
 * The rendering, split from the wiring so the four states above can be asserted
 * as PIXELS rather than as source text.
 *
 * `stateCensus.test.ts` scans `routes/` for the states vocabulary and would not
 * reach a shell component at all; and even where it does reach a file, a scan
 * proves a `Skeleton` is imported, not that a pending header draws one instead
 * of the word "Salmiya". `routes/shopRender.test.tsx` made the same split for
 * the same reason and states it: none of these guarantees is about a component
 * drawing a value wrongly, they are about WHICH branch renders.
 */
export function BranchSelectorView({
  selected,
  onSelect,
  branches,
  status,
}: BranchSelectorViewProps) {
  if (status === 'pending') {
    return <Skeleton width={132} height={30} />;
  }

  // A failed list and an empty list both mean: make no claim about the scope.
  if (status === 'error' || branches.length === 0) return null;

  const only = branches[0];
  if (branches.length === 1 && only) {
    return <span className="dash-header__branch">{only.name}</span>;
  }

  return (
    <Segmented
      label="Branch"
      value={selected}
      onChange={onSelect}
      options={[
        { value: ALL_BRANCHES, label: 'All branches' },
        /* The segment renders the name; the value it sends is the id. */
        ...branches.map((b) => ({ value: b.id, label: b.name })),
      ]}
    />
  );
}
