/**
 * `GET /v1/platform/accounts?role=` — THE SECOND PINNED ENUM, FOUND BY LOOKING FOR THE
 * FIRST ONE'S SHAPE RATHER THAN FOR ITS SYMPTOM.
 *
 * HOW TO RUN
 *
 *   pnpm install
 *   pnpm --dir ./api run db:up
 *   cd e2e && ../node_modules/.bin/vitest run platform-accounts-roles.test.ts
 *
 * Like `platform-salons.test.ts`, `campaigns.test.ts` and `console-reset.test.ts`, this
 * boots lane A's real API against lane D's own per-run Postgres —
 * `support/tenancy-harness.ts` carries the mechanics. It cannot run against
 * `packages/mock`: there is no platform principal there and no cross-tenant accounts
 * read to drive.
 *
 * =========================================================================
 * WHY THIS FILE EXISTS
 * =========================================================================
 * `audience: "lapsed"` answered 500 for the entire life of `POST /campaigns` because
 * every spec in `campaigns.test.ts` pinned `audience: 'gold'` at its call site. Five
 * audiences, one exercised. The fix worth having was not a sixth spec about `lapsed`; it
 * was a COVERAGE SHAPE — a loop derived from the constant — and that section says so at
 * length.
 *
 * A shape is only worth having if it is pointed at the other places with the same
 * anatomy, so the inventory that followed asked one question of every validated `as
 * const` in `api/src/routes`: does the suite send more than one of its values? This
 * endpoint's answer was no, and it is the worst of the ones found:
 *
 *   `ROLE_FILTERS = ['all', 'customer', 'staff', 'owner'] as const`  (accounts.ts:118)
 *
 * validated by `parseRole` (accounts.ts:164) — 400 `invalid_role` on anything else, `all`
 * on absent or empty. NOTHING IN THIS PACKAGE HAS EVER SENT `?role=`. The endpoint has
 * exactly one caller in `e2e/`, `support-routing.test.ts:1294`, and it sends
 * `?salon=&limit=100`. So `all` is exercised only as the DEFAULT, and `customer`, `staff`
 * and `owner` are three untested code shapes behind a validated constant. Same anatomy,
 * one door further along.
 *
 * AND THE THREE UNTESTED VALUES ARE NOT COSMETIC VARIANTS OF THE TESTED ONE, which is
 * what makes this worth a file rather than a line. They compile three DIFFERENT queries:
 *
 *   accounts.ts:242-243   `wantCustomers` and `wantStaff` decide whether each of the two
 *                         table queries RUNS AT ALL. `role=customer` never touches
 *                         `staff_user`; `role=staff` and `role=owner` never touch
 *                         `member`. The `role=all` path — the only one driven — is the
 *                         only one where both run.
 *   accounts.ts:326       `role === 'owner' ? eq(staffUser.role, 'owner') : undefined`
 *                         injects an extra WHERE clause that no other value produces,
 *                         binding a `staff_role` ENUM value as a parameter. Binding a
 *                         parameter the driver could not encode against its column is
 *                         precisely how the `lapsed` 500 was thrown.
 *
 * So the untested shapes include one that skips a query, one that skips the other, and
 * one that adds a predicate. `role=all` proves none of them.
 *
 * =========================================================================
 * WHAT THIS FILE CLAIMS, AND WHAT A PINNED-VALUE SUITE COULD NOT
 * =========================================================================
 * Two claims, and the second is the one that matters:
 *
 *   1. THE STATUS CODE. One request per member of `ROLE_FILTERS`, 200 and not 500. That
 *      is the assertion whose absence let the campaigns bug live, and it is cheap.
 *
 *   2. THE FILTER DISCRIMINATES. `role=customer` returns ONLY customers, `role=staff`
 *      and `role=owner` return NO customers, `role=owner` returns only staff whose role
 *      is `owner`. A 200 says the query ran; it says nothing about whether it ran the
 *      RIGHT query, and `wantCustomers`/`wantStaff` are two booleans over one `role`
 *      string — the shape where a mislaid `||` returns a plausible list of the wrong
 *      rows. Nothing 500s, nothing 400s, and the console's Customers chip quietly lists
 *      the salon's staff. That is the failure a status-code-only loop is blind to, so
 *      both halves are here.
 *
 * A UNIVERSAL CLAIM OVER THE WHOLE POPULATION, NOT OVER ONE PAGE. Every discrimination
 * spec below pages to exhaustion through `nextCursor` — see `listEveryAccount()` — for a
 * reason `campaigns.test.ts` records the hard way in § `LOWBAL`: a spec that reads one
 * page of a list other files are appending to is a spec whose result depends on file
 * order. "Every row served satisfies the filter" is a claim about the PREDICATE and is
 * true whatever else has run; "the first fifty rows look right" is a claim about the
 * population, and `MAX_LIMIT` is 100.
 *
 * THE FIXTURES DEFEAT VACUITY, AND THAT IS THEIR ONLY JOB. A universal claim is
 * satisfied for free by an empty list — a `role=owner` that returned nothing would pass
 * "every row is an owner" and prove that the chip is broken. So this file inserts three
 * rows of its own at salon B — a customer, an owner, and a non-owner staff member — and
 * every filter is required to CONTAIN the ones it admits as well as to exclude the ones
 * it does not. Presence and universality together are the discrimination claim; either
 * alone is passable by a broken endpoint.
 *
 * AND THE OWNER ROW HAD TO BE ONE OF THEM, because there is no other. `staffRole`
 * includes `owner`, and the ONLY code that writes one is
 * `services/salonOnboarding.ts:588` — so the stock seed and the tenancy harness between
 * them create zero. `role=owner` against this database without this fixture returns an
 * empty list, and every assertion anyone would think to write about it passes. That is
 * not a hypothetical: it is what the first draft of this file did, green, before the
 * fixture existed.
 *
 * =========================================================================
 * DERIVED FROM THE CONSTANT, AND CROSS-CHECKED AGAINST THE RUNNING SERVER
 * =========================================================================
 * There is no list of four filters typed in this file. `constListFromSource()` reads
 * `ROLE_FILTERS` out of `api/src/routes/accounts.ts` as TEXT — the technique
 * `campaigns.test.ts` § THE AUDIENCE DIMENSION, `support/perm-census.ts` and
 * `apps/dashboard/src/shell/consoleNavGates.test.ts` all use — so a fifth filter is
 * covered on the day it joins the constant rather than on the day somebody remembers
 * this file.
 *
 * READ AS TEXT RATHER THAN IMPORTED, which is this package's standing convention and not
 * an accident of this file: nothing in `e2e/` imports from `api/src` (`console-reset.
 * test.ts` says so in as many words) because the suite drives the API from OUTSIDE it.
 * The loops must also exist at COLLECTION time, before `beforeAll` has provisioned a
 * database, so they cannot come from a query either. `ROLE_FILTERS` is not exported, so
 * an import was never on the table anyway — which is worth saying, because "not
 * exported" is exactly the argument someone will use for hardcoding the list here.
 *
 * COMMENTS ARE NOT STRIPPED BEFORE PARSING, the same departure from `perm-census.ts`
 * that `campaigns.test.ts` makes and for the same two reasons: the declaration is a
 * single line of literals, and a mis-read cannot survive the cross-check below.
 * `ROLE_FILTERS` appears five times in `accounts.ts` — the declaration, the `RoleFilter`
 * type alias, twice inside `parseRole`, and once in prose at :321 — and only the
 * declaration is followed by `= [ … ] as const`, which is the whole of what the reader
 * matches. If the constant is ever reformatted across lines with a comment inside it,
 * strip comments then.
 *
 * A ZERO RESULT IS A CLAIM ABOUT THE PARSER, so `constListFromSource()` THROWS rather
 * than returning `[]`. A parse that silently found nothing would delete every derived
 * spec in this file and report it green with the role dimension untested — which is the
 * exact failure this file exists to end, reintroduced one level down. The known
 * positives are asserted too, in § "the derivation itself".
 *
 * AND THE DEPLOYED ARTIFACT IS CROSS-CHECKED, which is the half a source read cannot do.
 * `parseRole` builds its own refusal message as `role must be one of ` +
 * `ROLE_FILTERS.join(', ')`, so the RUNNING SERVER will recite its list on demand: one
 * spec below sends a role that cannot be valid, reads the four names back out of the
 * 400, and requires them to equal what was read from the file. A reader that matched the
 * wrong declaration, a stale checkout, or an API booted from different source all fail
 * there, by name, before any loop concludes anything.
 *
 * The dashboard's hand-mirrored copy is cross-checked too, for a different hazard —
 * see § "the derivation itself". A chip lane C draws for a role lane A refuses is a 400
 * on the console; a filter lane A accepts and lane C never draws is a code path with no
 * caller. Neither shows up in a lane's own tests, because neither lane holds both lists.
 *
 * =========================================================================
 * A DUPLICATED READER, REPORTED RATHER THAN RESOLVED HERE
 * =========================================================================
 * `constListFromSource()` below is deliberately SELF-CONTAINED, and that is a decision
 * with a shelf life. A second lane D session was factoring the same technique into a
 * shared `e2e/support/` module — a `const … = [ … ] as const` reader, a `pg_enum` label
 * reader, the same `quotedStrings` — at the same time as this file was written, off the
 * same pinned-enum inventory. Neither had landed when the other was committed, so
 * depending on it would have made this file un-runnable on its own branch.
 *
 * So there are now two readers of the same shape in this package, and COLLAPSING THEM IS
 * A TRUNK OPERATION, not something either session should do to the other's uncommitted
 * work. Whoever integrates both should keep one: this file's three source-derived specs
 * would then import it, and nothing about what they assert changes. Recorded here because
 * a duplicate nobody wrote down is a duplicate that stays.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { precondition } from './support/known-bug.js';
import {
  A_STAFF_FULL,
  B_MEMBER,
  PLATFORM_OWNER_HANDLE,
  SALON_B,
  psql,
  repoRoot,
  scalar,
  signInPlatform,
  startTenancyApi,
  stopTenancyApi,
  treq,
} from './support/tenancy-harness.js';

/** Yousef, the platform owner. Holds every console section, so `accounts` never refuses. */
let owner = '';

