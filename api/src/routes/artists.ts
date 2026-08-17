/**
 * Artists and their availability windows — api-contract.md § Artist.
 *
 *   GET /salons/{id}/artists          perms.team   (dashboard)
 *   PUT /artists/{id}/availability    perms.team   (dashboard) — on their behalf
 *   PUT /artists/me/availability      authenticated staff (scanner) — her own
 *
 * TWO ROUTES, NOT ONE WITH A BRANCH, AND THAT IS THE PERMISSION MODEL
 * ------------------------------------------------------------------
 * The contract lists both separately — "Staff | Own hours | PUT
 * /artists/me/availability" and "Merchant | Team hours | PUT
 * /artists/{id}/availability" — and keeping them separate is what lets the
 * authority check stay the first statement of each handler.
 *
 * A single `PUT /artists/:id` that decided "is this me?" would have to LOAD the
 * artist before it could know which gate applies, and auth/principal.ts is
 * explicit about why that ordering is wrong: "an endpoint that looks the token
 * up first and only then checks authority has already told an unauthorised
 * caller whether that token exists." Here the same shape would answer a
 * receptionist without `perms.team` a 404 or a 200 depending on which artist id
 * she guessed — a roster oracle.
 *
 * With `me` as its own path the surface is decided by the URL: `/artists/me/…`
 * is self-scoped by construction, so it needs a scanner session and no
 * permission (the same reasoning as `GET /staff/me` — gating "what may I do"
 * on a permission is circular). `/artists/{id}/…` is somebody else's calendar
 * and needs the dashboard plus `perms.team`.
 *
 * WHY `availabilitySource` IS CHECKED SERVER-SIDE
 * ----------------------------------------------
 * "Google connect is one-time and read-only for busy slots." The dashboard draws
 * a Google-sourced artist's week as disabled rows with a Synced pill. That is a
 * UI convention, and non-negotiable #7's whole point is that a UI convention is
 * not a control: a hand-rolled PUT would overwrite windows that the next
 * calendar sync is about to overwrite back, and the merchant would watch hours
 * she typed silently revert with nothing to blame.
 *
 * So a windows edit against a `google` row is refused with a 409 that names the
 * fix, and switching to `manual` is an explicit field in the body. Switch and
 * edit may arrive in ONE request — that is what the segmented control does — and
 * they land in one UPDATE.
 *
 * ===========================================================================
 * THE TIMEZONE FINDING THIS FILE RAISED THREE TIMES IS NOW RESOLVED.
 * ===========================================================================
 * It said: `windows[d].from` / `.to` are naive wall-clock strings — "10:00", no
 * offset, no zone — and so are `salon.business_hours` and the happy-hour
 * `from`/`to`, and nothing in the codebase stored a zone or converted one. It
 * declined to guess, on the grounds that a column added on one lane's judgement
 * reads as settled to the next three.
 *
 * The decision came back, and it is the one the finding argued for: an IANA zone
 * id on the salon, defaulting to `Asia/Kuwait`. Migration 0010. The business
 * question — will AVO sign a salon outside Kuwait — is still the client's; the
 * technical choice never depended on it, because an id is correct either way and
 * only gets expensive after there is production data.
 *
 * So `GET /artists/{id}/availability?date=` below can now exist. It is the
 * endpoint the finding named as the first thing that would break: it has to
 * choose an instant for "10:00 on 2026-08-17", and until 0010 there was no salon
 * field to choose it from, so it would have fallen back to the process zone —
 * UTC under docker-compose — and offered every slot for a Kuwait salon three
 * hours late. Silently: the list still renders, it is just wrong.
 *
 * Every conversion here goes through `api/src/time/zone.ts`, which never reads
 * the process zone. `TZ=America/New_York node …` resolves identically to
 * `TZ=UTC`; src/time/zone.test.ts asserts exactly that, because a test that only
 * runs in one zone cannot tell a correct conversion from an absent one.
 *
 * WHAT IS SUBTRACTED NOW
 * The contract defines availability as "business hours minus Google busy blocks
 * minus existing bookings". Both halves exist: bookings are subtracted for real,
 * and the Google busy overlay is read through the driver seam in src/calendar/,
 * which today is a stub that honestly returns nothing rather than a fake that
 * reports an artist free. The computation moved to services/availability.ts,
 * because `POST /bookings` has to validate a start time against exactly the same
 * grid this endpoint renders — two implementations of "is 16:45 bookable" is
 * two answers, and the one the customer saw is not the one that took her money.
 * ===========================================================================
 */

