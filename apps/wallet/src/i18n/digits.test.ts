/**
 * The digit rule, tested from both sides.
 *
 * A test that only checks `toEasternDigits(6) === '٦'` proves nothing useful —
 * the bug this rule exists to prevent is not "the converter is broken", it is
 * "somebody converted the wrong thing, or forgot to convert the right thing".
 * So the interesting assertions are the two policy ones at the bottom:
 *
 *   · every Arabic copy string that takes a number comes back with no Western
 *     digit in it, and
 *   · money comes back with no Eastern digit in it, in either language.
 *
 * Between them those two cover both ways of getting non-negotiable #12 wrong.
 */

import { describe, expect, it } from 'vitest';
import { fils, formatFils, formatMoney, moneyAriaLabel } from '@avo/types';
import { ARABIC_PERCENT, hasEasternDigits, hasWesternDigits, toEasternDigits } from './digits';
import { en } from '../copy/en';
import { ar, AR_GAPS } from '../copy/ar';
import type { Copy } from '../copy/types';
import { clockTime, dateLocale } from '../domain/activity';

describe('toEasternDigits', () => {
  it('maps every Western digit to its Eastern Arabic-Indic counterpart', () => {
    expect(toEasternDigits('0123456789')).toBe('٠١٢٣٤٥٦٧٨٩');
  });

  it('accepts a number as well as a string', () => {
    expect(toEasternDigits(6)).toBe('٦');
    expect(toEasternDigits(30)).toBe('٣٠');
  });

  it('leaves everything that is not a digit alone', () => {
    // A formatted clock time: the colon and the meridiem survive.
    expect(toEasternDigits('4:30 م')).toBe('٤:٣٠ م');
    expect(toEasternDigits('زيارات')).toBe('زيارات');
  });

  it('reproduces the strings the design writes', () => {
    // design/AVO Wallet Home.dc.html:1276
    expect(`${toEasternDigits(6)} زيارات للذهبية`).toBe('٦ زيارات للذهبية');
    // design:1281 — note the Arabic percent sign, not %
    expect(`فضية · مكافأة +${toEasternDigits(10)}${ARABIC_PERCENT}`).toBe(
      'فضية · مكافأة +١٠٪',
    );
  });
});

describe('the money exception', () => {
  const amount = fils(24500);

  it('formats money in Western digits in BOTH languages', () => {
    expect(formatMoney(amount, 'en')).toBe('24.500 KD');
    expect(formatMoney(amount, 'ar')).toBe('24.500 د.ك');
  });

  it('never lets an Eastern digit into a money string', () => {
    for (const lang of ['en', 'ar'] as const) {
      expect(hasEasternDigits(formatMoney(amount, lang))).toBe(false);
      expect(hasEasternDigits(moneyAriaLabel(amount, lang))).toBe(false);
    }
    expect(hasEasternDigits(formatFils(amount))).toBe(false);
  });

  it('would corrupt a money string if it were ever applied — which is the point', () => {
    // Documented as a test rather than a comment so the wrong output is on
    // record next to the right one. `24.500 د.ك` must never look like this.
    expect(toEasternDigits(formatMoney(amount, 'ar'))).toBe('٢٤.٥٠٠ د.ك');
  });
});