// ---------------------------------------------------------------------------
// THE CONSTANT, READ OUT OF LANE A'S ROUTE MODULE
// ---------------------------------------------------------------------------

const ROLE_CONSTANT_FILE = join(repoRoot, 'api', 'src', 'routes', 'accounts.ts');

/**
 * Lane C's hand-mirrored copy of the same list. Its own comment says "Mirrored from the
 * server's exported list rather than invented" — and the server's list is not exported,
 * which is exactly why the mirror is worth a spec rather than a nod.
 */
const DASHBOARD_MIRROR_FILE = join(
  repoRoot,
  'apps',
  'dashboard',
  'src',
  'api',
  'platformAccounts.ts',
);

/**
 * Every single-quoted literal in a fragment of text, in order.
 *
 * Used against the two `as const` declarations AND against the running server's 400
 * message, because all three say the same thing in three syntaxes and the literals are
 * the part that matters in each. `campaignAudiencesFromSource()` in `campaigns.test.ts`
 * makes the same choice against a `pg_get_constraintdef()` rendering, for the same
 * reason: matching the syntax would need one reader per syntax and would break the first
 * time one of them was reformatted.
 */
const quotedStrings = (text: string): string[] =>
  [...text.matchAll(/'([^']*)'/g)].flatMap((m) => (m[1] ? [m[1]] : []));

