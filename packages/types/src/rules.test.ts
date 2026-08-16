import { describe, expect, it } from 'vitest';
import type { HappyHour } from './entities.js';
import {
  activeHappyHour,
  formatCountdown,
  isHappyHourLive,
  isInQuietHours,
  minutesRemaining,
  minutesUntilNext,
  salonClock,
  socialUrl,
  visibleSocialLinks,
} from './rules.js';

/** Kuwait local time → the UTC Date a client would actually hold. */
function kuwait(day: string, hhmm: string): Date {
  return new Date(`${day}T${hhmm}:00+03:00`);
}

const window: HappyHour = {
  id: 'hh1',
  branchId: 'all',
  days: [0, 1, 2], // Sun, Mon, Tue
  from: '16:00',
  to: '18:00',
  reward: 'x2stamp',
  on: true,
  notify: true,
};

// 2026-08-16 is a Sunday → getDay() 0.
describe('salonClock', () => {
  it('reads Kuwait local time regardless of the device timezone', () => {
    expect(salonClock(kuwait('2026-08-16', '16:30'))).toEqual({ day: 0, minutes: 990 });
  });
});

describe('isHappyHourLive — the predicate, not a flag', () => {
  it('is live inside the window on a listed day', () => {
    expect(isHappyHourLive(window, kuwait('2026-08-16', '16:30'))).toBe(true);
  });

  it('is live exactly at `from`', () => {
    expect(isHappyHourLive(window, kuwait('2026-08-16', '16:00'))).toBe(true);
  });

  it('is NOT live exactly at `to` — the interval is half-open', () => {
    expect(isHappyHourLive(window, kuwait('2026-08-16', '18:00'))).toBe(false);
  });

  it('is not live a minute before it opens', () => {
    expect(isHappyHourLive(window, kuwait('2026-08-16', '15:59'))).toBe(false);
  });

  it('is not live on an unlisted day', () => {
    // 2026-08-19 is a Wednesday → 3, not in [0,1,2]
    expect(isHappyHourLive(window, kuwait('2026-08-19', '16:30'))).toBe(false);
  });

  it('is never live when paused, even inside the window', () => {
    expect(isHappyHourLive({ ...window, on: false }, kuwait('2026-08-16', '16:30'))).toBe(false);
  });

  it('expires on its own with no push, poll or server tick', () => {
    const before = kuwait('2026-08-16', '17:59');
    const after = kuwait('2026-08-16', '18:01');
    expect(isHappyHourLive(window, before)).toBe(true);
    expect(isHappyHourLive(window, after)).toBe(false);
  });
});

describe('countdown', () => {
  it('reports minutes left inside the window', () => {
    expect(minutesRemaining(window, kuwait('2026-08-16', '17:18'))).toBe(42);
  });

  it('formats the way the wallet banner and dashboard row both show it', () => {
    expect(formatCountdown(88)).toBe('1h 28m left');
    expect(formatCountdown(42)).toBe('42m left');
    expect(formatCountdown(0)).toBe('');
  });

  it('finds the next opening later the same day', () => {
    expect(minutesUntilNext(window, kuwait('2026-08-16', '12:36'))).toBe(204); // 3h 24m
  });

  it('rolls to the next listed day once today has passed', () => {
    // Sunday 19:00 → next is Monday 16:00 = 21h = 1260 min
    expect(minutesUntilNext(window, kuwait('2026-08-16', '19:00'))).toBe(1260);
  });
});

describe('activeHappyHour', () => {
  const branchWindow: HappyHour = { ...window, id: 'hh2', branchId: 'BR-SAL', to: '17:00' };

  it('picks the window closest to ending when two overlap', () => {
    const now = kuwait('2026-08-16', '16:30');
    expect(activeHappyHour([window, branchWindow], 'BR-SAL', now)?.id).toBe('hh2');
  });

  it('ignores a window scoped to a different branch', () => {
    const now = kuwait('2026-08-16', '16:30');
    expect(activeHappyHour([branchWindow], 'BR-OTHER', now)).toBeNull();
  });

  it('returns null when nothing is open', () => {
    expect(activeHappyHour([window], 'BR-SAL', kuwait('2026-08-16', '09:00'))).toBeNull();
  });
});

describe('socialUrl — store the handle, derive the URL', () => {
  it.each([
    ['instagram', '@amara.kw', 'https://instagram.com/amara.kw'],
    ['tiktok', 'amara.kw', 'https://tiktok.com/@amara.kw'],
    ['snapchat', '@amarakw', 'https://snapchat.com/add/amarakw'],
    ['whatsapp', '+965 9912 4408', 'https://wa.me/96599124408'],
  ] as const)('%s %s → %s', (id, handle, expected) => {
    expect(socialUrl(id, handle)).toBe(expected);
  });

  it('returns null for an empty handle rather than a dead link', () => {
    expect(socialUrl('instagram', '   ')).toBeNull();
  });

  it('hides a switched-off channel without losing the handle', () => {
    const links = [
      { id: 'instagram' as const, label: 'Instagram', handle: '@amara.kw', on: true },
      { id: 'tiktok' as const, label: 'TikTok', handle: '@amara.kw', on: false },
      { id: 'snapchat' as const, label: 'Snapchat', handle: '', on: true },
    ];
    expect(visibleSocialLinks(links).map((l) => l.id)).toEqual(['instagram']);
  });
});

describe('quiet hours — wraps midnight', () => {
  it('is quiet at 23:00 with a 22:00→09:00 window', () => {
    expect(isInQuietHours(kuwait('2026-08-16', '23:00'), '22:00', '09:00')).toBe(true);
  });

  it('is quiet at 03:00 — the case a naive from<=t<to comparison gets wrong', () => {
    expect(isInQuietHours(kuwait('2026-08-16', '03:00'), '22:00', '09:00')).toBe(true);
  });

  it('is not quiet at midday', () => {
    expect(isInQuietHours(kuwait('2026-08-16', '12:00'), '22:00', '09:00')).toBe(false);
  });

  it('is not quiet exactly at the end of the window', () => {
    expect(isInQuietHours(kuwait('2026-08-16', '09:00'), '22:00', '09:00')).toBe(false);
  });
});
