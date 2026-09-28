/**
 * W7 — the pickup branch's pure rules, one spec per module it touched.
 *
 *   fulfilment    what goes on the wire, what holds Pay, what survives a list
 *                 change — and that nothing is ever preselected or fallen back to;
 *   orderRefusal  the three codes, each its own kind, and before `offline`;
 *   cardCheckout  the settlement's three reasons, from the code;
 *   shopOrders    `pickupLocation`'s four answers;
 *   bell          the shop row's "where", joined from her orders, EN and AR;
 *   receipt       the invoice's "Collect from" row.
 */

import { describe, expect, it } from 'vitest';
import type { BellItem } from '../api/bell';
import { ApiError } from '../api/client';
import { en } from '../copy/en';
import { ar } from '../copy/ar';
import { bellRow } from './bell';
import { refusalReason } from './cardCheckout';
import {
  checkoutBlock,
  chosenPickupBranch,
  fulfilmentBody,
  onlyPickupBranch,
  PICKUP,
  pickupPickerApplies,
  reconcilePickupBranch,
  type FulfilmentChoice,
} from './fulfilment';
import { orderRefusal } from './orderRefusal';
import { buildReceipt } from './receipt';
import { pickupLocation } from './shopOrders';

const KWC = { id: 'BR-KWC', name: 'Kuwait City', nameAr: 'مدينة الكويت' };
const SAL = { id: 'BR-SAL', name: 'Salmiya', nameAr: 'السالمية' };
const TWO = [KWC, SAL];

const at = (pickupBranchId: string | null, mode: 'pickup' | 'delivery' = 'pickup'): FulfilmentChoice => ({
  mode,
  addressId: mode === 'delivery' ? 'ADR-1' : null,
  pickupBranchId,
});

// ═══════════════════════════════════════════════════════════════ fulfilment ══

describe('fulfilment — the body', () => {
  it('a single-branch pickup sends NOTHING, even with a stray id in state', () => {
    expect(fulfilmentBody(PICKUP, [KWC])).toEqual({});
    expect(fulfilmentBody(at('BR-KWC'), [KWC])).toEqual({});
  });

  it('a multi-branch pickup sends `pickupBranchId` — never `branchId`', () => {
    const body = fulfilmentBody(at('BR-SAL'), TWO);
    expect(body).toEqual({ pickupBranchId: 'BR-SAL' });
    expect(Object.keys(body)).toEqual(['pickupBranchId']);
  });

  it('a chosen id no longer on the list is not sent', () => {
    expect(fulfilmentBody(at('BR-GONE'), TWO)).toEqual({});
  });

  it('a delivery drops the branch, as a pickup drops the address', () => {
    expect(fulfilmentBody(at('BR-SAL', 'delivery'), TWO)).toEqual({ fulfilment: 'delivery', addressId: 'ADR-1' });
  });
});

describe('fulfilment — the block', () => {
  it('holds Pay at a multi-branch salon until she chooses', () => {
    expect(checkoutBlock(PICKUP, TWO)).toBe('noPickupBranch');
    expect(checkoutBlock(at('BR-GONE'), TWO)).toBe('noPickupBranch');
    expect(checkoutBlock(at('BR-KWC'), TWO)).toBeNull();
  });

  it('never at a single-branch salon, and never on a delivery', () => {
    expect(checkoutBlock(PICKUP, [KWC])).toBeNull();
    expect(checkoutBlock(PICKUP, [])).toBeNull();
    expect(checkoutBlock(at(null, 'delivery'), TWO)).toBeNull();
  });
});

