/**
 * THE RETURN PATH AND THE CAUSE, AS FUNCTIONS.
 *
 * The rendered half of this fix is `shell/sessionExpiryCause.test.tsx`, which
 * mounts the real router and drives the three causes through the real session
 * store. This file is the other half, and the split is the one `MerchantShell`
 * already argues for `authorityLabel`: "the interesting behaviour is a mapping
 * with three cases, and a rendering test that has to mount a router to reach it
 * proves less about the mapping than a call does."
 *
 * Here the mapping is a SECURITY BOUNDARY, which sharpens the argument. An open
 * redirect on a sign-in screen is a real vulnerability, and the thing worth
 * proving about `returnPathFor` is not that `/appointments` survives it — it is
 * that NOTHING ELSE CAN COME OUT OF IT. That is a property over arbitrary input,
 * and a property is checked by calling the function a hundred times, not by
 * rendering it twice.
 */

import { describe, expect, it } from 'vitest';
import { SCOPES } from './scopes.js';
import {
  SESSION_END_REASONS,
  SESSION_ENDED_COPY,
  returnPathFor,
  sessionEndReasonFrom,
  signInSearchFor,
} from './signInSearch.js';
import { CONSOLE_NAV_ITEMS } from '../shell/consoleNavItems.js';
import { NAV_ITEMS } from '../shell/navItems.js';

/**
 * Every string `returnPathFor` is permitted to produce, for each scope, derived
 * from the same tables `router.tsx` derives its routes from.
 *
 * DERIVED, NOT LISTED. A hand-written copy of the ten merchant paths would go
 * stale the day a section is added and would then assert that the new one is
 * forbidden — the `consoleNavGates.test.ts` lesson, applied to a closed set
 * instead of to a permission.
 */
const ALLOWED = {
  merchant: new Set([SCOPES.merchant.home, ...NAV_ITEMS.map((item) => item.to)]),
  owner: new Set([SCOPES.owner.home, ...CONSOLE_NAV_ITEMS.map((item) => item.to)]),
} as const;

/**
 * The hostile inputs, and everything else that is not a section.
 *
 * The three the brief names are the first three. The rest are here because a
 * blocklist's failure mode is the spelling nobody thought of, and the whole
 * claim `returnPathFor` makes is that it is not a blocklist — so the honest test
 * is a wide sample of things a filter would have to have anticipated, asserted
 * against the closed set rather than one at a time.
 */
const HOSTILE: readonly unknown[] = [
  // An absolute URL to another origin.
  'https://evil.example/appointments',
  'http://evil.example',
  'https://evil.example',
  // Protocol-relative.
  '//evil.example',
  '//evil.example/appointments',
  '/\\evil.example',
  '\\\\evil.example',
  '/\\/evil.example',
  // Encoded, and double-encoded.
  '%2f%2fevil.example',
  '%2F%2Fevil.example',
  '/%2f%2fevil.example',
  '%252f%252fevil.example',
  // Schemes that are not navigation at all.
  'javascript:alert(1)',
  'data:text/html,<script>1</script>',
  'vbscript:msgbox(1)',
  // Credentials in the authority, which is how a host hides behind a path.
  'https://evil.example@avo.beauty/overview',
  '//user:pass@evil.example',
  // Traversal and normalisation. (A traversal that begins UNDER a real section
  // is not in this list — it resolves to that section, which is still a table
  // literal; see 'a traversal cannot climb out of the closed set' below.)
  '/./appointments/../..',
  '/..//evil.example',
  '/../../etc/passwd',
  // Paths this shell does not serve.
  '/billing',
  '/signin',
  '/nope',
  '/',
  '',
  // Query strings and fragments: the match is on the path, so these are not
  // sections. Stated in `returnPathFor`'s header as a deliberate cost.
  '/appointments?x=1',
  '/appointments#frag',
  // Whitespace and control characters around an otherwise valid section.
  ' /appointments',
  '/appointments ',
  '\n/appointments',
  '/ appointments',
  // Not strings at all.
  null,
  undefined,
  42,
  true,
  {},
  [],
  { toString: () => '/appointments' },
  ['/appointments'],
];

