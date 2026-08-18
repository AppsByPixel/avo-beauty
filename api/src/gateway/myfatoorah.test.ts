/**
 * The MyFatoorah adapter's pure halves: the status mapping, the signature
 * construction and the callback parse.
 *
 * OFFLINE AND DETERMINISTIC, deliberately. Nothing here reaches the network.
 * The live behaviour was verified by hand against apitest.myfatoorah.com and the
 * evidence is in the commit message and the lane report; what belongs in a suite
 * that gates CI is the part that must not drift, and none of it needs a
 * processor to be reachable.
 *
 * EVERY FIXTURE IS VERBATIM. The status payload is MyFatoorah's own
 * `GetPaymentStatus` example (docs .../reference/get-payment-status.md), typos
 * intact — `"TransactionStatus": "Succss"`, `"TransationValue"` — and the webhook
 * payload is their `PAYMENT_STATUS_CHANGED` sample event
 * (.../webhook-v2-payment-status-data-model.md). Paraphrasing a fixture is how a
 * suite ends up testing what someone remembered the processor sends.
 *
 * The one thing that CANNOT be tested without their portal secret is whether our
 * base64 equals theirs. What can be — and is, character for character — is the
 * ordered `key=value` string that goes into the MAC, because that is where a
 * field-order or null-rendering mistake hides, and such a mistake produces a
 * well-formed MAC that simply never matches.
 */

import { describe, expect, it } from 'vitest';
import { env } from '../env';
import {
  MYFATOORAH_SIGNATURE_HEADER,
  MyFatoorahGateway,
  outcomeFor,
  readPath,
  signatureDataFor,
  signatureFor,
} from './myfatoorah';
import { GatewayEventMalformedError, GatewayEventUnsupportedError } from './types';

// ------------------------------------------------------------- the fixtures --

/** docs.myfatoorah.com/docs/webhook-v2-payment-status-data-model.md § Sample Event */
const PAID_WEBHOOK = {
  Event: {
    Code: 1,
    Name: 'PAYMENT_STATUS_CHANGED',
    CountryIsoCode: 'KWT',
    CreationDate: '2026-01-04T08:15:00.9500000Z',
    Reference: 'WH-626519',
  },
  Data: {
    Invoice: {
      Id: '6409988',
      Status: 'PAID',
      Reference: '2026000073',
      CreationDate: '2026-01-04T08:14:49.897Z',
      ExpirationDate: '2026-01-04T10:08:36Z',
      UserDefinedField: '',
      ExternalIdentifier: 'asdqwd-f13sdf-fasjkz',
      MetaData: { UDF1: 'dsa', UDF2: '145', UDF3: '8586', UDF4: '12039', UDF5: '748gsvf' },
    },
    Transaction: {
      Id: '86781',
      Status: 'SUCCESS',
      PaymentMethod: 'VISA/MASTER',
      PaymentId: '07076409988323998875',
      ReferenceId: '600408086781',
      TrackId: '04-01-2026_3239988',
      AuthorizationId: '086781',
      TransactionDate: '2026-01-04T08:15:00.8834074Z',
      ECI: '02',
      IP: { Address: '41.40.252.158', Country: 'Egypt' },
      Error: { Code: '', Message: '' },
      Card: { Number: '512345xxxxxx0008', Brand: 'Mastercard', IssuerCountry: 'KWT' },
    },
    Customer: { Name: 'Anonymous', Mobile: '+965', Email: '' },
    Amount: {
      BaseCurrency: 'KWD',
      ValueInBaseCurrency: '1',
      ServiceCharge: '0.02',
      ServiceChargeVAT: '0.003',
      ReceivableAmount: '0.51',
      DisplayCurrency: 'KWD',
      ValueInDisplayCurrency: '1',
      PayCurrency: 'KWD',
      ValueInPayCurrency: '1',
    },
  },
};

/**
 * The unpaid `GetPaymentStatus` read this driver actually performed against
 * apitest.myfatoorah.com, pasted whole. An invoice with no transactions on it at
 * all is the shape that decides whether an empty `InvoiceTransactions` array
 * crashes the mapping — and it is also the shape that must credit nothing.
 */
