/**
 * Shared platform state: promotions and the published legal set.
 *
 * CAMPAIGNS USED TO LIVE HERE and are now routes/campaigns.ts — non-negotiable #8
 * turned out to be a table, a send log, a messaging policy, the console's queue, a
 * decision endpoint and send-time cap enforcement, which is most of a phase rather
 * than one handler.
 *
 * The promotion set is read-only here. It is ONE object that the wallet and the
 * dashboard both read, and it deliberately ships days/from/to with no `live`
 * flag: the predicate resolves on each client every second and on the server at
 * charge time, so a stale banner cannot cause a wrong charge.
 */

import { and, desc, eq, gte, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  requireDashboardPerm,
  requireMember,
  requirePrincipal,
  requireSalonScoped,
  requireSameSalon,
} from '../auth/principal';
import { badRequest, conflict, notFound } from '../http/errors';
/** One definition of "HH:MM" for the whole API — see http/fields.ts. */
import { HHMM, HHMM_OR_END_OF_DAY } from '../http/fields';
import { requireString } from '../money/validate';
import { writeAudit } from '../services/audit';
import { db } from '../db/client';
import { legalDocumentDraft, legalDocumentSet } from '../db/schema/legal';
import { member } from '../db/schema/member';
import { branch } from '../db/schema/salon';
import { transaction } from '../db/schema/transaction';
import { boost, happyHour, REWARD_KEYS } from '../db/schema/promotion';
import {
  hasBeenApplied,
  readPromotionSet,
  serialiseHappyHour,
} from '../services/promotions';

