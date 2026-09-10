// @vitest-environment jsdom

/**
 * THE CHECKOUT, DRIVEN — the four properties of the delivery fork that are
 * either money-safe or not, and that no pure function can hold on its own.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY THIS FILE EXISTS BESIDE `useShop.test.ts`.
 *
 * That file tests `shopStatusForFailure`, a pure function, and its header says
 * "this workspace has no renderer". THAT IS NO LONGER TRUE — `vitest.config.ts`
 * aliases `react-native` to `react-native-web` and a file can opt into jsdom, so
 * `productImageRender.test.tsx` and two others render today. The claim outlived
 * the limitation, which is the defect this build has now catalogued four times.
 *
 * So the properties below are DRIVEN through the hook rather than argued from
 * the source, and every one of them is a property the source could satisfy while
 * being wrong:
 *
 *   1. A FAILED ORDER LEAVES HER CART INTACT. It falls out of `setCart({})`
 *      living inside the success path — one misplaced line from being wrong, and
 *      the cost is a customer rebuilding her basket after a network blip.
 *
 *   2. THE IDEMPOTENCY KEY DOES NOT CHANGE WHEN THE FULFILMENT DOES. This is
 *      the money-critical one. If it did, a pickup that committed without being
 *      read, retried as a delivery, would be a SECOND DEBIT. Asserted by
 *      capturing the key handed to `placeOrder` across a mode switch.
 *
 *   3. THE KEY DOES CHANGE WHEN THE CART DOES, so a new basket after a settled
 *      order does not arrive under the burned key.
 *
 *   4. A PICKUP BODY IS BYTE-IDENTICAL TO THE ONE THAT SHIPPED. Captured off
 *      the call, not read off `fulfilmentBody`.
 * ═════════════════════════════════════════════════════════════════════════════
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Product } from '../api/shop';

const { getProducts, placeOrder } = vi.hoisted(() => ({
  getProducts: vi.fn(),
  placeOrder: vi.fn(),
}));

vi.mock('../api/shop', () => ({ getProducts, placeOrder }));

// eslint-disable-next-line import/first
import { ApiError, newIdempotencyKey } from '../api/client';
// eslint-disable-next-line import/first
import { useShop } from './useShop';

const PRODUCTS: Product[] = [
  { id: 'PR-01', salonId: 'SAL-AMARA', name: 'Argan hair oil 100ml', priceFils: 8500, image: null },
  { id: 'PR-02', salonId: 'SAL-AMARA', name: 'Repair mask', priceFils: 12000, image: null },
];

/** Enough of an `OrderResult` for the hook; it stores none of it (#2). */
const ORDER = {
  transaction: {
    id: 'TX-1',
    kind: 'shop',
    amountFils: -8500,
    status: 'settled',
    createdAt: '2026-09-10T09:00:00.000Z',
  },
  balanceAfterFils: 16000,
  totalFils: 8500,
  items: [],
  loyalty: { mode: 'stamps', stamps: 1, target: 6, rewardReady: false },
  voidable: false,
};

async function mountReady(balance = 24500) {
  const onPaid = vi.fn();
  const hook = renderHook(() => useShop(balance, onPaid));
  await waitFor(() => expect(hook.result.current.status).toBe('ready'));
  return { ...hook, onPaid };
}

/** The `{ fulfilment?, addressId? }` argument `placeOrder` was handed. */
function bodyOf(call: number): Record<string, unknown> {
  return (placeOrder.mock.calls[call]?.[2] ?? {}) as Record<string, unknown>;
}

function keyOf(call: number): string {
  return placeOrder.mock.calls[call]?.[1] as string;
}

beforeEach(() => {
  vi.clearAllMocks();
  getProducts.mockResolvedValue(PRODUCTS);
  placeOrder.mockResolvedValue(ORDER);
});

describe('the fork defaults to pickup and sends nothing for it', () => {
  it('opens on pickup with no address and nothing blocking', async () => {
    const { result } = await mountReady();
    expect(result.current.fulfilment).toEqual({ mode: 'pickup', addressId: null });
    expect(result.current.block).toBeNull();
  });

  /**
   * THE SHIPPED REQUEST, BYTE FOR BYTE. `routes/orders.ts` reads
   * `body.fulfilment ?? 'pickup'`, so a pickup contributes NO keys and the path
   * that has been driven and tested is not re-entered through a new branch.
   */
  it('sends no fulfilment and no addressId on a pickup order', async () => {
    const { result } = await mountReady();
    act(() => result.current.add('PR-01'));
    await act(async () => {
      await result.current.checkout();
    });

    expect(placeOrder).toHaveBeenCalledTimes(1);
    expect(bodyOf(0)).toEqual({});
  });
});

