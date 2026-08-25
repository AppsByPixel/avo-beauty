import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripComments } from '../testing/stripComments.js';

/**
 * The module toggles on Merchant → Settings, and the server-side fact they depend on.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The toggles spent an unknown number of weeks rendered `disabled` behind a notice
 * reading "the workspace has no endpoint for it", above a comment asserting the API
 * refused "`modules`, `moduleBooking` and `moduleShop` alike — verified against the
 * running API". One third of that was true. The two COLUMN spellings are refused, on
 * purpose and forever; `modules`, the WIRE shape the same screen already READ off the
 * salon, has been in `MERCHANT_EDITABLE` since e883330.
 *
 * That is the shape of the failure, and it is the shape a test can hold: a real refusal,
 * observed once, generalised into a claim about a field nobody re-tested, then frozen in
 * prose that made re-testing look unnecessary. Six other "not built" claims in this
 * dashboard have now turned out the same way (`api/settings.ts` counts them).
 *
 * So this file pins BOTH halves, because either one rotting reproduces the bug:
 *
 *   the server half  `modules` is merchant-editable, and the column spellings are not.
 *                    Derived from `api/src/routes/salons.ts`, not from a copy kept here —
 *                    a hand-kept list is the thing that rotted.
 *   the client half  the toggles are wired to it, the notice is gone, and the write uses
 *                    the wire spelling.
 *
 * A NOTE ON WHAT THIS CANNOT DO. It is a source scan. It cannot prove the endpoint
 * accepts the body — only driving it can, and it was driven before this was written:
 * `PATCH /salons/SAL-AMARA {"modules":{"booking":true,"shop":false}}` → 200 on a lane-C
 * API, `module_booking=t module_shop=f` asserted in SQL, the column spellings → 400
 * `not_editable`, and the same call as a staff member without `perms.loyalty` → 403 with
 * the columns unmoved. The transcript is in `api/settings.ts`. What a scan CAN do is
 * notice the day lane A takes the field back out, which is when this screen would start
 * lying again.
 *
 * COMMENTS ARE BLANKED BEFORE EVERY SEARCH. Not a precaution — a requirement. The two
 * files under test now carry corrected history that quotes the deleted notice and names
 * the refused column spellings verbatim, so every assertion below would find its own
 * subject in prose and pass while the code said the opposite.
 */

/** `apps/dashboard/src/routes` → repo root. */
const REPO = join(__dirname, '..', '..', '..', '..');

const read = (rel: string) => stripComments(readFileSync(join(REPO, rel), 'utf8'));

const SALONS_ROUTE = 'api/src/routes/salons.ts';

/**
 * The body of `const MERCHANT_EDITABLE = new Set([ … ])`, as string literals.
 *
 * Sliced to the Set rather than searched across the file, because `salons.ts` also
 * declares `PLATFORM_ONLY_EDITABLE` and `PLATFORM_EDITABLE`, and "is `city` editable"
 * has a different answer in each. A file-wide grep would answer for whichever set it
 * happened to land in.
 */
function merchantEditable(): string[] {
  const src = read(SALONS_ROUTE);
  const open = src.indexOf('const MERCHANT_EDITABLE = new Set([');
  expect(open, `MERCHANT_EDITABLE not found in ${SALONS_ROUTE}`).toBeGreaterThan(-1);
  const close = src.indexOf('])', open);
  expect(close).toBeGreaterThan(open);
  // `m[1]` is `string | undefined` under `noUncheckedIndexedAccess`; the group is not
  // optional, so this narrows rather than tolerating a hole.
  return [...src.slice(open, close).matchAll(/'([^']+)'/g)].flatMap((m) => m[1] ?? []);
}

