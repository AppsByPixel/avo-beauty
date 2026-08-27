/**
 * READING LANE A'S CONSTANTS OUT OF LANE A'S SOURCE, AND CHECKING THEM AGAINST THE
 * DATABASE THAT IS ACTUALLY DEPLOYED.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * `e2e/campaigns.test.ts` § THE AUDIENCE DIMENSION established the technique and the
 * reason for it: `audience: "lapsed"` answered 500 for the whole life of
 * `POST /campaigns` because every spec in a thorough suite pinned `audience: 'gold'`
 * at its call site. The fix worth having was not a sixth spec about `lapsed`, it was
 * a COVERAGE SHAPE — cases generated from the constant, so a new member of an enum
 * is covered on the day it is added rather than on the day somebody remembers the
 * file.
 *
 * The pinned-enum inventory that followed found more of the same shape, and two of
 * them needed the identical reader. Two copies of a reader whose whole job is "do
 * not hardcode the list" is a joke that writes itself, so it is here.
 *
 * READ FROM SOURCE TEXT RATHER THAN IMPORTED. Nothing in `e2e/` imports from
 * `api/src` — `console-reset.test.ts` says so in as many words — because this suite
 * drives the API from outside it, as a client. And the cases have to exist at
 * COLLECTION time, before `beforeAll` has provisioned a database or booted an API,
 * so they cannot come from a query either.
 *
 * COMMENTS ARE STRIPPED BEFORE ANYTHING IS MATCHED. `campaigns.test.ts` deliberately
 * does not, and explains that it is safe there because its declaration is a single
 * line of literals — then adds "If the constant is ever reformatted across lines
 * with a comment inside it, strip comments then." `loyaltyEventKind` is exactly that
 * shape:
 *
 *     export const loyaltyEventKind = pgEnum('loyalty_event_kind', [
 *       /** Crossed a threshold and moved up the ladder. *\/
 *       'tier_climb',
 *       …
 *
 * so this module strips. `stripComments` is `support/perm-census.ts`'s, string- and
 * template-literal aware, already proved by the census, and space-preserving so line
 * numbers survive.
 *
 * `campaigns.test.ts` WAS DELIBERATELY NOT MIGRATED ONTO THIS MODULE. Its reader is
 * a plain `as const` array cross-checked against a CHECK CONSTRAINT rather than
 * against a Postgres enum type, and its header carries a long argument for not
 * stripping comments that is true of that declaration. Rewriting a file that has
 * just landed, to share a helper it does not need, buys a diff and no information.
 *
 * EVERY READER THROWS ON A FAILED PARSE, NEVER RETURNS EMPTY. A parse that silently
 * found nothing deletes every derived spec downstream and reports the file green
 * with the dimension untested — which is the exact failure this technique exists to
 * end, reintroduced one level down. The messages name the file and the plausible
 * causes, because the reader of the failure is somebody who just renamed a constant
 * and has no reason to expect a QA suite to care.
 */

import { readFileSync } from 'node:fs';
import { stripComments } from './perm-census.js';
import { scalar } from './tenancy-harness.js';

/** Every single-quoted literal in a fragment of text, in order. */
export const quotedStrings = (text: string): string[] =>
  [...text.matchAll(/'([^']*)'/g)].flatMap((m) => (m[1] ? [m[1]] : []));

const read = (file: string): string => stripComments(readFileSync(file, 'utf8'));

const failedParse = (what: string, file: string): Error =>
  new Error(
    `${what} could not be read out of ${file}.\n` +
      'Derived specs in e2e/ are generated from it, so a failed parse would silently delete ' +
      'them all and report the suite green with the dimension untested — hence this throw ' +
      'rather than an empty list.\n' +
      'If the declaration was renamed, moved or reformatted, update this reader in ' +
      'e2e/support/source-enums.ts. Do NOT replace it with a list typed in the spec file: a ' +
      'hardcoded list is what let `audience: "lapsed"` answer 500 for the life of an ' +
      'endpoint, and what left `availability_source: "google"` unnamed by any test in this ' +
      'repository.',
  );

/**
 * A Drizzle `pgEnum` declaration, as BOTH halves.
 *
 * The Postgres type name is returned rather than taken as an argument, so
 * `pgEnumLabels()` below can cross-check against the type the source actually names
 * and a spec file holds one fewer string that the schema can rename underneath it.
 */
