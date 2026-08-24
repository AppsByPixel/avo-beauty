/**
 * The onboarding boundary, without a database.
 *
 * Two claims made in comments elsewhere are measured here, because a comment
 * asserting a guard is worth nothing next to a test that fails when the guard
 * stops holding — and this build has now paid three times for exactly that gap.
 *
 * 1. THE DEFAULT TIER LADDER IS VALID. `parseLoyaltyConfig` returns
 *    `current.tiers` UNTOUCHED on one path — the request supplies no `tiers` and
 *    does not switch the mechanic — and for this endpoint that path is the
 *    wizard's own default. So `DEFAULT_LOYALTY.tiers` would be the only ladder
 *    in the system that reaches a database column without passing the publish
 *    validator. This file runs it through `parseTiers` explicitly. It is also the
 *    guard against a well-meaning edit: someone giving Bronze a 5% bonus "so new
 *    customers get something" is refused here rather than at a salon's first
 *    top-up.
 *
 * 2. THE BRAND-COLOUR REFUSAL IS THE DERIVER'S OWN. Non-negotiable #9's second
 *    clause was unimplemented, and the fix is only worth having if it refuses the
 *    right hexes and accepts the right ones. The cases below are the design's
 *    three swatches (which must all pass, or the wizard cannot be completed as
 *    drawn) and the two `packages/tokens`' own suite names as unusable.
 */

import { describe, expect, it } from 'vitest';
import { ApiError } from '../http/errors';
import { parseBrandColor } from './brandColor';
import { parseTiers } from './loyaltyRules';
import { DEFAULT_LOYALTY, parseOnboardInput } from './salonOnboarding';
import { fils } from '@avo/types';

/** The platform's Controls default, as `readPlatformSettings` would supply it. */
const PLATFORM_DEFAULT_DEPOSIT = fils(5000);

/** The three fields the design's own `wizReady` gates Continue on. */
const MINIMUM_BODY = {
  name: 'Amara',
  city: 'Salmiya',
  ownerPhone: '+96599124408',
};

