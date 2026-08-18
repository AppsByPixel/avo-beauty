/**
 * The legal set — api-contract.md § LegalDocumentSet, the six routes that did not
 * exist, and the reason non-negotiable #10's second half was unreachable.
 *
 *   POST   /v1/platform/policies/draft           console, `policies` — new document
 *   PATCH  /v1/platform/policies/draft/{docId}   console, `policies` — title/body/consent/order
 *   DELETE /v1/platform/policies/draft/{docId}   console, `policies`
 *   POST   /v1/platform/policies/publish         console, `policies` — bumps `version`
 *   POST   /v1/platform/policies/discard         console, `policies`
 *
 * `GET /v1/platform/policies` stays in routes/platform.ts, where it belongs: it is
 * the CUSTOMER's read, unauthenticated by necessity — the signup screen renders
 * the consent documents before there is a session, and #10's first sentence is
 * "the customer app holds no legal copy". It now includes `draft` FOR A PLATFORM
 * PRINCIPAL WITH `policies` AND NOBODY ELSE, which is what
 * `LegalDocumentSetSchema` means by declaring `draft` optional: "A draft served to
 * a wallet is unreviewed legal text in front of a customer, and `consent: true`
 * documents among it would be consent collected against wording counsel has not
 * seen."
 *
 * WHY THIS UNBLOCKS #10, WHICH IS THE POINT OF THE SLICE
 * -----------------------------------------------------
 * #10's second half — "Store the accepted version against the member" and
 * re-prompt on a material change — was fully built: `member_consent_event` carries
 * `policy_acceptance`, `policyAcceptanceState` derives whether she has accepted
 * what is published NOW, and `requireCurrentPolicyVersion` refuses a stale
 * acceptance. All of it depended on a version being published, and nothing could
 * publish one. STATUS.md records the consequence in its own words: a previous
 * session "inserted v4 by SQL to test the stale path".
 *
 * So the re-prompt was reachable from psql and not from the product. `publish`
 * below is the missing verb.
 *
 * WHAT publish REFUSES, AND WHAT IT ONLY REPORTS
 * ---------------------------------------------
 * REFUSED: a consent document with an empty `body.ar`. The contract is explicit —
 * "An empty `body.ar` is a legitimate state (document not yet translated) and the
 * client falls back to `en`; do not ship a consent document that way." A consent
 * document is the one a customer must tick to have an account, so an Arabic-reading
 * customer would be agreeing to English she may not read. Non-negotiable #12 says
 * Arabic is a first-class layout, not a translation pass.
 *
 * REFUSED: an `effectiveFrom` in the past. A set that took effect before it was
 * published is a claim nobody can defend.
 *
 * ONLY REPORTED: the 30-day notice. The contract says "Set `effectiveFrom` at least
 * 30 days out for a MATERIAL change — the terms themselves promise that notice."
 * Whether a change is material is a judgement about legal meaning, and the contract
 * gives no field to carry it, so the server cannot tell a typo fix from a change of
 * liability. Enforcing 30 days on every publish would make correcting a spelling
 * mistake take a month; enforcing none silently breaks a promise the terms make. So
 * the response carries `noticeDays` and the audit row records it, and the console
 * is where a human judges. ESCALATED: this needs a `material` flag on the publish
 * body, which is a contract change.
 */

import { desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { db } from '../db/client';
import { legalDocumentDraft, legalDocumentSet, type LegalDoc } from '../db/schema/legal';
import { requirePlatform } from '../auth/principal';
import { badRequest, conflict, notFound } from '../http/errors';
import { requireString } from '../money/validate';
import { writeAudit } from '../services/audit';

/** api-contract.md § LegalDoc — `scope` is one of two. */
const DOC_SCOPES = ['platform', 'wallet'] as const;

/** The 30-day promise the terms make, reported rather than enforced. See the header. */
const MATERIAL_NOTICE_DAYS = 30;

async function readDraft(): Promise<LegalDoc[]> {
  const [row] = await db.select().from(legalDocumentDraft).limit(1);
  // Migration 0030 inserts the row, so absence is an incomplete deployment — but
  // an empty draft and a missing row mean the same thing to every caller here, and
  // a 503 for "no unpublished changes" would be a worse answer than the truth.
  return row?.docs ?? [];
}

async function writeDraft(docs: LegalDoc[], by: string): Promise<LegalDoc[]> {
  const [row] = await db
    .insert(legalDocumentDraft)
    .values({ id: 'avo', docs, updatedBy: by, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: legalDocumentDraft.id,
      set: { docs, updatedBy: by, updatedAt: new Date() },
    })
    .returning({ docs: legalDocumentDraft.docs });
  return row?.docs ?? docs;
}

/**
 * A document, validated whole. Every field is required on create and optional on
 * patch, so the two callers share the same rules rather than each having its own
 * idea of what a clause list is.
 */
function parseDoc(body: Record<string, unknown>, existing?: LegalDoc): LegalDoc {
  const scope = body.scope ?? existing?.scope;
  if (typeof scope !== 'string' || !(DOC_SCOPES as readonly string[]).includes(scope)) {
    throw badRequest('invalid_scope', `scope must be one of ${DOC_SCOPES.join(', ')}.`);
  }

  const consent = 'consent' in body ? body.consent : existing?.consent;
  if (typeof consent !== 'boolean') {
    throw badRequest('invalid_consent', 'consent must be true or false.');
  }

  const title = parseBilingualString(body.title, existing?.title, 'title');
  const bodyText = parseClauses(body.body, existing?.body);

  return {
    id: existing?.id ?? '',
    scope: scope as LegalDoc['scope'],
    consent,
    title,
    body: bodyText,
  };
}

function parseBilingualString(
  raw: unknown,
  existing: { en: string; ar: string } | undefined,
  field: string,
): { en: string; ar: string } {
  if (raw === undefined) {
    if (!existing) throw badRequest('invalid_request', `${field} is required.`);
    return existing;
  }
  if (typeof raw !== 'object' || raw === null) {
    throw badRequest('invalid_request', `${field} must be { en, ar }.`);
  }
  const { en, ar } = raw as Record<string, unknown>;
  return {
    en: requireString(en ?? existing?.en, `${field}.en`, 300),
    /**
     * `ar` MAY BE EMPTY, and that is a declared state rather than sloppiness: "An
     * empty `body.ar` is a legitimate state (document not yet translated) and the
     * client falls back to `en`". `publish` is where that becomes a refusal, and
     * only for a `consent: true` document.
     */
    ar: typeof ar === 'string' ? ar.trim() : (existing?.ar ?? ''),
  };
}

/** "one string per clause, rendered in order" — api-contract.md. */
function parseClauses(
  raw: unknown,
  existing: { en: string[]; ar: string[] } | undefined,
): { en: string[]; ar: string[] } {
  if (raw === undefined) {
    if (!existing) throw badRequest('invalid_request', 'body is required.');
    return existing;
  }
  if (typeof raw !== 'object' || raw === null) {
    throw badRequest('invalid_request', 'body must be { en: string[], ar: string[] }.');
  }
  const { en, ar } = raw as Record<string, unknown>;

  const clauses = (value: unknown, name: string, allowEmpty: boolean): string[] => {
    if (value === undefined) return name === 'en' ? (existing?.en ?? []) : (existing?.ar ?? []);
    if (!Array.isArray(value)) throw badRequest('invalid_request', `body.${name} must be an array.`);
    if (value.length > 200) throw badRequest('invalid_request', `body.${name} has too many clauses.`);
    for (const clause of value) {
      if (typeof clause !== 'string' || clause.trim() === '') {
        throw badRequest(
          'invalid_clause',
          `Every clause in body.${name} must be a non-empty string. One string per clause.`,
        );
      }
      if (clause.length > 4000) {
        throw badRequest('invalid_clause', `A clause in body.${name} is too long.`);
      }
    }
    if (!allowEmpty && value.length === 0) {
      throw badRequest('invalid_request', 'body.en needs at least one clause.');
    }
    return value as string[];
  };

  return { en: clauses(en, 'en', false), ar: clauses(ar, 'ar', true) };
}

function docId(): string {
  return `doc-${Math.random().toString(36).slice(2, 8)}`;
}

export async function registerPolicyRoutes(app: FastifyInstance): Promise<void> {
  /**
   * The console's read. `{ published, draft }` — the shape the contract declares
   * and the customer's route deliberately does not serve.
   */
  app.get('/v1/platform/policies/draft', async (req, reply) => {
    requirePlatform(req, 'policies');
    const [row] = await db.select().from(legalDocumentDraft).limit(1);
    return reply.send({
      docs: row?.docs ?? [],
      updatedBy: row?.updatedBy ?? null,
      updatedAt: row?.updatedAt ? row.updatedAt.toISOString() : null,
    });
  });

  app.post('/v1/platform/policies/draft', async (req, reply) => {
    const p = requirePlatform(req, 'policies');

    const body = (req.body ?? {}) as Record<string, unknown>;
    const doc = parseDoc(body);
    const id = typeof body.id === 'string' && body.id.trim() !== '' ? body.id.trim() : docId();

    const docs = await readDraft();
    if (docs.some((d) => d.id === id)) {
      throw conflict('document_exists', `The draft already has a document called ${id}.`);
    }

    /**
     * APPENDED. "rendered in array order" is the contract's ordering rule, so a new
     * document goes last and `PATCH … { order }` is what moves it. Inserting at a
     * caller-chosen index would be a second way to express order.
     */
    const next = [...docs, { ...doc, id }];
    await writeDraft(next, p.name);

    await writeAudit(db, p, {
      salonId: null,
      kind: 'rules',
      action: 'Policy document drafted',
      detail: `"${doc.title.en}" added to the draft${doc.consent ? ' · consent document' : ''}`,
      source: 'owner_console',
      subjectType: 'legal_document',
      subjectId: id,
      metadata: { scope: doc.scope, consent: doc.consent },
      ipAddress: req.ip ?? null,
      userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
    });

    return reply.code(201).send({ ...doc, id });
  });

  app.patch<{ Params: { docId: string } }>(
    '/v1/platform/policies/draft/:docId',
    async (req, reply) => {
      const p = requirePlatform(req, 'policies');

      const body = (req.body ?? {}) as Record<string, unknown>;
      const allowed = ['title', 'body', 'consent', 'scope', 'order'];
      const unknown = Object.keys(body).filter((k) => !allowed.includes(k));
      if (unknown.length > 0) {
        throw badRequest('invalid_field', `Not editable: ${unknown.join(', ')}.`);
      }

      const docs = await readDraft();
      const index = docs.findIndex((d) => d.id === req.params.docId);
      if (index === -1) throw notFound('unknown_document', 'No such draft document.');
      const existing = docs[index]!;

      const updated = { ...parseDoc(body, existing), id: existing.id };
      const next = [...docs];
      next[index] = updated;

      /**
       * `order` MOVES THE DOCUMENT, and it is a position in the array rather than a
       * stored field — "rendered in array order" means the array IS the order, so a
       * separate `order` column would be a second answer able to disagree with it.
       * Clamped rather than refused: a console dragging a row to the end sends the
       * length, and refusing that would be refusing the gesture.
       */
      if ('order' in body) {
        const raw = body.order;
        if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
          throw badRequest('invalid_order', 'order must be a whole number from 0.');
        }
        const target = Math.min(raw, next.length - 1);
        const [moved] = next.splice(index, 1);
        next.splice(target, 0, moved!);
      }

      await writeDraft(next, p.name);

      await writeAudit(db, p, {
        salonId: null,
        kind: 'rules',
        action: 'Policy draft edited',
        detail: `"${updated.title.en}" · ${Object.keys(body).join(', ')}`,
        source: 'owner_console',
        subjectType: 'legal_document',
        subjectId: updated.id,
        metadata: { changed: Object.keys(body) },
        ipAddress: req.ip ?? null,
        userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
      });

      return reply.send(updated);
    },
  );

  app.delete<{ Params: { docId: string } }>(
    '/v1/platform/policies/draft/:docId',
    async (req, reply) => {
      const p = requirePlatform(req, 'policies');

      const docs = await readDraft();
      const doc = docs.find((d) => d.id === req.params.docId);
      if (!doc) throw notFound('unknown_document', 'No such draft document.');

      /**
       * A DRAFT DOCUMENT IS REALLY DELETED, unlike a product or a happy hour, and
       * the difference is what references it. Nothing does: a draft has never been
       * published, so no `member.policy_version` points at it and no acceptance
       * event names it. The PUBLISHED sets are the record, and they are INSERT-only
       * and kept forever.
       */
      await writeDraft(
        docs.filter((d) => d.id !== req.params.docId),
        p.name,
      );

      await writeAudit(db, p, {
        salonId: null,
        kind: 'rules',
        action: 'Policy draft document removed',
        detail: `"${doc.title.en}" removed from the draft`,
        source: 'owner_console',
        subjectType: 'legal_document',
        subjectId: doc.id,
        metadata: { consent: doc.consent },
        ipAddress: req.ip ?? null,
        userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
      });

      return reply.code(204).send();
    },
  );

  /**
   * PUBLISH. The verb whose absence made #10's re-prompt reachable only from psql.
   *
   * ONE TRANSACTION, and the version is read INSIDE it. `version` is the primary
   * key of `legal_document_set`, so two admins publishing at the same moment would
   * otherwise both compute `max + 1`, and one would get a unique violation — which
   * is the database saving us, but it would reach a human as a 500. Reading under
   * the transaction makes the loser wait and take the next number.
   *
   * THE DRAFT IS EMPTIED, NOT KEPT. After a publish there are no unpublished
   * changes, which is what the console's dirty dot means; leaving the draft
   * populated would show unpublished changes identical to what was just published.
   */
  app.post('/v1/platform/policies/publish', async (req, reply) => {
    const p = requirePlatform(req, 'policies');

    const body = (req.body ?? {}) as Record<string, unknown>;
    const effectiveFrom = requireString(body.effectiveFrom, 'effectiveFrom', 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) {
      throw badRequest('invalid_effective_from', 'effectiveFrom must be YYYY-MM-DD.');
    }

    const today = new Date().toISOString().slice(0, 10);
    if (effectiveFrom < today) {
      /**
       * A set that took effect before it was published is a claim nobody can
       * defend. Refused, unlike the 30-day notice below, because this one needs no
       * judgement about what changed.
       */
      throw badRequest(
        'effective_from_in_the_past',
        'A policy set cannot take effect before it is published.',
      );
    }

    const docs = await readDraft();
    if (docs.length === 0) {
      throw conflict('nothing_to_publish', 'The draft is empty. There are no changes to publish.');
    }

    /**
     * A CONSENT DOCUMENT MUST BE TRANSLATED. api-contract.md: "do not ship a
     * consent document that way." An untranslated NON-consent document is fine and
     * the client falls back to `en`; a consent document is the one a customer must
     * tick to have an account, so shipping it English-only asks an Arabic-reading
     * customer to agree to wording she may not read. Non-negotiable #12.
     */
    const untranslated = docs.filter(
      (d) => d.consent && (d.body.ar.length === 0 || d.title.ar.trim() === ''),
    );
    if (untranslated.length > 0) {
      throw conflict(
        'consent_document_untranslated',
        `A consent document must be published in both languages: ${untranslated
          .map((d) => d.id)
          .join(', ')}.`,
      );
    }

    const noticeDays = Math.round(
      (Date.parse(`${effectiveFrom}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000,
    );

    const published = await db.transaction(async (tx) => {
      const [current] = await tx
        .select({ version: legalDocumentSet.version })
        .from(legalDocumentSet)
        .orderBy(desc(legalDocumentSet.version))
        .limit(1)
        // The lock that serialises two simultaneous publishes onto two versions.
        .for('update');

      const version = (current?.version ?? 0) + 1;

      const [row] = await tx
        .insert(legalDocumentSet)
        .values({
          version,
          effectiveFrom,
          publishedAt: new Date(),
          publishedBy: p.name,
          docs,
        })
        .returning();
      if (!row) throw conflict('publish_failed', 'That publish could not be saved. Try again.');

      // No unpublished changes after a publish. See the header.
      await tx
        .update(legalDocumentDraft)
        .set({ docs: [], updatedBy: p.name, updatedAt: new Date() })
        .where(eq(legalDocumentDraft.id, 'avo'));

      /**
       * "which must be written to the platform audit log" — api-contract.md, on
       * publish specifically. `salonId: null`, so it is platform-wide and invisible
       * to every merchant: the audit read's `salon_id = $1` predicate excludes null
       * without anybody having to remember to.
       *
       * `noticeDays` is IN THE ROW. The 30-day promise cannot be enforced by a
       * server that cannot tell a typo fix from a change of liability, so what the
       * log can do is record how much notice was actually given — which is the
       * question anybody auditing the promise will ask.
       */
      await writeAudit(tx, p, {
        salonId: null,
        kind: 'rules',
        action: 'Policy set published',
        detail:
          `v${version} effective ${effectiveFrom} · ${docs.length} document(s) · ` +
          `${noticeDays} day(s) notice` +
          (noticeDays < MATERIAL_NOTICE_DAYS
            ? ` · UNDER the ${MATERIAL_NOTICE_DAYS}-day notice the terms promise for a material change`
            : ''),
        source: 'owner_console',
        subjectType: 'legal_document_set',
        subjectId: String(version),
        metadata: {
          version,
          effectiveFrom,
          noticeDays,
          documents: docs.map((d) => ({ id: d.id, consent: d.consent, scope: d.scope })),
          consentDocuments: docs.filter((d) => d.consent).map((d) => d.id),
        },
        ipAddress: req.ip ?? null,
        userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
      });

      return row;
    });

    /**
     * `noticeDays` AND `noticeShortfall` ON THE RESPONSE, because the console is
     * where the judgement is made and it cannot make it without the number. Sibling
     * keys on the envelope rather than fields on the set, so a client parsing
     * `body.published` with `LegalDocumentSetSchema` gets exactly the contract's
     * shape and nothing is stripped.
     */
    return reply.code(201).send({
      published: {
        version: published.version,
        effectiveFrom: published.effectiveFrom,
        publishedAt: published.publishedAt.toISOString(),
        publishedBy: published.publishedBy,
        docs: published.docs,
      },
      noticeDays,
      noticeShortfall: Math.max(0, MATERIAL_NOTICE_DAYS - noticeDays),
    });
  });

  /**
   * DISCARD. "Editing writes to `draft`; nothing reaches a phone until publish" —
   * so discarding is the escape hatch that makes editing safe, and it resets the
   * draft to EMPTY rather than to a copy of the published set.
   *
   * Empty is the honest representation of "no unpublished changes": a draft holding
   * a copy of what is published would show the console a dirty dot for a difference
   * that does not exist, and `publish` would then republish identical text as a new
   * version, which bumps `member.policy_version` for every customer and re-prompts
   * all of them for nothing. That is #10's re-prompt fired by an accident of
   * representation.
   */
  app.post('/v1/platform/policies/discard', async (req, reply) => {
    const p = requirePlatform(req, 'policies');

    const docs = await readDraft();
    if (docs.length === 0) {
      throw conflict('nothing_to_discard', 'There are no unpublished changes.');
    }

    await writeDraft([], p.name);

    await writeAudit(db, p, {
      salonId: null,
      kind: 'rules',
      action: 'Policy draft discarded',
      detail: `${docs.length} unpublished document(s) discarded`,
      source: 'owner_console',
      subjectType: 'legal_document_set',
      subjectId: 'draft',
      metadata: { discarded: docs.map((d) => d.id) },
      ipAddress: req.ip ?? null,
      userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
    });

    return reply.code(204).send();
  });
}
