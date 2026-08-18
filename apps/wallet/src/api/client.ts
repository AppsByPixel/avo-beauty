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

import { z } from 'zod';
import { scenarioHeader } from './scenario';
import { clearSession, getAccessToken, getRefreshToken, rotated } from './session';

/**
 * Where the API lives.
 *
 * THE DEFAULT WAS THE MOCK, AND THE DEFAULT IS WHAT HID THE GAP.
 * This read `?? 'http://localhost:4000'` — `packages/mock`, which requires no
 * authentication. So a wallet that sent no `authorization` header worked
 * perfectly against the default, on every screen, and nothing ever failed in a
 * way that pointed at the missing auth. `STATUS.md` recorded the wallet as
 * working; it was, against a server that asks nothing of it.
 *
 * So the default is now the real API — the same port apps/scanner defaults to,
 * deliberately, so the two apps in this lane agree about where "the API" is —
 * and the mock is the explicit opt-in it should always have been:
 *
 *     EXPO_PUBLIC_AVO_API=http://localhost:4000   # the mock, on purpose
 *
 * The mock also cannot serve this flow: it has no `/auth/member/session` and no
 * `/auth/refresh`. Pointing at it now fails at sign-in rather than silently
 * succeeding everywhere, which is the correct direction for that failure.
 */
export const API_BASE_URL: string = process.env['EXPO_PUBLIC_AVO_API'] ?? 'http://localhost:4100';

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
 * One attempt. No auth retry, no refresh — just the request and its result.
 *
 * Split from `send` so the 401 path has something to call twice without
 * recursing, and so `/auth/refresh` itself has a way to be sent that cannot
 * trigger another refresh.
 */
async function sendOnce(
  path: string,
  options: RequestOptions,
): Promise<{ response: Response; reference: string }> {
  const { method, body, idempotencyKey, signal } = options;
  const reference = newReference();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const onOuterAbort = () => controller.abort();
  signal?.addEventListener('abort', onOuterAbort);

  /*
    Read at SEND time, never captured earlier. A request queued behind a refresh
    must go out with the token the refresh produced, not the dead one that was
    current when its caller started.
  */
  const token = getAccessToken();

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      method,
      headers: {
        accept: 'application/json',
        'x-avo-request-id': reference,
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
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

/**
 * The paths that must never trigger a refresh-and-retry.
 *
 * `/auth/refresh` is the refresh — retrying it through itself is infinite
 * recursion. `/auth/member/session` returning 401 means she typed the wrong
 * password, and refreshing a session she does not have yet is meaningless; that
 * 401 has to reach the sign-in screen as a wrong-password message, which is
 * exactly the "a wrong password is not an outage" rule. `/auth/sign-out` on a 401
 * is already what it wanted: the session is gone.
 */
const NO_REAUTH = new Set(['/auth/refresh', '/auth/member/session', '/auth/sign-out']);

/**
 * ONE refresh at a time, and this latch is not an optimisation.
 *
 * Refresh tokens ROTATE (`rotateSession`), and the API cannot distinguish a
 * replayed token from a stolen one, so it fails both. The wallet's home screen
 * fires several reads at once — member, transactions, wallet token — so an expired
 * access token produces several simultaneous 401s. Without a latch each would
 * refresh independently: the first rotates and succeeds, the rest present the
 * token that was just invalidated, fail, and sign the customer out in the middle
 * of a working session.
 *
 * So every 401 in a burst awaits the SAME promise, and exactly one rotation
 * happens.
 */
let inFlightRefresh: Promise<boolean> | null = null;

/**
 * The rotated pair. Validated like every other response rather than duck-typed:
 * a refresh that answered 200 with a body missing `refreshToken` would otherwise
 * store `undefined` and sign her out on the next call, one step removed from the
 * cause.
 */
const RefreshSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  expiresAt: z.string(),
});

async function performRefresh(): Promise<boolean> {
  const token = getRefreshToken();
  if (token === null) return false;

  try {
    const { response } = await sendOnce('/auth/refresh', {
      method: 'POST',
      body: { refreshToken: token },
    });
    const parsed = RefreshSchema.safeParse(await response.json());
    if (!parsed.success) {
      await clearSession();
      return false;
    }
    /*
      The rotated pair is persisted HERE rather than by a caller. Forgetting it
      works exactly once and then signs her out — a bug that presents as a flaky
      backend rather than as a client mistake.

      The dependency stays one-way and needs no lazy import: session.ts knows
      nothing about HTTP, so client.ts -> session.ts is acyclic. auth.ts sits
      above both.
    */
    await rotated({
      accessToken: parsed.data.accessToken,
      refreshToken: parsed.data.refreshToken,
    });
    return true;
  } catch {
    /*
     * Every failure means the same thing to the customer — sign in again — and the
     * session is cleared so nothing downstream believes otherwise. An offline
     * refresh lands here too, which is honest: we cannot prove the session is
     * alive.
     */
    await clearSession();
    return false;
  }
}

/**
 * Exchange the stored refresh token for a new pair. Resolves false when the
 * session is genuinely over and the only correct response is to show sign-in.
 *
 * Exported because boot needs it explicitly: `restore()` loads a refresh token and
 * no access token, so the app calls this once rather than letting the first screen
 * discover the session through a 401.
 */
export function refreshSession(): Promise<boolean> {
  if (inFlightRefresh !== null) return inFlightRefresh;
  const attempt = performRefresh();
  inFlightRefresh = attempt;
  void attempt.finally(() => {
    // Cleared only if it is still ours; a refresh that started after this one
    // finished must not be dropped.
    if (inFlightRefresh === attempt) inFlightRefresh = null;
  });
  return attempt;
}

/**
 * The transport half: everything up to and including "the server answered
 * without an error status". Split out from `request` so that a 204 endpoint —
 * `POST /members/me/password`, which returns no body precisely so that it cannot
 * leak a password field (non-negotiable #6) — can share the failure
 * classification without being handed a schema it has nothing to validate.
 *
 * And the layer where an expired access token stops being every screen's problem:
 * a 401 is refreshed and retried ONCE here, so no caller needs to know that
 * tokens expire.
 */
async function send(
  path: string,
  options: RequestOptions,
): Promise<{ response: Response; reference: string }> {
  try {
    return await sendOnce(path, options);
  } catch (err) {
    const retryable =
      err instanceof ApiError &&
      err.status === 401 &&
      !NO_REAUTH.has(path) &&
      getRefreshToken() !== null;
    if (!retryable) throw err;

    const ok = await refreshSession();
    if (!ok) throw err;

    /*
      Exactly once. A second 401 after a successful refresh is not an expiry — it
      is the server refusing this principal for this resource — and retrying it in
      a loop would hammer the API with a request that will never succeed.

      Safe for the money POSTs, which is the case worth checking rather than
      assuming: the idempotency key is unchanged on the retry, so if the first
      attempt somehow reached the server the second replays its stored answer
      instead of moving money twice (non-negotiable #4).
    */
    return await sendOnce(path, options);
  }
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
