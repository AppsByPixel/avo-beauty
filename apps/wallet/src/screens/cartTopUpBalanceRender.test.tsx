// @vitest-environment jsdom

/**
 * "NEW BALANCE" ON THE CART'S TOP-UP — the row that never resolved.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE DEFECT THIS FILE PINS WAS FOUND BY DRIVING THE APP, NOT BY A TEST.
 *
 * Shop tab → add items → cart → "Top up to continue" → Choose payment → Pay.
 * The success sheet showed the amount, showed KNET, and showed a grey skeleton
 * bar where "New balance" goes — still a bar a minute later, on a screen whose
 * whole purpose is to tell her the money arrived.
 *
 * `TopUpSheet` was right: a `null` balance renders a bar, because a number that
 * has not been re-read since the payment is the balance from BEFORE it.
 * `ShopScreen` passed a HARD-CODED `null`, under a comment claiming the sheet
 * re-read the member itself. It does not. Nothing on the screen was ever going
 * to fill that row.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY IT HAS TO BE A RENDER, AND THE WHOLE FLOW AT THAT.
 *
 * The predicate is three comparisons and could be unit-tested in a line — and a
 * unit test of it would have been just as green BEFORE this slice, because the
 * bug was never in the comparison. It was in the CALL: a literal where the
 * derivation should have been. That is DECISIONS #38's shape exactly, and the
 * only assertion that catches it runs the real `useTopUp` through the real
 * `ShopScreen` and reads the row.
 *
 * So `createTopUp` / `getTopUp` and the gateway handoff are mocked — the wire
 * and the browser, nothing else. The state machine, the cart, the sheet and the
 * screen's own wiring are the shipped ones.
 *
 * EVERY TEST BELOW FAILS AGAINST THE PRE-SLICE SCREEN. The first three go red on
 * a bar that never becomes a number; the last two are the guard that stops the
 * "fix" everyone reaches for first — adding `creditFils` to the balance in
 * props, which is non-negotiable #2 in one line of arithmetic.
 * ═════════════════════════════════════════════════════════════════════════════
 */

import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Product } from '../api/shop';

/**
 * `react-native-svg` IS STUBBED, AND IT IS THE ONLY STUB OF A COMPONENT HERE —
 * the same one `shopInvoiceRender.test.tsx` carries and for the identical
 * reason: `ShopScreen` imports it for the cart glyph, the chain reaches
 * untranspiled Flow in React Native's source, and without this the file does not
 * COLLECT. It costs the cart icon, which nothing below looks at.
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

const { createTopUp, getTopUp } = vi.hoisted(() => ({
  createTopUp: vi.fn(),
  getTopUp: vi.fn(),
}));
vi.mock('../api/topups', () => ({ createTopUp, getTopUp }));

/**
 * THE HANDOFF, NOT THE OUTCOME. `openGateway` only ever answers "the page
 * opened" plus a hint that she is back; the status still comes from
 * `GET /topups/{id}` below. `returned` is resolved so the poll's first race
 * settles at once and the suite needs no timer control — which is faithful, not
 * a shortcut: a customer who pays fast is exactly this.
 */
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
import { en } from '../copy/en';

const PRODUCTS: Product[] = [
  { id: 'PR-01', salonId: 'SAL-AMARA', name: 'Repair serum', priceFils: 9500, image: null },
];

/** 5.000 KD in the wallet against a 9.500 KD cart — short, so the CTA is Top up. */
const BALANCE_BEFORE = 5000;

/**
 * A real `POST /topups` 200 for the 10.000 tile `topUpAmountForShortfall` picks:
 * Silver +10%, so 11.000 lands. Ten keys — `feeFils` is customer-never.
 */
const INTENT = {
  id: 'TI-WQJTHJ',
  memberId: '8842',
  amountFils: 10000,
  bonusFils: 1000,
  creditFils: 11000,
  method: 'knet',
  status: 'redirected',
  failureReason: null,
  redirectUrl: 'http://localhost:4180/_gateway/SBX-2B3901429B33',
  reference: 'AVO-TOP-WQJTHJ',
} as const;

