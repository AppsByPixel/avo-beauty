/**
 * THE GUARD AGAINST A SCHEMA THAT IS NARROWER THAN THE WIRE.
 *
 * Four contract drifts have now been found on this project, every one of them by
 * a lane walking into it rather than by a check, and all four were the same
 * shape:
 *
 *   1. `ArtistSchema` declared less than `serialiseArtist` sends.
 *   2. `BookingSchema` had no `changeableUntil`, so the entire one-hour
 *      cancellation rule was deleted between the server and the screen.
 *   3. `AvailabilitySlotSchema` declared `{time, available, reason?}` against an
 *      API sending `{startsAt, endsAt, local, available, reason}` in an envelope.
 *   4. And the fix for (3) made `reason` `.nullable()` without `.optional()`,
 *      which made it REQUIRED — so every bookable slot failed `.parse()`. It hid
 *      on today's date, where every slot is already past and therefore carries a
 *      reason. A future date is what exposed it.
 *
 * ZOD DOES NOT FAIL ON A FIELD IT DOES NOT DECLARE. IT DELETES IT. That is the
 * whole reason this file exists. `safeParse` going red is the easy half of the
 * problem and it is not the half that has actually bitten: three of the four
 * above were fields the server sent and the contract silently threw away, and a
 * client cannot tell the difference between "the server did not send it" and
 * "our own types ate it".
 *
 * So the honest test is not "does it parse". It is a DEEP COMPARISON OF THE
 * PRE-PARSE OBJECT AGAINST THE POST-PARSE ONE. Every key the wire carried and
 * the parse did not return is drift, named with the path it was lost at.
 *
 * Both directions are checked, because (4) was the other one:
 *
 *   stripped   the wire had a key, the parse output does not — the schema is
 *              narrower than the wire, and a client is blind to that field.
 *   invented   the parse output has a key the wire did not — a `.default()`
 *              fired. Not always wrong, always worth seeing: it means a declared
 *              field is not being served, and the default is covering for it.
 *   parse fail a required key was absent, or a value had the wrong type. (4).
 *
 * NOTHING HERE HOLDS A FIXTURE. A recorded response drifts alongside the schema
 * it is meant to police and then proves nothing at all; every comparison in this
 * file is against a response lane A's API served during the run.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { ROUTES_DIR, registrationsIn, stripComments } from './perm-census.js';

/**
 * What this file needs of a schema, written structurally rather than as
 * `z.ZodTypeAny`.
 *
 * `e2e` does not depend on zod and should not start to: the guard's subject is
 * the schemas themselves, and a version of zod resolved through this package
 * rather than through `@avo/types` would be a second copy of the library
 * deciding what "parse" means. The schemas are imported from the BUILT package,
 * which is what a client actually consumes.
 */
export interface ParsesLikeZod {
  safeParse(value: unknown): { success: boolean; data?: unknown; error?: unknown };
}

// --------------------------------------------------------------- key deltas --

export type DeltaKind = 'stripped' | 'invented';

