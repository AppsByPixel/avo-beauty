import { describe, expect, it } from 'vitest';
import {
  ALL_BRANCHES,
  branchChoiceLabel,
  branchChoices,
  branchQuery,
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

const COPY = { branchFilterAll: 'All branches', branchFilterOther: 'Other artists' };

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

describe('branchChoices — the three groups', () => {
  it('offers All, every branch, and Other artists when the roster is mixed', () => {
    const chips = branchChoices({ branches: [KWC, SAL], split: { total: 4, unassigned: 2 } });
    expect(kinds(chips)).toEqual(['all', 'BR-KWC', 'BR-SAL', 'unassigned']);
  });

  /**
   * The third group disappears on its own as the merchant works through the
   * roster. Nothing has to be switched on.
   */
  it('drops Other artists once every artist has a branch', () => {
    const chips = branchChoices({ branches: [KWC, SAL], split: { total: 4, unassigned: 0 } });
    expect(kinds(chips)).toEqual(['all', 'BR-KWC', 'BR-SAL']);
  });

  it('keeps a branch chip whose artists are all elsewhere — an honest empty state, not a hidden chip', () => {
    // Three branches, one assigned artist. Two chips lead to "no artists here",
    // which is true and is a state the screen builds.
    const chips = branchChoices({ branches: [KWC, SAL, NO_AR], split: { total: 3, unassigned: 2 } });
    expect(kinds(chips)).toEqual(['all', 'BR-KWC', 'BR-SAL', 'BR-HAW', 'unassigned']);
  });

  it('leads with All, so the default chip is the request the wallet always made', () => {
    const chips = branchChoices({ branches: [KWC, SAL], split: { total: 4, unassigned: 1 } });
    expect(chips[0]).toEqual(ALL_BRANCHES);
  });
});

describe('branchQuery — the wire value', () => {
  /**
   * `all` OMITS the parameter. The API treats `?branch=all` and no parameter
   * identically, so this keeps the default request byte-identical to the one
   * made before the picker existed.
   */
  it('omits the parameter for All', () => {
    expect(branchQuery({ kind: 'all' })).toBeUndefined();
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

  it('matches all to all and unassigned to unassigned', () => {
    expect(sameChoice(ALL_BRANCHES, { kind: 'all' })).toBe(true);
    expect(sameChoice({ kind: 'unassigned' }, { kind: 'unassigned' })).toBe(true);
    expect(sameChoice(ALL_BRANCHES, { kind: 'unassigned' })).toBe(false);
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

  it('labels the two filter chips from copy, in both languages', () => {
    const ar = { branchFilterAll: 'كل الفروع', branchFilterOther: 'مصففات أخريات' };
    expect(branchChoiceLabel(ALL_BRANCHES, [], 'en', COPY)).toBe('All branches');
    expect(branchChoiceLabel({ kind: 'unassigned' }, [], 'en', COPY)).toBe('Other artists');
    expect(branchChoiceLabel(ALL_BRANCHES, [], 'ar', ar)).toBe('كل الفروع');
    expect(branchChoiceLabel({ kind: 'unassigned' }, [], 'ar', ar)).toBe('مصففات أخريات');
  });

  it('does not throw on a branch it cannot find', () => {
    expect(branchChoiceLabel({ kind: 'branch', branchId: 'BR-GONE' }, [KWC], 'en', COPY)).toBe(
      'All branches',
    );
  });
});
