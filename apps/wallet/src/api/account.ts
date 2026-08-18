/**
 * The Account screen's endpoints.
 *
 * Every shape here comes from @avo/types, which is generated from
 * design/api-contract.md. This file adds no entity shapes of its own — the two
 * schemas it does declare (`PublishedPoliciesSchema`, `PhoneChallengeSchema`)
 * are envelopes the contract describes in prose but that the shared package has
 * no named type for, and both are built out of shared schemas rather than
 * restating a field.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EVERY ROUTE IN THIS FILE IS NOW SERVED BY THE REAL API.
 *
 * That was not true when it was written, and the shape of the file is the
 * record of it: three groups of calls, written against the contract's own paths
 * and bodies so that when the endpoints landed nothing here would change.
 * Nothing here did change — the calls were already right. What changed is that
 * they now return instead of 404ing, and the screens above them can stop
 * rendering honest failures.
 *
 *     POST   /members/me/password                          always existed
 *     GET    /v1/platform/policies                         landed — all SEVEN
 *                                                          documents, both
 *                                                          languages. The mock
 *                                                          served three.
 *     GET    /v1/platform/support                          landed
 *     POST   /v1/support/tickets                           landed
 *     PATCH  /members/me                                   landed
 *     POST   /members/me/phone-change                      landed
 *     POST   /members/me/phone-change/{id}/verify          landed
 *     GET    /members/me/notifications                     landed
 *     PATCH  /members/me/notifications                     landed
 *     POST   /members/me/deletion                          landed
 *     DELETE /members/me/deletion                          landed
 *
 * The last four were in NO contract at all and were escalated rather than
 * invented — the deletion shape in particular, because whether deletion is a
 * ticket, a queued job or a state on the member changes what the confirmation
 * is ALLOWED to say, and the copy already promised "removed within 30 days".
 * Lane A made it a member state with a clock, so the promise is now backed.
 *
 * Their shapes are still not in api-contract.md. They are declared here as
 * envelopes, built out of shared schemas where shared schemas exist, and
 * reported to trunk rather than added to `packages/types` from this lane.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { z } from 'zod';
import {
  DateTimeSchema,
  LegalDocSchema,
  MemberSchema,
  SupportConfigSchema,
  SupportTicketSchema,
} from '@avo/types';
import type { LegalDoc, Member, SupportConfig, SupportTicket } from '@avo/types';
import {
  deleteJson,
  getJson,
  newIdempotencyKey,
  patchJson,
  postAction,
  postNoContent,
} from './client';

// ------------------------------------------------------------------ policies --

/**
 * The published half of the legal set, and only the published half.
 *
 * api-contract.md: "GET /v1/platform/policies → { published, draft }", and
 * "Customer | Legal documents | GET /v1/platform/policies (published only)".
 * The draft is the owner console's working copy and nothing in it has reached a
 * customer, so the wallet does not model it: an unpublished clause parsed into
 * the wallet's memory is one refactor away from being rendered.
 */
export const PublishedPoliciesSchema = z.object({
  published: z.object({
    version: z.number().int().positive(),
    /** "YYYY-MM-DD". Stamped into the document header with the version. */
    effectiveFrom: z.string(),
    publishedAt: DateTimeSchema,
    publishedBy: z.string(),
    docs: z.array(LegalDocSchema),
  }),
});

export type PublishedPolicies = z.infer<typeof PublishedPoliciesSchema>['published'];

/**
 * NON-NEGOTIABLE #10. This function is the ONLY source of legal text in the
 * wallet. There is no bundled fallback set, no "if the fetch fails show the
 * terms we shipped with" branch, and no default document list — if this returns
 * nothing, the policies section renders nothing.
 *
 * That is testable rather than aspirational: `account.test.ts` renders the
 * section against an empty `docs` array and asserts the screen is empty. A
 * bundled clause would make that test fail, which is the whole point.
 */
export async function getPolicies(signal?: AbortSignal): Promise<PublishedPolicies> {
  const body = await getJson('/v1/platform/policies', PublishedPoliciesSchema, signal);
  return body.published;
}

