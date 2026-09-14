/**
 * The shop's client layer, tested where it can cost money or lose a field.
 *
 * Four things matter here and the rest is plumbing:
 *
 *   the body      `POST /orders` REFUSES a client-supplied price by name. A cart
 *                 line is built from `{productId, qty}` and a `Product` carries
 *                 `priceFils`, so the one-character mistake — spreading the
 *                 product into the line — turns every checkout into a 400. Worse,
 *                 if the server ever stopped refusing it, the customer would be
 *                 charged an amount her app chose.
 *   the schemas   parsed against a REAL captured response, both directions: no
 *                 key dropped, no required key absent. Four contract drifts in
 *                 this project were a schema narrower than the wire.
 *   `voidable`    a literal `false`, so a server that started sending `true`
 *                 fails the parse rather than quietly growing an undo button.
 *   `active`      NOT declared on a product, because the route does not send it.
 */

import { API_BASE_URL } from './client.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_LINE_QTY,
  OrderResultSchema,
  ProductPageSchema,
  getProducts,
  placeOrder,
} from './shop';

/** A real `POST /orders` 201 from avo_lane_b: 1x PR-01 + 2x PR-03 = 22.000. */
const ORDER_201 = {
  transaction: {
    id: 'TX-1000001',
    memberId: '8842',
    branchId: 'BR-KWC',
    kind: 'shop',
    amountFils: -22000,
    bonusFils: 0,
    method: 'wallet',
    status: 'settled',
    reference: 'AVO-SH-10001',
    createdAt: '2026-08-19T01:20:00.000Z',
    /*
      THE THIRTEENTH KEY, and the spec below predicted it by name: "if the schema
      ever grows a required thirteenth, this fails here rather than on every real
      response in production." It grew one — `customAmount`, api migration 0049 —
      and this is what that prediction cost to honour. `false` because a shop
      order is priced from the catalogue, and `custom_amount` is CHECKed
      charge-only at the database, so no `shop` row can ever carry `true`.
    */
    customAmount: false,
    voidedAt: null,
    reversedByTransactionId: null,
    /*
      NO `branchAssumed` HERE, AND ITS REMOVAL IS THE POINT. This fixture carried
      `branchAssumed: false` and the real wire does not send it:
      `serialiseTransactionForCustomer` emits exactly the twelve keys asserted in
      "the transaction's key set is the wire's" below, and that is not one of
      them — the column is written on the row so per-branch shop revenue is
      filterable, and it is merchant data, not customer data.

      Harmless today, because zod strips unknown keys. Dangerous tomorrow, and in
      the exact direction this file exists to guard: if `TransactionSchema` ever
      declared `branchAssumed` as required, this test would PASS on the fixture
      that has it while every real response failed to parse — a *successful* order
      unparseable, which is the drift that has already happened here once. A
      fixture whose stated purpose is fidelity to the wire cannot carry a field the
      wire does not send.
    */
  },
  balanceAfterFils: 2500,
  totalFils: 22000,
  items: [
    { productId: 'PR-01', name: 'Argan hair oil 100ml', qty: 1, unitPriceFils: 8500, lineTotalFils: 8500 },
    { productId: 'PR-03', name: 'Heat protect spray', qty: 2, unitPriceFils: 6750, lineTotalFils: 13500 },
  ],
  loyalty: { mode: 'tiers', visits: 6, tier: 'silver', nextTier: 'gold', visitsToNext: 4, climbed: false },
  voidable: false,
};

/**
 * CAPTURED FROM `GET /salons/SAL-AMARA/products` ON avo_lane_b, WITH A REAL
 * UPLOADED IMAGE — not hand-written, and not the mock's fixture.
 *
 * `image` arrived with `ImageRefSchema` (packages/types) and it is why this
 * fixture had to be recaptured rather than patched: `ProductSchema` used to be
 * four fields and is now five, and a fixture that carried four PARSED FINE while
 * asserting the wrong shape — zod strips unknown keys but cannot invent a
 * required one, so the four-field fixture failed the parse outright. That is the
 * good direction for this file's guard to fail in, and it caught the widening
 * within a day of it landing.
 *
 * BOTH BRANCHES OF `image` ARE HERE ON PURPOSE. PR-01 carries the real ref for a
 * 600×600 PNG uploaded through `POST /v1/salons/{id}/products/{pid}/image`;
 * PR-02 carries `null`, which is what almost every row carries today. The API
 * sends the KEY either way — required-but-nullable, never optional — precisely so
 * that a client never has to tell "no image" from "field not sent", and a fixture
 * with only one of the two branches would let that distinction rot unnoticed.
 *
 * `url` IS ABSOLUTE AND THAT IS ALSO THE WIRE'S DOING. The API builds it from
 * `PUBLIC_BASE_URL` server-side because a phone cannot resolve a path against an
 * origin nobody told it. Written out in full here rather than composed, so that a
 * server that started sending a relative path fails this parse.
 */
