/**
 * Salon reads and edits. Four of the nine permission gates live here.
 *
 *   GET   /salons/{id}/metrics   perms.dashboard
 *   GET   /salons/{id}/products  perms.shop
 *   GET   /salons/{id}/bookings  perms.appointments
 *   PATCH /salons/{id}           perms.loyalty
 *
 * PATCH is the one that matters most. The loyalty editor writes through it, and
 * build-plan.md calls a half-published tier ladder a money bug — a member who
 * tops up between two writes gets a bonus from a ladder that does not exist yet.
 * The ladder is one jsonb column precisely so a publish is a single row update
 * and cannot half-write; the gate here is what stops someone without loyalty
 * authority reaching it at all.
 *
 * `GET /salons/{id}` itself is not gated: the customer wallet renders the salon
 * name, brand colour, business hours and social links, so it is readable by any
 * authenticated principal of that salon and serialised without anything
 * merchant-only in it.
 */

import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { db } from '../db/client';
import { artist } from '../db/schema/artist';
import { booking } from '../db/schema/booking';
import { member } from '../db/schema/member';
import { branch, salon } from '../db/schema/salon';
import { service } from '../db/schema/service';
import { staffUser } from '../db/schema/staff';
import { requireDashboardPerm, requirePrincipal, requireSameSalon } from '../auth/principal';
import { badRequest, conflict, notFound } from '../http/errors';
import { parseAmountFils, requireString } from '../money/validate';
import { writeAudit } from '../services/audit';
import { branchClosureImpact } from '../services/branchClosure';
import { parseLoyaltyConfig } from '../services/loyaltyRules';
import { serialiseBooking, type BookingRow } from '../services/booking';
import { computeMetrics, parsePeriod } from '../services/metrics';
import { parseTimeZone } from '../time/zone';
import { loyaltyConfigOf } from './loyalty';

/** api-contract.md § Booking — the four statuses, and the merchant's status pills. */
const BOOKING_STATUSES = ['deposit_held', 'completed', 'no_show_returned', 'cancelled'] as const;

/** Fields a merchant may edit. Anything else in the body is refused, not ignored. */
const EDITABLE = new Set([
  'name',
  /**
   * `{ booking, shop }` — the shape `GET /salons/{id}` serves and the shape
   * api-contract.md § Salon defines. Stored as two boolean columns, so this is
   * the one editable field whose wire name is not its column name; the split
   * happens in `applyModules` below.
   *
   * The COLUMN spellings (`moduleBooking` / `moduleShop`) are deliberately NOT
   * accepted. Two doors into one field is how the tier ladder acquired an
   * unvalidated second entrance, and a client that can spell a field two ways
   * will eventually spell it both ways in one request. Lane C reads `modules`
   * from the GET; it writes the same word back.
   */
  'modules',
  // `name` and `stampReward` are editable, so their Arabic twins are too. A
  // field the API serves but nothing can ever set is the same half-implemented
  // state this change exists to close: it would leave the Arabic name settable
  // only by a hand-written UPDATE.
  'nameAr',
  'brandColor',
  'loyaltyMode',
  'tiers',
  'stampTarget',
  'stampReward',
  'stampRewardAr',
  'depositFils',
  'noShowReturnMinutes',
  /**
   * Editable, and validated as an IANA id rather than stored verbatim.
   *
   * It decides what "10:00" means for business hours, artist windows and every
   * happy-hour window, so an unvalidated string here would not fail loudly — it
   * would make `Intl.DateTimeFormat` throw inside a charge, three screens away
   * from the field that was typed wrong. See `parseTimeZone`.
   */
  'timezone',
  'businessHours',
  'social',
  'whatsappEnabled',
]);

/**
 * The nullable Arabic columns, and the only fields on this route where an empty
 * string is not a value.
 *
 * `'' ?? name` is `''` — a blank Arabic name defeats the client's fallback and
 * paints an empty heading, which is why the CHECK constraint refuses it. Coerced
 * here rather than 400'd because clearing a translation is a legitimate thing to
 * want, and "" is how an emptied text input arrives. Without this, clearing the
 * field would surface as a constraint violation, i.e. a 500 on a valid intent.
 */
const NULLABLE_ARABIC = new Set(['nameAr', 'stampRewardAr']);

/**
 * The fields that describe what a visit and a top-up are worth. Touching any of
 * them sends the whole loyalty configuration through the publish validator —
 * see the block comment in the PATCH handler.
 */
const LOYALTY_FIELDS = new Set([
  'loyaltyMode',
  'tiers',
  'stampTarget',
  'stampReward',
  'stampRewardAr',
]);

