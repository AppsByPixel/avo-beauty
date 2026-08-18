/**
 * The fils ↔ decimal-KWD boundary, proved BY MAKING THE OBVIOUS VERSION FAIL.
 *
 * Every arithmetic case below is paired with the float expression a reasonable
 * person would have written instead, asserted to give the WRONG answer. That
 * pairing is the point: a test that only checks `kwdToFils('8.870') === 8870`
 * passes against `parseFloat(v) * 1000` too, so it cannot tell a correct
 * converter from one that happens to agree on the values someone thought to
 * type. Non-negotiable #1 is the reason this file is longer than the module it
 * covers.
 *
 * The literals are not invented. `8.033` is what apitest.myfatoorah.com actually
 * answered with for the 8033-fils invoice created while building the driver:
 *
 *     "InvoiceValue": 8.033, "InvoiceDisplayValue": "8.033 KD"
 *
 * and it is the amount that loses a fil the moment anything truncates it. The
 * amount was CHOSEN for that property, after enumerating which of the 45,000
 * fils values between 5 and 50 KD survive `parseFloat(s) * 1000` intact — 324 of
 * them do not.
 *
 * ONE HONEST QUALIFICATION, because the alternative is a test that overclaims.
 * `Math.round(parseFloat(s) * 1000)` is exact for every three-decimal value up
 * to ten million fils; it was checked rather than assumed. So rounding is not
 * shown failing on arithmetic, and it is not what this module is defending
 * against. What rounding cannot do is REFUSE — `Math.round(0.0001 * 1000)` is
 * `0` and `Math.round(8.8705 * 1000)` is `8871`, both silently, and both mean an
 * assumption about the amount has broken. That is the last describe block.
 */

import { describe, expect, it } from 'vitest';
import { fils } from '@avo/types';
import {
  KwdConversionError,
  filsToKwd,
  kwdToFils,
  positiveKwdToFils,
  requestBodyWithDecimal,
} from './kwd';

describe('filsToKwd', () => {
  it('always emits three decimals', () => {
    expect(filsToKwd(fils(8033))).toBe('8.033');
    expect(filsToKwd(fils(24500))).toBe('24.500');
    expect(filsToKwd(fils(1))).toBe('0.001');
    expect(filsToKwd(fils(10))).toBe('0.010');
    expect(filsToKwd(fils(100))).toBe('0.100');
    expect(filsToKwd(fils(1000))).toBe('1.000');
    expect(filsToKwd(fils(0))).toBe('0.000');
  });

  it('does not lose a fil where dividing by 1000 and formatting would', () => {
    // The naive version, and what it gets wrong. `toFixed` rounds, so it happens
    // to be right here — the failure is in `(n / 1000).toString()`, which is the
    // version that looks obviously safe because no rounding is involved.
    expect((615 / 1000).toString()).toBe('0.615');
    // ...but drop one digit and the double's shortest form is no longer three
    // decimals, so a formatter that trusts it emits a two-decimal amount.
    expect((610 / 1000).toString()).toBe('0.61');
    expect(filsToKwd(fils(610))).toBe('0.610');
  });

  it('refuses a non-integer rather than formatting it', () => {
    expect(() => filsToKwd(8.5 as unknown as ReturnType<typeof fils>)).toThrow(KwdConversionError);
  });
});

describe('kwdToFils — the case that converts wrong under floats', () => {
  it('reads 8.033 as 8033 fils, where truncating the float product gives 8032', () => {
    // THE FLOAT PATH, shown failing. Not hypothetical: this is what
    // `Math.trunc(value * 1000)` returns for the number MyFatoorah sent back for
    // the invoice this driver created.
    expect(8.033 * 1000).toBe(8032.999999999999);
    expect(Math.trunc(8.033 * 1000)).toBe(8032);
    expect(Math.floor(parseFloat('8.033') * 1000)).toBe(8032);

    // THE DIGIT PATH. One fil is one fil.
    expect(kwdToFils(8.033)).toBe(8033);
    expect(kwdToFils('8.033')).toBe(8033);
  });

  it('is exact for the other float-hostile amounts', () => {
    // Each pair: the float product's true value, then the digit parse.
    expect(1.005 * 1000).toBe(1004.9999999999999);
    expect(Math.trunc(1.005 * 1000)).toBe(1004);
    expect(kwdToFils(1.005)).toBe(1005);

    expect(16.08 * 1000).toBe(16079.999999999998);
    expect(Math.trunc(16.08 * 1000)).toBe(16079);
    expect(kwdToFils(16.08)).toBe(16080);

    expect(kwdToFils(8.87)).toBe(8870);
    expect(kwdToFils(0.615)).toBe(615);
    expect(kwdToFils(2.675)).toBe(2675);
  });

  it('round-trips every fils value in a range through both directions', () => {
    // A property rather than a sample. If either direction rounded, one of these
    // 3000 values would move.
    for (let n = 0; n <= 3000; n += 1) {
      const amount = fils(n);
      expect(kwdToFils(filsToKwd(amount))).toBe(n);
      // ...and through a JSON round trip, which is the path a real response
      // takes: the decimal string becomes a double and comes back.
      const viaJson = JSON.parse(`{"v":${filsToKwd(amount)}}`) as { v: number };
      expect(kwdToFils(viaJson.v)).toBe(n);
    }
  });

  it('accepts the shapes MyFatoorah actually uses for the same quantity', () => {
    // `InvoiceValue` is a JSON number in GetPaymentStatus...
    expect(kwdToFils(8.87)).toBe(8870);
    // ...and `Amount.ValueInBaseCurrency` is a string in the webhook payload,
    // sometimes with no decimal point at all ("1" for one dinar).
    expect(kwdToFils('1')).toBe(1000);
    expect(kwdToFils('0.003')).toBe(3);
    expect(kwdToFils('0.51')).toBe(510);
    expect(kwdToFils('.5')).toBe(500);
  });

  it('right-pads rather than left-reading a short fraction', () => {
    // The bug this catches: reading '8.8' as 8 fils of fraction instead of 800.
    expect(kwdToFils('8.8')).toBe(8800);
    expect(kwdToFils('8.08')).toBe(8080);
    expect(kwdToFils('8.008')).toBe(8008);
  });
});