const SETTLED = { ...INTENT, status: 'succeeded' } as const;

/**
 * THE SERVER'S BALANCE AFTER, AND IT IS DELIBERATELY NOT THE SUM.
 *
 * 5.000 + 11.000 = 16.000, and the server says 21.000 — a stamp reward, a
 * refund, a second device, any of the reasons #2 gives for never doing that
 * addition. Every assertion below that reads 21.000 also refuses 16.000, so a
 * screen that "fixed" the bar by computing it goes red rather than green.
 */
const BALANCE_AFTER = 21000;
const LOCAL_SUM = BALANCE_BEFORE + INTENT.creditFils;

const onReport = vi.fn();

interface HarnessHandle {
  /** What a member re-read landing NOW would do to the screen's props. */
  reread: (balanceFils: number, fetchedAt: number) => void;
  /** How many times the screen asked the shell to re-read. */
  rereads: () => number;
}

let handle: HarnessHandle;

/**
 * The shell, as App.tsx composes it: one member read owned above, its balance
 * AND the moment it landed handed down, and `onToppedUp` wired to the re-read.
 * Nothing here computes a balance; the test plays the part of the read landing.
 */
function Shell({ initialFetchedAt }: { initialFetchedAt: number | null }) {
  const [member, setMember] = useState({
    balanceFils: BALANCE_BEFORE,
    fetchedAt: initialFetchedAt,
  });
  const [rereads, setRereads] = useState(0);
  const shop = useShop(member.balanceFils, () => setRereads((n) => n + 1));

  handle = {
    reread: (balanceFils, fetchedAt) => setMember({ balanceFils, fetchedAt }),
    rereads: () => rereads,
  };

  return (
    <ShopScreen
      shop={shop}
      balanceFils={member.balanceFils}
      memberFetchedAt={member.fetchedAt}
      tier="silver"
      branches={[] as never}
      onToppedUp={() => setRereads((n) => n + 1)}
      onReport={onReport}
    />
  );
}

/** Add the product, open the cart, tap Top up, choose nothing, Pay, settle. */
async function topUpFromCart(initialFetchedAt: number | null) {
  render(
    <LanguageProvider initial="en">
      <Shell initialFetchedAt={initialFetchedAt} />
    </LanguageProvider>,
  );
  await waitFor(() => expect(screen.getByTestId('shop-row-PR-01')).toBeTruthy());
  act(() => screen.getByTestId('shop-add-PR-01').click());
  act(() => screen.getByTestId('shop-cart-button').click());

  // "Top up to continue" — the CTA the cart shows when she cannot afford it.
  await act(async () => {
    screen.getByTestId('cart-topup').click();
  });
  await waitFor(() => expect(screen.getByTestId('topup-pay')).toBeTruthy());

  await act(async () => {
    screen.getByTestId('topup-pay').click();
  });
  // The authoritative read said `succeeded`, so this is the success screen.
  await waitFor(() => expect(screen.getByTestId('topup-result-success')).toBeTruthy());
}

const balanceRow = () => screen.getByTestId('topup-new-balance');
const stillABar = () => screen.queryByTestId('topup-new-balance-skeleton');

beforeEach(() => {
  vi.clearAllMocks();
  getProducts.mockResolvedValue(PRODUCTS);
  getMyOrders.mockResolvedValue({ items: [], truncated: false, nextCursor: null });
  listAddresses.mockResolvedValue([]);
  placeOrder.mockResolvedValue({});
  createTopUp.mockResolvedValue(INTENT);
  getTopUp.mockResolvedValue(SETTLED);
});
afterEach(cleanup);

