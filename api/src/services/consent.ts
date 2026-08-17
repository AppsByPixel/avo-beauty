/**
 * Marketing consent: reading it, and recording a change to it.
 *
 * THE POINT OF THIS FILE IS THAT THE SEND PATH HAS ONE PLACE TO ASK.
 *
 * Non-negotiable #8: "A merchant cannot send a customer message.
 * `POST /campaigns` only creates `pending`. Delivery happens on the platform
 * decision endpoint, and caps and quiet hours are enforced again at send time."
 * Consent is the check that sits beside those two, and it has to be asked at
 * SEND time for the same reason they do — an approval given on Tuesday is not
 * evidence of a consent still standing on Friday.
 *
 * `marketingConsentOf` is what that path calls. It is written here rather than
 * inline in the eventual sender so that the definition of "may we send to her"
 * cannot end up existing twice, once in the campaign sender and once in
 * whatever reads the Account screen — which is exactly how a customer who
 * turned offers off keeps receiving them.
 *
 * WHY THE STATE IS DERIVED AND NOT STORED
 *
 * The current answer is the newest event. There is no cached boolean to fall
 * out of step with the trail, and the trail is the thing an audit actually
 * needs: `member_consent_event` has UPDATE and DELETE revoked from the
 * application role (migration 0020), so what the send path reads is the same
 * append-only record a regulator would be shown.
 *
 * NO EVENT AT ALL MEANS NO CONSENT. Not "unknown", not "assume yes". A member
 * who predates this table has never been asked, and inferring a grant from
 * silence is the one answer that cannot be defended afterwards.
 */

import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { memberConsentEvent, type ConsentKind, type ConsentSource } from '../db/schema/member';
import type { Executor } from './audit';

export interface ConsentState {
  granted: boolean;
  /** When the standing answer was given. Null when she has never been asked. */
  at: string | null;
  source: ConsentSource | null;
  /** The legal version in force when she answered. */
  policyVersion: number | null;
}

const NEVER_ASKED: ConsentState = {
  granted: false,
  at: null,
  source: null,
  policyVersion: null,
};

/**
 * The standing answer for one member and one kind of consent.
 *
 * THIS IS THE FUNCTION THE PLATFORM SEND PATH MUST CALL before it delivers a
 * campaign to anybody, alongside the weekly/monthly caps and the quiet hours.
 */
export async function marketingConsentOf(
  db: Db,
  memberId: string,
  kind: ConsentKind = 'marketing_offers',
): Promise<ConsentState> {
  const rows = await db
    .select()
    .from(memberConsentEvent)
    .where(and(eq(memberConsentEvent.memberId, memberId), eq(memberConsentEvent.kind, kind)))
    .orderBy(desc(memberConsentEvent.createdAt))
    .limit(1);

  const latest = rows[0];
  if (!latest) return NEVER_ASKED;

  return {
    granted: latest.granted,
    at: latest.createdAt.toISOString(),
    source: latest.source,
    policyVersion: latest.policyVersion,
  };
}

export interface RecordConsentInput {
  memberId: string;
  salonId: string;
  kind?: ConsentKind;
  granted: boolean;
  source: ConsentSource;
  /** The version in force right now — `member.policyVersion`. */
  policyVersion: number;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/**
 * Append one consent event. Never an update — a withdrawal is a new row saying
 * `granted: false`, which is what makes "she turned it off in August and back
 * on in October" a readable history rather than a boolean that is currently
 * true and says nothing about how it got there.
 *
 * Takes an executor so a caller can record consent inside the transaction that
 * created the account, and have the two commit or roll back together.
 */
export async function recordConsent(exec: Executor, input: RecordConsentInput): Promise<void> {
  await exec.insert(memberConsentEvent).values({
    memberId: input.memberId,
    salonId: input.salonId,
    kind: input.kind ?? 'marketing_offers',
    granted: input.granted,
    source: input.source,
    policyVersion: input.policyVersion,
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent ?? null,
  });
}
