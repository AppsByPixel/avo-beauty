/**
 * THE CUSTOMER BELL, DRIVEN. Client ask 4. `services/memberNotifications.ts`
 * carries the decisions; each block below pins one of them by request, against
 * the real router and the real money path where the fact is a money fact.
 *
 * The receipt stream is fed by REAL top-ups — `POST /topups` + `GET /topups/{id}`
 * through the sandbox gateway — so the item under test is the one `creditWallet`
 * queued, not a row this file invented. The campaign stream is written directly,
 * because `deliverCampaign` resolves the WHOLE salon's audience and every
 * `campaign_send` row is permanent (0028 revokes DELETE): a real release from this
 * file would put a message in every seeded customer's weekly cap on every run.
 * What the campaign specs pin is the READ's filter, which is where #8 lives for
 * this endpoint.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

const INT_URL = process.env.AVO_INT_DATABASE_URL;
const suite = INT_URL ? describe : describe.skip;

const SALON = 'SAL-AMARA';
const OTHER_SALON = 'SAL-LUMIERE';
const BRANCH = 'BR-SAL';

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
const id = (tag: string) => `MB-${tag}-${RUN}`;

const AMINA = id('M-AMINA'); // tops up, consents to offers, receives campaigns
const BASMA = id('M-BASMA'); // the other customer: same salon, her own bell
const DANA = id('M-DANA'); // is erased

const CMP_SENT = id('CMP-SENT'); // sent, push, Amina is a recipient
const CMP_WA = id('CMP-WA'); // sent, WhatsApp only
const CMP_HELD = id('CMP-HELD'); // approved and HELD — a send row that must not exist
const CMP_PENDING = id('CMP-PEND'); // pending, no send
const CMP_LUMIERE = id('CMP-LUM'); // another salon's campaign

interface Item {
  id: string;
  kind: string;
  createdAt: string;
  readAt: string | null;
  [k: string]: unknown;
}
interface Feed {
  items: Item[];
  nextCursor: string | null;
  unreadCount: number;
  visibleKinds: string[];
}

suite('the customer notification bell', () => {
  let app: FastifyInstance;
  let db: (typeof import('../db/client'))['db'];
  let sql: (typeof import('drizzle-orm'))['sql'];
  let issueSession: (typeof import('../auth/sessions'))['issueSession'];
  let bell: typeof import('../services/memberNotifications');
  const token: Record<string, string> = {};

  const exec = async (q: unknown) =>
    (await db.execute(q as never)) as unknown as Array<Record<string, unknown>>;

  async function member(mid: string, salonId = SALON): Promise<void> {
    await exec(sql`
      INSERT INTO member (id, salon_id, name, phone, password_hash, balance_fils, tier, visits, policy_version)
      VALUES (${mid}, ${salonId}, ${`MB Int ${mid}`},
              ${`+9656${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}`},
              '$argon2id$fake-not-a-credential', 0, 'bronze', 0, 3)`);
  }

  async function wallet(mid: string, salonId = SALON): Promise<string> {
    const s = await issueSession(db, {
      principalKind: 'member',
      memberId: mid,
      salonId,
      scope: 'wallet',
    });
    return s.accessToken;
  }

  const feed = async (who: string, qs = '') => {
    const res = await app.inject({
      method: 'GET',
      url: `/members/me/notifications/feed${qs}`,
      headers: { authorization: `Bearer ${token[who]}` },
    });
    return { status: res.statusCode, body: JSON.parse(res.body) as Feed };
  };

  const mark = async (who: string, payload: unknown) => {
    const res = await app.inject({
      method: 'POST',
      url: '/members/me/notifications/read',
      headers: { authorization: `Bearer ${token[who]}` },
      payload: payload as Record<string, unknown>,
    });
    return { status: res.statusCode, body: JSON.parse(res.body) };
  };

  /** A REAL top-up, settled by the sandbox. Returns the settled transaction id. */
  async function topUp(who: string, amountFils: number): Promise<string> {
    const start = await app.inject({
      method: 'POST',
      url: '/topups',
      headers: { authorization: `Bearer ${token[who]}`, 'idempotency-key': `mb-${randomUUID()}` },
      payload: { amountFils, method: 'knet' },
    });
    expect(start.statusCode, start.body).toBe(200);
    const intentId = JSON.parse(start.body).id as string;
    const read = await app.inject({
      method: 'GET',
      url: `/topups/${intentId}`,
      headers: { authorization: `Bearer ${token[who]}` },
    });
    expect(JSON.parse(read.body).status, read.body).toBe('succeeded');
    const [row] = await exec(sql`SELECT transaction_id FROM topup_intent WHERE id = ${intentId}`);
    return String(row?.transaction_id);
  }

  async function campaignRow(
    cid: string,
    opts: { salonId?: string; status: string; channel?: string; held?: boolean },
  ): Promise<void> {
    const decided = opts.status !== 'pending';
    /**
     * DECIDED IN 2020, deliberately. `deliverCampaign`'s monthly cap counts a salon's
     * approved + sent campaigns by `decided_at` in the current month, and these rows
     * are permanent — decided "now", every run of this file would spend the seeded
     * salon's platform allowance and hold the next real release in
     * `campaignAudience.int.test.ts`. Measured: 84 fixture campaigns after a mutation
     * sweep, and five reds there that were this file's. The bell reads `sent_at` off
     * `campaign_send`, not `decided_at`, so nothing below depends on the date.
     */
    await exec(sql`
      INSERT INTO campaign (id, salon_id, title, body, channel, audience, status, submitted_by,
                            submitted_at, decided_by, decided_at, result, held_reason, held_at)
      VALUES (${cid}, ${opts.salonId ?? SALON}, ${`Offer ${cid}`}, ${`Body of ${cid} — كلمات التاجرة`},
              ${opts.channel ?? 'push'}, 'all', ${opts.status}, 'MB int', '2020-01-01T00:00:00Z',
              ${decided ? 'MB int reviewer' : null}, ${decided ? '2020-01-01T00:00:00Z' : null},
              ${opts.status === 'sent' ? '1 reached' : null},
              ${opts.held ? 'Quiet hours. Held.' : null}, ${opts.held ? sql`now()` : null})`);
  }

  const send = (cid: string, mid: string, channel = 'push') =>
    exec(sql`INSERT INTO campaign_send (campaign_id, member_id, channel) VALUES (${cid}, ${mid}, ${channel})`);

  const consent = (mid: string, granted: boolean) =>
    exec(sql`
      INSERT INTO member_consent_event (member_id, salon_id, kind, granted, source, policy_version)
      VALUES (${mid}, ${SALON}, 'marketing_offers', ${granted}, 'wallet_account', 3)`);

  let aminaTopupA = '';
  let aminaTopupB = '';
  let basmaTopup = '';

  beforeAll(async () => {
    db = (await import('../db/client')).db;
    sql = (await import('drizzle-orm')).sql;
    issueSession = (await import('../auth/sessions')).issueSession;
    bell = await import('../services/memberNotifications');
    app = await (await import('../app')).buildApp();

    for (const m of [AMINA, BASMA, DANA]) {
      await member(m);
      token[m] = await wallet(m);
    }

    aminaTopupA = await topUp(AMINA, 5000);
    aminaTopupB = await topUp(AMINA, 10000);
    basmaTopup = await topUp(BASMA, 7000);

    await consent(AMINA, true);

    await campaignRow(CMP_SENT, { status: 'sent' });
    await send(CMP_SENT, AMINA);
    await campaignRow(CMP_WA, { status: 'sent', channel: 'wa' });
    await send(CMP_WA, AMINA, 'wa');
    await campaignRow(CMP_HELD, { status: 'approved', held: true });
    // A writer bug: a send row for a campaign that never went out. The read must not trust it.
    await send(CMP_HELD, AMINA);
    await campaignRow(CMP_PENDING, { status: 'pending' });
    await campaignRow(CMP_LUMIERE, { salonId: OTHER_SALON, status: 'sent' });
    // A cross-tenant writer bug: another salon's campaign addressed to her.
    await send(CMP_LUMIERE, AMINA);
  });

  afterAll(async () => {
    await app?.close();
  });

  // ----------------------------------------------------------- the feed --

  it('serves her real top-ups and her delivered campaign, newest first', async () => {
    const { status, body } = await feed(AMINA);
    expect(status).toBe(200);
    expect(body.items.map((i) => i.id)).toEqual([CMP_SENT, aminaTopupB, aminaTopupA]);
    expect(body.unreadCount).toBe(3);
    expect(body.visibleKinds).toEqual([
      'topup',
      'charge',
      'shop',
      'deposit_hold',
      'deposit_return',
      // Migration 0066: the salon published a new booking policy. Not marketing,
      // so visible whatever her offers consent.
      'booking_policy',
      'campaign',
    ]);
    expect(body.nextCursor).toBeNull();
  });

  it('a receipt item is STRUCTURED: integer fils, the kind, no composed text and no balance (#12, #1)', async () => {
    const { body } = await feed(AMINA);
    const item = body.items.find((i) => i.id === aminaTopupB)!;
    expect(item).toMatchObject({
      kind: 'topup',
      transactionId: aminaTopupB,
      amountFils: 10000,
      method: 'knet',
      readAt: null,
    });
    expect(Number.isSafeInteger(item.amountFils)).toBe(true);
    expect(Number.isSafeInteger(item.creditFils)).toBe(true);
    expect(item.creditFils as number).toBeGreaterThanOrEqual(10000);
    /**
     * #12: no server-composed sentence in either language — the wallet renders it
     * from its copy module. And whatsapp-templates.md's "never a balance in a message
     * that could be read over someone's shoulder".
     */
    expect(item).not.toHaveProperty('title');
    expect(item).not.toHaveProperty('body');
    expect(item).not.toHaveProperty('balanceAfterFils');
    expect(JSON.stringify(item)).not.toMatch(/KD|د\.ك/);
  });

  it("a campaign carries the merchant's own words verbatim, whatever language she wrote in", async () => {
    const { body } = await feed(AMINA);
    const item = body.items.find((i) => i.id === CMP_SENT)!;
    expect(item).toMatchObject({
      kind: 'campaign',
      campaignId: CMP_SENT,
      title: `Offer ${CMP_SENT}`,
      body: `Body of ${CMP_SENT} — كلمات التاجرة`,
    });
  });

  // ------------------------------------------------------------ tenancy --

  it('TENANCY: scoped by the credential — Basma sees only her own, and a memberId in the URL is ignored', async () => {
    const own = await feed(BASMA);
    expect(own.body.items.map((i) => i.id)).toEqual([basmaTopup]);

    const probe = await feed(BASMA, `?memberId=${encodeURIComponent(AMINA)}`);
    expect(probe.body.items.map((i) => i.id)).toEqual([basmaTopup]);
  });

  it("TENANCY: Basma cannot mark Amina's items read, and the refusal is not an oracle", async () => {
    const res = await mark(BASMA, { ids: [aminaTopupA, CMP_SENT] });
    expect(res.status).toBe(200);
    expect(res.body.marked).toBe(0);

    const amina = await feed(AMINA);
    expect(amina.body.unreadCount).toBe(3);
    const [n] = await exec(
      sql`SELECT count(*)::int AS n FROM member_notification_read WHERE member_id = ${BASMA}`,
    );
    expect(n?.n).toBe(0);
  });

  // ------------------------------------------------- #8: delivered only --

  it('#8: only a DELIVERED campaign, of HER salon, on the APP channel — held, pending, WhatsApp and cross-salon never appear', async () => {
    const { body } = await feed(AMINA);
    const ids = body.items.map((i) => i.id);
    expect(ids).toContain(CMP_SENT);
    for (const hidden of [CMP_WA, CMP_HELD, CMP_PENDING, CMP_LUMIERE]) {
      expect(ids, hidden).not.toContain(hidden);
    }
    // And not counted either — the badge and the panel agree.
    expect(body.unreadCount).toBe(3);
  });

  it('#8: a campaign she was not sent is not in her bell, though it went to the same salon', async () => {
    const { body } = await feed(BASMA);
    expect(body.items.map((i) => i.kind)).not.toContain('campaign');
  });

  it('offers consent withdrawn: campaigns leave the bell and visibleKinds says so; restored, they return', async () => {
    await consent(AMINA, false);
    const off = await feed(AMINA);
    expect(off.body.items.map((i) => i.id)).toEqual([aminaTopupB, aminaTopupA]);
    expect(off.body.visibleKinds).not.toContain('campaign');
    expect(off.body.unreadCount).toBe(2);

    await consent(AMINA, true);
    const on = await feed(AMINA);
    expect(on.body.items.map((i) => i.id)).toEqual([CMP_SENT, aminaTopupB, aminaTopupA]);
    expect(on.body.visibleKinds).toContain('campaign');
  });

  // ------------------------------------------------------------- paging --

  it('PAGES across both streams: twenty, then the rest, no repeats, no gaps, one badge', async () => {
    const who = id('M-PAGER');
    await member(who);
    token[who] = await wallet(who);
    await consent(who, true);
    const txs: string[] = [];
    for (let i = 0; i < 12; i++) txs.push(await topUp(who, 1000 + i));
    const cmp = id('CMP-PAGER');
    await campaignRow(cmp, { status: 'sent' });
    await send(cmp, who);
    for (let i = 0; i < 11; i++) txs.push(await topUp(who, 2000 + i));

    const first = await feed(who);
    expect(first.body.items).toHaveLength(bell.MEMBER_NOTIFICATION_PAGE_SIZE);
    expect(first.body.nextCursor).not.toBeNull();
    const second = await feed(who, `?cursor=${encodeURIComponent(first.body.nextCursor!)}`);
    expect(second.body.nextCursor).toBeNull();

    const all = [...first.body.items, ...second.body.items].map((i) => i.id);
    expect(new Set(all).size).toBe(all.length);
    expect(all.sort()).toEqual([...txs, cmp].sort());
    // Newest first across the merge: the campaign sits between the two batches.
    const firstIds = first.body.items.map((i) => i.id);
    expect(firstIds.indexOf(cmp)).toBe(11);
    // The badge is not the page.
    expect(first.body.unreadCount).toBe(24);
    expect(second.body.unreadCount).toBe(24);

    const bad = await feed(who, '?cursor=not-a-cursor');
    expect(bad.status).toBe(400);
  });

  // --------------------------------------------------- one item per send --

  it('a receipt queued on TWO channels is ONE item — she was told once', async () => {
    await exec(sql`
      INSERT INTO receipt_job (transaction_id, member_id, channel, payload)
      SELECT transaction_id, member_id, 'email', payload FROM receipt_job
       WHERE transaction_id = ${basmaTopup} AND channel = 'whatsapp'`);
    const [n] = await exec(
      sql`SELECT count(*)::int AS n FROM receipt_job WHERE transaction_id = ${basmaTopup}`,
    );
    expect(n?.n).toBe(2);

    const { body } = await feed(BASMA);
    expect(body.items.map((i) => i.id)).toEqual([basmaTopup]);
    expect(body.unreadCount).toBe(1);
  });

  // -------------------------------------------------------- chrome holds --

  it('a malformed payload is dropped, not a 500; an unknown kind is neither served nor counted', async () => {
    const who = id('M-CHROME');
    await member(who);
    token[who] = await wallet(who);
    const txId = await topUp(who, 3000);
    await exec(sql`
      UPDATE receipt_job SET payload = jsonb_build_object('kind', 'topup', 'amountFils', 'lots')
       WHERE transaction_id = ${txId}`);
    const broken = await feed(who);
    expect(broken.status).toBe(200);
    expect(broken.body.items).toEqual([]);

    await exec(sql`
      UPDATE receipt_job SET payload = jsonb_build_object('kind', 'mystery', 'amountFils', 3000)
       WHERE transaction_id = ${txId}`);
    const unknown = await feed(who);
    expect(unknown.body.items).toEqual([]);
    expect(unknown.body.unreadCount).toBe(0);
  });

  // ---------------------------------------------------------- mark read --

  it('mark read by id: one flips, the badge drops, and the FIRST read_at survives a second call', async () => {
    const first = await mark(AMINA, { ids: [aminaTopupA] });
    expect(first.body).toEqual({ marked: 1, unreadCount: 2 });

    const before = (await feed(AMINA)).body.items.find((i) => i.id === aminaTopupA)!;
    expect(before.readAt).not.toBeNull();
    const others = (await feed(AMINA)).body.items.filter((i) => i.id !== aminaTopupA);
    expect(others.every((i) => i.readAt === null)).toBe(true);

    const again = await mark(AMINA, { ids: [aminaTopupA] });
    expect(again.body).toEqual({ marked: 0, unreadCount: 2 });
    const after = (await feed(AMINA)).body.items.find((i) => i.id === aminaTopupA)!;
    expect(after.readAt).toBe(before.readAt);
  });

  it('mark all: everything visible, and nothing she cannot see', async () => {
    const res = await mark(AMINA, { all: true });
    expect(res.body).toEqual({ marked: 2, unreadCount: 0 });
    const rows = await exec(sql`
      SELECT coalesce(transaction_id, campaign_id) AS id FROM member_notification_read
       WHERE member_id = ${AMINA} ORDER BY 1`);
    // The held, WhatsApp and cross-salon campaigns have send rows for her and were NOT marked.
    expect(rows.map((r) => r.id).sort()).toEqual([CMP_SENT, aminaTopupA, aminaTopupB].sort());
  });

  it('the selection is exactly one of ids / all, and ids are bounded', async () => {
    for (const bad of [{}, { all: true, ids: [aminaTopupA] }, { ids: [] }, { ids: [1] }, { all: 'yes' }]) {
      const res = await mark(AMINA, bad);
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    const many = Array.from({ length: bell.MEMBER_MARK_READ_MAX_IDS + 1 }, (_, i) => `TX-${i}`);
    expect((await mark(AMINA, { ids: many })).status).toBe(400);
  });

  it('a staff token is refused — this bell is a customer door', async () => {
    const staff = await issueSession(db, {
      principalKind: 'staff',
      staffId: 'ST-001',
      salonId: SALON,
      scope: 'dashboard',
    });
    const res = await app.inject({
      method: 'GET',
      url: '/members/me/notifications/feed',
      headers: { authorization: `Bearer ${staff.accessToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  // ------------------------------------------------------------ erasure --

  it('ERASED: no feed, no marks, and her stale token is dead — even though campaign_send cannot be deleted', async () => {
    await consent(DANA, true);
    await campaignRow(id('CMP-DANA'), { status: 'sent' });
    await send(id('CMP-DANA'), DANA);
    /**
     * A receipt of her own, on a zero-sum pair so erasure's balance precondition
     * holds: she is erased only at a zero balance, so a top-up here would defer it.
     */
    const [tx] = await exec(sql`SELECT id FROM "transaction" WHERE id = ${aminaTopupA}`);
    await exec(sql`
      INSERT INTO receipt_job (transaction_id, member_id, channel, payload)
      VALUES (${String(tx?.id)}, ${DANA}, 'email',
              ${JSON.stringify({
                kind: 'topup',
                transactionId: 'X',
                intentId: 'X',
                amountFils: 1000,
                bonusFils: 0,
                creditFils: 1000,
                method: 'knet',
                reference: 'X',
                balanceAfterFils: 1000,
              })}::jsonb)`);

    const live = await feed(DANA);
    expect(live.body.items.map((i) => i.kind).sort()).toEqual(['campaign', 'topup']);
    expect((await mark(DANA, { all: true })).body.marked).toBe(2);

    await exec(sql`
      UPDATE member SET deletion_requested_at = now() - interval '31 days',
                        deletion_due_at = now() - interval '1 day'
       WHERE id = ${DANA}`);
    const { runErasureOnce } = await import('../services/erasure');
    await runErasureOnce(db, 500);
    const [m] = await exec(sql`SELECT erased_at FROM member WHERE id = ${DANA}`);
    expect(m?.erased_at).not.toBeNull();

    const [marks] = await exec(
      sql`SELECT count(*)::int AS n FROM member_notification_read WHERE member_id = ${DANA}`,
    );
    expect(marks?.n).toBe(0);
    const [sends] = await exec(
      sql`SELECT count(*)::int AS n FROM campaign_send WHERE member_id = ${DANA}`,
    );
    expect(sends?.n, 'campaign_send survives erasure by design (0028)').toBe(1);

    const stale = await app.inject({
      method: 'GET',
      url: '/members/me/notifications/feed',
      headers: { authorization: `Bearer ${token[DANA]}` },
    });
    expect(stale.statusCode).toBe(401);

    // The layer that holds if a session ever outlived her: the service itself.
    const direct = await bell.readMemberFeed(db, DANA, null);
    expect(direct).toEqual({ items: [], nextCursor: null, unreadCount: 0, visibleKinds: [] });
  });
});
