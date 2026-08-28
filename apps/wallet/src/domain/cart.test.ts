/**
 * The cart, tested where it can cost money or reach an unreachable refusal.
 *
 * The map shape exists to make `duplicate_product` impossible by construction, so
 * that is the first thing asserted. The rest is the arithmetic a customer is
 * charged for and the two clamps that keep the server from having to refuse.
 */

import { describe, expect, it } from 'vitest';
import { fils } from '@avo/types';
import {
  MAX_LINE_QTY,
  affordable,
  cartCount,
  cartTotal,
  decrement,
  increment,
  initialFor,
  localShortfall,
  pricedLines,
  setQty,
  staleIds,
  swatchFor,
  toOrderLines,
} from './cart';
import type { Product } from '../api/shop';

/**
 * The real catalogue from avo_lane_b, ordered by id as the route returns it.
 *
 * `image: null` on all three because nothing here prices a photograph — the
 * fidelity this fixture owes the wire is about `priceFils` and about the field
 * NAMES the cart reads. The image branch that does matter is exercised where it
 * belongs: `api/shop.test.ts` carries a real `ImageRef` alongside a null one, and
 * `components/productImageRender.test.tsx` renders both.
 */
const CATALOGUE: Product[] = [
  { id: 'PR-01', salonId: 'SAL-AMARA', name: 'Argan hair oil 100ml', priceFils: 8500, image: null },
  { id: 'PR-02', salonId: 'SAL-AMARA', name: 'Repair mask', priceFils: 12000, image: null },
  { id: 'PR-03', salonId: 'SAL-AMARA', name: 'Heat protect spray', priceFils: 6750, image: null },
];

// ------------------------------------------------------------- the map shape ----

describe('the cart cannot express a duplicate', () => {
  /**
   * `POST /orders` refuses duplicate ids by name, and a duplicate reaching the
   * money transaction would raise a 23505 that reads as an idempotency collision —
   * answering "still being processed" for an order that never happened. A map
   * keyed by id makes that unreachable rather than something a screen remembers.
   */
  it('adding the same product twice raises its quantity, never adds a line', () => {
    let cart = increment({}, 'PR-01');
    cart = increment(cart, 'PR-01');
    cart = increment(cart, 'PR-01');

    expect(cart).toEqual({ 'PR-01': 3 });
    const lines = toOrderLines(cart, CATALOGUE);
    expect(lines).toEqual([{ productId: 'PR-01', qty: 3 }]);
    expect(new Set(lines.map((l) => l.productId)).size).toBe(lines.length);
  });

  it('never emits two lines for one product from any sequence of edits', () => {
    let cart: Record<string, number> = {};
    for (const id of ['PR-01', 'PR-02', 'PR-01', 'PR-03', 'PR-02', 'PR-01']) {
      cart = { ...increment(cart, id) };
    }
    const ids = toOrderLines(cart, CATALOGUE).map((l) => l.productId);
    expect(ids).toEqual([...new Set(ids)]);
  });
});

// ---------------------------------------------------------------- the wire ----

describe('the order body carries no price', () => {
  /**
   * The one-character mistake: a `PricedLine` holds a `Product`, a `Product` holds
   * `priceFils`, and spreading one into the body sends a price the route refuses
   * BY NAME. `toOrderLines` returns two keys so it cannot happen.
   */
  it('emits exactly productId and qty', () => {
    const lines = toOrderLines({ 'PR-01': 2, 'PR-03': 1 }, CATALOGUE);
    for (const l of lines) expect(Object.keys(l).sort()).toEqual(['productId', 'qty']);
    expect(JSON.stringify(lines)).not.toContain('priceFils');
    expect(JSON.stringify(lines)).not.toContain('salonId');
  });

  it('drops a product the catalogue no longer has rather than ordering it', () => {
    // The server would refuse it as `invalid_products`; not sending it means the
    // rest of a valid cart can still be paid for once she removes it.
    const lines = toOrderLines({ 'PR-01': 1, 'PR-99': 2 }, CATALOGUE);
    expect(lines.map((l) => l.productId)).toEqual(['PR-01']);
  });
});

// --------------------------------------------------------------- arithmetic ----

describe('the totals a customer is shown', () => {
  it('prices each line qty × catalogue price', () => {
    const lines = pricedLines({ 'PR-01': 1, 'PR-03': 2 }, CATALOGUE);
    expect(lines.map((l) => l.lineTotalFils)).toEqual([fils(8500), fils(13500)]);
    // The real order this mirrors: 8500 + 13500 = 22000, driven on avo_lane_b.
    expect(cartTotal(lines)).toBe(fils(22000));
  });

  it('renders lines in catalogue order, not insertion order', () => {
    const lines = pricedLines({ 'PR-03': 1, 'PR-01': 1 }, CATALOGUE);
    expect(lines.map((l) => l.product.id)).toEqual(['PR-01', 'PR-03']);
  });

  it('counts total quantity, not distinct lines — design:1447', () => {
    // Two bottles of one oil is "2 items" to a customer and one row to a database.
    expect(cartCount({ 'PR-01': 2 })).toBe(2);
    expect(cartCount({ 'PR-01': 2, 'PR-02': 3 })).toBe(5);
    expect(cartCount({})).toBe(0);
  });

  it('throws rather than rendering a float total — money is integer fils', () => {
    const bad: Product[] = [{ id: 'X', salonId: 'S', name: 'X', priceFils: 8500.5, image: null }];
    expect(() => pricedLines({ X: 1 }, bad)).toThrow();
  });
});

