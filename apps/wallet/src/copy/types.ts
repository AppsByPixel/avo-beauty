/**
 * The shape both languages must fill.
 *
 * This is an interface rather than `typeof en` so that Arabic cannot silently
 * drop a key: `ar.ts` is declared `: Copy` and the compiler rejects a partial.
 * Where Arabic genuinely has no source in the design bundle the English string
 * is used **explicitly**, listed in `AR_GAPS`, and a test asserts the list and
 * the file agree. A missing translation is therefore a tracked item, never a
 * silent fallback.
 *
 * WHY THE TIER FUNCTIONS TAKE A `TierName` AND NOT A DISPLAY STRING.
 *
 * English composes "6 visits to Gold" from a label. Arabic cannot: the design
 * writes `٦ زيارات للذهبية`, where the preposition لـ and the article الـ have
 * merged into لل. `'ل' + 'الذهبية'` produces `لالذهبية`, which is not a word.
 * The same happens to the bonus line — `مستواكِ الفضي` needs the *adjective*
 * form of the tier, not its noun. So each language is handed the tier itself and
 * does its own grammar, which is the whole point of non-negotiable #12:
 * "Arabic is a first-class layout, not a translation pass."
 */

import type { PaymentMethod, TierName, Transaction } from '@avo/types';

export interface Copy {
  // header
  greeting(firstName: string): string;

  // wallet card
  balanceLabel: string;
  // The currency unit is deliberately NOT here. It comes off `formatMoney` in
  // @avo/types so that it changes with the language along with the rest of the
  // money string, instead of being a per-app literal that Arabic forgets to
  // translate. See src/components/Money.tsx.
  tierName: Record<TierName, string>;
  tierHint(visits: number, tier: TierName): string;
  stampsHint(have: number, target: number): string;
  /** The pill on the card in stamps mode: "3/8" — a count, so Eastern in AR. */
  stampsPill(have: number, target: number): string;
  /** "Silver → Gold" — the arrow points the way the language reads. */
  tierLadder(current: TierName, next: TierName | null): string;

  // payment code
  qrTitle: string;
  qrHint: string;
  sec: string;
  tapEnlarge: string;
  memberIdPrefix: string;
  /** Spoken, not shown. Seconds are a count. */
  qrAria(memberId: string, seconds: number): string;
  /** The skeleton's single announcement. */
  loadingAria: string;

  // branches
  branchEarnLabel: string;
  branchNote: string;
  standardEarning: string;
  visitsMultiplier(n: number): string;
  stampsMultiplier(n: number): string;
  topupBoost(percent: number): string;

  // top-up card
  topupTitle: string;
  tierBonusBadge(tier: TierName, percent: number): string;
  tierBonusExplain(tier: TierName, percent: number): string;
  stampsBadge(target: number): string;
  stampsExplain: string;
  continuePay: string;

  // top-up sheet — choose
  payTitle: string;
  youPay: string;
  /** The calculation card's middle row. `null` when no tier can be named. */
  bonusRow(tier: TierName | null): string;
  lands: string;
  methodLabel: string;
  payBtn: string;
  payMethod: Record<PaymentMethod, string>;
  /**
   * The pill next to KNET. Design-sourced in both languages
   * (AVO Wallet Home.dc.html:1405), and a copy key rather than a literal on
   * MethodOption — it was a bare English string in domain/topup.ts and shipped
   * untranslated into the Arabic sheet until a screenshot caught it.
   */
  mostUsed: string;

  // top-up sheet — the quote failed before an intent existed
  quoteFailedTitle: string;
  quoteFailedBody: string;

  // top-up sheet — redirect. Not dismissible; there is no close control here.
  payRedirectTitle(method: string): string;
  payRedirectSub: string;
  payDontClose: string;

  // top-up sheet — the four outcomes. Four sets of words, deliberately.
  doneTitle: string;
  doneMsg: string;
  failTitle: string;
  failMsg: string;
  cancelTitle: string;
  cancelMsg: string;
  pendingTitle: string;
  pendingMsg: string;

