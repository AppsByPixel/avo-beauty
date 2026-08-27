/**
 * `availability_source` — THE ENUM WHOSE SECOND VALUE NO TEST HAS EVER NAMED.
 *
 * HOW TO RUN
 *
 *   pnpm install
 *   pnpm --dir ./api run db:up
 *   cd e2e && ../node_modules/.bin/vitest run artist-availability-source.test.ts
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `api/src/db/schema/artist.ts` declares `pgEnum('availability_source', ['google',
 * 'manual'])`. Before this file, the string `'google'` appeared in NO test file in
 * this repository — not in `e2e/`, not in `api/src/**\/*.test.ts`, not in the app
 * packages. Every artist fixture a test wrote pinned `manual`:
 * `configuration.test.ts` inserts `availability_source = 'manual', google_connected
 * = false` and resets it to the same pair on conflict.
 *
 * That is the identical coverage shape that shipped the `audience: "lapsed"` 500 —
 * see `campaigns.test.ts` § THE AUDIENCE DIMENSION, which is the file this one is
 * modelled on. A suite that drives one member of an enum has not tested the enum;
 * it has tested the value that happened to work. And the `google` side is not a
 * thin one. It owns five distinct branches:
 *
 *   services/availability.ts:178  `if (a.availabilitySource !== 'google')` — the
 *                                 early return. Everything past it is the google
 *                                 path, ending in `raiseMerchantNotification` at
 *                                 :228.
 *   routes/artists.ts:275         the value validation.
 *   routes/artists.ts:284         `v === 'google' && !target.googleConnected` — a
 *                                 409 refusal.
 *   routes/artists.ts:304         `editsWindows && nextSource === 'google'` — a
 *                                 second 409 refusal.
 *   routes/artists.ts:629/:655    the live-calendar filter behind
 *                                 `availabilityLive` on `/artists/bookable`.
 *
 * Both 409s are merchant-facing and neither had ever been driven, by any suite, at
 * any layer. They are the cheapest thing here and the most valuable: a merchant who
 * meets one meets a sentence written for her, and until this file nothing checked
 * that she gets that sentence rather than a constraint-violation 500.
 *
 * WHAT IS NOT DRIVABLE, SAID PLAINLY RATHER THAN SPECIFIED AROUND
 * --------------------------------------------------------------
 * The brief for this work asked whether `api/src/calendar/` provides enough to
 * drive the google READ path end to end. It does not, and the honest answer is
 * worth more than a spec that proves nothing:
 *
 *   `api/src/env.ts:192` is `CALENDAR_DRIVER: z.enum(['stub'])`. ONE value. There
 *   is no second driver to select. `calendar/index.ts` switches on it and its
 *   `default:` arm is an exhaustiveness `never`, so the object every caller reads
 *   is always `StubCalendar`, whose `configured` is the literal `false` and whose
 *   `listBusy` returns `[]` — deliberately, and its header explains why inventing
 *   otherwise would be the worst failure this feature can have.
 *
 * So two arms are UNREACHABLE in any configuration this repository can boot:
 *
 *   availability.ts:205  `if (conn && calendar.configured)` — the live-connection
 *                        arm, which clears the stale notification and returns the
 *                        artist's own windows plus a busy source. `calendar.
 *                        configured` is false, so this is dead until Google lands.
 *   artists.ts:634       `if (syncedIds.length > 0 && calendar.configured)` — the
 *                        block that populates `live`. Same reason, so `live` is
 *                        always empty and `availabilityLive` is `false` for EVERY
 *                        google-sourced artist.
 *
 * There is no fixture, no header and no scenario that reaches either from outside
 * the process, because the branch is on a boot-time constant and not on state. A
 * spec pretending to cover them would be asserting `false === false` through four
 * layers. § THE DRIVER, AND THE TWO ARMS IT MAKES DEAD instead pins the two facts
 * that make them dead, so the day a `google` driver is added those pins go red and
 * name the arms that just became reachable and are still untested.
 *
 * WHAT IS COVERED IS EVERYTHING ELSE, AND IT IS MOST OF IT: the early return, the
 * whole fallback path including both `fallbackReason` values and the merchant
 * notification's dedup, the value validation, both 409s, the accepted request that
 * proves the second 409 is narrow rather than blanket, and `availabilityLive` on
 * the customer's own roster read.
 *
 * DERIVED FROM THE ENUM, AND CROSS-CHECKED AGAINST THE DEPLOYED TYPE
 * -----------------------------------------------------------------
 * There is no list of two sources typed in this file, and there is no fixture per
 * value typed in it either — `beforeAll` MINTS an artist for every value the enum
 * declares, so a third value gets a row, a roster spec, an availability spec and a
 * bookable spec on the day it is added to the enum rather than on the day somebody
 * remembers this file. That is `campaigns.test.ts`'s technique and
 * `support/perm-census.ts`'s before it.
 *
 * READ FROM SOURCE TEXT RATHER THAN IMPORTED, because nothing in `e2e/` imports
 * from `api/src` — `console-reset.test.ts` says so in as many words — and because
 * the cases have to exist at COLLECTION time, before `beforeAll` has provisioned a
 * database, so they cannot come from a query either.
 *
 * THE READER IS `support/source-enums.ts`, shared with `activity-feed.test.ts`,
 * which came out of the same inventory and needs the identical thing. That module
 * carries the argument for stripping comments before matching, for throwing rather
 * than returning `[]` on a failed parse, and for cross-checking every constant
 * against the artifact that is actually deployed. The short version of the throw:
 * a parse that silently found nothing would delete every derived spec below and
 * report this file green with the enum untested — the exact failure it exists to
 * end, reintroduced one level down.
 *
 * AND THE DEPLOYED TYPE IS CROSS-CHECKED. The schema module is not the only gate:
 * `availability_source` is a real Postgres enum type, written out by a migration,
 * and a value added to the `pgEnum` WITHOUT the migration passes Drizzle and then
 * fails on INSERT — the same family of bug as `lapsed`, reached by the same door.
 * So one spec reads `pg_enum` and requires the two lists to agree.
 *
 * SALON B THROUGHOUT, AND ARTISTS OF THIS FILE'S OWN. Every row here is prefixed
 * `AR-QA-SRC-`, so nothing this file does can move a fixture another suite asserts
 * on — and in particular it does not touch `AR-001`, `AR-002` or `AR-004`, lane
 * A's seeded google-sourced artists, which `contract.test.ts` reads availability
 * from. The seed comments already call `AR-004` "the one that proves switching TO
 * google is refused without a calendar"; that proof was never written, and writing
 * it against a shared row would have made this file's refusals depend on file
 * order.
 *
 * A DASHBOARD PRINCIPAL, WHICH IS WHY `module_booking` DOES NOT ARISE.
 * `assertSalonTakesBookings` returns early for every non-member principal
 * (`routes/artists.ts:443`, "Staff read the roster and its hours while setting the
 * salon up"), and salon B has `module_booking = false` in `seedSalonB()`. So every
 * read here is driven by Layla's dashboard session, and the module gate is somebody
 * else's spec.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { precondition } from './support/known-bug.js';
import { stripComments } from './support/perm-census.js';
import { pgEnumFromSource, pgEnumLabels, quotedStrings } from './support/source-enums.js';
import {
  B_STAFF_HANDLE,
  SALON_B,
  psql,
  repoRoot,
  scalar,
  signInDashboard,
  startTenancyApi,
  stopTenancyApi,
  treq,
} from './support/tenancy-harness.js';

/** Layla, salon B's manager, holding all nine permissions. */
let dashboard = '';

