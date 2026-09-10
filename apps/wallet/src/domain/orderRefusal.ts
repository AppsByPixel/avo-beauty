/**
 * Why a checkout was refused — the money path's classifier, as a pure function.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * EXTRACTED FROM `useShop` FOR THE REASON `deletionOutcome.ts` AND `signup.ts`
 * BOTH STATE: this workspace has no renderer, so a branch left inline in a hook
 * is a branch no test can reach. It was inline, and the four-way classification
 * of a REFUSED ORDER — the most consequential mapping in this app after the
 * charge — had no spec at all. It has one now, and `orderRefusal.test.ts` is that
 * spec.
 *
 * THE ORDER OF THE CHECKS IS THE SPEC, and every one of the seven is
 * load-bearing. It was four before delivery; the three added are 2b, 2c and 2d,
 * and they go BEFORE the offline check for the same reason `invalid_products`
 * does:
 *
 *   1.  402 + a shortfall   the server's figure, never a locally computed one.
 *   2.  `invalid_products`  a product retired underneath her. BEFORE the offline
 *                           check, because it is a 400 and would otherwise be
 *                           fine — but see the 503 note below for why the order
 *                           is written down rather than left to chance.
 *   2b. `address_required`  delivery with no address. A 400.
 *   2c. `unknown_address`   the address she chose is gone. A 404.
 *   2d. `idempotency_key_reused`  ALREADY PLACED. A 422, and the one case in
 *                           this function that means the money DID move — see
 *                           the union below, because getting this one wrong
 *                           tells a customer nothing was charged when a debit
 *                           has settled.
 *   3.  `offline`           her connection. LAST of the classified cases, because
 *                           `client.ts`'s `classify()` maps 503 AND 504 to
 *                           `offline`, so a server-side 503 carrying a real code
 *                           would otherwise claim her network was down. That exact
 *                           collision made a signup refusal blame the connection,
 *                           and `termsFailure` carries the same note.
 *   4.  anything else       our failure, with no retry affordance.
 *
 * WHAT THIS FUNCTION MAY NOT DO: offer a retry on `failed` or `offline`. It does
 * not render, so it cannot — but the shape it returns is what the sheet keys its
 * button off, and the rule belongs beside the classification. An order moves
 * money with ONE concurrency guard where a charge has two, so a client that could
 * not read the response does not know whether the money moved. `short`, `stale`,
 * `noAddress` and `addressGone` are refusals the server demonstrably made BEFORE
 * debiting — driven, see the test — and only those four keep a button.
 * `alreadyPlaced` gets no retry either, for the opposite reason: retrying it
 * would be asking for a second order.
 * ═════════════════════════════════════════════════════════════════════════════
 */

import { fils, type Fils } from '@avo/types';
import { ApiError } from '../api/client';

/**
 * What a refused checkout was. Each is a different sentence to the customer.
 *
 * Declared HERE rather than in `state/useShop`, which re-exports it: a domain
 * module must not import from `state/`, and the classifier is the thing that
 * defines the union.
 */
export type CheckoutRefusal =
  | { kind: 'short'; shortfallFils: Fils }
  | { kind: 'stale'; ids: string[] }
  /**
   * DELIVERY WITH NO ADDRESS. `address_required`, a 400 from
   * `services/order.ts` before anything is debited. `checkoutBlock` in
   * `domain/fulfilment.ts` normally stops the button first, so reaching this is
   * either a race — she deleted her last address between the render and the tap
   * — or the client check having a hole. Either way the server is the control
   * (#7) and this is the sentence she gets.
   */
  | { kind: 'noAddress' }
  /**
   * THE ADDRESS SHE CHOSE IS GONE. `unknown_address`, a 404: soft-deleted, or
   * never hers. Reachable in one tap — the address book is editable from inside
   * the same flow, so she can delete the selected address and then pay.
   * `reconcileChoice` handles the ordinary case; this is the one where the
   * delete happened on another device.
   *
   * A SEPARATE KIND FROM `noAddress` because the two ask for different things.
   * "Choose an address" is wrong when the one she chose has vanished from under
   * her — she did choose, and being told to choose implies she had not.
   */
  | { kind: 'addressGone' }
  /**
   * ALREADY PLACED. 422 `idempotency_key_reused`, and this kind is NEW TO THIS
   * SLICE because until now it could not happen.
   *
   * `useShop` mints one key per CART and the API hashes
   * `{items, fulfilment, addressId}`. Before delivery existed, the cart WAS the
   * whole body — so one key could never carry two different bodies, and a 422
   * here was unreachable. Now the fulfilment can change under an unchanged
   * cart, and the API answers 422 rather than replaying the first order.
   *
   * That is the RIGHT answer and this kind exists to render it honestly: it
   * means the earlier attempt COMMITTED. Her money moved, an order exists, and
   * the destination is the one she chose the first time. The sentence therefore
   * tells her the order was placed and sends her to look at it — it does not
   * offer a retry, and it must never read as a failure, because "we couldn't
   * complete your order, nothing has been charged" would be a lie about a
   * settled debit.
   *
   * See `useShop` § THE KEY IS KEYED ON THE CART for why the alternative —
   * re-minting the key when the fulfilment changes — is a double charge.
   */
  | { kind: 'alreadyPlaced' }
  | { kind: 'offline' }
  | { kind: 'failed' };

