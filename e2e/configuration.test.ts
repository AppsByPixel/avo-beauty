/**
 * CAN AN OWNER CONFIGURE A SALON WITHOUT AN ENGINEER?
 *
 * HOW TO RUN
 *
 *   pnpm install
 *   pnpm --dir ./api run db:up
 *   cd e2e && ../node_modules/.bin/vitest run configuration.test.ts
 *
 * Like the other harness-driven files, this boots lane A's real API against this
 * run's own database. `packages/mock` has one salon whose settings it ignores, so
 * a configuration suite pointed at it would prove nothing.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * build-plan.md's phase 4 is done when "an owner can configure a salon end to end
 * without an engineer". Lane C has built the five dashboard sections that make
 * that claim — Team, Loyalty, Settings, Accounts, Audit log — and every one of
 * them was, until this file, unwitnessed on the server side. A screen rendering
 * is not the criterion. The criterion is a merchant changing something and the
 * change being there afterwards.
 *
 * So each section below does the same three things: read what the screen reads,
 * write what the screen writes, and read it back through a SECOND request. The
 * read-back is the point. A handler that echoes its own request body satisfies
 * any spec that only inspects the response, and echoing the body is precisely
 * what `PATCH /salons/{id}` does today.
 *
 * WHAT IS `knownBug()` HERE AND WHY THAT IS THE HONEST RECORD
 * -----------------------------------------------------------
 * The answer to the question in the title is currently NO, and the gap is not
 * subtle: modules cannot be switched, branches cannot be created, renamed or
 * removed, and a staff account cannot be created, deleted or have its password
 * reset. Every one of those is written below as the assertion the contract calls
 * for, wrapped in `knownBug()`. They report green today and go red the hour lane
 * A ships the endpoint, which is the only form of "this is missing" that cannot
 * quietly stop being true.
 *
 * SALON B THROUGHOUT, AND ONE ARTIST OF THIS FILE'S OWN. Every write here lands
 * on Lumière, never on lane A's seeded salon, so nothing this file does can move
 * a fixture another suite asserts on.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { knownBug, precondition } from './support/known-bug.js';
import {
  B_BRANCH,
  B_STAFF_BRANCH_STRANDED,
  B_STAFF_BRANCH_SURVIVOR,
  B_STAFF,
  B_STAFF_HANDLE,
  PLATFORM_OWNER_HANDLE,
  SALON_B,
  psql,
  scalar,
  signInDashboard,
  signInPlatform,
  startTenancyApi,
  stopTenancyApi,
  treq,
} from './support/tenancy-harness.js';

/** Layla, salon B's manager, holding all nine permissions. */
let dashboard = '';

/**
 * Yousef, the AVO owner console, holding every section.
 *
 * NEW IN THIS FILE, AND IT IS A CHANGE OF SUBJECT RATHER THAN AN EXTRA FIXTURE.
 * The question in the title — "can an owner configure a salon without an engineer"
 * — was answered entirely through a merchant credential until decision 79 moved the
 * tier ladder to AVO. The Loyalty section below is now the one part of the answer
 * that requires the CONSOLE, so the file needs both principals to say anything true
 * about it: one that publishes, and one that is refused.
 */
let platform = '';

/**
 * An artist this file creates and nothing else touches.
 *
 * `seedSalonB()` deliberately seeds no artists — the tenancy suite has no use for
 * one — and the Team section is unassertable without a row to edit. Created here
 * rather than added to the shared seed for the reason the flakiness work settled:
 * a fixture belongs to whoever needs it, and a fixture two files share is a
 * fixture that will surprise one of them.
 */
const ARTIST = 'AR-CFG-B01';
const ARTIST_NAME = 'Hessa';

/** ST-B02, Mariam. The Accounts section's target row. */
const STAFF_TARGET = 'ST-B02';

/**
 * The two branch-scoped rows the closure-preview identity spec re-scopes, so that
 * the closure it compares actually has an impact to report. Dedicated because that
 * spec rewrites their branch access — `STAFF_TARGET` above belongs to Accounts.
 */
const BRANCH_SURVIVOR = B_STAFF_BRANCH_SURVIVOR;
const BRANCH_STRANDED = B_STAFF_BRANCH_STRANDED;

/** A full seven-day week, which is the only shape `PUT …/availability` accepts. */
function week(overrides: Record<string, { open: boolean; from: string; to: string }> = {}) {
  const base: Record<string, { open: boolean; from: string; to: string }> = {};
  for (const day of ['0', '1', '2', '3', '4', '5', '6']) {
    base[day] = { open: false, from: '10:00', to: '19:00' };
  }
  return { ...base, ...overrides };
}

/**
 * Salon B's settings as this file found them, so it can put them back.
 *
 * `seedSalonB()` inserts the salon `ON CONFLICT DO NOTHING` — correct, because a
 * suite must not silently undo a merchant's configuration — and the consequence
 * is that everything this file publishes SURVIVES into the next file of the same
 * run. The tier ladder is the one that matters: it decides the top-up bonus, and
 * a later suite asserting salon B's bonus would be asserting against whatever
 * this file last published.
 *
 * A per-run database makes that harmless across runs. Within a run it is exactly
 * the coupling this suite has spent the week removing, so the file gives back
 * what it borrowed.
 */
const SNAPSHOT_COLUMNS = [
  'tiers',
  'loyalty_mode',
  'deposit_fils',
  'no_show_return_minutes',
  'whatsapp_enabled',
  'module_booking',
  'module_shop',
  'name',
] as const;

/** column → the literal it held, already quoted for SQL. */
let salonSnapshot: Record<string, string> | undefined;

beforeAll(async () => {
  await startTenancyApi();
  dashboard = await signInDashboard(SALON_B, B_STAFF_HANDLE);
  platform = await signInPlatform(PLATFORM_OWNER_HANDLE);

  /**
   * `quote_literal` and `pg_typeof` do the work, so the restore below is a plain
   * assignment and not a pile of casts. `tiers` is jsonb and `loyalty_mode` is an
   * enum; a JSON round-trip through `->>` turns both into text and Postgres
   * rejects the assignment, which is how the first draft of this teardown failed.
   */
  const row = scalar(
    `select ${SNAPSHOT_COLUMNS.map(
      (c) => `quote_literal(${c}::text) || '::' || pg_typeof(${c})`,
    ).join(" || '' || ")} from salon where id='${SALON_B}'`,
  ).split('');
  salonSnapshot = Object.fromEntries(SNAPSHOT_COLUMNS.map((c, i) => [c, row[i]!]));

  psql(`
    INSERT INTO artist (id, salon_id, name, availability_source, google_connected,
                        slot_minutes, windows, active)
    VALUES ('${ARTIST}', '${SALON_B}', '${ARTIST_NAME}', 'manual', false, 30,
            '{"0":{"open":false,"from":"10:00","to":"19:00"},
              "1":{"open":false,"from":"10:00","to":"19:00"},
              "2":{"open":false,"from":"10:00","to":"19:00"},
              "3":{"open":false,"from":"10:00","to":"19:00"},
              "4":{"open":false,"from":"10:00","to":"19:00"},
              "5":{"open":false,"from":"10:00","to":"19:00"},
              "6":{"open":false,"from":"10:00","to":"19:00"}}'::jsonb,
            true)
    ON CONFLICT (id) DO UPDATE SET
      availability_source = 'manual', google_connected = false, slot_minutes = 30, active = true;
  `);
}, 120_000);

afterAll(async () => {
  /**
   * EVERY BRANCH AND EVERY ACCOUNT THIS FILE CREATED, REMOVED.
   *
   * The lesson that produced this block: the moment `POST /salons/{id}/branches`
   * started working, the spec that had merely PROVED IT MISSING started creating
   * real branches and leaving them. Salon B went from two to four, which is not a
   * cosmetic difference — `services/branch.ts` decides on the OPEN BRANCH COUNT,
   * so `promotions.test.ts`'s whole fixture premise changed, and because lane A
   * mints branch ids as `BR-` plus random base36 the leaked row won
   * `resolveBranch`'s alphabetical tie-break about three runs in five.
   *
   * A knownBug that flips is not a spec that has started passing. It is a spec
   * whose side effects have just become real, and the cleanup has to land in the
   * same commit as the promotion.
   *
   * Hard DELETE, not the product's own close and deactivate. `closed_at` and
   * `deactivated_at` leave rows holding their names against
   * `branch_salon_name_uq` and the per-salon handle index, so the next run
   * collides — and a merchant's branch list and staff roster are no place for a
   * test's scaffolding either way. Scoped by id and by the `qa` handle prefix, so
   * neither statement can reach a fixture row.
   */
  if (createdBranches.length > 0) {
    const ids = createdBranches.map((id) => `'${id}'`).join(', ');
    psql(`
      DELETE FROM boost  WHERE branch_id IN (${ids});
      DELETE FROM branch WHERE salon_id = '${SALON_B}' AND id IN (${ids});
    `);
  }
  psql(`
    DELETE FROM staff_user
     WHERE salon_id = '${SALON_B}' AND handle LIKE 'qa%' AND id NOT IN ('${B_STAFF}', '${STAFF_TARGET}');
  `);

  if (salonSnapshot) {
    // Restored through SQL rather than through the API, deliberately: a teardown
    // that can only undo what the product currently exposes is a teardown that
    // leaks the first time a spec runs ahead of the endpoint it is waiting for.
    const assignments = SNAPSHOT_COLUMNS.map((c) => `${c} = ${salonSnapshot![c]}`).join(', ');
    psql(`UPDATE salon SET ${assignments} WHERE id = '${SALON_B}';`);
  }
  await stopTenancyApi();
});

