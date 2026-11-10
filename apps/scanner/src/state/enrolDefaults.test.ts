/**
 * The seeded pilot's ids pre-fill the manual form on a development build only.
 *
 * DECISIONS.md § "Staff phone pairing, phone sign-in, and a truthful receipt
 * line — Aftab, 2026-11-10": "the old typed form stays only as a muted 'Set up
 * manually' path for the seeded pilot, with its pre-filled defaults kept under
 * `__DEV__` only".
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { enrolDefaults, SEEDED_PILOT } from './enrolDefaults';

describe('the manual form pre-fill', () => {
  it('is the seeded pilot on a development build', () => {
    expect(enrolDefaults(true)).toEqual({ salonId: 'SAL-AMARA', handle: '', deviceId: 'DEV-SCANNER-01' });
  });

  it('is three empty fields on a release build — no demo salon in a real phone', () => {
    const release = enrolDefaults(false);
    expect(release).toEqual({ salonId: '', handle: '', deviceId: '' });
    expect(JSON.stringify(release)).not.toContain('SAL-AMARA');
    expect(JSON.stringify(release)).not.toContain('DEV-SCANNER-01');
  });

  it('hands out a copy, so a form cannot edit the constant', () => {
    const a = enrolDefaults(true);
    a.salonId = 'changed';
    expect(SEEDED_PILOT.salonId).toBe('SAL-AMARA');
    expect(enrolDefaults(true).salonId).toBe('SAL-AMARA');
  });

  /**
   * `./device` cannot be imported here (AsyncStorage is React Native), so the
   * wiring is read off the source: the exported default is decided by `__DEV__`
   * and nothing else, and the pilot ids are not restated there.
   */
  it('is what the device module exports, decided by __DEV__', () => {
    const src = readFileSync(join(__dirname, 'device.ts'), 'utf8');
    expect(src).toContain('export const ENROL_DEFAULTS: DeviceBinding = enrolDefaults(__DEV__);');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(code).not.toContain("'SAL-AMARA'");
    expect(code).not.toContain("'DEV-SCANNER-01'");
  });

  it('is the only pre-fill the manual form reads', () => {
    const enrol = readFileSync(join(__dirname, '..', 'screens', 'EnrolScreen.tsx'), 'utf8');
    expect(enrol).toContain('initial ?? ENROL_DEFAULTS');
    expect(enrol.replace(/\/\*[\s\S]*?\*\//g, '')).not.toContain('SAL-AMARA');
  });
});
