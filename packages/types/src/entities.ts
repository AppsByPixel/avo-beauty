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

// -------------------------------------------------------------- booking ----

export const BookingSchema = z.object({
  id: IdSchema,
  memberId: IdSchema,
  artistId: IdSchema,
  branchId: IdSchema,
  serviceId: IdSchema,
  startsAt: DateTimeSchema,
  durationMin: z.number().int().positive(),
  depositFils: FilsSchema.nonnegative(),
  status: z.enum(['deposit_held', 'completed', 'no_show_returned', 'cancelled']),
  source: z.enum(['app', 'google_calendar']),
});

export const ArtistSchema = z.object({
  id: IdSchema,
  salonId: IdSchema,
  name: z.string().min(1),
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
  time: z.string(),
  available: z.boolean(),
  /** The UI strikes unavailable slots through rather than hiding them. */
  reason: z.enum(['busy', 'booked', 'closed']).optional(),
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
  draft: z.object({ docs: z.array(LegalDocSchema) }),
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
export type Booking = z.infer<typeof BookingSchema>;
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
