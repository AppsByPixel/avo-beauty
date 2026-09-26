/**
 * THE BELL — what it contains, and who may see each row of it.
 *
 * Aftab's item 4: *"Notification bell on top right"*. The bell itself is lane C's;
 * `merchant_notification` has been written to since phase 6 and NO ENDPOINT HAS
 * EVER READ IT. There is a live unread row on the demo database — *"Rana
 * Al-Sabah's calendar is not connected"* — that no surface in the product can
 * show. This module is the half that was missing, and it is a service rather than
 * a handler because the two decisions in it are not about routing.
 *
 * =========================================================================
 * DECISION 1 — THE FEED IS FILTERED TO THE KINDS THE READER MAY SEE.
 * =========================================================================
 * Not gated on the union, not ungated. Both alternatives are wrong in a way the
 * register has already written down once, so the argument is worth keeping whole.
 *
 * THE THREE KINDS SIT BEHIND THREE DIFFERENT PERMISSIONS, and they are not three
 * views of one thing:
 *
 *   calendar_disconnected   an artist's hours        subject `artist`    → team
 *   booking_no_show         an appointment, a member's NAME, a deposit
 *                                                    subject `booking`   → appointments
 *   campaign_held           a marketing send         subject `campaign`  → marketing
 *
 * Each one maps onto the permission that already gates the SCREEN its deep link
 * points at — `/merchant/team/:id`, `/merchant/appointments/:id`,
 * `/marketing/campaigns`. That is not a coincidence to be admired; it is the whole
 * reason the mapping is defensible. A notification is a call to an action, and if
 * the reader cannot reach the screen where the action is taken, the notification is
 * not information, it is a link to a 403.
 *
 * GATING THE BELL ON THE UNION IS THE OBVIOUS SAFE ANSWER AND IT IS WRONG.
 * `team AND appointments AND marketing` would hide a merchant's own no-shows from
 * her because she does not hold `marketing`. The seeded frontdesk `ST-002` holds
 * `appointments` and not `team`; the nine permissions are NOT ORDERED —
 * `routes/customers.ts` establishes that against this exact pair — so there is no
 * "widest" grant that makes a union cheap. A union on chrome that appears on every
 * screen means the bell is empty for almost everybody.
 *
 * GATING ON NOTHING LEAKS, and the leak is concrete rather than theoretical. The
 * `booking_no_show` body is `services/noShowWorker.ts:168`: *"${m.name} did not
 * arrive for her appointment, and the ${…} KD deposit has been returned to her
 * wallet."* A customer's name and a money fact, in a string, on a control in the
 * chrome of every screen — reachable by a stylist who holds `scanner` and nothing
 * else. Non-negotiable #7, and decision 96's sentence: *"customer PII must not ride
 * on the weakest gate a screen happens to sit behind."* An ungated bell is that
 * sentence with the weakest gate being NO gate.
 *
 * SO: FILTER. And the objection to filtering is real and is accepted rather than
 * argued away — the unread count now DIFFERS PER STAFF MEMBER, and two people
 * looking at the same salon see different bells.
 *
 * WHY THAT IS CORRECT HERE AND WAS NOT CORRECT ON THE CUSTOMER CARD. The card
 * refusal in `routes/customers.ts` looks like the same join and is a different
 * shape, and getting this wrong in either direction is the risk:
 *
 *   A CARD IS ONE OBJECT. Serving it with `nextBooking` omitted because the
 *       reader lacks `appointments` does not produce a smaller truth, it produces
 *       a FALSE one — the card reads "no upcoming appointment" when it means "you
 *       may not be told". There is no honest partial card, so the join had to
 *       resolve to one permission, and `team` and `appointments` being unordered
 *       meant that permission was BOTH. Hence the refusal.
 *
 *   A FEED IS A SET. A set narrowed to the elements the reader may see is still a
 *       true statement about those elements. Nothing in it is misrepresented;
 *       there is simply less of it. That is what every list in this API already
 *       does on the TENANCY axis — `GET /salons/:id/bookings` does not show
 *       another salon's bookings and nobody calls that a hole. This is the same
 *       mechanism on the PERMISSION axis.
 *
 *   BUT A SET CAN LIE BY OMISSION, which is the one thing that had to be fixed
 *       to make the analogy hold. "You're all caught up." — the design's empty
 *       state, `AVO Merchant Dashboard.dc.html:110` — is FALSE when it means "the
 *       two things waiting for this salon are both things you may not see." So
 *       the response carries `visibleKinds`. An empty feed with all three kinds
 *       visible is genuinely quiet; an empty feed with one kind visible is a
 *       narrower claim, and the client can say so. The filter is declared on the
 *       wire rather than being a silent property of the reader.
 *
 * A READER WHO HOLDS NONE OF THE THREE gets `200` with `items: []` and
 * `visibleKinds: []`, not `403`. She is legitimately signed in to the dashboard;
 * the bell is chrome on every screen, and a 403 on chrome makes every screen look
 * broken for someone whose account is working exactly as configured. Zero rows is
 * the honest answer and `visibleKinds: []` is what distinguishes it from quiet.
 *
 * CONSEQUENCE FOR THE PERMISSION CENSUS, STATED SO IT IS NOT MISREAD. These routes
 * carry NO `requireDashboardPerm` call, so `permission-census.test.ts` will pin
 * them as `[requireDashboardScope]` — which that ledger's own header calls "a
 * legitimate shape… and a bug for a merchant write", and adds that "whether it
 * should have carried a permission is a judgement this scanner cannot make and a
 * reviewer reading the new ledger line can." This is the reviewer's note: the
 * permission enforcement for these two routes IS `visibleKinds` below, it is not a
 * missing gate, and it is driven by request in
 * `routes/merchantNotifications.int.test.ts` § "permission-off, per kind" rather
 * than by the census's generated sweep, which can only revoke a permission an
 * endpoint names.
 *
 * =========================================================================
 * DECISION 2 — READ AND RESOLVED ARE DIFFERENT, AND THE CONTRACT SAYS SO.
 * =========================================================================
 * The schema models both and nothing had ever had to choose between them.
 *
 *   THE FEED CONTAINS BOTH. Every row, resolved or not, newest first, each
 *       carrying its own `readAt` and `resolvedAt`. A calendar that reconnects
 *       before anyone looks is exactly the case in the brief, and dropping the row
 *       on resolve is the small dishonesty it names: a merchant who saw a red
 *       badge, got pulled away, and came back to an empty panel learns nothing and
 *       stops trusting the bell. She should find the row, struck through, saying
 *       what happened and that it is over.
 *
 *   THE COUNT IS UNREAD **AND** UNRESOLVED. `read_at IS NULL AND resolved_at IS
 *       NULL`. The badge is a demand for attention, and a resolved row demands
 *       none — the calendar is back, the campaign sent. So the self-resolving row
 *       correctly never contributes to a badge, and it is still in the feed. The
 *       row does not vanish; it stops shouting. Those are different things and the
 *       schema was already able to tell them apart.
 *
 *       `booking_no_show` is the case that proves the count is not just
 *       "unresolved": nothing in the product ever resolves one, so it would sit in
 *       an unresolved-count forever. It leaves the badge when she READS it, which
 *       is the only signal available and the right one.
 *
 * READ IS A SALON-WIDE FACT, NOT A PER-STAFF ONE, because `read_at` is one column
 * on the row. That is kept rather than migrated away from, and the reasoning is
 * not "the schema said so": the bell is a shared WORKLIST. "Rana's calendar is not
 * connected" needs fixing once, by whoever sees it first, and a per-staff read
 * table would make the manager and the front desk each dismiss the same fact.
 *
 * It does sit at an angle to decision 1 — the FEED is per-reader and READ is
 * shared — and the angle is not an accident: they answer different questions.
 * *Whose business is this row* is a question about authority and varies by reader.
 * *Has this been dealt with* is a question about the salon and does not.
 *
 * THE ANGLE HAS ONE SHARP EDGE, AND IT IS WHY MARK-ALL IS SCOPED. If "mark all
 * read" cleared every row, a front desk holding `appointments` alone would clear
 * the marketing manager's `campaign_held` badge — a row she cannot see, about work
 * she cannot do, silenced by someone who never knew it existed. So the write takes
 * the SAME filter as the read: you may only mark read what you could have read.
 *
 * =========================================================================
 * `deep_link` — VALIDATED ON THE WAY OUT.
 * =========================================================================
 * Three writers, all server-side literals with an id interpolated —
 * `/merchant/team/${a.id}`, `/merchant/appointments/${row.id}`,
 * `/marketing/campaigns` — and every id is minted by `services/ids.ts` from a
 * sequence. Nothing a client sends reaches the column today.
 *
 * "Today" is the whole reason `safeDeepLink` exists. The column is a nullable
 * `text` with no CHECK, the client's entire contract with it is *navigate here*,
 * and a fourth raise site that interpolated something from a request would turn
 * the bell into an open redirect in the chrome of every screen. The rule is
 * narrow: a SITE-RELATIVE PATH, one leading slash, and nothing else.
 *
 * VALIDATED ON THE WAY OUT RATHER THAN ON THE WAY IN, deliberately. Rows written
 * before any check existed are already in the database; a check that only guards
 * new writes leaves them, and they are the ones nobody will think to look at. The
 * read is the last thing before the client, so it is the only place that covers
 * every row that will ever be served. A failing link serialises as `null` — an
 * unclickable row — rather than throwing, because a bell that 500s over one bad
 * link is worse than a bell with one dead row in it.
 *
 * `metadata` IS NOT SERVED AT ALL. It carries `memberId`, `depositFils` and
 * `reason`, it has no schema in `packages/types`, and the bell renders none of it —
 * the design draws a dot, a title, a body and a timestamp. Putting an unmodelled
 * jsonb blob on the wire creates a shape a client gets built against, which is the
 * drift `e2e/contract.test.ts` exists to catch. If a screen ever needs a field out
 * of it, it gets a named field.
 */

