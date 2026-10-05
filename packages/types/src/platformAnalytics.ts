/**
 * THE WIRE SHAPE OF `GET /v1/platform/analytics`, AS ZOD.
 *
 * Landed by trunk from lane A's `api/src/services/platformAnalytics.schema.ts`
 * (2a2824f), verbatim bar the import line — the path `analytics.ts` took
 * (7152b5f → 4a9cbdb). `platformAnalytics.int.test.ts` `.parse()`s every
 * response through it, so the serialiser and the contract cannot drift.
 *
 * House style, as the Overview's: `.nullable()` means REQUIRED ON THE WIRE and
 * permitted to be null. Nothing is `.optional()`. Every object is `.strict()`,
 * so an undeclared key fails the spec instead of being stripped in transit.
 *
 * The one import that differs from the Overview's is the withheld shape: a
 * console block is withheld for a PLATFORM SECTION (`approvals`, `policies`),
 * not a staff permission, so its `permission` enum is the nine sections. There
 * is no `not_per_branch` — the console has no branch filter.
 */

import { z } from 'zod';
import { DateTimeSchema, FilsSchema, IdSchema } from './entities.js';

export const PlatformSectionNameSchema = z.enum([
  'analytics',
  'activity',
  'salons',
  'accounts',
  'admins',
  'controls',
  'approvals',
  'policies',
  'audit',
]);

export const PlatformWithheldSchema = z
  .object({
    status: z.literal('withheld'),
    reason: z.enum(['permission', 'module_off']),
    /** Non-null exactly when `reason` is `permission`. */
    permission: PlatformSectionNameSchema.nullable(),
  })
  .strict();

/** A block the caller may see, or the reason she may not. */
function block<T extends z.ZodRawShape>(shape: T) {
  return z.discriminatedUnion('status', [
    z.object({ status: z.literal('ok'), ...shape }).strict(),
    PlatformWithheldSchema,
  ]);
}

const Count = z.number().int().nonnegative();
const Money = FilsSchema.nonnegative();
/** Basis points, 0–10000, rounded half up. Null when the denominator is 0. */
const BasisPoints = z.number().int().min(0).max(10000).nullable();
/** A calendar month in the platform zone. */
export const MonthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);

const MethodFeeSchema = z.object({ topups: Count, feeFils: Money }).strict();
const MethodTotalSchema = z.object({ count: Count, fils: Money, shareBp: BasisPoints }).strict();

