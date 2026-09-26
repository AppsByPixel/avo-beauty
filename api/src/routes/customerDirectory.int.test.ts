/**
 * THE MERCHANT'S CUSTOMER BOOK — `GET /salons/{id}/customers`, the card, and the
 * history. `services/customerDirectory.ts` carries the permission argument and what
 * became of the scanner's four controls; this file is the evidence that each one
 * actually holds against a row.
 *
 * WHY THESE ARE INTEGRATION SPECS. Every claim below is a claim about a WHERE
 * clause, an append-only INSERT or a `timestamptz` comparison. A unit spec can pin
 * a parser; it cannot pin whether a row from another salon is reachable, whether
 * the audit row was written before the 404, or whether an erased member's `+990`
 * tombstone reaches the wire — and those are the three ways this endpoint can be
 * wrong in a way that matters.
 *
 * ===================== THE SIX INVERSIONS, AND WHAT THEY COST =====================
 * Nothing here is trusted because it went green. Each load-bearing claim was
 * anchored by BREAKING the code and confirming the spec goes red — and, where it
 * was possible to arrange it, breaking it so the endpoint returns THE WRONG ANSWER
 * rather than an empty one, because an empty result is the thing a weak spec
 * accidentally agrees with. The counts below are what the runs printed, not what
 * they were expected to print; two of them are recorded because the prediction was
 * wrong, which is the only reason the exercise is worth doing.
 *
 *   1. THE GATE.  `requireCustomerDirectory`'s
 *      `if (p.scope === 'dashboard' && p.perms.team)` forced true — both halves
 *      removed at once.
 *      → 4 red. All three routes answer 200 to ST-002, who holds no `team`; a
 *        device-bound till session reads the back-office book; and both
 *        refusal-audit specs find no risk row, because no refusal happened.
 *
 *   2. THE TENANT PREDICATE ON THE DETAIL.  `loadCustomer`'s
 *      `eq(member.salonId, salonId)` deleted.
 *      → 2 red, and this is the WRONG-ANSWER inversion. Amara's manager asking for
 *        Lumière's member id stops getting `404 unknown_member` and gets HER CARD:
 *        `{"name":"AC Lumiere Customer","memberPhone":"+9658…","email":"…",
 *        "balanceFils":1000,"salonId":"SAL-LUMIERE"}` with a 200. A spec asserting
 *        only "the list is empty" would never have seen it.
 *
 *   3. THE TENANT PREDICATE ON THE LIST.  `eq(member.salonId, p.salonId)` deleted
 *      from the list's WHERE.
 *      → 2 red, also the wrong answer: the Lumière customer appears in Amara's
 *        book, on the first page, because her `joined_at` is the newest of the
 *        three fixtures.
 *
 *   4. THE ZONE ON THE HISTORY WINDOW.  `s.timezone` replaced with `'UTC'`.
 *      → 2 red — EDGE_IN leaves the week and NEXT_OUT enters it, which is again the
 *        wrong answer rather than an empty one: the merchant's Saturday-night
 *        figure acquires a transaction that happened on her Sunday.
 *        THE PREDICTION WAS WRONG, and it is left here rather than quietly fixed.
 *        The ZONE row was expected to be the falsifier; it is NOT, because 21:30Z
 *        on a Tuesday sits comfortably inside the UTC week as well as the salon's.
 *        The rows that actually move are the two at the BOUNDARY, which is where a
 *        three-hour shift shows up. ZONE stays as a true claim about a mid-week row
 *        and is honestly not load-bearing for the zone.
 *
 *   5. THE CEILING.  `>= CUSTOMER_DIRECTORY_MAX_PER_WINDOW` weakened to `>`.
 *      → 1 red, which is exactly right: only the boundary spec can see a one-read
 *        difference, and it does.
 *
 *   6. THE PHONE CLAUSE.  `looksLikeAPhone` weakened back to `digits !== ''`, the
 *      rule this endpoint started with and the one the scanner still uses.
 *      → 2 red. THIS INVERSION FAILED TO REPRODUCE THE FIRST TIME and that is the
 *        more useful half of the story: the spec was searching for the other
 *        salon's member id and relying on its random suffix happening to contain
 *        digits the fixture phones also contained. It had caught the real defect on
 *        the run that found it and then went green under a deliberate break. The
 *        probe is now built from a phone known to hold the digits, so the spec is
 *        falsifiable on every run rather than on lucky ones.
 *
 * The specs that survive all six are the money shapes, the erasure, the audit
 * content and the cursor's no-repeat property, which is correct: none of those six
 * touches a serialiser or the keyset.
 *
 * `AC-` NAMESPACE, per-run suffix. `EG-` is bookingsRange, `EN-` is bookingsPaging,
 * `IT-` is metrics.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  CUSTOMER_DIRECTORY_MAX_PER_WINDOW,
  CUSTOMER_PAGE_SIZE,
} from '../services/customerDirectory';

const INT_URL = process.env.AVO_INT_DATABASE_URL;
const suite = INT_URL ? describe : describe.skip;

const SALON = 'SAL-AMARA';
const BRANCH = 'BR-SAL';
/** Hessa. `perm_team` is FALSE in the seed — she is the permission-off probe. */
const FRONTDESK = 'ST-002';
const OTHER_SALON = 'SAL-LUMIERE';

/** design/AVO Staff Scanner.dc.html, locked state — asserted verbatim. */
const TEAM_REFUSAL = "You don't have permission to manage the team. A manager can grant it.";

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
const id = (tag: string) => `AC-${tag}-${RUN}`;

const LIVE = id('M');
const ERASED = id('E');
const OTHER_MEMBER = id('L');
const OTHER_STAFF = id('ST');