describe('delivery', () => {
  it('blocks checkout until an address is chosen, and does not call the API', async () => {
    const { result } = await mountReady();
    act(() => result.current.add('PR-01'));
    act(() => result.current.setFulfilment('delivery'));

    expect(result.current.block).toBe('noAddress');

    await act(async () => {
      await result.current.checkout();
    });

    /*
      NOT SENT. The sheet disables the button on the same predicate, and this is
      the second gate — `checkout` is reachable from a caller that did not read
      `block`, and the honest failure of an unsubmittable form is not sending it.
      The refusal set is the SERVER's own, so she reads one sentence either way.
    */
    expect(placeOrder).not.toHaveBeenCalled();
    expect(result.current.refusal).toEqual({ kind: 'noAddress' });
  });

  it('sends fulfilment and addressId once an address is chosen', async () => {
    const { result } = await mountReady();
    act(() => result.current.add('PR-01'));
    act(() => result.current.chooseAddress('ADR-1'));

    // Choosing an address IMPLIES delivery — she tapped a specific address.
    expect(result.current.fulfilment).toEqual({ mode: 'delivery', addressId: 'ADR-1' });
    expect(result.current.block).toBeNull();

    await act(async () => {
      await result.current.checkout();
    });
    expect(bodyOf(0)).toEqual({ fulfilment: 'delivery', addressId: 'ADR-1' });
  });

  /**
   * SWITCHING BACK TO PICKUP DROPS THE ADDRESS ON THE WIRE while KEEPING it in
   * state. `services/order.ts` refuses pickup-with-an-address by name
   * (`address_not_for_pickup`) because the database makes it unstorable — so a
   * customer who changes her mind must not have her order refused for a field
   * she cannot see.
   */
  it('drops the address from a pickup body but keeps her selection', async () => {
    const { result } = await mountReady();
    act(() => result.current.add('PR-01'));
    act(() => result.current.chooseAddress('ADR-1'));
    act(() => result.current.setFulfilment('pickup'));

    expect(result.current.fulfilment).toEqual({ mode: 'pickup', addressId: 'ADR-1' });

    await act(async () => {
      await result.current.checkout();
    });
    expect(bodyOf(0)).toEqual({});
  });

  /**
   * A DELETED SELECTION IS LOST AND NEVER REPLACED. Driven through the hook,
   * with other addresses present, because an empty list would pass an
   * implementation that took the first id.
   */
  it('loses a selection the address book no longer has', async () => {
    const { result } = await mountReady();
    act(() => result.current.chooseAddress('ADR-GONE'));
    act(() => result.current.reconcileAddresses(['ADR-1', 'ADR-2']));

    expect(result.current.fulfilment).toEqual({ mode: 'delivery', addressId: null });
    expect(result.current.block).toBe('noAddress');
  });
});

describe('the idempotency key', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE MONEY-CRITICAL PROPERTY OF THIS WHOLE SLICE.
   *
   * The API hashes `{items, fulfilment, addressId}` and answers 422 for one key
   * with two bodies. The tempting client move is to mirror that by putting the
   * fulfilment into the key's signature. THAT IS A DOUBLE CHARGE:
   *
   *   she taps Pay as a pickup; the response never arrives;
   *   she switches to delivery and taps again.
   *
   *   SAME key  → the first committed: 422, one debit, she is told it was placed.
   *               the first rolled back: the key was never persisted, 201, one
   *               debit.
   *   NEW key   → the first committed: a second order and A SECOND DEBIT over a
   *               cart she never saw emptied.
   *
   * So the key must be identical across a fulfilment change, and that is
   * asserted by capturing what `placeOrder` was actually handed rather than by
   * reading `cartSignature`.
   * ═══════════════════════════════════════════════════════════════════════════
   */
  it('does not change when the fulfilment changes under an unchanged cart', async () => {
    // The first attempt fails without a readable outcome — the case that matters.
    placeOrder.mockRejectedValueOnce(new ApiError('offline', 'No connection.', 'WLT-1', null));

    const { result } = await mountReady();
    act(() => result.current.add('PR-01'));

    await act(async () => {
      await result.current.checkout();
    });
    expect(result.current.refusal).toEqual({ kind: 'offline' });

    act(() => result.current.chooseAddress('ADR-1'));
    await act(async () => {
      await result.current.checkout();
    });

    expect(placeOrder).toHaveBeenCalledTimes(2);
    expect(keyOf(1)).toBe(keyOf(0));
    // And the second attempt genuinely carried a different body, which is the
    // whole reason the key staying the same is the safe answer.
    expect(bodyOf(0)).toEqual({});
    expect(bodyOf(1)).toEqual({ fulfilment: 'delivery', addressId: 'ADR-1' });
  });

  it('does not change when only the chosen address changes', async () => {
    placeOrder.mockRejectedValueOnce(new ApiError('offline', 'No connection.', 'WLT-1', null));

    const { result } = await mountReady();
    act(() => result.current.add('PR-01'));
    act(() => result.current.chooseAddress('ADR-1'));
    await act(async () => {
      await result.current.checkout();
    });
    act(() => result.current.chooseAddress('ADR-2'));
    await act(async () => {
      await result.current.checkout();
    });

    expect(keyOf(1)).toBe(keyOf(0));
  });

  /**
   * IT DOES CHANGE WHEN THE CART CHANGES. Still load-bearing for its one case:
   * after an order settles the cart is emptied, she adds something else, and that
   * new cart must not arrive under the key the settled order burned.
   */
  it('changes when the cart changes', async () => {
    placeOrder.mockRejectedValueOnce(new ApiError('offline', 'No connection.', 'WLT-1', null));

    const { result } = await mountReady();
    act(() => result.current.add('PR-01'));
    await act(async () => {
      await result.current.checkout();
    });
    act(() => result.current.add('PR-02'));
    await act(async () => {
      await result.current.checkout();
    });

    expect(keyOf(1)).not.toBe(keyOf(0));
  });

  /**
   * GUARDS THE THREE ASSERTIONS ABOVE. `keyOf(0) === keyOf(1)` is also satisfied
   * by two `undefined`s, so the equality tests are worthless unless a real key
   * reaches `placeOrder`. Driven rather than assumed.
   */
  it('hands placeOrder a real key, so the equality tests mean something', async () => {
    const { result } = await mountReady();
    act(() => result.current.add('PR-01'));
    await act(async () => {
      await result.current.checkout();
    });
    expect(typeof keyOf(0)).toBe('string');
    expect(keyOf(0).length).toBeGreaterThan(8);
    expect(newIdempotencyKey().length).toBeGreaterThan(8);
  });
});

