/**
 * The Services tab — "add the services, price it, then assign them". The
 * client's words, and the three verbs are the three gates below.
 *
 *   POST   /salons/{id}/services               perms.loyalty  add a service
 *   PATCH  /salons/{id}/services/{sid}         perms.loyalty  rename / reprice
 *   DELETE /salons/{id}/services/{sid}         perms.loyalty  retire (never deletes)
 *   PUT    /salons/{id}/services/{sid}/artists perms.team     who does it
 *
 * `GET /salons/{id}/services` stays in routes/salons.ts, unchanged in who may
 * read it, and now carries `artistIds` — built by `serialiseServices` below, so
 * the read and every write answer one shape.
 *
 * All BARE paths, like `/salons/{id}/products` beside them. The catalogue's read
 * has always been bare and the scanner, the wallet and the dashboard all call
 * it; a `/v1/` write beside a bare read of the same resource is two spellings a
 * client has to know which to use for which verb.
 *
 * ===========================================================================
 * TWO PERMISSIONS, NOT ONE — AND NOT A TENTH.
 * ===========================================================================
 * The brief's likely fit was `perms.team` for all of it. It is right for the
 * assignment and wrong for the price, and the difference is what each one can
 * move.
 *
 * THE PRICE IS SALON CONFIGURATION THAT SETS WHAT A CUSTOMER PAYS. Every charge
 * is priced from `service.price_fils` at the moment it is posted
 * (`services/charge.ts` § 3). Whoever can edit it can make the next colour at
 * the counter cost 0.100 KD or 100.000 KD. That is the same class of authority
 * as the booking deposit, and the deposit sits behind `perms.loyalty` on
 * `PATCH /salons/{id}` — the Settings gate the codebase already uses for "salon
 * configuration" in the absence of a `settings` permission (routes/salons.ts §
 * BRANCHES says why no tenth is invented). Putting the price behind `team`
 * would let a staff member trusted to set artists' hours reprice the menu while
 * being unable to change the deposit. So: add, rename, reprice and retire are
 * `perms.loyalty`.
 *
 * THE ASSIGNMENT IS ROSTER ADMINISTRATION. "Who does which service" is the same
 * kind of fact as "who works at which branch" (`PUT /artists/{id}/branch`) and
 * "when does she work" (`PUT /artists/{id}/availability`), and both of those are
 * `perms.team`. It moves no money and prices nothing — it decides whose diary a
 * booking may land in. So: `PUT …/artists` is `perms.team`.
 *
 * A `perms.services` would have been cleaner to read and is a four-way break:
 * `StaffPermsSchema` is consumed by every surface, and the Accounts → Team chips
 * are drawn by the design. Not this lane's to add.
 *
 * ===========================================================================
 * A PRICE CHANGE NEVER MOVES MONEY ALREADY AGREED.
 * ===========================================================================
 *   - A past charge stores its own `amount_fils` and its receipt its own line
 *     prices; nothing re-reads `service.price_fils` for money already moved.
 *     `best-selling-services` reads revenue from `transaction_revenue`, and only
 *     the service NAME from this row — so a rename relabels that report's
 *     history, and a reprice does not change a fils of it.
 *   - A booking's `deposit_fils` is the SALON'S deposit (`salon.deposit_fils`,
 *     `createBooking` § 4), not the service price. Repricing a service changes
 *     no held deposit.
 *   - AN UNPAID BASKET AT THE COUNTER IS AFFECTED. A basket is a list of
 *     service ids; `POST /charges` prices it from these rows when it is posted,
 *     and the request carries no expected total. So a charge posted after a
 *     price edit commits is charged at the NEW price, even if the scanner's
 *     screen was showing the old one. The customer is told the real amount by
 *     the charge response and the receipt; nothing is charged that the server
 *     did not price. Closing the gap would need an expected total on the charge
 *     request — a contract change, reported rather than made.
 */

