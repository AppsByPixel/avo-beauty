/**
 * THE NO-SHOW RETURN WINDOW HAS A CEILING NOW, AND EVERY DOOR ONTO THE COLUMN
 * IS DRIVEN HERE.
 *
 * The reported gap: `parseNoShowReturnMinutes` refused only `<= 0`, so
 * `noShowReturnMinutes: 525600` was accepted and stored — ONE YEAR was a storable
 * no-show window. Lane C hit it building the Settings control and could not pick
 * a preset list, because a range invented in a client is a range the next client
 * will not have (non-negotiable #7's reasoning, applied to a bound).
 *
 * WHY THE BOUND IS A MONEY GUARD AND NOT A PREFERENCE
 * ---------------------------------------------------
 * ONE NUMBER IS TWO WINDOWS, and only one of them is the one the merchant thinks
 * she is setting. Both readers are in `services/booking.ts`:
 *
 *   markNoShow           `no_show_return_due_at = ends_at + noShowReturnMinutes`
 *                        — how long a missed slot's deposit waits before it goes
 *                        back to her customer's wallet.
 *
 *   findApplicableHold   the EARLY-ARRIVAL GRACE at the counter:
 *                        `starts_at <= now + noShowReturnMinutes` decides WHICH
 *                        held deposit a charge may consume. Its own header states
 *                        the case: "A customer with an appointment next Tuesday
 *                        who walks in today for a blow-dry must not have
 *                        Tuesday's deposit spent on it."
 *
 * At 525600 every hold a member owns satisfies that predicate, so the charge
 * consumes whichever the ordering returns first. That is a money defect reachable
 * BY CONFIGURATION, through a Settings field, with no bad code anywhere — which is
 * why the bound is asserted here against the real API rather than argued about.
 *
 * WHAT THIS FILE PROVES THAT A UNIT TEST CANNOT
 * ---------------------------------------------
 * `salons.test.ts` already drives `buildSalonPatch` directly and proves the
 * validator refuses both ends. It cannot prove the THIRD door: a statement that
 * never goes through a route. `salon_no_show_return_in_range` (migration 0051) is
 * the guarantee for that one, and the last describe below runs the UPDATE as
 * `avo_app` — the role `db/client.ts` actually connects as — and reads the
 * refusal off the database.
 *
 * TWO HTTP DOORS, ONE FUNCTION. `PATCH /salons/{id}` and
 * `PATCH /v1/platform/salons/{id}` both call `buildSalonPatch`; they differ only
 * in which allow-list they pass. That is the whole safety argument for the console
 * route, so it is asserted rather than assumed — `brandColor`'s precedent is a
 * guard that lived on one of two doors.
 *
 * THIS FILE OWNS NO ROWS. It writes one column of the SEEDED salon and puts back
 * what it found, read in `beforeAll` rather than assumed to be 60. Nothing else
 * here creates anything, so there is nothing to collide with on a second run —
 * `artistDayVoid.int.test.ts` § THE FIXTURE OWNS ITS OWN SLOT is the longer
 * version of that rule.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

const INT_URL = process.env.AVO_INT_DATABASE_URL;
const suite = INT_URL ? describe : describe.skip;

const SALON = 'SAL-AMARA';
/** Noura — every permission. `PATCH /salons/{id}` is `requireDashboardPerm(req, 'loyalty')`. */
const MANAGER = 'ST-001';
/** The console owner, every section. `PATCH /v1/platform/salons/{id}` takes `salons`. */
const PLATFORM_OWNER = 'PLT-001';

/** The bound, spelled here as the reader of the specs would say it. */
const FLOOR = 5;
const CEILING = 1440;

