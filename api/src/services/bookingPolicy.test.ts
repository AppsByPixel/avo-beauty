/**
 * THE POLICY'S PURE HALF — parsing, the split and the cut-off rule — on every
 * merge (these are unit specs, not `.int`, so `pnpm check` runs them).
 *
 * The money assertions are EXACT FILS, never "close to": the ruling is "applied to
 * integer fils and rounded down to the fil; the salon keeps the remainder fil", and
 * a float or a half-up rounding differs from it by exactly one fil on exactly the
 * deposits these specs pick.
 */

import { fils, percentOf } from '@avo/types';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../http/errors';
import {
  cancellationOutcome,
  lockInCap,
  noShowOutcome,
  returnPercentAt,
  parseCancellationRules,
  parsePolicyInput,
  splitDeposit,
} from './bookingPolicy';

const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (err) {
    if (err instanceof ApiError) return err.code;
    throw err;
  }
  throw new Error('expected a refusal');
};

const H = 3_600_000;
const START = new Date('2026-10-10T16:00:00+03:00');
const before = (hours: number, extraMs = 0) => new Date(START.getTime() - hours * H - extraMs);

describe('splitDeposit — rounded DOWN to the fil, the salon keeps the remainder', () => {
  it('5.005 KD at 50% returns 2502 and keeps 2503 — not 2503/2502', () => {
    expect(splitDeposit(fils(5_005), 50)).toEqual({ returnedFils: 2_502, keptFils: 2_503 });
  });

  it('is NOT @avo/types percentOf, which rounds half-up — the finding, pinned', () => {
    // If percentOf ever changes to floor, this spec says so and the helper can go.
    expect(percentOf(fils(5_005), 50)).toBe(2_503);
    expect(splitDeposit(fils(5_005), 50).returnedFils).toBe(2_502);
  });

  it('the parts always sum to the deposit, for every percent, on an awkward deposit', () => {
    for (let p = 0; p <= 100; p++) {
      const { returnedFils, keptFils } = splitDeposit(fils(7_777), p);
      expect(returnedFils + keptFils, `${p}%`).toBe(7_777);
      expect(Number.isInteger(returnedFils) && Number.isInteger(keptFils)).toBe(true);
      // Floor: never more than the exact share, and less by under one fil.
      expect(returnedFils * 100).toBeLessThanOrEqual(7_777 * p);
      expect(7_777 * p - returnedFils * 100).toBeLessThan(100);
    }
  });

  it('100% returns everything and 0% keeps everything', () => {
    expect(splitDeposit(fils(5_000), 100)).toEqual({ returnedFils: 5_000, keptFils: 0 });
    expect(splitDeposit(fils(5_000), 0)).toEqual({ returnedFils: 0, keptFils: 5_000 });
  });

  it('refuses a fractional or out-of-range percent rather than rounding it', () => {
    expect(() => splitDeposit(fils(5_000), 12.5)).toThrow(RangeError);
    expect(() => splitDeposit(fils(5_000), 101)).toThrow(RangeError);
    expect(() => splitDeposit(fils(5_000), -1)).toThrow(RangeError);
  });
});

describe('cancellationOutcome — the first threshold she meets wins', () => {
  const rules = [
    { hoursBefore: 48, returnPercent: 100 },
    { hoursBefore: 24, returnPercent: 50 },
    { hoursBefore: 2, returnPercent: 25 },
  ];

  it('exactly on a threshold meets it; one millisecond later does not', () => {
    expect(cancellationOutcome(rules, START, before(48), fils(5_005)).returnPercent).toBe(100);
    expect(cancellationOutcome(rules, START, before(48, -1), fils(5_005)).returnPercent).toBe(50);
  });

  it('each band, with exact fils on a deposit that leaves a remainder', () => {
    expect(cancellationOutcome(rules, START, before(72), fils(5_005))).toMatchObject({
      rule: { hoursBefore: 48, returnPercent: 100 },
      returnedFils: 5_005,
      keptFils: 0,
    });
    expect(cancellationOutcome(rules, START, before(30), fils(5_005))).toMatchObject({
      rule: { hoursBefore: 24, returnPercent: 50 },
      returnedFils: 2_502,
      keptFils: 2_503,
    });
    expect(cancellationOutcome(rules, START, before(3), fils(5_005))).toMatchObject({
      rule: { hoursBefore: 2, returnPercent: 25 },
      returnedFils: 1_251,
      keptFils: 3_754,
    });
  });

  it('later than every threshold returns 0%, and no rule matched', () => {
    expect(cancellationOutcome(rules, START, before(1), fils(5_005))).toEqual({
      rule: null,
      returnPercent: 0,
      returnedFils: 0,
      keptFils: 5_005,
    });
  });

  it('a policy with no rules returns nothing on any cancel', () => {
    expect(cancellationOutcome([], START, before(500), fils(5_000)).returnedFils).toBe(0);
  });
});

