/**
 * THE READER HALF OF THE WALLET CENSUS, DRIVEN WITH SYNTHETIC LINES.
 *
 * The census itself runs in `support/global-setup.ts`'s `globalSetup` teardown,
 * because that is the only hook guaranteed to run after every file — and a spec
 * cannot call a teardown. What a spec CAN do is drive the half that decides
 * anything, which is why `readCensus` is a pure function of one printed line in
 * `support/wallet-census.ts` rather than a paragraph inside the teardown.
 *
 * WHAT THIS PINS, AND IT IS DELIBERATELY THE WORDING AND NOT THE NUMBER. The
 * number is 12 today and is supposed to fall; a spec that pins it turns every
 * file adopting `reconcileWalletLedger` into a red spec, which is the opposite of
 * the point. So the assertions are about the two things the gate exists to do:
 *
 *   1. AT THE CAP, THE GREEN RUN SAYS SO. `all 12 of the documented 12` has to
 *      read as a warning where `12` read as a statistic, because the alternative
 *      is the next lane finding out in teardown after a suite of green tests.
 *   2. OVER THE CAP, THE MESSAGE NAMES THE RIGHT FIX. Which member is new, that
 *      a fixture wrote a balance with no ledger pair, and `reconcileWalletLedger`
 *      — not "raise the cap", which at zero headroom was the cheaper path and is
 *      the reason the cap is a named list now.
 *
 * IT ALSO PINS THE IDENTITY PROPERTY, which is the whole difference between the
 * integer this replaced and the list: ONE undocumented drifter fails, even
 * though one is far under thirteen. And the converse, which is the property that
 * kept the old bound on DRIFTERS rather than on reconcilers: a partial run
 * leaves a SUBSET, and a subset must never fail. An equality against the list
 * would have gone red on `vitest run one-file.test.ts` — the shape that teaches
 * people to disable a gate.
 *
 * NOT COVERED HERE, ON PURPOSE. The `!line` branch — a query whose shape changed
 * under the reader — stays in `global-setup.ts`, because it needs the raw `psql`
 * output to quote back and the database name to name. Its reasoning is intact
 * there and this extraction did not touch it.
 *
 * NO DATABASE, NO API. Like `commit-order.test.ts`, this file runs on a tree and
 * a string, so it adds nothing for the census to measure.
 */

import { describe, expect, it } from 'vitest';

import {
  DOCUMENTED_DRIFTERS,
  DOCUMENTED_DRIFTER_COUNT,
  readCensus,
} from './support/wallet-census.js';

const N = DOCUMENTED_DRIFTER_COUNT;
const DOCUMENTED = Object.keys(DOCUMENTED_DRIFTERS);

/** The exact shape `reportWalletDrift`'s `format()` prints. */
function censusLine(drifting: Array<[string, number]>, total = 28): string {
  const reconciling = total - drifting.length;
  const head = `${reconciling} of ${total} members reconcile to their wallet ledger`;
  if (drifting.length === 0) return head;
  return `${head}; drifting: ${drifting.map(([id, n]) => `${id} by ${n} fils`).join(', ')}`;
}

/** Every documented drifter, drifting — i.e. what a full run looks like today. */
const AT_THE_CAP = censusLine(DOCUMENTED.map((id, i) => [id, (i + 1) * 1000]));

describe('the documented drifter list is reviewable, not just a count', () => {
  it('every entry carries a reason, not just a name', () => {
    for (const [id, why] of Object.entries(DOCUMENTED_DRIFTERS)) {
      expect(why.length, id).toBeGreaterThan(40);
    }
  });

  /**
   * The sign is half the reading — a NEGATIVE drift means wallet legs the
   * balance does not reflect, which is the shape worth looking at twice — so an
   * entry that does not commit to one has not been thought about.
   */
  it('every reason commits to a sign', () => {
    for (const [id, why] of Object.entries(DOCUMENTED_DRIFTERS)) {
      expect(/POSITIVE|NEGATIVE/.test(why), `${id}: ${why.slice(0, 60)}`).toBe(true);
    }
  });

  it('the cap is derived from the list, so there is no number to raise', () => {
    expect(DOCUMENTED_DRIFTER_COUNT).toBe(DOCUMENTED.length);
  });
});

