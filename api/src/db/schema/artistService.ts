/**
 * Artist ↔ service — WHO DOES WHICH SERVICE. Migrations 0061 (the table) and
 * 0062 (the backfill).
 *
 * One row per "she does this". What it decides is who can be BOOKED to perform
 * a service: `POST /bookings`, `POST /salons/{id}/bookings`, both reschedules and
 * the reassign refuse an artist with no row here for the booking's service
 * (`services/artistService.ts § assertArtistPerformsService`).
 *
 * WHAT IT DOES NOT DECIDE: WHO MAY CHARGE FOR IT. `POST /charges` never reads
 * this table. The person at the till is a receptionist ringing up the visit,
 * not the person who performed it — a front desk that could only charge for
 * services it personally performs could charge for nothing — and a charge has
 * no artist on it at all. Assignment is a fact about the diary, not about the
 * money.
 *
 * A NEW SERVICE HAS NO ROWS, and so it is unbookable until the merchant assigns
 * someone. That is served, not hidden: `GET /salons/{id}/services` carries
 * `artistIds` on every row, and a service whose list does not meet the bookable
 * roster is one the wallet does not offer. It is still chargeable at the
 * counter the moment it exists.
 *
 * TENANCY IS IN THE SCHEMA. Both composite FKs share `salon_id`, so a row cannot
 * pair salon A's artist with salon B's service. Drizzle cannot express a
 * composite FK to a non-primary unique key, so — as for `artist.branch_id` in
 * 0044 — the constraints live in the migration and are not restated here.
 * `ON DELETE cascade`, and 0061 argues why a link is the one reference to an
 * artist or a service that should not be `restrict`.
 */

import { index, pgTable, primaryKey, text } from 'drizzle-orm/pg-core';
import { timestamptz } from './_shared';

export const artistService = pgTable(
  'artist_service',
  {
    artistId: text('artist_id').notNull(),
    serviceId: text('service_id').notNull(),
    salonId: text('salon_id').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'artist_service_pkey', columns: [t.artistId, t.serviceId] }),
    index('artist_service_service_idx').on(t.serviceId),
  ],
);