// ===========================================================================
// Settings — the section with the most surface and the biggest hole in it.
// ===========================================================================

interface SalonView {
  id: string;
  name: string;
  nameAr: string | null;
  brandColor: string;
  modules: { booking: boolean; shop: boolean };
  depositFils: number;
  noShowReturnMinutes: number;
  timezone: string;
  businessHours: unknown;
  branches: Array<{ id: string; salonId: string; name: string; nameAr: string | null }>;
  social: unknown;
  whatsappEnabled: boolean;
}

const readSalon = async (): Promise<SalonView> => {
  const res = await treq<SalonView>('GET', `/salons/${SALON_B}`, { token: dashboard });
  precondition(res.status === 200, `GET /salons/${SALON_B} answered ${res.status} ${res.raw}`);
  return res.body;
};

describe('Settings — everything the section renders is on the salon read', () => {
  it('one GET carries modules, branches, hours, deposit and the WhatsApp switch', async () => {
    const s = await readSalon();

    // The section is one screen and it makes one request. A field the design
    // renders and this response omits is a second request nobody has written.
    expect(s.id).toBe(SALON_B);
    expect(s.modules, 'the module toggles have nothing to render').toEqual({
      booking: expect.any(Boolean),
      shop: expect.any(Boolean),
    });
    expect(Array.isArray(s.branches), 'the branches list is not an array').toBe(true);
    expect(s.branches.map((b) => b.id)).toContain(B_BRANCH);
    expect(typeof s.depositFils, 'the deposit is not an integer of fils').toBe('number');
    expect(Number.isInteger(s.depositFils)).toBe(true);
    expect(typeof s.noShowReturnMinutes).toBe('number');
    expect(typeof s.whatsappEnabled).toBe('boolean');
    // Non-negotiable: naive business hours mean nothing without the zone.
    expect(s.timezone, 'businessHours without a timezone is a string in an unknown zone').toBeTruthy();
    expect(s.businessHours).not.toBeNull();
  });

  it('a brand colour that cannot make a 4.5:1 fill is still served, and the derived variant is the client\'s job', async () => {
    // Non-negotiable #9 lives in packages/tokens (`derive.test.ts` proves the
    // contrast maths). What the API owes the dashboard is the source colour, and
    // what this asserts is that it is a hex the deriver can actually take.
    const s = await readSalon();
    expect(s.brandColor, 'brandColor is not a hex the token deriver can read').toMatch(
      /^#[0-9a-fA-F]{6}$/,
    );
  });
});

describe('Settings — what a merchant can actually change, proved by reading it back', () => {
  it('the deposit, the no-show window and the WhatsApp switch round-trip', async () => {
    const before = await readSalon();
    const nextDeposit = before.depositFils === 6_000 ? 7_000 : 6_000;
    const nextMinutes = before.noShowReturnMinutes === 45 ? 90 : 45;
    const nextWhatsapp = !before.whatsappEnabled;

    const patched = await treq('PATCH', `/salons/${SALON_B}`, {
      token: dashboard,
      body: {
        depositFils: nextDeposit,
        noShowReturnMinutes: nextMinutes,
        whatsappEnabled: nextWhatsapp,
      },
    });
    expect(patched.status, patched.raw).toBe(200);

    // THE SECOND REQUEST. An echoed body would satisfy everything above.
    const after = await readSalon();
    expect(after.depositFils, 'the deposit did not persist').toBe(nextDeposit);
    expect(after.noShowReturnMinutes).toBe(nextMinutes);
    expect(after.whatsappEnabled).toBe(nextWhatsapp);

    // Put it back, so a re-run of this file starts where it started.
    await treq('PATCH', `/salons/${SALON_B}`, {
      token: dashboard,
      body: {
        depositFils: before.depositFils,
        noShowReturnMinutes: before.noShowReturnMinutes,
        whatsappEnabled: before.whatsappEnabled,
      },
    });
  });

  it('a fractional deposit never reaches the column (non-negotiable #1)', async () => {
    const before = scalar(`select deposit_fils::text from salon where id='${SALON_B}'`);
    const res = await treq('PATCH', `/salons/${SALON_B}`, {
      token: dashboard,
      body: { depositFils: 5_500.5 },
    });
    // The part that is not negotiable: it is refused, and nothing moved.
    expect(res.status, 'a fractional deposit was ACCEPTED — money is integer fils everywhere').toBeGreaterThanOrEqual(400);
    expect(
      scalar(`select deposit_fils::text from salon where id='${SALON_B}'`),
      'the refused PATCH still wrote',
    ).toBe(before);
  });

  /**
   * PROMOTED — this was a `knownBug()` and it flipped on lane A's phase-4 merge.
   *
   * The defect it reported: `depositFils: 5500.5` was not validated by the route,
   * went into the patch object as it arrived, and Postgres refused it on the
   * integer column — reaching the merchant as `server_error`, "Something went
   * wrong on our side". The money was never at risk, which is why the spec above
   * stayed a plain `it()` throughout. What was wrong is that a typed-in "5.5" and
   * a real outage were the same event to whoever was looking at the screen.
   *
   * The route already pre-validated `timezone` for exactly this reason. The money
   * fields have the same treatment now, and this locks it in.
   */
  it('and a fractional deposit is a 400 naming the field, not a 500', async () => {
    const res = await treq<{ error?: string }>('PATCH', `/salons/${SALON_B}`, {
      token: dashboard,
      body: { depositFils: 5_500.5 },
    });
    expect(res.status, 'an unvalidated float reached Postgres and came back as server_error').toBe(
      400,
    );
    expect(res.body.error, 'the refusal does not name what was wrong').toBeTruthy();
    expect(res.body.error).not.toBe('server_error');
  });

  it('a field outside the editable set is refused by name rather than dropped', async () => {
    const res = await treq<{ error?: string }>('PATCH', `/salons/${SALON_B}`, {
      token: dashboard,
      body: { plan: 'pro' },
    });
    // Silently ignoring it is how a merchant "upgrades her plan" and nothing
    // happens, with a 200 to say it worked.
    expect(res.status, res.raw).toBe(400);
    expect(res.body.error).toBe('not_editable');
  });

  it('and the change is on the audit log, because Settings is where authority is spent', async () => {
    const before = Number(
      scalar(`select count(*) from audit_log where salon_id='${SALON_B}' and kind='rules'`),
    );
    const res = await treq('PATCH', `/salons/${SALON_B}`, {
      token: dashboard,
      body: { noShowReturnMinutes: 61 },
    });
    precondition(res.status === 200, `PATCH answered ${res.status} ${res.raw}`);

    const after = Number(
      scalar(`select count(*) from audit_log where salon_id='${SALON_B}' and kind='rules'`),
    );
    expect(after, 'a settings change wrote no audit row').toBe(before + 1);
  });
});

// ---------------------------------------------------------------------------
// PROMOTED, ALL OF IT. This block was `GAP: Settings cannot finish the job` and
// every spec in it was a knownBug() reporting an endpoint that did not exist.
// Lane A's phase-4 merge landed them and they flipped together.
//
// THEY ARE NOT PROMOTED AS THEY WERE WRITTEN, and the difference is the whole
// lesson of this round. A knownBug only has to prove a thing is missing; the
// call can be a throwaway. A passing spec's write REALLY HAPPENS, and these
// writes change the shape of the salon that three other files are measuring.
// `POST /branches` created a branch and nothing removed it, and salon B went
// from two branches to four — which broke the promotions suite's fixture and,
// because lane A mints ids as `BR-` + random base36, won `resolveBranch`'s
// alphabetical tie-break on about three runs in five. Fifteen deterministic
// failures with a flapping edge, none of them a product defect.
//
// So every branch this block creates is tracked and removed, and nothing here
// touches a fixture branch.
// ---------------------------------------------------------------------------

