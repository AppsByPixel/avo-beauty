/**
 * The two top-up endpoints, and the reason there are exactly two.
 *
 * api-contract.md § TopUpIntent:
 *
 *   POST /topups → open `redirectUrl` → the gateway returns to
 *   avo://topup/return?intent={id} → GET /topups/{id} for the authoritative status.
 *
 * Client rule 1 is the one this file exists to enforce: **the return URL is a
 * hint, not a result.** Nothing here reads a status, an amount or a success flag
 * out of a redirect. `getTopUp` is the only thing in the app that can say what
 * happened to a payment, and the four outcome screens are driven from it alone.
 *
 * Client rule 4 follows from the same place: this module returns an intent, never
 * a balance. The wallet's balance is re-read from GET /members/me after a
 * successful top-up; `creditFils` is never added to anything locally.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * `TopUpIntentPublicSchema`, NOT `TopUpIntentSchema`. THIS IS NOT A PREFERENCE.
 *
 * The two differ by one field, `feeFils`, and it is REQUIRED on the merchant
 * schema and never sent to a customer: the commission is merchant-visible and
 * customer-never (api-contract.md § Commission), and `serialiseIntentForCustomer`
 * emits exactly the ten keys of the public shape.
 *
 * So this file parsed every `POST /topups` 200 with a schema that demanded an
 * eleventh key the API will never send, zod threw, `client.ts` turned the throw
 * into `ApiError('server')`, and the sheet showed "We couldn't start that
 * top-up — Nothing was charged." on a request the server had answered correctly.
 * Money could not enter the product at all, on any rail, for any amount, and the
 * error named the wrong side of the wire.
 *
 * `api/topups.test.ts` pins both directions against real captured responses.
 * ═════════════════════════════════════════════════════════════════════════════
 */

import { TopUpIntentPublicSchema } from '@avo/types';
import type { Fils, PaymentMethod, TopUpIntentPublic } from '@avo/types';
import { postJson, getJson } from './client';

export interface CreateTopUpInput {
  amountFils: Fils;
  method: PaymentMethod;
  /**
   * Minted once per attempt by the caller and reused verbatim across retries of
   * that same attempt — see newIdempotencyKey(). It is an argument rather than
   * something generated in here precisely so that the retry case can hold it.
   */
  idempotencyKey: string;
}

export function createTopUp(
  input: CreateTopUpInput,
  signal?: AbortSignal,
): Promise<TopUpIntentPublic> {
  return postJson(
    '/topups',
    { amountFils: input.amountFils, method: input.method },
    TopUpIntentPublicSchema,
    input.idempotencyKey,
    signal,
  );
}

/** The authoritative status read. This, and only this, decides the outcome. */
export function getTopUp(id: string, signal?: AbortSignal): Promise<TopUpIntentPublic> {
  return getJson(`/topups/${encodeURIComponent(id)}`, TopUpIntentPublicSchema, signal);
}
