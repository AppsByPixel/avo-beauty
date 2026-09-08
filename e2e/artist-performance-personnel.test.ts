/**
 * `artist-performance` — THE FIRST REPORT WHOSE ROWS NAME INDIVIDUAL PEOPLE AND
 * WHAT THEY EARNED, and the two things that follow from that.
 *
 * HOW TO RUN
 *
 *   pnpm install
 *   cd e2e && ../node_modules/.bin/vitest run artist-performance-personnel.test.ts
 *
 * WHAT IS ALREADY COVERED ELSEWHERE, so that this file does not re-assert it:
 *
 *   permission-census.test.ts   the three gates. `GET …/artist-performance`,
 *                               `GET …/artist-performance.csv` and
 *                               `POST …/artist-performance/download-url` are each
 *                               driven with `team` OFF (403 + the `team` copy) and
 *                               again with it granted. Those probes are GENERATED
 *                               from `REPORT_PERMISSION`, so they arrived with the
 *                               kind and nothing here needs to duplicate them.
 *   report-download-capability  the capability semantics — 60s life, single use,
 *                               burnt on any touch, authority re-read at
 *                               redemption — driven on `sales`.
 *   reportsArtist.int.test.ts   lane A's own aggregate: the columns, the deposit
 *                               arithmetic, the unattributed buckets.
 *
 * WHAT IS NOT, AND IS THE SUBJECT OF THIS FILE.
 *
 * ============================================================================
 * 1. THE STAFF JOIN IS DEFENSIVE, NOT CONSTRAINED
 * ============================================================================
 * `services/reports.ts` joins `artist` to `staff_user` to print a `Staff account`
 * column, and it scopes that join to the salon:
 *
 *     LEFT JOIN staff_user su ON su.id = ar.staff_user_id
 *                            AND su.salon_id = <this salon>
 *
 * Lane A reports, and `db/schema/artist.ts` confirms, that `artist.staff_user_id`
 * is a PLAIN FK to `staff_user` with NO same-salon constraint behind it. So that
 * second equality is the only thing standing between a mislinked row and another
 * salon's staff handle printed into this salon's export. Lane A said so in the
 * comment and called it "reported rather than left as a property of a missing
 * constraint" — which is exactly right, and is also a sentence, not a test. A
 * comment cannot go red when somebody simplifies the join.
 *
 * So the link is CONSTRUCTED here and the export is read back. Constructed in SQL
 * and not through the product, because — checked, and it is the finding that
 * bounds this whole risk — NO ROUTE IN THIS API WRITES `artist.staff_user_id`,
 * and no route creates an artist at all: `grep` finds exactly one
 * `insert(artist)` in the repository and it is in `db/seed.ts`. The cross-tenant
 * link is therefore NOT reachable by any merchant today. It is reachable by a data
 * migration, a support script, a fixture, or the first `POST /salons/:id/artists`
 * anybody writes — and on that day this test is what tells them the join is
 * load-bearing.
 *
 * ============================================================================
 * 2. THE DOWNLOAD LINK CARRIES PERSONNEL DATA OUT OF THE PRODUCT AS A FILE
 * ============================================================================
 * `GET /report-downloads/:token` is the only endpoint in this API that answers
 * with no session at all. For `artist-performance` the bytes it hands back are
 * named people and their takings.
 *
 * The question worth asking of it is not "is it single-use" — that is pinned on
 * `sales` — but IS THE LINK SCOPED TO THE SALON THAT MINTED IT. A link that
 * worked cross-tenant would be a leak with a URL, and it would be a durable one:
 * a URL can be pasted into a ticket, a chat or a browser on another salon's
 * counter.
 *
 * The answer, and the reason it is the right shape rather than a check that
 * happens to pass: THE TOKEN PATH CARRIES NO TENANT INPUT AT ALL. `kind`,
 * `salonId`, `branchId` and `period` are read off the stored `report_download`
 * row, so there is no parameter for a caller to substitute — the class of bug is
 * absent rather than guarded against. That is asserted below in the two ways it
 * can be: structurally (the minted URL is the token and nothing else) and
 * behaviourally (the bytes are this salon's, and contain no artist and no handle
 * from the other one).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { precondition } from './support/known-bug.js';
import {
  A_STAFF_FULL,
  B_STAFF,
  B_STAFF_HANDLE,
  SALON_A,
  SALON_B,
  psql,
  scalar,
  signInDashboard,
  startTenancyApi,
  stopTenancyApi,
  tenancyBaseUrl,
  treq,
} from './support/tenancy-harness.js';

/** Layla, salon B's manager, holding all nine permissions — `team` among them. */
let dashboard = '';

const KIND = 'artist-performance';

