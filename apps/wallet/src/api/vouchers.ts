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
 * THE SCHEMA CAME FROM HERE AND NOW LIVES IN `packages/types`. (trunk, 2026-09-15)
 *
 * This file used to declare `VoucherSchema` and `VoucherRedemptionSchema`
 * itself, and said why it could not move them: `packages/types` is trunk-owned
 * and a lane may not change it. **Trunk moved them**, for exactly the reason
 * this block named — `e2e/contract.test.ts`'s drift guard walks the SHARED
 * schemas, so it could not see a parser declared here, and a server that renamed
 * `balanceAfterFils` would have been caught at runtime by one customer and
 * nowhere else.
 *
 * The console has its own reader (`apps/dashboard/src/api/vouchers.ts`,
 * hand-rolled) and keeps it: that app has no zod dependency at all, so parsing
 * by hand is its house style there rather than an oversight. Two readers of one
 * fact is still one more than anybody wants — what changed is that the fact is
 * now declared somewhere the guard can reach.
 */

import {
  VoucherRedemptionSchema,
  type Voucher,
  type VoucherRedemption,
} from '@avo/types';
import { newIdempotencyKey, postJson } from './client';

export type { Voucher, VoucherRedemption };


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
