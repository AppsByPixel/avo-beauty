/**
 * Entity shapes, transcribed from design/api-contract.md.
 *
 * These are zod schemas rather than bare interfaces so the same definition
 * validates at the API boundary AND types the four clients. When the contract
 * changes, the build breaks — which is the whole reason the lanes can run in
 * parallel against a mock.
 *
 * Money fields are named `*Fils` without exception and are `z.number().int()`.
 * Cast them through `fils()` at the point of use; the branded type can't survive
 * a zod inference, but the integer check here catches a float on the wire.
 */

import { z } from 'zod';

// ------------------------------------------------------------- primitives --

/** Integer fils. Non-negotiable #1. */
export const FilsSchema = z.number().int();

/** ISO 8601 with offset. Kuwait is UTC+3, no DST. */
export const DateTimeSchema = z.string().datetime({ offset: true });

/** IDs are opaque strings — api-contract.md: "Don't assume format." */
export const IdSchema = z.string().min(1);

/** E.164. Also the customer's login identity. */
export const PhoneSchema = z.string().regex(/^\+[1-9]\d{6,14}$/, 'Phone must be E.164, e.g. +96599124408');

export const LanguageSchema = z.enum(['en', 'ar']);

/** Every list endpoint is cursor-paginated. */
export function paginated<T extends z.ZodTypeAny>(item: T) {
  return z.object({ items: z.array(item), nextCursor: z.string().nullable() });
}

// ------------------------------------------------------------------ salon --

export const TierNameSchema = z.enum(['bronze', 'silver', 'gold', 'black']);

export const TierSchema = z.object({
  name: TierNameSchema,
  minVisits: z.number().int().nonnegative(),
  /** Top-up bonus, e.g. 10 means 10.000 KD credits 11.000. Bronze is 0. */
  bonusPercent: z.number().min(0).max(100),
});

export const BranchSchema = z.object({
  id: IdSchema,
  salonId: IdSchema,
  name: z.string().min(1),
  /**
   * Arabic branch name. Without it an Arabic wallet renders "Salmiya" in Latin
   * inside otherwise-mirrored Arabic copy. The bundle's own reference
   * implementation carries it (`avo-promotions.js` → `branchLabel`, which picks
   * `nameAr` when `ar`), so this closes a gap between the contract and the
   * behaviour the design already demonstrates.
   *
   * Nullable, not required: a salon that has not supplied one falls back to
   * `name`, the same way an untranslated legal document falls back to `en`.
   */
  nameAr: z.string().nullable(),
});

export const SocialLinkSchema = z.object({
  id: z.enum(['instagram', 'tiktok', 'snapchat', 'whatsapp']),
  label: z.string(),
  /** "@amara.kw", or E.164 for whatsapp. STORE THE HANDLE, DERIVE THE URL. */
  handle: z.string(),
  /** false hides the icon without losing the handle. */
  on: z.boolean(),
});

export const BusinessHoursSchema = z.object({
  /** ["10:00", "13:00"] — the Kuwaiti afternoon closure is the norm, not an edge case. */
  morning: z.tuple([z.string(), z.string()]),
  evening: z.tuple([z.string(), z.string()]),
});

export const SalonSchema = z.object({
  id: IdSchema,
  name: z.string().min(1),
  /** Arabic salon name. See BranchSchema.nameAr. Falls back to `name`. */
  nameAr: z.string().nullable(),
  plan: z.enum(['starter', 'growth', 'pro']),
  /** Drives the white-label token. Validated through deriveBrandSet at onboarding. */
  brandColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
  modules: z.object({ booking: z.boolean(), shop: z.boolean() }),
  loyaltyMode: z.enum(['tiers', 'stamps']),
  tiers: z.array(TierSchema).optional(),
  stampTarget: z.number().int().positive().optional(),
  stampReward: z.string().optional(),
  /** "تصفيف شعر مجاني" — the reward is customer-facing copy, so it needs both. */
  stampRewardAr: z.string().nullable().optional(),
  depositFils: FilsSchema.min(1000).max(10000),
  noShowReturnMinutes: z.number().int().positive(),
  /**
   * IANA zone id — "Asia/Kuwait", not an offset.
   *
   * `businessHours`, artist `windows` and happy-hour `from`/`to` are all naive
   * wall clock. Without a zone they resolve against whatever the API process
   * booted with (UTC in docker-compose), which silently offers every slot three
   * hours out and, for happy hours, applies the wrong earning multiplier — a
   * money bug, not a display one.
   *
   * An IANA id rather than a stored offset because "10:00 local" is two
   * different instants across the year in any zone with DST. Kuwait has none,
   * so this is free today and expensive the first time AVO signs a salon
   * outside it.
   */
  timezone: z.string().min(1).default('Asia/Kuwait'),
  businessHours: BusinessHoursSchema,
  branches: z.array(BranchSchema),
  social: z.array(SocialLinkSchema),
  whatsappEnabled: z.boolean(),
});

