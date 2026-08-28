/**
 * `GET /salons/{id}/metrics?branch=` — against real rows, the real driver and the
 * real permission stack.
 *
 * =========================================================================
 * WHY THIS CANNOT BE A PURE SPEC
 * =========================================================================
 * Every claim in here is a claim about ROWS. "Jabriya's repeat rate is 33%" is
 * not a property of a function, it is a property of four charges spread over
 * three members; "a branch belonging to another salon is a 404" is a property of
 * a WHERE clause with two equalities in it, and a mock returning undefined would
 * pass against a resolver that had dropped the tenancy half. The aggregates also
 * use `FILTER (WHERE …)` and `count(DISTINCT …)` in one SELECT, which is exactly
 * the class of SQL no unit test observes.
 *
 * `vitest.int.config.ts` carries why this suite is separate, why it is not in
 * `pnpm check`, and why it SKIPS rather than connects when
 * `AVO_INT_DATABASE_URL` is unset. Run it against your own lane database:
 *
 *     ./scripts/lane-db.sh a
 *     export AVO_INT_DATABASE_URL="postgres://avo_app:avo_app_dev_password@localhost:5433/avo_lane_a"
 *     npx vitest run --config vitest.int.config.ts
 *
 * =========================================================================
 * IT RUNS AT SAL-LUMIERE, AND THAT WAS FOUND BY RUNNING IT THREE TIMES
 * =========================================================================
 * The first draft used `SAL-AMARA`, the seeded two-branch salon. It passed on the
 * first full-suite run and FAILED on the second and third — `activeMembers` 20
 * where 5 was expected, `repeatRatePercent` 100 where 75 was.
 *
 * The cause is that `scannerLimit`, `topupLimit` and `receiptWorker` all write
 * real charges and top-ups at SAL-LUMIERE's sibling and leave them there. With
 * `fileParallelism: false` this file happens to run BEFORE them alphabetically,
 * so a run against a freshly reset database sees none of their rows and every run
 * afterwards sees all of them. A suite whose expectations are absolute cannot
 * share a salon with suites whose fixtures are not cleaned up.
 *
 * That is decision 75 in miniature — a green first run that was luck — and it is
 * the reason this file measures a salon nothing else in `api/` touches.
 * `SAL-LUMIERE` is seeded with two branches (Hawally, Jabriya) and ZERO
 * transactions, bookings, members, artists, services and staff, so every row
 * counted below is one this file wrote. `beforeAll` asserts that, by name, rather
 * than assuming it: if another suite ever moves in, this fails with the reason
 * printed instead of quietly returning a different number.
 *
 * =========================================================================
 * `now` IS PINNED, AND THAT IS NOT A CONVENIENCE EITHER
 * =========================================================================
 * Three of these figures are bounded by the SALON'S OWN MIDNIGHT — `loadedToday`
 * at both ends, `upcomingAppointments` at the top. A suite on the real clock
 * would pass all afternoon and fail after 21:00 Kuwait, when the fixture's
 * bookings stop being "still to start today". So `computeMetrics` is called with
 * an explicit `now` and every fixture instant is written relative to that
 * constant. The route specs, which cannot inject a clock, therefore assert STATUS
 * CODES AND SHAPE ONLY — never a figure.
 *
 * =========================================================================
 * THE FIXTURE, AND WHY EACH ROW IS THE SHAPE IT IS
 * =========================================================================
 *   IT-M1  2 charges at Hawally, branch RECORDED
 *   IT-M2  1 charge  at Hawally, recorded  +  1 charge at Jabriya, ASSUMED
 *   IT-M3  2 charges at Jabriya, ASSUMED
 *   IT-M4  1 charge  at Jabriya, ASSUMED
 *
 * IT-M2 is the point of it. She is active at BOTH branches, which is what makes
 * `activeMembers` demonstrably non-additive, and her Hawally row is recorded
 * while her Jabriya row is not — so she must land in Jabriya's assumed bucket and
 * NOT in Hawally's. A fixture where every member sat at one branch would pass
 * against an implementation that had both of those backwards.
 *
 * IT-M4 exists so the three repeat rates are three different numbers
 * (75 / 50 / 33). With her removed both branches read 50% and the suite would
 * pass against a filter that was being ignored on that metric.
 *
 * Two top-ups, one per branch, both `branch_assumed` — not a choice this fixture
 * made but the only thing `services/topup.ts` can write.
 *
 * IDEMPOTENT ACROSS RUNS BY CONSTRUCTION. Every row is prefixed `IT-`, `beforeAll`
 * deletes that prefix before inserting it, and `afterAll` deletes it again.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

const INT_URL = process.env.AVO_INT_DATABASE_URL;
const suite = INT_URL ? describe : describe.skip;

const SALON = 'SAL-LUMIERE';
const HAWALLY = { id: 'BR-LUM-HAW', name: 'Hawally' };
const JABRIYA = { id: 'BR-LUM-JAB', name: 'Jabriya' };
/** SAL-AMARA's Salmiya. A REAL branch, at a salon this caller is not staff of. */
const FOREIGN_BRANCH = 'BR-SAL';
const STAFF = 'IT-ST-LUM';

