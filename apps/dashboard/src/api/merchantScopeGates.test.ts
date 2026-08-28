import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripComments } from '../testing/stripComments.js';

/**
 * A DASHBOARD SESSION MUST NOT CALL A SCANNER-GATED ENDPOINT.
 *
 * `api/src/auth/principal.ts` checks two things, in this order, and the order is the
 * whole subject of this file:
 *
 *   1. SURFACE   is this the right KIND of credential? A session is minted as a
 *                `scanner` session or a `dashboard` session and never changes kind.
 *   2. PERMISSION is this credential authorised?
 *
 * The second is recoverable — a manager can grant a permission. The FIRST IS NOT.
 * `requireScannerPerm` demands a device-bound PIN session, so a web principal is
 * refused "whatever permissions she holds", in that file's own words. There is no
 * grant, no setting and no role that fixes it.
 *
 * WHAT WENT WRONG. `useRecentActivity` — the Recent activity panel on Merchant →
 * Overview, the first screen a salon owner sees after signing in — requested
 * `GET /charges`, which is `requireScannerPerm(req, 'charges')` (charges.ts:226). The
 * owner holds all nine permissions including `charges` and was refused every time,
 * because she was holding a web session. The panel rendered the 403 as "You don't have
 * access to this", under a heading reading "Recent activity", on every load since the
 * screen was built.
 *
 * It was invisible for three compounding reasons, and the third is why this file is a
 * test and not a corrected comment:
 *
 *   the refusal was EXPECTED   `salon.ts` carried "a web principal reading GET /charges
 *                              gets a 403 by design", and `Overview.tsx` carried "No web
 *                              principal satisfies it whatever permissions she holds".
 *                              Both true about `GET /charges`. Neither is a reason for
 *                              this panel to read it.
 *   the explain state WORKED   a correct, well-written 403 state made a broken screen
 *                              look like a designed one.
 *   the right endpoint EXISTED `GET /salons/{id}/activity` was built for this panel,
 *                              gated `requireDashboardPerm(req, 'dashboard')`, and says
 *                              so in its own header. The client simply never pointed at
 *                              it. Nothing in the dashboard could notice.
 *
 * =========================================================================
 * THE SURFACES ARE DERIVED, WHICH IS THE ONLY PROPERTY THAT MATTERS HERE
 * =========================================================================
 * There is no table of expected endpoints in this file. `gatesFromRoutes()` reads
 * `api/src/routes/*.ts` and extracts, for every registered route, the guard call that
 * opens its handler. `merchantCalls()` reads what this dashboard actually REQUESTS. The
 * two are matched by path, and a merchant-scope call landing on a scanner-surface guard
 * fails BY CALL SITE.
 *
 * So a hand-kept list cannot rot here, because there is no hand-kept list. This is the
 * method `consoleNavGates.test.ts` established for the console sidebar, pointed at the
 * other half of non-negotiable #7: that file checks the courtesy the UI performs, this
 * one checks the request the UI makes.
 *
 * A ZERO RESULT IS A CLAIM ABOUT THE PARSER, so both parsers are proved against known
 * positives before anything is concluded from them — see § "the parsers are
 * load-bearing". This is not a theoretical hazard here. The first scan written for this
 * investigation matched `authedRequest<T>(` with `<[^>]*>` and therefore skipped every
 * call with a NESTED generic — `authedRequest<Paginated<Transaction>>` among them, which
 * is the exact call this file exists to catch. It reported a clean sweep. Both shapes are
 * pinned below.
 */

/** `apps/dashboard/src/api` → repo root. */
const REPO = join(__dirname, '..', '..', '..', '..');
const ROUTES_DIR = join(REPO, 'api', 'src', 'routes');
const API_DIR = join(REPO, 'apps', 'dashboard', 'src', 'api');

// ------------------------------------------------------------ the server --

/**
 * `app.get('/path'` and `app.get<{ Querystring: … }>(\n  '/path'`.
 *
 * Lifted verbatim from `consoleNavGates.test.ts`, including the reason: Fastify routes
 * here are frequently registered with a type parameter, which pushes the path string
 * onto the next line. A regex anchored to `app.get('` misses those entirely.
 */
