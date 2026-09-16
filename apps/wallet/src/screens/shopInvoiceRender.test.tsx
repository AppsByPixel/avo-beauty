// @vitest-environment jsdom

/**
 * THE INVOICE, DRIVEN THROUGH THE SCREEN SHE PAYS ON.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT ONLY A RENDER CAN ASSERT HERE.
 *
 * `receiptInvoice.test.ts` proves the builder and `receiptEmailParity.test.ts`
 * proves it agrees with the email. Neither can reach the two questions this file
 * owns, and both are the shape of DECISIONS #38 — the rule tested, the call to
 * it not:
 *
 *   1. THAT THE SCREEN OPENS IT AT ALL, with the SERVER'S response and not with
 *      the cart's own sum. `checkout` could resolve, the cart could close, and
 *      nothing could appear — which is exactly what this slice replaced.
 *
 *   2. THAT THE TOAST IS GONE. A toast fired alongside would paint over the
 *      invoice (`Toast` zIndex 40, `Sheet` 30), and nothing about the
 *      arithmetic would look wrong. Only a render can see one covering the
 *      other, and only a spy can see that it never fires.
 *
 * The real `useShop` is used, with `placeOrder` mocked — so the idempotency key,
 * the cart clear and the `onPaid` re-read are the shipped ones, and the invoice
 * is fed by the same path production uses.
 * ═════════════════════════════════════════════════════════════════════════════
 */

import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Product } from '../api/shop';

/**
 * `react-native-svg` IS STUBBED, AND IT IS THE ONLY STUB HERE.
 *
 * `vitest.config.ts` and `MembershipSection` both record that anything importing
 * it cannot be loaded in this workspace: the chain reaches untranspiled Flow in
 * React Native's own source. `ShopScreen` imports it for the cart glyph, so
 * without this the file does not COLLECT — measured, `SyntaxError: Unexpected
 * token 'typeof'`, zero tests run.
 *
 * What it costs is exactly the cart icon, which nothing below asserts on. The
 * invoice itself draws no SVG — `TransactionSheet` is text, rows and a tinted
 * pill — so no assertion in this file is standing on the stub. Named rather than
 * buried: a mock that removed something a test then claimed to prove would be
 * the green bought with a cast this repository keeps warning about.
 */
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

const { listAddresses } = vi.hoisted(() => ({ listAddresses: vi.fn() }));
vi.mock('../api/addresses', () => ({
  listAddresses,
  createAddress: vi.fn(),
  updateAddress: vi.fn(),
  removeAddress: vi.fn(),
}));
vi.mock('../api/topups', () => ({ createTopUp: vi.fn(), getTopUp: vi.fn() }));

/* eslint-disable import/first */
import { ShopScreen } from './ShopScreen';
import { useShop } from '../state/useShop';
import { LanguageProvider } from '../i18n/language';
import { en } from '../copy/en';
import { ar } from '../copy/ar';

const PRODUCTS: Product[] = [
  { id: 'PR-01', salonId: 'SAL-AMARA', name: 'Repair serum', priceFils: 9500, image: null },
  { id: 'PR-02', salonId: 'SAL-AMARA', name: 'Silk scrunchie', priceFils: 2500, image: null },
];

/**
 * The response `services/order.ts` returns: the transaction row NEGATIVE
 * (`:445`), the payload's own `items` and `balanceAfterFils` (`:690-692`).
 */
const ORDER = {
  transaction: {
    id: 'TX-7601442',
    memberId: '8842',
    branchId: 'BR-KWC',
    kind: 'shop',
    amountFils: -14500,
    bonusFils: 0,
    method: 'wallet',
    status: 'settled',
    reference: 'AVO-SH-7601442',
    createdAt: '2026-09-06T13:20:00.000Z',
    voidedAt: null,
    reversedByTransactionId: null,
  },
  balanceAfterFils: 48500,
  totalFils: 14500,
  items: [
    { productId: 'PR-01', name: 'Repair serum', qty: 1, unitPriceFils: 9500, lineTotalFils: 9500 },
    { productId: 'PR-02', name: 'Silk scrunchie', qty: 2, unitPriceFils: 2500, lineTotalFils: 5000 },
  ],
  loyalty: { mode: 'tiers', visits: 7, tier: 'silver', nextTier: 'gold', visitsToNext: 3 },
  voidable: false,
};

