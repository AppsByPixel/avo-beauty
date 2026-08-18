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
  /**
   * INVENTED — the design has no copy for a failed OPEN, because in the design
   * picking a row simply opens the member card.
   *
   * It does now: `GET /members/{id}` landed and `ScannerFlow.handlePick` calls it.
   * The two strings that used to live here — "Charging from a lookup is not ready
   * yet" — were correct until that endpoint existed. They are DELETED rather than
   * left in place, because a stale explanation of a solved problem is exactly what
   * cost this lane a run once already (src/api/members.ts § the stale header was
   * read as authoritative and briefed onward as a gap).
   *
   * What replaces them is narrower, and it is a real state rather than a
   * placeholder: the open can still fail after a successful search. She was listed
   * a moment ago and the resolve 404s because another device deactivated her, or
   * it 403s, or the network drops between the two requests. The body rendered
   * alongside this title is the SERVER's message whenever there is one, so the
   * artist reads why instead of a guess.
   */
  lookupOpenFailedTitle: 'Could not open her account',

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
  /** :266 — the void this session, where we still hold the reason we sent. */
  voidedNote: (reason: string) => `Voided · refunded to wallet · ${reason}`,
  /**
   * The same charge, read back from the server on a later load.
   *
   * `GET /charges` serves `voidedAt` but not the reason — the reason lives on
   * the reversal's audit row, not on this list. So the sentence states the time
   * instead of inventing a reason, and it is the time of the REVERSAL, which is
   * what "when was this refunded" means to whoever is asking.
   */
  voidedAtNote: (time: string) => `Voided ${time} · refunded to wallet`,

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
  /**
   * The headline when the held deposit covered the whole basket, so the WALLET
   * DEBIT is 0 and "Charged 0.000 KD" would say the opposite of what happened.
   *
   * LIFTED, AND THE DESIGN ALREADY MADE THIS EXACT PAIRING. `AVO Wallet
   * Home.dc.html:1707` renders a zero debit as the label `rCharged` ("Charged")
   * carrying the value `vNothing` — "Nothing charged" at :1271, "لم يُخصم شيء" at
   * :1378. So the bundle's own answer to a zero debit is these words rather than a
   * 0.000 figure, in both languages, and the customer's receipt already says it.
   * Nothing is invented here; the scanner takes the English because it is
   * English-only (design/README.md:273).
   *
   * NOT `nothingCharged` BELOW, AND THE COLLISION IS THE POINT. That one is
   * "Nothing was charged." — the reassurance under an EXPIRED-CODE title, where the
   * charge did not happen. This one sits under a SUCCESS MARK, where the charge did
   * happen and simply cost her nothing from her wallet. Reusing one string for both
   * would make a settled visit read like a failed one on the one screen where staff
   * have to tell those apart.
   */
  chargedNothing: 'Nothing charged',
  /** :384 */
  newBalance: 'New balance',
  /**
   * The remainder of a deposit that was bigger than the basket.
   *
   * LIFTED, NOT INVENTED, and from the wallet rather than from this design file —
   * the scanner's own result panel has no such row to copy. `Deposit returned` is
   * the bundle's own wording for this exact fact at
   * `AVO Wallet Home.dc.html:1569`, and it is what the customer's activity feed
   * and receipt already say (`txKind.deposit_return`, both languages). One fact,
   * one phrase, so the artist reading it at the counter and the customer reading
   * it on her phone are looking at the same words.
   */
  depositReturned: 'Deposit returned',
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
   * INVENTED, and the reasoning matters more than the wording — see MemberScreen
   * § THE DOUBLE-CHARGE PATH.
   *
   * The design offers "Try again" on a failed load (States:103,137) and that is
   * right for a load. It is WRONG for a charge, because a client that could not
   * read the response cannot know whether the money moved. The failure this
   * sentence appears under includes the case where the debit SUCCEEDED and only
   * the reply was unreadable, and the recovery staff reach for by instinct —
   * rescan her code — mints a fresh idempotency key and a fresh token, which the
   * server correctly treats as a second, genuine charge. No idempotency test
   * catches that; the server behaved properly both times.
   *
   * So the error state deliberately offers no retry button, and says this instead.
   * Her balance is the only reliable evidence of whether the debit landed, and
   * checking it is the manual version of the check the client can no longer do.
   */
  chargeUnknownOutcome:
    'Check her balance before charging again — this charge may already have gone through.',

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

  // ------------------------------------------------------- my bookings ----
  /** :138 — "3 upcoming · 2 new". */
  bookingsCount: (total: number, isNew: number) =>
    `${total} upcoming${isNew > 0 ? ` · ${isNew} new` : ''}`,
  /** :138, verbatim after the em dash. */
  bookingsSource: 'pulled from the AVO app and your Google Calendar.',
  /** :142, verbatim. */
  bookingsNote:
    'Every new booking pings you with a push notification and lands here — synced with your Google Calendar automatically.',
  /** :157 — "Deposit 5.000". The amount comes off formatFils, never a literal. */
  bookingsDeposit: (amount: string) => `Deposit ${amount}`,
  /** :155 */
  bookingsNew: 'NEW',
  /** :169-170 */
  bookingsCall: 'Call',
  bookingsWhatsApp: 'WhatsApp',
  /** :693 — the group headings. Dates, so they are formatted rather than fixed. */
  bookingsToday: 'Today',
  bookingsTomorrow: 'Tomorrow',
  /** :713-714 — where the booking came from. */
  bookingsSrcApp: 'AVO app',
  bookingsSrcGcal: 'Google Calendar',
  /** The duration, off the booking's own `durationMin`. design:693-699. */
  bookingsDuration: (minutes: number) =>
    minutes < 60
      ? `${minutes} min`
      : minutes % 60 === 0
        ? `${minutes / 60} hr`
        : `${Math.floor(minutes / 60)} hr ${minutes % 60}`,
  bookingsEmptyTitle: 'Nothing booked yet',
  bookingsEmptyBody: 'When a customer books you in the AVO app, it lands here.',
  /**
   * `GET /artists/me/bookings` answers `404 not_an_artist` for a staff account
   * with no artist row — a receptionist, a shared terminal. Not a refusal on
   * authority: there is simply no calendar here, and the API says so in those
   * words.
   */
  notArtistTitle: 'This account has no calendar',
  notArtistBody:
    'This login is not set up as a bookable artist, so it has no appointments of its own. A manager can add you to the team in the merchant dashboard.',

  // ------------------------------------------------------- my schedule ----
  /**
   * :405, verbatim — the SCREEN's subtitle. Not `scheduleSub` above, which is
   * :116, the home tile's one-liner. The design writes two different sentences
   * and collapsing them loses the one that explains "no fixed slots".
   */
  scheduleIntro:
    "Set the hours you're free — customers can book you in any open window. No fixed slots.",
  /** :408-409 */
  srcGoogle: 'Google Calendar',
  srcManual: 'Set manually',
  /** :811-812, both verbatim. */
  srcManualNote:
    'You set these hours yourself — no Google Calendar needed. Toggle a day, or drag the window earlier or later.',
  srcGoogleNote:
    'Synced live from your Google Calendar. Busy events block booking automatically. Switch to Set manually to edit here.',
  /** :419 */
  slotLengthLabel: 'Booking slot length',
  /** :423 */
  slotNote: (minutes: number) =>
    `Each open day is offered as ${minutes} min appointments — set any length you like.`,
  /** :657 — the chips read "15m", "30m". */
  slotChip: (minutes: number) => `${minutes}m`,
  /** :665 — "10:00 – 19:00 · 18 × 30m", and the closed-day line. */
  daySummary: (from: string, to: string, slots: number, minutes: number) =>
    `${from} – ${to} · ${slots} × ${minutes}m`,
  dayOff: 'Day off',
  /** :676 — the pill on a synced day. */
  synced: 'Synced',
  off: 'Off',
  /** :441,:449 */
  windowFrom: 'From',
  windowTo: 'To',
  /** :464-466 — the running summary in the footer. */
  openDays: 'Open days',
  openDaysValue: (open: number, total: number) => `${open} of ${total}`,
  hoursPerWeek: 'Hours per week',
  hoursValue: (hours: number) => `${Number.isInteger(hours) ? hours : hours.toFixed(1)} hrs`,
  bookingSlots: 'Booking slots',
  slotsValue: (slots: number) => `${slots} / week`,
  /** :804 */
  saveSchedule: 'Save schedule',
  backToHome: 'Back to home',
  scheduleSaved: 'Schedule saved',
  /**
   * `409 availability_is_synced`.
   *
   * SURFACED, NOT ONLY PREVENTED. The design draws a Google-sourced week as
   * read-only rows with a Synced pill, which is a UI convention — and
   * non-negotiable #7's whole point is that a convention is not a control. So
   * the rows stay tappable, the server refuses, and the refusal names the fix.
   * The body shown on screen is the API's own sentence.
   */
  syncedRefusedTitle: 'These hours come from Google',
  /** `409 google_not_connected` — no calendar to switch back to. */
  noCalendarTitle: 'No calendar connected',
  /**
   * The first-open state, and the endpoint that would remove it.
   *
   * There is no `GET /artists/me`, so the week cannot be drawn before a source
   * is chosen — see src/api/artist.ts for the three routes that were checked.
   * Choosing one is the design's own first control and the PUT returns the row,
   * so nothing is invented and nothing is probed. Reported.
   */
  pickSourceTitle: 'Choose where your hours come from',
  pickSourceBody:
    'Your week loads once you pick a source. Google Calendar keeps it in sync; Set manually lets you edit it here.',
} as const;

export type Copy = typeof copy;