const PENDING_STATUS_LIVE = {
  InvoiceId: 7085810,
  InvoiceStatus: 'Pending',
  InvoiceReference: '2026189694',
  CustomerReference: 'TI-PROBE-001',
  CreatedDate: '2026-08-18T22:47:54.317',
  ExpiryDate: 'August 21, 2026',
  ExpiryTime: '22:47:54.317',
  InvoiceValue: 8.87,
  Comments: null,
  CustomerName: 'Lane A Probe',
  CustomerMobile: '+965',
  CustomerEmail: null,
  UserDefinedField: 'TI-PROBE-001',
  InvoiceDisplayValue: '8.870 KD',
  DueDeposit: 0.0,
  DepositStatus: 'Not Deposited',
  InvoiceItems: [],
  InvoiceTransactions: [],
  Suppliers: [],
};

// ------------------------------------------------------------ the mapping ----

describe('outcomeFor — their vocabulary to ours', () => {
  it('maps a paid invoice to succeeded, in either casing', () => {
    // The read says 'Paid'; the webhook says 'PAID'. One function, so they
    // cannot disagree about what paid means.
    expect(outcomeFor('Paid', ['Succss'])).toBe('succeeded');
    expect(outcomeFor('PAID', ['SUCCESS'])).toBe('succeeded');
  });

  it('maps a cancelled invoice to cancelled, including their single-L spelling', () => {
    expect(outcomeFor('Canceled', [])).toBe('cancelled');
    expect(outcomeFor('CANCELED', ['CANCELED'])).toBe('cancelled');
    // And ours, in case they ever normalise.
    expect(outcomeFor('Cancelled', [])).toBe('cancelled');
  });

  it('accepts their documented typo AND the correct spelling', () => {
    // The day MyFatoorah fixes `Succss` must not be the day top-ups stop
    // settling. Both are asserted so the tolerance cannot be tidied away.
    expect(outcomeFor('Pending', ['Succss'])).toBe('pending');
    expect(outcomeFor('Pending', ['Success'])).toBe('pending');
    expect(outcomeFor('Pending', ['Authorize'])).toBe('pending');
    expect(outcomeFor('Pending', ['Authorise'])).toBe('pending');
  });

  it('DOES NOT report a failed transaction on an open invoice as declined', () => {
    /**
     * THE MONEY DECISION IN THIS FILE, asserted so nobody "improves" it.
     *
     * `failed` is terminal in the top-up machine and has no arrow out. A
     * declined card leaves the MyFatoorah invoice `Pending` and the customer can
     * still pay the SAME PaymentURL — so mapping this to `declined` would let her
     * complete a payment against an intent this system had already given up on,
     * and no later read could credit it. `pending` credits nothing and keeps the
     * intent in OPEN_STATUSES, so the next read settles it for real.
     */
    expect(outcomeFor('Pending', ['Failed'])).toBe('pending');
    expect(outcomeFor('Pending', ['InProgress'])).toBe('pending');
    expect(outcomeFor('Pending', ['Canceled'])).toBe('pending');
    // No attempt at all — the live fixture above.
    expect(outcomeFor('Pending', [])).toBe('pending');
  });

  it('throws rather than guessing at a status it does not know', () => {
    // MyFatoorah documents exactly three invoice statuses. A fourth means an
    // assumption broke, and `readTopUp` turns this throw into "report the intent
    // unchanged" — never a guess written into failure_reason.
    expect(() => outcomeFor('Expired', [])).toThrow(/unrecognised InvoiceStatus/);
    expect(() => outcomeFor('', [])).toThrow(/unrecognised InvoiceStatus/);
    expect(() => outcomeFor('Refunded', [])).toThrow(/unrecognised InvoiceStatus/);
  });
});

// ---------------------------------------------------------- the signature ----

