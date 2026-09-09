/**
 * Artists and their availability windows — api-contract.md § Artist.
 *
 *   GET /salons/{id}/artists          perms.team   (dashboard) — the full roster
 *   GET /salons/{id}/artists/bookable any principal of the salon — the customer's
 *   GET /artists/me                   authenticated staff (scanner) — her own row
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

import { and, asc, eq, inArray, isNull, type SQL } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { db } from '../db/client';
import { artist, SLOT_MINUTES, type ArtistWindows } from '../db/schema/artist';
import { artistCalendarConnection } from '../db/schema/booking';
import { branch, salon } from '../db/schema/salon';
import { calendar, CalendarNotConfiguredError } from '../calendar';
import { env } from '../env';
import {
  requireDashboardPerm,
  requireSalonScoped,
  requireScannerScope,
  requireSameSalon,
  type StaffPrincipal,
} from '../auth/principal';
import { badRequest, conflict, notFound } from '../http/errors';
/** One definition of "HH:MM" for the whole API — see http/fields.ts. */
import { HHMM } from '../http/fields';
import { writeAudit } from '../services/audit';
import { computeAvailability } from '../services/availability';
import { assertBookingReadable, type PrincipalKind } from '../services/moduleAccess';
import { resolveMerchantNotification } from '../services/notifications';
import { parseDate } from '../time/zone';

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
/**
 * `?branch=` on the two artist lists, resolved once so the merchant roster and
 * the customer's bookable list cannot disagree about what the parameter means.
 *
 * THREE VALUES, and `unassigned` is the one that exists because of migration
 * 0044's ruling: artists at a multi-branch salon were deliberately left NULL,
 * so "who still has no branch" is the merchant's actual working query and a
 * caller cannot express it with a branch id.
 *
 * An unrecognised value is REFUSED rather than ignored. A filter that quietly
 * does nothing returns the whole roster, which reads as "all of these are at
 * that branch" — a wrong answer presented as a filtered one.
 */
function artistBranchFilter(value: string | undefined): SQL | undefined {
  if (value === undefined || value === '') return undefined;
  if (value === 'unassigned') return isNull(artist.branchId);
  if (value === 'all') return undefined;
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(value)) {
    throw badRequest(
      'invalid_branch_filter',
      "branch must be a branch id, 'unassigned', or 'all'.",
    );
  }
  return eq(artist.branchId, value);
}

