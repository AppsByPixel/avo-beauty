// @vitest-environment jsdom

/**
 * THE SHOP, PAID BY CARD — client ask W2, rendered through the real screen.
 *
 * `ShopScreen`, `useShop`, `useCardCheckout`, `CartSheet` and `CardOrderSheet`
 * are the shipped ones. Mocked: the wire (`api/shop`, `api/orderPayments`,
 * `api/addresses`, `api/topups`) and the browser (`platform/gateway`, which only
 * ever says "the page opened" plus a hint that she is back — never an outcome).
 *
 * THE VIEWS ARE THE REAL ONES. `REFUSED_RACE` is `GET /orders/payments/TI-10000001`
 * captured on avo_lane_b (2026-09-28) after PR-02's price was changed while the
 * sandbox hosted page was open; `DECLINED` is `TI-10000003`. Their `message`
 * fields are the server's English, kept verbatim so a screen that rendered them
 * is caught.
 *
 * What is pinned:
 *   · the method choice is visible at checkout even when the balance covers it;
 *   · the wallet path is unchanged — `POST /orders`, same arguments, no card call;
 *   · the key is stable across a retry of the same basket and different across
 *     baskets (and after an attempt ends);
 *   · the outcome comes from `GET /orders/payments/{id}`, not the POST, not the
 *     return from the page;
 *   · the race says "your money is in your wallet" and why, FROM THE CODE, in
 *     English and Arabic;
 *   · pending offers no retry, and holds both pay buttons.
 */

import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Language } from '@avo/types';
import type { Product } from '../api/shop';

vi.mock('react-native-svg', () => {
  const nothing = () => null;
  return { default: nothing, Svg: nothing, Path: nothing, Circle: nothing, Rect: nothing, G: nothing };
});

const { getProducts, placeOrder, getMyOrders } = vi.hoisted(() => ({
  getProducts: vi.fn(),
  placeOrder: vi.fn(),
  getMyOrders: vi.fn(),
}));
vi.mock('../api/shop', () => ({ getProducts, placeOrder, getMyOrders }));

const { createOrderPayment, getOrderPayment } = vi.hoisted(() => ({
  createOrderPayment: vi.fn(),
  getOrderPayment: vi.fn(),
}));
vi.mock('../api/orderPayments', () => ({ createOrderPayment, getOrderPayment }));

vi.mock('../api/addresses', () => ({
  listAddresses: vi.fn(async () => []),
  createAddress: vi.fn(),
  updateAddress: vi.fn(),
  removeAddress: vi.fn(),
}));
vi.mock('../api/topups', () => ({ createTopUp: vi.fn(), getTopUp: vi.fn() }));

const { openGateway } = vi.hoisted(() => ({
  openGateway: vi.fn(async () => ({
    opened: true,
    session: { returned: Promise.resolve(), dispose: () => undefined },
  })),
}));
vi.mock('../platform/gateway', () => ({ openGateway }));

/* eslint-disable import/first */
import { ShopScreen } from './ShopScreen';
import { useShop } from '../state/useShop';
import { LanguageProvider } from '../i18n/language';
import { ApiError } from '../api/client';
import { en } from '../copy/en';
import { ar } from '../copy/ar';

const PRODUCTS: Product[] = [
  { id: 'PR-01', salonId: 'SAL-AMARA', name: 'Argan hair oil 100ml', priceFils: 8500, image: null },
  { id: 'PR-02', salonId: 'SAL-AMARA', name: 'Repair mask', priceFils: 12000, image: null },
];

/** 25.350 KD — covers either product, so the wallet path would pay directly. */
const BALANCE = 25350;

const INTENT = {
  id: 'TI-10000001',
  memberId: '8842',
  amountFils: 12000,
  bonusFils: 1200,
  creditFils: 13200,
  method: 'card',
  status: 'redirected',
  failureReason: null,
  redirectUrl:
    'http://localhost:4217/_gateway/SBX-A246CDE2C0A5?return=avo%3A%2F%2Ftopup%2Freturn%3Fintent%3DTI-10000001',
  reference: 'AVO-TOP-10000001',
} as const;

/** What the POST answers — AND what a replay answers, stale, forever. */
const OPENED = {
  intent: INTENT,
  order: { status: 'awaiting_payment', transactionId: null, refusal: null, result: null },
} as const;

