/**
 * Availability — "business hours minus Google busy minus existing bookings",
 * api-contract.md § Availability, build-plan.md phase 6.
 *
 * UNAVAILABLE SLOTS ARE RETURNED AND MARKED, NOT OMITTED
 * -----------------------------------------------------
 * The contract says it — "the UI strikes through unavailable slots rather than
 * hiding them" — and it is the single most important thing in this file, because
 * omission is the easier implementation and it is wrong in a way the customer
 * feels. A 16:45 that is simply missing from the list reads as a salon that does
 * not work at 16:45. A 16:45 with a line through it reads as a slot somebody
 * else took, which is the truth, and it is the difference between a customer
 * picking 17:15 and a customer closing the app.
 *
 * So every slot the grid generates is emitted, with `available` and, when false,
 * a `reason`. The reason set is the contract's — `busy` (the artist's calendar)
 * and `booked` (an AVO booking) — plus `closed`, which the contract also names.
 * A slot earlier today is reported as `closed`; see the note at `reasonFor`.
 *
 * THE GRID IS THE INTERSECTION OF THREE THINGS, IN THIS ORDER
 * ----------------------------------------------------------
 *   1. the SALON's trading spans for that weekday — two of them, morning and
 *      evening, because the Kuwaiti afternoon closure is real and a naive
 *      `morning[0] → evening[1]` offers a 14:00 at a salon whose door is locked
 *   2. the ARTIST's window for that weekday, or the salon's own hours when her
 *      window cannot be trusted — see `resolveWorkingWindow`
 *   3. slots of `artist.slotMinutes`, none of which may run past the close
 *
 * and then bookings and busy blocks are SUBTRACTED by marking, not by removal.
 *
 * WHY A GOOGLE-SOURCED ARTIST WITH NO CONNECTION FALLS BACK TO SALON HOURS
 * -----------------------------------------------------------------------
 * `artist.availability_source = 'google'` means "these windows are a copy of what
 * her calendar said". When the calendar cannot be read — no connection row, a
 * revoked token, or a driver with no credentials — that copy is of unknown age.
 * Offering it as though it had been checked is the one failure a booking system
 * must not have: it books an artist into a slot her real calendar already holds,
 * and the salon finds out at the door.
 *
 * The salon's own hours are the honest floor. They are not her hours — she may
 * work fewer — so the fallback OVER-offers rather than under-offers, and that is
 * a deliberate choice between two wrong answers: an over-offer is a booking the
 * salon can move, an under-offer is revenue that silently never happened. What
 * makes it defensible is that it is never silent. `raiseMerchantNotification`
 * puts it in the bell, deduplicated, every time it happens.
 */

import { and, eq, gte, inArray, lt } from 'drizzle-orm';
import type { Db } from '../db/client';
import { artist as artistTable, type ArtistWindows } from '../db/schema/artist';
import { artistCalendarConnection, booking } from '../db/schema/booking';
import { salon as salonTable } from '../db/schema/salon';
import { calendar } from '../calendar';
import { notFound } from '../http/errors';
import {
  hhmmToMinutes,
  minutesToHhmm,
  wallClockInstant,
  weekdayOf,
  type CalendarDate,
} from '../time/zone';
import { raiseMerchantNotification, resolveMerchantNotification } from './notifications';
import type { Executor } from './audit';

/** A closed interval of salon-local minutes, half-open at the end. */
export interface Span {
  from: number;
  to: number;
}

/** a ∩ b, or null when they do not overlap. */
export function intersect(a: Span, b: Span): Span | null {
  const from = Math.max(a.from, b.from);
  const to = Math.min(a.to, b.to);
  return to > from ? { from, to } : null;
}

/**
 * The salon's trading spans for one weekday.
 *
 * TWO of them, not one. `BusinessHoursSchema` is
 * `{ morning: ["10:00","13:00"], evening: ["16:00","21:00"] }` and the afternoon
 * closure between them is the Kuwaiti shape rather than an edge case.
 */
export function tradingSpans(hours: {
  morning: [string, string];
  evening: [string, string];
}): Span[] {
  const spans: Span[] = [];
  for (const [from, to] of [hours.morning, hours.evening]) {
    const span = { from: hhmmToMinutes(from), to: hhmmToMinutes(to) };
    if (span.to > span.from) spans.push(span);
  }
  return spans;
}

/** The contract's reason set. `api-contract.md` § Availability. */
export type UnavailableReason = 'busy' | 'booked' | 'closed';

