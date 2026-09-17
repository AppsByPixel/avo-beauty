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

/**
 * A page that also carries the size of the whole filtered set — the audit reads
 * and the support queue, where the screen renders "N entries match".
 *
 * A SEPARATE HELPER RATHER THAN AN OPTIONAL `total` ON `paginated`. The wallet's
 * booking and service pages use `paginated` and do **not** send a total, so
 * making it optional there would tolerate a server that simply forgot it — the
 * same trap `nextAppointmentAt` avoided by being nullable-and-required rather
 * than optional. A page with a count and a page without are different shapes;
 * saying so lets each be wrong loudly.
 *
 * `total` is the count of the whole filter, NOT of `items` — that distinction is
 * what makes the cursor bug lane A found so hard to see, where a page returned
 * one row and still reported ten.
 */
export function countedPage<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
    total: z.number().int().nonnegative(),
  });
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

/**
 * A wall-clock time. `24:00` is admitted because it is a real END of a trading
 * day and the API accepts it as one — the API also refuses it as a START, which
 * is a POSITIONAL rule and deliberately not expressed here. See below.
 *
 * Mirrors `HHMM_OR_END_OF_DAY` in `api/src/http/fields.ts`. Two copies of one
 * regex is one more than anybody wants, but the alternative is `packages/types`
 * importing from `api/`, which inverts the dependency every surface relies on.
 * `e2e` asserts the two agree, so a drift fails rather than silently diverging.
 */
const CLOCK = /^(([01]\d|2[0-3]):[0-5]\d|24:00)$/;

/**
 * WHY THIS VALIDATES THE CLOCK AND NOT THE ORDERING.
 *
 * It used to be `z.tuple([z.string(), z.string()])` — "two strings", which is a
 * lossy description of "two times", and the gap between the two is what let
 * `{"morning":["banana",7]}` reach the column. That value then threw inside
 * `hhmmToMinutes` during `computeAvailability`, so ONE bad Settings save answered
 * 500 on every availability read for that salon, three screens from the field
 * that was typed wrong. Lane A closed the door; this closes the description, so a
 * client building business hours fails locally on its own field instead of
 * meeting an unpredicted 400 — and so `packages/mock` cannot serve a shape the
 * real API would refuse.
 *
 * ORDERING IS DELIBERATELY NOT CHECKED, and this is the part not to "tighten"
 * later. `tradingSpans` drops a span with `to <= from`, which makes
 * `evening: ["21:00", "21:00"]` the ESTABLISHED way to say "no second sitting" —
 * so a `from < to` refinement here would break every salon that trades straight
 * through the afternoon with no evening session. The artist-windows route DOES
 * refuse a zero-length span, correctly, because an open day with no bookable slot
 * is a merchant who meant something else. Two different questions about
 * same-looking data; only one of them belongs to the shape.
 */
export const BusinessHoursSchema = z.object({
  /** ["10:00", "13:00"] — the Kuwaiti afternoon closure is the norm, not an edge case. */
  morning: z.tuple([z.string().regex(CLOCK), z.string().regex(CLOCK)]),
  evening: z.tuple([z.string().regex(CLOCK), z.string().regex(CLOCK)]),
});

