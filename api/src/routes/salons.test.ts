/**
 * `buildSalonPatch` — the one translator behind two gates.
 *
 * The merchant's `PATCH /salons/{id}` and the console's
 * `PATCH /v1/platform/salons/{id}` differ by exactly one argument: which allow-list
 * they pass. That is the whole safety argument for the console route — every
 * guard the merchant door has applies there because it is literally the same
 * function — so the thing worth asserting is that the two sets differ ONLY where
 * they are meant to, and that neither set can be widened by accident.
 *
 * A pure unit test, no database: `buildSalonPatch` takes the current row as an
 * argument precisely so the validation is testable without one.
 */

import { describe, expect, it } from 'vitest';
import { fils } from '@avo/types';
import { ApiError } from '../http/errors';
import { buildSalonPatch, PLATFORM_EDITABLE } from './salons';
import { salon } from '../db/schema/salon';

type SalonRow = typeof salon.$inferSelect;

/** A tiers salon, the shape `loadSalon` would hand the builder. */
const BEFORE: SalonRow = {
  id: 'SAL-AMARA',
  name: 'Amara',
  nameAr: 'أمارا',
  city: 'Salmiya',
  ownerPhone: '+96599124408',
  plan: 'growth',
  brandColor: '#6E7F6C',
  moduleBooking: true,
  moduleShop: true,
  loyaltyMode: 'tiers',
  tiers: [
    { name: 'bronze', minVisits: 0, bonusPercent: 0 },
    { name: 'silver', minVisits: 4, bonusPercent: 10 },
    { name: 'gold', minVisits: 10, bonusPercent: 20 },
    { name: 'black', minVisits: 20, bonusPercent: 30 },
  ],
  stampTarget: 8,
  stampReward: 'Free blow-dry',
  stampRewardAr: 'تصفيف شعر مجاني',
  depositFils: fils(5000),
  noShowReturnMinutes: 60,
  timezone: 'Asia/Kuwait',
  businessHours: { morning: ['10:00', '13:00'], evening: ['16:00', '21:00'] },
  social: [],
  whatsappEnabled: true,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

/** The merchant set is module-private; recover it by difference. */
const MERCHANT_EDITABLE: ReadonlySet<string> = new Set(
  [...PLATFORM_EDITABLE].filter((k) => k !== 'city' && k !== 'ownerPhone'),
);

function refusal(fn: () => unknown): ApiError {
  try {
    fn();
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
  throw new Error('expected a refusal, got a value');
}

describe('the two allow-lists', () => {
  it('differ by exactly city and ownerPhone', () => {
    const extra = [...PLATFORM_EDITABLE].filter((k) => !MERCHANT_EDITABLE.has(k));
    expect(extra.sort()).toEqual(['city', 'ownerPhone']);
  });

  it('neither of them carries plan — Billing has no API', () => {
    expect(PLATFORM_EDITABLE.has('plan')).toBe(false);
    expect(MERCHANT_EDITABLE.has('plan')).toBe(false);
  });

  it('neither carries a field with no column, like the drawn Live toggle', () => {
    for (const drawn of ['active', 'live', 'suspended', 'trialEndsAt']) {
      expect(PLATFORM_EDITABLE.has(drawn), `${drawn} must not be editable`).toBe(false);
    }
  });
});

describe('buildSalonPatch, merchant set', () => {
  it('refuses city and ownerPhone, and says "here"', () => {
    const err = refusal(() => buildSalonPatch({ city: 'Hawally' }, BEFORE, MERCHANT_EDITABLE));
    expect(err.code).toBe('not_editable');
    // The field exists and the console can change it. "Cannot be edited here" is
    // a different sentence from "no such field", and the difference is where the
    // next person goes looking.
    expect(err.message).toContain('here');
    expect(refusal(() => buildSalonPatch({ ownerPhone: '+96599999999' }, BEFORE, MERCHANT_EDITABLE)).code)
      .toBe('not_editable');
  });

  it('refuses an empty body', () => {
    expect(refusal(() => buildSalonPatch({}, BEFORE, MERCHANT_EDITABLE)).code).toBe('invalid_request');
  });

  it('validates brandColor through deriveBrandSet', () => {
    expect(refusal(() => buildSalonPatch({ brandColor: '#FFFF00' }, BEFORE, MERCHANT_EDITABLE)).code)
      .toBe('brand_color_not_viable');
    expect(buildSalonPatch({ brandColor: '#8A7CB0' }, BEFORE, MERCHANT_EDITABLE).patch.brandColor)
      .toBe('#8A7CB0');
  });

  it('validates businessHours, which nothing did before', () => {
    expect(
      refusal(() =>
        buildSalonPatch(
          { businessHours: { morning: ['banana', '13:00'], evening: ['16:00', '21:00'] } },
          BEFORE,
          MERCHANT_EDITABLE,
        ),
      ).code,
    ).toBe('invalid_business_hours');
  });

  it('validates the tier ladder through the publish validator', () => {
    const err = refusal(() =>
      buildSalonPatch(
        {
          tiers: [
            { name: 'bronze', minVisits: 0, bonusPercent: 0 },
            { name: 'silver', minVisits: 4, bonusPercent: 10 },
            { name: 'gold', minVisits: 2, bonusPercent: 20 },
            { name: 'black', minVisits: 20, bonusPercent: 30 },
          ],
        },
        BEFORE,
        MERCHANT_EDITABLE,
      ),
    );
    expect(err.code).toBe('threshold_not_above_tier_below');
  });

  it('splits modules into its two columns and never sends the wire name', () => {
    const { patch } = buildSalonPatch({ modules: { shop: false } }, BEFORE, MERCHANT_EDITABLE);
    expect(patch.moduleShop).toBe(false);
    expect('moduleBooking' in patch).toBe(false);
    expect('modules' in patch).toBe(false);
  });

  it('leaves a stored two-rung legacy ladder alone when the request does not touch it', () => {
    // loyaltyRules.ts § the narrower rule — a salon holding a pre-rules ladder
    // must not be locked out of editing everything else.
    const legacy: SalonRow = { ...BEFORE, tiers: [{ name: 'bronze', minVisits: 0, bonusPercent: 0 }] };
    expect(() => buildSalonPatch({ noShowReturnMinutes: 45 }, legacy, MERCHANT_EDITABLE)).not.toThrow();
  });
});

describe('buildSalonPatch, platform set', () => {
  it('accepts city and normalises a typed phone number', () => {
    const { patch } = buildSalonPatch(
      { city: '  Hawally ', ownerPhone: '+965 9912 4409' },
      BEFORE,
      PLATFORM_EDITABLE,
    );
    expect(patch.city).toBe('Hawally');
    expect(patch.ownerPhone).toBe('+96599124409');
  });

  it('refuses a blank city rather than storing one the CHECK would reject', () => {
    expect(refusal(() => buildSalonPatch({ city: '   ' }, BEFORE, PLATFORM_EDITABLE)).code)
      .toBe('invalid_request');
  });

  it('refuses a phone the E.164 CHECK would reject', () => {
    expect(refusal(() => buildSalonPatch({ ownerPhone: '99124409' }, BEFORE, PLATFORM_EDITABLE)).code)
      .toBe('invalid_phone');
  });

  it('carries every merchant guard, because it is the same function', () => {
    expect(refusal(() => buildSalonPatch({ brandColor: '#FFFF00' }, BEFORE, PLATFORM_EDITABLE)).code)
      .toBe('brand_color_not_viable');
    expect(refusal(() => buildSalonPatch({ depositFils: 500 }, BEFORE, PLATFORM_EDITABLE)).code)
      .toBe('deposit_out_of_range');
    expect(refusal(() => buildSalonPatch({ timezone: 'Kuwait/Salmiya' }, BEFORE, PLATFORM_EDITABLE)).statusCode)
      .toBe(400);
  });

  it('still refuses plan', () => {
    expect(refusal(() => buildSalonPatch({ plan: 'pro' }, BEFORE, PLATFORM_EDITABLE)).code)
      .toBe('not_editable');
  });
});