/**
 * ============================================================================
 * A PER-RUN MANAGER, AND SHE IS NOT A CONVENIENCE.
 * ============================================================================
 * This file used the seeded `ST-001` and the inversion run is what exposed the
 * problem. `enforceCustomerDirectoryLimit` counts rows in `audit_log`, which is
 * APPEND-ONLY — the application role holds no DELETE — so every request this suite
 * makes as ST-001 stays on her hourly counter after the run ends. At roughly fifty
 * directory reads a run, the sixth run inside an hour trips the 300 ceiling and the
 * suite goes red for a reason that has nothing to do with the code under test. That
 * is the shape of failure api/README.md's idempotence requirement exists to catch,
 * and it took a deliberately broken build to surface it.
 *
 * THE FIX IS THE LIMITER WORKING, NOT A HOLE IN IT. The ceiling is keyed on
 * `actor_id` and nothing else, precisely so that "the only way to get a fresh budget
 * is to be a different person". A per-run fixture manager IS a different person. The
 * number is not touched to accommodate a test, which is the move
 * `services/memberSearch.ts` warns against: "raise these on evidence".
 *
 * `FRONTDESK` stays seeded, because a REFUSED read consumes no budget — the refusal
 * action is deliberately not in `CUSTOMER_DIRECTORY_ACTIONS` — so her counter never
 * moves however many times this file probes the gate.
 */
const MANAGER = id('MGR');

/** Her balance, in fils. A number with three significant decimal places so that a
 *  float creeping in anywhere renders visibly rather than plausibly. */
const LIVE_BALANCE_FILS = 24_500;

/**
 * Sunday 6 June 2027 to Saturday 12 June 2027. Asia/Kuwait is UTC+3 with no DST,
 * so the window is `[2027-06-05T21:00:00Z, 2027-06-12T21:00:00Z)`. Every row below
 * is placed against one of those two instants on purpose.
 */
const WEEK_FROM = '2027-06-06';
const WEEK_TO = '2027-06-12';

/**
 * `[key, createdAt, kind, amountFils]`. The instants are written as UTC because
 * that is what the database stores and what makes the salon-local claim
 * FALSIFIABLE — see inversion 3.
 *
 *   EDGE_IN    the window's FIRST instant, to the microsecond          in
 *   EDGE_OUT   one microsecond earlier                                 out
 *   ZONE       21:30Z on TUESDAY, which is WEDNESDAY at the salon      in
 *   LAST_IN    23:59 salon-local on `to`                               in
 *   NEXT_OUT   00:00 salon-local on the day after `to`                 out
 */
const TX = [
  ['EDGE_IN', '2027-06-05T21:00:00.000000Z', 'charge', -12_345],
  ['EDGE_OUT', '2027-06-05T20:59:59.999999Z', 'charge', -6_000],
  ['ZONE', '2027-06-08T21:30:00.000000Z', 'topup', 30_000],
  ['LAST_IN', '2027-06-12T20:59:00.000000Z', 'charge', -7_500],
  ['NEXT_OUT', '2027-06-12T21:00:00.000000Z', 'charge', -9_000],
] as const;

const TXID: Record<string, string> = Object.fromEntries(TX.map(([k]) => [k, id(`TX-${k}`)]));
const IN_WEEK = ['EDGE_IN', 'ZONE', 'LAST_IN'].map((k) => TXID[k] as string);
const OUT_OF_WEEK = ['EDGE_OUT', 'NEXT_OUT'].map((k) => TXID[k] as string);

interface FeedRow {
  id: string;
  stream: string;
  what: string;
  kind: string;
  amountFils: number | null;
  memberId: string;
}
interface ListRow {
  id: string;
  name: string;
  memberErased: boolean;
  memberPhone: string | null;
  tier: string | null;
  balanceFils: number;
  visits: number;
  joinedAt: string;
}
interface AuditRow {
  action: string;
  kind: string;
  actor_id: string | null;
  subject_id: string | null;
  detail: string | null;
  metadata: Record<string, unknown>;
}