function serialiseArtist(row: typeof artist.$inferSelect) {
  return {
    id: row.id,
    salonId: row.salonId,
    name: row.name,
    nameAr: row.nameAr,
    availabilitySource: row.availabilitySource,
    googleConnected: row.googleConnected,
    slotMinutes: row.slotMinutes,
    /**
     * WHERE SHE WORKS, or null when nobody has assigned her (migration 0044).
     *
     * SERVED EVEN WHEN NULL, and that is the point rather than an oversight. A
     * multi-branch salon's artists were deliberately not backfilled — pointing
     * them at whichever branch sorts first would be the guess decisions 80 and
     * 82 forbid — so null is a real and common state, and it is what lets the
     * dashboard say "3 artists have no branch" instead of the merchant
     * discovering it from a diary that quietly attributes appointments to the
     * wrong location.
     */
    branchId: row.branchId,
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

/**
 * `modules.booking`, for the two reads in this file that feed the Book flow.
 *
 * The flag lives on the salon and both callers already know which salon governs
 * them, so this is one narrow SELECT rather than a `loadSalon` — the row is read
 * to answer one question. The rule itself is in `services/moduleAccess.ts`, shared
 * with `routes/salons.ts` so the two files cannot drift on who the gate applies to.
 */
async function assertSalonTakesBookings(kind: PrincipalKind, salonId: string): Promise<void> {
  // Staff read the roster and its hours while setting the salon up — see the rule.
  if (kind !== 'member') return;

  const [row] = await db
    .select({ moduleBooking: salon.moduleBooking })
    .from(salon)
    .where(eq(salon.id, salonId))
    .limit(1);
  if (!row) throw notFound('unknown_salon', 'No such salon.');

  assertBookingReadable(kind, row);
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
      // Salon-scoped: `p.salonId` is the tenancy boundary passed to
      // `computeAvailability` below, and the owner console has no salon to pass.
      const p = requireSalonScoped(req);

      /**
       * The module, before the grid. `p.salonId` IS the governing salon: the
       * artist is resolved against it (`services/availability.ts` :289 refuses
       * one whose `salonId` differs), so there is no other salon this read could
       * be about. Checked before `parseDate` for the reason `reports.ts` § build
       * gives — an invalid date must not answer differently from a valid one to
       * somebody who may not read this at all.
       */
      await assertSalonTakesBookings(p.kind, p.salonId);

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
  /**
   * `?branch=<id>` filters to one branch; `?branch=unassigned` is the query a
   * merchant actually needs after migration 0044, because that is the set she
   * has to act on. Anything else is refused by name rather than ignored — a
   * filter that silently does nothing shows a full roster and reads as "every
   * artist is at this branch", which is the opposite of the truth.
   *
   * NO SALON CHECK ON THE BRANCH ID, and none is needed: the `WHERE` is already
   * `salon_id = <hers>`, so another salon's branch id simply matches no row and
   * returns an empty list. It cannot be used to probe, because an id that is not
   * hers and an id that is hers with no artists are the same answer.
   */
  app.get<{ Params: { id: string }; Querystring: { branch?: string } }>(
    '/salons/:id/artists',
    async (req, reply) => {
      const p = requireDashboardPerm(req, 'team');
      requireSameSalon(p, req.params.id);

      const rows = await db
        .select()
        .from(artist)
        .where(and(eq(artist.salonId, req.params.id), artistBranchFilter(req.query.branch)))
        .orderBy(asc(artist.name));

      return reply.send({ items: rows.map(serialiseArtist), nextCursor: null });
    },
  );

  // -------------------------------------- GET /salons/{id}/artists/bookable --
  /**
   * THE ROUTE THAT MAKES BOOKING WORK FOR A CUSTOMER AT ALL.
   *
   * Step 2 of the wallet's Book flow — choose your artist — and the artist name
   * on the upcoming-appointment card both need the roster, and the only roster
   * endpoint was `GET /salons/{id}/artists` above, which is `perms.team`. A real
   * member session therefore got a 403 and the flow resolved only under
   * `AVO_TEST_PRINCIPALS`, where an unauthenticated request quietly becomes
   * ST-001. The Book flow was working in the test shim and nowhere else.
   *
   * A SEPARATE PATH, NOT A BRANCH INSIDE THE `perms.team` ROUTE. One URL that
   * answers two different shapes depending on who is asking cannot be declared
   * once in `packages/types`, and the contract is the thing that has already
   * bitten this build three times. The URL names the audience, exactly as
   * `/artists/me/…` does two routes down.
   *
   * ACTIVE ONLY. "Bookable" is the filter, not a hint — a customer choosing who
   * will cut her hair should not be offered somebody who has left. The merchant
   * roster above deliberately does the opposite and lists everyone, because
   * reception has to be able to see and reactivate a retired artist.
   *
   * WHAT A CUSTOMER GETS, AND WHAT SHE DOES NOT
   * -------------------------------------------
   * Emitted: `id` (she posts it to `/bookings` and reads
   * `/artists/{id}/availability` with it), `salonId`, `name`, `nameAr`, and
   * `availabilityLive`.
   *
   * Excluded, and each for its own reason rather than as a blanket narrowing:
   *
   *   handle, role, perms, branchAccess
   *                     `staff_user` fields. They are not on this table at all
   *                     and must not be joined in to get here — the roster a
   *                     customer sees is people, not accounts.
   *   hasOwnLogin       which artists hold an AVO account. A staffing fact, and
   *                     the one field on THIS table that leaks toward
   *                     `staff_user`. It is on the merchant shape because
   *                     reception needs to know who can edit her own week.
   *   windows           the salon's internal scheduling week. She gets the
   *                     computed grid from `/artists/{id}/availability`, which
   *                     has already subtracted other customers' bookings; the
   *                     raw week would let her infer who is booked when.
   *   slotMinutes       an operational detail. The grid arrives pre-sliced.
   *   availabilitySource, googleConnected
   *                     the name and connection state of a third-party
   *                     integration. See `availabilityLive` below.
   *   active            the list is filtered on it, so emitting it would say
   *                     `true` on every row. The filter is the statement.
   *
   * `availabilityLive` IS THE ANSWER WITHOUT THE MECHANISM
   * -----------------------------------------------------
   * False means services/availability.ts will fall back to the SALON's hours for
   * this artist rather than offering her own — which over-offers deliberately, so
   * a slot the customer picks may be one the artist cannot actually work. That is
   * a real thing to tell her. *Why* it happens is "AVO cannot reach her Google
   * Calendar", which is the salon's operational problem and belongs in the
   * merchant's bell (it is already there, deduplicated), not in a customer's
   * booking screen. One boolean says the part she can act on.
   *
   * Computed the same way `resolveWorkingWindow` computes it, and it has to be:
   * a manual artist is always live, a google-sourced one needs BOTH a
   * `connected` row and a driver that can actually reach a calendar — a stub
   * driver with a connection row would report an artist free having read
   * nothing. One `IN` query for the whole salon rather than one per artist.
   *
   * IT DOES NOT RAISE THE MERCHANT NOTIFICATION. `resolveWorkingWindow` does
   * that on the real availability read, where the fallback is actually applied.
   * Raising it here would put a write inside a customer's list read for a
   * fallback that has not happened yet.
   */
  /**
   * `?branch=` HERE IS THE CUSTOMER'S BRANCH SWITCH — the request Aftab made.
   * She picks a location, and the artist list narrows to the artists who work
   * there. She never names a branch on `POST /bookings`; the booking's branch is
   * derived from whichever artist she then chooses (migration 0044), so choosing
   * a branch is a FILTER and never an assertion. Non-negotiable #2 untouched.
   *
   * UNASSIGNED ARTISTS ARE INCLUDED WHEN NO FILTER IS GIVEN and excluded by any
   * branch filter, which falls out of `branch_id = <id>` and is the honest
   * answer: an artist with no branch cannot be claimed to work at one. A salon
   * that has not assigned its artists therefore sees no change to the unfiltered
   * flow, and a branch filter that returns nothing is telling the customer
   * something true.
   */
  // ------------------------------------------- PUT /artists/{id}/branch --
  /**
   * ASSIGN AN ARTIST TO A BRANCH.  (migration 0044)
   *
   * `perms.team`, AND THAT IS THE DELIBERATE CONTRAST WITH A TILL. Enrolling a
   * device is gated `perms.dashboard` because a till's branch decides which
   * branch's EARNING RATES apply to money (DECISIONS.md #82). An artist's branch
   * decides where an APPOINTMENT is and which diary it lands in — it pays no
   * multiplier, because the charge that settles a booking takes its branch from
   * the enrolled device and not from the booking. So this is roster
   * administration, and `perms.team` is the authority over who works here.
   *
   * `branchId: null` UNASSIGNS, and is accepted rather than refused: a merchant
   * who assigned an artist to the wrong branch must be able to undo it without
   * inventing a third state, and null is the state every artist started in.
   *
   * OPEN BRANCHES ONLY, matching `POST /salons/{id}/devices`. Assigning to a
   * closed branch would produce bookings attributed to a location that takes no
   * money — `resolveBranch` refuses a closed `supplied` branch — so the booking
   * would fail at the deposit hold. Caught here, where it can be a message.
   *
   * IDEMPOTENT AND QUIET WHEN NOTHING CHANGES: re-assigning the same branch
   * writes no audit row, the pattern the availability PUT above already uses.
   */
  app.put<{ Params: { id: string } }>('/artists/:id/branch', async (req, reply) => {
    const p = requireDashboardPerm(req, 'team');

    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!('branchId' in body)) {
      throw badRequest('branch_required', 'branchId is required; send null to unassign.');
    }
    const raw = body.branchId;
    if (raw !== null && typeof raw !== 'string') {
      throw badRequest('invalid_branch', 'branchId must be a branch id or null.');
    }
    const wanted = raw === null ? null : raw.trim();
    if (wanted === '') {
      throw badRequest('invalid_branch', 'branchId must be a branch id or null.');
    }

    const [target] = await db
      .select()
      .from(artist)
      .where(and(eq(artist.id, req.params.id), eq(artist.salonId, p.salonId)))
      .limit(1);
    // Same 404 for "no such artist" and "not in your salon" — another salon's
    // roster is not something this caller gets to probe (the reasoning
    // `createBooking` and `computeAvailability` both already use).
    if (!target) throw notFound('unknown_artist', 'No such artist.');

    if (wanted !== null) {
      const [b] = await db
        .select({ id: branch.id })
        .from(branch)
        .where(
          and(eq(branch.id, wanted), eq(branch.salonId, p.salonId), isNull(branch.closedAt)),
        )
        .limit(1);
      // 404 and not 403: a 403 would confirm the id names a real branch
      // somewhere else, which is `resolveBranch`'s own argument.
      if (!b) throw notFound('unknown_branch', 'No such open branch.');
    }

    if (target.branchId === wanted) return reply.send(serialiseArtist(target));

    /**
     * THE RESPONSE IS BUILT INSIDE THE TRANSACTION AND SENT AFTER IT COMMITS.
     *
     * The first version called `reply.send(...)` from INSIDE the transaction
     * callback, which dispatches the response before drizzle's COMMIT round trip
     * has finished — so a client that PUT and immediately re-read could see the
     * OLD branch. It showed up as an intermittently red spec on the third
     * consecutive int run (decision 75), not on the first two, and the residue
     * is still visible in the lane database: one run's artist left unassigned
     * because its own assertion read a pre-commit snapshot.
     *
     * Returning the serialised row and letting fastify send it once the handler's
     * promise resolves is the shape `PUT /artists/{id}/availability` above already
     * uses, and `POST /salons/{id}/devices` uses the same ordering.
     */
    const updatedRow = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(artist)
        .set({ branchId: wanted, updatedAt: new Date() })
        .where(eq(artist.id, target.id))
        .returning();

      await writeAudit(tx, p, {
        salonId: p.salonId,
        kind: 'rules',
        action: wanted === null ? 'artist_branch_cleared' : 'artist_branch_set',
        detail: `${target.name} → ${wanted ?? 'no branch'}`,
        source: 'merchant',
        subjectType: 'artist',
        subjectId: target.id,
      });

      return updated!;
    });

    return reply.send(serialiseArtist(updatedRow));
  });

  app.get<{ Params: { id: string }; Querystring: { branch?: string } }>(
    '/salons/:id/artists/bookable',
    async (req, reply) => {
      // Any authenticated principal of this salon — the same gate
      // `GET /salons/{id}/services` uses, and for the same reason: gating the
      // list a customer books from on a merchant permission gates booking.
      const p = requireSalonScoped(req);
      requireSameSalon(p, req.params.id);
      await assertSalonTakesBookings(p.kind, req.params.id);

      const rows = await db
        .select({
          id: artist.id,
          salonId: artist.salonId,
          name: artist.name,
          nameAr: artist.nameAr,
          availabilitySource: artist.availabilitySource,
        })
        .from(artist)
        .where(
          and(
            eq(artist.salonId, req.params.id),
            eq(artist.active, true),
            artistBranchFilter(req.query.branch),
          ),
        )
        .orderBy(asc(artist.name));

      const syncedIds = rows
        .filter((r) => r.availabilitySource === 'google')
        .map((r) => r.id);

      const live = new Set<string>();
      if (syncedIds.length > 0 && calendar.configured) {
        const connections = await db
          .select({ artistId: artistCalendarConnection.artistId })
          .from(artistCalendarConnection)
          .where(
            and(
              inArray(artistCalendarConnection.artistId, syncedIds),
              eq(artistCalendarConnection.status, 'connected'),
            ),
          );
        for (const c of connections) live.add(c.artistId);
      }

      return reply.send({
        items: rows.map((r) => ({
          id: r.id,
          salonId: r.salonId,
          name: r.name,
          nameAr: r.nameAr,
          // `availabilitySource` is selected only to compute this, and is
          // destructured away here by construction rather than deleted from a
          // spread — the same discipline http/serialise.ts applies to `feeFils`.
          availabilityLive: r.availabilitySource !== 'google' || live.has(r.id),
        })),
        nextCursor: null,
      });
    },
  );

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
        /**
         * 409, in the sweep `routes/support.ts` describes. `services/policy.ts`
         * settled that a configuration state is not a transient unavailability, and
         * a calendar driver that has not been configured is exactly that: no retry
         * makes it work, and 503 is what puts a refusal in a client's offline
         * bucket, so a merchant pressing Connect was told her network was down
         * about a server that had just answered.
         */
        throw conflict('calendar_not_configured', err.message, {
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

    /**
     * SENT AFTER THE COMMIT, not from inside the transaction.
     *
     * This handler called `reply.send()` from within `db.transaction()` — twelve
     * lines below the paragraph on `PUT /artists/{id}/branch` explaining why that
     * is wrong, which is the honest record: the fix was understood there and not
     * generalised. Lane D's `e2e/commit-order.test.ts` scan found it on its first
     * run (DECISIONS.md #93).
     *
     * `reply.send()` dispatches the response before drizzle's COMMIT round trip
     * finishes, so a client that acts on the 200 and immediately re-reads can see
     * the PRE-disconnect row: `googleConnected: true`, `availabilitySource:
     * 'google'`. Lane D measured the window with a control — 4 of 40 write-then-
     * reread attempts on the broken shape, 0 of 40 on the fixed one — so roughly
     * one attempt in ten, which is why three ordinary runs would probably not
     * have noticed.
     *
     * The shape is: do the work in the transaction, RETURN the row, and let
     * fastify send once the handler's promise (commit included) resolves.
     */
    const updatedRow = await db.transaction(async (tx) => {
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

      return updated;
    });

    return reply.send(serialiseArtist(updatedRow));
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
