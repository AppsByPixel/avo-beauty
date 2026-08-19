/**
 * The platform's own switches, fees and defaults — and the one place AVO's
 * commission is resolved from.
 *
 * WHAT THIS FILE IS FOR, in one sentence: `DEFAULT_COMMISSION` in
 * `packages/types/src/money.ts` documents itself as "Configurable per platform in
 * Owner → Controls; these are the defaults", and until this file existed it was
 * not configurable by anything. `services/topup.ts` called
 *
 *     commissionFor(input.amountFils, input.method)
 *
 * with no third argument, so AVO's cut was a constant compiled into the server,
 * and the owner console's stepper would have moved a number on a screen and
 * changed nothing about a single top-up. That is the shape this build keeps
 * finding — a capability that exists and goes unused, like
 * `PlatformMessagingPolicySchema` before 0028 and `isInQuietHours` before it was
 * called — and it is worth naming as such, because the defect is invisible from
 * either side alone: the constant is right, the column is right, and nothing
 * joins them.
 *
 * THE ROW IS A SINGLETON AND IS NOT OPTIONAL. Migration 0032 inserts it in the
 * same file that creates the table, so every deployment past 0032 has exactly one
 * row. `readPlatformSettings` therefore THROWS rather than falling back to
 * `DEFAULT_COMMISSION` on a missing row, and the choice is the money-path one: a
 * silent fallback would price a top-up at the compiled-in rate while the console
 * displayed something else, and nobody would ever see a difference until
 * reconciliation. A 500 on a broken deployment is the cheaper failure.
 */

import { commissionFor, type CommissionRates, type Fils, type PaymentMethod } from '@avo/types';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import {
  platformSettings,
  PLATFORM_FLAGS,
  PLATFORM_SETTINGS_ID,
  type PlatformFlag,
  type PlatformSettingsRow,
} from '../db/schema/platformSettings';

/** Anything with `.select()` — the pool, or an open transaction. */
export type Reader = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * The design's own stepper bounds, restated in TypeScript so the PATCH route can
 * refuse a bad value by NAME instead of letting a CHECK produce a 500.
 *
 * `CARD_PERCENT_STEP_BP` is the one that is arithmetic rather than UI fidelity —
 * see `db/schema/platformSettings.ts` and migration 0032. Half a percentage point
 * is the design's step AND the granularity at which `bp / 100` below stays exact.
 */
export const MAX_KNET_FLAT_FILS = 500;
export const KNET_STEP_FILS = 10;
export const MAX_CARD_PERCENT_BP = 500;
export const CARD_PERCENT_STEP_BP = 50;
export const MIN_SALON_DEPOSIT_FILS = 1000;
export const MAX_SALON_DEPOSIT_FILS = 10_000;

/**
 * The one row, or a thrown error. See the header for why there is no fallback.
 */
export async function readPlatformSettings(exec: Reader): Promise<PlatformSettingsRow> {
  const rows = await exec
    .select()
    .from(platformSettings)
    .where(eq(platformSettings.id, PLATFORM_SETTINGS_ID))
    .limit(1);
  const row = rows[0];
  if (!row) {
    /**
     * Not an `ApiError`. A caller cannot do anything about this and a client must
     * not be taught to handle it: the row is created by the same migration that
     * creates the table, so its absence means the deployment is behind 0032 or
     * somebody deleted it by hand. That is an operator's problem, and it should
     * arrive as a 500 with a sentence naming the fix.
     */
    throw new Error(
      'platform_settings has no row. Migration 0032 inserts it; run db:migrate.',
    );
  }
  return row;
}

