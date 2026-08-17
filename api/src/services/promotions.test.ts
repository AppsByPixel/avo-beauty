/**
 * The earning predicate, proved the way the timezone was: by making it fail.
 *
 * Two properties are worth a test here and neither of them is "the function
 * returns 2".
 *
 *   1. THE PROCESS ZONE CANNOT MOVE A MULTIPLIER. A happy hour is 16:00–18:00
 *      salon-local, and if the server resolves that against its own clock then
 *      an API booted under TZ=America/New_York applies an x2 at the wrong eight
 *      hours of the day. That is a money bug, not a display one, and it is
 *      invisible to any test that runs in one zone.
 *
 *   2. THE WINDOW ENDS WITHOUT ANYTHING TELLING IT TO. Nothing is stored, no job
 *      runs, no tick fires. The same rows, evaluated one minute later, stop
 *      earning. That is what "no push, no poll and no server tick" means and it
 *      is testable exactly by moving `now` and changing nothing else.
 *
 * The predicate itself is packages/types/src/rules.ts and is deliberately NOT
 * restated — this file exercises the shared function through `decideEarning`,
 * which is the whole point of importing it rather than writing a second one.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { isHappyHourLive } from '@avo/types';
import { decideEarning, type PromotionInputs, type HappyHourWire } from './promotions';

const SALON = { id: 'SAL-AMARA', timezone: 'Asia/Kuwait' };
const BR_SAL = 'BR-SAL';
const BR_KWC = 'BR-KWC';

/** The fixture window: all branches, Sun/Mon/Tue 16:00–18:00, x2 visits. */
const HH_01: HappyHourWire = {
  id: 'HH-01',
  branchId: 'all',
  days: [0, 1, 2],
  from: '16:00',
  to: '18:00',
  reward: 'x2visit',
  on: true,
  notify: true,
};

/** The fixture's switched-off window: Salmiya, Thursday 10:00–13:00, topup10. */
const HH_02: HappyHourWire = {
  id: 'HH-02',
  branchId: BR_SAL,
  days: [4],
  from: '10:00',
  to: '13:00',
  reward: 'topup10',
  on: false,
  notify: false,
};

function inputs(over: Partial<PromotionInputs> = {}): PromotionInputs {
  return {
    salon: SALON,
    branchId: BR_SAL,
    boosts: [],
    windows: [HH_01, HH_02],
    ...over,
  };
}

/** 2026-08-17 is a Monday. `hh:mm` is KUWAIT wall clock; the Date is UTC. */
function kuwait(hhmm: string, ymd = '2026-08-17'): Date {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(`${ymd}T${String((h as number) - 3).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`);
}

const PROCESS_ZONES = ['UTC', 'Asia/Kuwait', 'America/New_York', 'Australia/Sydney'];
const originalTz = process.env.TZ;
afterAll(() => {
  process.env.TZ = originalTz;
});
beforeEach(() => {
  process.env.TZ = originalTz;
});

describe('the multiplier is decided on the salon clock, not the process clock', () => {
  it('16:30 Kuwait earns x2 whatever TZ the API booted with', () => {
    for (const tz of PROCESS_ZONES) {
      process.env.TZ = tz;
      const d = decideEarning(inputs(), kuwait('16:30'));
      expect(d.visitMultiplier, `TZ=${tz} decided the wrong multiplier`).toBe(2);
      expect(d.happyHourId, `TZ=${tz}`).toBe('HH-01');
    }
  });

  it('19:00 Kuwait earns nothing whatever TZ the API booted with', () => {
    for (const tz of PROCESS_ZONES) {
      process.env.TZ = tz;
      const d = decideEarning(inputs(), kuwait('19:00'));
      expect(d.visitMultiplier, `TZ=${tz}`).toBe(1);
      expect(d.happyHourId, `TZ=${tz}`).toBeNull();
    }
  });

  /**
   * THE CASE THAT WOULD HAVE PASSED WITHOUT A ZONE AND IS WRONG.
   *
   * 13:00Z is 16:00 in Kuwait — inside the window — and 09:00 in New York, which
   * is not. A server resolving against its own clock decides the opposite thing
   * in the two zones. This asserts it does not.
   */
  it('the same instant earns the same reward in every process zone', () => {
    const instant = new Date('2026-08-17T13:00:00Z');
    const answers = PROCESS_ZONES.map((tz) => {
      process.env.TZ = tz;
      return decideEarning(inputs(), instant).visitMultiplier;
    });
    expect(new Set(answers).size, `the process zone changed the answer: ${answers.join(', ')}`).toBe(1);
    expect(answers[0]).toBe(2);
  });
});

