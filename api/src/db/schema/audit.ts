/**
 * Audit log — design/README.md § Merchant dashboard, build-plan.md phase 0.
 *
 * "Every charge, void, reimbursement, automatic deposit return, rule change and
 * permission change in this salon, with who/what/source... Append-only, 7 years."
 *
 * Append-only is enforced in migration 0001, not here and not by convention:
 * `UPDATE`, `DELETE` and `TRUNCATE` are revoked from the application role, and a
 * trigger raises on any of them so that even a privileged session has to
 * deliberately disable a trigger rather than fat-finger a row away. The API
 * connects as `avo_app`, which is not the table owner, so the revoke is real.
 *
 * The actor is recorded as a *snapshot* (`actor_name`, `actor_role`) alongside
 * the id. Seven years is longer than staff turnover: the row has to still read
 * "Rana Al-Sabah · Manager" after the account is gone, which a join cannot
 * promise. The id is a soft reference for the same reason — no foreign key,
 * because a FK would let deleting a staff member fail or cascade into the log.
 */

import { sql } from 'drizzle-orm';
import { bigserial, check, index, jsonb, pgEnum, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { filsColumn, timestamptz } from './_shared';
import { salon } from './salon';

/** The four dashboard filters: Money / Rules / Access / Risk. */
export const auditKind = pgEnum('audit_kind', ['money', 'rules', 'access', 'risk']);

/** The surface the action came from. "Owner console" marks AVO acting on a salon. */
export const auditSource = pgEnum('audit_source', [
  'merchant',
  'scanner',
  'wallet',
  'owner_console',
  'system',
]);

export const auditActorKind = pgEnum('audit_actor_kind', [
  'staff',
  'member',
  'platform_admin',
  'system',
]);

export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Write order. The dashboard reads newest-first by (created_at, seq). */
    seq: bigserial('seq', { mode: 'number' }).notNull(),

    /** Null for a platform-level action that belongs to no single salon. */
    salonId: text('salon_id').references(() => salon.id, { onDelete: 'restrict' }),

    actorKind: auditActorKind('actor_kind').notNull(),
    /** Soft reference — deliberately not a foreign key. See the file header. */
    actorId: text('actor_id'),
    /** "Rana Al-Sabah", "System". Snapshot at write time. */
    actorName: text('actor_name').notNull(),
    /** "Manager", "Owner", "AVO platform", "Automatic". Snapshot at write time. */
    actorRole: text('actor_role').notNull(),

    kind: auditKind('kind').notNull(),
    /** "Charge voided", "Permissions changed", "Tier rules published". */
    action: text('action').notNull(),
    /** "12.000 KD returned to Dana A. · wrong service". Rendered verbatim. */
    detail: text('detail').notNull().default(''),
    source: auditSource('source').notNull(),

    /** What was acted on: 'transaction' / 'staff_user' / 'salon' / 'policy'… */
    subjectType: text('subject_type'),
    subjectId: text('subject_id'),
    /** Present on money rows so the log can be totalled without parsing `detail`. */
    amountFils: filsColumn('amount_fils'),

    /** Before/after for a rules or access change, request ids, anything else. */
    metadata: jsonb('metadata')
      .notNull()
      .default(sql`'{}'::jsonb`),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),

    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('audit_log_salon_created_idx').on(t.salonId, t.createdAt.desc()),
    index('audit_log_kind_created_idx').on(t.kind, t.createdAt.desc()),
    index('audit_log_source_created_idx').on(t.source, t.createdAt.desc()),
    index('audit_log_subject_idx').on(t.subjectType, t.subjectId),

    // Only the system acts without an identity. Everything else names someone.
    check(
      'audit_log_actor_id_required',
      sql`${t.actorKind} = 'system' OR ${t.actorId} IS NOT NULL`,
    ),
    // A Money row that carries no amount cannot be reconciled against the ledger.
    check('audit_log_money_has_amount', sql`${t.kind} <> 'money' OR ${t.amountFils} IS NOT NULL`),
  ],
);