suite('the no-show return window is bounded at every door onto the column', () => {
  let app: FastifyInstance;
  let db: (typeof import('../db/client'))['db'];
  let sql: (typeof import('drizzle-orm'))['sql'];

  let merchantBearer = '';
  let platformBearer = '';
  /** What the salon held before this file ran. Restored in `afterAll`. */
  let original = 0;

  const exec = async (q: unknown) =>
    (await db.execute(q as never)) as unknown as Array<Record<string, unknown>>;

  /** The stored value, read from the row — never from the API's own reply. */
  const stored = async (): Promise<number> =>
    Number(
      (await exec(sql`SELECT no_show_return_minutes AS n FROM salon WHERE id = ${SALON}`))[0]?.n,
    );

  const merchantPatch = (minutes: unknown) =>
    app.inject({
      method: 'PATCH',
      url: `/salons/${SALON}`,
      headers: { authorization: `Bearer ${merchantBearer}` },
      payload: { noShowReturnMinutes: minutes },
    });

  const consolePatch = (minutes: unknown) =>
    app.inject({
      method: 'PATCH',
      url: `/v1/platform/salons/${SALON}`,
      headers: { authorization: `Bearer ${platformBearer}` },
      payload: { noShowReturnMinutes: minutes },
    });

  beforeAll(async () => {
    db = (await import('../db/client')).db;
    sql = (await import('drizzle-orm')).sql;
    const issueSession = (await import('../auth/sessions')).issueSession;
    app = await (await import('../app')).buildApp();

    original = await stored();

    merchantBearer = (
      await issueSession(db, {
        principalKind: 'staff',
        staffId: MANAGER,
        salonId: SALON,
        scope: 'dashboard',
      })
    ).accessToken;

    platformBearer = (
      await issueSession(db, {
        principalKind: 'platform_admin',
        platformAdminId: PLATFORM_OWNER,
        salonId: null,
        scope: 'platform',
      })
    ).accessToken;
  });

  afterAll(async () => {
    if (db && sql) {
      await exec(sql`
        UPDATE salon SET no_show_return_minutes = ${original} WHERE id = ${SALON}`);
    }
    await app?.close();
  });

  // ------------------------------------------------- the merchant's own door --

  describe('PATCH /salons/{id} — the Settings screen', () => {
    it('THE REPORTED GAP — a year is refused, and nothing was stored', async () => {
      const before = await stored();

      const res = await merchantPatch(525_600);
      expect(res.statusCode, res.body).toBe(400);
      expect((res.json() as { error: string }).error).toBe('invalid_no_show_window');

      /**
       * THE HALF THAT MATTERS. A refusal that had already written the column would
       * be worse than no refusal: the merchant is told no and the till's grace is
       * a year wide anyway. Read off the ROW, not off the reply.
       */
      expect(await stored(), 'a refused window must not have been stored').toBe(before);
    });

    it('refuses one minute past the ceiling and accepts the ceiling itself', async () => {
      const over = await merchantPatch(CEILING + 1);
      expect(over.statusCode, over.body).toBe(400);
      expect((over.json() as { error: string }).error).toBe('invalid_no_show_window');

      /**
       * BOTH SIDES OF THE EDGE. A bound nobody tests AT the edge is a bound the
       * next person loosens by one on a hunch — `artistDayVoid`'s 300/301 cap is
       * the same assertion one field over.
       */
      const at = await merchantPatch(CEILING);
      expect(at.statusCode, at.body).toBe(200);
      expect(await stored()).toBe(CEILING);
    });

    it('refuses one minute below the floor and accepts the floor itself', async () => {
      const under = await merchantPatch(FLOOR - 1);
      expect(under.statusCode, under.body).toBe(400);
      expect((under.json() as { error: string }).error).toBe('invalid_no_show_window');

      const at = await merchantPatch(FLOOR);
      expect(at.statusCode, at.body).toBe(200);
      expect(await stored()).toBe(FLOOR);
    });

    it('still refuses zero, a negative and a fraction — the old floor did not move', async () => {
      for (const bad of [0, -60, 30.5]) {
        const res = await merchantPatch(bad);
        expect(res.statusCode, `${bad}: ${res.body}`).toBe(400);
        expect((res.json() as { error: string }).error).toBe('invalid_no_show_window');
      }
    });
  });

  // ----------------------------------------------------- AVO's door, the same --

  describe('PATCH /v1/platform/salons/{id} — the console editor', () => {
    /**
     * THE SECOND DOOR ONTO ONE COLUMN, and the reason it is safe is structural
     * rather than duplicated: both routes call `buildSalonPatch`, which calls this
     * validator. Asserted anyway — `brandColor` sat unguarded on one of two doors
     * for the life of the route, and `salons.ts` § `modules` records what that
     * cost. A console copy of this field would be the copy nobody watches.
     */
    it('refuses a year through the console too, with the same code', async () => {
      const before = await stored();

      const res = await consolePatch(525_600);
      expect(res.statusCode, res.body).toBe(400);
      expect((res.json() as { error: string }).error).toBe('invalid_no_show_window');
      expect(await stored(), 'a refused console window must not have been stored').toBe(before);
    });

    it('accepts an in-range window through the console', async () => {
      const res = await consolePatch(90);
      expect(res.statusCode, res.body).toBe(200);
      expect(await stored()).toBe(90);
    });
  });

  // ------------------------------------- the onboarding wizard is NOT a door --

  it('POST /v1/platform/salons does not take the field at all', async () => {
    /**
     * ASKED RATHER THAN ASSUMED. The create endpoint has its own input parser
     * (`services/salonOnboarding.ts § parseOnboardInput`) and does NOT go through
     * `buildSalonPatch`, so if it accepted this field it would be a genuine third
     * door with no guard on it — which is exactly the `brandColor` shape. It does
     * not: the field is outside `ACCEPTED`, so a new salon takes the column
     * default and the window is set afterwards through the editor above.
     *
     * Refused on the allow-list, BEFORE the required-field checks and before the
     * transaction opens, so this request creates nothing.
     */
    const res = await app.inject({
      method: 'POST',
      url: '/v1/platform/salons',
      headers: {
        authorization: `Bearer ${platformBearer}`,
        'idempotency-key': `ns-window-${Date.now()}`,
      },
      payload: { noShowReturnMinutes: 60 },
    });
    expect(res.statusCode, res.body).toBe(400);
    expect((res.json() as { error: string }).error).toBe('not_settable_here');
  });

  // -------------------------------------------- the door that is not a route --

  describe('salon_no_show_return_in_range — what the validator alone cannot refuse', () => {
    /**
     * THE STATEMENT THAT NEVER PASSES A HANDLER. A validator guards the requests
     * it sees; this guards the column. Run as `avo_app`, the role
     * `db/client.ts` connects as, so it is the privilege set production has —
     * `vitest.int.config.ts` § "a limiter proved under the owner role is a limiter
     * proved against privileges production does not have".
     *
     * `db:verify` does not carry this invariant (it holds none for this column),
     * so this file is where the CHECK is exercised.
     */
    const refusedBy = async (minutes: number): Promise<string> => {
      try {
        await exec(sql`
          UPDATE salon SET no_show_return_minutes = ${minutes} WHERE id = ${SALON}`);
      } catch (err) {
        return String((err as { constraint_name?: string }).constraint_name ?? err);
      }
      throw new Error(`the database stored ${minutes}, which the CHECK must refuse`);
    };

    it('refuses a year written straight at the column', async () => {
      expect(await refusedBy(525_600)).toBe('salon_no_show_return_in_range');
    });

    it('refuses one minute, which the old `> 0` CHECK allowed', async () => {
      /**
       * THE HALF THE REPLACED CONSTRAINT WOULD HAVE PASSED. `salon_no_show_return_positive`
       * was `> 0`, so 1 was storable — a grace so short that a customer arriving
       * two minutes early has a deposit the till cannot see. Migration 0051's
       * floor is the part of this change that is not about the ceiling.
       */
      expect(await refusedBy(1)).toBe('salon_no_show_return_in_range');
    });

    it('and the old constraint is gone rather than shadowed', async () => {
      /**
       * A `> 0` left beside a `BETWEEN 5 AND 1440` could never be the constraint
       * that fires, and a constraint that cannot fire reads as evidence of a lower
       * regime that does not exist. Migration 0051 drops it; this is the assertion
       * that it was dropped and not merely out-argued in a comment.
       */
      const rows = await exec(sql`
        SELECT conname FROM pg_constraint
         WHERE conrelid = 'salon'::regclass AND conname LIKE '%no_show%'`);
      expect(rows.map((r) => r.conname)).toEqual(['salon_no_show_return_in_range']);
    });

    it('accepts both edges, so the CHECK and the validator agree on the range', async () => {
      await exec(sql`UPDATE salon SET no_show_return_minutes = ${FLOOR} WHERE id = ${SALON}`);
      expect(await stored()).toBe(FLOOR);
      await exec(sql`UPDATE salon SET no_show_return_minutes = ${CEILING} WHERE id = ${SALON}`);
      expect(await stored()).toBe(CEILING);
    });
  });
});