describe('the signature, against their own documented strings', () => {
  it('builds the PAYMENT_STATUS_CHANGED data string character for character', () => {
    // Verbatim from .../webhook-v2-payment-status-data-model.md § Webhook Signature.
    const documented =
      'Invoice.Id=6409988,Invoice.Status=PAID,Transaction.Status=SUCCESS,' +
      'Transaction.PaymentId=07076409988323998875,' +
      'Invoice.ExternalIdentifier=asdqwd-f13sdf-fasjkz';

    // THE `Data` OBJECT, not the envelope. The documented field names are
    // relative to it, and resolving them against the envelope instead makes every
    // value empty and the MAC a CONSTANT — see the next spec but one.
    expect(
      signatureDataFor(PAID_WEBHOOK.Data, [
        'Invoice.Id',
        'Invoice.Status',
        'Transaction.Status',
        'Transaction.PaymentId',
        'Invoice.ExternalIdentifier',
      ]),
    ).toBe(documented);
  });

  it('builds the REFUND_STATUS_CHANGED data string character for character', () => {
    // Verbatim from .../webhook-v2-refund-data-model.md § Webhook Signature.
    const payload = {
      Refund: { Id: 111147, Status: 'REFUNDED' },
      Amount: { ValueInBaseCurrency: 30 },
      ReferencedInvoice: { Id: 5620277 },
    };
    expect(
      signatureDataFor(payload, [
        'Refund.Id',
        'Refund.Status',
        'Amount.ValueInBaseCurrency',
        'ReferencedInvoice.Id',
      ]),
    ).toBe('Refund.Id=111147,Refund.Status=REFUNDED,Amount.ValueInBaseCurrency=30,ReferencedInvoice.Id=5620277');
  });

  it('renders a null as an empty string, as their own example shows', () => {
    // 'CreatedDate=04032021211555,CustomerEmail=,CustomerMobile=96512345678'
    // — docs.myfatoorah.com/docs/webhook-signature.md § Null Properties.
    const payload = { CreatedDate: '04032021211555', CustomerEmail: null, CustomerMobile: '96512345678' };
    expect(signatureDataFor(payload, ['CreatedDate', 'CustomerEmail', 'CustomerMobile'])).toBe(
      'CreatedDate=04032021211555,CustomerEmail=,CustomerMobile=96512345678',
    );
    // An ABSENT field is the same absence as a null one. The failure this
    // catches is `undefined` stringifying to the four characters 'null' or
    // 'undefined', which yields a MAC that is well-formed and never matches.
    expect(signatureDataFor({}, ['CustomerEmail'])).toBe('CustomerEmail=');
  });

  it('is HMAC-SHA256 in base64, and order matters', () => {
    const secret = 'a-portal-secure-key-value';
    const fields = ['Invoice.Id', 'Invoice.Status'] as const;
    const mac = signatureFor(PAID_WEBHOOK.Data, fields, secret);

    // 32 bytes base64.
    expect(mac).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(Buffer.from(mac, 'base64')).toHaveLength(32);

    // Reversing the documented order changes the MAC. Without this assertion
    // `SIGNED_FIELDS` could be reordered and nothing would notice until a real
    // delivery.
    expect(signatureFor(PAID_WEBHOOK.Data, ['Invoice.Status', 'Invoice.Id'], secret)).not.toBe(mac);
    // A different secret changes it too, which is the only reason any of it means
    // anything.
    expect(signatureFor(PAID_WEBHOOK.Data, fields, `${secret}x`)).not.toBe(mac);
  });
});

