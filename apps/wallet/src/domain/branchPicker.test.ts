import { describe, expect, it } from 'vitest';
import {
  branchChoiceLabel,
  branchChoices,
  branchQuery,
  branchStepApplies,
  sameChoice,
  type BranchChoice,
  type PickableBranch,
} from './branchPicker';

/**
 * Two branches with an Arabic name and one WITHOUT, because that is the wire:
 * `BranchSchema.nameAr` is nullable and the seed leaves SAL-LUMIERE's branches
 * NULL on purpose. A fixture narrower than the wire hides exactly the bug the
 * wire carries — the lesson `domain/names.ts` opens with.
 */
const KWC: PickableBranch = { id: 'BR-KWC', name: 'Kuwait City', nameAr: 'مدينة الكويت' };
const SAL: PickableBranch = { id: 'BR-SAL', name: 'Salmiya', nameAr: 'السالمية' };
const NO_AR: PickableBranch = { id: 'BR-HAW', name: 'Hawally', nameAr: null };

const COPY = { branchFilterOther: 'Other artists' };

const kinds = (chips: BranchChoice[]) =>
  chips.map((c) => (c.kind === 'branch' ? c.branchId : c.kind));

describe('branchChoices — when the strip appears at all', () => {
  it('draws no strip for a single-branch salon: one option is not a choice', () => {
    expect(branchChoices({ branches: [KWC], split: { total: 4, unassigned: 0 } })).toEqual([]);
  });

  it('draws no strip for a salon with no open branch', () => {
    expect(branchChoices({ branches: [], split: { total: 4, unassigned: 0 } })).toEqual([]);
  });

  /**
   * THE COMMON CASE TODAY, and the one that must not regress: migration 0044
   * left every multi-branch salon's artists NULL. Amara in the seed is exactly
   * this — two open branches, four artists, zero assigned.
   */
  it('draws no strip when nothing is assigned, however many branches there are', () => {
    expect(branchChoices({ branches: [KWC, SAL], split: { total: 4, unassigned: 4 } })).toEqual([]);
  });

  it('draws no strip while the roster is still loading', () => {
    expect(branchChoices({ branches: [KWC, SAL], split: null })).toEqual([]);
  });

  it('draws no strip for a salon with no artists at all', () => {
    expect(branchChoices({ branches: [KWC, SAL], split: { total: 0, unassigned: 0 } })).toEqual([]);
  });
});

describe('branchChoices — every branch, then Other artists, and no All', () => {
  it('offers every branch and Other artists when the roster is mixed', () => {
    const chips = branchChoices({ branches: [KWC, SAL], split: { total: 4, unassigned: 2 } });
    expect(kinds(chips)).toEqual(['BR-KWC', 'BR-SAL', 'unassigned']);
  });

  /**
   * The third group disappears on its own as the merchant works through the
   * roster. Nothing has to be switched on.
   */
  it('drops Other artists once every artist has a branch', () => {
    const chips = branchChoices({ branches: [KWC, SAL], split: { total: 4, unassigned: 0 } });
    expect(kinds(chips)).toEqual(['BR-KWC', 'BR-SAL']);
  });

  it('keeps a branch chip whose artists are all elsewhere — an honest empty state, not a hidden chip', () => {
    // Three branches, one assigned artist. Two chips lead to "no artists here",
    // which is true and is a state the screen builds.
    const chips = branchChoices({ branches: [KWC, SAL, NO_AR], split: { total: 3, unassigned: 2 } });
    expect(kinds(chips)).toEqual(['BR-KWC', 'BR-SAL', 'BR-HAW', 'unassigned']);
  });

  /**
   * Aftab, 2026-09-29: "Remove all branches option in the select branch while
   * booking". The first row is a real branch, and no row means "all".
   */
  it('leads with a real branch, never an All choice', () => {
    const chips = branchChoices({ branches: [KWC, SAL], split: { total: 4, unassigned: 1 } });
    expect(chips[0]).toEqual({ kind: 'branch', branchId: 'BR-KWC' });
    expect(chips.some((c) => (c as { kind: string }).kind === 'all')).toBe(false);
  });
});

describe('branchQuery — the wire value', () => {
  /**
   * NO CHOICE OMITS the parameter. The API treats `?branch=all` and no
   * parameter identically, so this keeps the request of a salon with no branch
   * step byte-identical to the one made before the picker existed.
   */
  it('omits the parameter when nothing is chosen', () => {
    expect(branchQuery(null)).toBeUndefined();
  });

  it("sends the API's own 'unassigned' for the third group", () => {
    expect(branchQuery({ kind: 'unassigned' })).toBe('unassigned');
  });

  it('sends the branch id for a branch', () => {
    expect(branchQuery({ kind: 'branch', branchId: 'BR-SAL' })).toBe('BR-SAL');
  });

  /**
   * The union exists for this: a branch really called `unassigned` would be
   * indistinguishable from the filter if the choice were a bare string, and the
   * server would answer the wrong question with a 200.
   */
  it('does not confuse a branch id with the unassigned filter', () => {
    expect(branchQuery({ kind: 'branch', branchId: 'unassigned' })).toBe('unassigned');
    expect(sameChoice({ kind: 'branch', branchId: 'unassigned' }, { kind: 'unassigned' })).toBe(
      false,
    );
  });
});

