import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { parseFils, type Fils } from '@avo/types';
import { authedRequest } from '../auth/authedRequest.js';
import { useSalonId } from '../auth/AuthProvider.js';
import { branchQuery } from './salon.js';

/**
 * DEPOSIT HEALTH. `GET /salons/{id}/deposits`, `perms.appointments`.
 *
 * The client's last numbered item, verbatim: *"what if they dont have enough
 * payment (sometimes they dont have money but lock the booking and they dont
 * come) deposit health option for merchants"*.
 *
 * `api/src/services/depositHealth.ts` is the specification and this file does not
 * restate it. What the CLIENT half owes, and what is written down here:
 *
 * =========================================================================
 * REGISTERED BARE, NOT UNDER `/v1`
 * =========================================================================
 * `api/src/app.ts` calls `registerDepositRoutes(app)` with no prefix, so the path
 * is `/salons/{id}/deposits` and not `/v1/salons/{id}/deposits`. This codebase
 * genuinely has both conventions — `GET /v1/salons/{id}/orders` in `api/orders.ts`
 * against `GET /salons/{id}/bookings` in `api/bookings.ts` — so the prefix is
 * READ OFF THE REGISTRATION rather than inferred from the neighbours, and
 * `merchantScopeGates.test.ts` matches this call site against the route's own
 * registered path, which is what would catch a `/v1` added here by pattern-match.
 *
 * =========================================================================
 * `?branch=` THROUGH `branchQuery`, AND NO `?period=`
 * =========================================================================
 * Same vocabulary as Overview and Reports — `'all'` or a branch id, `'all'`
 * meaning the parameter is omitted entirely. `branchQuery` is `api/salon.ts`'s,
 * reused rather than re-spelled, so the three surfaces cannot disagree about what
 * the unfiltered request looks like.
 *
 * There is NO period control on this screen and this hook offers none. Every
 * figure the endpoint serves is a STOCK — "how much of my customers' money is
 * held right now", "how long has that deposit been owed" — and the route header
 * makes the point that a window has nothing to select here. A date range drawn
 * over these tiles would label a figure with a bound it does not have.
 *
 * =========================================================================
 * PARSED, NOT CAST — AND A MALFORMED BODY IS A FAILED READ
 * =========================================================================
 * There is no schema for this response in `packages/types` and Lane C does not
 * widen `packages/types`, so this is the local hand-rolled parser in the shape
 * `api/customers.ts § parseCustomerDetail` and
 * `api/settings.ts § parseBranchClosurePreview` settled on: small helpers, a
 * `where` string per field so a failure names the endpoint AND the key, and a
 * throw rather than a default.
 *
 * THE THROW IS THE WHOLE POINT ON THIS SCREEN. TanStack turns a thrown `queryFn`
 * into `isError`, which `SectionError` renders as "Couldn't load deposit health"
 * — and the alternative, a tolerant parse that coerced a missing `held.fils` to
 * zero, would paint `0.000 KD` under "Held right now" on a salon holding two
 * thousand dinars of its customers' money. A deposit screen that renders a zero
 * it could not read is the exact lie class this lane has spent four slices
 * removing; here it would be a lie about money, which is worse than the receipt
 * body and the branch preview that taught it.
 *
 * =========================================================================
 * MONEY IS `parseFils`, NOT `int`
 * =========================================================================
 * Non-negotiable #1, and the split mirrors the server's: `count` is a
 * non-negative integer check, money goes through `parseFils`, which REFUSES a
 * float rather than truncating it. The server's `filsFrom` refuses for the
 * identical reason — truncating would swallow the one signal that a float had
 * reached a money column. Two funnels on each side of the wire, and the money
 * one refuses on both.
 *
 * =========================================================================
 * `unclosed` HAS NO `fils` KEY AND THIS PARSER DOES NOT INVENT ONE
 * =========================================================================
 * `booking_deposit_matches_hold` makes "no hold" and "zero deposit" the same
 * fact, so the sum over that set is 0 for every row for ever, and the API
 * deliberately declines to serve a money figure whose only possible use is to
 * mislead. The type below therefore has no `fils` on `unclosed`, so a component
 * that tries to draw one does not compile. That is a stronger guarantee than a
 * comment asking nobody to, and it is why the shape is not flattened into a
 * common `{ bookings, fils }` for symmetry.
 */