describe('verifySignature', () => {
  const gw = new MyFatoorahGateway();
  const raw = JSON.stringify(PAID_WEBHOOK);
  const valid = signatureFor(
    PAID_WEBHOOK.Data,
    [
      'Invoice.Id',
      'Invoice.Status',
      'Transaction.Status',
      'Transaction.PaymentId',
      'Invoice.ExternalIdentifier',
    ],
    env.gatewayWebhookSecret,
  );

  it('accepts a correctly signed body', () => {
    expect(gw.verifySignature(raw, { [MYFATOORAH_SIGNATURE_HEADER]: valid })).toBe(true);
  });

  it('refuses a missing, empty, truncated or wrong signature', () => {
    expect(gw.verifySignature(raw, {})).toBe(false);
    expect(gw.verifySignature(raw, { [MYFATOORAH_SIGNATURE_HEADER]: '' })).toBe(false);
    expect(gw.verifySignature(raw, { [MYFATOORAH_SIGNATURE_HEADER]: valid.slice(0, -4) })).toBe(false);
    expect(
      gw.verifySignature(raw, {
        [MYFATOORAH_SIGNATURE_HEADER]: signatureFor(
          PAID_WEBHOOK.Data,
          ['Invoice.Id'],
          env.gatewayWebhookSecret,
        ),
      }),
    ).toBe(false);
  });

  it('refuses a body whose signed fields were tampered with', () => {
    // The point of the whole exercise: change the amount or the status and the
    // signature no longer covers the document.
    const tampered = JSON.parse(raw) as typeof PAID_WEBHOOK;
    tampered.Data.Invoice.Id = '9999999';
    expect(gw.verifySignature(JSON.stringify(tampered), { [MYFATOORAH_SIGNATURE_HEADER]: valid })).toBe(
      false,
    );
  });

  it('IS INDIFFERENT to changes outside the signed field list — including Event.Reference', () => {
    /**
     * NOT a bug in this adapter, and the reason it is asserted rather than
     * merely commented: it is a property of MyFatoorah's scheme, and the
     * dedupe design depends on knowing it.
     *
     * `Event.Reference` is our `eventId` and the key behind
     * `UNIQUE (provider, event_id)`. It is not in the signed list, so a replayed
     * callback with a fresh reference verifies happily and the unique index sees
     * no duplicate. What stops the second credit is the top-up state machine:
     * `succeeded → succeeded` is not a legal arrow. If this test ever starts
     * failing because MyFatoorah began signing `Event.Reference`, that is good
     * news and the comment in services/topup.ts can be relaxed.
     */
    const replayed = JSON.parse(raw) as typeof PAID_WEBHOOK;
    replayed.Event.Reference = 'WH-000000-forged';
    expect(gw.verifySignature(JSON.stringify(replayed), { [MYFATOORAH_SIGNATURE_HEADER]: valid })).toBe(
      true,
    );

    // Same for the amount, which is signed nowhere. The amount-mismatch check in
    // services/topup.ts is what refuses it, not the signature.
    const reamounted = JSON.parse(raw) as typeof PAID_WEBHOOK;
    reamounted.Data.Amount.ValueInBaseCurrency = '500';
    expect(
      gw.verifySignature(JSON.stringify(reamounted), { [MYFATOORAH_SIGNATURE_HEADER]: valid }),
    ).toBe(true);
  });

  it('refuses an unparseable body and an event type whose field order we do not have', () => {
    expect(gw.verifySignature('not json', { [MYFATOORAH_SIGNATURE_HEADER]: valid })).toBe(false);
    const unknown = { Event: { Name: 'SUPPLIER_UPDATE_REQUEST' }, Data: { Supplier: { Code: 1 } } };
    expect(
      gw.verifySignature(JSON.stringify(unknown), {
        [MYFATOORAH_SIGNATURE_HEADER]: signatureFor(
          unknown.Data,
          ['Supplier.Code'],
          env.gatewayWebhookSecret,
        ),
      }),
    ).toBe(false);
  });

  it('refuses a payload in which NO signed field resolves — the constant-MAC bug', () => {
    /**
     * THE REGRESSION GUARD FOR THE ONE REAL BUG THIS SUITE FOUND.
     *
     * The first version of the adapter resolved the documented paths
     * (`Invoice.Id`, `Invoice.Status`, …) against the whole envelope rather than
     * against `Data`. Every one came back `undefined`, the data string collapsed
     * to `Invoice.Id=,Invoice.Status=,…` — a CONSTANT — and the MAC therefore no
     * longer depended on the body. `verifySignature` accepted a payload with a
     * rewritten `Invoice.Id`, which is an unauthenticated credit endpoint with a
     * signature check bolted to the front of it.
     *
     * Two things stop it now: the paths resolve against `Data`, and a payload in
     * which nothing resolves is refused outright. This asserts the second, since
     * it is the one that survives someone "simplifying" the first.
     */
    const empty = { Event: { Name: 'PAYMENT_STATUS_CHANGED', Reference: 'WH-1' }, Data: {} };
    // Signed CORRECTLY for what it contains — which is nothing. Still refused.
    const macOverNothing = signatureFor(
      empty.Data,
      [
        'Invoice.Id',
        'Invoice.Status',
        'Transaction.Status',
        'Transaction.PaymentId',
        'Invoice.ExternalIdentifier',
      ],
      env.gatewayWebhookSecret,
    );
    expect(gw.verifySignature(JSON.stringify(empty), { [MYFATOORAH_SIGNATURE_HEADER]: macOverNothing })).toBe(
      false,
    );

    // And a body with no `Data` at all cannot be verified either.
    const noData = { Event: { Name: 'PAYMENT_STATUS_CHANGED', Reference: 'WH-1' } };
    expect(gw.verifySignature(JSON.stringify(noData), { [MYFATOORAH_SIGNATURE_HEADER]: macOverNothing })).toBe(
      false,
    );
  });
});

