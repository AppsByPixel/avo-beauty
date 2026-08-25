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

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { directionEffect, directionOutcome, isRtl } from './direction';

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

/**
 * The persisted flag, as opposed to the notice.
 *
 * These exist because the app was DRIVEN on an iOS dev client and the sequence
 * below left `RCTI18nUtil_forceRTL: false` in the app's own preferences while
 * the customer was looking at a mirrored Arabic screen with no notice on it.
 * See `direction.ts § directionEffect` for the trace.
 */
describe('what the switch writes', () => {
  it('never touches I18nManager on web, in either direction', () => {
    for (const currentIsRtl of [LTR, RTL]) {
      for (const next of ['en', 'ar'] as const) {
        expect(directionEffect({ platform: 'web', currentIsRtl, next })).toEqual({
          flag: null,
          pendingRestart: false,
        });
      }
    }
  });

  it('writes the flag AND owes a restart when the direction actually changes', () => {
    expect(directionEffect({ platform: 'ios', currentIsRtl: LTR, next: 'ar' })).toEqual({
      flag: true,
      pendingRestart: true,
    });
    expect(directionEffect({ platform: 'android', currentIsRtl: RTL, next: 'en' })).toEqual({
      flag: false,
      pendingRestart: true,
    });
  });

  /**
   * THE REGRESSION. 'unchanged' means "no restart owed", never "no flag owed" —
   * the running layout and the persisted flag are different facts.
   */
  it('still writes the flag when no restart is owed', () => {
    expect(directionEffect({ platform: 'ios', currentIsRtl: RTL, next: 'ar' })).toEqual({
      flag: true,
      pendingRestart: false,
    });
    expect(directionEffect({ platform: 'ios', currentIsRtl: LTR, next: 'en' })).toEqual({
      flag: false,
      pendingRestart: false,
    });
  });

  /**
   * The driven sequence, as a test. A mirrored Arabic app, switched to English
   * and straight back, must not be left persisting `false` — she chose Arabic
   * and the next launch has to agree with her.
   */
  it('leaves the flag agreeing with her choice after she switches away and back', () => {
    // Yoga is laying out RTL for the whole sequence: it is fixed at bridge start
    // and neither tap reloads the app.
    const layoutInForce = RTL;

    const away = directionEffect({ platform: 'ios', currentIsRtl: layoutInForce, next: 'en' });
    expect(away).toEqual({ flag: false, pendingRestart: true });

    const back = directionEffect({ platform: 'ios', currentIsRtl: layoutInForce, next: 'ar' });
    // The flag she is left with, NOT the notice, is what the next launch reads.
    expect(back.flag).toBe(true);
    // And no restart is owed, because the layout on screen is already right.
    expect(back.pendingRestart).toBe(false);
  });

  it('always persists exactly the direction of the language chosen, on native', () => {
    for (const platform of ['ios', 'android']) {
      for (const currentIsRtl of [LTR, RTL]) {
        for (const next of ['en', 'ar'] as const) {
          expect(directionEffect({ platform, currentIsRtl, next }).flag).toBe(isRtl(next));
        }
      }
    }
  });
});

/**
 * THE PROVIDER ACTUALLY USES IT — asserted structurally, because this workspace
 * has no renderer.
 *
 * `directionEffect` was landed with the five tests above and NOT wired in: it sat
 * exported, green, and unreachable while `LanguageProvider` went on gating the
 * flag write on `directionOutcome`. Passing tests for a function nothing calls is
 * the most expensive kind of green, because it reads exactly like a fixed bug.
 *
 * Scanning source rather than importing follows `theme/brandBootOrder.test.ts`,
 * for the same reason: the thing being measured is which module the provider
 * reaches for, and `language.tsx` cannot be imported here anyway — it is a `.tsx`
 * carrying a React context, which is why `direction.ts` exists as a separate
 * module in the first place.
 */
describe('the provider writes the flag through directionEffect', () => {
  /**
   * COMMENTS ARE STRIPPED BEFORE ANYTHING IS ASSERTED, and the first version of
   * this file did not strip them and failed for it. `language.tsx`'s header
   * explains the mechanism in prose — "`I18nManager.forceRTL()` writes a native
   * flag" — which a call-site scan happily read as a call with no arguments. A
   * structural test that cannot tell code from the paragraph describing it will
   * eventually fail on a comment edit, and whoever hits that will fix the
   * comment rather than the code.
   */
  const provider = readFileSync(join(__dirname, 'language.tsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');

  it('imports directionEffect', () => {
    expect(provider).toMatch(/import\s*{[^}]*\bdirectionEffect\b[^}]*}\s*from\s*'\.\/direction'/);
  });

  /**
   * Both decisions — the switch and the launch-time reconcile — go through the
   * one function. `directionOutcome` is still exported and still tested above;
   * it is simply not what the provider asks, because its three-way answer is the
   * thing that got misread as "nothing to write".
   */
  it('asks directionEffect and not directionOutcome', () => {
    expect(provider).not.toMatch(/\bdirectionOutcome\b/);
  });

  /**
   * THE REGRESSION, in the shape a diff would reintroduce it. `forceRTL(isRtl(x))`
   * is the old form: it can only appear inside a branch that already decided the
   * direction changed, which is the branch that skipped the write. The flag must
   * come from the effect, so the write is unconditional on native.
   */
  it('passes the effect flag to forceRTL, never a recomputed isRtl', () => {
    expect(provider).not.toMatch(/forceRTL\s*\(\s*isRtl/);
    const calls = [...provider.matchAll(/I18nManager\.forceRTL\s*\(([^)]*)\)/g)].map((m) => m[1]?.trim());
    expect(calls.length).toBeGreaterThan(0);
    for (const arg of calls) expect(arg).toMatch(/\.flag$/);
  });

  /** And the write is guarded on `flag !== null`, which is the web guard. */
  it('guards the write on the null flag rather than on the platform', () => {
    expect(provider).toMatch(/\.flag\s*!==\s*null/);
  });
});
