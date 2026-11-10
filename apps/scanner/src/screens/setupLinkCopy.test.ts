/**
 * The PIN screen's setup link names the screen it opens.
 *
 * FOUND IN THE LIVE RUN, 2026-11-10 (phase 2 of DECISIONS.md § "Staff phone
 * pairing, phone sign-in, and a truthful receipt line — Aftab, 2026-11-10").
 * On a paired phone the only way back into setup is the muted link under the
 * PIN pad. It read "Set up this device" — the title of the OLD typed form
 * (EnrolScreen), the very screen Aftab hit and ruled against — and it opened a
 * screen titled "Set up this phone", whose own muted "Set up manually" link
 * then led to a screen titled "Set up this device". A manager talking a stylist
 * through re-pairing ("tap Set up this device") was naming the wrong screen,
 * and a stylist who did so landed one tap away from the form the ruling retired.
 *
 * Both strings are INVENTED (no design source), so this is lane B's wording to
 * get right rather than design copy to keep verbatim. The link now carries the
 * pairing screen's title, and the old form keeps its own name — two names for
 * two screens, each the name of the screen it opens.
 *
 * Checked on the source as well as on the dictionary: the scanner's vitest is
 * node-only (vitest.config.ts), so the wiring is asserted the way
 * receiptCopy.test.ts asserts it — by what the screen file renders.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { copy } from '../copy/en';

const read = (name: string) => readFileSync(join(__dirname, name), 'utf8');

describe("the PIN screen's link into setup", () => {
  it('is the title of the screen it opens', () => {
    expect(copy.setupFromSignIn).toBe(copy.setupTitle);
    expect(copy.setupFromSignIn).toBe('Set up this phone');
  });

  it('is not the name of the retired typed form', () => {
    expect(copy.setupFromSignIn).not.toBe(copy.enrolTitle);
  });

  it('is the label PinScreen renders on its setup link', () => {
    const src = read('PinScreen.tsx');
    expect(src).toContain('copy.setupFromSignIn');
    // The old key is gone, so nothing can quietly go on rendering it.
    expect(src).not.toContain('copy.enrolChange');
    expect('enrolChange' in copy).toBe(false);
  });

  it('opens the pairing setup, not the typed form', () => {
    // PinScreen hands the link to `onReconfigure`; App.tsx answers it by showing
    // SetupFlow, which starts on SetupScreen ("Set up this phone") — never on
    // EnrolScreen, which is reachable only from SetupScreen's "Set up manually".
    expect(read('PinScreen.tsx')).toMatch(
      /label=\{copy\.setupFromSignIn\}\s+onPress=\{onReconfigure\}/,
    );
    const app = readFileSync(join(__dirname, '..', '..', 'App.tsx'), 'utf8');
    expect(app).toMatch(/onReconfigure=\{\(\) => setSettingUp\(true\)\}/);
    expect(read('SetupFlow.tsx')).toMatch(/const START: Step = \{ name: 'setup'/);
  });
});
