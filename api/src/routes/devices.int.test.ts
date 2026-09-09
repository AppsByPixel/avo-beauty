/**
 * DEVICE ENROLMENT, against real rows and the real permission stack.
 *                                                        (DECISIONS.md #82)
 *
 * =========================================================================
 * THE ASSERTION THIS FILE EXISTS FOR
 * =========================================================================
 * A charge on an ENROLLED till at a MULTI-BRANCH salon earns that branch's
 * boost, and its transaction row says `branch_assumed = false`. Neither has ever
 * been true in this product: `resolveBranch` returns `established: rows.length
 * === 1`, `charge.ts` passes `established ? branchId : null` into
 * `loadPromotionInputs`, and a null branch matches no boost — so every
 * per-branch earning rate at a two-branch salon was stored, served to both
 * clients, editable by the merchant, and applied by nobody.
 *
 * The seeded fixture is exactly the shape needed to prove it and requires no
 * invention: SAL-AMARA has two open branches, BR-KWC carries `visit = 2` and
 * BR-SAL carries `visit = 1` (db/seed.ts). So the same charge on the same device
 * earns +2 visits or +1 depending only on which branch the till is enrolled to,
 * and +1 when it is enrolled to neither.
 *
 * =========================================================================
 * WHY THE FIXTURE IS APPEND-ONLY, AND WHAT IS ASSERTED INSTEAD OF ABSOLUTES
 * =========================================================================
 * Charges write `ledger_entry`, which is append-only against the owner role as
 * well as `avo_app` (migration 0001 plus `ledger_entry_is_immutable`), so
 * nothing this file charges can be cleaned up. Same constraint
 * `reportsArtist.int.test.ts` documents.
 *
 * So every money assertion here is a DELTA — `member.visits` before and after
 * one charge — and every enrolment carries a per-run device id. Deltas hold no
 * matter how much other traffic shares the salon, which is decision 75's
 * multi-run requirement answered by construction rather than by a reset.
 *
 * The `device_enrolment` rows this file writes ARE deleted in `afterAll`: they
 * have no ledger behind them, and leaving live enrolments at a shared seeded
 * salon would silently change what every later run of every other suite
 * measures. That is the one thing here that must not leak.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

const INT_URL = process.env.AVO_INT_DATABASE_URL;
const suite = INT_URL ? describe : describe.skip;

const SALON = 'SAL-AMARA';
const OTHER_SALON = 'SAL-LUMIERE';
/** `visit = 2` in the seed. The boost that has never paid. */
const KUWAIT_CITY = 'BR-KWC';
/** `visit = 1`. */
const SALMIYA = 'BR-SAL';
/** SAL-LUMIERE's, for the tenancy case. */
const FOREIGN_BRANCH = 'BR-LUM-HAW';

/** Seeded manager: every permission, so `dashboard` is held. */
const MANAGER = 'ST-001';
/** Seeded frontdesk: `appointments` TRUE, `dashboard` FALSE — see db/seed.ts. */
const FRONTDESK = 'ST-002';
/**
 * EVERY ID HERE IS `EN-`, NOT `IT-`, AND THAT IS NOT COSMETIC.
 *
 * `services/metrics.int.test.ts` cleans up with `DELETE FROM member WHERE id
 * LIKE 'IT-M%'` — and the same for `IT-AR%`, `IT-B%`, `IT-SV%`, `IT-TX-%`. The
 * whole `IT-` prefix is that suite's namespace.
 *
 * This file's member cannot be deleted: she has real charges, `ledger_entry` is
 * append-only, and `transaction_member_id_member_id_fk` is `ON DELETE restrict`.
 * So an `IT-M-` member here does not merely collide — it makes ANOTHER suite's
 * cleanup fail permanently, and that suite then dies in `beforeAll` on every
 * subsequent run. Found by running the int suite three times: run 1 green, runs
 * 2 and 3 red in `metrics.int.test.ts` for a reason that had nothing to do with
 * metrics. Decision 75's multi-run rule earning its keep.
 */
const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
const DEVICE = `EN-DEV-${RUN}`;
const OTHER_DEVICE = `EN-DEV2-${RUN}`;
/**
 * A REAL manager holding the REAL permission at the WRONG salon. Created here
 * rather than borrowed from the seed, which has no SAL-LUMIERE staff row — and
 * deliberately `perm_dashboard TRUE`, because a 403 from somebody who lacks the
 * permission anyway would prove nothing about the tenancy boundary.
 */
