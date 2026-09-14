/**
 * Which branch is she booking at — and whether that question is worth asking.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE MODEL, WHICH IS THE API'S AND NOT THIS SCREEN'S
 * ═════════════════════════════════════════════════════════════════════════════
 * Migration 0044 settled it: ONE ARTIST BELONGS TO ONE BRANCH. So a customer
 * never asserts a branch. She picks an artist, and the booking's branch is
 * DERIVED from her — `services/booking.ts` passes `a.branchId` into
 * `resolveBranch` as `supplied`, and `POST /bookings` still takes only
 * `{artistId, serviceId, startsAt}` and refuses a `branchId` by name.
 *
 * Choosing a branch is therefore a FILTER over the artist list and never an
 * assertion about where money moves. Non-negotiable #2 is untouched, and it is
 * untouched by construction rather than by care: there is no field to send.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE PICKER IS NOW A STEP. THE MODEL IS NOT.
 * ═════════════════════════════════════════════════════════════════════════════
 * This paragraph used to read "that is also why the picker is not a fourth
 * step" — `design/AVO Wallet Home.dc.html` draws three (service :534, artist
 * :547, date & time :565) and no branch step, so `TOTAL_STEPS` stayed 4 and the
 * picker was a filter strip inside step 2.
 *
 * Aftab reversed that after testing the app: the flow is now service → branch →
 * artist → time → confirmation, and `TOTAL_STEPS` is 5. WHAT DID NOT CHANGE IS
 * THE SENTENCE ABOVE IT. The step selects which artists she SEES; the booking's
 * branch is still derived server-side from the artist she picks. `POST
 * /bookings` still takes only `{artistId, serviceId, startsAt}` and still
 * refuses a `branchId` by name, so non-negotiable #2 remains untouched BY
 * CONSTRUCTION — there is no field to send, and promoting the control to a step
 * did not create one.
 *
 * The old argument was that "a filter that changed the step count would be
 * claiming the customer had decided something she has not". That risk is real
 * and it is now carried by the SCREEN rather than by the step count: the review
 * step names the service, the artist and the time, and it does not name a
 * branch — because the branch she filtered by is not necessarily the branch the
 * server will record, and the `unassigned` group means it can legitimately be
 * neither. A step she walks through is not a fact she asserted.
 *
 * THE SUPPRESSION RULE BECAME LOAD-BEARING RATHER THAN COSMETIC. As a strip, an
 * absent picker cost nothing. As a step, an absent picker changes the number
 * printed on every screen of the flow — so `branchStepApplies` and
 * `branchChoices` are the SAME predicate (the first is defined as the second
 * being non-empty) and cannot drift into disagreeing about whether a salon has
 * four steps or five.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE HARD PART: `branch_id` IS NULL FOR MOST ARTISTS AND THAT IS NOT AN ERROR
 * ═════════════════════════════════════════════════════════════════════════════
 * Migration 0044 backfilled only salons with exactly one OPEN branch and left
 * every multi-branch salon's artists NULL rather than guessing — decisions 80
 * and 82, do not write a value into live data because the shape was
 * inconvenient. NULL means "not assigned", NOT "unbookable": the alternative
 * would have taken booking offline at every multi-branch salon.
 *
 * The seed reproduces exactly that state. Amara has two open branches, four
 * artists and zero assigned.
 *
 * So the picker has to answer: what shows when some artists have a branch and
 * some do not? Three answers, two of them wrong:
 *
 *   HIDE THE UNASSIGNED ONES.  Breaks booking at every salon that has not
 *   assigned anyone, which is most of them today. Rejected outright — it is the
 *   NULL-means-unbookable mistake the migration refused, moved into the client.
 *
 *   SHOW THEM UNDER EVERY BRANCH.  A lie, and an expensive one: she believes she
 *   picked Salmiya, the booking records `branch_assumed = true`, and nothing on
 *   screen ever said the location was not settled.
 *
 *   A THIRD GROUP, WHICH IS WHAT THIS DOES.  And it is a peer of the branches
 *   rather than a footnote under one, because that is what the API says it is:
 *   `?branch=` accepts exactly three kinds of value — a branch id, `unassigned`,
 *   and `all` — and `artistBranchFilter` was written ONCE for both artist lists
 *   so the merchant roster and the customer's list cannot disagree about what
 *   the parameter means. The strip mirrors that domain one chip per value kind,
 *   so the screen and the server cannot disagree either.
 *
 * `unassigned` IS STAFF VOCABULARY AND DOES NOT REACH THE CUSTOMER. The chip
 * reads "Other artists" — true relative to the branch chips beside it ("not at
 * any of those"), and it claims no location, which is the whole point. Selecting
 * it shows a note saying the salon has not listed a branch for them yet. See
 * `copy/en.ts § branchFilterOther` for what is owed to the copywriter here: the
 * bundle draws no branch step, so every string in this feature is new.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHEN THERE IS NO STRIP AT ALL — THREE SUPPRESSIONS, ONE RULE
 * ═════════════════════════════════════════════════════════════════════════════
 * The rule is that a filter must be able to keep its promise. It promises to
 * narrow the roster, so it earns its place only when there is more than one way
 * to narrow it.
 *
 *   ONE OPEN BRANCH → NO PICKER. One option is not a choice, and `resolveBranch`
 *   already agrees: "ONE BRANCH IS NOT A GUESS ... it is `established` and its
 *   boost applies". A booking at a single-branch salon is established with no
 *   picker, so a picker there would be decoration over a settled fact.
 *   `Salon.branches` carries only OPEN branches (`api/src/routes/salons.ts` —
 *   "a closed one is history"), so a two-branch salon that closes one becomes a
 *   one-branch salon here, which is the same reading `resolveBranch` takes.
 *
 *   NOTHING ASSIGNED → NO PICKER. Every branch chip would return an empty list
 *   and "Other artists" would be the whole roster: three ways to say one thing,
 *   two of them dead ends that read as a broken salon. This is the common case
 *   today, and suppressing it means those salons see step 2 exactly as it is now
 *   — zero change, zero risk, and nothing told to a customer about the salon's
 *   data hygiene.
 *
 *   ROSTER NOT KNOWN YET → NO PICKER. Deliberately not a chip skeleton. The
 *   branches are known at mount (they ride in on `Salon`) so a strip COULD paint
 *   immediately — and then vanish when the counts arrive and say nothing is
 *   assigned. A control that appears and then disappears is worse than one that
 *   arrives with the list it filters. It therefore arrives WITH the roster, in
 *   one paint, and the loading state of step 2 is unchanged from today.
 *
 * Once shown it is STICKY: visibility is decided from the unfiltered mount read,
 * never from the filtered one. Otherwise tapping a branch with no artists would
 * remove the strip she needs in order to tap a different one.
 * ═════════════════════════════════════════════════════════════════════════════
 */

