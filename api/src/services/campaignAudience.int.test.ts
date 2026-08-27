/**
 * EVERY CAMPAIGN AUDIENCE, AGAINST A REAL DATABASE AND THE REAL DRIVER — on the
 * create path AND on the release path.
 *
 * =========================================================================
 * WHY THIS CANNOT BE A UNIT SPEC
 * =========================================================================
 * `audience: "lapsed"` answered 500 `server_error` for the whole life of
 * `POST /v1/salons/{id}/campaigns` while the other four answered 201. The failure
 * was a `Date` reaching postgres.js as a bound parameter after `drizzle()` had
 * replaced the driver's date serializer with an identity function — so it happens
 * at BIND time, on a socket, and no mock produces it. `campaignAudience.test.ts`
 * asserts the compiled-parameter property (and runs in `pnpm check`); this file is
 * the one that proves the query executes.
 *
 * `vitest.int.config.ts` carries why this suite is separate, why it is not in
 * `pnpm check`, and why it SKIPS rather than connects when `AVO_INT_DATABASE_URL`
 * is unset. Run it against your own lane database, never a shared one:
 *
 *     ./scripts/lane-db.sh a
 *     export AVO_INT_DATABASE_URL="postgres://avo_app:avo_app_dev_password@localhost:5433/avo_lane_a"
 *     pnpm --dir "$PWD/api" run test:int
 *
 * =========================================================================
 * THE RELEASE PATH IS COVERED BECAUSE IT SHARES THE PREDICATE
 * =========================================================================
 * `resolveAudience` is called TWICE in a campaign's life: by `computeReach` when
 * the merchant submits, and by `deliverCampaign` step 3 when the platform releases
 * it — non-negotiable #8's "caps and quiet hours are enforced again at send time",
 * which cannot be enforced against an audience without resolving one. So the bug
 * was two 500s, not one: a merchant could not create a `lapsed` campaign, and an
 * ALREADY-APPROVED `lapsed` campaign could not be released either. Both are here.
 *
 * =========================================================================
 * WRITES NOTHING THAT SURVIVES, AND MEASURES NO ABSOLUTE COUNT
 * =========================================================================
 * `deliverCampaign` writes `campaign_send` rows, flips a status, raises a merchant
 * notification and writes audit — so each release runs inside a transaction that is
 * ROLLED BACK. That is what `topupLimit.int.test.ts` § NO CLEANUP argues for from
 * the other direction: this file makes no claim about the state of the database and
 * leaves none, so it is idempotent across repeat runs by construction rather than
 * by a "reset first" footnote.
 *
 * IT DOES NOT MUTATE THE POLICY TO GET A CLEAN RUN, either. The cap and the quiet
 * window are the real ones; only `now` is chosen — pinned to the middle of a
 * Kuwaiti afternoon, because a suite that held on quiet hours would prove nothing
 * about the audience and would pass or fail by the hour it ran. If a spec here ever
 * DOES hold on quiet hours or the monthly cap it fails with that named, because
 * either is a hold BEFORE step 3 and would be a green run that never resolved an
 * audience at all.
 *
 * Cases derive from `CAMPAIGN_AUDIENCES`, for the reason
 * `campaignAudience.test.ts` gives at length: the trap in this bug is the
 * single-value fix.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { CAMPAIGN_AUDIENCES } from '../db/schema/campaign';

const INT_URL = process.env.AVO_INT_DATABASE_URL;
const suite = INT_URL ? describe : describe.skip;

/** The seeded salon. `Asia/Kuwait`, UTC+3, no DST. */
const SALON = 'SAL-AMARA';

/**
 * 12:00Z is 15:00 in Kuwait — comfortably outside the seeded quiet window
 * (22:00–09:00) at both ends, so neither a clock skew nor the three-hour offset can
 * put a run inside it.
 */
const NOW = new Date('2026-08-27T12:00:00.000Z');

/** The two hold sentences that can only be reached AFTER the audience resolved. */
function isAudienceHold(reason: string | null): boolean {
  if (reason === null) return false;
  return (
    reason.startsWith('Nobody is in this audience right now') ||
    /^Every one of the \d+ customers in this audience/.test(reason)
  );
}