/** 15:00 in Kuwait: comfortably inside the salon's day at both ends. */
const NOW = new Date('2026-08-29T12:00:00.000Z');
const S = { id: SALON, timezone: 'Asia/Kuwait' };

suite('GET /salons/:id/metrics — the branch filter', () => {
  let app: FastifyInstance;
  let db: (typeof import('../db/client'))['db'];
  let sql: (typeof import('drizzle-orm'))['sql'];
  let computeMetrics: (typeof import('./metrics'))['computeMetrics'];
  let bearer: string;

  const rows = async (q: unknown) =>
    (await db.execute(q as never)) as unknown as Array<Record<string, unknown>>;
  const scalar = async (q: unknown) => Number((await rows(q))[0]?.n);

  async function wipe(): Promise<void> {
    await db.execute(sql`DELETE FROM booking WHERE id LIKE 'IT-B%'`);
    await db.execute(sql`DELETE FROM "transaction" WHERE id LIKE 'IT-TX-%'`);
    await db.execute(sql`DELETE FROM member WHERE id LIKE 'IT-M%'`);
    await db.execute(sql`DELETE FROM artist WHERE id LIKE 'IT-AR%'`);
    await db.execute(sql`DELETE FROM service WHERE id LIKE 'IT-SV%'`);
    // Sessions cascade off the staff row (session_staff_id_staff_user_id_fk).
    await db.execute(sql`DELETE FROM staff_user WHERE id = ${STAFF}`);
  }

  beforeAll(async () => {
    db = (await import('../db/client')).db;
    sql = (await import('drizzle-orm')).sql;
    computeMetrics = (await import('./metrics')).computeMetrics;
    const issueSession = (await import('../auth/sessions')).issueSession;
    app = await (await import('../app')).buildApp();

    await wipe();

    await db.execute(sql`
      INSERT INTO staff_user (id, salon_id, name, handle, role, branch_access_all, perm_dashboard)
      VALUES (${STAFF}, ${SALON}, 'Int Lumiere', 'it-lumiere', 'manager', true, true)`);
    await db.execute(sql`
      INSERT INTO artist (id, salon_id, name) VALUES ('IT-AR1',${SALON},'Int Artist')`);
    await db.execute(sql`
      INSERT INTO service (id, salon_id, name, price_fils) VALUES ('IT-SV1',${SALON},'Int Service',8000)`);

    await db.execute(sql`
      INSERT INTO member (id, salon_id, name, phone, password_hash, balance_fils, tier, visits, policy_version)
      VALUES ('IT-M1',${SALON},'Int One'  ,'+96590000001','x',0,'bronze',0,1),
             ('IT-M2',${SALON},'Int Two'  ,'+96590000002','x',0,'bronze',0,1),
             ('IT-M3',${SALON},'Int Three','+96590000003','x',0,'bronze',0,1),
             ('IT-M4',${SALON},'Int Four' ,'+96590000004','x',0,'bronze',0,1)`);

    await db.execute(sql`
      INSERT INTO "transaction"
        (id, member_id, salon_id, branch_id, branch_assumed, kind, amount_fils, method, status, created_at, settled_at)
      VALUES
        ('IT-TX-C1','IT-M1',${SALON},'BR-LUM-HAW',false,'charge',-5000,'wallet','settled','2026-08-28T12:00:00Z','2026-08-28T12:00:00Z'),
        ('IT-TX-C2','IT-M1',${SALON},'BR-LUM-HAW',false,'charge',-5000,'wallet','settled','2026-08-28T12:05:00Z','2026-08-28T12:05:00Z'),
        ('IT-TX-C3','IT-M2',${SALON},'BR-LUM-HAW',false,'charge',-5000,'wallet','settled','2026-08-28T12:10:00Z','2026-08-28T12:10:00Z'),
        ('IT-TX-C4','IT-M2',${SALON},'BR-LUM-JAB',true ,'charge',-5000,'wallet','settled','2026-08-28T12:15:00Z','2026-08-28T12:15:00Z'),
        ('IT-TX-C5','IT-M3',${SALON},'BR-LUM-JAB',true ,'charge',-5000,'wallet','settled','2026-08-28T12:20:00Z','2026-08-28T12:20:00Z'),
        ('IT-TX-C6','IT-M3',${SALON},'BR-LUM-JAB',true ,'charge',-5000,'wallet','settled','2026-08-28T12:25:00Z','2026-08-28T12:25:00Z'),
        ('IT-TX-C7','IT-M4',${SALON},'BR-LUM-JAB',true ,'charge',-5000,'wallet','settled','2026-08-28T12:30:00Z','2026-08-28T12:30:00Z'),
        ('IT-TX-T1','IT-M1',${SALON},'BR-LUM-HAW',true ,'topup', 10000,'knet' ,'settled','2026-08-29T09:00:00Z','2026-08-29T09:00:00Z'),
        ('IT-TX-T2','IT-M2',${SALON},'BR-LUM-JAB',true ,'topup', 10000,'card' ,'settled','2026-08-29T09:05:00Z','2026-08-29T09:05:00Z'),
        ('IT-TX-H1','IT-M1',${SALON},'BR-LUM-HAW',false,'deposit_hold',-3000,'wallet','settled','2026-08-29T08:00:00Z','2026-08-29T08:00:00Z'),
        ('IT-TX-H2','IT-M2',${SALON},'BR-LUM-JAB',true ,'deposit_hold',-3000,'wallet','settled','2026-08-29T08:05:00Z','2026-08-29T08:05:00Z'),
        ('IT-TX-H3','IT-M3',${SALON},'BR-LUM-JAB',true ,'deposit_hold',-3000,'wallet','settled','2026-08-29T08:10:00Z','2026-08-29T08:10:00Z')`);

    await db.execute(sql`
      INSERT INTO booking
        (id, salon_id, branch_id, branch_assumed, member_id, artist_id, service_id,
         starts_at, ends_at, duration_min, deposit_fils, status, hold_transaction_id, no_show_return_due_at)
      VALUES
        ('IT-B1',${SALON},'BR-LUM-HAW',false,'IT-M1','IT-AR1','IT-SV1','2026-08-29T14:00:00Z','2026-08-29T15:00:00Z',60,3000,'deposit_held','IT-TX-H1','2026-08-30T14:00:00Z'),
        ('IT-B2',${SALON},'BR-LUM-JAB',true ,'IT-M2','IT-AR1','IT-SV1','2026-08-29T15:00:00Z','2026-08-29T16:00:00Z',60,3000,'deposit_held','IT-TX-H2','2026-08-30T15:00:00Z'),
        ('IT-B3',${SALON},'BR-LUM-JAB',true ,'IT-M3','IT-AR1','IT-SV1','2026-08-29T16:00:00Z','2026-08-29T17:00:00Z',60,3000,'deposit_held','IT-TX-H3','2026-08-30T16:00:00Z')`);

    /**
     * THE ISOLATION IS ASSERTED, NOT ASSUMED. Every absolute number below is only
     * true while this file owns every row at this salon. The first draft of this
     * suite learned that the expensive way against SAL-AMARA — see the header —
     * so if another suite ever seeds SAL-LUMIERE this fails HERE, with the reason,
     * rather than in four expectations that look like a regression in the filter.
     */
    const strays = await scalar(sql`
      SELECT (SELECT count(*) FROM "transaction" WHERE salon_id = ${SALON} AND id NOT LIKE 'IT-TX-%')
           + (SELECT count(*) FROM booking       WHERE salon_id = ${SALON} AND id NOT LIKE 'IT-B%')
           AS n`);
    expect(
      strays,
      `${SALON} is expected to hold only this file's IT-* rows; found ${strays} others. ` +
        `Another suite has started seeding this salon — see this file's header.`,
    ).toBe(0);

    bearer = (
      await issueSession(db, {
        principalKind: 'staff',
        staffId: STAFF,
        salonId: SALON,
        scope: 'dashboard',
      })
    ).accessToken;
  });

  afterAll(async () => {
    // Leaves the lane database as it found it. The defect this file's header
    // documents is one another suite caused by not doing this.
    if (db) await wipe();
    await app?.close();
  });

  const metrics = (branch: { id: string; name: string } | null) =>
    computeMetrics(db, S, '30d', NOW, branch);

  const get = (qs: string) =>
    app.inject({
      method: 'GET',
      url: `/salons/${SALON}/metrics${qs}`,
      headers: { authorization: `Bearer ${bearer}` },
    });

  // ==================================================================
  // BACKWARDS COMPATIBILITY. The claim Lane C's existing Overview rests on.
  // ==================================================================
  describe('an existing caller that sends no branch is unaffected', () => {
    it('returns the same seven figures with no branch, with branch=all and with branch=""', async () => {
      // The three spellings of "every branch" must be ONE answer, not three that
      // happen to agree today.
      const viaRoute = await Promise.all([get(''), get('?branch=all'), get('?branch=')]);
      for (const res of viaRoute) expect(res.statusCode).toBe(200);
      const bodies = viaRoute.map((r) => JSON.parse(r.body));
      expect(bodies[1]).toEqual(bodies[0]);
      expect(bodies[2]).toEqual(bodies[0]);

      // The seven pre-existing fields at their pre-change values — measured
      // against this same fixture on the parent commit, where `computeMetrics`
      // took four arguments and knew nothing about a branch.
      expect(await metrics(null)).toMatchObject({
        activeMembers: 4,
        activeMembersDelta: 4,
        loadedTodayFils: 20_000,
        knetSharePercent: 50,
        repeatRatePercent: 75,
        upcomingAppointments: 3,
        nextAppointmentAt: '2026-08-29T14:00:00.000Z',
      });
    });

    it('adds branchId, branchName and branchAssumed as null rather than as absent', async () => {
      const none = await metrics(null);
      // Present-and-null, not missing. A client destructuring `branchAssumed` must
      // not get `undefined` from the unfiltered call and an object from the
      // filtered one.
      expect(none.branchId).toBeNull();
      expect(none.branchName).toBeNull();
      expect(none.branchAssumed).toBeNull();
      expect(Object.keys(none)).toContain('branchAssumed');
    });
  });

  // ==================================================================
  // NON-NEGOTIABLE #7. The one that matters.
  // ==================================================================
  describe('a branch id that is not this salon’s', () => {
    /**
     * THE TENANCY TEST, called directly against the endpoint with a real session
     * rather than through a UI that would never offer the id. `BR-SAL` is a REAL
     * branch — SAL-AMARA's Salmiya — so this is not "an unknown id 404s", it is
     * "a branch that exists somewhere else is invisible from here".
     *
     * 404 AND NOT 403, AND NOT AN EMPTY RESULT. A 403 would confirm the id names a
     * real branch at some other salon, which is the enumeration oracle in
     * miniature. Zero figures would be worse still: it reads as "that branch had
     * no sales", a confident false answer about somebody else's business.
     */
    it('is 404 unknown_branch — not a leak, not a 500, not an empty answer', async () => {
      const res = await get(`?branch=${FOREIGN_BRANCH}`);

      expect(res.statusCode).toBe(404);
      // The CODE is the contract — http/errors.ts. A spec asserting only the
      // status would pass against a handler that had 404'd on the salon instead.
      expect(JSON.parse(res.body).error).toBe('unknown_branch');
      // And nothing about the other salon reaches the wire.
      expect(res.body).not.toContain('Salmiya');
      expect(res.body).not.toContain('SAL-AMARA');
    });

    it('is indistinguishable from a branch id that exists nowhere', async () => {
      const foreign = await get(`?branch=${FOREIGN_BRANCH}`);
      const nonsense = await get('?branch=BR-NO-SUCH-THING');
      expect(nonsense.statusCode).toBe(foreign.statusCode);
      expect(JSON.parse(nonsense.body)).toEqual(JSON.parse(foreign.body));
    });

    it('refuses a non-string branch with 400 invalid_branch', async () => {
      // Repeated in the query string: Fastify hands the handler an array, which a
      // silent `String()` would turn into "BR-LUM-HAW,BR-LUM-JAB" and 404 on a
      // branch nobody named.
      const res = await get('?branch=BR-LUM-HAW&branch=BR-LUM-JAB');
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('invalid_branch');
    });

    it('resolves a branch of this salon, and echoes what was applied', async () => {
      const res = await get(`?branch=${HAWALLY.id}`);
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toMatchObject({
        branchId: HAWALLY.id,
        branchName: HAWALLY.name,
      });
    });
  });

  // ==================================================================
  // THE FILTER ACTUALLY CHANGES THE ANSWER, AND THE ANSWERS RECONCILE.
  // ==================================================================
  describe('the per-branch figures', () => {
    it('splits the visits behind the repeat rate exactly, with no row lost or double-counted', async () => {
      const [all, haw, jab] = await Promise.all([
        metrics(null),
        metrics(HAWALLY),
        metrics(JABRIYA),
      ]);

      // Not merely "the parameter was accepted": three different rates.
      expect(all.repeatRatePercent).toBe(75); // M1,M2,M3 twice; M4 once → 3 of 4
      expect(haw.repeatRatePercent).toBe(50); // M1 twice, M2 once → 1 of 2
      expect(jab.repeatRatePercent).toBe(33); // M3 twice, M2 and M4 once → 1 of 3

      // A CHARGE HAS EXACTLY ONE BRANCH, so visits ARE additive and the two
      // branches must account for every charge in the window. This is the
      // assertion that fails if the filter ever silently drops rows.
      const salonWideCharges = await scalar(sql`
        SELECT count(*)::int AS n FROM "transaction"
         WHERE salon_id = ${SALON} AND kind = 'charge' AND status = 'settled'
           AND created_at >= ${new Date(NOW.getTime() - 30 * 86_400_000).toISOString()}::timestamptz`);

      expect(salonWideCharges).toBe(7);
      expect(haw.branchAssumed!.visitsTotal).toBe(3);
      expect(jab.branchAssumed!.visitsTotal).toBe(4);
      expect(haw.branchAssumed!.visitsTotal + jab.branchAssumed!.visitsTotal).toBe(
        salonWideCharges,
      );
    });

    it('splits the upcoming bookings exactly, and moves the "next at" with them', async () => {
      const [all, haw, jab] = await Promise.all([
        metrics(null),
        metrics(HAWALLY),
        metrics(JABRIYA),
      ]);

      expect(all.upcomingAppointments).toBe(3);
      expect(haw.upcomingAppointments).toBe(1);
      expect(jab.upcomingAppointments).toBe(2);
      expect(haw.upcomingAppointments + jab.upcomingAppointments).toBe(all.upcomingAppointments);

      // The sub-label follows the filter out of the SAME query as the count:
      // Hawally's only booking is the salon's next one, Jabriya's is later.
      expect(all.nextAppointmentAt).toBe('2026-08-29T14:00:00.000Z');
      expect(haw.nextAppointmentAt).toBe('2026-08-29T14:00:00.000Z');
      expect(jab.nextAppointmentAt).toBe('2026-08-29T15:00:00.000Z');
    });

    it('does NOT make activeMembers additive, and that is arithmetic rather than a bug', async () => {
      const [all, haw, jab] = await Promise.all([
        metrics(null),
        metrics(HAWALLY),
        metrics(JABRIYA),
      ]);

      expect(all.activeMembers).toBe(4); // IT-M1..IT-M4
      expect(haw.activeMembers).toBe(2); // IT-M1, IT-M2
      expect(jab.activeMembers).toBe(3); // IT-M2, IT-M3, IT-M4

      /**
       * A DISTINCT COUNT DOES NOT ADD UP, and IT-M2 is the reason: she transacted
       * at both branches, so she is 1 at each and 1 in the salon total. The excess
       * is exactly the number of members active at more than one branch.
       *
       * Pinned deliberately. Anything reconciling a branch breakdown against a
       * salon total will otherwise read the difference as missing revenue, and
       * this is the spec that says it was never revenue at all.
       */
      expect(haw.activeMembers + jab.activeMembers - all.activeMembers).toBe(1);
    });
  });

  // ==================================================================
  // THE HONESTY OF THE ANSWER — the part that is not a filter.
  // ==================================================================
  describe('what the API refuses to state per branch', () => {
    it('returns loadedTodayFils and knetSharePercent as null under a branch, and never zero', async () => {
      const [all, haw, jab] = await Promise.all([
        metrics(null),
        metrics(HAWALLY),
        metrics(JABRIYA),
      ]);

      // Unfiltered, the figures are real and both branches "contributed".
      expect(all.loadedTodayFils).toBe(20_000);
      expect(all.knetSharePercent).toBe(50);

      /**
       * A top-up happens on a phone. `services/topup.ts` writes every one of these
       * rows `branch_assumed = true` and says so in as many words, so there is no
       * per-branch answer to give.
       *
       * NULL, NOT ZERO, and this is the assertion that fails if somebody
       * "simplifies" the skip into an ordinary filter: the naive filter returns
       * 10.000 KD at each branch here — plausible, reconcilable-looking, and a
       * statement about footfall that nothing in the database supports.
       */
      for (const m of [haw, jab]) {
        expect(m.loadedTodayFils).toBeNull();
        expect(m.knetSharePercent).toBeNull();
      }
    });

    it('reports the SIZE of the doubt per branch, not a boolean', async () => {
      const [haw, jab] = await Promise.all([metrics(HAWALLY), metrics(JABRIYA)]);

      /**
       * HAWALLY IS EXACT. Every charge and every booking there recorded its branch,
       * so nothing is qualified — including IT-M1, whose Hawally TOP-UP is assumed:
       * a member with even one recorded row genuinely was there, and taking the
       * positive filter instead of the negative would have put her in both buckets.
       */
      expect(haw.branchAssumed).toEqual({
        activeMembers: 0,
        visits: 0,
        visitsTotal: 3,
        upcomingAppointments: 0,
      });

      /**
       * JABRIYA IS ENTIRELY A GUESS, and says so numerically: all four visits
       * behind its 33%, both of its upcoming appointments, and all three of its
       * active members rest on an inferred branch.
       *
       * `visits === visitsTotal` is the shape a client renders as "based entirely
       * on assumed branches" rather than "approximately". IT-M2 is counted here
       * and NOT at Hawally, which is the asymmetry a boolean could not carry.
       */
      expect(jab.branchAssumed).toEqual({
        activeMembers: 3,
        visits: 4,
        visitsTotal: 4,
        upcomingAppointments: 2,
      });
    });

    it('states no doubt at all when no branch is applied, however many rows are assumed', async () => {
      /**
       * There are seven assumed rows in this fixture and the salon-wide answer is
       * still exact: a row attributed to the wrong branch is still inside the
       * salon. The caveat is created by the filter and must not outlive it.
       */
      const assumed = await scalar(
        sql`SELECT count(*)::int AS n FROM "transaction" WHERE salon_id = ${SALON} AND branch_assumed`,
      );
      expect(assumed).toBeGreaterThan(0);
      expect((await metrics(null)).branchAssumed).toBeNull();
    });
  });
});
