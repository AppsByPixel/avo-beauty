/**
 * The HTTP boundary.
 *
 * Two jobs beyond fetching:
 *
 * 1. Every response is parsed through the zod schema from @avo/types before it
 *    reaches a screen. A float where fils are expected is a contract violation,
 *    and the place to catch it is here, not in a component reading `.toFixed()`.
 *
 * 2. Failures are classified into the three kinds interaction-spec.md §4 asks a
 *    screen to tell apart: we failed (retry), you can't (explain, no retry), and
 *    no connection (keep the last-known data, stamp it).
 */

import type { z } from 'zod';
import { scenarioHeader } from './scenario';

/**
 * Where the API lives.
 *
 * `packages/mock` serves :4000 and answers everything the Home, top-up and
 * Account screens need. It does NOT implement booking — no `/bookings`, no
 * `/artists/{id}/availability` — so the Book flow is built and driven against
 * the real API (`api/`, lane A), which does. `EXPO_PUBLIC_AVO_API` selects it,
 * exactly as apps/scanner already does, rather than this constant being edited
 * back and forth by whoever ran the app last.
 */
export const API_BASE_URL: string = process.env['EXPO_PUBLIC_AVO_API'] ?? 'http://localhost:4000';

/** Timeout past which we treat the request as a connection failure, not a 500. */
const REQUEST_TIMEOUT_MS = 15_000;

export type FailureKind =
  /** 5xx or a malformed payload. Our fault, so the screen offers Try again. */
  | 'server'
  /** 401/403. The customer retrying will not help — explain instead. */
  | 'forbidden'
  /** 503, DNS failure, timeout, the device being on a plane. */
  | 'offline';

export class ApiError extends Error {
  readonly kind: FailureKind;
  /** Shown on the error screen so support can find the request. */
  readonly reference: string;
  readonly status: number | null;
  /**
   * The API's `error` field — `insufficient_balance`, `change_window_closed`,
   * `slot_taken`, `booking_not_enabled`.
   *
   * THE THREE KINDS ARE NOT ENOUGH FOR BOOKING, AND THAT IS WHY THIS EXISTS.
   * Home and Top up only ever had to tell "we failed" from "you can't" from
   * "no connection", so the code was thrown away at this boundary. The Book
   * flow cannot: a 402 has to become an inline shortfall with a top-up button,
   * a 409 `change_window_closed` has to become the one-hour sentence on the
   * Upcoming card, and a 409 `slot_taken` has to send her back to the grid. All
   * three would otherwise collapse into one "Try again" that never works.
   */
  readonly code: string | null;
  /**
   * Whatever else the error body carried. On a 402 that is
   * `{ shortfallFils, balanceFils, dueFils }` — non-negotiable #2 says the
   * server owns the balance, which includes owning the difference, so the
   * screen reads the shortfall off here rather than subtracting two numbers.
   */
  readonly details: Record<string, unknown>;

  constructor(
    kind: FailureKind,
    message: string,
    reference: string,
    status: number | null,
    code: string | null = null,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;
    this.reference = reference;
    this.status = status;
    this.code = code;
    this.details = details;
  }

  /** The shortfall on a 402, in fils. Null on anything else. */
  get shortfallFils(): number | null {
    const v = this.details['shortfallFils'];
    return typeof v === 'number' ? v : null;
  }
}

/** "WLT-5502-9917" — the format the error state in AVO States.dc.html shows. */
function newReference(): string {
  const block = () => String(Math.floor(Math.random() * 9000) + 1000);
  return `WLT-${block()}-${block()}`;
}

function classify(status: number): FailureKind {
  if (status === 401 || status === 403) return 'forbidden';
  if (status === 503 || status === 504) return 'offline';
  return 'server';
}

/**
 * An idempotency key for one money-moving attempt.
 *
 * Non-negotiable #4. The value matters less than its lifetime: it is minted once
 * per *attempt* and reused verbatim while that attempt is being retried, so a
 * timed-out POST that actually succeeded replays its stored result instead of
 * charging twice. A fresh attempt — the customer choosing a different amount, or
 * trying again after a decline — mints a new one, because api-contract.md's
 * addendum makes the same key with a different body a 422 and not a replay.
 */
export function newIdempotencyKey(): string {
  const rand = () => Math.random().toString(36).slice(2, 10);
  return `wlt-${Date.now().toString(36)}-${rand()}${rand()}`;
}

interface ErrorBody {
  error?: string;
  message?: string;
  [key: string]: unknown;
}

interface RequestOptions {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** JSON body. Absent on a GET. */
  body?: unknown;
  /**
   * Non-negotiable #4. Required on every money-moving POST; the server rejects
   * the request without it, which is the behaviour we want rather than a client
   * that can forget.
   */
  idempotencyKey?: string | undefined;
  signal?: AbortSignal | undefined;
}

/**
 * The transport half: everything up to and including "the server answered
 * without an error status". Split out from `request` so that a 204 endpoint —
 * `POST /members/me/password`, which returns no body precisely so that it cannot
 * leak a password field (non-negotiable #6) — can share the failure
 * classification without being handed a schema it has nothing to validate.
 */
