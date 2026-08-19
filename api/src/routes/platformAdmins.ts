/**
 * The owner console's Admins section — `perms.admins`, platform scope.
 *
 *   GET    /v1/platform/admins                     list
 *   POST   /v1/platform/admins                     invite
 *   PATCH  /v1/platform/admins/{id}                role and section chips
 *   DELETE /v1/platform/admins/{id}                deactivate
 *   POST   /v1/platform/admins/{id}/password-reset issue a reset link
 *
 * The REDEEM half lives in `routes/auth.ts` as `POST /auth/platform/password-reset`,
 * unauthenticated, next to its staff counterpart — an admin redeeming a link cannot
 * hold a console session by definition, so it does not belong in a file gated on
 * `perms.admins`.
 *
 * NOT IN api-contract.md, which never declared the console's own account
 * management. `design/AVO Owner Console.dc.html` § ADMINS draws all four — "+ Add
 * admin" with name/role/username/temporary password, a role select, nine chips,
 * "Reset password", and a ✕ — so the shapes come from the design. Reported as a
 * contract addition, the way `POST /bookings/{id}/reschedule` was.
 *
 * NON-NEGOTIABLE #6 IS THE ONE THAT SHAPES THIS FILE. "Passwords are never
 * stored in plaintext, never returned by an endpoint, never shown in a UI. Owner
 * console only sends a reset link."
 *
 * So the design's "Temporary password" field is NOT accepted here — it is refused
 * by name, on the invite and on the reset issue alike. An invite creates an admin
 * with `password_hash` NULL and answers with the reset link's expiry, never the
 * token's value in a body that could be logged; she sets her own password by
 * redeeming that link at `POST /auth/platform/password-reset`.
 *
 * THAT DOOR NOW EXISTS. This header used to end "until one exists for the console,
 * an invited admin cannot sign in, which is the honest state" — a true statement
 * about a product with an account nobody could use. Migration 0033 added the outbox,
 * this file issues the link, and auth.ts redeems it. Nothing on this path ever
 * accepts or returns a plaintext password.
 *
 * THE OWNER IS NOT EDITABLE AND NOT REMOVABLE, which the design draws (no ✕, no
 * toggleable chips, "Owner · full access") and `platform_admin_owner_holds_everything`
 * enforces. Refused here by name so the console gets a sentence rather than a
 * constraint violation.
 */

import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { db } from '../db/client';
import {
  platformAdmin,
  platformAdminPasswordReset,
  PLATFORM_ROLE_PRESETS,
  PLATFORM_ROLES,
  PLATFORM_SECTIONS,
  type PlatformRole,
  type PlatformSection,
} from '../db/schema/platformAdmin';
import { requirePlatform } from '../auth/principal';
import { revokeAllSessions } from '../auth/sessions';
import {
  hashPasswordResetToken as hashResetToken,
  mintPasswordResetToken as mintResetToken,
} from '../auth/tokens';
import { badRequest, conflict, forbidden, notFound } from '../http/errors';
import { requireString } from '../money/validate';
import { writeAudit } from '../services/audit';
import { isUniqueViolation } from '../services/idempotency';

/**
 * The wire shape. `passwordHash` IS NOT ON IT, and neither is anything derived
 * from it beyond the boolean the design needs to decide between "Reset password"
 * and "Link sent" — non-negotiable #6, and the same treatment `serialiseStaff`
 * gives `pinSet`.
 */
export function serialisePlatformAdmin(row: typeof platformAdmin.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    /** With the '@' the console renders. The column stores it without. */
    handle: `@${row.handle}`,
    role: row.role,
    owner: row.owner,
    /** False means invited and not yet signed in. Never the hash, never a hint. */
    passwordSet: row.passwordHash !== null,
    active: row.active,
    sections: {
      analytics: row.permAnalytics,
      activity: row.permActivity,
      salons: row.permSalons,
      accounts: row.permAccounts,
      admins: row.permAdmins,
      controls: row.permControls,
      approvals: row.permApprovals,
      policies: row.permPolicies,
      audit: row.permAudit,
    },
  };
}