/* ------------------------------------------------------------------ shapes -- */

/** Which of the three an overdue booking is in. `services/depositHealth.ts`. */
export type DepositState = 'awaiting_arrival' | 'return_overdue' | 'unclosed';

export const DEPOSIT_STATES: readonly DepositState[] = [
  'awaiting_arrival',
  'return_overdue',
  'unclosed',
];

export interface DepositRow {
  bookingId: string;
  state: DepositState;
  /**
   * EXACTLY ONE OF `memberId` AND `guestName` IS NON-NULL —
   * `booking_identity_exactly_one`. Both keys are present on every row rather
   * than omitted, so there is one shape rather than two.
   */
  memberId: string | null;
  memberName: string | null;
  /** Non-null `erased_at` on the server. The only tell, and this client's to act on. */
  memberErased: boolean;
  /** Null for an erased member. NEVER the `+990` tombstone — DECISIONS #100. */
  memberPhone: string | null;
  guestName: string | null;
  guestPhone: string | null;
  artistId: string;
  artistName: string;
  serviceName: string;
  branchId: string;
  branchName: string;
  /** Whether this row's branch was RECORDED or inferred. */
  branchAssumed: boolean;
  startsAt: string;
  endsAt: string;
  durationMin: number;
  /** INTEGER FILS. Zero on every walk-in, by constraint — not by filter. */
  depositFils: Fils;
  noShowReturnDueAt: string;
  source: string;
  /** Whole minutes since `starts_at`, floored by the server. A number, not a sentence. */
  overdueMinutes: number;
  /**
   * Minutes since the deposit was DUE BACK, and null unless `state` is
   * `return_overdue`. A zero on the other two would read as "due back this
   * instant", which is a different and false claim — so the null is meaningful
   * and this parser keeps it rather than defaulting.
   */
  returnOverdueMinutes: number | null;
}

export interface DepositHealth {
  /** The instant every figure below was computed against. */
  asOf: string;
  /** Every `deposit_held` booking in scope, whenever its slot is. */
  held: {
    bookings: number;
    fils: Fils;
    /** Null at `branch=all` — a salon-wide total is exact however many rows are assumed. */
    branchAssumed: number | null;
  };
  /** Held, slot NOT yet started. NOT `upcoming`: this has no day bound at all. */
  scheduled: { bookings: number; fils: Fils };
  /** Held, slot already started. The set the Overview tile excludes on purpose. */
  overdue: {
    bookings: number;
    fils: Fils;
    oldestStartedAt: string | null;
    branchAssumed: number | null;
    /** Her slot started, the salon's own grace window has not run out. */
    awaitingArrival: { bookings: number; fils: Fils };
    /** AVO owes this money back and has not returned it. About us, not about her. */
    returnOverdue: { bookings: number; fils: Fils; dueSince: string | null };
    /** Past the deadline with no money behind it. NO `fils` — see the header. */
    unclosed: { bookings: number; oldestStartedAt: string | null };
  };
  /** The overdue rows, oldest slot first, capped at 200 by the server. */
  rows: DepositRow[];
  /** True when the cap hid rows. `overdue.bookings` is always the true size. */
  rowsTruncated: boolean;
  branchId: string | null;
  branchName: string | null;
}

/* ----------------------------------------------------------------- parsing -- */

/*
 * Local, in the shape `api/customers.ts` and `api/settings.ts` both keep. The
 * `where` strings are what make a parse failure name the endpoint AND the field
 * that produced it, which is the difference between "the deposits screen broke"
 * and "the server sent `overdue.returnOverdue.dueSince` as a number".
 */
function obj(v: unknown, where: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new Error(`${where} was not an object.`);
  }
  return v as Record<string, unknown>;
}

function str(v: unknown, where: string): string {
  if (typeof v !== 'string') throw new Error(`${where} was not a string.`);
  return v;
}

function nullableStr(v: unknown, where: string): string | null {
  if (v === null) return null;
  if (typeof v !== 'string') throw new Error(`${where} was neither a string nor null.`);
  return v;
}

function bool(v: unknown, where: string): boolean {
  if (typeof v !== 'boolean') throw new Error(`${where} was not a boolean.`);
  return v;
}

/** A non-negative integer count. `2.5 bookings` is a broken server, not a rounding. */
function count(v: unknown, where: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
    throw new Error(`${where} was not a non-negative integer.`);
  }
  return v;
}

