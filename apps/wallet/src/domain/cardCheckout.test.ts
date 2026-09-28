/**
 * The card rail's pure rules — `domain/cardCheckout.ts`.
 */

import { describe, expect, it } from 'vitest';
import type { OrderPaymentView } from '../api/orderPayments';
import { basketSignature, cardOutcome, keyForBasket, refusalReason } from './cardCheckout';

let n = 0;
const mint = () => `k${(n += 1)}`;

describe('keyForBasket (#4)', () => {
  const sig = basketSignature([{ productId: 'PR-01', qty: 1 }]);

  it('returns the SAME key object for a retry of the same basket', () => {
    const first = keyForBasket(null, sig, mint);
    expect(keyForBasket(first, sig, mint)).toBe(first);
    expect(keyForBasket(keyForBasket(first, sig, mint), sig, mint).key).toBe(first.key);
  });

  it('mints a new key for a different basket', () => {
    const first = keyForBasket(null, sig, mint);
    const other = keyForBasket(first, basketSignature([{ productId: 'PR-01', qty: 2 }]), mint);
    expect(other.key).not.toBe(first.key);
  });

  it('mints a new key once the attempt under it is spent', () => {
    const first = keyForBasket(null, sig, mint);
    expect(keyForBasket({ ...first, spent: true }, sig, mint).key).not.toBe(first.key);
  });

  it('the signature is productId:qty only — the method and fulfilment are not in it', () => {
    expect(basketSignature([{ productId: 'PR-01', qty: 1 }, { productId: 'PR-02', qty: 3 }])).toBe('PR-01:1,PR-02:3');
  });
});

const view = (orderStatus: string, intentStatus: string) =>
  ({ intent: { status: intentStatus }, order: { status: orderStatus } }) as unknown as OrderPaymentView;

describe('cardOutcome', () => {
  it.each([
    ['placed', 'succeeded', 'placed'],
    ['refused', 'succeeded', 'refused'],
    ['not_paid', 'failed', 'declined'],
    ['not_paid', 'cancelled', 'cancelled'],
    ['awaiting_payment', 'redirected', 'awaiting'],
    ['awaiting_payment', 'pending', 'awaiting'],
  ])('%s / %s → %s', (o, i, want) => {
    expect(cardOutcome(view(o, i))).toBe(want);
  });
});

describe('refusalReason — the code, never the message', () => {
  it.each([
    ['price_changed', 'price_changed'],
    ['shop_not_enabled', 'shop_not_enabled'],
    ['invalid_products', 'invalid_products'],
    ['unknown_address', 'unknown_address'],
    ['address_required', 'address_required'],
    ['order_failed', 'other'],
    ['address_not_for_pickup', 'other'],
    ['something_new', 'other'],
    [undefined, 'other'],
  ])('%s → %s', (code, want) => {
    expect(refusalReason(code)).toBe(want);
  });
});
