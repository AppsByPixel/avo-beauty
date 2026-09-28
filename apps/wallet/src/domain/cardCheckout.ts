/**
 * The rules of paying for a basket by card — pure, so each has a spec.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE IDEMPOTENCY KEY IS DERIVED FROM THE BASKET (#4).
 *
 * `POST /orders` already does this: one key per cart signature, `productId:qty`
 * in catalogue order (`useShop § cartSignature`). The card path does the same,
 * with ONE addition the wallet path does not need:
 *
 *   same basket, a retry, a double tap, a resume after closing the browser
 *       → the SAME key. The server replays the stored 201, so there is one
 *         intent, one hosted page, and at most one charge. Lane A, verbatim:
 *         "two different idempotency keys still mean two card charges and two
 *         orders."
 *   a different basket
 *       → a NEW key, because a different body under a burned key is a 422.
 *   the SAME basket after its attempt ENDED — placed, refused, or not paid
 *       → a NEW key. This is the addition. An ended attempt's key is spent:
 *         replaying it would answer the old, dead intent forever, so "Try
 *         again" after a decline could never reach the bank. An attempt that is
 *         still open (awaiting the bank, or pending) is NOT ended, and its key is
 *         held — that is what makes "Check the payment" resume the same intent
 *         rather than open a second one.
 *
 * The METHOD, the FULFILMENT and — since W7 — the PICKUP BRANCH are NOT in the
 * signature, for the reason `useShop § THE KEY IS KEYED ON THE CART` walks: a
 * new key on a switched method, destination or counter would be a second intent
 * beside a first whose outcome is unknown. The API hashes `pickupBranchId`
 * (routes/orders.ts), so a branch changed under a held key is answered 422 —
 * "a payment for this basket has already started" — and a branch changed after
 * a PRE-FLIGHT refusal goes through under the same key, because the refusal
 * rolled back and burned nothing.
 * Under the held key the server answers 422 `idempotency_key_reused` instead,
 * and `useCardCheckout` renders that as "a payment for this basket is already
 * open" — never as a failure, and never by minting its way around it.
 * ═════════════════════════════════════════════════════════════════════════════
 */

import type { OrderPaymentView } from '../api/orderPayments';

export interface BasketKey {
  signature: string;
  key: string;
  /** The attempt under this key reached a terminal outcome. */
  spent: boolean;
}

/** `productId:qty`, in the order given — the same string `useShop` keys on. */
export function basketSignature(lines: readonly { productId: string; qty: number }[]): string {
  return lines.map((l) => `${l.productId}:${l.qty}`).join(',');
}

/**
 * The key for this basket, given the one held. Returns `held` UNCHANGED (same
 * object) when it still applies — which is what a retry must get — and a fresh
 * one only for a new basket or a spent attempt.
 */
export function keyForBasket(held: BasketKey | null, signature: string, mint: () => string): BasketKey {
  if (held !== null && held.signature === signature && !held.spent) return held;
  return { signature, key: mint(), spent: false };
}

/** What a view means for her. `awaiting` is the only non-terminal one. */
export type CardOutcome = 'placed' | 'refused' | 'declined' | 'cancelled' | 'awaiting';

export function cardOutcome(view: OrderPaymentView): CardOutcome {
  switch (view.order.status) {
    case 'placed':
      return 'placed';
    case 'refused':
      return 'refused';
    case 'not_paid':
      return view.intent.status === 'cancelled' ? 'cancelled' : 'declined';
    default:
      return 'awaiting';
  }
}

/**
 * The refusal reasons this app has words for — `order.refusal.code`, as
 * `placeOrder` throws them inside the settlement's savepoint
 * (api/src/services/order.ts), plus `other` for everything else.
 *
 * `other` covers `order_failed` (an unexpected error, which lane A also turns
 * into a refusal so she is never paid-and-uncredited), `address_not_for_pickup`
 * (unreachable by construction — `fulfilmentBody` never sends it), and any code
 * a later API adds. It still says her money is in her wallet, because that is
 * what `refused` means whatever the code.
 */
export const CARD_REFUSAL_REASONS = [
  'price_changed',
  'shop_not_enabled',
  'invalid_products',
  'unknown_address',
  'address_required',
  /*
    W7 — the settlement re-validates the branch she chose on the cart
    (`OrderPaymentRequest.pickupBranchId`, services/topup.ts). A manager can
    close it while she is on the bank's page; a salon can open a second branch
    under a request stored before 0060. Either way she was PAID AND CREDITED.
  */
  'pickup_branch_closed',
  'pickup_branch_required',
  'unknown_pickup_branch',
  'other',
] as const;

export type CardRefusalReason = (typeof CARD_REFUSAL_REASONS)[number];

export function refusalReason(code: string | null | undefined): CardRefusalReason {
  return (CARD_REFUSAL_REASONS as readonly string[]).includes(code ?? '') && code !== 'other'
    ? (code as CardRefusalReason)
    : 'other';
}