describe('returnPathFor cannot produce a destination this app did not compile', () => {
  /**
   * THE PROPERTY, AND IT IS THE WHOLE SECURITY CLAIM.
   *
   * Not "these hostile strings are rejected" — that is a statement about the
   * sample. This is a statement about the FUNCTION: whatever it is handed, what
   * comes back is a member of a set derived from this app's own nav tables. An
   * open redirect is not filtered here, it is unrepresentable.
   *
   * It runs over the hostile sample AND over every legitimate section, because a
   * closed-set claim that only ever sees hostile input would also be satisfied
   * by `return home` — which is the mutation the round-trip spec catches.
   */
  it.each(['merchant', 'owner'] as const)('%s: every output is in the closed set', (scope) => {
    const everything = [
      ...HOSTILE,
      ...NAV_ITEMS.map((item) => item.to),
      ...CONSOLE_NAV_ITEMS.map((item) => item.to),
      ...NAV_ITEMS.map((item) => `${item.to}/deeper`),
      ...CONSOLE_NAV_ITEMS.map((item) => `${item.to}/SAL-AMARA`),
    ];
    const produced = new Set(everything.map((value) => returnPathFor(scope, value)));
    for (const path of produced) expect(ALLOWED[scope]).toContain(path);
  });

  it.each(HOSTILE.map((value) => [String(value), value] as const))(
    'merchant: %s falls back to the default rather than navigating to it',
    (_label, value) => {
      expect(returnPathFor('merchant', value)).toBe(SCOPES.merchant.home);
    },
  );

  it.each(HOSTILE.map((value) => [String(value), value] as const))(
    'owner: %s falls back to the default rather than navigating to it',
    (_label, value) => {
      expect(returnPathFor('owner', value)).toBe(SCOPES.owner.home);
    },
  );

  /**
   * The guard's own premise. A `returnPathFor` that returned the default for
   * EVERYTHING would satisfy every assertion above and restore the defect this
   * lane was sent to fix — the merchant back on `/overview`, just more
   * defensibly. The sections have to survive.
   */
  it('carries every real merchant section back', () => {
    for (const item of NAV_ITEMS) {
      expect(returnPathFor('merchant', item.to)).toBe(item.to);
    }
    expect(returnPathFor('merchant', '/appointments')).toBe('/appointments');
  });

  it('carries every real console section back', () => {
    for (const item of CONSOLE_NAV_ITEMS) {
      expect(returnPathFor('owner', item.to)).toBe(item.to);
    }
  });

  /**
   * A sub-path resolves to its SECTION, which is how the console's per-salon
   * editor survives at all — `/console/salons/$id` is a real route and is not a
   * nav item. What comes back is still the table's own literal.
   */
  it('resolves a sub-path to its section, not to the sub-path', () => {
    expect(returnPathFor('owner', '/console/salons/SAL-AMARA')).toBe('/console/salons');
    expect(returnPathFor('merchant', '/appointments/BKG-1')).toBe('/appointments');
  });

  /**
   * A TRAVERSAL CANNOT CLIMB OUT OF THE CLOSED SET, AND THIS ASSERTION WAS
   * WRITTEN THE WRONG WAY ROUND FIRST.
   *
   * `/appointments/../../evil.example` was in the hostile list above expecting
   * `/overview`, and it failed: the lookup matches the `/appointments/` prefix
   * and returns `/appointments`. That is not an escape, it is the design doing
   * its job — what comes back is the TABLE'S literal and not one character of
   * the input, so there is nothing left of `evil.example` to navigate to. The
   * expectation was corrected rather than the function, because a function that
   * returned the default here would be inspecting the input's shape, which is
   * the blocklist this deliberately is not.
   *
   * Kept as its own case so the distinction is asserted rather than remembered:
   * a traversal under a real section lands on that section, a traversal that
   * matches nothing lands home, and neither can produce a foreign string.
   */
  it('a traversal cannot climb out of the closed set', () => {
    expect(returnPathFor('merchant', '/appointments/../../evil.example')).toBe('/appointments');
    expect(returnPathFor('merchant', '/appointments/..%2f..%2fevil.example')).toBe('/appointments');
    expect(returnPathFor('merchant', '/..//evil.example')).toBe(SCOPES.merchant.home);
  });

  /**
   * SCOPE CONFINEMENT. The merchant door cannot be talked into returning a
   * console path and the console door cannot be talked into returning a
   * merchant one — not by a filter, but because the lookup runs against one
   * table and the other table's paths are not in it.
   */
  it('refuses the other scope’s sections', () => {
    for (const item of CONSOLE_NAV_ITEMS) {
      expect(returnPathFor('merchant', item.to)).toBe(SCOPES.merchant.home);
    }
    for (const item of NAV_ITEMS) {
      expect(returnPathFor('owner', item.to)).toBe(SCOPES.owner.home);
    }
  });
});

