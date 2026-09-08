// @vitest-environment jsdom

/**
 * The sidebar's authority line.
 *
 * =========================================================================
 * WHAT WAS WRONG
 * =========================================================================
 * `MerchantShell.tsx` passed `userRole="Owner"` to both `<Sidebar>` mounts — the
 * rail and the tablet drawer — as a string literal. Every merchant was labelled
 * "Owner". Driven against a real API, the seeded manager (`noura`, ST-001) read
 * "Owner" and so did the seeded front desk (`hessa`, ST-002, `perm_team` and
 * `perm_dashboard` both false).
 *
 * The label was not merely wrong, it CONTRADICTED THE SCREEN AROUND IT: hessa
 * sees "Owner" under her name while four of the five Reports cards refuse her
 * for lacking the permissions an owner would hold. The refusals were the honest
 * half, and they are server-side (#7); the label was chrome that had never been
 * wired to anything.
 *
 * The cause was upstream of the shell. `MerchantSession` had no `role` field at
 * all — only `scope`, `staffId`, `salonId`, `perms` — so there was nothing for
 * the shell to render and a literal was standing in. `POST /auth/web/session`
 * returns the staff row through `serialiseStaff`, `role` included, and
 * `signIn` was dropping it on the floor.
 *
 * =========================================================================
 * SO THIS FILE ASSERTS THREE THINGS, IN THE ORDER THEY CAN BREAK
 * =========================================================================
 *   1. the shell derives the label and does not carry an authority literal
 *      (source scan — the regression is a string coming back, which no
 *      rendering test would notice if it came back correct for the fixture)
 *   2. the mapping is right for all five roles, for the unknown word, and for
 *      the null
 *   3. an existing signed-in session, minted before the field existed, is NOT
 *      signed out by the validator that now knows about it
 *
 * (3) is the one that would be discovered by users rather than by a test. It is
 * a deploy-day mass sign-out, silent — `readSession` drops and `removeItem`s
 * anything failing validation, and the shell reads "no session" and redirects,
 * with nothing anywhere saying why.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { StaffPerms } from '@avo/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SCOPES } from '../auth/scopes.js';
import {
  isMerchantSession,
  readSession,
  writeSession,
  type MerchantSession,
} from '../auth/session.js';
import { stripComments } from '../testing/stripComments.js';
import { authorityLabel } from './MerchantShell.js';

const read = (rel: string) => stripComments(readFileSync(join(__dirname, rel), 'utf8'));

/*
 * A REAL `Storage`, BECAUSE THIS jsdom DOES NOT SHIP ONE.
 *
 * `window.localStorage` here is an EMPTY OBJECT — no `getItem`, no `clear`. The
 * second copy of this shim in the repo, and duplicated for the reason
 * `routes/consoleSignInRedirect.test.tsx` gives at length where the first copy
 * lives: a vitest jsdom file owns its own `window`, so installing Storage
 * restores the browser's behaviour inside this worker rather than stubbing a
 * shared global. `auth/session.ts` calls `store.getItem` unguarded, correctly —
 * a browser always has Storage, and paying for a test environment's gap in
 * shipped code would be the wrong trade.
 *
 * It wants a home in `src/testing/` next to `stripComments.ts`, which is where
 * the third copy should stop being written. Left here rather than moved because
 * moving it edits a test file this change has no other business in.
 */
function installStorage(name: 'localStorage' | 'sessionStorage') {
  const existing = window[name] as unknown;
  if (existing && typeof (existing as Storage).setItem === 'function') return;
  const map = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key) => map.get(key) ?? null,
    key: (index) => [...map.keys()][index] ?? null,
    removeItem: (key) => void map.delete(key),
    setItem: (key, value) => void map.set(key, String(value)),
  };
  Object.defineProperty(window, name, { value: storage, configurable: true, writable: true });
}

installStorage('localStorage');
installStorage('sessionStorage');

const MERCHANT_KEY = SCOPES.merchant.storageKey;

const PERMS: StaffPerms = {
  dashboard: true,
  appointments: true,
  shop: true,
  loyalty: true,
  team: true,
  scanner: true,
  charges: true,
  void: true,
  marketing: true,
};

