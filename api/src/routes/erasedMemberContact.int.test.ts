/**
 * A TOMBSTONE IS NOT A PHONE NUMBER — the two booking surfaces.
 *                                            (DECISIONS.md #100)
 *
 * `services/erasure.ts § tombstonePhone` mints `+990` and twelve random digits
 * because `member.phone` is `NOT NULL`, `CHECK`ed E.164 and unique per salon —
 * erasure cannot clear the column, so it overwrites it with a well-formed number
 * in an unassigned country code. Storing that is correct. SERVING it is not, and
 * three merchant reads that join `member` live did exactly that in a field the
 * wire calls `memberPhone`:
 *
 *   GET /v1/salons/{id}/orders     the fulfilment board. Lane C's dashboard
 *                                  rendered `href="tel:+990224285141169"` beside
 *                                  a row reading "Deleted account". Covered by
 *                                  `services/erasureAddress.int.test.ts`, whose
 *                                  assertion used to pin the bug as expected.
 *   GET /salons/{id}/bookings      the merchant appointments board.   ← here
 *   GET /artists/me/bookings       the artist's day.                  ← here
 *
 * THIS FILE EXISTS FOR THE SECOND AND THIRD, WHICH HAD NO COVERAGE AT ALL. The
 * third is the sharp one: the scanner turns `memberPhone` into a `tel:` AND a
 * `https://wa.me/<digits>` button, so that surface does not merely display an
 * unreachable number, it offers to message it.
 *
 * BOTH HALVES OF THE CONTRACT, ON BOTH ENDPOINTS, and neither is redundant:
 *
 *   memberPhone: null    the tombstone does not travel in a phone field. There
 *                        is no dialable fallback to degrade to, and rendering
 *                        the digits as plain text is barely better than linking
 *                        them — a merchant can still copy them into a handset.
 *   memberErased: true   `null` alone would later be indistinguishable from "no
 *                        phone on file", and a client needs to know WHY to write
 *                        honest copy. Without it the only client-side detection
 *                        is string-matching `+990` or `'Deleted account'`, which
 *                        rots the moment either constant changes.
 *   memberName           UNCHANGED, still the tombstone. Asserted, not assumed:
 *                        "Deleted account" is what these boards should say, and
 *                        a fix that blanked the name too would be a regression
 *                        wearing a privacy costume.
 *
 * A LIVE MEMBER IS IN EVERY SPEC, ON THE SAME PAGE, ON THE SAME ARTIST. An
 * endpoint that nulled `memberPhone` for everybody would satisfy every erased-row
 * assertion in this file. The contrast row is the only thing that separates "the
 * tombstone is withheld" from "the phone column stopped working", and it is the
 * assertion that would have caught a mistake in the serializer rather than in the
 * query.
 *
 * AND THE DATABASE IS READ BACK. The tombstone must still BE there — the column
 * is `NOT NULL` and the scrub depends on it. "The wire is clean" and "the row was
 * emptied" are different claims and only one of them is the fix.
 *
 * ---------------------------------------------------------------------------
 * FIXTURES — synthetic bookings, and the reason is `bookingsPaging.int.test.ts`'s
 * ---------------------------------------------------------------------------
 * The bookings here are inserted directly rather than driven through
 * `POST /bookings`. `hold_transaction_id` is `NOT NULL` and one synthetic
 * transaction is shared by both bookings, exactly as `bookingsPaging` does and
 * for its stated reason: nothing in this file reads the hold, and minting real
 * deposit holds would write ledger pairs into an append-only table to test a
 * SELECT list.
 *
 * `completed`, NOT `deposit_held`, and that is forced rather than chosen twice
 * over. `runErasureOnce` DEFERS a member who has a `deposit_held` booking
 * (`deferred_escrow`) — escrow is her money and erasure will not strand it — so
 * an erased member with a live deposit cannot exist. And `GET /artists/me/bookings`
 * filters to `deposit_held` and `completed`, so `completed` is the one status
 * that is both reachable after erasure and visible on the artist's day.
 *
 * A FRESH MEMBER PER RUN, for `erasureAddress.int.test.ts`'s reason: erasure is
 * the one irreversible act in this codebase, and a suite that erased a SEEDED
 * member would work once and hand every later run — and every other int suite
 * sharing the lane database — a tombstone where its fixture used to be.
 *
 * `EC-` namespace, per-run suffix. `EN-` is `bookingsPaging`, `IT-` is `metrics`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

const INT_URL = process.env.AVO_INT_DATABASE_URL;
const suite = INT_URL ? describe : describe.skip;

const SALON = 'SAL-AMARA';
const BRANCH = 'BR-SAL';
/** Seeded manager, every permission — the appointments board is gated on `perms.appointments`. */
const MANAGER = 'ST-001';
/**
 * Seeded frontdesk Hessa, and the ONLY seeded staff user with an `artist` row
 * hanging off her (`artist.staff_user_id` = 'ST-002' on AR-003). That link is
 * what makes `GET /artists/me/bookings` reachable at all: the handler resolves
 * the artist from the principal, and a staff account with no artist row is a
 * 404 `not_an_artist` rather than a day.
 */