describe('the window expires on its own — no push, no poll, no server tick', () => {
  /**
   * Nothing between these two calls does anything. No row is written, no job
   * runs, no flag is flipped. The only thing that changes is `now`, and the
   * window stops applying because it stops SATISFYING THE PREDICATE. That is
   * what having no `live` column buys.
   */
  it('17:59 earns double, 18:00 does not, and nothing was told', () => {
    const rows = inputs(); // the same object, unmodified, for both calls

    expect(decideEarning(rows, kuwait('17:59')).visitMultiplier).toBe(2);
    expect(decideEarning(rows, kuwait('18:00')).visitMultiplier).toBe(1);
  });

  it('the boundary is inclusive at `from` and exclusive at `to`', () => {
    const rows = inputs();
    // 15:59 — one minute early, nothing.
    expect(decideEarning(rows, kuwait('15:59')).visitMultiplier).toBe(1);
    // 16:00 — exactly at `from`, earns.
    expect(decideEarning(rows, kuwait('16:00')).visitMultiplier).toBe(2);
    // 17:59 — the last minute, earns.
    expect(decideEarning(rows, kuwait('17:59')).visitMultiplier).toBe(2);
    // 18:00 — exactly at `to`, does not. `from <= now < to`.
    expect(decideEarning(rows, kuwait('18:00')).visitMultiplier).toBe(1);
  });

  it('a day the window does not name earns nothing, at the same time of day', () => {
    // 2026-08-19 is a Wednesday; HH-01 runs Sun/Mon/Tue.
    expect(decideEarning(inputs(), kuwait('16:30', '2026-08-19')).visitMultiplier).toBe(1);
    // 2026-08-16 is a Sunday, which it does name.
    expect(decideEarning(inputs(), kuwait('16:30', '2026-08-16')).visitMultiplier).toBe(2);
  });

  it('`minutesRemaining` counts down and reaches zero at `to`', () => {
    expect(decideEarning(inputs(), kuwait('16:00')).minutesRemaining).toBe(120);
    expect(decideEarning(inputs(), kuwait('17:32')).minutesRemaining).toBe(28);
    expect(decideEarning(inputs(), kuwait('18:00')).minutesRemaining).toBe(0);
  });
});

describe('what a client claims is never consulted', () => {
  /**
   * `decideEarning` takes rows and an instant. There is no parameter a client
   * could reach, and `ChargeInput` in services/charge.ts has no promotion field
   * to carry one. This is the assertion that the ONLY inputs are the stored
   * window and the server clock — non-negotiable #2.
   */
  it('a window that is off never applies, even inside its own hours', () => {
    // Thursday 11:00 Kuwait, at Salmiya: squarely inside HH-02, which is off.
    const thursday = kuwait('11:00', '2026-08-20');
    expect(isHappyHourLive(HH_02, thursday, 180), 'the shared predicate itself').toBe(false);

    const d = decideEarning(inputs({ branchId: BR_SAL }), thursday);
    expect(d.topupBonusPercent).toBe(0);
    expect(d.happyHourId).toBeNull();
  });

  it('switching it on is the only thing that changes that', () => {
    const thursday = kuwait('11:00', '2026-08-20');
    const on = { ...HH_02, on: true };
    const d = decideEarning(inputs({ branchId: BR_SAL, windows: [on] }), thursday);
    expect(d.topupBonusPercent).toBe(10);
    expect(d.happyHourId).toBe('HH-02');
  });

  it('a branch-scoped window applies at that branch only; "all" applies everywhere', () => {
    const thursday = kuwait('11:00', '2026-08-20');
    const on = { ...HH_02, on: true };

    expect(decideEarning(inputs({ branchId: BR_SAL, windows: [on] }), thursday).topupBonusPercent).toBe(10);
    expect(decideEarning(inputs({ branchId: BR_KWC, windows: [on] }), thursday).topupBonusPercent).toBe(0);

    const everywhere = { ...on, branchId: 'all' };
    expect(decideEarning(inputs({ branchId: BR_KWC, windows: [everywhere] }), thursday).topupBonusPercent).toBe(10);
  });
});

