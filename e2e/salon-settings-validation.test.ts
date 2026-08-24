/**
 * `PATCH /salons/{id}` — THE LAST FIELD ON THIS ROUTE WITH AN UNGUARDED DOOR.
 *
 * HOW TO RUN
 *
 *   pnpm install
 *   pnpm --dir ./api run db:up
 *   cd e2e && ../node_modules/.bin/vitest run salon-settings-validation.test.ts
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `businessHours` is in the `EDITABLE` set at `api/src/routes/salons.ts:104` and
 * nothing validates it. The column is jsonb, so it takes whatever arrives.
 *
 * This is the same hole `brandColor` had, and it is documented from inside the fix
 * that closed the other one. `services/salonOnboarding.ts` validates the field on
 * CREATE through the shared `BusinessHoursSchema`, and says so beside it:
 *
 *   "NOTE, REPORTED: `PATCH /salons/{id}` lists `businessHours` as editable and does
 *    NOT validate it — the jsonb column takes whatever arrives. That is the same
 *    shape of hole `brandColor` had and it is a separate defect from this slice;
 *    flagged rather than fixed here because it is not what this change is about."
 *
 * Which is the right call for that change and exactly why this file has to exist: a
 * defect flagged in a comment is a defect nothing will notice being fixed, and
 * nothing will notice growing worse. `whitelabel.test.ts` is the precedent — the
 * claim "validated through deriveBrandSet() at onboarding" sat in the schema file
 * for weeks being false.
 *
 * WHAT IS ACTUALLY BEING ASSERTED: THAT THE TWO DOORS AGREE
 * --------------------------------------------------------
 * Not "businessHours is valid" — that is a rule this file would be inventing. The
 * assertion is narrower and entirely derived: `BusinessHoursSchema` is the shared
 * schema every client parses this document against, and CREATE already enforces it.
 * So whatever the schema says, the UPDATE door must say too. A field the API accepts
 * through one door and refuses through another is, in the onboarding file's own
 * words, "a disagreement about the same jsonb document".
 *
 * So the verdicts here are computed by calling `BusinessHoursSchema.safeParse` on
 * each candidate, exactly as `whitelabel.test.ts` calls `deriveBrandSet`. Nothing
 * below hardcodes which shapes are wrong; tighten or loosen the schema and this file
 * follows on the next run.
 *
 * WHY IT MATTERS BEYOND TIDINESS. `services/availability.ts` reads this document to
 * decide what "10:00" means for every bookable slot, and the timezone comment on
 * `salons.ts` makes the general point about this class of field: an unvalidated
 * value here "would not fail loudly — it would make `Intl.DateTimeFormat` throw
 * inside a charge, three screens away from the field that was typed wrong". A
 * merchant who saves `{ morning: "10-1" }` breaks her own booking grid, and the
 * request that did it answered 200.
 *
 * TWO FINDINGS, WITH DIFFERENT OWNERS, AND THE SECOND IS NOT LANE A'S
 * -------------------------------------------------------------------
 * 1. THE UPDATE DOOR (lane A, `routes/salons.ts`): every shape the shared schema
 *    rejects is stored by `PATCH` today. Recorded as `knownBug()` below, one per
 *    shape, so each goes red by name when the door closes.
 *
 * 2. THE SHARED SCHEMA ITSELF (trunk, `packages/types`): `BusinessHoursSchema` is
 *    `z.tuple([z.string(), z.string()])`, which accepts ANY two strings. So
 *    `{ morning: ["banana", "x"] }` and a backwards window `["13:00", "10:00"]` pass
 *    validation — on BOTH doors, including the create path that already validates.
 *    Closing finding 1 does not close finding 2. Recorded separately and attributed
 *    separately, because `packages/types` is trunk-owned and a lane cannot change it.
 *
 * SALON B, and the original document is restored after every write — a suite that
 * left a broken `businessHours` behind would break availability in whatever file ran
 * next, for a reason having nothing to do with it.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { knownBug, precondition } from './support/known-bug.js';
/** The shared schema — the BUILT package, which is what a client actually consumes. */
import { BusinessHoursSchema } from '../packages/types/dist/index.js';
import {
  B_STAFF_HANDLE,
  SALON_B,
  signInDashboard,
  startTenancyApi,
  stopTenancyApi,
  treq,
} from './support/tenancy-harness.js';

let dashboard = '';
/** Salon B's hours as the seed left them. Read, not hardcoded; restored constantly. */
let original: unknown;

/**
 * CANDIDATE DOCUMENTS. Inputs only — no verdict is written beside any of them. Each
 * is a shape a hand-built request or a half-wired form could genuinely produce.
 */