// ----------------------------------------------------------------- member --

export const MemberSchema = z.object({
  id: IdSchema,
  salonId: IdSchema,
  name: z.string().min(1),
  phone: PhoneSchema,
  email: z.string().email().nullable(),
  emailVerified: z.boolean(),
  balanceFils: FilsSchema.nonnegative(),
  visits: z.number().int().nonnegative(),
  tier: TierNameSchema.nullable(),
  /** null when the salon runs tiers. */
  stamps: z.number().int().nonnegative().nullable(),
  /** The published legal version accepted at signup. Non-negotiable #10. */
  policyVersion: z.number().int().positive(),
  joinedAt: DateTimeSchema,
});

// ------------------------------------------------------------ wallet token --

export const WalletTokenSchema = z.object({
  memberId: IdSchema,
  /** Server-minted, single-use, rotates every 45s. The client NEVER mints this. */
  token: z.string().min(1),
  expiresAt: DateTimeSchema,
  /**
   * The string the QR encodes — `avo://pay?m=…&t=…` — minted by the server.
   *
   * It was being stripped, so every client re-derived it with `walletTokenUri()`
   * and none of them was using the authoritative one. Two implementations of a
   * bearer credential's format is one too many.
   */
  uri: z.string().min(1),
});

/** The string the QR encodes. */
export function walletTokenUri(memberId: string, token: string): string {
  return `avo://pay?m=${encodeURIComponent(memberId)}&t=${encodeURIComponent(token)}`;
}

// ------------------------------------------------------------ transaction --

export const TransactionKindSchema = z.enum([
  'topup',
  'charge',
  'deposit_hold',
  'deposit_return',
  'shop',
  'adjustment',
]);

export const TransactionSchema = z.object({
  id: IdSchema,
  memberId: IdSchema,
  branchId: IdSchema,
  kind: TransactionKindSchema,
  /** Signed: credit positive, debit negative. */
  amountFils: FilsSchema,
  /** Tier bonus portion of a top-up. Always 0 in stamps mode. */
  bonusFils: FilsSchema,
  method: z.enum(['knet', 'card', 'applepay', 'wallet']).nullable(),
  status: z.enum(['pending', 'settled', 'failed', 'cancelled']),
  /** Gateway ref, shown to the customer on failure. */
  reference: z.string(),
  createdAt: DateTimeSchema,
  /**
   * The void state. `voidedAt` is what a list renders — "Voided 14:32" is the
   * sentence a human reads; `reversedByTransactionId` is what makes it auditable.
   *
   * Both were being stripped, on the one surface where a 15-minute reversal
   * window is the whole feature: the scanner offered "Void this charge" on a
   * charge already voided, because the contract deleted the evidence.
   */
  voidedAt: DateTimeSchema.nullable(),
  reversedByTransactionId: IdSchema.nullable(),
});

// --------------------------------------------------------------- top-up ----

export const TopUpIntentSchema = z.object({
  id: IdSchema,
  memberId: IdSchema,
  /** What the customer pays. */
  amountFils: FilsSchema.positive(),
  /** Funded by the merchant. */
  bonusFils: FilsSchema.nonnegative(),
  /** amountFils + bonusFils — what lands in the wallet. */
  creditFils: FilsSchema.positive(),
  method: z.enum(['knet', 'card', 'applepay']),
  /** AVO commission. Merchant-visible, customer-NEVER. */
  feeFils: FilsSchema.nonnegative(),
  status: z.enum(['created', 'redirected', 'pending', 'succeeded', 'failed', 'cancelled']),
  failureReason: z
    .enum(['declined', 'expired', 'cancelled_by_user', 'gateway_error'])
    .nullable(),
  redirectUrl: z.string().url(),
  reference: z.string(),
});