export const PlatformAnalyticsSchema = z
  .object({
    asOf: DateTimeSchema,
    /** `PLATFORM_TIMEZONE`. Every month boundary on this object is in it. */
    timezone: z.string().min(1),
    /** The selected month — the leaderboard's, the payment mix's, the heat map's. */
    month: MonthSchema,
    /** True when `month` is the current one, so its figures are month-to-date. */
    partial: z.boolean(),
    /** The history, oldest first, ending at `month`. Every series below has exactly these. */
    months: z.array(MonthSchema).min(1).max(24),
    /** The `?salon=` scope. Both null for every salon. */
    salonId: IdSchema.nullable(),
    salonName: z.string().nullable(),

    /** 1. AVO's commission: `sum(fee_fils)` on settled top-ups, by `settled_at`. */
    revenue: block({
      months: z.array(
        z
          .object({
            month: MonthSchema,
            feeFils: Money,
            topups: Count,
            byMethod: z
              .object({ knet: MethodFeeSchema, card: MethodFeeSchema, applepay: MethodFeeSchema })
              .strict(),
          })
          .strict(),
      ),
      thisMonthFils: Money,
      priorMonth: MonthSchema,
      priorMonthFils: Money,
    }),

    /** 2. Loaded (what customers paid), bonus credited, spent; and what is owed now. */
    money: block({
      months: z.array(
        z
          .object({ month: MonthSchema, loadedFils: Money, bonusFils: Money, spentFils: Money })
          .strict(),
      ),
      liabilityFils: Money,
      liabilityBySalon: z.array(
        z.object({ salonId: IdSchema, name: z.string(), liabilityFils: Money }).strict(),
      ),
    }),

    /** 3. Snapshot counts, plus new / active / dormant per month. */
    salons: block({
      total: Count,
      byPlan: z.object({ starter: Count, growth: Count, pro: Count }).strict(),
      branches: z.object({ open: Count, closed: Count }).strict(),
      months: z.array(
        z
          .object({ month: MonthSchema, newSalons: Count, active: Count, dormant: Count })
          .strict(),
      ),
    }),

    /** 4. Members per month, and the loyalty snapshot by mode. */
    members: block({
      total: Count,
      months: z.array(
        z.object({ month: MonthSchema, newMembers: Count, activeMembers: Count }).strict(),
      ),
      tiers: z
        .object({
          salons: Count,
          bronze: Count,
          silver: Count,
          gold: Count,
          black: Count,
          untiered: Count,
        })
        .strict(),
      stamps: z
        .object({
          salons: Count,
          buckets: z.array(
            z.object({ stampTarget: Count, stamps: Count, members: Count }).strict(),
          ),
        })
        .strict(),
    }),

    /** 5. Every salon in scope, the selected month, sorted by loaded. */
    leaderboard: block({
      rows: z.array(
        z
          .object({
            salonId: IdSchema,
            name: z.string(),
            modules: z.object({ booking: z.boolean(), shop: z.boolean() }).strict(),
            members: Count,
            activeMembers: Count,
            loadedFils: Money,
            spentFils: Money,
            avoRevenueFils: Money,
            /** Null when the salon's booking module is off. */
            bookings: Count.nullable(),
            /** Null when the booking module is off, or nothing was resolved. */
            noShowRateBp: BasisPoints,
            /** Null when the salon's shop module is off. */
            shopRevenueFils: Money.nullable(),
            liabilityFils: Money,
          })
          .strict(),
      ),
    }),

    /** 6. Top-ups in the selected month, by method — count, paid fils, share of value. */
    paymentMix: block({
      topups: Count,
      loadedFils: Money,
      methods: z
        .object({ knet: MethodTotalSchema, card: MethodTotalSchema, applepay: MethodTotalSchema })
        .strict(),
    }),

    /** 7. Salons with the booking module on. `module_off` at a scoped salon without it. */
    bookings: block({
      salons: Count,
      months: z.array(
        z
          .object({
            month: MonthSchema,
            bookings: Count,
            completed: Count,
            noShows: Count,
            rateBp: BasisPoints,
          })
          .strict(),
      ),
      depositsHeld: z.object({ bookings: Count, fils: Money }).strict(),
    }),

    /** 8. Withheld without `approvals`. Decision times are whole seconds. */
    campaigns: block({
      pendingNow: Count,
      months: z.array(
        z
          .object({
            month: MonthSchema,
            submitted: Count,
            approved: Count,
            rejected: Count,
            sent: Count,
            held: Count,
            medianDecisionSeconds: Count.nullable(),
            p90DecisionSeconds: Count.nullable(),
          })
          .strict(),
      ),
    }),

    /** 9. Withheld without `policies` (the support queue's own console gate). */
    support: block({
      openNow: z.object({ total: Count, avo: Count, salon: Count }).strict(),
      months: z.array(
        z.object({ month: MonthSchema, opened: Count, resolved: Count }).strict(),
      ),
    }),

    /** 10. Salons with the shop module on. `module_off` at a scoped salon without it. */
    shop: block({
      salons: Count,
      months: z.array(
        z.object({ month: MonthSchema, gmvFils: Money, orders: Count }).strict(),
      ),
      ordersByStatus: z.object({ preparing: Count, ready: Count, closed: Count }).strict(),
    }),

    /** 11. Sparse; weekday 0 = Sunday; each visit on ITS OWN SALON'S clock. */
    busiestTimes: block({
      clock: z.literal('salon_local'),
      cells: z.array(
        z
          .object({
            weekday: z.number().int().min(0).max(6),
            hour: z.number().int().min(0).max(23),
            visits: z.number().int().positive(),
          })
          .strict(),
      ),
      totalVisits: Count,
    }),
  })
  .strict();

export type PlatformAnalyticsWire = z.infer<typeof PlatformAnalyticsSchema>;
