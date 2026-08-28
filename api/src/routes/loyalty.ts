/**
 * The loyalty editor — design/AVO Merchant Dashboard.dc.html § Loyalty.
 *
 *   GET /salons/{id}/loyalty   merchant: perms.loyalty · console: sections.salons
 *   PUT /salons/{id}/loyalty   console:  sections.salons  — MERCHANT REFUSED
 *
 * ==========================================================================
 * LOYALTY AUTHORITY MOVED FROM THE MERCHANT TO AVO. THIS REVERSES A SETTLED
 * DECISION; IT DOES NOT FILL A GAP.
 * ==========================================================================
 * Aftab, verbatim: *"Owner console will control the loyalty part not the
 * merchant (it will be read only for merchant)."*
 *
 * `design/README.md:136` records the decision being reversed, in the past tense
 * of something finished: the merchant Loyalty screen has "per-tier Visits and
 * Bonus % inputs … and a **Publish changes** button", and "(This closes the
 * phase-2 open item — merchants now edit their own tier rules.)" Line 283 lists
 * "merchant-editable tier rules" among the items CLOSED in a previous revision.
 *
 * So the merchant editor was not an oversight and was not wrong. It was built to
 * a decision that has since changed. Everything below is the withdrawal of a
 * working capability, and the 403 it produces is a `loyalty_read_only` rather
 * than a permission failure precisely so that nobody downstream mistakes this
 * for a chip somebody forgot to tick. See `http/errors.ts § loyaltyReadOnly`.
 *
 * WHAT THE MERCHANT KEEPS: the GET, unchanged in shape. Read-only is the point —
 * her Loyalty screen still renders the live ladder and the "10 → 11 KD" preview,
 * it simply has no Publish. The ladder was never secret; it is already public to
 * every customer of the salon through `GET /salons/{id}`.
 *
 * THE CONSOLE'S GATE IS `sections.salons`, ARGUED NOT DEFAULTED. It is the
 * section that already gates the console's per-salon authority —
 * `GET/PATCH /v1/platform/salons/{id}` and `POST /v1/platform/salons` — and the
 * console's salon editor already draws "loyalty structure with tier thresholds/
 * bonuses or stamp target" (routes/salons.ts § PLATFORM_EDITABLE). `analytics`
 * was rejected for the reason `POST /v1/platform/salons` gives at length: every
 * role preset holds it, `analyst` included, and an analyst is "read-only
 * metrics". Publishing a ladder is the most money-adjacent per-salon write the
 * console has — it decides what a top-up is worth — so it belongs with the other
 * management authority, not with reading.
 *
 * ONE PAIR OF ENDPOINTS, NOT A SECOND CONSOLE-SPELLED PAIR under
 * `/v1/platform/...`. This file's own history is the argument: the tier ladder
 * acquired an unvalidated second entrance through `PATCH /salons/{id}` and the
 * note below records what that cost. A `/v1/platform/salons/{id}/loyalty` would
 * be a second transaction writing `salon.tiers`, and the console's copy is the
 * one nobody would be watching. The authority is resolved from the PRINCIPAL,
 * the way `routes/support.ts § requireQueueReader` already does it for the two
 * support consoles.
 *
 * WHAT "ATOMIC" MEANS HERE, AND WHY IT IS MOSTLY NOT CODE
 * ------------------------------------------------------
 * build-plan.md phase 4 requires the publish to be atomic, and the reason is
 * money: a member who tops up between two halves of a ladder write is priced by
 * a ladder that never existed. If Gold moved 10 → 12 and the bonus 20% → 25%,
 * an interleaved top-up could be charged against 10 visits at 25%.
 *
 * The guarantee comes from the schema, not from careful sequencing here.
 * `salon.tiers` is ONE jsonb column holding the whole ladder — see
 * db/schema/salon.ts, which says so at the column — so four rungs are written by
 * a single UPDATE to a single field. There is no interleaving point to protect,
 * because there is no second write to the ladder.
 *
 * What this handler adds on top is that the ladder and its AUDIT ROW commit
 * together, in one `db.transaction`. A published ladder with no record of who
 * published it is exactly the state the audit log exists to prevent, and
 * services/audit.ts takes an executor so the row can ride the same transaction.
 * Proven by fault injection: a trigger made to raise on the audit insert leaves
 * the old ladder live.
 *
 * A NOTE ON WHAT IS *NOT* GUARDED
 * -------------------------------
 * There is no optimistic-concurrency token. Two managers publishing different
 * ladders within the same second means the second one wins, whole. That is the
 * correct outcome for this data — a ladder is edited and published as a
 * document, and "last writer wins" on a document is a coherent ladder, whereas
 * merging two would produce a rung ordering neither manager chose. The dashboard
 * already draws the difference ("Unsaved changes — customers see the old rules
 * until you publish"), and the audit log names both publishes.
 *
 * WHY `PATCH /salons/{id}` ALSO ROUTES THROUGH THE VALIDATOR
 * ---------------------------------------------------------
 * That endpoint listed `tiers`, `loyaltyMode`, `stampTarget` and the stamp
 * reward copy as editable and validated none of them, so every rule below could
 * be walked around by sending the same fields one route over. Publishing an
 * invalid ladder through the unguarded door is not a smaller bug than publishing
 * it through this one. See routes/salons.ts.
 */

