import { consoleNavItemFor } from '../shell/consoleNavItems.js';
import { navItemFor } from '../shell/navItems.js';
import { SCOPES, type AuthScope } from './scopes.js';

/**
 * WHAT A SIGN-IN SCREEN IS TOLD ABOUT THE SESSION THAT ENDED.
 *
 * =========================================================================
 * THE DEFECT THIS FILE EXISTS FOR
 * =========================================================================
 * Both shells redirected with one line — `if (!session) navigate({ to: signIn })`
 * — and that line served three materially different events with one identical
 * outcome:
 *
 *   1. a deliberate "Sign out"        she did it; nothing to explain
 *   2. the session expired past refresh   she was not told, so the screen reads
 *                                         as the app having lost her work at
 *                                         random
 *   3. a sign-out in ANOTHER TAB      a different sentence again; MerchantShell's
 *                                     own comment already named this case as
 *                                     distinct and then handled it identically
 *
 * All three landed on a bare sign-in screen with no sentence and no way back to
 * the section she was on. The front desk mid-walk-in at `/appointments` came
 * back to `/overview`.
 *
 * So the redirect now carries two things — a CAUSE and a DESTINATION — and this
 * module owns both vocabularies so the merchant workspace and the owner console
 * cannot drift apart on either. Two sign-in screens telling the same story two
 * ways is the same defect one level up.
 *
 * NON-NEGOTIABLE #6 IS THE BINDING CONSTRAINT ON THE CAUSE. What crosses the URL
 * is a CATEGORY — one of the two words below — and never a diagnostic: not the
 * status code, not which call failed, and above all nothing derived from a token.
 * There is nothing in this module that could carry one.
 *
 * NON-NEGOTIABLE #7 IS THE BINDING CONSTRAINT ON WHAT IT MEANS. The cause is a
 * courtesy for the human reading the screen. Nothing reads it to decide access,
 * and nothing can: it reaches exactly one place, `InlineError`'s `message`.
 */

export const SESSION_END_REASONS = ['expired', 'elsewhere'] as const;

/**
 * The two causes worth a sentence.
 *
 * A DELIBERATE SIGN-OUT IS DELIBERATELY NOT A MEMBER. It is the absence of a
 * reason, not a third word, because a sign-out that announces itself is noise —
 * she pressed the button one screen ago. Modelling it as a value would make
 * "render nothing" a case every reader has to remember rather than the default
 * they get for free.
 */
export type SessionEndReason = (typeof SESSION_END_REASONS)[number];

/**
 * The sentence, verbatim, and IDENTICAL ON BOTH SURFACES.
 *
 * There is no designed state for this — `AVO States.dc.html` has no expired
 * session and `AVO Login.dc.html` draws no notice — so this copy is new work
 * rather than transcription, and it is flagged as such in the lane report.
 *
 * Both merchant surfaces and the console are ENGLISH-ONLY; `AR_GAPS` is the
 * wallet's. There is no Arabic half of this map to be missing.
 *
 * ONE SENTENCE, IN TWO CLAUSES: what happened, then the one action. §4 of
 * interaction-spec.md distinguishes an explain-state from a retry-state, and an
 * expired session is an explain-state whose single action is signing in — which
 * is the screen it is rendered on. That is why there is no button in this copy
 * and no `onRetry` anywhere near it.
 */
export const SESSION_ENDED_COPY: Record<SessionEndReason, string> = {
  expired: 'Your session expired. Sign in again to pick up where you left off.',
  elsewhere: 'You were signed out in another tab. Sign in again to pick up where you left off.',
};

/** The search params the two sign-in routes accept. See `router.tsx`. */
export interface SignInSearch {
  /** Where she was when the session ended. UNTRUSTED — see `returnPathFor`. */
  from?: string;
  /** Why, as a category. Absent for a deliberate sign-out. */
  reason?: SessionEndReason;
}

export function isSessionEndReason(value: unknown): value is SessionEndReason {
  return typeof value === 'string' && (SESSION_END_REASONS as readonly string[]).includes(value);
}

