/**
 * Her saved address book — `GET|POST /members/me/addresses` and
 * `PUT|DELETE /members/me/addresses/{id}`.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * NO MEMBER ID ANYWHERE IN THIS FILE, AND THAT IS THE CONTRACT'S SHAPE.
 *
 * The principal IS the member: every route is `requireMember` and scoped to
 * `principal.id`, and `POST` refuses a `memberId` in the body BY NAME
 * (`member_not_client_supplied`) rather than ignoring it. So there is no id a
 * client could point at somebody else's address book, and no function here takes
 * one. A `PUT` or `DELETE` naming another customer's address is a 404, not a 403
 * — deliberately, because a 403 would confirm the address exists.
 *
 * NOT A MONEY PATH, AND THAT IS ASSERTED RATHER THAN ASSUMED.
 * There is no delivery fee anywhere in this feature — no `deliveryCharge`, no
 * `deliveryFee`, nothing — so saving an address moves nothing, and none of these
 * four calls carries an idempotency key. Non-negotiable #4 covers money-moving
 * POSTs; this POST inserts one row and touches no ledger. `POST /orders` keeps
 * its key because it debits a wallet for the GOODS, which it already did before
 * delivery existed.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE SCHEMA COMES FROM `@avo/types` AND IS NOT RE-DECLARED HERE.
 *
 * `MemberAddressSchema` is trunk-owned and already lands in this branch
 * (`65ab72e`). A second local copy of a wire shape is the drift this build has
 * paid for four times — see the `LoyaltyOutcome` compromise in `api/shop.ts`,
 * which is app-local ONLY because promoting it is a trunk operation.
 *
 * WHAT THE SCHEMA SAYS THAT IS EASY TO MISS:
 *
 *   `latitude`/`longitude` ARE STRINGS. The column is `text` (the constraint
 *   audit bans the whole float family, `numeric` included), nothing does
 *   arithmetic on a coordinate, and both-or-neither is a database CHECK. This
 *   client never SENDS them — there is no Places integration, so there is no
 *   source for a pair — and reads them back as whatever is stored.
 *
 *   EVERY OPTIONAL FIELD IS REQUIRED-BUT-NULLABLE, not optional. So a client
 *   never has to tell "no floor" from "field not sent", and a server that
 *   stopped sending one fails the parse instead of rendering a blank.
 * ═════════════════════════════════════════════════════════════════════════════
 */

import { z } from 'zod';
import { MemberAddressSchema, type MemberAddress } from '@avo/types';
import { deleteNoContent, getJson, postAction, putJson } from './client';
import type { AddressPayload } from '../domain/address';

export type { MemberAddress };

/** `{ items, nextCursor }` — the same envelope every collection uses. */
export const AddressPageSchema = z.object({
  items: z.array(MemberAddressSchema),
  /**
   * Declared and nullable rather than omitted, for `ProductPageSchema`'s reason:
   * the route always sends it. Nothing pages an address book — a customer has
   * two or three — but a client that ignored the field would silently show the
   * first page if that ever stopped being true.
   */
  nextCursor: z.string().nullable(),
});

/** `POST` and `PUT` both answer the single entity under a key. */
export const AddressEnvelopeSchema = z.object({ address: MemberAddressSchema });

/**
 * Her book, newest first — the route's own `ORDER BY created_at DESC`.
 *
 * SOFT-DELETED ROWS ARE ABSENT and the route filters them, so this list is what
 * she can choose from today. An old order still names one of them, through its
 * own snapshot rather than through this list, and the two are not reconciled —
 * see `domain/shopOrders.ts` § THE ADDRESS ON AN ORDER IS A SNAPSHOT.
 */
export async function listAddresses(signal?: AbortSignal): Promise<MemberAddress[]> {
  const body = await getJson('/members/me/addresses', AddressPageSchema, signal);
  return body.items;
}

/**
 * Save a new one. 201 with the stored row, which is what the caller renders —
 * never the form state it just sent.
 *
 * That distinction is worth the sentence: the server trims, and maps an empty
 * optional field to NULL. Rendering the submitted form instead would show her
 * `'  '` as a floor for exactly as long as the sheet stayed open.
 *
 * `postAction` and not `postJson`: no money moves, so the key is optional rather
 * than a required positional argument — and this call passes none. A
 * double-tapped Save would create two identical rows in her book, which is
 * visible, harmless and hers to delete; the `busy` flag on the sheet is what
 * actually prevents it.
 */
export function createAddress(
  payload: AddressPayload,
  signal?: AbortSignal,
): Promise<{ address: MemberAddress }> {
  // `exactOptionalPropertyTypes` — an explicit `undefined` does not satisfy
  // `signal?: AbortSignal`, so the key is omitted rather than set to undefined.
  return postAction(
    '/members/me/addresses',
    payload,
    AddressEnvelopeSchema,
    signal === undefined ? {} : { signal },
  );
}

/**
 * Replace one. WHOLE-ROW: an omitted optional field becomes NULL — see
 * `putJson`'s header — so `payload` must always carry all nine fields, which is
 * the only thing `toAddressPayload` can produce.
 *
 * EDITING DOES NOT REACH A PAST ORDER, deliberately. The order snapshotted the
 * eleven components when it was placed, so a delivered order stays answerable
 * and a driver holds what she typed at the time. Nothing here needs to warn her
 * about that, because nothing here changes an order — but a caller that ever
 * wanted to "update the address on my order" is asking for something this
 * contract does not have.
 */
export function updateAddress(
  id: string,
  payload: AddressPayload,
  signal?: AbortSignal,
): Promise<{ address: MemberAddress }> {
  return putJson(
    `/members/me/addresses/${encodeURIComponent(id)}`,
    payload,
    AddressEnvelopeSchema,
    signal,
  );
}

/**
 * Remove one. 204, so `deleteNoContent` — `.json()` on an empty body would throw
 * and report a contract failure for a delete that succeeded.
 *
 * SOFT on the server. `shop_order.address_id` is `ON DELETE restrict`, so a hard
 * delete would refuse for exactly the addresses that have been used; soft is the
 * shape that works for both, and a second DELETE is a 404 rather than a silent
 * success.
 */
export function removeAddress(id: string, signal?: AbortSignal): Promise<void> {
  return deleteNoContent(`/members/me/addresses/${encodeURIComponent(id)}`, signal);
}
