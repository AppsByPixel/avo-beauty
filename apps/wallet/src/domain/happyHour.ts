/**
 * The happy-hour banner: which window, live or next, and the countdown.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THERE IS NO `live` FLAG, AND THE CLOCK IS THE SALON'S.
 *
 * `isHappyHourLive`, `minutesRemaining` and `minutesUntilNext` come from
 * `@avo/types` — the same three functions `POST /charges` runs to decide whether
 * a window's earning multiplier applies. That is the whole reason they live in a
 * shared package: a banner resolved by a different rule than the charge is a
 * customer told she is earning double while the server disagrees.
 *
 * `design/avo-promotions.js:1133-1151` resolves the same banner against
 * `new Date().getHours()`. That is the host clock, and porting it would be wrong
 * in a way that is invisible on a Kuwaiti developer's laptop and invisible on
 * this one for the opposite reason — it runs PKT, two hours AHEAD, so a
 * host-clock banner opens Amara's 16:00 window at 14:00 Kuwait time. The salon's
 * IANA zone is on `Salon.timezone` precisely so this is not guesswork; see the
 * field's own docstring, which calls the same mistake "a money bug, not a
 * display one".
 *
 * KNOWN LIMITATION, DELIBERATE, DO NOT WIDEN HERE. An overnight window
 * (23:00–01:00) cannot be expressed: `from <= now < to` is a half-open interval
 * on one day and the schema CHECK agrees with it. DECISIONS.md records that as a
 * deferral with a reversal path. This module renders what the rules can express
 * and invents nothing to cover what they cannot.
 * ═════════════════════════════════════════════════════════════════════════════
 */

import {
  isHappyHourLive,
  minutesRemaining,
  minutesUntilNext,
  salonClock,
  SALON_UTC_OFFSET_MINUTES,
  type HappyHour,
  type Language,
  type PromotionSet,
} from '@avo/types';
import type { Copy } from '../copy/types';
import { branchName, type Named } from './names';

/** A branch as the banner needs it: an id and the two name fields. */
export type BannerBranch = Named & { id: string };

export interface HappyBanner {
  /** `live` gets the tinted, pulsing treatment; `next` the muted one. design:201/217. */
  kind: 'live' | 'next';
  /** The window this came from, so a test can name it and React can key it. */
  id: string;
  /** "Happy hour · Double visit credit". */
  title: string;
  /** "All branches · until 18:00" / "Salmiya · today 16:00–18:00". */
  sub: string;
  /** "1h 28m left" / "in 3h 24m". */
  countdown: string;
  /** "now 16:32" — the salon's wall clock. Live banner only; null on `next`. */
  clock: string | null;
}

/** Hours and whole minutes. Shared with `copy/en.ts` and `copy/ar.ts`. */
export function durationParts(totalMinutes: number): { hours: number; minutes: number } {
  const safe = Math.max(0, Math.floor(totalMinutes));
  return { hours: Math.floor(safe / 60), minutes: safe % 60 };
}

/**
 * The salon zone's offset from UTC, in minutes, at this instant.
 *
 * `isHappyHourLive` takes an OFFSET, not a zone — `SALON_UTC_OFFSET_MINUTES` is
 * a constant 180 with the comment "Kuwait is UTC+3 year-round". That is correct
 * for Kuwait and wrong for the first salon outside it, so rather than accept the
 * default this derives the offset from `Salon.timezone` and passes it in. Intl
 * does the zone arithmetic, so a zone with DST resolves correctly on both sides
 * of its transitions without this module knowing any zone rules.
 *
 * An unusable zone id falls back to Kuwait rather than to the host: the host
 * clock is the one value that is certainly not the salon's.
 */
export function salonOffsetMinutes(timeZone: string, at: Date): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(at);
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
    // Intl renders midnight as hour "24" in some engines; Date.UTC absorbs it.
    const asUtc = Date.UTC(
      get('year'),
      get('month') - 1,
      get('day'),
      get('hour'),
      get('minute'),
      get('second'),
    );
    if (Number.isNaN(asUtc)) return SALON_UTC_OFFSET_MINUTES;
    // Seconds are already matched on both sides, so this divides exactly.
    return Math.round((asUtc - at.getTime()) / 60_000);
  } catch {
    return SALON_UTC_OFFSET_MINUTES;
  }
}