function nullableCount(v: unknown, where: string): number | null {
  return v === null ? null : count(v, where);
}

/**
 * MONEY, AND IT REFUSES RATHER THAN COERCES. `parseFils` rejects a string, a
 * float and a null — all three of which a tolerant parser would happily turn
 * into a number this screen then prints as a KD figure. Non-negotiable #1.
 */
function money(v: unknown, where: string): Fils {
  try {
    return parseFils(v);
  } catch (cause) {
    throw new Error(`${where} was not an integer number of fils.`, { cause });
  }
}

/** `{ bookings, fils }` — the shape three of the five buckets share. */
function bucket(v: unknown, where: string): { bookings: number; fils: Fils } {
  const b = obj(v, where);
  return {
    bookings: count(b.bookings, `${where}.bookings`),
    fils: money(b.fils, `${where}.fils`),
  };
}

/**
 * THE STATE IS NARROWED TO THE THREE, AND THAT IS A DEPARTURE FROM THE HOUSE
 * RULE FOR ENUM-ISH STRINGS — SO IT IS ARGUED RATHER THAN ASSUMED.
 *
 * `api/customers.ts § tier` deliberately does NOT narrow: an unrecognised tier is
 * printed raw, because "a parse that threw on a fifth tier would take the whole
 * book down over a label". That is right when the string is a LABEL.
 *
 * This one is not a label. The whole feature is that the three states get three
 * different framings, and a row whose state this client does not recognise has no
 * framing to render — it would fall through to whichever arm is last and be
 * described with somebody else's sentence. A `return_overdue` row drawn under the
 * `awaiting_arrival` heading tells a merchant her customer is late when in fact
 * AVO owes that customer money. The state is load-bearing, so an unknown one is a
 * failed read.
 */
function state(v: unknown, where: string): DepositState {
  const s = str(v, where);
  if (!DEPOSIT_STATES.includes(s as DepositState)) {
    throw new Error(`${where} was not one of the three deposit states, but ${s}.`);
  }
  return s as DepositState;
}

export function parseDepositRow(raw: unknown, where: string): DepositRow {
  const r = obj(raw, where);
  return {
    bookingId: str(r.bookingId, `${where}.bookingId`),
    state: state(r.state, `${where}.state`),
    memberId: nullableStr(r.memberId, `${where}.memberId`),
    memberName: nullableStr(r.memberName, `${where}.memberName`),
    memberErased: bool(r.memberErased, `${where}.memberErased`),
    memberPhone: nullableStr(r.memberPhone, `${where}.memberPhone`),
    guestName: nullableStr(r.guestName, `${where}.guestName`),
    guestPhone: nullableStr(r.guestPhone, `${where}.guestPhone`),
    artistId: str(r.artistId, `${where}.artistId`),
    artistName: str(r.artistName, `${where}.artistName`),
    serviceName: str(r.serviceName, `${where}.serviceName`),
    branchId: str(r.branchId, `${where}.branchId`),
    branchName: str(r.branchName, `${where}.branchName`),
    branchAssumed: bool(r.branchAssumed, `${where}.branchAssumed`),
    startsAt: str(r.startsAt, `${where}.startsAt`),
    endsAt: str(r.endsAt, `${where}.endsAt`),
    durationMin: count(r.durationMin, `${where}.durationMin`),
    depositFils: money(r.depositFils, `${where}.depositFils`),
    noShowReturnDueAt: str(r.noShowReturnDueAt, `${where}.noShowReturnDueAt`),
    source: str(r.source, `${where}.source`),
    overdueMinutes: count(r.overdueMinutes, `${where}.overdueMinutes`),
    returnOverdueMinutes:
      r.returnOverdueMinutes === null
        ? null
        : count(r.returnOverdueMinutes, `${where}.returnOverdueMinutes`),
  };
}

/**
 * EVERY KEY THE ENDPOINT DOCUMENTS IS READ HERE, INCLUDING THE ONES NO COMPONENT
 * DRAWS TODAY — `endsAt`, `durationMin`, `artistId`, `source`, `guestPhone`.
 *
 * `api/customers.ts` states the rule and the reason: the next reader of this
 * record should find it whole rather than discover a hole. It is also the only
 * version of a parser that can be MUTATION-TESTED honestly — a spec that renders
 * four of twenty-four keys and asserts on the four cannot tell a whole record
 * from a stub, which is the hollow-spec failure this lane found in a receipt
 * where the first four words satisfied every assertion while 7 of 10 keys went
 * unrendered.
 */
