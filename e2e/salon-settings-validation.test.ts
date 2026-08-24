/**
 * `businessHours` — THE THIRD JSONB DOOR, NOW CLOSED, AND THE DECISIONS INSIDE IT.
 *
 * HOW TO RUN
 *
 *   pnpm install && turbo run build
 *   pnpm --dir ./api run db:up
 *   cd e2e && ../node_modules/.bin/vitest run salon-settings-validation.test.ts
 *
 * WHAT THIS FILE WAS, AND WHAT IT IS NOW
 * --------------------------------------
 * It was nine `knownBug()`s. `businessHours` sat in `EDITABLE` on
 * `PATCH /salons/{id}` validated by nothing, so the jsonb column took whatever
 * arrived — the same hole `brandColor` and `salon.timezone` had, and flagged from
 * inside the fix that closed one of them.
 *
 * Lane A closed it with `parseBusinessHours` in `api/src/http/fields.ts`, shared by
 * BOTH doors. All nine went red in one run asking for promotion, which is the
 * mechanism working. They are promoted below, and — per the precedent this
 * directory has set twice now — the promoted versions assert MORE than the
 * originals could, because there is now a guard to interrogate rather than a hole
 * to describe.
 *
 * THE HOLE WAS NOT COSMETIC, and lane A's comment names the blast radius better
 * than my original did: `services/availability.ts` calls `tradingSpans` on this
 * document and `hhmmToMinutes` throws a TypeError on anything that is not HH:MM.
 * So one bad Settings save turned EVERY availability read for that salon into a
 * 500 — on the booking screen, three screens from the field that was typed wrong.
 *
 * THREE THINGS ARE ASSERTED, AND THE THIRD IS THE ONE THAT WILL MATTER LATER
 * -------------------------------------------------------------------------
 * 1. THE DOORS AGREE ON SHAPE. `BusinessHoursSchema` is what every client parses
 *    this against and what CREATE already enforced; UPDATE must refuse what the
 *    schema refuses. Verdicts computed from the schema — nothing hardcoded.
 *
 * 2. THE ENDPOINT IS STRICTER THAN THE SCHEMA, DELIBERATELY. The schema is
 *    `z.tuple([z.string(), z.string()])` — "two strings", not "two clock times",
 *    because zod describes the WIRE and the API is the authority on what may be
 *    STORED. So `{ morning: ["banana", "x"] }` passes the schema and the endpoint
 *    refuses it. These specs are new: they are the half of lane A's fix that the
 *    shared schema cannot express, and nothing else drives them.
 *
 * 3. WHAT IS DELIBERATELY ACCEPTED — AND MY BRIEF DESCRIBED THIS WRONG, WHICH IS
 *    EXACTLY WHY IT NEEDED READING RATHER THAN RESTATING.
 *
 *    I was told the fix "refuses a backwards window". It does not, and the code
 *    says why in a comment headed WHAT IS DELIBERATELY NOT REFUSED: `tradingSpans`
 *    already drops a span with `to <= from`, which makes
 *    `evening: ["21:00", "21:00"]` the established way to say "no evening
 *    session" — so refusing it here "would break a salon with no afternoon closure
 *    and no second sitting". The artist-windows route DOES refuse a zero-length
 *    span, correctly, because an open day with no bookable slot is a different
 *    question about the same-looking data.
 *
 *    Verified against the running endpoint rather than taken on trust:
 *    `{morning:["13:00","10:00"]}` answers 200 and is stored.
 *
 *    So the deliberate acceptances get specs of their own. This is the same shape
 *    as `platform-salons.test.ts` pinning that `memberCount` counts tombstones: a
 *    decision that looks like an oversight to the next reader, and which a
 *    well-meaning "tightening" would silently reverse. Refusing `to <= from` here
 *    would be a one-line change that reads like a bug fix and breaks every salon
 *    that trades straight through the afternoon.
 *
 * THE CLOCK RULES ARE READ FROM SOURCE, NOT RESTATED. `HHMM` and
 * `HHMM_OR_END_OF_DAY` are extracted from `api/src/http/fields.ts` as text, the
 * same technique `support/perm-census.ts` uses on the route files. A hand-copied
 * regex would be a second copy of "what counts as a time" — the precise defect
 * lane A's comment says consolidating three copies was fixing.
 *
 * SALON B, and the seeded document is restored after every write. A suite that left
 * a broken `businessHours` behind would 500 the availability reads in whatever file
 * ran next, for a reason having nothing to do with it.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { knownBug, precondition } from './support/known-bug.js';
/** The shared schema — the BUILT package, which is what a client actually consumes. */
import { BusinessHoursSchema } from '../packages/types/dist/index.js';
import {
  B_STAFF_HANDLE,
  SALON_B,
  repoRoot,
  signInDashboard,
  startTenancyApi,
  stopTenancyApi,
  treq,
} from './support/tenancy-harness.js';