import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { db } from '../db/client';
import { salon } from '../db/schema/salon';
import {
  requireDashboardPerm,
  requirePlatform,
  requirePrincipal,
  requireSameSalon,
  type PlatformPrincipal,
  type StaffPrincipal,
} from '../auth/principal';
import { loyaltyReadOnly, notFound } from '../http/errors';
import { writeAudit } from '../services/audit';
import {
  describeLoyaltyChange,
  parseLoyaltyConfig,
  previewLadder,
  type LoyaltyConfig,
} from '../services/loyaltyRules';

/** The salon's loyalty columns, as the validator wants them. */
export function loyaltyConfigOf(row: typeof salon.$inferSelect): LoyaltyConfig {
  return {
    mode: row.loyaltyMode,
    tiers: row.tiers,
    stampTarget: row.stampTarget,
    stampReward: row.stampReward,
    stampRewardAr: row.stampRewardAr,
  };
}

function serialiseLoyalty(config: LoyaltyConfig) {
  return {
    loyaltyMode: config.mode,
    tiers: config.tiers,
    stampTarget: config.stampTarget,
    stampReward: config.stampReward,
    stampRewardAr: config.stampRewardAr,
    /**
     * The "10 → 11 KD" line under each card, computed server-side with the same
     * `percentOf` that prices a real top-up. The dashboard could do this
     * arithmetic itself — the design does — but then the number a merchant reads
     * before publishing and the number a customer is credited afterwards come
     * from two implementations of the same rounding rule, and there is no test
     * that can notice when they diverge.
     *
     * Null in stamps mode: there is no top-up bonus to preview.
     */
    preview: config.mode === 'tiers' && config.tiers ? previewLadder(config.tiers) : null,
  };
}

/**
 * WHO MAY READ A SALON'S LADDER — the merchant who owns it, or AVO.
 *
 * Two principals, two different boundaries, and they are different QUESTIONS
 * rather than two strengths of the same one. `routes/support.ts §
 * requireQueueReader` is the precedent and the shape is deliberately identical.
 *
 * `requireSameSalon` IS STILL RIGHT — FOR THE MERCHANT, AND ONLY HER. It is the
 * tenancy boundary for a salon-scoped credential and nothing here weakens it: a
 * manager at SAL-AMARA reading SAL-LUMIERE's ladder is refused exactly as before.
 *
 * It is NOT applied to the console, and that is not an exemption granted here —
 * it is not expressible. `PlatformPrincipal` has no `salonId` field at all, so
 * `requireSameSalon(p, id)` on one does not compile (see auth/principal.ts,
 * which says so at the type). A platform admin's boundary is `requirePlatform`,
 * and it is the question "may this console account touch salons at all", which
 * is answered above. Editing salon X's ladder without being able to read it back
 * would be an editor that cannot show what it is editing.
 */
function requireLoyaltyReader(
  req: FastifyRequest,
  salonId: string,
): PlatformPrincipal | StaffPrincipal {
  const p = requirePrincipal(req);
  if (p.kind === 'platform_admin') return requirePlatform(req, 'salons');
  const staff = requireDashboardPerm(req, 'loyalty');
  requireSameSalon(staff, salonId);
  return staff;
}

