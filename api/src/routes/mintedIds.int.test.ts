/**
 * EVERY HUMAN-FACING ID THE API MINTS IS UNIQUE UNDER LOAD — ALL SIX PREFIXES.
 *
 * =========================================================================
 * WHAT BROKE
 * =========================================================================
 * Nine minters across five prefixes drew a PRIMARY KEY from a small random space
 * with no uniqueness check and no retry. A duplicate is an unhandled 23505.
 * Observed on dev 2026-09-17 in a full `e2e/` run:
 * `duplicate key value violates unique constraint "campaign_pkey"`,
 * `Key (id)=(CMP-6994) already exists`.
 *
 * Migrations 0052 (`CMP-`, `SUP-`) and 0053 (`TX-`, `BK-`, `NT-`) replaced all of
 * them with sequences, and `services/ids.ts` is the one place they live now.
 *
 * `TX-` is the one that matters: a colliding transaction id does NOT surface as a
 * 500. `routes/orders.ts` and friends read every 23505 as an idempotency-key
 * collision and answer `409 request_in_progress` — "still being processed" — for a
 * charge that never happened, on a path whose natural remedy is to charge again.
 * `services/ids.ts` carries the full argument.
 *
 * =========================================================================
 * WHY THIS CANNOT BE A UNIT SPEC
 * =========================================================================
 * The claim is about a PRIMARY KEY and a sequence, which are database objects. A
 * mock cannot raise 23505 unless it is taught to, and a mock taught to raise it
 * asserts the test author's model of the constraint rather than the constraint.
 * The old minters were type-correct, lint-clean and passed every unit spec in this
 * repo for the whole of their lives; the only thing that ever disagreed with them
 * was postgres.
 *
 * `services/ids.test.ts` is the unit half — a source census that fails if anybody
 * adds a tenth minter. It runs in `pnpm check`; this does not.
 *
 * =========================================================================
 * TWO PROOFS, BECAUSE THE SPACES DIFFER BY THREE ORDERS OF MAGNITUDE
 * =========================================================================
 * BULK INSERT against the real primary key, for `CMP-`, `SUP-` and `NT-`. It is a
 * birthday problem, so what matters is P(no collision) over N draws from a space
 * of S, about exp(-N(N-1)/2S):
 *
 *   CMP-, S = 9,000,      N = 1000  ->  ~1e-24.  Certain to have failed before.
 *   SUP-, S = 90,000,     N = 1000  ->  ~0.004.  99.6% certain.
 *   NT-,  S = 9,000,000,  N = 1000  ->  ~0.95.   NOT decisive on its own.
 *
 * MONOTONICITY, for `TX-`, `BK-` and `NT-`, whose old space was 9,000,000. Making
 * a bulk insert decisive there would need ~6,400 rows of real money fixtures, which
 * is not a spec, it is a load test. So these assert the property a sequence HAS and
 * a dice roll cannot: N draws that strictly increase. P(200 random draws arriving
 * in strictly ascending order) is 1/200!, which is zero in every sense that
 * matters — so a small N is decisive here where a large N was needed there.
 *
 * Both also assert the id clears the space the random minter already used, which
 * is what makes migrations 0052 and 0053 safe on a live database.
 *
 * =========================================================================
 * WRITES NOTHING THAT SURVIVES
 * =========================================================================
 * Every insert runs inside a transaction that is ROLLED BACK, the shape
 * `campaignAudience.int.test.ts` uses and for its reason: this file makes no claim
 * about the state of the database and leaves none, so it is idempotent across
 * repeat runs by construction rather than by a "reset first" footnote.
 * `api/README.md` records that the int suite is green exactly once per reset; this
 * file is not part of why.
 *
 * THE SEQUENCES THEMSELVES ARE NOT ROLLED BACK, which is the documented trade — a
 * rolled-back transaction burns the numbers it drew. That is invisible in a receipt
 * reference and it is what makes the mint collision-free without a retry loop, so
 * this suite consuming a few thousand values per run is the design working.
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

/** See the header: enough to have failed before, for the spaces where it can be. */
const MINTS = 1000;
/** Enough for monotonicity, which needs no margin at all. */
const DRAWS = 200;

