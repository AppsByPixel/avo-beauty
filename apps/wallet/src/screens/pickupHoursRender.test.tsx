// @vitest-environment jsdom

/**
 * W8 — "please collect during the branch's official working hours", RENDERED,
 * on every surface that names a pickup branch: the picker's rows, the
 * single-branch tile, the invoice, and her orders list. (The bell's lines are
 * pinned in `domain/pickupBranch.test.ts`, the zone arithmetic in
 * `domain/pickupHours.test.ts`.) Real `ShopScreen`, `useShop`, `CartSheet`,
 * `FulfilmentSection`, `TransactionSheet`, `OrdersSheet`; only the wire, the
 * browser and the CLOCK are doubled.
 *
 * THE DEVICE IS ON KARACHI TIME HERE, as the machine this was written on is,
 * and the clock is pinned (Date only — timers stay real so React settles):
 *
 *   AFTER_HOURS   UTC 18:30  Kuwait 21:30 — closed, collect tomorrow
 *   OPEN_EVENING  UTC 17:30  Kuwait 20:30 — open (device 22:30 says shut)
 *
 * Every "closed now" assertion is therefore a statement about the SALON's
 * clock that the device's clock would get wrong.
 */

import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Language, ShopOrder } from '@avo/types';
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
vi.mock('../api/orderPayments', () => ({ createOrderPayment: vi.fn(), getOrderPayment: vi.fn() }));
vi.mock('../api/addresses', () => ({
  listAddresses: vi.fn(async () => []),
  createAddress: vi.fn(),
  updateAddress: vi.fn(),
  removeAddress: vi.fn(),
}));
vi.mock('../api/topups', () => ({ createTopUp: vi.fn(), getTopUp: vi.fn() }));
vi.mock('../platform/gateway', () => ({ openGateway: vi.fn() }));

/* eslint-disable import/first */
import { ShopScreen } from './ShopScreen';
import { useShop } from '../state/useShop';
import { LanguageProvider } from '../i18n/language';
import { OrdersSheet } from '../components/OrdersSheet';
import type { OrdersController } from '../state/useOrders';
import type { PickupBranchOption } from '../domain/fulfilment';
import type { BusinessHours } from '../domain/pickupHours';
import { hasWesternDigits } from '../i18n/digits';
import { en } from '../copy/en';
import { ar } from '../copy/ar';

// ------------------------------------------------------------------ the clock --

const originalTZ = process.env.TZ;
beforeAll(() => {
  process.env.TZ = 'Asia/Karachi';
});
afterAll(() => {
  if (originalTZ === undefined) delete process.env.TZ;
  else process.env.TZ = originalTZ;
});

const AFTER_HOURS = new Date('2026-09-28T18:30:00Z');
const OPEN_EVENING = new Date('2026-09-28T17:30:00Z');

function clockAt(instant: Date) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(instant);
}

// ------------------------------------------------------------------ fixtures --

const SPLIT: BusinessHours = { morning: ['10:00', '13:00'], evening: ['16:00', '21:00'] };
/** Open straight through — the zero-length evening is "no second sitting". */
const STRAIGHT: BusinessHours = { morning: ['10:00', '21:00'], evening: ['21:00', '21:00'] };

const KWC: PickupBranchOption = { id: 'BR-KWC', name: 'Kuwait City', nameAr: 'مدينة الكويت', businessHours: SPLIT };
const SAL: PickupBranchOption = { id: 'BR-SAL', name: 'Salmiya', nameAr: 'السالمية', businessHours: STRAIGHT };

const PRODUCTS: Product[] = [
  { id: 'PR-01', salonId: 'SAL-AMARA', name: 'Argan hair oil 100ml', priceFils: 8500, image: null },
];
const BALANCE = 25350;

const SPLIT_EN = 'Collect during working hours, 10 am – 1 pm and 4 pm – 9 pm';
const SPLIT_AR = 'استلمي خلال ساعات العمل، ١٠ ص – ١ م و٤ م – ٩ م';
const TOMORROW_EN = 'Closed now — collect tomorrow from 10 am';
const TOMORROW_AR = 'مغلق الآن — استلمي غداً من ١٠ ص';

/** `POST /orders` 201 — `pickupBranch` as a given migration served it. */
function orderResult(pickupBranch: unknown) {
  return {
    transaction: {
      id: 'TX-7601442',
      memberId: '8842',
      branchId: 'BR-KWC',
      kind: 'shop',
      amountFils: -8500,
      bonusFils: 0,
      method: 'wallet',
      status: 'settled',
      reference: 'AVO-SH-7601442',
      createdAt: '2026-09-28T18:20:00.000Z',
      voidedAt: null,
      reversedByTransactionId: null,
    },
    balanceAfterFils: 16850,
    totalFils: 8500,
    items: [{ productId: 'PR-01', name: 'Argan hair oil 100ml', qty: 1, unitPriceFils: 8500, lineTotalFils: 8500 }],
    loyalty: { mode: 'tiers', visits: 7, tier: 'silver', nextTier: 'gold', visitsToNext: 3 },
    pickupBranch,
    voidable: false,
  };
}

