/**
 * W8 — WHEN SHE CAN COLLECT, decided in the SALON's zone.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THIS FILE RUNS IN A NON-KUWAIT ZONE, ON PURPOSE, AND CHECKS THAT IT DOES.
 *
 * The machine this was written on runs PKT (UTC+5), two hours AHEAD of Kuwait,
 * and a charge in `api/src/services/reports.ts` has already landed on the wrong
 * day for reading the host clock. A spec that ran in Asia/Kuwait could not tell
 * "decided in the salon's zone" from "decided on the device", because the two
 * would agree. So the device zone is forced to Asia/Karachi below — and then to
 * a zone on the far side of the date line — and the first spec asserts the
 * device clock really does disagree with Kuwait at every instant used, so the
 * rest are not vacuous.
 *
 * Every instant is chosen where the two clocks give DIFFERENT answers:
 *
 *   UTC 17:30   Kuwait 20:30  OPEN (evening)      Karachi 22:30  after hours
 *   UTC 05:30   Kuwait 08:30  before opening      Karachi 10:30  open
 *   UTC 11:00   Kuwait 14:00  afternoon closure   Karachi 16:00  open
 *   UTC 18:30   Kuwait 21:30  after hours         Karachi 23:30  after hours*
 *
 * (*the one where both say "closed" — it pins "tomorrow" rather than the zone.)
 * ═════════════════════════════════════════════════════════════════════════════
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  pickupHoursLines,
  pickupNow,
  tradingSpans,
  wallClockLabel,
  type BusinessHours,
} from './pickupHours';
import { en } from '../copy/en';
import { ar } from '../copy/ar';
import { hasWesternDigits } from '../i18n/digits';

const DEVICE_ZONE = 'Asia/Karachi';
const originalTZ = process.env.TZ;
beforeAll(() => {
  process.env.TZ = DEVICE_ZONE;
});
afterAll(() => {
  if (originalTZ === undefined) delete process.env.TZ;
  else process.env.TZ = originalTZ;
});

const KUWAIT = 'Asia/Kuwait';
/** The Kuwaiti afternoon closure — the seed's hours, and the norm. */
const SPLIT: BusinessHours = { morning: ['10:00', '13:00'], evening: ['16:00', '21:00'] };
/** Open straight through: the evening is the established "no second sitting". */
const STRAIGHT: BusinessHours = { morning: ['10:00', '21:00'], evening: ['21:00', '21:00'] };

const at = (iso: string) => new Date(iso);
const OPEN_EVENING = at('2026-09-28T17:30:00Z');
const BEFORE_OPENING = at('2026-09-28T05:30:00Z');
const AFTERNOON = at('2026-09-28T11:00:00Z');
const AFTER_HOURS = at('2026-09-28T18:30:00Z');

describe('the device is NOT on Kuwait time while these run', () => {
  it('Karachi and Kuwait disagree at every instant below', () => {
    expect(new Date().getTimezoneOffset()).toBe(-300); // UTC+5, no DST
    expect(OPEN_EVENING.getHours()).toBe(22);
    expect(BEFORE_OPENING.getHours()).toBe(10);
    expect(AFTERNOON.getHours()).toBe(16);
  });
});

describe('tradingSpans — a span with to <= from is not a window', () => {
  it('two windows, morning then evening', () => {
    expect(tradingSpans(SPLIT)).toEqual([
      ['10:00', '13:00'],
      ['16:00', '21:00'],
    ]);
  });
  it('a zero-length evening is dropped — ONE range, never a phantom second', () => {
    expect(tradingSpans(STRAIGHT)).toEqual([['10:00', '21:00']]);
  });
  it('a backwards span is dropped too; nothing trading is []', () => {
    expect(tradingSpans({ morning: ['10:00', '22:00'], evening: ['22:00', '18:00'] })).toEqual([
      ['10:00', '22:00'],
    ]);
    expect(tradingSpans({ morning: ['09:00', '09:00'], evening: ['21:00', '21:00'] })).toEqual([]);
  });
  it('24:00 is a real end of day', () => {
    expect(tradingSpans({ morning: ['16:00', '24:00'], evening: ['24:00', '24:00'] })).toEqual([
      ['16:00', '24:00'],
    ]);
  });
});

describe('pickupNow — decided in the SALON’s zone', () => {
  it('20:30 in Kuwait is OPEN, although the device says 22:30', () => {
    expect(pickupNow(SPLIT, KUWAIT, OPEN_EVENING)).toEqual({ kind: 'open' });
  });
  it('08:30 in Kuwait is closed until 10:00 TODAY, although the device says 10:30', () => {
    expect(pickupNow(SPLIT, KUWAIT, BEFORE_OPENING)).toEqual({
      kind: 'closed',
      day: 'today',
      opensAt: '10:00',
    });
  });
  it('14:00 in Kuwait is the afternoon closure — back at 16:00 today', () => {
    expect(pickupNow(SPLIT, KUWAIT, AFTERNOON)).toEqual({ kind: 'closed', day: 'today', opensAt: '16:00' });
  });
  it('21:30 in Kuwait is after hours — TOMORROW from the first window', () => {
    expect(pickupNow(SPLIT, KUWAIT, AFTER_HOURS)).toEqual({
      kind: 'closed',
      day: 'tomorrow',
      opensAt: '10:00',
    });
  });
  it('the boundaries are half-open: open AT from, closed AT to', () => {
    expect(pickupNow(SPLIT, KUWAIT, at('2026-09-28T07:00:00Z'))).toEqual({ kind: 'open' }); // 10:00
    expect(pickupNow(SPLIT, KUWAIT, at('2026-09-28T18:00:00Z'))).toEqual({
      kind: 'closed',
      day: 'tomorrow',
      opensAt: '10:00',
    }); // 21:00
  });
  it('reads the zone it is GIVEN — a Dubai salon (UTC+4) at the same instant', () => {
    // UTC 17:30 is 21:30 in Dubai: after hours there, open in Kuwait.
    expect(pickupNow(SPLIT, 'Asia/Dubai', OPEN_EVENING)).toEqual({
      kind: 'closed',
      day: 'tomorrow',
      opensAt: '10:00',
    });
  });
  it('an unusable zone falls back to Kuwait, never to the device', () => {
    expect(pickupNow(SPLIT, 'Not/AZone', OPEN_EVENING)).toEqual({ kind: 'open' });
  });
  it('straight through: 14:00 is open — there is no afternoon closure to invent', () => {
    expect(pickupNow(STRAIGHT, KUWAIT, AFTERNOON)).toEqual({ kind: 'open' });
  });
  it('no window at all says nothing', () => {
    expect(pickupNow({ morning: ['09:00', '09:00'], evening: ['21:00', '21:00'] }, KUWAIT, AFTERNOON)).toBeNull();
  });
});