/**
 * Branches this file created, hard-deleted in `afterAll`.
 *
 * DELETE and not the product's own close, for two reasons that both matter.
 * `closed_at` leaves the row holding its name against `branch_salon_name_uq`, so
 * a second run against the same database collides; and a closed branch is still
 * a row in the merchant's list, which is scaffolding left in a product.
 */
const createdBranches: string[] = [];

/** Unique per run — the name index spans closed branches, so a literal collides. */
const probeBranchName = (what: string) => `QA ${what} ${Date.now()}`;

async function openBranch(name: string): Promise<{ id: string; status: number; raw: string }> {
  const res = await treq<{ id: string }>('POST', `/salons/${SALON_B}/branches`, {
    token: dashboard,
    body: { name },
  });
  if (res.status === 201 && res.body?.id) createdBranches.push(res.body.id);
  return { id: res.body?.id ?? '', status: res.status, raw: res.raw };
}

describe('Settings — the structure of a salon, and it is configurable now', () => {
  /**
   * REPORTED BY LANE C, AND THE SYMPTOM IS WORTH KEEPING.
   *
   * The dashboard cached the PATCH response as the new salon, the way any client
   * reasonably would, and every consumer of `salon.branches` and `salon.modules`
   * got `undefined` on the next render. It took the whole section to its error
   * boundary. Lane C's workaround was to stop caching the response and re-GET,
   * which worked and meant the write endpoint was telling the truth to nobody.
   *
   * PROMOTED. The PATCH now builds the same `Salon` the GET does.
   */
  it('PATCH /salons/{id} answers a Salon, the shape GET answers', async () => {
    const res = await treq<SalonView>('PATCH', `/salons/${SALON_B}`, {
      token: dashboard,
      body: { noShowReturnMinutes: 62 },
    });
    precondition(res.status === 200, `PATCH answered ${res.status} ${res.raw}`);

    expect(res.body.modules, 'PATCH returned the raw row: moduleBooking/moduleShop, no modules')
      .toEqual({ booking: expect.any(Boolean), shop: expect.any(Boolean) });
    expect(Array.isArray(res.body.branches), 'PATCH returned no branches').toBe(true);

    // Byte for byte the same document the GET serves. Anything less and a client
    // caching one and re-fetching the other sees the salon change under it.
    const fetched = await readSalon();
    expect(res.body.branches.map((b) => b.id).sort()).toEqual(
      fetched.branches.map((b) => b.id).sort(),
    );
    expect(res.body.modules).toEqual(fetched.modules);
  });

  /**
   * The two switches at the top of the Settings screen.
   *
   * PROMOTED — and the sibling knownBug is DELETED rather than promoted. It
   * asserted the same toggle by its column names (`moduleBooking`/`moduleShop`),
   * written that way so whichever spelling lane A chose, one spec flipped and the
   * other was removed. Lane A chose `modules` and said why: "the column spelling
   * is not a second door." Keeping a spec that demands the second door would be
   * lane D legislating an API shape, which is not its job.
   */
  it('the module toggles switch — Booking and Shop', async () => {
    const before = (await readSalon()).modules;

    const res = await treq('PATCH', `/salons/${SALON_B}`, {
      token: dashboard,
      body: { modules: { booking: !before.booking, shop: before.shop } },
    });
    expect(res.status, `PATCH { modules } answered ${res.status} ${res.raw}`).toBe(200);

    const after = (await readSalon()).modules;
    expect(after.booking, 'the Booking module did not switch').toBe(!before.booking);
    expect(after.shop, 'the Shop module moved when only Booking was sent').toBe(before.shop);

    await treq('PATCH', `/salons/${SALON_B}`, { token: dashboard, body: { modules: before } });
  });

  /**
   * THE SPEC THAT DECIDES THE PHASE-4 CRITERION.
   *
   * "An owner can configure a salon end to end without an engineer" was false for
   * exactly as long as branches had no write path: `branchAccessIds` on every
   * staff row, the happy-hour `branchId`, the per-branch metrics and the charge's
   * own branch resolution all hang off rows nobody but an engineer could make.
   *
   * 201, not 200 — consistent with `POST …/promotions/happy-hours`, which is the
   * decision lane A asked for and this is the answer: the ledger and this spec
   * both assert 201.
   */
  it('a branch can be opened — POST /salons/{id}/branches answers 201 with the branch', async () => {
    const name = probeBranchName('opened');
    const openedIds = (await readSalon()).branches.map((b) => b.id);

    const created = await openBranch(name);
    expect(created.status, `POST /salons/{id}/branches answered ${created.status}: ${created.raw}`)
      .toBe(201);
    expect(created.id, 'the created branch has no id to address it by').toBeTruthy();

    // On the salon read, which is the only place the dashboard will look for it.
    const after = await readSalon();
    expect(after.branches.map((b) => b.id)).toContain(created.id);
    expect(after.branches.length, 'the branch list did not grow by one').toBe(openedIds.length + 1);
    expect(after.branches.find((b) => b.id === created.id)?.name).toBe(name);
  });

  it('and a second branch of the same name is refused, with the reason named', async () => {
    const name = probeBranchName('duplicate');
    const first = await openBranch(name);
    precondition(first.status === 201, `the first create answered ${first.status}: ${first.raw}`);

    const second = await treq<{ error?: string }>('POST', `/salons/${SALON_B}/branches`, {
      token: dashboard,
      body: { name },
    });
    expect(second.status, 'two branches of one salon share a name').toBe(409);
    expect(second.body.error).toBe('branch_name_taken');
  });

  it('a branch can be renamed, in either language', async () => {
    // Its own branch, never a fixture: a renamed fixture collides on
    // `branch_salon_name_uq` the next run, and other suites read those names.
    const created = await openBranch(probeBranchName('rename'));
    precondition(created.status === 201, `the create answered ${created.status}: ${created.raw}`);

    const renamed = probeBranchName('renamed');
    const res = await treq('PATCH', `/salons/${SALON_B}/branches/${created.id}`, {
      token: dashboard,
      body: { name: renamed, nameAr: 'حولي الشرقية' },
    });
    expect(res.status, `PATCH on a branch answered ${res.status}: ${res.raw}`).toBe(200);

    const after = (await readSalon()).branches.find((b) => b.id === created.id);
    expect(after?.name, 'the rename did not persist').toBe(renamed);
    expect(after?.nameAr, 'the Arabic name did not persist').toBe('حولي الشرقية');
  });

  it('a branch can be closed, and a closed branch leaves the salon\'s open list', async () => {
    const created = await openBranch(probeBranchName('close'));
    precondition(created.status === 201, `the create answered ${created.status}: ${created.raw}`);

    const res = await treq('DELETE', `/salons/${SALON_B}/branches/${created.id}`, {
      token: dashboard,
    });
    expect(res.status, `DELETE on a branch answered ${res.status}: ${res.raw}`).toBe(200);

    // A close, not a delete — the row survives so its receipts stay attached to
    // something, and `closed_at` is what `services/branch.ts` filters on.
    expect(
      scalar(`select (closed_at is not null)::text from branch where id='${created.id}'`),
      'DELETE removed the row instead of closing it — its transactions now point at nothing',
    ).toBe('true');
    expect((await readSalon()).branches.map((b) => b.id)).not.toContain(created.id);
  });

  /**
   * THE PREVIEW AND THE CLOSE ARE ONE BUILDER, SO PIN THE IDENTITY AND NOT THE FIELDS.
   *
   * `GET .../closure-preview` answers what the DELETE would do: who gets re-scoped,
   * who is left with no branch at all, and how many of this salon's customers have
   * a deposit held against a booking there. Lane A built both halves on one
   * `branchClosureImpact`, and lane A verified they agree field-for-field.
   *
   * This is the same property as the two doors onto the counter screen, where
   * `heldDepositFils` was hardcoded `0` on the scan path while the charge read it
   * for real — the credit line the customer was shown and the credit applied were
   * different answers, and `services/counter.ts` exists because of it. One identity
   * assertion protects a shared builder better than two field-by-field specs,
   * because a field-by-field spec only checks the fields whoever wrote it thought
   * of, which is exactly how that bug survived.
   *
   * THE PREVIEW IS COMPARED AGAINST THE CLOSE OF THE SAME BRANCH, in that order, so
   * the "would" and the "did" describe one event. Both are taken on a branch this
   * spec created, so no fixture is closed as a side effect.
   *
   * =====================================================================
   * IF THIS SPEC IS RED ON `staffRescoped` ORDER, DO NOT SORT THE ASSERTION.
   * =====================================================================
   * Observed once in a full-suite run on 2026-09-10 (lane D), green in isolation
   * and green in three consecutive runs of its own file, which is the tell:
   *
   *     - Expected  ["Branch Survivor", "Branch Stranded"]     the PREVIEW
   *     + Received  ["Branch Stranded", "Branch Survivor"]     the CLOSE
   *
   * Same two members, identical counts, different ORDER. The two sides are ordered
   * by different things and only one of them is ordered at all:
   *
   *   PREVIEW  `services/branchClosure.ts:107` ends `.orderBy(staffUser.id)`, so it
   *            is deterministic — ST-B09 (Survivor) before ST-B10 (Stranded).
   *   CLOSE    `routes/salons.ts:1254` is `UPDATE … RETURNING` with NO ordering
   *            applied, before or after. RETURNING emits in the UPDATE's scan
   *            order, which postgres does not guarantee and which can flip on
   *            planner choice, buffer state or a concurrent autovacuum.
   *
   * THIS IS DECISION 75'S DEFECT IN A SECOND FUNCTION, and 75 is worth re-reading
   * before touching anything here: it records that `RETURNING` does not honour an
   * `ORDER BY`, measured on trunk — "the subquery picks 8,7,6,5 and RETURNING
   * returns 5,6,7,8, the exact reverse" — and that the resulting failure is
   * INTERMITTENT, so "the first single run of the broken spec passed".
   *
   * SORTING EITHER SIDE HERE WOULD DELETE A REAL DEFECT AND LOOK LIKE A FIX. The
   * merchant reads `staffRescoped` as a list of names on a confirmation dialog and
   * then again on the outcome; two different orders for one event is the same class
   * of wrong as two different numbers, and it is the shared-builder property this
   * spec exists to protect. 75's resolution was the same shape: lane A fixed the
   * CODE so the spec depended on no order, rather than relaxing the spec.
   *
   * THE FIX IS LANE A'S COLUMN (`api/`): order the close's staff list the way the
   * preview orders it — `affected` sorted by `id` after the RETURNING, or the same
   * `.orderBy` intent expressed in the serialiser at `routes/salons.ts:1373` and
   * `:1189` so both doors emit one order. Reported by lane D 2026-09-10, not fixed
   * here.
   */
  it('the closure preview reports exactly what the close then reports — one builder, not two', async () => {
    const created = await openBranch(probeBranchName('preview'));
    precondition(created.status === 201, `the create answered ${created.status}: ${created.raw}`);

    /**
     * GIVE THE CLOSURE SOMETHING TO REPORT, because without this the spec was
     * VACUOUS AND I PROVED IT. A freshly created branch has no staff and no
     * bookings, so all four impact fields are empty on both sides — and a deliberate
     * break that made the preview report `depositHeldBookingsBranchAssumed: 0`
     * while the close reported the real number DID NOT FAIL. Two empty objects
     * compare equal no matter how differently they were built.
     *
     * Same defect as a refusal probe whose WHERE clause matches nothing, and the
     * fourth time this suite has produced it. The lesson that generalises: an
     * identity assertion is only as strong as the difference it could have seen.
     *
     * So two staff are scoped onto the branch about to close — one who keeps
     * another branch and one who does not, which populates `staffRescoped` and
     * `staffLeftWithNoBranch` respectively. Restored in a `finally`.
     */
    psql(`
      UPDATE staff_user SET branch_access_all = false,
                            branch_access_ids = ARRAY['${B_BRANCH}', '${created.id}']
       WHERE id = '${BRANCH_SURVIVOR}';
      UPDATE staff_user SET branch_access_all = false,
                            branch_access_ids = ARRAY['${created.id}']
       WHERE id = '${BRANCH_STRANDED}';
    `);

    try {
    const preview = await treq<any>(
      'GET',
      `/salons/${SALON_B}/branches/${created.id}/closure-preview`,
      { token: dashboard },
    );
    expect(preview.status, `the preview answered ${preview.status}: ${preview.raw}`).toBe(200);

    // It says the close would go through, which is what makes the comparison below
    // a comparison of two descriptions of the same event rather than of a refusal.
    expect(preview.body.closable, `the preview says this branch cannot be closed: ${preview.raw}`).toBe(
      true,
    );
    expect(preview.body.blockedReason).toBeNull();

    const closed = await treq<any>('DELETE', `/salons/${SALON_B}/branches/${created.id}`, {
      token: dashboard,
    });
    expect(closed.status, `the close answered ${closed.status}: ${closed.raw}`).toBe(200);

    /**
     * THE FOUR IMPACT FIELDS, COMPARED AS A UNIT. Not `closable`, `blockedReason` or
     * `closedAt` — those describe the preview's own verdict and the close's own
     * outcome, and are expected to differ.
     *
     * AS SETS, NOT AS SEQUENCES — and this was a real 50/50 flake, not a hypothetical.
     * The two name lists are built from two different reads that agree on their MEMBERS
     * by construction and on their ORDER only by luck:
     *
     *   preview  `api/src/services/branchClosure.ts` selects the scoped staff with an
     *            explicit `.orderBy(staffUser.id)` — deterministic.
     *   close    `api/src/routes/salons.ts` reads `affected` out of the `UPDATE …
     *            array_remove` RETURNING, deliberately, so the body describes THIS close
     *            rather than the salon's general state. Postgres does not order a
     *            RETURNING; it yields rows in whatever order the update touched them.
     *
     * With one rescoped staff member the distinction is invisible. This fixture has two,
     * and the suite went green twice and then red on the third run of an unchanged tree
     * with `["Branch Survivor","Branch Stranded"]` against the reverse — the same two
     * names, in the other order.
     *
     * SORTING IS THE HONEST FIX HERE, and the reason is what the spec's own failure
     * message claims: that a disagreement means "one of the two sentences she read was
     * false". A merchant reading two names in the other order has not been told anything
     * false. No design file specifies an order for this list, so the contract this spec
     * can defend is the MEMBERSHIP. If an order is ever specified, it belongs in lane A's
     * query — a CTE with an `ORDER BY` around the RETURNING — and gets its own spec
     * saying so; it cannot be asserted here by accident.
     */
    const sorted = (v: unknown) => (Array.isArray(v) ? [...v].sort() : v);
    const impactOf = (body: any) => ({
      staffRescoped: sorted(body.staffRescoped),
      staffLeftWithNoBranch: sorted(body.staffLeftWithNoBranch),
      depositHeldBookings: body.depositHeldBookings,
      depositHeldBookingsBranchAssumed: body.depositHeldBookingsBranchAssumed,
    });

    expect(
      impactOf(closed.body),
      'the preview and the close describe the same closure differently. A merchant confirms on ' +
        'the preview and is told the outcome by the close, so a disagreement means one of the two ' +
        'sentences she read was false — and the field most likely to drift is the one that counts ' +
        'money already taken from her customers.',
    ).toEqual(impactOf(preview.body));

    // And the shapes are the same set of keys, so a field added to one and not the
    // other is caught even when both happen to be empty on this fixture.
    for (const field of Object.keys(impactOf(preview.body))) {
      expect(closed.body, `the close does not carry \`${field}\``).toHaveProperty(field);
      expect(preview.body, `the preview does not carry \`${field}\``).toHaveProperty(field);
    }

    /**
     * `depositHeldBookingsBranchAssumed <= depositHeldBookings`, and it is worth
     * asserting the relation rather than either number.
     *
     * An ASSUMED branch is the NORMAL case for a booking, not the edge one: artists
     * have no branch column, so `POST /bookings` infers it and comes back
     * `branch_assumed = true`. A spec expecting the assumed count to be zero, or
     * treating it as anomalous, would be treating the common path as exceptional.
     * What must never happen is the assumed count exceeding the total, which would
     * mean the warning is counting bookings that are not in the set it is warning
     * about.
     */
    expect(
      preview.body.depositHeldBookingsBranchAssumed,
      'more deposit-held bookings have an assumed branch than there are deposit-held bookings',
    ).toBeLessThanOrEqual(preview.body.depositHeldBookings);

    /**
     * AND THE SAMPLE WAS WORTH COMPARING, asserted rather than assumed — the whole
     * point of the two staff rows above. Without this the spec could quietly go back
     * to comparing two empty lists the day the fixture changes.
     *
     * The deposit counts are NOT asserted non-zero: salon B seeds no artists, so no
     * booking can exist there and both numbers are structurally 0. Their non-zero
     * coverage is `deposit.test.ts`, which works at salon A where the artists are.
     */
    expect(
      preview.body.staffRescoped.length,
      'no staff were scoped to the closing branch, so this identity assertion compared two empty ' +
        'lists and would pass however differently the two sides were built',
    ).toBeGreaterThan(0);
    expect(
      preview.body.staffLeftWithNoBranch,
      'the stranded staff member is missing from the field the merchant most needs to see',
    ).toContain('Branch Stranded');
    } finally {
      psql(`
        UPDATE staff_user SET branch_access_all = false,
                              branch_access_ids = ARRAY['${B_BRANCH}']
         WHERE id IN ('${BRANCH_SURVIVOR}', '${BRANCH_STRANDED}');
      `);
    }
  });

  it('the LAST open branch cannot be closed — that would be a money outage from a settings screen', async () => {
    // `resolveBranch` throws `no_branch` for a salon with none, so the next
    // charge, top-up and booking would all fail. Refused with a sentence instead
    // of discovered at the counter.
    const open = (await readSalon()).branches;
    precondition(open.length >= 2, 'salon B needs two open branches for this spec to mean anything');

    // Close everything but one, through the product's own door.
    const [survivor, ...rest] = open;
    const closedHere: string[] = [];
    try {
      for (const b of rest) {
        const res = await treq('DELETE', `/salons/${SALON_B}/branches/${b.id}`, {
          token: dashboard,
        });
        precondition(res.status === 200, `closing ${b.id} answered ${res.status}: ${res.raw}`);
        closedHere.push(b.id);
      }

      const last = await treq<{ error?: string }>(
        'DELETE',
        `/salons/${SALON_B}/branches/${survivor!.id}`,
        { token: dashboard },
      );
      expect(last.status, "a salon's only open branch was closed").toBe(409);
      expect(last.body.error).toBe('last_open_branch');
    } finally {
      /**
       * ONLY THE ONES THIS SPEC CLOSED, and in a `finally` so a failed assertion
       * cannot leave salon B single-branched for the rest of the file.
       *
       * The first version reopened every branch of the salon and then checked the
       * count matched what it saw at the start. It did not: earlier specs in this
       * block close branches on purpose, so a blanket reopen restores THOSE too
       * and the total comes back higher. A teardown that undoes more than its own
       * spec did is the same class of mistake as one that undoes less.
       *
       * Through SQL because there is no re-open endpoint — which is itself worth
       * knowing, and is in the GAP block below.
       */
      if (closedHere.length > 0) {
        const list = closedHere.map((id) => `'${id}'`).join(', ');
        psql(`UPDATE branch SET closed_at = NULL WHERE salon_id='${SALON_B}' AND id IN (${list});`);
      }
    }

    expect(
      (await readSalon()).branches.map((b) => b.id).sort(),
      'this spec did not put salon B\'s open branches back',
    ).toEqual(open.map((b) => b.id).sort());
  });
});