export interface KeyDelta {
  /** Concrete path, e.g. `$.items[3].voidedAt`. Names one real example. */
  path: string;
  /** Array indices collapsed: `$.items[].voidedAt`. What an annotation matches. */
  shape: string;
  kind: DeltaKind;
  /** JSON of the value that was lost, truncated. Empty for `invented`. */
  sample: string;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function preview(v: unknown): string {
  let s: string;
  try {
    s = JSON.stringify(v) ?? String(v);
  } catch {
    s = String(v);
  }
  return s.length > 120 ? `${s.slice(0, 117)}…` : s;
}

/** `$.items[3].voidedAt` → `$.items[].voidedAt` */
export function shapePath(path: string): string {
  return path.replace(/\[\d+\]/g, '[]');
}

// ----------------------------------------------------------------- wire pins --

/**
 * THE SAME GUARD FOR A SHAPE THAT HAS NO SCHEMA YET.
 *
 * `keyDeltas` compares a response against what a zod schema returned, which is
 * the right instrument when a schema exists. Two of the shapes this API now
 * serves have none: the notification preference set and the deletion state are
 * both newer than `packages/types` and both are already consumed by the wallet.
 * A shape with no schema cannot drift against one — it drifts against the
 * CLIENT, silently, in exactly the same way, and the census at the bottom of
 * contract.test.ts can only say "this is unmodelled", not "this is still the
 * shape it was".
 *
 * So the pin is the same comparison with the schema's side written by hand: the
 * declared key set against the served key set, BOTH DIRECTIONS.
 *
 *   a key served and not declared   the response grew and nothing told the
 *                                   guard. Benign here, but it is the half that
 *                                   proves the pin is still being maintained.
 *   a key declared and not served   THE ONE THAT BITES. A field the client reads
 *                                   stopped arriving, or started arriving under
 *                                   a different name, and every consumer sees
 *                                   `undefined` with no error anywhere.
 *
 * A KEY WHOSE VALUE IS `null` IS A KEY THAT IS PRESENT. That distinction is the
 * whole of drift (4) restated: `offersConsent.at` is `null` until she is asked,
 * and an API that OMITS it instead of nulling it is a different contract from the
 * one the wallet was built against, even though every screen looks identical.
 * `wireShape` therefore records `null` as a leaf and never as an absence.
 *
 * Values are NOT pinned — only the shape. Pinning a value would make this a
 * fixture, and rule 1 of contract.test.ts is that nothing here holds one.
 */
export function wireShape(value: unknown, path = '$'): string[] {
  if (Array.isArray(value)) {
    // Index-wise would make the pin depend on how many rows happened to exist.
    // The first element carries the row shape; an empty array is a leaf, and the
    // caller's `requireNonEmpty` is what refuses to draw conclusions from it.
    return value.length === 0 ? [`${path}[]`] : wireShape(value[0], `${path}[]`);
  }
  if (isPlainObject(value)) {
    return Object.keys(value)
      .sort()
      .flatMap((k) => wireShape(value[k], `${path}.${k}`));
  }
  return [path];
}

/**
 * Every key present on one side of the parse and absent on the other.
 *
 * Walks arrays index-wise and objects key-wise. A type change (object became a
 * string) is not reported here — `safeParse` has already refused that response,
 * and re-reporting it as a hundred missing keys would bury the actual message.
 */
export function keyDeltas(before: unknown, after: unknown, path = '$'): KeyDelta[] {
  const out: KeyDelta[] = [];
  walk(before, after, path, out);
  return out;
}

function walk(before: unknown, after: unknown, path: string, out: KeyDelta[]): void {
  if (Array.isArray(before)) {
    if (!Array.isArray(after)) return;
    const n = Math.min(before.length, after.length);
    for (let i = 0; i < n; i++) walk(before[i], after[i], `${path}[${i}]`, out);
    return;
  }

  if (isPlainObject(before)) {
    if (!isPlainObject(after)) return;
    for (const k of Object.keys(before)) {
      const p = `${path}.${k}`;
      if (!(k in after)) {
        out.push({ path: p, shape: shapePath(p), kind: 'stripped', sample: preview(before[k]) });
        continue;
      }
      walk(before[k], after[k], p, out);
    }
    for (const k of Object.keys(after)) {
      if (k in before) continue;
      const p = `${path}.${k}`;
      out.push({ path: p, shape: shapePath(p), kind: 'invented', sample: preview(after[k]) });
    }
  }
}

/** One line per distinct shape path, with a concrete example of each. */
export function describeDeltas(deltas: KeyDelta[]): string {
  const byShape = new Map<string, KeyDelta>();
  for (const d of deltas) if (!byShape.has(d.shape)) byShape.set(d.shape, d);
  return [...byShape.values()]
    .map((d) =>
      d.kind === 'stripped'
        ? `  STRIPPED  ${d.shape}   the wire sent ${d.sample} and the parse deleted it (e.g. ${d.path})`
        : `  INVENTED  ${d.shape}   the parse produced ${d.sample} from nothing — a .default() is covering for a field the API does not serve (e.g. ${d.path})`,
    )
    .sort()
    .join('\n');
}

// ------------------------------------------------------------- issue report --

/** zod's own account of what was missing or mistyped, flattened to lines. */
export function describeParseError(error: unknown): string {
  const issues = (error as { issues?: unknown })?.issues;
  if (!Array.isArray(issues)) return String(error);
  return issues
    .slice(0, 20)
    .map((i) => {
      const issue = i as { path?: unknown[]; code?: string; message?: string };
      const at = Array.isArray(issue.path) && issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `  ${at}: ${issue.message ?? ''} [${issue.code ?? '?'}]`;
    })
    .join('\n');
}

// -------------------------------------------------------------- the census --

export interface DiscoveredGetRoute {
  path: string;
  file: string;
}

/**
 * Every GET route lane A registers.
 *
 * The brief for this guard says: where a schema does not exist yet for a served
 * shape, SAY SO rather than skip quietly — the bookable-artist row had no schema
 * at all until the hour before it was noticed. A hand-maintained list of probes
 * cannot say that, because the thing it fails to mention is the thing it does not
 * know about. So the census reads the routes off disk, the same mechanism the
 * tenancy gap ledger uses, and every GET has to be classified as either probed
 * against a schema or explicitly unmodelled with a reason.
 */
/**
 * The GET registrations in ONE file's source, in path order.
 *
 * THIS IS NO LONGER ITS OWN READING OF "WHAT IS A ROUTE REGISTRATION", AND THAT
 * IS THE WHOLE POINT OF THE FUNCTION.
 *
 * It used to be. `e2e` carried three independent definitions — `registrationsIn`
 * in `perm-census.ts`, the ambiguity pass's `callSites` beside it, and a regex
 * here:
 *
 *     const re = /app\.get[^(]*\(\s*'([^']+)'/g;
 *
 * Three readings of the same thirty files that were free to disagree about them,
 * and the two in `perm-census.ts` have since been collapsed into one for exactly
 * that reason. This was the third. It had three weaknesses, none of which bit on
 * the tree as it stood — measured 2026-09-11, both readers returned the same 55
 * GET paths, set-identical — which is the condition under which a defect is
 * cheapest to remove and least likely to be believed.
 *
 * 1. ANCHORED ON THE LITERAL RECEIVER `app.get`. This is verbatim the defect
 *    `registrationsIn` documents under "THE THIRD FAILURE MODE, AND IT HID THE
 *    PAYMENT WEBHOOK": `POST /webhooks/:provider` registers on `scoped`, an
 *    encapsulated Fastify context, and was invisible to every `app.`-anchored
 *    sweep on the platform. That route is a POST, so this census never wanted it
 *    — but the class does not care about the method. A GET on an encapsulated
 *    context was invisible here, and nothing anywhere reported it, because a
 *    census cannot report a hole in a route it never enumerated. Encapsulation is
 *    what a route reaches for when it needs its own parser or its own error
 *    handler, which is not a rare shape and not a low-stakes one.
 *
 * 2. A PATH LIFTED INTO A CONST WAS SILENTLY LOST. `[^(]*` cannot cross a `(`, so
 *    unlike the pattern that produced the `DELETE /v1/images/:imageId` ghost this
 *    one could not INVENT a route — `app.get<…>(SOME_CONST, handler)` simply
 *    produced no match. It left `discovered` and both consumers went QUIET rather
 *    than red: "every GET is classified as probed or UNMODELLED" cannot fail on a
 *    route it cannot see, and the UNMODELLED ghost spec asks the opposite
 *    question. Losing a route without inventing one is the better half of that
 *    pair and it is still a loss.
 *
 *    THAT HOLE IS NOW FLOORED BY SOMEONE ELSE, WHICH IS THE SECOND THING SHARING
 *    THE READER BUYS. An unreadable registration is dropped here exactly as
 *    before — but it is dropped by `registrationsIn`, and `ambiguousRegistrations()`
 *    reports every call site that reader could see and could not resolve, by file
 *    and line, across all five methods. `permission-census.test.ts` is what turns
 *    that into a red spec. This module still has no ambiguity pass of its own and
 *    now does not need one.
 *
 * 3. SINGLE QUOTES ONLY. `'([^']+)'` could not see a double-quoted path.
 *
 * And a fourth that was not on the list and is the one that would have fired
 * first: IT DID NOT STRIP COMMENTS. `censusOfRoutes` reads `stripComments(raw)`
 * and this read `raw`, so a commented-out or merely quoted `app.get('/…')` in
 * `api/src/routes/` was a GET route as far as this census was concerned — a ghost
 * demanding a probe or an `UNMODELLED` reason for an endpoint nobody serves. That
 * difference between the two readers was never decided, only never exercised; it
 * is decided now, in favour of stripping, by using the same pipeline as the
 * census.
 *
 * EXPORTED SO THE SPEC CAN DRIVE IT ON SOURCE IT WRITES ITSELF, for the same
 * reason `registrationsIn` is exported: every path in `api/src/routes/` is an
 * inline single-quoted literal on an `app` receiver today, so not one of the four
 * has a reproduction in the tree and not one moves a census number when it is
 * fixed. `contract.test.ts` § "the GET reader is the census's reader" is the only
 * place these shapes can be asserted before an ordinary refactor produces them.
 */
export function getRoutesIn(source: string): string[] {
  return registrationsIn(stripComments(source))
    .filter((r) => r.method === 'GET')
    .map((r) => r.path);
}

export function discoverGetRoutes(): DiscoveredGetRoute[] {
  const found: DiscoveredGetRoute[] = [];

  for (const file of readdirSync(ROUTES_DIR).filter((f) => f.endsWith('.ts'))) {
    const source = readFileSync(join(ROUTES_DIR, file), 'utf8');
    for (const path of getRoutesIn(source)) {
      found.push({ path, file: `api/src/routes/${file}` });
    }
  }
  return found.sort((a, b) => a.path.localeCompare(b.path));
}