const REGISTRATION = /\bapp\.(get|post|put|patch|delete)\s*(?:<[\s\S]*?>)?\s*\(\s*(['"])([^'"]+)\2/g;

/**
 * The surface guard opening a handler.
 *
 * `requireScannerPerm` / `requireScannerScope` demand a PIN session; `requireDashboard*`
 * demand a web one; `requireStaff(req, 'either')` and `requireSalonScoped` accept both.
 * Only the SCANNER half is disqualifying for this dashboard, so that is what is captured
 * — the alternative, a list of every acceptable guard, is a hand-kept list of exactly the
 * sort this file refuses to keep.
 */
const SCANNER_GUARD = /\brequireScanner(?:Perm|Scope)\s*\(\s*req\b/;

export interface RouteGate {
  /** `GET /charges` — method and registered path. */
  name: string;
  /** True where the handler opens with a scanner-surface guard. */
  scannerOnly: boolean;
  /** `charges.ts:226`, so a failure can be acted on. */
  where: string;
}

/**
 * A handler's extent is "this registration to the next one" — coarse on purpose, for the
 * reason `consoleNavGates.test.ts` gives: the alternative is brace-matching a TypeScript
 * file, and the only question being asked of the span is which guard is inside it.
 */
function gatesFromRoutes(): RouteGate[] {
  const files = readdirSync(ROUTES_DIR)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .sort();

  const found: RouteGate[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const src = stripComments(readFileSync(join(ROUTES_DIR, file), 'utf8'));
    const hits = [...src.matchAll(REGISTRATION)];
    for (let k = 0; k < hits.length; k++) {
      const start = hits[k]!.index!;
      const end = k + 1 < hits.length ? hits[k + 1]!.index! : src.length;
      const name = `${hits[k]![1]!.toUpperCase()} ${hits[k]![3]!}`;
      if (seen.has(name)) continue;
      seen.add(name);
      found.push({
        name,
        scannerOnly: SCANNER_GUARD.test(src.slice(start, end)),
        where: `${file}:${src.slice(0, start).split('\n').length}`,
      });
    }
  }
  return found;
}

const GATES = gatesFromRoutes();

// ------------------------------------------------------------ the client --

/**
 * `authedRequest<T>('merchant', path, { method })`.
 *
 * `[\s\S]{0,160}?` spans the type argument rather than trying to match it. The generic
 * is optional, frequently NESTED (`<Paginated<Transaction>>`), and sometimes carries a
 * line break — every anchored attempt at it drops real calls, silently, which is the
 * failure this whole file is about. The scope literal is the anchor instead, because it
 * is the one token that cannot be absent.
 *
 * THE PATH IS THE HARDER HALF, and a lazy `` `…*?` `` is wrong for it. `audit.ts` and
 * `bookings.ts` build a query string INSIDE the path with a nested template —
 * `` `/salons/${id}/audit${query ? `?${query}` : ''}` `` — and a lazy matcher ends the
 * outer literal at the nested opening backtick, truncating the path to something that
 * resolves to no route. `TEMPLATE` therefore consumes `${…}` as a unit, allowing one
 * level of nested template inside it, so the path comes out whole. Both files' shapes
 * are pinned below; without this they were two silent holes in the sweep.
 */
/** A backtick, written as an escape so these patterns can live in template literals. */
const BT = String.raw`\x60`;

/** One template literal, consuming `${…}` as a unit with one level of nesting inside it. */
const TEMPLATE = String.raw`(?:[^\x60$\\]|\\.|\$(?!\{)|\$\{(?:[^{}\x60]|\x60[^\x60]*\x60)*\})*`;

/** One `${…}` interpolation, nesting-aware, for reducing a path literal. */
const INTERP = new RegExp(String.raw`\$\{(?:[^{}\x60]|\x60[^\x60]*\x60)*\}`, 'g');

/**
 * `authedRequest` AND `authedRequestDetailed`, AND THE SECOND NAME IS WHY THIS
 * COMMENT EXISTS.
 *
 * `\b` after `authedRequest` does not match `authedRequestDetailed` — `D` is a word
 * character, so the boundary is not there. When the image upload was written against
 * the new wrapper, `POST /v1/salons/{id}/products/{pid}/image` became invisible to
 * this sweep and the suite went GREEN, one test heavier, having quietly stopped
 * covering a route it should cover.
 *
 * That is precisely the failure this file's header describes — "a zero result is a
 * claim about the parser" — arriving through a new function name rather than a new
 * regex. A scan anchored on an identifier has to be widened every time the identifier
 * is, and nothing but a pin makes that visible. There is one below.
 *
 * ONE CALL REMAINS OUT OF REACH BY CONSTRUCTION, and it is named rather than left to
 * be discovered: `useProductImage` in `productImage.ts` requests `ImageRef.url`, a
 * server-minted ABSOLUTE url held in a variable. There is no path literal at the call
 * site for `normalisePath` to reduce, so it matches nothing here. It resolves to
 * `GET /v1/images/:imageId`, which `routes/images.ts` gates with `requireSalonScoped`
 * — a dashboard session satisfies it, so the property this file checks holds. It just
 * holds by reading, not by this parse.
 */
const CALL = new RegExp(
  String.raw`authedRequest(?:Detailed)?\b[\s\S]{0,160}?\(\s*'(merchant|owner)'\s*,\s*` +
    `(${BT}${TEMPLATE}${BT}|'[^']*')` +
    String.raw`\s*(?:,\s*\{([\s\S]{0,240}?)\})?`,
  'g',
);

export interface DashboardCall {
  scope: 'merchant' | 'owner';
  /** `GET /charges` — method defaults to GET, as `RequestOptions` does. */
  name: string;
  /** `salon.ts:122`. */
  where: string;
}

/** The stand-in for an interpolated path segment. Never appears in source. */
const WILDCARD = '\u0001';

/**
 * A path literal reduced to something that can be matched against a route.
 *
 * TWO KINDS OF `${…}` AND THE DIFFERENCE MATTERS. An interpolation standing as a whole
 * segment is a path PARAMETER — `` `/staff/${staffId}` `` — and must survive as a
 * wildcard. An interpolation glued to the end of a segment is a QUERY SUFFIX —
 * `` `/salons/${id}/audit${query ? `?${query}` : ''}` `` — and must be dropped, because
 * `?…` is not part of the registered path and leaving it in resolves to no route at all.
 * The character in front of it is what separates the two: a `/` means a new segment.
 *
 * Both were silently unresolvable before this rule, which is two calls the sweep could
 * not see. Neither was the defect being hunted; either could have been.
 */
function normalisePath(literal: string): string {
  const body = literal.replace(/^[`']|[`']$/g, '');
  // Same nesting allowance as `TEMPLATE`: a lazy `\$\{[\s\S]*?\}` stops at the `}` of
  // the INNER `${query}` and leaves the tail of the ternary in the path.
  const marked = body.replace(INTERP, WILDCARD);
  return marked.replace(new RegExp(`([^/])${WILDCARD}`, 'g'), '$1');
}

function callsFromDashboard(): DashboardCall[] {
  const files = readdirSync(API_DIR)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .sort();

  const calls: DashboardCall[] = [];
  for (const file of files) {
    const src = stripComments(readFileSync(join(API_DIR, file), 'utf8'));
    for (const m of src.matchAll(CALL)) {
      const method = (/\bmethod:\s*'(\w+)'/.exec(m[3] ?? '') ?? [, 'GET'])[1]!.toUpperCase();
      calls.push({
        scope: m[1] as 'merchant' | 'owner',
        name: `${method} ${normalisePath(m[2]!)}`,
        where: `${file}:${src.slice(0, m.index!).split('\n').length}`,
      });
    }
  }
  return calls;
}

const CALLS = callsFromDashboard();

/**
 * The route a call lands on.
 *
 * A wildcard matches a run of non-slash characters, which covers both a path parameter
 * and a trailing `?query` suffix — the two things `${…}` interpolates in this codebase.
 */
function routeFor(call: DashboardCall): RouteGate | undefined {
  const sp = call.name.indexOf(' ');
  const [method, path] = [call.name.slice(0, sp), call.name.slice(sp + 1)];
  return GATES.find((g) => {
    const gs = g.name.indexOf(' ');
    if (g.name.slice(0, gs) !== method) return false;
    const pattern = g.name
      .slice(gs + 1)
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/:[A-Za-z]+/g, '[^/]+');
    return new RegExp(`^${pattern}$`).test(path.split(WILDCARD).join('X'));
  });
}

// -------------------------------------------------------- the parsers --

/**
 * § THE PARSERS ARE LOAD-BEARING.
 *
 * Every assertion below is a lookup into one of two parses. If either came back empty or
 * shallow, the sweep would be vacuously green — "no merchant call hits a scanner route"
 * is trivially true of no merchant calls at all. That is not a hypothetical: it is what
 * the first version of this scan reported, and the bug was live at the time.
 */
describe('the parsers', () => {
  it('finds a substantial number of routes, not a handful', () => {
    // 123 at the time of writing. A floor far below the real number — a smoke alarm for
    // a regex that stopped matching, not a count to maintain.
    expect(GATES.length).toBeGreaterThan(80);
  });

  it('reads a scanner guard off a route that has one', () => {
    expect(GATES.find((g) => g.name === 'GET /charges')?.scannerOnly).toBe(true);
  });

  it('distinguishes a dashboard route from one it failed to parse', () => {
    // A parser returning `false` for everything would pass the sweep by accident, so a
    // known dashboard-surface route is pinned as NOT scanner-only.
    const activity = GATES.find((g) => g.name === 'GET /salons/:id/activity');
    expect(activity, 'GET /salons/{id}/activity is not registered in api/src/routes').toBeDefined();
    expect(activity?.scannerOnly).toBe(false);
  });

  it('finds a substantial number of dashboard calls, not a handful', () => {
    expect(CALLS.length).toBeGreaterThan(30);
  });

  /**
   * THE CASE THAT WAS ACTUALLY MISSED. `authedRequest<Paginated<Transaction>>(…)` has a
   * nested type argument; a `<[^>]*>` pattern stops at the inner `>` and the call never
   * matches. The Overview feed is written this way, so a parser with that flaw reports a
   * clean sweep of a dashboard containing this exact defect.
   */
  it('reads a call whose type argument is nested', () => {
    const src = "authedRequest<Paginated<Transaction>>('merchant', '/charges', { signal })";
    const m = [...src.matchAll(CALL)];
    expect(m).toHaveLength(1);
    expect(normalisePath(m[0]![2]!)).toBe('/charges');
  });

  it('reads a call whose path is a template literal with an interpolation', () => {
    const src = "authedRequest<Salon>('merchant', `/salons/${salonId}/metrics`, { signal })";
    const m = [...src.matchAll(CALL)];
    expect(m).toHaveLength(1);
    expect(normalisePath(m[0]![2]!)).toBe(`/salons/${WILDCARD}/metrics`);
  });

  /**
   * THE OTHER SHAPE THAT WAS SILENTLY DROPPED. `audit.ts` and `bookings.ts` append a
   * query string inside the path literal with a nested template. Before the rule in
   * `normalisePath`, both reduced to a path matching no route — two calls the sweep
   * could not see, in files it was supposed to be covering.
   */
  it('keeps an interpolated segment and drops an interpolated query suffix', () => {
    expect(normalisePath('`/staff/${staffId}`')).toBe(`/staff/${WILDCARD}`);
    const withQuery = '`/salons/${salonId}/audit${query ? `?${query}` : \'\'}`';
    expect(normalisePath(withQuery)).toBe(`/salons/${WILDCARD}/audit`);
  });

  it('reads a call whose path carries a nested query template', () => {
    const src =
      "authedRequest<AuditPage>('merchant', `/salons/${salonId}/audit${query ? `?${query}` : ''}`)";
    const m = [...src.matchAll(CALL)];
    expect(m).toHaveLength(1);
    expect(routeFor({ scope: 'merchant', name: `GET ${normalisePath(m[0]![2]!)}`, where: 'x' })?.name)
      .toBe('GET /salons/:id/audit');
  });

  /**
   * THE NAME THAT DEFEATED THE ANCHOR. `authedRequestDetailed` is the same call with
   * the response status attached — the image upload needs it, because 201 and 200 mean
   * "added" and "changed". It carries a merchant session and reaches a gated route
   * exactly as `authedRequest` does, so it belongs in this sweep, and for one commit it
   * was not in it.
   */
  it('reads a call made through the status-carrying wrapper', () => {
    const src =
      "authedRequestDetailed<ImageRef>('merchant', `/v1/salons/${salonId}/products/${id}/image`, { method: 'POST' })";
    const m = [...src.matchAll(CALL)];
    expect(m).toHaveLength(1);
    expect(normalisePath(m[0]![2]!)).toBe(`/v1/salons/${WILDCARD}/products/${WILDCARD}/image`);
    expect(
      routeFor({ scope: 'merchant', name: `POST ${normalisePath(m[0]![2]!)}`, where: 'x' })?.name,
    ).toBe('POST /v1/salons/:id/products/:oid/image');
  });

  it('picks the method out of the options object, defaulting to GET', () => {
    const one = [..."authedRequest<void>('merchant', '/staff/x', { method: 'DELETE' })".matchAll(CALL)];
    expect((/\bmethod:\s*'(\w+)'/.exec(one[0]![3] ?? '') ?? [, 'GET'])[1]).toBe('DELETE');
  });

  it('ignores authedRequest written in a comment', () => {
    // Both files under test discuss `authedRequest<Salon>` in prose — `settings.ts` names
    // it twice as the cast it refuses to make. Unblanked, those would enter the sweep as
    // real calls against paths that are not there.
    const raw = "const a = 1;\n/* authedRequest<X>('merchant', '/charges') */\nconst b = 2;";
    const stripped = stripComments(raw);
    expect([...stripped.matchAll(CALL)]).toHaveLength(0);
    expect(stripped.split('\n')).toHaveLength(raw.split('\n').length);
  });

  it('resolves a call to the route it hits', () => {
    const call: DashboardCall = { scope: 'merchant', name: `GET /salons/${WILDCARD}/metrics`, where: 'x' };
    expect(routeFor(call)?.name).toBe('GET /salons/:id/metrics');
  });
});

// ------------------------------------------------------------- the sweep --

describe('no merchant-scope call reaches a scanner-only endpoint', () => {
  const merchant = CALLS.filter((c) => c.scope === 'merchant');

  it('has merchant calls to check, so the sweep is not vacuous', () => {
    expect(merchant.length).toBeGreaterThan(15);
  });

  it('resolves every merchant call to a registered route', () => {
    // An unresolvable path is not itself the defect this file hunts, but it blinds the
    // sweep to that call — so it fails here rather than passing in silence.
    const unresolved = merchant.filter((c) => !routeFor(c)).map((c) => `${c.name}  (${c.where})`);
    expect(unresolved, `these merchant calls match no route in api/src/routes:\n${unresolved.join('\n')}`).toEqual([]);
  });

  for (const call of merchant) {
    it(`${call.name} — ${call.where}`, () => {
      const route = routeFor(call);
      if (!route) return; // reported by the case above; not re-reported here.
      expect(
        route.scannerOnly,
        `${call.where} holds a WEB session and requests ${call.name}, but ${route.name} is ` +
          `gated by requireScanner* (${route.where}). That guard demands a device-bound ` +
          `PIN session, so this call is refused for every user of this dashboard — the ` +
          `owner included, whatever permissions she holds. No permission grant fixes it. ` +
          `Point the call at a dashboard-surface endpoint; the server is the authority.`,
      ).toBe(false);
    });
  }
});

/**
 * The instance, named, so the regression has a case of its own.
 *
 * The sweep above would catch it anyway. This says which panel and which endpoint, so a
 * failure here reads as "the Overview feed moved back to the scanner" rather than as one
 * more row in a list.
 */
describe('the Overview activity panel', () => {
  const feed = CALLS.find((c) => c.where.startsWith('salon.ts') && c.name.includes('activity'));

  it('requests the endpoint that was built for it', () => {
    expect(
      feed,
      'useRecentActivity no longer requests an /activity path. GET /salons/{id}/activity is ' +
        'the Overview panel\'s endpoint — see its header in api/src/routes/activity.ts.',
    ).toBeDefined();
    expect(routeFor(feed!)?.name).toBe('GET /salons/:id/activity');
  });

  it('does not request the scanner\'s charge list', () => {
    const charges = CALLS.filter((c) => c.name === 'GET /charges');
    expect(
      charges,
      'GET /charges is requireScannerPerm(req, "charges") — the scanner\'s own screen, not ' +
        'a dashboard panel. api/src/routes/activity.ts § "WHAT WAS WRONG WITH READING THIS ' +
        'OFF GET /charges" is the argument.',
    ).toEqual([]);
  });
});
