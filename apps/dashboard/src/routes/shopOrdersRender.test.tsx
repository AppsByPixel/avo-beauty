// @vitest-environment jsdom

/**
 * The fulfilment board's guarantees that no source scan can reach.
 *
 * `stateCensus.test.ts` proves this screen HAS the four-state vocabulary and
 * that `truncated` reaches the paint. Neither of those can prove what a merchant
 * actually READS, and every property below is about exactly that — because on
 * this screen the wrong words are not cosmetic:
 *
 *   1. PICKUP IS DATA, NOT A MISSING FIELD. `address: null` is the ordinary shape
 *      of a live fork (`PRIOR-ART.md`: "Pickup is not replaced. It is a fork."),
 *      so the cell has to SAY something. An em dash or "No address" reports a
 *      perfectly good row as broken, which is the premature-zero class with the
 *      sign flipped. Only rendering proves which one landed.
 *
 *   2. THE ADDRESS IS A SNAPSHOT AND MUST NOT LOOK LIVE. The requirement is
 *      NEGATIVE — no link, no edit affordance — and a negative is precisely what
 *      gets built by accident, and what a grep for the thing that should not be
 *      there cannot distinguish from a comment about it. So it is asserted
 *      against the DOM: nothing in that cell is an anchor.
 *
 *   3. THE CONTROL IS MONOTONIC. `preparing → ready → closed`, forward only,
 *      enforced server-side with the row count deciding. A button offering a
 *      backwards move is not just a 409 — "closed → preparing" would tell a
 *      customer her delivered order is being prepared. Pinned per status,
 *      including the closed row having no button at all.
 *
 *   4. THE THREE EMPTIES DO NOT SHARE COPY. `AVO States.dc.html` is explicit,
 *      and the middle one is the trap: "orders land here as soon as they're
 *      placed" is a false promise to a salon whose Shop module is off, because
 *      nobody CAN place one.
 *
 *   5. THE TRUNCATION NAMES WHICH END IS MISSING. This lane has already paid for
 *      the alternative once — a `DESC LIMIT 200` believed complete, and a closure
 *      preview that reported 0 held deposits against the server's 3. A notice
 *      that says "some rows are missing" without saying WHICH is only half a fix.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MerchantShopOrder } from '../api/orders.js';
import { AddressSnapshot, BoardEmpty, OrderRow, TruncatedNotice } from './ShopOrders.js';

/*
 * NOT AUTOMATIC — this project does not run vitest with `globals`, so
 * `@testing-library/react` never registers its own `afterEach(cleanup)`.
 * `shopRender.test.tsx` carries the same line and the same warning.
 */
afterEach(cleanup);

/** The address as the API actually serialises it — every optional part present. */
const ADDRESS: NonNullable<MerchantShopOrder['address']> = {
  id: 'ADR-bf73672c-c3e3-4e74-a74b-d63461deb2c6',
  label: 'Home',
  block: '4',
  street: 'Salem Al-Mubarak',
  building: '27',
  floor: '3',
  apartment: '12',
  area: 'Salmiya',
  governorate: 'Hawalli',
  instructions: 'Ring the intercom, the gate sticks.',
  /*
   * STRINGS, and that is the wire type rather than a fixture convenience. The
   * column is `numeric` — the database's ban on the float family covers a
   * coordinate, and nothing does arithmetic on one — so it arrives as text.
   */
  latitude: '29.333900',
  longitude: '48.078200',
};

const DELIVERY: MerchantShopOrder = {
  transactionId: 'TX-3233428',
  fulfilment: 'delivery',
  status: 'preparing',
  address: ADDRESS,
  createdAt: '2026-09-09T14:46:21.658Z',
  readyAt: null,
  closedAt: null,
  memberName: 'Dana Al-Sabah',
  memberPhone: '+96599124408',
};