/**
 * The customer-facing shape of a top-up intent.
 *
 * `GET /topups/{id}` is called by the wallet, and the commission is
 * merchant-visible / customer-never — settled in api-contract.md, confirmed by
 * the product owner ("the customer doesn't see this of course, they just see the
 * price") and by the live AvoRewards app, whose payment methods render a name
 * and no fee.
 *
 * So the field is omitted from the type the customer endpoint returns, rather
 * than left on it with a comment asking everyone to remember. A field that is
 * not in the response cannot be leaked by a serialiser someone edits later —
 * which is the failure mode Lane D found: `GET /members/me/transactions` maps
 * its rows inline instead of going through the shared serialiser, so a rule
 * enforced in one place was already only half enforced.
 *
 * `TopUpIntentSchema` keeps `feeFils` for the merchant and platform views.
 */
export const TopUpIntentPublicSchema = TopUpIntentSchema.omit({ feeFils: true });

// -------------------------------------------------------------- booking ----

export const BookingSchema = z.object({
  id: IdSchema,
  memberId: IdSchema,
  artistId: IdSchema,
  branchId: IdSchema,
  serviceId: IdSchema,
  startsAt: DateTimeSchema,
  /** Server-computed. The no-show clock runs from here, not from `startsAt`. */
  endsAt: DateTimeSchema,
  durationMin: z.number().int().positive(),
  depositFils: FilsSchema.nonnegative(),
  status: z.enum(['deposit_held', 'completed', 'no_show_returned', 'cancelled']),
  source: z.enum(['app', 'google_calendar']),

  /**
   * The one-hour rule, as an instant rather than a rule the client re-derives.
   *
   * THIS FIELD WAS MISSING AND ZOD WAS SILENTLY STRIPPING IT. A schema that
   * omits a field does not merely fail to type it — `.parse()` removes it from
   * the object, so a client reading `booking.changeableUntil` got `undefined`
   * and had no way to know the server had sent it. The entire cancellation
   * window disappeared between the wire and the screen.
   *
   * Found by Lane B building the Book flow against the real API. The lesson is
   * the one this contract exists for: a schema narrower than the wire is not a
   * smaller contract, it is a lossy one.
   */
  changeableUntil: DateTimeSchema,
  /** When the no-show job will return the deposit if she does not arrive. */
  noShowReturnDueAt: DateTimeSchema,
  /** A reschedule carries the deposit; this counts how often. */
  rescheduledCount: z.number().int().nonnegative(),
  calendarSyncState: z.enum(['not_applicable', 'pending', 'synced', 'failed']),
});

export const ArtistSchema = z.object({
  id: IdSchema,
  salonId: IdSchema,
  name: z.string().min(1),
  /** Arabic artist name. See BranchSchema.nameAr. Falls back to `name`. */
  nameAr: z.string().nullable(),
  /**
   * An artist is not necessarily a login. `staff_user` is the account; `artist`
   * is the person whose hours are bookable, and the contract says artists need
   * no login. When this is true the two are linked and the artist can edit
   * their own availability from the scanner.
   */
  hasOwnLogin: z.boolean(),
  /** Soft-deleted artists keep their bookings and stop taking new ones. */
  active: z.boolean(),
  availabilitySource: z.enum(['google', 'manual']),
  googleConnected: z.boolean(),
  slotMinutes: z.union([
    z.literal(15),
    z.literal(20),
    z.literal(30),
    z.literal(45),
    z.literal(60),
  ]),
  windows: z.record(
    z.string(),
    z.object({ open: z.boolean(), from: z.string(), to: z.string() }),
  ),
});

