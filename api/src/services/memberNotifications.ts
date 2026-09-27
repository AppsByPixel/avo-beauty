/**
 * THE CUSTOMER BELL — what it contains, where each row comes from, and why the
 * text is not composed here.
 *
 * Client ask 4 (wallet list): *"add a notification bell so they can see the
 * notifications and manage them"*. `GET/PATCH /members/me/notifications` already
 * exist and are the PREFERENCES — five switches, pinned as a settings shape by
 * `e2e/contract.test.ts`. There was nothing a customer could open to see what had
 * been sent to her. This module is that, and `routes/memberNotifications.ts` is its
 * two doors. The merchant bell (`services/merchantNotifications.ts`) is the
 * precedent for the shape; where this one differs, the difference is argued below.
 *
 * =========================================================================
 * DECISION 1 — A BELL ITEM IS SOMETHING THIS API ALREADY SENT HER. NOTHING ELSE.
 * =========================================================================
 * The first question was what a customer notification even IS here, and the rule
 * that answered it: *a feed of events that never fire is a screen that is
 * permanently empty and looks broken.* So the census was taken of what the API
 * actually writes per member, addressed TO her, and every kind below is one row
 * type that exists today:
 *
 *   SENT (an outbound record addressed to her, written in the producing transaction)
 *     topup           receipt_job, `services/topup.ts § creditWallet`
 *     charge          receipt_job, `services/charge.ts`
 *     shop            receipt_job, `services/order.ts`
 *     deposit_hold    receipt_job, `services/booking.ts § createBooking` — the booking
 *                     confirmation (whatsapp-templates.md § 1)
 *     deposit_return  receipt_job, `services/booking.ts § returnDeposit` — reached from
 *                     her own cancel AND from the no-show job (§ 4)
 *     campaign        campaign_send, `services/campaign.ts § deliverCampaign`
 *
 *   RECORDED BUT NEVER SENT — NOT IN THE BELL, deliberately
 *     tier_climb / stamp_reward_ready   loyalty_event. The design draws a "You're Gold"
 *                     push, but nothing queues one to her through any channel; the
 *                     row exists for the merchant's Overview feed.
 *
 *   DRAWN IN THE DESIGN, EMITTED BY NOTHING — NOT IN THE BELL
 *     day-before reminder (whatsapp-templates.md § 2), low balance
 *     (`AVO States.dc.html` push list), happy-hour / boost pushes, the
 *     "deletion cancelled" notice (`customerNoticeOwed: true` in topup.ts), the
 *     password-changed notice. No job, no row, no sender.
 *
 * Adding any of those is adding a SENDER, not a bell kind — and the bell then
 * picks it up for free if the sender writes one of the two records below.
 *
 * =========================================================================
 * DECISION 2 — READ FROM THE OUTBOUND RECORDS, NOT COPIED INTO A NEW TABLE.
 * =========================================================================
 * The merchant bell has `merchant_notification`, raised inside the producing
 * transaction. The customer bell does not get a twin, and the reason is where the
 * raise would have to go: the five receipt kinds are raised on FIVE MONEY PATHS.
 * A `member_notification` insert beside every `queueReceipts` call is a new
 * failure mode inside `POST /charges`, a charge that rolls back because a bell row
 * could not be written, for a fact `receipt_job` is already recording in the same
 * transaction. And a copy is the two-doors defect: the one nobody reads drifts.
 *
 * So the feed is a two-stream keyset read (`services/streamCursor.ts`, the same
 * machinery `GET /v1/platform/accounts` uses):
 *
 *   rank 0  receipt_job   ONE ROW PER TRANSACTION. The outbox is one row per
 *                         CHANNEL — a merchant with WhatsApp and email on writes two
 *                         rows for one top-up — and she was told once. The row with
 *                         the lowest channel in enum order stands for the pair.
 *   rank 1  campaign_send joined to a `sent` campaign OF HER OWN SALON.
 *
 * What neither record can hold is whether SHE has seen it. That is the only new
 * state — `member_notification_read`, migration 0057 — and absence of a row is
 * "unread".
 *
 * Every receipt kind exists IF AND ONLY IF THE MONEY MOVED: `queueReceipts` runs
 * inside the money transaction, so a charge that rolled back left no receipt row
 * and so no bell item. A bell that announced a top-up which did not settle would
 * be worse than no bell.
 *
 * =========================================================================
 * DECISION 3 — NON-NEGOTIABLE #8: THE BELL DISPLAYS DELIVERIES, IT IS NOT ONE.
 * =========================================================================
 * `campaign_send` rows are written by `deliverCampaign` alone, AFTER the platform
 * approved the campaign and AFTER quiet hours and both caps passed at send time. A
 * campaign that is pending, rejected, approved-but-held, or that she was capped out
 * of has no `campaign_send` row for her, so it is not in her bell. The read also
 * requires `campaign.status = 'sent'` and `campaign.salon_id = her salon` — both
 * already true of every row that exists, both stated so that no future writer of
 * `campaign_send` turns this endpoint into a path by which a merchant reaches a
 * customer. Nothing here WRITES anything a merchant authored.
 *
 * TWO FURTHER FILTERS, and they are the customer-side analogue of the merchant
 * bell's `visibleKinds`:
 *
 *   CHANNEL `push` OR `both`. The bell is the app's own channel. A campaign the
 *     merchant chose to send by WhatsApp only, and the platform approved AS a
 *     WhatsApp send, was not an app notification; echoing it into the app would be
 *     a channel nobody approved.
 *
 *   HER CURRENT `offers` CONSENT. If she has withdrawn marketing consent, delivered
 *     campaigns leave her bell. Withdrawal means "stop showing me salon offers", and
 *     an inbox that keeps presenting the old ones is continuing to market to a
 *     customer who has said no. It is reversible — turning offers back on brings
 *     them back — because the history is not deleted, only not shown.
 *
 * So `visibleKinds` is served, exactly as the merchant bell serves it and for the
 * same reason: "You're all caught up" is a narrower sentence when `campaign` is not
 * visible, and the client can say so and link to Account → Notifications, where the
 * switch is. That is the "manage them" half of the ask: mark read here, and the
 * existing preferences endpoint for what arrives. The preferences are NOT rebuilt.
 *
 * Receipts are not filtered by any switch. `wa` and `receipt` choose the CHANNELS a
 * receipt is sent on, not whether the money moved; `push` is lock-screen delivery,
 * which does not exist yet. The in-app record of a settled payment is not something
 * a customer opts out of any more than her transaction list is.
 *
 * =========================================================================
 * DECISION 4 — NON-NEGOTIABLE #12: STRUCTURED FIELDS, NOT COMPOSED TEXT.
 * =========================================================================
 * The merchant bell serves `title` and `body` composed here — correctly, because
 * the merchant surfaces are English-only. The wallet is not, and composing both
 * languages on the server is the WRONG LAYER, for four reasons:
 *
 *   1. THE COPY ALREADY HAS A HOME. `apps/wallet/src/copy/{en,ar}.ts` is the
 *      wallet's one copy module, with the feminine address and the digits rule
 *      (`i18n/digits.ts`) enforced by its own tests. A second copy source on the
 *      server is a second place for the Arabic to drift, and the one nobody reads
 *      drifts first.
 *   2. MONEY IS FORMATTED AT THE DISPLAY BOUNDARY — non-negotiable #1's last
 *      sentence. `formatMoney(fils, 'ar')` is the wallet's call to make; a server
 *      string with "5.000 د.ك" baked in is a formatted number travelling as text.
 *   3. THE LANGUAGE IS HERS AND CAN CHANGE WITHOUT A ROUND TRIP. The wallet flips
 *      language locally; server text would be stale the instant she switched.
 *   4. THE DESIGN'S BILINGUAL COPY IS TEMPLATES WITH VARIABLES.
 *      `whatsapp-templates.md` gives EN + AR for booking confirmation, payment
 *      receipt and deposit returned as positional variables. Serving the variables
 *      is serving exactly what that copy needs.
 *
 * So every item is `kind` + named fields: integer fils, ISO instants, names as
 * stored. Lane B renders them.
 *
 * THE ONE EXCEPTION IS `campaign`, and it is not an exception to the rule: its
 * `title` and `body` are the MERCHANT'S OWN WORDS, written in whatever language she
 * wrote them in. They are content, not product copy, and they are served verbatim —
 * translating them is not this API's to do, and `campaign` has no Arabic column.
 *
 * NO BALANCE IS SERVED. whatsapp-templates.md: "Never include a balance in a message
 * that could be read over someone's shoulder." The receipt payload carries
 * `balanceAfterFils`; the bell does not repeat it. Her balance is on Home.
 *
 * =========================================================================
 * DECISION 5 — SCOPED BY THE CREDENTIAL, AND AN ERASED MEMBER HAS NO BELL.
 * =========================================================================
 * `/members/me/…`. There is no id in the URL, so a customer cannot address another
 * customer's bell at all — `routes/bookings.ts`'s argument for the member routes.
 * Every query below takes `memberId` from the principal and nothing else.
 *
 * ERASURE (`services/erasure.ts`) deletes her `receipt_job` rows and her read marks,
 * but `campaign_send` CANNOT be deleted (0028's REVOKE) — so a tombstone would still
 * have a campaign stream. `feedScope` refuses a member with `erased_at` set and the
 * feed answers empty. A tombstone cannot sign in and its sessions are deleted, so
 * the route never gets here in practice; this is the layer that holds if that ever
 * stops being true.
 *
 * =========================================================================
 * THE BELL IS CHROME AND MUST NOT EXPLODE.
 * =========================================================================
 * The merchant bell's rule, and it has a customer-side edge: `receipt_job.payload`
 * is jsonb written by five call sites. A row whose payload does not parse as its
 * kind serialises as NOTHING (it is dropped from the page and logged) rather than
 * throwing — a bell that 500s over one malformed row takes the wallet's header down
 * with it. The kind filter is also applied IN SQL, so a payload of a kind this file
 * does not know is neither served nor counted, and the badge cannot disagree with the
 * panel.
 */

