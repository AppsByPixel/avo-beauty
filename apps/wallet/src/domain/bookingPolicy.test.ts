/**
 * The cancel preview's arithmetic, pinned against the SERVER's.
 *
 * `cancelPreview` is display only (#2): it tells her what the stamped rule would
 * return at this moment, and the server's answer is what she is shown after. But
 * it must be the same answer whenever nothing moved in between, or it is a
 * promise the server breaks — and the place a copy drifts is the rounding.
 *
 * The server's rule, from api/src/services/bookingPolicy.ts § cancellationOutcome
 * and § splitDeposit: the first rule whose `hoursBefore` she meets (in ms, at or
 * before the threshold) wins; later than all of them is 0%; the percent of
 * integer fils is rounded DOWN and the salon keeps the remainder fil.
 */

import { describe, expect, it } from 'vitest';
import { fils, formatMoney } from '@avo/types';
import { cancelPreview, policySummary, policyText, splitDeposit } from './bookingPolicy';
import { en } from '../copy/en';
import { ar } from '../copy/ar';

const START = '2026-10-01T13:00:00.000Z';
const HOUR = 3_600_000;
const at = (hoursBefore: number, extraMs = 0) => new Date(Date.parse(START) - hoursBefore * HOUR + extraMs);

/** 24h → 100%, 2h → 50%, later → 0. The brief's own example. */
const RULES = [
  { hoursBefore: 24, returnPercent: 100 },
  { hoursBefore: 2, returnPercent: 50 },
];

describe('the preview at each cut-off', () => {
  it.each([
    ['48h out — the first rule', 48, 0, 100, 5000, 0],
    ['exactly 24h — the threshold is met, not missed', 24, 0, 100, 5000, 0],
    ['1 ms inside 24h — the second rule', 24, 1, 50, 2500, 2500],
    ['exactly 2h', 2, 0, 50, 2500, 2500],
    ['1 ms inside 2h — later than every rule, nothing back', 2, 1, 0, 0, 5000],
    ['ten minutes before', 10 / 60, 0, 0, 0, 5000],
  ])('%s', (_label, hours, extra, percent, back, kept) => {
    const p = cancelPreview(RULES, START, at(hours, extra), 5000);
    expect(p.returnPercent).toBe(percent);
    expect(p.returnedFils).toBe(back);
    expect(p.keptFils).toBe(kept);
    expect(p.returnedFils + p.keptFils).toBe(5000);
  });

  it('no rules at all returns nothing, however early', () => {
    const p = cancelPreview([], START, at(700), 5000);
    expect(p).toEqual({ rule: null, returnPercent: 0, returnedFils: 0, keptFils: 5000 });
  });
});

describe('rounding: DOWN to the fil, and the salon keeps the remainder', () => {
  it('50% of 5.005 KD is 2.502 back and 2.503 kept — not the half-up 2.503', () => {
    expect(splitDeposit(fils(5005), 50)).toEqual({ returnedFils: 2502, keptFils: 2503 });
    const p = cancelPreview(RULES, START, at(5), 5005);
    expect(p.returnedFils).toBe(2502);
    expect(p.keptFils).toBe(2503);
  });

  it('33% of 1.001 KD is 0.330 back', () => {
    expect(splitDeposit(fils(1001), 33)).toEqual({ returnedFils: 330, keptFils: 671 });
  });

  /*
    AN INDEPENDENT ORACLE, NOT THE SERVER'S CODE. Importing
    api/src/services/bookingPolicy.ts from a wallet test would couple this lane's
    suite to lane A's module graph (drizzle, the schema, the audit writer). The
    ruling is one sentence — "rounded down to the fil, the salon keeps the
    remainder" — and BigInt division IS floor division on non-negatives, by a
    different path than the implementation's `product − product % 100`.
  */
  it('agrees with BigInt floor division on every percent, for awkward deposits', () => {
    for (const deposit of [1, 7, 99, 999, 1001, 4999, 5005, 12345, 1_000_000]) {
      for (let percent = 0; percent <= 100; percent++) {
        const back = Number((BigInt(deposit) * BigInt(percent)) / 100n);
        expect(splitDeposit(fils(deposit), percent)).toEqual({ returnedFils: back, keptFils: deposit - back });
      }
    }
  });
});

/**
 * AFTER A LATE MOVE — `BookingSchema.returnCapPercent` (trunk 7646bb8).
 *
 * Lane A's reading, accepted (DECISIONS.md, "Reschedule loophole"): a late
 * reschedule locks in the percent she held at the moment she moved, and a later
 * cancel returns the SMALLER of that and the new slot's rule — the server's
 * `cancellationOutcome(rules, startsAt, now, deposit, capPercent)`. Without the
 * cap, a move from 5 hours out (50%) to next week reads 100% here while the
 * server pays 50%: a preview that promises twice what comes back.
 */
