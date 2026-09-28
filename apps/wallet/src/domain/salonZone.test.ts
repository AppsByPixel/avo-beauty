/**
 * A SALON'S INSTANT IS READ IN THE SALON'S CLOCK — the activity row, the bell
 * and the receipt, both halves of every stamp.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THIS FILE RUNS IN A NON-SALON ZONE, ON PURPOSE, AND CHECKS THAT IT DOES.
 *
 * Until 2026-09-28 `dayAndTime` formatted the time in a hard-coded Kuwait zone
 * but decided Today/Yesterday with `toDateString()` — the DEVICE's calendar —
 * and `fullWhen` and the bell's booking labels hard-coded Kuwait instead of
 * reading `salon.timezone`. A spec that ran in Asia/Kuwait could not tell any
 * of that from correct, because the device and the salon would agree. So the
 * process zone is pinned to Asia/Karachi (UTC+5, two hours AHEAD of Kuwait,
 * one ahead of Dubai), and the first spec asserts the pin took, so the rest are
 * not vacuous.
 *
 * "Now" is faked with `vi.setSystemTime`, not passed in, so the activity row is
 * driven through the same `new Date()` default Home uses.
 *
 * The instants, and why each one is here:
 *
 *   UTC 07:00        Kuwait 10:00   Dubai 11:00   Karachi 12:00
 *   UTC 18:30 → 19:30  Kuwait 21:30 → 22:30, one evening   Karachi crosses midnight
 *   UTC 20:30 → 21:30  Kuwait crosses midnight              Karachi 01:30 → 02:30
 *   UTC 19:30 → 20:30  Dubai crosses midnight               Kuwait 22:30 → 23:30
 * ═════════════════════════════════════════════════════════════════════════════
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Transaction } from '@avo/types';
import type { BellItem } from '../api/bell';
import { dayAndTime, toActivityRow } from './activity';
import { bellRow, dayLabel, timeLabel } from './bell';
import { buildReceipt } from './receipt';
import { en } from '../copy/en';
import { ar } from '../copy/ar';

const DEVICE_ZONE = 'Asia/Karachi';
const KUWAIT = 'Asia/Kuwait';
const DUBAI = 'Asia/Dubai';

const originalTZ = process.env.TZ;
beforeAll(() => {
  process.env.TZ = DEVICE_ZONE;
});
afterAll(() => {
  if (originalTZ === undefined) delete process.env.TZ;
  else process.env.TZ = originalTZ;
});
afterEach(() => {
  vi.useRealTimers();
});

/** Freeze `new Date()` — and only Date; nothing here waits on a timer. */
function nowIs(iso: string): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(iso));
}

const BRANCHES = [{ id: 'BR-KWC', name: 'Kuwait City', nameAr: 'مدينة الكويت' }];

function tx(createdAt: string, over: Partial<Transaction> = {}): Transaction {
  return {
    id: 'TX-5719874',
    memberId: '8842',
    branchId: 'BR-KWC',
    kind: 'charge',
    amountFils: -5000,
    bonusFils: 0,
    method: 'wallet',
    status: 'settled',
    reference: 'AVO-CHG-5719874',
    createdAt,
    voidedAt: null,
    reversedByTransactionId: null,
    loyalty: null,
    ...over,
  } as Transaction;
}

/** The activity row's stamp, before the " · Kuwait City" branch suffix. */
function stamp(createdAt: string, timeZone: string, lang: 'en' | 'ar' = 'en'): string {
  const copy = lang === 'ar' ? ar : en;
  return toActivityRow(tx(createdAt), BRANCHES, lang, copy, timeZone).when.split(' · ').slice(0, 2).join(' · ');
}

describe('the device is NOT on the salon clock while these run', () => {
  it('the process zone is Karachi, and it disagrees with Kuwait and Dubai', () => {
    expect(process.env.TZ).toBe(DEVICE_ZONE);
    expect(new Date('2026-09-30T07:00:00Z').getTimezoneOffset()).toBe(-300); // UTC+5, no DST
    expect(new Date('2026-09-30T07:00:00Z').getHours()).toBe(12); // Kuwait says 10, Dubai 11
    // The midnight cases really do straddle the DEVICE's midnight, or the
    // boundary specs below could pass on the device calendar by luck.
    expect(new Date('2026-09-30T18:30:00Z').getDate()).toBe(30);
    expect(new Date('2026-09-30T19:30:00Z').getDate()).toBe(1);
  });
});

describe('the time half — the salon zone, not the device and not a constant', () => {
  it('2026-09-30T07:00:00Z is 10:00 in a Kuwait salon', () => {
    nowIs('2026-09-30T09:00:00Z');
    expect(stamp('2026-09-30T07:00:00Z', KUWAIT)).toBe(`${en.today} · 10:00 am`);
    expect(dayAndTime(new Date('2026-09-30T07:00:00Z'), 'en', en, KUWAIT)).toBe(`${en.today} · 10:00 am`);
  });

  it('the same instant is 11:00 in a Dubai salon — its own clock, not Kuwait', () => {
    nowIs('2026-09-30T09:00:00Z');
    expect(stamp('2026-09-30T07:00:00Z', DUBAI)).toBe(`${en.today} · 11:00 am`);
  });

  it('Arabic keeps Eastern digits on the time and the salon zone underneath', () => {
    nowIs('2026-09-30T09:00:00Z');
    expect(stamp('2026-09-30T07:00:00Z', KUWAIT, 'ar')).toBe(`${ar.today} · ١٠:٠٠ ص`);
    expect(stamp('2026-09-30T07:00:00Z', DUBAI, 'ar')).toBe(`${ar.today} · ١١:٠٠ ص`);
  });
});