/**
 * Read a `const <name> = [ … ] as const` out of a file as text.
 *
 * THROWS ON EVERY FAILED PARSE — see the file header. The message names the file, the
 * constant and both plausible causes, because the reader of this failure is somebody who
 * just renamed or reformatted a constant and has no reason to expect a QA suite to care
 * about it.
 */
function constListFromSource(file: string, name: string): string[] {
  const src = readFileSync(file, 'utf8');
  const decl = new RegExp(`const ${name}\\s*=\\s*\\[([^\\]]*)\\]\\s*as const`).exec(src);
  if (!decl) {
    throw new Error(
      `${name} could not be found in ${file}.\n` +
        'Every role spec in e2e/platform-accounts-roles.test.ts is derived from that ' +
        'constant, so a failed parse would silently delete them all — hence this throw ' +
        'rather than an empty list.\nIf the constant was renamed, moved, or reformatted ' +
        'across lines, update this reader. Do NOT replace it with a list typed here: a ' +
        'hardcoded list is what let `audience: "lapsed"` answer 500 for the life of ' +
        '`POST /campaigns`, and `?role=` is the same shape one door along.',
    );
  }
  const found = quotedStrings(decl[1] ?? '');
  if (found.length === 0) {
    throw new Error(
      `${name} was found in ${file} but no value was read out of it. ` +
        `The declaration matched as: ${decl[0]}`,
    );
  }
  return found;
}

const ROLE_FILTERS = constListFromSource(ROLE_CONSTANT_FILE, 'ROLE_FILTERS');

// ---------------------------------------------------------------------------
// THIS FILE'S THREE ROWS
// ---------------------------------------------------------------------------

/**
 * A CUSTOMER, AN OWNER AND A NON-OWNER STAFF MEMBER, ALL AT SALON B.
 *
 * Three rows, because the four filters partition them three ways and no two filters
 * below admit the same set. Without the non-owner staff member, `staff` and `owner`
 * would admit identical lists and the extra WHERE clause at accounts.ts:326 could be
 * deleted with every spec still green — which is the `LOWBAL` lesson from
 * `campaigns.test.ts` § THE AUDIENCE DIMENSION applied before the fact rather than
 * after: the fixture has to make the filters DISCRIMINATE, or the suite is asserting
 * that four names produce four copies of one answer.
 *
 * `artist` FOR THE NON-OWNER, chosen off `staffRole` deliberately rather than at random:
 * `manager` and `frontdesk` are what the harness seeds at salon B, so a third spelling
 * proves the `staff` chip admits a role no other row in the database carries — a
 * predicate that had quietly become `role IN ('manager','frontdesk')` would fail here
 * and nowhere else.
 */
const QA_CUSTOMER = 'QA-ACR-0001';
const QA_OWNER = 'ST-QA-ACR-OWN';
const QA_STAFF = 'ST-QA-ACR-ART';

/** Unused elsewhere in this package — `member_salon_phone_uq` is on (salon_id, phone). */
const QA_CUSTOMER_PHONE = '+96555880301';

/**
 * NO `password_hash` ON EITHER STAFF ROW, and it is not laziness.
 *
 * `passwordSet` is nothing this file asserts on, `staff_user.password_hash` is nullable,
 * and NULL is a real product state — `routes/staff.ts` calls it "invite pending". So the
 * cheaper fixture is also the more honest one, and it means this file mints no credential
 * on a handle at a real salon in order to test a read. `staff_user_deactivated_holds_no_
 * credential` is satisfied either way; both rows are active.
 */
function seedRows(): void {
  psql(`
    INSERT INTO member (id, salon_id, name, phone, email, email_verified, password_hash,
                        balance_fils, visits, tier, stamps, policy_version, notify_wa)
    SELECT '${QA_CUSTOMER}', salon_id, 'Role Filter QA (customer)', '${QA_CUSTOMER_PHONE}',
           NULL, false, password_hash, 0, 0, tier, stamps, policy_version, false
      FROM member WHERE id = '${B_MEMBER}'
    ON CONFLICT (id) DO UPDATE SET erased_at = NULL,
                                   deletion_requested_at = NULL,
                                   deletion_due_at = NULL;

    INSERT INTO staff_user (id, salon_id, name, handle, role,
                            branch_access_all, branch_access_ids, password_hash)
    VALUES ('${QA_OWNER}', '${SALON_B}', 'Role Filter QA (owner)', 'qa.acr.owner', 'owner',
            true, '{}', NULL)
    ON CONFLICT (id) DO UPDATE SET role = 'owner', deactivated_at = NULL;

    INSERT INTO staff_user (id, salon_id, name, handle, role,
                            branch_access_all, branch_access_ids, password_hash)
    VALUES ('${QA_STAFF}', '${SALON_B}', 'Role Filter QA (artist)', 'qa.acr.artist', 'artist',
            true, '{}', NULL)
    ON CONFLICT (id) DO UPDATE SET role = 'artist', deactivated_at = NULL;
  `);
}

/**
 * Give the three rows back.
 *
 * DELETABLE BECAUSE NOTHING POINTS AT THEM — neither staff row has taken a charge,
 * consumed a wallet token, been wired to an `artist` or appeared in an `audit_log`
 * subject, and the customer has no ledger. That is a property of fixtures this file
 * only READS through, and it is why `tenancy-harness.ts`'s branch teardown has to
 * close rather than delete while this one can delete.
 *
 * It matters for a run pointed at a SHARED API rather than a per-run database: leaving an
 * owner behind at salon B would change what every other suite's team and accounts reads
 * return. The per-run database makes it a courtesy; the courtesy is cheap.
 */
function dropRows(): void {
  psql(`
    DELETE FROM staff_user WHERE id IN ('${QA_OWNER}', '${QA_STAFF}');
    DELETE FROM member WHERE id = '${QA_CUSTOMER}';
  `);
}

