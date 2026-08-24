/**
 * `businessHours` — TWO AUTHORITIES, ONE RULE, AND THE ORDERING NOBODY SHOULD FIX.
 *
 * HOW TO RUN
 *
 *   pnpm install && turbo run build
 *   pnpm --dir ./api run db:up
 *   cd e2e && ../node_modules/.bin/vitest run salon-settings-validation.test.ts
 *
 * THE HISTORY, BECAUSE THIS FILE HAS BEEN REWRITTEN BY ITS OWN FINDINGS TWICE
 * --------------------------------------------------------------------------
 * ROUND ONE. `businessHours` was in `EDITABLE` on `PATCH /salons/{id}` validated by
 * nothing — the jsonb column took whatever arrived, and `services/availability.ts`
 * calls `hhmmToMinutes` on the document, which throws a TypeError on anything that
 * is not HH:MM. So one bad Settings save turned every availability read for that
 * salon into a 500, on the booking screen, three screens from the field that was
 * typed wrong. Nine `knownBug()`s recorded it.
 *
 * ROUND TWO. Lane A closed the door with `parseBusinessHours` in
 * `api/src/http/fields.ts`, shared by both doors. The nine went red asking for
 * promotion and were promoted. The file then recorded a SECOND finding, against
 * trunk: `BusinessHoursSchema` was `z.tuple([z.string(), z.string()])`, so
 * `{morning:["banana","x"]}` passed the shared schema even though the API refused
 * it — and the exposure was not the salon column (already safe) but that every
 * CLIENT and `packages/mock` validate against a schema that disagreed with the API,
 * surfacing as an unpredicted 400 rather than a field-level message.
 *
 * ROUND THREE, WHICH IS THIS FILE. Trunk closed that too (`e8ea6b3`):
 * `BusinessHoursSchema` now validates the clock. So the five `knownBug()`s went red
 * asking for promotion, and — more interestingly — the section titled "the endpoint
 * is STRICTER than the shared schema" had its premise removed. They are equally
 * strict on the clock now. Restructured around what is actually still true.
 *
 * WHAT IS ACTUALLY STILL TRUE, AND IT IS NARROW
 * ---------------------------------------------
 * `BusinessHoursSchema` validates that both ends of both sessions are clock times,
 * where `24:00` counts as one. `parseBusinessHours` does that (via the schema) and
 * adds exactly one thing: a session may not START at `24:00`. That is POSITIONAL —
 * the same string is legal as an end and illegal as a start — and a zod tuple of
 * two identically-typed strings cannot express it, which is why it stays at the
 * endpoint.
 *
 * So the remaining divergence is one rule, and this file asserts that it is the ONLY
 * one, computed rather than claimed: every candidate is classified by both
 * authorities and every disagreement between them is required to be a `24:00` start.
 *
 * AND THE ORDERING IS STILL DELIBERATELY UNVALIDATED, BY BOTH.
 * -----------------------------------------------------------
 * A backwards window and a zero-length session are accepted and stored. This is the
 * part of the file most likely to be read as a bug and "fixed":
 *
 *   - `services/availability.ts`'s `tradingSpans` already drops a span whose
 *     `to <= from`, which makes `evening: ["21:00","21:00"]` the established way for
 *     a salon to say "no second sitting".
 *   - so refusing `to <= from` at either door would break a salon with no afternoon
 *     closure and no evening session.
 *   - the artist-windows route DOES refuse a zero-length span, and correctly: an
 *     open DAY with no bookable slot in it is a merchant who meant something else.
 *     Two different questions about the same-looking data.
 *
 * MY OWN BRIEF ASSERTED THE OPPOSITE — that the fix refused a backwards window — and
 * it was wrong, twice, from two directions. Verified against the running endpoint
 * both times rather than restated. That is why the deliberate acceptances have specs
 * of their own here, the same way `platform-salons.test.ts` pins that `memberCount`
 * counts tombstones: a one-line "tightening" that reads like a bug fix is the
 * failure mode, and a passing spec with the reasoning attached is the only thing
 * that stops it.
 *
 * NOTHING BELOW TYPES A THIRD COPY OF WHAT COUNTS AS A TIME. `CLOCK` is lifted from
 * `packages/types/src/entities.ts` and `HHMM` / `HHMM_OR_END_OF_DAY` from
 * `api/src/http/fields.ts`, as text, the technique `support/perm-census.ts` uses on
 * route files. There are already two copies of this rule in the codebase — trunk
 * chose that over inverting the dependency `packages/types` → `api/`, which every
 * surface relies on — and a third living in a test would be the copy nobody reads.
 *
 * SALON B, and the seeded document is restored after every write. A suite that left
 * a broken `businessHours` behind would 500 the availability reads in whatever file
 * ran next, for a reason having nothing to do with it.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { precondition } from './support/known-bug.js';
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

const API_FIELDS = join(repoRoot, 'api', 'src', 'http', 'fields.ts');
const TYPES_ENTITIES = join(repoRoot, 'packages', 'types', 'src', 'entities.ts');

/**
 * Lift a named regex literal out of a source file.
 *
 * Text extraction rather than an import, for two different reasons on the two
 * files: `api/src` is not a built package and `fields.ts` pulls in the API's own
 * error helpers, so importing it would drag half the server in to learn one regex;
 * and `CLOCK` in `entities.ts` is a module-private `const` that is deliberately not
 * exported, so there is nothing to import even from the built package.
 *
 * `export` is optional in the pattern for exactly that reason.
 */
