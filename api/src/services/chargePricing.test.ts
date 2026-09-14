/**
 * The two canonical answers to "what was this charge for", and the wall between
 * them.
 *
 * `transaction.basket_hash` holds one question's answer in two shapes: the sorted
 * service ids for a menu charge, the amount for a typed one. That is what keeps the
 * near-duplicate guard — DECISIONS.md item 3 — reachable on the path where the
 * figure is typed, which is the path where a double tap costs the most.
 *
 * IT ALSO CREATES A COLLISION RISK THAT NOTHING ELSE WOULD CATCH. If a basket could
 * ever hash to the same value as an amount, a charge for `SV-01` and a charge for
 * some number of fils would be the same charge to the guard: one would refuse the
 * other as a duplicate, or — far worse — a confirmed duplicate would let through a
 * second charge for something entirely different. Neither would look like a hashing
 * bug from the outside. These are pure functions, so the wall between them is
 * cheaply and permanently pinned here rather than inferred from a database spec.
 */

import { describe, expect, it } from 'vitest';
import { fils } from '@avo/types';
import { basketHashFor, customAmountHashFor, CUSTOM_AMOUNT_MAX_FILS } from './charge';

describe('basketHashFor', () => {
  it('is order-independent — one basket to the person at the counter', () => {
    expect(basketHashFor(['SV-02', 'SV-01'])).toBe(basketHashFor(['SV-01', 'SV-02']));
  });

  it('distinguishes different baskets', () => {
    expect(basketHashFor(['SV-01'])).not.toBe(basketHashFor(['SV-02']));
  });
});

describe('customAmountHashFor', () => {
  it('is stable for one amount and different for another', () => {
    expect(customAmountHashFor(fils(25_000))).toBe(customAmountHashFor(fils(25_000)));
    expect(customAmountHashFor(fils(25_000))).not.toBe(customAmountHashFor(fils(25_001)));
  });

  it('can never collide with a basket, whatever the ids look like', () => {
    /**
     * The adversarial shapes: an id that is a number, an id that is the amount, a
     * basket of one. A `{ custom: n }` body and a `{ basket: [...] }` body are
     * different JSON, so no input to one can produce the other's digest — asserted
     * rather than reasoned, because the day somebody "tidies" these two into one
     * helper is the day it stops being true and nothing else goes red.
     */
    for (const ids of [['25000'], ['SV-01'], ['25000', 'SV-01'], []]) {
      expect(basketHashFor(ids)).not.toBe(customAmountHashFor(fils(25_000)));
    }
  });
});

describe('CUSTOM_AMOUNT_MAX_FILS', () => {
  /**
   * A CONSTANT WITH A SPEC, because the number is the decision. An unbounded
   * number field on a money path is a decision nobody made; this one is 200.000 KD
   * — eight times the most expensive seeded service and twenty times the
   * contract's maximum deposit. Changing it should have to touch a spec, exactly as
   * `scannerLimit.int.test.ts` argues for its thresholds.
   */
  it('is 200.000 KD, expressed in whole fils', () => {
    expect(CUSTOM_AMOUNT_MAX_FILS).toBe(200_000);
    expect(Number.isInteger(CUSTOM_AMOUNT_MAX_FILS)).toBe(true);
  });

  it('leaves room for a real visit — it is well above the dearest seeded service', () => {
    // SV-03, colour roots, 25.000 KD. A ceiling below this would block the menu.
    expect(CUSTOM_AMOUNT_MAX_FILS).toBeGreaterThan(25_000);
  });
});
