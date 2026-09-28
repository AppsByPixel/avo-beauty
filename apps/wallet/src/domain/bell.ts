/**
 * The bell's rows — every kind, composed from the wallet's copy module. Pure, so
 * each kind has a spec in both languages (`bell.test.ts`) without a renderer.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE ITEMS ARE STRUCTURED AND THIS IS WHERE THEY BECOME WORDS.
 *
 * Lane A serves `kind` + integer fils + ISO instants + stored names and
 * deliberately no text (`services/memberNotifications.ts` § DECISION 4): the
 * copy module is the wallet's, the language is hers and can flip without a
 * round trip, and money is formatted at the display boundary (#1). So:
 *
 *   · every sentence comes from `copy` — never from a literal here, and never
 *     from a server string, with ONE exception:
 *   · a `campaign` row's title and body are the MERCHANT'S OWN WORDS, served
 *     verbatim in whatever language she wrote them. They are content, not
 *     product copy, and they are rendered as-is. Not translated, not trimmed.
 *   · money goes through `formatFils` / `moneyAriaLabel` from @avo/types and
 *     nothing else — Western digits in both languages (#12).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * TWO LIMITS LANE A REPORTED, AND WHAT THIS FILE DOES ABOUT EACH.
 *
 * 1. A VOIDED CHARGE STILL ARRIVES AS A PLAIN `charge`. The item has no void
 *    flag. This file does not render it as a normal successful charge WHEN IT
 *    CAN TELL: Home already holds `GET /members/me/transactions`, whose
 *    `Transaction.voidedAt` is the server's own void state, so a `charge` whose
 *    `transactionId` is on that page with `voidedAt` set is drawn as voided —
 *    unsigned figure, "Voided — the amount is back in your wallet". When the
 *    charge is NOT on the page (older than the first page of history), it
 *    cannot tell, and the row reads as an ordinary charge. That residue is
 *    reported, not papered over: the fix is a `voided` field on the item, which
 *    is lane A's.
 *
 * 2. A CARD-PAID SHOP ORDER WRITES TWO RECEIPTS — a `topup` for the card money
 *    and a `shop` for the order — "truthful but could confuse her". Drawn as
 *    two rows they read as "you topped up 8.500 and then spent 8.500", which is
 *    true of the ledger and not of what she did. So `pairCardOrders` folds them
 *    into ONE row: "Shop order · KNET", the lines, "Paid by KNET", and the bonus
 *    if one landed. The figure is UNSIGNED — the card paid, her balance did not
 *    fall — and the row stands for BOTH ids, so opening the bell marks both.
 *
 *    HOW THE PAIR IS RECOGNISED, and it is a heuristic, stated as one: a
 *    `topup` and a `shop` with the SAME `createdAt` to the millisecond and the
 *    SAME `amountFils`, method not `wallet`. `creditWallet` and the attached
 *    order run in ONE database transaction and `receipt_job.created_at` is
 *    `now()`, which Postgres fixes at transaction start — so the two receipts
 *    are stamped identically (driven: both `2026-09-28T08:38:18.990Z`). Two
 *    independent transactions agreeing to the millisecond AND on the amount is
 *    not a case a customer can produce. A pair split across a page boundary is
 *    drawn as two rows; a card payment whose order was REFUSED writes no shop
 *    receipt and is drawn as the top-up it became.
 *
 * 3. A SHOP ITEM CARRIES NO PICKUP BRANCH — found by W7, not reported by lane
 *    A. The item is projected from `receipt_job.payload`
 *    (api/src/services/memberNotifications.ts), and that payload carries the
 *    fulfilment but not where she collects. Every ORDER read does carry
 *    `pickupBranch` (migration 0060), so the row is joined by `transactionId`
 *    against `GET /members/me/orders` — the same move as the void in 1 — and
 *    `domain/shopOrders § pickupLocation` decides the words, so the bell and
 *    the orders list cannot disagree. When the order is NOT on that page
 *    (the read failed, is in flight, or is past its cap of 200) the row says
 *    "Pickup" and nothing about where, which claims no location. REPORTED: the
 *    fix is `pickupBranch` on the shop item, which is lane A's.
 * ═════════════════════════════════════════════════════════════════════════════
 */