describe('sameChoice', () => {
  it('matches two branch chips only on the same id', () => {
    expect(sameChoice({ kind: 'branch', branchId: 'BR-KWC' }, { kind: 'branch', branchId: 'BR-KWC' })).toBe(true);
    expect(sameChoice({ kind: 'branch', branchId: 'BR-KWC' }, { kind: 'branch', branchId: 'BR-SAL' })).toBe(false);
  });

  it('matches unassigned to unassigned, and nothing chosen to no row', () => {
    expect(sameChoice({ kind: 'unassigned' }, { kind: 'unassigned' })).toBe(true);
    expect(sameChoice(null, { kind: 'unassigned' })).toBe(false);
    expect(sameChoice(null, { kind: 'branch', branchId: 'BR-KWC' })).toBe(false);
  });
});

describe('branchChoiceLabel — non-negotiable #12', () => {
  it('reads a branch in Arabic when Arabic has one', () => {
    expect(branchChoiceLabel({ kind: 'branch', branchId: 'BR-SAL' }, [KWC, SAL], 'ar', COPY)).toBe(
      'السالمية',
    );
  });

  it('reads the Latin name in English', () => {
    expect(branchChoiceLabel({ kind: 'branch', branchId: 'BR-SAL' }, [KWC, SAL], 'en', COPY)).toBe(
      'Salmiya',
    );
  });

  /** `nameAr ?? name`, and the seed has a real null path for it. */
  it('falls back to the Latin name in Arabic when nameAr is null, rather than blanking', () => {
    expect(branchChoiceLabel({ kind: 'branch', branchId: 'BR-HAW' }, [NO_AR], 'ar', COPY)).toBe(
      'Hawally',
    );
  });

  it('labels Other artists from copy, in both languages', () => {
    const ar = { branchFilterOther: 'مصففات أخريات' };
    expect(branchChoiceLabel({ kind: 'unassigned' }, [], 'en', COPY)).toBe('Other artists');
    expect(branchChoiceLabel({ kind: 'unassigned' }, [], 'ar', ar)).toBe('مصففات أخريات');
  });

  /** It used to fall back to "All branches", a label that now names nothing. */
  it('does not throw on a branch it cannot find, and names nothing', () => {
    expect(branchChoiceLabel({ kind: 'branch', branchId: 'BR-GONE' }, [KWC], 'en', COPY)).toBeNull();
  });
});

/**
 * `branchStepApplies` — whether the flow is five steps or four.
 *
 * FAILS BEFORE THIS SLICE: the export did not exist. The picker was a filter
 * strip inside step 2 and the step count was the literal 4.
 *
 * The value of these cases is not that the predicate is hard — it is one
 * expression — but that it is the same expression. The step count and the chips
 * on the step are now the same decision, and a salon counting five steps while
 * drawing no chips would be the visible form of them drifting apart. Each case
 * below asserts BOTH sides so a future edit cannot satisfy one and not the other.
 */
describe('branchStepApplies — the step and the chips are one decision', () => {
  const agree = (input: Parameters<typeof branchStepApplies>[0]) =>
    expect(branchStepApplies(input)).toBe(branchChoices(input).length > 0);

  it('is false for a single-branch salon — she is not asked', () => {
    const input = { branches: [KWC], split: { total: 4, unassigned: 0 } };
    expect(branchStepApplies(input)).toBe(false);
    agree(input);
  });

  it('is false when nothing is assigned — the step would have no answer', () => {
    const input = { branches: [KWC, SAL], split: { total: 4, unassigned: 4 } };
    expect(branchStepApplies(input)).toBe(false);
    agree(input);
  });

  it('is false while the roster split is unknown', () => {
    const input = { branches: [KWC, SAL], split: null };
    expect(branchStepApplies(input)).toBe(false);
    agree(input);
  });

  it('is false for a salon with no open branch at all', () => {
    agree({ branches: [], split: { total: 4, unassigned: 0 } });
    expect(branchStepApplies({ branches: [], split: { total: 4, unassigned: 0 } })).toBe(false);
  });

  it('is true for two open branches with somebody assigned to one', () => {
    const input = { branches: [KWC, SAL], split: { total: 4, unassigned: 2 } };
    expect(branchStepApplies(input)).toBe(true);
    agree(input);
  });

  it('is true once every artist has been assigned — the Other group is gone, the step is not', () => {
    const input = { branches: [KWC, SAL], split: { total: 4, unassigned: 0 } };
    expect(branchStepApplies(input)).toBe(true);
    agree(input);
  });
});
