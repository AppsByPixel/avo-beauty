/**
 * The HTTP boundary for the staff scanner.
 *
 * It differs from apps/wallet's client in three ways, and each is load-bearing:
 *
 * 1. **Every request is authenticated.** A PIN session mints a bearer token
 *    scoped to `scanner` (api/src/routes/auth.ts). There is no anonymous call
 *    on this surface, so the token is a constructor argument rather than an
 *    option a call site can forget.
 *
 * 2. **The error CODE survives.** The wallet collapses failures into three
 *    kinds for a customer. The scanner cannot: `402 insufficient_balance`
 *    carries the exact shortfall, `410 token_expired` and
 *    `410 token_consumed_or_unknown` are different sentences at the counter,
 *    `403 forbidden` draws the locked screen, and `429 pin_locked` is not the
 *    same as `429 too_many_attempts`. Collapsing them would mean recomputing
 *    the shortfall on the client — and non-negotiable #2 says the server owns
 *    the balance, which includes owning the difference.
 *
 * 3. **Idempotency is required, not offered.** `postMoney` takes the key as a
 *    positional argument for the same reason the wallet's does: there is no
 *    correct call site that omits it (non-negotiable #4).
 */

import type { z } from 'zod';

/**
 * Where the API lives.
 *
 * The real API (api/, lane A) runs on 4100; the mock (packages/mock) on 4000.
 * This lane builds against the real one — every endpoint the scanner needs is
 * implemented and tested under concurrency there — and falls back to the mock
 * when the real service is not up. `EXPO_PUBLIC_AVO_API` overrides both, which
 * is how a device on the salon wifi reaches a laptop.
 */
export const API_BASE_URL: string =
  process.env['EXPO_PUBLIC_AVO_API'] ?? 'http://localhost:4100';

const REQUEST_TIMEOUT_MS = 15_000;

export type FailureKind =
  /** 5xx or a body that does not match the contract. Offer Try again. */
  | 'server'
  /** 4xx that retrying will not fix. Explain instead. */
  | 'refused'
  /** No route to host, DNS, TLS, timeout, aeroplane. Keep the last-known data. */
  | 'offline';

/**
 * A failure with its code and its details intact.
 *
 * `code` is the API's `error` field — `insufficient_balance`, `token_expired`,
 * `pin_locked`, `forbidden`. `details` is whatever else the body carried;
 * for a 402 that is `{ shortfallFils, balanceFils, dueFils }`, and the screen
 * reads the shortfall off it rather than subtracting two numbers itself.
 */
export class ApiError extends Error {
  readonly kind: FailureKind;
  readonly code: string | null;
  readonly status: number | null;
  readonly reference: string;
  readonly details: Record<string, unknown>;

  constructor(init: {
    kind: FailureKind;
    message: string;
    code?: string | null;
    status?: number | null;
    reference: string;
    details?: Record<string, unknown>;
  }) {
    super(init.message);
    this.name = 'ApiError';
    this.kind = init.kind;
    this.code = init.code ?? null;
    this.status = init.status ?? null;
    this.reference = init.reference;
    this.details = init.details ?? {};
  }

  /** The shortfall on a 402, in fils. Null on anything else. */
  get shortfallFils(): number | null {
    const v = this.details['shortfallFils'];
    return typeof v === 'number' ? v : null;
  }
}

/** "SCN-5502-9917" — the reference format from AVO States.dc.html:138. */
function newReference(): string {
  const block = () => String(Math.floor(Math.random() * 9000) + 1000);
  return `SCN-${block()}-${block()}`;
}

function classify(status: number): FailureKind {
  if (status === 503 || status === 504) return 'offline';
  if (status >= 400 && status < 500) return 'refused';
  return 'server';
}

/**
 * An idempotency key for one money-moving attempt.
 *
 * Minted once per *attempt* and reused verbatim while that attempt is retried,
 * so a timed-out charge that actually succeeded replays the stored result
 * instead of debiting twice. A genuinely new attempt — different services,
 * a different member — mints a new one, because the API answers a reused key
 * with a changed body as a conflict rather than a replay
 * (api/src/services/idempotency.ts).
 */
export function newIdempotencyKey(): string {
  const rand = () => Math.random().toString(36).slice(2, 10);
  return `scn-${Date.now().toString(36)}-${rand()}${rand()}`;
}

interface ErrorBody {
  error?: string;
  message?: string;
  [key: string]: unknown;
}

export interface RequestOptions {
  method: 'GET' | 'POST';
  body?: unknown;
  /** Non-negotiable #4. Required on every money-moving POST. */
  idempotencyKey?: string | undefined;
  /** Absent only on PIN sign-in, which is what mints the token. */
  accessToken?: string | undefined;
  signal?: AbortSignal | undefined;
}

async function request<S extends z.ZodTypeAny>(
  path: string,
  schema: S,
  options: RequestOptions,
): Promise<z.infer<S>> {
  const { method, body, idempotencyKey, accessToken, signal } = options;
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
        ...(accessToken === undefined ? {} : { authorization: `Bearer ${accessToken}` }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
    });
  } catch {
    // fetch rejects only for transport-level problems. All of them mean "no
    // connection" to someone standing at a counter with a customer waiting.
    throw new ApiError({
      kind: 'offline',
      message: 'No connection.',
      reference,
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onOuterAbort);
  }

  if (!response.ok) {
    let parsed: ErrorBody = {};
    try {
      parsed = (await response.json()) as ErrorBody;
    } catch {
      /* a non-JSON error body is still an error; the status carries the meaning */
    }
    const { error, message, ...details } = parsed;
    throw new ApiError({
      kind: classify(response.status),
      message: message ?? 'Something went wrong.',
      code: error ?? null,
      status: response.status,
      reference,
      details,
    });
  }

  const decoded = schema.safeParse(await response.json());
  if (!decoded.success) {
    throw new ApiError({
      kind: 'server',
      message: 'That response did not match the contract.',
      status: response.status,
      reference,
    });
  }
  return decoded.data as z.infer<S>;
}

/** GET a resource and validate it against the contract. */
export function getJson<S extends z.ZodTypeAny>(
  path: string,
  schema: S,
  accessToken: string,
  signal?: AbortSignal,
): Promise<z.infer<S>> {
  return request(path, schema, { method: 'GET', accessToken, signal });
}

/** POST something that does not move money — sign-in, a scan resolution. */
export function postJson<S extends z.ZodTypeAny>(
  path: string,
  body: unknown,
  schema: S,
  accessToken?: string,
  signal?: AbortSignal,
): Promise<z.infer<S>> {
  return request(path, schema, { method: 'POST', body, accessToken, signal });
}

/**
 * POST something that moves money. The key is positional because omitting it
 * is never right — and the server refuses the request without it anyway, which
 * is the behaviour we want rather than a client that can quietly forget.
 */
export function postMoney<S extends z.ZodTypeAny>(
  path: string,
  body: unknown,
  schema: S,
  idempotencyKey: string,
  accessToken: string,
  signal?: AbortSignal,
): Promise<z.infer<S>> {
  return request(path, schema, {
    method: 'POST',
    body,
    idempotencyKey,
    accessToken,
    signal,
  });
}
