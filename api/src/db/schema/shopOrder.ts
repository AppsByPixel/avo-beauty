/**
 * The lines of a shop order.
 *
 * WHY THERE IS NO `shop_order` TABLE
 * ---------------------------------
 * The `shop` transaction IS the order. It already carries the member, the salon,
 * the branch and whether that branch was established, the total (signed,
 * negative), the method, the status, the reference (`AVO-SH-…`) and the instant.
 * An `order` table beside it would restate every one of those, and a second
 * money column that can disagree with `transaction.amount_fils` is the defect
 * `member.balance_fils` needs a whole ledger to defend. So the order's identity
 * is its transaction id, and this table holds the one thing the transaction
 * cannot: WHAT was bought, and how many.
 *
 * WHY LINES ARE STORED AT ALL, when a charge does not store its services
 * ---------------------------------------------------------------------
 * `services/charge.ts` puts `serviceIds` in the audit metadata and the receipt
 * payload and stops there, and that is sufficient for a charge because a basket
 * of services has no quantities: the ids and the prices reconstruct the total.
 * A cart does have quantities — `design/AVO Wallet Home.dc.html` is a `{[id]:
 * qty}` map with − / + steppers — so `total = Σ qty × price` is not recoverable
 * from a list of ids. Two of one bottle and one of another is a different order
 * from one of each at the same total, and the person handing the bag over at the
 * salon needs to know which.
 *
 * PRICE AND NAME ARE SNAPSHOTS, NOT JOINS
 * ---------------------------------------
 * `product.price_fils` and `product.name` are editable — the design's Shop
 * editor saves as you type — so joining them would silently rewrite the history
 * of every order the moment a merchant corrects a price. The receipt she was
 * sent said 8.500; the row must keep saying 8.500. Same instinct as
 * `support_ticket.route` and `audit_log`'s actor columns.
 *
 * `line_total_fils` IS STORED ALONGSIDE `qty × unit_price_fils`, which looks
 * redundant and is the opposite: the CHECK below makes the multiplication a
 * database fact, so "does the sum of the lines equal what she was debited" is one
 * SELECT rather than arithmetic done again by whoever is asking. That
 * reconciliation is invariant 11 in `scripts/verify-constraints.sql`.
 *
 * KEYED ON (transaction_id, product_id)
 * -------------------------------------
 * One line per product, quantity in `qty` — the cart's own shape. A cart cannot
 * hold the same product on two rows, so the primary key says it cannot here
 * either; two lines for one bottle would make `qty` a number nobody could read
 * without summing.
 *
 * APPEND-ONLY, like `ledger_entry`. A settled purchase is money evidence: the
 * migration revokes UPDATE and DELETE from the application role, so an order
 * cannot be quietly re-itemised after the fact.
 */

import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, primaryKey, text } from 'drizzle-orm/pg-core';
import { filsColumn } from './_shared';
import { product } from './product';
import { transaction } from './transaction';

/**
 * A cart line's ceiling. Not a stock count — there are none — just a bound on a
 * single number a client sends, so a typo'd `qty: 1000000` is a 400 rather than a
 * bigint overflow argument at a counter.
 */
export const MAX_LINE_QTY = 99;

export const shopOrderLine = pgTable(
  'shop_order_line',
  {
    /** The `shop` transaction this line belongs to. The order's identity. */
    transactionId: text('transaction_id')
      .notNull()
      .references(() => transaction.id, { onDelete: 'restrict' }),
    /**
     * `ON DELETE restrict` — which is why the Shop editor's ✕ retires a product
     * rather than deleting it. See db/schema/product.ts.
     */
    productId: text('product_id')
      .notNull()
      .references(() => product.id, { onDelete: 'restrict' }),

    /** Snapshot of `product.name` at the moment of sale. */
    name: text('name').notNull(),
    qty: integer('qty').notNull(),
    /** Snapshot of `product.price_fils` at the moment of sale. */
    unitPriceFils: filsColumn('unit_price_fils').notNull(),
    /** `qty × unit_price_fils`, made a database fact by the CHECK below. */
    lineTotalFils: filsColumn('line_total_fils').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.transactionId, t.productId], name: 'shop_order_line_pk' }),
    // "Which orders has this product ever appeared in" — asked when a merchant
    // tries to delete one, and answered without a scan.
    index('shop_order_line_product_idx').on(t.productId),

    check('shop_order_line_qty_positive', sql`${t.qty} > 0 AND ${t.qty} <= ${sql.raw(String(MAX_LINE_QTY))}`),
    check('shop_order_line_unit_price_positive', sql`${t.unitPriceFils} > 0`),
    /**
     * The multiplication, enforced. A handler that computed the line total with a
     * float, or forgot a quantity, does not commit — which is non-negotiable #1
     * made structural on the one money path where a multiplication happens at
     * all. Nothing else in this schema multiplies money.
     */
    check(
      'shop_order_line_total_matches_qty',
      sql`${t.lineTotalFils} = ${t.qty} * ${t.unitPriceFils}`,
    ),
    check('shop_order_line_name_not_blank', sql`length(btrim(${t.name})) > 0`),
  ],
);
