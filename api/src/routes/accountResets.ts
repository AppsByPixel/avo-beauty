/**
 * `POST /accounts/{id}/reset-link` — the console's "Send reset link", on the
 * mixed Accounts list.
 *
 * api-contract.md § Operations: "| Owner | Reset link | POST /accounts/{id}/
 * reset-link |". The design's Accounts section lists CUSTOMERS, STAFF and SALON
 * OWNERS in one table and draws the button on every row, under the banner
 * "Passwords are never stored or shown" — non-negotiable #6's sentence.
 *
 * THE INVESTIGATION THIS ROUTE ANSWERS (trunk asked before building): is the row
 * already satisfied by the three reset flows? NO, and precisely why matters —
 *
 *   staff issue     POST /staff/{id}/password-reset is `requireDashboardPerm`,
 *                   a MERCHANT credential, salon-scoped to the caller's own
 *                   salon. A platform admin cannot call it at all.
 *   member issue    POST /auth/member/password-reset/request is SELF-SERVICE by
 *                   phone, unauthenticated and IP-throttled. A console calling
 *                   it would be an impersonation: its audit row says SHE asked.
 *   console admins  POST /v1/platform/admins/{id}/password-reset covers
 *                   platform admins, who are the Admins section, not this list.
 *
 * SO THIS IS NOT A FOURTH RESET FLOW — it is a fourth ISSUER DOOR into the two
 * existing ones. Same tables (`staff_password_reset`, `member_password_reset`),
 * same token mint and sha256 storage, same 60-minute TTL, and the SAME REDEEM
 * ENDPOINTS the staff and member already use — nothing new to redeem, nothing
 * new to leak. The issue transaction (spend outstanding, insert hashed) is the
 * three-statement shape both siblings use; it is repeated here per kind rather
 * than extracted, because refactoring two working money-adjacent routes to
 * de-duplicate nine lines is more risk than nine lines.
 *
 * `kind` IS EXPLICIT IN THE BODY ('customer' | 'staff'), not inferred by
 * probing both tables with the id. Ids are opaque by contract, so nothing
 * guarantees the two id spaces stay disjoint — and an id that matched BOTH
 * tables would silently pick whichever this code probed first. The console's
 * list knows the role of every row it renders; making it say so costs one field
 * and removes a class of wrong-account resets. A salon owner is a staff_user,
 * so the design's third role is `kind: 'staff'`.
 *
 * KIND-SPECIFIC RULES ARE INHERITED, NOT INVENTED:
 *   - a DEACTIVATED STAFF member may receive a link — that is the re-hire path,
 *     exactly as the merchant issuer allows and for the reasons argued there
 *     (routes/staff.ts): the link is an invitation, re-activation happens at
 *     redemption, and her history stays on one identity.
 *   - an ERASED MEMBER is refused 409 `member_erased` — a tombstone has no
 *     phone for the message to reach and nobody to hold the account.
 *   - a member in the DELETION WINDOW issues normally, clock untouched — the
 *     window exists so she can come back, same ruling as the self-service flow.
 *
 * The response is 202 with the expiry and NEVER the token — the same half of #6
 * every issuer keeps: a link that returns through the issuer's browser is a
 * credential in the wrong hands. `delivered: false`, honestly: the same
 * unwired-sender escalation as all three siblings.
 *
 * GATE: `requirePlatform(req, 'accounts')` — the screen the button is drawn on,
 * the same argument as the wallet adjust one file over.
 */

import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { db } from '../db/client';
import { member, memberPasswordReset } from '../db/schema/member';
import { staffPasswordReset, staffUser } from '../db/schema/staff';
import { requirePlatform } from '../auth/principal';
import { badRequest, conflict, notFound } from '../http/errors';
import { hashPasswordResetToken, mintPasswordResetToken } from '../auth/tokens';
import { requireString } from '../money/validate';
import { writeAudit } from '../services/audit';

/** Sixty minutes, matching every issuer. A different window nobody chose. */
const RESET_TTL_MINUTES = 60;

