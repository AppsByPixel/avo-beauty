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

import type { FastifyInstance } from 'fastify';
import { db } from '../db/client';
import { requireMember } from '../auth/principal';
import { badRequest, conflict } from '../http/errors';
import { MAX_LINE_QTY } from '../db/schema/shopOrder';
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

    const idem = {
      scope: principalScope(p),
      endpoint: 'POST /orders',
      key,
      /**
       * The cart, in the order it was sent. Two different carts under one key is
       * a 422 from `readCommittedKey`, not a replay of the first — the client bug
       * that would otherwise hide a lost order.
       */
      requestHash: hashRequestBody({ items }),
    };

    try {
      const result = await performOrder(db, { items }, {
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