function normaliseArabic(key: string, value: unknown): unknown {
  if (!NULLABLE_ARABIC.has(key)) return value;
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw badRequest('invalid_request', `${key} must be a string or null.`);
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * THE NUMERIC FIELDS, REFUSED AT THE DOOR RATHER THAN AT THE COLUMN.
 *
 * `depositFils: 5500.5` used to go into the patch object exactly as it arrived.
 * Postgres refused it on the bigint column — the money was never at risk, and
 * non-negotiable #1 held — but the refusal reached the merchant as
 * `server_error`, "Something went wrong on our side". She cannot tell a typed
 * "5.5" from an outage, and the API logged an unhandled error every time
 * somebody mistyped a number.
 *
 * This is the same treatment `timezone` already had, and for the reason its
 * comment gives: a validated field fails with a sentence naming the field, an
 * unvalidated one fails somewhere else as somebody else's problem.
 *
 * The RANGE is checked here as well as by `salon_deposit_in_range`, so 500 fils
 * is a sentence about the range instead of a constraint-violation 500. Both
 * still exist: the CHECK is the guarantee, this is the explanation.
 */
const DEPOSIT_MIN_FILS = 1_000;
const DEPOSIT_MAX_FILS = 10_000;

function parseDepositFils(value: unknown): number {
  const n = parseAmountFils(value, 'depositFils');
  if (n < DEPOSIT_MIN_FILS || n > DEPOSIT_MAX_FILS) {
    throw badRequest(
      'deposit_out_of_range',
      `The booking deposit has to be between ${DEPOSIT_MIN_FILS / 1000}.000 and ${DEPOSIT_MAX_FILS / 1000}.000 KD.`,
    );
  }
  return n;
}

function parseNoShowReturnMinutes(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw badRequest(
      'invalid_no_show_window',
      'noShowReturnMinutes must be a whole number of minutes greater than zero.',
    );
  }
  return value;
}

/**
 * `modules: { booking, shop }` → the two boolean columns.
 *
 * A partial object is a partial update: `{ booking: true }` leaves Shop alone,
 * because the Settings screen has two independent switches and sending the pair
 * on every flip would let a stale render turn the other one off.
 */
function applyModules(value: unknown, patch: Record<string, unknown>): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw badRequest('invalid_request', 'modules must be an object like { booking, shop }.');
  }
  const incoming = value as Record<string, unknown>;
  for (const key of Object.keys(incoming)) {
    if (key !== 'booking' && key !== 'shop') {
      throw badRequest('unknown_module', `Unknown module: ${key}. The modules are booking and shop.`);
    }
  }
  for (const [key, column] of [
    ['booking', 'moduleBooking'],
    ['shop', 'moduleShop'],
  ] as const) {
    if (key in incoming) {
      if (typeof incoming[key] !== 'boolean') {
        throw badRequest('invalid_request', `modules.${key} must be true or false.`);
      }
      patch[column] = incoming[key];
    }
  }
}

/**
 * THE Salon WIRE SHAPE — one function, so a read and a write cannot disagree.
 *
 * This existed only inside the GET handler, and `PATCH` answered
 * `reply.send(after)` — the raw Drizzle row, carrying `moduleBooking` and
 * `moduleShop` instead of `modules`, and no `branches` at all. Lane C cached
 * that response as the new salon, which is what any reasonable client does with
 * a 200 from a write, and every consumer of `salon.branches` got `undefined` on
 * the next render. It took the whole Settings section to its error boundary.
 * The workaround — stop caching the write, re-GET — works and means the write
 * endpoint is telling the truth to nobody.
 *
 * `branches` carries only OPEN branches: a closed one is history, and every
 * client renders this list as the places a customer can be sent to.
 */
function serialiseSalon(
  s: typeof salon.$inferSelect,
  branches: Array<typeof branch.$inferSelect>,
) {
  return {
    id: s.id,
    name: s.name,
    // Emitted whether or not it is set, and emitted as JSON `null` when it is
    // not. An OMITTED key and a null are the same thing to `??`, which is
    // exactly why the missing implementation went unnoticed — so the absent
    // case is now a value the client can actually see and a spec can actually
    // assert on. What must never reach a client is the STRING "null".
    nameAr: s.nameAr,
    plan: s.plan,
    brandColor: s.brandColor,
    modules: { booking: s.moduleBooking, shop: s.moduleShop },
    loyaltyMode: s.loyaltyMode,
    tiers: s.tiers,
    stampTarget: s.stampTarget,
    stampReward: s.stampReward,
    stampRewardAr: s.stampRewardAr,
    depositFils: s.depositFils,
    noShowReturnMinutes: s.noShowReturnMinutes,
    /**
     * Emitted to every surface, not just the dashboard. `businessHours` right
     * below it is naive wall clock and means nothing without this — a wallet
     * that renders "Open until 21:00" is rendering a string in a zone it was
     * never told. The clients also need it to resolve `isHappyHourLive`
     * themselves, every second, which is the whole point of there being no
     * `live` flag.
     */
    timezone: s.timezone,
    businessHours: s.businessHours,
    branches: branches.map(serialiseBranch),
    social: s.social,
    whatsappEnabled: s.whatsappEnabled,
  };
}