describe('dates and times are Eastern in Arabic', () => {
  // 2026-07-12T13:30:00Z is 16:30 in Kuwait (UTC+3).
  const at = Date.parse('2026-07-12T13:30:00Z');

  /**
   * The trap this test exists for: plain `'ar'` gives WESTERN digits in modern
   * CLDR, so `Intl.DateTimeFormat('ar', …)` returns "16:30" and the bug is
   * invisible to anyone reading the Arabic month name and assuming the rest
   * followed. The numbering system has to be requested explicitly.
   */
  it('asks for the arab numbering system explicitly', () => {
    expect(dateLocale('ar')).toBe('ar-u-nu-arab');
    expect(new Intl.DateTimeFormat('ar', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kuwait' }).format(at)).toBe('16:30');
  });

  it('formats the stale banner clock in Eastern digits', () => {
    expect(clockTime(at, 'en')).toBe('16:30');
    expect(clockTime(at, 'ar')).toBe('١٦:٣٠');
  });

  it('matches the design, which writes ٤:٣٠ م', () => {
    const time = new Intl.DateTimeFormat(dateLocale('ar'), {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZone: 'Asia/Kuwait',
    }).format(at);
    expect(time).toBe('٤:٣٠ م'); // design/AVO Wallet Home.dc.html:1286
  });
});

// ---------------------------------------------------------------- policy ----

/**
 * The sample money string, as `formatMoney` would hand it over.
 *
 * Western digits, three decimals, and the unit attached — which is the whole
 * point: the copy modules never format an amount, they interpolate one that has
 * already been formatted, so the unit changes with the language without a single
 * `kd: 'KD'` constant existing anywhere. The Arabic sample would be
 * "5.000 د.ك"; the digits are identical either way, which is what
 * MONEY_ARG_KEYS below asserts is allowed.
 */
const MONEY_SAMPLE = '5.000 KD';

/**
 * Sample arguments for every copy entry that is a function. Numbers are chosen
 * multi-digit where possible so a partial conversion is visible.
 */
const CALLS: Partial<Record<keyof Copy, unknown[]>> = {
  greeting: ['دانة'],
  tierHint: [6, 'gold'],
  stampsHint: [3, 8],
  stampsPill: [3, 8],
  tierLadder: ['silver', 'gold'],
  qrAria: ['AVO-1204', 45],
  visitsMultiplier: [2],
  stampsMultiplier: [2],
  topupBoost: [30],
  tierBonusBadge: ['silver', 10],
  tierBonusExplain: ['silver', 10],
  stampsBadge: [8],
  bonusRow: ['silver'],
  payRedirectTitle: ['كي نت'],
  // The server's `graceDays`. Two digits so a partial conversion is visible.
  deletePendingBody: [30],
  // `lastUpdated` takes an already-formatted relative string built from
  // `minutesAgo`/`hoursAgo`, which are themselves in this table — so the sample
  // here carries no digits of its own. `staleBanner` takes the raw epoch and
  // formats it itself; see the no-mixed-script test below for why.
  lastUpdated: ['—'],
  staleBanner: [Date.parse('2026-07-12T13:30:00Z')],
  minutesAgo: [14],
  hoursAgo: [3],
  daysAgo: [2],
  txTierBonus: ['silver'],
  plus: ['x'],
  minus: ['x'],
  // --- account ---
  followTitle: ['أمارا'],
  // The policy stamp. The raw "YYYY-MM-DD" and the version go in and each
  // language formats its own — the same rule as `staleBanner`, and for the same
  // reason: a date and a version are counts, so Arabic renders them Eastern.
  legalUpdated: ['2026-07-01', 3],
  vfSub: ['+96599887766'],
  // --- book ---
  // A step counter and a total: counts, so Eastern in Arabic.
  bookStep: [2, 4],
  // An artist's name, already resolved to the reading language by
  // domain/booking.ts § artistName.
  upWith: ['رنا'],
  // Everything below is handed an ALREADY-FORMATTED money string. See
  // MONEY_ARG_KEYS.
  depositNote: [MONEY_SAMPLE],
  bookConfirmCta: [MONEY_SAMPLE],
  bookedToast: [MONEY_SAMPLE],
  cancelledToast: [MONEY_SAMPLE],
  bookShortBy: [MONEY_SAMPLE],
  upDeposit: [MONEY_SAMPLE],
};

/**
 * Keys whose rendered string legitimately carries Western digits in Arabic,
 * because what is interpolated is an IDENTIFIER and not a count.
 *
 * `vfSub` is "أدخلي الرمز المكوّن من ٤ أرقام الذي أرسلناه إلى +96599887766" —
 * the code length is Eastern, as the rule requires, and the phone number is
 * left exactly as stored. Converting it would produce a number the customer
 * cannot compare against the one on her SIM, and the design does the same
 * (design:1842 interpolates `s.pfPhone` untouched). `qrAria` is the same shape:
 * a member id inside a spoken sentence.
 *
 * `appVersion` is the same category without an interpolation: "AVO Beauty ·
 * v1.0" is a build number. "v١٫٠" is not a version anyone can quote to support.
 *
 * This is a third category alongside "money is Western" and "counts are
 * Eastern", and it is narrow on purpose: only strings carrying a value the
 * customer, the server or the release owns — never a number this app computed.
 */
const IDENTIFIER_KEYS = new Set(['vfSub', 'qrAria', 'appVersion']);

/**
 * Arabic strings that carry Western digits because what is interpolated is
 * MONEY — the fourth category, and the one the Book flow introduced.
 *
 * Until booking, no copy string took an amount: the wallet card, the top-up
 * calculation and every receipt row rendered money through `<Money>`, as its own
 * node, so no sentence had a figure inside it. The design's booking copy does
 * have them — `تأكيد · حجز 5.000 د.ك` (design:1553), `عربون 5.000 د.ك`
 * (design:1286), `أُعيد العربون 5.000 د.ك` (design:1774) — and every one is
 * written with WESTERN digits in the designer's own Arabic. That is
 * non-negotiable #12 working exactly as specified, not an exception to it.
 *
 * What keeps this narrow rather than a hole: each of these keys takes ONE
 * argument, that argument is always `formatMoney`'s output, and the surrounding
 * sentence has no other number in it. A key that mixed a count and an amount
 * would fail the mixed-script test below, which is not exempted here.
 */
const MONEY_ARG_KEYS = new Set([
  'depositNote',
  'bookConfirmCta',
  'bookedToast',
  'cancelledToast',
  'bookShortBy',
  'upDeposit',
]);

/** Flatten a copy object to `[dottedKey, renderedString]` pairs. */
function render(copy: Copy): [string, string][] {
  const out: [string, string][] = [];
  for (const [key, value] of Object.entries(copy)) {
    if (typeof value === 'string') {
      out.push([key, value]);
    } else if (typeof value === 'function') {
      const args = CALLS[key as keyof Copy];
      if (!args) throw new Error(`copy.${key} is a function with no sample args in CALLS`);
      out.push([key, (value as (...a: unknown[]) => string)(...args)]);
    } else if (value && typeof value === 'object') {
      for (const [sub, subValue] of Object.entries(value as Record<string, string>)) {
        out.push([`${key}.${sub}`, subValue]);
      }
    }
  }
  return out;
}

const GAPS = new Set<string>(AR_GAPS);

describe('Arabic copy obeys the digit rule', () => {
  it('has no Western digit in any translated string', () => {
    const offenders = render(ar)
      .filter(([key]) => !GAPS.has(key) && !IDENTIFIER_KEYS.has(key) && !MONEY_ARG_KEYS.has(key))
      .filter(([, value]) => hasWesternDigits(value));
    // The gaps are English and are allowed Western digits; nothing else is,
    // except the identifier keys and the money keys above.
    expect(offenders).toEqual([]);
  });

  it('uses the Arabic percent sign rather than %', () => {
    const offenders = render(ar)
      .filter(([key]) => !GAPS.has(key))
      .filter(([, value]) => value.includes('%'));
    expect(offenders).toEqual([]);
  });
});

/**
 * The regression this file exists for second.
 *
 * The stale banner used to be handed a clock string formatted with the APP's
 * language while the sentence around it came from AR_GAPS and was still English.
 * The result on screen was:
 *
 *     Showing your wallet from ٢٣:٤٩ — refresh failed
 *
 * Eastern digits inside an English sentence. Half-translated is worse than
 * either half: it reads as a bug to an English reader and as a bug to an Arabic
 * one. The fix was to give the copy string the raw epoch and let it format its
 * own digits, so the script always follows the sentence.
 *
 * This generalises, which is why it is asserted over the whole copy set rather
 * than over one key: no rendered string may mix the two scripts. Money is the
 * one legitimate mix (Western digits beside Arabic text) and it never comes
 * through the copy modules, so there is nothing to exempt.
 */
describe('no rendered string mixes the two digit scripts', () => {
  for (const [name, copy] of [['en', en], ['ar', ar]] as const) {
    it(`${name} copy is internally consistent`, () => {
      const mixed = render(copy)
        .filter(([key]) => !IDENTIFIER_KEYS.has(key))
        .filter(([, value]) => hasWesternDigits(value) && hasEasternDigits(value));
      expect(mixed).toEqual([]);
    });
  }

  it('the stale banner stays Western while its sentence is English', () => {
    const at = Date.parse('2026-07-12T20:49:00Z');
    expect(ar.staleBanner(at)).toBe(en.staleBanner(at));
    expect(hasEasternDigits(ar.staleBanner(at))).toBe(false);
  });
});

describe('English copy obeys the digit rule', () => {
  it('has no Eastern digit anywhere', () => {
    const offenders = render(en).filter(([, value]) => hasEasternDigits(value));
    expect(offenders).toEqual([]);
  });
});

describe('the two languages stay the same shape', () => {
  it('renders exactly the same set of keys', () => {
    const enKeys = render(en).map(([k]) => k).sort();
    const arKeys = render(ar).map(([k]) => k).sort();
    expect(arKeys).toEqual(enKeys);
  });

  /**
   * The load-bearing one. AR_GAPS is a hand-maintained list of the strings the
   * design bundle has no Arabic for, and it is only worth anything if it cannot
   * drift: translating a string without deleting its entry fails here, and
   * adding an untranslated string without listing it fails here too.
   */
  it('AR_GAPS is exactly the set of keys where Arabic is still English', () => {
    const enByKey = new Map(render(en));
    const stillEnglish = render(ar)
      .filter(([key, value]) => enByKey.get(key) === value)
      .map(([key]) => key)
      // Not gaps: the design's own Arabic leaves these untranslated, because
      // each is a brand, a Latin identifier or a placeholder rather than a
      // sentence. `cRouteAvo` is the AVO wordmark (design:1331), `appVersion`
      // is a wordmark and a build number (design:475), and `pfEmailPh` is a
      // Latin email placeholder (design:1293).
      .filter(
        (key) =>
          ![
            'payMethod.applepay',
            'txMethod.applepay',
            'memberIdPrefix',
            'cRouteAvo',
            'appVersion',
            'pfEmailPh',
          ].includes(key),
      )
      .sort();
    expect(stillEnglish).toEqual([...AR_GAPS].sort());
  });
});