/**
 * Migration 0052, 0053 and 0054 start values — each a digit wider than the space its
 * random minter used, so a minted id cannot collide with a row that was already
 * in the table when the migration ran.
 */
const FLOOR = {
  'CMP-': 10_000,
  'SUP-': 100_000,
  'TX-': 10_000_000,
  'BK-': 10_000_000,
  'NT-': 10_000_000,
  /** 0054. Old `TI-` ids are six chars of [0-9A-Z], so an all-digit one tops out
   *  at 999,999 — this is two digits clear of it. */
  'TI-': 10_000_000,
} as const;

function suffix(id: string, prefix: keyof typeof FLOOR): number {
  expect(id.startsWith(prefix), `"${id}" does not start with "${prefix}"`).toBe(true);
  const n = Number(id.slice(prefix.length));
  expect(Number.isInteger(n), `"${id}" does not end in an integer`).toBe(true);
  return n;
}

/** The one assertion this file exists for, said once for every prefix. */
function expectAllDistinct(ids: string[], what: string): void {
  const seen = new Map<string, number>();
  for (const id of ids) seen.set(id, (seen.get(id) ?? 0) + 1);
  const duplicates = [...seen.entries()].filter(([, n]) => n > 1);
  expect(
    duplicates,
    `${duplicates.length} of ${ids.length} minted ${what} ids repeated: ` +
      `${duplicates.slice(0, 5).map(([id, n]) => `${id} x${n}`).join(', ')}. ` +
      `That is the collision, reproduced.`,
  ).toEqual([]);
  expect(seen.size).toBe(ids.length);
}

function expectClearsLegacySpace(ids: string[], prefix: keyof typeof FLOOR): void {
  for (const id of ids) {
    expect(
      suffix(id, prefix),
      `${id} landed in the space the random minter already used, so it could ` +
        `collide with a row that predates the migration`,
    ).toBeGreaterThanOrEqual(FLOOR[prefix]);
  }
}

function expectStrictlyIncreasing(ids: string[], prefix: keyof typeof FLOOR): void {
  const ns = ids.map((id) => suffix(id, prefix));
  const breaks = ns
    .map((n, i) => ({ n, prev: ns[i - 1], i }))
    .filter(({ n, prev }) => prev !== undefined && n <= prev);
  expect(
    breaks,
    `${breaks.length} of ${ns.length} ${prefix} draws did not increase — e.g. ` +
      `${breaks.slice(0, 3).map((b) => `#${b.i}: ${b.prev} then ${b.n}`).join(', ')}. ` +
      `A sequence cannot do that; a random minter almost always does.`,
  ).toEqual([]);
}

