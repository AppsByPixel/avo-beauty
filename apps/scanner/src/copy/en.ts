/**
 * Every string the scanner renders, verbatim from
 * design/AVO Staff Scanner.dc.html and design/AVO States.dc.html.
 *
 * CLAUDE.md: "Keep the copy verbatim. Product copy is written; do not
 * paraphrase." Each entry below carries the design line it came from, so a
 * future edit can be checked against the source rather than against memory.
 *
 * ENGLISH ONLY, DELIBERATELY.
 * ---------------------------
 * design/README.md § Known gaps 1 — Arabic is the customer app only. The
 * scanner is the phone staff carry, and the staff-facing surfaces in the bundle
 * are written in English alone. So unlike apps/wallet there is no `ar.ts` next
 * to this file and no language provider: adding one would be inventing product
 * copy nobody wrote.
 *
 * THE CURRENCY UNIT IS NOT IN THIS FILE.
 * --------------------------------------
 * It comes off `formatMoney()` / `formatFils()` in @avo/types so it stays tied
 * to the amount. A local `kd: 'KD'` is the exact mistake the skill file calls
 * out (.claude/skills/screen-from-design/SKILL.md §2).
 */

export const copy = {
  // ------------------------------------------------------------------ PIN --
  /** :77 */
  pinSubtitle: 'Staff scanner',
  /** :79 */
  pinPrompt: 'Enter your PIN',
  /** :86 */
  pinFootnote: 'Scan only · no dashboard access',
  /**
   * The lockout and the refusal. The design has no error state on the PIN pad —
   * it accepts any four digits (:53 "Enter any 4 digits to reach the home
   * screen"). These come from the API's own messages, which are written:
   * api/src/routes/auth.ts BAD_CREDENTIALS and the `pin_locked` throw.
   */
  pinWrong: 'Those details do not match. Try again.',
  pinLocked: 'This PIN is locked. A manager can unlock it, or try again later.',
  pinLockedTitle: 'PIN locked',
  pinTooMany: 'Too many attempts from this device. Wait a few minutes and try again.',
  pinTooManyTitle: 'Too many attempts',
  pinAttemptsLeft: (n: number) => `${n} ${n === 1 ? 'attempt' : 'attempts'} left before this PIN locks.`,

  // ----------------------------------------------------------------- home --
  /** :97 — "{first} · signed in" */
  signedIn: (first: string) => `${first} · signed in`,
  /** :99 */
  signOut: 'Sign out',
  /** :102 */
  greeting: (first: string) => `Hello, ${first}`,
  /** :102 */
  greetingSub: 'What would you like to do?',
  /** :107 */
  scan: 'Scan',
  scanSub: "Scan a customer's wallet QR and charge",
  /** :111 */
  bookings: 'My bookings',
  bookingsSub: 'Upcoming appointments & client contacts',
  /** :116 */
  schedule: 'My schedule',
  scheduleSub: "Set the hours you're available to book",
  /** :120 */
  charges: "Today's charges",
  /** :775 — the three variants, by authority */
  chargesSubVoid: 'Review or void a charge you just took',
  chargesSubRead: 'Review the charges you took today',
  chargesSubLocked: 'Needs a senior to switch this on',
  /** :121 — the padlock's tooltip */
  chargesLockedHint: 'Not enabled for your account',
  /** :125 */
  appFooter: 'AVO Beauty · Staff',

  // ----------------------------------------------------------------- scan --
  /** :185 */
  home: '‹ Home',
  /** :188 */
  scanTitle: 'Show me the QR',
  scanPrompt: "Point at the customer's wallet code",
  /**
   * interaction-spec.md §3, verbatim: the reduced-motion replacement for the
   * scanner line is "a static frame and the text 'Point at the customer's
   * code'". A different sentence from `scanPrompt` above, and that is what the
   * spec says.
   */
  scanPromptReducedMotion: "Point at the customer's code",
  /** :196 */
  cantScan: "Can't scan? Find member manually",
  /** Camera permission — no design state exists; see ScanScreen. */
  cameraDenied: 'Camera access is off',
  cameraDeniedBody:
    'The scanner needs the camera to read a wallet code. Turn it on in Settings, or find the member manually.',
  cameraAsk: 'Allow camera access',

  // --------------------------------------------------------------- lookup --
  /** :209 */
  backToScan: '‹ Back to scan',
  /** :210 */
  lookupEyebrow: 'Manual lookup',
  /** :212 */
  lookupTitle: 'Find a member',
  /** :213 */
  lookupSub:
    "For a dead phone or a camera that won't focus. Search by name, phone number or member ID.",
  /** :214 */
  lookupPlaceholder: 'Name, phone or ID',
  /** :229 */
  lookupNoneTitle: 'No member found',
  /** :230 */
  lookupNoneBody: 'Check the number, or ask her to sign up in the AVO app first.',
  /** :235 */
  lookupLogged:
    'Manual lookups are logged with your name. The customer gets a WhatsApp confirmation for every charge taken this way.',
  /** :734 — "ID · 8842" */
  memberId: (id: string) => `ID · ${id}`,

  // -------------------------------------------------------------- charges --
  /** :249 */
  chargesTitle: "Today's charges",
  /** :782 — "4 charges today · 2 still voidable" */
  chargesSummary: (total: number, voidable: number) =>
    `${total} ${total === 1 ? 'charge' : 'charges'} today · ${voidable} still voidable`,
  /** :781 — the two authority variants */
  voidRuleCan: 'A charge can be voided for 15 minutes — after that ask the manager.',
  voidRuleCannot: 'Voiding is off for your account — a manager can reverse a charge for you.',
  /** :258 — "2:10 PM · by Rana" */
  chargeBy: (time: string, by: string) => `${time} · by ${by}`,
  /** :263 */
  voidThis: 'Void this charge',
  /** :266 */
  voidedNote: (reason: string) => `Voided · refunded to wallet · ${reason}`,

  // --------------------------------------------------------------- locked --
  /** :284 */
  lockedTitle: 'Not enabled for you',
  /** :776 */
  lockedBody: (first: string) =>
    `Today’s charges is a senior permission. ${first}’s account can scan and charge, but a manager has to turn this on in the merchant dashboard.`,
  /** :288 */
  lockedWhoTitle: 'Who can see charges here',
  /** :779 */
  askManager: 'Ask a manager for access',
  askManagerSent: (first: string) => `Request sent to ${first}`,
  /** :571 — role labels */
  roles: {
    owner: 'Owner',
    manager: 'Manager',
    frontdesk: 'Front desk',
    artist: 'Stylist',
    stylist: 'Stylist',
    scanner: 'Scanner only',
  } as Record<string, string>,

  // ----------------------------------------------------------------- void --
  /** :309 */
  voidSheetTitle: 'Void this charge?',
  /** :310 */
  voidSheetBody:
    'The full amount goes straight back to her wallet, the visit is removed, and she gets a WhatsApp notice. This is recorded against your name.',
  /** :543 / :785 — the three reasons, in order */
  voidReasons: [
    { id: 'wrong', label: 'Wrong amount or service' },
    { id: 'dupe', label: 'Duplicate charge' },
    { id: 'cust', label: 'Customer did not receive service' },
  ] as const,
  /** :317 */
  voidKeep: 'Keep it',
  /** :318 */
  voidConfirm: 'Void & refund',
  /** api/src/routes/charges.ts — the 15-minute window, closed. */
  voidWindowClosed: 'That charge is older than 15 minutes. Reimburse the customer instead.',

  // --------------------------------------------------------------- member --
  /** :329 */
  rescan: '‹ Rescan',
  /** :330 */
  charging: 'Charging',
  /** :609 — the two loyalty modes */
  memberSubVisits: (n: number) => `Member · ${n} ${n === 1 ? 'visit' : 'visits'}`,
  memberSubStamps: (n: number) => `Member · ${n} ${n === 1 ? 'stamp' : 'stamps'}`,
  /** :347 */
  walletBalance: 'Wallet balance',
  /** :354 — the deposit line. The amount is interpolated, never typed. */
  depositApplies: 'will apply automatically to this charge.',
  depositAppliesLead: 'Held deposit',
  /** :357 */
  selectServices: 'Select services',
  /** :364 */
  shortfall: (name: string) => ({
    lead: 'Balance too low by',
    tail: `— ask ${name} to top up, then rescan.`,
  }),
  /** :368-370 — the totals block */
  totalServices: 'Services',
  totalDeposit: 'Deposit applied',
  totalToCharge: 'To charge',
  /** :638 — the three button labels */
  chargeSelectFirst: 'Select a service',
  chargeTooLow: 'Balance too low',
  chargeAction: (amount: string) => `Charge ${amount}`,
  chargeWorking: 'Charging…',

  // ----------------------------------------------------------------- done --
  /** :380 — "Charged 3.000 KD" */
  charged: (amount: string) => `Charged ${amount}`,
  /** :384 */
  newBalance: 'New balance',
  /** :385 */
  loyalty: 'Loyalty',
  /** :610-612 — the two loyalty sentences */
  loyaltyStamp: (have: number, target: number) => `Stamp added · ${have} of ${target}`,
  loyaltyVisit: (have: number, target: number, tier: string) =>
    `Visit added · ${have} of ${target} to ${tier}`,
  /** No next rung — the ladder's top. The design only shows the climbing case. */
  loyaltyVisitTop: (have: number) => `Visit added · ${have} visits`,
  /** :386 */
  receiptSent: 'WhatsApp receipt sent',
  /** interaction-spec.md §3 — the reduced-motion replacement for a pulse dot. */
  receiptPending: 'Waiting for the receipt…',
  /** :390 */
  voidLast: 'Wrong charge? Void it',
  /** :391 */
  nextCustomer: 'Next customer',

  // --------------------------------------------------------------- states --
  // design/AVO States.dc.html — the four states, plus the scanner's own.
  /** States:103,137 */
  tryAgain: 'Try again',
  /** States:138 — "Reference · WLT-5502-9917" */
  reference: (ref: string) => `Reference · ${ref}`,
  /** States:136 — "this is on our side", which is why it offers a retry. */
  errorTitle: "We couldn't load that",
  errorBody: 'Nothing was lost. This is on our side.',
  /** States:85 — the offline banner, verbatim. */
  offlineBanner: 'No connection · showing your last update',
  offlineTitle: 'No connection',
  offlineBody: 'The scanner needs a connection to take a charge.',
  chargesEmptyTitle: 'No charges yet today',
  chargesEmptyBody: 'The first charge you take will show here, with 15 minutes to void it.',

  /**
   * States:142-157 — "Scanner · code expired", the one scanner state the
   * states file draws in full. Verbatim, including the reassurance banner:
   * a code that has rotated is the single most common refusal at a counter
   * ("the token rotates every 45s and is single-use — this will happen daily")
   * and the first thing the artist needs to know is that no money moved.
   */
  codeExpiredTitle: 'That code has expired',
  codeExpiredBody: 'Codes refresh every 45 seconds. Ask the customer to show hers again.',
  scanAgain: 'Scan again',
  nothingCharged: 'Nothing was charged.',
  /** The already-used variant of the same 410. */
  codeUsedTitle: 'That code has already been used',
  codeUsedBody: 'Ask the customer to show a fresh one.',
  scanUnreadable: "That isn't an AVO wallet code.",

  // ----------------------------------------------------------- enrolment --
  // NO DESIGN EXISTS FOR THIS SCREEN — see src/screens/EnrolScreen.tsx for why
  // it has to exist and what was escalated.
  enrolTitle: 'Set up this device',
  enrolBody:
    'A PIN is scoped to one device and one salon, so this phone has to be named before anyone can sign in.',
  enrolSalon: 'Salon ID',
  enrolHandle: 'Staff handle',
  enrolDevice: 'Device ID',
  enrolSave: 'Save and continue',
  enrolChange: 'Set up this device',
} as const;

export type Copy = typeof copy;
