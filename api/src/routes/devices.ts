/**
 * DEVICE ENROLMENT — binding a till to a branch.       (DECISIONS.md #82)
 *
 * =========================================================================
 * WHAT THIS FIXES, AND WHY IT IS NOT A SETTINGS SCREEN
 * =========================================================================
 * `services/branch.ts` has always been able to accept an established branch and
 * has never had one to accept, because `session.device_id` is a string the
 * client sends and nothing recorded what any device WAS. So at a multi-branch
 * salon `resolveBranch` fell back to `ORDER BY id LIMIT 1`, marked the row
 * `branch_assumed = true`, and `charge.ts` passed `null` into
 * `loadPromotionInputs` — which matches no boost and no branch-scoped happy
 * hour.
 *
 * Decision 82's framing, which is the one to keep: **adding a second branch is
 * not a configuration task, it is a regression.** The merchant is still shown
 * her per-branch earning rates and can still edit them, and they apply to
 * nothing. These three endpoints are what make them apply again.
 *
 * =========================================================================
 * THE GATE: `perms.dashboard`, ON EITHER SURFACE
 * =========================================================================
 * ARGUED, not defaulted, and the surface half is the unusual part.
 *
 * WHY `dashboard` AND NOT THE OTHERS. The authority being handed out is "decide
 * which branch's earning rates apply to the money taken at this till", and
 * `perms.dashboard` is already the authority over per-branch money truth — it
 * gates `GET /salons/:id/activity`, `GET /salons/:id/audit` and the sales
 * report. `team` was the plausible alternative and is wrong: a till is not a
 * person. `marketing` gates the boost rows themselves
 * (`PUT /v1/salons/:id/promotions/boosts`) and would have been defensible, but
 * `marketing` means customer messaging under caps and quiet hours everywhere
 * else in this build (non-negotiable #8), and widening it to cover hardware is
 * how a permission ends up granting more than anybody intended — decision 21's
 * complaint about `loyalty` and the social links, one endpoint over.
 *
 * The honest name is `perms.settings`, which does not exist. **This is the
 * SECOND endpoint family to want it** — decision 21 is the first, and escalated
 * rather than inventing a tenth permission. Reported again here rather than
 * decided, because adding one is still a four-way break.
 *
 * The concrete consequence, which is the test that matters: the seeded
 * `frontdesk` preset (ST-002) holds `appointments` and NOT `dashboard`, so a
 * front-desk PIN holder cannot re-point her till at the branch with the 2x
 * visit boost. That is the whole reason this is not gated on `scanner`.
 *
 * WHY `'either'` SURFACE, WHICH NO OTHER GATED ENDPOINT IN THIS BUILD DOES.
 * `requirePerm(req, surface, permission)` checks surface first "because it is
 * the more fundamental refusal" — a manager holds `charges` legitimately, so a
 * permission alone would let her web session debit a wallet from a laptop. That
 * argument is about a credential being used somewhere it should not be, and it
 * does not apply here, because **both surfaces are legitimate callers by
 * design**: decision 82 assigns "the scanner's 'Set up this device' flow
 * choosing it" to lane B and "the dashboard managing it" to lane C. A manager
 * standing at the counter with the new iPad in her hands is the primary flow.
 *
 * So the control is the PERMISSION rather than the surface, deliberately, and it
 * is a strictly narrower grant than the alternative would have been: gating on
 * `scanner` scope would have let every PIN holder on the counter choose her own
 * branch, which is `services/branch.ts` § THE FIX THAT MUST NOT BE TAKEN
 * arriving through a side door.
 *
 * =========================================================================
 * THE DEVICE IS NOT TRUSTED, IT IS LOOKED UP
 * =========================================================================
 * `POST` takes a `deviceId` and a `branchId` together — from a caller holding
 * `perms.dashboard`, once, as an act of configuration. `POST /charges` still
 * takes no branch at all and `ChargeInput` no longer has a field for one. The
 * asymmetry is the design: setting up a till is a deliberate authorised act;
 * taking a payment reads what was set up. A device that asserted its own branch
 * per charge would be a client choosing its own multiplier.
 */

import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { db } from '../db/client';
import { branch } from '../db/schema/salon';
import { deviceEnrolment } from '../db/schema/deviceEnrolment';
import { requirePerm, requireSameSalon, type StaffPrincipal } from '../auth/principal';
import { badRequest, notFound } from '../http/errors';
import { requireString } from '../money/validate';
import { writeAudit } from '../services/audit';

