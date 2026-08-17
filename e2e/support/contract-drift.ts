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
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
/** e2e/support → e2e → repo root */
const repoRoot = join(here, '..', '..');

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
export function discoverGetRoutes(): DiscoveredGetRoute[] {
  const dir = join(repoRoot, 'api', 'src', 'routes');
  const found: DiscoveredGetRoute[] = [];
  // `app.get<{ Params: { id: string } }>('/salons/:id', …)` — the generic sits
  // between the method and the paren, and never contains a `(`.
  const re = /app\.get[^(]*\(\s*'([^']+)'/g;

  for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
    const source = readFileSync(join(dir, file), 'utf8');
    for (const m of source.matchAll(re)) {
      found.push({ path: m[1]!, file: `api/src/routes/${file}` });
    }
  }
  return found.sort((a, b) => a.path.localeCompare(b.path));
}
