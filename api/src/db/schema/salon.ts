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
  uuid,
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
    /**
     * "Salmiya". NULLABLE — migration 0037 added it to a table with rows in it,
     * and a backfilled city would be an invented fact about a real salon.
     *
     * WHY IT EXISTS NOW. The designed onboarding wizard's step 1 requires it
     * (`wizReady` gates Continue on name + city + phone), the console renders it
     * in the salon list row and the editor header, and there was no column — so
     * `POST /v1/platform/salons` would have had to silently drop one of the three
     * fields the wizard insists on. `routes/platformConsole.ts` had already
     * recorded the absence: "NO `city`. `salon` has no city column". A CONTRACT
     * ADDITION, reported; `packages/types` § SalonSchema is trunk's to extend.
     *
     * Not a branch name dressed up as a city, which is what that comment refused
     * to do. A salon's city is where the business is; its branches are where its
     * chairs are, and Amara has two of those in two different cities.
     */
    city: text('city'),
    /**
     * The owner's WhatsApp number, E.164 — the wizard's "Owner contact
     * (WhatsApp)", and the DESTINATION of the invite the design promises
     * ("Creating the salon sends the owner a WhatsApp invite with their dashboard
     * sign-in").
     *
     * NULLABLE for the same reason `city` is: 0037 landed on a populated table.
     *
     * ON THE SALON RATHER THAN ON THE INVITE ROW. `staff_password_reset` is an
     * outbox and its rows are consumed; the owner contact is the durable answer to
     * "who does AVO call about this account", and re-issuing an invite must not
     * require re-typing the number. It is also NOT on `staff_user`: putting a
     * phone there would add a contact field to every scanner account across four
     * surfaces, which is a different decision than this one.
     *
     * IT IS NOT SERVED BY `GET /salons/{id}`. That endpoint is readable by any
     * authenticated principal of the salon — the customer wallet reads it for the
     * name and brand colour — and the owner's personal number is not a
     * customer-facing fact. `routes/salons.ts § serialiseSalon` says so at the
     * omission.
     */
    ownerPhone: text('owner_phone'),
    plan: salonPlan('plan').notNull().default('starter'),
    /**
     * Drives the white-label token set.
     *
     * VALIDATED THROUGH `deriveBrandSet()` AT BOTH DOORS —
     * `POST /v1/platform/salons` and `PATCH /salons/{id}` — by
     * `api/src/services/brandColor.ts`.
     *
     * This comment used to say "Validated through deriveBrandSet() at onboarding"
     * and NOTHING DID IT. There was no create endpoint at all, and the update
     * path's only guard was the hex CHECK below, so `#FFFF00` was a storable brand
     * colour. A comment asserting a check that does not exist is worse than no
     * comment: it stops the next reader looking. Third instance of that class in
     * this build, and the reason the sentence above names the module rather than
     * the intention.
     */
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

    /**
     * IANA zone id. THE zone every naive wall-clock value in this schema is
     * resolved against — `business_hours` below, `artist.windows`, and
     * `happy_hour.from`/`.to`. Never the process zone: docker-compose.yml sets
     * TZ=UTC, so an unzoned conversion offers a Kuwait salon's 10:00 at 13:00
     * and, for a happy hour, applies the wrong earning multiplier. One of those
     * is a mis-booked appointment; the other is money.
     *
     * An id rather than a stored offset because "10:00 local" is two different
     * instants across the year in any DST zone, and no integer fixes that. See
     * migration 0010 and api/src/time/zone.ts.
     *
     * Validity is enforced at the write (`parseTimeZone`), not by a CHECK: the
     * tz database is mutable, so "is this a real zone" is not an IMMUTABLE
     * predicate and Postgres will not accept it in a constraint.
     */
    timezone: text('timezone').notNull().default('Asia/Kuwait'),

    businessHours: jsonb('business_hours').$type<BusinessHours>().notNull(),
    /** Handles, never URLs — api-contract.md § SocialLink. Derive the URL on read. */
    social: jsonb('social')
      .$type<SocialLink[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /**
     * The merchant's receipt channels (DECISIONS.md #88, migration 0047).
     *
     * `whatsapp_enabled` was stored, merchant-editable, served in the payload,
     * declared in `SalonSchema` — and consulted by NOTHING.
     * `services/receipts.ts` queued a WhatsApp job unconditionally, so
     * SAL-LUMIERE shipped `false` and had one queued for every charge. It is
     * read now, in `decideReceiptChannels`.
     *
     * TWO BOOLEANS WITH A FLOOR, not an enum: `salon_receipt_channel_floor`
     * makes both-off unstorable, so the four states a second boolean would
     * imply are three and none of them is "no receipt". An enum would have
     * retired `whatsappEnabled` from a live contract; this is additive.
     *
     * `email_enabled` DEFAULTS TRUE and that is the current behaviour rather
     * than a policy: `queueReceipts` already queued email whenever there was a
     * verified address. It also has to be, or the CHECK would fail on the seed.
     */
    whatsappEnabled: boolean('whatsapp_enabled').notNull().default(false),
    emailEnabled: boolean('email_enabled').notNull().default(true),

    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    // Non-negotiable #9 lives at onboarding, but a colour that isn't even a hex
    // must never reach the token deriver.
    check('salon_brand_color_is_hex', sql`${t.brandColor} ~ '^#[0-9A-Fa-f]{6}$'`),
    // api-contract.md: merchant-set booking deposit, 1000–10000 fils.
    check('salon_deposit_in_range', sql`${t.depositFils} BETWEEN 1000 AND 10000`),
    /**
     * 5 ≤ n ≤ 1440, and it REPLACES `salon_no_show_return_positive` (`> 0`) rather
     * than sitting beside it — migration 0051. A `> 0` alongside a `>= 5` can
     * never be the constraint that fires, and a constraint that cannot fire reads
     * to the next person as evidence of a lower regime that does not exist.
     * `salon_deposit_in_range` one line up is the same shape for the same reason:
     * one named range per bounded column.
     *
     * THE CEILING IS THE NEW HALF. `parseNoShowReturnMinutes` refused only `<= 0`
     * and this CHECK said no more, so `525600` — one year — was a storable
     * no-show window, driven against the real API. That number is read TWICE:
     * once as the delay before a missed slot's deposit returns, and once by
     * `findApplicableHold` as the early-arrival grace that decides which held
     * deposit a charge may consume. A year-long grace makes every hold a member
     * owns "arriving now". The argument for both ends is in
     * `routes/salons.ts § parseNoShowReturnMinutes`.
     *
     * IT IS HERE AS WELL AS THERE because the column has two write doors —
     * `PATCH /salons/{id}` and `PATCH /v1/platform/salons/{id}` — and because a
     * direct UPDATE is a third. `brandColor`'s comment above records what a guard
     * on one door and not the other costs.
     */
    check('salon_no_show_return_in_range', sql`${t.noShowReturnMinutes} BETWEEN 5 AND 1440`),
    check('salon_timezone_not_blank', sql`length(btrim(${t.timezone})) > 0`),
    /**
     * THE FLOOR, AND IT IS THE CONSTRAINT RATHER THAN A HANDLER. A receipt is "a
     * record-keeping obligation, not marketing" (design/README.md § Known gaps
     * 7), so a merchant may choose a channel and may not choose silence. In the
     * database because a handler that remembers is not the same guarantee, and
     * because a direct SQL edit must not be able to produce it either.
     */
    check('salon_receipt_channel_floor', sql`${t.whatsappEnabled} OR ${t.emailEnabled}`),
    check('salon_stamp_target_positive', sql`${t.stampTarget} IS NULL OR ${t.stampTarget} > 0`),
    // An empty string is not a translation, it is a rendering bug waiting to
    // happen: `'' ?? name` is `''`, so a blank Arabic name defeats the client's
    // fallback and paints an empty heading. Absent is NULL; present is present.
    check('salon_name_ar_not_blank', sql`${t.nameAr} IS NULL OR length(btrim(${t.nameAr})) > 0`),
    // Absent is NULL; present is present. Same rule as `name_ar` above, and for
    // the same reason: `'' ?? name` is `''`, and a city rendered as an empty
    // string in "Salmiya · Growth plan" leaves a stray separator.
    check('salon_city_not_blank', sql`${t.city} IS NULL OR length(btrim(${t.city})) > 0`),
    // The same shape `member_phone_is_e164` enforces and `parseE164` produces, so
    // a number that passes the boundary cannot be refused here with a 500.
    check(
      'salon_owner_phone_is_e164',
      sql`${t.ownerPhone} IS NULL OR ${t.ownerPhone} ~ '^\\+[1-9][0-9]{6,14}$'`,
    ),
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
    /**
     * A CLOSED branch, not a deleted one. NULL means open.
     *
     * `transaction.branch_id` and `booking.branch_id` are both NOT NULL and
     * `ON DELETE restrict`, so a branch that has ever taken money cannot be
     * removed — and should not be. Per-branch revenue, a customer's receipt and
     * an appointment history all name it, and that record has to outlive the
     * merchant's interest in operating there. Same rule as `happy_hour`: the
     * receipts refer to it, switch it off instead.
     *
     * A closed branch is excluded from `resolveBranch` (so it attracts no new
     * money), from the happy-hour and boost branch pickers, and from the
     * `branches` list every client renders. Its historic rows keep resolving to
     * a row that still has a name.
     */
    closedAt: timestamptz('closed_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('branch_salon_idx').on(t.salonId),
    uniqueIndex('branch_salon_name_uq').on(t.salonId, t.name),
    check('branch_name_ar_not_blank', sql`${t.nameAr} IS NULL OR length(btrim(${t.nameAr})) > 0`),
  ],
);

/**
 * One-time report download tokens — migration 0036.
 *
 * A plain anchor to a `.csv` route carries no authorization header, so the
 * natural download saved a JSON 401 named `sales.csv` (Lane C's finding). The
 * dashboard mints one of these immediately before the anchor navigates; the CSV
 * route spends it. Opaque token, sha256-stored, 60 seconds, single-use under the
 * conditional-spend UPDATE, and the minting staff member's PERMISSION IS
 * RE-CHECKED at redemption — routes/reports.ts argues each half.
 */
export const reportDownload = pgTable(
  'report_download',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    staffId: text('staff_id').notNull(),
    salonId: text('salon_id')
      .notNull()
      .references(() => salon.id, { onDelete: 'restrict' }),
    kind: text('kind').notNull(),
    branchId: text('branch_id').references(() => branch.id, { onDelete: 'restrict' }),
    period: text('period').notNull(),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamptz('expires_at').notNull(),
    usedAt: timestamptz('used_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('report_download_token_uq').on(t.tokenHash),
    check('report_download_expires_after_creation', sql`${t.expiresAt} > ${t.createdAt}`),
  ],
);
