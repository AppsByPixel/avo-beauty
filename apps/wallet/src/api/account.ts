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
 * WHAT EXISTS AND WHAT DOES NOT, AT THE TIME OF WRITING
 *
 *   served by the mock AND the real API
 *     POST   /members/me/password
 *
 *   served by the mock ONLY — the real API owes them
 *     GET    /v1/platform/policies
 *     GET    /v1/platform/support
 *     POST   /v1/support/tickets
 *
 *   in api-contract.md, served by NEITHER — the API owes them
 *     PATCH  /members/me
 *     POST   /members/me/phone-change
 *     POST   /members/me/phone-change/{challengeId}/verify
 *
 *   in NO contract and NO server — see `notifications.ts` and
 *   `requestAccountDeletion` below, both escalated rather than invented
 *     notification preferences
 *     account deletion request
 *
 * The three middle calls are written against the contract's own paths and
 * bodies, so when the endpoint lands nothing in this app changes. Until then
 * they fail the way any unbuilt route fails — a 404 classified as `server`, so
 * the sheet shows "we failed, try again" rather than pretending it saved.
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
import { getJson, newIdempotencyKey, patchJson, postAction, postNoContent } from './client';

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

// ------------------------------------------------------------------ deletion --

/**
 * Request account deletion — the App Store requirement.
 *
 * THERE IS NO ENDPOINT. Not in api-contract.md, not in packages/mock, not in
 * api/src/routes. Reported to lane A rather than invented here, because the
 * shape of this one is not a client decision: whether deletion is a ticket, a
 * queued job with a 30-day timer, or a state on the member changes what the
 * confirmation is allowed to say, and the copy already promises "removed within
 * 30 days".
 *
 * So this does what the design does — design/AVO Wallet Home.dc.html:902-903,
 * where BOTH buttons in the delete sheet call `closeDelete` and nothing else —
 * and does not show a success message it cannot back. Faking one is the worst
 * available option: a customer told her data will be gone in 30 days, when
 * nothing was recorded, is a data-protection problem and not a TODO.
 *
 * When the endpoint lands, this is the only function that changes.
 */
export function requestAccountDeletion(): { recorded: false; owes: string } {
  if (__DEV__) {
    console.warn(
      '[avo] account deletion requested — no endpoint exists yet. ' +
        'API owes: POST /members/me/deletion-request (shape undecided, escalated).',
    );
  }
  return { recorded: false, owes: 'POST /members/me/deletion-request' };
}
