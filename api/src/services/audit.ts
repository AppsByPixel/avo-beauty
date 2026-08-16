/**
 * Audit writes. One helper, so every mutating handler produces a row of the
 * same shape and the four dashboard filters (Money / Rules / Access / Risk) stay
 * meaningful.
 *
 * The actor is written as a SNAPSHOT — name and role copied in at write time,
 * with the id as a soft reference. See db/schema/audit.ts: seven years outlives
 * staff turnover, and the row still has to read "Rana Al-Sabah · Manager" after
 * the account is gone.
 *
 * `writeAudit` takes an executor rather than the global `db` so a money-path
 * caller can pass its transaction handle and have the audit row commit or roll
 * back with the effect it describes. An audit row for a charge that did not
 * happen is worse than no row at all.
 */

import type { Db } from '../db/client';
import { auditLog } from '../db/schema/audit';
import type { Principal } from '../auth/principal';

/** Anything with `.insert()` — the pool, or an open transaction. */
export type Executor = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

export type AuditKind = 'money' | 'rules' | 'access' | 'risk';
export type AuditSource = 'merchant' | 'scanner' | 'wallet' | 'owner_console' | 'system';

export interface AuditInput {
  salonId: string | null;
  kind: AuditKind;
  action: string;
  detail?: string;
  source: AuditSource;
  subjectType?: string | null;
  subjectId?: string | null;
  /** Required on `money` rows — the CHECK in the schema enforces it. */
  amountFils?: number | null;
  metadata?: Record<string, unknown>;
  ipAddress?: string | null;
  userAgent?: string | null;
}

function actorOf(principal: Principal | null): {
  actorKind: 'staff' | 'member' | 'platform_admin' | 'system';
  actorId: string | null;
  actorName: string;
  actorRole: string;
} {
  if (!principal) {
    return { actorKind: 'system', actorId: null, actorName: 'System', actorRole: 'Automatic' };
  }
  if (principal.kind === 'staff') {
    return {
      actorKind: 'staff',
      actorId: principal.id,
      actorName: principal.name,
      actorRole: principal.role,
    };
  }
  return {
    actorKind: 'member',
    actorId: principal.id,
    actorName: `Member ${principal.id}`,
    actorRole: 'Customer',
  };
}

export async function writeAudit(
  exec: Executor,
  principal: Principal | null,
  input: AuditInput,
): Promise<void> {
  const actor = actorOf(principal);
  await exec.insert(auditLog).values({
    salonId: input.salonId,
    actorKind: actor.actorKind,
    actorId: actor.actorId,
    actorName: actor.actorName,
    actorRole: actor.actorRole,
    kind: input.kind,
    action: input.action,
    detail: input.detail ?? '',
    source: input.source,
    subjectType: input.subjectType ?? null,
    subjectId: input.subjectId ?? null,
    amountFils: (input.amountFils ?? null) as never,
    metadata: input.metadata ?? {},
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent ?? null,
  });
}