suite('every campaign audience resolves against the real driver', () => {
  let db: typeof import('../db/client')['db'];
  let svc: typeof import('./campaign');
  let campaign: typeof import('../db/schema/campaign')['campaign'];

  beforeAll(async () => {
    db = (await import('../db/client')).db;
    svc = await import('./campaign');
    campaign = (await import('../db/schema/campaign')).campaign;
  });

  it('covers all five audiences the schema allows', () => {
    expect(CAMPAIGN_AUDIENCES).toHaveLength(5);
    expect([...CAMPAIGN_AUDIENCES]).toContain('lapsed');
  });

  // ------------------------------------------------------------ create path --
  /**
   * What the merchant hits. `computeReach` is the only database work
   * `POST /campaigns` does before the insert, and it is where the 500 came from.
   */
  for (const audience of CAMPAIGN_AUDIENCES) {
    it(`computes reach for audience "${audience}" (POST /campaigns)`, async () => {
      const reach = await svc.computeReach(db, { salonId: SALON, audience, now: NOW });
      expect(Number.isInteger(reach), `reach for "${audience}" was ${reach}`).toBe(true);
      expect(reach).toBeGreaterThanOrEqual(0);
    });
  }

  /**
   * `resolveAudience` returns the ids the release loop will write sends for. Asserted
   * separately from `computeReach` because `computeReach` is only its length, and a
   * predicate that threw would fail both identically while a predicate that returned
   * the wrong SHAPE would only fail here.
   */
  for (const audience of CAMPAIGN_AUDIENCES) {
    it(`resolves the audience ids for "${audience}"`, async () => {
      const ids = await svc.resolveAudience(db, { salonId: SALON, audience, now: NOW });
      expect(Array.isArray(ids)).toBe(true);
      for (const id of ids) expect(typeof id).toBe('string');
    });
  }

  // ----------------------------------------------------------- release path --
  for (const audience of CAMPAIGN_AUDIENCES) {
    it(`releases an approved "${audience}" campaign (platform decision endpoint)`, async () => {
      let outcome: import('./campaign').DeliveryOutcome | null = null;

      try {
        await db.transaction(async (tx) => {
          const [row] = await tx
            .insert(campaign)
            .values({
              id: `CMP-INT-AUD-${audience.toUpperCase()}`,
              salonId: SALON,
              title: 'Audience release probe',
              body: 'Rolled back. Nothing here survives the transaction.',
              channel: 'push',
              audience,
              reward: 'none',
              reach: 0,
              sendWhen: 'now',
              // Already approved: this is the release, not the submission.
              status: 'approved',
              submittedBy: 'campaignAudience.int.test',
              submittedAt: NOW,
              decidedBy: 'campaignAudience.int.test',
              decidedAt: NOW,
            })
            .returning();

          outcome = await svc.deliverCampaign(tx, row!, { actor: null, now: NOW });
          tx.rollback();
        });
      } catch (error) {
        // `tx.rollback()` throws to unwind. Anything else is the failure under test.
        if (!(error as Error)?.constructor?.name?.includes('TransactionRollback')) throw error;
      }

      expect(outcome, `deliverCampaign returned nothing for "${audience}"`).not.toBeNull();
      const o = outcome as unknown as import('./campaign').DeliveryOutcome;

      /**
       * A hold is a legitimate outcome — an empty `lapsed` segment on a lane database
       * with two seeded members is expected. What must NOT happen is a hold from step
       * 1 or step 2, because those return before the audience is ever resolved and
       * would make this spec green without exercising the thing it exists for.
       */
      expect(
        o.status === 'sent' || isAudienceHold(o.heldReason),
        `audience "${audience}" was held before step 3 resolved an audience: ` +
          `${o.heldReason}. That is a quiet-hours or monthly-cap hold, so this run ` +
          `proved nothing about the predicate. Reset the lane database ` +
          `(./scripts/lane-db.sh a) and check the seeded platform_messaging_policy.`,
      ).toBe(true);

      if (o.status === 'sent') {
        expect(o.sent).toBeGreaterThan(0);
        expect(o.result).toMatch(/^\d+ reached/);
      } else {
        expect(o.sent).toBe(0);
      }
    });
  }
});
