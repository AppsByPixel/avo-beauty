import { clockFrame } from './salonTime.js';
import { localDate } from './salesTrendRules.js';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A LINK TO ONE APPOINTMENT ON THE APPOINTMENTS BOARD
 * ═══════════════════════════════════════════════════════════════════════════
 * The Overview's "Upcoming" list and the customer card's Bookings panel both
 * name a booking the merchant may want to act on, and the actions live on
 * Appointments. The board has no per-booking page, so the link carries two
 * things in the query string and nothing else:
 *
 *   `booking`  the id, which the board uses to mark and scroll to the row.
 *   `day`      the SALON-LOCAL calendar date the booking starts on, which the
 *              board applies as its "Dates" filter so the row is on the page it
 *              opens — the list is `starts_at DESC` in pages of 200, and a
 *              booking three weeks out would otherwise not be on the first.
 *
 * THE DAY IS THE SALON'S, from `localDate` in the salon's zone — `salonTime.ts`
 * has the argument. From Karachi, a Kuwait 23:30 booking is still its own day.
 *
 * NEITHER IS A CONTROL (#7). The board re-validates both: an id that is not on
 * the filtered page highlights nothing, and a malformed day is ignored. No
 * permission is implied by holding the link — the board's read is still
 * `perms.appointments`, and it answers its own 403.
 */
export function appointmentHref(bookingId: string, startsAt: string, timezone: string | null): string {
  const params = new URLSearchParams({ booking: bookingId });
  const at = new Date(startsAt);
  if (!Number.isNaN(at.getTime())) {
    const day = localDate(at, clockFrame(timezone).zone);
    if (day !== null) params.set('day', day);
  }
  return `/appointments?${params.toString()}`;
}

export interface BookingFocus {
  bookingId: string;
  /** `YYYY-MM-DD`, salon-local, or null when the link carried none. */
  day: string | null;
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** The board's half: read the two parameters back, refusing anything malformed. */
export function readBookingFocus(search: string): BookingFocus | null {
  const params = new URLSearchParams(search);
  const bookingId = params.get('booking')?.trim() ?? '';
  if (bookingId === '' || bookingId.length > 100) return null;
  const day = params.get('day');
  return { bookingId, day: day !== null && YMD.test(day) ? day : null };
}
