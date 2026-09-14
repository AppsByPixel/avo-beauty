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

import type { RewardKey, TierName } from '@avo/types';
import { toEasternDigits as ea, ARABIC_PERCENT as PC } from '../i18n/digits';
import type { Copy } from './types';
import { en } from './en';
import { durationParts } from '../domain/happyHour';

/**
 * design/avo-promotions.js:19-24 — the six rewards, in the designer's Arabic.
 *
 * ⚠️ `credit3` IS A DESIGN/NON-NEGOTIABLE CONFLICT, REPORTED AND NOT RESOLVED
 * HERE. `'٣ د.ك رصيد'` puts a money figure in EASTERN digits, which
 * non-negotiable #12 forbids — and the same design bundle writes money the other
 * way everywhere else in Arabic (`'عربون 5.000 د.ك'`, design:1286). So two
 * design strings disagree with each other about the same question, and one of
 * them disagrees with a non-negotiable.
 *
 * It is lifted VERBATIM rather than silently corrected, because "do not restyle,
 * keep the copy verbatim" is also a rule and choosing between two rules is not a
 * decision this lane gets to make quietly. It is reachable in production — a
 * merchant can publish a `credit3` window — and it is not in the seeded fixture,
 * so it is flagged rather than shipped-and-forgotten. One word changes it if the
 * ruling goes the other way: `'3 د.ك رصيد'`.
 */
const REWARD_AR: Record<RewardKey, string> = {
  x2stamp: 'ختمان بدل ختم',
  x3stamp: 'ثلاثة أختام',
  x2visit: 'رصيد زيارة مضاعف',
  topup10: `+${ea(10)}${PC} على الشحن`,
  topup20: `+${ea(20)}${PC} على الشحن`,
  credit3: '٣ د.ك رصيد', // ⚠️ see above
};

/** design:1144 — the design's own `dayNamesAr`, not a transliteration. */
const DAYS_AR = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];

/**
 * "١ س ٣٠ د" / "٣٠ د" — design:349-353, minus the seconds.
 *
 * The design's prototype formatter resolves to seconds below one hour ("٣٠ د ٠٥
 * ث"). This banner does not, because `minutesRemaining` in @avo/types — the
 * shared rule both surfaces must agree on — is whole minutes, and README §119's
 * own examples of this banner ("1h 28m left") and of the dashboard row
 * ("Live · 42m left") are both minute-resolution. The predicate is still
 * re-evaluated every second, so the banner still disappears on the second the
 * window closes; only the digits are coarser than the prototype's.
 */
function countdownAr(minutes: number): string {
  const parts = durationParts(minutes);
  return parts.hours > 0
    ? `${ea(parts.hours)} س ${ea(parts.minutes)} د`
    : `${ea(parts.minutes)} د`;
}

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
 * زيارة / زيارات — the counted noun for a number of visits.
 *
 * Arabic agreement is not a plural switch at 2. The noun takes the PLURAL for
 * 3-10 and returns to the SINGULAR from 11 up, which is why `+٢٠ زيارة` is
 * right and `+٢٠ زيارات` is not. design:1722-1724 confirms both ends of that
 * rule — `٠ زيارة` and `+٤ زيارات`/`+١٠ زيارات` — and sidesteps the 20 case by
 * dropping the noun, so the 11+ branch here is the regular derivation rather
 * than design-sourced.
 *
 * The DUAL (exactly 2, `زيارتين`) is deliberately not implemented: it needs a
 * different construction after a numeral, no design string supplies it, and no
 * tier ladder or stamp target in the contract uses 2 today. If one ever does,
 * this is the function that has to learn it.
 */
