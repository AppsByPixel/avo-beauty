/**
 * THE CUSTOMER BELL — `GET /members/me/notifications/feed` and
 * `POST /members/me/notifications/read` — and the tenancy property neither URL can show.
 *
 * HOW TO RUN
 *
 *   pnpm --dir /absolute/worktree/api run db:up
 *   cd e2e && ../node_modules/.bin/vitest run member-bell.test.ts
 *
 * WHY `SALON_ROUTES` DOES NOT APPLY, AND WHAT IS PINNED INSTEAD
 * -------------------------------------------------------------
 * `tenancy.test.ts § SALON_ROUTES` drives salon-scoped routes by swapping the salon
 * id in the PATH and requiring a 403. These two routes have no id in the path at all:
 * `/members/me/…` is scoped by the CREDENTIAL. There is nothing to swap, so a 403
 * row would be a row that cannot fail.
 *
 * The property worth pinning is the one the path cannot express: member A's session
 * cannot READ member B's bell, and cannot MARK member B's rows — including by passing
 * B's real ids in the BODY, which is the one place a foreign id can enter. Lane A's
 * rule is that a foreign id marks nothing and answers `marked: 0`, exactly as an
 * already-read or made-up id does, rather than a 404 that would confirm it exists.
 *
 * PROVED THE WAY THE MERCHANT BELL'S WAS: the row is read back out of Postgres.
 * `marked: 0` in a reply is the API describing itself. What settles it is that
 * `member_notification_read` holds no row — for ANY member — naming B's
 * transactions, and that B's own feed still shows them unread.
 *
 * NOT HOLLOW, AND THIS IS THE SHAPE THE LAST TWO SLICES GOT WRONG
 * ---------------------------------------------------------------
 * A tenancy spec against a member with an empty bell proves nothing: A's feed would
 * be disjoint from B's because both are empty, and "A marked none of B's rows"
 * because B has none. So both members are given REAL receipts — two top-ups each,
 * settled through the sandbox gateway, which writes `receipt_job` inside the money
 * transaction — and a tripwire refuses to run the specs unless both bells carry
 * unread rows. And the ids A sends are proved MARKABLE by B herself at the end: a
 * `marked: 0` over ids nobody could mark would be a spec about junk ids.
 *
 * Every check is narrowed to these two members' transaction ids. No whole-table
 * sweep, so the suite's other fixtures cannot hold a count up or push one over.
 *
 * THE MEMBERS ARE THIS FILE'S OWN, zero balance, every fil through the gateway, so
 * they reconcile by construction and the wallet census has nothing to forgive.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { precondition } from './support/known-bug.js';
import {
  SALON_A,
  psql,
  scalar,
  signInMember,
  startTenancyApi,
  stopTenancyApi,
  treq,
} from './support/tenancy-harness.js';

const CLONE_SOURCE = 'QA-GW-0001';
const A = { id: 'QA-BELL-0001', phone: '+96555970001' };
const B = { id: 'QA-BELL-0002', phone: '+96555970002' };

let tokenA = '';
let tokenB = '';
let n = 0;
const key = (label: string) => `qabell-${label}-${Date.now()}-${n++}`;

interface Feed {
  items: Array<{ id: string; kind: string; readAt: string | null; transactionId?: string }>;
  nextCursor: string | null;
  unreadCount: number;
  visibleKinds: string[];
}

const feedOf = (token: string) =>
  treq<Feed>('GET', '/members/me/notifications/feed', { token });

const mark = (token: string, body: unknown) =>
  treq<{ marked: number; unreadCount: number }>('POST', '/members/me/notifications/read', {
    token,
    body,
  });

/** Her receipt transactions, from the outbox — the rows her bell is built from. */
const receiptTxOf = (memberId: string): string[] =>
  scalar(
    `select coalesce(string_agg(distinct transaction_id, ',' order by transaction_id), '')
       from receipt_job where member_id = '${memberId}'`,
  )
    .trim()
    .split(',')
    .filter(Boolean);

/** Marks naming these transactions, by ANY member. The row the tenancy claim is about. */
const marksOn = (txIds: string[]): number =>
  txIds.length === 0
    ? 0
    : Number(
        scalar(
          `select count(*) from member_notification_read
            where transaction_id in (${txIds.map((t) => `'${t}'`).join(',')})`,
        ),
      );

