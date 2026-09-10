/**
 * The fork's spec: what each choice puts on the wire, and what it must not.
 *
 * Three properties matter more than the rest, and each has its own describe:
 *
 *   OMITTING `fulfilment` IS PICKUP, so the pickup body must be EMPTY — the
 *   shipped request, byte for byte.
 *   PICKUP NEVER CARRIES AN ADDRESS, even when one is selected, because
 *   `services/order.ts` refuses that by name and the database makes it
 *   unstorable.
 *   A LOST ADDRESS LOSES THE SELECTION and never falls back to another one.
 */

import { describe, expect, it } from 'vitest';
import {
  checkoutBlock,
  DEFAULT_FULFILMENT,
  fulfilmentBody,
  PICKUP,
  reconcileChoice,
} from './fulfilment';

describe('the default', () => {
  /**
   * Pickup, because it is what this app did yesterday and because a customer who
   * has never saved an address cannot be defaulted into delivery.
   */
  it('is pickup, with no address', () => {
    expect(DEFAULT_FULFILMENT).toBe('pickup');
    expect(PICKUP).toEqual({ mode: 'pickup', addressId: null });
  });
});

describe('fulfilmentBody — pickup sends nothing', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE PICKUP BODY IS EMPTY, AND THAT IS THE WHOLE POINT.
   *
   * `routes/orders.ts` reads `body.fulfilment ?? 'pickup'`, so omitting the field
   * IS pickup — and omitting it leaves the request identical to the one this app
   * sent before delivery existed. The driven, tested, shipped path is not
   * re-entered through a new branch.
   *
   * `toEqual({})` rather than checking two fields for undefined: an object with
   * NO KEYS is the claim, and `{ fulfilment: undefined }` would satisfy a
   * per-field check while making the intent unreadable at the one call site that
   * matters.
   * ═══════════════════════════════════════════════════════════════════════════
   */
  it('contributes no keys for pickup', () => {
    expect(fulfilmentBody(PICKUP)).toEqual({});
    expect(Object.keys(fulfilmentBody(PICKUP))).toEqual([]);
  });

  /**
   * PICKUP DROPS A SELECTED ADDRESS. Not defensive tidying: `services/order.ts`
   * refuses pickup-with-an-address by name (`address_not_for_pickup`) because
   * `shop_order_delivery_has_an_address` makes it unstorable. A customer who
   * chose delivery, picked an address, then switched back to pickup would
   * otherwise have her order refused for a field she cannot see.
   *
   * This is also what makes `address_not_for_pickup` unreachable, which is why
   * `orderRefusal` deliberately does not classify it.
   */
  it('drops the address on pickup even when one is selected', () => {
    const body = fulfilmentBody({ mode: 'pickup', addressId: 'ADR-1' });
    expect(body).toEqual({});
    expect('addressId' in body).toBe(false);
  });

  it('sends fulfilment and addressId for a delivery', () => {
    expect(fulfilmentBody({ mode: 'delivery', addressId: 'ADR-1' })).toEqual({
      fulfilment: 'delivery',
      addressId: 'ADR-1',
    });
  });

  /**
   * Delivery with no address is not submittable — `checkoutBlock` stops the
   * button and `useShop.checkout` re-checks it — but this stays TOTAL rather
   * than throwing, because it runs on a money path and a helper that could throw
   * would turn a blocked form into a crash.
   */
  it('omits addressId rather than throwing for a delivery with none', () => {
    expect(fulfilmentBody({ mode: 'delivery', addressId: null })).toEqual({
      fulfilment: 'delivery',
    });
  });

  /**
   * NO FEE FIELD, NO AMOUNT, NO BRANCH. Three things this body must never carry:
   * a fee (there is none anywhere in the feature), a price (`POST /orders`
   * refuses one by name), and a branch (refused by name; the server resolves it,
   * and there is no pickup-branch field in the contract at all).
   */
  it('carries no amount, no fee and no branch, on either path', () => {
    for (const body of [
      fulfilmentBody(PICKUP) as Record<string, unknown>,
      fulfilmentBody({ mode: 'delivery', addressId: 'ADR-1' }) as Record<string, unknown>,
    ]) {
      for (const forbidden of [
        'branchId',
        'deliveryFee',
        'deliveryFeeFils',
        'feeFils',
        'amountFils',
        'totalFils',
        'block',
        'street',
        'building',
        'address',
      ]) {
        expect(forbidden in body).toBe(false);
      }
    }
  });
});

describe('checkoutBlock', () => {
  it('blocks a delivery with no address chosen', () => {
    expect(checkoutBlock({ mode: 'delivery', addressId: null })).toBe('noAddress');
  });

  it('does not block a delivery with an address', () => {
    expect(checkoutBlock({ mode: 'delivery', addressId: 'ADR-1' })).toBeNull();
  });

  /** Pickup is never blocked, address or no address. */
  it('never blocks a pickup', () => {
    expect(checkoutBlock(PICKUP)).toBeNull();
    expect(checkoutBlock({ mode: 'pickup', addressId: 'ADR-1' })).toBeNull();
  });
});

describe('reconcileChoice — a lost address loses the selection', () => {
  it('keeps a selection that still exists', () => {
    const choice = { mode: 'delivery' as const, addressId: 'ADR-1' };
    expect(reconcileChoice(choice, ['ADR-1', 'ADR-2'])).toEqual(choice);
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * IT MUST NOT FALL BACK TO ANOTHER ADDRESS.
   *
   * Picking a destination for her because the one she chose disappeared is the
   * worst available behaviour on this path: she would tap Pay believing she had
   * chosen, and a bottle would go to a previous address. The selection is lost
   * instead, which lands on a state the sheet already renders and already blocks
   * on.
   *
   * Asserted with OTHER ADDRESSES PRESENT, because an empty list would pass a
   * buggy implementation that took `ids[0]`.
   * ═══════════════════════════════════════════════════════════════════════════
   */
  it('loses a deleted selection rather than choosing a different address', () => {
    const next = reconcileChoice({ mode: 'delivery', addressId: 'ADR-GONE' }, ['ADR-1', 'ADR-2']);
    expect(next.addressId).toBeNull();
    expect(next.addressId).not.toBe('ADR-1');
    expect(next.addressId).not.toBe('ADR-2');
  });

  /** The mode survives. She still wants it delivered; she just has to choose again. */
  it('keeps the delivery mode when the selection is lost', () => {
    expect(reconcileChoice({ mode: 'delivery', addressId: 'ADR-GONE' }, [])).toEqual({
      mode: 'delivery',
      addressId: null,
    });
  });

  it('leaves a null selection alone', () => {
    expect(reconcileChoice(PICKUP, [])).toEqual(PICKUP);
    expect(reconcileChoice({ mode: 'delivery', addressId: null }, ['ADR-1'])).toEqual({
      mode: 'delivery',
      addressId: null,
    });
  });

  /**
   * A pickup order's stale selection is dropped too. It cannot reach the wire —
   * `fulfilmentBody` drops it — but leaving a dead id in state would make the
   * chooser highlight a row that is no longer in the book the moment she
   * switches back to delivery.
   */
  it('drops a stale selection held behind a pickup', () => {
    expect(reconcileChoice({ mode: 'pickup', addressId: 'ADR-GONE' }, ['ADR-1'])).toEqual({
      mode: 'pickup',
      addressId: null,
    });
  });
});