import { formatMoney } from '@avo/types';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { db } from '../db/client';
import { artist } from '../db/schema/artist';
import { artistService } from '../db/schema/artistService';
import { service } from '../db/schema/service';
import { requireDashboardPerm, requireSameSalon } from '../auth/principal';
import { badRequest, conflict, notFound } from '../http/errors';
import { parseAmountFils, requireString } from '../money/validate';
import { assignedArtistIds } from '../services/artistService';
import { nextServiceId } from '../services/ids';
import { writeAudit, type Executor } from '../services/audit';
import { primaryImagesFor, type ImageRef } from '../services/imageAttachment';

type ServiceRow = Pick<
  typeof service.$inferSelect,
  'id' | 'salonId' | 'name' | 'nameAr' | 'priceFils' | 'active'
>;

const serviceColumns = {
  id: service.id,
  salonId: service.salonId,
  name: service.name,
  nameAr: service.nameAr,
  priceFils: service.priceFils,
  active: service.active,
};

/**
 * The wire shape, DECLARED — `SalonView`'s reason: `priceFils` is `Fils` on the
 * row and a plain number in JSON, and an inferred exported type cannot name the
 * brand (TS4058).
 */
export interface ServiceView {
  id: string;
  salonId: string;
  name: string;
  nameAr: string | null;
  /** Integer fils. */
  priceFils: number;
  active: boolean;
  image: ImageRef | null;
  artistIds: string[];
}

/**
 * `ServiceSchema`'s six fields, plus `artistIds`. EXPORTED for
 * `GET /salons/{id}/services`, so the list and the writes cannot drift.
 *
 * `artistIds` — WHO MAY BE BOOKED FOR IT, every artist assigned, sorted. It is
 * `[]` for a service nobody has been assigned to yet, which is what every NEW
 * service starts as, and that is the signal the wallet reads: a service whose
 * `artistIds` does not meet the bookable roster (`GET /salons/{id}/artists/
 * bookable`, optionally `?branch=`) cannot be booked and should not be offered.
 * The scanner ignores it — any service is chargeable.
 *
 * ALL ASSIGNED ARTISTS, RETIRED ONES INCLUDED. This list is the thing
 * `PUT …/artists` replaces, so it has to be round-trippable: a dashboard that
 * read a filtered list and saved it back would silently drop every retired
 * artist's assignment. The wallet intersects with the bookable roster, which is
 * already active-only, so a retired id here offers nobody anything. It is an
 * opaque id with no name attached; the roster that names it is `perms.team`.
 *
 * On the service rather than as `serviceIds` on `BookableArtist`, argued: the
 * Services tab edits assignment PER SERVICE, so this is the shape it writes and
 * reads back; the wallet already fetches both lists for the Book flow, and one
 * intersection answers both of its questions ("which services are bookable at
 * this branch?" and "who can do this one?") without a request per service,
 * which is what a `?service=` filter would have cost. And `serialiseArtist` has
 * five callers across two surfaces; this has one.
 */
export async function serialiseServices(
  exec: Executor,
  salonId: string,
  rows: readonly ServiceRow[],
): Promise<ServiceView[]> {
  const ids = rows.map((r) => r.id);
  const [images, artists] = await Promise.all([
    primaryImagesFor(exec as typeof db, salonId, 'service', ids),
    assignedArtistIds(exec, ids),
  ]);
  return rows.map((r) => ({
    id: r.id,
    salonId: r.salonId,
    name: r.name,
    nameAr: r.nameAr,
    priceFils: r.priceFils,
    active: r.active,
    image: images.get(r.id) ?? null,
    artistIds: artists.get(r.id) ?? [],
  }));
}

/**
 * The Arabic name: a trimmed string, or null. Blank is null — `service_name_ar_
 * not_blank` refuses an empty string, because it defeats the `nameAr ?? name`
 * fallback and paints an empty line where a service should be (migration 0022).
 */
function parseNameAr(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw badRequest('invalid_request', 'nameAr must be a string or null.');
  }
  const trimmed = value.trim();
  if (trimmed.length > 200) throw badRequest('invalid_request', 'nameAr is too long.');
  return trimmed === '' ? null : trimmed;
}

