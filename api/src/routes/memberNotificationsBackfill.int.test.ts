/**
 * THE BELL OPENS ON HER HISTORY, READ — migration 0059, driven.
 *
 * Every spec here runs THE MIGRATION FILE ITSELF: `backfill()` reads
 * `drizzle/0059_*.sql` off disk and executes its statements in one transaction,
 * as drizzle's migrator does. A copy of the SQL in this file would be a second
 * definition that can drift from the one the demo database runs.
 *
 * The lane database has already applied 0059 at migrate time, so every row this
 * file creates in `beforeAll` is "history" only once `backfill()` runs here — which
 * is exactly the live situation: rows exist, then the statement runs over them.
 *
 * THE SPEC THAT MATTERS MOST is "inserted AFTER the backfill, backdated to 2020,
 * still UNREAD". It is what separates snapshotting rows from comparing timestamps,
 * and the bell's own fixtures are backdated to 2020 (campaignRow in
 * memberNotifications.int.test.ts) for a reason unrelated to the bell.
 */

import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

const INT_URL = process.env.AVO_INT_DATABASE_URL;
const suite = INT_URL ? describe : describe.skip;

const SALON = 'SAL-AMARA';
const OTHER_SALON = 'SAL-LUMIERE';

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
const id = (tag: string) => `BF-${tag}-${RUN}`;

const HISTORY = id('M-HIST'); // a full history across every filter the feed applies
const NO_OFFERS = id('M-NOOFF'); // offers consent OFF at launch, turned back on after
const LATE = id('M-LATE'); // gets a backdated receipt and campaign AFTER launch
const FRESH = id('M-FRESH'); // gets an ordinary receipt after launch
const ERASED = id('M-ERASED'); // erased before launch; campaign_send survives erasure
const RACED = id('M-RACED'); // erased WHILE the backfill runs

const MIGRATION = (() => {
  const dir = new URL('../../drizzle/', import.meta.url);
  const file = readdirSync(dir).find((f) => f.startsWith('0059_'));
  if (!file) throw new Error('no 0059 migration in api/drizzle');
  return readFileSync(new URL(file, dir), 'utf8');
})();

interface Item {
  id: string;
  kind: string;
  readAt: string | null;
}
interface Feed {
  items: Item[];
  unreadCount: number;
  visibleKinds: string[];
}

