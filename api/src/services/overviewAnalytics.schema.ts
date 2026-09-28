/**
 * THE WIRE SHAPES THIS SLICE SERVES, AS ZOD — FOR TRUNK TO LAND IN `packages/types`.
 *
 * `packages/types` is trunk-owned (CLAUDE.md § Lanes), so these live in `api/`
 * until trunk moves them. They are not decoration: `overviewAnalytics.int.test.ts`
 * and `customerRecords.int.test.ts` `.parse()` every response through them, so the
 * serialiser and the proposed contract cannot drift while they sit here.
 *
 * House style: `.nullable()` means REQUIRED ON THE WIRE, permitted to be null
 * (memory: "Nullable is required on the wire"). Nothing here is `.optional()`.
 * `.strict()` on the objects so an undeclared key fails the spec rather than
 * being stripped in transit — the trap STATUS.md names.
 */

import { z } from 'zod';
import { DateTimeSchema, FilsSchema, IdSchema, ShopOrderSchema } from '@avo/types';

const PermissionNameSchema = z.enum([
  'dashboard',
  'appointments',
  'shop',
  'loyalty',
  'team',
  'scanner',
  'charges',
  'void',
  'marketing',
]);

export const WithheldSchema = z
  .object({
    status: z.literal('withheld'),
    reason: z.enum(['permission', 'module_off', 'not_per_branch']),
    /** Non-null exactly when `reason` is `permission`. */
    permission: PermissionNameSchema.nullable(),
  })
  .strict();

/** A block the caller may see, or the reason she may not. */
function block<T extends z.ZodRawShape>(shape: T) {
  return z.discriminatedUnion('status', [
    z.object({ status: z.literal('ok'), ...shape }).strict(),
    WithheldSchema,
  ]);
}

const Count = z.number().int().nonnegative();
/** Basis points, 0–10000, rounded half up. Null when the denominator is 0. */
const BasisPoints = z.number().int().min(0).max(10000).nullable();

/** Null at `branch=all`. Of `total` rows behind the block, `assumed` had an inferred branch. */
export const BranchAssumedSchema = z
  .object({ assumed: Count, total: Count })
  .strict()
  .nullable();

/** `services/period.ts § serialiseWindow`. */
export const AnalyticsWindowSchema = z
  .object({
    token: z.string().min(1),
    basis: z.enum(['rolling', 'calendar']),
    from: DateTimeSchema,
    to: DateTimeSchema,
    days: z.number().int().positive(),
    fromDate: z.string().nullable(),
    toDate: z.string().nullable(),
    timezone: z.string().min(1),
  })
  .strict();

const ServiceRowSchema = z
  .object({ serviceId: IdSchema, name: z.string(), bookings: Count, revenueFils: FilsSchema.nonnegative() })
  .strict();

const MethodTotalSchema = z
  .object({ count: Count, fils: FilsSchema.nonnegative(), shareBp: BasisPoints })
  .strict();