const SCANNER_STAFF = 'ST-002';
const ARTIST = 'AR-003';
/** The seeded till. A scanner session is device-scoped or the CHECK refuses it. */
const SCANNER_DEVICE = 'DEV-SCANNER-01';

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
const ERASED = `EC-M-DEAD-${RUN}`;
const LIVE = `EC-M-LIVE-${RUN}`;
const SVC = `EC-SV-${RUN}`;
const HOLD = `EC-TX-HOLD-${RUN}`;
const SETTLED = `EC-TX-SETTLED-${RUN}`;
const BK_ERASED = `EC-BK-DEAD-${RUN}`;
const BK_LIVE = `EC-BK-LIVE-${RUN}`;

/**
 * HER REAL NUMBER, and it is a needle rather than a plausible one. The specs
 * below grep whole response bodies, and a realistic `+9655...` would collide with
 * a seeded member's number and report a leak that is not there — the failure mode
 * `erasureAddress.int.test.ts` records against a `block` of `'4'`. The last eight
 * digits are the run stamp, so nothing else in the salon can produce them.
 */
const LIVE_PHONE = `+9657${String(Date.now() % 10_000_000).padStart(7, '0')}`;

interface BoardRow {
  id: string;
  memberName: string;
  memberPhone: string | null;
  memberErased: boolean;
  memberTier: string;
}