describe('the reschedule cap — a late move cannot buy back a return she had lost', () => {
  const rules = [
    { hoursBefore: 48, returnPercent: 100 },
    { hoursBefore: 24, returnPercent: 50 },
  ];
  const DAY = 24 * H;

  it('no cap: the rules decide, unchanged', () => {
    expect(cancellationOutcome(rules, START, before(72), fils(5_005), null)).toEqual(
      cancellationOutcome(rules, START, before(72), fils(5_005)),
    );
  });

  it("trunk's case: moved at 30h (50% locked in), cancelled a week out — 50%, not 100%", () => {
    const original = START;
    const movedAt = before(30);
    const cap = lockInCap(null, returnPercentAt(rules, original, movedAt));
    expect(cap).toBe(50);
    const newSlot = new Date(original.getTime() + 7 * DAY);
    expect(cancellationOutcome(rules, newSlot, movedAt, fils(5_005), cap)).toEqual({
      rule: { hoursBefore: 24, returnPercent: 50 },
      returnPercent: 50,
      returnedFils: 2_502,
      keptFils: 2_503,
    });
  });

  it('the cap is a ceiling, not a floor: the new slot\'s own rules can still bring it lower', () => {
    const newSlot = new Date(START.getTime() + 7 * DAY);
    // Twelve hours before the NEW slot: later than every rule → 0%, cap 50 or not.
    const late = new Date(newSlot.getTime() - 12 * H);
    expect(cancellationOutcome(rules, newSlot, late, fils(5_005), 50)).toMatchObject({
      rule: null,
      returnPercent: 0,
      keptFils: 5_005,
    });
  });

  it('a cap below every rule names no rule', () => {
    expect(cancellationOutcome(rules, START, before(72), fils(5_005), 0)).toEqual({
      rule: null,
      returnPercent: 0,
      returnedFils: 0,
      keptFils: 5_005,
    });
  });

  it('WHY A CAP: an early move (100%) keeps 100% after the original slot\'s time has gone by', () => {
    // Booked for the 10th; moved on the 5th, five days ahead, to the 25th.
    const movedAt = new Date(START.getTime() - 5 * DAY);
    const cap = lockInCap(null, returnPercentAt(rules, START, movedAt));
    expect(cap).toBe(100);
    const newSlot = new Date(START.getTime() + 15 * DAY);
    // Cancelled on the 15th: ten days before the appointment that exists. The
    // original slot (the 10th) is five days in the PAST, so measuring from it
    // would return 0% and keep the whole deposit. The cap returns it all.
    const cancelAt = new Date(START.getTime() + 5 * DAY);
    expect(cancellationOutcome(rules, START, cancelAt, fils(5_005)).returnPercent).toBe(0);
    expect(cancellationOutcome(rules, newSlot, cancelAt, fils(5_005), cap).returnPercent).toBe(100);
  });

  it('lockInCap only ever narrows, across a chain of moves', () => {
    expect(lockInCap(null, 100)).toBe(100);
    expect(lockInCap(null, 50)).toBe(50);
    expect(lockInCap(50, 100)).toBe(50);
    expect(lockInCap(100, 50)).toBe(50);
    expect(lockInCap(50, 0)).toBe(0);
    // A second move, from a slot a week out, with 50% already locked in.
    expect(returnPercentAt(rules, new Date(START.getTime() + 7 * DAY), START, 50)).toBe(50);
  });
});

describe('noShowOutcome', () => {
  it('keep keeps it all, return returns it all', () => {
    expect(noShowOutcome('keep', fils(5_005))).toEqual({ returnedFils: 0, keptFils: 5_005 });
    expect(noShowOutcome('return', fils(5_005))).toEqual({ returnedFils: 5_005, keptFils: 0 });
  });
});

