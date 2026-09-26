/**
 * THE MERCHANT BELL — `GET /v1/salons/{id}/notifications` and
 * `POST /v1/salons/{id}/notifications/read`.
 *
 * `services/merchantNotifications.ts` carries the two decisions — the per-kind
 * permission filter and what the feed and the count each contain with respect to
 * `read_at` and `resolved_at`. This file is the evidence that each one holds
 * against a row.
 *
 * WHY THESE ARE INTEGRATION SPECS. `services/merchantNotifications.test.ts` pins
 * `visibleKinds` and `safeDeepLink` as functions, and a correct filter that the
 * endpoint never consults is exactly the defect non-negotiable #7 is about. Every
 * claim below is a claim about a WHERE clause, a partial unique index, or an
 * UPDATE's scope, and none of them can be made against a stub.
 *
 * ===================== THE SEVEN INVERSIONS, AND WHAT THEY COST ==================
 * Nothing here is trusted because it went green. Each load-bearing claim was
 * anchored by BREAKING the code and confirming the spec goes red — and, where it
 * could be arranged, breaking it so the endpoint returns THE WRONG ANSWER rather
 * than an empty one, because an empty result is what a weak spec accidentally
 * agrees with. The counts below are what the runs printed.
 *
 *   1. THE PERMISSION FILTER ON THE READ.  `visibilityPredicate` forced to
 *      `sql`true``, which IS the ungated bell the service header argues against.
 *      → 7 red, and they are WRONG-ANSWER reds rather than empty ones. The
 *        `scanner`-only stylist — no `team`, no `appointments`, no `marketing` —
 *        receives all five of this run's rows: `expected [ { …(9) }, { …(9) },
 *        { …(9) }, …(2) ] to deeply equal []`. Among them is the no-show body
 *        carrying a customer's NAME, which is the leak stated in decision 96's
 *        terms. The marketing-only reader's assertion prints the same shape from
 *        the other side: `expected [ …(5) ] to deeply equal [ 'AC Bell campaign
 *        … ' ]`.
 *
 *   2. THE PERMISSION FILTER ON THE WRITE.  `visibilityPredicate` removed from the
 *      UPDATE only, leaving the READ correct.
 *      → 2 red, and this is the inversion most worth having. The feed stayed right
 *        the whole time, so a suite that probed only `GET` would have been green
 *        while the front desk's "Mark all read" cleared `campaign_held`:
 *        `a front desk with no marketing permission cleared a held campaign:
 *        expected '2026-09-26 05:19:43.674+00' to be null`.
 *
 *   3. THE SALON PREDICATE ON THE READ.  `eq(merchantNotification.salonId,
 *      p.salonId)` deleted from the feed's WHERE.
 *      → 4 red, wrong answer again: `expected [ 'AC Bell lumiere …', …(5) ] to not
 *        include 'AC Bell lumiere …'`. `requireSameSalon` does NOT catch this —
 *        both managers are asking about their own salon in the path — which is
 *        exactly why the predicate is doubled. The paging spec caught it
 *        independently, which is the point of asserting on the walk as well as on
 *        the first page.
 *
 *   4. `resolved_at IS NULL` DROPPED FROM THE COUNT.
 *      → 2 red. Resolving the one open unread row stops moving the badge at all
 *        (`expected +0 to be 1`): a calendar that reconnected goes on demanding
 *        attention. The FEED stays correct throughout, so only the count specs see
 *        it — which is the case for counting in the endpoint rather than trusting
 *        `items.length`, and the second red is precisely that spec.
 *
 *   5. `read_at IS NULL` DROPPED FROM THE UPDATE.
 *      → 1 red, and the number is the interesting part. It was FOUR before the
 *        `beforeEach` above existed, and three of those four were bookkeeping: the
 *        idempotence spec failed, vitest abandoned it before its trailing cleanup,
 *        and three later specs then failed against a row left read. The inversion
 *        run is what exposed that, the fixture was changed to reset forward, and
 *        the honest count is one. `a repeat marked a row that was already read:
 *        expected 1 to be +0` — and the same spec pins that the first call's
 *        timestamp is not overwritten, which `unreadCount: 0` on both calls would
 *        have missed entirely.
 *
 *   6. THE PARTIAL INDEX'S PREDICATE.  `where: sql`resolved_at IS NULL`` removed
 *      from `raiseMerchantNotification`'s `onConflictDoNothing` — the only
 *      inversion outside this slice's own files, and reverted immediately.
 *      → 2 red, and NOT the failure predicted. The expectation was a duplicate
 *        row; what actually happens is `42P10`, *"there is no unique or exclusion
 *        constraint matching the ON CONFLICT specification"* — Postgres finds no
 *        arbiter index at all, so the INSERT THROWS on a customer-facing
 *        availability read rather than quietly duplicating. `services/
 *        notifications.ts` already says this in so many words; the inversion is
 *        recorded because the PREDICTION WAS WRONG and the real failure mode is
 *        louder and lands somewhere else entirely.
 *
 *   7. THE SURFACE WALL.  `requireDashboardScope` widened to
 *      `requireStaff(req, 'either')`, which admits a scanner PIN session.
 *      → 1 red, and it is the wrong answer in the fullest sense: the salon-floor
 *        tablet receives the entire back-office bell — nine rows, `unreadCount: 7`,
 *        `visibleKinds` all three — including verbatim *"Latifa Al-Ayyar did not
 *        arrive for her appointment, and the 5.000 KD deposit has been returned to
 *        her wallet."* A customer's name and her balance, on a device that lives
 *        unattended on a counter.
 *
 *        THIS SPEC AND THIS INVERSION BOTH EXIST BECAUSE THE PERMISSION AUDIT
 *        ASKED FOR THEM. Every other spec in this file probes AUTHORITY, and the
 *        per-kind filter is what enforces that. The filter says nothing whatever
 *        about which SURFACE is asking — a scanner session for someone holding
 *        `appointments` passes `visibleKinds` without complaint. Only
 *        `requireDashboardScope`, running first, is the wall, and nothing here had
 *        been pointed at it.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { NOTIFICATION_PAGE_SIZE } from '../services/merchantNotifications';

const INT_URL = process.env.AVO_INT_DATABASE_URL;
const suite = INT_URL ? describe : describe.skip;

const SALON = 'SAL-AMARA';
const OTHER_SALON = 'SAL-LUMIERE';

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
const id = (tag: string) => `BN-${tag}-${RUN}`;

/**
 * FIVE STAFF ROWS, MINTED FOR THIS RUN, AND THE SHAPES ARE THE ARGUMENT.
 *
 * The seeded staff cannot carry this file: the filter's whole subject is what
 * happens when a reader holds exactly ONE of `team`, `appointments` and
 * `marketing`, and the seed has nobody in three of those four shapes. Minting them
 * also keeps the suite idempotent — every assertion below is scoped to `RUN`, so a
 * re-run reads none of the previous run's rows.
 */