/** api-contract.md § Branch. `nameAr` for the reason db/schema/salon.ts gives. */
function serialiseBranch(b: typeof branch.$inferSelect) {
  return { id: b.id, salonId: b.salonId, name: b.name, nameAr: b.nameAr };
}

/** The open branches of a salon, in a stable order. */
function openBranchesOf(salonId: string) {
  return db
    .select()
    .from(branch)
    .where(and(eq(branch.salonId, salonId), isNull(branch.closedAt)))
    .orderBy(branch.id);
}

/** Read the salon or 404. Used by every handler in this file that writes one. */
async function loadSalon(id: string): Promise<typeof salon.$inferSelect> {
  const rows = await db.select().from(salon).where(eq(salon.id, id)).limit(1);
  const s = rows[0];
  if (!s) throw notFound('unknown_salon', 'No such salon.');
  return s;
}

/**
 * A branch of THIS salon, open or closed, or a 404.
 *
 * Scoped to the salon in the same predicate rather than fetched by id and
 * checked afterwards — the same rule `POST /scans` learned the hard way. A
 * branch of another tenant is `unknown_branch`, identical to one that does not
 * exist, because a distinguishable 403 would confirm the id names something
 * real somewhere else.
 */
async function loadBranch(salonId: string, id: string): Promise<typeof branch.$inferSelect> {
  const rows = await db
    .select()
    .from(branch)
    .where(and(eq(branch.id, id), eq(branch.salonId, salonId)))
    .limit(1);
  const b = rows[0];
  if (!b) throw notFound('unknown_branch', 'No such branch.');
  return b;
}

