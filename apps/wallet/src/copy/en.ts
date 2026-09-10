/**
 * English copy, verbatim from design/AVO Wallet Home.dc.html and
 * design/AVO States.dc.html. CLAUDE.md: "Keep the copy verbatim. Both languages.
 * Product copy is written; do not paraphrase."
 *
 * The Arabic sibling is `ar.ts`. Both fill the `Copy` interface in `types.ts`,
 * so a key added here that is not added there does not compile.
 */

import { formatCountdown, type RewardKey, type TierName } from '@avo/types';
import type { Copy } from './types';
import { clockTime } from '../domain/activity';
import { durationParts } from '../domain/happyHour';

/** design/avo-promotions.js:19-24 — the six rewards a window can carry. */
const REWARD_EN: Record<RewardKey, string> = {
  x2stamp: 'Double stamps',
  x3stamp: 'Triple stamps',
  x2visit: 'Double visit credit',
  topup10: '+10% top-up bonus',
  topup20: '+20% top-up bonus',
  credit3: '3 KD wallet credit',
};

/** design:1143 — the weekday names the "next happy hour" line is built from. */
const DAYS_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const TIER_NAME: Record<TierName, string> = {
  bronze: 'Bronze',
  silver: 'Silver',
  gold: 'Gold',
  black: 'Black',
};

/** design:1611 — the English month names the policy stamp is built from. */
const MONTHS_EN = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/**
 * "2026-07-01" → "1 July 2026".
 *
 * PARSED AS A STRING, NOT AS A DATE. The design does
 * `new Date(effectiveFrom + 'T00:00')`, which resolves in the device's zone —
 * so a phone set to UTC−03:00 renders `effectiveFrom: '2026-07-01'` as
 * "30 June 2026" and shows a customer an effective date one day before the one
 * she agreed to. `effectiveFrom` is a calendar date in the contract
 * ("YYYY-MM-DD"), not an instant, and calendar dates have no zone.
 *
 * A value that is not a calendar date is returned untouched rather than turned
 * into "NaN undefined NaN": the API is the authority on this string.
 */
export function formatEffectiveFrom(effectiveFrom: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(effectiveFrom.trim());
  if (!match) return effectiveFrom;
  const [, year, month, day] = match;
  const name = MONTHS_EN[Number(month) - 1];
  if (!name) return effectiveFrom;
  return `${Number(day)} ${name} ${year}`;
}