describe('the preview after a late move takes the same minimum as the server', () => {
  it('moved at 50%, the new slot 48h out: 50% back, not 100%', () => {
    const p = cancelPreview(RULES, START, at(48), 5000, 50);
    expect(p.returnPercent).toBe(50);
    expect(p.returnedFils).toBe(2500);
    expect(p.keptFils).toBe(2500);
    // When the cap binds, the rule is the stamped one whose percent it equals.
    expect(p.rule).toEqual({ hoursBefore: 2, returnPercent: 50 });
  });

  it('moved later than every cut-off: a cap of 0 returns nothing, however far out she is now', () => {
    const p = cancelPreview(RULES, START, at(700), 5000, 0);
    expect(p).toEqual({ rule: null, returnPercent: 0, returnedFils: 0, keptFils: 5000 });
  });

  it('the cap never raises a return — the new slot’s rule wins when it is lower', () => {
    const p = cancelPreview(RULES, START, at(1), 5000, 50);
    expect(p.returnPercent).toBe(0);
    expect(p.returnedFils).toBe(0);
  });

  it('a cap equal to the rule changes nothing, and a null cap is the plain rule', () => {
    expect(cancelPreview(RULES, START, at(48), 5000, 100)).toEqual(cancelPreview(RULES, START, at(48), 5000));
    expect(cancelPreview(RULES, START, at(48), 5000, null).returnPercent).toBe(100);
  });

  it('a capped split rounds down to the fil like any other: 50% of 5.005 KD is 2.502', () => {
    const p = cancelPreview(RULES, START, at(48), 5005, 50);
    expect(p.returnedFils).toBe(2502);
    expect(p.keptFils).toBe(2503);
  });

  it('a cap that matches no stamped rule reports no rule, and still applies', () => {
    const p = cancelPreview(RULES, START, at(48), 1001, 33);
    expect(p.rule).toBeNull();
    expect(p.returnPercent).toBe(33);
    expect(p.returnedFils).toBe(330);
    expect(p.keptFils).toBe(671);
  });
});

describe('the summary, in both languages', () => {
  it('English: the brief’s own sentence', () => {
    expect(policySummary({ noShow: 'keep', cancellation: RULES }, en)).toEqual({
      noShow: 'No-show: the salon keeps your deposit.',
      cancel: 'Cancel 24 hours before: 100% back · 2 hours before: 50% back · later: nothing back',
    });
  });

  it('one hour is singular, and a 0% rule says nothing rather than 0%, with no repeated tail', () => {
    const s = policySummary(
      { noShow: 'return', cancellation: [{ hoursBefore: 1, returnPercent: 0 }] },
      en,
    );
    expect(s.noShow).toBe('No-show: your deposit comes back to your wallet.');
    expect(s.cancel).toBe('Cancel 1 hour before: nothing back');
  });

  it('no cut-offs: one sentence', () => {
    expect(policySummary({ noShow: 'keep', cancellation: [] }, en).cancel).toBe(en.policyCancelNothing);
  });

  it('Arabic: Eastern digits, the Arabic percent sign, and the hours agreeing with the number', () => {
    expect(policySummary({ noShow: 'keep', cancellation: RULES }, ar).cancel).toBe(
      'الإلغاء قبل ٢٤ ساعة: يُعاد ١٠٠٪ · قبل ساعتين: يُعاد ٥٠٪ · بعد ذلك: لا يُعاد شيء',
    );
    expect(ar.policyCutoff(1, 50, true)).toBe('الإلغاء قبل ساعة: يُعاد ٥٠٪');
    expect(ar.policyCutoff(5, 25, false)).toBe('قبل ٥ ساعات: يُعاد ٢٥٪');
    expect(ar.policyCutoff(48, 0, false)).toBe('قبل ٤٨ ساعة: لا يُعاد شيء');
    expect(ar.policyCutoff(103, 10, false)).toBe('قبل ١٠٣ ساعات: يُعاد ١٠٪');
  });

  it('money stays Western in the Arabic money lines', () => {
    const amount = formatMoney(fils(2502), 'ar');
    expect(ar.cancelPreviewBack(amount)).toBe('إذا ألغيتِ الآن، يعود 2.502 د.ك إلى محفظتكِ.');
    expect(ar.settledKept(formatMoney(fils(2503), 'ar'))).toBe('احتفظ الصالون بـ 2.503 د.ك');
  });
});

describe('the salon’s text', () => {
  it('Arabic when she wrote it, English when she did not — and says which', () => {
    expect(policyText({ en: 'EN', ar: 'عربي' }, 'ar')).toEqual({ body: 'عربي', lang: 'ar' });
    expect(policyText({ en: 'EN', ar: '' }, 'ar')).toEqual({ body: 'EN', lang: 'en' });
    expect(policyText({ en: 'EN', ar: '   ' }, 'ar')).toEqual({ body: 'EN', lang: 'en' });
    expect(policyText({ en: 'EN', ar: 'عربي' }, 'en')).toEqual({ body: 'EN', lang: 'en' });
  });
});