/** The API's code for a product that is unknown, retired, or another salon's. */
export const INVALID_PRODUCTS = 'invalid_products';

/**
 * The three delivery-era codes, as named constants for `INVALID_PRODUCTS`'s
 * reason: a string literal inside the classifier is a string literal nothing can
 * assert against the API's own spelling.
 *
 * All three are copied from the API verbatim:
 *   `address_required`        services/order.ts:413  (400)
 *   `unknown_address`         services/order.ts:426  (404)
 *   `idempotency_key_reused`  services/idempotency.ts:168  (422)
 */
export const ADDRESS_REQUIRED = 'address_required';
export const UNKNOWN_ADDRESS = 'unknown_address';
export const KEY_REUSED = 'idempotency_key_reused';

/**
 * The ids `invalid_products` names, read off the error body.
 *
 * THE KEY IS `unknown` AND IT IS TOP-LEVEL ON THE WIRE, not nested under a
 * `details` object. `api/src/services/order.ts` throws
 * `badRequest('invalid_products', …, { unknown })`, which serialises as
 * `{error, message, unknown}` — and `client.ts` rebuilds `details` by spreading
 * everything that is not `error` or `message`. So `details.unknown` is correct
 * because of that spread, not because the server sends a `details` object.
 * Captured from the real 400, not inferred:
 *
 *   {"error":"invalid_products",
 *    "message":"Unknown or unavailable product: PR-01.",
 *    "unknown":["PR-01"]}
 *
 * Filtered to strings rather than cast. A malformed `unknown` yields an empty
 * list, which still renders the stale refusal — she is told something in her cart
 * has gone even if we cannot name it, which is the honest degradation. It must
 * never throw: this runs inside the catch of a money-moving POST.
 */
function namedIds(err: ApiError): string[] {
  const raw = err.details['unknown'];
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === 'string');
}

/**
 * Classify a thrown checkout failure.
 *
 * Total by construction — every path returns, and a non-`ApiError` (a TypeError
 * from a schema parse, say) is `failed` rather than an escape. A classifier on a
 * money path that could itself throw would replace a refusal the customer can act
 * on with a blank screen.
 */
export function orderRefusal(err: unknown): CheckoutRefusal {
  if (!(err instanceof ApiError)) return { kind: 'failed' };

  /*
    THE SERVER'S SHORTFALL, replacing the local one the CTA label used. #2 gives
    the server the balance and therefore the difference; subtracting two numbers
    here would be a second opinion about money. `shortfallFils` is a getter that
    returns null unless the body carried a number, so a 402 without one falls
    through to `failed` rather than rendering "Balance too low by 0.000".
  */
  if (err.status === 402 && err.shortfallFils !== null) {
    return { kind: 'short', shortfallFils: fils(err.shortfallFils) };
  }

  /*
    A PRODUCT RETIRED WHILE SHE SHOPPED — and it is indistinguishable to the API
    from one that never existed, because the route filters `active = true` inside
    the same query that prices the basket and reports every missing id the same
    way. So the client cannot tell "retired" from "never existed" and must not
    try; the sentence names the product and asks her to take it out, which is true
    either way.
  */
  if (err.code === INVALID_PRODUCTS) {
    return { kind: 'stale', ids: namedIds(err) };
  }

  /*
    THE DELIVERY REFUSALS. Both are refusals `services/order.ts` makes at step
    5b, INSIDE the transaction but BEFORE the debit at step 5 commits — a throw
    there rolls everything back, so the key is untouched and nothing moved. That
    is why both keep a button, on the same evidence `short` and `stale` do.

    Matched on the CODE and never on the status: `address_required` is a 400 and
    `unknown_address` is a 404, and a client that switched on status here would
    conflate the second with every other missing resource.
  */
  if (err.code === ADDRESS_REQUIRED) return { kind: 'noAddress' };
  if (err.code === UNKNOWN_ADDRESS) return { kind: 'addressGone' };

  /*
    ALREADY PLACED — the opposite of every other case in this function.

    Each refusal above means NOTHING HAPPENED. This one means the money moved,
    on an earlier attempt whose response never reached us, and the client is now
    asking for a different order under the key that one burned. `readCommittedKey`
    only throws this for a key that EXISTS with a different request hash, and a
    key only persists if its transaction committed — so the 422 is positive
    evidence of a settled order rather than an ambiguous outcome.

    Deliberately NOT folded into `failed`, which says "nothing has been charged".
    See the union above.

    `address_not_for_pickup` is deliberately absent from this list. It is
    unreachable by construction — `fulfilmentBody` drops the address on the
    pickup path precisely so it cannot be sent — so if it ever arrives it is a
    client bug and `failed` is the honest classification of one, not a sentence
    written for a state that should not exist.
  */
  if (err.code === KEY_REUSED) return { kind: 'alreadyPlaced' };

  // AFTER the codes. See the header — 503 classifies as `offline`, so a coded
  // refusal arriving with that status must not be read as a dead connection.
  if (err.kind === 'offline') return { kind: 'offline' };

  return { kind: 'failed' };
}