function clientMeta(req: FastifyRequest) {
  return {
    ipAddress: req.ip ?? null,
    userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
  };
}

/** An ACTIVE service of this salon, or the same 404 whether it is retired, foreign or absent. */
async function loadActiveService(salonId: string, sid: string): Promise<ServiceRow> {
  const [row] = await db
    .select(serviceColumns)
    .from(service)
    .where(and(eq(service.id, sid), eq(service.salonId, salonId), eq(service.active, true)))
    .limit(1);
  if (!row) throw notFound('unknown_service', 'No such service.');
  return row;
}

export async function registerServiceRoutes(app: FastifyInstance): Promise<void> {
  // -------------------------------------------- POST /salons/{id}/services --
  /**
   * ADD A SERVICE. `{ name, nameAr?, priceFils }` → 201 with the service.
   *
   * IT STARTS WITH NOBODY ASSIGNED (`artistIds: []`), and so it is chargeable at
   * the counter at once and bookable by nobody until someone is assigned. That
   * is the safe direction: "everyone does it" would put a new brow treatment in
   * every artist's diary, including the ones who have never done one, and the
   * first a merchant would hear of it is a customer booked with the wrong
   * person. The empty list is served, so the wallet does not offer it and the
   * Services tab can say "nobody assigned yet".
   *
   * The id is minted here, never taken from the body: a client-chosen primary
   * key is a client that can collide with another salon's row. From a SEQUENCE
   * (`SV-10000000` up, migration 0061), not the products route's six base36
   * characters — `services/ids.ts § nextServiceId` says why.
   */
  app.post<{ Params: { id: string } }>('/salons/:id/services', async (req, reply) => {
    const p = requireDashboardPerm(req, 'loyalty');
    requireSameSalon(p, req.params.id);

    const body = (req.body ?? {}) as Record<string, unknown>;
    const rejected = Object.keys(body).filter(
      (k) => k !== 'name' && k !== 'nameAr' && k !== 'priceFils',
    );
    if (rejected.length > 0) {
      throw badRequest(
        'not_editable',
        `These fields cannot be set on a new service: ${rejected.join(', ')}. ` +
          'A service has a name, an Arabic name and a price; assign artists with PUT …/artists.',
      );
    }
    const name = requireString(body.name, 'name', 200);
    const nameAr = parseNameAr(body.nameAr);
    // Integer fils, positive — non-negotiable #1, and `service_price_positive`.
    const priceFils = parseAmountFils(body.priceFils, 'priceFils');

    const now = new Date();

    const row = await db.transaction(async (tx) => {
      const id = await nextServiceId(tx);
      const [inserted] = await tx
        .insert(service)
        .values({ id, salonId: p.salonId, name, nameAr, priceFils, createdAt: now, updatedAt: now })
        .returning(serviceColumns);
      if (!inserted) throw conflict('service_not_created', 'That service could not be saved. Try again.');

      // `rules`, not `money`: nothing moved. See `POST …/products`.
      await writeAudit(tx, p, {
        salonId: p.salonId,
        kind: 'rules',
        action: 'Service added',
        detail: `${name} · ${formatMoney(priceFils)} · nobody assigned yet`,
        source: 'merchant',
        subjectType: 'service',
        subjectId: id,
        metadata: { name, nameAr, priceFils },
        ...clientMeta(req),
      });
      return inserted;
    });

    const [view] = await serialiseServices(db, p.salonId, [row]);
    return reply.code(201).send(view);
  });

  // --------------------------------------- PATCH /salons/{id}/services/{sid} --
  /**
   * RENAME AND REPRICE. `{ name?, nameAr?, priceFils? }`, a patch per field —
   * "saves as you type", the products route's argument for a PATCH rather than a
   * PUT of the whole menu.
   *
   * `active` IS NOT EDITABLE HERE (retire is the DELETE, with its own audit
   * line), and neither is `artistIds` (that is `perms.team`'s route, and a
   * `loyalty` PATCH that could reassign staff would be a second door around it).
   *
   * A retired service is a 404 — it is not repriced back into the menu.
   */
  app.patch<{ Params: { id: string; sid: string } }>(
    '/salons/:id/services/:sid',
    async (req, reply) => {
      const p = requireDashboardPerm(req, 'loyalty');
      requireSameSalon(p, req.params.id);

      const body = (req.body ?? {}) as Record<string, unknown>;
      const rejected = Object.keys(body).filter(
        (k) => k !== 'name' && k !== 'nameAr' && k !== 'priceFils',
      );
      if (rejected.length > 0) {
        throw badRequest(
          'not_editable',
          `Not editable here: ${rejected.join(', ')}. A service has a name, an Arabic name and a price. ` +
            'Retire it with DELETE; assign artists with PUT …/artists.',
        );
      }

      const patch: { name?: string; nameAr?: string | null; priceFils?: ReturnType<typeof parseAmountFils> } = {};
      if ('name' in body) patch.name = requireString(body.name, 'name', 200);
      if ('nameAr' in body) patch.nameAr = parseNameAr(body.nameAr);
      if ('priceFils' in body) patch.priceFils = parseAmountFils(body.priceFils, 'priceFils');
      if (Object.keys(patch).length === 0) {
        throw badRequest('invalid_request', 'Send a name, a nameAr, a priceFils, or any of them.');
      }

      const before = await loadActiveService(p.salonId, req.params.sid);

      const row = await db.transaction(async (tx) => {
        // Salon and `active` IN THE WHERE as well: the read above is not a lock,
        // and a retire that commits between the two must not be undone by a
        // rename that finds the row anyway.
        const [updated] = await tx
          .update(service)
          .set({ ...patch, updatedAt: new Date() })
          .where(
            and(
              eq(service.id, before.id),
              eq(service.salonId, p.salonId),
              eq(service.active, true),
            ),
          )
          .returning(serviceColumns);
        if (!updated) throw notFound('unknown_service', 'No such service.');

        const repriced = patch.priceFils !== undefined && patch.priceFils !== before.priceFils;
        await writeAudit(tx, p, {
          salonId: p.salonId,
          kind: 'rules',
          action: 'Service edited',
          // What it is NOW, and the old price beside the new one when it moved —
          // a merchant reading this later is asking "since when does it cost that".
          detail:
            `${updated.name} · ${formatMoney(updated.priceFils)}` +
            (repriced ? ` (was ${formatMoney(before.priceFils)})` : ''),
          source: 'merchant',
          subjectType: 'service',
          subjectId: updated.id,
          metadata: {
            changed: Object.keys(patch),
            before: { name: before.name, nameAr: before.nameAr, priceFils: before.priceFils },
            after: { name: updated.name, nameAr: updated.nameAr, priceFils: updated.priceFils },
          },
          ...clientMeta(req),
        });
        return updated;
      });

      const [view] = await serialiseServices(db, p.salonId, [row]);
      return reply.send(view);
    },
  );

  // -------------------------------------- DELETE /salons/{id}/services/{sid} --
  /**
   * RETIRE. `active = false`; the row stays. There is no hard delete, and there
   * cannot be one: `booking.service_id` is `ON DELETE restrict`, and past
   * charges and receipts name the service. The existing list and the charge
   * pricer already filter on `active`, so a retired service leaves the menu,
   * the Book flow and the scanner in one write.
   *
   * WHAT HAPPENS TO A LIVE BOOKING FOR IT: nothing. It is not cancelled and its
   * deposit stays held. It still COMPLETES AT THE COUNTER — a held deposit is
   * applied to whatever that customer is charged at that salon inside the
   * grace window (`findApplicableHold` matches on member, salon and time, not
   * on service), and the charge settles the booking. What the counter cannot do
   * is put the retired service itself in the basket, because `performCharge`
   * prices only active rows: the receptionist rings up the visit as another
   * service or as a typed custom amount (`perms.scanner`, the existing path for
   * a price not on the menu). The booking can still be rescheduled with the same
   * artist, cancelled, or no-showed as before.
   *
   * THE ASSIGNMENTS ARE KEPT. They are why that booking can still be moved, and
   * they cost nothing on a row nobody can book.
   *
   * Idempotent by predicate: a second DELETE finds no active row and answers
   * 404, the products route's reasoning.
   */
  app.delete<{ Params: { id: string; sid: string } }>(
    '/salons/:id/services/:sid',
    async (req, reply) => {
      const p = requireDashboardPerm(req, 'loyalty');
      requireSameSalon(p, req.params.id);

      await db.transaction(async (tx) => {
        const [row] = await tx
          .update(service)
          .set({ active: false, updatedAt: new Date() })
          .where(
            and(
              eq(service.id, req.params.sid),
              eq(service.salonId, p.salonId),
              eq(service.active, true),
            ),
          )
          .returning(serviceColumns);
        if (!row) throw notFound('unknown_service', 'No such service.');

        await writeAudit(tx, p, {
          salonId: p.salonId,
          kind: 'rules',
          action: 'Service removed',
          detail: `${row.name} retired from the menu`,
          source: 'merchant',
          subjectType: 'service',
          subjectId: row.id,
          metadata: { name: row.name, priceFils: row.priceFils, retired: true },
          ...clientMeta(req),
        });
      });

      return reply.code(204).send();
    },
  );

  // ---------------------------------- PUT /salons/{id}/services/{sid}/artists --
  /**
   * WHO DOES IT. `{ artistIds: string[] }` REPLACES the set; `[]` means nobody.
   * 200 with the service, `artistIds` as stored.
   *
   * A REPLACEMENT, NOT A MERGE, and the per-service unit is the argument: the
   * Services tab draws one service's checkboxes and saves them as a whole, the
   * same reason `PUT /artists/{id}/availability` replaces a week. A merge would
   * need a second verb to untick anybody.
   *
   * EVERY ID MUST BE AN ARTIST OF THIS SALON — active or retired, so the list
   * `GET` serves can be saved back unchanged (see `serialiseServices`). Unknown
   * and foreign ids are the same 404, `unknown_artist`, naming none of them: a
   * list of which ids failed would sort another salon's roster into "real" and
   * "not". Duplicates are refused by name — the client believes it sent a set,
   * and a list with a repeat is a client bug worth surfacing.
   *
   * ONLY AN ACTIVE SERVICE, for the PATCH's reason.
   *
   * WHAT UNASSIGNING DOES TO BOOKINGS ALREADY MADE: nothing. They stand at their
   * time and complete as normal. What changes is that a NEW booking, a
   * reschedule, or a reassign onto that pair is refused `artist_not_assigned`
   * (services/artistService.ts). The booking check takes `FOR SHARE` on the link
   * row, so this DELETE and an in-flight booking serialise: either the booking
   * commits first and stands, or it waits, finds the row gone, and refuses.
   *
   * NO-OP WHEN NOTHING CHANGES: no write and no audit row, the availability
   * PUT's rule.
   */
  app.put<{ Params: { id: string; sid: string } }>(
    '/salons/:id/services/:sid/artists',
    async (req, reply) => {
      const p = requireDashboardPerm(req, 'team');
      requireSameSalon(p, req.params.id);

      const body = (req.body ?? {}) as Record<string, unknown>;
      const rejected = Object.keys(body).filter((k) => k !== 'artistIds');
      if (rejected.length > 0) {
        throw badRequest(
          'not_editable',
          `These fields cannot be set here: ${rejected.join(', ')}. This takes artistIds only.`,
        );
      }
      const raw = body.artistIds;
      if (!Array.isArray(raw)) {
        throw badRequest(
          'invalid_artist_ids',
          'artistIds must be an array of artist ids; send [] to assign nobody.',
        );
      }
      if (raw.length > 200) throw badRequest('invalid_artist_ids', 'artistIds has too many entries.');
      if (raw.some((x) => typeof x !== 'string' || x.trim() === '')) {
        throw badRequest('invalid_artist_ids', 'artistIds must contain only artist ids.');
      }
      const wanted = (raw as string[]).map((x) => x.trim());
      const dupes = [...new Set(wanted.filter((x, i) => wanted.indexOf(x) !== i))];
      if (dupes.length > 0) {
        throw badRequest('duplicate_artist', `artistIds names the same artist twice: ${dupes.join(', ')}.`);
      }

      const svc = await db.transaction(async (tx) => {
        /**
         * THE SERVICE ROW IS THE LOCK, and the diff is computed under it. Two
         * managers saving the same service's checkboxes at once would otherwise
         * each diff against the set they read and each write half of a merge —
         * one tick lost with an audit row saying it happened. `FOR NO KEY UPDATE`
         * serialises them, conflicts with a concurrent retire (so a service
         * retired a moment ago is a 404 here, not a reassigned ghost), and does
         * NOT conflict with the KEY SHARE a booking's FK checks take, so no
         * booking waits on it.
         */
        const [locked] = await tx
          .select(serviceColumns)
          .from(service)
          .where(
            and(
              eq(service.id, req.params.sid),
              eq(service.salonId, p.salonId),
              eq(service.active, true),
            ),
          )
          .for('no key update')
          .limit(1);
        if (!locked) throw notFound('unknown_service', 'No such service.');

        if (wanted.length > 0) {
          const found = await tx
            .select({ id: artist.id })
            .from(artist)
            .where(and(eq(artist.salonId, p.salonId), inArray(artist.id, wanted)));
          if (found.length !== wanted.length) {
            throw notFound('unknown_artist', 'One or more of those is not an artist at this salon.');
          }
        }

        const current = (await assignedArtistIds(tx, [locked.id])).get(locked.id) ?? [];
        const target = [...wanted].sort();
        const added = target.filter((x) => !current.includes(x));
        const removed = current.filter((x) => !target.includes(x));
        if (added.length === 0 && removed.length === 0) return locked;
        if (removed.length > 0) {
          await tx
            .delete(artistService)
            .where(
              and(eq(artistService.serviceId, locked.id), inArray(artistService.artistId, removed)),
            );
        }
        if (added.length > 0) {
          await tx
            .insert(artistService)
            .values(added.map((artistId) => ({ artistId, serviceId: locked.id, salonId: p.salonId })))
            .onConflictDoNothing();
        }

        const names = await tx
          .select({ id: artist.id, name: artist.name })
          .from(artist)
          .where(and(eq(artist.salonId, p.salonId), inArray(artist.id, [...added, ...removed])))
          .orderBy(asc(artist.name));
        const nameOf = (id: string) => names.find((n) => n.id === id)?.name ?? id;

        await writeAudit(tx, p, {
          salonId: p.salonId,
          // `rules`, as `PUT /artists/{id}/branch` is: it decides where a
          // booking may land, and grants nobody any authority.
          kind: 'rules',
          action: 'Service staff changed',
          detail:
            `${locked.name}: ` +
            [
              added.length ? `+ ${added.map(nameOf).join(', ')}` : '',
              removed.length ? `− ${removed.map(nameOf).join(', ')}` : '',
            ]
              .filter(Boolean)
              .join(' · ') +
            (target.length === 0 ? ' · nobody can be booked for it now' : ''),
          source: 'merchant',
          subjectType: 'service',
          subjectId: locked.id,
          metadata: { before: current, after: target, added, removed },
          ...clientMeta(req),
        });
        return locked;
      });

      // After the commit, not inside it — `PUT /artists/{id}/branch` § THE
      // RESPONSE IS BUILT … AND SENT AFTER IT COMMITS, for the stale-read reason.
      const [view] = await serialiseServices(db, p.salonId, [svc]);
      return reply.send(view);
    },
  );
}
