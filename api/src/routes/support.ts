/**
 * Support — non-negotiable #11, both halves of it.
 *
 *   GET    /v1/platform/support                  any authenticated principal
 *   PATCH  /v1/platform/support/channels         console · policies
 *   POST   /v1/platform/support/topics           console · policies
 *   PATCH  /v1/platform/support/topics/{id}      console · policies
 *   DELETE /v1/platform/support/topics/{id}      console · policies
 *   POST   /v1/support/tickets                   the customer
 *   GET    /v1/support/tickets?route=&status=    console · policies  OR  merchant · perms.dashboard
 *   PATCH  /v1/support/tickets/{id}              same two audiences, same boundary
 *
 * THIS FILE EXISTS BECAUSE THE WRITE SIDE OF #11 DID NOT.
 *
 * "Support ticket routing is resolved server-side from `topicId`. A client-supplied
 * route can land a wallet dispute in a salon's inbox." The read half has been right
 * since it was written — `POST /v1/support/tickets` takes `route` from the topic row
 * and never from the body. But the route a ticket inherits is a property of the
 * TOPIC, and until now nothing could set it: there was no topic editor, so #11's
 * subject was reachable only from psql. The console's Support panel had a read and
 * no remedy — the same shape `routes/platformConsole.ts` records for the Salons
 * section, where a guard named a screen that could not do the thing it was named
 * for.
 *
 * TWO HANDLERS MOVED HERE UNCHANGED from `routes/platform.ts` —
 * `GET /v1/platform/support` and `POST /v1/support/tickets`, with `ticketId`,
 * `TICKET_DEDUPE_MINUTES` and `serialiseTicket`. That file's header says
 * "promotions, the published legal set, support", and the same argument it makes
 * about campaigns applies here: support is now a config editor, a reorderable topic
 * list, two staffed queues and a tenancy boundary that no other route in this API
 * has. That is not one section of a file about promotions.
 *
 * AVO OWNS THE CHANNELS AND THE TOPICS, NOT THE SALON. `design/README.md`: "a salon
 * cannot redirect customers to an unmonitored number". So every write above the
 * ticket line is `requirePlatform`, and there is deliberately no merchant door onto
 * `support_config` or `support_topic` at all — not a gated one, not one. A merchant
 * who could edit a topic's route could route "a charge I do not recognise" to
 * herself and answer the disputes she is the subject of; a merchant who could edit
 * the WhatsApp number could take AVO's escalation path away from her customers.
 */

import { and, asc, desc, eq, getTableColumns, gte, inArray, sql, type SQL } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  requireDashboardPerm,
  requireMember,
  requirePlatform,
  requirePrincipal,
  type PlatformPrincipal,
  type StaffPrincipal,
} from '../auth/principal';
import { badRequest, conflict, forbidden, notFound } from '../http/errors';
import { E164, requireEmail } from '../http/fields';
import { requireString } from '../money/validate';
import { writeAudit } from '../services/audit';
import {
  afterCursor,
  cursorInstant,
  encodeCursor,
  parseCursor,
} from '../services/streamCursor';
import { ticketId } from '../services/ids';
import { enforceTicketLimits } from '../services/supportLimit';
import { db } from '../db/client';
import { supportConfig, supportTicket, supportTopic } from '../db/schema/legal';
import { member } from '../db/schema/member';
import { transaction } from '../db/schema/transaction';

/** api-contract.md rule 5: "Deduplicate an identical message inside 5 minutes". */
const TICKET_DEDUPE_MINUTES = 5;

const ROUTES = ['salon', 'avo'] as const;
type TicketRoute = (typeof ROUTES)[number];

const STATUSES = ['open', 'closed'] as const;
type TicketStatus = (typeof STATUSES)[number];

/** A queue page. The design draws a list, not five lines — see the cursor note below. */
const TICKET_MAX_LIMIT = 100;
const TICKET_DEFAULT_LIMIT = 50;

/**
 * ONE STREAM, SO ONE RANK. `services/streamCursor.ts` keys on `(at, stream, id)`
 * because two of its three callers merge several tables; this one does not, so its
 * rank is a constant. Kept rather than special-cased: a second cursor format for
 * the single-table case is a second thing to get the microsecond truncation wrong
 * in, which is exactly how that file came to exist.
 */
const TICKET_RANK = 0;

// ===========================================================================
// SERIALISERS
// ===========================================================================

/**
 * api-contract.md § SupportTicket. `member` is the customer's NAME, which the
 * contract carries beside `memberId` so a staffed queue can render a person
 * rather than an id.
 *
 * `salonId` IS ON THE WIRE and the contract does not list it — a reported addition,
 * on exactly the argument `services/auditRead.ts` makes for the same field: the
 * console's queue crosses every tenant, so a row that does not say which salon it
 * came from cannot be rendered. It is not a leak on the merchant's side, because
 * every row she can see carries her own salon id by construction.
 *
 * NAMES ARE RESOLVED IN ONE QUERY for the whole page. The single-row form below is
 * the wrapper, not the other way round: it was a per-row `SELECT` when the only
 * caller was `POST /v1/support/tickets` returning one ticket, and a fifty-row queue
 * would have made that fifty round trips.
 */
async function serialiseTickets(rows: (typeof supportTicket.$inferSelect)[]) {
  const ids = [...new Set(rows.map((r) => r.memberId))];
  const names = new Map<string, string>();
  if (ids.length > 0) {
    const found = await db
      .select({ id: member.id, name: member.name })
      .from(member)
      .where(inArray(member.id, ids));
    for (const m of found) names.set(m.id, m.name);
  }

  const topicIds = [...new Set(rows.map((r) => r.topicId))];
  const labels = new Map<string, { en: string; ar: string }>();
  if (topicIds.length > 0) {
    const found = await db
      .select({ id: supportTopic.id, en: supportTopic.en, ar: supportTopic.ar })
      .from(supportTopic)
      .where(inArray(supportTopic.id, topicIds));
    for (const t of found) labels.set(t.id, { en: t.en, ar: t.ar });
  }

  return rows.map((row) => ({
    id: row.id,
    memberId: row.memberId,
    member: names.get(row.memberId) ?? '',
    salonId: row.salonId,
    topicId: row.topicId,
    /**
     * THE LABEL, JOINED — a contract addition, reported, and the thing that makes
     * the soft delete coherent from the queue.
     *
     * `DELETE …/topics/{id}` retires a topic rather than removing it, so the
     * console's topic list (active only) stops containing it while tickets filed
     * under it keep pointing at it. A queue that carried only `topicId` would then
     * render a bare slug — `visit` — for exactly the tickets a retired topic
     * produced, which is the dangling-reference problem the soft delete was chosen
     * to avoid, moved one layer up into the UI.
     *
     * JOINED AND NOT SNAPSHOTTED, which is the opposite of what `route` does two
     * fields down, and the asymmetry is the point. `db/schema/legal.ts` snapshots
     * the route because "a ticket that silently changed queue afterwards would be a
     * customer's dispute changing hands with no record of it" — a route is a
     * DECISION about the ticket. A label is WORDING: a console admin fixing a typo
     * or adding the Arabic should fix it on every ticket, not leave the old spelling
     * frozen into the queue.
     */
    topic: labels.get(row.topicId) ?? { en: row.topicId, ar: '' },
    /** Resolved server-side from the topic. Never echoed from the request. */
    route: row.route,
    message: row.message,
    ref: row.ref,
    transactionId: row.transactionId,
    via: row.via,
    at: row.createdAt.toISOString(),
    status: row.status,
  }));
}