/**
 * The document in the customer's language, with the contract's fallback.
 *
 * api-contract.md: "An empty `body.ar` is a legitimate state (document not yet
 * translated) and the client falls back to `en`". So the fallback is per
 * document and per field, not per set: a translated title over an untranslated
 * body is a state the owner console can produce and the wallet has to render.
 */
export function localiseDoc(
  doc: LegalDoc,
  lang: 'en' | 'ar',
): { id: string; title: string; body: string[]; translated: boolean } {
  const title = lang === 'ar' && doc.title.ar.trim() ? doc.title.ar : doc.title.en;
  const body = lang === 'ar' && doc.body.ar.length > 0 ? doc.body.ar : doc.body.en;
  return {
    id: doc.id,
    title,
    body,
    translated: lang === 'en' || doc.body.ar.length > 0,
  };
}

// ------------------------------------------------------------------- support --

/** Channels, hours, the reply promise, and the topic list. AVO owns all of it. */
export function getSupportConfig(signal?: AbortSignal): Promise<SupportConfig> {
  return getJson('/v1/platform/support', SupportConfigSchema, signal);
}

/**
 * NON-NEGOTIABLE #11. The body carries `topicId` and never `route`.
 *
 * The route is on `SupportTopic` — the wallet reads it to draw the "Salon" /
 * "AVO" chip next to each topic, because the design shows the customer who
 * answers before she picks. Displaying it and sending it are different things:
 * a client that posted the route it displayed would let anyone who can edit a
 * request body drop a wallet dispute into a salon's inbox. So the field is
 * absent from `TicketDraft` entirely rather than optional, and the type makes
 * adding it back a compile error.
 *
 * The response's `route` is the server's answer, and it is what the confirmation
 * screen reads to choose between "Amara has your message" and "AVO support has
 * your message" — the customer is told where it actually went, not where the
 * client guessed.
 */
export interface TicketDraft {
  topicId: string;
  message: string;
  /** The receipt reference, when the form was opened from a payment. */
  ref?: string;
  via: 'wa' | 'email';
}

export function submitTicket(draft: TicketDraft, signal?: AbortSignal): Promise<SupportTicket> {
  return postAction(
    '/v1/support/tickets',
    {
      topicId: draft.topicId,
      message: draft.message,
      ref: draft.ref ?? '',
      via: draft.via,
    },
    SupportTicketSchema,
    // Not money, so not non-negotiable #4 — but a customer who taps Send twice
    // on a slow connection should raise one ticket with one reference, not two.
    { idempotencyKey: newIdempotencyKey(), ...(signal ? { signal } : {}) },
  );
}

// ------------------------------------------------------------------- profile --

/**
 * api-contract.md rule 1: "`PATCH /members/me` must reject a `phone` field."
 *
 * The type says so too. Phone is not optional-and-ignored here; it is not a
 * member of the interface, so a call site that tries to slip the login identity
 * through the profile edit does not compile. The change goes through the
 * challenge pair below.
 */
export interface ProfilePatch {
  name?: string;
  /** Empty string clears it. Changing it clears `emailVerified` server-side. */
  email?: string | null;
}

export function patchProfile(patch: ProfilePatch, signal?: AbortSignal): Promise<Member> {
  return patchJson('/members/me', patch, MemberSchema, signal);
}

/** `POST /members/me/phone-change { phone } → { challengeId, expiresAt }`. */
export const PhoneChallengeSchema = z.object({
  challengeId: z.string().min(1),
  expiresAt: DateTimeSchema,
});

export type PhoneChallenge = z.infer<typeof PhoneChallengeSchema>;

/**
 * Start a phone change. Sends a code to the NEW number.
 *
 * The old number is notified by the server that the change happened
 * (api-contract.md rule 1) — the client neither sends that nor can suppress it.
 */
export function startPhoneChange(phone: string, signal?: AbortSignal): Promise<PhoneChallenge> {
  return postAction(
    '/members/me/phone-change',
    { phone },
    PhoneChallengeSchema,
    signal ? { signal } : {},
  );
}