describe('a refused order leaves her cart intact', () => {
  /**
   * ONE TEST PER REFUSAL, because the property is "no path through the catch
   * clears the cart" and a single case cannot say that. The four below are every
   * shape the classifier produces from a real refusal.
   */
  const REFUSALS = [
    ['offline', new ApiError('offline', 'No connection.', 'WLT-1', null), { kind: 'offline' }],
    /*
      A 402 WITH NO SHORTFALL IN THE BODY. `orderRefusal` deliberately falls
      through to `failed` for this rather than rendering "Balance too low by
      0.000" — the existing spec's own note — so it is listed here under its
      real classification and not under the one the status suggests.
    */
    ['a 402 with no shortfall body', new ApiError('server', 'Too low.', 'WLT-1', 402), { kind: 'failed' }],
    [
      'a retired product',
      new ApiError('server', 'Gone.', 'WLT-1', 400, 'invalid_products'),
      { kind: 'stale', ids: [] },
    ],
    [
      'a reused key',
      new ApiError('server', 'Already used.', 'WLT-1', 422, 'idempotency_key_reused'),
      { kind: 'alreadyPlaced' },
    ],
    ['anything else', new TypeError('bad parse'), { kind: 'failed' }],
  ] as const;

  for (const [name, thrown, refusal] of REFUSALS) {
    it(`keeps the cart after ${name}`, async () => {
      placeOrder.mockRejectedValueOnce(thrown);
      const { result, onPaid } = await mountReady();
      act(() => result.current.add('PR-01'));
      act(() => result.current.add('PR-01'));
      act(() => result.current.add('PR-02'));

      await act(async () => {
        await result.current.checkout();
      });

      // Three items in two lines, exactly as she left them.
      expect(result.current.cart).toEqual({ 'PR-01': 2, 'PR-02': 1 });
      expect(result.current.count).toBe(3);
      // And the wallet is NOT asked to re-read: nothing moved.
      expect(onPaid).not.toHaveBeenCalled();
      if (refusal !== null) expect(result.current.refusal).toEqual(refusal);
    });
  }

  /**
   * AND THE FULFILMENT CHOICE SURVIVES TOO. She chose delivery to an address; a
   * network blip must not silently put her back on pickup, which would be the
   * app changing her destination without saying so.
   */
  it('keeps the delivery choice after a refusal', async () => {
    placeOrder.mockRejectedValueOnce(new ApiError('offline', 'No connection.', 'WLT-1', null));
    const { result } = await mountReady();
    act(() => result.current.add('PR-01'));
    act(() => result.current.chooseAddress('ADR-1'));

    await act(async () => {
      await result.current.checkout();
    });

    expect(result.current.fulfilment).toEqual({ mode: 'delivery', addressId: 'ADR-1' });
  });
});

describe('a settled order clears the cart and the choice together', () => {
  /**
   * Her next order is a NEW decision. Leaving `delivery` selected would carry a
   * destination across a purchase boundary, so the next cart would open already
   * committed to an address she chose for a different basket.
   */
  it('empties the cart, resets to pickup, and asks the wallet to re-read', async () => {
    const { result, onPaid } = await mountReady();
    act(() => result.current.add('PR-01'));
    act(() => result.current.chooseAddress('ADR-1'));

    await act(async () => {
      await result.current.checkout();
    });

    expect(result.current.cart).toEqual({});
    expect(result.current.fulfilment).toEqual({ mode: 'pickup', addressId: null });
    expect(onPaid).toHaveBeenCalledTimes(1);
  });

  /**
   * #2: `balanceAfterFils` is on the response and this hook stores it NOWHERE.
   * The balance on screen is the server's answer to `GET /members/me`, and a
   * client that carried the figure across would be the seam a locally-mutated
   * balance arrives through later.
   */
  it('does not store balanceAfterFils anywhere in its state', async () => {
    const { result } = await mountReady();
    act(() => result.current.add('PR-01'));
    await act(async () => {
      await result.current.checkout();
    });
    expect(JSON.stringify(result.current)).not.toContain('16000');
  });
});