async function topUp(token: string, amountFils: number, label: string): Promise<void> {
  const t = await treq<any>('POST', '/topups', {
    token,
    idempotencyKey: key(label),
    body: { amountFils, method: 'knet' },
  });
  precondition(t.status === 200, `top-up ${label}: ${t.status} ${t.raw}`);
  const ref = /\/_gateway\/([^/?#]+)/.exec(t.body.redirectUrl ?? '')?.[1];
  precondition(!!ref, `no gateway ref: ${t.body.redirectUrl}`);
  const paid = await treq<any>('POST', `/_gateway/${ref}`, {
    token: null,
    body: { outcome: 'succeeded', notify: true },
  });
  precondition(paid.status === 200, `settle ${label}: ${paid.status} ${paid.raw}`);
}

beforeAll(async () => {
  await startTenancyApi();

  for (const m of [A, B]) {
    psql(`
      INSERT INTO member (id, salon_id, name, phone, email, email_verified, password_hash,
                          balance_fils, visits, tier, stamps, policy_version)
      SELECT '${m.id}', salon_id, 'Bell QA ${m.id}', '${m.phone}', NULL, false,
             password_hash, 0, 0, 'silver', NULL, policy_version
        FROM member WHERE id = '${CLONE_SOURCE}'
      ON CONFLICT (id) DO NOTHING;
    `);
    precondition(
      scalar(`select count(*) from member where id='${m.id}'`).trim() === '1',
      `the clone source ${CLONE_SOURCE} is missing, so ${m.id} has no row`,
    );
  }
  tokenA = await signInMember(SALON_A, A.phone);
  tokenB = await signInMember(SALON_A, B.phone);

  // Two real receipts each. Different figures per member, so a row that crossed
  // over would carry a figure that is visibly not hers.
  await topUp(tokenA, 3_000, 'a1');
  await topUp(tokenA, 4_000, 'a2');
  await topUp(tokenB, 7_000, 'b1');
  await topUp(tokenB, 8_000, 'b2');
}, 180_000);

afterAll(async () => {
  await stopTenancyApi();
});

// -------------------------------------------------------------- tripwires --

describe('tripwires — both bells are populated, or nothing below means anything', () => {
  it('the sessions are the two members, not the shim principal', async () => {
    for (const [tok, m] of [
      [tokenA, A],
      [tokenB, B],
    ] as const) {
      const me = await treq<{ id: string }>('GET', '/members/me', { token: tok });
      expect(me.status, me.raw).toBe(200);
      expect(me.body.id).toBe(m.id);
    }
  });

  it('each bell carries unread receipts of her own, and nothing is marked yet', async () => {
    for (const [tok, m] of [
      [tokenA, A],
      [tokenB, B],
    ] as const) {
      const f = await feedOf(tok);
      expect(f.status, f.raw).toBe(200);
      const own = receiptTxOf(m.id);
      expect(own.length, `${m.id} has no receipt rows, so her bell is empty`).toBeGreaterThanOrEqual(2);
      expect(f.body.items.length, `${m.id}'s bell is empty — the tenancy specs would be vacuous`).toBeGreaterThanOrEqual(2);
      expect(f.body.unreadCount).toBeGreaterThanOrEqual(2);
      expect(f.body.items.every((i) => i.readAt === null)).toBe(true);
      expect(marksOn(own), `${m.id} already has read marks — the fixture is not fresh`).toBe(0);
    }
  });

  /**
   * `booking_policy` IS ALWAYS VISIBLE (migration 0066). The salon changing the terms of
   * her bookings is a fact about her account, like a receipt, and not marketing, so it is
   * not behind the `offers` consent the way `campaign` is. Every receipt kind must be
   * there too. `booking-policy.test.ts` proves a publish lands in the bell; this proves
   * the bell says it can hold one, for both members, whatever their consent.
   */
  it('both bells can hold a booking-policy notice, and every receipt kind', async () => {
    for (const tok of [tokenA, tokenB]) {
      const f = await feedOf(tok);
      expect(f.status, f.raw).toBe(200);
      expect(f.body.visibleKinds).toEqual(
        expect.arrayContaining(['topup', 'charge', 'shop', 'deposit_hold', 'deposit_return', 'booking_policy']),
      );
    }
  });
});

// ------------------------------------------------------------------ read --

describe("member A's bell never carries member B's rows", () => {
  it('the two feeds are disjoint, and every row A is served is a transaction of hers', async () => {
    const fa = (await feedOf(tokenA)).body;
    const fb = (await feedOf(tokenB)).body;
    const idsA = fa.items.map((i) => i.id);
    const idsB = fb.items.map((i) => i.id);
    precondition(idsA.length > 0 && idsB.length > 0, 'an empty bell — see the tripwires');

    expect(idsA.filter((id) => idsB.includes(id)), "B's rows appear in A's bell").toEqual([]);

    const owners = scalar(
      `select coalesce(string_agg(distinct member_id, ','), '') from "transaction"
        where id in (${idsA.map((t) => `'${t}'`).join(',')})`,
    ).trim();
    expect(owners, "A's bell serves a transaction that is not A's").toBe(A.id);

    // And the badge is hers too: B's unread rows are not counted on A's bell.
    expect(fa.unreadCount).toBe(receiptTxOf(A.id).length);
  });
});

// ------------------------------------------------------------------ write --

describe("member A cannot mark member B's rows — by B's real ids in the body, or by 'all'", () => {
  let bIds: string[] = [];
  let aUnreadBefore = 0;
  let bUnreadBefore = 0;

  it("A sending B's real ids marks nothing: `marked: 0`, and Postgres holds no mark on B's rows", async () => {
    // From Postgres, not from B's feed: the ids are B's because the outbox says so,
    // so a feed that had started serving the wrong rows cannot also choose the probe.
    bIds = receiptTxOf(B.id);
    precondition(bIds.length >= 2, "B has no receipts");
    const servedToB = (await feedOf(tokenB)).body.items.map((i) => i.id);
    precondition(
      bIds.every((id) => servedToB.includes(id)),
      "B's own bell does not carry her receipts, so they are not live notification ids",
    );
    aUnreadBefore = (await feedOf(tokenA)).body.unreadCount;
    bUnreadBefore = (await feedOf(tokenB)).body.unreadCount;

    const res = await mark(tokenA, { ids: bIds });
    expect(res.status, res.raw).toBe(200);
    expect(res.body.marked, "A's session marked B's notifications").toBe(0);
    expect(res.body.unreadCount).toBe(aUnreadBefore);

    // THE ROW, not the reply. No mark by anybody names B's transactions.
    expect(marksOn(bIds), "a read mark was written against B's transactions").toBe(0);

    // And B's own bell still shows every one of them unread.
    const fb = (await feedOf(tokenB)).body;
    expect(fb.unreadCount).toBe(bUnreadBefore);
    expect(fb.items.filter((i) => bIds.includes(i.id)).every((i) => i.readAt === null)).toBe(true);
  });

  it("the answer for B's real ids is byte-identical to the answer for ids that name nothing", async () => {
    precondition(bIds.length > 0, 'the previous spec collected nothing');
    const real = await mark(tokenA, { ids: bIds });
    const junk = await mark(tokenA, { ids: bIds.map((_, i) => `TX-QABELL-NO-SUCH-${i}`) });
    expect(real.status).toBe(junk.status);
    expect(real.raw, "B's ids are distinguishable from made-up ones — an existence oracle").toBe(
      junk.raw,
    );
  });

  it("A marking ALL marks exactly A's rows and none of B's", async () => {
    precondition(bIds.length > 0, 'the previous spec collected nothing');
    const own = receiptTxOf(A.id);
    const res = await mark(tokenA, { all: true });
    expect(res.status, res.raw).toBe(200);
    expect(res.body.marked).toBe(aUnreadBefore);
    expect(res.body.unreadCount).toBe(0);

    expect(marksOn(bIds), "'mark all' on A's session wrote a mark on B's rows").toBe(0);
    // Every mark A now holds names a transaction of A's.
    expect(
      scalar(
        `select coalesce(string_agg(distinct t.member_id, ','), '')
           from member_notification_read r join "transaction" t on t.id = r.transaction_id
          where r.member_id = '${A.id}'`,
      ).trim(),
    ).toBe(A.id);
    expect(marksOn(own)).toBe(own.length);

    const fb = (await feedOf(tokenB)).body;
    expect(fb.unreadCount, "A's 'mark all' cleared B's badge").toBe(bUnreadBefore);
  });

  it("THE CONTROL — the same ids ARE markable, by the one member they belong to", async () => {
    precondition(bIds.length > 0, 'the previous spec collected nothing');
    const res = await mark(tokenB, { ids: [bIds[0]] });
    expect(res.status, res.raw).toBe(200);
    expect(res.body.marked, "B could not mark her own row — so A's `marked: 0` proved nothing").toBe(1);
    expect(res.body.unreadCount).toBe(bUnreadBefore - 1);
    expect(
      scalar(`select member_id from member_notification_read where transaction_id='${bIds[0]}'`).trim(),
    ).toBe(B.id);
  });
});