const BRANCHES = [{ id: 'BR-KWC', name: 'Kuwait City', nameAr: 'مدينة الكويت' }];

const onToppedUp = vi.fn();
const onReport = vi.fn();

/** The shell, exactly as App.tsx composes it: `useShop` above, screen below. */
function Harness({ lang = 'en' as 'en' | 'ar' }) {
  return (
    <LanguageProvider initial={lang}>
      <Screen />
    </LanguageProvider>
  );
}

function Screen() {
  const shop = useShop(60000, onToppedUp);
  return (
    <ShopScreen
      shop={shop}
      balanceFils={60000}
      tier="silver"
      branches={BRANCHES as never}
      onToppedUp={onToppedUp}
      onReport={onReport}
    />
  );
}

async function payFor(lang: 'en' | 'ar' = 'en') {
  render(<Harness lang={lang} />);
  await waitFor(() => expect(screen.getByTestId('shop-row-PR-01')).toBeTruthy());
  // Two of one and one of the other, so a quantity of 1 and of 2 are both on it.
  act(() => screen.getByTestId('shop-add-PR-01').click());
  act(() => screen.getByTestId('shop-add-PR-02').click());
  act(() => screen.getByTestId('shop-inc-PR-02').click());
  act(() => screen.getByTestId('shop-cart-button').click());
  await act(async () => {
    screen.getByTestId('cart-pay').click();
  });
  await waitFor(() => expect(screen.getByTestId('tx-sheet')).toBeTruthy());
}

beforeEach(() => {
  vi.clearAllMocks();
  getProducts.mockResolvedValue(PRODUCTS);
  getMyOrders.mockResolvedValue({ items: [], truncated: false, nextCursor: null });
  listAddresses.mockResolvedValue([]);
  placeOrder.mockResolvedValue(ORDER);
});
afterEach(cleanup);

