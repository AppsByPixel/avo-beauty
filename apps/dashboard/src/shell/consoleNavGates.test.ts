/**
 * THE SIDEBAR'S COURTESY MUST NAME THE GATE THE SERVER ACTUALLY ENFORCES.
 *
 * Non-negotiable #7 says the UI hiding a button is a courtesy, not a control. It does
 * not say the courtesy may be WRONG. A courtesy that disagrees with the enforcement is
 * worse than none, and it fails in both directions at once:
 *
 *   too generous   the item is shown to an admin the server will refuse. The link 403s.
 *                  A console that offers a section and then refuses it teaches its
 *                  operator that the product is broken.
 *   too stingy     the item is hidden from an admin the server would ALLOW. Authority
 *                  the platform owner deliberately granted, never offered. Nobody files
 *                  a bug for a door they were never shown, so this half can run for
 *                  months in silence — and did.
 *
 * WHAT WENT WRONG, and why a comment was not enough. `consoleNavItems.tsx` carried a
 * twenty-line comment explaining, correctly and with a line reference, that
 * `GET /v1/platform/salons` was gated `analytics`. Commit 4cc03c5 regated it to
 * `salons`. The comment even NAMED the trigger to revisit itself — "when the per-salon
 * editor and the onboarding wizard land they will be gated on `salons`" — and that
 * commit is the one that landed the editor. The decision was written down, the trigger
 * fired, and nothing reread the note. Both directions went live against the shipped
 * presets in `api/src/db/schema/platformAdmin.ts`:
 *
 *   analyst   analytics:true  salons:false  → sidebar SHOWED Salons, server said 403
 *   support   analytics:false salons:true   → sidebar HID Salons, server would allow
 *
 * A prose comment cannot fail. This can.
 *
 * =========================================================================
 * THE GATES ARE DERIVED, WHICH IS THE ONLY PROPERTY THAT MATTERS HERE
 * =========================================================================
 * There is no table of expected sections in this file. `gatesFromRoutes()` reads
 * `api/src/routes/*.ts` and extracts, for every registered route, the argument of the
 * `requirePlatform` call that guards it. A nav item declares only its ENDPOINT — a fact
 * its own screen owns and this lane can verify — and the section is checked against
 * whatever the server currently says.
 *
 * So a hand-kept list cannot rot here, because there is no hand-kept list. The next
 * commit that moves a gate fails this test BY ITEM NAME on the same run, whichever lane
 * moves it. That is the property `e2e/permission-census.test.ts` established for the
 * endpoints themselves; this is the same method pointed at the sidebar.
 *
 * ASSERTING ON THE THING, NOT THE STRING. Comments are stripped before parsing —
 * `stripComments` blanks them in place, preserving line numbers so a failure can cite
 * one. Without that, `requirePlatform` mentioned in prose outnumbers the real calls in
 * this API roughly two to one, and every count and every lookup would be wrong in a
 * direction that reads as passing.
 *
 * A ZERO RESULT IS A CLAIM ABOUT THE PARSER, so the parser is proved against known
 * positives before anything is concluded from it — see § "the parser is load-bearing".
 * A regex that silently matched nothing would make every assertion below vacuously
 * true, which is the failure mode this whole file exists to prevent, reintroduced one
 * level down.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONSOLE_NAV_ITEMS } from './consoleNavItems.js';
import { PLATFORM_SECTIONS } from '../auth/platformAdmin.js';
/*
 * Lifted out of this file into `src/testing/` when `settingsModules.test.ts` needed the
 * same guarantee against the same hazard. See that module's header for why one copy.
 */
import { stripComments } from '../testing/stripComments.js';

/** `apps/dashboard/src/shell` → repo root → `api/src/routes`. */
const ROUTES_DIR = join(__dirname, '..', '..', '..', '..', 'api', 'src', 'routes');


/**
 * `app.get('/path'` and `app.get<{ Querystring: … }>(\n  '/path'`.
 *
 * THE OPTIONAL GENERIC IS THE WHOLE DIFFICULTY. Fastify routes here are frequently
 * registered with a type parameter, which pushes the path string onto the NEXT line —
 * `GET /v1/platform/salons` is written exactly that way. A regex anchored to
 * `app.get('` misses it and reports the endpoint as unregistered, i.e. reports the one
 * route this file was written about as absent. `[\s\S]*?` spans the newline; the lazy
 * quantifier stops it swallowing the file.
 */