function regexFromSource(file: string, name: string): RegExp {
  const src = readFileSync(file, 'utf8');
  const m = new RegExp(`(?:export\\s+)?const ${name}\\s*=\\s*(/.+?/)\\s*;`).exec(src);
  if (!m) {
    throw new Error(
      `could not read ${name} out of ${file} — the clock rules moved, and this file must ` +
        'follow them rather than keep its own copy.',
    );
  }
  return new RegExp(m[1]!.slice(1, -1));
}

/** The API's two: a start, and an end that may be end-of-day. */
const HHMM = regexFromSource(API_FIELDS, 'HHMM');
const HHMM_OR_END_OF_DAY = regexFromSource(API_FIELDS, 'HHMM_OR_END_OF_DAY');
/** `packages/types`' single one, applied to both ends of both sessions. */
const CLOCK = regexFromSource(TYPES_ENTITIES, 'CLOCK');

// ------------------------------------------------------------------ classifiers --

/** What the SHARED schema accepts — shape AND clock, since `e8ea6b3`. */
const schemaAccepts = (v: unknown): boolean => BusinessHoursSchema.safeParse(v).success;

/**
 * What the ENDPOINT accepts: the schema, plus `parseBusinessHours`'s one extra
 * rule — a session may not START at end-of-day. Mirrors the handler's own two
 * checks using the handler's own two regexes.
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

const hours = (morning: [unknown, unknown], evening: [unknown, unknown] = ['16:00', '21:00']) => ({
  morning,
  evening,
});

/**
 * Inputs only — no verdict written beside any of them. Each is a document a
 * hand-built request or a half-wired form could genuinely produce, spanning shape
 * errors, clock errors, the positional case, and the deliberate acceptances.
 */
const CANDIDATES: Array<[string, unknown]> = [
  // ---- well-formed
  ['the well-formed document', hours(['10:00', '13:00'])],
  // ---- shape: the tuple's own job
  ['an empty object', {}],
  ['only the morning', { morning: ['10:00', '13:00'] }],
  ['a range typed as one string', { morning: '10:00-13:00', evening: ['16:00', '21:00'] }],
  ['a one-element window', hours(['10:00'] as unknown as [unknown, unknown])],
  ['a three-element window', { morning: ['10:00', '13:00', '15:00'], evening: ['16:00', '21:00'] }],
  ['null', null],
  ['a sentence', 'open all hours'],
  ['an array', []],
  ['numbers instead of times', hours([10, 13])],
  // ---- clock: was the API's job alone, now both
  ['a non-time string', hours(['banana', 'x'])],
  ['a 25th hour', hours(['25:00', '13:00'])],
  ['an unpadded hour', hours(['9:00', '13:00'])],
  ['a 61st minute', hours(['10:61', '13:00'])],
  ['an empty string', hours(['', '13:00'])],
  ['a minute past end-of-day', hours(['24:01', '13:00'])],
  // ---- position: the API's job alone, and still is
  ['end-of-day as a START', hours(['24:00', '13:00'])],
  ['end-of-day starting the EVENING', hours(['10:00', '13:00'], ['24:00', '21:00'])],
  // ---- deliberately accepted
  ['end-of-day as an END', hours(['10:00', '13:00'], ['16:00', '24:00'])],
  ['a backwards window', hours(['13:00', '10:00'])],
  ['a zero-length evening', hours(['10:00', '13:00'], ['21:00', '21:00'])],
  ['midnight to midnight', hours(['00:00', '00:00'])],
];

