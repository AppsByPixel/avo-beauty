// @vitest-environment jsdom

/**
 * W7 — where she collects, on HER ORDERS list. The real `OrdersSheet`, fed
 * `ShopOrder`s shaped exactly as `serialiseShopOrder` emits them since 0060:
 * `pickupBranch: { id, name, nameAr, closed } | null`, served INLINE.
 *
 * The four answers `domain/shopOrders § pickupLocation` gives, drawn:
 *   a branch               "Collect from · Salmiya", Arabic from `nameAr`,
 *                          falling back to `name`;
 *   closed, still waiting  the branch, marked closed, AND a plain sentence
 *                          saying so — never drawn as a normal pickup;
 *   closed, collected      history: the name, marked closed, no warning;
 *   no branch (legacy)     "not recorded" — neither a branch nor "the salon".
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Language, ShopOrder } from '@avo/types';

/* eslint-disable import/first */
import { OrdersSheet } from './OrdersSheet';
import { LanguageProvider } from '../i18n/language';
import type { OrdersController } from '../state/useOrders';
import { en } from '../copy/en';
import { ar } from '../copy/ar';

const SAL = { id: 'BR-SAL', name: 'Salmiya', nameAr: 'السالمية', closed: false, businessHours: { morning: ['10:00', '13:00'] as [string, string], evening: ['16:00', '21:00'] as [string, string] }, businessHoursSource: 'salon' as const, timezone: 'Asia/Kuwait' };
/** The seed leaves SAL-LUMIERE's branches with `name_ar` NULL on purpose. */
const LUM = { id: 'BR-LUM', name: 'Lumiere Main', nameAr: null, closed: false, businessHours: { morning: ['10:00', '13:00'] as [string, string], evening: ['16:00', '21:00'] as [string, string] }, businessHoursSource: 'salon' as const, timezone: 'Asia/Kuwait' };

function order(over: Partial<ShopOrder> = {}): ShopOrder {
  return {
    transactionId: 'TX-1',
    fulfilment: 'pickup',
    status: 'preparing',
    address: null,
    pickupBranch: SAL,
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

afterEach(cleanup);

describe('a pickup names its branch, from the order’s own `pickupBranch`', () => {
  it.each([
    ['en', en, 'Salmiya'],
    ['ar', ar, 'السالمية'],
  ] as const)('%s', (lang, copy, name) => {
    sheet([order()], lang);
    const where = screen.getByTestId('order-pickup-TX-1');
    expect(where.textContent).toContain(copy.pickupFrom);
    expect(screen.getByTestId('order-branch-TX-1').textContent).toBe(name);
    expect(screen.queryByTestId('order-branch-closed-TX-1')).toBeNull();
    expect(where.textContent).not.toContain(copy.orderCollectAt);
  });

  it('Arabic falls back to `name` when the branch has no `nameAr`', () => {
    sheet([order({ pickupBranch: LUM })], 'ar');
    expect(screen.getByTestId('order-branch-TX-1').textContent).toBe('Lumiere Main');
  });
});

describe('a branch that closed while she is waiting is not a normal pickup', () => {
  it.each([
    ['en', en, 'Salmiya'],
    ['ar', ar, 'السالمية'],
  ] as const)('%s — marked closed, and told plainly', (lang, copy, name) => {
    for (const status of ['preparing', 'ready'] as const) {
      sheet([order({ status, pickupBranch: { ...SAL, closed: true } })], lang);
      expect(screen.getByTestId('order-branch-TX-1').textContent).toBe(copy.pickupClosedName(name));
      expect(screen.getByTestId('order-branch-closed-TX-1').textContent).toBe(copy.orderBranchClosed);
      cleanup();
    }
  });

  it('a COLLECTED order at a since-closed branch is history: marked closed, no warning', () => {
    sheet([order({ status: 'closed', pickupBranch: { ...SAL, closed: true } })]);
    expect(screen.getByTestId('order-branch-TX-1').textContent).toBe(en.pickupClosedName('Salmiya'));
    expect(screen.queryByTestId('order-branch-closed-TX-1')).toBeNull();
  });
});

describe('a legacy pickup with no branch is "not recorded" — not a branch, not the salon', () => {
  it.each([
    ['en', en],
    ['ar', ar],
  ] as const)('%s', (lang, copy) => {
    sheet([order({ pickupBranch: null })], lang);
    expect(screen.getByTestId('order-branch-unrecorded-TX-1').textContent).toBe(copy.orderBranchNotRecorded);
    expect(screen.queryByTestId('order-branch-TX-1')).toBeNull();
    const row = screen.getByTestId('order-row-TX-1').textContent ?? '';
    expect(row).not.toContain(copy.orderCollectAt);
    expect(row).not.toContain(copy.fulfilPickupBody);
    for (const branch of ['Salmiya', 'السالمية']) expect(row).not.toContain(branch);
  });
});

describe('a delivery draws no pickup line at all', () => {
  it('even an erased delivery (address null) is not read as a pickup', () => {
    sheet([order({ fulfilment: 'delivery', pickupBranch: null, address: null })]);
    expect(screen.queryByTestId('order-pickup-TX-1')).toBeNull();
    expect(screen.getByTestId('order-row-TX-1').textContent).not.toContain(en.orderCollectAt);
  });
});