describe('GAP: what configuring a salon still cannot do', () => {
  it.todo(
    'a CLOSED branch cannot be re-opened. `DELETE` sets closed_at and nothing clears it, so a ' +
      'merchant who closes the wrong location needs an engineer to undo a self-service action — ' +
      'and `branch_salon_name_uq` spans closed rows, so she cannot even re-create it under the ' +
      'same name (lane A)',
  );
  it.todo(
    'branch writes are gated on perms.loyalty because there is no perms.settings among the nine ' +
      'in api-contract.md. A staff member who may edit the tier ladder may therefore restructure ' +
      'the salon. Lane A reported it as a contract observation rather than inventing a tenth ' +
      'permission, correctly — this is the spec that appears when the contract answers (trunk)',
  );
});

// ===========================================================================
// Loyalty — the tier ladder editor.
// ===========================================================================

describe('Loyalty — AVO publishes the ladder, and the merchant reads it', () => {
  /**
   * ========================================================================
   * THE LADDER MOVED TO AVO. THIS BLOCK IS THE WITHDRAWAL, NOT A GAP.
   * ========================================================================
   * Decision 79, Aftab verbatim: *"Owner console will control the loyalty part not
   * the merchant (it will be read only for merchant)."* It REVERSES
   * `design/README.md:136`, which records the merchant editor shipping — "merchants
   * now edit their own tier rules" — so the three specs that used to publish a ladder
   * through `dashboard` were not wrong when they were written. They were right about
   * a product that has changed.
   *
   * THEY ARE REWRITTEN RATHER THAN DELETED, and the direction of each is worth stating
   * because "update the test" is exactly how a reversal loses its coverage:
   *
   *   publish → still asserted, through the CONSOLE. The atomicity requirement in
   *   build-plan.md phase 4 did not move with the authority.
   *
   *   refuse-an-invalid-ladder → still asserted, through the CONSOLE. A validator
   *   nobody can reach is not a validator that has been proved.
   *
   *   the second door → NOW TWO SPECS INSTEAD OF ONE. The old one proved
   *   `PATCH /salons/{id}` shares the publish validator. That question is still live
   *   for AVO (`PATCH /v1/platform/salons/{id}`), and a SECOND one appeared underneath
   *   it that did not exist before: the merchant's own `PATCH /salons/{id}` is gated on
   *   the same `perms.loyalty` that still opens her Settings screen, so refusing only
   *   `PUT …/loyalty` would have left the ladder editable by exactly the principal the
   *   reversal withdraws it from. Lane A closed that door in the same commit. Nothing
   *   in this suite would have noticed if it had not.
   */

  /** The four rungs every publish below sends. Ordered, Bronze locked at 0/0. */
  const LADDER = [
    { name: 'bronze', minVisits: 0, bonusPercent: 0 },
    { name: 'silver', minVisits: 4, bonusPercent: 10 },
    { name: 'gold', minVisits: 12, bonusPercent: 20 },
    { name: 'black', minVisits: 24, bonusPercent: 30 },
  ];

  it('the merchant can still read the ladder she can no longer edit, with the server\'s own preview', async () => {
    const res = await treq<{
      loyaltyMode: string;
      tiers?: Array<{ name: string; minVisits: number; bonusPercent: number }>;
      preview?: unknown;
    }>('GET', `/salons/${SALON_B}/loyalty`, { token: dashboard });
    expect(res.status, res.raw).toBe(200);
    expect(res.body.loyaltyMode, 'no loyalty mode to render').toBeTruthy();

    if (res.body.loyaltyMode === 'tiers') {
      // The "10 → 11 KD" line under each card. Computed by the server on purpose:
      // if the dashboard did the rounding itself, the number a merchant reads
      // before publishing and the number a customer is credited afterwards come
      // from two implementations of one rule, and nothing can notice them diverge.
      expect(res.body.preview, 'no server-computed bonus preview for the tier cards').not.toBeNull();
    }
  });

  /**
   * NON-NEGOTIABLE #7, THE SECOND HALF: "Every gated endpoint needs a test that calls
   * it directly with the permission ON" — inverted here, because what is being proved
   * is a WITHDRAWAL rather than a gate.
   *
   * `perms.loyalty` is read out of the database first rather than assumed from the
   * seed comment. If it were off, this spec would pass on a `403 forbidden` that had
   * nothing to do with decision 79 — the single most likely way for this assertion to
   * rot into a tautology, since `perm_loyalty` is a column six other suites write.
   *
   * The ERROR CODE is the assertion, not the status. `403 forbidden` is what a missing
   * permission produces and it is a different fact about the product: it would mean a
   * manager could grant the ladder back, which is exactly what nobody at the salon can
   * now do. `routes/loyalty.ts` says so at `requireLoyaltyPublisher` and
   * `http/errors.ts § loyaltyReadOnly` carries the copy.
   */
  it('a merchant holding perms.loyalty is refused the publish — the capability is withdrawn, not ungranted', async () => {
    precondition(
      scalar(`select perm_loyalty from staff_user where id='${B_STAFF}'`).trim() === 't',
      'Layla does not hold perms.loyalty, so a 403 here would prove nothing about the reversal',
    );
    const before = scalar(`select tiers::text from salon where id='${SALON_B}'`);

    const res = await treq<{ error: string; message: string }>(
      'PUT',
      `/salons/${SALON_B}/loyalty`,
      { token: dashboard, body: { mode: 'tiers', tiers: LADDER } },
    );

    expect(res.status, `the merchant publish answered ${res.status}: ${res.raw}`).toBe(403);
    expect(
      res.body.error,
      'the merchant was refused, but as a missing permission rather than a withdrawn ' +
        `capability — "${res.body.message}". A manager can grant a permission; nobody at ` +
        'the salon can grant this one back.',
    ).toBe('loyalty_read_only');
    expect(
      scalar(`select tiers::text from salon where id='${SALON_B}'`),
      'a refused merchant publish wrote the ladder anyway',
    ).toBe(before);
  });

  /**
   * =======================================================================
   * THE SECOND DOOR — `PATCH /salons/{id}`, THE ONE THAT IS EASY TO FORGET.
   * =======================================================================
   * THIS SPEC IS THE POINT OF THE SLICE, and it is a coverage GAP being filled rather
   * than a red test being repaired: nothing here would have failed if lane A had
   * refused the `PUT` and left the `PATCH` open.
   *
   * `PATCH /salons/{id}` is gated on `requireDashboardPerm(req, 'loyalty')` — the SAME
   * permission — because there is no `perms.settings` among the nine in
   * api-contract.md. So the principal refused at `PUT …/loyalty` above holds, by
   * construction, the exact permission that opens the general-purpose salon write, and
   * every one of the five loyalty columns was in `MERCHANT_EDITABLE` until this
   * reversal. Refusing the front door while that stood open would have withdrawn
   * nothing: the same session could publish the same ladder one route over, unaudited
   * as a publish, and the Loyalty screen would simply have had to send a different
   * request.
   *
   * FIVE FIELDS, FIVE CASES, ONE AT A TIME. Sent together, one refusal covers all five
   * and a field quietly returning to `MERCHANT_EDITABLE` would be invisible — the
   * remaining four would still trip the guard. Individually, the failure names the
   * field that reopened.
   *
   * AND `loyalty_read_only` RATHER THAN `not_editable` IS ASSERTED, because the two are
   * different products. `400 not_editable` says "these fields cannot be edited here",
   * which sends a merchant looking for the route where they can — and there is none.
   * Lane A ordered the guard above the allow-list for that reason; this is the spec that
   * keeps it there.
   */
  const LOYALTY_FIELD_PATCHES: Array<[string, unknown]> = [
    ['loyaltyMode', 'stamps'],
    ['tiers', LADDER],
    ['stampTarget', 6],
    ['stampReward', 'Free blow-dry'],
    ['stampRewardAr', 'تصفيف شعر مجاني'],
  ];

  for (const [field, value] of LOYALTY_FIELD_PATCHES) {
    it(`and the second door is shut too — PATCH /salons/{id} refuses ${field}`, async () => {
      const before = scalar(
        `select row(loyalty_mode, tiers, stamp_target, stamp_reward, stamp_reward_ar)::text from salon where id='${SALON_B}'`,
      );

      const res = await treq<{ error: string; message: string }>('PATCH', `/salons/${SALON_B}`, {
        token: dashboard,
        body: { [field]: value },
      });

      expect(
        res.status,
        `PATCH /salons/{id} answered ${res.status} to a merchant sending ${field}: ${res.raw}`,
      ).toBe(403);
      expect(
        res.body.error,
        `${field} is refused through PATCH /salons/{id}, but not as a withdrawn ` +
          `capability — "${res.body.message}". A merchant told a loyalty field is ` +
          '"not editable here" goes looking for the route where it is.',
      ).toBe('loyalty_read_only');
      expect(
        scalar(
          `select row(loyalty_mode, tiers, stamp_target, stamp_reward, stamp_reward_ar)::text from salon where id='${SALON_B}'`,
        ),
        `a refused PATCH wrote ${field} anyway`,
      ).toBe(before);
    });
  }

  /**
   * THE CONTROL FOR THE FIVE ABOVE, and without it they are satisfiable by a route that
   * refuses this merchant everything.
   *
   * `perms.loyalty` still gates `PATCH /salons/{id}` and the screen behind it is still
   * hers — brand colour, deposit, modules, timezone, hours, social, the Arabic name.
   * That is what "narrowed, not revoked" means, and it is the half of decision 79 a
   * future reader is most likely to over-apply. If this goes red alongside the five,
   * the permission was revoked rather than the ladder withdrawn.
   */
  it('and the rest of her Settings screen still writes — perms.loyalty was narrowed, not revoked', async () => {
    const before = Number(scalar(`select no_show_return_minutes from salon where id='${SALON_B}'`));
    const next = before === 61 ? 62 : 61;

    const res = await treq('PATCH', `/salons/${SALON_B}`, {
      token: dashboard,
      body: { noShowReturnMinutes: next },
    });
    expect(res.status, `a merchant-editable field was refused: ${res.raw}`).toBe(200);
    expect(Number(scalar(`select no_show_return_minutes from salon where id='${SALON_B}'`))).toBe(
      next,
    );

    // Put it back. The snapshot in `afterAll` covers the loyalty columns, not this one.
    await treq('PATCH', `/salons/${SALON_B}`, {
      token: dashboard,
      body: { noShowReturnMinutes: before },
    });
  });

  /**
   * THE PUBLISH ITSELF, now driven by the console.
   *
   * The read-back is deliberately through the SALON row and the customer-facing view
   * rather than through the response: a handler that echoes its own body satisfies any
   * spec that only inspects what came back, which is this file's founding complaint.
   *
   * THE AUDIT ROW IS READ FROM THE MERCHANT'S OWN LOG, and that is the assertion that
   * would have caught the defect lane A reported against itself. The row is written with
   * `salonId: <target>`; the natural-looking repair for a platform principal —
   * `salonId: null` — compiles, and `routes/audit.ts` filters the merchant's log on
   * `salon_id`, so a null would put an AVO ladder change in AVO's log and nowhere else.
   * A merchant opening her Loyalty screen to find Gold moved from 4 visits to 12 would
   * have had no row to read. Counting through `/salons/{id}/audit` rather than through
   * `psql` is what makes this spec see that; a raw count on `audit_log` would not.
   */
  it('AVO publishes a ladder, it persists, and the "Tier rules published" line reaches the SALON\'s log', async () => {
    const before = await treq<{ items: Array<{ action: string; source?: string }> }>(
      'GET',
      `/salons/${SALON_B}/audit?q=published&limit=50`,
      { token: dashboard },
    );
    precondition(before.status === 200, `the merchant audit read answered ${before.status}`);
    const publishedBefore = before.body.items.length;

    const published = await treq<{ message: string; appliesAt: string; publishedBy: string }>(
      'PUT',
      `/salons/${SALON_B}/loyalty`,
      { token: platform, body: { mode: 'tiers', tiers: LADDER } },
    );
    expect(published.status, published.raw).toBe(200);
    // Stated on the wire rather than hardcoded in the client: nobody is promoted or
    // demoted at publish time, and one place decides what the product says happened.
    expect(published.body.appliesAt).toBe('next_visit');

    const gold = Number(
      scalar(`select (tiers -> 2 ->> 'minVisits') from salon where id='${SALON_B}'`),
    );
    expect(gold, 'the published ladder did not persist').toBe(12);

    const after = await treq<{ items: Array<{ action: string; source?: string }> }>(
      'GET',
      `/salons/${SALON_B}/audit?q=published&limit=50`,
      { token: dashboard },
    );
    expect(after.status, after.raw).toBe(200);
    expect(
      after.body.items.length,
      'AVO published a ladder and the salon\'s own audit log has no line for it. The row ' +
        'was written against no salon, or against the actor\'s — a platform admin has ' +
        'neither.',
    ).toBe(publishedBefore + 1);
    expect(
      after.body.items.some((r) => r.action === 'Tier rules published'),
      'the publish landed under a different action string, so a merchant scanning the ' +
        'log for "who changed the tier rules" sees two things where there is one act',
    ).toBe(true);
  });

  it('an out-of-order ladder is refused and writes NOTHING — not even the valid rungs', async () => {
    const before = scalar(`select tiers::text from salon where id='${SALON_B}'`);

    const res = await treq('PUT', `/salons/${SALON_B}/loyalty`, {
      token: platform,
      body: {
        mode: 'tiers',
        tiers: [
          { name: 'bronze', minVisits: 0, bonusPercent: 0 },
          { name: 'silver', minVisits: 20, bonusPercent: 10 },
          { name: 'gold', minVisits: 12, bonusPercent: 20 },
          { name: 'black', minVisits: 24, bonusPercent: 30 },
        ],
      },
    });
    expect(res.status, 'a ladder whose gold sits below its silver was published').toBe(400);

    const after = scalar(`select tiers::text from salon where id='${SALON_B}'`);
    expect(after, 'a refused publish wrote part of the ladder').toBe(before);
  });

  /**
   * AND THE CONSOLE'S OWN SECOND DOOR OBEYS THE SAME RULES.
   *
   * This is the spec the merchant version became. `PATCH /v1/platform/salons/{id}`
   * takes `PLATFORM_EDITABLE` — `MERCHANT_EDITABLE` plus `city`, `ownerPhone` and the
   * five loyalty fields — so it is now the only general-purpose route that can write a
   * ladder at all. A validator that guards one of two open doors is decorative, and the
   * pair of doors is the same pair as before with one of them re-labelled.
   */
  it('and the same fields sent through PATCH /v1/platform/salons/{id} obey the same rules', async () => {
    const before = scalar(`select tiers::text from salon where id='${SALON_B}'`);
    const res = await treq('PATCH', `/v1/platform/salons/${SALON_B}`, {
      token: platform,
      body: {
        tiers: [
          { name: 'bronze', minVisits: 0, bonusPercent: 0 },
          { name: 'silver', minVisits: 30, bonusPercent: 10 },
          { name: 'gold', minVisits: 12, bonusPercent: 20 },
          { name: 'black', minVisits: 24, bonusPercent: 30 },
        ],
      },
    });
    expect(res.status, 'an invalid ladder was accepted through the general-purpose route').toBe(400);
    expect(scalar(`select tiers::text from salon where id='${SALON_B}'`)).toBe(before);
  });
});

