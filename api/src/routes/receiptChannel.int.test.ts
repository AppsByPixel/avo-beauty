/**
 * THE MERCHANT'S CHANNEL CHOICE, AGAINST REAL ROWS.      (DECISIONS.md #88)
 *
 * The unit spec next door proves the six-way decision with no database. This
 * proves the two things it cannot:
 *
 *   THE FLAG IS ACTUALLY READ ON A MONEY PATH. `queueReceipts` is called from
 *       five places inside money transactions; the defect was that none of them
 *       reached the salon row. A real charge at a salon with WhatsApp off must
 *       queue no WhatsApp job.
 *
 *   THE FLOOR REACHES THE DATABASE. Email-only plus no verified address queues a
 *       WhatsApp row carrying `fallback_reason = 'email_unavailable'` — and the
 *       CHECK refuses both-off, so the dangerous state is unstorable.
 *
 * AND WHAT THIS SLICE DOES NOT DELIVER, asserted rather than promised:
 * `RECEIPT_DRIVER` accepts one value, `logging`, so NOTHING SENDS. Every
 * assertion below is about `receipt_job` ROWS — which channel was queued and
 * which was not. Nobody should read a green run here as "invoices by WhatsApp".
 *
 * `EN-` namespace, per-run suffix — `metrics.int.test.ts` owns `IT-`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

const INT_URL = process.env.AVO_INT_DATABASE_URL;
const suite = INT_URL ? describe : describe.skip;

const SALON = 'SAL-AMARA';
const MANAGER = 'ST-001';
const DEVICE = 'DEV-SCANNER-01';

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
/** Verified address. */
const VERIFIED = `EN-RC-V-${RUN}`;
/** No address at all. */
const NO_EMAIL = `EN-RC-N-${RUN}`;
/** An address she typed that nobody proved she controls. */
const UNVERIFIED = `EN-RC-U-${RUN}`;
const SVC = `EN-RC-SV-${RUN}`;