/** Captured. Paid, credited, refused — `price_changed`, with the server's English. */
const REFUSED_RACE = {
  intent: { ...INTENT, status: 'succeeded' },
  order: {
    status: 'refused',
    transactionId: null,
    refusal: {
      code: 'price_changed',
      message:
        'A price in your basket changed while you were paying. The payment is in your wallet — check the basket and pay from your balance.',
    },
    result: null,
  },
} as const;

const DECLINED = {
  intent: { ...INTENT, id: 'TI-10000003', status: 'failed', failureReason: 'declined', method: 'knet' },
  order: { status: 'not_paid', transactionId: null, refusal: null, result: null },
} as const;

const PENDING = { intent: { ...INTENT, status: 'pending' }, order: OPENED.order } as const;

let rereads = 0;

function Shell() {
  const [n, setN] = useState(0);
  rereads = n;
  const shop = useShop(BALANCE, () => setN((x) => x + 1), []);
  return (
    <ShopScreen
      shop={shop}
      balanceFils={BALANCE}
      memberFetchedAt={Date.now()}
      tier="silver"
      branches={[] as never}
      onToppedUp={() => setN((x) => x + 1)}
      onReport={vi.fn()}
    />
  );
}

async function cartWith(productIds: string[], lang: Language = 'en') {
  render(
    <LanguageProvider initial={lang}>
      <Shell />
    </LanguageProvider>,
  );
  await waitFor(() => expect(screen.getByTestId('shop-row-PR-01')).toBeTruthy());
  for (const id of productIds) act(() => screen.getByTestId(`shop-add-${id}`).click());
  act(() => screen.getByTestId('shop-cart-button').click());
}

const choose = (method: string) => act(() => screen.getByTestId(`cart-method-${method}`).click());
async function payByCard() {
  await act(async () => {
    screen.getByTestId('cart-pay-card').click();
  });
}
const keysSent = () => createOrderPayment.mock.calls.map((c) => c[3] as string);

beforeEach(() => {
  vi.clearAllMocks();
  getProducts.mockResolvedValue(PRODUCTS);
  getMyOrders.mockResolvedValue({ items: [], truncated: false, nextCursor: null });
  placeOrder.mockResolvedValue({});
  createOrderPayment.mockResolvedValue(OPENED);
});
afterEach(cleanup);

// ------------------------------------------------------------ the choice --

describe('the method choice is visible at checkout', () => {
  it('with a balance that covers the basket, all four methods are there and wallet is chosen', async () => {
    await cartWith(['PR-01']);
    for (const m of ['wallet', 'knet', 'applepay', 'card']) {
      expect(screen.getByTestId(`cart-method-${m}`)).toBeTruthy();
    }
    expect(screen.getByTestId('cart-method-wallet').getAttribute('aria-checked')).toBe('true');
    // The wallet CTA, exactly as before.
    expect(screen.getByTestId('cart-pay').textContent).toBe(en.cartPayCta('8.500 KD'));
  });

  it('choosing KNET swaps the CTA for the one-step card payment — and shows no fee', async () => {
    await cartWith(['PR-01']);
    choose('knet');
    expect(screen.getByTestId('cart-pay-card').textContent).toBe(en.cartPayWith('8.500 KD', en.payMethod.knet));
    expect(screen.queryByTestId('cart-pay')).toBeNull();
    expect(screen.getByTestId('cart-sheet').textContent ?? '').not.toMatch(/fee/i);
  });
});

describe('the wallet path is unchanged', () => {
  it('Pay from wallet is still POST /orders with the cart, the key and the pickup body — no card call', async () => {
    await cartWith(['PR-01']);
    await act(async () => {
      screen.getByTestId('cart-pay').click();
    });
    expect(placeOrder).toHaveBeenCalledTimes(1);
    const [items, key, body] = placeOrder.mock.calls[0]!;
    expect(items).toEqual([{ productId: 'PR-01', qty: 1 }]);
    expect(typeof key).toBe('string');
    expect(body).toEqual({});
    expect(createOrderPayment).not.toHaveBeenCalled();
  });
});