describe('after she pays, the invoice appears', () => {
  it('opens the receipt sheet with the lines the server priced', async () => {
    await payFor();
    const rows = screen.getByTestId('tx-rows').textContent ?? '';
    expect(rows).toContain('Repair serum × 1');
    expect(rows).toContain('9.500 KD');
    expect(rows).toContain('Silk scrunchie × 2');
    expect(rows).toContain('5.000 KD');
  });

  /**
   * NON-NEGOTIABLE #2 ON SCREEN. 60.000 was her balance, 14.500 was the order,
   * and 48.500 is neither of those minus the other — it is the server's own
   * figure, which is exactly why it is rendered instead of subtracted. A client
   * that computed it would have shown 45.500 here and been wrong about a number
   * a customer checks.
   */
  it('shows the server’s balance after, which local arithmetic would get wrong', async () => {
    await payFor();
    const rows = screen.getByTestId('tx-rows').textContent ?? '';
    expect(rows).toContain(en.txBalanceAfter);
    expect(rows).toContain('48.500 KD');
    expect(60000 - ORDER.totalFils).not.toBe(ORDER.balanceAfterFils);
    expect(rows).not.toContain('45.500');
  });

  /** The reference support traces by, on the document, at the moment of payment. */
  it('carries the reference and the report affordance', async () => {
    await payFor();
    expect(screen.getByTestId('tx-reference').textContent).toBe('AVO-SH-7601442');
    expect(screen.getByTestId('tx-report')).toBeTruthy();
  });

  /**
   * THE TOAST IS GONE, NOT MERELY UNTIDY. It sits at zIndex 40 over the sheet's
   * 30, so one fired here would be painted across the rows above.
   */
  it('fires no toast over it', async () => {
    await payFor();
    expect(screen.queryByTestId('toast')).toBeNull();
    // And the string itself is nowhere on screen — a toast rendered by some
    // other route would still be caught.
    expect(document.body.textContent ?? '').not.toContain('visit added');
  });

  /** interaction-spec.md §4: nothing is in flight, so it dismisses. */
  it('is dismissible, and dismissing leaves the shop with an empty cart', async () => {
    await payFor();
    act(() => screen.getByTestId('tx-close').click());
    expect(screen.queryByTestId('tx-sheet')).toBeNull();
    expect(screen.queryByTestId('shop-cart-badge')).toBeNull();
  });

  /**
   * #12. The quantity is Eastern because it is a count; the money beside it is
   * Western because it is money (design:1587 writes exactly this mix).
   */
  it('renders in Arabic with Eastern quantities and Western money', async () => {
    await payFor('ar');
    const rows = screen.getByTestId('tx-rows').textContent ?? '';
    expect(rows).toContain('Repair serum × ١');
    expect(rows).toContain('Silk scrunchie × ٢');
    expect(rows).toContain(ar.txBalanceAfter);
    expect(rows).toContain('48.500 د.ك');
    expect(rows).not.toContain('٤٨.٥٠٠');
  });

  /**
   * THE ARIA LABEL, NOT JUST THE GLYPH. Three of this lane's mutations have gone
   * red on the announcement alone, and a money row read as "nine point five
   * hundred" is the whole document's value lost to a screen reader.
   */
  it('announces every money row as dinars', async () => {
    await payFor();
    const spoken = Array.from(screen.getByTestId('tx-rows').querySelectorAll('[aria-label]'))
      .map((n) => n.getAttribute('aria-label'));
    expect(spoken).toContain('9.500 Kuwaiti dinars');
    expect(spoken).toContain('5.000 Kuwaiti dinars');
    expect(spoken).toContain('48.500 Kuwaiti dinars');
  });

  /**
   * THE OFFLINE STATE FOR THIS DOCUMENT IS "NOTHING HAPPENS", and it is a
   * property of where the figures came from rather than a banner. Every number
   * on the invoice arrived with the order, so a network that dies while she is
   * reading it has nothing to fail: no refetch, no blanked rows.
   *
   * Driven by making every remaining API call reject the way `client.ts` reports
   * a dead connection, then re-reading the sheet.
   */
  it('survives the connection dying while it is open', async () => {
    await payFor();
    getProducts.mockRejectedValue(new TypeError('Network request failed'));
    getMyOrders.mockRejectedValue(new TypeError('Network request failed'));
    listAddresses.mockRejectedValue(new TypeError('Network request failed'));
    await act(async () => {
      await Promise.resolve();
    });
    const rows = screen.getByTestId('tx-rows').textContent ?? '';
    expect(rows).toContain('Repair serum × 1');
    expect(rows).toContain('48.500 KD');
    expect(screen.getByTestId('tx-reference').textContent).toBe('AVO-SH-7601442');
  });
});

describe('a refused order gets no invoice', () => {
  /**
   * The document is a record of something that happened. `checkout` resolves
   * null on every refusal, and the sheet must stay shut — an invoice over a
   * failed payment is the worst possible reading of it, and the cart must
   * survive for her to retry.
   */
  it('leaves the sheet closed and the cart intact', async () => {
    placeOrder.mockRejectedValue(new TypeError('Network request failed'));
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId('shop-row-PR-01')).toBeTruthy());
    act(() => screen.getByTestId('shop-add-PR-01').click());
    act(() => screen.getByTestId('shop-cart-button').click());
    await act(async () => {
      screen.getByTestId('cart-pay').click();
    });
    expect(screen.queryByTestId('tx-sheet')).toBeNull();
    expect(screen.getByTestId('shop-cart-badge')).toBeTruthy();
  });
});