export const en: Copy = {
  // header
  greeting: (firstName) => `Good evening, ${firstName}`,

  // wallet card
  balanceLabel: 'Wallet balance',
  tierName: TIER_NAME,
  tierHint: (visits, tier) =>
    `${visits} ${visits === 1 ? 'visit' : 'visits'} to ${TIER_NAME[tier]}`,
  stampsHint: (have, target) => `${have} of ${target} stamps`,
  stampsPill: (have, target) => `${have}/${target}`,
  tierLadder: (current, next) =>
    next ? `${TIER_NAME[current]} → ${TIER_NAME[next]}` : TIER_NAME[current],

  // payment code
  qrTitle: 'Show to pay',
  qrHint: 'Refreshes in',
  sec: 's',
  tapEnlarge: 'Tap to enlarge',
  memberIdPrefix: 'ID · ',
  qrAria: (memberId, seconds) =>
    `Payment code for member ${memberId}, refreshes in ${seconds} seconds`,
  loadingAria: 'Loading your wallet',
  qrBig: 'Show this to the cashier', // design:1172
  qrBigSub: 'Screen brightened for scanning', // design:1172

  // ------------------------------------------------------------ happy hour --
  happyReward: REWARD_EN,
  happyLiveTitle: (reward) => `Happy hour · ${reward}`, // design:1136
  happyNextTitle: (reward) => `Next happy hour · ${reward}`, // design:1145
  happyLiveSub: (branch, endsAt) => `${branch} · until ${endsAt}`, // design:1137
  happyNextSub: (branch, day, from, to) =>
    // design:1146-1150 — "today" when it opens later the same salon day, the
    // weekday otherwise.
    `${branch} · ${day === null ? 'today' : DAYS_EN[day]} ${from}–${to}`,
  /**
   * `formatCountdown` from @avo/types, not a copy of its wording.
   *
   * Its own docstring says "the wallet banner and the dashboard row share this",
   * and a salon looking at its dashboard while a customer looks at her wallet is
   * the case where two near-identical strings become a support call. Arabic
   * cannot use it — it is English-only and hard-codes "left" — so only English
   * delegates, and `happyHour.test.ts` pins the two together at every minute
   * value the banner can hold.
   */
  happyLiveLabel: (minutes) => formatCountdown(minutes),
  happyNextLabel: (minutes) => {
    const { hours, minutes: mins } = durationParts(minutes);
    return hours > 0 ? `in ${hours}h ${mins}m` : `in ${mins}m`; // design:1151
  },
  happyClock: (hhmm) => `now ${hhmm}`, // design:1140
  happyAllBranches: 'All branches', // design/avo-promotions.js:272

  // branches
  branchEarnLabel: 'Earning by branch',
  branchNote: 'One wallet — valid at all branches.',
  standardEarning: 'Standard earning',
  visitsMultiplier: (n) => `${n}× visits`,
  stampsMultiplier: (n) => `${n}× stamps`,
  topupBoost: (percent) => `+${percent}% top-ups`,

  // top-up card
  topupTitle: 'Top up',
  tierBonusBadge: (tier, percent) => `${TIER_NAME[tier]} · +${percent}% bonus`,
  tierBonusExplain: (tier, percent) =>
    `Your ${TIER_NAME[tier]} tier adds ${percent}% free credit to every top-up.`,
  stampsBadge: (target) => `Collect ${target} · get 1 free`,
  stampsExplain: 'Top up any amount — every salon visit adds a stamp.',
  continuePay: 'Continue to payment',

  // top-up sheet — choose
  payTitle: 'Choose payment',
  youPay: 'Pay',
  // The bonus row's label carries the tier, because "Bonus" alone reads as
  // AVO's money. It is the salon's: "Bonus credit and tier rewards are funded by
  // Amara Salon, not AVO."
  bonusRow: (tier) => (tier ? `${TIER_NAME[tier]} bonus` : 'Tier bonus'),
  lands: 'Lands in wallet',
  methodLabel: 'Payment method',
  payBtn: 'Pay',
  payMethod: {
    knet: 'KNET',
    card: 'Visa · Mastercard',
    applepay: 'Apple Pay',
  },
  mostUsed: 'Most used in Kuwait', // design:1405

  // top-up sheet — the quote itself failed, before any intent existed
  quoteFailedTitle: "We couldn't start that top-up",
  quoteFailedBody: 'Nothing was charged. Try again in a moment.',

  // top-up sheet — redirect. Not dismissible; there is no close control here.
  payRedirectTitle: (method) => `Opening ${method}`,
  payRedirectSub:
    'Finish the payment on your bank page — you will come back here automatically.',
  payDontClose: 'Keep this screen open until the bank sends you back.',

  /*
    INVENTED — see copy/types.ts for why none of the existing failure sentences
    could be reused, and DECISIONS.md § "The offline cold-load sentence" for the
    precedent that authorises writing one.

    "still waiting" is the load-bearing phrase. The intent is real, unpaid and
    unconsumed, and a customer who is told "nothing happened" starts a second
    top-up — which is the behaviour that leaves a trail of orphaned intents
    behind a phone whose browser will not open.
  */
  gatewayFailedTitle: 'The payment page did not open',
  gatewayFailedBody:
    'Nothing was charged and your top-up is still waiting. Open the payment page again, or choose another method.',
  gatewayFailedRetry: 'Open the payment page',

  // top-up sheet — the four outcomes. Four sets of words, deliberately.
  doneTitle: 'Top-up complete',
  doneMsg: 'Your wallet is ready to use at any branch.',
  failTitle: 'Payment not completed',
  failMsg: 'Your bank declined the transaction. Nothing was charged.',
  cancelTitle: 'Payment cancelled',
  cancelMsg: 'You cancelled on the KNET page. Nothing was charged.',
  pendingTitle: 'Confirming with your bank',
  pendingMsg:
    'This can take up to a minute. Do not pay again — the credit appears as soon as the bank confirms.',

  rAmount: 'Amount',
  rMethod: 'Method',
  rRef: 'Reference',
  rStatus: 'Status',
  rBalance: 'New balance',
  rCharged: 'Charged',
  vNothing: 'Nothing charged',
  vPending: 'Awaiting bank',
  otherMethod: 'Choose another method',
  backToWallet: 'Back to wallet',
  done: 'Done',

  // activity
  activityLabel: 'Activity',
  emptyActivityTitle: 'Nothing here yet',
  emptyActivityBody: 'Top-ups, visits and purchases will appear here.',
  emptyActivityAction: 'Top up your wallet',
  rowPending: 'Pending',
  rowFailed: 'Failed',

  // membership — design:343-384. Strings at :1173, :1232 and :1258-1263.
  membersLabel: 'Membership', // design:1232
  current: 'Current', // design:1232
  // design:1173, authority clause corrected per DECISIONS.md #86. The design
  // appends "Salon" to the name ("Amara Salon"); interpolating that would build
  // part of a proper noun the salon did not choose, and would read "Amara Salon
  // Salon" for a salon already named that way. The name goes in bare.
  tierFine: (salon) =>
    `Bonus credit and tier rewards are funded by ${salon}, not AVO. ` +
    'AVO can change these tiers at any time; your existing balance is never affected.',
  // design:1716-1719. "0 visits · no bonus" for a rung that earns nothing;
  // "4+ visits · +10%" for one that does.
  tierRequirement: (minVisits, bonusPercent) =>
    bonusPercent <= 0
      ? `${minVisits} visits · no bonus`
      : `${minVisits}+ visits · +${bonusPercent}%`,
  tierBonusIllustration: (base, credited) => `${base} → ${credited}`,

  stampCardTitle: 'Your stamp card', // design:1258
  stampCountOf: (have, target) => `${have} of ${target}`, // design:1657
  // design:1258 writes "your blow-dry", the salon's reward in a shortened form
  // the prototype could hardcode. The salon's own string goes in unaltered —
  // lowercasing it would corrupt a proper noun like "Moroccan Hammam".
  stampsGoal: (remaining, reward) => `${remaining} more visits and your ${reward} is on us.`,
  stampRule1: 'One stamp per salon visit, whatever you spend.', // design:1261
  stampRule2: 'A shop purchase counts as a visit too.', // design:1262
  // design:1263 is "…claim the free blow-dry." With the reward interpolated,
  // "the" collides with a title-cased reward ("claim the Free blow-dry"), so it
  // takes the same possessive `stampsGoal` uses one line above.
  stampRule3: (reward) => `Your card resets after you claim your ${reward}.`,

  // sign-in — design:1168, :1246, :1248
  salonName: 'Amara',
  walletWord: 'Wallet',
  signInTitle: 'Welcome back',
  signInSub: 'Log in to your Amara wallet',
  signInAction: 'Log in',
  /**
   * INVENTED — the design's button carries no busy label. Same pattern as the
   * scanner's `chargeWorking`, and the button is disabled for the duration so a
   * second submit cannot mint a second session.
   */
  signInWorking: 'Logging in…',
  /**
   * INVENTED, and it replaces a string the design does have.
   *
   * `errEmpty` at :1256 reads "Enter your username and password." in English and
   * :1363 "أدخلي اسم المستخدم وكلمة المرور." in Arabic. Both name a username, and
   * there is no member username in this system — see api/auth.ts for the whole
   * conflict. So the design's own validation copy could not be lifted, and this is
   * the only string on the screen that had to be written rather than taken.
   */
  signInErrEmpty: 'Enter your phone number and password.',
  /**
   * INVENTED. `offlineBanner` is the wrong sentence here: it promises the last
   * update, and at sign-in there is no last update to show. A wrong password and a
   * dead connection must not read the same (interaction-spec §4).
   */
  signInOffline: 'No connection. You need one to log in.',
  // design:1249 — the link into signup, now that there is somewhere to go.
  signInNoAccount: 'New here?',
  signInCreateOne: 'Create account',
  signInForgot: 'Forgot password?', // design:104

  // the reset-request screen — design § FORGOT
  resetTitle: 'Reset your password', // design's resetTitle
  /**
   * ADAPTED, not the design's sentence verbatim: the design says "Enter your
   * username — we'll send a reset link to your WhatsApp." and there is no member
   * username in this system (see api/auth.ts). The identity is the phone, so the
   * sentence names the phone — the same correction SignInScreen made to its
   * field label, recorded rather than silent.
   */
  resetSub: "Enter your phone number — we'll send a reset link to your WhatsApp.",
  resetErrEmpty: 'Enter your phone number.', // INVENTED — see types.ts
  resetWorking: 'Sending…', // INVENTED busy label, like signInWorking
  resetBtn: 'Send reset link', // design's resetBtn
  resetSentTitle: 'Check WhatsApp', // design's resetSentTitle
  // Rendered on EVERY 202, matched or not — see copy/types.ts for why it must
  // never become a conditional.
  resetSentSub: 'A secure reset link is on its way to your registered number.', // design's resetSentSub
  backToLogin: 'Back to log in', // design's backToLogin

  // signup — design:1250, :1251, :1210-1212, :1247-1248, :1256
  signUpTitle: 'Create your account',
  signUpSub: 'Your Amara wallet — valid at every Amara branch',
  signUpAction: 'Create account',
  /** INVENTED — the design's button carries no busy label, same as `signInWorking`. */
  signUpWorking: 'Creating your account…',
  signUpPassHint: 'At least 6 characters',
  signUpConfirmPass: 'Confirm password',
  signUpConsentTerms: 'I agree to the Wallet terms, the refund policy and the privacy notice.',
  signUpConsentWa: 'Send me receipts and appointment confirmations on WhatsApp.',
  signUpHaveAccount: 'Already have an account?',
  signUpLogIn: 'Log in',

  /**
   * INVENTED, and it replaces a string the design does have — the same trade
   * `signInErrEmpty` makes. `errEmpty` at :1256 reads "Enter your username and
   * password." and names a field that does not exist here; the name is also
   * required in this build where the design marked it optional, so the sentence
   * had to change on both counts.
   */
  signUpErrEmpty: 'Enter your name, phone number and password.',
  signUpErrConsent: 'Please accept the wallet terms to continue.',
  signUpErrMismatch: "Passwords don't match.",
  signUpErrShort: 'Use at least 6 characters.',
  /**
   * INVENTED. The server's own sentence adds "or contact support", which is right
   * advice for somebody who does not recognise the number but not for the ordinary
   * case — she has an account and this screen puts Log in one tap away, so it
   * points there instead.
   */
  signUpErrRegistered: 'You already have an account with that number.',
  /**
   * INVENTED, and this is the string the whole `policy_version_stale` design exists
   * for: it has to read as "the terms changed, here they are again" rather than as
   * a failure, because nothing went wrong and she has only to re-read.
   */
  signUpErrTermsChanged: 'The terms have been updated. Please read them and accept again.',
  signUpErrTermsReload: "We couldn't confirm which terms you were shown. Here they are again.",
  /** INVENTED. The example is the shape `parseE164` accepts. */
  signUpErrPhone: 'Enter your number with its country code, like +96599123456.',
  signUpErrSalon: 'This app is not set up for a salon yet.',
  signUpErrTermsMissing: "The wallet terms aren't published yet, so accounts can't be created.",
  signUpErrBusy: 'Too many attempts. Wait a moment and try again.',
  signUpErrTooMany: 'Too many accounts have been created from this connection. Try again later.',
  signUpErrFailed: "We couldn't create your account. This is on our side.",
  signUpOffline: 'No connection. You need one to create an account.',
  signUpTermsFailedTitle: "We couldn't load the terms",
  signUpTermsFailedBody: 'You need to read them before creating an account.',

  // failure — "we failed", so it retries
  errorTitle: "We couldn't load your wallet",
  errorBody: 'Your balance and history are safe. This is on our side.',
  tryAgain: 'Try again',
  referencePrefix: 'Reference · ',

  // failure — "you can't do that", so it explains
  blockedTitle: "We can't show this wallet",

  /**
   * INVENTED, authorised in DECISIONS.md § "The offline cold-load sentence —
   * inventing it is AUTHORISED". The bundle has exactly one customer offline
   * string, `offlineBanner`, and it is a STALE-DATA sentence: on a cold load
   * there is no last update to show, so it would be a lie. `errorBody`'s "This
   * is on our side" is the other wrong answer — it blames us for her signal.
   *
   * The third such string, after `signInOffline` and `signUpOffline`, and marked
   * the same way so the native-speaker review picks all three up together.
   *
   * The retry stays: reconnecting is something she can actually do, which is
   * what separates this from `blockedTitle`.
   */
  offlineColdTitle: 'No connection',
  offlineColdBody: 'Reconnect and try again. Nothing is lost.',

  // offline
  offlineBanner: 'No connection · showing your last update',
  lastUpdated: (relative) => `Last updated ${relative}`,
  qrOfflineTitle: 'Payment code unavailable offline',
  qrOfflineBody: 'Reconnect to show a valid code at the salon.',

  // stale — a refresh failed over data already on screen
  staleBanner: (atEpochMs) => `Showing your wallet from ${clockTime(atEpochMs, 'en')} — refresh failed`,

  // payment code failed while online
  qrFailedTitle: 'Payment code unavailable',
  qrFailedBody: 'Try again to show a valid code at the salon.',

  // relative time
  justNow: 'just now',
  minutesAgo: (n) => `${n} min ago`,
  hoursAgo: (n) => `${n} ${n === 1 ? 'hour' : 'hours'} ago`,
  daysAgo: (n) => `${n} ${n === 1 ? 'day' : 'days'} ago`,

  today: 'Today',
  yesterday: 'Yesterday',

  // transaction kinds — the activity row titles
  txKind: {
    topup: 'Top-up',
    charge: 'Service',
    deposit_hold: 'Deposit held',
    deposit_return: 'Deposit returned',
    shop: 'Shop order',
    adjustment: 'Adjustment',
  },

  txMethod: {
    knet: 'KNET',
    card: 'Card',
    applepay: 'Apple Pay',
    wallet: 'Wallet balance',
  },

  // transaction detail sheet
  txRefLabel: 'Reference',
  txHelp: 'Something looks wrong? Message the salon on WhatsApp.',
  txClose: 'Close',
  txReport: 'Report a problem with this payment',
  txYouPaid: 'You paid', // design:1565
  txPaidWith: 'Paid with',
  txPaidFrom: 'Paid from',
  txWalletBalance: 'Wallet balance',
  txLanded: 'Landed in wallet',
  // The design says "Silver bonus". A Transaction does not record which tier
  // funded it, and a member who has climbed since would be shown her *current*
  // tier against an old percentage. Neutral until the contract carries it.
  txTierBonus: (tier) => (tier ? `${TIER_NAME[tier]} bonus` : 'Tier bonus'),
  txBranch: 'Branch',
  txBranchOnline: 'Online',
  txReturnedTo: 'Returned to',
  txAmountRow: 'Amount',
  txStatus: {
    settled: 'Completed',
    pending: 'Pending',
    failed: 'Failed',
    cancelled: 'Cancelled',
  },

  plus: (label) => `plus ${label}`,
  minus: (label) => `minus ${label}`,

  // ══════════════════════════════════════════════════════════════════ book ══

  navHome: 'Home', // design:1233
  navBook: 'Book', // design:1233
  navShop: 'Shop', // design:1233
  navPay: 'Pay', // design:1233

  // ------------------------------------------------------------ shop & cart --
  shopTitle: 'Shop', // design:1234
  shopSub: 'Pay from your wallet · pick up at the salon.', // design:1234
  shopAdd: 'Add', // design:1235
  shopNote: 'Shop purchases count as a visit toward your next tier.', // design:1235
  cartTitle: 'Your cart', // design:1236
  // design:945/1236 — `{{ cartCount }} {{ t.items }}`.
  cartItems: (n) => `${n} ${n === 1 ? 'item' : 'items'}`,
  qtyValue: (n) => `${n}`,
  cartTotal: 'Total', // design:1236
  cartPayFrom: 'Paid from wallet', // design:1236
  cartShortBy: (amount) => `Balance too low by ${amount}`, // design:1237
  cartEmptyTitle: 'Your cart is empty', // design:1237
  cartEmptyBody: 'Add a product to get started.', // design:1237
  cartPayCta: (amount) => `Pay ${amount} from wallet`, // design:1461
  cartTopUpCta: 'Top up to continue', // design:1460
  shopPaidToast: (amount) => `Paid ${amount} from wallet · visit added`, // design:1457

  /**
   * INVENTED — every one of these is a state the design's shop has no server to
   * reach. `emptyTitle`/`emptySub` at :1237 are the empty CART and are used above;
   * an empty CATALOGUE is a different fact told to a different person, and reusing
   * "Add a product to get started" for it would tell a customer to add something
   * the salon does not sell.
   */
  shopEmptyTitle: 'Nothing in the shop yet',
  shopEmptyBody: 'This salon has no products for sale right now.',
  shopOffTitle: 'The shop is closed',
  shopOffBody: 'This salon does not sell products through AVO.',
  /**
   * INVENTED, and the one state trunk singled out. A product retired while she
   * shopped answers `invalid_products` naming its id, and the honest sentence says
   * WHICH thing has gone rather than "something went wrong" — she is holding it.
   */
  cartStaleBody: (names) => `${names} has been removed from the shop. Take it out of your cart to pay.`,
  shopOrderFailed: "We couldn't complete your order. Nothing has been charged.",

  bookTitle: 'Book', // design:1240
  bookStep: (step, total) => `Step ${step} of ${total}`, // design:1876

  chooseService: 'Choose a service', // design:1240
  chooseArtist: 'Choose an artist', // design:1240
  chooseDay: 'Pick a day', // design:1241

  // The branch strip. NOT IN THE BUNDLE -- see copy/types.ts for why each of
  // these reads the way it does, and that all seven are owed to the copywriter.
  // "All branches" is the one borrowed word: `branchNote` below already says
  // "One wallet -- valid at all branches" (design:1163), so "all branches" is
  // established product vocabulary rather than a new coinage.
  branchFilterAll: 'All branches',
  branchFilterOther: 'Other artists',
  branchFilterOtherNote: "The salon hasn't listed a branch for these artists yet.",
  branchEmptyTitle: 'No artists at this branch',
  branchEmptyBody: 'Try another branch, or choose All branches to see everyone.',
  artistsEmptyTitle: 'No artists to book with',
  artistsEmptyBody: "This salon hasn't added anyone to book with yet.",
  morning: 'Morning', // design:1241
  evening: 'Evening', // design:1241
  review: 'Review', // design:1241

  availLive: 'Live availability', // design:1491
  availSalon: 'Availability by salon hours', // design:1492
  /**
   * NOT DESIGN-SOURCED, and it could not be: the design's artist fixture has a
   * static `live` boolean and never models a calendar that is *supposed* to be
   * live and is not. The API does — `fallbackReason` — and it is the one
   * difference the customer can act on, because the times she is being offered
   * are the salon's rather than the artist's.
   */
  availFallback: "Showing the salon's own hours — this artist's calendar could not be reached.",

  svcRow: 'Service', // design:1242
  artistRow: 'Artist', // design:1242
  whenRow: 'When', // design:1242
  depositHeld: 'Deposit held', // design:1242
  depositNote: (remainder) => `Held from your wallet · remainder ${remainder} paid at the salon.`, // design:1539
  depShort: 'Top up your wallet to hold the deposit.', // design:1243

  bookContinue: 'Continue', // design:1554
  bookReviewCta: 'Review booking', // design:1550
  bookConfirmCta: (deposit) => `Confirm · hold ${deposit}`, // design:1553
  bookTopUpCta: 'Top up to book', // design:1552

  booked: "You're booked", // design:1243
  waConfirm: 'Confirmation sent on WhatsApp', // design:1244
  viewHome: 'View on home', // design:1244
  cancelPolicy:
    'Free to cancel up to 24h before — the deposit returns to your wallet automatically.', // design:1245

  bookedToast: (deposit) => `Booked · ${deposit} deposit held`, // design:1547
  rescheduleToast: 'Pick a new time — your deposit carries over', // design:1773
  cancelledToast: (deposit) => `Appointment cancelled · ${deposit} deposit returned`, // design:1774

  bookEmptyDayTitle: 'Nothing on this day',
  bookEmptyDayBody: 'This artist is not working then. Try another day.',
  bookFullDayTitle: 'Fully booked',
  bookFullDayBody: 'Every time on this day is taken. Try another day or another artist.',
  slotTakenTitle: 'That time has gone',
  slotTakenBody: 'Somebody booked it a moment before you. Pick another one.',
  bookingOffTitle: 'This salon does not take appointments',
  bookingOffBody: 'Nothing was held from your wallet.',
  bookShortBy: (shortfall) => `Balance too low by ${shortfall}`, // design:1237 `shortMsg`

  // ═════════════════════════════════════════════════ upcoming appointment ══

  upcomingLabel: 'Upcoming', // design:1178
  upDeposit: (deposit) => `${deposit} held`, // design:1179
  upWith: (artist) => `with ${artist}`, // design:1178
  reschedule: 'Reschedule', // design:1180
  cancel: 'Cancel', // design:1179
  reschedNote: 'Free until an hour before. After that the deposit stays with the salon.', // design:1180
  changeClosedTitle: 'Too close to the appointment',
  changeClosedBody:
    'An appointment can be changed free until an hour before it starts. After that the deposit stays with the salon.',
  noUpcomingTitle: 'No appointment booked',
  noUpcomingBody: 'Book a service and your wallet holds the deposit.',
  noUpcomingAction: 'Book',

  // ══════════════════════════════════════════════════════════════ account ══
  // design:1182-1231, verbatim.
  accountTitle: 'Account',
  back: '‹ Back',
  acctProfile: 'Profile',
  acctNotifs: 'Notifications',
  acctLegal: 'Wallet & policies',
  acctHelp: 'Help',
  followTitle: (salonName) => `Follow ${salonName}`, // design:1840
  appVersion: 'AVO Beauty · v1.0', // design:475

  rowEdit: 'Edit',
  rowName: 'Name',
  rowPhone: 'Phone',
  rowEmail: 'Email',
  rowPassword: 'Password',
  rowLang: 'Language',
  rowChange: 'Change',
  rowAddEmail: 'Add an email',
  rowLangValue: 'English', // design:1832

  nPush: 'App notifications',
  nPushSub: 'Booking reminders, top-ups and tier changes',
  nWa: 'WhatsApp messages',
  nWaSub: 'Receipts and appointment confirmations',
  nRemind: 'Appointment reminder',
  nRemindSub: 'Two hours before your slot',
  nReceipt: 'Email receipts',
  nReceiptSub: 'An itemised receipt by email for every payment, top-up and refund',
  nOffers: 'Salon offers',
  nOffersSub: 'Occasional promotions from Amara. Off by default.',
  notifErr: "We couldn't load your notification settings.",
  notifSaveErr: "That didn't save, so the switch has been put back. Try again.",

  // design:1213 is the static half ("Last updated 1 July 2026"); design:1615
  // composes the whole stamp including the version.
  legalUpdated: (effectiveFrom, version) =>
    `Last updated ${formatEffectiveFrom(effectiveFrom)} · v${version}`,
  walletFine:
    'Your wallet holds prepaid credit for Amara Salon only. Credit does not expire, cannot be transferred to another salon, and is not a bank deposit.',
  logOut: 'Log out',
  deleteAcct: 'Delete my account',

  contactCta: 'Contact us',
  contactCtaSub: 'A question, a charge that looks wrong, or anything else',

  pfTitle: 'Edit profile',
  pfSub: 'Your name, and how the salon reaches you.',
  pfEmailPh: 'name@email.com',
  pfPhoneNote:
    'Your phone number is how you log in. Changing it needs a code sent to the new number.',
  pfSave: 'Save changes',
  pfSaved: 'Profile updated',
  pfErrName: 'Enter your name.',
  pfErrPhone: 'Enter a valid phone number.',
  pfErrEmail: 'That email address does not look right.',
  cOptional: '(optional)',

  vfTitle: 'Confirm your new number',
  vfSub: (phone) => `Enter the 4-digit code we sent to ${phone}`, // design:1191, :1842
  vfConfirm: 'Confirm number',
  vfResend: 'Send again',
  vfBack: 'Back',
  vfErr: 'Enter the 4-digit code.',
  vfSent: 'Code sent',

  pwTitle: 'Change password',
  pwSub: 'You stay logged in on this phone. Other devices are signed out.',
  pwCurLabel: 'Current password',
  pwNewLabel: 'New password',
  pwConfLabel: 'Confirm new password',
  pwSave: 'Update password',
  pwSaved: 'Password updated',
  pwForgot: 'I forgot my current password',
  pwErrCur: 'Enter your current password.',
  pwErrShort: 'Use at least 6 characters.',
  pwErrSame: 'Choose a password different from your current one.',
  pwErrMatch: "The two new passwords don't match.",
  pwShow: 'Show', // design:1806
  pwHide: 'Hide', // design:1806
  passHint: 'At least 6 characters',

  contactTitle: 'Contact us',
  contactSub: 'Tell us what happened and we will come back to you.',
  cTopicLabel: 'What is it about?',
  cMsgLabel: 'Your message',
  cMsgPh: 'A few lines is plenty. Dates and amounts help.',
  cRefLabel: 'Receipt or reference',
  cViaLabel: 'Reply to me on',
  cViaWa: 'WhatsApp',
  cViaEmail: 'Email',
  cSend: 'Send message',
  cErr: 'Pick a topic and write a short message.',
  cRouteSalon: 'Salon',
  cRouteAvo: 'AVO',
  cSentTitle: 'Message sent',
  cSentRef: 'Your reference',
  cSentDone: 'Done',
  cSentSalon: 'Amara has your message and will reply on WhatsApp.',
  cSentAvo: 'AVO support has your message.',

  deleteTitle: 'Delete your account?',
  deleteBody:
    'Your profile, visit history and loyalty progress are removed within 30 days. Anything already paid to the salon is not reversed.',
  deleteBalance: 'Remaining balance',
  deleteKeep: 'Keep account',
  deleteGo: 'Request deletion',
  deleteFine:
    'Wallet credit cannot be paid out in cash. Spend the remaining balance at the salon, or ask them to settle it with you, before the account closes.',
  deletePendingTitle: 'Deletion requested',
  // `days` is the server's `graceDays`. "You stay signed in" is not a courtesy
  // line — the API deliberately does not revoke her sessions, so the sentence
  // describes real behaviour and is what makes the cancel door findable.
  deletePendingBody: (days) =>
    `Your profile, visit history and loyalty progress are removed within ${days} ${
      days === 1 ? 'day' : 'days'
    }. You stay signed in until then, and you can still change your mind.`,
  deleteCancel: 'Cancel deletion request',
  deleteCancelled: 'Deletion cancelled',
  deleteScheduledTitle: 'Deletion scheduled',
  // NOTHING HAS BEEN DELETED, and the first four words say so. `erasureScheduled`
  // is false and stays false until the retention job exists, so "your data is
  // being removed" would describe work nobody has done. The date derives from the
  // server's `erasureDueAt`, never requestedAt plus a local 30.
  //
  // Takes the CALENDAR DATE and formats its own, exactly like `legalUpdated` and
  // for the reason `staleBanner` exists: a date formatted by the caller in the
  // app's language, dropped into a sentence that is still English because it is
  // an AR_GAP, produces "…stay as they are until ١٧ سبتمبر ٢٠٢٦." — Eastern
  // digits inside an English sentence, which reads as a bug in both languages.
  // The script has to follow the sentence, so the sentence does the formatting.
  deleteScheduledBody: (dueOn) =>
    `Nothing has been deleted yet. Your profile and your balance stay as they are until ${formatEffectiveFrom(
      dueOn,
    )}. You can cancel any time before then.`,
  deleteCheckFailed: "We couldn't check whether your account is scheduled for deletion.",

  // design/AVO Wallet Home.dc.html:1232 — the English build offers Arabic.
  langSwitch: 'العربية',
  restartNeeded: 'Restart the app to switch direction',
};
