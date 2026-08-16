/**
 * The loyalty editor — design/AVO Merchant Dashboard.dc.html § Loyalty.
 *
 *   GET /salons/{id}/loyalty   perms.loyalty   what is live, plus the preview
 *   PUT /salons/{id}/loyalty   perms.loyalty   Publish changes
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
import type { FastifyInstance } from 'fastify';
import { db } from '../db/client';
import { salon } from '../db/schema/salon';
import { requireDashboardPerm, requireSameSalon } from '../auth/principal';
import { notFound } from '../http/errors';
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

export async function registerLoyaltyRoutes(app: FastifyInstance): Promise<void> {
  // -------------------------------------------- GET /salons/{id}/loyalty --
  /**
   * perms.loyalty. The same permission as the write: this is the editor's own
   * bootstrap, and the ladder it returns is already public to every customer of
   * the salon through `GET /salons/{id}`. What is gated is the editing surface,
   * not the secrecy of the numbers.
   */
  app.get<{ Params: { id: string } }>('/salons/:id/loyalty', async (req, reply) => {
    const p = requireDashboardPerm(req, 'loyalty');
    requireSameSalon(p, req.params.id);

    const rows = await db.select().from(salon).where(eq(salon.id, req.params.id)).limit(1);
    const s = rows[0];
    if (!s) throw notFound('unknown_salon', 'No such salon.');

    return reply.send(serialiseLoyalty(loyaltyConfigOf(s)));
  });

  // -------------------------------------------- PUT /salons/{id}/loyalty --
  /** perms.loyalty — the design's **Publish changes** button. */
  app.put<{ Params: { id: string } }>('/salons/:id/loyalty', async (req, reply) => {
    // FIRST STATEMENT. Before the salon is read and before the body is parsed.
    const p = requireDashboardPerm(req, 'loyalty');
    requireSameSalon(p, req.params.id);

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

      // The design's own audit line: "Tier rules published · Gold threshold
      // 10 → 12 visits", kind `rules`, source Merchant.
      await writeAudit(tx, p, {
        salonId: p.salonId,
        kind: 'rules',
        action: after.mode === 'tiers' ? 'Tier rules published' : 'Stamp rules published',
        detail,
        source: 'merchant',
        subjectType: 'salon',
        subjectId: req.params.id,
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