// ------------------------------------------------------------- parseEvent ----

describe('parseEvent', () => {
  const gw = new MyFatoorahGateway();

  it('normalises their paid callback into our vocabulary', () => {
    const event = gw.parseEvent(PAID_WEBHOOK);
    expect(event).toEqual({
      eventId: 'WH-626519',
      pspReference: '6409988',
      outcome: 'succeeded',
      amountFils: 1000, // ValueInBaseCurrency '1' — one dinar, not one fil.
      reportedStatus: 'PAID/SUCCESS',
    });
  });

  it('keeps both status halves in reportedStatus', () => {
    // `Invoice.Status` alone loses WHY a pending invoice is pending, which is the
    // first thing anyone reconciling asks.
    const pending = structuredClone(PAID_WEBHOOK);
    pending.Data.Invoice.Status = 'PENDING';
    pending.Data.Transaction.Status = 'FAILED';
    expect(gw.parseEvent(pending).reportedStatus).toBe('PENDING/FAILED');
    expect(gw.parseEvent(pending).outcome).toBe('pending');
  });

  it('answers unsupported — not malformed — for a refund event', () => {
    // Non-negotiable #5: refunds are wallet credit, so AVO never issues a gateway
    // refund. One arriving is a portal-side action. The route turns this into a
    // logged 200; a 400 would make the PSP retry a correct delivery for days.
    const refund = { Event: { Name: 'REFUND_STATUS_CHANGED', Reference: 'WH-1' }, Data: {} };
    expect(() => gw.parseEvent(refund)).toThrow(GatewayEventUnsupportedError);
    expect(() => gw.parseEvent(refund)).not.toThrow(GatewayEventMalformedError);
  });

  it('refuses a non-KWD base currency rather than converting one', () => {
    const foreign = structuredClone(PAID_WEBHOOK);
    foreign.Data.Amount.BaseCurrency = 'SAR';
    expect(() => gw.parseEvent(foreign)).toThrow(/not KWD/);
  });

  it('refuses a callback missing any field the credit depends on', () => {
    for (const path of [
      'Event.Reference',
      'Data.Invoice.Id',
      'Data.Invoice.Status',
      'Data.Amount.ValueInBaseCurrency',
    ]) {
      const broken = structuredClone(PAID_WEBHOOK) as unknown as Record<string, unknown>;
      const segments = path.split('.');
      let node = broken;
      for (const s of segments.slice(0, -1)) node = node[s] as Record<string, unknown>;
      delete node[segments[segments.length - 1] as string];
      expect(() => gw.parseEvent(broken), `deleting ${path} must be refused`).toThrow(
        GatewayEventMalformedError,
      );
    }
  });

  it('refuses a body that is not an object at all', () => {
    expect(() => gw.parseEvent(null)).toThrow(GatewayEventMalformedError);
    expect(() => gw.parseEvent('PAID')).toThrow(GatewayEventMalformedError);
    expect(() => gw.parseEvent(42)).toThrow(GatewayEventMalformedError);
  });
});

// --------------------------------------------------- the live pending read ----

describe('the live unpaid read', () => {
  it('maps the real apitest.myfatoorah.com Pending response to pending, not succeeded', () => {
    // This exact object came back from GetPaymentStatus for invoice 7085810.
    // An invoice with an EMPTY InvoiceTransactions array is the shape that would
    // crash a mapping that assumed a first transaction, and it is also the shape
    // that must credit nothing.
    const statuses = (PENDING_STATUS_LIVE.InvoiceTransactions as { TransactionStatus?: string }[])
      .map((t) => t.TransactionStatus)
      .filter((s): s is string => typeof s === 'string');

    expect(statuses).toEqual([]);
    expect(outcomeFor(PENDING_STATUS_LIVE.InvoiceStatus, statuses)).toBe('pending');
  });
});

describe('readPath', () => {
  it('walks a dotted path and answers undefined rather than throwing', () => {
    expect(readPath(PAID_WEBHOOK, 'Data.Transaction.PaymentId')).toBe('07076409988323998875');
    expect(readPath(PAID_WEBHOOK, 'Data.Nope.Deeper')).toBeUndefined();
    expect(readPath(null, 'a.b')).toBeUndefined();
    expect(readPath('string', 'length')).toBeUndefined();
  });
});