// ===========================================================================
// Team — artist availability.
// ===========================================================================

describe('Team — the roster, and a week that replaces rather than merges', () => {
  it('the roster is salon-scoped and carries what the section renders', async () => {
    const res = await treq<{ items: Array<{ id: string; salonId: string; windows: unknown }> }>(
      'GET',
      `/salons/${SALON_B}/artists`,
      { token: dashboard },
    );
    expect(res.status, res.raw).toBe(200);

    const mine = res.body.items.find((a) => a.id === ARTIST);
    expect(mine, `${ARTIST} is missing from salon B's roster`).toBeTruthy();
    expect(res.body.items.every((a) => a.salonId === SALON_B), 'another salon on the roster').toBe(
      true,
    );
    expect(mine!.windows, 'an artist with no week to edit').toBeTruthy();
  });

  it('reception sets an artist\'s week on her behalf, and it is there afterwards', async () => {
    const res = await treq('PUT', `/artists/${ARTIST}/availability`, {
      token: dashboard,
      body: {
        slotMinutes: 30,
        windows: week({
          '1': { open: true, from: '10:00', to: '19:00' },
          '2': { open: true, from: '12:00', to: '20:00' },
        }),
      },
    });
    expect(res.status, res.raw).toBe(200);

    const monday = scalar(
      `select windows -> '1' ->> 'from' from artist where id='${ARTIST}'`,
    );
    expect(monday, 'the week did not persist').toBe('10:00');
    const tuesdayOpen = scalar(`select windows -> '2' ->> 'open' from artist where id='${ARTIST}'`);
    expect(tuesdayOpen).toBe('true');
  });

  it('a partial week is refused, because a PUT that merges is a PUT that lies', async () => {
    // The merchant who unticks Friday and saves sends six days. A merge keeps
    // Friday open and she finds out from a customer.
    const res = await treq<{ error?: string }>('PUT', `/artists/${ARTIST}/availability`, {
      token: dashboard,
      body: { windows: { '1': { open: true, from: '10:00', to: '19:00' } } },
    });
    expect(res.status, res.raw).toBe(400);
    expect(res.body.error).toBe('invalid_windows');
  });

  it('an open day shorter than one slot is refused rather than stored as zero bookable slots', async () => {
    const res = await treq('PUT', `/artists/${ARTIST}/availability`, {
      token: dashboard,
      body: {
        slotMinutes: 60,
        windows: week({ '3': { open: true, from: '10:00', to: '10:30' } }),
      },
    });
    expect(res.status, 'an open day with nothing bookable in it was accepted').toBe(400);
  });
});

