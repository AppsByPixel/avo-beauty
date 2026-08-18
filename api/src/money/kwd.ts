/**
 * The fils ↔ decimal-KWD boundary. One file, because there should be exactly
 * one place in this system where money stops being an integer.
 *
 * WHY THIS EXISTS
 * ---------------
 * Non-negotiable #1 says money is integer fils and no float touches it.
 * MyFatoorah's API does not agree: `InvoiceValue` is documented as "the amount
 * you are seeking to charge the customer and accepts decimal values (e.g.,
 * 2.500)", and `GetPaymentStatus` answers with a JSON number — a real response
 * from apitest.myfatoorah.com for an 8870-fils invoice reads
 *
 *     "InvoiceValue": 8.87,
 *
 * So the conversion cannot be avoided. It can only be confined, and this is
 * where. Everything above it speaks `Fils`; the gateway adapter is the only
 * caller.
 *
 * THE FAILURE THIS PREVENTS, CONCRETELY
 * -------------------------------------
 * The obvious implementation is `amount * 1000` in one direction and
 * `value / 1000` in the other. Both are wrong, and wrong in a way that passes
 * a casual test:
 *
 *     8.87 * 1000                    === 8869.999999999998
 *     Math.trunc(8.87 * 1000)        === 8869          <- one fil vanishes
 *     parseFloat('8.870') * 1000     === 8869.999999999998
 *     0.615 * 1000                   === 614.9999999999999
 *
 * `Math.round` papers over those three and still cannot be trusted, because
 * rounding is a decision and there is no rounding decision to make here: a KWD
 * amount with three decimals IS an exact number of fils. A converter that
 * rounds has already accepted that it might be off by one, which for money is
 * the whole question.
 *
 * So neither direction multiplies or divides. `filsToKwd` slices an integer
 * into a string, and `kwdToFils` reads decimal DIGITS and recombines them with
 * integer arithmetic. There is no floating-point operation in this file.
 *
 * THE ONE PLACE A DOUBLE IS UNAVOIDABLE, AND WHY IT IS STILL EXACT
 * ---------------------------------------------------------------
 * `JSON.parse` turns `8.87` into a double before any code here sees it. That is
 * survivable, and provably so rather than by hope: `String(n)` produces the
 * SHORTEST decimal string that round-trips to the same double (ECMA-262
 * Number::toString), and every decimal with at most three fraction digits below
 * 2^53/1000 maps to a distinct double. So for the values this boundary can
 * legitimately meet, `String(8.87)` is `'8.87'` — the literal the processor
 * sent — never `'8.869999999999999'`. `kwdToFils` therefore stringifies first
 * and parses digits, and never touches the double's value.
 *
 * The write direction does not even have that exposure: `requestBodyWithDecimal`
 * splices the decimal string into the JSON text, so an outbound `InvoiceValue`
 * is never a JS number at any point.
 *
 * MORE THAN THREE DECIMALS IS REFUSED, NOT ROUNDED. KWD has three. A fourth
 * decimal means an assumption behind this file has broken — a display-currency
 * amount read where a base-currency one was meant, most likely — and the honest
 * response is to fail where it happened rather than to quietly discard a
 * fraction of a fil and settle a top-up for the wrong number.
 */

import { fils, type Fils } from '@avo/types';

/** KWD is a three-decimal currency. Not configurable; it is a fact about KWD. */
const KWD_DECIMALS = 3;
const FILS_PER_KWD = 1000;

/**
 * A conversion that cannot be performed. Deliberately NOT an `ApiError`: this is
 * not a client's mistake to fix, and the gateway adapter turns it into a
 * `GatewayUnavailableError` so it lands as an operational fault rather than as
 * "your top-up failed".
 */
export class KwdConversionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KwdConversionError';
  }
}

/**
 * Integer fils → the decimal string a processor wants. `8870` → `'8.870'`.
 *
 * Always three decimals, always Western digits, no thousands separator. This is
 * a wire format, not a display format — `formatMoney` from `@avo/types` is the
 * display boundary and it is a different job with different rules (locale,
 * currency suffix, RTL).
 */
export function filsToKwd(amount: Fils): string {
  if (!Number.isSafeInteger(amount)) {
    throw new KwdConversionError(`fils must be a safe integer, got ${String(amount)}`);
  }
  const negative = amount < 0;
  const abs = Math.abs(amount);
  // Integer division and remainder. `Math.trunc` on a division of two safe
  // integers is exact — the quotient is representable and the fraction is
  // discarded deliberately, not rounded away.
  const whole = Math.trunc(abs / FILS_PER_KWD);
  const fraction = abs - whole * FILS_PER_KWD;
  return `${negative ? '-' : ''}${whole}.${String(fraction).padStart(KWD_DECIMALS, '0')}`;
}

