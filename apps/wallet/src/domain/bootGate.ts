/**
 * Where a cold launch lands: the wallet, or sign-in.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * `refreshSession()` RETURNS A BOOLEAN, AND FALSE MEANS TWO DIFFERENT THINGS.
 *
 * `Gate` used to read it as one:
 *
 *     const ok = await refreshSession();
 *     setState(ok ? 'in' : 'signIn');
 *
 * That is correct when the server refused the session and wrong when we simply
 * could not ask it. Both were `false`, so a launch with no connection showed the
 * sign-in screen — and `useWalletHome`'s entire offline path, which seeds from
 * the cached snapshot and stamps it "last updated", was unreachable on a cold
 * start because Home never mounted. The states were built, tested and dead.
 *
 * `client.ts § sessionWasRepudiated` fixed the other half: only a 401 or 403 —
 * the server answering about this credential — clears the session. So the two
 * cases are now distinguishable HERE by whether a session is still held after
 * the attempt, and this is the one bit of that decision.
 *
 * Going in without a proven access token is safe and is the point: every request
 * then fails the way the network is actually failing. Offline, the first read
 * rejects at the transport and `useWalletHome` renders the cached wallet with
 * its stamp — which is precisely the screen `interaction-spec.md` §4 asks for.
 *
 * A pure function rather than a ternary in `App.tsx` for the reason
 * `domain/names.ts` sets out at length: this workspace has no renderer, so a
 * branch left inside a component is a branch no test can reach — and this branch
 * decides whether a customer can see her money.
 * ═════════════════════════════════════════════════════════════════════════════
 */

export type BootDestination = 'in' | 'signIn';

export interface BootInput {
  /** `restore()` found a usable stored session. */
  hasStoredSession: boolean;
  /** `refreshSession()` resolved true — the server issued a new pair. */
  refreshed: boolean;
  /**
   * A refresh token is STILL held after the attempt.
   *
   * False only when something cleared it, and after the change above the only
   * thing that clears it is the server refusing it. So this is the difference
   * between "your session ended" and "we could not check right now".
   */
  stillSignedIn: boolean;
}

export function bootDestination({
  hasStoredSession,
  refreshed,
  stillSignedIn,
}: BootInput): BootDestination {
  // Nothing stored: a first-ever launch or one after a real sign-out. There is
  // no wallet to show and no credential to show it with.
  if (!hasStoredSession) return 'signIn';
  if (refreshed) return 'in';
  // Unproven failure. The session survived it, so it is still hers.
  return stillSignedIn ? 'in' : 'signIn';
}