async function serialiseTicket(row: typeof supportTicket.$inferSelect) {
  const [only] = await serialiseTickets([row]);
  return only!;
}

/**
 * api-contract.md § SupportTopic. `position` is NOT on the wire.
 *
 * "rendered in array order" is the contract's ordering rule, so the array IS the
 * order and a `position` beside it would be a second answer able to disagree with
 * it — the argument `routes/policies.ts` makes for the draft's `order`. The console
 * sends `PATCH … { order }` as an index into the list it was served, and never has
 * to know that a column exists.
 */
function serialiseTopic(row: typeof supportTopic.$inferSelect) {
  return { id: row.id, route: row.route, en: row.en, ar: row.ar };
}

function serialiseChannels(row: typeof supportConfig.$inferSelect) {
  return {
    whatsapp: row.whatsapp,
    email: row.email,
    hoursEn: row.hoursEn,
    hoursAr: row.hoursAr,
    replyEn: row.replyEn,
    replyAr: row.replyAr,
  };
}

// ===========================================================================
// THE TOPIC LIST — one lock, dense positions
// ===========================================================================

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * THE LOCK EVERY TOPIC WRITE TAKES, and it is the `support_config` row.
 *
 * Two admins dragging topics at the same moment is the double-submit shape in
 * another costume, and `support_topic_position_uq` makes the corruption loud rather
 * than silent: a half-applied reorder is a unique violation reaching a human as a
 * 500. So every write below runs inside a transaction that begins here.
 *
 * WHY THE CONFIG ROW AND NOT THE TOPIC ROWS. `SELECT … FROM support_topic FOR
 * UPDATE` locks the rows that exist, which is not the same as locking the LIST: two
 * concurrent `POST`s would each lock the same six rows, yes — but with an empty
 * table they would lock nothing, both compute `position = 0`, and one would take
 * the unique violation. The invariant being protected is a property of the list, so
 * the lock has to be on something that is there when the list is not.
 * `support_config` is a singleton with a CHECK pinning it to one row, and
 * api-contract.md's `SupportConfig` literally CONTAINS `topics` — locking it is
 * locking the object being edited, not a lock object invented for the purpose.
 *
 * The cost is that a channels edit and a topic reorder contend. They are two halves
 * of one panel on one screen; serialising them is the intent, not a side effect.
 *
 * A MISSING CONFIG ROW IS A 409, the same refusal `GET /v1/platform/support`
 * already gives. There is no such thing as a configured topic list on an
 * unconfigured support panel.
 */
async function lockSupport(tx: Tx): Promise<typeof supportConfig.$inferSelect> {
  const [row] = await tx.select().from(supportConfig).for('update').limit(1);
  if (!row) {
    /** 409 — the same code and now the same status as the read. See it for why. */
    throw conflict(
      'support_not_configured',
      'Support channels have not been configured yet.',
    );
  }
  return row;
}

/**
 * Every topic, active first, in render order — read under the lock above.
 *
 * INACTIVE ROWS ARE READ TOO, and they are the reason this returns the whole table
 * rather than the active list. `position` is unique across ALL rows, so a
 * deactivated topic still occupies a number; densifying only the active list would
 * collide with it. The order below — actives by position, then inactives by
 * position — is the order `rewritePositions` writes back, which keeps the active
 * list at `0 … n-1` and parks everything retired above it.
 */
async function readTopics(tx: Tx) {
  return tx
    .select()
    .from(supportTopic)
    .orderBy(desc(supportTopic.active), asc(supportTopic.position));
}

/**
 * Write `0 … n-1` onto the given order, IN TWO PHASES.
 *
 * `support_topic_position_uq` is a plain unique index, so it is checked per row
 * within a statement rather than at commit — there is no `DEFERRABLE` on an index
 * and Postgres will not accept one. That makes the obvious
 * `UPDATE … SET position = position + 1 WHERE position >= 3` fail with a duplicate
 * key on a list it is about to leave perfectly unique. So: park every row on a
 * negative number first (no real position is negative, and the negatives are unique
 * among themselves because the targets are), then flip them positive.
 *
 * Two statements, not two per row: a `CASE` over the id list, one round trip each,
 * and neither can half-apply because both run inside the caller's transaction.
 *
 * THE CHECK CONSTRAINTS PERMIT THE INTERMEDIATE STATE deliberately —
 * `support_topic` constrains `route` and says nothing about the sign of `position`.
 * If a `position >= 0` CHECK is ever added, this function breaks loudly on the
 * first reorder rather than quietly, which is the right way round.
 */
async function rewritePositions(tx: Tx, orderedIds: string[]): Promise<void> {
  if (orderedIds.length === 0) return;

  const ids = sql.join(
    orderedIds.map((id) => sql`${id}`),
    sql`, `,
  );
  /**
   * `::int` ON EVERY BRANCH, and it is not decoration. Postgres has to infer a type
   * for `CASE id WHEN $1 THEN $2 …` and with every arm a bare parameter it settles
   * on `text`, so the statement fails with `column "position" is of type integer but
   * expression is of type text` — which is exactly what the first drive of this
   * function produced. The transaction rolled back and the list was intact, which is
   * the only reason it was a 500 and not a corrupted order.
   */
  const park = sql.join(
    orderedIds.map((id, i) => sql`WHEN ${id} THEN ${-1 - i}::int`),
    sql` `,
  );
  const settle = sql.join(
    orderedIds.map((id, i) => sql`WHEN ${id} THEN ${i}::int`),
    sql` `,
  );

  await tx.execute(
    sql`UPDATE support_topic SET position = CASE id ${park} END WHERE id IN (${ids})`,
  );
  await tx.execute(
    sql`UPDATE support_topic SET position = CASE id ${settle} END WHERE id IN (${ids})`,
  );
}