function Shell({ branches }: { branches: readonly PickupBranchOption[] }) {
  const shop = useShop(BALANCE, vi.fn(), branches);
  return (
    <ShopScreen
      shop={shop}
      balanceFils={BALANCE}
      memberFetchedAt={Date.now()}
      tier="silver"
      branches={branches as never}
      timezone="Asia/Kuwait"
      onToppedUp={vi.fn()}
      onReport={vi.fn()}
    />
  );
}

async function cartAt(branches: readonly PickupBranchOption[], lang: Language = 'en') {
  render(
    <LanguageProvider initial={lang}>
      <Shell branches={branches} />
    </LanguageProvider>,
  );
  await waitFor(() => expect(screen.getByTestId('shop-row-PR-01')).toBeTruthy());
  act(() => screen.getByTestId('shop-add-PR-01').click());
  act(() => screen.getByTestId('shop-cart-button').click());
}

const tap = (id: string) => act(() => screen.getByTestId(id).click());
async function tapAsync(id: string) {
  await act(async () => {
    screen.getByTestId(id).click();
  });
}
const textOf = (id: string) => screen.getByTestId(id).textContent;

beforeEach(() => {
  vi.clearAllMocks();
  getProducts.mockResolvedValue(PRODUCTS);
  getMyOrders.mockResolvedValue({ items: [], truncated: false, nextCursor: null });
  placeOrder.mockResolvedValue(orderResult(null));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// ══════════════════════════════════════════════════════════ the picker ══

describe('the pickup picker names each branch’s hours', () => {
  it('EN — two windows on one row, ONE range on the straight-through row, and closed now', async () => {
    clockAt(AFTER_HOURS);
    await cartAt([KWC, SAL]);
    expect(textOf('pickup-branch-BR-KWC-hours-hours')).toBe(SPLIT_EN);
    expect(textOf('pickup-branch-BR-KWC-hours-closed')).toBe(TOMORROW_EN);
    // The zero-length evening is not a window: one range, no " and ".
    expect(textOf('pickup-branch-BR-SAL-hours-hours')).toBe('Collect during working hours, 10 am – 9 pm');
    // And a screen reader hears what is drawn, not just the name.
    expect(screen.getByTestId('pickup-branch-BR-KWC').getAttribute('aria-label')).toBe(
      `Kuwait City · ${SPLIT_EN} · ${TOMORROW_EN}`,
    );
  });

  it('AR — Eastern digits and ص/م, the same sentences, mirrored', async () => {
    clockAt(AFTER_HOURS);
    await cartAt([KWC, SAL], 'ar');
    expect(document.documentElement.dir).toBe('rtl');
    expect(textOf('pickup-branch-BR-KWC-hours-hours')).toBe(SPLIT_AR);
    expect(textOf('pickup-branch-BR-KWC-hours-closed')).toBe(TOMORROW_AR);
    expect(textOf('pickup-branch-BR-SAL-hours-hours')).toBe('استلمي خلال ساعات العمل، ١٠ ص – ٩ م');
    expect(hasWesternDigits(textOf('fulfil-pickup-branches') ?? '')).toBe(false);
  });

  it('"closed now" is the SALON’s clock: 20:30 in Kuwait is open, though the device says 22:30', async () => {
    clockAt(OPEN_EVENING);
    expect(new Date().getHours()).toBe(22); // the device really does think it is late
    await cartAt([KWC, SAL]);
    expect(textOf('pickup-branch-BR-KWC-hours-hours')).toBe(SPLIT_EN);
    expect(screen.queryByTestId('pickup-branch-BR-KWC-hours-closed')).toBeNull();
  });

  it('the single-branch tile carries its one branch’s hours', async () => {
    clockAt(AFTER_HOURS);
    await cartAt([KWC]);
    expect(screen.queryByTestId('fulfil-pickup-branches')).toBeNull();
    expect(textOf('fulfil-pickup-hours-hours')).toBe(SPLIT_EN);
    expect(textOf('fulfil-pickup-hours-closed')).toBe(TOMORROW_EN);
    expect(screen.getByTestId('fulfil-pickup').getAttribute('aria-label')).toContain(TOMORROW_EN);
  });
});

// ════════════════════════════════════════════════════════ not blocking ══

describe('display only — after hours she can still order', () => {
  it('single branch, closed now: Pay is live and the order goes, byte-identical', async () => {
    clockAt(AFTER_HOURS);
    await cartAt([KWC]);
    expect(textOf('fulfil-pickup-hours-closed')).toBe(TOMORROW_EN);
    expect(screen.getByTestId('cart-pay').getAttribute('aria-disabled')).not.toBe('true');
    await tapAsync('cart-pay');
    expect(placeOrder).toHaveBeenCalledTimes(1);
    expect(placeOrder.mock.calls[0]![2]).toEqual({});
  });

  it('several branches, closed now: choosing one is all Pay waits for', async () => {
    clockAt(AFTER_HOURS);
    await cartAt([KWC, SAL]);
    tap('pickup-branch-BR-KWC');
    expect(screen.queryByTestId('cart-no-pickup-branch')).toBeNull();
    await tapAsync('cart-pay');
    expect(placeOrder).toHaveBeenCalledTimes(1);
    expect(placeOrder.mock.calls[0]![2]).toEqual({ pickupBranchId: 'BR-KWC' });
  });
});

// ═════════════════════════════════════════════════════════ the invoice ══

describe('the invoice says when to collect, from the response', () => {
  it.each([
    ['en', SPLIT_EN, TOMORROW_EN],
    ['ar', SPLIT_AR, TOMORROW_AR],
  ] as const)('%s — the hours and closed now, in the zone the ORDER names', async (lang, hours, closed) => {
    clockAt(AFTER_HOURS);
    placeOrder.mockResolvedValueOnce(
      orderResult({ ...KWC, closed: false, businessHoursSource: 'salon', timezone: 'Asia/Kuwait' }),
    );
    await cartAt([KWC], lang);
    await tapAsync('cart-pay');
    await waitFor(() => expect(screen.getByTestId('tx-sheet')).toBeTruthy());
    expect(textOf('tx-pickup-hours-hours')).toBe(hours);
    expect(textOf('tx-pickup-hours-closed')).toBe(closed);
  });

  it('a result stored before 0063 (no hours, no zone) still names the branch and draws no hours', async () => {
    clockAt(AFTER_HOURS);
    placeOrder.mockResolvedValueOnce(
      orderResult({ id: 'BR-KWC', name: 'Kuwait City', nameAr: 'مدينة الكويت', closed: false }),
    );
    await cartAt([KWC]);
    await tapAsync('cart-pay');
    await waitFor(() => expect(screen.getByTestId('tx-sheet')).toBeTruthy());
    expect(textOf('tx-rows')).toContain(`${en.pickupFrom}Kuwait City`);
    expect(screen.queryByTestId('tx-pickup-hours')).toBeNull();
  });
});

// ═════════════════════════════════════════════════════ her orders list ══

function order(over: Partial<ShopOrder> = {}): ShopOrder {
  return {
    transactionId: 'TX-1',
    fulfilment: 'pickup',
    status: 'ready',
    address: null,
    pickupBranch: {
      id: 'BR-KWC',
      name: 'Kuwait City',
      nameAr: 'مدينة الكويت',
      closed: false,
      businessHours: SPLIT,
      businessHoursSource: 'salon',
      timezone: 'Asia/Kuwait',
    },
    createdAt: '2026-09-28T09:00:00.000Z',
    readyAt: null,
    closedAt: null,
    ...over,
  };
}

function sheet(list: ShopOrder[], lang: Language = 'en') {
  const controller: OrdersController = {
    status: 'ready',
    orders: list,
    truncated: false,
    failure: null,
    fetchedAt: 1_757_500_000_000,
    retry: vi.fn(),
  };
  return render(
    <LanguageProvider initial={lang}>
      <OrdersSheet open orders={controller} onClose={vi.fn()} />
    </LanguageProvider>,
  );
}

describe('her order says when to collect it', () => {
  it.each([
    ['en', SPLIT_EN, TOMORROW_EN],
    ['ar', SPLIT_AR, TOMORROW_AR],
  ] as const)('%s — a ready pickup, after hours', (lang, hours, closed) => {
    clockAt(AFTER_HOURS);
    sheet([order()], lang);
    expect(textOf('order-pickup-hours-TX-1-hours')).toBe(hours);
    expect(textOf('order-pickup-hours-TX-1-closed')).toBe(closed);
  });

  it('decided in the order’s zone: 20:30 Kuwait is open on a Karachi phone', () => {
    clockAt(OPEN_EVENING);
    sheet([order()]);
    expect(textOf('order-pickup-hours-TX-1-hours')).toBe(SPLIT_EN);
    expect(screen.queryByTestId('order-pickup-hours-TX-1-closed')).toBeNull();
  });

  it('a collected order, and a branch that closed, carry no hours', () => {
    clockAt(AFTER_HOURS);
    sheet([
      order({ transactionId: 'TX-1', status: 'closed' }),
      order({
        transactionId: 'TX-2',
        pickupBranch: { ...order().pickupBranch!, closed: true },
      }),
    ]);
    expect(screen.queryByTestId('order-pickup-hours-TX-1')).toBeNull();
    expect(screen.queryByTestId('order-pickup-hours-TX-2')).toBeNull();
  });
});