describe('boosts and happy hours: the best offer applies, they do not compound', () => {
  const boosts = [
    { branchId: BR_SAL, visit: 1, topup: 0, stamp: 1 },
    { branchId: BR_KWC, visit: 2, topup: 10, stamp: 1 },
  ];

  it('a branch boost applies with no window at all', () => {
    const d = decideEarning(inputs({ branchId: BR_KWC, boosts, windows: [] }), kuwait('11:00'));
    expect(d.visitMultiplier).toBe(2);
    // A boost is not a happy hour, so nothing is attributed to a window.
    expect(d.happyHourId).toBeNull();
  });

  it('2x boost + x2visit happy hour is 2x, not 4x', () => {
    // THE DECISION, as an assertion. A merchant who set "2×" in two places set
    // it twice; she did not agree to fund 4×, and neither the stepper nor the
    // wallet chip says anything that would lead her to expect it.
    const d = decideEarning(inputs({ branchId: BR_KWC, boosts }), kuwait('16:30'));
    expect(d.visitMultiplier).toBe(2);
  });

  /**
   * THE ARBITRARY-BRANCH CASE, FOUND BY RUNNING IT RATHER THAN READING IT.
   *
   * A charge with no branch on it is attributed to the salon's first branch by
   * `ORDER BY id LIMIT 1`. The first live charge against the seeded fixture
   * doubled a customer's visits — correctly, per the row — because 'BR-KWC'
   * sorts before 'BR-SAL' and Kuwait City happens to carry a 2× boost. Nobody
   * chose that, and a salon renaming a branch could turn it on or off.
   */
  it('an unknown branch earns no boost — a sort order must not decide a multiplier', () => {
    const d = decideEarning(inputs({ branchId: null, boosts, windows: [] }), kuwait('11:00'));
    expect(d.visitMultiplier).toBe(1);
    expect(d.topupBonusPercent).toBe(0);
  });

  it('an "all" window still applies with no branch — it has no ambiguity to resolve', () => {
    const d = decideEarning(inputs({ branchId: null, boosts }), kuwait('16:30'));
    expect(d.visitMultiplier).toBe(2);
    expect(d.happyHourId).toBe('HH-01');
  });

  it('a branch-scoped window does not apply with no branch', () => {
    const on = { ...HH_02, on: true };
    const d = decideEarning(
      inputs({ branchId: null, windows: [on] }),
      kuwait('11:00', '2026-08-20'),
    );
    expect(d.topupBonusPercent).toBe(0);
  });

  it('an x3 window beats a 2x boost, and is credited as the reason', () => {
    const x3 = { ...HH_01, reward: 'x3stamp' as const };
    const d = decideEarning(inputs({ branchId: BR_KWC, boosts, windows: [x3] }), kuwait('16:30'));
    expect(d.stampMultiplier).toBe(3);
    expect(d.happyHourId).toBe('HH-01');
  });

  it('a live window that beats nothing is not credited as the reason', () => {
    // The boost already gives 2x visits; an x2visit window adds nothing, so it
    // must not be recorded as what earned the customer her double visit.
    const d = decideEarning(inputs({ branchId: BR_KWC, boosts }), kuwait('16:30'));
    expect(d.visitMultiplier).toBe(2);
    expect(d.happyHourId).toBeNull();
  });

  it('two overlapping credit3 windows are one 3.000 KD credit, not two', () => {
    const a = { ...HH_01, id: 'HH-A', reward: 'credit3' as const };
    const b = { ...HH_01, id: 'HH-B', reward: 'credit3' as const, from: '16:15', to: '17:00' };
    const d = decideEarning(inputs({ windows: [a, b] }), kuwait('16:30'));
    expect(d.creditFils).toBe(3000);
  });
});

describe('a salon outside Kuwait, which is the case an offset could not have held', () => {
  const cairo = { id: 'SAL-CAIRO', timezone: 'Africa/Cairo' };

  it('a stored offset would pay double an hour early for half the year', () => {
    // Cairo is +3 in July and +2 in January. So "16:30 at the salon" — squarely
    // inside HH-01 — is 13:30Z in July and 14:30Z in January.
    expect(
      decideEarning(inputs({ salon: cairo }), new Date('2026-07-20T13:30:00Z')).visitMultiplier,
      'July, 16:30 Cairo',
    ).toBe(2);
    expect(
      decideEarning(inputs({ salon: cairo }), new Date('2026-01-19T14:30:00Z')).visitMultiplier,
      'January, 16:30 Cairo',
    ).toBe(2);

    // THE ASSERTION THAT MAKES THE COLUMN AN ID RATHER THAN AN INTEGER.
    // 13:30Z in January is 15:30 in Cairo — half an hour before the window
    // opens. A salon row holding "+180", correct all summer, would read that
    // same instant as 16:30 and fund a double visit that was never on offer.
    expect(
      decideEarning(inputs({ salon: cairo }), new Date('2026-01-19T13:30:00Z')).visitMultiplier,
      'January, 15:30 Cairo — the window has not opened',
    ).toBe(1);
  });

  it('two salons in two zones read one instant differently, and both are right', () => {
    // 15:50Z on a January Monday: 17:50 in Cairo (+2), inside the window;
    // 18:50 in Kuwait (+3), an hour after it closed.
    const instant = new Date('2026-01-19T15:50:00Z');
    expect(decideEarning(inputs({ salon: cairo }), instant).visitMultiplier).toBe(2);
    expect(decideEarning(inputs(), instant).visitMultiplier).toBe(1);
  });
});
