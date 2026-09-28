/**
 * A shop order paid by KNET, card or Apple Pay — client ask W2.
 *
 *   POST /orders/payments        → 201 { intent, order }   open the payment
 *   GET  /orders/payments/{id}   → { intent, order }       THE authoritative read
 *
 * Both bare (`api/src/routes/orders.ts`), driven against avo_lane_b. Lane A's
 * design (`services/orderPayment.ts`): a top-up intent sized to the order total,
 * with the order attached, PLACED BY THE SERVER when the money lands.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE OUTCOME IS `GET /orders/payments/{id}`, NEVER THE REDIRECT, AND NEVER THE
 * POST EITHER.
 *
 * #2: the client does not decide the order was paid. The return URL is a hint
 * (`platform/gateway.ts`), and — measured, which is why this paragraph exists —
 * the POST's body is not an outcome either: a replay of a key whose payment has
 * since SUCCEEDED answers the stored 201 verbatim, `status: "redirected"`,
 * `order.status: "awaiting_payment"`. So `useCardCheckout` reads the GET after
 * every POST, before it opens any payment page, and after every return.
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * `order.status`, as `orderPaymentView` derives it:
 *
 *   awaiting_payment   she is at the bank, or it is pending
 *   not_paid           declined or cancelled. Nothing charged, no order
 *   placed             paid, and the order debited it — `result` is its receipt
 *   refused            PAID AND CREDITED, but the order could not be placed:
 *                      THE MONEY IS IN HER WALLET, and `refusal.code` says why.
 *                      The screen renders from the CODE via the copy module; the
 *                      server's English `message` is never shown (#12).
 *
 * `intent` is `TopUpIntentPublicSchema` — no `feeFils`. A card fee is a business
 * question still open with the client; the merchant bears it today and nothing
 * here can show one, because the customer projection does not carry it.
 */

import { z } from 'zod';
import { TopUpIntentPublicSchema, type PaymentMethod } from '@avo/types';
import { getJson, postJson } from './client';
import { OrderResultSchema, type CartLine } from './shop';

export const OrderPaymentStatusSchema = z.enum(['awaiting_payment', 'not_paid', 'placed', 'refused']);
export type OrderPaymentStatus = z.infer<typeof OrderPaymentStatusSchema>;

export const OrderPaymentViewSchema = z.object({
  intent: TopUpIntentPublicSchema,
  order: z.object({
    status: OrderPaymentStatusSchema,
    transactionId: z.string().nullable(),
    /** `code` is what the screen reads. `message` is parsed and never rendered. */
    refusal: z.object({ code: z.string().min(1), message: z.string() }).nullable(),
    /**
     * `OrderResult`, exactly as `POST /orders` answers — the receipt sheet.
     *
     * `z.lazy` so the schema is read when a body is PARSED, not when this module
     * loads: two shop render specs replace `api/shop` wholesale, and an eager
     * read here would stop them collecting over a path they never exercise.
     */
    result: z.lazy(() => OrderResultSchema).nullable(),
  }),
});

export type OrderPaymentView = z.infer<typeof OrderPaymentViewSchema>;

/**
 * Open a card payment for this basket.
 *
 * THE KEY IS AN ARGUMENT, AND ITS LIFETIME IS THE CALLER'S — `useCardCheckout`
 * derives it from the basket and holds it across every retry of that basket.
 * Lane A, verbatim: "two different idempotency keys still mean two card charges
 * and two orders." A key minted per tap is exactly that on a double tap.
 *
 * THE BODY IS BUILT FIELD BY FIELD, NEVER SPREAD FROM A PRODUCT — the route
 * refuses a price by name (`parseOrderBody`), as `POST /orders` does, and it is
 * the SAME parser, so a pickup body is `{ items, method }` and nothing else.
 */
export function createOrderPayment(
  items: CartLine[],
  method: Exclude<PaymentMethod, 'wallet'>,
  fulfilment: { fulfilment?: 'delivery'; addressId?: string },
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<OrderPaymentView> {
  const body = {
    items: items.map((l) => ({ productId: l.productId, qty: l.qty })),
    method,
    ...fulfilment,
  };
  return postJson('/orders/payments', body, OrderPaymentViewSchema, idempotencyKey, signal);
}

/** The authoritative read. This, and only this, says what happened. */
export function getOrderPayment(id: string, signal?: AbortSignal): Promise<OrderPaymentView> {
  return getJson(`/orders/payments/${encodeURIComponent(id)}`, OrderPaymentViewSchema, signal);
}
