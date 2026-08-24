/**
 * What a language switch has to do about LAYOUT direction, per target.
 *
 * The rule was three branches inside `LanguageProvider.setLang`, which is a
 * branch no test can reach in a workspace with no renderer — and one of those
 * branches is a guard: the web build must never ask a customer to restart an app
 * that has no restart, for a direction change that already happened on the
 * previous frame.
 *
 * `i18n/language.tsx` carries the why. This carries the decision.
 */

import { describe, expect, it } from 'vitest';
import { directionOutcome } from './direction';

const LTR = false;
const RTL = true;

describe('web', () => {
  it('is always live — `document.dir` re-lays the page out on the next frame', () => {
    expect(directionOutcome({ platform: 'web', currentIsRtl: LTR, next: 'ar' })).toBe('live');
    expect(directionOutcome({ platform: 'web', currentIsRtl: RTL, next: 'en' })).toBe('live');
  });

  /**
   * THE GUARD. `expo-updates` is a native module and `Updates.reloadAsync()` is
   * not a thing a web page should be doing to a customer mid-session. Web must
   * never reach the restart path at all — not "reaches it and no-ops".
   */
  it('never asks for a restart, in either direction, ever', () => {
    for (const currentIsRtl of [LTR, RTL]) {
      for (const next of ['en', 'ar'] as const) {
        expect(directionOutcome({ platform: 'web', currentIsRtl, next })).not.toBe(
          'restart-required',
        );
      }
    }
  });
});

describe('native', () => {
  /**
   * `I18nManager.forceRTL` writes a flag Yoga reads at bridge start. The copy
   * changes on this frame; the layout does not turn around until the app is
   * reloaded. Documented React Native behaviour, not a bug.
   */
  it('needs a restart when the direction actually changes', () => {
    expect(directionOutcome({ platform: 'ios', currentIsRtl: LTR, next: 'ar' })).toBe(
      'restart-required',
    );
    expect(directionOutcome({ platform: 'android', currentIsRtl: RTL, next: 'en' })).toBe(
      'restart-required',
    );
  });

  it('needs nothing when the direction is already right', () => {
    // Switching en→en, or arriving already mirrored. Offering a restart here
    // would be a control that reloads the app to achieve nothing.
    expect(directionOutcome({ platform: 'ios', currentIsRtl: RTL, next: 'ar' })).toBe('unchanged');
    expect(directionOutcome({ platform: 'ios', currentIsRtl: LTR, next: 'en' })).toBe('unchanged');
  });
});

describe('the invariant', () => {
  it('only ever demands a restart on a native target whose direction is wrong', () => {
    for (const platform of ['web', 'ios', 'android', 'windows']) {
      for (const currentIsRtl of [LTR, RTL]) {
        for (const next of ['en', 'ar'] as const) {
          if (directionOutcome({ platform, currentIsRtl, next }) === 'restart-required') {
            expect(platform).not.toBe('web');
            expect(currentIsRtl).toBe(next === 'en');
          }
        }
      }
    }
  });
});
