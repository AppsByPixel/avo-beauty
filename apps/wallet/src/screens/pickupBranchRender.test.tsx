// @vitest-environment jsdom

/**
 * W7 — "Collect it is good, but from which branch if they have multiple".
 * Rendered through the real `ShopScreen`, `useShop`, `useCardCheckout`,
 * `CartSheet` and `FulfilmentSection`; only the wire and the browser are mocked.
 *
 * THE REFUSAL BODIES ARE THE API'S. Each `message` below is the server's own
 * English sentence from `resolvePickupBranch` (api/src/services/order.ts,
 * migration 0060), kept verbatim so a screen that rendered it is caught — in
 * Arabic above all, where it would be English inside a mirrored layout.
 *
 * What is pinned, numbered as the brief numbers it:
 *   1. multi-branch: the picker, NOTHING PRESELECTED, Pay held; the chosen id
 *      goes out as `pickupBranchId` on BOTH `POST /orders` and
 *      `POST /orders/payments`, and never as `branchId`;
 *   2. single-branch: no picker, nothing sent, the tile names the branch;
 *   3. delivery sends no `pickupBranchId` on either rail;
 *   4. each refusal code renders its own sentence from the code, EN and AR, and
 *      `pickup_branch_closed` keeps the basket — on either rail;
 *   5. a branch change under a held key reuses the key, on either rail;
 *   6. the invoice's "Collect from" row, from the response, EN and AR;
 *   7. the picker in Arabic.
 * The orders list and the bell row (6) are in `pickupBranchOrdersRender.test.tsx`
 * and `domain/bell.test.ts`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Language, MemberAddress } from '@avo/types';
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

const { listAddresses } = vi.hoisted(() => ({ listAddresses: vi.fn() }));
vi.mock('../api/addresses', () => ({
  listAddresses,
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
import { ApiError } from '../api/client';
import type { PickupBranchOption } from '../domain/fulfilment';
import { en } from '../copy/en';
import { ar } from '../copy/ar';

// ------------------------------------------------------------------ fixtures --

/** As `GET /salons/SAL-AMARA` serves them (seed: both carry `name_ar`). */
/** W8 — every branch now serves its resolved hours; the seed's split day. */
const HOURS = { morning: ['10:00', '13:00'], evening: ['16:00', '21:00'] } as PickupBranchOption['businessHours'];
const KWC: PickupBranchOption = { id: 'BR-KWC', name: 'Kuwait City', nameAr: 'مدينة الكويت', businessHours: HOURS };
const SAL: PickupBranchOption = { id: 'BR-SAL', name: 'Salmiya', nameAr: 'السالمية', businessHours: HOURS };
const TWO = [KWC, SAL];
const ONE = [KWC];

const PRODUCTS: Product[] = [
  { id: 'PR-01', salonId: 'SAL-AMARA', name: 'Argan hair oil 100ml', priceFils: 8500, image: null },
];
const BALANCE = 25350;

const ADDRESS: MemberAddress = {
  id: 'ADR-1',
  label: 'Home',
  block: '4',
  street: 'Salem Al Mubarak',
  building: '12',
  floor: null,
  apartment: null,
  area: null,
  governorate: null,
  instructions: null,
  latitude: null,
  longitude: null,
  createdAt: '2026-09-10T09:00:00.000Z',
};

const INTENT = {
  id: 'TI-10000001',
  memberId: '8842',
  amountFils: 8500,
  bonusFils: 0,
  creditFils: 8500,
  method: 'knet',
  status: 'redirected',
  failureReason: null,
  redirectUrl: 'http://localhost:4217/_gateway/SBX-1?return=avo%3A%2F%2Ftopup%2Freturn',
  reference: 'AVO-TOP-10000001',
} as const;
const OPENED = {
  intent: INTENT,
  order: { status: 'awaiting_payment', transactionId: null, refusal: null, result: null },
} as const;
const DECLINED = {
  intent: { ...INTENT, status: 'failed', failureReason: 'declined' },
  order: { status: 'not_paid', transactionId: null, refusal: null, result: null },
} as const;

