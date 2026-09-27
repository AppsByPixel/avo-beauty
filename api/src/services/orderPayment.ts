/**
 * A SHOP ORDER PAID BY KNET, CARD OR APPLE PAY. Client ask 2 (wallet list): "add
 * payment methods in the shop".
 *
 *   POST /orders/payments        open the payment → { intent, order }       (201)
 *   GET  /orders/payments/{id}   the authoritative read → { intent, order }
 *
 * =========================================================================
 * WHAT ALREADY EXISTED, AND THEREFORE WHAT THE GAP ACTUALLY WAS
 * =========================================================================
 * The wallet's cart ALREADY offers a card. On a 402 it shows "Top up to continue",
 * opens `TopUpSheet` with the KNET / card / Apple Pay choice, sized by
 * `topUpAmountForShortfall` to the smallest tile that clears the shortfall; on
 * success it re-reads the member and she presses Pay again, which is an ordinary
 * `POST /orders` from her balance (`apps/wallet/src/screens/ShopScreen.tsx`,
 * `cartTopUpBalanceRender.test.tsx`). So the method choice existed — but only when
 * she was SHORT, it cost two payments' worth of taps, it topped up a tile rather
 * than the order, and when her balance covered the basket there was no choice at
 * all.
 *
 * The real gap is therefore narrower than "no payment methods": ONE step, sized to
 * the order, with the order placed by the server when the money arrives. That is
 * what this file adds, and it adds no second path to the gateway.
 *
 * =========================================================================
 * THE SHAPE: A TOP-UP INTENT SIZED TO THE ORDER, WITH THE ORDER ATTACHED
 * =========================================================================
 * `openIntent` (services/topup.ts) is the ONE door to the gateway, and this file
 * calls it exactly as `createTopUp` does: key claimed first, limits enforced, bonus,
 * promotion and commission locked at creation, the gateway call under its timeout,
 * a failed gateway leg thrown so the key rolls back. The only difference is
 * `order_request` on the row (migration 0058) and an amount that is the order's
 * total rather than a tile.
 *
 * Settlement is the top-up's settlement — webhook, gateway read on her return, or
 * the reaper's read of a lost webhook, whichever sees it first, through the same
 * state machine that makes a duplicate callback a no-op. `creditWallet` credits the
 * card money and then places the order in a SAVEPOINT in the same transaction.
 * `services/topup.ts § placeAttachedOrder` carries the race: if the order is no
 * longer placeable, the money stays as wallet credit and the refusal is recorded.
 *
 * So: #2, the server decided it was paid — a client returning from the hosted page
 * decides nothing. #4, the key is on this POST, and the intent's own machine is the
 * guard against a retried or duplicated gateway confirmation. #5, a later refund is
 * wallet credit because the money passed through the wallet. #1, the amount is the
 * integer-fils total `priceBasket` computed from `product`, nothing from the body.
 *
 * =========================================================================
 * FEES, BONUS, AND THE TOTAL SHE SEES — REPORTED, NOT DECIDED HERE
 * =========================================================================
 * Because this IS a top-up, it is priced as one, and each of the following is the
 * existing top-up rule applied unchanged rather than a new policy:
 *
 *   COMMISSION: `platformCommissionFor(amount, method)` — KNET flat 150 fils, card
 *     2.5% + 50, from `platform_settings`. Recorded on the intent and the `topup`
 *     transaction as `fee_fils`; merchant-visible, customer-never; NOT deducted from
 *     what lands in the wallet. So the MERCHANT bears it, as on every top-up, and the
 *     order total she sees and pays DOES NOT CHANGE. A wallet-paid order carries no
 *     commission (order.ts § 6: commission is taken when money ENTERS through a PSP),
 *     so the business question is whether a salon accepts a PSP commission on shop
 *     sales paid by card. That is the client's decision; this code does not make it.
 *
 *   BONUS: her tier bonus and any live top-up promotion are credited, exactly as on a
 *     top-up. So a 10.000 KD order paid by card lands 10.000 + bonus, the order debits
 *     10.000, and the bonus stays in her wallet. That is the SAME economics as the
 *     two-step shortfall path the cart already offers (top up, then pay) — which is
 *     the argument for it: with no bonus here, paying in one step would be strictly
 *     worse for her than paying in two, and the flow built to be easier would be the
 *     one that costs her. If the client wants card-paid orders to earn no bonus,
 *     that is a one-line change in `openIntent` keyed on `orderRequest` and it is
 *     their call.
 */

import { eq } from 'drizzle-orm';
import type { Fils, PaymentMethod, TopUpIntentPublic } from '@avo/types';
import type { Db } from '../db/client';
import { topUpIntent } from '../db/schema/topup';
import type { MemberPrincipal } from '../auth/principal';
import { notFound } from '../http/errors';
import type { GatewayOutcome } from '../gateway/types';
import { claimKey, completeKey } from './idempotency';
import { quoteOrder, type OrderInput } from './order';
import { enforceTopUpLimits } from './topupLimit';
import {
  openIntent,
  readTopUp,
  serialiseIntentForCustomer,
  type TopUpIntentRow,
} from './topup';