function happyHourId(): string {
  return `HH-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

/**
 * The published set, on the wire.
 *
 * `effectiveFrom` is a `date` column and comes back as "YYYY-MM-DD" already —
 * emitted as-is rather than pushed through a Date, which would re-interpret a
 * calendar day in the process zone and can move it. The clients render it as
 * "Last updated 1 July 2026 · v3".
 */
function serialiseLegalSet(row: typeof legalDocumentSet.$inferSelect) {
  return {
    version: row.version,
    effectiveFrom: row.effectiveFrom,
    publishedAt: row.publishedAt.toISOString(),
    publishedBy: row.publishedBy,
    docs: row.docs,
  };
}

/**
 * Every OPEN branch of this salon. `branchId: 'all'` is the wire's sentinel and
 * is handled by the caller.
 *
 * Closed branches are excluded so a new happy hour or a boost cannot be scoped
 * to a location that takes no money — `resolveBranch` will never attribute a
 * charge there, so such a window would be silently dead. The `PUT …/boosts`
 * caller relies on this in a second way: it resets every branch the body omits,
 * and a closed branch has no business being reset to a neutral boost it can
 * never spend.
 */
async function branchIdsOf(salonId: string): Promise<Set<string>> {
  const rows = await db
    .select({ id: branch.id })
    .from(branch)
    .where(and(eq(branch.salonId, salonId), isNull(branch.closedAt)));
  return new Set(rows.map((r) => r.id));
}

interface WindowFields {
  branchId: string | null;
  days: number[];
  from: string;
  to: string;
  reward: string;
  on: boolean;
  notify: boolean;
}

/**
 * Validate a happy-hour window.
 *
 * `partial` is what separates POST from PATCH: a POST must carry a whole window,
 * a PATCH may carry one field. Everything that IS present is validated the same
 * way either way — a PATCH is not a second, laxer door into the same row.
 */
async function parseWindow(
  body: Record<string, unknown>,
  salonId: string,
  current: WindowFields | null,
): Promise<WindowFields> {
  const allowed = new Set(['branchId', 'days', 'from', 'to', 'reward', 'on', 'notify']);
  const rejected = Object.keys(body).filter((k) => !allowed.has(k));
  if (rejected.length > 0) {
    throw badRequest(
      'not_editable',
      `These fields cannot be set on a happy hour: ${rejected.join(', ')}.`,
    );
  }

  const out: WindowFields = current
    ? { ...current }
    : { branchId: null, days: [], from: '', to: '', reward: '', on: true, notify: false };

  if ('branchId' in body) {
    const v = body.branchId;
    if (v === 'all' || v === null) {
      out.branchId = null;
    } else if (typeof v === 'string' && (await branchIdsOf(salonId)).has(v)) {
      out.branchId = v;
    } else {
      // Refused rather than coerced to "all". A window the merchant scoped to
      // Salmiya and that silently became salon-wide is money she did not agree
      // to spend at the other branch.
      throw badRequest(
        'invalid_branch',
        'branchId must be "all" or a branch of this salon.',
      );
    }
  }

  if ('days' in body) {
    const v = body.days;
    if (!Array.isArray(v) || v.length === 0) {
      throw badRequest('invalid_days', 'days must be a non-empty array of 0-6, Sunday first.');
    }
    if (!v.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) {
      throw badRequest('invalid_days', 'days must contain whole numbers 0-6, 0 being Sunday.');
    }
    // Deduplicated and sorted before storage. `days.includes(now.getDay())` does
    // not care, but a stored `[1,1,1]` would render as three Mondays in the
    // dashboard's day picker.
    out.days = [...new Set(v as number[])].sort((a, b) => a - b);
  }

  if ('from' in body) {
    if (typeof body.from !== 'string' || !HHMM.test(body.from)) {
      throw badRequest('invalid_window', 'from must be a 24-hour time like "16:00".');
    }
    out.from = body.from;
  }
  if ('to' in body) {
    if (typeof body.to !== 'string' || !HHMM_OR_END_OF_DAY.test(body.to)) {
      throw badRequest(
        'invalid_window',
        'to must be a 24-hour time like "18:00", or "24:00" for the end of the day.',
      );
    }
    out.to = body.to;
  }

  if ('reward' in body) {
    if (typeof body.reward !== 'string' || !(REWARD_KEYS as readonly string[]).includes(body.reward)) {
      throw badRequest('invalid_reward', `reward must be one of ${REWARD_KEYS.join(', ')}.`);
    }
    out.reward = body.reward;
  }

  if ('on' in body) {
    if (typeof body.on !== 'boolean') throw badRequest('invalid_request', 'on must be true or false.');
    out.on = body.on;
  }
  if ('notify' in body) {
    if (typeof body.notify !== 'boolean') {
      throw badRequest('invalid_request', 'notify must be true or false.');
    }
    out.notify = body.notify;
  }

  if (out.days.length === 0 || out.from === '' || out.to === '' || out.reward === '') {
    throw badRequest(
      'invalid_request',
      'A happy hour needs days, from, to and reward.',
    );
  }

  /**
   * THE MIDNIGHT RULE, refused at the door as well as in the CHECK.
   *
   * The database would refuse `to <= from` with a constraint violation, which
   * reaches a merchant as a 500. She gets the workaround instead, because it is
   * a real one and it costs her nothing: `isHappyHourLive` — the SHARED
   * predicate both clients import — evaluates `from <= now < to` and is empty
   * when `to <= from`, so a wrapping window stored here would be applied by this
   * server and rendered as dead by every client. That disagreement is exactly
   * what the no-`live`-flag design exists to prevent.
   */
  if (out.to <= out.from) {
    throw badRequest(
      'window_crosses_midnight',
      `A happy hour cannot run from ${out.from} to ${out.to} — it has to end after it starts, on the same day. For a window that crosses midnight, add two: ${out.from}–24:00 on the day it starts, and 00:00–${out.to} on the day after.`,
    );
  }

  return out;
}

export async function registerPlatformRoutes(app: FastifyInstance): Promise<void> {
  /**
   * ONE source of truth — the wallet and the dashboard read this same object.
   *
   * Readable by any authenticated principal of the salon, and that is the point:
   * "the customer wallet and the merchant dashboard read the same object. Never
   * duplicate boost or happy-hour values in a client." The wallet's "2× visits"
   * chip and the dashboard's stepper are two views of one row.
   *
   * There is no `live` flag, no `minutesRemaining`, no `isLive`. The response
   * carries days/from/to and the salon's `timezone`, and every reader resolves
   * the predicate itself, every second, with no push and no poll. See the file
   * header and db/schema/promotion.ts.
   */
  app.get<{ Params: { id: string } }>('/v1/salons/:id/promotions', async (req, reply) => {
    const p = requireSalonScoped(req);
    requireSameSalon(p, req.params.id);
    return reply.send(await readPromotionSet(db, req.params.id));
  });

  /**
   * perms.marketing. Boosts publish as a SET, in one transaction.
   *
   * A PUT, not a PATCH, because the dashboard's screen is the whole grid: a
   * merchant who clears Salmiya's boost and saves has sent one branch, and a
   * merge would leave the old value standing. Branches absent from the body are
   * therefore reset to neutral (1/0/1) rather than left alone.
   */
  app.put<{ Params: { id: string } }>('/v1/salons/:id/promotions/boosts', async (req, reply) => {
    const p = requireDashboardPerm(req, 'marketing');
    requireSameSalon(p, req.params.id);

    const body = (req.body ?? {}) as Record<string, unknown>;
    const boosts = body.boosts;
    if (typeof boosts !== 'object' || boosts === null || Array.isArray(boosts)) {
      throw badRequest('invalid_request', 'boosts must be an object keyed by branch id.');
    }

    const known = await branchIdsOf(req.params.id);
    const parsed: Array<{ branchId: string; visit: number; topup: number; stamp: number }> = [];

    for (const [branchId, raw] of Object.entries(boosts as Record<string, unknown>)) {
      if (!known.has(branchId)) {
        throw badRequest('invalid_branch', `${branchId} is not a branch of this salon.`);
      }
      const v = (raw ?? {}) as Record<string, unknown>;
      const visit = v.visit ?? 1;
      const topup = v.topup ?? 0;
      const stamp = v.stamp ?? 1;
      // Bounds enforced here AND by the CHECK. Non-negotiable #7: the stepper
      // stopping at 3 is a courtesy; a hand-rolled PUT of `visit: 50` would
      // multiply a customer's loyalty standing by fifty.
      if (!Number.isInteger(visit) || (visit as number) < 1 || (visit as number) > 3) {
        throw badRequest('invalid_boost', `${branchId}: visit must be a whole number 1-3.`);
      }
      if (!Number.isInteger(topup) || (topup as number) < 0 || (topup as number) > 30) {
        throw badRequest('invalid_boost', `${branchId}: topup must be a whole number 0-30.`);
      }
      if (!Number.isInteger(stamp) || (stamp as number) < 1 || (stamp as number) > 3) {
        throw badRequest('invalid_boost', `${branchId}: stamp must be a whole number 1-3.`);
      }
      parsed.push({
        branchId,
        visit: visit as number,
        topup: topup as number,
        stamp: stamp as number,
      });
    }

    const now = new Date();
    await db.transaction(async (tx) => {
      // Every branch of the salon, so a branch the body omitted is reset rather
      // than left holding a boost the merchant thinks she removed. One
      // `published_at` across the set: it published as a unit.
      for (const branchId of known) {
        const next = parsed.find((x) => x.branchId === branchId) ?? {
          branchId,
          visit: 1,
          topup: 0,
          stamp: 1,
        };
        await tx
          .insert(boost)
          .values({
            salonId: req.params.id,
            branchId,
            visit: next.visit,
            topup: next.topup,
            stamp: next.stamp,
            publishedAt: now,
            publishedBy: p.name,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [boost.salonId, boost.branchId],
            set: {
              visit: next.visit,
              topup: next.topup,
              stamp: next.stamp,
              publishedAt: now,
              publishedBy: p.name,
              updatedAt: now,
            },
          });
      }

      await writeAudit(tx, p, {
        salonId: p.salonId,
        kind: 'rules',
        action: 'Boosts published',
        detail: parsed.length
          ? parsed.map((b) => `${b.branchId}: ${b.visit}× visits, +${b.topup}% top-ups, ${b.stamp}× stamps`).join(' · ')
          : 'All branches reset to no boost',
        source: 'merchant',
        subjectType: 'salon',
        subjectId: req.params.id,
        metadata: { boosts: parsed },
        ipAddress: req.ip ?? null,
        userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
      });
    });

    return reply.send(await readPromotionSet(db, req.params.id));
  });

  /** perms.marketing. A new window. */
  app.post<{ Params: { id: string } }>(
    '/v1/salons/:id/promotions/happy-hours',
    async (req, reply) => {
      const p = requireDashboardPerm(req, 'marketing');
      requireSameSalon(p, req.params.id);

      const fields = await parseWindow(
        (req.body ?? {}) as Record<string, unknown>,
        req.params.id,
        null,
      );

      const id = happyHourId();
      const [row] = await db.transaction(async (tx) => {
        const inserted = await tx
          .insert(happyHour)
          .values({ id, salonId: req.params.id, ...fields })
          .returning();

        await writeAudit(tx, p, {
          salonId: p.salonId,
          kind: 'rules',
          action: 'Happy hour added',
          detail: `${fields.from}–${fields.to}, ${fields.reward}, ${fields.branchId ?? 'all branches'}`,
          source: 'merchant',
          subjectType: 'happy_hour',
          subjectId: id,
          metadata: { ...fields },
          ipAddress: req.ip ?? null,
          userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
        });
        return inserted;
      });

      if (!row) throw conflict('happy_hour_not_created', 'That happy hour could not be created.');
      return reply.code(201).send(serialiseHappyHour(row));
    },
  );

  /** perms.marketing. Edit a window — including switching it off. */
  app.patch<{ Params: { id: string; hid: string } }>(
    '/v1/salons/:id/promotions/happy-hours/:hid',
    async (req, reply) => {
      const p = requireDashboardPerm(req, 'marketing');
      requireSameSalon(p, req.params.id);

      const rows = await db
        .select()
        .from(happyHour)
        .where(and(eq(happyHour.id, req.params.hid), eq(happyHour.salonId, req.params.id)))
        .limit(1);
      const current = rows[0];
      if (!current) throw notFound('unknown_happy_hour', 'No such happy hour.');

      const fields = await parseWindow(
        (req.body ?? {}) as Record<string, unknown>,
        req.params.id,
        {
          branchId: current.branchId,
          days: [...current.days],
          from: current.from,
          to: current.to,
          reward: current.reward,
          on: current.on,
          notify: current.notify,
        },
      );

      const [row] = await db.transaction(async (tx) => {
        const updated = await tx
          .update(happyHour)
          .set({ ...fields, updatedAt: new Date() })
          .where(eq(happyHour.id, req.params.hid))
          .returning();

        await writeAudit(tx, p, {
          salonId: p.salonId,
          kind: 'rules',
          action: current.on && !fields.on ? 'Happy hour switched off' : 'Happy hour changed',
          detail: `${fields.from}–${fields.to}, ${fields.reward}, ${fields.branchId ?? 'all branches'}`,
          source: 'merchant',
          subjectType: 'happy_hour',
          subjectId: req.params.hid,
          metadata: { before: { ...current, days: [...current.days] }, after: fields },
          ipAddress: req.ip ?? null,
          userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
        });
        return updated;
      });

      if (!row) throw notFound('unknown_happy_hour', 'No such happy hour.');
      return reply.send(serialiseHappyHour(row));
    },
  );

  /**
   * perms.marketing. Delete a window that has never paid out.
   *
   * A window that HAS paid out is refused, with the alternative named.
   * `transaction.promotion_id` is `ON DELETE restrict`, so the database would
   * refuse anyway — but as a foreign key violation, which reaches the merchant
   * as a 500. Asked first so she gets a sentence. The record of what a promotion
   * paid must outlive the merchant's interest in running it: a reconciliation
   * report with a dangling id in it is worse than a switch left in the off
   * position.
   */
  app.delete<{ Params: { id: string; hid: string } }>(
    '/v1/salons/:id/promotions/happy-hours/:hid',
    async (req, reply) => {
      const p = requireDashboardPerm(req, 'marketing');
      requireSameSalon(p, req.params.id);

      const rows = await db
        .select()
        .from(happyHour)
        .where(and(eq(happyHour.id, req.params.hid), eq(happyHour.salonId, req.params.id)))
        .limit(1);
      const current = rows[0];
      if (!current) throw notFound('unknown_happy_hour', 'No such happy hour.');

      if (await hasBeenApplied(db, current.id)) {
        throw conflict(
          'happy_hour_in_use',
          'This happy hour has already been applied to a charge, so it cannot be deleted — the receipts refer to it. Switch it off instead.',
        );
      }

      await db.transaction(async (tx) => {
        await tx.delete(happyHour).where(eq(happyHour.id, current.id));
        await writeAudit(tx, p, {
          salonId: p.salonId,
          kind: 'rules',
          action: 'Happy hour deleted',
          detail: `${current.from}–${current.to}, ${current.reward}`,
          source: 'merchant',
          subjectType: 'happy_hour',
          subjectId: current.id,
          metadata: { deleted: serialiseHappyHour(current) },
          ipAddress: req.ip ?? null,
          userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
        });
      });

      return reply.code(204).send();
    },
  );

  // ======================================================================
  // THE LEGAL SET — non-negotiable #10.
  // ======================================================================

  /**
   * `GET /v1/platform/policies` — what the wallet's Terms screen renders.
   *
   * "The customer app holds no legal copy. It renders the published policy set
   * from the API and stamps the version." Lane B built the screen with no
   * fallback branch and no bundled copy, which made the absence of this
   * endpoint an empty screen rather than a hidden one. This is what fills it.
   *
   * PUBLISHED ONLY, AND THE OMISSION OF `draft` IS THE FEATURE.
   * api-contract.md § LegalDocumentSet: "Editing writes to `draft`; nothing
   * reaches a phone until publish." The owner console's `GET` answers
   * `{ published, draft }`; this is the customer's read and answers
   * `{ published }`. A draft served to a wallet is unreviewed legal text in
   * front of a customer, and `consent: true` documents among it would be
   * consent collected against wording counsel has not seen.
   *
   * `?version=` RESOLVES AN OLD SET, because `member.policyVersion` refers to
   * one and support has to be able to read what she actually agreed to. Without
   * it the stamp is a number nobody can turn back into a document.
   *
   * UNAUTHENTICATED, AND THAT WAS A BUG UNTIL SIGNUP EXISTED.
   *
   * This route required a principal, which is defensible right up to the moment
   * something has to render these documents BEFORE there is a session — and that
   * moment is the signup screen. #10's first sentence is "the customer app holds
   * no legal copy", and the design's Create account screen links each
   * `consent: true` document so she can read it before ticking the box
   * (design/README.md:113). With a 401 here, a client could only satisfy both by
   * bundling the text, which is precisely what #10 forbids, or by showing her a
   * consent checkbox above three dead links.
   *
   * Nothing is disclosed by opening it. The set is platform-wide with no
   * tenant-specific field in it — which is why it hangs off `/v1/platform` rather
   * than a salon — it is PUBLISHED rather than draft, and it is the text a
   * customer is legally held to. Published terms being publicly readable is the
   * normal state of affairs for terms.
   *
   * Staff and members still read it here; they simply no longer have to.
   */
  app.get('/v1/platform/policies', async (req, reply) => {
    const raw = (req.query as Record<string, unknown> | undefined)?.version;
    let wanted: number | null = null;
    if (raw !== undefined && raw !== '') {
      const n = Number(raw);
      if (!Number.isInteger(n) || n <= 0) {
        throw badRequest('invalid_version', 'version must be a whole number greater than zero.');
      }
      wanted = n;
    }

    const rows = await db
      .select()
      .from(legalDocumentSet)
      .where(wanted === null ? undefined : eq(legalDocumentSet.version, wanted))
      .orderBy(desc(legalDocumentSet.version))
      .limit(1);

    const set = rows[0];
    if (!set) {
      // A specific version that was never published is a 404.
      if (wanted !== null) throw notFound('unknown_policy_version', 'No such policy version.');
      /**
       * NO PUBLISHED SET AT ALL IS A 409, AND IT USED TO BE A 503.
       *
       * The reasoning for 503 was sound in isolation — the deployment is
       * incomplete, the caller did nothing wrong, and a client must not read it as
       * "there are no terms" — and it collided with how clients classify statuses.
       * `apps/wallet/src/api/client.ts` maps `503 || 504` to OFFLINE, which is
       * correct for a gateway timeout, so a deployment with no published terms told
       * a customer "No connection. You need one to create an account", about a
       * working network, with a retry that could never succeed. Lane B hit it twice
       * in the same shape.
       *
       * A configuration state is not a transient unavailability. 503 promises "try
       * again later and it may work"; this will not work until somebody publishes.
       * 409 says the server is fine and its state is wrong, which is the truth and
       * is not in any client's offline bucket.
       *
       * The client's general 503→offline mapping is right and stays. Trunk's call;
       * the fix belongs on this side, because every client that classifies by status
       * would otherwise have to special-case this one code.
       */
      throw conflict(
        'policies_not_published',
        'The policy set has not been published yet.',
      );
    }

    /**
     * `draft` FOR A PLATFORM PRINCIPAL WITH `policies`, AND FOR NOBODY ELSE.
     *
     * `LegalDocumentSetSchema` declares `draft` OPTIONAL, and the reason is in its
     * own comment: requiring it made `.parse()` throw on the customer's legal set,
     * "so #10 could not be satisfied through the contract at all. The owner
     * console's editor is the only reader that gets a draft."
     *
     * So this one route serves two shapes, and the fork is the principal rather
     * than a query parameter — `?includeDraft=1` would be a client asking for
     * unreviewed legal text and being trusted about whether it may have it. A
     * wallet, a merchant, an anonymous signup screen and a console admin without
     * `policies` all get `{ published }`; only the editor sees the draft.
     *
     * RESOLVED WITHOUT THROWING, which is the part worth stating. This route is
     * anonymous by necessity, so it cannot call `requirePlatform` — that would 401
     * the signup screen. It ASKS whether the caller happens to be a console editor
     * and adds a key if so. An empty draft is omitted rather than sent as `{docs:
     * []}`, because "no unpublished changes" and "there is no draft concept here"
     * should not look identical to a console deciding whether to show a dirty dot.
     */
    const p = req.principal;
    if (p?.kind === 'platform_admin' && p.sections.policies) {
      const [draft] = await db.select().from(legalDocumentDraft).limit(1);
      if (draft && draft.docs.length > 0) {
        return reply.send({
          published: serialiseLegalSet(set),
          draft: {
            docs: draft.docs,
            updatedBy: draft.updatedBy,
            updatedAt: draft.updatedAt.toISOString(),
          },
        });
      }
    }

    return reply.send({ published: serialiseLegalSet(set) });
  });

  /**
   * SUPPORT HAS MOVED to routes/support.ts, and it is the same move campaigns made.
   *
   * `GET /v1/platform/support` and `POST /v1/support/tickets` lived here, which was
   * fine while support was a read and one insert. Non-negotiable #11 turned out to
   * be a channels editor, a reorderable topic list whose `route` column IS #11's
   * subject, two staffed queues sharing one path, and a tenancy boundary carried by
   * a predicate rather than by `requireSameSalon`. That is a phase, not a section of
   * a file about promotions.
   */

  /**
   * CAMPAIGNS HAVE MOVED to routes/campaigns.ts, and it is not a tidy-up.
   *
   * `POST /v1/salons/{id}/campaigns` lived here as one handler that built an object
   * literal, wrote an audit row and returned the literal — it persisted nothing. The
   * campaign half of non-negotiable #8 is now a table, a per-recipient send log, a
   * platform messaging policy, the console's queue, the decision endpoint and
   * send-time enforcement of caps and quiet hours. That is most of a phase, and it
   * does not belong inside a file whose header says "promotions, campaigns".
   */
}
