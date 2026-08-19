/**
 * Why a checkout was refused — the money path's classifier, as a pure function.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * EXTRACTED FROM `useShop` FOR THE REASON `deletionOutcome.ts` AND `signup.ts`
 * BOTH STATE: this workspace has no renderer, so a branch left inline in a hook
 * is a branch no test can reach. It was inline, and the four-way classification
 * of a REFUSED ORDER — the most consequential mapping in this app after the
 * charge — had no spec at all. It has one now, and `orderRefusal.test.ts` is that
 * spec.
 *
 * THE ORDER OF THE CHECKS IS THE SPEC, and every one of the four is load-bearing:
 *
 *   1. 402 + a shortfall   the server's figure, never a locally computed one.
 *   2. `invalid_products`  a product retired underneath her. BEFORE the offline
 *                          check, because it is a 400 and would otherwise be
 *                          fine — but see the 503 note below for why the order
 *                          is written down rather than left to chance.
 *   3. `offline`           her connection. LAST of the classified cases, because
 *                          `client.ts`'s `classify()` maps 503 AND 504 to
 *                          `offline`, so a server-side 503 carrying a real code
 *                          would otherwise claim her network was down. That exact
 *                          collision made a signup refusal blame the connection,
 *                          and `termsFailure` carries the same note.
 *   4. anything else       our failure, with no retry affordance.
 *
 * WHAT THIS FUNCTION MAY NOT DO: offer a retry on `failed` or `offline`. It does
 * not render, so it cannot — but the shape it returns is what the sheet keys its
 * button off, and the rule belongs beside the classification. An order moves
 * money with ONE concurrency guard where a charge has two, so a client that could
 * not read the response does not know whether the money moved. `short` and
 * `stale` are refusals the server demonstrably made BEFORE debiting — driven, see
 * the test — and only those two keep a button.
 * ═════════════════════════════════════════════════════════════════════════════
 */

import { fils, type Fils } from '@avo/types';
import { ApiError } from '../api/client';

/**
 * What a refused checkout was. Each is a different sentence to the customer.
 *
 * Declared HERE rather than in `state/useShop`, which re-exports it: a domain
 * module must not import from `state/`, and the classifier is the thing that
 * defines the union.
 */
export type CheckoutRefusal =
  | { kind: 'short'; shortfallFils: Fils }
  | { kind: 'stale'; ids: string[] }
  | { kind: 'offline' }
  | { kind: 'failed' };

/** The API's code for a product that is unknown, retired, or another salon's. */
export const INVALID_PRODUCTS = 'invalid_products';

/**
 * The ids `invalid_products` names, read off the error body.
 *
 * THE KEY IS `unknown` AND IT IS TOP-LEVEL ON THE WIRE, not nested under a
 * `details` object. `api/src/services/order.ts` throws
 * `badRequest('invalid_products', …, { unknown })`, which serialises as
 * `{error, message, unknown}` — and `client.ts` rebuilds `details` by spreading
 * everything that is not `error` or `message`. So `details.unknown` is correct
 * because of that spread, not because the server sends a `details` object.
 * Captured from the real 400, not inferred:
 *
 *   {"error":"invalid_products",
 *    "message":"Unknown or unavailable product: PR-01.",
 *    "unknown":["PR-01"]}
 *
 * Filtered to strings rather than cast. A malformed `unknown` yields an empty
 * list, which still renders the stale refusal — she is told something in her cart
 * has gone even if we cannot name it, which is the honest degradation. It must
 * never throw: this runs inside the catch of a money-moving POST.
 */
function namedIds(err: ApiError): string[] {
  const raw = err.details['unknown'];
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === 'string');
}

/**
 * Classify a thrown checkout failure.
 *
 * Total by construction — every path returns, and a non-`ApiError` (a TypeError
 * from a schema parse, say) is `failed` rather than an escape. A classifier on a
 * money path that could itself throw would replace a refusal the customer can act
 * on with a blank screen.
 */
export function orderRefusal(err: unknown): CheckoutRefusal {
  if (!(err instanceof ApiError)) return { kind: 'failed' };

  /*
    THE SERVER'S SHORTFALL, replacing the local one the CTA label used. #2 gives
    the server the balance and therefore the difference; subtracting two numbers
    here would be a second opinion about money. `shortfallFils` is a getter that
    returns null unless the body carried a number, so a 402 without one falls
    through to `failed` rather than rendering "Balance too low by 0.000".
  */
  if (err.status === 402 && err.shortfallFils !== null) {
    return { kind: 'short', shortfallFils: fils(err.shortfallFils) };
  }

  /*
    A PRODUCT RETIRED WHILE SHE SHOPPED — and it is indistinguishable to the API
    from one that never existed, because the route filters `active = true` inside
    the same query that prices the basket and reports every missing id the same
    way. So the client cannot tell "retired" from "never existed" and must not
    try; the sentence names the product and asks her to take it out, which is true
    either way.
  */
  if (err.code === INVALID_PRODUCTS) {
    return { kind: 'stale', ids: namedIds(err) };
  }

  // AFTER the codes. See the header — 503 classifies as `offline`, so a coded
  // refusal arriving with that status must not be read as a dead connection.
  if (err.kind === 'offline') return { kind: 'offline' };

  return { kind: 'failed' };
}
