/**
 * Every platform switch, fee and default — the owner console's CONTROLS screen.
 *
 * `AVO Owner Console.dc.html` § CONTROLS: "Every platform switch, fee and
 * default". Five switches, the flat KNET fee in fils, the card percentage, and
 * the booking deposit every new salon starts with. Migration 0032 creates it and
 * carries the long reasoning; this is the Drizzle side of the same table.
 *
 * THE COMMISSION IS WHY THIS IS A MONEY-PATH TABLE
 * -----------------------------------------------
 * `packages/types/src/money.ts` § DEFAULT_COMMISSION says, in its own comment,
 * "Configurable per platform in Owner → Controls; these are the defaults." It was
 * not configurable: `services/topup.ts` called `commissionFor(amount, method)`
 * with no third argument, so AVO's cut was a constant compiled into the server
 * and the console's stepper would have moved a number on a screen and changed
 * nothing. `services/platformSettings.ts` is what closes that.
 *
 * SINGLETON, and structurally rather than by convention — the same shape
 * `platform_messaging_policy` has, for the same reason. There is no salon column,
 * so there is nothing a salon-scoped route could select, and a merchant cannot
 * read or change AVO's take through any predicate she is allowed to write.
 *
 * WHY THE PERCENTAGE IS BASIS POINTS
 * ----------------------------------
 * The design's card control renders "2.5 %", which is a float on a screen.
 * Non-negotiable #1 keeps floats out of the database, and `db:verify` invariant 4
 * asserts that NO float-family column exists anywhere in the schema — including
 * `numeric`, which it refuses alongside the true floats because "#1 is that money
 * is an integer COUNT of fils". So the rate is stored as 250 basis points and
 * divided at the boundary, exactly as fils are divided at the display boundary.
 *
 * The column is `card_percent_bp` and not `card_percent` so that the unit cannot
 * be mistaken by somebody about to write `2.5` into it.
 */

import { fils } from '@avo/types';
import { sql } from 'drizzle-orm';
import { boolean, check, integer, pgTable, text } from 'drizzle-orm/pg-core';
import { filsColumn, timestamptz } from './_shared';

/**
 * The five switches the design draws, by its own ids.
 *
 * Exported as a list because both the PATCH route's field allow-list and its
 * audit detail need to iterate them, and a switch added to the table and
 * forgotten in one of those two places is a control that silently does nothing —
 * which is the exact defect this whole table exists to fix.
 */
export const PLATFORM_FLAGS = ['signups', 'booking', 'shop', 'wa', 'maintenance'] as const;
export type PlatformFlag = (typeof PLATFORM_FLAGS)[number];

/** The three fee/default steppers, and their design-drawn bounds. */
export const PLATFORM_SETTINGS_ID = 'avo' as const;

export const platformSettings = pgTable(
  'platform_settings',
  {
    id: text('id').primaryKey().notNull().default(PLATFORM_SETTINGS_ID),

    /**
     * The switches. Defaults are the design's own initial states: everything on
     * except maintenance mode, which is the one switch whose ON state is the
     * unusual one.
     */
    flagSignups: boolean('flag_signups').notNull().default(true),
    flagBooking: boolean('flag_booking').notNull().default(true),
    flagShop: boolean('flag_shop').notNull().default(true),
    flagWa: boolean('flag_wa').notNull().default(true),
    flagMaintenance: boolean('flag_maintenance').notNull().default(false),

    /**
     * AVO's commission, field by field from `DEFAULT_COMMISSION`.
     *
     * 150 / 250bp / 50 — checked against `packages/types/src/money.ts` rather
     * than recalled, because a default written from memory here would change
     * AVO's revenue the moment the table was created and nothing would report it.
     * `cardFlatFils` is 50; a draft of migration 0032 had 0.
     *
     * The defaults are declared here as well as in the migration, and they must
     * agree: `drizzle-kit generate` diffs this file against the schema, so a
     * column left without a default here would make the next generated migration
     * silently DROP the one 0032 set.
     */
    knetFlatFils: filsColumn('knet_flat_fils').notNull().default(fils(150)),
    cardPercentBp: integer('card_percent_bp').notNull().default(250),
    cardFlatFils: filsColumn('card_flat_fils').notNull().default(fils(50)),

    /** "The booking deposit each new salon starts with." Fils; the design renders KD. */
    newSalonDepositFils: filsColumn('new_salon_deposit_fils').notNull().default(fils(5000)),

    updatedBy: text('updated_by'),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    check('platform_settings_is_singleton', sql`${t.id} = 'avo'`),
    /**
     * The design's own stepper bounds, restated so the database refuses what the
     * screen could never have produced — the treatment
     * `platform_messaging_policy`'s caps get, and for the same reason: a row
     * written by a psql session or a future handler must not be able to express
     * what the UI cannot.
     */
    check('platform_settings_knet_fee_in_range', sql`${t.knetFlatFils} BETWEEN 0 AND 500`),
    /**
     * 0..5% IN HALF-POINT STEPS, AND THIS ONE IS LOAD-BEARING ARITHMETIC RATHER
     * THAN A UI ECHO.
     *
     * `commissionFor`'s `CommissionRates.cardPercent` is a percentage, so the
     * server hands it `cardPercentBp / 100` — a float division, which is the very
     * thing basis points were meant to avoid, displaced by one step. Probed over
     * bp 0..1000 and every exact half-fil boundary in 1..10,000,000 fils: 172,705
     * of 7,800,000 boundaries came out a fil apart, and 136 bp values are unsafe
     * somewhere (29 bp on 25.000 KD is 73 fils exactly, 72 through the float).
     *
     * The design's stepper (`AVO Owner Console.dc.html:1943`, ±0.5 clamped to 5)
     * only ever produces {0, 50, ..., 500}, and all eleven are provably exact. So
     * this CHECK is the design's bound written down, and it is what makes the
     * division in `services/platformSettings.ts` safe over the whole domain
     * instead of safe only at the default. Migration 0032 carries the numbers.
     */
    check('platform_settings_card_percent_in_range', sql`${t.cardPercentBp} BETWEEN 0 AND 500`),
    check('platform_settings_card_percent_is_half_a_point', sql`${t.cardPercentBp} % 50 = 0`),
    check('platform_settings_card_flat_non_negative', sql`${t.cardFlatFils} >= 0`),
    /**
     * `salon_deposit_in_range` puts a salon's own deposit between 1000 and 10000
     * fils, so a platform default outside that range would mint salons that
     * violate their own constraint on insert.
     */
    check(
      'platform_settings_deposit_in_range',
      sql`${t.newSalonDepositFils} BETWEEN 1000 AND 10000`,
    ),
  ],
);

export type PlatformSettingsRow = typeof platformSettings.$inferSelect;
