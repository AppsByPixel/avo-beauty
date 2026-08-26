/**
 * `POST /v1/platform/salons` — THE ADVERSARIAL HALF OF ONBOARDING.
 *
 * HOW TO RUN
 *
 *   pnpm install
 *   pnpm --dir ./api run db:up
 *   cd e2e && ../node_modules/.bin/vitest run salon-onboarding.test.ts
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Until dev `59e8628` there was no way to create a salon at all: every salon
 * existed because `seed.ts` inserted one, so onboarding a real client meant a
 * hand-written INSERT. Lane A closed that. This file is the half lane A should not
 * write about its own change — the endpoint creates a TENANT and a CREDENTIAL in one
 * request, which makes it the highest-consequence POST in the product.
 *
 * WHAT IS DELIBERATELY NOT HERE, because it is already covered and a second copy is
 * a liability:
 *
 *   - THE PERMISSION GATE. `permission-census.test.ts` discovered
 *     `POST /v1/platform/salons → salons` from source with no edit from me, and
 *     probes it both ways: refused with the section off, and stops refusing with it
 *     restored. That is non-negotiable #7's requirement, automated, and it arrived
 *     the same run the endpoint did. What IS added below is the one thing a
 *     generated census cannot know — that the gate is the RIGHT permission — which
 *     is an argument about presets, not about a route.
 *
 *   - THE CROSS-SALON MINT. `tenancy.test.ts` drives the salon-scoped census.
 *
 * WHAT IS ASSERTED, AND WHY EACH ONE
 * ----------------------------------
 * 1. THE GATE IS `salons`, NOT `analytics`, AND THE PRESETS ARE THE ARGUMENT.
 *    `GET /v1/platform/salons` takes `analytics` because metrics already exposes
 *    salon names and money under that gate. Creating is management, so it takes
 *    `salons`. The two presets make that concrete and opposite:
 *      analyst  analytics YES, salons NO   → may read the list, may not create
 *      support  analytics NO,  salons YES  → may create, may not read the list
 *    Had the create gate been `analytics`, every analyst could onboard a tenant.
 *    Mariam (`PLT-002`) is a real seeded analyst, so this is provable against a
 *    fixture rather than a synthetic flip.
 *
 * 2. ATOMICITY. build-plan.md calls a half-published tier ladder a money bug in
 *    those words, and this transaction creates five things at once. Loyalty lands
 *    in a SINGLE INSERT so `salon_loyalty_config_complete` is satisfied by that
 *    statement rather than a follow-up UPDATE — asserted structurally below, by
 *    requiring that no salon this endpoint created is missing any dependent row.
 *
 * 3. DOUBLE SUBMIT, WITH THE OVERLAP PROVED RATHER THAN ASSUMED. This is the one
 *    that needs the most care, and my own rule is why: a SELECT-then-INSERT and a
 *    conditional INSERT are byte-identical from outside, so "two requests, one
 *    salon" is evidence of a guard ONLY if the requests genuinely overlapped. Two
 *    sequential requests also produce one salon, and would pass a naive spec while
 *    proving nothing about concurrency. So the wall-clock intervals are recorded on
 *    the client and their INTERSECTION is asserted positive before any conclusion is
 *    drawn from the outcome.
 *
 * 4. A REFUSED CREATE WRITES NOTHING AND BURNS NO KEY. Validation runs before the
 *    transaction opens, so a 400 must leave no salon and must leave the
 *    Idempotency-Key reusable. The second half is the interesting one: a key burnt
 *    by a validation failure would make the wizard's retry-after-fixing-the-form
 *    answer 422 for ever.
 *
 * 5. THE INVITE CLAIMS NO DELIVERY. No sender is wired. `sent_at` stays NULL and
 *    nothing reports `delivered`, the same shape as the three reset flows.
 *
 * 6. `ownerPhone` IS NEVER SERVED. Migration 0037 added it, and `GET /salons/{id}`
 *    is readable by any authenticated principal of that salon — including a MEMBER,
 *    because the wallet renders the salon name, brand colour and hours. So a column
 *    holding the owner's personal mobile must not appear in that payload, on any
 *    surface, ever.
 *
 * EVERY SALON THIS FILE CREATES IS ITS OWN, named with a per-run suffix, and torn
 * down in `afterAll`. Counts are asserted as DELTAS or FLOORS, never as equalities
 * against the whole table — the census's own granted-mirror probe creates rows here
 * too, and an exact count would go red on a legitimate addition.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { precondition } from './support/known-bug.js';
import {
  B_MEMBER_PHONE,
  B_STAFF_HANDLE,
  PLATFORM_ANALYST,
  PLATFORM_ANALYST_HANDLE,
  PLATFORM_OWNER_HANDLE,
  SALON_B,
  psql,
  scalar,
  signInDashboard,
  signInMember,
  signInPlatform,
  signInPlatformFresh,
  startTenancyApi,
  stopTenancyApi,
  treq,
} from './support/tenancy-harness.js';

let owner = '';
let analyst = '';

/** A suffix nothing else in the run can produce, so every name here is this file's. */
const RUN = `${Date.now().toString(36).slice(-4)}${Math.floor(Math.random() * 900 + 100)}`.toUpperCase();
let seq = 0;
const uniqueName = (label: string) => `QA ${label} ${RUN}${seq++}`;
const uniqueKey = (label: string) => `qa-onboard-${label}-${RUN}-${seq++}`;

