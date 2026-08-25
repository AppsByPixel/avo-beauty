import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONSOLE_NAV_ITEMS } from '../shell/consoleNavItems.js';
import { NAV_ITEMS } from '../shell/navItems.js';
import { AUTH_SCOPES, type AuthScope } from '../auth/scopes.js';
import { stripComments } from '../testing/stripComments.js';

/**
 * THE PLACEHOLDER'S REASSURANCE MUST NAME A SECTION THAT SURFACE ACTUALLY HAS.
 *
 * `NotBuiltYet` is shown behind every nav item that has not landed, and it ends on a
 * sentence pointing the reader at something that IS built — the "not everything here is
 * a stub" reassurance. One sentence used to serve both surfaces:
 *
 *   "This section is in a later phase of the build plan. Overview is live and reads
 *    from the API."
 *
 * The owner console has no Overview. Its ten sections are Analytics, Activity, Salons,
 * Accounts, Admins, Approvals, Policies, Billing, Audit log and Controls. So the
 * platform owner was directed to a section that is not in her sidebar, on every unbuilt
 * console section — `/console/activity`, `/console/accounts` and `/console/billing`,
 * three screens at once.
 *
 * IT IS COSMETIC AND IT IS STILL THE HOUSE DEFECT: the UI stating something about the
 * system that is not true. The same slice fixed the Overview feed calling an endpoint it
 * cannot reach and Settings claiming an endpoint that exists does not.
 *
 * WHAT THIS CHECKS, AND WHY IT IS NOT A SPELLING TEST. The sentence is not compared to a
 * copy kept here — a second copy of the string is a second thing to update, and it would
 * pass happily while naming a section that had since been deleted. Instead the LANDMARK
 * named in each sentence is looked up in that surface's own nav table, and must be a
 * section that exists AND is `built`. So deleting Analytics from the console, or flipping
 * it to `built: false`, fails here by name — which is the day the sentence starts lying.
 */

const NOT_BUILT_YET = join(__dirname, 'NotBuiltYet.tsx');

/**
 * The landmark sentence per scope, read out of `LANDMARK` in the component.
 *
 * READ FROM THE SOURCE, NOT IMPORTED, because the value under test is a string the
 * component renders and the question is what a reader SEES. Comments are blanked first:
 * the component's header quotes the deleted sentence verbatim, including the word
 * "Overview", so an unblanked scan would find the old copy and conclude the console is
 * still wrong — or, worse, find it and pass while checking prose.
 */
function landmarks(): Map<AuthScope, string> {
  const src = stripComments(readFileSync(NOT_BUILT_YET, 'utf8'));
  const open = src.indexOf('const LANDMARK');
  expect(open, 'LANDMARK not found in NotBuiltYet.tsx — the sentences moved').toBeGreaterThan(-1);
  const close = src.indexOf('};', open);
  expect(close).toBeGreaterThan(open);
  const body = src.slice(open, close);

  const found = new Map<AuthScope, string>();
  for (const m of body.matchAll(/(\w+):\s*'([^']+)'/g)) {
    if ((AUTH_SCOPES as readonly string[]).includes(m[1]!)) {
      found.set(m[1] as AuthScope, m[2]!);
    }
  }
  return found;
}

const LANDMARKS = landmarks();

/** Every section title a surface offers, with whether it is built. */
const SECTIONS: Record<AuthScope, ReadonlyArray<{ title: string; built: boolean }>> = {
  merchant: NAV_ITEMS,
  owner: CONSOLE_NAV_ITEMS,
};

describe('the parser', () => {
  /**
   * § A ZERO RESULT IS A CLAIM ABOUT THE PARSER. Every assertion below is a lookup into
   * `LANDMARKS`; an empty parse would make the loop vacuous and the file a no-op.
   */
  it('reads a sentence for every auth scope', () => {
    expect([...LANDMARKS.keys()].sort()).toEqual([...AUTH_SCOPES].sort());
  });

  it('ignores the deleted sentence quoted in the header', () => {
    // The component's own header reproduces "Overview is live and reads from the API."
    // as the thing it removed. Unblanked, that string is in the file twice and this
    // file's subject is which one the component RENDERS.
    const raw = readFileSync(NOT_BUILT_YET, 'utf8');
    expect(raw, 'the header no longer quotes the sentence it replaced').toContain(
      'Overview is live and reads from the API.',
    );
    expect(LANDMARKS.get('owner')).not.toContain('Overview');
  });
});

describe('every surface points at a section it actually has', () => {
  it('has scopes to check, so the loop is not vacuous', () => {
    expect(AUTH_SCOPES.length).toBeGreaterThan(1);
  });

  for (const scope of AUTH_SCOPES) {
    describe(scope, () => {
      it('names a section that is in this surface\'s sidebar', () => {
        const sentence = LANDMARKS.get(scope)!;
        const named = SECTIONS[scope].filter((s) => sentence.includes(s.title));
        expect(
          named.length,
          `the ${scope} placeholder says "${sentence}" but names no section in its own nav. ` +
            `That surface offers: ${SECTIONS[scope].map((s) => s.title).join(', ')}. ` +
            `A placeholder that reassures the reader with a section they do not have is ` +
            `worse than one that reassures them with nothing.`,
        ).toBeGreaterThan(0);
      });

      it('names a section that is actually built', () => {
        const sentence = LANDMARKS.get(scope)!;
        const named = SECTIONS[scope].filter((s) => sentence.includes(s.title));
        if (named.length === 0) return; // reported above; not re-reported here.
        for (const s of named) {
          expect(
            s.built,
            `the ${scope} placeholder says "${sentence}", but ${s.title} is built: false ` +
              `in its nav table — so it is a placeholder pointing at a placeholder.`,
          ).toBe(true);
        }
      });
    });
  }
});

/**
 * The instance, named, so the regression that prompted this has a case of its own.
 *
 * The loop above catches it. This says which surface and which word, so a failure reads
 * as "the console is being sent to the merchant's Overview again".
 */
describe('the owner console', () => {
  it('is not sent to an Overview it does not have', () => {
    expect(
      CONSOLE_NAV_ITEMS.some((s) => s.title === 'Overview'),
      'the console grew an Overview — if so, this whole file needs rereading, not deleting',
    ).toBe(false);
    expect(LANDMARKS.get('owner')).not.toContain('Overview');
  });
});