import { and, asc, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { db } from '../db/client';
import { artist, SLOT_MINUTES, type ArtistWindows } from '../db/schema/artist';
import { artistCalendarConnection } from '../db/schema/booking';
import { calendar, CalendarNotConfiguredError } from '../calendar';
import { env } from '../env';
import {
  requireDashboardPerm,
  requirePrincipal,
  requireScannerScope,
  requireSameSalon,
  type StaffPrincipal,
} from '../auth/principal';
import { badRequest, conflict, notFound, serviceUnavailable } from '../http/errors';
import { writeAudit } from '../services/audit';
import { computeAvailability } from '../services/availability';
import { resolveMerchantNotification } from '../services/notifications';
import { parseDate } from '../time/zone';

/** "10:00", "23:45". 24-hour, zero-padded, no seconds — the contract's "HH:mm". */
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** JS `getDay()` order, 0 = Sunday. All seven, always — see `parseWindows`. */
const DAY_KEYS = ['0', '1', '2', '3', '4', '5', '6'] as const;

const DAY_NAMES: Record<string, string> = {
  '0': 'Sunday',
  '1': 'Monday',
  '2': 'Tuesday',
  '3': 'Wednesday',
  '4': 'Thursday',
  '5': 'Friday',
  '6': 'Saturday',
};

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(':');
  return Number(h) * 60 + Number(m);
}

/** The wire shape — exactly `ArtistSchema` from @avo/types. */
function serialiseArtist(row: typeof artist.$inferSelect) {
  return {
    id: row.id,
    salonId: row.salonId,
    name: row.name,
    nameAr: row.nameAr,
    availabilitySource: row.availabilitySource,
    googleConnected: row.googleConnected,
    slotMinutes: row.slotMinutes,
    windows: row.windows,
    /**
     * Not in `ArtistSchema`, and useful to the dashboard rather than decorative:
     * it is the difference between "this artist can edit her own hours from the
     * scanner" and "only reception can". Never the staff row itself — no perms,
     * no handle, nothing this endpoint's `perms.team` gate does not already
     * cover on `GET /staff`.
     */
    hasOwnLogin: row.staffUserId !== null,
    active: row.active,
  };
}

/**
 * Validate a whole week.
 *
 * ALL SEVEN DAYS, REQUIRED. This is a PUT — a full replacement of the artist's
 * week — and a partial map leaves "what happens on Friday?" answered by whatever
 * was in the column before. That is a merge dressed as a replace, and the two
 * disagree exactly when it matters: a merchant who unticks Friday and saves has
 * sent six keys, and a merge would keep Friday open.
 */
