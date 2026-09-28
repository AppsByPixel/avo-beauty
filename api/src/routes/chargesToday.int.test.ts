/**
 * GET /charges — "TODAY" STARTS AT THE SALON'S MIDNIGHT, not the API process's.
 *
 * The line this pins was `since = new Date(); since.setHours(0, 0, 0, 0)`:
 * midnight in whatever zone the API booted under. Trunk's full gate on 36f7855
 * ran at 00:0x in Karachi (UTC+5), where midnight is 22:00 in Kuwait, and
 * `e2e/contract.test.ts` lost fixture charges made minutes earlier. On Vercel
 * the process is UTC, and a Kuwait salon's "today" began at 03:00 Kuwait — staff
 * closing up after midnight saw yesterday's charges until three in the morning.
 *
 * THE PROCESS IS PINNED TO Asia/Karachi below, before the app is imported, and
 * a guard asserts the pin took. Under Karachi the old line and the salon's
 * midnight disagree in BOTH directions, depending on which side of Karachi's
 * midnight "now" falls, so each direction gets its own scenario:
 *
 *   now AFTER Karachi midnight   the old line started the day too LATE, and
 *                                dropped the salon's 21:30 charge.
 *   now BEFORE Karachi midnight  the old line started it too EARLY, and listed
 *                                the salon's 23:59 charge from yesterday.
 *
 * A SALON IN A DST ZONE, on both transition days of America/New_York. A 25-hour
 * and a 23-hour day are where "now − 24h" and a salon midnight disagree, so the
 * cases are placed to go red under that implementation too — the fix has to be
 * right by construction, not by the offset happening to be constant.
 *
 * "NOW" IS FAKED — `Date` only, so the postgres driver's timers still run —
 * because the property is about which side of two midnights the clock is on,
 * and a spec that used the real clock would pass or fail depending on the hour
 * it ran. Only the request runs under the stopped clock; the session is minted
 * on the real one — `listAt` says why.
 *
 * A FRESH SALON PER SCENARIO, with its own branch, staff member and customer.
 * `GET /charges` has no upper bound, so charges from any other spec in the same
 * salon would be listed alongside these; a salon of its own makes every row in
 * the response one this spec placed. The charge rows are inserted directly with
 * a chosen `created_at` — the property under test is the listing's lower bound,
 * and `performCharge` stamps `created_at` from Postgres's `now()`, which no
 * fake clock in this process can move. All dates are in the past, so none of
 * these rows can surface in a real-time "today" anywhere.
 */

// BEFORE ANY IMPORT THAT CAN READ THE ZONE. Node re-reads `TZ` on assignment,
// and nothing below constructs a local-time Date before the guard runs.
process.env.TZ = 'Asia/Karachi';

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const INT_URL = process.env.AVO_INT_DATABASE_URL;

/** Skip rather than connect — `vitest.int.config.ts` § the empty-string fallback. */
const suite = INT_URL ? describe : describe.skip;