export interface AvailabilitySlot {
  startsAt: string;
  endsAt: string;
  /** "16:45" in the salon's zone. Rendered as-is — never reformatted client-side. */
  local: string;
  available: boolean;
  /** Present only when `available` is false. */
  reason?: UnavailableReason;
}

export interface SubtractedBlock {
  from: string;
  to: string;
  reason: 'busy' | 'booked';
  /** The booking this came from, when it was one. Merchant-side detail. */
  bookingId?: string;
}

export interface AvailabilityResult {
  artistId: string;
  date: string;
  timezone: string;
  slotMinutes: number;
  open: boolean;
  slots: AvailabilitySlot[];
  /**
   * What was removed from the open grid, as intervals. Reported rather than left
   * to be inferred from a suspiciously full day — the same reasoning the empty
   * list carried before bookings existed.
   */
  subtracted: SubtractedBlock[];
  /**
   * WHERE THE HOURS CAME FROM. Not decoration: `salon_hours` means this artist's
   * own window was not trusted, and a merchant looking at a strangely wide day
   * needs the grid itself to say so rather than having to correlate it with a
   * notification.
   */
  hoursSource: 'artist_windows' | 'salon_hours';
  /** Null unless `hoursSource` is `salon_hours`. Names why. */
  fallbackReason: 'calendar_not_connected' | 'calendar_unavailable' | null;
}

interface WorkingWindow {
  span: Span | null;
  hoursSource: 'artist_windows' | 'salon_hours';
  fallbackReason: 'calendar_not_connected' | 'calendar_unavailable' | null;
  /** The live connection, when there is one. Null means no busy source. */
  connection: { externalCalendarId: string | null; credentialRef: string | null } | null;
}

/**
 * Whose hours are we offering, and can we read her calendar?
 *
 * Three cases, and only the middle one is new:
 *
 *   manual                         her windows. No busy source, and none is
 *                                  expected — nothing is missing.
 *   google, connection live        her windows, which the sync wrote, PLUS her
 *                                  calendar's busy blocks subtracted.
 *   google, connection absent      the SALON's hours, and a notification.
 *
 * "Connection live" needs both halves: a row in `artist_calendar_connection`
 * with `status = 'connected'`, AND a driver that can actually reach a calendar.
 * A stub driver with a connection row would report an artist free because it has
 * never read anything, which is the failure this whole function exists to avoid.
 */
async function resolveWorkingWindow(
  db: Db,
  a: typeof artistTable.$inferSelect,
  s: typeof salonTable.$inferSelect,
  weekday: number,
  trading: Span[],
): Promise<WorkingWindow> {
  const windows: ArtistWindows = a.windows ?? {};
  const own = windows[String(weekday)];
  const ownSpan =
    own?.open === true ? { from: hhmmToMinutes(own.from), to: hhmmToMinutes(own.to) } : null;

  if (a.availabilitySource !== 'google') {
    return { span: ownSpan, hoursSource: 'artist_windows', fallbackReason: null, connection: null };
  }

  const [conn] = await db
    .select()
    .from(artistCalendarConnection)
    .where(
      and(
        eq(artistCalendarConnection.artistId, a.id),
        eq(artistCalendarConnection.status, 'connected'),
      ),
    )
    .limit(1);

  if (conn && calendar.configured) {
    /**
     * The connection is live, so any earlier disconnect notification is stale.
     * Clearing it here rather than only at connect time means a calendar that
     * recovers on its own — a token refreshed out of band — also clears the bell.
     */
    await resolveMerchantNotification(db, {
      salonId: a.salonId,
      kind: 'calendar_disconnected',
      subjectType: 'artist',
      subjectId: a.id,
    });
    return {
      span: ownSpan,
      hoursSource: 'artist_windows',
      fallbackReason: null,
      connection: {
        externalCalendarId: conn.externalCalendarId,
        credentialRef: conn.credentialRef,
      },
    };
  }

  /**
   * THE FALLBACK, and the notification that keeps it honest.
   *
   * `calendar_not_connected` — the artist is marked google-sourced and has no
   * connection row at all. `calendar_unavailable` — she has one, and the driver
   * cannot use it, which today means the deployment has no Google credentials.
   * Two different sentences for the merchant, because the fix is different: one
   * is "connect her calendar", the other is "AVO has not finished the
   * integration".
   */
  const fallbackReason = conn ? 'calendar_unavailable' : 'calendar_not_connected';

  await raiseMerchantNotification(db, {
    salonId: a.salonId,
    kind: 'calendar_disconnected',
    severity: 'warning',
    title: `${a.name}'s calendar is not connected`,
    body:
      conn
        ? `${a.name}'s hours are set to sync from Google, and AVO cannot reach that calendar. ` +
          'She is being offered on the salon\'s own hours until it is reconnected, so a slot ' +
          'her calendar already holds can still be booked.'
        : `${a.name}'s hours are set to sync from Google, but no calendar is connected. ` +
          'She is being offered on the salon\'s own hours. Connect her calendar, or switch ' +
          'her to Manual hours and set her week on the Team screen.',
    subjectType: 'artist',
    subjectId: a.id,
    deepLink: `/merchant/team/${a.id}`,
    metadata: { artistId: a.id, availabilitySource: a.availabilitySource, fallbackReason },
  });

  /**
   * The salon's hours as one span covering every trading span of the day. The
   * intersection below re-splits it around the afternoon closure, so this is not
   * an "open all day" claim — it is "no narrower rule available".
   */
  const salonSpan =
    trading.length > 0
      ? { from: Math.min(...trading.map((t) => t.from)), to: Math.max(...trading.map((t) => t.to)) }
      : null;

  return { span: salonSpan, hoursSource: 'salon_hours', fallbackReason, connection: null };
}

