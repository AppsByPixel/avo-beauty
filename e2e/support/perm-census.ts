/**
 * THE PERMISSION CENSUS — enumerate every permission-gated endpoint in
 * `api/src/routes/` from SOURCE, across every HTTP method.
 *
 * WHAT THIS MODULE IS FOR. Non-negotiable #7 says "every gated endpoint needs a test
 * that calls it directly with the permission off". `authority.test.ts` probes nine
 * endpoints — one per permission — and its own spec title claims it "covers all nine
 * permissions", a criterion that passes while #7's actual requirement went unmet on 22
 * endpoint/permission pairs. `design/go-live-checklist.md` records that gap and says the
 * thing that would close it is a census that enumerates the call sites from source and
 * demands a probe for each. This is that census.
 *
 * The existing census in `contract.test.ts` cannot do this job: it walks GET routes only,
 * so every gated `POST`, `PATCH`, `PUT` and `DELETE` lane A adds is invisible to it.
 *
 * WHAT IS ACTUALLY BEING ENUMERATED, STATED PLAINLY — because trunk's caution is
 * exactly right and a census that greps for a NAME is a census that lies.
 *
 * This module reads source text and produces a PROPOSAL: "the handler registered at
 * `app.<method>('<path>')` appears to call `<guard>` with `<permission>` first". It is a
 * structural reading of a file, and it can be wrong in three ways that matter:
 *
 *   1. a gate applied through a WRAPPER or a re-export under another name — not matched
 *   2. a gate mentioned in a COMMENT — falsely matched
 *   3. a gate that is present but NOT FIRST, so something else refuses before it
 *
 * (2) is handled here: comments are stripped before anything is matched, string- and
 * template-literal aware, so prose naming `requireDashboardPerm` cannot invent a gate.
 *
 * (1) IS HANDLED, AND IT HAD TO BE — the first run of this census found two real gates it
 * could not see. `GET /members` and `GET /members/:id` are gated on `perms.scanner`
 * through `requireDirectoryScanner`, a local helper in `routes/members.ts` that ends
 * `return requireScannerPerm(req, 'scanner')` after writing a risk audit row. A
 * name-based census reported both as UNGATED — a customer-directory read, reported as
 * open, when it is not. That is trunk's caution arriving as a concrete defect in the
 * first draft of the thing meant to prevent it.
 *
 * So wrappers are RESOLVED rather than enumerated: any function in `api/src` whose body
 * calls a permission guard, and which is not itself a route-registration function,
 * becomes a gate under its own name. A future helper gets the same treatment with no edit
 * here. What is deliberately NOT done is following two levels — a wrapper around a
 * wrapper is reported as ungated and would be caught by the runtime pass, and the spec
 * says so rather than pretending to a generality this does not have.
 *
 * (3) IS NOT HANDLED HERE AND IS NOT MEANT TO BE. It is settled at RUNTIME
 * by `permission-census.test.ts`, which takes each proposed pair, revokes exactly that
 * permission, calls the endpoint, and requires a 403 carrying the permission's own copy —
 * then grants it back and requires the same call to stop refusing. The static pass only
 * proposes; the runtime pair decides. So:
 *
 *   - a gate this module misreads produces a probe that FAILS, by name
 *   - a gate on the WRONG permission produces a probe that FAILS, by name
 *   - a gate that is not first answers something other than 403 and FAILS, by name
 *   - a route with no gate at all is reported as UNGATED and must be named in the
 *     spec's exemption list, with a reason, or the spec goes red
 *
 * That is the difference between asserting on the string and asserting on the thing: the
 * string is only ever used to decide WHICH permission to switch off.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from './tenancy-harness.js';

export const ROUTES_DIR = join(repoRoot, 'api', 'src', 'routes');

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** The four guards that check a PERMISSION. Scope-only guards are not gates in this sense. */
export type GuardName =
  | 'requireDashboardPerm'
  | 'requireScannerPerm'
  | 'requirePerm'
  | 'requirePlatform';

export interface GatedRoute {
  file: string;
  line: number;
  method: HttpMethod;
  path: string;
  guard: GuardName;
  /** `perms.<name>` for the merchant guards, a console section for `requirePlatform`. */
  permission: string;
  /** Which credential the endpoint accepts. `platform` for the owner console. */
  surface: 'dashboard' | 'scanner' | 'platform';
  /** The wrapper the gate arrived through, or null for a direct guard call. */
  via: string | null;
}