const OWNER = id('ST-OWNER'); // team + appointments + marketing — sees all three
const FRONTDESK = id('ST-FRONT'); // appointments only
const MANAGER = id('ST-MGR'); // team only
const MARKETER = id('ST-MKT'); // marketing only
const STYLIST = id('ST-STYL'); // scanner + charges — the leak probe, sees nothing
const LUMIERE = id('ST-LUM'); // all three, at the OTHER salon

/**
 * THE ROWS. `NT-` ids are minted from a sequence in production
 * (`services/ids.ts`); these are written directly so the fixture can place
 * `created_at`, `read_at` and `resolved_at` exactly, which is what makes the
 * read-versus-resolved claims falsifiable rather than incidental.
 */
const N_CAL = id('NT-CAL'); // calendar_disconnected, open, unread    → team
const N_CAL_RESOLVED = id('NT-CALR'); // calendar_disconnected, RESOLVED, never read
const N_NOSHOW = id('NT-NOSHOW'); // booking_no_show, open, unread     → appointments
const N_CAMPAIGN = id('NT-CAMP'); // campaign_held, open, unread       → marketing
const N_BADLINK = id('NT-BAD'); // booking_no_show carrying a hostile deep_link
const N_LUMIERE = id('NT-LUM'); // at the other salon entirely

interface BellRow {
  id: string;
  kind: string;
  severity: string;
  title: string;
  body: string;
  deepLink: string | null;
  createdAt: string;
  readAt: string | null;
  resolvedAt: string | null;
}
interface Bell {
  items: BellRow[];
  nextCursor: string | null;
  unreadCount: number;
  visibleKinds: string[];
}