describe('kwdToFils — what it refuses', () => {
  it('refuses a fourth decimal instead of rounding it away', () => {
    // THE ONE ROUNDING CANNOT DO. `Math.round` accepts both of these silently —
    // 0.0001 KD becomes zero fils and 8.8705 becomes 8871 — and either is an
    // amount nobody agreed to, arrived at by discarding evidence that the value
    // was not a base-currency KWD amount in the first place.
    expect(Math.round(0.0001 * 1000)).toBe(0);
    expect(Math.round(8.8705 * 1000)).toBe(8871);

    expect(() => kwdToFils('8.8705')).toThrow(/KWD has 3/);
    expect(() => kwdToFils(0.0001)).toThrow(/KWD has 3/);
  });

  it('refuses exponent form, which would defeat the digit parse', () => {
    expect(String(1e21)).toBe('1e+21');
    expect(() => kwdToFils(1e21)).toThrow(/exponent form/);
    expect(() => kwdToFils(1e-7)).toThrow(/exponent form/);
    expect(() => kwdToFils('1e3')).toThrow(/not a decimal amount/);
  });

  it('refuses NaN, Infinity, null, objects and money-shaped strings', () => {
    expect(() => kwdToFils(Number.NaN)).toThrow(/not a finite number/);
    expect(() => kwdToFils(Number.POSITIVE_INFINITY)).toThrow(/not a finite number/);
    expect(() => kwdToFils(null)).toThrow(/must be a number or a decimal string/);
    expect(() => kwdToFils(undefined)).toThrow(/must be a number or a decimal string/);
    expect(() => kwdToFils({ v: 1 })).toThrow(/must be a number or a decimal string/);
    // `InvoiceDisplayValue` is '8.870 KD'. Reading it as an amount would be a
    // plausible mistake, and `parseFloat` would happily return 8.87 from it.
    expect(parseFloat('8.870 KD')).toBe(8.87);
    expect(() => kwdToFils('8.870 KD')).toThrow(/not a decimal amount/);
    expect(() => kwdToFils('')).toThrow(/not a decimal amount/);
    expect(() => kwdToFils('1,000.000')).toThrow(/not a decimal amount/);
  });

  it('refuses zero and negative amounts where a payment amount is expected', () => {
    // `kwdToFils` itself is signed — a refund data model may legitimately carry
    // one — but a payment amount may not be.
    expect(kwdToFils('-1.500')).toBe(-1500);
    expect(filsToKwd(fils(-1500))).toBe('-1.500');

    expect(() => positiveKwdToFils(0)).toThrow(/greater than zero/);
    expect(() => positiveKwdToFils('-1.500')).toThrow(/greater than zero/);
    expect(positiveKwdToFils(8.87)).toBe(8870);
  });
});

describe('requestBodyWithDecimal', () => {
  it('emits the amount as an unquoted JSON number that was never a JS number', () => {
    const body = requestBodyWithDecimal(
      { PaymentMethodId: 1, DisplayCurrencyIso: 'KWD' },
      'InvoiceValue',
      filsToKwd(fils(8030)),
    );

    expect(body).toContain('"InvoiceValue":8.030');
    expect(body).not.toContain('"8.030"');
    // The trailing zero survives, which is the tell that no Number ever held it:
    // a JS number cannot carry it, so `JSON.stringify` cannot emit it.
    expect(JSON.stringify({ InvoiceValue: 8.03 })).toBe('{"InvoiceValue":8.03}');

    // And it is still valid JSON that reads back to the right money.
    const parsed = JSON.parse(body) as { InvoiceValue: number; PaymentMethodId: number };
    expect(parsed.PaymentMethodId).toBe(1);
    expect(kwdToFils(parsed.InvoiceValue)).toBe(8030);
  });

  it('refuses a decimal that is not a bare literal, so nothing can be injected', () => {
    expect(() => requestBodyWithDecimal({}, 'InvoiceValue', '8.033,"IsTest":true')).toThrow(
      /not a bare decimal literal/,
    );
    expect(() => requestBodyWithDecimal({}, 'InvoiceValue', '8.033 KD')).toThrow(
      /not a bare decimal literal/,
    );
  });

  it('refuses to splice when the placeholder is not uniquely present', () => {
    // A body that already contains the sentinel would produce malformed JSON,
    // and the processor's validation error would point at the wrong thing.
    expect(() =>
      requestBodyWithDecimal(
        { CustomerReference: '__AVO_RAW_DECIMAL_a7f3__' },
        'InvoiceValue',
        '1.000',
      ),
    ).toThrow(/placeholder appeared/);
  });
});
