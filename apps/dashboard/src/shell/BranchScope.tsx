import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Branch } from '@avo/types';
import { useSalon } from '../api/salon.js';

/**
 * WHICH BRANCH THE MERCHANT IS LOOKING AT — one selection, shared by the whole
 * dashboard.
 *
 * ===========================================================================
 * WHAT THIS REPLACES, AND WHY IT WAS A DEFECT RATHER THAN A MISSING FEATURE
 * ===========================================================================
 * `MerchantShell.tsx` used to compute
 *
 *     const branchLabel = salon?.branches?.[0]?.name ?? '—';
 *
 * and `Header.tsx` rendered it as `{salonName} · {branchLabel}` in a plain
 * `<span>`. For SAL-AMARA — Salmiya and Kuwait City — that put the word
 * "Salmiya" directly above four KPI tiles computed over BOTH branches. Not a
 * stale label and not an approximation: a confident, specific, permanently
 * wrong one, sitting on the first screen a salon owner sees. It was truthful
 * only for a salon with exactly one branch, by accident.
 *
 * The fix is not a better label. A label cannot be right here, because the
 * scope of the numbers underneath is genuinely a CHOICE and nothing was making
 * it. So the label becomes a control, and the control's value becomes the thing
 * the screens read. `BranchSelector.tsx` renders it in the space the old span
 * occupied; `routes/Overview.tsx` scopes its metrics to it; `routes/Reports.tsx`
 * binds its own already-built segment to it rather than keeping a second,
 * independent one.
 *
 * ===========================================================================
 * `'all'` IS THE VALUE, AND IT IS THE WIRE'S OMISSION
 * ===========================================================================
 * The selection is `'all'` or a branch id — the exact vocabulary
 * `routes/Reports.tsx` already sends on `?branch=` and `api/reports.ts` already
 * parses back off `Report.branchId`. `'all'` is the default because it is the
 * behaviour every screen had before this existed: an unfiltered, salon-wide
 * read. A default of "the first branch" would reintroduce the bug above with a
 * control bolted to it.
 *
 * NOT PERSISTED. A branch filter that survives a reload is a filter a merchant
 * can forget she set, and this whole change exists because the dashboard was
 * claiming a scope nobody had chosen. The session starts salon-wide, every time.
 *
 * ===========================================================================
 * THE BRANCH LIST IS THE SALON QUERY'S, NOT A SECOND FETCH
 * ===========================================================================
 * `GET /salons/{id}` already carries `branches`, `useSalon()` already caches it,
 * and Reports already reads it for exactly this control. A dedicated
 * `/branches` read here would be a second answer to a question one endpoint
 * already answers, and the two would drift the first time a branch is renamed.
 *
 * `status` is exposed rather than the raw query because the only thing a
 * consumer may do differently is DRAW differently — pending, ready, or "the
 * list did not arrive". The header owes a rendering for all three (CLAUDE.md:
 * a screen without its states is not done) and nothing else in the tree owes
 * a retry for a list it did not ask for.
 */
export interface BranchScope {
  /** `'all'` or a branch id. Never a name — names are for the glass. */
  selected: string;
  select: (next: string) => void;
  /** The salon's branches. Empty while pending and empty when the load failed. */
  branches: Branch[];
  status: 'pending' | 'ready' | 'error';
  /**
   * The selected branch's name, or `null` for `'all'` — and `null` also while
   * the list is still loading, because a name we cannot look up is a name we
   * must not print.
   */
  selectedName: string | null;
}

/**
 * Is the held selection one that no longer names a branch of this salon?
 *
 * Pulled out of the effect below so the rule can be asserted directly — the
 * effect's job is to `setState`, and a test of a `setState` is a test of React.
 * The three `false` cases are the whole subtlety and each is a way of NOT
 * concluding a branch has gone away from evidence that does not say so.
 */
export function selectionIsStale(
  selected: string,
  branches: Branch[],
  status: BranchScope['status'],
): boolean {
  // An empty list during pending, or after a failed load, is not evidence.
  if (status !== 'ready') return false;
  if (selected === ALL_BRANCHES) return false;
  return !branches.some((b) => b.id === selected);
}

const BranchScopeContext = createContext<BranchScope | null>(null);

/** The wire sentinel and the default. Exported so nothing re-types the string. */
export const ALL_BRANCHES = 'all';

export function BranchScopeProvider({ children }: { children: ReactNode }) {
  const salon = useSalon();
  const [selected, setSelected] = useState<string>(ALL_BRANCHES);

  const branches = useMemo<Branch[]>(() => salon.data?.branches ?? [], [salon.data]);

  const status: BranchScope['status'] = salon.isError
    ? 'error'
    : salon.data === undefined
      ? 'pending'
      : 'ready';

  /*
   * A SELECTION THAT NO LONGER NAMES A BRANCH FALLS BACK TO SALON-WIDE.
   *
   * Settings can rename, add and remove branches while this shell is mounted
   * (`api/settings.ts` invalidates `salonKeys.detail`, so the list below changes
   * underneath a held selection). A dangling id would send `?branch=BR-GONE`,
   * which the contract answers 404 `unknown_branch` — an error screen caused
   * entirely by the client holding a stale value. Falling back to `'all'` is the
   * one direction that cannot lie: it widens the scope and the selector visibly
   * moves to "All branches", rather than quietly narrowing to some other branch.
   *
   * Gated on `status === 'ready'`: an empty list during pending, or after a
   * failed load, is not evidence that the branch disappeared.
   */
  useEffect(() => {
    if (!selectionIsStale(selected, branches, status)) return;
    setSelected(ALL_BRANCHES);
  }, [status, selected, branches]);

  const value = useMemo<BranchScope>(
    () => ({
      selected,
      select: setSelected,
      branches,
      status,
      selectedName:
        selected === ALL_BRANCHES
          ? null
          : (branches.find((b) => b.id === selected)?.name ?? null),
    }),
    [selected, branches, status],
  );

  return <BranchScopeContext.Provider value={value}>{children}</BranchScopeContext.Provider>;
}

/**
 * Throws outside the provider, on purpose, in the house style of `useSalonId`.
 * A default-valued fallback would let a screen silently read `'all'` forever
 * while a merchant watched the header say otherwise — the exact class of quiet
 * disagreement this module exists to end.
 */
export function useBranchScope(): BranchScope {
  const scope = useContext(BranchScopeContext);
  if (!scope) throw new Error('useBranchScope must be used inside <BranchScopeProvider>.');
  return scope;
}