import type { PermissionName, StaffPerms } from '../auth/principal';
import type { NotificationKind } from './notifications';

/**
 * The three kinds, in the enum's own order. Declared here as well as in
 * `db/schema/notification.ts` so that `KIND_PERMISSION` below can be checked
 * against the union rather than against whatever this array happens to contain.
 */
export const NOTIFICATION_KINDS = [
  'calendar_disconnected',
  'booking_no_show',
  'campaign_held',
] as const satisfies readonly NotificationKind[];

/**
 * A KIND, AND THE PERMISSION THAT OPENS THE SCREEN IT POINTS AT.
 *
 * `satisfies Record<NotificationKind, PermissionName>` is the load-bearing part
 * and is the `PERM_COLUMN` idiom from `auth/principal.ts`, here for a sharper
 * reason. A FOURTH KIND ADDED TO THE PG ENUM IS A COMPILE ERROR HERE. Without the
 * `satisfies`, a new kind would fall out of `visibleKinds` — and the failure would
 * be silent and in the SAFE direction, which is exactly what makes it dangerous:
 * the new notification would simply never appear for anybody, and the way that
 * gets "fixed" six months later by someone who does not know this file is a
 * default that makes it visible to everybody.
 */
export const KIND_PERMISSION = {
  calendar_disconnected: 'team',
  booking_no_show: 'appointments',
  campaign_held: 'marketing',
} as const satisfies Record<NotificationKind, PermissionName>;