/**
 * The fixtures, all prefixed so `afterAll` can remove exactly what this file made
 * and a failed run cannot poison the next one.
 *
 * `AR-QA-AP-CROSS` is salon B's artist wired to salon A's ST-001 Noura — the
 * mislinked row the join has to survive. `AR-QA-AP-OWN` is salon B's own artist
 * with no staff account, present so the report has a row that is legitimately
 * `no staff account` and the assertion below cannot pass merely because every row
 * says that. `AR-QA-AP-FOREIGN` belongs to SALON A and must not appear in salon
 * B's export at all — that is the `WHERE ar.salon_id` half of the same query.
 */
const ARTIST_CROSS = 'AR-QA-AP-CROSS';
const ARTIST_OWN = 'AR-QA-AP-OWN';
const ARTIST_FOREIGN = 'AR-QA-AP-FOREIGN';

/** Distinctive enough that a substring search over a CSV means something. */
const NAME_CROSS = 'Qa Crosslinked Artist';
const NAME_OWN = 'Qa Salonb Artist';
const NAME_FOREIGN = 'Qa Salona Artist';

/** ST-001's handle in the seed. The string that must never reach salon B. */
const FOREIGN_HANDLE = 'noura';

interface ReportRow {
  attributedTo: string;
  attribution: string;
  staffAccount: string;
  chargedFils: number;
  depositAppliedFils: number;
  earnedFils: number;
}
interface ReportBody {
  kind: string;
  rows: ReportRow[];
}

function removeFixtures(): void {
  psql(
    `DELETE FROM artist WHERE id IN ('${ARTIST_CROSS}', '${ARTIST_OWN}', '${ARTIST_FOREIGN}');`,
  );
}

async function fetchJson(): Promise<ReportBody> {
  const res = await treq<ReportBody>('GET', `/salons/${SALON_B}/reports/${KIND}`, {
    token: dashboard,
  });
  if (res.status !== 200) {
    throw new Error(`the report answered ${res.status}: ${res.raw}`);
  }
  return res.body;
}

async function fetchCsv(): Promise<string> {
  const res = await treq<string>('GET', `/salons/${SALON_B}/reports/${KIND}.csv`, {
    token: dashboard,
  });
  if (res.status !== 200) {
    throw new Error(`the CSV answered ${res.status}: ${res.raw}`);
  }
  return res.raw;
}

/** Mint the one-time link, and return the opaque token out of the relative URL. */
async function mint(salonId: string): Promise<{ token: string; url: string }> {
  const res = await treq<{ url: string; expiresAt: string }>(
    'POST',
    `/salons/${salonId}/reports/${KIND}/download-url`,
    { token: dashboard },
  );
  if (res.status !== 200) {
    throw new Error(`minting answered ${res.status}: ${res.raw}`);
  }
  return { token: res.body.url.replace('/report-downloads/', ''), url: res.body.url };
}

/** Redeem with NO Authorization header — the whole point of the route. */
async function redeem(token: string): Promise<{ status: number; text: string }> {
  const res = await fetch(`${tenancyBaseUrl()}/report-downloads/${token}`, {
    signal: AbortSignal.timeout(12_000),
  });
  return { status: res.status, text: await res.text() };
}

beforeAll(async () => {
  await startTenancyApi();
  dashboard = await signInDashboard(SALON_B, B_STAFF_HANDLE);

  precondition(
    scalar(`select perm_team from staff_user where id='${B_STAFF}'`).trim() === 't',
    `Layla does not hold perm_team, so nothing in this file could read ${KIND}`,
  );
  precondition(
    scalar(`select salon_id from staff_user where id='${A_STAFF_FULL}'`).trim() === SALON_A,
    `${A_STAFF_FULL} is not in ${SALON_A}, so linking to it would not be a CROSS-tenant link`,
  );
  precondition(
    scalar(`select handle from staff_user where id='${A_STAFF_FULL}'`).trim() === FOREIGN_HANDLE,
    "ST-001's handle is not `noura`, so the leak assertions below search for the wrong string",
  );

  removeFixtures();

  /**
   * `artist_staff_user_uq` is UNIQUE on `staff_user_id` where not null, so the
   * mislink can only be built if nothing already claims ST-001. AR-003 claims
   * ST-002, not ST-001 — asserted rather than assumed, because a seed change that
   * linked ST-001 would make the INSERT below fail with a constraint error and the
   * failure would read as a bug in this file.
   */
  precondition(
    scalar(`select count(*) from artist where staff_user_id='${A_STAFF_FULL}'`).trim() === '0',
    `an artist already links ${A_STAFF_FULL}, so the unique index blocks this fixture`,
  );

  psql(`
    INSERT INTO artist (id, salon_id, staff_user_id, name, slot_minutes, active)
    VALUES ('${ARTIST_CROSS}', '${SALON_B}', '${A_STAFF_FULL}', '${NAME_CROSS}', 30, true),
           ('${ARTIST_OWN}',   '${SALON_B}', NULL,              '${NAME_OWN}',   30, true),
           ('${ARTIST_FOREIGN}', '${SALON_A}', NULL,            '${NAME_FOREIGN}', 30, true);
  `);

  precondition(
    scalar(
      `select staff_user_id from artist where id='${ARTIST_CROSS}'`,
    ).trim() === A_STAFF_FULL,
    'the cross-tenant link was not actually written, so the assertions below would ' +
      'pass against a row that has no link at all — the exact false green this file exists to avoid',
  );
}, 120_000);

