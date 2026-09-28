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
 * THE PICKUP BRANCH — W7, "Collect it is good, but from which branch if they
 * have multiple".
 *
 * ⚠️ THIS SECTION USED TO SAY THE OPPOSITE, AND IT WAS TRUE WHEN WRITTEN. It
 * read "A QUESTION THIS MODULE REFUSES TO ANSWER": `POST /orders` took no pickup
 * branch, so the three ways to fake one (reuse `branchChoice`, send `branchId`,
 * show a picker and drop the value) were all refused and the tile said "the
 * salon". Migration 0060 changed the contract, and the reasoning that refused
 * the fakes is exactly what shapes the real thing:
 *
 *   ITS OWN FIELD, `pickupBranchId`. Never `branchId`, which is still refused BY
 *   NAME — that one is the ATTRIBUTION branch, and a client that named it would
 *   be picking which branch's boost pays. Where she will physically go is a
 *   different fact, validated server-side as an OPEN branch of HER salon.
 *
 *   NOT `branchChoice`. That is still a view filter over an artist list; this
 *   reaches the server. They share nothing but the branch list.
 *
 *   ONLY WHEN THERE IS A CHOICE. `salon.branches` (GET /salons/{id}) lists OPEN
 *   branches only. With one, there is nowhere else she could mean: no picker,
 *   NOTHING SENT, and the server uses that branch — so the request is
 *   byte-identical to the one that shipped. With several, she must choose, and
 *   Pay is blocked (`noPickupBranch`) until she has. Omitting it at a
 *   multi-branch salon is `pickup_branch_required`, a 400.
 *
 *   NO PRESELECTION. Not the first branch, not the one she last booked at. A
 *   branch she did not notice being chosen is a bag waiting at the wrong
 *   counter, and the server refuses to guess for exactly that reason ("picking
 *   one for her is the alphabetical guess this whole column exists to
 *   replace", services/order.ts). One tap is the cheaper failure.
 *
 *   NEVER ON A DELIVERY. `pickup_branch_not_for_delivery` is a 400 by name, so
 *   the delivery body drops a selected branch the way the pickup body drops a
 *   selected address — and for the same reason the address is kept in state:
 *   switching back must not lose what she chose.
 *
 *   NOT IN THE IDEMPOTENCY KEY. See `useShop` § THE KEY IS KEYED ON THE CART:
 *   a branch changed under a held key is either a 422 (the first attempt
 *   committed — one order, one debit) or a fresh placement (it rolled back and
 *   burned nothing). A key re-minted on the branch would be the double charge.
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
  /**
   * The branch she chose to collect from, or null for NONE CHOSEN. Null is the
   * resting state and the only state at a single-branch salon, where there is
   * no picker and nothing is sent. Kept across a switch to delivery, and never
   * sent on one — see the header.
   */
  pickupBranchId: string | null;
}

export const PICKUP: FulfilmentChoice = { mode: 'pickup', addressId: null, pickupBranchId: null };

/** An open branch she could collect from — `Salon.branches`, narrowed. */
export interface PickupBranchOption {
  id: string;
  name: string;
  nameAr: string | null;
}

/**
 * Is there a choice to make? MORE THAN ONE open branch. One is not a choice and
 * none cannot take an order at all (`no_branch`). The one predicate the picker,
 * the block and the body all read, so they cannot disagree about a salon.
 */
export function pickupPickerApplies(branches: readonly { id: string }[]): boolean {
  return branches.length > 1;
}

/**
 * The branch the pickup tile may NAME without a picker — the salon's only open
 * branch — or null. Null at a multi-branch salon (the tile names her choice
 * instead, once she has made one) and at a salon with none.
 */
export function onlyPickupBranch<B extends { id: string }>(branches: readonly B[]): B | null {
  return branches.length === 1 ? branches[0]! : null;
}

/** The chosen branch, resolved against the list, or null. Never a fallback. */
export function chosenPickupBranch<B extends { id: string }>(
  choice: FulfilmentChoice,
  branches: readonly B[],
): B | null {
  if (!pickupPickerApplies(branches) || choice.pickupBranchId === null) return null;
  return branches.find((b) => b.id === choice.pickupBranchId) ?? null;
}

