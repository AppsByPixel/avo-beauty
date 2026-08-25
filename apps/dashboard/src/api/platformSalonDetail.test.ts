import { describe, expect, it } from 'vitest';
import { isCompleteLadder, parsePlatformSalonDetail } from './platformSalons.js';

/**
 * The per-salon editor's parser, against the bodies `GET /v1/platform/salons/:id`
 * actually sent.
 *
 * BOTH FIXTURES ARE CAPTURED RESPONSES, not hand-written shapes — off a freshly
 * seeded `avo_lane_c`, API on 4170, owner-console token for `yousef`. That matters
 * more here than it usually does, because writing them by hand is exactly how the
 * two defects below would have shipped: a hand-written fixture describes what the
 * author expects, and both of these were things nobody expected.
 *
 *   `ownerPhone` IS NULL on every seeded salon. The field was typed `string` and
 *   parsed with a required-string helper, on the reasoning that the whole point of
 *   the envelope is to carry it. `owner_phone` is a nullable column added by
 *   migration 0037 for the onboarding wizard, so every salon that predates the
 *   wizard has none — which on a plain seed is all of them. The strict parser
 *   threw on the real body and would have failed the editor's read for every
 *   salon, reported as a server error.
 *
 *   `SAL-LUMIERE` RUNS A TWO-RUNG LADDER. `services/loyaltyRules.ts § parseTiers`
 *   refuses anything but four — "A ladder has all four tiers … Got 2." — so the
 *   client mirrored it and threw. Confirmed in SQL rather than off the reply:
 *   `jsonb_array_length(tiers)` is 2 for that salon on a fresh seed. The server
 *   deliberately tolerates a stored short ladder on READ and validates it only
 *   when a request puts it into effect (lane D's suite found the strict version
 *   locking such a salon out of editing anything at all). The client now draws the
 *   same line, and these cases pin it.
 *
 * Both were found by driving the endpoint. Both typechecked.
 */

/** `GET /v1/platform/salons/SAL-LUMIERE` — tiers mode, SHORT ladder, null card. */
const WIRE_TIERS = {
  salon: {
    id: 'SAL-LUMIERE',
    name: 'Lumiere',
    nameAr: null,
    city: null,
    plan: 'starter',
    brandColor: '#7A5C8E',
    modules: { booking: false, shop: false },
    loyaltyMode: 'tiers',
    tiers: [
      { name: 'bronze', minVisits: 0, bonusPercent: 0 },
      { name: 'silver', minVisits: 4, bonusPercent: 10 },
    ],
    stampTarget: null,
    stampReward: null,
    stampRewardAr: null,
    depositFils: 5000,
    noShowReturnMinutes: 60,
    timezone: 'Asia/Kuwait',
    businessHours: { evening: ['16:00', '21:00'], morning: ['10:00', '13:00'] },
    branches: [
      { id: 'BR-LUM-HAW', salonId: 'SAL-LUMIERE', name: 'Hawally', nameAr: null },
      { id: 'BR-LUM-JAB', salonId: 'SAL-LUMIERE', name: 'Jabriya', nameAr: null },
    ],
    social: [],
    whatsappEnabled: false,
  },
  ownerPhone: null,
};

/**
 * `SAL-AMARA` after a driven `PATCH { loyaltyMode: 'stamps' }` — stamps mode with
 * the tier ladder KEPT, which is the server's documented behaviour ("a salon that
 * trials tiers for a month and switches back should find its stamp card where it
 * left it") and the reason the dormant side is parsed rather than dropped.
 */
const WIRE_STAMPS = {
  salon: {
    ...WIRE_TIERS.salon,
    id: 'SAL-AMARA',
    name: 'Amara',
    nameAr: 'أمارا',
    plan: 'growth',
    modules: { booking: true, shop: false },
    loyaltyMode: 'stamps',
    tiers: [
      { name: 'bronze', minVisits: 0, bonusPercent: 0 },
      { name: 'silver', minVisits: 5, bonusPercent: 10 },
      { name: 'gold', minVisits: 10, bonusPercent: 20 },
      { name: 'black', minVisits: 20, bonusPercent: 30 },
    ],
    stampTarget: 8,
    stampReward: 'Free blow-dry',
    depositFils: 7000,
    branches: [
      { id: 'BR-KWC', salonId: 'SAL-AMARA', name: 'Kuwait City', nameAr: 'مدينة الكويت' },
      { id: 'BR-SAL', salonId: 'SAL-AMARA', name: 'Salmiya', nameAr: 'السالمية' },
    ],
  },
  ownerPhone: null,
};

