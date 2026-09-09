/**
 * WHICH BRANCH IS THIS TILL STANDING IN?          (DECISIONS.md #82, migration 0043)
 *
 * `session.device_id` is a string the CLIENT sends, and until this table there
 * was no server-side record of what any device was. So `services/branch.ts`
 * could not answer "where did this money move" for a multi-branch salon, fell
 * back to `ORDER BY id LIMIT 1`, and marked the row `branch_assumed = true` —
 * which is honest, and also means every per-branch earning rate the merchant is
 * still being shown and still editing applies to nothing.
 *
 * A ROW HERE IS A FACT THE SERVER HOLDS, WHICH IS THE ENTIRE POINT. The device
 * presents an identifier; the server looks up what that identifier is bound to.
 * A client that named its own branch would be a client choosing its own
 * multiplier — non-negotiable #2 — so the direction of the lookup is the safety
 * property, not an implementation detail. `POST /charges` still has no branch in
 * its body and `ChargeInput` no longer has a field for one.
 *
 * REVOKING IS AN UPDATE, NOT A DELETE. `device_enrolment_live_uq` is partial on
 * `revoked_at IS NULL`, so one live enrolment exists per (salon, device) and the
 * superseded rows stay. A till that was pointed at Kuwait City while three
 * hundred charges went through it is a thing somebody will need to look up after
 * the merchant re-points it at Salmiya, and a deleted row cannot answer that.
 *
 * THE COMPOSITE FOREIGN KEY IS THE TENANCY CONTROL. `(branch_id, salon_id)`
 * references `branch (id, salon_id)`, so a row naming another salon's branch
 * does not commit. Deliberately stronger than `artist.staff_user_id`, which is a
 * plain FK that `services/reports.ts` has to carry a defensive join for — the
 * money follows this column, so the error is unrepresentable rather than
 * survivable.
 */

import { index, pgTable, text, uniqueIndex, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { timestamptz } from './_shared';
import { salon, branch } from './salon';
import { staffUser } from './staff';

export const deviceEnrolment = pgTable(
  'device_enrolment',
  {
    id: text('id').primaryKey(),

    salonId: text('salon_id')
      .notNull()
      .references(() => salon.id, { onDelete: 'restrict' }),

    /**
     * The client-chosen device identifier, the same string `session.device_id`
     * carries and the same one `pin_attempt` and `scanner_attempt` rate-limit
     * on. Scoped per salon rather than globally unique for exactly that reason:
     * two salons may both run a till called `DEV-SCANNER-01`.
     */
    deviceId: text('device_id').notNull(),

    /**
     * Where this till stands. NOT NULL — an enrolment with no branch is not an
     * enrolment, it is the guess this table exists to replace.
     *
     * The same-salon guarantee is the composite FK in migration 0043; drizzle
     * cannot express it, so it is not restated as a `.references()` here. See
     * the file header.
     */
    branchId: text('branch_id').notNull(),

    /**
     * What a human calls it. NOT NULL, because the merchant's revoke button acts
     * on this list and a list of opaque identifiers is one she cannot safely
     * pick a row out of.
     */
    label: text('label').notNull(),

    enrolledByStaffId: text('enrolled_by_staff_id').references(() => staffUser.id, {
      onDelete: 'restrict',
    }),

    /** Set together, by `device_enrolment_revocation_is_whole`. */
    revokedAt: timestamptz('revoked_at'),
    revokedByStaffId: text('revoked_by_staff_id').references(() => staffUser.id, {
      onDelete: 'restrict',
    }),

    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('device_enrolment_live_uq')
      .on(t.salonId, t.deviceId)
      .where(sql`revoked_at IS NULL`),
    index('device_enrolment_branch_idx').on(t.branchId),

    check('device_enrolment_device_id_not_blank', sql`length(btrim(${t.deviceId})) > 0`),
    check('device_enrolment_label_not_blank', sql`length(btrim(${t.label})) > 0`),
    check(
      'device_enrolment_revocation_is_whole',
      sql`(${t.revokedAt} IS NULL) = (${t.revokedByStaffId} IS NULL)`,
    ),
  ],
);