// ---------------------------------------------------------------------------
// THE WIRE
// ---------------------------------------------------------------------------

interface AccountRow {
  id: string;
  kind: 'customer' | 'staff';
  name: string;
  handle: string | null;
  role: string;
  salonId: string;
  salon: string;
  passwordSet: boolean;
  status: string;
  createdAt: string;
}

interface AccountsPage {
  items: AccountRow[];
  nextCursor: string | null;
  error?: string;
  message?: string;
}

/** `MAX_LIMIT` in `accounts.ts`. Mirrored only to ask for the largest legal page. */
const MAX_LIMIT = 100;

/**
 * A guard, not a tuning knob. 100 rows a page, so this is 20 000 accounts — orders of
 * magnitude past anything this suite creates. It exists because a cursor that fails to
 * advance is an INFINITE loop, and a suite that hangs is harder to diagnose than one
 * that fails with a sentence.
 */
const MAX_PAGES = 200;

const accountsQuery = (role: string, extra = ''): string =>
  `/v1/platform/accounts?role=${encodeURIComponent(role)}&limit=${MAX_LIMIT}${extra}`;

const listAccounts = (role: string, extra = '') =>
  treq<AccountsPage>('GET', accountsQuery(role, extra), { token: owner });

/**
 * EVERY account the endpoint serves under one filter, paged to exhaustion.
 *
 * WHY NOT ONE PAGE. `MAX_LIMIT` is 100 and this endpoint has no salon predicate — it is
 * "the widest read in the product" by its own header — so one page is a prefix of an
 * unknown population that other files in this suite are appending to. A universal claim
 * ("every row served satisfies the filter") is only universal if it is made over all of
 * them; made over a prefix it silently becomes a claim about ordering, which is the
 * mistake `campaigns.test.ts` § `LOWBAL` records paying for.
 *
 * THE CURSOR IS EXERCISED AS A SIDE EFFECT, and it is worth naming because it is the one
 * thing here that is genuinely new rather than merely untested: `parseCursor` and
 * `afterCursor` run against a composite over two streams, and until this file NOTHING
 * had ever followed that cursor with a `role=` filter also applied. `support-routing.
 * test.ts` pages a same-microsecond tie on the unfiltered read.
 *
 * A NON-ADVANCING CURSOR IS DETECTED RATHER THAN WAITED ON: a page that yields no rows
 * while still handing back a cursor, or a cursor that repeats, throws by name.
 */
async function listEveryAccount(role: string, extra = ''): Promise<AccountRow[]> {
  const all: AccountRow[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const suffix: string = cursor === null ? extra : `${extra}&cursor=${encodeURIComponent(cursor)}`;
    const res = await listAccounts(role, suffix);
    if (res.status !== 200) {
      throw new Error(
        `GET ${accountsQuery(role, suffix)} answered ${res.status} on page ${page + 1}: ${res.raw}`,
      );
    }
    all.push(...res.body.items);

    const next: string | null = res.body.nextCursor ?? null;
    if (next === null) return all;
    if (res.body.items.length === 0) {
      throw new Error(
        `GET /v1/platform/accounts?role=${role} handed back a cursor on an EMPTY page ` +
          `(page ${page + 1}). That is a cursor that cannot advance, and following it is an ` +
          'infinite loop rather than a slow test.',
      );
    }
    if (seenCursors.has(next)) {
      throw new Error(
        `GET /v1/platform/accounts?role=${role} repeated cursor ${next} on page ${page + 1}. ` +
          'The composite cursor is not advancing under a role filter.',
      );
    }
    seenCursors.add(next);
    cursor = next;
  }

  throw new Error(
    `GET /v1/platform/accounts?role=${role} did not run out of pages in ${MAX_PAGES} ` +
      `(${all.length} rows read). Either this database is far larger than any suite makes ` +
      'it, or the cursor is advancing without ever terminating.',
  );
}

// ---------------------------------------------------------------------------
// WHAT EACH FILTER MEANS
// ---------------------------------------------------------------------------

interface RoleExpectation {
  /** True for every row the filter is allowed to serve. The universal half. */
  admits: (a: AccountRow) => boolean;
  /** Prose for the failure message when `admits` rejects a served row. */
  admitsClaim: string;
  /** Fixture ids the filter MUST serve. The half that defeats an empty list. */
  present: string[];
  /** Fixture ids the filter must NOT serve. */
  absent: string[];
}

/**
 * THE LOOP IS DERIVED; THE MEANING IS DECLARED. That split is deliberate and it is the
 * one real difference from `campaigns.test.ts` § THE AUDIENCE DIMENSION.
 *
 * There, every audience has the SAME correct answer — 201, `pending`, an integer reach —
 * so a uniform loop over the constant is the whole specification. Here each filter's
 * correct answer is DIFFERENT, and that difference is the entire subject: a spec that
 * asserted the same thing about all four would be a status-code loop again, blind to
 * exactly the mislaid predicate § WHAT THIS FILE CLAIMS is about. There is no way to
 * derive "customer means only customers" from the string `'customer'` that is not just
 * this table written less legibly.
 *
 * SO THE DERIVATION PROTECTS THE OTHER PROPERTY: a fifth filter added to `ROLE_FILTERS`
 * cannot slip through untested, because the loop comes from the constant and this
 * function THROWS on a member it has no meaning for. Red, by name, on the commit that
 * adds it — rather than green with one more shape nobody has driven, which is the
 * failure this whole family of files exists to end.
 */
