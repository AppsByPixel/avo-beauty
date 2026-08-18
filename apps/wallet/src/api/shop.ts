/**
 * The shop — `GET /salons/{id}/products` and `POST /orders`.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * BUILT AGAINST THE REAL ROUTES, NOT THE MOCK, AND THE DIFFERENCE MATTERED.
 *
 * `packages/mock` serves three products from a fixture and asks for no
 * authentication. The real `GET /salons/:id/products` did neither until this
 * slice's dependencies landed: it returned a hardcoded `{ items: [] }` behind
 * `requireDashboardPerm(req, 'shop')`, which a customer's wallet token cannot
 * satisfy at all. A Shop screen built against the mock would have worked
 * perfectly in development and answered 403 for every customer in production —
 * the same shape as the auth gap that hid for a whole build, where every screen
 * worked against a mock that asked nothing of it.
 *
 * It is now genuinely member-readable: `productReadGate` admits a member for her
 * own salon and requires `perms.shop` only of staff. Verified with a real member
 * token before this file was written, not inferred from the route's comment.
 *
 * WHAT THE SCHEMAS DELIBERATELY DO NOT DECLARE
 * -------------------------------------------
 * `ProductSchema` is exactly four fields and `active` is NOT one of them. The
 * route filters `active = true` server-side and emits the four; declaring a fifth
 * would be a field the contract strips in transit. `ServiceSchema` declares
 * `active` and its route emits it — the asymmetry is real and is the route's own
 * documented decision, so the client follows each rather than unifying them.
 *
 * AND WHAT THEY DO DECLARE THAT IS EASY TO MISS: `voidable: false`. It is a
 * positive statement, not an omission — there is no reversal path for an order
 * (`performVoid` refuses anything that is not a `charge`), and a literal `false`
 * lets a client tell "this cannot be undone" from "this API is too old to say".
 * Declaring it as a literal means a server that ever started sending `true`
 * fails the parse instead of quietly growing an undo button.
 *
 * THERE IS NO `GET /orders`, BY DESIGN. An order is a `shop` transaction and
 * reaches the customer through the activity feed and its receipt sheet, which is
 * where the design draws it (`AVO Wallet Home.dc.html:1573`). A second collection
 * over the same rows would be two endpoints able to disagree about one purchase.
 *
 * ORDERS HAVE ONE CONCURRENCY GUARD WHERE A CHARGE HAS TWO — recorded here
 * because it changes what this client may do. Lane A removed it and five
 * concurrent orders all settled with the ledger off by 36000 fils, every CHECK
 * satisfied, caught only by `db:verify` invariant 5. So the idempotency key is
 * not a nicety on this path: it is the guard doing the work, and `placeOrder`
 * takes it positionally for the same reason `postJson` does.
 * ═════════════════════════════════════════════════════════════════════════════
 */

import { z } from 'zod';
import { FilsSchema, IdSchema, ProductSchema, TransactionSchema } from '@avo/types';
import { getJson, postJson } from './client';

// ------------------------------------------------------------------- loyalty --

/**
 * `LoyaltyOutcome`, and DECLARING IT HERE IS A REPORTED COMPROMISE.
 *
 * It belongs in `packages/types`. It is the API's `LoyaltyOutcome`
 * (api/src/services/loyalty.ts), it is already declared in
 * `apps/scanner/src/api/charges.ts` for `POST /charges`, and this is the second
 * surface to need it — which is exactly the criterion `packages/types` exists
 * for: "the rules that must resolve identically everywhere". Two app-local copies
 * of one wire shape is the drift this project has paid for four times.
 *
 * `packages/types` is trunk-owned and a field rename there is a four-way break,
 * so promoting it is a trunk operation and not a lane B edit. ESCALATED. Until it
 * moves, this copy is written to match the scanner's field for field, and the
 * discriminated union is kept rather than flattened: `mode` is exclusive — a tiers
 * salon never sends stamps and a stamps salon never sends visits — so one object
 * with nullable halves would let an impossible response parse.
 */
const TiersOutcomeSchema = z.object({
  mode: z.literal('tiers'),
  visits: z.number().int().nonnegative(),
  tier: z.enum(['bronze', 'silver', 'gold', 'black']).nullable(),
  nextTier: z.enum(['bronze', 'silver', 'gold', 'black']).nullable(),
  visitsToNext: z.number().int().nullable(),
  climbed: z.boolean().optional(),
});