const ARTIST_SCHEMA_FILE = join(repoRoot, 'api', 'src', 'db', 'schema', 'artist.ts');
const ENV_FILE = join(repoRoot, 'api', 'src', 'env.ts');
const CALENDAR_STUB_FILE = join(repoRoot, 'api', 'src', 'calendar', 'stub.ts');
const CALENDAR_INDEX_FILE = join(repoRoot, 'api', 'src', 'calendar', 'index.ts');
const AVAILABILITY_SERVICE_FILE = join(repoRoot, 'api', 'src', 'services', 'availability.ts');
const ARTISTS_ROUTE_FILE = join(repoRoot, 'api', 'src', 'routes', 'artists.ts');

const SOURCE_ENUM = pgEnumFromSource(ARTIST_SCHEMA_FILE, 'availabilitySource');
const SOURCES = SOURCE_ENUM.values;

// ---------------------------------------------------------------- fixtures --

/**
 * One artist per enum value, id derived from the value itself.
 *
 * DERIVED SO THE FIXTURE CANNOT FALL BEHIND THE ENUM. A third value gets a row
 * here, and therefore a roster spec, an availability spec and a bookable spec,
 * with no edit to this file.
 *
 * `google_connected = true` on every one of them, which is what makes the fixture
 * derivable at all: `artist_google_source_requires_connection` refuses
 * `availability_source = 'google'` with `google_connected = false`, and
 * connected-but-manual is the combination the CHECK deliberately permits ("the
 * normal state after a receptionist takes the wheel"). So one column value
 * satisfies the constraint for every enum member, present and future.
 */
const artistFor = (source: string): string => `AR-QA-SRC-${source.toUpperCase()}`;

/**
 * The two google artists that differ only in whether a CONNECTION ROW exists, which
 * is the whole of what separates the two `fallbackReason` values.
 *
 * Named rather than derived, because they are not about the enum: they are about
 * `resolveWorkingWindow`'s `const fallbackReason = conn ? 'calendar_unavailable' :
 * 'calendar_not_connected'`, and that ternary exists only on the google path.
 * `NOT_CONNECTED` is `artistFor('google')` reused — it has no connection row by
 * construction — and `UNAVAILABLE` is its own row so that inserting a connection
 * for one cannot change the other's answer.
 */
const ARTIST_UNAVAILABLE = 'AR-QA-SRC-CONNROW';
const CONNECTION_ROW = 'ACC-QA-SRC-CONNROW';

/** The artist the two 409 specs edit, so no derived row is ever left switched. */
const ARTIST_MANUAL_TARGET = 'AR-QA-SRC-TARGET-MANUAL';
const ARTIST_GOOGLE_TARGET = 'AR-QA-SRC-TARGET-GOOGLE';

/** A full seven-day week, which is the only shape `PUT …/availability` accepts. */
function week(
  overrides: Record<string, { open: boolean; from: string; to: string }> = {},
): Record<string, { open: boolean; from: string; to: string }> {
  const base: Record<string, { open: boolean; from: string; to: string }> = {};
  for (const day of ['0', '1', '2', '3', '4', '5', '6']) {
    base[day] = { open: false, from: '10:00', to: '19:00' };
  }
  return { ...base, ...overrides };
}

/** Monday open 10:00–19:00, so a fallback to salon hours is a visible difference. */
const FIXTURE_WEEK = week({ '1': { open: true, from: '10:00', to: '19:00' } });

const ALL_ARTISTS = (): string[] => [
  ...SOURCES.map(artistFor),
  ARTIST_UNAVAILABLE,
  ARTIST_MANUAL_TARGET,
  ARTIST_GOOGLE_TARGET,
];

/**
 * Every fixture row, put back exactly as `beforeAll` wrote it.
 *
 * Run in `beforeEach` rather than once, because two specs below deliberately
 * SUCCEED at changing a source — the accepted google→manual switch, and the
 * derived accept-every-value spec — and a derived loop that ran afterwards would
 * be asserting against whatever the last spec left. `configuration.test.ts`
 * learned the same lesson about `ON CONFLICT DO NOTHING` on a row a spec mutates.
 */
function resetArtists(): void {
  const rows = SOURCES.map(
    (s) =>
      `('${artistFor(s)}', '${SALON_B}', 'QA ${s} source', '${s}', true, 30, ` +
      `'${JSON.stringify(FIXTURE_WEEK)}'::jsonb, true)`,
  );
  rows.push(
    `('${ARTIST_UNAVAILABLE}', '${SALON_B}', 'QA google with a connection row', 'google', true, ` +
      `30, '${JSON.stringify(FIXTURE_WEEK)}'::jsonb, true)`,
  );
  rows.push(
    `('${ARTIST_MANUAL_TARGET}', '${SALON_B}', 'QA manual target', 'manual', false, 30, ` +
      `'${JSON.stringify(FIXTURE_WEEK)}'::jsonb, true)`,
  );
  rows.push(
    `('${ARTIST_GOOGLE_TARGET}', '${SALON_B}', 'QA google target', 'google', true, 30, ` +
      `'${JSON.stringify(FIXTURE_WEEK)}'::jsonb, true)`,
  );

  psql(`
    INSERT INTO artist (id, salon_id, name, availability_source, google_connected,
                        slot_minutes, windows, active)
    VALUES ${rows.join(',\n           ')}
    ON CONFLICT (id) DO UPDATE SET
      availability_source = EXCLUDED.availability_source,
      google_connected    = EXCLUDED.google_connected,
      slot_minutes        = EXCLUDED.slot_minutes,
      windows             = EXCLUDED.windows,
      active              = true;

    -- Exactly one connection row, on exactly one artist. Deleted first rather than
    -- upserted: artist_calendar_connection.artist_id is UNIQUE, and a row left on
    -- the derived google artist by an earlier edit would silently turn its
    -- calendar_not_connected spec into a calendar_unavailable one.
    DELETE FROM artist_calendar_connection
     WHERE artist_id IN (${ALL_ARTISTS().map((a) => `'${a}'`).join(', ')});

    INSERT INTO artist_calendar_connection
      (id, salon_id, artist_id, provider, status, account_email, external_calendar_id,
       credential_ref)
    VALUES ('${CONNECTION_ROW}', '${SALON_B}', '${ARTIST_UNAVAILABLE}', 'google', 'connected',
            'qa-availability-source@example.invalid', 'qa-cal-id', 'qa-credential-ref');
  `);
}

