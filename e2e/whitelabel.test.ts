/**
 * NON-NEGOTIABLE #9, SECOND CLAUSE: THE WRITE PATH FOR A BRAND COLOUR.
 *
 * HOW TO RUN
 *
 *   pnpm install
 *   pnpm --dir ./api run db:up
 *   cd e2e && ../node_modules/.bin/vitest run whitelabel.test.ts
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * #9 has two clauses and only the first one is guarded anywhere. The first —
 * "white text never goes on `--avo-brand`, use `--avo-brand-deep`" — is settled
 * in `packages/tokens` and proved by `derive.test.ts`. The second is a rule about
 * an ENDPOINT:
 *
 *   "Validate derived variants at white-label onboarding with `deriveBrandSet()`;
 *    reject a hex that cannot produce a 4.5:1 fill."
 *
 * Nothing rejects anything. `brandColor` sits in the `EDITABLE` set at
 * `api/src/routes/salons.ts:74` with no validation attached, so the only guard on
 * the field is the database's 6-hex regex CHECK — a guard on the SHAPE of the
 * string, which has nothing to say about contrast. `PATCH /salons/{id}` with
 * `#FFFF00` is accepted and stored today, and the wallet then renders white text
 * on a fill measuring 4.25:1.
 *
 * WHY THE EXISTING COVERAGE DOES NOT CATCH IT, WHICH IS THE MORE USEFUL POINT.
 * `configuration.test.ts` already has a spec whose title mentions the 4.5:1 fill:
 *
 *   it('a brand colour that cannot make a 4.5:1 fill is still served, and the
 *      derived variant is the client's job', …)
 *       expect(s.brandColor).toMatch(/^#[0-9a-fA-F]{6}$/);
 *
 * That spec is not wrong and is not deleted — what it asserts (the API serves the
 * source colour in a shape the deriver can read) is true and worth holding. But
 * it reads a SEEDED value, and the seed is `#7A5C8E`, which derives fine. It is
 * an assertion about a fixture wearing the vocabulary of an assertion about a
 * guard, and it would go on passing if the write path accepted pure white. This
 * build has been bitten by that exact shape three times, so the distinction is
 * worth stating: a fixture cannot witness a guard, because the guard is never
 * asked anything.
 *
 * WHAT THIS FILE ASSERTS INSTEAD: it WRITES. Every claim below goes through
 * `PATCH /salons/{id}` — the funnel a merchant and Lane C's wizard both use — and
 * then reads the value back through a second request.
 *
 * THE VERDICTS ARE DERIVED, NOT LISTED
 * ------------------------------------
 * The hexes below are INPUTS. Which of them are acceptable is not written down
 * here — it is computed by calling the real `deriveBrandSet()` from the built
 * `packages/tokens`, the same function #9 names. So this file holds no second
 * copy of the contrast maths to fall out of date with the first: if the thresholds
 * in `derive.ts` move, the expectations here move with them on the next run, and a
 * hex that changes verdict changes which half of the sweep it lands in.
 *
 * That is also why `EXPECT_ACCEPTED` is asserted at all. A handler that refused
 * EVERY `brandColor` would satisfy every refusal spec in this file and would be a
 * worse bug than the one it fixed — the wizard could no longer set a legitimate
 * colour. The accepted half is the discriminator that makes the refused half mean
 * something.
 *
 * TWO DEFECTS, AND THE SECOND ONE IS NOT THE ONE I WAS LOOKING FOR
 * ----------------------------------------------------------------
 * Probing the live endpoint turned up a second, separate failure in the same
 * field, recorded in its own section at the bottom: a MALFORMED hex answers
 * `500 server_error`, "Something went wrong on our side". The database CHECK
 * refuses the string and the constraint violation reaches the merchant as an
 * outage.
 *
 * This is not a new class of bug in this file — it is the bug the numeric fields
 * on this very route already had fixed. `salons.ts` carries a block comment about
 * it in the present tense, about `depositFils: 5500.5`: "the refusal reached the
 * merchant as `server_error` … She cannot tell a typed '5.5' from an outage, and
 * the API logged an unhandled error every time somebody mistyped a number." The
 * numbers were pulled forward to a door check. `brandColor` was not, and it is
 * about to acquire a door check anyway for the contrast rule, so the shape
 * refusal belongs in the same fix.
 *
 * WHY EVERY REFUSAL SPEC IS A `knownBug()`. Because none of them pass today and
 * this suite has to stay green for the daily merge. `knownBug()` requires the
 * contract-correct assertion to FAIL, reports the spec as passing, and goes RED
 * the hour the endpoint is fixed — with a message asking for promotion to a plain
 * `it()`. A defect written down any other way either rots into prose or gets
 * cemented as `expect(200) // wrong, but that's what it does`.
 *
 * SALON B THROUGHOUT, and the original colour is put back in `afterAll`, so a run
 * against a shared API (`E2E_BASE_URL=…`) leaves no fixture moved.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { knownBug, precondition } from './support/known-bug.js';
/**
 * The real deriver, from the BUILT package — the same module `packages/tokens`
 * ships and the same one the wallet and the dashboard consume.
 *
 * Imported by relative path into `dist`, which is the established shape in this
 * directory (`contract.test.ts` reaches `../packages/types/dist/index.js` the same
 * way) and is deliberate rather than lazy: adding `@avo/tokens` to `e2e`'s own
 * dependencies would rewrite the root lockfile, and the lockfile is trunk-owned.
 */
