/**
 * Arabic copy — LIFTED, NOT TRANSLATED.
 *
 * Every string below that carries a `design:NNNN` marker is the exact text from
 * design/AVO Wallet Home.dc.html at that line. Nothing here was written by the
 * engineer building this file. CLAUDE.md: "Keep the copy verbatim. Both
 * languages. Product copy is written; do not paraphrase."
 *
 * THE DIGIT RULE (see ../i18n/digits.ts). Counts, dates, times, percentages and
 * PIN lengths are Eastern Arabic-Indic; **money is Western**, and money never
 * comes through this file — it comes off `formatMoney()` in @avo/types. Every
 * numeric interpolation below therefore goes through `toEasternDigits`, and the
 * test asserts that none of them can return a Western digit.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THE DESIGN BUNDLE DOES NOT HAVE, AND WHY THESE ARE ENGLISH
 *
 * `design/AVO States.dc.html` — the file that specifies every loading, empty,
 * error and offline state — contains **zero Arabic characters**. The `ar` block
 * in AVO Wallet Home.dc.html covers the happy path only. So the whole state
 * vocabulary, relative time, three of the four transaction statuses and the
 * screen-reader phrasing have no Arabic source anywhere in the bundle.
 *
 * Those keys hold the English string, are listed in `AR_GAPS` below, and are
 * asserted by `copy.test.ts` so the list cannot drift from the file. They are
 * NOT machine-translated and NOT guessed: a masculine or wrong-register string
 * shipped into a women's-salon product is a copy defect, and inventing one here
 * would hide the gap from the native-speaker review instead of handing it over.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { TierName } from '@avo/types';
import { toEasternDigits as ea, ARABIC_PERCENT as PC } from '../i18n/digits';
import type { Copy } from './types';
import { en } from './en';

/**
 * design:1722–1725 — the membership ladder, all four tiers.
 * برونزية · فضية · ذهبية · سوداء
 */
const TIER_NAME: Record<TierName, string> = {
  bronze: 'برونزية',
  silver: 'فضية',
  gold: 'ذهبية',
  black: 'سوداء',
};

/**
 * "to Gold" — design:1276 `tierHint: '٦ زيارات للذهبية'`.
 *
 * This is why `tierHint` takes a `TierName` and not a label: لِ + الـ elide into
 * لل, so the phrase is `لل` + the bare noun. Concatenating a preposition onto
 * the already-definite `الذهبية` would produce `لالذهبية`, which is not a word.
 * The design's own gold form confirms the rule: لل + ذهبية = للذهبية.
 */
const tierTo = (tier: TierName) => `لل${TIER_NAME[tier]}`;

/**
 * The adjective form, for design:1282 `'مستواكِ الفضي يضيف ١٠٪ …'` — مستوى is
 * masculine, so the tier agrees as a masculine adjective rather than appearing
 * as the feminine noun above.
 *
 * ONLY `silver` IS DESIGN-SOURCED. The other three are the regular derivation
 * and are flagged for the booked native-speaker review — سوداء in particular is
 * irregular (the masculine of the colour is أسود, not سوداءي). Listed in
 * `AR_UNVERIFIED` rather than `AR_GAPS`: they render Arabic, but no designer
 * wrote them.
 */
const TIER_ADJECTIVE: Record<TierName, string> = {
  silver: 'الفضي', // design:1282
  gold: 'الذهبي', // UNVERIFIED
  bronze: 'البرونزي', // UNVERIFIED
  black: 'الأسود', // UNVERIFIED
};

