/**
 * Shared platform state: promotions, campaigns.
 *
 * `POST /v1/salons/{id}/campaigns` is the ninth permission gate (`perms.marketing`)
 * and the place non-negotiable #8 lives:
 *
 *   "A merchant cannot send a customer message. POST /campaigns only creates
 *    pending. Delivery happens on the platform decision endpoint, and caps and
 *    quiet hours are enforced again at send time."
 *
 * So `status` is hardcoded to `pending` and a client-supplied `status` is
 * ignored — not merged, not validated-then-used. `reach` is likewise
 * server-computed and never trusted from the client (api-contract.md § Campaign).
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
  requireSameSalon,
} from '../auth/principal';
import { badRequest, conflict, notFound, serviceUnavailable } from '../http/errors';
import { requireString } from '../money/validate';
import { writeAudit } from '../services/audit';
import { db } from '../db/client';
import { legalDocumentSet, supportConfig, supportTicket, supportTopic } from '../db/schema/legal';
import { member } from '../db/schema/member';
import { branch } from '../db/schema/salon';
import { transaction } from '../db/schema/transaction';
import { boost, happyHour, REWARD_KEYS } from '../db/schema/promotion';
import {
  hasBeenApplied,
  readPromotionSet,
  serialiseHappyHour,
} from '../services/promotions';

/** "10:00"..."23:59", plus "24:00" on `to` only — see db/schema/promotion.ts. */
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const HHMM_OR_END_OF_DAY = /^(([01]\d|2[0-3]):[0-5]\d|24:00)$/;

