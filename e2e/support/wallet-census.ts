/**
 * THE READER HALF OF THE WALLET RECONCILIATION CENSUS — `db:verify` invariant 5.
 *
 * `support/global-setup.ts` § `reportWalletDrift` asks Postgres the question and
 * prints the answer; everything that DECIDES anything about the answer lives
 * here. The split is the one the census already made between the query and the
 * reader — this file just gives the reader a name and a file of its own, so a
 * spec can drive it with a synthetic census line. The census itself runs in
 * `globalSetup` teardown, which is the only hook guaranteed to run after every
 * file, and that is not a thing a spec can call.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS AT ALL: A RATCHET RESTING ON ITS STOP
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The gate used to be `if (drifting > MAX_DRIFTING_MEMBERS)`, with
 * `MAX_DRIFTING_MEMBERS = 13`, and a full run measured exactly 13. Zero
 * headroom: 13 passed, 14 threw.
 *
 * That is not a defect in the census — the cap is right and ratcheting it DOWN
 * as fixtures adopt `reconcileWalletLedger` is the correct direction. The defect
 * is in who the failure lands on. The next lane to add a fixture that sets
 * `balance_fils` in SQL — which the census block itself documents as the
 * ordinary, legitimate way to write a shortfall spec, because no endpoint
 * produces a specific balance — would watch every test pass and then take an
 * invariant-5 throw in teardown. Its first instinct would be that it broke the
 * ledger. It did not. It added a fixture the file explicitly permits, and the
 * ratchet happened to be resting on its stop when it got there.
 *
 * Two things follow, and they are the two halves of this file.
 *
 * 1. THE HEADROOM IS PRINTED ON THE GREEN RUN, NOT DISCOVERED ON THE RED ONE.
 *    `13 of 13` has to read as a warning where `13` reads as a statistic. The
 *    line that saves the next reader four minutes in `global-setup.ts` is the
 *    same line that warns the next lane, so it is one line and it prints every
 *    run.
 *
 * 2. THE FAILURE NAMES THE RIGHT FIX. Not "the cap was exceeded" — which member
 *    is new relative to the documented set, that a fixture wrote a balance with
 *    no matching ledger pair, that this is almost certainly the reader's own new
 *    fixture rather than a broken ledger, and that the fix is
 *    `reconcileWalletLedger` in that file's `afterAll`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE DECISION THAT WAS PUT AS A QUESTION: A NUMBER, OR A NAMED SET?
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * At zero headroom nothing made raising the cap harder than adopting
 * `reconcileWalletLedger`, and the second is clearly the intended path. A lane
 * in a hurry takes the cheaper one, and editing one digit is cheaper than
 * anything.
 *
 * SO THE CAP IS NOW A LIST OF NAMES AND THERE IS NO NUMBER TO RAISE. The cap is
 * `Object.keys(DOCUMENTED_DRIFTERS).length`, derived, never written down twice.
 * Adding a drifter means adding an id AND the sentence saying why its balance
 * cannot come from a real ledger pair — the conscious act with a name attached
 * that `KNOWN_INERT` and `LANGUAGE_PINNED` get in
 * `apps/wallet/src/theme/typeFidelity.test.ts`. The effective cap was unchanged
 * at 13 when this landed, was 12 the day Fatima `9001` was reconciled, and is ONE
 * now — eleven more entries left the list by being fixed, in the slice that also
 * made the branch a derived value rather than a parameter. It never moved by
 * editing a digit, which was the whole point of taking the list's risk on.
 *
 * AND IT IS A SUBSET CHECK, NOT AN EQUALITY, WHICH IS THE ONE PLACE THIS FILE
 * MUST DIVERGE FROM `KNOWN_INERT`. `typeFidelity.test.ts` can assert equality
 * because its input is the source tree, and the source tree is the same for
 * every run. This census's input is WHICHEVER FILES RAN. The original block
 * states the consequence and it still holds verbatim: "`vitest run
 * one-file.test.ts` leaves a SUBSET of the members a full run leaves ... A floor
 * on reconcilers would have gone red on every single-file run, which is the
 * shape that teaches people to disable a gate." An equality against
 * `DOCUMENTED_DRIFTERS` is exactly that floor wearing a different hat. A SUBSET
 * check is not: a partial run's drifters are a subset of a full run's, so it can
 * never falsely trip, and it still fails on the IDENTITY of a member nobody
 * wrote down — which is strictly more than the count ever knew.
 *
 * WHAT THE SUBSET CHECK GIVES UP, SAID PLAINLY RATHER THAN GLOSSED. It cannot
 * fail on a STALE entry. A member that stops drifting because its file adopted
 * `reconcileWalletLedger` sits in this list harmlessly forever, and that is the
 * rot that took `DYNAMIC_PERMISSION` in `permission-census.test.ts` and that the
 * original census block refused a hand-kept list to avoid. It is accepted here
 * for one reason: the ONLY check that would catch it is the equality that goes
 * red on every single-file run, and a gate people disable catches nothing at
 * all. What is done about it instead is cheap and costs no extra query — the
 * printed line reports the drifting count AGAINST the documented size, so a full
 * run that had dropped to `11 of the documented 12` would say on its face that
 * one entry below was prunable. That is the same mechanism that caught the
 * original staleness (a number that moved), pointed at the list instead of at
 * the fixtures.
 *
 * AT ONE ENTRY THAT MECHANISM IS IDLE AND THE LIST IS GUARDED DIFFERENTLY. There
 * is no gap left for the count to report: a full run drifts one, and a run that
 * drifts zero is a run whose `adjustments.test.ts` did not execute. What keeps
 * the last entry honest is not a number any more but the sentence it carries —
 * "this member's balance cannot come from a real ledger pair" — which is
 * falsifiable by reading her spec, and which stops being true the day that spec
 * stops asserting the product refuses her.
 */

