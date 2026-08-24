/**
 * `publicationNotice` — what day it is when AVO publishes a legal set.
 *
 * WHY THIS SPEC EXISTS, AND WHY IT IS SHAPED THE WAY IT IS
 * -------------------------------------------------------
 * The guard it covers had ZERO tests. `effective_from_in_the_past` appeared exactly
 * once in the whole repository — at the `throw` that raises it — so nothing
 * anywhere asserted that a policy set cannot be back-dated, and the refusal was
 * free to be wrong in a way no suite could notice. It was:
 *
 *     const today = new Date().toISOString().slice(0, 10);   // UTC, always
 *
 * Kuwait is UTC+3. Between 00:00 and 03:00 Kuwait time that string is still
 * YESTERDAY in Kuwait, so a console admin could publish a set effective the
 * previous Kuwait day and the check waved it through — and the reported
 * `noticeDays` was one too many for the whole window.
 *
 * THE TRAP THIS SPEC IS BUILT TO AVOID
 * ------------------------------------
 * A test that asks the host clock what day it is CANNOT SEE THIS BUG. Build
 * `effectiveFrom` from `new Date()` and the right answer and the wrong answer
 * coincide: both versions agree on every date except the ones inside a three-hour
 * window, and the odds of a CI run landing there are one in eight. Worse, this
 * host runs PKT (UTC+5) — ahead of BOTH UTC and Kuwait — so a naive spec written
 * here is green against the broken code and green against the fixed code, and
 * proves only that the file imports.
 *
 * So every case below PINS AN INSTANT and passes it in. `publicationNotice` takes
 * `now` as a parameter precisely so this is possible with no database, no HTTP and
 * no fake timers — `routes/support.ts` § `queueScope` makes the same move for the
 * same reason. The cases in § "the three-hour window" are the discriminating ones:
 * they FAIL against the UTC version and pass against this one, which was watched
 * happening in both directions rather than assumed.
 *
 * WHAT THIS SPEC DELIBERATELY DOES NOT DO
 * ---------------------------------------
 * It does not enforce the 30-day notice, and § "reported, not enforced" pins that
 * it stays unenforced. `routes/policies.ts`'s header records the decision and the
 * reason: whether a change is MATERIAL is a judgement about legal meaning, the
 * contract gives no field to carry it, and enforcing 30 days on every publish
 * would make correcting a typo take a month. That is an escalation awaiting a
 * `material` flag, not a gap to close here.
 *
 * WHAT IT CANNOT COVER, stated rather than implied. The handler is database-bound,
 * so "the endpoint answers 400" is an endpoint-level assertion and belongs to Lane
 * D in `e2e/`. The one seam that leaves — the handler could pass the WRONG instant
 * and every case here would still pass — is closed by the source assertion at the
 * bottom, which is the same technique `e2e/report-download-capability.test.ts`
 * uses to pin a registration it cannot otherwise reach.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ApiError } from '../http/errors';
import { publicationNotice } from './policies';

/**
 * 00:30 on 26 August in Kuwait. In UTC this instant is still 25 August, 21:30 —
 * which is the entire bug in one line.
 */
const INSIDE_THE_WINDOW = new Date('2026-08-25T21:30:00Z');
const KUWAIT_DAY = '2026-08-26';
const THE_UTC_DAY_IT_USED_TO_THINK_IT_WAS = '2026-08-25';

/** 12:00 in Kuwait, when UTC and Kuwait agree on the date. */
const ORDINARY_DAYTIME = new Date('2026-08-26T09:00:00Z');