describe('the same answers with the device across the date line', () => {
  /*
    Pacific/Kiritimati is UTC+14. At UTC 18:30 the DEVICE is already on the
    29th at 08:30 — before a 10:00 opening "today" by its clock — while Kuwait
    is still the 28th at 21:30, after hours, collect TOMORROW. The device-clock
    answer would be "today from 10 am", wrong by a day.
  */
  let saved: string | undefined;
  beforeAll(() => {
    saved = process.env.TZ;
    process.env.TZ = 'Pacific/Kiritimati';
  });
  afterAll(() => {
    process.env.TZ = saved;
  });
  it('is tomorrow in Kuwait, not today on the device', () => {
    expect(AFTER_HOURS.getDate()).toBe(29);
    expect(AFTER_HOURS.getHours()).toBe(8);
    expect(pickupNow(SPLIT, KUWAIT, AFTER_HOURS)).toEqual({
      kind: 'closed',
      day: 'tomorrow',
      opensAt: '10:00',
    });
  });
});

describe('the sentences, EN and AR', () => {
  it('two windows, English 12-hour, "10 am – 1 pm and 4 pm – 9 pm"', () => {
    expect(pickupHoursLines(SPLIT, KUWAIT, OPEN_EVENING, en)).toEqual({
      hours: 'Collect during working hours, 10 am – 1 pm and 4 pm – 9 pm',
      closedNow: null,
    });
  });
  it('Arabic: Eastern digits and ص/م, the wallet’s own time convention', () => {
    const lines = pickupHoursLines(SPLIT, KUWAIT, OPEN_EVENING, ar);
    expect(lines).toEqual({
      hours: 'استلمي خلال ساعات العمل، ١٠ ص – ١ م و٤ م – ٩ م',
      closedNow: null,
    });
    expect(hasWesternDigits(lines!.hours)).toBe(false);
  });
  it('a zero-length evening is ONE range in both languages', () => {
    expect(pickupHoursLines(STRAIGHT, KUWAIT, AFTERNOON, en)!.hours).toBe(
      'Collect during working hours, 10 am – 9 pm',
    );
    expect(pickupHoursLines(STRAIGHT, KUWAIT, AFTERNOON, ar)!.hours).toBe(
      'استلمي خلال ساعات العمل، ١٠ ص – ٩ م',
    );
  });
  it('after hours: "Closed now — collect tomorrow from 10 am", EN and AR', () => {
    expect(pickupHoursLines(SPLIT, KUWAIT, AFTER_HOURS, en)!.closedNow).toBe(
      'Closed now — collect tomorrow from 10 am',
    );
    expect(pickupHoursLines(SPLIT, KUWAIT, AFTER_HOURS, ar)!.closedNow).toBe(
      'مغلق الآن — استلمي غداً من ١٠ ص',
    );
  });
  it('the afternoon closure: "Closed now — collect today from 4 pm", EN and AR', () => {
    expect(pickupHoursLines(SPLIT, KUWAIT, AFTERNOON, en)!.closedNow).toBe(
      'Closed now — collect today from 4 pm',
    );
    expect(pickupHoursLines(SPLIT, KUWAIT, AFTERNOON, ar)!.closedNow).toBe(
      'مغلق الآن — استلمي اليوم من ٤ م',
    );
  });
  it('an unknown zone draws the hours and NO closed-now line — never the device’s answer', () => {
    expect(pickupHoursLines(SPLIT, null, AFTER_HOURS, en)).toEqual({
      hours: 'Collect during working hours, 10 am – 1 pm and 4 pm – 9 pm',
      closedNow: null,
    });
  });
  it('nothing trading draws nothing', () => {
    expect(pickupHoursLines({ morning: ['09:00', '09:00'], evening: ['21:00', '21:00'] }, KUWAIT, AFTERNOON, en)).toBeNull();
  });
  it('wallClockLabel keeps half-hours and drops :00', () => {
    expect(wallClockLabel('16:30', 'en-GB')).toBe('4:30 pm');
    expect(wallClockLabel('10:00', 'en-GB')).toBe('10 am');
    expect(wallClockLabel('24:00', 'en-GB')).toBe('12 am');
    expect(wallClockLabel('16:30', 'ar-u-nu-arab')).toBe('٤:٣٠ م');
  });
});