export async function registerAccountResetRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { id: string } }>('/accounts/:id/reset-link', async (req, reply) => {
    const p = requirePlatform(req, 'accounts');

    const body = (req.body ?? {}) as Record<string, unknown>;
    // Refused BY NAME, as every issuer refuses them: a console that sent one
    // believed it set a credential.
    if ('password' in body || 'temporaryPassword' in body) {
      throw badRequest(
        'password_not_accepted',
        'The console never sets a password. The account holder receives a reset link and sets her own.',
      );
    }
    const kind = requireString(body.kind, 'kind', 20);
    if (kind !== 'customer' && kind !== 'staff') {
      throw badRequest('invalid_kind', "kind must be 'customer' or 'staff'.");
    }

    const token = mintPasswordResetToken();
    const tokenHash = hashPasswordResetToken(token);
    const expiresAt = new Date(Date.now() + RESET_TTL_MINUTES * 60_000);
    const clientMeta = {
      ipAddress: req.ip ?? null,
      userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
    };

    if (kind === 'staff') {
      const [target] = await db.select().from(staffUser).where(eq(staffUser.id, req.params.id)).limit(1);
      if (!target) throw notFound('unknown_account', 'No such account.');
      const reactivating = target.deactivatedAt !== null;

      await db.transaction(async (tx) => {
        await tx
          .update(staffPasswordReset)
          .set({ usedAt: new Date() })
          .where(and(eq(staffPasswordReset.staffId, target.id), isNull(staffPasswordReset.usedAt)));
        await tx.insert(staffPasswordReset).values({
          staffId: target.id,
          salonId: target.salonId,
          tokenHash,
          requestedBy: p.name,
          expiresAt,
        });
        await writeAudit(tx, p, {
          salonId: target.salonId,
          kind: 'access',
          action: reactivating ? 'Re-activation link sent' : 'Password reset link sent',
          detail:
            `${target.name} (@${target.handle}) — link valid for ${RESET_TTL_MINUTES} minutes` +
            (reactivating ? ' · will re-activate a deactivated account' : ''),
          source: 'owner_console',
          subjectType: 'staff_user',
          subjectId: target.id,
          metadata: { expiresAt: expiresAt.toISOString(), ttlMinutes: RESET_TTL_MINUTES, reactivating },
          ...clientMeta,
        });
      });

      return reply
        .code(202)
        .send({ accountId: target.id, kind, expiresAt: expiresAt.toISOString(), delivered: false, reactivating });
    }

    const [m] = await db.select().from(member).where(eq(member.id, req.params.id)).limit(1);
    if (!m) throw notFound('unknown_account', 'No such account.');
    if (m.erasedAt !== null) {
      throw conflict('member_erased', 'That account has been erased. There is nothing to reset.');
    }

    await db.transaction(async (tx) => {
      await tx
        .update(memberPasswordReset)
        .set({ usedAt: new Date() })
        .where(and(eq(memberPasswordReset.memberId, m.id), isNull(memberPasswordReset.usedAt)));
      await tx.insert(memberPasswordReset).values({
        memberId: m.id,
        tokenHash,
        // The issuer table has no name column by design (self-service has no
        // authenticated requester); THIS issuer is authenticated, and the audit
        // row below is where the console admin's name lives.
        requestedIp: req.ip ?? null,
        expiresAt,
      });
      await writeAudit(tx, p, {
        salonId: m.salonId,
        kind: 'access',
        action: 'Password reset link sent',
        detail: `${m.name} — link valid for ${RESET_TTL_MINUTES} minutes`,
        source: 'owner_console',
        subjectType: 'member',
        subjectId: m.id,
        metadata: {
          expiresAt: expiresAt.toISOString(),
          ttlMinutes: RESET_TTL_MINUTES,
          deletionPending: m.deletionRequestedAt !== null,
        },
        ...clientMeta,
      });
    });

    return reply
      .code(202)
      .send({ accountId: m.id, kind, expiresAt: expiresAt.toISOString(), delivered: false });
  });
}