/** Finish it. Returns the updated Member — the new phone is now the identity. */
export function verifyPhoneChange(
  challengeId: string,
  code: string,
  signal?: AbortSignal,
): Promise<Member> {
  return postAction(
    `/members/me/phone-change/${encodeURIComponent(challengeId)}/verify`,
    { code },
    MemberSchema,
    signal ? { signal } : {},
  );
}

// ------------------------------------------------------------------ password --

/**
 * Change the password, and sign every other device out.
 *
 * THE UI PROMISE HERE IS REAL, WHICH IS WHY THE CALL IS REAL.
 *
 * The design's subtitle says "You stay logged in on this phone. Other devices
 * are signed out" — a security claim, in front of a customer, in both languages.
 * The API keeps it: `api/src/routes/auth.ts` revokes every session for the
 * member except the calling one and writes an audit row, and lane D's suite
 * proves the shape end to end — the caller stays 200, a second device's next
 * request is 401 and its refresh is 401 too.
 *
 * So there is exactly one thing this client must not do, and it is the thing a
 * "make it feel snappy" refactor would do: show the confirmation without
 * awaiting the call. The sentence on screen is only true after the server has
 * answered.
 *
 * Returns void. `postNoContent` cannot return a body, so no accidental logging
 * of a response can print a credential — non-negotiable #6.
 */
export function changePassword(
  current: string,
  next: string,
  signal?: AbortSignal,
): Promise<void> {
  return postNoContent('/members/me/password', { current, next }, signal);
}

// ------------------------------------------------------------- notifications --

/**
 * The five switches — server-held, and four of them were never the client's.
 *
 * This was device-local `AsyncStorage` while no endpoint existed, and the
 * escalation said exactly why that was untenable: `wa` and `receipt` are sent
 * BY THE SERVER, so a local "off" does not stop a receipt and the customer has
 * been told it did. `offers` is marketing consent, which non-negotiable #8
 * needs readable on the platform send path. Storage that cannot be read by the
 * thing it is supposed to govern is not a preference, it is a false statement.
 *
 * `offersConsent` is the evidence beside the boolean: when she answered, from
 * where, and under which version of the terms. The screen binds to `offers`;
 * this type carries the rest because the response does, and because dropping it
 * here is precisely the silent stripping the contract guard exists to catch.
 *
 * NOT IN api-contract.md. The API serves it and the shape is lane A's; it is
 * declared here as an envelope rather than added to `packages/types` from this
 * lane. Reported to trunk.
 */
export const ConsentStateSchema = z.object({
  granted: z.boolean(),
  /** Null when she has never been asked. No event at all means no consent. */
  at: DateTimeSchema.nullable(),
  source: z.enum(['signup', 'wallet_account', 'support', 'import']).nullable(),
  policyVersion: z.number().int().positive().nullable(),
});

export const NotificationPreferencesSchema = z.object({
  push: z.boolean(),
  remind: z.boolean(),
  wa: z.boolean(),
  receipt: z.boolean(),
  offers: z.boolean(),
  offersConsent: ConsentStateSchema,
});

export type NotificationPreferencesResponse = z.infer<typeof NotificationPreferencesSchema>;

export function getNotifications(signal?: AbortSignal): Promise<NotificationPreferencesResponse> {
  return getJson('/members/me/notifications', NotificationPreferencesSchema, signal);
}

/**
 * PATCH one switch, not all five.
 *
 * The API refuses an unknown key by name and refuses an empty body, and it
 * records a consent EVENT only when the answer actually changes — re-sending
 * the same value is a screen re-rendering, not the customer consenting again.
 * Sending only the switch she touched is what keeps that true: a full-object
 * PATCH would be indistinguishable from four deliberate answers.
 */
export function patchNotifications(
  patch: Partial<Record<'push' | 'remind' | 'wa' | 'receipt' | 'offers', boolean>>,
  signal?: AbortSignal,
): Promise<NotificationPreferencesResponse> {
  return patchJson('/members/me/notifications', patch, NotificationPreferencesSchema, signal);
}

// ------------------------------------------------------------------ deletion --