describe('a green run shows the headroom instead of hiding it', () => {
  it('at the cap, the line reads as a warning and not as a statistic', () => {
    const { announcement, verdict } = readCensus(AT_THE_CAP);

    // Still green — the cap is a ceiling, and sitting on it is not a failure.
    expect(verdict).toBeNull();

    // The census line survives verbatim: the gate acts on what the reader saw.
    expect(announcement.startsWith(AT_THE_CAP)).toBe(true);

    // And the count is stated AGAINST the permitted count, which is the whole
    // point — `12` is a statistic, `12 of a documented 12` is a warning.
    expect(announcement).toContain(`ALL ${N} OF THE DOCUMENTED ${N} ARE DRIFTING`);
    expect(announcement).toContain('no spare slot');
    expect(announcement).toContain('reconcileWalletLedger');
  });

  /**
   * DRIVEN WITH A SYNTHETIC SET, BECAUSE THE REAL LIST IS ONE ENTRY LONG AND THIS
   * BRANCH CANNOT BE REACHED THROUGH IT — a run drifts zero or it drifts her.
   *
   * That is the reason `readCensus` takes an optional `documented`, and it is the
   * only thing the parameter is for: production passes nothing. The branch is not
   * dead code, it is the branch the list needs the moment it grows back, and the
   * alternative to driving it synthetically was deleting the spec and discovering
   * on some later run that the "prunable" message had rotted unwatched. That is
   * precisely how `DYNAMIC_PERMISSION` went, one file over.
   */
  it('below the cap it says so, and says which way to read the gap', () => {
    const four = {
      'QA-SYN-0001': 'POSITIVE, synthetic.',
      'QA-SYN-0002': 'POSITIVE, synthetic.',
      'QA-SYN-0003': 'POSITIVE, synthetic.',
      'QA-SYN-0004': 'POSITIVE, synthetic.',
    };
    const { announcement, verdict } = readCensus(
      censusLine(Object.keys(four).slice(0, 3).map((id): [string, number] => [id, 1000])),
      four,
    );
    expect(verdict).toBeNull();
    expect(announcement).toContain('3 drifting, all documented, out of 4');
    // A full run that has dropped below the list's size is the list going stale,
    // and nothing else in this design can notice that.
    expect(announcement).toContain('prunable');
  });

  /**
   * AND THE CLAIM THE LIST MAKES TODAY, ASSERTED RATHER THAN LEFT TO THE PROSE.
   *
   * The gate used to say "twelve known drifters, watch for a thirteenth". It says
   * "any drift but one tombstoned member is a bug", and the only thing that keeps
   * that true is that nobody quietly re-adds a reconcilable member to the list.
   * An addition is still ALLOWED — it is the documented escape hatch — but it can
   * no longer happen without this spec going red and asking for the argument.
   */
  it('the list is down to the one member who cannot be reconciled', () => {
    expect(DOCUMENTED).toEqual(['QA-ADJ-0002']);
    expect(DOCUMENTED_DRIFTERS['QA-ADJ-0002']).toContain('TOMBSTONED');
  });

  it('prints a line even when nothing drifted at all', () => {
    const { announcement, verdict, drifting } = readCensus(censusLine([]));
    expect(verdict).toBeNull();
    expect(drifting).toEqual([]);
    expect(announcement).toContain('nothing drifting');
  });
});

describe('a partial run cannot falsely trip it — the subset property', () => {
  /**
   * `vitest run one-file.test.ts` leaves a SUBSET of the members a full run
   * leaves. An EQUALITY against `DOCUMENTED_DRIFTERS` would be red on every
   * single-file run, which is why this is a subset check and why that is the one
   * place this list must diverge from `KNOWN_INERT`'s frozen equality.
   */
  it('every proper subset of the documented list passes', () => {
    for (let i = 0; i <= DOCUMENTED.length; i += 1) {
      const line = censusLine(DOCUMENTED.slice(0, i).map((id) => [id, 500]));
      expect(readCensus(line).verdict, `${i} documented drifters`).toBeNull();
    }
  });

  it('order does not matter — the list is a set, not a sequence', () => {
    const reversed = censusLine([...DOCUMENTED].reverse().map((id) => [id, 500]));
    expect(readCensus(reversed).verdict).toBeNull();
  });
});