describe('fulfilment — nothing is preselected, nothing is fallen back to', () => {
  it('PICKUP names no branch, and no helper resolves one from an empty choice', () => {
    expect(PICKUP.pickupBranchId).toBeNull();
    expect(chosenPickupBranch(PICKUP, TWO)).toBeNull();
  });

  it('only a one-branch list has a branch to name without asking', () => {
    expect(onlyPickupBranch([KWC])).toBe(KWC);
    expect(onlyPickupBranch(TWO)).toBeNull();
    expect(onlyPickupBranch([])).toBeNull();
    expect(pickupPickerApplies(TWO)).toBe(true);
    expect(pickupPickerApplies([KWC])).toBe(false);
  });

  it('a branch that closed LOSES the selection — never moves her to another', () => {
    const next = reconcilePickupBranch(at('BR-SAL'), [KWC, { id: 'BR-NEW' }]);
    expect(next.pickupBranchId).toBeNull();
  });

  it('a list that stops offering a choice drops it; an unchanged one keeps identity', () => {
    expect(reconcilePickupBranch(at('BR-KWC'), [KWC]).pickupBranchId).toBeNull();
    const kept = at('BR-SAL');
    expect(reconcilePickupBranch(kept, TWO)).toBe(kept);
    expect(reconcilePickupBranch(PICKUP, [])).toBe(PICKUP);
  });
});

// ═════════════════════════════════════════════════════════════ orderRefusal ══

describe('orderRefusal — the three pickup codes', () => {
  it.each([
    ['pickup_branch_required', 400, 'pickupRequired'],
    ['unknown_pickup_branch', 404, 'pickupUnknown'],
    ['pickup_branch_closed', 409, 'pickupClosed'],
  ] as const)('%s → %s', (code, status, kind) => {
    expect(orderRefusal(new ApiError('server', 'English.', 'R', status, code))).toEqual({ kind });
  });

  it('a coded refusal arriving as a 503 is still the code, not "offline"', () => {
    expect(orderRefusal(new ApiError('offline', 'x', 'R', 503, 'pickup_branch_closed'))).toEqual({
      kind: 'pickupClosed',
    });
  });

  it('`pickup_branch_not_for_delivery` is unreachable by construction, so it is `failed`', () => {
    expect(orderRefusal(new ApiError('server', 'x', 'R', 400, 'pickup_branch_not_for_delivery'))).toEqual({
      kind: 'failed',
    });
  });
});

describe('cardCheckout — the settlement’s branch reasons, from the code', () => {
  it.each(['pickup_branch_closed', 'pickup_branch_required', 'unknown_pickup_branch'] as const)('%s', (code) => {
    expect(refusalReason(code)).toBe(code);
    expect(en.cardOrderRefusal[code]).not.toBe(en.cardOrderRefusal.other);
    expect(ar.cardOrderRefusal[code]).not.toBe(ar.cardOrderRefusal.other);
    expect(ar.cardOrderRefusal[code]).toMatch(/[؀-ۿ]/);
  });
});

// ═══════════════════════════════════════════════════════════════ shopOrders ══

