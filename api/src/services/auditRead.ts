/**
 * Reading the audit log — the parts the merchant's read and the platform's read
 * must not do differently.
 *
 * There are two audit screens. `GET /salons/{id}/audit` is the merchant's, scoped
 * to her salon; `GET /v1/platform/audit` is the owner console's, scoped to
 * nothing. They filter differently BY DESIGN and that is the whole of the
 * difference — the filter grammar, the cursor rule, the search escaping and the
 * row shape are the same question asked twice, so they live here and are answered
 * once.
 *
 * WHY THAT MATTERS MORE THAN THE USUAL DE-DUPLICATION ARGUMENT: an audit log is
 * read years later by someone reconciling a dispute, and the two screens would be
 * compared. A `kind` chip that means something slightly different on the console
 * than on the dashboard, or a cursor that pages differently, turns "these two
 * screens disagree" into a question about the record itself. `readMessagingPolicy`
 * is here for the same reason on a smaller scale: one object, two surfaces, one
 * function.
 *
 * NOTHING HERE WRITES. Rows are written by the handlers that cause them, inside
 * the transaction as the effect they describe (`services/audit.ts`), and
 * `UPDATE`/`DELETE` are revoked from `avo_app` in migration 0001.
 */

import { ilike, or, sql, type SQL } from 'drizzle-orm';
import { auditLog } from '../db/schema/audit';
import { badRequest } from '../http/errors';

/** The four filter chips, plus the "All" that means no filter. */
export const AUDIT_KINDS = ['money', 'rules', 'access', 'risk'] as const;
export type AuditReadKind = (typeof AUDIT_KINDS)[number];

/**
 * The Source column, as the design writes it. The database stores a machine
 * value; the screen renders "Owner console", capital O, lower c.
 *
 * Mapped on the server rather than in each client for the same reason the 403 copy
 * is: one place decides what the product calls a thing, and two clients rendering
 * the same row with different words is the divergence this file exists to stop.
 */
export const AUDIT_SOURCE_LABEL: Record<string, string> = {
  merchant: 'Merchant',
  scanner: 'Scanner',
  wallet: 'Wallet',
  owner_console: 'Owner console',
  system: 'System',
};

export const AUDIT_MAX_LIMIT = 100;
export const AUDIT_DEFAULT_LIMIT = 50;

export function parseAuditLimit(value: unknown): number {
  if (value === undefined) return AUDIT_DEFAULT_LIMIT;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > AUDIT_MAX_LIMIT) {
    throw badRequest(
      'invalid_limit',
      `limit must be a whole number between 1 and ${AUDIT_MAX_LIMIT}.`,
    );
  }
  return n;
}

/**
 * The cursor is the `seq` of the last row already delivered.
 *
 * `seq` and not `created_at`: it is a bigserial, so it is strictly monotonic in
 * write order and unique, which makes `seq < cursor` a total order with no ties to
 * break. Two audit rows written in the same millisecond — a charge and its loyalty
 * line — would otherwise be able to straddle a page boundary and either repeat or
 * vanish.
 */
export function parseAuditCursor(value: unknown): number | null {
  if (value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw badRequest('invalid_cursor', 'cursor must be the seq of the last row you received.');
  }
  return n;
}

export function parseAuditKinds(value: unknown): AuditReadKind[] | null {
  if (value === undefined || value === '' || value === 'all') return null;
  const raw = String(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const bad = raw.filter((k) => !(AUDIT_KINDS as readonly string[]).includes(k));
  if (bad.length > 0) {
    throw badRequest(
      'invalid_kind',
      `Unknown filter: ${bad.join(', ')}. Use ${AUDIT_KINDS.join(', ')} or all.`,
    );
  }
  return raw.length > 0 ? (raw as AuditReadKind[]) : null;
}

/**
 * The search box: "Search staff, customer or action".
 *
 * Matched against the four columns the design's own filter reads —
 * `who + action + detail + role`. `%` and `_` are escaped so somebody typing a
 * literal underscore (they appear in `subject_type` values and in staff handles)
 * searches for that character rather than for any character.
 */
export function auditSearchPredicate(q: string): SQL | undefined {
  const escaped = q.replace(/[\\%_]/g, (c) => `\\${c}`);
  const like = `%${escaped}%`;
  return or(
    ilike(auditLog.actorName, like),
    ilike(auditLog.actorRole, like),
    ilike(auditLog.action, like),
    ilike(auditLog.detail, like),
  );
}

/** `count(*)` over a filter, as the chip counter reads it. */
export const auditTotal = sql<number>`count(*)::int`;

/**
 * One audit row, as both screens render it.
 *
 * `salonId` IS ON THE WIRE, and it is the one field the merchant's screen has no
 * use for and the console's needs: the console's log draws a salon pill on every
 * row ("Amara", "Glow Bar"). It is not a leak on the merchant's side — every row
 * she can see already carries her own salon id by construction — and emitting it
 * from one serialiser is cheaper than two shapes that drift.
 *
 * THE RETURN TYPE IS DECLARED, and `amountFils` is `number | null` rather than
 * `Fils | null`. `tsc` refuses the inferred version — `TS4058: Return type of
 * exported function has or is using name 'FilsBrand' ... but cannot be named` —
 * and the fix is the correct shape anyway: this is a JSON body, and `Fils` is a
 * compile-time brand that does not survive serialisation. Claiming one on the wire
 * would assert a guarantee the wire cannot keep. Same boundary
 * `http/serialise.ts` draws for `feeFils`.
 */
export interface AuditRowWire {
  id: string;
  seq: number;
  when: string;
  who: string;
  role: string;
  actorKind: string;
  actorId: string | null;
  salonId: string | null;
  kind: string;
  action: string;
  detail: string;
  source: string;
  sourceLabel: string;
  isPlatformAction: boolean;
  subjectType: string | null;
  subjectId: string | null;
  amountFils: number | null;
}

export function serialiseAuditRow(r: typeof auditLog.$inferSelect): AuditRowWire {
  return {
    id: r.id,
    seq: r.seq,
    /**
     * ISO, not "Today · 6:42 PM". The design's relative phrasing is a rendering
     * decision that depends on the reader's clock and language — and
     * non-negotiable #12 makes the Arabic surfaces first-class layouts, not string
     * swaps. The server sends the instant.
     */
    when: r.createdAt.toISOString(),
    who: r.actorName,
    role: r.actorRole,
    actorKind: r.actorKind,
    /** Soft reference. Null for a system action — see db/schema/audit.ts. */
    actorId: r.actorId,
    /** Null on a platform action belonging to no salon. */
    salonId: r.salonId,
    /** The pill colour: money / rules / access / risk. */
    kind: r.kind,
    action: r.action,
    detail: r.detail,
    source: r.source,
    /** "Owner console" — the label the design's Source column renders. */
    sourceLabel: AUDIT_SOURCE_LABEL[r.source] ?? r.source,
    /**
     * True for an AVO platform action. The merchant dashboard's footnote calls
     * these out specifically, and a boolean is a cheaper thing for a client to
     * style on than a string comparison it has to keep in sync.
     */
    isPlatformAction: r.source === 'owner_console',
    subjectType: r.subjectType,
    subjectId: r.subjectId,
    /** Present on money rows — the CHECK guarantees it. Integer fils. */
    amountFils: r.amountFils,
  };
}
