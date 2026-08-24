/**
 * The pre-auth salon name: where it comes from, and what it does when it has
 * nothing.
 *
 * The point of this file is the negative case. `config/brand.ts` used to take the
 * name from the bundle and argue that it had to; it now takes it from the
 * `GET /salons/{id}` the app already makes at sign-in, cached against the bound
 * salon id. The build default survives as the PRE-ENROLMENT fallback, and these
 * tests are what stop that fallback from quietly becoming a fabricated name.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { adoptSalonName, brand, resetSalonNameToBuildDefault } from './brand';

afterEach(() => {
  resetSalonNameToBuildDefault();
});

describe('before anything is adopted', () => {
  /**
   * design/AVO Staff Scanner.dc.html:581 — `P.salonName || 'Amara'`. The build
   * default is the design's own, not an invention.
   */
  it('falls back to the build default', () => {
    expect(brand.salonName).toBe(process.env['EXPO_PUBLIC_AVO_SALON_NAME'] ?? 'Amara');
  });

  it('derives the initial from it — design:766', () => {
    expect(brand.initial).toBe(brand.salonName.trim().charAt(0).toUpperCase());
  });
});

describe('adopting a name the server gave us', () => {
  it('replaces the fallback', () => {
    adoptSalonName('Noor Beauty Lounge');
    expect(brand.salonName).toBe('Noor Beauty Lounge');
    expect(brand.initial).toBe('N');
  });

  /**
   * Read at RENDER time, not captured at module scope — which is the whole reason
   * the name can change while the app runs and the palette cannot. If `brand`
   * became a frozen snapshot again, this fails.
   */
  it('is live, not a snapshot taken when the module loaded', () => {
    const before = brand.salonName;
    adoptSalonName('Lila Studio');
    expect(brand.salonName).not.toBe(before);
    expect(brand.salonName).toBe('Lila Studio');
  });

  it('takes the initial from the adopted name, uppercased and trimmed', () => {
    adoptSalonName('  lila studio  ');
    expect(brand.initial).toBe('L');
  });
});

describe('what it refuses to adopt', () => {
  /**
   * A blank would paint an empty heading and an empty initial over the PIN pad.
   * The API's own CHECK constraint refuses a blank Arabic name for exactly this
   * reason; the client should not invent the failure the server prevents.
   */
  it('ignores a blank, keeping the fallback', () => {
    adoptSalonName('');
    expect(brand.salonName).toBe('Amara');
    adoptSalonName('   ');
    expect(brand.salonName).toBe('Amara');
  });

  it('ignores null and undefined — the "nothing cached" case', () => {
    adoptSalonName(null);
    expect(brand.salonName).toBe('Amara');
    adoptSalonName(undefined);
    expect(brand.salonName).toBe('Amara');
  });
});