/** Every open `calendar_disconnected` row this file's artists have raised. */
const openCalendarNotifications = (artistId: string): number =>
  Number(
    scalar(
      `select count(*) from merchant_notification
        where salon_id='${SALON_B}' and kind='calendar_disconnected'
          and subject_type='artist' and subject_id='${artistId}' and resolved_at is null`,
    ),
  );

function clearCalendarNotifications(): void {
  psql(`
    DELETE FROM merchant_notification
     WHERE salon_id = '${SALON_B}' AND kind = 'calendar_disconnected'
       AND subject_type = 'artist'
       AND subject_id IN (${ALL_ARTISTS().map((a) => `'${a}'`).join(', ')});
  `);
}

const sourceOf = (artistId: string): string =>
  scalar(`select availability_source from artist where id='${artistId}'`);

const windowsOf = (artistId: string): string =>
  scalar(`select windows::text from artist where id='${artistId}'`);

/**
 * A Monday, near enough ahead to be inside nobody's booking fixtures.
 *
 * MONDAY BECAUSE `FIXTURE_WEEK` OPENS DAY 1, so a manual artist has a window of her
 * own to report and a google artist's fallback to salon hours is a difference the
 * response can show rather than two closed days looking alike.
 *
 * Computed from the wall clock rather than pinned, because a pinned date goes into
 * the past and `computeAvailability` has a `now` in it. The date arithmetic is UTC
 * and salon B is `Asia/Kuwait`; a Monday chosen in UTC 21 days out is still a
 * Monday there, and nothing below asserts on a slot boundary where the three-hour
 * offset could matter.
 */
function nextMonday(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 21);
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

const DATE = nextMonday();

interface AvailabilityBody {
  artistId: string;
  date: string;
  open: boolean;
  slotMinutes: number;
  hoursSource: 'artist_windows' | 'salon_hours';
  fallbackReason: 'calendar_not_connected' | 'calendar_unavailable' | null;
  slots: Array<{ local: string; available: boolean }>;
}

const availability = (artistId: string) =>
  treq<AvailabilityBody>('GET', `/artists/${artistId}/availability?date=${DATE}`, {
    token: dashboard,
  });

interface ArtistRow {
  id: string;
  availabilitySource: string;
  googleConnected: boolean;
  windows: unknown;
}

interface BookableRow {
  id: string;
  name: string;
  availabilityLive: boolean;
}

beforeAll(async () => {
  await startTenancyApi();
  dashboard = await signInDashboard(SALON_B, B_STAFF_HANDLE);
  resetArtists();
}, 180_000);

beforeEach(() => {
  resetArtists();
});

afterAll(async () => {
  /**
   * EVERY ROW THIS FILE CREATED, REMOVED — connections before artists, because
   * `artist_calendar_connection.artist_id` is `ON DELETE restrict`.
   *
   * Hard DELETE rather than the product's own deactivate, for the reason
   * `configuration.test.ts`'s teardown gives: `active = false` leaves the rows on
   * salon B's roster, and `GET /salons/{id}/artists` is the merchant's Team screen,
   * which is no place for a QA suite's scaffolding. Scoped by the `AR-QA-SRC-`
   * prefix so neither statement can reach a fixture row.
   *
   * THE AUDIT ROWS ARE LEFT, AND THE FIRST DRAFT OF THIS TEARDOWN LEARNED WHY THE
   * HARD WAY. The accepted `PUT …/availability` specs write real `audit_log` rows,
   * and a `DELETE` of them fails: "audit_log is append-only: DELETE is not
   * permitted on this table. HINT: Correct a wrong entry by appending a correcting
   * one." That trigger is the product working — `deposit.test.ts` asserts the same
   * refusal for `ledger_entry` as a feature — and a suite that could erase the
   * audit log to tidy up after itself would be the strongest possible argument that
   * the log means nothing. So the rows stay. They are harmless: `audit_log.
   * subject_id` carries no foreign key, so removing the artist beneath them
   * succeeds, and `GET /salons/{id}/audit` is a log of what happened, which
   * includes what this file did.
   */
  clearCalendarNotifications();
  psql(`
    DELETE FROM artist_calendar_connection WHERE salon_id = '${SALON_B}' AND id = '${CONNECTION_ROW}';
    DELETE FROM artist WHERE salon_id = '${SALON_B}' AND id LIKE 'AR-QA-SRC-%';
  `);
  await stopTenancyApi();
});

// ===========================================================================
// THE DERIVATION ITSELF
// ===========================================================================