import { deriveBrandSet } from '../packages/tokens/dist/index.js';
import {
  B_STAFF_HANDLE,
  SALON_B,
  signInDashboard,
  startTenancyApi,
  stopTenancyApi,
  treq,
} from './support/tenancy-harness.js';

/** Layla, salon B's manager. Holds all nine permissions, so `perms.loyalty` — the
 *  gate on `PATCH /salons/{id}` — is never what refuses anything below. */
let dashboard = '';

/** Salon B's colour as the seed left it, read rather than hardcoded, and restored at the end. */
let originalBrandColor = '';

/**
 * CANDIDATE HEXES. Inputs only — no verdict is written beside any of them.
 *
 * Chosen to span the space rather than to make a point: both seeded salon
 * colours, three plausible boutique colours, and five that a colour picker will
 * happily produce and a merchant will happily choose. The yellows and the near
 * whites are the interesting half precisely because they look like brand colours
 * and cannot carry white text.
 */
const CANDIDATES = [
  '#6E7F6C', // salon A's seed
  '#7A5C8E', // salon B's seed
  '#B08D8D',
  '#8A7CB0',
  '#00FF00',
  '#FFD700',
  '#00FFFF',
  '#FFFF00',
  '#FFFFFF',
  '#FFFF99',
  '#F0E68C',
] as const;

const verdict = (hex: string) => deriveBrandSet(hex);

/** What the deriver says the API must take. */
const EXPECT_ACCEPTED = CANDIDATES.filter((h) => verdict(h).ok);
/** What the deriver says the API must refuse. */
const EXPECT_REFUSED = CANDIDATES.filter((h) => !verdict(h).ok);

/**
 * Strings that are not colours at all. Not run through the deriver — `deriveBrandSet`
 * is entitled to assume a hex, and what these probe is the door, not the maths.
 */
const MALFORMED = ['not-a-hex', '#GGGGGG', '#FFF', '', '#1234567'] as const;

const readBrandColor = async (): Promise<string> => {
  const res = await treq('GET', `/salons/${SALON_B}`, { token: dashboard });
  if (res.status !== 200) {
    throw new Error(`GET /salons/${SALON_B} answered ${res.status}: ${res.raw}`);
  }
  return res.body.brandColor;
};

const setBrandColor = (hex: unknown) =>
  treq('PATCH', `/salons/${SALON_B}`, { token: dashboard, body: { brandColor: hex } });

beforeAll(async () => {
  await startTenancyApi();
  dashboard = await signInDashboard(SALON_B, B_STAFF_HANDLE);
  originalBrandColor = await readBrandColor();
}, 120_000);

afterAll(async () => {
  // Put it back before the API goes down, so a run against a shared API leaves
  // salon B's colour exactly as it found it.
  if (dashboard && originalBrandColor) await setBrandColor(originalBrandColor);
  await stopTenancyApi();
});

