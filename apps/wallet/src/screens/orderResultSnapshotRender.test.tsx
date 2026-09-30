// @vitest-environment jsdom

/**
 * THE PAYMENT-RESULT SCREEN OVER A STORED SNAPSHOT — W8, upgrade hazard 2.
 *
 * A card order's receipt is `GET /orders/payments/{id}` → `order.result`, a
 * body STORED at settlement. One settled between migrations 0060 and 0063
 * carries a `pickupBranch` with no hours and no timezone. Here that body goes
 * through the REAL `OrderPaymentViewSchema` (only the network is doubled — the
 * mock parses what it returns) and the real `ShopScreen` → invoice:
 *
 *   · the read does not throw, so the screen is the invoice, not "couldn't check";
 *   · the branch is still named ("Collect from · Kuwait City");
 *   · no hours are drawn — degraded, not invented, and never decided on the
 *     device's clock.
 *
 * The 0063 vintage is drawn alongside, so the degradation is visibly a
 * difference and not an invoice that never draws hours at all.
 */

import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
// The schemas stay REAL — `OrderPaymentViewSchema` reads `OrderResultSchema`
// lazily from this module — and only the three calls are doubled.
vi.mock('../api/shop', async () => ({
  ...(await vi.importActual<typeof import('../api/shop')>('../api/shop')),
  getProducts,
  placeOrder,
  getMyOrders,
}));

const { createOrderPayment, getOrderPayment } = vi.hoisted(() => ({
  createOrderPayment: vi.fn(),
  getOrderPayment: vi.fn(),
}));
vi.mock('../api/orderPayments', async () => ({
  ...(await vi.importActual<typeof import('../api/orderPayments')>('../api/orderPayments')),
  createOrderPayment,
  getOrderPayment,
}));
vi.mock('../api/addresses', () => ({
  listAddresses: vi.fn(async () => []),
  createAddress: vi.fn(),
  updateAddress: vi.fn(),
  removeAddress: vi.fn(),
}));
vi.mock('../api/topups', () => ({ createTopUp: vi.fn(), getTopUp: vi.fn() }));
vi.mock('../platform/gateway', () => ({
  openGateway: vi.fn(async () => ({
    opened: true,
    session: { returned: Promise.resolve(), dispose: () => undefined },
  })),
}));

/* eslint-disable import/first */
import { ShopScreen } from './ShopScreen';
import { useShop } from '../state/useShop';
import { LanguageProvider } from '../i18n/language';
import { OrderPaymentViewSchema } from '../api/orderPayments';
import { en } from '../copy/en';
import type { PickupBranchOption } from '../domain/fulfilment';
import type { BusinessHours } from '../domain/pickupHours';

const PRODUCTS: Product[] = [
  { id: 'PR-01', salonId: 'SAL-AMARA', name: 'Argan hair oil 100ml', priceFils: 8500, image: null },
];
const HOURS: BusinessHours = { morning: ['10:00', '13:00'], evening: ['16:00', '21:00'] };
const KWC_OPTION: PickupBranchOption = { id: 'BR-KWC', name: 'Kuwait City', nameAr: 'مدينة الكويت', businessHours: HOURS };

const INTENT = {
  id: 'TI-10000000',
  memberId: '8842',
  amountFils: 8500,
  bonusFils: 850,
  creditFils: 9350,
  method: 'knet',
  status: 'redirected',
  failureReason: null,
  redirectUrl: 'http://localhost:4217/_gateway/SBX-1?return=avo%3A%2F%2Ftopup%2Freturn',
  reference: 'AVO-TOP-10000000',
} as const;

/** A placed card order whose stored result names `pickupBranch` as given. */
function placed(pickupBranch: unknown) {
  return {
    intent: { ...INTENT, status: 'succeeded' },
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
          loyalty: null,
        },
        balanceAfterFils: 25350,
        pickupBranch,
      },
    },
  };
}
const OPENED = {
  intent: INTENT,
  order: { status: 'awaiting_payment', transactionId: null, refusal: null, result: null },
};

function Shell() {
  const shop = useShop('SAL-AMARA', 25350, vi.fn(), [KWC_OPTION]);
  return (
    <ShopScreen
      shop={shop}
      balanceFils={25350}
      memberFetchedAt={Date.now()}
      tier="silver"
      branches={[] as never}
      timezone="Asia/Kuwait"
      onToppedUp={vi.fn()}
      onReport={vi.fn()}
    />
  );
}

/** Pay by KNET; the settlement read answers `stored`, through the REAL schema. */
async function payByCardAndSettle(stored: unknown) {
  createOrderPayment.mockImplementation(async () => OrderPaymentViewSchema.parse(OPENED));
  let reads = 0;
  getOrderPayment.mockImplementation(async () =>
    OrderPaymentViewSchema.parse((reads += 1) === 1 ? OPENED : stored),
  );
  render(
    <LanguageProvider initial="en">
      <Shell />
    </LanguageProvider>,
  );
  await waitFor(() => expect(screen.getByTestId('shop-row-PR-01')).toBeTruthy());
  act(() => screen.getByTestId('shop-add-PR-01').click());
  act(() => screen.getByTestId('shop-cart-button').click());
  act(() => screen.getByTestId('cart-method-knet').click());
  await act(async () => {
    screen.getByTestId('cart-pay-card').click();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  getProducts.mockResolvedValue(PRODUCTS);
  getMyOrders.mockResolvedValue({ items: [], truncated: false, nextCursor: null });
});
afterEach(cleanup);

describe('a card order settled between 0060 and 0063', () => {
  it('the result screen is the invoice, naming the branch, with no hours line', async () => {
    await payByCardAndSettle(placed({ id: 'BR-KWC', name: 'Kuwait City', nameAr: 'مدينة الكويت', closed: false }));
    await waitFor(() => expect(screen.getByTestId('tx-sheet')).toBeTruthy());
    expect(screen.getByTestId('tx-rows').textContent).toContain(`${en.pickupFrom}Kuwait City`);
    expect(screen.queryByTestId('tx-pickup-hours')).toBeNull();
    expect(screen.queryByTestId('card-sheet')).toBeNull();
  });
});

describe('the same order settled after 0063', () => {
  it('draws the hours the stored result carries', async () => {
    await payByCardAndSettle(
      placed({ id: 'BR-KWC', name: 'Kuwait City', nameAr: 'مدينة الكويت', closed: false, businessHours: HOURS, businessHoursSource: 'salon', timezone: 'Asia/Kuwait' }),
    );
    await waitFor(() => expect(screen.getByTestId('tx-sheet')).toBeTruthy());
    expect(screen.getByTestId('tx-pickup-hours-hours').textContent).toBe(
      'Collect during working hours, 10 am – 1 pm and 4 pm – 9 pm',
    );
  });
});