const CANDIDATES: Array<[string, unknown]> = [
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

/** What the SHARED schema accepts. Computed, never listed. */
const schemaAccepts = (v: unknown): boolean => BusinessHoursSchema.safeParse(v).success;

const REJECTED = CANDIDATES.filter(([, v]) => !schemaAccepts(v));
const ACCEPTED = CANDIDATES.filter(([, v]) => schemaAccepts(v));

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
describe('The sweep is pointed at something', () => {
  /**
   * The vacuity guard, for the reason `whitelabel.test.ts` carries one: every
   * `knownBug` below iterates `REJECTED`, and an empty `REJECTED` — a schema import
   * that silently resolved to a stub — would report a confident row of green having
   * asked the server nothing.
   */
  it('the shared schema loaded, and splits the candidates into two non-empty halves', () => {
    expect(typeof BusinessHoursSchema?.safeParse, 'BusinessHoursSchema did not resolve').toBe(
      'function',
    );
    expect(ACCEPTED.length, 'no candidate is well-formed — the accepted half proves nothing').toBeGreaterThan(0);
    expect(REJECTED.length, 'no candidate is malformed — every knownBug below is vacuous').toBeGreaterThan(0);
  });

  /**
   * THE PROBE LANDS. `knownBug()` reports green on ANY assertion failure and cannot
   * tell which, so a mistyped path or a stale token would read as a confirmed
   * defect. A negative control on `whitelabel.test.ts` proved this is not
   * theoretical: pointed at a wrong salon id it got `403 forbidden` and thirteen
   * refusal specs reported green while the guard was never asked anything.
   */
  it('a malformed document reaches the handler — the request is answered, not lost', async () => {
    const [, value] = REJECTED[0]!;
    try {
      const res = await setHours(value);
      expect(
        [200, 400],
        `PATCH /salons/${SALON_B} answered ${res.status} — the knownBugs below would all ` +
          `report green on this. Response: ${res.raw}`,
      ).toContain(res.status);
    } finally {
      await restore();
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
describe('The well-formed document still round-trips — the discriminator', () => {
  /**
   * Passes today and must still pass once the door closes. Without it, "refuse every
   * businessHours" would satisfy every other spec in this file and break the
   * Settings screen outright.
   */
  for (const [label, value] of ACCEPTED) {
    it(`${label} is accepted and read back through a second request`, async () => {
      try {
        const res = await setHours(value);
        expect(res.status, `a schema-valid document was refused: ${res.raw}`).toBe(200);
        expect(await readHours(), 'the document did not persist').toEqual(value);
      } finally {
        await restore();
      }
    }, 60_000);
  }
});

// ---------------------------------------------------------------------------
describe('FINDING 1 (lane A) — the update door stores what the create door refuses', () => {
  for (const [label, value] of REJECTED) {
    knownBug(
      `PATCH /salons/{id} stores businessHours as ${label}, which BusinessHoursSchema rejects`,
      async () => {
        const known = await readHours();
        try {
          const res = await setHours(value);

          /*
           * THE REFUSAL IS THE ASSERTION. And the code is the create door's own —
           * `invalid_business_hours`, from `parseBusinessHours` in
           * `services/salonOnboarding.ts`. Demanding the SAME code is the point of
           * the whole file: two doors onto one document should refuse it the same
           * way, so the console can branch on one thing.
           */
          expect(
            res.status,
            `${label} was stored. availability.ts reads this document to decide what "10:00" ` +
              `means for every bookable slot. Response: ${res.raw}`,
          ).toBe(400);
          expect(res.body?.error, 'the update door refuses with a different code than create').toBe(
            'invalid_business_hours',
          );
          expect(res.body?.message, 'the refusal has no copy the form can render').toBeTruthy();

          // Corroboration, second request.
          expect(await readHours(), `${label} was persisted despite the refusal`).toEqual(known);
        } finally {
          await restore();
        }
      },
      60_000,
    );
  }
});

// ---------------------------------------------------------------------------
describe('FINDING 2 (trunk, packages/types) — the shared schema accepts any two strings', () => {
  /**
   * A DIFFERENT DEFECT WITH A DIFFERENT OWNER, and it survives the fix above.
   *
   * `BusinessHoursSchema` is `z.tuple([z.string(), z.string()])`. A tuple of two
   * strings is all it checks — so these documents pass validation on BOTH doors,
   * including the create path that already calls the schema. Closing finding 1
   * routes these straight through the new guard.
   *
   * Recorded here rather than in a report to lane A because the owner is different:
   * `packages/types` is trunk-owned and shared by four surfaces, so tightening it is
   * a trunk operation and a field rename is a four-way break. Written as `knownBug`
   * so it goes red the day someone tightens it, whoever that is.
   *
   * THE ASSERTION IS DELIBERATELY ON THE SCHEMA, NOT ON THE ENDPOINT. Asserting the
   * endpoint refuses these would be asserting a rule that does not exist yet, and it
   * would go red on lane A for a defect that is not theirs.
   */
  const WEAK: Array<[string, unknown]> = [
    ['a non-time string', { morning: ['banana', 'x'], evening: ['y', 'z'] }],
    ['a backwards window', { morning: ['13:00', '10:00'], evening: ['16:00', '21:00'] }],
    ['an empty string', { morning: ['', ''], evening: ['16:00', '21:00'] }],
    ['a 25th hour', { morning: ['25:00', '99:99'], evening: ['16:00', '21:00'] }],
  ];

  for (const [label, value] of WEAK) {
    knownBug(
      `BusinessHoursSchema accepts ${label} — ${JSON.stringify(value)}`,
      () => {
        expect(
          schemaAccepts(value),
          `${label} passes the shared schema, so it passes BOTH doors — the create path ` +
            'validates against this schema and would store it too.',
        ).toBe(false);
      },
    );
  }

  it('the schema does at least hold the SHAPE, which is what finding 1 leans on', () => {
    // Said explicitly so finding 2 is not read as "the schema is useless". It
    // catches every structural error; what it does not catch is the CONTENT.
    expect(schemaAccepts({ morning: ['10:00'] })).toBe(false);
    expect(schemaAccepts({ morning: '10:00-13:00', evening: ['16:00', '21:00'] })).toBe(false);
    expect(schemaAccepts(null)).toBe(false);
    expect(schemaAccepts({ morning: ['10:00', '13:00'], evening: ['16:00', '21:00'] })).toBe(true);
  });
});