describe('the derivation — the enum was read, and it is the enum the database has', () => {
  it("`availabilitySource` was read out of lane A's schema, and holds the known positives", () => {
    /**
     * THE PARSER IS LOAD-BEARING, so it is proved against known positives before
     * anything is concluded from it. A regex that matched the declaration but read
     * no strings out of it would make every loop below iterate zero times and
     * report this file green with the enum untested.
     *
     * THE COUNT IS NOT PINNED AT 2. `campaigns.test.ts` § "the derivation itself"
     * settles the reasoning and it applies unchanged: what pinning the count adds
     * is a suite turning red on the day somebody deliberately adds a third value,
     * when this file's whole purpose is that the third is COVERED rather than that
     * it does not exist. The two throws in `pgEnumFromSource()` already guard the
     * emptied-constant case that a pinned count would guard.
     */
    expect(
      SOURCE_ENUM.typeName,
      `no Postgres type name was read out of the pgEnum in ${ARTIST_SCHEMA_FILE}`,
    ).toBe('availability_source');

    expect(
      SOURCES.length,
      `only ${SOURCES.length} value(s) were read out of ${ARTIST_SCHEMA_FILE}. The reader ` +
        'matched the declaration but is mis-reading its contents.',
    ).toBeGreaterThanOrEqual(2);

    for (const known of ['google', 'manual'] as const) {
      expect(
        SOURCES,
        `"${known}" is not among the availability sources read from source ` +
          `(${SOURCES.join(', ')}). Either the enum genuinely lost it, or the reader is ` +
          'wrong — and if the reader is wrong, every derived spec below is testing the ' +
          'wrong set.',
      ).toContain(known);
    }
  });

  it('the deployed Postgres enum admits exactly the values the schema declares', () => {
    /**
     * TWO INDEPENDENT GATES ON ONE COLUMN, and a divergence between them is a 500.
     *
     * Drizzle's `pgEnum` is a TypeScript declaration; `availability_source` is a
     * real Postgres type written out by a migration. A third value added to the
     * declaration and not to the type type-checks, passes the route's
     * `v !== 'google' && v !== 'manual'` rewrite, and then fails on INSERT with an
     * invalid-input-value error — `server_error` on `PUT /artists/{id}/availability`,
     * the same family of bug as `audience: "lapsed"` and reached by the same door.
     *
     * Read from `pg_enum` rather than from the migration file, because what matters
     * is the type that is actually deployed in front of this run.
     */
    const labels = pgEnumLabels(SOURCE_ENUM.typeName);
    expect(
      labels,
      `the Postgres enum type \`${SOURCE_ENUM.typeName}\` is not on this database. Either ` +
        'the migration that creates it was dropped, or it was renamed — in which case this ' +
        'spec is reading nothing and proving nothing.',
    ).not.toEqual([]);

    expect(
      [...labels].sort(),
      'the values the DATABASE admits and the values the SCHEMA MODULE declares disagree.\n' +
        `  pg_enum:            ${labels.join(', ')}\n` +
        `  availabilitySource: ${SOURCES.join(', ')}\n` +
        'A value in the declaration but not in the type answers 500 on write. A value in ' +
        'the type but not in the declaration is unreachable and untested.',
    ).toEqual([...SOURCES].sort());
  });
});

// ===========================================================================
// THE DRIVER, AND THE TWO ARMS IT MAKES DEAD
// ===========================================================================

describe('the calendar driver — what is unreachable, pinned rather than pretended', () => {
  /**
   * THIS SECTION ASSERTS ON SOURCE TEXT, WHICH IS NORMALLY THE WRONG THING FOR AN
   * E2E SUITE TO DO, and it is the right thing here for one reason: the facts that
   * make two branches unreachable are boot-time constants, so there is no request
   * that can observe them and no fixture that can change them. The alternative is
   * silence, and silence is how a branch becomes reachable without anybody noticing
   * that nothing covers it.
   *
   * `api/src/routes/salons.test.ts:418` already reads `routes/artists.ts` as text
   * for the same kind of claim, so the technique is lane A's, not an invention here.
   */
  it('`CALENDAR_DRIVER` has exactly one value, so `calendar.configured` is a constant', () => {
    const env = stripComments(readFileSync(ENV_FILE, 'utf8'));
    const decl = /CALENDAR_DRIVER:\s*z\.enum\(\s*\[([^\]]*)\]\s*\)/.exec(env);
    precondition(
      decl !== null,
      `CALENDAR_DRIVER could not be found as a z.enum in ${ENV_FILE}. This section reads it ` +
        'to prove which calendar branches are reachable; a failed parse proves nothing.',
    );

    const drivers = quotedStrings(decl![1] ?? '');
    expect(
      drivers,
      `no driver was read out of the CALENDAR_DRIVER enum in ${ENV_FILE}`,
    ).not.toEqual([]);

    expect(
      drivers,
      `CALENDAR_DRIVER now offers ${drivers.join(', ')} rather than only "stub".\n\n` +
        'THIS IS NOT A FAILURE OF THIS FILE, IT IS THE NOTICE THIS FILE EXISTS TO GIVE. Two ' +
        'branches were unreachable only because no configured driver existed, and one of ' +
        'them has just become reachable:\n' +
        '  services/availability.ts `if (conn && calendar.configured)` — returns the ' +
        "artist's OWN windows plus a busy source, and resolves the stale notification.\n" +
        '  routes/artists.ts `if (syncedIds.length > 0 && calendar.configured)` — populates ' +
        '`live`, which is the only thing that can make `availabilityLive` true for a ' +
        'google-sourced artist.\n\n' +
        'Both need coverage now, and the three specs in this file that assert ' +
        '`fallbackReason` is non-null and `availabilityLive` is false for google need ' +
        'rewriting against a driver that can actually read a calendar.',
    ).toEqual(['stub']);
  });

  it('the only driver reports itself unconfigured, which is what makes those arms dead', () => {
    const stub = stripComments(readFileSync(CALENDAR_STUB_FILE, 'utf8'));
    const index = stripComments(readFileSync(CALENDAR_INDEX_FILE, 'utf8'));

    expect(
      /readonly configured\s*=\s*false/.test(stub),
      `${CALENDAR_STUB_FILE} no longer declares \`configured = false\`. Every ` +
        '`fallbackReason` and `availabilityLive` assertion in this file depends on it.',
    ).toBe(true);

    // The switch resolves ONCE at boot — `export const calendar = build()` — so no
    // request can change which object the two arms are testing.
    expect(
      /export const calendar\s*:\s*CalendarProvider\s*=\s*build\(\)/.test(index),
      `${CALENDAR_INDEX_FILE} no longer resolves the driver once at module load. If it is ` +
        'now resolved per request, `calendar.configured` is no longer a constant and the ' +
        'two arms this section calls dead may be reachable.',
    ).toBe(true);

    /**
     * AND THE TWO ARMS ARE STILL WRITTEN THE WAY THIS SECTION DESCRIBES THEM.
     * Without this, the section above could keep passing after somebody dropped the
     * `calendar.configured` conjunct — which would make the arm reachable with a
     * stub driver and every `fallbackReason` spec below would go red with no
     * explanation of why.
     */
    const svc = stripComments(readFileSync(AVAILABILITY_SERVICE_FILE, 'utf8'));
    const route = stripComments(readFileSync(ARTISTS_ROUTE_FILE, 'utf8'));
    expect(
      svc.includes('conn && calendar.configured'),
      `services/availability.ts no longer gates the live-connection arm on ` +
        '`conn && calendar.configured`. § THE DRIVER, AND THE TWO ARMS IT MAKES DEAD in ' +
        'e2e/artist-availability-source.test.ts describes that gate; if it has moved, the ' +
        "reachability argument that file's `fallbackReason` specs rest on has moved too.",
    ).toBe(true);
    expect(
      route.includes('syncedIds.length > 0 && calendar.configured'),
      'routes/artists.ts no longer gates the `live` lookup on ' +
        '`syncedIds.length > 0 && calendar.configured`. Same reasoning as above, for ' +
        '`availabilityLive`.',
    ).toBe(true);
  });
});

