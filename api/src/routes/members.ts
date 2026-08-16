/**
 * Customer-facing reads. The wallet's whole bootstrap lives here.
 *
 * `GET /members/me/wallet-token` mints the rotating QR. The client never mints
 * it (non-negotiable #2), the raw value is returned exactly once and stored only
 * as a sha256, and it lives 45 seconds. The countdown in the UI is cosmetic —
 * expiry and single-use consumption are decided here and in
 * services/walletToken.ts.
 */

import { desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { walletTokenUri } from '@avo/types';
import { db } from '../db/client';
import { member } from '../db/schema/member';
import { transaction } from '../db/schema/transaction';
import { requireMember } from '../auth/principal';
import { notFound } from '../http/errors';
import { mintToken } from '../services/walletToken';
import { serialiseMember } from './auth';

export async function registerMemberRoutes(app: FastifyInstance): Promise<void> {
  app.get('/members/me', async (req, reply) => {
    const p = requireMember(req);
    const rows = await db.select().from(member).where(eq(member.id, p.id)).limit(1);
    const m = rows[0];
    if (!m) throw notFound('unknown_member', 'No such member.');
    return reply.send(serialiseMember(m));
  });

  app.get('/members/me/transactions', async (req, reply) => {
    const p = requireMember(req);
    const rows = await db
      .select()
      .from(transaction)
      .where(eq(transaction.memberId, p.id))
      .orderBy(desc(transaction.createdAt))
      .limit(50);

    return reply.send({
      items: rows.map((t) => ({
        id: t.id,
        memberId: t.memberId,
        branchId: t.branchId,
        kind: t.kind,
        amountFils: t.amountFils,
        bonusFils: t.bonusFils,
        method: t.method,
        status: t.status,
        reference: t.reference,
        createdAt: t.createdAt.toISOString(),
      })),
      nextCursor: null,
    });
  });

  /** Server-minted, 45s, single use. Returned once — only its hash is stored. */
  app.get('/members/me/wallet-token', async (req, reply) => {
    const p = requireMember(req);
    const minted = await mintToken(db, p.id);
    return reply.send({
      memberId: minted.memberId,
      token: minted.token,
      expiresAt: minted.expiresAt.toISOString(),
      uri: walletTokenUri(minted.memberId, minted.token),
    });
  });
}
