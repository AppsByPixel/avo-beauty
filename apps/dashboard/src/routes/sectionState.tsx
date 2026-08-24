import type { ReactNode } from 'react';
import { ErrorState } from '@avo/ui';
import { ApiError } from '../api/client.js';

/**
 * The four states, in one place, for every section below the shell.
 *
 * Overview worked this out first and wrote it inline. Five more sections is five
 * more chances to get the distinction backwards, and the failure is quiet: a
 * refusal rendered with a Retry button looks like a bug in the API rather than a
 * permission the merchant does not hold, and she presses it until she calls
 * someone.
 *
 * interaction-spec.md §4: "distinguish *we failed* (retry) from *you can't do
 * that* (explain)."
 *
 *   401  the session is gone. The shell is already redirecting; render nothing.
 *        A refusal rendered here flashes for a frame and tells a merchant she
 *        lacks a permission she actually holds.
 *   403  explain, NO retry. An identical request produces an identical refusal,
 *        so a retry button is a lie about what she can do. The body is the
 *        server's own copy, which names who can grant the permission.
 *   else we failed — offer the retry.
 *
 * ---------------------------------------------------------------------------
 * THE COURTESY-GATE LEDGER. Read this before adding a section.
 *
 * A section needs a `session.perms` check ONLY when its READ is ungated and its
 * WRITES are not. Where the read is already permission-gated the 403 arrives on
 * its own and `SectionError` explains it — adding a client check there would
 * duplicate the server and drift from it.
 *
 * Settings survived for weeks in the wrong column because the ABSENCE of a gate
 * is indistinguishable from an oversight. So the decision is written down per
 * section, with the permission the SERVER enforces, so the next person can check
 * a claim here against `api/src/routes` without reading the handlers.
 *
 * Verified against the guards in api/src/routes, not against the permission name
 * that sounds right:
 *
 *   Section       read → server guard                        writes → guard      gate
 *   ─────────────────────────────────────────────────────────────────────────────────
 *   Overview      /metrics            → perms.dashboard      (none)              none needed
 *                 /charges            → SCANNER perms.charges
 *   Appointments  /bookings           → perms.appointments   (none)              none needed
 *   Team          /artists            → perms.team           availability → team none needed
 *   Loyalty       /loyalty            → perms.loyalty        PUT /loyalty → loyalty
 *                                                                                none needed
 *   Audit log     /audit              → perms.dashboard      (none, ever)        none needed
 *   Accounts      /staff              → perms.team           staff/* → team      none needed
 *   Marketing     /promotions         → requirePrincipal     boosts, happy-hours,
 *                                       NO PERMISSION        campaigns → marketing
 *                                                                                perms.marketing
 *   Settings      /salons/{id}        → requirePrincipal     PATCH /salons/{id}
 *                                       NO PERMISSION        + branches → loyalty
 *                                                                                perms.loyalty
 *
 * Only the last two have the ungated-read/gated-write shape, and both now carry a
 * gate naming the permission the server actually checks. The other six are
 * deliberately ungated on the client, and that is a decision rather than a gap.
 *
 * TWO THINGS THE TABLE MAKES VISIBLE that reading one file does not:
 *
 * 1. `GET /charges` is `requireScannerPerm(req, 'charges')` — a SCANNER-scope
 *    guard, not a dashboard one. No web principal can ever satisfy it, whatever
 *    permissions she holds, which is why Overview's activity feed renders the
 *    server's "charging happens on the staff scanner" refusal for everyone. That
 *    is the contract, not a permission to grant.
 * 2. Every salon write — `PATCH /salons/{id}` and all three branch routes — is
 *    `perms.loyalty`, NOT `perms.dashboard`. Gating Settings on `dashboard`
 *    would hide it from somebody the API would let save, which is a different
 *    defect and not a safer one.
 *
 * Non-negotiable #7 is unchanged by any of this: every gate above is enforced
 * server-side and would refuse with the check deleted. These are courtesies.
 */

export function isForbidden(error: unknown): boolean {
  return error instanceof ApiError && error.isForbidden;
}

export function isUnauthenticated(error: unknown): boolean {
  return error instanceof ApiError && error.isUnauthenticated;
}