suite('an erased member reaches the two booking boards as a tombstone, not a contact', () => {
  let app: FastifyInstance;
  let db: (typeof import('../db/client'))['db'];
  let sql: (typeof import('drizzle-orm'))['sql'];
  let erasure: typeof import('../services/erasure');

  let managerBearer = '';
  let scannerBearer = '';
  /** Read back from the row after the job, never assumed to be `+990`-shaped. */
  let tombstonePhone = '';

  const exec = async (q: unknown) =>
    (await db.execute(q as never)) as unknown as Array<Record<string, unknown>>;

  beforeAll(async () => {
    db = (await import('../db/client')).db;
    sql = (await import('drizzle-orm')).sql;
    erasure = await import('../services/erasure');
    const issue = (await import('../auth/sessions')).issueSession;
    app = await (await import('../app')).buildApp();

    /**
     * BALANCE ZERO ON BOTH, which is a precondition rather than a convenience.
     * `runErasureOnce` DEFERS a member with `balance_fils > 0` — her money is
     * hers — so a fixture with a balance would silently produce a member who was
     * never erased, and every assertion below would then be about a live row.
     * Zero also keeps `verify-constraints.sql` invariant 5 satisfied without
     * inventing ledger entries: nothing to reconcile against.
     */
    await exec(sql`
      INSERT INTO member (id, salon_id, name, phone, password_hash, balance_fils, tier, visits, policy_version)
      VALUES
        (${ERASED}, ${SALON}, 'EC Erasure Subject',
         ${`+9656${String((Date.now() + 1) % 10_000_000).padStart(7, '0')}`},
         '$argon2id$int-test-not-a-real-hash', 0, 'silver', 3, 1),
        (${LIVE}, ${SALON}, 'EC Live Member', ${LIVE_PHONE},
         '$argon2id$int-test-not-a-real-hash', 0, 'bronze', 1, 1)`);

    await exec(sql`
      INSERT INTO service (id, salon_id, name, price_fils)
      VALUES (${SVC}, ${SALON}, ${`EC Svc ${RUN}`}, 5000)`);

    /**
     * TWO TRANSACTIONS, because `booking_settlement_matches_status` makes the
     * pair a state machine the database enforces: `completed` requires a
     * non-null `settled_transaction_id`, and `deposit_held` requires a null one.
     * The hold is the deposit that paid for the booking; the settlement is the
     * charge that consumed it. Both are shared by both bookings — see the header.
     */
    await exec(sql`
      INSERT INTO "transaction"
        (id, member_id, salon_id, branch_id, kind, amount_fils, method, status, reference, created_at, settled_at)
      VALUES
        (${HOLD}, ${ERASED}, ${SALON}, ${BRANCH}, 'deposit_hold', -5000, 'wallet', 'settled', '', now(), now()),
        (${SETTLED}, ${ERASED}, ${SALON}, ${BRANCH}, 'charge', -5000, 'wallet', 'settled', '', now(), now())`);

    /**
     * BOTH ON THE SAME ARTIST, an hour apart. Same artist because the artist-day
     * endpoint resolves ONE artist from the principal and the contrast row has to
     * be on the same list; an hour apart because
     * `booking_artist_slot_no_overlap` is an `EXCLUDE USING gist` over the real
     * time range and would refuse two overlapping rows on AR-003.
     *
     * FAR IN THE FUTURE so both land on page 1 of `starts_at DESC` regardless of
     * what else the seed has put on this salon's board, and comfortably inside
     * the artist day's `starts_at >= now() - 24h` window.
     */
    await exec(sql`
      INSERT INTO booking
        (id, salon_id, branch_id, branch_assumed, member_id, artist_id, service_id,
         starts_at, ends_at, duration_min, deposit_fils, status,
         hold_transaction_id, settled_transaction_id, completed_at, no_show_return_due_at)
      VALUES
        (${BK_ERASED}, ${SALON}, ${BRANCH}, false, ${ERASED}, ${ARTIST}, ${SVC},
         now() + interval '300 days', now() + interval '300 days 30 minutes',
         30, 5000, 'completed', ${HOLD}, ${SETTLED}, now(), now() + interval '300 days 1 hour'),
        (${BK_LIVE}, ${SALON}, ${BRANCH}, false, ${LIVE}, ${ARTIST}, ${SVC},
         now() + interval '301 days', now() + interval '301 days 30 minutes',
         30, 5000, 'completed', ${HOLD}, ${SETTLED}, now(), now() + interval '301 days 1 hour')`);

    managerBearer = (
      await issue(db, { principalKind: 'staff', staffId: MANAGER, salonId: SALON, scope: 'dashboard' })
    ).accessToken;
    /**
     * `deviceId` IS NOT OPTIONAL HERE — `session_scanner_is_device_scoped`
     * refuses a scanner session without one, on the grounds that "a scanner
     * session without a device id is a bearer credential anyone can replay from
     * anywhere". `DEV-SCANNER-01` is the seeded till both PINs are enrolled on.
     */
    scannerBearer = (
      await issue(db, {
        principalKind: 'staff',
        staffId: SCANNER_STAFF,
        salonId: SALON,
        scope: 'scanner',
        deviceId: SCANNER_DEVICE,
      })
    ).accessToken;

    // ------------------------------------------- the clock, then the real job --
    await exec(sql`
      UPDATE member
         SET deletion_requested_at = now() - interval '31 days',
             deletion_due_at       = now() - interval '1 day'
       WHERE id = ${ERASED}`);

    const result = await erasure.runErasureOnce(db, 500);
    expect(result.failed, `the job reported failures: ${JSON.stringify(result)}`).toBe(0);

    /**
     * THE JOB ACTUALLY RAN ON HER, read back rather than inferred from the run
     * counters — another lane's fixture could have been the one erased. If she is
     * still live, every spec below asserts nothing and must not be allowed to
     * pass quietly.
     */
    const [after] = await exec(sql`
      SELECT erased_at, name, phone FROM member WHERE id = ${ERASED}`);
    if (!after?.['erased_at']) {
      throw new Error(
        `${ERASED} was not erased — ${JSON.stringify(result)}. Every spec below would ` +
          `then be about a live member and would pass for the wrong reason.`,
      );
    }
    tombstonePhone = String(after['phone']);
  });

  afterAll(async () => {
    if (db) {
      await exec(sql`DELETE FROM booking WHERE id IN (${BK_ERASED}, ${BK_LIVE})`);
      await exec(sql`DELETE FROM "transaction" WHERE id IN (${HOLD}, ${SETTLED})`);
      await exec(sql`DELETE FROM service WHERE id = ${SVC}`);
      await exec(sql`DELETE FROM member WHERE id IN (${ERASED}, ${LIVE})`);
    }
    await app?.close();
  });

  // ------------------------------------------------ the database still has it --

  it('the tombstone is still IN the row — this is not a fix that emptied the column', async () => {
    /**
     * `member.phone` is `NOT NULL`, `CHECK`ed E.164 and unique per salon, which is
     * the whole reason erasure writes `+990` instead of clearing it. If a later
     * change "fixed" this defect at the storage layer the INSERT constraint would
     * break somewhere else entirely, so the storage claim is asserted separately
     * from the wire claim.
     */
    expect(tombstonePhone).toMatch(/^\+990\d+$/);
    const [row] = await exec(sql`SELECT name FROM member WHERE id = ${ERASED}`);
    expect(row?.['name']).toBe(erasure.TOMBSTONE_NAME);
  });

  // ------------------------------------- GET /salons/{id}/bookings — merchant --

  it('the merchant appointments board serves no tombstone number', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/salons/${SALON}/bookings`,
      headers: { authorization: `Bearer ${managerBearer}` },
    });
    expect(res.statusCode, res.body).toBe(200);
    const items = JSON.parse(res.body).items as BoardRow[];

    const dead = items.find((b) => b.id === BK_ERASED);
    if (!dead) throw new Error('her booking is not on the board at all, which asserts nothing');

    expect(dead.memberName, 'the tombstone NAME is what this board should say').toBe(
      erasure.TOMBSTONE_NAME,
    );
    expect(
      dead.memberPhone,
      'the +990 tombstone is on the merchant board in a field the wire calls a phone number',
    ).toBeNull();
    expect(
      dead.memberErased,
      'null alone is indistinguishable from "no phone on file" — the flag is why a ' +
        'client does not have to string-match +990 to render honest copy',
    ).toBe(true);

    /**
     * THE CONTRAST, on the same response. Without it an endpoint that nulled
     * `memberPhone` unconditionally would pass every assertion above.
     */
    const alive = items.find((b) => b.id === BK_LIVE);
    if (!alive) throw new Error('the live member is not on the board; the contrast is missing');
    expect(alive.memberErased).toBe(false);
    expect(
      alive.memberPhone,
      'a live customer STILL has a phone number here — the merchant has to be able to call her',
    ).toBe(LIVE_PHONE);
    expect(alive.memberName).toBe('EC Live Member');
  });

  it('no component of the tombstone number reaches the merchant board by any key', async () => {
    /**
     * THE WHOLE-BODY FORM, for the reason `erasureAddress.int.test.ts` gives: a
     * field this suite does not know about is the same leak arriving through a
     * different door. A future `memberContact` object, or a debug echo, would pass
     * the row assertions above and fail here.
     */
    const res = await app.inject({
      method: 'GET',
      url: `/salons/${SALON}/bookings`,
      headers: { authorization: `Bearer ${managerBearer}` },
    });
    expect(res.body.includes(tombstonePhone), 'her tombstone number is in the body').toBe(false);
    expect(res.body.includes('+990'), 'SOME tombstone number is in the body').toBe(false);
  });

  // -------------------------------------- GET /artists/me/bookings — the artist --

  it("the artist's day serves no tombstone number — the surface that MESSAGES it", async () => {
    /**
     * `apps/scanner/src/screens/BookingsScreen.tsx` builds both a `tel:` and a
     * `https://wa.me/<digits>` action from this field. Every other surface
     * displayed a number that reaches nobody; this one offered to send to it.
     */
    const res = await app.inject({
      method: 'GET',
      url: '/artists/me/bookings',
      headers: { authorization: `Bearer ${scannerBearer}` },
    });
    expect(res.statusCode, res.body).toBe(200);
    const items = JSON.parse(res.body).items as BoardRow[];

    const dead = items.find((b) => b.id === BK_ERASED);
    if (!dead) throw new Error('her booking is not on the artist day at all, which asserts nothing');

    expect(dead.memberName).toBe(erasure.TOMBSTONE_NAME);
    expect(
      dead.memberPhone,
      'the scanner would turn this into a wa.me link to an unassigned country code',
    ).toBeNull();
    expect(dead.memberErased).toBe(true);
    /**
     * HER TIER SURVIVES, and it is asserted because it is the boundary of the
     * change. `tier` and `visits` are aggregates on a row that now names nobody —
     * erasure keeps them deliberately — so a change that swept "everything about
     * an erased member" off this endpoint would have gone too far.
     */
    expect(dead.memberTier).toBe('silver');

    const alive = items.find((b) => b.id === BK_LIVE);
    if (!alive) throw new Error('the live member is not on the artist day; the contrast is missing');
    expect(alive.memberErased).toBe(false);
    expect(alive.memberPhone).toBe(LIVE_PHONE);

    expect(res.body.includes(tombstonePhone), 'her tombstone number is in the body').toBe(false);
    expect(res.body.includes('+990'), 'SOME tombstone number is in the body').toBe(false);
  });
});