afterAll(async () => {
  removeFixtures();
  await stopTenancyApi();
});

// ---------------------------------------------------------------------------
describe('1. a cross-tenant staff link does not leak a handle into the export', () => {
  it('the mislinked row renders `no staff account`, not the other salon\'s handle', async () => {
    const body = await fetchJson();

    const cross = body.rows.find((r) => r.attributedTo === NAME_CROSS);
    expect(
      cross,
      `salon B's own artist ${ARTIST_CROSS} is missing from its own report entirely, so ` +
        'nothing below is being tested. `FROM artist LEFT JOIN` is supposed to give every ' +
        'artist of the salon a row.',
    ).toBeDefined();

    expect(
      cross!.staffAccount,
      'THE LEAK. `artist.staff_user_id` points at ST-001 Noura, who belongs to ' +
        `${SALON_A}. The staff join must be scoped to the reading salon, so this cell is ` +
        'the words `no staff account`. If it reads `noura`, the `AND su.salon_id = …` term ' +
        'has gone from the join in services/reports.ts and one salon is printing another ' +
        "salon's staff handle into a personnel export.",
    ).toBe('no staff account');
  });

  it('and the foreign handle appears nowhere in the JSON body at all', async () => {
    const body = await fetchJson();
    /**
     * Broader than the cell above on purpose. The handle could also arrive through
     * a column this spec does not know the name of, or through a future
     * `Staff name` column, and a substring search over the whole serialised body
     * cannot be fooled by the shape changing.
     */
    expect(
      JSON.stringify(body).toLowerCase().includes(FOREIGN_HANDLE),
      `the string "${FOREIGN_HANDLE}" — a ${SALON_A} staff handle — is somewhere in ` +
        `${SALON_B}'s ${KIND} response`,
    ).toBe(false);
  });

  it('the CSV path leaks it no more than the JSON does — same query, two renderers', async () => {
    const csv = await fetchCsv();
    expect(csv).toContain(NAME_CROSS);
    expect(
      csv.toLowerCase().includes(FOREIGN_HANDLE),
      'the JSON is clean and the CSV is not, which would mean the two paths do not share ' +
        'one query after all',
    ).toBe(false);
    expect(
      csv,
      'the mislinked row must carry the words in the CSV too, not an empty cell — blank ' +
        'reads as "unknown" and this is a definite fact about her',
    ).toContain('no staff account');
  });

  it('the assertion is not vacuous — an unlinked artist and a linked one differ', async () => {
    /**
     * WITHOUT THIS SPEC THE THREE ABOVE ARE WORTHLESS. Salon B has no seeded
     * artists, so `staffAccount` is `no staff account` for every row of this report
     * whether the join is scoped or not, and a suite that only checked the
     * mislinked row would stay green with the guard deleted. So: link salon B's
     * OTHER artist to salon B's OWN staff and require the handle to appear. The
     * column can print a handle; it declines to print THAT one.
     */
    psql(`UPDATE artist SET staff_user_id = '${B_STAFF}' WHERE id = '${ARTIST_OWN}';`);
    try {
      const body = await fetchJson();
      const own = body.rows.find((r) => r.attributedTo === NAME_OWN);
      expect(own, `${ARTIST_OWN} is missing from the report`).toBeDefined();
      expect(
        own!.staffAccount,
        'a SAME-salon link does not print its handle either, so the `no staff account` ' +
          'assertions above prove nothing about tenancy — the column may simply be broken',
      ).toBe(B_STAFF_HANDLE);

      // And the mislinked row is still refused in the very same response.
      const cross = body.rows.find((r) => r.attributedTo === NAME_CROSS);
      expect(
        cross!.staffAccount,
        'one response, two links: the same-salon one resolved and the cross-tenant one ' +
          'must not have',
      ).toBe('no staff account');
    } finally {
      psql(`UPDATE artist SET staff_user_id = NULL WHERE id = '${ARTIST_OWN}';`);
    }
  });

  it('an artist of another salon is not in this salon\'s report at all', async () => {
    const body = await fetchJson();
    expect(
      body.rows.map((r) => r.attributedTo),
      `${ARTIST_FOREIGN} belongs to ${SALON_A}. The \`WHERE ar.salon_id\` half of the ` +
        `same query is what keeps her out of ${SALON_B}'s rows.`,
    ).not.toContain(NAME_FOREIGN);
  });
});