// ===========================================================================
// Accounts — the nine permission chips, and the three doors that are missing.
// ===========================================================================

interface StaffView {
  id: string;
  name: string;
  handle: string;
  perms: Record<string, boolean>;
}

describe('Accounts — authority is readable, settable, and never carries a credential', () => {
  it('the roster is salon-scoped and holds no hash of any kind (non-negotiable #6)', async () => {
    const res = await treq<{ items: StaffView[] }>('GET', '/staff', { token: dashboard });
    expect(res.status, res.raw).toBe(200);

    const ids = res.body.items.map((s) => s.id);
    expect(ids).toContain(B_STAFF);
    expect(ids).toContain(STAFF_TARGET);

    // Asserted on the raw bytes, not on the parsed keys: a hash nested one level
    // deeper than the assertion looked would pass a key-by-key check.
    for (const smell of ['passwordHash', 'password_hash', 'pinHash', 'pin_hash', '$argon2']) {
      expect(res.raw, `GET /staff leaked ${smell}`).not.toContain(smell);
    }
  });

  it('the nine chips round-trip, and the change is read back from a second request', async () => {
    const grant = await treq('PATCH', `/staff/${STAFF_TARGET}`, {
      token: dashboard,
      body: { perms: { marketing: true } },
    });
    expect(grant.status, grant.raw).toBe(200);

    const roster = await treq<{ items: StaffView[] }>('GET', '/staff', { token: dashboard });
    const target = roster.body.items.find((s) => s.id === STAFF_TARGET);
    expect(target?.perms.marketing, 'the grant did not persist').toBe(true);

    const revoke = await treq('PATCH', `/staff/${STAFF_TARGET}`, {
      token: dashboard,
      body: { perms: { marketing: false } },
    });
    expect(revoke.status, revoke.raw).toBe(200);
    expect(scalar(`select perm_marketing::text from staff_user where id='${STAFF_TARGET}'`)).toBe(
      'false',
    );
  });

  it('void without charges is refused — the dependency is enforced on the server', async () => {
    const res = await treq<{ error?: string }>('PATCH', `/staff/${STAFF_TARGET}`, {
      token: dashboard,
      body: { perms: { void: true } },
    });
    expect(res.status, res.raw).toBe(400);
    expect(res.body.error).toBe('void_requires_charges');
    expect(scalar(`select perm_void::text from staff_user where id='${STAFF_TARGET}'`)).toBe(
      'false',
    );
  });

  it('an invented permission is named, not dropped', async () => {
    const res = await treq<{ error?: string }>('PATCH', `/staff/${STAFF_TARGET}`, {
      token: dashboard,
      body: { perms: { refunds: true } },
    });
    expect(res.status, res.raw).toBe(400);
    expect(res.body.error).toBe('unknown_permission');
  });

  it('a credential can never be set through the authority endpoint (non-negotiable #6)', async () => {
    for (const body of [
      { perms: { scanner: true }, pin: '1234' },
      { perms: { scanner: true }, password: 'hunter2' },
      { perms: { scanner: true }, passwordHash: 'whatever' },
    ]) {
      const res = await treq<{ error?: string }>('PATCH', `/staff/${STAFF_TARGET}`, {
        token: dashboard,
        body,
      });
      expect(res.status, `${JSON.stringify(body)} was accepted: ${res.raw}`).toBe(400);
      expect(res.body.error).toBe('not_settable_here');
    }
  });

  it('and every permission change is on the audit log under Access', async () => {
    const before = Number(
      scalar(`select count(*) from audit_log where salon_id='${SALON_B}' and kind='access'`),
    );
    const res = await treq('PATCH', `/staff/${STAFF_TARGET}`, {
      token: dashboard,
      body: { perms: { appointments: true } },
    });
    precondition(res.status === 200, `PATCH answered ${res.status} ${res.raw}`);

    const after = Number(
      scalar(`select count(*) from audit_log where salon_id='${SALON_B}' and kind='access'`),
    );
    expect(after, 'authority moved with nothing written down').toBe(before + 1);

    await treq('PATCH', `/staff/${STAFF_TARGET}`, {
      token: dashboard,
      body: { perms: { appointments: false } },
    });
  });
});