function parseWindows(value: unknown, slotMinutes: number): ArtistWindows {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw badRequest('invalid_windows', 'windows must be an object keyed 0-6, Sunday first.');
  }
  const raw = value as Record<string, unknown>;

  const unknown = Object.keys(raw).filter((k) => !(DAY_KEYS as readonly string[]).includes(k));
  if (unknown.length > 0) {
    throw badRequest(
      'invalid_windows',
      `windows has keys that are not days 0-6: ${unknown.join(', ')}.`,
    );
  }

  const out: ArtistWindows = {};
  for (const key of DAY_KEYS) {
    const day = raw[key];
    if (day === undefined) {
      throw badRequest(
        'invalid_windows',
        `windows is missing ${DAY_NAMES[key]} (key "${key}"). Send all seven days — this replaces the week.`,
      );
    }
    if (typeof day !== 'object' || day === null || Array.isArray(day)) {
      throw badRequest('invalid_windows', `windows.${key} must be { open, from, to }.`);
    }
    const d = day as Record<string, unknown>;

    if (typeof d.open !== 'boolean') {
      throw badRequest('invalid_windows', `windows.${key}.open must be true or false.`);
    }
    if (typeof d.from !== 'string' || !HHMM.test(d.from)) {
      throw badRequest(
        'invalid_windows',
        `windows.${key}.from must be a 24-hour time like "10:00".`,
      );
    }
    if (typeof d.to !== 'string' || !HHMM.test(d.to)) {
      throw badRequest('invalid_windows', `windows.${key}.to must be a 24-hour time like "19:00".`);
    }

    /**
     * Only checked on OPEN days. A closed day keeps whatever from/to the client
     * had in its steppers, which is what the dashboard sends — it disables the
     * row, it does not blank it — and a closed day's times mean nothing.
     */
    if (d.open) {
      const from = minutesOf(d.from);
      const to = minutesOf(d.to);
      if (to <= from) {
        throw badRequest(
          'invalid_windows',
          `${DAY_NAMES[key]} closes at ${d.to}, at or before it opens at ${d.from}.`,
        );
      }
      /**
       * A window shorter than one slot is an open day with nothing bookable in
       * it: `Math.floor(span / slotMinutes)` is 0, so the dashboard's summary
       * would read "1 open day · 0 slots". Refused rather than stored, because
       * the merchant meant something by opening that day.
       */
      if (to - from < slotMinutes) {
        throw badRequest(
          'invalid_windows',
          `${DAY_NAMES[key]} is ${to - from} minutes long, shorter than one ${slotMinutes}-minute slot. Widen the window or shorten the slot.`,
        );
      }
      out[key] = { open: true, from: d.from, to: d.to };
    } else {
      out[key] = { open: false, from: d.from, to: d.to };
    }
  }
  return out;
}

function parseSlotMinutes(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw badRequest('invalid_slot_minutes', 'slotMinutes must be a whole number of minutes.');
  }
  if (!(SLOT_MINUTES as readonly number[]).includes(value)) {
    throw badRequest(
      'invalid_slot_minutes',
      `slotMinutes must be one of ${SLOT_MINUTES.join(', ')}.`,
    );
  }
  return value;
}

const BODY_KEYS = new Set(['availabilitySource', 'slotMinutes', 'windows']);

/**
 * The write, shared by both routes. Everything above it differs (who is allowed,
 * and which artist row); everything from here down is identical, and duplicating
 * it is how the scanner path quietly loses the `google` refusal.
 */
