/**
 * Collect it, or have it delivered — and what that adds to `POST /orders`.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * IT IS A FORK, NOT A MIGRATION OFF COLLECTION.
 *
 * `PRIOR-ART.md` § "The shop is delivery-based" settled this from Lean's own
 * `deliveryOption.js`: both paths are live there, after years and ten tenants.
 * So "the shop is delivery-based" means delivery is AVAILABLE AND CHOSEN, not
 * that pickup was removed — which is also what keeps the design bundle's Pickup
 * copy (`shopSub`, "pick up at the salon") correct rather than legacy.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * OMITTING `fulfilment` IS PICKUP, AND THIS MODULE OMITS IT.
 *
 * `routes/orders.ts` reads `body.fulfilment ?? 'pickup'`. So the pickup body is
 * byte-identical to the body this app sent before delivery existed, and the path
 * that has been driven, tested and shipped is not re-entered through a new
 * branch. `branchQuery` in `domain/branchPicker.ts` takes the same shape for the
 * same reason: when the server treats two spellings identically, send the one
 * that leaves the old request unchanged.
 *
 * The alternative — always sending `fulfilment: 'pickup'` explicitly — is not
 * wrong on the wire, and is still worse: it makes every existing order body a
 * new body, so a regression in the pickup path could only be attributed to this
 * slice by reading the diff.
 *
 * A DELIVERY SENDS `{ fulfilment: 'delivery', addressId }` AND NOTHING ELSE.
 * Never the address fields. `routes/orders.ts` refuses `block`, `street`,
 * `building` and `address` BY NAME, and the refusal is the point: an address
 * posted into an order is an address that never entered her book —
 * unreviewable, unreusable, and the door Lean's four-fields-from-one-input
 * arrives through. `AddressPayload` and this body have no field in common, so
 * there is no call site where one could be spread into the other.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THERE IS NO FEE, AND THIS MODULE COMPUTES NO AMOUNT.
 *
 * Not "the fee is zero" — there is no fee anywhere, asserted server-side rather
 * than merely absent: `shop_order` has no amount column at all, an order touches
 * only `member_wallet` and `salon_revenue`, and a fee would have to invent a
 * third account. The same cart costs the same collected or delivered.
 *
 * So this module has no arithmetic and the cart sheet gains no line. Read that
 * as a rule about the UI too: no fee row, no "Delivery: free" row, no subtotal
 * split. A free-fee row TELLS THE CUSTOMER A FEE EXISTS and is merely waived
 * today, which is a promise about pricing nobody has made — and it is the row
 * somebody later "fixes" by putting a number in it.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE PICKUP BRANCH: A QUESTION THIS MODULE REFUSES TO ANSWER.
 *
 * My own branch-picker report raised it and it has to be answered here or not at
 * all: if she collects, collect at WHICH branch? Amara has two open branches.
 *
 * The answer is that `POST /orders` TAKES NO PICKUP BRANCH TODAY, and more than
 * that: it refuses `branchId` by name (`branch_not_client_supplied`) and
 * `services/order.ts` resolves the branch itself through `resolveBranch`,
 * writing `branch_assumed = true` at a multi-branch salon. There is no field to
 * carry her choice.
 *
 * So this module does not offer one, and — the part that matters — it does not
 * SIMULATE one. The three ways to fake it were all available and all rejected:
 *
 *   REUSE `branchChoice`.  The booking screen's strip. Refused outright, and
 *   this is the specific thing I warned about in that slice: `branchChoice` is a
 *   VIEW FILTER over an artist list that never reaches the server, and a pickup
 *   branch would reach the server. One value cannot be both a filter and an
 *   assertion; wiring them together would make a filter silently load-bearing.
 *
 *   SEND IT ANYWAY as `branchId`. A 400 by name. Correct behaviour by the API.
 *
 *   SHOW A PICKER AND DROP THE VALUE. The worst of the three. She believes she
 *   chose Salmiya, the row records an assumed branch, and nothing on screen ever
 *   said the location was not settled — the "SHOW THEM UNDER EVERY BRANCH" lie
 *   `branchPicker.ts` already rejected, in a costume where the cost is a customer
 *   standing in the wrong salon.
 *
 * WHAT THE UI DOES INSTEAD: the pickup option says the salon, not a branch, and
 * says nothing it cannot keep. `copy.fulfilPickupBody` is one sentence and it
 * claims no location. REPORTED as a gap rather than filled: if a pickup branch
 * is wanted it is a contract change on `POST /orders` plus a column on
 * `shop_order`, which is lane A's, and a decision about whether a customer may
 * assert a reporting bucket, which is Aftab's.
 * ═════════════════════════════════════════════════════════════════════════════
 */