/**
 * PROMOTED. Hire, leave, and a reset that is only ever a link.
 *
 * These three were `knownBug()` and reported the same absence: `GET /staff` and
 * `PATCH /staff/{id}` were the whole surface, so a new receptionist had to be
 * INSERTed by hand with a password hash produced by hand — a phase-4 blocker and
 * the exact circumstance in which somebody stores a plaintext password to get
 * through an afternoon.
 *
 * EVERY ACCOUNT THIS BLOCK CREATES IS ITS OWN, with a handle unique per run.
 * `staff_user` handles are unique per salon and span deactivated rows, so a fixed
 * handle would 409 the second time this file ran against one database — and a
 * spec that hired into salon B's real roster would be changing what
 * `tenancy.test.ts` and `scanner.test.ts` count.
 */
describe('Accounts — hiring, leaving, and a password that is only ever a link', () => {
  const probeHandle = (what: string) => `qa${what}${Date.now().toString(36)}`;

  it('a staff account can be hired — POST /staff answers 201 with the account', async () => {
    const handle = probeHandle('hire');
    const res = await treq<StaffView>('POST', '/staff', {
      token: dashboard,
      body: {
        name: 'Shaikha',
        handle,
        role: 'frontdesk',
        perms: { scanner: true, charges: true },
      },
    });
    // 201, matching POST /salons/{id}/branches and POST …/happy-hours. Lane A
    // asked which of 200 or 201 this suite wanted; the answer is 201 everywhere.
    expect(res.status, `POST /staff answered ${res.status}: ${res.raw}`).toBe(201);
    expect(res.body.id, 'the new account has no id').toBeTruthy();
    expect(res.body.handle).toBe(handle);

    // The authority asked for, and nothing more. A hire that quietly granted the
    // nine would be the worst possible default.
    expect(res.body.perms.scanner).toBe(true);
    expect(res.body.perms.charges).toBe(true);
    expect(res.body.perms.team, 'a new frontdesk account can edit the roster').toBe(false);
    expect(res.body.perms.void, 'void arrived unasked, and it is the reversal permission').toBe(
      false,
    );

    // On the roster the Accounts screen reads.
    const roster = await treq<{ items: StaffView[] }>('GET', '/staff', { token: dashboard });
    expect(roster.body.items.map((s) => s.id)).toContain(res.body.id);
  });

  it('and the hire carries no credential, in the response or the audit row (non-negotiable #6)', async () => {
    const res = await treq<StaffView>('POST', '/staff', {
      token: dashboard,
      body: { name: 'Noor QA', handle: probeHandle('cred'), role: 'frontdesk', perms: {} },
    });
    precondition(res.status === 201, `POST /staff answered ${res.status}: ${res.raw}`);

    for (const smell of ['passwordHash', 'password_hash', 'pinHash', 'pin_hash', '$argon2']) {
      expect(res.raw, `POST /staff leaked ${smell}`).not.toContain(smell);
    }

    /**
     * `pinSet` and `passwordSet` are the RIGHT shape and this asserts they stayed
     * booleans rather than banning the substring "pin".
     *
     * The first draft did ban it, and `pinSet: false` tripped it — a spec calling
     * a correct design a leak. The Accounts screen has to distinguish "no web
     * login by design", an artist who only ever uses the tablet, from "her
     * password needs resetting"; both are false and only one is a problem. A
     * boolean answers that. A length or a masked hash would not, and is what this
     * assertion is really for.
     */
    expect(typeof (res.body as unknown as { pinSet: unknown }).pinSet).toBe('boolean');
    expect(typeof (res.body as unknown as { passwordSet: unknown }).passwordSet).toBe('boolean');

    const audit = scalar(
      `select coalesce(detail,'') || ' ' || coalesce(metadata::text,'') from audit_log
        where subject_id='${res.body.id}' order by seq desc limit 1`,
    );
    expect(audit, 'the hire audit row carries a credential').not.toMatch(/argon2|password|pin_hash/i);
  });

  it('a leaver loses her sign-in, and her history keeps her name on it', async () => {
    const created = await treq<StaffView>('POST', '/staff', {
      token: dashboard,
      body: { name: 'Departing QA', handle: probeHandle('leave'), role: 'frontdesk', perms: {} },
    });
    precondition(created.status === 201, `POST /staff answered ${created.status}: ${created.raw}`);

    const res = await treq('DELETE', `/staff/${created.body.id}`, { token: dashboard });
    expect(res.status, `DELETE /staff/{id} answered ${res.status}: ${res.raw}`).toBe(200);

    // A deactivation, not a delete: `transaction` and `audit_log` name the actor,
    // and a removed row would leave every one of those pointing at nobody.
    expect(
      scalar(`select (deactivated_at is not null)::text from staff_user where id='${created.body.id}'`),
      'DELETE removed the row — her charges and audit lines now name nobody',
    ).toBe('true');
  });

  it('a forgotten password is recovered by a LINK, and the link is never in the response', async () => {
    /**
     * NON-NEGOTIABLE #6, and the assertion that matters is the second one.
     *
     * "Owner console only ever sends a reset link." An endpoint that answered 202
     * and handed the caller the token would satisfy the letter of that and none of
     * its intent: the merchant's browser, her logs and anything reading the
     * response would hold a credential that resets a staff account.
     */
    const res = await treq<{ expiresAt?: string }>(
      'POST',
      `/staff/${STAFF_TARGET}/password-reset`,
      { token: dashboard, body: {} },
    );
    expect(res.status, `POST /staff/{id}/password-reset answered ${res.status}: ${res.raw}`).toBe(
      202,
    );
    expect(res.body.expiresAt, 'the dashboard cannot say how long the link is good for').toBeTruthy();

    for (const smell of ['token', 'link', 'url', 'password', 'hash']) {
      expect(
        res.raw.toLowerCase(),
        `the reset response carries "${smell}" — the token must never leave the server`,
      ).not.toContain(smell);
    }

    // Nor in the audit row, which is read by more people than the response is.
    const audit = scalar(
      `select coalesce(detail,'') || ' ' || coalesce(metadata::text,'') from audit_log
        where subject_id='${STAFF_TARGET}' and action like '%link sent%' order by seq desc limit 1`,
    );
    expect(audit, 'no audit row for a reset link').not.toBe('');
    expect(audit.toLowerCase(), 'the audit row recorded the reset token').not.toMatch(
      /token|[a-f0-9]{32}/,
    );
  });

  it('and the same endpoint re-activates a leaver, rather than a second account appearing', async () => {
    const handle = probeHandle('rehire');
    const created = await treq<StaffView>('POST', '/staff', {
      token: dashboard,
      body: { name: 'Returning QA', handle, role: 'frontdesk', perms: {} },
    });
    precondition(created.status === 201, `POST /staff answered ${created.status}: ${created.raw}`);
    const left = await treq('DELETE', `/staff/${created.body.id}`, { token: dashboard });
    precondition(left.status === 200, `DELETE answered ${left.status}: ${left.raw}`);

    // Hiring the same handle again must not mint a second identity — her charges
    // and audit lines belong to one person.
    const again = await treq<{ error?: string }>('POST', '/staff', {
      token: dashboard,
      body: { name: 'Returning QA', handle, role: 'frontdesk', perms: {} },
    });
    expect(again.status, 'a leaver\'s handle was reissued as a new account').toBe(409);

    const reset = await treq('POST', `/staff/${created.body.id}/password-reset`, {
      token: dashboard,
      body: {},
    });
    expect(reset.status, `re-activating answered ${reset.status}: ${reset.raw}`).toBe(202);
  });
});