import { and, count, desc, eq, inArray, isNull, notExists, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Db } from '../db/client';
import { campaign, campaignSend } from '../db/schema/campaign';
import { member } from '../db/schema/member';
import { memberNotificationRead } from '../db/schema/memberNotification';
import { receiptJob } from '../db/schema/receipt';
import { booking } from '../db/schema/booking';
import { service } from '../db/schema/service';
import { marketingConsentOf } from './consent';
import {
  afterCursor,
  cursorInstant,
  mergePage,
  type Keyed,
  type StreamCursor,
} from './streamCursor';

// ------------------------------------------------------------------ kinds --

/** The receipt kinds, exactly `ReceiptPayload['kind']` in services/receipts.ts. */
export const RECEIPT_KINDS = ['topup', 'charge', 'shop', 'deposit_hold', 'deposit_return'] as const;
export type ReceiptKind = (typeof RECEIPT_KINDS)[number];

export const MEMBER_NOTIFICATION_KINDS = [...RECEIPT_KINDS, 'campaign'] as const;
export type MemberNotificationKind = (typeof MEMBER_NOTIFICATION_KINDS)[number];

/** Two streams, one rank each. Its own rank set, so no other endpoint's cursor addresses it. */
export const BELL_RANKS = [0, 1] as const;
const RANK_RECEIPT = 0;
const RANK_CAMPAIGN = 1;