/**
 * A CONFIGURATION STATE THE SERVER NAMED — not a failure, and not the network.
 *
 * `policies_not_published` and `support_not_configured` are answers. The server
 * is healthy, its STATE is wrong, and it says so in a sentence written to be
 * read: "The policy set has not been published yet." Both were being thrown away
 * before this existed, and in the two worst possible directions:
 *
 *   409 policies_not_published  -> "Something went wrong on our side. Nothing
 *                                   has changed in your salon."  Nothing went
 *                                   wrong; every wallet cannot show terms.
 *   503 support_not_configured  -> "No connection … try again once you're back
 *                                   online."  The connection is fine. `503` is
 *                                   in `ApiError.isConnectivity`, correctly, and
 *                                   that is exactly how a served answer ended up
 *                                   in the offline bucket.
 *
 * Console/Policies.tsx carried a comment claiming the server's own sentence was
 * rendered here ("the only honest option"). It was not, and it named the wrong
 * status while doing it. An announced-not-painted defect in prose rather than in
 * a caption: the intent was written down, the code never did it, and the comment
 * is why nobody re-checked.
 *
 * KEYED ON SHAPE, NOT ON A LIST OF CODES. A hardcoded set of code strings drifts
 * the moment the API names a third state — which it will, and which is how this
 * one survived `policies_not_published` being fixed. The discriminator instead:
 *
 *   status 409 or 503, `code` is not the client's `http_error` fallback, and the
 *   request was not a connection failure.
 *
 * A reverse proxy's 503 has no JSON body, so `client.ts` labels it `http_error`
 * and it stays in the offline bucket where it belongs. Only a 503 the API itself
 * composed through `serviceUnavailable(code, message)` carries a real code.
 *
 * NO RETRY BUTTON. api/src/services/policy.ts is emphatic about why: "503
 * promises 'try again later and it may work'; this will not work until somebody
 * publishes." A retry on a configuration state is the same lie a retry on a 403
 * is. Lane A moved the policy route 503 -> 409 for that reason and has not yet
 * moved `support_not_configured`, so until it does, `retryPolicy.ts` still spends
 * its budget on that one before the sentence appears — reported to lane A rather
 * than special-cased here, because the status is the API's to state.
 */
export function namedStateAnswer(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  if (error.offline) return null;
  if (error.status !== 409 && error.status !== 503) return null;
  if (error.code === 'http_error') return null;
  return error.message;
}

export interface SectionErrorProps {
  error: unknown;
  /** "You don't have access to the team" — names the section, not the endpoint. */
  forbiddenTitle: string;
  /** "Couldn't load the team" */
  failedTitle: string;
  onRetry: () => void;
  retrying: boolean;
  /**
   * The heading over a `namedStateAnswer`. Optional: a screen that cannot reach
   * one does not need it, and where it is absent the state answer falls back to
   * `failedTitle` rather than going unrendered.
   */
  stateTitle?: string;
}

export function SectionError({
  error,
  forbiddenTitle,
  failedTitle,
  onRetry,
  retrying,
  stateTitle,
}: SectionErrorProps) {
  if (isUnauthenticated(error)) return null;

  if (isForbidden(error)) {
    // Server-authored copy, rendered verbatim. It names the permission and who
    // can grant it; a paraphrase here would drop that.
    return <ErrorState title={forbiddenTitle} body={(error as ApiError).message} />;
  }

  // Before the offline check, because a served 503 is in `isConnectivity` and
  // would otherwise be reported as a dead network.
  const named = namedStateAnswer(error);
  if (named !== null) {
    return <ErrorState title={stateTitle ?? failedTitle} body={named} />;
  }

  const offline = error instanceof ApiError && error.isConnectivity;
  return (
    <ErrorState
      title={offline ? 'No connection' : failedTitle}
      body={
        offline
          ? "We can't reach the workspace. Nothing is lost — try again once you're back online."
          : 'Something went wrong on our side. Nothing has changed in your salon.'
      }
      onRetry={onRetry}
      retrying={retrying}
    />
  );
}

/**
 * The banner a failed *write* leaves behind, as distinct from a failed read.
 *
 * A write that failed has a property a read does not: the screen is still
 * showing what the merchant typed, and the salon is still showing what it had
 * before. Saying which is which is the whole job — "Nothing was published" is
 * the sentence that stops someone re-entering a tier ladder that never left the
 * browser, and stops them assuming one did.
 */
export interface WriteErrorProps {
  error: unknown;
  /** What did not happen: "Nothing was published." */
  reassurance: string;
  children?: ReactNode;
}

export function WriteError({ error, reassurance }: WriteErrorProps) {
  if (isUnauthenticated(error)) return null;

  const forbidden = isForbidden(error);
  const api = error instanceof ApiError ? error : null;

  /*
   * A 400 and a 409 are neither "we failed" nor "you can't" — they are "that
   * particular change is not allowed", and the server said why in a sentence
   * written for a merchant. `availability_is_synced` names the fix ("Switch to
   * Manual hours"); `void_requires_charges` names the order to do it in. Those
   * are rendered verbatim; inventing a friendlier version loses the fix.
   *
   * `namedStateAnswer` is folded in for the same reason it exists above, and the
   * write path had the identical hole: `POST /artists/{id}/calendar` answers 503
   * `calendar_not_configured` with a five-clause sentence naming exactly what the
   * deployment is missing and what happens meanwhile ("artists are bookable on
   * salon hours") — and 503 is in `isConnectivity`, so all of it was replaced by
   * "We couldn't reach the workspace." on a workspace that answered. Fixing the
   * read half and not this one is how the two would have drifted apart.
   */
  const serverExplained =
    api !== null &&
    (api.status === 400 || api.status === 409 || forbidden || namedStateAnswer(api) !== null);

  return (
    <div className="section-write-error" role="alert">
      <span className="section-write-error__dot" aria-hidden="true" />
      <span className="section-write-error__text">
        {serverExplained
          ? api.message
          : api?.isConnectivity
            ? "We couldn't reach the workspace."
            : 'Something went wrong on our side.'}{' '}
        <b>{reassurance}</b>
      </span>
    </div>
  );
}
