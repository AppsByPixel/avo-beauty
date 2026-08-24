/**
 * The happy-hour banner, resolved against the SALON's clock.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE BUG THIS FILE EXISTS TO STOP IS INVISIBLE ON THIS MACHINE.
 *
 * The development host runs PKT (UTC+5). Kuwait is UTC+3. A banner built from
 * `new Date().getHours()` — which is what `design/avo-promotions.js` does, and
 * what any straight port of it would do — is two hours fast: it opens the
 * window at 14:00 Kuwait and closes it at 16:00, and every assertion written on
 * this laptop passes. So the fixtures below are UTC instants and the
 * expectations are stated in Kuwait wall time, and one test pins an instant
 * where the two clocks disagree about whether a window is live at all.
 *
 * `isHappyHourLive` and `minutesRemaining` come from `@avo/types` — the same
 * predicate the API runs to gate the earning multiplier at charge time. There is
 * no `live` flag, here or on the wire.
 * ═════════════════════════════════════════════════════════════════════════════
 */

import { describe, expect, it } from 'vitest';
import { formatCountdown, type HappyHour, type PromotionSet } from '@avo/types';
import { happyBanner, salonOffsetMinutes } from './happyHour';
import { hasWesternDigits } from '../i18n/digits';
import { en } from '../copy/en';
import { ar } from '../copy/ar';

/**
 * Verbatim from `GET /v1/salons/SAL-AMARA/promotions` on the real API, driven
 * against `avo_lane_b`. Not hand-written: a fixture narrower than the wire hides
 * exactly the bug the wire carries (see domain/names.ts).
 */
const HH_01: HappyHour = {
  id: 'HH-01',
  branchId: 'all',
  days: [0, 1, 2],
  from: '16:00',
  to: '18:00',
  reward: 'x2visit',
  on: true,
  notify: true,
};

const HH_02: HappyHour = {
  id: 'HH-02',
  branchId: 'BR-SAL',
  days: [4],
  from: '10:00',
  to: '13:00',
  reward: 'topup10',
  on: false,
  notify: false,
};

const PROMOTIONS: PromotionSet = {
  boosts: {
    'BR-SAL': { visit: 1, topup: 0, stamp: 1 },
    'BR-KWC': { visit: 2, topup: 10, stamp: 1 },
  },
  boostsPublishedAt: '2026-08-10T06:00:00.000Z',
  boostsPublishedBy: 'Noura',
  happy: [HH_01, HH_02],
};

/** `GET /salons/SAL-AMARA` § branches, with the Arabic the API serves. */
const BRANCHES = [
  { id: 'BR-KWC', name: 'Kuwait City', nameAr: 'مدينة الكويت' },
  { id: 'BR-SAL', name: 'Salmiya', nameAr: 'السالمية' },
];

const KUWAIT = 'Asia/Kuwait';

/** A UTC instant, written as the Kuwait wall time it denotes. */
function kuwait(iso: string): Date {
  return new Date(`${iso}+03:00`);
}

/** "HH:MM" in a named zone. Used to state the timezone trap TZ-independently. */
function wallClock(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone,
  }).format(at);
}

function banner(now: Date, lang: 'en' | 'ar' = 'en', promotions = PROMOTIONS) {
  return happyBanner(promotions, BRANCHES, KUWAIT, now, lang, lang === 'ar' ? ar : en);
}

// ------------------------------------------------------------------ zone ----

describe('the salon clock, not the host clock', () => {
  it('reads +180 for Kuwait, whatever the host is set to', () => {
    expect(salonOffsetMinutes(KUWAIT, kuwait('2026-08-25T12:00:00'))).toBe(180);
    // Kuwait has no DST, so the offset does not move across the year.
    expect(salonOffsetMinutes(KUWAIT, kuwait('2026-01-15T12:00:00'))).toBe(180);
  });

  it('falls back to Kuwait rather than to the host when the zone is unusable', () => {
    expect(salonOffsetMinutes('Not/AZone', new Date())).toBe(180);
  });

  /**
   * THE TEST THIS FILE IS FOR.
   *
   * 2026-08-24T22:30:00Z is Tuesday 01:30 in Kuwait and Tuesday 03:30 on this
   * machine. A window that runs 02:00–04:00 on Tuesdays is therefore LIVE by the
   * host clock and NOT YET OPEN by the salon's — it opens in half an hour. A
   * banner that says "1h 30m left" here is telling a customer in Kuwait that she
   * is earning double when she is not.
   */
  it('a window the host clock calls live is correctly reported as not yet open', () => {
    const window: HappyHour = { ...HH_01, id: 'HH-TZ', from: '02:00', to: '04:00', days: [2] };
    const now = new Date('2026-08-24T22:30:00Z');

    // The trap, stated without depending on the TZ this process happens to run
    // in — CI is UTC and this laptop is PKT, and the assertion has to mean the
    // same thing in both. At this instant a Karachi wall clock reads 03:30,
    // inside the window, and a Kuwait one reads 01:30, outside it.
    expect(wallClock(now, 'Asia/Karachi')).toBe('03:30');
    expect(wallClock(now, KUWAIT)).toBe('01:30');

    const view = banner(now, 'en', { ...PROMOTIONS, happy: [window] });
    expect(view?.kind).toBe('next');
    expect(view?.countdown).toBe('in 30m');
  });
});