/** A page. Fixed, not client-chosen — the merchant bell's number and reasoning. */
export const MEMBER_NOTIFICATION_PAGE_SIZE = 20;
/** `MARK_READ_MAX_IDS`'s bound, for the same reason. */
export const MEMBER_MARK_READ_MAX_IDS = MEMBER_NOTIFICATION_PAGE_SIZE * 5;

/** Campaign channels that ARE the app's own channel. Decision 3. */
const APP_CHANNELS = ['push', 'both'];

// ----------------------------------------------------------------- shapes --

interface ItemBase {
  /** The transaction id for a receipt item, the campaign id for a campaign. */
  id: string;
  createdAt: string;
  /** When SHE marked it read. Per member, which is per reader. */
  readAt: string | null;
}

/**
 * ONE ITEM, DISCRIMINATED ON `kind`. Every money field is integer fils and every
 * magnitude is POSITIVE — the direction is the kind, as it is in the receipt
 * payloads these are read from. `transactionId` is the Activity deep link: the
 * design's deep-link list sends top-up and deposit to "Activity detail".
 */
export type MemberNotificationItem =
  | (ItemBase & {
      kind: 'topup';
      transactionId: string;
      /** What she paid. */
      amountFils: number;
      /** Tier bonus as locked on the intent. */
      bonusFils: number;
      /** What landed. `amountFils + bonusFils + any promotion bonus`. */
      creditFils: number;
      method: 'knet' | 'card' | 'applepay' | 'wallet';
    })
  | (ItemBase & {
      kind: 'charge';
      transactionId: string;
      amountFils: number;
      /** Service names as charged. Empty for a typed amount — see `customAmount`. */
      services: string[];
      /** The price was typed by a manager rather than drawn from the catalogue. */
      customAmount: boolean;
    })
  | (ItemBase & {
      kind: 'shop';
      transactionId: string;
      amountFils: number;
      items: Array<{ name: string; qty: number }>;
      fulfilment: 'pickup' | 'delivery';
    })
  | (ItemBase & {
      kind: 'deposit_hold';
      transactionId: string;
      amountFils: number;
      bookingId: string;
      serviceName: string;
      artistName: string;
      startsAt: string;
    })
  | (ItemBase & {
      kind: 'deposit_return';
      transactionId: string;
      amountFils: number;
      bookingId: string;
      reason: 'cancelled' | 'no_show';
      /** From the booking, for "your 9 Jul blow-dry". Null only if the join finds nothing. */
      serviceName: string | null;
      startsAt: string | null;
    })
  | (ItemBase & {
      kind: 'campaign';
      campaignId: string;
      /** The merchant's own words, verbatim. Decision 4. */
      title: string;
      body: string;
    });

