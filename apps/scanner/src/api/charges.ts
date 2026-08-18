/**
 * The money endpoints: charge, today's charges, void.
 *
 * Nothing in this file computes an amount. The total shown before the charge is
 * the sum of prices the server sent with the scan; the amount actually debited,
 * the deposit applied, the new balance, the loyalty outcome and the shortfall
 * on a refusal all come back from the server. Non-negotiable #2 — the server
 * owns the balance — read strictly: the client does not get to be right about
 * money by accident.
 */

import { z } from 'zod';
import { DateTimeSchema, FilsSchema, IdSchema, TransactionSchema } from '@avo/types';
import { getJson, postMoney } from './client';

// ------------------------------------------------------------------ loyalty --

/**
 * Mirrors `LoyaltyOutcome` in api/src/services/loyalty.ts. `mode` is exclusive:
 * a tiers salon never sends stamps and a stamps salon never sends visits, which
 * is why this is a discriminated union and not one object with nullable halves.
 */
export const TiersOutcomeSchema = z.object({
  mode: z.literal('tiers'),
  visits: z.number().int().nonnegative(),
  tier: z.enum(['bronze', 'silver', 'gold', 'black']).nullable(),
  nextTier: z.enum(['bronze', 'silver', 'gold', 'black']).nullable(),
  visitsToNext: z.number().int().nullable(),
  climbed: z.boolean().optional(),
});

export const StampsOutcomeSchema = z.object({
  mode: z.literal('stamps'),
  stamps: z.number().int().nonnegative(),
  target: z.number().int().positive(),
  rewardReady: z.boolean(),
});

export const LoyaltyOutcomeSchema = z.discriminatedUnion('mode', [
  TiersOutcomeSchema,
  StampsOutcomeSchema,
]);

export type LoyaltyOutcome = z.infer<typeof LoyaltyOutcomeSchema>;

// ------------------------------------------------------------------- charge --

/**
 * WIDENED — three fields the server has been sending and this schema was
 * silently throwing away.
 *
 * `ChargeResult` in api/src/services/charge.ts:80-120 carries
 * `depositReturnedFils`, `bookingId` and `happyHour` as well. Zod does not fail
 * on an undeclared field, it STRIPS it, so all three arrived and vanished before
 * any screen could read them — the same drift STATUS.md calls the trap that keeps
 * reappearing, found here while closing the manual path because the deposit is
 * what the manual path had to prove.
 *
 * Widening is the correct direction, and the server's own comments say why the
 * shapes are as they are: `depositReturnedFils` and `bookingId` are "both always
 * present, both null/0 when there was no booking — a scanner has to be able to
 * tell 'no deposit was held' from 'this API is too old to say'". Declaring them
 * nullable rather than optional preserves exactly that distinction.
 *
 * `depositReturnedFils` is the one with money in it: when a 5.000 deposit meets a
 * 3.000 basket the server caps the credit at the basket and hands 2.000 back to
 * her wallet as its own `deposit_return` transaction (non-negotiable #5 — it never
 * became salon revenue). A client that strips the field cannot tell the artist
 * that happened, so the customer sees a balance move nobody at the counter can
 * explain.
 */
export const ChargeResultSchema = z.object({
  transaction: TransactionSchema,
  balanceAfterFils: FilsSchema.nonnegative(),
  depositAppliedFils: FilsSchema.nonnegative(),
  /** Handed back because the hold was bigger than the basket. Its own transaction. */
  depositReturnedFils: FilsSchema.nonnegative(),
  /** The booking the deposit came from. Null when none was held — never omitted. */
  bookingId: IdSchema.nullable(),
  loyalty: LoyaltyOutcomeSchema,
  /** 15 minutes from the charge. api/src/services/charge.ts VOID_WINDOW_MINUTES. */
  voidableUntil: DateTimeSchema,
  /**
   * What the promotion set decided for THIS charge, at one instant, on the server
   * — an outcome, never an input. `POST /charges` reads no promotion field from
   * its body at all, so a client claiming a live happy hour is not refused, it is
   * simply not consulted (non-negotiable #2).
   */
  happyHour: z
    .object({
      id: IdSchema.nullable(),
      visitMultiplier: z.number(),
      stampMultiplier: z.number(),
      creditFils: FilsSchema.nonnegative(),
      minutesRemaining: z.number().int(),
    })
    .nullable(),
});

export type ChargeResult = z.infer<typeof ChargeResultSchema>;

export interface ChargeInput {
  memberId: string;
  serviceIds: string[];
  /**
   * Present when the member was reached by scanning her code, absent when she
   * was found by manual lookup. The API declares it optional for exactly this
   * reason (api/src/routes/charges.ts:100) — a dead phone still has to be able
   * to pay.
   */
  token?: string | undefined;
}

/**
 * `POST /charges`. One server-side transaction: token consumption, deposit,
 * debit, visit/stamp, tier evaluation and receipt queue, all or nothing
 * (non-negotiable #3).
 *
 * A 402 comes back as an ApiError carrying `shortfallFils` — the screen shows
 * that number and does not compute one.
 */
export function charge(
  input: ChargeInput,
  idempotencyKey: string,
  accessToken: string,
  signal?: AbortSignal,
): Promise<ChargeResult> {
  const body: Record<string, unknown> = {
    memberId: input.memberId,
    serviceIds: input.serviceIds,
  };
  if (input.token !== undefined) body['token'] = input.token;

  return postMoney('/charges', body, ChargeResultSchema, idempotencyKey, accessToken, signal);
}

// ---------------------------------------------------------- today's charges --

const ChargeListSchema = z.object({
  items: z.array(TransactionSchema),
  nextCursor: z.string().nullable(),
});

export type ChargeRow = z.infer<typeof TransactionSchema>;

/**
 * `GET /charges?date=today` — requires `perms.charges`, enforced server-side.
 *
 * A 403 from here is the control; the locked tile on the home screen is only a
 * courtesy (non-negotiable #7). The screen calls this even when it already
 * knows the permission is off, because proving the server refuses is the whole
 * point of the pairing.
 *
 * CONTRACT GAP — REPORTED, NOT PAPERED OVER.
 * The design's row is "Noura S. / Blow-dry / 2:10 PM · by Rana"
 * (AVO Staff Scanner.dc.html:256-258). This endpoint returns bare
 * `Transaction` rows: no member name, no service names, no staff name
 * (api/src/routes/charges.ts:156-168). The screen renders what exists and
 * leaves the rest out rather than inventing it; see ChargesScreen.
 */
export async function fetchTodaysCharges(
  accessToken: string,
  signal?: AbortSignal,
): Promise<ChargeRow[]> {
  const body = await getJson('/charges?date=today', ChargeListSchema, accessToken, signal);
  return body.items;
}

// --------------------------------------------------------------------- void --

export const VoidResultSchema = z.object({
  ok: z.boolean(),
  refundedFils: FilsSchema.nonnegative(),
  visitRemoved: z.boolean(),
});

export type VoidResult = z.infer<typeof VoidResultSchema>;

/**
 * `POST /voids`. Requires `perms.void`, a reason, and an idempotency key — a
 * retried void without one is a double refund (non-negotiable #4).
 *
 * Refunds are wallet credit. No cash, no card reversal, ever (#5).
 */
export function voidCharge(
  input: { transactionId: string; reason: string },
  idempotencyKey: string,
  accessToken: string,
  signal?: AbortSignal,
): Promise<VoidResult> {
  return postMoney('/voids', input, VoidResultSchema, idempotencyKey, accessToken, signal);
}

export { IdSchema };