describe('pickupLocation — four answers', () => {
  const branch = { ...SAL, closed: false };
  it('a branch', () => {
    expect(pickupLocation({ fulfilment: 'pickup', status: 'ready', pickupBranch: branch })).toEqual({
      kind: 'branch',
      branch,
    });
  });
  it('closed while she waits — preparing and ready', () => {
    for (const status of ['preparing', 'ready'] as const) {
      expect(
        pickupLocation({ fulfilment: 'pickup', status, pickupBranch: { ...branch, closed: true } })?.kind,
      ).toBe('closedWaiting');
    }
  });
  it('closed after she collected — plain history', () => {
    expect(
      pickupLocation({ fulfilment: 'pickup', status: 'closed', pickupBranch: { ...branch, closed: true } })?.kind,
    ).toBe('branch');
  });
  it('a legacy pickup with no branch', () => {
    expect(pickupLocation({ fulfilment: 'pickup', status: 'ready', pickupBranch: null })).toEqual({
      kind: 'notRecorded',
    });
  });
  it('a delivery has none', () => {
    expect(pickupLocation({ fulfilment: 'delivery', status: 'ready', pickupBranch: null })).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════ bell ══

describe('the bell’s shop row says where, joined from her orders', () => {
  const SHOP: BellItem = {
    id: 'N-3',
    kind: 'shop',
    transactionId: 'TX-3',
    createdAt: '2026-09-27T10:00:00.000Z',
    readAt: null,
    amountFils: 8500,
    items: [{ name: 'Repair mask', qty: 1 }],
    fulfilment: 'pickup',
  };
  const ctx = (lang: 'en' | 'ar', orders: Parameters<typeof bellRow>[1]['orders']) => ({
    lang,
    copy: lang === 'ar' ? ar : en,
    salon: lang === 'ar' ? 'أمارا' : 'Amara',
    transactions: [],
    now: new Date('2026-09-28T12:00:00.000Z'),
    ...(orders ? { orders } : {}),
  });
  const pickup = (pickupBranch: unknown, status = 'preparing') =>
    [{ transactionId: 'TX-3', fulfilment: 'pickup', status, pickupBranch }] as never;

  it.each([
    ['en', 'Repair mask · Pickup at Salmiya'],
    ['ar', `Repair mask · ${ar.bellPickupAt('السالمية')}`],
  ] as const)('%s — the branch, Arabic from `nameAr`', (lang, line) => {
    expect(bellRow(SHOP, ctx(lang, pickup({ ...SAL, closed: false }))).lines).toEqual([line]);
  });

  it('Arabic falls back to `name`', () => {
    const row = bellRow(SHOP, ctx('ar', pickup({ id: 'BR-L', name: 'Lumiere Main', nameAr: null, closed: false })));
    expect(row.lines[0]).toContain(ar.bellPickupAt('Lumiere Main'));
  });

  it.each([
    ['en', en],
    ['ar', ar],
  ] as const)('%s — closed while she waits, and a legacy order not recorded', (lang, copy) => {
    const name = lang === 'ar' ? 'السالمية' : 'Salmiya';
    expect(bellRow(SHOP, ctx(lang, pickup({ ...SAL, closed: true }))).lines[0]).toContain(
      copy.bellPickupClosed(name),
    );
    const legacy = bellRow(SHOP, ctx(lang, pickup(null))).lines[0]!;
    expect(legacy).toContain(copy.bellPickupUnrecorded);
    expect(legacy).not.toContain(name);
  });

  it('with no order on the page, the row says Pickup and names nowhere', () => {
    expect(bellRow(SHOP, ctx('en', undefined)).lines).toEqual([`Repair mask · ${en.bellPickup}`]);
    expect(bellRow(SHOP, ctx('en', [] as never)).lines).toEqual([`Repair mask · ${en.bellPickup}`]);
  });

  it('a delivery row is untouched by an order list', () => {
    const delivery = { ...SHOP, fulfilment: 'delivery' } as BellItem;
    expect(bellRow(delivery, ctx('en', pickup({ ...SAL, closed: false }))).lines).toEqual([
      `Repair mask · ${en.bellDelivery}`,
    ]);
  });
});

// ═════════════════════════════════════════════════════════════════ receipt ══

describe('the invoice’s Collect-from row', () => {
  const TX = {
    id: 'TX-1',
    memberId: '8842',
    branchId: 'BR-SAL',
    kind: 'shop',
    amountFils: -8500,
    bonusFils: 0,
    method: 'wallet',
    status: 'settled',
    reference: 'AVO-SH-1',
    createdAt: '2026-09-28T13:20:00.000Z',
    voidedAt: null,
    reversedByTransactionId: null,
  } as const;

  it.each([
    ['en', en, 'Salmiya'],
    ['ar', ar, 'السالمية'],
  ] as const)('%s', (lang, copy, name) => {
    const r = buildReceipt(TX as never, TWO, lang, copy, { pickupBranch: { ...SAL, closed: false } });
    expect(r.rows).toContainEqual({ label: copy.pickupFrom, value: name });
  });

  it('no detail, no row — the activity feed’s receipt is unchanged', () => {
    const r = buildReceipt(TX as never, TWO, 'en', en);
    expect(r.rows.some((row) => row.label === en.pickupFrom)).toBe(false);
  });
});