export interface MemberFeed {
  items: MemberNotificationItem[];
  nextCursor: string | null;
  /** Unread over the whole VISIBLE set. Not the page, and not cursor-dependent. */
  unreadCount: number;
  /** Which kinds this bell can contain for her right now. Decision 3. */
  visibleKinds: MemberNotificationKind[];
}

// ------------------------------------------------------------ scope --

interface FeedScope {
  memberId: string;
  salonId: string;
  /** Erased: no feed at all. Decision 5. */
  erased: boolean;
  campaignsVisible: boolean;
}

export async function feedScope(db: Db, memberId: string): Promise<FeedScope> {
  const [m] = await db
    .select({ id: member.id, salonId: member.salonId, erasedAt: member.erasedAt })
    .from(member)
    .where(eq(member.id, memberId))
    .limit(1);

  if (!m || m.erasedAt !== null) {
    return { memberId, salonId: m?.salonId ?? '', erased: true, campaignsVisible: false };
  }
  const consent = await marketingConsentOf(db, m.id);
  return { memberId: m.id, salonId: m.salonId, erased: false, campaignsVisible: consent.granted };
}

export function visibleKindsFor(scope: FeedScope): MemberNotificationKind[] {
  if (scope.erased) return [];
  return scope.campaignsVisible ? [...MEMBER_NOTIFICATION_KINDS] : [...RECEIPT_KINDS];
}

// ------------------------------------------------------------- predicates --

const otherChannel = alias(receiptJob, 'rj_other');

/**
 * THE RECEIPT STREAM'S WHERE, shared by the page, the count and the mark — one
 * definition, so the badge, the panel and "mark all" cannot disagree about what a
 * receipt item is.
 */
function receiptStreamWhere(db: Db, memberId: string): SQL {
  return and(
    eq(receiptJob.memberId, memberId),
    /**
     * ONE ROW PER TRANSACTION. The pair written for WhatsApp + email is one thing
     * she was told; the lowest channel in enum order stands for it.
     */
    notExists(
      db
        .select({ one: sql`1` })
        .from(otherChannel)
        .where(
          and(
            eq(otherChannel.transactionId, receiptJob.transactionId),
            eq(otherChannel.memberId, receiptJob.memberId),
            sql`${otherChannel.channel} < ${receiptJob.channel}`,
          ),
        ),
    ),
    /** Known kinds only, in SQL — so the count can never include a row the page drops. */
    sql`(${receiptJob.payload}->>'kind') IN (${sql.join(
      RECEIPT_KINDS.map((k) => sql`${k}`),
      sql`, `,
    )})`,
  )!;
}

