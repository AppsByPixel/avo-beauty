/**
 * THE MODULE GATES — `modules.booking` and `modules.shop`, on the READ paths.
 *
 * Both modules default OFF (AVO-Beauty-Product-Description-v2.md § Settings), and
 * both had a write-path refusal and no read-path one:
 *
 *   services/order.ts   § 3   `shop_not_enabled`     POST /orders
 *   services/booking.ts :324  `booking_not_enabled`  POST /bookings
 *
 * So a customer could be served the catalogue, the service list, the roster and a
 * grid of bookable slots by a salon that sells none of it, and only learn
 * otherwise at the moment she tried to pay. The shop half of that shipped as a
 * defect Lane B drove end to end; the booking half is closed here for symmetry,
 * before it can.
 *
 * WHY THE TWO LIVE IN ONE MODULE. They are one rule with two flags, and they were
 * about to be written in two route files that do not import each other — which is
 * how `shop_not_enabled` and `booking_not_enabled` would end up with two different
 * answers to "does staff get the gate". A caller in `routes/artists.ts` and a
 * caller in `routes/salons.ts` now read the same function.
 *
 * MEMBERS ONLY, ON BOTH, AND IT IS A DECISION RATHER THAN AN OVERSIGHT.
 *
 * The setup a module governs is built BEFORE the module is turned on — that is the
 * whole reason the columns default off. Products are written by three `perms.shop`
 * endpoints with no module check; artists and their hours are written by
 * `perms.team` endpoints with no module check. Gating a merchant's own read would
 * let her create a product, or set an artist's Tuesday, and then refuse to list it
 * back to her: an editor that forgets what it just saved.
 *
 * So the gate is on the SHOPFRONT, not on the workshop. `productReadGate` and the
 * two artist reads already branch on `p.kind`, which is the seam.
 *
 * WHAT THESE DO NOT DO, and it matters for the honesty property. Neither is how a
 * client is supposed to LEARN that a module is off: `GET /salons/{id}` serves
 * `modules: { booking, shop }` and stays ungated, so a wallet renders "The shop is
 * closed" or "This salon does not take appointments" from a fact it was given,
 * BEFORE it asks for anything it cannot have. `apps/wallet` § HomeScreen and
 * BookScreen already work that way. These refusals are the control behind that
 * courtesy — non-negotiable #7's distinction, applied to a module instead of a
 * permission.
 */

import { conflict } from '../http/errors';

/** The two flags, and nothing else — the shape every caller here needs. */
export interface SalonModules {
  moduleBooking: boolean;
  moduleShop: boolean;
}

/** The principal kinds `requireSalonScoped` can produce, plus the console's. */
export type PrincipalKind = 'member' | 'staff' | 'platform_admin';

/**
 * THE SHOP MODULE, ON THE READ PATH — the half that was missing.
 *
 * `services/order.ts` § 3 refuses a checkout with `shop_not_enabled` when
 * `modules.shop` is off. `GET /salons/{id}/products` had no such check, so with
 * the module off the CATALOGUE still answered 200 with every product on it. Lane
 * B drove the consequence end to end: the customer browses a shop that is closed,
 * fills a cart, taps "Pay 8.500 KD from wallet", and is told "We couldn't complete
 * your order. Nothing has been charged." — a PERMANENT refusal wearing the copy of
 * a retryable one, with the button still live to be pressed again.
 *
 * The money control held throughout: balance unchanged, no transaction row. This
 * is not a money defect. It is the product telling a customer to shop in a shop
 * that is closed, and then blaming the till.
 *
 * A 409 AND NOT AN EMPTY LIST, because the wallet already distinguishes the two
 * and the design gives them different words:
 *
 *   shopOffTitle    "The shop is closed"          ← this refusal
 *   shopEmptyTitle  "Nothing in the shop yet"     ← a 200 with zero rows
 *
 * `apps/wallet/src/state/useShop.ts` maps code `shop_not_enabled` to
 * `status: 'off'` and everything else to a failure, so the client half of this
 * contract was already written and waiting — the server simply never sent it.
 * Returning `{ items: [] }` instead would render "Nothing in the shop yet" about a
 * salon that does not sell products at all, which is the same class of lie in a
 * quieter voice. The code and message are byte-identical to `order.ts` § 3 so the
 * read and the write cannot drift into two vocabularies for one fact.
 *
 * MEMBERS ONLY, AND THAT IS A DECISION RATHER THAN AN OVERSIGHT.
 *
 * The three product WRITES (`POST`/`PATCH`/`DELETE /salons/{id}/products`) have no
 * module check and should not get one: building the catalogue BEFORE flipping the
 * module on is the obvious way a salon opens a shop, and `module_shop` defaults
 * OFF. Gating the merchant's own read would therefore let her create a product and
 * then refuse to list it back to her — an editor that forgets what it just saved.
 * The dashboard has no product reader today, so nothing breaks either way; the
 * argument is the workflow, not the current consumer.
 *
 * So the gate is on the SHOPFRONT, not on the catalogue. `productReadGate` already
 * branches on `p.kind !== 'member'` for exactly this seam.
 */
