/**
 * The Account slice's copy, in both languages.
 *
 * Three things are asserted, and each of them has a failure mode that a
 * screenshot review would miss:
 *
 *   1. Arabic is present for every account key. The `Copy` interface already
 *      makes a MISSING key a compile error; what it cannot catch is a key
 *      quietly filled with `en.something` and never listed as a gap. The design
 *      bundle covers this whole screen, so the correct number of new gaps is
 *      zero and the test says so by name.
 *   2. The digit rule. Money is Western in both languages, everything else is
 *      Eastern in Arabic (see ../i18n/digits.ts). The delete sheet is the one
 *      place both appear in the same view — "٣٠ يوماً" beside "24.500 د.ك" —
 *      so it is the sharpest test of the rule there is.
 *   3. Feminine address. The customer base is women's salons; a masculine
 *      imperative is a copy defect, not a nuance.
 */

import { describe, expect, it } from 'vitest';
import { en, formatEffectiveFrom } from './en';
import { ar } from './ar';
import { hasEasternDigits, hasWesternDigits } from '../i18n/digits';
import type { Copy } from './types';

/** Every key this slice added. Kept explicit so the list is reviewable. */
const ACCOUNT_KEYS = [
  'accountTitle',
  'back',
  'acctProfile',
  'acctNotifs',
  'acctLegal',
  'acctHelp',
  'rowEdit',
  'rowName',
  'rowPhone',
  'rowEmail',
  'rowPassword',
  'rowLang',
  'rowChange',
  'rowAddEmail',
  'rowLangValue',
  'nPush',
  'nPushSub',
  'nWa',
  'nWaSub',
  'nRemind',
  'nRemindSub',
  'nReceipt',
  'nReceiptSub',
  'nOffers',
  'nOffersSub',
  'walletFine',
  'logOut',
  'deleteAcct',
  'contactCta',
  'contactCtaSub',
  'pfTitle',
  'pfSub',
  'pfPhoneNote',
  'pfSave',
  'pfSaved',
  'pfErrName',
  'pfErrPhone',
  'pfErrEmail',
  'cOptional',
  'vfTitle',
  'vfConfirm',
  'vfResend',
  'vfBack',
  'vfErr',
  'vfSent',
  'pwTitle',
  'pwSub',
  'pwCurLabel',
  'pwNewLabel',
  'pwConfLabel',
  'pwSave',
  'pwSaved',
  'pwForgot',
  'pwErrCur',
  'pwErrShort',
  'pwErrSame',
  'pwErrMatch',
  'pwShow',
  'pwHide',
  'passHint',
  'contactTitle',
  'contactSub',
  'cTopicLabel',
  'cMsgLabel',
  'cMsgPh',
  'cRefLabel',
  'cViaLabel',
  'cViaWa',
  'cViaEmail',
  'cSend',
  'cErr',
  'cRouteSalon',
  'cSentTitle',
  'cSentRef',
  'cSentDone',
  'cSentSalon',
  'cSentAvo',
  'deleteTitle',
  'deleteBody',
  'deleteBalance',
  'deleteKeep',
  'deleteGo',
  'deleteFine',
] as const satisfies readonly (keyof Copy)[];

/**
 * The account strings that are deliberately identical in both languages, and
 * why. Each is a proper noun, a Latin identifier, or a brand — not a gap.
 */
const SHARED_BY_DESIGN: Partial<Record<keyof Copy, string>> = {
  appVersion: 'a wordmark and a build number (design:475)',
  cRouteAvo: 'the AVO brand stays Latin in the Arabic build (design:1331)',
  pfEmailPh: 'a Latin email placeholder in both (design:1293)',
};

