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
  /**
   * The path AS REGISTERED. Differs from `path` only for an expanded indexed gate, where
   * one registration yields one entry per key — so a count of registrations stays a count
   * of registrations.
   */
  route: string;
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
 * `app.get('/x')`, `app.post<{ Params: … }>('/x')`, across five methods — and on ANY
 * receiver, not only `app`.
 *
 * THE THIRD FAILURE MODE, AND IT HID THE PAYMENT WEBHOOK.
 *
 * The module header names two ways this reading can be wrong: a gate reached through a
 * wrapper, and a gate mentioned in a comment. There is a third, and it is not about the
 * GATE at all — it is about the ROUTE. This pattern was anchored on the literal receiver
 * `app.`, so a route registered on anything else was not merely mis-gated, it was
 * INVISIBLE: outside `totalRoutes`, outside the ungated ledger, and outside every
 * generated probe. A census cannot report a hole in a route it never enumerated.
 *
 * `POST /webhooks/:provider` is registered on `scoped`, an encapsulated Fastify context,
 * because it needs its own raw-body content-type parser for signature verification
 * (`api/src/routes/webhooks.ts:87`). `grep -c 'app\.(get|post|…)'` on that file returns
 * ZERO. So the unauthenticated payment-gateway callback — the one endpoint on the platform
 * that adds money to a wallet and is reachable by a stranger — was the single route this
 * census could not see. Encapsulation is exactly the pattern a security-sensitive route
 * reaches for, which is what makes this the wrong blind spot to have.
 *
 * THE FIX IS THE CLASS, NOT THE CASE. Matching `scoped.` as well would leave the next
 * encapsulated context invisible. The receiver is now any identifier.
 *
 * WHAT STOPS THAT MATCHING EVERYTHING. A bare `<identifier>.<method>(` also describes
 * `names.get(memberId)`, `labels.get(row.topicId)`, `db.delete(campaign)` and
 * `tx.delete(happyHour)` — all of which appear in `api/src/routes/` and none of which is a
 * route. The discriminator is not the receiver's NAME, which is why an allowlist was the
 * wrong shape: it is that a route registration's first argument is a STRING LITERAL
 * BEGINNING WITH `/`. Map keys and Drizzle table objects are neither. That is held by the
 * route COUNT the spec pins, which would move the moment this let a Map lookup in.
 */
