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
 * at 13 when this landed and is 12 now — one entry left the list by being fixed —
 * but it cannot be moved by editing a digit any more.
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
 * run that has dropped to `11 of the documented 12` says on its face that one
 * entry below is now prunable. That is the same mechanism that caught the
 * original staleness (a number that moved), pointed at the list instead of at
 * the fixtures.
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
 * THIS LIST ONLY EVER GETS SHORTER on its own merits. `reports.test.ts` and
 * `account.test.ts` already reconcile both of their members in `afterAll`, which
 * is why `QA-RPT-0001` and `QA-ACC-0001` are not here. Every removal is a file
 * adopting the pattern. An addition is allowed and is sometimes right — but it is
 * an addition to a list of NAMES with REASONS, which is the only way it stays
 * reviewable.
 *
 * Measured 13 on 2026-09-11 twice, and re-measured on 2026-09-17 over the full
 * suite: the same thirteen ids. IT IS 12 NOW, and the removal is the first one
 * this mechanism produced rather than recorded. Fatima `9001` was carried here
 * with a reason that said her opening balance came from `api/src/db/seed.ts` and
 * that closing it belonged to lane A. That was wrong on both counts and the list
 * is the reason it got caught: `seed.ts` § `OPENING_BALANCES` covers `8842` and
 * `8843` only, and both get a real pair through the builder. `9001` is written by
 * `support/tenancy-harness.ts` § `seedSalonB()` — this column — with a
 * `balance_fils` literal and no pair, which is precisely the case `overCapVerdict`
 * below tells a reader to fix rather than document. `stopTenancyApi()` now
 * reconciles her, for the reasons written at that call.
 *
 * THE SIGN IS PART OF THE READING and the reasons below carry it:
 *
 *   POSITIVE — the balance is AHEAD of the ledger. An opening balance with no
 *       originating entry. The standing convention in this directory, and a real
 *       gap: `api/src/db/seed.ts` § "the opening balances" settled that an
 *       opening balance is a real credit and gets a real pair, and the fixtures
 *       here never caught up.
 *   NEGATIVE — the LEDGER is ahead of the balance, and this is the shape worth
 *       looking at twice: wallet legs exist that the balance does not reflect.
 *       Either a fixture that reset `balance_fils` after the API had moved it,
 *       or a real cached-aggregate defect. Exactly one member is negative today
 *       and it has a named cause. A negative drift on a member NOBODY
 *       re-fixtures would be the other thing, and is what this census is for.
 */