describe('parsePlatformSalonDetail reads the real wire', () => {
  it('keeps a null ownerPhone rather than throwing on it', () => {
    // The defect this whole file exists for. A required string here failed the
    // editor's read on every seeded salon.
    expect(parsePlatformSalonDetail(WIRE_TIERS).ownerPhone).toBeNull();
  });

  it('narrows the salon to what the editor draws, and no further', () => {
    const { salon } = parsePlatformSalonDetail(WIRE_TIERS);
    expect(salon).toEqual({
      id: 'SAL-LUMIERE',
      name: 'Lumiere',
      nameAr: null,
      city: null,
      plan: 'starter',
      modules: { booking: false, shop: false },
      loyaltyMode: 'tiers',
      tiers: [
        { name: 'bronze', minVisits: 0, bonusPercent: 0 },
        { name: 'silver', minVisits: 4, bonusPercent: 10 },
      ],
      stampTarget: null,
      depositFils: 5000,
      branches: [
        { id: 'BR-LUM-HAW', salonId: 'SAL-LUMIERE', name: 'Hawally', nameAr: null },
        { id: 'BR-LUM-JAB', salonId: 'SAL-LUMIERE', name: 'Jabriya', nameAr: null },
      ],
    });
  });

  it('accepts a stored two-rung legacy ladder instead of reporting it as broken', () => {
    const { salon } = parsePlatformSalonDetail(WIRE_TIERS);
    expect(salon.tiers).toHaveLength(2);
    // …and marks it as one the API would not take back, which is what stops the
    // editor offering a Save that could only 400.
    expect(isCompleteLadder(salon.tiers)).toBe(false);
  });

  it('keeps the dormant side of the loyalty configuration', () => {
    // Stamps mode, ladder retained. Dropping it would lose the salon's tiers on the
    // first save after a switch.
    const { salon } = parsePlatformSalonDetail(WIRE_STAMPS);
    expect(salon.loyaltyMode).toBe('stamps');
    expect(salon.stampTarget).toBe(8);
    expect(isCompleteLadder(salon.tiers)).toBe(true);
  });

  it('keeps an Arabic name and Arabic branch names whole', () => {
    const { salon } = parsePlatformSalonDetail(WIRE_STAMPS);
    expect(salon.nameAr).toBe('أمارا');
    expect(salon.branches[0]?.nameAr).toBe('مدينة الكويت');
  });
});

describe('parsePlatformSalonDetail refuses what the editor could not draw', () => {
  const withSalon = (patch: Record<string, unknown>) => ({
    ...WIRE_TIERS,
    salon: { ...WIRE_TIERS.salon, ...patch },
  });

  it('refuses a plan it cannot paint', () => {
    expect(() => parsePlatformSalonDetail(withSalon({ plan: 'enterprise' }))).toThrow(/not a known plan/);
  });

  it('refuses a loyalty mode it cannot name', () => {
    expect(() => parsePlatformSalonDetail(withSalon({ loyaltyMode: 'points' }))).toThrow(
      /not a known mode/,
    );
  });

  it('refuses a rung name that is not on the ladder', () => {
    // Positional against TIER_LADDER: an unknown rung would draw a row with no
    // label and steppers wired to it.
    expect(() =>
      parsePlatformSalonDetail(withSalon({ tiers: [{ name: 'platinum', minVisits: 1, bonusPercent: 5 }] })),
    ).toThrow(/not a ladder tier/);
  });

  it('refuses a ladder whose rungs are out of order', () => {
    expect(() =>
      parsePlatformSalonDetail(
        withSalon({
          tiers: [
            { name: 'silver', minVisits: 4, bonusPercent: 10 },
            { name: 'bronze', minVisits: 0, bonusPercent: 0 },
          ],
        }),
      ),
    ).toThrow(/not above the rung before it/);
  });

  it('refuses more rungs than the ladder has', () => {
    const five = [...WIRE_STAMPS.salon.tiers, { name: 'black', minVisits: 30, bonusPercent: 40 }];
    expect(() => parsePlatformSalonDetail(withSalon({ tiers: five }))).toThrow(/more than the ladder/);
  });

  it('refuses a deposit that is not a whole number of fils', () => {
    // Money. A float reaching this field is non-negotiable #1, and 5.5 KD typed as
    // 5500.5 is exactly how it would arrive.
    expect(() => parsePlatformSalonDetail(withSalon({ depositFils: 5500.5 }))).toThrow(
      /depositFils.*whole count/,
    );
  });

  it('refuses a tiers salon whose ladder is missing entirely', () => {
    // `salon_loyalty_config_complete` guarantees the ACTIVE side. A null here means
    // the constraint is gone, not that the salon has an empty ladder.
    expect(() => parsePlatformSalonDetail(withSalon({ tiers: null }))).toThrow(
      /no tier ladder came with it/,
    );
  });

  it('refuses a stamps salon with no target', () => {
    expect(() =>
      parsePlatformSalonDetail(withSalon({ loyaltyMode: 'stamps', stampTarget: null })),
    ).toThrow(/no stamp target came with it/);
  });

  it('tells a missing ownerPhone key apart from a null one', () => {
    // Absent means an API from before the envelope; null is a salon with no phone
    // on record. Defaulting the first to the second is a silent downgrade.
    const { ownerPhone, ...noKey } = WIRE_TIERS;
    void ownerPhone;
    expect(() => parsePlatformSalonDetail(noKey)).toThrow(/carried no ownerPhone key/);
  });

  it('refuses a body that is not the envelope at all', () => {
    // The salon shape WITHOUT the envelope — what the endpoint would send if it
    // ever stopped wrapping, which is the change that would silently drop the phone.
    expect(() => parsePlatformSalonDetail(WIRE_TIERS.salon)).toThrow(/carried no salon/);
    expect(() => parsePlatformSalonDetail([])).toThrow(/was not an object/);
  });
});

describe('isCompleteLadder draws the line the API draws', () => {
  it('is false for no ladder and for a short one', () => {
    expect(isCompleteLadder(null)).toBe(false);
    expect(isCompleteLadder(parsePlatformSalonDetail(WIRE_TIERS).salon.tiers)).toBe(false);
  });

  it('is true for the fixed four rungs', () => {
    expect(isCompleteLadder(parsePlatformSalonDetail(WIRE_STAMPS).salon.tiers)).toBe(true);
  });
});