export function assertShopReadable(
  kind: PrincipalKind,
  salonRow: Pick<SalonModules, 'moduleShop'>,
): void {
  // Staff manage a catalogue whether or not it is on sale yet.
  if (kind !== 'member') return;
  if (salonRow.moduleShop) return;

  throw conflict('shop_not_enabled', 'This salon does not sell products through AVO.');
}

/**
 * THE BOOKING MODULE, ON THE READ PATHS — the same half, for the other module.
 *
 * `services/booking.ts` :324 refuses `POST /bookings` with `booking_not_enabled`
 * when `modules.booking` is off. Three member-readable reads fed that flow and
 * checked nothing:
 *
 *   GET /salons/{id}/services           the service list
 *   GET /salons/{id}/artists/bookable   the roster a customer picks from
 *   GET /artists/{id}/availability      the slot grid
 *
 * ALL THREE GOVERNED BY THE CALLER'S OWN SALON, which is worth stating because the
 * third one looks like an exception and is not. It is keyed on an ARTIST, not a
 * salon — but it resolves tenancy through `p.salonId`, and
 * `services/availability.ts` :289 refuses an artist whose `salonId` differs. So
 * the artist is always one of the caller's own, and the governing salon is the
 * caller's in all three cases. There is no cross-salon read here for a module flag
 * to disagree about.
 *
 * LESS SEVERE THAN THE SHOP WAS, AND THAT IS RECORDED RATHER THAN GLOSSED. The
 * wallet's BookScreen renders `bookingOffTitle` from `modules.booking` before it
 * fetches anything, and HomeScreen does not fetch booking labels at all when the
 * module is off — so no customer was ever lured into a booking she could not make,
 * the way the shop lured her into a cart she could not pay for. This closes a #7
 * gap (a courtesy with no control behind it), not an active defect.
 *
 * ONE CONSEQUENCE, REPORTED AND NOT PAPERED OVER: `apps/wallet` maps
 * `shop_not_enabled` to a rendered state on the shop READ (`useShop.ts` § 173) and
 * has no equivalent mapping for `booking_not_enabled` on these three — its
 * `booking_not_enabled` handling is on the CONFIRM path only (`BookScreen.tsx` §
 * ConfirmFailure). A 409 from these reads would therefore render as a generic
 * failure. It is unreachable in the shipped client, because the screens gate on
 * `modules.booking` first, and inventing client copy is not this lane's to do. Owed
 * by Lane B as defence in depth; named here so it is not discovered as a surprise.
 */
export function assertBookingReadable(
  kind: PrincipalKind,
  salonRow: Pick<SalonModules, 'moduleBooking'>,
): void {
  // Staff set a roster and its hours before the salon opens for appointments.
  if (kind !== 'member') return;
  if (salonRow.moduleBooking) return;

  throw conflict('booking_not_enabled', 'This salon does not take appointments through AVO.');
}