  rAmount: string;
  rMethod: string;
  rRef: string;
  rStatus: string;
  rBalance: string;
  rCharged: string;
  vNothing: string;
  vPending: string;
  otherMethod: string;
  backToWallet: string;
  done: string;

  // activity
  activityLabel: string;
  emptyActivityTitle: string;
  emptyActivityBody: string;
  emptyActivityAction: string;
  /** The row's " · Pending" / " · Failed" suffix. */
  rowPending: string;
  rowFailed: string;

  // failure — "we failed", so it retries
  errorTitle: string;
  errorBody: string;
  tryAgain: string;
  referencePrefix: string;

  // failure — "you can't do that", so it explains
  blockedTitle: string;

  // offline
  offlineBanner: string;
  lastUpdated(relative: string): string;
  qrOfflineTitle: string;
  qrOfflineBody: string;

  // stale — a refresh failed over data already on screen
  /**
   * Takes the EPOCH, not a formatted clock string, and formats it itself.
   *
   * This is the rule the whole i18n layer rests on, and it was learned here:
   * an earlier version formatted the time with `clockTime(at, lang)` and passed
   * the string in, which produced
   *
   *     "Showing your wallet from ٢٣:٤٩ — refresh failed"
   *
   * — Eastern digits inside an English sentence, because the sentence is an
   * AR GAP and the number was not. Half-translated is worse than either, and
   * the same argument as the offline QR applies: a code that will not scan is
   * worse than no code.
   *
   * With the epoch, the digits follow the STRING rather than the app language.
   * The English implementation formats Western and the Arabic one formats
   * Eastern, so a gap is automatically self-consistent and stops being one the
   * moment the string is translated — with no list to keep in sync.
   */
  staleBanner(atEpochMs: number): string;

  // payment code failed while online
  qrFailedTitle: string;
  qrFailedBody: string;

  // relative time
  justNow: string;
  minutesAgo(n: number): string;
  hoursAgo(n: number): string;
  daysAgo(n: number): string;

  // dates — "Today · 6:12 PM" / "اليوم · ٦:١٢ م"
  today: string;
  yesterday: string;

  // transaction kinds — the activity row titles
  txKind: Record<Transaction['kind'], string>;
  txMethod: Record<PaymentMethod | 'wallet', string>;

  // transaction detail sheet
  txRefLabel: string;
  txHelp: string;
  txClose: string;
  txReport: string;
  /**
   * The receipt's paid row. NOT the same string as `youPay` on the calculation
   * card: the card is an instruction before paying ("Pay" / "تدفعين") and the
   * receipt is a record after it ("You paid" / "المبلغ المدفوع"). The design
   * writes them differently in both languages — AVO Wallet Home.dc.html:1565
   * and :1579 against :1176 and :1283 — and collapsing them into one key loses
   * the tense in Arabic, where تدفعين is second-person present.
   */
  txYouPaid: string;
  txPaidWith: string;
  txPaidFrom: string;
  txWalletBalance: string;
  txLanded: string;
  /** The receipt's bonus row. Carries the tier when the transaction names one. */
  txTierBonus(tier: TierName | null): string;
  txBranch: string;
  txBranchOnline: string;
  txReturnedTo: string;
  txAmountRow: string;
  txStatus: Record<Transaction['status'], string>;

  // screen-reader phrasing for signed money, which is not a copy string in
  // English but must be one in Arabic — "plus"/"minus" are words.
  plus(label: string): string;
  minus(label: string): string;

  // ══════════════════════════════════════════════════════════════════ book ══

  // bottom navigation
  navHome: string;
  navBook: string;

  // book — shell
  bookTitle: string;
  /** "Step 2 of 4" — a count, so Eastern in Arabic. */
  bookStep(step: number, total: number): string;

  // book — step headings, design:1240-1241
  chooseService: string;
  chooseArtist: string;
  chooseDay: string;
  morning: string;
  evening: string;
  review: string;