// ===========================================================================
// THE TICKET QUEUE — the tenancy boundary that has no path segment
// ===========================================================================

/**
 * WHO IS READING A QUEUE, AND WHICH ROWS THEY MAY SEE.
 *
 * `GET /v1/support/tickets` is the one shared read in this API where the tenancy
 * boundary is NOT a path segment. Every other salon-scoped route is
 * `/salons/{id}/…` and answers with `requireSameSalon`, which compares a path id to
 * the principal's. Here there is no id in the path — api-contract.md § Operations
 * lists one endpoint for two audiences, "Owner / Merchant | Support queue" — so the
 * boundary has to be a PREDICATE, applied by this function, and it is the one thing
 * a census over route paths cannot see.
 *
 * The consequence, stated because it is the failure mode: a merchant read with the
 * predicate missing is not a 403 anybody notices, it is a salon quietly reading
 * every other salon's customer correspondence. So the predicate is built HERE, from
 * the principal, and the queries below have no other source of `where`.
 *
 * THREE RULES, and rule 2 of api-contract.md § SupportTicket is two of them:
 * "Salon-routed tickets are visible to the merchant; AVO-routed ones are not."
 *
 *   1. A merchant sees `salon_id = her salon`.        (tenancy)
 *   2. A merchant sees `route = 'salon'`.             (rule 2 — never AVO's queue)
 *   3. `?route=avo` from a merchant is REFUSED, not silently narrowed. She is
 *      asking for the queue she is the subject of; answering with an empty page
 *      would say "AVO has no tickets about you", which is a different and false
 *      statement. `?salon=` naming somebody else is refused for the same reason.
 *
 * A CONSOLE ADMIN GETS NO PREDICATE AT ALL — the absence is the difference, exactly
 * as it is between `GET /salons/{id}/audit` and `GET /v1/platform/audit`. `?route=`
 * and `?salon=` narrow it and widen nothing.
 */
export function queueScope(
  principal: PlatformPrincipal | StaffPrincipal,
  query: { route?: string; status?: string; salon?: string },
): SQL[] {
  const filters: SQL[] = [];

  const route = (query.route ?? '').trim();
  if (route !== '' && !(ROUTES as readonly string[]).includes(route)) {
    throw badRequest('invalid_route', `route must be ${ROUTES.join(' or ')}.`);
  }
  const status = (query.status ?? '').trim();
  if (status !== '' && !(STATUSES as readonly string[]).includes(status)) {
    throw badRequest('invalid_status', `status must be ${STATUSES.join(' or ')}.`);
  }
  const salonFilter = (query.salon ?? '').trim();

  if (principal.kind === 'staff') {
    if (route === 'avo') {
      throw forbidden(
        'Messages routed to AVO support are not visible to the salon. Your queue is the salon-routed one.',
      );
    }
    if (salonFilter !== '' && salonFilter !== principal.salonId) {
      throw forbidden('That salon is not yours.');
    }
    // Rules 1 and 2, and neither is conditional on anything the caller sent.
    filters.push(eq(supportTicket.salonId, principal.salonId));
    filters.push(eq(supportTicket.route, 'salon'));
  } else {
    if (route !== '') filters.push(eq(supportTicket.route, route as TicketRoute));
    if (salonFilter !== '') filters.push(eq(supportTicket.salonId, salonFilter));
  }

  if (status !== '') filters.push(eq(supportTicket.status, status as TicketStatus));

  return filters;
}

/**
 * Either audience, resolved once so the two ticket handlers cannot disagree.
 *
 * THE MERCHANT GATE IS `perms.dashboard`, ON THE DASHBOARD SURFACE, and the
 * argument is the one `routes/activity.ts` makes for the Overview feed. The nine
 * permissions of api-contract.md § StaffUser are dashboard, appointments, shop,
 * loyalty, team, scanner, charges, void, marketing — there is no `support` among
 * them, and the closest fit is not close by accident: `perms.dashboard` is the
 * permission that says "this person may see salon-wide operational information",
 * which is what a customer's message about a visit is. The alternatives are worse
 * for reasons worth writing down: `charges` is scanner-scoped and is "Today's
 * charges ON THE SCANNER", `marketing` is outbound and #8's subject, `team` is
 * authority over staff. A tenth permission is the honest answer, and it is a
 * `packages/types` + schema + console-editor change, i.e. a trunk operation —
 * REPORTED, not invented here.
 *
 * SCANNER PINS ARE OUT, and that is `requireDashboardPerm` doing it rather than a
 * second check: a four-digit PIN on a shared tablet on the salon floor should not
 * open a queue of customers' written complaints, and `SURFACE_COPY.dashboard` says
 * so in the words the design uses.
 *
 * THE CONSOLE GATE IS `policies` — see the section note above
 * `PATCH /v1/platform/support/channels`.
 *
 * A MEMBER IS REFUSED. api-contract.md calls these "staffed queues"; there is no
 * customer-facing ticket list in the contract, and `POST` hands her the id back
 * because rule 4 makes that "the only handle the customer has". Serving her a
 * filtered list would be a new feature, so it is refused rather than guessed at.
 */
function requireQueueReader(req: FastifyRequest): PlatformPrincipal | StaffPrincipal {
  const p = requirePrincipal(req);
  if (p.kind === 'member') {
    throw forbidden(
      'This is a staffed support queue. Your own message is confirmed by its ticket number.',
    );
  }
  if (p.kind === 'platform_admin') return requirePlatform(req, 'policies');
  return requireDashboardPerm(req, 'dashboard');
}