const REGISTRATION =
  /\b[A-Za-z_$][\w$]*\.(get|post|put|patch|delete)\s*(?:<[\s\S]*?>)?\s*\(\s*(['"])(\/[^'"]*)\2/g;

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
  /**
   * When the wrapper's guard indexes a permission table — `build()` in `routes/reports.ts`
   * calls `requireDashboardPerm(req, REPORT_PERMISSION[kind])` — the table's name and the
   * indexer variable, so a route gated THROUGH the wrapper can still be expanded per key.
   *
   * Without this the two GET reports routes stayed unresolved while the sibling
   * `POST …/download-url`, which calls the guard directly, expanded fine. Same gate, same
   * table, two different code shapes — and only one of them was being read.
   */
  mapName?: string;
  indexer?: string;
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
       *
       * SAME RECEIVER WIDENING AS `REGISTRATION`, AND FOR THE SAME REASON. Anchored on
       * `app.` this missed `registerWebhookRoutes`, whose body registers on `scoped` —
       * so that registrar was eligible to be recorded as a WRAPPER, and every call to it
       * would have looked like a gate. The two patterns have to agree about what a route
       * registration is, or the census disagrees with itself about the same file.
       */
      if (
        /\b[A-Za-z_$][\w$]*\.(get|post|put|patch|delete)\s*(?:<[\s\S]*?>)?\s*\(\s*(['"])\//.test(
          body,
        )
      ) {
        continue;
      }

      /**
       * EVERY GUARD IN THE BODY, NOT THE FIRST — a wrapper can be DISJUNCTIVE.
       *
       * This was `.exec(body)`, which takes the first match and stops, and the assumption
       * underneath it was that a wrapper applies one gate. `requireQueueReader`
       * (`api/src/routes/support.ts:414`) does not:
       *
       *     if (p.kind === 'member')         throw forbidden(...)
       *     if (p.kind === 'platform_admin') return requirePlatform(req, 'policies');
       *     return requireDashboardPerm(req, 'dashboard');
       *
       * Two guards, chosen by principal kind. Reading only the first censused
       * `GET /v1/support/tickets` and `PATCH /v1/support/tickets/:id` as `policies` and
       * gave the merchant `dashboard` branch NO generated probe at all — so a merchant-side
       * authority regression on the staffed support queue would have been silent. The only
       * nearby hand-written test (`support-routing.test.ts:1034`) probes the MEMBER
       * refusal, which is the `throw` above and neither of these branches.
       *
       * A wrapper with N guard paths is now N wrapper records under one name, and the
       * census expands the routes that call it into one (route, gate) pair per path. The
       * `throw forbidden(...)` branch is deliberately NOT one of them: it is a flat refusal
       * with no permission to switch off, so there is nothing for a probe to grant back.
       *
       * DE-DUPLICATED ON (guard, permission), because a wrapper that calls the same gate
       * twice — an early return and a fallthrough — is one gate, not two, and would
       * otherwise generate two identical probes.
       */
      const seen = new Set<string>();
      for (const g of body.matchAll(new RegExp(GUARD.source, 'g'))) {
        const guard = g[1]! as GuardName;
        const args = argsOf(g[2]!);
        const quoted = args.filter((a) => a !== '');
        const permission = quoted[quoted.length - 1] ?? '';
        if (seen.has(`${guard} ${permission}`)) continue;
        seen.add(`${guard} ${permission}`);
        const idx = /(\w+)\s*\[\s*(\w+)\s*\]/.exec(g[2]!);
        found.push({
          name: d.name,
          file: full.slice(full.indexOf('api/src/')),
          guard,
          permission,
          surface: surfaceOf(guard, args),
          ...(idx ? { mapName: idx[1]!, indexer: idx[2]! } : {}),
        });
      }
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

/**
 * A permission chosen BY a path parameter, through an exported lookup table.
 *
 * `routes/reports.ts` gates on `requireDashboardPerm(req, REPORT_PERMISSION[kind])`, so
 * the permission is not a literal and a name-based read records `''`. The first fix here
 * was a hand-kept exemption ledger naming the routes; it was WRONG IN THE WAY THIS WHOLE
 * MODULE EXISTS TO AVOID, and said so within a day — lane A added a THIRD reports route
 * (`POST /salons/:id/reports/:kind/download-url`) and the ledger, listing two, failed on
 * it. An exemption list needs an entry per route; reading the map needs none.
 *
 * So the table is read from source. `REPORT_PERMISSION` has one owner, and this is not a
 * second copy of it: a kind added there is probed here on the next run with no edit.
 */
export interface PermissionMap {
  name: string;
  file: string;
  /** kind → permission, in declaration order. */
  entries: Array<[string, string]>;
}

/**
 * `export const NAME: Record<Something, PermissionName> = { key: 'value', … }`.
 *
 * Deliberately narrow: it matches a `PermissionName`- or `PlatformSection`-valued record,
 * so an unrelated string map cannot be mistaken for a permission table. The body is
 * matched to the first `}` because these tables are flat by construction.
 */
const PERMISSION_MAP =
  /export\s+const\s+(\w+)\s*:\s*Record<[^>]*,\s*(?:PermissionName|PlatformSection)\s*>\s*=\s*\{([^}]*)\}/g;

export function discoverPermissionMaps(): PermissionMap[] {
  const maps: PermissionMap[] = [];
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
    for (const m of src.matchAll(PERMISSION_MAP)) {
      const entries: Array<[string, string]> = [];
      for (const e of m[2]!.matchAll(/['"]?([\w-]+)['"]?\s*:\s*['"]([\w-]+)['"]/g)) {
        entries.push([e[1]!, e[2]!]);
      }
      if (entries.length > 0) {
        maps.push({ name: m[1]!, file: full.slice(full.indexOf('api/src/')), entries });
      }
    }
  }
  return maps;
}

export interface Census {
  gated: GatedRoute[];
  ungated: UngatedRoute[];
  /** Every registration found, gated or not. Pinned by the spec so a drop is visible. */
  totalRoutes: number;
  files: string[];
  /** The permission-guard wrappers this census resolved, so the spec can name them. */
  wrappers: Wrapper[];
  /** The permission lookup tables it read, so the spec can pin what it found. */
  permissionMaps: PermissionMap[];
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
  const permissionMaps = discoverPermissionMaps();
  const wrapperByName = new Map(wrappers.map((w) => [w.name, w]));
  /**
   * All of a wrapper's gates, under its one name — see the disjunctive-wrapper note in
   * `discoverWrappers`. `wrapperByName` keeps the FIRST for the places that need a single
   * representative (surface, indexed-map fallback); this is what the route expansion below
   * iterates so a two-branch wrapper yields two probes.
   */
  const wrapperGates = new Map<string, Wrapper[]>();
  for (const w of wrappers) {
    const list = wrapperGates.get(w.name);
    if (list) list.push(w);
    else wrapperGates.set(w.name, [w]);
  }
  const WRAPPER_CALL =
    wrappers.length > 0
      ? new RegExp(`\\b(${[...new Set(wrappers.map((w) => w.name))].join('|')})\\s*\\(`, 'g')
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
      raw?: string;
      permission?: string;
      via?: string;
    }[] = [];
    for (const m of src.matchAll(GUARD)) {
      guards.push({
        index: m.index!,
        guard: m[1]! as GuardName,
        args: argsOf(m[2]!),
        raw: m[2]!,
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

      /**
       * AN INDEXED LOOKUP EXPANDS INTO ONE ROUTE PER KEY. `requireDashboardPerm(req,
       * REPORT_PERMISSION[kind])` on `/salons/:id/reports/:kind` becomes four probeable
       * routes with `:kind` replaced by each literal kind and the permission resolved —
       * so the generated sweep drives every kind, and a kind added to the map is driven
       * on the next run with no edit here.
       *
       * The INDEXER NAMES THE PATH PARAMETER: `[kind]` binds `:kind`. Matching them is
       * what makes the substitution honest rather than positional — a route indexed by
       * something absent from its path is left unresolved and reported, not guessed at.
       */
      if (permission === '') {
        const w = hit.via ? wrapperByName.get(hit.via) : undefined;
        const direct = hit.raw ? /(\w+)\s*\[\s*(\w+)\s*\]/.exec(hit.raw) : null;
        // The call site's own lookup, or the wrapper's — whichever exists.
        const idx: [string, string] | null = direct
          ? [direct[1]!, direct[2]!]
          : w?.mapName && w.indexer
            ? [w.mapName, w.indexer]
            : null;
        const map = idx ? permissionMaps.find((m) => m.name === idx[0]) : undefined;
        if (idx && map && reg.path.includes(`:${idx[1]}`)) {
          for (const [k, perm] of map.entries) {
            gated.push({
              file,
              line: lineOf(src, reg.index),
              method: reg.method,
              path: reg.path.replace(`:${idx[1]}`, k),
              route: reg.path,
              guard: hit.guard,
              permission: perm,
              surface: hit.via
                ? wrapperByName.get(hit.via)!.surface
                : surfaceOf(hit.guard, hit.args),
              via: hit.via ?? null,
            });
          }
          return;
        }
      }

      /**
       * ONE PAIR PER GATE PATH. A direct guard call is one; a DISJUNCTIVE wrapper is one
       * per branch, so `GET /v1/support/tickets` now censuses as both
       * `→ policies` (the console admin) and `→ dashboard` (the merchant) instead of only
       * the first branch the regex happened to reach.
       */
      const paths =
        hit.via && (wrapperGates.get(hit.via)?.length ?? 0) > 1
          ? wrapperGates.get(hit.via)!.map((w) => ({
              guard: w.guard,
              permission: w.permission,
              surface: w.surface,
            }))
          : [
              {
                guard: hit.guard,
                permission,
                surface: hit.via
                  ? wrapperByName.get(hit.via)!.surface
                  : surfaceOf(hit.guard, hit.args),
              },
            ];

      for (const p of paths) {
        gated.push({
          file,
          line: lineOf(src, reg.index),
          method: reg.method,
          path: reg.path,
          route: reg.path,
          guard: p.guard,
          permission: p.permission,
          surface: p.surface,
          via: hit.via ?? null,
        });
      }
    });
  }

  return { gated, ungated, totalRoutes, files, wrappers, permissionMaps };
}

/** `GET /salons/:id/audit` — the stable name a failure reports and an exemption lists. */
export const nameOf = (r: { method: string; path: string }): string => `${r.method} ${r.path}`;

/** `GET /salons/:id/audit [dashboard]` — pair identity, for a per-permission probe. */
export const pairOf = (r: GatedRoute): string => `${nameOf(r)} → ${r.permission}`;

// ===========================================================================
// WHAT THE SCANNER CANNOT SEE — and how it is made to say so
// ===========================================================================

/**
 * THE FAILURE MODE THIS SECTION EXISTS FOR, STATED BEFORE THE CODE.
 *
 * Everything above reads SOURCE TEXT and produces a proposal. The module header names
 * three ways that reading can be wrong about a GATE. There is a fourth, it is about the
 * ROUTE, and it is worse than all three because it is SILENT IN BOTH DIRECTIONS:
 *
 *   a route this scanner cannot see is not reported as ungated, or as unresolved, or as
 *   anything. It leaves `totalRoutes`, it leaves `gated`, it leaves `ungated`, and every
 *   probe generated from it stops being generated. The suite then reports success with
 *   less coverage than it had, and the number that would have said so — `totalRoutes` —
 *   went down by exactly the same amount, so the reconciliation still balances.
 *
 * This has now happened twice on this project, from opposite directions:
 *
 *   LANE A, images. The four write routes were registered through a curried handler
 *   factory, so the guard was not a literal at the registration site and the permission
 *   was read out of a table keyed on the owner kind. Four merchant writes, zero
 *   permission-off probes. `routes/images.ts` carries lane A's own account of it and the
 *   fix was to move the guard to a literal — which fixes the FILE and not the SCANNER.
 *
 *   LANE C, `merchantScopeGates.test.ts`. Extracting a path into a helper dropped an
 *   endpoint from a generated sweep: 44 cases became 43 and nothing turned red.
 *
 * MEASURED, NOT ARGUED. Extracting `POST /scans`'s path into a `const` in
 * `api/src/routes/staff.ts` — a refactor no reviewer would stop — takes this census from
 * 129 routes to 128 and `permission-census.test.ts` from 183 specs to 181, ALL GREEN. The
 * two that vanished are the permission-off probe and the grant-back probe on the scanner's
 * member-resolve endpoint.
 *
 * Two things answer it, and they answer different halves:
 *
 *   `ambiguousRegistrations()` below catches a route BORN unreadable — a registration
 *   site this scanner can see is there but cannot resolve to a path. Nothing else can
 *   catch that, because there is no earlier state to compare against.
 *
 *   `censusLedger()` below is the pinnable classification of every route the scanner CAN
 *   read. `permission-census.test.ts` pins it line by line, so a route or a gate that
 *   stops being readable fails BY NAME rather than by a count that was never tight
 *   enough to notice.
 */

/** A `.get(`/`.post(`/… call site, resolved past its type arguments. */
interface CallSite {
  file: string;
  line: number;
  method: HttpMethod;
}

/**
 * Skip a balanced `<…>` type-argument list starting at `i`, or return `i` unchanged.
 *
 * HAND-WRITTEN RATHER THAN A REGEX, and the reason is a real defect rather than taste.
 * `REGISTRATION` matches the generic as `<[\s\S]*?>`, which is lazy and crosses
 * newlines — so when the following registration's path is NOT a literal, the match
 * happily runs the generic on until it finds the NEXT literal in the file. Measured on a
 * mutated `routes/images.ts`: with `DELETE /v1/salons/:id/services/:oid/image`'s path
 * extracted into a const, the scanner produced `DELETE /v1/images/:imageId` — a route
 * that does not exist, with the wrong method, while the GET that does exist vanished.
 * A scanner that INVENTS a route under an unreadable one is worse than one that merely
 * loses it, so the ambiguity pass must not share that weakness.
 */
function skipTypeArgs(src: string, i: number): number {
  if (src[i] !== '<') return i;
  let depth = 0;
  let quote: string | null = null;
  for (let k = i; k < src.length; k++) {
    const c = src[k]!;
    if (quote) {
      if (c === '\\') { k++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if (c === '<') depth++;
    else if (c === '>') {
      depth--;
      if (depth === 0) return k + 1;
    }
  }
  return i;
}

/** The top-level arguments of the call whose `(` is at `open`, as raw text. */
function argumentsAt(src: string, open: number): string[] | null {
  const args: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = open + 1;
  for (let k = open; k < src.length; k++) {
    const c = src[k]!;
    if (quote) {
      if (c === '\\') { k++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) {
        const last = src.slice(start, k).trim();
        if (last !== '' || args.length > 0) args.push(last);
        return args;
      }
    } else if (c === ',' && depth === 1) {
      args.push(src.slice(start, k).trim());
      start = k + 1;
    }
  }
  return null;
}

/**
 * Every `<identifier>.(get|post|put|patch|delete)(…)` call in `api/src/routes/`, with its
 * type arguments resolved properly.
 */
function callSites(): { site: CallSite; args: string[] | null }[] {
  const out: { site: CallSite; args: string[] | null }[] = [];
  const METHOD_CALL = /\b[A-Za-z_$][\w$]*\.(get|post|put|patch|delete)\s*/g;

  for (const file of readdirSync(ROUTES_DIR).filter((f) => f.endsWith('.ts')).sort()) {
    const src = stripComments(readFileSync(join(ROUTES_DIR, file), 'utf8'));
    for (const m of src.matchAll(METHOD_CALL)) {
      const at = m.index!;
      const site = {
        file,
        line: lineOf(src, at),
        method: m[1]!.toUpperCase() as HttpMethod,
      };
      let i = skipTypeArgs(src, at + m[0].length);
      /**
       * `skipTypeArgs` returned its input, so there IS a `<` here and it does not
       * balance — a generic this walker cannot read. `args: null` rather than a skip,
       * because "I found a registration and could not find its arguments" is exactly
       * the thing that must be loud. A `.get`/`.post` that is not a call at all
       * (`const g = map.get;`) is dropped below, where the next character says so.
       */
      if (src[i] === '<') {
        out.push({ site, args: null });
        continue;
      }
      while (i < src.length && /\s/.test(src[i]!)) i++;
      if (src[i] !== '(') continue;
      const args = argumentsAt(src, i);
      out.push({ site, args });
    }
  }
  return out;
}

export interface AmbiguousRegistration {
  file: string;
  line: number;
  method: HttpMethod;
  /** The first argument, verbatim — the thing that should have been a path literal. */
  first: string;
}

/**
 * Call sites that LOOK like route registrations and whose path this census cannot read.
 *
 * THE DISCRIMINATOR IS ARITY, NOT THE RECEIVER'S NAME. `REGISTRATION`'s own comment
 * settles why an allowlist of receivers is the wrong shape — `POST /webhooks/:provider`
 * is registered on `scoped`, and the next encapsulated context would be invisible again.
 * But its discriminator ("the first argument is a string literal beginning with `/`") is
 * the thing being defeated here, so it cannot also be the thing that decides whether a
 * call site was SUPPOSED to be a route.
 *
 * Arity can. A Fastify registration is `(path, handler)` or `(path, opts, handler)` —
 * never fewer than two arguments. Every non-route call of these names in
 * `api/src/routes/` takes exactly ONE: `names.get(t.memberId)`, `labels.get(row.topicId)`,
 * `images.get(r.id)`, `imageStore.get(row.storageKey)`, `db.delete(campaign)`,
 * `tx.delete(happyHour)`. Drizzle chains its predicates (`.where(…)`) rather than passing
 * them, which is what makes the split clean rather than lucky — checked across all
 * thirty route files, and the spec that consumes this asserts the one-argument calls are
 * still there so a future two-argument Map API cannot quietly become a false positive.
 *
 * WHAT THIS BUYS. `app.post(SCANS_ROUTE, handler)` is two arguments with a first that is
 * not a path literal, and is reported here by file and line. That is the shape that took
 * this census from 129 routes to 128 with every spec green.
 */
export function ambiguousRegistrations(): AmbiguousRegistration[] {
  return callSites()
    .filter(({ args }) => args === null || (args.length >= 2 && !/^(['"])\//.test(args[0] ?? '')))
    .map(({ site, args }) => ({
      file: site.file,
      line: site.line,
      method: site.method,
      first:
        args === null
          ? '(unreadable — the type arguments or the argument list do not balance)'
          : (args[0] ?? '').replace(/\s+/g, ' ').slice(0, 80),
    }));
}

/** Call sites with a single argument — a Map read, a Drizzle delete. Not routes. */
export function singleArgumentCallSites(): number {
  return callSites().filter(({ args }) => args?.length === 1).length;
}

/**
 * THE PINNABLE CLASSIFICATION — one line per (route, decision) this census reached.
 *
 *   `POST /scans → scanner`                     a gate, and which permission
 *   `GET /members/me [requireMember]`           authenticated, no permission applies
 *   `POST /webhooks/:provider [ANONYMOUS]`      authenticates nobody
 *
 * A GATED ROUTE CONTRIBUTES ONE LINE PER GATE PATH, which is the identity of a generated
 * probe rather than of a registration: a disjunctive wrapper yields two, and an indexed
 * permission table yields one per key. That is deliberate — the thing that must not
 * silently shrink is the PROBE SET, not the route count, and those two came apart the day
 * `REPORT_PERMISSION` was expanded.
 *
 * SORTED, so a pin is a stable text block and a diff of it is readable.
 */
export function censusLedger(census: Census): string[] {
  const lines = [
    ...census.gated.map(pairOf),
    ...census.ungated.map((u) => `${nameOf(u)} [${u.scope ?? 'ANONYMOUS'}]`),
  ];
  return [...new Set(lines)].sort();
}
