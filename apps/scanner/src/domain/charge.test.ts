/**
 * The charge footer's arithmetic, including the deposit case the design shows
 * on the member card: 8.000 of services, 5.000 held, 3.000 charged.
 */

import { describe, expect, it } from 'vitest';
import { fils, formatFils } from '@avo/types';
import { chargeTotals } from './charge';
import { loyaltySentence } from './loyalty';

const services = [
  { id: 'cut', name: 'Cut & style', priceFils: 12000 },
  { id: 'blow', name: 'Blow-dry', priceFils: 6000 },
  { id: 'gloss', name: 'Gloss', priceFils: 8000 },
];

describe('chargeTotals', () => {
  it('is empty with nothing selected', () => {
    const t = chargeTotals(services, new Set(), fils(0));
    expect(t.hasSelection).toBe(false);
    expect(t.totalFils).toBe(0);
    expect(t.chargedFils).toBe(0);
  });

  it('adds the selected services', () => {
    const t = chargeTotals(services, new Set(['cut', 'blow']), fils(0));
    expect(t.totalFils).toBe(18000);
    expect(t.chargedFils).toBe(18000);
    expect(formatFils(t.totalFils)).toBe('18.000');
  });

  it('applies a held deposit — the design’s 8.000 − 5.000 = 3.000', () => {
    const t = chargeTotals(services, new Set(['gloss']), fils(5000));
    expect(formatFils(t.totalFils)).toBe('8.000');
    expect(formatFils(t.creditFils)).toBe('5.000');
    expect(formatFils(t.chargedFils)).toBe('3.000');
  });

  it('never credits more deposit than the bill, and never goes negative', () => {
    const t = chargeTotals(services, new Set(['blow']), fils(10000));
    expect(t.totalFils).toBe(6000);
    expect(t.creditFils).toBe(6000);
    expect(t.chargedFils).toBe(0);
  });

  it('ignores an unknown selected id rather than charging for it', () => {
    const t = chargeTotals(services, new Set(['cut', 'ghost']), fils(0));
    expect(t.totalFils).toBe(12000);
  });

  it('stays in integer fils across a multi-service basket', () => {
    const t = chargeTotals(services, new Set(['cut', 'blow', 'gloss']), fils(2500));
    expect(Number.isInteger(t.totalFils)).toBe(true);
    expect(Number.isInteger(t.chargedFils)).toBe(true);
    expect(formatFils(t.chargedFils)).toBe('23.500');
  });
});

describe('loyaltySentence', () => {
  it('renders the stamps form from the design', () => {
    expect(
      loyaltySentence({ mode: 'stamps', stamps: 5, target: 8, rewardReady: false }),
    ).toBe('Stamp added · 5 of 8');
  });

  it('renders the tiers form from the design', () => {
    expect(
      loyaltySentence({
        mode: 'tiers',
        visits: 5,
        tier: 'silver',
        nextTier: 'gold',
        visitsToNext: 5,
      }),
    ).toBe('Visit added · 5 of 10 to Gold');
  });

  it('degrades at the top of the ladder instead of dangling "to null"', () => {
    expect(
      loyaltySentence({
        mode: 'tiers',
        visits: 40,
        tier: 'black',
        nextTier: null,
        visitsToNext: null,
      }),
    ).toBe('Visit added · 40 visits');
  });
});