// ===========================================================================
export async function registerSupportRoutes(app: FastifyInstance): Promise<void> {
  /**
   * The Contact us form's channels, hours and topics.
   *
   * Every topic carries its `route`, and serving it is deliberate rather than
   * careless: the client does not USE it — `POST /v1/support/tickets` below ignores
   * any route it is sent — but the wallet does tell the customer who she is writing
   * to ("this goes to the salon" / "this goes to AVO"), and it cannot say that
   * truthfully from a field it was never given. Reading it is fine; sending it back
   * is what #11 forbids.
   *
   * READABLE BY ANY AUTHENTICATED PRINCIPAL, which is why `auth/principal.ts`'s
   * test shim excludes `/v1/platform/support` from its console branch by EXACT
   * match. The three `/topics` and `/channels` writes below are not excluded and
   * resolve to the console principal, which is what they need — that is the
   * prefix-versus-exact distinction that file's own comment records.
   */
  app.get('/v1/platform/support', async (req, reply) => {
    requirePrincipal(req);

    const [channels] = await db.select().from(supportConfig).limit(1);
    if (!channels) {
      /**
       * 409, NOT 503, and this is `services/policy.ts`'s doctrine applied one code
       * short of where it should have been. That file settled the argument for
       * `policies_not_published` — "a configuration state is not a transient
       * unavailability… the clients' 503-to-offline mapping is correct and stays;
       * the fix belongs here" — and then it was applied PER CODE rather than as a
       * rule, so this one kept its 503.
       *
       * Lane C drove the consequence: 503 is in the client's connectivity bucket, so
       * an unconfigured deployment told a console admin "No connection — try again
       * once you're back online" about a server that had just replied, and watched
       * the retry policy spend its budget on an answer no retry can change. Lane C
       * has since keyed its client on shape rather than on a status list, so it reads
       * correctly either way; the point of changing it here is that the doctrine
       * should hold for every configuration state rather than the ones somebody
       * remembered.
       *
       * `messaging_policy_missing` and `calendar_not_configured` moved with it — the
       * sweep, not just the reported case.
       */
      throw conflict(
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
      channels: serialiseChannels(channels),
      topics: topics.map(serialiseTopic),
    });
  });

  /**
   * ============================ THE SECTION GATE ============================
   *
   * `policies`, for all four writes, and the argument is that Support is not its
   * own screen. api-contract.md heads this section "owner console → Policies →
   * Support" and the design puts the panel at the bottom of that screen; the
   * console draws no Support entry in its sidebar. `PLATFORM_SECTIONS` has nine
   * names and none of them is `support`, so the choice is between the section the
   * panel is drawn inside and inventing a tenth.
   *
   * The alternatives, and why not: `controls` is platform switches and money rates
   * (KNET flat fee, card percentage, default deposit) — a WhatsApp number is not a
   * rate; `accounts` is per-user remedies (adjust, reset link) and a topic list is
   * nobody's account; `admins` is authority over console users. `policies` is
   * already the section that owns "text AVO publishes to customers", which is
   * exactly what a support hours string and a topic label are.
   *
   * IT MATCHES THE READ SIDE'S AUTHORITY, which is the property that made
   * `GET /v1/platform/salons` worth regating: an admin who can open the panel can
   * edit the panel, so there is no screen carrying a control that only 403s.
   *
   * NOT KEYED FOR IDEMPOTENCY, and this is `PATCH /v1/platform/settings`'s
   * reasoning rather than an omission: every field is set to an absolute value, so
   * a replay produces the same row and there is no second application to prevent.
   * What a retry can do is overwrite a concurrent edit, which is a lost update and
   * not a double-spend — and the `FOR UPDATE` in `lockSupport` makes two edits
   * serial rather than interleaved.
   */
  app.patch('/v1/platform/support/channels', async (req, reply) => {
    const p = requirePlatform(req, 'policies');

    const body = (req.body ?? {}) as Record<string, unknown>;
    const allowed = ['whatsapp', 'email', 'hoursEn', 'hoursAr', 'replyEn', 'replyAr'];
    const unknown = Object.keys(body).filter((k) => !allowed.includes(k));
    if (unknown.length > 0) {
      throw badRequest('invalid_field', `Not editable: ${unknown.join(', ')}.`);
    }
    const sent = allowed.filter((k) => k in body);
    if (sent.length === 0) {
      throw badRequest('invalid_request', `Send at least one of: ${allowed.join(', ')}.`);
    }

    const patch: Partial<typeof supportConfig.$inferInsert> = {};

    /**
     * THE DESIGN AND THE CONTRACT DISAGREE ABOUT THIS FIELD, and the disagreement
     * is reported rather than settled by quietly picking one.
     *
     * api-contract.md § SupportConfig says "E.164". `design/avo-promotions.js` —
     * the reference implementation of shared platform state, whose shapes and rules
     * CLAUDE.md says to keep — stores `'+965 9008 4408'`, with spaces, and derives
     * the click target separately (`'https://wa.me/' + h.replace(/\D/g, '')`). The
     * seed stores the spaced form too. So the design treats this as a DISPLAY
     * string that reduces to E.164, and the contract treats it as E.164.
     *
     * What happens here satisfies both and loses neither: the value is validated by
     * reducing it the way `parseE164` does and testing the SAME `E164` pattern —
     * one definition of a phone number for this API, imported rather than copied —
     * and then the admin's own spacing is STORED. Normalising instead would
     * silently reformat the seeded number on the first edit anybody made, changing
     * what the wallet's Contact us row renders as a side effect of editing the
     * hours.
     */
    if ('whatsapp' in body) {
      const raw = requireString(body.whatsapp, 'whatsapp', 32);
      if (!E164.test(raw.replace(/[\s-]/g, ''))) {
        throw badRequest(
          'invalid_phone',
          'Enter the number with its country code, like +96599123456.',
        );
      }
      patch.whatsapp = raw;
    }
    if ('email' in body) patch.email = requireEmail(body.email);
    /**
     * The four strings are prose the customer reads — "Saturday to Thursday,
     * 10:00 - 20:00", "Most messages are answered the same working day." Both
     * languages are authored here and neither may be blanked: #12 makes Arabic a
     * first-class layout, and an empty `hoursAr` is not a fallback on this screen,
     * it is a blank line under Contact us. The columns are `NOT NULL` and
     * `requireString` refuses a whitespace-only value, so the two agree.
     */
    if ('hoursEn' in body) patch.hoursEn = requireString(body.hoursEn, 'hoursEn', 200);
    if ('hoursAr' in body) patch.hoursAr = requireString(body.hoursAr, 'hoursAr', 200);
    if ('replyEn' in body) patch.replyEn = requireString(body.replyEn, 'replyEn', 300);
    if ('replyAr' in body) patch.replyAr = requireString(body.replyAr, 'replyAr', 300);

    const updated = await db.transaction(async (tx) => {
      const before = await lockSupport(tx);

      const [row] = await tx
        .update(supportConfig)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(supportConfig.id, before.id))
        .returning();
      if (!row) throw conflict('support_not_updated', 'That change could not be saved. Try again.');

      /**
       * `salonId: null` — a platform action belonging to no single salon, which is
       * what `GET /v1/platform/audit`'s `?salon=platform` filter selects. `rules`
       * rather than `access`: nothing about who may do what changed, a rule the
       * product renders to customers did.
       *
       * The detail names the FIELDS and not the values. A support inbox and a
       * WhatsApp number are not secrets, but "whatsapp · email" is the sentence a
       * reader of this log needs, and `metadata` carries the previous values for
       * the reader who needs to know what it was.
       */
      await writeAudit(tx, p, {
        salonId: null,
        kind: 'rules',
        action: 'Support channels changed',
        detail: sent.join(' · '),
        source: 'owner_console',
        subjectType: 'support_config',
        subjectId: row.id,
        metadata: { changed: sent, from: serialiseChannels(before) },
        ipAddress: req.ip ?? null,
        userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
      });

      return row;
    });

    return reply.send({ channels: serialiseChannels(updated) });
  });

  /**
   * `POST /v1/platform/support/topics` — api-contract.md says `{ en }`.
   *
   * TWO CONTRACT GAPS, BOTH CLOSED IN THE SAFE DIRECTION AND BOTH REPORTED.
   *
   * `route` is `NOT NULL` on the column and absent from the contract's create
   * body, so a new topic has to get one from somewhere. It DEFAULTS TO `'avo'`,
   * because #11 names exactly one direction as the harm — "a client-supplied route
   * can land a wallet dispute in a salon's inbox" — and a default of `'salon'`
   * would send every topic anybody forgot to set there. Sending customers to AVO
   * when the topic was meant for the salon is a misrouted message; the other way
   * round is a merchant answering a complaint about herself. `route` IS accepted on
   * create, because refusing it would make the console's "add a topic and say whose
   * queue it is" gesture two round trips for no gain — it is platform-gated either
   * way, and #11 is about a CUSTOMER's body, not an admin's.
   *
   * `ar` is `NOT NULL` too and also absent from the contract. It defaults to `''`,
   * which api-contract.md § LegalDocumentSet already establishes as the legitimate
   * "not yet translated" state, and is accepted on create for the same reason
   * `route` is. #12 makes an empty Arabic label a thing to FIX before the topic
   * ships, not a thing to refuse at creation.
   *
   * APPENDED, never inserted at a caller-chosen index — `PATCH … { order }` is the
   * one way to express position, the argument `routes/policies.ts` makes for the
   * legal draft.
   *
   * THE ID IS DERIVED FROM `en`, matching the seeded ids (`wallet`, `charge`,
   * `booking`) rather than minting `topic-a1b2c3`: it is the primary key, it is
   * what `support_ticket.topic_id` points at for the life of the ticket, and a
   * console admin reading an audit row wants a word. Collisions take a numeric
   * suffix, resolved under `lockSupport` so two admins adding the same label cannot
   * both take the same slug.
   */
  app.post('/v1/platform/support/topics', async (req, reply) => {
    const p = requirePlatform(req, 'policies');

    const body = (req.body ?? {}) as Record<string, unknown>;
    const allowed = ['en', 'ar', 'route'];
    const unknown = Object.keys(body).filter((k) => !allowed.includes(k));
    if (unknown.length > 0) {
      throw badRequest('invalid_field', `Not settable: ${unknown.join(', ')}.`);
    }

    const en = requireString(body.en, 'en', 120);
    const ar = 'ar' in body ? String(body.ar ?? '').trim().slice(0, 120) : '';
    let route: TicketRoute = 'avo';
    if ('route' in body) {
      const raw = body.route;
      if (raw !== 'salon' && raw !== 'avo') {
        throw badRequest('invalid_route', `route must be ${ROUTES.join(' or ')}.`);
      }
      route = raw;
    }

    const created = await db.transaction(async (tx) => {
      await lockSupport(tx);
      const topics = await readTopics(tx);

      const base =
        en
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 40) || 'topic';
      const taken = new Set(topics.map((t) => t.id));
      let id = base;
      for (let n = 2; taken.has(id); n += 1) id = `${base}-${n}`;

      const activeIds = topics.filter((t) => t.active).map((t) => t.id);
      const retiredIds = topics.filter((t) => !t.active).map((t) => t.id);

      /**
       * The new topic goes at the END OF THE ACTIVE LIST, which is index
       * `activeIds.length` — a position currently held by the first RETIRED row, if
       * there is one. So the insert cannot simply use that number: the whole list is
       * rewritten instead, with the newcomer spliced in at that index, which is the
       * same single code path a reorder takes.
       *
       * WHICH MEANS THE PLACEHOLDER HAS TO MISS BOTH OF `rewritePositions`' RANGES,
       * and getting that wrong is what the first drive of this endpoint found. It
       * parks the list on `-1 … -(n)` and settles it on `0 … n-1`, so a placeholder
       * of `-1` is the slot the FIRST row is about to be parked in — `wallet` took
       * it and the insert's own row was still sitting there, which is a duplicate
       * key on `support_topic_position_uq` from a function whose whole purpose is
       * avoiding one. `n` here is `topics.length + 1`, so anything at or below
       * `-(topics.length + 2)` is outside both ranges by construction.
       *
       * It exists for the length of two statements and is never observable outside
       * this transaction.
       */
      const placeholder = -(topics.length + 2);
      const [row] = await tx
        .insert(supportTopic)
        .values({ id, route, en, ar, position: placeholder, active: true })
        .returning();
      if (!row) throw conflict('topic_not_created', 'That topic could not be added. Try again.');

      await rewritePositions(tx, [...activeIds, id, ...retiredIds]);

      await writeAudit(tx, p, {
        salonId: null,
        kind: 'rules',
        action: 'Support topic added',
        /** The ROUTE is in the sentence, because it is the thing #11 is about. */
        detail: `"${en}" · routed to ${route === 'avo' ? 'AVO support' : 'the salon'}`,
        source: 'owner_console',
        subjectType: 'support_topic',
        subjectId: id,
        metadata: { route, en, ar, position: activeIds.length },
        ipAddress: req.ip ?? null,
        userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
      });

      return row;
    });

    return reply.code(201).send(serialiseTopic(created));
  });

  /**
   * `PATCH /v1/platform/support/topics/{id}` — `{ en | ar | route | order }`.
   *
   * ============ THIS IS THE WRITE SIDE OF NON-NEGOTIABLE #11 ============
   *
   * `route` here is the field `POST /v1/support/tickets` reads INSTEAD of the
   * customer's body. Everything that endpoint refuses to let a client decide is
   * decided here, by a console admin holding `policies`, and the audit row below
   * names the move in both directions because "who sent wallet disputes to the
   * salon" is a question this log has to be able to answer.
   *
   * MOVING A TOPIC DOES NOT MOVE ITS EXISTING TICKETS, and that is
   * `db/schema/legal.ts`'s decision rather than this handler's:
   * `support_ticket.route` is SNAPSHOTTED at creation, because "a ticket that
   * silently changed queue afterwards would be a customer's dispute changing hands
   * with no record of it". The audit row is the record that the future changed; the
   * past stays where it was, and the row's metadata counts how many tickets that
   * is.
   *
   * ============ `order` — A DENSE INDEX, REWRITTEN UNDER A LOCK ============
   *
   * Three shapes were available and this is the one the gesture has. A DRAG is "put
   * this row at index k", which shifts everything between — it is not a SWAP
   * (dropping row 5 on row 1 does not send row 1 to position 5), and a SPARSE
   * integer only postpones the rewrite while making `order` mean two different
   * things: an index into the list the client was served, or a sort weight the
   * client has to compute. `routes/policies.ts` already answers this question for
   * the legal draft with an index, and one product should not hold two answers.
   *
   * So `order` is an index into the ACTIVE list, clamped rather than refused — a
   * console dragging a row to the end sends the length, and refusing that would be
   * refusing the gesture. Positions come back dense at `0 … n-1`, so the index and
   * the stored number are the same fact and cannot disagree.
   *
   * CONCURRENT REORDERS CANNOT CORRUPT THE LIST: `lockSupport` serialises them, so
   * two admins dragging produce one order or the other and never a mix, and
   * `rewritePositions` is two statements inside one transaction, so it cannot
   * half-apply. Without the lock the unique index turns a lost update into a 500 —
   * the database saving us in a way that reaches a human as a crash.
   *
   * A RETIRED TOPIC IS NOT EDITABLE. It is no longer offered on the Contact us
   * form, so reordering it would move a row nobody can see and renaming it would
   * rewrite the subject line of tickets already filed under it. There is no
   * reactivate verb in the contract — reported, and `POST` is the door.
   */
  app.patch<{ Params: { id: string } }>(
    '/v1/platform/support/topics/:id',
    async (req, reply) => {
      const p = requirePlatform(req, 'policies');

      const body = (req.body ?? {}) as Record<string, unknown>;
      const allowed = ['en', 'ar', 'route', 'order'];
      const unknown = Object.keys(body).filter((k) => !allowed.includes(k));
      if (unknown.length > 0) {
        throw badRequest('invalid_field', `Not editable: ${unknown.join(', ')}.`);
      }
      const sent = allowed.filter((k) => k in body);
      if (sent.length === 0) {
        throw badRequest('invalid_request', `Send at least one of: ${allowed.join(', ')}.`);
      }

      const patch: Partial<typeof supportTopic.$inferInsert> = {};
      if ('en' in body) patch.en = requireString(body.en, 'en', 120);
      /** Blankable, unlike `en`: "not yet translated" is a real state. */
      if ('ar' in body) patch.ar = String(body.ar ?? '').trim().slice(0, 120);
      if ('route' in body) {
        const raw = body.route;
        if (raw !== 'salon' && raw !== 'avo') {
          throw badRequest('invalid_route', `route must be ${ROUTES.join(' or ')}.`);
        }
        patch.route = raw;
      }
      let requestedOrder: number | null = null;
      if ('order' in body) {
        const raw = body.order;
        if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
          throw badRequest('invalid_order', 'order must be a whole number from 0.');
        }
        requestedOrder = raw;
      }

      const result = await db.transaction(async (tx) => {
        await lockSupport(tx);
        const topics = await readTopics(tx);

        const existing = topics.find((t) => t.id === req.params.id);
        if (!existing) throw notFound('unknown_topic', 'No such support topic.');
        if (!existing.active) {
          throw conflict(
            'topic_retired',
            'That topic has been retired and is no longer offered. Add a new one instead.',
          );
        }

        const [row] = await tx
          .update(supportTopic)
          .set({ ...patch, updatedAt: new Date() })
          .where(eq(supportTopic.id, existing.id))
          .returning();
        if (!row) throw conflict('topic_not_updated', 'That change could not be saved. Try again.');

        const active = topics.filter((t) => t.active).map((t) => t.id);
        let index = active.indexOf(existing.id);
        if (requestedOrder !== null) {
          const target = Math.min(requestedOrder, active.length - 1);
          active.splice(index, 1);
          active.splice(target, 0, existing.id);
          index = target;
          await rewritePositions(tx, [
            ...active,
            ...topics.filter((t) => !t.active).map((t) => t.id),
          ]);
        }

        const rerouted = patch.route !== undefined && patch.route !== existing.route;
        /**
         * How many tickets ALREADY point at this topic and keep the old route. The
         * snapshot decision above is invisible from the row otherwise, and this is
         * the number a reader needs in order to know it happened.
         */
        let keepingOldRoute = 0;
        if (rerouted) {
          const [counted] = await tx
            .select({ n: sql<number>`count(*)::int` })
            .from(supportTicket)
            .where(eq(supportTicket.topicId, row.id));
          keepingOldRoute = counted?.n ?? 0;
        }

        /**
         * A ROUTE CHANGE IS NAMED SEPARATELY from a label edit, in the same log.
         * "Support topic edited · en" and "Support topic rerouted · salon → avo"
         * are different events to somebody reconciling where a dispute went, and
         * collapsing both into one action string would make the second
         * unsearchable — `auditSearchPredicate` matches `action` and `detail`.
         */
        await writeAudit(tx, p, {
          salonId: null,
          kind: 'rules',
          action: rerouted ? 'Support topic rerouted' : 'Support topic edited',
          detail: rerouted
            ? `"${row.en}" · ${existing.route} → ${row.route}`
            : `"${row.en}" · ${sent.join(', ')}`,
          source: 'owner_console',
          subjectType: 'support_topic',
          subjectId: row.id,
          metadata: {
            changed: sent,
            ...(rerouted
              ? {
                  routeFrom: existing.route,
                  routeTo: row.route,
                  ticketsKeepingOldRoute: keepingOldRoute,
                }
              : {}),
            ...(requestedOrder !== null ? { order: index } : {}),
          },
          ipAddress: req.ip ?? null,
          userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
        });

        return row;
      });

      return reply.send(serialiseTopic(result));
    },
  );

  /**
   * `DELETE /v1/platform/support/topics/{id}` — a SOFT delete, and the database
   * settles that rather than a preference.
   *
   * `support_ticket.topic_id` references this row `onDelete: 'restrict'`, so a hard
   * delete of a topic anybody has ever written under fails at the foreign key. That
   * restrict is right: a ticket whose topic vanished is a dispute nobody can say
   * what it was about, seven years after the fact. `active` exists for exactly this
   * and the customer read already filters on it — the topic disappears from the
   * Contact us form and every existing ticket keeps its subject.
   *
   * IT IS NOT IN TRUNK'S BRIEF and it IS in api-contract.md line 559, beside the
   * four writes that were. Built, and the discrepancy reported.
   *
   * THE LAST ACTIVE TOPIC CANNOT BE RETIRED. `POST /v1/support/tickets` requires a
   * known active `topicId` and refuses an unknown one by naming the list; with an
   * empty list that refusal names nothing and the wallet's Contact us form has no
   * option to offer. A console admin deleting her way to a support form nobody can
   * submit should be told, not obeyed.
   *
   * 204, no body — `DELETE /v1/platform/policies/draft/{docId}`'s shape.
   */
  app.delete<{ Params: { id: string } }>(
    '/v1/platform/support/topics/:id',
    async (req, reply) => {
      const p = requirePlatform(req, 'policies');

      await db.transaction(async (tx) => {
        await lockSupport(tx);
        const topics = await readTopics(tx);

        const existing = topics.find((t) => t.id === req.params.id);
        if (!existing) throw notFound('unknown_topic', 'No such support topic.');
        /** Already retired. Idempotent rather than a 404 — the state asked for holds. */
        if (!existing.active) return;

        const active = topics.filter((t) => t.active);
        if (active.length <= 1) {
          throw conflict(
            'last_topic',
            'This is the only topic left. The Contact us form needs at least one, so add its replacement first.',
          );
        }

        await tx
          .update(supportTopic)
          .set({ active: false, updatedAt: new Date() })
          .where(eq(supportTopic.id, existing.id));

        /** Densify what is left, and park the retired row above it. See `readTopics`. */
        await rewritePositions(tx, [
          ...active.filter((t) => t.id !== existing.id).map((t) => t.id),
          ...topics.filter((t) => !t.active).map((t) => t.id),
          existing.id,
        ]);

        const [counted] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(supportTicket)
          .where(eq(supportTicket.topicId, existing.id));

        await writeAudit(tx, p, {
          salonId: null,
          kind: 'rules',
          action: 'Support topic retired',
          detail: `"${existing.en}" is no longer offered on the Contact us form`,
          source: 'owner_console',
          subjectType: 'support_topic',
          subjectId: existing.id,
          /** Not deleted, and the row says so — plus what still points at it. */
          metadata: {
            softDelete: true,
            route: existing.route,
            existingTickets: counted?.n ?? 0,
          },
          ipAddress: req.ip ?? null,
          userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
        });
      });

      return reply.code(204).send();
    },
  );

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
   * TRUNK ASKED WHETHER THIS ACCEPTS A CLIENT ROUTE TODAY. It does not, and never
   * has: `body.route` appears nowhere in this handler and `topic.route` is the only
   * source. That was checked by driving it — `POST` with `route: 'salon'` against
   * the AVO-routed `wallet` topic, and the stored row read back out of SQL rather
   * than out of the reply — not by reading this comment. The standing assertion is
   * owed to Lane D, which is where an endpoint-level spec lives; a unit spec in this
   * package touches no database (`api/vitest.config.ts` points `DATABASE_URL` at
   * port 1 on purpose).
   *
   * The topic must EXIST. An unknown `topicId` is a 400 naming the list rather than
   * a ticket routed to a default, because "route it somewhere sensible" is the
   * decision this endpoint exists to take away from guesswork.
   *
   * RULE 5 IS TWO RULES — "Rate-limit per member. Deduplicate an identical message
   * inside 5 minutes rather than opening a second ticket." — and only the second
   * was built. The dedupe: a double-tapped Send is the scanner's double scan in
   * another costume, and the customer gets the SAME ticket id back, because two
   * reference numbers for one question is a customer told two different things by
   * two different agents. The limiter is `services/supportLimit.ts`, added when
   * trunk reported the missing half out of Lane D's reading, and it keys on the
   * member and counts `support_ticket` rather than inventing a fourth attempt
   * table — see that file for why it runs where it does.
   *
   * RULE 3 — a `ref` matching one of HER OWN transactions is linked. Scoped to her:
   * an unscoped lookup would let anyone confirm whether a receipt number exists by
   * watching whether it linked.
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
      /**
       * AN EMPTY LIST GETS A DIFFERENT SENTENCE, because the general one degrades
       * into `Pick a topic from the list: .` — a customer told to choose from a bare
       * period. Lane C found it. `DELETE …/topics/{id}` refuses to retire the last
       * active topic precisely so this cannot be reached by an admin's own edits, so
       * what is left is an unseeded deployment: the same condition
       * `support_not_configured` names one function up, and the same answer.
       */
      if (known.length === 0) {
        throw conflict(
          'support_not_configured',
          'Support is not taking messages yet. Reach us on WhatsApp in the meantime.',
        );
      }
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

    /**
     * RULE 5'S OTHER HALF, and it is here rather than at the top of the handler on
     * purpose — `services/supportLimit.ts` carries the argument. Short version: the
     * dedupe above returns an existing ticket and creates nothing, so a limiter in
     * front of it would charge a customer for a double-tapped Send that this
     * endpoint is specifically built to absorb. The check sits immediately before
     * the only statement that can add a row to a staffed queue.
     */
    await enforceTicketLimits(db, p.id);

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
        id: ticketId,
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
     * readable by any merchant holding the right permission. A customer's support
     * message — very often a complaint ABOUT that merchant, and routed to AVO
     * precisely so the merchant does not see it — has no business in it. The
     * ticket row is its own record.
     */
    return reply.send(await serialiseTicket(row));
  });

  /**
   * `GET /v1/support/tickets?route=&status=` — the staffed queues.
   *
   * ONE ENDPOINT, TWO AUDIENCES, AND THE BOUNDARY IS A PREDICATE. The whole of that
   * argument is above `queueScope`, and it is the part of this slice most worth
   * reading: this is the only shared read in the API whose tenancy check is not a
   * path segment, so no census over route paths can see it and no `requireSameSalon`
   * appears in this handler at all.
   *
   * CURSOR PAGINATION IN THE `auditRead` SHAPE — `limit + 1`, keyed on the last row
   * delivered, newest first. `routes/activity.ts` deliberately has NO cursor because
   * the Overview draws five lines with no "load more"; a queue is the opposite
   * screen. The key is `(created_at, id)` rather than a `seq`, because
   * `support_ticket` has no serial.
   *
   * THE PAIR IS NEEDED, NOT JUST THE TIMESTAMP, and the reason is not hypothetical:
   * every row written inside one transaction shares `now()`, so a charge and the
   * ticket somebody files about it can land on the same instant, and four rows
   * sharing a microsecond is what the fixture that found the truncation bug looked
   * like. `parseAuditCursor` records what a tiebreak-free ordering is for; `seq`
   * gives the audit log one for free and this table has to build it. The id breaks
   * the tie, so no row can straddle a page boundary and either repeat or vanish.
   *
   * THE TIMESTAMP HALF COMES FROM POSTGRES, NOT FROM `at`, and
   * `services/streamCursor.ts` carries what happened when it did not: this endpoint
   * is where the truncation was found, and that file was extracted from the fix.
   *
   * `total` is counted against the FILTER and not the page, so the console's
   * counter does not shrink as it pages — `GET /v1/platform/audit`'s reasoning.
   */
  app.get<{
    Querystring: {
      route?: string;
      status?: string;
      salon?: string;
      limit?: string;
      cursor?: string;
    };
  }>('/v1/support/tickets', async (req, reply) => {
    const p = requireQueueReader(req);

    const rawLimit =
      req.query.limit === undefined ? TICKET_DEFAULT_LIMIT : Number(req.query.limit);
    if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > TICKET_MAX_LIMIT) {
      throw badRequest(
        'invalid_limit',
        `limit must be a whole number between 1 and ${TICKET_MAX_LIMIT}.`,
      );
    }

    const scope = queueScope(p, req.query);
    const where = scope.length > 0 ? and(...scope) : undefined;

    const cursor = parseCursor(req.query.cursor, [TICKET_RANK]);
    const after = afterCursor(cursor, TICKET_RANK, supportTicket.createdAt, supportTicket.id);
    const pageWhere =
      after === undefined ? where : where === undefined ? after : and(where, after);

    const rows = await db
      /** The row, plus the exact instant Postgres will accept back. */
      .select({ ...getTableColumns(supportTicket), cursorAt: cursorInstant(supportTicket.createdAt) })
      .from(supportTicket)
      .where(pageWhere)
      /**
       * `id ASC` inside one instant, matching `afterCursor`'s `id > cursorId`. The
       * two have to agree or a page boundary inside a same-microsecond group either
       * repeats a row or loses one — the ordering and the predicate are one decision.
       */
      .orderBy(desc(supportTicket.createdAt), asc(supportTicket.id))
      .limit(rawLimit + 1);

    const page = rows.slice(0, rawLimit);
    const hasMore = rows.length > rawLimit;

    const [counted] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(supportTicket)
      .where(where);

    const last = page[page.length - 1];
    return reply.send({
      items: await serialiseTickets(page),
      total: counted?.total ?? 0,
      nextCursor:
        hasMore && last
          ? encodeCursor({ at: last.cursorAt, rank: TICKET_RANK, id: last.id })
          : null,
    });
  });

  /**
   * `PATCH /v1/support/tickets/{id}` — `{ status }`, and nothing else is editable.
   *
   * THE SAME BOUNDARY AS THE READ, BUILT FROM THE SAME FUNCTION. A merchant may
   * only close a salon-routed ticket belonging to her own salon, and the check is
   * `queueScope`'s predicate applied to one id rather than a second copy of the
   * rule — a write able to reach a row the read cannot is the defect this endpoint
   * would otherwise introduce. An AVO-routed ticket is INVISIBLE to her, so she is
   * told `404` and not `403`: a 403 would confirm that a ticket with that id exists
   * and that AVO is handling it, which is the fact rule 2 withholds.
   *
   * IDEMPOTENT. Closing a closed ticket returns it unchanged — a double-tapped
   * Close is the same gesture as a double-tapped Send, which rule 5 already answers
   * for the customer's side.
   *
   * NOBODY IS RECORDED AS HAVING CLOSED IT, and that is a gap rather than a
   * decision: `support_ticket` has no `closed_by` and no `closed_at`, and there is
   * no audit row here for the reason `POST` gives above — a customer's complaint
   * about a merchant does not belong in a log that merchant can read. So "who
   * closed this" is currently unanswerable. It needs a column, which needs a
   * migration and a contract line, so it is REPORTED rather than invented here.
   */
  app.patch<{ Params: { id: string } }>('/v1/support/tickets/:id', async (req, reply) => {
    const p = requireQueueReader(req);

    const body = (req.body ?? {}) as Record<string, unknown>;
    const unknown = Object.keys(body).filter((k) => k !== 'status');
    if (unknown.length > 0) {
      throw badRequest('invalid_field', `Not editable: ${unknown.join(', ')}.`);
    }
    const status = body.status;
    if (status !== 'open' && status !== 'closed') {
      throw badRequest('invalid_status', `status must be ${STATUSES.join(' or ')}.`);
    }

    /**
     * The scope predicate with NONE of the caller's own filters on it — a merchant
     * closing an open ticket must not have to have been filtering for open ones,
     * and `?route=` is not a thing a PATCH carries. What survives is exactly the
     * tenancy half: her salon, salon-routed.
     */
    const scope = queueScope(p, {});
    const [existing] = await db
      .select()
      .from(supportTicket)
      .where(and(eq(supportTicket.id, req.params.id), ...scope))
      .limit(1);
    if (!existing) throw notFound('unknown_ticket', 'No such support ticket.');

    if (existing.status === status) return reply.send(await serialiseTicket(existing));

    const [row] = await db
      .update(supportTicket)
      .set({ status, updatedAt: new Date() })
      .where(eq(supportTicket.id, existing.id))
      .returning();
    if (!row) throw conflict('ticket_not_updated', 'That change could not be saved. Try again.');

    return reply.send(await serialiseTicket(row));
  });
}
