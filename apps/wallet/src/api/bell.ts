/**
 * The customer bell — `GET /members/me/notifications/feed` and
 * `POST /members/me/notifications/read`. Client ask W4.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * BARE PATHS, NOT `/v1/…`, AND THAT WAS MEASURED RATHER THAN GUESSED.
 *
 * This API serves both conventions (`getPromotions` is `/v1/salons/…`, every
 * other wallet read is bare), so the prefix is a per-route fact. Against the
 * real API on avo_lane_b, 2026-09-28: `GET /members/me/notifications/feed`
 * answered 200 and `GET /v1/members/me/notifications/feed` answered 404.
 * `api/src/routes/memberNotifications.ts` registers both doors bare.
 *
 * The feed sits BESIDE the preferences (`GET/PATCH /members/me/notifications`,
 * `api/account.ts`) and does not replace them: the switches say what arrives,
 * this says what did.
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * PARSED AT THE BOUNDARY, NEVER CAST. Every body goes through the schemas below
 * via `getJson`/`postAction`, and a body that does not satisfy them is an
 * `ApiError('server')` — a FAILED READ, which the bell renders as its error
 * state with a reference. It is never an empty bell: "You're all caught up" over
 * a response we could not read would be a false statement about her payments.
 *
 * THE ITEMS ARE STRUCTURED, NOT TEXT — lane A's deliberate call
 * (`services/memberNotifications.ts` § DECISION 4): `kind` plus integer fils,
 * ISO instants and stored names. The wallet composes the sentences from its own
 * copy module, in her language, and formats money only at the display boundary
 * (#1). The one exception is `campaign`, whose `title`/`body` are the merchant's
 * own words and are rendered verbatim.
 *
 * A KIND THIS CLIENT HAS NOT HEARD OF DOES NOT FAIL THE READ. The server filters
 * kinds in SQL today, so an unknown kind can only arrive when lane A adds a
 * sender before this app is updated. Failing the whole bell over one row would
 * take every receipt down with it; so an unknown kind parses to
 * `{ kind: 'unknown' }` carrying only the envelope (id, instants), and the panel
 * draws it as a neutral row — see `domain/bell.ts § unknown`. A KNOWN kind with a
 * malformed field is different: that is a contract violation, and it fails the
 * read exactly as any other bad body does.
 */

import { z } from 'zod';
import { FilsSchema } from '@avo/types';
import { getJson, postAction } from './client';

// ------------------------------------------------------------------ kinds --

/** `MEMBER_NOTIFICATION_KINDS` in api/src/services/memberNotifications.ts. */
export const BELL_KINDS = [
  'topup',
  'charge',
  'shop',
  'deposit_hold',
  'deposit_return',
  'booking_policy',
  'campaign',
] as const;

export type BellKind = (typeof BELL_KINDS)[number];

function isBellKind(k: unknown): k is BellKind {
  return typeof k === 'string' && (BELL_KINDS as readonly string[]).includes(k);
}

// ----------------------------------------------------------------- items --

const Instant = z.string().min(1);

/** Every item, whatever its kind. `id` is the transaction id or the campaign id. */
const Envelope = z.object({
  id: z.string().min(1),
  createdAt: Instant,
  readAt: Instant.nullable(),
});

/**
 * Money magnitudes are POSITIVE — the server's rule (`serialiseReceiptItem`
 * refuses a negative `amountFils`), and the direction is the kind. `FilsSchema`
 * refuses a float, so a fractional amount is a failed read, not a wrong figure.
 */
const Magnitude = FilsSchema.nonnegative();

const TopupItem = Envelope.extend({
  kind: z.literal('topup'),
  transactionId: z.string().min(1),
  amountFils: Magnitude,
  bonusFils: Magnitude,
  creditFils: Magnitude,
  method: z.enum(['knet', 'card', 'applepay', 'wallet']),
});

const ChargeItem = Envelope.extend({
  kind: z.literal('charge'),
  transactionId: z.string().min(1),
  amountFils: Magnitude,
  services: z.array(z.string()),
  customAmount: z.boolean(),
});

const ShopItem = Envelope.extend({
  kind: z.literal('shop'),
  transactionId: z.string().min(1),
  amountFils: Magnitude,
  items: z.array(z.object({ name: z.string(), qty: z.number().int().positive() })),
  fulfilment: z.enum(['pickup', 'delivery']),
});

const DepositHoldItem = Envelope.extend({
  kind: z.literal('deposit_hold'),
  transactionId: z.string().min(1),
  amountFils: Magnitude,
  bookingId: z.string().min(1),
  serviceName: z.string(),
  artistName: z.string(),
  startsAt: Instant,
});

const DepositReturnItem = Envelope.extend({
  kind: z.literal('deposit_return'),
  transactionId: z.string().min(1),
  amountFils: Magnitude,
  bookingId: z.string().min(1),
  reason: z.enum(['cancelled', 'no_show']),
  /** Null only when the server's join on HER booking found nothing. */
  serviceName: z.string().nullable(),
  startsAt: Instant.nullable(),
});