// ------------------------------------------------------------------ live ----

describe('the live banner', () => {
  // Tuesday. HH-01 runs 16:00–18:00 on Sun/Mon/Tue.
  const at1630 = kuwait('2026-08-25T16:30:00');

  it('renders the reward, the branch, the end time and the real countdown', () => {
    expect(banner(at1630)).toEqual({
      kind: 'live',
      id: 'HH-01',
      title: 'Happy hour · Double visit credit',
      sub: 'All branches · until 18:00',
      countdown: '1h 30m left',
      clock: 'now 16:30',
    });
  });

  it('counts down against the salon clock as the window runs out', () => {
    expect(banner(kuwait('2026-08-25T16:00:00'))?.countdown).toBe('2h 0m left');
    expect(banner(kuwait('2026-08-25T17:02:00'))?.countdown).toBe('58m left');
    expect(banner(kuwait('2026-08-25T17:59:30'))?.countdown).toBe('1m left');
  });

  /**
   * `from <= now < to`, half-open, exactly as `rules.ts` states it. A charge
   * landing on `to` is outside the window, so the banner must be gone by then —
   * a banner that outlives its own multiplier by even a minute is the wrong
   * charge this whole predicate exists to prevent.
   */
  it('is gone at `to`, not at `to` plus a minute', () => {
    expect(banner(kuwait('2026-08-25T17:59:00'))?.kind).toBe('live');
    expect(banner(kuwait('2026-08-25T18:00:00'))?.kind).toBe('next');
  });

  it('opens exactly at `from`', () => {
    expect(banner(kuwait('2026-08-25T15:59:00'))?.kind).toBe('next');
    expect(banner(kuwait('2026-08-25T16:00:00'))?.kind).toBe('live');
  });

  it('shows the window that ends soonest when two are open at once', () => {
    const early: HappyHour = { ...HH_01, id: 'HH-EARLY', to: '17:00', reward: 'x2stamp' };
    const view = happyBanner(
      { ...PROMOTIONS, happy: [HH_01, early] },
      BRANCHES,
      KUWAIT,
      at1630,
      'en',
      en,
    );
    expect(view?.id).toBe('HH-EARLY');
    expect(view?.countdown).toBe('30m left');
  });

  it('names a single branch by name rather than by id', () => {
    const salmiya: HappyHour = { ...HH_01, id: 'HH-SAL', branchId: 'BR-SAL' };
    const view = happyBanner(
      { ...PROMOTIONS, happy: [salmiya] },
      BRANCHES,
      KUWAIT,
      at1630,
      'en',
      en,
    );
    expect(view?.sub).toBe('Salmiya · until 18:00');
  });

  it('falls back to the raw id for a branch the salon read does not carry', () => {
    const orphan: HappyHour = { ...HH_01, id: 'HH-ORPHAN', branchId: 'BR-GONE' };
    const view = happyBanner(
      { ...PROMOTIONS, happy: [orphan] },
      BRANCHES,
      KUWAIT,
      at1630,
      'en',
      en,
    );
    // Not blank, and not "All branches" — either would misstate where the
    // reward applies.
    expect(view?.sub).toBe('BR-GONE · until 18:00');
  });

  /**
   * A CONTRACT TEST AGAINST `@avo/types`, NOT AGAINST THIS MODULE, and that is
   * the point rather than a weakness. `happyHour.ts` deliberately does NOT
   * filter on `on` — `isHappyHourLive` and `minutesUntilNext` both already
   * refuse an off window, and this assertion stayed green when the module's own
   * redundant filter was deleted, which is how that was established. What it
   * guards now is the shared rule staying the shared rule.
   */
  it('never invents a live flag: an OFF window inside its own hours is not live', () => {
    // HH-02 runs Thursday 10:00–13:00 and is off.
    const thursday = kuwait('2026-08-27T11:00:00');
    const view = happyBanner(
      { ...PROMOTIONS, happy: [HH_02] },
      BRANCHES,
      KUWAIT,
      thursday,
      'en',
      en,
    );
    expect(view).toBeNull();
  });
});

// ------------------------------------------------------------------ next ----