export const ar: Copy = {
  // ---------------------------------------------------------------- header --
  greeting: (firstName) => `مساء الخير، ${firstName}`, // design:1275

  // ----------------------------------------------------------- wallet card --
  balanceLabel: 'رصيد المحفظة', // design:1275
  tierName: TIER_NAME,
  // design:1276 '٦ زيارات للذهبية' — Eastern digits, because a visit count is
  // not money.
  tierHint: (visits, tier) => `${ea(visits)} زيارات ${tierTo(tier)}`,
  stampsHint: (have, target) => `${ea(have)} من ${ea(target)}`, // design:1657
  stampsPill: (have, target) => `${ea(have)} / ${ea(target)}`, // design:1646
  // design:1722–1725 — the ladder arrow is ← in Arabic and → in English. The
  // arrow follows the reading direction; it is not a decoration.
  tierLadder: (current, next) =>
    next ? `${TIER_NAME[current]} ← ${TIER_NAME[next]}` : TIER_NAME[current],

  // ---------------------------------------------------------- payment code --
  qrTitle: 'اعرضي للدفع', // design:1278 — feminine imperative
  qrHint: 'يتجدد خلال', // design:1278
  sec: ' ث', // design:1278
  tapEnlarge: 'اضغطي للتكبير', // design:1278 — feminine imperative
  // The member id is a Latin identifier in both languages; only the separator
  // is copy, and the design renders the id with `direction:ltr` (design:403).
  memberIdPrefix: 'ID · ',
  qrAria: en.qrAria, // AR GAP
  loadingAria: en.loadingAria, // AR GAP

  // -------------------------------------------------------------- branches --
  branchEarnLabel: 'الكسب حسب الفرع', // design:1152
  branchNote: 'محفظة واحدة — صالحة في كل الفروع.', // design:1277
  standardEarning: 'كسب اعتيادي', // design:1160
  visitsMultiplier: (n) => `زيارات ×${ea(n)}`, // design:1157
  stampsMultiplier: (n) => `أختام ×${ea(n)}`, // design:1157
  topupBoost: (percent) => `+${ea(percent)}${PC} على الشحن`, // design:1158

  // ----------------------------------------------------------- top-up card --
  topupTitle: 'اشحني محفظتك', // design:1281 — feminine imperative
  // design:1281 'فضية · مكافأة +١٠٪' — Eastern digits AND ٪ rather than %.
  tierBonusBadge: (tier, percent) =>
    `${TIER_NAME[tier]} · مكافأة +${ea(percent)}${PC}`,
  // design:1282 'مستواكِ الفضي يضيف ١٠٪ رصيد مجاني على كل شحن.'
  tierBonusExplain: (tier, percent) =>
    `مستواكِ ${TIER_ADJECTIVE[tier]} يضيف ${ea(percent)}${PC} رصيد مجاني على كل شحن.`,
  stampsBadge: (target) => `اجمعي ${ea(target)} · واحدة مجاناً`, // design:1366
  stampsExplain: 'اشحني أي مبلغ — كل زيارة للصالون تضيف ختماً.', // design:1367
  continuePay: 'متابعة الدفع', // design:1283

  // -------------------------------------------------- top-up sheet: choose --
  payTitle: 'اختاري وسيلة الدفع', // design:1284
  youPay: 'تدفعين', // design:1283
  // design:1579 'مكافأة فضية' — the receipt's bonus row carries the tier noun.
  bonusRow: (tier) => (tier ? `مكافأة ${TIER_NAME[tier]}` : 'مكافأة'),
  lands: 'يُضاف للمحفظة', // design:1284
  methodLabel: 'وسيلة الدفع', // design:1284
  payBtn: 'ادفعي', // design:1284 — feminine imperative
  payMethod: {
    knet: 'كي نت', // design:1345
    card: 'فيزا · ماستركارد', // design:1345
    applepay: 'Apple Pay', // design:1345 — untranslated in the design too
  },
  mostUsed: 'الأكثر استخداماً في الكويت', // design:1405

  // --------------------------------------------- top-up sheet: quote failed --
  quoteFailedTitle: en.quoteFailedTitle, // AR GAP
  quoteFailedBody: en.quoteFailedBody, // AR GAP

  // -------------------------------------------------- top-up sheet: redirect --
  payRedirectTitle: (method) => `جارٍ فتح ${method}`, // design:1371
  payRedirectSub: 'أكملي الدفع في صفحة البنك — ستعودين إلى هنا تلقائياً.', // design:1371
  payDontClose: 'أبقي هذه الشاشة مفتوحة حتى يعيدكِ البنك.', // design:1372

  // ------------------------------------------ top-up sheet: the four outcomes --
  doneTitle: 'تم الشحن', // design:1376
  doneMsg: 'محفظتكِ جاهزة للاستخدام في كل الفروع.', // design:1376
  failTitle: 'لم تكتمل العملية', // design:1373
  failMsg: 'رفض البنك العملية. لم يُخصم أي مبلغ.', // design:1373
  cancelTitle: 'أُلغيت العملية', // design:1374
  cancelMsg: 'ألغيتِ الدفع في صفحة كي نت. لم يُخصم أي مبلغ.', // design:1374
  pendingTitle: 'بانتظار تأكيد البنك', // design:1375
  pendingMsg: 'قد تستغرق دقيقة. لا تعيدي الدفع — سيُضاف الرصيد فور تأكيد البنك.', // design:1375

  rAmount: 'المبلغ', // design:1377
  rMethod: 'الطريقة', // design:1377
  rRef: 'الرقم المرجعي', // design:1377
  rStatus: 'الحالة', // design:1377
  rBalance: 'الرصيد الجديد', // design:1377
  rCharged: 'المخصوم', // design:1377
  vNothing: 'لم يُخصم شيء', // design:1378
  vPending: 'بانتظار البنك', // design:1378
  otherMethod: 'اختاري طريقة أخرى', // design:1378
  backToWallet: 'العودة للمحفظة', // design:1379
  done: 'تم', // design:1379

  // -------------------------------------------------------------- activity --
  activityLabel: 'النشاط', // design:1339
  emptyActivityTitle: en.emptyActivityTitle, // AR GAP
  emptyActivityBody: en.emptyActivityBody, // AR GAP
  emptyActivityAction: en.emptyActivityAction, // AR GAP
  rowPending: en.rowPending, // AR GAP
  rowFailed: en.rowFailed, // AR GAP

  // --------------------------------------------------------------- failure --
  errorTitle: en.errorTitle, // AR GAP
  errorBody: en.errorBody, // AR GAP
  tryAgain: 'حاولي مرة أخرى', // design:1378
  referencePrefix: en.referencePrefix, // AR GAP
  blockedTitle: en.blockedTitle, // AR GAP

  // --------------------------------------------------------------- offline --
  offlineBanner: en.offlineBanner, // AR GAP
  lastUpdated: en.lastUpdated, // AR GAP
  qrOfflineTitle: en.qrOfflineTitle, // AR GAP
  qrOfflineBody: en.qrOfflineBody, // AR GAP
  staleBanner: en.staleBanner, // AR GAP — formats its own clock, so it stays Western while the sentence is English
  qrFailedTitle: en.qrFailedTitle, // AR GAP
  qrFailedBody: en.qrFailedBody, // AR GAP

  // --------------------------------------------------------- relative time --
  justNow: en.justNow, // AR GAP
  minutesAgo: en.minutesAgo, // AR GAP
  hoursAgo: en.hoursAgo, // AR GAP
  daysAgo: en.daysAgo, // AR GAP

  today: 'اليوم', // design:1577
  yesterday: 'أمس', // design:1580

  // ------------------------------------------------------ transaction kinds --
  txKind: {
    topup: 'شحن', // design:1577
    charge: 'خدمة', // design:1581
    deposit_hold: 'العربون المحجوز', // design:1349
    deposit_return: 'استرجاع العربون', // design:1583
    shop: 'طلب من المتجر', // design:1587
    adjustment: en.txKind.adjustment, // AR GAP
  },

  txMethod: {
    knet: 'كي نت', // design:1579
    card: 'فيزا · ماستركارد', // design:1345
    applepay: 'Apple Pay', // design:1345
    wallet: 'رصيد المحفظة', // design:1582
  },

  // --------------------------------------------- transaction detail sheet --
  txRefLabel: 'الرقم المرجعي', // design:1288
  txHelp: 'في حال وجود خطأ، راسلي الصالون على واتساب.', // design:1288
  txClose: 'إغلاق', // design:1288
  txReport: 'الإبلاغ عن مشكلة في هذه العملية', // design:1332
  txYouPaid: 'المبلغ المدفوع', // design:1579
  txPaidWith: 'وسيلة الدفع', // design:1579
  txPaidFrom: 'الدفع من', // design:1582
  txWalletBalance: 'رصيد المحفظة', // design:1582
  txLanded: 'المضاف للمحفظة', // design:1579
  txTierBonus: (tier) => (tier ? `مكافأة ${TIER_NAME[tier]}` : 'مكافأة'), // design:1579
  txBranch: 'الفرع', // design:1579
  txBranchOnline: 'عبر التطبيق', // design:1579
  txReturnedTo: 'أُعيد إلى', // design:1585
  txAmountRow: 'المبلغ', // design:1377
  txStatus: {
    settled: 'مكتملة', // design:1578
    pending: en.txStatus.pending, // AR GAP
    failed: en.txStatus.failed, // AR GAP
    cancelled: en.txStatus.cancelled, // AR GAP
  },

  plus: en.plus, // AR GAP
  minus: en.minus, // AR GAP

  langSwitch: 'EN', // design:1339
  restartNeeded: en.restartNeeded, // AR GAP
};