/** `POST /orders` 201, as services/order.ts builds it — with 0060's field. */
function orderResult(pickupBranch: unknown) {
  return {
    transaction: {
      id: 'TX-7601442',
      memberId: '8842',
      branchId: 'BR-SAL',
      kind: 'shop',
      amountFils: -8500,
      bonusFils: 0,
      method: 'wallet',
      status: 'settled',
      reference: 'AVO-SH-7601442',
      createdAt: '2026-09-28T13:20:00.000Z',
      voidedAt: null,
      reversedByTransactionId: null,
      loyalty: null,
    },
    balanceAfterFils: 16850,
    totalFils: 8500,
    items: [{ productId: 'PR-01', name: 'Argan hair oil 100ml', qty: 1, unitPriceFils: 8500, lineTotalFils: 8500 }],
    loyalty: { mode: 'tiers', visits: 7, tier: 'silver', nextTier: 'gold', visitsToNext: 3 },
    pickupBranch,
    voidable: false,
  };
}

/**
 * The three refusals, with the SERVER'S ENGLISH verbatim — the thing that must
 * never reach the screen. `[code, status, chip testID, copy key, message]`.
 */
const REFUSALS = [
  [
    'pickup_branch_required',
    400,
    'cart-pickup-required',
    'cartPickupRequired',
    'This salon has more than one branch. Choose the branch you will collect your order from.',
  ],
  [
    'unknown_pickup_branch',
    404,
    'cart-pickup-unknown',
    'cartPickupUnknown',
    "That branch isn't one of this salon's. Choose where to collect from the salon's branches.",
  ],
  [
    'pickup_branch_closed',
    409,
    'cart-pickup-closed',
    'cartPickupClosed',
    'That branch has closed and is no longer taking pickups. Choose another branch to collect from.',
  ],
] as const;

function refusal(code: string, status: number, message: string) {
  return new ApiError('server', message, 'WLT-7777-0060', status, code, {});
}

// ------------------------------------------------------------------ harness --

/**
 * A picker row's NAME — its text with the W8 hours block taken out. The row
 * still carries nothing else (no address, no preselection mark); the hours are
 * pinned against a fixed clock in `pickupHoursRender.test.tsx`.
 */
function rowName(testID: string): string {
  const row = screen.getByTestId(testID).textContent ?? '';
  const hours = screen.queryByTestId(`${testID}-hours`)?.textContent ?? '';
  return row.replace(hours, '');
}

let stale = 0;

function Shell({ branches }: { branches: readonly PickupBranchOption[] }) {
  const shop = useShop(BALANCE, vi.fn(), branches, () => {
    stale += 1;
  });
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
  const view = render(
    <LanguageProvider initial={lang}>
      <Shell branches={branches} />
    </LanguageProvider>,
  );
  await waitFor(() => expect(screen.getByTestId('shop-row-PR-01')).toBeTruthy());
  act(() => screen.getByTestId('shop-add-PR-01').click());
  act(() => screen.getByTestId('shop-cart-button').click());
  return view;
}

const tap = (id: string) => act(() => screen.getByTestId(id).click());
async function tapAsync(id: string) {
  await act(async () => {
    screen.getByTestId(id).click();
  });
}
const checked = (id: string) => screen.getByTestId(id).getAttribute('aria-checked');
const disabled = (id: string) => screen.getByTestId(id).getAttribute('aria-disabled') === 'true';
const walletBody = (n = 0) => placeOrder.mock.calls[n]![2] as Record<string, unknown>;
const walletKey = (n = 0) => placeOrder.mock.calls[n]![1] as string;
const cardBody = (n = 0) => createOrderPayment.mock.calls[n]![2] as Record<string, unknown>;
const cardKey = (n = 0) => createOrderPayment.mock.calls[n]![3] as string;

beforeEach(() => {
  vi.clearAllMocks();
  stale = 0;
  getProducts.mockResolvedValue(PRODUCTS);
  getMyOrders.mockResolvedValue({ items: [], truncated: false, nextCursor: null });
  listAddresses.mockResolvedValue([ADDRESS]);
  placeOrder.mockResolvedValue(orderResult(null));
  createOrderPayment.mockResolvedValue(OPENED);
  getOrderPayment.mockResolvedValue(DECLINED);
});
afterEach(cleanup);