/** Joined on the mark for THIS member only — a mark is hers or it is nothing. */
function receiptMarkJoin(memberId: string): SQL {
  return and(
    eq(memberNotificationRead.memberId, memberId),
    eq(memberNotificationRead.transactionId, receiptJob.transactionId),
  )!;
}

function campaignStreamWhere(scope: FeedScope): SQL {
  return and(
    eq(campaignSend.memberId, scope.memberId),
    /** Decision 3, stated even though every row that exists already satisfies it. */
    eq(campaign.status, 'sent'),
    eq(campaign.salonId, scope.salonId),
    inArray(campaignSend.channel, APP_CHANNELS),
  )!;
}

function campaignMarkJoin(memberId: string): SQL {
  return and(
    eq(memberNotificationRead.memberId, memberId),
    eq(memberNotificationRead.campaignId, campaignSend.campaignId),
  )!;
}

// ------------------------------------------------------------ serialising --

type Json = Record<string, unknown>;
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);
const isStr = (v: unknown): v is string => typeof v === 'string';

/**
 * A receipt payload → one item, or `null` if the payload is not the shape its own
 * kind promises. `null` is dropped from the page and logged; see the header.
 */
export function serialiseReceiptItem(row: {
  transactionId: string;
  payload: unknown;
  createdAt: Date;
  readAt: Date | null;
  bookingServiceName?: string | null;
  bookingStartsAt?: Date | null;
}): MemberNotificationItem | null {
  const p = (row.payload ?? {}) as Json;
  const base = {
    id: row.transactionId,
    transactionId: row.transactionId,
    createdAt: row.createdAt.toISOString(),
    readAt: row.readAt?.toISOString() ?? null,
  };
  if (!isInt(p.amountFils) || p.amountFils < 0) return null;
  const amountFils = p.amountFils;

  switch (p.kind) {
    case 'topup': {
      if (!isInt(p.bonusFils) || !isInt(p.creditFils) || !isStr(p.method)) return null;
      if (!['knet', 'card', 'applepay', 'wallet'].includes(p.method)) return null;
      return {
        ...base,
        kind: 'topup',
        amountFils,
        bonusFils: p.bonusFils,
        creditFils: p.creditFils,
        method: p.method as 'knet' | 'card' | 'applepay' | 'wallet',
      };
    }
    case 'charge': {
      if (!Array.isArray(p.services)) return null;
      const services = (p.services as Json[]).map((s) => s?.name);
      if (!services.every(isStr)) return null;
      return {
        ...base,
        kind: 'charge',
        amountFils,
        services: services as string[],
        customAmount: p.custom !== undefined && p.custom !== null,
      };
    }
    case 'shop': {
      if (!Array.isArray(p.items)) return null;
      const items = (p.items as Json[]).map((i) => ({ name: i?.name, qty: i?.qty }));
      if (!items.every((i) => isStr(i.name) && isInt(i.qty))) return null;
      if (p.fulfilment !== 'pickup' && p.fulfilment !== 'delivery') return null;
      return {
        ...base,
        kind: 'shop',
        amountFils,
        items: items as Array<{ name: string; qty: number }>,
        fulfilment: p.fulfilment,
      };
    }
    case 'deposit_hold': {
      if (!isStr(p.bookingId) || !isStr(p.serviceName) || !isStr(p.artistName)) return null;
      if (!isStr(p.startsAt)) return null;
      return {
        ...base,
        kind: 'deposit_hold',
        amountFils,
        bookingId: p.bookingId,
        serviceName: p.serviceName,
        artistName: p.artistName,
        startsAt: p.startsAt,
      };
    }
    case 'deposit_return': {
      if (!isStr(p.bookingId)) return null;
      if (p.reason !== 'cancelled' && p.reason !== 'no_show') return null;
      return {
        ...base,
        kind: 'deposit_return',
        amountFils,
        bookingId: p.bookingId,
        reason: p.reason,
        serviceName: row.bookingServiceName ?? null,
        startsAt: row.bookingStartsAt?.toISOString() ?? null,
      };
    }
    default:
      return null;
  }
}

// ------------------------------------------------------------------ reads --

