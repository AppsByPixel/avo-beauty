/**
 * Product — api-contract.md § Product, and nothing more than it declares.
 *
 *     id, salonId, name, priceFils
 *
 * "Catalog only — no stock counts, deliberately. A purchase earns a visit/stamp."
 * The merchant dashboard's Shop section says the same in its own words: "Catalog
 * only — no stock counts, no delivery (phase 2). Buyers pick up at the salon."
 *
 * SO THERE IS NO `quantity`, NO `stock`, NO `sku`, and none is to be added
 * without a decision. A stock count that nothing decrements is worse than no
 * stock count: the shop screen would show "3 left" for ever and a customer would
 * be told a bottle exists that the salon sold last week.
 *
 * `active` IS HERE AND IS NOT ON THE WIRE, for the reason `service.active` is
 * both:
 *
 *   - the DELETE in the design's Shop editor (the ✕ on each row) retires a
 *     product rather than removing the row, because `shop_order_line` references
 *     it `ON DELETE restrict` and a product deleted out from under the orders it
 *     was sold in is a receipt with a dangling id in it;
 *   - `ProductSchema` in `packages/types` declares exactly four fields and Zod
 *     STRIPS anything else, so emitting a fifth would be a field the contract
 *     silently deletes in transit. `ServiceSchema` declares `active` and so
 *     `GET /salons/{id}/services` emits it; `ProductSchema` does not, so this
 *     route does not. Widening the schema is a trunk operation.
 *
 * WHAT IS MISSING AND IS REPORTED RATHER THAN INVENTED: `nameAr`. The wallet's
 * Shop tab in `design/AVO Wallet Home.dc.html` renders Arabic product names, and
 * the merchant's Shop editor draws ONE name field with no Arabic column beside
 * it — so the design asks for a translation it gives nobody a way to author, and
 * `ProductSchema` has no field to carry it. `service.name_ar` exists because
 * `ServiceSchema` declares it. Adding one here would mean widening a
 * trunk-owned schema AND inventing a dashboard input, which is exactly the
 * "redesign" CLAUDE.md forbids. Escalated instead.
 */

import { sql } from 'drizzle-orm';
import { boolean, check, index, pgTable, text } from 'drizzle-orm/pg-core';
import { filsColumn, timestamptz } from './_shared';
import { salon } from './salon';

export const product = pgTable(
  'product',
  {
    id: text('id').primaryKey(),
    salonId: text('salon_id')
      .notNull()
      .references(() => salon.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    priceFils: filsColumn('price_fils').notNull(),
    /** Retired products stay for old orders to reference; they just can't be sold. */
    active: boolean('active').notNull().default(true),

    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('product_salon_idx').on(t.salonId),
    /**
     * A free product is the same rounding argument at the same counter as a free
     * service, so it gets the same CHECK.
     *
     * IT IS ALSO WHAT MAKES A CLAIM ALREADY IN THE SCHEMA TRUE. The sign CHECK
     * on `transaction` says a `shop` row cannot be zero "because
     * `service_price_positive` refuses a free line" — and a shop row is priced
     * from THIS table, not from `service`, so until this constraint existed that
     * sentence named a constraint that did not govern the kind it was explaining.
     * The conclusion was right and the reason was wrong, which is the harder
     * defect to notice.
     */
    check('product_price_positive', sql`${t.priceFils} > 0`),
    // A product whose name is whitespace paints an empty row in both the shop
    // list and the receipt. Same reasoning as `service_name_ar_not_blank`.
    check('product_name_not_blank', sql`length(btrim(${t.name})) > 0`),
  ],
);
