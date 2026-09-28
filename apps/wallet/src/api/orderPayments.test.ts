/**
 * `POST /orders/payments` and `GET /orders/payments/{id}` at the boundary.
 *
 * The bodies below are CAPTURED from the real API on avo_lane_b, 2026-09-28:
 * a placed KNET order (`TI-10000000`), the race (`TI-10000001`, PR-02 repriced
 * while the sandbox page was open) and a decline (`TI-10000003`).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './client';
import { createOrderPayment, getOrderPayment, OrderPaymentViewSchema } from './orderPayments';

const PLACED = {
  intent: {
    id: 'TI-10000000', memberId: '8842', amountFils: 8500, bonusFils: 850, creditFils: 9350,
    method: 'knet', status: 'succeeded', failureReason: null,
    redirectUrl: 'http://localhost:4217/_gateway/SBX-500054250BF2?return=avo%3A%2F%2Ftopup%2Freturn%3Fintent%3DTI-10000000',
    reference: 'AVO-TOP-10000000',
  },
  order: {
    status: 'placed',
    transactionId: 'TX-10000001',
    refusal: null,
    result: {
      items: [{ qty: 1, name: 'Argan hair oil 100ml', productId: 'PR-01', lineTotalFils: 8500, unitPriceFils: 8500 }],
      loyalty: { mode: 'tiers', tier: 'silver', visits: 6, climbed: false, nextTier: 'gold', visitsToNext: 4 },
      voidable: false,
      totalFils: 8500,
      transaction: {
        id: 'TX-10000001', kind: 'shop', method: 'wallet', status: 'settled', branchId: 'BR-KWC',
        memberId: '8842', voidedAt: null, bonusFils: 0, createdAt: '2026-09-28T08:38:19.014Z',
        reference: 'AVO-SH-10000001', amountFils: -8500, customAmount: false, reversedByTransactionId: null,
      },
      balanceAfterFils: 25350,
    },
  },
};

const REFUSED = {
  intent: { ...PLACED.intent, id: 'TI-10000001', amountFils: 12000, bonusFils: 1200, creditFils: 13200, method: 'card' },
  order: {
    status: 'refused',
    transactionId: null,
    refusal: {
      code: 'price_changed',
      message: 'A price in your basket changed while you were paying. The payment is in your wallet — check the basket and pay from your balance.',
    },
    result: null,
  },
};

const DECLINED = {
  intent: { ...PLACED.intent, id: 'TI-10000003', status: 'failed', failureReason: 'declined', amountFils: 6750, bonusFils: 675, creditFils: 7425 },
  order: { status: 'not_paid', transactionId: null, refusal: null, result: null },
};

interface Call { url: string; method: string; headers: Record<string, string>; body: unknown }

function stub(body: unknown, status = 200): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', (url: string, init: RequestInit = {}) => {
    calls.push({
      url,
      method: init.method ?? 'GET',
      headers: (init.headers ?? {}) as Record<string, string>,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  });
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe('the captured views parse', () => {
  it.each([
    ['placed', PLACED],
    ['refused', REFUSED],
    ['not_paid', DECLINED],
  ])('%s', (status, body) => {
    expect(OrderPaymentViewSchema.parse(body).order.status).toBe(status);
  });

  it('carries no fee — the customer projection has none to show', () => {
    const parsed = OrderPaymentViewSchema.parse({ ...REFUSED, intent: { ...REFUSED.intent, feeFils: 350 } });
    expect('feeFils' in parsed.intent).toBe(false);
  });

  it('a float in the intent is a failed read, not a figure', async () => {
    stub({ ...REFUSED, intent: { ...REFUSED.intent, creditFils: 13.2 } });
    const err = await getOrderPayment('TI-10000001').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).kind).toBe('server');
  });
});

describe('the wire', () => {
  it('POSTs the bare path with { items, method } only, and the key in the header (#4)', async () => {
    const calls = stub(REFUSED, 201);
    await createOrderPayment([{ productId: 'PR-02', qty: 1 }], 'card', {}, 'wlt-basket-key');
    expect(new URL(calls[0]!.url).pathname).toBe('/orders/payments');
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.headers['idempotency-key']).toBe('wlt-basket-key');
    // No price, no branch, no balance — the server prices from its own rows (#2).
    expect(calls[0]!.body).toEqual({ items: [{ productId: 'PR-02', qty: 1 }], method: 'card' });
  });

  it('a delivery carries the address id and nothing else about the address', async () => {
    const calls = stub(REFUSED, 201);
    await createOrderPayment([{ productId: 'PR-02', qty: 2 }], 'knet', { fulfilment: 'delivery', addressId: 'ADR-1' }, 'k');
    expect(calls[0]!.body).toEqual({
      items: [{ productId: 'PR-02', qty: 2 }],
      method: 'knet',
      fulfilment: 'delivery',
      addressId: 'ADR-1',
    });
  });

  it('GETs the authoritative read by intent id', async () => {
    const calls = stub(DECLINED);
    await getOrderPayment('TI-10000003');
    expect(new URL(calls[0]!.url).pathname).toBe('/orders/payments/TI-10000003');
  });
});

/**
 * THE STORED SNAPSHOT HAZARD — W8. `order.result` is written ONCE, at
 * settlement (`topup_intent.order_result`), and read back verbatim for as long
 * as she can open the payment. So `GET /orders/payments/{id}` answers bodies of
 * three vintages, and all three were real card payments:
 *
 *   before 0060   no `pickupBranch` key at all
 *   0060 – 0062   `pickupBranch: { id, name, nameAr, closed }` — NO hours, no zone
 *   0063 on       `pickupBranch` with `businessHours`, `businessHoursSource`,
 *                 `timezone`
 *
 * `ShopOrderSchema.pickupBranch` now requires the 0063 fields. Parsed against it
 * strictly, the middle vintage fails, the read throws, and a customer whose card
 * WAS charged is told the app could not check her payment. So these must all
 * parse, and only the last may carry hours.
 */