// ------------------------------------------------------------------ clamps ----

describe('quantities are clamped so the server never has to refuse them', () => {
  it('stops at the ceiling the schema CHECKs', () => {
    let cart = setQty({}, 'PR-01', MAX_LINE_QTY);
    cart = increment(cart, 'PR-01');
    expect(cart['PR-01']).toBe(MAX_LINE_QTY);
  });

  /**
   * A stored zero would make `Object.keys` report a line, so an "empty" cart would
   * submit an order and be refused as `invalid_request`. Deleting the key is what
   * keeps empty meaning empty.
   */
  it('deletes the key at zero rather than storing a 0', () => {
    const cart = decrement({ 'PR-01': 1 }, 'PR-01');
    expect(cart).toEqual({});
    expect(Object.keys(cart)).toHaveLength(0);
    expect(cartCount(cart)).toBe(0);
  });

  it('never goes negative, from any number of decrements', () => {
    let cart = decrement({ 'PR-01': 1 }, 'PR-01');
    cart = decrement(cart, 'PR-01');
    cart = decrement(cart, 'PR-01');
    expect(cart).toEqual({});
  });

  it('truncates a fractional quantity rather than sending 2.5', () => {
    // `invalid_qty` refuses 2.5 server-side; truncating means a client bug cannot
    // reach it, and `fils()` would throw on the line total anyway.
    expect(setQty({}, 'PR-01', 2.9)['PR-01']).toBe(2);
  });

  it('returns a new cart rather than mutating the old one', () => {
    const before = { 'PR-01': 1 };
    const after = increment(before, 'PR-01');
    expect(before).toEqual({ 'PR-01': 1 });
    expect(after).toEqual({ 'PR-01': 2 });
  });
});

// ---------------------------------------------------- the stale-product state ----

describe('a product that went away while she shopped', () => {
  /**
   * The state trunk singled out. `invalid_products` names the id whether it was
   * retired or never existed, and she is holding it — so the cart can say WHICH
   * before she taps Pay rather than after.
   */
  it('names the ids the catalogue no longer has', () => {
    expect(staleIds({ 'PR-01': 1, 'PR-99': 1 }, CATALOGUE)).toEqual(['PR-99']);
  });

  it('is empty for a cart the catalogue fully covers', () => {
    expect(staleIds({ 'PR-01': 1, 'PR-02': 2 }, CATALOGUE)).toEqual([]);
  });

  it('ignores a zero-quantity entry', () => {
    expect(staleIds({ 'PR-99': 0 }, CATALOGUE)).toEqual([]);
  });

  it('is sorted, so the sentence is stable across renders', () => {
    expect(staleIds({ 'PR-98': 1, 'PR-99': 1 }, CATALOGUE)).toEqual(['PR-98', 'PR-99']);
  });
});

// ------------------------------------------------------------ the CTA choice ----

describe('affordability chooses a label and nothing else', () => {
  it('is true when the balance covers the total exactly', () => {
    expect(affordable(fils(22000), 22000)).toBe(true);
    expect(affordable(fils(22001), 22000)).toBe(false);
  });

  /**
   * The local shortfall exists for the label before submission. Once a 402
   * arrives, `ApiError.shortfallFils` replaces it — #2 gives the server the
   * difference as well as the balance, and the 402 driven on avo_lane_b carried
   * `shortfallFils: 57500` for a 60000 cart against 2500.
   */
  it('computes a local shortfall that the server’s 402 then overrides', () => {
    expect(localShortfall(fils(60000), 2500)).toBe(fils(57500));
    expect(localShortfall(fils(1000), 2500)).toBe(fils(0));
  });
});

// ------------------------------------------------------------- presentation ----

describe('the swatch and initial the design draws but no API carries', () => {
  it('is stable for one product across calls', () => {
    expect(swatchFor('PR-01')).toBe(swatchFor('PR-01'));
  });

  it('does not depend on catalogue position', () => {
    // An index-based swatch would recolour every product when one is retired.
    const before = CATALOGUE.map((p) => swatchFor(p.id));
    const after = [CATALOGUE[2]!, CATALOGUE[0]!].map((p) => swatchFor(p.id));
    expect(after[0]).toBe(before[2]);
    expect(after[1]).toBe(before[0]);
  });

  it('only ever returns one of the design’s own five hexes', () => {
    const allowed = new Set(['#EDE7DF', '#E8E9E0', '#E4EAE4', '#ECE6E6', '#EAE4EC']);
    for (let i = 0; i < 200; i += 1) expect(allowed.has(swatchFor(`PR-${i}`))).toBe(true);
  });

  it('takes the initial from the name, as the design does', () => {
    expect(initialFor('Repair mask')).toBe('R');
    expect(initialFor('  argan oil')).toBe('A');
  });
});
