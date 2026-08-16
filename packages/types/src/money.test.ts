import { describe, expect, it } from 'vitest';
import {
  DEFAULT_COMMISSION,
  add,
  commissionFor,
  fils,
  formatFils,
  formatMoney,
  moneyAriaLabel,
  parseKwdInput,
  percentOf,
  subtract,
} from './money.js';

describe('fils()', () => {
  it('rejects a float — the bug non-negotiable #1 exists to prevent', () => {
    expect(() => fils(18.5)).toThrow(/must be an integer number of fils/);
  });

  it('rejects a KWD amount mistaken for fils', () => {
    expect(() => fils(18.0)).not.toThrow(); // 18.0 IS an integer — 18 fils
    expect(() => fils(0.1 + 0.2)).toThrow(); // classic float artefact
  });

  it('accepts zero and negatives (debits are signed)', () => {
    expect(fils(0)).toBe(0);
    expect(fils(-5000)).toBe(-5000);
  });
});

describe('formatFils — 3 decimals, Western digits, both languages', () => {
  it.each([
    [18000, '18.000'],
    [32500, '32.500'],
    [0, '0.000'],
    [1, '0.001'],
    [999, '0.999'],
    [1000, '1.000'],
    [-5000, '-5.000'],
    [1234567, '1,234.567'],
  ])('%i fils → %s', (input, expected) => {
    expect(formatFils(fils(input))).toBe(expected);
  });

  it('renders the same digits in Arabic, only the unit changes', () => {
    expect(formatMoney(fils(18000), 'en')).toBe('18.000 KD');
    expect(formatMoney(fils(18000), 'ar')).toBe('18.000 د.ك');
  });

  it('labels money so a screen reader says dinars, not thousands', () => {
    expect(moneyAriaLabel(fils(18000))).toBe('18.000 Kuwaiti dinars');
  });
});

describe('parseKwdInput', () => {
  it.each([
    ['5', 5000],
    ['5.250', 5250],
    ['5.25', 5250],
    ['0.001', 1],
    ['1,234.567', 1234567],
  ])('%s → %i fils', (input, expected) => {
    expect(parseKwdInput(input)).toBe(expected);
  });

  it('refuses more than 3 decimals rather than rounding silently', () => {
    expect(() => parseKwdInput('5.2501')).toThrow(/up to 3 decimals/);
  });
});

describe('commission — api-contract.md § Commission', () => {
  it('KNET is 150 fils flat, whatever the amount', () => {
    expect(commissionFor(fils(5000), 'knet')).toBe(150);
    expect(commissionFor(fils(50000), 'knet')).toBe(150);
  });

  it('card is 2.5% + 50 fils', () => {
    // 10.000 KD → 250 + 50 = 300 fils
    expect(commissionFor(fils(10000), 'card')).toBe(300);
    // 25.000 KD → 625 + 50 = 675 fils
    expect(commissionFor(fils(25000), 'card')).toBe(675);
  });

  it('Apple Pay is charged as card', () => {
    expect(commissionFor(fils(10000), 'applepay')).toBe(commissionFor(fils(10000), 'card'));
  });

  it('honours platform-configured rates from Owner → Controls', () => {
    const custom = { ...DEFAULT_COMMISSION, knetFlatFils: 200 };
    expect(commissionFor(fils(10000), 'knet', custom)).toBe(200);
  });

  it('never produces a fractional fil', () => {
    for (const amount of [1, 7, 333, 4999, 12345]) {
      expect(Number.isInteger(commissionFor(fils(amount), 'card'))).toBe(true);
    }
  });
});

describe('tier bonus — the numbers the wallet shows on top-up', () => {
  it('Silver: 10 → 11 KD is a 10% bonus', () => {
    expect(percentOf(fils(10000), 10)).toBe(1000);
    expect(add(fils(10000), percentOf(fils(10000), 10))).toBe(11000);
  });

  it('Gold: 10 → 12 KD is a 20% bonus', () => {
    expect(add(fils(10000), percentOf(fils(10000), 20))).toBe(12000);
  });

  it('Black: 10 → 13 KD is a 30% bonus', () => {
    expect(add(fils(10000), percentOf(fils(10000), 30))).toBe(13000);
  });

  it('Bronze earns nothing', () => {
    expect(percentOf(fils(10000), 0)).toBe(0);
  });

  it('rounds half-up to a whole fil, consistently', () => {
    // 5% of 5 fils = 0.25 → 0
    expect(percentOf(fils(5), 5)).toBe(0);
    // 10% of 25 fils = 2.5 → 3
    expect(percentOf(fils(25), 10)).toBe(3);
  });
});

describe('the charge arithmetic', () => {
  it('applies a held deposit as a credit line: 8.000 − 5.000 = 3.000', () => {
    const service = fils(8000);
    const deposit = fils(5000);
    expect(subtract(service, deposit)).toBe(3000);
  });

  it('reports the exact shortfall when a balance is too low', () => {
    const balance = fils(2500);
    const due = fils(8000);
    const shortfall = subtract(due, balance);
    expect(formatFils(shortfall)).toBe('5.500');
  });
});