/** The refusal, as a value, so a case can assert on `code` rather than on a throw. */
function refusal(fn: () => unknown): ApiError {
  try {
    fn();
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
  throw new Error('expected a refusal, and the call returned normally');
}

describe('the three-hour window where UTC and Kuwait disagree', () => {
  /**
   * THE CASE THAT FAILS AGAINST THE OLD CODE. Under the UTC version `today` was
   * "2026-08-25", so `"2026-08-25" < "2026-08-25"` is false and the publish was
   * ACCEPTED — a legal set taking effect on a day that, in Kuwait, had already
   * finished.
   */
  it('refuses a set effective the previous Kuwait day, at 00:30 Kuwait', () => {
    const err = refusal(() =>
      publicationNotice(THE_UTC_DAY_IT_USED_TO_THINK_IT_WAS, INSIDE_THE_WINDOW),
    );

    // The CODE, not the status. A 400 from this guard and a 400 from the
    // `invalid_effective_from` regex above it are the same three digits.
    expect(err.code).toBe('effective_from_in_the_past');
    expect(err.statusCode).toBe(400);
  });

  /**
   * THE MIRROR, and without it the case above passes against a handler that
   * refuses everything. It also discriminates on its own: the UTC version accepts
   * this date too, but reports `noticeDays: 1` for a set effective TODAY.
   */
  it('accepts the current Kuwait day, and reports no notice for it', () => {
    expect(publicationNotice(KUWAIT_DAY, INSIDE_THE_WINDOW)).toBe(0);
  });

  /** The far edge of the window: 00:00 Kuwait exactly, still 21:00 UTC the day before. */
  it('holds at the moment the Kuwait day turns over', () => {
    const midnightKuwait = new Date('2026-08-25T21:00:00Z');

    expect(refusal(() => publicationNotice('2026-08-25', midnightKuwait)).code).toBe(
      'effective_from_in_the_past',
    );
    expect(publicationNotice('2026-08-26', midnightKuwait)).toBe(0);
  });

  /** And one second before it, when Kuwait is still on the 25th and so is the rule. */
  it('does not turn the day over early', () => {
    const justBefore = new Date('2026-08-25T20:59:59Z');

    expect(publicationNotice('2026-08-25', justBefore)).toBe(0);
    expect(refusal(() => publicationNotice('2026-08-24', justBefore)).code).toBe(
      'effective_from_in_the_past',
    );
  });
});

describe('the ordinary case, which the fix must not have broken', () => {
  it('refuses yesterday', () => {
    expect(refusal(() => publicationNotice('2026-08-25', ORDINARY_DAYTIME)).code).toBe(
      'effective_from_in_the_past',
    );
  });

  it('accepts today with zero notice', () => {
    expect(publicationNotice('2026-08-26', ORDINARY_DAYTIME)).toBe(0);
  });

  it('counts whole days to a future date', () => {
    expect(publicationNotice('2026-08-27', ORDINARY_DAYTIME)).toBe(1);
    expect(publicationNotice('2026-09-25', ORDINARY_DAYTIME)).toBe(30);
    // Across a month boundary and a 31-day month, so the arithmetic is not
    // quietly assuming 30.
    expect(publicationNotice('2026-10-26', ORDINARY_DAYTIME)).toBe(61);
  });
});

/**
 * The `zone.test.ts` argument, applied to this rule: a spec that only ever runs
 * under one process zone cannot tell a correct conversion from an absent one. The
 * whole point of the fix is that the machine's own zone stops mattering, so it is
 * asserted directly — including under UTC, where the OLD code would have looked
 * correct, and under this host's real PKT.
 */
describe('the process zone cannot influence the answer', () => {
  const PROCESS_ZONES = ['UTC', 'Asia/Kuwait', 'America/New_York', 'Asia/Karachi'];
  const originalTz = process.env.TZ;

  afterAll(() => {
    process.env.TZ = originalTz;
  });
  beforeEach(() => {
    process.env.TZ = originalTz;
  });

  it('refuses the previous Kuwait day under every process zone', () => {
    for (const tz of PROCESS_ZONES) {
      process.env.TZ = tz;

      const err = refusal(() =>
        publicationNotice(THE_UTC_DAY_IT_USED_TO_THINK_IT_WAS, INSIDE_THE_WINDOW),
      );
      expect(err.code, `process zone ${tz} changed the refusal`).toBe(
        'effective_from_in_the_past',
      );
      expect(publicationNotice(KUWAIT_DAY, INSIDE_THE_WINDOW), `process zone ${tz}`).toBe(0);
    }
  });
});

/**
 * THE 30-DAY NOTICE IS REPORTED, NOT ENFORCED — a decision, pinned so that a later
 * reader does not mistake it for an oversight and "fix" it. `routes/policies.ts`
 * § "WHAT publish REFUSES, AND WHAT IT ONLY REPORTS" carries the reasoning:
 * materiality is a legal judgement, the contract has no field for it, and
 * enforcing 30 days on every publish would make a spelling correction take a
 * month. ESCALATED, awaiting a `material` flag on the publish body.
 */
describe('the 30-day notice is reported, not enforced', () => {
  it('accepts a one-day notice and reports it as one day', () => {
    expect(publicationNotice('2026-08-27', ORDINARY_DAYTIME)).toBe(1);
  });

  it('accepts a same-day publish and reports it as zero', () => {
    expect(publicationNotice('2026-08-26', ORDINARY_DAYTIME)).toBe(0);
  });
});

/**
 * THE ONE SEAM THE UNIT CASES CANNOT REACH.
 *
 * Every case above injects an instant, which is what makes them precise — and it
 * means the handler could pass something other than the real clock and all of them
 * would still be green. The handler is database-bound so it cannot be driven here;
 * what CAN be checked without a database is that its call site still hands the rule
 * a live `Date`, and that the UTC line has not crept back in as executable code.
 */
describe('the publish handler passes the real clock', () => {
  const source = readFileSync(fileURLToPath(new URL('./policies.ts', import.meta.url)), 'utf8');

  it('calls publicationNotice with a live Date', () => {
    expect(source).toContain('publicationNotice(effectiveFrom, new Date())');
  });

  it('has no executable toISOString().slice date left in it', () => {
    // Comment lines are dropped first — this file's own header QUOTES the old
    // line to explain it, and a naive search would match the explanation and
    // report the bug as still present.
    const executable = source
      .split('\n')
      .filter((line) => {
        const t = line.trim();
        return !(t.startsWith('*') || t.startsWith('//') || t.startsWith('/*'));
      })
      .join('\n');

    expect(executable).not.toContain('toISOString().slice');
  });
});
