/**
 * Money. Non-negotiable #1: integer fils everywhere, no floats, ever.
 *
 *   1 KWD = 1000 fils.  "18.000 KD" is the integer 18000.
 *
 * `Fils` is a branded type, so a bare `number` will not type-check where money is
 * expected. That turns "don't use floats for money" from a code-review habit into
 * a compiler error — which is the only version of that rule that survives a
 * 30-day build.
 *
 *   const wrong: Fils = 18.5;          // ✗ compile error
 *   const right = fils(18500);         // ✓
 *   const bad   = fils(18.5);          // ✗ throws at runtime
 *
 * Formatting to 3 decimals happens ONLY at the display boundary — see
 * design/tokens/avo-tokens.json → $rules.money.
 */

declare const FilsBrand: unique symbol;

/** An integer count of fils. Never a float, never a KWD amount. */
export type Fils = number & { readonly [FilsBrand]: true };

export const FILS_PER_KWD = 1000;

/** Construct a Fils value. Throws on anything that isn't a safe integer. */
export function fils(n: number): Fils {
  if (!Number.isInteger(n)) {
    throw new TypeError(
      `Money must be an integer number of fils, got ${n}. ` +
        `Did a float or a KWD amount reach this call? 18.500 KD is fils(18500).`,
    );
  }
  if (!Number.isSafeInteger(n)) {
    throw new RangeError(`Fils value ${n} is outside the safe integer range.`);
  }
  return n as Fils;
}

/** Parse a value arriving from the wire. Rejects strings, floats and null. */
export function parseFils(value: unknown): Fils {
  if (typeof value !== 'number') {
    throw new TypeError(`Expected a number of fils, got ${typeof value}.`);
  }
  return fils(value);
}

export const ZERO = fils(0);

// ------------------------------------------------------------ arithmetic ---
// Every operation returns Fils, so an intermediate result can't silently
// decay to a plain number and pick up a fractional part.

export function add(...amounts: Fils[]): Fils {
  return fils(amounts.reduce<number>((sum, a) => sum + a, 0));
}

export function subtract(a: Fils, b: Fils): Fils {
  return fils(a - b);
}

export function negate(a: Fils): Fils {
  return fils(-a);
}

export function isNegative(a: Fils): boolean {
  return a < 0;
}

export function max(a: Fils, b: Fils): Fils {
  return a >= b ? a : b;
}

/**
 * Apply a percentage, rounding half-up to the nearest fil.
 *
 * Used for the tier bonus (a 10% bonus on a 10.000 top-up is 1.000) and for the
 * card commission (2.5%). Rounding direction is fixed here so two callers can
 * never disagree about a half-fil.
 */
export function percentOf(amount: Fils, percent: number): Fils {
  if (!Number.isFinite(percent)) throw new TypeError(`Bad percentage: ${percent}`);
  return fils(Math.round((amount * percent) / 100));
}

// ------------------------------------------------------------- commission --
// api-contract.md § Commission. Merchant-visible, customer-never.
// Configurable per platform in Owner → Controls; these are the defaults.

export interface CommissionRates {
  /** KNET: flat fee per top-up, regardless of amount. */
  knetFlatFils: number;
  /** Card / Apple Pay: percentage of the amount... */
  cardPercent: number;
  /** ...plus a flat component. */
  cardFlatFils: number;
}

export const DEFAULT_COMMISSION: CommissionRates = {
  knetFlatFils: 150,
  cardPercent: 2.5,
  cardFlatFils: 50,
};

export type PaymentMethod = 'knet' | 'card' | 'applepay';

/** AVO's cut of a top-up. Shown to the merchant, never to the customer. */
export function commissionFor(
  amount: Fils,
  method: PaymentMethod,
  rates: CommissionRates = DEFAULT_COMMISSION,
): Fils {
  if (method === 'knet') return fils(rates.knetFlatFils);
  return add(percentOf(amount, rates.cardPercent), fils(rates.cardFlatFils));
}

// --------------------------------------------------------------- display ---

/**
 * The display boundary. 3 decimals, Western digits, in BOTH languages.
 *
 * Deliberately not `Intl.NumberFormat` with an Arabic locale: that would render
 * Eastern Arabic numerals, and the brief is explicit that money stays Western
 * even in Arabic mode (AVO-Beauty-Product-Description-v2.md §4).
 */
export function formatFils(amount: Fils): string {
  const negative = amount < 0;
  const abs = Math.abs(amount);
  const whole = Math.floor(abs / FILS_PER_KWD);
  const frac = abs % FILS_PER_KWD;
  return `${negative ? '-' : ''}${whole.toLocaleString('en-US')}.${String(frac).padStart(3, '0')}`;
}

export type Language = 'en' | 'ar';

/** `18.000 KD` / `18.000 د.ك`. The amount itself is identical in both. */
export function formatMoney(amount: Fils, lang: Language = 'en'): string {
  return `${formatFils(amount)} ${lang === 'ar' ? 'د.ك' : 'KD'}`;
}

/**
 * Screen-reader label. interaction-spec.md §2: `18.000` must read as "eighteen
 * point zero zero zero Kuwaiti dinars", not "eighteen thousand".
 */
export function moneyAriaLabel(amount: Fils, lang: Language = 'en'): string {
  const kwd = formatFils(amount);
  return lang === 'ar' ? `${kwd} دينار كويتي` : `${kwd} Kuwaiti dinars`;
}

/** Parse operator input like "5" or "5.250" into fils. For admin tools only. */
export function parseKwdInput(input: string): Fils {
  const t = input.trim().replace(/,/g, '');
  if (!/^-?\d+(\.\d{1,3})?$/.test(t)) {
    throw new TypeError(`"${input}" is not a KWD amount. Use up to 3 decimals, e.g. 5.250`);
  }
  const negative = t.startsWith('-');
  const [whole = '0', frac = ''] = t.replace('-', '').split('.');
  const value = Number(whole) * FILS_PER_KWD + Number(frac.padEnd(3, '0'));
  return fils(negative ? -value : value);
}