/**
 * `booking_policy` (migration 0066) — the salon published a new booking policy.
 * Bell only, never push, at most one a salon-day. It carries a pointer and no
 * text: the wallet reads the salon's current policy when she opens it. It was an
 * `unknown` row — drawn neutral, "update the app" — until this build knew it.
 */
const BookingPolicyItem = Envelope.extend({
  kind: z.literal('booking_policy'),
  salonId: z.string().min(1),
  policyId: z.string().min(1),
  policyVersion: z.number().int().positive(),
});

const CampaignItem = Envelope.extend({
  kind: z.literal('campaign'),
  campaignId: z.string().min(1),
  /** The merchant's own words. Rendered verbatim, never translated. */
  title: z.string(),
  body: z.string(),
});

/** The six known kinds, discriminated. */
const KnownItem = z.discriminatedUnion('kind', [
  TopupItem,
  ChargeItem,
  ShopItem,
  DepositHoldItem,
  DepositReturnItem,
  BookingPolicyItem,
  CampaignItem,
]);

/** A kind this build does not know. Only the envelope is read. */
const UnknownItem = Envelope.extend({ kind: z.string() }).transform((v) => ({
  id: v.id,
  createdAt: v.createdAt,
  readAt: v.readAt,
  kind: 'unknown' as const,
  /** What the server called it — for the console, never shown. */
  serverKind: v.kind,
}));

/**
 * The item schema. A known `kind` MUST satisfy its own shape — a `topup` with a
 * float `amountFils` fails the read rather than slipping through as "unknown".
 * Only a `kind` string outside `BELL_KINDS` takes the neutral path.
 */
export const BellItemSchema = z.unknown().transform((raw, ctx) => {
  const kind = (raw as { kind?: unknown } | null)?.kind;
  const schema = isBellKind(kind) ? KnownItem : UnknownItem;
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) ctx.addIssue(issue);
    return z.NEVER;
  }
  return parsed.data;
});

export type BellItem = z.infer<typeof BellItemSchema>;
export type KnownBellItem = z.infer<typeof KnownItem>;

// -------------------------------------------------------------- the feed --

export const BellFeedSchema = z.object({
  items: z.array(BellItemSchema),
  nextCursor: z.string().nullable(),
  /** Unread over her whole VISIBLE set — not this page. The badge. */
  unreadCount: z.number().int().nonnegative(),
  /**
   * Which kinds her bell can hold right now. `campaign` is absent when her
   * offers consent is off (lane A's Decision 3). A kind string this build does
   * not know is DROPPED, not refused: the list is advisory, and the one question
   * the client asks of it is "is `campaign` in here".
   */
  visibleKinds: z.array(z.string()).transform((ks) => ks.filter(isBellKind)),
});

export type BellFeed = z.infer<typeof BellFeedSchema>;

export const MarkReadResultSchema = z.object({
  marked: z.number().int().nonnegative(),
  unreadCount: z.number().int().nonnegative(),
});

export type MarkReadResult = z.infer<typeof MarkReadResultSchema>;

/**
 * One page of her bell. `cursor` is the server's `nextCursor`, passed back
 * untouched — it is opaque, and a client that built one would be addressing a
 * stream it does not own.
 */
export function getBellFeed(cursor: string | null, signal?: AbortSignal): Promise<BellFeed> {
  const query = cursor === null ? '' : `?cursor=${encodeURIComponent(cursor)}`;
  return getJson(`/members/me/notifications/feed${query}`, BellFeedSchema, signal);
}

/**
 * Mark these read. `{ ids }` ONLY, from this function — the ids of the rows the
 * panel actually DREW. The merchant bell made the same choice for the same
 * reason: `{ all: true }` sent on open would clear a badge larger than the rows
 * she has seen, including a whole page-two of history she never scrolled to.
 * "Mark all" is its own function below, reachable only from its own control.
 *
 * NO IDEMPOTENCY KEY: it moves no money (#4 is about money-moving POSTs), and
 * the server is idempotent anyway — a second mark answers `marked: 0`.
 */
export function markBellRead(ids: string[], signal?: AbortSignal): Promise<MarkReadResult> {
  return postAction('/members/me/notifications/read', { ids }, MarkReadResultSchema, {
    ...(signal ? { signal } : {}),
  });
}

/** `{ all: true }` — ONLY from the explicit "Mark all as read" control. */
export function markBellAllRead(signal?: AbortSignal): Promise<MarkReadResult> {
  return postAction('/members/me/notifications/read', { all: true }, MarkReadResultSchema, {
    ...(signal ? { signal } : {}),
  });
}

/** The server's cap on one `{ ids }` call (`MEMBER_MARK_READ_MAX_IDS`). */
export const MARK_READ_MAX_IDS = 100;
