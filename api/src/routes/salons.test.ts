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
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { assertShopReadable, buildSalonPatch, PLATFORM_EDITABLE } from './salons';
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

/**
 * `assertShopReadable` — the shop module on the READ path.
 *
 * THE DEFECT THIS COVERS. `GET /salons/{id}/products` filtered on `salonId` and
 * `active` and nothing else, so a salon with `module_shop = false` served its full
 * catalogue with a 200. `shop_not_enabled` existed in exactly one place —
 * `services/order.ts` § 3, the WRITE path — so the customer browsed a closed shop,
 * filled a cart, tapped "Pay 8.500 KD from wallet" and was told "We couldn't
 * complete your order. Nothing has been charged.": a permanent refusal wearing the
 * copy of a retryable one, with the button still live.
 *
 * The money control held — balance unchanged, no transaction row — so this was
 * never a money defect. It is an honesty defect, and the permission census cannot
 * see it because a module is not an authority.
 *
 * WHY THESE CASES AND NOT AN ENDPOINT DRIVE. The handler is database-bound, so
 * "the endpoint answers 409" belongs to Lane D in `e2e/`. What is pure — and what
 * actually carries the decision — is which callers the module refuses, so that is
 * taken as an argument and asserted here with no database, the same shape
 * `buildSalonPatch` above uses.
 */
describe('the shop module on the read path', () => {
  const OPEN = { moduleShop: true };
  const CLOSED = { moduleShop: false };

  it('refuses a member when the shop module is off', () => {
    const err = refusal(() => assertShopReadable('member', CLOSED));

    // The CODE, not the status. A 409 here and the `handle_taken` 409 two routes
    // over are the same three digits; only the code says which fact answered.
    expect(err.code).toBe('shop_not_enabled');
    expect(err.statusCode).toBe(409);
  });

  /**
   * THE MIRROR. Without it the case above passes against a function that refuses
   * every member, which would take the shop away from the salons that sell.
   */
  it('lets a member read an open shop', () => {
    expect(() => assertShopReadable('member', OPEN)).not.toThrow();
  });

  /**
   * THE DECISION, PINNED. The three product writes have no module check, because
   * building a catalogue before flipping the module on is how a salon opens a
   * shop and `module_shop` defaults OFF. Gating the merchant's own read would let
   * her create a product and then refuse to list it back — an editor that forgets
   * what it just saved. If someone later "completes" the gate by extending it to
   * staff, this goes red and the comment says why.
   */
  it('does NOT refuse staff, so a merchant can build a catalogue before opening', () => {
    expect(() => assertShopReadable('staff', CLOSED)).not.toThrow();
    expect(() => assertShopReadable('platform_admin', CLOSED)).not.toThrow();
  });

  /**
   * OFF AND EMPTY MUST STAY DIFFERENT ANSWERS. The wallet renders distinct copy —
   * "The shop is closed" versus "Nothing in the shop yet" — and picks between them
   * on the CODE (`apps/wallet/src/state/useShop.ts` maps `shop_not_enabled` to
   * `status: 'off'`). A closed shop that answered `{ items: [] }` would render
   * "Nothing in the shop yet" about a salon that does not sell products at all.
   * So the closed case must THROW rather than return, which is what this asserts
   * that the two cases above do not, on their own, say.
   */
  it('refuses rather than returning an empty catalogue', () => {
    let returnedNormally = false;
    try {
      assertShopReadable('member', CLOSED);
      returnedNormally = true;
    } catch {
      /* expected */
    }
    expect(returnedNormally, 'a closed shop must not be reported as an empty one').toBe(false);
  });
});

/**
 * THE READ AND THE WRITE MUST SPEAK ONE VOCABULARY.
 *
 * Two files now raise `shop_not_enabled` for one fact. The failure this guards
 * against is not that either is wrong today — it is that someone reworders one of
 * them and the wallet, which switches on the CODE and renders the MESSAGE, starts
 * showing two different sentences about the same closed shop depending on whether
 * she browsed or checked out. Asserted against `order.ts`'s source rather than
 * against a copy of the string, so the two cannot drift while the spec stays green.
 */
describe('the read refusal matches the write refusal', () => {
  const orderSource = readFileSync(
    fileURLToPath(new URL('../services/order.ts', import.meta.url)),
    'utf8',
  );

  it('raises the code and message services/order.ts already raises', () => {
    const written = /conflict\(\s*'shop_not_enabled',\s*'([^']+)'/.exec(orderSource);
    expect(written, 'services/order.ts no longer raises shop_not_enabled as expected').not.toBeNull();

    const err = refusal(() => assertShopReadable('member', { moduleShop: false }));
    expect(err.message).toBe(written![1]);
  });
});

/**
 * The seam the pure cases cannot reach: the handler could stop calling the gate
 * and every assertion above would stay green. Same technique as
 * `e2e/report-download-capability.test.ts`, and as `policies.test.ts`.
 */
describe('the products handler applies the gate', () => {
  const source = readFileSync(fileURLToPath(new URL('./salons.ts', import.meta.url)), 'utf8');

  it('calls assertShopReadable with the principal kind', () => {
    expect(source).toContain('assertShopReadable(p.kind, s)');
  });
});
