/**
 * What a receipt says, and — more of these than usual — what it does not.
 *
 * The composer is pure, so every case here is a table row rather than a fixture.
 * The three that matter most are the NEGATIVE ones: `feeFils` and
 * `transaction.note` must never reach a customer (`db/schema/transaction.ts`,
 * DECISIONS.md 107), and a payload written by an older shape of
 * `ReceiptPayload` must produce a truthful receipt rather than an exception —
 * because throwing turns a real charge into a permanent failure and the money
 * already moved.
 */

import { describe, expect, it } from 'vitest';
import { composeReceiptEmail } from './compose';
import type { ReceiptAddressing } from '../types';

const ADDRESSING: ReceiptAddressing = {
  recipient: { name: 'Dana A.', email: 'dana@example.com', emailVerified: true },
  salon: { id: 'SAL-AMARA', name: 'Amara' },
};

function compose(payload: Record<string, unknown>, transactionId = 'TRX-24817') {
  return composeReceiptEmail({ ...ADDRESSING, transactionId, payload });
}

const CHARGE = {
  kind: 'charge',
  transactionId: 'TRX-24817',
  amountFils: 34_500,
  balanceAfterFils: 18_250,
  services: [
    { id: 'SRV-1', name: 'Cut & blow-dry', priceFils: 22_000 },
    { id: 'SRV-2', name: 'Olaplex No.4 shampoo', priceFils: 12_500 },
  ],
};

describe('the subject and the sender identity', () => {
  it('is the design file’s own <title>, with the salon in it and not AVO', () => {
    const { subject } = compose(CHARGE);
    expect(subject).toBe('Your receipt from Amara');
    /**
     * whatsapp-templates.md § Rules that apply to all four: "The salon name, not
     * 'AVO', is the sender identity. AVO is invisible to the customer."
     */
    expect(subject).not.toContain('AVO');
  });

  it('names AVO exactly once in the body, in the line the design itself writes', () => {
    const { text } = compose(CHARGE);
    expect(text.match(/AVO/g)).toHaveLength(1);
    expect(text).toContain('Sent by AVO Beauty Technologies on behalf of Amara.');
  });
});

describe('money', () => {
  it('is three decimals with Western digits and KD, from @avo/types', () => {
    const { text } = compose(CHARGE);
    expect(text).toContain('Paid from your wallet: 34.500 KD');
    expect(text).toContain('Wallet balance');
    expect(text).toContain('18.250 KD');
  });

  it('itemises each service against its own price', () => {
    const { text } = compose(CHARGE);
    expect(text).toContain('Cut & blow-dry');
    expect(text).toContain('22.000 KD');
    expect(text).toContain('Olaplex No.4 shampoo');
    expect(text).toContain('12.500 KD');
  });

  /**
   * Non-negotiable #1, enforced at the LAST boundary rather than only the first.
   * `fils()` refuses a non-integer; the composer drops the line instead of
   * printing a figure nobody can reconcile against the ledger.
   */
  it('drops a money field that is not an integer number of fils rather than rendering it', () => {
    const { text } = compose({ ...CHARGE, amountFils: 34.5 });
    expect(text).not.toContain('34.5');
    expect(text).toContain('Paid from your wallet');
    /** The rest of the receipt still renders — one bad field is not a bad receipt. */
    expect(text).toContain('18.250 KD');
  });
});

describe('what a receipt must never carry', () => {
  /**
   * `feeFils` is "merchant-visible, customer-never" on its own column. It is not
   * in `ReceiptPayload`, so this asserts the composer does not helpfully render
   * a key it finds anyway — which is exactly what a `Record<string, unknown>`
   * makes possible.
   */
  it('ignores feeFils even when the row carries one', () => {
    const { text } = compose({ ...CHARGE, feeFils: 150 });
    expect(text).not.toContain('0.150');
    expect(text).not.toMatch(/fee/i);
  });

  /**
   * DECISIONS.md 107. One column carries void reasons, "Deposit larger than the
   * visit", "No-show · deposit returned automatically" and an owner's free-text
   * adjustment reason, and the decision's own words are that declaring it on the
   * customer's type would put every one of those "one careless serialiser away
   * from her own activity list". A receipt is that second serialiser.
   */
  it('ignores a bare note even when the row carries one', () => {
    const { text } = compose({ ...CHARGE, note: 'Voided — staff rang it twice' });
    expect(text).not.toContain('Voided');
    expect(text).not.toContain('rang it twice');
  });

  /**
   * AND THE ONE EXCEPTION, which 107 decides rather than this file: the note of
   * a TYPED price is customer-visible on purpose, "a charge whose price a staff
   * member invented is precisely the charge a customer has cause to query". It
   * arrives through `custom`, not through `note`, so the type is the boundary.
   */
  it('does carry a typed price’s reason, because that is the one note she is owed', () => {
    const { text } = compose({
      kind: 'charge',
      transactionId: 'TRX-9',
      amountFils: 25_000,
      balanceAfterFils: 1_000,
      services: [],
      custom: { reason: 'Bridal trial, agreed at the counter' },
      note: 'Bridal trial, agreed at the counter',
    });
    expect(text).toContain('"Bridal trial, agreed at the counter"');
    expect(text).toContain('25.000 KD');
  });
});

