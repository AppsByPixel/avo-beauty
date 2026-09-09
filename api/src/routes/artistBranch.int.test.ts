/**
 * AN ARTIST BELONGS TO ONE BRANCH, and a booking stops guessing.
 *                                     (migration 0044, and DECISIONS.md #91)
 *
 * =========================================================================
 * WHAT THIS PROVES
 * =========================================================================
 * `POST /bookings` writes a deposit-hold transaction whose branch used to be
 * `resolveBranch(tx, salonId, undefined)` — so at a multi-branch salon EVERY
 * booking was `ORDER BY id LIMIT 1` with `branch_assumed = true`, and "branch"
 * on a booking was a label rather than a constraint. A booking against an
 * ASSIGNED artist is now `branch_assumed = false`, at the artist's branch, which
 * has never been true for a booking in this product.
 *
 * And the closure regression lane C drove (decision 91): enrol a till, close its
 * branch, charge → `404 unknown_branch`, a dead counter with nothing saying so.
 * The close now cascades a revoke and names the tills before and after.
 *
 * =========================================================================
 * THE `EN-` NAMESPACE, AND WHY IT IS NOT `IT-`
 * =========================================================================
 * `services/metrics.int.test.ts` owns the whole `IT-` prefix and cleans up with
 * `DELETE … WHERE id LIKE 'IT-M%'` and friends. A member with real charges
 * cannot be deleted (`ledger_entry` is append-only, the FK is `ON DELETE
 * restrict`), so an `IT-` id here would make ANOTHER suite's cleanup fail
 * permanently — found the hard way in `devices.int.test.ts`, by running the int
 * suite three times.
 *
 * This file shares `EN-` with `devices.int.test.ts` and suffixes every id per
 * run, so the two cannot collide with each other either.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

const INT_URL = process.env.AVO_INT_DATABASE_URL;
const suite = INT_URL ? describe : describe.skip;

const SALON = 'SAL-AMARA';
const KUWAIT_CITY = 'BR-KWC';
const SALMIYA = 'BR-SAL';
const OTHER_SALON = 'SAL-LUMIERE';
const FOREIGN_BRANCH = 'BR-LUM-HAW';

/** Every permission, so `team` and `loyalty` and `dashboard` are all held. */
const MANAGER = 'ST-001';
/** `appointments` TRUE, `team` FALSE, `dashboard` FALSE — db/seed.ts. */
const FRONTDESK = 'ST-002';

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
const AR_SAL = `EN-AB-SAL-${RUN}`;
const AR_KWC = `EN-AB-KWC-${RUN}`;
const AR_NONE = `EN-AB-NONE-${RUN}`;
const SVC = `EN-AB-SV-${RUN}`;
const MEMBER = `EN-AB-M-${RUN}`;
const DEVICE = `EN-AB-DEV-${RUN}`;