import type { Language } from '@avo/types';
import { branchName, type Named } from './names';

/**
 * The three value kinds `?branch=` accepts, as a union rather than a bare
 * string — `'unassigned'` is also a legal branch id shape, so a plain string
 * cannot distinguish "the branch whose id is unassigned" from the filter.
 */
export type BranchChoice =
  | { kind: 'all' }
  | { kind: 'unassigned' }
  | { kind: 'branch'; branchId: string };

/** The default, and the request the wallet has always made. */
export const ALL_BRANCHES: BranchChoice = { kind: 'all' };

/**
 * A branch as this module needs it: an id and the two name fields
 * `domain/names.ts` resolves. Structural for the reason `Named` is — a narrowed
 * shape from a test fixture or a wire row both satisfy it.
 */
export interface PickableBranch extends Named {
  id: string;
}

/** The roster counts the suppression rule turns on, from the unfiltered read. */
export interface RosterSplit {
  /** Bookable artists at this salon, unfiltered. */
  total: number;
  /** How many of those have `branchId === null`. */
  unassigned: number;
}

/**
 * The `?branch=` value for a choice, or `undefined` to omit the parameter.
 *
 * `all` OMITS IT rather than sending `?branch=all`. The API treats the two
 * identically (`artistBranchFilter` returns `undefined` for both), so this is a
 * free choice — and the free choice worth making is the one that leaves the
 * default request byte-identical to the one this app made before the picker
 * existed. A salon with no picker cannot have its roster read changed by a
 * feature it does not show.
 */