const PRODUCTS_200 = {
  items: [
    {
      id: 'PR-01',
      salonId: 'SAL-AMARA',
      name: 'Argan hair oil 100ml',
      priceFils: 8500,
      image: {
        id: 'IM-XFD4ATS22Z',
        url: 'http://localhost:4600/v1/images/IM-XFD4ATS22Z',
        contentType: 'image/png',
        width: 600,
        height: 600,
        byteSize: 10119,
      },
    },
    { id: 'PR-02', salonId: 'SAL-AMARA', name: 'Repair mask', priceFils: 12000, image: null },
  ],
  nextCursor: null,
};

interface Call {
  path: string;
  idempotencyKey: string | null;
  body: Record<string, unknown>;
}

function stub(respond: (path: string) => Response): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: { headers?: Record<string, string>; body?: string }) => {
      const path = url.replace(API_BASE_URL, '');
      calls.push({
        path,
        idempotencyKey: init.headers?.['idempotency-key'] ?? null,
        body: JSON.parse(init.body ?? '{}') as Record<string, unknown>,
      });
      return respond(path);
    }),
  );
  return calls;
}

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => {
  vi.unstubAllGlobals();
});

// -------------------------------------------------------------- the schemas ----

describe('the real responses parse with nothing lost', () => {
  it('keeps every field of a real order 201', () => {
    const parsed = OrderResultSchema.safeParse(ORDER_201);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(Object.keys(parsed.data).sort()).toEqual(Object.keys(ORDER_201).sort());
    expect(Object.keys(parsed.data.items[0]!).sort()).toEqual(
      Object.keys(ORDER_201.items[0]!).sort(),
    );
  });

  /**
   * THE GAP THAT LET A PHANTOM FIELD SIT IN THIS FILE. The test above compares
   * TOP-LEVEL keys and the `items[0]` keys, so a stray key nested inside
   * `transaction` was invisible to it — and `branchAssumed: false` sat there,
   * a field `serialiseTransactionForCustomer` does not emit.
   *
   * Twelve keys, captured from a real 201 on avo_lane_b. `feeFils` is deliberately
   * absent: it is merchant-visible and customer-never, and the serialiser has its
   * own comment saying so. If the schema ever grows a required thirteenth, this
   * fails here rather than on every real response in production.
   */
  it("the transaction's key set is the wire's, with no phantom field", () => {
    const parsed = OrderResultSchema.safeParse(ORDER_201);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(Object.keys(parsed.data.transaction).sort()).toEqual([
      'amountFils',
      'bonusFils',
      'branchId',
      'createdAt',
      'customAmount',
      'id',
      'kind',
      'memberId',
      'method',
      'reference',
      'reversedByTransactionId',
      'status',
      'voidedAt',
    ]);
    expect(Object.keys(ORDER_201.transaction).sort()).toEqual(
      Object.keys(parsed.data.transaction).sort(),
    );
    expect(ORDER_201.transaction).not.toHaveProperty('branchAssumed');
    expect(ORDER_201.transaction).not.toHaveProperty('feeFils');
  });

  it('keeps every field of a real products 200', () => {
    const parsed = ProductPageSchema.safeParse(PRODUCTS_200);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(Object.keys(parsed.data.items[0]!).sort()).toEqual([
      'id',
      'image',
      'name',
      'priceFils',
      'salonId',
    ]);
    // The nullable half, asserted as a KEY and not just as a falsy value — the
    // whole point of required-but-nullable is that `'image' in row` is true.
    expect('image' in parsed.data.items[1]!).toBe(true);
    expect(parsed.data.items[1]!.image).toBeNull();
    // And the ref itself survives the parse intact, dimensions included: they are
    // in the payload so a tile can reserve its space before the bytes arrive.
    expect(parsed.data.items[0]!.image).toEqual(PRODUCTS_200.items[0]!.image);
  });

  /**
   * `active` is filtered server-side and NOT emitted — the route says so
   * explicitly, and zod strips anything `ProductSchema` does not declare.
   * Declaring it would make the contract delete a key in transit; asserting its
   * absence keeps that decision visible. (`image` joining the schema does not
   * touch this: a field being ADDED deliberately is not the same event as a field
   * arriving on the wire that nobody declared.)
   */
  it('does not expect an `active` flag the route never sends', () => {
    const parsed = ProductPageSchema.parse(PRODUCTS_200);
    expect('active' in parsed.items[0]!).toBe(false);
  });

  /**
   * `voidable: false` is a positive statement — there is no reversal path for an
   * order, and a literal lets a client tell that from "this API is too old to
   * say". A literal also means a server that started sending `true` FAILS rather
   * than silently enabling an undo the API would refuse.
   */
  it('refuses voidable: true rather than accepting an undo that cannot work', () => {
    expect(OrderResultSchema.safeParse({ ...ORDER_201, voidable: true }).success).toBe(false);
  });

  it('refuses a float anywhere money lives — money is integer fils', () => {
    for (const bad of [
      { totalFils: 22000.5 },
      { balanceAfterFils: 2500.001 },
    ]) {
      expect(OrderResultSchema.safeParse({ ...ORDER_201, ...bad }).success).toBe(false);
    }
    const badLine = { ...ORDER_201, items: [{ ...ORDER_201.items[0]!, unitPriceFils: 8500.5 }] };
    expect(OrderResultSchema.safeParse(badLine).success).toBe(false);
  });

  it('refuses a stamps outcome carrying tiers fields, and vice versa', () => {
    // The discriminated union is the point: `mode` is exclusive server-side, so a
    // response with both halves is impossible and must not parse.
    const hybrid = { ...ORDER_201, loyalty: { mode: 'stamps', visits: 6, tier: 'silver' } };
    expect(OrderResultSchema.safeParse(hybrid).success).toBe(false);
  });
});

