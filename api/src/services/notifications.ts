/**
 * Merchant notifications — raising and clearing.
 *
 * Two functions, and the interesting one is `raise`, because it is called from a
 * READ. `GET /artists/{id}/availability` discovers that an artist's calendar is
 * unreachable while computing a customer's slot list, which means the raise has
 * to be safe to run on a hot path, from many concurrent requests, without
 * flooding the bell.
 *
 * `ON CONFLICT DO NOTHING` against `merchant_notification_open_uq` — unique on
 * `(salon, kind, subject_type, subject_id) WHERE resolved_at IS NULL` — is what
 * makes that true. The database, not a cache and not a check-then-act, decides
 * whether this fact is already raised. Two hundred availability reads in a
 * minute produce one row.
 *
 * `resolve` is the other half and matters as much: a notification that never
 * clears trains a merchant to ignore the bell. Reconnecting a calendar resolves
 * the disconnect row, which also frees the unique index so a LATER disconnect
 * raises a new one rather than being deduped against a stale fact.
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import { merchantNotification } from '../db/schema/notification';
import type { Executor } from './audit';
import { notificationId } from './ids';

export type NotificationKind = 'calendar_disconnected' | 'booking_no_show' | 'campaign_held';

export interface RaiseNotificationInput {
  salonId: string;
  kind: NotificationKind;
  severity?: 'info' | 'warning';
  title: string;
  body: string;
  subjectType: string;
  subjectId: string;
  deepLink?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Raise it if it is not already open. Returns true when a row was written.
 *
 * Never throws on a duplicate — that is the normal case, not an error, and a
 * customer's availability read must not fail because a warning the merchant has
 * already been given could not be given twice.
 */
export async function raiseMerchantNotification(
  exec: Executor,
  input: RaiseNotificationInput,
): Promise<boolean> {
  const rows = await exec
    .insert(merchantNotification)
    .values({
      id: notificationId,
      salonId: input.salonId,
      kind: input.kind,
      severity: input.severity ?? 'warning',
      title: input.title,
      body: input.body,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      deepLink: input.deepLink ?? null,
      metadata: input.metadata ?? {},
    })
    /**
     * Targeted at the PARTIAL index, so the conflict is only against an OPEN
     * notification. A resolved one does not suppress a new raise — a calendar
     * that disconnects, is fixed, and disconnects again is two events and the
     * merchant needs to be told twice.
     */
    .onConflictDoNothing({
      target: [
        merchantNotification.salonId,
        merchantNotification.kind,
        merchantNotification.subjectType,
        merchantNotification.subjectId,
      ],
      /**
       * The index predicate, repeated. Drizzle 0.38's `where` on
       * `onConflictDoNothing` emits the INDEX PREDICATE of `ON CONFLICT (…)
       * WHERE …`, not an `ON CONFLICT DO NOTHING WHERE …` action filter — which
       * is what is wanted here, and is required: Postgres only matches a partial
       * unique index when the statement names its predicate. Without this the
       * insert finds no arbiter index and raises 42P10 instead of deduplicating.
       */
      where: sql`resolved_at IS NULL`,
    })
    .returning({ id: merchantNotification.id });

  return rows.length > 0;
}

/** Clear the open notification for this subject, if there is one. */
export async function resolveMerchantNotification(
  exec: Executor,
  params: { salonId: string; kind: NotificationKind; subjectType: string; subjectId: string },
): Promise<void> {
  await exec
    .update(merchantNotification)
    .set({ resolvedAt: new Date() })
    .where(
      and(
        eq(merchantNotification.salonId, params.salonId),
        eq(merchantNotification.kind, params.kind),
        eq(merchantNotification.subjectType, params.subjectType),
        eq(merchantNotification.subjectId, params.subjectId),
        isNull(merchantNotification.resolvedAt),
      ),
    );
}
