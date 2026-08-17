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
 */

export function isForbidden(error: unknown): boolean {
  return error instanceof ApiError && error.isForbidden;
}

export function isUnauthenticated(error: unknown): boolean {
  return error instanceof ApiError && error.isUnauthenticated;
}

export interface SectionErrorProps {
  error: unknown;
  /** "You don't have access to the team" — names the section, not the endpoint. */
  forbiddenTitle: string;
  /** "Couldn't load the team" */
  failedTitle: string;
  onRetry: () => void;
  retrying: boolean;
}

export function SectionError({
  error,
  forbiddenTitle,
  failedTitle,
  onRetry,
  retrying,
}: SectionErrorProps) {
  if (isUnauthenticated(error)) return null;

  if (isForbidden(error)) {
    // Server-authored copy, rendered verbatim. It names the permission and who
    // can grant it; a paraphrase here would drop that.
    return <ErrorState title={forbiddenTitle} body={(error as ApiError).message} />;
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
   */
  const serverExplained = api !== null && (api.status === 400 || api.status === 409 || forbidden);

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
