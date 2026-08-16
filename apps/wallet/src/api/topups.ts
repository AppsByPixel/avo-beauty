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
 */

import { TopUpIntentSchema } from '@avo/types';
import type { Fils, PaymentMethod, TopUpIntent } from '@avo/types';
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
): Promise<TopUpIntent> {
  return postJson(
    '/topups',
    { amountFils: input.amountFils, method: input.method },
    TopUpIntentSchema,
    input.idempotencyKey,
    signal,
  );
}

/** The authoritative status read. This, and only this, decides the outcome. */
export function getTopUp(id: string, signal?: AbortSignal): Promise<TopUpIntent> {
  return getJson(`/topups/${encodeURIComponent(id)}`, TopUpIntentSchema, signal);
}
