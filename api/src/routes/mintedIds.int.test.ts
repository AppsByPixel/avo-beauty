/**
 * THE TWO MERCHANT- AND CUSTOMER-FACING IDS ARE UNIQUE UNDER LOAD.
 *
 * =========================================================================
 * WHAT BROKE
 * =========================================================================
 * `routes/campaigns.ts` minted `CMP-${Math.floor(Math.random() * 9000 + 1000)}`
 * and `routes/support.ts` minted `SUP-${... * 90_000 + 10_000}`, straight into a
 * PRIMARY KEY, with no uniqueness check and no retry. A duplicate is an unhandled
 * 23505 that leaves the handler as a 500 `server_error`, so the merchant is told
 * "Something went wrong on our side" about a campaign that was refused by a dice
 * roll. Observed on dev 2026-09-17 during a full `e2e/` run:
 * `duplicate key value violates unique constraint "campaign_pkey"`,
 * `Key (id)=(CMP-6994) already exists`.
 *
 * Migration 0051 replaced both with a sequence. This file is the spec that would
 * have failed before it.
 *
 * =========================================================================
 * WHY THIS CANNOT BE A UNIT SPEC
 * =========================================================================
 * The claim is about a PRIMARY KEY, and a primary key is a database object. A
 * mock cannot raise 23505 unless it is taught to, and a mock taught to raise it
 * is asserting the test author's model of the constraint rather than the
 * constraint. The old minter was type-correct, lint-clean and passed every unit
 * spec in this repo for the whole of its life; the only thing that ever
 * disagreed with it was postgres.
 *
 * `nextval` is also not something a mock has an opinion about. The property under
 * test — "N mints produce N distinct ids" — is a property of the sequence and the
 * index together.
 *
 * =========================================================================
 * WRITES NOTHING THAT SURVIVES
 * =========================================================================
 * Every insert runs inside a transaction that is ROLLED BACK, the shape
 * `campaignAudience.int.test.ts` uses and for its reason: this file makes no
 * claim about the state of the database and leaves none, so it is idempotent
 * across repeat runs by construction rather than by a "reset first" footnote.
 * `api/README.md` records that the int suite as a whole is green exactly once per
 * reset; this file is not part of why.
 *
 * THE SEQUENCE ITSELF IS NOT ROLLED BACK, which is the documented trade — a
 * rolled-back transaction burns the numbers it drew. That is invisible in a
 * campaign id and it is what makes the mint collision-free without a retry loop,
 * so this suite consuming a few thousand values per run is the design working,
 * not a leak.
 *
 * Run it against your own lane database, never a shared one:
 *
 *     ./scripts/lane-db.sh a
 *     export AVO_INT_DATABASE_URL="postgres://avo_app:avo_app_dev_password@localhost:5433/avo_lane_a"
 *     pnpm --dir "$PWD/api" run test:int
 */

import { beforeAll, describe, expect, it } from 'vitest';

const INT_URL = process.env.AVO_INT_DATABASE_URL;
const suite = INT_URL ? describe : describe.skip;

/** The seeded salon and one of its seeded members. */
const SALON = 'SAL-AMARA';
const MEMBER = '8842';

/**
 * HOW MANY MINTS MAKE THIS SPEC DECISIVE RATHER THAN LUCKY.
 *
 * It is a birthday problem, so the number that matters is not "how likely is one
 * collision" but "how likely is NO collision across N draws", which is
 * approximately exp(-N(N-1)/2S) for a space of size S.
 *
 *   CMP-, S = 9000,  N = 1000  ->  P(no collision) ~ 1e-24. Certain.
 *   SUP-, S = 90000, N = 1000  ->  P(no collision) ~ 0.004. 99.6% certain.
 *
 * So a green run of this file under the OLD minter was not merely unlikely, it
 * was unreachable for campaigns and a 1-in-250 fluke for tickets. Under a
 * sequence both are exact, not probable, which is the whole point of the change:
 * the number below is chosen to make the old code fail, and it has no bearing on
 * whether the new code passes.
 */
const MINTS = 1000;

/** `CMP-10000` and up — migration 0051's start value, a digit wider than the
 *  1000..9999 the random minter used, so a minted id cannot collide with a row
 *  that was already in the table when the migration ran. */
const CAMPAIGN_FLOOR = 10_000;
/** `SUP-100000` and up, clearing the old 10000..99999 the same way. */
const TICKET_FLOOR = 100_000;

function suffixes(ids: string[], prefix: string): number[] {
  return ids.map((id) => {
    expect(id.startsWith(prefix), `"${id}" does not start with "${prefix}"`).toBe(true);
    const n = Number(id.slice(prefix.length));
    expect(Number.isInteger(n), `"${id}" does not end in an integer`).toBe(true);
    return n;
  });
}

/** The one assertion this file exists for, said once for both prefixes. */
function expectAllDistinct(ids: string[], what: string): void {
  const seen = new Map<string, number>();
  for (const id of ids) seen.set(id, (seen.get(id) ?? 0) + 1);
  const duplicates = [...seen.entries()].filter(([, n]) => n > 1);
  expect(
    duplicates,
    `${duplicates.length} of ${ids.length} minted ${what} ids repeated: ` +
      `${duplicates.slice(0, 5).map(([id, n]) => `${id} x${n}`).join(', ')}. ` +
      `That is the 500 the merchant sees, reproduced.`,
  ).toEqual([]);
  expect(seen.size).toBe(ids.length);
}

