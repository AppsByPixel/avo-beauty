/**
 * Artist — api-contract.md § Artist.
 *
 * "Artists do **not** need an AVO login." That single sentence is why this is
 * its own table rather than four columns bolted onto `staff_user`. A salon's
 * bookable people and its sign-in accounts are overlapping sets, not the same
 * set: a visiting colourist is bookable with no credential at all, and the
 * receptionist who holds `perms.team` is a login nobody books. Modelling them as
 * one row forces a fake staff account for every artist, and a fake staff account
 * is a row in the table the permission system reads.
 *
 * `staff_user_id` is therefore NULLABLE and UNIQUE-where-present: the optional
 * link that lets an artist who *does* have a scanner PIN edit her own hours
 * through `PUT /artists/me/availability`.
 *
 * THE `availability_source` COLUMN IS THE ENFORCEMENT POINT
 * --------------------------------------------------------
 * The contract says Google connect is "one-time and read-only for busy slots".
 * The dashboard draws that as a disabled set of day rows until you flip the
 * segmented control to Manual. Read-only in the client is a courtesy — the same
 * courtesy non-negotiable #7 says a hidden button is — so the state lives here
 * and `PUT /artists/{id}/availability` refuses a window edit while the row says
 * `google`. Switching to `manual` is an explicit, audited act, not a UI mode.
 *
 * `artist_google_source_requires_connection` is the half of that the database
 * can hold: a row cannot claim to be sourced from a calendar it is not connected
 * to. The reverse is allowed and normal — an artist may stay connected to Google
 * while her hours are set manually, which is exactly what "switch to Manual to
 * set hours here on their behalf" produces.
 *
 * `windows` is one jsonb document for the same reason `salon.tiers` is: a week
 * of hours is edited and saved as a whole, and seven columns would let a save
 * land half-applied.
 */

import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { timestamptz } from './_shared';
import { salon } from './salon';
import { staffUser } from './staff';

export const availabilitySource = pgEnum('availability_source', ['google', 'manual']);

/**
 * One day of the week, as the contract writes it:
 * `{ [dayOfWeek: 0-6]: { open: bool, from: "HH:mm", to: "HH:mm" } }`.
 *
 * `from` and `to` are NAIVE WALL-CLOCK STRINGS with no zone attached. See the
 * header of routes/artists.ts for exactly what that costs the day AVO signs a
 * salon outside Kuwait — it is a decision that belongs to the client, and this
 * comment exists so it is made knowingly rather than discovered.
 */
export interface ArtistWindow {
  open: boolean;
  from: string;
  to: string;
}

/** Keyed '0'..'6', JS `getDay()` order — 0 is Sunday, as in avo-promotions.js. */
export type ArtistWindows = Record<string, ArtistWindow>;

/** api-contract.md § Artist: `slotMinutes int // 15 | 20 | 30 | 45 | 60`. */
export const SLOT_MINUTES = [15, 20, 30, 45, 60] as const;

export const artist = pgTable(
  'artist',
  {
    id: text('id').primaryKey(),
    salonId: text('salon_id')
      .notNull()
      .references(() => salon.id, { onDelete: 'restrict' }),

    /**
     * The scanner login this artist edits her own hours from, when she has one.
     * NULL is the common case and the contract's default — see the file header.
     */
    staffUserId: text('staff_user_id').references(() => staffUser.id, {
      onDelete: 'restrict',
    }),

    name: text('name').notNull(),
    /** Nullable for the reason `salon.name_ar` is — absent is not the same as blank. */
    nameAr: text('name_ar'),

    availabilitySource: availabilitySource('availability_source').notNull().default('manual'),
    googleConnected: boolean('google_connected').notNull().default(false),

    slotMinutes: integer('slot_minutes').notNull().default(30),
    windows: jsonb('windows')
      .$type<ArtistWindows>()
      .notNull()
      .default(sql`'{}'::jsonb`),

    /**
     * A retired artist stays for old bookings to reference; she is simply no
     * longer bookable. Same reasoning as `service.active`.
     */
    active: boolean('active').notNull().default(true),

    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('artist_salon_idx').on(t.salonId),
    /**
     * One artist per staff login. Without this, two artist rows could point at
     * the same PIN account and `PUT /artists/me/availability` would have to pick
     * one — which is a coin toss deciding whose calendar gets edited.
     */
    uniqueIndex('artist_staff_user_uq')
      .on(t.staffUserId)
      .where(sql`staff_user_id IS NOT NULL`),

    check('artist_slot_minutes_allowed', sql`${t.slotMinutes} IN (15, 20, 30, 45, 60)`),
    /**
     * A row cannot claim its hours come from a calendar it is not connected to.
     * The other direction is deliberately permitted: connected + manual is the
     * normal state after a receptionist takes the wheel.
     */
    check(
      'artist_google_source_requires_connection',
      sql`${t.availabilitySource} <> 'google' OR ${t.googleConnected}`,
    ),
    check('artist_name_ar_not_blank', sql`${t.nameAr} IS NULL OR length(btrim(${t.nameAr})) > 0`),
  ],
);