export const AvailabilitySlotSchema = z.object({
  startsAt: DateTimeSchema,
  endsAt: DateTimeSchema,
  /** Salon-local wall clock, "16:45" — what the customer is shown. */
  local: z.string(),
  available: z.boolean(),
  /**
   * OPTIONAL, not merely nullable. The server OMITS this key on an available
   * slot rather than sending null.
   *
   * The distinction cost a round: a `.nullable()` that is not `.optional()`
   * makes `reason` required, so **every bookable slot fails `.parse()`** — the
   * entire Book grid. It hid on today's date, where every slot is already past
   * and therefore carries a reason, which is exactly why the first fix looked
   * like it worked.
   */
  reason: z.enum(['busy', 'booked', 'closed']).optional(),
});

/**
 * What was removed from the open grid, reported rather than left to be inferred.
 *
 * `from`/`to` are salon-local WALL CLOCK — "10:00" — the same shape as a slot's
 * `local` and as `HappyHourSchema.from`/`to`. Not instants.
 *
 * This schema WAS drift #5, and the fix for #3 created it: I typed these as
 * `DateTimeSchema` and verified against a day with no bookings, where
 * `subtracted` is an empty array and nothing is validated. The moment a customer
 * books, the entire availability response throws.
 *
 * A brand-new schema proved against an empty sample is not proved at all. That
 * is why Lane D's guard now FAILS any probe whose declared arrays come back
 * empty, rather than passing vacuously.
 */
export const SubtractedBlockSchema = z.object({
  from: z.string(),
  to: z.string(),
  reason: z.enum(['busy', 'booked']),
  bookingId: IdSchema.optional(),
});

/**
 * `GET /artists/{id}/availability?date=` — slots inside an envelope, because
 * *why* a grid looks the way it does is part of the answer.
 *
 * Every field here is served. An earlier version of this schema declared four of
 * them and zod stripped the rest, including `open` — which is how a client tells
 * "she does not work that day" from an error, and `subtracted`, which is how a
 * merchant reads a suspiciously wide day without correlating it against a
 * notification.
 */
export const AvailabilityDaySchema = z.object({
  artistId: IdSchema,
  date: z.string(),
  /** IANA zone the wall-clock strings are in. */
  timezone: z.string(),
  slotMinutes: z.number().int().positive(),
  /** false with an empty `slots` means she does not work that day. */
  open: z.boolean(),
  slots: z.array(AvailabilitySlotSchema),
  subtracted: z.array(SubtractedBlockSchema),
  /**
   * `salon_hours` means this artist's own window was not trusted. The fallback
   * deliberately over-offers, so the customer has to be able to tell which grid
   * she is looking at.
   */
  hoursSource: z.enum(['artist_windows', 'salon_hours']),
  /** Null unless `hoursSource` is `salon_hours`. Names why. */
  fallbackReason: z.enum(['calendar_not_connected', 'calendar_unavailable']).nullable(),
});

/**
 * `GET /salons/{id}/artists/bookable` — what a CUSTOMER may see of an artist.
 *
 * Deliberately not `Artist`. Excluded and why, per Lane A: `handle`/`role`/
 * `perms`/`branchAccess` are staff facts; `hasOwnLogin` is a staffing fact;
 * `windows` is the internal week, and the raw week lets a customer infer who is
 * booked when — she gets the computed grid, which has already subtracted other
 * customers' bookings.
 *
 * `availabilityLive: false` is the answer without the mechanism: availability
 * falls back to salon hours, which over-offers, so a slot she picks may be one
 * the artist cannot work. WHY is the salon's problem and is in the merchant bell.
 */
export const BookableArtistSchema = z.object({
  id: IdSchema,
  salonId: IdSchema,
  name: z.string().min(1),
  nameAr: z.string().nullable(),
  availabilityLive: z.boolean(),
});

export const ServiceSchema = z.object({
  id: IdSchema,
  salonId: IdSchema,
  name: z.string().min(1),
  /**
   * The Book flow is the most Arabic-heavy screen in the wallet and it was
   * rendering Latin service names. Salon, Branch and Artist all carry this;
   * Service was the omission. Nullable — SV-05 is seeded NULL deliberately so
   * the `nameAr ?? name` fallback has a real null path to prove.
   */
  nameAr: z.string().nullable(),
  priceFils: FilsSchema.positive(),
  /** A retired service would build a basket the charge handler refuses. */
  active: z.boolean(),
});

export const ProductSchema = z.object({
  id: IdSchema,
  salonId: IdSchema,
  name: z.string().min(1),
  priceFils: FilsSchema.positive(),
});