let dashboard = '';
/** Salon B's hours as the seed left them. Read, not hardcoded; restored constantly. */
let original: unknown;

// ------------------------------------------------------- the rules, from source --

const FIELDS_SRC = join(repoRoot, 'api', 'src', 'http', 'fields.ts');

/**
 * Lift a named exported regex literal out of `http/fields.ts`.
 *
 * Text extraction rather than an import: `api/src` is not a built package and
 * `fields.ts` pulls in the API's own error helpers, so importing it into `e2e`
 * would drag half the server into this file to learn one regex. The census modules
 * read route files exactly this way.
 */
function regexFromSource(name: string): RegExp {
  const src = readFileSync(FIELDS_SRC, 'utf8');
  const m = new RegExp(`export const ${name}\\s*=\\s*(/.+?/)\\s*;`).exec(src);
  if (!m) {
    throw new Error(
      `could not read ${name} out of api/src/http/fields.ts — the clock rules moved, ` +
        'and this file must follow them rather than keep its own copy.',
    );
  }
  return new RegExp(m[1]!.slice(1, -1));
}

const HHMM = regexFromSource('HHMM');
const HHMM_OR_END_OF_DAY = regexFromSource('HHMM_OR_END_OF_DAY');

/** What the SHARED schema accepts — the SHAPE half. Computed, never listed. */
const schemaAccepts = (v: unknown): boolean => BusinessHoursSchema.safeParse(v).success;

/**
 * What the ENDPOINT accepts: the schema's shape, plus a start that is a wall-clock
 * time and an end that may also be end-of-day. Mirrors `parseBusinessHours`'s own
 * two checks, using its own two regexes.
 */
function endpointAccepts(v: unknown): boolean {
  const parsed = BusinessHoursSchema.safeParse(v);
  if (!parsed.success) return false;
  for (const session of ['morning', 'evening'] as const) {
    const [from, to] = parsed.data[session];
    if (!HHMM.test(from)) return false;
    if (!HHMM_OR_END_OF_DAY.test(to)) return false;
  }
  return true;
}

// ------------------------------------------------------------------ candidates --

/**
 * SHAPE candidates. Inputs only — no verdict written beside any of them. Each is a
 * shape a hand-built request or a half-wired form could genuinely produce.
 */
const SHAPE_CANDIDATES: Array<[string, unknown]> = [
  ['the well-formed document', { morning: ['10:00', '13:00'], evening: ['16:00', '21:00'] }],
  ['an empty object', {}],
  ['only the morning', { morning: ['10:00', '13:00'] }],
  ['a range typed as one string', { morning: '10:00-13:00', evening: ['16:00', '21:00'] }],
  ['a one-element window', { morning: ['10:00'], evening: ['16:00', '21:00'] }],
  ['a three-element window', { morning: ['10:00', '13:00', '15:00'], evening: ['16:00', '21:00'] }],
  ['null', null],
  ['a sentence', 'open all hours'],
  ['an array', []],
  ['numbers instead of times', { morning: [10, 13], evening: ['16:00', '21:00'] }],
];

const SHAPE_REJECTED = SHAPE_CANDIDATES.filter(([, v]) => !schemaAccepts(v));
const SHAPE_ACCEPTED = SHAPE_CANDIDATES.filter(([, v]) => schemaAccepts(v));

/**
 * CLOCK candidates: every one of these passes the shared schema — two strings per
 * session — so the schema has nothing to say about any of them. Which half they
 * land in is decided by the regexes read out of `fields.ts`.
 */