  // book — the artist rows' availability badge, design:1491-1492
  availLive: string;
  availSalon: string;
  /**
   * Shown on the GRID, not the artist row, when a google-sourced artist's
   * calendar could not actually be read and the salon's own hours were offered
   * instead. The API returns `fallbackReason`; this is what it means to a
   * customer, which is that the times shown are wider than the artist's own.
   */
  availFallback: string;

  // book — the review rows, design:1242
  svcRow: string;
  artistRow: string;
  whenRow: string;
  depositHeld: string;
  /**
   * "Held from your wallet · remainder 3.000 KD paid at the salon."
   * design:1537-1539. Takes the FORMATTED remainder, because the unit changes
   * with the language and only `formatMoney` knows that.
   */
  depositNote(remainder: string): string;
  depShort: string;

  // book — the call to action, design:1550-1554
  bookContinue: string;
  bookReviewCta: string;
  /** "Confirm · hold 5.000 KD" — money, so formatted by the caller. */
  bookConfirmCta(deposit: string): string;
  bookTopUpCta: string;

  // book — confirmed, design:1243-1245
  booked: string;
  waConfirm: string;
  viewHome: string;
  /**
   * "Free to cancel up to 24h before…", design:1245.
   *
   * ⚠️ THIS STRING CONTRADICTS `reschedNote` AND THE SERVER. See ar.ts and the
   * BookScreen's confirmed step: the design says 24 hours here and one hour at
   * design:1180, the build plan and the API implement ONE hour, and the copy is
   * left verbatim in both places rather than quietly edited. Reported.
   */
  cancelPolicy: string;

  // book — toasts, design:1547, 1773-1774
  bookedToast(deposit: string): string;
  rescheduleToast: string;
  cancelledToast(deposit: string): string;

  // book — the states the design bundle has no Arabic for
  bookEmptyDayTitle: string;
  bookEmptyDayBody: string;
  bookFullDayTitle: string;
  bookFullDayBody: string;
  /** 409 slot_taken — somebody else took it between the tap and the POST. */
  slotTakenTitle: string;
  slotTakenBody: string;
  /** 409 booking_not_enabled — the module is off for this salon. */
  bookingOffTitle: string;
  bookingOffBody: string;
  /** The shortfall banner. Takes the formatted shortfall — the SERVER's number. */
  bookShortBy(shortfall: string): string;

  // ═════════════════════════════════════════════════ upcoming appointment ══

  upcomingLabel: string;
  /** "5.000 KD held" / "عربون 5.000 د.ك" — money, formatted by the caller. */
  upDeposit(deposit: string): string;
  /** "with Rana" / "مع رنا" — design:1178, 1285. */
  upWith(artist: string): string;
  reschedule: string;
  cancel: string;
  /** The one-hour rule, stated inline. design:1180, 1287. */
  reschedNote: string;
  /** 409 change_window_closed — the server refused, and says when it closed. */
  changeClosedTitle: string;
  changeClosedBody: string;
  /** The empty state where the Upcoming card would be. */
  noUpcomingTitle: string;
  noUpcomingBody: string;
  noUpcomingAction: string;

  // ══════════════════════════════════════════════════════════════ account ══

  // account — shell and section headings
  accountTitle: string;
  back: string;
  acctProfile: string;
  acctNotifs: string;
  acctLegal: string;
  acctHelp: string;
  /** "Follow Amara" / "تابعي أمارا" — the salon name comes from the API. */
  followTitle(salonName: string): string;
  /** Product wordmark and build. Identical in both languages by design. */
  appVersion: string;

  // account — profile rows
  rowEdit: string;
  rowName: string;
  rowPhone: string;
  rowEmail: string;
  rowPassword: string;
  rowLang: string;
  /** The password row's value column. Never the password — non-negotiable #6. */
  rowChange: string;
  /** The email row's value when there is no email yet. */
  rowAddEmail: string;
  /** The language row's value: the language currently in force, in its own name. */
  rowLangValue: string;