/**
 * EVERY MEMBER A FULL RUN MAY LEAVE DRIFTING, AND WHY EACH ONE MAY.
 *
 * The gate is the keys; the values are what makes the keys reviewable. The bar
 * for an entry is not "this looked deliberate" — it is "this member's balance
 * cannot come from a real ledger pair", and if that is not true of a member you
 * are about to add, the entry you want is a `reconcileWalletLedger` call in your
 * own file's `afterAll` instead.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * IT IS ONE ENTRY NOW, AND THAT CHANGES WHAT THIS GATE CLAIMS
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * It measured 13 on 2026-09-11, 13 again on 2026-09-17, and 12 after Fatima
 * `9001` was reconciled. It is ONE. Eleven members left this list in a single
 * slice, each by the mechanism the list was built to encourage: a
 * `reconcileWalletLedger` call in the `afterAll` of the file that owns the
 * fixture.
 *
 * So the claim is no longer "twelve known drifters, watch for a thirteenth". It
 * is: ANY MEMBER WHOSE BALANCE DOES NOT RECONCILE TO HER WALLET LEDGER IS A BUG,
 * EXCEPT ONE TOMBSTONED MEMBER WHO CANNOT BE RECONCILED WITHOUT CONTRADICTING
 * THE SPEC THAT TOMBSTONED HER. That is a far stronger statement than a count
 * ever made, and it is worth naming what it buys: the common path for a new
 * fixture is now "call the helper", not "argue for an exemption". The
 * zero-headroom problem this file was written to fix — where editing a digit was
 * cheaper than adopting the pattern — is gone in the other direction. There is
 * no digit, and the exemption costs a paragraph.
 *
 * WHAT IT COSTS, SAID PLAINLY. The reader's "below the cap" branch — `N drifting,
 * all documented, out of M`, the one that says an entry is prunable — is
 * unreachable against a one-entry list, because a run either drifts zero or
 * drifts one. It is not dead code: it is the branch the list needs the moment it
 * grows back, and `wallet-census.test.ts` drives it through `readCensus`'s
 * optional `documented` argument rather than letting it rot untested.
 *
 * THE SUBSET CHECK IS UNCHANGED AND STILL RIGHT, for the reason below: this
 * census's input is WHICHEVER FILES RAN, so an equality would go red on every
 * single-file run. With one entry the subset check is very nearly an equality
 * anyway — the only passing readings are "nothing drifted" and "she drifted" —
 * which is the strongest this instrument has ever been without becoming the
 * floor that teaches people to disable a gate.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE SIGN IS PART OF THE READING, AND WHERE IT IS PROVEN NOW
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   POSITIVE — the balance is AHEAD of the ledger. An opening balance with no
 *       originating entry. This was the standing convention in this directory
 *       and a real gap: `api/src/db/seed.ts` § "the opening balances" settled
 *       that an opening balance is a real credit and gets a real pair, and the
 *       fixtures here never caught up. They have now; the remaining entry is one.
 *   NEGATIVE — the LEDGER is ahead of the balance, and this is the shape worth
 *       looking at twice: wallet legs exist that the balance does not reflect.
 *       Either a fixture that reset `balance_fils` after the API had moved it,
 *       or a real cached-aggregate defect.
 *
 * THERE IS NO LIVE NEGATIVE DRIFTER ANY MORE, AND THE EXPLANATION STAYS BECAUSE
 * THE SHAPE STILL MATTERS. `QA-GW-0001` was the census's only negative — −239.000
 * on a full run — and the sentence keeping her here argued that closing her would
 * remove the only worked example of the shape worth looking at twice. That was
 * the right thing to weigh and the wrong conclusion, because it confused a
 * DEMONSTRATION with a TEST.
 *
 * WHERE THE SIGN LOGIC IS PROVEN NOW: `wallet-census.test.ts` § "the reading is
 * taken off the printed line and nowhere else" drives `readCensus` with a
 * synthetic line carrying `-239000` and asserts that ids split off their amounts
 * "signs and all"; the same file's multi-member spec pins `NEW: QA-NEW-0002 by
 * -4500 fils` through the verdict. Those run on every invocation of this suite
 * and fail if the parse ever stops handling a minus sign. A live negative drifter
 * proved nothing that those do not, and cost an unexplained balance in the
 * database to keep saying it. What a live one WOULD still catch — a negative
 * drift on a member nobody re-fixtures, the cached-aggregate defect this census
 * exists to find — is caught better now, because such a member is no longer
 * hiding among eleven documented neighbours. She is the thirteenth name on a
 * list of one.
 */