async function applyAvailability(
  target: typeof artist.$inferSelect,
  principal: StaffPrincipal,
  req: FastifyRequest,
  source: 'merchant' | 'scanner',
) {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const keys = Object.keys(body);
  if (keys.length === 0) throw badRequest('invalid_request', 'Nothing to change.');

  const rejected = keys.filter((k) => !BODY_KEYS.has(k));
  if (rejected.length > 0) {
    throw badRequest(
      'not_editable',
      `These fields cannot be set here: ${rejected.join(', ')}. Availability takes availabilitySource, slotMinutes and windows.`,
    );
  }

  // --- the source, resolved before anything is validated against it ---------
  let nextSource = target.availabilitySource;
  if ('availabilitySource' in body) {
    const v = body.availabilitySource;
    if (v !== 'google' && v !== 'manual') {
      throw badRequest('invalid_request', 'availabilitySource must be "google" or "manual".');
    }
    /**
     * The database CHECK refuses this combination anyway. Catching it here means
     * the merchant gets a sentence naming the missing step instead of a
     * constraint-violation 500 — the same reasoning routes/staff.ts gives for
     * catching `void` without `charges` in the handler.
     */
    if (v === 'google' && !target.googleConnected) {
      throw conflict(
        'google_not_connected',
        'This artist has not connected a Google Calendar, so there are no synced hours to switch back to.',
      );
    }
    nextSource = v;
  }

  const editsWindows = 'windows' in body || 'slotMinutes' in body;

  /**
   * THE REFUSAL THIS ENDPOINT EXISTS TO MAKE REAL.
   *
   * Refused when the row is `google` AND the request is not switching it to
   * `manual` in the same breath. Switching and editing together is the ordinary
   * flow — the dashboard's segmented control moves to Manual and the day rows
   * become live — so the request that carries both is accepted, and the one that
   * carries only an edit is not.
   */
  if (editsWindows && nextSource === 'google') {
    throw conflict(
      'availability_is_synced',
      "These hours come from this artist's Google Calendar and would be overwritten by the next sync. Switch to Manual hours to set them here.",
    );
  }

  const nextSlot = 'slotMinutes' in body ? parseSlotMinutes(body.slotMinutes) : target.slotMinutes;
  // Validated against the slot length that will be STORED, not the one that was.
  // Shortening a window and lengthening the slot in one request has to agree.
  const nextWindows = 'windows' in body ? parseWindows(body.windows, nextSlot) : target.windows;

  /**
   * A slot change alone can invalidate a window the client never sent. The
   * dashboard's own stepper widens the day instead (`schSetSlot`); the server
   * refuses rather than silently rewriting hours nobody asked to change, because
   * a merchant who moves 30m → 60m and finds her Saturday extended by half an
   * hour has been edited by the software.
   */
  if (!('windows' in body) && nextSlot !== target.slotMinutes) {
    parseWindows(target.windows, nextSlot);
  }

  const changed: string[] = [];
  if (nextSource !== target.availabilitySource) changed.push('availabilitySource');
  if (nextSlot !== target.slotMinutes) changed.push('slotMinutes');
  if (JSON.stringify(nextWindows) !== JSON.stringify(target.windows)) changed.push('windows');

  if (changed.length === 0) return serialiseArtist(target);

  /**
   * ONE TRANSACTION. The row and its audit line commit together — an audit row
   * for a change that rolled back is worse than no row, and services/audit.ts
   * takes an executor for exactly this.
   */
  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(artist)
      .set({
        availabilitySource: nextSource,
        slotMinutes: nextSlot,
        windows: nextWindows,
        updatedAt: new Date(),
      })
      .where(eq(artist.id, target.id))
      .returning();

    if (!updated) throw notFound('unknown_artist', 'No such artist.');

    /**
     * `rules`, not `access`. Availability decides what a customer can book and
     * when a deposit is taken; it is a rule of how the salon trades, which is
     * the Rules filter the dashboard draws. `access` is who may do what, and
     * nothing here grants anybody anything.
     */
    await writeAudit(tx, principal, {
      salonId: target.salonId,
      kind: 'rules',
      action: 'Availability changed',
      detail:
        `${target.name}: ` +
        changed
          .map((c) =>
            c === 'availabilitySource'
              ? `${target.availabilitySource} → ${nextSource} hours`
              : c === 'slotMinutes'
                ? `${target.slotMinutes}m → ${nextSlot}m slots`
                : 'weekly hours updated',
          )
          .join(' · '),
      source,
      subjectType: 'artist',
      subjectId: target.id,
      metadata: {
        changed,
        before: {
          availabilitySource: target.availabilitySource,
          slotMinutes: target.slotMinutes,
          windows: target.windows,
        },
        after: {
          availabilitySource: nextSource,
          slotMinutes: nextSlot,
          windows: nextWindows,
        },
        /**
         * Stamped so the record still reads correctly after the zone question is
         * answered: these strings were stored with no zone attached, and a later
         * migration that reinterprets them can tell which rows predate it.
         */
        wallClockUnzoned: true,
      },
      ipAddress: req.ip ?? null,
      userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
    });

    return serialiseArtist(updated);
  });
}

/**
 * The artist row belonging to this staff account, or a 404 that says why.
 *
 * Shared by `GET /artists/me` and `PUT /artists/me/availability` so the two
 * cannot disagree about who "me" is. Scoped to the principal's salon as well as
 * to the staff id: `artist.staff_user_id` is unique on its own, but reading a
 * salon id off the token and then not using it is how a cross-salon lookup gets
 * introduced later by someone tidying the query.
 *
 * A staff account with no artist row — a receptionist, a shared scanner
 * terminal — is not bookable and has no week. 404 rather than 403: nothing was
 * refused on authority, there is simply no calendar here. Both routes give the
 * same sentence, because from the tablet they are the same situation.
 */
