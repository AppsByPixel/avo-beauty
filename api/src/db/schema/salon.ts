/**
 * Salon and Branch — api-contract.md § Salon / § Branch.
 *
 * "One wallet, one loyalty status, valid at every branch. Branch scopes staff
 * access and reporting, never the customer's balance." That is why `member` has
 * a `salon_id` and no `branch_id`, and why `transaction` carries both.
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
import type { z } from 'zod';
import type { BusinessHoursSchema, SocialLink, Tier } from '@avo/types';
import { filsColumn, timestamptz } from './_shared';

export const salonPlan = pgEnum('salon_plan', ['starter', 'growth', 'pro']);
export const loyaltyMode = pgEnum('loyalty_mode', ['tiers', 'stamps']);
export const tierName = pgEnum('tier_name', ['bronze', 'silver', 'gold', 'black']);

type BusinessHours = z.infer<typeof BusinessHoursSchema>;

export const salon = pgTable(
  'salon',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    /**
     * The Arabic salon name. NULLABLE, and the null is the point.
     *
     * Non-negotiable #12: Arabic is a first-class layout, not a translation
     * pass. A salon that has not supplied an Arabic name has not supplied one —
     * defaulting this to `name` would make "untranslated" indistinguishable from
     * "translated to the same string" and would hand the client a value that
     * looks authored. NULL says the true thing and the client falls back to
     * `name`, the same way an untranslated legal document falls back to `en`.
     */
    nameAr: text('name_ar'),
    plan: salonPlan('plan').notNull().default('starter'),
    /** Drives the white-label token set. Validated through deriveBrandSet() at onboarding. */
    brandColor: text('brand_color').notNull(),
    moduleBooking: boolean('module_booking').notNull().default(false),
    moduleShop: boolean('module_shop').notNull().default(false),

    loyaltyMode: loyaltyMode('loyalty_mode').notNull(),
    /**
     * The tier ladder, as a whole. Held as one jsonb document specifically so
     * that publishing it is a single row update — build-plan.md calls a
     * half-published tier ladder a money bug, and one column cannot half-write.
     */
    tiers: jsonb('tiers').$type<Tier[]>(),
    stampTarget: integer('stamp_target'),
    stampReward: text('stamp_reward'),
    /** "تصفيف شعر مجاني". The reward is customer-facing copy, so it needs both. */
    stampRewardAr: text('stamp_reward_ar'),

    depositFils: filsColumn('deposit_fils').notNull(),
    noShowReturnMinutes: integer('no_show_return_minutes').notNull().default(60),
    businessHours: jsonb('business_hours').$type<BusinessHours>().notNull(),
    /** Handles, never URLs — api-contract.md § SocialLink. Derive the URL on read. */
    social: jsonb('social')
      .$type<SocialLink[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    whatsappEnabled: boolean('whatsapp_enabled').notNull().default(false),

    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    // Non-negotiable #9 lives at onboarding, but a colour that isn't even a hex
    // must never reach the token deriver.
    check('salon_brand_color_is_hex', sql`${t.brandColor} ~ '^#[0-9A-Fa-f]{6}$'`),
    // api-contract.md: merchant-set booking deposit, 1000–10000 fils.
    check('salon_deposit_in_range', sql`${t.depositFils} BETWEEN 1000 AND 10000`),
    check('salon_no_show_return_positive', sql`${t.noShowReturnMinutes} > 0`),
    check('salon_stamp_target_positive', sql`${t.stampTarget} IS NULL OR ${t.stampTarget} > 0`),
    // An empty string is not a translation, it is a rendering bug waiting to
    // happen: `'' ?? name` is `''`, so a blank Arabic name defeats the client's
    // fallback and paints an empty heading. Absent is NULL; present is present.
    check('salon_name_ar_not_blank', sql`${t.nameAr} IS NULL OR length(btrim(${t.nameAr})) > 0`),
    check(
      'salon_stamp_reward_ar_not_blank',
      sql`${t.stampRewardAr} IS NULL OR length(btrim(${t.stampRewardAr})) > 0`,
    ),
    // A salon in stamps mode with no target, or in tiers mode with no ladder,
    // has no answer to "what does this charge earn?".
    check(
      'salon_loyalty_config_complete',
      sql`(${t.loyaltyMode} = 'tiers' AND ${t.tiers} IS NOT NULL)
          OR (${t.loyaltyMode} = 'stamps' AND ${t.stampTarget} IS NOT NULL)`,
    ),
  ],
);

export const branch = pgTable(
  'branch',
  {
    id: text('id').primaryKey(),
    salonId: text('salon_id')
      .notNull()
      .references(() => salon.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    /**
     * The Arabic branch name. Without it an Arabic wallet renders "Salmiya" in
     * Latin inside otherwise-mirrored Arabic copy. Nullable for the reason
     * `salon.nameAr` is.
     *
     * NOT part of `branch_salon_name_uq`: two branches may share an Arabic name
     * only if they already share the Latin one, which the existing index
     * already refuses. Adding a second uniqueness rule over a mostly-NULL column
     * would constrain nothing and would block a salon from translating its
     * second branch before its first.
     */
    nameAr: text('name_ar'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('branch_salon_idx').on(t.salonId),
    uniqueIndex('branch_salon_name_uq').on(t.salonId, t.name),
    check('branch_name_ar_not_blank', sql`${t.nameAr} IS NULL OR length(btrim(${t.nameAr})) > 0`),
  ],
);