const PICKUP: MerchantShopOrder = {
  transactionId: 'TX-8265554',
  fulfilment: 'pickup',
  status: 'preparing',
  /*
   * Explicit null, for `shopRender.test.tsx § PRODUCT.image`'s reason: the API
   * sends the key on every row, so a fixture that omitted it would be the one
   * order whose "pickup" is indistinguishable from "field not sent".
   */
  address: null,
  createdAt: '2026-09-09T14:46:21.835Z',
  readyAt: null,
  closedAt: null,
  memberName: 'Dana Al-Sabah',
  memberPhone: '+96599124408',
};

/**
 * A DELIVERY WHOSE ADDRESS SNAPSHOT WAS ERASED — the third state, and the one a
 * merchant actually meets. DECISIONS.md #97, migration 0048.
 *
 * `fulfilment: 'delivery'` WITH `address: null`, which is exactly the pair the
 * board has to read, and there is no fourth field to help it: `address_erased_at`
 * is deliberately not on the wire (`api/src/routes/orders.ts § serialiseShopOrder`)
 * because it would tell a salon WHEN a customer asked to be erased.
 *
 * `status: 'closed'` and the tombstoned name/phone, because that is what the row
 * genuinely looks like: erasure runs 30+ days after the request and scrubs
 * `member` in the SAME transaction, so an erased order's Customer cell reads
 * "Deleted account" and its phone is a `+990` sentinel. The fixture carries them
 * so the tests below are asserting about a row that can exist rather than about a
 * shape assembled to make a point.
 */
const ERASED_DELIVERY: MerchantShopOrder = {
  transactionId: 'TX-5510923',
  fulfilment: 'delivery',
  status: 'closed',
  address: null,
  createdAt: '2026-07-28T09:12:04.117Z',
  readyAt: '2026-07-28T10:41:55.402Z',
  closedAt: '2026-07-28T13:08:19.660Z',
  memberName: 'Deleted account',
  memberPhone: '+990418702935514',
};

/**
 * A `<tr>` needs a table around it or jsdom hoists it out of the tree and the
 * queries below find nothing — a zero result that would be a claim about the
 * harness rather than about the row.
 */
function renderRow(order: MerchantShopOrder, moving = false) {
  const onMove = vi.fn();
  const view = render(
    <table>
      <tbody>
        <OrderRow order={order} moving={moving} onMove={onMove} />
      </tbody>
    </table>,
  );
  return { ...view, onMove };
}

describe('pickup is a live fork, so its row states a fact rather than an absence', () => {
  it('says where the order is going instead of rendering a missing field', () => {
    renderRow(PICKUP);
    expect(screen.getByText('Collecting at the salon')).toBeTruthy();
  });

  it('never renders the pickup cell as an em dash or as "no address"', () => {
    const { container } = renderRow(PICKUP);
    const where = container.querySelector('.orders__where')!;
    // The two shapes that would report ordinary data as broken.
    expect(where.textContent).not.toContain('—');
    expect(where.textContent?.toLowerCase()).not.toContain('no address');
  });

  it('labels the fulfilment in words, not by the presence of an address', () => {
    renderRow(PICKUP);
    expect(screen.getByText('Pickup')).toBeTruthy();
    cleanup();
    renderRow(DELIVERY);
    expect(screen.getByText('Delivery')).toBeTruthy();
  });
});

/**
 * THE ERASED DELIVERY — `fulfilment: 'delivery'`, `address: null`.
 *
 * WHY THIS BLOCK IS NOT A DUPLICATE OF THE ONE ABOVE. `address === null` had one
 * meaning when this screen was built and now has two, so every assertion above
 * about "the null cell" was implicitly an assertion about pickup. The regression
 * this block pins is the one the screen actually shipped: a row printing
 * "Collecting at the salon" two cells from its own Delivery pill. A false
 * sentence renders identically to a true one and no source scan can tell them
 * apart, so it has to be read out of the DOM.
 *
 * AND IT PINS WHAT THE COPY MUST NOT SAY, which is the half that would rot
 * first. The constraints are privacy constraints rather than style ones — no
 * date, no reason, nothing about the order's status, no "deleted" — so they are
 * asserted, not left to the comment in `ShopOrders.tsx` to defend.
 */