/** Refused by the shared schema — shape or clock. */
const SCHEMA_REFUSES = CANDIDATES.filter(([, v]) => !schemaAccepts(v));
/** Accepted by the schema AND by the endpoint: what a merchant may actually store. */
const BOTH_ACCEPT = CANDIDATES.filter(([, v]) => schemaAccepts(v) && endpointAccepts(v));
/** The divergence: the schema allows it, the endpoint does not. */
const ENDPOINT_ONLY_REFUSES = CANDIDATES.filter(([, v]) => schemaAccepts(v) && !endpointAccepts(v));

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

// ===========================================================================
// The two copies of one rule
// ===========================================================================
describe('`CLOCK` and `HHMM_OR_END_OF_DAY` are two copies of one rule, and they agree', () => {
  /**
   * TRUNK INTRODUCED THIS RISK ON PURPOSE AND ASKED FOR IT TO BE GUARDED.
   *
   * `packages/types` cannot import from `api/` — that inverts the dependency every
   * surface relies on — so closing the schema hole meant `entities.ts` growing its
   * own `CLOCK` beside `fields.ts`'s `HHMM_OR_END_OF_DAY`. Two copies of "what counts
   * as a time", which is precisely the defect `fields.ts` was created to end when it
   * consolidated three.
   *
   * A duplicated rule is not automatically wrong; an UNWATCHED duplicated rule is.
   * The copy that drifts is the one nobody is reading, and the drift would not be
   * loud: a client would start accepting a time the API refuses, or refusing one the
   * API takes, and the symptom would be a 400 no form predicted.
   *
   * So the two are compared over a GENERATED corpus rather than a hand-picked list.
   * A list of examples proves agreement on the examples someone thought of; a
   * generated sweep of every hour and a set of malformed forms is the same question
   * asked where the answers are hard.
   */
  const corpus = ((): string[] => {
    const out = new Set<string>();
    for (let h = 0; h <= 25; h++) {
      for (const m of [0, 1, 5, 30, 59, 60, 61]) {
        const hh = String(h).padStart(2, '0');
        const mm = String(m).padStart(2, '0');
        out.add(`${hh}:${mm}`);
        out.add(`${h}:${mm}`); // unpadded hour — "9:00"
        out.add(`${hh}:${m}`); // unpadded minute — "10:0"
      }
    }
    for (const junk of [
      '', ' ', '  ', '10', '10:', ':00', '::', 'banana', '1000', '10:00:00', '1O:00',
      '10-00', '10.00', '24:01', '24:59', '99:99', '-1:00', '+10:00', '10:00 ', ' 10:00',
      '١٠:٠٠', '10:00am', 'noon', 'null', 'undefined', '0:0', '000:00', '10:000',
    ]) {
      out.add(junk);
    }
    return [...out];
  })();

  it('the corpus is big enough and mixed enough to be a test', () => {
    // A sweep that is all-accept or all-refuse proves nothing about agreement:
    // two regexes that both say yes to everything also "agree".
    expect(corpus.length, 'the corpus is too small to be a sweep').toBeGreaterThan(200);
    const accepted = corpus.filter((s) => CLOCK.test(s));
    expect(accepted.length, 'nothing in the corpus is a valid clock').toBeGreaterThan(20);
    expect(
      corpus.length - accepted.length,
      'everything in the corpus is a valid clock',
    ).toBeGreaterThan(20);
  });

  it('every string in the corpus is judged identically by both copies', () => {
    const disagreements = corpus
      .filter((s) => CLOCK.test(s) !== HHMM_OR_END_OF_DAY.test(s))
      .map((s) => `${JSON.stringify(s)}: types=${CLOCK.test(s)} api=${HHMM_OR_END_OF_DAY.test(s)}`);

    expect(
      disagreements,
      'packages/types and api/src/http/fields.ts disagree about what counts as a clock time. ' +
        'These are two copies of one rule — trunk chose duplication over inverting the ' +
        'packages/types -> api dependency — so they must be changed together:\n  ' +
        disagreements.join('\n  '),
    ).toEqual([]);
  });

  it('and `HHMM` is the same rule MINUS end-of-day, which is the whole positional story', () => {
    /*
     * Stated as a relationship rather than as two regexes' contents, because the
     * relationship is the design: one string, legal as an end and illegal as a start.
     * `24:00` must be the ONLY thing they differ on — if `HHMM` ever diverged
     * further, the endpoint would be refusing starts the schema calls valid for
     * reasons nobody wrote down.
     */
    const differ = corpus.filter((s) => HHMM.test(s) !== HHMM_OR_END_OF_DAY.test(s));
    expect(
      differ,
      `HHMM and HHMM_OR_END_OF_DAY differ on more than end-of-day: ${JSON.stringify(differ)}`,
    ).toEqual(['24:00']);
  });
});