suite('GET /charges — today is the salon’s calendar day', () => {
  let app: FastifyInstance;

  let db: typeof import('../db/client')['db'];
  let salon: typeof import('../db/schema/salon')['salon'];
  let branch: typeof import('../db/schema/salon')['branch'];
  let member: typeof import('../db/schema/member')['member'];
  let staffUser: typeof import('../db/schema/staff')['staffUser'];
  let transaction: typeof import('../db/schema/transaction')['transaction'];
  let issueSession: typeof import('../auth/sessions')['issueSession'];

  beforeAll(async () => {
    db = (await import('../db/client')).db;
    ({ salon, branch } = await import('../db/schema/salon'));
    member = (await import('../db/schema/member')).member;
    staffUser = (await import('../db/schema/staff')).staffUser;
    transaction = (await import('../db/schema/transaction')).transaction;
    issueSession = (await import('../auth/sessions')).issueSession;
    app = await (await import('../app')).buildApp();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(async () => {
    await app?.close();
  });

  interface Till {
    salonId: string;
    branchId: string;
    memberId: string;
    staffId: string;
  }

  /** A salon in `timezone` with one branch, one manager who may read charges, one customer. */
  async function mintSalon(timezone: string): Promise<Till> {
    const tag = randomUUID().slice(0, 8);
    const salonId = `SAL-INT-TODAY-${tag}`;
    const branchId = `BR-INT-TODAY-${tag}`;
    const memberId = `MB-INT-TODAY-${tag}`;
    const staffId = `ST-INT-TODAY-${tag}`;
    await db.insert(salon).values({
      id: salonId,
      name: `Int Today ${tag}`,
      plan: 'starter',
      brandColor: '#7A5C8E',
      loyaltyMode: 'tiers',
      tiers: [{ name: 'bronze', minVisits: 0, bonusPercent: 0 }],
      depositFils: 5000 as never,
      businessHours: { morning: ['10:00', '13:00'], evening: ['16:00', '21:00'] },
      social: [],
      timezone,
    });
    await db.insert(branch).values({ id: branchId, salonId, name: 'Main' });
    await db.insert(staffUser).values({
      id: staffId,
      salonId,
      name: 'Int Today Manager',
      handle: `int-today-${tag}`,
      role: 'manager',
      passwordHash: '$argon2id$fake-not-a-credential',
      permScanner: true,
      permCharges: true,
    });
    await db.insert(member).values({
      id: memberId,
      salonId,
      name: 'Int Today',
      phone: `+9658${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}`,
      passwordHash: '$argon2id$fake-not-a-credential',
      balanceFils: 0 as never,
      visits: 0,
      tier: 'bronze',
      policyVersion: 3,
    });
    return { salonId, branchId, memberId, staffId };
  }

  /** A settled charge at exactly `at`. Returns its id. */
  async function chargeAt(t: Till, at: string): Promise<string> {
    const id = `TX-INT-TODAY-${randomUUID().slice(0, 12)}`;
    await db.insert(transaction).values({
      id,
      memberId: t.memberId,
      salonId: t.salonId,
      branchId: t.branchId,
      kind: 'charge',
      amountFils: -8000 as never,
      status: 'settled',
      createdAt: new Date(at),
      settledAt: new Date(at),
    });
    return id;
  }

  /** `GET /charges` as the salon's manager, with the process clock stopped at `now`. */
  async function listAt(t: Till, now: string): Promise<string[]> {
    // Minted on the REAL clock: `session_expires_after_creation` compares the
    // row's `expires_at` (computed from `Date.now()`) with Postgres's own
    // `created_at`, so a session minted under a clock stopped a year ago is
    // refused as already expired. The JWT then carries a real `iat`/`exp`,
    // which `jose` accepts under a clock that is earlier than both.
    const s = await issueSession(db, {
      principalKind: 'staff',
      staffId: t.staffId,
      salonId: t.salonId,
      scope: 'scanner',
      deviceId: `DEV-INT-TODAY-${randomUUID()}`,
    });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(now));
    let res: Awaited<ReturnType<FastifyInstance['inject']>>;
    try {
      res = await app.inject({
        method: 'GET',
        url: '/charges',
        headers: { authorization: `Bearer ${s.accessToken}` },
      });
    } finally {
      vi.useRealTimers();
    }
    expect(res.statusCode, res.body).toBe(200);
    return (res.json() as { items: Array<{ id: string }> }).items.map((i) => i.id);
  }

  it('the process really is in Karachi — otherwise nothing below proves anything', () => {
    // 19:30Z is 00:30 the next day in Karachi (UTC+5, no DST).
    const probe = new Date('2026-08-17T19:30:00Z');
    expect(probe.getHours()).toBe(0);
    expect(probe.getDate()).toBe(18);
  });

  it('Kuwait, after Karachi midnight: the 21:30 and 22:30 charges are today, 23:59 yesterday is not', async () => {
    const t = await mintSalon('Asia/Kuwait');
    // 2026-08-17 in Kuwait (UTC+3). Karachi's midnight is 19:00Z = 22:00 Kuwait.
    const beforeKarachiMidnight = await chargeAt(t, '2026-08-17T21:30:00+03:00'); // 18:30Z
    const afterKarachiMidnight = await chargeAt(t, '2026-08-17T22:30:00+03:00'); // 19:30Z
    const yesterday = await chargeAt(t, '2026-08-16T23:59:00+03:00'); // 20:59Z the day before

    // 22:45 Kuwait = 19:45Z = 00:45 on the 18th in Karachi.
    const ids = await listAt(t, '2026-08-17T22:45:00+03:00');

    // The incident: the old line took 19:00Z as "today" and dropped this one.
    expect(ids).toContain(beforeKarachiMidnight);
    expect(ids).toContain(afterKarachiMidnight);
    expect(ids).not.toContain(yesterday);
  });

  it('Kuwait, before Karachi midnight: yesterday’s 23:59 charge is not today, 00:05 is', async () => {
    const t = await mintSalon('Asia/Kuwait');
    const yesterday = await chargeAt(t, '2026-08-16T23:59:00+03:00'); // 20:59Z on the 16th
    const justAfterMidnight = await chargeAt(t, '2026-08-17T00:05:00+03:00'); // 21:05Z on the 16th

    // 21:00 Kuwait = 18:00Z = 23:00 on the 17th in Karachi, whose midnight was
    // 19:00Z on the 16th — 22:00 Kuwait YESTERDAY. The old line listed 23:59.
    const ids = await listAt(t, '2026-08-17T21:00:00+03:00');

    expect(ids).not.toContain(yesterday);
    expect(ids).toContain(justAfterMidnight);
  });

  it('New York on the 25-hour day: a charge at 00:15 EDT is today although it is 24h15m old', async () => {
    const t = await mintSalon('America/New_York');
    // 2025-11-02: clocks fall back 02:00 EDT → 01:00 EST. Midnight is 00:00 EDT = 04:00Z.
    const firstThing = await chargeAt(t, '2025-11-02T00:15:00-04:00'); // 04:15Z
    const yesterday = await chargeAt(t, '2025-11-01T23:50:00-04:00'); // 03:50Z

    // 23:30 EST = 04:30Z on the 3rd. `now − 24h` is 04:30Z on the 2nd, which
    // would drop `firstThing`; Karachi's midnight is 19:00Z on the 2nd, which
    // drops it too.
    const ids = await listAt(t, '2025-11-02T23:30:00-05:00');

    expect(ids).toContain(firstThing);
    expect(ids).not.toContain(yesterday);
  });

  it('New York on the 23-hour day: 23:30 EST the night before is not today although it is under 24h old', async () => {
    const t = await mintSalon('America/New_York');
    // 2026-03-08: clocks spring forward 02:00 EST → 03:00 EDT. Midnight is 00:00 EST = 05:00Z.
    const firstThing = await chargeAt(t, '2026-03-08T00:10:00-05:00'); // 05:10Z
    const lastNight = await chargeAt(t, '2026-03-07T23:30:00-05:00'); // 04:30Z

    // 23:30 EDT = 03:30Z on the 9th. `now − 24h` is 03:30Z on the 8th, which
    // would list `lastNight`; Karachi's midnight is 19:00Z on the 8th, which
    // drops `firstThing`.
    const ids = await listAt(t, '2026-03-08T23:30:00-04:00');

    expect(ids).toContain(firstThing);
    expect(ids).not.toContain(lastNight);
  });
});