describe('an undocumented drifter fails on its identity, not on the count', () => {
  /**
   * THE DIFFERENCE FROM THE INTEGER THIS REPLACED, IN ONE ASSERTION. Under
   * `drifting > 13` a single-file run leaving one new drifter passed, and the
   * fixture debt was only discovered when somebody else's full run crossed the
   * line. One unnamed member is a failure now regardless of how few there are.
   */
  it('one new member fails even though one is far under the cap', () => {
    const { verdict, undocumented } = readCensus(censusLine([['QA-NEW-0001', 200000]]));
    expect(undocumented).toEqual(['QA-NEW-0001']);
    expect(verdict).not.toBeNull();
  });

  it('names the new member, and only the new member', () => {
    const line = censusLine([
      ...DOCUMENTED.map((id): [string, number] => [id, 1000]),
      ['QA-NEW-0001', 200000],
    ]);
    const { verdict, drifting, undocumented } = readCensus(line);

    expect(drifting).toHaveLength(N + 1);
    expect(undocumented).toEqual(['QA-NEW-0001']);
    expect(verdict).toContain('NEW: QA-NEW-0001 by 200000 fils');
    // The documented drifters are not paraded as suspects. They are accounted
    // for, and saying so is what stops the reader auditing them.
    expect(verdict).toContain(`the other ${N} are documented`);
    for (const id of DOCUMENTED) expect(verdict).not.toContain(`NEW: ${id}`);
  });

  /** Requirement 2, stated as the assertions that would fail if it regressed. */
  it('the message says what it MEANS before it says what broke', () => {
    const { verdict } = readCensus(censusLine([['QA-NEW-0001', 200000]]));
    expect(verdict).toContain('EVERY TEST ABOVE MAY HAVE PASSED');
    // It is a fixture, not the ledger. Getting this wrong is what sends a lane
    // hunting a money defect it did not write.
    expect(verdict).toContain('very probably NOT a defect in the ledger');
    expect(verdict).toContain('IT IS ALMOST CERTAINLY YOUR NEW FIXTURE');
    expect(verdict).toContain('you did not do anything wrong');
  });

  it('the fix it names is the reconcile, spelled out for the member that failed', () => {
    const { verdict } = readCensus(censusLine([['QA-NEW-0001', 200000]]));
    expect(verdict).toContain("reconcileWalletLedger('QA-NEW-0001', 'TAG');");
    expect(verdict).toContain('`afterAll`, NOT `beforeAll`');
    expect(verdict).toContain('reports.test.ts');
  });

  /**
   * THE POINT OF THE NAMED LIST. The escape hatch still exists — `fund()`'s
   * shortfall members are legitimate and always will be — but it is an id plus a
   * sentence, and the message says so. What must NOT be offered is a number to
   * raise, because at zero headroom that was the cheaper path and it is the one
   * that leaves the next lane in the same place.
   */
  it('offers no number to raise, and makes the escape hatch the heavier path', () => {
    const { verdict } = readCensus(censusLine([['QA-NEW-0001', 200000]]));
    expect(verdict).toContain('THE OTHER PATH IS DELIBERATELY THE HEAVIER ONE');
    expect(verdict).toContain('DOCUMENTED_DRIFTERS');
    expect(verdict).toContain('WITH the sentence saying why');
    expect(verdict).toContain('There is no number to raise');
    expect(verdict).not.toMatch(/raise\s+MAX_DRIFTING_MEMBERS/);
    // And it never reads as an invitation to delete the gate.
    expect(verdict).toContain('Do not delete the check');
  });

  it('the announcement warns on the same run, so the red is not a surprise in isolation', () => {
    const { announcement } = readCensus(censusLine([['QA-NEW-0001', 200000]]));
    expect(announcement).toContain('OVER');
    expect(announcement).toContain('QA-NEW-0001');
  });

  it('reports every undocumented member when more than one arrives at once', () => {
    const { undocumented, verdict } = readCensus(
      censusLine([
        [DOCUMENTED[0] ?? 'QA-ADJ-0001', 1000],
        ['QA-NEW-0001', 200000],
        ['QA-NEW-0002', -4500],
      ]),
    );
    expect(undocumented).toEqual(['QA-NEW-0001', 'QA-NEW-0002']);
    expect(verdict).toContain('NEW: QA-NEW-0001 by 200000 fils');
    // Negative drift is the shape worth looking at twice, and the sign has to
    // survive the parse to be looked at.
    expect(verdict).toContain('NEW: QA-NEW-0002 by -4500 fils');
    expect(verdict).toContain('2 members drift');
  });
});

/**
 * THE GUARD ON THE GUARD, for the reason `typeFidelity.test.ts` states about its
 * own frozen lists: every assertion above passes just as well against a reader
 * that has stopped reading. So the parser is pointed at the two shapes the
 * printed line actually takes and required to separate them.
 */
describe('the reading is taken off the printed line and nowhere else', () => {
  it('a line with no drifting clause yields no drifters', () => {
    expect(readCensus('28 of 28 members reconcile to their wallet ledger').drifting).toEqual([]);
  });

  it('ids are split off the amounts, signs and all', () => {
    const { drifting } = readCensus(
      censusLine([
        ['QA-A-0001', 1],
        ['QA-B-0002', -239000],
      ]),
    );
    expect(drifting).toEqual(['QA-A-0001', 'QA-B-0002']);
  });

  /**
   * `9001` IS THE RIGHT ID TO DRIVE THIS WITH AND IT IS NO LONGER DOCUMENTED,
   * WHICH MAKES THE SPEC STRICTLY BETTER. Every other fixture id in this suite
   * carries a `QA-` prefix, so she is the only member who can show that an id
   * made entirely of digits is not mistaken for an amount by the split. She used
   * to be on `DOCUMENTED_DRIFTERS`, so this spec asserted a null verdict; she is
   * reconciled by `stopTenancyApi()` now, so the honest assertion is the other
   * one — a numeric id that nobody wrote down is caught BY NAME, which is the
   * identity property the list replaced the integer to get.
   */
  it('a purely numeric member id survives the parse — the harness seeds one', () => {
    const reading = readCensus(censusLine([['9001', 25000]]));
    expect(reading.drifting).toEqual(['9001']);
    expect(reading.undocumented).toEqual(['9001']);
    expect(reading.verdict).toContain('9001');
    expect(reading.verdict).toContain('reconcileWalletLedger');
  });
});
