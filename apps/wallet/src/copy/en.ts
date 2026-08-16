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
};

export type Copy = typeof en;
