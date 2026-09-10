// @vitest-environment jsdom

/**
 * THE DELIVERY UI, RENDERED — the states, and the two rules that are claims
 * about pixels rather than about data.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT ONLY A RENDER CAN ASSERT.
 *
 *   THERE IS NO FEE LINE ANYWHERE. Not a fee row, not a subtotal split, not a
 *   "Delivery: free" row. `domain/fulfilment.ts` computes no amount, which is
 *   necessary and not sufficient: a component could still draw the words. So
 *   this file searches the rendered text of both fulfilment modes for every
 *   spelling of a fee, in both languages, and requires none of them.
 *
 *   AN ORDER'S ADDRESS IS NOT A CONTROL. `domain/shopOrders.ts` exports
 *   `orderAddressIsEditable = false`, which documents the rule and cannot
 *   enforce it. Here the order row is rendered and the address region is
 *   required to contain no button, no link and no edit affordance — and the
 *   label shown is required to be the SNAPSHOT's, never a live lookup.
 *
 *   THE EMPTY ADDRESS BOOK IS ITS OWN SENTENCE. Three ways to have no
 *   choosable address — never saved one, the read failed, the read is in flight
 *   — and `design/AVO States.dc.html` insists they never share words.
 *
 * The wall this file does not hit: nothing here imports
 * `react-native-qrcode-svg`, so it loads. See `vitest.config.ts`.
 * ═════════════════════════════════════════════════════════════════════════════
 */

import type { MemberAddress, ShopOrder } from '@avo/types';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CartSheet } from './CartSheet';
import { FulfilmentSection } from './FulfilmentSection';
import { OrdersSheet } from './OrdersSheet';
import { AddressSheet } from './AddressSheet';
import { LanguageProvider } from '../i18n/language';
import { PICKUP, type FulfilmentChoice } from '../domain/fulfilment';
import { fils } from '@avo/types';
import type { CheckoutRefusal } from '../domain/orderRefusal';
import { en } from '../copy/en';
import { ar } from '../copy/ar';
import type { AddressBookController } from '../state/useAddresses';
import type { OrdersController } from '../state/useOrders';
import { ADDRESS_OPTIONAL, ADDRESS_REQUIRED } from '../domain/address';

afterEach(cleanup);

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

function book(over: Partial<AddressBookController> = {}): AddressBookController {
  return {
    status: 'ready',
    addresses: [ADDRESS],
    failure: null,
    fetchedAt: 1_757_500_000_000,
    busy: false,
    writeError: null,
    retry: vi.fn(),
    clearWriteError: vi.fn(),
    save: vi.fn(),
    remove: vi.fn(),
    ...over,
  };
}

function orders(over: Partial<OrdersController> = {}): OrdersController {
  return {
    status: 'ready',
    orders: [],
    truncated: false,
    failure: null,
    fetchedAt: 1_757_500_000_000,
    retry: vi.fn(),
    ...over,
  };
}

function order(over: Partial<ShopOrder> = {}): ShopOrder {
  return {
    transactionId: 'TX-1',
    fulfilment: 'pickup',
    status: 'preparing',
    address: null,
    createdAt: '2026-09-10T09:00:00.000Z',
    readyAt: null,
    closedAt: null,
    ...over,
  };
}