export function pgEnumFromSource(
  file: string,
  constName: string,
): { typeName: string; values: string[] } {
  const src = read(file);
  const decl = new RegExp(
    `export const ${constName}\\s*=\\s*pgEnum\\(\\s*('[^']*')\\s*,\\s*\\[([^\\]]*)\\]`,
  ).exec(src);
  if (!decl) throw failedParse(`the pgEnum \`${constName}\``, file);

  const typeName = quotedStrings(decl[1] ?? '')[0];
  const values = quotedStrings(decl[2] ?? '');
  if (!typeName || values.length === 0) {
    throw new Error(
      `the pgEnum \`${constName}\` was found in ${file} but nothing was read out of it. ` +
        `The declaration matched as: ${decl[0]}`,
    );
  }
  return { typeName, values };
}

/** An `export const NAME = ['a', 'b'] as const` array of string literals. */
export function constArrayFromSource(file: string, constName: string): string[] {
  const src = read(file);
  const decl = new RegExp(
    `export const ${constName}\\s*=\\s*\\[([^\\]]*)\\]\\s*as const`,
  ).exec(src);
  if (!decl) throw failedParse(`the \`as const\` array \`${constName}\``, file);

  const values = quotedStrings(decl[1] ?? '');
  if (values.length === 0) {
    throw new Error(
      `\`${constName}\` was found in ${file} but no literal was read out of it. The ` +
        `declaration matched as: ${decl[0]}`,
    );
  }
  return values;
}

/**
 * A plain array literal that is NOT exported — `const order = ['bronze', …]` inside a
 * function body.
 *
 * `describeLoyalty` holds one, and it is load-bearing: it is the ladder the tier
 * DESCENT comparison indexes into, so a tier added to the enum and not to that array
 * makes `indexOf` return -1 and a climb read as a descent. A spec can only check
 * that if it can read the array.
 */
export function localArrayFromSource(file: string, varName: string): string[] {
  const src = read(file);
  const decl = new RegExp(`\\bconst ${varName}\\s*=\\s*\\[([^\\]]*)\\]`).exec(src);
  if (!decl) throw failedParse(`the local array \`${varName}\``, file);

  const values = quotedStrings(decl[1] ?? '');
  if (values.length === 0) {
    throw new Error(
      `\`${varName}\` was found in ${file} but no literal was read out of it. The ` +
        `declaration matched as: ${decl[0]}`,
    );
  }
  return values;
}

/**
 * An `export const NAME: Record<string, string> = { key: 'value', … }` lookup, as a map.
 *
 * `METHOD_LABEL` and `TIER_LABEL` are these, and both are read with `?? row.method` /
 * `?? row.toTier` fallbacks — so a key the enum has and the map does not puts a raw
 * database value in front of a merchant. That is only assertable if the map can be
 * compared to the enum.
 */
export function stringRecordFromSource(
  file: string,
  constName: string,
): Record<string, string> {
  const src = read(file);
  const decl = new RegExp(
    `export const ${constName}\\s*:\\s*Record<\\s*string\\s*,\\s*string\\s*>\\s*=\\s*\\{([^}]*)\\}`,
  ).exec(src);
  if (!decl) throw failedParse(`the Record literal \`${constName}\``, file);

  const out: Record<string, string> = {};
  for (const m of (decl[1] ?? '').matchAll(/([A-Za-z_$][\w$]*)\s*:\s*'([^']*)'/g)) {
    out[m[1] as string] = m[2] as string;
  }
  if (Object.keys(out).length === 0) {
    throw new Error(
      `\`${constName}\` was found in ${file} but no key/value pair was read out of it. The ` +
        `declaration matched as: ${decl[0]}`,
    );
  }
  return out;
}

/**
 * The labels the DEPLOYED Postgres enum type admits, in declaration order.
 *
 * THE POINT OF READING IT AT ALL: a Drizzle `pgEnum` is a TypeScript declaration and
 * the Postgres type is written out by a migration. A value added to one and not the
 * other type-checks, passes any route validation built from the declaration, and
 * then fails on INSERT — `server_error` on a request a client was entitled to send,
 * which is the same family of bug as `audience: "lapsed"` reached by a different
 * door. Read from `pg_enum` rather than from the migration file, because what
 * matters is the type deployed in front of THIS run.
 *
 * Empty means the type is not there at all. Returned rather than thrown, so the
 * calling spec can say which type it was looking for.
 */
export function pgEnumLabels(typeName: string): string[] {
  const raw = scalar(
    `select coalesce(string_agg(e.enumlabel, ',' order by e.enumsortorder), '')
       from pg_enum e join pg_type t on t.oid = e.enumtypid
      where t.typname = '${typeName}'`,
  );
  return raw === '' ? [] : raw.split(',');
}

/** `pg_get_constraintdef()` for a named constraint, or `''` if it is not deployed. */
export function constraintDef(name: string): string {
  return scalar(`select pg_get_constraintdef(oid) from pg_constraint where conname='${name}'`);
}
