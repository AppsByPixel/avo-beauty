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

/**
 * design:1612 — the Arabic month names the policy stamp is built from, lifted
 * from the design's own `mAr` array. Not transliterations invented here.
 */
const MONTHS_AR = [
  'يناير',
  'فبراير',
  'مارس',
  'أبريل',
  'مايو',
  'يونيو',
  'يوليو',
  'أغسطس',
  'سبتمبر',
  'أكتوبر',
  'نوفمبر',
  'ديسمبر',
];

/**
 * "2026-07-01" → "١ يوليو ٢٠٢٦".
 *
 * Same string parse as the English side (see en.ts § formatEffectiveFrom) —
 * `effectiveFrom` is a calendar date, and putting it through `new Date` would
 * make the effective date of a legal document depend on the phone's timezone.
 * The digits are Eastern because a date is not money.
 */
function formatEffectiveFromAr(effectiveFrom: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(effectiveFrom.trim());
  if (!match) return effectiveFrom;
  const [, year, month, day] = match;
  const name = MONTHS_AR[Number(month) - 1];
  if (!name) return effectiveFrom;
  return `${ea(Number(day))} ${name} ${ea(year!)}`;
}

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

  // --------------------------------------------------------------- sign-in --
  // The happy path IS in the bundle's `ar` block, so these three are lifted.
  // Note the feminine imperative in `signInSub` — سجّلي, not سجّل. The customer
  // base is women's salons and a masculine form is a copy defect.
  salonName: 'أمارا', // design:1275
  walletWord: 'المحفظة', // design:1353
  signInTitle: 'أهلاً بعودتك', // design:1353
  signInSub: 'سجّلي الدخول إلى محفظة أمارا', // design:1353
  signInAction: 'تسجيل الدخول', // design:1355
  // The three below have no Arabic source. `signInErrEmpty` is the interesting
  // one: the bundle HAS an Arabic string for the empty-fields error (:1363
  // "أدخلي اسم المستخدم وكلمة المرور.") and it names the username, which does not
  // exist in this system — so it cannot be lifted, and translating the phone
  // version here would be exactly the invention this file refuses to make.
  signInWorking: en.signInWorking, // AR GAP
  signInErrEmpty: en.signInErrEmpty, // AR GAP
  signInOffline: en.signInOffline, // AR GAP

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

  // ══════════════════════════════════════════════════════════════════ book ══
  //
  // design:1340-1352 and :1537-1554. The design's Arabic block covers the whole
  // happy path of the Book flow — every heading, every row label, the deposit
  // note, all four call-to-action labels and all three toasts — in feminine
  // address forms throughout (احجزي، اختاري، اشحني). Nine keys are new AR GAPS
  // and every one of them is a STATE: an empty day, a full day, a slot taken
  // between the tap and the POST, the module being off, the calendar fallback,
  // and the refusal when the change window has closed. That is the same shape
  // the file's header describes — AVO States.dc.html contains zero Arabic — and
  // it holds here for a reason worth saying out loud: the design's booking
  // prototype has no failures in it at all.
  //
  // THE DIGIT RULE EARNS ITS KEEP ON THIS SCREEN. It is full of numbers and
  // almost none of them are money: the step counter, the day of the month, the
  // slot times, the duration, the weekday. Those are Eastern. The deposit, the
  // remainder and the shortfall are money and stay Western — and none of them
  // is formatted here, because every one arrives already formatted by
  // `formatMoney`, which is what makes "5.000 د.ك" impossible to get wrong.

  navHome: 'الرئيسية', // design:1340
  navBook: 'احجزي', // design:1340

  bookTitle: 'احجزي', // design:1347
  bookStep: (step, total) => `الخطوة ${ea(step)} من ${ea(total)}`, // design:1876

  chooseService: 'اختاري الخدمة', // design:1347
  chooseArtist: 'اختاري المصففة', // design:1347
  chooseDay: 'اختاري اليوم', // design:1348
  morning: 'صباحاً', // design:1348
  evening: 'مساءً', // design:1348
  review: 'المراجعة', // design:1348

  availLive: 'توفر مباشر', // design:1491
  availSalon: 'حسب دوام الصالون', // design:1492
  availFallback: en.availFallback, // AR GAP

  svcRow: 'الخدمة', // design:1349
  artistRow: 'المصففة', // design:1349
  whenRow: 'الموعد', // design:1349
  depositHeld: 'العربون المحجوز', // design:1349
  depositNote: (remainder) => `يُحجز من محفظتك · الباقي ${remainder} يُدفع في الصالون.`, // design:1538
  depShort: 'اشحني محفظتك لحجز العربون.', // design:1350

  bookContinue: 'متابعة', // design:1554
  bookReviewCta: 'مراجعة الحجز', // design:1550
  bookConfirmCta: (deposit) => `تأكيد · حجز ${deposit}`, // design:1553
  bookTopUpCta: 'اشحني للحجز', // design:1552

  booked: 'تم حجز موعدك', // design:1350
  waConfirm: 'تم إرسال التأكيد على واتساب', // design:1351
  viewHome: 'العودة للرئيسية', // design:1351
  /**
   * design:1352, verbatim — ٢٤ ساعة.
   *
   * ⚠️ IT CONTRADICTS `reschedNote` BELOW, WHICH SAYS ساعة (one hour), AND THE
   * SERVER IMPLEMENTS ONE HOUR. Both strings are the designer's and both are
   * kept exactly as written, in both languages, rather than one being quietly
   * corrected to match the other — a lane editing product copy to resolve a
   * product contradiction is how the contradiction stops being visible.
   * Reported. See BookScreen § the confirmed step, which states the one-hour
   * rule alongside this line so the customer is not told only the wrong number.
   */
  cancelPolicy: 'الإلغاء مجاني حتى ٢٤ ساعة قبل الموعد — يُعاد العربون لمحفظتك تلقائياً.', // design:1352

  bookedToast: (deposit) => `تم الحجز · حُجز عربون ${deposit}`, // design:1547
  rescheduleToast: 'اختاري موعداً جديداً — العربون محفوظ', // design:1773
  cancelledToast: (deposit) => `أُلغي الموعد · أُعيد العربون ${deposit}`, // design:1774

  bookEmptyDayTitle: en.bookEmptyDayTitle, // AR GAP
  bookEmptyDayBody: en.bookEmptyDayBody, // AR GAP
  bookFullDayTitle: en.bookFullDayTitle, // AR GAP
  bookFullDayBody: en.bookFullDayBody, // AR GAP
  slotTakenTitle: en.slotTakenTitle, // AR GAP
  slotTakenBody: en.slotTakenBody, // AR GAP
  bookingOffTitle: en.bookingOffTitle, // AR GAP
  bookingOffBody: en.bookingOffBody, // AR GAP
  bookShortBy: (shortfall) => `الرصيد أقل بـ ${shortfall}`, // design:1344 `shortMsg`

  // ═════════════════════════════════════════════════ upcoming appointment ══

  upcomingLabel: 'موعدك القادم', // design:1285
  upDeposit: (deposit) => `عربون ${deposit}`, // design:1286
  upWith: (artist) => `مع ${artist}`, // design:1285
  reschedule: 'تغيير الموعد', // design:1287
  cancel: 'إلغاء', // design:1286
  reschedNote: 'مجاناً حتى ساعة قبل الموعد. بعدها يبقى العربون للصالون.', // design:1287
  changeClosedTitle: en.changeClosedTitle, // AR GAP
  changeClosedBody: en.changeClosedBody, // AR GAP
  noUpcomingTitle: en.noUpcomingTitle, // AR GAP
  noUpcomingBody: en.noUpcomingBody, // AR GAP
  noUpcomingAction: 'احجزي', // design:1340 — the nav label, the same word.

  // ══════════════════════════════════════════════════════════════ account ══
  // design:1289-1338. The design's Arabic block covers the whole Account screen,
  // so this section adds not a single new AR GAP — every string below was
  // written by the designer, in feminine address forms throughout
  // (اكتبي، اختاري، أدخلي، استخدمي، تابعي).
  accountTitle: 'حسابي', // design:1289
  back: '‹ رجوع', // design:1347
  acctProfile: 'الملف الشخصي', // design:1289
  acctNotifs: 'الإشعارات', // design:1290
  acctLegal: 'المحفظة والسياسات', // design:1290
  acctHelp: 'المساعدة', // design:1323
  // design:1840 — `(isAr ? 'تابعي ' : 'Follow ') + t.salon`. تابعي is the
  // feminine imperative; the salon name itself comes off the API.
  followTitle: (salonName) => `تابعي ${salonName}`,
  // design:475 — sits outside the `t` object in the design, i.e. the same string
  // in both languages. A wordmark and a build number, not a sentence.
  appVersion: 'AVO Beauty · v1.0',

  rowEdit: 'تعديل', // design:1291
  rowName: 'الاسم', // design:1308
  rowPhone: 'رقم الهاتف', // design:1308
  rowEmail: 'البريد الإلكتروني', // design:1308
  rowPassword: 'كلمة المرور', // design:1308
  rowLang: 'اللغة', // design:1308
  rowChange: 'تغيير', // design:1308
  rowAddEmail: 'أضيفي بريداً إلكترونياً', // design:1308 — feminine imperative
  rowLangValue: 'العربية', // design:1832

  nPush: 'إشعارات التطبيق', // design:1309
  nPushSub: 'تذكير المواعيد، الشحن، وتغيّر المستوى', // design:1309
  nWa: 'رسائل واتساب', // design:1310
  nWaSub: 'الإيصالات وتأكيد المواعيد', // design:1310
  nRemind: 'تذكير بالموعد', // design:1311
  nRemindSub: 'قبل موعدك بساعتين', // design:1311
  nReceipt: 'إيصالات بالبريد', // design:1312
  nReceiptSub: 'إيصال مفصّل بالبريد الإلكتروني عن كل عملية دفع أو شحن أو استرجاع', // design:1312
  nOffers: 'عروض الصالون', // design:1313
  nOffersSub: 'عروض من أمارا بين حين وآخر. مغلقة افتراضياً.', // design:1313
  notifErr: en.notifErr, // AR GAP
  notifSaveErr: en.notifSaveErr, // AR GAP

  // design:1320 'آخر تحديث ١ يوليو ٢٠٢٦', and design:1614 which composes the
  // version onto it. Eastern digits throughout — a date and a version are not
  // money — and the Arabic month name, not a transliteration of the English one.
  legalUpdated: (effectiveFrom, version) =>
    `آخر تحديث ${formatEffectiveFromAr(effectiveFrom)} · إصدار ${ea(version)}`,
  walletFine:
    'محفظتك تحتوي رصيداً مدفوعاً مسبقاً لصالون أمارا فقط. الرصيد لا ينتهي، ولا يمكن تحويله لصالون آخر، وليس وديعة بنكية.', // design:1321
  logOut: 'تسجيل الخروج', // design:1322
  deleteAcct: 'حذف حسابي', // design:1322

  contactCta: 'اتصلي بنا', // design:1324 — feminine imperative
  contactCtaSub: 'سؤال، أو خصم يبدو غير صحيح، أو أي أمر آخر', // design:1324

  pfTitle: 'تعديل الملف الشخصي', // design:1292
  pfSub: 'اسمك وطريقة تواصل الصالون معك.', // design:1292
  pfEmailPh: 'name@email.com', // design:1293 — a Latin placeholder in both
  pfPhoneNote: 'رقم هاتفك هو وسيلة تسجيل الدخول. تغييره يحتاج رمزاً نرسله للرقم الجديد.', // design:1294
  pfSave: 'حفظ التغييرات', // design:1295
  pfSaved: 'تم تحديث الملف', // design:1295
  pfErrName: 'أدخلي اسمك.', // design:1296 — feminine imperative
  pfErrPhone: 'أدخلي رقم هاتف صحيح.', // design:1296
  pfErrEmail: 'البريد الإلكتروني غير صحيح.', // design:1297
  cOptional: '(اختياري)', // design:1328

  vfTitle: 'تأكيد رقمك الجديد', // design:1298
  // design:1298 + design:1842. '٤ أرقام' is Eastern; the phone number that
  // follows is a Latin/E.164 run that bidi keeps together and LTR.
  vfSub: (phone) => `أدخلي الرمز المكوّن من ٤ أرقام الذي أرسلناه إلى ${phone}`,
  vfConfirm: 'تأكيد الرقم', // design:1299
  vfResend: 'إرسال مرة أخرى', // design:1299
  vfBack: 'رجوع', // design:1299
  vfErr: 'أدخلي الرمز المكوّن من ٤ أرقام.', // design:1300
  vfSent: 'تم إرسال الرمز', // design:1300

  pwTitle: 'تغيير كلمة المرور', // design:1301
  pwSub: 'ستبقين مسجّلة الدخول على هذا الهاتف، وتُسجَّل الأجهزة الأخرى خارجاً.', // design:1301
  pwCurLabel: 'كلمة المرور الحالية', // design:1302
  pwNewLabel: 'كلمة المرور الجديدة', // design:1302
  pwConfLabel: 'تأكيد كلمة المرور الجديدة', // design:1302
  pwSave: 'تحديث كلمة المرور', // design:1303
  pwSaved: 'تم تحديث كلمة المرور', // design:1303
  pwForgot: 'نسيت كلمة المرور الحالية', // design:1304
  pwErrCur: 'أدخلي كلمة المرور الحالية.', // design:1305
  pwErrShort: 'استخدمي ٦ أحرف على الأقل.', // design:1305 — Eastern, a count
  pwErrSame: 'اختاري كلمة مرور مختلفة عن الحالية.', // design:1306
  pwErrMatch: 'كلمتا المرور غير متطابقتين.', // design:1307
  pwShow: 'إظهار', // design:1806
  pwHide: 'إخفاء', // design:1806
  passHint: '٦ أحرف على الأقل', // design:1355 — Eastern, a count

  contactTitle: 'اتصلي بنا', // design:1325
  contactSub: 'اكتبي لنا ما حصل وسنرد عليك.', // design:1325 — feminine imperative
  cTopicLabel: 'ما هو الموضوع؟', // design:1326
  cMsgLabel: 'رسالتك', // design:1326
  cMsgPh: 'سطران يكفيان. ذكر التاريخ والمبلغ يساعدنا.', // design:1327
  cRefLabel: 'رقم الإيصال أو المرجع', // design:1328
  cViaLabel: 'الرد عليّ على', // design:1329
  cViaWa: 'واتساب', // design:1329
  cViaEmail: 'البريد الإلكتروني', // design:1329
  cSend: 'إرسال الرسالة', // design:1330
  cErr: 'اختاري الموضوع واكتبي رسالة قصيرة.', // design:1330
  cRouteSalon: 'الصالون', // design:1331
  cRouteAvo: 'AVO', // design:1331 — the brand stays Latin in the Arabic build
  cSentTitle: 'تم إرسال رسالتك', // design:1333
  cSentRef: 'رقمك المرجعي', // design:1333
  cSentDone: 'تم', // design:1333
  cSentSalon: 'وصلت رسالتك إلى أمارا وسيتم الرد على واتساب.', // design:1334
  cSentAvo: 'وصلت رسالتك إلى فريق AVO.', // design:1335

  deleteTitle: 'حذف حسابك؟', // design:1336
  // design:1336 — ٣٠ يوماً is Eastern; a number of days is a count, not money.
  deleteBody:
    'سيتم حذف ملفك وسجل زياراتك ونقاط الولاء خلال ٣٠ يوماً. المبالغ المدفوعة للصالون لا تُسترجع تلقائياً.',
  deleteBalance: 'الرصيد المتبقي', // design:1337
  deleteKeep: 'الاحتفاظ بالحساب', // design:1337
  deleteGo: 'طلب الحذف', // design:1337
  deleteFine:
    'لا يُصرف رصيد المحفظة نقداً. استخدمي الرصيد المتبقي في الصالون أو اتفقي معهم على تسويته قبل إغلاق الحساب.', // design:1338
  // The design's delete sheet never reaches a server, so it has no Arabic for
  // any outcome. These three are the highest-priority entries on the worksheet:
  // deletion copy is legally loaded and the English promises a specific window.
  deletePendingTitle: en.deletePendingTitle, // AR GAP
  deletePendingBody: en.deletePendingBody, // AR GAP
  deleteCancel: en.deleteCancel, // AR GAP
  deleteCancelled: en.deleteCancelled, // AR GAP
  // The persistent scheduled state. Same worksheet priority as the four above and
  // arguably higher: this is the only sentence a customer mid-grace-window ever
  // sees, and it is the one that has to make clear NOTHING has been deleted yet.
  deleteScheduledTitle: en.deleteScheduledTitle, // AR GAP
  deleteScheduledBody: en.deleteScheduledBody, // AR GAP
  deleteCheckFailed: en.deleteCheckFailed, // AR GAP

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
  'signInWorking',
  'signInErrEmpty',
  'signInOffline',
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
  // ---- book. Every one of these is a STATE or a refusal; see the section
  // header above. The design's booking prototype has no failure in it, so the
  // Arabic block that covers its whole happy path covers none of these.
  'availFallback',
  'bookEmptyDayTitle',
  'bookEmptyDayBody',
  'bookFullDayTitle',
  'bookFullDayBody',
  'slotTakenTitle',
  'slotTakenBody',
  'bookingOffTitle',
  'bookingOffBody',
  'changeClosedTitle',
  'changeClosedBody',
  'noUpcomingTitle',
  'noUpcomingBody',
  // ---- account. Same pattern again: the design's Account prototype has no
  // failing write and no server behind the delete sheet, so the Arabic that
  // covers its happy path covers none of these.
  'notifErr',
  'notifSaveErr',
  'deletePendingTitle',
  'deletePendingBody',
  'deleteCancel',
  'deleteCancelled',
  'deleteScheduledTitle',
  'deleteScheduledBody',
  'deleteCheckFailed',
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