function section(
  lang: 'en' | 'ar',
  choice: FulfilmentChoice,
  controller: AddressBookController = book(),
) {
  return render(
    <LanguageProvider initial={lang}>
      <FulfilmentSection
        choice={choice}
        book={controller}
        onMode={vi.fn()}
        onChoose={vi.fn()}
        onAdd={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
      />
    </LanguageProvider>,
  );
}

// ══════════════════════════════════════════════════════════ the fee rule ══

/**
 * Every spelling a fee could arrive under, in both languages. `توصيل` on its own
 * is legitimate — it is the word for delivery — so the Arabic entries are the
 * MONEY words rather than the delivery word.
 */
const FEE_WORDS = [
  'fee',
  'Fee',
  'charge',
  'Charge',
  'delivery cost',
  'Free',
  'free',
  'KD',
  'د.ك',
  'رسوم',
  'مجاناً',
  'مجانا',
  'التوصيل مجاني',
];

describe('there is no fee line, in either mode or either language', () => {
  for (const lang of ['en', 'ar'] as const) {
    for (const [name, choice] of [
      ['pickup', PICKUP],
      ['delivery', { mode: 'delivery' as const, addressId: 'ADR-1' }],
    ] as const) {
      it(`${lang} ${name} renders no fee word and no money at all`, () => {
        const { container } = section(lang, choice);
        const body = container.textContent ?? '';
        /*
          GUARDS THE WHOLE ASSERTION. A `not.toContain` sweep over an empty
          string passes, so the section is first required to have actually
          rendered its own heading — the same trap a green typecheck bought with
          a cast represents.
        */
        expect(body.length).toBeGreaterThan(40);
        expect(screen.getByTestId('fulfil-pickup')).toBeTruthy();
        expect(screen.getByTestId('fulfil-delivery')).toBeTruthy();
        for (const word of FEE_WORDS) {
          expect(body).not.toContain(word);
        }
        /*
          AND NO DIGITS THAT COULD BE MONEY. `0.000`, `0`, a decimal point — the
          same cart costs the same collected or delivered, so this section has no
          arithmetic to show. The address's own numbers (block 4, building 12) are
          only reachable under delivery, so the pickup case is checked for any
          decimal at all.
        */
        expect(body).not.toContain('0.000');
        expect(body).not.toContain('٠٠٠');
        if (name === 'pickup') expect(body).not.toMatch(/\d+\.\d/);
      });
    }
  }
});

// ══════════════════════════════════════════ the four address-book states ══

describe('the address list has four distinct states', () => {
  const DELIVERING: FulfilmentChoice = { mode: 'delivery', addressId: null };

  it('paints skeleton rows while loading, and no empty-state call to action', () => {
    section('en', DELIVERING, book({ status: 'loading', addresses: null }));
    expect(screen.getByTestId('fulfil-addresses-skeleton')).toBeTruthy();
    expect(screen.queryByTestId('fulfil-addresses-empty')).toBeNull();
    // A money field would skeleton as a bar; there is no money here at all.
    expect(screen.queryByText('0.000')).toBeNull();
  });

  /**
   * THE FIRST-RUN CASE, and the one a real customer hits. Its words are its own:
   * a failed read must not tell her to add an address she may already have, and
   * this must not offer a Try again for a state that is not a problem.
   */
  it('names the empty book and offers the one action that helps', () => {
    section('en', DELIVERING, book({ addresses: [] }));
    const empty = screen.getByTestId('fulfil-addresses-empty');
    expect(empty.textContent).toContain('No saved addresses');
    expect(screen.queryByTestId('fulfil-addresses-failed')).toBeNull();
    // Add is present — the only action that changes this state.
    expect(screen.getByTestId('address-add')).toBeTruthy();
  });

  it('says something different when the read failed than when the book is empty', () => {
    section('en', DELIVERING, book({ status: 'failed', addresses: null }));
    const failed = screen.getByTestId('fulfil-addresses-failed');
    expect(failed.textContent).toContain("We couldn't load your addresses");
    expect(failed.textContent).not.toContain('No saved addresses');
    // Cold and retryable: the retry is there.
    expect(screen.getByTestId('fulfil-addresses-failed-retry')).toBeTruthy();
  });

  /**
   * A COLD OFFLINE READ USES `offlineColdBody`, NOT `offlineBanner`. The banner
   * promises "showing your last update" and there is no last update — the copy
   * layer's own argument, and the reason that string was invented.
   */
  it('does not promise a last update on a cold offline read', () => {
    section('en', DELIVERING, book({ status: 'offline', addresses: null }));
    const failed = screen.getByTestId('fulfil-addresses-failed');
    expect(failed.textContent).toContain('Reconnect and try again');
    expect(failed.textContent).not.toContain('showing your last update');
  });

  /**
   * A FAILED REFRESH OVER A LIST ALREADY ON SCREEN KEEPS THE LIST —
   * interaction-spec.md §4, "keeps the last-known data visible with a stale
   * banner rather than blanking". The row stays tappable: an address that was
   * hers thirty seconds ago is still hers.
   */
  it('keeps the rows when a refresh fails over them', () => {
    section('en', DELIVERING, book({ status: 'offline' }));
    expect(screen.getByTestId('fulfil-addresses-offline')).toBeTruthy();
    expect(screen.getByTestId('address-row-ADR-1')).toBeTruthy();
  });

  /**
   * ADD IS AVAILABLE EVEN WHEN THE READ FAILED. A customer who cannot read her
   * book can still tell us where to send a bottle, and the POST does not depend
   * on the GET having worked.
   */
  it('offers Add in every state', () => {
    for (const controller of [
      book({ status: 'loading', addresses: null }),
      book({ addresses: [] }),
      book({ status: 'failed', addresses: null }),
      book({ status: 'offline', addresses: null }),
      book(),
    ]) {
      cleanup();
      section('en', DELIVERING, controller);
      expect(screen.getByTestId('address-add')).toBeTruthy();
    }
  });

  /** No chooser above a pickup order — it would offer a decision with no field. */
  it('draws no address list under pickup', () => {
    section('en', PICKUP);
    expect(screen.queryByTestId('fulfil-addresses')).toBeNull();
  });
});

// ══════════════════════════════════════════════ the snapshot is not live ══

describe("an order's address is text and never a control", () => {
  const SNAPSHOT = {
    id: 'ADR-1',
    label: 'Home',
    block: '4',
    street: 'Salem Al Mubarak',
    building: '12',
    floor: '3',
    apartment: null,
    area: 'Salmiya',
    governorate: null,
    instructions: 'Ring twice',
    latitude: null,
    longitude: null,
  };

  function sheet(list: ShopOrder[], lang: 'en' | 'ar' = 'en') {
    return render(
      <LanguageProvider initial={lang}>
        <OrdersSheet open orders={orders({ orders: list })} onClose={vi.fn()} />
      </LanguageProvider>,
    );
  }

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE RULE MOST LIKELY TO BE BROKEN BY A WELL-MEANING EDIT.
   *
   * The address region must contain NO button, NO link and no edit affordance.
   * `orderAddressIsEditable = false` documents that; only a render can hold it.
   * ═══════════════════════════════════════════════════════════════════════════
   */
  it('renders no button or link inside the address region', () => {
    sheet([order({ fulfilment: 'delivery', status: 'ready', address: SNAPSHOT })]);
    const region = screen.getByTestId('order-address-TX-1');
    expect(region.querySelectorAll('button')).toHaveLength(0);
    expect(region.querySelectorAll('a')).toHaveLength(0);
    expect(region.querySelectorAll('[role="button"]')).toHaveLength(0);
    expect(region.querySelectorAll('input')).toHaveLength(0);
    expect(region.textContent).not.toContain('Edit');
  });

  /** And it says so, so a customer is not left to infer it. */
  it('says the address is the one she gave when she ordered', () => {
    sheet([order({ fulfilment: 'delivery', address: SNAPSHOT })]);
    expect(screen.getByTestId('order-fixed-TX-1').textContent).toContain(
      'The address you gave when you ordered',
    );
  });

  /**
   * NULLS ARE SKIPPED. The snapshot has a floor and no apartment, so there is a
   * floor line and no apartment line — and, the point, no second copy of the
   * building number standing in for the apartment.
   */
  it('skips the null components rather than substituting anything', () => {
    sheet([order({ fulfilment: 'delivery', address: SNAPSHOT })]);
    const region = screen.getByTestId('order-address-TX-1');
    const body = region.textContent ?? '';
    expect(body).toContain('Floor 3');
    expect(body).not.toContain('Apartment');
    // `12` appears exactly once — as the building, not also as an apartment.
    expect(body.match(/12/g)).toHaveLength(1);
    expect(body).not.toContain('string');
  });

  it('renders her note to the driver on the order but not the label twice', () => {
    sheet([order({ fulfilment: 'delivery', address: SNAPSHOT })]);
    const body = screen.getByTestId('order-address-TX-1').textContent ?? '';
    expect(body).toContain('Ring twice');
    expect(body.match(/Home/g)).toHaveLength(1);
  });

  /** A pickup order shows the salon and NO branch — there is no branch field. */
  it('shows the salon and no branch for a pickup order', () => {
    sheet([order({ fulfilment: 'pickup' })]);
    expect(screen.getByTestId('order-pickup-TX-1').textContent).toContain(
      'Collect at the salon',
    );
    expect(screen.queryByTestId('order-address-TX-1')).toBeNull();
    for (const branch of ['Salmiya', 'Kuwait City', 'Branch', 'branch']) {
      expect(screen.getByTestId('order-row-TX-1').textContent).not.toContain(branch);
    }
  });
});

// ══════════════════════════════════════════════════ the three statuses ══

describe('the three statuses each render, and there is no fourth', () => {
  function sheet(list: ShopOrder[]) {
    return render(
      <LanguageProvider initial="en">
        <OrdersSheet open orders={orders({ orders: list })} onClose={vi.fn()} />
      </LanguageProvider>,
    );
  }

  it('renders a delivery order in each of preparing, ready and closed', () => {
    sheet([
      order({ transactionId: 'TX-P', fulfilment: 'delivery', status: 'preparing' }),
      order({
        transactionId: 'TX-R',
        fulfilment: 'delivery',
        status: 'ready',
        readyAt: '2026-09-10T10:00:00.000Z',
      }),
      order({
        transactionId: 'TX-C',
        fulfilment: 'delivery',
        status: 'closed',
        readyAt: '2026-09-10T10:00:00.000Z',
        closedAt: '2026-09-10T11:00:00.000Z',
      }),
    ]);
    expect(screen.getByTestId('order-status-TX-P').textContent).toBe('Being prepared');
    expect(screen.getByTestId('order-status-TX-R').textContent).toBe('Ready and on its way');
    expect(screen.getByTestId('order-status-TX-C').textContent).toBe('Delivered');
  });

  /** No cancel, no undo, no "mark collected" — advancing a status is the merchant's. */
  it('offers no action that would change a status', () => {
    sheet([order({ transactionId: 'TX-R', fulfilment: 'delivery', status: 'ready' })]);
    const row = screen.getByTestId('order-row-TX-R');
    expect(row.querySelectorAll('button')).toHaveLength(0);
    for (const word of ['Cancel', 'Undo', 'Collected?', 'Mark']) {
      expect(row.textContent).not.toContain(word);
    }
  });

  it('names the empty list without offering a retry', () => {
    sheet([]);
    expect(screen.getByTestId('orders-empty').textContent).toContain('No orders yet');
    expect(screen.queryByTestId('orders-failed')).toBeNull();
    expect(screen.queryByTestId('orders-stale')).toBeNull();
  });

  it('reports the cap when the server capped the page', () => {
    render(
      <LanguageProvider initial="en">
        <OrdersSheet
          open
          orders={orders({ orders: [order()], truncated: true })}
          onClose={vi.fn()}
        />
      </LanguageProvider>,
    );
    expect(screen.getByTestId('orders-truncated')).toBeTruthy();
  });
});

// ══════════════════════════════════════════════════════════════ the form ══

describe('the address form', () => {
  function form(lang: 'en' | 'ar' = 'en', editing: MemberAddress | null = null) {
    return render(
      <LanguageProvider initial={lang}>
        <AddressSheet
          open
          editing={editing}
          busy={false}
          writeError={null}
          onClose={vi.fn()}
          onSave={vi.fn()}
        />
      </LanguageProvider>,
    );
  }

  /**
   * ONE INPUT PER FIELD WE STORE — nine, not two. That count IS the fix for
   * Lean's fan-out: there is no input here whose value could reach two columns,
   * because every input has exactly one destination.
   */
  it('renders exactly nine inputs, one per stored field', () => {
    form();
    for (const field of [...ADDRESS_REQUIRED, ...ADDRESS_OPTIONAL]) {
      expect(screen.getByTestId(`address-field-${field}`)).toBeTruthy();
    }
    expect(screen.getAllByTestId(/^address-field-/)).toHaveLength(9);
  });

  /**
   * THE `(optional)` SUFFIX IS ON FIVE LABELS AND NOT ON NINE, and the asymmetry
   * is the feature: the form has to SAY which fields may be left empty, because
   * an empty field is stored empty rather than filled with a copy of another.
   */
  it('marks the five optional fields optional and the four required ones not', () => {
    const { container } = form();
    expect((container.textContent ?? '').match(/\(optional\)/g)).toHaveLength(5);
    expect(screen.getByTestId('address-optional-note').textContent).toContain(
      'Leave anything you do not need blank',
    );
  });

  /** No coordinate input, and no button that would manufacture a pair. */
  it('collects no coordinates and offers no location button', () => {
    const { container } = form();
    const body = container.textContent ?? '';
    for (const word of ['Latitude', 'Longitude', 'location', 'Location', 'map', 'Map', 'GPS']) {
      expect(body).not.toContain(word);
    }
    expect(screen.queryByTestId('address-field-latitude')).toBeNull();
    expect(screen.queryByTestId('address-field-longitude')).toBeNull();
  });

  /**
   * Save is DISABLED ONLY BY `busy`, never by an incomplete form. A Save greyed
   * out for a reason she cannot see is a dead end; tapping it and being told
   * which fields are missing is the shape sign-in and signup already use.
   */
  it('leaves Save enabled on a blank form and shows nothing until it is tapped', () => {
    form();
    expect(screen.getByTestId('address-save').getAttribute('aria-disabled')).not.toBe('true');
    expect(screen.queryByTestId('address-missing')).toBeNull();
  });

  it('seeds the form from a saved address when editing', () => {
    form('en', { ...ADDRESS, floor: '3' });
    expect(screen.getByTestId('address-field-label').getAttribute('value')).toBe('Home');
    expect(screen.getByTestId('address-field-floor').getAttribute('value')).toBe('3');
    // A null column is an EMPTY input, never invented text.
    expect(screen.getByTestId('address-field-apartment').getAttribute('value')).toBe('');
  });

  /** #12: every label renders in Arabic, and none of them falls back to English. */
  it('renders Arabic labels rather than English ones', () => {
    const { container } = form('ar');
    const body = container.textContent ?? '';
    expect(body).toContain('القطعة');
    expect(body).toContain('الشارع');
    expect(body).toContain('المبنى');
    expect(body).toContain('(اختياري)');
    expect(body).not.toContain('Block');
    expect(body).not.toContain('Street');
  });
});

// ══════════════════════════════════════════ the cart's own refusal chips ══

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE OFFLINE CHIP MUST NOT BE THE SIGN-UP SENTENCE.
 *
 * FOUND BY DRIVING, and this is the regression test for it. The cart rendered
 * `copy.signUpOffline` for an offline checkout, so an Arabic wallet mid-payment
 * showed "No connection. You need one to create an account." — the wrong words
 * for the surface, and in English, because that key is in `AR_GAPS`.
 *
 * Two properties are pinned, and the second is the one a reading would miss:
 * the sentence is the CART's, and it does not claim nothing was charged. The
 * outcome of a money-moving POST that never answered is unknown, and
 * `shopOrderFailed` — "Nothing has been charged." — is reserved for a refusal
 * the server demonstrably made.
 * ═══════════════════════════════════════════════════════════════════════════
 */
describe("the cart's offline chip", () => {
  function cart(refusal: CheckoutRefusal | null, lang: 'en' | 'ar' = 'en') {
    return render(
      <LanguageProvider initial={lang}>
        <CartSheet
          open
          lines={[
            {
              product: {
                id: 'PR-01',
                salonId: 'SAL-AMARA',
                name: 'Argan hair oil 100ml',
                priceFils: 8500,
                image: null,
              },
              qty: 1,
              lineTotalFils: fils(8500),
            },
          ]}
          count={1}
          total={fils(8500)}
          balanceFils={24500}
          canAfford
          shortfall={fils(0)}
          stale={[]}
          busy={false}
          refusal={refusal}
          fulfilment={PICKUP}
          block={null}
          book={book()}
          onClose={vi.fn()}
          onAdd={vi.fn()}
          onRemove={vi.fn()}
          onCheckout={vi.fn()}
          onTopUp={vi.fn()}
          onFulfilment={vi.fn()}
          onChooseAddress={vi.fn()}
          onAddAddress={vi.fn()}
          onEditAddress={vi.fn()}
          onDeleteAddress={vi.fn()}
        />
      </LanguageProvider>,
    );
  }

  it('renders the cart sentence, never the sign-up one', () => {
    cart({ kind: 'offline' });
    const chip = screen.getByTestId('cart-offline');
    expect(chip.textContent).toBe(en.cartOffline);
    expect(chip.textContent).not.toBe(en.signUpOffline);
    expect(chip.textContent).not.toContain('create an account');
  });

  /**
   * AND IT RENDERS ARABIC. `signUpOffline` is in `AR_GAPS`, so reusing it
   * imported a translation gap into a screen that had none — the half of the
   * defect that only an Arabic screenshot showed.
   */
  it('renders Arabic in an Arabic cart', () => {
    cart({ kind: 'offline' }, 'ar');
    const chip = screen.getByTestId('cart-offline');
    expect(chip.textContent).toBe(ar.cartOffline);
    expect(chip.textContent).not.toBe(en.cartOffline);
    expect(chip.textContent).not.toContain('connection');
  });

  /**
   * IT DOES NOT PROMISE NOTHING WAS CHARGED. The outcome is unknown: an order
   * moves money with one concurrency guard where a charge has two, so a client
   * that could not read the response does not know whether the money moved.
   */
  it('does not claim nothing was charged, and offers no retry', () => {
    cart({ kind: 'offline' });
    expect(screen.getByTestId('cart-offline').textContent).not.toContain('Nothing has been charged');
    // The Pay button is present but disabled — no tap that could commit a second
    // order over one whose outcome we cannot see.
    expect(screen.getByTestId('cart-pay').getAttribute('aria-disabled')).toBe('true');
  });

  /**
   * `alreadyPlaced` IS THE OPPOSITE CASE AND MUST NOT READ AS A FAILURE. The 422
   * means an earlier attempt COMMITTED, so a sentence saying nothing was charged
   * would be a lie about a settled debit.
   */
  it('tells her an already-placed order was placed, and disables Pay', () => {
    cart({ kind: 'alreadyPlaced' });
    const chip = screen.getByTestId('cart-already-placed');
    expect(chip.textContent).toContain('already placed');
    expect(chip.textContent).not.toContain('Nothing has been charged');
    expect(screen.getByTestId('cart-pay').getAttribute('aria-disabled')).toBe('true');
  });

  /** THE TOTALS BLOCK GAINED NO ROW. Two rows, and no fee in any spelling. */
  it('shows exactly Total and Paid from wallet, with no fee row', () => {
    const { container } = cart(null);
    const body = container.textContent ?? '';
    expect(body).toContain('Total');
    expect(body).toContain('Paid from wallet');
    for (const word of ['Delivery fee', 'delivery fee', 'Free delivery', 'Delivery: free', 'Subtotal']) {
      expect(body).not.toContain(word);
    }
  });
});
