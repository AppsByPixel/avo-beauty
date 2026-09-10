/**
 * The order list's spec: three statuses, six sentences, and a snapshot that is
 * not editable.
 */

import { describe, expect, it } from 'vitest';
import type { ShopOrder } from '@avo/types';
import {
  ORDER_STATUS_COUNT,
  ORDER_STATUS_FLOW,
  orderAddressIsEditable,
  orderIsOpen,
  orderStatusLabel,
  orderStatusStep,
  sortedOrders,
} from './shopOrders';
import { en } from '../copy/en';
import { ar } from '../copy/ar';

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

describe('the lifecycle is three statuses', () => {
  /**
   * NOT FOUR. `preparing → ready → closed` is the whole lifecycle in an app that
   * has served ten tenants for years. Pinned against the API's own
   * `ORDER_STATUS_FLOW` so a fourth invented here fails rather than rendering a
   * state the merchant's board has no button to produce.
   */
  it('is exactly preparing, ready, closed — in order', () => {
    expect([...ORDER_STATUS_FLOW]).toEqual(['preparing', 'ready', 'closed']);
    expect(ORDER_STATUS_COUNT).toBe(3);
  });

  it('numbers the steps 1, 2, 3 for a person rather than an index', () => {
    expect(orderStatusStep('preparing')).toBe(1);
    expect(orderStatusStep('ready')).toBe(2);
    expect(orderStatusStep('closed')).toBe(3);
  });

  it('treats only closed as finished', () => {
    expect(orderIsOpen(order({ status: 'preparing' }))).toBe(true);
    expect(orderIsOpen(order({ status: 'ready' }))).toBe(true);
    expect(orderIsOpen(order({ status: 'closed' }))).toBe(false);
  });
});

describe('orderStatusLabel — six sentences over three statuses', () => {
  /**
   * `closed` means BOTH collected and delivered, so the SENTENCE differs by
   * fulfilment while the enum does not. That is a copy decision on top of a
   * three-value enum and not a fourth value, which is the distinction this
   * describe exists to hold.
   */
  it('says collected for a closed pickup and delivered for a closed delivery', () => {
    expect(orderStatusLabel(order({ status: 'closed', fulfilment: 'pickup' }), en)).toBe(
      'Collected',
    );
    expect(orderStatusLabel(order({ status: 'closed', fulfilment: 'delivery' }), en)).toBe(
      'Delivered',
    );
  });

  it('distinguishes ready-to-collect from ready-and-on-its-way', () => {
    expect(orderStatusLabel(order({ status: 'ready', fulfilment: 'pickup' }), en)).toBe(
      'Ready to collect',
    );
    expect(orderStatusLabel(order({ status: 'ready', fulfilment: 'delivery' }), en)).toBe(
      'Ready and on its way',
    );
  });

  /** All six resolve to a non-empty string in BOTH languages — #12. */
  it('resolves all six in both languages', () => {
    for (const copy of [en, ar]) {
      for (const status of ORDER_STATUS_FLOW) {
        for (const fulfilment of ['pickup', 'delivery'] as const) {
          const label = orderStatusLabel(order({ status, fulfilment }), copy);
          expect(label.length).toBeGreaterThan(0);
        }
      }
    }
  });

  /**
   * The Arabic is WRITTEN, not lifted — the design bundle draws no delivery UI —
   * so it must not be the English string. That is the `AR_GAPS` contract: these
   * six are in `AR_UNVERIFIED`, which means they render Arabic and still need a
   * native speaker, and a key that silently fell back to English would be in the
   * wrong list.
   */
  it('renders Arabic rather than falling back to English', () => {
    for (const status of ORDER_STATUS_FLOW) {
      for (const fulfilment of ['pickup', 'delivery'] as const) {
        const subject = order({ status, fulfilment });
        expect(orderStatusLabel(subject, ar)).not.toBe(orderStatusLabel(subject, en));
      }
    }
  });
});

describe("an order's address is a snapshot", () => {
  /**
   * A NAMED FALSE, for `voidable`'s reason: a positive statement fails a review,
   * an omission passes one. The snapshot is what she typed WHEN SHE ORDERED, so
   * editing her book must not change a past order — and the UI must not present
   * it as live or editable.
   */
  it('is never editable', () => {
    expect(orderAddressIsEditable).toBe(false);
  });
});

describe('sortedOrders', () => {
  it('puts open orders before closed ones', () => {
    const list = [
      order({ transactionId: 'TX-CLOSED', status: 'closed', createdAt: '2026-09-10T12:00:00.000Z' }),
      order({ transactionId: 'TX-OPEN', status: 'preparing', createdAt: '2026-09-10T08:00:00.000Z' }),
    ];
    expect(sortedOrders(list).map((o) => o.transactionId)).toEqual(['TX-OPEN', 'TX-CLOSED']);
  });

  it('sorts newest first within each group', () => {
    const list = [
      order({ transactionId: 'A', status: 'preparing', createdAt: '2026-09-10T08:00:00.000Z' }),
      order({ transactionId: 'B', status: 'ready', createdAt: '2026-09-10T11:00:00.000Z' }),
      order({ transactionId: 'C', status: 'closed', createdAt: '2026-09-09T08:00:00.000Z' }),
      order({ transactionId: 'D', status: 'closed', createdAt: '2026-09-09T20:00:00.000Z' }),
    ];
    expect(sortedOrders(list).map((o) => o.transactionId)).toEqual(['B', 'A', 'D', 'C']);
  });

  /** `sort` mutates; this array comes from state React compares by reference. */
  it('does not mutate its input', () => {
    const list = [
      order({ transactionId: 'A', status: 'closed' }),
      order({ transactionId: 'B', status: 'preparing' }),
    ];
    sortedOrders(list);
    expect(list.map((o) => o.transactionId)).toEqual(['A', 'B']);
  });
});