import {
  fils,
  formatFils,
  formatMoney,
  moneyAriaLabel,
  type Language,
  type ShopOrder,
  type Transaction,
} from '@avo/types';
import type { Copy } from '../copy/types';
import type { BellItem, KnownBellItem } from '../api/bell';
import { branchName } from './names';
import { pickupLocation } from './shopOrders';
import { dateLocale, dayAndTime } from './activity';

const KUWAIT_TIME_ZONE = 'Asia/Kuwait';

/** The figure column. Absent on a row that moved no money (campaign, unknown). */
export interface BellAmount {
  /** "+9.350" / "−8.500" / "8.500" — 3 decimals, Western digits, both languages. */
  display: string;
  /** Spoken — "dinars", not "thousands". */
  label: string;
  tone: 'in' | 'out' | 'neutral';
}

export interface BellRow {
  /** React key. The first id the row stands for. */
  key: string;
  /**
   * Every notification id this row stands for — one, or two for a card-paid
   * order. THESE are what "mark the drawn rows read" sends.
   */
  ids: string[];
  kind: KnownBellItem['kind'] | 'card_order' | 'unknown';
  title: string;
  /** Second and third lines, in order. Empty strings are never pushed. */
  lines: string[];
  amount: BellAmount | null;
  when: string;
  unread: boolean;
  /**
   * Whether opening the bell may mark this row read. FALSE ONLY FOR AN UNKNOWN
   * KIND: she was shown "update the app to read this one", not the thing
   * itself, so marking it read would clear a notification she has not been
   * able to read. It stays unread — and the badge stays equal to the unread
   * rows she can see — until an update draws it properly.
   */
  markable: boolean;
  /** The row's words are the merchant's, verbatim. */
  verbatim: boolean;
}

export interface BellContext {
  lang: Language;
  copy: Copy;
  /** The salon's name in the reading language — `salonName()`. */
  salon: string;
  /**
   * Home's `GET /members/me/transactions` page, for the void. See the header,
   * limit 1. Only `id` and `voidedAt` are read.
   */
  transactions: readonly Pick<Transaction, 'id' | 'voidedAt'>[];
  /**
   * `GET /members/me/orders`, for WHERE a pickup is collected — see the header,
   * limit 3. Optional: absent or empty, a pickup row names no branch.
   */
  orders?: readonly Pick<ShopOrder, 'transactionId' | 'fulfilment' | 'status' | 'pickupBranch'>[];
  now?: Date;
}

// ----------------------------------------------------------------- money --

function inflow(amountFils: number, lang: Language, copy: Copy): BellAmount {
  const f = fils(amountFils);
  return {
    display: amountFils === 0 ? formatFils(f) : `+${formatFils(f)}`,
    label: amountFils === 0 ? moneyAriaLabel(f, lang) : copy.plus(moneyAriaLabel(f, lang)),
    tone: amountFils === 0 ? 'neutral' : 'in',
  };
}

function outflow(amountFils: number, lang: Language, copy: Copy): BellAmount {
  const f = fils(amountFils);
  /*
    NO SIGN ON A ZERO — the activity row's rule (`toActivityRow`): a charge a held
    deposit covered entirely is a real 0-fils row, and a minus asserts a
    direction that did not occur. U+2212 MINUS, the character the design sets.
  */
  return {
    display: amountFils === 0 ? formatFils(f) : `−${formatFils(f)}`,
    label: amountFils === 0 ? moneyAriaLabel(f, lang) : copy.minus(moneyAriaLabel(f, lang)),
    tone: amountFils === 0 ? 'neutral' : 'out',
  };
}

function unsigned(amountFils: number, lang: Language): BellAmount {
  const f = fils(amountFils);
  return { display: formatFils(f), label: moneyAriaLabel(f, lang), tone: 'neutral' };
}

// ----------------------------------------------------------------- dates --

/** "Sat 12 Jul" — the booking's day, Kuwait time. Eastern digits in Arabic. */
export function dayLabel(iso: string, lang: Language): string {
  return new Intl.DateTimeFormat(dateLocale(lang), {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: KUWAIT_TIME_ZONE,
  }).format(new Date(iso));
}

/** "4:30 pm" — the booking's time. Arabic renders ص/م, as the templates ask. */
export function timeLabel(iso: string, lang: Language): string {
  return new Intl.DateTimeFormat(dateLocale(lang), {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: KUWAIT_TIME_ZONE,
  }).format(new Date(iso));
}

