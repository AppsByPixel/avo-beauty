/**
 * `GET /v1/platform/salons` — THE COUNTS, WHICH NOTHING HAS ASSERTED.
 *
 * HOW TO RUN
 *
 *   pnpm install
 *   pnpm --dir ./api run db:up
 *   cd e2e && ../node_modules/.bin/vitest run platform-salons.test.ts
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The endpoint's gate is already driven — `permission-census.test.ts` discovers
 * `requirePlatform(analytics)` from source and probes it with the section off. What
 * has never been driven is the PAYLOAD, and `contract.test.ts` says so in the
 * annotation that exempts the route from the schema census:
 *
 *   "the rows are an aggregate built in raw SQL, cursor-paginated by salon id. Its
 *    gate is driven in permission-census.test.ts; the counts THEMSELVES ARE
 *    UNASSERTED and named in the lane report as owed."
 *
 * This file is that debt. It is worth paying now rather than later because Lane C is
 * building the Salons section against these numbers this week, and because one of
 * them is a deliberate, counter-intuitive decision that nothing currently protects.
 *
 * THE CLAIM WORTH A SPEC
 * ----------------------
 * `platformConsole.ts` states it as a decision, not an implementation detail:
 *
 *   "MEMBER COUNT COUNTS TOMBSTONES, deliberately: an erased member's row still
 *    exists so the books resolve, and 'members' here is 'wallets on the books', the
 *    same number her transactions still roll up into. Excluding erased rows would
 *    make this list disagree with the ledger by exactly the number of erasures — a
 *    drift with a clock attached."
 *
 * That is exactly the kind of decision that gets "fixed" by a well-meaning reader.
 * `count(*) FROM member WHERE salon_id = …` has no `erased_at IS NULL` on it, and to
 * a developer tidying up an erasure ticket that reads like an oversight — the same
 * shape as every other member query in the codebase, which does filter. Adding the
 * filter would silently make the console disagree with the ledger, and nothing
 * would have gone red. So the comment needs an executable twin.
 *
 * AND THE ASYMMETRY BESIDE IT, which is the reason this is subtle rather than
 * obvious: `branchCount` in the very same SELECT *does* filter, on
 * `b.closed_at IS NULL`. So one subquery excludes retired rows and the one directly
 * above it includes them, four lines apart, and both are correct — a closed branch
 * is not a branch you can book at, while an erased member is still a wallet the
 * books roll up. Asserting only one of the two would leave the pair looking like an
 * inconsistency for someone to harmonise. Both are pinned below, together, so the
 * next reader finds the asymmetry defended rather than accidental.
 *
 * HOW THE DIVERGENCE IS MANUFACTURED RATHER THAN ASSUMED
 * -----------------------------------------------------
 * The trap in a spec like this is that "counts tombstones" and "does not count
 * tombstones" produce THE SAME NUMBER unless a tombstone actually exists. Pointed
 * at the stock seed — which erases nobody — an assertion either way passes, and the
 * spec would be another green claim about a behaviour it never exercised.
 *
 * So this file makes the two numbers diverge itself: it inserts two members into
 * salon B, erases exactly one of them mid-spec, and requires the served count to be
 * the one that DID NOT drop. The inclusive and exclusive counts are both read
 * straight from SQL and asserted to differ before the endpoint's answer is compared
 * to either, so the comparison can never be satisfied by them being equal.
 *
 * SALON B, AND TWO MEMBERS OF THIS FILE'S OWN. Nothing here touches a fixture
 * another suite asserts on, and the rows are cleaned up in `afterAll`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { precondition } from './support/known-bug.js';
import {
  B_MEMBER,
  PLATFORM_OWNER_HANDLE,
  SALON_A,
  SALON_B,
  psql,
  scalar,
  signInPlatform,
  startTenancyApi,
  stopTenancyApi,
  treq,
} from './support/tenancy-harness.js';

/** Yousef, the platform owner. Holds every console section, so `analytics` is never what refuses. */
let owner = '';

/** Two members this file owns outright. `TOMB` is erased partway through. */
const QA_LIVE = 'QA-PSL-0001';
const QA_TOMB = 'QA-PSL-0002';

interface SalonRow {
  id: string;
  name: string;
  nameAr: string | null;
  plan: string;
  loyaltyMode: string;
  branchCount: number;
  memberCount: number;
  createdAt: string;
}

