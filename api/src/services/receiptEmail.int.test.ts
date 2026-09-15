/**
 * The email driver, the real worker and a real database — with only the HTTP hop
 * stubbed.
 *
 * ======================================================================
 * WHY THIS EXISTS BESIDE receiptWorker.int.test.ts RATHER THAN INSIDE IT
 * ======================================================================
 * That suite proves the worker re-asserts its claim, and it does so against a
 * driver that is a pair of closures. This one proves the opposite half: that the
 * REAL `EmailReceiptSender` — its channel refusal, its send-time address check,
 * its sending identity — produces the queue states and the audit row the worker
 * promises. The two mocks are incompatible by construction (each replaces
 * `receiptSender` for its whole file), so they are two files.
 *
 * WHAT IS STUBBED IS EXACTLY ONE THING: `EmailTransport.send`. Everything from
 * `runOnce` down to `receipt_job` is real, the payload is one a real settle
 * queued, and the audit row is read back out of `audit_log`.
 *
 * ======================================================================
 * THE CLAIM UNDER TEST IS "THE FAILURE PATH", AND IT HAS THREE SHAPES
 * ======================================================================
 *   transient   the row comes back. `failed`, attempts incremented, `last_error`
 *               recorded, `available_at` inside the backoff window, and NO audit
 *               row — nobody has been let down yet.
 *
 *   permanent   the row stops. `failed`, parked a century out, and an audit row
 *               of kind `risk` — because the customer paid and will not be told,
 *               which is the one receipt outcome a salon may be asked about at a
 *               counter.
 *
 *   not ours    a `whatsapp` row under an email-only driver is given BACK:
 *               `queued`, attempt decremented, no error, no audit. This is the
 *               branch `processJob` has carried since it was written and that no
 *               configuration has ever executed, because the logging driver
 *               handles everything.
 *
 * `receipts/types.ts` states the cost of confusing the first two: a worker that
 * cannot tell them apart "eventually treats every failure as transient, which is
 * the same as having no retry policy". Here that is measurable — the assertions
 * below are on `available_at`, which is the only thing that differs.
 */

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EmailMessage } from '../receipts/email/transport';

const INT_URL = process.env.AVO_INT_DATABASE_URL;
const suite = INT_URL ? describe : describe.skip;

const SALON = 'SAL-AMARA';

/**
 * The postman, under this spec's control. `vi.hoisted` for the reason
 * `receiptWorker.int.test.ts` gives: `vi.mock`'s factory is lifted above the
 * imports, so a plain `const` would be in its temporal dead zone.
 */
const postman = vi.hoisted(() => ({
  sent: [] as Array<{ from: string; to: string; subject: string; text: string }>,
  send: async (_message: unknown): Promise<{ providerReference: string }> => ({
    providerReference: 'int-email-ref',
  }),
}));

/**
 * THE REAL DRIVER, not a stand-in for it. `EmailReceiptSender` is constructed
 * directly rather than through `buildEmailReceiptSender()` so that this suite
 * needs no credential in its environment — there is no API key in this tree and
 * there is not going to be one.
 */
vi.mock('../receipts', async () => {
  const actual = await vi.importActual<typeof import('../receipts')>('../receipts');
  const email = await vi.importActual<typeof import('../receipts/email')>('../receipts/email');
  return {
    ...actual,
    receiptSender: new email.EmailReceiptSender({
      fromAddress: 'receipts@avo.beauty',
      transport: {
        name: 'int-stub',
        send: async (message: EmailMessage) => {
          const result = await postman.send(message);
          postman.sent.push({
            from: `${message.from.name} <${message.from.address}>`,
            to: message.to.address,
            subject: message.subject,
            text: message.text,
          });
          return result;
        },
      },
    }),
  };
});

