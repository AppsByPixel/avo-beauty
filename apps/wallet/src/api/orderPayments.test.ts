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
