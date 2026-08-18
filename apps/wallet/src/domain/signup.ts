/**
 * What the signup screen does with each answer `POST /auth/member/signup` can give.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * TEN REFUSALS, FOUR RECOVERIES, AND THE WHOLE POINT IS THAT THEY DIFFER
 *
 * The endpoint is unusually rich in refusals for a customer-facing POST, because
 * it is unauthenticated, rate limited, and gated on a document that can be
 * republished underneath the screen. Collapsing them into one "something went
 * wrong" would break three of them specifically:
 *
 *   already_registered      she has an account. The answer is Log in, not retry.
 *   policy_version_stale    NOTHING went wrong. The terms moved while she read
 *                           them, and the recovery is to show the new ones.
 *   signup_hourly_limit     she cannot wait this one out in a moment, and telling
 *                           her to "wait a moment" sends her back every minute.
 *
 * A pure function rather than a branch inside the screen, for the reason
 * `deletionOutcome.ts` gives at length: this workspace has no renderer, so
 * anything left inline in a component is unreachable by a test. Everything here
 * is covered by `signup.test.ts`, including the assertion that the mapping is
 * TOTAL over the codes the API can actually throw.
 *
 * WHY `reterms` RE-FETCHES INSTEAD OF READING `publishedVersion` OFF THE ERROR
 * --------------------------------------------------------------------------
 * The 409 carries `publishedVersion`, and submitting that number would make the
 * refusal disappear on the next tap. It would also be the exact defect
 * non-negotiable #10 and `design/README.md` gap 5 forbid — "do not rely on 'they
 * agreed to whatever is current'" — because she would have accepted a version
 * whose text was never on her screen. The version is only ever sent back after
 * the document it names has been fetched and rendered, which is why the recovery
 * is "fetch and re-show" and not "resubmit with the number they gave us".
 *
 * The consent tick is cleared with it. A box she ticked against v3 is not consent
 * to v4.
 * ═════════════════════════════════════════════════════════════════════════════
 */

import { ApiError } from '../api/client';
import type { Copy } from '../copy/types';

/**
 * The client's half of the password rule.
 *
 * `api-contract.md` § Profile edit rule 4: "enforces a minimum length of 6 (the
 * client says so; enforce it server-side too)" — so this is the "client says so"
 * half and `api/src/auth/password.ts` holds the authority. Checking it here saves
 * her a round trip and an argon2 hash against the rate limiter; the server's
 * `password_too_short` maps to the same sentence, so the two cannot disagree on
 * what she is told.
 */
export const MIN_PASSWORD_LENGTH = 6;

/**
 * What the screen should do next. Not a severity — a next action, which is the
 * only thing the difference between these refusals is about.
 */
export type SignupRecovery =
  /** Stay on the form. She can change something and submit again. */
  | 'retype'
  /**
   * Re-fetch the published set, re-render the documents, clear the consent tick.
   * The form keeps her name, phone and preference; only the acceptance resets.
   */
  | 'reterms'
  /** Send her to Log in. The form cannot succeed with this number. */
  | 'login'
  /**
   * No account can be created right now and nothing she types changes that —
   * an unpublished legal set, a misconfigured salon, or a ceiling she has to
   * wait out. The form is hidden rather than left inviting a submit that cannot
   * work.
   */
  | 'unavailable';

export interface SignupRefusal {
  /** The sentence to show inline, in the reading language. Never the server's. */
  message: string;
  recovery: SignupRecovery;
}

/**
 * Every code this screen renders, with the copy key and the recovery.
 *
 * BILINGUAL BY MAPPING, NOT BY PASSING THE SERVER'S MESSAGE THROUGH. Sign-in
 * shows `err.message` and that is defensible there — one refusal, and the server
 * authored a better sentence than a generic. It is not defensible here: the API
 * returns English for all ten, so an Arabic build would render an English
 * paragraph at the one moment a customer is being asked to agree to something.
 * So the code is the contract and the copy is ours, in both languages.
 *
 * The two entries that can only be a CLIENT bug are mapped deliberately rather
 * than left to the fallback. `wa_preference_required` means this app omitted the
 * WhatsApp preference, and `unknown_salon` means it was built pointing at a salon
 * the API does not have — neither is something she did, and neither should read
 * as though retyping her phone number would help.
 */
