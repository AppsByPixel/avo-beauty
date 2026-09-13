/**
 * DELIVERY: the member's address book, and an order's fulfilment.
 *                              (item 7, migration 0045, PRIOR-ART.md § Lean)
 *
 * Four decisions taken from Lean rather than invented — pickup stays as a FORK,
 * three statuses (`preparing → ready → closed`) rather than a workflow engine, a
 * saved address book keyed to the MEMBER, and NO DELIVERY FEE.
 *
 * THE FEE IS THE LOAD-BEARING ONE. Lean has no `deliveryCharge`, `deliveryFee` or
 * `shippingFee` anywhere, and following that keeps this entire feature OFF THE
 * MONEY PATH: nothing here touches `transaction`, `ledger_entry` or an amount, so
 * there is no new idempotency key, no atomic multi-table money write and no
 * refund case. `shop_order` hangs off a transaction that already settled —
 * deciding where a bottle goes cannot change what it cost. Preserve that if this
 * is ever extended; a fee is its own slice with its own decision.
 *
 * AND THE ONE THING NOT COPIED, which is why the columns look like this. Lean's
 * `addressDetail.js` collects two inputs and sends one of them as four different
 * address fields, writes the landmark where the street belongs, hardcodes
 * `areaId`/`regionId` to 1, and ships the literal text `'string'` in two more. A
 * driver then gets a house number in the block field. Every optional component
 * here is NULLABLE with no default: if Places cannot resolve one, it is absent,
 * and absent is something a driver can act on. `area` and `governorate` are free
 * text rather than ids into tables that do not exist — a hardcoded `areaId: 1` is
 * what an id column with nothing behind it becomes.
 */

import { check, index, pgEnum, pgTable, text } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { timestamptz } from './_shared';
import { member } from './member';
import { salon } from './salon';
import { transaction } from './transaction';

export const orderFulfilment = pgEnum('order_fulfilment', ['pickup', 'delivery']);
export const orderStatus = pgEnum('order_status', ['preparing', 'ready', 'closed']);

/** The lifecycle, in order. Index position IS the rank — see `routes/orders.ts`. */
export const ORDER_STATUS_FLOW = ['preparing', 'ready', 'closed'] as const;
export type OrderStatus = (typeof ORDER_STATUS_FLOW)[number];

/**
 * `text`, AND THE REASON IS AN INVARIANT RATHER THAN TASTE.
 *
 * `scripts/verify-constraints.sql` § 4 bans the whole float family and refuses
 * `numeric` with them — deliberately blanket, because the `%_fils` naming rule
 * "only catches money that was NAMED correctly" and a `legacy_price real` would
 * otherwise pass every check while putting a float one join away from a total.
 * Written first as `numeric(9,6)`, these columns tripped it, which is the
 * invariant doing its job.
 *
 * Nothing in this build does ARITHMETIC on a coordinate — it goes to a map — so
 * text costs nothing and needs no adjudication about which numerics are safe.
 * The shape and range are CHECKed in migration 0045 instead, casting inside the
 * expression rather than in the column type.
 */
const coordinate = (name: string) => text(name);

export const memberAddress = pgTable(
  'member_address',
  {
    id: text('id').primaryKey(),
    memberId: text('member_id')
      .notNull()
      .references(() => member.id, { onDelete: 'restrict' }),
    /** Her own name for it — Lean's `saveAs`, and what makes a book reusable. */
    label: text('label').notNull(),

    /** The parts a Kuwaiti address actually has. Undeliverable without these. */
    block: text('block').notNull(),
    street: text('street').notNull(),
    building: text('building').notNull(),

    /** Genuinely optional in a real address. NULL, never a placeholder. */
    floor: text('floor'),
    apartment: text('apartment'),
    area: text('area'),
    governorate: text('governorate'),
    instructions: text('instructions'),

    latitude: coordinate('latitude'),
    longitude: coordinate('longitude'),

    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
    /**
     * Soft-deleted, so an order placed to an address she later removes still has
     * a row to point at. `product.active`'s reasoning.
     */
    deletedAt: timestamptz('deleted_at'),
  },
  (t) => [
    index('member_address_member_idx').on(t.memberId, t.createdAt.desc()),
    check('member_address_label_not_blank', sql`length(btrim(${t.label})) > 0`),
    check('member_address_block_not_blank', sql`length(btrim(${t.block})) > 0`),
    check('member_address_street_not_blank', sql`length(btrim(${t.street})) > 0`),
    check('member_address_building_not_blank', sql`length(btrim(${t.building})) > 0`),
    /** Both or neither: a latitude with no longitude renders as the Gulf of Guinea. */
    check(
      'member_address_coordinates_are_a_pair',
      sql`(${t.latitude} IS NULL) = (${t.longitude} IS NULL)`,
    ),
  ],
);