/**
 * `rules`, not `access` and not `money`. It moves no money and grants no person
 * any authority; it decides which branch's EARNING RULES a till's charges fall
 * under, which is what `rules` covers everywhere else.
 */
const AUDIT_KIND = 'rules' as const;

/** The surface that actually called, so the log does not flatten the two. */
const sourceOf = (p: StaffPrincipal) => (p.scope === 'scanner' ? 'scanner' : 'merchant');

interface EnrolmentRow {
  deviceId: string;
  branchId: string;
  branchName: string | null;
  label: string;
  enrolledAt: string;
}

export async function registerDeviceRoutes(app: FastifyInstance): Promise<void> {
  // ------------------------------------------------------------------ list --
  /**
   * The salon's live tills.
   *
   * LIVE ONLY. A revoked row is history and stays in the table — see
   * db/schema/deviceEnrolment.ts for why revoking is an UPDATE — but a merchant
   * managing hardware wants the list she can act on, and every enrolment and
   * revocation is already in `audit_log` with an actor and a timestamp. Two
   * answers to "which tills does this salon have" is the failure this avoids.
   */
  app.get<{ Params: { id: string } }>('/salons/:id/devices', async (req, reply) => {
    const p = requirePerm(req, 'either', 'dashboard');
    requireSameSalon(p, req.params.id);

    const rows = await db
      .select({
        deviceId: deviceEnrolment.deviceId,
        branchId: deviceEnrolment.branchId,
        branchName: branch.name,
        label: deviceEnrolment.label,
        createdAt: deviceEnrolment.createdAt,
      })
      // Scoped from the principal, not the path — the doubling routes/activity.ts
      // and routes/audit.ts both keep, so these queries stay right even if the
      // `requireSameSalon` above were ever loosened.
      .from(deviceEnrolment)
      .leftJoin(branch, eq(branch.id, deviceEnrolment.branchId))
      .where(and(eq(deviceEnrolment.salonId, p.salonId), isNull(deviceEnrolment.revokedAt)))
      .orderBy(deviceEnrolment.deviceId);

    const items: EnrolmentRow[] = rows.map((r) => ({
      deviceId: r.deviceId,
      branchId: r.branchId,
      branchName: r.branchName ?? null,
      label: r.label,
      enrolledAt: r.createdAt.toISOString(),
    }));
    return reply.send({ items, nextCursor: null });
  });

  // ----------------------------------------------------------------- enrol --
  /**
   * Bind a device to a branch.
   *
   * NO IDEMPOTENCY KEY, and that is a decision rather than an omission.
   * Non-negotiable #4 covers money-moving POSTs — "top-ups, charges, orders,
   * voids" — and this moves none. What it does instead is make a REPEAT
   * HARMLESS: re-posting an enrolment that already names the same branch and the
   * same label returns the existing row with 200 and writes nothing, so a
   * double-tapped Save does not churn the history the revoke trail depends on. A
   * genuine change revokes the old row and inserts a new one, in one
   * transaction, and answers 201.
   *
   * THE BRANCH IS CHECKED AGAINST THE SALON HERE AS WELL AS BY THE COMPOSITE
   * FOREIGN KEY. The constraint is the control — a cross-tenant row does not
   * commit whatever this handler does — but a raw FK violation surfaces as a 500,
   * and a 404 by name is what a client can render. Answered as `unknown_branch`
   * and NOT as a 403, for `resolveBranch`'s reason: a 403 would confirm the id
   * names a real branch at some other salon.
   */
  app.post<{ Params: { id: string } }>('/salons/:id/devices', async (req, reply) => {
    const p = requirePerm(req, 'either', 'dashboard');
    requireSameSalon(p, req.params.id);

    const body = (req.body ?? {}) as Record<string, unknown>;
    const deviceId = requireString(body.deviceId, 'deviceId', 200).trim();
    const branchId = requireString(body.branchId, 'branchId', 100).trim();
    const label = requireString(body.label, 'label', 120).trim();
    /**
     * `badRequest`, not `conflict`: a blank field is a malformed request, not a
     * state the server refuses. `device_enrolment_device_id_not_blank` and its
     * label twin are the control — a whitespace-only value does not commit — and
     * this is the message a client can render instead of a 500.
     */
    if (!deviceId || !label) {
      throw badRequest('blank_field', 'deviceId and label cannot be blank.');
    }

    const result = await db.transaction(async (tx) => {
      /**
       * OPEN BRANCHES ONLY. `resolveBranch` refuses a closed branch for new
       * money, so enrolling a till into one would create a till whose every
       * charge is refused at the branch lookup — a working configuration screen
       * producing a broken counter. Caught here, where it can be a message.
       */
      const [b] = await tx
        .select({ id: branch.id, name: branch.name })
        .from(branch)
        .where(and(eq(branch.id, branchId), eq(branch.salonId, p.salonId), isNull(branch.closedAt)))
        .limit(1);
      if (!b) throw notFound('unknown_branch', 'No such open branch.');

      const [live] = await tx
        .select()
        .from(deviceEnrolment)
        .where(
          and(
            eq(deviceEnrolment.salonId, p.salonId),
            eq(deviceEnrolment.deviceId, deviceId),
            isNull(deviceEnrolment.revokedAt),
          ),
        )
        .for('update')
        .limit(1);

      if (live && live.branchId === branchId && live.label === label) {
        return { status: 200 as const, row: live, branchName: b.name, changed: false };
      }

      const now = new Date();
      if (live) {
        await tx
          .update(deviceEnrolment)
          .set({ revokedAt: now, revokedByStaffId: p.id, updatedAt: now })
          .where(eq(deviceEnrolment.id, live.id));
      }

      const [row] = await tx
        .insert(deviceEnrolment)
        .values({
          id: `ENR-${randomUUID()}`,
          salonId: p.salonId,
          deviceId,
          branchId,
          label,
          enrolledByStaffId: p.id,
          createdAt: now,
          updatedAt: now,
        })
        .returning();

      await writeAudit(tx, p, {
        salonId: p.salonId,
        kind: AUDIT_KIND,
        action: live ? 'device_reassigned' : 'device_enrolled',
        detail: `${label} (${deviceId}) → ${b.name}`,
        source: sourceOf(p),
        subjectType: 'device',
        subjectId: deviceId,
      });

      return { status: 201 as const, row: row!, branchName: b.name, changed: true };
    });

    return reply.code(result.status).send({
      device: {
        deviceId: result.row.deviceId,
        branchId: result.row.branchId,
        branchName: result.branchName,
        label: result.row.label,
        enrolledAt: result.row.createdAt.toISOString(),
      },
    });
  });

  // ---------------------------------------------------------------- revoke --
  /**
   * Unbind a till.
   *
   * WHAT IT DOES TO THAT TILL'S NEXT CHARGE, stated because it is the point: the
   * charge still succeeds. `enrolledBranchId` becomes null, `resolveBranch` falls
   * back to its own answer, and at a multi-branch salon the row is written
   * `branch_assumed = true` and earns no boost again. Revoking degrades
   * attribution; it never refuses money at the counter.
   */
  app.delete<{ Params: { id: string; deviceId: string } }>(
    '/salons/:id/devices/:deviceId',
    async (req, reply) => {
      const p = requirePerm(req, 'either', 'dashboard');
      requireSameSalon(p, req.params.id);

      const now = new Date();
      /**
       * THE TRANSITION IS THE WHERE CLAUSE and the row count decides — the
       * pattern services/booking.ts § returnDeposit had to learn: a second
       * revoke must not be reported as a first. `revoked_at IS NULL` in the
       * predicate means two concurrent DELETEs produce one revocation and one
       * 404, without the handler comparing anything.
       */
      const revoked = await db
        .update(deviceEnrolment)
        .set({ revokedAt: now, revokedByStaffId: p.id, updatedAt: now })
        .where(
          and(
            eq(deviceEnrolment.salonId, p.salonId),
            eq(deviceEnrolment.deviceId, req.params.deviceId),
            isNull(deviceEnrolment.revokedAt),
          ),
        )
        .returning({ id: deviceEnrolment.id, label: deviceEnrolment.label });

      const row = revoked[0];
      if (!row) throw notFound('unknown_device', 'That device is not enrolled here.');

      await writeAudit(db, p, {
        salonId: p.salonId,
        kind: AUDIT_KIND,
        action: 'device_revoked',
        detail: `${row.label} (${req.params.deviceId})`,
        source: sourceOf(p),
        subjectType: 'device',
        subjectId: req.params.deviceId,
      });

      return reply.send({ deviceId: req.params.deviceId, enrolled: false });
    },
  );
}