/** The nine boolean columns, from a `Record<PlatformSection, boolean>`. */
function sectionColumns(sections: Record<PlatformSection, boolean>) {
  return {
    permAnalytics: sections.analytics,
    permActivity: sections.activity,
    permSalons: sections.salons,
    permAccounts: sections.accounts,
    permAdmins: sections.admins,
    permControls: sections.controls,
    permApprovals: sections.approvals,
    permPolicies: sections.policies,
    permAudit: sections.audit,
  };
}

/**
 * How long a console reset link is good for. Sixty minutes, matching
 * `routes/staff.ts`: it is a credential in transit, and the two surfaces having
 * different windows would be a difference nobody chose.
 */
const RESET_TTL_MINUTES = 60;

function isRole(value: unknown): value is PlatformRole {
  return typeof value === 'string' && (PLATFORM_ROLES as readonly string[]).includes(value);
}

/**
 * `owner` IS NOT ASSIGNABLE THROUGH THIS API AT ALL, in either direction.
 *
 * There is one platform owner, seeded, and the flag is tied to the role by CHECK.
 * An endpoint that could grant it would be an endpoint that could grant every
 * section to anybody — the console's own `admins` chip is the thing being edited
 * here, so a support user who somehow reached this route could otherwise promote
 * herself past the gate that let her in.
 */
function refuseOwnerRole(role: PlatformRole): void {
  if (role === 'owner') {
    throw forbidden('There is one platform owner and the role cannot be assigned.');
  }
}