// ===========================================================================
// The classification the rest of this file rests on
// ===========================================================================
describe('The candidates classify into three non-empty groups', () => {
  /**
   * THIS GUARD HAS NOW CAUGHT ITS OWN OBSOLESCENCE TWICE, WHICH IS THE POINT OF IT.
   *
   * Its previous form asserted that the candidates split into a SHAPE axis and a
   * CLOCK axis, and that every clock candidate passed the shared schema. Trunk's
   * schema fix made the second half false — clock candidates are schema cases now —
   * and this spec went red rather than the file quietly testing an axis that no
   * longer existed. Same event as `gated + ungated == totalRoutes` breaking when the
   * census learned to expand an indexed gate.
   *
   * The three groups it now guards are the three the file is organised around, and
   * each has to be non-empty or a whole section below is vacuous.
   */
  it('schema-refuses, both-accept and endpoint-only-refuses are all populated', () => {
    expect(typeof BusinessHoursSchema?.safeParse, 'BusinessHoursSchema did not resolve').toBe(
      'function',
    );
    expect(SCHEMA_REFUSES.length, 'nothing is refused by the schema').toBeGreaterThan(0);
    expect(BOTH_ACCEPT.length, 'nothing is accepted by both, so the round-trip proves nothing').toBeGreaterThan(0);
    expect(
      ENDPOINT_ONLY_REFUSES.length,
      'no candidate separates the endpoint from the schema, so the positional section is vacuous',
    ).toBeGreaterThan(0);

    // The three are a partition: every candidate lands in exactly one.
    expect(
      SCHEMA_REFUSES.length + BOTH_ACCEPT.length + ENDPOINT_ONLY_REFUSES.length,
      'a candidate is in two groups or none',
    ).toBe(CANDIDATES.length);
  });

  /**
   * THE CENTRAL CLAIM OF THIS FILE, COMPUTED RATHER THAN ASSERTED.
   *
   * After trunk's fix the two authorities agree on everything except one rule. Rather
   * than assert that by listing the one case, every disagreement is derived and each
   * is REQUIRED to be a start of `24:00`. So if lane A ever adds a second
   * endpoint-only rule — an ordering check, a maximum span, anything — this fails and
   * names it, instead of the new rule going unnoticed because the file only knew
   * about the old one.
   */
  it('the ONLY thing the endpoint refuses that the schema allows is a session starting at end-of-day', () => {
    for (const [label, value] of ENDPOINT_ONLY_REFUSES) {
      const parsed = BusinessHoursSchema.safeParse(value);
      precondition(parsed.success, `${label} does not parse, so it is a schema case`);
      const starts = [parsed.data.morning[0], parsed.data.evening[0]];
      expect(
        starts.some((s) => s === '24:00'),
        `"${label}" is refused by the endpoint and allowed by the schema for some reason other ` +
          `than a 24:00 start (starts: ${JSON.stringify(starts)}). A second endpoint-only rule ` +
          'has appeared and this file does not know about it.',
      ).toBe(true);
    }
  });

  /**
   * THE PROBE LANDS. A negative control on `whitelabel.test.ts` proved this is not
   * theoretical: pointed at a mistyped salon id it got `403 forbidden` and thirteen
   * refusal specs reported green while the guard was never asked anything.
   */
  it('a malformed document reaches the handler — the request is answered, not lost', async () => {
    const [, value] = SCHEMA_REFUSES[0]!;
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

// ===========================================================================
// What a merchant may store
// ===========================================================================
describe('Everything both authorities accept round-trips — the discriminator', () => {
  /**
   * Without these, "refuse every businessHours" would satisfy every refusal spec in
   * this file and break the Settings screen outright. They also carry the deliberate
   * acceptances — a backwards window, a zero-length evening, end-of-day as an end —
   * which is the section a future "tightening" has to get past.
   */
  for (const [label, value] of BOTH_ACCEPT) {
    it(`${label} is stored and read back through a second request`, async () => {
      try {
        const res = await setHours(value);
        expect(
          res.status,
          `${label} was refused. If deliberate, fields.ts's "WHAT IS DELIBERATELY NOT REFUSED" ` +
            `note and availability.ts's tradingSpans need revisiting together — a zero-length ` +
            `span is how "no evening session" is expressed. Response: ${res.raw}`,
        ).toBe(200);
        expect(await readHours(), `${label} did not persist`).toEqual(value);
      } finally {
        await restore();
      }
    }, 60_000);
  }
});

// ===========================================================================
// Both doors, one code
// ===========================================================================
describe('Everything the shared schema refuses, the endpoint refuses too', () => {
  /**
   * PROMOTED TWICE OVER. Nine of these were the file's original defects, closed by
   * lane A's `parseBusinessHours`. Five more were the trunk finding — the schema
   * accepting a non-clock string — closed by `e8ea6b3`, and their `knownBug`s went
   * red asking for promotion.
   *
   * Promoted STRONGER than either original, and the addition is the interesting part:
   * these no longer assert only that the ENDPOINT refuses, but that BOTH authorities
   * do. The whole point of the trunk fix was that clients and `packages/mock`
   * validate against the schema, so a value the API rejects must not look valid to
   * the form that is about to submit it. Asserting one side would have left the
   * disagreement that was the actual finding unguarded.
   *
   * The code is pinned to `invalid_business_hours`; the MESSAGE is deliberately not
   * asserted, because `parseBusinessHours` writes three different sentences (shape,
   * opens-at, closes-at) and a spec that pinned prose would break on a copy edit
   * while a spec that pins the code would not.
   */
  for (const [label, value] of SCHEMA_REFUSES) {
    it(`${label} — refused by the schema AND by the endpoint, with nothing stored`, async () => {
      // The client-side authority. This half was the trunk finding.
      expect(
        schemaAccepts(value),
        `${label} passes BusinessHoursSchema, so every client and packages/mock believes it is ` +
          'valid while the API refuses it — an unpredicted 400 rather than a field-level message.',
      ).toBe(false);

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

        // Corroboration, second request.
        expect(await readHours(), `${label} was persisted despite the refusal`).toEqual(known);
      } finally {
        await restore();
      }
    }, 60_000);
  }
});

// ===========================================================================
// The one rule that is positional, and stays at the endpoint
// ===========================================================================
describe('A session may not START at end-of-day — the endpoint\'s one remaining rule', () => {
  /**
   * THIS SECTION REPLACES "the endpoint is STRICTER than the shared schema", whose
   * premise trunk removed. They are equally strict on the CLOCK now. What is left is
   * one POSITIONAL rule, and it is at the endpoint because a zod tuple of two
   * identically-typed strings cannot say "this string is legal here and not there".
   *
   * `db/schema/promotion.ts` carries the underlying argument: `24:00` is a real END
   * and never a real START, because `hhmmToMinutes` resolves it to 1440 and a window
   * that begins at end-of-day has no length. `HHMM_OR_END_OF_DAY` exists for the end;
   * `HHMM` is the same rule minus that one string, which the regex section above pins
   * as their only difference.
   */
  for (const [label, value] of ENDPOINT_ONLY_REFUSES) {
    it(`${label} passes the schema and the endpoint still refuses it`, async () => {
      // The premise, stated per-spec: this is genuinely the divergence and not a
      // clock case that drifted into the wrong group.
      expect(schemaAccepts(value), `${label} fails the schema, so it is not a positional case`).toBe(
        true,
      );

      const known = await readHours();
      try {
        const res = await setHours(value);
        expect(
          res.status,
          `${label} was stored, and the shared schema was never going to catch it — a tuple of ` +
            `two identically-typed strings cannot express "not in this position". ` +
            `Response: ${res.raw}`,
        ).toBe(400);
        expect(res.body?.error).toBe('invalid_business_hours');
        expect(await readHours(), `${label} reached the column`).toEqual(known);
      } finally {
        await restore();
      }
    }, 60_000);
  }

  it('the same string is accepted as an END, which is what makes the rule positional', async () => {
    // Not a separate fact — the SAME `24:00` that was refused above, moved one slot.
    // Without this the refusals above would be consistent with `24:00` simply being
    // an invalid clock time, which is what the schema fix might have made it.
    const value = hours(['10:00', '13:00'], ['16:00', '24:00']);
    precondition(endpointAccepts(value), 'end-of-day is no longer accepted as an end either');
    try {
      const res = await setHours(value);
      expect(res.status, `end-of-day was refused as an END too: ${res.raw}`).toBe(200);
      expect(await readHours()).toEqual(value);
    } finally {
      await restore();
    }
  }, 60_000);
});
