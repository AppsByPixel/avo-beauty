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

  // design/AVO Wallet Home.dc.html:1232 — the English build offers Arabic.
  langSwitch: 'العربية',
  restartNeeded: 'Restart the app to switch direction',
};