const CLOCK_CANDIDATES: Array<[string, unknown]> = [
  ['a non-time string', { morning: ['banana', 'x'], evening: ['16:00', '21:00'] }],
  ['a 25th hour', { morning: ['25:00', '13:00'], evening: ['16:00', '21:00'] }],
  ['an unpadded hour', { morning: ['9:00', '13:00'], evening: ['16:00', '21:00'] }],
  ['a 61st minute', { morning: ['10:61', '13:00'], evening: ['16:00', '21:00'] }],
  ['an empty string', { morning: ['', '13:00'], evening: ['16:00', '21:00'] }],
  ['end-of-day as a START', { morning: ['24:00', '13:00'], evening: ['16:00', '21:00'] }],
  ['end-of-day as an END', { morning: ['10:00', '13:00'], evening: ['16:00', '24:00'] }],
  ['a backwards window', { morning: ['13:00', '10:00'], evening: ['16:00', '21:00'] }],
  ['a zero-length evening', { morning: ['10:00', '13:00'], evening: ['21:00', '21:00'] }],
  ['midnight to midnight', { morning: ['00:00', '00:00'], evening: ['16:00', '21:00'] }],
];

const CLOCK_REJECTED = CLOCK_CANDIDATES.filter(([, v]) => !endpointAccepts(v));
const CLOCK_ACCEPTED = CLOCK_CANDIDATES.filter(([, v]) => endpointAccepts(v));

// ---------------------------------------------------------------------- helpers --

const readHours = async (): Promise<unknown> => {
  const res = await treq('GET', `/salons/${SALON_B}`, { token: dashboard });
  if (res.status !== 200) {
    throw new Error(`GET /salons/${SALON_B} answered ${res.status}: ${res.raw}`);
  }
  return res.body.businessHours;
};

const setHours = (value: unknown) =>
  treq('PATCH', `/salons/${SALON_B}`, { token: dashboard, body: { businessHours: value } });

/** Put the seeded document back. Called in a `finally` after every write. */
const restore = async () => {
  await setHours(original);
};

beforeAll(async () => {
  await startTenancyApi();
  dashboard = await signInDashboard(SALON_B, B_STAFF_HANDLE);
  original = await readHours();
  precondition(
    schemaAccepts(original),
    `salon B's seeded businessHours does not satisfy the shared schema: ${JSON.stringify(original)}`,
  );
}, 120_000);

afterAll(async () => {
  if (dashboard && original !== undefined) await restore();
  await stopTenancyApi();
});