function happyHourId(): string {
  return `HH-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

/** "SUP-48263" — api-contract.md § SupportTicket. Shown to the customer verbatim. */
function ticketId(): string {
  return `SUP-${Math.floor(Math.random() * 90_000 + 10_000)}`;
}

/** api-contract.md rule 5: "Deduplicate an identical message inside 5 minutes". */
const TICKET_DEDUPE_MINUTES = 5;

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
 * api-contract.md § SupportTicket. `member` is the customer's NAME, which the
 * contract carries beside `memberId` so a staffed queue can render a person
 * rather than an id.
 */
async function serialiseTicket(row: typeof supportTicket.$inferSelect) {
  const [m] = await db
    .select({ name: member.name })
    .from(member)
    .where(eq(member.id, row.memberId))
    .limit(1);

  return {
    id: row.id,
    memberId: row.memberId,
    member: m?.name ?? '',
    topicId: row.topicId,
    /** Resolved server-side from the topic. Never echoed from the request. */
    route: row.route,
    message: row.message,
    ref: row.ref,
    transactionId: row.transactionId,
    via: row.via,
    at: row.createdAt.toISOString(),
    status: row.status,
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
    const p = requirePrincipal(req);
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
   * Readable by any authenticated principal: staff need the same text to answer
   * a question about it, and none of it is tenant-specific — the set is
   * platform-wide, which is why it hangs off `/v1/platform` and not off a salon.
   */
  app.get('/v1/platform/policies', async (req, reply) => {
    requirePrincipal(req);

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
      // A specific version that was never published is a 404. NO published set
      // at all is a 503: the deployment is incomplete, the caller did nothing
      // wrong, and a client must not read it as "there are no terms".
      if (wanted !== null) throw notFound('unknown_policy_version', 'No such policy version.');
      throw serviceUnavailable(
        'policies_not_published',
        'The policy set has not been published yet.',
      );
    }

    return reply.send({ published: serialiseLegalSet(set) });
  });

  // ======================================================================
  // SUPPORT — non-negotiable #11.
  // ======================================================================

  /**
   * The Contact us form's channels, hours and topics.
   *
   * Every topic carries its `route`, and serving it is deliberate rather than
   * careless: the client does not USE it — `POST /v1/support/tickets` below
   * ignores any route it is sent — but the wallet does tell the customer who
   * she is writing to ("this goes to the salon" / "this goes to AVO"), and it
   * cannot say that truthfully from a field it was never given. Reading it is
   * fine; sending it back is what #11 forbids.
   */
  app.get('/v1/platform/support', async (req, reply) => {
    requirePrincipal(req);

    const [channels] = await db.select().from(supportConfig).limit(1);
    if (!channels) {
      throw serviceUnavailable(
        'support_not_configured',
        'Support channels have not been configured yet.',
      );
    }

    const topics = await db
      .select()
      .from(supportTopic)
      .where(eq(supportTopic.active, true))
      .orderBy(supportTopic.position);

    return reply.send({
      channels: {
        whatsapp: channels.whatsapp,
        email: channels.email,
        hoursEn: channels.hoursEn,
        hoursAr: channels.hoursAr,
        replyEn: channels.replyEn,
        replyAr: channels.replyAr,
      },
      topics: topics.map((t) => ({ id: t.id, route: t.route, en: t.en, ar: t.ar })),
    });
  });

  /**
   * `POST /v1/support/tickets` — NON-NEGOTIABLE #11, in one line of code.
   *
   *     route: topic.route
   *
   * Never `body.route`. A client-supplied route lands a wallet dispute in the
   * salon's inbox, and the customer's money question is then answered by the
   * merchant she is disputing. A `route` in the body is IGNORED rather than
   * refused — the same treatment `POST /campaigns` gives a client-supplied
   * `status`, and for the same reason: the field is not the client's to have an
   * opinion about, so there is nothing to negotiate over.
   *
   * The topic must EXIST. An unknown `topicId` is a 400 naming the list rather
   * than a ticket routed to a default, because "route it somewhere sensible"
   * is the decision this endpoint exists to take away from guesswork.
   *
   * RULE 5 — "Deduplicate an identical message inside 5 minutes rather than
   * opening a second ticket." A double-tapped Send is the scanner's double scan
   * in another costume: the customer gets the SAME ticket id back, because two
   * reference numbers for one question is a customer told two different things
   * by two different agents.
   *
   * RULE 3 — a `ref` matching one of HER OWN transactions is linked. Scoped to
   * her: an unscoped lookup would let anyone confirm whether a receipt number
   * exists by watching whether it linked.
   */
  app.post('/v1/support/tickets', async (req, reply) => {
    const p = requireMember(req);

    const body = (req.body ?? {}) as Record<string, unknown>;
    const topicId = requireString(body.topicId, 'topicId', 100);
    const message = requireString(body.message, 'message', 4000);
    const ref = typeof body.ref === 'string' ? body.ref.trim().slice(0, 100) : '';
    const via = body.via ?? 'wa';
    if (via !== 'wa' && via !== 'email') {
      throw badRequest('invalid_via', 'via must be wa or email.');
    }

    const [topic] = await db
      .select()
      .from(supportTopic)
      .where(and(eq(supportTopic.id, topicId), eq(supportTopic.active, true)))
      .limit(1);
    if (!topic) {
      const known = await db
        .select({ id: supportTopic.id })
        .from(supportTopic)
        .where(eq(supportTopic.active, true))
        .orderBy(supportTopic.position);
      throw badRequest(
        'unknown_topic',
        `Pick a topic from the list: ${known.map((t) => t.id).join(', ')}.`,
      );
    }

    // Rule 5, before anything is written.
    const since = new Date(Date.now() - TICKET_DEDUPE_MINUTES * 60_000);
    const [duplicate] = await db
      .select()
      .from(supportTicket)
      .where(
        and(
          eq(supportTicket.memberId, p.id),
          eq(supportTicket.topicId, topic.id),
          eq(supportTicket.message, message),
          gte(supportTicket.createdAt, since),
        ),
      )
      .limit(1);
    if (duplicate) return reply.send(await serialiseTicket(duplicate));

    // Rule 3. Scoped to her own transactions.
    let transactionId: string | null = null;
    if (ref) {
      const [t] = await db
        .select({ id: transaction.id })
        .from(transaction)
        .where(and(eq(transaction.id, ref), eq(transaction.memberId, p.id)))
        .limit(1);
      transactionId = t?.id ?? null;
    }

    const [row] = await db
      .insert(supportTicket)
      .values({
        id: ticketId(),
        memberId: p.id,
        salonId: p.salonId,
        topicId: topic.id,
        // ---- NON-NEGOTIABLE #11 ----
        // From the TOPIC. `body.route` is never read, anywhere in this handler.
        route: topic.route,
        message,
        ref,
        transactionId,
        via,
      })
      .returning();
    if (!row) throw conflict('ticket_not_created', 'That message could not be sent. Try again.');

    /**
     * NOT an audit_log row. `audit_log` is the salon's record of authority and
     * money being spent, filtered by Money / Rules / Access / Risk, and it is
     * readable by any merchant holding the right permission. A customer's
     * support message — very often a complaint ABOUT that merchant, and
     * routed to AVO precisely so the merchant does not see it — has no
     * business in it. The ticket row is its own record.
     */
    return reply.send(await serialiseTicket(row));
  });

  /** perms.marketing. Creates `pending` and nothing else, ever. */
  app.post<{ Params: { id: string } }>('/v1/salons/:id/campaigns', async (req, reply) => {
    const p = requireDashboardPerm(req, 'marketing');
    requireSameSalon(p, req.params.id);

    const body = (req.body ?? {}) as Record<string, unknown>;
    const title = requireString(body.title, 'title', 200);
    const text = requireString(body.body, 'body', 2000);
    const channel = body.channel ?? 'push';
    if (!['push', 'wa', 'both'].includes(String(channel))) {
      throw badRequest('invalid_channel', 'channel must be push, wa or both.');
    }

    const campaign = {
      id: `CMP-${Math.floor(Math.random() * 900 + 100)}`,
      salonId: p.salonId,
      title,
      body: text,
      channel,
      audience: body.audience ?? 'all',
      branchId: body.branchId ?? 'all',
      reward: body.reward ?? 'none',
      // Server-computed, never trusted from the client.
      reach: 0,
      when: body.when ?? 'now',
      scheduledAt: body.scheduledAt ?? '',
      // Hardcoded. A merchant cannot send — non-negotiable #8.
      status: 'pending' as const,
      submittedBy: p.name,
      submittedAt: new Date().toISOString(),
      decidedBy: null,
      decidedAt: null,
      note: null,
      result: null,
    };

    await writeAudit(db, p, {
      salonId: p.salonId,
      kind: 'rules',
      action: 'Campaign submitted',
      detail: `"${title}" submitted for AVO approval`,
      source: 'merchant',
      subjectType: 'campaign',
      subjectId: campaign.id,
      ipAddress: req.ip ?? null,
      userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
    });

    return reply.send(campaign);
  });
}
