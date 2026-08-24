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
 */

import { describe, expect, it } from 'vitest';
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

  it('accepts 24:00 as a closing time and refuses it as an opening one', () => {
    expect(parseBusinessHours({ ...KUWAITI_DAY, evening: ['16:00', '24:00'] }).evening)
      .toEqual(['16:00', '24:00']);
    expect(refusal(() => parseBusinessHours({ ...KUWAITI_DAY, evening: ['24:00', '24:00'] })).code)
      .toBe('invalid_business_hours');
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

  it('refuses a string that is not a clock, which the shared schema allows', () => {
    // BusinessHoursSchema is `z.tuple([z.string(), z.string()])` — two strings,
    // not two times. This is the gap between the wire shape and what may be
    // stored, and it is the gap that produced the availability 500.
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

  it('names the session and the offending value, not just the field', () => {
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
