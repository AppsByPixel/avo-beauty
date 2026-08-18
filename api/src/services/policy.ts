/**
 * Policy acceptance — non-negotiable #10, both halves.
 *
 *   "The customer app holds no legal copy. It renders the published policy set
 *    from the API and stamps the version. Store the accepted version against
 *    the member."
 *
 * design/README.md gap 5 is the part that decides the shape of this file:
 * "a real build must store the accepted version against the member at signup,
 * and re-prompt on a material change. Do not rely on 'they agreed to whatever is
 * current'."
 *
 * THE CLIENT SENDS THE VERSION IT DISPLAYED, AND THIS FILE REFUSES A STALE ONE
 * ---------------------------------------------------------------------------
 * A server that stamped `member.policy_version = <whatever is published now>`
 * would satisfy the letter of #10 and reproduce exactly what gap 5 forbids: the
 * stored number would be a claim about a document she may never have been shown.
 * She can only accept what was on the screen, so the screen tells us which
 * version that was and `requireCurrentPolicyVersion` refuses anything else.
 *
 * `policy_version_stale` IS A RENDERABLE CLIENT STATE, NOT AN EDGE CASE. A
 * publish landing between the moment the signup screen rendered and the moment
 * she taps Create account is the ordinary race, not a freak one, and the client
 * has a sensible thing to do about it: fetch the new set and show it again. The
 * refusal therefore carries both version numbers so the client can say "the
 * terms changed" rather than "something went wrong".
 *
 * WHY THE ANSWER IS DERIVED FROM EVENTS AND NEVER FROM `member.policy_version`
 * ---------------------------------------------------------------------------
 * `member.policy_version` is the cached current value — cheap to read, and NOT
 * evidence. It is a single mutable integer, so it can answer "which version did
 * she last accept" and nothing else. #10's second half asks a different
 * question: "has she accepted the version published NOW", which needs the
 * history, because the interesting case is a member whose stamp says v3 while
 * v4 is live.
 *
 * NO EVENT AT ALL MEANS NOT ACCEPTED. Not "unknown", not "assume the column is
 * right" — the same rule services/consent.ts states for marketing consent, and
 * for the same reason: inferring agreement from silence is the answer that
 * cannot be defended afterwards. Every member seeded before migration 0025 is
 * therefore due a re-prompt, which is correct rather than unfortunate: her
 * acceptance was never recorded, so nobody can show what she agreed to.
 */

import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { legalDocumentSet } from '../db/schema/legal';
import { memberConsentEvent } from '../db/schema/member';
import { conflict, serviceUnavailable } from '../http/errors';
import type { Executor } from './audit';
import { recordConsent } from './consent';

/** The kind on the consent event. Widened into the CHECK by migration 0025. */
export const POLICY_ACCEPTANCE = 'policy_acceptance' as const;

/**
 * The newest published set. `version` is the primary key and a publish INSERTs
 * (migration 0019), so "currently published" is the highest version.
 */