export const OverviewAnalyticsSchema = z
  .object({
    asOf: DateTimeSchema,
    window: AnalyticsWindowSchema,
    branchId: IdSchema.nullable(),
    branchName: z.string().nullable(),
    loyaltyMode: z.enum(['tiers', 'stamps']),
    modules: z.object({ booking: z.boolean(), shop: z.boolean() }).strict(),

    /** Widget 2. `appointments`. */
    topServices: block({
      byBookings: z.array(ServiceRowSchema).max(5),
      byRevenue: z.array(ServiceRowSchema).max(5),
      branchAssumed: BranchAssumedSchema,
    }),
    /** Widget 3. `team`. Every artist of the salon, zeros included. */
    artists: block({
      items: z.array(
        z
          .object({
            artistId: IdSchema,
            name: z.string(),
            bookings: Count,
            noShows: Count,
            revenueFils: FilsSchema.nonnegative(),
          })
          .strict(),
      ),
      branchAssumed: BranchAssumedSchema,
    }),
    /** Widget 4. Sparse; weekday 0 = Sunday; both in the SALON'S zone. */
    busiestTimes: block({
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
      branchAssumed: BranchAssumedSchema,
    }),
    /** Widget 5. Not the period: today and the next 7 salon days. `next` needs `appointments`. */
    upcoming: z
      .object({
        status: z.literal('ok'),
        today: Count,
        next7Days: Count,
        branchAssumed: BranchAssumedSchema,
        next: block({
          items: z
            .array(
              z
                .object({
                  bookingId: IdSchema,
                  startsAt: DateTimeSchema,
                  customerName: z.string(),
                  memberId: IdSchema.nullable(),
                  serviceName: z.string(),
                  artistName: z.string(),
                  branchId: IdSchema,
                  branchName: z.string(),
                  branchAssumed: z.boolean(),
                })
                .strict(),
            )
            .max(5),
        }),
      })
      .strict(),
    /** Widget 6. */
    noShows: block({
      completed: Count,
      noShows: Count,
      rateBp: BasisPoints,
      depositsHeld: z.object({ bookings: Count, fils: FilsSchema.nonnegative() }).strict(),
      branchAssumed: BranchAssumedSchema,
    }),
    /** Widget 7a. Not per branch. Sunday-first salon-local weeks, zeros included. */
    newMembers: block({
      total: Count,
      weeks: z.array(
        z
          .object({
            weekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
            count: Count,
            partial: z.boolean(),
          })
          .strict(),
      ),
    }),
    /** Widget 7b. */
    visitors: block({
      total: Count,
      firstVisit: Count,
      returning: Count,
      branchAssumed: BranchAssumedSchema,
    }),
    /** Widget 8. Not per branch. The mode the salon is in, only. */
    loyalty: z.union([
      z
        .object({
          status: z.literal('ok'),
          mode: z.literal('tiers'),
          tiers: z.array(z.object({ tier: z.string(), members: Count }).strict()),
          untiered: Count,
        })
        .strict(),
      z
        .object({
          status: z.literal('ok'),
          mode: z.literal('stamps'),
          stampTarget: Count,
          buckets: z.array(z.object({ stamps: Count, members: Count }).strict()),
        })
        .strict(),
      WithheldSchema,
    ]),
    /** Widget 9. Not per branch. */
    wallet: block({
      loadedFils: FilsSchema.nonnegative(),
      bonusFils: FilsSchema.nonnegative(),
      topups: Count,
      spentFils: FilsSchema.nonnegative(),
      liabilityFils: FilsSchema.nonnegative(),
    }),
    /** Widget 10. Not per branch. Top-ups by method; spend is always the wallet. */
    paymentMix: block({
      topups: z
        .object({ knet: MethodTotalSchema, card: MethodTotalSchema, applepay: MethodTotalSchema })
        .strict(),
      walletSpend: z.object({ count: Count, fils: FilsSchema.nonnegative() }).strict(),
    }),
    /** Widget 11. `module_off` before `permission` (`shop`). */
    shop: block({
      orders: Count,
      ordersByStatus: z.object({ preparing: Count, ready: Count, closed: Count }).strict(),
      topProducts: z
        .array(
          z
            .object({
              productId: IdSchema,
              name: z.string(),
              units: Count,
              revenueFils: FilsSchema.nonnegative(),
            })
            .strict(),
        )
        .max(5),
      revenueFils: FilsSchema.nonnegative(),
      branchAssumed: BranchAssumedSchema,
    }),
    /** Widget 12. Not per branch; `marketing`. No open rate — nothing records one. */
    campaigns: block({
      sent: Count,
      reached: Count,
      reach: Count,
      items: z
        .array(
          z
            .object({
              campaignId: IdSchema,
              title: z.string(),
              audience: z.string(),
              channel: z.string(),
              sentAt: DateTimeSchema,
              reached: Count,
              reach: Count,
              result: z.string().nullable(),
            })
            .strict(),
        )
        .max(20),
      truncated: z.boolean(),
    }),
  })
  .strict();

export type OverviewAnalyticsWire = z.infer<typeof OverviewAnalyticsSchema>;

/**
 * `GET /v1/salons/{id}/orders` — one row. `ShopOrderSchema` plus the three
 * member fields the board already served (lane C checks them by hand today)
 * plus the two this slice adds, `lines` and `totalFils`.
 */
export const ShopOrderLineSchema = z
  .object({
    productId: IdSchema,
    name: z.string().min(1),
    qty: z.number().int().min(1).max(99),
    unitPriceFils: FilsSchema.positive(),
    lineTotalFils: FilsSchema.positive(),
  })
  .strict();

export const MerchantShopOrderSchema = ShopOrderSchema.extend({
  memberName: z.string(),
  /** Null when erased — `http/serialise.ts § serialiseMemberContact`. */
  memberPhone: z.string().nullable(),
  memberErased: z.boolean(),
  lines: z.array(ShopOrderLineSchema),
  /** What left her wallet: `-amount_fils` on the order's own `shop` transaction. */
  totalFils: FilsSchema.positive(),
}).strict();

/** The board's envelope: the house page plus `truncated`, which now means "there is another page". */
export const OrderBoardSchema = z
  .object({
    items: z.array(MerchantShopOrderSchema),
    truncated: z.boolean(),
    nextCursor: z.string().nullable(),
  })
  .strict();