/** The badge: unread over the visible set. See the header. */
export async function unreadCountFor(db: Db, scope: FeedScope): Promise<number> {
  if (scope.erased) return 0;

  const [r] = await db
    .select({ n: count() })
    .from(receiptJob)
    .leftJoin(memberNotificationRead, receiptMarkJoin(scope.memberId))
    .where(and(receiptStreamWhere(db, scope.memberId), isNull(memberNotificationRead.readAt)));

  let campaigns = 0;
  if (scope.campaignsVisible) {
    const [c] = await db
      .select({ n: count() })
      .from(campaignSend)
      .innerJoin(campaign, eq(campaign.id, campaignSend.campaignId))
      .leftJoin(memberNotificationRead, campaignMarkJoin(scope.memberId))
      .where(and(campaignStreamWhere(scope), isNull(memberNotificationRead.readAt)));
    campaigns = Number(c?.n ?? 0);
  }
  return Number(r?.n ?? 0) + campaigns;
}

/**
 * One page of her bell. Newest first, `(at, rank, id)` — `services/streamCursor.ts`.
 * Each stream reads `limit + 1` and `mergePage` takes the first `limit` of the merge,
 * which is sound because a row not fetched from a stream is older than every row
 * that was.
 */
export async function readMemberFeed(
  db: Db,
  memberId: string,
  cursor: StreamCursor | null,
): Promise<MemberFeed> {
  const scope = await feedScope(db, memberId);
  if (scope.erased) return { items: [], nextCursor: null, unreadCount: 0, visibleKinds: [] };

  const take = MEMBER_NOTIFICATION_PAGE_SIZE + 1;

  const receipts = await db
    .select({
      transactionId: receiptJob.transactionId,
      payload: receiptJob.payload,
      createdAt: receiptJob.createdAt,
      at: cursorInstant(receiptJob.createdAt),
      readAt: memberNotificationRead.readAt,
      bookingServiceName: service.name,
      bookingStartsAt: booking.startsAt,
    })
    .from(receiptJob)
    .leftJoin(memberNotificationRead, receiptMarkJoin(memberId))
    /**
     * `deposit_return`'s payload carries only the booking id, and "your 9 Jul
     * blow-dry" needs the service and the date. A LEFT join on a booking of HERS —
     * never on the id alone — so a payload naming somebody else's booking finds
     * nothing rather than her name for it.
     */
    .leftJoin(
      booking,
      and(
        sql`${receiptJob.payload}->>'kind' = 'deposit_return'`,
        eq(booking.id, sql`${receiptJob.payload}->>'bookingId'`),
        eq(booking.memberId, memberId),
      ),
    )
    .leftJoin(service, eq(service.id, booking.serviceId))
    .where(
      and(
        receiptStreamWhere(db, memberId),
        afterCursor(cursor, RANK_RECEIPT, receiptJob.createdAt, receiptJob.transactionId),
      ),
    )
    .orderBy(desc(receiptJob.createdAt), receiptJob.transactionId)
    .limit(take);

  const campaigns = scope.campaignsVisible
    ? await db
        .select({
          campaignId: campaignSend.campaignId,
          title: campaign.title,
          body: campaign.body,
          sentAt: campaignSend.sentAt,
          at: cursorInstant(campaignSend.sentAt),
          readAt: memberNotificationRead.readAt,
        })
        .from(campaignSend)
        .innerJoin(campaign, eq(campaign.id, campaignSend.campaignId))
        .leftJoin(memberNotificationRead, campaignMarkJoin(memberId))
        .where(
          and(
            campaignStreamWhere(scope),
            afterCursor(cursor, RANK_CAMPAIGN, campaignSend.sentAt, campaignSend.campaignId),
          ),
        )
        .orderBy(desc(campaignSend.sentAt), campaignSend.campaignId)
        .limit(take)
    : [];

  /**
   * A malformed receipt KEEPS ITS PLACE IN THE KEY ORDER and is dropped after the
   * merge, so the cursor still advances past it. Dropping it before the merge would
   * let a bad row at a page boundary be re-read as the first row of the next page
   * and dropped again — harmless, but a cursor that depends on what the serialiser
   * accepted is a cursor that can stall.
   */
  const keyed: Keyed<MemberNotificationItem | null>[] = [
    ...receipts.map((r) => ({
      item: serialiseReceiptItem(r),
      rank: RANK_RECEIPT,
      at: r.at,
      id: r.transactionId,
    })),
    ...campaigns.map((c) => ({
      item: {
        id: c.campaignId,
        kind: 'campaign' as const,
        campaignId: c.campaignId,
        title: c.title,
        body: c.body,
        createdAt: c.sentAt.toISOString(),
        readAt: c.readAt?.toISOString() ?? null,
      },
      rank: RANK_CAMPAIGN,
      at: c.at,
      id: c.campaignId,
    })),
  ];

  const page = mergePage(keyed, MEMBER_NOTIFICATION_PAGE_SIZE);
  const items: MemberNotificationItem[] = [];
  page.items.forEach((item, i) => {
    if (item) items.push(item);
    else {
      // Logged, not thrown. Which row, not what was in it: the payload names what she bought.
      console.warn(`[member-bell] dropped a malformed receipt payload (page position ${i})`);
    }
  });

  return {
    items,
    nextCursor: page.nextCursor,
    unreadCount: await unreadCountFor(db, scope),
    visibleKinds: visibleKindsFor(scope),
  };
}