const visitsNoun = (n: number) => (n >= 3 && n <= 10 ? 'زيارات' : 'زيارة');

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
  qrBig: 'اعرضي هذا على الكاشير', // design:1279 — feminine imperative
  qrBigSub: 'تم رفع الإضاءة لتسهيل المسح', // design:1279

  // ------------------------------------------------------------ happy hour --
  happyReward: REWARD_AR,
  happyLiveTitle: (reward) => `الساعة السعيدة · ${reward}`, // design:1136
  // design:1145 — the design's Arabic drops "الساعة السعيدة" from the next
  // banner and says only "القادمة". Lifted as written; not padded out to match
  // the English sentence.
  happyNextTitle: (reward) => `القادمة · ${reward}`,
  happyLiveSub: (branch, endsAt) => `${branch} · حتى ${ea(endsAt)}`, // design:1137
  happyNextSub: (branch, day, from, to) =>
    // design:1146-1150. A clock time is a count, not money, so it is Eastern.
    `${branch} · ${day === null ? 'اليوم' : DAYS_AR[day]} ${ea(from)}–${ea(to)}`,
  /**
   * design:1138 + :346-355. `formatCountdown` in @avo/types cannot serve this —
   * it is English-only and hard-codes the word "left" — so the units come from
   * the design's own countdown formatter (س / د) and only the minute count is
   * shared with English.
   */
  happyLiveLabel: (minutes) => `باقي ${countdownAr(minutes)}`,
  happyNextLabel: (minutes) => `بعد ${countdownAr(minutes)}`, // design:1151
  happyClock: (hhmm) => `الآن ${ea(hhmm)}`, // design:1140
  happyAllBranches: 'كل الفروع', // design/avo-promotions.js:272

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
  /**
   * design:295 — the same markup serves both languages, so the same `+`. The
   * figure arrives formatted by `formatFils`, i.e. Western digits, which is what
   * the designer's own Arabic does for money (design:1286 writes `عربون 5.000
   * د.ك`). Deliberately NOT `ea()`: this is money, not a count.
   */
  topupTileBonus: (bonus) => `+${bonus}`,
  topupGet: 'تحصلين على', // design:1283 — feminine, as the design wrote it
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

  /*
    INVENTED in English and NOT translated here — the three keys go to the
    native-speaker worksheet via AR_GAPS, like `quoteFailedTitle` and
    `quoteFailedBody` immediately above them. Machine Arabic on a money screen is
    the exact thing that list exists to prevent, and this one has to carry a
    distinction ("still waiting", not "nothing happened") that a translation
    which loses it would make actively harmful.
  */
  gatewayFailedTitle: en.gatewayFailedTitle, // AR GAP
  gatewayFailedBody: en.gatewayFailedBody, // AR GAP
  gatewayFailedRetry: en.gatewayFailedRetry, // AR GAP

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
  // AR GAP. The design draws no disclosure control in either language, so
  // there is nothing to lift — see copy/types.ts § activityShowMore.
  activityShowMore: en.activityShowMore, // AR GAP
  emptyActivityTitle: en.emptyActivityTitle, // AR GAP
  emptyActivityBody: en.emptyActivityBody, // AR GAP
  emptyActivityAction: en.emptyActivityAction, // AR GAP
  rowPending: en.rowPending, // AR GAP
  rowFailed: en.rowFailed, // AR GAP

  // ------------------------------------------------------------ membership --
  membersLabel: 'مستويات العضوية', // design:1339
  current: 'الحالية', // design:1339
  /*
    design:1280, with TWO changes, both recorded rather than invented.

    1. The authority clause's subject moves from `الصالون` to AVO — DECISIONS.md
       #86. The construction (`يمكن لـ` + subject) is the designer's own and is
       untouched, which is why this is a substitution and not a new sentence.
    2. The funding clause interpolates the salon's name where the design wrote
       `صالون أمارة` literally. Note the design's own two spellings of the name:
       `أمارة` here and `أمارا` at design:1275, which is what the API serves and
       therefore what this renders.

    In AR_UNVERIFIED, not AR_GAPS: it renders Arabic, and a native speaker still
    needs to confirm the substituted subject reads correctly.
  */
  tierFine: (salon) =>
    `المكافآت ومزايا المستويات ممولة من ${salon} وليس من AVO. ` +
    'يمكن لـAVO تغيير المستويات في أي وقت، ولا يتأثر رصيدك الحالي.',
  /*
    design:1722-1724 supplies three counted forms — `٠ زيارة`, `+٤ زيارات`,
    `+١٠ زيارات` — and drops the noun entirely for 20. Those three fix the rule
    rather than merely sampling it: Arabic takes the plural for 3–10 and the
    SINGULAR from 11 up, so `+٢٠ زيارة` is correct and a uniform `زيارات` would
    not be. The dual (2) has no design sample and no ladder uses it today.
  */
  tierRequirement: (minVisits, bonusPercent) =>
    bonusPercent <= 0
      ? `${ea(minVisits)} ${visitsNoun(minVisits)} · بدون مكافأة`
      : `+${ea(minVisits)} ${visitsNoun(minVisits)} · +${ea(bonusPercent)}${PC}`,
  // The arrow points the way the language reads — design:1722 writes `10 ← 11`.
  // Western digits: both figures are money. Non-negotiable #12.
  tierBonusIllustration: (base, credited) => `${base} ← ${credited}`,

  stampCardTitle: 'بطاقة الأختام', // design:1365
  stampCountOf: (have, target) => `${ea(have)} من ${ea(target)}`, // design:1657
  // design:1365 writes `وتصفيف الشعر`, a fitted form of the one reward the
  // prototype had. The salon's own `stampRewardAr` goes in instead.
  stampsGoal: (remaining, reward) =>
    `${ea(remaining)} ${visitsNoun(remaining)} و${reward} على حسابنا.`,
  stampRule1: 'ختم واحد لكل زيارة، مهما كان المبلغ.', // design:1368
  stampRule2: 'مشتريات المتجر تُحتسب كزيارة أيضاً.', // design:1369
  // design:1370, with `التصفيف المجاني` replaced by the salon's reward.
  stampRule3: (reward) => `تبدأ البطاقة من جديد بعد استلام ${reward}.`,

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
  signInNoAccount: 'أول مرة معنا؟', // design:1356
  signInCreateOne: 'أنشئي حساباً', // design:1356
  signInForgot: 'نسيت كلمة المرور؟', // design's forgot, drawn

  // ------------------------------------------------- reset request screen --
  resetTitle: 'إعادة تعيين كلمة المرور', // design's resetTitle, drawn
  // AR GAP, deliberately: the design's Arabic names a USERNAME (أدخلي اسم
  // المستخدم…) and the identity is the phone. Swapping one noun into a designed
  // sentence would be Arabic no native speaker wrote — the exact thing AR_GAPS
  // exists to prevent — so the English adaptation stands in until review.
  resetSub: en.resetSub, // AR GAP
  resetErrEmpty: en.resetErrEmpty, // AR GAP — INVENTED in English, untranslated
  resetWorking: en.resetWorking, // AR GAP — INVENTED in English, untranslated
  resetBtn: 'إرسال الرابط', // design's resetBtn, drawn
  resetSentTitle: 'تحقّقي من واتساب', // design's resetSentTitle, drawn
  resetSentSub: 'رابط إعادة التعيين في طريقه إلى رقمكِ المسجّل.', // design's resetSentSub, drawn
  backToLogin: 'العودة لتسجيل الدخول', // design's backToLogin, drawn

  // ---------------------------------------------------------------- signup --
  /*
    THE HAPPY PATH IS ALL IN THE BUNDLE, AND IT IS ALL FEMININE. أنشئي, لديكِ,
    سجّلي — the design's own Arabic addresses a woman throughout, which is
    non-negotiable #12's "feminine address forms" written by the designer rather
    than inferred by me. Lifted character for character.

    THE REFUSALS ARE NOT. The design's signup has no server, so its Arabic covers
    three client-side validations and none of the ten the endpoint can answer with.
    Those hold English and are in AR_GAPS. `signUpErrShort` is the one that crosses
    over: the design wrote it for its own 6-character check and the server's
    `password_too_short` means exactly the same thing, so one string serves both and
    it is NOT a gap.
  */
  signUpTitle: 'أنشئي حسابك', // design:1357
  signUpSub: 'محفظتك في أمارا — صالحة في كل فروع أمارا', // design:1357
  signUpAction: 'إنشاء الحساب', // design:1358
  signUpWorking: en.signUpWorking, // AR GAP
  signUpPassHint: '٦ أحرف على الأقل', // design:1355
  signUpConfirmPass: 'تأكيد كلمة المرور', // design:1354
  signUpConsentTerms: 'أوافق على شروط المحفظة وسياسة الاسترجاع وإشعار الخصوصية.', // design:1317
  signUpConsentWa: 'أرسلوا لي الإيصالات وتأكيد المواعيد على واتساب.', // design:1318
  signUpHaveAccount: 'لديكِ حساب بالفعل؟', // design:1358
  signUpLogIn: 'سجّلي الدخول', // design:1358

  signUpErrEmpty: en.signUpErrEmpty, // AR GAP — :1363 names the username; see signInErrEmpty
  signUpErrConsent: 'يرجى الموافقة على شروط المحفظة للمتابعة.', // design:1319
  signUpErrMismatch: 'كلمتا المرور غير متطابقتين.', // design:1363
  signUpErrShort: 'استخدمي ٦ أحرف على الأقل.', // design:1363 — also the server's password_too_short
  signUpErrRegistered: en.signUpErrRegistered, // AR GAP
  signUpErrTermsChanged: en.signUpErrTermsChanged, // AR GAP
  signUpErrTermsReload: en.signUpErrTermsReload, // AR GAP
  signUpErrPhone: en.signUpErrPhone, // AR GAP
  signUpErrSalon: en.signUpErrSalon, // AR GAP
  signUpErrTermsMissing: en.signUpErrTermsMissing, // AR GAP
  signUpErrBusy: en.signUpErrBusy, // AR GAP
  signUpErrTooMany: en.signUpErrTooMany, // AR GAP
  signUpErrFailed: en.signUpErrFailed, // AR GAP
  signUpOffline: en.signUpOffline, // AR GAP
  signUpTermsFailedTitle: en.signUpTermsFailedTitle, // AR GAP
  signUpTermsFailedBody: en.signUpTermsFailedBody, // AR GAP

  // --------------------------------------------------------------- failure --
  errorTitle: en.errorTitle, // AR GAP
  errorBody: en.errorBody, // AR GAP
  tryAgain: 'حاولي مرة أخرى', // design:1378
  referencePrefix: en.referencePrefix, // AR GAP
  blockedTitle: en.blockedTitle, // AR GAP

  // --------------------------------------------------------------- offline --
  offlineBanner: en.offlineBanner, // AR GAP
  // INVENTED in English and not yet translated — DECISIONS.md § "The offline
  // cold-load sentence". Aliased rather than guessed at: writing Arabic no
  // native speaker wrote is the thing AR_GAPS exists to prevent.
  offlineColdTitle: en.offlineColdTitle, // AR GAP
  offlineColdBody: en.offlineColdBody, // AR GAP
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
  navShop: 'المتجر', // design:1340
  navPay: 'ادفعي', // design:1340 — feminine imperative

  // ------------------------------------------------------------ shop & cart --
  /*
    THE WHOLE HAPPY PATH IS IN THE BUNDLE, and it is feminine throughout — ادفعي,
    أضيفي, اشحني, مستواكِ. Lifted character for character from the `ar` block at
    :1341-1344, plus the three the design composes inline at :1457 and :1460-1461,
    which are equally the designer's words and are cited on their own lines.

    Money interpolations stay WESTERN inside Arabic sentences: the designer writes
    `تم الدفع 22.000 د.ك` that way herself (:1457), which is non-negotiable #12
    working as specified rather than an exception to it. `cartItems` is a COUNT and
    is therefore Eastern.
  */
  shopTitle: 'المتجر', // design:1341
  shopSub: 'ادفعي من محفظتك · الاستلام من الصالون.', // design:1341
  shopAdd: 'أضيفي', // design:1342
  shopNote: 'مشتريات المتجر تُحتسب كزيارة نحو مستواكِ التالي.', // design:1342
  cartTitle: 'سلتك', // design:1343
  // design:1343 — منتج is the counted noun the design uses for every quantity.
  cartItems: (n) => `${ea(n)} منتج`,
  qtyValue: (n) => ea(n), // a count, so Eastern
  cartTotal: 'الإجمالي', // design:1343
  cartPayFrom: 'الدفع من المحفظة', // design:1343
  cartShortBy: (amount) => `الرصيد أقل بـ ${amount}`, // design:1344
  cartEmptyTitle: 'سلتك فارغة', // design:1344
  cartEmptyBody: 'أضيفي منتجاً للبدء.', // design:1344
  cartPayCta: (amount) => `ادفعي ${amount} من المحفظة`, // design:1461
  cartTopUpCta: 'اشحني محفظتك', // design:1460
  shopPaidToast: (amount) => `تم الدفع ${amount} من المحفظة · أُضيفت زيارة`, // design:1457

  // The six states below have no Arabic source — the design's shop cannot fail.
  shopEmptyTitle: en.shopEmptyTitle, // AR GAP
  shopEmptyBody: en.shopEmptyBody, // AR GAP
  shopOffTitle: en.shopOffTitle, // AR GAP
  shopOffBody: en.shopOffBody, // AR GAP
  cartStaleBody: en.cartStaleBody, // AR GAP
  shopOrderFailed: en.shopOrderFailed, // AR GAP
  /*
    ليست ترجمة: مكتوبة، ومُدرجة في AR_UNVERIFIED. تحل محل `signUpOffline` الذي كان
    يظهر بالإنجليزية في سلة عربية — راجعي copy/types.ts.
  */
  cartOffline: 'لا يوجد اتصال. راجعي طلباتي قبل المحاولة مرة أخرى.',

  /**
   * DELIVERY — item 7. NOT IN THE BUNDLE, and owed in Arabic just as much as in
   * English: non-negotiable #12, Arabic is a first-class layout and not a
   * translation pass.
   *
   * Every key here is WRITTEN rather than transcribed, so every key here is in
   * `AR_UNVERIFIED` — it renders Arabic, and no designer wrote it. That is a
   * different failure mode from `AR_GAPS`: a gap shows English and is obvious, an
   * unverified string shows plausible Arabic that may be wrong.
   *
   * FEMININE ADDRESS FORMS THROUGHOUT, matching `اختاري المصففة` and `أضيفي
   * منتجاً` above: `اختاري` (choose), `أضيفي` (add), `احفظي` (save), `اتركي`
   * (leave), `سمّيها` (name it) are all feminine imperatives.
   *
   * COUNTS ARE EASTERN (`orderStep` goes through `ea`), money is Western and
   * never comes through this file. No string below carries a Western digit —
   * `digits.test.ts` asserts that over the whole set.
   */
  fulfilTitle: 'كيف تحبين أن تستلميها؟',
  fulfilPickup: 'أستلمها بنفسي',
  fulfilDelivery: 'توصيل',
  // يذكر الصالون ولا يذكر الفرع — لا يوجد فرع استلام في العقد.
  fulfilPickupBody: 'استلميها من الصالون عند جهوزها.',
  fulfilDeliveryBody: 'سنوصلها إلى أحد عناوينك المحفوظة.',
  addressChooseTitle: 'التوصيل إلى',
  addressAddCta: 'أضيفي عنواناً',
  addressEdit: 'تعديل',
  addressDelete: 'حذف',
  addressEmptyTitle: 'لا عناوين محفوظة',
  addressEmptyBody: 'أضيفي عنواناً وسنحفظه للمرة القادمة.',
  addressLoadFailed: 'لم نتمكن من تحميل عناوينك.',
  addressWriteFailed: 'لم نتمكن من الحفظ. حاولي مرة أخرى.',
  addressWriteOffline: 'لا يوجد اتصال، فلم نتمكن من تأكيد الحفظ.',
  addressGoneBody: 'هذا العنوان لم يعد محفوظاً.',

  addressFormNewTitle: 'عنوان جديد',
  addressFormEditTitle: 'تعديل العنوان',
  addrLabel: 'سمّيها',
  addrBlock: 'القطعة',
  addrStreet: 'الشارع',
  addrBuilding: 'المبنى',
  addrFloor: 'الطابق',
  addrApartment: 'الشقة',
  addrArea: 'المنطقة',
  addrGovernorate: 'المحافظة',
  addrInstructions: 'ملاحظات للمندوب',
  addrOptional: '(اختياري)',
  /*
    الجملة التي تقوم عليها هذه الميزة كلها: الحقل الفارغ يُحفظ فارغاً، ولا يُملأ
    بنسخة عن حقل آخر. راجعي `copy/en.ts` وسجل PRIOR-ART.
  */
  addrOptionalNote: 'اتركي ما لا تحتاجينه فارغاً.',
  addrInstructionsPh: 'اقرعي الجرس مرتين، لو سمحت',
  addressSaveCta: 'احفظي العنوان',
  addressMissingBody: 'سمّي العنوان، واملأي القطعة والشارع والمبنى.',
  addressDeleteTitle: 'حذف هذا العنوان؟',
  addressDeleteBody: 'الطلبات التي سبق إرسالها إليه لا تتأثر.',
  addressDeleteCta: 'حذف',
  addressDeleteCancel: 'الاحتفاظ به',

  cartNoAddress: 'اختاري إلى أين نوصلها.',
  // ليست جملة فشل: المبلغ خُصم فعلاً والطلب موجود.
  cartAlreadyPlaced: 'طلبك مُسجّل بالفعل. راجعي طلباتي.',

  ordersCta: 'طلباتي',
  ordersTitle: 'طلباتي',
  ordersEmptyTitle: 'لا طلبات بعد',
  ordersEmptyBody: 'كل ما تشترينه من المتجر يظهر هنا.',
  ordersLoadFailed: 'لم نتمكن من تحميل طلباتك.',
  // ثلاث حالات، وطريقتا استلام. `closed` هي النهاية في الحالتين.
  orderPickupPreparing: 'قيد التحضير',
  orderPickupReady: 'جاهز للاستلام',
  orderPickupClosed: 'تم الاستلام',
  orderDeliveryPreparing: 'قيد التحضير',
  orderDeliveryReady: 'جاهز وفي الطريق',
  orderDeliveryClosed: 'تم التوصيل',
  orderStep: (step, total) => `الخطوة ${ea(step)} من ${ea(total)}`,
  orderDeliveringTo: 'إلى',
  orderAddressFixed: 'العنوان الذي أدخلتِه عند الطلب.',
  orderCollectAt: 'الاستلام من الصالون',
  orderTruncated: 'نعرض أحدث طلباتك.',

  bookTitle: 'احجزي', // design:1347
  bookStep: (step, total) => `الخطوة ${ea(step)} من ${ea(total)}`, // design:1876

  chooseService: 'اختاري الخدمة', // design:1347
  chooseArtist: 'اختاري المصففة', // design:1347
  chooseDay: 'اختاري اليوم', // design:1348
  // AR GAP. The branch step's label is invented in English and deliberately
  // NOT derived here — see copy/types.ts § chooseBranch for why this one goes
  // to the worksheet rather than in as plausible Arabic.
  chooseBranch: en.chooseBranch, // AR GAP

  // The branch strip. NOT IN THE BUNDLE, and owed in Arabic just as much as in
  // English -- non-negotiable #12, Arabic is a first-class layout and not a
  // translation pass. Feminine address forms throughout, matching
  // `اختاري المصففة` above: `مصففات أخريات` is feminine plural, and
  // `جرّبي` is the feminine imperative.
  branchFilterAll: 'كل الفروع',
  branchFilterOther: 'مصففات أخريات',
  branchFilterOtherNote: 'لم يحدّد الصالون فرعاً لهؤلاء المصففات بعد.',
  branchEmptyTitle: 'لا مصففات في هذا الفرع',
  branchEmptyBody: 'جرّبي فرعاً آخر، أو اختاري كل الفروع لرؤية الجميع.',
  artistsEmptyTitle: 'لا مصففات متاحة للحجز',
  artistsEmptyBody: 'لم يُضِف هذا الصالون أي مصففة للحجز بعد.',
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
 * This is the worksheet for the native-speaker review. It stands at 86 entries
 * and almost every one of them is state or refusal copy, which is not an accident —
 * see the section notes below.
 *
 * THE COUNT IN THIS COMMENT HAS NOW BEEN WRONG FOUR TIMES. It read
 * "twenty-four", then "76" — the latter while asserting, in the same sentence,
 * that it "is recomputed here rather than carried". It was carried. STATUS.md
 * said 74 and DECISIONS.md said 31 at the same moment the array held 81, and one
 * of those figures had already been repeated into two lane briefs.
 *
 * AND IT WAS WRONG AGAIN WHEN THIS SLICE OPENED THE FILE. The prose said 81; the
 * array at `ae6eefc` held 84. Nobody wrote 81 down wrongly — three entries were
 * added by later slices that did not re-read the sentence three lines above the
 * list they were appending to. Which is the point: this number cannot be
 * maintained by intention, only by the `awk` below. DECISIONS.md queue item 4
 * still says 81 and is now stale by five; that file is trunk-owned, so it is
 * REPORTED rather than edited here.
 *
 * The list itself cannot rot — `i18n/digits.test.ts` asserts it is EXACTLY the
 * set of keys where `ar` and `en` are identical, so adding a gap without listing
 * it fails, and translating one without delisting it fails too. Only this prose
 * can rot, and it does, because prose does not recompile. Recount before quoting
 * it:
 *
 *     awk '/^export const AR_GAPS = \[/{f=1;next} /^\] as const;/{f=0} f' \
 *       apps/wallet/src/copy/ar.ts | grep -c "^  '"
 */