/**
 * The stored rate as `commissionFor` wants it.
 *
 * `cardPercentBp / 100` IS A FLOAT DIVISION AND IT IS SAFE ONLY BECAUSE THE
 * COLUMN IS CONSTRAINED. `CommissionRates.cardPercent` is a percentage — 2.5, not
 * 250 — so basis points have to become one somewhere, and this is the somewhere.
 * The division was probed over bp 0..1000 against exact integer basis-point
 * arithmetic at every half-fil boundary in 1..10,000,000 fils: 172,705 of
 * 7,800,000 boundaries came out one fil apart, across 136 unsafe bp values.
 *
 * `platform_settings_card_percent_is_half_a_point` and
 * `platform_settings_card_percent_in_range` reduce the domain to
 * {0, 50, ..., 500} — the design's own ±0.5%-clamped-to-5% stepper — and all
 * eleven of those are in the provably-exact set. So the guarantee here is
 * structural: the column cannot hold a value for which this line is wrong.
 * `platformSettings.test.ts` asserts the whole attainable domain rather than
 * trusting that sentence.
 *
 * If a future change widens that CHECK, this function becomes wrong by a fil and
 * the test is what will say so.
 */
export function commissionRatesFrom(row: PlatformSettingsRow): CommissionRates {
  return {
    knetFlatFils: row.knetFlatFils,
    cardPercent: row.cardPercentBp / 100,
    cardFlatFils: row.cardFlatFils,
  };
}

/**
 * AVO's cut of a top-up, at the platform's CURRENT configured rate.
 *
 * Takes the executor so a money path can read the rate inside its own
 * transaction. `services/topup.ts` does, and that matters for a reason worth
 * stating: the fee is computed once at intent creation and settlement replays
 * `intent.feeFils` verbatim, so a rate change landing mid-flight cannot reprice a
 * top-up the customer already paid for. Same reasoning as the tier bonus being
 * "LOCKED AT CREATION, not at settlement" a few lines above the call site.
 */
export async function platformCommissionFor(
  exec: Reader,
  amount: Fils,
  method: PaymentMethod,
): Promise<Fils> {
  const row = await readPlatformSettings(exec);
  return commissionFor(amount, method, commissionRatesFrom(row));
}

/**
 * The wire shape for `GET` / `PATCH /v1/platform/settings`.
 *
 * FILS AND BASIS POINTS GO OUT AS THEY ARE STORED. The console renders "2.5 %"
 * and "0.150 KD"; that is a display-boundary transform and it belongs on the
 * client, the same rule `formatMoney` exists for. Emitting `cardPercent: 2.5`
 * here would put the float in the response body and invite a client to send one
 * back.
 *
 * DECLARED, NOT INFERRED, and `number` rather than `Fils` on the money fields.
 * Two reasons, and the first is that `tsc` refuses the inferred version outright
 * — `error TS4058: Return type of exported function has or is using name
 * 'FilsBrand' ... but cannot be named`. The second is the one that matters: this
 * is a JSON body. `Fils` is a compile-time brand that does not survive
 * serialisation, so a response type claiming to carry one would be asserting a
 * guarantee the wire cannot keep. The brand belongs on everything up to here and
 * on nothing past it — the same boundary `http/serialise.ts` draws.
 */
export interface PlatformSettingsWire {
  flags: Record<PlatformFlag, boolean>;
  commission: { knetFlatFils: number; cardPercentBp: number; cardFlatFils: number };
  newSalonDepositFils: number;
  updatedBy: string | null;
  updatedAt: string;
}

export function serialisePlatformSettings(row: PlatformSettingsRow): PlatformSettingsWire {
  return {
    flags: {
      signups: row.flagSignups,
      booking: row.flagBooking,
      shop: row.flagShop,
      wa: row.flagWa,
      maintenance: row.flagMaintenance,
    },
    commission: {
      knetFlatFils: row.knetFlatFils,
      cardPercentBp: row.cardPercentBp,
      cardFlatFils: row.cardFlatFils,
    },
    newSalonDepositFils: row.newSalonDepositFils,
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The column behind each design-named flag id. One map, two readers. */
export const FLAG_COLUMN: Record<PlatformFlag, keyof PlatformSettingsRow> = {
  signups: 'flagSignups',
  booking: 'flagBooking',
  shop: 'flagShop',
  wa: 'flagWa',
  maintenance: 'flagMaintenance',
};

/** Re-exported so a route file needs one import for the whole concept. */
export { PLATFORM_FLAGS, PLATFORM_SETTINGS_ID };
export type { PlatformFlag, PlatformSettingsRow };