export const shopOrder = pgTable(
  'shop_order',
  {
    /**
     * THE TRANSACTION IS THE KEY, not a surrogate with a unique index. An order
     * has exactly one fulfilment, so a second one is not storable at all.
     *
     * It is also what keeps this table off the money path: the identity is
     * borrowed from the row that holds the amount, so there is nothing here to
     * disagree with `transaction.amount_fils`. `db/schema/shopOrder.ts` carries
     * that argument in full — it is the one this table had to be reconciled
     * with rather than an exception to.
     */
    transactionId: text('transaction_id')
      .primaryKey()
      .references(() => transaction.id, { onDelete: 'restrict' }),
    salonId: text('salon_id')
      .notNull()
      .references(() => salon.id, { onDelete: 'restrict' }),
    memberId: text('member_id')
      .notNull()
      .references(() => member.id, { onDelete: 'restrict' }),

    fulfilment: orderFulfilment('fulfilment').notNull(),
    status: orderStatus('status').notNull().default('preparing'),

    /**
     * Provenance only, and nullable because she may delete the address later.
     * The columns below are the SNAPSHOT, and they are what a driver reads —
     * `shop_order_line` snapshots `name` and `unit_price_fils` for the same
     * reason, and an address is worse because she can edit it after ordering.
     */
    addressId: text('address_id').references(() => memberAddress.id, {
      onDelete: 'restrict',
    }),
    addressLabel: text('address_label'),
    block: text('block'),
    street: text('street'),
    building: text('building'),
    floor: text('floor'),
    apartment: text('apartment'),
    area: text('area'),
    governorate: text('governorate'),
    instructions: text('instructions'),
    latitude: coordinate('latitude'),
    longitude: coordinate('longitude'),

    /**
     * SET ONLY BY `services/erasure.ts`, and the reason it is a column rather
     * than a relaxed CHECK. (DECISIONS.md #97, migration 0048.)
     *
     * Erasure legitimately creates the one state
     * `shop_order_delivery_has_an_address` forbids: a delivery order with no
     * address. Dropping the three `IS NOT NULL`s to admit it would also admit
     * the BUG the constraint exists for — an order path that forgot to copy the
     * snapshot. This stamp makes the erased state REPRESENTABLE instead: the
     * live-delivery arm now requires it to be NULL, the erased arm requires it
     * to be set, and `services/order.ts` never writes it. So a forgotten
     * snapshot is refused exactly as before.
     *
     * A pickup can never carry it — there was no address to erase.
     */
    addressErasedAt: timestamptz('address_erased_at'),

    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
    readyAt: timestamptz('ready_at'),
    closedAt: timestamptz('closed_at'),
  },
  (t) => [
    index('shop_order_salon_status_idx').on(t.salonId, t.status, t.createdAt.desc()),
    index('shop_order_member_idx').on(t.memberId, t.createdAt.desc()),
    /**
     * A LIVE delivery HAS the three required parts; a pickup has NONE of them;
     * an ERASED delivery has none of them and says so. One CHECK rather than
     * three columns' worth, so "pickup with a street" is not a storable state
     * — pickup is a fork, not a delivery with empty fields.
     *
     * THE THIRD ARM IS MIGRATION 0048 AND DECISIONS.md #97. Erasure has to reach
     * the snapshot — a street beside a member row reading "Deleted account" is
     * the worst of the two outcomes — and this is the version of admitting it
     * that does not also admit a forgotten snapshot. `address_erased_at IS NULL`
     * on the live arm is the half that keeps the original guarantee: a row
     * cannot carry a street and an erasure stamp at once.
     *
     * Restated from migration 0048 so it is legible from the schema too; the
     * migration is the authority and carries the full argument.
     */
    check(
      'shop_order_delivery_has_an_address',
      sql`(${t.fulfilment} = 'delivery'
             AND ${t.addressErasedAt} IS NULL
             AND ${t.block} IS NOT NULL AND ${t.street} IS NOT NULL AND ${t.building} IS NOT NULL)
          OR (${t.fulfilment} = 'delivery'
             AND ${t.addressErasedAt} IS NOT NULL
             AND ${t.addressId} IS NULL AND ${t.addressLabel} IS NULL
             AND ${t.block} IS NULL AND ${t.street} IS NULL AND ${t.building} IS NULL
             AND ${t.floor} IS NULL AND ${t.apartment} IS NULL AND ${t.area} IS NULL
             AND ${t.governorate} IS NULL AND ${t.instructions} IS NULL
             AND ${t.latitude} IS NULL AND ${t.longitude} IS NULL)
          OR (${t.fulfilment} = 'pickup'
             AND ${t.addressErasedAt} IS NULL
             AND ${t.addressId} IS NULL AND ${t.addressLabel} IS NULL
             AND ${t.block} IS NULL AND ${t.street} IS NULL AND ${t.building} IS NULL
             AND ${t.floor} IS NULL AND ${t.apartment} IS NULL AND ${t.area} IS NULL
             AND ${t.governorate} IS NULL AND ${t.instructions} IS NULL
             AND ${t.latitude} IS NULL AND ${t.longitude} IS NULL)`,
    ),
    check(
      'shop_order_coordinates_are_a_pair',
      sql`(${t.latitude} IS NULL) = (${t.longitude} IS NULL)`,
    ),
    /**
     * `ready_at` is set on the way to ready and KEPT when it closes, so a closed
     * order still records when it became ready. That is why this is a three-arm
     * CHECK rather than `(status = 'ready') = (ready_at IS NOT NULL)`.
     */
    check(
      'shop_order_ready_at_matches_status',
      sql`(${t.status} = 'preparing' AND ${t.readyAt} IS NULL AND ${t.closedAt} IS NULL)
          OR (${t.status} = 'ready' AND ${t.readyAt} IS NOT NULL AND ${t.closedAt} IS NULL)
          OR (${t.status} = 'closed' AND ${t.closedAt} IS NOT NULL)`,
    ),
  ],
);
