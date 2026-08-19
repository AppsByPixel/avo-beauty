/**
 * The owner console's three remaining sections — Analytics, Controls, Audit.
 *
 *   GET   /v1/platform/metrics    analytics   "How AVO is performing across every salon"
 *   GET   /v1/platform/settings   controls    "Every platform switch, fee and default"
 *   PATCH /v1/platform/settings   controls
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

import { and, desc, eq, inArray, isNull, lt, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { db } from '../db/client';
import { auditLog } from '../db/schema/audit';
import { salon } from '../db/schema/salon';
import { platformSettings } from '../db/schema/platformSettings';
import { requirePlatform } from '../auth/principal';
import { badRequest, notFound } from '../http/errors';
import { writeAudit } from '../services/audit';
import {
  auditSearchPredicate,
  auditTotal,
  parseAuditCursor,
  parseAuditKinds,
  parseAuditLimit,
  serialiseAuditRow,
} from '../services/auditRead';
import { computePlatformMetrics } from '../services/platformMetrics';
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
     * `flags` nested, the fee fields flat — the shape `serialisePlatformSettings`
     * emits, so the console can send back a subset of exactly what it read rather
     * than transposing between two shapes.
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
