/**
 * `POST /orders` — the shop checkout, api-contract.md § Operations.
 *
 * The customer's own money-moving POST, so it looks like `POST /bookings` rather
 * than like `POST /charges`: `requireMember` first, then the key, then the body.
 * The one transaction that does the work is services/order.ts, which carries the
 * reasoning for everything the handler does not decide.
 *
 * THERE IS NO `GET /orders`, AND THAT IS THE CONTRACT'S SHAPE, NOT AN OMISSION.
 * An order is a `shop` transaction, so it appears in the wallet's activity feed
 * through `GET /members/me/transactions` and in its detail sheet — which is where
 * the design draws it (`AVO Wallet Home.dc.html:1573`, "Shop order · AVO-SH-…").
 * A second collection listing the same rows under a different name would be two
 * endpoints able to disagree about one purchase.
 *
 * WHY THE COLLECTION IS AT THE ROOT and not `/members/me/orders`: the contract
 * names `POST /orders`, scoped by the credential rather than by the path, exactly
 * as it names `POST /bookings`. The handler reads `requireMember(req)` and writes
 * against `principal.id`, so there is no id in the URL a customer could point at
 * somebody else's wallet.
 */

import { and, desc, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { db } from '../db/client';
import { requireDashboardPerm, requireMember, requireSameSalon } from '../auth/principal';
import { badRequest, conflict, notFound } from '../http/errors';
import { requireString } from '../money/validate';
import { MAX_LINE_QTY } from '../db/schema/shopOrder';
import {
  ORDER_STATUS_FLOW,
  shopOrder,
  type OrderStatus,
} from '../db/schema/delivery';
import { member } from '../db/schema/member';
import { writeAudit } from '../services/audit';

/**
 * One page of the merchant's fulfilment board. A cap, reported as one — see the
 * `truncated` field on the list, and `GET /salons/{id}/bookings` for why a
 * hardcoded `nextCursor: null` on a capped list is not acceptable here.
 */
const ORDERS_PAGE = 200;

/** The fulfilment, as both surfaces read it. Delivery fields are null for pickup. */
function serialiseShopOrder(row: typeof shopOrder.$inferSelect) {
  return {
    transactionId: row.transactionId,
    fulfilment: row.fulfilment,
    status: row.status,
    /** The SNAPSHOT — what she typed when she ordered, not what her book says now. */
    address:
      row.fulfilment === 'delivery'
        ? {
            id: row.addressId,
            label: row.addressLabel,
            block: row.block,
            street: row.street,
            building: row.building,
            floor: row.floor,
            apartment: row.apartment,
            area: row.area,
            governorate: row.governorate,
            instructions: row.instructions,
            latitude: row.latitude,
            longitude: row.longitude,
          }
        : null,
    createdAt: row.createdAt.toISOString(),
    readyAt: row.readyAt?.toISOString() ?? null,
    closedAt: row.closedAt?.toISOString() ?? null,
  };
}
import {
  awaitCommittedKey,
  hashRequestBody,
  isUniqueViolation,
  principalScope,
  readIdempotencyKey,
} from '../services/idempotency';
import { performOrder, type OrderLineInput } from '../services/order';

/** A cart's ceiling. Wider than any drawn catalog, narrow enough to bound a body. */
const MAX_LINES = 50;

/**
 * `{ items: [{ productId, qty }] }`, validated into what the service needs.
 *
 * QUANTITIES ARE VALIDATED HERE AND NOT COERCED. `qty: "2"`, `qty: 2.5` and
 * `qty: 0` are three different client bugs and all three are refused by name,
 * because the alternative — `Number(qty) || 1` — is how a cart of 2.5 bottles
 * becomes a charge for 2 and a customer arguing about a receipt. The same
 * reasoning money/validate.ts gives for not calling `fils()` on a request body:
 * a client can fix a mistake it is told about.
 *
 * DUPLICATE PRODUCT IDS ARE REFUSED RATHER THAN SUMMED. `shop_order_line`'s
 * primary key is `(transaction_id, product_id)`, so two lines for one product
 * would raise a unique violation deep inside the money transaction — where
 * `withIdempotency`-shaped callers read every 23505 as an idempotency-key
 * collision and answer "still being processed", which is the exact
 * mis-translation that once told a staff member a completed void was in flight.
 * Summing them silently would be worse: the wallet's cart is a `{[id]: qty}` map
 * and cannot produce duplicates, so a body that has them is a client that has
 * lost track of its own cart, and the honest answer names the product.
 */
function parseItems(raw: unknown): OrderLineInput[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw badRequest('invalid_request', 'items must be a non-empty array.');
  }
  if (raw.length > MAX_LINES) {
    throw badRequest('invalid_request', `items has too many entries (max ${MAX_LINES}).`);
  }

  const seen = new Set<string>();
  return raw.map((entry) => {
    if (typeof entry !== 'object' || entry === null) {
      throw badRequest('invalid_request', 'Each item must be an object { productId, qty }.');
    }
    const { productId, qty } = entry as Record<string, unknown>;

    if (typeof productId !== 'string' || productId.trim() === '') {
      throw badRequest('invalid_request', 'Each item needs a productId.');
    }
    const id = productId.trim();
    if (id.length > 100) throw badRequest('invalid_request', 'productId is too long.');
    if (seen.has(id)) {
      throw badRequest(
        'duplicate_product',
        `${id} appears twice in items. Send one line per product with its quantity.`,
      );
    }
    seen.add(id);

    if (typeof qty !== 'number' || !Number.isInteger(qty)) {
      throw badRequest('invalid_qty', `qty for ${id} must be a whole number.`);
    }
    if (qty < 1 || qty > MAX_LINE_QTY) {
      throw badRequest('invalid_qty', `qty for ${id} must be between 1 and ${MAX_LINE_QTY}.`);
    }

    return { productId: id, qty };
  });
}