export function branchQuery(choice: BranchChoice): string | undefined {
  if (choice.kind === 'all') return undefined;
  if (choice.kind === 'unassigned') return 'unassigned';
  return choice.branchId;
}

/** Two choices name the same filter. Used to drive the selected chip. */
export function sameChoice(a: BranchChoice, b: BranchChoice): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'branch' && b.kind === 'branch') return a.branchId === b.branchId;
  return true;
}

/**
 * The chips, in order, or an EMPTY ARRAY meaning "draw no strip".
 *
 * Empty rather than a nullable list so the caller's render is one `.map` with no
 * second branch to forget: `chips.length === 0` and `chips.map(...)` are the
 * same code path.
 *
 * @param split `null` while the unfiltered roster is still loading.
 */
export function branchChoices(input: {
  /** `Salon.branches` — already OPEN-only, per the salons route. */
  branches: readonly PickableBranch[];
  split: RosterSplit | null;
}): BranchChoice[] {
  const { branches, split } = input;

  // One option is not a choice. Also covers a salon with no open branch, which
  // cannot take a booking at all — `resolveBranch` throws `no_branch`.
  if (branches.length < 2) return [];

  // Not known yet. See § ROSTER NOT KNOWN YET.
  if (split === null) return [];

  // Nothing to filter by. Covers an empty roster too: no artists means none
  // assigned, and an empty list wants the empty state, not a filter over it.
  const assigned = split.total - split.unassigned;
  if (assigned <= 0) return [];

  const chips: BranchChoice[] = [ALL_BRANCHES];
  for (const b of branches) chips.push({ kind: 'branch', branchId: b.id });
  // Last, and only when the group is non-empty. When every artist has been
  // assigned it disappears on its own — the feature completes itself as the
  // merchant works through the roster.
  if (split.unassigned > 0) chips.push({ kind: 'unassigned' });
  return chips;
}

/**
 * Is the branch a STEP of this flow at all — five steps, or four?
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * DEFINED AS `branchChoices(...).length > 0`, AND THAT IS THE WHOLE POINT
 * ═════════════════════════════════════════════════════════════════════════════
 * Not a second rule that happens to agree with the first today. The three
 * suppressions argued at length above — one open branch, nothing assigned,
 * roster not known yet — are exactly the cases where the step has no answer
 * she could give, and a step with no answer is worse than no step. Writing the
 * rule twice is how a salon ends up counting five steps and drawing four chips
 * on one of them.
 *
 * THE ONE THAT MATTERS IS THE FIRST. A single-branch salon is the ordinary
 * salon: one option is not a choice, `resolveBranch` already treats a lone open
 * branch as `established`, and she must not be asked. The caller is responsible
 * for the other half of honesty — that the COUNTER says four when this returns
 * false. See `useBooking` § the branch step.
 */
export function branchStepApplies(input: {
  branches: readonly PickableBranch[];
  split: RosterSplit | null;
}): boolean {
  return branchChoices(input).length > 0;
}

/**
 * The two strings this module needs, structurally, so it does not depend on the
 * whole `Copy` interface — the same narrowing `Named` applies to entities.
 */
export interface BranchStripCopy {
  branchFilterAll: string;
  branchFilterOther: string;
}

/**
 * A chip's label in the reading language.
 *
 * A branch's name goes through `branchName`, so `nameAr ?? name` is applied in
 * exactly one place for the fourth render site in this app — non-negotiable #12,
 * and the reason `domain/names.ts` exists rather than a ternary per screen. The
 * seed leaves SAL-LUMIERE's branches with `name_ar` NULL on purpose, so the
 * fallback has a real null path here too.
 *
 * A branch id with no matching branch returns the `all` label rather than
 * throwing: an unknown chip cannot be produced by `branchChoices`, and a screen
 * is not the place to crash over one.
 */
export function branchChoiceLabel(
  choice: BranchChoice,
  branches: readonly PickableBranch[],
  lang: Language,
  copy: BranchStripCopy,
): string {
  if (choice.kind === 'all') return copy.branchFilterAll;
  if (choice.kind === 'unassigned') return copy.branchFilterOther;
  const found = branches.find((b) => b.id === choice.branchId);
  return found ? branchName(found, lang) : copy.branchFilterAll;
}