describe('the success sheet the cart opens', () => {
  /**
   * THE DEFECT, DIRECTLY. Before this slice the row was a bar here forever.
   */
  it('resolves "New balance" once a member read lands after the payment', async () => {
    await topUpFromCart(Date.now() - 60_000);
    // Still a bar at the instant of success: nothing has been re-read yet.
    expect(stillABar()).not.toBeNull();

    // The shell's re-read lands. This is the only thing that may fill the row.
    act(() => handle.reread(BALANCE_AFTER, Date.now()));

    expect(stillABar()).toBeNull();
    expect(balanceRow().textContent ?? '').toContain(en.rBalance);
    expect(balanceRow().textContent ?? '').toContain('21.000 KD');
  });

  /**
   * THE ARIA LABEL, NOT JUST THE GLYPH. A money row read out as "twenty-one
   * point zero zero zero" is the one fact on this screen lost to a screen
   * reader, and three of this lane's mutations have gone red on the
   * announcement alone.
   */
  it('announces that balance as dinars', async () => {
    await topUpFromCart(Date.now() - 60_000);
    act(() => handle.reread(BALANCE_AFTER, Date.now()));

    const spoken = balanceRow().querySelector('[aria-label]')?.getAttribute('aria-label');
    expect(spoken).toBe('21.000 Kuwaiti dinars');
  });

  /**
   * AND IT ASKED FOR THAT READ ITSELF. The row cannot resolve on a screen that
   * never told the shell to re-read, and this is the half that was already
   * working — kept so a regression in either half is distinguishable.
   */
  it('asks the shell to re-read the member on success', async () => {
    await topUpFromCart(Date.now() - 60_000);
    expect(handle.rereads()).toBeGreaterThan(0);
  });
});

describe('and it stays a bar until that read is genuinely newer', () => {
  /**
   * NOTHING HAS LANDED. The screen is holding a balance — it renders it on the
   * cart's CTA — and it still may not label it "New balance", because that
   * figure is from before she paid.
   */
  it('shows the bar when no member read has landed at all', async () => {
    await topUpFromCart(null);
    expect(stillABar()).not.toBeNull();
    expect(balanceRow().textContent ?? '').not.toContain('5.000');
  });

  /**
   * THE CASE THAT GUARDS #2, AND THE REASON THE TIMESTAMP IS A PROP.
   *
   * A read DID land — `useWalletHome` serves the cached snapshot with the
   * cache's own `fetchedAt` while a refresh is in flight, so this is the
   * ordinary state of the app a second after a payment, not a contrivance. Its
   * balance is stale by definition, and printing it would tell her a top-up she
   * just made did nothing.
   */
  it('shows the bar for a read whose fetchedAt PRE-DATES the success', async () => {
    const before = Date.now() - 60_000;
    await topUpFromCart(before);

    // A read lands — with a timestamp older than the payment, and a balance
    // that is not the post-payment one either.
    act(() => handle.reread(BALANCE_BEFORE, before + 1_000));

    expect(stillABar()).not.toBeNull();
    expect(balanceRow().textContent ?? '').not.toContain('5.000');
  });

  /**
   * STATED AS A CONTRAST, because an assertion that cannot go red is not
   * evidence and this repository has been bitten by exactly that shape. Same
   * payment, same screen, two reads: the stale one leaves the bar, the fresh one
   * fills the row. Nothing that hard-codes either answer satisfies both halves —
   * and the number that appears is the server's 21.000, never the 16.000 that
   * adding `creditFils` to the balance in props would have produced.
   */
  it('goes bar → number on the read, and never prints the local sum', async () => {
    const before = Date.now() - 60_000;
    await topUpFromCart(before);

    act(() => handle.reread(BALANCE_BEFORE, before + 1_000));
    expect(stillABar()).not.toBeNull();

    act(() => handle.reread(BALANCE_AFTER, Date.now()));
    expect(stillABar()).toBeNull();

    const shown = balanceRow().textContent ?? '';
    expect(shown).toContain('21.000 KD');
    expect(LOCAL_SUM).not.toBe(BALANCE_AFTER);
    expect(shown).not.toContain('16.000');
  });
});
