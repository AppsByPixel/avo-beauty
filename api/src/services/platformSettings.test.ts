/**
 * The basis-point → percentage conversion, and the CHECK that makes it exact.
 *
 * `commissionRatesFrom` divides `card_percent_bp` by 100 because
 * `CommissionRates.cardPercent` is a percentage. That division is a float
 * operation on the money path, and the comment beside it claims the column's
 * CHECK constraints make it exact. This file is that claim measured, because a
 * comment asserting an arithmetic property is worth nothing next to a test that
 * would fail if it stopped holding.
 *
 * WHY THE WHOLE DOMAIN AND NOT A FEW CASES: the interesting inputs are the exact
 * half-fil boundaries, where the rounding direction is decided by the last bit of
 * a double, and there is no way to pick those by hand. The attainable rate domain
 * is eleven values, so the test enumerates all of them against exact integer
 * arithmetic — no sampling, no fixture, no judgement about which amounts matter.
 */

import { describe, expect, it } from 'vitest';
import { commissionFor, DEFAULT_COMMISSION, fils } from '@avo/types';
import {
  CARD_PERCENT_STEP_BP,
  MAX_CARD_PERCENT_BP,
  commissionRatesFrom,
} from './platformSettings';
import type { PlatformSettingsRow } from '../db/schema/platformSettings';

/** A settings row with only the fields the conversion reads. */
function rowWith(overrides: Partial<PlatformSettingsRow>): PlatformSettingsRow {
  return {
    id: 'avo',
    flagSignups: true,
    flagBooking: true,
    flagShop: true,
    flagWa: true,
    flagMaintenance: false,
    knetFlatFils: fils(150),
    cardPercentBp: 250,
    cardFlatFils: fils(50),
    newSalonDepositFils: fils(5000),
    updatedBy: null,
    updatedAt: new Date('2026-08-19T00:00:00.000Z'),
    ...overrides,
  } as PlatformSettingsRow;
}

/**
 * The card commission computed in integer basis points, half-up. No float
 * anywhere: `amount * bp` is at most 1e7 * 500 = 5e9, far inside
 * `Number.MAX_SAFE_INTEGER`, so the product is exact and the floor is exact.
 *
 * This is the ORACLE. It is deliberately not the implementation, because a test
 * that recomputes the implementation proves only that it is deterministic.
 */
function exactCardCommission(amount: number, bp: number, flat: number): number {
  return Math.floor((amount * bp + 5000) / 10000) + flat;
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/** Every rate the design's stepper can produce: 0, 0.5% ... 5%. */
const ATTAINABLE_BP: number[] = [];
for (let bp = 0; bp <= MAX_CARD_PERCENT_BP; bp += CARD_PERCENT_STEP_BP) ATTAINABLE_BP.push(bp);

describe('commissionRatesFrom — the stored rate as commissionFor wants it', () => {
  it('reproduces DEFAULT_COMMISSION from migration 0032 defaults, field for field', () => {
    /**
     * THE NEAR-MISS THIS TEST EXISTS FOR. A draft of migration 0032 defaulted
     * `card_flat_fils` to 0, from memory, where the constant says 50. Creating the
     * table would have silently cut AVO's card commission by 50 fils per top-up and
     * nothing would have reported it — the console would have displayed the wrong
     * number as confidently as the right one.
     *
     * So the defaults are not merely documented as matching; they are asserted to.
     */
    expect(commissionRatesFrom(rowWith({}))).toEqual(DEFAULT_COMMISSION);
  });

  it('prices a top-up identically to the compiled-in default at the default rate', () => {
    // The wiring change in services/topup.ts must move no money on a fresh
    // deployment. Same amounts money.test.ts uses, both methods.
    for (const amount of [5000, 10000, 25000, 50000, 99999]) {
      for (const method of ['knet', 'card', 'applepay'] as const) {
        expect(commissionFor(fils(amount), method, commissionRatesFrom(rowWith({})))).toBe(
          commissionFor(fils(amount), method),
        );
      }
    }
  });

  it('has an exact bp → percent conversion for every attainable rate', () => {
    expect(ATTAINABLE_BP).toEqual([0, 50, 100, 150, 200, 250, 300, 350, 400, 450, 500]);

    const CAP = 10_000_000; // 10,000 KD, well past any real top-up.
    let boundariesChecked = 0;
    const divergences: Array<{ amount: number; bp: number; got: number; exact: number }> = [];

    for (const bp of ATTAINABLE_BP) {
      if (bp === 0) continue; // 0% has no rounding to get wrong.
      const rates = commissionRatesFrom(rowWith({ cardPercentBp: bp }));
      const flat = DEFAULT_COMMISSION.cardFlatFils;

      /**
       * The exact half-fil boundaries are the solutions of
       * `amount * bp ≡ 5000 (mod 10000)` — an arithmetic progression, so they are
       * ENUMERATED rather than found by scanning ten million amounts per rate.
       * The step is `10000 / gcd(bp, 10000)`; the first solution is found by one
       * pass over a single period.
       */
      const step = 10000 / gcd(bp, 10000);
      let first = -1;
      for (let a = 1; a <= step; a++) {
        if ((a * bp) % 10000 === 5000) {
          first = a;
          break;
        }
      }
      // `5000 % g !== 0` would mean this rate has no half-fil boundary at all —
      // nothing to check, and not a failure.
      if (first < 0) continue;

      for (let amount = first; amount <= CAP; amount += step) {
        boundariesChecked++;
        const got = commissionFor(fils(amount), 'card', rates);
        const exact = exactCardCommission(amount, bp, flat);
        if (got !== exact) divergences.push({ amount, bp, got, exact });
      }
    }

    // Collected and asserted once: a failure names the amount and the rate rather
    // than stopping at whichever boundary happened to be first.
    expect(divergences).toEqual([]);
    // A test that checked nothing would also pass. Name the coverage it got.
    expect(boundariesChecked).toBeGreaterThan(1_000_000);
  });

  it('would catch a widened CHECK: rates outside the design step are not all exact', () => {
    /**
     * THE COUNTER-CASE, and it is the point of the two CHECK constraints rather
     * than a curiosity. If `platform_settings_card_percent_is_half_a_point` were
     * dropped, the column could hold 29 bp — and 0.29% of 25.000 KD is 73 fils
     * exactly and 72 fils through `bp / 100`.
     *
     * Asserted as a REAL DIVERGENCE so this file documents why the constraint is
     * load-bearing. If a future @avo/types made `percentOf` exact for all rates,
     * this expectation flips and whoever sees it can retire the CHECK deliberately
     * instead of discovering the constraint has become theatre.
     */
    const unsafe = commissionRatesFrom(rowWith({ cardPercentBp: 29, cardFlatFils: fils(0) }));
    expect(commissionFor(fils(25000), 'card', unsafe)).toBe(72);
    expect(exactCardCommission(25000, 29, 0)).toBe(73);
  });

  it('carries the flat components through as integers, untouched', () => {
    const rates = commissionRatesFrom(
      rowWith({ knetFlatFils: fils(200), cardFlatFils: fils(0), cardPercentBp: 0 }),
    );
    expect(rates.knetFlatFils).toBe(200);
    expect(rates.cardFlatFils).toBe(0);
    // 0% + 0 flat is a real configuration: AVO waiving its card fee.
    expect(commissionFor(fils(50000), 'card', rates)).toBe(0);
    // KNET is flat regardless of amount — the rate never enters.
    expect(commissionFor(fils(50000), 'knet', rates)).toBe(200);
    expect(commissionFor(fils(1), 'knet', rates)).toBe(200);
  });
});