suite('receipt channels follow the merchant’s choice', () => {
  let app: FastifyInstance;
  let db: (typeof import('../db/client'))['db'];
  let sql: (typeof import('drizzle-orm'))['sql'];
  let issue: (typeof import('../auth/sessions'))['issueSession'];
  let manager: string;
  /** Restored in afterAll — this is a SEEDED salon other suites read. */
  let originalWhatsapp = true;
  let originalEmail = true;

  const exec = async (q: unknown) =>
    (await db.execute(q as never)) as unknown as Array<Record<string, unknown>>;

  const setChannels = (whatsapp: boolean, email: boolean) =>
    db.execute(sql`
      UPDATE salon SET whatsapp_enabled = ${whatsapp}, email_enabled = ${email}
       WHERE id = ${SALON}`);

  beforeAll(async () => {
    db = (await import('../db/client')).db;
    sql = (await import('drizzle-orm')).sql;
    issue = (await import('../auth/sessions')).issueSession;
    app = await (await import('../app')).buildApp();

    const [row] = await exec(
      sql`SELECT whatsapp_enabled, email_enabled FROM salon WHERE id = ${SALON}`,
    );
    originalWhatsapp = row?.whatsapp_enabled === true;
    originalEmail = row?.email_enabled === true;

    const phone = (n: number) => `+9659${String(Date.now() % 1_000_000).padStart(6, '0')}${n}`;
    await db.execute(sql`
      INSERT INTO member (id, salon_id, name, phone, email, email_verified,
                          password_hash, balance_fils, tier, visits, policy_version)
      VALUES
        (${VERIFIED},   ${SALON}, 'EN RC Verified',   ${phone(1)},
         ${`en-rc-${RUN}@example.com`}, true,  'x', 900000, 'bronze', 0, 1),
        (${NO_EMAIL},   ${SALON}, 'EN RC NoEmail',    ${phone(2)}, NULL, false, 'x', 900000, 'bronze', 0, 1),
        (${UNVERIFIED}, ${SALON}, 'EN RC Unverified', ${phone(3)},
         ${`en-rc-u-${RUN}@example.com`}, false, 'x', 900000, 'bronze', 0, 1)`);

    await db.execute(sql`
      INSERT INTO service (id, salon_id, name, price_fils, active)
      VALUES (${SVC}, ${SALON}, ${`EN RC Service ${RUN}`}, 3000, true)`);

    manager = (
      await issue(db, {
        principalKind: 'staff',
        staffId: MANAGER,
        salonId: SALON,
        scope: 'dashboard',
      })
    ).accessToken;
  });

  afterAll(async () => {
    if (db) {
      // RESTORED. This is a seeded salon and the flags are read by other suites;
      // leaving WhatsApp off here would silently change what they measure.
      await setChannels(originalWhatsapp, originalEmail);
      await db.execute(
        sql`DELETE FROM session WHERE member_id IN (${VERIFIED}, ${NO_EMAIL}, ${UNVERIFIED})`,
      );
    }
    await app?.close();
  });

  /** A real charge through the real endpoint, and the rows it queued. */
  async function chargeAndReadJobs(memberId: string) {
    const scanner = (
      await issue(db, {
        principalKind: 'staff',
        staffId: MANAGER,
        salonId: SALON,
        scope: 'scanner',
        deviceId: DEVICE,
      })
    ).accessToken;
    const memberToken = (
      await issue(db, { principalKind: 'member', memberId, salonId: SALON, scope: 'wallet' })
    ).accessToken;
    const wt = await app.inject({
      method: 'GET',
      url: '/members/me/wallet-token',
      headers: { authorization: `Bearer ${memberToken}` },
    });
    expect(wt.statusCode, wt.body).toBe(200);

    const res = await app.inject({
      method: 'POST',
      url: '/charges',
      headers: {
        authorization: `Bearer ${scanner}`,
        'idempotency-key': `en-rc-${RUN}-${Math.random().toString(36).slice(2)}`,
      },
      payload: {
        memberId,
        serviceIds: [SVC],
        token: JSON.parse(wt.body).token,
        confirmDuplicate: true,
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    const txId = (JSON.parse(res.body).transaction ?? JSON.parse(res.body)).id as string;

    const jobs = await exec(sql`
      SELECT channel::text AS channel, fallback_reason
        FROM receipt_job WHERE transaction_id = ${txId} ORDER BY channel`);
    return {
      channels: jobs.map((j) => String(j.channel)),
      fallbacks: jobs.map((j) => j.fallback_reason),
    };
  }

  // ==================================================================
  describe('the flag is read on a real money path', () => {
    it('both on, verified address: both jobs queued', async () => {
      await setChannels(true, true);
      const { channels, fallbacks } = await chargeAndReadJobs(VERIFIED);
      expect(channels).toEqual(['email', 'whatsapp']);
      expect(fallbacks).toEqual([null, null]);
    });

    /**
     * THE DEFECT, INVERTED. Before this, `whatsapp` was an unconditional array
     * literal — so this charge queued a WhatsApp job at a salon that had opted
     * out, which is what SAL-LUMIERE has been doing for every charge.
     */
    it('email only: NO WhatsApp job is queued', async () => {
      await setChannels(false, true);
      const { channels, fallbacks } = await chargeAndReadJobs(VERIFIED);
      expect(channels).toEqual(['email']);
      expect(channels).not.toContain('whatsapp');
      expect(fallbacks).toEqual([null]);
    });

    it('WhatsApp only: no email job, even with a verified address', async () => {
      await setChannels(true, false);
      const { channels } = await chargeAndReadJobs(VERIFIED);
      expect(channels).toEqual(['whatsapp']);
    });

    it('both on but no address: WhatsApp alone, and not marked a fallback', async () => {
      await setChannels(true, true);
      const { channels, fallbacks } = await chargeAndReadJobs(NO_EMAIL);
      expect(channels).toEqual(['whatsapp']);
      // Her preference was honoured in full; there was nowhere to email.
      expect(fallbacks).toEqual([null]);
    });
  });

  // ==================================================================
  describe('the floor reaches the database', () => {
    it('email only + no address: WhatsApp, marked email_unavailable', async () => {
      await setChannels(false, true);
      const { channels, fallbacks } = await chargeAndReadJobs(NO_EMAIL);
      expect(channels).toEqual(['whatsapp']);
      expect(fallbacks).toEqual(['email_unavailable']);
    });

    it('an UNVERIFIED address is not an address — same floor', async () => {
      await setChannels(false, true);
      const { channels, fallbacks } = await chargeAndReadJobs(UNVERIFIED);
      expect(channels).toEqual(['whatsapp']);
      expect(fallbacks).toEqual(['email_unavailable']);
    });

    it('every charge in this run queued at least one job', async () => {
      const [row] = await exec(sql`
        SELECT count(*) AS n FROM "transaction" t
         WHERE t.member_id IN (${VERIFIED}, ${NO_EMAIL}, ${UNVERIFIED})
           AND t.kind = 'charge'
           AND NOT EXISTS (SELECT 1 FROM receipt_job r WHERE r.transaction_id = t.id)`);
      expect(Number(row?.n), 'a settled charge queued no receipt at all').toBe(0);
    });

    /** Both-off is unstorable. The CHECK is the control. */
    it('the database refuses both channels off', async () => {
      await expect(setChannels(false, false)).rejects.toThrow(/salon_receipt_channel_floor/);
      await setChannels(true, true);
    });
  });

  // ==================================================================
  describe('the merchant’s own control', () => {
    const patch = (body: unknown) =>
      app.inject({
        method: 'PATCH',
        url: `/salons/${SALON}`,
        headers: { authorization: `Bearer ${manager}` },
        payload: body as object,
      });

    it('serves both flags so a client can render the real three states', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/salons/${SALON}`,
        headers: { authorization: `Bearer ${manager}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(typeof body.whatsappEnabled).toBe('boolean');
      expect(typeof body.emailEnabled).toBe('boolean');
    });

    it('she can switch to email only', async () => {
      await setChannels(true, true);
      const res = await patch({ whatsappEnabled: false });
      expect(res.statusCode, res.body).toBe(200);
      expect(JSON.parse(res.body).whatsappEnabled).toBe(false);
      expect(JSON.parse(res.body).emailEnabled).toBe(true);
    });

    /**
     * REFUSED BY NAME, not by a 500 from the CHECK. The request that can do this
     * sends only ONE field — she is already on email-only and turns email off —
     * which is why the guard merges the patch over the current row rather than
     * reading the body.
     */
    it('turning off the LAST channel is refused with a message, not a 500', async () => {
      await setChannels(false, true);
      const res = await patch({ emailEnabled: false });
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).error).toBe('receipt_channels_required');

      // And nothing was written.
      const [row] = await exec(
        sql`SELECT whatsapp_enabled, email_enabled FROM salon WHERE id = ${SALON}`,
      );
      expect(row?.whatsapp_enabled).toBe(false);
      expect(row?.email_enabled).toBe(true);
    });

    it('and refused when both are sent off in one request', async () => {
      await setChannels(true, true);
      const res = await patch({ whatsappEnabled: false, emailEnabled: false });
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).error).toBe('receipt_channels_required');
    });
  });

  // ==================================================================
  describe('a setting change does not touch jobs already queued', () => {
    /**
     * The channel is decided at QUEUE time, inside the money transaction, so a
     * later preference change cannot reach a row already written. That is the
     * correct answer rather than a convenient one: the receipt for a charge that
     * happened under the old setting was queued under the old setting, and the
     * alternative is mutating leased rows that `stillOurs` exists to protect.
     */
    it('an already-queued WhatsApp job survives the merchant switching it off', async () => {
      await setChannels(true, true);
      const { channels } = await chargeAndReadJobs(VERIFIED);
      expect(channels).toContain('whatsapp');

      const before = await exec(sql`
        SELECT count(*) AS n FROM receipt_job r
          JOIN "transaction" t ON t.id = r.transaction_id
         WHERE t.member_id = ${VERIFIED} AND r.channel = 'whatsapp'`);

      await setChannels(false, true);

      const after = await exec(sql`
        SELECT count(*) AS n FROM receipt_job r
          JOIN "transaction" t ON t.id = r.transaction_id
         WHERE t.member_id = ${VERIFIED} AND r.channel = 'whatsapp'`);
      expect(Number(after[0]?.n)).toBe(Number(before[0]?.n));
    });
  });

  // ==================================================================
  describe('what this slice does NOT deliver', () => {
    /**
     * Asserted so a green run cannot be read as "invoices by WhatsApp shipped".
     * `RECEIPT_DRIVER` accepts one value and sends nothing; this slice makes the
     * CHOICE real and honoured.
     */
    it('nothing sends — the driver is still logging-only', async () => {
      const env = (await import('../env')).env;
      expect(env.receiptDriver).toBe('logging');
    });
  });
});
