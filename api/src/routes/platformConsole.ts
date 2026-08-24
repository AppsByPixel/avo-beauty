/**
 * The owner console's remaining sections — Analytics, Salons, Controls, Activity, Audit.
 *
 *   GET   /v1/platform/metrics    analytics   "How AVO is performing across every salon"
 *   GET   /v1/platform/salons     salons      every salon, as facts that exist
 *   POST  /v1/platform/salons     salons      the onboarding wizard's write
 *   GET   /v1/platform/salons/{id} salons      the per-salon editor's read
 *   PATCH /v1/platform/salons/{id} salons     the per-salon editor's write
 *   GET   /v1/platform/settings   controls    "Every platform switch, fee and default"
 *   PATCH /v1/platform/settings   controls
 *   GET   /v1/platform/activity   activity    the platform-wide live feed
 *   GET   /v1/platform/audit      audit       the platform-wide log
 *
 * Lane C has the console shell and Policies built and named these three as what
 * the remaining sections need. `apps/dashboard/src/auth/scopes.ts` records two of
 * them against "nowhere", which is what an endpoint the UI is waiting on looks
 * like from the other side.
 *
 * IN api-contract.md, both of them, under § Operations:
 *
 *   | Owner | Platform metrics  | `GET /platform/metrics`   |
 *   | Owner | Platform controls | `PATCH /platform/settings` |
 *
 * so the names are the contract's and are not invented here. `GET
 * /v1/platform/settings` is the read the contract omits and the screen obviously
 * needs — a PATCH-only resource would make the console guess its own current
 * state — and `GET /v1/platform/audit` is likewise implied by the drawn AUDIT
 * section and not written down. Both are reported as contract additions, the way
 * `PATCH /v1/platform/messaging-policy` and the four admin routes were. The `/v1`
 * prefix follows every other `/v1/platform/*` route rather than the contract's
 * prefix-less shorthand, which it also uses for `GET /salons/{id}/metrics`.
 *
 * EVERY HANDLER'S FIRST STATEMENT IS `requirePlatform(req, <section>)` —
 * non-negotiable #7. `requirePlatform` takes no default section precisely so a new
 * console endpoint cannot be ungated by accident, and each of these names the
 * section the design's own sidebar puts it behind.
 */

import { and, asc, desc, eq, getTableColumns, inArray, isNull, lt, sql, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { db } from '../db/client';
import { auditLog } from '../db/schema/audit';
import { loyaltyEvent } from '../db/schema/loyaltyEvent';
import { member } from '../db/schema/member';
import { transaction } from '../db/schema/transaction';
import { salon } from '../db/schema/salon';
import { platformSettings } from '../db/schema/platformSettings';
import { requirePlatform } from '../auth/principal';
import { badRequest, conflict, notFound } from '../http/errors';
import { writeAudit } from '../services/audit';
import {
  afterCursor,
  cursorInstant,
  mergePage,
  parseCursor,
  type Keyed,
} from '../services/streamCursor';
import {
  describeLoyalty,
  describeTransaction,
  FEED_KINDS,
  kd,
  parseFeedLimit,
  type FeedItem,
} from '../services/activityFeed';
import {
  auditSearchPredicate,
  auditTotal,
  parseAuditCursor,
  parseAuditKinds,
  parseAuditLimit,
  serialiseAuditRow,
} from '../services/auditRead';
import {
  awaitCommittedKey,
  hashRequestBody,
  principalScope,
  readIdempotencyKey,
  violatedConstraint,
} from '../services/idempotency';
import { computePlatformMetrics } from '../services/platformMetrics';
import { mintSalonId, onboardSalon, parseOnboardInput } from '../services/salonOnboarding';
import {
  buildSalonPatch,
  loadSalon,
  openBranchesOf,
  PLATFORM_EDITABLE,
  serialiseSalon,
} from './salons';
import {
  CARD_PERCENT_STEP_BP,
  FLAG_COLUMN,
  MAX_CARD_PERCENT_BP,
  MAX_KNET_FLAT_FILS,
  MAX_SALON_DEPOSIT_FILS,
  MIN_SALON_DEPOSIT_FILS,
  PLATFORM_FLAGS,
  PLATFORM_SETTINGS_ID,
  readPlatformSettings,
  serialisePlatformSettings,
  type PlatformFlag,
} from '../services/platformSettings';

/**
 * A whole number of fils from a request body, refused BY NAME.
 *
 * The CHECK constraints behind these columns would refuse a bad value anyway, and
 * that is the point of having both: the constraint is the guarantee and this is the
 * error message. Without it a console bug produces a 500 and a constraint name;
 * with it, a sentence naming the bound.
 */
function parseIntegerInRange(
  value: unknown,
  field: string,
  min: number,
  max: number,
): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw badRequest('invalid_amount', `${field} must be a whole number.`);
  }
  if (value < min || value > max) {
    throw badRequest('invalid_amount', `${field} must be between ${min} and ${max}.`);
  }
  return value;
}

/**
 * THIS FEED'S STREAMS, in the order a simultaneous group reads: the money
 * happened, then the tier it moved, then the record of it. `services/streamCursor.ts`
 * owns the mechanics and says why the rank is load-bearing rather than tidy.
 */
const STREAM_RANK = { transaction: 0, loyalty: 1, audit: 2 } as const;
const FEED_RANKS = Object.values(STREAM_RANK);

