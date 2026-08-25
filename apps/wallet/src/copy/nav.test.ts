/**
 * The bottom navigation's four labels — design:1233 (en) and design:1340 (ar).
 *
 * This file exists because of how the fourth one went missing. Both copy modules
 * cite the SAME design line for the nav block — `// design:1233`, `// design:1340`
 * — and that line defines four keys:
 *
 *     navHome: 'Home', navBook: 'Book', navShop: 'Shop', navPay: 'Pay',
 *
 * Three were ported. The citation was accurate about where the strings came from
 * and silent about the one that did not come, so nothing downstream could notice:
 * `Copy` type-checked, the AR-gap ledger balanced, and the nav rendered three
 * buttons for months. A cited line is not a covered line, and the only way to
 * make the difference visible is to assert the design's whole set.
 *
 * The digit rule does not apply here — none of the four is a number. What does
 * apply is non-negotiable #12: two of the four are IMPERATIVES addressed to the
 * customer, and the customers are women.
 */

import { describe, expect, it } from 'vitest';
import { en } from './en';
import { ar } from './ar';
import type { Copy } from './types';

/** design:1233 / design:1340, in the order the design writes them. */
const NAV_KEYS = ['navHome', 'navBook', 'navShop', 'navPay'] as const satisfies
  readonly (keyof Copy)[];

describe('the bottom nav has all four of the design\'s labels', () => {
  it('carries the English verbatim from design:1233', () => {
    expect(NAV_KEYS.map((k) => en[k])).toEqual(['Home', 'Book', 'Shop', 'Pay']);
  });

  it('carries the Arabic verbatim from design:1340', () => {
    expect(NAV_KEYS.map((k) => ar[k])).toEqual(['الرئيسية', 'احجزي', 'المتجر', 'ادفعي']);
  });

  it('borrows no English: the design bundle covers every one of them', () => {
    const borrowed = NAV_KEYS.filter((k) => ar[k] === en[k]);
    expect(borrowed).toEqual([]);
  });

  it('gives each destination its own word, in both languages', () => {
    // A copy-paste in a four-item list is invisible in review and obvious on a
    // phone. Cheap to assert, and it is how a fourth label most easily goes
    // wrong now that there is a fourth label.
    expect(new Set(NAV_KEYS.map((k) => en[k])).size).toBe(NAV_KEYS.length);
    expect(new Set(NAV_KEYS.map((k) => ar[k])).size).toBe(NAV_KEYS.length);
  });
});

describe('the Arabic nav addresses a woman', () => {
  /**
   * Book and Pay are imperatives; Home and Shop are nouns and take no form.
   *
   * The masculine imperatives are `احجز` and `ادفع` — the feminine adds ي. That
   * is one character, it is the character a translation pass drops, and
   * non-negotiable #12 calls dropping it a defect rather than a nuance.
   */
  it('uses the feminine imperative for the two verbs', () => {
    expect(ar.navBook).toBe('احجزي');
    expect(ar.navPay).toBe('ادفعي');
  });

  it('is not the masculine form', () => {
    expect(ar.navBook).not.toBe('احجز');
    expect(ar.navPay).not.toBe('ادفع');
    // Stated as the rule rather than as two literals, so a future fifth verb
    // cannot slip in unmarked: an Arabic imperative aimed at this customer ends
    // in ي.
    for (const verb of [ar.navBook, ar.navPay]) {
      expect(verb.endsWith('ي'), `${verb} is not a feminine imperative`).toBe(true);
    }
  });

  it('keeps the two nouns as the design wrote them', () => {
    expect(ar.navHome).toBe('الرئيسية');
    expect(ar.navShop).toBe('المتجر');
  });
});