// ------------------------------------------------------------------ rows --

/** A list of names. Arabic takes its own comma, U+060C. Punctuation, not copy. */
function listSeparator(lang: Language): string {
  return lang === 'ar' ? '، ' : ', ';
}

function base(item: BellItem, ctx: BellContext) {
  return {
    key: item.id,
    ids: [item.id],
    when: dayAndTime(new Date(item.createdAt), ctx.lang, ctx.copy, ctx.now),
    unread: item.readAt === null,
  };
}

function shopLines(item: Extract<KnownBellItem, { kind: 'shop' }>, ctx: BellContext): string[] {
  const { lang, copy } = ctx;
  const goods = item.items.map((l) => copy.bellShopLine(l.name, l.qty)).join(listSeparator(lang));
  const where = item.fulfilment === 'delivery' ? copy.bellDelivery : pickupWords(item, ctx);
  return [goods === '' ? where : `${goods} · ${where}`];
}

/**
 * Where a pickup is collected, joined from her orders — header, limit 3. The
 * ORDER's fulfilment is read, not the item's, so the two cannot be crossed:
 * `pickupLocation` returns null for a delivery and the row falls back.
 */
function pickupWords(item: Extract<KnownBellItem, { kind: 'shop' }>, ctx: BellContext): string {
  const { lang, copy } = ctx;
  const order = ctx.orders?.find((o) => o.transactionId === item.transactionId);
  const where = order ? pickupLocation(order) : null;
  if (where === null) return copy.bellPickup;
  if (where.kind === 'notRecorded') return copy.bellPickupUnrecorded;
  const name = branchName(where.branch, lang);
  return where.kind === 'closedWaiting' ? copy.bellPickupClosed(name) : copy.bellPickupAt(name);
}

/**
 * One item → one row. TOTAL: every known kind has a branch, and anything else
 * is the neutral unknown row — never a throw inside a component render.
 */
export function bellRow(item: BellItem, ctx: BellContext): BellRow {
  const { lang, copy } = ctx;
  const b = base(item, ctx);

  switch (item.kind) {
    case 'topup':
      return {
        ...b,
        kind: 'topup',
        // The activity row's own title — "Top-up · KNET" (design:1577-1579).
        title: `${copy.txKind.topup} · ${copy.txMethod[item.method]}`,
        lines:
          item.bonusFils > 0 ? [copy.bellTopupBonus(formatMoney(fils(item.bonusFils), lang))] : [],
        // What LANDED, which is what the activity row shows for a top-up too.
        amount: inflow(item.creditFils, lang, copy),
        markable: true,
        verbatim: false,
      };

    case 'charge': {
      const voided =
        ctx.transactions.find((tx) => tx.id === item.transactionId)?.voidedAt != null;
      const what =
        item.services.length > 0
          ? item.services.join(listSeparator(lang))
          : item.customAmount
            ? copy.bellChargeCustom
            : '';
      return {
        ...b,
        kind: 'charge',
        title: copy.txKind.charge,
        lines: [what, voided ? copy.bellChargeVoided : ''].filter((l) => l !== ''),
        /*
          A VOIDED CHARGE IS NOT DRAWN AS A DEBIT. The money came back, so a
          minus in the figure column would contradict the line beneath it.
        */
        amount: voided ? unsigned(item.amountFils, lang) : outflow(item.amountFils, lang, copy),
        markable: true,
        verbatim: false,
      };
    }

    case 'shop':
      return {
        ...b,
        kind: 'shop',
        title: copy.txKind.shop,
        lines: shopLines(item, ctx),
        amount: outflow(item.amountFils, lang, copy),
        markable: true,
        verbatim: false,
      };

    case 'deposit_hold':
      return {
        ...b,
        kind: 'deposit_hold',
        title: copy.bellBookingTitle(ctx.salon),
        lines: [
          copy.bellBookingWith(item.serviceName, item.artistName),
          copy.bellBookingAt(dayLabel(item.startsAt, lang), timeLabel(item.startsAt, lang)),
        ],
        // A zero-deposit booking moved nothing — no figure, not "−0.000".
        amount: item.amountFils > 0 ? outflow(item.amountFils, lang, copy) : null,
        markable: true,
        verbatim: false,
      };

    case 'deposit_return': {
      const noShow = item.reason === 'no_show';
      const known = item.serviceName !== null && item.startsAt !== null;
      const lines = noShow
        ? [
            known
              ? copy.bellNoShowBody(item.serviceName!, dayLabel(item.startsAt!, lang))
              : copy.bellNoShowBare,
          ]
        : [
            ...(known ? [`${item.serviceName!} · ${dayLabel(item.startsAt!, lang)}`] : []),
            copy.bellCancelledReturn,
          ];
      return {
        ...b,
        kind: 'deposit_return',
        title: noShow ? copy.bellNoShowTitle(ctx.salon) : copy.txKind.deposit_return,
        lines,
        amount: inflow(item.amountFils, lang, copy),
        markable: true,
        verbatim: false,
      };
    }

    case 'campaign':
      return {
        ...b,
        kind: 'campaign',
        // VERBATIM. The merchant's words, in whatever language she wrote them.
        title: item.title,
        lines: item.body === '' ? [] : [item.body],
        amount: null,
        markable: true,
        verbatim: true,
      };

    default:
      return {
        ...b,
        kind: 'unknown',
        title: copy.bellUnknownTitle,
        lines: [copy.bellUnknownBody],
        amount: null,
        // See `BellRow.markable`.
        markable: false,
        verbatim: false,
      };
  }
}

