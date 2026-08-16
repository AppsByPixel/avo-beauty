/**
 * Shared rules that MUST resolve identically on every surface.
 *
 * These are the places where a client and the server disagreeing produces a real
 * bug — a stale happy-hour banner causing a wrong charge, or an edited social
 * handle leaving a dead icon in a wallet. One implementation, imported by all
 * four surfaces and by the API.
 */

import type { HappyHour, RewardKey, SocialLink } from './entities.js';

// -------------------------------------------------------------- salon clock --

/** Kuwait is UTC+3 year-round. No DST, so a fixed offset is correct, not a shortcut. */
export const SALON_UTC_OFFSET_MINUTES = 180;

export interface SalonClock {
  /** 0 = Sunday, matching JS getDay() and the `days` array in a HappyHour. */
  day: number;
  /** Minutes since salon-local midnight. */
  minutes: number;
}

export function salonClock(now: Date, offsetMinutes = SALON_UTC_OFFSET_MINUTES): SalonClock {
  const shifted = new Date(now.getTime() + offsetMinutes * 60_000);
  return {
    day: shifted.getUTCDay(),
    minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
  };
}

/** "16:45" → 1005. */
export function hhmmToMinutes(hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) throw new TypeError(`Not a HH:MM time: ${hhmm}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

// -------------------------------------------------------------- happy hour --

/**
 * THE predicate. api-contract.md § Promotion set:
 *
 *   "There is no `live` flag. A window is live if and only if
 *    days.includes(now.getDay()) && from <= now < to in salon-local time."
 *
 * Both clients resolve this every second and render a real countdown; the banner
 * disappears on its own at `to` with no push, no poll and no server tick. The
 * server runs the SAME predicate to gate the earning multiplier at charge time,
 * so a client showing a stale banner cannot produce a wrong charge.
 *
 * Note the half-open interval: `from <= now < to`. A charge landing exactly on
 * `to` is outside the window.
 */
export function isHappyHourLive(hh: HappyHour, now: Date, offsetMinutes?: number): boolean {
  if (!hh.on) return false;
  const { day, minutes } = salonClock(now, offsetMinutes);
  if (!hh.days.includes(day)) return false;
  return minutes >= hhmmToMinutes(hh.from) && minutes < hhmmToMinutes(hh.to);
}

/** Minutes remaining in a live window. 0 if it isn't live. */
export function minutesRemaining(hh: HappyHour, now: Date, offsetMinutes?: number): number {
  if (!isHappyHourLive(hh, now, offsetMinutes)) return 0;
  const { minutes } = salonClock(now, offsetMinutes);
  return hhmmToMinutes(hh.to) - minutes;
}

/** "1h 28m left" / "42m left" — the wallet banner and the dashboard row share this. */
export function formatCountdown(mins: number): string {
  if (mins <= 0) return '';
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h ${m}m left` : `${m}m left`;
}

/** Minutes until the next occurrence of a window, searching up to 7 days out. */
export function minutesUntilNext(
  hh: HappyHour,
  now: Date,
  offsetMinutes?: number,
): number | null {
  if (!hh.on || hh.days.length === 0) return null;
  const { day, minutes } = salonClock(now, offsetMinutes);
  const from = hhmmToMinutes(hh.from);

  for (let ahead = 0; ahead < 8; ahead++) {
    const d = (day + ahead) % 7;
    if (!hh.days.includes(d)) continue;
    if (ahead === 0 && minutes >= from) continue; // already started or passed today
    return ahead * 1440 + from - minutes;
  }
  return null;
}

/** The live window with the least time left, or null. */
export function activeHappyHour(
  windows: HappyHour[],
  branchId: string,
  now: Date,
  offsetMinutes?: number,
): HappyHour | null {
  const live = windows
    .filter((w) => w.branchId === 'all' || w.branchId === branchId)
    .filter((w) => isHappyHourLive(w, now, offsetMinutes));
  if (live.length === 0) return null;
  return live.reduce((best, w) =>
    minutesRemaining(w, now, offsetMinutes) < minutesRemaining(best, now, offsetMinutes) ? w : best,
  );
}

export interface EarningEffect {
  visitMultiplier: number;
  stampMultiplier: number;
  /** Extra top-up bonus percentage points on top of the tier bonus. */
  topupBonusPercent: number;
  /** Flat wallet credit in fils. */
  creditFils: number;
}

const NO_EFFECT: EarningEffect = {
  visitMultiplier: 1,
  stampMultiplier: 1,
  topupBonusPercent: 0,
  creditFils: 0,
};

export function rewardEffect(reward: RewardKey): EarningEffect {
  switch (reward) {
    case 'x2stamp':
      return { ...NO_EFFECT, stampMultiplier: 2 };
    case 'x3stamp':
      return { ...NO_EFFECT, stampMultiplier: 3 };
    case 'x2visit':
      return { ...NO_EFFECT, visitMultiplier: 2 };
    case 'topup10':
      return { ...NO_EFFECT, topupBonusPercent: 10 };
    case 'topup20':
      return { ...NO_EFFECT, topupBonusPercent: 20 };
    case 'credit3':
      return { ...NO_EFFECT, creditFils: 3000 };
  }
}

// ------------------------------------------------------------ social links --

/**
 * api-contract.md § SocialLink: "Store the handle, derive the URL. Never persist
 * a URL: a salon that edits its handle would leave the icon pointing at a dead
 * profile."
 */
export function socialUrl(id: SocialLink['id'], handle: string): string | null {
  const bare = handle.trim().replace(/^@/, '');
  if (!bare) return null;
  switch (id) {
    case 'instagram':
      return `https://instagram.com/${bare}`;
    case 'tiktok':
      return `https://tiktok.com/@${bare}`;
    case 'snapchat':
      return `https://snapchat.com/add/${bare}`;
    case 'whatsapp':
      return `https://wa.me/${bare.replace(/\D/g, '')}`;
  }
}

/** The wallet renders only links that are on AND have a handle. */
export function visibleSocialLinks(
  links: SocialLink[],
): Array<SocialLink & { url: string }> {
  return links.flatMap((l) => {
    if (!l.on) return [];
    const url = socialUrl(l.id, l.handle);
    return url ? [{ ...l, url }] : [];
  });
}

// ------------------------------------------------------------- quiet hours --

/**
 * Quiet hours wrap midnight (default 22:00 → 09:00), so a naive `from <= t < to`
 * comparison is wrong here in a way it is not for happy hours.
 *
 * Enforced again AT SEND, not at approval — an approved campaign that would land
 * inside quiet hours is HELD and reported, never silently dropped.
 */
export function isInQuietHours(
  now: Date,
  quietFrom: string,
  quietTo: string,
  offsetMinutes?: number,
): boolean {
  const { minutes } = salonClock(now, offsetMinutes);
  const from = hhmmToMinutes(quietFrom);
  const to = hhmmToMinutes(quietTo);
  return from <= to ? minutes >= from && minutes < to : minutes >= from || minutes < to;
}