/**
 * The cause to render, read out of a parsed query string.
 *
 * Takes `unknown` because that is what it is: a value that round-tripped through
 * a URL anyone can type. Anything that is not one of the two words is no cause
 * at all, which is the same outcome as a deliberate sign-out — silence.
 */
export function sessionEndReasonFrom(search: unknown): SessionEndReason | null {
  if (typeof search !== 'object' || search === null) return null;
  const value = (search as Record<string, unknown>)['reason'];
  return isSessionEndReason(value) ? value : null;
}

/**
 * =========================================================================
 * THE RETURN PATH, AND WHY IT CANNOT BE AN OPEN REDIRECT
 * =========================================================================
 * A value that round-tripped through a URL is untrusted, and an open redirect on
 * a sign-in screen is a real vulnerability: it is the shape that turns a
 * phishing link into one that starts on the merchant's own domain, collects the
 * credential, and lands her somewhere she did not choose.
 *
 * The defence here is NOT a blocklist of hostile spellings. `//evil.example`,
 * `https://evil.example`, `/\evil.example`, `%2f%2fevil.example` and whatever
 * the next normalisation quirk turns out to be are all things a filter has to
 * think of in advance, and the ones it does not think of are the ones that ship.
 *
 * Instead THE RETURN VALUE IS DRAWN FROM A CLOSED SET. The argument is used only
 * to LOOK UP a nav item, and what comes back is that item's own `to` — a string
 * literal from `shell/navItems.tsx` or `shell/consoleNavItems.tsx`, which are the
 * tables `router.tsx` derives its routes from. No caller-supplied character
 * survives the lookup. An input that matches nothing yields the scope's home.
 *
 * So the question "did we filter every hostile spelling" does not arise: this
 * function cannot return a string that is not already compiled into this app,
 * whatever it is handed. `signInReturnPath.test.ts` asserts exactly that
 * property against every hostile input in the brief and then some.
 *
 * THE LOOKUP IS SCOPE-CONFINED for free, and it matters. `navItemFor` matches on
 * `pathname === item.to || pathname.startsWith(item.to + '/')`, so a merchant
 * redirect handed `/console/audit` matches nothing — `/console/audit` does not
 * start with `/audit/` — and falls back to `/overview` rather than bouncing a
 * salon's front desk at the platform console's door.
 *
 * WHAT IT DOES NOT PRESERVE, stated rather than discovered later: the match
 * returns the SECTION, so a sub-path comes back as its section (the console's
 * `/console/salons/SAL-AMARA` returns `/console/salons`) and a query string
 * matches nothing at all (`/reports?period=…` returns `/overview`). Both are
 * deliberate — widening either one means letting caller-supplied characters into
 * the output, which is the property this whole function is.
 *
 * ONE GATE, AND IT IS THIS ONE. `validateSearch` in `router.tsx` deliberately
 * does NOT also filter `from`: a second gate is a second place for the rule to
 * drift, and — worse for the test — it lets a spec pass because of the gate it
 * is not exercising. The validation lives at the point of navigation, where it
 * cannot be bypassed by a caller that builds the search another way.
 */
export function returnPathFor(scope: AuthScope, from: unknown): string {
  const home = SCOPES[scope].home;
  if (typeof from !== 'string') return home;
  const item = scope === 'owner' ? consoleNavItemFor(from) : navItemFor(from);
  return item?.to ?? home;
}

/**
 * The search a shell hands its sign-in screen on the way out.
 *
 * `from` is omitted when the section she was on is the scope's home anyway —
 * there is nothing to restore, and a URL that says so is one more thing on
 * screen that means nothing to the person reading it.
 */
export function signInSearchFor(
  scope: AuthScope,
  pathname: string,
  reason: SessionEndReason | null,
): SignInSearch {
  const from = returnPathFor(scope, pathname);
  return {
    ...(from === SCOPES[scope].home ? {} : { from }),
    ...(reason === null ? {} : { reason }),
  };
}