suite('a merchant- or customer-facing id is minted from a sequence, not a dice roll', () => {
  let db: typeof import('../db/client')['db'];
  let campaign: typeof import('../db/schema/campaign')['campaign'];
  let supportTicket: typeof import('../db/schema/legal')['supportTicket'];
  let supportTopic: typeof import('../db/schema/legal')['supportTopic'];
  let campaignId: typeof import('./campaigns')['campaignId'];
  let ticketId: typeof import('./support')['ticketId'];

  beforeAll(async () => {
    db = (await import('../db/client')).db;
    campaign = (await import('../db/schema/campaign')).campaign;
    ({ supportTicket, supportTopic } = await import('../db/schema/legal'));
    // THE EXPRESSIONS THE ROUTES ACTUALLY USE, imported rather than retyped. A
    // copy of the SQL here would pass while `POST /campaigns` kept minting at
    // random, which is the one outcome this file must not be able to have.
    ({ campaignId } = await import('./campaigns'));
    ({ ticketId } = await import('./support'));
  });

  /**
   * Rolled back. `tx.rollback()` throws to unwind, so the catch below distinguishes
   * that from a real failure — anything else, 23505 above all, is the bug.
   */
  async function inRollback(fn: (tx: never) => Promise<void>): Promise<void> {
    try {
      await db.transaction(async (tx) => {
        await fn(tx as never);
        tx.rollback();
      });
    } catch (error) {
      if (!(error as Error)?.constructor?.name?.includes('TransactionRollback')) throw error;
    }
  }

  it(`mints ${MINTS} campaign ids with no duplicate and no 23505`, async () => {
    let ids: string[] = [];

    await inRollback(async (tx) => {
      const rows = await (tx as unknown as typeof db)
        .insert(campaign)
        .values(
          Array.from({ length: MINTS }, (_, i) => ({
            id: campaignId,
            salonId: SALON,
            title: `Minted id probe ${i}`,
            body: 'Rolled back. Nothing here survives the transaction.',
            channel: 'push',
            audience: 'all' as never,
            reward: 'none',
            reach: 0,
            sendWhen: 'now',
            // Non-negotiable #8 holds here too: nothing this file writes is
            // anything but `pending`, and all of it is rolled back regardless.
            status: 'pending' as const,
            submittedBy: 'mintedIds.int.test',
            submittedAt: new Date(),
          })),
        )
        .returning({ id: campaign.id });
      ids = rows.map((r) => r.id);
    });

    expect(ids).toHaveLength(MINTS);
    expectAllDistinct(ids, 'campaign');
    for (const n of suffixes(ids, 'CMP-')) {
      expect(n, 'a minted id landed in the space the random minter already used').toBeGreaterThanOrEqual(
        CAMPAIGN_FLOOR,
      );
    }
  });

  it(`mints ${MINTS} support ticket ids with no duplicate and no 23505`, async () => {
    const [topic] = await db
      .select({ id: supportTopic.id, route: supportTopic.route })
      .from(supportTopic)
      .limit(1);
    expect(topic, 'no seeded support topic — run ./scripts/lane-db.sh a').toBeTruthy();

    let ids: string[] = [];

    await inRollback(async (tx) => {
      const rows = await (tx as unknown as typeof db)
        .insert(supportTicket)
        .values(
          Array.from({ length: MINTS }, (_, i) => ({
            id: ticketId,
            memberId: MEMBER,
            salonId: SALON,
            topicId: topic!.id,
            // Non-negotiable #11: the route is resolved from the TOPIC, never from
            // the client. This fixture is not the handler, so rather than assert
            // that it takes the topic's route and then supply its own, it reads
            // it — a fixture that hardcoded 'avo' would still be green on the day
            // somebody made the handler hardcode it too.
            route: topic!.route,
            message: `Minted id probe ${i}. Rolled back.`,
            via: 'email' as const,
          })),
        )
        .returning({ id: supportTicket.id });
      ids = rows.map((r) => r.id);
    });

    expect(ids).toHaveLength(MINTS);
    expectAllDistinct(ids, 'support ticket');
    for (const n of suffixes(ids, 'SUP-')) {
      expect(n, 'a minted id landed in the space the random minter already used').toBeGreaterThanOrEqual(
        TICKET_FLOOR,
      );
    }
  });

  /**
   * THE TWO SEQUENCES ARE SEPARATE OBJECTS. Sharing one would still be unique, so
   * no spec above would notice — and campaign ids would skip in blocks whenever
   * support was busy. A merchant reading "CMP-10000" and then "CMP-14820" back to
   * support has been handed a live count of somebody else's tickets, which is the
   * enumerability 0025 accepted for a salon's own members turned into a leak
   * across tenants.
   */
  it('draws campaign ids and ticket ids from different sequences', async () => {
    const [topic] = await db
      .select({ id: supportTopic.id, route: supportTopic.route })
      .from(supportTopic)
      .limit(1);
    expect(topic, 'no seeded support topic — run ./scripts/lane-db.sh a').toBeTruthy();

    let before = 0;
    let after = 0;

    await inRollback(async (tx) => {
      const t = tx as unknown as typeof db;

      const [a] = await t.select({ minted: campaignId }).from(supportTopic).limit(1);

      // A hundred ticket ids drawn in between. Under one shared sequence the next
      // campaign id would be 101 further on, not 1.
      await t.insert(supportTicket).values(
        Array.from({ length: 100 }, (_, i) => ({
          id: ticketId,
          memberId: MEMBER,
          salonId: SALON,
          topicId: topic!.id,
          route: topic!.route,
          message: `Sequence separation probe ${i}. Rolled back.`,
          via: 'email' as const,
        })),
      );

      const [b] = await t.select({ minted: campaignId }).from(supportTopic).limit(1);

      before = Number(String(a!.minted).slice('CMP-'.length));
      after = Number(String(b!.minted).slice('CMP-'.length));
    });

    expect(
      after - before,
      `a hundred ticket ids moved the campaign sequence by ${after - before}. ` +
        `Both prefixes are drawing from one sequence.`,
    ).toBe(1);
  });
});