describe('the day half — Today/Yesterday turns over at the SALON\'s midnight', () => {
  it('one Kuwait evening is Today, although the device has crossed midnight', () => {
    // 21:30 → 22:30 Kuwait, 30 Sept. Karachi: 23:30 on the 30th → 00:30 on the 1st.
    nowIs('2026-09-30T19:30:00Z');
    expect(stamp('2026-09-30T18:30:00Z', KUWAIT)).toBe(`${en.today} · 9:30 pm`);
  });

  it('across Kuwait midnight it is Yesterday, although the device calls both the same day', () => {
    // 23:30 on the 30th → 00:30 on the 1st, Kuwait. Karachi: 01:30 → 02:30, both the 1st.
    nowIs('2026-09-30T21:30:00Z');
    expect(stamp('2026-09-30T20:30:00Z', KUWAIT)).toBe(`${en.yesterday} · 11:30 pm`);
  });

  it('one minute either side of the salon midnight', () => {
    nowIs('2026-09-30T21:00:00Z'); // 00:00 on the 1st, Kuwait
    expect(stamp('2026-09-30T20:59:00Z', KUWAIT)).toBe(`${en.yesterday} · 11:59 pm`);
    expect(stamp('2026-09-30T21:00:00Z', KUWAIT)).toBe(`${en.today} · 12:00 am`);
  });

  it('two salon days back is a date, not Yesterday', () => {
    nowIs('2026-09-30T21:30:00Z'); // 1 Oct, Kuwait
    expect(stamp('2026-09-29T20:30:00Z', KUWAIT)).toBe('29 Sept · 11:30 pm');
  });

  it('a Dubai salon turns over at DUBAI\'s midnight, where Kuwait would not', () => {
    // 23:30 Dubai on the 30th → 00:30 Dubai on the 1st; Kuwait is 22:30 → 23:30, one day.
    nowIs('2026-09-30T20:30:00Z');
    expect(stamp('2026-09-30T19:30:00Z', DUBAI)).toBe(`${en.yesterday} · 11:30 pm`);
    expect(stamp('2026-09-30T19:30:00Z', KUWAIT)).toBe(`${en.today} · 10:30 pm`);
  });
});

describe('the receipt — the salon\'s date and time', () => {
  it('Kuwait and Dubai each print their own clock, and their own date across midnight', () => {
    const late = tx('2026-09-30T20:30:00Z');
    expect(buildReceipt(late, BRANCHES, 'en', en, KUWAIT).subtitle).toBe('30 September 2026 at 11:30 pm');
    expect(buildReceipt(late, BRANCHES, 'en', en, DUBAI).subtitle).toBe('1 October 2026 at 12:30 am');
  });

  it('2026-09-30T07:00:00Z is 10:00 on a Kuwait receipt', () => {
    expect(buildReceipt(tx('2026-09-30T07:00:00Z'), BRANCHES, 'en', en, KUWAIT).subtitle).toContain('10:00 am');
  });
});

describe('the bell — its stamps and its booking times, in the salon clock', () => {
  const HOLD: BellItem = {
    id: 'TX-4',
    kind: 'deposit_hold',
    transactionId: 'TX-4',
    createdAt: '2026-09-30T20:30:00Z',
    readAt: null,
    amountFils: 5000,
    bookingId: 'BK-1',
    serviceName: 'Blow-dry',
    artistName: 'Rana',
    startsAt: '2026-09-30T20:30:00Z',
  };
  const ctx = (timeZone: string) => ({
    lang: 'en' as const,
    copy: en,
    salon: 'Amara',
    timeZone,
    transactions: [],
    now: new Date('2026-09-30T21:30:00Z'),
  });

  it('the booking line names the salon\'s day and time', () => {
    expect(dayLabel('2026-09-30T20:30:00Z', 'en', KUWAIT)).toBe('Wed 30 Sept');
    expect(dayLabel('2026-09-30T20:30:00Z', 'en', DUBAI)).toBe('Thu 1 Oct');
    expect(timeLabel('2026-09-30T07:00:00Z', 'en', KUWAIT)).toBe('10:00 am');
    expect(timeLabel('2026-09-30T07:00:00Z', 'en', DUBAI)).toBe('11:00 am');
  });

  it('a row reads the zone it is given, for its stamp and its booking line', () => {
    const kw = bellRow(HOLD, ctx(KUWAIT));
    expect(kw.when).toBe(`${en.yesterday} · 11:30 pm`);
    expect(kw.lines).toContain(en.bellBookingAt('Wed 30 Sept', '11:30 pm'));

    const dxb = bellRow(HOLD, ctx(DUBAI));
    expect(dxb.when).toBe(`${en.today} · 12:30 am`);
    expect(dxb.lines).toContain(en.bellBookingAt('Thu 1 Oct', '12:30 am'));
  });
});