// ===========================================================================
// 1. THE ROSTER — EVERY VALUE, ROUND-TRIPPED
// ===========================================================================

describe('the roster reports every availability source the enum declares', () => {
  /**
   * `serialiseArtist` puts `availabilitySource` on the wire verbatim, and until this
   * loop every assertion about that field in the repository read `manual`. The claim
   * is thin on purpose — a value stored is a value served — and it is the claim that
   * catches a serialiser that maps an unknown value to a default, which is the
   * quiet version of this whole class of bug.
   */
  for (const source of SOURCES) {
    it(`GET /salons/{id}/artists serves availabilitySource "${source}" as stored`, async () => {
      const res = await treq<{ items: ArtistRow[] }>('GET', `/salons/${SALON_B}/artists`, {
        token: dashboard,
      });
      expect(res.status, res.raw).toBe(200);

      const mine = res.body.items.find((a) => a.id === artistFor(source));
      expect(
        mine,
        `${artistFor(source)} is missing from salon B's roster. \`resetArtists()\` mints one ` +
          'artist per enum value; if this row is absent the fixture, not the route, is what ' +
          'stopped covering this value.',
      ).toBeTruthy();

      expect(
        mine!.availabilitySource,
        `the roster serves "${mine!.availabilitySource}" for an artist stored as "${source}"`,
      ).toBe(source);
      expect(mine!.windows, 'an artist with no week to report').toBeTruthy();
    });
  }
});

// ===========================================================================
// 2. THE AVAILABILITY READ — THE BRANCH AT services/availability.ts:178
// ===========================================================================