/**
 * Every guard that establishes WHO the caller is without checking a permission. A route
 * carrying one of these is authenticated but not permission-gated, which is a legitimate
 * shape — `GET /members/me` is the customer's own record and there is no permission that
 * could apply. Captured so the census can say WHY a route is ungated from source, rather
 * than relying on forty-eight hand-written reasons that rot.
 */
export type ScopeGuardName =
  | 'requirePrincipal'
  | 'requireMember'
  | 'requireSalonScoped'
  | 'requireStaff'
  | 'requireDashboardScope'
  | 'requireScannerScope'
  | 'requirePlatformScope';

export interface UngatedRoute {
  file: string;
  line: number;
  method: HttpMethod;
  path: string;
  /**
   * The scope guard the handler does use, or `null` for a route that authenticates
   * nobody. `null` is the only case needing a written reason — and the list of those is
   * short and is exactly the set that must stay short.
   */
  scope: ScopeGuardName | null;
}

/**
 * Remove comments, leave code. String- and template-literal aware, because
 * `'https://x'` and a regex containing `//` both look like line comments to a naive
 * pass, and a route path is a string literal — so mangling strings would destroy the
 * very thing being enumerated.
 *
 * Replaced with SPACES rather than deleted, so every byte offset and every line number
 * still matches the original file. A census that reported the wrong line would be worse
 * than no census: the whole value is naming the endpoint a developer has to go fix.
 */
export function stripComments(src: string): string {
  const out = src.split('');
  let i = 0;
  const n = src.length;
  type State = 'code' | 'line' | 'block' | 'single' | 'double' | 'template';
  let state: State = 'code';

  const blank = (from: number, to: number): void => {
    for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ';
  };

  while (i < n) {
    const c = src[i];
    const d = src[i + 1];

    if (state === 'code') {
      if (c === '/' && d === '/') {
        const start = i;
        while (i < n && src[i] !== '\n') i++;
        blank(start, i);
        continue;
      }
      if (c === '/' && d === '*') {
        const start = i;
        i += 2;
        while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
        i = Math.min(i + 2, n);
        blank(start, i);
        continue;
      }
      if (c === "'") state = 'single';
      else if (c === '"') state = 'double';
      else if (c === '`') state = 'template';
      i++;
      continue;
    }

    // Inside a literal: honour escapes, then look for the closing delimiter.
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (
      (state === 'single' && c === "'") ||
      (state === 'double' && c === '"') ||
      (state === 'template' && c === '`')
    ) {
      state = 'code';
    }
    i++;
  }

  return out.join('');
}

/**
 * The body of the declaration starting at `from`: the first `{` at or after it, matched to
 * its closing brace.
 *
 * REPLACES a "everything up to the next declaration" heuristic that was wrong in a way
 * that mattered. `productReadGate` in `routes/salons.ts` is a `const` arrow declared
 * INSIDE `registerSalonRoutes`, immediately before the route that uses it — so its
 * heuristic body swallowed the following `app.get(...)`, the declaration was discarded as
 * a route registrar, and `GET /salons/:id/products` was reported UNGATED when it is
 * gated on `perms.shop` for any staff caller. Two wrappers, two different reasons a
 * name-based reading failed; brace matching removes the second class entirely.
 *
 * String-aware: comments are already gone, but a `}` inside a string literal or a `${}`
 * template would otherwise unbalance the count.
 */
export function bodyOf(src: string, from: number): { start: number; end: number } | null {
  let i = src.indexOf('{', from);
  if (i < 0) return null;
  const start = i;
  let depth = 0;
  let quote: string | null = null;

  for (; i < src.length; i++) {
    const c = src[i]!;
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return { start, end: i + 1 };
    }
  }
  return null;
}

const lineOf = (src: string, index: number): number =>
  src.slice(0, index).split('\n').length;

/**
 * `app.get('/x')`, `app.post<{ Params: … }>('/x')`, across five methods.
 *
 * The generic parameter list is optional and may contain `>` inside it, so it is matched
 * non-greedily up to the `(` rather than by balancing brackets — which is enough here
 * and is asserted to be enough by the route COUNT the spec pins.
 */
