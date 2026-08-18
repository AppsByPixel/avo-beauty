/**
 * English copy, verbatim from design/AVO Wallet Home.dc.html and
 * design/AVO States.dc.html. CLAUDE.md: "Keep the copy verbatim. Both languages.
 * Product copy is written; do not paraphrase."
 *
 * The Arabic sibling is `ar.ts`. Both fill the `Copy` interface in `types.ts`,
 * so a key added here that is not added there does not compile.
 */

import type { TierName } from '@avo/types';
import type { Copy } from './types';
import { clockTime } from '../domain/activity';

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

  // failure — "we failed", so it retries
  errorTitle: "We couldn't load your wallet",
  errorBody: 'Your balance and history are safe. This is on our side.',
  tryAgain: 'Try again',
  referencePrefix: 'Reference · ',

  // failure — "you can't do that", so it explains
  blockedTitle: "We can't show this wallet",

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

  bookTitle: 'Book', // design:1240
  bookStep: (step, total) => `Step ${step} of ${total}`, // design:1876

  chooseService: 'Choose a service', // design:1240
  chooseArtist: 'Choose an artist', // design:1240
  chooseDay: 'Pick a day', // design:1241
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

  // design/AVO Wallet Home.dc.html:1232 — the English build offers Arabic.
  langSwitch: 'العربية',
  restartNeeded: 'Restart the app to switch direction',
};