describe('the copy that is verbatim from design/AVO Receipt Email.html', () => {
  it('carries the dispute paragraph with this transaction’s own reference', () => {
    const { text } = compose(CHARGE);
    expect(text).toContain(
      'Wrong amount? Salon staff can reverse a charge for 15 minutes, and the salon ' +
        'can reimburse you from their dashboard after that. Refunds are returned as ' +
        'wallet credit. Queries within 30 days, please — quote TRX-24817.',
    );
  });

  it('carries the wallet-credit disclosure and the account-record sentence', () => {
    const { text } = compose(CHARGE);
    expect(text).toContain(
      'Wallet credit is not a bank deposit and is not covered by deposit insurance.',
    );
    expect(text).toContain(
      'Card and KNET payments are processed by a payment provider licensed by the ' +
        'Central Bank of Kuwait.',
    );
    expect(text).toContain(
      'Receipts are sent for every transaction and are part of your account record.',
    );
  });

  /** Non-negotiable #5, and it is in the customer-facing copy rather than only the code. */
  it('says refunds are wallet credit', () => {
    expect(compose(CHARGE).text).toContain('Refunds are returned as wallet credit');
  });
});

describe('every other payload kind', () => {
  it('a shop order itemises quantity, unit price and line total', () => {
    const { text } = compose({
      kind: 'shop',
      transactionId: 'TRX-7',
      amountFils: 29_000,
      balanceAfterFils: 5_000,
      fulfilment: 'delivery',
      items: [
        { productId: 'P1', name: 'Olaplex No.4', qty: 2, unitPriceFils: 14_500, lineTotalFils: 29_000 },
      ],
    });
    expect(text).toContain('Olaplex No.4');
    expect(text).toContain('2 x 14.500 KD');
    expect(text).toContain('29.000 KD');
  });

  it('a deposit hold names the service, the artist and the slot', () => {
    const { text } = compose({
      kind: 'deposit_hold',
      transactionId: 'TRX-8',
      amountFils: 5_000,
      balanceAfterFils: 19_500,
      bookingId: 'BKG-1',
      artistName: 'Hessa M.',
      serviceName: 'Cut & blow-dry',
      startsAt: '2026-08-04T11:38:00.000Z',
    });
    expect(text).toContain('Cut & blow-dry with Hessa M.');
    expect(text).toContain('Deposit held');
    expect(text).toContain('5.000 KD');
  });

  it('a returned deposit distinguishes a cancellation from a no-show', () => {
    const base = {
      kind: 'deposit_return',
      transactionId: 'TRX-9',
      amountFils: 5_000,
      balanceAfterFils: 24_500,
      bookingId: 'BKG-1',
    };
    expect(compose({ ...base, reason: 'no_show' }).text).toContain('Deposit returned\n');
    expect(compose({ ...base, reason: 'cancelled' }).text).toContain(
      'Deposit returned after cancellation',
    );
  });

  it('a top-up shows the bonus as its own line, because it is not what she paid', () => {
    const { text } = compose({
      kind: 'topup',
      transactionId: 'TRX-10',
      amountFils: 10_000,
      balanceAfterFils: 36_000,
      intentId: 'TOP-1',
      bonusFils: 1_000,
      creditFils: 11_000,
      method: 'knet',
      reference: 'REF-1',
    });
    expect(text).toContain('Added to your wallet: 10.000 KD');
    expect(text).toContain('Bonus credit');
    expect(text).toContain('1.000 KD');
    expect(text).toContain('Credited to your wallet');
    expect(text).toContain('11.000 KD');
  });

  it('omits a zero bonus rather than printing 0.000 KD at her', () => {
    const { text } = compose({
      kind: 'topup',
      transactionId: 'TRX-11',
      amountFils: 10_000,
      balanceAfterFils: 35_000,
      bonusFils: 0,
      creditFils: 10_000,
    });
    expect(text).not.toContain('Bonus credit');
  });
});

describe('a payload this composer does not recognise', () => {
  /**
   * A parked job sits a century out (`PARK_MS`), so a row read here may have been
   * written by a shape of `ReceiptPayload` that no longer exists. The money moved
   * either way, so the receipt degrades to the amount, the balance and the
   * reference rather than throwing — which would park the row and write a `risk`
   * audit for a receipt that could perfectly well have been sent.
   */
  it('still produces a truthful receipt instead of throwing', () => {
    const { subject, text } = compose({
      kind: 'some_future_kind',
      amountFils: 7_000,
      balanceAfterFils: 1_500,
    });
    expect(subject).toBe('Your receipt from Amara');
    expect(text).toContain('7.000 KD');
    expect(text).toContain('1.500 KD');
    expect(text).toContain('TRX-24817');
  });

  it('survives an entirely empty payload', () => {
    expect(() => compose({})).not.toThrow();
    expect(compose({}).text).toContain('Amara — receipt');
  });
});
