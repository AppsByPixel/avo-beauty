/**
 * EVERY CAMPAIGN AUDIENCE COMPILES TO A QUERY THE DRIVER CAN BIND.
 *
 * =========================================================================
 * WHAT THIS IS GUARDING, AND WHY THE ASSERTION IS ABOUT PARAMETERS
 * =========================================================================
 * `POST /v1/salons/{id}/campaigns` with `audience: "lapsed"` answered 500
 * `server_error` for the whole life of the endpoint. The other four audiences
 * answered 201. Probed against a live API:
 *
 *     all      201 ok
 *     lapsed   500 server_error
 *     lowbal   201 ok
 *     gold     201 ok
 *     new      201 ok
 *
 * `lapsed` is "Not seen in 60 days" — the campaign a salon asks for first — and
 * non-negotiable #8 routes every campaign through the platform, so the merchant
 * met a 500 at the moment she asked for something she is entitled to ask for.
 *
 * The cause was one bound parameter. `services/campaign.ts` § BUILT WITH THE
 * HELPERS carries the mechanism in full; the short version is that `drizzle()`
 * REPLACES the postgres.js date serializer with an identity function on
 * construction, so any parameter Drizzle did not itself encode arrives at the
 * driver as a live `Date` and dies in `Buffer.byteLength`:
 *
 *     TypeError [ERR_INVALID_ARG_TYPE]: The "string" argument must be of type
 *     string or an instance of Buffer or ArrayBuffer. Received an instance of Date
 *
 * So the property worth asserting is not "the endpoint returns 201" — that needs a
 * database and an HTTP request, and it is asserted in `campaignAudience.int.test.ts`
 * against both the create and the release path. It is the narrower, sharper one:
 * NO AUDIENCE BINDS A PARAMETER THE DRIVER CANNOT ENCODE. That is a property of
 * the compiled SQL, needs no connection, and therefore runs inside `pnpm check` —
 * which does not run the `.int` suite (`vitest.int.config.ts` § THIS SUITE DOES NOT
 * RUN IN `pnpm check`).
 *
 * =========================================================================
 * DERIVED FROM `CAMPAIGN_AUDIENCES`, NOT FROM A LIST TYPED HERE
 * =========================================================================
 * The trap in this bug is the single-value fix. Four branches were fine and one
 * was hand-written; a spec that adds `lapsed` and stops would have proved the fix
 * and nothing about the shape of the mistake. So the cases come from the same
 * `as const` the CHECK constraint and the endpoint's 400 message come from — the
 * technique `apps/dashboard/src/shell/consoleNavGates.test.ts` uses — and a sixth
 * audience is covered on the day it is added to the constant rather than on the
 * day somebody remembers this file.
 *
 * The count is asserted too. `toHaveLength(5)` here is not redundant with the loop:
 * without it, a `CAMPAIGN_AUDIENCES` accidentally emptied would make every
 * derived spec vanish and the file would report green with nothing run.
 */

import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { CAMPAIGN_AUDIENCES } from '../db/schema/campaign';
import { audiencePredicate } from './campaign';

const dialect = new PgDialect();

/** A fixed instant, so a failure is reproducible rather than "sometimes". */
const NOW = new Date('2026-08-27T09:15:00.000Z');
const SALON = 'SAL-AMARA';

/**
 * What postgres.js can actually put on the wire once Drizzle has replaced its date
 * serializer: text, and the few primitives it stringifies itself. `null` is fine —
 * `Bind` writes it as a NULL and never calls `str`. Anything else reaches
 * `Buffer.byteLength` as an object and throws, which is the bug.
 */
function bindable(value: unknown): boolean {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint' ||
    value instanceof Uint8Array
  );
}

function describeValue(value: unknown): string {
  if (value instanceof Date) return `Date(${value.toISOString()})`;
  return `${Object.prototype.toString.call(value)} ${String(value)}`;
}

describe('audiencePredicate — every audience compiles to bindable parameters', () => {
  it('covers all five audiences the schema allows', () => {
    expect(CAMPAIGN_AUDIENCES).toHaveLength(5);
    expect([...CAMPAIGN_AUDIENCES]).toContain('lapsed');
  });

  for (const audience of CAMPAIGN_AUDIENCES) {
    it(`binds no unencodable parameter for audience "${audience}"`, () => {
      const predicate = audiencePredicate(SALON, audience, NOW);
      expect(predicate, `audience "${audience}" produced no predicate`).toBeDefined();

      const { sql, params } = dialect.sqlToQuery(predicate!);
      expect(sql).toContain('salon_id');

      const bad = params
        .map((value, i) => ({ i, value }))
        .filter(({ value }) => !bindable(value));

      expect(
        bad,
        `audience "${audience}" binds ${bad.length} parameter(s) the driver cannot encode: ` +
          bad.map(({ i, value }) => `$${i + 1} = ${describeValue(value)}`).join(', ') +
          `. A raw \`sql\` template gives Drizzle no column to encode against, and ` +
          `\`drizzle()\` has replaced postgres.js's own date serializer with an identity ` +
          `function — so this is a 500 on POST /campaigns and on the release path. ` +
          `Express the comparison with a Drizzle helper against the real column ` +
          `(\`gte(transaction.createdAt, cutoff)\`), not by interpolating the value. ` +
          `SQL was: ${sql}`,
      ).toEqual([]);
    });
  }

  /**
   * The one branch that regressed, named on its own. The loop above would catch it,
   * but a named spec is what a bisect run reads, and this is the branch that has to
   * keep working: a raw template reintroduced anywhere in it puts a `Date` back on
   * the wire, and the parameter list is where that shows.
   */
  it('binds the lapsed cutoff as timestamptz text, not as a Date', () => {
    const { params } = dialect.sqlToQuery(audiencePredicate(SALON, 'lapsed', NOW)!);
    const cutoff = new Date(NOW.getTime() - 60 * 86_400_000).toISOString();
    expect(params).toContain(cutoff);
    expect(params.some((p) => p instanceof Date)).toBe(false);
  });
});