suite('every minted id comes from a sequence, not a dice roll', () => {
  let db: typeof import('../db/client')['db'];
  let campaign: typeof import('../db/schema/campaign')['campaign'];
  let supportTicket: typeof import('../db/schema/legal')['supportTicket'];
  let supportTopic: typeof import('../db/schema/legal')['supportTopic'];
  let merchantNotification: typeof import('../db/schema/notification')['merchantNotification'];
  let ids: typeof import('../services/ids');

  beforeAll(async () => {
    db = (await import('../db/client')).db;
    campaign = (await import('../db/schema/campaign')).campaign;
    ({ supportTicket, supportTopic } = await import('../db/schema/legal'));
    ({ merchantNotification } = await import('../db/schema/notification'));
    // THE MODULE THE PRODUCTION PATHS USE, imported rather than retyped. A copy of
    // the SQL here would pass while every route kept minting at random, which is
    // the one outcome this file must not be able to have.
    ids = await import('../services/ids');
  });

  /**
   * Rolled back. `tx.rollback()` throws to unwind, so the catch distinguishes that
   * from a real failure — anything else, 23505 above all, is the bug.
   */
  async function inRollback(fn: (tx: typeof db) => Promise<void>): Promise<void> {
    try {
      await db.transaction(async (tx) => {
        await fn(tx as unknown as typeof db);
        tx.rollback();
      });
    } catch (error) {
      if (!(error as Error)?.constructor?.name?.includes('TransactionRollback')) throw error;
    }
  }

  async function seededTopic(): Promise<{ id: string; route: 'salon' | 'avo' }> {
    const [topic] = await db
      .select({ id: supportTopic.id, route: supportTopic.route })
      .from(supportTopic)
      .limit(1);
    expect(topic, 'no seeded support topic — run ./scripts/lane-db.sh a').toBeTruthy();
    return topic as { id: string; route: 'salon' | 'avo' };
  }

  // ===================================================== the bulk-insert half ==

  it(`mints ${MINTS} campaign ids against campaign_pkey with no duplicate`, async () => {
    let minted: string[] = [];
    await inRollback(async (tx) => {
      const rows = await tx
        .insert(campaign)
        .values(
          Array.from({ length: MINTS }, (_, i) => ({
            id: ids.campaignId,
            salonId: SALON,
            title: `Minted id probe ${i}`,
            body: 'Rolled back. Nothing here survives the transaction.',
            channel: 'push',
            audience: 'all' as never,
            reward: 'none',
            reach: 0,
            sendWhen: 'now',
            // Non-negotiable #8 holds in the fixture too: nothing this file writes
            // is anything but `pending`, and all of it is rolled back regardless.
            status: 'pending' as const,
            submittedBy: 'mintedIds.int.test',
            submittedAt: new Date(),
          })),
        )
        .returning({ id: campaign.id });
      minted = rows.map((r) => r.id);
    });

    expect(minted).toHaveLength(MINTS);
    expectAllDistinct(minted, 'campaign');
    expectClearsLegacySpace(minted, 'CMP-');
  });

  it(`mints ${MINTS} support ticket ids against support_ticket_pkey with no duplicate`, async () => {
    const topic = await seededTopic();
    let minted: string[] = [];
    await inRollback(async (tx) => {
      const rows = await tx
        .insert(supportTicket)
        .values(
          Array.from({ length: MINTS }, (_, i) => ({
            id: ids.ticketId,
            memberId: MEMBER,
            salonId: SALON,
            topicId: topic.id,
            // Non-negotiable #11: the route resolves this from the TOPIC, never
            // from the client. This fixture is not the handler, so rather than
            // assert that it takes the topic's route and then supply its own, it
            // reads it — a fixture that hardcoded 'avo' would still be green on the
            // day somebody made the handler hardcode it too.
            route: topic.route,
            message: `Minted id probe ${i}. Rolled back.`,
            via: 'email' as const,
          })),
        )
        .returning({ id: supportTicket.id });
      minted = rows.map((r) => r.id);
    });

    expect(minted).toHaveLength(MINTS);
    expectAllDistinct(minted, 'support ticket');
    expectClearsLegacySpace(minted, 'SUP-');
  });

  it(`mints ${MINTS} notification ids against merchant_notification_pkey with no duplicate`, async () => {
    let minted: string[] = [];
    await inRollback(async (tx) => {
      const rows = await tx
        .insert(merchantNotification)
        .values(
          Array.from({ length: MINTS }, (_, i) => ({
            id: ids.notificationId,
            salonId: SALON,
            kind: 'calendar_disconnected' as never,
            title: 'Minted id probe',
            body: 'Rolled back. Nothing here survives the transaction.',
            subjectType: 'mintedIds.int.test',
            // VARIED ON PURPOSE. `merchant_notification` carries a partial unique
            // index over (salon, kind, subject) WHERE open — the dedup that stops
            // one disconnected calendar minting a row per read. A thousand rows
            // sharing a subject would violate THAT index, and this spec would go
            // red for a reason that has nothing to do with the id.
            subjectId: `probe-${i}`,
          })),
        )
        .returning({ id: merchantNotification.id });
      minted = rows.map((r) => r.id);
    });

    expect(minted).toHaveLength(MINTS);
    expectAllDistinct(minted, 'notification');
    expectClearsLegacySpace(minted, 'NT-');
  });

  // ===================================================== the monotonic half ==

  it(`draws ${DRAWS} transaction ids that strictly increase — the money path`, async () => {
    let drawn: string[] = [];
    await inRollback(async (tx) => {
      for (let i = 0; i < DRAWS; i += 1) drawn.push(await ids.nextTransactionId(tx));
    });

    expect(drawn).toHaveLength(DRAWS);
    expectAllDistinct(drawn, 'transaction');
    expectStrictlyIncreasing(drawn, 'TX-');
    expectClearsLegacySpace(drawn, 'TX-');
  });

  it(`draws ${DRAWS} booking ids that strictly increase`, async () => {
    let drawn: string[] = [];
    await inRollback(async (tx) => {
      for (let i = 0; i < DRAWS; i += 1) drawn.push(await ids.nextBookingId(tx));
    });

    expect(drawn).toHaveLength(DRAWS);
    expectAllDistinct(drawn, 'booking');
    expectStrictlyIncreasing(drawn, 'BK-');
    expectClearsLegacySpace(drawn, 'BK-');
  });

  it(`draws ${DRAWS} top-up intent ids that strictly increase — a payment record`, async () => {
    const drawn: string[] = [];
    await inRollback(async (tx) => {
      for (let i = 0; i < DRAWS; i += 1) drawn.push(await ids.nextTopUpIntentId(tx));
    });

    expect(drawn).toHaveLength(DRAWS);
    expectAllDistinct(drawn, 'top-up intent');
    expectStrictlyIncreasing(drawn, 'TI-');
    expectClearsLegacySpace(drawn, 'TI-');
  });

  /**
   * A DRAW IS NOT ROLLED BACK, and that is the trade 0025 named rather than a leak.
   * Asserted because it is the property that makes every other spec here sound: if
   * a rollback DID return the numbers, two concurrent transactions could be handed
   * the same id and every uniqueness claim above would hold only for serial runs.
   */
  it('keeps a drawn id even when the transaction that drew it rolls back', async () => {
    let inside = '';
    await inRollback(async (tx) => {
      inside = await ids.nextTransactionId(tx);
    });
    const after = await ids.nextTransactionId(db);

    expect(suffix(after, 'TX-')).toBeGreaterThan(suffix(inside, 'TX-'));
  });

  /**
   * THE FIVE SEQUENCES ARE SEPARATE OBJECTS. Sharing one would still be unique, so
   * no spec above would notice — and ids would skip in blocks whenever another
   * prefix was busy. A merchant reading "CMP-10000" and then "CMP-14820" back to
   * support has been handed a live count of somebody else's transactions, which
   * turns the enumerability `services/ids.ts` accepts within a tenant into a
   * disclosure across tenants.
   */
  it('draws each prefix from its own sequence', async () => {
    const topic = await seededTopic();
    let before = 0;
    let after = 0;

    await inRollback(async (tx) => {
      const [a] = await tx.select({ minted: ids.campaignId }).from(supportTopic).limit(1);

      // A hundred of every other prefix in between. Under one shared sequence the
      // next campaign id would be hundreds further on, not one.
      for (let i = 0; i < 100; i += 1) {
        await ids.nextTransactionId(tx);
        await ids.nextBookingId(tx);
      }
      await tx.insert(supportTicket).values(
        Array.from({ length: 100 }, (_, i) => ({
          id: ids.ticketId,
          memberId: MEMBER,
          salonId: SALON,
          topicId: topic.id,
          route: topic.route,
          message: `Sequence separation probe ${i}. Rolled back.`,
          via: 'email' as const,
        })),
      );

      const [b] = await tx.select({ minted: ids.campaignId }).from(supportTopic).limit(1);
      before = suffix(String(a!.minted), 'CMP-');
      after = suffix(String(b!.minted), 'CMP-');
    });

    expect(
      after - before,
      `three hundred draws on other prefixes moved the campaign sequence by ` +
        `${after - before}. The prefixes are sharing a sequence.`,
    ).toBe(1);
  });
});