describe('the next banner', () => {
  it('names today when the window opens later the same salon day', () => {
    // Tuesday 09:00 Kuwait; HH-01 opens at 16:00.
    expect(banner(kuwait('2026-08-25T09:00:00'))).toEqual({
      kind: 'next',
      id: 'HH-01',
      title: 'Next happy hour · Double visit credit',
      sub: 'All branches · today 16:00–18:00',
      countdown: 'in 7h 0m',
      clock: null,
    });
  });

  it('names the weekday when the next window is on another day', () => {
    // Wednesday 12:00 Kuwait. HH-01's days are Sun/Mon/Tue, so the next one is
    // Sunday.
    const view = banner(kuwait('2026-08-26T12:00:00'));
    expect(view?.sub).toBe('All branches · Sunday 16:00–18:00');
    expect(view?.countdown).toBe('in 100h 0m');
  });

  it('skips windows that are off when choosing the next one', () => {
    // Thursday 09:00 Kuwait. HH-02 would open in an hour if it were on; it is
    // not, so the answer is HH-01 on Sunday.
    const view = banner(kuwait('2026-08-27T09:00:00'));
    expect(view?.id).toBe('HH-01');
  });

  it('shows the soonest of several upcoming windows', () => {
    const sooner: HappyHour = { ...HH_01, id: 'HH-SOON', from: '10:00', to: '11:00' };
    const view = happyBanner(
      { ...PROMOTIONS, happy: [HH_01, sooner] },
      BRANCHES,
      KUWAIT,
      kuwait('2026-08-25T09:00:00'),
      'en',
      en,
    );
    expect(view?.id).toBe('HH-SOON');
    expect(view?.countdown).toBe('in 1h 0m');
  });
});

// ---------------------------------------------------------------- absent ----

describe('the absent state', () => {
  it('renders nothing when the promotions read failed', () => {
    // Non-null is the ONLY difference between "no promotions" and "we could not
    // read the promotions", and neither may put a claim on the screen.
    expect(happyBanner(null, BRANCHES, KUWAIT, kuwait('2026-08-25T16:30:00'), 'en', en)).toBeNull();
  });

  it('renders nothing when the salon publishes no windows', () => {
    expect(banner(kuwait('2026-08-25T16:30:00'), 'en', { ...PROMOTIONS, happy: [] })).toBeNull();
  });

  it('renders nothing when every window is switched off', () => {
    const off = { ...PROMOTIONS, happy: [{ ...HH_01, on: false }, HH_02] };
    expect(banner(kuwait('2026-08-25T16:30:00'), 'en', off)).toBeNull();
  });

  it('renders nothing for a window with no days, rather than searching forever', () => {
    const never = { ...PROMOTIONS, happy: [{ ...HH_01, days: [] }] };
    expect(banner(kuwait('2026-08-25T16:30:00'), 'en', never)).toBeNull();
  });
});

// ---------------------------------------------------------------- arabic ----

describe('Arabic', () => {
  it('lifts the design’s own wording for both banners', () => {
    // design:1136-1138 and :1145-1151. Times are Eastern — a time is not money.
    expect(banner(kuwait('2026-08-25T16:30:00'), 'ar')).toEqual({
      kind: 'live',
      id: 'HH-01',
      title: 'الساعة السعيدة · رصيد زيارة مضاعف',
      sub: 'كل الفروع · حتى ١٨:٠٠',
      countdown: 'باقي ١ س ٣٠ د',
      clock: 'الآن ١٦:٣٠',
    });
    expect(banner(kuwait('2026-08-25T09:00:00'), 'ar')?.sub).toBe(
      'كل الفروع · اليوم ١٦:٠٠–١٨:٠٠',
    );
    expect(banner(kuwait('2026-08-26T12:00:00'), 'ar')?.sub).toBe(
      'كل الفروع · الأحد ١٦:٠٠–١٨:٠٠',
    );
  });

  it('names an Arabic branch in Arabic', () => {
    const salmiya: HappyHour = { ...HH_01, id: 'HH-SAL', branchId: 'BR-SAL' };
    const view = happyBanner(
      { ...PROMOTIONS, happy: [salmiya] },
      BRANCHES,
      KUWAIT,
      kuwait('2026-08-25T16:30:00'),
      'ar',
      ar,
    );
    expect(view?.sub).toBe('السالمية · حتى ١٨:٠٠');
  });

  it('puts no Western digit on the Arabic banner', () => {
    for (const at of ['2026-08-25T16:30:00', '2026-08-25T09:00:00', '2026-08-26T12:00:00']) {
      const view = banner(kuwait(at), 'ar');
      expect(view).not.toBeNull();
      for (const field of [view!.title, view!.sub, view!.countdown, view!.clock ?? '']) {
        expect(hasWesternDigits(field)).toBe(false);
      }
    }
  });
});

// -------------------------------------------------- the shared countdown ----

describe('the live countdown does not drift from the shared helper', () => {
  /**
   * `formatCountdown` in `@avo/types` is documented as the string "the wallet
   * banner and the dashboard row share". English must therefore BE it, not
   * merely resemble it — otherwise the wallet says "1h 8m left" and the salon's
   * own dashboard says something else about the same window.
   *
   * Arabic cannot use it: it is English-only and hard-codes the word "left". So
   * `ar.happyLiveLabel` is written in `copy/ar.ts` from the design's own
   * vocabulary (س / د, design:346-355) and only the minute count is shared.
   */
  it('matches formatCountdown exactly, in English, at every minute value it can hold', () => {
    for (const minutes of [1, 9, 10, 59, 60, 61, 68, 120, 121, 599, 1439]) {
      expect(en.happyLiveLabel(minutes)).toBe(formatCountdown(minutes));
    }
  });
});