// ---------------------------------------------------------------------------
describe('2. the one-time link is scoped to the salon that minted it', () => {
  it('the minted URL carries the token and NOTHING else — no salon, no kind, no period', async () => {
    const { url, token } = await mint(SALON_B);
    /**
     * THE STRUCTURAL HALF, and the reason the behavioural half below can be brief.
     * There is no tenant parameter on the redemption path for a caller to
     * substitute, so cross-tenant redirection is not a check that passes — it is a
     * class of bug with no input to exploit. If a `salonId` or a `kind` ever
     * appears in this URL, the redemption gains a parameter that can disagree with
     * the stored row and this spec is the place that says so.
     */
    expect(url).toBe(`/report-downloads/${token}`);
    expect(token).toMatch(/^tok_[A-Za-z0-9_-]+$/);
    expect(url.toLowerCase()).not.toContain(SALON_B.toLowerCase());
    expect(url).not.toContain(KIND);
    expect(url).not.toContain('period');
    expect(url).not.toContain('?');
  });

  it('the row behind the token records the salon, so the bytes cannot be redirected', async () => {
    const { token } = await mint(SALON_B);
    /**
     * `hashWalletToken` is sha256 of the raw token — the row is addressed by its
     * own digest rather than by "the newest row", so two specs minting in the same
     * clock tick cannot target each other's fixture.
     */
    const digest = scalar(`select encode(sha256('${token}'::bytea), 'hex')`).trim();
    expect(
      scalar(`select salon_id from report_download where token_hash='${digest}'`).trim(),
      'the mint stored a different salon than the one that minted, which would make the ' +
        'redemption serve somebody else',
    ).toBe(SALON_B);
    expect(
      scalar(`select staff_id from report_download where token_hash='${digest}'`).trim(),
      'the mint did not record WHO minted it, and the redemption re-reads authority off ' +
        'that row',
    ).toBe(B_STAFF);
  });

  it('the redeemed bytes are this salon\'s people, and carry nothing from the other salon', async () => {
    const { token } = await mint(SALON_B);
    const out = await redeem(token);
    expect(out.status, out.text.slice(0, 300)).toBe(200);

    // Salon B's own artists are in the file — so the file is real.
    expect(out.text).toContain(NAME_CROSS);
    expect(out.text).toContain(NAME_OWN);

    // And nothing of salon A's is: not its artist, not its staff handle.
    expect(
      out.text.includes(NAME_FOREIGN),
      `an unauthenticated URL minted by ${SALON_B} handed back a ${SALON_A} artist`,
    ).toBe(false);
    expect(
      out.text.toLowerCase().includes(FOREIGN_HANDLE),
      `an unauthenticated URL minted by ${SALON_B} handed back a ${SALON_A} staff handle`,
    ).toBe(false);
  });

  it('SINGLE USE holds for this kind too — the second redemption is refused', async () => {
    /**
     * `report-download-capability.test.ts` pins single use on `sales`, and the
     * mechanism is kind-independent by construction (one conditional-spend UPDATE
     * on `report_download`). It is re-driven here for the one kind whose bytes are
     * personnel data, because "covered for another kind" and "covered" are the
     * same sentence right up until somebody adds a per-kind branch.
     */
    const { token } = await mint(SALON_B);
    const first = await redeem(token);
    expect(first.status).toBe(200);

    const second = await redeem(token);
    expect(
      second.status,
      'a replayed link served the personnel export a second time. The spend is a ' +
        'conditional UPDATE on `used_at IS NULL`; if this is 200, it is no longer conditional.',
    ).toBe(401);
    expect(second.text).toContain('invalid_download');
  });

  it('two simultaneous redemptions of one token: exactly one wins', async () => {
    /**
     * The double-scan case, on this door. Lane D's own remit — sequential replay
     * and concurrent replay are different bugs, and the conditional UPDATE is
     * precisely the thing that makes the second safe. A read-then-write would pass
     * the spec above and fail this one.
     */
    const { token } = await mint(SALON_B);
    const [a, b] = await Promise.all([redeem(token), redeem(token)]);
    const statuses = [a.status, b.status].sort();
    expect(
      statuses,
      'two concurrent redemptions of one single-use link did not resolve to exactly one ' +
        `success and one refusal (got ${statuses.join(' and ')}). Two 200s means the spend ` +
        'is a read-then-write and the capability is not single-use under load.',
    ).toEqual([200, 401]);
  });
});