const listSalons = (query = '') =>
  treq<{ items: SalonRow[]; nextCursor: string | null }>(
    'GET',
    `/v1/platform/salons${query}`,
    { token: owner },
  );

/** Salon B's row, or a failure that names what came back instead. */
async function rowFor(salonId: string): Promise<SalonRow> {
  const res = await listSalons('?limit=100');
  if (res.status !== 200) {
    throw new Error(`GET /v1/platform/salons answered ${res.status}: ${res.raw}`);
  }
  const row = res.body.items.find((s) => s.id === salonId);
  if (!row) {
    throw new Error(
      `${salonId} is not in the list. Got: ${res.body.items.map((s) => s.id).join(', ')}`,
    );
  }
  return row;
}

/** `count(*)` over salon B's members, with and without the tombstones. */
const inclusiveCount = (salonId: string): number =>
  Number(scalar(`select count(*) from member where salon_id='${salonId}'`).trim());
const exclusiveCount = (salonId: string): number =>
  Number(
    scalar(`select count(*) from member where salon_id='${salonId}' and erased_at is null`).trim(),
  );

beforeAll(async () => {
  await startTenancyApi();
  owner = await signInPlatform(PLATFORM_OWNER_HANDLE);

  /*
   * Two members cloned off the seeded one, so every NOT NULL column and the
   * password hash come from a row the schema already accepted. Both start LIVE —
   * the erasure happens inside the spec that depends on it, because a fixture that
   * arrived pre-erased would let the spec pass without the transition ever
   * happening.
   */
  psql(`
    INSERT INTO member (id, salon_id, name, phone, email, email_verified, password_hash,
                        balance_fils, visits, tier, stamps, policy_version, notify_wa)
    SELECT '${QA_LIVE}', salon_id, 'Platform List QA (live)', '+96555880101', NULL, false,
           password_hash, 0, 0, tier, stamps, policy_version, false
      FROM member WHERE id = '${B_MEMBER}'
    ON CONFLICT (id) DO UPDATE SET erased_at = NULL,
                                   deletion_requested_at = NULL,
                                   deletion_due_at = NULL;
    INSERT INTO member (id, salon_id, name, phone, email, email_verified, password_hash,
                        balance_fils, visits, tier, stamps, policy_version, notify_wa)
    SELECT '${QA_TOMB}', salon_id, 'Platform List QA (tombstone)', '+96555880102', NULL, false,
           password_hash, 0, 0, tier, stamps, policy_version, false
      FROM member WHERE id = '${B_MEMBER}'
    ON CONFLICT (id) DO UPDATE SET erased_at = NULL,
                                   deletion_requested_at = NULL,
                                   deletion_due_at = NULL;
  `);

  precondition(
    scalar(`select count(*) from member where id='${QA_LIVE}'`).trim() === '1' &&
      scalar(`select count(*) from member where id='${QA_TOMB}'`).trim() === '1',
    `the clone source ${B_MEMBER} is missing, so this file has no members`,
  );
  precondition(
    exclusiveCount(SALON_B) === inclusiveCount(SALON_B),
    'salon B already has an erased member, so this file cannot attribute the divergence it creates',
  );
}, 120_000);

afterAll(async () => {
  await stopTenancyApi();
  // The run database is dropped by global teardown; these deletes matter only for a
  // run pointed at a shared API, where leaving two members behind would move
  // exactly the counts this file asserts on.
  psql(`DELETE FROM member WHERE id IN ('${QA_LIVE}', '${QA_TOMB}');`);
});