const REGISTRATION =
  /\bapp\.(get|post|put|patch|delete)\s*(?:<[\s\S]*?>)?\s*\(\s*(['"])([^'"]+)\2/g;

/**
 * A permission gate, with its argument list captured up to the closing paren.
 *
 * `requirePerm` is listed after the two specific ones so the alternation cannot match it
 * as a prefix of `requireDashboardPerm`; `requirePlatform` is last for the same reason
 * against `requirePlatformScope`, which is a SCOPE guard and deliberately not a gate.
 * Both orderings are pinned by a unit case in the spec.
 */
const GUARD =
  /\b(requireDashboardPerm|requireScannerPerm|requirePerm|requirePlatform)\s*\(([^)]*)\)/g;

/** The scope guards, for explaining an ungated route. Longest-first, same reason. */
const SCOPE_GUARD =
  /\b(requirePlatformScope|requireDashboardScope|requireScannerScope|requireSalonScoped|requirePrincipal|requireMember|requireStaff)\s*\(/g;

/**
 * The surface each guard implies. `requirePerm` names its surface in argument 2, so it
 * is resolved from the call text rather than from the guard name.
 */
function surfaceOf(guard: GuardName, args: string[]): GatedRoute['surface'] {
  if (guard === 'requirePlatform') return 'platform';
  if (guard === 'requireDashboardPerm') return 'dashboard';
  if (guard === 'requireScannerPerm') return 'scanner';
  const named = args[1];
  return named === 'scanner' ? 'scanner' : 'dashboard';
}

/** Quoted argument values, in order. Unquoted arguments (`req`, a variable) become ''. */
function argsOf(raw: string): string[] {
  return raw.split(',').map((a) => {
    const m = a.trim().match(/^['"]([^'"]*)['"]$/);
    return m ? m[1]! : '';
  });
}

/** A helper whose body calls a permission guard: a gate under another name. */
export interface Wrapper {
  name: string;
  file: string;
  guard: GuardName;
  permission: string;
  surface: GatedRoute['surface'];
}

/**
 * Function declarations, both `function f(` and `const f = (`. Used to carve a file into
 * candidate helper bodies — a body being everything up to the next declaration.
 */
const DECLARATION =
  /\b(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(|\bconst\s+(\w+)\s*(?::[^=]+)?=\s*(?:async\s*)?\(/g;

/**
 * Find every permission-guard wrapper in `api/src`, at one level of indirection.
 *
 * A declaration whose body registers routes (`app.<method>(`) is SKIPPED: every
 * `registerXRoutes` function contains dozens of guards and would otherwise be recorded as
 * a wrapper, making every call to it look like a gate.
 */
export function discoverWrappers(): Wrapper[] {
  const found: Wrapper[] = [];
  const walk = (dir: string): string[] => {
    const out: string[] = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) out.push(...walk(full));
      else if (e.name.endsWith('.ts')) out.push(full);
    }
    return out;
  };

  for (const full of walk(join(repoRoot, 'api', 'src'))) {
    const src = stripComments(readFileSync(full, 'utf8'));

    const decls: { index: number; name: string }[] = [];
    for (const m of src.matchAll(DECLARATION)) {
      decls.push({ index: m.index!, name: (m[1] ?? m[2])! });
    }

    for (const d of decls) {
      const span = bodyOf(src, d.index);
      if (!span) continue;
      const body = src.slice(span.start, span.end);
      /**
       * A declaration that registers routes is a route registrar, not a wrapper — every
       * `registerXRoutes` contains dozens of guards and would make every call to it look
       * like a gate. With an accurately-matched body this now excludes exactly those.
       */
      if (/\bapp\.(get|post|put|patch|delete)\s*(?:<[\s\S]*?>)?\s*\(/.test(body)) continue;

      const g = new RegExp(GUARD.source).exec(body);
      if (!g) continue;

      const guard = g[1]! as GuardName;
      const args = argsOf(g[2]!);
      const quoted = args.filter((a) => a !== '');
      found.push({
        name: d.name,
        file: full.slice(full.indexOf('api/src/')),
        guard,
        permission: quoted[quoted.length - 1] ?? '',
        surface: surfaceOf(guard, args),
      });
    }
  }

  // The guards themselves live in auth/principal.ts and are not wrappers of themselves.
  const GATES = new Set<string>([
    'requireDashboardPerm',
    'requireScannerPerm',
    'requirePerm',
    'requirePlatform',
  ]);
  return found.filter((w) => !GATES.has(w.name));
}

export interface Census {
  gated: GatedRoute[];
  ungated: UngatedRoute[];
  /** Every registration found, gated or not. Pinned by the spec so a drop is visible. */
  totalRoutes: number;
  files: string[];
  /** The permission-guard wrappers this census resolved, so the spec can name them. */
  wrappers: Wrapper[];
}

/**
 * Walk `api/src/routes/`, and for each route registration find the FIRST permission
 * guard that appears after it and before the next registration.
 *
 * "Before the next registration" is the handler-body boundary, and it is the reason this
 * works without a TypeScript parser: a guard textually between two `app.<method>(` calls
 * belongs to the first of them. A guard in a shared helper ABOVE the first registration
 * is therefore invisible here, which is failure mode (1) in the header — caught at
 * runtime, not here.
 */
export function censusOfRoutes(): Census {
  const files = readdirSync(ROUTES_DIR)
    .filter((f) => f.endsWith('.ts'))
    .sort();

  const wrappers = discoverWrappers();
  const wrapperByName = new Map(wrappers.map((w) => [w.name, w]));
  const WRAPPER_CALL =
    wrappers.length > 0
      ? new RegExp(`\\b(${wrappers.map((w) => w.name).join('|')})\\s*\\(`, 'g')
      : /(?!)/g;

  const gated: GatedRoute[] = [];
  const ungated: UngatedRoute[] = [];
  let totalRoutes = 0;

  for (const file of files) {
    const raw = readFileSync(join(ROUTES_DIR, file), 'utf8');
    const src = stripComments(raw);

    const registrations: { index: number; method: HttpMethod; path: string }[] = [];
    for (const m of src.matchAll(REGISTRATION)) {
      registrations.push({
        index: m.index!,
        method: m[1]!.toUpperCase() as HttpMethod,
        path: m[3]!,
      });
    }

    const guards: {
      index: number;
      guard: GuardName;
      args: string[];
      permission?: string;
      via?: string;
    }[] = [];
    for (const m of src.matchAll(GUARD)) {
      guards.push({
        index: m.index!,
        guard: m[1]! as GuardName,
        args: argsOf(m[2]!),
      });
    }

    const scopes: { index: number; guard: ScopeGuardName }[] = [];
    for (const m of src.matchAll(SCOPE_GUARD)) {
      scopes.push({ index: m.index!, guard: m[1]! as ScopeGuardName });
    }

    /**
     * A call to a resolved wrapper counts as a gate at the call site, carrying the
     * wrapper's permission. Merged into the same list as the direct guards so that
     * whichever comes FIRST in the handler wins — the gate is the first statement, and a
     * handler doing both should be read as the earlier one.
     */
    for (const m of src.matchAll(WRAPPER_CALL)) {
      const w = wrapperByName.get(m[1]!)!;
      guards.push({ index: m.index!, guard: w.guard, args: [], permission: w.permission, via: w.name });
    }
    guards.sort((a, b) => a.index - b.index);

    totalRoutes += registrations.length;

    registrations.forEach((reg, k) => {
      const end = registrations[k + 1]?.index ?? src.length;
      const hit = guards.find((g) => g.index > reg.index && g.index < end);

      if (!hit) {
        const scope = scopes.find((g) => g.index > reg.index && g.index < end);
        ungated.push({
          file,
          line: lineOf(src, reg.index),
          method: reg.method,
          path: reg.path,
          scope: scope?.guard ?? null,
        });
        return;
      }

      /**
       * The permission is the LAST quoted argument: `requireDashboardPerm(req, 'team')`
       * and `requirePerm(req, 'scanner', 'charges')` both put it there. A call whose
       * permission is a variable yields '' and is reported as UNRESOLVED by the spec
       * rather than silently skipped — a gate this module cannot read is exactly the
       * case that must not pass quietly.
       */
      const quoted = hit.args.filter((a) => a !== '');
      const permission = hit.permission ?? quoted[quoted.length - 1] ?? '';

      gated.push({
        file,
        line: lineOf(src, reg.index),
        method: reg.method,
        path: reg.path,
        guard: hit.guard,
        permission,
        surface: hit.via ? wrapperByName.get(hit.via)!.surface : surfaceOf(hit.guard, hit.args),
        via: hit.via ?? null,
      });
    });
  }

  return { gated, ungated, totalRoutes, files, wrappers };
}

/** `GET /salons/:id/audit` — the stable name a failure reports and an exemption lists. */
export const nameOf = (r: { method: string; path: string }): string => `${r.method} ${r.path}`;

/** `GET /salons/:id/audit [dashboard]` — pair identity, for a per-permission probe. */
export const pairOf = (r: GatedRoute): string => `${nameOf(r)} → ${r.permission}`;