export const DOCUMENTED_DRIFTERS: Record<string, string> = {
  'QA-ADJ-0002':
    'POSITIVE, 10.000, and she is the ONLY MEMBER IN THIS SUITE THAT IS NOT ' +
    'RECONCILABLE AT ALL. Not a `fund()` member — that helper defaults to ' +
    'QA-ADJ-0001 and is never called with her; her balance is the literal in ' +
    '`adjustments.test.ts`\'s own INSERT. What makes her different is the three ' +
    'lines after it: she is walked request -> due -> erase and left TOMBSTONED, ' +
    'and her single spec asserts that `POST /members/{id}/adjustments` REFUSES ' +
    'her and moves nothing. Reconciling her would have the fixture write, in SQL, ' +
    'the exact settled money row the product refuses to write for her — the spec ' +
    'and the teardown would be saying opposite things about the same member. A ' +
    'balance on a scrubbed record genuinely cannot come from a real ledger pair; ' +
    'this is what that sentence is for, and she is the last member it is true of. ' +
    'Her neighbour QA-ADJ-0001 sat here beside her as "the standing legitimate ' +
    'case" and was reconciled in the same slice that cut this list to one, which ' +
    'is the difference worth holding on to: `fund()` writing a SQL balance MID-RUN ' +
    'is legitimate and is answered by reconciling LAST. Only a tombstone survives ' +
    'that answer.',
};

/** Derived, never written down twice. There is no cap to raise — only a list to name. */
export const DOCUMENTED_DRIFTER_COUNT = Object.keys(DOCUMENTED_DRIFTERS).length;

/** What `reportWalletDrift` should print, and whether the run must fail. */
export interface CensusReading {
  /** The one line, every run. The census line plus what it means. */
  announcement: string;
  /** The drifting ids, in the order the line listed them. */
  drifting: string[];
  /** Drifting ids that are not in `DOCUMENTED_DRIFTERS`. Non-empty ⟹ `verdict`. */
  undocumented: string[];
  /** Non-null when the run must be failed, AFTER teardown's cleanup has run. */
  verdict: string | null;
}

/**
 * Read one census line.
 *
 * COUNTED OFF THE PRINTED LINE RATHER THAN RE-QUERIED, which is the property the
 * query half was careful to give this function: the ids the gate acts on are
 * provably the ids a reader was just shown. A second query could disagree with
 * the line above it and nobody would be able to tell which was true.
 *
 * The line's shape is
 *
 *     N of M members reconcile to their wallet ledger; drifting: <id> by <n> fils, …
 *
 * and no `; drifting: ` means nothing drifted. A line this function cannot
 * recognise at all never reaches here — `reportWalletDrift` fails the run on a
 * missing census line before calling this, for the reason written there.
 */