// --------------------------------------------------------------- metrics ---

/**
 * Merchant Overview KPIs — `GET /salons/{id}/metrics?period=`.
 *
 * Not in api-contract.md's entity list, but the dashboard's Overview needs a
 * shape and a hand-written mirror in one client is how two surfaces start
 * disagreeing about what "repeat rate" means.
 */
export const SalonMetricsSchema = z.object({
  activeMembers: z.number().int().nonnegative(),
  /** Change over the previous period. Signed; the delta line hides when 0. */
  activeMembersDelta: z.number().int(),
  loadedTodayFils: FilsSchema.nonnegative(),
  /** Share of today's top-ups taken via KNET, 0–100. */
  knetSharePercent: z.number().min(0).max(100),
  repeatRatePercent: z.number().min(0).max(100),
  upcomingAppointments: z.number().int().nonnegative(),
  /**
   * Start instant of the next still-to-start booking — the "next at 4:30 PM"
   * half of the Upcoming tile. `null` when `upcomingAppointments` is 0, and the
   * tile hides the sub-label. Same window and status filter as the count
   * (deposit_held, now → salon's own midnight, salon's zone): the two answers
   * must come from one query so they cannot disagree — a count of 3 with a null
   * "next" is a contract violation, not a rendering choice.
   *
   * Declared BEFORE the API serves it, deliberately. Zod strips undeclared
   * keys, so serving the field first would mean every client silently drops it
   * — the drift this contract has shipped five times. Widen, then serve.
   *
   * REQUIRED-BUT-NULLABLE, and the staging that got here is worth keeping:
   * it landed `.optional()` first (the contract guard parses real responses,
   * and a required key the API did not yet send would have turned `dev` red),
   * the API began serving it, and the option came off the same day — because
   * optional hides a server that FORGOT the field. `null` means "no upcoming
   * appointment — hide the sub-label", and it co-occurs with
   * `upcomingAppointments: 0` by construction: the instant is `min(starts_at)`
   * in the same SELECT as the count, so a count beside a missing next is
   * unrepresentable, not merely untested.
   */
  nextAppointmentAt: DateTimeSchema.nullable(),
});

// ----------------------------------------------------------------- staff ---

/**
 * Non-negotiable #7. Set in the merchant dashboard, read by the scanner, and
 * enforced SERVER-SIDE. The UI hiding a button is a courtesy, not a control.
 */
export const StaffPermsSchema = z.object({
  dashboard: z.boolean(),
  appointments: z.boolean(),
  shop: z.boolean(),
  loyalty: z.boolean(),
  team: z.boolean(),
  /** Can scan & charge. */
  scanner: z.boolean(),
  /** Can open Today's charges on the scanner. Senior permission. */
  charges: z.boolean(),
  /** Can reverse a charge within 15 min. Meaningless without `charges`. */
  void: z.boolean(),
  /** Can submit a campaign for AVO approval. Cannot send it. */
  marketing: z.boolean(),
});

export const StaffUserSchema = z.object({
  id: IdSchema,
  salonId: IdSchema,
  name: z.string().min(1),
  handle: z.string().min(1),
  role: z.enum(['owner', 'manager', 'frontdesk', 'artist', 'scanner']),
  branchAccess: z.union([z.literal('all'), z.array(IdSchema)]),
  /** Whether a PIN exists. The PIN itself is hashed and never leaves the server. */
  pinSet: z.boolean(),
  /** Whether a web password exists. A new invite is `false` until they set one. */
  passwordSet: z.boolean(),
  /**
   * Deactivation, not deletion — a staff row that ever took money cannot be
   * removed. Both fields were stripped, so the dashboard could not tell a live
   * account from a retired one through the contract.
   */
  active: z.boolean(),
  deactivatedAt: DateTimeSchema.nullable(),
  perms: StaffPermsSchema,
});

// ------------------------------------------------------------ promotions ---

export const RewardKeySchema = z.enum([
  'x2stamp',
  'x3stamp',
  'x2visit',
  'topup10',
  'topup20',
  'credit3',
]);

