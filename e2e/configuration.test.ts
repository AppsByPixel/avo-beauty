/**
 * CAN AN OWNER CONFIGURE A SALON WITHOUT AN ENGINEER?
 *
 * HOW TO RUN
 *
 *   pnpm install
 *   pnpm --filter @avo/api run db:up
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
  B_STAFF,
  B_STAFF_HANDLE,
  SALON_B,
  psql,
  scalar,
  signInDashboard,
  startTenancyApi,
  stopTenancyApi,
  treq,
} from './support/tenancy-harness.js';

/** Layla, salon B's manager, holding all nine permissions. */
let dashboard = '';

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
  if (salonSnapshot) {
    // Restored through SQL rather than through the API, deliberately: the API is
    // missing write paths for half of these, and a teardown that can only undo
    // what the product can currently do is a teardown that leaks.
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
   * FOUND HERE, AND IT IS A 500 RATHER THAN A REFUSAL.
   *
   * `depositFils: 5500.5` is not validated by the route; it goes into the patch
   * object as it arrived and Postgres refuses it on the integer column, which
   * arrives at the client as `server_error` — "Something went wrong on our side."
   *
   * The money is safe, which is why the spec above is a plain `it()`: nothing is
   * written, and the constraint is doing exactly the job a constraint is for. The
   * defect is that the merchant cannot tell a typed-in "5.5" from an outage, and
   * that the API's own logs record an unhandled error every time somebody
   * mis-types a number. The route already validates `timezone` before the UPDATE
   * for precisely this reason, and its comment says so: "a typo is a 400 naming
   * the tz database rather than a 500 thrown out of Intl". The money fields
   * deserve the same treatment.
   */
  knownBug('and a fractional deposit is a 400 naming the field, not a 500', async () => {
    const res = await treq('PATCH', `/salons/${SALON_B}`, {
      token: dashboard,
      body: { depositFils: 5_500.5 },
    });
    expect(res.status, 'an unvalidated float reached Postgres and came back as server_error').toBe(
      400,
    );
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
// The gap. Lane C found the first one by watching the dashboard fall into its
// error boundary; the rest are what "configure a salon end to end" still needs.
// ---------------------------------------------------------------------------

describe('GAP: Settings cannot finish the job — lane A owns every one of these', () => {
  /**
   * REPORTED BY LANE C, AND THE SYMPTOM IS WORTH KEEPING.
   *
   * The dashboard cached the PATCH response as the new salon, the way any client
   * reasonably would, and every consumer of `salon.branches` and `salon.modules`
   * got `undefined` on the next render. It took the whole section to its error
   * boundary. Lane C's workaround was to stop caching the response and re-GET,
   * which works and means the write endpoint is telling the truth to nobody.
   *
   * `GET /salons/{id}` right above builds the `Salon` shape by hand — modules as
   * an object, branches joined in. The PATCH returns `reply.send(after)`, the raw
   * Drizzle row: `moduleBooking`/`moduleShop` instead of `modules`, and no
   * `branches` key at all.
   */
  knownBug('PATCH /salons/{id} answers a Salon, the shape GET answers', async () => {
    const res = await treq<SalonView>('PATCH', `/salons/${SALON_B}`, {
      token: dashboard,
      body: { noShowReturnMinutes: 62 },
    });
    precondition(res.status === 200, `PATCH answered ${res.status} ${res.raw}`);

    expect(res.body.modules, 'PATCH returned the raw row: moduleBooking/moduleShop, no modules')
      .toEqual({ booking: expect.any(Boolean), shop: expect.any(Boolean) });
    expect(Array.isArray(res.body.branches), 'PATCH returned no branches').toBe(true);
  });

  /**
   * The two switches at the top of the Settings screen. `GET /salons/{id}` serves
   * `modules`, the dashboard renders them, and there is no way to set them: they
   * are not in the route's EDITABLE set under any spelling.
   *
   * A read-only toggle is worse than an absent one. The merchant flips it, the
   * request 400s, and what she has learned is that the dashboard is broken rather
   * than that the feature is unbuilt.
   */
  knownBug('the module toggles can be switched — Booking and Shop', async () => {
    const before = (await readSalon()).modules;

    const res = await treq('PATCH', `/salons/${SALON_B}`, {
      token: dashboard,
      body: { modules: { booking: !before.booking, shop: before.shop } },
    });
    expect(res.status, `PATCH { modules } answered ${res.status} ${res.raw}`).toBe(200);

    const after = (await readSalon()).modules;
    expect(after.booking, 'the Booking module did not switch').toBe(!before.booking);
  });

  knownBug('and by their column names too, if `modules` is not the agreed spelling', async () => {
    // Written separately so a fix that lands one spelling does not leave the
    // other reported as broken. Whichever lane A chooses, one of these two
    // knownBugs flips and the other is deleted.
    const before = (await readSalon()).modules;
    const res = await treq('PATCH', `/salons/${SALON_B}`, {
      token: dashboard,
      body: { moduleShop: !before.shop },
    });
    expect(res.status, `PATCH { moduleShop } answered ${res.status} ${res.raw}`).toBe(200);
  });

  /**
   * BRANCHES HAVE NO WRITE PATH AT ALL — no POST, no DELETE, and `branches` is
   * refused by the PATCH.
   *
   * This is the one that decides the phase-4 criterion. A salon that opens a
   * second location cannot be told about it by anybody without database access,
   * and `branchAccessIds` on every staff row, the happy-hour `branchId`, the
   * per-branch metrics and the charge's own branch resolution all hang off rows
   * only an engineer can create.
   */
  knownBug('a branch can be created — POST /salons/{id}/branches', async () => {
    const res = await treq('POST', `/salons/${SALON_B}/branches`, {
      token: dashboard,
      body: { name: 'Salmiya' },
    });
    expect(
      res.status,
      `POST /salons/{id}/branches answered ${res.status} — a salon cannot open a second location`,
    ).toBe(200);
  });

  knownBug('a branch can be renamed', async () => {
    const res = await treq('PATCH', `/salons/${SALON_B}/branches/${B_BRANCH}`, {
      token: dashboard,
      body: { name: 'Hawally East' },
    });
    expect(res.status, `PATCH on a branch answered ${res.status}`).toBe(200);
  });

  knownBug('a branch can be closed — DELETE /salons/{id}/branches/{bid}', async () => {
    const res = await treq('DELETE', `/salons/${SALON_B}/branches/BR-LUM-JAB`, {
      token: dashboard,
    });
    // Whether it is a soft close or a hard delete is lane A's call; the point is
    // that there is a door. Transactions reference `branch`, so it will most
    // likely be the same "switch it off, the receipts refer to it" rule the
    // happy-hour delete already states.
    expect(res.status, `DELETE on a branch answered ${res.status}`).toBe(200);
  });
});

// ===========================================================================
// Loyalty — the tier ladder editor.
// ===========================================================================

describe('Loyalty — the ladder publishes atomically and is refused whole', () => {
  it('the editor can read the ladder it is about to edit, with the server\'s own preview', async () => {
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

  it('publishing a ladder persists it and writes the "Tier rules published" line', async () => {
    const auditBefore = Number(
      scalar(
        `select count(*) from audit_log where salon_id='${SALON_B}' and action like '%rules published%'`,
      ),
    );

    const published = await treq('PUT', `/salons/${SALON_B}/loyalty`, {
      token: dashboard,
      body: {
        mode: 'tiers',
        tiers: [
          { name: 'bronze', minVisits: 0, bonusPercent: 0 },
          { name: 'silver', minVisits: 4, bonusPercent: 10 },
          { name: 'gold', minVisits: 12, bonusPercent: 20 },
          { name: 'black', minVisits: 24, bonusPercent: 30 },
        ],
      },
    });
    expect(published.status, published.raw).toBe(200);

    // Read back through the customer-facing route, which is where the ladder
    // actually has to arrive — the wallet renders it, not the editor.
    const salonView = await readSalon();
    expect(salonView).toBeTruthy();
    const gold = Number(
      scalar(
        `select (tiers -> 2 ->> 'minVisits') from salon where id='${SALON_B}'`,
      ),
    );
    expect(gold, 'the published ladder did not persist').toBe(12);

    const auditAfter = Number(
      scalar(
        `select count(*) from audit_log where salon_id='${SALON_B}' and action like '%rules published%'`,
      ),
    );
    expect(auditAfter, 'a ladder was published with no audit line').toBe(auditBefore + 1);
  });

  it('an out-of-order ladder is refused and writes NOTHING — not even the valid rungs', async () => {
    const before = scalar(`select tiers::text from salon where id='${SALON_B}'`);

    const res = await treq('PUT', `/salons/${SALON_B}/loyalty`, {
      token: dashboard,
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

  it('and the same fields sent through PATCH /salons/{id} obey the same rules', async () => {
    // The second door. A validator that only guards one route is decorative.
    const before = scalar(`select tiers::text from salon where id='${SALON_B}'`);
    const res = await treq('PATCH', `/salons/${SALON_B}`, {
      token: dashboard,
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

describe('GAP: staff onboarding has no server behind it — lane A owns these too', () => {
  /**
   * There is no way to hire anybody. `GET /staff` lists, `PATCH /staff/{id}`
   * adjusts authority, and that is the whole surface — a new receptionist has to
   * be INSERTed by hand, with a password hash produced by hand, which is both a
   * blocker for phase 4 and the exact circumstance in which somebody stores a
   * plaintext password to get through the afternoon.
   */
  knownBug('a staff account can be created — POST /staff', async () => {
    const res = await treq('POST', '/staff', {
      token: dashboard,
      idempotencyKey: `staff-create-${Date.now()}`,
      body: {
        name: 'Shaikha',
        handle: 'shaikha',
        role: 'frontdesk',
        perms: { scanner: true, charges: true },
      },
    });
    expect(
      res.status,
      `POST /staff answered ${res.status} — a salon cannot hire without an engineer`,
    ).toBe(200);
  });

  knownBug('a staff account can be removed — DELETE /staff/{id}', async () => {
    const res = await treq('DELETE', `/staff/${STAFF_TARGET}`, { token: dashboard });
    // Almost certainly a deactivation rather than a delete, since `transaction`
    // and `audit_log` name the actor. Either is a door; there is none.
    expect(
      res.status,
      `DELETE /staff/{id} answered ${res.status} — a leaver keeps her sign-in for ever`,
    ).toBe(200);
  });

  /**
   * Non-negotiable #6: "Owner console only ever sends a reset link." There is no
   * endpoint that sends one, from either console, which means the only way to
   * restore access today is to write a hash into the row — the thing the
   * non-negotiable exists to prevent.
   */
  knownBug('a forgotten password is recovered by a reset LINK, never by a set', async () => {
    const res = await treq('POST', `/staff/${STAFF_TARGET}/password-reset`, {
      token: dashboard,
      body: {},
    });
    expect(
      res.status,
      `POST /staff/{id}/password-reset answered ${res.status} — there is no reset link to send`,
    ).toBe(202);
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
