/**
 * STAFF PHONE PAIRING AND PHONE SIGN-IN, against real rows and the real handlers.
 * Aftab, 2026-11-10 (DECISIONS.md § Staff phone pairing, phone sign-in, and a
 * truthful receipt line); migration 0073.
 *
 * What a pure spec cannot hold and this file does:
 *
 *   - the code is stored as HASHES and nothing else (a row assertion);
 *   - a redeem binds the PIN to a SERVER-ISSUED device, clears the lock, revokes
 *     her scanner sessions and not her web one, and enrols the till — all in one
 *     transaction (row assertions on four tables);
 *   - every refusal is ONE status and ONE body, whatever the cause;
 *   - two racing redeems of one code produce exactly one session;
 *   - five wrong digits void a code, and the budget sits in front;
 *   - the number is a sign-in name on both the scanner and the dashboard.
 *
 * MULTI-RUN SAFE BY CONSTRUCTION (decision 75): every staff member, phone number,
 * device and client address here is minted per run. Addresses matter because
 * `avo_app` cannot DELETE `sign_in_attempt` (migration 0039), so a bucket this
 * file spends stays spent for the hour — a fixed address would be refused on
 * the third run. Rows this file creates are deleted in `afterAll`, except
 * `audit_log` (append-only, by design) and `sign_in_attempt` (see above).
 */

import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  STAFF_PAIRING_TTL_MINUTES,
  StaffPairResponseSchema,
  StaffPairingCodeSchema,
  StaffUserSchema,
} from '@avo/types';

const INT_URL = process.env.AVO_INT_DATABASE_URL;
const suite = INT_URL ? describe : describe.skip;