export const HappyHourSchema = z.object({
  id: IdSchema,
  branchId: z.string(),
  /** JS getDay(): 0 = Sunday. */
  days: z.array(z.number().int().min(0).max(6)),
  /** Salon-local, 24h. */
  from: z.string(),
  to: z.string(),
  reward: RewardKeySchema,
  on: z.boolean(),
  notify: z.boolean(),
});

export const BoostSchema = z.object({
  visit: z.number().int().min(1).max(3),
  topup: z.number().int().min(0).max(30),
  stamp: z.number().int().min(1).max(3),
});

/**
 * ONE source of truth. The wallet and the dashboard read this same object —
 * never duplicate boost or happy-hour values in a client.
 *
 * THERE IS NO `live` FLAG. A window is live iff
 *   days.includes(now.getDay()) && from <= now < to
 * in salon-local time, resolved fresh by every reader. See isHappyHourLive().
 */
export const PromotionSetSchema = z.object({
  boosts: z.record(z.string(), BoostSchema),
  boostsPublishedAt: DateTimeSchema.nullable(),
  boostsPublishedBy: z.string().nullable(),
  happy: z.array(HappyHourSchema),
});

// -------------------------------------------------------------- campaign ---

export const CampaignSchema = z.object({
  id: IdSchema,
  salonId: IdSchema,
  salon: z.string(),
  title: z.string(),
  body: z.string(),
  channel: z.enum(['push', 'wa', 'both']),
  audience: z.enum(['all', 'lapsed', 'lowbal', 'gold', 'new']),
  branchId: z.string(),
  reward: z.union([RewardKeySchema, z.literal('none')]),
  /** Server-computed. NEVER trusted from the client. */
  reach: z.number().int().nonnegative(),
  when: z.enum(['now', 'later', 'recurring']),
  scheduledAt: z.string(),
  /** Non-negotiable #8: POST /campaigns can only ever create "pending". */
  status: z.enum(['pending', 'approved', 'rejected', 'sent']),
  /**
   * HELD IS NOT A STATUS, AND THAT IS THE POINT.
   *
   * Non-negotiable #8 ends "caps and quiet hours are enforced again at send time",
   * and `design/README.md` gap 6 is explicit that a breaching campaign is "held and
   * reported, never silently dropped". So a campaign the platform released and the
   * send path then refused stays `approved` — the platform's decision is a fact and
   * a later cap does not retract it — and carries the refusal beside it.
   *
   * Two fields rather than a boolean because the merchant is owed the sentence, not
   * the flag: "held until 09:00" and "held — this customer has had two messages this
   * week" are different things to do next. Without them a dashboard can render
   * "approved" and a bell and nothing that explains either.
   *
   * `null` on every campaign that was never held, which is most of them.
   */
  heldReason: z.string().nullable(),
  heldAt: DateTimeSchema.nullable(),
  submittedBy: z.string(),
  submittedAt: DateTimeSchema,
  decidedBy: z.string().nullable(),
  decidedAt: DateTimeSchema.nullable(),
  /** Shown verbatim to the merchant. A rejection must carry one. */
  note: z.string().nullable(),
  result: z.string().nullable(),
});

export const PlatformMessagingPolicySchema = z.object({
  requireApproval: z.boolean(),
  /** Hard cap across ALL salons, enforced server-side AT SEND. */
  weeklyCapPerCustomer: z.number().int().min(1).max(7),
  monthlyCapPerSalon: z.number().int().min(1).max(30),
  quietFrom: z.string(),
  quietTo: z.string(),
});

// ----------------------------------------------------------------- legal ---

export const LegalDocSchema = z.object({
  id: IdSchema,
  scope: z.enum(['platform', 'wallet']),
  /** Linked at signup; blocks account creation until ticked. */
  consent: z.boolean(),
  title: z.object({ en: z.string(), ar: z.string() }),
  /** One string per clause, rendered in order. Empty `ar` falls back to `en`. */
  body: z.object({ en: z.array(z.string()), ar: z.array(z.string()) }),
});

