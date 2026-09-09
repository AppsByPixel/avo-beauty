// @vitest-environment jsdom

/**
 * MEMBERSHIP, RENDERED — the half `domain/membership.test.ts` cannot reach.
 *
 * The domain test proves the model: how many rungs, which one is current, what
 * the illustration figures are, which language the reward comes back in. What no
 * pure test can reach is whether the COMPONENT asks for those things and puts
 * them on screen — and this section's risk is concentrated exactly there,
 * because three of its strings were CHANGED relative to the design bundle and a
 * silent regression would put the old sentence back:
 *
 *   - the fine print's authority clause, which decision 86 moved from the salon
 *     to AVO because decision 79 made the design's sentence false;
 *   - the goal line and the third stamp rule, which name the SALON'S reward
 *     where the design hardcoded one salon's blow-dry.
 *
 * So the assertions below are about sentences on screen, not about props.
 */

import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Member, Salon } from '@avo/types';

import { MembershipSection } from './MembershipSection';
import { LanguageProvider } from '../i18n/language';

const TIERS = [
  { name: 'bronze', minVisits: 0, bonusPercent: 0 },
  { name: 'silver', minVisits: 4, bonusPercent: 10 },
  { name: 'gold', minVisits: 10, bonusPercent: 20 },
  { name: 'black', minVisits: 20, bonusPercent: 30 },
];

function salon(over: Record<string, unknown> = {}): Salon {
  return {
    name: 'Amara',
    nameAr: 'أمارا',
    loyaltyMode: 'tiers',
    tiers: TIERS,
    modules: { booking: false, shop: false },
    ...over,
  } as unknown as Salon;
}

const STAMPS = {
  loyaltyMode: 'stamps',
  tiers: undefined,
  stampTarget: 8,
  stampReward: 'Free blow-dry',
  stampRewardAr: 'تصفيف شعر مجاني',
};

function member(over: Record<string, unknown> = {}): Member {
  return { tier: 'silver', visits: 6, stamps: null, ...over } as unknown as Member;
}

function draw(m: Member, s: Salon, lang: 'en' | 'ar' = 'en') {
  return render(
    <LanguageProvider initial={lang}>
      <MembershipSection member={m} salon={s} />
    </LanguageProvider>,
  );
}

afterEach(cleanup);

describe('the tier variant', () => {
  it('renders one row per rung the salon has, and no more', () => {
    const { container } = draw(member(), salon());
    expect(container.querySelectorAll('[data-testid^="membership-rung-"]')).toHaveLength(4);

    cleanup();
    const two = draw(member(), salon({ tiers: TIERS.slice(0, 2) })).container;
    expect(two.querySelectorAll('[data-testid^="membership-rung-"]')).toHaveLength(2);
    // The rungs it does NOT have must not appear under any spelling.
    expect(two.textContent).not.toContain('Gold');
    expect(two.textContent).not.toContain('Black');
  });

  it('marks exactly one rung as current', () => {
    const { container } = draw(member(), salon());
    expect(container.querySelectorAll('[data-testid="membership-current"]')).toHaveLength(1);
    const silver = container.querySelector('[data-testid="membership-rung-silver"]');
    expect(silver?.textContent).toContain('Current');
  });

  it('prints each rung requirement and its illustration', () => {
    const { container } = draw(member(), salon());
    const text = container.textContent ?? '';
    expect(text).toContain('0 visits · no bonus');
    expect(text).toContain('4+ visits · +10%');
    expect(text).toContain('10 → 11');
    expect(text).toContain('10 → 13');
  });

  /**
   * DECISION 86, ASSERTED AS A SENTENCE. The design's own words were "The salon
   * can change its tiers at any time", and decision 79 made that false.
   */
  describe('the fine print', () => {
    it('names AVO as the party that can change the tiers', () => {
      const text = draw(member(), salon()).container.textContent ?? '';
      expect(text).toContain('AVO can change these tiers at any time');
      expect(text).not.toContain('The salon can change');
    });

    it('still says the salon funds the rewards, and names it', () => {
      const text = draw(member(), salon()).container.textContent ?? '';
      expect(text).toContain('funded by Amara, not AVO');
      expect(text).toContain('your existing balance is never affected');
    });

    it('names the salon in the reading language', () => {
      const ar = draw(member(), salon(), 'ar').container.textContent ?? '';
      expect(ar).toContain('أمارا');
      expect(ar).toContain('يمكن لـAVO');
      expect(ar).not.toContain('يمكن للصالون');
    });

    /** SAL-LUMIERE's `nameAr` is NULL, so Arabic falls back to the Latin name. */
    it('falls back to the Latin name when the salon has no Arabic one', () => {
      const ar = draw(member(), salon({ name: 'Lumiere', nameAr: null }), 'ar').container
        .textContent;
      expect(ar).toContain('Lumiere');
    });
  });

  it('mirrors the illustration arrow in Arabic', () => {
    const ar = draw(member(), salon(), 'ar').container.textContent ?? '';
    expect(ar).toContain('10 ← 11');
    expect(ar).not.toContain('10 → 11');
  });

  /** Non-negotiable #12: money stays Western while the counts go Eastern. */
  it('keeps the illustration Western and the requirement Eastern in Arabic', () => {
    const silver = draw(member(), salon(), 'ar').container.querySelector(
      '[data-testid="membership-rung-silver"]',
    );
    const text = silver?.textContent ?? '';
    expect(text).toContain('10 ← 11'); // money
    expect(text).toContain('+٤ زيارات'); // a count
    expect(text).toContain('١٠٪');
  });
});