describe('the availability read answers for every source, and says where the hours came from', () => {
  /**
   * ONE SPEC PER VALUE, AND THE ASSERTION IS THE CONTRACT'S OWN INVARIANT rather
   * than a per-value expectation typed here. `AvailabilityResult` says
   * `fallbackReason` is "Null unless `hoursSource` is `salon_hours`", and that
   * biconditional is true of every value the enum can ever hold — so it is what a
   * derived loop can honestly assert. The value-SPECIFIC claims are the two named
   * specs underneath, where the reasoning can be written down.
   */
  for (const source of SOURCES) {
    it(`GET /artists/{id}/availability answers 200 for a "${source}" artist, coherently`, async () => {
      const res = await availability(artistFor(source));
      expect(
        res.status,
        `GET /artists/${artistFor(source)}/availability answered ${res.status}.\n${res.raw}\n\n` +
          'A 500 here is this file\'s reason for existing: `resolveWorkingWindow` takes a ' +
          'different path per source and only one of them had ever been driven.',
      ).toBe(200);

      const body = res.body;
      expect(body.artistId).toBe(artistFor(source));
      expect(body.date).toBe(DATE);
      expect(
        ['artist_windows', 'salon_hours'],
        `hoursSource came back as ${JSON.stringify(body.hoursSource)} for source "${source}"`,
      ).toContain(body.hoursSource);

      expect(
        body.fallbackReason === null,
        `for source "${source}" the read reported hoursSource=${body.hoursSource} with ` +
          `fallbackReason=${JSON.stringify(body.fallbackReason)}. \`AvailabilityResult\` says ` +
          'fallbackReason is "Null unless `hoursSource` is `salon_hours`" — a merchant ' +
          'looking at a strangely wide day is told why by exactly one of these two fields, ' +
          'and they have to agree about whether there is a why.',
      ).toBe(body.hoursSource === 'artist_windows');

      if (body.fallbackReason !== null) {
        expect(
          ['calendar_not_connected', 'calendar_unavailable'],
          `fallbackReason came back as ${JSON.stringify(body.fallbackReason)}, which is not ` +
            'one of the two the contract names',
        ).toContain(body.fallbackReason);
      }
    });
  }

  // ------------------------------------------------- the early return, named --
  it('a MANUAL artist is served her own windows, with no fallback and no notification', async () => {
    /**
     * `services/availability.ts:178` — `if (a.availabilitySource !== 'google') return
     * { …hoursSource: 'artist_windows', fallbackReason: null, connection: null }`.
     * The early return, which is the only arm the suite has ever taken, asserted here
     * for the first time as a claim rather than as a side effect of every other spec.
     *
     * AND THE ABSENCE OF THE NOTIFICATION IS THE HALF THAT MATTERS. A manual artist
     * who raised `calendar_disconnected` would ring a merchant's bell about a
     * calendar she has deliberately stopped using — the early return is what
     * prevents that, and nothing checked it.
     */
    clearCalendarNotifications();
    const res = await availability(ARTIST_MANUAL_TARGET);
    expect(res.status, res.raw).toBe(200);

    expect(res.body.hoursSource, 'a manual artist was served salon hours').toBe('artist_windows');
    expect(res.body.fallbackReason).toBeNull();
    expect(
      openCalendarNotifications(ARTIST_MANUAL_TARGET),
      'reading a MANUAL artist\'s availability rang the merchant\'s bell about a calendar. ' +
        'The early return at services/availability.ts:178 is what stops that.',
    ).toBe(0);
  });

  // ---------------------------------------- the fallback, and both its reasons --
  it('a GOOGLE artist with no connection falls back to salon hours and says `calendar_not_connected`', async () => {
    /**
     * THE PATH PAST THE EARLY RETURN, driven for the first time. With no connection
     * row, `resolveWorkingWindow`'s ternary picks `calendar_not_connected`, the span
     * becomes the salon's own hours, and `raiseMerchantNotification` writes the row
     * that tells the merchant to connect a calendar or switch the artist to manual.
     *
     * WHAT IS ASSERTED IS THE TWO FIELDS AND THE NOTIFICATION, not the slot grid.
     * `hoursSource` IS the product's own statement about which week it used — the
     * service calls it "not decoration" and the merchant reads it — so asserting the
     * grid instead would mean re-deriving salon B's trading spans here, and
     * `configuration.test.ts` publishes over that salon's business hours. The claim
     * is the one the contract makes; the arithmetic behind it is `tradingSpans`, and
     * `salon-settings-validation.test.ts` owns that.
     */
    clearCalendarNotifications();
    const artistId = artistFor('google');
    precondition(
      sourceOf(artistId) === 'google',
      `${artistId} is not google-sourced, so this spec cannot exercise the fallback`,
    );

    const res = await availability(artistId);
    expect(res.status, res.raw).toBe(200);
    expect(
      res.body.hoursSource,
      'a google-sourced artist with no connection was served her own windows as though they ' +
        'had been checked against a calendar. That is the failure calendar/stub.ts calls ' +
        '"the single worst failure this feature can have, and it is silent".',
    ).toBe('salon_hours');
    expect(res.body.fallbackReason).toBe('calendar_not_connected');

    expect(
      openCalendarNotifications(artistId),
      'the fallback was applied and the merchant was not told. ' +
        'build-plan.md phase 6 § Done when makes the notification the condition of the ' +
        'fallback being acceptable at all.',
    ).toBe(1);

    const body = scalar(
      `select body from merchant_notification
        where subject_id='${artistId}' and kind='calendar_disconnected' and resolved_at is null`,
    );
    expect(
      body,
      'the `calendar_not_connected` notification does not tell the merchant what to do. The ' +
        'two reasons carry different sentences on purpose — one is "connect her calendar", ' +
        'the other is "AVO has not finished the integration" — and a merchant who gets the ' +
        'wrong one goes looking for a setting that will not help her.',
    ).toContain('no calendar is connected');

    expect(
      scalar(
        `select metadata->>'fallbackReason' from merchant_notification
          where subject_id='${artistId}' and kind='calendar_disconnected' and resolved_at is null`,
      ),
    ).toBe('calendar_not_connected');
  });

  it('and a SECOND read does not ring the bell twice — the open-uniqueness dedup', async () => {
    /**
     * `merchant_notification`'s dedup index, which the schema header names in as many
     * words: "without it, a disconnected calendar mints a row on every availability
     * read". Every customer opening the Book flow would add one, and the merchant's
     * bell would carry a hundred copies of one problem.
     *
     * ASSERTED ACROSS TWO REQUESTS RATHER THAN ONE, because a single read cannot
     * distinguish "wrote one row" from "writes one row every time".
     */
    clearCalendarNotifications();
    const artistId = artistFor('google');

    expect((await availability(artistId)).status).toBe(200);
    expect(openCalendarNotifications(artistId)).toBe(1);
    expect((await availability(artistId)).status).toBe(200);
    expect(
      openCalendarNotifications(artistId),
      'a second availability read minted a second open `calendar_disconnected` row. Every ' +
        "customer opening this artist's day would add one.",
    ).toBe(1);
  });

  it('a GOOGLE artist WITH a connected row says `calendar_unavailable` instead — the driver, not the salon', async () => {
    /**
     * THE OTHER SIDE OF `const fallbackReason = conn ? 'calendar_unavailable' :
     * 'calendar_not_connected'`, which is the only line in the product that
     * distinguishes "this salon has not connected a calendar" from "AVO cannot reach
     * the calendar it connected".
     *
     * The distinction is not cosmetic and the service says why: "Two different
     * sentences for the merchant, because the fix is different." A merchant told to
     * connect a calendar she has already connected is a support ticket.
     *
     * THIS IS ALSO THE CLOSEST ANY SPEC CAN GET TO THE LIVE ARM. The connection row
     * is real and `status = 'connected'`; the only reason control falls through to
     * the fallback is `calendar.configured`. § THE DRIVER pins that, so on the day a
     * google driver lands this spec is the one that changes meaning, and the section
     * above is what will say so.
     */
    clearCalendarNotifications();
    precondition(
      scalar(
        `select status from artist_calendar_connection where artist_id='${ARTIST_UNAVAILABLE}'`,
      ) === 'connected',
      `${ARTIST_UNAVAILABLE} has no connected calendar row, so this spec cannot tell the two ` +
        'fallback reasons apart. `resetArtists()` inserts it.',
    );

    const res = await availability(ARTIST_UNAVAILABLE);
    expect(res.status, res.raw).toBe(200);
    expect(res.body.hoursSource).toBe('salon_hours');
    expect(
      res.body.fallbackReason,
      'an artist with a CONNECTED calendar row was reported as having no calendar connected. ' +
        'The merchant is then told to connect one she has already connected.',
    ).toBe('calendar_unavailable');

    expect(
      scalar(
        `select body from merchant_notification
          where subject_id='${ARTIST_UNAVAILABLE}' and kind='calendar_disconnected'
            and resolved_at is null`,
      ),
      'the `calendar_unavailable` notification carries the `calendar_not_connected` sentence',
    ).toContain('AVO cannot reach that calendar');
  });
});

// ===========================================================================
// 3. THE TWO REFUSALS — routes/artists.ts:284 AND :304
// ===========================================================================