function branchId(): string {
  return `BR-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

/** The two audit columns every handler in this file fills the same way. */
function clientMeta(req: FastifyRequest): { ipAddress: string | null; userAgent: string | null } {
  return {
    ipAddress: req.ip ?? null,
    userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
  };
}

export async function registerSalonRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string } }>('/salons/:id', async (req, reply) => {
    const p = requirePrincipal(req);
    requireSameSalon(p, req.params.id);

    const s = await loadSalon(req.params.id);
    return reply.send(serialiseSalon(s, await openBranchesOf(s.id)));
  });

  /** perms.loyalty — the loyalty editor writes through here. */
  app.patch<{ Params: { id: string } }>('/salons/:id', async (req, reply) => {
    const p = requireDashboardPerm(req, 'loyalty');
    requireSameSalon(p, req.params.id);

    const body = (req.body ?? {}) as Record<string, unknown>;
    const keys = Object.keys(body);
    if (keys.length === 0) throw badRequest('invalid_request', 'Nothing to change.');

    const rejected = keys.filter((k) => !EDITABLE.has(k));
    if (rejected.length > 0) {
      throw badRequest('not_editable', `These fields cannot be edited here: ${rejected.join(', ')}.`);
    }

    const before = await loadSalon(req.params.id);

    const patch: Record<string, unknown> = { updatedAt: new Date() };
    for (const k of keys) patch[k] = normaliseArabic(k, body[k]);

    // Refused here, before the UPDATE, so a typo is a 400 naming the tz database
    // rather than a 500 thrown out of `Intl.DateTimeFormat` inside the next
    // charge that tries to resolve a happy hour.
    if ('timezone' in body) patch.timezone = parseTimeZone(body.timezone);

    // Every remaining field whose wire type is not its column type, or whose
    // range the database states as a CHECK. See the helpers at the top.
    if ('depositFils' in body) patch.depositFils = parseDepositFils(body.depositFils);
    if ('noShowReturnMinutes' in body) {
      patch.noShowReturnMinutes = parseNoShowReturnMinutes(body.noShowReturnMinutes);
    }
    if ('modules' in body) {
      // `modules` is a wire shape, not a column. Remove it before the UPDATE or
      // Drizzle would try to set a column that does not exist.
      delete patch.modules;
      applyModules(body.modules, patch);
    }

    /**
     * THE SECOND DOOR INTO THE TIER LADDER, AND WHY IT IS VALIDATED HERE TOO.
     *
     * `tiers`, `loyaltyMode`, `stampTarget` and the stamp reward copy have been
     * in `EDITABLE` since this route was written, and until now nothing checked
     * them. Every rule the publish endpoint enforces — four rungs, Bronze locked
     * at 0/0, each threshold above the one below — could be walked around by
     * sending the same fields one route over, which makes the validation
     * decorative: an invalid ladder published through the unguarded door is not
     * a smaller money bug than one published through the guarded one.
     *
     * So the loyalty fields go through the SAME validator
     * (services/loyaltyRules.ts), and the result replaces them wholesale rather
     * than being merged key by key. The validator returns a COMPLETE
     * configuration — it fills in whatever the request did not mention from the
     * current row — which is what keeps `salon_loyalty_config_complete`
     * satisfiable when a caller flips `loyaltyMode` and nothing else.
     *
     * `PUT /salons/{id}/loyalty` remains the endpoint the editor should use: it
     * returns the preview and writes the "Tier rules published" audit line. This
     * is the guard on the general-purpose door, not a second front entrance.
     */
    const touchesLoyalty = keys.some((k) => LOYALTY_FIELDS.has(k));
    if (touchesLoyalty) {
      const config = parseLoyaltyConfig(body, loyaltyConfigOf(before));
      patch.loyaltyMode = config.mode;
      patch.tiers = config.tiers;
      patch.stampTarget = config.stampTarget;
      patch.stampReward = config.stampReward;
      patch.stampRewardAr = config.stampRewardAr;
    }

    const [after] = await db
      .update(salon)
      .set(patch)
      .where(eq(salon.id, req.params.id))
      .returning();
    if (!after) throw notFound('unknown_salon', 'No such salon.');

    await writeAudit(db, p, {
      salonId: p.salonId,
      kind: 'rules',
      action: 'Salon settings changed',
      detail: `Changed: ${keys.join(', ')}`,
      source: 'merchant',
      subjectType: 'salon',
      subjectId: req.params.id,
      metadata: { changed: keys },
      ipAddress: req.ip ?? null,
      userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
    });

    // The SAME shape `GET` answers. See `serialiseSalon`.
    return reply.send(serialiseSalon(after, await openBranchesOf(after.id)));
  });

  // ========================================================================
  // BRANCHES — the write path phase 4 was missing.
  //
  // THE PERMISSION IS `loyalty`, and it is worth saying why rather than
  // leaving it to look arbitrary. Branches are a Settings concern, and
  // `PATCH /salons/{id}` — the Settings write these three sit beside — is
  // already gated on `perms.loyalty`. The nine permissions in
  // api-contract.md § StaffUser have no "settings" among them, so a new gate
  // would have to be invented, and inventing a tenth permission is a contract
  // change this lane may not make. Gating the branch routes on anything
  // WEAKER than the screen they live on would be the real defect: it would let
  // a staff member who cannot change the deposit restructure the salon.
  // Reported to trunk as a contract observation.
  // ========================================================================

  /** perms.loyalty. A salon opens a second location. */
  app.post<{ Params: { id: string } }>('/salons/:id/branches', async (req, reply) => {
    const p = requireDashboardPerm(req, 'loyalty');
    requireSameSalon(p, req.params.id);
    await loadSalon(req.params.id);

    const body = (req.body ?? {}) as Record<string, unknown>;
    const rejected = Object.keys(body).filter((k) => k !== 'name' && k !== 'nameAr');
    if (rejected.length > 0) {
      throw badRequest(
        'not_editable',
        `These fields cannot be set on a branch: ${rejected.join(', ')}.`,
      );
    }

    const name = requireString(body.name, 'name', 120);
    const nameAr = normaliseArabic('nameAr', body.nameAr) as string | null;

    // `branch_salon_name_uq` spans CLOSED branches too, so this catches the
    // re-opening case as well as the duplicate one. Asked here so the merchant
    // gets a sentence naming the alternative, rather than a 23505 as a 500.
    const clash = await db
      .select({ id: branch.id, closedAt: branch.closedAt })
      .from(branch)
      .where(and(eq(branch.salonId, req.params.id), eq(branch.name, name)))
      .limit(1);
    if (clash[0]) {
      throw conflict(
        'branch_name_taken',
        clash[0].closedAt
          ? `This salon already has a branch called "${name}" that is closed. Re-open that one instead, so its history stays attached to it.`
          : `This salon already has a branch called "${name}".`,
      );
    }

    const id = branchId();
    const [row] = await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(branch)
        .values({ id, salonId: req.params.id, name, nameAr })
        .returning();

      await writeAudit(tx, p, {
        salonId: p.salonId,
        kind: 'rules',
        action: 'Branch opened',
        detail: name,
        source: 'merchant',
        subjectType: 'branch',
        subjectId: id,
        metadata: { name, nameAr },
        ...clientMeta(req),
      });
      return inserted;
    });

    if (!row) throw conflict('branch_not_created', 'That branch could not be created.');
    return reply.code(201).send(serialiseBranch(row));
  });

  /** perms.loyalty. Rename a branch, in either language. */
  app.patch<{ Params: { id: string; bid: string } }>(
    '/salons/:id/branches/:bid',
    async (req, reply) => {
      const p = requireDashboardPerm(req, 'loyalty');
      requireSameSalon(p, req.params.id);

      const body = (req.body ?? {}) as Record<string, unknown>;
      const keys = Object.keys(body);
      if (keys.length === 0) throw badRequest('invalid_request', 'Nothing to change.');
      const rejected = keys.filter((k) => k !== 'name' && k !== 'nameAr');
      if (rejected.length > 0) {
        throw badRequest(
          'not_editable',
          `These fields cannot be edited on a branch: ${rejected.join(', ')}.`,
        );
      }

      const current = await loadBranch(req.params.id, req.params.bid);

      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if ('name' in body) patch.name = requireString(body.name, 'name', 120);
      if ('nameAr' in body) patch.nameAr = normaliseArabic('nameAr', body.nameAr);

      if (typeof patch.name === 'string' && patch.name !== current.name) {
        const clash = await db
          .select({ id: branch.id })
          .from(branch)
          .where(and(eq(branch.salonId, req.params.id), eq(branch.name, patch.name)))
          .limit(1);
        if (clash[0]) {
          throw conflict(
            'branch_name_taken',
            `This salon already has a branch called "${patch.name as string}".`,
          );
        }
      }

      const [row] = await db.transaction(async (tx) => {
        const updated = await tx
          .update(branch)
          .set(patch)
          .where(eq(branch.id, current.id))
          .returning();

        await writeAudit(tx, p, {
          salonId: p.salonId,
          kind: 'rules',
          action: 'Branch renamed',
          detail: `${current.name} → ${(patch.name as string | undefined) ?? current.name}`,
          source: 'merchant',
          subjectType: 'branch',
          subjectId: current.id,
          metadata: { before: serialiseBranch(current), changed: keys },
          ...clientMeta(req),
        });
        return updated;
      });

      if (!row) throw notFound('unknown_branch', 'No such branch.');
      return reply.send(serialiseBranch(row));
    },
  );

  /**
   * perms.loyalty. CLOSE a branch. It is not deleted, and this is the cascade
   * the API owns rather than leaving to a foreign key.
   *
   * WHY A CLOSE. `transaction.branch_id` and `booking.branch_id` are both NOT
   * NULL and `ON DELETE restrict`. A real DELETE of a branch that has ever
   * taken money is refused by the database and arrives at the merchant as a
   * 500 — and the refusal is correct, because per-branch revenue, a customer's
   * receipt and an appointment history all name the branch. Same rule the
   * happy-hour delete already states: the receipts refer to it, switch it off.
   *
   * THE THREE THINGS THAT REFERENCE A BRANCH, AND WHAT HAPPENS TO EACH:
   *
   * 1. STAFF (`staff_user.branch_access_ids`). The id is REMOVED from every
   *    staff row in the salon, in this transaction, and each affected member is
   *    named in the audit row. A staff member scoped only to this branch is
   *    left with an EMPTY access list — she is not promoted to `all`.
   *    Widening authority as a side effect of closing a location is exactly
   *    the privilege escalation the permission model exists to prevent, and
   *    "revoking charges takes void with it" is the same instinct: when a
   *    change makes authority ambiguous, the safe direction is less.
   *    The owner re-scopes her from Accounts → Team, and the audit row tells
   *    her who needs it.
   *
   * 2. BOOKINGS. Left exactly as they are, and this is deliberate rather than
   *    lazy. A booking's `branch_id` comes from `resolveBranch`, which for a
   *    multi-branch salon is an ATTRIBUTION and is flagged `branch_assumed` as
   *    such — services/branch.ts is explicit that such a value must not drive
   *    a decision. Refusing to close a location because of appointments whose
   *    branch was GUESSED would be a refusal built on a number the codebase
   *    says is not knowledge. The count is reported and audited so the
   *    merchant knows what she still has to deal with, and each booking runs
   *    to its own end state; the deposit-return path is untouched by this and
   *    a no-show at a closed branch still returns the customer's money.
   *
   * 3. TRANSACTIONS. Untouched, still pointing at a branch that still exists
   *    and still has a name to render. That is the entire point of a close.
   *
   * The LAST OPEN BRANCH cannot be closed. `resolveBranch` refuses a salon with
   * none, so the next charge, top-up and booking would all fail with
   * `no_branch` — a total money outage produced by a settings change. Refused
   * here with a sentence instead of discovered at the counter.
   */
  // ------------------------------------------- the closure preview (read) ----
  /**
   * WHAT CLOSING THIS BRANCH WOULD DO — on `perms.loyalty`, the same permission as
   * the close itself.
   *
   * THE PERMISSION IS THE WHOLE POINT. The close returns `staffRescoped`,
   * `staffLeftWithNoBranch` and `depositHeldBookings`, but computed them inside the
   * transaction that performs it — so the facts a merchant needs BEFORE deciding
   * arrived only afterwards. With no preview, lane C had to derive them client-side
   * from the roster and the appointment list, and those reads need `perms.team` and
   * `perms.appointments`: a `loyalty`-only account could close a branch it was not
   * allowed to be warned about. Lane C degraded the warning to categories without
   * counts rather than invent numbers, which was right, and is a mitigation.
   *
   * Gating this on `loyalty` means no second permission stands between a destructive
   * button and its own consequences. Whoever may close a branch may be told what
   * closing it does.
   *
   * A SEPARATE READ rather than `?dryRun` on the DELETE: it is cacheable, it cannot
   * be fired by accident, and a destructive verb that sometimes does nothing is a
   * request whose effect depends on a query parameter nobody sees in a log.
   *
   * `closable` IS INCLUDED because the close can be refused outright — a salon with
   * no open branch cannot take a payment, a top-up or a booking, so the last one is
   * protected. A merchant should learn that here rather than from an error after she
   * has decided.
   *
   * The numbers come from the same `branchClosureImpact` the close uses. Field names
   * match the close's response exactly, so the preview and the outcome are
   * comparable rather than merely similar.
   */
  app.get<{ Params: { id: string; bid: string } }>(
    '/salons/:id/branches/:bid/closure-preview',
    async (req, reply) => {
      const p = requireDashboardPerm(req, 'loyalty');
      requireSameSalon(p, req.params.id);

      const current = await loadBranch(req.params.id, req.params.bid);
      const open = await openBranchesOf(req.params.id);
      const impact = await branchClosureImpact(db, req.params.id, current.id);

      const alreadyClosed = current.closedAt !== null;
      const lastOpen = !alreadyClosed && open.length <= 1;

      return reply.send({
        ...serialiseBranch(current),
        /** Whether the DELETE would go through, and why not when it would not. */
        closable: !alreadyClosed && !lastOpen,
        blockedReason: alreadyClosed
          ? 'already_closed'
          : lastOpen
            ? 'last_open_branch'
            : null,
        openBranchCount: open.length,
        // The same three the close reports, in the same shape — names, not ids,
        // because this is what a merchant reads on a confirmation sheet.
        staffRescoped: impact.staffRescoped.map((x) => x.name),
        staffLeftWithNoBranch: impact.staffRescoped
          .filter((x) => x.remaining === 0)
          .map((x) => x.name),
        depositHeldBookings: impact.depositHeldBookings,
        depositHeldBookingsBranchAssumed: impact.depositHeldBookingsBranchAssumed,
      });
    },
  );

  app.delete<{ Params: { id: string; bid: string } }>(
    '/salons/:id/branches/:bid',
    async (req, reply) => {
      const p = requireDashboardPerm(req, 'loyalty');
      requireSameSalon(p, req.params.id);

      const current = await loadBranch(req.params.id, req.params.bid);

      // Idempotent: closing a closed branch is not an error, and must not write
      // a second audit row claiming it happened twice.
      if (current.closedAt) return reply.send(serialiseBranch(current));

      const open = await openBranchesOf(req.params.id);
      if (open.length <= 1) {
        throw conflict(
          'last_open_branch',
          'This is the salon\'s only open branch. A salon with no open branch cannot take a payment, a top-up or a booking — open the new location first, then close this one.',
        );
      }

      /**
       * Through the SHARED calculation, so the preview and the close cannot
       * disagree about money already taken from customers. This used to be its own
       * inline count; `services/branchClosure.ts` explains why one implementation
       * matters here specifically.
       */
      const impact = await branchClosureImpact(db, req.params.id, current.id);
      const heldCount = impact.depositHeldBookings;
      const heldAssumed = impact.depositHeldBookingsBranchAssumed;

      const closedAt = new Date();
      const { row, rescoped, stranded } = await db.transaction(async (tx) => {
        const updated = await tx
          .update(branch)
          .set({ closedAt, updatedAt: closedAt })
          .where(eq(branch.id, current.id))
          .returning();

        // Every staff row in the salon that names this branch. `array_remove`
        // does it in one statement so there is no read-modify-write to race,
        // and `RETURNING` names who was affected for the audit row.
        // `array_remove` in ONE statement, so there is no read-modify-write for
        // a concurrent permission change to race, and `RETURNING` names who was
        // affected without a second query that could see a different world.
        //
        // Through the query builder rather than a raw `sql` template: the
        // template binds `closedAt` as a Date straight to postgres.js, which
        // refuses it, while the builder maps it through the column's own
        // `timestamptz` codec.
        const affected = await tx
          .update(staffUser)
          .set({
            branchAccessIds: sql`array_remove(${staffUser.branchAccessIds}, ${current.id})`,
            updatedAt: closedAt,
          })
          .where(
            and(
              eq(staffUser.salonId, req.params.id),
              sql`${current.id} = ANY(${staffUser.branchAccessIds})`,
            ),
          )
          .returning({
            id: staffUser.id,
            name: staffUser.name,
            branchAccessIds: staffUser.branchAccessIds,
          });

        // `branch_access_all` staff are untouched by the UPDATE above — their id
        // list is empty by the `staff_user_branch_access_exclusive` CHECK, so
        // `= ANY(…)` never matches them. An empty list here can therefore only
        // mean a member who was scoped to branches and now has none.
        const strandedRows = affected.filter((s) => s.branchAccessIds.length === 0);

        await writeAudit(tx, p, {
          salonId: p.salonId,
          kind: 'rules',
          action: 'Branch closed',
          detail:
            `${current.name} closed` +
            (affected.length ? ` · ${affected.length} staff re-scoped` : '') +
            (strandedRows.length
              ? ` · ${strandedRows.map((s) => s.name).join(', ')} ${strandedRows.length === 1 ? 'now has' : 'now have'} no branch access`
              : '') +
            (heldCount ? ` · ${heldCount} appointment(s) still hold a deposit here` : ''),
          source: 'merchant',
          subjectType: 'branch',
          subjectId: current.id,
          metadata: {
            branch: serialiseBranch(current),
            staffRescoped: affected.map((s) => ({
              id: s.id,
              name: s.name,
              remaining: s.branchAccessIds.length,
            })),
            staffLeftWithNoBranch: strandedRows.map((s) => s.id),
            depositHeldBookings: heldCount,
            depositHeldBookingsBranchAssumed: heldAssumed,
          },
          ...clientMeta(req),
        });

        return { row: updated[0], rescoped: affected, stranded: strandedRows };
      });

      if (!row) throw notFound('unknown_branch', 'No such branch.');

      /**
       * 200 with a body, not 204. A close is an UPDATE — the merchant's screen
       * wants the row back to re-render it as closed, and `closedAt` is the
       * fact she just created. A 204 would make the client re-read to find out
       * what its own request did, which is the defect `PATCH /salons/{id}` had.
       */
      return reply.send({
        ...serialiseBranch(row),
        closedAt: row.closedAt?.toISOString() ?? null,
        /**
         * What the close actually touched — read from the UPDATE's own
         * RETURNING, not re-queried afterwards, so it describes this close and
         * not the salon's general state. The Settings screen says it out loud
         * rather than leaving the merchant to find it in the audit log: both
         * are consequences she cannot see from the branch list she was looking
         * at, and `staffLeftWithNoBranch` is the one that needs her attention.
         */
        staffRescoped: rescoped.map((s) => s.name),
        staffLeftWithNoBranch: stranded.map((s) => s.name),
        depositHeldBookings: heldCount,
        /**
         * How many of those had their branch INFERRED rather than recorded. Lane C's
         * point, and it is about money: an artist has no branch column, so a warning
         * about deposits already taken must not read as a fact where part of it is a
         * guess. Reported by the preview and by the close, identically.
         */
        depositHeldBookingsBranchAssumed: heldAssumed,
      });
    },
  );

  /**
   * perms.dashboard. Overview's four stat tiles, computed rather than stubbed.
   *
   * Every definition — what "active" counts, what "today" means, why a repeat
   * visit is a charge and not a transaction — lives in services/metrics.ts next
   * to the query that implements it. A metric's failure mode is not a crash, it
   * is a merchant deciding on a number that means something other than what she
   * thinks, so the definitions sit where they cannot drift from the SQL.
   */
  app.get<{ Params: { id: string }; Querystring: { period?: string } }>(
    '/salons/:id/metrics',
    async (req, reply) => {
      const p = requireDashboardPerm(req, 'dashboard');
      requireSameSalon(p, req.params.id);

      const period = parsePeriod(req.query?.period);

      const rows = await db
        .select({ id: salon.id, timezone: salon.timezone })
        .from(salon)
        .where(eq(salon.id, req.params.id))
        .limit(1);
      const s = rows[0];
      if (!s) throw notFound('unknown_salon', 'No such salon.');

      // The salon's zone, not the process zone: "loaded today" has to roll over
      // at the salon's midnight, or the last three hours of every evening's
      // takings land on yesterday's tile. See services/metrics.ts.
      return reply.send(await computeMetrics(db, s, period));
    },
  );

  /** perms.shop */
  app.get<{ Params: { id: string } }>('/salons/:id/products', async (req, reply) => {
    const p = requireDashboardPerm(req, 'shop');
    requireSameSalon(p, req.params.id);
    return reply.send({ items: [], nextCursor: null });
  });

  /**
   * perms.appointments — the Merchant → Appointments screen.
   *
   * This route existed as an empty list so the ninth permission had a real
   * server-side gate rather than an unguarded 404 that looks like a gate and is
   * not. It now returns actual bookings.
   *
   * `?status=` takes the contract's four, comma-separated — the status pills the
   * design draws, "Deposit held / Completed / No-show · returned". Unknown values
   * are refused BY NAME rather than silently ignored: a dashboard filtering on a
   * typo would render an empty Appointments screen, and the merchant would read
   * that as "no bookings today", which is the worst possible answer to give a
   * salon about its own day.
   *
   * The customer's name, tier and phone are joined in, which the design asks for
   * and which `perms.appointments` is the gate for. `branchAssumed` comes out
   * too, for the reason it does on a transaction: a per-branch appointment count
   * that rests on a guess should be filterable rather than indistinguishable from
   * one that does not.
   */
  app.get<{ Params: { id: string }; Querystring: { status?: string } }>(
    '/salons/:id/bookings',
    async (req, reply) => {
      const p = requireDashboardPerm(req, 'appointments');
      requireSameSalon(p, req.params.id);

      const raw = req.query?.status;
      const wanted =
        typeof raw === 'string' && raw.trim() !== ''
          ? raw.split(',').map((s) => s.trim()).filter(Boolean)
          : null;
      if (wanted) {
        const unknown = wanted.filter((s) => !(BOOKING_STATUSES as readonly string[]).includes(s));
        if (unknown.length > 0) {
          throw badRequest(
            'invalid_status',
            `Unknown booking status: ${unknown.join(', ')}. One of ${BOOKING_STATUSES.join(', ')}.`,
          );
        }
      }

      const rows = await db
        .select({
          b: booking,
          memberName: member.name,
          memberPhone: member.phone,
          memberTier: member.tier,
          artistName: artist.name,
          serviceName: service.name,
        })
        .from(booking)
        .innerJoin(member, eq(member.id, booking.memberId))
        .innerJoin(artist, eq(artist.id, booking.artistId))
        .innerJoin(service, eq(service.id, booking.serviceId))
        .where(
          wanted
            ? and(
                eq(booking.salonId, req.params.id),
                inArray(booking.status, wanted as Array<BookingRow['status']>),
              )
            : eq(booking.salonId, req.params.id),
        )
        .orderBy(desc(booking.startsAt))
        .limit(200);

      return reply.send({
        items: rows.map((r) => ({
          ...serialiseBooking(r.b as BookingRow),
          branchAssumed: r.b.branchAssumed,
          memberName: r.memberName,
          memberPhone: r.memberPhone,
          memberTier: r.memberTier,
          artistName: r.artistName,
          serviceName: r.serviceName,
        })),
        nextCursor: null,
      });
    },
  );

  /**
   * The service list. Readable by anyone who may scan — and, since the Book
   * flow, by the customer choosing what she is booking.
   *
   * `ServiceSchema` IS THE SHAPE, ALL FIVE FIELDS. This route served
   * `{id, name, priceFils}` against a contract that also declares `salonId`,
   * `nameAr` and `active`, so the wallet's most Arabic-heavy screen rendered
   * Latin service names — `name_ar` did not exist until migration 0022, and the
   * two fields that did exist were simply never selected.
   *
   * `active` IS EMITTED AND THE LIST IS STILL FILTERED ON IT, which reads like a
   * contradiction and is not. The filter is a rule about money: a retired
   * service cannot be charged — services/charge.ts prices a basket from these
   * rows — so offering one would build a basket the charge handler then refuses
   * at the counter. The field is contract conformance: `ServiceSchema` declares
   * it non-optional, and a response omitting it fails `.parse()` in every client
   * that validates. It is `true` on every row here, and that is a true
   * statement rather than a placeholder.
   */
  app.get<{ Params: { id: string } }>('/salons/:id/services', async (req, reply) => {
    const p = requirePrincipal(req);
    requireSameSalon(p, req.params.id);
    const rows = await db
      .select({
        id: service.id,
        salonId: service.salonId,
        name: service.name,
        nameAr: service.nameAr,
        priceFils: service.priceFils,
        active: service.active,
      })
      .from(service)
      .where(and(eq(service.salonId, req.params.id), eq(service.active, true)));
    return reply.send({ items: rows, nextCursor: null });
  });
}