suite('the email receipt driver, end to end', () => {
  let app: FastifyInstance;

  let db: typeof import('../db/client')['db'];
  let member: typeof import('../db/schema/member')['member'];
  let receiptJob: typeof import('../db/schema/receipt')['receiptJob'];
  let auditLog: typeof import('../db/schema/audit')['auditLog'];
  let worker: typeof import('./receiptWorker');
  let orm: typeof import('drizzle-orm');
  let issueSession: typeof import('../auth/sessions')['issueSession'];
  let hashSecret: typeof import('../auth/password')['hashSecret'];
  let receiptErrors: typeof import('../receipts');

  beforeAll(async () => {
    db = (await import('../db/client')).db;
    member = (await import('../db/schema/member')).member;
    receiptJob = (await import('../db/schema/receipt')).receiptJob;
    auditLog = (await import('../db/schema/audit')).auditLog;
    worker = await import('./receiptWorker');
    orm = await import('drizzle-orm');
    issueSession = (await import('../auth/sessions')).issueSession;
    hashSecret = (await import('../auth/password')).hashSecret;
    receiptErrors = await vi.importActual<typeof import('../receipts')>('../receipts');

    app = await (await import('../app')).buildApp();
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    postman.sent.length = 0;
    postman.send = async () => ({ providerReference: 'int-email-ref' });
  });

  // ------------------------------------------------------------- fixtures --

  function freePhone(): string {
    return `+9656${Math.floor(Math.random() * 10_000_000)
      .toString()
      .padStart(7, '0')}`;
  }

  /**
   * A real settle, by a member with a VERIFIED address.
   *
   * `SAL-AMARA` has both channels on (`whatsapp_enabled` and `email_enabled`),
   * so `decideReceiptChannels` queues TWO rows for one transaction — which is
   * what makes the give-back spec below possible without forging anything.
   */
  async function settledWithEmail(): Promise<{
    memberId: string;
    emailJobId: string;
    whatsappJobId: string;
    txId: string;
    address: string;
  }> {
    const id = `INT-EM-${randomUUID().slice(0, 8)}`;
    const address = `${id.toLowerCase()}@example.test`;
    await db.insert(member).values({
      id,
      salonId: SALON,
      name: 'Int Email Member',
      phone: freePhone(),
      email: address,
      emailVerified: true,
      passwordHash: await hashSecret(`pw-${randomUUID()}`),
      policyVersion: 1,
    });

    const s = await issueSession(db, {
      principalKind: 'member',
      memberId: id,
      salonId: SALON,
      scope: 'wallet',
    });

    const created = await app.inject({
      method: 'POST',
      url: '/topups',
      headers: {
        authorization: `Bearer ${s.accessToken}`,
        'idempotency-key': `int-email-${randomUUID()}`,
      },
      payload: { amountFils: 1000, method: 'knet' },
    });
    expect(created.statusCode, created.body).toBe(200);
    const intentId = JSON.parse(created.body).id as string;

    const settled = await app.inject({
      method: 'GET',
      url: `/topups/${intentId}`,
      headers: { authorization: `Bearer ${s.accessToken}` },
    });
    expect(settled.statusCode, settled.body).toBe(200);
    expect(JSON.parse(settled.body).status, settled.body).toBe('succeeded');

    const rows = await db
      .select({ id: receiptJob.id, channel: receiptJob.channel, transactionId: receiptJob.transactionId })
      .from(receiptJob)
      .where(orm.eq(receiptJob.memberId, id));

    const emailRow = rows.find((r) => r.channel === 'email');
    const whatsappRow = rows.find((r) => r.channel === 'whatsapp');
    /**
     * Asserted rather than assumed. If a merchant preference or the floor ever
     * changes what a verified member queues, this suite should say so here
     * instead of failing later with something that looks like a worker bug.
     */
    if (!emailRow || !whatsappRow) {
      throw new Error(
        `expected one email and one whatsapp row for ${id}, got ${JSON.stringify(rows)}`,
      );
    }
    return {
      memberId: id,
      emailJobId: emailRow.id,
      whatsappJobId: whatsappRow.id,
      txId: emailRow.transactionId,
      address,
    };
  }

  /** `receiptWorker.int.test.ts § soleClaimable`, verbatim in effect. */
  async function soleClaimable(ids: string[]): Promise<void> {
    const array = `ARRAY[${ids.map((i) => `'${i}'::uuid`).join(',')}]`;
    await db.execute(orm.sql`
      UPDATE receipt_job SET available_at = now() + interval '1 hour'
       WHERE status IN ('queued', 'failed', 'sending')
         AND id <> ALL (${orm.sql.raw(array)})
    `);
    await db.execute(orm.sql`
      UPDATE receipt_job SET available_at = now() - interval '1 second'
       WHERE id = ANY (${orm.sql.raw(array)})
    `);
  }

  async function jobRow(id: string) {
    const [row] = await db.select().from(receiptJob).where(orm.eq(receiptJob.id, id)).limit(1);
    if (!row) throw new Error(`no receipt_job ${id}`);
    return row;
  }

  /** The `risk` rows this job wrote, if any. Keyed on the subject, never on time. */
  async function auditFor(jobId: string) {
    return db
      .select({
        kind: auditLog.kind,
        action: auditLog.action,
        detail: auditLog.detail,
        source: auditLog.source,
        salonId: auditLog.salonId,
      })
      .from(auditLog)
      .where(
        orm.and(orm.eq(auditLog.subjectType, 'receipt_job'), orm.eq(auditLog.subjectId, jobId)),
      );
  }

  // ----------------------------------------------------------------- send --

  it('sends the email row, and the message is addressed by the salon to the verified mailbox', async () => {
    const { emailJobId, address, txId } = await settledWithEmail();
    await soleClaimable([emailJobId]);

    const result = await worker.runOnce(db, 1);
    expect(result).toMatchObject({ claimed: 1, sent: 1, retry: 0, gaveUp: 0, lost: 0 });

    expect(postman.sent).toHaveLength(1);
    const message = postman.sent[0];
    expect(message?.from).toBe('Amara <receipts@avo.beauty>');
    expect(message?.to).toBe(address);
    expect(message?.subject).toBe('Your receipt from Amara');
    /** The frozen payload's money, and this transaction's own reference. */
    expect(message?.text).toContain('Added to your wallet: 1.000 KD');
    expect(message?.text).toContain(txId);

    const row = await jobRow(emailJobId);
    expect(row.status).toBe('sent');
    expect(row.sentAt).not.toBeNull();
    expect(row.lastError).toBeNull();
    expect(await auditFor(emailJobId)).toHaveLength(0);
  });

  // ------------------------------------------------------------- transient --

  it('a transient failure comes back: failed, one attempt spent, inside the backoff window, no audit', async () => {
    const { emailJobId } = await settledWithEmail();
    await soleClaimable([emailJobId]);

    postman.send = async () => {
      throw new receiptErrors.ReceiptTransientError('the provider timed out');
    };

    const result = await worker.runOnce(db, 1);
    expect(result).toMatchObject({ claimed: 1, sent: 0, retry: 1, gaveUp: 0, lost: 0 });

    const row = await jobRow(emailJobId);
    expect(row.status).toBe('failed');
    expect(row.attempts).toBe(1);
    expect(row.sentAt).toBeNull();
    expect(row.lastError).toContain('the provider timed out');
    /** NOT the `permanent: ` prefix — that is the only thing in `last_error` that distinguishes them. */
    expect(row.lastError).not.toContain('permanent:');

    /**
     * THE ASSERTION THAT ACTUALLY SEPARATES TRANSIENT FROM PERMANENT is this
     * one. `RECEIPT_BACKOFF_MAX_MS` is fifteen minutes and `PARK_MS` is a
     * century, so a row due inside the hour came back and a row due next century
     * did not.
     */
    const dueInMs = row.availableAt.getTime() - Date.now();
    expect(dueInMs).toBeGreaterThan(0);
    expect(dueInMs).toBeLessThan(60 * 60_000);

    expect(await auditFor(emailJobId)).toHaveLength(0);
  });

  it('and the row is claimable again once its backoff has elapsed', async () => {
    const { emailJobId } = await settledWithEmail();
    await soleClaimable([emailJobId]);

    postman.send = async () => {
      throw new receiptErrors.ReceiptTransientError('still down');
    };
    expect(await worker.runOnce(db, 1)).toMatchObject({ retry: 1 });

    /** Wind the backoff out rather than sleeping through it. */
    await soleClaimable([emailJobId]);
    postman.send = async () => ({ providerReference: 'recovered' });

    expect(await worker.runOnce(db, 1)).toMatchObject({ claimed: 1, sent: 1 });
    const row = await jobRow(emailJobId);
    expect(row.status).toBe('sent');
    expect(row.attempts).toBe(2);
    /** The recovery clears the error rather than leaving a sent row that reads as broken. */
    expect(row.lastError).toBeNull();
  });

  // ------------------------------------------------------------- permanent --

  it('a permanent failure stops: parked a century out, and a risk audit naming the transaction', async () => {
    const { emailJobId, txId } = await settledWithEmail();
    await soleClaimable([emailJobId]);

    postman.send = async () => {
      throw new receiptErrors.ReceiptPermanentError('the sending domain is not verified');
    };

    const result = await worker.runOnce(db, 1);
    expect(result).toMatchObject({ claimed: 1, sent: 0, retry: 0, gaveUp: 1, lost: 0 });

    const row = await jobRow(emailJobId);
    expect(row.status).toBe('failed');
    expect(row.attempts).toBe(1);
    expect(row.sentAt).toBeNull();
    expect(row.lastError).toContain('permanent: the sending domain is not verified');
    /** Past the claim horizon, which is what "gave up" means in a table with no `dead` status. */
    expect(row.availableAt.getTime() - Date.now()).toBeGreaterThan(50 * 365 * 24 * 60 * 60_000);

    /**
     * THE CUSTOMER PAID AND WILL NOT BE TOLD. That is the row a salon reads when
     * she says she never got a receipt, so it is checked field by field rather
     * than counted.
     */
    const audit = await auditFor(emailJobId);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      kind: 'risk',
      action: 'Receipt could not be sent',
      source: 'system',
      salonId: SALON,
    });
    expect(audit[0]?.detail).toContain(txId);
    expect(audit[0]?.detail).toContain('email');

    /** And it is not claimed again on the next pass. */
    expect(await worker.runOnce(db, 1)).toMatchObject({ claimed: 0 });
  });

  // ----------------------------------------------- the send-time address --

  it('an address erased between the charge and the send is PERMANENT, with the audit', async () => {
    const { emailJobId, memberId } = await settledWithEmail();

    /**
     * What `services/erasure.ts:437` does when a deletion falls due: the address
     * goes, the verification goes, the money rows stay. This is the ordering the
     * addressing is resolved at SEND time for — a frozen address would have been
     * posted to a provider here.
     */
    await db
      .update(member)
      .set({ email: null, emailVerified: false })
      .where(orm.eq(member.id, memberId));

    await soleClaimable([emailJobId]);
    const result = await worker.runOnce(db, 1);
    expect(result).toMatchObject({ claimed: 1, sent: 0, gaveUp: 1 });

    /** Nothing left this process. That is the whole assertion. */
    expect(postman.sent).toHaveLength(0);

    const row = await jobRow(emailJobId);
    expect(row.lastError).toContain('permanent:');
    expect(row.lastError).toContain('no email address at send time');
    expect(await auditFor(emailJobId)).toHaveLength(1);
  });

  it('an address that lost its verification is PERMANENT too, and nothing is sent to it', async () => {
    const { emailJobId, memberId, address } = await settledWithEmail();
    await db.update(member).set({ emailVerified: false }).where(orm.eq(member.id, memberId));

    await soleClaimable([emailJobId]);
    expect(await worker.runOnce(db, 1)).toMatchObject({ claimed: 1, gaveUp: 1 });

    expect(postman.sent.map((m) => m.to)).not.toContain(address);
    expect((await jobRow(emailJobId)).lastError).toContain('not verified at send time');
  });

  // ------------------------------------------------------------ not ours --

  it('a whatsapp row is given BACK, not failed — the branch no driver had ever executed', async () => {
    const { whatsappJobId } = await settledWithEmail();
    await soleClaimable([whatsappJobId]);

    const result = await worker.runOnce(db, 1);
    /** Claimed and returned. `retry`, because nothing was attempted and nothing failed. */
    expect(result).toMatchObject({ claimed: 1, sent: 0, retry: 1, gaveUp: 0, lost: 0 });

    expect(postman.sent).toHaveLength(0);

    const row = await jobRow(whatsappJobId);
    expect(row.status).toBe('queued');
    /**
     * THE CLAIM'S INCREMENT IS GIVEN BACK. Without this a WhatsApp row under an
     * email-only deployment would exhaust `RECEIPT_MAX_ATTEMPTS` in about a
     * minute and park itself — a receipt abandoned because the wrong driver
     * looked at it, with a `risk` audit row blaming nothing.
     */
    expect(row.attempts).toBe(0);
    expect(row.lastError).toBeNull();
    expect(row.sentAt).toBeNull();
    expect(await auditFor(whatsappJobId)).toHaveLength(0);
  });

  it('so one transaction under an email-only driver sends one receipt and holds the other', async () => {
    const { emailJobId, whatsappJobId } = await settledWithEmail();
    await soleClaimable([emailJobId, whatsappJobId]);

    /**
     * Batch of two, and this spec is INDIFFERENT to the order they are processed
     * in — `receiptWorker.int.test.ts § soleClaimable` measured that `RETURNING`
     * does not follow the claim's `ORDER BY`. Every assertion below is keyed on
     * the row's identity.
     */
    const result = await worker.runOnce(db, 2);
    expect(result).toMatchObject({ claimed: 2, sent: 1, retry: 1, gaveUp: 0, lost: 0 });

    expect(await jobRow(emailJobId)).toMatchObject({ status: 'sent' });
    expect(await jobRow(whatsappJobId)).toMatchObject({ status: 'queued', attempts: 0 });
    expect(postman.sent).toHaveLength(1);
  });
});