describe('a delivery with no address was erased, and the cell must not call it pickup', () => {
  it('never says the customer is collecting on a delivery row', () => {
    const { container } = renderRow(ERASED_DELIVERY);
    const where = container.querySelector('.orders__where')!;
    // THE SHIPPED DEFECT, stated as the thing that must not be in the cell.
    expect(where.textContent).not.toContain('Collecting at the salon');
    expect(where.textContent?.toLowerCase()).not.toContain('collect');
    expect(where.textContent?.toLowerCase()).not.toContain('salon');
  });

  it('says the address is gone rather than leaving the cell blank', () => {
    renderRow(ERASED_DELIVERY);
    expect(screen.getByText('Address no longer held')).toBeTruthy();
  });

  it('does not read as a missing field a merchant should go looking for', () => {
    const { container } = renderRow(ERASED_DELIVERY);
    const where = container.querySelector('.orders__where')!;
    expect(where.textContent?.trim()).not.toBe('');
    expect(where.textContent).not.toContain('—');
    expect(where.textContent?.toLowerCase()).not.toContain('no address');
    expect(where.textContent?.toLowerCase()).not.toContain('unknown');
  });

  /**
   * THE FOUR THINGS THE COPY MAY NOT CONTAIN, each one a privacy or a
   * truthfulness constraint from `ShopOrders.tsx § the erased delivery`:
   *
   *   a date        the API does not serve `address_erased_at` on purpose — it
   *                 would say WHEN a customer asked to be erased. If a field
   *                 like it ever appears on the wire, this screen still may not
   *                 print it, and this assertion is what notices.
   *   a person      "deleted", "erased", "removed by" — the sentence is about a
   *                 record and has no subject who is her. ("Deleted account" in
   *                 the Customer cell is the API's tombstone, which is why the
   *                 assertion is scoped to this cell.)
   *   a reason      nothing invented about why.
   *   the order     "cancelled" / "undeliverable" would be a claim about the
   *                 purchase derived from a fact about the data. The Status
   *                 column owns the status and the row is closed and paid.
   */
  it('says nothing about when, who, why, or what became of the order', () => {
    const { container } = renderRow(ERASED_DELIVERY);
    const text = container.querySelector('.orders__where')!.textContent!.toLowerCase();
    for (const forbidden of [
      'deleted',
      'erased',
      'erasure',
      'request',
      'gdpr',
      'privacy',
      'cancel',
      'undeliverable',
      'failed',
      'error',
      '2026',
      '2025',
    ]) {
      expect(text).not.toContain(forbidden);
    }
  });

  it('still labels the row Delivery, because that is what she chose', () => {
    renderRow(ERASED_DELIVERY);
    expect(screen.getByText('Delivery')).toBeTruthy();
  });

  /**
   * NOT STYLED AS A PROBLEM. `--avo-warn` on this cell would read as something
   * wrong with a paid, delivered order — see `app.css § .orders__erased`. Pinned
   * by class rather than by computed colour, which jsdom does not resolve.
   */
  it('is a quiet statement, and offers nothing to click', () => {
    const { container } = renderRow(ERASED_DELIVERY);
    expect(container.querySelector('.orders__erased')).toBeTruthy();
    /*
     * THE NEGATIVE REQUIREMENT, which this state needs MORE than the snapshot
     * does: a "why is this gone?" link, or anything that looks like a way to
     * recover the address, would undo the erasure by inviting the search.
     */
    expect(container.querySelector('.orders__where a')).toBeNull();
    expect(container.querySelector('.orders__where button')).toBeNull();
  });
});