/**
 * WHERE THE ORDER IS. Derived from the intent's status and its three order columns,
 * never stored as a fourth thing that could disagree with them.
 *
 *   awaiting_payment   the intent is open — she is on the hosted page, or it is pending
 *   not_paid           the payment failed or was cancelled. Nothing was charged, no order
 *   placed             paid, credited, and the order debited it — `result` is its receipt
 *   refused            paid and credited, and the order could NOT be placed: the money is
 *                      in her wallet. `refusal.code` is the machine reason
 */
export type OrderPaymentStatus = 'awaiting_payment' | 'not_paid' | 'placed' | 'refused';

export interface OrderPaymentView {
  /** `TopUpIntentPublicSchema` — no commission — by the same projection `GET /topups` uses. */
  intent: TopUpIntentPublic;
  order: {
    status: OrderPaymentStatus;
    /** The `shop` transaction, once placed. */
    transactionId: string | null;
    /** Why it was not placed. `price_changed`, `shop_not_enabled`, `invalid_products`, … */
    refusal: { code: string; message: string } | null;
    /** `OrderResult`, exactly as `POST /orders` answers — the wallet's receipt sheet. */
    result: Record<string, unknown> | null;
  };
}

export function orderPaymentView(row: TopUpIntentRow): OrderPaymentView {
  const status: OrderPaymentStatus =
    row.status === 'succeeded'
      ? row.orderTransactionId
        ? 'placed'
        : 'refused'
      : row.status === 'failed' || row.status === 'cancelled'
        ? 'not_paid'
        : 'awaiting_payment';
  return {
    intent: serialiseIntentForCustomer(row),
    order: {
      status,
      transactionId: row.orderTransactionId ?? null,
      refusal:
        row.orderRefusalCode && row.orderRefusalMessage
          ? { code: row.orderRefusalCode, message: row.orderRefusalMessage }
          : null,
      result: row.orderResult ?? null,
    },
  };
}

export interface CreateOrderPaymentContext {
  principal: MemberPrincipal;
  idempotency: { scope: string; endpoint: string; key: string; requestHash: string };
  failCreate?: boolean;
}

/**
 * Open a card payment for this basket. ONE transaction: the key, the limits, the
 * pre-flight, the intent and the gateway's hosted page commit together, or the key
 * rolls back with them — including when the gateway leg fails, so the retry under
 * the same key is a real retry (#4, and topup.ts § createTopUp's rule).
 *
 * THE PRE-FLIGHT RUNS BEFORE THE GATEWAY IS ASKED FOR ANYTHING. A basket that would
 * be refused now — shop off, a retired product, an address that is not hers — is
 * refused now, before her card is charged, with the same codes `POST /orders` uses.
 * What cannot be refused now is what changes in the minutes she spends on the hosted
 * page, and that is settlement's problem, handled there.
 *
 * HER BALANCE IS NOT CONSULTED. Paying by card is a choice she may make whatever her
 * balance is; the card pays the whole order and her existing balance is untouched.
 */
export async function createOrderPayment(
  db: Db,
  input: { order: OrderInput; method: PaymentMethod },
  ctx: CreateOrderPaymentContext,
): Promise<OrderPaymentView> {
  return db.transaction(async (tx) => {
    const keyId = await claimKey(tx, ctx.idempotency);
    await enforceTopUpLimits(tx, ctx.principal);

    const quote = await quoteOrder(tx, ctx.principal.id, input.order);

    const row = await openIntent(tx, {
      principal: ctx.principal,
      amountFils: quote.totalFils as Fils,
      method: input.method,
      failCreate: ctx.failCreate ?? false,
      orderRequest: {
        items: input.order.items.map((i) => ({ productId: i.productId, qty: i.qty })),
        fulfilment: input.order.fulfilment ?? 'pickup',
        addressId: input.order.addressId ?? null,
      },
    });

    // The response and its replay are one object, projected once — topup.ts's rule.
    const view = orderPaymentView(row);
    await completeKey(tx, keyId, { status: 201, body: view });
    return view;
  });
}

/**
 * The authoritative read, for her return from the hosted page. `readTopUp` asks the
 * gateway if the intent is still open and settles through the machine — which, for
 * this intent, places the order — and the row is then re-read for the order columns.
 *
 * SCOPED TO HER, and an ordinary top-up is not an order payment: both answer 404,
 * exactly as another customer's top-up does on `GET /topups/{id}`, because a 403
 * would confirm the id is real.
 */
export async function readOrderPayment(
  db: Db,
  principal: MemberPrincipal,
  intentId: string,
  simulate?: GatewayOutcome,
): Promise<OrderPaymentView> {
  const [before] = await db
    .select({ memberId: topUpIntent.memberId, orderRequest: topUpIntent.orderRequest })
    .from(topUpIntent)
    .where(eq(topUpIntent.id, intentId))
    .limit(1);
  if (!before || before.memberId !== principal.id || before.orderRequest === null) {
    throw notFound('unknown_order_payment', 'No such order payment.');
  }

  await readTopUp(db, principal, intentId, simulate);

  const [row] = await db.select().from(topUpIntent).where(eq(topUpIntent.id, intentId)).limit(1);
  if (!row) throw notFound('unknown_order_payment', 'No such order payment.');
  return orderPaymentView(row as TopUpIntentRow);
}
