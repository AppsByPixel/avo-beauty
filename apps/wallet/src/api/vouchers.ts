/**
 * The customer's half of AVO-issued vouchers.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THERE IS EXACTLY ONE ENDPOINT HERE, AND THAT IS THE WHOLE SHAPE OF THE
 * FEATURE ON THIS SURFACE.
 * ═════════════════════════════════════════════════════════════════════════════
 * `api/src/routes/vouchers.ts` registers four routes. Three of them —
 * `POST /v1/vouchers`, `GET /v1/vouchers`, `DELETE /v1/vouchers/:id` — are
 * `requirePlatform(req, 'accounts')`, which a member session can never satisfy.
 * The fourth, `POST /members/me/vouchers/redeem`, is `requireMember`.
 *
 * So **the customer app cannot list her vouchers**. There is no
 * `GET /members/me/vouchers`, and the platform list is not reachable with her
 * token. This is not an omission in this file; it is what the API serves, and it
 * decides the screen: a voucher cannot be *shown* to her, only *spent* by her.
 * See `components/account/RedeemVoucherSheet.tsx` for what that makes the
 * surface, and the slice report for the endpoint that would change it.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE PATH IS NOT UNDER `/v1`, AND THE THREE THAT ARE ARE NOT OURS.
 * ═════════════════════════════════════════════════════════════════════════════
 * `client.ts` concatenates `API_BASE_URL + path` with no prefix of its own, so
 * the literal below is the whole path. Written `/v1/members/me/vouchers/redeem`
 * by analogy with its three siblings it would 404, and a 404 classifies as
 * `'server'` — "we failed, try again" — which is the wrong sentence for a route
 * that does not exist.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE SCHEMA IS DECLARED HERE BECAUSE `packages/types` HAS NO `VoucherSchema`.
 * ═════════════════════════════════════════════════════════════════════════════
 * REPORTED, NOT ADDED — `packages/types` is trunk-owned (CLAUDE.md § Shared
 * packages) and a field rename there is a four-way break. The consequence is
 * named rather than absorbed: `e2e/contract.test.ts`'s drift guard walks the
 * shared schemas, so it cannot see this parser. A server that renamed
 * `balanceAfterFils` would be caught here, at runtime, by one customer — and
 * nowhere else.
 *
 * It is built out of the shared primitives (`FilsSchema`, `IdSchema`,
 * `DateTimeSchema`) rather than restating `z.number()`, which is the same rule
 * `api/account.ts` follows for its four envelope schemas.
 */

import { z } from 'zod';
import { DateTimeSchema, FilsSchema, IdSchema } from '@avo/types';
import { newIdempotencyKey, postJson } from './client';

/**
 * A voucher row as `serialiseVoucher` writes it.
 *
 * `redeemable` IS THE SERVER'S AND IS NOT RE-DERIVED. The route computes it once
 * from `redeemedAt`, `voidedAt` and `expiresAt` precisely so that no client can
 * disagree with the redeem endpoint about whether a row is live — its own words:
 * "so the console does not reimplement the predicate". The three timestamps are
 * declared below so that a server which stopped sending them fails the parse
 * loudly, and for no other reason: nothing in this app reads them.
 *
 * `code` comes back on the response and is deliberately never rendered. She
 * typed it; echoing it buys nothing and puts a live-looking credential on a
 * screen after it has been spent.
 */
export const VoucherSchema = z.object({
  id: IdSchema,
  code: z.string().min(1),
  memberId: IdSchema,
  amountFils: FilsSchema,
  reason: z.string(),
  expiresAt: DateTimeSchema.nullable(),
  createdAt: DateTimeSchema,
  redeemedAt: DateTimeSchema.nullable(),
  redeemedTransactionId: IdSchema.nullable(),
  voidedAt: DateTimeSchema.nullable(),
  redeemable: z.boolean(),
});

export type Voucher = z.infer<typeof VoucherSchema>;

/**
 * What `POST /members/me/vouchers/redeem` answers with on a 200.
 *
 * `balanceAfterFils` IS THE BALANCE. Non-negotiable #2: it is written inside the
 * same transaction as the credit and the ledger pair, so it is the only number
 * on this surface that is safe to show. Adding `creditedFils` to a balance the
 * app happened to be holding would be the client deciding what she has, and it
 * would be wrong the moment a charge settled between the two reads.
 */
export const VoucherRedemptionSchema = z.object({
  voucher: VoucherSchema,
  creditedFils: FilsSchema,
  balanceAfterFils: FilsSchema,
});

export type VoucherRedemption = z.infer<typeof VoucherRedemptionSchema>;

/**
 * Redeem a code.
 *
 * THE BODY CARRIES A CODE AND NOTHING ELSE, and that is enforced on both sides:
 * the route refuses `amountFils`, `voucherId` or `memberId` by name with
 * `code_only`. A client that sent an amount would be telling the server what she
 * is owed.
 *
 * THE CODE IS SENT AS SHE TYPED IT. `normaliseCode` upper-cases and strips
 * spaces and dashes server-side "so what she types on a phone keyboard reaches
 * the same row whatever her autocapitalise did". Normalising here as well would
 * put that rule in two places, and the second copy is the one that drifts —
 * exactly the reasoning `serialiseMemberContact` uses against a client deriving
 * erasure from `+990`. Driven against avo_lane_b: `"vmq5-cxmc-ggk3"` redeemed
 * `VMQ5CXMCGGK3` for 1.500 KD.
 *
 * THE IDEMPOTENCY KEY IS REQUIRED BY THE SERVER (non-negotiable #4) and is minted
 * by the CALLER, not here. Its lifetime is the point: one key per *attempt*,
 * reused verbatim while that attempt is retried, so a timed-out POST that
 * actually credited replays its stored 200 instead of crediting twice. Minting it
 * inside this function would mint a fresh one per retry and defeat that — and
 * unlike a top-up there is no second voucher to spend, so the replay would simply
 * 409 and tell her a code that worked did not.
 */
export function redeemVoucher(
  code: string,
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<VoucherRedemption> {
  return postJson(
    '/members/me/vouchers/redeem',
    { code },
    VoucherRedemptionSchema,
    idempotencyKey,
    signal,
  );
}

export { newIdempotencyKey };