// ---------------------------------------------------------------------------
describe('The row the Salons section renders', () => {
  it('carries every field the list needs, and nothing is a stringified number', async () => {
    const row = await rowFor(SALON_B);

    expect(row.id).toBe(SALON_B);
    expect(typeof row.name, 'the salon has no name to render').toBe('string');
    expect(row.name.length).toBeGreaterThan(0);
    // Nullable, but it must be NULL and not the string "null" — the wallet falls
    // back on the Latin name and `'null' ?? name` would paint the word.
    expect(row.nameAr === null || typeof row.nameAr === 'string').toBe(true);
    expect(row.nameAr).not.toBe('null');
    expect(typeof row.plan).toBe('string');
    expect(typeof row.loyaltyMode).toBe('string');

    /*
     * The counts are built with `count(*)::int` in raw SQL. Without the cast
     * Postgres returns bigint, node-postgres hands back a STRING to avoid losing
     * precision, and the console renders "12" fine while `memberCount > 10`
     * compares a string to a number and silently misbehaves. So the cast is load
     * bearing and this is the assertion that notices if it is ever dropped.
     */
    expect(typeof row.branchCount, 'branchCount is not a number — the ::int cast is gone').toBe(
      'number',
    );
    expect(typeof row.memberCount, 'memberCount is not a number — the ::int cast is gone').toBe(
      'number',
    );
    expect(Number.isInteger(row.branchCount)).toBe(true);
    expect(Number.isInteger(row.memberCount)).toBe(true);

    // A parseable timestamp, not a Date that stringified to something local.
    expect(Number.isNaN(Date.parse(row.createdAt)), 'createdAt is not parseable').toBe(false);
    expect(row.createdAt, 'createdAt is not ISO-8601 UTC').toMatch(/Z$/);
  });

  it('lists every salon on the platform, which is what makes it the platform list', async () => {
    const res = await listSalons('?limit=100');
    expect(res.status).toBe(200);
    const ids = res.body.items.map((s) => s.id);
    // A FLOOR, not an equality. Two salons are seeded; a third arriving is a
    // legitimate addition and must not turn this red.
    expect(ids, 'salon A is missing from the platform list').toContain(SALON_A);
    expect(ids, 'salon B is missing from the platform list').toContain(SALON_B);
    expect(new Set(ids).size, 'the list repeats a salon').toBe(ids.length);
  });
});

// ---------------------------------------------------------------------------
describe('memberCount counts tombstones — the decision, not the implementation', () => {
  it('an erasure does not decrement the count, and the served number is the inclusive one', async () => {
    // ---- before: the two SQL numbers agree, so neither can be mistaken for the other
    const before = await rowFor(SALON_B);
    const inclusiveBefore = inclusiveCount(SALON_B);
    const exclusiveBefore = exclusiveCount(SALON_B);
    precondition(
      inclusiveBefore === exclusiveBefore,
      'salon B already holds a tombstone before this spec erased anything',
    );
    expect(before.memberCount, 'the served count does not match a plain count(*)').toBe(
      inclusiveBefore,
    );

    /*
     * ---- the transition. Erasure is not a column you can just set: three CHECKs
     * bind the trio (`erased_at` requires `deletion_requested_at`, the request and
     * due dates are both-or-neither, and due must be later than requested), so the
     * fixture walks request -> due -> erase in the order the real deletion path
     * walks. Setting `erased_at` alone is refused by
     * `member_erased_only_after_request`, which is the tombstone invariant working.
     */
    psql(`
      UPDATE member
         SET deletion_requested_at = now() - interval '31 days',
             deletion_due_at       = now() - interval '1 day',
             erased_at             = now()
       WHERE id = '${QA_TOMB}';
    `);

    // ---- the divergence is REAL before anything is concluded from it.
    const inclusiveAfter = inclusiveCount(SALON_B);
    const exclusiveAfter = exclusiveCount(SALON_B);
    expect(
      inclusiveAfter,
      'the erasure removed the row entirely — an erasure is a scrub, not a DELETE, and ' +
        'without the row there is no tombstone to count and this spec cannot discriminate',
    ).toBe(inclusiveBefore);
    expect(
      exclusiveAfter,
      'the erasure did not take effect, so the two counts still agree and the assertion ' +
        'below would pass whichever number the endpoint served',
    ).toBe(exclusiveBefore - 1);

    // ---- the assertion. Two candidate numbers, now provably different by one.
    const after = await rowFor(SALON_B);
    expect(
      after.memberCount,
      `memberCount dropped from ${before.memberCount} to ${after.memberCount} when a member ` +
        'was erased. The console now disagrees with the ledger by the number of erasures — ' +
        'see the MEMBER COUNT COUNTS TOMBSTONES note in api/src/routes/platformConsole.ts.',
    ).toBe(inclusiveAfter);
    expect(
      after.memberCount,
      'memberCount is the erased-excluding count — an `erased_at IS NULL` has been added to ' +
        'the subquery, which is the exact change that note exists to prevent',
    ).not.toBe(exclusiveAfter);
    // Said once more as the behaviour rather than as the number: nothing moved.
    expect(after.memberCount, 'the erasure moved the count').toBe(before.memberCount);
  });
});