suite('the merchant notification bell', () => {
  let app: FastifyInstance;
  let db: (typeof import('../db/client'))['db'];
  let sql: (typeof import('drizzle-orm'))['sql'];
  const token: Record<string, string> = {};

  beforeAll(async () => {
    db = (await import('../db/client')).db;
    sql = (await import('drizzle-orm')).sql;
    const issue = (await import('../auth/sessions')).issueSession;
    app = await (await import('../app')).buildApp();

    const staff = (
      sid: string,
      salon: string,
      team: boolean,
      appts: boolean,
      mkt: boolean,
      scanner = false,
      charges = false,
    ) => sql`(${sid}, ${salon}, ${`AC Bell ${sid}`}, ${sid.toLowerCase()}, 'manager', true, '{}',
              'x', true, ${appts}, false, false, ${team}, ${scanner}, ${charges}, false, ${mkt})`;

    await db.execute(sql`
      INSERT INTO staff_user
        (id, salon_id, name, handle, role, branch_access_all, branch_access_ids,
         password_hash, perm_dashboard, perm_appointments, perm_shop, perm_loyalty,
         perm_team, perm_scanner, perm_charges, perm_void, perm_marketing)
      VALUES
        ${staff(OWNER, SALON, true, true, true)},
        ${staff(FRONTDESK, SALON, false, true, false)},
        ${staff(MANAGER, SALON, true, false, false)},
        ${staff(MARKETER, SALON, false, false, true)},
        ${staff(STYLIST, SALON, false, false, false, true, true)},
        ${staff(LUMIERE, OTHER_SALON, true, true, true)}`);

    /**
     * `subject_id` CARRIES `RUN` ON EVERY ROW, and that is not decoration. The
     * open-uniqueness index is `(salon_id, kind, subject_type, subject_id) WHERE
     * resolved_at IS NULL` — two runs raising `('artist', 'AR-001')` would collide
     * across runs, and the second run would fail to insert rather than fail an
     * assertion. Per-run subjects make this file re-runnable, which is what
     * `api/README.md` asks of the suite.
     *
     * THE BODIES ARE WRITTEN IN THE SHAPE THE PRODUCT WRITES THEM.
     * `noShowWorker.ts:168` interpolates a member's NAME into the no-show body, so
     * this fixture does too — the leak inversion is only legible if the row that
     * leaks contains the thing that must not leak.
     */
    await db.execute(sql`
      INSERT INTO merchant_notification
        (id, salon_id, kind, severity, title, body, subject_type, subject_id,
         deep_link, metadata, created_at, read_at, resolved_at)
      VALUES
        (${N_CAL}, ${SALON}, 'calendar_disconnected', 'warning',
         ${`AC Bell calendar ${RUN}`},
         'Rana Al-Sabah''s hours are set to sync from Google, and AVO cannot reach that calendar.',
         'artist', ${id('AR-1')}, '/merchant/team/AR-001', '{}'::jsonb,
         '2026-09-20T08:00:00Z', NULL, NULL),

        (${N_CAL_RESOLVED}, ${SALON}, 'calendar_disconnected', 'warning',
         ${`AC Bell calendar resolved ${RUN}`},
         'Her calendar was unreachable and is now connected again.',
         'artist', ${id('AR-2')}, '/merchant/team/AR-002', '{}'::jsonb,
         '2026-09-21T08:00:00Z', NULL, '2026-09-21T09:00:00Z'),

        (${N_NOSHOW}, ${SALON}, 'booking_no_show', 'info',
         ${`AC Bell no-show ${RUN}`},
         'Latifa Al-Ayyar did not arrive for her appointment, and the 5.000 KD deposit has been returned to her wallet.',
         'booking', ${id('BK-1')}, '/merchant/appointments/BK-1', '{}'::jsonb,
         '2026-09-22T08:00:00Z', NULL, NULL),

        (${N_CAMPAIGN}, ${SALON}, 'campaign_held', 'warning',
         ${`AC Bell campaign ${RUN}`},
         '"Eid offer" — outside the salon''s quiet hours window.',
         'campaign', ${id('CMP-1')}, '/marketing/campaigns', '{}'::jsonb,
         '2026-09-23T08:00:00Z', NULL, NULL),

        (${N_BADLINK}, ${SALON}, 'booking_no_show', 'info',
         ${`AC Bell hostile link ${RUN}`},
         'A row whose deep_link would navigate off this origin.',
         'booking', ${id('BK-2')}, '//evil.test/steal', '{}'::jsonb,
         '2026-09-24T08:00:00Z', NULL, NULL),

        (${N_LUMIERE}, ${OTHER_SALON}, 'booking_no_show', 'info',
         ${`AC Bell lumiere ${RUN}`},
         'A no-show that belongs to another salon entirely.',
         'booking', ${id('BK-3')}, '/merchant/appointments/BK-3', '{}'::jsonb,
         '2026-09-25T08:00:00Z', NULL, NULL)`);

    for (const [name, sid, salon] of [
      ['owner', OWNER, SALON],
      ['frontdesk', FRONTDESK, SALON],
      ['manager', MANAGER, SALON],
      ['marketer', MARKETER, SALON],
      ['stylist', STYLIST, SALON],
      ['lumiere', LUMIERE, OTHER_SALON],
    ] as const) {
      token[name] = (
        await issue(db, {
          principalKind: 'staff',
          staffId: sid,
          salonId: salon,
          scope: 'dashboard',
        })
      ).accessToken;
    }
  });

  /**
   * ==========================================================================
   * THE FIXTURE'S MUTABLE STATE IS RESET BEFORE EACH SPEC, NOT AFTER.
   * ==========================================================================
   * `read_at` and `resolved_at` are the two columns this suite writes, and several
   * specs write them on purpose. Cleaning up at the END of a spec looks equivalent
   * and is not: VITEST ABORTS A TEST AT ITS FIRST FAILED ASSERTION, so a trailing
   * `UPDATE … SET read_at = NULL` never runs on the run that matters — the red one.
   *
   * IT WAS THE INVERSION RUNS THAT EXPOSED THIS, which is the whole reason for
   * doing them. Inversion 5 (`read_at IS NULL` dropped from the UPDATE) reported
   * FOUR red where only ONE is a real detection: the idempotence spec failed, its
   * cleanup was skipped, and three later specs then failed against a row the
   * previous spec had left read. Three of those four reds were bookkeeping, not
   * evidence — and a count inflated that way is exactly the thing an inversion run
   * is supposed to stop anyone trusting.
   *
   * Resetting FORWARD makes each spec independent of whatever the last one did or
   * failed to undo, so a red count is a count of detections.
   */
  beforeEach(async () => {
    await db.execute(sql`
      UPDATE merchant_notification
         SET read_at = NULL,
             resolved_at = CASE WHEN id = ${N_CAL_RESOLVED} THEN '2026-09-21T09:00:00Z'::timestamptz
                                ELSE NULL END
       WHERE id IN (${N_CAL}, ${N_CAL_RESOLVED}, ${N_NOSHOW}, ${N_CAMPAIGN}, ${N_BADLINK}, ${N_LUMIERE})`);
  });

  afterAll(async () => {
    if (db) {
      await db.execute(sql`DELETE FROM merchant_notification WHERE id LIKE ${`BN-NT-%${RUN}`}`);
      await db.execute(sql`DELETE FROM merchant_notification WHERE subject_id LIKE ${`BN-%${RUN}`}`);
      await db.execute(sql`DELETE FROM staff_user WHERE id LIKE ${`BN-ST-%${RUN}`}`);
    }
    await app?.close();
  });

  /** This run's rows only — the table holds every previous run's and the seed's. */
  const mine = (b: Bell) => b.items.filter((r) => r.title.endsWith(RUN));
  const titles = (b: Bell) => mine(b).map((r) => r.title);

  async function bell(who: string, salon = SALON, query = ''): Promise<{ status: number; body: Bell }> {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/salons/${salon}/notifications${query}`,
      headers: { authorization: `Bearer ${token[who]}` },
    });
    return { status: res.statusCode, body: JSON.parse(res.body) };
  }

  async function markRead(who: string, payload: unknown, salon = SALON) {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/salons/${salon}/notifications/read`,
      headers: { authorization: `Bearer ${token[who]}` },
      payload: payload as object,
    });
    return { status: res.statusCode, body: JSON.parse(res.body) };
  }

  /**
   * Straight from the database, so a claim about `read_at` is not read through the
   * code under test — the filter and the serialiser are the things being doubted.
   *
   * THROWS ON A MISSING ROW rather than returning `undefined`. Every id handed to
   * this belongs to a fixture row, so absence is a broken fixture, and
   * `undefined?.read_at` would quietly satisfy a `toBeNull()` — a spec that passes
   * because the row it was asserting about is not there.
   */
  async function rowOf(nid: string): Promise<{ read_at: string | null; resolved_at: string | null }> {
    const r = await db.execute(
      sql`SELECT read_at, resolved_at FROM merchant_notification WHERE id = ${nid}`,
    );
    const row = (r as unknown as { read_at: string | null; resolved_at: string | null }[])[0];
    if (!row) throw new Error(`fixture row ${nid} is missing`);
    return row;
  }

  /** Same reason: a `find` that misses must fail loudly, not assert about `undefined`. */
  function rowIn(b: Bell, nid: string): BellRow {
    const row = b.items.find((r) => r.id === nid);
    if (!row) throw new Error(`${nid} is not in this feed`);
    return row;
  }

  // ======================================================================
  describe('permission-off, per kind — non-negotiable #7', () => {
    /**
     * THE THREE SINGLE-PERMISSION SHAPES. Each reader holds exactly one of the
     * three mapped permissions and must see exactly that kind. Asserted as an
     * EXACT set rather than with `toContain`, because the leak this guards is a
     * row that should not be there and `toContain` cannot see one.
     */
    it('appointments alone serves no-shows and neither of the other two', async () => {
      const { body } = await bell('frontdesk');
      expect(body.visibleKinds).toEqual(['booking_no_show']);
      expect(titles(body).sort()).toEqual(
        [`AC Bell hostile link ${RUN}`, `AC Bell no-show ${RUN}`].sort(),
      );
      expect(mine(body).every((r) => r.kind === 'booking_no_show')).toBe(true);
    });

    it('team alone serves disconnected calendars and neither of the other two', async () => {
      const { body } = await bell('manager');
      expect(body.visibleKinds).toEqual(['calendar_disconnected']);
      expect(mine(body).every((r) => r.kind === 'calendar_disconnected')).toBe(true);
      expect(titles(body)).not.toContain(`AC Bell campaign ${RUN}`);
      expect(titles(body)).not.toContain(`AC Bell no-show ${RUN}`);
    });

    it('marketing alone serves held campaigns and neither of the other two', async () => {
      const { body } = await bell('marketer');
      expect(body.visibleKinds).toEqual(['campaign_held']);
      expect(titles(body)).toEqual([`AC Bell campaign ${RUN}`]);
    });

    /**
     * THE LEAK, ASSERTED AS AN ABSENCE OF A CUSTOMER'S NAME. A stylist holding
     * `scanner` and `charges` is a real seeded shape. `booking_no_show`'s body is
     * a customer's name and a money fact, and this is the one spec that says so in
     * the terms decision 96 uses — "customer PII must not ride on the weakest gate
     * a screen happens to sit behind".
     */
    it('a reader with none of the three sees nothing, and 200 rather than 403', async () => {
      const { status, body } = await bell('stylist');
      expect(status).toBe(200);
      expect(body.visibleKinds).toEqual([]);
      expect(mine(body)).toEqual([]);
      expect(body.unreadCount).toBe(0);
      expect(JSON.stringify(body)).not.toContain('Latifa');
    });

    it('an owner holding all three sees all three kinds', async () => {
      const { body } = await bell('owner');
      expect(body.visibleKinds).toEqual([
        'calendar_disconnected',
        'booking_no_show',
        'campaign_held',
      ]);
      expect(new Set(mine(body).map((r) => r.kind))).toEqual(
        new Set(['calendar_disconnected', 'booking_no_show', 'campaign_held']),
      );
    });

    /**
     * `visibleKinds` IS THE HONEST HALF OF THE FILTER. The design's empty state is
     * "You're all caught up." — false when it means "the things waiting are things
     * you may not see". A client can only tell those apart from this field.
     */
    it('visibleKinds distinguishes a quiet bell from a narrowed one', async () => {
      expect((await bell('stylist')).body.visibleKinds).toEqual([]);
      expect((await bell('marketer')).body.visibleKinds).toEqual(['campaign_held']);
    });
  });

  // ======================================================================
  describe('salon scoping', () => {
    /**
     * THE WRONG-ANSWER SPEC. Not "the list is empty" — Lumière's row is named, in
     * both directions, so a deleted tenant predicate produces a visible stranger
     * rather than a shorter list.
     */
    it("another salon's notification never reaches this salon's bell", async () => {
      expect(titles((await bell('owner')).body)).not.toContain(`AC Bell lumiere ${RUN}`);
      const lum = await bell('lumiere', OTHER_SALON);
      expect(titles(lum.body)).toEqual([`AC Bell lumiere ${RUN}`]);
      expect(titles(lum.body)).not.toContain(`AC Bell no-show ${RUN}`);
    });

    it('asking about a salon that is not yours is 403 on both verbs', async () => {
      expect((await bell('owner', OTHER_SALON)).status).toBe(403);
      expect((await markRead('owner', { all: true }, OTHER_SALON)).status).toBe(403);
    });

    /**
     * THE PATH IS NOT THE SCOPE. Both readers ask about their OWN salon, so
     * `requireSameSalon` is satisfied for each and cannot be what separates them.
     * Only the doubled predicate in the WHERE can.
     */
    it('the tenant split survives when both sides ask about their own salon', async () => {
      const a = titles((await bell('owner')).body);
      const b = titles((await bell('lumiere', OTHER_SALON)).body);
      expect(a.some((t) => b.includes(t))).toBe(false);
    });
  });

  // ======================================================================
  describe('read versus resolved — what the feed holds and what the badge counts', () => {
    /**
     * THE BRIEF'S CASE, EXACTLY: a calendar that reconnects before anyone looks.
     * Resolved, never read. It must be IN the feed and OUT of the badge — "the row
     * does not vanish; it stops shouting".
     */
    it('a resolved, never-read row is in the feed', async () => {
      const row = rowIn((await bell('manager')).body, N_CAL_RESOLVED);
      expect(row.resolvedAt, 'the resolved row lost its resolvedAt').not.toBeNull();
      expect(row.readAt).toBeNull();
    });

    it('a resolved, never-read row is not in the badge', async () => {
      // `manager` holds `team` only, so her two visible rows are N_CAL (open)
      // and N_CAL_RESOLVED (resolved). Exactly one of them may be counted.
      const { body } = await bell('manager');
      const visible = mine(body);
      expect(visible.map((r) => r.id).sort()).toEqual([N_CAL, N_CAL_RESOLVED].sort());
      expect(body.unreadCount).toBeGreaterThanOrEqual(1);

      // Isolate this run's contribution by resolving the open one and re-reading.
      const before = body.unreadCount;
      await db.execute(
        sql`UPDATE merchant_notification SET resolved_at = now() WHERE id = ${N_CAL}`,
      );
      const after = (await bell('manager')).body.unreadCount;
      expect(
        before - after,
        'resolving the one open unread row must drop the badge by exactly one',
      ).toBe(1);

      // And it is still in the feed, which is the other half of the same decision.
      expect(mine((await bell('manager')).body).map((r) => r.id)).toContain(N_CAL);
    });

    /**
     * READ ALSO LEAVES THE BADGE, and by the same arithmetic — so the count is
     * `read IS NULL AND resolved IS NULL` and not either one alone.
     */
    it('reading an open row drops the badge by one and leaves it in the feed', async () => {
      const before = (await bell('marketer')).body.unreadCount;
      await markRead('marketer', { ids: [N_CAMPAIGN] });
      const after = await bell('marketer');
      expect(before - after.body.unreadCount).toBe(1);
      expect(rowIn(after.body, N_CAMPAIGN).readAt).not.toBeNull();
    });

    it('the count is not the length of the page', async () => {
      const { body } = await bell('owner');
      expect(body.unreadCount).not.toBe(body.items.length);
    });
  });

  // ======================================================================
  describe('the unique-open-row property', () => {
    /**
     * THE DEDUP, AGAINST THE INDEX. `raiseMerchantNotification` is called from a
     * customer-facing READ path — `GET /artists/{id}/availability` — so a
     * disconnected calendar is re-raised on every availability check. The property
     * that keeps the bell usable is the database's, not a cache's.
     */
    it('raising the same subject twice while open writes one row', async () => {
      const { raiseMerchantNotification } = await import('../services/notifications');
      const subject = id('AR-DEDUP');
      const input = {
        salonId: SALON,
        kind: 'calendar_disconnected' as const,
        title: `AC Bell dedup ${RUN}`,
        body: 'raised twice',
        subjectType: 'artist',
        subjectId: subject,
      };

      expect(await raiseMerchantNotification(db, input)).toBe(true);
      expect(await raiseMerchantNotification(db, input)).toBe(false);
      expect(await raiseMerchantNotification(db, input)).toBe(false);

      const rows = await db.execute(
        sql`SELECT count(*)::int AS n FROM merchant_notification WHERE subject_id = ${subject}`,
      );
      expect((rows as unknown as { n: number }[])[0]!.n).toBe(1);
    });

    /**
     * AND THE OTHER HALF, WHICH MATTERS AS MUCH. A calendar that disconnects, is
     * fixed, and disconnects again is TWO events. Resolving frees the partial
     * index, so the second disconnect raises rather than being deduplicated
     * against a stale fact — the property `services/notifications.ts` names as the
     * reason the index is partial at all.
     */
    it('resolving frees the index so a later disconnect raises again', async () => {
      const { raiseMerchantNotification, resolveMerchantNotification } = await import(
        '../services/notifications'
      );
      const subject = id('AR-RERAISE');
      const key = {
        salonId: SALON,
        kind: 'calendar_disconnected' as const,
        subjectType: 'artist',
        subjectId: subject,
      };

      expect(await raiseMerchantNotification(db, { ...key, title: `AC Bell reraise ${RUN}`, body: 'one' })).toBe(true);
      await resolveMerchantNotification(db, key);
      expect(await raiseMerchantNotification(db, { ...key, title: `AC Bell reraise ${RUN}`, body: 'two' })).toBe(true);

      const rows = await db.execute(
        sql`SELECT count(*)::int AS n FROM merchant_notification WHERE subject_id = ${subject}`,
      );
      expect((rows as unknown as { n: number }[])[0]!.n).toBe(2);
    });

    /**
     * THE INDEX IS A DATABASE CONSTRAINT, NOT A CONVENTION. Asserted by writing
     * around the helper entirely: a raw INSERT of a second OPEN row for one subject
     * must be rejected. If this ever passes, the helper's `ON CONFLICT` has nothing
     * behind it and a hot read path can flood the bell.
     */
    it('the database itself refuses a second open row for one subject', async () => {
      const subject = id('AR-RAW');
      const insert = (nid: string) =>
        db.execute(sql`
          INSERT INTO merchant_notification
            (id, salon_id, kind, severity, title, body, subject_type, subject_id, metadata)
          VALUES (${nid}, ${SALON}, 'calendar_disconnected', 'warning',
                  ${`AC Bell raw ${RUN}`}, 'raw', 'artist', ${subject}, '{}'::jsonb)`);

      await insert(id('NT-RAW1'));
      await expect(insert(id('NT-RAW2'))).rejects.toThrow();
    });
  });

  // ======================================================================
  describe('marking read', () => {
    it('is idempotent: the second call marks nothing and keeps the first timestamp', async () => {
      const first = await markRead('marketer', { ids: [N_CAMPAIGN] });
      expect(first.status).toBe(200);
      expect(first.body.marked).toBe(1);
      const stamp = (await rowOf(N_CAMPAIGN)).read_at;
      expect(stamp).not.toBeNull();

      const second = await markRead('marketer', { ids: [N_CAMPAIGN] });
      expect(second.body.marked, 'a repeat marked a row that was already read').toBe(0);
      expect(second.body.unreadCount).toBe(first.body.unreadCount);
      expect(
        (await rowOf(N_CAMPAIGN)).read_at,
        'the second call rewrote when this was first seen',
      ).toEqual(stamp);
    });

    /**
     * ============================================================
     * THE SHARP EDGE OF SALON-WIDE `read_at`, AND THE SPEC THAT BOLTS IT.
     * ============================================================
     * `read_at` is one column, so read is a fact about the SALON. Mark-all is
     * therefore the one place a reader can act on a row she cannot see — and if it
     * did, a front desk holding `appointments` alone would silence the marketing
     * manager's badge for a campaign she was never shown.
     */
    it('mark-all only marks the kinds the caller may see', async () => {
      const all = await markRead('frontdesk', { all: true });
      expect(all.status).toBe(200);

      expect((await rowOf(N_NOSHOW)).read_at, 'her own no-show stayed unread').not.toBeNull();
      expect(
        (await rowOf(N_CAMPAIGN)).read_at,
        'a front desk with no marketing permission cleared a held campaign',
      ).toBeNull();
      expect(
        (await rowOf(N_CAL)).read_at,
        'a front desk with no team permission cleared a calendar alert',
      ).toBeNull();

      // The marketing manager's badge is untouched by the front desk's sweep.
      expect(rowIn((await bell('marketer')).body, N_CAMPAIGN).readAt).toBeNull();
    });

    /**
     * NO ORACLE. Naming a notification she may not see must be indistinguishable
     * from naming one that does not exist and from naming one already read — all
     * three are `marked: 0`. A 404 on the first would answer "does this salon have
     * a held campaign" for someone with no `marketing`.
     */
    it('naming an invisible, a foreign and an unknown id all report marked: 0', async () => {
      for (const target of [N_CAMPAIGN, N_LUMIERE, id('NT-NOT-A-ROW')]) {
        const res = await markRead('frontdesk', { ids: [target] });
        expect(res.status, `${target} produced a distinguishable status`).toBe(200);
        expect(res.body.marked, `${target} was marked`).toBe(0);
      }
      expect((await rowOf(N_CAMPAIGN)).read_at).toBeNull();
      expect((await rowOf(N_LUMIERE)).read_at).toBeNull();
    });

    it('a reader with no relevant permission marks nothing', async () => {
      const res = await markRead('stylist', { all: true });
      expect(res.status).toBe(200);
      expect(res.body.marked).toBe(0);
      expect((await rowOf(N_NOSHOW)).read_at).toBeNull();
    });

    /**
     * EXACTLY ONE SELECTION. `{}` would be a silent no-op the client reads as
     * success; both keys together is two intentions, and guessing which wins is how
     * a mark-all meant for three rows clears the salon.
     */
    it.each([
      ['neither', {}],
      ['both', { all: true, ids: ['NT-1'] }],
    ])('refuses %s selection', async (_why, payload) => {
      const res = await markRead('owner', payload);
      expect(res.status).toBe(400);
      expect(res.body.error ?? res.body.code).toBeTruthy();
    });

    it.each([
      ['a non-array', { ids: 'NT-1' }],
      ['a non-string element', { ids: [1] }],
      ['an empty array', { ids: [] }],
    ])('refuses %s for ids', async (_why, payload) => {
      expect((await markRead('owner', payload)).status).toBe(400);
    });

    it('refuses more ids than the bound', async () => {
      const ids = Array.from({ length: NOTIFICATION_PAGE_SIZE * 5 + 1 }, (_, i) => `NT-${i}`);
      expect((await markRead('owner', { ids })).status).toBe(400);
    });
  });

  // ======================================================================
  describe('deep_link', () => {
    /**
     * VALIDATED ON THE WAY OUT, AGAINST A ROW THAT IS ALREADY IN THE DATABASE.
     * That is the whole argument for validating on the read: `N_BADLINK` was
     * inserted directly, the way a row written before any check existed sits there
     * now, and it still cannot reach a client as a navigable link.
     */
    it('a protocol-relative link stored in the column serves as null', async () => {
      const row = rowIn((await bell('frontdesk')).body, N_BADLINK);
      expect(row.deepLink, 'a link that leaves this origin reached the client').toBeNull();
      expect(JSON.stringify(row)).not.toContain('evil.test');
    });

    it('the row is still served — a bad link is an unclickable row, not a dropped one', async () => {
      expect(rowIn((await bell('frontdesk')).body, N_BADLINK).title).toBe(
        `AC Bell hostile link ${RUN}`,
      );
    });

    it('the links this product mints survive unchanged', async () => {
      expect(rowIn((await bell('frontdesk')).body, N_NOSHOW).deepLink).toBe(
        '/merchant/appointments/BK-1',
      );
    });
  });

  // ======================================================================
  describe('the wire, and paging', () => {
    it('serves no metadata, subjectType or subjectId', async () => {
      const row = rowIn((await bell('owner')).body, N_CAMPAIGN);
      expect(Object.keys(row).sort()).toEqual([
        'body',
        'createdAt',
        'deepLink',
        'id',
        'kind',
        'readAt',
        'resolvedAt',
        'severity',
        'title',
      ]);
    });

    it('is newest first', async () => {
      const at = mine((await bell('owner')).body).map((r) => r.createdAt);
      expect([...at].sort().reverse()).toEqual(at);
    });

    /**
     * THE CURSOR WALKS THE WHOLE SET WITHOUT LOSING OR REPEATING A ROW. Written
     * against a page size of one so the walk has real boundaries to fall on —
     * `streamCursor.ts` records a bug where four rows sharing one microsecond
     * ended a walk three rows early, and only a boundary can see it.
     */
    it('pages without losing or repeating a row', async () => {
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let guard = 0; guard < 50; guard += 1) {
        const page: { body: Bell } = await bell(
          'owner',
          SALON,
          cursor === null ? '' : `?cursor=${encodeURIComponent(cursor)}`,
        );
        seen.push(...page.body.items.map((r) => r.id));
        cursor = page.body.nextCursor;
        if (cursor === null) break;
      }
      expect(cursor, 'the walk did not terminate').toBeNull();
      expect(new Set(seen).size, 'a row was served twice').toBe(seen.length);
      for (const nid of [N_CAL, N_CAL_RESOLVED, N_NOSHOW, N_CAMPAIGN, N_BADLINK]) {
        expect(seen, `${nid} was lost by the walk`).toContain(nid);
      }
      expect(seen, "another salon's row entered the walk").not.toContain(N_LUMIERE);
    });

    it('the badge is the same on every page', async () => {
      const first = await bell('owner');
      if (first.body.nextCursor === null) return;
      const second = await bell(
        'owner',
        SALON,
        `?cursor=${encodeURIComponent(first.body.nextCursor)}`,
      );
      expect(second.body.unreadCount).toBe(first.body.unreadCount);
    });

    it('refuses a cursor it did not mint', async () => {
      expect((await bell('owner', SALON, '?cursor=nonsense')).status).toBe(400);
    });

    /**
     * ======================================================================
     * THE SURFACE WALL. A PIN IS NOT A PASSWORD.
     * ======================================================================
     * `api-contract.md § StaffUser`: a PIN must "never reach dashboard scopes",
     * and `auth/principal.ts` puts the reason plainly — a four-digit PIN is only
     * safe because of what surrounds it (device-scoped, rate-limited, locked after
     * five failures), none of which a web session has.
     *
     * IT IS THE OWNER'S OWN CREDENTIAL, DELIBERATELY. The scanner session below is
     * minted for `OWNER`, who holds all three mapped permissions, so a 403 here can
     * only be the SURFACE and never a missing permission. That is the distinction
     * the wall exists to draw: the credential is the wrong KIND, not
     * under-privileged.
     *
     * THIS IS THE CASE THE PER-KIND FILTER CANNOT COVER. Everything else in this
     * file probes authority, and the filter is what enforces it. The filter says
     * nothing at all about which SURFACE is asking — a scanner session for a staff
     * member holding `appointments` would pass `visibleKinds` happily. Only
     * `requireDashboardScope`, running first, keeps the salon-floor tablet out of
     * the back office, and it was untested here until the permission audit asked.
     */
    it('a scanner PIN session cannot reach the bell, on either verb', async () => {
      const issue = (await import('../auth/sessions')).issueSession;
      const { randomUUID } = await import('node:crypto');
      const till = await issue(db, {
        principalKind: 'staff',
        staffId: OWNER,
        salonId: SALON,
        scope: 'scanner',
        deviceId: `DEV-INT-BN-${randomUUID()}`,
      });

      const g = await app.inject({
        method: 'GET',
        url: `/v1/salons/${SALON}/notifications`,
        headers: { authorization: `Bearer ${till.accessToken}` },
      });
      expect(g.statusCode, g.body).toBe(403);
      // Not merely refused — nothing of the feed came back with the refusal.
      expect(g.body).not.toContain('Latifa');
      expect(g.body).not.toContain(RUN);

      const w = await app.inject({
        method: 'POST',
        url: `/v1/salons/${SALON}/notifications/read`,
        headers: { authorization: `Bearer ${till.accessToken}` },
        payload: { all: true },
      });
      expect(w.statusCode, w.body).toBe(403);
      // AND THE REFUSED WRITE WROTE NOTHING. A gate that refuses after the effect
      // is the defect non-negotiable #7 is about; this is the half that says so.
      expect((await rowOf(N_NOSHOW)).read_at).toBeNull();
      expect((await rowOf(N_CAMPAIGN)).read_at).toBeNull();
    });

    /**
     * A CUSTOMER'S TOKEN IS NOT STAFF. Separate from the scanner case because the
     * refusal comes from a different line and carries different copy — "This
     * endpoint is for salon staff." — and because a member token is the credential
     * an attacker actually has.
     */
    it('a member token cannot reach the bell', async () => {
      const issue = (await import('../auth/sessions')).issueSession;
      const rows = await db.execute(
        sql`SELECT id FROM member WHERE salon_id = ${SALON} AND erased_at IS NULL LIMIT 1`,
      );
      const memberId = (rows as unknown as { id: string }[])[0]?.id;
      if (!memberId) throw new Error('the seed has no member at SAL-AMARA');

      const her = await issue(db, {
        principalKind: 'member',
        memberId,
        salonId: SALON,
        scope: 'wallet',
      });
      const res = await app.inject({
        method: 'GET',
        url: `/v1/salons/${SALON}/notifications`,
        headers: { authorization: `Bearer ${her.accessToken}` },
      });
      expect(res.statusCode, res.body).toBe(403);
      expect(res.body).not.toContain(RUN);
    });

    it('both verbs refuse an unauthenticated caller', async () => {
      const g = await app.inject({ method: 'GET', url: `/v1/salons/${SALON}/notifications` });
      const p = await app.inject({
        method: 'POST',
        url: `/v1/salons/${SALON}/notifications/read`,
        payload: { all: true },
      });
      expect(g.statusCode).toBe(401);
      expect(p.statusCode).toBe(401);
    });
  });
});