describe('parseCancellationRules — every refusal has its own code', () => {
  it('accepts up to three, earliest cut-off first, and an empty list', () => {
    expect(parseCancellationRules([])).toEqual([]);
    expect(
      parseCancellationRules([
        { hoursBefore: 48, returnPercent: 100 },
        { hoursBefore: 24, returnPercent: 100 },
        { hoursBefore: 1, returnPercent: 0 },
      ]),
    ).toHaveLength(3);
  });

  it('refuses four rules', () => {
    const four = [4, 3, 2, 1].map((h) => ({ hoursBefore: h, returnPercent: 0 }));
    expect(code(() => parseCancellationRules(four))).toBe('too_many_cancellation_rules');
  });

  it('refuses a non-positive, fractional, stringly or over-long hoursBefore', () => {
    for (const h of [0, -1, 1.5, '24', null, 721]) {
      expect(code(() => parseCancellationRules([{ hoursBefore: h, returnPercent: 50 }])), String(h)).toBe(
        'invalid_hours_before',
      );
    }
  });

  it('refuses hoursBefore that is not strictly descending — equal included', () => {
    expect(
      code(() =>
        parseCancellationRules([
          { hoursBefore: 24, returnPercent: 50 },
          { hoursBefore: 48, returnPercent: 25 },
        ]),
      ),
    ).toBe('hours_before_not_descending');
    expect(
      code(() =>
        parseCancellationRules([
          { hoursBefore: 24, returnPercent: 50 },
          { hoursBefore: 24, returnPercent: 25 },
        ]),
      ),
    ).toBe('hours_before_not_descending');
  });

  it('refuses a percent outside 0..100 or fractional', () => {
    for (const p of [-1, 101, 50.5, '50']) {
      expect(code(() => parseCancellationRules([{ hoursBefore: 24, returnPercent: p }])), String(p)).toBe(
        'invalid_return_percent',
      );
    }
  });

  it('refuses a later cut-off that returns MORE — non-increasing, equal allowed', () => {
    expect(
      code(() =>
        parseCancellationRules([
          { hoursBefore: 48, returnPercent: 50 },
          { hoursBefore: 24, returnPercent: 60 },
        ]),
      ),
    ).toBe('return_percent_increasing');
  });

  it('refuses a non-list, a non-object rule, and an unknown field', () => {
    expect(code(() => parseCancellationRules({}))).toBe('invalid_cancellation_rules');
    expect(code(() => parseCancellationRules([7]))).toBe('invalid_cancellation_rules');
    expect(
      code(() => parseCancellationRules([{ hoursBefore: 24, returnPercent: 50, fee: 1 }])),
    ).toBe('invalid_cancellation_rules');
  });
});

describe('parsePolicyInput', () => {
  const ok = {
    noShow: 'keep',
    cancellation: [{ hoursBefore: 24, returnPercent: 100 }],
    text: { en: '  Free until 24 hours before.  ', ar: '' },
  };

  it('trims the text and keeps an empty Arabic as the fallback', () => {
    expect(parsePolicyInput(ok).text).toEqual({ en: 'Free until 24 hours before.', ar: '' });
    expect(parsePolicyInput({ ...ok, text: { en: 'x' } }).text.ar).toBe('');
  });

  it('refuses an unknown no-show rule, a missing English text and an unknown field', () => {
    expect(code(() => parsePolicyInput({ ...ok, noShow: 'refund' }))).toBe('invalid_no_show_rule');
    expect(code(() => parsePolicyInput({ ...ok, text: { en: '   ', ar: 'x' } }))).toBe('invalid_policy_text');
    expect(code(() => parsePolicyInput({ ...ok, windowMinutes: 60 }))).toBe('invalid_policy');
    expect(code(() => parsePolicyInput(null))).toBe('invalid_policy');
  });

  it('refuses text over 1000 characters in either language, and accepts 1000', () => {
    const long = 'a'.repeat(1001);
    expect(code(() => parsePolicyInput({ ...ok, text: { en: long, ar: '' } }))).toBe('policy_text_too_long');
    expect(code(() => parsePolicyInput({ ...ok, text: { en: 'x', ar: long } }))).toBe('policy_text_too_long');
    expect(parsePolicyInput({ ...ok, text: { en: 'a'.repeat(1000), ar: '' } }).text.en).toHaveLength(1000);
  });
});
