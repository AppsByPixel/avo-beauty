/**
 * The cart — pure, so it can be tested without a renderer.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * A MAP KEYED BY PRODUCT ID, NOT A LIST OF LINES, AND THE API DECIDES THAT.
 *
 * `POST /orders` refuses duplicate product ids by name (`duplicate_product`)
 * rather than summing them, because `shop_order_line`'s primary key is
 * `(transaction_id, product_id)` and a duplicate would raise a unique violation
 * deep inside the money transaction — where callers of that shape read every
 * 23505 as an idempotency collision and answer "still being processed" for
 * something that never happened.
 *
 * A `Record<productId, qty>` cannot produce a duplicate. That is the whole reason
 * the shape is a map: the refusal becomes unreachable by construction rather than
 * something a screen has to remember not to do. The design's own prototype uses
 * `cart: {}` keyed by id (:1443-1448) for what was presumably a simpler reason,
 * and it happens to be right.
 *
 * PRICES ARE THE CATALOGUE'S, AND THEY ARE NEVER SENT.
 * `cartTotal` exists to render a figure and to choose a CTA — not to tell the
 * server what to charge. The order body is `{productId, qty}` only, the server
 * prices from its own rows, and it refuses a client-supplied price by name
 * (non-negotiable #2). So every amount computed here is a DISPLAY value whose
 * authority is the response, and the moment the two disagree the response wins.
 *
 * WHICH IS WHY `affordable` IS A COURTESY AND SAYS SO.
 * `useBooking` states the rule for the deposit: "the 402 carries `shortfallFils`.
 * Subtracting the balance from the deposit here would be a second opinion about
 * money." The same holds here, with one difference — the cart has to pick between
 * two CTAs before it can submit anything, and "Top up to continue" versus "Pay
 * 22.000 from wallet" is a label, not a decision about money. So `affordable`
 * chooses the label and NOTHING else: the shortfall she is shown comes off the
 * 402, and a cart this function called affordable is still refused by the server
 * if the balance moved underneath it.
 * ═════════════════════════════════════════════════════════════════════════════
 */

import { add, fils, subtract, type Fils } from '@avo/types';
import type { Product } from '../api/shop';
import type { CartLine } from '../api/shop';

/** Product id → quantity. Absent or 0 means "not in the cart". */
export type Cart = Readonly<Record<string, number>>;

/** api/src/db/schema/shopOrder.ts — a CHECK enforces this server-side too. */
export const MAX_LINE_QTY = 99;

export interface PricedLine {
  product: Product;
  qty: number;
  /** qty × the CATALOGUE price. A display figure; see the header. */
  lineTotalFils: Fils;
}

/**
 * The cart's lines, in CATALOGUE order rather than insertion order.
 *
 * Catalogue order because the server returns products ordered by id and the Shop
 * list renders them that way — a cart sheet that reordered itself as she tapped
 * would make her re-find the row she just changed. Products no longer in the
 * catalogue are dropped here and reported separately; see `staleIds`.
 */
export function pricedLines(cart: Cart, products: readonly Product[]): PricedLine[] {
  const lines: PricedLine[] = [];
  for (const product of products) {
    const qty = cart[product.id] ?? 0;
    if (qty <= 0) continue;
    lines.push({
      product,
      qty,
      /*
        THERE IS NO `multiply` IN @avo/types, AND THIS IS THE GUARDED SUBSTITUTE.
        `add`, `subtract`, `negate`, `percentOf` and `commissionFor` exist; nothing
        scales an amount by a count, because until the shop nothing needed to — a
        charge sums prices and a bonus is a percentage.

        `priceFils` and `qty` are both integers (the schema refuses a float price,
        and `setQty` truncates and clamps), so their product is an integer, and
        `fils()` re-brands it through the guard that THROWS on a non-integer. So a
        float arriving from either side surfaces here rather than as a wrong figure
        on a receipt (non-negotiable #1).

        ESCALATED, not worked around: `multiply(amount, count)` belongs in
        `@avo/types` beside the others, and the shop is the first surface to need
        it. That package is trunk-owned and a four-way break, so adding it is not a
        lane B edit.
      */
      lineTotalFils: fils(product.priceFils * qty),
    });
  }
  return lines;
}

/**
 * Ids in the cart that the catalogue no longer has.
 *
 * THE STATE TRUNK SINGLED OUT. A product retired while she shopped is
 * indistinguishable to the API from one that never existed — `invalid_products`
 * names the id either way — and she is holding it. Detecting it from the
 * catalogue lets the cart say so BEFORE she taps Pay, rather than turning a
 * refusal into the first time she hears about it.
 *
 * It is not a substitute for handling the refusal: the catalogue this compares
 * against can itself be stale, so the server's `invalid_products` is still the
 * authority and still rendered.
 */
