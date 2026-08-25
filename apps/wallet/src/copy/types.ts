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

import type { PaymentMethod, RewardKey, TierName, Transaction } from '@avo/types';

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
  /**
   * The enlarged code overlay — design:641-643. Its dismiss button reuses the
   * existing `done` key, which is the same word the design uses at :643 and at
   * :1379 and is already lifted in both languages.
   */
  qrBig: string;
  qrBigSub: string;

  // happy hour — design:201-231 (the markup) and :1136-1151 (the strings)
  /**
   * The reward a window carries. `design/avo-promotions.js:18-26` writes all six
   * in both languages; nothing here is a translation.
   *
   * `none` is deliberately absent: `RewardKeySchema` has no such member, so a
   * `PromotionSet` off the wire cannot carry one.
   */
  happyReward: Record<RewardKey, string>;
  /** "Happy hour · Double visit credit" — takes the resolved reward label. */
  happyLiveTitle(reward: string): string;
  /** "Next happy hour · Double visit credit". */
  happyNextTitle(reward: string): string;
  /**
   * "All branches · until 18:00".
   *
   * `endsAt` arrives as the contract's raw "HH:MM" and each language renders its
   * own digits — the `staleBanner` rule. A time is a count, not money, so Arabic
   * is Eastern; handing a pre-formatted clock string across languages is exactly
   * how Eastern digits got into an English sentence once already.
   */
  happyLiveSub(branch: string, endsAt: string): string;
  /**
   * "Salmiya · today 16:00–18:00" / "All branches · Sunday 16:00–18:00".
   *
   * ONE function rather than a "when" phrase composed elsewhere and passed in,
   * for the same reason: a caller that formatted "today 16:00–18:00" in English
   * and handed it to the Arabic sentence would produce precisely the half-script
   * line that `no rendered string mixes the two digit scripts` exists to catch.
   *
   * `day` is a JS `getDay()` index, or null when the window opens later today.
   */
  happyNextSub(branch: string, day: number | null, from: string, to: string): string;
  /** "1h 28m left". English IS `formatCountdown` from @avo/types — see en.ts. */
  happyLiveLabel(minutes: number): string;
  /** "in 3h 24m". */
  happyNextLabel(minutes: number): string;
  /** "now 16:32" — the SALON's wall clock, never the phone's. Raw "HH:MM" in. */
  happyClock(hhmm: string): string;
  /** The branch label for a window that applies everywhere. design:271-272. */
  happyAllBranches: string;

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

  /**
   * top-up sheet — the payment page would not open.
   *
   * INVENTED, and marked. The bundle has no sentence for this because the
   * prototype's gateway always opens; the three it does have would each be a
   * lie here. `quoteFailedBody` says "Nothing was charged. Try again in a
   * moment." — true about the money, false about the state, because a real
   * `TI-…` intent exists and a customer told "try again" reasonably starts a
   * second one. `failMsg` blames her bank for a decline that never happened.
   * `errorBody` says it is on our side, which it may not be — a popup blocker
   * and a phone with no browser are hers.
   *
   * So the words have to do the one job the existing set cannot: say the page
   * did not open, say the top-up is still waiting rather than gone, and point at
   * opening it again rather than at starting another.
   *
   * See DECISIONS.md § "The offline cold-load sentence" for the precedent, and
   * `AR_GAPS` for where the Arabic goes to be written.
   */
  gatewayFailedTitle: string;
  gatewayFailedBody: string;
  /** The primary control: the SAME intent, opened again. Not a new top-up. */
  gatewayFailedRetry: string;

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

  /**
   * Sign-in. `design/AVO Wallet Home.dc.html:89-109`.
   *
   * The two FIELD labels are not here: they are `rowPhone` and `rowPassword`,
   * already lifted verbatim from the profile rows in both languages, and reusing
   * them is deliberate — the alternative is a second pair of strings for the same
   * two words, which is how one language ends up saying something the other does
   * not.
   *
   * `signInForgot` WAS ABSENT BY DECISION AND THE DECISION'S PREMISE HAS EXPIRED.
   * The old paragraph read: "there is no member password-reset endpoint —
   * `/auth/staff/password-reset` is staff-only. A link that does nothing when a
   * customer cannot get into her wallet is worse than no link, so it is omitted
   * and reported." The report was answered: `POST /auth/member/password-reset/request`
   * and `POST /auth/member/password-reset` are real (api/src/routes/auth.ts:835,
   * :943), so design:104's link has a destination and the string below is the
   * design's own, in both languages. Third entry in this file's own pattern —
   * `signInCreateOne` went through the identical absence-then-built cycle when
   * `POST /auth/member/signup` landed.
   */
  signInNoAccount: string;
  signInCreateOne: string;
  /** design:104 — "Forgot password?", the link under the sign-in form. */
  signInForgot: string;

  /**
   * The reset-request screen — design's `authScreen === 'forgot'`, a sibling of
   * sign-in and signup, with a `resetSent` sub-state.
   *
   * FIVE OF THE SEVEN ARE THE DESIGN'S OWN in both languages. The exceptions:
   *
   *   resetSub       the design's sentence names a USERNAME ("Enter your
   *                  username — we'll send a reset link to your WhatsApp."), and
   *                  there is no member username anywhere in this system — the
   *                  same settled conflict `signInScreen` documents. EN is the
   *                  design's sentence with the identity corrected to the phone;
   *                  the Arabic names the username too, so it is an AR GAP rather
   *                  than a spliced sentence no native speaker wrote.
   *
   * WHAT `resetSentSub` MUST NEVER BECOME: a conditional. The server answers 202
   * whether or not the pair matched — unknown phone and right-phone-wrong-salon
   * are byte-identical, deliberately, so a login form cannot be used as a
   * customer-list oracle — and this screen renders the SAME sentence on every
   * 202. One sentence for both outcomes is the anti-enumeration posture rendered
   * as copy; a "we couldn't find that number" branch here would undo the
   * server's whole property. (The drawn sentence does claim a link is on its
   * way, which on an unknown phone is not a fact — recorded and escalated, but
   * it is the design's sentence and it is uniform, which is the load-bearing
   * half.)
   */
  resetTitle: string;
  resetSub: string;
  /** INVENTED — the design's forgot-screen validation reuses `errEmpty`, which
      names a username and a password; this form has one field and it is the
      phone. Same correction, same marking, as `signInErrEmpty`. */
  resetErrEmpty: string;
  /** INVENTED — the design's button carries no busy label, same as
      `signInWorking` and `signUpWorking`. */
  resetWorking: string;
  resetBtn: string;
  resetSentTitle: string;
  resetSentSub: string;
  backToLogin: string;
  /**
  /**
   * The salon's name and the word "Wallet", above the sign-in form (design:86).
   *
   * IN THE COPY FILE, AND ONLY BECAUSE SIGN-IN IS PRE-AUTH. Everywhere after
   * sign-in the name comes off `Salon.name` from the API, which is correct for a
   * white-label product. Here there is no session yet and therefore no salon to
   * fetch, so the build carries its own name — and that, not a missing field, is
   * why the Arabic form lives here. The clause that used to follow ("`Salon.name`
   * is a single string with no `nameAr`, the contract gap HomeScreen already
   * reports") was stale: `SalonSchema.nameAr` exists and is served. Pre-auth
   * still cannot read it, so this key stays; the reason is the session, not the
   * schema.
   */
  salonName: string;
  walletWord: string;
  signInTitle: string;
  signInSub: string;
  signInAction: string;
  signInWorking: string;
  signInErrEmpty: string;
  signInOffline: string;

  /**
   * Signup — `design/AVO Wallet Home.dc.html:110-152`, and non-negotiable #10's
   * only moment.
   *
   * THE FIELD LABELS ARE NOT HERE, for the same reason sign-in's are not: `rowName`,
   * `rowPhone` and `rowPassword` are already lifted verbatim from the profile rows
   * in both languages.
   *
   * TWO OF THE DESIGN'S FOUR FIELDS ARE NOT BUILT, and the difference is settled
   * rather than mine: there is no `signUpUsername`, because there is no member
   * username in this system (DECISIONS.md § "Wallet sign-in identity"), and the
   * name is REQUIRED rather than `optional`, because removing the username leaves
   * it the only human label on the record. So the design's `optional` string is
   * deliberately unused, and `t.username` has no key at all.
   *
   * THE REFUSALS ARE THE BULK OF THIS BLOCK, AND THEY ARE ALL NEW STRINGS. The
   * design's signup prototype cannot fail: it has no server, so it has `errConsent`,
   * `errMismatch` and `errShort` and nothing else. `POST /auth/member/signup` has
   * ten distinct refusals, each of which is a different sentence to a customer —
   * "you already have an account" and "the terms changed while you were reading" are
   * not one "something went wrong". Every one whose Arabic the bundle does not carry
   * is in AR_GAPS rather than machine-translated. See `signupRefusal()` in
   * `api/signup.ts` for the code → key mapping and the test that keeps it total.
   */
  signUpTitle: string;
  signUpSub: string;
  signUpAction: string;
  signUpWorking: string;
  /** The password field's placeholder — design:127 reuses `passHint`. */
  signUpPassHint: string;
  signUpConfirmPass: string;
  /** design:1210 — the REQUIRED box. Blocks account creation until ticked. */
  signUpConsentTerms: string;
  /**
   * design:1211 — the SEPARATE box, and it is the SERVICE channel, not marketing.
   *
   * Word for word `nWaSub` ("Receipts and appointment confirmations") wrapped in a
   * sentence. Marketing is `nOffersSub`, "off by default", and it has no signup
   * entry point at all — so ticking this writes `notify_wa` and nothing else.
   * DECISIONS.md § "Member signup" has the reasoning; it is repeated here because
   * this is the string somebody would reach for if they wanted an offers opt-in.
   */
  signUpConsentWa: string;
  signUpHaveAccount: string;
  signUpLogIn: string;

  /** Caught before the request, so a blank submit is not a round trip. */
  signUpErrEmpty: string;
  /** design:1212 — the required box, untucked. */
  signUpErrConsent: string;
  /** design:1256 — the two passwords disagree. Never sent. */
  signUpErrMismatch: string;
  /** design:1256, and also the server's `password_too_short`. */
  signUpErrShort: string;
  /** 409 `already_registered` — she belongs on Log in, and the screen says so. */
  signUpErrRegistered: string;
  /** 409 `policy_version_stale` — a publish landed while she was reading. */
  signUpErrTermsChanged: string;
  /** 409 `policy_version_required` — we cannot prove which terms she saw. */
  signUpErrTermsReload: string;
  /** 400 `invalid_phone`. */
  signUpErrPhone: string;
  /** 400 `unknown_salon` — this build points at a salon the API does not have. */
  signUpErrSalon: string;
  /** 503 `policies_not_published` — there are no terms to accept. */
  signUpErrTermsMissing: string;
  /** 429 `signup_rate_limited` — the five-minute window. */
  signUpErrBusy: string;
  /** 429 `signup_hourly_limit` — the ceiling, which she cannot wait out. */
  signUpErrTooMany: string;
  /** Anything else, including the two refusals that can only be a client bug. */
  signUpErrFailed: string;
  /** Its own sentence: `signInOffline` promises a log-in she is not attempting. */
  signUpOffline: string;
  /**
   * The terms could not be loaded, so there is nothing to accept.
   *
   * NON-NEGOTIABLE #10 IS WHY THIS STATE EXISTS AT ALL. "The customer app holds no
   * legal copy" means there is no bundled set to fall back to, so a failed
   * `GET /v1/platform/policies` is not a cosmetic gap — the screen cannot honestly
   * offer a consent checkbox. It shows this and `tryAgain`, and no form.
   */
  signUpTermsFailedTitle: string;
  signUpTermsFailedBody: string;

  // failure — "we failed", so it retries
  errorTitle: string;
  errorBody: string;
  tryAgain: string;
  referencePrefix: string;

  // failure — "you can't do that", so it explains
  blockedTitle: string;

  /**
   * failure — "your connection", on a COLD load with nothing to keep on screen.
   *
   * Distinct from `offlineBanner`, which promises a last update and therefore
   * cannot be used here: on a cold load there is no last update, so it would
   * lie. Distinct from `errorTitle`/`errorBody`, which say "this is on our
   * side" — false when the phone simply has no signal.
   *
   * INVENTED, and authorised: DECISIONS.md § "The offline cold-load sentence".
   */
  offlineColdTitle: string;
  offlineColdBody: string;

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
  navShop: string;
  /**
   * design:627 — the fourth button, and the only one that is not a destination.
   * It opens the enlarged payment code over whatever screen she is on
   * (design:1905 `openQr`), which is why design:1897 renders it inactive
   * unconditionally. See `domain/payTab.ts`.
   */
  navPay: string;

  /**
   * Shop and cart — `design/AVO Wallet Home.dc.html:478-518` and :940-978.
   *
   * ALL LIFTED, in both languages, from :1234-1237 and :1341-1344 — plus three
   * strings the design composes INLINE rather than as `t.` keys (:1457, :1460,
   * :1461), which are still the designer's own words and are cited individually
   * below.
   *
   * WHAT THE DESIGN DRAWS AND THE API CANNOT FILL: a per-product `desc` ("For
   * split ends", "Shine & hydration"). `ProductSchema` is exactly
   * `{id, salonId, name, priceFils}` — the route says so, and declaring a fifth
   * field would be one the contract strips in transit. So there is no
   * `shopProductDesc` key and the row renders without it. REPORTED, not invented:
   * a description is a column, a contract field and a merchant editor input, not
   * a client string.
   */
  shopTitle: string;
  shopSub: string;
  /** :511 — the button on a product not yet in the cart. */
  shopAdd: string;
  /** :516 — the brand-tinted note under the list. */
  shopNote: string;
  cartTitle: string;
  /** ":945 — `{{ cartCount }} {{ t.items }}`". A count, so Eastern in Arabic. */
  cartItems(n: number): string;
  /**
   * A bare quantity — the number between the − and + of a stepper (design:960).
   *
   * IN THE COPY LAYER EVEN THOUGH IT IS ONLY A NUMBER, because that is the
   * invariant the whole i18n layer rests on: "the raw number goes to the copy
   * function and the copy function decides the script". A component calling
   * `toEasternDigits` itself would put digit policy in two places, and the second
   * one always drifts.
   */
  qtyValue(n: number): string;
  cartTotal: string;
  /** :966 — the row naming where the money comes from. */
  cartPayFrom: string;
  /** :968 — takes an already-formatted amount, so Western digits in both. */
  cartShortBy(amount: string): string;
  cartEmptyTitle: string;
  cartEmptyBody: string;
  /** :1461, composed inline by the design. Money arg. */
  cartPayCta(amount: string): string;
  /** :1460 — the shortfall CTA. It goes to top-up, not to a refused order. */
  cartTopUpCta: string;
  /** :1457 — the toast after a successful order. Money arg. */
  shopPaidToast(amount: string): string;

  /**
   * Shop STATES. The design's shop prototype has no server, so its Arabic covers
   * the happy path and none of these. All are in AR_GAPS.
   *
   * `shopEmpty*` is NOT `cartEmpty*` and the distinction is the one
   * `design/AVO States.dc.html` insists on: "nothing booked yet" and "the module
   * is off" must never share words. Here there are three ways to have no
   * products — the salon sells none yet, the module is switched off, and her cart
   * is empty — and they are three different sentences to three different people.
   */
  shopEmptyTitle: string;
  shopEmptyBody: string;
  shopOffTitle: string;
  shopOffBody: string;
  /**
   * `invalid_products`. A product retired while she shopped is indistinguishable
   * to the API from one that never existed — and she is holding it. The API names
   * the ids in `details.unknown`, so the sentence can say WHICH.
   *
   * ONE SENTENCE, NOT A TITLE AND A BODY. There was a `cartStaleTitle` beside this
   * and nothing ever rendered it: the refusal is a danger chip in the cart, the
   * same one-line shape sign-in and signup use, and a heading inside a chip is
   * redundant with the sentence under it. Deleted rather than left declared,
   * because an unrendered key still sat in AR_GAPS and would have cost a native
   * speaker a sentence nobody would read.
   */
  cartStaleBody(names: string): string;
  /** Any other refused order. Never an undo — `voidable` is always false. */
  shopOrderFailed: string;

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
  /**
   * The PERSISTENT state, shown on Account whenever `GET /members/me/deletion`
   * says `pending` — which is what makes the cancel door reachable after a cold
   * start rather than only in the seconds after requesting.
   *
   * NO DESIGN SOURCE, for the same reason as the three above: the design's sheet
   * never reaches a server, so it has no notion of a request that outlives the
   * sheet. Both are in AR_GAPS.
   *
   * `deleteScheduledBody` takes the CALENDAR DATE the erasure is due on, as
   * "YYYY-MM-DD", and each language formats its own — the `staleBanner` /
   * `legalUpdated` rule. A caller that formatted it would put Eastern digits
   * inside this English AR_GAP sentence, which is the half-translated mix that
   * reads as a bug in both languages.
   *
   * A calendar date, not the raw `erasureDueAt` instant: converting the instant
   * to a Kuwait date is a timezone decision and belongs in one place, not in two
   * copy modules.
   */
  deleteScheduledTitle: string;
  deleteScheduledBody(dueOn: string): string;
  /**
   * The read failed, so the screen knows neither `none` nor `pending`. BOTH
   * guesses are harmful — see state/useDeletionState.ts — so the section shows
   * this with a retry instead of picking one.
   */
  deleteCheckFailed: string;

  // the language switch itself
  langSwitch: string;
  /**
   * Shown only on native, only when the direction actually has to change.
   * `I18nManager.forceRTL` does not take effect until the app restarts.
   */
  restartNeeded: string;
}
