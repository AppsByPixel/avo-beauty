/**
 * Service — the priced lines a charge is built from.
 *
 * Not an entity in api-contract.md, because no client creates one: the scanner
 * reads `GET /salons/{id}/services` and posts back ids. But `POST /charges`
 * cannot exist without it. The basket total is computed HERE, from these rows,
 * never from a price the scanner sends — a client-supplied price is a client
 * that can charge 0.000 for a colour, and non-negotiable #2 says the server owns
 * the money.
 *
 * An unknown service id is a 400 at the boundary, not a line worth 0 fils. Lane
 * D found exactly that bug in the mock: a settled transaction with a real
 * reference and a voidable window, for work that does not exist.
 */

import { sql } from 'drizzle-orm';
import { boolean, check, index, pgTable, text } from 'drizzle-orm/pg-core';
import { filsColumn, timestamptz } from './_shared';
import { salon } from './salon';

export const service = pgTable(
  'service',
  {
    id: text('id').primaryKey(),
    salonId: text('salon_id')
      .notNull()
      .references(() => salon.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    priceFils: filsColumn('price_fils').notNull(),
    /** Retired services stay for old transactions to reference; they just can't be charged. */
    active: boolean('active').notNull().default(true),

    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('service_salon_idx').on(t.salonId),
    // A free service is a rounding bug waiting to be argued about at a counter.
    check('service_price_positive', sql`${t.priceFils} > 0`),
  ],
);