export const LegalDocumentSetSchema = z.object({
  published: z.object({
    version: z.number().int().positive(),
    effectiveFrom: z.string(),
    publishedAt: DateTimeSchema,
    publishedBy: z.string(),
    docs: z.array(LegalDocSchema),
  }),
  /**
   * OPTIONAL. `GET /v1/platform/policies` serves `{published}` alone, because a
   * customer must never receive an unpublished draft — non-negotiable #10.
   *
   * Requiring it made `.parse()` THROW on the customer's legal set, so #10 could
   * not be satisfied through the contract at all. The owner console's editor is
   * the only reader that gets a draft.
   */
  draft: z.object({ docs: z.array(LegalDocSchema) }).optional(),
});

// --------------------------------------------------------------- support ---

export const SupportTopicSchema = z.object({
  id: IdSchema,
  /** Which queue this lands in. RESOLVED SERVER-SIDE from topicId — #11. */
  route: z.enum(['salon', 'avo']),
  en: z.string(),
  ar: z.string(),
});

export const SupportConfigSchema = z.object({
  channels: z.object({
    /** E.164, shown LTR in both languages. */
    whatsapp: z.string(),
    email: z.string().email(),
    hoursEn: z.string(),
    hoursAr: z.string(),
    replyEn: z.string(),
    replyAr: z.string(),
  }),
  topics: z.array(SupportTopicSchema),
});

export const SupportTicketSchema = z.object({
  /** "SUP-48263" — the customer's reference. Show it verbatim. */
  id: IdSchema,
  memberId: IdSchema,
  member: z.string(),
  topicId: IdSchema,
  route: z.enum(['salon', 'avo']),
  message: z.string(),
  ref: z.string(),
  /**
   * The charge this dispute is ABOUT, resolved server-side from `ref`. Stripped
   * until now, which made "Report a problem with this payment" a form that knew
   * the receipt number and not the payment.
   */
  transactionId: IdSchema.nullable(),
  via: z.enum(['wa', 'email']),
  at: DateTimeSchema,
  status: z.enum(['open', 'closed']),
});

// ------------------------------------------------------------------ types --

export type Fils_ = z.infer<typeof FilsSchema>;
export type Tier = z.infer<typeof TierSchema>;
export type TierName = z.infer<typeof TierNameSchema>;
export type Branch = z.infer<typeof BranchSchema>;
export type SocialLink = z.infer<typeof SocialLinkSchema>;
export type Salon = z.infer<typeof SalonSchema>;
export type Member = z.infer<typeof MemberSchema>;
export type WalletToken = z.infer<typeof WalletTokenSchema>;
export type Transaction = z.infer<typeof TransactionSchema>;
export type TransactionKind = z.infer<typeof TransactionKindSchema>;
export type TopUpIntent = z.infer<typeof TopUpIntentSchema>;
export type TopUpIntentPublic = z.infer<typeof TopUpIntentPublicSchema>;
export type Booking = z.infer<typeof BookingSchema>;
export type AvailabilityDay = z.infer<typeof AvailabilityDaySchema>;
export type SubtractedBlock = z.infer<typeof SubtractedBlockSchema>;
export type BookableArtist = z.infer<typeof BookableArtistSchema>;
export type Service = z.infer<typeof ServiceSchema>;
export type Artist = z.infer<typeof ArtistSchema>;
export type AvailabilitySlot = z.infer<typeof AvailabilitySlotSchema>;
export type Product = z.infer<typeof ProductSchema>;
export type SalonMetrics = z.infer<typeof SalonMetricsSchema>;
export type StaffPerms = z.infer<typeof StaffPermsSchema>;
export type StaffUser = z.infer<typeof StaffUserSchema>;
export type Boost = z.infer<typeof BoostSchema>;
export type HappyHour = z.infer<typeof HappyHourSchema>;
export type PromotionSet = z.infer<typeof PromotionSetSchema>;
export type RewardKey = z.infer<typeof RewardKeySchema>;
export type Campaign = z.infer<typeof CampaignSchema>;
export type PlatformMessagingPolicy = z.infer<typeof PlatformMessagingPolicySchema>;
export type LegalDoc = z.infer<typeof LegalDocSchema>;
export type LegalDocumentSet = z.infer<typeof LegalDocumentSetSchema>;
export type SupportTopic = z.infer<typeof SupportTopicSchema>;
export type SupportConfig = z.infer<typeof SupportConfigSchema>;
export type SupportTicket = z.infer<typeof SupportTicketSchema>;
