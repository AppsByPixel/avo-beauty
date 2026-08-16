/**
 * English copy, verbatim from design/AVO Wallet Home.dc.html and
 * design/AVO States.dc.html. CLAUDE.md: "Keep the copy verbatim. Both languages.
 * Product copy is written; do not paraphrase."
 *
 * Arabic is a first-class layout, not a translation pass (non-negotiable #12).
 * The strings are lifted in this same file's `ar` sibling when the language
 * switch lands; this build renders English only and the switch is not yet wired,
 * which is noted in the lane report rather than faked with a half-mirrored RTL.
 */

export const en = {
  // header
  greeting: (firstName: string) => `Good evening, ${firstName}`,

  // wallet card
  balanceLabel: 'Wallet balance',
  // The currency unit is deliberately NOT here. It comes off `formatMoney` in
  // @avo/types so that it changes with the language along with the rest of the
  // money string, instead of being a per-app literal that Arabic forgets to
  // translate. See src/components/Money.tsx.
  tierHint: (visits: number, tier: string) =>
    `${visits} ${visits === 1 ? 'visit' : 'visits'} to ${tier}`,
  stampsHint: (have: number, target: number) => `${have} of ${target} stamps`,

  // payment code
  qrTitle: 'Show to pay',
  qrHint: 'Refreshes in',
  sec: 's',
  tapEnlarge: 'Tap to enlarge',
  memberIdPrefix: 'ID · ',

  // branches
  branchEarnLabel: 'Earning by branch',
  branchNote: 'One wallet — valid at all branches.',
  standardEarning: 'Standard earning',
  visitsMultiplier: (n: number) => `${n}× visits`,
  stampsMultiplier: (n: number) => `${n}× stamps`,
  topupBoost: (percent: number) => `+${percent}% top-ups`,

  // top-up card
  topupTitle: 'Top up',
  tierBonusBadge: (tier: string, percent: number) => `${tier} · +${percent}% bonus`,
  tierBonusExplain: (tier: string, percent: number) =>
    `Your ${tier} tier adds ${percent}% free credit to every top-up.`,
  stampsBadge: (target: number) => `Collect ${target} · get 1 free`,
  stampsExplain: 'Top up any amount — every salon visit adds a stamp.',
  continuePay: 'Continue to payment',

  // top-up sheet — choose
  payTitle: 'Choose payment',
  youPay: 'Pay',
  // The bonus row's label carries the tier, because "Bonus" alone reads as
  // AVO's money. It is the salon's: "Bonus credit and tier rewards are funded by
  // Amara Salon, not AVO."
  bonusRow: (tier: string) => `${tier} bonus`,
  lands: 'Lands in wallet',
  methodLabel: 'Payment method',
  payBtn: 'Pay',
  mostUsed: 'Most used in Kuwait',
  payMethod: {
    knet: 'KNET',
    card: 'Visa · Mastercard',
    applepay: 'Apple Pay',
  } as const,

  // top-up sheet — the quote itself failed, before any intent existed
  quoteFailedTitle: "We couldn't start that top-up",
  quoteFailedBody: 'Nothing was charged. Try again in a moment.',

  // top-up sheet — redirect. Not dismissible; there is no close control here.
  payRedirectTitle: (method: string) => `Opening ${method}`,
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

  // failure — "we failed", so it retries
  errorTitle: "We couldn't load your wallet",
  errorBody: 'Your balance and history are safe. This is on our side.',
  tryAgain: 'Try again',
  referencePrefix: 'Reference · ',

  // failure — "you can't do that", so it explains
  blockedTitle: "We can't show this wallet",

  // offline
  offlineBanner: 'No connection · showing your last update',
  lastUpdated: (relative: string) => `Last updated ${relative}`,
  qrOfflineTitle: 'Payment code unavailable offline',
  qrOfflineBody: 'Reconnect to show a valid code at the salon.',

  // stale — a refresh failed over data already on screen
  staleBanner: (at: string) => `Showing your wallet from ${at} — refresh failed`,

  // payment code failed while online
  qrFailedTitle: 'Payment code unavailable',
  qrFailedBody: 'Try again to show a valid code at the salon.',

  // relative time
  justNow: 'just now',
  minutesAgo: (n: number) => `${n} min ago`,
  hoursAgo: (n: number) => `${n} ${n === 1 ? 'hour' : 'hours'} ago`,
  daysAgo: (n: number) => `${n} ${n === 1 ? 'day' : 'days'} ago`,

  // transaction kinds — the activity row titles
  txKind: {
    topup: 'Top-up',
    charge: 'Service',
    deposit_hold: 'Deposit held',
    deposit_return: 'Deposit returned',
    shop: 'Shop order',
    adjustment: 'Adjustment',
  } as const,

  txMethod: {
    knet: 'KNET',
    card: 'Card',
    applepay: 'Apple Pay',
    wallet: 'Wallet balance',
  } as const,

  // transaction detail sheet
  txRefLabel: 'Reference',
  txHelp: 'Something looks wrong? Message the salon on WhatsApp.',
  txClose: 'Close',
  txReport: 'Report a problem with this payment',
  txPaidWith: 'Paid with',
  txPaidFrom: 'Paid from',
  txWalletBalance: 'Wallet balance',
  txLanded: 'Landed in wallet',
  // The design says "Silver bonus". A Transaction does not record which tier
  // funded it, and a member who has climbed since would be shown her *current*
  // tier against an old percentage. Neutral until the contract carries it.
  txTierBonus: 'Tier bonus',
  txBranch: 'Branch',
  txBranchOnline: 'Online',
  txReturnedTo: 'Returned to',
  txAmountRow: 'Amount',
  txStatus: {
    settled: 'Completed',
    pending: 'Pending',
    failed: 'Failed',
    cancelled: 'Cancelled',
  } as const,
};

export type Copy = typeof en;