export function parseDepositHealth(raw: unknown): DepositHealth {
  const where = 'GET /salons/{id}/deposits';
  const d = obj(raw, where);
  const overdue = obj(d.overdue, `${where}.overdue`);
  const unclosed = obj(overdue.unclosed, `${where}.overdue.unclosed`);
  const returnOverdue = obj(overdue.returnOverdue, `${where}.overdue.returnOverdue`);

  if (!Array.isArray(d.rows)) throw new Error(`${where}.rows was not an array.`);
  const held = obj(d.held, `${where}.held`);

  return {
    asOf: str(d.asOf, `${where}.asOf`),
    held: {
      bookings: count(held.bookings, `${where}.held.bookings`),
      fils: money(held.fils, `${where}.held.fils`),
      branchAssumed: nullableCount(held.branchAssumed, `${where}.held.branchAssumed`),
    },
    scheduled: bucket(d.scheduled, `${where}.scheduled`),
    overdue: {
      bookings: count(overdue.bookings, `${where}.overdue.bookings`),
      fils: money(overdue.fils, `${where}.overdue.fils`),
      oldestStartedAt: nullableStr(overdue.oldestStartedAt, `${where}.overdue.oldestStartedAt`),
      branchAssumed: nullableCount(overdue.branchAssumed, `${where}.overdue.branchAssumed`),
      awaitingArrival: bucket(overdue.awaitingArrival, `${where}.overdue.awaitingArrival`),
      returnOverdue: {
        ...bucket(returnOverdue, `${where}.overdue.returnOverdue`),
        dueSince: nullableStr(
          returnOverdue.dueSince,
          `${where}.overdue.returnOverdue.dueSince`,
        ),
      },
      /*
       * NO `fils` READ, AND NOT BECAUSE IT MIGHT BE MISSING — because the API
       * does not send one and a client that read `unclosed.fils` would be
       * reserving a slot for a figure whose only possible value is zero.
       */
      unclosed: {
        bookings: count(unclosed.bookings, `${where}.overdue.unclosed.bookings`),
        oldestStartedAt: nullableStr(
          unclosed.oldestStartedAt,
          `${where}.overdue.unclosed.oldestStartedAt`,
        ),
      },
    },
    rows: d.rows.map((row, i) => parseDepositRow(row, `${where}.rows[${i}]`)),
    rowsTruncated: bool(d.rowsTruncated, `${where}.rowsTruncated`),
    branchId: nullableStr(d.branchId, `${where}.branchId`),
    branchName: nullableStr(d.branchName, `${where}.branchName`),
  };
}

/* -------------------------------------------------------------------- keys -- */

export const depositKeys = {
  all: ['deposits'] as const,
  /*
   * THE BRANCH IS IN THE KEY, for `salonKeys.metrics`' reason exactly: pick
   * Salmiya, get the salon-wide figures back out of the cache, and read them
   * under a control that says Salmiya. `'all'` is a key segment like any other.
   */
  health: (salonId: string, branch: string) => [...depositKeys.all, salonId, branch] as const,
};

/* -------------------------------------------------------------------- reads */

/**
 * `enabled` IS THE VIEW GATE. Appointments mounts three views and only one of
 * them reads this; a merchant on the List should not pay for a request she is
 * not looking at. `AppointmentsWeek` is gated the same way from the other side.
 *
 * `networkMode: 'always'`. TanStack's default PAUSES a fetch offline rather than
 * failing it, and a paused query sits at `status: 'pending'` forever — which this
 * screen would paint as skeleton tiles for as long as the network is down,
 * instead of the offline answer `SectionError` exists to give. `api/bookings.ts`
 * and `api/customers.ts` both record the same trap.
 */
export function useDepositHealth(branch: string, enabled = true): UseQueryResult<DepositHealth> {
  const salonId = useSalonId();
  return useQuery({
    enabled,
    queryKey: depositKeys.health(salonId, branch),
    queryFn: async ({ signal }) =>
      parseDepositHealth(
        await authedRequest<unknown>(
          'merchant',
          `/salons/${salonId}/deposits${branchQuery(branch)}`,
          { signal },
        ),
      ),
    networkMode: 'always',
  });
}