/** Thirty days out, like a real refresh expiry — an expired one is dropped. */
const FUTURE = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();

const session = (over: Partial<MerchantSession> = {}): MerchantSession => ({
  scope: 'merchant',
  accessToken: 'at',
  refreshToken: 'rt',
  refreshExpiresAt: FUTURE,
  username: 'hessa',
  displayName: 'Hessa',
  staffId: 'ST-002',
  salonId: 'SAL-AMARA',
  role: 'frontdesk',
  perms: PERMS,
  ...over,
});

/** Writes the shape a PREVIOUS build stored: no `role` key at all. */
function storeLegacySession(extra: Record<string, unknown> = {}): void {
  const { role: _role, ...withoutRole } = session();
  window.localStorage.setItem(
    MERCHANT_KEY,
    JSON.stringify({ ...withoutRole, persistent: true, ...extra }),
  );
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});
afterEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});

/* ------------------------------------------------- the literal is gone -- */

describe('the shell does not label a merchant with a literal', () => {
  /**
   * THE ASSERTION THIS FILE WAS WRITTEN FOR.
   *
   * Comments are blanked first, and here that is load-bearing rather than
   * tidy — `MerchantShell.tsx` now carries a paragraph QUOTING the deleted
   * `userRole="Owner"` so the next reader knows what the derivation replaced,
   * and this file quotes it repeatedly too. A scan that did not blank comments
   * would find the corrected history and report it as the uncorrected code.
   */
  it('MerchantShell passes no string literal to userRole', () => {
    const src = read('MerchantShell.tsx');
    expect(src).not.toMatch(/userRole\s*=\s*"/);
    expect(src).not.toMatch(/userRole\s*=\s*\{\s*'/);
  });

  /**
   * BOTH MOUNTS. The rail and the tablet drawer are separate `<Sidebar>`s with
   * separate prop lists, which is how one of them held the literal for as long
   * as it did: fixing the one you are looking at leaves the other wrong on a
   * breakpoint nobody is testing at.
   */
  it('both sidebar mounts are fed the derived label', () => {
    const src = read('MerchantShell.tsx');
    const fed = src.match(/userRole=\{userRole\}/g) ?? [];
    expect(fed).toHaveLength(2);
    expect(src.match(/<Sidebar\b/g) ?? []).toHaveLength(2);
  });

  /**
   * The prop's type is the guard against the next person needing a string here.
   * `userRole: string` is what made a literal a legal thing to pass and made
   * "unknown" unrepresentable, which is why a literal was the only option.
   */
  it('Sidebar accepts an unknown authority rather than demanding a word', () => {
    expect(read('Sidebar.tsx')).toContain('userRole: string | null');
  });
});

/* ------------------------------------------------------------ the mapping -- */

describe('the authority line says what the staff row says', () => {
  /**
   * The five of `staffRole` in api/src/db/schema/staff.ts, with the labels the
   * design's Team chips use. `artist` is "Stylist" — the design's word for the
   * role the enum spells `artist`; see `ROLE_LABEL` in api/staff.ts for why the
   * wire value and the label differ on exactly that one.
   */
  it.each([
    ['owner', 'Owner'],
    ['manager', 'Manager'],
    ['frontdesk', 'Front desk'],
    ['artist', 'Stylist'],
    ['scanner', 'Scanner only'],
  ] as const)('%s renders as %s', (role, label) => {
    expect(authorityLabel(role)).toBe(label);
  });

  /** The defect, stated as the case that used to fail. */
  it('a front-desk account is not labelled Owner', () => {
    expect(authorityLabel('frontdesk')).not.toBe('Owner');
    expect(authorityLabel('manager')).not.toBe('Owner');
  });

  /**
   * NOTHING, not a placeholder and not a guess. A default would be the literal
   * back again — `?? 'Owner'` reproduces the bug exactly, and `?? 'Front desk'`
   * is the same lie aimed the other way.
   */
  it('an unknown role draws nothing at all', () => {
    expect(authorityLabel(null)).toBeNull();
  });

  /**
   * The console's map is NOT interchangeable with this one. They share `owner`
   * and nothing else, so a mix-up type-checks on one value and renders
   * `undefined` for the rest — which is how ConsoleShell came to print a raw
   * lowercase enum value before it was corrected.
   */
  it('the merchant vocabulary is not the platform vocabulary', () => {
    for (const platformOnly of ['admin', 'analyst', 'support']) {
      // Not in `staff_role`; if this ever starts returning a label, the two maps
      // have been merged and the merchant rail can print an AVO staff title.
      expect(authorityLabel(platformOnly as never)).toBe(platformOnly);
    }
  });
});

/* ------------------------------------------- the field does not sign anyone out -- */

describe('a session minted before `role` existed keeps working', () => {
  /**
   * THE DEPLOY-DAY CASE. Every merchant with "Keep me signed in" on is holding
   * one of these, with up to thirty days left on its refresh token.
   */
  it('is not dropped by the validator', () => {
    storeLegacySession();
    const restored = readSession('merchant');
    expect(restored).not.toBeNull();
    // Still in storage. `readSession` removes what it rejects, so an emptied key
    // is the mass sign-out this test exists to catch.
    expect(window.localStorage.getItem(MERCHANT_KEY)).not.toBeNull();
  });

  it('reads back as an explicit null role, never undefined', () => {
    storeLegacySession();
    const restored = readSession('merchant');
    if (!restored || !isMerchantSession(restored)) throw new Error('no merchant session');
    // `null` and not `undefined`: the type promises `StaffRole | null`, and a
    // reader distinguishing "unknown" from "absent field" is a reader that has
    // to handle two spellings of the same state.
    expect(restored.role).toBeNull();
    expect('role' in restored).toBe(true);
    expect(authorityLabel(restored.role)).toBeNull();
  });

  it('keeps everything else about the session intact', () => {
    storeLegacySession();
    const restored = readSession('merchant');
    if (!restored || !isMerchantSession(restored)) throw new Error('no merchant session');
    expect(restored.salonId).toBe('SAL-AMARA');
    expect(restored.staffId).toBe('ST-002');
    expect(restored.accessToken).toBe('at');
    expect(restored.perms.charges).toBe(true);
  });

  /**
   * A role that is not one of the five is not a role. This runs over
   * `localStorage`, which the person reading the sidebar can edit; without this
   * the label is whatever she types. It changes no authority — `perms` is
   * checked server-side — but a forgeable label is still a label nobody can
   * trust, and the vocabulary is closed.
   */
  it('a role outside the enum is nulled, not printed', () => {
    storeLegacySession({ role: 'Regional Director' });
    const restored = readSession('merchant');
    if (!restored || !isMerchantSession(restored)) throw new Error('no merchant session');
    expect(restored.role).toBeNull();
  });

  it('a real role survives the round trip', () => {
    writeSession(session({ role: 'manager' }), true);
    const restored = readSession('merchant');
    if (!restored || !isMerchantSession(restored)) throw new Error('no merchant session');
    expect(restored.role).toBe('manager');
    expect(authorityLabel(restored.role)).toBe('Manager');
  });

  /**
   * The tolerance is for `role` ALONE. `salonId` was and stays the rule that a
   * merchant session cannot exist without one — a session with no salon renders
   * a shell that 404s one route later, which is not a missing line of chrome.
   */
  it('still refuses a merchant session with no salon', () => {
    storeLegacySession({ salonId: '' });
    expect(readSession('merchant')).toBeNull();
  });
});

/* --------------------------------------------------------- sign-in persists it -- */

describe('sign-in records the role the server sent', () => {
  /**
   * A source scan and not a `signIn` call, deliberately: the value's journey is
   * `serialiseStaff` → `StaffUserSchema` → this line, and the only link this
   * lane owns is the last one. `e2e/` owns the round trip.
   *
   * `staff.role` and NOT `credentials.role` — there is no such thing, which is
   * the point. Authority comes off the parsed response, the way `salonId` does.
   */
  it('reads role off the parsed staff row', () => {
    const src = read('../auth/api.ts');
    expect(src).toMatch(/role:\s*staff\.role/);
    // No default. A `??` here would put a guessed authority on the session and
    // make the nullable half of the field unreachable for the case it is for.
    expect(src).not.toMatch(/role:\s*staff\.role\s*\?\?/);
  });
});