describe('account copy — Arabic is present, not borrowed', () => {
  it('adds no new AR gaps: the design bundle covers this whole screen', () => {
    const borrowed = ACCOUNT_KEYS.filter((key) => {
      const a = ar[key];
      const e = en[key];
      return typeof a === 'string' && typeof e === 'string' && a === e;
    });
    expect(borrowed).toEqual([]);
  });

  it('documents the three strings that are the same on purpose', () => {
    for (const [key, reason] of Object.entries(SHARED_BY_DESIGN)) {
      expect(reason.length, `${key} needs a reason`).toBeGreaterThan(0);
      expect(ar[key as keyof Copy]).toEqual(en[key as keyof Copy]);
    }
  });

  it('uses feminine imperatives, because the customers are women', () => {
    // design:1296 أدخلي · design:1305 استخدمي · design:1306 اختاري ·
    // design:1325 اكتبي · design:1308 أضيفي · design:1840 تابعي
    expect(ar.pfErrName).toContain('أدخلي');
    expect(ar.pwErrShort).toContain('استخدمي');
    expect(ar.pwErrSame).toContain('اختاري');
    expect(ar.contactSub).toContain('اكتبي');
    expect(ar.rowAddEmail).toContain('أضيفي');
    expect(ar.followTitle('أمارا')).toContain('تابعي');
  });
});

describe('the digit rule on the account screen', () => {
  it('uses EASTERN digits for counts in Arabic', () => {
    // "٣٠ يوماً" — a number of days.
    expect(ar.deleteBody).toContain('٣٠');
    expect(hasWesternDigits(ar.deleteBody)).toBe(false);
    // "٦ أحرف على الأقل" — a character count.
    expect(ar.passHint).toContain('٦');
    expect(hasWesternDigits(ar.passHint)).toBe(false);
    expect(hasWesternDigits(ar.pwErrShort)).toBe(false);
    // "٤ أرقام" — a code length.
    expect(hasWesternDigits(ar.vfErr)).toBe(false);
  });

  it('keeps WESTERN digits in the same strings in English', () => {
    expect(en.deleteBody).toContain('30');
    expect(hasEasternDigits(en.deleteBody)).toBe(false);
    expect(hasEasternDigits(en.passHint)).toBe(false);
  });

  it('interpolates a phone number without converting it', () => {
    // A phone number is an identifier, not a count: it stays exactly as stored.
    expect(ar.vfSub('+96599887766')).toContain('+96599887766');
    expect(en.vfSub('+96599887766')).toContain('+96599887766');
  });
});

describe('the policy stamp', () => {
  it('formats "1 July 2026 · v3" in English', () => {
    expect(en.legalUpdated('2026-07-01', 3)).toBe('Last updated 1 July 2026 · v3');
  });

  it('formats the Arabic month and Eastern digits', () => {
    expect(ar.legalUpdated('2026-07-01', 3)).toBe('آخر تحديث ١ يوليو ٢٠٢٦ · إصدار ٣');
    expect(hasWesternDigits(ar.legalUpdated('2026-07-01', 3))).toBe(false);
  });

  /**
   * The reason `effectiveFrom` is parsed as a string and not as a `Date`.
   *
   * `new Date('2026-07-01T00:00')` resolves in the device's zone, so a phone set
   * west of UTC renders the effective date of a legal document one day early.
   * This asserts the formatter is zone-independent by running it under a zone
   * that would break the naive version.
   */
  it('does not shift the date with the device timezone', () => {
    const original = process.env.TZ;
    try {
      process.env.TZ = 'Pacific/Midway'; // UTC−11
      expect(en.legalUpdated('2026-07-01', 3)).toContain('1 July 2026');
      process.env.TZ = 'Pacific/Kiritimati'; // UTC+14
      expect(en.legalUpdated('2026-07-01', 3)).toContain('1 July 2026');
    } finally {
      process.env.TZ = original;
    }
  });

  it('returns an unparseable date untouched rather than "NaN undefined NaN"', () => {
    expect(formatEffectiveFrom('soon')).toBe('soon');
    expect(formatEffectiveFrom('2026-13-01')).toBe('2026-13-01');
  });
});

describe('non-negotiable #6 — the password row never carries a password', () => {
  it('offers an action, not a value', () => {
    expect(en.rowChange).toBe('Change');
    expect(ar.rowChange).toBe('تغيير');
  });
});