describe('the two refusals the merchant meets, driven for the first time', () => {
  it('switching an artist TO google without a connected calendar is refused, and changes nothing', async () => {
    /**
     * `routes/artists.ts:284`. A 409 `google_not_connected`, and the route's own
     * comment says exactly why it is a 409 in the handler rather than a 500 from the
     * CHECK: "Catching it here means the merchant gets a sentence naming the missing
     * step instead of a constraint-violation 500."
     *
     * Nobody had ever driven it. `artist_google_source_requires_connection` would
     * have answered the same request with `server_error`, and the difference between
     * those two outcomes is the whole of what this branch buys — so it is the
     * difference this spec asserts, by requiring the code AND the status.
     *
     * AND THE ROW IS READ BACK. A refusal that answered 409 and wrote anyway is a
     * worse bug than no refusal, because the merchant believes nothing happened.
     */
    precondition(
      sourceOf(ARTIST_MANUAL_TARGET) === 'manual' &&
        scalar(`select google_connected from artist where id='${ARTIST_MANUAL_TARGET}'`) === 'f',
      `${ARTIST_MANUAL_TARGET} must start manual and unconnected for this refusal to be the ` +
        'one under test',
    );
    const before = windowsOf(ARTIST_MANUAL_TARGET);

    const res = await treq<{ error?: string; message?: string }>(
      'PUT',
      `/artists/${ARTIST_MANUAL_TARGET}/availability`,
      { token: dashboard, body: { availabilitySource: 'google' } },
    );

    expect(
      res.status,
      `switching an unconnected artist to google answered ${res.status}.\n${res.raw}\n\n` +
        'A 500 means the handler check at routes/artists.ts:284 is gone and the database ' +
        'CHECK is answering instead — which is the exact substitution that check exists to ' +
        'prevent. A 200 means the row now claims hours come from a calendar it is not ' +
        'connected to.',
    ).toBe(409);
    expect(res.body.error).toBe('google_not_connected');

    expect(sourceOf(ARTIST_MANUAL_TARGET), 'the refused switch was written anyway').toBe('manual');
    expect(windowsOf(ARTIST_MANUAL_TARGET), 'the refused request rewrote the week').toBe(before);
  });

  it('editing the windows of a GOOGLE-sourced artist is refused, and the week is untouched', async () => {
    /**
     * `routes/artists.ts:304` — "THE REFUSAL THIS ENDPOINT EXISTS TO MAKE REAL." A
     * 409 `availability_is_synced`, because hours that come from a calendar would be
     * overwritten by the next sync, so accepting the edit means a merchant sets a
     * week and finds it gone without being told.
     *
     * Never driven either, and `configuration.test.ts` could not have driven it: its
     * artist is `manual` with `google_connected = false`, and reaching this branch
     * needs a row that is google-sourced, which needs a connected calendar.
     */
    precondition(
      sourceOf(ARTIST_GOOGLE_TARGET) === 'google',
      `${ARTIST_GOOGLE_TARGET} must be google-sourced for this refusal to be reachable`,
    );
    const before = windowsOf(ARTIST_GOOGLE_TARGET);

    const res = await treq<{ error?: string }>(
      'PUT',
      `/artists/${ARTIST_GOOGLE_TARGET}/availability`,
      {
        token: dashboard,
        body: { windows: week({ '3': { open: true, from: '11:00', to: '17:00' } }) },
      },
    );

    expect(
      res.status,
      `editing a google-sourced artist's week answered ${res.status}.\n${res.raw}\n\n` +
        'A 200 means the merchant just set hours that the next sync will silently discard.',
    ).toBe(409);
    expect(res.body.error).toBe('availability_is_synced');
    expect(
      windowsOf(ARTIST_GOOGLE_TARGET),
      'the refused edit was written anyway — the merchant is told no and gets yes',
    ).toBe(before);
  });

  it('a slot change alone is refused the same way — `editsWindows` is not only `windows`', async () => {
    /**
     * `const editsWindows = 'windows' in body || 'slotMinutes' in body`. The
     * disjunction, which the spec above cannot see: a request carrying only
     * `slotMinutes` edits the synced week just as much, because the slot length is
     * what the day is divided into. A refusal that only looked at `windows` would let
     * a merchant regrid a Google-sourced artist and lose it on the next sync — the
     * same outcome, through the other key.
     */
    const res = await treq<{ error?: string }>(
      'PUT',
      `/artists/${ARTIST_GOOGLE_TARGET}/availability`,
      { token: dashboard, body: { slotMinutes: 60 } },
    );
    expect(res.status, res.raw).toBe(409);
    expect(res.body.error).toBe('availability_is_synced');
    expect(
      scalar(`select slot_minutes from artist where id='${ARTIST_GOOGLE_TARGET}'`),
      'the refused slot change was written anyway',
    ).toBe('30');
  });

  it('but switching to manual AND setting the week in ONE request is accepted — the refusal is narrow', async () => {
    /**
     * THE SPEC THAT KEEPS THE ONE ABOVE FROM BEING A BLANKET BAN, and the route
     * describes the flow it protects: "the dashboard's segmented control moves to
     * Manual and the day rows become live — so the request that carries both is
     * accepted, and the one that carries only an edit is not."
     *
     * Without this, a refusal widened to "no edits on a google artist, ever" would
     * pass the spec above and break the only way a receptionist can take the wheel.
     * That is the ordinary flow of the Team screen, and it was as untested as the
     * refusals — because both need a google-sourced artist and no fixture had one.
     */
    const res = await treq<ArtistRow>('PUT', `/artists/${ARTIST_GOOGLE_TARGET}/availability`, {
      token: dashboard,
      body: {
        availabilitySource: 'manual',
        slotMinutes: 45,
        windows: week({ '2': { open: true, from: '12:00', to: '20:00' } }),
      },
    });

    expect(
      res.status,
      `switching to manual and setting the week together answered ${res.status}.\n${res.raw}\n\n` +
        'A 409 here means `editsWindows && nextSource === "google"` is reading the STORED ' +
        'source rather than the one the request is moving to, and reception can no longer ' +
        'take a synced artist off her calendar.',
    ).toBe(200);
    expect(res.body.availabilitySource).toBe('manual');

    // Read back through the database, not from the reply — `PATCH /salons/{id}`
    // echoing its own body is the precedent configuration.test.ts's header names.
    expect(sourceOf(ARTIST_GOOGLE_TARGET)).toBe('manual');
    expect(scalar(`select slot_minutes from artist where id='${ARTIST_GOOGLE_TARGET}'`)).toBe('45');
    expect(
      scalar(`select windows -> '2' ->> 'from' from artist where id='${ARTIST_GOOGLE_TARGET}'`),
      'the week did not persist through the accepted switch',
    ).toBe('12:00');
    expect(
      scalar(`select google_connected from artist where id='${ARTIST_GOOGLE_TARGET}'`),
      'switching to manual dropped the connection flag. Connected-but-manual is the ' +
        'combination the CHECK deliberately permits, and losing the flag means she cannot be ' +
        'switched back.',
    ).toBe('t');
  });

  // ------------------------------------------- the validation, derived negatively --
  it('a value the enum does not declare is refused with 400, not stored and not 500', async () => {
    /**
     * `routes/artists.ts:275`. DERIVED FROM THE ENUM IN THE NEGATIVE DIRECTION: the
     * probe is a string built to be absent from `SOURCES` and checked to be absent,
     * so a third enum value cannot turn this spec into a false negative by
     * accidentally being the probe.
     *
     * The 400 is the interesting number. Without it the value reaches the column and
     * Postgres answers `invalid input value for enum`, which is a 500 on a request a
     * merchant's own client sent — and the shape of THAT bug is the one this whole
     * file is about.
     */
    const probe = 'outlook';
    precondition(
      !SOURCES.includes(probe),
      `the probe "${probe}" is now a real availability source, so this spec is testing the ` +
        'accept path while claiming to test the reject path. Pick another.',
    );

    const res = await treq<{ error?: string; message?: string }>(
      'PUT',
      `/artists/${ARTIST_MANUAL_TARGET}/availability`,
      { token: dashboard, body: { availabilitySource: probe } },
    );

    expect(
      res.status,
      `an unknown availabilitySource answered ${res.status}.\n${res.raw}\n\nA 500 means the ` +
        'route is not validating and the Postgres enum is refusing instead.',
    ).toBe(400);
    expect(res.body.error).toBe('invalid_request');
    expect(sourceOf(ARTIST_MANUAL_TARGET)).toBe('manual');
  });

  /**
   * AND EVERY VALUE THE ENUM DOES DECLARE IS ACCEPTED, one spec each.
   *
   * The other half of the validation at :275, and the half a hardcoded pair of
   * cases cannot keep: a third value added to the enum and the Postgres type, and
   * NOT added to the route's `v !== 'google' && v !== 'manual'`, is refused 400 on a
   * value the schema says is legal. Nothing else in the repository would notice.
   *
   * `ARTIST_GOOGLE_TARGET` is the subject because it starts google-sourced and
   * connected, so it can hold every value the CHECK permits — including `google`
   * itself, which on an unconnected row is the 409 two specs up. `beforeEach` puts
   * it back.
   */
  for (const source of SOURCES) {
    it(`PUT …/availability accepts availabilitySource "${source}" on a connected artist`, async () => {
      const res = await treq<ArtistRow>('PUT', `/artists/${ARTIST_GOOGLE_TARGET}/availability`, {
        token: dashboard,
        body: { availabilitySource: source },
      });

      expect(
        res.status,
        `setting availabilitySource "${source}" answered ${res.status}.\n${res.raw}\n\n` +
          'A 400 means the route validates against a narrower list than the enum declares. ' +
          'A 500 means it validates against a wider one and the database is refusing.',
      ).toBe(200);
      expect(res.body.availabilitySource).toBe(source);
      expect(
        sourceOf(ARTIST_GOOGLE_TARGET),
        `the reply said "${source}" and the row says something else`,
      ).toBe(source);
    });
  }
});