// ---------------------------------------------------------------------------
describe('The sweep is pointed at something — the candidate split, before any request', () => {
  /**
   * A ZERO RESULT IS A CLAIM ABOUT THE COMMAND, NOT ABOUT THE SYSTEM.
   *
   * Every refusal spec below iterates `EXPECT_REFUSED`. If that array were empty —
   * a deriver import that silently resolved to a stub, a threshold change that
   * made every candidate derivable — the refusal half of this file would report a
   * confident green having asked the server nothing at all. So the split is
   * asserted before it is used, and both halves have to be non-empty.
   */
  it('the deriver actually loaded, and splits the candidates into two non-empty halves', () => {
    expect(typeof deriveBrandSet, 'deriveBrandSet did not resolve to a function').toBe('function');
    expect(
      EXPECT_ACCEPTED.length,
      'no candidate hex derives — the accepted half of this file would prove nothing',
    ).toBeGreaterThan(0);
    expect(
      EXPECT_REFUSED.length,
      'no candidate hex is refusable — every refusal spec below would pass vacuously',
    ).toBeGreaterThan(0);
  });

  it('and the refusable half is refusable for a reason the deriver states as data', () => {
    for (const hex of EXPECT_REFUSED) {
      const r = verdict(hex);
      precondition(r.ok === false, `${hex} unexpectedly derives`);
      // `failed` is a union of two literals precisely so a test does not have to
      // read prose to know which constraint refused. See derive.ts.
      expect(['white-on-deep', 'deep-on-tint'], `${hex} refused for an unknown reason`).toContain(
        r.failed,
      );
      expect(r.bestContrast, `${hex} was refused but reports a passing contrast`).toBeLessThan(4.5);
    }
  });

  /**
   * THE PROBE LANDS — the control that `knownBug()` cannot do for itself.
   *
   * `knownBug()` reports green whenever its body raises an ASSERTION failure, and
   * it cannot tell which assertion. So every refusal spec in this file would also
   * report green if the requests were never reaching the handler at all: a
   * mistyped path answering 404, an expired token answering 401, a dead route
   * answering 405 would each fail `expect(status).toBe(400)` exactly as an
   * accepted 200 does, and the file would report a tidy row of confirmed defects
   * having proved nothing about the endpoint.
   *
   * This is that control, and it is a permanent spec rather than a one-off check
   * because the risk is permanent — the path could be renamed next week. It
   * asserts only what stays true on both sides of the fix: the request arrives
   * somewhere that either accepts it or refuses it on the merits.
   */
  it('a refusable hex reaches the handler — the request is answered, not lost', async () => {
    for (const hex of EXPECT_REFUSED) {
      const res = await setBrandColor(hex);
      expect(
        [200, 400],
        `PATCH /salons/${SALON_B} answered ${res.status} for ${hex} — the refusal specs below ` +
          `would all report green on this without touching the guard. Response: ${res.raw}`,
      ).toContain(res.status);
    }
  }, 60_000);

  it('both seeded salon colours derive, so no fixture is relying on the missing guard', () => {
    // The claim `configuration.test.ts` was reaching for. Stated here as what it
    // is — a fact about the SEED — so nothing has to pretend it is a fact about
    // the endpoint.
    for (const hex of ['#6E7F6C', '#7A5C8E']) {
      expect(verdict(hex).ok, `the seeded colour ${hex} cannot make a 4.5:1 fill`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
describe('A usable brand colour is accepted and persists — the discriminator', () => {
  /**
   * These pass TODAY and must still pass after the guard lands. They are what
   * stops "refuse every brandColor" from satisfying this file.
   */
  for (const hex of EXPECT_ACCEPTED) {
    it(`${hex} derives, so PATCH takes it and a second request reads it back`, async () => {
      const res = await setBrandColor(hex);
      expect(res.status, `a derivable brand colour was refused: ${res.raw}`).toBe(200);

      // THE SECOND REQUEST. An echoed body would satisfy the line above.
      expect(await readBrandColor(), `${hex} did not persist`).toBe(hex);
    });
  }
});

// ---------------------------------------------------------------------------
describe('A brand colour that cannot make a 4.5:1 fill is refused (non-negotiable #9)', () => {
  for (const hex of EXPECT_REFUSED) {
    const r = verdict(hex);
    const best = r.ok ? Infinity : r.bestContrast;

    knownBug(
      `PATCH /salons/{id} stores ${hex}, whose best fill is ${best.toFixed(2)}:1 — #9 says reject it`,
      async () => {
        const known = await readBrandColor();
        precondition(known !== hex, `salon B is already set to ${hex}; nothing to prove`);

        const res = await setBrandColor(hex);

        /*
         * THE REFUSAL IS THE ASSERTION, not the absence of a change. A handler
         * that accepted the value, wrote nothing and answered 200 would be a
         * worse defect than one that wrote it, and only this line can tell them
         * apart.
         */
        expect(
          res.status,
          `${hex} was accepted (best fill ${best.toFixed(2)}:1, floor 4.5). Response: ${res.raw}`,
        ).toBe(400);

        /*
         * AND IT SAYS WHICH GUARD ANSWERED, because a status cannot.
         *
         * 403 `forbidden` is this API's code for a surface wall and for every
         * missing permission, so a spec that only counted non-200s here would go
         * green if the endpoint were accidentally gated shut — the wizard would be
         * just as broken and the test just as quiet. Each exclusion below names a
         * DIFFERENT wrong answer that would otherwise read as a pass:
         */
        const code = res.body?.error;
        expect(code, 'the refusal carries no machine-readable code').toBeTruthy();
        expect(code, 'a permission wall answered, not the contrast guard').not.toBe('forbidden');
        expect(code, 'the database CHECK refused it — that is a 500, not a validation').not.toBe(
          'server_error',
        );
        expect(
          code,
          'brandColor was dropped from EDITABLE rather than validated — see the accepted-hex ' +
            'specs above, which must still pass',
        ).not.toBe('not_editable');

        // A refusal an onboarding wizard cannot show a human is half a refusal;
        // deriveBrandSet returns `reason` for exactly this purpose.
        expect(res.body?.message, 'the refusal has no copy the wizard can render').toBeTruthy();

        // Corroboration, second request: the stored value is untouched.
        expect(await readBrandColor(), `${hex} was persisted despite the refusal`).toBe(known);
      },
      60_000,
    );
  }

  knownBug(
    'every unusable hex is refused with the SAME code, so a wizard can branch on one thing',
    async () => {
      const codes = new Map<string, unknown>();
      for (const hex of EXPECT_REFUSED) {
        const res = await setBrandColor(hex);
        /*
         * THE REFUSAL IS REQUIRED BEFORE THE CODES ARE COMPARED, AND THE FIRST
         * DRAFT OF THIS SPEC DID NOT DO THAT.
         *
         * It collected `body.error ?? '<${status} with no code>'` and asserted the
         * set had one element. Every hex is accepted today, so every entry was the
         * identical placeholder string, the set had exactly one member, and the
         * spec reported ITSELF as fixed — `knownBug` went red announcing that a
         * guard which does not exist had started working.
         *
         * A UNIFORM 200 IS UNIFORM. "They all agree" was satisfied by the endpoint
         * agreeing to store all of them, which is the defect, not the fix. So the
         * status is asserted per hex first: consistency is only a question worth
         * asking about answers that are refusals.
         */
        expect(res.status, `${hex} was not refused at all: ${res.raw}`).toBe(400);
        codes.set(hex, res.body?.error);
      }
      const distinct = new Set(codes.values());
      expect(
        [...distinct],
        `the contrast refusal has ${distinct.size} different codes: ${JSON.stringify([
          ...codes.entries(),
        ])}`,
      ).toHaveLength(1);
      expect([...distinct][0], 'the refusals carry no code at all').toBeTruthy();
    },
    60_000,
  );
});

// ---------------------------------------------------------------------------
describe('A malformed brand colour is a 400, not an outage', () => {
  /**
   * THE SECOND DEFECT, AND THE ONE ALREADY SOLVED ONCE ON THIS ROUTE.
   *
   * `salons.ts` explains at length why the numeric fields are refused "at the
   * door rather than at the column": Postgres refused `depositFils: 5500.5` on the
   * bigint column, the money was never at risk, and the refusal still reached the
   * merchant as `server_error` — "She cannot tell a typed '5.5' from an outage,
   * and the API logged an unhandled error every time somebody mistyped a number."
   *
   * `brandColor` is in exactly that pre-fix state. Its CHECK constraint
   * (`salon_brand_color_is_hex`) does hold — nothing malformed is ever stored,
   * which is why this is a usability and observability defect rather than a data
   * one — but a merchant who pastes a colour name gets an outage message, and the
   * server logs an unhandled exception every time.
   *
   * Filed here rather than in a separate report because the fix is the same edit:
   * `brandColor` is about to get a door check for the contrast rule, and a door
   * check that validates contrast but not shape would still 500 on `#GGGGGG`.
   */
  for (const value of MALFORMED) {
    knownBug(
      `PATCH /salons/{id} with brandColor ${JSON.stringify(value)} answers 500 server_error`,
      async () => {
        const known = await readBrandColor();
        const res = await setBrandColor(value);

        expect(
          res.status,
          `${JSON.stringify(value)} answered ${res.status} — a mistyped colour is a client ` +
            `error the merchant can act on. Response: ${res.raw}`,
        ).toBe(400);
        expect(
          res.body?.error,
          'the merchant cannot tell a typo from an outage',
        ).not.toBe('server_error');
        expect(res.body?.message, 'the refusal has no copy the form can render').toBeTruthy();

        // The CHECK does hold, and that is worth pinning: this is the wrong
        // MESSAGE, not a wrong write.
        expect(await readBrandColor(), 'a malformed hex reached the column').toBe(known);
      },
      60_000,
    );
  }

  /**
   * A NON-STRING `brandColor` GETS THE SAME TREATMENT, and these were nearly
   * written as one plain `it()` asserting `status).not.toBe(200)`.
   *
   * That assertion would pass today — every value below except the array answers
   * 500 — and it would have been INCOHERENT with the section it sits in: this
   * whole describe block exists to say that a 500 here is the defect. A spec that
   * accepts the 500 as proof of refusal contradicts the five specs above it and
   * would have to be rewritten the moment they were fixed. So the demand is the
   * same one: 400, with a code.
   */
  for (const value of [123456, null, true, { hex: '#8A7CB0' }]) {
    knownBug(
      `PATCH /salons/{id} with brandColor ${JSON.stringify(value)} (${typeof value}) answers 500`,
      async () => {
        const known = await readBrandColor();
        const res = await setBrandColor(value);

        expect(
          res.status,
          `brandColor ${JSON.stringify(value)} answered ${res.status}. Response: ${res.raw}`,
        ).toBe(400);
        expect(res.body?.error, 'a mistyped field reads as an outage').not.toBe('server_error');
        expect(await readBrandColor(), 'a non-string reached the column').toBe(known);
      },
      60_000,
    );
  }

  /**
   * THE ONE THAT IS NOT LIKE THE OTHERS, AND THE REASON THIS SECTION EXISTS.
   *
   * `["#8A7CB0"]` is not refused at all. It answers 200 and the colour is STORED,
   * because `String(['#8A7CB0'])` is `'#8A7CB0'` — `Array.prototype.toString`
   * joins on commas and a single-element array is just its element. So the value
   * is coerced somewhere between the body and the column, arrives as a
   * well-formed hex, and satisfies the `salon_brand_color_is_hex` CHECK that is
   * currently the field's only guard.
   *
   * WHY IT MATTERS BEYOND THE ODDITY. It proves there is no type check on this
   * field at all — the CHECK constraint is doing the entire job, and it can only
   * see what survives coercion. That is a live concern for the guard Lane A is
   * about to add: `deriveBrandSet(String(value))` would close the contrast hole
   * and leave this one open, still accepting an array. `typeof value !== 'string'`
   * → 400, checked BEFORE the deriver, closes both.
   */
  knownBug(
    'brandColor ["#8A7CB0"] — an array is coerced to its element and STORED, not refused',
    async () => {
      const known = await readBrandColor();
      precondition(known !== '#8A7CB0', 'salon B is already #8A7CB0; nothing to prove');

      const res = await setBrandColor(['#8A7CB0']);

      expect(
        res.status,
        `an array was accepted and stored as a string. Response: ${res.raw}`,
      ).toBe(400);
      expect(res.body?.error, 'the refusal carries no code').toBeTruthy();
      expect(await readBrandColor(), 'the coerced array reached the column').toBe(known);
    },
    60_000,
  );
});