/** Everything created here, torn down at the end. */
const createdSalons = new Set<string>();

const validBody = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  city: 'Salmiya',
  ownerPhone: '+96599887766',
  ...extra,
});

const create = (body: unknown, key: string, token = owner) =>
  treq<any>('POST', '/v1/platform/salons', { token, idempotencyKey: key, body });

/** Remember whatever came back, so teardown can find it. */
function remember(res: { status: number; body: any }): string | null {
  const id = res.body?.id ?? res.body?.salon?.id ?? null;
  if (typeof id === 'string') {
    createdSalons.add(id);
    return id;
  }
  return null;
}

const num = (sql: string): number => Number(scalar(sql).trim());

beforeAll(async () => {
  await startTenancyApi();
  owner = await signInPlatform(PLATFORM_OWNER_HANDLE);
  analyst = await signInPlatform(PLATFORM_ANALYST_HANDLE);
}, 120_000);

afterAll(async () => {
  await stopTenancyApi();
  // Belt and braces over the support spec's own `finally`.
  try {
    psql(`DELETE FROM platform_admin WHERE id = 'PLT-QA-SUP1';`);
  } catch {
    /* reported by the next run's stale-fixture sweep */
  }
  /*
   * Dependency order, and best-effort: the run database is dropped by global
   * teardown, so this matters only for a run pointed at a shared API — where
   * leaving tenants and owner credentials behind would be far worse than a failed
   * DELETE here.
   */
  for (const id of createdSalons) {
    try {
      psql(`
        DELETE FROM audit_log WHERE salon_id = '${id}';
        DELETE FROM staff_password_reset WHERE salon_id = '${id}';
        DELETE FROM staff_user WHERE salon_id = '${id}';
        DELETE FROM branch WHERE salon_id = '${id}';
        DELETE FROM salon WHERE id = '${id}';
      `);
    } catch {
      // Reported by the next run's stale-fixture sweep rather than failing teardown.
    }
  }
});