// ------------------------------------------------------ the two receipts --

type TopupItem = Extract<KnownBellItem, { kind: 'topup' }>;
type ShopItem = Extract<KnownBellItem, { kind: 'shop' }>;

function isPair(topup: TopupItem, shop: ShopItem): boolean {
  return (
    topup.method !== 'wallet' &&
    topup.createdAt === shop.createdAt &&
    topup.amountFils === shop.amountFils
  );
}

/**
 * The page's rows, with each card-paid order's two receipts folded into one.
 * See the header, limit 2, for the rule and why it is safe.
 */
export function bellRows(items: readonly BellItem[], ctx: BellContext): BellRow[] {
  const { lang, copy } = ctx;
  const used = new Set<number>();
  const rows: BellRow[] = [];

  items.forEach((item, i) => {
    if (used.has(i)) return;

    if (item.kind === 'topup' || item.kind === 'shop') {
      const j = items.findIndex((other, k) => {
        if (k === i || used.has(k)) return false;
        if (item.kind === 'topup' && other.kind === 'shop') return isPair(item, other);
        if (item.kind === 'shop' && other.kind === 'topup') return isPair(other, item);
        return false;
      });
      if (j !== -1) {
        used.add(i);
        used.add(j);
        const other = items[j]!;
        const topup = (item.kind === 'topup' ? item : other) as TopupItem;
        const shop = (item.kind === 'shop' ? item : other) as ShopItem;
        const method = copy.txMethod[topup.method];
        rows.push({
          // The SHOP id leads: it is the order, and the order is what she did.
          key: shop.id,
          ids: [shop.id, topup.id],
          kind: 'card_order',
          title: `${copy.txKind.shop} · ${method}`,
          lines: [
            ...shopLines(shop, ctx),
            copy.bellCardOrder(method),
            ...(topup.bonusFils > 0
              ? [copy.bellCardOrderBonus(formatMoney(fils(topup.bonusFils), lang))]
              : []),
          ],
          // UNSIGNED: the card paid. Her balance did not fall by this.
          amount: unsigned(shop.amountFils, lang),
          when: dayAndTime(new Date(shop.createdAt), lang, copy, ctx.now),
          // Unread if EITHER half is — a half-read pair is news she has not had.
          unread: shop.readAt === null || topup.readAt === null,
          markable: true,
          verbatim: false,
        });
        return;
      }
    }

    used.add(i);
    rows.push(bellRow(item, ctx));
  });

  return rows;
}

/**
 * The ids to send in `{ ids }` on open — the drawn rows, unread, markable.
 *
 * NEVER `{ all: true }`. Only the ids of rows the panel actually drew: the
 * badge counts her whole visible set, and page two of a day-one history is not
 * something she has seen because she opened page one.
 */
export function idsToMark(rows: readonly BellRow[]): string[] {
  return rows.filter((r) => r.unread && r.markable).flatMap((r) => r.ids);
}

/** Whether the "offers are off" note is owed — `campaign` is not visible. */
export function campaignsHidden(visibleKinds: readonly string[]): boolean {
  return !visibleKinds.includes('campaign');
}