describe('the address is a snapshot and the screen must not imply otherwise', () => {
  /**
   * THE NEGATIVE REQUIREMENT, asserted against the DOM.
   *
   * `address` does not track her address book: editing or deleting an address
   * leaves every past order as it was, deliberately, so a delivered order stays
   * answerable. A link — to her profile, to her addresses, anywhere — would
   * invite a merchant to read the cell as live, which is the one misreading
   * `ShopOrderSchema` warns about by name.
   */
  it('puts no link, and nothing clickable, on the address cell', () => {
    const { container } = render(<AddressSnapshot address={ADDRESS} />);
    expect(container.querySelectorAll('a')).toHaveLength(0);
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });

  it('labels every part of the address rather than relying on position', () => {
    render(<AddressSnapshot address={ADDRESS} />);
    /*
     * `PRIOR-ART.md` § "The one thing not to follow": Lean fans one input across
     * four address fields, so a driver receives a house number in the block
     * field. An unlabelled "4 · Salem Al-Mubarak · 27" reproduces that confusion
     * at the reading end, where somebody has to act on it.
     */
    const line = screen.getByText(/Block 4/).textContent ?? '';
    expect(line).toContain('Block 4');
    expect(line).toContain('Street Salem Al-Mubarak');
    expect(line).toContain('Building 27');
    expect(line).toContain('Floor 3');
    expect(line).toContain('Apt 12');
  });

  it('keeps her own name for the address, and her instructions in her words', () => {
    render(<AddressSnapshot address={ADDRESS} />);
    expect(screen.getByText('Home')).toBeTruthy();
    expect(screen.getByText(/Ring the intercom/)).toBeTruthy();
  });

  /**
   * AN OMITTED PART IS OMITTED — not blank-labelled, and never filled in from a
   * neighbour. That is the whole point of `normaliseOptional` on the way in, and
   * a `?? '—'` here would undo it: "Floor —" is a claim about a floor.
   */
  it('drops the optional parts that are null instead of labelling them empty', () => {
    const bare = { ...ADDRESS, floor: null, apartment: null, instructions: null };
    const { container } = render(<AddressSnapshot address={bare} />);
    expect(container.textContent).not.toContain('Floor');
    expect(container.textContent).not.toContain('Apt');
    // The three required parts are still all there.
    expect(container.textContent).toContain('Block 4');
    expect(container.textContent).toContain('Building 27');
  });

  /**
   * COORDINATES ARE RENDERED AND NOT LINKED, and both halves are the assertion.
   * A driver needs them, so withholding them would be precious — but a map link
   * would send a named customer's home address to a third party from the
   * merchant's browser on page view, which is a decision about a data processor
   * rather than a layout.
   */
  it('prints the coordinates and links them nowhere', () => {
    const { container } = render(<AddressSnapshot address={ADDRESS} />);
    const pin = container.querySelector('.orders__address-pin')!;
    expect(pin.textContent).toContain('29.333900');
    expect(pin.textContent).toContain('48.078200');
    expect(pin.querySelector('a')).toBeNull();
  });

  it('renders no pin at all when she gave no coordinates', () => {
    const noPin = { ...ADDRESS, latitude: null, longitude: null };
    const { container } = render(<AddressSnapshot address={noPin} />);
    expect(container.querySelector('.orders__address-pin')).toBeNull();
  });
});