// ---------------------------------------------------------------------------
describe('branchCount excludes closed branches — the deliberate asymmetry', () => {
  it('a closed branch leaves the count, while an erased member does not', async () => {
    const openBranches = Number(
      scalar(
        `select count(*) from branch where salon_id='${SALON_B}' and closed_at is null`,
      ).trim(),
    );
    const allBranches = Number(
      scalar(`select count(*) from branch where salon_id='${SALON_B}'`).trim(),
    );

    const row = await rowFor(SALON_B);
    expect(row.branchCount, 'branchCount is not the open-branch count').toBe(openBranches);

    /*
     * The discriminating half, and it only discriminates when a closed branch
     * exists. Rather than assert against a fixture that may have none, close one
     * and watch the count fall — which also proves the filter is live rather than
     * incidentally equal.
     */
    if (allBranches === openBranches) {
      const disposable = scalar(
        `select id from branch where salon_id='${SALON_B}' and closed_at is null order by id desc limit 1`,
      ).trim();
      precondition(disposable !== '', 'salon B has no branch to close');
      psql(`UPDATE branch SET closed_at = now() WHERE id = '${disposable}';`);
      try {
        const afterClose = await rowFor(SALON_B);
        expect(
          afterClose.branchCount,
          'closing a branch did not reduce branchCount — the closed_at filter is gone, and a ' +
            'retired branch is now offered as bookable',
        ).toBe(openBranches - 1);
      } finally {
        psql(`UPDATE branch SET closed_at = NULL WHERE id = '${disposable}';`);
      }
    }

    // And the pair, stated together so the asymmetry reads as intended.
    const finalRow = await rowFor(SALON_B);
    expect(finalRow.branchCount).toBe(openBranches);
    expect(finalRow.memberCount).toBe(inclusiveCount(SALON_B));
  });
});

// ---------------------------------------------------------------------------
describe('Cursor pagination — a list endpoint that still works when the table is not small', () => {
  it('limit=1 walks the whole table, seeing every salon exactly once', async () => {
    const all = await listSalons('?limit=100');
    expect(all.status).toBe(200);
    const expected = all.body.items.map((s) => s.id);
    precondition(expected.length >= 2, 'fewer than two salons — pagination cannot be walked');

    const seen: string[] = [];
    let cursor: string | null = null;
    // Bounded, so a server that returns the same cursor for ever fails as an
    // assertion about pagination rather than as a suite timeout.
    for (let page = 0; page < expected.length + 3; page++) {
      const res = await listSalons(`?limit=1${cursor ? `&cursor=${cursor}` : ''}`);
      expect(res.status, `page ${page} answered ${res.status}: ${res.raw}`).toBe(200);
      expect(res.body.items.length, `limit=1 returned ${res.body.items.length} rows`).toBeLessThanOrEqual(1);
      if (res.body.items.length === 0) break;
      seen.push(res.body.items[0]!.id);
      cursor = res.body.nextCursor;
      if (cursor === null) break;
    }

    expect(seen, 'the walk saw a salon twice').toHaveLength(new Set(seen).size);
    expect(seen, 'the walk did not see every salon the unpaginated list holds').toEqual(expected);
  });

  it('the last page reports nextCursor null rather than repeating itself', async () => {
    const res = await listSalons('?limit=100');
    expect(res.status).toBe(200);
    expect(res.body.nextCursor, 'a full page still offers a next cursor').toBeNull();
  });

  it('a limit outside 1..100 is refused with a code, not clamped in silence', async () => {
    for (const bad of ['0', '101', '-1', 'abc', '1.5', '']) {
      const res = await listSalons(`?limit=${bad}`);
      expect(res.status, `limit=${JSON.stringify(bad)} answered ${res.status}: ${res.raw}`).toBe(
        400,
      );
      expect(res.body.error, `limit=${JSON.stringify(bad)} refused without a code`).toBe(
        'invalid_limit',
      );
    }
  });

  it('an unknown cursor is an empty page, not an error and not the first page again', async () => {
    // Keyed by `id > cursor`, so a cursor past the last id yields nothing. The
    // failure mode worth excluding is silently ignoring the cursor and re-serving
    // page one, which paginates for ever.
    const res = await listSalons('?limit=100&cursor=ZZZZ-NO-SUCH-SALON');
    expect(res.status, res.raw).toBe(200);
    expect(res.body.items, 'an out-of-range cursor re-served the first page').toHaveLength(0);
    expect(res.body.nextCursor).toBeNull();
  });
});