/**
 * A decimal amount from a processor → integer fils. `8.87` and `'8.870'` both
 * give `8870`.
 *
 * Accepts a string or a number, because MyFatoorah uses both for the same
 * quantity: `InvoiceValue` is a JSON number in `GetPaymentStatus`, and
 * `Amount.ValueInBaseCurrency` is a string in the webhook payload.
 */
export function kwdToFils(value: unknown, field = 'amount'): Fils {
  const text = decimalText(value, field);

  const negative = text.startsWith('-');
  const unsigned = negative ? text.slice(1) : text;

  const dot = unsigned.indexOf('.');
  const wholeText = dot < 0 ? unsigned : unsigned.slice(0, dot);
  const fractionText = dot < 0 ? '' : unsigned.slice(dot + 1);

  if (fractionText.length > KWD_DECIMALS) {
    throw new KwdConversionError(
      `${field} has ${fractionText.length} decimals; KWD has ${KWD_DECIMALS}. ` +
        `Refusing to round ${text} — a fourth decimal means this is not a base-currency KWD amount.`,
    );
  }

  const whole = Number(wholeText === '' ? '0' : wholeText);
  // Right-pad so '8.8' is 800 fils of fraction rather than 8.
  const fraction = Number(fractionText.padEnd(KWD_DECIMALS, '0') || '0');

  if (!Number.isSafeInteger(whole) || !Number.isSafeInteger(fraction)) {
    throw new KwdConversionError(`${field} is out of range: ${text}`);
  }

  const total = whole * FILS_PER_KWD + fraction;
  if (!Number.isSafeInteger(total)) {
    throw new KwdConversionError(`${field} is out of range: ${text}`);
  }

  // `fils()` is the branded constructor and it throws on a non-integer. By here
  // `total` is a sum of two integer products, so it cannot be one — the call is
  // the type boundary, not the validation.
  return fils(negative ? -total : total);
}

/**
 * Normalise the input to a plain decimal string, refusing every shape that
 * would make the digit parse above a guess.
 */
function decimalText(value: unknown, field: string): string {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new KwdConversionError(`${field} is not a finite number: ${String(value)}`);
    }
    // Shortest round-tripping decimal. See the header: for a ≤3-decimal amount
    // this recovers the literal the processor sent.
    const text = String(value);
    if (/[eE]/.test(text)) {
      // 1e-7 or 1e21. Neither is a KWD amount, and both would defeat the digit
      // parse rather than merely be out of range.
      throw new KwdConversionError(`${field} is in exponent form and cannot be read as KWD: ${text}`);
    }
    return text;
  }

  if (typeof value === 'string') {
    const text = value.trim();
    if (!/^-?(\d+(\.\d+)?|\.\d+)$/.test(text)) {
      throw new KwdConversionError(`${field} is not a decimal amount: ${JSON.stringify(value)}`);
    }
    return text;
  }

  throw new KwdConversionError(
    `${field} must be a number or a decimal string, got ${value === null ? 'null' : typeof value}`,
  );
}

/**
 * A positive KWD amount, which is what every payment field this boundary reads
 * has to be. A processor reporting a zero or negative invoice value is an
 * incident, not a settlement.
 */
export function positiveKwdToFils(value: unknown, field = 'amount'): Fils {
  const amount = kwdToFils(value, field);
  if (amount <= 0) {
    throw new KwdConversionError(`${field} must be greater than zero, got ${String(value)}`);
  }
  return amount;
}

/**
 * Serialise a request body with ONE field carried as a raw JSON number that was
 * never a JS number.
 *
 * `JSON.stringify` has no way to emit an unquoted decimal from a string, and
 * `Number('8.870')` would put a double back in the path this whole file exists
 * to keep it out of. So the field is stringified as a sentinel STRING and the
 * quoted sentinel is replaced by the decimal text — which is a splice into JSON
 * that has already been generated, not string-concatenated JSON.
 *
 * The sentinel is asserted to appear exactly once. Without that check a body
 * whose other fields happened to contain the sentinel text would emit malformed
 * JSON, and the failure would surface as a processor validation error rather
 * than as the bug it is.
 */
export function requestBodyWithDecimal(
  body: Record<string, unknown>,
  field: string,
  decimal: string,
): string {
  const SENTINEL = '__AVO_RAW_DECIMAL_a7f3__';
  const quoted = `"${SENTINEL}"`;

  const text = JSON.stringify({ ...body, [field]: SENTINEL });
  const first = text.indexOf(quoted);
  if (first < 0 || text.indexOf(quoted, first + 1) >= 0) {
    throw new KwdConversionError(
      `could not splice ${field} into the request body: the placeholder appeared ${
        first < 0 ? 0 : 2
      } times`,
    );
  }
  if (!/^-?\d+(\.\d+)?$/.test(decimal)) {
    // Anything else would inject non-JSON into a body we are about to sign our
    // name to.
    throw new KwdConversionError(`${field} is not a bare decimal literal: ${JSON.stringify(decimal)}`);
  }

  return text.slice(0, first) + decimal + text.slice(first + quoted.length);
}