suite('the merchant customer directory', () => {
  let app: FastifyInstance;
  let db: (typeof import('../db/client'))['db'];
  let sql: (typeof import('drizzle-orm'))['sql'];
  let managerToken: string;
  let frontdeskToken: string;
  let frontdeskSessionId: string;
  let otherSalonToken: string;

  beforeAll(async () => {
    db = (await import('../db/client')).db;
    sql = (await import('drizzle-orm')).sql;
    const issue = (await import('../auth/sessions')).issueSession;
    app = await (await import('../app')).buildApp();

    const digits = String(Date.now() % 1_000_000).padStart(6, '0');

    /**
     * THREE MEMBERS AND THE THIRD IS THE POINT. Two at Amara — one live, one
     * ERASED — and one at Lumière, which is what makes "a merchant cannot read
     * another salon's customer" an assertion about a row rather than about an
     * empty set. `joined_at` is explicit and ordered, because the list pages on it.
     */
    await db.execute(sql`
      INSERT INTO member
        (id, salon_id, name, phone, email, email_verified, password_hash,
         balance_fils, visits, tier, policy_version, joined_at)
      VALUES
        (${LIVE}, ${SALON}, 'AC Live Customer', ${`+9657${digits}`},
         ${`ac.live.${RUN}@example.test`}, true, 'x',
         ${LIVE_BALANCE_FILS}, 5, 'silver', 1, '2027-04-01T09:00:00Z'),
        (${OTHER_MEMBER}, ${OTHER_SALON}, 'AC Lumiere Customer', ${`+9658${digits}`},
         ${`ac.lum.${RUN}@example.test`}, true, 'x', 1000, 1, 'bronze', 1,
         '2027-04-03T09:00:00Z')`);

    /**
     * THE ERASED MEMBER, BUILT THE WAY `services/erasure.ts` BUILDS ONE — the
     * tombstone name, a `+990` phone, a nulled email, and `erased_at` set. The
     * three `member_deletion_*` CHECKs require the request and the due date to be
     * present and ordered before `erased_at` is allowed at all, which is itself
     * the schema insisting that an erasure without a request is unexplainable.
     *
     * `+990` is an UNASSIGNED country code, chosen by erasure.ts precisely because
     * it can never reach anybody. The specs below assert those four digits never
     * appear in a response body.
     */
    await db.execute(sql`
      INSERT INTO member
        (id, salon_id, name, phone, email, email_verified, password_hash,
         balance_fils, visits, tier, policy_version, joined_at,
         deletion_requested_at, deletion_due_at, erased_at)
      VALUES
        (${ERASED}, ${SALON}, 'Deleted account', ${`+990${digits}555555`.slice(0, 16)},
         NULL, false, '!erased', 0, 2, 'bronze', 1, '2027-04-02T09:00:00Z',
         '2027-04-02T10:00:00Z', '2027-05-02T10:00:00Z', '2027-05-02T10:00:00Z')`);

    /**
     * TWO MANAGERS, ONE PER SALON, BOTH MINTED FOR THIS RUN. The Amara one for the
     * reason above; the Lumiere one so that "a merchant cannot read another salon's
     * customer" is proved against a real staff row with `perm_team` ON — her
     * refusal can then only be tenancy, never a missing permission.
     */
    await db.execute(sql`
      INSERT INTO staff_user
        (id, salon_id, name, handle, role, branch_access_all, branch_access_ids,
         password_hash, perm_dashboard, perm_appointments, perm_shop, perm_loyalty,
         perm_team, perm_scanner, perm_charges, perm_void, perm_marketing)
      VALUES
        (${MANAGER}, ${SALON}, ${`AC Mgr ${RUN}`}, ${`ac-mgr-${RUN}`},
         'manager', true, '{}', 'x', true, true, true, true, true, false, false, false, false),
        (${OTHER_STAFF}, ${OTHER_SALON}, ${`AC Lum Mgr ${RUN}`}, ${`ac-lum-${RUN}`},
         'manager', true, '{}', 'x', true, true, true, true, true, false, false, false, false)`);

    const txValues = TX.map(([k, at, kind, amount]) => {
      const method = kind === 'topup' ? 'knet' : 'wallet';
      return sql`(${TXID[k]}, ${LIVE}, ${SALON}, ${BRANCH}, ${kind}, ${amount}, 0,
                  ${method}, 'settled', '', ${at}::timestamptz, ${at}::timestamptz)`;
    });
    await db.execute(sql`
      INSERT INTO "transaction"
        (id, member_id, salon_id, branch_id, kind, amount_fils, bonus_fils,
         method, status, reference, created_at, settled_at)
      VALUES ${sql.join(txValues, sql`, `)}`);

    /**
     * ONE LOYALTY EVENT, INSIDE THE WINDOW. The history is a MERGE of two streams,
     * and a fixture with only transactions in it would let a broken second stream
     * pass unnoticed — which is the failure `services/streamCursor.ts` exists to
     * prevent and the one a single-source fixture cannot see.
     */
    await db.execute(sql`
      INSERT INTO loyalty_event
        (salon_id, member_id, transaction_id, kind, from_tier, to_tier, created_at)
      VALUES (${SALON}, ${LIVE}, ${TXID.ZONE}, 'tier_climb', 'bronze', 'silver',
              '2027-06-09T10:00:00Z')`);

    managerToken = (
      await issue(db, { principalKind: 'staff', staffId: MANAGER, salonId: SALON, scope: 'dashboard' })
    ).accessToken;
    const frontdeskSession = await issue(db, {
      principalKind: 'staff',
      staffId: FRONTDESK,
      salonId: SALON,
      scope: 'dashboard',
    });
    frontdeskToken = frontdeskSession.accessToken;
    /**
     * THE SESSION ID IS THIS RUN'S ONLY HANDLE ON ITS OWN REFUSAL ROWS, and it is
     * kept for a reason the first green run hid. `audit_log` is append-only, so
     * every previous run's refusal rows are still there under the same actor and
     * the same action — a spec that asserted "at least one such row exists" stayed
     * green with the permission check REMOVED, because it was reading rows a
     * correct build had written minutes earlier. `metadata.sessionId` is minted
     * here, so a row carrying it can only have been written by this run.
     */
    frontdeskSessionId = frontdeskSession.sessionId;
    otherSalonToken = (
      await issue(db, {
        principalKind: 'staff',
        staffId: OTHER_STAFF,
        salonId: OTHER_SALON,
        scope: 'dashboard',
      })
    ).accessToken;
  });

  afterAll(async () => {
    if (db) {
      // `loyalty_event.transaction_id` is ON DELETE RESTRICT, so the events go first.
      await db.execute(sql`DELETE FROM loyalty_event WHERE member_id = ${LIVE}`);
      await db.execute(sql`DELETE FROM "transaction" WHERE id LIKE ${`AC-TX-%${RUN}`}`);
      /**
       * THE AUDIT ROWS THIS RUN WROTE ARE NOT CLEANED UP, AND CANNOT BE. The
       * application role holds no DELETE on `audit_log` (migration 0001), which is
       * the property `enforceCustomerDirectoryLimit` counts on: a limiter whose
       * counter the limited process can trim is not a limiter. `actor_id` is a
       * SOFT reference and deliberately not a foreign key, so the staff row below
       * still drops. Every lookup in this file is scoped to this run's ids rather
       * than to "the newest row", so the leftovers are inert on a re-run — which
       * is the idempotence api/README.md asks of this suite.
       */
      await db.execute(sql`DELETE FROM staff_user WHERE id IN (${MANAGER}, ${OTHER_STAFF})`);
      await db.execute(sql`DELETE FROM member WHERE id IN (${LIVE}, ${ERASED}, ${OTHER_MEMBER})`);
    }
    await app?.close();
  });

  async function get(url: string, token: string) {
    const res = await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });
    return { status: res.statusCode, raw: res.body, body: JSON.parse(res.body) };
  }

  const listUrl = (salon: string, q?: string) =>
    `/salons/${salon}/customers${q === undefined ? '' : `?q=${encodeURIComponent(q)}`}`;
  const cardUrl = (salon: string, m: string) => `/salons/${salon}/customers/${m}`;
  const historyUrl = (salon: string, m: string, query: Record<string, string> = {}) =>
    `/salons/${salon}/customers/${m}/activity${
      Object.keys(query).length === 0 ? '' : `?${new URLSearchParams(query).toString()}`
    }`;

  /**
   * ==========================================================================
   * A BOUNDED PREFIX, NOT THE WHOLE BOOK — and the first draft walked the book.
   * ==========================================================================
   * It walked to `nextCursor === null` with a 40-page budget and went red, in an
   * unrelated inversion run, with "the list walk did not terminate". SAL-AMARA held
   * 1,180 members by then: every integration run in this suite's history leaves
   * fixtures behind, and 1,180 at 25 a page is 48 pages. The specs had been green
   * for exactly as long as the lane database was small, which is a spec that fails
   * on a date rather than on a defect.
   *
   * IT IS ALSO THE WRONG SHAPE FOR THE CLAIM. Walking a merchant's entire customer
   * book to find two rows is the enumeration the endpoint's controls exist to
   * bound; a spec should not need to do the thing the feature is designed to make
   * expensive.
   *
   * SO: A FIXED PREFIX, AND THE FIXTURE IS BUILT TO LAND IN IT. This run's three
   * members carry `joined_at` in 2027 — the FUTURE, relative to any real row — and
   * the list is ordered `joined_at DESC`, so they occupy the first page by
   * construction. That is what keeps the tenancy spec falsifiable: with the salon
   * predicate deleted, the Lumière member (2027-04-03, the newest of the three)
   * appears at the very top, which is where this looks.
   */
  const PREFIX_PAGES = 3;

  async function walkList(token: string, q?: string, pages = PREFIX_PAGES): Promise<ListRow[]> {
    const found: ListRow[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < pages; i++) {
      const url = listUrl(SALON, q) + (cursor ? `${q === undefined ? '?' : '&'}cursor=${cursor}` : '');
      const page = (await get(url, token)).body as { items: ListRow[]; nextCursor: string | null };
      found.push(...page.items);
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    return found;
  }

  /** The same prefix, narrowed to what this run put there. */
  async function runRows(token: string, q?: string): Promise<ListRow[]> {
    return (await walkList(token, q)).filter((r) => r.id.includes(RUN));
  }

  async function auditRows(action: string, actor: string): Promise<AuditRow[]> {
    const rows = (await db.execute(sql`
      SELECT action, kind, actor_id, subject_id, detail, metadata
        FROM audit_log
       WHERE action = ${action} AND actor_id = ${actor}
         AND created_at > now() - interval '10 minutes'
       ORDER BY seq DESC`)) as unknown as AuditRow[];
    return [...rows];
  }

  // ======================================================================
  // NON-NEGOTIABLE #7 — the gate, called directly with the permission off
  // ======================================================================
  describe('perms.team is enforced server-side', () => {
    const routes = () => [
      ['the list', listUrl(SALON)],
      ['the card', cardUrl(SALON, LIVE)],
      ['the history', historyUrl(SALON, LIVE)],
    ] as const;

    it('a staff member without perms.team is refused on all three, by the permission’s own copy', async () => {
      for (const [label, url] of routes()) {
        const res = await get(url, frontdeskToken);
        expect(res.status, `${label} answered ${res.status}: ${res.raw}`).toBe(403);
        expect(res.body.error).toBe('forbidden');
        /**
         * THE COPY, NOT THE STATUS. Every permission refusal carries code
         * `forbidden`, and so does `requireSameSalon` — so the code alone cannot
         * say WHICH guard answered. The permission's own sentence is the only
         * discriminator, which is `permission-census.test.ts`' reasoning.
         */
        expect(res.body.message, label).toBe(TEAM_REFUSAL);
        // Two keys, no third. A refusal that also carries `items: []` has told the
        // caller the route exists and the shape of what it serves.
        expect(Object.keys(res.body).sort(), label).toEqual(['error', 'message']);
      }
    });

    it('nothing about a customer survives the refusal — not a name, not a balance', async () => {
      for (const [label, url] of routes()) {
        const res = await get(url, frontdeskToken);
        expect(res.raw, label).not.toContain('AC Live Customer');
        expect(res.raw, label).not.toContain(String(LIVE_BALANCE_FILS));
        expect(res.raw, label).not.toContain(LIVE);
      }
    });

    /**
     * THE MIRROR. A 403 is not evidence on its own — `DECISIONS.md dcf1e2e`: a
     * status code says nothing about which guard answered. Grant the permission,
     * make the same three calls, and the refusal must stop. Without this the specs
     * above would pass just as happily against a route that does not exist.
     */
    it('the same three calls with perms.team ON succeed — the 403 was the permission', async () => {
      for (const [label, url] of routes()) {
        const res = await get(url, managerToken);
        expect(res.status, `${label} answered ${res.status}: ${res.raw}`).toBe(200);
      }
    });

    /**
     * THE REFUSAL IS RECORDED. `routes/members.ts § requireDirectoryScanner`
     * established that an authenticated, identified and refused directory read is
     * a fact worth keeping — a run of these naming one actor is what an insider
     * probing her own limits looks like. A gate that only throws leaves no run.
     */
    it('a refused read writes a risk row naming the actor and the permission', async () => {
      await get(listUrl(SALON), frontdeskToken);
      const rows = (await auditRows('Customer directory access refused', FRONTDESK)).filter(
        (r) => r.metadata.sessionId === frontdeskSessionId,
      );
      expect(rows.length, 'this run’s refusal left no row').toBeGreaterThan(0);
      const row = rows[0] as AuditRow;
      expect(row.kind).toBe('risk');
      expect(row.metadata.permission).toBe('team');
      expect(row.metadata.scope).toBe('dashboard');
      expect(row.metadata.hasPermission).toBe(false);
      // Nothing was accessed, so nothing is named as a subject.
      expect(row.subject_id).toBeNull();

      /**
       * AND NO `access` ROW UNDER THAT SESSION. A refused read must leave the
       * risk row and NOTHING ELSE — if the gate stopped holding, the same call
       * would write `Customer directory listed` instead, so this half goes red
       * from the other direction.
       */
      const read = (await auditRows('Customer directory listed', FRONTDESK)).filter(
        (r) => r.metadata.sessionId === frontdeskSessionId,
      );
      expect(read, 'a refused caller listed the book').toHaveLength(0);
    });

    /**
     * THE OTHER HALF OF THE SAME QUESTION. A device-bound PIN session holding every
     * permission is still refused here — the customer book is a back-office screen,
     * not a till one — and the refusal is RECORDED rather than thrown away at the
     * surface wall. `routes/members.ts § requireDirectoryScanner` logs the mirror
     * case, a dashboard session reaching the scanner's lookup; a log that answered
     * "who tried to reach the customer directory without the authority to" at one
     * door and not the other would be a filter with a hole in it.
     */
    it('a scanner session is refused too, and the refusal is recorded with its scope', async () => {
      const issue = (await import('../auth/sessions')).issueSession;
      const { randomUUID } = await import('node:crypto');
      const till = await issue(db, {
        principalKind: 'staff',
        staffId: MANAGER,
        salonId: SALON,
        scope: 'scanner',
        deviceId: `DEV-INT-AC-${randomUUID()}`,
      });

      const res = await get(listUrl(SALON), till.accessToken);
      expect(res.status, res.raw).toBe(403);
      expect(res.raw).not.toContain('AC Live Customer');

      const rows = (await auditRows('Customer directory access refused', MANAGER)).filter(
        (r) => r.metadata.sessionId === till.sessionId,
      );
      expect(rows.length, 'a till session reached the back office unlogged').toBe(1);
      const row = rows[0] as AuditRow;
      expect(row.kind).toBe('risk');
      expect(row.metadata.scope).toBe('scanner');
      /** She HOLDS `team`; what she lacks is the surface. The row must say so. */
      expect(row.metadata.hasPermission).toBe(true);
    });
  });

  // ======================================================================
  // TENANCY — a merchant sees her own salon's members and no others
  // ======================================================================
  describe('salon scoping', () => {
    it('another salon’s manager is refused at the path, before any customer is read', async () => {
      for (const url of [listUrl(SALON), cardUrl(SALON, LIVE), historyUrl(SALON, LIVE)]) {
        const res = await get(url, otherSalonToken);
        expect(res.status, `${url} answered ${res.status}: ${res.raw}`).toBe(403);
        expect(res.body.message).toBe('That salon is not yours.');
        expect(res.raw).not.toContain('AC Live Customer');
      }
    });

    /**
     * THE MIRROR FOR TENANCY: the same manager, her OWN salon, her own customer.
     * Without it the specs above are green against a route that 403s for everyone.
     */
    it('the same manager reading her OWN salon succeeds', async () => {
      const res = await get(cardUrl(OTHER_SALON, OTHER_MEMBER), otherSalonToken);
      expect(res.status, res.raw).toBe(200);
      expect(res.body.id).toBe(OTHER_MEMBER);
    });

    /**
     * ============ THE WRONG-ANSWER SPEC ============
     * Amara's manager, inside her OWN workspace, naming a member id that lives at
     * Lumière. The path check cannot catch this — the salon in the URL is hers.
     * Only the second term of `loadCustomer`'s WHERE can, and when it is deleted
     * this call returns HER CARD with a 200 rather than an empty anything. That is
     * inversion 2, and it is why this asserts the body as well as the status.
     *
     * `404 unknown_member`, BYTE-IDENTICAL TO A MEMBER WHO DOES NOT EXIST — not a
     * 403. `services/memberSearch.ts § resolveMember`: a distinct 403 "would
     * confirm that the id is real, which turns this endpoint into an oracle for
     * 'is 8842 a customer somewhere in AVO'".
     */
    it('a member id from another salon is 404 unknown_member, not her card and not a 403', async () => {
      for (const url of [cardUrl(SALON, OTHER_MEMBER), historyUrl(SALON, OTHER_MEMBER)]) {
        const res = await get(url, managerToken);
        expect(res.status, `${url} answered ${res.status}: ${res.raw}`).toBe(404);
        expect(res.body.error).toBe('unknown_member');
        expect(res.raw).not.toContain('AC Lumiere Customer');
        expect(res.raw).not.toContain(OTHER_MEMBER);
      }
    });

    it('an unknown id and another salon’s id are the same refusal, to the byte', async () => {
      const stranger = await get(cardUrl(SALON, OTHER_MEMBER), managerToken);
      const nobody = await get(cardUrl(SALON, `AC-NOPE-${RUN}`), managerToken);
      expect(stranger.status).toBe(nobody.status);
      expect(stranger.raw).toBe(nobody.raw);
    });

    it('the list never contains another salon’s member, filtered or not', async () => {
      /**
       * THE PREFIX IS WHERE SHE WOULD BE. Her `joined_at` is 2027-04-03, the newest
       * of this run's three, so an unscoped list puts her first — see `walkList`.
       */
      const all = await walkList(managerToken);
      expect(all.map((r) => r.id)).not.toContain(OTHER_MEMBER);
      // And by name and by exact id, which is what a search box would reach for.
      expect(await runRows(managerToken, 'AC Lumiere')).toHaveLength(0);
      expect(await runRows(managerToken, OTHER_MEMBER)).toHaveLength(0);
    });
  });

  // ======================================================================
  // THE ERASED MEMBER — DECISIONS.md #100, a fourth merchant read
  // ======================================================================
  describe('an erased member', () => {
    it('is still in the book — her transactions are records a merchant has to reach', async () => {
      const all = await runRows(managerToken);
      expect(all.map((r) => r.id)).toContain(ERASED);
    });

    it('carries memberErased true and memberPhone null on the list, never the +990 tombstone', async () => {
      const all = await runRows(managerToken);
      const row = all.find((r) => r.id === ERASED) as ListRow;
      expect(row.memberErased).toBe(true);
      expect(row.memberPhone).toBeNull();
      expect(row.name).toBe('Deleted account');
      const live = all.find((r) => r.id === LIVE) as ListRow;
      // The flag is not stuck on: a live member is false with a real number.
      expect(live.memberErased).toBe(false);
      expect(live.memberPhone).toMatch(/^\+965/);
    });

    it('never puts +990 on the wire, on any of the three reads', async () => {
      const pages = [
        (await get(listUrl(SALON), managerToken)).raw,
        (await get(listUrl(SALON, 'Deleted'), managerToken)).raw,
        (await get(cardUrl(SALON, ERASED), managerToken)).raw,
        (await get(historyUrl(SALON, ERASED), managerToken)).raw,
      ];
      for (const raw of pages) expect(raw).not.toContain('+990');
    });

    it('her card carries the same pair, and the email erasure nulled at rest', async () => {
      const res = await get(cardUrl(SALON, ERASED), managerToken);
      expect(res.status).toBe(200);
      expect(res.body.memberErased).toBe(true);
      expect(res.body.memberPhone).toBeNull();
      expect(res.body.email).toBeNull();
    });
  });

  // ======================================================================
  // MONEY — non-negotiable #1, integer fils on the wire
  // ======================================================================
  describe('money', () => {
    it('a balance is an integer number of fils, not a formatted string and not a float', async () => {
      const res = await get(cardUrl(SALON, LIVE), managerToken);
      expect(typeof res.body.balanceFils).toBe('number');
      expect(Number.isInteger(res.body.balanceFils)).toBe(true);
      expect(res.body.balanceFils).toBe(LIVE_BALANCE_FILS);
      // The display form must not be reachable from here — formatting happens at
      // the display boundary, which is not this process.
      expect(res.raw).not.toContain('24.500');
    });

    it('every history amount is an integer, signed as stored', async () => {
      const res = await get(historyUrl(SALON, LIVE), managerToken);
      const items = (res.body.items as FeedRow[]).filter((i) => i.id.includes(RUN));
      expect(items.length).toBeGreaterThan(0);
      for (const item of items) {
        if (item.amountFils === null) continue;
        expect(Number.isInteger(item.amountFils), item.id).toBe(true);
      }
      const charge = items.find((i) => i.id === TXID.EDGE_IN) as FeedRow;
      expect(charge.amountFils).toBe(-12_345);
      const topup = items.find((i) => i.id === TXID.ZONE) as FeedRow;
      expect(topup.amountFils).toBe(30_000);
    });

    /**
     * "Commission is recorded per transaction, merchant-visible, CUSTOMER-NEVER"
     * — and `FeedItem`'s own rule is narrower still: not on a feed at all,
     * because "the commission belongs on the settlement report where it can be
     * totalled". A feed row that grew a `feeFils` would be a second serialiser
     * making that decision, which is what `http/serialise.ts` exists to prevent.
     */
    it('no feed row carries feeFils', async () => {
      const res = await get(historyUrl(SALON, LIVE), managerToken);
      expect(res.raw).not.toContain('feeFils');
    });

    /** The merge is real: a tier climb reaches the same page as the money. */
    it('the history merges the loyalty stream, not only transactions', async () => {
      const res = await get(historyUrl(SALON, LIVE), managerToken);
      const items = res.body.items as FeedRow[];
      const climb = items.find((i) => i.stream === 'loyalty' && i.memberId === LIVE);
      expect(climb, 'no loyalty row on the page').toBeDefined();
      expect((climb as FeedRow).what).toBe('reached Silver tier');
      expect((climb as FeedRow).amountFils).toBeNull();
    });
  });

  // ======================================================================
  // THE DATE RANGE — the same grammar the bookings list uses
  // ======================================================================
  describe('?from= and ?to= on the history', () => {
    async function idsIn(query: Record<string, string>): Promise<string[]> {
      const found: string[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < 20; i++) {
        const q: Record<string, string> = cursor ? { ...query, cursor } : query;
        const page = (await get(historyUrl(SALON, LIVE, q), managerToken)).body as {
          items: FeedRow[];
          nextCursor: string | null;
        };
        found.push(...page.items.map((r) => r.id).filter((x) => x.includes(RUN)));
        cursor = page.nextCursor;
        if (!cursor) return found;
      }
      throw new Error('the history walk did not terminate in 20 pages');
    }

    const week = { from: WEEK_FROM, to: WEEK_TO };

    it('a transaction AT the window’s first instant is in; one microsecond earlier is out', async () => {
      const found = await idsIn(week);
      expect(found).toContain(TXID.EDGE_IN);
      expect(found).not.toContain(TXID.EDGE_OUT);
    });

    it('23:59 salon-local on `to` is in; 00:00 the next day is out', async () => {
      const found = await idsIn(week);
      expect(found).toContain(TXID.LAST_IN);
      expect(found).not.toContain(TXID.NEXT_OUT);
    });

    /**
     * A MID-WEEK ROW, AND HONESTLY NOT THE ZONE'S FALSIFIER. 21:30Z on Tuesday
     * 8 June is 00:30 on WEDNESDAY 9 June at a Kuwait salon — but it sits inside
     * the UTC week too, so the UTC inversion does not move it. The rows that prove
     * the zone are the two at the BOUNDARY, in the specs above. This one is kept
     * because it is a true claim that a row three days from either edge is served
     * and is not served by the week before it, which is what catches an off-by-a-
     * week rather than an off-by-three-hours.
     */
    it('a row is placed on the salon’s calendar day, not UTC’s', async () => {
      const found = await idsIn(week);
      expect(found).toContain(TXID.ZONE);
      // The week BEFORE, in which UTC would have placed it, must not hold it.
      const before = await idsIn({ from: '2027-05-30', to: '2027-06-05' });
      expect(before).not.toContain(TXID.ZONE);
    });

    it('no range at all returns every row, in and out of the week', async () => {
      const found = await idsIn({});
      for (const t of [...IN_WEEK, ...OUT_OF_WEEK]) expect(found).toContain(t);
    });

    it('one end without the other is refused by name', async () => {
      const res = await get(historyUrl(SALON, LIVE, { from: WEEK_FROM }), managerToken);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_range');
    });
  });

  // ======================================================================
  // THE AUDIT — the scanner's two subtle rules, carried
  // ======================================================================
  describe('the audit trail', () => {
    it('a list read records the QUERY and the COUNT, and names no customer', async () => {
      await get(listUrl(SALON, 'AC Live'), managerToken);
      const rows = await auditRows('Customer directory listed', MANAGER);
      const row = rows.find((r) => r.metadata.query === 'AC Live') as AuditRow;
      expect(row, 'no list row for that query').toBeDefined();
      expect(row.kind).toBe('access');
      expect(typeof row.metadata.results).toBe('number');
      expect(row.metadata.results).toBeGreaterThan(0);
      /**
       * THE SPLIT THAT MATTERS. "Copying the matched customers into an
       * append-only seven-year log would build a second customer list inside the
       * audit trail." So: no subject, and the matched member's id appears
       * nowhere on the row.
       */
      expect(row.subject_id).toBeNull();
      expect(JSON.stringify(row)).not.toContain(LIVE);
      expect(JSON.stringify(row)).not.toContain('AC Live Customer');
    });

    it('opening a card names HER — this is the read that disclosed her', async () => {
      await get(cardUrl(SALON, LIVE), managerToken);
      const rows = await auditRows('Customer profile opened', MANAGER);
      const row = rows.find((r) => r.subject_id === LIVE) as AuditRow;
      expect(row, 'no open row naming her').toBeDefined();
      expect(row.kind).toBe('access');
      expect(row.detail).toBe('Opened AC Live Customer');
      expect(row.metadata.found).toBe(true);
    });

    /**
     * WRITTEN BEFORE THE REFUSAL. An attempt on an id that is not in this salon is
     * "the single most interesting line in this log — it is what a directory walk
     * looks like from the inside", and a log that recorded only successful reads
     * would omit exactly the evidence.
     */
    it('a read that found nobody is still logged, before the 404', async () => {
      const missing = `AC-GHOST-${RUN}`;
      const res = await get(cardUrl(SALON, missing), managerToken);
      expect(res.status).toBe(404);
      const rows = await auditRows('Customer profile opened', MANAGER);
      const row = rows.find((r) => r.metadata.requestedId === missing) as AuditRow;
      expect(row, 'the refused read left no row').toBeDefined();
      expect(row.metadata.found).toBe(false);
      expect(row.subject_id).toBeNull();
    });

    it('reading the history is its own action, and records the window it ran over', async () => {
      await get(historyUrl(SALON, LIVE, { from: WEEK_FROM, to: WEEK_TO }), managerToken);
      /**
       * Found by THIS RUN'S member, then asserted on the window — not the other
       * way round. `audit_log` is append-only, so a previous run's row carries the
       * same dates against a different member, and a lookup keyed on the window
       * would assert this run's claim against that run's row.
       */
      const rows = (await auditRows('Customer history read', MANAGER)).filter(
        (r) => r.subject_id === LIVE,
      );
      expect(rows.length, 'no history row naming her').toBeGreaterThan(0);
      const row = rows.find((r) => r.metadata.from === WEEK_FROM) as AuditRow;
      expect(row, 'no history row for that window').toBeDefined();
      expect(row.metadata.to).toBe(WEEK_TO);
    });
  });

  // ======================================================================
  // THE CEILING — scanner control 3, re-keyed and re-sized
  // ======================================================================
  describe('the hourly ceiling', () => {
    /**
     * THE BOUNDARY, FROM BOTH SIDES, AND NOT BY MAKING 300 REQUESTS.
     *
     * The limiter counts rows in `audit_log` keyed on `actor_id`, so the counter can
     * be positioned directly — which is the whole reason the audit row IS the
     * counter rather than a separate table: there is one number, and this spec reads
     * the same one the limiter does. Driving 300 real requests would test the same
     * predicate thirty seconds more slowly.
     *
     * ONE BELOW THE CEILING SUCCEEDS AND THE CEILING REFUSES. A spec that only
     * asserted the 429 would pass against a limiter that refused everybody; a spec
     * that only asserted the 200 would pass against one that refused nobody. The
     * pair is what pins the number, and it goes red if `>=` becomes `>`.
     *
     * A THROWAWAY ACTOR, because positioning a counter that cannot be deleted is a
     * one-way operation — see the per-run manager above for what sharing one costs.
     */
    const LIMITED = id('LIM');

    async function stuff(rows: number) {
      const values = Array.from({ length: rows }, () => sql`(
        ${SALON}, 'staff', ${LIMITED}, 'AC Limited', 'manager',
        'access', ${'Customer directory listed'}, 'merchant', now())`);
      await db.execute(sql`
        INSERT INTO audit_log
          (salon_id, actor_kind, actor_id, actor_name, actor_role,
           kind, action, source, created_at)
        VALUES ${sql.join(values, sql`, `)}`);
    }

    it('refuses at the ceiling and not one read before it', async () => {
      const issue = (await import('../auth/sessions')).issueSession;
      await db.execute(sql`
        INSERT INTO staff_user
          (id, salon_id, name, handle, role, branch_access_all, branch_access_ids,
           password_hash, perm_dashboard, perm_appointments, perm_shop, perm_loyalty,
           perm_team, perm_scanner, perm_charges, perm_void, perm_marketing)
        VALUES (${LIMITED}, ${SALON}, ${`AC Limited ${RUN}`}, ${`ac-lim-${RUN}`},
                'manager', true, '{}', 'x', true, false, false, false,
                true, false, false, false, false)`);
      const token = (
        await issue(db, {
          principalKind: 'staff',
          staffId: LIMITED,
          salonId: SALON,
          scope: 'dashboard',
        })
      ).accessToken;

      try {
        // One short of the ceiling. Her own read then makes it exactly the ceiling.
        await stuff(CUSTOMER_DIRECTORY_MAX_PER_WINDOW - 1);
        const allowed = await get(listUrl(SALON), token);
        expect(allowed.status, allowed.raw).toBe(200);

        /**
         * That read wrote its own row, so she now stands AT the ceiling. The next
         * one is refused — by name, and with nothing about a customer in the body.
         */
        const refused = await get(listUrl(SALON), token);
        expect(refused.status, refused.raw).toBe(429);
        expect(refused.body.error).toBe('customer_directory_limit');
        expect(refused.raw).not.toContain('AC Live Customer');

        /** All three doors share the budget — see `CUSTOMER_DIRECTORY_ACTIONS`. */
        const card = await get(cardUrl(SALON, LIVE), token);
        expect(card.status, card.raw).toBe(429);
        const history = await get(historyUrl(SALON, LIVE), token);
        expect(history.status, history.raw).toBe(429);
      } finally {
        await db.execute(sql`DELETE FROM staff_user WHERE id = ${LIMITED}`);
      }
    });
  });

  // ======================================================================
  // THE LIST ITSELF
  // ======================================================================
  describe('the list', () => {
    /**
     * THE CURSOR'S ONE REAL PROPERTY: a page boundary neither repeats a row nor
     * drops one. Asserted over the prefix rather than the book, which is enough —
     * `services/streamCursor.ts`' tiebreak is what makes the order total, and a
     * broken tiebreak shows up at the FIRST boundary, not the fortieth.
     */
    it('pages without repeating a row, and yields each of this run’s members once', async () => {
      const all = await walkList(managerToken);
      expect(new Set(all.map((r) => r.id)).size).toBe(all.length);
      expect(all.filter((r) => r.id === LIVE)).toHaveLength(1);
      expect(all.filter((r) => r.id === ERASED)).toHaveLength(1);
    });

    it('orders newest member first, across a page boundary and not only inside one', async () => {
      const all = await walkList(managerToken);
      expect(all.length).toBeGreaterThan(CUSTOMER_PAGE_SIZE);
      const stamps = all.map((r) => r.joinedAt);
      expect([...stamps].sort().reverse()).toEqual(stamps);
    });

    it('finds a customer by name, by phone digits and by exact member id', async () => {
      const digits = ((await runRows(managerToken)).find((r) => r.id === LIVE) as ListRow)
        .memberPhone as string;
      const byName = await runRows(managerToken, 'ac live');
      const byPhone = await runRows(managerToken, digits.slice(-6));
      const byId = await runRows(managerToken, LIVE);
      for (const [label, rows] of [['name', byName], ['phone', byPhone], ['id', byId]] as const) {
        expect(rows.map((r) => r.id), label).toContain(LIVE);
      }
    });

    /**
     * ==========================================================================
     * AN ID SEARCH RETURNS HER AND NOT WHOEVER SHARES ITS DIGITS.
     * ==========================================================================
     * This is the spec that found the defect. A member id is not all digits —
     * `AC-L-muhu7p8omx` yields `78` — so a phone clause that fires on any digit
     * anywhere turns the most precise identifier a merchant has into a crowd:
     * she reads a number off a customer's card and gets everyone whose phone
     * happens to contain two incidental digits. `customerSearchPredicate` now
     * skips the phone match for any query containing a letter.
     *
     * THE OTHER SALON'S ID IS THE PROBE, because it must return NOTHING — so a
     * single stray row is the whole failure, with no correct match to hide behind.
     */
    it('an id query does not drag in whoever shares its incidental digits', async () => {
      const phone = ((await runRows(managerToken)).find((r) => r.id === LIVE) as ListRow)
        .memberPhone as string;

      /**
       * THE PROBE IS BUILT FROM HER OWN PHONE, WHICH IS WHAT MAKES IT DETERMINISTIC.
       * The first version of this spec searched for the other salon's member id and
       * relied on that id's random suffix HAPPENING to contain digits the fixture
       * phones also contain. It caught the defect on the run that found it and then
       * failed to reproduce under a deliberate inversion, because the suffix that
       * time had no useful digits — a spec that is falsifiable on some runs and not
       * others is not a spec. So the digits are taken from a phone that is known to
       * contain them, and a letter is put in front: a query no phone match may fire
       * on, carrying digits every phone match certainly would.
       */
      const probe = `AC-${phone.slice(-5, -1)}`;
      expect(/\p{L}/u.test(probe)).toBe(true);
      expect(await runRows(managerToken, probe)).toHaveLength(0);

      /** And the control: those same digits alone DO find her. */
      expect((await runRows(managerToken, phone.slice(-5, -1))).map((r) => r.id)).toContain(LIVE);

      // Her own id returns exactly her, not her and a handful of neighbours.
      expect((await runRows(managerToken, LIVE)).map((r) => r.id)).toEqual([LIVE]);
      expect(await runRows(managerToken, OTHER_MEMBER)).toHaveLength(0);
    });

    /**
     * THE LIKE ESCAPE. `likeLiteral` is imported from `services/memberSearch.ts`
     * rather than rewritten, and this is what it buys: an unescaped `%` does not
     * throw, it returns the book. A spec that only searched for real names would
     * never see the difference.
     */
    it('a query of % is a search for a percent sign, not a request for the book', async () => {
      const rows = await walkList(managerToken, '%');
      expect(rows).toHaveLength(0);
      // The control: the book it would have returned is not empty.
      expect((await walkList(managerToken)).length).toBeGreaterThan(0);
    });

    /**
     * NO MINIMUM LENGTH, AND IT IS DELIBERATE — `services/customerDirectory.ts` § 2.
     * The scanner refuses a one-character query; this is a list whose no-query
     * state is already the whole book, so the same refusal would cost a merchant a
     * keystroke and an attacker nothing. Pinned so that "adding" it later is a
     * visible decision rather than a tidy-up.
     */
    it('a one-character query is answered, not refused', async () => {
      const res = await get(listUrl(SALON, 'a'), managerToken);
      expect(res.status).toBe(200);
    });
  });
});