export const SalonSchema = z.object({
  id: IdSchema,
  name: z.string().min(1),
  /** Arabic salon name. See BranchSchema.nameAr. Falls back to `name`. */
  nameAr: z.string().nullable(),
  plan: z.enum(['starter', 'growth', 'pro']),
  /**
   * The salon's city. Arrived with the onboarding wizard, whose first step gates
   * Continue on name + city + phone — migration 0037 added the column because two
   * of those three had none.
   *
   * `.nullable()` and NOT `.optional()`: the seeded pair predate the column and
   * read null, so null is a real answer, but a server that FORGETS the key must
   * fail rather than pass. Declared here because the API already serves it and
   * this schema is what strips an undeclared key — the sixth instance of that
   * drift in this contract, and the first found by a lane reporting its own
   * endpoint's field as unrepresentable rather than by a client losing data.
   *
   * `ownerPhone` is deliberately NOT here. The API serves it outside the salon
   * shape, in an envelope, precisely so this schema cannot carry it: members read
   * `GET /salons/{id}`, and a salon owner's phone number is not theirs to have.
   */
  city: z.string().nullable(),
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
  /**
   * 5 ≤ n ≤ 1440, the same bound the API validates and `salon_no_show_return_in_range`
   * holds on the column (`api/drizzle/0051`). Stated here for the reason
   * `depositFils` states its own: a bounded column whose shared schema says only
   * "positive" under-states it, and every surface that parses a Salon then
   * believes the wider claim.
   *
   * THE CEILING IS A MONEY RULE, NOT A TIDINESS ONE. This number is read twice —
   * `markNoShow` stamps the return deadline with it, and `findApplicableHold`
   * reuses it as the early-arrival grace (`startsAt <= now + noShowReturnMinutes`)
   * that decides WHICH held deposit a charge may consume. Set large enough, every
   * hold a member owns satisfies that predicate and the charge takes whichever the
   * ordering returns first: the wrong appointment settled, reachable through a
   * Settings field with no bad code anywhere. 1440 is where the grace certainly
   * crosses into another day's booking; 5 rather than 1 keeps a till able to see a
   * deposit at check-in.
   */
  noShowReturnMinutes: z.number().int().min(5).max(1440),
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
  /**
   * Which channels a receipt may go out on. **A salon cannot have both off** —
   * `salon_receipt_channel_floor` is a database CHECK, not a handler's memory,
   * because a receipt is a record-keeping obligation rather than marketing
   * (`design/README.md` § Known gaps 7) and a merchant's channel preference must
   * not be able to produce silence.
   *
   * `whatsappEnabled` EXISTED AND WAS NEVER CONSULTED — stored, merchant-editable,
   * served to every client, and absent from the receipt path, so a salon that had
   * turned WhatsApp off still had WhatsApp receipts queued for every charge
   * (decision 88). `emailEnabled` arrives alongside the fix.
   *
   * WhatsApp is the floor, and the schema decides that rather than a preference:
   * `member.phone` is NOT NULL while `member.email` is nullable and needs
   * verifying, so exactly one combination is dangerous — email-only for a
   * customer with no verified address. A merchant chooses a *preference*; she does
   * not override the rule about where a customer's balance may be sent.
   */
  whatsappEnabled: z.boolean(),
  emailEnabled: z.boolean(),
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
   * The string the QR encodes — `avostaff://pay?m=…&t=…` — minted by the server.
   *
   * It was being stripped, so every client re-derived it with `walletTokenUri()`
   * and none of them was using the authoritative one. Two implementations of a
   * bearer credential's format is one too many.
   */
  uri: z.string().min(1),
});