describe('the stamp variant', () => {
  const stampSalon = (over: Record<string, unknown> = {}) => salon({ ...STAMPS, ...over });

  it('renders one dot per stamp in the target', () => {
    const { container } = draw(member({ stamps: 4 }), stampSalon());
    const dots = container.querySelector('[data-testid="membership-stamp-dots"]');
    expect(dots?.children).toHaveLength(8);
  });

  it('renders the count and the goal with the salon reward interpolated', () => {
    const text = draw(member({ stamps: 4 }), stampSalon()).container.textContent ?? '';
    expect(text).toContain('Your stamp card');
    expect(text).toContain('4 of 8');
    expect(text).toContain('4 more visits and your Free blow-dry is on us.');
  });

  it('uses the Arabic reward in Arabic', () => {
    const text = draw(member({ stamps: 4 }), stampSalon(), 'ar').container.textContent ?? '';
    expect(text).toContain('تصفيف شعر مجاني');
    expect(text).toContain('٤ من ٨');
    expect(text).not.toContain('Free blow-dry');
  });

  /**
   * A rule about buying in a shop the salon does not run describes an action the
   * customer cannot take.
   */
  it('hides the shop rule unless the salon runs a shop', () => {
    const off = draw(member({ stamps: 1 }), stampSalon()).container.textContent ?? '';
    expect(off).not.toContain('shop purchase');
    expect(off).toContain('One stamp per salon visit');

    cleanup();
    const on =
      draw(member({ stamps: 1 }), stampSalon({ modules: { booking: false, shop: true } })).container
        .textContent ?? '';
    expect(on).toContain('A shop purchase counts as a visit too.');
  });

  /**
   * Both remaining stamp strings NAME the reward. With none configured they must
   * be absent rather than rendered around a blank.
   */
  it('drops the goal line and the reset rule when no reward is configured', () => {
    const { container } = draw(
      member({ stamps: 1 }),
      stampSalon({ stampReward: undefined, stampRewardAr: null }),
    );
    const text = container.textContent ?? '';
    expect(container.querySelector('[data-testid="membership-goal"]')).toBeNull();
    expect(text).not.toContain('is on us');
    expect(text).not.toContain('resets');
    // The card itself, and the rule that does not name a reward, still render.
    expect(text).toContain('Your stamp card');
    expect(text).toContain('One stamp per salon visit');
  });
});

describe('a salon with no loyalty configured', () => {
  it('renders nothing rather than an empty labelled section', () => {
    const { container } = draw(member(), salon({ tiers: [] }));
    expect(container.textContent).toBe('');
  });
});