  // account — the five notification switches
  nPush: string;
  nPushSub: string;
  nWa: string;
  nWaSub: string;
  nRemind: string;
  nRemindSub: string;
  nReceipt: string;
  nReceiptSub: string;
  nOffers: string;
  nOffersSub: string;
  /**
   * The five switches could not be read. NOT a generic error: five switches
   * drawn from defaults look like her settings and are not, so the section says
   * it could not read them rather than showing a wrong `offers: false`.
   */
  notifErr: string;
  /** One switch's write failed and it has been put back where it was. */
  notifSaveErr: string;

  // account — wallet & policies
  /**
   * The document header stamp: "Last updated 1 July 2026 · v3".
   *
   * Takes the RAW `effectiveFrom` ("YYYY-MM-DD") and the version, not a
   * pre-formatted date — the same rule as `staleBanner`. Arabic needs its own
   * month names and Eastern digits, and a caller that formatted the date would
   * have to know which. Non-negotiable #10 makes this the only string the wallet
   * itself contributes to a policy document; every other character is the API's.
   */
  legalUpdated(effectiveFrom: string, version: number): string;
  /** The fine print under the policy list. Not a legal document — a summary. */
  walletFine: string;
  logOut: string;
  deleteAcct: string;

  // account — help
  contactCta: string;
  contactCtaSub: string;

  // edit profile sheet
  pfTitle: string;
  pfSub: string;
  pfEmailPh: string;
  pfPhoneNote: string;
  pfSave: string;
  pfSaved: string;
  pfErrName: string;
  pfErrPhone: string;
  pfErrEmail: string;
  /** "(optional)" — used by both the email field and the receipt reference. */
  cOptional: string;

  // phone confirmation — the number is the login identity
  vfTitle: string;
  vfSub(phone: string): string;
  vfConfirm: string;
  vfResend: string;
  vfBack: string;
  vfErr: string;
  vfSent: string;

  // change password sheet
  pwTitle: string;
  /**
   * "You stay logged in on this phone. Other devices are signed out."
   *
   * A security claim in front of a customer, and it is true: the API revokes
   * every other session on success. See src/api/account.ts § changePassword.
   */
  pwSub: string;
  pwCurLabel: string;
  pwNewLabel: string;
  pwConfLabel: string;
  pwSave: string;
  pwSaved: string;
  pwForgot: string;
  pwErrCur: string;
  pwErrShort: string;
  pwErrSame: string;
  pwErrMatch: string;
  /** The show/hide control on the password sheet. */
  pwShow: string;
  pwHide: string;
  /** "At least 6 characters" — Eastern digit in Arabic; a count, not money. */
  passHint: string;

  // contact us sheet
  contactTitle: string;
  contactSub: string;
  cTopicLabel: string;
  cMsgLabel: string;
  cMsgPh: string;
  cRefLabel: string;
  cViaLabel: string;
  cViaWa: string;
  cViaEmail: string;
  cSend: string;
  cErr: string;
  /** The chip next to a topic. Read from the topic, never sent back — #11. */
  cRouteSalon: string;
  cRouteAvo: string;
  cSentTitle: string;
  cSentRef: string;
  cSentDone: string;
  /** Chosen by the route the SERVER returned, not the one the client displayed. */
  cSentSalon: string;
  cSentAvo: string;

  // delete account sheet
  deleteTitle: string;
  deleteBody: string;
  deleteBalance: string;
  deleteKeep: string;
  deleteGo: string;
  deleteFine: string;
  /**
   * The confirmed state, and the cancel door.
   *
   * NO DESIGN SOURCE. The design's sheet has both buttons call `closeDelete`
   * (design:902-903) and never reaches a server, so it has copy for no outcome
   * at all — neither the two refusals nor the request actually landing. The two
   * refusals use the SERVER's own message, following ChangePasswordSheet; these
   * three are the ones the client has to supply, and all three are in AR_GAPS.
   */
  deletePendingTitle: string;
  /** The grace window is the SERVER's number — `graceDays`, not a local 30. */
  deletePendingBody(days: number): string;
  deleteCancel: string;
  deleteCancelled: string;

  // the language switch itself
  langSwitch: string;
  /**
   * Shown only on native, only when the direction actually has to change.
   * `I18nManager.forceRTL` does not take effect until the app restarts.
   */
  restartNeeded: string;
}
