import { API_BASE_URL } from '../config.js';

/**
 * A failure that carries enough for the UI to tell "we failed" (retry) apart
 * from "you can't do that" (explain) — interaction-spec.md §4.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** No response at all: DNS, CORS, the laptop's wifi. Distinct from a 5xx. */
  readonly offline: boolean;

  constructor(message: string, opts: { status: number; code: string; offline?: boolean }) {
    super(message);
    this.name = 'ApiError';
    this.status = opts.status;
    this.code = opts.code;
    this.offline = opts.offline ?? false;
  }

  /**
   * 401 — WHO is calling is the problem. The credential is missing, expired
   * past refresh, or revoked. `authedRequest` has already tried to rotate and
   * has already dropped the session by the time this reaches a component, so
   * the screen's job is to get out of the way and let the shell redirect to
   * sign-in. There is nothing to explain and nothing to retry.
   */
  get isUnauthenticated(): boolean {
    return this.status === 401;
  }

  /**
   * 403 — WHAT was asked for is the problem. The session is perfectly valid;
   * this staff member lacks the permission, or the thing belongs to another
   * salon ("That salon is not yours."). This is the *explain, no retry* case of
   * interaction-spec.md §4: an identical request produces an identical refusal,
   * so offering a retry button is a lie about what the user can do. The
   * `message` is server-authored copy naming who can grant the permission —
   * render it rather than inventing one.
   */
  get isForbidden(): boolean {
    return this.status === 403;
  }

  /** The connection-style failures the wallet and dashboard both treat as offline. */
  get isConnectivity(): boolean {
    return this.offline || this.status === 503 || this.status === 0;
  }
}

/**
 * `x-avo-scenario` passthrough. The mock serves loading/empty/error/offline
 * behind this header; putting `?scenario=empty` in the dashboard URL drives the
 * whole app through that state so the four states get built and *reviewed*
 * alongside the happy path rather than after it.
 *
 * Pinned once seen: the router drops search params it does not know about, and
 * a scenario that evaporated on the first client-side navigation would be worse
 * than useless for reviewing a state. Clearing it is a reload.
 */
let pinnedScenario: string | null = null;

function scenarioHeader(): Record<string, string> {
  if (typeof window === 'undefined') return {};
  const fromUrl = new URLSearchParams(window.location.search).get('scenario');
  if (fromUrl) pinnedScenario = fromUrl;
  return pinnedScenario ? { 'x-avo-scenario': pinnedScenario } : {};
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
  /** Bearer token for the active session. */
  token?: string | null;
  /**
   * Non-negotiable #4. Required on every money-moving POST. Typed here so a
   * future charge/top-up/void call cannot be written without one.
   */
  idempotencyKey?: string;
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, signal, token, idempotencyKey } = options;

  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...scenarioHeader(),
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal ? { signal } : {}),
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    throw new ApiError('No connection to the workspace.', {
      status: 0,
      code: 'network_error',
      offline: true,
    });
  }

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as {
      error?: string;
      message?: string;
    } | null;
    throw new ApiError(payload?.message ?? response.statusText, {
      status: response.status,
      code: payload?.error ?? 'http_error',
    });
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}