function expectationFor(role: string): RoleExpectation {
  switch (role) {
    /**
     * The default, and until this file the only value ever sent. BOTH streams run, so
     * this is the only filter required to contain a customer AND a staff member — an
     * `all` that had lost one of its two queries would still answer 200 with a
     * plausible list.
     */
    case 'all':
      return {
        admits: (a) => a.kind === 'customer' || a.kind === 'staff',
        admitsClaim: 'every row is a customer or a staff member (there is no third kind)',
        present: [QA_CUSTOMER, QA_OWNER, QA_STAFF],
        absent: [],
      };

    /** `wantStaff` is false, so `staff_user` is never queried. */
    case 'customer':
      return {
        admits: (a) => a.kind === 'customer',
        admitsClaim: "every row is kind 'customer'",
        present: [QA_CUSTOMER],
        absent: [QA_OWNER, QA_STAFF],
      };

    /**
     * `wantCustomers` is false, so `member` is never queried.
     *
     * AND OWNERS ARE INCLUDED, which is a decision rather than an accident —
     * accounts.ts:323 states it: "a list that hid the owner from it would be a list of
     * everyone except the one person a console admin is most likely looking for." That is
     * exactly the kind of decision a later reader tidies away, so it gets an executable
     * twin here: `present` names the owner row, not only the artist.
     */
    case 'staff':
      return {
        admits: (a) => a.kind === 'staff',
        admitsClaim: "every row is kind 'staff'",
        present: [QA_OWNER, QA_STAFF],
        absent: [QA_CUSTOMER],
      };

    /**
     * The only filter with an extra WHERE clause (accounts.ts:326), and the only one
     * that binds a `staff_role` enum value as a parameter.
     */
    case 'owner':
      return {
        admits: (a) => a.kind === 'staff' && a.role === 'owner',
        admitsClaim: "every row is kind 'staff' with role 'owner'",
        present: [QA_OWNER],
        absent: [QA_CUSTOMER, QA_STAFF],
      };

    default:
      throw new Error(
        `ROLE_FILTERS contains "${role}" and this file declares no meaning for it.\n` +
          `Read from ${ROLE_CONSTANT_FILE}: ${ROLE_FILTERS.join(', ')}.\n\n` +
          'This throw IS the coverage. A new role filter compiles two new query shapes in ' +
          '`registerAccountRoutes` — `wantCustomers`/`wantStaff` and possibly a WHERE ' +
          'clause of its own — and adding it without saying here which accounts it must ' +
          'and must not serve would leave those shapes as untested as `customer`, `staff` ' +
          'and `owner` were before this file existed. Add a case above: what every served ' +
          'row must satisfy, and which of this file\'s three fixture rows it must and must ' +
          'not return.',
      );
  }
}

const idsOf = (rows: AccountRow[]): string[] => rows.map((r) => r.id);

/** A row's identity in a failure message, short enough to list a handful of. */
const describeRow = (a: AccountRow): string => `${a.id}(kind=${a.kind},role=${a.role})`;

beforeAll(async () => {
  await startTenancyApi();
  owner = await signInPlatform(PLATFORM_OWNER_HANDLE);

  seedRows();

  precondition(
    scalar(`select count(*) from member where id='${QA_CUSTOMER}'`).trim() === '1',
    `the clone source ${B_MEMBER} is missing, so this file has no customer row`,
  );
  precondition(
    scalar(`select role::text from staff_user where id='${QA_OWNER}'`).trim() === 'owner',
    'the owner fixture did not land as role=owner, so ?role=owner would be tested against ' +
      'an empty list and would pass',
  );
  precondition(
    scalar(`select role::text from staff_user where id='${QA_STAFF}'`).trim() === 'artist',
    'the non-owner staff fixture did not land, so ?role=staff and ?role=owner would admit ' +
      'identical lists and the owner predicate would be untested',
  );
  precondition(
    scalar(`select count(*) from staff_user where id='${A_STAFF_FULL}'`).trim() === '1',
    'the seeded salon A staff row is missing, so this database is not the one this suite ' +
      'seeds and nothing below is reasoning about the fixtures it thinks it is',
  );
}, 120_000);

afterAll(async () => {
  await stopTenancyApi();
  dropRows();
});

// ===========================================================================
// THE DERIVATION ITSELF
// ===========================================================================