/**
 * The fields this choice contributes to the `POST /orders` and
 * `POST /orders/payments` bodies — both rails, one function.
 *
 * `{}` for a pickup at a single-branch salon — see the header. Returning an
 * object with no keys rather than `null` means the caller spreads
 * unconditionally and has no second branch to forget:
 *
 *     const body = { items, ...fulfilmentBody(choice, branches) };
 *
 * PICKUP CARRIES NO `addressId` EVEN IF ONE IS SET, and that is not defensive
 * tidying: `services/order.ts` REFUSES pickup-with-an-address by name
 * (`address_not_for_pickup`, "A pickup order takes no address"), because
 * `shop_order_delivery_has_an_address` makes it unstorable. A customer who picks
 * delivery, chooses an address, then switches back to pickup would otherwise
 * have her order refused for a field she cannot see.
 *
 * DELIVERY CARRIES NO `pickupBranchId` EVEN IF ONE IS SET — the mirror image,
 * refused by name as `pickup_branch_not_for_delivery`.
 *
 * `pickupBranchId` IS SENT ONLY WHEN THE PICKER APPLIES AND HER CHOICE IS ON
 * THE LIST. `branches` is REQUIRED, not defaulted: a caller that forgot it
 * would silently send nothing, and although the server would refuse that
 * (`pickup_branch_required`) rather than guess, the place to catch a missing
 * argument is the compiler. A chosen id no longer on the list is not sent —
 * `reconcilePickupBranch` has already cleared it and `checkoutBlock` holds Pay.
 */
export function fulfilmentBody(
  choice: FulfilmentChoice,
  branches: readonly { id: string }[],
): FulfilmentBody {
  if (choice.mode === 'pickup') {
    const chosen = chosenPickupBranch(choice, branches);
    return chosen === null ? {} : { pickupBranchId: chosen.id };
  }
  // Delivery with no address is not submittable — `checkoutBlock` stops the
  // button — but this stays total rather than throwing on a money path.
  if (choice.addressId === null) return { fulfilment: 'delivery' };
  return { fulfilment: 'delivery', addressId: choice.addressId };
}

/** What `fulfilmentBody` may put on the wire. Never `branchId`. */
export interface FulfilmentBody {
  fulfilment?: 'delivery';
  addressId?: string;
  pickupBranchId?: string;
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
export type CheckoutBlock = 'noAddress' | 'noPickupBranch';

/**
 * `noPickupBranch` mirrors `pickup_branch_required` the way `noAddress` mirrors
 * `address_required`: a pickup at a salon with several open branches and none
 * chosen. A courtesy; the server's 400 is the control (#7).
 */
export function checkoutBlock(
  choice: FulfilmentChoice,
  branches: readonly { id: string }[],
): CheckoutBlock | null {
  if (choice.mode === 'delivery' && choice.addressId === null) return 'noAddress';
  if (
    choice.mode === 'pickup' &&
    pickupPickerApplies(branches) &&
    chosenPickupBranch(choice, branches) === null
  ) {
    return 'noPickupBranch';
  }
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
  return { ...choice, addressId: null };
}

/**
 * Her pickup branch after the branch list changed underneath it — the address
 * rule, for the same reason. A branch that closed drops out of
 * `salon.branches`, and a selection pointing at it would be refused as
 * `pickup_branch_closed`. So a chosen id no longer on the list, or a list that
 * no longer offers a choice, LOSES THE SELECTION.
 *
 * IT DOES NOT FALL BACK TO ANOTHER BRANCH. Moving her order to a counter she
 * did not choose because the one she chose closed is the exact outcome this
 * picker exists to prevent. Returns `choice` itself when nothing changed, so a
 * refetch of an unchanged list does not re-render.
 */
export function reconcilePickupBranch(
  choice: FulfilmentChoice,
  branches: readonly { id: string }[],
): FulfilmentChoice {
  if (choice.pickupBranchId === null) return choice;
  if (pickupPickerApplies(branches) && branches.some((b) => b.id === choice.pickupBranchId)) {
    return choice;
  }
  return { ...choice, pickupBranchId: null };
}