export const DOCUMENTED_DRIFTERS: Record<string, string> = {
  'QA-ADJ-0001':
    'POSITIVE or NEGATIVE, whatever `adjustments.test.ts` § `fund()` last wrote. ' +
    'THE STANDING LEGITIMATE CASE, and the reason this is a list and not an ' +
    'assertion: a shortfall spec needs a SPECIFIC balance and there is no ' +
    'endpoint that produces one, so it is written with SQL on purpose. This ' +
    'member will always drift and should.',
  'QA-ADJ-0002':
    'POSITIVE, 10.000, and she is the ONE ENTRY HERE THAT IS NOT RECONCILABLE AT ' +
    'ALL. Not a `fund()` member — that helper defaults to QA-ADJ-0001 and is never ' +
    'called with her; her balance is the literal in `adjustments.test.ts`\'s own ' +
    'INSERT. What makes her different is the three lines after it: she is walked ' +
    'request -> due -> erase and left TOMBSTONED, and her single spec asserts that ' +
    '`POST /members/{id}/adjustments` REFUSES her and moves nothing. Reconciling ' +
    'her would have the fixture write, in SQL, the exact settled money row the ' +
    'product refuses to write for her. A balance on a scrubbed record genuinely ' +
    'cannot come from a real ledger pair; this is what that sentence is for.',
  'QA-CMP-0001':
    'POSITIVE. `campaigns.test.ts` clones a member with an opening balance to ' +
    'have an audience with wallet history; the clone copies `balance_fils` and ' +
    'not the ledger behind it.',
  'QA-CMP-0002': 'POSITIVE. The second `campaigns.test.ts` audience clone, same cause.',
  'QA-CMP-0003': 'POSITIVE. The third `campaigns.test.ts` audience clone, same cause.',
  'QA-CMP-0004': 'POSITIVE. The fourth `campaigns.test.ts` audience clone, same cause.',
  'QA-DEP-0001':
    'POSITIVE. `deposit.test.ts`\'s member, cloned with an opening balance so a ' +
    'deposit can be held against it. Same missing pair as the other clones.',
  'QA-GW-0001':
    'NEGATIVE on a full run, and the only negative one there. She is ' +
    '`QA_MEMBER`, reset by the harness\'s own `seedQaMember()`, which runs once ' +
    'per FILE — so every charge an earlier file drove through her is still in ' +
    'the ledger with the balance wound back behind it. The ledger is right and ' +
    'the balance is the rewind. HER SIGN IS A FUNCTION OF HOW MANY FILES RAN: on ' +
    'a single-file run too few charges have accumulated to outweigh the opening ' +
    'balance and she reads POSITIVE — same cause, caught earlier.\n\n' +
    'SHE IS FATIMA `9001`\'S TWIN AND IS ONE LINE FROM CLOSED. `seedQaMember()` ' +
    'runs beside `seedSalonB()` in the same `startTenancyApi()`, so the reconcile ' +
    'that closed `9001` closes her too: a second ' +
    '`reconcileWalletLedger(QA_MEMBER, ...)` next to the first in ' +
    '`stopTenancyApi()`. SHE IS LEFT HERE ON PURPOSE, AND THAT IS THE DECISION ' +
    'THIS SENTENCE EXISTS TO RECORD — she is the only NEGATIVE on a full run, and ' +
    'the paragraph above leans on that sign as a diagnostic: a negative drift on a ' +
    'member nobody re-fixtures is the cached-aggregate defect this census was ' +
    'built to find, and she is the calibration for what that reads like. Closing ' +
    'her removes the only worked example of the shape worth looking at twice. ' +
    'That trade deserves its own slice and its own argument; it is not a tidy-up ' +
    'to be done in passing by whoever next reads this line.',
  'QA-NSW-0001':
    'POSITIVE. `no-show-worker.test.ts`\'s member, cloned with an opening ' +
    'balance so a forfeited deposit has somewhere to come from.',
  'QA-ORD-0001':
    'POSITIVE or NEGATIVE, whatever `orders.test.ts` § `fund()` last wrote. SHE IS ' +
    'A `fund()` CASE, NOT A CLONE CASE — this entry used to say she was "cloned ' +
    'with an opening balance", and she is cloned with `balance_fils = 0`; every ' +
    'figure she holds comes from one of twelve `UPDATE member SET balance_fils` ' +
    'calls, because an order race needs a balance exact to the fil and no endpoint ' +
    'produces one. Same standing rule as QA-ADJ-0001. Corrected while checking ' +
    'this list after `9001`\'s reason turned out to name the wrong file.',
  'QA-RES-0001':
    'POSITIVE, 200.000 exactly. `reschedule.test.ts`\'s member, cloned with an ' +
    'opening balance to cover a deposit across a moved booking.',
  'QA-RES-0002':
    'POSITIVE, 200.000 exactly. `reschedule.test.ts`\'s second member, same cause.',
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
export function readCensus(line: string): CensusReading {
  const listed = line.split('; drifting: ')[1];
  const entries = listed ? listed.split(', ') : [];
  // `?? e` rather than a non-null assertion: `split` on a separator that is not
  // there yields the whole string, so this only fires on a shape nobody printed,
  // and silently dropping such an entry would be a drifter the gate never saw.
  const drifting = entries.map((e) => e.split(' by ')[0] ?? e);
  const undocumented = drifting.filter((id) => !(id in DOCUMENTED_DRIFTERS));
  const n = DOCUMENTED_DRIFTER_COUNT;

  if (undocumented.length > 0) {
    const newOnes = entries.filter((e) => undocumented.includes(e.split(' by ')[0] ?? e));
    return {
      announcement:
        `${line} — OVER: ${undocumented.length} of these ${drifting.length} ` +
        `${undocumented.length === 1 ? 'is' : 'are'} NOT on the documented list of ${n} ` +
        `(${undocumented.join(', ')}). This run fails after teardown; the message says why.`,
      drifting,
      undocumented,
      verdict: overCapVerdict(newOnes, undocumented, drifting.length),
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
function overCapVerdict(newEntries: string[], newIds: string[], total: number): string {
  const plural = newIds.length === 1 ? '' : 's';
  return (
    `wallet census: ${newIds.length} member${plural} drift${newIds.length === 1 ? 's' : ''} ` +
    `from the wallet ledger and ${newIds.length === 1 ? 'is' : 'are'} not on the documented ` +
    `list of ${DOCUMENTED_DRIFTER_COUNT} in e2e/support/wallet-census.ts.\n\n` +
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
    `    reconcileWalletLedger('${newIds[0] ?? 'QA-XXX-0001'}', BRANCH_ID, 'TAG');\n\n` +
    'It posts the adjustment + gateway_clearing pair the balance is missing, it is a no-op ' +
    'for a member who already reconciles, and `reports.test.ts` and `account.test.ts` both ' +
    'do exactly this. Reconciling LAST is what lets the same file keep using a SQL balance ' +
    'mid-run for a shortfall spec.\n\n' +
    'THE OTHER PATH IS DELIBERATELY THE HEAVIER ONE. If the balance genuinely cannot come ' +
    'from a real ledger pair — `adjustments.test.ts` § `fund()` is the standing example — ' +
    'add the member to DOCUMENTED_DRIFTERS in e2e/support/wallet-census.ts WITH the sentence ' +
    'saying why, the way every entry there carries one. There is no number to raise: the ' +
    'list is the cap, and that is on purpose, because at zero headroom nothing else made ' +
    'the reconcile the cheaper path. Do not delete the check — it is the only thing ' +
    `measuring db:verify invariant 5 across a run.\n\n` +
    `(${total} members drift in total; the other ${total - newIds.length} are documented.)`
  );
}