describe('the role filter — every member of ROLE_FILTERS, derived', () => {
  it("the constant was read out of lane A's route module, and it holds the known positives", () => {
    /**
     * THE PARSER IS LOAD-BEARING, so it is proved against known positives before
     * anything is concluded from it. A regex that matched the declaration and read no
     * strings out of it would make every loop below iterate zero times and report green
     * — the failure this file exists to prevent, one level down.
     *
     * THE COUNT IS NOT PINNED AT 4, for the reason `campaigns.test.ts` gives for not
     * pinning 5: the two throws in `constListFromSource()` already cover an emptied or
     * unreadable constant, and pinning the count would only add a spec that turns red on
     * the day somebody deliberately adds a fifth filter — when the whole point of
     * deriving the loop is that the fifth is COVERED rather than that it does not exist.
     * `expectationFor()`'s `default` is what fires then, and it fires with instructions.
     */
    expect(
      ROLE_FILTERS.length,
      `only ${ROLE_FILTERS.length} filter(s) were read out of ${ROLE_CONSTANT_FILE}. The ` +
        'reader matched the declaration but is mis-reading its contents.',
    ).toBeGreaterThanOrEqual(2);

    for (const known of ['all', 'customer', 'staff', 'owner']) {
      expect(
        ROLE_FILTERS,
        `"${known}" is not among the filters read from source (${ROLE_FILTERS.join(', ')}). ` +
          'Either the constant genuinely lost it — in which case a console chip has no ' +
          'endpoint behind it — or the reader is wrong, and if the reader is wrong every ' +
          'derived spec below is testing the wrong set.',
      ).toContain(known);
    }
  });

  it('the RUNNING server recites the same four filters in its own refusal', async () => {
    /**
     * THE CROSS-CHECK AGAINST THE DEPLOYED ARTIFACT, and the only one available here.
     *
     * `campaigns.test.ts` cross-checks its constant against a CHECK constraint, because
     * a second gate on the same field really exists there. `?role=` has no database
     * gate — it is validated in TypeScript and then compiled into a predicate — so
     * there is no constraint to read. What there IS is `parseRole` building its refusal
     * as `role must be one of ${ROLE_FILTERS.join(', ')}`, which makes the running
     * process willing to recite the list it is actually enforcing.
     *
     * WHAT IT ACTUALLY CATCHES TODAY, stated precisely rather than grandly.
     * `startTenancyApi()` boots lane A's API from THIS checkout with `tsx`, so the file
     * the reader parses and the process the loops drive are the same source by
     * construction — there is no `AVO_API_BASE` to point elsewhere. So this spec is not
     * guarding against a stale deployment; it is guarding against the READER. A regex
     * anchored on the wrong declaration, or one that matched `RoleFilter` instead of
     * `ROLE_FILTERS`, produces a plausible list that the server does not enforce, and
     * every loop below would then be derived from the wrong set while still passing. It
     * fails here, in one sentence, instead.
     *
     * AND IT BECOMES LOAD-BEARING the day anything points this suite at an API it did
     * not boot — the way `E2E_BASE_URL` already does for the mock-backed files in this
     * package. At that point the file and the process really can disagree, and this is
     * the spec that says so.
     *
     * THE MESSAGE FORMAT IS A DEPENDENCY, stated plainly rather than hidden: this spec
     * reads `ROLE_FILTERS` out of English prose. If lane A rewords the refusal, this
     * goes red and the fix is to update the extraction here — not to delete the spec.
     * The alternative is trusting that the file and the process agree, which is the
     * assumption every stale-comment defect in this repository is made of.
     */
    const res = await treq<AccountsPage>(
      'GET',
      '/v1/platform/accounts?role=definitely-not-a-role',
      { token: owner },
    );
    precondition(
      res.status === 400,
      `a bogus role answered ${res.status} rather than 400, so there is no refusal message ` +
        `to read the server's list out of: ${res.raw}`,
    );

    const message = res.body.message ?? '';
    const listed = message.replace(/^[^:]*one of\s*/i, '').replace(/\.\s*$/, '');
    const recited = listed
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '');

    expect(
      [...recited].sort(),
      'the filters the RUNNING SERVER enforces and the filters read out of ' +
        `${ROLE_CONSTANT_FILE} disagree.\n  server said: ${message}\n  parsed as: ` +
        `${recited.join(', ')}\n  read from source: ${ROLE_FILTERS.join(', ')}\n\nOne of ` +
        'three things: the checkout this suite reads is not the source the API was booted ' +
        'from, the source reader is anchored on the wrong declaration, or `parseRole`\'s ' +
        'message was reworded and the extraction in this spec needs updating.',
    ).toEqual([...ROLE_FILTERS].sort());
  });

  it("lane C's console chips are exactly the filters lane A accepts", () => {
    /**
     * TWO LISTS, TWO LANES, ONE FIELD — and neither lane's own tests can see both.
     *
     * `apps/dashboard/src/api/platformAccounts.ts` declares `ACCOUNT_ROLE_FILTERS` by
     * hand and its comment says "Mirrored from the server's exported list rather than
     * invented". `ROLE_FILTERS` is NOT exported, so the mirror was necessarily typed out
     * rather than derived, and a hand-typed copy of another lane's constant is the exact
     * shape `consoleNavGates.test.ts` was written for after a gate moved underneath a
     * correct, line-referenced comment.
     *
     * It fails in both directions and neither is loud:
     *
     *   a chip lane A does not accept   the console sends `?role=X`, gets 400
     *                                   `invalid_role`, and the Accounts section is
     *                                   broken for whoever clicks that chip.
     *   a filter lane C never draws     a validated query shape with no caller — which
     *                                   is precisely the state `customer`, `staff` and
     *                                   `owner` were in when this file was written, and
     *                                   how an untested shape stays untested.
     *
     * ORDER IS ASSERTED, NOT ONLY MEMBERSHIP, because the design's chip row is ordered —
     * "All accounts, Customers, Staff, Salon owners" — and both lists are written in that
     * order today. Sorting first would hide a reordering that moves the console's chips
     * away from the design.
     *
     * READ AS TEXT, like everything else here. `e2e/` imports from neither `api/src` nor
     * `apps/`; the point is to be an outside observer of both.
     */
    const mirror = constListFromSource(DASHBOARD_MIRROR_FILE, 'ACCOUNT_ROLE_FILTERS');

    expect(
      mirror,
      "the console's role chips and the API's role filters disagree.\n  " +
        `${DASHBOARD_MIRROR_FILE}: ${mirror.join(', ')}\n  ${ROLE_CONSTANT_FILE}: ` +
        `${ROLE_FILTERS.join(', ')}\n\nA chip the API does not accept 400s ` +
        '`invalid_role` on the console. A filter the console never draws is a query shape ' +
        'with no caller. If the order changed, check it against the design\'s chip row ' +
        'before changing this spec.',
    ).toEqual(ROLE_FILTERS);
  });

  it('the staff_role enum on THIS database really admits the value the owner chip binds', () => {
    /**
     * The one thing `?role=owner` does that no other filter does is bind `'owner'` as a
     * parameter against `staff_user.role`, a Postgres ENUM (accounts.ts:326).
     *
     * WHY THAT IS WORTH A SPEC OF ITS OWN, given the loop below drives the endpoint
     * anyway: it is the same failure family as the `lapsed` 500 — a parameter the
     * database will not accept against the column it is compared to — and it is the one
     * that fails at the DRIVER rather than in application code, so it arrives as
     * `server_error` with nothing in the reply naming the cause. When it happens, the
     * loop below goes red with a 500 and this spec goes red with the reason. A migration
     * that renamed or dropped the `owner` label would do exactly that.
     *
     * Read out of `pg_enum` rather than out of the schema module, because what matters
     * is the type in front of THIS run, not the one the source describes.
     */
    const labels = scalar(
      `select coalesce(string_agg(e.enumlabel, ',' order by e.enumsortorder), '')
         from pg_type t join pg_enum e on e.enumtypid = t.oid
        where t.typname = 'staff_role'`,
    ).trim();

    expect(
      labels,
      'the `staff_role` enum is not on this database at all, so this spec is reading ' +
        'nothing and proving nothing about the value ?role=owner binds',
    ).not.toBe('');
    expect(
      labels.split(','),
      `\`staff_role\` on this database is (${labels}) and does not include "owner". ` +
        '`?role=owner` binds that label against `staff_user.role`, so this is a 500 on the ' +
        "console's Salon owners chip, thrown by the driver with nothing in the reply to " +
        'say why.',
    ).toContain('owner');
  });

  // =========================================================================
  // 1. THE STATUS CODE — one spec per member of ROLE_FILTERS
  // =========================================================================
  /**
   * THE SPEC WHOSE ABSENCE LET THE CAMPAIGNS 500 LIVE, written for this endpoint before
   * anybody meets it. The whole subject is the status code: `role=customer` and
   * `role=staff` each SKIP one of the two table queries and `role=owner` adds a bound
   * enum parameter, and none of those three had ever been executed.
   *
   * ONE PAGE, DELIBERATELY. This spec is not making a claim about the contents — the
   * discrimination loop below pages to exhaustion for that — so it asks for one page and
   * gets its answer in one request. What it does assert about the body is that `items` is
   * an ARRAY: a 200 carrying `{"error":...}`, or a page shaped like the audit read's
   * `{ total, items }`, would satisfy a bare status assertion and break every caller.
   */
  for (const role of ROLE_FILTERS) {
    it(`GET /v1/platform/accounts?role=${role} answers 200 for the platform owner`, async () => {
      const res = await listAccounts(role);

      expect(
        res.status,
        `GET ${accountsQuery(role)} answered ${res.status}.\n${res.raw}\n\n` +
          'A 500 here is the bug this file exists for — `?role=' +
          role +
          '` compiles a query shape no spec in this package had ever executed. A 400 ' +
          'means `parseRole` validates against a narrower list than `ROLE_FILTERS`, ' +
          'which is the same defect from the other side. A 403 means the platform ' +
          "owner has lost the `accounts` section, and it is not this file's subject.",
      ).toBe(200);

      expect(
        Array.isArray(res.body.items),
        `?role=${role} answered 200 but \`items\` is ${JSON.stringify(res.body.items)} ` +
          'rather than an array, so every client that maps over it breaks on a reply ' +
          'a status-code assertion calls healthy',
      ).toBe(true);
      expect(
        res.body.nextCursor === null || typeof res.body.nextCursor === 'string',
        `?role=${role} answered a nextCursor of ${JSON.stringify(res.body.nextCursor)}`,
      ).toBe(true);
    });
  }

  // =========================================================================
  // 2. THE FILTER DISCRIMINATES — the claim a pinned-value suite cannot make
  // =========================================================================
  /**
   * ONE SPEC PER FILTER, over EVERY row the filter serves, asserting three things: that
   * no row it served is one the filter does not admit, that this file's rows it must
   * serve are all there, and that this file's rows it must not serve are all absent.
   *
   * The first is the predicate claim and is population-independent. The second is what
   * stops an empty list from satisfying the first. The third is what makes the four
   * filters four different answers rather than four names for one.
   */
  for (const role of ROLE_FILTERS) {
    it(`?role=${role} serves only the accounts that filter admits, and serves them`, async () => {
      const expected = expectationFor(role);
      const rows = await listEveryAccount(role);

      // -- the universal half: nothing served that the filter does not admit --
      const wrong = rows.filter((a) => !expected.admits(a));
      expect(
        wrong.map(describeRow),
        `?role=${role} served ${wrong.length} account(s) it must not: ${expected.admitsClaim} ` +
          `is false for them.\nThe claim is about the PREDICATE, so this is a mislaid ` +
          '`wantCustomers`/`wantStaff` at accounts.ts:242-243, or a lost WHERE clause at ' +
          `accounts.ts:326 — not a fixture problem. ${rows.length} row(s) were read in ` +
          'total across every page.',
      ).toEqual([]);

      /**
       * -- and the half that makes the universal half mean something --
       *
       * An empty list satisfies every universal claim ever written. `role=owner` in
       * particular returns nothing at all on a database with no owner in it, and the
       * first draft of this file was green for exactly that reason before the fixture
       * above existed. So the filter is required to actually FIND the rows it admits.
       */
      const served = new Set(idsOf(rows));
      for (const id of expected.present) {
        expect(
          served.has(id),
          `?role=${role} did not serve ${id}, which it must — ${expected.admitsClaim}, and ` +
            `that row satisfies it (see this file's fixtures). ${rows.length} row(s) were ` +
            'read across every page, so this is not truncation. A filter that serves ' +
            'nothing passes every other assertion in this spec.',
        ).toBe(true);
      }
      for (const id of expected.absent) {
        expect(
          served.has(id),
          `?role=${role} served ${id}, which it must not. This is the console's ${role} ` +
            'chip listing an account from another category — no 500, no 400, and a ' +
            'plausible-looking list of the wrong rows, which is what a status-code loop ' +
            'cannot see.',
        ).toBe(false);
      }
    });
  }

  /**
   * THE THREE FIXTURES ARE ADMITTED BY DIFFERENT FILTERS — asserted once, directly,
   * rather than left as a property of the table above.
   *
   * If `staff` and `owner` ever admitted the same set, every spec above would still
   * pass and the extra WHERE clause at accounts.ts:326 could be deleted with the suite
   * green. That is the whole `LOWBAL` lesson from `campaigns.test.ts`: the fixture must
   * make the filters discriminate, and whether it still does is itself worth an
   * assertion, because it is a property of DATA and data is what rots.
   */
  it('the four filters are four different answers, not four names for one', async () => {
    const sets = new Map<string, Set<string>>();
    for (const role of ROLE_FILTERS) {
      const rows = await listEveryAccount(role);
      sets.set(
        role,
        new Set(idsOf(rows).filter((id) => [QA_CUSTOMER, QA_OWNER, QA_STAFF].includes(id))),
      );
    }

    const signature = (role: string): string => [...(sets.get(role) ?? [])].sort().join('+');

    // `staff` ⊋ `owner` is the pair the extra WHERE clause exists for.
    expect(
      signature('staff'),
      'the `staff` and `owner` filters admit the SAME accounts, so the owner predicate at ' +
        'accounts.ts:326 could be deleted with this suite green. Either the non-owner staff ' +
        'fixture stopped landing, or `staff` has quietly become an owners-only list.',
    ).not.toBe(signature('owner'));

    expect(
      signature('customer'),
      'the `customer` and `staff` filters admit the same accounts of this file\'s three, ' +
        'so `wantCustomers`/`wantStaff` are not discriminating at all',
    ).not.toBe(signature('staff'));

    // `all` is the union, and it is the only filter that must hold all three.
    expect(
      signature('all'),
      "`all` does not admit all three of this file's fixtures, so one of its two table " +
        'queries is not running',
    ).toBe([QA_CUSTOMER, QA_OWNER, QA_STAFF].sort().join('+'));
  });

  // =========================================================================
  // 3. THE REFUSAL, AND THE DEFAULT
  // =========================================================================

  it('an unknown role is refused 400 invalid_role and no accounts cross the wire', async () => {
    /**
     * The other half of `parseRole`, and the reason the derived loops above can be
     * trusted to be about the filter rather than about validation: an unknown value must
     * not fall through to `all`.
     *
     * A FALL-THROUGH IS A DISCLOSURE, NOT A COSMETIC BUG, on this endpoint specifically.
     * It is "the widest read in the product" with no salon predicate — so a `?role=` the
     * parser did not recognise, defaulted quietly to `all`, would answer a typo with
     * every customer and every staff member of every tenant. That is why this spec
     * asserts on the BODY as well as the status: no `items` key at all.
     */
    const res = await treq<AccountsPage>('GET', '/v1/platform/accounts?role=manager', {
      token: owner,
    });

    expect(
      res.status,
      `?role=manager answered ${res.status} rather than 400: ${res.raw}\n\n"manager" is a ` +
        'real `staffRole` and NOT a role FILTER, which is the plausible wrong value — the ' +
        'console has five staff roles and four chips. A 200 here means an unrecognised ' +
        'filter fell through to `all` and answered a typo with every account AVO holds.',
    ).toBe(400);
    expect(
      res.body.error,
      `?role=manager was refused 400 but not by name: ${res.raw}. Clients switch on ` +
        '`error`, and `invalid_role` is what `parseRole` throws.',
    ).toBe('invalid_role');
    expect(
      res.body.items,
      'a refused accounts read carried accounts in its body',
    ).toBeUndefined();
  });

  it('an absent and an empty ?role= both mean `all`, which is how the console asks', async () => {
    /**
     * `parseRole` returns `all` for `undefined` and for `''` — two early returns, and the
     * empty one is not hypothetical: `apps/dashboard/src/api/platformAccounts.ts` builds
     * its query string from the chip state, and "All accounts" is the chip that is
     * selected when nobody has chosen. `support-routing.test.ts` sends `?salon=&limit=100`
     * — an empty `salon=` — which is the same idiom arriving on the neighbouring
     * parameter, so an empty `role=` is what a URL builder produces here.
     *
     * ASSERTED AGAINST `all`'S OWN ANSWER rather than against a count, because a count is
     * a claim about the population and this is a claim about the parser: three spellings
     * of the same request must serve the same accounts. Read on one page — the three
     * requests are compared with each other, so a prefix is a fair comparison as long as
     * it is the same prefix, and `nextCursor` is compared too.
     */
    const [explicit, absent, empty] = await Promise.all([
      treq<AccountsPage>('GET', `/v1/platform/accounts?role=all&limit=${MAX_LIMIT}`, {
        token: owner,
      }),
      treq<AccountsPage>('GET', `/v1/platform/accounts?limit=${MAX_LIMIT}`, { token: owner }),
      treq<AccountsPage>('GET', `/v1/platform/accounts?role=&limit=${MAX_LIMIT}`, {
        token: owner,
      }),
    ]);

    for (const [label, res] of [
      ['?role=all', explicit],
      ['no ?role= at all', absent],
      ['?role= (empty)', empty],
    ] as const) {
      expect(res.status, `${label} answered ${res.status}: ${res.raw}`).toBe(200);
    }

    expect(
      idsOf(absent.body.items),
      'omitting ?role= served a different page from ?role=all, so the default is not `all`',
    ).toEqual(idsOf(explicit.body.items));
    expect(
      idsOf(empty.body.items),
      'an EMPTY ?role= served a different page from ?role=all. `parseRole` returns `all` ' +
        "for '' deliberately, because a URL builder that always emits the parameter is " +
        'how the console asks for every account.',
    ).toEqual(idsOf(explicit.body.items));
    expect(absent.body.nextCursor).toBe(explicit.body.nextCursor);
    expect(empty.body.nextCursor).toBe(explicit.body.nextCursor);
  });
});
