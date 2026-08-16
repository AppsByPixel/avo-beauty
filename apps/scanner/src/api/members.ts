/**
 * Manual member lookup — "Can't scan? Find member manually".
 *
 * THIS ENDPOINT DOES NOT EXIST YET. REPORTED TO LANE A, NOT BUILT HERE.
 * =====================================================================
 * design/AVO Staff Scanner.dc.html:205-239 specifies the screen: search by
 * name, phone number or member ID, pick a row, charge her. The prototype backs
 * it with a hardcoded `directory` array (:722-727) because it is a prototype.
 *
 * There is no staff-facing member search in either server:
 *
 *   api/src/routes/members.ts   only /members/me, /members/me/transactions,
 *                               /members/me/wallet-token — all member-scoped,
 *                               none reachable from a scanner session
 *   packages/mock/src/server.ts  the same three
 *
 * So this module names the endpoint the design requires and calls it. Until
 * lane A ships it the call 404s, and LookupScreen renders that as its error
 * state — which is the honest outcome. Writing the route myself would put a
 * customer-directory read with no salon predicate into another lane's column,
 * and a member search is precisely the endpoint where a missing tenant scope
 * leaks one salon's client list to another (the same class of bug lane A had
 * already found and fixed in POST /scans).
 *
 * WHAT LANE A IS OWED — the shape this file expects:
 *
 *   GET /members?q={query}          scanner scope, perms.scanner
 *     → { items: Member[], nextCursor: string | null }
 *
 *   - scoped to the caller's salon, exactly like POST /scans
 *   - matches name, phone, or member id
 *   - a minimum query length, so it cannot be walked as a directory dump
 *   - rate-limited per staff session for the same reason
 *   - writes an audit row naming the staff member who searched:
 *     "Manual lookups are logged with your name" is a promise the design makes
 *     to the customer (:235) and only the server can keep it
 *
 * The charge that follows a manual lookup carries no token, which the charge
 * endpoint already supports (api/src/routes/charges.ts:100).
 */

import { z } from 'zod';
import { MemberSchema } from '@avo/types';
import { getJson } from './client';

const MemberListSchema = z.object({
  items: z.array(MemberSchema),
  nextCursor: z.string().nullable(),
});

export type LookupMember = z.infer<typeof MemberSchema>;

/** The shortest query the server should answer. Keeps it from being a dump. */
export const MIN_QUERY_LENGTH = 3;

export async function lookupMembers(
  query: string,
  accessToken: string,
  signal?: AbortSignal,
): Promise<LookupMember[]> {
  const body = await getJson(
    `/members?q=${encodeURIComponent(query)}`,
    MemberListSchema,
    accessToken,
    signal,
  );
  return body.items;
}
