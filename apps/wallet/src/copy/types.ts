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

  // the language switch itself
  langSwitch: string;
  /**
   * Shown only on native, only when the direction actually has to change.
   * `I18nManager.forceRTL` does not take effect until the app restarts.
   */
  restartNeeded: string;
}