/** The two, exactly as the enum spells them. */
export type Fulfilment = 'pickup' | 'delivery';

/**
 * The default, and the one that changes nothing. A cart opens on pickup because
 * that is what this app did yesterday, and because a customer who has never
 * saved an address cannot be defaulted into delivery.
 */
export const DEFAULT_FULFILMENT: Fulfilment = 'pickup';

/**
 * Her choice, and the address it names. `addressId` is null for pickup and for a
 * delivery she has not chosen an address for yet — the second is a real,
 * reachable, unsubmittable state and `checkoutBlock` is what names it.
 */
export interface FulfilmentChoice {
  mode: Fulfilment;
  addressId: string | null;
}

export const PICKUP: FulfilmentChoice = { mode: 'pickup', addressId: null };

/**
 * The fields this choice contributes to the `POST /orders` body.
 *
 * `{}` for pickup — see the header. Returning an object with no keys rather than
 * `null` means the caller spreads unconditionally and has no second branch to
 * forget:
 *
 *     const body = { items, ...fulfilmentBody(choice) };
 *
 * PICKUP CARRIES NO `addressId` EVEN IF ONE IS SET, and that is not defensive
 * tidying: `services/order.ts` REFUSES pickup-with-an-address by name
 * (`address_not_for_pickup`, "A pickup order takes no address"), because
 * `shop_order_delivery_has_an_address` makes it unstorable. A customer who picks
 * delivery, chooses an address, then switches back to pickup would otherwise
 * have her order refused for a field she cannot see.
 */
export function fulfilmentBody(
  choice: FulfilmentChoice,
): { fulfilment?: 'delivery'; addressId?: string } {
  if (choice.mode === 'pickup') return {};
  // Delivery with no address is not submittable — `checkoutBlock` stops the
  // button — but this stays total rather than throwing on a money path.
  if (choice.addressId === null) return { fulfilment: 'delivery' };
  return { fulfilment: 'delivery', addressId: choice.addressId };
}

/**
 * Why she cannot tap Pay yet, or `null`.
 *
 * `noAddress` is the ONE reason this module owns. It mirrors the server's
 * `address_required` — which is a real 400 that `orderRefusal` classifies — so
 * she is stopped at the sheet rather than by a refusal after a tap. That is the
 * same relationship the stale-product check already has with `invalid_products`:
 * the client check is a courtesy and the server's is the control (#7).
 */
export type CheckoutBlock = 'noAddress';

export function checkoutBlock(choice: FulfilmentChoice): CheckoutBlock | null {
  if (choice.mode === 'delivery' && choice.addressId === null) return 'noAddress';
  return null;
}

/**
 * Her choice after the address book changed underneath it.
 *
 * She can delete the address she has selected — the book is editable from inside
 * the same flow — and a selection pointing at a deleted row would be submitted
 * and answered `unknown_address`. So the selection is re-resolved against the
 * ids that exist: gone means back to "no address chosen", which is a state the
 * sheet already renders and already blocks on.
 *
 * IT DOES NOT FALL BACK TO ANOTHER ADDRESS. Picking a different destination for
 * her because the one she chose disappeared is the worst available behaviour on
 * this path — she would tap Pay believing she had chosen, and a bottle would go
 * to a previous address. Deliberately loses the selection instead.
 */
export function reconcileChoice(
  choice: FulfilmentChoice,
  addressIds: readonly string[],
): FulfilmentChoice {
  if (choice.addressId === null) return choice;
  if (addressIds.includes(choice.addressId)) return choice;
  return { mode: choice.mode, addressId: null };
}