describe('the server half — what PATCH /salons/{id} lets a merchant edit', () => {
  it('accepts `modules`, the wire shape this screen reads', () => {
    expect(merchantEditable()).toContain('modules');
  });

  /**
   * The other half of the same fact, and the half that was RIGHT all along.
   *
   * Asserted so the fix does not read as "the API was wrong and now it is not". It was
   * never wrong about these two: `MERCHANT_EDITABLE`'s own comment refuses them because
   * `modules` is a wire shape and `applyModules` splits it into the columns — "two doors
   * into one field is how the tier ladder acquired an unvalidated second entrance". If
   * they ever appear here, this dashboard has a second spelling to keep in step and the
   * failure should land on someone who can say no.
   */
  it('still refuses the two column spellings', () => {
    const editable = merchantEditable();
    expect(editable).not.toContain('moduleBooking');
    expect(editable).not.toContain('moduleShop');
  });

  /**
   * `applyModules` is what makes a one-key write safe, and the toggles below depend on
   * it: each switch sends only its own key, so flipping Booking from a render made
   * before someone else changed Shop cannot take Shop with it. A version that wrote
   * both columns unconditionally would turn every flip into a two-field write.
   *
   * THIS WAS QUERIED AS AN OVERWRITE HAZARD AND IT IS THE OPPOSITE. The concern raised
   * was that `PATCH /salons/{id}` takes the WHOLE `modules` object, so a one-key write
   * would clobber the other — and that the client should therefore read-modify-write
   * both keys from the current salon. It does not, and doing that would REINTRODUCE the
   * very clobber it was meant to avoid: sending both keys from a render made before
   * someone else flipped Shop is exactly how a stale render turns the other switch off.
   * Driven against a running lane-C API, asserted in SQL rather than in the reply:
   *
   *   start                                   booking=true  shop=true
   *   PATCH {"modules":{"booking":false}} 200  booking=false shop=true    ← shop untouched
   *   PATCH {"modules":{"shop":false}}    200  booking=false shop=false
   *   PATCH {"modules":{...both true}}    200  booking=true  shop=true
   *   PATCH {"moduleBooking":false}       400  not_editable, columns unmoved
   *
   * So one switch sends one key, and this test is what keeps that safe.
   */
  it('splits `modules` per key present, not as a pair', () => {
    const src = read(SALONS_ROUTE);
    const open = src.indexOf('function applyModules(');
    expect(open, `applyModules not found in ${SALONS_ROUTE}`).toBeGreaterThan(-1);
    // To the function's closing brace at column 0 — a fixed character budget would
    // silently truncate the body and assert about half a function.
    const body = src.slice(open, src.indexOf('\n}', open));

    /*
     * ASSERTED ON THE ASSIGNMENTS, NOT ON A PHRASE. `toContain('if (key in incoming)')`
     * passes on a reformat that keeps the words and loses the guard. What must be true
     * is narrower: each column is written exactly once, and every write is inside a
     * presence check. So the columns are counted, and the guard is required to sit
     * between the loop and the first of them.
     */
    for (const column of ['moduleBooking', 'moduleShop']) {
      const writes = [...body.matchAll(new RegExp(`patch\\[['"]?${column}`, 'g'))];
      // Written via `patch[column]` through the pair table rather than by name — so the
      // literal appears once, in that table, and never as a direct unconditional write.
      expect(
        writes.length,
        `${column} is assigned directly in applyModules. Every module write must go ` +
          `through the guarded pair loop, or a one-key PATCH starts clobbering the other.`,
      ).toBe(0);
    }
    expect(body).toMatch(/\bif\s*\(\s*key in incoming\s*\)/);
    expect(body).toContain('patch[column]');
  });
});

describe('the client half — the toggles', () => {
  const settingsScreen = () => read('apps/dashboard/src/routes/Settings.tsx');
  const settingsApi = () => read('apps/dashboard/src/api/settings.ts');

  it('sends the wire spelling, one key per switch', () => {
    const src = settingsScreen();
    expect(src).toContain('update.mutate({ modules: { booking: next } })');
    expect(src).toContain('update.mutate({ modules: { shop: next } })');
  });

  /**
   * The column spellings must not appear in the CODE of either file. They may appear in
   * the comments — they are named there as the thing the API refuses and as the likely
   * subject of the original mis-verification — which is the whole reason this reads a
   * blanked source.
   */
  it('never reaches for a column spelling', () => {
    for (const src of [settingsScreen(), settingsApi()]) {
      expect(src).not.toContain('moduleBooking');
      expect(src).not.toContain('moduleShop');
    }
  });

  it('has no notice left telling the merchant to ask AVO', () => {
    const src = settingsScreen();
    expect(src).not.toContain('settings__notice');
    expect(src).not.toContain('Ask AVO to enable a module');
  });

  /**
   * The `disabled` that remains is `disabled={busy}` — the in-flight guard every other
   * write control on this screen has. A bare `disabled` is the dead one, and it is what
   * a future edit would most plausibly reintroduce by copying a neighbouring read-only
   * row. Asserted on the `Toggle` line rather than on the file, so the deposit stepper's
   * own `disabled={update.isPending}` is not caught by it.
   */
  it('disables the switch only while a write is in flight', () => {
    const toggle = settingsScreen()
      .split('\n')
      .find((l) => l.includes('label={`${name} module`}'));
    expect(toggle, 'the module Toggle line moved or was renamed').toBeDefined();
    expect(toggle).toContain('disabled={busy}');
  });

  it('declares `modules` on SalonPatch, partially', () => {
    expect(settingsApi()).toContain("modules?: Partial<Salon['modules']>");
  });
});

/**
 * NOT ASSERTED HERE, AND NAMED SO THE ABSENCE IS A DECISION.
 *
 * That the write is gated on `perms.loyalty`. It is — `PATCH /salons/{id}` is one route
 * with one `requireDashboardPerm(req, 'loyalty')` guard, so the module toggles are gated
 * by the same call that gates the deposit, and the courtesy check at the top of
 * `Settings` covers them with nothing added. There is therefore no NEW gate for a test
 * to pin: an assertion here would restate `sectionState.tsx`'s ledger and drift from it.
 * Non-negotiable #7's requirement — a test that calls the endpoint directly with the
 * permission off — belongs to the API's own suite and to `e2e/`, which is lane D's
 * column. Driven by hand for this change (403, columns unchanged); reported, not
 * smuggled into this file.
 */