/** "16:05" from minutes-since-salon-midnight. */
function hhmm(minutesSinceMidnight: number): string {
  const h = Math.floor(minutesSinceMidnight / 60) % 24;
  const m = minutesSinceMidnight % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * A window's branch, named in the reading language.
 *
 * `'all'` becomes "All branches"; a branch the salon read carries becomes its
 * name; anything else falls back to the raw id. Not blank and not "All
 * branches" — either would misstate where the reward applies, and a customer
 * walking to the wrong branch for a double-stamp hour is the failure.
 */
function branchLabel(branchId: string, branches: BannerBranch[], lang: Language, copy: Copy) {
  if (branchId === 'all') return copy.happyAllBranches;
  const branch = branches.find((b) => b.id === branchId);
  return branch ? branchName(branch, lang) : branchId;
}

/**
 * The banner, or null.
 *
 * `promotions` is nullable because the promotions read is the one part of the
 * Home snapshot the screen can render without — see `useWalletHome`. Null and
 * "no windows published" produce the same answer here on purpose: neither is
 * permission to put a claim about earning on the screen.
 */
export function happyBanner(
  promotions: PromotionSet | null,
  branches: BannerBranch[],
  timeZone: string,
  now: Date,
  lang: Language,
  copy: Copy,
): HappyBanner | null {
  if (!promotions || promotions.happy.length === 0) return null;

  const offset = salonOffsetMinutes(timeZone, now);
  /**
   * NO `.filter((w) => w.on)` HERE, DELIBERATELY, AND IT WAS HERE UNTIL IT WAS
   * PROVEN NOT TO MATTER.
   *
   * `isHappyHourLive` opens with `if (!hh.on) return false` and
   * `minutesUntilNext` with `if (!hh.on || hh.days.length === 0) return null`.
   * Deleting the filter and re-running `happyHour.test.ts` left all 23 green,
   * which is the evidence that it was redundant — and a redundant copy of a
   * shared rule is the thing this whole module exists to avoid. One
   * implementation of "is this window on", in `packages/types`, consulted by the
   * wallet and by `POST /charges` alike.
   */
  const windows = promotions.happy;

  // --- live: the window closing soonest, matching activeHappyHour's tie-break.
  // Not `activeHappyHour` itself: it filters to ONE branch, and the wallet is
  // not at a branch — the design shows any salon's window and names its branch
  // (design:1137).
  let live: HappyHour | null = null;
  let liveLeft = Infinity;
  for (const w of windows) {
    if (!isHappyHourLive(w, now, offset)) continue;
    const left = minutesRemaining(w, now, offset);
    if (left < liveLeft) {
      live = w;
      liveLeft = left;
    }
  }

  const salonNow = salonClock(now, offset);

  if (live) {
    return {
      kind: 'live',
      id: live.id,
      title: copy.happyLiveTitle(copy.happyReward[live.reward]),
      sub: copy.happyLiveSub(branchLabel(live.branchId, branches, lang, copy), live.to),
      countdown: copy.happyLiveLabel(liveLeft),
      clock: copy.happyClock(hhmm(salonNow.minutes)),
    };
  }

  // --- next: the window opening soonest. design:1141, `!live && !!nextW`.
  let next: HappyHour | null = null;
  let nextIn = Infinity;
  for (const w of windows) {
    const until = minutesUntilNext(w, now, offset);
    if (until === null || until >= nextIn) continue;
    next = w;
    nextIn = until;
  }
  if (!next) return null;

  /**
   * Which weekday the next occurrence lands on, derived from the shared helper
   * rather than by repeating its 8-day search. `minutesUntilNext` returns
   * `ahead * 1440 + from - nowMinutes`, so adding the current salon minute back
   * and dividing recovers `ahead` exactly.
   */
  const daysAhead = Math.floor((nextIn + salonNow.minutes) / 1440);

  return {
    kind: 'next',
    id: next.id,
    title: copy.happyNextTitle(copy.happyReward[next.reward]),
    sub: copy.happyNextSub(
      branchLabel(next.branchId, branches, lang, copy),
      daysAhead === 0 ? null : (salonNow.day + daysAhead) % 7,
      next.from,
      next.to,
    ),
    countdown: copy.happyNextLabel(nextIn),
    clock: null,
  };
}