/** Local-minute span of a booking on the requested date, or null if it is elsewhere. */
function spanOfInstant(
  startsAt: Date,
  endsAt: Date,
  dayStart: Date,
  dayEnd: Date,
): Span | null {
  if (endsAt <= dayStart || startsAt >= dayEnd) return null;
  const from = Math.round((Math.max(startsAt.getTime(), dayStart.getTime()) - dayStart.getTime()) / 60_000);
  const to = Math.round((Math.min(endsAt.getTime(), dayEnd.getTime()) - dayStart.getTime()) / 60_000);
  return to > from ? { from, to } : null;
}

export interface AvailabilityOptions {
  /** Injected so a caller inside a money transaction evaluates one instant. */
  now?: Date;
}

export async function computeAvailability(
  db: Db,
  artistId: string,
  salonId: string,
  date: CalendarDate,
  dateString: string,
  options: AvailabilityOptions = {},
): Promise<AvailabilityResult> {
  const [a] = await db.select().from(artistTable).where(eq(artistTable.id, artistId)).limit(1);
  // Answered as a 404 rather than a 403 for the reason routes/staff.ts gives:
  // another salon's roster is not something this caller gets to probe.
  if (!a || a.salonId !== salonId) throw notFound('unknown_artist', 'No such artist.');

  const [s] = await db.select().from(salonTable).where(eq(salonTable.id, a.salonId)).limit(1);
  if (!s) throw notFound('unknown_salon', 'No such salon.');

  const now = options.now ?? new Date();
  const weekday = weekdayOf(date);
  const trading = tradingSpans(s.businessHours);

  const working = await resolveWorkingWindow(db, a, s, weekday, trading);
  const open = a.active && working.span !== null && trading.length > 0;

  const base: AvailabilityResult = {
    artistId: a.id,
    date: dateString,
    timezone: s.timezone,
    slotMinutes: a.slotMinutes,
    open,
    slots: [],
    subtracted: [],
    hoursSource: working.hoursSource,
    fallbackReason: working.fallbackReason,
  };

  if (!open || !working.span) return base;

  // Salon-local midnight, as a real instant, and the next one. Everything below
  // measures minutes from `dayStart`, which is what makes a DST day 1380 or 1500
  // minutes long without any arithmetic here knowing that.
  const dayStart = wallClockInstant(date, 0, s.timezone);
  const dayEnd = wallClockInstant(date, 24 * 60, s.timezone);

  // ------------------------------------------------------- existing bookings --
  /**
   * `deposit_held` and `completed` only. A cancelled or no-show booking has
   * released its slot — the deposit went back to the customer's wallet and the
   * chair is free — which is exactly what the exclusion constraint's predicate
   * says, and the two must agree or the grid will offer a slot the insert then
   * refuses.
   */
  const bookings = await db
    .select({
      id: booking.id,
      startsAt: booking.startsAt,
      endsAt: booking.endsAt,
    })
    .from(booking)
    .where(
      and(
        eq(booking.artistId, a.id),
        inArray(booking.status, ['deposit_held', 'completed']),
        lt(booking.startsAt, dayEnd),
        gte(booking.endsAt, dayStart),
      ),
    );

  const takenSpans: Array<Span & { bookingId: string }> = [];
  for (const b of bookings) {
    const span = spanOfInstant(b.startsAt, b.endsAt, dayStart, dayEnd);
    if (span) takenSpans.push({ ...span, bookingId: b.id });
  }

  // ----------------------------------------------------------- calendar busy --
  /**
   * Read through the driver, never directly. The stub returns [] — see
   * src/calendar/stub.ts for why that is empty rather than an error — and a
   * provider failure is caught rather than allowed to take down a customer's
   * slot list. Losing the busy overlay degrades the grid; throwing removes it.
   */
  const busySpans: Span[] = [];
  if (working.connection && calendar.configured) {
    try {
      const blocks = await calendar.listBusy(
        {
          artistId: a.id,
          externalCalendarId: working.connection.externalCalendarId,
          credentialRef: working.connection.credentialRef,
        },
        dayStart,
        dayEnd,
      );
      for (const block of blocks) {
        const span = spanOfInstant(block.startsAt, block.endsAt, dayStart, dayEnd);
        if (span) busySpans.push(span);
      }
    } catch {
      // Deliberately swallowed, and deliberately not silent: the merchant is
      // told through the connection row's `last_error` by the sync job that owns
      // it. A customer reading availability is not the right place to surface a
      // third party's outage, and a 500 here would close the booking flow.
    }
  }

  for (const t of takenSpans) {
    base.subtracted.push({
      from: minutesToHhmm(t.from),
      to: minutesToHhmm(t.to),
      reason: 'booked',
      bookingId: t.bookingId,
    });
  }
  for (const b of busySpans) {
    base.subtracted.push({ from: minutesToHhmm(b.from), to: minutesToHhmm(b.to), reason: 'busy' });
  }

  // ------------------------------------------------------------ the grid ------
  const overlaps = (slot: Span, other: Span) => slot.from < other.to && other.from < slot.to;

  for (const tradingSpan of trading) {
    const span = intersect(working.span, tradingSpan);
    if (!span) continue;
    // `+ slotMinutes <= span.to` — a slot that would run past closing is not
    // offered. Half a haircut is not availability.
    for (let m = span.from; m + a.slotMinutes <= span.to; m += a.slotMinutes) {
      const slot = { from: m, to: m + a.slotMinutes };
      const startsAt = wallClockInstant(date, m, s.timezone);
      const endsAt = wallClockInstant(date, m + a.slotMinutes, s.timezone);

      /**
       * ORDER MATTERS, and it is the order of usefulness to the customer.
       * `booked` first because it is the one she can act on — pick another time.
       * `busy` next. `closed` last, for a slot whose moment has passed.
       *
       * A PAST SLOT IS REPORTED AS `closed`, which is the contract's word and
       * not quite the right one: the salon is open, the slot is simply gone. A
       * fourth reason (`past`) reads better and is a contract change, so it is
       * reported rather than invented — a client switching on the enum would
       * meet a value it has never seen.
       */
      let reason: UnavailableReason | undefined;
      if (takenSpans.some((t) => overlaps(slot, t))) reason = 'booked';
      else if (busySpans.some((b) => overlaps(slot, b))) reason = 'busy';
      else if (startsAt <= now) reason = 'closed';

      base.slots.push({
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
        local: minutesToHhmm(m),
        available: reason === undefined,
        ...(reason ? { reason } : {}),
      });
    }
  }

  return base;
}

/**
 * Is this exact instant a bookable slot for this artist?
 *
 * `POST /bookings` calls this rather than trusting `startsAt` from the body. A
 * client that can name its own start time can book at 03:00, book a 15-minute
 * sliver inside a 45-minute grid, or book a slot that is already taken and rely
 * on the exclusion constraint to catch it — and the last of those turns a
 * validation error into a database error with the wrong message on it.
 *
 * Returns the matched slot so the caller uses the SERVER's `endsAt` rather than
 * deriving its own.
 */
export function findSlot(
  availability: AvailabilityResult,
  startsAtIso: string,
): AvailabilitySlot | null {
  const wanted = new Date(startsAtIso).getTime();
  return (
    availability.slots.find((slot) => new Date(slot.startsAt).getTime() === wanted) ?? null
  );
}

/** Re-exported so routes/artists.ts keeps its one import. */
export type { Executor };