/**
 * Account deletion — a member state with a clock, which is what the copy needed.
 *
 * The wallet's copy has always promised "removed within 30 days" and there was
 * nothing behind it; this function used to `console.warn` and return
 * `{ recorded: false }`, because faking a confirmation is a data-protection
 * problem rather than a TODO. The endpoint exists now and the promise is backed
 * by `deletionDueAt` on the member row — `graceDays` comes back so the sentence
 * states the server's number rather than a 30 hard-coded twice.
 *
 * TWO REFUSALS THE SCREEN HAS TO TELL APART, and neither is a generic error:
 *
 *   401 invalid_credentials   the password did not match, AND NOTHING HAPPENED.
 *                             No clock started. She can simply try again.
 *   409 balance_outstanding   she still holds credit. The error carries
 *                             `balanceFils`, so the screen names the amount
 *                             instead of telling her to go and look.
 *
 * The second is the one a real customer hits, because a wallet with money in it
 * is the normal state of a wallet. Erasing the account that names money the
 * salon owes her is the one outcome nobody can undo.
 */
export const DeletionStateSchema = z.object({
  requestedAt: DateTimeSchema.nullable(),
  erasureDueAt: DateTimeSchema.nullable(),
  status: z.enum(['none', 'pending']),
  /** The grace window in days. The server's number, not a client constant. */
  graceDays: z.number().int().positive(),
  erasureScheduled: z.boolean(),
});

export type DeletionState = z.infer<typeof DeletionStateSchema>;

/**
 * Is a deletion already scheduled? Read on every Account mount.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THIS IS WHAT MAKES THE GRACE WINDOW REAL.
 *
 * Until this landed, the ONLY route to the cancel door was the few seconds
 * between requesting deletion and closing the sheet. `Member` carried no
 * deletion state, so a customer who requested it and reopened the app saw an
 * ordinary Account screen — clock running, nothing saying so, no way back. A
 * 30-day window she cannot find is not a window.
 *
 * WHY AN ENDPOINT RATHER THAN TWO FIELDS ON `Member`, which is what this lane
 * originally asked for: an undeclared field would have been STRIPPED by zod
 * rather than rejected. `MemberSchema` is a closed object, so adding
 * `deletionRequestedAt` to the API's response without also adding it to
 * `packages/types` would have parsed clean and arrived as `undefined` — the
 * silent-widening trap, in the direction where the wallet shows nothing and
 * nobody sees a failure. A separate route with its own schema cannot fail that
 * way: if it is missing the read fails loudly and the section says so.
 *
 * `erasureScheduled` is `false` and is expected to STAY false: the job that
 * actually nulls the columns is not built, because which columns are nulled at
 * the due date is the client's retention decision (CLAUDE.md § Escalate). So
 * nothing on this screen may imply the erasure has happened or is under way —
 * "we have your request and the clock is running" and "it has been carried out"
 * are different sentences and only the first is true.
 * ═════════════════════════════════════════════════════════════════════════════
 */
export function getDeletionState(signal?: AbortSignal): Promise<DeletionState> {
  return getJson('/members/me/deletion', DeletionStateSchema, signal);
}

/**
 * The password is required and is sent for one request only.
 *
 * Non-negotiable #6: it is never stored, never cached, never logged, and the
 * response cannot contain it. An unlocked handset on a salon counter is the
 * threat this guards, which is the same reasoning behind
 * `POST /members/me/password` demanding `current`.
 *
 * Idempotent server-side: asking twice is one request and does not restart the
 * clock, so a double-tapped button cannot quietly extend the 30 days.
 */
export function requestAccountDeletion(
  password: string,
  signal?: AbortSignal,
): Promise<DeletionState> {
  return postAction(
    '/members/me/deletion',
    { password },
    DeletionStateSchema,
    signal ? { signal } : {},
  );
}

/**
 * Change her mind. The grace window is only real if she can use it.
 *
 * Sessions are deliberately NOT revoked on request, so she is still signed in
 * and this door is reachable. 404 `no_deletion_request` when there was nothing
 * pending — which the screen treats as already-cancelled rather than an error.
 */
export function cancelAccountDeletion(signal?: AbortSignal): Promise<DeletionState> {
  return deleteJson('/members/me/deletion', DeletionStateSchema, signal);
}