// ---------------------------------------------------------------------------
describe('The rules this file tests against were read, not written', () => {
  /**
   * The extraction is asserted before it is used. A `regexFromSource` that silently
   * matched something wrong — or a `fields.ts` that renamed its exports — would
   * reclassify every candidate below and the file would still report green, having
   * tested a rule nobody holds.
   */
  it('the two clock regexes came out of api/src/http/fields.ts and behave as named', () => {
    expect(HHMM.test('10:00'), 'HHMM rejects a plain time').toBe(true);
    expect(HHMM.test('23:59')).toBe(true);
    expect(HHMM.test('24:00'), 'HHMM accepts end-of-day as a start, which it must not').toBe(false);
    expect(HHMM.test('9:00'), 'HHMM accepts an unpadded hour').toBe(false);
    expect(HHMM.test('banana')).toBe(false);

    expect(HHMM_OR_END_OF_DAY.test('24:00'), 'end-of-day is not accepted as an end').toBe(true);
    expect(HHMM_OR_END_OF_DAY.test('21:00')).toBe(true);
    expect(HHMM_OR_END_OF_DAY.test('25:00')).toBe(false);
  });

  it('and the candidates split into non-empty halves on both axes', () => {
    expect(typeof BusinessHoursSchema?.safeParse, 'BusinessHoursSchema did not resolve').toBe(
      'function',
    );
    // A zero result is a claim about the command, not about the system.
    expect(SHAPE_ACCEPTED.length, 'no shape candidate is well-formed').toBeGreaterThan(0);
    expect(SHAPE_REJECTED.length, 'no shape candidate is malformed').toBeGreaterThan(0);
    expect(CLOCK_ACCEPTED.length, 'no clock candidate is acceptable').toBeGreaterThan(0);
    expect(CLOCK_REJECTED.length, 'no clock candidate is refusable').toBeGreaterThan(0);

    /*
     * AND THE CLOCK AXIS IS GENUINELY A SECOND AXIS. Every clock candidate passes
     * the SHARED schema, which is the whole reason those specs exist: if any of them
     * failed the schema it would be a shape case in disguise, and the endpoint
     * refusing it would prove nothing about the clock check.
     */
    for (const [label, v] of CLOCK_CANDIDATES) {
      expect(schemaAccepts(v), `the clock candidate "${label}" is really a shape case`).toBe(true);
    }
  });

  /**
   * THE PROBE LANDS. A negative control on `whitelabel.test.ts` proved this is not
   * theoretical: pointed at a mistyped salon id it got `403 forbidden` and thirteen
   * refusal specs reported green while the guard was never asked anything.
   */
  it('a malformed document reaches the handler — the request is answered, not lost', async () => {
    const [, value] = SHAPE_REJECTED[0]!;
    try {
      const res = await setHours(value);
      expect(
        [200, 400],
        `PATCH /salons/${SALON_B} answered ${res.status}. Response: ${res.raw}`,
      ).toContain(res.status);
    } finally {
      await restore();
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
describe('The well-formed document round-trips — the discriminator', () => {
  /**
   * Without this, "refuse every businessHours" would satisfy every refusal spec in
   * this file and break the Settings screen outright.
   */
  for (const [label, value] of SHAPE_ACCEPTED) {
    it(`${label} is accepted and read back through a second request`, async () => {
      try {
        const res = await setHours(value);
        expect(res.status, `a valid document was refused: ${res.raw}`).toBe(200);
        expect(await readHours(), 'the document did not persist').toEqual(value);
      } finally {
        await restore();
      }
    }, 60_000);
  }
});

// ---------------------------------------------------------------------------
describe('Both doors agree on SHAPE — promoted from knownBug, now the guard', () => {
  /**
   * These nine were the file's original nine defects. Promoted verbatim in intent
   * and stronger in assertion: the code is pinned to `invalid_business_hours` — the
   * code the CREATE door already used, so a client branches on one thing — and the
   * stored document is read back rather than the message being matched.
   *
   * The message is deliberately NOT asserted. `parseBusinessHours` writes three
   * different sentences (shape, opens-at, closes-at) and a spec that pinned prose
   * would break on a copy edit while a spec that pins the code would not — the same
   * argument `derive.ts` makes for returning `failed` as data.
   */
  for (const [label, value] of SHAPE_REJECTED) {
    it(`${label} is refused with invalid_business_hours, and nothing is stored`, async () => {
      const known = await readHours();
      try {
        const res = await setHours(value);

        expect(
          res.status,
          `${label} was stored. availability.ts calls hhmmToMinutes on this document and it ` +
            `throws on anything that is not HH:MM, so a bad save 500s every booking read. ` +
            `Response: ${res.raw}`,
        ).toBe(400);
        expect(res.body?.error, 'the update door refuses with a different code than create').toBe(
          'invalid_business_hours',
        );

        // Corroboration, second request: the stored document is untouched.
        expect(await readHours(), `${label} was persisted despite the refusal`).toEqual(known);
      } finally {
        await restore();
      }
    }, 60_000);
  }
});

// ---------------------------------------------------------------------------
describe('The endpoint is STRICTER than the shared schema — the clock check', () => {
  /**
   * The half of lane A's fix that `BusinessHoursSchema` cannot express, and which
   * nothing else in this suite drives. Every value here is two strings per session,
   * so the schema is satisfied and only the endpoint can refuse it.
   */
  for (const [label, value] of CLOCK_REJECTED) {
    it(`${label} passes the schema and the endpoint still refuses it`, async () => {
      const known = await readHours();
      try {
        // Stated per-spec so a failure says which authority was expected to refuse.
        precondition(schemaAccepts(value), `${label} fails the schema, so this is a shape case`);

        const res = await setHours(value);
        expect(
          res.status,
          `${label} was stored, and the shared schema was never going to catch it. ` +
            `Response: ${res.raw}`,
        ).toBe(400);
        expect(res.body?.error).toBe('invalid_business_hours');
        expect(await readHours(), `${label} reached the column`).toEqual(known);
      } finally {
        await restore();
      }
    }, 60_000);
  }
});

// ---------------------------------------------------------------------------
describe('What is DELIBERATELY accepted — protecting a decision, not a behaviour', () => {
  /**
   * THE SECTION MOST LIKELY TO BE READ AS A BUG, WHICH IS WHY IT EXISTS.
   *
   * A backwards window and a zero-length session are STORED, on purpose.
   * `fields.ts` carries the argument under the heading WHAT IS DELIBERATELY NOT
   * REFUSED: `tradingSpans` drops a span whose `to <= from`, so
   * `evening: ["21:00","21:00"]` is how a salon says "no second sitting", and
   * refusing it at the door "would break a salon with no afternoon closure and no
   * second sitting".
   *
   * My own brief told me this fix refused a backwards window. It does not. Asserted
   * here against the running endpoint so the next person to be told that finds a
   * spec instead of a rumour — and so that a future one-line "tightening" that reads
   * like a bug fix goes red with the reason attached.
   */
  for (const [label, value] of CLOCK_ACCEPTED) {
    it(`${label} is stored — refusing it would break a real salon`, async () => {
      try {
        const res = await setHours(value);
        expect(
          res.status,
          `${label} was refused. If that was intentional, fields.ts's "WHAT IS DELIBERATELY ` +
            `NOT REFUSED" comment and services/availability.ts's tradingSpans need revisiting ` +
            `together — a zero-length span is how "no evening session" is expressed. ` +
            `Response: ${res.raw}`,
        ).toBe(200);
        expect(await readHours(), `${label} did not persist`).toEqual(value);
      } finally {
        await restore();
      }
    }, 60_000);
  }
});

// ---------------------------------------------------------------------------
describe('OPEN FINDING (trunk, packages/types) — the schema still accepts any two strings', () => {
  /**
   * STILL OPEN, AND NOW NARROWER THAN WHEN THIS FILE FIRST RECORDED IT.
   *
   * `BusinessHoursSchema` is `z.tuple([z.string(), z.string()])`. Lane A's endpoint
   * check closed the hole AT THE API, so the salon column is safe — but the schema
   * is exported from `@avo/types` and parsed by the wallet, the dashboard and the
   * mock, and it still tells every one of them that `{morning:["banana","x"]}` is a
   * valid business-hours document.
   *
   * WHY THAT IS NOT ACADEMIC NOW THAT THE ENDPOINT IS GUARDED: the schema is what a
   * CLIENT validates against before it submits, and what the mock validates when
   * three lanes build against it. A client that trusts the schema will send a
   * document the API refuses, and the disagreement surfaces as a 400 the form did
   * not predict rather than as a field-level message.
   *
   * ASSERTED AGAINST THE SCHEMA, NOT THE ENDPOINT — deliberately. The endpoint now
   * refuses these, so an endpoint-shaped assertion would go green and hide the
   * finding. `packages/types` is trunk-owned; a lane cannot fix it, and trunk is
   * deciding it. `knownBug` so it goes red the day someone tightens the schema,
   * whoever that is.
   */
  for (const [label, value] of CLOCK_CANDIDATES.filter(([, v]) => !endpointAccepts(v))) {
    knownBug(`BusinessHoursSchema accepts ${label}, which the API refuses`, () => {
      expect(
        schemaAccepts(value),
        `${label} passes the shared schema. Every client and packages/mock parses against ` +
          'this, so they disagree with the API about the same jsonb document.',
      ).toBe(false);
    });
  }

  it('the schema does hold the SHAPE, which is what the agreement specs lean on', () => {
    // Said explicitly so the finding above is not read as "the schema is useless".
    // It catches every structural error; what it does not catch is the CONTENT.
    expect(schemaAccepts({ morning: ['10:00'] })).toBe(false);
    expect(schemaAccepts({ morning: '10:00-13:00', evening: ['16:00', '21:00'] })).toBe(false);
    expect(schemaAccepts(null)).toBe(false);
    expect(schemaAccepts({ morning: ['10:00', '13:00'], evening: ['16:00', '21:00'] })).toBe(true);
  });
});