// ═══════════════════════════════════════════════════════ 1. multi-branch ══

describe('1. a salon with several open branches', () => {
  it('shows the picker under Collect it, with NOTHING preselected, and holds Pay', async () => {
    await cartAt(TWO);
    expect(screen.getByTestId('fulfil-pickup-branches')).toBeTruthy();
    expect(rowName('pickup-branch-BR-KWC')).toBe('Kuwait City');
    expect(rowName('pickup-branch-BR-SAL')).toBe('Salmiya');
    // No honest default exists, so none is taken — see domain/fulfilment.ts.
    expect(checked('pickup-branch-BR-KWC')).toBe('false');
    expect(checked('pickup-branch-BR-SAL')).toBe('false');
    expect(screen.getByTestId('fulfil-pickup').textContent).toContain(en.fulfilPickupChoose);
    expect(screen.getByTestId('cart-no-pickup-branch').textContent).toBe(en.cartNoPickupBranch);

    expect(disabled('cart-pay')).toBe(true);
    await tapAsync('cart-pay');
    expect(placeOrder).not.toHaveBeenCalled();
  });

  it('sends the chosen branch as `pickupBranchId` on POST /orders — never as `branchId`', async () => {
    await cartAt(TWO);
    tap('pickup-branch-BR-SAL');
    expect(checked('pickup-branch-BR-SAL')).toBe('true');
    expect(screen.getByTestId('fulfil-pickup').textContent).toContain(en.fulfilPickupAt('Salmiya'));
    expect(screen.queryByTestId('cart-no-pickup-branch')).toBeNull();

    await tapAsync('cart-pay');
    expect(placeOrder).toHaveBeenCalledTimes(1);
    expect(walletBody()).toEqual({ pickupBranchId: 'BR-SAL' });
    expect('branchId' in walletBody()).toBe(false);
  });

  it('sends the same `pickupBranchId` on POST /orders/payments, the one-step card rail', async () => {
    await cartAt(TWO);
    tap('pickup-branch-BR-KWC');
    tap('cart-method-knet');
    await tapAsync('cart-pay-card');
    await waitFor(() => expect(createOrderPayment).toHaveBeenCalledTimes(1));
    expect(cardBody()).toEqual({ pickupBranchId: 'BR-KWC' });
    expect('branchId' in cardBody()).toBe(false);
    expect(placeOrder).not.toHaveBeenCalled();
  });

  it('holds the card rail too until a branch is chosen', async () => {
    await cartAt(TWO);
    tap('cart-method-knet');
    expect(disabled('cart-pay-card')).toBe(true);
    await tapAsync('cart-pay-card');
    expect(createOrderPayment).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════ 2. single-branch ══

describe('2. a salon with one open branch', () => {
  it('draws no picker, names the branch on the tile, and sends NOTHING on either rail', async () => {
    await cartAt(ONE);
    expect(screen.queryByTestId('fulfil-pickup-branches')).toBeNull();
    expect(screen.getByTestId('fulfil-pickup').textContent).toContain(en.fulfilPickupAt('Kuwait City'));
    // It names the branch rather than "the salon".
    expect(screen.getByTestId('fulfil-pickup').textContent).not.toContain(en.fulfilPickupBody);
    expect(screen.queryByTestId('cart-no-pickup-branch')).toBeNull();

    await tapAsync('cart-pay');
    // Byte-identical to the body that shipped: no keys at all.
    expect(walletBody()).toEqual({});
  });

  it('sends nothing on the card rail either', async () => {
    await cartAt(ONE);
    tap('cart-method-knet');
    await tapAsync('cart-pay-card');
    await waitFor(() => expect(createOrderPayment).toHaveBeenCalledTimes(1));
    expect(cardBody()).toEqual({});
  });
});

// ════════════════════════════════════════════════════════════ 3. delivery ══

describe('3. a delivery never carries a pickup branch', () => {
  async function chooseBranchThenDeliver() {
    await cartAt(TWO);
    // She chose a branch first — it is KEPT in state, and must not be sent.
    tap('pickup-branch-BR-SAL');
    tap('fulfil-delivery');
    await waitFor(() => expect(screen.getByTestId('address-row-ADR-1')).toBeTruthy());
    tap('address-row-ADR-1');
    // The picker belongs to Collect it; under Delivery it is gone.
    expect(screen.queryByTestId('fulfil-pickup-branches')).toBeNull();
  }

  it('on POST /orders', async () => {
    await chooseBranchThenDeliver();
    await tapAsync('cart-pay');
    expect(walletBody()).toEqual({ fulfilment: 'delivery', addressId: 'ADR-1' });
    expect('pickupBranchId' in walletBody()).toBe(false);
  });

  it('on POST /orders/payments', async () => {
    await chooseBranchThenDeliver();
    tap('cart-method-knet');
    await tapAsync('cart-pay-card');
    await waitFor(() => expect(createOrderPayment).toHaveBeenCalledTimes(1));
    expect(cardBody()).toEqual({ fulfilment: 'delivery', addressId: 'ADR-1' });
    expect('pickupBranchId' in cardBody()).toBe(false);
  });

  it('and switching back to Collect it restores her branch', async () => {
    await chooseBranchThenDeliver();
    tap('fulfil-pickup');
    expect(checked('pickup-branch-BR-SAL')).toBe('true');
  });
});

// ════════════════════════════════════════════════════════════ 4. refusals ══

describe('4. each refusal renders its own sentence from the CODE', () => {
  describe.each([
    ['en', en],
    ['ar', ar],
  ] as const)('%s', (lang, copy) => {
    it.each(REFUSALS)('%s → its own sentence, never the server’s message', async (code, status, chip, key, message) => {
      placeOrder.mockRejectedValueOnce(refusal(code, status, message));
      await cartAt(TWO, lang);
      tap('pickup-branch-BR-SAL');
      await tapAsync('cart-pay');

      await waitFor(() => expect(screen.getByTestId(chip)).toBeTruthy());
      expect(screen.getByTestId(chip).textContent).toBe(copy[key]);
      expect(screen.getByTestId('cart-sheet').textContent).not.toContain(message);
      // Exactly one of the three.
      for (const [, , other] of REFUSALS) {
        if (other !== chip) expect(screen.queryByTestId(other)).toBeNull();
      }
      // Not a failure: made before the debit, so no "unknown outcome" sentence.
      expect(screen.queryByTestId('cart-failed')).toBeNull();
      expect(screen.queryByTestId('cart-offline')).toBeNull();
      // The list she chose from is stale — the salon is re-read.
      expect(stale).toBe(1);
    });
  });

  it('the three sentences are three different sentences, in both languages', () => {
    for (const copy of [en, ar]) {
      const said = new Set(REFUSALS.map(([, , , key]) => copy[key]));
      expect(said.size).toBe(3);
      expect(said.has(copy.cartNoPickupBranch)).toBe(false);
    }
  });

  /**
   * CLOSED BETWEEN CHOOSING AND PAYING. The basket survives, Pay is held over
   * the refused branch, and choosing another one clears the sentence and goes
   * through — under the SAME key, because the refusal rolled back and burned
   * nothing (see § 5).
   */
  it('pickup_branch_closed keeps the basket, holds Pay, and a new choice goes through', async () => {
    placeOrder.mockRejectedValueOnce(refusal(...(['pickup_branch_closed', 409, REFUSALS[2][4]] as const)));
    await cartAt(TWO);
    tap('pickup-branch-BR-SAL');
    await tapAsync('cart-pay');
    await waitFor(() => expect(screen.getByTestId('cart-pickup-closed')).toBeTruthy());

    expect(screen.getByTestId('cart-line-PR-01')).toBeTruthy();
    expect(screen.getByTestId('shop-cart-badge')).toBeTruthy();
    expect(disabled('cart-pay')).toBe(true);

    placeOrder.mockResolvedValueOnce(orderResult({ ...KWC, closed: false }));
    tap('pickup-branch-BR-KWC');
    expect(screen.queryByTestId('cart-pickup-closed')).toBeNull();
    await tapAsync('cart-pay');
    expect(placeOrder).toHaveBeenCalledTimes(2);
    expect(walletBody(1)).toEqual({ pickupBranchId: 'BR-KWC' });
  });

  it('pickup_branch_closed on the card PRE-FLIGHT is the cart’s sentence, not "couldn’t start"', async () => {
    createOrderPayment.mockRejectedValueOnce(refusal('pickup_branch_closed', 409, REFUSALS[2][4]));
    await cartAt(TWO, 'ar');
    tap('pickup-branch-BR-SAL');
    tap('cart-method-knet');
    await tapAsync('cart-pay-card');
    await waitFor(() => expect(screen.getByTestId('cart-pickup-closed')).toBeTruthy());
    expect(screen.getByTestId('cart-pickup-closed').textContent).toBe(ar.cartPickupClosed);
    expect(screen.queryByTestId('card-start-failed')).toBeNull();
    expect(screen.getByTestId('cart-line-PR-01')).toBeTruthy();
  });

  it('a settlement refusal after she paid reads the branch reason from the code, EN and AR', async () => {
    for (const [lang, copy] of [
      ['en', en],
      ['ar', ar],
    ] as const) {
      getOrderPayment.mockResolvedValue({
        intent: { ...INTENT, status: 'succeeded' },
        order: {
          status: 'refused',
          transactionId: null,
          refusal: { code: 'pickup_branch_closed', message: REFUSALS[2][4] },
          result: null,
        },
      });
      await cartAt(TWO, lang);
      tap('pickup-branch-BR-SAL');
      tap('cart-method-knet');
      await tapAsync('cart-pay-card');
      await waitFor(() => expect(screen.getByTestId('card-refused')).toBeTruthy());
      expect(screen.getByTestId('card-refused-reason').textContent).toBe(
        copy.cardOrderRefusal.pickup_branch_closed,
      );
      expect(screen.getByTestId('card-sheet').textContent).not.toContain(REFUSALS[2][4]);
      cleanup();
    }
  });
});

// ═════════════════════════════════════════════════════ 5. idempotency key ══

describe('5. a branch change is the SAME purchase to the key', () => {
  /**
   * The walk in `useShop` § AND THE PICKUP BRANCH IS NOT IN IT EITHER. She pays
   * collecting at Salmiya; the answer never arrives. She switches to Kuwait
   * City and pays again. The retry MUST carry the first key: if the first
   * attempt committed, the server answers 422 and she is told the order was
   * already placed — one debit. A fresh key there is a second order.
   */
  it('wallet rail: the retry at another branch carries the first key, and a 422 reads as already placed', async () => {
    placeOrder
      .mockRejectedValueOnce(new ApiError('offline', 'No connection.', 'WLT-1', null))
      .mockRejectedValueOnce(
        new ApiError('server', 'That key was used for a different request.', 'WLT-2', 422, 'idempotency_key_reused'),
      );
    await cartAt(TWO);
    tap('pickup-branch-BR-SAL');
    await tapAsync('cart-pay');
    await waitFor(() => expect(screen.getByTestId('cart-offline')).toBeTruthy());

    tap('pickup-branch-BR-KWC');
    await tapAsync('cart-pay');
    expect(placeOrder).toHaveBeenCalledTimes(2);
    expect(walletBody(0)).toEqual({ pickupBranchId: 'BR-SAL' });
    expect(walletBody(1)).toEqual({ pickupBranchId: 'BR-KWC' });
    expect(walletKey(1)).toBe(walletKey(0));

    await waitFor(() => expect(screen.getByTestId('cart-already-placed')).toBeTruthy());
    expect(screen.getByTestId('cart-already-placed').textContent).toBe(en.cartAlreadyPlaced);
  });

  it('card rail: a branch changed under the held key reuses it', async () => {
    createOrderPayment.mockRejectedValueOnce(new ApiError('offline', 'No connection.', 'WLT-3', null));
    await cartAt(TWO);
    tap('pickup-branch-BR-SAL');
    tap('cart-method-knet');
    await tapAsync('cart-pay-card');
    await waitFor(() => expect(screen.getByTestId('card-start-failed')).toBeTruthy());
    await tapAsync('card-close');

    tap('pickup-branch-BR-KWC');
    await tapAsync('cart-pay-card');
    await waitFor(() => expect(createOrderPayment).toHaveBeenCalledTimes(2));
    expect(cardBody(1)).toEqual({ pickupBranchId: 'BR-KWC' });
    expect(cardKey(1)).toBe(cardKey(0));
  });
});

// ═══════════════════════════════════════════════════════ 6. confirmation ══

describe('6. the confirmation says where she collects, from the response', () => {
  it.each([
    ['en', en, 'Salmiya'],
    ['ar', ar, 'السالمية'],
  ] as const)('%s — "Collect from" the branch the server settled', async (lang, copy, name) => {
    placeOrder.mockResolvedValueOnce(orderResult({ ...SAL, closed: false }));
    await cartAt(TWO, lang);
    tap('pickup-branch-BR-SAL');
    await tapAsync('cart-pay');
    await waitFor(() => expect(screen.getByTestId('tx-sheet')).toBeTruthy());
    expect(screen.getByTestId('tx-rows').textContent).toContain(`${copy.pickupFrom}${name}`);
  });

  it('at a single-branch salon she sent nothing, and the invoice is where she learns the branch', async () => {
    placeOrder.mockResolvedValueOnce(orderResult({ ...KWC, closed: false }));
    await cartAt(ONE);
    await tapAsync('cart-pay');
    await waitFor(() => expect(screen.getByTestId('tx-sheet')).toBeTruthy());
    expect(walletBody()).toEqual({});
    expect(screen.getByTestId('tx-rows').textContent).toContain(`${en.pickupFrom}Kuwait City`);
  });

  it('a delivery (pickupBranch null) draws no Collect-from row', async () => {
    placeOrder.mockResolvedValueOnce(orderResult(null));
    await cartAt(ONE);
    await tapAsync('cart-pay');
    await waitFor(() => expect(screen.getByTestId('tx-sheet')).toBeTruthy());
    expect(screen.getByTestId('tx-rows').textContent).not.toContain(en.pickupFrom);
  });
});

// ═════════════════════════════════════════════════════════════════ 7. RTL ══

describe('7. the picker in Arabic', () => {
  it('mirrors, speaks the Arabic names, and says every word in Arabic', async () => {
    await cartAt(TWO, 'ar');
    expect(document.documentElement.dir).toBe('rtl');
    const picker = screen.getByTestId('fulfil-pickup-branches');
    expect(picker.textContent).toContain(ar.pickupFrom);
    expect(rowName('pickup-branch-BR-KWC')).toBe('مدينة الكويت');
    expect(rowName('pickup-branch-BR-SAL')).toBe('السالمية');
    expect(screen.getByTestId('fulfil-pickup').textContent).toContain(ar.fulfilPickupChoose);
    expect(screen.getByTestId('cart-no-pickup-branch').textContent).toBe(ar.cartNoPickupBranch);
    // No Latin letter anywhere in the picker — a missed `nameAr` would show here.
    expect(picker.textContent).not.toMatch(/[A-Za-z]/);

    tap('pickup-branch-BR-SAL');
    expect(screen.getByTestId('fulfil-pickup').textContent).toContain(ar.fulfilPickupAt('السالمية'));
    /*
      THE ROW IS A LOGICAL `row`, NEVER `row-reverse`, so `dir="rtl"` flips it —
      `i18n/rtl.ts`. jsdom does not lay out, so this reads the style the row
      was given rather than measuring where the dot landed.
    */
    const row = screen.getByTestId('pickup-branch-BR-SAL');
    expect(getComputedStyle(row).flexDirection).toBe('row');
  });

  /**
   * SOURCE ASSERTION, labelled as such — the `bookEntryRender` precedent. The
   * row borrows `styles.row`/`styles.dot` from the address rows; none of the
   * styles it uses may carry a PHYSICAL edge, which would stay put when the
   * layout turns around.
   */
  it('the picker’s styles carry no physical left/right and no row-reverse (source)', () => {
    const src = fs.readFileSync(path.join(__dirname, '../components/FulfilmentSection.tsx'), 'utf8');
    const styles = src.slice(src.indexOf('const styles = StyleSheet.create'));
    expect(styles).not.toMatch(/row-reverse/);
    expect(styles).not.toMatch(/\b(marginLeft|marginRight|paddingLeft|paddingRight|left|right)\s*:/);
  });
});