/**
 * WHO MAY PUBLISH ONE — AVO, and nobody else.
 *
 * THE STAFF REFUSAL IS FIRST, BEFORE `requirePlatformScope`, AND THE ORDER IS
 * THE WHOLE POINT. Falling through to the platform gate would refuse a merchant
 * with "This endpoint is the AVO owner console, not the salon dashboard." — and
 * that is untrue in the one way that matters. She IS on the right endpoint; it
 * is her own salon's loyalty URL, the same one her GET reads a line above, and
 * the one her dashboard has been publishing to since phase 4. What changed is
 * the authority behind it, and the refusal has to say so.
 *
 * NOTHING IS LOOKED UP BEFORE IT. Not the salon, not the body, not the
 * permission. Two reasons, and the second is the stronger:
 *
 *   1. `requirePerm`'s own note — an endpoint that resolves an id and only then
 *      checks authority has already told an unauthorised caller whether that id
 *      exists.
 *   2. IT REFUSES ON PRINCIPAL KIND ALONE, so a merchant at SAL-AMARA aiming at
 *      SAL-LUMIERE learns nothing about SAL-LUMIERE — not whether it exists, not
 *      whether she is inside it. Checking `requireSameSalon` first would have
 *      been the natural-looking order and would have leaked the tenancy answer
 *      to a caller who may not write either salon.
 *
 * A MEMBER falls through to `requirePlatformScope`, which refuses her by
 * surface. Correct: a customer here is confused, not withdrawn.
 */
function requireLoyaltyPublisher(req: FastifyRequest): PlatformPrincipal {
  const p = requirePrincipal(req);
  if (p.kind === 'staff') throw loyaltyReadOnly();
  return requirePlatform(req, 'salons');
}