const REFUSALS: Record<string, { key: keyof Copy; recovery: SignupRecovery }> = {
  already_registered: { key: 'signUpErrRegistered', recovery: 'login' },
  policy_version_stale: { key: 'signUpErrTermsChanged', recovery: 'reterms' },
  policy_version_required: { key: 'signUpErrTermsReload', recovery: 'reterms' },
  invalid_phone: { key: 'signUpErrPhone', recovery: 'retype' },
  password_too_short: { key: 'signUpErrShort', recovery: 'retype' },
  unknown_salon: { key: 'signUpErrSalon', recovery: 'unavailable' },
  policies_not_published: { key: 'signUpErrTermsMissing', recovery: 'unavailable' },
  signup_rate_limited: { key: 'signUpErrBusy', recovery: 'retype' },
  /**
   * `unavailable`, unlike its five-minute sibling. An hour is not a "wait a
   * moment", and leaving the form live invites her to keep paying for refusals.
   */
  signup_hourly_limit: { key: 'signUpErrTooMany', recovery: 'unavailable' },
  wa_preference_required: { key: 'signUpErrFailed', recovery: 'retype' },
};

/** The codes above, for the test that asserts the mapping is total. */
export const HANDLED_SIGNUP_CODES: readonly string[] = Object.keys(REFUSALS);

/**
 * Classify a failed signup.
 *
 * THE CODE IS CHECKED BEFORE `kind`, AND THE ORDER IS A BUG FIX RATHER THAN A
 * PREFERENCE. This read `if (err.kind === 'offline')` first, which looks obviously
 * right and is wrong for one refusal: `client.ts`'s `classify()` maps **503** to
 * `offline`, and `policies_not_published` is a 503. So a deployment with no
 * published legal set told the customer "No connection. You need one to create an
 * account" — a sentence she can do nothing about, attached to a retry that can
 * never succeed, describing a network that was working.
 *
 * Checking the code first is strictly safer, not merely different: a genuinely
 * dead connection never reaches a server, so `sendOnce`'s transport branch
 * constructs its `ApiError` with **no code at all** and falls through to the
 * `offline` check below untouched. A code and `kind: 'offline'` together always
 * means "the server answered 503", and the server's own word for what happened
 * beats our guess from the status class.
 *
 * Found by the spec that asserts this, not by reading the code — which is the
 * whole reason the mapping is a pure function rather than a branch in the screen.
 */
export function signupRefusal(err: unknown, copy: Copy): SignupRefusal {
  if (!(err instanceof ApiError)) {
    return { message: copy.signUpErrFailed, recovery: 'retype' };
  }

  const known = err.code === null ? undefined : REFUSALS[err.code];
  if (known) {
    // Every mapped key is a plain string in `Copy`; the cast is narrowing the
    // union that also holds the copy FUNCTIONS, none of which appear above.
    return { message: copy[known.key] as string, recovery: known.recovery };
  }

  /*
    No code, or one we do not know, AND no connection. `signInOffline` is the wrong
    sentence here even though it is one word away: it promises a log-in she is not
    attempting.
  */
  if (err.kind === 'offline') {
    return { message: copy.signUpOffline, recovery: 'retype' };
  }

  /**
   * An unmapped refusal. `signUpErrFailed` rather than `err.message`, on purpose:
   * passing the server's sentence through is how English reaches an Arabic
   * screen, and a code this client has never heard of is by definition one whose
   * wording nobody has reviewed in either language. The `retype` recovery is the
   * conservative one — it neither hides the form nor claims the terms moved.
   */
  return { message: copy.signUpErrFailed, recovery: 'retype' };
}