// ---------------------------------------------------------------------------
describe('The console gates, and the presets are the argument for which one', () => {
  /**
   * THIS SECTION WAS WRONG FOR A DAY, AND THE REASON IS WORTH KEEPING.
   *
   * It used to assert "an analyst READS the salon list — 200, because that is what
   * `analytics` buys". That was true when it was written: the LIST took `analytics`
   * on the argument that `/v1/platform/metrics` already exposes salon names and
   * money under that gate, so the list widened nothing.
   *
   * Trunk then REGATED the list to `salons` on this lane's and lane C's finding, and
   * the spec went red having faithfully captured a truth that stopped being one.
   * That is the spec doing its job — the same event as the fifteen brandColour
   * knownBugs going red, arriving from the other direction.
   *
   * THE PAIR IS STILL THE ARGUMENT; regating moved it rather than removing it. The
   * presets are opposite on this axis:
   *
   *   analyst   analytics YES, salons NO   -> metrics yes, salon list no, create no
   *   support   analytics NO,  salons YES  -> metrics no,  salon list yes, create yes
   *
   * So the claim now under test is that authority to see AGGREGATE platform
   * performance and authority to see and change the TENANT ROSTER are different
   * things, held by different presets. What must NOT have happened is the analyst
   * losing the figures she is employed to read — the entire tiebreak for the old
   * gating was that metrics already names salons and their money, and that is still
   * true and still hers.
   */
  it('the two presets really are opposite on this axis, or every pair below is vacuous', () => {
    /*
     * DERIVED FROM THE FIXTURE, not restated. If Mariam's preset changes, this fails
     * here with a clear reason rather than making the specs below mysterious — a
     * spec whose premise has silently rotted is worse than no spec.
     */
    const analytics = scalar(
      `select perm_analytics from platform_admin where id='${PLATFORM_ANALYST}'`,
    ).trim();
    const salons = scalar(
      `select perm_salons from platform_admin where id='${PLATFORM_ANALYST}'`,
    ).trim();
    expect(analytics, 'the analyst holds no analytics, so the metrics half proves nothing').toBe('t');
    expect(salons, 'the analyst already holds salons, so the refusals prove no gate choice').toBe('f');
  });

  it('the analyst still reads METRICS — 200, with its named top salons', async () => {
    const res = await treq('GET', '/v1/platform/metrics', { token: analyst });
    expect(res.status, `the analyst lost the figures she is employed to read: ${res.raw}`).toBe(200);

    /*
     * NOT JUST A 200. The old gating's entire tiebreak was that metrics ALREADY
     * exposes salon names and money under `analytics`, so moving the list to
     * `salons` widened nothing and took nothing away. If regating had also stripped
     * the names out of metrics, that argument would have quietly become false and a
     * status-only assertion would not have noticed.
     */
    expect(Array.isArray(res.body.topSalons), 'metrics serves no top-salon list').toBe(true);
    precondition(
      res.body.topSalons.length > 0,
      'no salon has loaded any money, so the naming assertion below is vacuous',
    );
    for (const s of res.body.topSalons) {
      expect(typeof s.name, 'a top salon has no name').toBe('string');
      expect(s.name.length, 'a top salon is named with an empty string').toBeGreaterThan(0);
    }
  });

  it('but the analyst is refused the salon LIST — 403, which is the regating', async () => {
    const res = await treq('GET', '/v1/platform/salons?limit=5', { token: analyst });
    expect(
      res.status,
      'the analyst read the tenant roster. The list takes `salons` now, precisely so that ' +
        `seeing aggregate performance does not carry seeing the client list. Response: ${res.raw}`,
    ).toBe(403);
    expect(res.body?.error).toBe('forbidden');
  });

  it('and the analyst cannot create one — 403, and nothing is written', async () => {
    const before = num(`select count(*) from salon`);
    const res = await create(validBody(uniqueName('AnalystDenied')), uniqueKey('analyst'), analyst);

    expect(res.status, `an analyst onboarded a tenant. Response: ${res.raw}`).toBe(403);
    expect(res.body?.error).toBe('forbidden');

    // A refusal that still created something would be the worst of both.
    expect(num(`select count(*) from salon`), 'the refused create still made a salon').toBe(before);
  });

  /**
   * THE OTHER HALF OF THE PAIR, and it needs an admin the seed does not provide.
   *
   * `seed.ts` creates an owner, an analyst and an admin — no `support`. Rather than
   * flip Mariam's columns and put them back (she is the fixture the specs above and
   * the generated permission census both lean on), this hires its own: the `support`
   * preset as `PLATFORM_ROLE_PRESETS` declares it, cloned onto her password hash so
   * the standard sign-in works, and deleted afterwards.
   */
  it('a `support` admin gets the mirror image — the list yes, the metrics no', async () => {
    const SUPPORT = 'PLT-QA-SUP1';
    const SUPPORT_HANDLE = 'qasupport';

    /*
     * The support preset from api/src/db/schema/platformAdmin.ts:
     *   analytics false, activity true, salons true, accounts true,
     *   admins false, controls false, approvals false, policies false, audit false
     * Spelled out rather than derived by string manipulation, for the reason seed.ts
     * gives for doing the same — and the two columns this spec asserts on are the
     * two that decide the mirror.
     */
    psql(`
      INSERT INTO platform_admin (id, name, handle, password_hash, role, owner,
                                  perm_analytics, perm_activity, perm_salons, perm_accounts,
                                  perm_admins, perm_controls, perm_approvals, perm_policies,
                                  perm_audit, active)
      SELECT '${SUPPORT}', 'QA Support', '${SUPPORT_HANDLE}', password_hash, 'support', false,
             false, true, true, true, false, false, false, false, false, true
        FROM platform_admin WHERE id = '${PLATFORM_ANALYST}'
      ON CONFLICT (id) DO UPDATE SET perm_analytics = false, perm_salons = true, active = true;
    `);

    try {
      precondition(
        scalar(`select count(*) from platform_admin where id='${SUPPORT}'`).trim() === '1',
        'the support fixture was not created',
      );

      /**
       * `Fresh`: this admin is upserted four statements above and DELETEd in the
       * `finally`, so she must not outlive the test in the run's session cache.
       */
      const support = await signInPlatformFresh(SUPPORT_HANDLE);

      // THE LIST: yes. Under the old gating this preset could NOT read it — holding
      // `salons` bought the create and not the roster it creates into.
      const list = await treq('GET', '/v1/platform/salons?limit=5', { token: support });
      expect(list.status, `support cannot read the roster it maintains: ${list.raw}`).toBe(200);
      expect(Array.isArray(list.body.items)).toBe(true);

      // THE METRICS: no. Exactly inverted from the analyst above, which is what makes
      // these two gates two gates rather than one with a second name.
      const metrics = await treq('GET', '/v1/platform/metrics', { token: support });
      expect(
        metrics.status,
        `support read the platform's aggregate money without analytics: ${metrics.raw}`,
      ).toBe(403);
      expect(metrics.body?.error).toBe('forbidden');
    } finally {
      psql(`DELETE FROM platform_admin WHERE id = '${SUPPORT}';`);
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
describe('The happy path, and everything it creates at once', () => {
  it('creates the salon, its first branch, its owner, an invite and two audit rows', async () => {
    const name = uniqueName('Happy');
    const res = await create(validBody(name), uniqueKey('happy'));
    expect(res.status, `onboarding failed: ${res.raw}`).toBe(201);

    const id = remember(res);
    expect(id, `the response carries no salon id: ${res.raw}`).toBeTruthy();

    /*
     * ALL FIVE, COUNTED. This is the atomicity assertion in its observable form:
     * the transaction either produced every one of these or none, and a partial
     * state would show up as one of these counts being wrong while the others are
     * right.
     */
    expect(num(`select count(*) from salon where id='${id}'`), 'no salon row').toBe(1);
    expect(num(`select count(*) from branch where salon_id='${id}'`), 'no first branch').toBe(1);
    expect(
      num(`select count(*) from staff_user where salon_id='${id}' and role='owner'`),
      'no owner account',
    ).toBe(1);
    expect(
      num(`select count(*) from staff_password_reset where salon_id='${id}'`),
      'no invite outbox row',
    ).toBe(1);
    expect(
      num(`select count(*) from audit_log where salon_id='${id}'`),
      'the two audit rows (rules + access) are not both there',
    ).toBe(2);
    expect(
      num(`select count(distinct kind) from audit_log where salon_id='${id}'`),
      'both audit rows were filed under one kind, so one is invisible under the other filter',
    ).toBe(2);
  }, 60_000);

  it('the owner account holds every permission and NO credential (non-negotiable #6)', async () => {
    const name = uniqueName('Owner');
    const res = await create(validBody(name), uniqueKey('owner'));
    expect(res.status, res.raw).toBe(201);
    const id = remember(res);

    // Both hashes NULL: the console never sets a password, it sends a link.
    expect(
      num(
        `select count(*) from staff_user where salon_id='${id}'
           and (password_hash is not null or pin_hash is not null)`,
      ),
      'the onboarding created a credential rather than an invite',
    ).toBe(0);

    /*
     * AND THE RESPONSE REPORTS THE ABSENCE RATHER THAN CARRYING A CREDENTIAL.
     *
     * The first draft of this line was `expect(res.raw).not.toMatch(/password/i)`,
     * which failed — on `"passwordSet": false`, a field that is #6 being honest: it
     * tells the console there is no password yet so it can draw "invite sent"
     * instead of a reset button. A regex over the raw body cannot tell a credential
     * from a statement about one, and the broad version would have had to be
     * loosened the moment anything legitimately mentioned the word.
     *
     * So the assertion is on the shape instead: the flag must be present and false,
     * and no HASH-shaped field may appear.
     */
    expect(res.body?.owner?.passwordSet, 'the response does not say whether a password exists').toBe(
      false,
    );
    expect(res.raw, 'a credential hash is in the response').not.toMatch(
      /passwordHash|pinHash|password_hash|pin_hash|\$argon2/i,
    );

    // The ladder arrived complete, which is what lets one INSERT satisfy
    // `salon_loyalty_config_complete`.
    expect(
      num(`select count(*) from salon where id='${id}' and loyalty_mode is not null`),
      'the salon has no loyalty mode, so the config landed incomplete',
    ).toBe(1);
  }, 60_000);

  it('no salon this endpoint created is missing a dependent row — a partial state is unreachable', async () => {
    precondition(createdSalons.size > 0, 'nothing has been created yet, so this scan is vacuous');
    const ids = [...createdSalons].map((i) => `'${i}'`).join(',');

    /*
     * The converse of the per-salon counts above, asked as one question over every
     * salon this file made: is there ANY of them lacking a branch, an owner or an
     * invite? A transaction that could half-commit would eventually produce one.
     */
    const orphans = num(`
      select count(*) from salon s
       where s.id in (${ids})
         and (
           not exists (select 1 from branch b where b.salon_id = s.id)
           or not exists (select 1 from staff_user u where u.salon_id = s.id and u.role = 'owner')
           or not exists (select 1 from staff_password_reset r where r.salon_id = s.id)
         )
    `);
    expect(orphans, 'a salon exists without its branch, owner or invite').toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('Double submit — one wizard, two clicks', () => {
  it('two OVERLAPPING requests under one key create exactly one salon', async () => {
    const name = uniqueName('DoubleSubmit');
    const key = uniqueKey('double');
    const body = validBody(name);
    const before = num(`select count(*) from salon`);

    /*
     * THE OVERLAP IS MEASURED, NOT ASSUMED — and this is the assertion that makes
     * the rest of the spec mean anything.
     *
     * `Promise.all` does not guarantee concurrency: if the first request completed
     * before the second was written to the socket, the two would be sequential and
     * the "one salon" result below would be evidence of nothing at all — two
     * sequential creates under one key also produce one salon. A conditional INSERT
     * and a SELECT-then-INSERT are indistinguishable from outside unless the
     * requests were actually in flight together.
     *
     * So each call records its own wall-clock interval and the INTERSECTION of the
     * two is required to be positive before anything is concluded.
     */
    const fire = async () => {
      const start = performance.now();
      const res = await create(body, key);
      return { res, start, end: performance.now() };
    };
    const [a, b] = await Promise.all([fire(), fire()]);

    const overlapMs = Math.min(a.end, b.end) - Math.max(a.start, b.start);
    expect(
      overlapMs,
      `the two requests did not overlap (a: ${a.start.toFixed(1)}–${a.end.toFixed(1)}ms, ` +
        `b: ${b.start.toFixed(1)}–${b.end.toFixed(1)}ms). They ran in sequence, so the ` +
        `single-salon outcome below says nothing about the guard.`,
    ).toBeGreaterThan(0);

    /*
     * A NEGATIVE CONTROL PROVED THIS LINE IS LOAD-BEARING, and it is worth writing
     * down because the result was the whole reason for the line. Replacing the
     * `Promise.all` above with `await fire(); await fire();` made the two requests
     * strictly sequential — a: 3367.5–3407.4ms, b: 3407.4–3419.3ms, overlap
     * −0.003ms — and this assertion failed by name, as it should.
     *
     * The important half: EVERY OTHER ASSERTION IN THIS SPEC STILL PASSED under the
     * sequential run. One salon, one owner, one branch, one invite, both callers
     * answered. So without this line the spec would have reported a confident green
     * for a concurrency guard it never exercised.
     */
    remember(a.res);
    remember(b.res);

    // ---- the outcome, now that it is about concurrency.
    const created = num(`select count(*) from salon where name = '${name}'`);
    expect(
      created,
      `two salons were created from one key with ${overlapMs.toFixed(2)}ms of genuine overlap`,
    ).toBe(1);
    expect(num(`select count(*) from salon`) - before, 'more than one salon appeared').toBe(1);

    /*
     * Both callers get an answer they can use. One is the winner's 201; the other is
     * either the replayed 201 or a named 409 telling the wizard to retry — what must
     * not happen is a 500, or one caller getting a success for a salon that does not
     * exist.
     */
    for (const { res } of [a, b]) {
      expect([201, 409], `a caller got ${res.status}: ${res.raw}`).toContain(res.status);
      if (res.status === 409) {
        expect(res.body?.error, 'the loser got an unnamed conflict').toBeTruthy();
        expect(res.body?.error).not.toBe('server_error');
      }
    }

    // Exactly one of the dependent-row sets, too — a second owner credential on a
    // tenant would be the real damage.
    const id = scalar(`select id from salon where name = '${name}'`).trim();
    createdSalons.add(id);
    expect(num(`select count(*) from staff_user where salon_id='${id}'`), 'two owner accounts').toBe(1);
    expect(num(`select count(*) from branch where salon_id='${id}'`), 'two first branches').toBe(1);
    expect(num(`select count(*) from staff_password_reset where salon_id='${id}'`), 'two invites').toBe(1);
  }, 60_000);

  it('a sequential retry under the same key replays rather than creating a second salon', async () => {
    const name = uniqueName('Replay');
    const key = uniqueKey('replay');
    const body = validBody(name);

    const first = await create(body, key);
    expect(first.status, first.raw).toBe(201);
    remember(first);

    const second = await create(body, key);
    expect(second.status, `the retry answered ${second.status}: ${second.raw}`).toBe(201);
    expect(
      second.body,
      'the retry recomputed a response instead of replaying the stored one',
    ).toEqual(first.body);

    expect(num(`select count(*) from salon where name = '${name}'`), 'the retry made a second salon').toBe(1);
  }, 60_000);

  it('the same key with a DIFFERENT body is refused, not answered with the first salon', async () => {
    const key = uniqueKey('conflict');
    const first = await create(validBody(uniqueName('KeyA')), key);
    expect(first.status, first.raw).toBe(201);
    remember(first);

    const second = await create(validBody(uniqueName('KeyB')), key);
    expect(
      second.status,
      `a different body under a spent key answered ${second.status}: ${second.raw}`,
    ).toBe(422);
    expect(second.body?.error, 'the refusal is unnamed').toBeTruthy();
  }, 60_000);

  it('a keyless create is refused before anything is written (non-negotiable #4)', async () => {
    const before = num(`select count(*) from salon`);
    const res = await treq('POST', '/v1/platform/salons', {
      token: owner,
      body: validBody(uniqueName('Keyless')),
    });
    expect(res.status, `a keyless create answered ${res.status}: ${res.raw}`).toBe(400);
    expect(res.body?.error).toBe('idempotency_key_required');
    expect(num(`select count(*) from salon`), 'the keyless create still made a salon').toBe(before);
  }, 60_000);
});

// ---------------------------------------------------------------------------
describe('A refused create writes no row, and does not burn the key', () => {
  /**
   * Validation runs before `db.transaction` opens. Both halves matter, and the
   * second is the one a wizard depends on: a merchant who mistypes a hex, gets a
   * 400, fixes it and resubmits is retrying with the SAME Idempotency-Key. If the
   * failed attempt burnt the key, the corrected submission answers 422 for ever and
   * the wizard is wedged.
   */
  it('a non-viable brandColor is refused, creates nothing, and leaves the key reusable', async () => {
    const key = uniqueKey('reuse');
    const name = uniqueName('Reuse');
    const before = num(`select count(*) from salon`);

    // #FFFF00 tops out at 4.25:1 — under #9's floor. Same guard as the update door.
    const bad = await create(validBody(name, { brandColor: '#FFFF00' }), key);
    expect(bad.status, `a non-viable hex was accepted: ${bad.raw}`).toBe(400);
    expect(bad.body?.error).toBe('brand_color_not_viable');
    expect(bad.body?.bestContrast, 'the refusal does not carry the measured contrast').toBeLessThan(4.5);
    expect(num(`select count(*) from salon`), 'the refused create made a salon').toBe(before);

    // THE SECOND HALF. Same key, corrected colour.
    const good = await create(validBody(name, { brandColor: '#6E7F6C' }), key);
    expect(
      good.status,
      `the corrected resubmission under the same key answered ${good.status} — the failed ` +
        `attempt burnt the key and the wizard cannot recover. Response: ${good.raw}`,
    ).toBe(201);
    remember(good);
  }, 60_000);

  it('a malformed hex is refused at the create door too, with the shape code', async () => {
    const res = await create(validBody(uniqueName('BadHex'), { brandColor: 'periwinkle' }), uniqueKey('badhex'));
    expect(res.status, res.raw).toBe(400);
    expect(res.body?.error).toBe('invalid_brand_color');
  }, 60_000);

  it('an unknown field is named rather than ignored', async () => {
    const res = await create(
      validBody(uniqueName('Unknown'), { isLive: true, suspended: false }),
      uniqueKey('unknown'),
    );
    expect(res.status, `an unknown field was silently dropped: ${res.raw}`).toBe(400);
    expect(res.body?.error).toBe('not_settable_here');
    // The design draws a Live toggle the schema has no column for; a create that
    // accepted and discarded it would report success for a setting that vanished.
    expect(res.body?.message, 'the refusal does not say which fields').toMatch(/isLive|suspended/);
  }, 60_000);

  describe('money is integer fils on the deposit (non-negotiable #1)', () => {
    for (const [label, value] of [
      ['a float', 5500.5],
      ['a string', '5000'],
      ['below the floor', 999],
      ['above the ceiling', 10_001],
      ['negative', -5000],
      ['NaN-ish', null],
    ] as Array<[string, unknown]>) {
      it(`${label} (${JSON.stringify(value)}) is refused through the real validator`, async () => {
        const before = num(`select count(*) from salon`);
        const res = await create(
          validBody(uniqueName('Deposit'), { depositFils: value }),
          uniqueKey('deposit'),
        );
        expect(
          res.status,
          `depositFils ${JSON.stringify(value)} was accepted: ${res.raw}`,
        ).toBe(400);
        expect(res.body?.error, 'no float ever reaches a money column, but the refusal must be named').not.toBe(
          'server_error',
        );
        expect(num(`select count(*) from salon`), 'a bad deposit still created a salon').toBe(before);
      }, 60_000);
    }

    it('and a valid deposit is stored as an integer number of fils', async () => {
      const res = await create(
        validBody(uniqueName('DepositOk'), { depositFils: 7000 }),
        uniqueKey('depositok'),
      );
      expect(res.status, res.raw).toBe(201);
      const id = remember(res);
      expect(
        scalar(`select deposit_fils from salon where id='${id}'`).trim(),
        'the deposit did not round-trip as an integer',
      ).toBe('7000');
    }, 60_000);
  });
});

// ---------------------------------------------------------------------------
describe('The invite exists and claims no delivery', () => {
  it('the outbox row is there, unsent, and the token is stored only as a hash', async () => {
    const res = await create(validBody(uniqueName('Invite')), uniqueKey('invite'));
    expect(res.status, res.raw).toBe(201);
    const id = remember(res);

    expect(num(`select count(*) from staff_password_reset where salon_id='${id}'`)).toBe(1);

    // NOTHING CLAIMS DELIVERY — no sender is wired, and the honest record of that
    // is a NULL rather than a timestamp nobody wrote.
    expect(
      scalar(`select sent_at is null from staff_password_reset where salon_id='${id}'`).trim(),
      'sent_at is set, so something is claiming an invite was delivered',
    ).toBe('t');

    // The hash is 64 hex characters and the raw token is nowhere — the same
    // discipline session refresh tokens and wallet tokens get.
    expect(
      num(`select length(token_hash) from staff_password_reset where salon_id='${id}'`),
      'the invite token is not stored as a sha256 digest',
    ).toBe(64);

    // AND NO ENDPOINT RETURNS IT. #6's shape: the console sends a link, it never
    // shows one.
    expect(res.raw, 'the create response carries the invite token').not.toMatch(/token/i);
    expect(res.body?.delivered, 'the response claims delivery').toBeFalsy();
  }, 60_000);
});

// ---------------------------------------------------------------------------
describe('`ownerPhone` is stored and never served', () => {
  const PHONE = '+96555512345';

  it('the column holds it, and no salon payload does — on any surface', async () => {
    const res = await create(
      validBody(uniqueName('Phone'), { ownerPhone: PHONE }),
      uniqueKey('phone'),
    );
    expect(res.status, res.raw).toBe(201);
    const id = remember(res);

    // It really was stored, or the absence assertions below are vacuous.
    expect(
      scalar(`select owner_phone from salon where id='${id}'`).trim(),
      'ownerPhone was not stored, so nothing below is a disclosure test',
    ).toBe(PHONE);

    /*
     * THE CREATE RESPONSE IS ALLOWED TO ECHO IT, and asserting otherwise was this
     * spec's first draft failing for the right reason. The body carries
     * `invite: { channel: 'whatsapp', to: '+965…' }` — the destination the console
     * admin just typed into the wizard, confirmed back so she can see where the
     * invite is going. The caller supplied the value and holds the `salons` section.
     * Refusing to echo it would be a rule this file invented.
     *
     * The rule that DOES exist is about the SALON ENTITY, and it is asserted below
     * where it bites.
     */
    expect(res.body?.invite?.to, 'the console cannot see where the invite went').toBe(PHONE);

    // The salon entity in the create response must not carry it, though — that is
    // the same serialiser the member-facing GET uses.
    expect(res.body?.salon?.ownerPhone, 'ownerPhone is a serialised salon field').toBeUndefined();

    // And the platform list, the other place a salon is serialised for a console.
    const list = await treq('GET', '/v1/platform/salons?limit=100', { token: owner });
    expect(list.status, list.raw).toBe(200);
    expect(list.raw.includes(PHONE), 'the platform salon list carries the owner phone').toBe(false);
  }, 60_000);

  /**
   * THE ASSERTION THAT ACTUALLY TESTS THE CLAIM, AND THE FIRST VERSION DID NOT.
   *
   * The claim is "a member-readable salon must not carry the owner's phone". Testing
   * it needs BOTH halves at once: a salon whose `owner_phone` is populated, AND a
   * member of that salon reading it. The first draft used the platform-owner token
   * against a new salon, which proves nothing about members; and pointing a member
   * at a SEEDED salon proves nothing either, because migration 0037 added the column
   * after the seed was written and every seeded salon has NULL there. Either way the
   * assertion passes while the disclosure path is never exercised — a vacuous green
   * of exactly the kind this file's siblings were written to avoid.
   *
   * So the column is populated on salon B, which has a real member who can sign in,
   * and restored afterwards.
   */
  it('a MEMBER reading her own salon does not receive the owner phone', async () => {
    const before = scalar(`select coalesce(owner_phone, '') from salon where id='${SALON_B}'`).trim();
    precondition(before === '', `salon B already has an owner phone (${before}); not overwriting it`);

    psql(`UPDATE salon SET owner_phone = '${PHONE}' WHERE id = '${SALON_B}';`);
    try {
      // The column really is populated, or everything below is vacuous.
      expect(
        scalar(`select owner_phone from salon where id='${SALON_B}'`).trim(),
        'the fixture did not take, so this spec is not a disclosure test',
      ).toBe(PHONE);

      /*
       * `GET /salons/{id}` IS NOT PERMISSION-GATED — routes/salons.ts says so
       * explicitly, because the customer wallet renders the salon name, brand
       * colour, business hours and social links. So a MEMBER reads this exact
       * payload, and the owner's personal mobile must not be in it.
       */
      const member = await signInMember(SALON_B, B_MEMBER_PHONE);
      const asMember = await treq('GET', `/salons/${SALON_B}`, { token: member });
      expect(asMember.status, asMember.raw).toBe(200);

      /*
       * THE KNOWN-POSITIVE BEFORE THE ABSENCE. `raw.includes(...)` returning false
       * is a claim about the haystack until the haystack has been shown to contain
       * something — an empty body, or a `raw` that was never populated, would make
       * the next line pass for ever. So the sweep is first pointed at a value that
       * IS in the payload.
       */
      expect(
        asMember.raw.includes(asMember.body.name),
        'the raw-body sweep cannot find a value that is definitely present, so the ' +
          'absence assertion below would pass vacuously',
      ).toBe(true);

      expect(
        asMember.raw.includes(PHONE),
        "a member of the salon can read the owner's personal mobile from GET /salons/{id}",
      ).toBe(false);
      expect(asMember.body?.ownerPhone, 'ownerPhone is serialised to members').toBeUndefined();

      // The wallet-facing fields ARE still there, so this is not passing because the
      // payload came back empty or the read failed.
      expect(asMember.body?.name, 'the salon payload is empty, so the absence proves nothing').toBeTruthy();
      expect(asMember.body?.brandColor, 'the wallet has no brand colour to theme with').toBeTruthy();
      expect(asMember.body?.businessHours, 'the wallet has no hours').toBeTruthy();
    } finally {
      psql(`UPDATE salon SET owner_phone = NULL WHERE id = '${SALON_B}';`);
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
describe('A brand-new salon is isolated the moment it exists', () => {
  /**
   * THE POINT OF DOING THIS HERE rather than adding cases to `tenancy.test.ts`: that
   * file's census drives salon A against salon B, two SEEDED tenants. A salon
   * created at runtime is the case nobody has driven, and a tenancy check that keyed
   * off something the seed establishes — a fixture list, a hardcoded pair — would
   * pass for the seeded salons and be silent about every real client.
   */
  it('a salon-B manager cannot read it, and a real id answers exactly as an invented one', async () => {
    const res = await create(validBody(uniqueName('Isolated')), uniqueKey('isolated'));
    expect(res.status, res.raw).toBe(201);
    const id = remember(res)!;

    const layla = await signInDashboard(SALON_B, B_STAFF_HANDLE);

    const foreign = await treq('GET', `/salons/${id}`, { token: layla });
    const invented = await treq('GET', '/salons/SAL-DOES-NOT-EXIST-AT-ALL', { token: layla });

    expect(foreign.status, `a salon-B manager read the new tenant: ${foreign.raw}`).toBe(403);

    /*
     * AND THE TWO ARE INDISTINGUISHABLE. If a real-but-foreign id answered 403 while
     * an invented one answered 404, the pair would be an existence oracle: an
     * outsider could enumerate AVO's client list by watching which ids refuse
     * differently. This is the assertion the salon-scoped census makes for every
     * seeded route, applied to a salon that did not exist a second ago.
     */
    expect(
      { status: invented.status, error: invented.body?.error },
      `a real foreign salon and an invented one answer differently — that difference is an ` +
        `existence oracle over AVO's client list. real: ${foreign.status}/${foreign.body?.error}, ` +
        `invented: ${invented.status}/${invented.body?.error}`,
    ).toEqual({ status: foreign.status, error: foreign.body?.error });

    // The new salon's own owner is not reachable as a salon-B staff row either.
    expect(
      num(`select count(*) from staff_user where salon_id='${SALON_B}' and id in
             (select id from staff_user where salon_id='${id}')`),
      'the new owner account leaked into salon B',
    ).toBe(0);
  }, 60_000);
});