// ----------------------------------------------------------------- the body ----

describe('the order body carries no price and no branch', () => {
  /**
   * THE MISTAKE THIS PREVENTS IS ONE CHARACTER. A cart holds products; a line
   * needs `{productId, qty}`. Spreading a `Product` into the line sends
   * `priceFils` and `salonId`, and the route refuses `priceFils` BY NAME — so
   * every checkout would 400. The route refuses rather than ignores precisely
   * because a client that sent a price believed it was setting one.
   */
  it('sends exactly productId and qty per line', async () => {
    const calls = stub(() => json(ORDER_201, 201));
    await placeOrder([{ productId: 'PR-01', qty: 2 }], 'wlt-key-1');

    expect(calls[0]?.path).toBe('/orders');
    const items = calls[0]?.body['items'] as Record<string, unknown>[];
    expect(items).toHaveLength(1);
    expect(Object.keys(items[0]!).sort()).toEqual(['productId', 'qty']);
  });

  it('sends no price field under any of the four names the route refuses', async () => {
    const calls = stub(() => json(ORDER_201, 201));
    await placeOrder([{ productId: 'PR-01', qty: 1 }], 'wlt-key-2');

    const wire = JSON.stringify(calls[0]?.body);
    for (const field of ['priceFils', 'unitPriceFils', 'totalFils', 'amountFils', 'branchId']) {
      expect(wire, `body must not carry ${field}`).not.toContain(field);
    }
  });

  /**
   * Non-negotiable #4, and on THIS path it is load-bearing rather than routine:
   * an order has ONE concurrency guard where a charge has two. Lane A removed it
   * and five concurrent orders all settled with the ledger off by 36000 fils,
   * every CHECK satisfied. Verified against the real API: the same key and body
   * replays one transaction id, and the same key with a DIFFERENT body is a 422
   * rather than a replay.
   */
  it('sends the idempotency key it was given', async () => {
    const calls = stub(() => json(ORDER_201, 201));
    await placeOrder([{ productId: 'PR-01', qty: 1 }], 'wlt-order-abc');
    expect(calls[0]?.idempotencyKey).toBe('wlt-order-abc');
  });

  it('reads the shortfall off a 402 rather than computing one', async () => {
    stub(() =>
      json(
        { error: 'insufficient_balance', message: 'Not enough credit.', shortfallFils: 57500, balanceFils: 2500, dueFils: 60000 },
        402,
      ),
    );
    await expect(placeOrder([{ productId: 'PR-02', qty: 5 }], 'wlt-key-3')).rejects.toMatchObject({
      code: 'insufficient_balance',
      // #2: the server owns the balance, which includes owning the difference.
      shortfallFils: 57500,
    });
  });
});

// ------------------------------------------------------------- the shopfront ----

describe('the shopfront', () => {
  it('asks the salon-scoped path and returns the items', async () => {
    const calls = stub(() => json(PRODUCTS_200));
    const items = await getProducts('SAL-AMARA');
    expect(calls[0]?.path).toBe('/salons/SAL-AMARA/products');
    expect(items.map((p) => p.id)).toEqual(['PR-01', 'PR-02']);
  });

  it('encodes a salon id rather than interpolating it raw', async () => {
    const calls = stub(() => json(PRODUCTS_200));
    await getProducts('SAL/AMARA?x=1');
    expect(calls[0]?.path).toBe('/salons/SAL%2FAMARA%3Fx%3D1/products');
  });
});

// ------------------------------------------------------ pinned to the server ----

describe('the client mirrors the server’s own limits', () => {
  /**
   * `MAX_LINE_QTY` exists in two places — here and `shopOrder.ts`, where a CHECK
   * enforces it — so they are pinned against each other. A client that allowed 200
   * would spend a round trip to be told 99.
   */
  it('uses the same per-line ceiling the schema CHECKs', () => {
    const src = readFileSync(
      join(__dirname, '../../../../api/src/db/schema/shopOrder.ts'),
      'utf8',
    );
    const m = /MAX_LINE_QTY\s*=\s*(\d+)/.exec(src);
    expect(m?.[1]).toBe(String(MAX_LINE_QTY));
  });
});