suite('an artist belongs to one branch', () => {
  let app: FastifyInstance;
  let db: (typeof import('../db/client'))['db'];
  let sql: (typeof import('drizzle-orm'))['sql'];
  let issue: (typeof import('../auth/sessions'))['issueSession'];
  let manager: string;
  let frontdesk: string;
  let memberToken: string;

  const exec = async (q: unknown) =>
    (await db.execute(q as never)) as unknown as Array<Record<string, unknown>>;
  const scalar = async (q: unknown) => String((await exec(q))[0]?.n ?? '');

  beforeAll(async () => {
    db = (await import('../db/client')).db;
    sql = (await import('drizzle-orm')).sql;
    issue = (await import('../auth/sessions')).issueSession;
    app = await (await import('../app')).buildApp();

    const open = await scalar(
      sql`SELECT count(*) AS n FROM branch WHERE salon_id = ${SALON} AND closed_at IS NULL`,
    );
    expect(open, 'this suite needs SAL-AMARA to have 2 open branches').toBe('2');

    /**
     * Three artists: one per branch and one deliberately UNASSIGNED, which is
     * the state migration 0044 leaves every multi-branch salon's roster in.
     *
     * `windows` gives each of them a wide, every-day schedule so the real
     * availability grid offers slots — this suite books through the real
     * endpoint and will not fabricate a slot.
     */
    /**
     * `ArtistWindow` is `{ open: boolean; from: string; to: string }` — `open` is
     * a FLAG, not a time. Getting that wrong produced windows the availability
     * grid read as closed all week and four specs failing with "offered no
     * bookable slot in a fortnight", which looks like a defect in booking.
     */
    const week = JSON.stringify(
      Object.fromEntries(
        ['0', '1', '2', '3', '4', '5', '6'].map((d) => [
          d,
          { open: true, from: '10:00', to: '20:00' },
        ]),
      ),
    );
    await db.execute(sql`
      INSERT INTO artist (id, salon_id, branch_id, name, slot_minutes, windows, active) VALUES
        (${AR_SAL},  ${SALON}, ${SALMIYA},     ${`EN Salmiya ${RUN}`},  60, ${week}::jsonb, true),
        (${AR_KWC},  ${SALON}, ${KUWAIT_CITY}, ${`EN Kuwait ${RUN}`},   60, ${week}::jsonb, true),
        (${AR_NONE}, ${SALON}, NULL,           ${`EN Nobranch ${RUN}`}, 60, ${week}::jsonb, true)`);

    await db.execute(sql`
      INSERT INTO service (id, salon_id, name, price_fils, active)
      VALUES (${SVC}, ${SALON}, ${`EN AB Service ${RUN}`}, 9000, true)`);

    await db.execute(sql`
      INSERT INTO member (id, salon_id, name, phone, password_hash, balance_fils, tier, visits, policy_version)
      VALUES (${MEMBER}, ${SALON}, 'EN AB Member',
              ${`+9656${String(Date.now() % 1_000_000).padStart(6, '0')}`},
              'x', 900000, 'bronze', 0, 1)`);

    manager = (
      await issue(db, { principalKind: 'staff', staffId: MANAGER, salonId: SALON, scope: 'dashboard' })
    ).accessToken;
    frontdesk = (
      await issue(db, { principalKind: 'staff', staffId: FRONTDESK, salonId: SALON, scope: 'dashboard' })
    ).accessToken;
    memberToken = (
      await issue(db, { principalKind: 'member', memberId: MEMBER, salonId: SALON, scope: 'wallet' })
    ).accessToken;
  });

  afterAll(async () => {
    if (db) {
      await db.execute(sql`DELETE FROM device_enrolment WHERE device_id = ${DEVICE}`);
      await db.execute(sql`DELETE FROM session WHERE member_id = ${MEMBER}`);
      // Artists, services and the member stay: bookings and ledger rows anchor
      // them. Per-run ids, so nothing else reads them.
    }
    await app?.close();
  });

  const get = (url: string, token: string) =>
    app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });

  const setBranch = (artistId: string, branchId: string | null, token = manager) =>
    app.inject({
      method: 'PUT',
      url: `/artists/${artistId}/branch`,
      headers: { authorization: `Bearer ${token}` },
      payload: { branchId },
    });

  /** A real booking through the real endpoint, on a slot the real grid offers. */
  async function bookWith(artistId: string) {
    let slot: string | undefined;
    for (let d = 9; d < 24 && !slot; d++) {
      const day = new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);
      const res = await get(`/artists/${artistId}/availability?date=${day}`, memberToken);
      expect(res.statusCode, res.body).toBe(200);
      slot = (JSON.parse(res.body).slots as Array<{ available: boolean; startsAt: string }>).find(
        (s) => s.available,
      )?.startsAt;
    }
    expect(slot, `${artistId} offered no bookable slot in a fortnight`).toBeDefined();

    const res = await app.inject({
      method: 'POST',
      url: '/bookings',
      headers: {
        authorization: `Bearer ${memberToken}`,
        'idempotency-key': `en-ab-${RUN}-${Math.random().toString(36).slice(2)}`,
      },
      payload: { artistId, serviceId: SVC, startsAt: slot },
    });
    expect(res.statusCode, res.body).toBe(201);
    const bookingId = JSON.parse(res.body).booking.id as string;
    const [row] = await exec(sql`
      SELECT b.branch_id, b.branch_assumed, t.branch_id AS tx_branch, t.branch_assumed AS tx_assumed
        FROM booking b JOIN "transaction" t ON t.id = b.hold_transaction_id
       WHERE b.id = ${bookingId}`);
    return {
      bookingId,
      branchId: String(row?.branch_id),
      assumed: row?.branch_assumed === true,
      txBranchId: String(row?.tx_branch),
      txAssumed: row?.tx_assumed === true,
    };
  }

  // ==================================================================
  // THE PROOF: a booking's branch comes from its artist.
  // ==================================================================
  describe('a booking derives its branch from the artist', () => {
    it('an artist at SALMIYA: booking at BR-SAL, branch_assumed FALSE', async () => {
      const b = await bookWith(AR_SAL);
      expect(b.branchId).toBe(SALMIYA);
      expect(b.assumed).toBe(false);
      // The deposit-hold transaction carries the same answer.
      expect(b.txBranchId).toBe(SALMIYA);
      expect(b.txAssumed).toBe(false);
    });

    it('an artist at KUWAIT CITY: booking at BR-KWC, branch_assumed FALSE', async () => {
      const b = await bookWith(AR_KWC);
      expect(b.branchId).toBe(KUWAIT_CITY);
      expect(b.assumed).toBe(false);
    });

    /**
     * THE UNASSIGNED CASE, which is what every multi-branch salon's roster looks
     * like the moment 0044 runs. Byte-for-byte the old behaviour: attributed by
     * sort order and flagged as a guess. This is the assertion that says the
     * lenient NULL ruling did not quietly change anything.
     */
    it('an UNASSIGNED artist: still a guess, and the row still says so', async () => {
      const b = await bookWith(AR_NONE);
      expect(b.assumed).toBe(true);
      expect([SALMIYA, KUWAIT_CITY]).toContain(b.branchId);
    });

    it('re-assigning changes where the NEXT booking lands, not the last one', async () => {
      const before = await bookWith(AR_NONE);
      expect(before.assumed).toBe(true);

      expect((await setBranch(AR_NONE, KUWAIT_CITY)).statusCode).toBe(200);
      const after = await bookWith(AR_NONE);
      expect(after.assumed).toBe(false);
      expect(after.branchId).toBe(KUWAIT_CITY);

      // The earlier booking is untouched — history is not rewritten.
      const [old] = await exec(
        sql`SELECT branch_assumed FROM booking WHERE id = ${before.bookingId}`,
      );
      expect(old?.branch_assumed).toBe(true);

      await setBranch(AR_NONE, null);
    });
  });

  // ==================================================================
  // THE ASSIGNMENT ENDPOINT — perms.team, enforced server-side.
  // ==================================================================
  describe('PUT /artists/:id/branch', () => {
    it('a frontdesk holder cannot assign — perms.team off', async () => {
      const res = await setBranch(AR_SAL, KUWAIT_CITY, frontdesk);
      expect(res.statusCode).toBe(403);
      const [row] = await exec(sql`SELECT branch_id FROM artist WHERE id = ${AR_SAL}`);
      expect(row?.branch_id).toBe(SALMIYA);
    });

    it("another salon's branch is a 404 by name, not a 403", async () => {
      const res = await setBranch(AR_SAL, FOREIGN_BRANCH);
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body).error).toBe('unknown_branch');
    });

    it('a closed branch cannot take an artist', async () => {
      await db.execute(sql`UPDATE branch SET closed_at = now() WHERE id = ${KUWAIT_CITY}`);
      try {
        expect((await setBranch(AR_SAL, KUWAIT_CITY)).statusCode).toBe(404);
      } finally {
        await db.execute(sql`UPDATE branch SET closed_at = NULL WHERE id = ${KUWAIT_CITY}`);
      }
    });

    it('null unassigns, and re-sending the same branch is a no-op', async () => {
      expect((await setBranch(AR_KWC, null)).statusCode).toBe(200);
      const cleared = await exec(sql`SELECT branch_id FROM artist WHERE id = ${AR_KWC}`);
      expect(cleared[0]?.branch_id).toBeNull();

      expect((await setBranch(AR_KWC, KUWAIT_CITY)).statusCode).toBe(200);
      const audits = await scalar(sql`
        SELECT count(*) AS n FROM audit_log
         WHERE subject_type = 'artist' AND subject_id = ${AR_KWC}`);
      // Re-sending the SAME branch writes nothing.
      expect((await setBranch(AR_KWC, KUWAIT_CITY)).statusCode).toBe(200);
      expect(
        await scalar(sql`
          SELECT count(*) AS n FROM audit_log
           WHERE subject_type = 'artist' AND subject_id = ${AR_KWC}`),
      ).toBe(audits);
    });

    it('a missing branchId is refused rather than read as null', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/artists/${AR_SAL}/branch`,
        headers: { authorization: `Bearer ${manager}` },
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('branch_required');
    });
  });

  // ==================================================================
  // THE ARTIST LISTS FILTER BY BRANCH — the customer's branch switch.
  // ==================================================================
  describe('?branch= on both artist lists', () => {
    const names = (body: string) =>
      (JSON.parse(body).items as Array<{ name: string }>).map((a) => a.name);

    it('the merchant roster filters to one branch', async () => {
      const res = await get(`/salons/${SALON}/artists?branch=${SALMIYA}`, manager);
      expect(res.statusCode).toBe(200);
      expect(names(res.body)).toContain(`EN Salmiya ${RUN}`);
      expect(names(res.body)).not.toContain(`EN Kuwait ${RUN}`);
      expect(names(res.body)).not.toContain(`EN Nobranch ${RUN}`);
    });

    it('`unassigned` is the query the merchant actually needs', async () => {
      const res = await get(`/salons/${SALON}/artists?branch=unassigned`, manager);
      expect(res.statusCode).toBe(200);
      expect(names(res.body)).toContain(`EN Nobranch ${RUN}`);
      expect(names(res.body)).not.toContain(`EN Salmiya ${RUN}`);
      // The seed's four artists are unassigned too — SAL-AMARA is multi-branch,
      // so 0044 deliberately backfilled none of them.
      expect(names(res.body)).toContain('Rana Al-Sabah');
    });

    it('the CUSTOMER bookable list filters too, and never asserts a branch', async () => {
      const res = await get(`/salons/${SALON}/artists/bookable?branch=${KUWAIT_CITY}`, memberToken);
      expect(res.statusCode).toBe(200);
      expect(names(res.body)).toContain(`EN Kuwait ${RUN}`);
      expect(names(res.body)).not.toContain(`EN Salmiya ${RUN}`);
      expect(names(res.body)).not.toContain(`EN Nobranch ${RUN}`);
    });

    it('an unfiltered bookable list still includes unassigned artists', async () => {
      const res = await get(`/salons/${SALON}/artists/bookable`, memberToken);
      expect(names(res.body)).toContain(`EN Nobranch ${RUN}`);
    });

    it('a nonsense filter is refused, not ignored', async () => {
      const res = await get(`/salons/${SALON}/artists?branch=' OR 1=1`, manager);
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('invalid_branch_filter');
    });

    it("another salon's branch id filters to empty rather than probing", async () => {
      const res = await get(`/salons/${SALON}/artists?branch=${FOREIGN_BRANCH}`, manager);
      expect(res.statusCode).toBe(200);
      expect(names(res.body)).toEqual([]);
    });
  });

  // ==================================================================
  // DECISION 91 — closing a branch must not leave a dead counter.
  // ==================================================================
  describe('closing a branch unenrols its tills', () => {
    it('the preview names the tills before she confirms', async () => {
      const enrolled = await app.inject({
        method: 'POST',
        url: `/salons/${SALON}/devices`,
        headers: { authorization: `Bearer ${manager}` },
        payload: { deviceId: DEVICE, branchId: KUWAIT_CITY, label: `EN till ${RUN}` },
      });
      expect(enrolled.statusCode, enrolled.body).toBe(201);

      const preview = await get(
        `/salons/${SALON}/branches/${KUWAIT_CITY}/closure-preview`,
        manager,
      );
      expect(preview.statusCode, preview.body).toBe(200);
      expect(JSON.parse(preview.body).tillsUnenrolled).toContain(`EN till ${RUN}`);
    });

    it('the close cascades the revoke, names it, and the till still charges', async () => {
      const closed = await app.inject({
        method: 'DELETE',
        url: `/salons/${SALON}/branches/${KUWAIT_CITY}`,
        headers: { authorization: `Bearer ${manager}` },
      });
      try {
        expect(closed.statusCode, closed.body).toBe(200);
        expect(JSON.parse(closed.body).tillsUnenrolled).toContain(`EN till ${RUN}`);

        // The enrolment is revoked, not deleted — the history survives.
        const [row] = await exec(sql`
          SELECT revoked_at IS NOT NULL AS revoked FROM device_enrolment
           WHERE device_id = ${DEVICE} ORDER BY created_at DESC LIMIT 1`);
        expect(row?.revoked).toBe(true);

        /**
         * THE REGRESSION LANE C DROVE. Before the cascade this charge answered
         * `404 unknown_branch` — `resolveBranch` requires `closed_at IS NULL` on
         * a supplied branch — and the till was a dead counter. It now falls back
         * to unenrolled and takes the payment.
         */
        const scanner = (
          await issue(db, {
            principalKind: 'staff',
            staffId: MANAGER,
            salonId: SALON,
            scope: 'scanner',
            deviceId: DEVICE,
          })
        ).accessToken;
        const wt = await get('/members/me/wallet-token', memberToken);
        const charge = await app.inject({
          method: 'POST',
          url: '/charges',
          headers: {
            authorization: `Bearer ${scanner}`,
            'idempotency-key': `en-ab-chg-${RUN}-${Math.random().toString(36).slice(2)}`,
          },
          payload: {
            memberId: MEMBER,
            serviceIds: [SVC],
            token: JSON.parse(wt.body).token,
            confirmDuplicate: true,
          },
        });
        expect(charge.statusCode, charge.body).toBe(200);
      } finally {
        await db.execute(sql`UPDATE branch SET closed_at = NULL WHERE id = ${KUWAIT_CITY}`);
      }
    });

    /**
     * THE INVARIANT THE CASCADE BUYS, asserted over the whole table rather than
     * over this run's rows: no LIVE enrolment may point at a closed branch. That
     * is what makes `resolveBranch`'s throw unreachable through the product's own
     * paths, and it is why the throw was left strict rather than softened into a
     * silent fallback.
     */
    it('no live enrolment anywhere points at a closed branch', async () => {
      const n = await scalar(sql`
        SELECT count(*) AS n
          FROM device_enrolment d
          JOIN branch b ON b.id = d.branch_id
         WHERE d.revoked_at IS NULL AND b.closed_at IS NOT NULL`);
      expect(n).toBe('0');
    });
  });
});
