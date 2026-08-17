/**
 * The artist calendar seam — Google, behind an interface, with a stub driver.
 *
 * WHY THIS IS AN INTERFACE AND NOT AN INTEGRATION
 * ----------------------------------------------
 * build-plan.md phase 6 wants "Google Calendar read-only connect, write-back of
 * new AVO bookings". OAuth against Google needs a real project: a client id, a
 * client secret, a verified consent screen, and redirect URIs registered against
 * AVO's own domains. Every one of those is the CLIENT's to create — they are
 * issued to a legal entity, they carry a consent screen with AVO's name and
 * privacy policy on it, and a developer's personal project would put a salon's
 * artists' calendars behind an account nobody at AVO controls.
 *
 * So this follows the precedent src/gateway/ set for the PSP: the seam is real,
 * the driver is a stub, and the switch is one environment variable plus one
 * adapter file. Nothing in routes/ or services/ has ever seen a Google field
 * name, so adding the real driver changes nothing above this directory.
 *
 * WHAT THE STUB IS AND IS NOT
 * ---------------------------
 * It is NOT a fake that pretends to work. `beginConnect` throws
 * `CalendarNotConfiguredError`, so `POST /artists/{id}/calendar/connect` answers
 * a 503 that names what is missing rather than a redirect to nowhere. That is
 * the same reasoning env.ts gives for refusing `GATEWAY_DRIVER=sandbox` in
 * production: a payment seam that settles money nobody paid is worse than one
 * that is honestly absent. A calendar seam that reports an artist as free when it
 * has never read her calendar is the booking form of the same lie.
 *
 * `listBusy` returns an EMPTY LIST rather than throwing, and the difference is
 * deliberate. Availability is a read that must keep working — a salon whose
 * calendar integration is unconfigured still has to be bookable on its own
 * hours — so the busy source degrades to "nothing known" and the caller is told
 * so through `configured`, which is what raises the merchant notification and
 * falls back to salon hours. See services/availability.ts.
 */

/** A block of time the artist is not free, as read from her calendar. */
export interface CalendarBusyBlock {
  startsAt: Date;
  endsAt: Date;
  /** Free-text, for the merchant's eyes only. Never shown to a customer. */
  summary?: string | null;
}

/** The stored connection, as a driver needs to see it. Never a raw token. */
export interface CalendarConnectionRef {
  artistId: string;
  externalCalendarId: string | null;
  /** A pointer into the secret store. The driver resolves it; this layer never does. */
  credentialRef: string | null;
}

export interface CalendarEventDraft {
  bookingId: string;
  summary: string;
  startsAt: Date;
  endsAt: Date;
  /** IANA zone. The event is written in the salon's clock, not the server's. */
  timezone: string;
  notes?: string | null;
}

export interface CalendarProvider {
  readonly id: string;
  /**
   * Can this driver actually reach a calendar?
   *
   * Read by services/availability.ts to decide between "her Google hours" and
   * the documented fallback. A driver that answered `true` without credentials
   * would make an artist look free at times she is booked, which is the one
   * failure a booking system must not have.
   */
  readonly configured: boolean;

  /** Step one of OAuth: where to send the browser. Throws when unconfigured. */
  beginConnect(params: {
    salonId: string;
    artistId: string;
    redirectUri: string;
  }): Promise<{ authorizeUrl: string; state: string }>;

  /** Step two: exchange the code. Returns what the connection row stores. */
  completeConnect(params: { code: string; state: string }): Promise<{
    accountEmail: string | null;
    externalCalendarId: string | null;
    credentialRef: string;
  }>;

  /** Read-only busy blocks. Returns [] when unconfigured — see the header. */
  listBusy(
    connection: CalendarConnectionRef,
    from: Date,
    to: Date,
  ): Promise<CalendarBusyBlock[]>;

  /** Write-back of a new AVO booking. Throws when unconfigured. */
  createEvent(
    connection: CalendarConnectionRef,
    draft: CalendarEventDraft,
  ): Promise<{ eventId: string }>;

  /** Cancel or reschedule removes the event it wrote. Throws when unconfigured. */
  deleteEvent(connection: CalendarConnectionRef, eventId: string): Promise<void>;
}

/**
 * The driver cannot do this because nobody has given it credentials.
 *
 * Distinct from a provider error on purpose: this is a deployment fact, answered
 * as a 503 with a sentence naming what the client has to supply, and it must
 * never be retried into a queue as though Google were merely down.
 */
export class CalendarNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CalendarNotConfiguredError';
  }
}

/** The provider answered, and said no. Transient; a write-back may retry. */
export class CalendarProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CalendarProviderError';
  }
}