export async function registerOrderRoutes(app: FastifyInstance): Promise<void> {
  /**
   * `GET /members/me/orders` — HER side of the three statuses.
   *
   * Without this the lifecycle is invisible to the person waiting for the
   * bottle, which would make `preparing → ready → closed` a merchant's private
   * bookkeeping rather than the thing it is for. `requireMember`, scoped to her
   * own id from the principal — no member id is read from the path or the query,
   * so one customer cannot read another's order or the address on it.
   *
   * Her OWN address snapshot is on the row, which is correct rather than a leak:
   * it is where she asked her own order to be sent.
   */
  app.get('/members/me/orders', async (req, reply) => {
    const p = requireMember(req);
    const rows = await db
      .select()
      .from(shopOrder)
      .where(eq(shopOrder.memberId, p.id))
      .orderBy(desc(shopOrder.createdAt))
      .limit(ORDERS_PAGE);
    return reply.send({
      items: rows.map(serialiseShopOrder),
      truncated: rows.length === ORDERS_PAGE,
      nextCursor: null,
    });
  });

  // ------------------------------------ the merchant's fulfilment board --
  /**
   * `GET /v1/salons/{id}/orders` — what is preparing, ready and closed.
   *
   * `perms.shop`, the same gate as the catalogue and `products-sold`: this is the
   * Shop section's own screen, and it carries a customer's DELIVERY ADDRESS,
   * which is the most sensitive field the shop touches. It is deliberately not
   * `appointments` (a different section) and not `dashboard` (which would put a
   * customer's home address behind the Overview permission).
   *
   * `?status=` takes the three, comma-separated. Unknown values refused by name
   * rather than ignored, for `GET /salons/{id}/bookings`'s reason: a board
   * filtered on a typo renders empty and the merchant reads that as "no orders".
   */
  app.get<{ Params: { id: string }; Querystring: { status?: string } }>(
    '/v1/salons/:id/orders',
    async (req, reply) => {
      const p = requireDashboardPerm(req, 'shop');
      requireSameSalon(p, req.params.id);

      const raw = req.query?.status;
      const wanted =
        typeof raw === 'string' && raw.trim() !== ''
          ? raw.split(',').map((x) => x.trim()).filter(Boolean)
          : null;
      if (wanted) {
        const unknown = wanted.filter(
          (x) => !(ORDER_STATUS_FLOW as readonly string[]).includes(x),
        );
        if (unknown.length > 0) {
          throw badRequest(
            'invalid_order_status',
            `Unknown order status: ${unknown.join(', ')}. One of ${ORDER_STATUS_FLOW.join(', ')}.`,
          );
        }
      }

      const rows = await db
        .select({ o: shopOrder, memberName: member.name, memberPhone: member.phone })
        .from(shopOrder)
        .innerJoin(member, eq(member.id, shopOrder.memberId))
        .where(
          and(
            eq(shopOrder.salonId, p.salonId),
            wanted ? inArray(shopOrder.status, wanted as OrderStatus[]) : undefined,
          ),
        )
        .orderBy(desc(shopOrder.createdAt))
        .limit(ORDERS_PAGE);

      return reply.send({
        items: rows.map((r) => ({
          ...serialiseShopOrder(r.o),
          memberName: r.memberName,
          memberPhone: r.memberPhone,
        })),
        /**
         * A CAP WITH AN HONEST CURSOR IS NOT WHAT THIS IS — it is a cap, said out
         * loud. `nextCursor: null` on a capped list is the lie
         * `GET /salons/{id}/bookings` was just fixed for, so this does not repeat
         * it: `truncated` is true when the cap was reached, and a client that sees
         * it knows the board is incomplete. A real cursor is the better answer and
         * is owed the day a salon has more than `ORDERS_PAGE` live orders; saying
         * so here is what stops the field being believed in the meantime.
         */
        truncated: rows.length === ORDERS_PAGE,
        nextCursor: null,
      });
    },
  );

  /**
   * `PATCH /v1/salons/{id}/orders/{transactionId}` — move it along.
   *
   * THREE STATUSES AND FORWARD ONLY: `preparing → ready → closed`. Lean's whole
   * lifecycle after years across ten tenants, and anything richer would be us
   * inventing rather than following.
   *
   * MONOTONIC, and the row count decides. The `WHERE` names the status the caller
   * believes it is leaving, so two managers tapping "Ready" produce one
   * transition and one 409 — the pattern `services/booking.ts § returnDeposit`
   * had to learn, where a caller's `if` was the only thing between one deposit
   * and two refunds. Going backwards is refused rather than silently accepted:
   * "closed → preparing" would tell a customer her delivered order is being
   * prepared.
   *
   * NO MONEY. Closing an order does not settle, refund or charge anything — the
   * wallet was debited when she ordered. That is what the absent delivery fee
   * buys, and it is why this is a plain UPDATE with an audit row rather than a
   * money transaction.
   */
  app.patch<{ Params: { id: string; tid: string } }>(
    '/v1/salons/:id/orders/:tid',
    async (req, reply) => {
      const p = requireDashboardPerm(req, 'shop');
      requireSameSalon(p, req.params.id);

      const body = (req.body ?? {}) as Record<string, unknown>;
      const next = body.status;
      if (next !== 'ready' && next !== 'closed') {
        throw badRequest(
          'invalid_order_status',
          'status must be "ready" or "closed". An order starts at "preparing".',
        );
      }
      /** The one status each is reachable from. Forward only, one step at a time. */
      const from: OrderStatus = next === 'ready' ? 'preparing' : 'ready';

      const now = new Date();
      const updated = await db
        .update(shopOrder)
        .set(
          next === 'ready'
            ? { status: 'ready', readyAt: now, updatedAt: now }
            : { status: 'closed', closedAt: now, updatedAt: now },
        )
        .where(
          and(
            eq(shopOrder.transactionId, req.params.tid),
            eq(shopOrder.salonId, p.salonId),
            eq(shopOrder.status, from),
          ),
        )
        .returning();

      const row = updated[0];
      if (!row) {
        /**
         * ONE READ TO TELL "not hers" FROM "wrong status", because those need
         * different answers and a single 404 for both would have a merchant
         * hunting for an order she is looking at. Scoped to her salon, so a
         * missing row stays a 404 rather than leaking that it exists elsewhere.
         */
        const [current] = await db
          .select({ status: shopOrder.status })
          .from(shopOrder)
          .where(
            and(
              eq(shopOrder.transactionId, req.params.tid),
              eq(shopOrder.salonId, p.salonId),
            ),
          )
          .limit(1);
        if (!current) throw notFound('unknown_order', 'No such order.');
        throw conflict(
          'order_status_not_reachable',
          `That order is ${current.status}. ${next === 'ready' ? '"Ready" follows "preparing"' : '"Closed" follows "ready"'}, and an order never goes backwards.`,
          { status: current.status, attempted: next },
        );
      }

      await writeAudit(db, p, {
        salonId: p.salonId,
        kind: 'rules',
        action: next === 'ready' ? 'Order ready' : 'Order closed',
        detail: `${row.fulfilment === 'delivery' ? 'Delivery' : 'Pickup'} order ${row.transactionId} → ${next}`,
        source: 'merchant',
        subjectType: 'order',
        subjectId: row.transactionId,
        ipAddress: req.ip ?? null,
        userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
      });

      return reply.send({ order: serialiseShopOrder(row) });
    },
  );

  app.post('/orders', async (req, reply) => {
    // FIRST, before the body is read. Money leaves a wallet here.
    const p = requireMember(req);
    // Then the key — non-negotiable #4. Refused before any work.
    const key = readIdempotencyKey(req);

    const body = (req.body ?? {}) as Record<string, unknown>;

    /**
     * NO PRICES, AND THEY ARE REFUSED RATHER THAN IGNORED.
     *
     * `POST /bookings` refuses `depositFils` and `branchId` by name for this
     * reason, and it is the stronger treatment where money is concerned: a
     * client that sent `unitPriceFils` believed it was setting the price, and
     * silently ignoring it means the customer is charged an amount her app never
     * showed her. A `status` on a campaign is ignored because the field is not
     * the client's to have an opinion about; a price is one it might act on.
     */
    for (const field of ['priceFils', 'unitPriceFils', 'totalFils', 'amountFils'] as const) {
      if (field in body) {
        throw badRequest(
          'price_not_client_supplied',
          `A product's price comes from the salon's catalog, not from ${field} in the request.`,
        );
      }
    }
    /** The server resolves the branch. services/branch.ts § "the fix that must not be taken". */
    if ('branchId' in body) {
      throw badRequest(
        'branch_not_client_supplied',
        "An order's branch is resolved by the server, not sent by the client.",
      );
    }

    const items = parseItems(body.items);

    /**
     * THE FORK (PRIOR-ART.md § Lean's shop). Lean keeps pickup and delivery both
     * live, so this is a choice and not a migration off collection.
     *
     * OMITTED IS PICKUP — the behaviour that shipped before the field existed.
     * An unknown value is REFUSED BY NAME rather than falling back to pickup: a
     * client that sent `"DELIVERY"` believed it had chosen delivery, and quietly
     * collecting instead is the shape of wrong answer that reads as working.
     *
     * NO FEE, so this changes no amount and adds no money path. `POST /orders`
     * keeps its idempotency key because it debits a wallet for the GOODS, which
     * it already did.
     */
    const rawFulfilment = body.fulfilment;
    if (rawFulfilment !== undefined && rawFulfilment !== 'pickup' && rawFulfilment !== 'delivery') {
      throw badRequest(
        'invalid_fulfilment',
        'fulfilment must be "pickup" or "delivery", or omitted for pickup.',
      );
    }
    const fulfilment = (rawFulfilment ?? 'pickup') as 'pickup' | 'delivery';
    const addressId =
      body.addressId === undefined || body.addressId === null
        ? undefined
        : requireString(body.addressId, 'addressId', 100);

    /**
     * THE ADDRESS IS AN ID, NEVER THE FIELDS. A client posting `block`/`street`
     * here would be writing an address into an order that never entered her book
     * — unreviewable, unreusable, and the door through which Lean's four-fields-
     * from-one-input arrives. Refused by name, like a price and a branch.
     */
    for (const field of ['block', 'street', 'building', 'address'] as const) {
      if (field in body) {
        throw badRequest(
          'address_not_client_supplied',
          `A delivery address comes from your saved addresses as addressId, not from ${field}.`,
        );
      }
    }

    const idem = {
      scope: principalScope(p),
      endpoint: 'POST /orders',
      key,
      /**
       * The cart, in the order it was sent. Two different carts under one key is
       * a 422 from `readCommittedKey`, not a replay of the first — the client bug
       * that would otherwise hide a lost order.
       */
      /**
       * FULFILMENT IS IN THE HASH. Two different destinations under one key is a
       * 422 rather than a replay of the first — a client that retried a pickup
       * as a delivery meant something different, and replaying the pickup would
       * hand her a "delivered" order that is sitting on a counter.
       */
      requestHash: hashRequestBody({ items, fulfilment, addressId: addressId ?? null }),
    };

    try {
      const result = await performOrder(db, { items, fulfilment, addressId }, {
        principal: p,
        idempotency: idem,
        ipAddress: req.ip ?? null,
        userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
      });
      // 201: a purchase created a transaction. `POST /bookings` answers 201 for
      // the same reason; `POST /charges` answers 200 because the scanner's
      // contract was written that way and the mock it was built against does too.
      return reply.code(201).send(result);
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;

      /**
       * Her own key, replayed. The double-tapped "Pay from wallet" button is the
       * scanner's double scan in another costume: the loser waits for the winner's
       * committed response and returns it verbatim rather than computing a second
       * one, which would be a second debit.
       *
       * The only unique index this transaction can violate under a race is the
       * idempotency key's: `shop_order_line`'s composite primary key is refused at
       * the boundary by `parseItems` above, and nothing else here is unique. That
       * is why this catch does not have to ask WHICH constraint fired the way
       * routes/charges.ts does — and it is worth saying, because the day another
       * unique index lands on this path, this comment is wrong and the answer
       * becomes "still being processed" for something permanent.
       */
      const stored = await awaitCommittedKey(db, idem);
      if (stored) return reply.code(stored.status).send(stored.body);

      throw conflict(
        'request_in_progress',
        'That request is still being processed. Try again in a moment.',
      );
    }
  });
}