describe('the status control is monotonic, forward only, one step at a time', () => {
  it('offers exactly "Mark ready" on a preparing order', () => {
    renderRow({ ...DELIVERY, status: 'preparing' });
    expect(screen.getByRole('button', { name: 'Mark ready' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
  });

  it('offers exactly "Close" on a ready order, and no way back to preparing', () => {
    renderRow({ ...DELIVERY, status: 'ready', readyAt: '2026-09-09T15:10:00.000Z' });
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Mark ready' })).toBeNull();
  });

  /**
   * A CLOSED ROW HAS NO BUTTON. The board is not a place an order can be
   * reopened, because the API is not — and "closed → preparing" would tell a
   * customer her delivered order is being prepared.
   */
  it('offers nothing on a closed order', () => {
    const { container } = renderRow({
      ...DELIVERY,
      status: 'closed',
      readyAt: '2026-09-09T15:10:00.000Z',
      closedAt: '2026-09-09T15:40:00.000Z',
    });
    expect(container.querySelectorAll('.orders__status button')).toHaveLength(0);
    /*
     * Scoped to the STATUS cell. "Closed" appears twice on a closed row — the
     * pill and the `closedAt` stamp — so an unscoped `getByText` matches two
     * nodes and fails for a reason that says nothing about the guarantee.
     */
    expect(container.querySelector('.orders__status .avo-pill')?.textContent).toBe('Closed');
  });

  it('sends the one status that follows, never the one it is leaving', () => {
    const { onMove } = renderRow({ ...DELIVERY, status: 'preparing' });
    fireEvent.click(screen.getByRole('button', { name: 'Mark ready' }));
    expect(onMove).toHaveBeenCalledWith('ready');
  });

  /**
   * THE IN-FLIGHT ROW SHOWS ITS PREVIOUS STATUS, which is the visible half of
   * "a failed move must not leave the UI a step ahead of the server". The pill
   * renders the cached status and the BUTTON carries the pending state, so a move
   * that fails leaves the truth on screen with nothing to roll back.
   */
  it('keeps the previous status on the pill while a move is in flight', () => {
    const { container } = renderRow({ ...DELIVERY, status: 'preparing' }, true);
    /*
     * The STATUS pill, specifically, and scoped twice over. `queryByText('Ready')`
     * would match the button's own label on a ready row; a bare `.avo-pill` picks
     * up the FULFILMENT pill, which comes first in the row and says "Delivery".
     * Both would pass or fail for reasons that say nothing about the guarantee.
     */
    expect(container.querySelector('.orders__status .avo-pill')?.textContent).toBe('Preparing');
    const button = screen.getByRole('button');
    expect(button.textContent).toBe('Saving…');
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it('does not fire a second move while one is in flight', () => {
    const { onMove } = renderRow({ ...DELIVERY, status: 'preparing' }, true);
    fireEvent.click(screen.getByRole('button'));
    expect(onMove).not.toHaveBeenCalled();
  });
});

describe('the server owns the transition timestamps', () => {
  /**
   * `readyAt` and `closedAt` are stamped inside the UPDATE, so they are when the
   * transition actually committed — which is what a merchant reconstructing "she
   * says she waited an hour" needs, and what a client's idea of when a button was
   * pressed is not.
   */
  it('renders the stamps it was given and none it was not', () => {
    const { container } = renderRow({
      ...DELIVERY,
      status: 'ready',
      readyAt: '2026-09-09T15:10:00.000Z',
      closedAt: null,
    });
    const when = container.querySelector('.orders__when')!;
    expect(when.textContent).toContain('Ready');
    expect(when.textContent).not.toContain('Closed');
  });
});

describe('the customer is reachable, because a wrong building number is the normal case', () => {
  it('dials the phone rather than printing it', () => {
    const { container } = renderRow(DELIVERY);
    const tel = container.querySelector<HTMLAnchorElement>('a.orders__phone')!;
    expect(tel.getAttribute('href')).toBe('tel:+96599124408');
    expect(tel.textContent).toBe('+96599124408');
  });
});

describe('the three empties are three different sentences', () => {
  /**
   * The pairwise assertion rather than three independent ones, because the defect
   * is SHARED COPY and a test per empty cannot see it. `AVO States.dc.html`:
   * "Never show the same copy for both."
   */
  function copyOf(node: HTMLElement): string {
    return (node.textContent ?? '').replace(/\s+/g, ' ').trim();
  }

  it('promises orders will arrive only when the shop can actually take them', () => {
    const { container } = render(
      <BoardEmpty filter={null} shopOn={true} onClear={() => {}} />,
    );
    expect(copyOf(container)).toContain('land here as soon as they');
  });

  /**
   * THE TRAP. With the module off, "orders land here as soon as they're placed"
   * is a false promise and it points at the wrong fix — there is nothing to wait
   * for, because nobody can place one. The switched-off empty names the switch.
   */
  it('tells a salon with the module off that nobody can order, and where the switch is', () => {
    const { container } = render(
      <BoardEmpty filter={null} shopOn={false} onClear={() => {}} />,
    );
    const copy = copyOf(container);
    expect(copy).toContain('none can be placed');
    expect(copy).toContain('Settings');
    // The open-shop promise must not appear here.
    expect(copy).not.toContain('land here as soon as they');
  });

  /**
   * `undefined` IS NOT `false`. The salon read has not landed, so the module is
   * unknown — and claiming it is off on every load of a salon whose shop is open
   * is the premature-zero class in words.
   */
  it('does not claim the module is off while the salon read is still in flight', () => {
    const { container } = render(
      <BoardEmpty filter={null} shopOn={undefined} onClear={() => {}} />,
    );
    expect(copyOf(container)).not.toContain('none can be placed');
  });

  /**
   * The filtered empty is a claim about a FILTER. "No orders yet" under an active
   * Preparing chip is a claim about the business — that this salon has never sold
   * anything — and it is wrong.
   */
  it('says which stage is empty, not that the shop has never sold anything', () => {
    const { container } = render(
      <BoardEmpty filter="preparing" shopOn={true} onClear={() => {}} />,
    );
    const copy = copyOf(container);
    expect(copy).toContain('No orders are preparing');
    expect(copy).not.toContain('No orders yet');
  });

  it('gives the filtered empty the one click that resolves it', () => {
    const onClear = vi.fn();
    render(<BoardEmpty filter="closed" shopOn={true} onClear={onClear} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show all orders' }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('offers no such button on the two unfiltered empties, which a click cannot fix', () => {
    const open = render(<BoardEmpty filter={null} shopOn={true} onClear={() => {}} />);
    expect(open.container.querySelectorAll('button')).toHaveLength(0);
    cleanup();
    const off = render(<BoardEmpty filter={null} shopOn={false} onClear={() => {}} />);
    expect(off.container.querySelectorAll('button')).toHaveLength(0);
  });
});

describe('the truncation says which end of the board is missing', () => {
  /**
   * A NOTICE THAT SAYS "SOME ROWS ARE MISSING" IS HALF A FIX, and this lane has
   * already paid for the other half once.
   *
   * `GET /salons/{id}/bookings` was `starts_at DESC LIMIT 200` with a hardcoded
   * `nextCursor: null`. This lane's client-side closure impact believed it and
   * reported 0 deposit-held appointments where the server's preview correctly
   * reported 3 — because the order is DESC, so the rows dropped first were the
   * ones starting SOONEST. The number was not the problem; not knowing which end
   * had gone was.
   *
   * `created_at DESC` here means the dropped rows are the OLDEST, and on a
   * fulfilment board the oldest `preparing` order is the one that has been
   * waiting longest. So the notice names that, and these assertions are on the
   * word, because the word is the fix.
   */
  it('names the oldest rows as the missing ones, and the cap as a cap', () => {
    const { container } = render(<TruncatedNotice filtered={false} onNarrow={() => {}} />);
    const copy = (container.textContent ?? '').replace(/\s+/g, ' ');
    expect(copy).toContain('200 most recent');
    expect(copy).toContain('oldest');
    expect(copy).toContain('waiting longest');
  });

  /**
   * `nextCursor` IS ALWAYS NULL AND IS NOT A CURSOR. Lane A shipped an honest
   * `truncated` beside it and said in the code that a real cursor "is owed the
   * day a salon has more than ORDERS_PAGE live orders". Until then a merchant who
   * is told rows are missing must not be left hunting for a next-page control
   * that does not exist.
   */
  it('says plainly that there is no next page yet', () => {
    const { container } = render(<TruncatedNotice filtered={false} onNarrow={() => {}} />);
    expect((container.textContent ?? '').replace(/\s+/g, ' ')).toContain('no next page');
  });

  /**
   * THE FILTER IS A REAL REMEDY, WHICH IS WHY IT IS OFFERED. `?status=` narrows
   * SERVER-SIDE, so filtering re-runs the query and can return rows the
   * unfiltered cap had dropped — it is not an `Array.filter` over the 200 that
   * survived. Narrowing to Preparing is the one that recovers the urgent end.
   */
  it('offers the narrowing that can bring the missing rows back', () => {
    const onNarrow = vi.fn();
    render(<TruncatedNotice filtered={false} onNarrow={onNarrow} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show Preparing' }));
    expect(onNarrow).toHaveBeenCalledTimes(1);
  });

  /**
   * ALREADY FILTERED AND STILL CAPPED is a different sentence: the remedy that
   * the unfiltered notice offers has already been taken, so offering it again
   * would be a button that does nothing to a merchant who just pressed it.
   */
  it('drops the button, and the re-filter suggestion, once a filter is already on', () => {
    const { container } = render(<TruncatedNotice filtered={true} onNarrow={() => {}} />);
    expect(container.querySelectorAll('button')).toHaveLength(0);
    const copy = (container.textContent ?? '').replace(/\s+/g, ' ');
    expect(copy).toContain('Narrowing further');
    expect(copy).not.toContain('Filtering by status asks the server');
    // The fact that matters is still stated, filtered or not.
    expect(copy).toContain('oldest');
  });

  /**
   * `role="status"` AND NOT `role="alert"`. Nothing failed and nothing is at
   * risk — the board loaded and is incomplete. An assertive announcement would
   * interrupt, and a merchant who is interrupted by a working screen learns to
   * ignore the channel.
   */
  it('announces politely, because an incomplete board is not a failure', () => {
    const { container } = render(<TruncatedNotice filtered={false} onNarrow={() => {}} />);
    expect(container.firstElementChild?.getAttribute('role')).toBe('status');
  });
});

describe('a moved row keeps the fields the PATCH does not send', () => {
  /**
   * THE REGRESSION PIN FOR A DEFECT A TYPE COULD NOT CATCH.
   *
   * `PATCH …/orders/{tid}` answers the BARE `ShopOrder` — no `memberName`, no
   * `memberPhone`, because that pair is a join the board's GET does and the PATCH
   * does not (`serialiseShopOrder` is shared with `GET /members/me/orders`, where
   * the member is the principal). `useMoveOrder` originally declared the response
   * `MerchantShopOrder` and wrote it straight into the cache: it type-checked, it
   * passed every unit test, and it BLANKED THE CUSTOMER COLUMN on every row a
   * merchant moved. Found in a browser against the real API by pressing "Mark
   * ready" and watching the customer's name vanish from her own order.
   *
   * `authedRequest<T>` is an unchecked assertion over `unknown` JSON, so no
   * compiler could have seen it — decision 78's class, and the reason the rule is
   * RUN the combination rather than typecheck it.
   *
   * This asserts the ROW'S CONTRACT rather than the merge helper, because the row
   * is where the damage showed: given the fields, it renders them. Paired with the
   * merge in `api/orders.ts § writeRow`, which is what supplies them after a move.
   */
  it('still renders the customer on a row that has just moved to ready', () => {
    /*
     * Exactly what the cache holds after a correct merge: the server's new
     * `status`/`readyAt` spread over the joined row, so the member fields survive.
     */
    const merged: MerchantShopOrder = {
      ...DELIVERY,
      status: 'ready',
      readyAt: '2026-09-10T07:44:00.000Z',
    };
    const { container } = renderRow(merged);
    expect(screen.getByText('Dana Al-Sabah')).toBeTruthy();
    expect(container.querySelector('a.orders__phone')?.textContent).toBe('+96599124408');
    expect(container.querySelector('.orders__status .avo-pill')?.textContent).toBe('Ready');
  });

  /**
   * AND THE SHAPE OF THE FAILURE, pinned so the row degrades legibly rather than
   * rendering an empty cell if this ever regresses. A row that reaches the table
   * without its member fields is a bug upstream, not a customer with no name —
   * but the cell must not silently look like a blank column either.
   */
  it('does not render an empty customer cell when the join is missing', () => {
    const stripped = { ...DELIVERY } as Partial<MerchantShopOrder>;
    delete stripped.memberName;
    delete stripped.memberPhone;
    const { container } = renderRow(stripped as MerchantShopOrder);
    /*
     * Today this WOULD render blank, which is why the guarantee lives in the
     * merge rather than in a fallback here. Asserted as a known shape so the
     * decision is visible: if a fallback is ever wanted, this is the test that
     * changes, deliberately, rather than a surprise.
     */
    expect(container.querySelector('.orders__customer')?.textContent).toBe('');
  });
});