const StampsOutcomeSchema = z.object({
  mode: z.literal('stamps'),
  stamps: z.number().int().nonnegative(),
  target: z.number().int().positive(),
  rewardReady: z.boolean(),
});

export const LoyaltyOutcomeSchema = z.discriminatedUnion('mode', [
  TiersOutcomeSchema,
  StampsOutcomeSchema,
]);

export type LoyaltyOutcome = z.infer<typeof LoyaltyOutcomeSchema>;

// ------------------------------------------------------------- the shopfront --

/**
 * `{ items, nextCursor }` — the same envelope every collection uses.
 *
 * `nextCursor` is declared and nullable rather than omitted: the route always
 * sends it, and a client that ignored it would silently show the first page of a
 * catalogue that had grown past one. Nothing pages yet; the field is where paging
 * goes when a salon has more products than one response.
 */
export const ProductPageSchema = z.object({
  items: z.array(ProductSchema),
  nextCursor: z.string().nullable(),
});

export type Product = z.infer<typeof ProductSchema>;

/**
 * The salon's shopfront. Active products only — the server decides that, and a
 * retired product must never reach a cart the checkout would then refuse.
 */
export async function getProducts(salonId: string, signal?: AbortSignal): Promise<Product[]> {
  const body = await getJson(
    `/salons/${encodeURIComponent(salonId)}/products`,
    ProductPageSchema,
    signal,
  );
  return body.items;
}

// ------------------------------------------------------------------ checkout --

/**
 * One priced line, as the SERVER priced it.
 *
 * `name` is the name at the moment of sale, so a later rename does not rewrite a
 * receipt — which is why the client renders this rather than looking the product
 * up again in whatever the catalogue says now.
 *
 * Every amount is integer fils (#1). `FilsSchema` throws on a float, so a
 * contract violation surfaces here rather than as a wrong figure on a receipt.
 */
export const OrderLineSchema = z.object({
  productId: IdSchema,
  name: z.string(),
  qty: z.number().int().positive(),
  unitPriceFils: FilsSchema.nonnegative(),
  lineTotalFils: FilsSchema.nonnegative(),
});

export const OrderResultSchema = z.object({
  transaction: TransactionSchema,
  balanceAfterFils: FilsSchema.nonnegative(),
  totalFils: FilsSchema.nonnegative(),
  items: z.array(OrderLineSchema),
  loyalty: LoyaltyOutcomeSchema,
  /** A literal. See the header — `false` is a statement, not a default. */
  voidable: z.literal(false),
});

export type OrderResult = z.infer<typeof OrderResultSchema>;
export type OrderLine = z.infer<typeof OrderLineSchema>;

/** api/src/db/schema/shopOrder.ts — the per-line ceiling, and a CHECK backs it. */
export const MAX_LINE_QTY = 99;

export interface CartLine {
  productId: string;
  qty: number;
}

/**
 * `POST /orders`. One transaction: price, debit, visit/stamp, tier, receipt.
 *
 * SENDS `{ productId, qty }` AND NOTHING ELSE. The route refuses `priceFils`,
 * `unitPriceFils`, `totalFils`, `amountFils` and `branchId` BY NAME rather than
 * ignoring them, and that is the stronger treatment on purpose: a client that
 * sent a price believed it was setting one, and silently dropping it would charge
 * a customer an amount her app never showed her (#2). So this builds the body
 * from the cart and never spreads a product object into it — a `Product` carries
 * `priceFils`, and spreading one here is exactly the mistake the server is
 * guarding against.
 *
 * ONE LINE PER PRODUCT. Duplicate ids are refused (`duplicate_product`) rather
 * than summed, because `shop_order_line`'s primary key is `(transaction_id,
 * product_id)` and a duplicate would raise a unique violation deep inside the
 * money transaction, where it reads as an idempotency collision and answers
 * "still being processed" for something that never happened. A cart keyed by
 * product id cannot produce duplicates, which is why `CartLine[]` is built from
 * a map — see `domain/cart.ts`.
 */
export function placeOrder(
  items: CartLine[],
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<OrderResult> {
  const body = {
    // Mapped field by field, never spread. See the header.
    items: items.map((l) => ({ productId: l.productId, qty: l.qty })),
  };
  return postJson('/orders', body, OrderResultSchema, idempotencyKey, signal);
}