export function staleIds(cart: Cart, products: readonly Product[]): string[] {
  const known = new Set(products.map((p) => p.id));
  return Object.keys(cart)
    .filter((id) => (cart[id] ?? 0) > 0 && !known.has(id))
    .sort();
}

/** The sum of the lines. A display figure — the server prices the order. */
export function cartTotal(lines: readonly PricedLine[]): Fils {
  return lines.reduce<Fils>((sum, l) => add(sum, l.lineTotalFils), fils(0));
}

/**
 * Total quantity, not distinct lines — design:1447 reduces the values.
 *
 * It matters which: two bottles of one oil is "2 items" to a customer and one row
 * to a database, and the badge counts what she put in.
 */
export function cartCount(cart: Cart): number {
  return Object.values(cart).reduce((a, b) => a + Math.max(0, b), 0);
}

/**
 * The body for `POST /orders`, built from the map.
 *
 * Deliberately returns `CartLine[]` — `{productId, qty}` and nothing else — so
 * the price cannot travel even by accident. A `PricedLine` carries a `Product`,
 * and a `Product` carries `priceFils`; spreading one into a request body is the
 * one-character mistake the server refuses by name.
 */
export function toOrderLines(cart: Cart, products: readonly Product[]): CartLine[] {
  return pricedLines(cart, products).map((l) => ({ productId: l.product.id, qty: l.qty }));
}

/**
 * Add, remove, or set a quantity. Returns a NEW cart.
 *
 * Clamped to `[0, MAX_LINE_QTY]` and a 0 DELETES the key rather than storing a
 * zero. Both matter: a stored `{PR-01: 0}` would count as a line in
 * `Object.keys` and make an "empty" cart submit an order, and a qty of 100 would
 * spend a round trip to be told the ceiling is 99.
 */
export function setQty(cart: Cart, productId: string, qty: number): Cart {
  const next: Record<string, number> = { ...cart };
  const clamped = Math.min(MAX_LINE_QTY, Math.max(0, Math.trunc(qty)));
  if (clamped <= 0) delete next[productId];
  else next[productId] = clamped;
  return next;
}

/** One more, up to the ceiling. */
export function increment(cart: Cart, productId: string): Cart {
  return setQty(cart, productId, (cart[productId] ?? 0) + 1);
}

/** One fewer; at 1 this removes the line, which is what the design's − does. */
export function decrement(cart: Cart, productId: string): Cart {
  return setQty(cart, productId, (cart[productId] ?? 0) - 1);
}

/**
 * Whether the wallet covers the total — FOR CHOOSING A CTA LABEL ONLY.
 *
 * See the header. This is not the authority on whether she can pay; the server
 * is, and its 402 carries the shortfall that gets rendered. Reading this as
 * permission is the bug it is documented against.
 */
export function affordable(total: Fils, balanceFils: number): boolean {
  return total <= fils(balanceFils);
}

/**
 * The LOCAL shortfall, for the label before submission only.
 *
 * Returned as `Fils` so it cannot be mixed with a float, and never used once the
 * server has answered — `ApiError.shortfallFils` replaces it the moment a 402
 * arrives, because #2 gives the server the difference as well as the balance.
 */
export function localShortfall(total: Fils, balanceFils: number): Fils {
  const balance = fils(balanceFils);
  return total > balance ? subtract(total, balance) : fils(0);
}

/**
 * The design's product swatch and initial, derived rather than fetched.
 *
 * design:1424-1428 gives every product a muted swatch and a letter. Neither is on
 * `ProductSchema` and neither is a thing an API should carry — they are
 * presentation. The letter is `name.charAt(0)`, exactly as the design writes it
 * and as `apps/scanner/src/config/brand.ts` derives the salon initial.
 *
 * The swatch cycles the design's OWN five hexes, indexed by a stable hash of the
 * product id — so a product keeps its colour across launches and across devices
 * without a field, and no new colour is invented. Deterministic on purpose: a
 * random or index-based swatch would change when the catalogue is reordered.
 */
const SWATCHES = ['#EDE7DF', '#E8E9E0', '#E4EAE4', '#ECE6E6', '#EAE4EC'] as const;

export function swatchFor(productId: string): string {
  let h = 0;
  for (let i = 0; i < productId.length; i += 1) h = (h * 31 + productId.charCodeAt(i)) % 100003;
  return SWATCHES[h % SWATCHES.length] as string;
}

export function initialFor(name: string): string {
  return name.trim().charAt(0).toUpperCase();
}