/**
 * Every key whose Arabic has no source in the design bundle and therefore holds
 * the English string. `copy.test.ts` asserts this list is exactly the set of
 * keys where `ar` and `en` are identical, so it cannot silently rot: adding a
 * translation without removing its entry here fails the build, and adding a key
 * without Arabic and without listing it here fails too.
 *
 * This is the worksheet for the native-speaker review. Twenty-two of the
 * twenty-four entries are state copy, which is not an accident — see the header.
 */
export const AR_GAPS = [
  'qrAria',
  'loadingAria',
  'quoteFailedTitle',
  'quoteFailedBody',
  'emptyActivityTitle',
  'emptyActivityBody',
  'emptyActivityAction',
  'rowPending',
  'rowFailed',
  'errorTitle',
  'errorBody',
  'referencePrefix',
  'blockedTitle',
  'offlineBanner',
  'lastUpdated',
  'qrOfflineTitle',
  'qrOfflineBody',
  'staleBanner',
  'qrFailedTitle',
  'qrFailedBody',
  'justNow',
  'minutesAgo',
  'hoursAgo',
  'daysAgo',
  'plus',
  'minus',
  'restartNeeded',
  'txKind.adjustment',
  'txStatus.pending',
  'txStatus.failed',
  'txStatus.cancelled',
] as const;

/**
 * Arabic that renders but that no designer wrote — the regular derivation of a
 * form the design only supplied for one case. Separate from `AR_GAPS` because
 * the failure mode is different: a gap shows English, an unverified string shows
 * plausible Arabic that may be wrong. Both go to the native-speaker review.
 */
export const AR_UNVERIFIED = [
  'tierBonusExplain(bronze)',
  'tierBonusExplain(gold)',
  'tierBonusExplain(black)',
] as const;
