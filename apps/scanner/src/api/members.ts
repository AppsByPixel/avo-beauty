/**
 * Manual member lookup — "Can't scan? Find member manually".
 *
 * design/AVO Staff Scanner.dc.html:205-239 specifies the screen: search by name,
 * phone number or member ID, pick a row, charge her.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE ENDPOINT EXISTS, AND THIS FILE USED TO SAY IT DID NOT.
 *
 * `GET /members?q=` is live in api/src/routes/members.ts:167, behind
 * `requireScannerPerm(req, 'scanner')`, with everything that was asked for it:
 * salon-scoped in the WHERE rather than filtered afterwards, a minimum query
 * length, a per-SESSION rate limit counted before the read, and an append-only
 * audit row written whether or not anything matched — which is what makes the
 * design's promise to the customer ("Manual lookups are logged with your name",
 * :233) true rather than decorative.
 *
 * The stale header cost real time: it was read as authoritative and briefed
 * onward as a gap. What was actually broken was this file's expectation.
 *
 * IT ANSWERED WITH A DIRECTORY ROW AND THIS FILE DEMANDED A CUSTOMER RECORD.
 *
 * The response is deliberately narrow — id, salonId, name, phoneLast4, tier:
 *
 *     {"items":[{"id":"8842","salonId":"SAL-AMARA","name":"Dana Al-Sabah",
 *                "phoneLast4":"4408","tier":"silver"}],"nextCursor":null}
 *
 * This module parsed it with `MemberSchema`, which REQUIRES phone, email,
 * emailVerified, balanceFils, visits, stamps, policyVersion and joinedAt. Eight
 * missing fields, so zod threw, `request()` raised `ApiError('server', 'That
 * response did not match the contract.')`, and LookupScreen rendered its error
 * state on EVERY SUCCESSFUL SEARCH. Driven against the real API, all eight
 * issues confirmed before this was changed.
 *
 * This is the drift trap inverted. The usual failure is a client schema wider
 * than the wire, quietly stripping. Here the client was STRICTER than a
 * response that is narrow on purpose — so widening the schema would be the wrong
 * instinct: the server is right. A staff directory row must not carry a
 * customer's wallet balance or her full phone number, and the server not sending
 * them is the control, not an omission.
 *
 * So the shape below is a LOCAL envelope, matching the wire exactly. It is
 * deliberately NOT added to `packages/types`: that package is trunk-owned and
 * consumed by four surfaces (CLAUDE.md § Lanes), and trunk is landing the shared
 * schema in the integration pass. Same pattern the wallet used for notification
 * preferences.
 * ═════════════════════════════════════════════════════════════════════════════
 */

import { z } from 'zod';
import { IdSchema, TierNameSchema } from '@avo/types';
import { getJson } from './client';

/**
 * One row of the staff directory, and nothing more than the server sends.
 *
 * `phoneLast4` not `phone`, and no `balanceFils`. Both are the server's decision
 * and both are right: this list is reachable by any staff member with
 * `perms.scanner` and typing two characters, so every field on it is a field
 * that leaks four keystrokes deep.
 *
 * `tier` is nullable because a stamps salon has no tiers — the same nullability
 * `MemberSchema` carries, for the same reason.
 */
export const MemberSearchRowSchema = z.object({
  id: IdSchema,
  salonId: IdSchema,
  name: z.string(),
  /** The last four digits, as a string — leading zeros are significant. */
  phoneLast4: z.string(),
  tier: TierNameSchema.nullable(),
});

const MemberSearchPageSchema = z.object({
  items: z.array(MemberSearchRowSchema),
  nextCursor: z.string().nullable(),
});

export type MemberSearchRow = z.infer<typeof MemberSearchRowSchema>;

/**
 * The old name, kept as an alias so the screens read the same.
 *
 * It no longer means "a Member": it is a directory row, which is the whole point
 * of the fix above.
 */
export type LookupMember = MemberSearchRow;

/**
 * The shortest query worth sending, and it is the SERVER's number.
 *
 * `MEMBER_SEARCH_MIN_QUERY` in api/src/services/memberSearch.ts:56 is 2. This
 * was 3, which is harmless in the sense that a stricter client cannot leak
 * anything — but it silently refuses to search for a query the server would
 * have answered, and two numbers that disagree about the same rule is how the
 * next person ends up debugging why "Da" finds nobody. The server owns the rule
 * because the server enforces it; if it rises to 3 the client shows the API's
 * own `query_too_short` message rather than guessing ahead of it.
 */
export const MIN_QUERY_LENGTH = 2;

export async function lookupMembers(
  query: string,
  accessToken: string,
  signal?: AbortSignal,
): Promise<MemberSearchRow[]> {
  const body = await getJson(
    `/members?q=${encodeURIComponent(query)}`,
    MemberSearchPageSchema,
    accessToken,
    signal,
  );
  return body.items;
}