export const AR_GAPS = [
  'qrAria',
  'loadingAria',
  'quoteFailedTitle',
  'quoteFailedBody',
  'gatewayFailedTitle',
  'gatewayFailedBody',
  'gatewayFailedRetry',
  'activityShowMore',
  'emptyActivityTitle',
  'emptyActivityBody',
  'emptyActivityAction',
  'rowPending',
  'rowFailed',
  'signInWorking',
  'signInErrEmpty',
  'signInOffline',
  'resetSub',
  'resetErrEmpty',
  'resetWorking',
  // ---- signup. The design's Create account screen has no server behind it, so
  // its Arabic covers the three client-side validations and none of the ten
  // refusals `POST /auth/member/signup` can answer with. `signUpErrShort` is
  // absent from this list on purpose: the design wrote it, and it is the same
  // sentence the server's `password_too_short` needs.
  'signUpWorking',
  'signUpErrEmpty',
  'signUpErrRegistered',
  'signUpErrTermsChanged',
  'signUpErrTermsReload',
  'signUpErrPhone',
  'signUpErrSalon',
  'signUpErrTermsMissing',
  'signUpErrBusy',
  'signUpErrTooMany',
  'signUpErrFailed',
  'signUpOffline',
  'signUpTermsFailedTitle',
  'signUpTermsFailedBody',
  'errorTitle',
  'errorBody',
  'referencePrefix',
  'blockedTitle',
  'offlineBanner',
  'offlineColdTitle',
  'offlineColdBody',
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
  // The branch STEP's micro label. Invented in English, and the one string in
  // the branch family that did NOT go in as unverified Arabic — see the note
  // in AR_UNVERIFIED about the seven that did.
  'chooseBranch',
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
  // ---- shop. The design's shop prototype has no server behind it, so its Arabic
  // covers the whole happy path and none of the six ways the flow can refuse.
  // Note what is NOT here: every string on the happy path, including the three the
  // design composes inline, is lifted.
  'shopEmptyTitle',
  'shopEmptyBody',
  'shopOffTitle',
  'shopOffBody',
  'cartStaleBody',
  'shopOrderFailed',
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
  // Membership. The subject substitution decision 86 ruled on, plus the three
  // strings where a per-salon value replaced a phrase the design had fitted to
  // one hardcoded reward.
  'tierFine',
  'tierRequirement(11+)',
  'stampsGoal',
  'stampRule3',
  /**
   * THE BRANCH STRIP — SEVEN KEYS THAT SHOULD HAVE BEEN LISTED HERE AND WERE
   * NOT, and this is my own omission from the branch-picker slice rather than
   * somebody else's.
   *
   * They were written in Arabic, flagged in a COMMENT above them in `ar.ts`
   * ("NOT IN THE BUNDLE, and owed in Arabic just as much as in English"), and
   * never added to this list. A comment is not a worksheet: the native-speaker
   * review reads `AR_UNVERIFIED`, so seven strings the design never wrote would
   * have gone to production unreviewed while the comment sat two lines above
   * them saying so.
   *
   * That is the same shape as the `nameAr` defect `domain/names.ts` documents at
   * length — a true comment that nothing acts on — and worth naming as such,
   * because this list is only worth anything if it is where the flags actually
   * go. Added now rather than in the branch-picker slice's own commit, and
   * reported.
   */
  'branchFilterAll',
  'branchFilterOther',
  'branchFilterOtherNote',
  'branchEmptyTitle',
  'branchEmptyBody',
  'artistsEmptyTitle',
  'artistsEmptyBody',
  /**
   * DELIVERY — item 7. All 51 keys, because the design bundle draws no delivery
   * UI at all: the shop was collection-only when it was made, `shopSub` says
   * "pick up at the salon" and the receipt row says "Pickup".
   *
   * So unlike the shop's six failure states — which are in `AR_GAPS` because
   * they render ENGLISH — these render written Arabic with feminine address
   * forms, and the whole set needs a native speaker. `fulfilTitle`,
   * `addrOptionalNote` and the six order-status sentences are the ones to read
   * first: the first sets the register for the section, the second is the
   * sentence the entire feature turns on, and the six are what a customer reads
   * while she waits.
   */
  'fulfilTitle',
  'fulfilPickup',
  'fulfilDelivery',
  'fulfilPickupBody',
  'fulfilDeliveryBody',
  'addressChooseTitle',
  'addressAddCta',
  'addressEdit',
  'addressDelete',
  'addressEmptyTitle',
  'addressEmptyBody',
  'addressLoadFailed',
  'addressWriteFailed',
  'addressWriteOffline',
  'addressGoneBody',
  'addressFormNewTitle',
  'addressFormEditTitle',
  'addrLabel',
  'addrBlock',
  'addrStreet',
  'addrBuilding',
  'addrFloor',
  'addrApartment',
  'addrArea',
  'addrGovernorate',
  'addrInstructions',
  'addrOptional',
  'addrOptionalNote',
  'addrInstructionsPh',
  'addressSaveCta',
  'addressMissingBody',
  'addressDeleteTitle',
  'addressDeleteBody',
  'addressDeleteCta',
  'addressDeleteCancel',
  'cartNoAddress',
  'cartAlreadyPlaced',
  'ordersCta',
  'ordersTitle',
  'ordersEmptyTitle',
  'ordersEmptyBody',
  'ordersLoadFailed',
  // The cart's offline chip. It was `signUpOffline` — English, and the wrong
  // sentence — until driving an Arabic checkout against a dead API showed it.
  'cartOffline',
  'orderPickupPreparing',
  'orderPickupReady',
  'orderPickupClosed',
  'orderDeliveryPreparing',
  'orderDeliveryReady',
  'orderDeliveryClosed',
  'orderStep',
  'orderDeliveringTo',
  'orderAddressFixed',
  'orderCollectAt',
  'orderTruncated',
] as const;