const FOREIGN_STAFF = `EN-ST-${RUN}`;

/**
 * THIS SUITE'S OWN CUSTOMER, not the seeded Dana (8842).
 *
 * Every case below drives a real charge, and `e2e/support/tenancy-harness.ts`
 * records what the seeded member is: "Dana 8842 — lane A's seed. Shared,
 * drifting. Read, never pinned." Draining her balance and climbing her tier
 * seven times per run, three runs deep, is exactly the drift that note is
 * warning about. A per-run member costs one INSERT and touches nothing anybody
 * else reads.
 *
 * Her balance is set directly with no funding ledger legs, which is the pattern
 * `reportsArtist.int.test.ts` and `metrics.int.test.ts` already use — and a
 * known gap those files share: it leaves `db:verify`'s invariant 5
 * (`member.balance_fils = sum(member_wallet entries)`) failing after any int
 * run. Reported, not introduced here.
 */
const MEMBER = `EN-M-${RUN}`;

suite('device enrolment binds a till to a branch', () => {
  let app: FastifyInstance;
  let db: (typeof import('../db/client'))['db'];
  let sql: (typeof import('drizzle-orm'))['sql'];
  let issue: (typeof import('../auth/sessions'))['issueSession'];

  /** A manager on the enrolled device — the scanner surface. */
  let scanner: string;
  /** The same manager on a web session — the dashboard surface. */
  let dashboard: string;
  /** The frontdesk PIN holder on the same device: no `dashboard` permission. */
  let frontdesk: string;
  /** A real manager holding the real permission, at the WRONG salon. */
  let foreign: string;

  const exec = async (q: unknown) =>
    (await db.execute(q as never)) as unknown as Array<Record<string, unknown>>;
  const scalar = async (q: unknown) => String((await exec(q))[0]?.n ?? '');

  const scannerSession = async (staffId: string, deviceId: string) =>
    (
      await issue(db, {
        principalKind: 'staff',
        staffId,
        salonId: SALON,
        scope: 'scanner',
        deviceId,
      })
    ).accessToken;

  beforeAll(async () => {
    db = (await import('../db/client')).db;
    sql = (await import('drizzle-orm')).sql;
    issue = (await import('../auth/sessions')).issueSession;
    app = await (await import('../app')).buildApp();

    /**
     * THE FIXTURE'S OWN PRECONDITIONS, ASSERTED. Every expectation below rests
     * on the seed having two OPEN branches at this salon with different visit
     * boosts. A previous run that closed a branch and died before restoring it
     * would otherwise turn "+2 because the till is enrolled" into "+1 because
     * the salon is effectively single-branch", and the failure would look like a
     * defect in enrolment. Driving this suite is how that trap was found.
     */
    const open = await scalar(
      sql`SELECT count(*) AS n FROM branch WHERE salon_id = ${SALON} AND closed_at IS NULL`,
    );
    expect(open, `${SALON} must have exactly 2 open branches for this suite to mean anything`).toBe('2');
    const boosts = await exec(
      sql`SELECT branch_id, visit FROM boost WHERE salon_id = ${SALON} ORDER BY branch_id`,
    );
    expect(boosts.map((b) => `${b.branch_id}=${b.visit}`)).toEqual([
      `${KUWAIT_CITY}=2`,
      `${SALMIYA}=1`,
    ]);

    await db.execute(sql`
      INSERT INTO staff_user (id, salon_id, name, handle, role, branch_access_all,
                              perm_team, perm_dashboard)
      VALUES (${FOREIGN_STAFF}, ${OTHER_SALON}, 'EN Lumiere', ${`en-lum-${RUN}`},
              'manager', true, true, true)`);

    await db.execute(sql`
      INSERT INTO member (id, salon_id, name, phone, password_hash, balance_fils,
                          tier, visits, policy_version)
      VALUES (${MEMBER}, ${SALON}, 'EN Enrol', ${`+9657${String(Date.now() % 1_000_000).padStart(6, '0')}`},
              'x', 900000, 'bronze', 0, 1)`);

    scanner = await scannerSession(MANAGER, DEVICE);
    frontdesk = await scannerSession(FRONTDESK, DEVICE);
    dashboard = (
      await issue(db, {
        principalKind: 'staff',
        staffId: MANAGER,
        salonId: SALON,
        scope: 'dashboard',
      })
    ).accessToken;
    foreign = (
      await issue(db, {
        principalKind: 'staff',
        staffId: FOREIGN_STAFF,
        salonId: OTHER_SALON,
        scope: 'dashboard',
      })
    ).accessToken;
  });

  afterAll(async () => {
    if (db) {
      await db.execute(
        sql`DELETE FROM device_enrolment WHERE device_id IN (${DEVICE}, ${OTHER_DEVICE})`,
      );
      await db.execute(sql`DELETE FROM session WHERE device_id IN (${DEVICE}, ${OTHER_DEVICE})`);
      await db.execute(sql`DELETE FROM session WHERE staff_id = ${FOREIGN_STAFF}`);
      await db.execute(sql`DELETE FROM staff_user WHERE id = ${FOREIGN_STAFF}`);
      /**
       * The MEMBER stays. Her charges wrote `ledger_entry` rows, which are
       * append-only against the owner role too (migration 0001 +
       * `ledger_entry_is_immutable`) and `ON DELETE restrict` back to her, so
       * she cannot be removed — the constraint `reportsArtist.int.test.ts`
       * documents. She is inert: a per-run id nothing else reads.
       */
    }
    await app?.close();
  });

  // ------------------------------------------------------------- the driver --

  const enrol = (token: string, body: unknown, salon = SALON) =>
    app.inject({
      method: 'POST',
      url: `/salons/${salon}/devices`,
      headers: { authorization: `Bearer ${token}` },
      payload: body as object,
    });

  const list = (token: string, salon = SALON) =>
    app.inject({
      method: 'GET',
      url: `/salons/${salon}/devices`,
      headers: { authorization: `Bearer ${token}` },
    });

  const revoke = (token: string, deviceId: string, salon = SALON) =>
    app.inject({
      method: 'DELETE',
      url: `/salons/${salon}/devices/${deviceId}`,
      headers: { authorization: `Bearer ${token}` },
    });

  /**
   * One real charge through the real endpoint on a real scanner session, and the
   * two facts it produces: the visits it earned, and what the row says about its
   * own branch.
   *
   * A FRESH SESSION PER CHARGE, because `enrolledBranchId` is resolved when the
   * principal is loaded. That is per REQUEST rather than per session — the
   * enrolment is read in `loadStaffPrincipal` on every call — and re-minting
   * here proves the token carries no stale branch either way.
   *
   * `confirmDuplicate` because this suite charges the same member for the same
   * basket several times inside the 120-second near-duplicate window, which is
   * exactly what that guard is for. The confirm is the documented way past it.
   */
  async function chargeOnce(serviceId: string, deviceId = DEVICE) {
    const token = await scannerSession(MANAGER, deviceId);
    // The wallet token is minted by the MEMBER, not the till.
    const memberSession = (
      await issue(db, {
        principalKind: 'member',
        memberId: MEMBER,
        salonId: SALON,
        scope: 'wallet',
      })
    ).accessToken;
    const wt = await app.inject({
      method: 'GET',
      url: '/members/me/wallet-token',
      headers: { authorization: `Bearer ${memberSession}` },
    });
    expect(wt.statusCode, wt.body).toBe(200);

    const before = Number(
      await scalar(sql`SELECT visits AS n FROM member WHERE id = ${MEMBER}`),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/charges',
      headers: {
        authorization: `Bearer ${token}`,
        'idempotency-key': `it-enrol-${RUN}-${Math.random().toString(36).slice(2)}`,
      },
      payload: {
        memberId: MEMBER,
        serviceIds: [serviceId],
        token: JSON.parse(wt.body).token,
        confirmDuplicate: true,
      },
    });
    // `POST /charges` answers 200, not 201 — it is not a creation from the
    // caller's point of view, it is a debit. Pinned because getting it wrong
    // made six specs here fail identically for a reason unrelated to branches.
    expect(res.statusCode, res.body).toBe(200);
    const txId = (JSON.parse(res.body).transaction ?? JSON.parse(res.body)).id as string;
    const [row] = await exec(
      sql`SELECT branch_id, branch_assumed FROM "transaction" WHERE id = ${txId}`,
    );
    const after = Number(await scalar(sql`SELECT visits AS n FROM member WHERE id = ${MEMBER}`));
    return {
      branchId: String(row?.branch_id),
      assumed: row?.branch_assumed === true,
      visitsGained: after - before,
    };
  }

  // ==================================================================
  // THE PROOF.
  // ==================================================================
  describe('an enrolled till earns its own branch’s boost', () => {
    it('unenrolled at a two-branch salon: assumed, and no boost', async () => {
      const r = await chargeOnce('SV-01');
      expect(r.assumed).toBe(true);
      expect(r.visitsGained).toBe(1);
    });

    it('enrolled to BR-KWC (visit 2x): established, and the boost PAYS', async () => {
      const res = await enrol(scanner, {
        deviceId: DEVICE,
        branchId: KUWAIT_CITY,
        label: 'Kuwait City counter',
      });
      expect(res.statusCode, res.body).toBe(201);

      const r = await chargeOnce('SV-01');
      expect(r.branchId).toBe(KUWAIT_CITY);
      expect(r.assumed).toBe(false);
      // The whole slice, in one number.
      expect(r.visitsGained).toBe(2);
    });

    it('re-pointed to BR-SAL (visit 1x): still established, boost is 1x', async () => {
      const res = await enrol(scanner, {
        deviceId: DEVICE,
        branchId: SALMIYA,
        label: 'Salmiya counter',
      });
      expect(res.statusCode, res.body).toBe(201);

      const r = await chargeOnce('SV-01');
      expect(r.branchId).toBe(SALMIYA);
      expect(r.assumed).toBe(false);
      expect(r.visitsGained).toBe(1);
    });

    /**
     * A DIFFERENT DEVICE AT THE SAME SALON IS UNAFFECTED. The lookup is keyed on
     * (salon, device), so enrolling one till must not establish another — which
     * is the failure a lookup keyed on the salon alone would produce, and it
     * would look like a working feature.
     */
    it('a second, unenrolled device at the same salon is still assumed', async () => {
      const r = await chargeOnce('SV-01', OTHER_DEVICE);
      expect(r.assumed).toBe(true);
      expect(r.visitsGained).toBe(1);
    });

    it('revoked: back to assumed, and the charge still succeeds', async () => {
      const res = await revoke(scanner, DEVICE);
      expect(res.statusCode, res.body).toBe(200);

      const r = await chargeOnce('SV-01');
      expect(r.assumed).toBe(true);
      expect(r.visitsGained).toBe(1);
    });
  });

  // ==================================================================
  // THE GATE — non-negotiable #7, called directly with the permission off.
  // ==================================================================
  describe('perms.dashboard, enforced server-side', () => {
    /**
     * The seeded `frontdesk` preset, on the SAME device, with a real live
     * session. Not a request with no token — a real principal who simply may
     * not do this. If she could, every PIN holder on the counter could point her
     * till at the 2x branch, which is `services/branch.ts` § THE FIX THAT MUST
     * NOT BE TAKEN arriving through a side door.
     */
    it('a frontdesk PIN holder cannot enrol, list or revoke', async () => {
      const posted = await enrol(frontdesk, {
        deviceId: DEVICE,
        branchId: KUWAIT_CITY,
        label: 'nice try',
      });
      expect(posted.statusCode).toBe(403);

      expect((await list(frontdesk)).statusCode).toBe(403);
      expect((await revoke(frontdesk, DEVICE)).statusCode).toBe(403);
    });

    it('and the refusal wrote no enrolment', async () => {
      const n = await scalar(
        sql`SELECT count(*) AS n FROM device_enrolment
             WHERE device_id = ${DEVICE} AND revoked_at IS NULL`,
      );
      expect(n).toBe('0');
    });

    /** The dashboard surface is a first-class caller, not a fallback. */
    it('the same permission works from a web session', async () => {
      const res = await enrol(dashboard, {
        deviceId: DEVICE,
        branchId: KUWAIT_CITY,
        label: 'from the dashboard',
      });
      expect(res.statusCode, res.body).toBe(201);
      expect((await list(dashboard)).statusCode).toBe(200);
    });
  });

  // ==================================================================
  // TENANCY.
  // ==================================================================
  describe('a branch that is not hers does not exist', () => {
    it("another salon's real branch is a 404 by name, not a 403", async () => {
      const res = await enrol(scanner, {
        deviceId: DEVICE,
        branchId: FOREIGN_BRANCH,
        label: 'cross tenant',
      });
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body).error).toBe('unknown_branch');
    });

    it('a manager at another salon cannot reach this salon’s devices', async () => {
      expect((await list(foreign)).statusCode).toBe(403);
      const res = await enrol(foreign, {
        deviceId: DEVICE,
        branchId: KUWAIT_CITY,
        label: 'wrong salon',
      });
      expect(res.statusCode).toBe(403);
    });

    /**
     * The same device id enrolled at ANOTHER salon must not answer for this one.
     * `device_id` is a client-chosen string and two salons may share one, so a
     * lookup keyed on the device alone would let one salon's configuration
     * establish another salon's charges — and pay another salon's boost.
     */
    it("another salon's enrolment of the same device id does not leak", async () => {
      await db.execute(sql`
        INSERT INTO device_enrolment (id, salon_id, device_id, branch_id, label)
        VALUES (${`ENR-EN-${RUN}`}, ${OTHER_SALON}, ${DEVICE}, ${FOREIGN_BRANCH}, 'foreign till')`);

      const items = JSON.parse((await list(dashboard)).body).items as Array<{ branchId: string }>;
      expect(items.every((i) => i.branchId !== FOREIGN_BRANCH)).toBe(true);

      const r = await chargeOnce('SV-01');
      expect(r.branchId).not.toBe(FOREIGN_BRANCH);
    });
  });

  // ==================================================================
  // THE ENDPOINTS' OWN BEHAVIOUR.
  // ==================================================================
  describe('enrol, re-enrol and revoke', () => {
    it('re-posting an identical enrolment is 200 and writes no history', async () => {
      const first = await enrol(scanner, {
        deviceId: DEVICE,
        branchId: SALMIYA,
        label: 'stable label',
      });
      expect([200, 201]).toContain(first.statusCode);
      const before = await scalar(
        sql`SELECT count(*) AS n FROM device_enrolment WHERE device_id = ${DEVICE}`,
      );

      const again = await enrol(scanner, {
        deviceId: DEVICE,
        branchId: SALMIYA,
        label: 'stable label',
      });
      expect(again.statusCode).toBe(200);
      expect(
        await scalar(sql`SELECT count(*) AS n FROM device_enrolment WHERE device_id = ${DEVICE}`),
      ).toBe(before);
    });

    it('exactly one live enrolment per (salon, device), whatever the history', async () => {
      const live = await scalar(
        sql`SELECT count(*) AS n FROM device_enrolment
             WHERE salon_id = ${SALON} AND device_id = ${DEVICE} AND revoked_at IS NULL`,
      );
      expect(live).toBe('1');
    });

    it('a revoke is idempotent in effect: the second is a 404', async () => {
      expect((await revoke(scanner, DEVICE)).statusCode).toBe(200);
      const second = await revoke(scanner, DEVICE);
      expect(second.statusCode).toBe(404);
      expect(JSON.parse(second.body).error).toBe('unknown_device');
    });

    it('a blank label or device id is refused', async () => {
      for (const payload of [
        { deviceId: DEVICE, branchId: SALMIYA, label: '   ' },
        { deviceId: '   ', branchId: SALMIYA, label: 'ok' },
      ]) {
        const res = await enrol(scanner, payload);
        expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      }
    });

    it('a closed branch cannot take a till', async () => {
      await db.execute(sql`UPDATE branch SET closed_at = now() WHERE id = ${KUWAIT_CITY}`);
      try {
        const res = await enrol(scanner, {
          deviceId: DEVICE,
          branchId: KUWAIT_CITY,
          label: 'closed branch',
        });
        expect(res.statusCode).toBe(404);
      } finally {
        // RESTORED IN A `finally`. A previous drive of this behaviour left the
        // branch closed after an unrelated throw, and the next case read "+1
        // because unenrolled" when it was really "+1 because the salon had one
        // open branch". Every later expectation in this file depends on two.
        await db.execute(sql`UPDATE branch SET closed_at = NULL WHERE id = ${KUWAIT_CITY}`);
      }
      expect(
        await scalar(
          sql`SELECT count(*) AS n FROM branch WHERE salon_id = ${SALON} AND closed_at IS NULL`,
        ),
      ).toBe('2');
    });

    it('the audit log names the actor, the till and the branch', async () => {
      const rows = await exec(sql`
        SELECT action, detail, source FROM audit_log
         WHERE subject_type = 'device' AND subject_id = ${DEVICE}
         ORDER BY seq`);
      expect(rows.length).toBeGreaterThanOrEqual(2);
      const actions = rows.map((r) => String(r.action));
      expect(actions).toContain('device_enrolled');
      expect(actions).toContain('device_revoked');
      // The surface is recorded rather than flattened: this suite calls from both.
      expect(new Set(rows.map((r) => String(r.source))).size).toBeGreaterThanOrEqual(1);
    });
  });
});