/**
 * The kinds this reader may be told about, in enum order.
 *
 * Reads `perms`, which `auth/principal.ts` loads from `staff_user` on every
 * request — never from a token claim — so a permission revoked at 14:00 narrows
 * the bell at 14:00.
 */
export function visibleKinds(perms: StaffPerms): NotificationKind[] {
  return NOTIFICATION_KINDS.filter((k) => perms[KIND_PERMISSION[k]]);
}

/** A bell page. Fixed, not client-chosen — `CUSTOMER_PAGE_SIZE`'s reasoning. */
export const NOTIFICATION_PAGE_SIZE = 20;

/**
 * The most ids one `POST …/read` may name. A bound rather than a meaningful
 * number: the panel holds one page, so a caller marking more than a page at a time
 * is not the UI, and `all: true` is there for the case that is.
 */
export const MARK_READ_MAX_IDS = NOTIFICATION_PAGE_SIZE * 5;

/** Longer than any link this product mints; short enough not to be a payload. */
const DEEP_LINK_MAX = 512;

/** Anything a browser might fold into a scheme or a host. */
const DEEP_LINK_REJECT = /[\\\u0000-\u001f\u007f]/;

/**
 * A deep link fit to hand a client, or `null`.
 *
 * The four refusals are each a way to leave this origin, and they are listed
 * rather than collapsed into one regex because the second is the one that gets
 * missed:
 *
 *   no leading `/`    `https://evil.test/x`, `javascript:…`, `mailto:…` — any
 *                     absolute URL, and any bare word a client would resolve
 *                     against its own base in a way this server cannot predict.
 *   leading `//`      PROTOCOL-RELATIVE. `//evil.test/x` passes a naive
 *                     "starts with a slash" check and navigates off-origin.
 *   a backslash       browsers normalise `\` to `/` in the authority position, so
 *                     `/\evil.test` is `//evil.test` at the far end.
 *   a control char    a NUL or a newline smuggled through a header or a log.
 */
export function safeDeepLink(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const v = raw.trim();
  if (v.length === 0 || v.length > DEEP_LINK_MAX) return null;
  if (!v.startsWith('/')) return null;
  if (v.startsWith('//')) return null;
  if (DEEP_LINK_REJECT.test(v)) return null;
  return v;
}

/** One row of the bell. No `metadata`, no `subjectType`/`subjectId` — see header. */
export interface NotificationView {
  id: string;
  kind: NotificationKind;
  severity: 'info' | 'warning';
  title: string;
  body: string;
  /** Site-relative, or `null` — including when the stored value failed validation. */
  deepLink: string | null;
  createdAt: string;
  /** Salon-wide, not per-staff. Header, decision 2. */
  readAt: string | null;
  /** The condition cleared on its own. A resolved row stays in the feed. */
  resolvedAt: string | null;
}

export function serialiseNotification(row: {
  id: string;
  kind: NotificationKind;
  severity: 'info' | 'warning';
  title: string;
  body: string;
  deepLink: string | null;
  createdAt: Date;
  readAt: Date | null;
  resolvedAt: Date | null;
}): NotificationView {
  return {
    id: row.id,
    kind: row.kind,
    severity: row.severity,
    title: row.title,
    body: row.body,
    deepLink: safeDeepLink(row.deepLink),
    createdAt: row.createdAt.toISOString(),
    readAt: row.readAt?.toISOString() ?? null,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
  };
}