async function requireOwnArtist(p: StaffPrincipal): Promise<typeof artist.$inferSelect> {
  const rows = await db
    .select()
    .from(artist)
    .where(and(eq(artist.staffUserId, p.id), eq(artist.salonId, p.salonId)))
    .limit(1);
  const target = rows[0];
  if (!target) {
    throw notFound(
      'not_an_artist',
      'This account is not set up as a bookable artist, so it has no hours to set.',
    );
  }
  return target;
}

export async function registerArtistRoutes(app: FastifyInstance): Promise<void> {
  // ------------------------------------ GET /artists/{id}/availability?date= --
  /**
   * api-contract.md § Operations: "Customer | Availability |
   * GET /artists/{id}/availability?date=".
   *
   * THE ENDPOINT THE ZONE EXISTS FOR. Every slot it emits is a real instant, and
   * producing one requires answering "what moment is 10:00 on this date at this
   * salon" — which is `wallClockInstant(date, minutes, salon.timezone)` and is
   * not answerable without the column migration 0010 added.
   *
   * Any authenticated principal of the salon. A customer chooses a slot from
   * this list, so gating it on a merchant permission would gate booking itself;
   * `requireSameSalon` is the boundary that matters, and it is checked against
   * the ARTIST's salon because the path carries no salon id.
   *
   * Both representations are emitted for every slot:
   *
   *   startsAt  the instant, in UTC. What a booking will actually be stored as,
   *             and the only thing two clients in two zones can agree on.
   *   local     "10:00", the label. Rendered as-is — a client that reformatted
   *             `startsAt` in the DEVICE's zone would show a customer in London
   *             her Kuwait appointment at 07:00 and let her believe it.
   *
   * EVERY slot is emitted, including the ones nobody can book. See
   * services/availability.ts: a struck-through 16:45 says "somebody took it",
   * a missing 16:45 says "this salon does not work at 16:45", and only one of
   * those is true.
   */
  app.get<{ Params: { id: string }; Querystring: { date?: string } }>(
    '/artists/:id/availability',
    async (req, reply) => {
      const p = requirePrincipal(req);

      // Required, not defaulted to "today". "Today" is a question about a zone,
      // and a server that answered it from its own clock would be making exactly
      // the mistake this endpoint exists to stop.
      const date = parseDate(req.query?.date, 'date');

      return reply.send(
        await computeAvailability(db, req.params.id, p.salonId, date, req.query?.date ?? ''),
      );
    },
  );


  // ------------------------------------------------- GET /salons/{id}/artists --
  /**
   * perms.team. The roster of bookable people and their hours is the Merchant →
   * Team screen, which is the screen `perms.team` names.
   *
   * Not `perms.appointments`: that permission opens the appointment LIST — who
   * is booked, with whom, for how much deposit. This is who works here, which is
   * the same authority `GET /staff` sits behind.
   */
  app.get<{ Params: { id: string } }>('/salons/:id/artists', async (req, reply) => {
    const p = requireDashboardPerm(req, 'team');
    requireSameSalon(p, req.params.id);

    const rows = await db
      .select()
      .from(artist)
      .where(eq(artist.salonId, req.params.id))
      .orderBy(asc(artist.name));

    return reply.send({ items: rows.map(serialiseArtist), nextCursor: null });
  });

  // ------------------------------------------------------- GET /artists/me --
  /**
   * THE READ THAT MAKES `PUT /artists/me/availability` USABLE.
   *
   * Until this existed the scanner could WRITE an artist's week and could not
   * read it back. All three candidate routes failed her, each for a different
   * and correct reason: this path did not exist, `/artists/me/availability`
   * fell through to the `:id` handler and 404'd on an artist called "me", and
   * `GET /salons/{id}/artists` is `perms.team` — which is exactly the
   * permission an artist account is supposed to lack.
   *
   * So the scanner's My schedule opened on the manual/Google toggle and got its
   * row from the response of the PUT that answered it. Lane B declined to probe
   * with a speculative `{availabilitySource:'manual'}` on mount, and was right
   * to: that is a write dressed as a read, and it silently switches a
   * Google-synced artist off her calendar. A screen with no read is a screen
   * that eventually invents one.
   *
   * Scanner scope, NO PERMISSION, same authority model as `GET /staff/me` and
   * as the PUT directly below: the `me` in the path is self-scoping by
   * construction, so there is nothing left for a permission to decide. Gating
   * "may I see my own working hours" on `perms.team` would mean every artist
   * who can read her own week can also read — and edit — everyone else's.
   *
   * Returns the full `serialiseArtist` shape, deliberately, and not a narrowed
   * one. It is HER row: `windows` is the week the screen renders,
   * `availabilitySource` and `googleConnected` are what the source toggle is a
   * picture of, and `slotMinutes` is the grid. A narrower response would send
   * the screen straight back to inferring them from a write.
   */
  app.get('/artists/me', async (req, reply) => {
    const p = requireScannerScope(req);
    return reply.send(serialiseArtist(await requireOwnArtist(p)));
  });

  // ------------------------------------------ PUT /artists/me/availability --
  /**
   * The artist's own hours, from the scanner.
   *
   * REGISTERED BEFORE THE `:id` ROUTE. Fastify's router prefers a static segment
   * over a parameter, so the order does not actually decide it — but writing it
   * this way means a reader never has to know that to be sure `me` cannot fall
   * through to the `perms.team` handler and be looked up as an artist id.
   *
   * No permission. Scanner scope and an artist row linked to this staff account
   * ARE the authority — the same reasoning `GET /staff/me` gives. Gating "may I
   * set my own working hours" on `perms.team` would mean every artist who can
   * edit her own week can also edit everyone else's.
   */
  app.put('/artists/me/availability', async (req, reply) => {
    const p = requireScannerScope(req);
    const target = await requireOwnArtist(p);
    return reply.send(await applyAvailability(target, p, req, 'scanner'));
  });

  // ----------------------------------- POST /artists/{id}/calendar/connect --
  /**
   * Start the Google connect. build-plan.md phase 6: "Google Calendar read-only
   * connect".
   *
   * `perms.team` — it is the Team screen's action, and it changes where an
   * artist's bookable hours come from, which is the same authority that edits
   * them.
   *
   * TODAY THIS ANSWERS 503, AND THAT IS THE HONEST ANSWER. The driver is a stub
   * because OAuth against Google needs a Cloud project owned by AVO — a client id
   * and secret, a verified consent screen carrying AVO's name and privacy policy,
   * and redirect URIs on AVO's domains. Those are issued to a legal entity and
   * are the client's to create; a developer's personal project would put a
   * salon's artists' calendars behind an account nobody at AVO controls.
   *
   * The refusal names all of it, so a merchant who taps Connect learns she is
   * waiting on AVO rather than on herself. The alternative — a redirect to
   * nowhere, or a fake "connected" state — is the failure src/calendar/stub.ts
   * exists to refuse.
   */
  app.post<{ Params: { id: string } }>('/artists/:id/calendar/connect', async (req, reply) => {
    const p = requireDashboardPerm(req, 'team');

    const [target] = await db
      .select()
      .from(artist)
      .where(and(eq(artist.id, req.params.id), eq(artist.salonId, p.salonId)))
      .limit(1);
    if (!target) throw notFound('unknown_artist', 'No such artist.');

    try {
      const started = await calendar.beginConnect({
        salonId: p.salonId,
        artistId: target.id,
        redirectUri: env.calendarRedirectUrl,
      });
      return reply.send({ authorizeUrl: started.authorizeUrl, state: started.state });
    } catch (err) {
      if (err instanceof CalendarNotConfiguredError) {
        throw serviceUnavailable('calendar_not_configured', err.message, {
          driver: calendar.id,
          artistId: target.id,
        });
      }
      throw err;
    }
  });

  // ------------------------------------------ DELETE /artists/{id}/calendar --
  /**
   * Disconnect. `perms.team`, same reasoning.
   *
   * IT ALSO SWITCHES HER TO MANUAL HOURS, and it has to: the CHECK
   * `artist_google_source_requires_connection` refuses a row that claims its
   * hours come from a calendar it is not connected to, so an artist left on
   * `google` with `google_connected = false` is not a state the database will
   * store. Doing it in one UPDATE is what stops a disconnect from being half
   * applied.
   *
   * Her `windows` are KEPT, deliberately. They are the last thing the sync wrote
   * and are the only hours anyone has for her; blanking them would leave the
   * merchant re-typing a week she never chose to lose. They are now editable,
   * which is exactly what "switch to Manual to set them here" means.
   */
  app.delete<{ Params: { id: string } }>('/artists/:id/calendar', async (req, reply) => {
    const p = requireDashboardPerm(req, 'team');

    const [target] = await db
      .select()
      .from(artist)
      .where(and(eq(artist.id, req.params.id), eq(artist.salonId, p.salonId)))
      .limit(1);
    if (!target) throw notFound('unknown_artist', 'No such artist.');

    if (!target.googleConnected) {
      throw conflict('calendar_not_connected', 'That artist has no connected calendar.');
    }

    return db.transaction(async (tx) => {
      const [updated] = await tx
        .update(artist)
        .set({
          googleConnected: false,
          // Forced by the CHECK, and correct: her hours are now hers to set.
          availabilitySource: 'manual',
          updatedAt: new Date(),
        })
        .where(eq(artist.id, target.id))
        .returning();
      if (!updated) throw notFound('unknown_artist', 'No such artist.');

      await tx
        .update(artistCalendarConnection)
        .set({ status: 'revoked', updatedAt: new Date() })
        .where(eq(artistCalendarConnection.artistId, target.id));

      /**
       * `access`, not `rules`. Revoking a third party's read access to a
       * calendar is an authority change; the hours change that comes with it is
       * a consequence, and the detail says so.
       */
      await writeAudit(tx, p, {
        salonId: target.salonId,
        kind: 'access',
        action: 'Calendar disconnected',
        detail: `${target.name}: Google calendar disconnected · hours switched to manual`,
        source: 'merchant',
        subjectType: 'artist',
        subjectId: target.id,
        metadata: { artistId: target.id, previousSource: target.availabilitySource },
        ipAddress: req.ip ?? null,
        userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
      });

      /**
       * The disconnect notification is RESOLVED rather than raised. She is on
       * manual hours now, deliberately, so there is nothing to warn about — and
       * leaving a stale warning open would suppress the real one if her calendar
       * is ever reconnected and then breaks.
       */
      await resolveMerchantNotification(tx, {
        salonId: target.salonId,
        kind: 'calendar_disconnected',
        subjectType: 'artist',
        subjectId: target.id,
      });

      return reply.send(serialiseArtist(updated));
    });
  });

  // ------------------------------------------ PUT /artists/{id}/availability --
  /**
   * Somebody else's hours, from the dashboard. api-contract.md § Artist:
   * "Owner/receptionist can edit `windows` on the artist's behalf (Merchant →
   * Team)."
   *
   * `perms.team` FIRST STATEMENT, before the artist is read. A 404 answered to a
   * caller without the permission would confirm which artist ids exist.
   */
  app.put<{ Params: { id: string } }>('/artists/:id/availability', async (req, reply) => {
    const p = requireDashboardPerm(req, 'team');

    const rows = await db
      .select()
      .from(artist)
      .where(and(eq(artist.id, req.params.id), eq(artist.salonId, p.salonId)))
      .limit(1);
    const target = rows[0];
    // Same 404 for "no such artist" and "not in your salon" — another salon's
    // roster is not something this caller gets to probe. routes/staff.ts § PATCH.
    if (!target) throw notFound('unknown_artist', 'No such artist.');

    return reply.send(await applyAvailability(target, p, req, 'merchant'));
  });
}