describe('the rails do not double up', () => {
  /*
    A wallet order whose answer never arrived may have SETTLED — `useShop`
    offers no retry for exactly that reason. Paying the same basket by card
    right after would be a second payment by the other door, so the card
    button is held by the same refusal that holds the wallet one.
  */
  it('after a wallet order with an unknown outcome, the card button is held too', async () => {
    placeOrder.mockRejectedValueOnce(new ApiError('offline', 'No connection.', 'WLT-3333-4444', null));
    await cartWith(['PR-01']);
    await act(async () => {
      screen.getByTestId('cart-pay').click();
    });
    await waitFor(() => expect(screen.getByTestId('cart-offline')).toBeTruthy());
    choose('knet');
    const card = screen.getByTestId('cart-pay-card');
    expect(card.getAttribute('aria-disabled')).toBe('true');
    await act(async () => {
      card.click();
    });
    expect(createOrderPayment).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------------ #4 key --

describe('the idempotency key is derived from the basket (#4)', () => {
  it('is STABLE across a retry of the same basket', async () => {
    createOrderPayment.mockRejectedValueOnce(
      new ApiError('offline', 'No connection.', 'WLT-1111-2222', null),
    );
    getOrderPayment.mockResolvedValue(REFUSED_RACE);
    await cartWith(['PR-02']);
    choose('card');
    await payByCard();
    await waitFor(() => expect(screen.getByTestId('card-start-failed')).toBeTruthy());
    expect(screen.getByTestId('card-start-failed-body').textContent).toBe(en.cardOrderStartFailedBody);

    await act(async () => {
      screen.getByTestId('card-retry-start').click();
    });
    await waitFor(() => expect(createOrderPayment).toHaveBeenCalledTimes(2));
    expect(keysSent()[1]).toBe(keysSent()[0]);
  });

  it('is DIFFERENT for a different basket', async () => {
    getOrderPayment.mockResolvedValue(DECLINED);
    await cartWith(['PR-01']);
    choose('knet');
    await payByCard();
    await waitFor(() => expect(screen.getByTestId('card-declined')).toBeTruthy());
    await act(async () => {
      screen.getByTestId('card-close').click();
    });
    // A different basket: one more of PR-01.
    act(() => screen.getByTestId('cart-step-PR-01-inc').click());
    await payByCard();
    await waitFor(() => expect(createOrderPayment).toHaveBeenCalledTimes(2));
    expect(keysSent()[1]).not.toBe(keysSent()[0]);
  });

  it('is NEW after the attempt ended — "Try again" after a decline reaches the bank again', async () => {
    getOrderPayment.mockResolvedValue(DECLINED);
    await cartWith(['PR-01']);
    choose('knet');
    await payByCard();
    await waitFor(() => expect(screen.getByTestId('card-declined')).toBeTruthy());
    await act(async () => {
      screen.getByTestId('card-try-again').click();
    });
    await waitFor(() => expect(createOrderPayment).toHaveBeenCalledTimes(2));
    expect(keysSent()[1]).not.toBe(keysSent()[0]);
  });
});

// ---------------------------------------------------------- #2 the outcome --

describe('the outcome comes from GET /orders/payments/{id} (#2)', () => {
  it('reads the GET before opening the page, and again after she returns', async () => {
    getOrderPayment.mockResolvedValueOnce(OPENED).mockResolvedValueOnce(REFUSED_RACE);
    await cartWith(['PR-02']);
    choose('card');
    await payByCard();
    await waitFor(() => expect(screen.getByTestId('card-refused')).toBeTruthy());
    expect(getOrderPayment).toHaveBeenCalledTimes(2);
    expect(getOrderPayment).toHaveBeenCalledWith('TI-10000001');
    expect(openGateway).toHaveBeenCalledTimes(1);
    // No order was placed by the client, and no wallet order was attempted.
    expect(placeOrder).not.toHaveBeenCalled();
  });

  it('a POST answered "awaiting" and a return from the page decide nothing — the GET does', async () => {
    // The page opens, she comes back, and the server still says awaiting until
    // it says declined. A client that trusted the return would show success.
    getOrderPayment
      .mockResolvedValueOnce(OPENED)
      .mockResolvedValueOnce(DECLINED);
    await cartWith(['PR-01']);
    choose('knet');
    await payByCard();
    await waitFor(() => expect(screen.getByTestId('card-declined')).toBeTruthy());
    expect(screen.getByTestId('card-declined-body').textContent).toBe(en.cardOrderDeclined);
  });

  it('never opens the bank page for an intent the bank already has (pending)', async () => {
    getOrderPayment.mockResolvedValue(PENDING);
    await cartWith(['PR-02']);
    choose('card');
    await payByCard();
    await waitFor(() => expect(screen.getByTestId('card-pending')).toBeTruthy());
    expect(openGateway).not.toHaveBeenCalled();
  });
});

// --------------------------------------------------------------- the race --

describe('the race: paid, credited, refused — "your money is in your wallet", from the CODE', () => {
  it.each([
    ['en', en, '13.200 KD'],
    ['ar', ar, '13.200 د.ك'],
  ] as const)('%s', async (lang, copy, inWallet) => {
    getOrderPayment.mockResolvedValue(REFUSED_RACE);
    await cartWith(['PR-02'], lang);
    choose('card');
    await payByCard();
    await waitFor(() => expect(screen.getByTestId('card-refused')).toBeTruthy());

    expect(screen.getByTestId('card-refused-title').textContent).toBe(copy.cardOrderRefusedTitle);
    expect(screen.getByTestId('card-refused-body').textContent).toBe(copy.cardOrderRefusedBody(inWallet));
    expect(screen.getByTestId('card-refused-reason').textContent).toBe(copy.cardOrderRefusal.price_changed);
    // The server's English sentence is never on screen, in either language.
    expect(screen.getByTestId('card-sheet').textContent).not.toContain(REFUSED_RACE.order.refusal.message);
    // The money landed, so the wallet is re-read; the basket is KEPT.
    expect(rereads).toBeGreaterThan(0);
    await act(async () => {
      screen.getByTestId('card-back').click();
    });
    expect(screen.getByTestId('cart-line-PR-02')).toBeTruthy();
  });

  it('an unknown code still says the money is in her wallet, with the neutral reason', async () => {
    getOrderPayment.mockResolvedValue({
      ...REFUSED_RACE,
      order: { ...REFUSED_RACE.order, refusal: { code: 'order_failed', message: 'We could not place your order.' } },
    });
    await cartWith(['PR-02'], 'ar');
    choose('card');
    await payByCard();
    await waitFor(() => expect(screen.getByTestId('card-refused')).toBeTruthy());
    expect(screen.getByTestId('card-refused-title').textContent).toBe(ar.cardOrderRefusedTitle);
    expect(screen.getByTestId('card-refused-reason').textContent).toBe(ar.cardOrderRefusal.other);
  });
});

// ------------------------------------------------------ placed and pending --

describe('placed and pending', () => {
  it('placed: the basket is emptied, the wallet re-read, and the card sheet closes', async () => {
    getOrderPayment.mockResolvedValue({
      intent: { ...INTENT, status: 'succeeded' },
      order: { status: 'placed', transactionId: 'TX-10000001', refusal: null, result: null },
    });
    await cartWith(['PR-02']);
    choose('card');
    await payByCard();
    await waitFor(() => expect(screen.queryByTestId('card-sheet')).toBeNull());
    expect(screen.queryByTestId('shop-cart-badge')).toBeNull();
    expect(rereads).toBeGreaterThan(0);
  });

  it('pending: no "Try again", and both pay buttons are held until she checks it', async () => {
    getOrderPayment.mockResolvedValue(PENDING);
    await cartWith(['PR-02']);
    choose('card');
    await payByCard();
    await waitFor(() => expect(screen.getByTestId('card-pending')).toBeTruthy());
    expect(screen.queryByTestId('card-try-again')).toBeNull();
    await act(async () => {
      screen.getByTestId('card-close').click();
    });
    expect(screen.getByTestId('cart-card-open').textContent).toContain(en.cardOrderOpen);
    expect(screen.queryByTestId('cart-pay-card')).toBeNull();
    // The wallet rail is held too — a second payment beside a pending one.
    choose('wallet');
    expect(screen.queryByTestId('cart-pay')).toBeNull();
    // "Check the payment" re-reads the SAME intent; it does not open a new one.
    getOrderPayment.mockResolvedValue(REFUSED_RACE);
    await act(async () => {
      screen.getByTestId('cart-card-check').click();
    });
    await waitFor(() => expect(screen.getByTestId('card-refused')).toBeTruthy());
    expect(createOrderPayment).toHaveBeenCalledTimes(1);
  });
});