const SALON = 'SAL-AMARA';
const OTHER_SALON = 'SAL-LUMIERE';
const SALMIYA = 'BR-SAL';
const KUWAIT_CITY = 'BR-KWC';
const FOREIGN_BRANCH = 'BR-LUM-HAW';
/** Seeded manager: every permission. Issues the codes. */
const MANAGER = 'ST-001';
/** Seeded frontdesk: no `team`. */
const FRONTDESK = 'ST-002';

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
const octet = () => Math.floor(Math.random() * 250) + 1;
/** A per-run client address, so the per-address budget starts empty. */
const IP = `10.${octet()}.${octet()}.${octet()}`;
/** Eight random digits starting with 5 — a Kuwait mobile nobody seeded. */
const localNumber = () => `5${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;

const PAIRED = `PR-ST-A-${RUN}`;
const SECOND = `PR-ST-B-${RUN}`;
const LEAVER = `PR-ST-C-${RUN}`;
const WEBBY = `PR-ST-D-${RUN}`;
const TEAM_NO_DASH = `PR-ST-E-${RUN}`;
const FOREIGN_STAFF = `PR-ST-F-${RUN}`;
/** Re-pairs twice: her first `PH-` till must be unenrolled by the second pair. */
const REPAIRED = `PR-ST-G-${RUN}`;
/** Holds her PIN on a TYPED till the counter shares; a re-pair must leave it enrolled. */
const TILL_USER = `PR-ST-H-${RUN}`;
const OLD_DEVICE = `PR-DEV-OLD-${RUN}`;
/** A typed till id, the `DEV-SCANNER-01` shape — never server-issued. */
const SHARED_TILL = `DEV-PR-TILL-${RUN}`;
/**
 * Every device id the re-pair specs create, deleted by id in `afterAll` — so the
 * cleanup does not depend on the behaviour under test. A route that FAILED to
 * revoke would otherwise leave a live till behind under a staff id that no
 * longer points at it.
 */
const REPAIR_DEVICES: string[] = [SHARED_TILL];
/** A manager re-issues while her phone redeems the earlier code (phase 2 deadlock). */
const RACER = `PR-ST-I-${RUN}`;
/** Holds a live code when she is deactivated, then is re-hired through a reset link. */
const CODE_LEAVER = `PR-ST-J-${RUN}`;
const CODE_LEAVER_PHONE_LOCAL = localNumber();
/** Pairs a `PH-` till, then is deactivated: the till must go with her. */
const PHONE_LEAVER = `PR-ST-K-${RUN}`;
/** Holds her PIN on a TYPED till, then is deactivated: the till must stay. */
const TILL_LEAVER = `PR-ST-L-${RUN}`;
const LEAVER_TILL = `DEV-PR-LEAVE-${RUN}`;
REPAIR_DEVICES.push(LEAVER_TILL);
const PAIRED_PHONE_LOCAL = localNumber();
const PAIRED_PHONE = `+965${PAIRED_PHONE_LOCAL}`;
const SECOND_PHONE = `+965${localNumber()}`;
const WEB_PHONE_LOCAL = localNumber();
const WEB_PASSWORD = 'a-real-password-for-this-test';

const REFUSAL = {
  error: 'pairing_refused',
  message: 'That code did not work. Ask a manager for a new one.',
};

suite('staff phone pairing', () => {
  let app: FastifyInstance;
  let db: (typeof import('../db/client'))['db'];
  let sql: (typeof import('drizzle-orm'))['sql'];
  let issue: (typeof import('../auth/sessions'))['issueSession'];

  let manager: string;
  let frontdesk: string;
  let teamNoDash: string;
  let foreign: string;
  /** PAIRED's own web session — must survive her pairing. */
  let pairedWeb: string;
  /** PAIRED's scanner session on the old device — must not. */
  let pairedOldScannerSid: string;

  const exec = async (q: unknown) =>
    (await db.execute(q as never)) as unknown as Array<Record<string, unknown>>;

  const dashboardSession = async (staffId: string, salonId = SALON) =>
    (await issue(db, { principalKind: 'staff', staffId, salonId, scope: 'dashboard' })).accessToken;

  const post = (url: string, payload: unknown, token?: string, remoteAddress = IP) =>
    app.inject({
      method: 'POST',
      url,
      payload: payload as Record<string, unknown>,
      remoteAddress,
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });

  const issueCode = async (staffId: string, body: Record<string, unknown> = {}, token = manager) => {
    const res = await post(`/staff/${staffId}/pairing-code`, body, token);
    expect(res.statusCode, res.body).toBe(201);
    return StaffPairingCodeSchema.parse(res.json());
  };

  beforeAll(async () => {
    db = (await import('../db/client')).db;
    sql = (await import('drizzle-orm')).sql;
    issue = (await import('../auth/sessions')).issueSession;
    const { hashSecret } = await import('../auth/password');
    app = await (await import('../app')).buildApp();

    const pw = await hashSecret(WEB_PASSWORD);
    const pinHash = await hashSecret('9999');
    await db.execute(sql`
      INSERT INTO staff_user (id, salon_id, name, handle, phone, role, perm_scanner,
                              pin_hash, pin_device_id, pin_failed_attempts, pin_locked_until)
      VALUES (${PAIRED}, ${SALON}, 'PR Paired', ${`pr-a-${RUN}`}, ${PAIRED_PHONE}, 'artist', true,
              ${pinHash}, ${OLD_DEVICE}, 4, now() + interval '1 hour')`);
    await db.execute(sql`
      INSERT INTO staff_user (id, salon_id, name, handle, phone, role, perm_scanner)
      VALUES (${SECOND}, ${SALON}, 'PR Second', ${`pr-b-${RUN}`}, ${SECOND_PHONE}, 'artist', true)`);
    await db.execute(sql`
      INSERT INTO staff_user (id, salon_id, name, handle, role)
      VALUES (${LEAVER}, ${SALON}, 'PR Leaver', ${`pr-c-${RUN}`}, 'artist')`);
    await db.execute(sql`
      INSERT INTO staff_user (id, salon_id, name, handle, phone, role, password_hash, perm_dashboard)
      VALUES (${WEBBY}, ${SALON}, 'PR Web', ${`pr-d-${RUN}`}, ${`+965${WEB_PHONE_LOCAL}`},
              'manager', ${pw}, true)`);
    await db.execute(sql`
      INSERT INTO staff_user (id, salon_id, name, handle, role, perm_team, perm_dashboard)
      VALUES (${TEAM_NO_DASH}, ${SALON}, 'PR Team', ${`pr-e-${RUN}`}, 'manager', true, false)`);
    await db.execute(sql`
      INSERT INTO staff_user (id, salon_id, name, handle, role, perm_team, perm_dashboard)
      VALUES (${FOREIGN_STAFF}, ${OTHER_SALON}, 'PR Lumiere', ${`pr-f-${RUN}`}, 'manager', true, true)`);
    await db.execute(sql`
      INSERT INTO staff_user (id, salon_id, name, handle, role, perm_scanner)
      VALUES (${REPAIRED}, ${SALON}, 'PR Repaired', ${`pr-j-${RUN}`}, 'artist', true)`);
    await db.execute(sql`
      INSERT INTO staff_user (id, salon_id, name, handle, role, perm_scanner, pin_hash, pin_device_id)
      VALUES (${TILL_USER}, ${SALON}, 'PR Till', ${`pr-k-${RUN}`}, 'artist', true, ${pinHash}, ${SHARED_TILL})`);
    await db.execute(sql`
      INSERT INTO staff_user (id, salon_id, name, handle, role, perm_scanner)
      VALUES (${RACER}, ${SALON}, 'PR Racer', ${`pr-l-${RUN}`}, 'artist', true)`);
    await db.execute(sql`
      INSERT INTO staff_user (id, salon_id, name, handle, phone, role, perm_scanner)
      VALUES (${CODE_LEAVER}, ${SALON}, 'PR Code Leaver', ${`pr-m-${RUN}`}, ${`+965${CODE_LEAVER_PHONE_LOCAL}`},
              'artist', true)`);
    await db.execute(sql`
      INSERT INTO staff_user (id, salon_id, name, handle, role, perm_scanner)
      VALUES (${PHONE_LEAVER}, ${SALON}, 'PR Phone Leaver', ${`pr-n-${RUN}`}, 'artist', true)`);
    await db.execute(sql`
      INSERT INTO staff_user (id, salon_id, name, handle, role, perm_scanner, pin_hash, pin_device_id)
      VALUES (${TILL_LEAVER}, ${SALON}, 'PR Till Leaver', ${`pr-o-${RUN}`}, 'artist', true, ${pinHash}, ${LEAVER_TILL})`);

    manager = await dashboardSession(MANAGER);
    frontdesk = await dashboardSession(FRONTDESK);
    teamNoDash = await dashboardSession(TEAM_NO_DASH);
    foreign = await dashboardSession(FOREIGN_STAFF, OTHER_SALON);
    pairedWeb = await dashboardSession(PAIRED);
    pairedOldScannerSid = (
      await issue(db, {
        principalKind: 'staff',
        staffId: PAIRED,
        salonId: SALON,
        scope: 'scanner',
        deviceId: OLD_DEVICE,
      })
    ).sessionId;
  });

  afterAll(async () => {
    if (db) {
      const ids = [
        PAIRED, SECOND, LEAVER, WEBBY, TEAM_NO_DASH, FOREIGN_STAFF, REPAIRED, TILL_USER,
        RACER, CODE_LEAVER, PHONE_LEAVER, TILL_LEAVER,
      ];
      for (const id of ids) {
        await db.execute(sql`DELETE FROM device_enrolment WHERE device_id IN
                               (SELECT pin_device_id FROM staff_user WHERE id = ${id})`);
        // A re-pair leaves her EARLIER phone's row behind as revoked history,
        // naming her as the revoker — and that FK would keep her row alive.
        await db.execute(sql`DELETE FROM device_enrolment WHERE revoked_by_staff_id = ${id}`);
      }
      for (const deviceId of REPAIR_DEVICES) {
        await db.execute(sql`DELETE FROM device_enrolment WHERE salon_id = ${SALON} AND device_id = ${deviceId}`);
      }
      for (const id of ids) {
        await db.execute(sql`DELETE FROM session WHERE staff_id = ${id}`);
        await db.execute(sql`DELETE FROM staff_pairing_code WHERE staff_id = ${id} OR created_by = ${id}`);
      }
      for (const id of ids) {
        try {
          await db.execute(sql`DELETE FROM staff_user WHERE id = ${id}`);
        } catch {
          /**
           * `pin_attempt` is append-only for `avo_app` (migration 0040) and
           * references her, so a staff member who attempted a PIN here cannot be
           * removed — the constraint `devices.int.test.ts` meets with its member.
           * She is left INERT instead: deactivated, holding no credential and no
           * number, under a per-run id nothing else reads.
           */
          await db.execute(sql`
            UPDATE staff_user
               SET deactivated_at = now(), password_hash = NULL, pin_hash = NULL,
                   pin_device_id = NULL, phone = NULL
             WHERE id = ${id}`);
        }
      }
    }
    await app?.close();
  });

  // ================================================================ issuance ==
  describe('POST /staff/:id/pairing-code', () => {
    /** Non-negotiable #7: a refusal is only a control if nothing happened. */
    const codesFor = async (staffId: string) =>
      Number((await exec(sql`SELECT count(*)::int AS n FROM staff_pairing_code WHERE staff_id = ${staffId}`))[0]!.n);

    it('refuses a caller without perms.team before reading anything, and writes nothing', async () => {
      const before = await codesFor(PAIRED);
      const res = await post(`/staff/${PAIRED}/pairing-code`, {}, frontdesk);
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe('forbidden');
      expect(await codesFor(PAIRED)).toBe(before);
    });

    it('refuses a PIN session even when it holds perms.team — a PIN never reaches the dashboard', async () => {
      // ST-001 holds every permission; on the SCANNER surface that is not enough.
      const pinSession = (
        await issue(db, {
          principalKind: 'staff',
          staffId: MANAGER,
          salonId: SALON,
          scope: 'scanner',
          deviceId: `PR-DEV-PIN-${RUN}`,
        })
      ).accessToken;
      const before = await codesFor(PAIRED);
      const res = await post(`/staff/${PAIRED}/pairing-code`, {}, pinSession);
      expect(res.statusCode).toBe(403);
      expect(await codesFor(PAIRED)).toBe(before);
      await db.execute(sql`DELETE FROM session WHERE device_id = ${`PR-DEV-PIN-${RUN}`}`);
    });

    it('refuses a branch to a caller holding team but not dashboard', async () => {
      const before = await codesFor(PAIRED);
      const res = await post(`/staff/${PAIRED}/pairing-code`, { branchId: SALMIYA }, teamNoDash);
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe('forbidden');
      expect(await codesFor(PAIRED)).toBe(before);
      // The same caller without a branch is allowed: team is the authority.
      const ok = await post(`/staff/${SECOND}/pairing-code`, {}, teamNoDash);
      expect(ok.statusCode).toBe(201);
    });

    it('answers 404 for a staff member of another salon', async () => {
      const res = await post(`/staff/${PAIRED}/pairing-code`, {}, foreign);
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe('unknown_staff');
    });

    it('answers 404 for a branch of another salon', async () => {
      const res = await post(`/staff/${PAIRED}/pairing-code`, { branchId: FOREIGN_BRANCH }, manager);
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe('unknown_branch');
    });

    it('refuses a PIN in the body — the PIN is chosen on the phone', async () => {
      const res = await post(`/staff/${PAIRED}/pairing-code`, { pin: '1234' }, manager);
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('not_settable_here');
    });

    it('returns the contract shape once and stores only hashes', async () => {
      const before = Date.now();
      const code = await issueCode(SECOND);
      expect(code.staffId).toBe(SECOND);
      expect(code.branchId).toBeNull();
      const ttl = new Date(code.expiresAt).getTime() - before;
      expect(ttl).toBeGreaterThan((STAFF_PAIRING_TTL_MINUTES - 1) * 60_000);
      expect(ttl).toBeLessThanOrEqual(STAFF_PAIRING_TTL_MINUTES * 60_000 + 5_000);

      const [row] = await exec(sql`
        SELECT * FROM staff_pairing_code
         WHERE staff_id = ${SECOND} AND used_at IS NULL AND voided_at IS NULL`);
      expect(row!.token_hash).toBe(createHash('sha256').update(code.token).digest('hex'));
      expect(String(row!.code_hash)).toMatch(/^\$argon2id\$/);
      expect(row!.created_by).toBe(MANAGER);
      const flat = JSON.stringify(row);
      expect(flat).not.toContain(code.token);
      expect(flat).not.toContain(`"${code.code}"`);

      const audits = await exec(sql`
        SELECT detail, metadata::text AS metadata FROM audit_log
         WHERE subject_id = ${SECOND} AND action = 'Pairing code issued'`);
      expect(audits.length).toBeGreaterThan(0);
      for (const a of audits) {
        expect(`${a.detail}${a.metadata}`).not.toContain(code.token);
        expect(`${a.detail}${a.metadata}`).not.toContain(code.code);
      }
    });

    it('voids the earlier unused code when a new one is issued', async () => {
      const first = await issueCode(SECOND);
      const second = await issueCode(SECOND);
      const stale = await post('/staff/pair', { token: first.token, pin: '1111' });
      expect(stale.statusCode).toBe(400);
      expect(stale.json()).toEqual(REFUSAL);
      const [n] = await exec(sql`
        SELECT count(*)::int AS n FROM staff_pairing_code
         WHERE staff_id = ${SECOND} AND used_at IS NULL AND voided_at IS NULL`);
      expect(n!.n).toBe(1);
      expect(second.token).not.toBe(first.token);
    });

    it('refuses a deactivated target with 409 staff_deactivated', async () => {
      await db.execute(sql`UPDATE staff_user SET deactivated_at = now() WHERE id = ${LEAVER}`);
      const res = await post(`/staff/${LEAVER}/pairing-code`, {}, manager);
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('staff_deactivated');
    });
  });

  // ================================================================= redeem ==
  describe('POST /staff/pair', () => {
    it('refuses a PIN that is not four digits before anything else', async () => {
      const res = await post('/staff/pair', { token: 'x'.repeat(40), pin: '12' });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('invalid_pin_format');
    });

    it('pairs by QR token: device bound, lock cleared, scanner sessions revoked, web kept', async () => {
      const code = await issueCode(PAIRED, { branchId: SALMIYA });
      const res = await post('/staff/pair', { token: code.token, pin: '4321' });
      expect(res.statusCode, res.body).toBe(200);
      const body = StaffPairResponseSchema.parse(res.json());
      expect(body.salonId).toBe(SALON);
      expect(body.staff.id).toBe(PAIRED);
      expect(body.staff.phone).toBe(PAIRED_PHONE);
      expect(body.deviceId).not.toBe(OLD_DEVICE);
      expect(JSON.stringify(body)).not.toMatch(/pinHash|passwordHash|4321/);

      const [staff] = await exec(sql`
        SELECT pin_device_id, pin_hash, pin_failed_attempts, pin_locked_until
          FROM staff_user WHERE id = ${PAIRED}`);
      expect(staff!.pin_device_id).toBe(body.deviceId);
      expect(String(staff!.pin_hash)).toMatch(/^\$argon2id\$/);
      expect(staff!.pin_failed_attempts).toBe(0);
      expect(staff!.pin_locked_until).toBeNull();

      const [claimed] = await exec(sql`
        SELECT used_at FROM staff_pairing_code WHERE token_hash = ${createHash('sha256').update(code.token).digest('hex')}`);
      expect(claimed!.used_at).not.toBeNull();

      const [old] = await exec(sql`SELECT revoked_at, revoked_reason FROM session WHERE id = ${pairedOldScannerSid}`);
      expect(old!.revoked_at).not.toBeNull();
      expect(old!.revoked_reason).toBe('phone_paired');
      const me = await app.inject({
        method: 'GET',
        url: '/staff/me',
        headers: { authorization: `Bearer ${pairedWeb}` },
      });
      expect(me.statusCode, 'her web session is not about which phone holds her PIN').toBe(200);

      const [enrol] = await exec(sql`
        SELECT branch_id, enrolled_by_staff_id FROM device_enrolment
         WHERE salon_id = ${SALON} AND device_id = ${body.deviceId} AND revoked_at IS NULL`);
      expect(enrol!.branch_id).toBe(SALMIYA);
      expect(enrol!.enrolled_by_staff_id).toBe(MANAGER);

      // The minted session is a scanner session on the new device.
      const viaNew = await app.inject({
        method: 'GET',
        url: '/staff/me',
        headers: { authorization: `Bearer ${body.accessToken}` },
      });
      expect(viaNew.statusCode).toBe(200);
      expect(StaffUserSchema.parse(viaNew.json()).id).toBe(PAIRED);
      const [sess] = await exec(sql`
        SELECT scope, device_id FROM session
         WHERE staff_id = ${PAIRED} AND revoked_at IS NULL AND scope = 'scanner'`);
      expect(sess).toMatchObject({ scope: 'scanner', device_id: body.deviceId });

      // The new PIN works from the new device, by handle and by number, and not from the old one.
      const byHandle = await post('/staff/session', {
        salonId: SALON, deviceId: body.deviceId, handle: `pr-a-${RUN}`, pin: '4321',
      });
      expect(byHandle.statusCode).toBe(200);
      const byPhone = await post('/staff/session', {
        salonId: SALON, deviceId: body.deviceId, phone: PAIRED_PHONE_LOCAL, pin: '4321',
      });
      expect(byPhone.statusCode).toBe(200);
      expect(byPhone.json().staff.id).toBe(PAIRED);
      const fromOld = await post('/staff/session', {
        salonId: SALON, deviceId: OLD_DEVICE, phone: PAIRED_PHONE, pin: '4321',
      });
      expect(fromOld.statusCode).toBe(401);
      expect(fromOld.json().error).toBe('invalid_credentials');

      // Spent: the same token again is the uniform refusal.
      const again = await post('/staff/pair', { token: code.token, pin: '4321' });
      expect(again.statusCode).toBe(400);
      expect(again.json()).toEqual(REFUSAL);
    });

    it('pairs by mobile number and six digits', async () => {
      const code = await issueCode(SECOND);
      const res = await post('/staff/pair', { phone: SECOND_PHONE, code: code.code, pin: '2580' });
      expect(res.statusCode, res.body).toBe(200);
      const body = StaffPairResponseSchema.parse(res.json());
      expect(body.staff.id).toBe(SECOND);
      expect(body.staff.pinSet).toBe(true);
      // Paired without a branch: no till enrolled.
      const rows = await exec(sql`SELECT 1 FROM device_enrolment WHERE device_id = ${body.deviceId}`);
      expect(rows.length).toBe(0);
    });

    /**
     * Trunk's ruling, phase 2: a re-pair unenrols her PREVIOUS phone in the same
     * transaction as the claim — but only a `PH-` id the server issued, never a
     * typed or seeded till (the counter's shared tablet).
     */
    describe('re-pairing unenrols the phone she left, and only a phone the server issued', () => {
      /** Its own address: these pairs must not spend the file's shared budget. */
      const REPAIR_IP = `10.${octet()}.${octet()}.${octet()}`;
      const pairAs = async (staffId: string, branchId: string | null, pin: string) => {
        const code = await issueCode(staffId, branchId ? { branchId } : {});
        const res = await post('/staff/pair', { token: code.token, pin }, undefined, REPAIR_IP);
        expect(res.statusCode, res.body).toBe(200);
        const body = StaffPairResponseSchema.parse(res.json());
        REPAIR_DEVICES.push(body.deviceId);
        return body;
      };
      const enrolmentsOf = (deviceId: string) =>
        exec(sql`
          SELECT branch_id, label, revoked_at, revoked_by_staff_id, enrolled_by_staff_id
            FROM device_enrolment
           WHERE salon_id = ${SALON} AND device_id = ${deviceId}
           ORDER BY created_at`);

      it('pairing twice with a branch revokes the first PH- enrolment, as her, and enrols the second', async () => {
        const first = await pairAs(REPAIRED, SALMIYA, '1357');
        expect(first.deviceId.startsWith('PH-')).toBe(true);
        const [live] = await enrolmentsOf(first.deviceId);
        expect(live).toMatchObject({ branch_id: SALMIYA, revoked_at: null, enrolled_by_staff_id: MANAGER });

        const second = await pairAs(REPAIRED, KUWAIT_CITY, '2468');
        expect(second.deviceId).not.toBe(first.deviceId);

        // The first phone's row: revoked, not deleted — the history stays.
        const firstRows = await enrolmentsOf(first.deviceId);
        expect(firstRows.length).toBe(1);
        expect(firstRows[0]!.revoked_at).not.toBeNull();
        expect(firstRows[0]!.revoked_by_staff_id, 'the revoker is her: she moved the PIN').toBe(REPAIRED);

        // The second phone is the live till, at the branch on the second code.
        const secondRows = await enrolmentsOf(second.deviceId);
        expect(secondRows).toEqual([
          expect.objectContaining({ branch_id: KUWAIT_CITY, revoked_at: null, revoked_by_staff_id: null }),
        ]);

        // Exactly one live till carries her name.
        const [liveCount] = await exec(sql`
          SELECT count(*)::int AS n FROM device_enrolment
           WHERE salon_id = ${SALON} AND device_id IN (${first.deviceId}, ${second.deviceId})
             AND revoked_at IS NULL`);
        expect(liveCount!.n).toBe(1);

        // The audit row is the one DELETE /salons/:id/devices writes, with her as the actor.
        const audits = await exec(sql`
          SELECT kind::text AS kind, actor_kind::text AS actor_kind, actor_id, source::text AS source,
                 subject_type, detail, metadata->>'via' AS via,
                 metadata->>'replacedByDeviceId' AS replaced_by
            FROM audit_log
           WHERE subject_id = ${first.deviceId} AND action = 'device_revoked'`);
        expect(audits).toEqual([
          expect.objectContaining({
            kind: 'rules',
            actor_kind: 'staff',
            actor_id: REPAIRED,
            source: 'scanner',
            subject_type: 'device',
            via: 'pairing',
            replaced_by: second.deviceId,
          }),
        ]);
        expect(String(audits[0]!.detail)).toContain(first.deviceId);

        // The old phone's PIN binding is gone with it; the new one signs in.
        const fromFirst = await post('/staff/session', {
          salonId: SALON, deviceId: first.deviceId, handle: `pr-j-${RUN}`, pin: '2468',
        }, undefined, REPAIR_IP);
        expect(fromFirst.statusCode).toBe(401);
        const fromSecond = await post('/staff/session', {
          salonId: SALON, deviceId: second.deviceId, handle: `pr-j-${RUN}`, pin: '2468',
        }, undefined, REPAIR_IP);
        expect(fromSecond.statusCode, fromSecond.body).toBe(200);
      });

      it('a re-pair WITHOUT a branch still unenrols the PH- phone she left, and enrols nothing', async () => {
        const [row] = await exec(sql`SELECT pin_device_id FROM staff_user WHERE id = ${REPAIRED}`);
        const leaving = String(row!.pin_device_id);
        expect(leaving.startsWith('PH-')).toBe(true);
        expect((await enrolmentsOf(leaving))[0]!.revoked_at, 'precondition: her current phone is a live till').toBeNull();

        const third = await pairAs(REPAIRED, null, '1470');
        const left = await enrolmentsOf(leaving);
        expect(left.length).toBe(1);
        expect(left[0]!.revoked_at).not.toBeNull();
        expect(left[0]!.revoked_by_staff_id).toBe(REPAIRED);
        expect((await enrolmentsOf(third.deviceId)).length).toBe(0);
      });

      it('a typed DEV- till survives her re-pair: still enrolled, still where it was', async () => {
        // Enrolled the way the counter's tablet is: a manager types the id in Tills.
        const enrol = await post(
          `/salons/${SALON}/devices`,
          { deviceId: SHARED_TILL, branchId: SALMIYA, label: 'PR counter tablet' },
          manager,
        );
        expect(enrol.statusCode, enrol.body).toBe(201);

        const paired = await pairAs(TILL_USER, KUWAIT_CITY, '8642');
        expect(paired.deviceId).not.toBe(SHARED_TILL);

        // Her PIN moved to the new phone…
        const [staff] = await exec(sql`SELECT pin_device_id FROM staff_user WHERE id = ${TILL_USER}`);
        expect(staff!.pin_device_id).toBe(paired.deviceId);

        // …and the shared till did not move at all.
        const shared = await enrolmentsOf(SHARED_TILL);
        expect(shared).toEqual([
          expect.objectContaining({ branch_id: SALMIYA, revoked_at: null, revoked_by_staff_id: null }),
        ]);
        const [revokes] = await exec(sql`
          SELECT count(*)::int AS n FROM audit_log
           WHERE subject_id = ${SHARED_TILL} AND action = 'device_revoked'`);
        expect(revokes!.n).toBe(0);

        // And her new phone is the till at the branch on her code.
        expect(await enrolmentsOf(paired.deviceId)).toEqual([
          expect.objectContaining({ branch_id: KUWAIT_CITY, revoked_at: null }),
        ]);
      });
    });

    it('answers every refusal with one status and one body', async () => {
      const code = await issueCode(SECOND);
      const causes: Array<[string, Record<string, unknown>]> = [
        ['unknown token', { token: `pair_${'A'.repeat(43)}`, pin: '1234' }],
        ['malformed token', { token: 'short', pin: '1234' }],
        ['wrong digits', { phone: SECOND_PHONE, code: code.code === '000000' ? '000001' : '000000', pin: '1234' }],
        ['unknown phone', { phone: `+965${localNumber()}`, code: code.code, pin: '1234' }],
        ['malformed phone', { phone: 'not a number', code: code.code, pin: '1234' }],
        ['five digits', { phone: SECOND_PHONE, code: '12345', pin: '1234' }],
      ];
      for (const [cause, payload] of causes) {
        const res = await post('/staff/pair', payload);
        expect(res.statusCode, cause).toBe(400);
        expect(res.json(), cause).toEqual(REFUSAL);
      }
    });

    it('refuses an expired code and a deactivated staff member identically', async () => {
      const expired = await issueCode(SECOND);
      await db.execute(sql`
        UPDATE staff_pairing_code
           SET created_at = now() - interval '20 minutes', expires_at = now() - interval '10 minutes'
         WHERE staff_id = ${SECOND} AND used_at IS NULL AND voided_at IS NULL`);
      const a = await post('/staff/pair', { token: expired.token, pin: '1234' });
      expect(a.statusCode).toBe(400);
      expect(a.json()).toEqual(REFUSAL);

      // A code issued, then the staff member leaves: the code dies with her.
      await db.execute(sql`UPDATE staff_user SET deactivated_at = NULL WHERE id = ${LEAVER}`);
      const live = await issueCode(LEAVER);
      await db.execute(sql`UPDATE staff_user SET deactivated_at = now() WHERE id = ${LEAVER}`);
      const b = await post('/staff/pair', { token: live.token, pin: '1234' });
      expect(b.statusCode).toBe(400);
      expect(b.json()).toEqual(REFUSAL);
    });

    it('voids a code after five wrong sets of digits, so the right one then fails', async () => {
      // PAIRED's number, not SECOND's: six attempts here would take SECOND's
      // per-number budget (ten a quarter-hour) too close to its ceiling.
      const code = await issueCode(PAIRED);
      const wrong = code.code === '999999' ? '999998' : '999999';
      for (let i = 0; i < 5; i++) {
        const res = await post('/staff/pair', { phone: PAIRED_PHONE, code: wrong, pin: '1234' });
        expect(res.json()).toEqual(REFUSAL);
      }
      const right = await post('/staff/pair', { phone: PAIRED_PHONE, code: code.code, pin: '1234' });
      expect(right.statusCode).toBe(400);
      expect(right.json()).toEqual(REFUSAL);

      const [row] = await exec(sql`
        SELECT failed_attempts, voided_at, used_at FROM staff_pairing_code
         WHERE token_hash = ${createHash('sha256').update(code.token).digest('hex')}`);
      expect(row!.failed_attempts).toBe(5);
      expect(row!.voided_at).not.toBeNull();
      expect(row!.used_at).toBeNull();
      const [audit] = await exec(sql`
        SELECT actor_kind FROM audit_log
         WHERE subject_id = ${PAIRED} AND action = 'Pairing code voided'
         ORDER BY created_at DESC LIMIT 1`);
      expect(audit!.actor_kind).toBe('system');
    });

    it('lets exactly one of two racing redeems win', async () => {
      const code = await issueCode(SECOND);
      const [a, b] = await Promise.all([
        post('/staff/pair', { token: code.token, pin: '1111' }),
        post('/staff/pair', { token: code.token, pin: '2222' }),
      ]);
      expect([a.statusCode, b.statusCode].sort()).toEqual([200, 400]);
      const loser = a.statusCode === 400 ? a : b;
      expect(loser.json()).toEqual(REFUSAL);
    });

    it('refuses with 429 too_many_attempts once one number has spent its budget', async () => {
      const phone = `+965${localNumber()}`;
      // Each from a fresh address, so this is the PHONE tier and not the address one.
      for (let i = 0; i < 10; i++) {
        const res = await post('/staff/pair', { phone, code: '123456', pin: '1234' }, undefined, `10.250.${i}.${octet()}`);
        expect(res.statusCode).toBe(400);
      }
      const res = await post('/staff/pair', { phone, code: '123456', pin: '1234' }, undefined, `10.251.0.${octet()}`);
      expect(res.statusCode).toBe(429);
      expect(res.json().error).toBe('too_many_attempts');
    });

    it('refuses with 429 too_many_attempts once one address has spent its budget', async () => {
      const ip = `10.${octet()}.${octet()}.${octet()}`;
      for (let i = 0; i < 30; i++) {
        const res = await post('/staff/pair', { token: `pair_${'B'.repeat(43)}`, pin: '1234' }, undefined, ip);
        expect(res.statusCode).toBe(400);
      }
      const res = await post('/staff/pair', { token: `pair_${'B'.repeat(43)}`, pin: '1234' }, undefined, ip);
      expect(res.statusCode).toBe(429);
      expect(res.json().error).toBe('too_many_attempts');
    });
  });

  // ========================================================= lock order ==
  /**
   * PHASE 2, lane D's knownBug (e2e/staff-pairing.test.ts): the issue locked her
   * staff row then her codes, the redeem locked the code then her staff row, and
   * a re-issue interleaved with a redeem of the earlier code was a `40P01` and a
   * 500. Lane D's spec is the contract; this is the same arrangement held in
   * lane A's own column, so the fix has a regression test that does not depend
   * on another lane's file being promoted.
   *
   * ARRANGED, NOT HOPED FOR. A transaction here takes her row FOR UPDATE; the
   * re-issue is let in and observed queueing on it; then the redeem, observed
   * queueing too; then the row is released. Before the fix the redeem queued at
   * the PIN bind holding the claimed code — the cycle. After it, the redeem
   * queues at its first lock holding nothing, and simply loses to the re-issue.
   */
  describe('a re-issue racing a redeem of the earlier code', () => {
    const RACE_IP = `10.${octet()}.${octet()}.${octet()}`;

    /** Backends of this database waiting on a lock, other than the probe itself. */
    const lockWaiters = async () =>
      Number(
        (
          await exec(sql`
            SELECT count(*)::int AS n FROM pg_stat_activity
             WHERE datname = current_database() AND pid <> pg_backend_pid()
               AND wait_event_type = 'Lock'`)
        )[0]!.n,
      );
    const until = async (cond: () => Promise<boolean>, what: string) => {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        if (await cond()) return;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error(`precondition failed: ${what}`);
    };

    it('both answer inside the contract — never a 500 — and the new code then pairs', async () => {
      const first = await issueCode(RACER);

      let release!: () => void;
      const released = new Promise<void>((r) => (release = r));
      let taken!: () => void;
      const lockTaken = new Promise<void>((r) => (taken = r));
      const holder = db.transaction(async (tx) => {
        await tx.execute(sql`SELECT 1 FROM staff_user WHERE id = ${RACER} FOR UPDATE`);
        taken();
        await released;
      });
      await lockTaken;

      let reissue: ReturnType<typeof post> | undefined;
      let redeem: ReturnType<typeof post> | undefined;
      try {
        reissue = post(`/staff/${RACER}/pairing-code`, {}, manager);
        await until(async () => (await lockWaiters()) >= 1, 'the re-issue never queued on her row');
        redeem = post('/staff/pair', { token: first.token, pin: '3141' }, undefined, RACE_IP);
        await until(async () => (await lockWaiters()) >= 2, 'the redeem never queued behind it');
      } finally {
        release();
        await holder;
      }
      const [reissued, redeemed] = await Promise.all([reissue!, redeem!]);

      expect(reissued.statusCode, `the re-issue: ${reissued.body}`).toBe(201);
      expect([200, 400], `the redeem: ${redeemed.statusCode} ${redeemed.body}`).toContain(redeemed.statusCode);
      if (redeemed.statusCode === 400) expect(redeemed.json()).toEqual(REFUSAL);

      // Either way the re-issued code is the live one, and it pairs.
      const fresh = StaffPairingCodeSchema.parse(reissued.json());
      const ok = await post('/staff/pair', { token: fresh.token, pin: '2718' }, undefined, RACE_IP);
      expect(ok.statusCode, ok.body).toBe(200);
      expect(StaffPairResponseSchema.parse(ok.json()).staff.id).toBe(RACER);
    });
  });

  // ========================================================== the leaver ==
  /**
   * Trunk's ruling, phase 2: deactivating a staff member retires her pairing
   * state with her, in the same transaction, as it already spends her reset
   * links — her live codes are voided, and the till enrolled under her
   * server-issued `PH-` phone is revoked. A typed or seeded till is never
   * touched.
   */
  describe('DELETE /staff/:id retires her pairing state', () => {
    const LEAVE_IP = `10.${octet()}.${octet()}.${octet()}`;
    const deactivate = (staffId: string) =>
      app.inject({
        method: 'DELETE',
        url: `/staff/${staffId}`,
        headers: { authorization: `Bearer ${manager}` },
      });
    const enrolmentsOf = (deviceId: string) =>
      exec(sql`
        SELECT branch_id, revoked_at, revoked_by_staff_id FROM device_enrolment
         WHERE salon_id = ${SALON} AND device_id = ${deviceId}
         ORDER BY created_at`);

    it("voids her live code, so it cannot pair her even after she is re-hired within its life", async () => {
      const code = await issueCode(CODE_LEAVER);

      const res = await deactivate(CODE_LEAVER);
      expect(res.statusCode, res.body).toBe(200);
      const [row] = await exec(sql`
        SELECT voided_at, used_at FROM staff_pairing_code
         WHERE token_hash = ${createHash('sha256').update(code.token).digest('hex')}`);
      expect(row!.voided_at, 'her code outlived her deactivation').not.toBeNull();
      expect(row!.used_at, 'voided, not spent: nobody redeemed it').toBeNull();

      // RE-HIRED through the product's own door: a reset link, accepted. The
      // token is minted here because the route never returns one (#6); the row
      // is the outbox a sender would deliver from.
      const resetToken = `pr-reset-${RUN}-${'x'.repeat(24)}`;
      await db.execute(sql`
        INSERT INTO staff_password_reset (staff_id, salon_id, token_hash, requested_by, expires_at)
        VALUES (${CODE_LEAVER}, ${SALON}, ${createHash('sha256').update(resetToken).digest('hex')},
                ${MANAGER}, now() + interval '1 hour')`);
      const rehire = await post('/auth/staff/password-reset', {
        token: resetToken,
        password: 'a-returning-password',
      }, undefined, LEAVE_IP);
      expect(rehire.statusCode, rehire.body).toBeLessThan(300);
      const [back] = await exec(sql`SELECT deactivated_at, phone FROM staff_user WHERE id = ${CODE_LEAVER}`);
      expect(back!.deactivated_at, 'precondition: she is active again').toBeNull();
      expect(back!.phone, 'precondition: her number came back with her').toBe(`+965${CODE_LEAVER_PHONE_LOCAL}`);

      // Inside the code's ten minutes, neither door pairs her with it.
      const byToken = await post('/staff/pair', { token: code.token, pin: '1593' }, undefined, LEAVE_IP);
      expect(byToken.statusCode).toBe(400);
      expect(byToken.json()).toEqual(REFUSAL);
      const byPhone = await post(
        '/staff/pair',
        { phone: CODE_LEAVER_PHONE_LOCAL, code: code.code, pin: '1593' },
        undefined,
        LEAVE_IP,
      );
      expect(byPhone.statusCode).toBe(400);
      expect(byPhone.json()).toEqual(REFUSAL);
      const [staff] = await exec(sql`SELECT pin_hash, pin_device_id FROM staff_user WHERE id = ${CODE_LEAVER}`);
      expect(staff!.pin_hash).toBeNull();
      expect(staff!.pin_device_id).toBeNull();

      const [audit] = await exec(sql`
        SELECT metadata->>'pairingCodesVoided' AS voided FROM audit_log
         WHERE subject_id = ${CODE_LEAVER} AND action = 'Staff account deactivated'`);
      expect(audit!.voided).toBe('1');

      // A code issued AFTER the re-hire is hers, and works.
      const fresh = await issueCode(CODE_LEAVER);
      const ok = await post('/staff/pair', { token: fresh.token, pin: '1593' }, undefined, LEAVE_IP);
      expect(ok.statusCode, ok.body).toBe(200);
      REPAIR_DEVICES.push(StaffPairResponseSchema.parse(ok.json()).deviceId);
    });

    it('revokes the PH- till her phone was enrolled as, as the manager, with reason staff_deactivated', async () => {
      const code = await issueCode(PHONE_LEAVER, { branchId: SALMIYA });
      const res = await post('/staff/pair', { token: code.token, pin: '8024' }, undefined, LEAVE_IP);
      expect(res.statusCode, res.body).toBe(200);
      const phone = StaffPairResponseSchema.parse(res.json()).deviceId;
      REPAIR_DEVICES.push(phone);
      expect(phone.startsWith('PH-')).toBe(true);
      expect((await enrolmentsOf(phone))[0]!.revoked_at, 'precondition: her phone is a live till').toBeNull();

      const gone = await deactivate(PHONE_LEAVER);
      expect(gone.statusCode, gone.body).toBe(200);

      // Revoked, not deleted — the history stays — and by the manager who did it.
      const rows = await enrolmentsOf(phone);
      expect(rows.length).toBe(1);
      expect(rows[0]!.revoked_at).not.toBeNull();
      expect(rows[0]!.revoked_by_staff_id).toBe(MANAGER);

      // The re-pair's audit row, with the deactivation's reason.
      const audits = await exec(sql`
        SELECT kind::text AS kind, actor_kind::text AS actor_kind, actor_id, source::text AS source,
               subject_type, detail, metadata->>'reason' AS reason, metadata->>'pairedStaffId' AS staff
          FROM audit_log
         WHERE subject_id = ${phone} AND action = 'device_revoked'`);
      expect(audits).toEqual([
        expect.objectContaining({
          kind: 'rules',
          actor_kind: 'staff',
          actor_id: MANAGER,
          source: 'merchant',
          subject_type: 'device',
          reason: 'staff_deactivated',
          staff: PHONE_LEAVER,
        }),
      ]);
      expect(String(audits[0]!.detail)).toContain(phone);

      const [summary] = await exec(sql`
        SELECT metadata->>'tillsRevoked' AS tills FROM audit_log
         WHERE subject_id = ${PHONE_LEAVER} AND action = 'Staff account deactivated'`);
      expect(summary!.tills).toBe('1');
    });

    it('leaves a typed DEV- till enrolled: it may be the counter tablet the team still uses', async () => {
      const enrol = await post(
        `/salons/${SALON}/devices`,
        { deviceId: LEAVER_TILL, branchId: KUWAIT_CITY, label: 'PR leaver counter tablet' },
        manager,
      );
      expect(enrol.statusCode, enrol.body).toBe(201);

      const gone = await deactivate(TILL_LEAVER);
      expect(gone.statusCode, gone.body).toBe(200);
      const [staff] = await exec(sql`SELECT pin_device_id, deactivated_at FROM staff_user WHERE id = ${TILL_LEAVER}`);
      expect(staff!.deactivated_at).not.toBeNull();
      expect(staff!.pin_device_id, 'her PIN binding still goes').toBeNull();

      expect(await enrolmentsOf(LEAVER_TILL)).toEqual([
        expect.objectContaining({ branch_id: KUWAIT_CITY, revoked_at: null, revoked_by_staff_id: null }),
      ]);
      const [revokes] = await exec(sql`
        SELECT count(*)::int AS n FROM audit_log
         WHERE subject_id = ${LEAVER_TILL} AND action = 'device_revoked'`);
      expect(revokes!.n).toBe(0);
    });
  });

  // ============================================================ the number ==
  describe('staff_user.phone through POST /staff and PATCH /staff/:id', () => {
    let created: string | null = null;
    afterAll(async () => {
      if (created) await db.execute(sql`DELETE FROM staff_user WHERE id = ${created}`);
    });

    it('stores an eight-digit number as +965 and serialises it', async () => {
      const local = localNumber();
      const res = await post('/staff', { name: 'PR New', handle: `pr-g-${RUN}`, role: 'artist', phone: local }, manager);
      expect(res.statusCode, res.body).toBe(201);
      const body = StaffUserSchema.parse(res.json());
      created = body.id;
      expect(body.phone).toBe(`+965${local}`);
    });

    it('refuses a phone edit from a caller without perms.team, and changes nothing', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/staff/${SECOND}`,
        payload: { phone: null },
        headers: { authorization: `Bearer ${frontdesk}` },
      });
      expect(res.statusCode).toBe(403);
      const [row] = await exec(sql`SELECT phone FROM staff_user WHERE id = ${SECOND}`);
      expect(row!.phone).toBe(SECOND_PHONE);
    });

    it('refuses a number another active staff member holds with 409 phone_taken', async () => {
      const res = await post('/staff', { name: 'PR Dup', handle: `pr-h-${RUN}`, role: 'artist', phone: SECOND_PHONE }, manager);
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('phone_taken');
      const patch = await app.inject({
        method: 'PATCH',
        url: `/staff/${PAIRED}`,
        payload: { phone: SECOND_PHONE },
        headers: { authorization: `Bearer ${manager}` },
      });
      expect(patch.statusCode).toBe(409);
      expect(patch.json().error).toBe('phone_taken');
    });

    it('lets a leaver\'s number go to the next hire', async () => {
      const number = `+965${localNumber()}`;
      await db.execute(sql`UPDATE staff_user SET phone = ${number} WHERE id = ${LEAVER}`);
      const patch = await app.inject({
        method: 'PATCH',
        url: `/staff/${TEAM_NO_DASH}`,
        payload: { phone: number },
        headers: { authorization: `Bearer ${manager}` },
      });
      expect(patch.statusCode, patch.body).toBe(200);
      expect(patch.json().phone).toBe(number);
      const clear = await app.inject({
        method: 'PATCH',
        url: `/staff/${TEAM_NO_DASH}`,
        payload: { phone: null },
        headers: { authorization: `Bearer ${manager}` },
      });
      expect(clear.json().phone).toBeNull();
    });

    it('refuses a handle that reads as a mobile number, and a malformed number', async () => {
      const handle = await post('/staff', { name: 'PR Num', handle: localNumber(), role: 'artist' }, manager);
      expect(handle.statusCode).toBe(400);
      expect(handle.json().error).toBe('invalid_handle');
      const bad = await post('/staff', { name: 'PR Bad', handle: `pr-i-${RUN}`, role: 'artist', phone: '12' }, manager);
      expect(bad.statusCode).toBe(400);
      expect(bad.json().error).toBe('invalid_phone');
    });

    it('emits phone on every roster row, null when unset', async () => {
      const res = await app.inject({ method: 'GET', url: '/staff', headers: { authorization: `Bearer ${manager}` } });
      const items = res.json().items as Array<Record<string, unknown>>;
      expect(items.length).toBeGreaterThan(0);
      for (const item of items) {
        expect(item).toHaveProperty('phone');
        StaffUserSchema.extend({ phone: StaffUserSchema.shape.phone.unwrap() }).parse(item);
      }
      expect(items.find((i) => i.id === MANAGER)!.phone).toBeNull();
    });
  });

  // =========================================================== sign-in ==
  describe('the number as a sign-in name', () => {
    it('signs into the dashboard with an eight-digit number as the username', async () => {
      const res = await post('/auth/web/session', { salonId: SALON, username: WEB_PHONE_LOCAL, password: WEB_PASSWORD });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().staff.id).toBe(WEBBY);
      const e164 = await post('/auth/web/session', { salonId: SALON, username: `+965 ${WEB_PHONE_LOCAL}`, password: WEB_PASSWORD });
      expect(e164.statusCode).toBe(200);
    });

    it('answers an unknown number exactly as a wrong password', async () => {
      const unknown = await post('/auth/web/session', { salonId: SALON, username: localNumber(), password: WEB_PASSWORD });
      const wrong = await post('/auth/web/session', { salonId: SALON, username: WEB_PHONE_LOCAL, password: 'not-the-password' });
      expect(unknown.statusCode).toBe(401);
      expect(wrong.statusCode).toBe(401);
      expect(unknown.json()).toEqual(wrong.json());
    });

    it('answers an unknown number on the scanner exactly as a wrong PIN', async () => {
      const [row] = await exec(sql`SELECT pin_device_id FROM staff_user WHERE id = ${PAIRED}`);
      const device = String(row!.pin_device_id);
      const unknown = await post('/staff/session', { salonId: SALON, deviceId: device, phone: `+965${localNumber()}`, pin: '4321' });
      const wrong = await post('/staff/session', { salonId: SALON, deviceId: device, phone: PAIRED_PHONE, pin: '0000' });
      expect(unknown.statusCode).toBe(401);
      expect(wrong.statusCode).toBe(401);
      expect(unknown.json()).toEqual(wrong.json());
      // Reset the strike the wrong PIN left, so a re-run starts clean.
      await db.execute(sql`UPDATE staff_user SET pin_failed_attempts = 0 WHERE id = ${PAIRED}`);
    });

    it('refuses handle and phone together, and keeps the old refusal for neither', async () => {
      const both = await post('/staff/session', { salonId: SALON, deviceId: 'd', handle: 'noura', phone: PAIRED_PHONE, pin: '1234' });
      expect(both.statusCode).toBe(400);
      expect(both.json().error).toBe('invalid_request');
      const neither = await post('/staff/session', { salonId: SALON, deviceId: 'd', pin: '1234' });
      expect(neither.statusCode).toBe(400);
      expect(neither.json().message).toBe('handle is required.');
    });
  });
});
