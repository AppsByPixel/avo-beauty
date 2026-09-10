/**
 * Her orders, and the three states one can be in.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THREE STATUSES. NOT FOUR.
 *
 * `preparing → ready → closed` is the whole lifecycle in an app that has served
 * ten tenants for years (`PRIOR-ART.md` § Lean). `OrderStatusSchema` is a
 * three-member enum, `ORDER_STATUS_FLOW` in the API is the same three in the
 * same order, and the position in that array IS the rank.
 *
 * Anything richer — `dispatched`, `out_for_delivery`, `delivered` — is a thing
 * we would be INVENTING rather than following, and the customer-facing cost of
 * inventing one is that the merchant's board has no button that produces it, so
 * it is a state her app can display and the salon can never reach.
 *
 * `closed` therefore means BOTH "collected" and "delivered", and one word for
 * two endings is the shape of the data. So `orderStatusLabel` takes the
 * fulfilment as well as the status: the STATUS is one of three, and the SENTENCE
 * about it differs, because "Ready to collect" and "Ready — on its way" are the
 * same row read by two different customers. That is a copy decision on top of a
 * three-value enum, not a fourth value.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE ADDRESS ON AN ORDER IS A SNAPSHOT AND MUST NOT LOOK LIVE.
 *
 * `ShopOrderSchema.address` is what she typed WHEN SHE ORDERED, not what her
 * book says now. `shop_order` snapshots all eleven components beside an
 * `address_id` kept only for provenance, and the id may point at a soft-deleted
 * row. Editing or deleting an address deliberately does not change a past order,
 * so a delivered order stays answerable.
 *
 * The UI consequence, which is the thing most likely to be got wrong: an order's
 * address is RENDERED AS TEXT and is never a control. No edit affordance, no tap
 * through to the address book, no "same as saved" indicator, and it is never
 * matched by id against the live book to relabel it — that lookup is exactly how
 * a snapshot comes to be presented as live, and it would show "Home" for an
 * order placed to an address she has since renamed and moved.
 *
 * `orderAddressIsEditable` exists as a named `false` rather than as an absence,
 * for `voidable`'s reason: a positive statement fails a review, an omission
 * passes one.
 * ═════════════════════════════════════════════════════════════════════════════
 */

import type { OrderStatus, ShopOrder } from '@avo/types';

/** The lifecycle, in order. Mirrors `ORDER_STATUS_FLOW` in the API. */
export const ORDER_STATUS_FLOW = ['preparing', 'ready', 'closed'] as const;

/**
 * 1, 2 or 3 — the position in the flow, for a progress indicator.
 *
 * Derived from the array rather than a lookup table, so the two cannot disagree,
 * and 1-based because it is shown to a person ("step 2 of 3") rather than used
 * as an index. `bookStep` in the copy layer already takes that shape.
 */
export function orderStatusStep(status: OrderStatus): number {
  return ORDER_STATUS_FLOW.indexOf(status) + 1;
}

export const ORDER_STATUS_COUNT = ORDER_STATUS_FLOW.length;

/**
 * Is this order still in progress?
 *
 * `closed` is the only end. Used to sort the live ones to the top and to decide
 * whether the status chip carries the brand tint or goes quiet — not to hide
 * anything: a closed order is history she is entitled to read, and the receipt
 * on it is her record of what she paid.
 */
export function orderIsOpen(order: Pick<ShopOrder, 'status'>): boolean {
  return order.status !== 'closed';
}

/**
 * A NAMED FALSE. See the header — an order's address is a snapshot, and nothing
 * in this app may present it as editable. Exported so a caller reads the rule
 * rather than inferring it from the absence of a handler.
 */
export const orderAddressIsEditable = false as const;

/**
 * The six sentences: three statuses × two fulfilments.
 *
 * Structural, so this module does not depend on the whole `Copy` interface.
 * Every one of these strings is NEW — the design bundle draws no delivery UI at
 * all and its receipt says "Pickup" — so all six are owed in both languages and
 * all six are in `AR_UNVERIFIED`.
 */
export interface OrderStatusCopy {
  orderPickupPreparing: string;
  orderPickupReady: string;
  orderPickupClosed: string;
  orderDeliveryPreparing: string;
  orderDeliveryReady: string;
  orderDeliveryClosed: string;
}

/**
 * The status, as a sentence, for the fulfilment this order actually has.
 *
 * Reads the fulfilment off the ORDER rather than taking it separately: the two
 * arrive on one row and cannot disagree, and a signature that let a caller pass
 * them apart is a signature that lets a caller pass a delivery order's status
 * with a pickup's wording.
 */
export function orderStatusLabel(
  order: Pick<ShopOrder, 'status' | 'fulfilment'>,
  copy: OrderStatusCopy,
): string {
  if (order.fulfilment === 'delivery') {
    if (order.status === 'preparing') return copy.orderDeliveryPreparing;
    if (order.status === 'ready') return copy.orderDeliveryReady;
    return copy.orderDeliveryClosed;
  }
  if (order.status === 'preparing') return copy.orderPickupPreparing;
  if (order.status === 'ready') return copy.orderPickupReady;
  return copy.orderPickupClosed;
}

/**
 * Orders as the list draws them: open ones first, newest first within each.
 *
 * Sorted CLIENT-SIDE over one page rather than asked for — `GET
 * /members/me/orders` orders by `created_at DESC` and caps at 200 with a
 * `truncated` flag, so this re-groups what arrived and never implies it has
 * everything. A copy is taken because `Array.prototype.sort` mutates, and the
 * array here comes from state that React compares by reference.
 */
export function sortedOrders(orders: readonly ShopOrder[]): ShopOrder[] {
  return [...orders].sort((a, b) => {
    const openness = Number(orderIsOpen(b)) - Number(orderIsOpen(a));
    if (openness !== 0) return openness;
    return b.createdAt.localeCompare(a.createdAt);
  });
}