suite('0059 — the bell opens on her history, read', () => {
  let app: FastifyInstance;
  let db: (typeof import('../db/client'))['db'];
  let sql: (typeof import('drizzle-orm'))['sql'];
  let issueSession: (typeof import('../auth/sessions'))['issueSession'];
  let bell: typeof import('../services/memberNotifications');
  const token: Record<string, string> = {};

  const exec = async (q: unknown) =>
    (await db.execute(q as never)) as unknown as Array<Record<string, unknown>>;

  /** Runs 0059 as the migrator does: every statement, one transaction. Returns rows inserted. */
  async function backfill(): Promise<number> {
    const statements = MIGRATION.split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter((s) => s.replace(/--.*$/gm, '').trim().length > 0);
    let inserted = 0;
    await db.transaction(async (tx) => {
      for (const s of statements) {
        const res = (await tx.execute(sql.raw(s))) as unknown as { count?: number };
        if (/INSERT INTO member_notification_read/.test(s)) inserted = Number(res.count ?? 0);
      }
    });
    return inserted;
  }

  async function member(mid: string, salonId = SALON): Promise<void> {
    await exec(sql`
      INSERT INTO member (id, salon_id, name, phone, password_hash, balance_fils, tier, visits, policy_version)
      VALUES (${mid}, ${salonId}, ${`BF Int ${mid}`},
              ${`+9656${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}`},
              '$argon2id$fake-not-a-credential', 0, 'bronze', 0, 3)`);
    const s = await issueSession(db, { principalKind: 'member', memberId: mid, salonId, scope: 'wallet' });
    token[mid] = s.accessToken;
  }

  const feed = async (who: string) => {
    const res = await app.inject({
      method: 'GET',
      url: '/members/me/notifications/feed',
      headers: { authorization: `Bearer ${token[who]}` },
    });
    expect(res.statusCode, res.body).toBe(200);
    return JSON.parse(res.body) as Feed;
  };

  /** A REAL top-up, settled by the sandbox. Returns the settled transaction id. */
  async function topUp(who: string, amountFils: number): Promise<string> {
    const start = await app.inject({
      method: 'POST',
      url: '/topups',
      headers: { authorization: `Bearer ${token[who]}`, 'idempotency-key': `bf-${randomUUID()}` },
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

  /** Decided in 2020, as memberNotifications.int.test.ts does and for its reason: the monthly cap. */
  async function campaignRow(
    cid: string,
    opts: { salonId?: string; status: string; channel?: string; held?: boolean },
  ): Promise<void> {
    const decided = opts.status !== 'pending';
    await exec(sql`
      INSERT INTO campaign (id, salon_id, title, body, channel, audience, status, submitted_by,
                            submitted_at, decided_by, decided_at, result, held_reason, held_at)
      VALUES (${cid}, ${opts.salonId ?? SALON}, ${`Offer ${cid}`}, ${`Body of ${cid}`},
              ${opts.channel ?? 'push'}, 'all', ${opts.status}, 'BF int', '2020-01-01T00:00:00Z',
              ${decided ? 'BF int reviewer' : null}, ${decided ? '2020-01-01T00:00:00Z' : null},
              ${opts.status === 'sent' ? '1 reached' : null},
              ${opts.held ? 'Quiet hours. Held.' : null}, ${opts.held ? sql`now()` : null})`);
  }

  const send = (cid: string, mid: string, channel = 'push', sentAt?: string) =>
    exec(sql`
      INSERT INTO campaign_send (campaign_id, member_id, channel, sent_at)
      VALUES (${cid}, ${mid}, ${channel}, ${sentAt ?? sql`now()`})`);

  const consent = (mid: string, granted: boolean) =>
    exec(sql`
      INSERT INTO member_consent_event (member_id, salon_id, kind, granted, source, policy_version)
      VALUES (${mid}, ${SALON}, 'marketing_offers', ${granted}, 'wallet_account', 3)`);

  const marksOf = async (mid: string) =>
    (
      await exec(sql`
        SELECT coalesce(transaction_id, campaign_id) AS id FROM member_notification_read
         WHERE member_id = ${mid} ORDER BY 1`)
    ).map((r) => String(r.id));

  const markCount = async () =>
    Number((await exec(sql`SELECT count(*)::int AS n FROM member_notification_read`))[0]?.n);

  let historyFeedIds: string[] = [];
  let noOffersCampaign = '';

  beforeAll(async () => {
    db = (await import('../db/client')).db;
    sql = (await import('drizzle-orm')).sql;
    issueSession = (await import('../auth/sessions')).issueSession;
    bell = await import('../services/memberNotifications');
    app = await (await import('../app')).buildApp();

    for (const m of [HISTORY, NO_OFFERS, LATE, FRESH, ERASED, RACED]) await member(m);

    // ---- HISTORY: one of every case the feed's predicates decide ----
    await consent(HISTORY, true);
    const txA = await topUp(HISTORY, 5000);
    const txB = await topUp(HISTORY, 6000);
    // B was told on two channels: one item, one mark.
    await exec(sql`
      INSERT INTO receipt_job (transaction_id, member_id, channel, payload)
      SELECT transaction_id, member_id, 'email', payload FROM receipt_job
       WHERE transaction_id = ${txB} AND channel = 'whatsapp'`);
    // A receipt of a kind the bell does not know: neither served, nor counted, nor marked.
    const txC = await topUp(HISTORY, 7000);
    await exec(sql`
      UPDATE receipt_job SET payload = jsonb_set(payload, '{kind}', '"mystery"')
       WHERE transaction_id = ${txC}`);
    const cmpPush = id('CMP-PUSH');
    const cmpBoth = id('CMP-BOTH');
    await campaignRow(cmpPush, { status: 'sent' });
    await send(cmpPush, HISTORY);
    await campaignRow(cmpBoth, { status: 'sent', channel: 'both' });
    await send(cmpBoth, HISTORY, 'both');
    // Send rows the feed refuses to trust: WhatsApp-only, held, another salon's.
    const cmpWa = id('CMP-WA');
    const cmpHeld = id('CMP-HELD');
    const cmpLum = id('CMP-LUM');
    await campaignRow(cmpWa, { status: 'sent', channel: 'wa' });
    await send(cmpWa, HISTORY, 'wa');
    await campaignRow(cmpHeld, { status: 'approved', held: true });
    await send(cmpHeld, HISTORY);
    await campaignRow(cmpLum, { salonId: OTHER_SALON, status: 'sent' });
    await send(cmpLum, HISTORY);

    const before = await feed(HISTORY);
    historyFeedIds = before.items.map((i) => i.id).sort();
    // The fixture is what it claims to be before anything is marked.
    expect(historyFeedIds).toEqual([txA, txB, cmpPush, cmpBoth].sort());
    expect(before.unreadCount).toBe(4);

    // ---- NO_OFFERS: consent off at launch ----
    await consent(NO_OFFERS, false);
    await topUp(NO_OFFERS, 3000);
    noOffersCampaign = id('CMP-NOOFF');
    await campaignRow(noOffersCampaign, { status: 'sent' });
    await send(noOffersCampaign, NO_OFFERS);

    // ---- LATE / FRESH: some history, so launch has something to mark ----
    await consent(LATE, true);
    await topUp(LATE, 2000);
    await topUp(FRESH, 2000);

    // ---- ERASED: erased before launch, with a campaign_send that survives it ----
    await consent(ERASED, true);
    const cmpErased = id('CMP-ERASED');
    await campaignRow(cmpErased, { status: 'sent' });
    await send(cmpErased, ERASED);
    await exec(sql`
      UPDATE member SET deletion_requested_at = now() - interval '31 days',
                        deletion_due_at = now() - interval '1 day'
       WHERE id = ${ERASED}`);
    const { runErasureOnce } = await import('../services/erasure');
    await runErasureOnce(db, 500);
    const [e] = await exec(sql`SELECT erased_at FROM member WHERE id = ${ERASED}`);
    expect(e?.erased_at, 'fixture: ERASED is erased before launch').not.toBeNull();
    // The case the backfill must not undo: erasure survives only as the campaign_send.
    expect(await marksOf(ERASED)).toEqual([]);
    const [s] = await exec(sql`SELECT count(*)::int AS n FROM campaign_send WHERE member_id = ${ERASED}`);
    expect(s?.n).toBe(1);

    // ---- LAUNCH ----
    await backfill();
  });

  afterAll(async () => {
    await app?.close();
  });

  // ---------------------------------------------------------------- 1 --

  it('1. what existed when it ran is read, and unreadCount is 0', async () => {
    const after = await feed(HISTORY);
    expect(after.unreadCount).toBe(0);
    expect(after.items.map((i) => i.id).sort()).toEqual(historyFeedIds);
    expect(after.items.every((i) => i.readAt !== null)).toBe(true);
  });

  it('1. the marks ARE the feed: every item she is shown, and nothing she is not', async () => {
    // Not the WhatsApp-only, held or cross-salon send rows, and not the unknown kind.
    expect(await marksOf(HISTORY)).toEqual(historyFeedIds);
  });

  it('1. across the WHOLE lane database, no live member has an unread item at launch', async () => {
    const live = await exec(sql`SELECT id FROM member WHERE erased_at IS NULL`);
    const unread: Array<[string, number]> = [];
    for (const r of live) {
      const n = await bell.unreadCountFor(db, await bell.feedScope(db, String(r.id)));
      if (n > 0) unread.push([String(r.id), n]);
    }
    expect(live.length).toBeGreaterThan(5);
    expect(unread).toEqual([]);
  });

  it('1. offers off at launch and turned back on after: the old campaigns come back READ', async () => {
    const off = await feed(NO_OFFERS);
    expect(off.visibleKinds).not.toContain('campaign');
    expect(off.unreadCount).toBe(0);

    await consent(NO_OFFERS, true);
    const on = await feed(NO_OFFERS);
    const cmp = on.items.find((i) => i.id === noOffersCampaign);
    expect(cmp, 'the campaign is back in her bell').toBeDefined();
    expect(cmp!.readAt).not.toBeNull();
    expect(on.unreadCount).toBe(0);
  });

  // ---------------------------------------------------------------- 3 --

  it('3. re-running marks nothing new, duplicates nothing, and keeps the first read_at', async () => {
    const [firstRead] = await exec(sql`
      SELECT read_at FROM member_notification_read WHERE member_id = ${HISTORY}
       ORDER BY coalesce(transaction_id, campaign_id) LIMIT 1`);
    const total = await markCount();

    expect(await backfill()).toBe(0);
    expect(await markCount()).toBe(total);

    const dupes = await exec(sql`
      SELECT member_id, coalesce(transaction_id, campaign_id) AS item, count(*)::int AS n
        FROM member_notification_read GROUP BY 1, 2 HAVING count(*) > 1`);
    expect(dupes).toEqual([]);

    const [again] = await exec(sql`
      SELECT read_at FROM member_notification_read WHERE member_id = ${HISTORY}
       ORDER BY coalesce(transaction_id, campaign_id) LIMIT 1`);
    expect(String(again?.read_at)).toBe(String(firstRead?.read_at));
  });

  // ---------------------------------------------------------------- 4 --

  it('4. an erased member gets no marks, though her campaign_send survives erasure', async () => {
    expect(await marksOf(ERASED)).toEqual([]);
  });

  // ---------------------------------------------------------------- 2 --

  it('2. a receipt and a campaign inserted AFTER it ran, backdated to 2020, are UNREAD', async () => {
    const tx = await topUp(LATE, 4000);
    await exec(sql`UPDATE receipt_job SET created_at = '2020-01-01T00:00:00Z' WHERE transaction_id = ${tx}`);
    const cmp = id('CMP-LATE');
    await campaignRow(cmp, { status: 'sent' });
    await send(cmp, LATE, 'push', '2020-01-01T00:00:00Z');

    const [r] = await exec(sql`SELECT created_at FROM receipt_job WHERE transaction_id = ${tx}`);
    expect(new Date(String(r?.created_at)).getUTCFullYear(), 'fixture: really backdated').toBe(2020);

    const f = await feed(LATE);
    const late = f.items.filter((i) => i.id === tx || i.id === cmp);
    expect(late.map((i) => i.id).sort()).toEqual([tx, cmp].sort());
    expect(late.every((i) => i.readAt === null)).toBe(true);
    expect(f.unreadCount).toBe(2);
    // …and her pre-launch top-up is still read: one read, two unread, three items.
    expect(f.items).toHaveLength(3);
  });

  // ---------------------------------------------------------------- 5 --

  it('5. a receipt after launch is unread, and the bell shows it first', async () => {
    const tx = await topUp(FRESH, 9000);
    const f = await feed(FRESH);
    expect(f.items[0]).toMatchObject({ id: tx, kind: 'topup', readAt: null });
    expect(f.items[1]?.readAt, 'her pre-launch top-up stays read').not.toBeNull();
    expect(f.unreadCount).toBe(1);
  });

  // ------------------------------------------------------------ 4, raced --

  it('4. erasure IN FLIGHT while it runs: it waits for her row, sees her erased, and writes nothing', async () => {
    await consent(RACED, true);
    const cmp = id('CMP-RACED');
    await campaignRow(cmp, { status: 'sent' });
    await send(cmp, RACED);
    await exec(sql`
      UPDATE member SET deletion_requested_at = now() - interval '31 days',
                        deletion_due_at = now() - interval '1 day'
       WHERE id = ${RACED}`);

    /**
     * Park the REAL erasure mid-transaction. Its first statement takes her member row
     * FOR UPDATE; its first DELETE is her sessions. Holding one of her session rows
     * on a separate connection stops it there — member row locked, erasure uncommitted.
     */
    const postgres = (await import('postgres')).default;
    const holder = postgres(INT_URL!, { max: 1, onnotice: () => {} });
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let held!: () => void;
    const holding = new Promise<void>((r) => (held = r));
    const holderTx = holder.begin(async (t) => {
      await t`SELECT id FROM session WHERE member_id = ${RACED} FOR UPDATE`;
      held();
      await released;
    });
    await holding;

    const waitingOn = async (pattern: string) => {
      for (let i = 0; i < 200; i++) {
        const rows = await exec(sql`
          SELECT 1 FROM pg_stat_activity
           WHERE wait_event_type = 'Lock' AND query ILIKE ${pattern}`);
        if (rows.length > 0) return;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(`nothing waiting on a lock matching ${pattern}`);
    };

    const { runErasureOnce } = await import('../services/erasure');
    const erasure = runErasureOnce(db, 500);
    await waitingOn('delete from "session"%');

    const launch = backfill();
    await waitingOn('%INSERT INTO member_notification_read%');

    release();
    await holderTx;
    await erasure;
    await launch;
    await holder.end();

    const [m] = await exec(sql`SELECT erased_at FROM member WHERE id = ${RACED}`);
    expect(m?.erased_at, 'the erasure committed').not.toBeNull();
    expect(await marksOf(RACED)).toEqual([]);
  });
});