describe('a card order settled before migration 0063 still reads', () => {
  const KWC = { id: 'BR-KWC', name: 'Kuwait City', nameAr: 'مدينة الكويت', closed: false };
  const HOURS = { morning: ['10:00', '13:00'], evening: ['16:00', '21:00'] };
  const withBranch = (pickupBranch: unknown) => ({
    ...PLACED,
    order: { ...PLACED.order, result: { ...PLACED.order.result, pickupBranch } },
  });

  it('before 0060 — no key — parses, with no branch', async () => {
    stub(PLACED);
    const view = await getOrderPayment('TI-10000000');
    expect(view.order.result?.pickupBranch).toBeUndefined();
  });

  it('0060–0062 — a branch with NO hours and NO zone — parses, and names the branch', async () => {
    stub(withBranch(KWC));
    const view = await getOrderPayment('TI-10000000');
    expect(view.order.status).toBe('placed');
    expect(view.order.result?.pickupBranch).toEqual(KWC);
  });

  it('0063 on — the hours and the zone come through', async () => {
    stub(withBranch({ ...KWC, businessHours: HOURS, businessHoursSource: 'salon', timezone: 'Asia/Kuwait' }));
    const view = await getOrderPayment('TI-10000000');
    expect(view.order.result?.pickupBranch?.businessHours).toEqual(HOURS);
    expect(view.order.result?.pickupBranch?.timezone).toBe('Asia/Kuwait');
  });

  it('relaxed, not loosened: hours that ARE present are still checked, and a branch still needs a name', () => {
    expect(() =>
      OrderPaymentViewSchema.parse(withBranch({ ...KWC, businessHours: { morning: ['banana', 7] } })),
    ).toThrow();
    expect(() => OrderPaymentViewSchema.parse(withBranch({ id: 'BR-KWC', closed: false }))).toThrow();
  });
});