function refusal(fn: () => unknown): ApiError {
  try {
    fn();
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
  throw new Error('expected a refusal, got a value');
}

describe('the default tier ladder', () => {
  it('passes the publish validator it would otherwise bypass', () => {
    expect(() => parseTiers(DEFAULT_LOYALTY.tiers)).not.toThrow();
  });

  it('is the ladder the design draws', () => {
    // `AVO Owner Console.dc.html` § wizNext, and its own step-3 copy: "Bronze /
    // Silver / Gold / Black start at 0, 4, 10 and 20 visits with 0, 10, 20 and
    // 30% top-up bonus."
    expect(DEFAULT_LOYALTY.tiers).toEqual([
      { name: 'bronze', minVisits: 0, bonusPercent: 0 },
      { name: 'silver', minVisits: 4, bonusPercent: 10 },
      { name: 'gold', minVisits: 10, bonusPercent: 20 },
      { name: 'black', minVisits: 20, bonusPercent: 30 },
    ]);
  });

  it('is what a body that mentions no loyalty fields resolves to', () => {
    const input = parseOnboardInput({ ...MINIMUM_BODY }, PLATFORM_DEFAULT_DEPOSIT);
    expect(input.loyalty.mode).toBe('tiers');
    expect(input.loyalty.tiers).toEqual(DEFAULT_LOYALTY.tiers);
    // "8 stamps for a free blow-dry" — kept, not cleared, so a salon that
    // switches mechanic later finds a card waiting. loyaltyRules.ts § the same.
    expect(input.loyalty.stampTarget).toBe(8);
  });

  it('refuses an invalid ladder through this door too', () => {
    const err = refusal(() =>
      parseOnboardInput(
        {
          ...MINIMUM_BODY,
          tiers: [
            { name: 'bronze', minVisits: 0, bonusPercent: 5 },
            { name: 'silver', minVisits: 4, bonusPercent: 10 },
            { name: 'gold', minVisits: 10, bonusPercent: 20 },
            { name: 'black', minVisits: 20, bonusPercent: 30 },
          ],
        },
        PLATFORM_DEFAULT_DEPOSIT,
      ),
    );
    expect(err.code).toBe('bronze_is_locked');
  });
});

describe('brandColor, non-negotiable #9 second clause', () => {
  // The design's three swatches in the wizard's step 3. If any of these were
  // refused, the drawn flow could not be completed.
  it.each(['#6E7F6C', '#B08D8D', '#8A7CB0'])('accepts the drawn swatch %s', (hex) => {
    expect(parseBrandColor(hex)).toBe(hex);
  });

  it.each(['#FFFF00', '#FFFFFF'])('refuses %s with the deriver’s own reason', (hex) => {
    const err = refusal(() => parseBrandColor(hex));
    expect(err.statusCode).toBe(400);
    expect(err.code).toBe('brand_color_not_viable');
    // Not a message restated here — the deriver writes it, and it names the hex,
    // the ratio reached and what to do instead.
    expect(err.message).toContain(hex);
    expect(err.message).toContain('brand colour');
    expect(err.details.bestContrast).toBeLessThan(4.5);
  });

  it('refuses a non-hex before any contrast maths runs', () => {
    // `deriveBrandSet` normalises by prepending '#' and upper-casing and does not
    // validate, so "blue" would reach `hexToRgb` as NaN and produce a rejection
    // whose numbers mean nothing. The shape check has to come first.
    const err = refusal(() => parseBrandColor('blue'));
    expect(err.code).toBe('invalid_brand_color');
  });

  it('is applied by the create boundary, not only by PATCH', () => {
    const err = refusal(() =>
      parseOnboardInput({ ...MINIMUM_BODY, brandColor: '#FFFF00' }, PLATFORM_DEFAULT_DEPOSIT),
    );
    expect(err.code).toBe('brand_color_not_viable');
  });
});

describe('the onboarding body', () => {
  it('requires the three fields the wizard requires', () => {
    expect(refusal(() => parseOnboardInput({ city: 'Salmiya', ownerPhone: '+96599124408' }, PLATFORM_DEFAULT_DEPOSIT)).code)
      .toBe('invalid_request');
    expect(refusal(() => parseOnboardInput({ name: 'Amara', ownerPhone: '+96599124408' }, PLATFORM_DEFAULT_DEPOSIT)).code)
      .toBe('invalid_request');
    expect(refusal(() => parseOnboardInput({ name: 'Amara', city: 'Salmiya' }, PLATFORM_DEFAULT_DEPOSIT)).code)
      .toBe('invalid_phone');
  });

  it('defaults the deposit to the platform Controls value, not to a constant', () => {
    const input = parseOnboardInput({ ...MINIMUM_BODY }, fils(7000));
    expect(input.depositFils).toBe(7000);
  });

  it('refuses a fractional deposit by name rather than at the column', () => {
    const err = refusal(() =>
      parseOnboardInput({ ...MINIMUM_BODY, depositFils: 5500.5 }, PLATFORM_DEFAULT_DEPOSIT),
    );
    expect(err.code).toBe('invalid_amount');
  });

  it('refuses a deposit outside the 1–10 KD range the design draws', () => {
    expect(
      refusal(() => parseOnboardInput({ ...MINIMUM_BODY, depositFils: 500 }, PLATFORM_DEFAULT_DEPOSIT)).code,
    ).toBe('deposit_out_of_range');
    expect(
      refusal(() => parseOnboardInput({ ...MINIMUM_BODY, depositFils: 20000 }, PLATFORM_DEFAULT_DEPOSIT)).code,
    ).toBe('deposit_out_of_range');
  });

  it('accepts the plan label the design renders, lower-cased', () => {
    // `wPlan: 'Growth'` in the design's own state.
    expect(parseOnboardInput({ ...MINIMUM_BODY, plan: 'Growth' }, PLATFORM_DEFAULT_DEPOSIT).plan)
      .toBe('growth');
    expect(refusal(() => parseOnboardInput({ ...MINIMUM_BODY, plan: 'enterprise' }, PLATFORM_DEFAULT_DEPOSIT)).code)
      .toBe('invalid_plan');
  });

  it('starts both modules off, and honours a partial object', () => {
    const bare = parseOnboardInput({ ...MINIMUM_BODY }, PLATFORM_DEFAULT_DEPOSIT);
    expect(bare.moduleBooking).toBe(false);
    expect(bare.moduleShop).toBe(false);

    const one = parseOnboardInput(
      { ...MINIMUM_BODY, modules: { booking: true } },
      PLATFORM_DEFAULT_DEPOSIT,
    );
    expect(one.moduleBooking).toBe(true);
    expect(one.moduleShop).toBe(false);
  });

  it('names the first branch after the city, as the wizard does', () => {
    expect(parseOnboardInput({ ...MINIMUM_BODY }, PLATFORM_DEFAULT_DEPOSIT).branchName)
      .toBe('Salmiya');
  });

  it('refuses a field it does not accept rather than dropping it', () => {
    // The design draws a Live toggle and there is no such column. A console that
    // sent `active: true` must not be told it worked.
    const err = refusal(() =>
      parseOnboardInput({ ...MINIMUM_BODY, active: true }, PLATFORM_DEFAULT_DEPOSIT),
    );
    expect(err.code).toBe('not_settable_here');
    expect(err.message).toContain('active');
  });

  it('never accepts a password, on #6', () => {
    const err = refusal(() =>
      parseOnboardInput({ ...MINIMUM_BODY, ownerPassword: 'hunter2' }, PLATFORM_DEFAULT_DEPOSIT),
    );
    expect(err.code).toBe('not_settable_here');
  });

  it('validates the timezone rather than storing a string', () => {
    expect(refusal(() => parseOnboardInput({ ...MINIMUM_BODY, timezone: 'Kuwait/Salmiya' }, PLATFORM_DEFAULT_DEPOSIT)).statusCode)
      .toBe(400);
    expect(parseOnboardInput({ ...MINIMUM_BODY }, PLATFORM_DEFAULT_DEPOSIT).timezone)
      .toBe('Asia/Kuwait');
  });

  it('validates businessHours through the shared schema', () => {
    const err = refusal(() =>
      parseOnboardInput(
        { ...MINIMUM_BODY, businessHours: { morning: ['10:00'], evening: ['16:00', '21:00'] } },
        PLATFORM_DEFAULT_DEPOSIT,
      ),
    );
    expect(err.code).toBe('invalid_business_hours');
  });
});