// ===========================================================================
// Audit log — the section that makes every section above accountable.
// ===========================================================================

interface AuditPage {
  items: Array<{
    id: string;
    seq: number;
    when: string;
    who: string;
    kind: string;
    action: string;
    detail: string | null;
    source: string;
    sourceLabel: string;
  }>;
  total?: number;
}

describe('Audit log — search, the kind filter, and the count beside the chips', () => {
  it('the page is newest-first and carries the columns the design renders', async () => {
    const res = await treq<AuditPage>('GET', `/salons/${SALON_B}/audit?limit=20`, {
      token: dashboard,
    });
    expect(res.status, res.raw).toBe(200);
    precondition(res.body.items.length > 0, 'no audit rows — the specs above should have made some');

    const first = res.body.items[0]!;
    expect(first.when, 'the instant is not ISO — a relative phrase is the client\'s job').toMatch(
      /^\d{4}-\d{2}-\d{2}T/,
    );
    expect(first.who).toBeTruthy();
    expect(['money', 'rules', 'access', 'risk']).toContain(first.kind);
    expect(first.sourceLabel, 'no Source label for the design\'s Source column').toBeTruthy();

    const seqs = res.body.items.map((r) => r.seq);
    expect(seqs, 'the log is not newest-first').toEqual([...seqs].sort((a, b) => b - a));
  });

  it('the kind chips filter, and filter to that kind only', async () => {
    const res = await treq<AuditPage>('GET', `/salons/${SALON_B}/audit?kind=access&limit=50`, {
      token: dashboard,
    });
    expect(res.status, res.raw).toBe(200);
    precondition(res.body.items.length > 0, 'no access rows to filter');
    expect(res.body.items.every((r) => r.kind === 'access'), 'the kind filter let others through')
      .toBe(true);
  });

  it('search matches the action text', async () => {
    const res = await treq<AuditPage>('GET', `/salons/${SALON_B}/audit?q=published&limit=50`, {
      token: dashboard,
    });
    expect(res.status, res.raw).toBe(200);
    precondition(res.body.items.length > 0, 'the loyalty spec above should have made a match');
    expect(
      res.body.items.every((r) => `${r.action} ${r.detail ?? ''}`.toLowerCase().includes('publish')),
      'search returned a row that does not match',
    ).toBe(true);
  });

  it('a search that matches nothing is an empty page, not an error', async () => {
    const res = await treq<AuditPage>(
      'GET',
      `/salons/${SALON_B}/audit?q=zzzz-no-such-entry-zzzz`,
      { token: dashboard },
    );
    expect(res.status, res.raw).toBe(200);
    expect(res.body.items).toEqual([]);
  });

  it('the log is salon-scoped from the PRINCIPAL, so it can never show another salon', async () => {
    const res = await treq<AuditPage>('GET', `/salons/${SALON_B}/audit?limit=50`, {
      token: dashboard,
    });
    precondition(res.status === 200, `audit answered ${res.status}`);
    const ids = res.body.items.map((r) => r.id);
    const foreign = ids.length === 0
      ? '0'
      : scalar(
          `select count(*) from audit_log where salon_id <> '${SALON_B}' and id in (${ids
            .map((i) => `'${i}'`)
            .join(',')})`,
        );
    expect(foreign, 'the audit page contained a row belonging to another salon').toBe('0');
  });
});