async function send(
  path: string,
  options: RequestOptions,
): Promise<{ response: Response; reference: string }> {
  const { method, body, idempotencyKey, signal } = options;
  const reference = newReference();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const onOuterAbort = () => controller.abort();
  signal?.addEventListener('abort', onOuterAbort);

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      method,
      headers: {
        accept: 'application/json',
        'x-avo-request-id': reference,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(idempotencyKey === undefined ? {} : { 'idempotency-key': idempotencyKey }),
        ...scenarioHeader(),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
    });
  } catch {
    // fetch only rejects for transport-level problems: no route to host, DNS,
    // TLS, or our own abort. All of them mean "no connection" to a customer.
    throw new ApiError(
      'offline',
      'No connection. Showing your last update.',
      reference,
      null,
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onOuterAbort);
  }

  if (!response.ok) {
    let body: ErrorBody = {};
    try {
      body = (await response.json()) as ErrorBody;
    } catch {
      /* a non-JSON error body is still an error; the status carries the meaning */
    }
    const { error, message, ...details } = body;
    throw new ApiError(
      classify(response.status),
      message ?? 'Something went wrong.',
      reference,
      response.status,
      error ?? null,
      details,
    );
  }

  return { response, reference };
}

async function request<S extends z.ZodTypeAny>(
  path: string,
  schema: S,
  options: RequestOptions,
): Promise<z.infer<S>> {
  const { response, reference } = await send(path, options);

  const parsed = schema.safeParse(await response.json());
  if (!parsed.success) {
    throw new ApiError(
      'server',
      'That response did not match the contract.',
      reference,
      response.status,
    );
  }
  return parsed.data as z.infer<S>;
}

/**
 * GET a resource and validate it. `schema` is the contract; if the body does not
 * satisfy it, that is a server failure and not something to render around.
 */
export function getJson<S extends z.ZodTypeAny>(
  path: string,
  schema: S,
  signal?: AbortSignal,
): Promise<z.infer<S>> {
  return request(path, schema, { method: 'GET', signal });
}

/**
 * POST a money-moving request. The idempotency key is a required argument rather
 * than an option, because there is no correct call site that omits it.
 */
export function postJson<S extends z.ZodTypeAny>(
  path: string,
  body: unknown,
  schema: S,
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<z.infer<S>> {
  return request(path, schema, { method: 'POST', body, idempotencyKey, signal });
}

/**
 * POST a request that moves no money and returns a body.
 *
 * Separate from `postJson` because the idempotency key there is a *required*
 * positional argument, and that is deliberate — non-negotiable #4 is about money
 * and a helper that let a top-up omit the key would be the bug. These calls
 * (profile edits, a phone-change challenge, a support ticket) still take a key,
 * but as an option: it protects against a double-submit creating two tickets
 * rather than two charges, so the caller decides.
 */
export function postAction<S extends z.ZodTypeAny>(
  path: string,
  body: unknown,
  schema: S,
  options: { idempotencyKey?: string; signal?: AbortSignal } = {},
): Promise<z.infer<S>> {
  return request(path, schema, {
    method: 'POST',
    body,
    idempotencyKey: options.idempotencyKey,
    signal: options.signal,
  });
}

/**
 * DELETE a resource and validate what comes back.
 *
 * NO IDEMPOTENCY KEY, AND THAT IS THE API'S REASONING RATHER THAN AN OMISSION.
 * `DELETE /bookings/{id}` returns a deposit to the wallet, so by
 * non-negotiable #4's letter it moves money — but api/src/routes/bookings.ts
 * spells out why a key would be weaker here: a DELETE names ONE resource with
 * one live state, and the `deposit_held → cancelled` transition happens under
 * `FOR UPDATE`. A second cancel blocks, re-reads and is told `already_cancelled`
 * — which also holds when the client sends two DIFFERENT keys, and a key would
 * not.
 */
export function deleteJson<S extends z.ZodTypeAny>(
  path: string,
  schema: S,
  signal?: AbortSignal,
): Promise<z.infer<S>> {
  return request(path, schema, { method: 'DELETE', signal });
}

/** PATCH a resource and validate the updated entity that comes back. */
export function patchJson<S extends z.ZodTypeAny>(
  path: string,
  body: unknown,
  schema: S,
  signal?: AbortSignal,
): Promise<z.infer<S>> {
  return request(path, schema, { method: 'PATCH', body, signal });
}

/**
 * POST something whose success is a 204 with no body.
 *
 * There is nothing to parse and nothing to return — which is the point for
 * `POST /members/me/password`: api-contract.md rule 5 says the endpoint never
 * returns a password field, and the surest way to keep that true is a response
 * with no body to put one in. A caller that wanted a value back from this would
 * be asking for something it must not have.
 */
export async function postNoContent(
  path: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<void> {
  await send(path, { method: 'POST', body, signal });
}
