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

/**
 * AN ACTOR THAT IS NOT A LIVE PRINCIPAL.
 *
 * Some actions are taken by an identified person who holds no session at the
 * moment she takes them: signing in (the credential has just been verified, the
 * session is one line further down) and setting a password from a reset link (a
 * single-use token bound to her account, which is an identification, not a
 * session). Both were passing `null`, so both produced `System / Automatic` — the
 * audit log's Who column, and every actor filter over it, could not answer "who
 * signed in" for a row written immediately after a password was verified.
 *
 * A SNAPSHOT RATHER THAN A SECOND OPTIONAL FIELD ON `AuditInput`. Two doors into
 * one column is how `salon.tiers` acquired an unvalidated second entrance; this
 * is the same parameter, in the one other shape the answer legitimately comes in.
 */
export interface AuditActorSnapshot {
  kind: 'staff' | 'member' | 'platform_admin';
  id: string;
  name: string;
  role: string;
}

/**
 * `null` IS STILL A REAL ANSWER, and it is not a fallback. Some rows genuinely
 * have no actor: the no-show job returning a deposit, and — importantly — a PIN
 * LOCKOUT. Five failed PINs establish that somebody tried, not who: attributing a
 * lockout to the account holder would put "Hessa M. locked her own PIN" in the
 * log when the likeliest reader of that row is somebody investigating whether it
 * was her at all. She is the SUBJECT of that row, which is what `subjectId`
 * carries; `System` is the true actor. Recorded here so the next reader does not
 * "fix" it.
 */
export type AuditActor = Principal | AuditActorSnapshot | null;

function actorOf(principal: AuditActor): {
  actorKind: 'staff' | 'member' | 'platform_admin' | 'system';
  actorId: string | null;
  actorName: string;
  actorRole: string;
} {
  if (!principal) {
    return { actorKind: 'system', actorId: null, actorName: 'System', actorRole: 'Automatic' };
  }
  if (principal.kind === 'staff') {
    // A `StaffPrincipal` and an `AuditActorSnapshot` of kind 'staff' carry the
    // same three fields, so one branch serves both. That is not a coincidence
    // worth hiding behind two branches — the snapshot exists precisely to supply
    // what a principal would have supplied.
    return {
      actorKind: 'staff',
      actorId: principal.id,
      actorName: principal.name,
      actorRole: principal.role,
    };
  }
  /**
   * THE BRANCH THAT COULD NOT BE REACHED.
   *
   * `audit_log.actor_kind` has included `platform_admin` since migration 0001 and
   * the seed writes rows with it, but no principal of that kind existed, so this
   * function could never produce the value — the schema anticipated the owner
   * console and the write path did not. Trunk found it by reading the enum against
   * `Principal`; lane C found the same thing from the other end and recorded it in
   * `apps/dashboard/src/auth/scopes.ts`.
   *
   * `actorRole` IS "AVO platform", NOT THE CONSOLE ROLE, and that is not laziness.
   * Two things already say so: `audit_log.actor_role`'s own comment lists the
   * vocabulary as '"Manager", "Owner", "AVO platform", "Automatic"', and the design
   * renders the row as "Yousef · AVO platform" in the merchant's own audit log —
   * where the internal seniority of an AVO employee is not the merchant's business
   * and "Analyst" beside "Manager" would read as one column with two vocabularies.
   *
   * The console role is not lost: `actor_id` names the `platform_admin` row, which
   * holds it. This column answers "on whose authority", and the answer a salon is
   * owed is AVO's.
   */
  if (principal.kind === 'platform_admin') {
    return {
      actorKind: 'platform_admin',
      actorId: principal.id,
      actorName: principal.name,
      actorRole: 'AVO platform',
    };
  }
  return {
    actorKind: 'member',
    actorId: principal.id,
    /**
     * A `MemberPrincipal` carries no name — it is loaded from two columns, and
     * the wallet does not need one to act. A snapshot does carry one, so a
     * customer-initiated row can name her when the caller has already read the
     * row. `'name' in principal` rather than a cast: the two shapes genuinely
     * differ here, and this is the only place they do.
     */
    actorName: 'name' in principal ? principal.name : `Member ${principal.id}`,
    actorRole: 'Customer',
  };
}

export async function writeAudit(
  exec: Executor,
  principal: AuditActor,
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