describe('the cause is a category and nothing more', () => {
  it.each(SESSION_END_REASONS)('reads %s back out of a search object', (reason) => {
    expect(sessionEndReasonFrom({ reason })).toBe(reason);
  });

  /**
   * Anything that is not one of the two words is no cause. A forged `?reason=`
   * can therefore choose between the two sentences and nothing else — which is
   * the whole of its power, and is why #7 is not in play: there is no access
   * decision downstream of a sentence.
   */
  it.each([
    ['an unknown word', { reason: 'hacked' }],
    ['an empty string', { reason: '' }],
    ['a number', { reason: 1 }],
    ['an object', { reason: { reason: 'expired' } }],
    ['no reason key', { from: '/appointments' }],
    ['an empty search', {}],
    ['null', null],
    ['a string', 'reason=expired'],
    ['undefined', undefined],
  ])('%s is no cause at all', (_label, search) => {
    expect(sessionEndReasonFrom(search)).toBeNull();
  });

  /**
   * NON-NEGOTIABLE #6, ASSERTED ON THE COPY ITSELF. The sentence names a
   * category and never a diagnostic. `sessionExpiryCause.test.tsx` asserts the
   * same guarantee over the rendered DOM against a real token; this asserts it
   * over the words, where a well-meant "(401)" would be added.
   */
  it('says nothing about a status, a token or the call that failed', () => {
    for (const copy of Object.values(SESSION_ENDED_COPY)) {
      expect(copy).not.toMatch(/\d/);
      expect(copy.toLowerCase()).not.toMatch(/token|refresh|401|403|bearer|http|api|endpoint/);
      // One sentence about what happened, one about the single action.
      expect(copy).toMatch(/Sign in again to pick up where you left off\.$/);
    }
  });

  /** The two doors must not diverge: there is one map, so they cannot. */
  it('has one sentence per cause and no more', () => {
    expect(Object.keys(SESSION_ENDED_COPY).sort()).toEqual([...SESSION_END_REASONS].sort());
  });
});

describe('what a shell puts in the URL on its way out', () => {
  it('carries the section and the cause', () => {
    expect(signInSearchFor('merchant', '/appointments', 'expired')).toEqual({
      from: '/appointments',
      reason: 'expired',
    });
  });

  /** A deliberate sign-out has no cause, so the URL carries none. */
  it('omits the cause when there is nothing to explain', () => {
    expect(signInSearchFor('merchant', '/appointments', null)).toEqual({ from: '/appointments' });
  });

  /** Nothing to restore: she was already on the section she would land on. */
  it('omits the section when it is the scope’s home anyway', () => {
    expect(signInSearchFor('merchant', SCOPES.merchant.home, 'expired')).toEqual({
      reason: 'expired',
    });
    expect(signInSearchFor('owner', SCOPES.owner.home, null)).toEqual({});
  });

  /**
   * THE SHELL'S OWN PATHNAME IS NORMALISED TOO, and that is not belt-and-braces.
   * It is what keeps the closed-set property true of what goes INTO the URL as
   * well as what comes out of it, so there is no window in which a raw location
   * string is sitting in the address bar waiting to be copied somewhere.
   */
  it('writes a table literal, never the raw pathname', () => {
    expect(signInSearchFor('owner', '/console/salons/SAL-AMARA', 'elsewhere')).toEqual({
      from: '/console/salons',
      reason: 'elsewhere',
    });
    expect(signInSearchFor('merchant', '/appointments/BKG-1?x=1', 'expired')).toEqual({
      from: '/appointments',
      reason: 'expired',
    });
  });
});