export async function registerLoyaltyRoutes(app: FastifyInstance): Promise<void> {
  // -------------------------------------------- GET /salons/{id}/loyalty --
  /**
   * READ-ONLY IS THE POINT, SO THIS KEEPS WORKING — unchanged in shape, and now
   * reachable by the console as well.
   *
   * `perms.loyalty` is no longer "the same permission as the write", which is
   * what this comment used to say. It is now the permission to SEE the editor,
   * and there is nothing behind it to protect: the ladder is already public to
   * every customer of the salon through `GET /salons/{id}`. It stays gated
   * anyway because the screen is a dashboard screen, and #7 does not permit an
   * ungated dashboard endpoint on a whim.
   */
  app.get<{ Params: { id: string } }>('/salons/:id/loyalty', async (req, reply) => {
    requireLoyaltyReader(req, req.params.id);

    const rows = await db.select().from(salon).where(eq(salon.id, req.params.id)).limit(1);
    const s = rows[0];
    if (!s) throw notFound('unknown_salon', 'No such salon.');

    return reply.send(serialiseLoyalty(loyaltyConfigOf(s)));
  });

  // -------------------------------------------- PUT /salons/{id}/loyalty --
  /**
   * `sections.salons` — the console's **Publish changes**. A merchant holding
   * `perms.loyalty` is refused here; see `requireLoyaltyPublisher`.
   */
  app.put<{ Params: { id: string } }>('/salons/:id/loyalty', async (req, reply) => {
    // FIRST STATEMENT. Before the salon is read and before the body is parsed.
    const p = requireLoyaltyPublisher(req);

    const rows = await db.select().from(salon).where(eq(salon.id, req.params.id)).limit(1);
    const s = rows[0];
    if (!s) throw notFound('unknown_salon', 'No such salon.');

    const before = loyaltyConfigOf(s);
    /**
     * Validated BEFORE the transaction opens. Every refusal below is a 400 that
     * has written nothing, so a rejected ladder cannot leave a lock held or a
     * partial state behind — there is nothing to roll back because nothing
     * started. "Fix the highlighted tier before saving" is a client-side state
     * in the design; this is the same rule with authority.
     */
    const after = parseLoyaltyConfig((req.body ?? {}) as Record<string, unknown>, before);

    const detail = describeLoyaltyChange(before, after);
    const publishedAt = new Date();

    /**
     * ONE TRANSACTION, ONE UPDATE, ONE AUDIT ROW.
     *
     * The UPDATE sets every loyalty column at once — mode, ladder, stamp target
     * and reward copy — rather than only the ones that changed. Switching
     * mechanic is the case that matters: `salon_loyalty_config_complete` requires
     * the configuration for whichever mode is active, so mode and its
     * configuration have to move in the same statement or the row is briefly
     * illegal. Postgres checks a CHECK per statement, so "briefly" would mean
     * "the statement fails".
     */
    const published = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(salon)
        .set({
          loyaltyMode: after.mode,
          tiers: after.tiers,
          stampTarget: after.stampTarget,
          stampReward: after.stampReward,
          stampRewardAr: after.stampRewardAr,
          updatedAt: publishedAt,
        })
        .where(eq(salon.id, req.params.id))
        .returning();

      if (!updated) throw notFound('unknown_salon', 'No such salon.');

      /**
       * ================================================================
       * THE AUDIT ROW, AND THE LINE THAT WOULD HAVE BEEN QUIETLY WRONG.
       * ================================================================
       * `salonId` WAS `p.salonId` — the ACTOR's salon. That was right while the
       * only actor was a manager publishing her own salon's ladder, and it is
       * the exact line this reversal breaks: `PlatformPrincipal` has no
       * `salonId`, because a platform admin has no salon. TypeScript catches the
       * literal `p.salonId` here, which is the one mercy; what it cannot catch
       * is the natural-looking repair, `salonId: null`.
       *
       * `null` WOULD COMPILE, WOULD LOOK CORRECT, AND WOULD DELETE THE ROW FROM
       * THE ONLY LOG THAT NEEDS IT. `routes/audit.ts` — the merchant's own audit
       * read — filters on `eq(auditLog.salonId, p.salonId)`, and its header says
       * what that excludes: "Platform actions belonging to NO salon have a null
       * `salon_id` and are therefore invisible here." So a null would put an AVO
       * ladder change in AVO's own log and nowhere else, and the merchant who
       * opens her Loyalty screen to find Gold moved from 10 visits to 12 would
       * have no row to read. That is precisely the question this slice exists to
       * keep answerable, and the failure would be silent in both directions —
       * the publish succeeds, the platform log looks complete.
       *
       * So `salonId` is the TARGET salon. `PATCH /v1/platform/salons/{id}` made
       * this same call and wrote the same note: "`salonId` is the TARGET salon,
       * not null. A platform admin has no salon of her own, and an AVO action on
       * a salon belongs in that salon's log."
       *
       * `updated.id` rather than `req.params.id`: the UPDATE returned it, so the
       * row is written against a salon that demonstrably exists and was
       * demonstrably the one changed, inside the transaction that changed it.
       *
       * `source` IS `owner_console`, AND IT IS THE WHOLE DISTINCTION. The
       * `action` stays "Tier rules published" — the same string the merchant
       * door wrote — because the design's audit log renders Who / What / Detail
       * / Source as four columns, and an AVO publish and a merchant publish are
       * the same ACT by different actors. Inventing a second action string would
       * split one thing across two rows of a table somebody scans for "who
       * changed the tier rules". `routes/audit.ts` promises the merchant exactly
       * this: "AVO platform staff actions on your salon appear here too, marked
       * **Owner console**."
       *
       * THE ACTOR ITSELF NEEDED NOTHING. `services/audit.ts § actorOf` has had a
       * `platform_admin` branch since before any platform principal existed —
       * its comment calls it "THE BRANCH THAT COULD NOT BE REACHED" — so the row
       * lands as "Yousef · AVO platform", `actor_kind = 'platform_admin'`,
       * `actor_id = 'PLT-001'`. The console role is deliberately not the
       * `actor_role`; that column answers "on whose authority", and the answer a
       * salon is owed is AVO's.
       */
      await writeAudit(tx, p, {
        salonId: updated.id,
        kind: 'rules',
        action: after.mode === 'tiers' ? 'Tier rules published' : 'Stamp rules published',
        detail,
        source: 'owner_console',
        subjectType: 'salon',
        subjectId: updated.id,
        metadata: { before, after },
        ipAddress: req.ip ?? null,
        userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
      });

      return updated;
    });

    return reply.send({
      ...serialiseLoyalty(loyaltyConfigOf(published)),
      publishedAt: publishedAt.toISOString(),
      publishedBy: p.name,
      /**
       * The toast in the design reads "Tier rules published — customers see them
       * now." Returned rather than hardcoded in the client for the same reason
       * the 403 copy is: one place decides what the product says happened.
       */
      message:
        after.mode === 'tiers'
          ? 'Tier rules published — customers see them now.'
          : 'Stamp rules published — customers see them now.',
      /**
       * "Changing a threshold re-evaluates tiers on each customer's next visit."
       * Stated on the wire because it is the one thing about this operation a
       * merchant can get wrong: nobody is demoted or promoted at publish time,
       * and existing balances are never touched.
       */
      appliesAt: 'next_visit',
    });
  });
}