export async function registerPlatformAdminRoutes(app: FastifyInstance): Promise<void> {
  app.get('/v1/platform/admins', async (req, reply) => {
    requirePlatform(req, 'admins');
    const rows = await db.select().from(platformAdmin).orderBy(platformAdmin.createdAt);
    return reply.send({ items: rows.map(serialisePlatformAdmin), nextCursor: null });
  });

  app.post('/v1/platform/admins', async (req, reply) => {
    const p = requirePlatform(req, 'admins');

    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = requireString(body.name, 'name', 200);
    const handle = requireString(body.username, 'username', 100)
      .toLowerCase()
      .replace(/^@/, '');
    if (!/^[a-z0-9._-]{2,100}$/.test(handle)) {
      throw badRequest(
        'invalid_username',
        'A username is 2–100 characters of letters, digits, dot, dash or underscore.',
      );
    }
    if (!isRole(body.role)) {
      throw badRequest('invalid_role', `role must be one of ${PLATFORM_ROLES.join(', ')}.`);
    }
    refuseOwnerRole(body.role);

    /**
     * NON-NEGOTIABLE #6. The design draws a "Temporary password" field and this
     * endpoint refuses it BY NAME rather than ignoring it: a console that sent one
     * believed it had set a credential, and silently dropping it would leave an
     * admin who cannot sign in and an inviter who thinks she can.
     */
    if ('password' in body || 'temporaryPassword' in body) {
      throw badRequest(
        'password_not_accepted',
        'The console never sets a password. The admin receives a reset link and sets her own.',
      );
    }

    const id = `PA-${handle.replace(/[^a-z0-9]/g, '').slice(0, 12).toUpperCase()}`;
    const sections = PLATFORM_ROLE_PRESETS[body.role];

    try {
      const [row] = await db
        .insert(platformAdmin)
        .values({
          id,
          name,
          handle,
          // NULL. She sets her own; #6 allows a link and nothing else.
          passwordHash: null,
          role: body.role,
          owner: false,
          ...sectionColumns(sections),
        })
        .returning();
      if (!row) throw conflict('admin_not_created', 'That admin could not be saved. Try again.');

      await writeAudit(db, p, {
        salonId: null,
        kind: 'access',
        action: 'Console admin invited',
        detail: `${name} (@${handle}) invited as ${body.role}`,
        source: 'owner_console',
        subjectType: 'platform_admin',
        subjectId: row.id,
        metadata: { role: body.role, sections },
        ipAddress: req.ip ?? null,
        userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
      });

      return reply.code(201).send(serialisePlatformAdmin(row));
    } catch (err) {
      /**
       * Two admins can collide on the handle OR on the derived id, and both are
       * the same thing to the caller: that username is taken. Named rather than
       * reported as a 500, because the console's form can act on it.
       */
      if (isUniqueViolation(err)) {
        throw conflict('username_taken', 'That username is already in use.');
      }
      throw err;
    }
  });

  app.patch<{ Params: { id: string } }>('/v1/platform/admins/:id', async (req, reply) => {
    const p = requirePlatform(req, 'admins');

    const body = (req.body ?? {}) as Record<string, unknown>;
    const unknown = Object.keys(body).filter((k) => k !== 'role' && k !== 'sections');
    if (unknown.length > 0) {
      throw badRequest(
        'invalid_field',
        `Not editable: ${unknown.join(', ')}. An admin has a role and section access.`,
      );
    }

    const [existing] = await db
      .select()
      .from(platformAdmin)
      .where(eq(platformAdmin.id, req.params.id))
      .limit(1);
    if (!existing) throw notFound('unknown_admin', 'No such console admin.');
    if (existing.owner) {
      throw forbidden('The platform owner holds every section and cannot be edited.');
    }

    /**
     * A ROLE CHANGE RESETS THE CHIPS TO THAT ROLE'S PRESET, which is what the
     * design does — `onRole` in the Admins editor replaces `perms` wholesale with
     * `adminPresets[r]`. A body sending both `role` and `sections` gets the
     * sections it asked for on top of the new role's preset, in that order, so the
     * two are not fighting and the outcome does not depend on key order.
     */
    let sections: Record<PlatformSection, boolean> = {
      analytics: existing.permAnalytics,
      activity: existing.permActivity,
      salons: existing.permSalons,
      accounts: existing.permAccounts,
      admins: existing.permAdmins,
      controls: existing.permControls,
      approvals: existing.permApprovals,
      policies: existing.permPolicies,
      audit: existing.permAudit,
    };
    let role = existing.role;

    if ('role' in body) {
      if (!isRole(body.role)) {
        throw badRequest('invalid_role', `role must be one of ${PLATFORM_ROLES.join(', ')}.`);
      }
      refuseOwnerRole(body.role);
      role = body.role;
      sections = { ...PLATFORM_ROLE_PRESETS[body.role] };
    }

    if ('sections' in body) {
      const patch = body.sections;
      if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
        throw badRequest('invalid_sections', 'sections must be an object of booleans.');
      }
      for (const [key, value] of Object.entries(patch)) {
        if (!(PLATFORM_SECTIONS as readonly string[]).includes(key)) {
          throw badRequest(
            'invalid_section',
            `Unknown section: ${key}. One of ${PLATFORM_SECTIONS.join(', ')}.`,
          );
        }
        if (typeof value !== 'boolean') {
          throw badRequest('invalid_section', `sections.${key} must be true or false.`);
        }
        sections[key as PlatformSection] = value;
      }
    }

    const [row] = await db
      .update(platformAdmin)
      .set({ role, ...sectionColumns(sections), updatedAt: new Date() })
      .where(eq(platformAdmin.id, req.params.id))
      .returning();
    if (!row) throw notFound('unknown_admin', 'No such console admin.');

    await writeAudit(db, p, {
      salonId: null,
      kind: 'access',
      action: 'Console access changed',
      detail: `${row.name} (@${row.handle}) · ${row.role} · ${
        Object.entries(sections)
          .filter(([, on]) => on)
          .map(([k]) => k)
          .join(', ') || 'no sections'
      }`,
      source: 'owner_console',
      subjectType: 'platform_admin',
      subjectId: row.id,
      metadata: { role, sections },
      ipAddress: req.ip ?? null,
      userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
    });

    return reply.send(serialisePlatformAdmin(row));
  });

  /**
   * The ✕. DEACTIVATES, does not delete — the same distinction the Shop editor's
   * ✕ makes, and here it matters more: `audit_log`'s actor columns are a snapshot
   * precisely so a removed person's decisions still read "Yousef · Owner" seven
   * years later, and `campaign.decided_by` is a snapshot for the same reason. A
   * deleted row would also cascade her sessions away, which is the one part of
   * removal that must happen immediately — so it is done explicitly below.
   */
  app.delete<{ Params: { id: string } }>('/v1/platform/admins/:id', async (req, reply) => {
    const p = requirePlatform(req, 'admins');

    const [existing] = await db
      .select()
      .from(platformAdmin)
      .where(eq(platformAdmin.id, req.params.id))
      .limit(1);
    if (!existing) throw notFound('unknown_admin', 'No such console admin.');
    if (existing.owner) throw forbidden('The platform owner cannot be removed.');
    /**
     * SHE CANNOT REMOVE HERSELF. Not a courtesy: the console's `admins` section is
     * the only route back in, and an admin who deactivates her own account mid-session
     * locks a section of the product behind a row nobody can edit until somebody
     * touches the database. The owner is the escape hatch and cannot be removed.
     */
    if (existing.id === p.id) {
      throw forbidden('You cannot remove your own console account.');
    }
    if (!existing.active) throw notFound('unknown_admin', 'No such console admin.');

    /**
     * DEACTIVATION SPENDS HER OUTSTANDING RESET LINKS, in the same transaction as
     * the deactivation itself.
     *
     * Without this, removal had a hole that revoking sessions did not cover: a link
     * issued before the ✕ would still redeem afterwards, and redemption sets a
     * password. The redeem endpoint ALSO refuses an inactive admin, so this is the
     * second of two independent guards rather than the only one — but it is the one
     * that makes the link stop existing rather than merely stop working, which is
     * what someone auditing the table months later needs to see.
     */
    const spent = await db.transaction(async (tx) => {
      await tx
        .update(platformAdmin)
        .set({ active: false, updatedAt: new Date() })
        .where(eq(platformAdmin.id, existing.id));

      const burned = await tx
        .update(platformAdminPasswordReset)
        .set({ usedAt: new Date() })
        .where(
          and(
            eq(platformAdminPasswordReset.platformAdminId, existing.id),
            isNull(platformAdminPasswordReset.usedAt),
          ),
        )
        .returning({ id: platformAdminPasswordReset.id });
      return burned.length;
    });

    /**
     * Her sessions go NOW. `loadPlatformPrincipal` already refuses a deactivated
     * row on every request, so this is the second statement of the same fact — and
     * it is worth making, because it is the one that survives a future caching
     * layer in front of the principal load.
     */
    const dropped = await revokeAllSessions(
      db,
      { kind: 'platform_admin', id: existing.id },
      'admin_deactivated',
    );

    await writeAudit(db, p, {
      salonId: null,
      kind: 'access',
      action: 'Console admin removed',
      detail:
        `${existing.name} (@${existing.handle}) deactivated · ${dropped} session(s) ended` +
        (spent > 0 ? ` · ${spent} reset link(s) invalidated` : ''),
      source: 'owner_console',
      subjectType: 'platform_admin',
      subjectId: existing.id,
      metadata: { sessionsRevoked: dropped, resetLinksInvalidated: spent },
      ipAddress: req.ip ?? null,
      userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
    });

    return reply.code(204).send();
  });

  // ------------------------------------------------------- password reset --
  /**
   * `POST /v1/platform/admins/{id}/password-reset` — `admins`.
   *
   * THE DOOR THAT DID NOT EXIST. Until this endpoint, an invited platform admin
   * could not sign in at all: the invite creates her with `password_hash` NULL,
   * which non-negotiable #6 requires, and `POST /auth/platform/session` refuses a
   * NULL hash. This file's own header recorded the gap rather than working around it
   * by accepting a plaintext password, which was the right call and left the product
   * with an account nobody could use.
   *
   * THE TWO THINGS IT MUST NEVER DO, AND DOES NOT:
   *
   *   - it does not accept a password. There is no body field that sets one, and
   *     `password` / `temporaryPassword` are refused BY NAME, the way the invite
   *     refuses them: a console that sent one believed it had set a credential, and
   *     silently ignoring it would leave an admin who cannot sign in and an inviter
   *     who thinks she can.
   *   - it does not RETURN the token. The response is 202 carrying the expiry and
   *     nothing else. A link that comes back through the inviter's browser is a
   *     credential in the wrong pair of hands — it would sit in her network log, and
   *     she could set the password herself and know it. "Sends a link" means the
   *     link goes to the admin.
   *
   * THE OWNER CAN RECEIVE ONE, and that is deliberate where the ✕ and the section
   * chips are refused for her. The design renders "Reset password" on every row
   * including hers, and the reason is structural rather than cosmetic: the owner is
   * the escape hatch this file's DELETE handler names ("The owner is the escape hatch
   * and cannot be removed"), so an owner who has lost her password with no way to
   * request a link is the one lockout with nothing behind it. Resetting a credential
   * is not editing authority.
   *
   * A DEACTIVATED ADMIN IS REFUSED, which is the opposite of `routes/staff.ts` and
   * the difference is real rather than an inconsistency. There, a leaver's row is the
   * re-hire path — `handle_taken` on `POST /staff` tells a manager to "re-activate
   * that account with a reset link instead", so the link has to work. Here, the ✕ IS
   * removal: `revokeAllSessions` runs immediately and `loadPlatformPrincipal` refuses
   * the row on every request. Issuing a link to a removed admin would be a way back
   * into the owner console for somebody who was deliberately taken out of it, and
   * "re-invite her" is a separate deliberate act with its own audit row.
   *
   * ISSUING A SECOND ONE SPENDS THE FIRST. Otherwise two links are live at once and
   * the older one — the one somebody may already be walking to a desk with — is the
   * one nobody knows is still valid.
   *
   * 202, not 200: what is being reported is ACCEPTED, not done. No sender is wired,
   * for the reason receipts/types.ts sets out, so `sent_at` is the outbox stamp
   * waiting for one. Reported as an escalation rather than implied — the flow exists
   * and delivery does not.
   */
  app.post<{ Params: { id: string } }>(
    '/v1/platform/admins/:id/password-reset',
    async (req, reply) => {
      const p = requirePlatform(req, 'admins');

      const body = (req.body ?? {}) as Record<string, unknown>;
      if ('password' in body || 'temporaryPassword' in body) {
        throw badRequest(
          'password_not_accepted',
          'The console never sets a password. The admin receives a reset link and sets her own.',
        );
      }

      const [target] = await db
        .select()
        .from(platformAdmin)
        .where(eq(platformAdmin.id, req.params.id))
        .limit(1);
      if (!target) throw notFound('unknown_admin', 'No such console admin.');
      /**
       * Same refusal text and shape as an unknown id, so a removed admin's continued
       * existence is not something this endpoint reveals. She is gone as far as the
       * console is concerned.
       */
      if (!target.active) throw notFound('unknown_admin', 'No such console admin.');

      const token = mintResetToken();
      const expiresAt = new Date(Date.now() + RESET_TTL_MINUTES * 60_000);

      await db.transaction(async (tx) => {
        await tx
          .update(platformAdminPasswordReset)
          .set({ usedAt: new Date() })
          .where(
            and(
              eq(platformAdminPasswordReset.platformAdminId, target.id),
              isNull(platformAdminPasswordReset.usedAt),
            ),
          );

        await tx.insert(platformAdminPasswordReset).values({
          platformAdminId: target.id,
          tokenHash: hashResetToken(token),
          requestedBy: p.name,
          expiresAt,
        });

        await writeAudit(tx, p, {
          salonId: null,
          kind: 'access',
          action: 'Console password reset link sent',
          /**
           * Names who and when. NEVER the token — an audit row is read by more
           * people, and for longer, than the endpoint's response is.
           */
          detail:
            `${target.name} (@${target.handle}) — link valid for ${RESET_TTL_MINUTES} minutes` +
            (target.passwordHash === null ? ' · first sign-in' : ''),
          source: 'owner_console',
          subjectType: 'platform_admin',
          subjectId: target.id,
          metadata: {
            expiresAt: expiresAt.toISOString(),
            ttlMinutes: RESET_TTL_MINUTES,
            firstSignIn: target.passwordHash === null,
            self: target.id === p.id,
          },
          ipAddress: req.ip ?? null,
          userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
        });
      });

      return reply.code(202).send({
        adminId: target.id,
        expiresAt: expiresAt.toISOString(),
        /** No sender is wired. Stated, so the console does not claim it arrived. */
        delivered: false,
        /**
         * So the console can say "invite sent" for an admin who has never signed in
         * and "reset link sent" for one who has — the distinction its own row makes
         * between "Reset password" and "Link sent".
         */
        firstSignIn: target.passwordHash === null,
      });
    },
  );
}
