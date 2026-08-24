/**
 * `parseBusinessHours` — the last unvalidated jsonb door on the salon.
 *
 * The reason this is worth a test file rather than a glance: the failure it
 * prevents is not a bad column value, it is a 500 on a different screen.
 * `services/availability.ts` calls `hhmmToMinutes` on this document inside
 * `computeAvailability`, and that function THROWS on anything that is not HH:MM.
 * So the assertion that matters is the pairing — everything this parser accepts
 * must be something `hhmmToMinutes` can read — and that is asserted directly
 * below rather than assumed.
 *
 * THE DIVISION MOVED UNDER THIS FILE, AND TWO OF ITS SPECS CAUGHT IT. Trunk
 * tightened `BusinessHoursSchema` to validate the clock (`e8ea6b3`), which was
 * right and which broke the two specs asserting that a non-clock string produced a
 * message naming the session and the value — `safeParse` now failed first and
 * returned the generic shape sentence instead. Those two specs are renamed rather
 * than relaxed, because the behaviour they pin is still wanted; what changed is
 * WHO enforces the rule, not what a merchant should read when she breaks it.
 *
 * The line as it stands, and the reason each half is asserted here:
 *
 *   the shared schema  shape and clock. Not re-asserted here except through this
 *                      function, which is the only thing the API calls.
 *   this function      POSITION — "24:00" as a start, the one rule left on the
 *                      endpoint side — and every MESSAGE.
 */

import { describe, expect, it } from 'vitest';
import { BusinessHoursSchema } from '@avo/types';
import { ApiError } from './errors';
import { HHMM, HHMM_OR_END_OF_DAY, parseBusinessHours } from './fields';
import { hhmmToMinutes } from '../time/zone';

function refusal(fn: () => unknown): ApiError {
  try {
    fn();
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
  throw new Error('expected a refusal, got a value');
}

const KUWAITI_DAY = { morning: ['10:00', '13:00'], evening: ['16:00', '21:00'] };

describe('parseBusinessHours', () => {
  it('accepts the day the whole product is seeded with', () => {
    expect(parseBusinessHours(KUWAITI_DAY)).toEqual(KUWAITI_DAY);
  });

  it('accepts a salon with no afternoon closure and no second sitting', () => {
    // `tradingSpans` drops a zero-length span, so this is the established way to
    // say "one continuous sitting". Refusing `to <= from` here would break it.
    const straightThrough = { morning: ['10:00', '21:00'], evening: ['21:00', '21:00'] };
    expect(parseBusinessHours(straightThrough)).toEqual(straightThrough);
  });

  /**
   * THE POSITION RULE, and it is the only rule this function still enforces on its
   * own. Asserted against the shared schema's own verdict rather than in isolation:
   * the schema must ACCEPT this document (it validates one clock at a time and has
   * no notion of which end it is looking at) and the endpoint must REFUSE it. If
   * that gap ever closes, this spec is where it shows.
   */
  it('accepts 24:00 as a closing time and refuses it as an opening one', () => {
    expect(parseBusinessHours({ ...KUWAITI_DAY, evening: ['16:00', '24:00'] }).evening)
      .toEqual(['16:00', '24:00']);

    const openingAtEndOfDay = { ...KUWAITI_DAY, evening: ['24:00', '24:00'] };
    expect(
      BusinessHoursSchema.safeParse(openingAtEndOfDay).success,
      'the shared schema accepts this — the position rule is the endpoint’s alone',
    ).toBe(true);

    const err = refusal(() => parseBusinessHours(openingAtEndOfDay));
    expect(err.code).toBe('invalid_business_hours');
    // NOT "is not a 24-hour time" — "24:00" plainly is one. The copy has to say
    // why, or it reads as a bug in the validator.
    expect(err.message).toContain('cannot open at "24:00"');
    expect(err.message).toContain('closing time');
  });

  it('refuses the shape the shared schema refuses', () => {
    for (const bad of [
      undefined,
      null,
      'open',
      {},
      { morning: ['10:00'], evening: ['16:00', '21:00'] },
      { morning: ['10:00', '13:00'] },
      { morning: [10, 13], evening: ['16:00', '21:00'] },
    ]) {
      expect(refusal(() => parseBusinessHours(bad)).code).toBe('invalid_business_hours');
    }
  });

  it('answers a non-clock string with the session and the value, not the schema’s shape sentence', () => {
    // The schema catches this now; the SENTENCE is still this function's job. zod
    // does not know the field is a salon's trading day, so its own message is
    // `businessHours must be { morning: … }` — true, and useless to somebody who
    // typed one character wrong in one box.
    const err = refusal(() =>
      parseBusinessHours({ morning: ['banana', '13:00'], evening: ['16:00', '21:00'] }),
    );
    expect(err.code).toBe('invalid_business_hours');
    expect(err.message).toContain('banana');
    expect(err.message).toContain('morning');
  });

  it('refuses out-of-range clock values', () => {
    for (const bad of ['24:01', '25:00', '10:60', '9:00', '1000', '10:00:00', '']) {
      expect(
        refusal(() => parseBusinessHours({ morning: [bad, '13:00'], evening: ['16:00', '21:00'] })).code,
        `${bad} must be refused`,
      ).toBe('invalid_business_hours');
    }
  });

  it('names the session and the offending value for a bad closing time too', () => {
    const err = refusal(() =>
      parseBusinessHours({ morning: ['10:00', '13:00'], evening: ['16:00', 'late'] }),
    );
    expect(err.message).toContain('evening');
    expect(err.message).toContain('late');
  });

  /**
   * THE PAIRING. Every value this parser lets through has to survive the function
   * that reads the column next, or the guard is decorative.
   */
  it('accepts nothing hhmmToMinutes cannot read', () => {
    const accepted = [
      ['00:00', '00:00'], ['00:00', '24:00'], ['09:05', '23:59'], ['10:00', '13:00'],
    ];
    for (const [from, to] of accepted) {
      const hours = parseBusinessHours({ morning: [from!, to!], evening: ['16:00', '21:00'] });
      expect(() => hhmmToMinutes(hours.morning[0])).not.toThrow();
      expect(() => hhmmToMinutes(hours.morning[1])).not.toThrow();
    }
  });

  it('and hhmmToMinutes would have thrown on what it refuses', () => {
    // The other half of the pairing: these are exactly the inputs that used to
    // reach the column and blow up three screens away.
    for (const bad of ['banana', '', '1000', '10:00:00']) {
      expect(() => hhmmToMinutes(bad)).toThrow();
    }
  });
});

describe('the shared clock regex', () => {
  it('is one definition, and 24:00 is an end only', () => {
    expect(HHMM.test('23:59')).toBe(true);
    expect(HHMM.test('24:00')).toBe(false);
    expect(HHMM_OR_END_OF_DAY.test('24:00')).toBe(true);
    expect(HHMM_OR_END_OF_DAY.test('24:01')).toBe(false);
  });
});