// ------------------------------------------------------------------ write --

export type MarkSelection = { all: true } | { ids: string[] };

/**
 * Mark read — named ids, or everything visible.
 *
 * SELECTED FROM HER OWN FEED, THEN INSERTED. The ids a client sends are a FILTER on her
 * stream, never a value written: a mark can only be written for a row that is in
 * her visible feed, so another customer's transaction id, a campaign she was not
 * sent, a campaign she cannot currently see, and a string that names nothing all
 * mark nothing and are indistinguishable from an already-read id. The merchant
 * bell's no-oracle rule, and here it is also what keeps junk out of the table.
 *
 * `ON CONFLICT DO NOTHING` + `NOT EXISTS` is the idempotence: a second call marks
 * nothing and the FIRST `read_at` survives.
 *
 * "MARK ALL" IS EXACT, NOT A WATERMARK. A "read through <instant>" column would
 * swallow a receipt whose transaction STARTED before the instant and COMMITTED
 * after it — a top-up settling while she taps the button — and she would never see
 * it as unread. Inserting the ids that were visible in this statement's snapshot
 * marks precisely what she could have seen, and nothing that arrived during it.
 */
export async function markMemberNotificationsRead(
  db: Db,
  memberId: string,
  selection: MarkSelection,
): Promise<{ marked: number; unreadCount: number }> {
  const scope = await feedScope(db, memberId);
  if (scope.erased) return { marked: 0, unreadCount: 0 };

  const ids = 'ids' in selection ? selection.ids : null;

  const receiptIds = await db
    .selectDistinct({ id: receiptJob.transactionId })
    .from(receiptJob)
    .leftJoin(memberNotificationRead, receiptMarkJoin(memberId))
    .where(
      and(
        receiptStreamWhere(db, memberId),
        isNull(memberNotificationRead.readAt),
        ids ? inArray(receiptJob.transactionId, ids) : undefined,
      ),
    );

  const campaignIds = scope.campaignsVisible
    ? await db
        .selectDistinct({ id: campaignSend.campaignId })
        .from(campaignSend)
        .innerJoin(campaign, eq(campaign.id, campaignSend.campaignId))
        .leftJoin(memberNotificationRead, campaignMarkJoin(memberId))
        .where(
          and(
            campaignStreamWhere(scope),
            isNull(memberNotificationRead.readAt),
            ids ? inArray(campaignSend.campaignId, ids) : undefined,
          ),
        )
    : [];

  const rows = [
    ...receiptIds.map((r) => ({ memberId, transactionId: r.id, campaignId: null })),
    ...campaignIds.map((c) => ({ memberId, transactionId: null, campaignId: c.id })),
  ];

  const marked =
    rows.length === 0
      ? []
      : await db
          .insert(memberNotificationRead)
          .values(rows)
          .onConflictDoNothing()
          .returning({ memberId: memberNotificationRead.memberId });

  return { marked: marked.length, unreadCount: await unreadCountFor(db, scope) };
}
