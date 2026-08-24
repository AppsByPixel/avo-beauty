/**
 * Where a cold launch lands.
 *
 * The session-clearing fix in `client.ts § sessionWasRepudiated` is only half of
 * the airport bug. With it alone, an offline launch keeps the refresh token —
 * and `Gate` still showed the sign-in screen, because it read a bare boolean:
 *
 *     const ok = await refreshSession();
 *     setState(ok ? 'in' : 'signIn');
 *
 * `false` conflated "the session is over" with "we could not check". So the
 * customer was no longer locked out, but she still could not SEE her wallet, and
 * `interaction-spec.md` §4's whole offline treatment for Home — the kept balance
 * and the "last updated" stamp — was still unreachable, which was the actual
 * damage.
 */

import { describe, expect, it } from 'vitest';
import { bootDestination } from './bootGate';

describe('a launch that could reach the server', () => {
  it('goes in when the refresh succeeded', () => {
    expect(
      bootDestination({ hasStoredSession: true, refreshed: true, stillSignedIn: true }),
    ).toBe('in');
  });

  it('goes to sign-in when the server repudiated the session', () => {
    // `clearSession()` ran, so nothing is held any more.
    expect(
      bootDestination({ hasStoredSession: true, refreshed: false, stillSignedIn: false }),
    ).toBe('signIn');
  });
});

describe('a launch that could NOT reach the server', () => {
  /**
   * THE FIX. The refresh did not succeed, but nothing repudiated the session, so
   * it is still held — and the right destination is the wallet, which already
   * knows how to render itself from cache with a "last updated" stamp when the
   * network is gone. Sending her to sign-in here asks her to type a password to
   * see a balance that is sitting in storage.
   */
  it('goes IN on an unproven failure, because the session survived it', () => {
    expect(
      bootDestination({ hasStoredSession: true, refreshed: false, stillSignedIn: true }),
    ).toBe('in');
  });
});

describe('a launch with nothing stored', () => {
  it('goes to sign-in and never in, whatever the refresh reported', () => {
    // A first-ever launch, or one after a real sign-out. There is no wallet to
    // show and no credential to show it with.
    for (const refreshed of [true, false]) {
      for (const stillSignedIn of [true, false]) {
        expect(
          bootDestination({ hasStoredSession: false, refreshed, stillSignedIn }),
        ).toBe('signIn');
      }
    }
  });
});

describe('the invariant, over every combination', () => {
  it('only ever goes in while a session is actually held', () => {
    for (const hasStoredSession of [true, false]) {
      for (const refreshed of [true, false]) {
        for (const stillSignedIn of [true, false]) {
          const where = bootDestination({ hasStoredSession, refreshed, stillSignedIn });
          if (where === 'in') {
            expect(hasStoredSession).toBe(true);
            // Either the refresh proved the session, or nothing disproved it.
            expect(refreshed || stillSignedIn).toBe(true);
          }
        }
      }
    }
  });
});