/** The string the QR encodes. */
export function walletTokenUri(memberId: string, token: string): string {
  return `avostaff://pay?m=${encodeURIComponent(memberId)}&t=${encodeURIComponent(token)}`;
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
   * WHETHER SOMEBODY TYPED THIS PRICE, rather than it coming off the menu.
   * (api migration 0049; `perms.void` gates minting one.)
   *
   * Here for the same reason `voidedAt` is, three lines down: the server knows
   * it, `GET /charges` sends it, and a schema that does not declare it does not
   * fail — zod DELETES it, and no client can tell "the server did not send it"
   * apart from "our own types ate it". That is drift (7) and it cost this
   * project a whole 15-minute reversal feature once already.
   *
   * IT IS ON THE CUSTOMER'S TRANSACTION, NOT ONLY THE MERCHANT'S, AND THAT IS
   * THE POINT. A charge whose price a staff member invented is precisely the
   * charge a customer has cause to query, and `false` is a positive statement —
   * this came off the menu — rather than an absence she has to interpret.
   *
   * THE REASON STRING IS DELIBERATELY NOT HERE. `transaction.note` is a
   * general-purpose internal column: void reasons, "Cancelled by the customer",
   * "Deposit larger than the visit", "No-show · deposit returned automatically",
   * and an owner's free-text adjustment reason all live in it. Declaring `note`
   * on the customer's transaction type would put every one of those one careless
   * serialiser away from the customer's own activity list — and `GET /charges`
   * keeps it off her wire today only by a ternary
   * (`note: t.customAmount ? t.note : null`), which is a rule in one place with
   * nothing stopping the second. So it stays a MERCHANT-ROUTE key, alongside
   * `feeFils`, which carries the same "merchant-visible, customer-never" note
   * eight lines up in `db/schema/transaction.ts`. `e2e/contract.test.ts`
   * annotates it `wireOnly` with that reason.
   */
  customAmount: z.boolean(),
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

// -------------------------------------------------------------- voucher ----

/**
 * AN AVO-ISSUED COMPENSATION VOUCHER. (`api/src/routes/vouchers.ts`.)
 *
 * WHY THIS IS HERE RATHER THAN IN A CLIENT, which is the whole reason this block
 * was written: the wallet and the console each grew their OWN reader of this
 * shape — `apps/wallet/src/api/vouchers.ts` parsed it with zod, and
 * `apps/dashboard/src/api/vouchers.ts` hand-rolls an `interface` plus per-field
 * coercion. Two definitions of one fact, neither visible to
 * `e2e/support/contract-drift.ts`, on a money path. That is the shape of drift
 * (7), which deleted an entire 15-minute reversal feature between the server and
 * the screen, and of decision 105's "three readers of one fact is the defect,
 * not the disagreement they have not had yet".
 *
 * THE CONSOLE KEEPS ITS HAND-ROLLED READER, DELIBERATELY. `apps/dashboard` has
 * **no zod dependency at all** — zero imports, nothing in its package.json — so
 * hand-rolled parsing is that app's house style rather than an oversight there,
 * and adding a library to it is a decision with a lockfile and a bundle behind
 * it, not a rider on a schema move. What this block buys is the thing that was
 * actually missing: a declaration the drift guard can compare against the wire.
 *
 * `redeemable` IS THE SERVER'S ANSWER AND MUST NOT BE RE-DERIVED. The route
 * computes it once — not redeemed, not voided, not expired — precisely so a
 * client cannot disagree with the redeem endpoint about whether a row is live.
 * Both clients already carry that warning; it is restated at the field because
 * this is now where a third client will read it first.
 */
export const VoucherSchema = z.object({
  id: IdSchema,
  /** As the server minted it. A client never chooses one — `POST /v1/vouchers` refuses a supplied `code` by name. */
  code: z.string().min(1),
  memberId: IdSchema,
  amountFils: FilsSchema,
  /** Why it was issued. Required at issue, and the only description this instrument will ever carry. */
  reason: z.string(),
  expiresAt: DateTimeSchema.nullable(),
  createdAt: DateTimeSchema,
  redeemedAt: DateTimeSchema.nullable(),
  /** The `adjustment` the redemption wrote. Null until she spends it. */
  redeemedTransactionId: IdSchema.nullable(),
  voidedAt: DateTimeSchema.nullable(),
  /**
   * The server's single answer to "can this be spent". Computed once, server
   * side. Do NOT recompute it from the three timestamps above — a client that
   * does will eventually disagree with the endpoint that actually decides, and
   * the disagreement will be about money.
   */
  redeemable: z.boolean(),
});

/**
 * What `POST /members/me/vouchers/redeem` answers on a 200.
 *
 * `balanceAfterFils` IS THE BALANCE — written inside the same transaction as the
 * credit and the ledger pair, so it is the only number on this surface safe to
 * show. Adding `creditedFils` to a balance the app happened to be holding would
 * be the client deciding what she has (#2), and it would be wrong the moment a
 * charge settled between the two reads.
 */
export const VoucherRedemptionSchema = z.object({
  voucher: VoucherSchema,
  creditedFils: FilsSchema,
  balanceAfterFils: FilsSchema,
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
  /**
   * The branch she works at, or `null` when nobody has assigned her yet.
   *
   * NULL MEANS "NOT ASSIGNED", NOT "UNBOOKABLE" — migration 0044 backfilled only
   * salons with exactly one *open* branch, reusing `resolveBranch`'s own "one
   * branch is not a guess" rule, and deliberately left every multi-branch
   * salon's artists null rather than guessing. Treating null as unbookable would
   * have taken the booking flow offline at every multi-branch salon the moment
   * the migration ran, to fix an attribution defect with no money impact.
   *
   * WHAT IT IS FOR: a booking's branch is derived from her, so it is
   * *established* rather than guessed — the customer never asserts a branch, she
   * picks an artist. Assigning her is `perms.team` roster administration and
   * pays no multiplier, which is the deliberate contrast with a till's branch
   * (`perms.dashboard`): the charge that settles a booking takes its branch from
   * the enrolled device, not from her.
   *
   * So a booking's branch and its charge's branch CAN legitimately disagree — she
   * is seen at Salmiya and pays at Kuwait City — and they are never reconciled.
   * Every money figure filters on `transaction.branch_id`.
   */
  branchId: IdSchema.nullable(),
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

/**
 * A stored image, as every endpoint that carries one reports it.
 *
 * `url` IS ABSOLUTE, and that is not a style choice: the wallet runs on a phone
 * and cannot resolve a path against an origin nobody told it. It is built from
 * `PUBLIC_BASE_URL` server-side.
 *
 * THE READ IS AUTHENTICATED. Not because a product photo is a secret — because
 * the catalogue it belongs to is not public either. `GET /salons/{id}/products`
 * already refuses another salon's member, so a public image URL would make that
 * gate decorative for every product carrying a photo. Callers send the session:
 * the dashboard fetches and `createObjectURL`s, React Native passes `headers`
 * on the `Image` source. There is no token in a query string.
 *
 * `contentType` is the enum the API will ACCEPT and re-serve, read back from the
 * row rather than from whatever the uploader claimed. SVG is deliberately absent
 * — it is an XML document with a script host in it, served from the origin the
 * wallet trusts, and no sanitiser for it is known-complete.
 */
export const ImageRefSchema = z.object({
  id: IdSchema,
  url: z.string().url(),
  contentType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  byteSize: z.number().int().positive(),
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
  /** Explicit `null`, never absent — a client must not have to tell "no image" from "field not sent". */
  image: ImageRefSchema.nullable(),
});

export const ProductSchema = z.object({
  id: IdSchema,
  salonId: IdSchema,
  name: z.string().min(1),
  priceFils: FilsSchema.positive(),
  /** Explicit `null`, never absent — see ServiceSchema.image. */
  image: ImageRefSchema.nullable(),
});

// --------------------------------------------------------------- metrics ---

/**
 * Merchant Overview KPIs — `GET /salons/{id}/metrics?period=`.
 *
 * Not in api-contract.md's entity list, but the dashboard's Overview needs a
 * shape and a hand-written mirror in one client is how two surfaces start
 * disagreeing about what "repeat rate" means.
 */
/**
 * One enrolled till, as `GET /salons/{id}/devices` reports it.
 *
 * WHAT AN ENROLMENT IS FOR, in one sentence: it is how the SERVER establishes
 * which branch a charge happened at, so a multi-branch salon's earning rates can
 * be applied at all. Before it existed those rates were stored, served to both
 * clients, and applied by neither — decision 82.
 *
 * `branchId` IS NOT A CLIENT INPUT ANYWHERE. `POST /charges` has no branch in its
 * body and must never gain one: a client naming its own branch is a client
 * choosing its own multiplier, non-negotiable #2 with extra steps. This shape is
 * for *administering* tills, not for asserting one during a charge.
 *
 * `branchName` is nullable because it is a join, not a stored field — a branch
 * closed after enrolment still has a row here, deliberately, so a till that was
 * pointed somewhere while money went through it stays answerable.
 */
export const DeviceEnrolmentSchema = z.object({
  deviceId: z.string(),
  branchId: z.string(),
  branchName: z.string().nullable(),
  label: z.string(),
  enrolledAt: DateTimeSchema,
});

/**
 * A delivery address in the member's own address book.
 *
 * THE THREE REQUIRED FIELDS ARE `block`, `street`, `building`, AND THAT IS WHAT A
 * KUWAITI ADDRESS IS. Everything else is nullable with no default, and nothing
 * substitutes for anything: an omitted `floor` is `null`, not the building
 * number, and not the literal text `'string'`. That is a direct response to
 * `PRIOR-ART.md` — AvoRewards' live app sends one input as four separate address
 * fields and ships `'string'` in two more, so a driver receives a house number in
 * the block field and a landmark where the street should be.
 *
 * `area` and `governorate` are free text rather than ids, because the id tables
 * Lean hardcodes to `1` do not exist here and inventing them would be inventing a
 * gazetteer.
 *
 * COORDINATES ARE STRINGS, not numbers. The column is `numeric` — the database's
 * blanket ban on the float family covers it, and nothing does arithmetic on a
 * coordinate — so it arrives as a string and is sent as one. Both or neither;
 * `member_address_coordinates_are_a_pair` is the control.
 */
export const MemberAddressSchema = z.object({
  id: IdSchema,
  label: z.string(),
  block: z.string(),
  street: z.string(),
  building: z.string(),
  floor: z.string().nullable(),
  apartment: z.string().nullable(),
  area: z.string().nullable(),
  governorate: z.string().nullable(),
  instructions: z.string().nullable(),
  latitude: z.string().nullable(),
  longitude: z.string().nullable(),
  createdAt: DateTimeSchema,
});

/** `preparing → ready → closed`. Lean's whole lifecycle, after years and ten tenants. */
export const OrderStatusSchema = z.enum(['preparing', 'ready', 'closed']);

/**
 * A shop order, as the customer and the merchant board both read it.
 *
 * `fulfilment` IS A FORK, NOT A REPLACEMENT — Lean keeps both `pickup` and
 * delivery live, so "the shop is delivery-based" means delivery is available and
 * chosen, not that collection was removed.
 *
 * `address` IS A SNAPSHOT and this is the field most likely to be misread: it is
 * what she typed when she ordered, not what her address book says now. Editing or
 * deleting an address does not change a past order, deliberately — a delivered
 * order has to stay answerable. So the same address exists in two places with two
 * different lifetimes.
 *
 * There is NO FEE anywhere in this shape, and its absence is asserted rather than
 * assumed: the same cart costs the same collected or delivered, and an order
 * touches only `member_wallet` and `salon_revenue` — a fee would have to invent a
 * third account.
 */
export const ShopOrderSchema = z.object({
  transactionId: IdSchema,
  fulfilment: z.enum(['pickup', 'delivery']),
  status: OrderStatusSchema,
  /**
   * NULL HAS TWO MEANINGS AND THE FULFILMENT DISTINGUISHES THEM — do not read
   * a null address as pickup, which was true until migration 0048.
   *
   *   `pickup`   + null  → she is collecting. There was never an address.
   *   `delivery` + null  → the customer asked to be erased; the snapshot's
   *                        columns are scrubbed and `address_erased_at` stamped
   *                        server-side. The order, its lines, its transaction
   *                        and its ledger pair all survive.
   *
   * A *live* delivery is CHECKed to carry block, street and building, so a
   * delivery with a null address cannot arise from a bug or a forgotten
   * snapshot — the database refuses both. The state is unambiguous, which is why
   * no extra wire field was added for it.
   *
   * The erasure date is deliberately NOT served: it would tell a salon *when* a
   * customer it can still name asked to be erased, which is a fact about her
   * rather than about the order.
   */
  address: MemberAddressSchema.omit({ createdAt: true }).nullable(),
  createdAt: DateTimeSchema,
  readyAt: DateTimeSchema.nullable(),
  closedAt: DateTimeSchema.nullable(),
});

export const SalonMetricsSchema = z.object({
  activeMembers: z.number().int().nonnegative(),
  /** Change over the previous period. Signed; the delta line hides when 0. */
  activeMembersDelta: z.number().int(),
  /**
   * NULL WHEN A BRANCH FILTER IS APPLIED, AND THAT IS A CATEGORY ERROR MADE
   * VISIBLE RATHER THAN A MISSING FEATURE. `services/topup.ts` writes every
   * top-up row `branch_assumed = true` unconditionally, because — in its own
   * words — a top-up HAS no branch to establish: it happens on a phone. No
   * device-enrolment work will ever close that gap.
   *
   * So the metrics service SKIPS this query when a branch is selected rather
   * than filtering it and discarding the result. Filtering would hand a
   * two-branch salon its whole day's takings under whichever branch sorts
   * first and `0.000 KD` under the other, and a false zero reads as a real
   * number — the failure mode this whole field exists to avoid.
   *
   * Invariant: `loadedTodayFils === null` if and only if `branchId !== null`.
   */
  loadedTodayFils: FilsSchema.nonnegative().nullable(),
  /** Share of today's top-ups taken via KNET, 0–100. `null` with a branch — see above. */
  knetSharePercent: z.number().min(0).max(100).nullable(),
  /** The branch this answer was scoped to, echoed back. `null` = every branch. */
  branchId: z.string().nullable(),
  branchName: z.string().nullable(),
  /**
   * HOW MUCH OF THE PER-BRANCH ANSWER RESTS ON AN ASSUMED BRANCH. `null` when
   * `branchId` is null, because a salon-wide total is exact however many rows
   * are assumed — a misattributed row is still inside the salon.
   *
   * It carries the SIZE of the doubt, not a boolean, so the UI can say "based
   * entirely on assumed branches" (`visits === visitsTotal`) or nothing at all
   * (`0`) instead of a permanent unfalsifiable asterisk. When branch-bound
   * scanner sessions land, these fall to zero on their own and the caveat
   * leaves the UI with no code change.
   */
  branchAssumed: z
    .object({
      activeMembers: z.number().int().nonnegative(),
      visits: z.number().int().nonnegative(),
      visitsTotal: z.number().int().nonnegative(),
      upcomingAppointments: z.number().int().nonnegative(),
    })
    .nullable(),
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
  /**
   * Which salon's customer wrote it. Served by the API and previously stripped
   * here, which mattered more than a missing field usually does: it is the value
   * the queue's tenancy predicate is *built on* — a merchant read is forced to
   * `salon_id = hers AND route = 'salon'` — so a client validating through this
   * schema could not see the scoping it was subject to.
   */
  salonId: IdSchema,
  topicId: IdSchema,
  /**
   * The topic's label at READ time, joined rather than snapshotted — the
   * deliberate opposite of `route` directly below. A route is a **decision**
   * about the ticket and is frozen onto it; a label is **wording**, so an admin
   * fixing a typo or adding the Arabic should fix it on every ticket rather than
   * leaving the old spelling frozen into the queue.
   *
   * There IS a `{ en: topicId, ar: '' }` fallback in the serialiser, and it is
   * **not** the retired-topic path — that was this comment's original claim and
   * it named the one case that cannot reach it. `serialiseTickets` builds its
   * label map with `inArray(id, topicIds)` and **no `active` filter**, so a
   * retired topic's real wording survives; the API also never hard-deletes,
   * because `support_ticket.topic_id` is `ON DELETE RESTRICT`. So the customer
   * keeps the words she chose from while the Contact-us form stops offering
   * them. The fallback is defence against a future shape change, unreachable by
   * two independent mechanisms today — proved by Lane D and driven by Lane C.
   *
   * Declared here because the API already serves it and this schema was
   * **stripping** it — the sixth instance of schema-narrower-than-wire in this
   * contract, and the rule it breaks is the one written down in STATUS.md: *do
   * not narrow a response to match a schema — widen the schema.* Served first,
   * declared second, which is the wrong order and is why it needed catching.
   */
  topic: z.object({ en: z.string(), ar: z.string() }),
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
export type ImageRef = z.infer<typeof ImageRefSchema>;
export type Service = z.infer<typeof ServiceSchema>;
export type Artist = z.infer<typeof ArtistSchema>;
export type AvailabilitySlot = z.infer<typeof AvailabilitySlotSchema>;
export type Product = z.infer<typeof ProductSchema>;
export type MemberAddress = z.infer<typeof MemberAddressSchema>;
export type OrderStatus = z.infer<typeof OrderStatusSchema>;
export type ShopOrder = z.infer<typeof ShopOrderSchema>;
export type DeviceEnrolment = z.infer<typeof DeviceEnrolmentSchema>;
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
export type Voucher = z.infer<typeof VoucherSchema>;
export type VoucherRedemption = z.infer<typeof VoucherRedemptionSchema>;