export async function registerPlatformConsoleRoutes(app: FastifyInstance): Promise<void> {
  // ====================================================================
  // ANALYTICS
  // ====================================================================
  /**
   * `GET /v1/platform/metrics` — the four KPI tiles, the eight-month bar chart and
   * the top-five salon list.
   *
   * NO `?period=`, deliberately, and `services/platformMetrics.ts` carries the
   * reasoning: every figure the design draws on this screen is a CALENDAR month
   * ("Loaded (Jul)", "+3 this month", "Last 8 months", "Top salons this month"), so
   * a rolling window would make the KPI and the bar beneath it disagree about what
   * July was while labelling both July. The merchant's Overview has a period
   * because api-contract.md gives that screen one.
   *
   * `analytics` is the section, which is the one an analyst has and support does
   * not — `PLATFORM_ROLE_PRESETS` gives `analyst` "read-only metrics" and `support`
   * "accounts & salons", from the design's own presets.
   */
  app.get('/v1/platform/metrics', async (req, reply) => {
    requirePlatform(req, 'analytics');
    return reply.send(await computePlatformMetrics(db));
  });

  // ====================================================================
  // THE SALON LIST — `GET /v1/platform/salons`
  // ====================================================================
  /**
   * Every salon on AVO, as facts that exist. The immediate consumer is Lane C's
   * Audit section, which shipped a `?salon=` filter with nothing to populate the
   * picker ("no platform salons-list endpoint — unblocks when the Salons section
   * lands"); the design's Salons section draws the fuller list.
   *
   * WHAT IS DELIBERATELY NOT HERE, because it does not exist and pretending is
   * how a console lies:
   *
   *   - NO `live` / `suspended` field. The design draws a Live toggle ("flip it
   *     off to instantly suspend it") and the schema has NO SUCH COLUMN — Lane C
   *     already found this and it is a reported design gap, not a field to fake
   *     with `true`.
   *   - `city` NOW EXISTS AND IS SERVED. This note used to read "NO `city`.
   *     `salon` has no city column" and refused to dress a branch name up as one,
   *     which was right — but the onboarding wizard's step 1 REQUIRES a city, so
   *     migration 0037 added the column rather than let the create endpoint drop
   *     a field the design insists on. It is nullable, and every salon that
   *     predates 0037 answers `null` here, which is the true statement about a
   *     row nobody supplied one for. `branchCount` stays: a salon's city and the
   *     number of places it has chairs were never the same fact.
   *
   * ======================= GATED `salons`, AND WHY IT MOVED =======================
   * IT WAS `analytics`, AND THAT WAS WRONG. I wrote the original gate and the
   * argument for it, so this correction is mine to record rather than to soften.
   *
   * The old reasoning: `/v1/platform/metrics` is gated `analytics` and already
   * serves a top-five salon list with names and money figures, so gating this
   * list the same way "widens nothing" and unblocks the Audit picker "for every
   * preset (each one holds `analytics`)".
   *
   * TWO FAULTS IN ONE PARAGRAPH.
   *
   *   - THE PARENTHESIS WAS SIMPLY FALSE. `PLATFORM_ROLE_PRESETS.support` is
   *     `{ analytics: false, salons: true }` — from the design's own preset copy,
   *     "Support — accounts & salons". So the role whose job is customers, and
   *     which explicitly HOLDS `salons`, could not list salons, while `analyst`
   *     (`analytics: true, salons: false`) read the whole tenant list fine. The
   *     gate and the section name pointed at different people. Lane C hit the
   *     403; trunk verified the preset table rather than taking the report.
   *   - AND THE ARGUMENT PROVED THE WRONG THING. "Metrics already reveals this,
   *     so `analytics` widens nothing" is a sound argument that `analytics` is
   *     ACCEPTABLE. It is not an argument that it is CORRECT. `salons` is what
   *     "may see the platform's salons" means, and it widens nothing either:
   *     owner, admin and support all hold it.
   *
   * WHAT THE MOVE COSTS: the analyst loses the tenant list and keeps metrics,
   * which already names its top five salons — so nothing it needs disappears. The
   * Audit picker's only consumers are owner and admin, both of whom hold `salons`,
   * so the unblock this endpoint was written for survives the regate.
   *
   * THE COMMENT IS THE POINT, not just the gate. A false premise stated
   * confidently in a header is how the mis-gating survived review, and trunk then
   * propagated the same sentence into another brief before checking it. Fourth
   * instance of the wrong-comment class in this build — the others being
   * `salon.brandColor`'s claimed `deriveBrandSet` validation, the
   * `PATCH /v1/platform/settings` body shape, and "CSV export has landed" as a
   * proxy for a gate condition. The lesson each time is the same one: a comment
   * that asserts a fact about another file has to be re-read against that file,
   * because the comment is what the next reader trusts instead of looking.
   *
   * The READ and the WRITE are now the same authority, which is the honest
   * outcome: `GET`, `POST` and `GET`/`PATCH /v1/platform/salons/{id}` all take
   * `salons`. Seeing the platform's salons and changing one are still different
   * ACTS — that half of the old comment was right — but they are not different
   * SECTIONS, because the design draws one sidebar entry for both and the presets
   * hand out one chip for it.
   *
   * MEMBER COUNT COUNTS TOMBSTONES, deliberately: an erased member's row still
   * exists so the books resolve, and "members" here is "wallets on the books",
   * the same number her transactions still roll up into. Excluding erased rows
   * would make this list disagree with the ledger by exactly the number of
   * erasures — a drift with a clock attached.
   *
   * Cursor pagination in the auditRead shape (limit+1, keyed by id) — two salons
   * today, but a list endpoint that only works while the table is small is a
   * regression waiting for success.
   */
  app.get<{ Querystring: { limit?: string; cursor?: string } }>(
    '/v1/platform/salons',
    async (req, reply) => {
      requirePlatform(req, 'salons');

      const rawLimit = req.query.limit === undefined ? 50 : Number(req.query.limit);
      if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 100) {
        throw badRequest('invalid_limit', 'limit must be an integer between 1 and 100.');
      }
      const cursor = req.query.cursor;
      if (cursor !== undefined && typeof cursor !== 'string') {
        throw badRequest('invalid_cursor', 'cursor must be a salon id from a previous page.');
      }

      const rows = (await db.execute(sql`
        SELECT s.id, s.name, s.name_ar, s.city, s.plan, s.loyalty_mode, s.created_at,
               (SELECT count(*)::int FROM branch b WHERE b.salon_id = s.id AND b.closed_at IS NULL) AS branches,
               (SELECT count(*)::int FROM member m WHERE m.salon_id = s.id) AS members
          FROM salon s
         ${cursor ? sql`WHERE s.id > ${cursor}` : sql``}
         ORDER BY s.id ASC
         LIMIT ${rawLimit + 1}
      `)) as unknown as Array<Record<string, unknown>>;

      const page = rows.slice(0, rawLimit);
      const hasMore = rows.length > rawLimit;

      return reply.send({
        items: page.map((r) => ({
          id: String(r.id),
          name: String(r.name),
          nameAr: r.name_ar === null || r.name_ar === undefined ? null : String(r.name_ar),
          city: r.city === null || r.city === undefined ? null : String(r.city),
          plan: String(r.plan),
          loyaltyMode: String(r.loyalty_mode),
          branchCount: Number(r.branches ?? 0),
          memberCount: Number(r.members ?? 0),
          createdAt: new Date(r.created_at as string | Date).toISOString(),
        })),
        nextCursor: hasMore ? String(page[page.length - 1]!.id) : null,
      });
    },
  );

  // ====================================================================
  // THE PER-SALON EDITOR — `GET` / `PATCH /v1/platform/salons/{id}`
  // ====================================================================
  /**
   * The screen `design/README.md` § Owner Console calls "list → per-salon editor:
   * modules, deposit, loyalty structure with tier thresholds/bonuses or stamp
   * target, branches".
   *
   * THE DEFECT THESE CLOSE: a guard pointing at a screen with no remedy. Lane C
   * drove all three doors and every one of them refused a platform admin —
   * `GET /salons/:id` 403 "Open it from the console's Salons section",
   * `PATCH /salons/:id` 403 "for salon staff", and `GET /v1/platform/salons/:id`
   * 404 because nothing was registered. So the merchant route's refusal named a
   * console section that could not do the thing it was named for, and nothing in
   * `api/src/routes` was gated on `salons` for a read at all. Lane C drew no
   * Manage button rather than ship a control that only 403s, which was right and
   * is also why this was invisible from the UI.
   *
   * A CONTRACT ADDITION, reported: `api-contract.md` names neither, the way it
   * named neither `POST /v1/platform/salons` nor the four admin routes.
   *
   * ============= THE FIELD SET IS THE MERCHANT'S, PLUS TWO =============
   * `PATCH /salons/{id}` has accepted modules, deposit and the whole loyalty
   * shape since it was written, so this route calls the SAME translator —
   * `buildSalonPatch` in `routes/salons.ts` — with `PLATFORM_EDITABLE` instead of
   * the merchant set. The only difference is two fields: `city` and `ownerPhone`,
   * which arrived with the wizard and had exactly one door until now, creation.
   *
   * That is a superset, not a parallel set, and the distinction is the one the
   * `modules` comment in that file draws: two spellings of one field is how the
   * tier ladder acquired an unvalidated second entrance, and the console's copy
   * would have been the one nobody was watching. Every guard the merchant door
   * has — `deriveBrandSet` on the hex, the deposit range, `parseTimeZone`,
   * `parseBusinessHours`, the four-rung ladder — applies here because it is
   * literally the same function.
   *
   * `plan` is in NEITHER set. It prices the account, the design puts per-salon
   * plan and fee in BILLING, and Billing has no API behind it. Reported.
   *
   * ============= WHY THERE IS AN ENVELOPE =============
   * `{ salon, ownerPhone }` rather than the salon shape with one more key on it.
   * `ownerPhone` is not part of `serialiseSalon` on purpose — `GET /salons/{id}`
   * is readable by any authenticated principal of the salon, members included, and
   * the owner's personal number is not a customer-facing fact. Putting it at the
   * top level of a Salon-shaped body would also mean a client parsing through
   * `SalonSchema` silently strips it, which is the argument
   * `POST /v1/platform/salons` makes for its own envelope.
   *
   * NOT KEYED FOR IDEMPOTENCY, and this is the `PATCH /v1/platform/settings`
   * reasoning rather than an omission: it sets fields to absolute values, so a
   * replay produces the same row. There is no second application to prevent. What
   * a retry can do is overwrite a concurrent edit, which is a lost update rather
   * than a double-spend — the same exposure the merchant's own PATCH has carried
   * since it was written, and the same one this note records there.
   */
  app.get<{ Params: { id: string } }>('/v1/platform/salons/:id', async (req, reply) => {
    requirePlatform(req, 'salons');

    const s = await loadSalon(req.params.id);
    return reply.send({
      salon: serialiseSalon(s, await openBranchesOf(s.id)),
      /** The owner contact. Console-only — see the header. */
      ownerPhone: s.ownerPhone,
    });
  });

  app.patch<{ Params: { id: string } }>('/v1/platform/salons/:id', async (req, reply) => {
    const p = requirePlatform(req, 'salons');

    const before = await loadSalon(req.params.id);
    const { patch, keys } = buildSalonPatch(
      (req.body ?? {}) as Record<string, unknown>,
      before,
      PLATFORM_EDITABLE,
    );

    const [after] = await db
      .update(salon)
      .set(patch)
      .where(eq(salon.id, req.params.id))
      .returning();
    if (!after) throw notFound('unknown_salon', 'No such salon.');

    /**
     * THE SAME `action` AS THE MERCHANT DOOR, and `source` is what separates
     * them. The design's audit log renders Who / What / Detail / Source as four
     * columns and filters on kind, so an AVO edit and a merchant edit of the same
     * field should read as the same ACT by different actors — inventing a second
     * action string would split one thing across two rows of a table somebody
     * scans for "who changed the deposit".
     *
     * `salonId` is the TARGET salon, not null. A platform admin has no salon of
     * her own, and an AVO action on a salon belongs in that salon's log —
     * `seed.ts` § the platform-actor rows argues this at length.
     */
    await writeAudit(db, p, {
      salonId: after.id,
      kind: 'rules',
      action: 'Salon settings changed',
      detail: `Changed by AVO: ${keys.join(', ')}`,
      source: 'owner_console',
      subjectType: 'salon',
      subjectId: after.id,
      metadata: { changed: keys },
      ipAddress: req.ip ?? null,
      userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
    });

    return reply.send({
      salon: serialiseSalon(after, await openBranchesOf(after.id)),
      ownerPhone: after.ownerPhone,
    });
  });

  // ====================================================================
  // ONBOARD A SALON — `POST /v1/platform/salons`
  // ====================================================================
  /**
   * The four-step wizard's write. `design/README.md:165`: Salons →
   * "+ Onboard a salon" → details & plan, modules & deposit, loyalty & brand
   * colour, review → "Create salon & send invite".
   *
   * THIS IS THE ENDPOINT THAT DID NOT EXIST. `DECISIONS.md` § "White-label
   * onboarding is a wizard" put it plainly: no `POST /salons`, no
   * `POST /v1/platform/salons`, `api-contract.md` names neither, so every salon
   * exists because `seed.ts` inserted it and onboarding a real client meant a
   * hand-written INSERT. `build-plan.md` Phase 7 lists "Salons with the
   * onboarding wizard"; this is its server half. A CONTRACT ADDITION, reported,
   * the way `PATCH /v1/platform/messaging-policy` and the four admin routes were.
   *
   * ================= THE GATE IS `salons`, NOT `analytics` =================
   * The GET above takes `analytics`, and its own comment says why that was the
   * right call for a READ while naming the boundary this endpoint is on the other
   * side of:
   *
   *     "The Salons MANAGEMENT screen — modules, deposit, the suspend that does
   *      not exist yet — is a different endpoint and takes `salons` when it is
   *      built; authority to SEE the platform's salons and authority to CHANGE
   *      one were never the same thing."
   *
   * CREATING one is management, and it is the strongest form of it: it mints a
   * tenant, an owner credential and an invite to a phone number. `analytics` is
   * the one section EVERY role preset holds, `analyst` included — and the design
   * describes an analyst as "read-only metrics". Gating creation there would hand
   * every analyst the ability to onboard a client. `salons` is held by owner,
   * admin and support, which matches the design's own preset copy for support
   * ("accounts & salons").
   *
   * `PLATFORM_SECTIONS` already carries `salons` and `platform_admin` already has
   * `perm_salons`, so nothing new was needed — no column, no `packages/types`
   * change. `requirePlatform` has no default section, so this is gated on purpose
   * rather than by omission.
   *
   * ================= WHY IT IS IDEMPOTENCY-KEYED =================
   * Non-negotiable #4's letter names "top-ups, charges, orders, voids" and this
   * is none of those. It is keyed on #4's REASON, and the argument is in
   * `services/salonOnboarding.ts`: there is no natural key (two clients can share
   * a name), the id is server-minted so a retry cannot be idempotent by id, and a
   * double submit does not merely duplicate a row — it sends the client two
   * sign-ins for two salons, one of them a ghost. `PATCH /v1/platform/settings`
   * one screen over is deliberately NOT keyed, and its comment gives the
   * distinction: it sets absolute values, so a replay produces the same row.
   *
   * The body is validated BEFORE the transaction opens, so a bad hex or a
   * malformed phone number costs no lock and burns no key.
   */
  app.post('/v1/platform/salons', async (req, reply) => {
    // FIRST. #7 — a tenant and a credential get created here.
    const p = requirePlatform(req, 'salons');
    // Then the key, before any work. #4's shape, `POST /orders` § the same line.
    const key = readIdempotencyKey(req);

    const body = (req.body ?? {}) as Record<string, unknown>;

    /**
     * The platform's own new-salon deposit default, read once. It has been
     * settable in Controls since 0032 and NOTHING HAS EVER READ IT — see
     * `parseDeposit` in the service. This is the join.
     */
    const settings = await readPlatformSettings(db);
    const input = parseOnboardInput(body, settings.newSalonDepositFils);

    const salonId = await mintSalonId(db, input.name);

    const idem = {
      scope: principalScope(p),
      endpoint: 'POST /v1/platform/salons',
      key,
      /**
       * THE VALIDATED INPUT, not the raw body — so two bodies that differ only in
       * `plan: 'Growth'` vs `'growth'`, or that rely on different defaults, hash
       * the same when they mean the same thing. `salonId` is NOT in the hash: it
       * is minted per attempt, so including it would make every retry a
       * "different body" 422 and defeat the whole mechanism.
       */
      requestHash: hashRequestBody(input),
    };

    try {
      const result = await onboardSalon(db, input, salonId, {
        principal: p,
        idempotency: idem,
        ipAddress: req.ip ?? null,
        userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
      });
      return reply.code(result.status).send(result.body);
    } catch (err) {
      /**
       * WHICH unique index fired, asked explicitly. `routes/orders.ts` does not
       * have to ask because its transaction can only violate one; this one can
       * violate three, and treating them alike is exactly the defect
       * `violatedConstraint` was written for — a void answered
       * "request_in_progress" for something permanent.
       *
       *   idempotency_key_*          a double submit. Replay the winner's 201.
       *   salon_pkey                 two admins onboarding same-named salons in
       *                              the same instant. The id probe is a
       *                              check-then-act and this is its backstop.
       *   staff_user_salon_handle_uq cannot happen — the salon is brand new, so
       *                              its handle space is empty — but it is named
       *                              here rather than swept into the replay path,
       *                              because the day a second staff row is created
       *                              on this path the honest answer is not "still
       *                              being processed".
       */
      const constraint = violatedConstraint(err);
      if (constraint === null) throw err;

      if (constraint === 'salon_pkey') {
        throw conflict(
          'salon_id_taken',
          'Another salon with that name was created a moment ago. Submit again.',
        );
      }
      if (constraint === 'staff_user_salon_handle_uq') {
        throw conflict('handle_taken', 'That owner handle is already in use at this salon.');
      }

      const stored = await awaitCommittedKey(db, idem);
      if (stored) return reply.code(stored.status).send(stored.body);

      throw conflict(
        'request_in_progress',
        'That request is still being processed. Try again in a moment.',
      );
    }
  });

  // ====================================================================
  // CONTROLS — the switches, the fees, the new-salon default
  // ====================================================================
  /**
   * The read. One row, always present — migration 0032 inserts it in the same file
   * that creates the table, so there is no "not configured yet" state for the
   * console to render and no absent-settings branch for a handler to invent.
   */
  app.get('/v1/platform/settings', async (req, reply) => {
    requirePlatform(req, 'controls');
    return reply.send(serialisePlatformSettings(await readPlatformSettings(db)));
  });

  /**
   * `PATCH /v1/platform/settings` — and this is the endpoint that moves AVO's
   * commission, so it is a money-path write rather than a preferences write.
   *
   * WHAT MAKES IT ONE: `services/topup.ts` now reads `platform_settings` inside the
   * top-up transaction, so a value written here prices every subsequent top-up.
   * Before that wiring the commission was a constant compiled into the server and
   * this endpoint would have been decorative.
   *
   * IT IS NOT IDEMPOTENCY-KEYED, and that is a deliberate reading of
   * non-negotiable #4 rather than an omission. #4 covers "every money-moving POST —
   * top-ups, charges, orders, voids", and the hazard it addresses is a retry
   * applying an effect twice. This is an idempotent PATCH: it sets fields to
   * absolute values, so replaying it produces the same row. There is no second
   * application to prevent. What a retry CAN do is overwrite a concurrent edit by
   * another admin, and that is a lost-update problem rather than a double-spend —
   * called out below rather than silently accepted.
   *
   * THE BODY IS AN ALLOW-LIST, not a spread. `db.update().set(req.body)` on a table
   * with an `id` column is a route that lets a client rename the singleton, and on
   * this table it would let one set `updatedBy` to somebody else's name.
   */
  app.patch('/v1/platform/settings', async (req, reply) => {
    const p = requirePlatform(req, 'controls');

    const body = (req.body ?? {}) as Record<string, unknown>;

    /**
     * THE WRITE BODY IS FLAT, AND IT IS NOT THE READ SHAPE. This comment used to
     * claim the opposite — "the shape `serialisePlatformSettings` emits, so the
     * console can send back a subset of exactly what it read" — and that was false
     * on the half that matters: the serialiser NESTS the three fee fields under
     * `commission`, this allow-list is flat, so echoing the read back answers
     * `invalid_field "Not editable: commission."`. Lane C found it by doing exactly
     * what the comment invited and contained it client-side (`UpdateSettingsInput`
     * types the flat form, so the nested one cannot be built by accident).
     *
     * THE HANDLER IS THE PART THAT WAS RIGHT, in two ways, so the fix is this
     * comment and not the code:
     *
     *   - it stays ONE body shape. Accepting `commission.cardFlatFils` alongside
     *     flat `cardFlatFils` means a body can carry both with different values,
     *     and now the endpoint needs a precedence rule — the "same key, different
     *     body" ambiguity the idempotency layer exists to refuse elsewhere. Two
     *     accepted spellings of one write is how that starts.
     *   - it refuses the nested form BY NAME rather than ignoring it. A console
     *     that sent `commission: {...}` believed it changed AVO's take; silently
     *     dropping the key would leave the rate unchanged and the admin sure it
     *     was not. The loud 400 is what let Lane C find this in an afternoon.
     *
     * So, the contract: READ `GET /v1/platform/settings` returns fees nested under
     * `commission` (grouping is a read affordance); WRITE takes the five flat keys
     * below, plus `flags` as an object because the switches are one design concept
     * with a validated id vocabulary. The console transposes on the way out — one
     * line in the client, versus a permanent ambiguity on the wire.
     */
    const editable = ['flags', 'knetFlatFils', 'cardPercentBp', 'cardFlatFils', 'newSalonDepositFils'];
    const unknown = Object.keys(body).filter((k) => !editable.includes(k));
    if (unknown.length > 0) {
      throw badRequest('invalid_field', `Not editable: ${unknown.join(', ')}.`);
    }

    const patch: Record<string, unknown> = {};
    /** For the audit detail. Design-facing names, in the order they were sent. */
    const changed: string[] = [];

    if ('flags' in body) {
      const flags = body.flags;
      if (typeof flags !== 'object' || flags === null || Array.isArray(flags)) {
        throw badRequest('invalid_flags', 'flags must be an object of switch ids.');
      }
      const badFlags = Object.keys(flags).filter(
        (k) => !(PLATFORM_FLAGS as readonly string[]).includes(k),
      );
      if (badFlags.length > 0) {
        throw badRequest(
          'invalid_flag',
          `Unknown switch: ${badFlags.join(', ')}. Use ${PLATFORM_FLAGS.join(', ')}.`,
        );
      }
      for (const name of PLATFORM_FLAGS) {
        if (!(name in (flags as Record<string, unknown>))) continue;
        const v = (flags as Record<string, unknown>)[name];
        if (typeof v !== 'boolean') {
          throw badRequest('invalid_flag', `flags.${name} must be true or false.`);
        }
        patch[FLAG_COLUMN[name as PlatformFlag]] = v;
        changed.push(`${name} → ${v ? 'on' : 'off'}`);
      }
    }

    if ('knetFlatFils' in body) {
      const v = parseIntegerInRange(body.knetFlatFils, 'knetFlatFils', 0, MAX_KNET_FLAT_FILS);
      patch.knetFlatFils = v;
      changed.push(`KNET flat fee → ${v} fils`);
    }

    if ('cardPercentBp' in body) {
      const v = parseIntegerInRange(body.cardPercentBp, 'cardPercentBp', 0, MAX_CARD_PERCENT_BP);
      /**
       * THE STEP IS REFUSED HERE AS WELL AS BY THE CHECK, and this is the one
       * validation on this endpoint that is arithmetic rather than UI fidelity.
       *
       * `commissionFor`'s rate is a percentage, so the server divides these basis
       * points by 100 — a float division on the money path. Measured over bp
       * 0..1000 against exact integer arithmetic, 172,705 of 7,800,000 half-fil
       * boundaries came out ONE FIL apart across 136 unsafe rates: 29 bp on 25.000
       * KD is 73 fils exactly and 72 through the float.
       *
       * The design's stepper (±0.5% clamped to 5%) only ever produces
       * {0, 50, ..., 500}, all of which are exact. So refusing anything else is not
       * pedantry about matching a UI — it is the condition under which AVO's
       * commission is computed correctly. `db/schema/platformSettings.ts` and
       * migration 0032 carry the numbers; the CHECK is the guarantee and this is
       * the sentence.
       */
      if (v % CARD_PERCENT_STEP_BP !== 0) {
        throw badRequest(
          'invalid_card_percent',
          `cardPercentBp must be a multiple of ${CARD_PERCENT_STEP_BP} — the card rate moves in half-point steps, and rates off that step cannot be applied to a fil exactly.`,
        );
      }
      patch.cardPercentBp = v;
      changed.push(`card rate → ${v} bp`);
    }

    if ('cardFlatFils' in body) {
      // No upper bound in the schema beyond non-negative; the design draws no
      // stepper for it, so 500 is borrowed from the KNET cap rather than invented
      // as something larger. A flat card fee above half a KD is a typo.
      const v = parseIntegerInRange(body.cardFlatFils, 'cardFlatFils', 0, MAX_KNET_FLAT_FILS);
      patch.cardFlatFils = v;
      changed.push(`card flat fee → ${v} fils`);
    }

    if ('newSalonDepositFils' in body) {
      const v = parseIntegerInRange(
        body.newSalonDepositFils,
        'newSalonDepositFils',
        MIN_SALON_DEPOSIT_FILS,
        MAX_SALON_DEPOSIT_FILS,
      );
      patch.newSalonDepositFils = v;
      changed.push(`new-salon deposit → ${v} fils`);
    }

    if (Object.keys(patch).length === 0) {
      throw badRequest('invalid_request', 'Send at least one field to change.');
    }

    /**
     * The write and its audit row in ONE transaction. A rules change whose audit
     * row did not commit is a change nobody can attribute, and this particular
     * change alters what AVO charges — `services/audit.ts` takes an executor for
     * exactly this.
     */
    const row = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(platformSettings)
        .set({ ...patch, updatedBy: p.name, updatedAt: new Date() })
        .where(eq(platformSettings.id, PLATFORM_SETTINGS_ID))
        .returning();
      if (!updated) {
        throw notFound('platform_settings_missing', 'The platform settings row is missing.');
      }

      /**
       * `salonId: null` — a platform-wide rules change, and the null is what keeps
       * it out of every merchant's log: the salon audit read filters
       * `salon_id = $1`, which excludes null without anybody having to remember to.
       *
       * That is the right visibility here for the same reason it is right for the
       * messaging policy: AVO's commission is not a fact a salon reads from this
       * screen. Her own rate is shown to her in Merchant → Settings, which is a
       * separate read.
       *
       * `kind: 'rules'`, not `'money'`. No money moved — the rate that prices the
       * NEXT top-up changed. A money row without an `amountFils` would also fail
       * the CHECK that ties those together.
       */
      await writeAudit(tx, p, {
        salonId: null,
        kind: 'rules',
        action: 'Platform controls changed',
        detail: changed.join(' · '),
        source: 'owner_console',
        subjectType: 'platform_settings',
        subjectId: PLATFORM_SETTINGS_ID,
        metadata: { changed: patch },
      });

      return updated;
    });

    return reply.send(serialisePlatformSettings(row));
  });

  // ====================================================================
  // ACTIVITY — the platform-wide live feed
  // ====================================================================
  /**
   * `GET /v1/platform/activity` — the console's Activity section, which the design
   * describes in its own banner as "Live events across every salon — top-ups,
   * charges, deposits, tier changes and account actions."
   *
   * ================= IS THIS THE SALON FEED WITHOUT THE PREDICATE? NO =================
   *
   * Trunk asked the question directly and the honest answer is that it is neither
   * that nor the audit log renamed. It is BOTH, merged, and the design settles it —
   * the eight rows it draws are three different sources:
   *
   *     Latifa A.  topped up 25.000 via KNET        transaction   kind=topup
   *     Huda M.    upgraded to the Pro plan         (no source — see below)
   *     Maya S.    paid 18.000 · Balayage           transaction   kind=charge
   *     Owner      adjusted Silver tier bonus …     audit_log     kind=rules
   *     Owner      reset password for Sara H.       audit_log     kind=access
   *     Nour A.    enabled the Shop module          audit_log     kind=rules
   *     Reem S.    reached Gold tier                loyalty_event
   *     System     suspended Glow Bar · billing …   (no source — see below)
   *
   * `routes/activity.ts` reads `transaction` and `loyalty_event`, so it cannot
   * produce rows 4, 5 or 6 — a permission change and a rule change are not
   * transactions, and dropping the salon predicate would not make them appear.
   * `GET /v1/platform/audit` reads `audit_log`, so it cannot produce row 7: nothing
   * writes an audit row for a tier climb, and `grep subject_type='loyalty_event'`
   * over the log returns nothing. So the console's feed is the union, and the
   * merchant's Overview is the same union minus the audit stream — which the design
   * agrees with, because the merchant's Overview draws five lines and none of them
   * is an authority change.
   *
   * ================= AND IT IS NOT A SECOND DOOR ONTO THE AUDIT LOG =================
   *
   * That was the risk trunk named: `audit` is a separate section with its own gate,
   * so an "activity" feed that is the audit log renamed would let `activity` read
   * what `audit` gates. Two things stop that here.
   *
   * `kind: 'money'` AUDIT ROWS ARE EXCLUDED, which is most of the log's volume and
   * is not a privacy dodge — it is a DUPLICATE removal. Every money audit action
   * has a transaction behind it that this feed already reads: `Top-up settled` →
   * `topup`, `Charge taken` → `charge`, `Charge voided` and `Wallet adjusted` →
   * `adjustment`, `Shop order paid` → `shop`, `Deposit returned` →
   * `deposit_return`. Including both would print every money line twice, and the
   * transaction is the better of the pair for a feed: it renders as the design
   * writes it, with the MEMBER as the actor ("Latifa A. topped up 25.000 via KNET"),
   * where the audit row's actor for a settled top-up is `System` — correctly, since
   * "the money was moved by the processor confirming a payment". The one money
   * action with no counterpart is `Deposit held`, and `FEED_KINDS` excludes
   * `deposit_hold` on its own argument.
   *
   * WHAT REMAINS IS STILL A STRICT SUBSET OF THE AUDIT SECTION, and that is the
   * honest statement of the overlap rather than a denial of it: an admin holding
   * `activity` and not `audit` can see rules/access/risk rows in feed form. The
   * design intends that — its banner says "account actions" and draws a password
   * reset — and the two reads are not equivalent, because `audit` gets the search
   * box, the four filters, `?salon=platform`, `total`, `subjectType/subjectId`,
   * `ipAddress`-backed metadata and the money rows. Reported to trunk as a
   * deliberate overlap rather than left for somebody to find.
   *
   * SIGN-INS ARE IN, AND THEY WILL DOMINATE. `Web sign-in` and `Console sign-in`
   * are `access` rows and are by far the highest-volume action in the log, so at a
   * hundred salons this feed is mostly sign-ins and the eight kinds of line the
   * design draws are buried — none of its example rows is a sign-in. They are
   * included anyway, because excluding them means a hardcoded list of action
   * strings, which is a filter that silently stops matching the first time somebody
   * rewords an action, and "account actions" in the design's own banner plainly
   * covers them. If it matters the honest mechanism is a `?kind=` narrowing, which
   * `GET /v1/platform/audit` already has and this could take unchanged. Reported to
   * trunk rather than guessed at here.
   *
   * TWO OF THE DESIGN'S ROWS HAVE NO SOURCE AT ALL, and they are absent rather than
   * faked: `plan` is in neither `PLATFORM_EDITABLE` nor the merchant set — it prices
   * the account and Billing has no API — and there is no salon-suspension endpoint,
   * so "upgraded to the Pro plan" and "suspended Glow Bar · billing hold" cannot be
   * produced by anything. Both are Billing, which `DECISIONS.md` #15 blocks.
   * Reported.
   *
   * ================= THE CURSOR =================
   *
   * `routes/activity.ts` has none, on purpose, and says why: "a cursor over a merged
   * stream needs a composite position", and the Overview draws five lines with no
   * "load more". This screen is the other case — a whole section whose job is
   * looking backwards — so it pays for the composite key: `(at, stream, id)`, one
   * opaque string, exactly one thing for a client to carry.
   *
   * THE INSTANT IS RENDERED BY POSTGRES, for the reason `routes/support.ts` records
   * at length after it cost a walk: `timestamptz` stores microseconds and
   * `Date.toISOString()` emits milliseconds, so a cursor built from the wire's own
   * `at` truncates and silently ENDS the walk on any group of rows sharing a
   * millisecond. That is not a corner case here — a charge writes a `transaction`,
   * a `loyalty_event` and an `audit_log` row inside ONE transaction, and `now()` is
   * the transaction timestamp, so all three carry the SAME `created_at` to the
   * microsecond. The stream rank is what separates them, and the id separates two
   * rows of one stream.
   *
   * THE MECHANICS ARE `services/streamCursor.ts`, which owns the key, the instant,
   * the per-source predicate and the bounded merge — extracted when this became the
   * second of three reads needing them, and carrying the argument for each. What
   * stays here is the only thing that is this endpoint's own: which streams there
   * are, and in what order a simultaneous group reads.
   */
  app.get<{ Querystring: { limit?: string; cursor?: string; salon?: string } }>(
    '/v1/platform/activity',
    async (req, reply) => {
      requirePlatform(req, 'activity');

      const limit = parseFeedLimit(req.query.limit);

      /**
       * `?salon=` NARROWS and widens nothing — `GET /v1/platform/audit`'s reasoning,
       * including the refusal by name: "no activity" and "you typed the wrong id"
       * look identical otherwise and only one of them is worth acting on.
       *
       * There is no `?salon=platform` here, unlike the audit read. A feed line with
       * no salon is a platform action, and it is reachable — it just cannot be
       * SELECTED on its own, because the two streams that could accompany it always
       * have a salon, so the filter would degenerate into the audit read with a
       * `kind` filter. The audit section already expresses it.
       */
      const salonFilter = (req.query.salon ?? '').trim();
      if (salonFilter !== '') {
        const [known] = await db
          .select({ id: salon.id })
          .from(salon)
          .where(eq(salon.id, salonFilter))
          .limit(1);
        if (!known) throw notFound('unknown_salon', 'No such salon.');
      }

      const cursor = parseCursor(req.query.cursor, FEED_RANKS);
      const take = limit + 1;

      const [txRows, loyaltyRows, auditRows] = await Promise.all([
        db
          .select({ ...getTableColumns(transaction), cursorAt: cursorInstant(transaction.createdAt) })
          .from(transaction)
          .where(
            and(
              inArray(transaction.kind, [...FEED_KINDS]),
              /**
               * Settled only. A `pending` top-up is a customer staring at a gateway
               * page — reporting it as activity would put money in the feed that may
               * yet decline, and api-contract.md § TopUpIntent is explicit that
               * pending is "never a failure, never a success".
               */
              eq(transaction.status, 'settled'),
              salonFilter === '' ? undefined : eq(transaction.salonId, salonFilter),
              afterCursor(cursor, STREAM_RANK.transaction, transaction.createdAt, transaction.id),
            ),
          )
          .orderBy(desc(transaction.createdAt), asc(transaction.id))
          .limit(take),
        db
          .select({ ...getTableColumns(loyaltyEvent), cursorAt: cursorInstant(loyaltyEvent.createdAt) })
          .from(loyaltyEvent)
          .where(
            and(
              salonFilter === '' ? undefined : eq(loyaltyEvent.salonId, salonFilter),
              afterCursor(cursor, STREAM_RANK.loyalty, loyaltyEvent.createdAt, loyaltyEvent.id),
            ),
          )
          .orderBy(desc(loyaltyEvent.createdAt), asc(loyaltyEvent.id))
          .limit(take),
        db
          .select({ ...getTableColumns(auditLog), cursorAt: cursorInstant(auditLog.createdAt) })
          .from(auditLog)
          .where(
            and(
              /** The duplicate removal. See the header. */
              inArray(auditLog.kind, ['rules', 'access', 'risk']),
              salonFilter === '' ? undefined : eq(auditLog.salonId, salonFilter),
              afterCursor(cursor, STREAM_RANK.audit, auditLog.createdAt, auditLog.id),
            ),
          )
          .orderBy(desc(auditLog.createdAt), asc(auditLog.id))
          .limit(take),
      ]);

      /**
       * One lookup for every name the page will print, rather than a join on each
       * stream — `routes/activity.ts`'s reasoning, and NOT scoped to a salon here,
       * because this read crosses every tenant by design and the ids came out of
       * rows the caller is already entitled to.
       */
      const memberIds = [
        ...new Set([...txRows.map((t) => t.memberId), ...loyaltyRows.map((l) => l.memberId)]),
      ];
      const names = new Map<string, string>();
      if (memberIds.length > 0) {
        const rows = await db
          .select({ id: member.id, name: member.name })
          .from(member)
          .where(inArray(member.id, memberIds));
        for (const r of rows) names.set(r.id, r.name);
      }

      const keyed: Keyed<FeedItem>[] = [
        ...txRows.map<Keyed<FeedItem>>((t) => ({
          rank: STREAM_RANK.transaction,
          at: t.cursorAt,
          id: t.id,
          item: {
            id: t.id,
            stream: 'transaction',
            at: t.createdAt.toISOString(),
            /**
             * An automatic deposit return has no staff behind it and the design
             * attributes it to "System" — the same actor `writeAudit` records for a
             * principal-less write.
             */
            who:
              t.kind === 'deposit_return' && t.createdByStaffId === null
                ? 'System'
                : (names.get(t.memberId) ?? t.memberId),
            memberId: t.memberId,
            salonId: t.salonId,
            what:
              t.kind === 'deposit_return' && t.createdByStaffId === null
                ? `returned ${kd(t.amountFils)} deposit · ${names.get(t.memberId) ?? t.memberId}`
                : describeTransaction(t),
            kind: t.kind,
            amountFils: t.amountFils,
          },
        })),
        ...loyaltyRows.map<Keyed<FeedItem>>((l) => ({
          rank: STREAM_RANK.loyalty,
          at: l.cursorAt,
          id: l.id,
          item: {
            id: l.id,
            stream: 'loyalty',
            at: l.createdAt.toISOString(),
            who: names.get(l.memberId) ?? l.memberId,
            memberId: l.memberId,
            salonId: l.salonId,
            what: describeLoyalty(l),
            kind: l.kind,
            amountFils: null,
          },
        })),
        ...auditRows.map<Keyed<FeedItem>>((a) => ({
          rank: STREAM_RANK.audit,
          at: a.cursorAt,
          id: a.id,
          item: {
            id: a.id,
            stream: 'audit',
            at: a.createdAt.toISOString(),
            /** The actor SNAPSHOT, which is why this reads right seven years later. */
            who: a.actorName,
            /**
             * `memberId` is the member this line is ABOUT, when it is about one, and
             * null otherwise. It is read from `subjectId` and only when
             * `subjectType` says so, rather than from `actorId`: the design's row is
             * "Owner reset password for Sara H." — the actor is the console and the
             * member is the subject, and conflating them would attribute a reset to
             * the person it was done to.
             */
            memberId: a.subjectType === 'member' ? a.subjectId : null,
            /** Null on a platform action belonging to no salon. */
            salonId: a.salonId,
            /**
             * `action · detail`, which is how the design's lines read — "enabled the
             * Shop module", "adjusted Silver tier bonus to 12%". `detail` is
             * "rendered verbatim" per `db/schema/audit.ts` and defaults to the empty
             * string, so a row without one is its action alone rather than a line
             * with a dangling separator.
             */
            what: a.detail === '' ? a.action : `${a.action} · ${a.detail}`,
            /** money / rules / access / risk — the pill colour, as the audit read serves it. */
            kind: a.kind,
            /**
             * Always null on this stream, and deliberately so rather than passing
             * `a.amountFils` through: the money rows are EXCLUDED as duplicates, so
             * a non-null amount here would be a line whose money is also being
             * reported by a transaction. `rules`/`access`/`risk` rows carry no amount
             * anyway — the `audit_log_money_has_amount` CHECK only constrains the
             * other direction — so this states the invariant instead of relying on
             * it.
             */
            amountFils: null,
          },
        })),
      ];

      /** The bounded merge, and the "is there another page" argument. See that file. */
      return reply.send(mergePage(keyed, limit));
    },
  );

  // ====================================================================
  // AUDIT — the platform-wide log
  // ====================================================================
  /**
   * `GET /v1/platform/audit` — "Every charge, void, reimbursement, rule change and
   * permission change" across every salon, plus AVO's own actions.
   *
   * THE SCOPING IS THE WHOLE DIFFERENCE FROM THE MERCHANT'S READ, and it is an
   * absence rather than a predicate: there is NO `salon_id` filter, so the console
   * sees salon-scoped rows AND the null-salon rows that are the platform's own
   * business — the messaging-policy change, this endpoint's own controls change,
   * an admin's sections being edited. The merchant's read excludes those by
   * filtering on her salon id, which is what makes the two reads different views of
   * one append-only table rather than two logs.
   *
   * `?salon=` NARROWS IT, and does not widen anything: the design's own log draws a
   * salon pill on every row, and the console needs to answer "what happened at Glow
   * Bar". Unknown ids are refused by name rather than silently returning an empty
   * page, because "no activity" and "you typed the wrong id" look identical
   * otherwise and only one of them is worth acting on.
   *
   * `?salon=platform` selects the null-salon rows on their own — AVO's own actions,
   * which is the one filter the merchant's read can never express. A literal rather
   * than a magic empty string, so it cannot be produced by an accidentally blank
   * query parameter.
   *
   * NO POST HERE EITHER. Rows are written by the handlers that cause them, and
   * `UPDATE`/`DELETE` are revoked from `avo_app` in migration 0001. An endpoint that
   * let the console append would let it append a lie, on a log with no tenancy
   * boundary at all.
   */
  app.get<{
    Querystring: { q?: string; kind?: string; limit?: string; cursor?: string; salon?: string };
  }>('/v1/platform/audit', async (req, reply) => {
    requirePlatform(req, 'audit');

    const limit = parseAuditLimit(req.query.limit);
    const cursor = parseAuditCursor(req.query.cursor);
    const kinds = parseAuditKinds(req.query.kind);
    const q = (req.query.q ?? '').trim();
    const salonFilter = (req.query.salon ?? '').trim();

    const filters: (SQL | undefined)[] = [];

    if (salonFilter === 'platform') {
      filters.push(isNull(auditLog.salonId));
    } else if (salonFilter !== '') {
      const known = await db
        .select({ id: salon.id })
        .from(salon)
        .where(eq(salon.id, salonFilter))
        .limit(1);
      if (!known[0]) throw notFound('unknown_salon', 'No such salon.');
      filters.push(eq(auditLog.salonId, salonFilter));
    }

    if (kinds) filters.push(inArray(auditLog.kind, kinds));
    if (q !== '') filters.push(auditSearchPredicate(q));

    const present = filters.filter((f): f is SQL => f !== undefined);
    // `and()` of nothing is undefined, which Drizzle reads as "no WHERE" — which is
    // exactly right for an unfiltered platform read, and is stated because a
    // `WHERE` that vanishes is usually a bug rather than an intention.
    const where = present.length > 0 ? and(...present) : undefined;
    const pageWhere =
      cursor === null ? where : where === undefined ? lt(auditLog.seq, cursor) : and(where, lt(auditLog.seq, cursor));

    const rows = await db
      .select()
      .from(auditLog)
      .where(pageWhere)
      // Newest first, `seq` the only tiebreak-free ordering. See parseAuditCursor.
      .orderBy(desc(auditLog.seq))
      // One extra row, to answer "is there another page?" without a second count.
      .limit(limit + 1);

    const page = rows.slice(0, limit);
    const hasMore = rows.length > limit;

    // Against `where`, not `pageWhere`, so the count answers "how many entries
    // match this filter" and does not shrink as the console pages through.
    const [counted] = await db.select({ total: auditTotal }).from(auditLog).where(where);

    return reply.send({
      items: page.map(serialiseAuditRow),
      total: counted?.total ?? 0,
      nextCursor: hasMore ? (page[page.length - 1]?.seq ?? null) : null,
      appendOnly: true,
      retentionYears: 7,
    });
  });
}