const REGISTRATION = /\bapp\.(get|post|put|patch|delete)\s*(?:<[\s\S]*?>)?\s*\(\s*(['"])([^'"]+)\2/g;

/** `requirePlatform(req, 'salons')`. The section is the only capture that matters. */
const PLATFORM_GATE = /\brequirePlatform\s*\(\s*req\s*,\s*['"]([a-z]+)['"]\s*\)/;

export interface RouteGate {
  /** `GET /v1/platform/salons` — the key a nav item declares. */
  name: string;
  /** The `requirePlatform` section, or null where the route has no platform gate. */
  section: string | null;
  /** `platformConsole.ts:243`, for a failure message that can be acted on. */
  where: string;
}

/**
 * Every route in `api/src/routes/`, with the platform section guarding it.
 *
 * A handler's extent is taken as "this registration to the next one". That is coarse,
 * and it is deliberately coarse: the alternative is brace-matching a TypeScript file,
 * and the only thing being asked of the span is "which `requirePlatform` is the first
 * one inside it". The FIRST match is taken because non-negotiable #7's shape — and
 * `platformConsole.ts`'s own header — require the gate to be the handler's first
 * statement, so a later one in the same span would belong to a nested callback.
 */
function gatesFromRoutes(): Map<string, RouteGate> {
  const files = readdirSync(ROUTES_DIR)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .sort();

  const found = new Map<string, RouteGate>();
  for (const file of files) {
    const src = stripComments(readFileSync(join(ROUTES_DIR, file), 'utf8'));
    const hits = [...src.matchAll(REGISTRATION)];
    for (let k = 0; k < hits.length; k++) {
      const start = hits[k]!.index!;
      const end = k + 1 < hits.length ? hits[k + 1]!.index! : src.length;
      const gate = PLATFORM_GATE.exec(src.slice(start, end));
      const name = `${hits[k]![1]!.toUpperCase()} ${hits[k]![3]!}`;
      const line = src.slice(0, start).split('\n').length;
      // First registration wins; a duplicate path would be a server-side bug and is
      // surfaced by the census in e2e/, not silently overwritten here.
      if (!found.has(name)) {
        found.set(name, { name, section: gate ? gate[1]! : null, where: `${file}:${line}` });
      }
    }
  }
  return found;
}

const GATES = gatesFromRoutes();

// -------------------------------------------------------------- the parser --

/**
 * § THE PARSER IS LOAD-BEARING.
 *
 * Every assertion below is a lookup into `GATES`. If the parse came back empty or
 * shallow, those lookups would fail in a way that looks like "the endpoint is missing"
 * rather than "the parser is broken" — or worse, a `null` section would compare equal to
 * a `null` section and pass. These cases pin the parser against routes whose gates were
 * read by hand from the source, including the two-line registration shape that a naive
 * regex drops.
 */
describe('the route parser', () => {
  it('finds a substantial number of routes, not a handful', () => {
    // 122 at the time of writing. The floor is a smoke alarm for a regex that stopped
    // matching, not a count to maintain — it is deliberately far below the real number.
    expect(GATES.size).toBeGreaterThan(80);
  });

  it('reads a gate off a single-line registration', () => {
    // app.get('/v1/platform/metrics', …) — path on the same line as the method.
    expect(GATES.get('GET /v1/platform/metrics')?.section).toBe('analytics');
  });

  it('reads a gate off a registration whose path is on the next line', () => {
    // app.get<{ Querystring: … }>(\n  '/v1/platform/salons', …). The shape that hides
    // from an anchored regex — and the exact route this file was written about.
    expect(GATES.get('GET /v1/platform/salons')?.section).toBe('salons');
  });

  it('distinguishes a route with no platform gate from one it failed to parse', () => {
    // The published policy set is read by the wallet with no session at all. A parser
    // that returned null for everything would pass the gated cases only by luck, so an
    // ungated route is pinned as ungated.
    expect(GATES.has('GET /v1/platform/policies')).toBe(true);
    expect(GATES.get('GET /v1/platform/policies')?.section).toBeNull();
  });

  it('ignores requirePlatform written in a comment', () => {
    // `platformConsole.ts` discusses requirePlatform in prose above the handlers, and
    // `accounts.ts` names a section inside a comment two lines above the real call.
    // Both would corrupt the map if comments were not blanked.
    const raw = 'app.get(\'/x\', async () => {\n  /* requirePlatform(req, \'admins\') */\n});';
    const stripped = stripComments(raw);
    expect(stripped).not.toContain('admins');
    expect(stripped.split('\n')).toHaveLength(raw.split('\n').length);
  });
});

// ------------------------------------------------------------ the sidebar --

describe('every console nav item names the section its endpoint is gated on', () => {
  it('covers every item, so a new one cannot skip the check', () => {
    // Guards the loop below: `it.each` over an empty array is a silent pass.
    expect(CONSOLE_NAV_ITEMS.length).toBeGreaterThan(0);
  });

  for (const item of CONSOLE_NAV_ITEMS) {
    describe(`${item.id} (${item.label})`, () => {
      if (item.endpoint === null) {
        it('has no section, because it has no endpoint on the server', () => {
          // NULL IS "UNBUILT", NOT "UNGATED". ConsoleShell shows a null-section item to
          // everyone, so a real-but-unnamed route here would ship an unfiltered item.
          expect(item.section).toBeNull();
        });
        return;
      }

      it('declares an endpoint that is actually registered in api/src/routes', () => {
        const gate = GATES.get(item.endpoint!);
        expect(
          gate,
          `${item.id} declares "${item.endpoint}" but no such route is registered. ` +
            `Either the path moved or the item is pointing at a screen that cannot load.`,
        ).toBeDefined();
      });

      it('names the section the server enforces for it', () => {
        const gate = GATES.get(item.endpoint!);
        if (!gate) return; // reported by the case above; not re-reported here.
        expect(
          item.section,
          `${item.id}: the sidebar filters on "${item.section}" but ${item.endpoint} is ` +
            `gated "${gate.section}" (${gate.where}). An admin holding "${gate.section}" ` +
            `without "${item.section}" is refused a section they hold; one holding ` +
            `"${item.section}" without "${gate.section}" is offered a link that 403s. ` +
            `Fix the item's section — the server is the authority, not this file.`,
        ).toBe(gate.section);
      });

      it('names a section that exists', () => {
        // A typo'd section is `undefined` in `session.sections`, which is falsy, which
        // hides the item from EVERY admin including the owner. Silent and total.
        expect(PLATFORM_SECTIONS as readonly string[]).toContain(item.section);
      });
    });
  }
});