export function readCensus(
  line: string,
  documented: Record<string, string> = DOCUMENTED_DRIFTERS,
): CensusReading {
  const listed = line.split('; drifting: ')[1];
  const entries = listed ? listed.split(', ') : [];
  // `?? e` rather than a non-null assertion: `split` on a separator that is not
  // there yields the whole string, so this only fires on a shape nobody printed,
  // and silently dropping such an entry would be a drifter the gate never saw.
  const drifting = entries.map((e) => e.split(' by ')[0] ?? e);
  const undocumented = drifting.filter((id) => !(id in documented));
  const n = Object.keys(documented).length;

  if (undocumented.length > 0) {
    const newOnes = entries.filter((e) => undocumented.includes(e.split(' by ')[0] ?? e));
    return {
      announcement:
        `${line} — OVER: ${undocumented.length} of these ${drifting.length} ` +
        `${undocumented.length === 1 ? 'is' : 'are'} NOT on the documented list of ${n} ` +
        `(${undocumented.join(', ')}). This run fails after teardown; the message says why.`,
      drifting,
      undocumented,
      verdict: overCapVerdict(newOnes, undocumented, drifting.length, n),
    };
  }

  if (drifting.length === 0) {
    return {
      announcement: `${line} — nothing drifting; all ${n} documented drifters reconcile or did not run.`,
      drifting,
      undocumented,
      verdict: null,
    };
  }

  if (drifting.length === n) {
    return {
      announcement:
        `${line} — ALL ${n} OF THE DOCUMENTED ${n} ARE DRIFTING: no spare slot, by design. ` +
        'The list in support/wallet-census.ts IS the cap, so the next member to drift fails ' +
        'this gate by name. If you are about to write `balance_fils` with SQL, call ' +
        '`reconcileWalletLedger` in your file\'s afterAll and it never will.',
      drifting,
      undocumented,
      verdict: null,
    };
  }

  return {
    announcement:
      `${line} — ${drifting.length} drifting, all documented, out of ${n} on the list. ` +
      `The other ${n - drifting.length} did not drift in this run: either their files did ` +
      'not run, or they have adopted `reconcileWalletLedger` and their entries in ' +
      'support/wallet-census.ts are now prunable. On a FULL run it is the second.',
    drifting,
    undocumented,
    verdict: null,
  };
}

/**
 * THE MESSAGE THE GATE FIRES ON SOMEBODY ELSE, so it is written for that person.
 *
 * It arrives in teardown after a green suite, in the run of whoever added the
 * fixture rather than whoever set the list — the one objection the capped census
 * accepted knowingly and could not answer. What CAN be done about it is done
 * here: say what it means before saying what broke, name the member, name the
 * one-line fix, and make the alternative the visibly heavier one.
 */
function overCapVerdict(
  newEntries: string[],
  newIds: string[],
  total: number,
  documentedCount: number = DOCUMENTED_DRIFTER_COUNT,
): string {
  const plural = newIds.length === 1 ? '' : 's';
  return (
    `wallet census: ${newIds.length} member${plural} drift${newIds.length === 1 ? 's' : ''} ` +
    `from the wallet ledger and ${newIds.length === 1 ? 'is' : 'are'} not on the documented ` +
    `list of ${documentedCount} in e2e/support/wallet-census.ts.\n\n` +
    newEntries.map((e) => `  NEW: ${e}`).join('\n') +
    '\n\n' +
    'EVERY TEST ABOVE MAY HAVE PASSED AND THIS IS STILL RED, and it is very probably NOT a ' +
    'defect in the ledger or in anything you changed in the API. What it means is narrower ' +
    'than it looks: a FIXTURE set `member.balance_fils` with SQL and did not write the ' +
    '`member_wallet` ledger pair that accounts for it, so the balance has no originating ' +
    'entry — "a hole in that record, not a fixture convenience", per api/src/db/seed.ts ' +
    '§ "the opening balances".\n\n' +
    'IT IS ALMOST CERTAINLY YOUR NEW FIXTURE. Member ids map to files by convention ' +
    '(QA-RPT-… → reports.test.ts), so the id above names the file. Adding a fixture that ' +
    'writes a balance in SQL is a legitimate technique this suite documents and relies on — ' +
    'you did not do anything wrong, you just have one more line to write. In that file\'s ' +
    '`afterAll`, NOT `beforeAll`:\n\n' +
    `    reconcileWalletLedger('${newIds[0] ?? 'QA-XXX-0001'}', 'TAG');\n\n` +
    'It posts the adjustment + gateway_clearing pair the balance is missing, it is a no-op ' +
    'for a member who already reconciles, and `reports.test.ts` and `account.test.ts` both ' +
    'do exactly this. Reconciling LAST is what lets the same file keep using a SQL balance ' +
    'mid-run for a shortfall spec.\n\n' +
    'THE OTHER PATH IS DELIBERATELY THE HEAVIER ONE, AND THE LIST IS DOWN TO ONE NAME. ' +
    'If the balance genuinely cannot come from a real ledger pair — QA-ADJ-0002 is the only ' +
    'surviving example, a TOMBSTONED member whose spec asserts the product refuses to write ' +
    'her the very row a reconcile would write — add the member to DOCUMENTED_DRIFTERS in ' +
    'e2e/support/wallet-census.ts WITH the sentence ' +
    'saying why, the way every entry there carries one. There is no number to raise: the ' +
    'list is the cap, and that is on purpose, because at zero headroom nothing else made ' +
    'the reconcile the cheaper path. Do not delete the check — it is the only thing ' +
    `measuring db:verify invariant 5 across a run.\n\n` +
    `(${total} members drift in total; the other ${total - newIds.length} are documented.)`
  );
}