// ===========================================================================
// 4. THE CUSTOMER'S ROSTER — routes/artists.ts:629 AND :655
// ===========================================================================

describe('`availabilityLive` on the bookable roster, per source', () => {
  /**
   * THE FIELD A CUSTOMER'S BOOK FLOW READS, and the only place in the product where
   * `availability_source` reaches a customer at all. `availabilityLive` is
   * `r.availabilitySource !== 'google' || live.has(r.id)`, and `live` is populated
   * only inside `if (syncedIds.length > 0 && calendar.configured)`.
   *
   * DERIVED, AND THE EXPECTATION IS DERIVED TOO rather than being a table of two
   * booleans: with no configured driver — pinned by § THE DRIVER, which fails by
   * name the day that changes — `live` is empty, so the expression collapses to
   * `source !== 'google'` for every value the enum can hold. That is the claim this
   * loop makes, and a third value gets it for free.
   */
  for (const source of SOURCES) {
    it(`a "${source}" artist is on the bookable roster with availabilityLive === ${source !== 'google'}`, async () => {
      const res = await treq<{ items: BookableRow[] }>(
        'GET',
        `/salons/${SALON_B}/artists/bookable`,
        { token: dashboard },
      );
      expect(res.status, res.raw).toBe(200);

      const mine = res.body.items.find((a) => a.id === artistFor(source));
      expect(
        mine,
        `${artistFor(source)} is missing from salon B's bookable roster. She is active, so ` +
          '"bookable" has stopped meaning what the route says it means.',
      ).toBeTruthy();

      expect(
        typeof mine!.availabilityLive,
        `availabilityLive came back as ${JSON.stringify(mine!.availabilityLive)} for source ` +
          `"${source}" — the customer's client branches on it, so it cannot be absent`,
      ).toBe('boolean');

      expect(
        mine!.availabilityLive,
        `a "${source}" artist reports availabilityLive=${mine!.availabilityLive}. With no ` +
          'configured calendar driver `live` is always empty, so the route\'s expression ' +
          'collapses to `source !== "google"`. A google-sourced artist reporting `true` here ' +
          'tells a customer her hours were checked against a calendar nothing read.',
      ).toBe(source !== 'google');
    });
  }

  it('and a google-sourced artist WITH a connected row is still not live — the row is not the driver', async () => {
    /**
     * THE DISTINCTION THE LOOP ABOVE CANNOT DRAW. `live` is filled from
     * `artist_calendar_connection` rows with `status = 'connected'`, and this artist
     * has exactly such a row — so a reader of the route could reasonably expect her
     * to be live. She is not, because the query that would find her row never runs:
     * `calendar.configured` guards it.
     *
     * This is the spec that goes red, correctly, on the day a google driver is
     * configured — at which point it is the one to rewrite, and § THE DRIVER will
     * already have said so in its own failure message.
     */
    const res = await treq<{ items: BookableRow[] }>('GET', `/salons/${SALON_B}/artists/bookable`, {
      token: dashboard,
    });
    expect(res.status, res.raw).toBe(200);

    const mine = res.body.items.find((a) => a.id === ARTIST_UNAVAILABLE);
    expect(mine, `${ARTIST_UNAVAILABLE} is missing from the bookable roster`).toBeTruthy();
    expect(
      mine!.availabilityLive,
      'an artist with a connected calendar row is reported LIVE while the driver cannot read ' +
        'a calendar. Her real busy blocks were never fetched, so a slot her calendar already ' +
        'holds is being offered to a customer.',
    ).toBe(false);
  });

  it('the roster does not leak `availabilitySource` to the customer', async () => {
    /**
     * The route selects `availabilitySource` only to compute `availabilityLive` and
     * says so — "destructured away here by construction rather than deleted from a
     * spread". Worth one spec because the column is an internal integration detail
     * and this is the one endpoint in the file a MEMBER session reaches; a leak here
     * puts "which calendar does my salon use" on a customer's wire.
     */
    const res = await treq<{ items: Array<Record<string, unknown>> }>(
      'GET',
      `/salons/${SALON_B}/artists/bookable`,
      { token: dashboard },
    );
    expect(res.status, res.raw).toBe(200);

    const mine = res.body.items.find((a) => a.id === artistFor('google'));
    expect(mine, 'the google fixture artist is missing from the bookable roster').toBeTruthy();
    expect(
      Object.keys(mine!).sort(),
      'the bookable roster now serves a different key set. If `availabilitySource` is among ' +
        'them, the route is leaking the integration detail it selected only to compute ' +
        '`availabilityLive`.',
    ).toEqual(['availabilityLive', 'id', 'name', 'nameAr', 'salonId']);
  });
});