export async function publishedPolicySet(
  db: Db,
): Promise<typeof legalDocumentSet.$inferSelect | null> {
  const rows = await db
    .select()
    .from(legalDocumentSet)
    .orderBy(desc(legalDocumentSet.version))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * The published set, or a 503.
 *
 * Not a 500 and not a 404: nothing is broken and the caller did nothing wrong,
 * the deployment simply has no legal set. The same reasoning and the same code
 * `GET /v1/platform/policies` already answers with, so a client meets one
 * refusal for this condition rather than two.
 *
 * It matters that signup fails CLOSED here. A registration that succeeded with
 * no published terms would create a member with a `policy_version` pointing at
 * nothing — which is the state migration 0019 was written to end.
 */
export async function requirePublishedPolicySet(
  db: Db,
): Promise<typeof legalDocumentSet.$inferSelect> {
  const set = await publishedPolicySet(db);
  if (!set) {
    throw serviceUnavailable(
      'policies_not_published',
      'The policy set has not been published yet.',
    );
  }
  return set;
}

/**
 * Validate the version the client says it displayed, and return the published
 * set it matched.
 *
 * `submitted` is deliberately typed `unknown`: an absent `policyVersion` must be
 * a refusal and not a default. Defaulting it to the current version is the
 * "they agreed to whatever is current" failure written as a `??`.
 */
export async function requireCurrentPolicyVersion(
  db: Db,
  submitted: unknown,
): Promise<typeof legalDocumentSet.$inferSelect> {
  const set = await requirePublishedPolicySet(db);

  if (typeof submitted !== 'number' || !Number.isInteger(submitted) || submitted <= 0) {
    throw conflict(
      'policy_version_required',
      'Show the terms and send the version you displayed.',
      { publishedVersion: set.version },
    );
  }

  if (submitted !== set.version) {
    /**
     * 409, not 400. The client did nothing wrong — it displayed the version that
     * was current when it rendered, and a publish landed underneath it. That is a
     * conflict with the current state of the resource, which is what a 409 means,
     * and it tells the client the difference is worth re-reading rather than
     * worth fixing in the request.
     */
    throw conflict(
      'policy_version_stale',
      'The terms have been updated. Please read them and accept again.',
      { publishedVersion: set.version, submittedVersion: submitted },
    );
  }

  return set;
}

/**
 * Append the acceptance. Takes an executor so signup commits the member row and
 * the evidence together — a member created without her acceptance, or an
 * acceptance for a member who does not exist, are both worse than a failed
 * signup.
 *
 * `granted` is always true and is not a parameter:
 * `member_consent_acceptance_is_never_withdrawn` refuses anything else, and
 * migration 0025 carries the reasoning (there is no "I un-accept the terms"
 * fact in this product; there is account deletion).
 */
export async function recordPolicyAcceptance(
  exec: Executor,
  input: {
    memberId: string;
    salonId: string;
    policyVersion: number;
    source: 'signup' | 'wallet_account';
    ipAddress?: string | null;
    userAgent?: string | null;
  },
): Promise<void> {
  await recordConsent(exec, {
    memberId: input.memberId,
    salonId: input.salonId,
    kind: POLICY_ACCEPTANCE,
    granted: true,
    source: input.source,
    policyVersion: input.policyVersion,
    // `?? null` rather than passing through: `exactOptionalPropertyTypes` draws a
    // real distinction between an absent field and an explicit `undefined`, and
    // an absent client IP is a known null here rather than an unset property.
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent ?? null,
  });
}

export interface PolicyAcceptance {
  version: number;
  at: string;
  source: string;
}

/** Her newest acceptance, or null if none was ever recorded. */
export async function latestPolicyAcceptance(
  db: Db,
  memberId: string,
): Promise<PolicyAcceptance | null> {
  const rows = await db
    .select()
    .from(memberConsentEvent)
    .where(
      and(
        eq(memberConsentEvent.memberId, memberId),
        eq(memberConsentEvent.kind, POLICY_ACCEPTANCE),
      ),
    )
    .orderBy(desc(memberConsentEvent.createdAt))
    .limit(1);

  const latest = rows[0];
  if (!latest) return null;
  return {
    version: latest.policyVersion,
    at: latest.createdAt.toISOString(),
    source: latest.source,
  };
}

export interface PolicyAcceptanceState {
  /** What is published now, and what a re-prompt would show her. */
  published: { version: number; effectiveFrom: string; publishedAt: string } | null;
  /** The evidence. Null means no acceptance was ever recorded for her. */
  accepted: PolicyAcceptance | null;
  /**
   * `member.policy_version` — the cached value, carried so support can see the
   * stamp beside the evidence. It is NOT what `upToDate` is computed from, and a
   * `stampedVersion` with a null `accepted` is exactly the pre-0025 member whose
   * agreement nobody can produce.
   */
  stampedVersion: number;
  /** False means re-prompt. THE #10 QUESTION, answered from the event trail. */
  upToDate: boolean;
}

/**
 * "Has this member accepted the currently published version?"
 *
 * The whole point of the event shape. One call, and a client knows whether to
 * put the terms in front of her again.
 */
export async function policyAcceptanceState(
  db: Db,
  m: { id: string; policyVersion: number },
): Promise<PolicyAcceptanceState> {
  const [set, accepted] = await Promise.all([
    publishedPolicySet(db),
    latestPolicyAcceptance(db, m.id),
  ]);

  return {
    published: set
      ? {
          version: set.version,
          // A `date` column, already "YYYY-MM-DD". Pushing it through a Date
          // re-interprets the calendar day in the process zone and can move it.
          effectiveFrom: set.effectiveFrom,
          publishedAt: set.publishedAt.toISOString(),
        }
      : null,
    accepted,
    stampedVersion: m.policyVersion,
    /**
     * Both halves have to be true, and neither falls back to the column. No
     * published set means there is nothing she could have accepted; no event
     * means nothing was recorded.
     */
    upToDate: set !== null && accepted !== null && accepted.version === set.version,
  };
}
